use crate::services::openclaw_gateway::GatewayEndpoint;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{process::Stdio, time::Instant};
use tokio::{
    process::{Child, Command},
    sync::Mutex,
};

pub const DEFAULT_REMOTE_GATEWAY_PORT: u16 = 18790;
pub const DEFAULT_SSH_LOCAL_PORT: u16 = 18791;
/// Preferred local gateway port. One machine, one engine: it tries this port
/// first and, if it's occupied (a co-installed OpenClaw on its own default
/// 18789, some other app, or our own orphan before reclaim), falls back to a
/// kernel-assigned free port. Chosen well clear of OpenClaw's default (18789)
/// and below the OS ephemeral range (macOS 49152+, Linux 32768+) so the OS
/// won't transiently grab it. The *actual* bound port lives in
/// `local_gateway_port()` and is recorded in the per-profile endpoint file — it
/// is NEVER written to `openclaw.json` (a `gateway.port` change restarts the
/// gateway); `--port` drives it, so config stays byte-stable.
pub const UNIOPC_ENGINE_PREFERRED_PORT: u16 = 28790;
const CONNECTION_CONNECT_TIMEOUT_SECS: u64 = 3;
const CONNECTION_REQUEST_TIMEOUT_SECS: u64 = 8;

// ── Local gateway basic-auth (single-writer password) ────────────────────────
//
// The local gateway authenticates by password (`--auth password`), single-writer:
// the app mints ONE password per process run and is both the server (passes it to
// the child via `OPENCLAW_GATEWAY_PASSWORD`) and the only client (injects it here
// when resolving the local endpoint). The two can never diverge, so
// `auth_token_mismatch` — the failure mode of the old ed25519 device-auth path —
// is structurally impossible locally.
//
// Crucially the password is NEVER written into the engine's watched config
// (`openclaw.json`): the gateway restarts on any `gateway.auth.password` change,
// so persisting a per-run secret there caused a restart on every launch. Keeping
// it purely in-memory + env means config stays stable and the gateway never
// restarts on our account. Device auth + pairing remain for remote connections.
static LOCAL_GATEWAY_PASSWORD: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// The single per-run password for the local gateway. Stable for the whole app
/// process (survives gateway child restart), so the spawned server and the
/// desktop client always agree.
pub fn local_gateway_password() -> &'static str {
    LOCAL_GATEWAY_PASSWORD.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

// ── Local gateway port (dynamic, single-engine) ──────────────────────────────
//
// One engine runs at a time. It binds `UNIOPC_ENGINE_PREFERRED_PORT` when free,
// otherwise a kernel-assigned free port. Whatever it bound is the single source
// of truth for every local endpoint resolver (they read `local_gateway_port()`),
// and is persisted per-profile (`gateway-endpoint.json`) so a crashed app's
// orphan engine can be reclaimed by pid on the next launch — and so two engines
// never end up writing the same `state/<profile>` dir. The port is NEVER written
// to `openclaw.json`; `--port` drives it, keeping config byte-stable.
static LOCAL_GATEWAY_PORT: std::sync::Mutex<Option<u16>> = std::sync::Mutex::new(None);

/// The port the currently-running local engine bound, or the preferred port
/// before the first spawn. Every local endpoint URL is built from this.
pub fn local_gateway_port() -> u16 {
    LOCAL_GATEWAY_PORT
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .unwrap_or(UNIOPC_ENGINE_PREFERRED_PORT)
}

/// Record the port the engine child actually bound (called right after spawn).
pub fn set_local_gateway_port(port: u16) {
    if let Ok(mut guard) = LOCAL_GATEWAY_PORT.lock() {
        *guard = Some(port);
    }
}

/// Pick a port for a fresh engine: the preferred port if free, else a
/// kernel-assigned free one (`bind(:0)` never fails to find one). Probe-binds
/// then drops the listener, so there is a tiny window before the child binds —
/// the caller retries on the rare EADDRINUSE.
pub fn pick_local_gateway_port() -> u16 {
    use std::net::TcpListener;
    if TcpListener::bind(("127.0.0.1", UNIOPC_ENGINE_PREFERRED_PORT)).is_ok() {
        return UNIOPC_ENGINE_PREFERRED_PORT;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
        .unwrap_or(UNIOPC_ENGINE_PREFERRED_PORT)
}

/// Per-profile record of the running engine — its bound port and child pid.
/// Written on spawn, read on the next launch to reclaim an orphan (by pid) and
/// to let external `openclaw` CLIs discover the port without guessing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayEndpointRecord {
    pub profile_key: String,
    pub port: u16,
    pub pid: u32,
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub parent_pid: u32,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub process_created_at: Option<String>,
    pub created_at: String,
}

pub fn gateway_owner_instance_id() -> Result<String, String> {
    let path = crate::services::uniopc_runtime_paths::uniopc_data_dir()?
        .join("gateway-owner-instance-id");
    if let Ok(value) = std::fs::read_to_string(&path) {
        let value = value.trim();
        if !value.is_empty() {
            return Ok(value.to_string());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let value = uuid::Uuid::new_v4().to_string();
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(value.as_bytes()).map_err(|error| error.to_string())?;
            Ok(value)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            for _ in 0..10 {
                if let Ok(value) = std::fs::read_to_string(&path) {
                    let value = value.trim();
                    if !value.is_empty() {
                        return Ok(value.to_string());
                    }
                }
                std::thread::yield_now();
            }
            Err("gateway owner instance id is empty".to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn gateway_endpoint_file_path(profile: Option<&str>) -> Result<std::path::PathBuf, String> {
    // Same resolution the engine's own OPENCLAW_STATE_DIR uses (active profile
    // when unspecified), so the record lands beside the state it describes.
    Ok(
        crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(profile)?
            .join("gateway-endpoint.json"),
    )
}

/// Persist the running engine's port + pid for `profile`.
pub fn write_gateway_endpoint_record(
    profile: Option<&str>,
    port: u16,
    pid: u32,
    generation: u64,
    process_created_at: Option<String>,
) {
    // Record the concrete profile this engine serves. `None` means "the active
    // profile" (same resolution as the file's directory), so resolve it rather
    // than storing an empty key.
    let profile_key = crate::services::uniopc_runtime_paths::resolve_profile_key(profile);
    let Ok(instance_id) = gateway_owner_instance_id() else {
        return;
    };
    let record = GatewayEndpointRecord {
        profile_key,
        port,
        pid,
        generation,
        parent_pid: std::process::id(),
        instance_id: Some(instance_id),
        process_created_at,
        created_at: Utc::now().to_rfc3339(),
    };
    if let (Ok(path), Ok(json)) = (
        gateway_endpoint_file_path(profile),
        serde_json::to_string_pretty(&record),
    ) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, json);
    }
}

/// Read the last-recorded engine endpoint for `profile` (None if absent/corrupt).
pub fn read_gateway_endpoint_record(profile: Option<&str>) -> Option<GatewayEndpointRecord> {
    let path = gateway_endpoint_file_path(profile).ok()?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn classify_endpoint_metadata(
    metadata: Result<(), std::io::Error>,
    description: &str,
) -> Result<bool, String> {
    match metadata {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法读取 {description}: {error}")),
    }
}

fn endpoint_path_exists(path: &std::path::Path, description: &str) -> Result<bool, String> {
    classify_endpoint_metadata(std::fs::symlink_metadata(path).map(|_| ()), description)
}

/// Discover endpoint records left by every Uniopc profile. The directory name
/// must agree with the record's profile key; a copied, corrupt, or foreign file
/// is ignored rather than becoming a process-termination candidate.
pub(crate) fn gateway_endpoint_records_under(
    state_base: &std::path::Path,
) -> Result<Vec<GatewayEndpointRecord>, String> {
    if !endpoint_path_exists(state_base, "Gateway endpoint state root")? {
        return Ok(Vec::new());
    }
    let canonical_root = std::fs::canonicalize(state_base)
        .map_err(|error| format!("无法验证 Gateway endpoint state root: {error}"))?;
    let entries = std::fs::read_dir(&canonical_root)
        .map_err(|error| format!("无法枚举 Gateway endpoint records: {error}"))?;
    let mut records = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取 Gateway endpoint entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取 Gateway endpoint entry metadata: {error}"))?;
        if !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }
        let profile_dir = std::fs::canonicalize(entry.path())
            .map_err(|error| format!("无法验证 Gateway endpoint profile path: {error}"))?;
        if !canonical_path_is_within_root(&canonical_root, &profile_dir)? {
            return Err("Gateway endpoint profile path escapes state root".to_string());
        }
        if !std::fs::metadata(&profile_dir)
            .map_err(|error| format!("无法读取 Gateway endpoint profile metadata: {error}"))?
            .is_dir()
        {
            continue;
        }
        let endpoint = profile_dir.join("gateway-endpoint.json");
        if !endpoint_path_exists(&endpoint, "Gateway endpoint record metadata")? {
            continue;
        }
        let endpoint = std::fs::canonicalize(endpoint)
            .map_err(|error| format!("无法验证 Gateway endpoint record path: {error}"))?;
        if !canonical_path_is_within_root(&profile_dir, &endpoint)? {
            return Err("Gateway endpoint record path escapes profile directory".to_string());
        }
        let bytes = std::fs::read(&endpoint)
            .map_err(|error| format!("无法读取 Gateway endpoint record: {error}"))?;
        let record: GatewayEndpointRecord = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Gateway endpoint record 格式无效: {error}"))?;
        let directory_key = entry.file_name().to_string_lossy().into_owned();
        if record.profile_key != directory_key {
            return Err("Gateway endpoint record profile 与目录不一致".to_string());
        }
        records.push(record);
    }
    Ok(records)
}

fn canonical_path_is_within_root(
    root: &std::path::Path,
    candidate: &std::path::Path,
) -> Result<bool, String> {
    let root = std::fs::canonicalize(root).map_err(|error| error.to_string())?;
    let candidate = std::fs::canonicalize(candidate).map_err(|error| error.to_string())?;
    Ok(candidate.starts_with(root))
}

pub(crate) fn all_gateway_endpoint_records() -> Result<Vec<GatewayEndpointRecord>, String> {
    crate::services::uniopc_runtime_paths::state_v8_base_dir()
        .and_then(|base| gateway_endpoint_records_under(&base))
}

pub(crate) fn gateway_orphan_reclaim_scope(
    records: Vec<GatewayEndpointRecord>,
    _starting_profile: &str,
) -> Vec<GatewayEndpointRecord> {
    // The engine is machine-singleton, so a crash record from profile A stays
    // relevant when the next desktop session starts profile B.
    records
}

/// Drop the endpoint record for `profile` (called when we stop our own engine).
pub fn clear_gateway_endpoint_record(profile: Option<&str>) {
    if let Ok(path) = gateway_endpoint_file_path(profile) {
        let _ = std::fs::remove_file(path);
    }
}

/// The gateway's own singleton lock, written by the engine itself on startup:
/// `<state-dir>/tmp/uniopc-<uid>/gateway.<sha8(configPath)>.lock` containing
/// `{pid, createdAt, configPath}`. Unlike our `gateway-endpoint.json` (written
/// by the spawner) this is engine-authored ground truth, and `configPath`
/// pins it to one profile's state dir — immune to the Node process-title
/// rewrite that blinds `ps`-based ownership checks.
#[derive(Debug, Clone, Deserialize)]
pub struct OfficialGatewayLock {
    pub pid: u32,
    #[serde(rename = "configPath")]
    pub config_path: String,
    #[serde(rename = "createdAt", default)]
    #[allow(dead_code)]
    pub created_at: Option<String>,
}

/// `gateway.<sha8>.lock` — first 8 hex chars of SHA-256 over the exact config
/// path string, mirroring the engine's `resolveGatewayLockPath`.
fn official_gateway_lock_file_name(config_path: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = hex::encode(Sha256::digest(config_path.as_bytes()));
    format!("gateway.{}.lock", &digest[..8])
}

fn official_gateway_lock_path(profile: Option<&str>) -> Result<std::path::PathBuf, String> {
    let config_path =
        crate::services::openclaw_gateway::openclaw_config_path_for_profile(profile)?;
    let config_str = config_path.to_string_lossy();
    // Engine-side: state-dir/tmp/uniopc-<uid> on unix, bare "uniopc" where
    // process.getuid is unavailable (Windows). Use the state dir owner UID.
    let state_dir = crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(profile)
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let dir_name = {
        use std::os::unix::fs::MetadataExt;
        let uid = std::fs::metadata(&state_dir).ok()
            .map(|meta| meta.uid());
        match uid {
            Some(uid) => format!("uniopc-{uid}"),
            None => "uniopc".to_string(),
        }
    };
    #[cfg(not(unix))]
    let dir_name = "uniopc".to_string();
    Ok(state_dir.join("tmp")
        .join(dir_name)
        .join(official_gateway_lock_file_name(&config_str)))
}

/// Read the engine-authored lock for `profile`, returning it only when its
/// `configPath` matches that profile's config file — i.e. when the recorded
/// pid provably belongs to an engine serving OUR state dir. `None` on
/// absent/corrupt lock or a path mismatch (foreign gateway).
pub fn read_official_gateway_lock(profile: Option<&str>) -> Option<OfficialGatewayLock> {
    let lock_path = official_gateway_lock_path(profile).ok()?;
    let expected_config =
        crate::services::openclaw_gateway::openclaw_config_path_for_profile(profile).ok()?;
    let bytes = std::fs::read(lock_path).ok()?;
    let lock: OfficialGatewayLock = serde_json::from_slice(&bytes).ok()?;
    if lock.config_path == expected_config.to_string_lossy() {
        Some(lock)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GatewayConnectionMode {
    NotConfigured,
    Local,
    RemoteDirect,
    RemoteSshTunnel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GatewayConnectionStatus {
    Disconnected,
    Resolving,
    Starting,
    Connecting,
    Connected,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayConnectionConfig {
    pub profile: String,
    pub mode: GatewayConnectionMode,
    pub local_port: u16,
    pub remote_url: Option<String>,
    pub ssh_target: Option<String>,
    pub ssh_remote_host: String,
    pub ssh_remote_port: u16,
    pub ssh_local_port: u16,
    pub auth_token: Option<String>,
    pub auth_password: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConnectionEndpoint {
    pub endpoint: GatewayEndpoint,
    pub dashboard_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    pub user_host: String,
    pub port: Option<u16>,
}

pub struct GatewayTunnelSupervisor {
    child: Mutex<Option<Child>>,
    signature: Mutex<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConnectionSnapshot {
    pub profile: String,
    pub mode: GatewayConnectionMode,
    pub status: GatewayConnectionStatus,
    pub endpoint_url: Option<String>,
    pub dashboard_url: Option<String>,
    pub ping: Option<String>,
    pub has_auth_token: bool,
    pub has_auth_password: bool,
    pub auth_token_preview: Option<String>,
    pub auth_password_preview: Option<String>,
    pub tunnel_state: Option<String>,
    pub message: String,
    pub last_error: Option<String>,
    /// Structured classification of `last_error` — the machine-readable
    /// contract for UI decisions (circuit breakers, repair hints). Values:
    /// [`GATEWAY_ERROR_CODE_AUTH_TOKEN_MISMATCH`],
    /// [`GATEWAY_ERROR_CODE_AUTH_TOKEN_MISSING`],
    /// [`GATEWAY_ERROR_CODE_AUTH_UNAUTHORIZED`]. Frontends must branch on
    /// this code, never on `last_error` text.
    pub last_error_code: Option<String>,
    pub updated_at: DateTime<Utc>,
}

/// Gateway rejected our token outright (token exists but does not match).
/// Remote credentials require user action; local credentials are app-owned and
/// `openclaw_connection_start_local` repairs them by reclaiming/re-provisioning.
pub const GATEWAY_ERROR_CODE_AUTH_TOKEN_MISMATCH: &str = "auth_token_mismatch";
/// Token or device identity is missing — repairable by re-provisioning
/// (`openclaw_connection_start_local` runs the pairing/provision flow).
pub const GATEWAY_ERROR_CODE_AUTH_TOKEN_MISSING: &str = "auth_token_missing";
/// Bare unauthorized response with no more specific cause.
pub const GATEWAY_ERROR_CODE_AUTH_UNAUTHORIZED: &str = "auth_unauthorized";

/// Single source of truth mapping gateway probe error text to a structured
/// code. Only ever applied to `GatewayConnectionSnapshot.last_error` (gateway
/// health-probe context), so keywords like "unauthorized" cannot be confused
/// with unrelated cloud/API 401 messages.
pub fn classify_gateway_connection_error(error: Option<&str>) -> Option<String> {
    let normalized = error?.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if normalized.contains("token_mismatch")
        || normalized.contains("token mismatch")
        || normalized.contains("auth-mismatch")
        || normalized.contains("gateway auth token")
    {
        return Some(GATEWAY_ERROR_CODE_AUTH_TOKEN_MISMATCH.to_string());
    }
    if normalized.contains("gateway token missing")
        || normalized.contains("device identity required")
        || normalized.contains("auth token missing")
    {
        return Some(GATEWAY_ERROR_CODE_AUTH_TOKEN_MISSING.to_string());
    }
    if normalized.contains("unauthorized") {
        return Some(GATEWAY_ERROR_CODE_AUTH_UNAUTHORIZED.to_string());
    }
    None
}

impl GatewayConnectionConfig {
    pub fn not_configured(profile: String) -> Self {
        Self {
            profile,
            mode: GatewayConnectionMode::NotConfigured,
            local_port: 0,
            remote_url: None,
            ssh_target: None,
            ssh_remote_host: "127.0.0.1".to_string(),
            ssh_remote_port: DEFAULT_REMOTE_GATEWAY_PORT,
            ssh_local_port: DEFAULT_SSH_LOCAL_PORT,
            auth_token: None,
            auth_password: None,
            updated_at: Utc::now(),
        }
    }

    pub fn local(profile: String, local_port: u16) -> Self {
        Self {
            mode: GatewayConnectionMode::Local,
            local_port,
            // Basic-auth single-writer: local always authenticates by the per-run
            // password, never a token/device identity.
            auth_password: Some(local_gateway_password().to_string()),
            ..Self::not_configured(profile)
        }
    }

    pub fn local_for_profile(profile: String) -> Self {
        let local_port = local_gateway_port_for_profile(&profile);
        Self::local(profile, local_port)
    }
}

impl Default for GatewayTunnelSupervisor {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            signature: Mutex::new(None),
        }
    }
}

impl GatewayTunnelSupervisor {
    pub async fn ensure(&self, config: &GatewayConnectionConfig) -> Result<(), String> {
        let args = ssh_tunnel_args(config)?;
        let next_signature = args.join("\u{1f}");
        let mut signature = self.signature.lock().await;
        let mut child_guard = self.child.lock().await;
        if signature.as_deref() == Some(next_signature.as_str()) {
            if let Some(child) = child_guard.as_mut() {
                if child
                    .try_wait()
                    .map_err(|e| format!("检查 SSH tunnel 失败: {e}"))?
                    .is_none()
                {
                    return Ok(());
                }
            }
        }
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill().await;
        }
        let child = Command::new("ssh")
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 SSH tunnel 失败: {e}"))?;
        *child_guard = Some(child);
        *signature = Some(next_signature);
        Ok(())
    }

    pub async fn stop(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
        *self.signature.lock().await = None;
    }
}

impl GatewayConnectionSnapshot {
    pub fn from_config(
        config: &GatewayConnectionConfig,
        status: GatewayConnectionStatus,
        ping: Option<String>,
        last_error: Option<String>,
    ) -> Self {
        let endpoint = resolve_connection_endpoint(config).ok();
        let message = connection_status_message(config.mode, status, last_error.as_deref());
        let last_error_code = classify_gateway_connection_error(last_error.as_deref());
        Self {
            profile: config.profile.clone(),
            mode: config.mode,
            status,
            endpoint_url: endpoint.as_ref().map(|value| value.endpoint.url.clone()),
            dashboard_url: endpoint.and_then(|value| value.dashboard_url),
            ping,
            has_auth_token: config
                .auth_token
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty()),
            has_auth_password: config
                .auth_password
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty()),
            auth_token_preview: config.auth_token.as_ref().map(|_| "configured".to_string()),
            auth_password_preview: config
                .auth_password
                .as_ref()
                .map(|_| "configured".to_string()),
            tunnel_state: None,
            message,
            last_error,
            last_error_code,
            updated_at: Utc::now(),
        }
    }
}

fn connection_status_message(
    mode: GatewayConnectionMode,
    status: GatewayConnectionStatus,
    error: Option<&str>,
) -> String {
    if let Some(error) = error.filter(|value| !value.trim().is_empty()) {
        return error.to_string();
    }
    match (mode, status) {
        (GatewayConnectionMode::NotConfigured, _) => "Gateway Connection 尚未配置。".to_string(),
        (_, GatewayConnectionStatus::Connected) => "Gateway control channel 已连接。".to_string(),
        (_, GatewayConnectionStatus::Degraded) => {
            "Gateway 已发现，但健康检查未完全通过。".to_string()
        }
        (_, GatewayConnectionStatus::Unavailable) => "Gateway 当前不可用。".to_string(),
        (_, GatewayConnectionStatus::Starting) => "正在启动 Gateway。".to_string(),
        (_, GatewayConnectionStatus::Connecting) => "正在连接 Gateway。".to_string(),
        (_, GatewayConnectionStatus::Resolving) => "正在解析 Gateway endpoint。".to_string(),
        (_, GatewayConnectionStatus::Disconnected) => {
            "Gateway control channel 未连接。".to_string()
        }
    }
}

pub fn normalize_profile(profile: Option<&str>) -> String {
    profile
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("")
        .to_string()
}

pub fn require_profile(profile: Option<&str>) -> Result<String, String> {
    // The local engine always runs as the default profile; a cloud-assigned
    // profile name is accepted but no longer required for local addressing.
    Ok(normalize_profile(profile))
}

pub fn local_gateway_port_for_profile(_profile: &str) -> u16 {
    // One engine at a time: the local port is whatever the running engine bound
    // (preferred port, or a free fallback if it was taken) — not a per-profile
    // shard. Every local resolver reads this so they agree by construction.
    local_gateway_port()
}

pub fn normalize_gateway_ws_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Gateway URL 不能为空。".to_string());
    }
    if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        return Ok(trimmed.to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("http://") {
        return Ok(format!("ws://{rest}"));
    }
    if let Some(rest) = trimmed.strip_prefix("https://") {
        return Ok(format!("wss://{rest}"));
    }
    Err("Gateway URL 需要使用 ws/wss/http/https。".to_string())
}

fn normalize_remote_direct_gateway_ws_url(input: &str) -> Result<String, String> {
    let url = normalize_gateway_ws_url(input)?;
    if is_public_plaintext_gateway_url(&url) {
        return Err("Remote Direct Gateway URL 使用公网地址时必须使用 wss://。".to_string());
    }
    Ok(url)
}

fn is_public_plaintext_gateway_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "ws" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return true;
    };
    !is_private_or_loopback_gateway_host(host)
}

fn is_private_or_loopback_gateway_host(host: &str) -> bool {
    let value = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    if value.is_empty() {
        return false;
    }
    if value == "localhost" || value == "::1" || value == "0:0:0:0:0:0:0:1" {
        return true;
    }
    if value.ends_with(".local") {
        return true;
    }
    if value.contains(':')
        && (value.starts_with("fe80:") || value.starts_with("fc") || value.starts_with("fd"))
    {
        return true;
    }
    let octets = value
        .split('.')
        .map(str::parse::<u8>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(octets) = octets else {
        return false;
    };
    if octets.len() != 4 {
        return false;
    }
    matches!(
        (octets[0], octets[1]),
        (10, _) | (127, _) | (169, 254) | (172, 16..=31) | (192, 168) | (100, 64..=127)
    )
}

pub fn parse_ssh_target(input: &str) -> Result<SshTarget, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("SSH target 不能为空。".to_string());
    }
    if trimmed.chars().any(|ch| {
        ch.is_whitespace() || matches!(ch, '\'' | '"' | ';' | '&' | '|' | '`' | '$' | '<' | '>')
    }) {
        return Err("SSH target 只能包含 user@host[:port]，不能包含 shell 参数。".to_string());
    }
    // Reject a leading dash so the value can never be parsed by `ssh` as an
    // option (e.g. `-oProxyCommand=…`, `-F/attacker/config`). The metachar guard
    // above misses this: `-oProxyCommand=/tmp/x@h` has no space and contains `@`,
    // so it would otherwise pass and land in the host argv slot while ssh's option
    // scanner is still active. `ssh_tunnel_args` also pushes a literal `--` guard.
    if trimmed.starts_with('-') {
        return Err("SSH target 不能以 - 开头。".to_string());
    }
    let Some(at_index) = trimmed.find('@') else {
        return Err("SSH target 需要形如 user@host[:port]。".to_string());
    };
    if at_index == 0 || at_index + 1 >= trimmed.len() {
        return Err("SSH target 缺少 user 或 host。".to_string());
    }
    let (user_host, port) = match trimmed.rsplit_once(':') {
        Some((left, right)) if !right.is_empty() && right.chars().all(|ch| ch.is_ascii_digit()) => {
            let port = right
                .parse::<u16>()
                .map_err(|_| "SSH port 超出范围。".to_string())?;
            (left.to_string(), Some(port))
        }
        _ => (trimmed.to_string(), None),
    };
    Ok(SshTarget { user_host, port })
}

pub fn ssh_tunnel_args(config: &GatewayConnectionConfig) -> Result<Vec<String>, String> {
    let target = parse_ssh_target(config.ssh_target.as_deref().unwrap_or_default())?;
    let mut args = vec![
        "-N".to_string(),
        "-L".to_string(),
        format!(
            "{}:{}:{}",
            config.ssh_local_port, config.ssh_remote_host, config.ssh_remote_port
        ),
    ];
    if let Some(port) = target.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    // End option parsing before the host so it can never be read as a flag.
    args.push("--".to_string());
    args.push(target.user_host);
    Ok(args)
}

pub fn resolve_connection_endpoint(
    config: &GatewayConnectionConfig,
) -> Result<ResolvedConnectionEndpoint, String> {
    match config.mode {
        GatewayConnectionMode::NotConfigured => Err("Gateway Connection 尚未配置。".to_string()),
        GatewayConnectionMode::Local => Ok(ResolvedConnectionEndpoint {
            endpoint: GatewayEndpoint {
                // The engine runs on the port it actually bound this run (dynamic:
                // preferred, or a free fallback), held in `local_gateway_port()` —
                // never a stale port from config.
                url: format!("ws://127.0.0.1:{}", local_gateway_port()),
                // Local is basic-auth single-writer: never a token/device identity
                // (those belong to remote/pairing). Carrying a stray token here
                // used to flip `endpoint_is_basic_auth` false → device-auth on the
                // password-mode gateway → password_missing/device-required.
                token: None,
                password: config.auth_password.clone(),
                device_token: None,
            },
            dashboard_url: Some(format!("http://127.0.0.1:{}/", local_gateway_port())),
        }),
        GatewayConnectionMode::RemoteDirect => Ok(ResolvedConnectionEndpoint {
            endpoint: GatewayEndpoint {
                url: normalize_gateway_ws_url(config.remote_url.as_deref().unwrap_or_default())?,
                token: config.auth_token.clone(),
                password: config.auth_password.clone(),
                device_token: None,
            },
            dashboard_url: None,
        }),
        GatewayConnectionMode::RemoteSshTunnel => {
            parse_ssh_target(config.ssh_target.as_deref().unwrap_or_default())?;
            Ok(ResolvedConnectionEndpoint {
                endpoint: GatewayEndpoint {
                    url: format!("ws://127.0.0.1:{}", config.ssh_local_port),
                    token: config.auth_token.clone(),
                    password: config.auth_password.clone(),
                    device_token: None,
                },
                dashboard_url: Some(format!("http://127.0.0.1:{}/", config.ssh_local_port)),
            })
        }
    }
}

pub fn resolve_effective_connection_endpoint(
    default_config: &GatewayConnectionConfig,
    openclaw_config: Option<&Value>,
    ssh_tunnel_port: Option<u16>,
) -> Result<ResolvedConnectionEndpoint, String> {
    if let Some(openclaw_config) = openclaw_config {
        if let Ok(endpoint) = resolve_effective_connection_endpoint_from_openclaw_config(
            &default_config.profile,
            openclaw_config,
            ssh_tunnel_port,
        ) {
            return Ok(endpoint);
        }
    }
    resolve_connection_endpoint(default_config)
}

pub fn effective_connection_config_from_openclaw_config(
    default_config: &GatewayConnectionConfig,
    config: &Value,
) -> Result<GatewayConnectionConfig, String> {
    let gateway = config.get("gateway").unwrap_or(&Value::Null);
    let remote = gateway.get("remote").unwrap_or(&Value::Null);
    let mode = gateway
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_lowercase();
    let remote_url = remote
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if mode == "remote" || remote_url.is_some() {
        let transport = remote
            .get("transport")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_lowercase();
        let mut config = GatewayConnectionConfig::not_configured(default_config.profile.clone());
        config.auth_token = gateway_secret(remote, "token");
        config.auth_password = gateway_secret(remote, "password");
        if transport == "ssh" {
            config.mode = GatewayConnectionMode::RemoteSshTunnel;
            config.remote_url = remote_url.map(str::to_string);
            config.ssh_target = gateway_secret(remote, "sshTarget");
            config.ssh_remote_host = remote_url
                .and_then(host_from_gateway_ws_url)
                .unwrap_or_else(|| default_config.ssh_remote_host.clone());
            config.ssh_remote_port = remote
                .get("remotePort")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .or_else(|| remote_url.and_then(port_from_gateway_ws_url))
                .unwrap_or(default_config.ssh_remote_port);
            config.ssh_local_port = remote_url
                .filter(|url| is_loopback_gateway_url(url))
                .and_then(port_from_gateway_ws_url)
                .unwrap_or(default_config.ssh_local_port);
            return Ok(config);
        }

        config.mode = GatewayConnectionMode::RemoteDirect;
        config.remote_url = remote_url
            .map(normalize_remote_direct_gateway_ws_url)
            .transpose()?;
        return Ok(config);
    }

    if mode == "local" || gateway.is_object() {
        // Local is basic-auth single-writer: `local()` already set the per-run
        // password; config/env auth is intentionally ignored for local.
        let config = GatewayConnectionConfig::local(
            default_config.profile.clone(),
            gateway
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .filter(|value| *value > 0)
                .unwrap_or_else(|| local_gateway_port_for_profile(&default_config.profile)),
        );
        return Ok(config);
    }

    Err("Uniopc 引擎 config 尚未配置。".to_string())
}

pub fn resolve_effective_connection_endpoint_from_openclaw_config(
    profile: &str,
    config: &Value,
    ssh_tunnel_port: Option<u16>,
) -> Result<ResolvedConnectionEndpoint, String> {
    let gateway = config.get("gateway").unwrap_or(&Value::Null);
    let mode = gateway
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_lowercase();
    let remote = gateway.get("remote").unwrap_or(&Value::Null);
    let remote_url = remote
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if mode == "remote" || remote_url.is_some() {
        return resolve_remote_endpoint_from_openclaw_config(remote, remote_url, ssh_tunnel_port);
    }

    if mode == "local" || gateway.is_object() {
        // Ignore any port baked into openclaw.json: the engine runs on whatever
        // port it actually bound this run (preferred, or a free fallback), which
        // is what `local_gateway_port_for_profile` returns. Config never drives
        // the local port — we don't write `gateway.port` — so a stale value there
        // must not steer us.
        let port = local_gateway_port_for_profile(profile);
        // Local is basic-auth single-writer: always the per-run password, never a
        // config/env token or device token (those belong to remote / pairing).
        // The password is deliberately NOT sourced from `openclaw.json` — it is
        // never written there, so the gateway can't restart on a config change.
        return Ok(ResolvedConnectionEndpoint {
            endpoint: GatewayEndpoint {
                url: format!("ws://127.0.0.1:{port}"),
                token: None,
                password: Some(local_gateway_password().to_string()),
                device_token: None,
            },
            dashboard_url: Some(format!("http://127.0.0.1:{port}/")),
        });
    }

    Err("Uniopc 引擎 config 尚未配置。".to_string())
}

fn resolve_remote_endpoint_from_openclaw_config(
    remote: &Value,
    remote_url: Option<&str>,
    ssh_tunnel_port: Option<u16>,
) -> Result<ResolvedConnectionEndpoint, String> {
    let transport = remote
        .get("transport")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_lowercase();
    let token = env_secret("OPENCLAW_GATEWAY_TOKEN").or_else(|| gateway_secret(remote, "token"));
    let password =
        env_secret("OPENCLAW_GATEWAY_PASSWORD").or_else(|| gateway_secret(remote, "password"));
    let device_token = gateway_secret(remote, "deviceToken");

    if transport == "direct" {
        let url = remote_url
            .ok_or_else(|| "gateway.remote.url missing or invalid for direct transport".to_string())
            .and_then(normalize_remote_direct_gateway_ws_url)?;
        return Ok(ResolvedConnectionEndpoint {
            endpoint: GatewayEndpoint {
                url,
                token,
                password,
                device_token,
            },
            dashboard_url: None,
        });
    }

    if transport == "ssh" {
        let local_port = ssh_tunnel_port
            .or_else(|| remote_url.and_then(port_from_gateway_ws_url))
            .unwrap_or(DEFAULT_SSH_LOCAL_PORT);
        return Ok(ResolvedConnectionEndpoint {
            endpoint: GatewayEndpoint {
                url: format!("ws://127.0.0.1:{local_port}"),
                token,
                password,
                device_token,
            },
            dashboard_url: Some(format!("http://127.0.0.1:{local_port}/")),
        });
    }

    if let Some(remote_url) = remote_url {
        let url = normalize_gateway_ws_url(remote_url)?;
        return Ok(ResolvedConnectionEndpoint {
            endpoint: GatewayEndpoint {
                url,
                token,
                password,
                device_token,
            },
            dashboard_url: None,
        });
    }

    Err("gateway.remote.url missing or invalid".to_string())
}

fn gateway_secret(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn env_secret(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn port_from_gateway_ws_url(url: &str) -> Option<u16> {
    let without_scheme = url
        .trim()
        .strip_prefix("ws://")
        .or_else(|| url.trim().strip_prefix("wss://"))
        .unwrap_or_else(|| url.trim());
    without_scheme
        .split('/')
        .next()
        .unwrap_or_default()
        .rsplit(':')
        .next()
        .unwrap_or_default()
        .parse::<u16>()
        .ok()
}

fn host_from_gateway_ws_url(url: &str) -> Option<String> {
    let without_scheme = url
        .trim()
        .strip_prefix("ws://")
        .or_else(|| url.trim().strip_prefix("wss://"))
        .unwrap_or_else(|| url.trim());
    let host_port = without_scheme.split('/').next().unwrap_or_default();
    let host = host_port
        .rsplit_once(':')
        .map(|(host, _port)| host)
        .unwrap_or(host_port)
        .trim()
        .trim_matches('[')
        .trim_matches(']');
    (!host.is_empty()).then(|| host.to_string())
}

fn is_loopback_gateway_url(url: &str) -> bool {
    host_from_gateway_ws_url(url)
        .map(|host| matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1"))
        .unwrap_or(false)
}

pub async fn probe_connection_snapshot(
    config: &GatewayConnectionConfig,
) -> GatewayConnectionSnapshot {
    if config.mode == GatewayConnectionMode::NotConfigured {
        return GatewayConnectionSnapshot::from_config(
            config,
            GatewayConnectionStatus::Disconnected,
            None,
            None,
        );
    }
    let resolved = match resolve_connection_endpoint(config) {
        Ok(value) => value,
        Err(error) => {
            return GatewayConnectionSnapshot::from_config(
                config,
                GatewayConnectionStatus::Unavailable,
                None,
                Some(error),
            )
        }
    };
    let started = Instant::now();
    match crate::services::openclaw_gateway::request_json_for_endpoint(
        &resolved.endpoint,
        "health",
        json!({}),
        false,
        CONNECTION_CONNECT_TIMEOUT_SECS,
        CONNECTION_REQUEST_TIMEOUT_SECS,
    )
    .await
    {
        Ok(value)
            if value
                .get("ok")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true) =>
        {
            GatewayConnectionSnapshot::from_config(
                config,
                GatewayConnectionStatus::Connected,
                Some(format!("{} ms", started.elapsed().as_millis())),
                None,
            )
        }
        Ok(value) => GatewayConnectionSnapshot::from_config(
            config,
            GatewayConnectionStatus::Degraded,
            Some(format!("{} ms", started.elapsed().as_millis())),
            Some(format!("Gateway health 非 ok: {value}")),
        ),
        Err(error) => GatewayConnectionSnapshot::from_config(
            config,
            GatewayConnectionStatus::Unavailable,
            None,
            Some(error),
        ),
    }
}

pub async fn probe_effective_connection_snapshot(
    app: &tauri::AppHandle,
    default_config: &GatewayConnectionConfig,
    openclaw_config: Option<&Value>,
) -> GatewayConnectionSnapshot {
    let effective_config = openclaw_config
        .and_then(|config| {
            effective_connection_config_from_openclaw_config(default_config, config).ok()
        })
        .unwrap_or_else(|| default_config.clone());
    if effective_config.mode == GatewayConnectionMode::NotConfigured {
        return GatewayConnectionSnapshot::from_config(
            &effective_config,
            GatewayConnectionStatus::Disconnected,
            None,
            None,
        );
    }
    let resolved =
        match resolve_effective_connection_endpoint(&effective_config, openclaw_config, None) {
            Ok(value) => value,
            Err(error) => {
                return GatewayConnectionSnapshot::from_config(
                    &effective_config,
                    GatewayConnectionStatus::Unavailable,
                    None,
                    Some(error),
                )
            }
        };
    let started = Instant::now();
    match crate::services::openclaw_gateway::request_json_for_endpoint_with_device_auth(
        app,
        &resolved.endpoint,
        "health",
        json!({}),
        false,
        CONNECTION_CONNECT_TIMEOUT_SECS,
        CONNECTION_REQUEST_TIMEOUT_SECS,
    )
    .await
    {
        Ok(value)
            if value
                .get("ok")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true) =>
        {
            GatewayConnectionSnapshot::from_config(
                &effective_config,
                GatewayConnectionStatus::Connected,
                Some(format!("{} ms", started.elapsed().as_millis())),
                None,
            )
        }
        Ok(value) => GatewayConnectionSnapshot::from_config(
            &effective_config,
            GatewayConnectionStatus::Degraded,
            Some(format!("{} ms", started.elapsed().as_millis())),
            Some(format!("Gateway health 非 ok: {value}")),
        ),
        Err(error) => GatewayConnectionSnapshot::from_config(
            &effective_config,
            GatewayConnectionStatus::Unavailable,
            None,
            Some(error),
        ),
    }
}

pub async fn resolve_endpoint_for_profile_from_app(
    app: &tauri::AppHandle,
    profile: Option<&str>,
) -> Result<GatewayEndpoint, String> {
    resolve_mode_and_endpoint_for_profile_from_app(app, profile)
        .await
        .map(|(_, endpoint)| endpoint)
}

/// Resolve the configured transport and endpoint without probing Gateway
/// health. Runtime requests use this to send over the existing stream first;
/// transport recovery remains responsible for probes/restarts after a genuine
/// failure. Returning the mode keeps the local account-switch guard intact.
pub async fn resolve_mode_and_endpoint_for_profile_from_app(
    _app: &tauri::AppHandle,
    profile: Option<&str>,
) -> Result<(GatewayConnectionMode, GatewayEndpoint), String> {
    let profile_key = normalize_profile(profile);
    let default_config = GatewayConnectionConfig::not_configured(profile_key.clone());
    let openclaw_config =
        crate::services::openclaw_gateway::load_openclaw_config_for_profile(Some(&profile_key))
            .ok();
    let effective_config = openclaw_config
        .as_ref()
        .and_then(|config| {
            effective_connection_config_from_openclaw_config(&default_config, config).ok()
        })
        .unwrap_or_else(|| default_config.clone());
    if effective_config.mode == GatewayConnectionMode::NotConfigured {
        return Err(connection_required_message(&profile_key));
    }
    let mode = effective_config.mode;
    let endpoint =
        resolve_effective_connection_endpoint(&effective_config, openclaw_config.as_ref(), None)?
            .endpoint;
    Ok((mode, endpoint))
}

pub async fn connection_snapshot_for_profile_from_app(
    app: &tauri::AppHandle,
    profile: Option<&str>,
) -> Result<GatewayConnectionSnapshot, String> {
    let profile_key = normalize_profile(profile);
    let config = GatewayConnectionConfig::not_configured(profile_key.clone());
    let openclaw_config =
        crate::services::openclaw_gateway::load_openclaw_config_for_profile(Some(&profile_key))
            .ok();
    Ok(probe_effective_connection_snapshot(app, &config, openclaw_config.as_ref()).await)
}

pub fn connection_required_message(profile_key: &str) -> String {
    format!(
        "Gateway Connection（profile `{profile_key}`）尚未配置。请先在运行中心选择 Local 或 Remote。"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_gateway_records_across_profiles_and_rejects_mismatched_records() {
        let root = std::env::temp_dir().join(format!(
            "uniopc-gateway-records-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let profile_a = root.join("profile-a");
        let profile_b = root.join("profile-b");
        let mismatched = root.join("profile-c");
        std::fs::create_dir_all(&profile_a).unwrap();
        std::fs::create_dir_all(&profile_b).unwrap();
        std::fs::write(
            profile_a.join("gateway-endpoint.json"),
            r#"{"profile_key":"profile-a","port":28790,"pid":101,"created_at":"now"}"#,
        )
        .unwrap();
        std::fs::write(
            profile_b.join("gateway-endpoint.json"),
            r#"{"profile_key":"profile-b","port":28791,"pid":202,"created_at":"now"}"#,
        )
        .unwrap();
        let mut records = gateway_endpoint_records_under(&root).unwrap();
        records.sort_by_key(|record| record.pid);

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].profile_key, "profile-a");
        assert_eq!(records[1].profile_key, "profile-b");
        std::fs::create_dir_all(&mismatched).unwrap();
        std::fs::write(
            mismatched.join("gateway-endpoint.json"),
            r#"{"profile_key":"somebody-else","port":28792,"pid":303,"created_at":"now"}"#,
        )
        .unwrap();
        assert!(gateway_endpoint_records_under(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn endpoint_enumeration_rejects_unreadable_root_and_bad_json() {
        let root_file = std::env::temp_dir().join(format!(
            "uniopc-endpoint-root-file-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&root_file, b"not-a-directory").unwrap();
        assert!(gateway_endpoint_records_under(&root_file).is_err());
        std::fs::remove_file(&root_file).unwrap();

        let root = std::env::temp_dir().join(format!(
            "uniopc-endpoint-bad-json-{}",
            uuid::Uuid::new_v4()
        ));
        let profile = root.join("profile-a");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("gateway-endpoint.json"), b"not-json").unwrap();
        assert!(gateway_endpoint_records_under(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn endpoint_enumeration_rejects_bad_entry_and_canonical_escape() {
        let root = std::env::temp_dir().join(format!(
            "uniopc-endpoint-bad-entry-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(root.join("bad-profile/gateway-endpoint.json")).unwrap();
        assert!(gateway_endpoint_records_under(&root).is_err());
        std::fs::remove_dir_all(root.join("bad-profile")).unwrap();

        let outside = std::env::temp_dir().join(format!(
            "uniopc-endpoint-outside-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&outside).unwrap();
        assert!(!canonical_path_is_within_root(&root, &outside).unwrap());
        #[cfg(unix)]
        {
            let escaped = root.join("escaped-profile");
            std::os::unix::fs::symlink(&outside, escaped).unwrap();
            assert!(gateway_endpoint_records_under(&root).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn endpoint_enumeration_uses_symlink_metadata_instead_of_try_exists() {
        let source = include_str!("openclaw_connection.rs");
        let body = source
            .split("pub(crate) fn gateway_endpoint_records_under")
            .nth(1)
            .unwrap()
            .split("fn canonical_path_is_within_root")
            .next()
            .unwrap();
        assert!(source.contains("std::fs::symlink_metadata(path)"));
        assert!(body.contains("endpoint_path_exists"));
        assert!(!body.contains("try_exists"));
    }

    #[test]
    fn endpoint_metadata_classifier_only_treats_not_found_as_absent() {
        assert_eq!(
            classify_endpoint_metadata(
                Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
                "fixture"
            )
            .unwrap(),
            false
        );
        assert!(classify_endpoint_metadata(
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
            "fixture"
        )
        .is_err());
        assert!(classify_endpoint_metadata(Ok(()), "fixture").unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn endpoint_enumeration_rejects_dangling_root_and_record_symlinks() {
        let base =
            std::env::temp_dir().join(format!("uniopc-endpoint-dangling-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let missing = base.join("missing");
        let dangling_root = base.join("dangling-root");
        std::os::unix::fs::symlink(&missing, &dangling_root).unwrap();
        assert!(gateway_endpoint_records_under(&dangling_root).is_err());

        let root = base.join("state");
        let profile = root.join("profile-a");
        std::fs::create_dir_all(&profile).unwrap();
        std::os::unix::fs::symlink(&missing, profile.join("gateway-endpoint.json")).unwrap();
        assert!(gateway_endpoint_records_under(&root).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn starting_profile_b_keeps_profile_a_crash_records_in_reclaim_scope() {
        let records = vec![
            GatewayEndpointRecord {
                profile_key: "profile-a".to_string(),
                port: 28790,
                pid: 101,
                generation: 2,
                parent_pid: 10,
                instance_id: Some("desktop-instance".to_string()),
                process_created_at: Some("created-a".to_string()),
                created_at: "recorded-a".to_string(),
            },
            GatewayEndpointRecord {
                profile_key: "profile-b".to_string(),
                port: 28791,
                pid: 202,
                generation: 1,
                parent_pid: 10,
                instance_id: None,
                process_created_at: None,
                created_at: "recorded-b".to_string(),
            },
        ];

        let scope = gateway_orphan_reclaim_scope(records, "profile-b");
        assert_eq!(scope.len(), 2);
        assert_eq!(scope[0].profile_key, "profile-a");
        assert_eq!(scope[1].profile_key, "profile-b");
    }

    #[test]
    fn normalizes_http_gateway_url_to_ws() {
        assert_eq!(
            normalize_gateway_ws_url("http://example.test:18790/").unwrap(),
            "ws://example.test:18790"
        );
        assert_eq!(
            normalize_gateway_ws_url("https://gw.example.test/path").unwrap(),
            "wss://gw.example.test/path"
        );
    }

    #[test]
    fn rejects_invalid_gateway_url_scheme() {
        let error = normalize_gateway_ws_url("ftp://example.test").unwrap_err();
        assert!(error.contains("ws/wss/http/https"));
    }

    #[test]
    fn parses_ssh_target_with_optional_port() {
        let target = parse_ssh_target("lan@example.test:2222").unwrap();
        assert_eq!(target.user_host, "lan@example.test");
        assert_eq!(target.port, Some(2222));
    }

    #[test]
    fn rejects_unsafe_ssh_target() {
        assert!(parse_ssh_target("lan@example.test -o ProxyCommand=bad").is_err());
        // Leading-dash bypass: no whitespace, contains `@`, so the metachar guard
        // alone would pass it into ssh's option slot.
        assert!(parse_ssh_target("-oProxyCommand=/tmp/x@h").is_err());
        assert!(parse_ssh_target("-F/tmp/evil@host").is_err());
    }

    #[test]
    fn missing_profile_does_not_fallback_to_compat_profile() {
        assert_eq!(normalize_profile(None), "");
        assert_eq!(normalize_profile(Some("   ")), "");
        assert_eq!(normalize_profile(Some("owner-profile")), "owner-profile");
    }

    #[test]
    fn every_profile_shares_the_singleton_engine_port() {
        assert_eq!(local_gateway_port_for_profile("imai"), UNIOPC_ENGINE_PREFERRED_PORT);
        assert_eq!(local_gateway_port_for_profile(""), UNIOPC_ENGINE_PREFERRED_PORT);
        assert_eq!(
            local_gateway_port_for_profile("owner-profile"),
            local_gateway_port_for_profile("bootiful-wtf-4a58b3ae")
        );
    }

    #[test]
    fn pick_local_gateway_port_returns_a_free_port_and_avoids_an_occupied_preferred() {
        use std::net::TcpListener;
        // Whatever it returns must actually be bindable (free).
        let port = pick_local_gateway_port();
        assert_ne!(port, 0);
        assert!(
            TcpListener::bind(("127.0.0.1", port)).is_ok(),
            "picked port {port} must be free"
        );
        // Occupy the preferred port → the picker must fall back to a *different*
        // free port (this is the whole point: never fight a squatter). Skipped
        // gracefully if the preferred port is already held (e.g. a live engine).
        if let Ok(_held) = TcpListener::bind(("127.0.0.1", UNIOPC_ENGINE_PREFERRED_PORT)) {
            let fallback = pick_local_gateway_port();
            assert_ne!(
                fallback, UNIOPC_ENGINE_PREFERRED_PORT,
                "must not return the occupied preferred port"
            );
            assert!(TcpListener::bind(("127.0.0.1", fallback)).is_ok());
        }
    }

    #[test]
    fn resolves_local_endpoint() {
        let config = GatewayConnectionConfig::local_for_profile("owner-profile".to_string());
        let endpoint = resolve_connection_endpoint(&config).unwrap();
        assert_eq!(
            endpoint.endpoint.url,
            format!("ws://127.0.0.1:{}", config.local_port)
        );
        assert_eq!(
            endpoint.dashboard_url,
            Some(format!("http://127.0.0.1:{}/", config.local_port))
        );
    }

    #[test]
    fn resolves_member_local_endpoint_to_stable_profile_port() {
        let config =
            GatewayConnectionConfig::local_for_profile("bootiful-wtf-4a58b3ae".to_string());
        let endpoint = resolve_connection_endpoint(&config).unwrap();

        assert_eq!(config.local_port, UNIOPC_ENGINE_PREFERRED_PORT);
        assert_eq!(
            endpoint.endpoint.url,
            format!("ws://127.0.0.1:{}", config.local_port)
        );
        assert_eq!(
            config.local_port,
            local_gateway_port_for_profile("bootiful-wtf-4a58b3ae")
        );
    }

    #[test]
    fn snapshot_redacts_auth_token() {
        let config = GatewayConnectionConfig {
            mode: GatewayConnectionMode::RemoteDirect,
            remote_url: Some("wss://example.test".to_string()),
            auth_token: Some("secret-token".to_string()),
            auth_password: Some("secret-password".to_string()),
            ..GatewayConnectionConfig::not_configured("owner-profile".to_string())
        };
        let snapshot = GatewayConnectionSnapshot::from_config(
            &config,
            GatewayConnectionStatus::Connected,
            Some("10 ms".to_string()),
            None,
        );

        assert!(snapshot.has_auth_token);
        assert!(snapshot.has_auth_password);
        assert_eq!(snapshot.auth_token_preview, Some("configured".to_string()));
        assert_eq!(
            snapshot.auth_password_preview,
            Some("configured".to_string())
        );
    }

    #[test]
    fn builds_ssh_tunnel_args_without_shell() {
        let config = GatewayConnectionConfig {
            mode: GatewayConnectionMode::RemoteSshTunnel,
            ssh_target: Some("lan@example.test:2222".to_string()),
            ssh_remote_host: "127.0.0.1".to_string(),
            ssh_remote_port: 18790,
            ssh_local_port: 18791,
            ..GatewayConnectionConfig::not_configured("owner-profile".to_string())
        };

        let args = ssh_tunnel_args(&config).unwrap();

        assert_eq!(
            args,
            vec![
                "-N",
                "-L",
                "18791:127.0.0.1:18790",
                "-p",
                "2222",
                "--",
                "lan@example.test",
            ]
        );
    }

    #[test]
    fn openclaw_remote_direct_config_is_the_endpoint_source() {
        let config = json!({
            "gateway": {
                "mode": "remote",
                "remote": {
                    "transport": "direct",
                    "url": "https://owner.example.ts.net:19999/control/",
                    "token": "remote-token"
                }
            }
        });

        let resolved =
            resolve_effective_connection_endpoint_from_openclaw_config("imai", &config, None)
                .unwrap();

        assert_eq!(
            resolved.endpoint.url,
            "wss://owner.example.ts.net:19999/control"
        );
        assert_eq!(resolved.endpoint.token.as_deref(), Some("remote-token"));
        assert_eq!(resolved.dashboard_url, None);
    }

    #[test]
    fn openclaw_remote_direct_rejects_public_plaintext_ws() {
        let config = json!({
            "gateway": {
                "mode": "remote",
                "remote": {
                    "transport": "direct",
                    "url": "ws://gateway.example:18790"
                }
            }
        });

        let error =
            resolve_effective_connection_endpoint_from_openclaw_config("imai", &config, None)
                .expect_err("public ws direct endpoint should be rejected");

        assert!(error.contains("wss"));
    }

    #[test]
    fn openclaw_remote_direct_rejects_plaintext_private_prefix_bypasses() {
        for url in [
            "ws://127.attacker.example:18790",
            "ws://192.168.0.202.attacker.example:18790",
            "ws://100.123.224.76.attacker.example:18790",
            "ws://fd-example.com:18790",
        ] {
            let config = json!({
                "gateway": {
                    "mode": "remote",
                    "remote": {
                        "transport": "direct",
                        "url": url
                    }
                }
            });

            assert!(
                resolve_effective_connection_endpoint_from_openclaw_config("imai", &config, None)
                    .is_err(),
                "{url} should be rejected"
            );
        }
    }

    #[test]
    fn openclaw_remote_direct_allows_private_plaintext_ws() {
        for url in [
            "ws://127.0.0.1:18790",
            "ws://192.168.1.20:18790",
            "ws://100.105.138.117:18790",
            "ws://openclaw.local:18790",
            "ws://[fd00::1]:18790",
        ] {
            let config = json!({
                "gateway": {
                    "mode": "remote",
                    "remote": {
                        "transport": "direct",
                        "url": url
                    }
                }
            });

            resolve_effective_connection_endpoint_from_openclaw_config("imai", &config, None)
                .unwrap_or_else(|error| panic!("{url} should be allowed: {error}"));
        }
    }

    #[test]
    fn openclaw_remote_ssh_config_uses_local_tunnel_endpoint() {
        let config = json!({
            "gateway": {
                "mode": "remote",
                "remote": {
                    "transport": "ssh",
                    "url": "ws://127.0.0.1:18789",
                    "sshTarget": "lan@example.test",
                    "sshIdentity": "/Users/lan/.ssh/id_ed25519",
                    "token": "ssh-token"
                }
            }
        });

        let resolved = resolve_effective_connection_endpoint_from_openclaw_config(
            "imai",
            &config,
            Some(18888),
        )
        .unwrap();

        assert_eq!(resolved.endpoint.url, "ws://127.0.0.1:18888");
        assert_eq!(resolved.endpoint.token.as_deref(), Some("ssh-token"));
        assert_eq!(
            resolved.dashboard_url.as_deref(),
            Some("http://127.0.0.1:18888/")
        );
    }

    #[test]
    fn openclaw_config_endpoint_uses_official_token() {
        let openclaw_config = json!({
            "gateway": {
                "mode": "remote",
                "remote": {
                    "transport": "direct",
                    "url": "wss://official.example.test",
                    "token": "official-token"
                }
            }
        });
        let default_config = GatewayConnectionConfig {
            profile: "imai".to_string(),
            mode: GatewayConnectionMode::RemoteDirect,
            remote_url: Some("wss://legacy.example.test".to_string()),
            auth_token: Some("legacy-token".to_string()),
            ..GatewayConnectionConfig::not_configured("imai".to_string())
        };

        let resolved =
            resolve_effective_connection_endpoint(&default_config, Some(&openclaw_config), None)
                .unwrap();

        assert_eq!(resolved.endpoint.url, "wss://official.example.test");
        assert_eq!(resolved.endpoint.token.as_deref(), Some("official-token"));
    }

    #[test]
    fn local_endpoint_uses_single_writer_password_ignoring_config_auth() {
        // Local is basic-auth single-writer: whatever auth the on-disk config
        // carries (a stale token, an out-of-date password) is ignored — the
        // endpoint always resolves to the per-run in-memory password and never a
        // token. This is what makes `auth_token_mismatch` impossible locally.
        let openclaw_config = json!({
            "gateway": {
                "mode": "local",
                "port": 19148,
                "auth": {
                    "mode": "password",
                    "token": "stale-token",
                    "password": "stale-password"
                }
            }
        });
        let default_config =
            GatewayConnectionConfig::not_configured("linghao-37cfabdf".to_string());

        let effective =
            effective_connection_config_from_openclaw_config(&default_config, &openclaw_config)
                .unwrap();
        let resolved =
            resolve_effective_connection_endpoint(&default_config, Some(&openclaw_config), None)
                .unwrap();

        assert_eq!(effective.auth_token, None);
        assert_eq!(
            effective.auth_password.as_deref(),
            Some(local_gateway_password())
        );
        assert_eq!(resolved.endpoint.token, None);
        // Local must also never carry a device token — a stray one would divert
        // the connection to the device-auth handshake on a password-mode gateway.
        assert_eq!(resolved.endpoint.device_token, None);
        assert_eq!(
            resolved.endpoint.password.as_deref(),
            Some(local_gateway_password())
        );
    }

    #[test]
    fn openclaw_config_promotes_not_configured_default_to_remote_direct() {
        let openclaw_config = json!({
            "gateway": {
                "mode": "remote",
                "remote": {
                    "transport": "direct",
                    "url": "wss://official.example.test",
                    "token": "official-token"
                }
            }
        });
        let default_config = GatewayConnectionConfig::not_configured("imai".to_string());

        let effective =
            effective_connection_config_from_openclaw_config(&default_config, &openclaw_config)
                .unwrap();

        assert_eq!(effective.mode, GatewayConnectionMode::RemoteDirect);
        assert_eq!(
            effective.remote_url.as_deref(),
            Some("wss://official.example.test")
        );
        assert_eq!(effective.auth_token.as_deref(), Some("official-token"));
    }

    #[test]
    fn official_lock_file_name_matches_engine_derivation() {
        // Vector verified against a live engine (v2026.6.11): this config path
        // produced /tmp/openclaw-501/gateway.8fb80271.lock on disk.
        assert_eq!(
            super::official_gateway_lock_file_name(
                "/Users/lan/Library/Application Support/Uniopc/state/lanjinyu01-32bb573f/openclaw.json"
            ),
            "gateway.8fb80271.lock"
        );
    }

    #[test]
    fn official_lock_path_uses_branded_state_temp_directory() {
        let path = super::official_gateway_lock_path(Some("lan46-smoke")).unwrap();
        let components: Vec<_> = path
            .components()
            .map(|part| part.as_os_str().to_string_lossy().to_string())
            .collect();
        let temp_index = components.iter().rposition(|part| part == "tmp").unwrap();
        assert!(components[temp_index + 1].starts_with("uniopc"));
        assert!(path.to_string_lossy().ends_with(".lock"));
    }
}
