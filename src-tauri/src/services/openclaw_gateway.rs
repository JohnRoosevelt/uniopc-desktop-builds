use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{env, fs, path::{Path, PathBuf}};
use tauri::{AppHandle, Runtime};
use tokio::net::TcpStream;
use tokio::time::{sleep, timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

use crate::services::{
    openclaw_device_auth,
    openclaw_gateway_contract::{
        normalize_gateway_error, AgentFileDescriptor, GatewayCapabilities, UniopcGatewayError,
    },
};

const DEFAULT_GATEWAY_WS_URL: &str = "ws://127.0.0.1:18790";
const DEFAULT_GATEWAY_PORT: u16 = 18790;
const GATEWAY_CONNECT_TIMEOUT_SECS: u64 = 3;
const GATEWAY_REQUEST_TIMEOUT_SECS: u64 = 8;
const GATEWAY_LIST_CONNECT_TIMEOUT_SECS: u64 = 5;
const GATEWAY_LIST_REQUEST_TIMEOUT_SECS: u64 = 12;
const GATEWAY_CREATE_RECOVERY_ATTEMPTS: usize = 14;
const GATEWAY_CREATE_RECOVERY_DELAY_MS: u64 = 500;
const CONFIG_PATCH_RESTART_DELAY_MS: u64 = 500;
// OpenClaw guards every config.patch with the hash returned by config.get.
// Startup has several legitimate writers (profile defaults, system plugins and
// model setup), so a stale hash is an optimistic-concurrency conflict, not a
// terminal configuration error. Re-read and retry the whole transaction.
// Gateway can rewrite its runtime snapshot while Desktop is installing a
// plugin.  A config.patch carries the snapshot hash, so a short retry window
// turns that ordinary reload race into a user-visible INVALID_REQUEST.  Keep
// retrying across one complete reload cycle, always fetching a fresh hash.
const CONFIG_PATCH_CONFLICT_ATTEMPTS: usize = 20;
const CONFIG_PATCH_CONFLICT_DELAY_MS: u64 = 250;
// Keep the Gateway's raw error text out of the UI/log boundary while still
// allowing `config.patch` to recognize its optimistic-concurrency response.
// `openclaw plugins install` writes config asynchronously, so the first patch
// immediately after an install commonly needs this retry path.
const CONFIG_CHANGED_SINCE_LAST_LOAD: &str = "gateway.configChangedSinceLastLoad";
pub const DEFAULT_OPERATOR_CONNECT_SCOPES: &[&str] = &[
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
];
/// `client.displayName` sent on every gateway connect handshake. The engine
/// treats non-operator-UI clients' displayName as a SENDER name and back-fills
/// it into each direct session's `origin.label` → session row `displayName`,
/// so this exact string comes back to us as channel metadata masquerading as a
/// session title. Session title parsing filters on this constant — keep every
/// handshake pointed at it (no inline literals).
pub const GATEWAY_CLIENT_DISPLAY_NAME: &str = "Uniopc Desktop";
/// Client capabilities announced in the `connect` handshake. `tool-events` opts
/// this connection into the gateway's full tool stream (`stream:"tool"` frames
/// carrying `args`/`result`); without it we only see the args-less item stream.
pub const GATEWAY_CLIENT_CAPS: [&str; 2] = ["tool-events", "exec-approvals"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayEndpoint {
    pub url: String,
    pub token: Option<String>,
    pub password: Option<String>,
    pub device_token: Option<String>,
}

pub type GatewaySocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayConfigMetadata {
    pub ws_url: String,
    pub auth_mode: String,
    pub has_token: bool,
    pub has_password: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayChallengeProbe {
    pub ws_reachable: bool,
    pub connect_challenge_received: bool,
    pub connect_challenge_event: Option<String>,
    pub challenge_nonce: Option<String>,
    pub challenge_ts: Option<u64>,
    pub probe_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayAgent {
    pub id: String,
    pub name: Option<String>,
    pub identity_name: Option<String>,
    pub emoji: Option<String>,
    pub workspace: String,
    pub agent_dir: String,
    pub model: Option<String>,
    pub is_default: bool,
    pub bindings: u64,
    pub routes: Vec<String>,
    pub providers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayAgentCreateRequest {
    pub agent_id: String,
    pub name: String,
    pub workspace: String,
    pub model: Option<String>,
    pub emoji: String,
}

#[derive(Debug, Clone)]
pub struct GatewayClient {
    profile: Option<String>,
    pub(crate) endpoint_override: Option<GatewayEndpoint>,
    connect_timeout_secs: u64,
    request_timeout_secs: u64,
}

impl GatewayClient {
    pub fn for_profile(profile: Option<&str>) -> Self {
        Self::with_timeouts(
            profile,
            GATEWAY_CONNECT_TIMEOUT_SECS,
            GATEWAY_REQUEST_TIMEOUT_SECS,
        )
    }

    pub fn with_timeouts(
        profile: Option<&str>,
        connect_timeout_secs: u64,
        request_timeout_secs: u64,
    ) -> Self {
        Self {
            profile: profile
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            endpoint_override: None,
            connect_timeout_secs,
            request_timeout_secs,
        }
    }

    pub fn for_endpoint(
        endpoint: GatewayEndpoint,
        connect_timeout_secs: u64,
        request_timeout_secs: u64,
    ) -> Self {
        Self {
            profile: None,
            endpoint_override: Some(endpoint),
            connect_timeout_secs,
            request_timeout_secs,
        }
    }

    pub async fn request_json(
        &self,
        method: &str,
        params: Value,
        expect_final: bool,
    ) -> Result<Value, String> {
        let endpoint = self.endpoint()?;
        request_json_with_timeouts(
            &endpoint,
            method,
            params,
            expect_final,
            self.connect_timeout_secs,
            self.request_timeout_secs,
        )
        .await
    }

    pub async fn connect(&self) -> Result<GatewaySocket, String> {
        let endpoint = self.endpoint()?;
        connect_endpoint_socket(
            &endpoint,
            self.connect_timeout_secs,
            self.request_timeout_secs,
        )
        .await
    }

    fn endpoint(&self) -> Result<GatewayEndpoint, String> {
        if let Some(endpoint) = self.endpoint_override.clone() {
            return Ok(endpoint);
        }
        let config = load_openclaw_config_for_profile(self.profile.as_deref())?;
        gateway_endpoint_from_config(&config)
    }
}

pub async fn agents_list_json(profile: Option<&str>) -> Result<Vec<Value>, String> {
    let config = load_openclaw_config_for_profile(profile)?;
    let endpoint = gateway_endpoint_from_config(&config)?;
    let payload = request_json_with_timeouts(
        &endpoint,
        "agents.list",
        json!({}),
        false,
        GATEWAY_LIST_CONNECT_TIMEOUT_SECS,
        GATEWAY_LIST_REQUEST_TIMEOUT_SECS,
    )
    .await?;
    let mut agents = agents_from_gateway_payload(&payload)?;
    if agents.is_empty() {
        agents = agents_from_config(&config, profile)?;
    }
    enrich_agents_from_config(&mut agents, &config, profile)?;
    Ok(agents.into_iter().map(gateway_agent_to_value).collect())
}

pub async fn agents_list_json_with_device_auth<R: Runtime>(
    app: &AppHandle<R>,
    profile: Option<&str>,
) -> Result<Vec<Value>, String> {
    let config = load_openclaw_config_for_profile(profile)?;
    let endpoint = gateway_endpoint_from_config(&config)?;
    let payload = request_json_for_endpoint_with_device_auth(
        app,
        &endpoint,
        "agents.list",
        json!({}),
        false,
        GATEWAY_LIST_CONNECT_TIMEOUT_SECS,
        GATEWAY_LIST_REQUEST_TIMEOUT_SECS,
    )
    .await?;
    let mut agents = agents_from_gateway_payload(&payload)?;
    if agents.is_empty() {
        agents = agents_from_config(&config, profile)?;
    }
    enrich_agents_from_config(&mut agents, &config, profile)?;
    Ok(agents.into_iter().map(gateway_agent_to_value).collect())
}

pub async fn agents_create_json(
    profile: Option<&str>,
    req: &GatewayAgentCreateRequest,
) -> Result<Value, String> {
    let config = load_openclaw_config_for_profile(profile)?;
    let endpoint = gateway_endpoint_from_config(&config)?;
    let create_payload =
        match request_json(&endpoint, "agents.create", agent_create_params(req), false).await {
            Ok(payload) => payload,
            Err(create_error) => {
                let found = match find_agent_json_with_retry(profile, &req.agent_id).await {
                    Ok(found) => found,
                    Err(recovery_error) => {
                        return Err(format!(
                            "{create_error}\nGateway create recovery failed: {recovery_error}"
                        ));
                    }
                };
                let _ = apply_agent_update_with_retry(profile, req).await;
                return find_agent_json_with_retry(profile, &req.agent_id)
                    .await
                    .or_else(|_| Ok(agent_value_with_requested_identity(found, req)));
            }
        };

    let created_id = create_payload
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or(req.agent_id.as_str());
    if created_id != req.agent_id {
        return Err(format!(
            "Uniopc 引擎 创建的 agent id `{created_id}` 与 Uniopc 期望 `{}` 不一致。",
            req.agent_id
        ));
    }

    let update_result = apply_agent_update_with_retry(profile, req).await;
    let found_result = find_agent_json_with_retry(profile, &req.agent_id).await;
    match (update_result, found_result) {
        (Ok(_), Ok(found)) => Ok(found),
        (Err(_update_error), Ok(found)) => Ok(agent_value_with_requested_identity(found, req)),
        (Ok(_), Err(_list_error)) => Ok(agent_value_with_requested_identity(create_payload, req)),
        (Err(_update_error), Err(_list_error)) => {
            Ok(agent_value_with_requested_identity(create_payload, req))
        }
    }
}

pub async fn agents_delete(
    profile: Option<&str>,
    agent_id: &str,
    delete_files: bool,
) -> Result<(), String> {
    let _ = call_json(
        profile,
        "agents.delete",
        json!({
            "agentId": agent_id,
            "deleteFiles": delete_files
        }),
        false,
    )
    .await?;
    Ok(())
}

pub async fn agents_update_json(
    profile: Option<&str>,
    agent_id: &str,
    patch: Value,
) -> Result<Value, String> {
    let mut params = match patch {
        Value::Object(object) => Value::Object(object),
        _ => return Err("Gateway agents.update 参数必须是对象。".to_string()),
    };
    if let Some(object) = params.as_object_mut() {
        object.insert("agentId".to_string(), Value::String(agent_id.to_string()));
    }
    call_json(profile, "agents.update", params, false).await
}

pub async fn agent_files_list(profile: Option<&str>, agent_id: &str) -> Result<Value, String> {
    call_json(
        profile,
        "agents.files.list",
        json!({ "agentId": agent_id }),
        false,
    )
    .await
}

pub async fn agent_file_descriptors(
    profile: Option<&str>,
    agent_id: &str,
) -> Result<Vec<AgentFileDescriptor>, String> {
    AgentFileDescriptor::from_list_payload(agent_files_list(profile, agent_id).await?)
        .map_err(|error| error.to_string())
}

pub async fn agent_files_get(
    profile: Option<&str>,
    agent_id: &str,
    name: &str,
) -> Result<Value, String> {
    let files = agent_file_descriptors(profile, agent_id).await?;
    listed_agent_file_get(profile, agent_id, &files, name).await
}

pub async fn listed_agent_file_get(
    profile: Option<&str>,
    agent_id: &str,
    files: &[AgentFileDescriptor],
    name: &str,
) -> Result<Value, String> {
    ensure_agent_file_is_listed(files, name)?;
    call_json(
        profile,
        "agents.files.get",
        json!({
            "agentId": agent_id,
            "name": name
        }),
        false,
    )
    .await
}

pub async fn agent_files_set(
    profile: Option<&str>,
    agent_id: &str,
    name: &str,
    content: &str,
) -> Result<Value, String> {
    let files = agent_file_descriptors(profile, agent_id).await?;
    listed_agent_file_set(profile, agent_id, &files, name, content).await
}

pub async fn listed_agent_file_set(
    profile: Option<&str>,
    agent_id: &str,
    files: &[AgentFileDescriptor],
    name: &str,
    content: &str,
) -> Result<Value, String> {
    ensure_agent_file_is_listed(files, name)?;
    call_json(
        profile,
        "agents.files.set",
        json!({
            "agentId": agent_id,
            "name": name,
            "content": content
        }),
        false,
    )
    .await
}

fn ensure_agent_file_is_listed(files: &[AgentFileDescriptor], name: &str) -> Result<(), String> {
    if AgentFileDescriptor::supports(files, name) {
        Ok(())
    } else {
        Err(format!(
            "gateway.agentFile.notListed: {name} is not exposed by agents.files.list"
        ))
    }
}

pub fn gateway_capabilities(value: Value) -> Result<GatewayCapabilities, UniopcGatewayError> {
    GatewayCapabilities::from_hello_ok(value)
}

pub async fn skills_status(profile: Option<&str>, agent_id: Option<&str>) -> Result<Value, String> {
    let mut params = json!({});
    if let Some(agent_id) = agent_id.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(object) = params.as_object_mut() {
            object.insert("agentId".to_string(), Value::String(agent_id.to_string()));
        }
    }
    call_json(profile, "skills.status", params, false).await
}

pub async fn skills_update(profile: Option<&str>, params: Value) -> Result<Value, String> {
    call_json(profile, "skills.update", params, false).await
}

pub async fn channels_status(profile: Option<&str>, probe: bool) -> Result<Value, String> {
    call_json(profile, "channels.status", json!({ "probe": probe }), false).await
}

pub async fn config_get(profile: Option<&str>) -> Result<Value, String> {
    call_json(profile, "config.get", json!({}), false).await
}

pub async fn config_patch(profile: Option<&str>, patch: Value) -> Result<Value, String> {
    config_patch_with_retry(profile, patch, None).await
}

/// `config.patch` refuses to shrink an array unless the caller names it in
/// `replacePaths` (the engine's guard against accidental entry loss). Use this
/// variant when removing entries from a config array — e.g. unbinding a
/// channel from the top-level `bindings[]` — is exactly the intent.
pub async fn config_patch_replacing(
    profile: Option<&str>,
    patch: Value,
    replace_paths: &[&str],
) -> Result<Value, String> {
    config_patch_with_retry(profile, patch, Some(replace_paths)).await
}

pub(crate) fn config_patch_conflict(error: &str) -> bool {
    error == CONFIG_CHANGED_SINCE_LAST_LOAD
        || error
            .to_lowercase()
            .contains("config changed since last load")
}

async fn config_patch_with_retry(
    profile: Option<&str>,
    patch: Value,
    replace_paths: Option<&[&str]>,
) -> Result<Value, String> {
    let mut last_conflict = None;
    for attempt in 0..CONFIG_PATCH_CONFLICT_ATTEMPTS {
        let snapshot = config_get(profile).await?;
        let mut params = config_patch_params(&snapshot, patch.clone())?;
        if let (Some(paths), Some(object)) = (replace_paths, params.as_object_mut()) {
            object.insert("replacePaths".to_string(), json!(paths));
        }
        match call_json(profile, "config.patch", params, false).await {
            Ok(value) => return Ok(value),
            Err(error)
                if config_patch_conflict(&error)
                    && attempt + 1 < CONFIG_PATCH_CONFLICT_ATTEMPTS =>
            {
                last_conflict = Some(error);
                sleep(Duration::from_millis(CONFIG_PATCH_CONFLICT_DELAY_MS)).await;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_conflict.unwrap_or_else(|| "Uniopc 引擎 config.patch 重试失败。".to_string()))
}

/// Startup binds its delta to exactly the snapshot that produced it. Conflicts
/// are returned to the caller so it can rebuild, never replay with a new hash.
pub(crate) async fn startup_config_patch(profile: &str, snapshot: &Value, delta: Value) -> Result<(), String> {
    let params = config_patch_params(snapshot, delta)?;
    call_json(Some(profile), "config.patch", params, false).await.map(|_| ())
}

pub(crate) fn transport_error(error: &tokio_tungstenite::tungstenite::Error) -> String {
    if matches!(error, tokio_tungstenite::tungstenite::Error::Io(io) if io.kind() == std::io::ErrorKind::ConnectionRefused) {
        "gateway_transport_connection_refused".to_string()
    } else {
        format!("连接 Uniopc 引擎 失败: {error}")
    }
}

fn config_patch_params(snapshot: &Value, patch: Value) -> Result<Value, String> {
    let base_hash = snapshot
        .get("hash")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Uniopc 引擎 config.get 缺少 hash，无法安全 patch 配置。".to_string())?;
    let raw = serde_json::to_string(&patch)
        .map_err(|e| format!("序列化 Uniopc 引擎 config.patch 失败: {e}"))?;
    Ok(json!({
        "raw": raw,
        "baseHash": base_hash,
        "note": "Uniopc Desktop config patch",
        "restartDelayMs": CONFIG_PATCH_RESTART_DELAY_MS
    }))
}

pub async fn health(profile: Option<&str>) -> Result<Value, String> {
    call_json(profile, "health", json!({}), false).await
}

/// Cheap readiness probe over the gateway's official HTTP `/readyz` endpoint.
///
/// The gateway multiplexes HTTP and WebSocket on one port; `/readyz` answers in
/// milliseconds without auth and stays 503 while startup sidecars/channels are
/// still settling. Polling this instead of a full WS `health` RPC avoids paying
/// a challenge→sign→connect→hello handshake (3s connect / 8s request timeouts)
/// per attempt while the engine is still booting — the dominant cost of the old
/// readiness wait.
///
/// `Ok(true)` = ready; `Ok(false)` = HTTP up but not ready yet (503);
/// `Err` = HTTP layer not answering at all.
pub async fn http_ready(profile: Option<&str>) -> Result<bool, String> {
    let config = load_openclaw_config_for_profile(profile)?;
    let endpoint = gateway_endpoint_from_config(&config)?;
    http_ready_for_endpoint(&endpoint).await
}

pub async fn http_ready_for_endpoint(endpoint: &GatewayEndpoint) -> Result<bool, String> {
    let url = format!("{}/readyz", http_base_from_ws_url(&endpoint.url));
    let response = readiness_http_client()
        .get(&url)
        .send()
        .await
        .map_err(|error| readiness_transport_error("send", &error))?;
    if !response.status().is_success() { return Ok(false); }
    // reqwest labels interrupted body collection as decode errors too. Read
    // the full bytes first so only complete JSON is a schema decision.
    let bytes = response.bytes().await
        .map_err(|error| readiness_transport_error("body", &error))?;
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "gateway_http_readiness_schema_invalid".to_string())?;
    Ok(body.get("ready").and_then(Value::as_bool) == Some(true))
}

fn readiness_transport_error(phase: &str, error: &reqwest::Error) -> String {
    // Never format the error or its sources: they can contain URLs or secrets.
    let mut source = std::error::Error::source(error);
    let mut io_kind = None;
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            io_kind = Some(io.kind());
            break;
        }
        source = cause.source();
    }
    // A missing listener can be polled for 900 seconds. Keep diagnostics
    // bounded both in memory and frequency, without writing on every poll.
    type DiagnosticKey = (bool, u8, Option<std::io::ErrorKind>);
    static DIAGNOSTICS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<DiagnosticKey, std::time::Instant>>> = std::sync::OnceLock::new();
    let flags = u8::from(error.is_builder())
        | (u8::from(error.is_connect()) << 1)
        | (u8::from(error.is_timeout()) << 2)
        | (u8::from(error.is_request()) << 3)
        | (u8::from(error.is_body()) << 4)
        | (u8::from(error.is_decode()) << 5);
    let key = (phase == "body", flags, io_kind);
    let should_log = DIAGNOSTICS.get_or_init(Default::default).lock().ok().is_some_and(|mut seen| {
        let now = std::time::Instant::now();
        if let Some(last) = seen.get_mut(&key) {
            if now.duration_since(*last) < Duration::from_secs(30) { return false; }
            *last = now;
        } else {
            if seen.len() >= 32 { return false; }
            seen.insert(key, now);
        }
        true
    });
    if should_log {
        eprintln!(
            "gateway_http_readiness phase={phase} builder={} connect={} timeout={} request={} body={} decode={} io_kind={io_kind:?}",
            error.is_builder(), error.is_connect(), error.is_timeout(), error.is_request(), error.is_body(), error.is_decode()
        );
    }
    if !error.is_builder()
        && (phase == "body" || error.is_connect() || error.is_timeout() || error.is_request() || error.is_body())
    {
        "gateway_transport_unavailable".into()
    } else {
        "gateway_http_readiness_failed".into()
    }
}

fn http_base_from_ws_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        trimmed.to_string()
    }
}

fn readiness_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Loopback/tunnel probe: never let an inherited HTTPS_PROXY route
            // this (same reasoning as official_model_proxy's client).
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(1500))
            .build()
            .expect("build gateway readiness http client")
    })
}

pub async fn gateway_identity_get(profile: Option<&str>) -> Result<Value, String> {
    call_json(profile, "gateway.identity.get", json!({}), false).await
}

fn models_list_params(_view: Option<&str>) -> Value {
    json!({})
}

pub async fn models_list(profile: Option<&str>) -> Result<Value, String> {
    call_json(profile, "models.list", models_list_params(None), false).await
}

pub async fn configured_models_list(profile: Option<&str>) -> Result<Value, String> {
    call_json(
        profile,
        "models.list",
        models_list_params(Some("configured")),
        false,
    )
    .await
}

pub async fn models_auth_status(profile: Option<&str>, refresh: bool) -> Result<Value, String> {
    call_json(
        profile,
        "models.authStatus",
        json!({ "refresh": refresh }),
        false,
    )
    .await
}

pub async fn call_json(
    profile: Option<&str>,
    method: &str,
    params: Value,
    expect_final: bool,
) -> Result<Value, String> {
    let config = load_openclaw_config_for_profile(profile)?;
    let endpoint = gateway_endpoint_from_config(&config)?;
    request_json(&endpoint, method, params, expect_final).await
}

pub fn config_metadata(profile: Option<&str>) -> Result<GatewayConfigMetadata, String> {
    let config = load_openclaw_config_for_profile(profile)?;
    gateway_metadata_from_config(&config)
}

pub fn auth_secret(profile: Option<&str>) -> Result<(Option<String>, Option<String>), String> {
    let config = load_openclaw_config_for_profile(profile)?;
    let endpoint = gateway_endpoint_from_config(&config)?;
    Ok((endpoint.token, endpoint.password))
}

pub async fn connect_socket(profile: Option<&str>) -> Result<GatewaySocket, String> {
    connect_socket_with_timeouts(
        profile,
        GATEWAY_CONNECT_TIMEOUT_SECS,
        GATEWAY_REQUEST_TIMEOUT_SECS,
    )
    .await
}

pub async fn connect_socket_with_timeouts(
    profile: Option<&str>,
    connect_timeout_secs: u64,
    request_timeout_secs: u64,
) -> Result<GatewaySocket, String> {
    let config = load_openclaw_config_for_profile(profile)?;
    let endpoint = gateway_endpoint_from_config(&config)?;
    connect_endpoint_socket(&endpoint, connect_timeout_secs, request_timeout_secs).await
}

pub async fn request_json_for_profile(
    profile: Option<&str>,
    method: &str,
    params: Value,
    expect_final: bool,
    connect_timeout_secs: u64,
    request_timeout_secs: u64,
) -> Result<Value, String> {
    let config = load_openclaw_config_for_profile(profile)?;
    let endpoint = gateway_endpoint_from_config(&config)?;
    request_json_with_timeouts(
        &endpoint,
        method,
        params,
        expect_final,
        connect_timeout_secs,
        request_timeout_secs,
    )
    .await
}

pub async fn request_json_for_endpoint(
    endpoint: &GatewayEndpoint,
    method: &str,
    params: Value,
    expect_final: bool,
    connect_timeout_secs: u64,
    request_timeout_secs: u64,
) -> Result<Value, String> {
    request_json_with_timeouts(
        endpoint,
        method,
        params,
        expect_final,
        connect_timeout_secs,
        request_timeout_secs,
    )
    .await
}

pub async fn request_json_for_endpoint_with_device_auth<R: Runtime>(
    app: &AppHandle<R>,
    endpoint: &GatewayEndpoint,
    method: &str,
    params: Value,
    expect_final: bool,
    connect_timeout_secs: u64,
    request_timeout_secs: u64,
) -> Result<Value, String> {
    let mut socket = connect_endpoint_socket_with_device_auth(
        app,
        endpoint,
        connect_timeout_secs,
        request_timeout_secs,
    )
    .await?;

    let request_id = format!("imai-req-{}", uuid::Uuid::new_v4());
    let request = json!({
        "type": "req",
        "id": request_id,
        "method": method,
        "params": params
    });
    send_json_frame(&mut socket, &request)
        .await
        .map_err(|e| format!("发送 Gateway {method} 请求失败: {e}"))?;
    let response =
        next_matching_response(&mut socket, &request_id, expect_final, request_timeout_secs)
            .await
            .map_err(|e| format!("Gateway {method} 请求失败: {e}"))?;
    let payload = response_payload_for_method(&response, &request_id, method)?;
    let _ = socket.close(None).await;
    Ok(payload)
}

pub async fn health_for_endpoint(endpoint: &GatewayEndpoint) -> Result<Value, String> {
    request_json_for_endpoint(
        endpoint,
        "health",
        json!({}),
        false,
        GATEWAY_CONNECT_TIMEOUT_SECS,
        GATEWAY_REQUEST_TIMEOUT_SECS,
    )
    .await
}

pub async fn chat_history_for_endpoint(
    endpoint: &GatewayEndpoint,
    session_key: &str,
    limit: usize,
) -> Result<Value, String> {
    request_json_for_endpoint(
        endpoint,
        "chat.history",
        json!({
            "sessionKey": session_key,
            "limit": limit,
        }),
        false,
        GATEWAY_LIST_CONNECT_TIMEOUT_SECS,
        GATEWAY_LIST_REQUEST_TIMEOUT_SECS,
    )
    .await
}

pub async fn chat_abort_for_endpoint(
    endpoint: &GatewayEndpoint,
    session_key: &str,
    run_id: Option<&str>,
) -> Result<Value, String> {
    let mut params = json!({
        "sessionKey": session_key,
    });
    if let Some(run_id) = run_id.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(object) = params.as_object_mut() {
            object.insert("runId".to_string(), json!(run_id));
        }
    }
    request_json_for_endpoint(
        endpoint,
        "chat.abort",
        params,
        false,
        GATEWAY_CONNECT_TIMEOUT_SECS,
        GATEWAY_REQUEST_TIMEOUT_SECS,
    )
    .await
}

pub async fn connect_socket_for_endpoint(
    endpoint: &GatewayEndpoint,
    connect_timeout_secs: u64,
    request_timeout_secs: u64,
) -> Result<GatewaySocket, String> {
    connect_endpoint_socket(endpoint, connect_timeout_secs, request_timeout_secs).await
}

pub async fn probe_challenge_url(ws_url: &str, timeout_secs: u64) -> GatewayChallengeProbe {
    let connect_result = timeout(Duration::from_secs(timeout_secs), connect_async(ws_url)).await;
    let mut socket = match connect_result {
        Err(_) => {
            return GatewayChallengeProbe {
                ws_reachable: false,
                connect_challenge_received: false,
                connect_challenge_event: None,
                challenge_nonce: None,
                challenge_ts: None,
                probe_error: Some("连接 Gateway WebSocket 超时。".to_string()),
            }
        }
        Ok(Err(err)) => {
            return GatewayChallengeProbe {
                ws_reachable: false,
                connect_challenge_received: false,
                connect_challenge_event: None,
                challenge_nonce: None,
                challenge_ts: None,
                probe_error: Some(format!("无法建立 Gateway WebSocket 连接: {err}")),
            }
        }
        Ok(Ok((socket, _))) => socket,
    };

    let mut probe = GatewayChallengeProbe {
        ws_reachable: true,
        connect_challenge_received: false,
        connect_challenge_event: None,
        challenge_nonce: None,
        challenge_ts: None,
        probe_error: None,
    };

    match timeout(Duration::from_secs(timeout_secs), socket.next()).await {
        Err(_) => {
            probe.probe_error = Some("等待 Gateway challenge 超时。".to_string());
        }
        Ok(None) => {
            probe.probe_error = Some("Gateway 在发出 challenge 前关闭了连接。".to_string());
        }
        Ok(Some(Err(err))) => {
            probe.probe_error = Some(format!("读取 Gateway challenge 失败: {err}"));
        }
        Ok(Some(Ok(message))) => match message.into_text() {
            Ok(text) => match serde_json::from_str::<Value>(text.as_ref()) {
                Ok(value) => {
                    let event_name = value
                        .get("event")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    probe.connect_challenge_event = event_name.clone();
                    probe.challenge_nonce = value
                        .get("payload")
                        .and_then(|payload| payload.get("nonce"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    probe.challenge_ts = value
                        .get("payload")
                        .and_then(|payload| payload.get("ts"))
                        .and_then(Value::as_u64);
                    probe.connect_challenge_received =
                        matches!(event_name.as_deref(), Some("connect.challenge"));
                    if !probe.connect_challenge_received {
                        probe.probe_error =
                            Some("Gateway 已响应，但第一帧不是 connect.challenge。".to_string());
                    }
                }
                Err(_) => {
                    probe.probe_error = Some("Gateway 第一帧不是可解析的 JSON 文本。".to_string());
                }
            },
            Err(_) => {
                probe.probe_error = Some("Gateway 第一帧不是文本消息。".to_string());
            }
        },
    }

    let _ = socket.close(None).await;
    probe
}

pub async fn execute_connect_request(
    ws_url: &str,
    connect_request: &Value,
    timeout_secs: u64,
) -> Result<Value, String> {
    let (mut socket, _) = connect_async(ws_url)
        .await
        .map_err(|e| format!("建立 Gateway connect 测试连接失败: {e}"))?;

    let _ = timeout(Duration::from_secs(timeout_secs), socket.next())
        .await
        .map_err(|_| "等待 Gateway challenge 超时。".to_string())?;

    socket
        .send(Message::Text(connect_request.to_string().into()))
        .await
        .map_err(|e| format!("发送 connect 请求失败: {e}"))?;

    let response = timeout(Duration::from_secs(timeout_secs), socket.next())
        .await
        .map_err(|_| "等待 Gateway connect 响应超时。".to_string())?
        .ok_or_else(|| "Gateway 在返回 connect 响应前关闭了连接。".to_string())?
        .map_err(|e| format!("读取 Gateway connect 响应失败: {e}"))?;

    let response_text = response
        .into_text()
        .map_err(|_| "Gateway connect 响应不是文本消息。".to_string())?;
    let response_value = serde_json::from_str::<Value>(response_text.as_ref())
        .map_err(|e| format!("解析 Gateway connect 响应失败: {e}"))?;

    let _ = socket.close(None).await;
    Ok(response_value)
}

async fn request_json(
    endpoint: &GatewayEndpoint,
    method: &str,
    params: Value,
    expect_final: bool,
) -> Result<Value, String> {
    request_json_with_timeouts(
        endpoint,
        method,
        params,
        expect_final,
        GATEWAY_CONNECT_TIMEOUT_SECS,
        GATEWAY_REQUEST_TIMEOUT_SECS,
    )
    .await
}

async fn request_json_with_timeouts(
    endpoint: &GatewayEndpoint,
    method: &str,
    params: Value,
    expect_final: bool,
    connect_timeout_secs: u64,
    request_timeout_secs: u64,
) -> Result<Value, String> {
    let mut socket =
        connect_endpoint_socket(endpoint, connect_timeout_secs, request_timeout_secs).await?;

    let request_id = format!("imai-req-{}", uuid::Uuid::new_v4());
    let request = json!({
        "type": "req",
        "id": request_id,
        "method": method,
        "params": params
    });
    send_json_frame(&mut socket, &request)
        .await
        .map_err(|e| format!("发送 Gateway {method} 请求失败: {e}"))?;
    let response =
        next_matching_response(&mut socket, &request_id, expect_final, request_timeout_secs)
            .await
            .map_err(|e| format!("Gateway {method} 请求失败: {e}"))?;
    let payload = response_payload_for_method(&response, &request_id, method)?;
    let _ = socket.close(None).await;
    Ok(payload)
}

pub(crate) async fn connect_endpoint_socket(
    endpoint: &GatewayEndpoint,
    connect_timeout_secs: u64,
    request_timeout_secs: u64,
) -> Result<GatewaySocket, String> {
    let (mut socket, _) = timeout(
        Duration::from_secs(connect_timeout_secs),
        connect_async(&endpoint.url),
    )
    .await
    .map_err(|_| format!("连接 Uniopc 引擎 超时: {}", endpoint.url))?
    .map_err(|e| transport_error(&e))?;

    let challenge = next_text_frame(&mut socket, connect_timeout_secs)
        .await
        .map_err(|e| format!("读取 Gateway challenge 失败: {e}"))?;
    let nonce = connect_nonce_from_challenge(&challenge)?;

    let connect_id = format!("imai-connect-{}", uuid::Uuid::new_v4());
    let connect_request = build_connect_request(endpoint, &connect_id, &nonce);
    send_json_frame(&mut socket, &connect_request)
        .await
        .map_err(|e| format!("发送 Gateway connect 请求失败: {e}"))?;
    let connect_frame =
        next_matching_response(&mut socket, &connect_id, false, request_timeout_secs)
            .await
            .map_err(|e| format!("Gateway connect 失败: {e}"))?;
    let _hello = validated_connect_payload(&connect_frame, &connect_id)?;
    Ok(socket)
}

/// True for a local basic-auth endpoint: the single-writer local gateway, which
/// authenticates by password (`--auth password`) — no device identity, no
/// signing.
///
/// Accio-aligned locality gating: the local path has exactly ONE auth route (the
/// per-run password) and must NEVER fall through to the device-auth handshake —
/// the `--auth password` gateway rejects device-auth (`password_missing` →
/// `device-required`), which is precisely how a stray device identity from a
/// past provision desynced the whole desktop↔gateway backend connection. We key
/// on our in-memory per-run password rather than on endpoint *shape*: a leftover
/// `token`/`device_token` on a local endpoint can no longer divert it to
/// device-auth. The per-run password can't collide with SSH-tunnel/remote
/// endpoints — those carry the *remote* gateway's password, never ours.
fn endpoint_is_basic_auth(endpoint: &GatewayEndpoint) -> bool {
    if endpoint
        .password
        .as_deref()
        .is_some_and(|p| p == crate::services::openclaw_connection::local_gateway_password())
    {
        return true;
    }
    let present = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.trim().is_empty());
    present(&endpoint.password) && !present(&endpoint.token) && !present(&endpoint.device_token)
}

pub(crate) async fn connect_endpoint_socket_with_device_auth<R: Runtime>(
    app: &AppHandle<R>,
    endpoint: &GatewayEndpoint,
    connect_timeout_secs: u64,
    request_timeout_secs: u64,
) -> Result<GatewaySocket, String> {
    // Local basic-auth short-circuits the device-auth handshake: send only
    // `{auth:{password}}` (what the password-mode gateway expects) via the plain
    // connect. Skipping `ensure_device_identity`/cached-token resolution here is
    // essential — otherwise a stale cached device token would be preferred over
    // the password and desync against the freshly-spawned password-mode gateway.
    if endpoint_is_basic_auth(endpoint) {
        return connect_endpoint_socket(endpoint, connect_timeout_secs, request_timeout_secs).await;
    }
    let device_identity = openclaw_device_auth::ensure_device_identity(app)?;
    let cached_device_token =
        openclaw_device_auth::read_cached_device_token(app, &device_identity.device_id)?;
    let (mut socket, _) = timeout(
        Duration::from_secs(connect_timeout_secs),
        connect_async(&endpoint.url),
    )
    .await
    .map_err(|_| format!("连接 Uniopc 引擎 超时: {}", endpoint.url))?
    .map_err(|e| transport_error(&e))?;

    let challenge = next_text_frame(&mut socket, connect_timeout_secs)
        .await
        .map_err(|e| format!("读取 Gateway challenge 失败: {e}"))?;
    let nonce = connect_nonce_from_challenge(&challenge)?;

    let connect_id = format!("imai-connect-{}", uuid::Uuid::new_v4());
    let connect_request = build_signed_connect_request(
        app,
        endpoint,
        &device_identity,
        cached_device_token.as_ref(),
        &connect_id,
        &nonce,
    )?;
    send_json_frame(&mut socket, &connect_request)
        .await
        .map_err(|e| format!("发送 Gateway connect 请求失败: {e}"))?;
    let connect_frame =
        next_matching_response(&mut socket, &connect_id, false, request_timeout_secs)
            .await
            .map_err(|e| format!("Gateway connect 失败: {e}"))?;
    let hello = validated_connect_payload(&connect_frame, &connect_id)?;
    persist_issued_device_token(app, &device_identity.device_id, &hello);
    Ok(socket)
}

pub async fn send_json_frame<S>(socket: &mut S, value: &Value) -> Result<(), String>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .map_err(|e| e.to_string())
}

pub async fn next_text_frame<S>(socket: &mut S, timeout_secs: u64) -> Result<String, String>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let frame = timeout(Duration::from_secs(timeout_secs), socket.next())
        .await
        .map_err(|_| "等待 WebSocket 帧超时。".to_string())?
        .ok_or_else(|| "Gateway 在返回响应前关闭连接。".to_string())?
        .map_err(|e| e.to_string())?;
    frame
        .into_text()
        .map(|text| text.to_string())
        .map_err(|_| "Gateway 响应不是文本帧。".to_string())
}

pub async fn next_matching_response<S>(
    socket: &mut S,
    id: &str,
    expect_final: bool,
    timeout_secs: u64,
) -> Result<Value, String>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let text = next_text_frame(socket, timeout_secs).await?;
        if text.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("res") {
            continue;
        }
        if value.get("id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        let status = value
            .get("payload")
            .and_then(|payload| payload.get("status"))
            .and_then(Value::as_str);
        if expect_final && status == Some("accepted") {
            continue;
        }
        return Ok(value);
    }
}

fn build_connect_request(endpoint: &GatewayEndpoint, id: &str, _nonce: &str) -> Value {
    let auth = match (
        endpoint.token.as_ref().filter(|value| !value.is_empty()),
        endpoint.password.as_ref().filter(|value| !value.is_empty()),
        endpoint
            .device_token
            .as_ref()
            .filter(|value| !value.is_empty()),
    ) {
        (Some(token), _, _) => Some(json!({ "token": token })),
        (None, Some(password), _) => Some(json!({ "password": password })),
        (None, None, Some(device_token)) => Some(json!({ "deviceToken": device_token })),
        (None, None, None) => None,
    };

    let mut params = json!({
        "minProtocol": 3,
        "maxProtocol": 4,
        "client": {
            "id": "gateway-client",
            "displayName": GATEWAY_CLIENT_DISPLAY_NAME,
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "mode": "backend"
        },
        "role": "operator",
        "scopes": DEFAULT_OPERATOR_CONNECT_SCOPES,
        // Without this cap the gateway only sends us the args-less `item` tool
        // frames (or routes the real ones to session subscribers as
        // `session.tool`), so the 产物 panel has nothing to extract file paths
        // from. See GATEWAY_CLIENT_CAPS.TOOL_EVENTS in the engine.
        "caps": GATEWAY_CLIENT_CAPS
    });
    if let Some(auth) = auth {
        if let Some(params) = params.as_object_mut() {
            params.insert("auth".to_string(), auth);
        }
    }

    json!({
        "type": "req",
        "id": id,
        "method": "connect",
        "params": params
    })
}

fn build_signed_connect_request<R: Runtime>(
    app: &AppHandle<R>,
    endpoint: &GatewayEndpoint,
    device_identity: &openclaw_device_auth::DeviceIdentityInfo,
    cached_device_token: Option<&openclaw_device_auth::StoredGatewayDeviceToken>,
    id: &str,
    nonce: &str,
) -> Result<Value, String> {
    let client_id = "gateway-client";
    let client_mode = "backend";
    let device_family = "desktop";
    let role = "operator";
    let scopes = openclaw_device_auth::operator_connect_scopes();
    let platform = std::env::consts::OS.to_string();
    let signed_at = chrono::Utc::now().timestamp_millis();
    let token = endpoint
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            endpoint
                .device_token
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            cached_device_token
                .filter(|token| {
                    openclaw_device_auth::cached_device_token_covers_official_operator_scopes(token)
                })
                .map(|token| token.device_token.as_str())
        });
    let password = if token.is_some() {
        None
    } else {
        endpoint
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };

    let mut auth = serde_json::Map::new();
    if let Some(token) = token {
        auth.insert("token".to_string(), json!(token));
    } else if let Some(password) = password {
        auth.insert("password".to_string(), json!(password));
    }

    let device = openclaw_device_auth::signed_device_connect_params(
        device_identity,
        client_id,
        client_mode,
        role,
        &scopes,
        signed_at,
        token,
        nonce,
        &platform,
        device_family,
    )?;
    let package = app.package_info();
    let mut params = json!({
        "minProtocol": 3,
        "maxProtocol": 4,
        "client": {
            "id": client_id,
            "displayName": GATEWAY_CLIENT_DISPLAY_NAME,
            "version": package.version.to_string(),
            "platform": platform,
            "deviceFamily": device_family,
            "mode": client_mode
        },
        "role": role,
        "scopes": scopes,
        "caps": GATEWAY_CLIENT_CAPS,
        "commands": [],
        "permissions": {},
        "locale": "zh-CN",
        "userAgent": format!("uniopc-desktop/{}", package.version),
        "device": device
    });
    if !auth.is_empty() {
        if let Some(params) = params.as_object_mut() {
            params.insert("auth".to_string(), Value::Object(auth));
        }
    }

    Ok(json!({
        "type": "req",
        "id": id,
        "method": "connect",
        "params": params
    }))
}

fn persist_issued_device_token<R: Runtime>(app: &AppHandle<R>, device_id: &str, hello: &Value) {
    let Some(device_token) = hello
        .get("auth")
        .and_then(|auth| auth.get("deviceToken"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let role = hello
        .get("auth")
        .and_then(|auth| auth.get("role"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let scopes = hello
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
    let _ = openclaw_device_auth::persist_cached_device_token(
        app,
        device_id,
        device_token,
        role,
        scopes,
    );
}

fn agent_create_params(req: &GatewayAgentCreateRequest) -> Value {
    let mut params = json!({
        "name": req.agent_id,
        "workspace": req.workspace,
        "emoji": req.emoji
    });
    if let Some(model) = req
        .model
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        params["model"] = Value::String(model.to_string());
    }
    params
}

async fn apply_agent_update_with_retry(
    profile: Option<&str>,
    req: &GatewayAgentCreateRequest,
) -> Result<(), String> {
    if req.name.trim() == req.agent_id && req.emoji.trim().is_empty() {
        return Ok(());
    }

    let mut last_error = None;
    for attempt in 0..GATEWAY_CREATE_RECOVERY_ATTEMPTS {
        let result = async {
            let config = load_openclaw_config_for_profile(profile)?;
            let endpoint = gateway_endpoint_from_config(&config)?;
            request_json(
                &endpoint,
                "agents.update",
                json!({
                    "agentId": req.agent_id,
                    "name": req.name,
                    "emoji": req.emoji,
                    "model": req.model
                }),
                false,
            )
            .await
        }
        .await;

        match result {
            Ok(_) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                if attempt + 1 < GATEWAY_CREATE_RECOVERY_ATTEMPTS {
                    sleep(Duration::from_millis(GATEWAY_CREATE_RECOVERY_DELAY_MS)).await;
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Gateway agents.update failed".to_string()))
}

async fn find_agent_json_with_retry(
    profile: Option<&str>,
    agent_id: &str,
) -> Result<Value, String> {
    let mut last_error = None;
    for attempt in 0..GATEWAY_CREATE_RECOVERY_ATTEMPTS {
        match agents_list_json(profile).await {
            Ok(agents) => {
                if let Some(agent) = agents
                    .into_iter()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(agent_id))
                {
                    return Ok(agent);
                }
                last_error = Some("agents.list 未找到新员工。".to_string());
            }
            Err(error) => {
                last_error = Some(error);
            }
        }

        if attempt + 1 < GATEWAY_CREATE_RECOVERY_ATTEMPTS {
            sleep(Duration::from_millis(GATEWAY_CREATE_RECOVERY_DELAY_MS)).await;
        }
    }

    Err(last_error.unwrap_or_else(|| "agents.list 未找到新员工。".to_string()))
}

fn agent_value_with_requested_identity(mut value: Value, req: &GatewayAgentCreateRequest) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("id".to_string(), Value::String(req.agent_id.clone()));
        object.insert("agentId".to_string(), Value::String(req.agent_id.clone()));
        object.insert("name".to_string(), Value::String(req.name.clone()));
        object.insert("identityName".to_string(), Value::String(req.name.clone()));
        object.insert(
            "identityEmoji".to_string(),
            Value::String(req.emoji.clone()),
        );
        if let Some(model) = req
            .model
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            object.insert("model".to_string(), Value::String(model.to_string()));
        }
    }
    value
}

fn connect_nonce_from_challenge(value: &str) -> Result<String, String> {
    let frame = serde_json::from_str::<Value>(value)
        .map_err(|e| format!("解析 Gateway challenge 失败: {e}"))?;
    if frame.get("type").and_then(Value::as_str) != Some("event")
        || frame.get("event").and_then(Value::as_str) != Some("connect.challenge")
    {
        return Err("Gateway 第一帧不是 connect.challenge。".to_string());
    }
    frame
        .get("payload")
        .and_then(|payload| payload.get("nonce"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Gateway connect.challenge 缺少 nonce。".to_string())
}

fn response_payload_for_method(frame: &Value, expected_id: &str, method: &str) -> Result<Value, String> {
    let result = response_payload(frame, expected_id);
    if method != "browser.request" || result.is_ok() { return result; }
    // Keep only known browser diagnostic categories. Never forward the raw
    // Gateway message, which can contain request or credential values.
    let message = frame.pointer("/error/message").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    let category = if message.contains("unknown method: browser.request") {
        Some("unknown method: browser.request")
    } else if message.contains("scope") || message.contains("pairing required") {
        Some("browser scope upgrade pending approval")
    } else if message.contains("browser disabled") || message.contains("browser_disabled") {
        Some("browser disabled")
    } else if message.contains("cannot reach") || message.contains("connection refused") {
        Some("browser control connection unavailable")
    } else if frame.pointer("/error/code").and_then(Value::as_str) == Some("INVALID_REQUEST") {
        Some("browser request rejected: check plugin and tool policy")
    } else { None };
    match category { Some(category) => Err(category.to_string()), None => result }
}

pub fn response_payload(frame: &Value, expected_id: &str) -> Result<Value, String> {
    if frame.get("type").and_then(Value::as_str) != Some("res") {
        return Err("Gateway 响应不是 res 帧。".to_string());
    }
    if frame.get("id").and_then(Value::as_str) != Some(expected_id) {
        return Err("Gateway 响应 id 不匹配。".to_string());
    }
    if frame.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(frame.get("payload").cloned().unwrap_or(Value::Null));
    }

    // Do not format or forward the Gateway's raw error message. This one
    // well-defined response is safe to classify locally and is necessary for
    // config_patch_with_retry to refresh its base hash after another local
    // process (notably `plugins install`) has updated the config file.
    if frame
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(|message| message.to_lowercase().contains("config changed since last load"))
        .unwrap_or(false)
    {
        return Err(CONFIG_CHANGED_SINCE_LAST_LOAD.to_string());
    }

    let error = normalize_gateway_error(frame.clone());
    log_normalized_gateway_error(&error);
    Err(serde_json::to_string(&error)
        .unwrap_or_else(|_| "gateway.unknown (GATEWAY_ERROR)".to_string()))
}

fn log_normalized_gateway_error(error: &UniopcGatewayError) {
    eprintln!(
        "Gateway request rejected: code={} traceId={} messageKey={}",
        error.code, error.trace_id, error.message_key
    );
}

pub fn validated_connect_payload(frame: &Value, expected_id: &str) -> Result<Value, String> {
    let hello = response_payload(frame, expected_id)?;
    gateway_capabilities(hello.clone()).map_err(|error| error.to_string())?;
    Ok(hello)
}

fn agents_from_gateway_payload(payload: &Value) -> Result<Vec<GatewayAgent>, String> {
    let items = payload
        .as_array()
        .or_else(|| payload.get("agents").and_then(Value::as_array))
        .ok_or_else(|| "Uniopc 引擎 agents.list 没有返回 agents 数组。".to_string())?;
    Ok(items.iter().map(gateway_agent_from_value).collect())
}

fn gateway_agent_from_value(item: &Value) -> GatewayAgent {
    let identity = item.get("identity");
    let identity_name = string_field(item, "identityName")
        .or_else(|| identity.and_then(|value| string_field(value, "name")));
    GatewayAgent {
        id: string_field(item, "id").unwrap_or_else(|| "main".to_string()),
        name: string_field(item, "name").or_else(|| identity_name.clone()),
        identity_name,
        emoji: string_field(item, "identityEmoji")
            .or_else(|| identity.and_then(|value| string_field(value, "emoji"))),
        workspace: string_field(item, "workspace").unwrap_or_default(),
        agent_dir: string_field(item, "agentDir").unwrap_or_default(),
        model: string_field(item, "model"),
        is_default: item
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        bindings: item.get("bindings").and_then(Value::as_u64).unwrap_or(0),
        routes: string_array_field(item, "routes"),
        providers: string_array_field(item, "providers"),
    }
}

fn agents_from_config(config: &Value, profile: Option<&str>) -> Result<Vec<GatewayAgent>, String> {
    let profile_dir = openclaw_profile_dir(profile)?;
    let agents_root = config.get("agents");
    let default_id = default_agent_id_from_config(config);
    let defaults = agents_root.and_then(|agents| agents.get("defaults"));
    let default_workspace = defaults
        .and_then(|defaults| string_field(defaults, "workspace"))
        .unwrap_or_default();
    let default_model = defaults
        .and_then(|defaults| defaults.get("model"))
        .and_then(|model| string_field(model, "primary"))
        .or_else(|| defaults.and_then(|defaults| string_field(defaults, "model")));

    let entries = agents_root
        .and_then(|agents| agents.get("list"))
        .and_then(Value::as_array);

    let mut agents = entries
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = string_field(entry, "id")?;
            let identity = entry.get("identity");
            let identity_name = string_field(entry, "identityName")
                .or_else(|| identity.and_then(|value| string_field(value, "name")));
            let emoji = string_field(entry, "identityEmoji")
                .or_else(|| identity.and_then(|value| string_field(value, "emoji")));
            let workspace =
                string_field(entry, "workspace").unwrap_or_else(|| default_workspace.clone());
            let agent_dir = string_field(entry, "agentDir").unwrap_or_else(|| {
                profile_dir
                    .join("agents")
                    .join(&id)
                    .join("agent")
                    .to_string_lossy()
                    .to_string()
            });
            let model = string_field(entry, "model").or_else(|| default_model.clone());
            let is_default = entry
                .get("default")
                .or_else(|| entry.get("isDefault"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || id == default_id;

            Some(GatewayAgent {
                id,
                name: string_field(entry, "name").or_else(|| identity_name.clone()),
                identity_name,
                emoji,
                workspace,
                agent_dir,
                model,
                is_default,
                bindings: entry.get("bindings").and_then(Value::as_u64).unwrap_or(0),
                routes: string_array_field(entry, "routes"),
                providers: string_array_field(entry, "providers"),
            })
        })
        .collect::<Vec<_>>();

    if agents.is_empty() {
        let id = if default_id.trim().is_empty() {
            "main".to_string()
        } else {
            default_id
        };
        agents.push(GatewayAgent {
            id: id.clone(),
            name: None,
            identity_name: None,
            emoji: None,
            workspace: default_workspace,
            agent_dir: profile_dir
                .join("agents")
                .join(&id)
                .join("agent")
                .to_string_lossy()
                .to_string(),
            model: default_model,
            is_default: true,
            bindings: 0,
            routes: Vec::new(),
            providers: Vec::new(),
        });
    }

    Ok(agents)
}

fn default_agent_id_from_config(config: &Value) -> String {
    let agents = config.get("agents");
    if let Some(id) = agents
        .and_then(|agents| agents.get("defaultId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return id.to_string();
    }

    let entries = agents
        .and_then(|agents| agents.get("list"))
        .and_then(Value::as_array);
    if let Some(id) = entries.and_then(|entries| {
        entries.iter().find_map(|entry| {
            let is_default = entry
                .get("default")
                .or_else(|| entry.get("isDefault"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if is_default {
                string_field(entry, "id")
            } else {
                None
            }
        })
    }) {
        return id;
    }

    if let Some(id) =
        entries.and_then(|entries| entries.iter().find_map(|entry| string_field(entry, "id")))
    {
        return id;
    }

    "main".to_string()
}

fn enrich_agents_from_config(
    agents: &mut [GatewayAgent],
    config: &Value,
    profile: Option<&str>,
) -> Result<(), String> {
    let default_id = default_agent_id_from_config(config);
    let profile_dir = openclaw_profile_dir(profile)?;
    let entries = config
        .get("agents")
        .and_then(|agents| agents.get("list"))
        .and_then(Value::as_array);

    for agent in agents {
        if agent.id == default_id || agent.id == "main" {
            agent.is_default = true;
        }
        let entry = entries.and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(agent.id.as_str()))
        });
        if let Some(entry) = entry {
            if agent.name.is_none() {
                agent.name = string_field(entry, "name");
            }
            if agent.identity_name.is_none() {
                agent.identity_name = entry
                    .get("identity")
                    .and_then(|identity| string_field(identity, "name"));
            }
            if agent.emoji.is_none() {
                agent.emoji = entry
                    .get("identity")
                    .and_then(|identity| string_field(identity, "emoji"));
            }
            if agent.agent_dir.is_empty() {
                agent.agent_dir = string_field(entry, "agentDir").unwrap_or_default();
            }
        }
        if agent.agent_dir.is_empty() {
            agent.agent_dir = profile_dir
                .join("agents")
                .join(&agent.id)
                .join("agent")
                .to_string_lossy()
                .to_string();
        }
    }
    Ok(())
}

fn gateway_agent_to_value(agent: GatewayAgent) -> Value {
    let mut item = serde_json::Map::new();
    item.insert("id".to_string(), Value::String(agent.id));
    if let Some(name) = agent.name {
        item.insert("name".to_string(), Value::String(name));
    }
    if let Some(identity_name) = agent.identity_name {
        item.insert("identityName".to_string(), Value::String(identity_name));
    }
    if let Some(emoji) = agent.emoji {
        item.insert("identityEmoji".to_string(), Value::String(emoji));
    }
    item.insert("workspace".to_string(), Value::String(agent.workspace));
    item.insert("agentDir".to_string(), Value::String(agent.agent_dir));
    if let Some(model) = agent.model {
        item.insert("model".to_string(), Value::String(model));
    }
    item.insert("isDefault".to_string(), Value::Bool(agent.is_default));
    item.insert(
        "bindings".to_string(),
        Value::Number(serde_json::Number::from(agent.bindings)),
    );
    item.insert(
        "routes".to_string(),
        Value::Array(agent.routes.into_iter().map(Value::String).collect()),
    );
    item.insert(
        "providers".to_string(),
        Value::Array(agent.providers.into_iter().map(Value::String).collect()),
    );
    Value::Object(item)
}

fn gateway_endpoint_from_config(config: &Value) -> Result<GatewayEndpoint, String> {
    let gateway = config.get("gateway");
    let mode = gateway
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_lowercase();
    let remote = gateway.and_then(|value| value.get("remote"));
    let remote_transport = remote
        .and_then(|value| value.get("transport"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_lowercase();
    if mode == "remote" && remote_transport == "direct" {
        let url = remote
            .and_then(|value| value.get("url"))
            .and_then(Value::as_str)
            .map(ws_url_from_gateway_url)
            .map(|value| value.trim_end_matches('/').to_string())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "gateway.remote.url missing or invalid for direct transport".to_string()
            })?;
        let auth_mode = remote.and_then(|value| string_field(value, "authMode"));
        let (token, password) = select_gateway_auth_by_mode(
            auth_mode.as_deref(),
            remote.and_then(|value| string_field(value, "token")),
            remote.and_then(|value| string_field(value, "password")),
        );
        return Ok(GatewayEndpoint {
            url,
            token,
            password,
            device_token: remote.and_then(|value| string_field(value, "deviceToken")),
        });
    }
    let port = gateway
        .and_then(|value| value.get("port"))
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(DEFAULT_GATEWAY_PORT);
    let url = gateway
        .and_then(|value| value.get("url"))
        .and_then(Value::as_str)
        .map(ws_url_from_gateway_url)
        .unwrap_or_else(|| format!("ws://127.0.0.1:{port}"));
    // Local single-writer authenticates by the per-run password we hold in
    // memory — it is deliberately NOT written to openclaw.json (that would
    // restart the `--auth password` gateway on every launch). Config therefore
    // carries no auth for local, so inject the in-memory password here and drop
    // any stray token/device identity. This is what lets the config-sourced
    // consumers — `auth_secret`, `config_metadata`, and the operator / MCP-bridge
    // connect frames built from them — authenticate by password exactly like the
    // stream path, instead of sending a device-signature-only frame that a
    // password-mode gateway rejects (`password_missing` / `device-required`).
    // Gate strictly on the explicit local mode our own config always carries
    // (`gateway.mode == "local"`); a config that pins an explicit auth block with
    // no mode is a different contract and keeps reading its own auth below.
    if mode == "local" {
        return Ok(GatewayEndpoint {
            // Always the port the engine actually bound this run (dynamic), never
            // config's stale `gateway.port` — that value is not written any more
            // and would send config-sourced connects (operator / MCP bridge) to
            // the wrong port when a free fallback port was used.
            url: format!(
                "ws://127.0.0.1:{}",
                crate::services::openclaw_connection::local_gateway_port()
            ),
            token: None,
            password: Some(
                crate::services::openclaw_connection::local_gateway_password().to_string(),
            ),
            device_token: None,
        });
    }
    let auth = gateway.and_then(|value| value.get("auth"));
    let auth_mode = auth.and_then(|value| string_field(value, "mode"));
    let (token, password) = select_gateway_auth_by_mode(
        auth_mode.as_deref(),
        auth.and_then(|value| string_field(value, "token"))
            .or_else(|| {
                gateway
                    .and_then(|value| value.get("remote"))
                    .and_then(|value| string_field(value, "token"))
            }),
        auth.and_then(|value| string_field(value, "password")),
    );
    let device_token = auth
        .and_then(|value| string_field(value, "deviceToken"))
        .or_else(|| {
            gateway
                .and_then(|value| value.get("remote"))
                .and_then(|value| string_field(value, "deviceToken"))
        });

    Ok(GatewayEndpoint {
        url: if url.trim().is_empty() {
            DEFAULT_GATEWAY_WS_URL.to_string()
        } else {
            url
        },
        token,
        password,
        device_token,
    })
}

fn select_gateway_auth_by_mode(
    mode: Option<&str>,
    token: Option<String>,
    password: Option<String>,
) -> (Option<String>, Option<String>) {
    match mode
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "password" => (None, password),
        "token" => (token, None),
        _ => (token, password),
    }
}

fn gateway_metadata_from_config(config: &Value) -> Result<GatewayConfigMetadata, String> {
    let endpoint = gateway_endpoint_from_config(config)?;
    let gateway = config.get("gateway");
    let auth = gateway.and_then(|value| value.get("auth"));
    let mode = gateway
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_lowercase();
    // Local single-writer is always password auth (the per-run in-memory
    // password), even though openclaw.json carries no auth block for local — so
    // consumers that branch on `auth_mode` (e.g. the operator/MCP-bridge connect
    // builder) attach the password rather than falling through to device-auth.
    let auth_mode = if mode == "local" {
        "password".to_string()
    } else {
        auth.and_then(|value| value.get("mode"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("unknown")
            .to_string()
    };
    let port = gateway
        .and_then(|value| value.get("port"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_GATEWAY_PORT as u64);
    let bind_url = gateway
        .and_then(|value| value.get("bind"))
        .and_then(Value::as_str)
        .map(|bind| format!("ws://{}:{port}", normalize_gateway_host(bind)));

    // For local, `endpoint.url` already carries the actual bound (dynamic) port;
    // the config-derived `bind_url` would carry the stale config port, so it must
    // not override it (this ws_url feeds the operator / MCP-bridge connect).
    let ws_url = if mode == "local" {
        endpoint.url.clone()
    } else {
        bind_url.unwrap_or_else(|| endpoint.url.clone())
    };
    Ok(GatewayConfigMetadata {
        ws_url,
        auth_mode,
        has_token: endpoint.token.is_some(),
        has_password: endpoint.password.is_some(),
    })
}

fn normalize_gateway_host(bind: &str) -> String {
    match bind.trim() {
        "" | "loopback" | "auto" | "127.0.0.1" | "::1" | "localhost" => "127.0.0.1".to_string(),
        "0.0.0.0" | "::" | "lan" | "tailnet" => "127.0.0.1".to_string(),
        other => other.to_string(),
    }
}

fn ws_url_from_gateway_url(url: &str) -> String {
    let trimmed = url.trim();
    if let Some(rest) = trimmed.strip_prefix("http://") {
        return format!("ws://{rest}");
    }
    if let Some(rest) = trimmed.strip_prefix("https://") {
        return format!("wss://{rest}");
    }
    trimmed.to_string()
}

pub fn load_openclaw_config_for_profile(profile: Option<&str>) -> Result<Value, String> {
    let path = openclaw_config_path_for_profile(profile)?;
    if !path.exists() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 Uniopc 引擎 配置失败: {e}"))?;
    parse_openclaw_config_text(&text)
}

/// The engine's config contract is JSON5 (comments, trailing commas, single
/// quotes are all valid to the engine's own parser). Strict JSON first —
/// everything we write is strict — then a JSON5 fallback so a hand-edited
/// config the ENGINE happily boots with doesn't read as "解析失败" here and
/// take down every config-derived path (endpoint resolution, spawn prep).
fn parse_openclaw_config_text(text: &str) -> Result<Value, String> {
    match serde_json::from_str(text) {
        Ok(value) => Ok(value),
        Err(strict_error) => {
            json5::from_str(text).map_err(|_| format!("解析 Uniopc 引擎 配置失败: {strict_error}"))
        }
    }
}

pub fn openclaw_config_path_for_profile(profile: Option<&str>) -> Result<PathBuf, String> {
    let profile_dir = openclaw_profile_dir(profile)?;
    migrate_profile_config_name(&profile_dir)?;
    Ok(profile_dir.join("uniopc-engine.json"))
}

/// Move the engine's conventional config and backups to Uniopc-owned names.
/// Never overwrite an existing destination: conflicting legacy files are
/// retained under a Uniopc conflict name for recovery.
fn migrate_profile_config_name(profile_dir: &Path) -> Result<(), String> {
    use std::fs;
    if !profile_dir.is_dir() {
        return Ok(());
    }
    let entries = fs::read_dir(profile_dir)
        .map_err(|error| format!("读取 Uniopc 引擎配置目录失败: {error}"))?;
    for entry in entries.filter_map(Result::ok) {
        let source = entry.path();
        let Some(name) = source.file_name().and_then(|value| value.to_str()) else { continue };
        let Some(suffix) = name.strip_prefix("openclaw.json") else { continue };
        let destination_name = if suffix.is_empty() {
            "uniopc-engine.json".to_string()
        } else if suffix.starts_with(".bak") || suffix.starts_with(".backup.") {
            format!("uniopc-engine.json{suffix}")
        } else {
            continue;
        };
        let mut destination = profile_dir.join(&destination_name);
        if destination.exists() {
            if fs::read(&destination).ok() == fs::read(&source).ok() {
                fs::remove_file(&source).map_err(|error| format!("清理重复的旧引擎配置失败: {error}"))?;
                continue;
            }
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
            let mut index = 0_u32;
            loop {
                destination = profile_dir.join(format!("uniopc-engine.legacy-conflict-{stamp}-{index}.json"));
                if !destination.exists() { break; }
                index += 1;
            }
        }
        fs::rename(&source, &destination)
            .map_err(|error| format!("迁移 Uniopc 引擎配置文件名失败: {error}"))?;
    }
    Ok(())
}

fn openclaw_profile_dir(profile: Option<&str>) -> Result<PathBuf, String> {
    // Per-account isolation: the engine config/state lives in `state-v8/<key>`,
    // keyed by the explicit cloud profile when threaded through, else the active
    // account marker (`active-profile.json`), else `state-v8/default` (logged out).
    crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(profile)
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string_array_field(value: &Value, field: &str) -> Vec<String> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::openclaw_device_auth;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use serde_json::json;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use tokio_tungstenite::accept_async;

    #[tokio::test]
    async fn http_readiness_requires_literal_ready_true() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, body, expected) in [("200 OK", r#"{"ready":false}"#, false), ("200 OK", r#"{"ready":true}"#, true), ("200 OK", r#"{"ok":true}"#, false), ("503 Service Unavailable", r#"{"ready":true}"#, false)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0u8; 4096];
                socket.read(&mut buffer).await.unwrap();
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let endpoint = GatewayEndpoint { url: format!("ws://127.0.0.1:{port}"), token: None, password: None, device_token: None };
            assert_eq!(http_ready_for_endpoint(&endpoint).await.unwrap(), expected);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn http_readiness_invalid_json_and_builder_error_are_permanent() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            socket.read(&mut buffer).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\ninvalid").await.unwrap();
        });
        for (url, expected) in [
            (format!("ws://{address}"), "gateway_http_readiness_schema_invalid"),
            ("http://[invalid".to_string(), "gateway_http_readiness_failed"),
        ] {
            let endpoint = GatewayEndpoint { url, token: None, password: None, device_token: None };
            let error = http_ready_for_endpoint(&endpoint).await.unwrap_err();
            assert_eq!(error, expected);
            assert!(!crate::services::startup_readiness::transient(&error));
        }
        server.await.unwrap();
    }

    #[test]
    fn localized_connection_refused_uses_stable_recoverable_code() {
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionRefused,
            "由于目标计算机积极拒绝，无法连接。(os error 10061)");
        let error = transport_error(&tokio_tungstenite::tungstenite::Error::Io(io));
        assert_eq!(error, "gateway_transport_connection_refused");
        assert!(crate::services::startup_readiness::transient(&error));
        assert!(!crate::services::startup_readiness::transient("unauthorized password_mismatch"));
        assert!(!crate::services::startup_readiness::transient("invalid schema"));
    }

    #[test]
    fn legacy_config_and_backups_migrate_without_overwriting_new_files() {
        let root = std::env::temp_dir().join(format!("uniopc-config-migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("openclaw.json"), "legacy config").unwrap();
        fs::write(root.join("openclaw.json.bak.1"), "legacy backup").unwrap();
        migrate_profile_config_name(&root).unwrap();
        assert_eq!(fs::read_to_string(root.join("uniopc-engine.json")).unwrap(), "legacy config");
        assert_eq!(fs::read_to_string(root.join("uniopc-engine.json.bak.1")).unwrap(), "legacy backup");
        assert!(!root.join("openclaw.json").exists());

        fs::write(root.join("openclaw.json"), "second legacy config").unwrap();
        migrate_profile_config_name(&root).unwrap();
        let conflicts = fs::read_dir(&root).unwrap().filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("uniopc-engine.legacy-conflict-"))
            .collect::<Vec<_>>();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(fs::read_to_string(conflicts[0].path()).unwrap(), "second legacy config");
        assert!(!root.join("openclaw.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_single_writer_endpoint_is_basic_auth_even_with_stray_device_token() {
        // The runtime failure: a device identity left over from a past provision
        // put a `device_token` on the LOCAL endpoint, flipping the shape-based
        // check false → device-auth on the `--auth password` gateway → all
        // backend connections rejected (password_missing / device-required).
        // Keyed on the per-run password, a local endpoint is basic-auth
        // regardless of any stray token/device_token.
        let local_pw = crate::services::openclaw_connection::local_gateway_password().to_string();
        let poisoned_local = GatewayEndpoint {
            url: "ws://127.0.0.1:18790".to_string(),
            token: Some("stale-token".to_string()),
            password: Some(local_pw),
            device_token: Some("stale-device-token".to_string()),
        };
        assert!(endpoint_is_basic_auth(&poisoned_local));

        // A remote endpoint (its own password + token, not our per-run password)
        // must still NOT be treated as basic-auth — it needs the device-auth /
        // token handshake.
        let remote = GatewayEndpoint {
            url: "wss://gateway.example:18790".to_string(),
            token: Some("remote-token".to_string()),
            password: Some("some-remote-password".to_string()),
            device_token: None,
        };
        assert!(!endpoint_is_basic_auth(&remote));
    }

    enum FakeConnectResponse {
        Ok,
        AuthFailure,
        NonChallengeFirstFrame,
    }

    fn fake_hello_payload() -> Value {
        let mut value: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/openclaw-2026.8.1/hello-ok.json"
        )))
        .expect("hello fixture");
        value["server"]["version"] =
            Value::String(env!("IMAI_OPENCLAW_VERSION").to_string());
        value
    }

    async fn spawn_fake_gateway(
        response: FakeConnectResponse,
    ) -> (String, oneshot::Receiver<Value>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake gateway");
        let url = format!("ws://{}", listener.local_addr().expect("local addr"));
        let (request_tx, request_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (stream, _) = listener
                .accept()
                .await
                .expect("accept fake gateway connection");
            let mut socket = accept_async(stream).await.expect("accept websocket");
            match response {
                FakeConnectResponse::NonChallengeFirstFrame => {
                    socket
                        .send(Message::Text(
                            json!({
                                "type": "event",
                                "event": "gateway.ready",
                                "payload": {}
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .expect("send non challenge frame");
                    return;
                }
                FakeConnectResponse::Ok | FakeConnectResponse::AuthFailure => {
                    socket
                        .send(Message::Text(
                            json!({
                                "type": "event",
                                "event": "connect.challenge",
                                "payload": {
                                    "nonce": "nonce-1",
                                    "ts": 1
                                }
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .expect("send challenge");
                }
            }

            let request_text = socket
                .next()
                .await
                .expect("connect request frame")
                .expect("connect request ok")
                .into_text()
                .expect("connect request text");
            let request =
                serde_json::from_str::<Value>(&request_text).expect("connect request json");
            let request_id = request["id"]
                .as_str()
                .expect("connect request id")
                .to_string();
            let _ = request_tx.send(request);
            let response_frame = match response {
                FakeConnectResponse::Ok => json!({
                    "type": "res",
                    "id": request_id,
                    "ok": true,
                    "payload": fake_hello_payload()
                }),
                FakeConnectResponse::AuthFailure => json!({
                    "type": "res",
                    "id": request_id,
                    "ok": false,
                    "error": {
                        "code": "auth_failed",
                        "message": "Invalid Gateway credentials"
                    }
                }),
                FakeConnectResponse::NonChallengeFirstFrame => unreachable!(),
            };
            socket
                .send(Message::Text(response_frame.to_string().into()))
                .await
                .expect("send connect response");
            if matches!(response, FakeConnectResponse::Ok) {
                let Some(Ok(Message::Text(request_text))) = socket.next().await else {
                    return;
                };
                let request =
                    serde_json::from_str::<Value>(&request_text).expect("gateway request json");
                let request_id = request["id"].as_str().expect("gateway request id");
                socket
                    .send(Message::Text(
                        json!({
                            "type": "res",
                            "id": request_id,
                            "ok": true,
                            "payload": {
                                "ok": true,
                                "method": request["method"].as_str().unwrap_or_default()
                            }
                        })
                        .to_string()
                        .into(),
                    ))
                    .await
                    .expect("send gateway response");
            }
        });
        (url, request_rx)
    }

    async fn spawn_fake_device_auth_gateway(
        issued_device_token: &'static str,
    ) -> (String, oneshot::Receiver<Value>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake device auth gateway");
        let url = format!("ws://{}", listener.local_addr().expect("local addr"));
        let (request_tx, request_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (stream, _) = listener
                .accept()
                .await
                .expect("accept fake gateway connection");
            let mut socket = accept_async(stream).await.expect("accept websocket");
            let mut hello = fake_hello_payload();
            hello["auth"]["deviceToken"] = Value::String(issued_device_token.to_string());
            hello["auth"]["scopes"] = json!(DEFAULT_OPERATOR_CONNECT_SCOPES);
            socket
                .send(Message::Text(
                    json!({
                        "type": "event",
                        "event": "connect.challenge",
                        "payload": {
                            "nonce": "nonce-device-auth-1",
                            "ts": 1
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("send challenge");

            let request_text = socket
                .next()
                .await
                .expect("connect request frame")
                .expect("connect request ok")
                .into_text()
                .expect("connect request text");
            let request =
                serde_json::from_str::<Value>(&request_text).expect("connect request json");
            let request_id = request["id"]
                .as_str()
                .expect("connect request id")
                .to_string();
            let _ = request_tx.send(request);
            socket
                .send(Message::Text(
                    json!({
                        "type": "res",
                        "id": request_id,
                        "ok": true,
                        "payload": hello
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("send connect response");
            let _ = socket.next().await;
        });
        (url, request_rx)
    }

    fn verify_signed_device_auth_request(request: &Value, auth_token: &str) {
        let device = &request["params"]["device"];
        let public_key = device["publicKey"]
            .as_str()
            .expect("device public key should be present");
        let signature = device["signature"]
            .as_str()
            .expect("device signature should be present");
        let signed_at = device["signedAt"]
            .as_i64()
            .expect("device signedAt should be present");
        let device_id = device["id"].as_str().expect("device id should be present");
        let scopes = request["params"]["scopes"]
            .as_array()
            .expect("scopes should be array")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        let platform = request["params"]["client"]["platform"]
            .as_str()
            .expect("client platform should be present");
        let payload = openclaw_device_auth::build_openclaw_device_auth_payload_v3(
            device_id,
            "gateway-client",
            "backend",
            "operator",
            &scopes,
            signed_at,
            Some(auth_token),
            "nonce-device-auth-1",
            platform,
            Some("desktop"),
        );
        let public_key_bytes = URL_SAFE_NO_PAD
            .decode(public_key)
            .expect("public key base64url");
        let signature_bytes = URL_SAFE_NO_PAD
            .decode(signature)
            .expect("signature base64url");
        let verifying_key = VerifyingKey::from_bytes(
            &public_key_bytes
                .try_into()
                .expect("public key should be 32 bytes"),
        )
        .expect("valid public key");
        let signature = Signature::from_bytes(
            &signature_bytes
                .try_into()
                .expect("signature should be 64 bytes"),
        );
        verifying_key
            .verify(payload.as_bytes(), &signature)
            .expect("official v3 device-auth signature verifies");
    }

    #[test]
    fn gateway_config_uses_profile_port_and_token() {
        let config = json!({
            "gateway": {
                "port": 18888,
                "auth": {
                    "mode": "token",
                    "token": "abc123"
                }
            }
        });

        let endpoint = gateway_endpoint_from_config(&config).expect("endpoint");

        assert_eq!(endpoint.url, "ws://127.0.0.1:18888");
        assert_eq!(endpoint.token.as_deref(), Some("abc123"));
    }

    #[test]
    fn gateway_config_password_mode_does_not_send_stale_token() {
        let config = json!({
            "gateway": {
                "port": 19148,
                "auth": {
                    "mode": "password",
                    "token": "stale-token",
                    "password": "current-password"
                }
            }
        });

        let endpoint = gateway_endpoint_from_config(&config).expect("endpoint");

        assert_eq!(endpoint.url, "ws://127.0.0.1:19148");
        assert_eq!(endpoint.token, None);
        assert_eq!(endpoint.password.as_deref(), Some("current-password"));
    }

    #[test]
    fn gateway_config_local_mode_injects_in_memory_password_over_stray_auth() {
        // Local single-writer: config carries no real auth (the password lives in
        // memory). Any stray token/device identity baked into config must be
        // dropped and the per-run password injected, so the config-sourced
        // operator/MCP-bridge connect frames authenticate by password instead of
        // sending a device-signature-only frame the password-mode gateway rejects.
        let config = json!({
            "gateway": {
                "mode": "local",
                "port": 18790,
                "auth": { "mode": "token", "token": "stray", "deviceToken": "stray-device" }
            }
        });

        let endpoint = gateway_endpoint_from_config(&config).expect("endpoint");
        assert_eq!(endpoint.token, None);
        assert_eq!(endpoint.device_token, None);
        assert_eq!(
            endpoint.password.as_deref(),
            Some(crate::services::openclaw_connection::local_gateway_password())
        );

        let metadata = gateway_metadata_from_config(&config).expect("metadata");
        assert_eq!(metadata.auth_mode, "password");
        assert!(metadata.has_password);
        assert!(!metadata.has_token);
    }

    #[test]
    fn gateway_metadata_preserves_legacy_bind_port_and_auth_mode() {
        let config = json!({
            "gateway": {
                "bind": "0.0.0.0",
                "port": 18888,
                "auth": {
                    "mode": "password",
                    "password": "secret"
                }
            }
        });

        let metadata = gateway_metadata_from_config(&config).expect("metadata");

        assert_eq!(metadata.ws_url, "ws://127.0.0.1:18888");
        assert_eq!(metadata.auth_mode, "password");
        assert!(!metadata.has_token);
        assert!(metadata.has_password);
    }

    #[test]
    fn successful_gateway_response_returns_payload() {
        let frame = json!({
            "type": "res",
            "id": "req-1",
            "ok": true,
            "payload": { "agents": [] }
        });

        let payload = response_payload(&frame, "req-1").expect("payload");

        assert_eq!(payload, json!({ "agents": [] }));
    }

    #[test]
    fn production_connect_payload_rejects_malformed_hello() {
        let mut hello: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/openclaw-2026.8.1/hello-ok.json"
        )))
        .expect("hello fixture");
        hello["server"]["version"] =
            Value::String(env!("IMAI_OPENCLAW_VERSION").to_string());
        hello.as_object_mut().expect("hello object").remove("snapshot");
        let frame = json!({
            "type": "res",
            "id": "connect-1",
            "ok": true,
            "payload": hello
        });

        assert!(validated_connect_payload(&frame, "connect-1").is_err());
    }

    #[test]
    fn rejected_gateway_response_returns_only_stable_normalized_error() {
        let frame = json!({
            "type": "res",
            "id": "req-1",
            "ok": false,
            "error": {
                "code": "UNAVAILABLE",
                "message": "token=secret at C:\\\\Users\\\\owner\\\\engine-openclaw",
                "details": { "traceId": "trace-call-chain" }
            }
        });

        let error = response_payload(&frame, "req-1").expect_err("request must fail");
        assert!(error.contains("gateway.unavailable"));
        assert!(!error.contains("trace-call-chain"));
        let normalized: Value = serde_json::from_str(&error).expect("normalized error DTO");
        assert!(uuid::Uuid::parse_str(
            normalized["traceId"].as_str().expect("local trace id")
        )
        .is_ok());
        assert!(!error.contains("secret"));
        assert!(!error.contains("C:\\\\Users"));
        assert!(!error.contains("engine-openclaw"));
    }

    #[test]
    fn rejected_gateway_logging_never_formats_the_raw_message() {
        let source = include_str!("openclaw_gateway.rs");

        assert!(!source.contains("eprintln!(\"Gateway request rejected: {message}\")"));
        assert!(source.contains("log_normalized_gateway_error(&error)"));
    }

    #[test]
    fn agents_list_accepts_array_or_wrapped_agents() {
        let wrapped = json!({
            "agents": [
                {
                    "id": "main",
                    "identity": { "name": "Main", "emoji": "robot" },
                    "workspace": "/tmp/workspace",
                    "agentDir": "/tmp/agent",
                    "model": "openai-codex/gpt-5.5",
                    "isDefault": true,
                    "bindings": 2,
                    "routes": ["default"],
                    "providers": ["feishu"]
                }
            ]
        });

        let agents = agents_from_gateway_payload(&wrapped).expect("agents");

        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "main");
        assert_eq!(agents[0].name.as_deref(), Some("Main"));
        assert_eq!(agents[0].emoji.as_deref(), Some("robot"));
        assert!(agents[0].is_default);
        assert_eq!(agents[0].bindings, 2);
        assert_eq!(agents[0].routes, vec!["default"]);
        assert_eq!(agents[0].providers, vec!["feishu"]);

        let direct = json!([{ "id": "main" }]);
        assert_eq!(
            agents_from_gateway_payload(&direct).expect("agents").len(),
            1
        );
    }

    #[test]
    fn config_agents_fallback_exposes_implicit_main_agent() {
        let config = json!({
            "agents": {
                "defaults": {
                    "workspace": "/tmp/openclaw-workspace",
                    "model": {
                        "primary": "openai-codex/gpt-5.5"
                    }
                }
            }
        });

        let agents = agents_from_config(&config, Some("unit-profile")).expect("agents");

        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "main");
        assert!(agents[0].is_default);
        assert_eq!(agents[0].workspace, "/tmp/openclaw-workspace");
        assert_eq!(agents[0].model.as_deref(), Some("openai-codex/gpt-5.5"));
    }

    #[test]
    fn config_agents_fallback_uses_configured_agent_list() {
        let config = json!({
            "agents": {
                "defaults": {
                    "workspace": "/tmp/default-workspace",
                    "model": {
                        "primary": "openai-codex/gpt-5.5"
                    }
                },
                "list": [
                    {
                        "id": "research",
                        "name": "Research",
                        "identity": {
                            "name": "Researcher",
                            "emoji": "search"
                        },
                        "default": true,
                        "workspace": "/tmp/research-workspace",
                        "routes": ["default"]
                    }
                ]
            }
        });

        let agents = agents_from_config(&config, Some("unit-profile")).expect("agents");

        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "research");
        assert_eq!(agents[0].name.as_deref(), Some("Research"));
        assert_eq!(agents[0].identity_name.as_deref(), Some("Researcher"));
        assert_eq!(agents[0].emoji.as_deref(), Some("search"));
        assert!(agents[0].is_default);
        assert_eq!(agents[0].workspace, "/tmp/research-workspace");
        assert_eq!(agents[0].model.as_deref(), Some("openai-codex/gpt-5.5"));
        assert_eq!(agents[0].routes, vec!["default"]);
    }

    #[test]
    fn gateway_create_request_uses_stable_agent_id_as_create_name() {
        let req = GatewayAgentCreateRequest {
            agent_id: "employee-abc".to_string(),
            name: "张小龙".to_string(),
            workspace: "/tmp/workspace".to_string(),
            model: Some("openai-codex/gpt-5.5".to_string()),
            emoji: "robot".to_string(),
        };

        let create_params = agent_create_params(&req);

        assert_eq!(create_params["name"], "employee-abc");
        assert_ne!(create_params["name"], req.name);
    }

    #[test]
    fn gateway_create_request_omits_model_when_agent_inherits_profile_default() {
        let req = GatewayAgentCreateRequest {
            agent_id: "employee-abc".to_string(),
            name: "张小龙".to_string(),
            workspace: "/tmp/workspace".to_string(),
            model: None,
            emoji: "robot".to_string(),
        };

        let create_params = agent_create_params(&req);

        assert_eq!(create_params["name"], "employee-abc");
        assert_eq!(create_params.get("model"), None);
    }

    #[test]
    fn created_agent_fallback_value_preserves_requested_identity_and_id() {
        let req = GatewayAgentCreateRequest {
            agent_id: "employee-abc".to_string(),
            name: "张小龙".to_string(),
            workspace: "/tmp/workspace".to_string(),
            model: Some("openai-codex/gpt-5.5".to_string()),
            emoji: "robot".to_string(),
        };

        let value = agent_value_with_requested_identity(json!({ "agentId": "employee-abc" }), &req);

        assert_eq!(value["id"], "employee-abc");
        assert_eq!(value["agentId"], "employee-abc");
        assert_eq!(value["identityName"], "张小龙");
        assert_eq!(value["identityEmoji"], "robot");
    }

    #[test]
    fn connect_request_uses_openclaw_allowed_gateway_client_id() {
        let endpoint = GatewayEndpoint {
            url: "ws://127.0.0.1:18790".to_string(),
            token: Some("token".to_string()),
            password: None,
            device_token: None,
        };

        let request = build_connect_request(&endpoint, "connect-1", "nonce-1");

        assert_eq!(request["params"]["client"]["id"], "gateway-client");
    }

    #[test]
    fn connect_request_requests_gateway_read_and_write_scopes() {
        let endpoint = GatewayEndpoint {
            url: "ws://127.0.0.1:18790".to_string(),
            token: Some("token".to_string()),
            password: None,
            device_token: None,
        };

        let request = build_connect_request(&endpoint, "connect-1", "nonce-1");
        let scopes = request["params"]["scopes"]
            .as_array()
            .expect("connect scopes should be an array");

        assert!(scopes.iter().any(|scope| scope == "operator.read"));
        assert!(scopes.iter().any(|scope| scope == "operator.write"));
    }

    #[test]
    fn connect_request_matches_official_operator_scope_set() {
        let endpoint = GatewayEndpoint {
            url: "ws://127.0.0.1:18790".to_string(),
            token: Some("token".to_string()),
            password: None,
            device_token: None,
        };

        let request = build_connect_request(&endpoint, "connect-1", "nonce-1");
        let scopes = request["params"]["scopes"]
            .as_array()
            .expect("connect scopes should be an array")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();

        assert_eq!(scopes, DEFAULT_OPERATOR_CONNECT_SCOPES);
    }

    #[tokio::test]
    async fn fake_gateway_connect_sends_official_handshake_request() {
        let (url, request_rx) = spawn_fake_gateway(FakeConnectResponse::Ok).await;
        let endpoint = GatewayEndpoint {
            url,
            token: Some("token-1".to_string()),
            password: None,
            device_token: None,
        };

        let mut socket = connect_endpoint_socket(&endpoint, 2, 2)
            .await
            .expect("connect handshake succeeds");
        let request = request_rx.await.expect("captured connect request");
        let _ = socket.close(None).await;

        assert_eq!(request["type"], "req");
        assert_eq!(request["method"], "connect");
        assert_eq!(request["params"]["minProtocol"], 3);
        assert_eq!(request["params"]["maxProtocol"], 4);
        assert_eq!(request["params"]["client"]["id"], "gateway-client");
        assert_eq!(request["params"]["role"], "operator");
        assert_eq!(request["params"]["auth"]["token"], "token-1");
        let scopes = request["params"]["scopes"]
            .as_array()
            .expect("connect scopes")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert_eq!(scopes, DEFAULT_OPERATOR_CONNECT_SCOPES);
    }

    #[tokio::test]
    async fn fake_gateway_connect_auth_failure_returns_structured_message() {
        let (url, request_rx) = spawn_fake_gateway(FakeConnectResponse::AuthFailure).await;
        let endpoint = GatewayEndpoint {
            url,
            token: Some("bad-token".to_string()),
            password: None,
            device_token: None,
        };

        let error = connect_endpoint_socket(&endpoint, 2, 2)
            .await
            .expect_err("auth failure should fail connect");
        let request = request_rx.await.expect("captured connect request");

        assert_eq!(request["method"], "connect");
        assert!(error.contains("gateway.unknown"));
        assert!(error.contains("GATEWAY_ERROR"));
        assert!(!error.contains("AUTH_FAILED"));
        assert!(!error.contains("Invalid Gateway credentials"));
    }

    #[tokio::test]
    async fn fake_gateway_connect_requires_connect_challenge_first_frame() {
        let (url, _request_rx) =
            spawn_fake_gateway(FakeConnectResponse::NonChallengeFirstFrame).await;
        let endpoint = GatewayEndpoint {
            url,
            token: None,
            password: None,
            device_token: None,
        };

        let error = connect_endpoint_socket(&endpoint, 2, 2)
            .await
            .expect_err("non challenge first frame should fail");

        assert!(error.contains("Gateway 第一帧不是 connect.challenge"));
    }

    #[tokio::test]
    async fn fake_gateway_request_json_runs_after_official_handshake() {
        let (url, request_rx) = spawn_fake_gateway(FakeConnectResponse::Ok).await;
        let endpoint = GatewayEndpoint {
            url,
            token: Some("token-1".to_string()),
            password: None,
            device_token: None,
        };

        let payload =
            request_json_for_endpoint(&endpoint, "health", json!({ "probe": true }), false, 2, 2)
                .await
                .expect("request succeeds after handshake");
        let connect_request = request_rx.await.expect("captured connect request");

        assert_eq!(connect_request["method"], "connect");
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["method"], "health");
    }

    #[tokio::test]
    async fn fake_gateway_device_auth_handshake_sends_official_signed_connect_and_persists_token() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let app_handle = app.handle().clone();
        let (url, request_rx) = spawn_fake_device_auth_gateway("issued-device-token-1").await;
        let endpoint = GatewayEndpoint {
            url,
            token: Some("pairing-token-1".to_string()),
            password: None,
            device_token: None,
        };

        let mut socket = connect_endpoint_socket_with_device_auth(&app_handle, &endpoint, 2, 2)
            .await
            .expect("official device-auth handshake succeeds");
        let request = request_rx.await.expect("captured signed connect request");
        let _ = socket.close(None).await;

        assert_eq!(request["type"], "req");
        assert_eq!(request["method"], "connect");
        assert_eq!(request["params"]["minProtocol"], 3);
        assert_eq!(request["params"]["maxProtocol"], 4);
        assert_eq!(request["params"]["client"]["id"], "gateway-client");
        assert_eq!(request["params"]["client"]["mode"], "backend");
        assert_eq!(request["params"]["client"]["deviceFamily"], "desktop");
        assert_eq!(request["params"]["role"], "operator");
        assert_eq!(request["params"]["auth"]["token"], "pairing-token-1");
        assert_eq!(request["params"]["device"]["nonce"], "nonce-device-auth-1");
        assert!(request["params"]["device"].get("family").is_none());

        let scopes = request["params"]["scopes"]
            .as_array()
            .expect("connect scopes")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert_eq!(scopes, DEFAULT_OPERATOR_CONNECT_SCOPES);

        verify_signed_device_auth_request(&request, "pairing-token-1");

        let identity = openclaw_device_auth::ensure_device_identity(&app_handle)
            .expect("device identity still exists");
        let cached =
            openclaw_device_auth::read_cached_device_token(&app_handle, &identity.device_id)
                .expect("cached issued device token")
                .expect("device token persisted");
        assert_eq!(cached.device_token, "issued-device-token-1");
        assert_eq!(cached.role.as_deref(), Some("operator"));
        assert_eq!(
            cached.scopes,
            openclaw_device_auth::operator_connect_scopes()
        );
    }

    #[test]
    fn gateway_client_can_be_created_for_explicit_endpoint() {
        let endpoint = GatewayEndpoint {
            url: "ws://127.0.0.1:18790".to_string(),
            token: Some("token".to_string()),
            password: None,
            device_token: None,
        };

        let client = GatewayClient::for_endpoint(endpoint.clone(), 2, 3);

        assert_eq!(client.endpoint_override.as_ref().unwrap(), &endpoint);
    }

    #[test]
    fn agents_update_injects_agent_id_into_patch() {
        let mut patch = json!({
            "name": "Sales",
            "model": "openai-codex/gpt-5.5"
        });
        if let Some(object) = patch.as_object_mut() {
            object.insert("agentId".to_string(), Value::String("agent-1".to_string()));
        }

        assert_eq!(patch["agentId"], "agent-1");
        assert_eq!(patch["name"], "Sales");
    }

    #[test]
    fn agent_file_params_use_gateway_name_field() {
        let params = json!({
            "agentId": "main",
            "name": "IDENTITY.md",
            "content": "# IDENTITY.md"
        });

        assert_eq!(params["name"], "IDENTITY.md");
        assert!(params.get("path").is_none());
    }

    #[test]
    fn config_patch_uses_official_raw_and_base_hash_params() {
        let snapshot = json!({
            "hash": "abc123"
        });
        let params = config_patch_params(
            &snapshot,
            json!({
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai-codex/gpt-5.5"
                        }
                    }
                }
            }),
        )
        .expect("params");

        assert_eq!(params["baseHash"], "abc123");
        assert!(params["raw"]
            .as_str()
            .unwrap()
            .contains("openai-codex/gpt-5.5"));
        assert_eq!(params["restartDelayMs"], CONFIG_PATCH_RESTART_DELAY_MS);
        assert!(params.get("patch").is_none());
    }

    #[test]
    fn config_patch_retries_only_the_engine_optimistic_concurrency_conflict() {
        assert!(config_patch_conflict(CONFIG_CHANGED_SINCE_LAST_LOAD));
        assert!(config_patch_conflict(
            "config changed since last load; re-run config.get and retry"
        ));
        assert!(!config_patch_conflict("gateway authentication failed"));
    }

    #[test]
    fn config_patch_conflict_response_keeps_the_raw_gateway_message_private() {
        let frame = json!({
            "type": "res",
            "id": "req-1",
            "ok": false,
            "error": {
                "code": "INVALID_REQUEST",
                "message": "config changed since last load; re-run config.get and retry"
            }
        });

        let error = response_payload(&frame, "req-1").expect_err("request must retry");
        assert_eq!(error, CONFIG_CHANGED_SINCE_LAST_LOAD);
        assert!(!error.contains("config changed since last load"));
    }

    #[test]
    fn models_list_configured_uses_current_gateway_schema_without_view_param() {
        let params = models_list_params(Some("configured"));

        assert_eq!(params, json!({}));
    }

    #[test]
    fn gateway_endpoint_uses_official_remote_direct_config() {
        let endpoint = gateway_endpoint_from_config(&json!({
            "gateway": {
                "mode": "remote",
                "remote": {
                    "transport": "direct",
                    "url": "https://owner.example.ts.net:19999/control/",
                    "token": "remote-token"
                }
            }
        }))
        .unwrap();

        assert_eq!(endpoint.url, "wss://owner.example.ts.net:19999/control");
        assert_eq!(endpoint.token.as_deref(), Some("remote-token"));
    }

    #[tokio::test]
    async fn gateway_response_reader_skips_empty_text_frames() {
        let response = json!({
            "type": "res",
            "id": "req-1",
            "ok": true,
            "payload": { "ok": true }
        });
        let mut stream = futures_util::stream::iter(vec![
            Ok(Message::Text("".into())),
            Ok(Message::Text(response.to_string().into())),
        ]);

        let frame = next_matching_response(&mut stream, "req-1", false, 1)
            .await
            .expect("response");

        assert_eq!(frame["payload"]["ok"], true);
    }

    #[tokio::test]
    async fn gateway_response_reader_skips_non_json_text_frames() {
        let response = json!({
            "type": "res",
            "id": "req-1",
            "ok": true,
            "payload": { "ok": true }
        });
        let mut stream = futures_util::stream::iter(vec![
            Ok(Message::Text("config.patch accepted".into())),
            Ok(Message::Text(response.to_string().into())),
        ]);

        let frame = next_matching_response(&mut stream, "req-1", false, 1)
            .await
            .expect("response");

        assert_eq!(frame["payload"]["ok"], true);
    }

    #[test]
    fn config_parse_accepts_json5_hand_edits() {
        // The engine's own config parser is JSON5; a comment or trailing comma
        // added by hand must not read as parse failure on our side (that used to
        // fail every config-derived path while the engine booted fine).
        let text = r#"{
            // hand-written note
            "gateway": { "mode": "local", },
        }"#;
        let value = super::parse_openclaw_config_text(text).expect("json5 parse");
        assert_eq!(value["gateway"]["mode"], "local");
        // Strict JSON must keep working unchanged.
        assert!(super::parse_openclaw_config_text("{\"a\":1}").is_ok());
        // Actual garbage still errors — never silently degrade to `{}`.
        assert!(super::parse_openclaw_config_text("not a config").is_err());
    }

    #[test]
    fn ws_url_maps_to_http_base_for_readyz_probe() {
        assert_eq!(
            super::http_base_from_ws_url("ws://127.0.0.1:28790"),
            "http://127.0.0.1:28790"
        );
        assert_eq!(
            super::http_base_from_ws_url("wss://gw.example.com/"),
            "https://gw.example.com"
        );
    }
}
