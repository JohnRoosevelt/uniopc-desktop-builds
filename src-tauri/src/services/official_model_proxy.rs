//! In-process loopback reverse-proxy for the `uniopc-official` model provider.
//!
//! The rotating upstream LLM token used to be written into a `file` secret that
//! the gateway cached in its runtime snapshot (secrets are materialized at
//! startup/reload/failover, NOT per request). Because nothing told the running
//! gateway to re-read that file, every token rotation forced a **sidecar
//! restart** to pick the new token up — which interrupted the in-flight
//! conversation turn on a 401 self-heal.
//!
//! Instead, the token now lives ONLY in this process's memory. The gateway's
//! `uniopc-official` / `openai` / minimax-tts providers point their `baseUrl`
//! at this loopback server and authenticate with a local **shared secret**
//! (a constant string in config → config is byte-stable across token rotations
//! → no `config.patch` → no restart). On every forwarded request this server
//! swaps that shared secret for the real `Bearer <token>` from memory and
//! streams the upstream response straight back (SSE passes through unbuffered).
//!
//! This is the same "secret in Rust memory, injected at the process boundary,
//! never in config" pattern already used for the local gateway password
//! (`services::openclaw_connection::local_gateway_password`). Here the boundary
//! is a network hop instead of an env var, because the gateway is a separate
//! sidecar process rather than in-process.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::Request,
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::any,
    Router,
};
use futures_util::StreamExt;
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter};

/// Chat requests can carry a large context window; allow a generous request
/// body before rejecting. Responses stream and are not bounded by this.
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024 * 1024;

/// OpenAI-compatible providers may omit `content` or `reasoning_content` from
/// an SSE delta. OpenClaw 8.1 calls `.trim()` on those optional fields before
/// guarding them, so normalize every complete SSE `data:` line at the
/// compatibility boundary. The normalizer retains incomplete lines across
/// network chunks: a string replacement on individual TCP chunks misses both
/// formatted JSON and split SSE records.
#[derive(Default)]
struct SseDeltaNormalizer {
    pending: Vec<u8>,
}

impl SseDeltaNormalizer {
    fn push(&mut self, chunk: Bytes) -> Vec<Bytes> {
        self.pending.extend_from_slice(&chunk);
        let mut output = Vec::new();
        while let Some(newline) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line = self.pending.drain(..=newline).collect::<Vec<_>>();
            output.push(normalize_sse_data_line(line));
        }
        output
    }

    fn finish(&mut self) -> Option<Bytes> {
        (!self.pending.is_empty())
            .then(|| normalize_sse_data_line(std::mem::take(&mut self.pending)))
    }
}

fn normalize_sse_data_line(line: Vec<u8>) -> Bytes {
    let (body, newline) = match line.strip_suffix(b"\r\n") {
        Some(body) => (body, b"\r\n".as_slice()),
        None => match line.strip_suffix(b"\n") {
            Some(body) => (body, b"\n".as_slice()),
            None => (line.as_slice(), b"".as_slice()),
        },
    };
    let Some(payload) = body.strip_prefix(b"data:") else {
        return Bytes::from(line);
    };
    let payload = payload.strip_prefix(b" ").unwrap_or(payload);
    let Ok(mut event) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return Bytes::from(line);
    };

    let mut changed = false;
    if let Some(choices) = event
        .get_mut("choices")
        .and_then(serde_json::Value::as_array_mut)
    {
        for choice in choices {
            // Most streamed replies use `delta`; some compatible relays emit a
            // complete `message` object in an SSE record. OpenClaw's MiniMax
            // adapter dereferences either shape before checking for absence.
            for key in ["delta", "message"] {
                let Some(delta) = choice
                    .get_mut(key)
                    .and_then(serde_json::Value::as_object_mut)
                else {
                    continue;
                };
                // OpenClaw's OpenAI and MiniMax adapters read all four fields with
                // `.trim()` in different stream modes. Providers legitimately omit
                // them on role-only and tool-call deltas.
                for field in ["content", "reasoning_content", "reasoning", "refusal"] {
                    if !delta.get(field).is_some_and(serde_json::Value::is_string) {
                        delta.insert(field.to_string(), serde_json::Value::String(String::new()));
                        changed = true;
                    }
                }
            }
        }
    }
    if !changed {
        return Bytes::from(line);
    }

    let Ok(normalized) = serde_json::to_vec(&event) else {
        return Bytes::from(line);
    };
    let mut output = Vec::with_capacity(6 + normalized.len() + newline.len());
    output.extend_from_slice(b"data: ");
    output.extend_from_slice(&normalized);
    output.extend_from_slice(newline);
    Bytes::from(output)
}

#[derive(Clone)]
struct Upstream {
    /// Real metering-proxy base, e.g. `https://x.supabase.co/functions/v1/llm-proxy/v1`.
    base_url: String,
    /// The minted `uniopc_llm_*` bearer token. Memory only — never on disk.
    token: String,
}

static SHARED_SECRET: OnceLock<String> = OnceLock::new();
static PROXY_PORT: Mutex<Option<u16>> = Mutex::new(None);
static UPSTREAM: RwLock<Option<Upstream>> = RwLock::new(None);

// Transparent-refresh coordination (Phase 2). When the upstream 401s a request
// (revoked token), the handler asks JS to re-mint via a Tauri event and blocks
// on this notify until `set_official_upstream` bumps the version — then retries
// the SAME request with the fresh token, so the live turn never dies.
static UPSTREAM_VERSION: AtomicU64 = AtomicU64::new(0);
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Tauri event that asks the JS layer to re-mint the official token (it holds the
/// Supabase session; Rust cannot mint on its own) and call `set_official_upstream`.
const TOKEN_REFRESH_EVENT: &str = "official-model-token-refresh-needed";
/// How long a 401'd request waits for JS to deliver a fresh token before giving
/// up and letting the original 401 surface (JS bootstrap/self-heal still runs).
const REFRESH_WAIT: Duration = Duration::from_millis(12_000);

/// Local loopback shared secret. Placed into config as the provider `apiKey` so
/// config never carries the real token and stays byte-stable across rotations.
/// `start()` restores it from the active Profile when possible, making it stable
/// across both gateway and desktop restarts.
pub fn proxy_shared_secret() -> &'static str {
    SHARED_SECRET.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

fn set_proxy_port(port: u16) {
    *PROXY_PORT.lock().expect("proxy port lock") = Some(port);
}

fn proxy_port() -> Option<u16> {
    *PROXY_PORT.lock().expect("proxy port lock")
}

/// Loopback base the gateway should target, e.g. `http://127.0.0.1:52731/v1`.
/// Mirrors the real mint base's trailing `/v1` so the gateway's path joining
/// (and the minimax normalizer that strips one `/v1`) behave identically to the
/// old direct-to-Supabase setup. `None` until the server has bound a port.
pub fn proxy_base_url() -> Option<String> {
    proxy_port().map(|port| format!("http://127.0.0.1:{port}/v1"))
}

/// Whether an on-disk provider block already targets this process's live
/// proxy. Does not initialize the secret: returning false before `start()` has
/// finished is safer than letting an early status read choose a new secret.
pub fn proxy_config_matches(base_url: &str, api_key: &str) -> bool {
    let Some(current_base_url) = proxy_base_url() else {
        return false;
    };
    let Some(current_secret) = SHARED_SECRET.get() else {
        return false;
    };
    current_base_url.trim_end_matches('/') == base_url.trim().trim_end_matches('/')
        && current_secret == api_key.trim()
}

fn loopback_port_from_base_url(base_url: &str) -> Option<u16> {
    base_url
        .trim()
        .strip_prefix("http://127.0.0.1:")?
        .split('/')
        .next()?
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
}

/// Reuse the previous run's loopback endpoint when possible. The value stored
/// in config is only the local proxy secret (never the real upstream token), so
/// keeping it stable is safe and makes an unchanged Profile byte-stable across
/// desktop launches. If the old port is occupied we fall back to an ephemeral
/// port and the normal repair path patches config once.
fn configured_proxy_candidate() -> Option<(u16, String)> {
    let config = crate::services::openclaw_gateway::load_openclaw_config_for_profile(None).ok()?;
    let provider = config.pointer("/models/providers/uniopc-official")?;
    let port = loopback_port_from_base_url(provider.get("baseUrl")?.as_str()?)?;
    let secret = provider.get("apiKey")?.as_str()?.trim();
    if secret.is_empty() {
        return None;
    }
    Some((port, secret.to_string()))
}

/// Store the real upstream base + token in memory. Called on every connect /
/// re-mint. Rotating the token is just this write — config is untouched, so the
/// gateway never restarts.
pub fn set_official_upstream(base_url: &str, token: &str) {
    {
        let mut guard = UPSTREAM.write().expect("upstream lock");
        *guard = Some(Upstream {
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
        });
    }
    // Bump the version so a request blocked in wait_for_upstream_version_change
    // (polling) picks up the fresh token on its next tick.
    UPSTREAM_VERSION.fetch_add(1, Ordering::SeqCst);
}

/// Store the AppHandle so the proxy can emit the re-mint event. Called once at
/// startup. Without it, transparent refresh is disabled (401s surface as before).
pub fn set_app_handle(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

fn current_upstream_token() -> Option<String> {
    UPSTREAM
        .read()
        .ok()?
        .as_ref()
        .map(|upstream| upstream.token.clone())
        .filter(|token| !token.is_empty())
}

/// Block until the in-memory token version moves off `seen`, or `timeout`
/// elapses. Returns true when a new token became available. Polls rather than
/// using a condvar/Notify: `notify_waiters()` drops notifications with no waiter
/// registered, which raced the re-mint here and left the request waiting the
/// full timeout; a short poll wakes within one interval of the version change.
async fn wait_for_upstream_version_change(seen: u64, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if UPSTREAM_VERSION.load(Ordering::SeqCst) != seen {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

/// Ask JS to re-mint (via the Tauri event) and wait for the fresh token. Returns
/// true when the token changed. False if we can't reach JS or the wait times out.
async fn request_token_refresh_and_wait(seen: u64) -> bool {
    match APP_HANDLE.get() {
        Some(app) => {
            let _ = app.emit(TOKEN_REFRESH_EVENT, ());
        }
        None => return false,
    }
    wait_for_upstream_version_change(seen, REFRESH_WAIT).await
}

/// True once a non-empty token has been injected this session. The in-memory
/// token does NOT survive an app restart, so a fresh process must connect once
/// (mint + `set_official_upstream`) even when config already has the provider.
pub fn official_upstream_ready() -> bool {
    UPSTREAM
        .read()
        .expect("upstream lock")
        .as_ref()
        .map(|upstream| !upstream.token.is_empty())
        .unwrap_or(false)
}

/// Recognize a loopback base as one of ours. Used by the openai/minimax slot
/// detection so a stale/fallback-port baseUrl still counts as "ours" instead
/// of being mistaken for the user's own provider.
pub fn is_uniopc_official_loopback_base_url(base_url: &str) -> bool {
    base_url
        .trim_end_matches('/')
        .starts_with("http://127.0.0.1:")
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Pass upstream redirects (e.g. the video download 302) through to
            // the gateway verbatim instead of following them here.
            .redirect(reqwest::redirect::Policy::none())
            // Reach the official upstream DIRECTLY. reqwest otherwise auto-reads
            // the app's inherited HTTPS_PROXY (a Clash-style local proxy on
            // 127.0.0.1:7890 for overseas access) and routes our forwarded LLM
            // requests to the domestic `*.opentrust.net` Supabase overseas-and-
            // back — measured ~2/3 mid-stream ECONNRESET vs 100% direct. The
            // gateway child gets NO_PROXY for the same reason (openclaw_cli.rs),
            // but that never reached this Rust client, which reads proxy env on
            // its own. The upstream is always the domestic official proxy, so a
            // blanket no_proxy is correct here.
            .no_proxy()
            .build()
            .expect("build official-model proxy http client")
    })
}

/// Build the upstream target URL. The gateway targets `{loopback}/v1` so every
/// inbound path starts with `/v1`; strip that one leading segment and append
/// the rest to the upstream base (which itself ends in `/v1`).
fn build_target_url(upstream_base: &str, path_and_query: &str) -> String {
    let suffix = path_and_query.strip_prefix("/v1").unwrap_or(path_and_query);
    format!("{upstream_base}{suffix}")
}

/// The gateway must present the loopback shared secret (as a Bearer token, or
/// raw) — this keeps other local processes from using our metered upstream.
/// Compared in constant time so the check can't be turned into a timing oracle
/// for the secret (cheap insurance; the loopback threat is already same-user).
fn request_secret_ok(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.strip_prefix("Bearer ").unwrap_or(value).trim())
        .map(|provided| provided.as_bytes().ct_eq(expected.as_bytes()).into())
        .unwrap_or(false)
}

fn error_response(status: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({ "error": { "message": message } }).to_string();
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .expect("build error response")
}

async fn proxy_handler(req: Request) -> Response {
    if !request_secret_ok(req.headers(), proxy_shared_secret()) {
        return error_response(StatusCode::UNAUTHORIZED, "invalid loopback proxy secret");
    }

    let upstream = match UPSTREAM.read().expect("upstream lock").clone() {
        Some(upstream) if !upstream.token.is_empty() => upstream,
        _ => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "uniopc official model not connected yet",
            )
        }
    };

    // Capture the token version alongside the token so a concurrent refresh that
    // lands between here and a 401 is detected (version already moved → retry
    // immediately instead of waiting).
    let seen_version = UPSTREAM_VERSION.load(Ordering::SeqCst);

    let method = req.method().clone();
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| req.uri().path().to_string());
    let target = build_target_url(&upstream.base_url, &path_and_query);

    // Forward the gateway's headers, but drop the ones we set/own: its
    // Authorization carries the loopback secret (replaced with the real token
    // below), and Host must reflect the upstream, not the loopback listener.
    let mut headers = req.headers().clone();
    headers.remove(header::AUTHORIZATION);
    headers.remove(header::HOST);

    let body_bytes = match to_bytes(req.into_body(), MAX_REQUEST_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "request body too large or unreadable",
            )
        }
    };

    // Send, and on an upstream 401 (revoked token) transparently ask JS to
    // re-mint, wait for the fresh token, and retry the SAME request ONCE — so the
    // live turn is never interrupted. `method`/`headers`/`body_bytes` are cloned
    // per attempt (Bytes clone is O(1)); at most two attempts, never a loop.
    let mut token = upstream.token.clone();
    let mut refreshed = false;
    let upstream_res = loop {
        let mut builder = http_client()
            .request(method.clone(), &target)
            .headers(headers.clone())
            .bearer_auth(&token);
        if !body_bytes.is_empty() {
            builder = builder.body(body_bytes.clone());
        }
        let res = match builder.send().await {
            Ok(res) => res,
            Err(error) => {
                return error_response(
                    StatusCode::BAD_GATEWAY,
                    &format!("official model upstream request failed: {error}"),
                )
            }
        };
        if res.status() == StatusCode::UNAUTHORIZED
            && !refreshed
            && request_token_refresh_and_wait(seen_version).await
        {
            if let Some(fresh) = current_upstream_token() {
                token = fresh;
                refreshed = true;
                continue;
            }
        }
        break res;
    };

    let status = upstream_res.status();
    let upstream_headers = upstream_res.headers().clone();
    let mut response = Response::builder().status(status);
    for (name, value) in upstream_headers.iter() {
        // Let the streaming body manage its own framing.
        if name == header::CONTENT_LENGTH
            || name == header::TRANSFER_ENCODING
            || name == header::CONNECTION
        {
            continue;
        }
        response = response.header(name, value);
    }

    let is_chat_stream = path_and_query.starts_with("/v1/chat/completions")
        && upstream_headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("text/event-stream"));
    let response_body = if is_chat_stream {
        let stream = upstream_res.bytes_stream();
        Body::from_stream(futures_util::stream::unfold(
            (stream, SseDeltaNormalizer::default(), VecDeque::new()),
            |(mut stream, mut normalizer, mut ready)| async move {
                loop {
                    if let Some(line) = ready.pop_front() {
                        return Some((
                            Ok::<Bytes, reqwest::Error>(line),
                            (stream, normalizer, ready),
                        ));
                    }
                    match stream.next().await {
                        Some(Ok(chunk)) => ready.extend(normalizer.push(chunk)),
                        Some(Err(error)) => return Some((Err(error), (stream, normalizer, ready))),
                        None => {
                            return normalizer.finish().map(|line| {
                                (
                                    Ok::<Bytes, reqwest::Error>(line),
                                    (stream, normalizer, ready),
                                )
                            });
                        }
                    }
                }
            },
        ))
    } else {
        Body::from_stream(upstream_res.bytes_stream())
    };

    response.body(response_body).unwrap_or_else(|_| {
        error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to build proxied response",
        )
    })
}

/// Bind the loopback server (idempotent) and serve it in the background. Reuses
/// the active Profile's previous loopback port/secret when available; otherwise
/// binds an ephemeral port. Publishes the result via `proxy_base_url()`.
pub async fn start(app: AppHandle) -> Result<(), String> {
    set_app_handle(app);
    if proxy_port().is_some() {
        return Ok(());
    }
    let candidate = configured_proxy_candidate();
    if let Some((_, secret)) = candidate.as_ref() {
        let _ = SHARED_SECRET.set(secret.clone());
    }
    let listener = if let Some((port, _)) = candidate {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!(
                    "[official-model-proxy] previous port {port} unavailable ({error}); using an ephemeral port"
                );
                tokio::net::TcpListener::bind(("127.0.0.1", 0))
                    .await
                    .map_err(|error| format!("bind official-model loopback proxy: {error}"))?
            }
        }
    } else {
        tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("bind official-model loopback proxy: {error}"))?
    };
    let port = listener
        .local_addr()
        .map_err(|error| format!("official-model proxy local_addr: {error}"))?
        .port();
    set_proxy_port(port);
    // Initialize the shared secret up front so config patches and the handler
    // agree on the same value.
    let _ = proxy_shared_secret();

    let app = Router::new().fallback(any(proxy_handler));
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            eprintln!("[official-model-proxy] server exited: {error}");
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_missing_delta_fields_with_formatted_json() {
        let line =
            b"data: { \"choices\": [ { \"delta\": { \"role\": \"assistant\" } } ] }\r\n".to_vec();
        let normalized = normalize_sse_data_line(line);
        let payload = std::str::from_utf8(&normalized)
            .unwrap()
            .trim()
            .strip_prefix("data: ")
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(payload).unwrap();
        let delta = &value["choices"][0]["delta"];
        assert_eq!(delta["content"], "");
        assert_eq!(delta["reasoning_content"], "");
    }

    #[test]
    fn normalizes_missing_message_fields_in_sse_compat_responses() {
        let normalized = normalize_sse_data_line(
            b"data: {\"choices\":[{\"message\":{\"role\":\"assistant\"}}]}\n".to_vec(),
        );
        let payload = std::str::from_utf8(&normalized)
            .unwrap()
            .trim()
            .strip_prefix("data: ")
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(payload).unwrap();
        let message = &value["choices"][0]["message"];
        assert_eq!(message["content"], "");
        assert_eq!(message["refusal"], "");
    }

    #[test]
    fn normalizer_buffers_a_split_sse_line() {
        let mut normalizer = SseDeltaNormalizer::default();
        assert!(normalizer
            .push(Bytes::from_static(
                b"data: {\"choices\":[{\"delta\":{\"role\""
            ))
            .is_empty());
        let output = normalizer.push(Bytes::from_static(b":\"assistant\"}}]}\n"));
        assert_eq!(output.len(), 1);
        let payload = std::str::from_utf8(&output[0])
            .unwrap()
            .trim()
            .strip_prefix("data: ")
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(value["choices"][0]["delta"]["content"], "");
        assert_eq!(value["choices"][0]["delta"]["reasoning_content"], "");
    }

    #[test]
    fn target_url_strips_one_leading_v1_and_appends_to_upstream() {
        let base = "https://x.supabase.co/functions/v1/llm-proxy/v1";
        assert_eq!(
            build_target_url(base, "/v1/chat/completions"),
            "https://x.supabase.co/functions/v1/llm-proxy/v1/chat/completions"
        );
        // minimax normalizer lands on /v1/t2a_v2
        assert_eq!(
            build_target_url(base, "/v1/t2a_v2"),
            "https://x.supabase.co/functions/v1/llm-proxy/v1/t2a_v2"
        );
        // query string is preserved
        assert_eq!(
            build_target_url(base, "/v1/chat/completions?stream=true"),
            "https://x.supabase.co/functions/v1/llm-proxy/v1/chat/completions?stream=true"
        );
    }

    #[test]
    fn loopback_port_parser_only_accepts_the_owned_ipv4_shape() {
        assert_eq!(
            loopback_port_from_base_url("http://127.0.0.1:52731/v1"),
            Some(52731)
        );
        assert_eq!(
            loopback_port_from_base_url("https://example.test:52731/v1"),
            None
        );
        assert_eq!(loopback_port_from_base_url("http://127.0.0.1:0/v1"), None);
    }

    #[test]
    fn secret_check_accepts_bearer_and_raw_rejects_others() {
        let mut bearer = HeaderMap::new();
        bearer.insert(header::AUTHORIZATION, "Bearer sekret".parse().unwrap());
        assert!(request_secret_ok(&bearer, "sekret"));

        let mut raw = HeaderMap::new();
        raw.insert(header::AUTHORIZATION, "sekret".parse().unwrap());
        assert!(request_secret_ok(&raw, "sekret"));

        let mut wrong = HeaderMap::new();
        wrong.insert(header::AUTHORIZATION, "Bearer nope".parse().unwrap());
        assert!(!request_secret_ok(&wrong, "sekret"));

        assert!(!request_secret_ok(&HeaderMap::new(), "sekret"));
    }

    #[test]
    fn loopback_base_url_recognized_across_ports() {
        assert!(is_uniopc_official_loopback_base_url(
            "http://127.0.0.1:52731/v1"
        ));
        assert!(is_uniopc_official_loopback_base_url(
            "http://127.0.0.1:9/v1/"
        ));
        assert!(!is_uniopc_official_loopback_base_url(
            "https://x.supabase.co/functions/v1/llm-proxy/v1"
        ));
        assert!(!is_uniopc_official_loopback_base_url(""));
    }

    #[test]
    fn upstream_ready_reflects_injected_token() {
        set_official_upstream("https://x/llm-proxy/v1", "uniopc_llm_abc");
        assert!(official_upstream_ready());
    }

    #[test]
    fn set_upstream_bumps_version_so_blocked_requests_wake() {
        // The transparent-refresh wait keys on this version moving; injecting a
        // fresh token must advance it. (Only ever increments, so this is robust
        // to concurrent test mutation.)
        let before = UPSTREAM_VERSION.load(Ordering::SeqCst);
        set_official_upstream("https://x/llm-proxy/v1", "uniopc_llm_rotated");
        assert!(UPSTREAM_VERSION.load(Ordering::SeqCst) > before);
    }
}
