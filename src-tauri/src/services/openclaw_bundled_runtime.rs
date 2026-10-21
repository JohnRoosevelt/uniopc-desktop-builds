//! Bundled engine runtime: first-launch offline install into Uniopc's
//! private, versioned runtime directory.
//!
//! The release build packs a prefix-relocatable runtime archive
//! (`uniopc-engine-runtime-<platform>-<arch>.tar.gz`, produced by
//! `scripts/build-openclaw-runtime-bundle.mjs`) into the app resources under
//! `uniopc-engine-runtime/`. On first launch we extract it into
//! `<app data>/Uniopc/runtime/v<version>/` and point `runtime/current` at it
//! (see `uniopc_runtime_paths`). Upgrades extract a new version dir and flip
//! the pointer; rollback is flipping it back. The layout is private to
//! Uniopc — a developer's own `~/.openclaw` install is neither read nor
//! touched.
//!
//! The build-generated catalog includes a digest and expected size for every
//! platform/architecture artifact. Those values are re-verified before any
//! archive is extracted, even when the outer app bundle is code-signed.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::services::openclaw_engine_contract::OPENCLAW_ENGINE_VERSION;
use crate::services::openclaw_runtime_catalog::{
    node_version_is_supported, select_runtime_artifact, verify_archive_bytes, RuntimeArtifact,
    RuntimeCatalog,
};
use crate::services::uniopc_runtime_paths as runtime_paths;

pub const RUNTIME_RESOURCE_DIR: &str = "uniopc-engine-runtime";
const RUNTIME_CATALOG_FILE: &str = "uniopc-engine-runtime.catalog.json";
const RUNTIME_SUBTREES: &[&str] = &["bin", "tools"];
const INSTALLING_MARKER: &str = ".uniopc-installing";
const CLEANUP_WARNING_FILE: &str = "runtime-cleanup-warning.txt";

// Serialize runtime activation within the process. The startup hook and the
// frontend install command both call ensure_bundled_runtime_installed; without
// this they race into the same staging dir and clobber each other (one sees a
// half-deleted "missing bin/", the other hits os error 32 on the version-dir
// rename). The loser now just waits and observes AlreadyExtracted.
static ACTIVATION_LOCK: Mutex<Option<VerifiedArchive>> = Mutex::new(None);
// Serialize pointer flips against post-health cleanup so an engine update cannot
// activate a new version between the health check and removal of the old one.
static RUNTIME_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());
// Monotonic suffix so each extraction stages into its own dir even if two ever
// run without the lock (belt-and-suspenders alongside ACTIVATION_LOCK).
static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

/// A release must never activate an embedded runtime older or newer than the
/// engine version compiled into the app. Runtime artifacts are deliberately
/// ignored by git and rebuilt per platform, so this guard prevents a stale
/// local/CI artifact from downgrading an otherwise valid private runtime.
fn bundled_artifact_matches_declared_version(version: &str) -> bool {
    version == OPENCLAW_ENGINE_VERSION
}

#[derive(Debug, Clone)]
pub enum BundledRuntimeOutcome {
    /// The bundled version dir is already active.
    AlreadyExtracted { version: String },
    /// The bundled runtime was extracted (or re-activated) and `current` now
    /// points at it.
    Extracted { version: String },
    /// No usable bundle for this machine (dev build, arch mismatch, missing or
    /// invalid artifact). Callers must surface the diagnostic rather than use
    /// a network installer.
    Unavailable { reason: String },
}

/// A runtime install is immutable for a specific verified artifact, not only
/// for an OpenClaw package version. This lets us ship a repaired bundle built
/// from the same upstream version without overwriting the runtime that is
/// currently executing.
fn artifact_runtime_id(artifact: &RuntimeArtifact) -> Result<String, String> {
    let digest = artifact.sha256.trim().to_ascii_lowercase();
    if digest.len() < 12
        || !digest
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("内置运行时清单的 SHA-256 格式无效。".to_string());
    }
    Ok(format!("{}-{}", artifact.version, &digest[..12]))
}

/// Node's `process.platform` / `process.arch` names, to match the manifest
/// written by the bundle build script.
fn node_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn node_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        "unknown"
    }
}

fn bundled_runtime_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(RUNTIME_RESOURCE_DIR);
        if bundled.join(RUNTIME_CATALOG_FILE).exists() {
            return Some(bundled);
        }
    }
    // Dev builds read straight from the repo (populated by
    // `npm run build:openclaw-runtime`).
    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(RUNTIME_RESOURCE_DIR);
    if dev_dir.join(RUNTIME_CATALOG_FILE).exists() {
        return Some(dev_dir);
    }
    None
}

/// The verified bundled runtime artifact + archive path, when one exists that
/// matches this machine's platform/arch.
pub fn bundled_runtime_archive(app: &AppHandle) -> Result<(RuntimeArtifact, PathBuf), String> {
    let mut verified_archive = ACTIVATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (artifact, archive) = select_bundled_runtime_archive(app)?;
    verify_archive_cached(&artifact, &archive, &mut verified_archive)?;
    Ok((artifact, archive))
}

fn select_bundled_runtime_archive(app: &AppHandle) -> Result<(RuntimeArtifact, PathBuf), String> {
    let dir = bundled_runtime_dir(app)
        .ok_or_else(|| "安装包内未携带 Uniopc 引擎运行时制品。".to_string())?;
    let catalog_raw = fs::read_to_string(dir.join(RUNTIME_CATALOG_FILE))
        .map_err(|e| format!("读取内置运行时清单失败: {e}"))?;
    let catalog: RuntimeCatalog =
        serde_json::from_str(&catalog_raw).map_err(|e| format!("解析内置运行时清单失败: {e}"))?;
    let artifact = select_runtime_artifact(&catalog, node_platform(), node_arch())?.clone();
    if !bundled_artifact_matches_declared_version(&artifact.version) {
        return Err(format!(
            "内置 Uniopc 引擎版本 {} 与应用声明的精确版本 {} 不一致。",
            artifact.version, OPENCLAW_ENGINE_VERSION
        ));
    }
    if !node_version_is_supported(&artifact.node_version) {
        return Err(format!(
            "内置 Node.js 版本 {} 不满足 OpenClaw 8.1 运行时要求。",
            artifact.node_version
        ));
    }
    let archive = dir.join(&artifact.archive);
    if !archive.is_file() {
        return Err(format!(
            "内置运行时压缩包缺失: {}",
            archive.to_string_lossy()
        ));
    }
    Ok((artifact, archive))
}

fn verify_archive_file(artifact: &RuntimeArtifact, archive: &Path) -> Result<(), String> {
    let archive_bytes = fs::read(archive).map_err(|e| {
        format!(
            "读取内置运行时压缩包失败 {}: {e}",
            archive.to_string_lossy()
        )
    })?;
    verify_archive_bytes(artifact, &archive_bytes)
}

// Process-local only: each app launch verifies the archive at least once.
// Include every catalog field and filesystem identity/change metadata so an
// updated or replaced bundle cannot inherit another artifact's verification.
/// A cheap-to-recheck identity for an archive that has already passed its
/// digest verification. It is persisted so an unchanged release archive is
/// not re-hashed on the first engine start of every desktop process.
///
/// This is an optimization, never an authorization for extraction: extraction
/// always clears the cache and verifies the archive bytes again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct VerifiedArchive {
    artifact: serde_json::Value,
    path: PathBuf,
    len: u64,
    modified_nanos: u128,
    created_nanos: Option<u128>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

fn archive_fingerprint(
    artifact: &RuntimeArtifact,
    archive: &Path,
) -> Result<VerifiedArchive, String> {
    let metadata =
        fs::metadata(archive).map_err(|error| format!("读取运行时制品信息失败: {error}"))?;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(VerifiedArchive {
        artifact: serde_json::json!({
            "version": artifact.version, "platform": artifact.platform,
            "arch": artifact.arch, "archive": artifact.archive,
            "sha256": artifact.sha256, "sizeBytes": artifact.size_bytes,
            "nodeVersion": artifact.node_version,
        }),
        path: archive.to_path_buf(),
        len: metadata.len(),
        modified_nanos: metadata
            .modified()
            .map_err(|error| format!("读取运行时制品修改时间失败: {error}"))?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| format!("运行时制品修改时间早于 Unix epoch: {error}"))?
            .as_nanos(),
        created_nanos: metadata.created().ok().and_then(|time| {
            time.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|duration| duration.as_nanos())
        }),
        #[cfg(unix)]
        identity: (
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        ),
    })
}

fn verified_archive_stamp_path() -> Result<PathBuf, String> {
    Ok(runtime_paths::runtime_base_dir()?.join("verified-archive.json"))
}

fn load_verified_archive_stamp_at(path: &Path) -> Option<VerifiedArchive> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn store_verified_archive_stamp_at(
    path: &Path,
    fingerprint: &VerifiedArchive,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "运行时校验缓存路径无父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建运行时校验缓存目录失败: {error}"))?;
    let staged = parent.join(format!(".verified-archive-{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec(fingerprint)
        .map_err(|error| format!("序列化运行时校验缓存失败: {error}"))?;
    fs::write(&staged, bytes).map_err(|error| format!("写入运行时校验缓存失败: {error}"))?;
    if let Err(initial_error) = fs::rename(&staged, path) {
        // Windows does not replace an existing destination. This cache is
        // expendable, so a brief remove-and-replace fallback is sufficient.
        let _ = fs::remove_file(path);
        fs::rename(&staged, path).map_err(|error| {
            format!("提交运行时校验缓存失败: {initial_error}; fallback: {error}")
        })?;
    }
    Ok(())
}

fn persisted_archive_is_verified(
    artifact: &RuntimeArtifact,
    archive: &Path,
    stamp_path: &Path,
) -> Result<bool, String> {
    let fingerprint = archive_fingerprint(artifact, archive)?;
    Ok(load_verified_archive_stamp_at(stamp_path).as_ref() == Some(&fingerprint))
}

/// Returns true when this call performed full verification. Extraction callers
/// still verify unconditionally immediately before extraction.
fn verify_archive_cached(
    artifact: &RuntimeArtifact,
    archive: &Path,
    cached: &mut Option<VerifiedArchive>,
) -> Result<bool, String> {
    let before = archive_fingerprint(artifact, archive)?;
    if cached.as_ref() == Some(&before) {
        return Ok(false);
    }
    *cached = None;
    verify_archive_file(artifact, archive)?;
    let after = archive_fingerprint(artifact, archive)?;
    if before != after {
        return Err("内置运行时制品在校验期间发生变化，请重试。".to_string());
    }
    *cached = Some(after);
    Ok(true)
}

/// Version of the openclaw npm package installed under a runtime dir, if any.
pub fn installed_openclaw_version(runtime_dir: &Path) -> Option<String> {
    let tools_dir = runtime_dir.join("tools");
    let read_version = |package_json: &Path| -> Option<String> {
        let raw = fs::read_to_string(package_json).ok()?;
        let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
        json.get("version")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    // Unix install-cli.sh layout keeps global modules under `lib/node_modules`;
    // Windows npm keeps them at the prefix root (`node_modules`). Probe both so
    // the same detector works for the macOS bundle and the Windows provision.
    let module_suffixes: [&[&str]; 2] = [
        &["lib", "node_modules", "uniopc-engine", "package.json"],
        &["node_modules", "uniopc-engine", "package.json"],
    ];
    let alias_root = tools_dir.join("node");
    for suffix in module_suffixes {
        if let Some(version) = read_version(&join_all(&alias_root, suffix)) {
            return Some(version);
        }
    }
    for entry in fs::read_dir(tools_dir).ok()?.filter_map(Result::ok) {
        let root = entry.path();
        for suffix in module_suffixes {
            if let Some(version) = read_version(&join_all(&root, suffix)) {
                return Some(version);
            }
        }
    }
    None
}

fn join_all(base: &Path, parts: &[&str]) -> PathBuf {
    let mut path = base.to_path_buf();
    for part in parts {
        path = path.join(part);
    }
    path
}

fn runtime_shim_path(runtime_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        // Natural Windows npm-prefix layout: the engine shim sits at the node
        // prefix root next to node.exe, not under bin/ (which only the Unix
        // install-cli.sh bundle produces).
        runtime_dir
            .join("tools")
            .join("node")
            .join("uniopc-engine.cmd")
    } else {
        runtime_dir.join("bin").join("uniopc-engine")
    }
}

fn runtime_node_path(runtime_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        runtime_dir.join("tools").join("node").join("node.exe")
    } else {
        runtime_dir
            .join("tools")
            .join("node")
            .join("bin")
            .join("node")
    }
}

fn installed_node_version(runtime_dir: &Path) -> Option<String> {
    let mut command = Command::new(runtime_node_path(runtime_dir));
    // `node.exe --version` is also a console-subsystem program. Runtime
    // validation happens during desktop startup, so hide this brief probe just
    // like every other Windows OpenClaw/Node child.
    crate::services::openclaw_cli::hide_console(&mut command);
    let output = command.arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// A runtime directory is usable when its shim exists and its package version
/// matches the expected engine version. Its directory name may include an
/// artifact digest, so it is deliberately not used as the package version.
fn runtime_dir_is_valid(runtime_id: &str, expected_engine_version: &str) -> bool {
    let Ok(dir) = runtime_paths::runtime_version_dir(runtime_id) else {
        return false;
    };
    runtime_dir_is_valid_at(&dir, expected_engine_version)
}

fn runtime_dir_is_valid_at(dir: &Path, expected_engine_version: &str) -> bool {
    !dir.join(INSTALLING_MARKER).exists()
        && runtime_shim_path(dir).exists()
        && installed_openclaw_version(dir).as_deref() == Some(expected_engine_version)
        && installed_node_version(dir).is_some_and(|node| node_version_is_supported(&node))
}

/// Where `runtime/current` points right now, if anywhere valid. Prefers the
/// unix symlink target; falls back to the `current.version` marker (the sole
/// source of truth on Windows, which uses no traversable reparse point).
pub fn current_runtime_version() -> Option<String> {
    let runtime_id = current_runtime_pointer_version()?;
    runtime_dir_is_valid(&runtime_id, OPENCLAW_ENGINE_VERSION).then_some(runtime_id)
}

/// Polling hint only: this does not authenticate Node or authorize a launch.
/// Full runtime verification remains mandatory before recovery is consumed.
#[derive(Debug, PartialEq, Eq)]
pub struct UnverifiedRecoveryRuntimeIdentity(String);
impl UnverifiedRecoveryRuntimeIdentity {
    pub fn matches_runtime(&self, runtime: &str) -> bool {
        self.0 == runtime
    }
}

pub fn unverified_recovery_runtime_identity() -> Option<UnverifiedRecoveryRuntimeIdentity> {
    let base = runtime_paths::runtime_base_dir().ok()?;
    unverified_recovery_runtime_identity_at(&base)
}

fn unverified_recovery_runtime_identity_at(
    base: &Path,
) -> Option<UnverifiedRecoveryRuntimeIdentity> {
    let runtime_id = current_runtime_pointer_version_at(base)?;
    let dir = base.join(format!("v{runtime_id}"));
    if dir.join(INSTALLING_MARKER).try_exists().ok()?
        || !runtime_shim_path(&dir).is_file()
        || installed_openclaw_version(&dir).as_deref() != Some(OPENCLAW_ENGINE_VERSION)
        || !runtime_node_path(&dir).is_file()
    {
        return None;
    }
    Some(UnverifiedRecoveryRuntimeIdentity(runtime_id))
}

fn current_runtime_pointer_version() -> Option<String> {
    current_runtime_pointer_version_at(&runtime_paths::runtime_base_dir().ok()?)
}

fn current_runtime_pointer_version_at(base: &Path) -> Option<String> {
    let from_link = fs::read_link(base.join("current")).ok().and_then(|target| {
        target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .and_then(|name| name.strip_prefix('v').map(str::to_string))
    });
    let version = from_link.or_else(|| {
        fs::read_to_string(base.join("current.version"))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })?;
    Some(version)
}

/// The gateway may start only after `current_runtime_version` has checked the
/// installed package, shim, and embedded Node.js version against the exact
/// engine contract. The pointer may contain an artifact digest.
pub fn active_runtime_is_verified() -> bool {
    active_runtime_version_is_verified(current_runtime_version().as_deref())
}

fn active_runtime_version_is_verified(version: Option<&str>) -> bool {
    version.is_some()
}

/// Atomically point the active runtime at `runtime/v<version>` and record it in
/// the marker file. Unix uses a `runtime/current` symlink; Windows relies solely
/// on the marker (see `runtime_current_dir`).
fn flip_current_pointer(version: &str) -> Result<(), String> {
    let _lifecycle = RUNTIME_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let base = runtime_paths::runtime_base_dir()?;
    fs::create_dir_all(&base).map_err(|e| format!("创建运行时目录失败: {e}"))?;
    // The literal `current` entry (symlink on unix / stale junction on Windows),
    // NOT `runtime_current_dir()` which resolves through the marker on Windows.
    let current = base.join("current");

    #[cfg(unix)]
    {
        let staged = base.join(format!(".current-staging-{}", std::process::id()));
        let _ = fs::remove_file(&staged);
        std::os::unix::fs::symlink(format!("v{version}"), &staged)
            .map_err(|e| format!("创建运行时指针失败: {e}"))?;
        fs::rename(&staged, &current).map_err(|e| format!("切换运行时指针失败: {e}"))?;
    }

    #[cfg(windows)]
    {
        // No reparse point on Windows: `runtime_current_dir` resolves the active
        // version straight from the marker below. Clear any stale junction from
        // an earlier build so it can't shadow the marker.
        remove_current_pointer(&current);
    }

    fs::write(runtime_paths::current_marker_path()?, version)
        .map_err(|e| format!("写入运行时版本标记失败: {e}"))?;
    // Keep the previous version until the new Gateway has connected and passed
    // health. That preserves rollback files if startup fails after activation.
    Ok(())
}

/// Remove only version directories directly under Uniopc's private runtime
/// root. Cleanup is gated on a successful Gateway health connection.
fn prune_stale_runtime_versions_after_health(
    gateway_healthy: bool,
    base: &Path,
    keep: &str,
    mut remove_dir: impl FnMut(&Path) -> std::io::Result<()>,
) -> Vec<String> {
    if !gateway_healthy {
        return Vec::new();
    }
    let keep_dir = format!("v{keep}");
    let entries = match fs::read_dir(base) {
        Ok(entries) => entries,
        Err(error) => return vec![format!("无法读取旧引擎运行文件目录：{error}")],
    };
    let mut failures = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // A directory name is `v` followed by a version/digest token. Never
        // touch current, markers, staging, links, or adjacent user data.
        if !name.starts_with('v')
            || name == keep_dir
            || name.len() < 2
            || !name.as_bytes()[1].is_ascii_digit()
            || !name[1..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        {
            continue;
        }
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => {
                if let Err(error) = remove_dir(&entry.path()) {
                    failures.push(format!("无法清理旧引擎运行文件 {name}：{error}"));
                }
            }
            _ => {}
        }
    }
    failures
}

// Older Windows builds cached immutable engine archives beside the app under
// Local/Uniopc/openclaw-runtime. Only remove digest-named archives; anything
// else in that directory could be user data and must be left alone.
#[cfg(any(windows, test))]
fn prune_legacy_windows_runtime_archive_cache(cache_dir: &Path) -> Vec<String> {
    let entries = match fs::read_dir(cache_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => return vec![format!("无法读取旧引擎缓存：{error}")],
    };
    let mut failures = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(digest) = name.strip_suffix(".gz") else {
            continue;
        };
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        if entry.file_type().is_ok_and(|kind| kind.is_file()) {
            if let Err(error) = fs::remove_file(entry.path()) {
                failures.push(format!("无法清理旧引擎缓存 {name}：{error}"));
            }
        }
    }
    if let Err(error) = fs::remove_dir(cache_dir) {
        if error.kind() != std::io::ErrorKind::DirectoryNotEmpty {
            failures.push(format!("无法移除旧引擎缓存目录：{error}"));
        }
    }
    failures
}

fn record_runtime_cleanup(failures: Vec<String>) {
    let Ok(base) = runtime_paths::runtime_base_dir() else {
        return;
    };
    let warning_path = base.join(CLEANUP_WARNING_FILE);
    if failures.is_empty() {
        let _ = fs::remove_file(warning_path);
    } else {
        let message = format!(
            "旧版本引擎运行文件清理未完成：{}。应用仍可继续使用；下次启动会重试。",
            failures.join("；")
        );
        let _ = fs::write(warning_path, message);
    }
}

pub fn runtime_cleanup_warning() -> Option<String> {
    let path = runtime_paths::runtime_base_dir()
        .ok()?
        .join(CLEANUP_WARNING_FILE);
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Called only after the app has connected to the Gateway and confirmed its
/// health. Keep old runtimes until this point so a failed startup can still be
/// diagnosed or rolled back. Failure is non-fatal and retried at the next
/// healthy connection.
pub fn cleanup_stale_runtime_versions_after_gateway_connected(expected_runtime_id: &str) {
    let _lifecycle = RUNTIME_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if current_runtime_version().as_deref() != Some(expected_runtime_id) {
        return;
    }
    let Ok(base) = runtime_paths::runtime_base_dir() else {
        return;
    };
    let failures =
        prune_stale_runtime_versions_after_health(true, &base, expected_runtime_id, |path| {
            fs::remove_dir_all(path)
        });
    #[cfg(windows)]
    let failures = {
        let mut failures = failures;
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let legacy_cache = PathBuf::from(local_app_data)
                .join("Uniopc")
                .join("openclaw-runtime");
            failures.extend(prune_legacy_windows_runtime_archive_cache(&legacy_cache));
        }
        failures
    };
    record_runtime_cleanup(failures);
}

/// Remove the `current` reparse point (junction/symlink) without deleting the
/// version dir it targets. `remove_dir` unlinks a junction in place;
/// `remove_file` covers a symlink; a stray real dir is cleared last.
#[cfg(windows)]
fn remove_current_pointer(current: &Path) {
    if !current.exists() && fs::symlink_metadata(current).is_err() {
        return;
    }
    if fs::remove_dir(current).is_ok() {
        return;
    }
    if fs::remove_file(current).is_ok() {
        return;
    }
    let _ = fs::remove_dir_all(current);
}

/// The `tar` to shell out to. macOS and Windows 10+ both ship bsdtar, but on
/// Windows resolve it by absolute path (System32\tar.exe) rather than the bare
/// `tar` on PATH: a dev/CI shell (git-bash, MSYS) can shadow it with GNU tar,
/// which can't extract the deep nested node_modules paths in the runtime archive
/// (it fails creating `\\?\C:\...` long paths). bsdtar handles them. Falls back
/// to `tar` when the system copy is somehow absent.
fn tar_program() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let root = std::env::var_os("SystemRoot")
            .or_else(|| std::env::var_os("windir"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        let system_tar = root.join("System32").join("tar.exe");
        if system_tar.exists() {
            return system_tar;
        }
    }
    PathBuf::from("tar")
}

/// Bounded retries for platforms which commit installation by renaming staging.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last: std::io::Result<()> = Ok(());
    for attempt in 0..5u32 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last = Err(error);
                std::thread::sleep(std::time::Duration::from_millis(
                    150 * u64::from(attempt + 1),
                ));
            }
        }
    }
    last
}

/// Windows denies renaming a tree while a descendant is open, even with
/// FILE_SHARE_DELETE. In the 0.4.18 VM trace, running staged node.exe --version
/// triggered DiagTrack opens/mappings which outlived the probe and all retries.
/// Extract into the immutable destination
/// instead, guarded by a marker which excludes partial installs from activation.
/// Unix retains atomic staging/rename. Neither path changes the active pointer.
fn install_runtime_directory(
    staging: &Path,
    destination: &Path,
    direct: bool,
    install: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let work = if direct { destination } else { staging };
    if work.exists() {
        fs::remove_dir_all(work).map_err(|error| {
            format!("清理未完成的运行时目录失败（{}）: {error}", work.display())
        })?;
    }
    fs::create_dir_all(work)
        .map_err(|error| format!("创建运行时目录失败（{}）: {error}", work.display()))?;
    fs::write(work.join(INSTALLING_MARKER), b"pending verification\n")
        .map_err(|error| format!("记录运行时安装状态失败: {error}"))?;
    let cleanup_failure = |error: String| {
        // Direct Windows installs keep one marked, non-active directory for
        // the next explicit retry. Do not accumulate Unix staging directories.
        if !direct {
            if let Err(cleanup) = fs::remove_dir_all(work) {
                return format!("{error}; 清理暂存目录失败（{}）: {cleanup}", work.display());
            }
        }
        error
    };
    install(work).map_err(&cleanup_failure)?;
    if !direct {
        if destination.exists() {
            fs::remove_dir_all(destination).map_err(|error| {
                cleanup_failure(format!(
                    "清理旧的运行时目标目录失败（{}）: {error}",
                    destination.display()
                ))
            })?;
        }
        rename_with_retry(work, destination).map_err(|error| {
            cleanup_failure(format!(
                "落位运行时版本目录失败（{} -> {}）: {error}",
                work.display(),
                destination.display()
            ))
        })?;
    }
    fs::remove_file(destination.join(INSTALLING_MARKER))
        .map_err(|error| format!("完成运行时安装校验失败: {error}"))?;
    Ok(())
}

fn extract_archive(archive: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| format!("创建运行时解压目录失败: {e}"))?;
    let mut command = Command::new(tar_program());
    command.arg("-xzf").arg(archive).arg("-C").arg(destination);
    crate::services::openclaw_cli::hide_console(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("启动 tar 解压失败: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "解压内置运行时失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

fn extract_verified_archive(
    artifact: &RuntimeArtifact,
    archive: &Path,
    destination: &Path,
    cached: &mut Option<VerifiedArchive>,
) -> Result<(), String> {
    // Re-read and hash before every extraction, even if activation previously
    // verified this fingerprint. Failed verification never creates staging.
    *cached = None;
    verify_archive_cached(artifact, archive, cached)?;
    extract_archive(archive, destination)
}

/// Prefer the verified bundled artifact when one is present, including a
/// repaired artifact with the same upstream engine version. A valid existing
/// private runtime remains usable when the checkout has no bundled catalog;
/// this never probes a system-wide install.
pub fn ensure_runtime_ready(app: &AppHandle) -> Result<(), String> {
    prepare_runtime_if_needed(active_runtime_is_verified(), || {
        ensure_bundled_runtime_installed(app)
    })
}

fn prepare_runtime_if_needed(
    active_verified: bool,
    activate: impl FnOnce() -> Result<BundledRuntimeOutcome, String>,
) -> Result<(), String> {
    match activate()? {
        BundledRuntimeOutcome::Unavailable { .. } if active_verified => Ok(()),
        BundledRuntimeOutcome::Unavailable { reason } => Err(reason),
        BundledRuntimeOutcome::AlreadyExtracted { .. }
        | BundledRuntimeOutcome::Extracted { .. } => Ok(()),
    }
}

/// Install (or activate) the bundled runtime artifact. Idempotent: a valid
/// `runtime/v<version>-<digest>` that `current` already points at is a no-op;
/// an existing valid artifact dir that lost the pointer is just re-pointed.
pub fn ensure_bundled_runtime_installed(app: &AppHandle) -> Result<BundledRuntimeOutcome, String> {
    // Serialize before archive I/O: a concurrent caller reuses verification
    // completed by the first activation, rather than hashing the same archive.
    let mut verified_archive = ACTIVATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (artifact, archive) = match select_bundled_runtime_archive(app) {
        Ok(found) => found,
        Err(reason) => return Ok(BundledRuntimeOutcome::Unavailable { reason }),
    };
    let runtime_id = artifact_runtime_id(&artifact)?;
    let installed_valid = runtime_dir_is_valid(&runtime_id, &artifact.version);
    if installed_valid {
        let stamp_path = verified_archive_stamp_path()?;
        if !persisted_archive_is_verified(&artifact, &archive, &stamp_path)? {
            verify_archive_cached(&artifact, &archive, &mut verified_archive)?;
            // A cache-write failure only loses the fast path; it must not block
            // a verified runtime from starting.
            let _ = store_verified_archive_stamp_at(
                &stamp_path,
                verified_archive.as_ref().expect("verified archive"),
            );
        }
        if current_runtime_pointer_version().as_deref() == Some(runtime_id.as_str()) {
            return Ok(BundledRuntimeOutcome::AlreadyExtracted {
                version: artifact.version,
            });
        }
    } else {
        let base = runtime_paths::runtime_base_dir()?;
        let staging = base.join(format!(
            ".extract-staging-{}-{}",
            std::process::id(),
            STAGING_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let version_dir = runtime_paths::runtime_version_dir(&runtime_id)?;
        install_runtime_directory(&staging, &version_dir, cfg!(windows), |work| {
            extract_verified_archive(&artifact, &archive, work, &mut verified_archive)?;
            let staged_version = installed_openclaw_version(work)
                .ok_or_else(|| "解压后的内置运行时缺少引擎包版本信息。".to_string())?;
            if staged_version != artifact.version {
                return Err(format!(
                    "内置运行时版本不一致: 清单为 {}，压缩包内为 {staged_version}。",
                    artifact.version
                ));
            }
            let staged_node = installed_node_version(work)
                .ok_or_else(|| "解压后的内置运行时缺少 Node.js 版本信息。".to_string())?;
            if !node_version_is_supported(&staged_node)
                || staged_node.trim_start_matches('v')
                    != artifact.node_version.trim_start_matches('v')
            {
                return Err(format!(
                    "解压后的 Node.js 版本 {staged_node} 不满足 OpenClaw 8.1 运行时要求。"
                ));
            }
            for subtree in RUNTIME_SUBTREES {
                if !work.join(subtree).exists() {
                    return Err(format!("内置运行时缺少 {subtree}/ 子目录。"));
                }
            }
            Ok(())
        })?;
        if let Ok(stamp_path) = verified_archive_stamp_path() {
            if let Some(fingerprint) = verified_archive.as_ref() {
                // The extraction path has just performed a mandatory full
                // digest verification, so seed the next-process fast path.
                let _ = store_verified_archive_stamp_at(&stamp_path, fingerprint);
            }
        }
    }

    flip_current_pointer(&runtime_id)?;
    Ok(BundledRuntimeOutcome::Extracted {
        version: artifact.version,
    })
}

/// Warm-start fast check used by the status fast path: true when
/// `runtime/current` resolves to a valid install of `version`.
pub fn active_runtime_matches(version: &str) -> bool {
    current_runtime_version()
        .as_deref()
        .is_some_and(|runtime_id| runtime_dir_is_valid(runtime_id, version))
}

/// Point `runtime/current` at an already-installed version dir (used after
/// the network-installer fallback populates `runtime/v<version>` directly).
pub fn activate_runtime_version(version: &str) -> Result<(), String> {
    if !runtime_dir_is_valid(version, version) {
        return Err(format!("运行时版本目录无效或缺失: v{version}"));
    }
    flip_current_pointer(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn recovery_await_boundaries_reject_replaced_node_and_runtime() {
        use std::os::unix::fs::PermissionsExt;
        for boundary in ["before_spawn", "before_activation"] {
            for changed in ["node", "runtime"] {
                let root =
                    std::env::temp_dir().join(format!("uniopc-await-{}", uuid::Uuid::new_v4()));
                let dir = root.join("vfixture");
                let package = dir.join("tools/node/node_modules/uniopc-engine/package.json");
                fs::create_dir_all(package.parent().unwrap()).unwrap();
                fs::create_dir_all(runtime_node_path(&dir).parent().unwrap()).unwrap();
                fs::create_dir_all(runtime_shim_path(&dir).parent().unwrap()).unwrap();
                fs::write(root.join("current.version"), "fixture").unwrap();
                fs::write(runtime_shim_path(&dir), "shim").unwrap();
                fs::write(
                    &package,
                    serde_json::json!({"version": OPENCLAW_ENGINE_VERSION}).to_string(),
                )
                .unwrap();
                let node = runtime_node_path(&dir);
                fs::write(&node, "#!/bin/sh\nprintf 'v24.19.0\\n'\n").unwrap();
                fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
                assert!(runtime_dir_is_valid_at(&dir, OPENCLAW_ENGINE_VERSION));
                // Simulate replacement while termination/reaping or spawn is awaited.
                let mutation_dir = dir.clone();
                tokio::spawn(async move {
                    tokio::task::yield_now().await;
                    if changed == "node" {
                        fs::write(
                            runtime_node_path(&mutation_dir),
                            "#!/bin/sh\nprintf 'v1.0.0\\n'\n",
                        )
                        .unwrap();
                    } else {
                        fs::write(
                            mutation_dir.join("tools/node/node_modules/uniopc-engine/package.json"),
                            r#"{"version":"changed"}"#,
                        )
                        .unwrap();
                    }
                })
                .await
                .unwrap();
                // The cheap hint deliberately cannot authenticate a replaced Node.
                assert_eq!(
                    unverified_recovery_runtime_identity_at(&root).is_some(),
                    changed == "node"
                );
                let mut spawned = boundary == "before_activation";
                let mut activated = false;
                if runtime_dir_is_valid_at(&dir, OPENCLAW_ENGINE_VERSION) {
                    if boundary == "before_spawn" {
                        spawned = true;
                    } else {
                        activated = true;
                    }
                }
                assert_eq!(
                    spawned,
                    boundary == "before_activation",
                    "{boundary}: {changed} replacement must block spawn"
                );
                assert!(
                    !activated,
                    "{boundary}: {changed} replacement must block activation"
                );
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn recovery_identity_is_filesystem_only_and_rejects_incomplete_runtime() {
        let root = std::env::temp_dir().join(format!("uniopc-poll-{}", uuid::Uuid::new_v4()));
        let dir = root.join("vfixture");
        fs::create_dir_all(dir.join("tools/node/node_modules/uniopc-engine")).unwrap();
        fs::create_dir_all(runtime_shim_path(&dir).parent().unwrap()).unwrap();
        fs::create_dir_all(runtime_node_path(&dir).parent().unwrap()).unwrap();
        fs::write(root.join("current.version"), "fixture").unwrap();
        fs::write(runtime_shim_path(&dir), "shim").unwrap();
        // Deliberately not an executable: polling cannot run this fake Node.
        fs::write(runtime_node_path(&dir), "not executable").unwrap();
        let package = dir.join("tools/node/node_modules/uniopc-engine/package.json");
        fs::write(
            &package,
            serde_json::json!({"version": OPENCLAW_ENGINE_VERSION}).to_string(),
        )
        .unwrap();
        for _ in 0..400 {
            assert!(unverified_recovery_runtime_identity_at(&root)
                .unwrap()
                .matches_runtime("fixture"));
        }
        fs::write(dir.join(INSTALLING_MARKER), "").unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::remove_file(dir.join(INSTALLING_MARKER)).unwrap();
        fs::write(&package, "invalid json").unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::write(&package, r#"{"version":"wrong"}"#).unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::write(
            &package,
            serde_json::json!({"version": OPENCLAW_ENGINE_VERSION}).to_string(),
        )
        .unwrap();
        fs::remove_file(runtime_node_path(&dir)).unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::write(runtime_node_path(&dir), "not executable").unwrap();
        fs::remove_file(runtime_shim_path(&dir)).unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::write(runtime_shim_path(&dir), "shim").unwrap();
        fs::write(root.join("current.version"), "different").unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("vfixture", root.join("current")).unwrap();
            assert!(unverified_recovery_runtime_identity_at(&root)
                .unwrap()
                .matches_runtime("fixture"));
            fs::remove_file(root.join("current")).unwrap();
        }
        fs::remove_file(root.join("current.version")).unwrap();
        assert!(unverified_recovery_runtime_identity_at(&root).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_windows_cache_cleanup_keeps_unrecognized_files() {
        let root =
            std::env::temp_dir().join(format!("uniopc-legacy-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let archive = root.join(format!("{}.gz", "a".repeat(64)));
        fs::write(&archive, b"old archive").unwrap();
        let unrelated = root.join("notes.txt");
        fs::write(&unrelated, b"keep").unwrap();
        assert!(prune_legacy_windows_runtime_archive_cache(&root).is_empty());
        assert!(!archive.exists());
        assert!(unrelated.exists());
        fs::remove_file(unrelated).unwrap();
        fs::remove_dir(root).unwrap();

        let emptyable =
            std::env::temp_dir().join(format!("uniopc-legacy-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&emptyable).unwrap();
        fs::write(
            emptyable.join(format!("{}.gz", "b".repeat(64))),
            b"old archive",
        )
        .unwrap();
        assert!(prune_legacy_windows_runtime_archive_cache(&emptyable).is_empty());
        assert!(!emptyable.exists());
    }

    #[test]
    fn stale_runtime_cleanup_waits_for_healthy_gateway_then_retries_after_failure() {
        let root = std::env::temp_dir().join(format!("uniopc-prune-{}", uuid::Uuid::new_v4()));
        let runtime = root.join("runtime");
        let active = runtime.join("v2.0.0-new");
        let stale = runtime.join("v1.0.0-old");
        let unrelated = runtime.join("v-not-a-version");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&stale).unwrap();
        fs::create_dir_all(&unrelated).unwrap();
        fs::create_dir_all(root.join("state-v8")).unwrap();
        fs::create_dir_all(root.join("workspace")).unwrap();
        fs::write(active.join("engine"), "active").unwrap();
        fs::write(stale.join("engine"), "old").unwrap();
        fs::write(unrelated.join("keep"), "not an install").unwrap();

        let before_health =
            prune_stale_runtime_versions_after_health(false, &runtime, "2.0.0-new", |_| {
                panic!("cleanup must not run before Gateway health succeeds")
            });
        assert!(before_health.is_empty());
        assert!(
            stale.exists(),
            "pending/failed Gateway startup retains rollback runtime"
        );

        let failures =
            prune_stale_runtime_versions_after_health(true, &runtime, "2.0.0-new", |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "fixture lock",
                ))
            });
        assert_eq!(failures.len(), 1);
        assert!(stale.exists(), "failed cleanup keeps the old dir for retry");
        assert!(
            active.join("engine").exists(),
            "active runtime is never removed"
        );
        assert!(
            unrelated.join("keep").exists(),
            "non-version entries are untouched"
        );
        assert!(root.join("state-v8").exists());
        assert!(root.join("workspace").exists());

        let failures =
            prune_stale_runtime_versions_after_health(true, &runtime, "2.0.0-new", |path| {
                fs::remove_dir_all(path)
            });
        assert!(failures.is_empty());
        assert!(
            !stale.exists(),
            "subsequent cleanup retry removes stale runtime"
        );
        assert!(active.exists());
        assert!(unrelated.exists());
        assert!(root.join("state-v8").exists());
        assert!(root.join("workspace").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn direct_install_survives_a_diagtrack_style_open_descendant() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = std::env::temp_dir().join(format!("uniopc-open-tree-{}", uuid::Uuid::new_v4()));
        let destination = root.join("runtime");
        let staging = root.join("staging");
        let mut held_file = None;
        install_runtime_directory(&staging, &destination, true, |dir| {
            let node = dir.join("node-probe.txt");
            fs::write(&node, "fixture").unwrap();
            // Match the observed DiagTrack handle: Generic Read, share Read +
            // Delete. Sharing deletion of a file still blocks its parent move.
            held_file = Some(
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0x1 | 0x4)
                    .open(node)
                    .unwrap(),
            );
            let error = fs::rename(dir, &staging).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(5));
            Ok(())
        })
        .unwrap();
        assert!(!destination.join(INSTALLING_MARKER).exists());
        assert!(!staging.exists());
        assert_eq!(
            fs::read_to_string(destination.join("node-probe.txt")).unwrap(),
            "fixture"
        );
        drop(held_file);
        fs::rename(&destination, &staging).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_direct_install_is_not_completed_and_can_be_retried() {
        let root = std::env::temp_dir().join(format!("uniopc-install-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let pointer = root.join("current.version");
        fs::write(&pointer, "old-verified-runtime").unwrap();
        let destination = root.join("new-runtime");
        let staging = root.join("staging");
        let result = install_runtime_directory(&staging, &destination, true, |dir| {
            fs::write(dir.join("partial"), "incomplete").unwrap();
            Err("simulated validation failure".into())
        });
        assert!(result.is_err());
        assert!(destination.join(INSTALLING_MARKER).exists());
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            "old-verified-runtime"
        );
        install_runtime_directory(&staging, &destination, true, |dir| {
            assert!(!dir.join("partial").exists());
            fs::write(dir.join("complete"), "verified").unwrap();
            Ok(())
        })
        .unwrap();
        assert!(!destination.join(INSTALLING_MARKER).exists());
        assert!(destination.join("complete").exists());
        assert!(
            !staging.exists(),
            "Windows path must not need a tree rename"
        );
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            "old-verified-runtime"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staging_failure_preserves_the_existing_destination() {
        let root = std::env::temp_dir().join(format!("uniopc-stage-{}", uuid::Uuid::new_v4()));
        let destination = root.join("destination");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("old"), "keep").unwrap();
        let result = install_runtime_directory(&root.join("staging"), &destination, false, |_| {
            Err("bad archive".into())
        });
        assert!(result.is_err());
        assert!(destination.join("old").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verified_private_runtime_tolerates_a_missing_bundle() {
        prepare_runtime_if_needed(true, || {
            Ok(BundledRuntimeOutcome::Unavailable {
                reason: "bundle missing".into(),
            })
        })
        .unwrap();
    }

    #[test]
    fn verified_private_runtime_still_activates_a_repaired_bundle() {
        assert!(prepare_runtime_if_needed(true, || {
            Ok(BundledRuntimeOutcome::Extracted {
                version: OPENCLAW_ENGINE_VERSION.into(),
            })
        })
        .is_ok());
    }

    #[test]
    fn unverified_private_runtime_requires_successful_offline_activation() {
        let unavailable = prepare_runtime_if_needed(false, || {
            Ok(BundledRuntimeOutcome::Unavailable {
                reason: "bundle missing".into(),
            })
        });
        assert_eq!(unavailable.unwrap_err(), "bundle missing");
        assert_eq!(
            prepare_runtime_if_needed(false, || Err("archive invalid".into())).unwrap_err(),
            "archive invalid"
        );
        assert!(prepare_runtime_if_needed(false, || {
            Ok(BundledRuntimeOutcome::Extracted {
                version: OPENCLAW_ENGINE_VERSION.into(),
            })
        })
        .is_ok());
    }

    #[test]
    fn extraction_reverifies_even_when_archive_was_cached() {
        use sha2::{Digest, Sha256};
        let root = std::env::temp_dir().join(format!("uniopc-extract-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("payload"), "local runtime").unwrap();
        let archive = root.join("runtime.tar.gz");
        assert!(Command::new(tar_program())
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&source)
            .arg("payload")
            .status()
            .unwrap()
            .success());
        let bytes = fs::read(&archive).unwrap();
        let artifact = RuntimeArtifact {
            version: OPENCLAW_ENGINE_VERSION.into(),
            platform: node_platform().into(),
            arch: node_arch().into(),
            archive: "runtime.tar.gz".into(),
            sha256: hex::encode(Sha256::digest(&bytes)),
            size_bytes: bytes.len() as u64,
            node_version: "24.19.0".into(),
        };
        let mut cache = None;
        verify_archive_cached(&artifact, &archive, &mut cache).unwrap();
        let valid_dest = root.join("valid");
        extract_verified_archive(&artifact, &archive, &valid_dest, &mut cache).unwrap();
        assert_eq!(
            fs::read_to_string(valid_dest.join("payload")).unwrap(),
            "local runtime"
        );
        fs::write(&archive, b"corrupted").unwrap();
        // Even an apparently cached fingerprint cannot authorize extraction.
        cache = Some(archive_fingerprint(&artifact, &archive).unwrap());
        let invalid_dest = root.join("invalid");
        assert!(extract_verified_archive(&artifact, &archive, &invalid_dest, &mut cache).is_err());
        assert!(!invalid_dest.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unchanged_archive_is_hashed_once_and_changes_are_rejected() {
        let dir = std::env::temp_dir().join(format!("uniopc-archive-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("runtime.tar.gz");
        fs::write(&archive, b"hello").unwrap();
        let artifact = RuntimeArtifact {
            version: OPENCLAW_ENGINE_VERSION.into(),
            platform: node_platform().into(),
            arch: node_arch().into(),
            archive: "runtime.tar.gz".into(),
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
            size_bytes: 5,
            node_version: "24.19.0".into(),
        };
        let mut cache = None;
        assert!(verify_archive_cached(&artifact, &archive, &mut cache).unwrap());
        assert!(!verify_archive_cached(&artifact, &archive, &mut cache).unwrap());
        for field in ["version", "platform", "arch", "archive", "nodeVersion"] {
            let mut changed = artifact.clone();
            match field {
                "version" => changed.version.push('x'),
                "platform" => changed.platform.push('x'),
                "arch" => changed.arch.push('x'),
                "archive" => changed.archive.push('x'),
                _ => changed.node_version.push('x'),
            }
            assert!(
                verify_archive_cached(&changed, &archive, &mut cache).unwrap(),
                "changed {field}"
            );
        }
        assert!(verify_archive_cached(&artifact, &archive, &mut cache).unwrap());
        fs::write(&archive, b"jello").unwrap();
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(2);
        fs::File::options()
            .write(true)
            .open(&archive)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(future))
            .unwrap();
        assert!(verify_archive_cached(&artifact, &archive, &mut cache).is_err());
        fs::write(&archive, b"hello").unwrap();
        let mut changed = artifact.clone();
        changed.size_bytes += 1;
        assert!(verify_archive_cached(&changed, &archive, &mut cache).is_err());
        changed.size_bytes = artifact.size_bytes;
        changed.sha256 = "a".repeat(64);
        assert!(verify_archive_cached(&changed, &archive, &mut cache).is_err());
        fs::write(&archive, b"corrupt archive").unwrap();
        assert!(verify_archive_cached(&artifact, &archive, &mut cache).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn persisted_archive_stamp_skips_rehash_only_while_metadata_and_catalog_match() {
        let dir =
            std::env::temp_dir().join(format!("uniopc-archive-stamp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("runtime.tar.gz");
        let stamp = dir.join("verified-archive.json");
        fs::write(&archive, b"hello").unwrap();
        let artifact = RuntimeArtifact {
            version: OPENCLAW_ENGINE_VERSION.into(),
            platform: node_platform().into(),
            arch: node_arch().into(),
            archive: "runtime.tar.gz".into(),
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
            size_bytes: 5,
            node_version: "24.19.0".into(),
        };
        let fingerprint = archive_fingerprint(&artifact, &archive).unwrap();
        store_verified_archive_stamp_at(&stamp, &fingerprint).unwrap();
        assert!(persisted_archive_is_verified(&artifact, &archive, &stamp).unwrap());

        fs::write(&archive, b"jello").unwrap();
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(2);
        fs::File::options()
            .write(true)
            .open(&archive)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(future))
            .unwrap();
        assert!(!persisted_archive_is_verified(&artifact, &archive, &stamp).unwrap());

        fs::write(&archive, b"hello").unwrap();
        let mut changed = artifact.clone();
        changed.node_version.push('x');
        assert!(!persisted_archive_is_verified(&changed, &archive, &stamp).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bundled_artifact_must_match_the_exact_engine_version() {
        assert!(bundled_artifact_matches_declared_version(
            OPENCLAW_ENGINE_VERSION
        ));
        assert!(!bundled_artifact_matches_declared_version("2026.7.1-2"));
        assert!(!bundled_artifact_matches_declared_version("2026.8.2"));
    }

    #[test]
    fn artifact_runtime_id_includes_the_verified_artifact_digest() {
        let mut artifact = RuntimeArtifact {
            version: OPENCLAW_ENGINE_VERSION.into(),
            platform: "darwin".into(),
            arch: "arm64".into(),
            archive: "runtime.tar.gz".into(),
            sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789".into(),
            size_bytes: 1,
            node_version: "24.19.0".into(),
        };
        assert_eq!(
            artifact_runtime_id(&artifact).unwrap(),
            format!("{}-abcdef012345", OPENCLAW_ENGINE_VERSION),
        );
        artifact.sha256 = "not-a-digest".into();
        assert!(artifact_runtime_id(&artifact).is_err());
    }

    #[test]
    fn active_runtime_pointer_is_verified_before_reaching_the_fast_path() {
        assert!(active_runtime_version_is_verified(Some(
            OPENCLAW_ENGINE_VERSION
        )));
        assert!(active_runtime_version_is_verified(Some(
            "2026.8.1-abcdef012345"
        )));
        assert!(!active_runtime_version_is_verified(None));
    }

    #[test]
    fn node_platform_matches_current_os() {
        #[cfg(target_os = "macos")]
        assert_eq!(node_platform(), "darwin");
        #[cfg(target_os = "windows")]
        assert_eq!(node_platform(), "win32");
        #[cfg(target_os = "linux")]
        assert_eq!(node_platform(), "linux");
    }

    #[test]
    fn installed_version_reads_package_json() {
        let root = std::env::temp_dir().join(format!(
            "uniopc-bundled-runtime-test-{}",
            std::process::id()
        ));
        let package_dir = root
            .join("tools")
            .join("node-v22.22.2")
            .join("lib")
            .join("node_modules")
            .join("uniopc-engine");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(
            package_dir.join("package.json"),
            "{\"name\":\"openclaw\",\"version\":\"2026.6.11\"}",
        )
        .unwrap();
        assert_eq!(
            installed_openclaw_version(&root).as_deref(),
            Some("2026.6.11")
        );
        let _ = fs::remove_dir_all(&root);
    }
}
