//! Authenticated loopback bridge for the local Uniopc Engine document tools.
//!
//! The bridge exposes one fixed operation endpoint. It never exposes the
//! SQLCipher key, database path, filesystem, SQL, or a generic proxy surface.

use std::{
    collections::{HashMap, HashSet},
    io::Write,
    sync::{Arc, Mutex, OnceLock, RwLock},
    time::{Duration, Instant},
};

use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, Method, StatusCode},
    response::Response,
    routing::post,
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Listener};

use crate::services::local_documents::{
    LocalDocumentCreate, LocalDocumentError, LocalDocumentStore, LocalDocumentSummary,
    LocalDocumentUpdate,
};

const OPERATION_PATH: &str = "/v1/documents/operation";
const MAX_REQUEST_BODY_BYTES: usize = 17 * 1024 * 1024;
const TURN_GRANT_TTL: Duration = Duration::from_secs(30 * 60);

static PRODUCTION_STATE: OnceLock<LocalDocumentsBridgeState> = OnceLock::new();
static BRIDGE_PORT: Mutex<Option<u16>> = Mutex::new(None);
static START_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static TERMINAL_LISTENER_INSTALLED: OnceLock<()> = OnceLock::new();

#[derive(Clone)]
pub struct LocalDocumentsBridgeState {
    token: Arc<String>,
    turn_grants: Arc<RwLock<HashMap<String, TurnGrant>>>,
}

struct TurnGrant {
    document_ids: HashSet<String>,
    allow_workspace_documents: bool,
    allow_document_generation: bool,
    run_id: Option<String>,
    expires_at: Instant,
}

impl LocalDocumentsBridgeState {
    fn new(token: String) -> Self {
        Self {
            token: Arc::new(token),
            turn_grants: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    fn replace_turn_grants<I, S>(&self, session_key: &str, document_ids: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.replace_turn_document_access(session_key, document_ids, false, false);
    }

    // A direct `/` invocation of the built-in local-workspace plugin is the
    // user's explicit consent to use that capability for this turn. It is
    // still constrained to this desktop profile, session, run and TTL.
    fn replace_turn_workspace_grant<I, S>(&self, session_key: &str, document_ids: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.replace_turn_document_access(session_key, document_ids, true, false);
    }

    fn replace_turn_document_generation_grant(&self, session_key: &str) {
        self.replace_turn_document_access(session_key, std::iter::empty::<&str>(), false, true);
    }

    fn replace_turn_document_access<I, S>(
        &self,
        session_key: &str,
        document_ids: I,
        allow_workspace_documents: bool,
        allow_document_generation: bool,
    ) where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let session_key = session_key.trim();
        if session_key.is_empty() {
            return;
        }
        let grants = document_ids
            .into_iter()
            .filter_map(|id| {
                let id = id.as_ref().trim();
                (!id.is_empty()).then(|| id.to_string())
            })
            .collect::<HashSet<_>>();
        if let Ok(mut turn_grants) = self.turn_grants.write() {
            turn_grants.insert(
                session_key.to_string(),
                TurnGrant {
                    document_ids: grants,
                    allow_workspace_documents,
                    allow_document_generation,
                    run_id: None,
                    expires_at: Instant::now() + TURN_GRANT_TTL,
                },
            );
        }
    }

    fn is_document_generation_granted(&self, session_key: &str) -> bool {
        let Ok(mut turn_grants) = self.turn_grants.write() else {
            return false;
        };
        let session_key = session_key.trim();
        if turn_grants
            .get(session_key)
            .is_some_and(|grant| Instant::now() >= grant.expires_at)
        {
            turn_grants.remove(session_key);
            return false;
        }
        turn_grants
            .get(session_key)
            .is_some_and(|grant| grant.allow_document_generation)
    }

    fn is_document_granted(&self, session_key: &str, document_id: &str) -> bool {
        let Ok(mut turn_grants) = self.turn_grants.write() else {
            return false;
        };
        let session_key = session_key.trim();
        if turn_grants
            .get(session_key)
            .is_some_and(|grant| Instant::now() >= grant.expires_at)
        {
            turn_grants.remove(session_key);
            return false;
        }
        turn_grants.get(session_key).is_some_and(|grant| {
            grant.allow_workspace_documents || grant.document_ids.contains(document_id.trim())
        })
    }

    fn bind_turn_run(&self, session_key: &str, run_id: &str) {
        let Ok(mut turn_grants) = self.turn_grants.write() else {
            return;
        };
        if let Some(grant) = turn_grants.get_mut(session_key.trim()) {
            grant.run_id = Some(run_id.trim().to_string());
        }
    }

    fn clear_terminal_turn(&self, session_key: &str, run_id: Option<&str>) {
        let Ok(mut turn_grants) = self.turn_grants.write() else {
            return;
        };
        let session_key = session_key.trim();
        let should_clear = turn_grants.get(session_key).is_some_and(|grant| {
            match (grant.run_id.as_deref(), run_id.map(str::trim)) {
                (Some(expected), Some(actual)) => expected == actual,
                // A terminal frame can race the chat.send acknowledgement. In
                // that case clearing an unbound grant is the fail-closed choice.
                (None, _) => true,
                _ => false,
            }
        });
        if should_clear {
            turn_grants.remove(session_key);
        }
    }
}

fn production_state() -> &'static LocalDocumentsBridgeState {
    PRODUCTION_STATE
        .get_or_init(|| LocalDocumentsBridgeState::new(uuid::Uuid::new_v4().to_string()))
}

pub fn managed_state() -> LocalDocumentsBridgeState {
    production_state().clone()
}

/// Replace the document ids authorized for a session's current turn.
///
/// Replacing rather than accumulating grants ensures a later turn without a
/// document mention cannot reuse an earlier turn's document access.
pub fn record_turn_document_grants<I, S>(session_key: &str, document_ids: I)
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    production_state().replace_turn_grants(session_key, document_ids);
}

/// Authorize the built-in local-workspace plugin to access this profile's
/// documents for the current user-requested runtime turn only.
pub fn record_turn_workspace_document_grant<I, S>(session_key: &str, document_ids: I)
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    production_state().replace_turn_workspace_grant(session_key, document_ids);
}

/// A direct `/plugin:uniopc-documents` invocation grants creation of one or
/// more generated DOCX artifacts for this session/run only.
pub fn record_turn_document_generation_grant(session_key: &str) {
    production_state().replace_turn_document_generation_grant(session_key);
}

/// Clear a turn grant when the corresponding gateway send was not accepted.
pub fn clear_turn_document_grants(session_key: &str) {
    production_state().replace_turn_grants(session_key, std::iter::empty::<&str>());
}

pub fn bind_turn_document_grants_to_run(session_key: &str, run_id: &str) {
    production_state().bind_turn_run(session_key, run_id);
}

fn bridge_port() -> Option<u16> {
    BRIDGE_PORT.lock().ok().and_then(|port| *port)
}

fn set_bridge_port(port: u16) -> Result<(), String> {
    let mut current = BRIDGE_PORT
        .lock()
        .map_err(|_| "local document bridge port lock poisoned".to_string())?;
    *current = Some(port);
    Ok(())
}

#[cfg(test)]
pub(crate) fn configure_test_endpoint(port: u16) {
    set_bridge_port(port).expect("configure local document bridge test endpoint");
}

fn environment_for_endpoint(endpoint: &str, token: &str) -> Vec<(String, String)> {
    vec![
        (
            "UNIOPC_LOCAL_DOCUMENTS_URL".to_string(),
            endpoint.to_string(),
        ),
        (
            "UNIOPC_LOCAL_DOCUMENTS_TOKEN".to_string(),
            token.to_string(),
        ),
    ]
}

/// The only document-bridge values inherited by a locally spawned Engine.
/// Empty until the loopback listener has successfully bound.
pub fn bridge_environment() -> Vec<(String, String)> {
    let Some(port) = bridge_port() else {
        return Vec::new();
    };
    environment_for_endpoint(
        &format!("http://127.0.0.1:{port}{OPERATION_PATH}"),
        production_state().token.as_str(),
    )
}

#[derive(Debug)]
enum BridgeOperation {
    CreateDocx {
        title: String,
        markdown: String,
    },
    List {
        category: Option<String>,
    },
    Create {
        title: String,
        category: String,
        markdown: String,
        metadata: Value,
    },
    Get {
        id: String,
    },
    Update {
        id: String,
        title: String,
        category: String,
        markdown: String,
        metadata: Value,
        base_hash: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeEnvelope {
    action: String,
    payload: Value,
    agent: BridgeAgentContext,
    session: BridgeSessionContext,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeAgentContext {
    openclaw_profile: String,
    #[serde(default)]
    openclaw_agent_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BridgeSessionContext {
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListPayload {
    #[serde(default)]
    category: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetPayload {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatePayload {
    title: String,
    category: String,
    #[serde(default)]
    markdown: String,
    #[serde(default)]
    markdown_projection: String,
    #[serde(default)]
    blocksuite_body: String,
    #[serde(default)]
    metadata: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdatePayload {
    id: String,
    title: String,
    category: String,
    #[serde(default)]
    markdown: String,
    #[serde(default)]
    markdown_projection: String,
    #[serde(default)]
    blocksuite_body: String,
    #[serde(default)]
    metadata: Value,
    base_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateDocxPayload {
    title: String,
    markdown: String,
}

fn bridge_markdown(
    markdown: String,
    markdown_projection: String,
    blocksuite_body: String,
) -> Result<String, ()> {
    let markdown = markdown.trim();
    if !markdown.is_empty() {
        return Ok(markdown.to_string());
    }

    // 0.1.0 exposed a non-standard `blocksuiteBody` tool schema, but it also
    // required a Markdown projection. Prefer that projection rather than
    // accepting invented BlockSuite JSON. The frontend imports this Markdown
    // through BlockSuite's official MarkdownAdapter before editing.
    let projection = markdown_projection.trim();
    if !projection.is_empty() {
        return Ok(projection.to_string());
    }

    // A few old clients supplied plain Markdown in the wrong field. Preserve
    // that recoverable input, but never persist a JSON pseudo-snapshot as the
    // document body.
    let legacy_body = blocksuite_body.trim();
    if !legacy_body.is_empty() && !legacy_body.starts_with('{') && !legacy_body.starts_with('[') {
        return Ok(legacy_body.to_string());
    }
    Err(())
}

#[derive(Debug)]
struct ParsedBridgeRequest {
    operation: BridgeOperation,
    profile: String,
    session_key: String,
}

fn parse_bridge_request(body: &[u8]) -> Result<ParsedBridgeRequest, ()> {
    let envelope = serde_json::from_slice::<BridgeEnvelope>(body).map_err(|_| ())?;
    let profile = envelope.agent.openclaw_profile.trim();
    let session_key = envelope.session.key.trim();
    if profile.is_empty() || session_key.is_empty() {
        return Err(());
    }
    // Agent context is retained in the standard envelope for audit parity with
    // official plugins. It is deliberately not an authorization substitute.
    let _audit_agent_id = envelope.agent.openclaw_agent_id.trim();
    let operation = match envelope.action.as_str() {
        "uniopc_documents_create_docx" => {
            let payload =
                serde_json::from_value::<CreateDocxPayload>(envelope.payload).map_err(|_| ())?;
            BridgeOperation::CreateDocx {
                title: payload.title,
                markdown: payload.markdown,
            }
        }
        "uniopc_local_documents_list" => {
            let payload =
                serde_json::from_value::<ListPayload>(envelope.payload).map_err(|_| ())?;
            BridgeOperation::List {
                category: payload.category,
            }
        }
        "uniopc_local_document_get" => {
            let payload = serde_json::from_value::<GetPayload>(envelope.payload).map_err(|_| ())?;
            BridgeOperation::Get { id: payload.id }
        }
        "uniopc_local_document_create" => {
            let payload =
                serde_json::from_value::<CreatePayload>(envelope.payload).map_err(|_| ())?;
            BridgeOperation::Create {
                title: payload.title,
                category: payload.category,
                markdown: bridge_markdown(
                    payload.markdown,
                    payload.markdown_projection,
                    payload.blocksuite_body,
                )?,
                metadata: payload.metadata,
            }
        }
        "uniopc_local_document_update" => {
            let payload =
                serde_json::from_value::<UpdatePayload>(envelope.payload).map_err(|_| ())?;
            BridgeOperation::Update {
                id: payload.id,
                title: payload.title,
                category: payload.category,
                markdown: bridge_markdown(
                    payload.markdown,
                    payload.markdown_projection,
                    payload.blocksuite_body,
                )?,
                metadata: payload.metadata,
                base_hash: payload.base_hash,
            }
        }
        _ => return Err(()),
    };
    Ok(ParsedBridgeRequest {
        operation,
        // The gateway child is profile-scoped. Preserve that profile through
        // execution so a profile switch cannot redirect this request to the
        // desktop's subsequently active account.
        profile: profile.to_string(),
        session_key: session_key.to_string(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeDocumentMetadata {
    id: String,
    title: String,
    category: String,
    content_hash: String,
    status: String,
    version: i64,
    created_at: String,
    updated_at: String,
}

fn metadata_from_summary(summary: LocalDocumentSummary) -> BridgeDocumentMetadata {
    BridgeDocumentMetadata {
        id: summary.id,
        title: summary.title,
        category: summary.category,
        content_hash: summary.content_hash,
        status: summary.status,
        version: summary.version,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
    }
}

fn token_is_valid(request: &Request, expected: &str) -> bool {
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .map(|provided| provided.as_bytes().ct_eq(expected.as_bytes()).into())
        .unwrap_or(false)
}

fn json_response(status: StatusCode, value: Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .expect("build local document bridge response")
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    json_response(
        status,
        json!({ "error": { "code": code, "message": message } }),
    )
}

fn document_error_response(error: LocalDocumentError) -> Response {
    match error {
        LocalDocumentError::DocumentConflict(conflict) => json_response(
            StatusCode::CONFLICT,
            json!({
                "error": {
                    "code": "document_conflict",
                    "message": "The document changed since it was opened.",
                    "details": conflict,
                }
            }),
        ),
        LocalDocumentError::InvalidInput(message) => {
            error_response(StatusCode::BAD_REQUEST, "invalid_input", &message)
        }
        LocalDocumentError::NotFound => error_response(
            StatusCode::NOT_FOUND,
            "document_not_found",
            "The document was not found.",
        ),
        // Do not expose database paths, SQL errors, keyring identifiers, or
        // other storage diagnostics to the Engine/plugin boundary.
        LocalDocumentError::Storage(_) => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "local_documents_unavailable",
            "Local documents are unavailable.",
        ),
    }
}

fn markdown_document_metadata(metadata: Value) -> Value {
    let mut metadata = metadata.as_object().cloned().unwrap_or_default();
    metadata.insert(
        "body_format".to_string(),
        Value::String("markdown".to_string()),
    );
    Value::Object(metadata)
}

const MAX_DOCX_MARKDOWN_BYTES: usize = 2 * 1024 * 1024;

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn safe_document_stem(title: &str) -> String {
    let stem: String = title
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | ' ')
                || ('\u{4e00}'..='\u{9fff}').contains(&character)
            {
                character
            } else {
                '_'
            }
        })
        .collect();
    let stem = stem.trim().trim_matches('.');
    if stem.is_empty() {
        "document".to_string()
    } else {
        stem.chars().take(80).collect()
    }
}

fn push_docx_paragraph(body: &mut String, text: &str, style: Option<&str>) {
    let style = style
        .map(|name| format!("<w:pPr><w:pStyle w:val=\"{name}\"/></w:pPr>"))
        .unwrap_or_default();
    let escaped = xml_escape(text);
    let preserve = if text.starts_with(' ') || text.ends_with(' ') {
        " xml:space=\"preserve\""
    } else {
        ""
    };
    body.push_str(&format!(
        "<w:p>{style}<w:r><w:t{preserve}>{escaped}</w:t></w:r></w:p>"
    ));
}

fn docx_document_xml(title: &str, markdown: &str) -> String {
    let mut body = String::new();
    push_docx_paragraph(&mut body, title, Some("Title"));
    for line in markdown.lines() {
        let text = line.trim_end();
        if text.is_empty() {
            body.push_str("<w:p/>");
        } else if let Some(heading) = text.strip_prefix("# ") {
            push_docx_paragraph(&mut body, heading, Some("Heading1"));
        } else if let Some(heading) = text.strip_prefix("## ") {
            push_docx_paragraph(&mut body, heading, Some("Heading2"));
        } else if let Some(item) = text.strip_prefix("- ").or_else(|| text.strip_prefix("* ")) {
            push_docx_paragraph(&mut body, &format!("• {item}"), None);
        } else {
            push_docx_paragraph(&mut body, text, None);
        }
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>"#
    )
}

fn create_docx_artifact(profile: &str, title: &str, markdown: &str) -> Result<String, String> {
    if title.trim().is_empty() || markdown.len() > MAX_DOCX_MARKDOWN_BYTES {
        return Err("invalid_input".to_string());
    }
    let directory =
        crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(Some(profile))?
            .join("artifacts")
            .join("documents");
    std::fs::create_dir_all(&directory).map_err(|_| "local_documents_unavailable".to_string())?;
    let path = directory.join(format!(
        "{}-{}.docx",
        safe_document_stem(title),
        uuid::Uuid::new_v4()
    ));
    let file =
        std::fs::File::create(&path).map_err(|_| "local_documents_unavailable".to_string())?;
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    let write_part = |archive: &mut zip::ZipWriter<std::fs::File>,
                      name: &str,
                      content: String|
     -> Result<(), String> {
        archive
            .start_file(name, options)
            .map_err(|_| "local_documents_unavailable".to_string())?;
        archive
            .write_all(content.as_bytes())
            .map_err(|_| "local_documents_unavailable".to_string())
    };
    write_part(&mut archive, "[Content_Types].xml", r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>"#.to_string())?;
    write_part(&mut archive, "_rels/.rels", r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#.to_string())?;
    write_part(
        &mut archive,
        "word/document.xml",
        docx_document_xml(title, markdown),
    )?;
    write_part(&mut archive, "word/styles.xml", r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style></w:styles>"#.to_string())?;
    archive
        .finish()
        .map_err(|_| "local_documents_unavailable".to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn execute_operation(state: &LocalDocumentsBridgeState, request: ParsedBridgeRequest) -> Response {
    let session_key = request.session_key;
    let profile = request.profile;
    match request.operation {
        BridgeOperation::CreateDocx { title, markdown } => {
            if !state.is_document_generation_granted(&session_key) {
                return error_response(
                    StatusCode::FORBIDDEN,
                    "document_generation_not_granted",
                    "This document generation was not authorized for the current turn.",
                );
            }
            match create_docx_artifact(&profile, &title, &markdown) {
                Ok(path) => json_response(
                    StatusCode::OK,
                    json!({ "path": path, "title": title, "kind": "document" }),
                ),
                Err(_) => error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "local_documents_unavailable",
                    "Document generation is unavailable.",
                ),
            }
        }
        BridgeOperation::List { category } => {
            let result = LocalDocumentStore::new(Some(&profile))
                .and_then(|store| store.list(category.as_deref()))
                .map(|documents| {
                    documents
                        .into_iter()
                        .map(metadata_from_summary)
                        .collect::<Vec<_>>()
                });
            match result {
                Ok(documents) => json_response(StatusCode::OK, json!({ "documents": documents })),
                Err(error) => document_error_response(error),
            }
        }
        BridgeOperation::Create {
            title,
            category,
            markdown,
            metadata,
        } => {
            let result = LocalDocumentStore::new(Some(&profile)).and_then(|store| {
                store.create(LocalDocumentCreate {
                    title,
                    category,
                    blocksuite_body: markdown.clone(),
                    markdown_projection: markdown,
                    metadata: markdown_document_metadata(metadata),
                })
            });
            match result {
                Ok(document) => json_response(StatusCode::OK, json!({ "document": document })),
                Err(error) => document_error_response(error),
            }
        }
        BridgeOperation::Get { id } => {
            if !state.is_document_granted(&session_key, &id) {
                return error_response(
                    StatusCode::FORBIDDEN,
                    "document_not_granted",
                    "This document was not authorized for the current turn.",
                );
            }
            match LocalDocumentStore::new(Some(&profile)).and_then(|store| store.get(&id)) {
                Ok(document) => json_response(StatusCode::OK, json!({ "document": document })),
                Err(error) => document_error_response(error),
            }
        }
        BridgeOperation::Update {
            id,
            title,
            category,
            markdown,
            metadata,
            base_hash,
        } => {
            if base_hash.trim().is_empty() {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "invalid_input",
                    "A current document hash is required.",
                );
            }
            if !state.is_document_granted(&session_key, &id) {
                return error_response(
                    StatusCode::FORBIDDEN,
                    "document_not_granted",
                    "This document was not authorized for the current turn.",
                );
            }
            let result = LocalDocumentStore::new(Some(&profile)).and_then(|store| {
                store.update(LocalDocumentUpdate {
                    id,
                    title,
                    category,
                    blocksuite_body: markdown.clone(),
                    markdown_projection: markdown,
                    metadata: markdown_document_metadata(metadata),
                    base_hash,
                })
            });
            match result {
                Ok(document) => json_response(StatusCode::OK, json!({ "document": document })),
                Err(error) => document_error_response(error),
            }
        }
    }
}

async fn bridge_handler(
    State(state): State<LocalDocumentsBridgeState>,
    request: Request,
) -> Response {
    if request.method() != Method::POST || request.uri().path() != OPERATION_PATH {
        return error_response(StatusCode::NOT_FOUND, "not_found", "Not found.");
    }
    if !token_is_valid(&request, state.token.as_str()) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid local document bridge token is required.",
        );
    }
    let body = match to_bytes(request.into_body(), MAX_REQUEST_BODY_BYTES).await {
        Ok(body) => body,
        Err(_) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "invalid_request",
                "The operation request is too large.",
            )
        }
    };
    let request = match parse_bridge_request(&body) {
        Ok(request) => request,
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "The document operation is invalid.",
            )
        }
    };
    let operation_state = state.clone();
    match tokio::task::spawn_blocking(move || execute_operation(&operation_state, request)).await {
        Ok(response) => response,
        Err(_) => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "local_documents_unavailable",
            "Local documents are unavailable.",
        ),
    }
}

/// Bind the document bridge to an ephemeral IPv4 loopback port and serve it in
/// the background. The token and turn grants remain in process memory only.
fn install_terminal_listener(app: &AppHandle) {
    if TERMINAL_LISTENER_INSTALLED.set(()).is_err() {
        return;
    }
    let state = production_state().clone();
    app.listen("conversation-gateway-event", move |event| {
        let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        let terminal = payload
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|value| matches!(value, "final" | "error" | "aborted"));
        if !terminal {
            return;
        }
        let Some(session_key) = payload.get("sessionKey").and_then(Value::as_str) else {
            return;
        };
        state.clear_terminal_turn(session_key, payload.get("runId").and_then(Value::as_str));
    });
}

pub async fn start(app: AppHandle) -> Result<(), String> {
    install_terminal_listener(&app);
    let _guard = START_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    if bridge_port().is_some() {
        return Ok(());
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("bind local document bridge: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("read local document bridge address: {error}"))?;
    if address.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) {
        return Err("local document bridge did not bind IPv4 loopback".to_string());
    }
    set_bridge_port(address.port())?;

    let router = Router::new()
        .route(OPERATION_PATH, post(bridge_handler))
        .with_state(production_state().clone());
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("[local-documents-bridge] server exited: {error}");
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use crate::services::local_documents::LocalDocumentSummary;
    use axum::{
        body::Body,
        extract::State,
        http::{header, Request, StatusCode},
    };

    #[test]
    fn generated_docx_is_a_valid_zip_with_the_requested_content() {
        let root = std::env::temp_dir().join(format!("uniopc-docx-test-{}", uuid::Uuid::new_v4()));
        std::env::set_var("UNIOPC_DATA_DIR", &root);
        let path = create_docx_artifact("docx-test", "测试文档", "# 标题\n\n- 第一项\n内容 & <确认>")
            .expect("create DOCX");
        let file = std::fs::File::open(&path).expect("DOCX exists");
        let mut archive = zip::ZipArchive::new(file).expect("DOCX is a zip archive");
        let mut xml = String::new();
        archive.by_name("word/document.xml").expect("main document part")
            .read_to_string(&mut xml).expect("read document XML");
        assert!(xml.contains("测试文档"));
        assert!(xml.contains("内容 &amp; &lt;确认&gt;"));
        std::env::remove_var("UNIOPC_DATA_DIR");
        std::fs::remove_dir_all(root).ok();
    }

    async fn call_bridge(
        state: LocalDocumentsBridgeState,
        token: Option<&str>,
        request: serde_json::Value,
    ) -> axum::response::Response {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/v1/documents/operation")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        bridge_handler(
            State(state),
            builder.body(Body::from(request.to_string())).unwrap(),
        )
        .await
    }

    #[tokio::test]
    async fn bridge_rejects_missing_token_and_unmentioned_document() {
        let state = LocalDocumentsBridgeState::new("test-token".to_string());
        let get = serde_json::json!({
            "action": "uniopc_local_document_get",
            "payload": { "id": "doc-1" },
            "agent": {
                "openclawProfile": "member-a",
                "openclawAgentId": "agent-a"
            },
            "session": { "key": "session-a" }
        });

        assert_eq!(
            call_bridge(state.clone(), None, get.clone()).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call_bridge(state, Some("test-token"), get).await.status(),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn bridge_rejects_actions_outside_the_fixed_allowlist_and_legacy_envelopes() {
        let state = LocalDocumentsBridgeState::new("test-token".to_string());
        let response = call_bridge(
            state.clone(),
            Some("test-token"),
            serde_json::json!({
                "action": "uniopc_local_document_archive",
                "payload": { "id": "doc-1" },
                "agent": { "openclawProfile": "member-a", "openclawAgentId": "agent-a" },
                "session": { "key": "session-a" }
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let whitespace_alias = call_bridge(
            state.clone(),
            Some("test-token"),
            serde_json::json!({
                "action": " uniopc_local_document_get ",
                "payload": { "id": "doc-1" },
                "agent": { "openclawProfile": "member-a", "openclawAgentId": "agent-a" },
                "session": { "key": "session-a" }
            }),
        )
        .await;
        assert_eq!(whitespace_alias.status(), StatusCode::BAD_REQUEST);

        let legacy = call_bridge(
            state,
            Some("test-token"),
            serde_json::json!({
                "operation": "get",
                "sessionKey": "session-a",
                "id": "doc-1"
            }),
        )
        .await;
        assert_eq!(legacy.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn bridge_rejects_update_without_a_concurrency_hash() {
        let state = LocalDocumentsBridgeState::new("test-token".to_string());
        let response = call_bridge(
            state,
            Some("test-token"),
            serde_json::json!({
                "action": "uniopc_local_document_update",
                "payload": {
                    "id": "doc-1",
                    "title": "Changed",
                    "category": "research",
                    "markdown": "# Changed",
                    "metadata": {}
                },
                "agent": { "openclawProfile": "member-a", "openclawAgentId": "agent-a" },
                "session": { "key": "session-a" }
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn bridge_accepts_markdown_document_writes_without_a_blocksuite_body() {
        let request = parse_bridge_request(
            serde_json::json!({
                "action": "uniopc_local_document_create",
                "payload": {
                    "title": "Markdown 文档",
                    "category": "other",
                    "markdown": "# Markdown 文档\n\n- 正确显示"
                },
                "agent": { "openclawProfile": "member-a", "openclawAgentId": "agent-a" },
                "session": { "key": "session-a" }
            })
            .to_string()
            .as_bytes(),
        );

        let request = request.expect("markdown write should parse");
        assert_eq!(request.profile, "member-a");
        match request.operation {
            BridgeOperation::Create { markdown, .. } => {
                assert_eq!(markdown, "# Markdown 文档\n\n- 正确显示");
            }
            _ => panic!("expected a create operation"),
        }
    }

    #[test]
    fn bridge_uses_legacy_markdown_projection_instead_of_blocksuite_json() {
        let request = parse_bridge_request(
            serde_json::json!({
                "action": "uniopc_local_document_create",
                "payload": {
                    "title": "兼容旧插件",
                    "category": "other",
                    "blocksuiteBody": serde_json::json!({
                        "type": "page",
                        "blocks": [
                            { "type": "heading", "text": { "content": "测试标题", "level": 1 } },
                            { "type": "paragraph", "text": { "content": "正文内容" } },
                            { "type": "list", "listType": "bullet", "items": ["第一项", "第二项"] }
                        ]
                    }).to_string(),
                    "markdownProjection": "# 测试标题\n\n正文内容\n\n- 第一项\n- 第二项"
                },
                "agent": { "openclawProfile": "member-a", "openclawAgentId": "agent-a" },
                "session": { "key": "session-a" }
            })
            .to_string()
            .as_bytes(),
        );

        let request = request.expect("legacy markdown projection should parse");
        match request.operation {
            BridgeOperation::Create { markdown, .. } => {
                assert_eq!(markdown, "# 测试标题\n\n正文内容\n\n- 第一项\n- 第二项");
            }
            _ => panic!("expected a create operation"),
        }
    }

    #[tokio::test]
    async fn bridge_rejects_generic_database_parameters() {
        let state = LocalDocumentsBridgeState::new("test-token".to_string());
        let response = call_bridge(
            state,
            Some("test-token"),
            serde_json::json!({
                "action": "uniopc_local_documents_list",
                "payload": { "databasePath": "/tmp/documents.db" },
                "agent": { "openclawProfile": "member-a", "openclawAgentId": "agent-a" },
                "session": { "key": "session-a" }
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn bridge_fails_closed_on_missing_profile_or_session() {
        let state = LocalDocumentsBridgeState::new("test-token".to_string());
        let without_profile = serde_json::json!({
            "action": "uniopc_local_documents_list",
            "payload": {},
            "agent": { "openclawProfile": "", "openclawAgentId": "agent-a" },
            "session": { "key": "session-a" }
        });
        assert_eq!(
            call_bridge(state.clone(), Some("test-token"), without_profile)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );

        let without_session = serde_json::json!({
            "action": "uniopc_local_documents_list",
            "payload": {},
            "agent": { "openclawProfile": "member-a", "openclawAgentId": "session-a" },
            "session": { "key": "" }
        });
        assert_eq!(
            call_bridge(state, Some("test-token"), without_session)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn agent_identity_never_substitutes_for_the_session_document_grant() {
        let state = LocalDocumentsBridgeState::new("test-token".to_string());
        state.replace_turn_grants("session-a", ["doc-1"]);
        let response = call_bridge(
            state,
            Some("test-token"),
            serde_json::json!({
                "action": "uniopc_local_document_get",
                "payload": { "id": "doc-1" },
                "agent": {
                    "openclawProfile": "member-a",
                    "openclawAgentId": "session-a"
                },
                "session": { "key": "session-b" }
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn generic_openclaw_environment_never_receives_bridge_credentials() {
        set_bridge_port(32100).unwrap();

        let environment = crate::services::openclaw_cli::state_env_for_profile(None);

        assert!(!environment.iter().any(|(key, _)| {
            matches!(
                key.as_str(),
                "UNIOPC_LOCAL_DOCUMENTS_URL" | "UNIOPC_LOCAL_DOCUMENTS_TOKEN"
            )
        }));
    }

    #[test]
    fn create_cannot_restore_a_terminal_sessions_document_grant() {
        let state = LocalDocumentsBridgeState::new("test-token".to_string());
        state.replace_turn_grants("session-a", ["doc-old"]);
        state.bind_turn_run("session-a", "run-old");
        state.clear_terminal_turn("session-a", Some("run-old"));

        let request = serde_json::to_vec(&serde_json::json!({
            "action": "uniopc_local_document_create",
            "payload": {
                "title": "Created",
                "category": "research",
                "markdown": "# Created",
                "metadata": {}
            },
            "agent": { "openclawProfile": "member-a", "openclawAgentId": "agent-a" },
            "session": { "key": "session-a" }
        }))
        .unwrap();

        assert!(parse_bridge_request(&request).is_ok());
        assert!(!state.is_document_granted("session-a", "doc-created"));
    }

    #[test]
    fn child_environment_contains_only_the_bridge_url_and_token() {
        let environment = environment_for_endpoint(
            "http://127.0.0.1:32100/v1/documents/operation",
            "test-token",
        );

        assert_eq!(
            environment,
            vec![
                (
                    "UNIOPC_LOCAL_DOCUMENTS_URL".to_string(),
                    "http://127.0.0.1:32100/v1/documents/operation".to_string(),
                ),
                (
                    "UNIOPC_LOCAL_DOCUMENTS_TOKEN".to_string(),
                    "test-token".to_string(),
                ),
            ]
        );
    }

    #[test]
    fn list_metadata_omits_document_bodies_and_markdown_projection() {
        let metadata = metadata_from_summary(LocalDocumentSummary {
            id: "doc-1".to_string(),
            title: "Private note".to_string(),
            category: "research".to_string(),
            markdown_projection: "secret markdown".to_string(),
            content_hash: "hash-a".to_string(),
            status: "active".to_string(),
            version: 1,
            created_at: "2026-08-09T00:00:00.000Z".to_string(),
            updated_at: "2026-08-09T00:00:00.000Z".to_string(),
        });
        let value = serde_json::to_value(metadata).unwrap();

        assert_eq!(value["title"], "Private note");
        assert!(value.get("markdownProjection").is_none());
        assert!(value.get("blocksuiteBody").is_none());
    }

    #[test]
    fn a_new_turn_replaces_the_previous_document_grant() {
        let state = LocalDocumentsBridgeState::new("test-token".to_string());
        state.replace_turn_grants("session-a", ["doc-1"]);
        assert!(state.is_document_granted("session-a", "doc-1"));

        state.replace_turn_grants("session-a", std::iter::empty::<&str>());
        assert!(!state.is_document_granted("session-a", "doc-1"));
    }

    #[test]
    fn direct_workspace_access_grants_any_document_only_for_the_current_turn() {
        let state = LocalDocumentsBridgeState::new("test-token".to_string());
        state.replace_turn_workspace_grant("session-a", std::iter::empty::<&str>());
        assert!(state.is_document_granted("session-a", "doc-1"));

        state.replace_turn_grants("session-a", std::iter::empty::<&str>());
        assert!(!state.is_document_granted("session-a", "doc-1"));
    }

    #[test]
    fn terminal_event_clears_only_the_matching_run_grant() {
        let state = LocalDocumentsBridgeState::new("test-token".to_string());
        state.replace_turn_grants("session-a", ["doc-new"]);
        state.bind_turn_run("session-a", "run-new");

        state.clear_terminal_turn("session-a", Some("run-old"));
        assert!(state.is_document_granted("session-a", "doc-new"));

        state.clear_terminal_turn("session-a", Some("run-new"));
        assert!(!state.is_document_granted("session-a", "doc-new"));
    }
}
