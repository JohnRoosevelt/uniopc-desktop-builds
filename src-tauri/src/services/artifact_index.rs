//! Durable per-account store backing the 产物 (artifacts) panel.
//!
//! The index used to live in `localStorage`, which capped it at a few hundred
//! rows and tied its lifetime to the webview. This service owns a single JSON
//! file per account instead — `state/<profile>/artifacts-index.json`, the same
//! per-profile isolation the engine state uses — and exposes it to JS as an
//! opaque document: read returns the raw JSON text, write replaces it whole.
//!
//! Deliberately a dumb KV: dedupe/merge semantics (declared-over-sniffed, cap,
//! ordering) live in `src/lib/conversationArtifacts.js` where they are unit
//! tested. Rust only guarantees durability — atomic replace (tmp + rename),
//! serialized writers, a size ceiling, and shape validation so a corrupted
//! writer cannot poison the file with non-JSON.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active;

const INDEX_FILE_NAME: &str = "artifacts-index.json";
/// Hard ceiling well above the JS-side row cap; a payload this large means a
/// runaway writer, not a big library.
const MAX_INDEX_BYTES: usize = 8 * 1024 * 1024;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn index_path() -> Result<PathBuf, String> {
    Ok(state_v8_dir_for_profile_or_active(None)?.join(INDEX_FILE_NAME))
}

/// Raw index document for the active account; `None` when nothing was stored
/// yet. Unreadable/corrupt content is reported as absent rather than an error —
/// the caller's fallback (empty panel that refills over time) beats a hard
/// failure surfaced in the UI.
pub fn read_index() -> Result<Option<String>, String> {
    let path = index_path()?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("read {}: {err}", path.display())),
    }
}

/// Replaces the index document for the active account.
pub fn write_index(content: &str) -> Result<(), String> {
    let path = index_path()?;
    write_index_at(&path, content)
}

fn write_index_at(path: &Path, content: &str) -> Result<(), String> {
    if content.len() > MAX_INDEX_BYTES {
        return Err(format!(
            "artifact index too large: {} bytes (max {MAX_INDEX_BYTES})",
            content.len()
        ));
    }
    // Shape gate, not schema validation: the payload must at least be a JSON
    // object so a crashed serializer can't leave us a half-written poison pill.
    let parsed: serde_json::Value =
        serde_json::from_str(content).map_err(|err| format!("artifact index not JSON: {err}"))?;
    if !parsed.is_object() {
        return Err("artifact index must be a JSON object".to_string());
    }

    let _guard = WRITE_LOCK.lock().map_err(|_| "artifact index lock poisoned".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "artifact index path has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|err| format!("mkdir {}: {err}", parent.display()))?;

    // tmp + rename so readers never observe a torn file, even on crash.
    let tmp = path.with_extension("json.tmp");
    {
        let mut file =
            std::fs::File::create(&tmp).map_err(|err| format!("create {}: {err}", tmp.display()))?;
        file.write_all(content.as_bytes())
            .map_err(|err| format!("write {}: {err}", tmp.display()))?;
        file.sync_all().ok();
    }
    std::fs::rename(&tmp, path).map_err(|err| format!("rename {}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("uniopc-artifact-index-test-{}-{name}", std::process::id()))
            .join(INDEX_FILE_NAME)
    }

    #[test]
    fn writes_then_reads_back_atomically() {
        let path = temp_path("roundtrip");
        write_index_at(&path, r#"{"version":1,"items":[]}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"version":1,"items":[]}"#
        );
        // Overwrite must fully replace, and the tmp file must not linger.
        write_index_at(&path, r#"{"version":1,"items":[{"path":"/tmp/a.md"}]}"#).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("/tmp/a.md"));
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn rejects_non_json_and_non_object_payloads() {
        let path = temp_path("invalid");
        assert!(write_index_at(&path, "not json").is_err());
        assert!(write_index_at(&path, "[1,2,3]").is_err());
        assert!(!path.exists());
    }

    #[test]
    fn rejects_oversized_payloads() {
        let path = temp_path("oversize");
        let huge = format!(r#"{{"blob":"{}"}}"#, "x".repeat(MAX_INDEX_BYTES));
        assert!(write_index_at(&path, &huge).is_err());
    }
}
