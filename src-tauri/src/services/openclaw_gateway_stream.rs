use crate::services::{
    openclaw_gateway,
    openclaw_gateway_contract::{normalize_gateway_error, UniopcGatewayError},
};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 30;
const GATEWAY_STREAM_KEEPALIVE_INTERVAL_SECS: u64 = 15;
/// Reconnect backoff ladder (ms). A dropped socket retries fast first (0.5s) so a
/// brief blip mid-turn recovers quickly, ramping to 30s so a genuinely-down
/// gateway isn't hammered. Replaces the old flat 30s that made every first
/// reconnect wait the full interval.
const GATEWAY_STREAM_RECONNECT_BACKOFF_MS: &[u64] = &[500, 1_000, 2_000, 5_000, 10_000, 30_000];
/// A connection that stayed up at least this long is treated as healthy, so the
/// next drop restarts the backoff ladder from the fast end instead of inheriting
/// a long delay.
const GATEWAY_STREAM_STABLE_CONNECTION_SECS: u64 = 30;
/// How many runs keep a session binding. A run that never reports a terminal
/// state (killed gateway, dropped final) would otherwise leak an entry forever;
/// the oldest binding is evicted once the map is full.
// Keep enough ownership bindings for a busy team. This is only a small in-memory
// routing table, but eviction makes an older background run fall back to the
// currently visible session when its next agent/tool frame omits `sessionKey`.
const GATEWAY_STREAM_RUN_BINDING_CAPACITY: usize = 256;

fn reconnect_backoff(attempt: u32) -> Duration {
    let idx = (attempt as usize).min(GATEWAY_STREAM_RECONNECT_BACKOFF_MS.len() - 1);
    Duration::from_millis(GATEWAY_STREAM_RECONNECT_BACKOFF_MS[idx])
}

#[derive(Default)]
pub struct GatewayStreamManager {
    handle: Mutex<Option<GatewayStreamHandle>>,
}

struct GatewayStreamHandle {
    signature: String,
    tx: mpsc::Sender<GatewayStreamCommand>,
}

enum GatewayStreamCommand {
    Request {
        method: String,
        params: Value,
        respond: oneshot::Sender<Result<Value, String>>,
    },
    SubscribeSession {
        session_key: String,
        respond: oneshot::Sender<Result<(), String>>,
    },
    /// Records which session an accepted `chat.send` run belongs to. Frames on
    /// the agent/item/tool streams carry a runId but no sessionKey, so without
    /// this binding they can only be attributed to whatever session happens to
    /// be active — which mislabels a still-running turn onto the chat the user
    /// just switched to.
    BindRun {
        run_id: String,
        session_key: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStreamUiEvent {
    pub conversation_id: Option<String>,
    pub session_key: String,
    pub run_id: Option<String>,
    pub state: String,
    pub content: Option<String>,
    pub is_reasoning: bool,
    pub reasoning_content: Option<String>,
    pub error_message: Option<String>,
    pub gateway_error: Option<UniopcGatewayError>,
    pub seq: Option<u64>,
    pub created_at: u64,
    // Tool stream (state = tool_started / tool_update / tool_result / tool_error):
    // lets the UI render a live tool timeline instead of a silent long wait.
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_phase: Option<String>,
    pub tool_is_error: bool,
    pub tool_args: Option<String>,
    pub tool_result_preview: Option<String>,
    /// Files this tool call produced, extracted from the (untruncated) args and
    /// result. Feeds the 产物 panel; empty for tools that touch no files.
    pub tool_artifacts: Vec<crate::services::tool_artifacts::ToolArtifactPath>,
    /// A canonical transcript row sent by OpenClaw's
    /// `sessions.messages.subscribe` channel. This confirms a user turn as
    /// soon as the engine persists it; waiting for `chat.final` makes the UI
    /// appear to replace the user's message only after the agent replies.
    pub session_message: Option<GatewaySessionMessage>,
    /// Pending plugin write approval forwarded from the embedded runtime.
    pub approval_request: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySessionMessage {
    pub id: Option<String>,
    pub role: String,
    pub content: String,
    pub created_at: u64,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayStreamMappedEvent {
    Ui(GatewayStreamUiEvent),
    SeqGap { expected: u64, actual: u64 },
}

#[derive(Debug, Default)]
pub struct GatewaySeqTracker {
    last_seq: Option<u64>,
}

impl GatewaySeqTracker {
    pub fn observe(&mut self, seq: Option<u64>) -> Option<(u64, u64)> {
        let seq = seq?;
        let gap = self.last_seq.and_then(|last| {
            let expected = last.saturating_add(1);
            (seq > expected).then_some((expected, seq))
        });
        self.last_seq = Some(seq);
        gap
    }
}

/// Where a mapped frame should be delivered. `run_sessions` wins over the
/// active session for any frame that names a run: the active session only
/// tracks what the user is looking at, which is not the same thing as who owns
/// an in-flight turn.
#[derive(Debug, Default, Clone, Copy)]
pub struct GatewayStreamRouting<'a> {
    active_session_key: Option<&'a str>,
    run_sessions: Option<&'a HashMap<String, String>>,
}

impl<'a> GatewayStreamRouting<'a> {
    pub fn for_active_session(active_session_key: Option<&'a str>) -> Self {
        Self {
            active_session_key,
            run_sessions: None,
        }
    }

    /// Session that owns `run_id`, falling back to the active session for runs
    /// that were never bound (a turn started by another client, or a frame that
    /// arrived before the `chat.send` ack).
    fn session_for(&self, run_id: Option<&str>) -> Option<&'a str> {
        run_id
            .and_then(|run_id| {
                self.run_sessions
                    .and_then(|sessions| sessions.get(run_id))
                    .map(String::as_str)
            })
            .or(self.active_session_key)
    }
}

#[derive(Debug, Default)]
struct GatewayStreamActorState {
    active_session_key: Option<String>,
    seq_tracker: GatewaySeqTracker,
    run_sessions: HashMap<String, String>,
    run_order: VecDeque<String>,
}

impl GatewayStreamActorState {
    fn remember_active_session(&mut self, session_key: String) {
        self.active_session_key = Some(session_key);
    }

    fn active_session_key(&self) -> Option<&str> {
        self.active_session_key.as_deref()
    }

    fn routing(&self) -> GatewayStreamRouting<'_> {
        GatewayStreamRouting {
            active_session_key: self.active_session_key.as_deref(),
            run_sessions: Some(&self.run_sessions),
        }
    }

    fn bind_run(&mut self, run_id: String, session_key: String) {
        if run_id.is_empty() || session_key.is_empty() {
            return;
        }
        if self.run_sessions.insert(run_id.clone(), session_key).is_none() {
            self.run_order.push_back(run_id);
        }
        while self.run_order.len() > GATEWAY_STREAM_RUN_BINDING_CAPACITY {
            if let Some(evicted) = self.run_order.pop_front() {
                self.run_sessions.remove(&evicted);
            }
        }
    }

    fn release_run(&mut self, run_id: &str) {
        if self.run_sessions.remove(run_id).is_some() {
            self.run_order.retain(|item| item != run_id);
        }
    }

    /// Frames on the `chat` stream carry both ids, so a run started by another
    /// client (or before our own ack landed) still gets bound.
    fn learn_run_binding(&mut self, frame: &Value) {
        let payload = frame.get("payload").unwrap_or(&Value::Null);
        let Some(run_id) = payload.get("runId").and_then(Value::as_str) else {
            return;
        };
        if let Some(session_key) = payload.get("sessionKey").and_then(Value::as_str) {
            self.bind_run(run_id.to_string(), session_key.to_string());
        }
    }

    fn build_resubscribe_request(&self, id: &str) -> Option<Value> {
        self.active_session_key
            .as_deref()
            .map(|session_key| build_subscribe_session_request(id, session_key))
    }

    fn observe_seq(&mut self, seq: Option<u64>) -> Option<(u64, u64)> {
        self.seq_tracker.observe(seq)
    }

    fn prepare_for_reconnect(&mut self) {
        self.seq_tracker = GatewaySeqTracker::default();
    }
}

impl GatewayStreamManager {
    pub async fn request(
        &self,
        app: AppHandle,
        endpoint: openclaw_gateway::GatewayEndpoint,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.request_with_timeout(app, endpoint, method, params, DEFAULT_REQUEST_TIMEOUT_SECS)
            .await
    }

    pub async fn request_with_timeout(
        &self,
        app: AppHandle,
        endpoint: openclaw_gateway::GatewayEndpoint,
        method: &str,
        params: Value,
        timeout_secs: u64,
    ) -> Result<Value, String> {
        let signature = endpoint_signature(&endpoint);
        for attempt in 0..2 {
            let tx = self
                .ensure_handle(app.clone(), endpoint.clone(), &signature)
                .await;
            let (respond, response) = oneshot::channel();
            let command = GatewayStreamCommand::Request {
                method: method.to_string(),
                params: params.clone(),
                respond,
            };
            if tx.send(command).await.is_ok() {
                return await_actor_response(response, timeout_secs).await;
            }
            self.clear_handle(&signature).await;
            if attempt == 1 {
                break;
            }
        }
        Err("Gateway 长连接不可用。".to_string())
    }

    /// Binds an accepted run to its session so its agent/tool frames are routed
    /// by ownership instead of by whatever chat is on screen. Best-effort: a
    /// dropped binding only degrades routing back to the active session.
    pub async fn bind_run(
        &self,
        app: AppHandle,
        endpoint: openclaw_gateway::GatewayEndpoint,
        run_id: &str,
        session_key: &str,
    ) {
        if run_id.trim().is_empty() || session_key.trim().is_empty() {
            return;
        }
        let signature = endpoint_signature(&endpoint);
        let tx = self.ensure_handle(app, endpoint, &signature).await;
        let _ = tx
            .send(GatewayStreamCommand::BindRun {
                run_id: run_id.to_string(),
                session_key: session_key.to_string(),
            })
            .await;
    }

    pub async fn subscribe_session(
        &self,
        app: AppHandle,
        endpoint: openclaw_gateway::GatewayEndpoint,
        session_key: &str,
    ) -> Result<(), String> {
        let signature = endpoint_signature(&endpoint);
        for attempt in 0..2 {
            let tx = self
                .ensure_handle(app.clone(), endpoint.clone(), &signature)
                .await;
            let (respond, response) = oneshot::channel();
            let command = GatewayStreamCommand::SubscribeSession {
                session_key: session_key.to_string(),
                respond,
            };
            if tx.send(command).await.is_ok() {
                return await_actor_response(response, DEFAULT_REQUEST_TIMEOUT_SECS).await;
            }
            self.clear_handle(&signature).await;
            if attempt == 1 {
                break;
            }
        }
        Err("Gateway 会话订阅长连接不可用。".to_string())
    }

    async fn ensure_handle(
        &self,
        app: AppHandle,
        endpoint: openclaw_gateway::GatewayEndpoint,
        signature: &str,
    ) -> mpsc::Sender<GatewayStreamCommand> {
        let mut guard = self.handle.lock().await;
        if let Some(handle) = guard.as_ref() {
            if handle.signature == signature && !handle.tx.is_closed() {
                return handle.tx.clone();
            }
        }

        let (tx, rx) = mpsc::channel(64);
        let handle = GatewayStreamHandle {
            signature: signature.to_string(),
            tx: tx.clone(),
        };
        *guard = Some(handle);
        tauri::async_runtime::spawn(run_gateway_stream_actor(app, endpoint, rx));
        tx
    }

    async fn clear_handle(&self, signature: &str) {
        let mut guard = self.handle.lock().await;
        if guard
            .as_ref()
            .is_some_and(|handle| handle.signature == signature)
        {
            *guard = None;
        }
    }

    /// Tear down the live stream actor unconditionally. Dropping the handle drops
    /// its mpsc sender, so the actor's `rx.recv()` returns `None` and it exits,
    /// discarding its in-memory `active_session_key`/seq state. Call this on
    /// account switch / logout / profile reset: the local-gateway endpoint
    /// signature is byte-identical across accounts (process-constant password,
    /// same port), so without this the actor keeps resubscribing account A's
    /// session against account B's freshly respawned engine — a 30s reconnect
    /// loop that never converges. The next `subscribe_session` spawns a fresh
    /// actor with default state.
    pub async fn shutdown(&self) {
        let mut guard = self.handle.lock().await;
        *guard = None;
    }
}

async fn await_actor_response<T>(
    response: oneshot::Receiver<Result<T, String>>,
    timeout_secs: u64,
) -> Result<T, String> {
    tokio::time::timeout(Duration::from_secs(timeout_secs), response)
        .await
        .map_err(|_| "Gateway 长连接请求超时。".to_string())?
        .map_err(|_| "Gateway 长连接任务已停止。".to_string())?
}

async fn run_gateway_stream_actor(
    app: AppHandle,
    endpoint: openclaw_gateway::GatewayEndpoint,
    mut rx: mpsc::Receiver<GatewayStreamCommand>,
) {
    let mut state = GatewayStreamActorState::default();
    let mut deferred_command: Option<GatewayStreamCommand> = None;
    let mut reconnect_delay = Duration::ZERO;
    let mut reconnect_attempt: u32 = 0;

    loop {
        if deferred_command.is_none() && !reconnect_delay.is_zero() {
            tokio::select! {
                command = rx.recv() => {
                    let Some(command) = command else {
                        return;
                    };
                    deferred_command = Some(command);
                }
                _ = tokio::time::sleep(reconnect_delay) => {}
            }
        }

        let socket = match openclaw_gateway::connect_endpoint_socket_with_device_auth(
            &app, &endpoint, 15, 30,
        )
        .await
        {
            Ok(socket) => socket,
            Err(error) => {
                if let Some(command) = deferred_command.take() {
                    fail_command(command, format!("Gateway 长连接重连失败: {error}"));
                }
                fail_initial_commands(&mut rx, error).await;
                reconnect_delay = reconnect_backoff(reconnect_attempt);
                reconnect_attempt = reconnect_attempt.saturating_add(1);
                continue;
            }
        };

        state.prepare_for_reconnect();
        let connected_at = tokio::time::Instant::now();

        let disconnect_error =
            run_gateway_connected_loop(&app, socket, &mut rx, &mut state, deferred_command.take())
                .await;

        // A connection that stayed up restarts the ladder; a fast flap advances
        // it so a wedged gateway isn't hammered at 0.5s forever.
        if connected_at.elapsed() >= Duration::from_secs(GATEWAY_STREAM_STABLE_CONNECTION_SECS) {
            reconnect_attempt = 0;
        }
        reconnect_delay = reconnect_backoff(reconnect_attempt);
        reconnect_attempt = reconnect_attempt.saturating_add(1);

        if let Some(error) = disconnect_error {
            let _ = app.emit(
                "conversation-gateway-event",
                GatewayStreamUiEvent {
                    conversation_id: None,
                    session_key: state.active_session_key().unwrap_or_default().to_string(),
                    run_id: None,
                    state: "reconnecting".to_string(),
                    content: None,
                    is_reasoning: false,
                    reasoning_content: None,
                    error_message: Some(error),
                    seq: None,
                    created_at: now_millis(),
                    ..Default::default()
                },
            );
            continue;
        }
        return;
    }
}

async fn run_gateway_connected_loop(
    app: &AppHandle,
    socket: openclaw_gateway::GatewaySocket,
    rx: &mut mpsc::Receiver<GatewayStreamCommand>,
    state: &mut GatewayStreamActorState,
    initial_command: Option<GatewayStreamCommand>,
) -> Option<String> {
    let (mut write, mut read) = socket.split();
    let mut pending: HashMap<String, oneshot::Sender<Result<Value, String>>> = HashMap::new();
    let mut keepalive = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(GATEWAY_STREAM_KEEPALIVE_INTERVAL_SECS),
        Duration::from_secs(GATEWAY_STREAM_KEEPALIVE_INTERVAL_SECS),
    );
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    if let Some(request) =
        state.build_resubscribe_request(&format!("imai-resubscribe-{}", uuid::Uuid::new_v4()))
    {
        if let Err(error) = openclaw_gateway::send_json_frame(&mut write, &request).await {
            return Some(format!("Gateway 会话重订阅失败: {error}"));
        }
        // We just re-established a previously-active session: events emitted during
        // the dead window are lost, so tell the UI to refetch history (it treats
        // this like a seq gap). Only fires on a genuine reconnect — the first-ever
        // connect has no active session yet, so `build_resubscribe_request` is None.
        let _ = app.emit(
            "conversation-gateway-event",
            GatewayStreamUiEvent {
                conversation_id: None,
                session_key: state.active_session_key().unwrap_or_default().to_string(),
                run_id: None,
                state: "reconnected".to_string(),
                content: None,
                is_reasoning: false,
                reasoning_content: None,
                error_message: None,
                seq: None,
                created_at: now_millis(),
                ..Default::default()
            },
        );
    }

    if let Some(command) = initial_command {
        if let Err(error) = send_stream_command(app, &mut write, &mut pending, state, command).await {
            fail_pending(&mut pending, error.clone());
            return Some(error);
        }
    }

    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if let Err(error) = write.send(gateway_keepalive_ping_frame()).await {
                    fail_pending(&mut pending, format!("Gateway 长连接保活失败: {error}"));
                    return Some(format!("Gateway 长连接保活失败: {error}"));
                }
            }
            command = rx.recv() => {
                let Some(command) = command else {
                    fail_pending(&mut pending, "Gateway 长连接已停止。".to_string());
                    return None;
                };
                if let Err(error) = send_stream_command(app, &mut write, &mut pending, state, command).await {
                    fail_pending(&mut pending, error.clone());
                    return Some(error);
                }
            }
            frame = read.next() => {
                let Some(frame) = frame else {
                    fail_pending(&mut pending, "Gateway 长连接已断开。".to_string());
                    return Some("Gateway 长连接已断开。".to_string());
                };
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(error) => {
                        let message = format!("Gateway 长连接读取失败: {error}");
                        fail_pending(&mut pending, message.clone());
                        return Some(message);
                    }
                };
                let Ok(text) = frame.into_text() else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("res") => handle_response_frame(&mut pending, &value),
                    Some("event") => {
                        if let Some((expected, actual)) = state.observe_seq(value.get("seq").and_then(Value::as_u64)) {
                            let _ = app.emit("conversation-gateway-event", GatewayStreamUiEvent {
                                conversation_id: None,
                                session_key: state.active_session_key().unwrap_or_default().to_string(),
                                run_id: None,
                                state: "seq_gap".to_string(),
                                content: None,
                                is_reasoning: false,
                                reasoning_content: None,
                                error_message: Some(format!("Gateway event sequence gap: expected {expected}, got {actual}")),
                                seq: Some(actual),
                                created_at: now_millis(),
                    ..Default::default()
                            });
                        }
                        state.learn_run_binding(&value);
                        if let Some(GatewayStreamMappedEvent::Ui(event)) =
                            map_gateway_stream_frame(&value, state.routing())
                        {
                            // Release only after mapping: the terminal frame itself
                            // still needs the binding to reach the right session.
                            if matches!(event.state.as_str(), "final" | "error" | "aborted") {
                                if let Some(run_id) = event.run_id.as_deref() {
                                    state.release_run(run_id);
                                }
                            }
                            let _ = app.emit("conversation-gateway-event", event);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn fail_initial_commands(rx: &mut mpsc::Receiver<GatewayStreamCommand>, error: String) {
    while let Ok(command) = rx.try_recv() {
        fail_command(command, error.clone());
    }
}

async fn send_stream_command(
    app: &AppHandle,
    write: &mut SplitSink<openclaw_gateway::GatewaySocket, Message>,
    pending: &mut HashMap<String, oneshot::Sender<Result<Value, String>>>,
    state: &mut GatewayStreamActorState,
    command: GatewayStreamCommand,
) -> Result<(), String> {
    match command {
        GatewayStreamCommand::Request {
            method,
            params,
            respond,
        } => {
            let id = format!("imai-stream-{}", uuid::Uuid::new_v4());
            let request = json!({
                "type": "req",
                "id": id,
                "method": method,
                "params": params,
            });
            if let Err(error) = openclaw_gateway::send_json_frame(write, &request).await {
                let message = format!("发送 Gateway {method} 请求失败: {error}");
                let _ = respond.send(Err(message.clone()));
                return Err(message);
            }
            pending.insert(id, respond);
        }
        GatewayStreamCommand::SubscribeSession {
            session_key,
            respond,
        } => {
            let id = format!("imai-subscribe-{}", uuid::Uuid::new_v4());
            let request = build_subscribe_session_request(&id, &session_key);
            if let Err(error) = openclaw_gateway::send_json_frame(write, &request).await {
                let message = format!("订阅 Gateway 会话事件失败: {error}");
                let _ = respond.send(Err(message.clone()));
                return Err(message);
            }
            // messages.subscribe only carries chat text; tool-call lifecycle
            // ("item" stream) and turn lifecycle ride the session-level stream, so
            // subscribe to it too. Its ack is tracked but not awaited by the
            // caller: losing it degrades the tool timeline rather than the chat,
            // so the turn still proceeds — the UI is told instead of silently
            // showing a turn that appears to do nothing. Both streams share one
            // monotonic frame `seq`, so seq-gap tracking stays correct.
            let session_sub_id = format!("imai-sess-sub-{}", uuid::Uuid::new_v4());
            let session_sub_request = build_session_events_subscribe_request(&session_sub_id);
            if openclaw_gateway::send_json_frame(write, &session_sub_request)
                .await
                .is_ok()
            {
                pending.insert(
                    session_sub_id,
                    session_subscribe_ack_reporter(app.clone(), session_key.clone()),
                );
            } else {
                emit_session_subscribe_degraded(app, &session_key, "发送订阅请求失败");
            }
            state.remember_active_session(session_key);
            let wrapped = wrap_unit_response(respond);
            pending.insert(id, wrapped);
        }
        GatewayStreamCommand::BindRun {
            run_id,
            session_key,
        } => {
            state.bind_run(run_id, session_key);
        }
    }
    Ok(())
}

/// Watches the session-level subscribe ack in the background. A rejected
/// subscribe used to disappear entirely, leaving a turn that streams text but
/// shows no tool steps and no explanation.
fn session_subscribe_ack_reporter(
    app: AppHandle,
    session_key: String,
) -> oneshot::Sender<Result<Value, String>> {
    let (tx, rx) = oneshot::channel::<Result<Value, String>>();
    tauri::async_runtime::spawn(async move {
        match rx.await {
            Ok(Err(error)) => emit_session_subscribe_degraded(&app, &session_key, &error),
            // Channel closed means the connection went down; the reconnect path
            // already reports that and resubscribes.
            Ok(Ok(_)) | Err(_) => {}
        }
    });
    tx
}

fn emit_session_subscribe_degraded(app: &AppHandle, session_key: &str, error: &str) {
    let _ = app.emit(
        "conversation-gateway-event",
        GatewayStreamUiEvent {
            conversation_id: None,
            session_key: session_key.to_string(),
            run_id: None,
            state: "subscribe_degraded".to_string(),
            error_message: Some(format!("会话工具事件订阅失败，本轮不会显示工具步骤: {error}")),
            created_at: now_millis(),
            ..Default::default()
        },
    );
}

fn fail_command(command: GatewayStreamCommand, error: String) {
    match command {
        GatewayStreamCommand::Request { respond, .. } => {
            let _ = respond.send(Err(error));
        }
        GatewayStreamCommand::SubscribeSession { respond, .. } => {
            let _ = respond.send(Err(error));
        }
        // Nothing is waiting on a binding; it is re-learned from the next chat
        // frame that names the run.
        GatewayStreamCommand::BindRun { .. } => {}
    }
}

fn fail_pending(
    pending: &mut HashMap<String, oneshot::Sender<Result<Value, String>>>,
    error: String,
) {
    for (_, respond) in pending.drain() {
        let _ = respond.send(Err(error.clone()));
    }
}

fn wrap_unit_response(
    respond: oneshot::Sender<Result<(), String>>,
) -> oneshot::Sender<Result<Value, String>> {
    let (tx, rx) = oneshot::channel::<Result<Value, String>>();
    tauri::async_runtime::spawn(async move {
        let result = rx
            .await
            .map_err(|_| "Gateway 订阅响应通道已关闭。".to_string())
            .and_then(|result| result.map(|_| ()));
        let _ = respond.send(result);
    });
    tx
}

fn handle_response_frame(
    pending: &mut HashMap<String, oneshot::Sender<Result<Value, String>>>,
    frame: &Value,
) {
    let Some(id) = frame.get("id").and_then(Value::as_str) else {
        return;
    };
    let Some(respond) = pending.remove(id) else {
        return;
    };
    let result = openclaw_gateway::response_payload(frame, id);
    let _ = respond.send(result);
}

fn gateway_keepalive_ping_frame() -> Message {
    Message::Ping(Vec::new().into())
}

pub(crate) fn build_subscribe_session_request(id: &str, session_key: &str) -> Value {
    json!({
        "type": "req",
        "id": id,
        "method": "sessions.messages.subscribe",
        "params": {
            "key": session_key,
        },
    })
}

/// OpenClaw 8 session events are connection-wide. A session key belongs only
/// to `sessions.messages.subscribe`; passing it here is rejected by 8.1's
/// strict `sessions.subscribe` schema.
pub(crate) fn build_session_events_subscribe_request(id: &str) -> Value {
    json!({
        "type": "req",
        "id": id,
        "method": "sessions.subscribe",
        "params": {},
    })
}

pub fn map_gateway_stream_frame(
    frame: &Value,
    routing: GatewayStreamRouting<'_>,
) -> Option<GatewayStreamMappedEvent> {
    if frame.get("type").and_then(Value::as_str) != Some("event") {
        return None;
    }
    let event = frame.get("event").and_then(Value::as_str)?;
    let payload = frame.get("payload").unwrap_or(&Value::Null);
    let frame_seq = frame.get("seq").and_then(Value::as_u64);

    if matches!(event, "health" | "tick") {
        return None;
    }

    if matches!(
        event,
        "plugin.approval.requested" | "plugin.approval.resolved" | "plugin.approval.removed"
            | "exec.approval.requested" | "exec.approval.resolved"
    ) {
        let request = payload.get("request").unwrap_or(payload);
        let run_id = request
            .get("runId")
            .and_then(Value::as_str)
            .or_else(|| payload.get("runId").and_then(Value::as_str));
        let session_key = request
            .get("sessionKey")
            .and_then(Value::as_str)
            .or_else(|| payload.get("sessionKey").and_then(Value::as_str))
            .or_else(|| routing.session_for(run_id))
            .unwrap_or_default()
            .to_string();
        return Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
            conversation_id: None,
            session_key,
            run_id: run_id.map(str::to_string),
            state: match event {
                "plugin.approval.requested" => "plugin_approval_requested",
                "exec.approval.requested" => "exec_approval_requested",
                "exec.approval.resolved" => "exec_approval_resolved",
                _ => "plugin_approval_resolved",
            }.to_string(),
            approval_request: Some(payload.clone()),
            seq: frame_seq,
            created_at: now_millis(),
            ..Default::default()
        }));
    }

    // Session subscribers that did NOT claim the `tool-events` cap receive the
    // full tool frames under this event name instead of `agent`. The payload is
    // the same shape, so keep accepting it — it makes tool args (and therefore
    // 产物 extraction) work even if the handshake cap is ever dropped.
    if event == "session.tool" {
        return map_gateway_tool_stream(payload, routing, frame_seq);
    }

    // OpenClaw 8.1 persists each transcript record then broadcasts this exact
    // canonical row to `sessions.messages.subscribe` subscribers. Treat it as
    // a separate event from assistant text streaming: a user row is the
    // authoritative acknowledgement for the local optimistic bubble.
    if event == "session.message" {
        return map_gateway_session_message(payload, routing, frame_seq);
    }

    // OpenClaw's session stream is the authoritative completion signal for a
    // run.  Some gateway versions persist and broadcast `session.ended`
    // without a matching `chat.final`; if we drop it, the visible answer is
    // complete but the composer remains locked as "处理中" indefinitely.
    if event == "session.ended" {
        return map_gateway_session_ended(payload, routing, frame_seq);
    }

    if event == "agent" {
        let stream = payload
            .get("stream")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if stream == "tool" {
            return map_gateway_tool_stream(payload, routing, frame_seq);
        }
        // OpenClaw (2026.6.x) streams tool-call lifecycle on the "item" stream,
        // not "tool": data = { kind:"tool", phase:"start"|"end", status, name,
        // toolCallId, ... }. This rides the session-level `sessions.subscribe`
        // stream (chat text comes over messages.subscribe).
        if stream == "item" {
            return map_gateway_item_stream(payload, routing, frame_seq);
        }
        if !matches!(stream, "assistant" | "thinking" | "reasoning") {
            return None;
        }
        let content = payload
            .get("data")
            .and_then(|data| data.get("text"))
            .and_then(extract_gateway_text_content)
            .or_else(|| {
                payload
                    .get("data")
                    .and_then(extract_gateway_reasoning_content)
            })?;
        let is_reasoning = matches!(stream, "thinking" | "reasoning");
        let run_id = payload.get("runId").and_then(Value::as_str);
        return Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
            conversation_id: None,
            session_key: routing.session_for(run_id).unwrap_or_default().to_string(),
            run_id: run_id.map(str::to_string),
            state: if is_reasoning { "thinking" } else { "delta" }.to_string(),
            content: (!is_reasoning).then_some(content.clone()),
            is_reasoning,
            reasoning_content: is_reasoning.then_some(content),
            error_message: None,
            seq: payload.get("seq").and_then(Value::as_u64).or(frame_seq),
            created_at: now_millis(),
                    ..Default::default()
        }));
    }

    if event == "chat" || event.starts_with("chat.") {
        let state = gateway_stream_state(event, payload);
        let gateway_error = gateway_stream_error(payload);
        let is_reasoning = matches!(state.as_str(), "thinking" | "reasoning")
            || gateway_stream_reasoning_content(payload).is_some();
        let reasoning_content = gateway_stream_reasoning_content(payload).or_else(|| {
            is_reasoning
                .then(|| gateway_stream_message_content(payload))
                .flatten()
        });
        let run_id = payload.get("runId").and_then(Value::as_str);
        return Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
            conversation_id: None,
            session_key: payload
                .get("sessionKey")
                .and_then(Value::as_str)
                .or_else(|| routing.session_for(run_id))
                .unwrap_or_default()
                .to_string(),
            run_id: run_id.map(str::to_string),
            state,
            content: if is_reasoning || gateway_error.is_some() {
                None
            } else {
                gateway_stream_message_content(payload)
            },
            is_reasoning,
            reasoning_content: gateway_error.is_none().then_some(reasoning_content).flatten(),
            error_message: None,
            gateway_error,
            seq: payload.get("seq").and_then(Value::as_u64).or(frame_seq),
            created_at: now_millis(),
                    ..Default::default()
        }));
    }

    None
}

fn map_gateway_session_message(
    payload: &Value,
    routing: GatewayStreamRouting<'_>,
    frame_seq: Option<u64>,
) -> Option<GatewayStreamMappedEvent> {
    let message = payload.get("message")?;
    let role = message.get("role").and_then(Value::as_str)?.trim();
    if role.is_empty() {
        return None;
    }
    let content = message
        .get("content")
        .and_then(extract_gateway_text_content)
        .or_else(|| message.get("text").and_then(extract_gateway_text_content))
        .unwrap_or_default();
    let run_id = payload.get("runId").and_then(Value::as_str);
    let id = payload
        .get("messageId")
        .and_then(Value::as_str)
        .or_else(|| message.get("id").and_then(Value::as_str))
        .or_else(|| {
            message
                .get("__openclaw")
                .and_then(|meta| meta.get("id"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let idempotency_key = message
        .get("idempotencyKey")
        .or_else(|| message.get("idempotency_key"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let created_at = ["timestamp", "createdAt", "created_at"]
        .iter()
        .find_map(|key| message.get(*key).and_then(gateway_timestamp_millis))
        .unwrap_or_else(now_millis);

    Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
        conversation_id: None,
        session_key: payload
            .get("sessionKey")
            .and_then(Value::as_str)
            .or_else(|| routing.session_for(run_id))
            .unwrap_or_default()
            .to_string(),
        run_id: run_id.map(str::to_string),
        state: "session_message".to_string(),
        seq: payload.get("messageSeq").and_then(Value::as_u64).or(frame_seq),
        created_at,
        session_message: Some(GatewaySessionMessage {
            id,
            role: role.to_string(),
            content,
            created_at,
            idempotency_key,
        }),
        ..Default::default()
    }))
}

fn map_gateway_session_ended(
    payload: &Value,
    routing: GatewayStreamRouting<'_>,
    frame_seq: Option<u64>,
) -> Option<GatewayStreamMappedEvent> {
    let status = payload
        .get("data")
        .and_then(|data| data.get("status"))
        .or_else(|| payload.get("status"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|status| !status.is_empty())?;
    let state = match status {
        "success" | "completed" | "complete" | "done" => "final",
        "aborted" | "cancelled" | "canceled" => "aborted",
        _ => "error",
    };
    let run_id = payload.get("runId").and_then(Value::as_str);

    Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
        conversation_id: None,
        session_key: payload
            .get("sessionKey")
            .and_then(Value::as_str)
            .or_else(|| routing.session_for(run_id))
            .unwrap_or_default()
            .to_string(),
        run_id: run_id.map(str::to_string),
        state: state.to_string(),
        seq: payload.get("seq").and_then(Value::as_u64).or(frame_seq),
        created_at: now_millis(),
        ..Default::default()
    }))
}

fn gateway_timestamp_millis(value: &Value) -> Option<u64> {
    if let Some(value) = value.as_u64() {
        return Some(value);
    }
    let value = value.as_str()?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(value) = value.parse::<u64>() {
        return Some(value);
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .and_then(|value| u64::try_from(value.timestamp_millis()).ok())
}

const GATEWAY_TOOL_ARGS_PREVIEW_MAX_CHARS: usize = 400;
const GATEWAY_TOOL_RESULT_PREVIEW_MAX_CHARS: usize = 600;

// OpenClaw agent "item" stream. Message items surface here; tool-call items are
// data = { kind:"tool", phase:"start"|"end", status:"running"|"completed"|"error",
// name, title, toolCallId, startedAt?, endedAt? }. Non-tool items (assistant text)
// arrive over the chat/messages stream, so only tool items are surfaced here. The
// lifecycle frames carry no args/result — the UI shows tool name + status only.
fn map_gateway_item_stream(
    payload: &Value,
    routing: GatewayStreamRouting<'_>,
    frame_seq: Option<u64>,
) -> Option<GatewayStreamMappedEvent> {
    let data = payload.get("data").unwrap_or(&Value::Null);
    if data.get("kind").and_then(Value::as_str) != Some("tool") {
        return None;
    }
    let phase = data.get("phase").and_then(Value::as_str).unwrap_or_default();
    let status = data.get("status").and_then(Value::as_str).unwrap_or_default();
    let is_error = matches!(status, "error" | "failed");
    let state = match phase {
        "start" => "tool_started",
        "end" if is_error => "tool_error",
        "end" => "tool_result",
        _ => "tool_update",
    };
    let tool_name = data
        .get("name")
        .or_else(|| data.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    let run_id = payload.get("runId").and_then(Value::as_str);
    Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
        conversation_id: None,
        session_key: payload
            .get("sessionKey")
            .and_then(Value::as_str)
            .or_else(|| routing.session_for(run_id))
            .unwrap_or_default()
            .to_string(),
        run_id: run_id.map(str::to_string),
        state: state.to_string(),
        seq: payload.get("seq").and_then(Value::as_u64).or(frame_seq),
        created_at: now_millis(),
        tool_name: Some(tool_name.to_string()),
        tool_call_id: data
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_phase: Some(phase.to_string()),
        tool_is_error: is_error,
        ..Default::default()
    }))
}

// Official OpenClaw agent tool stream: payload.data =
// { phase: "start" | "update" | "result", name, toolCallId, args?, isError?, result? }.
fn map_gateway_tool_stream(
    payload: &Value,
    routing: GatewayStreamRouting<'_>,
    frame_seq: Option<u64>,
) -> Option<GatewayStreamMappedEvent> {
    let data = payload.get("data").unwrap_or(&Value::Null);
    let phase = data
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or("update");
    let is_error = data.get("isError").and_then(Value::as_bool).unwrap_or(false);
    let state = match phase {
        "start" => "tool_started",
        "result" if is_error => "tool_error",
        "result" => "tool_result",
        _ => "tool_update",
    };
    let tool_name = data
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    let result_text = data
        .get("result")
        .or_else(|| data.get("partialResult"))
        .and_then(extract_gateway_text_content);
    let result_preview = result_text
        .as_deref()
        .map(|text| truncate_chars(text, GATEWAY_TOOL_RESULT_PREVIEW_MAX_CHARS));
    // Extract from the raw values, not from the truncated previews: a `write`
    // call ships the whole file body in `args`, so the 400-char preview would
    // routinely cut the `file_path` off.
    let tool_artifacts = crate::services::tool_artifacts::extract_tool_artifact_paths(
        tool_name,
        data.get("args"),
        result_text.as_deref(),
    );
    let run_id = payload.get("runId").and_then(Value::as_str);
    Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
        conversation_id: None,
        session_key: payload
            .get("sessionKey")
            .and_then(Value::as_str)
            .or_else(|| routing.session_for(run_id))
            .unwrap_or_default()
            .to_string(),
        run_id: run_id.map(str::to_string),
        state: state.to_string(),
        seq: payload.get("seq").and_then(Value::as_u64).or(frame_seq),
        created_at: now_millis(),
        tool_name: Some(tool_name.to_string()),
        tool_call_id: data
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_phase: Some(phase.to_string()),
        tool_is_error: is_error,
        tool_args: data.get("args").and_then(compact_json_preview),
        tool_result_preview: result_preview,
        tool_artifacts,
        ..Default::default()
    }))
}

fn compact_json_preview(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let rendered = match value.as_str() {
        Some(text) => text.trim().to_string(),
        None => serde_json::to_string(value).ok()?,
    };
    if rendered.is_empty() || rendered == "{}" {
        return None;
    }
    Some(truncate_chars(&rendered, GATEWAY_TOOL_ARGS_PREVIEW_MAX_CHARS))
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let truncated: String = value.chars().take(max_chars).collect();
    format!("{truncated}…")
}

fn gateway_stream_state(event: &str, payload: &Value) -> String {
    let raw_state = payload
        .get("state")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| match event {
            "chat.final" => "final".to_string(),
            "chat.error" => "error".to_string(),
            "chat.aborted" => "aborted".to_string(),
            "chat.delta" => "delta".to_string(),
            _ => "event".to_string(),
        });

    // Gateway releases have used both chat.final and a generic chat event with
    // state=completed/success.  Keep the frontend terminal contract stable.
    match raw_state.as_str() {
        "completed" | "complete" | "success" | "done" => "final".to_string(),
        "cancelled" | "canceled" => "aborted".to_string(),
        _ => raw_state,
    }
}

fn gateway_stream_message_content(payload: &Value) -> Option<String> {
    payload
        .get("message")
        .and_then(extract_gateway_text_content)
        .or_else(|| {
            payload
                .get("content")
                .and_then(extract_gateway_text_content)
        })
        .or_else(|| {
            payload
                .get("deltaText")
                .and_then(extract_gateway_text_content)
        })
        .or_else(|| payload.get("text").and_then(extract_gateway_text_content))
}

fn gateway_stream_reasoning_content(payload: &Value) -> Option<String> {
    payload
        .get("reasoningContent")
        .and_then(extract_gateway_text_content)
        .or_else(|| {
            payload
                .get("reasoningText")
                .and_then(extract_gateway_text_content)
        })
        .or_else(|| {
            payload
                .get("reasoning")
                .and_then(extract_gateway_reasoning_content)
        })
        .or_else(|| {
            payload
                .get("thinking")
                .and_then(extract_gateway_text_content)
        })
        .or_else(|| {
            payload
                .get("message")
                .and_then(extract_gateway_reasoning_content)
        })
        .or_else(|| {
            payload
                .get("content")
                .and_then(extract_gateway_reasoning_content)
        })
}

fn gateway_stream_error(payload: &Value) -> Option<UniopcGatewayError> {
    let has_error = payload.get("state").and_then(Value::as_str) == Some("error")
        || payload.get("error").is_some()
        || payload.get("errorMessage").is_some()
        || payload.get("reason").is_some();
    if !has_error {
        return None;
    }
    if payload.get("error").is_some() {
        return Some(normalize_gateway_error(payload.clone()));
    }
    // Official 2026.8.1 chat frames put the provider failure in
    // `errorMessage`, without a structured `error` object. Preserve only the
    // safe category recognized by the contract; all other message text stays
    // out of the renderer and follows the stable errorKind fallback below.
    let normalized_payload_error = normalize_gateway_error(payload.clone());
    if normalized_payload_error.code == "MODEL_AUTH_OR_BILLING" {
        return Some(normalized_payload_error);
    }
    let code = match payload.get("errorKind").and_then(Value::as_str) {
        Some("timeout") => "TIMEOUT",
        _ => "GATEWAY_ERROR",
    };
    Some(normalize_gateway_error(json!({ "error": { "code": code } })))
}

fn extract_gateway_text_content(value: &Value) -> Option<String> {
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
                _ => None,
            })
            .collect::<Vec<_>>();
        if !parts.is_empty() {
            return Some(parts.join("\n\n").trim().to_string());
        }
    }
    value.get("content").and_then(extract_gateway_text_content)
}

fn extract_gateway_reasoning_content(value: &Value) -> Option<String> {
    if let Some(items) = value.as_array() {
        let parts = items
            .iter()
            .filter_map(extract_gateway_reasoning_content)
            .collect::<Vec<_>>();
        if !parts.is_empty() {
            return Some(parts.join("\n\n").trim().to_string());
        }
    }
    if let Some(reasoning) = value
        .get("reasoningContent")
        .or_else(|| value.get("reasoningText"))
        .or_else(|| value.get("reasoning"))
        .or_else(|| value.get("thinking"))
        .and_then(extract_gateway_text_content)
    {
        return Some(reasoning);
    }
    match value.get("type").and_then(Value::as_str) {
        Some("thinking") | Some("reasoning") => value
            .get("text")
            .or_else(|| value.get("content"))
            .and_then(extract_gateway_text_content),
        _ => value
            .get("content")
            .and_then(extract_gateway_reasoning_content),
    }
}

fn endpoint_signature(endpoint: &openclaw_gateway::GatewayEndpoint) -> String {
    format!(
        "{}|{}|{}|{}",
        endpoint.url,
        endpoint.token.as_deref().unwrap_or_default(),
        endpoint.password.as_deref().unwrap_or_default(),
        endpoint.device_token.as_deref().unwrap_or_default()
    )
}

fn now_millis() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejected_long_lived_response_uses_normalized_gateway_error() {
        let (tx, rx) = oneshot::channel();
        let mut pending = HashMap::from([("stream-1".to_string(), tx)]);
        handle_response_frame(
            &mut pending,
            &json!({
                "type": "res",
                "id": "stream-1",
                "ok": false,
                "error": {
                    "code": "UNAVAILABLE",
                    "message": "token=stream-secret C:\\\\private\\\\openclaw-engine",
                    "details": { "traceId": "trace-stream" }
                }
            }),
        );

        let error = rx.await.expect("response delivered").expect_err("rejected");
        assert!(error.contains("gateway.unavailable"));
        assert!(!error.contains("trace-stream"));
        let normalized: Value = serde_json::from_str(&error).expect("normalized error DTO");
        assert!(uuid::Uuid::parse_str(
            normalized["traceId"].as_str().expect("local trace id")
        )
        .is_ok());
        assert!(!error.contains("stream-secret"));
        assert!(!error.contains("openclaw-engine"));
    }

    /// Most mapper tests only care about the active-session fallback; the
    /// run-ownership routing has its own dedicated tests below.
    fn map_frame_for_session(frame: &Value, key: Option<&str>) -> Option<GatewayStreamMappedEvent> {
        map_gateway_stream_frame(frame, GatewayStreamRouting::for_active_session(key))
    }
    use serde_json::json;

    #[test]
    fn maps_official_chat_final_event_to_ui_event() {
        let frame = json!({
            "type": "event",
            "event": "chat",
            "seq": 42,
            "payload": {
                "runId": "run-1",
                "sessionKey": "session-1",
                "state": "final",
                "message": "Done"
            }
        });

        let mapped = map_frame_for_session(&frame, Some("session-1"));

        assert_eq!(
            mapped,
            Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
                conversation_id: None,
                session_key: "session-1".to_string(),
                run_id: Some("run-1".to_string()),
                state: "final".to_string(),
                content: Some("Done".to_string()),
                is_reasoning: false,
                reasoning_content: None,
                error_message: None,
                seq: Some(42),
                created_at: mapped_created_at(mapped.as_ref()),
                ..Default::default()
            }))
        );
    }

    #[test]
    fn maps_plugin_write_approval_to_the_active_conversation() {
        let frame = json!({
            "type": "event",
            "event": "plugin.approval.requested",
            "seq": 44,
            "payload": {
                "id": "approval-1",
                "request": {
                    "pluginId": "uniopc-local-workspace",
                    "toolName": "uniopc_local_document_update",
                    "sessionKey": "agent:assistant:main",
                    "runId": "turn-2",
                    "title": "更新本地文档",
                    "allowedDecisions": ["allow-once", "deny"]
                }
            }
        });

        let Some(GatewayStreamMappedEvent::Ui(event)) =
            map_frame_for_session(&frame, Some("agent:assistant:main"))
        else {
            panic!("plugin approval must reach the conversation UI");
        };
        assert_eq!(event.state, "plugin_approval_requested");
        assert_eq!(event.session_key, "agent:assistant:main");
        assert_eq!(event.run_id.as_deref(), Some("turn-2"));
        assert_eq!(
            event
                .approval_request
                .as_ref()
                .and_then(|row| row.get("id"))
                .and_then(Value::as_str),
            Some("approval-1")
        );
    }

    #[test]
    fn maps_exec_approval_to_its_session() {
        let frame = json!({
            "type": "event",
            "event": "exec.approval.requested",
            "payload": {
                "id": "exec-approval-1",
                "request": {
                    "sessionKey": "agent:assistant:main",
                    "runId": "turn-3",
                    "command": "touch /tmp/approval-test"
                }
            }
        });
        let Some(GatewayStreamMappedEvent::Ui(event)) =
            map_frame_for_session(&frame, Some("agent:assistant:main"))
        else {
            panic!("exec approval must reach the conversation UI");
        };
        assert_eq!(event.state, "exec_approval_requested");
        assert_eq!(event.session_key, "agent:assistant:main");
        assert_eq!(event.run_id.as_deref(), Some("turn-3"));
        assert_eq!(event.approval_request.as_ref().unwrap()["id"], "exec-approval-1");
    }

    #[test]
    fn captured_2026_8_1_chat_error_exposes_only_normalized_fields() {
        let mut frame: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/openclaw-2026.8.1/chat-error.json"
        )))
        .expect("captured chat error fixture");
        frame["payload"]["errorMessage"] =
            json!("token=stream-secret C:\\private\\OpenClaw-engine");

        let Some(GatewayStreamMappedEvent::Ui(event)) =
            map_frame_for_session(&frame, Some("<redacted-session-key>"))
        else {
            panic!("chat error must map to a UI event");
        };
        let serialized = serde_json::to_string(&event).expect("UI event serializes");

        assert_eq!(event.error_message, None);
        assert_eq!(event.gateway_error.as_ref().map(|value| value.code.as_str()), Some("GATEWAY_ERROR"));
        assert!(!serialized.contains("stream-secret"));
        assert!(!serialized.contains("C:\\private"));
        assert!(!serialized.contains("OpenClaw"));
    }

    #[test]
    fn official_chat_error_state_uses_only_stable_error_kind() {
        for (error_kind, expected_code) in [
            (Some("timeout"), "TIMEOUT"),
            (Some("unknown"), "GATEWAY_ERROR"),
            (None, "GATEWAY_ERROR"),
        ] {
            let mut payload = json!({
                "runId": "run-error",
                "sessionKey": "session-error",
                "state": "error",
                "errorMessage": "401 token=must-not-drive-classification"
            });
            if let Some(error_kind) = error_kind {
                payload["errorKind"] = json!(error_kind);
            }
            let frame = json!({ "type": "event", "event": "chat", "payload": payload });

            let Some(GatewayStreamMappedEvent::Ui(event)) =
                map_frame_for_session(&frame, Some("session-error"))
            else {
                panic!("chat error must map");
            };
            assert_eq!(
                event.gateway_error.as_ref().map(|error| error.code.as_str()),
                Some(expected_code)
            );
            assert!(!serde_json::to_string(&event)
                .expect("UI event")
                .contains("must-not-drive-classification"));
        }
    }

    #[test]
    fn official_provider_auth_or_billing_failure_has_a_safe_model_category() {
        let frame = json!({
            "type": "event",
            "event": "chat",
            "payload": {
                "runId": "run-error",
                "sessionKey": "session-error",
                "state": "error",
                "errorMessage": "Inline API key for provider \"uniopc-official\" is temporarily disabled after a provider auth/billing failure."
            }
        });

        let Some(GatewayStreamMappedEvent::Ui(event)) =
            map_frame_for_session(&frame, Some("session-error"))
        else {
            panic!("chat error must map");
        };

        let error = event.gateway_error.expect("normalized model error");
        assert_eq!(error.code, "MODEL_AUTH_OR_BILLING");
        assert_eq!(error.recovery_action, "selectModel");
        assert!(!serde_json::to_string(&error)
            .expect("normalized error serializes")
            .contains("uniopc-official"));
    }

    #[test]
    fn maps_official_session_message_to_canonical_user_event() {
        let frame = json!({
            "type": "event",
            "event": "session.message",
            "seq": 43,
            "payload": {
                "sessionKey": "agent:assistant:main",
                "runId": "turn-1",
                "messageId": "gateway-user-1",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "请介绍下你自己" }],
                    "timestamp": 1_785_814_340_000_u64,
                    "idempotencyKey": "turn-1:user"
                }
            }
        });

        let Some(GatewayStreamMappedEvent::Ui(event)) =
            map_frame_for_session(&frame, Some("agent:assistant:main"))
        else {
            panic!("expected the official session.message to reach the UI");
        };

        assert_eq!(event.state, "session_message");
        assert_eq!(event.session_key, "agent:assistant:main");
        assert_eq!(event.run_id.as_deref(), Some("turn-1"));
        assert_eq!(event.seq, Some(43));
        assert_eq!(
            event.session_message,
            Some(GatewaySessionMessage {
                id: Some("gateway-user-1".to_string()),
                role: "user".to_string(),
                content: "请介绍下你自己".to_string(),
                created_at: 1_785_814_340_000,
                idempotency_key: Some("turn-1:user".to_string()),
            })
        );
    }

    #[test]
    fn maps_session_ended_success_to_final_event() {
        let frame = json!({
            "type": "event",
            "event": "session.ended",
            "seq": 44,
            "payload": {
                "sessionKey": "agent:assistant:main",
                "runId": "turn-1",
                "data": { "status": "success" }
            }
        });

        let Some(GatewayStreamMappedEvent::Ui(event)) =
            map_frame_for_session(&frame, Some("agent:assistant:main"))
        else {
            panic!("session completion must reach the conversation UI");
        };

        assert_eq!(event.state, "final");
        assert_eq!(event.session_key, "agent:assistant:main");
        assert_eq!(event.run_id.as_deref(), Some("turn-1"));
        assert_eq!(event.seq, Some(44));
    }

    #[test]
    fn maps_official_assistant_agent_stream_to_delta_event() {
        let frame = json!({
            "type": "event",
            "event": "agent",
            "seq": 9,
            "payload": {
                "runId": "run-2",
                "stream": "assistant",
                "seq": 3,
                "data": {
                    "text": "partial"
                }
            }
        });

        let mapped = map_frame_for_session(&frame, Some("session-2"));

        assert_eq!(
            mapped,
            Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
                conversation_id: None,
                session_key: "session-2".to_string(),
                run_id: Some("run-2".to_string()),
                state: "delta".to_string(),
                content: Some("partial".to_string()),
                is_reasoning: false,
                reasoning_content: None,
                error_message: None,
                seq: Some(3),
                created_at: mapped_created_at(mapped.as_ref()),
                ..Default::default()
            }))
        );
    }

    #[test]
    fn maps_item_stream_tool_start_to_tool_started_event() {
        let frame = json!({
            "type": "event",
            "event": "agent",
            "seq": 106,
            "payload": {
                "runId": "run-t",
                "sessionKey": "agent:main:main",
                "stream": "item",
                "seq": 3,
                "data": {
                    "itemId": "tool:call_x",
                    "phase": "start",
                    "kind": "tool",
                    "title": "uniopc_cloud_projects_list",
                    "status": "running",
                    "name": "uniopc_cloud_projects_list",
                    "toolCallId": "call_x"
                }
            }
        });

        let mapped = map_frame_for_session(&frame, Some("session-t"));

        assert_eq!(
            mapped,
            Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
                conversation_id: None,
                session_key: "agent:main:main".to_string(),
                run_id: Some("run-t".to_string()),
                state: "tool_started".to_string(),
                seq: Some(3),
                created_at: mapped_created_at(mapped.as_ref()),
                tool_name: Some("uniopc_cloud_projects_list".to_string()),
                tool_call_id: Some("call_x".to_string()),
                tool_phase: Some("start".to_string()),
                tool_is_error: false,
                ..Default::default()
            }))
        );
    }

    #[test]
    fn maps_item_stream_tool_end_to_tool_result_event() {
        let frame = json!({
            "type": "event",
            "event": "agent",
            "payload": {
                "runId": "run-t",
                "stream": "item",
                "data": {
                    "phase": "end",
                    "kind": "tool",
                    "status": "completed",
                    "name": "uniopc_cloud_projects_list",
                    "toolCallId": "call_x"
                }
            }
        });

        let mapped = map_frame_for_session(&frame, Some("session-t"));
        match mapped {
            Some(GatewayStreamMappedEvent::Ui(event)) => {
                assert_eq!(event.state, "tool_result");
                assert_eq!(event.tool_name.as_deref(), Some("uniopc_cloud_projects_list"));
                assert!(!event.tool_is_error);
            }
            other => panic!("expected tool_result Ui event, got {other:?}"),
        }
    }

    #[test]
    fn ignores_non_tool_item_stream_frames() {
        let frame = json!({
            "type": "event",
            "event": "agent",
            "payload": {
                "runId": "run-t",
                "stream": "item",
                "data": { "phase": "start", "kind": "message", "text": "hi" }
            }
        });
        assert_eq!(map_frame_for_session(&frame, Some("session-t")), None);
    }

    #[test]
    fn maps_official_thinking_agent_stream_to_reasoning_event() {
        let frame = json!({
            "type": "event",
            "event": "agent",
            "seq": 10,
            "payload": {
                "runId": "run-3",
                "stream": "thinking",
                "seq": 4,
                "data": {
                    "text": "checking context"
                }
            }
        });

        let mapped = map_frame_for_session(&frame, Some("session-3"));

        assert_eq!(
            mapped,
            Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
                conversation_id: None,
                session_key: "session-3".to_string(),
                run_id: Some("run-3".to_string()),
                state: "thinking".to_string(),
                content: None,
                is_reasoning: true,
                reasoning_content: Some("checking context".to_string()),
                error_message: None,
                seq: Some(4),
                created_at: mapped_created_at(mapped.as_ref()),
                ..Default::default()
            }))
        );
    }

    #[test]
    fn maps_official_tool_agent_stream_start_to_tool_started_event() {
        let frame = json!({
            "type": "event",
            "event": "agent",
            "seq": 11,
            "payload": {
                "runId": "run-4",
                "stream": "tool",
                "seq": 5,
                "data": {
                    "phase": "start",
                    "name": "exec",
                    "toolCallId": "call-1",
                    "args": { "command": "ls -la" }
                }
            }
        });

        let mapped = map_frame_for_session(&frame, Some("session-4"));

        assert_eq!(
            mapped,
            Some(GatewayStreamMappedEvent::Ui(GatewayStreamUiEvent {
                conversation_id: None,
                session_key: "session-4".to_string(),
                run_id: Some("run-4".to_string()),
                state: "tool_started".to_string(),
                seq: Some(5),
                created_at: mapped_created_at(mapped.as_ref()),
                tool_name: Some("exec".to_string()),
                tool_call_id: Some("call-1".to_string()),
                tool_phase: Some("start".to_string()),
                tool_is_error: false,
                tool_args: Some("{\"command\":\"ls -la\"}".to_string()),
                ..Default::default()
            }))
        );
    }

    #[test]
    fn maps_official_tool_agent_stream_error_result_to_tool_error_event() {
        let frame = json!({
            "type": "event",
            "event": "agent",
            "payload": {
                "runId": "run-5",
                "stream": "tool",
                "data": {
                    "phase": "result",
                    "name": "read",
                    "toolCallId": "call-2",
                    "isError": true,
                    "result": { "content": [{ "type": "text", "text": "file not found" }] }
                }
            }
        });

        let mapped = map_frame_for_session(&frame, Some("session-5"));

        let Some(GatewayStreamMappedEvent::Ui(event)) = mapped else {
            panic!("expected ui event, got {mapped:?}");
        };
        assert_eq!(event.state, "tool_error");
        assert_eq!(event.tool_name.as_deref(), Some("read"));
        assert_eq!(event.tool_call_id.as_deref(), Some("call-2"));
        assert!(event.tool_is_error);
        assert_eq!(event.tool_result_preview.as_deref(), Some("file not found"));
        assert_eq!(event.content, None);
    }

    #[test]
    fn tool_args_preview_is_truncated_and_nameless_tool_frames_are_dropped() {
        let long_arg = "x".repeat(1000);
        let frame = json!({
            "type": "event",
            "event": "agent",
            "payload": {
                "stream": "tool",
                "data": { "phase": "start", "name": "exec", "args": { "command": long_arg } }
            }
        });
        let Some(GatewayStreamMappedEvent::Ui(event)) =
            map_frame_for_session(&frame, Some("s"))
        else {
            panic!("expected ui event");
        };
        let args = event.tool_args.expect("args preview");
        assert!(args.chars().count() <= GATEWAY_TOOL_ARGS_PREVIEW_MAX_CHARS + 1);
        assert!(args.ends_with('…'));

        let nameless = json!({
            "type": "event",
            "event": "agent",
            "payload": { "stream": "tool", "data": { "phase": "start" } }
        });
        assert_eq!(map_frame_for_session(&nameless, Some("s")), None);
    }

    #[test]
    fn seq_tracker_reports_gaps() {
        let mut tracker = GatewaySeqTracker::default();

        assert_eq!(tracker.observe(Some(1)), None);
        assert_eq!(tracker.observe(Some(2)), None);
        assert_eq!(tracker.observe(Some(5)), Some((3, 5)));
    }

    #[test]
    fn subscribe_session_request_uses_official_key_param() {
        let request = build_subscribe_session_request("req-1", "agent:main:main");

        assert_eq!(request["method"], "sessions.messages.subscribe");
        assert_eq!(request["params"], json!({ "key": "agent:main:main" }));
    }

    #[test]
    fn session_events_subscribe_request_uses_openclaw_8_empty_params() {
        let request = build_session_events_subscribe_request("req-2");

        assert_eq!(request["method"], "sessions.subscribe");
        assert_eq!(request["params"], json!({}));
    }

    #[test]
    fn keepalive_uses_official_websocket_ping_cadence() {
        assert_eq!(GATEWAY_STREAM_KEEPALIVE_INTERVAL_SECS, 15);
        match gateway_keepalive_ping_frame() {
            Message::Ping(payload) => assert!(payload.is_empty()),
            other => panic!("expected ping frame, got {other:?}"),
        }
    }

    #[test]
    fn stream_runtime_connect_uses_official_device_auth_socket() {
        let source = include_str!("openclaw_gateway_stream.rs");
        assert!(source.contains("connect_endpoint_socket_with_device_auth"));
        let legacy_call = format!("{}{}", "connect_endpoint_socket", "(&endpoint");
        assert!(!source.contains(&legacy_call));
    }

    #[test]
    fn reconnect_backoff_ramps_fast_first_then_caps() {
        // Fast first retry so a brief mid-turn blip recovers quickly...
        assert_eq!(reconnect_backoff(0), Duration::from_millis(500));
        assert_eq!(reconnect_backoff(1), Duration::from_millis(1_000));
        // ...ramping up, then clamped at the 30s ceiling for a wedged gateway.
        assert_eq!(reconnect_backoff(5), Duration::from_millis(30_000));
        assert_eq!(reconnect_backoff(99), Duration::from_millis(30_000));
    }

    #[test]
    fn actor_state_builds_official_resubscribe_after_reconnect() {
        let mut state = GatewayStreamActorState::default();
        state.remember_active_session("agent:main:main".to_string());

        let request = state
            .build_resubscribe_request("req-1")
            .expect("active session request");

        assert_eq!(request["method"], "sessions.messages.subscribe");
        assert_eq!(request["params"], json!({ "key": "agent:main:main" }));
    }

    #[test]
    fn actor_state_resets_sequence_tracker_for_reconnect() {
        let mut state = GatewayStreamActorState::default();

        assert_eq!(state.observe_seq(Some(7)), None);
        state.prepare_for_reconnect();

        assert_eq!(state.observe_seq(Some(1)), None);
    }

    #[test]
    fn agent_stream_is_routed_by_run_owner_not_by_active_session() {
        // The user sent a turn on session-a, then switched to session-b while it
        // was still running. Its agent frames carry no sessionKey, so before the
        // run binding they landed on whichever chat was on screen.
        let mut state = GatewayStreamActorState::default();
        state.remember_active_session("session-a".to_string());
        state.bind_run("run-a".to_string(), "session-a".to_string());
        state.remember_active_session("session-b".to_string());

        let frame = json!({
            "type": "event",
            "event": "agent",
            "payload": {
                "stream": "assistant",
                "runId": "run-a",
                "data": { "text": "still answering session-a" },
            },
        });

        let mapped = map_gateway_stream_frame(&frame, state.routing());
        let Some(GatewayStreamMappedEvent::Ui(event)) = mapped else {
            panic!("expected a mapped ui event");
        };
        assert_eq!(event.session_key, "session-a");
        assert_eq!(event.run_id.as_deref(), Some("run-a"));
    }

    #[test]
    fn unbound_run_still_falls_back_to_active_session() {
        // A run started by another client is never bound here, and must keep the
        // pre-existing behaviour instead of dropping to an empty session key.
        let mut state = GatewayStreamActorState::default();
        state.remember_active_session("session-b".to_string());

        let frame = json!({
            "type": "event",
            "event": "agent",
            "payload": {
                "stream": "assistant",
                "runId": "run-foreign",
                "data": { "text": "hi" },
            },
        });

        let mapped = map_gateway_stream_frame(&frame, state.routing());
        let Some(GatewayStreamMappedEvent::Ui(event)) = mapped else {
            panic!("expected a mapped ui event");
        };
        assert_eq!(event.session_key, "session-b");
    }

    #[test]
    fn chat_frames_bind_their_run_to_the_session_they_name() {
        let mut state = GatewayStreamActorState::default();
        state.remember_active_session("session-b".to_string());
        state.learn_run_binding(&json!({
            "type": "event",
            "event": "chat.delta",
            "payload": { "runId": "run-a", "sessionKey": "session-a", "deltaText": "x" },
        }));

        assert_eq!(
            state.routing().session_for(Some("run-a")),
            Some("session-a")
        );
    }

    #[test]
    fn run_bindings_are_released_and_capped() {
        let mut state = GatewayStreamActorState::default();
        state.bind_run("run-a".to_string(), "session-a".to_string());
        state.release_run("run-a");
        assert!(state.run_sessions.is_empty());
        assert!(state.run_order.is_empty());

        for index in 0..(GATEWAY_STREAM_RUN_BINDING_CAPACITY + 8) {
            state.bind_run(format!("run-{index}"), "session-a".to_string());
        }
        assert_eq!(state.run_sessions.len(), GATEWAY_STREAM_RUN_BINDING_CAPACITY);
        // Oldest evicted first, newest retained.
        assert_eq!(state.routing().session_for(Some("run-0")), None);
        assert_eq!(
            state
                .routing()
                .session_for(Some(&format!("run-{}", GATEWAY_STREAM_RUN_BINDING_CAPACITY + 7))),
            Some("session-a")
        );
    }

    fn mapped_created_at(mapped: Option<&GatewayStreamMappedEvent>) -> u64 {
        match mapped {
            Some(GatewayStreamMappedEvent::Ui(event)) => event.created_at,
            _ => 0,
        }
    }
}
