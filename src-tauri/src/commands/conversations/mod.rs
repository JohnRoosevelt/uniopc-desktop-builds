pub mod approvals;
pub mod history;
pub mod pairing;
pub mod sessions;
pub mod turns;

use self::sessions::{apply_session_control_patch, validate_model_override_for_profile};
#[cfg(test)]
use self::sessions::{
    build_session_control_patch, build_session_label_patch, build_session_model_patch,
    build_session_patch_params, build_session_thinking_patch,
};

use crate::commands::model::{openclaw_output_for_profile, openclaw_status, OpenClawStatus};
use crate::commands::openclaw_plugins;
use crate::services::openclaw_device_auth::{
    build_openclaw_device_auth_payload_v3, device_public_key_base64_url, ensure_device_identity,
    persist_cached_device_token, read_cached_device_token, DeviceIdentityInfo,
    StoredGatewayDeviceToken,
};
use crate::services::{
    openclaw_browser, openclaw_cli, openclaw_connection, openclaw_gateway,
    openclaw_gateway_connection,
    openclaw_gateway_contract::{
        normalize_gateway_error, normalize_gateway_recommended_next_step, SessionDescriptor,
        UniopcGatewayError,
    },
    openclaw_runtime,
};
use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::connect_async;

const TARGET_MODE: &str = "gateway_native";

/// Sessions with a turn currently being kicked off. `send_conversation_turn_inner`
/// returns as soon as the gateway accepts the `chat.send` (streaming continues via
/// events), so this only spans the multi-round-trip kickoff — enough to stop a
/// double-click / two overlapping `conversation_send_turn` calls from racing two
/// runs onto one session. It does NOT gate "send while a prior turn is still
/// streaming" (Rust never sees the terminal event); that belongs to the frontend
/// send-button gate / product-level queue.
fn in_flight_turn_sessions() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// RAII: frees the session on drop so an early return / error / panic during
/// kickoff can never leave it permanently locked.
struct InFlightTurnGuard(String);

impl Drop for InFlightTurnGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = in_flight_turn_sessions().lock() {
            set.remove(&self.0);
        }
    }
}

fn try_begin_turn(session_key: &str) -> Option<InFlightTurnGuard> {
    let mut set = in_flight_turn_sessions().lock().ok()?;
    if !set.insert(session_key.to_string()) {
        return None;
    }
    Some(InFlightTurnGuard(session_key.to_string()))
}
const TARGET_TRANSPORT: &str = "gateway_websocket";
const CURRENT_MODE: &str = TARGET_MODE;
const CURRENT_TRANSPORT: &str = TARGET_TRANSPORT;
const INTERNAL_CONTEXT_MARKER: &str = "_uniopc_context_hash:";
const OPENCLAW_HEARTBEAT_MARKER: &str = "Read HEARTBEAT.md if it exists (workspace context).";
const OPENCLAW_HEARTBEAT_POLL_MARKER: &str = "[Uniopc 引擎 heartbeat poll]";
const OPENCLAW_BOOTSTRAP_PENDING_MARKER: &str = "[Bootstrap pending]";
const USER_ORIGINAL_MESSAGE_MARKER: &str = "用户原始消息：";
const LEGACY_USER_MESSAGE_MARKER: &str = "用户消息：";
const OPENCLAW_STREAM_FAILURE_MARKER: &str = "[assistant turn failed before producing content]";
const OPENCLAW_STREAM_FAILURE_FALLBACK: &str = "The agent run failed before producing a reply.";
#[cfg(test)]
const DIRECT_CONVERSATION_PROJECT_ID: &str = "workspace:direct";
// A cold or freshly reloaded Uniopc 引擎 can take a little over 10s to
// accept the challenge/config/history round trip, so keep the UI from marking
// valid sends as failed during that warm-up window.
const GATEWAY_WS_CONNECT_TIMEOUT_SECS: u64 = 15;
const GATEWAY_WS_REQUEST_TIMEOUT_SECS: u64 = 30;
const CONVERSATION_IMAGE_MAX_COUNT: usize = 4;
const CONVERSATION_ATTACHMENT_MAX_BYTES: usize = 10 * 1024 * 1024;
const CONVERSATION_ATTACHMENT_MAX_TOTAL_BYTES: usize = 100 * 1024 * 1024;
const IMAI_BROWSER_AUTOMATION_CONTEXT: &str = "\
Uniopc 员工运行上下文：\n\
- 官方 browser 能力由运行中心的 Browser Runtime 状态决定；只有 enabled、Gateway 已连接、scope 已批准且 doctor/status 可用时才使用 browser tool。\n\
- 远程连接默认使用 Host browser，也就是 Gateway 中已配对且发布 browser capability 的 node 所在机器；这台 Mac 的浏览器只有显式作为 browser node 配对后才可用。\n\
- 需要浏览器自动化时，优先使用用户在消息里显式 @ 的 MCP / Skill（例如 @mcp:playwright）；没有可用 browser runtime 时，先说明需要在运行中心启用 Browser Runtime 或批准 scope upgrade。\n\
- 如果确实使用官方 browser tool，默认 profile 是 `openclaw`；操作前先读取 browser status/tabs/doctor，优先复用可用标签页，除非用户明确需要并行页面才新开标签。\n\
- 使用官方 browser tool 时，targetId/tabId 必须来自最新 tabs/open/navigate/snapshot 返回值；页面变化后重新读取状态，不要复用旧 ID 或猜测值。\n\
- 除非用户明确要求关闭页面，禁止 close 标签页。\n\
- 遇到登录、二维码、验证码、二次验证或人工确认时，停止自动猜测并请用户手动完成。\n\
- 用户要求“写入文档/保存到文档库”时，目标是云端“文档（新）”；不要再写入旧的本地 Uniopc 文档库。";

fn operator_connect_scopes() -> Vec<String> {
    openclaw_gateway::DEFAULT_OPERATOR_CONNECT_SCOPES
        .iter()
        .map(|scope| (*scope).to_string())
        .collect()
}

fn scopes_cover_official_operator_set(scopes: &[String]) -> bool {
    let granted = scopes
        .iter()
        .map(|scope| scope.trim())
        .collect::<std::collections::HashSet<_>>();
    openclaw_gateway::DEFAULT_OPERATOR_CONNECT_SCOPES
        .iter()
        .all(|scope| granted.contains(scope))
}

fn cached_device_token_covers_requested_scopes(token: &StoredGatewayDeviceToken) -> bool {
    scopes_cover_official_operator_set(&token.scopes)
}

fn gateway_pairing_request_id(value: &Value) -> Option<String> {
    value
        .get("requestId")
        .and_then(Value::as_str)
        .or_else(|| value.get("id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn pairing_request_requests_official_operator_upgrade(value: &Value) -> bool {
    let Some(scopes) = value.get("scopes").and_then(Value::as_array) else {
        return false;
    };
    scopes.iter().filter_map(Value::as_str).any(|scope| {
        matches!(
            scope.trim(),
            "operator.admin" | "operator.approvals" | "operator.pairing"
        )
    })
}

fn select_pairing_request_to_approve(requests: Vec<Value>) -> Result<String, String> {
    requests
        .iter()
        .find(|request| pairing_request_requests_official_operator_upgrade(request))
        .and_then(gateway_pairing_request_id)
        .or_else(|| requests.iter().find_map(gateway_pairing_request_id))
        .ok_or_else(|| "没有待批准的 Gateway 设备配对请求。".to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct ConversationRuntimeDescriptor {
    pub mode: String,
    pub transport: String,
    pub gateway_aligned: bool,
    pub label: String,
    pub summary: String,
    pub methods: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConversationBridgeStatus {
    pub current: ConversationRuntimeDescriptor,
    pub target: ConversationRuntimeDescriptor,
    pub gateway_installed: bool,
    pub gateway_running: bool,
    pub gateway_ws_url: String,
    pub gateway_protocol_version: u32,
    pub gateway_auth_mode: String,
    pub gateway_has_token: bool,
    pub gateway_has_password: bool,
    pub requires_device_identity: bool,
    pub requires_challenge_signature: bool,
    pub device_identity_ready: bool,
    pub device_id: Option<String>,
    pub device_public_key: Option<String>,
    pub cached_device_token_available: bool,
    pub cached_device_token_role: Option<String>,
    pub cached_device_token_scopes: Option<Vec<String>>,
    pub gateway_ws_reachable: bool,
    pub connect_challenge_received: bool,
    pub connect_challenge_event: Option<String>,
    pub challenge_nonce_available: bool,
    pub signed_connect_preview_ready: bool,
    pub signature_payload_version: Option<String>,
    pub probe_error: Option<String>,
    pub bridge_command_ready: bool,
    pub gateway_client_implemented: bool,
    pub target_ready: bool,
    pub next_step: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConversationTurnRequest {
    #[serde(default, alias = "agentId")]
    pub agent_id: Option<String>,
    #[serde(alias = "conversationId")]
    pub conversation_id: Option<String>,
    #[serde(alias = "sessionKey")]
    pub session_key: Option<String>,
    #[serde(default, alias = "projectId")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default, alias = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub mentions: Vec<ConversationMention>,
    #[serde(default)]
    pub attachments: Vec<ConversationAttachment>,
    #[serde(default, alias = "toolInvocations")]
    pub tool_invocations: Vec<ConversationToolInvocation>,
    #[serde(default, alias = "approvalMode")]
    pub approval_mode: Option<String>,
    #[serde(default, alias = "modelOverride")]
    pub model_override: Option<String>,
    #[serde(default, alias = "thinkingOverride")]
    pub thinking_override: Option<String>,
    pub input: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAttachment {
    #[serde(rename = "type", alias = "attachmentType")]
    pub attachment_type: String,
    #[serde(alias = "mimeType")]
    pub mime_type: String,
    #[serde(default, alias = "fileName")]
    pub file_name: Option<String>,
    #[serde(default)]
    pub content: String,
    #[serde(default, alias = "localMediaId")]
    pub local_media_id: Option<String>,
    #[serde(default, alias = "sizeBytes")]
    pub size_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedConversationAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: usize,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMention {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub trigger: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationToolInvocation {
    #[serde(alias = "pluginId")]
    pub plugin_id: String,
    #[serde(default, alias = "toolName")]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub trigger: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConversationTurnResult {
    pub content: String,
    pub run_id: Option<String>,
    pub provider_type: String,
    pub model: String,
    pub data_flow: String,
    pub runtime_mode: String,
    pub transport: String,
    pub gateway_aligned: bool,
    pub gateway_session_key: Option<String>,
    pub gateway_session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConversationAbortRequest {
    #[serde(alias = "sessionKey")]
    pub session_key: String,
    #[serde(default, alias = "runId")]
    pub run_id: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConversationAbortResult {
    pub ok: bool,
    pub aborted: bool,
    pub run_ids: Vec<String>,
    pub transport: String,
    pub gateway_aligned: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConversationSubscribeSessionResult {
    pub ok: bool,
    pub session_key: String,
    pub transport: String,
    pub gateway_aligned: bool,
}

// NB: no `rename_all` — the JS side reads `created_at` (and now `media_paths`)
// as snake_case. Adding camelCase here silently breaks history timestamps.
/// `chat.history` window size. The gateway offers no offset, so this is also the
/// point past which older messages simply are not returned.
const CONVERSATION_HISTORY_LIMIT: u64 = 120;

#[derive(Debug, Clone, Serialize)]
pub struct ConversationHistoryMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: u64,
    /// Absolute local paths of images the engine persisted for this turn, with
    /// their mime types positionally aligned. The gateway NEVER replays image
    /// bytes — `sanitizeChatHistoryContentBlock` deletes `data` and sets
    /// `omitted: true` unconditionally — so these sibling fields are the only
    /// way an attachment survives a history reload. See
    /// `gateway_history_message_media`.
    pub media_paths: Vec<String>,
    pub media_types: Vec<String>,
    /// The key we sent with `chat.send`, persisted by the gateway on the
    /// canonical user row. It is the only exact identity link between an
    /// optimistic local bubble and its server record — matching on
    /// role+text+timestamp collapses two identical messages sent in a row.
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConversationHistoryResult {
    pub session_key: String,
    pub session_id: Option<String>,
    pub messages: Vec<ConversationHistoryMessage>,
    /// Engine-side truth about whether this session still has a turn running,
    /// from `chat.history`'s `sessionInfo.hasActiveRun` / `inFlightRun`. The UI
    /// uses it to decide whether a spinner that never received a `final` frame
    /// is a genuinely running turn or a lost one.
    /// True when `chat.history` returned a full page: older messages exist but
    /// were not sent, so the client must not treat them as deleted.
    pub messages_truncated: bool,
    pub has_active_run: Option<bool>,
    pub in_flight_run_id: Option<String>,
    pub in_flight_text: Option<String>,
    pub model_provider: Option<String>,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub reasoning_level: Option<String>,
    pub thinking_default: Option<String>,
    pub thinking_levels: Vec<ConversationThinkingLevelOption>,
    pub provider_type: String,
    pub data_flow: String,
    pub transport: String,
    pub gateway_aligned: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionListRequest {
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default, alias = "agentId")]
    pub agent_id: Option<String>,
    #[serde(default, alias = "query")]
    pub search: Option<String>,
    #[serde(default)]
    pub offset: Option<u64>,
    #[serde(default)]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionFilesRequest {
    #[serde(default)]
    pub profile: Option<String>,
    pub session_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionCreateRequest {
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default, alias = "agentId")]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionRenameRequest {
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default, alias = "sessionKey")]
    pub session_key: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

/// Official Gateway session permission modes.  Keep this separate from the
/// historical execSecurity/execAsk knobs: OpenClaw 2026.8.1 rejects those
/// retired fields on `sessions.patch`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionPermissionRequest {
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default, alias = "sessionKey")]
    pub session_key: Option<String>,
    /// `default` clears the session override; all other values are the
    /// Gateway's canonical permissionMode values.
    pub permission_mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionStateRequest {
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default, alias = "sessionKey")]
    pub session_key: Option<String>,
    #[serde(default, alias = "sessionId")]
    pub session_id: Option<String>,
    /// archive | restore | pin | unpin | mark_unread | mark_read
    pub action: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionReasoningRequest {
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default, alias = "sessionKey")]
    pub session_key: Option<String>,
    #[serde(default, alias = "reasoningLevel")]
    pub reasoning_level: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionModelRequest {
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default, alias = "sessionKey")]
    pub session_key: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionThinkingRequest {
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default, alias = "sessionKey")]
    pub session_key: Option<String>,
    #[serde(default, alias = "thinkingLevel")]
    pub thinking_level: Option<String>,
}

pub type ConversationSessionSummary = SessionDescriptor;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionListResult {
    pub sessions: Vec<ConversationSessionSummary>,
    pub total: usize,
    pub offset: Option<u64>,
    pub next_offset: Option<u64>,
    pub provider_type: String,
    pub data_flow: String,
    pub transport: String,
    pub gateway_aligned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionCreateResult {
    pub session_key: String,
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub provider_type: String,
    pub data_flow: String,
    pub transport: String,
    pub gateway_aligned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionRenameResult {
    pub session_key: String,
    pub label: String,
    pub title: String,
    pub provider_type: String,
    pub data_flow: String,
    pub transport: String,
    pub gateway_aligned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionReasoningResult {
    pub session_key: String,
    pub reasoning_level: String,
    pub provider_type: String,
    pub data_flow: String,
    pub transport: String,
    pub gateway_aligned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionModelResult {
    pub session_key: String,
    pub model: Option<String>,
    pub provider_type: String,
    pub data_flow: String,
    pub transport: String,
    pub gateway_aligned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSessionThinkingResult {
    pub session_key: String,
    pub thinking_level: Option<String>,
    pub provider_type: String,
    pub data_flow: String,
    pub transport: String,
    pub gateway_aligned: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationThinkingLevelOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationGatewayEvent {
    conversation_id: Option<String>,
    session_key: String,
    run_id: Option<String>,
    state: String,
    content: Option<String>,
    is_reasoning: bool,
    reasoning_content: Option<String>,
    error_message: Option<String>,
    seq: Option<u64>,
    created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GatewayConnectPreview {
    pub ws_url: String,
    pub auth_mode: String,
    pub role: String,
    pub scopes: Vec<String>,
    pub challenge_nonce: String,
    pub challenge_ts: Option<u64>,
    pub signature_payload_version: String,
    pub signature_hex_preview: String,
    pub connect_request_preview: Value,
}

#[derive(Debug, Clone)]
struct PreparedGatewayConnect {
    preview: GatewayConnectPreview,
    connect_request: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct GatewayConnectAttemptResult {
    pub success: bool,
    pub hello_ok: bool,
    pub protocol: Option<u32>,
    pub server_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conn_id: Option<String>,
    pub device_token_issued: bool,
    pub used_cached_device_token: bool,
    pub retry_attempted_with_cached_device_token: bool,
    pub recommended_next_step: Option<String>,
    pub can_retry_with_device_token: bool,
    pub error_message: Option<String>,
    pub error_code: Option<String>,
    pub error_reason: Option<String>,
    pub gateway_error: Option<UniopcGatewayError>,
    pub response_preview: Option<Value>,
    pub preview: GatewayConnectPreview,
}

#[derive(Debug, Clone, Serialize)]
pub struct GatewayPairingStatus {
    pub pending_requests: Vec<Value>,
    pub paired_devices: Vec<Value>,
    pub raw: Option<Value>,
    pub output_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GatewayPairingApprovalResult {
    pub approved: bool,
    pub request_id: Option<String>,
    pub raw: Option<Value>,
    pub output_preview: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfilePairingRequest {
    pub profile: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfileRemoteSetupRequest {
    pub profile: String,
    #[serde(default)]
    pub gateway_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfileRedeemRemoteSetupRequest {
    pub profile: String,
    pub setup_code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfileRemoteSetupResult {
    pub profile: String,
    pub setup_code: String,
    pub gateway_url: String,
    pub raw: Option<Value>,
    pub output_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfileRedeemRemoteSetupResult {
    pub profile: String,
    pub gateway_url: String,
    pub success: bool,
    pub hello_ok: bool,
    pub device_token_issued: bool,
    pub response_preview: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpenClawPairingSetup {
    gateway_url: String,
    bootstrap_token: String,
}

fn gateway_output_preview(value: &Value) -> Option<String> {
    serde_json::to_string_pretty(value).ok()
}

fn parse_json_object_from_mixed_output(output: &str) -> Option<Value> {
    output
        .char_indices()
        .filter_map(|(index, ch)| (ch == '{').then_some(index))
        .rev()
        .find_map(|index| serde_json::from_str::<Value>(&output[index..]).ok())
}

fn extract_object_array(value: &Value, keys: &[&str]) -> Vec<Value> {
    for key in keys {
        if let Some(items) = value.get(*key).and_then(Value::as_array) {
            return items.clone();
        }
    }
    Vec::new()
}

fn json_trimmed_string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn gateway_thinking_levels_from_value(value: &Value) -> Vec<ConversationThinkingLevelOption> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            if let Some(text) = item.as_str().map(str::trim).filter(|text| !text.is_empty()) {
                return Some(ConversationThinkingLevelOption {
                    id: text.to_string(),
                    label: text.to_string(),
                });
            }
            let id = json_trimmed_string_at(item, &["id"])
                .or_else(|| json_trimmed_string_at(item, &["value"]))?;
            let label = json_trimmed_string_at(item, &["label"]).unwrap_or(id);
            Some(ConversationThinkingLevelOption {
                id: id.to_string(),
                label: label.to_string(),
            })
        })
        .collect()
}

fn gateway_session_snapshot_from_sessions_list(
    sessions_value: &Value,
    session_key: &str,
) -> Option<Value> {
    let sessions = sessions_value.get("sessions")?.as_array()?;
    sessions
        .iter()
        .find(|session| {
            json_trimmed_string_at(session, &["key"])
                .map(|key| key == session_key)
                .unwrap_or(false)
        })
        .cloned()
}

fn build_gateway_session_list_params(
    agent_id: Option<&str>,
    search: Option<&str>,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("configuredAgentsOnly".to_string(), json!(true));
    params.insert("includeUnknown".to_string(), json!(true));
    params.insert("includeGlobal".to_string(), json!(false));
    // Ask the gateway to derive a title from each session's first user message
    // (reads the first 8KB of the transcript; same flag OpenClaw's own TUI
    // passes). Without it every direct-chat session falls through to
    // `displayName`, which the engine back-fills from `origin.label` — our
    // connect handshake's client.displayName ("Uniopc Desktop") — so the whole
    // picker showed one indistinguishable name.
    params.insert("includeDerivedTitles".to_string(), json!(true));
    params.insert(
        "limit".to_string(),
        json!(limit.unwrap_or(40).clamp(1, 200)),
    );
    if let Some(agent_id) = agent_id.map(str::trim).filter(|value| !value.is_empty()) {
        params.insert("agentId".to_string(), json!(agent_id));
    }
    if let Some(search) = search.map(str::trim).filter(|value| !value.is_empty()) {
        params.insert("query".to_string(), json!(search));
        params.insert("search".to_string(), json!(search));
    }
    if let Some(offset) = offset {
        params.insert("offset".to_string(), json!(offset));
    }
    Value::Object(params)
}

fn build_gateway_session_create_params(agent_id: &str) -> Value {
    json!({
        "agentId": agent_id.trim(),
    })
}

#[cfg(test)]
fn parse_gateway_session_summary(value: &Value) -> Option<ConversationSessionSummary> {
    SessionDescriptor::from_session_value(value.clone()).ok()
}

fn parse_gateway_session_list(value: &Value) -> Result<Vec<ConversationSessionSummary>, String> {
    SessionDescriptor::from_list_payload(value.clone()).map_err(|error| error.to_string())
}

fn validate_openclaw_profile_handle(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Uniopc 引擎 profile 不能为空。".to_string());
    }
    if value.len() > 64 {
        return Err("Uniopc 引擎 profile 不能超过 64 个字符。".to_string());
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("Uniopc 引擎 profile 只能包含字母、数字、- 或 _。".to_string());
    }
    Ok(value.to_string())
}

fn base64_url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn base64_url_decode(value: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(value.trim())
        .map_err(|e| format!("解析 Uniopc 引擎 setup code 失败: {e}"))
}

fn decode_openclaw_pairing_setup_value(value: Value) -> Result<OpenClawPairingSetup, String> {
    let gateway_url = value
        .get("url")
        .and_then(Value::as_str)
        .or_else(|| value.get("gatewayUrl").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let host = value.get("host").and_then(Value::as_str)?.trim();
            if host.is_empty() {
                return None;
            }
            let port = value.get("port").and_then(Value::as_u64).unwrap_or(18790);
            let tls = value.get("tls").and_then(Value::as_bool).unwrap_or(true);
            Some(format!(
                "{}://{}:{port}",
                if tls { "wss" } else { "ws" },
                host
            ))
        })
        .ok_or_else(|| "Uniopc 引擎 setup code 缺少 gateway url。".to_string())?;
    let bootstrap_token = value
        .get("bootstrapToken")
        .and_then(Value::as_str)
        .or_else(|| value.get("bootstrap_token").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Uniopc 引擎 setup code 缺少 bootstrapToken。".to_string())?;
    Ok(OpenClawPairingSetup {
        gateway_url,
        bootstrap_token: bootstrap_token.to_string(),
    })
}

fn decode_openclaw_gateway_deep_link(input: &str) -> Result<OpenClawPairingSetup, String> {
    let query = input
        .split_once('?')
        .map(|(_, query)| query)
        .ok_or_else(|| "Uniopc 引擎 gateway deep link 缺少查询参数。".to_string())?;
    let mut payload = serde_json::Map::new();
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let key = urlencoding::decode(key)
            .map_err(|e| format!("解析 Uniopc 引擎 gateway deep link key 失败: {e}"))?
            .to_string();
        let value = urlencoding::decode(value)
            .map_err(|e| format!("解析 Uniopc 引擎 gateway deep link value 失败: {e}"))?
            .to_string();
        match key.as_str() {
            "url" | "gatewayUrl" | "bootstrapToken" | "bootstrap_token" | "host" => {
                payload.insert(key, Value::String(value));
            }
            "port" => {
                if let Ok(port) = value.parse::<u64>() {
                    payload.insert(key, json!(port));
                }
            }
            "tls" => {
                payload.insert(key, json!(matches!(value.as_str(), "1" | "true" | "yes")));
            }
            _ => {}
        }
    }
    decode_openclaw_pairing_setup_value(Value::Object(payload))
}

fn extract_openclaw_setup_code_input(input: &str) -> String {
    let trimmed = input.trim();
    if let Some(start) = trimmed.find("openclaw://gateway") {
        return trimmed[start..]
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches(|ch| ch == '"' || ch == '\'')
            .to_string();
    }
    for line in trimmed.lines() {
        let line = line.trim();
        for label in [
            "Setup code:",
            "setupCode:",
            "setup_code:",
            "授权码：",
            "授权码:",
        ] {
            if let Some(rest) = line.strip_prefix(label) {
                return rest.trim().to_string();
            }
        }
    }
    trimmed.to_string()
}

fn decode_openclaw_pairing_setup_code(setup_code: &str) -> Result<OpenClawPairingSetup, String> {
    let input = extract_openclaw_setup_code_input(setup_code);
    if input.starts_with("openclaw://gateway") {
        return decode_openclaw_gateway_deep_link(&input);
    }
    if input.starts_with('{') {
        let value: Value = serde_json::from_str(&input)
            .map_err(|e| format!("解析 Uniopc 引擎 setup code JSON 失败: {e}"))?;
        return decode_openclaw_pairing_setup_value(value);
    }
    let bytes = base64_url_decode(&input)?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("解析 Uniopc 引擎 setup code JSON 失败: {e}"))?;
    decode_openclaw_pairing_setup_value(value)
}

fn gateway_url_scheme_and_host(gateway_url: &str) -> Result<(&'static str, String), &'static str> {
    let raw = gateway_url.trim();
    if raw.is_empty() {
        return Err("missing");
    }
    let (scheme, rest) = if let Some(rest) = raw.strip_prefix("ws://") {
        ("ws", rest)
    } else if let Some(rest) = raw.strip_prefix("wss://") {
        ("wss", rest)
    } else {
        return Err("invalid_scheme");
    };
    let authority = rest.split('/').next().unwrap_or_default().trim();
    if authority.is_empty() {
        return Err("invalid");
    }
    let host = if let Some(without_open) = authority.strip_prefix('[') {
        without_open
            .split(']')
            .next()
            .unwrap_or_default()
            .to_string()
    } else {
        authority
            .split('@')
            .last()
            .unwrap_or(authority)
            .split(':')
            .next()
            .unwrap_or_default()
            .to_string()
    };
    let host = host
        .trim()
        .trim_matches(|ch| ch == '[' || ch == ']')
        .to_lowercase();
    if host.is_empty() {
        return Err("invalid");
    }
    Ok((scheme, host))
}

fn is_loopback_gateway_host(host: &str) -> bool {
    host == "localhost" || host == "::1" || host == "0:0:0:0:0:0:0:1" || host.starts_with("127.")
}

fn is_private_gateway_host(host: &str) -> bool {
    if host.ends_with(".local") || host.starts_with("10.") || host.starts_with("192.168.") {
        return true;
    }
    if host.starts_with("169.254.") || host.starts_with("fe80:") {
        return true;
    }
    if host.starts_with("fc") || host.starts_with("fd") {
        return true;
    }
    let octets = host
        .split('.')
        .filter_map(|part| part.parse::<u8>().ok())
        .collect::<Vec<_>>();
    if octets.len() != 4 {
        return false;
    }
    (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
}

fn remote_setup_gateway_url_issue(gateway_url: &str) -> Option<&'static str> {
    let (scheme, host) = match gateway_url_scheme_and_host(gateway_url) {
        Ok(parsed) => parsed,
        Err(issue) => return Some(issue),
    };
    if scheme == "wss" {
        return None;
    }
    if is_loopback_gateway_host(&host) || is_private_gateway_host(&host) {
        return None;
    }
    Some("remote_cleartext")
}

fn remote_setup_gateway_url_error(issue: &str) -> String {
    match issue {
        "missing" => "Uniopc 引擎 setup code 缺少 Gateway URL。".to_string(),
        "invalid_scheme" => "Uniopc 引擎 URL 必须使用 ws:// 或 wss://。".to_string(),
        "remote_cleartext" => {
            "远程 Uniopc 引擎 不能使用公网明文 ws://，请使用 wss://、Tailscale Serve/Funnel、SSH tunnel 或局域网地址。".to_string()
        }
        _ => "Uniopc 引擎 URL 无效。".to_string(),
    }
}

fn encode_openclaw_pairing_setup_code(gateway_url: &str, bootstrap_token: &str) -> String {
    base64_url_encode(
        json!({
            "url": gateway_url,
            "bootstrapToken": bootstrap_token,
        })
        .to_string()
        .as_bytes(),
    )
}

fn extract_text_content(value: &Value) -> Option<String> {
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(text.to_string());
    }

    if let Some(items) = value.as_array() {
        let parts = items
            .iter()
            .filter_map(|item| match item.get("type").and_then(Value::as_str) {
                Some("text") => item.get("text").and_then(Value::as_str).map(str::to_string),
                _ => item.as_str().map(str::to_string),
            })
            .collect::<Vec<_>>();
        if !parts.is_empty() {
            return Some(parts.join("\n\n").trim().to_string());
        }
    }

    if value.is_object() {
        for key in ["content", "message", "text", "deltaText"] {
            if let Some(content) = value.get(key).and_then(extract_text_content) {
                return Some(content);
            }
        }
        if let Some(content) = value
            .get("data")
            .and_then(|data| data.get("text"))
            .and_then(extract_text_content)
        {
            return Some(content);
        }
    }

    None
}

fn is_internal_context_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with(INTERNAL_CONTEXT_MARKER)
        || trimmed.contains(&format!("\n{INTERNAL_CONTEXT_MARKER}"))
        || trimmed.starts_with(OPENCLAW_HEARTBEAT_MARKER)
        || trimmed == OPENCLAW_HEARTBEAT_POLL_MARKER
        || trimmed.starts_with(OPENCLAW_BOOTSTRAP_PENDING_MARKER)
        || (trimmed.contains("Please read BOOTSTRAP.md")
            && trimmed.contains("Do not use a generic first greeting"))
}

fn map_gateway_history_messages(messages: &[Value]) -> Vec<ConversationHistoryMessage> {
    let mapped = messages
        .iter()
        .filter_map(|message| {
            let payload = gateway_history_message_payload(message);
            let role = gateway_history_message_role(message, payload)?.to_string();
            if role != "user" && role != "assistant" && role != "system" {
                return None;
            }
            let (media_paths, media_types) = gateway_history_message_media(message, payload);
            // A user turn that is nothing but an image has no text at all. Such
            // a message must still survive, or the attachment disappears with
            // it — so only bail on "no text AND no media".
            let raw_content = match gateway_history_message_content(message, payload) {
                Some(content) => content,
                None if !media_paths.is_empty() => String::new(),
                None => return None,
            };
            let content = if role == "user" {
                visible_user_message_from_context(&raw_content).unwrap_or(raw_content)
            } else {
                raw_content
            };
            if is_internal_context_text(&content) {
                return None;
            }
            let created_at = gateway_history_message_timestamp(message, payload).unwrap_or(0);
            let id = gateway_history_message_id(message, payload)
                .map(str::to_string)
                .unwrap_or_else(|| format!("gateway-{role}-{created_at}"));

            Some(ConversationHistoryMessage {
                id,
                role,
                content,
                created_at,
                media_paths,
                media_types,
                idempotency_key: gateway_history_message_idempotency_key(message, payload),
            })
        })
        .collect();
    normalize_gateway_assistant_error_fallbacks(mapped)
}

fn normalize_gateway_assistant_error_fallbacks(
    messages: Vec<ConversationHistoryMessage>,
) -> Vec<ConversationHistoryMessage> {
    let mut superseded_fallback_ids = HashSet::new();
    let mut pending_fallback_ids = Vec::new();

    let messages = messages
        .into_iter()
        .map(|mut message| {
            if message.role == "user" {
                // A later user turn starts a new response boundary. Its prior
                // fallback remains useful if the prior turn really did fail.
                pending_fallback_ids.clear();
                return message;
            }
            if message.role != "assistant" {
                return message;
            }

            let trimmed = message.content.trim();
            let mut reply = trimmed;
            let mut stripped_failure_markers = 0usize;
            // The upstream stream fallback can be repeated when a response is
            // recovered after more than one interrupted stream. Strip *all*
            // leading copies: leaving even one in the persisted transcript
            // makes it visible to the user and, worse, lets a later model turn
            // mistake an old transport failure for the current engine state.
            while let Some(rest) = reply.strip_prefix(OPENCLAW_STREAM_FAILURE_MARKER) {
                stripped_failure_markers += 1;
                reply = rest.trim_start();
            }
            if (stripped_failure_markers > 0 && reply.is_empty())
                || trimmed == OPENCLAW_STREAM_FAILURE_FALLBACK
            {
                pending_fallback_ids.push(message.id.clone());
                return message;
            }

            if stripped_failure_markers > 0 {
                message.content = reply.to_string();
            }
            if !message.content.trim().is_empty() {
                superseded_fallback_ids.extend(pending_fallback_ids.drain(..));
            }
            message
        })
        .collect::<Vec<_>>();

    messages
        .into_iter()
        .filter(|message| !superseded_fallback_ids.contains(&message.id))
        .collect()
}

fn gateway_history_message_payload(message: &Value) -> &Value {
    message
        .get("message")
        .filter(|value| {
            value.is_object()
                && (value.get("role").is_some()
                    || value.get("content").is_some()
                    || value.get("text").is_some())
        })
        .unwrap_or(message)
}

fn gateway_history_message_role<'a>(message: &'a Value, payload: &'a Value) -> Option<&'a str> {
    message
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| payload.get("role").and_then(Value::as_str))
}

/// Pull the engine's persisted attachment references off a history message.
///
/// The gateway writes every inbound image to `state/<profile>/media/inbound/`
/// and records the absolute paths on the message envelope as **capitalized**
/// siblings of `content` — `MediaPaths` (array) or the older singular
/// `MediaPath`, with `MediaTypes` / `MediaType` alongside. They are not content
/// blocks: `content` stays a plain string for user turns, which is why reading
/// only `content` loses the image entirely.
///
/// Assistant-produced media is different: the final assistant block may carry
/// only a gateway-relative playback URL, while `openclawDelivery.mediaUrls`
/// preserves the corresponding local file path.  Prefer that local delivery
/// record when no `MediaPaths` envelope is present so a generated video still
/// reaches the Tauri asset protocol after a history refresh.
///
/// Mime types are positional, so a short/absent `MediaTypes` is padded rather
/// than left to misalign against the paths.
fn gateway_history_message_media(message: &Value, payload: &Value) -> (Vec<String>, Vec<String>) {
    fn strings_at<'a>(sources: [&'a Value; 2], plural: &str, singular: &str) -> Vec<String> {
        for source in sources {
            if let Some(items) = source.get(plural).and_then(Value::as_array) {
                let values = items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                if !values.is_empty() {
                    return values;
                }
            }
            if let Some(value) = source
                .get(singular)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return vec![value.to_string()];
            }
        }
        Vec::new()
    }

    let sources = [payload, message];
    let mut paths = strings_at(sources, "MediaPaths", "MediaPath");
    if paths.is_empty() {
        for source in sources {
            let Some(urls) = source
                .get("openclawDelivery")
                .and_then(|delivery| delivery.get("mediaUrls"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            paths = urls
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                // A relative gateway URL cannot be opened by the WebView asset
                // protocol. The delivery record is useful precisely because it
                // retains the local, absolute media path.
                .filter(|value| value.starts_with('/'))
                .map(str::to_string)
                .collect();
            if !paths.is_empty() {
                break;
            }
        }
    }
    if paths.is_empty() {
        // `chat.history` sanitizes the delivery record on some gateway builds,
        // but leaves the final structured video block intact. Its outbound copy
        // has a stable `<fileName>---<delivery id>` name under this profile.
        let media_root =
            crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(None)
                .ok()
                .map(|state| state.join("media").join("outbound"));
        if let Some(media_root) = media_root.filter(|root| root.is_dir()) {
            for source in sources {
                let Some(blocks) = source.get("content").and_then(Value::as_array) else {
                    continue;
                };
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("video") {
                        continue;
                    }
                    let Some(file_name) = block.get("fileName").and_then(Value::as_str) else {
                        continue;
                    };
                    let file_name = file_name.trim();
                    if file_name.is_empty() || file_name.contains('/') || file_name.contains('\\') {
                        continue;
                    }
                    let Some((stem, extension)) = file_name.rsplit_once('.') else {
                        continue;
                    };
                    let prefix = format!("{stem}---");
                    if let Ok(entries) = fs::read_dir(&media_root) {
                        for entry in entries.flatten() {
                            let candidate = entry.path();
                            let Some(name) = candidate.file_name().and_then(|name| name.to_str())
                            else {
                                continue;
                            };
                            if name.starts_with(&prefix)
                                && name.ends_with(&format!(".{extension}"))
                                && candidate.is_file()
                            {
                                paths.push(candidate.to_string_lossy().to_string());
                                break;
                            }
                        }
                    }
                    if !paths.is_empty() {
                        break;
                    }
                }
                if !paths.is_empty() {
                    break;
                }
            }
        }
    }
    if paths.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let mut types = strings_at(sources, "MediaTypes", "MediaType");
    if types.is_empty() {
        for source in sources {
            let Some(blocks) = source.get("content").and_then(Value::as_array) else {
                continue;
            };
            types = blocks
                .iter()
                .filter_map(|block| {
                    matches!(
                        block.get("type").and_then(Value::as_str),
                        Some("image") | Some("video") | Some("audio") | Some("file")
                    )
                    .then(|| {
                        block
                            .get("mimeType")
                            .or_else(|| block.get("mime_type"))
                            .and_then(Value::as_str)
                    })
                    .flatten()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                })
                .collect();
            if !types.is_empty() {
                break;
            }
        }
    }
    types.resize(paths.len(), String::new());
    (paths, types)
}

fn gateway_history_message_content(message: &Value, payload: &Value) -> Option<String> {
    payload
        .get("content")
        .and_then(extract_text_content)
        .or_else(|| payload.get("message").and_then(extract_text_content))
        .or_else(|| payload.get("text").and_then(extract_text_content))
        .or_else(|| payload.get("deltaText").and_then(extract_text_content))
        .or_else(|| {
            payload
                .get("data")
                .and_then(|data| data.get("text"))
                .and_then(extract_text_content)
        })
        .or_else(|| {
            if std::ptr::eq(message, payload) {
                None
            } else {
                extract_text_content(payload)
            }
        })
        .or_else(|| extract_text_content(message))
}

fn visible_user_message_from_context(text: &str) -> Option<String> {
    [USER_ORIGINAL_MESSAGE_MARKER, LEGACY_USER_MESSAGE_MARKER]
        .iter()
        .find_map(|marker| {
            let (_, visible) = text.split_once(marker)?;
            let visible = visible.trim();
            (!visible.is_empty()).then(|| visible.to_string())
        })
}

fn gateway_history_message_id<'a>(message: &'a Value, payload: &'a Value) -> Option<&'a str> {
    message
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| payload.get("id").and_then(Value::as_str))
        .or_else(|| payload.get("messageId").and_then(Value::as_str))
}

fn gateway_history_message_idempotency_key(message: &Value, payload: &Value) -> Option<String> {
    ["idempotencyKey", "idempotency_key"]
        .iter()
        .find_map(|key| {
            payload
                .get(*key)
                .or_else(|| message.get(*key))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn gateway_history_message_timestamp(message: &Value, payload: &Value) -> Option<u64> {
    ["timestamp", "createdAt", "created_at"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(timestamp_value_as_millis))
        .or_else(|| {
            ["timestamp", "createdAt", "created_at"]
                .iter()
                .find_map(|key| message.get(*key).and_then(timestamp_value_as_millis))
        })
}

fn timestamp_value_as_millis(value: &Value) -> Option<u64> {
    if let Some(value) = value.as_u64() {
        return Some(value);
    }
    if let Some(value) = value.as_i64().filter(|value| *value >= 0) {
        return Some(value as u64);
    }
    if let Some(value) = value.as_f64().filter(|value| *value >= 0.0) {
        return Some(value as u64);
    }
    let text = value.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    text.parse::<u64>().ok().or_else(|| {
        chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .and_then(|timestamp| timestamp.timestamp_millis().try_into().ok())
    })
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct GatewayAssistantSnapshot {
    content: String,
    fingerprint: String,
}

#[cfg(test)]
fn latest_assistant_reply_snapshot(messages: &[Value]) -> Option<GatewayAssistantSnapshot> {
    messages.iter().rev().find_map(|message| {
        let payload = gateway_history_message_payload(message);
        if gateway_history_message_role(message, payload) != Some("assistant") {
            return None;
        }
        let content = gateway_history_message_content(message, payload)?;
        if content.trim().is_empty() || is_internal_context_text(&content) {
            return None;
        }
        let fingerprint = serde_json::to_string(message).unwrap_or_else(|_| {
            format!(
                "{}:{}:{}",
                message.get("id").and_then(Value::as_str).unwrap_or(""),
                message
                    .get("timestamp")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                content
            )
        });
        Some(GatewayAssistantSnapshot {
            content,
            fingerprint,
        })
    })
}

/// True when `id` is a single, path-safe segment. Real employee ids are slugs
/// (`slugify_employee_id` → `[a-z0-9-]`) plus the reserved `main`, so this only
/// rejects a hostile `session_key` whose agent segment carries traversal
/// (`agent:../../../../etc:x`) before it is joined into a `sessions` path.
fn is_path_safe_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains('\0')
        && !id.contains("..")
}

fn infer_employee_id_from_session_key(session_key: &str) -> Option<String> {
    let mut parts = session_key.split(':');
    match (parts.next(), parts.next()) {
        (Some("agent"), Some(employee_id)) if is_path_safe_agent_id(employee_id.trim()) => {
            Some(employee_id.trim().to_string())
        }
        _ => None,
    }
}

fn validate_requested_session_agent(
    requested_key: Option<&str>,
    requested_agent_id: Option<&str>,
) -> Result<(), String> {
    let Some(session_key) = requested_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let Some(agent_id) = requested_agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let session_agent_id = infer_employee_id_from_session_key(session_key)
        .ok_or_else(|| "员工对话的会话 ID 无效。请重新打开该员工后再发送。".to_string())?;
    if session_agent_id != agent_id {
        return Err(format!(
            "会话不属于员工 `{agent_id}`，已阻止发送到 `{session_agent_id}` 的会话。"
        ));
    }
    Ok(())
}

#[cfg(test)]
fn resolve_conversation_project_id(
    explicit_project_id: Option<&str>,
    _session_key: &str,
) -> String {
    explicit_project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DIRECT_CONVERSATION_PROJECT_ID.to_string())
}

#[cfg(test)]
fn merge_current_user_message(
    mut messages: Vec<ConversationHistoryMessage>,
    session_key: &str,
    input: &str,
    created_at: u64,
) -> Vec<ConversationHistoryMessage> {
    let normalized_input = input.trim();
    if normalized_input.is_empty() {
        return messages;
    }

    let has_visible_user_turn = messages.iter().any(|message| {
        message.role == "user"
            && message.created_at >= created_at.saturating_sub(5_000)
            && message.content.trim() == normalized_input
    });
    if !has_visible_user_turn {
        let hash = hex::encode(Sha256::digest(
            format!("{session_key}:{created_at}:{normalized_input}").as_bytes(),
        ));
        messages.push(ConversationHistoryMessage {
            id: format!("uniopc-user-{hash}"),
            role: "user".to_string(),
            content: normalized_input.to_string(),
            created_at,
            // Synthesized from the text we just sent, not from the engine, so
            // it has no persisted media of its own. The optimistic message in
            // the UI still carries the local preview.
            media_paths: Vec::new(),
            media_types: Vec::new(),
            idempotency_key: None,
        });
    }

    messages.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    messages
}

fn conversation_message_signature(message: &ConversationHistoryMessage) -> String {
    format!(
        "{}\u{0}{}\u{0}{}",
        message.role,
        message.created_at,
        message.content.trim()
    )
}

fn merge_conversation_history_messages(
    mut messages: Vec<ConversationHistoryMessage>,
    extra_messages: Vec<ConversationHistoryMessage>,
) -> Vec<ConversationHistoryMessage> {
    for message in extra_messages {
        if message.content.trim().is_empty() {
            continue;
        }
        let signature = conversation_message_signature(&message);
        if let Some(existing) = messages.iter_mut().find(|existing| {
            existing.id == message.id || conversation_message_signature(existing) == signature
        }) {
            // `chat.history` can omit attachment metadata even when the local
            // transcript still has it. Deduplication must preserve the richer
            // copy of a matching message instead of dropping its media paths.
            for (index, path) in message.media_paths.into_iter().enumerate() {
                if path.trim().is_empty() {
                    continue;
                }
                let mime_type = message.media_types.get(index).cloned().unwrap_or_default();
                if let Some(existing_index) =
                    existing.media_paths.iter().position(|item| item == &path)
                {
                    if existing
                        .media_types
                        .get(existing_index)
                        .is_none_or(String::is_empty)
                        && !mime_type.is_empty()
                    {
                        if existing.media_types.len() <= existing_index {
                            existing
                                .media_types
                                .resize(existing_index + 1, String::new());
                        }
                        existing.media_types[existing_index] = mime_type;
                    }
                    continue;
                }
                existing.media_paths.push(path);
                existing.media_types.push(mime_type);
            }
            if existing.idempotency_key.is_none() {
                existing.idempotency_key = message.idempotency_key;
            }
            continue;
        }
        messages.push(message);
    }

    messages.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    messages
}

fn load_usage_family_history_from_sessions_dir(
    sessions_dir: &Path,
    session_key: &str,
) -> Result<Vec<ConversationHistoryMessage>, String> {
    let sessions_path = sessions_dir.join("sessions.json");
    if !sessions_path.exists() {
        return Ok(Vec::new());
    }

    let text = fs::read_to_string(&sessions_path)
        .map_err(|e| format!("读取 Uniopc 引擎 sessions.json 失败: {e}"))?;
    let root: Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析 Uniopc 引擎 sessions.json 失败: {e}"))?;
    let Some(record) = root.get(session_key) else {
        return Ok(Vec::new());
    };

    let mut session_ids = record
        .get("usageFamilySessionIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(session_id) = record
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !session_ids.iter().any(|value| value == session_id) {
            session_ids.push(session_id.to_string());
        }
    }

    let mut messages = Vec::new();
    for session_id in session_ids {
        let mut files = session_transcript_files(sessions_dir, &session_id)?;
        files.sort();
        for file in files {
            let transcript = load_gateway_transcript_messages(&file)?;
            messages = merge_conversation_history_messages(messages, transcript);
        }
    }
    Ok(messages)
}

fn openclaw_agent_sessions_dir_for_profile(
    profile: Option<&str>,
    agent_id: Option<&str>,
) -> Result<PathBuf, String> {
    let profile_state_dir =
        crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(profile)?;
    let agent_id = agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("main");
    Ok(profile_state_dir
        .join("agents")
        .join(agent_id)
        .join("sessions"))
}

fn clear_session_model_overrides_from_sessions_dir(
    sessions_dir: &Path,
    session_key: &str,
) -> Result<bool, String> {
    let sessions_path = sessions_dir.join("sessions.json");
    if !sessions_path.exists() {
        return Ok(false);
    }

    let text = fs::read_to_string(&sessions_path)
        .map_err(|e| format!("读取 Uniopc 引擎 sessions.json 失败: {e}"))?;
    let mut root: Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析 Uniopc 引擎 sessions.json 失败: {e}"))?;
    let Some(record) = root.get_mut(session_key).and_then(Value::as_object_mut) else {
        return Ok(false);
    };

    let root_override_fields = [
        "modelOverrideFallbackOriginProvider",
        "modelOverrideFallbackOriginModel",
        "authProfileOverride",
        "authProfileOverrideSource",
        "authProfileOverrideCompactionCount",
    ];
    let nested_override_fields = [
        "providerOverride",
        "modelOverride",
        "modelOverrideSource",
        "modelOverrideFallbackOriginProvider",
        "modelOverrideFallbackOriginModel",
        "authProfileOverride",
        "authProfileOverrideSource",
        "authProfileOverrideCompactionCount",
    ];
    let mut changed = false;
    for field in root_override_fields {
        changed = record.remove(field).is_some() || changed;
    }
    for nested_field in ["systemPromptReport", "agentMeta", "contextBudgetStatus"] {
        if let Some(nested) = record.get_mut(nested_field).and_then(Value::as_object_mut) {
            for field in nested_override_fields {
                changed = nested.remove(field).is_some() || changed;
            }
            for field in ["modelProvider", "model", "provider"] {
                changed = nested.remove(field).is_some() || changed;
            }
        }
    }

    if changed {
        let next_text = serde_json::to_string_pretty(&root)
            .map_err(|e| format!("序列化 Uniopc 引擎 sessions.json 失败: {e}"))?;
        fs::write(&sessions_path, format!("{next_text}\n"))
            .map_err(|e| format!("写入 Uniopc 引擎 sessions.json 失败: {e}"))?;
    }

    Ok(changed)
}

async fn clear_local_session_model_overrides(
    profile: Option<&str>,
    session_key: &str,
) -> Result<(), String> {
    let agent_id = infer_employee_id_from_session_key(session_key);
    let sessions_dir = openclaw_agent_sessions_dir_for_profile(profile, agent_id.as_deref())?;
    clear_session_model_overrides_from_sessions_dir(&sessions_dir, session_key).map(|_| ())
}

fn session_transcript_files(sessions_dir: &Path, session_id: &str) -> Result<Vec<PathBuf>, String> {
    let reset_prefix = format!("{session_id}.jsonl.reset.");
    let current_name = format!("{session_id}.jsonl");
    let mut reset_files = Vec::new();
    let mut current_file = None;

    let entries = match fs::read_dir(sessions_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取 Uniopc 引擎 session 目录失败: {error}")),
    };

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取 Uniopc 引擎 session 文件失败: {e}"))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name == current_name {
            current_file = Some(path);
        } else if name.starts_with(&reset_prefix) {
            reset_files.push(path);
        }
    }

    reset_files.sort();
    if let Some(path) = current_file {
        reset_files.push(path);
    }
    Ok(reset_files)
}

fn load_gateway_transcript_messages(
    path: &Path,
) -> Result<Vec<ConversationHistoryMessage>, String> {
    let text =
        fs::read_to_string(path).map_err(|e| format!("读取 Uniopc 引擎 transcript 失败: {e}"))?;
    let raw_messages = text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let value = serde_json::from_str::<Value>(line).ok()?;
            let is_message = value
                .get("type")
                .and_then(Value::as_str)
                .map(|value| value == "message")
                .unwrap_or_else(|| value.get("role").is_some() || value.get("message").is_some());
            is_message.then_some(value)
        })
        .collect::<Vec<_>>();
    Ok(map_gateway_history_messages(&raw_messages))
}

fn load_local_gateway_usage_family_history(
    profile: &str,
    session_key: &str,
) -> Result<Vec<ConversationHistoryMessage>, String> {
    let Some(agent_id) = infer_employee_id_from_session_key(session_key) else {
        return Ok(Vec::new());
    };
    let config_path = openclaw_gateway::openclaw_config_path_for_profile(Some(profile))?;
    let Some(profile_dir) = config_path.parent() else {
        return Ok(Vec::new());
    };
    let sessions_dir = profile_dir.join("agents").join(agent_id).join("sessions");
    load_usage_family_history_from_sessions_dir(&sessions_dir, session_key)
}

fn mention_context(mentions: &[ConversationMention]) -> Option<String> {
    let mut mention_lines = Vec::new();
    let mut invocation_lines = Vec::new();
    let mut seen_mentions = std::collections::HashSet::new();
    let mut seen_invocations = std::collections::HashSet::new();
    for mention in mentions {
        let kind = mention.kind.trim();
        let name = mention.name.trim();
        if name.is_empty() {
            continue;
        }
        let key = format!("{kind}:{name}");
        if mention.trigger.as_deref() == Some("slash") {
            let label = match kind {
                "plugin" => "Uniopc 引擎 plugin",
                "skill" => "Skill",
                "mcp" => "MCP server",
                _ => continue,
            };
            if seen_invocations.insert(key) {
                invocation_lines.push(format!("- {label}: `{name}`"));
            }
        } else if matches!(kind, "project" | "doc") && seen_mentions.insert(key) {
            let label = if kind == "project" {
                "Project"
            } else {
                "Document"
            };
            let display = mention
                .label
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(name);
            if matches!(kind, "project" | "doc") && display != name {
                mention_lines.push(format!("- {label}: `{display}` (`{name}`)"));
            } else {
                mention_lines.push(format!("- {label}: `{name}`"));
            }
        }
    }
    if mention_lines.is_empty() && invocation_lines.is_empty() {
        return None;
    }
    let mut sections = Vec::new();
    if !mention_lines.is_empty() {
        sections.push(
            [
                "用户本轮显式 @ 了以下项目/文档上下文：".to_string(),
                mention_lines.join("\n"),
                "请优先按这些 @ 引用理解用户上下文；项目或文档不可用时，说明原因并给出替代方案。"
                    .to_string(),
            ]
            .join("\n"),
        );
    }
    if !invocation_lines.is_empty() {
        sections.push(
            [
                "用户本轮显式 / 调用了以下已安装能力：".to_string(),
                invocation_lines.join("\n"),
                "请把这些 / 调用视为用户明确要求使用的能力。能力既可能是工具，也可能是已加载的 Skill；以本轮附带的能力说明为准，不能仅因没有同名工具就判定不可用。"
                    .to_string(),
            ]
            .join("\n"),
        );
    }
    Some(sections.join("\n\n"))
}

/// Turn a selected skills-only plugin into an explicit per-turn instruction.
///
/// A slash invocation reaches the model as ordinary user text; unlike a tool,
/// it is not present in the Gateway's tool list.  Without this bridge the
/// model sees `/plugin:uniopc-documents`, looks for a same-named tool, and
/// incorrectly concludes that DOCX/PDF support is unavailable.  Keep this
/// derived from the verified capability snapshot, never from client input.
fn skill_pack_invocation_context(
    tool_invocations: &[ConversationToolInvocation],
    capabilities: &openclaw_plugins::OpenClawProfileToolCapabilitiesSnapshot,
) -> Option<String> {
    let mut lines = Vec::new();
    let mut seen = HashSet::new();

    for invocation in tool_invocations {
        if invocation
            .tool_name
            .as_deref()
            .is_some_and(|name| !name.trim().is_empty())
        {
            continue;
        }
        let plugin_id = invocation.plugin_id.trim();
        if plugin_id.is_empty() || !seen.insert(plugin_id.to_string()) {
            continue;
        }
        let Some(plugin) = capabilities
            .plugins
            .iter()
            .find(|plugin| plugin.id == plugin_id)
        else {
            continue;
        };
        if plugin.status != "ready" || !plugin.has_skills || plugin.skill_names.is_empty() {
            continue;
        }
        lines.push(format!(
            "- `{}` 是已就绪的技能包，已加载 Skill：{}。它没有同名工具是正常设计；直接使用匹配的 Skill 完成用户任务，不要改用不相关的本地 Markdown 文档工具，也不要声称它不可用。",
            plugin.id,
            plugin
                .skill_names
                .iter()
                .map(|name| format!("`{name}`"))
                .collect::<Vec<_>>()
                .join("、"),
        ));
    }

    (!lines.is_empty()).then(|| {
        [
            "本轮 / 调用的技能包执行说明（内部）：".to_string(),
            lines.join("\n"),
            "Skill 是已经注入你上下文的可执行工作流，不是也不需要是一个同名工具；不要在工具清单中查找 Skill、不要等待额外工具、更不能要求用户自行运行 pandoc。用户明确要求 `.docx` 时，直接按 `docx` Skill 的工作流，使用现有 coding/执行能力创建或编辑真实 Word 文件；用户明确要求 PDF 时，直接按 `pdf` Skill 执行。"
                .to_string(),
        ]
        .join("\n")
    })
}

fn explicit_document_mention_ids(mentions: &[ConversationMention]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    mentions
        .iter()
        .filter(|mention| mention.kind.trim().eq_ignore_ascii_case("doc"))
        .filter_map(|mention| {
            let id = mention.name.trim();
            (!id.is_empty() && seen.insert(id.to_string())).then(|| id.to_string())
        })
        .collect()
}

fn direct_local_workspace_access_requested(
    tool_invocations: &[ConversationToolInvocation],
) -> bool {
    tool_invocations.iter().any(|invocation| {
        invocation.plugin_id.trim() == "uniopc-local-workspace"
            && invocation.trigger.as_deref().map(str::trim) == Some("slash")
    })
}

fn direct_document_generation_requested(tool_invocations: &[ConversationToolInvocation]) -> bool {
    tool_invocations.iter().any(|invocation| {
        invocation.plugin_id.trim() == "uniopc-documents"
            && invocation.trigger.as_deref().map(str::trim) == Some("slash")
    })
}

fn browser_runtime_context(snapshot: Option<&openclaw_browser::BrowserRuntimeSnapshot>) -> String {
    let Some(snapshot) = snapshot else {
        return "Uniopc Browser Runtime 状态：\n- 状态：未检测\n- 自动浏览器规则：如果用户要求打开、查看、点击或输入网页，不要使用系统默认浏览器；先说明需要到运行中心刷新 Browser Runtime。".to_string();
    };
    let pending_count = snapshot.pending_requests.len();
    let tab_count = snapshot.tabs.len();
    let profile_count = snapshot.profiles.len();
    let error = snapshot
        .error
        .as_ref()
        .map(|error| format!("{}: {}", error.kind, error.message))
        .unwrap_or_else(|| "无".to_string());
    let browser_rule = if snapshot.status == "gateway_browser_rpc_unsupported" {
        "自动浏览器规则：当前 Gateway 没有可调用的 browser tool。不要声称你已打开、查看、点击或输入网页；请到运行中心修复并开启浏览器控制并重启引擎后重新检测。"
    } else {
        "自动浏览器规则：如果用户要求打开、查看、点击或输入网页，必须优先使用官方 Uniopc 引擎 browser tool，不能改用系统默认浏览器、open 命令或外部浏览器。使用 target=host、profile=openclaw，这是本工作区的隔离专用浏览器。状态 stopped 时先调用 browser action=start，再 status，确认 running/cdpReady 后继续；ready 时可直接操作。其他错误停止继续自动化并说明错误和对应恢复动作：disabled/策略缺失到运行中心修复并开启，scope upgrade pending approval 到运行中心批准权限，连接故障重新启动并检测。不要把专用浏览器与对话右侧网页视图混同。"
    };
    format!(
        "Uniopc Browser Runtime 状态：\n\
         - 状态：{}\n\
         - Enabled：{}\n\
         - 执行位置：{} ({})\n\
         - Browser profile：{}\n\
         - Profiles 数：{}\n\
         - Tabs 数：{}\n\
         - Pending pairing：{}\n\
         - Next action：{}\n\
         - Error：{}\n\n\
         {}",
        snapshot.status,
        snapshot.enabled,
        snapshot.execution_target_label,
        snapshot.execution_target,
        snapshot.browser_profile,
        profile_count,
        tab_count,
        pending_count,
        snapshot.next_action,
        error,
        browser_rule,
    )
}

fn build_gateway_user_input(
    input: &str,
    uniopc_context: Option<&str>,
    browser_runtime: Option<&openclaw_browser::BrowserRuntimeSnapshot>,
    mentions: &[ConversationMention],
) -> String {
    let visible_input = input.trim();
    let mut context_parts = Vec::new();
    if let Some(context) = uniopc_context
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        context_parts.push(context.to_string());
    }
    if browser_runtime.is_some() {
        context_parts.push(IMAI_BROWSER_AUTOMATION_CONTEXT.to_string());
        context_parts.push(browser_runtime_context(browser_runtime));
    }
    if let Some(context) = mention_context(mentions) {
        context_parts.push(context);
    }
    if context_parts.is_empty() {
        return visible_input.to_string();
    }
    let context = context_parts.join("\n\n");
    let hash = hex::encode(Sha256::digest(context.as_bytes()));
    format!("{INTERNAL_CONTEXT_MARKER}{hash}\n\n{context}\n\n用户原始消息：\n{visible_input}")
}

fn text_mentions_browser_runtime(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    [
        "browser",
        "chrome",
        "playwright",
        "webpage",
        "website",
        "tab",
        "url",
        "http://",
        "https://",
        "读取",
        "打开",
        "网页",
        "浏览器",
        "点击",
        "输入",
        "访问",
        "标签页",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn conversation_turn_needs_browser_runtime_context(
    input: &str,
    mentions: &[ConversationMention],
    tool_invocations: &[ConversationToolInvocation],
) -> bool {
    text_mentions_browser_runtime(input)
        || mentions.iter().any(|mention| {
            text_mentions_browser_runtime(&mention.kind)
                || text_mentions_browser_runtime(&mention.name)
        })
        || tool_invocations.iter().any(|invocation| {
            text_mentions_browser_runtime(&invocation.plugin_id)
                || invocation
                    .tool_name
                    .as_deref()
                    .is_some_and(text_mentions_browser_runtime)
        })
}

async fn build_gateway_user_input_for_turn(
    profile: Option<&str>,
    input: &str,
    mentions: &[ConversationMention],
    tool_invocations: &[ConversationToolInvocation],
    capabilities: Option<&openclaw_plugins::OpenClawProfileToolCapabilitiesSnapshot>,
) -> String {
    let browser_runtime =
        if conversation_turn_needs_browser_runtime_context(input, mentions, tool_invocations) {
            openclaw_browser::runtime_snapshot(
                profile,
                Some(openclaw_runtime::DEFAULT_BROWSER_PROFILE),
            )
            .await
            .ok()
        } else {
            None
        };

    let capability_context =
        capabilities.and_then(|snapshot| skill_pack_invocation_context(tool_invocations, snapshot));
    build_gateway_user_input(
        input,
        capability_context.as_deref(),
        browser_runtime.as_ref(),
        mentions,
    )
}

fn challenge_nonce_from_frame(value: &str) -> Result<(String, Option<u64>), String> {
    let frame = serde_json::from_str::<Value>(value)
        .map_err(|e| format!("解析 Gateway challenge 失败: {e}"))?;
    if frame.get("type").and_then(Value::as_str) != Some("event")
        || frame.get("event").and_then(Value::as_str) != Some("connect.challenge")
    {
        return Err("Gateway 第一帧不是 connect.challenge。".to_string());
    }
    let nonce = frame
        .get("payload")
        .and_then(|payload| payload.get("nonce"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Gateway connect.challenge 缺少 nonce。".to_string())?;
    let ts = frame
        .get("payload")
        .and_then(|payload| payload.get("ts"))
        .and_then(Value::as_u64);
    Ok((nonce, ts))
}

fn build_signed_connect_request_for_remote(
    app: &AppHandle,
    device_identity: &DeviceIdentityInfo,
    ws_url: &str,
    challenge_nonce: &str,
    challenge_ts: Option<u64>,
    bootstrap_token: Option<&str>,
    cached_device_token: Option<&str>,
) -> Result<PreparedGatewayConnect, String> {
    let package = app.package_info();
    let app_version = package.version.to_string();
    let platform = std::env::consts::OS.to_string();
    let client_id = "gateway-client";
    let client_mode = "backend";
    let device_family = "desktop";
    let role = "operator".to_string();
    let scopes = operator_connect_scopes();
    let signed_at = chrono::Utc::now().timestamp_millis();
    let public_key = device_public_key_base64_url(device_identity)?;

    let signing_key_bytes_vec = hex::decode(&device_identity.secret_key_hex)
        .map_err(|e| format!("解析本地 device secret 失败: {e}"))?;
    let signing_key_bytes: [u8; 32] = signing_key_bytes_vec
        .try_into()
        .map_err(|_| "本地 device secret 长度无效。".to_string())?;
    let signing_key = SigningKey::from_bytes(&signing_key_bytes);
    let signature_payload = build_openclaw_device_auth_payload_v3(
        &device_identity.device_id,
        client_id,
        client_mode,
        &role,
        &scopes,
        signed_at,
        bootstrap_token,
        challenge_nonce,
        &platform,
        Some(device_family),
    );
    let signature = signing_key.sign(signature_payload.as_bytes());
    let signature_value = base64_url_encode(&signature.to_bytes());

    let mut auth_actual = serde_json::Map::new();
    let mut auth_preview = serde_json::Map::new();
    if let Some(token) = bootstrap_token.filter(|value| !value.trim().is_empty()) {
        auth_actual.insert("bootstrapToken".to_string(), json!(token));
        auth_preview.insert(
            "bootstrapToken".to_string(),
            json!("<redacted-bootstrap-token>"),
        );
    }
    if let Some(device_token) = cached_device_token.filter(|value| !value.trim().is_empty()) {
        auth_actual.insert("deviceToken".to_string(), json!(device_token));
        auth_preview.insert("deviceToken".to_string(), json!("<redacted-device-token>"));
    }

    let connect_request = json!({
        "type": "req",
        "id": "remote-setup-connect",
        "method": "connect",
        "params": {
            "minProtocol": 3,
            "maxProtocol": 4,
            "client": {
                "id": client_id,
                "displayName": openclaw_gateway::GATEWAY_CLIENT_DISPLAY_NAME,
                "version": app_version,
                "platform": platform,
                "deviceFamily": device_family,
                "mode": client_mode,
            },
            "role": role,
            "scopes": scopes,
            "caps": [],
            "commands": [],
            "permissions": {},
            "auth": Value::Object(auth_actual.clone()),
            "locale": "zh-CN",
            "userAgent": format!("uniopc-desktop/{}", package.version),
            "device": {
                "id": device_identity.device_id,
                "publicKey": public_key,
                "signature": signature_value,
                "signedAt": signed_at,
                "nonce": challenge_nonce,
            }
        }
    });

    let preview = GatewayConnectPreview {
        ws_url: ws_url.to_string(),
        auth_mode: "bootstrap".to_string(),
        role: role.clone(),
        scopes: scopes.clone(),
        challenge_nonce: challenge_nonce.to_string(),
        challenge_ts,
        signature_payload_version: "v3".to_string(),
        signature_hex_preview: format!("{}...", &signature_value[..24]),
        connect_request_preview: json!({
            "type": "req",
            "id": "remote-setup-connect",
            "method": "connect",
            "params": {
                "minProtocol": 3,
                "maxProtocol": 4,
                "client": {
                    "id": client_id,
                    "displayName": openclaw_gateway::GATEWAY_CLIENT_DISPLAY_NAME,
                    "version": package.version.to_string(),
                    "platform": std::env::consts::OS,
                    "deviceFamily": device_family,
                    "mode": client_mode,
                },
                "role": role,
                "scopes": scopes,
                "caps": [],
                "commands": [],
                "permissions": {},
                "auth": Value::Object(auth_preview),
                "locale": "zh-CN",
                "userAgent": format!("uniopc-desktop/{}", package.version),
                "device": {
                    "id": device_identity.device_id,
                    "publicKey": public_key,
                    "signature": format!("{}...", &signature_value[..24]),
                    "signedAt": signed_at,
                    "nonce": challenge_nonce,
                }
            }
        }),
    };

    Ok(PreparedGatewayConnect {
        preview,
        connect_request,
    })
}

fn persist_remote_openclaw_profile_config(
    profile: &str,
    gateway_url: &str,
    device_token: &str,
) -> Result<(), String> {
    let path = openclaw_gateway::openclaw_config_path_for_profile(Some(profile))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建 Uniopc 引擎 profile 配置目录失败: {e}"))?;
    }
    let mut config = openclaw_gateway::load_openclaw_config_for_profile(Some(profile))?;
    if !config.is_object() {
        config = json!({});
    }
    if let Some(object) = config.as_object_mut() {
        object.insert(
            "gateway".to_string(),
            json!({
                "url": gateway_url,
                "auth": {
                    "mode": "deviceToken",
                    "deviceToken": device_token,
                },
                "remote": {
                    "deviceToken": device_token,
                }
            }),
        );
    }
    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化 Uniopc 引擎 remote profile 配置失败: {e}"))?;
    fs::write(path, format!("{serialized}\n"))
        .map_err(|e| format!("写入 Uniopc 引擎 remote profile 配置失败: {e}"))
}

fn extract_device_token(value: &Value) -> Option<String> {
    value
        .get("auth")
        .and_then(|auth| auth.get("deviceToken"))
        .and_then(Value::as_str)
        .or_else(|| value.get("deviceToken").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_remote_setup_from_gateway_payload(
    payload: &Value,
    fallback_gateway_url: &str,
) -> Result<(String, String), String> {
    let setup_code = payload
        .get("setupCode")
        .and_then(Value::as_str)
        .or_else(|| payload.get("setup_code").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(setup_code) = setup_code {
        let decoded = decode_openclaw_pairing_setup_code(setup_code)?;
        return Ok((setup_code.to_string(), decoded.gateway_url));
    }

    let bootstrap_token = payload
        .get("bootstrapToken")
        .and_then(Value::as_str)
        .or_else(|| payload.get("bootstrap_token").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Uniopc 引擎 没有返回 setupCode 或 bootstrapToken。".to_string())?;
    let gateway_url = payload
        .get("gatewayUrl")
        .and_then(Value::as_str)
        .or_else(|| payload.get("gateway_url").and_then(Value::as_str))
        .or_else(|| payload.get("url").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_gateway_url);

    Ok((
        encode_openclaw_pairing_setup_code(gateway_url, bootstrap_token),
        gateway_url.to_string(),
    ))
}

fn tail_text_lines(value: &str, max_lines: usize) -> String {
    let lines = value.lines().collect::<Vec<_>>();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

async fn openclaw_qr_setup_code(
    profile: &str,
    gateway_url_override: Option<&str>,
) -> Result<Value, String> {
    if let Some(gateway_url) = gateway_url_override {
        if let Some(issue) = remote_setup_gateway_url_issue(gateway_url) {
            return Err(remote_setup_gateway_url_error(issue));
        }
    }

    let mut args = vec![
        "--profile".to_string(),
        profile.to_string(),
        "qr".to_string(),
        "--json".to_string(),
        "--no-ascii".to_string(),
    ];
    if let Some(gateway_url) = gateway_url_override {
        args.push("--url".to_string());
        args.push(gateway_url.to_string());
    } else {
        args.push("--remote".to_string());
    }

    let _guard = openclaw_cli::acquire_cli_lock().await;
    let (program, args) = openclaw_cli::spawnable_command("openclaw", &args);
    let output = Command::new(program)
        .env("PATH", openclaw_cli::augmented_path(None))
        .envs(openclaw_cli::state_env_for_profile(
            args.iter()
                .position(|arg| arg == "--profile")
                .and_then(|index| args.get(index + 1))
                .map(String::as_str),
        ))
        .envs(openclaw_cli::local_loopback_env_overrides())
        .args(&args)
        .output()
        .map_err(|e| format!("执行官方 Uniopc 引擎 setup code 命令失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!(
            "官方 Uniopc 引擎 setup code 生成失败: {}",
            tail_text_lines(&detail, 12)
        ));
    }
    serde_json::from_str::<Value>(&stdout)
        .map_err(|e| format!("解析官方 Uniopc 引擎 setup code 输出失败: {e}"))
}

fn build_signed_connect_request(
    app: &AppHandle,
    device_identity: &DeviceIdentityInfo,
    profile: Option<&str>,
    challenge_nonce: &str,
    challenge_ts: Option<u64>,
    cached_device_token: Option<&str>,
    include_shared_auth: bool,
) -> Result<PreparedGatewayConnect, String> {
    let metadata = openclaw_gateway::config_metadata(profile)?;
    let ws_url = metadata.ws_url;
    let auth_mode = metadata.auth_mode;
    let (token, password) = openclaw_gateway::auth_secret(profile)?;
    let package = app.package_info();
    let platform = std::env::consts::OS.to_string();
    let client_id = "gateway-client";
    let client_mode = "backend";
    let device_family = "desktop";
    let role = "operator".to_string();
    let scopes = operator_connect_scopes();
    let signed_at = chrono::Utc::now().timestamp_millis();
    let public_key = device_public_key_base64_url(device_identity)?;

    let signing_key_bytes_vec = hex::decode(&device_identity.secret_key_hex)
        .map_err(|e| format!("解析本地 device secret 失败: {e}"))?;
    let signing_key_bytes: [u8; 32] = signing_key_bytes_vec
        .try_into()
        .map_err(|_| "本地 device secret 长度无效。".to_string())?;
    let signing_key = SigningKey::from_bytes(&signing_key_bytes);

    let signature_payload = build_openclaw_device_auth_payload_v3(
        &device_identity.device_id,
        client_id,
        client_mode,
        &role,
        &scopes,
        signed_at,
        None,
        challenge_nonce,
        &platform,
        Some(device_family),
    );
    let signature = signing_key.sign(signature_payload.as_bytes());
    let signature_value = base64_url_encode(&signature.to_bytes());

    let mut auth_actual = serde_json::Map::new();
    let mut auth_preview = serde_json::Map::new();
    if include_shared_auth {
        match auth_mode.as_str() {
            "token" => {
                auth_actual.insert(
                    "token".to_string(),
                    json!(token.clone().unwrap_or_default()),
                );
                auth_preview.insert(
                    "token".to_string(),
                    json!(token.as_ref().map(|_| "<redacted>").unwrap_or("<missing>")),
                );
            }
            "password" => {
                auth_actual.insert(
                    "password".to_string(),
                    json!(password.clone().unwrap_or_default()),
                );
                auth_preview.insert(
                    "password".to_string(),
                    json!(password
                        .as_ref()
                        .map(|_| "<redacted>")
                        .unwrap_or("<missing>")),
                );
            }
            _ => {}
        }
    }
    if let Some(device_token) = cached_device_token.filter(|value| !value.trim().is_empty()) {
        auth_actual.insert("deviceToken".to_string(), json!(device_token));
        auth_preview.insert("deviceToken".to_string(), json!("<redacted-device-token>"));
    }

    let connect_request = json!({
        "type": "req",
        "id": "preview-connect",
        "method": "connect",
        "params": {
            "minProtocol": 3,
            "maxProtocol": 4,
            "client": {
                "id": client_id,
                "displayName": openclaw_gateway::GATEWAY_CLIENT_DISPLAY_NAME,
                "version": package.version.to_string(),
                "platform": std::env::consts::OS,
                "deviceFamily": device_family,
                "mode": client_mode,
            },
            "role": role,
            "scopes": scopes,
            "caps": [],
            "commands": [],
            "permissions": {},
            "auth": Value::Object(auth_actual.clone()),
            "locale": "zh-CN",
            "userAgent": format!("uniopc-desktop/{}", package.version),
            "device": {
                "id": device_identity.device_id,
                "publicKey": public_key,
                "signature": signature_value,
                "signedAt": signed_at,
                "nonce": challenge_nonce,
            }
        }
    });

    let preview = GatewayConnectPreview {
        ws_url,
        auth_mode,
        role: role.clone(),
        scopes: scopes.clone(),
        challenge_nonce: challenge_nonce.to_string(),
        challenge_ts,
        signature_payload_version: "v3".to_string(),
        signature_hex_preview: format!("{}...", &signature_value[..24]),
        connect_request_preview: json!({
            "type": "req",
            "id": "preview-connect",
            "method": "connect",
            "params": {
                "minProtocol": 3,
                "maxProtocol": 4,
                "client": {
                    "id": client_id,
                    "displayName": openclaw_gateway::GATEWAY_CLIENT_DISPLAY_NAME,
                    "version": package.version.to_string(),
                    "platform": std::env::consts::OS,
                    "deviceFamily": device_family,
                    "mode": client_mode,
                },
                "role": role,
                "scopes": scopes,
                "caps": [],
                "commands": [],
                "permissions": {},
                "auth": Value::Object(auth_preview),
                "locale": "zh-CN",
                "userAgent": format!("uniopc-desktop/{}", package.version),
                "device": {
                    "id": device_identity.device_id,
                    "publicKey": public_key,
                    "signature": format!("{}...", &signature_value[..24]),
                    "signedAt": signed_at,
                    "nonce": challenge_nonce,
                }
            }
        }),
    };

    Ok(PreparedGatewayConnect {
        preview,
        connect_request,
    })
}

fn build_bridge_status(
    status: OpenClawStatus,
    profile_key: String,
    connection_snapshot: openclaw_connection::GatewayConnectionSnapshot,
    probe: openclaw_gateway::GatewayChallengeProbe,
    device_identity: Result<DeviceIdentityInfo, String>,
    cached_device_token: Option<StoredGatewayDeviceToken>,
) -> ConversationBridgeStatus {
    let (device_identity_ready, device_id, device_public_key) = match device_identity {
        Ok(identity) => (
            true,
            Some(identity.device_id),
            Some(identity.public_key_hex),
        ),
        Err(_) => (false, None, None),
    };
    let gateway_installed = status.installed;
    let gateway_running = matches!(
        connection_snapshot.status,
        openclaw_connection::GatewayConnectionStatus::Connected
    );
    let gateway_ws_url = connection_snapshot.endpoint_url.clone().unwrap_or_default();
    let gateway_has_token = connection_snapshot.has_auth_token;
    let gateway_auth_mode = if gateway_has_token { "token" } else { "none" }.to_string();
    let gateway_has_password = false;
    let gateway_client_implemented = true;
    let target_ready = gateway_installed && gateway_running;
    let cached_device_token_has_requested_scopes = cached_device_token
        .as_ref()
        .map(cached_device_token_covers_requested_scopes)
        .unwrap_or(false);

    let next_step = if gateway_installed && gateway_running {
        if cached_device_token.is_some() && !cached_device_token_has_requested_scopes {
            "缓存 device token scopes 仍是旧权限；请在运行中心尝试 Gateway Connect 或批准 scope upgrade 后再使用 browser tool。".to_string()
        } else if probe.connect_challenge_received && device_identity_ready {
            "Gateway WebSocket 对话通道已就绪。".to_string()
        } else if probe.connect_challenge_received {
            "Gateway 已响应 challenge；对话通道正在等待本地 device identity。".to_string()
        } else {
            "Gateway 已运行，但 WebSocket challenge 尚未稳定响应。".to_string()
        }
    } else if !gateway_installed {
        "需要先安装 Uniopc 引擎，Uniopc 才能发起原生 Gateway 对话。".to_string()
    } else if connection_snapshot.mode == openclaw_connection::GatewayConnectionMode::NotConfigured
    {
        format!("需要先配置 Uniopc 引擎 Connection（profile `{profile_key}`）。")
    } else {
        format!("Gateway Connection 未连接：{}", connection_snapshot.message)
    };

    ConversationBridgeStatus {
        current: ConversationRuntimeDescriptor {
            mode: CURRENT_MODE.to_string(),
            transport: CURRENT_TRANSPORT.to_string(),
            gateway_aligned: true,
            label: "Gateway 原生模式".to_string(),
            summary: "Uniopc 对话 UI 已接入 Uniopc 引擎 WebSocket 数据面。".to_string(),
            methods: Some(vec![
                "sessions.create".to_string(),
                "chat.history".to_string(),
                "chat.send".to_string(),
                "chat.final events".to_string(),
                "chat.abort".to_string(),
            ]),
        },
        target: ConversationRuntimeDescriptor {
            mode: TARGET_MODE.to_string(),
            transport: TARGET_TRANSPORT.to_string(),
            gateway_aligned: true,
            label: "Gateway 原生模式".to_string(),
            summary: "已对齐官方 Gateway 数据面；这些字段仅用于运行状态兼容和诊断。".to_string(),
            methods: Some(vec![
                "chat.history".to_string(),
                "chat.send".to_string(),
                "chat.abort".to_string(),
                "chat.inject".to_string(),
            ]),
        },
        gateway_installed,
        gateway_running,
        gateway_ws_url,
        gateway_protocol_version: 3,
        gateway_auth_mode,
        gateway_has_token,
        gateway_has_password,
        requires_device_identity: true,
        requires_challenge_signature: true,
        device_identity_ready,
        device_id,
        device_public_key,
        cached_device_token_available: cached_device_token.is_some(),
        cached_device_token_role: cached_device_token
            .as_ref()
            .and_then(|token| token.role.clone()),
        cached_device_token_scopes: cached_device_token
            .as_ref()
            .map(|token| token.scopes.clone()),
        gateway_ws_reachable: probe.ws_reachable,
        connect_challenge_received: probe.connect_challenge_received,
        connect_challenge_event: probe.connect_challenge_event,
        challenge_nonce_available: probe.challenge_nonce.is_some(),
        signed_connect_preview_ready: probe.challenge_nonce.is_some() && device_identity_ready,
        signature_payload_version: Some("v3".to_string()),
        probe_error: probe.probe_error,
        bridge_command_ready: true,
        gateway_client_implemented,
        target_ready,
        next_step,
    }
}

async fn ensure_gateway_session(
    app: &AppHandle,
    profile: Option<&str>,
    requested_key: Option<&str>,
    requested_agent_id: Option<&str>,
    conversation_id: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let key = requested_key
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            requested_agent_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("agent:{value}:main"))
        })
        .or_else(|| conversation_id.map(|value| format!("uniopc:{value}")))
        .unwrap_or_else(|| "main".to_string());

    let mut params = json!({ "key": key });
    if let Some(agent_id) = requested_agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(object) = params.as_object_mut() {
            object.insert("agentId".to_string(), json!(agent_id));
        }
    }

    let value = openclaw_gateway_connection::request(
        app,
        profile,
        "sessions.create",
        params,
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await?;
    let session_key = value
        .get("key")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Gateway sessions.create 没有返回 session key。".to_string())?;
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);

    Ok((session_key, session_id))
}

async fn resolve_gateway_session_for_turn(
    app: &AppHandle,
    profile: Option<&str>,
    requested_key: Option<&str>,
    requested_agent_id: Option<&str>,
    conversation_id: Option<&str>,
) -> Result<(String, Option<String>), String> {
    if let Some(key) = requested_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok((key.to_string(), None));
    }
    ensure_gateway_session(app, profile, None, requested_agent_id, conversation_id).await
}

fn emit_conversation_gateway_event(app: &AppHandle, event: ConversationGatewayEvent) {
    let _ = app.emit("conversation-gateway-event", event);
}

fn estimate_base64_decoded_len(content: &str) -> usize {
    let normalized = content
        .as_bytes()
        .iter()
        .filter(|byte| !byte.is_ascii_whitespace())
        .copied()
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        return 0;
    }
    let padding = normalized
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count()
        .min(2);
    (normalized.len() / 4)
        .saturating_mul(3)
        .saturating_sub(padding)
}

fn conversation_attachment_kind(name: &str, bytes: &[u8]) -> Result<&'static str, String> {
    let ext = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let starts = |signature: &[u8]| bytes.starts_with(signature);
    let image_mime = if starts(b"\x89PNG\r\n\x1a\n") && ext == "png" {
        Some("image/png")
    } else if starts(&[0xff, 0xd8, 0xff]) && matches!(ext.as_str(), "jpg" | "jpeg") {
        Some("image/jpeg")
    } else if (starts(b"GIF87a") || starts(b"GIF89a")) && ext == "gif" {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" && ext == "webp" {
        Some("image/webp")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && matches!(ext.as_str(), "heic" | "heif" | "avif") {
        Some(if ext == "avif" { "image/avif" } else { "image/heic" })
    } else {
        None
    };
    if let Some(mime) = image_mime {
        return Ok(mime);
    }
    match ext.as_str() {
        "pdf" if starts(b"%PDF-") => Ok("application/pdf"),
        "ppt" if starts(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) => {
            Ok("application/vnd.ms-powerpoint")
        }
        "pptx" if starts(b"PK\x03\x04") => Ok("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "txt" if std::str::from_utf8(bytes).is_ok() => Ok("text/plain"),
        "mp4" if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" => Ok("video/mp4"),
        _ => Err("仅支持图片、PDF、PPT/PPTX、UTF-8 TXT 或 MP4 附件。".to_string()),
    }
}

fn conversation_attachment_limit(_mime_type: &str) -> usize {
    CONVERSATION_ATTACHMENT_MAX_BYTES
}

fn conversation_media_inbound_dir(profile: Option<&str>) -> Result<PathBuf, String> {
    let state_dir = crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(profile)?;
    let dir = state_dir.join("media").join("inbound");
    fs::create_dir_all(&dir).map_err(|error| format!("创建本地附件目录失败: {error}"))?;
    let metadata = fs::symlink_metadata(&dir).map_err(|error| format!("读取本地附件目录失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("本地附件目录不是安全目录。".to_string());
    }
    let canonical_state = fs::canonicalize(&state_dir).map_err(|error| format!("解析引擎数据目录失败: {error}"))?;
    let canonical_media = fs::canonicalize(state_dir.join("media")).map_err(|error| format!("解析本地附件目录失败: {error}"))?;
    let canonical_inbound = fs::canonicalize(&dir).map_err(|error| format!("解析本地附件目录失败: {error}"))?;
    if canonical_media != canonical_state.join("media")
        || canonical_inbound != canonical_media.join("inbound")
    {
        return Err("本地附件目录超出引擎受管数据目录。".to_string());
    }
    Ok(dir)
}

fn store_conversation_media_bytes(inbound_dir: &Path, bytes: &[u8]) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let destination = inbound_dir.join(&id);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&destination)
        .map_err(|error| format!("保存附件失败: {error}"))?;
    use std::io::Write;
    if let Err(error) = file.write_all(bytes) {
        let _ = fs::remove_file(&destination);
        return Err(format!("保存附件失败: {error}"));
    }
    Ok(id)
}

fn read_conversation_attachment_file(path: &Path) -> Result<Vec<u8>, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|error| format!("读取附件失败: {error}"))?;
    let metadata = file.metadata().map_err(|error| format!("读取附件信息失败: {error}"))?;
    if !metadata.is_file() {
        return Err("附件必须是普通文件，不能是符号链接或目录。".to_string());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    use std::io::Read;
    file.take((CONVERSATION_ATTACHMENT_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取附件失败: {error}"))?;
    if bytes.len() > CONVERSATION_ATTACHMENT_MAX_BYTES {
        return Err("单个附件不能超过 10 MiB。".to_string());
    }
    Ok(bytes)
}

fn import_conversation_attachments_to_dir(
    paths: &[String],
    inbound_dir: &Path,
) -> Result<Vec<ImportedConversationAttachment>, String> {
    if paths.len() > CONVERSATION_IMAGE_MAX_COUNT {
        return Err(format!("一次最多发送 {CONVERSATION_IMAGE_MAX_COUNT} 个附件。"));
    }
    let mut total_bytes = 0usize;
    let mut staged = Vec::with_capacity(paths.len());
    for source in paths {
        let source_path = Path::new(source);
        let metadata = fs::symlink_metadata(source_path)
            .map_err(|error| format!("读取附件信息失败: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("附件必须是普通文件，不能是符号链接或目录。".to_string());
        }
        let name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "附件文件名无效。".to_string())?;
        if metadata.len() == 0 {
            return Err(format!("附件 {name} 为空。"));
        }
        if metadata.len() > CONVERSATION_ATTACHMENT_MAX_BYTES as u64 {
            return Err(format!("附件 {name} 超过 10 MiB 限制。"));
        }
        let bytes = read_conversation_attachment_file(source_path)
            .map_err(|error| format!("读取附件 {name} 失败: {error}"))?;
        let mime_type = conversation_attachment_kind(name, &bytes)?;
        let max_bytes = conversation_attachment_limit(mime_type);
        if bytes.len() > max_bytes {
            return Err(format!("附件 {name} 超过 {} MiB 限制。", max_bytes / (1024 * 1024)));
        }
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > CONVERSATION_ATTACHMENT_MAX_TOTAL_BYTES {
            return Err("附件总大小不能超过 100 MiB。".to_string());
        }
        staged.push((name.to_string(), mime_type.to_string(), bytes));
    }
    let mut imported: Vec<ImportedConversationAttachment> = Vec::with_capacity(staged.len());
    for (name, mime_type, bytes) in staged {
        let id = match store_conversation_media_bytes(inbound_dir, &bytes) {
            Ok(id) => id,
            Err(error) => {
                for stored in &imported {
                    let _ = fs::remove_file(inbound_dir.join(&stored.id));
                }
                return Err(format!("保存附件 {name} 失败: {error}"));
            }
        };
        let destination = inbound_dir.join(&id);
        imported.push(ImportedConversationAttachment {
            id,
            name,
            mime_type,
            size: bytes.len(),
            path: destination.to_string_lossy().into_owned(),
        });
    }
    Ok(imported)
}

pub async fn conversation_import_attachments(
    profile: Option<String>,
    paths: Vec<String>,
) -> Result<Vec<ImportedConversationAttachment>, String> {
    let inbound_dir = conversation_media_inbound_dir(profile.as_deref())?;
    import_conversation_attachments_to_dir(&paths, &inbound_dir)
}

pub async fn conversation_import_attachment_data_url(
    profile: Option<String>,
    name: String,
    data_url: String,
) -> Result<ImportedConversationAttachment, String> {
    let (metadata, payload) = data_url
        .split_once(',')
        .ok_or_else(|| "附件数据格式无效。".to_string())?;
    let mime_type = metadata
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or_else(|| "附件数据格式无效。".to_string())?
        .to_ascii_lowercase();
    let bytes = STANDARD
        .decode(payload)
        .map_err(|_| "附件数据编码无效。".to_string())?;
    let actual_mime = conversation_attachment_kind(&name, &bytes)?;
    if actual_mime != mime_type {
        return Err("附件内容与文件类型不匹配。".to_string());
    }
    let max_bytes = conversation_attachment_limit(actual_mime);
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(format!("附件大小无效或超过 {} MiB 限制。", max_bytes / (1024 * 1024)));
    }
    let inbound_dir = conversation_media_inbound_dir(profile.as_deref())?;
    let id = store_conversation_media_bytes(&inbound_dir, &bytes)?;
    let path = inbound_dir.join(&id).to_string_lossy().into_owned();
    Ok(ImportedConversationAttachment {
        id,
        name,
        mime_type: actual_mime.to_string(),
        size: bytes.len(),
        path,
    })
}

fn validate_conversation_attachments(attachments: &[ConversationAttachment]) -> Result<(), String> {
    if attachments.len() > CONVERSATION_IMAGE_MAX_COUNT {
        return Err(format!(
            "一次最多发送 {CONVERSATION_IMAGE_MAX_COUNT} 个附件。"
        ));
    }
    let mut total_bytes = 0usize;
    for attachment in attachments {
        let attachment_type = attachment.attachment_type.trim();
        let mime_type = attachment.mime_type.trim().to_ascii_lowercase();
        let is_image = attachment_type == "image" && mime_type.starts_with("image/");
        let local_id = attachment.local_media_id.as_deref().map(str::trim).filter(|value| !value.is_empty());
        let size = if let Some(local_id) = local_id {
            if uuid::Uuid::parse_str(local_id).is_err() || !attachment.content.trim().is_empty() {
                return Err("本地附件引用无效。".to_string());
            }
            let supported = is_image
                || (attachment_type == "file" && matches!(mime_type.as_str(),
                    "application/pdf"
                    | "application/vnd.ms-powerpoint"
                    | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                    | "text/plain"
                    | "video/mp4"));
            if !supported {
                return Err("附件类型不受支持。".to_string());
            }
            let declared_size = attachment.size_bytes.unwrap_or(0);
            if declared_size == 0 || declared_size > conversation_attachment_limit(&mime_type) {
                return Err("附件大小无效或超过单文件限制。".to_string());
            }
            declared_size
        } else {
            let is_pdf = attachment_type == "file" && mime_type == "application/pdf";
            if !is_image && !is_pdf {
                return Err("仅支持图片或 PDF 附件。".to_string());
            }
            if attachment.content.trim().is_empty() {
                return Err("附件内容不能为空。".to_string());
            }
            let decoded = estimate_base64_decoded_len(&attachment.content);
            if decoded > CONVERSATION_ATTACHMENT_MAX_BYTES {
                return Err("单个图片或 PDF 不能超过 10 MiB。".to_string());
            }
            decoded
        };
        total_bytes = total_bytes.saturating_add(size);
        if total_bytes > CONVERSATION_ATTACHMENT_MAX_TOTAL_BYTES {
            return Err("附件总大小不能超过 100 MiB。".to_string());
        }
    }
    Ok(())
}

fn validate_local_conversation_media_in_dir(
    inbound_dir: &Path,
    attachments: &[ConversationAttachment],
) -> Result<(), String> {
    let local = attachments
        .iter()
        .filter(|attachment| attachment.local_media_id.is_some())
        .collect::<Vec<_>>();
    if local.is_empty() {
        return Ok(());
    }
    let root = fs::canonicalize(inbound_dir).map_err(|error| format!("解析本地附件目录失败: {error}"))?;
    for attachment in local {
        let id = attachment.local_media_id.as_deref().unwrap_or_default();
        let parsed_id = uuid::Uuid::parse_str(id).map_err(|_| "本地附件引用无效。".to_string())?;
        let path = inbound_dir.join(parsed_id.to_string());
        let metadata = fs::symlink_metadata(&path).map_err(|_| "本地附件已不存在，请重新添加。".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("本地附件不是安全的普通文件。".to_string());
        }
        let canonical = fs::canonicalize(&path).map_err(|_| "本地附件路径无效。".to_string())?;
        if canonical.parent() != Some(root.as_path()) {
            return Err("本地附件路径超出受管目录。".to_string());
        }
        let bytes = read_conversation_attachment_file(&canonical)
            .map_err(|error| format!("读取本地附件失败: {error}"))?;
        if bytes.len() != attachment.size_bytes.unwrap_or_default() {
            return Err("本地附件大小已变化，请重新添加。".to_string());
        }
        let name = attachment.file_name.as_deref().unwrap_or_default();
        let actual_mime = conversation_attachment_kind(name, &bytes)?;
        if actual_mime != attachment.mime_type.trim().to_ascii_lowercase() {
            return Err("本地附件类型已变化，请重新添加。".to_string());
        }
    }
    Ok(())
}

fn prepare_gateway_conversation_attachments(
    profile: Option<&str>,
    attachments: &[ConversationAttachment],
) -> Result<Vec<ConversationAttachment>, String> {
    let inbound_dir = conversation_media_inbound_dir(profile)?;
    prepare_gateway_conversation_attachments_in_dir(&inbound_dir, attachments)
}

fn prepare_gateway_conversation_attachments_in_dir(
    inbound_dir: &Path,
    attachments: &[ConversationAttachment],
) -> Result<Vec<ConversationAttachment>, String> {
    let mut prepared = Vec::with_capacity(attachments.len());
    let mut total_bytes = 0usize;
    for attachment in attachments {
        if attachment.local_media_id.is_some() {
            prepared.push(attachment.clone());
            total_bytes = total_bytes.saturating_add(attachment.size_bytes.unwrap_or_default());
            continue;
        }
        let bytes = STANDARD
            .decode(attachment.content.trim())
            .map_err(|_| "附件数据编码无效。".to_string())?;
        let name = attachment.file_name.as_deref().unwrap_or("attachment");
        let actual_mime = conversation_attachment_kind(name, &bytes)?;
        if actual_mime != attachment.mime_type.trim().to_ascii_lowercase() {
            return Err("附件内容与文件类型不匹配。".to_string());
        }
        let max_bytes = conversation_attachment_limit(actual_mime);
        if bytes.is_empty() || bytes.len() > max_bytes {
            return Err(format!("附件大小无效或超过 {} MiB 限制。", max_bytes / (1024 * 1024)));
        }
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > CONVERSATION_ATTACHMENT_MAX_TOTAL_BYTES {
            return Err("附件总大小不能超过 100 MiB。".to_string());
        }
        let id = store_conversation_media_bytes(inbound_dir, &bytes)?;
        let mut local = attachment.clone();
        local.content.clear();
        local.local_media_id = Some(id);
        local.size_bytes = Some(bytes.len());
        prepared.push(local);
    }
    validate_conversation_attachments(&prepared)?;
    validate_local_conversation_media_in_dir(inbound_dir, &prepared)?;
    Ok(prepared)
}

fn default_conversation_image_file_name(mime_type: &str) -> &'static str {
    match mime_type.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "image.jpg",
        "image/webp" => "image.webp",
        "image/gif" => "image.gif",
        "image/heic" => "image.heic",
        _ => "image.png",
    }
}

fn normalize_conversation_image_file_name(file_name: Option<&str>, mime_type: &str) -> String {
    let trimmed = file_name.map(str::trim).unwrap_or_default();
    if trimmed.is_empty() {
        return default_conversation_image_file_name(mime_type).to_string();
    }
    trimmed
        .rsplit(['/', '\\'])
        .find(|part| !part.trim().is_empty())
        .map(|part| part.trim().to_string())
        .unwrap_or_else(|| default_conversation_image_file_name(mime_type).to_string())
}

fn validate_tool_invocations_against_capabilities(
    invocations: &[ConversationToolInvocation],
    capabilities: &openclaw_plugins::OpenClawProfileToolCapabilitiesSnapshot,
) -> Result<(), String> {
    for invocation in invocations {
        let plugin_id = invocation.plugin_id.trim();
        if plugin_id.is_empty() {
            return Err("缺少 Uniopc 引擎 插件 ID。".to_string());
        }
        let plugin = capabilities
            .plugins
            .iter()
            .find(|plugin| plugin.id == plugin_id)
            .ok_or_else(|| {
                format!("Uniopc 引擎 插件 `{plugin_id}` 不在当前 profile 的能力列表中。")
            })?;
        if plugin.status != "ready" {
            let reasons = if plugin.readiness_reasons.is_empty() {
                plugin.status.clone()
            } else {
                plugin.readiness_reasons.join(", ")
            };
            return Err(format!(
                "Uniopc 引擎 插件 `{plugin_id}` 尚未 ready，不能用于 / 调用：{reasons}。"
            ));
        }
        if let Some(tool_name) = invocation
            .tool_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !plugin.tools.iter().any(|tool| tool.name == tool_name) {
                return Err(format!(
                    "Uniopc 引擎 插件 `{plugin_id}` 没有声明工具 `{tool_name}`。"
                ));
            }
            continue;
        }

        let has_tools = plugin
            .tools
            .iter()
            .map(|tool| tool.name.trim())
            .any(|name| !name.is_empty());
        // Skill-pack plugins (e.g. uniopc-documents / uniopc-shopify) ship
        // bundled skills instead of gateway tools — zero tools is their normal
        // ready state and the "/" invocation is valid capability steering.
        if !has_tools && !plugin.has_skills {
            return Err(format!("Uniopc 引擎 插件 `{plugin_id}` 没有可用工具。"));
        }
    }
    Ok(())
}

fn build_gateway_chat_send_params(
    session_key: &str,
    input: &str,
    run_id: &str,
    attachments: &[ConversationAttachment],
    _tool_invocations: &[ConversationToolInvocation],
    thinking_override: Option<&str>,
) -> Result<Value, String> {
    validate_conversation_attachments(attachments)?;
    let mut params = json!({
        "sessionKey": session_key,
        "message": input,
        "idempotencyKey": run_id,
    });
    if let Some(thinking) = normalize_gateway_thinking_override(thinking_override)? {
        if let Some(object) = params.as_object_mut() {
            object.insert("thinking".to_string(), json!(thinking));
        }
    }
    if !attachments.is_empty() {
        if let Some(object) = params.as_object_mut() {
            object.insert(
                "attachments".to_string(),
                Value::Array(
                    attachments
                        .iter()
                        .map(|attachment| {
                            let mut value = json!({
                                "type": attachment.attachment_type.trim(),
                                "mimeType": attachment.mime_type.trim(),
                                "fileName": normalize_conversation_image_file_name(
                                    attachment.file_name.as_deref(),
                                    &attachment.mime_type,
                                ),
                            });
                            if let Some(local_media_id) = attachment.local_media_id.as_deref() {
                                value["localMediaId"] = json!(local_media_id.trim());
                                value["sizeBytes"] = json!(attachment.size_bytes.unwrap_or_default());
                            } else {
                                value["content"] = json!(attachment.content.trim());
                            }
                            value
                        })
                        .collect(),
                ),
            );
        }
    }
    Ok(params)
}

fn normalize_gateway_thinking_override(
    value: Option<&str>,
) -> Result<Option<&'static str>, String> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("default") | Some("inherit") | Some("inherited") => Ok(None),
        Some("off") => Ok(Some("off")),
        Some("minimal") => Ok(Some("minimal")),
        Some("low") => Ok(Some("low")),
        Some("medium") => Ok(Some("medium")),
        Some("high") => Ok(Some("high")),
        Some("adaptive") => Ok(Some("adaptive")),
        Some("xhigh") => Ok(Some("xhigh")),
        Some("max") => Ok(Some("max")),
        Some(value) => Err(format!("未知 Uniopc 引擎 thinking 模式: {value}")),
    }
}

async fn ensure_conversation_gateway_ready(
    app: &AppHandle,
    profile: Option<&str>,
) -> Result<openclaw_gateway::GatewayEndpoint, String> {
    let profile_key = crate::services::openclaw_runtime::normalize_profile_key(profile);
    let health_result = openclaw_gateway_connection::health(app, Some(&profile_key)).await;
    let health = match health_result {
        Ok(value) => value,
        Err(error) => {
            return Err(conversation_gateway_unavailable_message(
                &profile_key,
                Some(&error),
            ))
        }
    };
    let health_ok = health.get("ok").and_then(Value::as_bool).unwrap_or(true);
    if health_ok {
        return ensure_conversation_gateway_endpoint(app, &profile_key).await;
    }
    Err(conversation_gateway_unavailable_message(
        &profile_key,
        Some(&format!("health 非 ok: {health}")),
    ))
}

async fn ensure_conversation_gateway_endpoint(
    app: &AppHandle,
    profile_key: &str,
) -> Result<openclaw_gateway::GatewayEndpoint, String> {
    openclaw_gateway_connection::require_endpoint(app, Some(profile_key))
        .await
        .map_err(|error| conversation_gateway_unavailable_message(profile_key, Some(&error)))
}

#[cfg(test)]
fn connection_required_message(profile_key: &str) -> String {
    openclaw_connection::connection_required_message(profile_key)
}

fn conversation_gateway_unavailable_message(profile_key: &str, reason: Option<&str>) -> String {
    let reason = reason
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!(" 详情：{value}"))
        .unwrap_or_default();
    format!(
        "Uniopc 引擎（profile `{profile_key}`）未运行或不可用。请先在运行中心启动或修复该 Uniopc 引擎 profile。{reason}"
    )
}

fn is_gateway_response_rejection(error: &str) -> bool {
    let error = error.trim();
    let payload = serde_json::from_str::<Value>(error).ok().or_else(|| {
        error
            .find('{')
            .and_then(|index| serde_json::from_str::<Value>(&error[index..]).ok())
    });
    payload
        .and_then(|value| {
            value
                .get("code")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .is_some()
}

async fn send_gateway_chat_message(
    app: &AppHandle,
    profile: Option<&str>,
    conversation_id: Option<&str>,
    session_key: &str,
    input: &str,
    attachments: &[ConversationAttachment],
    idempotency_key: Option<&str>,
    thinking_override: Option<&str>,
) -> Result<String, String> {
    let prepared_attachments = prepare_gateway_conversation_attachments(profile, attachments)?;
    let run_id = idempotency_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("uniopc-turn-{}", uuid::Uuid::new_v4()));
    // `chat.send` is an admission mutation. Do not let generic connection
    // recovery replay it onto a replacement Gateway: once the socket write has
    // started, a missing response is an unknown delivery result. The renderer
    // preserves the original idempotency key and reconciles canonical history.
    let accepted_payload = openclaw_gateway_connection::request(
        app,
        profile,
        "chat.send",
        build_gateway_chat_send_params(
            session_key,
            input,
            &run_id,
            &prepared_attachments,
            &[],
            thinking_override,
        )?,
        openclaw_gateway_connection::GatewayRequestOptions {
            allow_recovery: false,
            ..openclaw_gateway_connection::GatewayRequestOptions::default()
        },
    )
    .await
    .map_err(|error| {
        // Gateway response errors are normalized JSON and prove a rejection.
        // Everything else is a timeout/socket/channel outcome after dispatch
        // may have begun, therefore must never be presented as a definite
        // "send failed" or retried under a new identity.
        let gateway_rejected = is_gateway_response_rejection(&error);
        if gateway_rejected {
            error
        } else {
            format!("delivery_unconfirmed:{error}")
        }
    })?;
    let accepted_run_id = accepted_payload
        .get("runId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| run_id.clone());
    let accepted_status = accepted_payload
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("started")
        .to_string();

    // Bind before the first stream frame can arrive: agent/tool frames name only
    // a runId, so without this they are attributed to the on-screen session and
    // a turn left running in the background bleeds into whatever chat the user
    // opened next.
    openclaw_gateway_connection::bind_run(app, profile, &accepted_run_id, session_key).await;

    emit_conversation_gateway_event(
        app,
        ConversationGatewayEvent {
            conversation_id: conversation_id.map(str::to_string),
            session_key: session_key.to_string(),
            run_id: Some(accepted_run_id.clone()),
            state: accepted_status,
            content: None,
            is_reasoning: false,
            reasoning_content: None,
            error_message: None,
            seq: None,
            created_at: chrono::Utc::now().timestamp_millis().max(0) as u64,
        },
    );

    Ok(accepted_run_id)
}

fn build_gateway_connect_attempt_result(
    response_value: Value,
    preview: GatewayConnectPreview,
    used_cached_device_token: bool,
    retry_attempted_with_cached_device_token: bool,
) -> GatewayConnectAttemptResult {
    let response_ok = response_value
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let payload = response_value.get("payload");
    let error = response_value.get("error");
    let details = error.and_then(|error| error.get("details"));
    let mut gateway_error = (!response_ok).then(|| normalize_gateway_error(response_value.clone()));
    let capabilities = if response_ok {
        match openclaw_gateway::gateway_capabilities(payload.cloned().unwrap_or(Value::Null)) {
            Ok(value) => Some(value),
            Err(error) => {
                gateway_error = Some(error);
                None
            }
        }
    } else {
        None
    };
    let success = response_ok && capabilities.is_some();
    let response_preview = capabilities.as_ref().map(|capabilities| {
        json!({
            "type": "hello-ok",
            "protocol": capabilities.protocol,
            "serverVersion": capabilities.server_version
        })
    });

    GatewayConnectAttemptResult {
        success,
        hello_ok: success
            && matches!(
                payload
                    .and_then(|payload| payload.get("type"))
                    .and_then(Value::as_str),
                Some("hello-ok")
            ),
        protocol: capabilities.as_ref().map(|value| value.protocol),
        server_version: capabilities
            .as_ref()
            .map(|value| value.server_version.clone()),
        conn_id: None,
        device_token_issued: payload
            .and_then(|payload| payload.get("auth"))
            .and_then(|auth| auth.get("deviceToken"))
            .is_some(),
        used_cached_device_token,
        retry_attempted_with_cached_device_token,
        recommended_next_step: normalize_gateway_recommended_next_step(
            details
                .and_then(|details| details.get("recommendedNextStep"))
                .and_then(Value::as_str),
        ),
        can_retry_with_device_token: details
            .and_then(|details| details.get("canRetryWithDeviceToken"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        error_message: gateway_error
            .as_ref()
            .map(|value| value.message_key.clone()),
        error_code: gateway_error.as_ref().map(|value| value.code.clone()),
        error_reason: None,
        gateway_error,
        response_preview,
        preview,
    }
}

pub(crate) async fn conversation_bridge_status_impl(
    app: AppHandle,
    profile: Option<String>,
) -> Result<ConversationBridgeStatus, String> {
    let profile_key = openclaw_connection::normalize_profile(profile.as_deref());
    let status = openclaw_status(app.clone()).await?;
    let connection_snapshot =
        openclaw_connection::connection_snapshot_for_profile_from_app(&app, Some(&profile_key))
            .await?;
    let device_identity = ensure_device_identity(&app);
    let cached_device_token = device_identity.as_ref().ok().and_then(|identity| {
        read_cached_device_token(&app, &identity.device_id)
            .ok()
            .flatten()
    });
    let probe = if matches!(
        connection_snapshot.status,
        openclaw_connection::GatewayConnectionStatus::Connected
    ) {
        match openclaw_connection::resolve_endpoint_for_profile_from_app(&app, Some(&profile_key))
            .await
        {
            Ok(endpoint) => openclaw_gateway::probe_challenge_url(&endpoint.url, 2).await,
            Err(error) => openclaw_gateway::GatewayChallengeProbe {
                ws_reachable: false,
                connect_challenge_received: false,
                connect_challenge_event: None,
                challenge_nonce: None,
                challenge_ts: None,
                probe_error: Some(error),
            },
        }
    } else {
        openclaw_gateway::GatewayChallengeProbe {
            ws_reachable: false,
            connect_challenge_received: false,
            connect_challenge_event: None,
            challenge_nonce: None,
            challenge_ts: None,
            probe_error: connection_snapshot.last_error.clone().or_else(|| {
                Some("Gateway Connection 尚未连接，暂时无法探测 WebSocket challenge。".to_string())
            }),
        }
    };
    Ok(build_bridge_status(
        status,
        profile_key,
        connection_snapshot,
        probe,
        device_identity,
        cached_device_token,
    ))
}

pub(crate) async fn conversation_prepare_gateway_connect_preview_impl(
    app: AppHandle,
    profile: Option<String>,
) -> Result<GatewayConnectPreview, String> {
    let profile_key = openclaw_connection::normalize_profile(profile.as_deref());
    let endpoint = ensure_conversation_gateway_ready(&app, Some(&profile_key)).await?;
    let probe = openclaw_gateway::probe_challenge_url(&endpoint.url, 2).await;
    if !probe.connect_challenge_received {
        return Err(probe
            .probe_error
            .unwrap_or_else(|| "还没有拿到 Gateway connect.challenge。".to_string()));
    }

    let device_identity = ensure_device_identity(&app)?;
    let challenge_nonce = probe
        .challenge_nonce
        .ok_or_else(|| "Gateway challenge 中没有可用 nonce。".to_string())?;

    let mut prepared = build_signed_connect_request(
        &app,
        &device_identity,
        Some(&profile_key),
        &challenge_nonce,
        probe.challenge_ts,
        None,
        true,
    )?;
    prepared.preview.ws_url = endpoint.url;
    Ok(prepared.preview)
}

pub(crate) async fn conversation_attempt_gateway_connect_impl(
    app: AppHandle,
    profile: Option<String>,
) -> Result<GatewayConnectAttemptResult, String> {
    let profile = profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_openclaw_profile_handle)
        .transpose()?;
    let profile_ref = profile.as_deref();

    let device_identity = ensure_device_identity(&app)?;
    let profile_key = openclaw_connection::normalize_profile(profile_ref);
    let endpoint = ensure_conversation_gateway_ready(&app, Some(&profile_key)).await?;
    let metadata = openclaw_gateway::config_metadata(profile_ref)?;
    let prepared_probe = openclaw_gateway::probe_challenge_url(&endpoint.url, 2).await;
    if !prepared_probe.connect_challenge_received {
        return Err(prepared_probe
            .probe_error
            .unwrap_or_else(|| "还没有拿到 Gateway connect.challenge。".to_string()));
    }

    let challenge_nonce = prepared_probe
        .challenge_nonce
        .clone()
        .ok_or_else(|| "Gateway challenge 中没有可用 nonce。".to_string())?;
    let cached_device_token = read_cached_device_token(&app, &device_identity.device_id)?;
    let cached_device_token_has_requested_scopes = cached_device_token
        .as_ref()
        .map(cached_device_token_covers_requested_scopes)
        .unwrap_or(false);
    let should_start_with_cached_token =
        cached_device_token_has_requested_scopes && !metadata.has_token && !metadata.has_password;
    let mut prepared = build_signed_connect_request(
        &app,
        &device_identity,
        profile.as_deref(),
        &challenge_nonce,
        prepared_probe.challenge_ts,
        cached_device_token
            .as_ref()
            .map(|token| token.device_token.as_str())
            .filter(|_| should_start_with_cached_token),
        true,
    )?;
    prepared.preview.ws_url = endpoint.url.clone();
    let mut response_value = openclaw_gateway::execute_connect_request(
        &prepared.preview.ws_url,
        &prepared.connect_request,
        3,
    )
    .await?;
    let mut used_cached_device_token = should_start_with_cached_token;
    let mut retry_attempted_with_cached_device_token = false;
    let can_retry_with_device_token = response_value
        .get("error")
        .and_then(|error| error.get("details"))
        .and_then(|details| details.get("canRetryWithDeviceToken"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if !response_value
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && !used_cached_device_token
        && can_retry_with_device_token
    {
        if let Some(cached) = cached_device_token
            .as_ref()
            .filter(|token| cached_device_token_covers_requested_scopes(token))
        {
            let mut retry_prepared = build_signed_connect_request(
                &app,
                &device_identity,
                profile.as_deref(),
                &challenge_nonce,
                prepared_probe.challenge_ts,
                Some(cached.device_token.as_str()),
                true,
            )?;
            retry_prepared.preview.ws_url = endpoint.url.clone();
            response_value = openclaw_gateway::execute_connect_request(
                &retry_prepared.preview.ws_url,
                &retry_prepared.connect_request,
                3,
            )
            .await?;
            used_cached_device_token = true;
            retry_attempted_with_cached_device_token = true;

            if response_value
                .get("ok")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                let payload = response_value.get("payload");
                let issued_device_token = payload
                    .and_then(|payload| payload.get("auth"))
                    .and_then(|auth| auth.get("deviceToken"))
                    .and_then(Value::as_str);
                if let Some(device_token) = issued_device_token {
                    let role = payload
                        .and_then(|payload| payload.get("auth"))
                        .and_then(|auth| auth.get("role"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let scopes = payload
                        .and_then(|payload| payload.get("auth"))
                        .and_then(|auth| auth.get("scopes"))
                        .and_then(Value::as_array)
                        .map(|scopes| {
                            scopes
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let _ = persist_cached_device_token(
                        &app,
                        &device_identity.device_id,
                        device_token,
                        role,
                        scopes,
                    );
                }
            }

            return Ok(build_gateway_connect_attempt_result(
                response_value,
                retry_prepared.preview,
                used_cached_device_token,
                retry_attempted_with_cached_device_token,
            ));
        }
    }

    if response_value
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let payload = response_value.get("payload");
        let issued_device_token = payload
            .and_then(|payload| payload.get("auth"))
            .and_then(|auth| auth.get("deviceToken"))
            .and_then(Value::as_str);
        if let Some(device_token) = issued_device_token {
            let role = payload
                .and_then(|payload| payload.get("auth"))
                .and_then(|auth| auth.get("role"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let scopes = payload
                .and_then(|payload| payload.get("auth"))
                .and_then(|auth| auth.get("scopes"))
                .and_then(Value::as_array)
                .map(|scopes| {
                    scopes
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let _ = persist_cached_device_token(
                &app,
                &device_identity.device_id,
                device_token,
                role,
                scopes,
            );
        }
    }

    Ok(build_gateway_connect_attempt_result(
        response_value,
        prepared.preview,
        used_cached_device_token,
        retry_attempted_with_cached_device_token,
    ))
}

pub(crate) async fn conversation_gateway_pairing_status_impl(
    _app: AppHandle,
) -> Result<GatewayPairingStatus, String> {
    let raw = openclaw_gateway::call_json(None, "device.pair.list", json!({}), false).await?;
    let output_preview = gateway_output_preview(&raw);
    let pending_requests = extract_object_array(&raw, &["pending", "pendingRequests", "requests"]);
    let paired_devices = extract_object_array(&raw, &["pairedDevices", "devices", "paired"]);

    Ok(GatewayPairingStatus {
        pending_requests,
        paired_devices,
        raw: Some(raw),
        output_preview,
    })
}

pub(crate) async fn openclaw_profile_remote_setup_code_impl(
    input: OpenClawProfileRemoteSetupRequest,
) -> Result<OpenClawProfileRemoteSetupResult, String> {
    let profile = validate_openclaw_profile_handle(&input.profile)?;
    let gateway_url_override = input
        .gateway_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let raw = openclaw_qr_setup_code(&profile, gateway_url_override).await?;
    let (setup_code, gateway_url) =
        extract_remote_setup_from_gateway_payload(&raw, gateway_url_override.unwrap_or(""))?;
    Ok(OpenClawProfileRemoteSetupResult {
        profile,
        setup_code,
        gateway_url,
        output_preview: gateway_output_preview(&raw),
        raw: Some(raw),
    })
}

pub(crate) async fn openclaw_profile_pairing_status_impl(
    input: OpenClawProfilePairingRequest,
) -> Result<GatewayPairingStatus, String> {
    let profile = validate_openclaw_profile_handle(&input.profile)?;
    let raw =
        openclaw_gateway::call_json(Some(&profile), "device.pair.list", json!({}), false).await?;
    // Phones connect as `role: node`, and node-role pairing requests live in a
    // separate list from device pairing. Polling only device.pair.list means a
    // waiting phone never surfaces here and the 批准 button never appears — so
    // also merge node.pair.list (best-effort; empty on engines without it).
    let node_raw = openclaw_gateway::call_json(Some(&profile), "node.pair.list", json!({}), false)
        .await
        .unwrap_or_else(|_| json!({}));
    let output_preview = gateway_output_preview(&raw);
    let mut pending_requests =
        extract_object_array(&raw, &["pending", "pendingRequests", "requests"]);
    pending_requests.extend(extract_object_array(
        &node_raw,
        &["pending", "pendingRequests", "requests"],
    ));
    let mut paired_devices = extract_object_array(&raw, &["pairedDevices", "devices", "paired"]);
    paired_devices.extend(extract_object_array(
        &node_raw,
        &["paired", "pairedNodes", "nodes"],
    ));

    Ok(GatewayPairingStatus {
        pending_requests,
        paired_devices,
        raw: Some(raw),
        output_preview,
    })
}

pub(crate) async fn openclaw_profile_approve_latest_pairing_impl(
    app: AppHandle,
    input: OpenClawProfilePairingRequest,
) -> Result<GatewayPairingApprovalResult, String> {
    let profile = validate_openclaw_profile_handle(&input.profile)?;
    // Phones pair as nodes, so approve the latest pending NODE first (the CLI
    // owns the correct approve scopes); fall back to device approval otherwise.
    // Without this, `devices approve` never clears a node request and the phone
    // stays "waiting for approval" forever.
    let node_list = openclaw_gateway::call_json(Some(&profile), "node.pair.list", json!({}), false)
        .await
        .unwrap_or_else(|_| json!({}));
    let node_request_id =
        extract_object_array(&node_list, &["pending", "pendingRequests", "requests"])
            .into_iter()
            .find_map(|entry| {
                entry
                    .get("requestId")
                    .or_else(|| entry.get("id"))
                    .or_else(|| entry.get("nodeId"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
    let output = if let Some(request_id) = node_request_id.as_deref() {
        openclaw_output_for_profile(&app, &profile, &["nodes", "approve", request_id, "--json"])
            .await?
    } else {
        openclaw_output_for_profile(
            &app,
            &profile,
            &["devices", "approve", "--latest", "--json"],
        )
        .await?
    };
    let raw = parse_json_object_from_mixed_output(&output).unwrap_or_else(|| {
        json!({
            "approved": true,
            "output": output,
        })
    });
    let output_preview = gateway_output_preview(&raw);
    let request_id = raw
        .get("requestId")
        .and_then(Value::as_str)
        .or_else(|| raw.get("id").and_then(Value::as_str))
        .map(str::to_string);
    let approved = raw
        .get("approved")
        .and_then(Value::as_bool)
        .or_else(|| raw.get("ok").and_then(Value::as_bool))
        .unwrap_or(true);

    Ok(GatewayPairingApprovalResult {
        approved,
        request_id,
        raw: Some(raw),
        output_preview,
    })
}

pub(crate) async fn openclaw_profile_redeem_remote_setup_impl(
    app: AppHandle,
    input: OpenClawProfileRedeemRemoteSetupRequest,
) -> Result<OpenClawProfileRedeemRemoteSetupResult, String> {
    let profile = validate_openclaw_profile_handle(&input.profile)?;
    let setup = decode_openclaw_pairing_setup_code(&input.setup_code)?;
    if let Some(issue) = remote_setup_gateway_url_issue(&setup.gateway_url) {
        return Err(remote_setup_gateway_url_error(issue));
    }
    let device_identity = ensure_device_identity(&app)?;
    let (mut socket, _) = connect_async(&setup.gateway_url)
        .await
        .map_err(|e| format!("连接 Owner Uniopc 引擎 失败: {e}"))?;
    let challenge = openclaw_gateway::next_text_frame(&mut socket, GATEWAY_WS_CONNECT_TIMEOUT_SECS)
        .await
        .map_err(|e| format!("读取 Owner Gateway challenge 失败: {e}"))?;
    let (challenge_nonce, challenge_ts) = challenge_nonce_from_frame(&challenge)?;
    let cached_device_token = read_cached_device_token(&app, &device_identity.device_id)?;
    let prepared = build_signed_connect_request_for_remote(
        &app,
        &device_identity,
        &setup.gateway_url,
        &challenge_nonce,
        challenge_ts,
        Some(&setup.bootstrap_token),
        cached_device_token
            .as_ref()
            .filter(|token| cached_device_token_covers_requested_scopes(token))
            .map(|token| token.device_token.as_str()),
    )?;
    openclaw_gateway::send_json_frame(&mut socket, &prepared.connect_request)
        .await
        .map_err(|e| format!("发送 Owner Gateway connect 请求失败: {e}"))?;
    let frame = openclaw_gateway::next_matching_response(
        &mut socket,
        "remote-setup-connect",
        false,
        GATEWAY_WS_REQUEST_TIMEOUT_SECS,
    )
    .await
    .map_err(|e| format!("Owner Gateway connect 失败: {e}"))?;
    let payload = openclaw_gateway::validated_connect_payload(&frame, "remote-setup-connect")?;
    let _ = socket.close(None).await;
    let device_token = extract_device_token(&payload)
        .ok_or_else(|| "Owner Gateway connect 成功但没有返回 deviceToken。".to_string())?;
    let role = payload
        .get("auth")
        .and_then(|auth| auth.get("role"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let scopes = payload
        .get("auth")
        .and_then(|auth| auth.get("scopes"))
        .and_then(Value::as_array)
        .map(|scopes| {
            scopes
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    persist_cached_device_token(
        &app,
        &device_identity.device_id,
        &device_token,
        role,
        scopes,
    )?;
    persist_remote_openclaw_profile_config(&profile, &setup.gateway_url, &device_token)?;

    Ok(OpenClawProfileRedeemRemoteSetupResult {
        profile,
        gateway_url: setup.gateway_url,
        success: true,
        hello_ok: matches!(
            payload.get("type").and_then(Value::as_str),
            Some("hello-ok")
        ),
        device_token_issued: true,
        response_preview: Some(prepared.preview.connect_request_preview),
    })
}

pub(crate) async fn conversation_gateway_approve_latest_pairing_impl(
    _app: AppHandle,
) -> Result<GatewayPairingApprovalResult, String> {
    let list = openclaw_gateway::call_json(None, "device.pair.list", json!({}), false).await?;
    let request_id = select_pairing_request_to_approve(extract_object_array(
        &list,
        &["pending", "pendingRequests", "requests"],
    ))?;
    let raw = openclaw_gateway::call_json(
        None,
        "device.pair.approve",
        json!({ "requestId": request_id }),
        false,
    )
    .await?;
    let output_preview = gateway_output_preview(&raw);
    let request_id = raw
        .get("requestId")
        .and_then(Value::as_str)
        .or_else(|| raw.get("id").and_then(Value::as_str))
        .map(str::to_string);
    let approved = raw
        .get("approved")
        .and_then(Value::as_bool)
        .or_else(|| raw.get("ok").and_then(Value::as_bool))
        .unwrap_or(true);

    Ok(GatewayPairingApprovalResult {
        approved,
        request_id,
        raw: Some(raw),
        output_preview,
    })
}

pub(crate) async fn conversation_load_history_impl(
    app: AppHandle,
    session_key: String,
    profile: Option<String>,
    include_session_meta: bool,
) -> Result<ConversationHistoryResult, String> {
    let normalized_key = session_key.trim();
    if normalized_key.is_empty() {
        return Err("缺少 Gateway session key".to_string());
    }

    let profile_key = openclaw_connection::normalize_profile(profile.as_deref());
    let history_value = openclaw_gateway_connection::request(
        &app,
        Some(&profile_key),
        "chat.history",
        json!({
            "sessionKey": normalized_key,
            "limit": CONVERSATION_HISTORY_LIMIT,
        }),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await?;
    let history = extract_object_array(&history_value, &["messages"]);
    // `chat.history` has no offset, so a full page means the session is older
    // than what we can see. The UI needs to know, or it treats "not returned"
    // as "deleted" and drops everything it had cached before this window.
    let messages_truncated = history.len() as u64 >= CONVERSATION_HISTORY_LIMIT;
    let mut messages = map_gateway_history_messages(&history);
    if let Ok(local_messages) =
        load_local_gateway_usage_family_history(&profile_key, normalized_key)
    {
        messages = merge_conversation_history_messages(local_messages, messages);
    }
    // Skipped on a post-turn refresh: it is a second round trip that pages 200
    // sessions purely to read this one session's model / thinking level, neither
    // of which a finished turn can change.
    let sessions_value = if include_session_meta {
        openclaw_gateway_connection::request(
            &app,
            Some(&profile_key),
            "sessions.list",
            json!({
                "configuredAgentsOnly": true,
                "includeUnknown": true,
                "limit": 200,
            }),
            openclaw_gateway_connection::GatewayRequestOptions::default(),
        )
        .await?
    } else {
        Value::Null
    };
    let session_snapshot =
        gateway_session_snapshot_from_sessions_list(&sessions_value, normalized_key);
    let thinking_levels = session_snapshot
        .as_ref()
        .and_then(|session| session.get("thinkingLevels"))
        .map(gateway_thinking_levels_from_value)
        .or_else(|| {
            sessions_value
                .get("defaults")
                .and_then(|defaults| defaults.get("thinkingLevels"))
                .map(gateway_thinking_levels_from_value)
        })
        .unwrap_or_default();
    Ok(ConversationHistoryResult {
        session_key: normalized_key.to_string(),
        messages_truncated,
        has_active_run: history_value
            .get("sessionInfo")
            .and_then(|info| info.get("hasActiveRun"))
            .and_then(Value::as_bool)
            .or_else(|| history_value.get("inFlightRun").map(|run| !run.is_null())),
        in_flight_run_id: json_trimmed_string_at(&history_value, &["inFlightRun", "runId"])
            .map(str::to_string),
        in_flight_text: history_value
            .get("inFlightRun")
            .and_then(|run| run.get("text"))
            .and_then(Value::as_str)
            .map(str::to_string),
        session_id: json_trimmed_string_at(&history_value, &["sessionId"])
            .or_else(|| {
                session_snapshot
                    .as_ref()
                    .and_then(|session| json_trimmed_string_at(session, &["sessionId"]))
            })
            .map(str::to_string),
        messages,
        model_provider: session_snapshot
            .as_ref()
            .and_then(|session| json_trimmed_string_at(session, &["modelProvider"]))
            .or_else(|| json_trimmed_string_at(&sessions_value, &["defaults", "modelProvider"]))
            .map(str::to_string),
        model: session_snapshot
            .as_ref()
            .and_then(|session| json_trimmed_string_at(session, &["model"]))
            .or_else(|| json_trimmed_string_at(&sessions_value, &["defaults", "model"]))
            .map(str::to_string),
        thinking_level: json_trimmed_string_at(&history_value, &["thinkingLevel"])
            .or_else(|| {
                session_snapshot
                    .as_ref()
                    .and_then(|session| json_trimmed_string_at(session, &["thinkingLevel"]))
            })
            .map(str::to_string),
        reasoning_level: json_trimmed_string_at(&history_value, &["reasoningLevel"])
            .or_else(|| {
                session_snapshot
                    .as_ref()
                    .and_then(|session| json_trimmed_string_at(session, &["reasoningLevel"]))
            })
            .map(str::to_string),
        thinking_default: session_snapshot
            .as_ref()
            .and_then(|session| json_trimmed_string_at(session, &["thinkingDefault"]))
            .or_else(|| json_trimmed_string_at(&sessions_value, &["defaults", "thinkingDefault"]))
            .map(str::to_string),
        thinking_levels,
        provider_type: "openclaw".to_string(),
        data_flow: "openclaw.gateway.history".to_string(),
        transport: TARGET_TRANSPORT.to_string(),
        gateway_aligned: true,
    })
}

pub(crate) async fn conversation_send_turn_impl(
    app: AppHandle,
    req: ConversationTurnRequest,
) -> Result<ConversationTurnResult, String> {
    send_conversation_turn_inner(app, req).await
}

pub(crate) async fn conversation_abort_turn_impl(
    app: AppHandle,
    req: ConversationAbortRequest,
) -> Result<ConversationAbortResult, String> {
    let session_key = req.session_key.trim();
    if session_key.is_empty() {
        return Err("缺少 Gateway session key".to_string());
    }

    let profile_key = openclaw_connection::normalize_profile(req.profile.as_deref());
    let mut params = json!({
        "sessionKey": session_key,
    });
    if let Some(run_id) = req
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(object) = params.as_object_mut() {
            object.insert("runId".to_string(), json!(run_id));
        }
    }
    let payload = openclaw_gateway_connection::request(
        &app,
        Some(&profile_key),
        "chat.abort",
        params,
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await?;
    let run_ids = payload
        .get("runIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(ConversationAbortResult {
        ok: payload.get("ok").and_then(Value::as_bool).unwrap_or(true),
        aborted: payload
            .get("aborted")
            .and_then(Value::as_bool)
            .unwrap_or(!run_ids.is_empty()),
        run_ids,
        transport: TARGET_TRANSPORT.to_string(),
        gateway_aligned: true,
    })
}

pub(crate) async fn conversation_subscribe_session_impl(
    app: AppHandle,
    session_key: String,
    profile: Option<String>,
) -> Result<ConversationSubscribeSessionResult, String> {
    let normalized_key = session_key.trim();
    if normalized_key.is_empty() {
        return Err("缺少 Gateway session key".to_string());
    }

    let profile_key = openclaw_connection::normalize_profile(profile.as_deref());
    openclaw_gateway_connection::subscribe_session(&app, Some(&profile_key), normalized_key)
        .await?;

    Ok(ConversationSubscribeSessionResult {
        ok: true,
        session_key: normalized_key.to_string(),
        transport: TARGET_TRANSPORT.to_string(),
        gateway_aligned: true,
    })
}

pub async fn send_conversation_turn_inner(
    app: AppHandle,
    req: ConversationTurnRequest,
) -> Result<ConversationTurnResult, String> {
    let input = req.input.trim();
    if input.is_empty() && req.attachments.is_empty() {
        return Err("输入不能为空".to_string());
    }
    validate_conversation_attachments(&req.attachments)?;
    validate_requested_session_agent(req.session_key.as_deref(), req.agent_id.as_deref())?;

    let conversation_profile = normalize_conversation_profile(req.profile.as_deref());
    let (session_key, session_id) = resolve_gateway_session_for_turn(
        &app,
        conversation_profile.as_deref(),
        req.session_key.as_deref(),
        req.agent_id.as_deref(),
        req.conversation_id.as_deref(),
    )
    .await
    .map_err(|e| format!("创建或恢复 Uniopc 引擎 会话失败: {e}"))?;

    // Reject a second turn racing onto the same session (double-click / overlapping
    // sends). Held until this kickoff returns; released on any exit path.
    let _turn_guard = try_begin_turn(&session_key)
        .ok_or_else(|| "上一条消息还在发送中，请稍候再试。".to_string())?;

    validate_model_override_for_profile(
        &app,
        conversation_profile.as_deref(),
        req.model_override.as_deref(),
    )
    .await
    .map_err(|e| format!("校验 Uniopc 引擎 会话模型失败: {e}"))?;

    clear_local_session_model_overrides(conversation_profile.as_deref(), &session_key)
        .await
        .map_err(|e| format!("清理 Uniopc 引擎 会话模型覆盖失败: {e}"))?;

    apply_session_control_patch(
        &app,
        conversation_profile.as_deref(),
        &session_key,
        req.approval_mode.as_deref(),
    )
    .await
    .map_err(|e| format!("应用 Uniopc 引擎 会话策略失败: {e}"))?;

    let capabilities = if !req.tool_invocations.is_empty() {
        let profile_key = crate::services::openclaw_runtime::normalize_profile_key(
            conversation_profile.as_deref(),
        );
        let capabilities =
            openclaw_plugins::tool_capabilities_for_profile(&app, &profile_key).await?;
        validate_tool_invocations_against_capabilities(&req.tool_invocations, &capabilities)?;
        Some(capabilities)
    } else {
        None
    };
    let gateway_input = build_gateway_user_input_for_turn(
        conversation_profile.as_deref(),
        input,
        &req.mentions,
        &req.tool_invocations,
        capabilities.as_ref(),
    )
    .await;

    // A document body is never injected into the prompt. Only explicit `doc`
    // mention ids are recorded at the desktop-owned bridge boundary, replacing
    // any previous turn's grants for this session immediately before the turn
    // is forwarded to the local Engine.
    let document_ids = explicit_document_mention_ids(&req.mentions);
    if direct_document_generation_requested(&req.tool_invocations) {
        crate::services::local_documents_bridge::record_turn_document_generation_grant(
            &session_key,
        );
    } else if direct_local_workspace_access_requested(&req.tool_invocations) {
        crate::services::local_documents_bridge::record_turn_workspace_document_grant(
            &session_key,
            &document_ids,
        );
    } else {
        crate::services::local_documents_bridge::record_turn_document_grants(
            &session_key,
            &document_ids,
        );
    }
    // A generated video is displayed by the desktop client from delivery
    // metadata, but OpenClaw 8.1 cannot replay its structured `video` block
    // into a following model turn. Repair the durable transcript immediately
    // before every send so a user can continue the same chat without a restart.
    crate::commands::model::repair_openclaw_assistant_attachment_blocks(
        conversation_profile.as_deref(),
    )
    .map_err(|e| format!("准备 Uniopc 引擎 会话历史失败: {e}"))?;
    let run_id = match send_gateway_chat_message(
        &app,
        conversation_profile.as_deref(),
        req.conversation_id.as_deref(),
        &session_key,
        &gateway_input,
        &req.attachments,
        req.idempotency_key.as_deref(),
        req.thinking_override.as_deref(),
    )
    .await
    {
        Ok(run_id) => run_id,
        Err(error) => {
            crate::services::local_documents_bridge::clear_turn_document_grants(&session_key);
            return Err(format!("发送 Uniopc 引擎 对话失败: {error}"));
        }
    };
    crate::services::local_documents_bridge::bind_turn_document_grants_to_run(
        &session_key,
        &run_id,
    );

    Ok(ConversationTurnResult {
        content: String::new(),
        run_id: Some(run_id),
        provider_type: "openclaw".to_string(),
        model: "gateway-session".to_string(),
        data_flow: "openclaw.gateway.chat.accepted".to_string(),
        runtime_mode: CURRENT_MODE.to_string(),
        transport: CURRENT_TRANSPORT.to_string(),
        gateway_aligned: true,
        gateway_session_key: Some(session_key),
        gateway_session_id: session_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::openclaw_gateway_contract::SessionKind;

    #[test]
    fn local_attachment_import_checks_magic_bytes_and_extensions() {
        assert_eq!(conversation_attachment_kind("brief.pdf", b"%PDF-1.7"), Ok("application/pdf"));
        assert_eq!(conversation_attachment_kind("brief.txt", b"UTF-8 text"), Ok("text/plain"));
        assert!(conversation_attachment_kind("brief.pdf", b"not a PDF").is_err());
        assert!(conversation_attachment_kind("brief.txt", &[0xff, 0xfe]).is_err());
        assert!(conversation_attachment_kind("brief.exe", b"MZ").is_err());
    }

    #[test]
    fn local_attachment_import_enforces_count_before_reading_paths() {
        let paths = vec!["missing".to_string(); CONVERSATION_IMAGE_MAX_COUNT + 1];
        let error = import_conversation_attachments_to_dir(&paths, Path::new("unused"))
            .expect_err("more than four attachments must be rejected before filesystem access");
        assert!(error.contains("最多发送 4"));
    }

    #[test]
    fn local_attachment_import_stores_uuid_named_private_media_and_returns_metadata() {
        let root = std::env::temp_dir().join(format!("uniopc-attachment-test-{}", uuid::Uuid::new_v4()));
        let input = root.join("input");
        let inbound = root.join("inbound");
        fs::create_dir_all(&input).expect("input directory");
        fs::create_dir_all(&inbound).expect("inbound directory");
        let source = input.join("notes.txt");
        fs::write(&source, b"UTF-8 notes").expect("valid text file");

        let imported = import_conversation_attachments_to_dir(
            &[source.to_string_lossy().into_owned()],
            &inbound,
        ).expect("supported attachment imports");
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].name, "notes.txt");
        assert_eq!(imported[0].mime_type, "text/plain");
        assert_eq!(imported[0].size, b"UTF-8 notes".len());
        assert_eq!(fs::read(inbound.join(&imported[0].id)).expect("stored attachment"), b"UTF-8 notes");
        assert!(uuid::Uuid::parse_str(&imported[0].id).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_attachment_import_rejects_over_ten_mib_before_writing_managed_media() {
        let root = std::env::temp_dir().join(format!("uniopc-attachment-limit-{}", uuid::Uuid::new_v4()));
        let input = root.join("input");
        let inbound = root.join("inbound");
        fs::create_dir_all(&input).expect("input directory");
        fs::create_dir_all(&inbound).expect("inbound directory");
        let source = input.join("oversized.pdf");
        let mut contents = vec![0_u8; CONVERSATION_ATTACHMENT_MAX_BYTES + 1];
        contents[..5].copy_from_slice(b"%PDF-");
        fs::write(&source, contents).expect("oversized PDF fixture");

        let error = import_conversation_attachments_to_dir(
            &[source.to_string_lossy().into_owned()],
            &inbound,
        ).expect_err("oversized PDF must be rejected");
        assert!(error.contains("超过 10 MiB"));
        assert_eq!(fs::read_dir(&inbound).expect("inbound listing").count(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn imported_local_attachment_uses_uuid_only_chat_params_and_restores_from_gateway_history() {
        let root = std::env::temp_dir().join(format!("uniopc-attachment-e2e-{}", uuid::Uuid::new_v4()));
        let input = root.join("input");
        let inbound = root.join("state").join("media").join("inbound");
        fs::create_dir_all(&input).expect("input directory");
        fs::create_dir_all(&inbound).expect("managed inbound directory");
        let source = input.join("notes.txt");
        fs::write(&source, b"Local history round trip").expect("valid text file");

        let imported = import_conversation_attachments_to_dir(
            &[source.to_string_lossy().into_owned()],
            &inbound,
        ).expect("attachment imports to managed storage");
        let local_attachment = ConversationAttachment {
            attachment_type: "file".to_string(),
            mime_type: imported[0].mime_type.clone(),
            file_name: Some(imported[0].name.clone()),
            content: String::new(),
            local_media_id: Some(imported[0].id.clone()),
            size_bytes: Some(imported[0].size),
        };
        let prepared = prepare_gateway_conversation_attachments_in_dir(&inbound, &[local_attachment])
            .expect("trusted local ref validates before send");
        let params = build_gateway_chat_send_params(
            "agent:main:main",
            "读取这个文件",
            "run-attachment-e2e",
            &prepared,
            &[],
            None,
        ).expect("chat.send params build");

        let sent = &params["attachments"][0];
        assert_eq!(sent["localMediaId"], imported[0].id);
        assert_eq!(sent["fileName"], "notes.txt");
        assert_eq!(sent["mimeType"], "text/plain");
        assert_eq!(sent["sizeBytes"], imported[0].size);
        assert!(sent.get("content").is_none(), "file bytes must not enter chat.send");

        // OpenClaw's managed-media parser records the local absolute path and
        // detected MIME on its canonical history message. Verify Rust restores
        // those fields for the frontend's Tauri asset URL conversion.
        let history = vec![json!({
            "id": "gateway-user-attachment-e2e",
            "role": "user",
            "timestamp": 1_800_000_000_000_u64,
            "content": "读取这个文件",
            "MediaPaths": [imported[0].path],
            "MediaTypes": ["text/plain"],
        })];
        let restored = map_gateway_history_messages(&history);
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].media_paths, vec![imported[0].path.clone()]);
        assert_eq!(restored[0].media_types, vec!["text/plain"]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_attachment_import_rejects_symlinks_and_leaves_no_partial_copy() {
        let root = std::env::temp_dir().join(format!("uniopc-attachment-test-{}", uuid::Uuid::new_v4()));
        let input = root.join("input");
        let inbound = root.join("inbound");
        fs::create_dir_all(&input).expect("input directory");
        fs::create_dir_all(&inbound).expect("inbound directory");
        let valid = input.join("first.txt");
        fs::write(&valid, b"hello").expect("valid text file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let linked = input.join("linked.txt");
            symlink(&valid, &linked).expect("symlink");
            let error = import_conversation_attachments_to_dir(
                &[valid.to_string_lossy().into_owned(), linked.to_string_lossy().into_owned()],
                &inbound,
            ).expect_err("symbolic link must be rejected");
            assert!(error.contains("符号链接"));
            assert_eq!(fs::read_dir(&inbound).expect("inbound listing").count(), 0);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn in_flight_turn_guard_rejects_second_and_releases_on_drop() {
        let key = format!("agent:test-race-{}:main", std::process::id());
        let guard = try_begin_turn(&key).expect("first turn admitted");
        // Second concurrent send on the same session is rejected while in flight.
        assert!(try_begin_turn(&key).is_none());
        drop(guard);
        // Once the kickoff finished (guard dropped), the session admits a new turn.
        assert!(try_begin_turn(&key).is_some());
    }

    #[test]
    fn in_flight_turn_guard_allows_distinct_employee_sessions_in_parallel() {
        let prefix = format!("agent:parallel-{}", std::process::id());
        let sales = format!("{prefix}:sales:main");
        let support = format!("{prefix}:support:main");

        let sales_guard = try_begin_turn(&sales).expect("sales turn admitted");
        let support_guard = try_begin_turn(&support).expect("support turn admitted concurrently");

        // Each session remains independently protected against duplicate sends.
        assert!(try_begin_turn(&sales).is_none());
        assert!(try_begin_turn(&support).is_none());

        drop(sales_guard);
        drop(support_guard);
    }

    #[test]
    fn infer_employee_id_rejects_path_traversal_agent_segment() {
        // Legit slug / reserved ids pass through unchanged.
        assert_eq!(
            infer_employee_id_from_session_key("agent:sales-bot:main"),
            Some("sales-bot".to_string())
        );
        assert_eq!(
            infer_employee_id_from_session_key("agent:main:x"),
            Some("main".to_string())
        );
        // A hostile session key must not become a `..`-escaping sessions path.
        assert_eq!(
            infer_employee_id_from_session_key("agent:../../../../etc:x"),
            None
        );
        assert_eq!(infer_employee_id_from_session_key("agent:..:x"), None);
        assert_eq!(infer_employee_id_from_session_key("agent:a/b:x"), None);
    }

    #[test]
    fn rejects_a_turn_when_requested_session_belongs_to_another_employee() {
        let error =
            validate_requested_session_agent(Some("agent:main:main"), Some("superip-producer"))
                .expect_err("a Super IP turn must not be sent to the default assistant session");

        assert!(error.contains("会话不属于员工"));
    }

    #[test]
    fn maps_visible_user_message_from_gateway_context_wrapper() {
        let gateway_history = vec![
            json!({
                "id": "hidden-user",
                "role": "user",
                "timestamp": 1_000_u64,
                "content": [{"type": "text", "text": "_uniopc_context_hash:abc\n\nIMAI 员工运行上下文：\n- hidden\n\n用户原始消息：\n真实用户输入"}]
            }),
            json!({
                "id": "assistant-1",
                "role": "assistant",
                "timestamp": 1_500_u64,
                "content": [{"type": "text", "text": "收到"}]
            }),
        ];

        let mapped = map_gateway_history_messages(&gateway_history);
        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].id, "hidden-user");
        assert_eq!(mapped[0].role, "user");
        assert_eq!(mapped[0].content, "真实用户输入");
        assert_eq!(mapped[0].created_at, 1_000_u64);
        assert_eq!(mapped[1].role, "assistant");
    }

    #[test]
    fn filters_openclaw_heartbeat_bootstrap_messages() {
        let gateway_history = vec![
            json!({
                "id": "heartbeat-user",
                "role": "user",
                "timestamp": 1_000_u64,
                "content": [{
                    "type": "text",
                    "text": "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK."
                }]
            }),
            json!({
                "type": "message",
                "id": "heartbeat-poll-user",
                "timestamp": "2026-06-06T12:00:00.000Z",
                "message": {
                    "role": "user",
                    "timestamp": 1_780_754_039_339_u64,
                    "sourceChannel": "heartbeat",
                    "content": "[Uniopc 引擎 heartbeat poll]"
                }
            }),
            json!({
                "id": "assistant-1",
                "role": "assistant",
                "timestamp": 1_500_u64,
                "content": [{"type": "text", "text": "HEARTBEAT_OK"}]
            }),
            json!({
                "id": "bootstrap-user",
                "role": "user",
                "timestamp": 2_000_u64,
                "content": [{
                    "type": "text",
                    "text": "[Bootstrap pending]\nPlease read BOOTSTRAP.md from the workspace and follow it before replying normally.\nDo not use a generic first greeting or reply normally until after you have handled BOOTSTRAP.md."
                }]
            }),
            json!({
                "id": "assistant-2",
                "role": "assistant",
                "timestamp": 2_500_u64,
                "content": [{"type": "text", "text": "在，Elon 在线。"}]
            }),
        ];

        let mapped = map_gateway_history_messages(&gateway_history);
        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].role, "assistant");
        assert_eq!(mapped[1].role, "assistant");
        assert_eq!(mapped[1].content, "在，Elon 在线。");
    }

    #[test]
    fn maps_official_openclaw_wrapped_history_messages() {
        let gateway_history = vec![
            json!({
                "type": "message",
                "id": "outer-user",
                "timestamp": "2026-06-04T01:15:00.000Z",
                "message": {
                    "role": "user",
                    "content": "官方浏览器是插件还是独立浏览器",
                    "timestamp": 1_780_528_500_000_u64,
                    "idempotencyKey": "run:user"
                }
            }),
            json!({
                "type": "message",
                "id": "outer-assistant",
                "timestamp": "2026-06-04T01:17:00.000Z",
                "message": {
                    "role": "assistant",
                    "content": [{
                        "type": "text",
                        "text": "现在这轮里没有可用的浏览器控制工具。"
                    }],
                    "timestamp": 1_780_528_620_000_u64,
                    "stopReason": "stop"
                }
            }),
        ];

        let mapped = map_gateway_history_messages(&gateway_history);

        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].id, "outer-user");
        assert_eq!(mapped[0].role, "user");
        assert_eq!(mapped[0].content, "官方浏览器是插件还是独立浏览器");
        assert_eq!(mapped[0].created_at, 1_780_528_500_000_u64);
        assert_eq!(mapped[1].id, "outer-assistant");
        assert_eq!(mapped[1].role, "assistant");
        assert_eq!(mapped[1].content, "现在这轮里没有可用的浏览器控制工具。");
        assert_eq!(mapped[1].created_at, 1_780_528_620_000_u64);
    }

    #[test]
    fn maps_official_chat_history_string_message_content() {
        let gateway_history = vec![json!({
            "id": "assistant-final",
            "role": "assistant",
            "timestamp": "2026-06-04T01:20:00.000Z",
            "message": "Done"
        })];

        let mapped = map_gateway_history_messages(&gateway_history);

        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].role, "assistant");
        assert_eq!(mapped[0].content, "Done");
        assert!(mapped[0].created_at > 0);
    }

    #[test]
    fn history_drops_a_stream_failure_fallback_when_the_same_turn_has_a_reply() {
        let gateway_history = vec![
            json!({
                "id": "assistant-fallback",
                "role": "assistant",
                "timestamp": 1_000_u64,
                "content": [{ "type": "text", "text": "The agent run failed before producing a reply." }]
            }),
            json!({
                "id": "assistant-reply",
                "role": "assistant",
                "timestamp": 1_100_u64,
                "content": [{ "type": "text", "text": "[assistant turn failed before producing content] Hey 👋 在的。" }]
            }),
        ];

        let mapped = map_gateway_history_messages(&gateway_history);

        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].id, "assistant-reply");
        assert_eq!(mapped[0].content, "Hey 👋 在的。");
    }

    #[test]
    fn history_strips_every_repeated_stream_failure_marker_from_a_reply() {
        let marker = OPENCLAW_STREAM_FAILURE_MARKER;
        let gateway_history = vec![json!({
            "id": "assistant-reply",
            "role": "assistant",
            "timestamp": 1_100_u64,
            "content": [{
                "type": "text",
                "text": format!("{marker}\n{marker}\n引擎正常，我可以继续处理。")
            }]
        })];

        let mapped = map_gateway_history_messages(&gateway_history);

        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].content, "引擎正常，我可以继续处理。");
    }

    #[test]
    fn gateway_user_input_leaves_plain_messages_unwrapped() {
        let input = build_gateway_user_input("hey", None, None, &[]);

        assert_eq!(input, "hey");
        assert!(!input.starts_with(INTERNAL_CONTEXT_MARKER));
        assert!(!is_internal_context_text(&input));
    }

    #[test]
    fn gateway_user_input_can_include_hidden_uniopc_context() {
        let input = build_gateway_user_input(
            "你在哪些项目中",
            Some("Uniopc 当前对话上下文：\n- 当前项目：Default"),
            None,
            &[],
        );

        assert!(input.starts_with(INTERNAL_CONTEXT_MARKER));
        assert!(input.contains("当前项目：Default"));
        assert!(input.contains("用户原始消息：\n你在哪些项目中"));
        assert!(is_internal_context_text(&input));
    }

    fn browser_runtime_snapshot_for_test(
        status: &str,
        execution_target: &str,
        error: Option<openclaw_browser::BrowserRuntimeError>,
    ) -> openclaw_browser::BrowserRuntimeSnapshot {
        openclaw_browser::BrowserRuntimeSnapshot {
            profile: "openclaw".to_string(),
            browser_profile: "openclaw".to_string(),
            enabled: true,
            status: status.to_string(),
            execution_target: execution_target.to_string(),
            execution_target_label: if execution_target == "host" {
                "Host browser".to_string()
            } else {
                "This Mac browser".to_string()
            },
            message: "Browser Runtime ready.".to_string(),
            next_action: if status == "ready" {
                "use_browser".to_string()
            } else {
                "approve_pairing_scope_upgrade".to_string()
            },
            browser_status: Some(json!({"ok": true})),
            profiles: vec![json!({"name": "openclaw"})],
            tabs: vec![json!({"targetId": "tab-1", "url": "https://x.com"})],
            pending_requests: Vec::new(),
            paired_devices: Vec::new(),
            error,
        }
    }

    #[test]
    fn gateway_user_input_includes_live_browser_runtime_snapshot() {
        let snapshot = browser_runtime_snapshot_for_test("ready", "host", None);

        let input = build_gateway_user_input("打开 x.com", None, Some(&snapshot), &[]);

        assert!(input.contains("Uniopc Browser Runtime 状态"));
        assert!(input.contains("- 状态：ready"));
        assert!(input.contains("- 执行位置：Host browser (host)"));
        assert!(input.contains("- Browser profile：openclaw"));
        assert!(input.contains("- Tabs 数：1"));
        assert!(input.contains("必须优先使用官方 Uniopc 引擎 browser tool"));
        assert!(input.contains("不能改用系统默认浏览器"));
    }

    #[test]
    fn gateway_user_input_warns_when_browser_scope_upgrade_is_pending() {
        let snapshot = browser_runtime_snapshot_for_test(
            "scope_upgrade_pending_approval",
            "this_mac",
            Some(openclaw_browser::BrowserRuntimeError {
                kind: "scope_upgrade_pending_approval".to_string(),
                message: "pairing required: device is asking for more scopes".to_string(),
                next_action: "approve_pairing_scope_upgrade".to_string(),
            }),
        );

        let input = build_gateway_user_input("打开 x.com", None, Some(&snapshot), &[]);

        assert!(input.contains("- 状态：scope_upgrade_pending_approval"));
        assert!(input.contains("scope_upgrade_pending_approval: pairing required"));
        assert!(input.contains("批准"));
        assert!(input.contains("停止继续自动化"));
    }

    #[test]
    fn gateway_user_input_does_not_claim_browser_tool_when_gateway_rpc_is_missing() {
        let snapshot = browser_runtime_snapshot_for_test(
            "gateway_browser_rpc_unsupported",
            "this_mac",
            Some(openclaw_browser::BrowserRuntimeError {
                kind: "gateway_browser_rpc_unsupported".to_string(),
                message: "browser.request unavailable".to_string(),
                next_action: "use_native_browser".to_string(),
            }),
        );

        let input = build_gateway_user_input("打开 x.com", None, Some(&snapshot), &[]);

        assert!(input.contains("没有可调用的 browser tool"));
        assert!(input.contains("不要声称你已打开"));
    }

    #[test]
    fn browser_runtime_context_is_only_needed_for_browser_related_turns() {
        assert!(!conversation_turn_needs_browser_runtime_context(
            "介绍下你自己",
            &[],
            &[],
        ));
        assert!(conversation_turn_needs_browser_runtime_context(
            "打开 x.com 看一下",
            &[],
            &[],
        ));
        assert!(conversation_turn_needs_browser_runtime_context(
            "检查一下",
            &[ConversationMention {
                kind: "mcp".to_string(),
                name: "playwright".to_string(),
                label: None,
                summary: None,
                trigger: Some("slash".to_string()),
            }],
            &[],
        ));
        assert!(conversation_turn_needs_browser_runtime_context(
            "检查一下",
            &[],
            &[ConversationToolInvocation {
                plugin_id: "browser-automation".to_string(),
                tool_name: None,
                trigger: Some("slash".to_string()),
            }],
        ));
    }

    #[test]
    fn cached_device_token_must_cover_official_operator_scopes() {
        let stale_token = StoredGatewayDeviceToken {
            device_id: "device-1".to_string(),
            device_token: "token".to_string(),
            role: Some("operator".to_string()),
            scopes: vec!["operator.read".to_string(), "operator.write".to_string()],
            created_at: "2026-06-04T00:00:00Z".to_string(),
            updated_at: "2026-06-04T00:00:00Z".to_string(),
        };
        let fresh_token = StoredGatewayDeviceToken {
            scopes: operator_connect_scopes(),
            ..stale_token.clone()
        };

        assert!(!cached_device_token_covers_requested_scopes(&stale_token));
        assert!(cached_device_token_covers_requested_scopes(&fresh_token));
    }

    #[test]
    fn pairing_approval_prefers_official_operator_scope_upgrade_request() {
        let request_id = select_pairing_request_to_approve(vec![
            json!({
                "requestId": "ordinary-device",
                "scopes": ["operator.read"]
            }),
            json!({
                "requestId": "browser-scope-upgrade",
                "scopes": ["operator.admin"]
            }),
        ])
        .expect("request id");

        assert_eq!(request_id, "browser-scope-upgrade");
    }

    #[test]
    fn pairing_approval_falls_back_to_first_pending_request() {
        let request_id = select_pairing_request_to_approve(vec![json!({
            "id": "ordinary-device",
            "scopes": ["operator.read"]
        })])
        .expect("request id");

        assert_eq!(request_id, "ordinary-device");
    }

    #[test]
    fn tauri_connect_result_does_not_expose_gateway_error_details() {
        let result = build_gateway_connect_attempt_result(
            json!({
                "type": "res",
                "id": "connect-1",
                "ok": false,
                "error": {
                    "code": "UNAVAILABLE",
                    "message": "token=tauri-secret C:\\\\private\\\\openclaw-engine",
                    "details": { "traceId": "trace-tauri" }
                }
            }),
            GatewayConnectPreview {
                ws_url: "ws://fixture.invalid".to_string(),
                auth_mode: "token".to_string(),
                role: "operator".to_string(),
                scopes: vec![],
                challenge_nonce: "fixture".to_string(),
                challenge_ts: None,
                signature_payload_version: "v3".to_string(),
                signature_hex_preview: "fixture".to_string(),
                connect_request_preview: json!({}),
            },
            false,
            false,
        );
        let serialized = serde_json::to_string(&result).expect("Tauri DTO serializes");

        assert!(serialized.contains("gateway.unavailable"));
        assert!(!serialized.contains("trace-tauri"));
        assert!(
            uuid::Uuid::parse_str(&result.gateway_error.expect("normalized error").trace_id)
                .is_ok()
        );
        assert!(!serialized.contains("tauri-secret"));
        assert!(!serialized.contains("openclaw-engine"));
    }

    #[test]
    fn tauri_connect_result_rejects_untrusted_recovery_hint() {
        let result = build_gateway_connect_attempt_result(
            json!({
                "type": "res",
                "id": "connect-1",
                "ok": false,
                "error": {
                    "code": "TOKEN=C0DE C:\\private\\OpenClaw",
                    "message": "token=message-secret C:\\private\\OpenClaw",
                    "details": {
                        "traceId": "token=trace-secret/C:\\private\\OpenClaw/../../escape",
                        "recommendedNextStep": "token=next-secret C:\\private\\OpenClaw"
                    }
                }
            }),
            GatewayConnectPreview {
                ws_url: "ws://fixture.invalid".to_string(),
                auth_mode: "token".to_string(),
                role: "operator".to_string(),
                scopes: vec![],
                challenge_nonce: "fixture".to_string(),
                challenge_ts: None,
                signature_payload_version: "v3".to_string(),
                signature_hex_preview: "fixture".to_string(),
                connect_request_preview: json!({}),
            },
            false,
            false,
        );
        let serialized = serde_json::to_string(&result).expect("Tauri DTO serializes");

        assert_eq!(result.recommended_next_step, None);
        let error = result
            .gateway_error
            .as_ref()
            .expect("normalized Gateway error");
        assert_eq!(error.code, "GATEWAY_ERROR");
        assert!(uuid::Uuid::parse_str(&error.trace_id).is_ok());
        for secret in [
            "C0DE",
            "message-secret",
            "trace-secret",
            "next-secret",
            "private",
            "OpenClaw",
        ] {
            assert!(!serialized.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn successful_tauri_connect_result_redacts_issued_device_token() {
        let mut hello: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/openclaw-2026.8.1/hello-ok.json"
        )))
        .expect("hello fixture");
        hello["server"]["version"] = Value::String(env!("IMAI_OPENCLAW_VERSION").to_string());
        hello["auth"]["deviceToken"] = Value::String("issued-device-secret".to_string());
        hello["auth"]["scopes"] = json!(["operator.read", "operator.write", "secret-scope-token"]);
        let result = build_gateway_connect_attempt_result(
            json!({ "type": "res", "id": "connect-1", "ok": true, "payload": hello }),
            GatewayConnectPreview {
                ws_url: "ws://fixture.invalid".to_string(),
                auth_mode: "token".to_string(),
                role: "operator".to_string(),
                scopes: vec![],
                challenge_nonce: "fixture".to_string(),
                challenge_ts: None,
                signature_payload_version: "v3".to_string(),
                signature_hex_preview: "fixture".to_string(),
                connect_request_preview: json!({}),
            },
            false,
            false,
        );
        let serialized = serde_json::to_string(&result).expect("Tauri DTO serializes");

        assert!(result.success);
        assert!(result.device_token_issued);
        assert!(!serialized.contains("issued-device-secret"));
        assert!(!serialized.contains("secret-scope-token"));
        assert!(!serialized.contains("deviceToken"));
        assert!(!serialized.contains("conn_id"));
        assert!(!serialized.contains("connId"));
    }

    #[test]
    fn successful_tauri_connect_result_never_echoes_gateway_conn_id() {
        let mut hello: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/openclaw-2026.8.1/hello-ok.json"
        )))
        .expect("hello fixture");
        hello["server"]["version"] = Value::String(env!("IMAI_OPENCLAW_VERSION").to_string());
        hello["server"]["connId"] =
            Value::String("AlphanumericConnSecret123 C:\\private\\OpenClaw".to_string());
        let result = build_gateway_connect_attempt_result(
            json!({ "type": "res", "id": "connect-1", "ok": true, "payload": hello }),
            GatewayConnectPreview {
                ws_url: "ws://fixture.invalid".to_string(),
                auth_mode: "token".to_string(),
                role: "operator".to_string(),
                scopes: vec![],
                challenge_nonce: "fixture".to_string(),
                challenge_ts: None,
                signature_payload_version: "v3".to_string(),
                signature_hex_preview: "fixture".to_string(),
                connect_request_preview: json!({}),
            },
            false,
            false,
        );
        let serialized = serde_json::to_string(&result).expect("Tauri DTO serializes");

        assert!(!result.success);
        assert_eq!(result.conn_id, None);
        assert!(!serialized.contains("conn_id"));
        assert!(!serialized.contains("connId"));
        for secret in ["AlphanumericConnSecret123", "private", "OpenClaw"] {
            assert!(!serialized.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn pairing_approval_parses_json_after_gateway_warning() {
        let raw = parse_json_object_from_mixed_output(
            "gateway connect failed: GatewayClientRequestError: scope upgrade pending approval\n\
             {\"approved\":true,\"requestId\":\"browser-scope-upgrade\"}",
        )
        .expect("json object");

        assert_eq!(
            raw.get("requestId").and_then(Value::as_str),
            Some("browser-scope-upgrade")
        );
        assert_eq!(raw.get("approved").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn conversation_accepts_member_openclaw_profile_keys() {
        assert_eq!(
            normalize_conversation_profile(Some("alice")),
            Some("alice".to_string())
        );
        assert_eq!(
            normalize_conversation_profile(Some(" imai ")),
            Some("imai".to_string())
        );
        assert_eq!(normalize_conversation_profile(None), None);
    }

    #[test]
    fn conversation_send_does_not_copy_model_auth_between_profiles() {
        let source = include_str!("mod.rs");
        let start = source
            .find("pub async fn send_conversation_turn_inner")
            .expect("send turn function");
        let end = source[start..]
            .find("fn build_gateway_user_input")
            .map(|offset| start + offset)
            .expect("next helper");
        let send_turn = &source[start..end];

        assert!(!send_turn.contains("sync_member_profile_codex_auth_from_owner"));
    }

    #[test]
    fn conversation_send_skips_browser_runtime_snapshot_on_plain_turns() {
        let source = include_str!("mod.rs");
        let start = source
            .find("pub async fn send_conversation_turn_inner")
            .expect("send turn function");
        let end = source[start..]
            .find("let run_id = send_gateway_chat_message")
            .map(|offset| start + offset)
            .expect("send call");
        let send_turn_setup = &source[start..end];

        assert!(!send_turn_setup.contains("openclaw_browser::runtime_snapshot"));
        assert!(send_turn_setup.contains("build_gateway_user_input_for_turn("));
    }

    #[test]
    fn conversation_send_uses_existing_session_key_without_creating_each_turn() {
        let source = include_str!("mod.rs");
        let start = source
            .find("pub async fn send_conversation_turn_inner")
            .expect("send turn function");
        let end = source[start..]
            .find("validate_model_override_for_profile")
            .map(|offset| start + offset)
            .expect("model validation");
        let send_turn_setup = &source[start..end];

        assert!(!send_turn_setup.contains("ensure_gateway_session("));
        assert!(send_turn_setup.contains("resolve_gateway_session_for_turn("));
    }

    #[test]
    fn conversation_send_repairs_display_only_media_before_gateway_send() {
        let source = include_str!("mod.rs");
        let start = source
            .find("pub async fn send_conversation_turn_inner")
            .expect("send turn function");
        let end = source[start..]
            .find("let run_id = match send_gateway_chat_message")
            .map(|offset| start + offset)
            .expect("send call");
        let setup = &source[start..end];

        assert!(setup.contains("repair_openclaw_assistant_attachment_blocks"));
    }

    #[test]
    fn chat_send_hot_path_does_not_subscribe_session() {
        let source = include_str!("mod.rs");
        let start = source
            .find("async fn send_gateway_chat_message")
            .expect("send helper");
        let end = source[start..]
            .find("fn build_gateway_connect_attempt_result")
            .map(|offset| start + offset)
            .expect("next helper");
        let send_helper = &source[start..end];

        assert!(!send_helper.contains("subscribe_session"));
    }

    #[test]
    fn chat_send_marks_missing_gateway_response_as_delivery_unconfirmed() {
        let source = include_str!("mod.rs");
        let start = source
            .find("async fn send_gateway_chat_message")
            .expect("send helper");
        let end = source[start..]
            .find("fn build_gateway_connect_attempt_result")
            .map(|offset| start + offset)
            .expect("next helper");
        let send_helper = &source[start..end];

        assert!(send_helper.contains("allow_recovery: false"));
        assert!(send_helper.contains("delivery_unconfirmed:"));
        assert!(send_helper.contains("is_gateway_response_rejection(&error)"));
    }

    #[test]
    fn gateway_response_rejections_remain_definite_failures() {
        assert!(is_gateway_response_rejection(
            "Gateway chat.send 请求失败: {\"code\":\"INVALID_REQUEST\",\"message\":\"bad input\"}"
        ));
        assert!(!is_gateway_response_rejection(
            "Gateway chat.send 请求失败: timed out"
        ));
    }

    #[test]
    fn gateway_unavailable_message_names_requested_profile() {
        let message =
            conversation_gateway_unavailable_message("bootiful-wtf-4a58b3ae", Some("refused"));

        assert!(message.contains("profile `bootiful-wtf-4a58b3ae`"));
        assert!(message.contains("详情：refused"));
    }

    #[test]
    fn gateway_user_input_includes_explicit_mentions() {
        let mentions = vec![
            ConversationMention {
                kind: "plugin".to_string(),
                name: "xhs-insights-openclaw-plugin".to_string(),
                label: None,
                summary: None,
                trigger: None,
            },
            ConversationMention {
                kind: "mcp".to_string(),
                name: "tikhub-xiaohongshu".to_string(),
                label: None,
                summary: None,
                trigger: None,
            },
            ConversationMention {
                kind: "skill".to_string(),
                name: "browser-automation".to_string(),
                label: None,
                summary: None,
                trigger: None,
            },
            ConversationMention {
                kind: "project".to_string(),
                name: "project-1".to_string(),
                label: Some("短剧项目".to_string()),
                summary: Some("可见项目".to_string()),
                trigger: None,
            },
            ConversationMention {
                kind: "doc".to_string(),
                name: "doc-1".to_string(),
                label: Some("投放复盘".to_string()),
                summary: Some("可见文档".to_string()),
                trigger: None,
            },
        ];
        let input = build_gateway_user_input("查一下小红书", None, None, &mentions);

        assert!(input.contains("用户本轮显式 @ 了以下项目/文档上下文"));
        assert!(!input.contains("Uniopc 引擎 plugin: `xhs-insights-openclaw-plugin`"));
        assert!(!input.contains("MCP server: `tikhub-xiaohongshu`"));
        assert!(!input.contains("Skill: `browser-automation`"));
        assert!(input.contains("Project: `短剧项目` (`project-1`)"));
        assert!(input.contains("Document: `投放复盘` (`doc-1`)"));
        assert!(input.contains("用户原始消息：\n查一下小红书"));
    }

    #[test]
    fn turn_grants_include_only_explicit_document_mentions() {
        let mentions = vec![
            ConversationMention {
                kind: "doc".to_string(),
                name: " doc-1 ".to_string(),
                label: Some("Private note".to_string()),
                summary: Some("must not be injected into grants".to_string()),
                trigger: None,
            },
            ConversationMention {
                kind: "project".to_string(),
                name: "project-1".to_string(),
                label: None,
                summary: None,
                trigger: None,
            },
            ConversationMention {
                kind: "doc".to_string(),
                name: "doc-1".to_string(),
                label: None,
                summary: None,
                trigger: None,
            },
        ];

        assert_eq!(explicit_document_mention_ids(&mentions), vec!["doc-1"]);
    }

    #[test]
    fn direct_local_workspace_plugin_invocation_authorizes_this_turns_workspace() {
        let direct = vec![ConversationToolInvocation {
            plugin_id: "uniopc-local-workspace".to_string(),
            tool_name: None,
            trigger: Some("slash".to_string()),
        }];
        let other_plugin = vec![ConversationToolInvocation {
            plugin_id: "browser-automation".to_string(),
            tool_name: None,
            trigger: Some("slash".to_string()),
        }];
        let non_direct = vec![ConversationToolInvocation {
            plugin_id: "uniopc-local-workspace".to_string(),
            tool_name: None,
            trigger: None,
        }];

        assert!(direct_local_workspace_access_requested(&direct));
        assert!(!direct_local_workspace_access_requested(&other_plugin));
        assert!(!direct_local_workspace_access_requested(&non_direct));
    }

    #[test]
    fn gateway_user_input_distinguishes_slash_tool_invocations() {
        let mentions = vec![
            ConversationMention {
                kind: "plugin".to_string(),
                name: "uniopc-cloud-workspace".to_string(),
                label: None,
                summary: None,
                trigger: Some("slash".to_string()),
            },
            ConversationMention {
                kind: "mcp".to_string(),
                name: "telegram".to_string(),
                label: None,
                summary: None,
                trigger: Some("slash".to_string()),
            },
        ];
        let input = build_gateway_user_input("创建文档", None, None, &mentions);

        assert!(input.contains("用户本轮显式 / 调用了以下已安装能力"));
        assert!(input.contains("Uniopc 引擎 plugin: `uniopc-cloud-workspace`"));
        assert!(input.contains("MCP server: `telegram`"));
        assert!(input.contains("请把这些 / 调用视为用户明确要求使用的能力"));
        assert!(input.contains("能力既可能是工具，也可能是已加载的 Skill"));
    }

    #[test]
    fn skill_pack_invocation_context_routes_documents_to_its_loaded_skills() {
        let invocations = vec![ConversationToolInvocation {
            plugin_id: "uniopc-documents".to_string(),
            tool_name: None,
            trigger: Some("slash".to_string()),
        }];
        let capabilities = openclaw_plugins::OpenClawProfileToolCapabilitiesSnapshot {
            profile: "test".to_string(),
            gateway_supports_tool_constraints: false,
            plugins: vec![openclaw_plugins::OpenClawProfileToolCapabilityPlugin {
                id: "uniopc-documents".to_string(),
                title: "文档处理".to_string(),
                description: String::new(),
                official: true,
                enabled: true,
                installed: true,
                status: "ready".to_string(),
                business_health_state: String::new(),
                business_health_label: String::new(),
                readiness_reasons: Vec::new(),
                tools: Vec::new(),
                has_skills: true,
                skill_names: vec!["docx".to_string(), "pdf".to_string()],
            }],
        };

        let context = skill_pack_invocation_context(&invocations, &capabilities)
            .expect("ready skill pack should produce per-turn routing context");

        assert!(context.contains("`uniopc-documents` 是已就绪的技能包"));
        assert!(context.contains("`docx`、`pdf`"));
        assert!(context.contains("不要改用不相关的本地 Markdown 文档工具"));
        assert!(context.contains("直接按 `docx` Skill 的工作流"));
        assert!(context.contains("不要在工具清单中查找 Skill"));
    }

    #[test]
    fn skill_pack_invocation_context_ignores_tool_level_calls() {
        let invocations = vec![ConversationToolInvocation {
            plugin_id: "uniopc-documents".to_string(),
            tool_name: Some("some_tool".to_string()),
            trigger: Some("slash".to_string()),
        }];
        let capabilities = openclaw_plugins::OpenClawProfileToolCapabilitiesSnapshot {
            profile: "test".to_string(),
            gateway_supports_tool_constraints: false,
            plugins: Vec::new(),
        };

        assert!(skill_pack_invocation_context(&invocations, &capabilities).is_none());
    }

    #[test]
    fn chat_send_params_include_image_attachments() {
        let attachments = vec![ConversationAttachment {
            attachment_type: "image".to_string(),
            mime_type: "image/png".to_string(),
            file_name: Some("screen.png".to_string()),
            content: "aGVsbG8=".to_string(),
            local_media_id: None,
            size_bytes: None,
        }];

        let params = build_gateway_chat_send_params(
            "agent:main:main",
            "看一下这张图",
            "run-1",
            &attachments,
            &[],
            None,
        )
        .expect("chat send params");

        assert_eq!(params["sessionKey"], "agent:main:main");
        assert_eq!(params["message"], "看一下这张图");
        assert_eq!(params["attachments"][0]["type"], "image");
        assert_eq!(params["attachments"][0]["mimeType"], "image/png");
        assert_eq!(params["attachments"][0]["fileName"], "screen.png");
        assert_eq!(params["attachments"][0]["content"], "aGVsbG8=");
    }

    #[test]
    fn chat_send_params_default_missing_image_file_name() {
        let attachments = vec![ConversationAttachment {
            attachment_type: "image".to_string(),
            mime_type: "image/jpeg".to_string(),
            file_name: None,
            content: "aGVsbG8=".to_string(),
            local_media_id: None,
            size_bytes: None,
        }];

        let params = build_gateway_chat_send_params(
            "agent:main:main",
            "看一下这张图",
            "run-1",
            &attachments,
            &[],
            None,
        )
        .expect("chat send params");

        assert_eq!(params["attachments"][0]["fileName"], "image.jpg");
    }

    #[test]
    fn chat_send_params_include_pdf_attachments() {
        let attachments = vec![ConversationAttachment {
            attachment_type: "file".to_string(),
            mime_type: "application/pdf".to_string(),
            file_name: Some("report.pdf".to_string()),
            content: "JVBERg==".to_string(),
            local_media_id: None,
            size_bytes: None,
        }];

        let params = build_gateway_chat_send_params(
            "agent:main:main",
            "读取这个 PDF",
            "run-1",
            &attachments,
            &[],
            None,
        )
        .expect("PDF chat send params");

        assert_eq!(params["attachments"][0]["type"], "file");
        assert_eq!(params["attachments"][0]["mimeType"], "application/pdf");
        assert_eq!(params["attachments"][0]["fileName"], "report.pdf");
        assert_eq!(params["attachments"][0]["content"], "JVBERg==");
    }

    #[test]
    fn chat_send_params_include_valid_thinking_override() {
        let attachments = Vec::new();

        let params = build_gateway_chat_send_params(
            "agent:main:main",
            "介绍下",
            "run-1",
            &attachments,
            &[],
            Some("medium"),
        )
        .expect("chat send params");

        assert_eq!(params["thinking"], "medium");
    }

    #[test]
    fn chat_send_params_reject_invalid_thinking_override() {
        let attachments = Vec::new();

        let error = build_gateway_chat_send_params(
            "agent:main:main",
            "介绍下",
            "run-1",
            &attachments,
            &[],
            Some("ultra"),
        )
        .expect_err("invalid thinking rejected");

        assert!(error.contains("未知 Uniopc 引擎 thinking 模式"));
    }

    #[test]
    fn chat_send_params_omit_tool_constraint_fields_before_validation() {
        let attachments = Vec::new();
        let invocations = vec![ConversationToolInvocation {
            plugin_id: "uniopc-cloud-workspace".to_string(),
            tool_name: Some("imai_cloud_document_create".to_string()),
            trigger: Some("slash".to_string()),
        }];

        let params = build_gateway_chat_send_params(
            "agent:main:main",
            "创建文档",
            "run-1",
            &attachments,
            &invocations,
            None,
        )
        .expect("chat send params");

        assert_eq!(params["allowedTools"], Value::Null);
        assert_eq!(params["toolChoice"], Value::Null);
    }

    #[test]
    fn chat_send_params_omit_tool_constraint_fields_after_validation() {
        let attachments = Vec::new();
        let invocations = vec![ConversationToolInvocation {
            plugin_id: "uniopc-cloud-workspace".to_string(),
            tool_name: Some("imai_cloud_document_create".to_string()),
            trigger: Some("slash".to_string()),
        }];

        let params = build_gateway_chat_send_params(
            "agent:main:main",
            "创建文档",
            "run-1",
            &attachments,
            &invocations,
            None,
        )
        .expect("chat send params");

        assert_eq!(params["allowedTools"], Value::Null);
        assert_eq!(params["toolChoice"], Value::Null);
    }

    #[test]
    fn chat_send_params_keep_plugin_level_invocation_out_of_gateway_params() {
        let attachments = Vec::new();
        let invocations = vec![ConversationToolInvocation {
            plugin_id: "uniopc-cloud-workspace".to_string(),
            tool_name: None,
            trigger: Some("slash".to_string()),
        }];

        let params = build_gateway_chat_send_params(
            "agent:main:main",
            "用 workspace",
            "run-1",
            &attachments,
            &invocations,
            None,
        )
        .expect("chat send params");

        assert_eq!(params["allowedTools"], Value::Null);
        assert_eq!(params["toolChoice"], Value::Null);
    }

    #[test]
    fn chat_send_params_keep_mixed_tool_invocations_out_of_gateway_params() {
        let attachments = Vec::new();
        let invocations = vec![
            ConversationToolInvocation {
                plugin_id: "uniopc-cloud-workspace".to_string(),
                tool_name: Some("imai_cloud_document_create".to_string()),
                trigger: Some("slash".to_string()),
            },
            ConversationToolInvocation {
                plugin_id: "uniopc-socials".to_string(),
                tool_name: Some("uniopc_socials_discover_leads".to_string()),
                trigger: Some("slash".to_string()),
            },
        ];

        let params = build_gateway_chat_send_params(
            "agent:main:main",
            "用 workspace",
            "run-1",
            &attachments,
            &invocations,
            None,
        )
        .expect("chat send params");

        assert_eq!(params["allowedTools"], Value::Null);
        assert_eq!(params["toolChoice"], Value::Null);
    }

    #[test]
    fn chat_send_params_reject_unsupported_file_attachments() {
        let attachments = vec![ConversationAttachment {
            attachment_type: "file".to_string(),
            mime_type: "text/plain".to_string(),
            file_name: Some("notes.txt".to_string()),
            content: "aGVsbG8=".to_string(),
            local_media_id: None,
            size_bytes: None,
        }];

        let error = build_gateway_chat_send_params(
            "agent:main:main",
            "读取附件",
            "run-1",
            &attachments,
            &[],
            None,
        )
        .expect_err("unsupported file attachment rejected");

        assert!(error.contains("仅支持图片或 PDF 附件"));
    }

    #[test]
    fn session_patch_params_map_user_permission_control_to_openclaw_fields() {
        let patch = build_session_control_patch(Some("direct")).expect("control patch");

        let params = build_session_patch_params("agent:main:main", patch);

        assert_eq!(params["key"], "agent:main:main");
        assert_eq!(params["permissionMode"], "full");
        assert_eq!(params.get("execSecurity"), None);
        assert_eq!(params.get("execAsk"), None);
        assert_eq!(params.get("model"), None);
        assert_eq!(params.get("patch"), None);
    }

    #[test]
    fn session_model_patch_matches_official_gateway_shape() {
        let patch = build_session_model_patch(Some("qwen/qwen3.7-plus")).expect("model patch");
        let params = build_session_patch_params("agent:main:main", patch);

        assert_eq!(params["key"], "agent:main:main");
        assert_eq!(params["model"], "qwen/qwen3.7-plus");

        let default_patch = build_session_model_patch(None).expect("default model patch");
        let default_params = build_session_patch_params("agent:main:main", default_patch);
        assert!(default_params["model"].is_null());
    }

    #[test]
    fn session_thinking_patch_matches_official_gateway_shape() {
        let (patch, thinking_level) =
            build_session_thinking_patch(Some("medium")).expect("thinking patch");
        let params = build_session_patch_params("agent:main:main", patch);

        assert_eq!(thinking_level.as_deref(), Some("medium"));
        assert_eq!(params["key"], "agent:main:main");
        assert_eq!(params["thinkingLevel"], "medium");
    }

    #[test]
    fn clears_legacy_auth_overrides_without_dropping_official_session_model() {
        let root = std::env::temp_dir().join(format!(
            "imai-openclaw-session-overrides-{}",
            uuid::Uuid::new_v4()
        ));
        let sessions_dir = root.join("agents").join("main").join("sessions");
        fs::create_dir_all(&sessions_dir).expect("sessions dir");
        let session_key = "agent:main:main";

        fs::write(
            sessions_dir.join("sessions.json"),
            serde_json::to_string_pretty(&json!({
                session_key: {
                    "sessionId": "session-1",
                    "providerOverride": "deepseek",
                    "modelOverride": "deepseek-v4-flash",
                    "modelOverrideSource": "user",
                    "authProfileOverride": "deepseek:default",
                    "authProfileOverrideSource": "user",
                    "modelProvider": "deepseek",
                    "model": "deepseek-v4-flash",
                    "provider": "deepseek",
                    "systemPromptReport": {
                        "provider": "deepseek",
                        "model": "deepseek-v4-flash",
                        "sessionId": "session-1"
                    },
                    "usageFamilySessionIds": ["session-1"]
                },
                "agent:main:other": {
                    "providerOverride": "deepseek",
                    "modelOverride": "deepseek-v4-flash"
                }
            }))
            .expect("sessions json"),
        )
        .expect("write sessions json");

        let changed = clear_session_model_overrides_from_sessions_dir(&sessions_dir, session_key)
            .expect("clear overrides");
        let next: Value = serde_json::from_str(
            &fs::read_to_string(sessions_dir.join("sessions.json")).expect("read sessions json"),
        )
        .expect("parse sessions json");

        assert!(changed);
        assert_eq!(next[session_key]["sessionId"], "session-1");
        assert_eq!(next[session_key]["usageFamilySessionIds"][0], "session-1");
        assert_eq!(next[session_key]["providerOverride"], "deepseek");
        assert_eq!(next[session_key]["modelOverride"], "deepseek-v4-flash");
        assert_eq!(next[session_key]["modelOverrideSource"], "user");
        assert_eq!(next[session_key].get("authProfileOverride"), None);
        assert_eq!(next[session_key]["modelProvider"], "deepseek");
        assert_eq!(next[session_key]["model"], "deepseek-v4-flash");
        assert_eq!(next[session_key]["provider"], "deepseek");
        assert_eq!(
            next[session_key]["systemPromptReport"]["sessionId"],
            "session-1"
        );
        assert_eq!(
            next[session_key]["systemPromptReport"].get("provider"),
            None
        );
        assert_eq!(next[session_key]["systemPromptReport"].get("model"), None);
        assert_eq!(next["agent:main:other"]["providerOverride"], "deepseek");
    }

    #[test]
    fn session_patch_params_clear_default_permission_mode() {
        let patch =
            build_session_control_patch(Some("default")).expect("default mode creates no patch");

        assert_eq!(patch, json!({ "permissionMode": null }));
    }

    #[test]
    fn session_rename_params_patch_official_label_only() {
        let patch = build_session_label_patch("  复盘聊天  ").expect("label patch");
        let params = build_session_patch_params("agent:main:idea", patch);

        assert_eq!(params["key"], "agent:main:idea");
        assert_eq!(params["label"], "复盘聊天");
        assert_eq!(params.get("patch"), None);
        assert_eq!(params.get("displayName"), None);
        assert_eq!(params.get("title"), None);
    }

    #[test]
    fn session_list_params_filter_current_agent_like_openclaw_client() {
        let params = build_gateway_session_list_params(
            Some("employee-1"),
            Some(" demo "),
            Some(20),
            Some(50),
        );

        assert_eq!(params["configuredAgentsOnly"], true);
        assert_eq!(params["includeUnknown"], true);
        assert_eq!(params["includeGlobal"], false);
        // First-message auto titles — without this every direct-chat session
        // renders as the handshake client.displayName ("Uniopc Desktop").
        assert_eq!(params["includeDerivedTitles"], true);
        assert_eq!(params["agentId"], "employee-1");
        assert_eq!(params["query"], "demo");
        assert_eq!(params["search"], "demo");
        assert_eq!(params["offset"], 20);
        assert_eq!(params["limit"], 50);
    }

    #[test]
    fn session_create_params_follow_gateway_schema_without_local_title_fields() {
        let params = build_gateway_session_create_params(" employee-1 ");

        assert_eq!(params["agentId"], "employee-1");
        assert_eq!(params.get("displayName"), None);
        assert_eq!(params.get("title"), None);
    }

    #[test]
    fn session_summary_title_priority_label_then_derived_then_display() {
        // derivedTitle (first-user-message auto title) must beat displayName:
        // for direct webchat sessions the engine back-fills displayName from
        // origin.label = our handshake client.displayName ("Uniopc Desktop"),
        // which is channel metadata, not a title.
        let session = parse_gateway_session_summary(&json!({
            "key": "agent:employee-1:idea",
            "kind": "direct",
            "sessionId": "sess-1",
            "agentId": "employee-1",
            "displayName": "Uniopc Desktop",
            "derivedTitle": "帮我写周报",
            "updatedAt": 1_780_000_000_000_u64,
            "modelProvider": "openai-codex",
            "model": "gpt-5.5",
            "thinkingDefault": "low",
            "thinkingLevels": [{"id": "low", "label": "低"}]
        }))
        .expect("session summary");

        assert_eq!(session.key, "agent:employee-1:idea");
        assert_eq!(session.title, "帮我写周报");
        assert_eq!(session.agent_id.as_deref(), Some("employee-1"));
        assert_eq!(session.model_provider.as_deref(), Some("openai-codex"));
        assert_eq!(session.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(session.thinking_levels[0].id, "low");
        assert_eq!(session.kind, SessionKind::Interactive);

        // An explicit user rename (sessions.patch label) beats everything.
        let renamed = parse_gateway_session_summary(&json!({
            "key": "agent:employee-1:idea",
            "kind": "direct",
            "label": "复盘聊天",
            "derivedTitle": "帮我写周报",
            "displayName": "Uniopc Desktop",
        }))
        .expect("renamed summary");
        assert_eq!(renamed.title, "复盘聊天");

        // No label, no derivedTitle (e.g. list without the flag) still falls
        // back to displayName before the raw key.
        let display_only = parse_gateway_session_summary(&json!({
            "key": "agent:employee-1:idea",
            "kind": "direct",
            "displayName": "短剧项目",
        }))
        .expect("display-only summary");
        assert_eq!(display_only.title, "短剧项目");

        // A context-wrapped first message must never leak as a title: the
        // engine derives "_uniopc_context_hash:…" and truncates at 60 chars,
        // so the real input after `用户原始消息：` is gone. With displayName
        // also being the filtered handshake name, fall to the sessionId
        // prefix (the engine's own no-title shape), not the raw key.
        let wrapped = parse_gateway_session_summary(&json!({
            "key": "agent:employee-1:dashboard:3de396b9-c2a7-4342-934e-f20e138f1978",
            "kind": "direct",
            "sessionId": "32f03c5d-67df-42ef-a8d3-597d86ca28e7",
            "derivedTitle": "_uniopc_context_hash:c3a1d63809 IMAI 员工运行上下文： - hidden…",
            "displayName": "Uniopc Desktop",
        }))
        .expect("wrapped summary");
        assert_eq!(wrapped.title, "32f03c5d");
    }

    #[test]
    fn session_summary_uses_contract_kind_for_background_sessions() {
        let cron = parse_gateway_session_summary(&json!({
            "key": "agent:employee-1:cron:fixture",
            "kind": "direct",
            "classification": "cron",
            "isBackground": true
        }))
        .expect("cron session");
        let worker = parse_gateway_session_summary(&json!({
            "key": "agent:employee-1:subagent:fixture",
            "kind": "direct",
            "classification": "subagent",
            "isBackground": true
        }))
        .expect("worker session");

        assert_eq!(cron.kind, SessionKind::Cron);
        assert_eq!(worker.kind, SessionKind::Worker);
        assert!(!cron.kind.is_interactive());
        assert!(!worker.kind.is_interactive());
    }

    #[test]
    fn chat_send_params_follow_gateway_thinking_levels_without_local_default() {
        let default_params =
            build_gateway_chat_send_params("agent:main:main", "hi", "run-1", &[], &[], Some(""))
                .expect("default thinking");
        assert_eq!(default_params["thinking"], Value::Null);

        let adaptive_params = build_gateway_chat_send_params(
            "agent:main:main",
            "hi",
            "run-2",
            &[],
            &[],
            Some("adaptive"),
        )
        .expect("official adaptive thinking");
        assert_eq!(adaptive_params["thinking"], "adaptive");

        let xhigh_params = build_gateway_chat_send_params(
            "agent:main:main",
            "hi",
            "run-3",
            &[],
            &[],
            Some("xhigh"),
        )
        .expect("official xhigh thinking");
        assert_eq!(xhigh_params["thinking"], "xhigh");
    }

    #[test]
    fn latest_assistant_reply_snapshot_skips_tool_use_without_text() {
        let history = vec![
            json!({
                "id": "assistant-tool",
                "role": "assistant",
                "timestamp": 1_000_u64,
                "stopReason": "toolUse",
                "content": [{
                    "type": "toolCall",
                    "name": "read",
                    "arguments": {"path": "docs/file.md"}
                }]
            }),
            json!({
                "id": "assistant-final",
                "role": "assistant",
                "timestamp": 1_500_u64,
                "stopReason": "stop",
                "content": [{"type": "text", "text": "已完成"}]
            }),
        ];

        let snapshot = latest_assistant_reply_snapshot(&history).expect("snapshot");
        assert_eq!(snapshot.content, "已完成");
        assert!(snapshot.fingerprint.contains("assistant-final"));
    }

    #[test]
    fn latest_assistant_reply_snapshot_reads_wrapped_openclaw_history() {
        let history = vec![json!({
            "type": "message",
            "id": "outer-assistant",
            "timestamp": "2026-06-04T01:17:00.000Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "已恢复历史回复"}],
                "timestamp": 1_780_528_620_000_u64
            }
        })];

        let snapshot = latest_assistant_reply_snapshot(&history).expect("snapshot");

        assert_eq!(snapshot.content, "已恢复历史回复");
        assert!(snapshot.fingerprint.contains("outer-assistant"));
    }

    #[test]
    fn latest_assistant_reply_snapshot_can_be_compared_with_baseline() {
        let old_history = vec![json!({
            "id": "assistant-old",
            "role": "assistant",
            "timestamp": 1_000_u64,
            "content": [{"type": "text", "text": "旧回复"}]
        })];
        let new_history = vec![
            old_history[0].clone(),
            json!({
                "id": "assistant-new",
                "role": "assistant",
                "timestamp": 2_000_u64,
                "content": [{"type": "text", "text": "新回复"}]
            }),
        ];

        let baseline = latest_assistant_reply_snapshot(&old_history).expect("baseline");
        let current = latest_assistant_reply_snapshot(&new_history).expect("current");
        assert_ne!(baseline.fingerprint, current.fingerprint);
        assert_eq!(current.content, "新回复");
    }

    #[test]
    fn connection_required_message_points_to_operations() {
        let message = connection_required_message("imai");

        assert!(message.contains("Gateway Connection"));
        assert!(message.contains("Local 或 Remote"));
    }

    #[test]
    fn history_keeps_engine_media_paths_off_the_message_envelope() {
        // Shape taken from a real session JSONL: the engine persists the image
        // to state/<profile>/media/inbound/ and hangs CAPITALIZED MediaPath*
        // fields off the envelope. `content` stays a plain string — reading
        // only `content` is what silently dropped the attachment.
        let history = vec![serde_json::json!({
            "type": "message",
            "id": "9825a648",
            "message": {
                "role": "user",
                "content": "你可以识别图片吗",
                "timestamp": 1_784_972_572_439u64,
                "MediaPath": "/tmp/media/inbound/a.png",
                "MediaPaths": ["/tmp/media/inbound/a.png"],
                "MediaType": "image/png",
                "MediaTypes": ["image/png"],
            }
        })];

        let mapped = map_gateway_history_messages(&history);
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].content, "你可以识别图片吗");
        assert_eq!(mapped[0].media_paths, vec!["/tmp/media/inbound/a.png"]);
        assert_eq!(mapped[0].media_types, vec!["image/png"]);
    }

    #[test]
    fn history_keeps_an_image_only_turn_and_pads_missing_mime_types() {
        // An image with no caption has no text at all. Before this, the whole
        // message was filter_map'd away and the attachment vanished with it.
        // A short MediaTypes must pad, never misalign against the paths.
        let history = vec![serde_json::json!({
            "message": {
                "role": "user",
                "MediaPaths": ["/tmp/media/inbound/a.png", "/tmp/media/inbound/b.png"],
                "MediaTypes": ["image/png"],
            }
        })];

        let mapped = map_gateway_history_messages(&history);
        assert_eq!(mapped.len(), 1, "an image-only turn must survive");
        assert_eq!(mapped[0].content, "");
        assert_eq!(mapped[0].media_paths.len(), 2);
        assert_eq!(mapped[0].media_types, vec!["image/png", ""]);
    }

    #[test]
    fn history_keeps_assistant_delivered_video_from_structured_content() {
        // Real Smart Montage completion: the text and the playable video are
        // separate blocks, and only openclawDelivery retains a local path.
        let history = vec![serde_json::json!({
            "id": "assistant-video-1",
            "role": "assistant",
            "content": [
                { "type": "text", "text": "成片已生成" },
                {
                    "type": "video",
                    "url": "/api/chat/media/outgoing/session/artifact/full",
                    "mimeType": "video/mp4"
                }
            ],
            "openclawDelivery": {
                "mediaUrls": ["/tmp/media/outbound/montage.mp4"]
            }
        })];

        let mapped = map_gateway_history_messages(&history);
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].content, "成片已生成");
        assert_eq!(
            mapped[0].media_paths,
            vec!["/tmp/media/outbound/montage.mp4"]
        );
        assert_eq!(mapped[0].media_types, vec!["video/mp4"]);
    }

    #[test]
    fn history_message_without_text_or_media_is_still_dropped() {
        let history = vec![serde_json::json!({ "message": { "role": "user" } })];
        assert!(map_gateway_history_messages(&history).is_empty());
    }

    #[test]
    fn merge_current_user_message_does_not_duplicate_visible_user_turn() {
        let messages = vec![ConversationHistoryMessage {
            id: "gateway-user-1000".to_string(),
            role: "user".to_string(),
            content: "真实用户输入".to_string(),
            created_at: 1_000,
            media_paths: Vec::new(),
            media_types: Vec::new(),
            idempotency_key: None,
        }];

        let merged = merge_current_user_message(messages, "agent:emp:main", "真实用户输入", 1_000);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].id, "gateway-user-1000");
    }

    #[test]
    fn merge_history_preserves_local_attachment_metadata_when_gateway_omits_it() {
        let gateway = ConversationHistoryMessage {
            id: "gateway-user-attachment".to_string(),
            role: "user".to_string(),
            content: "请读取这个文件".to_string(),
            created_at: 1_800_000_000_000,
            media_paths: Vec::new(),
            media_types: Vec::new(),
            idempotency_key: Some("turn-key".to_string()),
        };
        let transcript = ConversationHistoryMessage {
            id: "transcript-user-attachment".to_string(),
            role: "user".to_string(),
            content: "请读取这个文件".to_string(),
            created_at: 1_800_000_000_000,
            media_paths: vec!["/tmp/media/inbound/fixture.txt".to_string()],
            media_types: vec!["text/plain".to_string()],
            idempotency_key: None,
        };

        let merged = merge_conversation_history_messages(vec![gateway], vec![transcript]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].media_paths, vec!["/tmp/media/inbound/fixture.txt"]);
        assert_eq!(merged[0].media_types, vec!["text/plain"]);
        assert_eq!(merged[0].idempotency_key.as_deref(), Some("turn-key"));
    }

    #[test]
    fn loads_gateway_usage_family_reset_history_from_local_transcripts() {
        let root =
            std::env::temp_dir().join(format!("imai-openclaw-sessions-{}", uuid::Uuid::new_v4()));
        let sessions_dir = root.join("agents").join("main").join("sessions");
        fs::create_dir_all(&sessions_dir).expect("sessions dir");
        let session_key = "agent:main:main";

        fs::write(
            sessions_dir.join("sessions.json"),
            serde_json::to_string_pretty(&json!({
                session_key: {
                    "sessionId": "current-session",
                    "usageFamilySessionIds": ["old-session", "current-session"],
                    "sessionFile": sessions_dir.join("current-session.jsonl").to_string_lossy(),
                }
            }))
            .expect("sessions json"),
        )
        .expect("write sessions json");
        fs::write(
            sessions_dir.join("old-session.jsonl.reset.2026-06-06T01-00-00.000Z"),
            [
                json!({
                    "type": "session",
                    "id": "old-session",
                    "timestamp": "2026-06-06T00:59:00.000Z"
                }),
                json!({
                    "type": "message",
                    "id": "old-user",
                    "timestamp": "2026-06-06T01:00:00.000Z",
                    "message": {
                        "role": "user",
                        "timestamp": 1_780_000_000_000_u64,
                        "content": "_uniopc_context_hash:abc\n\n用户原始消息：\n旧问题"
                    }
                }),
                json!({
                    "type": "message",
                    "id": "old-assistant",
                    "timestamp": "2026-06-06T01:01:00.000Z",
                    "message": {
                        "role": "assistant",
                        "timestamp": 1_780_000_060_000_u64,
                        "content": [{"type": "text", "text": "旧回答"}]
                    }
                }),
            ]
            .iter()
            .map(|value| serde_json::to_string(value).expect("line json"))
            .collect::<Vec<_>>()
            .join("\n"),
        )
        .expect("write reset transcript");
        fs::write(
            sessions_dir.join("current-session.jsonl"),
            serde_json::to_string(&json!({
                "type": "message",
                "id": "current-assistant",
                "timestamp": "2026-06-06T02:00:00.000Z",
                "message": {
                    "role": "assistant",
                    "timestamp": 1_780_003_600_000_u64,
                    "content": "当前回答"
                }
            }))
            .expect("current line"),
        )
        .expect("write current transcript");

        let messages =
            load_usage_family_history_from_sessions_dir(&sessions_dir, session_key).unwrap();

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].id, "old-user");
        assert_eq!(messages[0].content, "旧问题");
        assert_eq!(messages[1].id, "old-assistant");
        assert_eq!(messages[1].content, "旧回答");
        assert_eq!(messages[2].id, "current-assistant");
        assert_eq!(messages[2].content, "当前回答");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_conversation_project_id_from_request_then_direct_fallback() {
        assert_eq!(
            resolve_conversation_project_id(
                Some(" explicit-project "),
                "agent:emp:project:session-project"
            ),
            "explicit-project"
        );
        assert_eq!(
            resolve_conversation_project_id(None, "agent:emp:project:session-project"),
            DIRECT_CONVERSATION_PROJECT_ID
        );
        assert_eq!(
            resolve_conversation_project_id(None, "agent:emp:main"),
            DIRECT_CONVERSATION_PROJECT_ID
        );
    }

    #[test]
    fn pairing_setup_code_decodes_openclaw_bootstrap_payload() {
        let setup_code = encode_base64_url_for_test(
            r#"{"url":"wss://owner.example.ts.net","bootstrapToken":"bootstrap-1"}"#,
        );

        let setup = decode_openclaw_pairing_setup_code(&setup_code).expect("setup code");

        assert_eq!(setup.gateway_url, "wss://owner.example.ts.net");
        assert_eq!(setup.bootstrap_token, "bootstrap-1");
    }

    #[test]
    fn pairing_setup_code_decodes_official_gateway_deep_link() {
        let setup = decode_openclaw_pairing_setup_code(
            "openclaw://gateway?url=wss%3A%2F%2Fowner.example.ts.net&bootstrapToken=bootstrap-1",
        )
        .expect("setup code");

        assert_eq!(setup.gateway_url, "wss://owner.example.ts.net");
        assert_eq!(setup.bootstrap_token, "bootstrap-1");
    }

    #[test]
    fn remote_setup_code_does_not_use_local_bootstrap_fallback() {
        let source = include_str!("mod.rs");

        assert!(!source.contains(&format!(
            "{}{}{}",
            "issue_local_", "openclaw_pairing_", "setup"
        )));
        assert!(!source.contains(&format!("{}{}", "local_bootstrap", "_token")));
    }

    #[test]
    fn device_auth_payload_matches_openclaw_v3_canonical_shape() {
        let payload = build_openclaw_device_auth_payload_v3(
            "device-1",
            "imai-desktop",
            "backend",
            "operator",
            &["operator.read".to_string(), "operator.write".to_string()],
            1_765_000_000,
            Some("bootstrap-1"),
            "nonce-1",
            "macos",
            Some("desktop"),
        );

        assert_eq!(
            payload,
            "v3|device-1|imai-desktop|backend|operator|operator.read,operator.write|1765000000|bootstrap-1|nonce-1|macos|desktop"
        );
    }

    #[test]
    fn remote_setup_connect_uses_gateway_compatible_schema() {
        let source = include_str!("mod.rs");
        let start = source
            .find("fn build_signed_connect_request_for_remote")
            .expect("remote connect builder");
        let end = source[start..]
            .find("fn persist_remote_openclaw_profile_config")
            .map(|offset| start + offset)
            .expect("next function");
        let remote_builder = &source[start..end];

        assert!(remote_builder.contains("let client_id = \"gateway-client\""));
        assert!(remote_builder.contains("timestamp_millis()"));
        assert!(remote_builder.contains("let device_family = \"desktop\""));
        assert!(remote_builder.contains("\"deviceFamily\": device_family"));
        assert!(remote_builder.contains("device_public_key_base64_url"));
        assert!(remote_builder.contains("base64_url_encode(&signature.to_bytes())"));
        assert!(!remote_builder.contains("\"payloadVersion\""));
    }

    #[test]
    fn local_setup_connect_uses_gateway_compatible_schema() {
        let source = include_str!("mod.rs");
        let start = source
            .find("fn build_signed_connect_request(")
            .expect("local connect builder");
        let end = source[start..]
            .find("fn validate_gateway_response")
            .map(|offset| start + offset)
            .expect("next function");
        let local_builder = &source[start..end];

        assert!(local_builder.contains("let client_id = \"gateway-client\""));
        assert!(local_builder.contains("let client_mode = \"backend\""));
        assert!(local_builder.contains("let device_family = \"desktop\""));
        assert!(local_builder.contains("\"displayName\": \"Uniopc Desktop\""));
        assert!(local_builder.contains("\"deviceFamily\": device_family"));
        assert!(local_builder.contains("device_public_key_base64_url"));
        assert!(local_builder.contains("base64_url_encode(&signature.to_bytes())"));
        assert!(!local_builder.contains("\"mode\": \"operator\""));
        assert!(!local_builder.contains("let client_id = \"uniopc-desktop\""));
        assert!(!local_builder.contains("\"v3-preview\""));
    }

    #[test]
    fn remote_setup_gateway_url_uses_official_mobile_safety_policy() {
        assert_eq!(remote_setup_gateway_url_issue(""), Some("missing"));
        assert_eq!(
            remote_setup_gateway_url_issue("https://owner.example.com"),
            Some("invalid_scheme")
        );
        assert_eq!(
            remote_setup_gateway_url_issue("ws://owner.example.com:18790"),
            Some("remote_cleartext")
        );
        assert_eq!(
            remote_setup_gateway_url_issue("ws://192.168.1.20:18790"),
            None
        );
        assert_eq!(
            remote_setup_gateway_url_issue("ws://100.105.138.117:18790"),
            None
        );
        assert_eq!(remote_setup_gateway_url_issue("ws://127.0.0.1:18790"), None);
        assert_eq!(
            remote_setup_gateway_url_issue("wss://owner.example.ts.net"),
            None
        );
    }

    fn encode_base64_url_for_test(value: &str) -> String {
        base64_url_encode(value.as_bytes())
    }
}

fn normalize_conversation_profile(profile: Option<&str>) -> Option<String> {
    profile
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
