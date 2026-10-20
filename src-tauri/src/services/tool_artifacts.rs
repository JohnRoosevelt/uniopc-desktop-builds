//! Extracts produced-file paths ("产物") out of gateway tool events.
//!
//! The chat stream never tells us what a turn produced: the model may or may not
//! mention the file it wrote, and the `MEDIA:` pseudo-token only ever covers
//! generated images/videos. The reliable signal is the tool call itself — `write`
//! carries `file_path`, `apply_patch` reports `A/M/D <path>` lines, `exec` carries
//! the shell command. This module turns those into a de-duplicated path list that
//! the UI can show in the 产物 panel.
//!
//! Deliberately conservative: only paths that look absolute AND end in a known
//! document/media extension survive, because a false positive shows up as a
//! broken card in the panel. Existence is NOT checked here (a `tool_started`
//! event fires before the file exists) — the UI stats the paths separately.

use serde_json::Value;

/// Extensions we are willing to call a 产物. Mirrors the set Accio uses so the
/// two products surface the same files; anything else (`.tmp`, `.lock`, sockets)
/// is noise the user never asked to see.
const ARTIFACT_EXTENSIONS: &[&str] = &[
    // images / video / audio
    "png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "mp4", "mov", "webm", "m4v", "mp3", "wav",
    "ogg", "m4a", // documents
    "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "tsv", "odt", "ods", "odp", "pdf", "rtf",
    "txt", "md", "markdown", "html", "htm", "tex", "epub", // data / bundles
    "json", "yaml", "yml", "zip", "tar", "gz", "7z", "rar",
];

/// Argument keys that hold "the file this tool is writing". Ordered loosely by
/// how common they are across OpenClaw's builtin tools and our plugins.
const PATH_ARG_KEYS: &[&str] = &[
    "file_path",
    "filePath",
    "path",
    "target_file",
    "target_file_path",
    "output_path",
    "outputPath",
    "output_file",
    "outputFile",
    "save_path",
    "savePath",
    "dest",
    "destination",
    "out",
    "output",
];

/// One produced file, as seen from a tool event.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifactPath {
    pub path: String,
    /// `created` | `modified` | `deleted` | `unknown` — drives the badge in the UI.
    pub operation: String,
    /// `declared` (the model presented this file via `uniopc_present_artifacts`)
    /// or `sniffed` (guessed from tool args / shell text). Declared entries are
    /// trusted verbatim; sniffed ones stay subject to the extension whitelist
    /// and the UI's existence check.
    pub origin: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// The declaration tool registered by the `uniopc-cloud-workspace` plugin. Its
/// whole purpose is to be seen here: the model calls it with the deliverables it
/// produced, and we record them as `declared` artifacts.
pub const PRESENT_ARTIFACTS_TOOL: &str = "uniopc_present_artifacts";
const DOCUMENT_CREATE_DOCX_TOOL: &str = "uniopc_documents_create_docx";
const PRESENTATIONS_CREATE_PPTX_TOOL: &str = "uniopc_presentations_create_pptx";
const MONTAGE_PRODUCE_VIDEO_TOOL: &str = "uniopc_montage_produce_video";

fn is_completed_video_tool(tool: &str) -> bool {
    tool == MONTAGE_PRODUCE_VIDEO_TOOL
        || matches!(
            tool,
            "uniopc_superip_produce_video"
                | "uniopc_superip_monologue_produce_video"
                | "uniopc_superip_dialogue_produce_video"
                | "uniopc_superip_presentation_produce_video"
        )
}

fn completed_video_title(tool: &str, job_id: &str) -> String {
    if tool == MONTAGE_PRODUCE_VIDEO_TOOL {
        format!("混剪成片 {job_id}")
    } else {
        format!("超级IP成片 {job_id}")
    }
}

/// Pulls every plausible produced-file path out of one tool event.
///
/// `args` is the raw (unsanitized-length) argument object from the gateway frame,
/// `result_text` the tool's textual result when it has already finished. Both are
/// optional because `tool_started` has args but no result and a plugin result may
/// arrive with neither.
pub fn extract_tool_artifact_paths(
    tool_name: &str,
    args: Option<&Value>,
    result_text: Option<&str>,
) -> Vec<ToolArtifactPath> {
    let tool = tool_name.trim().to_ascii_lowercase();

    // Declared path: the model itself says "these files are my deliverables".
    // Parsed exclusively — the generic key scan below would find nothing in the
    // nested `files` array anyway, and must not add noise next to a declaration.
    if tool == PRESENT_ARTIFACTS_TOOL {
        return extract_declared_artifacts(args);
    }

    // Video-production plugins return their finished MP4 in structured output,
    // rather than as a tool argument. Record it directly so playback never
    // depends on the model repeating a MEDIA token in prose.
    if is_completed_video_tool(&tool) {
        if let Some(artifact) = extract_completed_video_artifact(&tool, result_text) {
            return vec![artifact];
        }
    }

    // The desktop-owned DOCX creator returns its generated path only after the
    // write succeeds. Surface that result as a declared artifact so the
    // conversation card can open/reveal the actual Word file.
    if tool == DOCUMENT_CREATE_DOCX_TOOL {
        if let Some(artifact) = extract_completed_docx_artifact(result_text) {
            return vec![artifact];
        }
    }
    if tool == PRESENTATIONS_CREATE_PPTX_TOOL {
        if let Some(artifact) = extract_completed_pptx_artifact(result_text) {
            return vec![artifact];
        }
    }

    let mut found: Vec<ToolArtifactPath> = Vec::new();

    let default_operation = default_operation_for_tool(&tool);

    if let Some(args) = args.and_then(Value::as_object) {
        // 1. Named path arguments — the high-confidence source.
        for key in PATH_ARG_KEYS {
            if let Some(raw) = args.get(*key).and_then(Value::as_str) {
                push_candidate(&mut found, raw, default_operation);
            }
        }
        // 2. `exec`/`bash` write files as a side effect of a shell command, so the
        //    only trace is the command line itself. Scan it for path-looking
        //    tokens; the extension whitelist plus the later existence check keeps
        //    the false-positive rate low.
        if is_exec_tool(&tool) {
            if let Some(command) = args.get("command").and_then(command_as_text) {
                for token in scan_paths_in_text(&command) {
                    push_candidate(&mut found, &token, "unknown");
                }
            }
        }
    }

    // 3. `apply_patch` reports what it touched as `A|M|D <path>` lines.
    if let Some(text) = result_text {
        if tool == "apply_patch" {
            for (raw, operation) in parse_patch_summary_lines(text) {
                push_candidate(&mut found, raw, operation);
            }
        }
    }

    found
}

fn extract_completed_docx_artifact(result_text: Option<&str>) -> Option<ToolArtifactPath> {
    let result: Value = serde_json::from_str(result_text?).ok()?;
    let path = normalize_path_impl(result.get("path")?.as_str()?.trim(), true)?;
    if !path.to_ascii_lowercase().ends_with(".docx") {
        return None;
    }
    Some(ToolArtifactPath {
        path,
        operation: "created".to_string(),
        origin: "declared",
        title: result.get("title").and_then(Value::as_str).map(str::to_string),
        kind: Some("document".to_string()),
    })
}

fn extract_completed_pptx_artifact(result_text: Option<&str>) -> Option<ToolArtifactPath> {
    let result: Value = serde_json::from_str(result_text?).ok()?;
    let path = normalize_path_impl(result.get("path")?.as_str()?.trim(), true)?;
    if !path.to_ascii_lowercase().ends_with(".pptx") { return None; }
    Some(ToolArtifactPath { path, operation: "created".to_string(), origin: "declared", title: result.get("title").and_then(Value::as_str).map(str::to_string), kind: Some("slides".to_string()) })
}

fn extract_completed_video_artifact(tool: &str, result_text: Option<&str>) -> Option<ToolArtifactPath> {
    let result: Value = serde_json::from_str(result_text?).ok()?;
    if result.get("status").and_then(Value::as_str) != Some("completed") {
        return None;
    }
    let declared_path = result
        .get("mediaRef")
        .or_else(|| result.get("outputPath"))
        .and_then(Value::as_str)?
        .trim();
    let raw_path = declared_path.strip_prefix("MEDIA:").unwrap_or(declared_path);
    let path = normalize_path_impl(raw_path, true)?;
    if !matches!(path.rsplit('.').next()?.to_ascii_lowercase().as_str(), "mp4" | "mov" | "webm" | "m4v") {
        return None;
    }
    let job_id = result
        .get("jobId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty());
    Some(ToolArtifactPath {
        path,
        operation: "created".to_string(),
        origin: "declared",
        title: job_id.map(|id| completed_video_title(tool, id)),
        kind: Some("video".to_string()),
    })
}

/// Parses `uniopc_present_artifacts` args: `{files:[{path,title?,kind?},…]}`.
///
/// Declared paths skip the extension whitelist — the model explicitly said this
/// file is a deliverable, so an unusual extension is not grounds for dropping
/// it. The absolute-path requirement stays (a relative path is unresolvable),
/// and the UI existence check still guards against hallucinated paths.
fn extract_declared_artifacts(args: Option<&Value>) -> Vec<ToolArtifactPath> {
    let mut found: Vec<ToolArtifactPath> = Vec::new();
    let files = args
        .and_then(Value::as_object)
        .and_then(|map| map.get("files"))
        .and_then(Value::as_array);
    let Some(files) = files else {
        return found;
    };
    for entry in files {
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let Some(raw) = entry.get("path").and_then(Value::as_str) else {
            continue;
        };
        let Some(path) = normalize_path_impl(raw, false) else {
            continue;
        };
        if found.iter().any(|item| item.path == path) {
            continue;
        }
        let text_field = |key: &str| {
            entry
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        found.push(ToolArtifactPath {
            path,
            operation: "created".to_string(),
            origin: "declared",
            title: text_field("title"),
            kind: text_field("kind"),
        });
    }
    found
}

fn is_exec_tool(tool: &str) -> bool {
    matches!(tool, "exec" | "bash" | "shell" | "run")
}

fn default_operation_for_tool(tool: &str) -> &'static str {
    match tool {
        "write" | "create_file" | "apply_patch" => "created",
        "edit" | "multi_edit" | "str_replace" | "update_file" => "modified",
        _ => "unknown",
    }
}

/// `command` is a string for most shells but some tools pass `["bash","-lc",…]`.
fn command_as_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let joined = parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ");
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

fn push_candidate(found: &mut Vec<ToolArtifactPath>, raw: &str, operation: &str) {
    let Some(path) = normalize_artifact_path(raw) else {
        return;
    };
    if let Some(existing) = found.iter_mut().find(|item| item.path == path) {
        // A later, more specific operation wins over the `unknown` placeholder.
        if existing.operation == "unknown" && operation != "unknown" {
            existing.operation = operation.to_string();
        }
        return;
    }
    found.push(ToolArtifactPath {
        path,
        operation: operation.to_string(),
        origin: "sniffed",
        title: None,
        kind: None,
    });
}

/// Normalizes a raw path and rejects anything we would not want to show.
///
/// Accepts `/abs`, `~/rel`, `$HOME/rel` and Windows `C:\…`; rejects relative
/// paths because we cannot resolve them without knowing the tool's cwd, and a
/// wrong absolute guess is worse than omitting the artifact.
pub fn normalize_artifact_path(raw: &str) -> Option<String> {
    normalize_path_impl(raw, true)
}

fn normalize_path_impl(raw: &str, require_known_extension: bool) -> Option<String> {
    let trimmed = raw
        .trim()
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`' | '(' | ')' | '<' | '>' | ',' | ';'))
        .trim();
    if trimmed.is_empty() || trimmed.len() > 1024 {
        return None;
    }
    if require_known_extension && !has_artifact_extension(trimmed) {
        return None;
    }

    let expanded = if let Some(rest) = trimmed.strip_prefix("$HOME/") {
        format!("{}/{rest}", home_dir()?)
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        format!("{}/{rest}", home_dir()?)
    } else {
        trimmed.to_string()
    };

    let is_absolute = expanded.starts_with('/') || is_windows_absolute(&expanded);
    is_absolute.then_some(expanded)
}

fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
}

fn is_windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\')
}

fn has_artifact_extension(value: &str) -> bool {
    // Strip a URL-ish query/fragment tail before looking at the extension.
    let head = value.split(['?', '#']).next().unwrap_or(value);
    let name = head.rsplit(['/', '\\']).next().unwrap_or(head);
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if stem.is_empty() {
        return false;
    }
    let ext = ext.trim().to_ascii_lowercase();
    ARTIFACT_EXTENSIONS.iter().any(|known| *known == ext)
}

/// Splits free-form shell text into path-looking tokens.
///
/// Shell quoting means a path with spaces can only be recovered when it is
/// quoted, so we handle quoted runs first and fall back to whitespace splitting.
fn scan_paths_in_text(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    let flush = |current: &mut String, tokens: &mut Vec<String>| {
        if !current.is_empty() {
            tokens.push(std::mem::take(current));
        }
    };

    for ch in text.chars() {
        match quote {
            Some(open) if ch == open => {
                quote = None;
                flush(&mut current, &mut tokens);
            }
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => {
                flush(&mut current, &mut tokens);
                quote = Some(ch);
            }
            None if ch.is_whitespace() => flush(&mut current, &mut tokens),
            None => current.push(ch),
        }
    }
    flush(&mut current, &mut tokens);

    tokens
        .into_iter()
        .filter(|token| token.contains('/') || is_windows_absolute(token))
        .filter(|token| has_artifact_extension(token))
        .collect()
}

/// Parses `apply_patch`'s `A path`, `M path`, `D path` summary lines.
fn parse_patch_summary_lines(text: &str) -> Vec<(&str, &'static str)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (marker, rest) = line.split_at(line.char_indices().nth(1)?.0);
            let operation = match marker {
                "A" => "created",
                "M" => "modified",
                "D" => "deleted",
                _ => return None,
            };
            let path = rest.trim();
            (!path.is_empty()).then_some((path, operation))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_write_tool_file_path_as_created() {
        let args = json!({ "file_path": "/Users/demo/Desktop/deck.pptx", "content": "…" });
        let found = extract_tool_artifact_paths("write", Some(&args), None);
        assert_eq!(
            found,
            vec![ToolArtifactPath {
                path: "/Users/demo/Desktop/deck.pptx".to_string(),
                operation: "created".to_string(),
                origin: "sniffed",
                title: None,
                kind: None,
            }]
        );
    }

    #[test]
    fn present_artifacts_args_become_declared_entries() {
        let args = json!({
            "files": [
                { "path": "/tmp/weekly.docx", "title": "周报", "kind": "document" },
                { "path": "/tmp/weekly.docx", "title": "duplicate is dropped" },
                { "path": "/tmp/model.unusualext" },
                { "path": "relative/skipped.md" },
            ],
            "summary": "本周交付"
        });
        let found = extract_tool_artifact_paths("uniopc_present_artifacts", Some(&args), None);
        assert_eq!(
            found,
            vec![
                ToolArtifactPath {
                    path: "/tmp/weekly.docx".to_string(),
                    operation: "created".to_string(),
                    origin: "declared",
                    title: Some("周报".to_string()),
                    kind: Some("document".to_string()),
                },
                // Declared paths skip the extension whitelist on purpose.
                ToolArtifactPath {
                    path: "/tmp/model.unusualext".to_string(),
                    operation: "created".to_string(),
                    origin: "declared",
                    title: None,
                    kind: None,
                },
            ]
        );
    }

    #[test]
    fn present_artifacts_without_files_yields_nothing() {
        let args = json!({ "summary": "no files key" });
        assert!(extract_tool_artifact_paths("uniopc_present_artifacts", Some(&args), None).is_empty());
        assert!(extract_tool_artifact_paths("uniopc_present_artifacts", None, None).is_empty());
    }

    #[test]
    fn montage_completed_result_declares_a_renderable_video() {
        let result = r#"{"status":"completed","jobId":"montage-42","mediaRef":"MEDIA:/tmp/montage-42.mp4"}"#;
        let found = extract_tool_artifact_paths(MONTAGE_PRODUCE_VIDEO_TOOL, None, Some(result));
        assert_eq!(found, vec![ToolArtifactPath {
            path: "/tmp/montage-42.mp4".to_string(),
            operation: "created".to_string(),
            origin: "declared",
            title: Some("混剪成片 montage-42".to_string()),
            kind: Some("video".to_string()),
        }]);
    }

    #[test]
    fn docx_creator_result_declares_a_clickable_document_artifact() {
        let result = r#"{"path":"/tmp/acceptance.docx","title":"验收文档","kind":"document"}"#;
        let found = extract_tool_artifact_paths(DOCUMENT_CREATE_DOCX_TOOL, None, Some(result));
        assert_eq!(found, vec![ToolArtifactPath {
            path: "/tmp/acceptance.docx".to_string(),
            operation: "created".to_string(),
            origin: "declared",
            title: Some("验收文档".to_string()),
            kind: Some("document".to_string()),
        }]);
    }

    #[test]
    fn montage_incomplete_or_non_video_result_is_not_an_artifact() {
        assert!(extract_tool_artifact_paths(MONTAGE_PRODUCE_VIDEO_TOOL, None, Some(r#"{"status":"running","outputPath":"/tmp/video.mp4"}"#)).is_empty());
        assert!(extract_tool_artifact_paths(MONTAGE_PRODUCE_VIDEO_TOOL, None, Some(r#"{"status":"completed","outputPath":"/tmp/notes.txt"}"#)).is_empty());
    }

    #[test]
    fn superip_completed_result_declares_a_renderable_video() {
        let result = r#"{"status":"completed","jobId":"superip-42","mediaRef":"MEDIA:/tmp/superip-42.mp4"}"#;
        let found = extract_tool_artifact_paths("uniopc_superip_produce_video", None, Some(result));
        assert_eq!(found, vec![ToolArtifactPath {
            path: "/tmp/superip-42.mp4".to_string(),
            operation: "created".to_string(),
            origin: "declared",
            title: Some("超级IP成片 superip-42".to_string()),
            kind: Some("video".to_string()),
        }]);
    }

    #[test]
    fn sniffed_entries_are_marked_sniffed() {
        let args = json!({ "path": "/tmp/report.md" });
        let found = extract_tool_artifact_paths("edit", Some(&args), None);
        assert_eq!(found[0].origin, "sniffed");
        assert_eq!(found[0].title, None);
    }

    #[test]
    fn edit_tool_reports_modified() {
        let args = json!({ "path": "/tmp/report.md" });
        let found = extract_tool_artifact_paths("edit", Some(&args), None);
        assert_eq!(found[0].operation, "modified");
    }

    #[test]
    fn exec_command_yields_quoted_and_plain_paths() {
        let args = json!({
            "command": "python3 build.py && cp out.pptx \"/Users/demo/My Files/人vsAI.pptx\""
        });
        let found = extract_tool_artifact_paths("exec", Some(&args), None);
        let paths: Vec<&str> = found.iter().map(|item| item.path.as_str()).collect();
        // `build.py` has no artifact extension and `out.pptx` is relative — only
        // the quoted absolute path survives.
        assert_eq!(paths, vec!["/Users/demo/My Files/人vsAI.pptx"]);
    }

    #[test]
    fn exec_command_accepts_array_form() {
        let args = json!({ "command": ["bash", "-lc", "cat /srv/out/report.pdf"] });
        let found = extract_tool_artifact_paths("bash", Some(&args), None);
        assert_eq!(found[0].path, "/srv/out/report.pdf");
    }

    #[test]
    fn apply_patch_summary_lines_map_to_operations() {
        let result = "A /repo/new.md\nM /repo/old.md\nD /repo/gone.md\nnoise";
        let found = extract_tool_artifact_paths("apply_patch", None, Some(result));
        let pairs: Vec<(&str, &str)> = found
            .iter()
            .map(|item| (item.path.as_str(), item.operation.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("/repo/new.md", "created"),
                ("/repo/old.md", "modified"),
                ("/repo/gone.md", "deleted"),
            ]
        );
    }

    #[test]
    fn relative_and_unknown_extension_paths_are_rejected() {
        assert_eq!(normalize_artifact_path("out/deck.pptx"), None);
        assert_eq!(normalize_artifact_path("/tmp/session.sock"), None);
        assert_eq!(normalize_artifact_path("/tmp/.pptx"), None);
        assert_eq!(
            normalize_artifact_path("/tmp/a.PPTX").as_deref(),
            Some("/tmp/a.PPTX")
        );
    }

    #[test]
    fn home_shorthand_is_expanded() {
        let home = std::env::var("HOME").expect("test environment has HOME");
        assert_eq!(
            normalize_artifact_path("$HOME/Desktop/x.pdf").as_deref(),
            Some(format!("{home}/Desktop/x.pdf").as_str())
        );
        assert_eq!(
            normalize_artifact_path("~/Desktop/y.pdf").as_deref(),
            Some(format!("{home}/Desktop/y.pdf").as_str())
        );
    }

    #[test]
    fn duplicate_paths_keep_the_most_specific_operation() {
        let args = json!({ "file_path": "/tmp/x.md", "path": "/tmp/x.md" });
        let found = extract_tool_artifact_paths("write", Some(&args), None);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].operation, "created");
    }
}
