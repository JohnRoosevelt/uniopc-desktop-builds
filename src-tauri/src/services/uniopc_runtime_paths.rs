//! Single source of truth for Uniopc's private on-disk layout.
//!
//! The Uniopc 引擎 runtime and its state used to live in the shared
//! `~/.openclaw(-profile)` convention, mixed with any developer-managed
//! install. Uniopc now owns a private, versioned layout instead:
//!
//! ```text
//! <app data>/Uniopc/
//! ├── runtime/
//! │   ├── v<version>/{bin,tools}   # one dir per bundled runtime version
//! │   └── current -> v<version>    # active pointer; upgrade = extract + flip
//! └── state-v8/
//!     └── uniopc-<compatibility-version>/
//!         └── <profile>/           # per-profile engine state (config,
//!                                  # identity, sessions, extensions, logs)
//! ```
//!
//! `<app data>` is `~/Library/Application Support` on macOS, `%APPDATA%` on
//! Windows and `~/.local/share` on Linux. Rollback is flipping `current`
//! back; versions coexist. State placement is enforced by exporting
//! `OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH` at every engine spawn.

use std::path::PathBuf;

pub const DEFAULT_PROFILE_STATE_KEY: &str = "default";
const STATE_COMPATIBILITY_PREFIX: &str = "uniopc";
const LEGACY_STATE_COMPATIBILITY_PREFIX: &str = "openclaw";

/// Records the active runtime version for platforms that don't use a traversable
/// `current` reparse point (Windows). Unix keeps the `current` symlink as the
/// source of truth; the marker is written on every flip for parity.
pub fn current_marker_path() -> Result<PathBuf, String> {
    Ok(runtime_base_dir()?.join("current.version"))
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .ok_or_else(|| "无法定位用户目录。".to_string())
}

/// `<app data>/Uniopc` — the private root everything else derives from.
pub fn uniopc_data_dir() -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("UNIOPC_DATA_DIR") {
        let configured = PathBuf::from(configured);
        if configured.is_absolute() {
            return Ok(configured);
        }
    }
    let home = home_dir()?;
    if cfg!(target_os = "macos") {
        Ok(home.join("Library").join("Application Support").join("Uniopc"))
    } else if cfg!(target_os = "windows") {
        Ok(std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Uniopc"))
    } else {
        Ok(home.join(".local").join("share").join("uniopc"))
    }
}

pub fn runtime_base_dir() -> Result<PathBuf, String> {
    Ok(uniopc_data_dir()?.join("runtime"))
}

/// Immutable per-version runtime install (`runtime/v<version>`).
pub fn runtime_version_dir(version: &str) -> Result<PathBuf, String> {
    Ok(runtime_base_dir()?.join(format!("v{version}")))
}

/// The active-runtime directory. Unix uses the `runtime/current` symlink;
/// Windows resolves it to the concrete `runtime/v<version>` dir via the marker,
/// because a `mklink /J` junction created without elevation is not reliably
/// traversable by `std::fs` path checks (a path *through* it reports as
/// non-existent), which would otherwise break every runtime path lookup.
pub fn runtime_current_dir() -> Result<PathBuf, String> {
    let base = runtime_base_dir()?;
    #[cfg(windows)]
    {
        if let Ok(version) = std::fs::read_to_string(base.join("current.version")) {
            let version = version.trim();
            if !version.is_empty() {
                let dir = base.join(format!("v{version}"));
                if dir.is_dir() {
                    return Ok(dir);
                }
            }
        }
    }
    Ok(base.join("current"))
}

pub fn runtime_bin_dir() -> Result<PathBuf, String> {
    Ok(runtime_current_dir()?.join("bin"))
}

pub fn runtime_node_bin_dir() -> Result<PathBuf, String> {
    Ok(runtime_current_dir()?
        .join("tools")
        .join("node")
        .join("bin"))
}

pub fn runtime_tools_dir() -> Result<PathBuf, String> {
    Ok(runtime_current_dir()?.join("tools"))
}

/// Media tools are app-owned runtime data, never a user-managed PATH dependency.
/// The installer atomically points `media-runtime/current` at the verified
/// platform build. `UNIOPC_MEDIA_RUNTIME_DIR` exists only for CI/dev fixtures.
pub fn media_runtime_current_dir() -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("UNIOPC_MEDIA_RUNTIME_DIR") {
        let configured = PathBuf::from(configured);
        if configured.is_absolute() {
            return Ok(configured);
        }
    }
    let base = uniopc_data_dir()?.join("media-runtime");
    #[cfg(windows)]
    {
        if let Ok(version) = std::fs::read_to_string(base.join("current.version")) {
            let version = version.trim();
            if !version.is_empty() {
                let directory = base.join(version);
                if directory.is_dir() {
                    return Ok(directory);
                }
            }
        }
    }
    Ok(base.join("current"))
}

pub fn montage_media_runtime_env() -> Result<Vec<(String, String)>, String> {
    let directory = media_runtime_current_dir()?;
    let ffmpeg = directory.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    let ffprobe = directory.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
    if !ffmpeg.is_file() || !ffprobe.is_file() {
        return Err("智能混剪视频运行时尚未准备完成。请在「插件」中等待媒体运行时下载完成后重试。".to_string());
    }
    Ok(vec![
        ("UNIOPC_MONTAGE_FFMPEG".to_string(), ffmpeg.to_string_lossy().to_string()),
        ("UNIOPC_MONTAGE_FFPROBE".to_string(), ffprobe.to_string_lossy().to_string()),
        ("UNIOPC_SUPERIP_FFMPEG".to_string(), ffmpeg.to_string_lossy().to_string()),
        ("UNIOPC_SUPERIP_FFPROBE".to_string(), ffprobe.to_string_lossy().to_string()),
    ])
}

#[cfg(test)]
mod media_runtime_tests {
    use super::*;
    use std::{fs, sync::Mutex};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn montage_media_runtime_requires_both_tools() {
        let _guard = ENV_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(format!("uniopc-media-runtime-{}", std::process::id()));
        let _ = fs::create_dir_all(&root);
        std::env::set_var("UNIOPC_MEDIA_RUNTIME_DIR", &root);
        assert!(montage_media_runtime_env().is_err());
        let ffmpeg = root.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let ffprobe = root.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
        fs::write(&ffmpeg, b"fixture").unwrap();
        fs::write(&ffprobe, b"fixture").unwrap();
        let env = montage_media_runtime_env().unwrap();
        assert!(env.iter().any(|(key, value)| key == "UNIOPC_MONTAGE_FFMPEG" && value == &ffmpeg.to_string_lossy()));
        assert!(env.iter().any(|(key, value)| key == "UNIOPC_MONTAGE_FFPROBE" && value == &ffprobe.to_string_lossy()));
        assert!(env.iter().any(|(key, value)| key == "UNIOPC_SUPERIP_FFMPEG" && value == &ffmpeg.to_string_lossy()));
        assert!(env.iter().any(|(key, value)| key == "UNIOPC_SUPERIP_FFPROBE" && value == &ffprobe.to_string_lossy()));
        std::env::remove_var("UNIOPC_MEDIA_RUNTIME_DIR");
        let _ = fs::remove_dir_all(root);
    }
}

pub fn state_v8_base_dir() -> Result<PathBuf, String> {
    let compatibility_version = sanitize_profile_key(env!("IMAI_OPENCLAW_VERSION"));
    migrate_legacy_state_v8_base_dir(&uniopc_data_dir()?.join("state-v8"), &compatibility_version)
}

/// Move the old engine-branded compatibility root into Uniopc's private layout.
/// The rename stays inside `state-v8`, so it is atomic on normal desktop
/// installations and preserves every profile's config, sessions, extensions,
/// and generated media as one unit.
fn migrate_legacy_state_v8_base_dir(state_root: &std::path::Path, compatibility_version: &str) -> Result<PathBuf, String> {
    let current = state_root.join(format!("{STATE_COMPATIBILITY_PREFIX}-{compatibility_version}"));
    if current.exists() {
        return Ok(current);
    }
    let legacy = state_root.join(format!("{LEGACY_STATE_COMPATIBILITY_PREFIX}-{compatibility_version}"));
    if !legacy.exists() {
        return Ok(current);
    }
    std::fs::create_dir_all(state_root)
        .map_err(|error| format!("创建 Uniopc 本地状态目录失败: {error}"))?;
    match std::fs::rename(&legacy, &current) {
        Ok(()) => Ok(current),
        Err(_) if current.exists() => Ok(current),
        Err(error) => Err(format!("迁移 Uniopc 本地状态目录失败: {error}")),
    }
}

/// Per-profile OpenClaw 8.1 state dir. Empty/default profile maps to
/// `state-v8/uniopc-<compatibility-version>/default`; the legacy `state/`
/// root is deliberately never read.
///
/// The compatibility-version layer is derived from the exact OpenClaw version
/// compiled into this desktop build. It prevents an older engine from reading
/// or rewriting state produced by a newer engine. Existing unversioned
/// `state-v8/<profile>` directories are deliberately left in place: no data is
/// copied, migrated, or deleted during path resolution.
pub fn state_v8_dir_for_profile(profile: Option<&str>) -> Result<PathBuf, String> {
    Ok(state_v8_base_dir()?.join(sanitize_profile_key(
        profile
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "default")
            .unwrap_or(DEFAULT_PROFILE_STATE_KEY),
    )))
}

/// `active-profile.json` — the single source of truth for "which cloud account
/// is currently selected". Callers that don't (or can't) thread the profile
/// explicitly resolve through this marker so every engine spawn lands in the
/// same per-account compatibility-isolated state directory. Lives at the
/// private data-dir root (like the machine-level device identity), not inside
/// any one account's state.
pub fn active_profile_marker_path() -> Result<PathBuf, String> {
    Ok(uniopc_data_dir()?.join("active-profile.json"))
}

/// Read the currently-selected account key, or `None` when logged out / unset /
/// unreadable. The raw (unsanitized) key is returned; sanitize at resolve time.
pub fn read_active_profile_key() -> Option<String> {
    let path = active_profile_marker_path().ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("profileKey")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

/// Record the currently-selected account key. Called when the desktop switches
/// / provisions a profile, BEFORE the gateway child is (re)spawned, so the new
/// engine reads the new account's compatibility-isolated state directory.
pub fn write_active_profile_key(profile_key: &str) -> Result<(), String> {
    let key = profile_key.trim();
    let path = active_profile_marker_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建活跃账号目录失败: {e}"))?;
    }
    let body = serde_json::json!({ "profileKey": key }).to_string();
    std::fs::write(&path, body).map_err(|e| format!("写入活跃账号标记失败: {e}"))
}

/// Clear the active-account marker (logout / anonymous → fall back to `default`).
pub fn clear_active_profile_key() -> Result<(), String> {
    let path = active_profile_marker_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清除活跃账号标记失败: {e}")),
    }
}

/// Map an arbitrary cloud profile key to a safe on-disk directory name:
/// lowercase, keep `[a-z0-9_-]`, everything else → `_`, capped in length,
/// blank → `default`. Prevents path traversal and cross-platform-invalid names.
pub fn sanitize_profile_key(key: &str) -> String {
    let cleaned: String = key
        .trim()
        .chars()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        DEFAULT_PROFILE_STATE_KEY.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Resolve the account key to use for state addressing: an explicit non-blank
/// profile wins, else the active-profile marker, else `default`.
pub fn resolve_profile_key(profile: Option<&str>) -> String {
    if let Some(explicit) = profile
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default")
    {
        return sanitize_profile_key(explicit);
    }
    if let Some(active) = read_active_profile_key() {
        let active = active.trim();
        if !active.is_empty() && active != "default" {
            return sanitize_profile_key(active);
        }
    }
    DEFAULT_PROFILE_STATE_KEY.to_string()
}

/// State dir for the given profile, falling back to the active account (then
/// `default`). This is what callers should use instead of
/// `state_v8_dir_for_profile(None)` so logged-out and per-account paths both work.
pub fn state_v8_dir_for_profile_or_active(profile: Option<&str>) -> Result<PathBuf, String> {
    Ok(state_v8_base_dir()?.join(resolve_profile_key(profile)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_dir_is_prefixed() {
        let dir = runtime_version_dir("2026.6.11").unwrap();
        assert!(dir.ends_with("runtime/v2026.6.11"));
    }

    #[test]
    fn default_profile_maps_to_default_state() {
        let none = state_v8_dir_for_profile(None).unwrap();
        let blank = state_v8_dir_for_profile(Some("  ")).unwrap();
        let explicit = state_v8_dir_for_profile(Some("default")).unwrap();
        assert!(none.ends_with("state-v8/uniopc-2026_8_1/default"));
        assert_eq!(none, blank);
        assert_eq!(none, explicit);
        let named = state_v8_dir_for_profile(Some("team-a")).unwrap();
        assert!(named.ends_with("state-v8/uniopc-2026_8_1/team-a"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_data_dir_is_application_support() {
        let dir = uniopc_data_dir().unwrap();
        assert!(dir.ends_with("Library/Application Support/Uniopc"));
    }

    #[test]
    fn sanitize_profile_key_keeps_safe_chars_and_defaults_blank() {
        assert_eq!(sanitize_profile_key("Owner-Profile_1"), "owner-profile_1");
        assert_eq!(sanitize_profile_key("bootiful.wtf@x/../y"), "bootiful_wtf_x____y");
        assert_eq!(sanitize_profile_key("   "), "default");
        assert_eq!(sanitize_profile_key("///"), "default");
        // no path traversal survives
        assert!(!sanitize_profile_key("../../etc").contains('/'));
        assert!(!sanitize_profile_key("..\\win").contains('\\'));
    }

    #[test]
    fn resolve_profile_key_prefers_explicit_and_sanitizes() {
        // Explicit non-blank profile always wins — pure, no disk/marker read.
        // (Blank / "default" fall through to the active marker, which is
        // disk-dependent, so it's covered by manual verification rather than a
        // flaky unit test on a machine that may have a live marker.)
        assert_eq!(resolve_profile_key(Some("Team-A")), "team-a");
        assert_eq!(resolve_profile_key(Some("  Owner_9  ")), "owner_9");
    }

    #[test]
    fn state_v8_dir_for_profile_is_sanitized() {
        let dir = state_v8_dir_for_profile(Some("Team A/../x")).unwrap();
        assert!(dir.ends_with("state-v8/uniopc-2026_8_1/team_a____x"));
        let def = state_v8_dir_for_profile(None).unwrap();
        assert!(def.ends_with("state-v8/uniopc-2026_8_1/default"));
    }

    #[test]
    fn profile_state_uses_state_v8_and_never_legacy_state() {
        let dir = state_v8_dir_for_profile(Some("Team A")).unwrap();
        assert!(dir.ends_with("state-v8/uniopc-2026_8_1/team_a"));
        assert!(!dir.to_string_lossy().contains("/state/team_a"));
    }

    #[test]
    fn state_root_isolated_by_the_compiled_openclaw_compatibility_version() {
        let base = state_v8_base_dir().unwrap();
        assert!(base.ends_with("state-v8/uniopc-2026_8_1"));
        assert_ne!(base, uniopc_data_dir().unwrap().join("state-v8"));
    }

    #[test]
    fn migrates_the_legacy_compatibility_root_without_losing_profiles() {
        let root = std::env::temp_dir().join(format!("uniopc-state-migration-{}", std::process::id()));
        let state_root = root.join("state-v8");
        let legacy = state_root.join("openclaw-2026_8_1");
        std::fs::create_dir_all(legacy.join("profile-a/media/uniopc-superip")).unwrap();
        std::fs::write(legacy.join("profile-a/media/uniopc-superip/clip.mp4"), b"video").unwrap();

        let migrated = migrate_legacy_state_v8_base_dir(&state_root, "2026_8_1").unwrap();

        assert_eq!(migrated, state_root.join("uniopc-2026_8_1"));
        assert!(!legacy.exists());
        assert_eq!(std::fs::read(migrated.join("profile-a/media/uniopc-superip/clip.mp4")).unwrap(), b"video");
        let _ = std::fs::remove_dir_all(root);
    }
}
