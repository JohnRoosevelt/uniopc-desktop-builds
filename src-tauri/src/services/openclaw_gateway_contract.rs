//! Versioned OpenClaw wire payloads normalized into Uniopc-owned DTOs.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const UNIOPC_GATEWAY_CLIENT_DISPLAY_NAME: &str = "Uniopc Desktop";
const OPENCLAW_GATEWAY_PROTOCOL: u32 = 4;
const REQUIRED_METHODS: &[&str] = &[
    "agents.files.list",
    "agents.files.get",
    "agents.files.set",
    "sessions.list",
];
const REQUIRED_SCOPES: &[&str] = &["operator.read", "operator.write"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayCapabilities {
    pub protocol: u32,
    pub server_version: String,
    pub methods: Vec<String>,
    pub events: Vec<String>,
    pub capabilities: Vec<String>,
    pub role: String,
    pub scopes: Vec<String>,
    pub max_payload_bytes: u64,
    pub max_buffered_bytes: u64,
    pub tick_interval_ms: u64,
    pub max_attachment_bytes: Option<u64>,
    pub max_image_bytes: Option<u64>,
}

impl GatewayCapabilities {
    pub fn from_hello_ok(value: Value) -> Result<Self, UniopcGatewayError> {
        let raw: RawHelloOk =
            serde_json::from_value(value).map_err(contract_deserialization_error)?;
        if raw.message_type != "hello-ok"
            || raw.protocol != OPENCLAW_GATEWAY_PROTOCOL
            || raw.server.version.trim() != env!("IMAI_OPENCLAW_VERSION")
            || !raw.auth.role.eq_ignore_ascii_case("operator")
            || !contains_all(&raw.features.methods, REQUIRED_METHODS)
            || !contains_all(&raw.auth.scopes, REQUIRED_SCOPES)
            || uuid::Uuid::parse_str(raw.server.conn_id.trim()).is_err()
        {
            return Err(contract_identity_error("hello"));
        }
        Ok(Self {
            protocol: raw.protocol,
            server_version: raw.server.version,
            methods: raw.features.methods,
            events: raw.features.events,
            capabilities: raw.features.capabilities,
            role: raw.auth.role,
            scopes: raw.auth.scopes,
            max_payload_bytes: raw.policy.max_payload,
            max_buffered_bytes: raw.policy.max_buffered_bytes,
            tick_interval_ms: raw.policy.tick_interval_ms,
            max_attachment_bytes: raw.policy.attachments.as_ref().map(|value| value.max_bytes),
            max_image_bytes: raw.policy.attachments.map(|value| value.max_image_bytes),
        })
    }

    pub fn supports_method(&self, method: &str) -> bool {
        self.methods.iter().any(|candidate| candidate == method)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileDescriptor {
    pub name: String,
    pub missing: bool,
    pub expected_absent: bool,
    pub size: Option<u64>,
    pub updated_at_ms: Option<u64>,
}

impl AgentFileDescriptor {
    pub fn from_list_payload(value: Value) -> Result<Vec<Self>, UniopcGatewayError> {
        let raw: RawAgentFilesList =
            serde_json::from_value(value).map_err(contract_deserialization_error)?;
        if raw.agent_id.trim().is_empty() {
            return Err(contract_identity_error("agentFiles"));
        }
        raw.files
            .into_iter()
            .map(|file| {
                let name = file.name.trim();
                if name.is_empty() {
                    return Err(contract_identity_error("agentFile"));
                }
                Ok(Self {
                    name: name.to_string(),
                    missing: file.missing,
                    expected_absent: file.expected_absent,
                    size: file.size,
                    updated_at_ms: file.updated_at_ms,
                })
            })
            .collect()
    }

    pub fn supports(files: &[Self], name: &str) -> bool {
        files.iter().any(|file| file.name == name)
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    Main,
    Interactive,
    Cron,
    Worker,
    Background,
}

impl SessionKind {
    pub fn is_interactive(self) -> bool {
        matches!(self, Self::Main | Self::Interactive)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingLevelDescriptor {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescriptor {
    pub key: String,
    pub permission_mode: Option<String>,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub kind: SessionKind,
    pub title: String,
    pub summary: Option<String>,
    pub updated_at: Option<u64>,
    pub created_at: Option<u64>,
    pub model_provider: Option<String>,
    pub model: Option<String>,
    pub thinking_default: Option<String>,
    pub thinking_levels: Vec<ThinkingLevelDescriptor>,
    pub archived: bool,
    pub pinned: bool,
    pub unread: bool,
}

impl SessionDescriptor {
    pub fn from_list_payload(value: Value) -> Result<Vec<Self>, UniopcGatewayError> {
        let raw: RawSessionsList =
            serde_json::from_value(value).map_err(contract_deserialization_error)?;
        raw.sessions.into_iter().map(Self::try_from_raw).collect()
    }

    pub fn from_session_value(value: Value) -> Result<Self, UniopcGatewayError> {
        let raw: RawSession =
            serde_json::from_value(value).map_err(contract_deserialization_error)?;
        Self::try_from_raw(raw)
    }

    fn try_from_raw(raw: RawSession) -> Result<Self, UniopcGatewayError> {
        let key = raw.key.trim();
        if key.is_empty() || raw.raw_kind.trim().is_empty() {
            return Err(contract_identity_error("session"));
        }
        let kind = classify_session(&raw, key);
        let session_id = non_empty(raw.session_id);
        let derived_title =
            non_empty(raw.derived_title).filter(|title| !is_internal_context_text(title));
        let display_name =
            non_empty(raw.display_name).filter(|name| name != UNIOPC_GATEWAY_CLIENT_DISPLAY_NAME);
        let title = non_empty(raw.label)
            .or(derived_title)
            .or(display_name)
            .or_else(|| non_empty(raw.title))
            .or_else(|| {
                session_id
                    .as_deref()
                    .map(|id| id.get(..8).unwrap_or(id).to_string())
            })
            .unwrap_or_else(|| key.to_string());
        Ok(Self {
            key: key.to_string(),
            permission_mode: non_empty(raw.permission_mode),
            session_id,
            agent_id: non_empty(raw.agent_id),
            kind,
            title,
            summary: non_empty(raw.summary).or_else(|| non_empty(raw.description)),
            updated_at: raw.updated_at.and_then(timestamp_as_millis),
            created_at: raw.created_at.and_then(timestamp_as_millis),
            model_provider: non_empty(raw.model_provider),
            model: non_empty(raw.model),
            thinking_default: non_empty(raw.thinking_default),
            thinking_levels: raw
                .thinking_levels
                .into_iter()
                .filter_map(normalize_thinking_level)
                .collect(),
            archived: raw.archived_at.is_some(),
            pinned: raw.pinned_at.is_some(),
            unread: raw.marked_unread_at.is_some(),
        })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UniopcGatewayError {
    pub code: String,
    pub retryable: bool,
    pub recovery_action: String,
    pub message_key: String,
    pub trace_id: String,
}

impl std::fmt::Display for UniopcGatewayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} ({})", self.message_key, self.code)
    }
}

impl std::error::Error for UniopcGatewayError {}

pub fn normalize_gateway_error(value: Value) -> UniopcGatewayError {
    let payload = value.get("error").unwrap_or(&value);
    let details = payload.get("details");
    // Do not forward provider text to the renderer: it may include account or
    // credential details. This one known provider state still needs a distinct,
    // actionable product error instead of the misleading generic send failure.
    let code = if is_provider_auth_or_billing_failure(&value)
        || is_provider_auth_or_billing_failure(payload)
    {
        "MODEL_AUTH_OR_BILLING".to_string()
    } else {
        normalize_gateway_error_code(
            string_at(payload, "code")
                .or_else(|| details.and_then(|value| string_at(value, "code")))
                .as_deref(),
        )
    };
    // Gateway trace identifiers are untrusted wire data. A fresh local UUID is
    // the only correlation identifier allowed across the log/UI boundary.
    let trace_id = uuid::Uuid::new_v4().to_string();
    let raw_retryable = payload.get("retryable").and_then(Value::as_bool);
    let (retryable, recovery_action, message_key) = match code.as_str() {
        "UNAVAILABLE" | "TIMEOUT" | "CONNECTION_CLOSED" | "ENGINE_STARTING"
        | "NODE_NOT_READY" => {
            (true, "retry", "gateway.unavailable")
        }
        "NOT_PAIRED" | "PAIRING_REQUIRED" => (false, "pairDevice", "gateway.notPaired"),
        "MISSING_SCOPE" | "FORBIDDEN" | "UNAUTHORIZED" | "AUTH_TOKEN_MISMATCH"
        | "AUTH_SCOPE_MISMATCH" => {
            (false, "reviewPermissions", "gateway.forbidden")
        }
        "INVALID_REQUEST" | "VALIDATION_ERROR" => {
            (false, "reviewRequest", "gateway.invalidRequest")
        }
        "MODEL_AUTH_OR_BILLING" => (
            false,
            "selectModel",
            "gateway.modelCredentialsUnavailable",
        ),
        _ => (
            raw_retryable.unwrap_or(false),
            "openRuntime",
            "gateway.unknown",
        ),
    };
    UniopcGatewayError {
        code,
        retryable,
        recovery_action: recovery_action.to_string(),
        message_key: message_key.to_string(),
        trace_id,
    }
}

fn is_provider_auth_or_billing_failure(value: &Value) -> bool {
    ["message", "errorMessage", "reason"]
        .iter()
        .filter_map(|field| value.get(*field).and_then(Value::as_str))
        .map(str::to_ascii_lowercase)
        .any(|message| {
            message.contains("provider auth/billing failure")
                || message.contains("provider authentication/billing failure")
        })
}

pub fn normalize_gateway_recommended_next_step(value: Option<&str>) -> Option<String> {
    match value.map(str::trim) {
        Some(
            value @ ("retry_with_device_token"
            | "update_auth_configuration"
            | "update_auth_credentials"
            | "wait_then_retry"
            | "review_auth_configuration"),
        ) => Some(value.to_string()),
        _ => None,
    }
}

fn normalize_gateway_error_code(value: Option<&str>) -> String {
    match value.map(str::trim).map(str::to_ascii_uppercase).as_deref() {
        Some(
            value @ ("UNAVAILABLE"
            | "TIMEOUT"
            | "CONNECTION_CLOSED"
            | "ENGINE_STARTING"
            | "NODE_NOT_READY"
            | "NOT_PAIRED"
            | "PAIRING_REQUIRED"
            | "MISSING_SCOPE"
            | "FORBIDDEN"
            | "UNAUTHORIZED"
            | "AUTH_TOKEN_MISMATCH"
            | "AUTH_SCOPE_MISMATCH"
            | "INVALID_REQUEST"
            | "VALIDATION_ERROR"
            | "MODEL_AUTH_OR_BILLING"
            | "GATEWAY_ERROR"),
        ) => value.to_string(),
        _ => "GATEWAY_ERROR".to_string(),
    }
}

#[derive(Deserialize)]
struct RawHelloOk {
    #[serde(rename = "type")]
    message_type: String,
    protocol: u32,
    server: RawHelloServer,
    features: RawHelloFeatures,
    #[serde(rename = "snapshot")]
    _snapshot: RawHelloSnapshot,
    auth: RawHelloAuth,
    policy: RawHelloPolicy,
}

#[derive(Deserialize)]
struct RawHelloServer {
    version: String,
    #[serde(rename = "connId")]
    conn_id: String,
}

#[derive(Deserialize)]
struct RawHelloFeatures {
    methods: Vec<String>,
    events: Vec<String>,
    #[serde(default)]
    capabilities: Vec<String>,
}

#[derive(Deserialize)]
struct RawHelloAuth {
    role: String,
    scopes: Vec<String>,
}

#[derive(Deserialize)]
struct RawHelloSnapshot {
    #[serde(rename = "presence")]
    _presence: Value,
    #[serde(rename = "health")]
    _health: Value,
    #[serde(rename = "stateVersion")]
    _state_version: Value,
    #[serde(rename = "uptimeMs")]
    _uptime_ms: u64,
}

#[derive(Deserialize)]
struct RawHelloPolicy {
    #[serde(rename = "maxPayload")]
    max_payload: u64,
    #[serde(rename = "maxBufferedBytes")]
    max_buffered_bytes: u64,
    #[serde(rename = "tickIntervalMs")]
    tick_interval_ms: u64,
    #[serde(default)]
    attachments: Option<RawHelloAttachments>,
}

#[derive(Deserialize)]
struct RawHelloAttachments {
    #[serde(rename = "maxBytes")]
    max_bytes: u64,
    #[serde(rename = "maxImageBytes")]
    max_image_bytes: u64,
}

#[derive(Deserialize)]
struct RawAgentFilesList {
    #[serde(rename = "agentId")]
    agent_id: String,
    files: Vec<RawAgentFile>,
}

#[derive(Deserialize)]
struct RawAgentFile {
    name: String,
    missing: bool,
    #[serde(rename = "expectedAbsent", default)]
    expected_absent: bool,
    #[serde(default)]
    size: Option<u64>,
    #[serde(rename = "updatedAtMs", default)]
    updated_at_ms: Option<u64>,
}

#[derive(Deserialize)]
struct RawSessionsList {
    sessions: Vec<RawSession>,
}

#[derive(Deserialize)]
struct RawSession {
    key: String,
    #[serde(rename = "permissionMode", default)]
    permission_mode: Option<String>,
    #[serde(rename = "kind")]
    raw_kind: String,
    #[serde(default)]
    classification: Option<String>,
    #[serde(rename = "agentId", default)]
    agent_id: Option<String>,
    #[serde(rename = "isMain", default)]
    is_main: bool,
    #[serde(rename = "isBackground", default)]
    is_background: bool,
    #[serde(rename = "createdVia", default)]
    created_via: Option<String>,
    #[serde(rename = "spawnedBy", default)]
    spawned_by: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(rename = "derivedTitle", default)]
    derived_title: Option<String>,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(rename = "sessionId", default)]
    session_id: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "updatedAt", default)]
    updated_at: Option<Value>,
    #[serde(rename = "createdAt", default)]
    created_at: Option<Value>,
    #[serde(rename = "modelProvider", default)]
    model_provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(rename = "thinkingDefault", default)]
    thinking_default: Option<String>,
    #[serde(rename = "thinkingLevels", default)]
    thinking_levels: Vec<Value>,
    #[serde(rename = "archivedAt", default)]
    archived_at: Option<Value>,
    #[serde(rename = "pinnedAt", default)]
    pinned_at: Option<Value>,
    #[serde(rename = "markedUnreadAt", default)]
    marked_unread_at: Option<Value>,
}

fn classify_session(raw: &RawSession, key: &str) -> SessionKind {
    let classification = raw.classification.as_deref().unwrap_or_default();
    let created_via = raw.created_via.as_deref().unwrap_or_default();
    if classification.eq_ignore_ascii_case("cron")
        || created_via.eq_ignore_ascii_case("cron")
        || (raw.is_background && key.contains(":cron:"))
    {
        SessionKind::Cron
    } else if matches_ignore_ascii_case(classification, &["subagent", "worker"])
        || raw
            .spawned_by
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || key.contains(":subagent:")
    {
        SessionKind::Worker
    } else if raw.is_background {
        SessionKind::Background
    } else if raw.is_main || classification.eq_ignore_ascii_case("main") {
        SessionKind::Main
    } else {
        SessionKind::Interactive
    }
}

fn matches_ignore_ascii_case(value: &str, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
}

fn contains_all(values: &[String], required: &[&str]) -> bool {
    required
        .iter()
        .all(|required| values.iter().any(|value| value == required))
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn timestamp_as_millis(value: Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|value| u64::try_from(value).ok()))
        .or_else(|| value.as_str().and_then(|value| value.parse::<u64>().ok()))
}

fn normalize_thinking_level(value: Value) -> Option<ThinkingLevelDescriptor> {
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(ThinkingLevelDescriptor {
            id: text.to_string(),
            label: text.to_string(),
        });
    }
    let id = value
        .get("id")
        .or_else(|| value.get("value"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let label = value
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(id);
    Some(ThinkingLevelDescriptor {
        id: id.to_string(),
        label: label.to_string(),
    })
}

fn is_internal_context_text(text: &str) -> bool {
    text.trim_start().starts_with("_uniopc_context_hash:")
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn contract_deserialization_error(_: serde_json::Error) -> UniopcGatewayError {
    contract_identity_error("payload")
}

fn contract_identity_error(identity: &str) -> UniopcGatewayError {
    UniopcGatewayError {
        code: "GATEWAY_CONTRACT_INVALID".to_string(),
        retryable: false,
        recovery_action: "upgradeRuntime".to_string(),
        message_key: format!("gateway.contract.{identity}.invalid"),
        trace_id: uuid::Uuid::new_v4().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const HELLO_OK: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/openclaw-2026.8.1/hello-ok.json"
    ));
    const AGENT_FILES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/openclaw-2026.8.1/agent-files.json"
    ));
    const SESSIONS_LIST: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/openclaw-2026.8.1/sessions-list.json"
    ));

    fn fixture(raw: &str) -> Value {
        serde_json::from_str(raw).expect("fixture must be valid JSON")
    }

    fn compatible_hello_fixture() -> Value {
        let mut value = fixture(HELLO_OK);
        value["server"]["version"] = Value::String(env!("IMAI_OPENCLAW_VERSION").to_string());
        value
    }

    #[test]
    fn hello_fixture_ignores_additive_fields_and_exposes_stable_capabilities() {
        let capabilities = GatewayCapabilities::from_hello_ok(compatible_hello_fixture())
            .expect("captured 2026.8.1 hello-ok must normalize");

        assert_eq!(capabilities.protocol, 4);
        assert_eq!(capabilities.server_version, env!("IMAI_OPENCLAW_VERSION"));
        assert!(capabilities.supports_method("agents.files.list"));
        assert!(capabilities.supports_method("sessions.list"));
        assert_eq!(capabilities.role, "operator");
        assert!(serde_json::to_value(capabilities)
            .expect("serialize capabilities")
            .get("futureServerField")
            .is_none());
    }

    #[test]
    fn hello_missing_server_version_fails_closed() {
        let mut value = compatible_hello_fixture();
        value["server"]
            .as_object_mut()
            .expect("server object")
            .remove("version");

        assert!(GatewayCapabilities::from_hello_ok(value).is_err());
    }

    #[test]
    fn hello_missing_snapshot_fails_closed() {
        let mut value = compatible_hello_fixture();
        value.as_object_mut().expect("hello object").remove("snapshot");

        assert!(GatewayCapabilities::from_hello_ok(value).is_err());
    }

    #[test]
    fn hello_rejects_undeclared_version_and_non_live_protocol() {
        for version in ["0.0.0", "9999.1.0"] {
            let mut value = compatible_hello_fixture();
            value["server"]["version"] = Value::String(version.to_string());
            assert!(GatewayCapabilities::from_hello_ok(value).is_err(), "{version}");
        }
        for protocol in [0, 3, 5] {
            let mut value = compatible_hello_fixture();
            value["protocol"] = json!(protocol);
            assert!(GatewayCapabilities::from_hello_ok(value).is_err(), "{protocol}");
        }
    }

    #[test]
    fn hello_requires_operator_role_and_live_scopes() {
        for role in ["", "viewer"] {
            let mut value = compatible_hello_fixture();
            value["auth"]["role"] = Value::String(role.to_string());
            assert!(GatewayCapabilities::from_hello_ok(value).is_err(), "{role}");
        }
        for scopes in [json!([]), json!(["operator.read"]), json!(["operator.write"])] {
            let mut value = compatible_hello_fixture();
            value["auth"]["scopes"] = scopes;
            assert!(GatewayCapabilities::from_hello_ok(value).is_err());
        }
    }

    #[test]
    fn hello_requires_adapter_methods() {
        for missing in ["agents.files.list", "agents.files.get", "agents.files.set", "sessions.list"] {
            let mut value = compatible_hello_fixture();
            value["features"]["methods"]
                .as_array_mut()
                .expect("methods array")
                .retain(|method| method.as_str() != Some(missing));
            assert!(GatewayCapabilities::from_hello_ok(value).is_err(), "{missing}");
        }
        let mut value = compatible_hello_fixture();
        value["features"]["methods"] = json!([]);
        assert!(GatewayCapabilities::from_hello_ok(value).is_err());
    }

    #[test]
    fn agent_files_are_exactly_the_supported_list() {
        let files = AgentFileDescriptor::from_list_payload(fixture(AGENT_FILES))
            .expect("captured 2026.8.1 agents.files.list must normalize");
        let names = files
            .iter()
            .map(|file| file.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "AGENTS.md",
                "SOUL.md",
                "USER.md",
                "BOOTSTRAP.md",
                "MEMORY.md"
            ]
        );
        assert!(!AgentFileDescriptor::supports(&files, "TOOLS.md"));
        assert!(!AgentFileDescriptor::supports(&files, "IDENTITY.md"));
        assert!(AgentFileDescriptor::supports(&files, "AGENTS.md"));
    }

    #[test]
    fn agent_file_missing_name_fails_closed() {
        let value = json!({ "files": [{ "missing": false }] });
        assert!(AgentFileDescriptor::from_list_payload(value).is_err());
    }

    #[test]
    fn agent_files_missing_agent_identity_fail_closed() {
        let value = json!({
            "files": [{ "name": "AGENTS.md", "missing": false }]
        });
        assert!(AgentFileDescriptor::from_list_payload(value).is_err());
    }

    #[test]
    fn sessions_fixture_normalizes_interactive_and_background_kinds() {
        let sessions = SessionDescriptor::from_list_payload(fixture(SESSIONS_LIST))
            .expect("captured 2026.8.1 sessions.list must normalize");

        assert_eq!(sessions[0].kind, SessionKind::Main);
        assert!(sessions[0].kind.is_interactive());
        assert_eq!(sessions[1].kind, SessionKind::Cron);
        assert!(!sessions[1].kind.is_interactive());
        assert_eq!(sessions[2].kind, SessionKind::Worker);
        assert!(!sessions[2].kind.is_interactive());
        assert_eq!(sessions[3].kind, SessionKind::Interactive);
    }

    #[test]
    fn session_permission_mode_is_available_to_conversation_picker() {
        let session = SessionDescriptor::from_session_value(json!({
            "key": "agent:main:main",
            "kind": "direct",
            "permissionMode": "guarded"
        }))
        .expect("session with permission mode must normalize");
        assert_eq!(session.permission_mode.as_deref(), Some("guarded"));
    }

    #[test]
    fn unknown_official_background_sessions_fail_safe_noninteractive() {
        for classification in ["acp", "dreaming", "harness", "heartbeat", "hook", "system", "future"] {
            let session = SessionDescriptor::from_session_value(json!({
                "key": format!("opaque-{classification}"),
                "kind": "direct",
                "classification": classification,
                "isBackground": true
            }))
            .expect("background session must normalize");

            assert_eq!(session.kind, SessionKind::Background);
            assert!(!session.kind.is_interactive());
        }
    }

    #[test]
    fn session_missing_key_fails_closed() {
        let value = json!({ "sessions": [{ "kind": "direct" }] });
        assert!(SessionDescriptor::from_list_payload(value).is_err());
    }

    #[test]
    fn gateway_errors_are_normalized_without_exposing_raw_messages() {
        let error = normalize_gateway_error(json!({
            "error": {
                "code": "UNAVAILABLE",
                "message": "token=fixture-secret could not connect",
                "retryable": true,
                "details": { "traceId": "trace-fixture" }
            }
        }));

        assert_eq!(error.code, "UNAVAILABLE");
        assert!(error.retryable);
        assert_eq!(error.recovery_action, "retry");
        assert_eq!(error.message_key, "gateway.unavailable");
        assert_ne!(error.trace_id, "trace-fixture");
        assert!(uuid::Uuid::parse_str(&error.trace_id).is_ok());
        assert!(!serde_json::to_string(&error)
            .expect("serialize normalized error")
            .contains("fixture-secret"));
    }

    #[test]
    fn gateway_errors_reject_untrusted_code_and_trace_fields() {
        let error = normalize_gateway_error(json!({
            "error": {
                "code": "TOKEN=C0DE C:\\private\\OpenClaw",
                "message": "token=message-secret C:\\private\\OpenClaw",
                "details": {
                    "traceId": "token=trace-secret/C:\\private\\OpenClaw/../../escape"
                }
            }
        }));
        let serialized = serde_json::to_string(&error).expect("stable error serializes");

        assert_eq!(error.code, "GATEWAY_ERROR");
        assert!(uuid::Uuid::parse_str(&error.trace_id).is_ok());
        for secret in ["C0DE", "message-secret", "trace-secret", "private", "OpenClaw"] {
            assert!(!serialized.contains(secret), "leaked {secret}");
        }

        let overlong = normalize_gateway_error(json!({
            "error": { "code": "UNAVAILABLE", "traceId": "a".repeat(65) }
        }));
        assert!(uuid::Uuid::parse_str(&overlong.trace_id).is_ok());
    }

    #[test]
    fn provider_auth_or_billing_failure_is_actionable_without_leaking_provider_text() {
        let error = normalize_gateway_error(json!({
            "error": {
                "message": "Inline API key for provider \"uniopc-official\" is temporarily disabled after a provider auth/billing failure."
            }
        }));

        assert_eq!(error.code, "MODEL_AUTH_OR_BILLING");
        assert_eq!(error.recovery_action, "selectModel");
        assert_eq!(error.message_key, "gateway.modelCredentialsUnavailable");
        assert!(!serde_json::to_string(&error)
            .expect("serialize normalized error")
            .contains("uniopc-official"));
    }

    #[test]
    fn gateway_errors_never_reuse_safe_shaped_upstream_trace_secrets() {
        let upstream_trace = "AlphanumericSecretTrace1234567890";
        let error = normalize_gateway_error(json!({
            "error": {
                "code": "UNAVAILABLE",
                "details": { "traceId": upstream_trace }
            }
        }));
        let serialized = serde_json::to_string(&error).expect("stable error serializes");

        assert_ne!(error.trace_id, upstream_trace);
        assert!(uuid::Uuid::parse_str(&error.trace_id).is_ok());
        assert!(!serialized.contains(upstream_trace));
    }

    #[test]
    fn hello_rejects_non_uuid_gateway_connection_identity() {
        let mut value = compatible_hello_fixture();
        value["server"]["connId"] =
            Value::String("AlphanumericConnSecret123-private-OpenClaw".to_string());

        assert!(GatewayCapabilities::from_hello_ok(value).is_err());
    }

    #[test]
    fn gateway_contract_version_comes_from_the_build_manifest() {
        let source = include_str!("openclaw_gateway_contract.rs");
        let mut value = fixture(HELLO_OK);
        value["server"]["version"] = Value::String(env!("IMAI_OPENCLAW_VERSION").to_string());

        let capabilities = GatewayCapabilities::from_hello_ok(value)
            .expect("manifest-declared Gateway version must be accepted");
        assert_eq!(capabilities.server_version, env!("IMAI_OPENCLAW_VERSION"));
        assert!(source.contains("env!(\"IMAI_OPENCLAW_VERSION\")"));
    }
}
