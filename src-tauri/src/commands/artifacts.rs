//! Commands backing the 产物 (artifacts) panel.
//!
//! Paths reach the panel from tool events, which fire *before* the tool has
//! finished writing — and an `exec` command line can mention a path that is only
//! read, never produced. So the UI never trusts a path: it asks here whether the
//! file actually exists and how big it is, and only then shows a card.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileStat {
    pub path: String,
    pub exists: bool,
    pub size: u64,
    /// Unix millis of last modification, 0 when unknown.
    pub modified_at: u64,
    pub is_directory: bool,
}

/// Resolve a media path before handing it to Tauri's asset protocol.
///
/// The private state directory has used several version-component conventions
/// across desktop releases. Chat history is durable, so older `MEDIA:` tokens can outlive a
/// directory migration. A stale
/// path makes the asset protocol correctly return 404 even though the finished
/// media file is still present in the active profile's media directory.
///
/// The fallback is deliberately narrow: it only accepts a missing path below
/// this app's former `state-v8/{Uniopc,openclaw}-*/<profile>/media/` layouts and only returns an
/// existing file below the *active* profile's current media root. It never
/// turns an arbitrary chat-supplied path into an asset URL.
#[tauri::command]
pub fn resolve_media_asset_path(path: String) -> Result<String, String> {
    let requested = PathBuf::from(path.trim());
    if !requested.is_absolute() {
        return Err("media_path_not_absolute".to_string());
    }

    if requested.is_file() {
        return Ok(requested.to_string_lossy().into_owned());
    }

    let state_root = crate::services::uniopc_runtime_paths::uniopc_data_dir()?
        .join("state-v8");
    let active_state =
        crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(None)?;
    let migrated = legacy_media_path_for_active_state(&requested, &state_root, &active_state)
        .ok_or_else(|| "media_not_found".to_string())?;

    if !migrated.is_file() {
        return Err("media_not_found".to_string());
    }
    Ok(migrated.to_string_lossy().into_owned())
}

fn legacy_media_path_for_active_state(
    requested: &Path,
    state_root: &Path,
    active_state: &Path,
) -> Option<PathBuf> {
    let components = requested
        .strip_prefix(state_root)
        .ok()?
        .components()
        .map(|component| match component {
            std::path::Component::Normal(value) => Some(value),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;

    // `{Uniopc,openclaw}-<version>/<old-profile>/media/<relative-media-path>`
    if components.len() < 4
        || !(components[0].to_string_lossy().starts_with("Uniopc-")
            || components[0].to_string_lossy().starts_with("openclaw-"))
        || components[1].is_empty()
        || components[2] != "media"
    {
        return None;
    }

    let mut target = active_state.join("media");
    for component in &components[3..] {
        target.push(component);
    }
    Some(target)
}

/// Cap the batch so a corrupted conversation store can't make the UI walk the
/// whole disk in one call.
const MAX_STAT_BATCH: usize = 500;

#[tauri::command]
pub fn artifact_stat_paths(paths: Vec<String>) -> Vec<ArtifactFileStat> {
    paths
        .into_iter()
        .take(MAX_STAT_BATCH)
        .map(|path| stat_one(&path))
        .collect()
}

fn stat_one(path: &str) -> ArtifactFileStat {
    let trimmed = path.trim();
    let metadata = (!trimmed.is_empty())
        .then(|| std::fs::metadata(trimmed).ok())
        .flatten();
    match metadata {
        Some(metadata) => ArtifactFileStat {
            path: trimmed.to_string(),
            exists: true,
            size: metadata.len(),
            modified_at: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|delta| delta.as_millis() as u64)
                .unwrap_or(0),
            is_directory: metadata.is_dir(),
        },
        None => ArtifactFileStat {
            path: trimmed.to_string(),
            exists: false,
            size: 0,
            modified_at: 0,
            is_directory: false,
        },
    }
}

/// Raw artifact index document for the active account (JSON text), or `None`
/// when nothing has been stored yet. Merge semantics live in JS — this pair of
/// commands is a durable KV, see `services/artifact_index.rs`.
#[tauri::command]
pub fn artifact_index_read() -> Result<Option<String>, String> {
    crate::services::artifact_index::read_index()
}

/// Replace the artifact index document for the active account.
#[tauri::command]
pub fn artifact_index_write(content: String) -> Result<(), String> {
    crate::services::artifact_index::write_index(&content)
}

/// Text-family previews (markdown / code / html source) read through here
/// instead of the asset protocol: artifacts can live anywhere on disk while the
/// asset scope only covers the engine's media/workspace dirs. Size-capped so a
/// mislabelled multi-GB file cannot be pulled into the webview.
const MAX_PREVIEW_TEXT_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub fn artifact_read_text(path: String) -> Result<String, String> {
    let target = existing_file(&path)?;
    let metadata = std::fs::metadata(&target).map_err(|_| "artifact_not_found".to_string())?;
    if metadata.len() > MAX_PREVIEW_TEXT_BYTES {
        return Err("artifact_too_large_for_preview".to_string());
    }
    let bytes = std::fs::read(&target).map_err(|error| error.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Reveal a produced file in Finder/Explorer. Existence is re-checked here so a
/// stale card cannot make the opener plugin raise an OS-level error dialog.
#[tauri::command]
pub fn artifact_reveal_in_dir(app: AppHandle, path: String) -> Result<(), String> {
    let target = existing_file(&path)?;
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|error| error.to_string())
}

/// Open a produced file with the OS default application.
#[tauri::command]
pub fn artifact_open_path(app: AppHandle, path: String) -> Result<(), String> {
    let target = existing_file(&path)?;
    app.opener()
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// Resolves a path the UI handed us back into something safe to act on.
///
/// The webview is only ever allowed to name a file that already exists on disk;
/// this keeps "open whatever string I send you" from becoming a generic local
/// execution surface reachable from chat content.
fn existing_file(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty_artifact_path".to_string());
    }
    let candidate = Path::new(trimmed);
    if !candidate.is_absolute() {
        return Err("artifact_path_not_absolute".to_string());
    }
    let metadata = std::fs::metadata(candidate).map_err(|_| "artifact_not_found".to_string())?;
    if !metadata.is_file() {
        return Err("artifact_not_a_file".to_string());
    }
    Ok(candidate.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_reports_missing_files_without_erroring() {
        let stat = stat_one("/definitely/not/here/deck.pptx");
        assert!(!stat.exists);
        assert_eq!(stat.size, 0);
    }

    #[test]
    fn stat_reads_size_of_a_real_file() {
        let dir = std::env::temp_dir().join("uniopc-artifact-stat-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.md");
        std::fs::write(&file, b"hello").unwrap();
        let stat = stat_one(file.to_str().unwrap());
        assert!(stat.exists);
        assert_eq!(stat.size, 5);
        assert!(!stat.is_directory);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn existing_file_rejects_relative_missing_and_directories() {
        assert!(existing_file("").is_err());
        assert!(existing_file("relative/x.md").is_err());
        assert!(existing_file("/definitely/not/here.md").is_err());
        assert!(existing_file(std::env::temp_dir().to_str().unwrap()).is_err());
    }

    #[test]
    fn stat_batch_is_capped() {
        let paths: Vec<String> = (0..MAX_STAT_BATCH + 10)
            .map(|index| format!("/nope/{index}.md"))
            .collect();
        assert_eq!(artifact_stat_paths(paths).len(), MAX_STAT_BATCH);
    }

    #[test]
    fn legacy_media_path_maps_prior_version_layouts_to_the_active_state() {
        let state_root = Path::new("/app-data/Uniopc/state-v8");
        let active_state = Path::new("/app-data/Uniopc/state-v8/uniopc-2026_8_1/account-a");
        let old = Path::new(
            "/app-data/Uniopc/state-v8/Uniopc-2026_8_1/account-a/media/uniopc-montage/clip.mp4",
        );

        assert_eq!(
            legacy_media_path_for_active_state(old, state_root, active_state),
            Some(active_state.join("media/uniopc-montage/clip.mp4"))
        );
        let openclaw = Path::new(
            "/app-data/Uniopc/state-v8/openclaw-2026_8_1/account-a/media/uniopc-superip/clip.mp4",
        );
        assert_eq!(
            legacy_media_path_for_active_state(openclaw, state_root, active_state),
            Some(active_state.join("media/uniopc-superip/clip.mp4"))
        );
        assert_eq!(
            legacy_media_path_for_active_state(
                Path::new("/tmp/Uniopc-2026_8_1/account-a/media/clip.mp4"),
                state_root,
                active_state,
            ),
            None
        );
        assert_eq!(
            legacy_media_path_for_active_state(
                Path::new("/app-data/Uniopc/state-v8/other/account-a/media/clip.mp4"),
                state_root,
                active_state,
            ),
            None
        );
    }
}
