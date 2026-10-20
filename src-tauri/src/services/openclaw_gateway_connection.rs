use crate::services::{
    openclaw_connection::{
        self, GatewayConnectionMode, GatewayConnectionSnapshot, GatewayConnectionStatus,
    },
    openclaw_gateway, openclaw_gateway_stream,
};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const GATEWAY_RUNTIME_REQUEST_TIMEOUT_SECS: u64 = 30;
// Transport-only retries preserve the original params/idempotency key. Cover a
// normal Windows cold boot rather than surfacing connection-refused while the
// same healthy Gateway is still loading Node plugins.
const GATEWAY_RUNTIME_RETRY_DELAYS_MS: &[u64] = &[250, 500, 1_000, 1_500, 2_500, 3_000, 3_000];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayRecoveryAction {
    None,
    StartLocal,
    RefreshRemoteDirect,
    RestartRemoteSshTunnel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GatewayRequestOptions {
    pub timeout_secs: u64,
    pub allow_recovery: bool,
}

impl Default for GatewayRequestOptions {
    fn default() -> Self {
        Self {
            timeout_secs: GATEWAY_RUNTIME_REQUEST_TIMEOUT_SECS,
            allow_recovery: true,
        }
    }
}

pub fn recovery_action_for_mode(
    mode: GatewayConnectionMode,
    status: GatewayConnectionStatus,
    transport_error: bool,
) -> GatewayRecoveryAction {
    if !transport_error || matches!(status, GatewayConnectionStatus::Connected) {
        return GatewayRecoveryAction::None;
    }
    match mode {
        GatewayConnectionMode::Local => GatewayRecoveryAction::StartLocal,
        GatewayConnectionMode::RemoteDirect => GatewayRecoveryAction::RefreshRemoteDirect,
        GatewayConnectionMode::RemoteSshTunnel => GatewayRecoveryAction::RestartRemoteSshTunnel,
        GatewayConnectionMode::NotConfigured => GatewayRecoveryAction::None,
    }
}

pub async fn require_endpoint(
    app: &AppHandle,
    profile: Option<&str>,
) -> Result<openclaw_gateway::GatewayEndpoint, String> {
    recover_if_needed(app, profile).await?;
    openclaw_connection::resolve_endpoint_for_profile_from_app(app, profile).await
}

pub async fn refresh(
    app: &AppHandle,
    profile: Option<&str>,
) -> Result<GatewayConnectionSnapshot, String> {
    recover_if_needed(app, profile).await
}

pub async fn health(app: &AppHandle, profile: Option<&str>) -> Result<Value, String> {
    request(
        app,
        profile,
        "health",
        serde_json::json!({}),
        GatewayRequestOptions::default(),
    )
    .await
}

pub async fn request(
    app: &AppHandle,
    profile: Option<&str>,
    method: &str,
    params: Value,
    options: GatewayRequestOptions,
) -> Result<Value, String> {
    // The stream actor already detects a dead socket and the error path below
    // performs full recovery. Probing `health` over a brand-new WebSocket before
    // every healthy request doubled the round trips for tiny operations such as
    // a session model patch. Resolve locally and send first instead.
    let endpoint = request_endpoint_without_probe(app, profile).await?;
    let stream_manager = app.state::<openclaw_gateway_stream::GatewayStreamManager>();
    match stream_manager
        .request_with_timeout(
            app.clone(),
            endpoint,
            method,
            params.clone(),
            options.timeout_secs,
        )
        .await
    {
        Ok(value) => Ok(value),
        Err(error) if options.allow_recovery && is_transport_error(&error) => {
            recover_for_request_error(app, profile, &error).await?;
            retry_request(app, profile, method, params, options.timeout_secs).await
        }
        Err(error) => Err(format!("Gateway {method} 请求失败: {error}")),
    }
}

fn request_endpoint_needs_recovery(
    mode: GatewayConnectionMode,
    running_profile: Option<&str>,
    requested_profile: Option<&str>,
) -> bool {
    matches!(mode, GatewayConnectionMode::Local)
        && local_engine_profile_mismatch(running_profile, requested_profile)
}

async fn request_endpoint_without_probe(
    app: &AppHandle,
    profile: Option<&str>,
) -> Result<openclaw_gateway::GatewayEndpoint, String> {
    let (mode, endpoint) =
        openclaw_connection::resolve_mode_and_endpoint_for_profile_from_app(app, profile).await?;
    let running_profile = if matches!(mode, GatewayConnectionMode::Local) {
        app.state::<crate::commands::model::GatewaySupervisor>()
            .running_profile()
            .await
    } else {
        None
    };
    if request_endpoint_needs_recovery(mode, running_profile.as_deref(), profile) {
        // Account isolation is the one condition that cannot wait for a failed
        // request: local endpoints share one port/password, so sending first
        // would address the previous account's live engine. Switch the child,
        // settle it, then resolve again in case the dynamic port changed.
        start_local_for_profile(app, profile).await?;
        return openclaw_connection::resolve_endpoint_for_profile_from_app(app, profile).await;
    }
    Ok(endpoint)
}

/// Tells the stream actor which session an accepted run belongs to, so its
/// agent/tool frames (which carry no sessionKey) are routed by ownership rather
/// than by whichever chat is on screen. Best-effort — a failure here only falls
/// back to the previous active-session attribution.
pub async fn bind_run(app: &AppHandle, profile: Option<&str>, run_id: &str, session_key: &str) {
    let Ok(endpoint) = require_endpoint(app, profile).await else {
        return;
    };
    app.state::<openclaw_gateway_stream::GatewayStreamManager>()
        .bind_run(app.clone(), endpoint, run_id, session_key)
        .await;
}

pub async fn subscribe_session(
    app: &AppHandle,
    profile: Option<&str>,
    session_key: &str,
) -> Result<(), String> {
    let endpoint = require_endpoint(app, profile).await?;
    let stream_manager = app.state::<openclaw_gateway_stream::GatewayStreamManager>();
    match stream_manager
        .subscribe_session(app.clone(), endpoint, session_key)
        .await
    {
        Ok(()) => Ok(()),
        Err(error) if is_transport_error(&error) => {
            recover_for_request_error(app, profile, &error).await?;
            let endpoint = require_endpoint(app, profile).await?;
            app.state::<openclaw_gateway_stream::GatewayStreamManager>()
                .subscribe_session(app.clone(), endpoint, session_key)
                .await
        }
        Err(error) => Err(error),
    }
}

async fn retry_request(
    app: &AppHandle,
    profile: Option<&str>,
    method: &str,
    params: Value,
    timeout_secs: u64,
) -> Result<Value, String> {
    let mut last_error = String::new();
    for delay_ms in GATEWAY_RUNTIME_RETRY_DELAYS_MS {
        tokio::time::sleep(Duration::from_millis(*delay_ms)).await;
        let endpoint = require_endpoint_without_recovery(app, profile).await?;
        let result = app
            .state::<openclaw_gateway_stream::GatewayStreamManager>()
            .request_with_timeout(app.clone(), endpoint, method, params.clone(), timeout_secs)
            .await;
        match result {
            Ok(value) => return Ok(value),
            Err(error) => last_error = error,
        }
    }
    Err(format!("Gateway {method} 请求恢复后仍失败: {last_error}"))
}

async fn require_endpoint_without_recovery(
    app: &AppHandle,
    profile: Option<&str>,
) -> Result<openclaw_gateway::GatewayEndpoint, String> {
    openclaw_connection::resolve_endpoint_for_profile_from_app(app, profile).await
}

/// Pure switch-guard check: should a live local child spawned for `running` be
/// torn down before serving a caller acting for `requested`? An empty/None
/// `requested` (guest / no account) never forces a respawn, and an absent child
/// (`running` is None) has nothing to switch away from.
fn local_engine_profile_mismatch(running: Option<&str>, requested: Option<&str>) -> bool {
    let requested = requested.map(str::trim).unwrap_or("");
    if requested.is_empty() {
        return false;
    }
    match running.map(str::trim) {
        Some(spawned_for) => spawned_for != requested,
        None => false,
    }
}

async fn recover_if_needed(
    app: &AppHandle,
    profile: Option<&str>,
) -> Result<GatewayConnectionSnapshot, String> {
    let snapshot =
        openclaw_connection::connection_snapshot_for_profile_from_app(app, profile).await?;
    if matches!(snapshot.status, GatewayConnectionStatus::Connected) {
        // One machine, one engine, one port: a health probe for the account the
        // child was spawned for also reads "Connected" to a caller acting for a
        // different account — e.g. right after a switch, before warmup's respawn
        // lands. Serving the turn here would touch the previous account's
        // state/memory, so respawn for the requested profile first. start_local
        // writes the active marker + respawns + settles, so the returned
        // snapshot already reflects the requested account's engine.
        if matches!(snapshot.mode, GatewayConnectionMode::Local) {
            let running = app
                .state::<crate::commands::model::GatewaySupervisor>()
                .running_profile()
                .await;
            if local_engine_profile_mismatch(running.as_deref(), profile) {
                return start_local_for_profile(app, profile).await;
            }
        }
        return Ok(snapshot);
    }
    recover_for_snapshot(app, profile, snapshot).await
}

async fn recover_for_request_error(
    app: &AppHandle,
    profile: Option<&str>,
    error: &str,
) -> Result<GatewayConnectionSnapshot, String> {
    let snapshot =
        openclaw_connection::connection_snapshot_for_profile_from_app(app, profile).await?;
    let snapshot = if matches!(snapshot.status, GatewayConnectionStatus::Connected) {
        GatewayConnectionSnapshot {
            status: GatewayConnectionStatus::Unavailable,
            last_error_code: openclaw_connection::classify_gateway_connection_error(Some(error)),
            last_error: Some(error.to_string()),
            ..snapshot
        }
    } else {
        snapshot
    };
    recover_for_snapshot(app, profile, snapshot).await
}

async fn recover_for_snapshot(
    app: &AppHandle,
    profile: Option<&str>,
    snapshot: GatewayConnectionSnapshot,
) -> Result<GatewayConnectionSnapshot, String> {
    match recovery_action_for_mode(snapshot.mode, snapshot.status, true) {
        GatewayRecoveryAction::None => Err(openclaw_connection::connection_required_message(
            &snapshot.profile,
        )),
        GatewayRecoveryAction::StartLocal => {
            // Reconnect ≠ respawn. A transport error on the WS stream does NOT
            // mean the engine died — if its HTTP layer still answers (`/readyz`
            // 200 or 503), the process is alive and the failure was socket-
            // level; the stream actor reconnects on its own and `retry_request`
            // re-attempts with backoff. Respawning here killed in-flight state
            // and, during the respawn's own cold start, failed the next request
            // too — the self-exciting ~30s watchdog-respawn loop. Only an
            // engine whose HTTP layer is unreachable warrants StartLocal.
            if openclaw_gateway::http_ready(profile).await.is_ok() {
                return openclaw_connection::connection_snapshot_for_profile_from_app(app, profile)
                    .await;
            }
            start_local_for_profile(app, profile).await
        }
        GatewayRecoveryAction::RefreshRemoteDirect => {
            openclaw_connection::connection_snapshot_for_profile_from_app(app, profile).await
        }
        GatewayRecoveryAction::RestartRemoteSshTunnel => {
            restart_remote_ssh_for_profile(app, profile).await
        }
    }
}

async fn start_local_for_profile(
    app: &AppHandle,
    profile: Option<&str>,
) -> Result<GatewayConnectionSnapshot, String> {
    crate::commands::openclaw_connection::openclaw_connection_start_local_for_runtime(
        app.clone(),
        crate::commands::openclaw_connection::GatewayConnectionProfileInput {
            profile: profile.map(str::to_string),
            gateway_port: None,
            cloud_agent_api_url: None,
            cloud_agent_auth_token: None,
            cloud_agent_token_expires_at: None,
            cloud_agent_id: None,
        },
    )
    .await
}

async fn restart_remote_ssh_for_profile(
    app: &AppHandle,
    profile: Option<&str>,
) -> Result<GatewayConnectionSnapshot, String> {
    crate::commands::openclaw_connection::openclaw_connection_test_remote_for_runtime(
        app.clone(),
        crate::commands::openclaw_connection::GatewayConnectionProfileInput {
            profile: profile.map(str::to_string),
            gateway_port: None,
            cloud_agent_api_url: None,
            cloud_agent_auth_token: None,
            cloud_agent_token_expires_at: None,
            cloud_agent_id: None,
        },
    )
    .await
}

fn is_transport_error(error: &str) -> bool {
    let normalized = error.to_lowercase();
    normalized.contains("connect")
        || normalized.contains("connection")
        || normalized.contains("socket")
        || normalized.contains("websocket")
        || normalized.contains("timeout")
        || normalized.contains("closed")
        || normalized.contains("断开")
        || normalized.contains("不可用")
        || normalized.contains("超时")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_transport_failure_chooses_local_recovery() {
        assert_eq!(
            recovery_action_for_mode(
                GatewayConnectionMode::Local,
                GatewayConnectionStatus::Unavailable,
                true,
            ),
            GatewayRecoveryAction::StartLocal,
        );
    }

    #[test]
    fn remote_ssh_transport_failure_chooses_tunnel_recovery() {
        assert_eq!(
            recovery_action_for_mode(
                GatewayConnectionMode::RemoteSshTunnel,
                GatewayConnectionStatus::Unavailable,
                true,
            ),
            GatewayRecoveryAction::RestartRemoteSshTunnel,
        );
    }

    #[test]
    fn remote_direct_transport_failure_does_not_start_local_or_ssh() {
        assert_eq!(
            recovery_action_for_mode(
                GatewayConnectionMode::RemoteDirect,
                GatewayConnectionStatus::Unavailable,
                true,
            ),
            GatewayRecoveryAction::RefreshRemoteDirect,
        );
    }

    #[test]
    fn gateway_response_error_does_not_trigger_recovery() {
        assert_eq!(
            recovery_action_for_mode(
                GatewayConnectionMode::Local,
                GatewayConnectionStatus::Unavailable,
                false,
            ),
            GatewayRecoveryAction::None,
        );
    }

    #[test]
    fn local_engine_profile_mismatch_detects_account_switch() {
        // Same account: keep serving, no respawn.
        assert!(!local_engine_profile_mismatch(Some("acct-a"), Some("acct-a")));
        // Different account: the switch-window bug — must respawn.
        assert!(local_engine_profile_mismatch(Some("acct-a"), Some("acct-b")));
        // Whitespace-insensitive (normalize_profile_key only trims).
        assert!(!local_engine_profile_mismatch(Some(" acct-a "), Some("acct-a")));
        // Guest / no requested account never forces a respawn.
        assert!(!local_engine_profile_mismatch(Some("acct-a"), Some("")));
        assert!(!local_engine_profile_mismatch(Some("acct-a"), None));
        // No live child: nothing to switch away from.
        assert!(!local_engine_profile_mismatch(None, Some("acct-b")));
    }

    #[test]
    fn request_fast_path_only_requires_recovery_for_a_local_account_switch() {
        assert!(!request_endpoint_needs_recovery(
            GatewayConnectionMode::Local,
            Some("acct-a"),
            Some("acct-a"),
        ));
        assert!(request_endpoint_needs_recovery(
            GatewayConnectionMode::Local,
            Some("acct-a"),
            Some("acct-b"),
        ));
        assert!(!request_endpoint_needs_recovery(
            GatewayConnectionMode::RemoteDirect,
            Some("acct-a"),
            Some("acct-b"),
        ));
    }

    #[test]
    fn runtime_request_uses_the_existing_stream_before_health_recovery() {
        let source = include_str!("openclaw_gateway_connection.rs");
        let start = source.find("pub async fn request(").expect("request function");
        let end = source[start..]
            .find("pub async fn bind_run")
            .map(|offset| start + offset)
            .expect("request function end");
        let request_path = &source[start..end];

        assert!(request_path.contains("request_endpoint_without_probe"));
        assert!(!request_path.contains("let endpoint = require_endpoint(app, profile).await?;"));
        assert!(request_path.contains("recover_for_request_error"));
    }

    #[test]
    fn subscribe_session_request_uses_official_key_param() {
        let request =
            openclaw_gateway_stream::build_subscribe_session_request("req-1", "agent:main:main");

        assert_eq!(request["method"], "sessions.messages.subscribe");
        assert_eq!(
            request["params"],
            serde_json::json!({ "key": "agent:main:main" })
        );
    }

    #[test]
    fn runtime_transport_retry_budget_covers_gateway_cold_start() {
        assert!(
            GATEWAY_RUNTIME_RETRY_DELAYS_MS.iter().sum::<u64>() >= 10_000,
            "transport recovery must outlast a normal Windows Gateway cold start"
        );
    }
}
