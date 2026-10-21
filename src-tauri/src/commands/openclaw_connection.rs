use crate::commands::model;
use crate::services::openclaw_connection::{
    effective_connection_config_from_openclaw_config, normalize_gateway_ws_url, parse_ssh_target,
    probe_effective_connection_snapshot, require_profile, resolve_effective_connection_endpoint,
    GatewayConnectionConfig, GatewayConnectionMode, GatewayConnectionSnapshot,
    GatewayConnectionStatus, GatewayTunnelSupervisor, GATEWAY_ERROR_CODE_AUTH_TOKEN_MISSING,
    GATEWAY_ERROR_CODE_AUTH_TOKEN_MISMATCH, GATEWAY_ERROR_CODE_AUTH_UNAUTHORIZED,
};
use crate::services::openclaw_gateway;
use chrono::Utc;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const GATEWAY_STARTUP_BUDGET: Duration = Duration::from_secs(900);
#[cfg(not(windows))]
const GATEWAY_STARTUP_BUDGET: Duration = Duration::from_secs(180);

struct LocalStartupBackend<'a> {
    app: &'a AppHandle,
    config: std::sync::Mutex<GatewayConnectionConfig>,
    input: &'a GatewayConnectionProfileInput,
    generation: u64,
    flight: &'a crate::services::startup_coordinator::StartupFlightContext,
    provision_count: &'a AtomicU64,
    phases: std::sync::Mutex<std::collections::HashSet<(String, bool)>>,
}
impl LocalStartupBackend<'_> {
    fn config(&self) -> GatewayConnectionConfig {
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}
impl crate::services::startup_readiness::GatewayStartup for LocalStartupBackend<'_> {
    type Snapshot = GatewayConnectionSnapshot;
    fn check(&self) -> Result<(), String> {
        self.flight.checkpoint()?;
        local_gateway_lifecycle().check(self.generation)
    }
    async fn child_running(&self) -> bool {
        self.app
            .state::<model::GatewaySupervisor>()
            .is_running()
            .await
    }
    async fn http_ready(&self) -> Result<bool, String> {
        let config = self.config();
        let root = openclaw_gateway::load_openclaw_config_for_profile(Some(&config.profile))?;
        let resolved = resolve_effective_connection_endpoint(&config, Some(&root), None)?;
        openclaw_gateway::http_ready_for_endpoint(&resolved.endpoint).await
    }
    async fn auth_ready(&self) -> Result<Option<Self::Snapshot>, String> {
        let config = self.config();
        let root = openclaw_gateway::load_openclaw_config_for_profile(Some(&config.profile))?;
        let snapshot = probe_effective_connection_snapshot(self.app, &config, Some(&root)).await;
        if snapshot.status == GatewayConnectionStatus::Connected {
            Ok(Some(snapshot))
        } else if let Some(error) = snapshot.last_error {
            Err(error)
        } else {
            Ok(None)
        }
    }
    async fn config_get(&self) -> Result<Value, String> {
        openclaw_gateway::config_get(Some(&self.config().profile)).await
    }
    fn defaults_patch(&self, snapshot: &Value) -> Result<Value, String> {
        model::startup_defaults_delta(
            snapshot,
            &self.config().profile,
            self.input.cloud_agent_api_url.as_deref(),
            self.input.cloud_agent_auth_token.as_deref(),
            self.input.cloud_agent_token_expires_at.as_deref(),
            self.input.cloud_agent_id.as_deref(),
        )
    }
    async fn config_patch(&self, snapshot: &Value, delta: Value) -> Result<(), String> {
        openclaw_gateway::startup_config_patch(&self.config().profile, snapshot, delta).await
    }
    fn contains_explicit_secret(&self, delta: &Value) -> bool {
        self.input
            .cloud_agent_auth_token
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .is_some_and(|secret| {
                delta
                    .pointer("/env/vars/IMAI_CLOUD_AGENT_AUTH_TOKEN")
                    .and_then(Value::as_str)
                    == Some(secret)
            })
    }
    async fn verify_plugins(&self) -> Result<(), String> {
        crate::services::openclaw_system_plugins::ensure_system_plugins_for_profile(
            self.app,
            &self.config().profile,
        )
        .await
    }
    fn phase(&self, phase: &str, elapsed: Duration, count: usize) {
        // Readonly transport recovery can revisit readiness many times. Keep
        // disk-backed phase telemetry at most once per boundary per flight.
        if !self
            .phases
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert((phase.to_string(), count == 0))
        {
            return;
        }
        crate::services::engine_startup_metrics::record_startup_event(
            self.app,
            &self.config().profile,
            phase,
            if count == 0 { "started" } else { "completed" },
            elapsed.as_millis().try_into().unwrap_or(u64::MAX),
            Some(format!("count={count}")),
        );
    }
}
impl crate::services::startup_readiness::GatewayActivation for LocalStartupBackend<'_> {
    async fn stop_and_reclaim(&self) -> Result<(), String> {
        use crate::services::startup_readiness::GatewayStartup;
        self.check()?;
        self.app.state::<model::GatewaySupervisor>().stop().await;
        self.check()?;
        model::reclaim_orphan_engines_before_start()
    }
    async fn onboard(&self) -> Result<(), String> {
        use crate::services::startup_readiness::GatewayStartup;
        self.check()?;
        self.provision_count.fetch_add(1, Ordering::SeqCst);
        let config = self.config();
        let provision = model::openclaw_profile_provision(
            self.app.clone(),
            model::OpenClawProfileProvisionRequest {
                profile: config.profile,
                gateway_port: Some(config.local_port),
                managed_member_profile: false,
                cloud_agent_api_url: self.input.cloud_agent_api_url.clone(),
                cloud_agent_auth_token: self.input.cloud_agent_auth_token.clone(),
                cloud_agent_token_expires_at: self.input.cloud_agent_token_expires_at.clone(),
                cloud_agent_id: self.input.cloud_agent_id.clone(),
                startup_generation: Some(self.generation),
            },
        )
        .await?;
        self.check()?;
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .local_port = provision.gateway_port;
        Ok(())
    }
    async fn prepare_spawn(&self) -> Result<(), String> {
        use crate::services::startup_readiness::GatewayStartup;
        let config = self.config();
        self.check()?;
        crate::commands::openclaw_plugins::cleanup_legacy_acpx_bridge_for_profile(&config.profile)?;
        self.check()?;
        save_openclaw_gateway_config_patch(
            &config.profile,
            local_openclaw_gateway_config_patch(&config.profile, config.local_port),
        )?;
        self.check()?;
        crate::services::openclaw_system_plugins::prepare_system_plugins_before_gateway_spawn(
            self.app,
            &config.profile,
        )
        .await
    }
    async fn spawn(&self) -> Result<(), String> {
        use crate::services::startup_readiness::GatewayStartup;
        self.check()?;
        self.app
            .state::<model::GatewaySupervisor>()
            .ensure_running_for(&self.config().profile)
            .await
    }
    fn auth_repair_needed(&self, error: &str) -> bool {
        let snapshot = GatewayConnectionSnapshot::from_config(
            &self.config(),
            GatewayConnectionStatus::Unavailable,
            None,
            Some(error.to_string()),
        );
        local_gateway_auth_repair_needed(&snapshot)
    }
}

#[derive(Default)]
struct LocalGatewayLifecycle {
    generation: AtomicU64,
    mutations: tokio::sync::Mutex<()>,
    target_profile: std::sync::Mutex<Option<String>>,
}

impl LocalGatewayLifecycle {
    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn activate(&self, profile: &str, generation: u64) -> Result<(), String> {
        let mut target = self
            .target_profile
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let current_generation = self.generation();
        if generation < current_generation
            || (generation == current_generation && target.as_deref() != Some(profile))
        {
            return Err("startup_superseded_by_newer_intent".to_string());
        }
        self.generation.store(generation, Ordering::SeqCst);
        *target = Some(profile.to_string());
        Ok(())
    }

    fn invalidate(&self, generation: u64) {
        self.generation.store(generation, Ordering::SeqCst);
        *self
            .target_profile
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }

    fn check(&self, generation: u64) -> Result<(), String> {
        if self.generation() == generation {
            Ok(())
        } else {
            Err("账号已退出，已取消本次 Uniopc 引擎启动。".to_string())
        }
    }

    async fn lock_current(&self, generation: u64) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        let guard = self.mutations.lock().await;
        self.check(generation)?;
        Ok(guard)
    }

}

fn local_gateway_lifecycle() -> &'static LocalGatewayLifecycle {
    static LIFECYCLE: OnceLock<LocalGatewayLifecycle> = OnceLock::new();
    LIFECYCLE.get_or_init(LocalGatewayLifecycle::default)
}

fn runtime_activation_coordinator() -> &'static crate::services::startup_coordinator::StartupCoordinator<()> {
    static COORDINATOR: OnceLock<crate::services::startup_coordinator::StartupCoordinator<()>> =
        OnceLock::new();
    COORDINATOR.get_or_init(Default::default)
}

async fn prepare_bundled_runtime(app: AppHandle) -> Result<(), String> {
    runtime_activation_coordinator()
        .run_profile(
            crate::services::openclaw_engine_contract::OPENCLAW_ENGINE_VERSION,
            move |_| async move {
                tauri::async_runtime::spawn_blocking(move || {
                    crate::services::openclaw_bundled_runtime::ensure_runtime_ready(&app)
                })
                .await
                .map_err(|error| format!("初始化内置运行时任务失败: {error}"))??;
                Ok(())
            },
        )
        .await
}

pub(crate) fn local_gateway_generation() -> u64 {
    local_gateway_lifecycle().generation()
}

pub(crate) fn ensure_local_gateway_generation(generation: u64) -> Result<(), String> {
    local_gateway_lifecycle().check(generation)
}

/// Invalidate queued/activating starts, then hold both startup execution and
/// lifecycle mutation gates while destructive stop/reset work commits. Runtime
/// preparation is outside the execution gate, so shutdown need not wait for it.
pub(crate) struct LocalGatewayShutdownGuard {
    _startup: tokio::sync::OwnedMutexGuard<()>,
    _lifecycle: tokio::sync::MutexGuard<'static, ()>,
}

pub(crate) async fn local_gateway_shutdown_guard(
    app: &AppHandle,
) -> LocalGatewayShutdownGuard {
    use tauri::Manager;
    let startup = app
        .state::<crate::services::startup_coordinator::GatewayStartupCoordinator>()
        .invalidate_and_lock(|generation| local_gateway_lifecycle().invalidate(generation))
        .await;
    let lifecycle = local_gateway_lifecycle().mutations.lock().await;
    LocalGatewayShutdownGuard {
        _startup: startup,
        _lifecycle: lifecycle,
    }
}

fn owned_engine_matches_profile(profile: &str, running_profile: Option<&str>, running: bool) -> bool {
    running && running_profile == Some(profile)
}

fn require_local_gateway_start_profile(profile: Option<&str>) -> Result<String, String> {
    let profile = require_profile(profile)?;
    if profile.is_empty() {
        return Err("Uniopc 引擎 profile 不能为空，请先完成工作空间 profile 初始化。".to_string());
    }
    Ok(profile)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConnectionProfileInput {
    pub profile: Option<String>,
    pub gateway_port: Option<u16>,
    pub cloud_agent_api_url: Option<String>,
    pub cloud_agent_auth_token: Option<String>,
    pub cloud_agent_token_expires_at: Option<String>,
    pub cloud_agent_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConnectionModeInput {
    pub profile: Option<String>,
    pub mode: GatewayConnectionMode,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRemoteDirectInput {
    pub profile: Option<String>,
    pub remote_url: String,
    pub auth_token: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRemoteSshInput {
    pub profile: Option<String>,
    pub ssh_target: String,
    pub ssh_remote_host: String,
    pub ssh_remote_port: u16,
    pub ssh_local_port: u16,
    pub auth_token: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawEffectiveStatus {
    pub profile: String,
    pub requested_gateway_port: Option<u16>,
    pub app_connection_mode: GatewayConnectionMode,
    pub app_connection_endpoint_url: Option<String>,
    pub app_connection_port: Option<u16>,
    pub app_connection_has_token: bool,
    pub app_connection_updated_at: String,
    pub openclaw_config_path: String,
    pub openclaw_config_exists: bool,
    pub openclaw_config_ws_url: Option<String>,
    pub openclaw_config_port: Option<u16>,
    pub openclaw_config_auth_mode: Option<String>,
    pub openclaw_config_has_token: bool,
    pub openclaw_config_has_password: bool,
    pub mismatches: Vec<String>,
}

fn remote_direct_openclaw_gateway_config_patch(
    remote_url: &str,
    auth_token: Option<String>,
) -> Result<Value, String> {
    let mut remote = json!({
        "transport": "direct",
        "url": normalize_gateway_ws_url(remote_url)?,
    });
    if let Some(token) = normalize_optional_secret(auth_token) {
        remote["token"] = Value::String(token);
    } else {
        remote["token"] = Value::Null;
    }
    remote["password"] = Value::Null;
    Ok(json!({
        "gateway": {
            "mode": "remote",
            "remote": remote,
        }
    }))
}

fn remote_ssh_openclaw_gateway_config_patch(
    ssh_target: &str,
    ssh_identity: &str,
    ssh_remote_port: u16,
    ssh_local_port: u16,
    auth_token: Option<String>,
) -> Result<Value, String> {
    parse_ssh_target(ssh_target)?;
    let mut remote = json!({
        "transport": "ssh",
        "url": format!("ws://127.0.0.1:{ssh_local_port}"),
        "sshTarget": ssh_target.trim(),
        "remotePort": ssh_remote_port,
    });
    if let Some(identity) = normalize_optional_secret(Some(ssh_identity.to_string())) {
        remote["sshIdentity"] = Value::String(identity);
    } else {
        remote["sshIdentity"] = Value::Null;
    }
    if let Some(token) = normalize_optional_secret(auth_token) {
        remote["token"] = Value::String(token);
    } else {
        remote["token"] = Value::Null;
    }
    remote["password"] = Value::Null;
    Ok(json!({
        "gateway": {
            "mode": "remote",
            "remote": remote,
        }
    }))
}

fn local_openclaw_gateway_config_patch(profile: &str, local_port: u16) -> Value {
    // Basic-auth single-writer: the password lives ONLY in memory + env
    // (`OPENCLAW_GATEWAY_PASSWORD` on the gateway child; injected client-side by
    // `local_gateway_password()`), never in the engine's watched config. The
    // gateway restarts on any `gateway.auth.password` change, so persisting a
    // per-run secret here made it restart on every launch. We instead CLEAR
    // `gateway.auth` entirely — dropping any stale token/password from older
    // builds — so the config value is stable and the gateway never restarts on
    // our account.
    //
    // Bind honors the per-profile mobile-LAN marker. This patch is applied on
    // connect/launch and previously hardcoded "loopback", which clobbered an
    // opted-in LAN bind on every restart. The env password still gates the
    // non-loopback listener, so a LAN bind is not left unauthenticated.
    let bind = if model::mobile_lan_enabled_for_profile(profile) {
        "lan"
    } else {
        "loopback"
    };
    json!({
        "gateway": {
            "mode": "local",
            "bind": bind,
            "port": local_port,
            "remote": null,
            "auth": null,
        }
    })
}

fn mode_openclaw_gateway_config_patch(mode: GatewayConnectionMode) -> Value {
    let mode = match mode {
        GatewayConnectionMode::Local => Some("local"),
        GatewayConnectionMode::RemoteDirect | GatewayConnectionMode::RemoteSshTunnel => {
            Some("remote")
        }
        GatewayConnectionMode::NotConfigured => None,
    };
    match mode {
        Some(mode) => json!({ "gateway": { "mode": mode } }),
        None => json!({ "gateway": null }),
    }
}

/// Write `contents` to `path` atomically: a sibling temp file, flushed to disk,
/// then renamed over the target. A crash/force-quit mid-write can no longer
/// leave a truncated `openclaw.json` that the engine (which watches this file)
/// would refuse to load — the same invalid-config startup failure the read-side
/// byte guard exists to prevent, reached by a different door.
fn write_config_atomic(path: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| "Uniopc 引擎 config 路径缺少父目录。".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("uniopc-engine.json");
    let tmp = parent.join(format!(".{file_name}.tmp-{}", std::process::id()));
    {
        let mut file = fs::File::create(&tmp)
            .map_err(|e| format!("创建 Uniopc 引擎 config 临时文件失败: {e}"))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("写入 Uniopc 引擎 config 临时文件失败: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("刷新 Uniopc 引擎 config 临时文件失败: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("保存 Uniopc 引擎 config 失败: {e}")
    })
}

// The desktop provides its own UI. Avoid preparing and retaining the bundled
// browser console for profiles that never configured it. Preserve any explicit
// controlUi settings (including custom roots/origins) and all remote configs.
fn merge_gateway_config_patch(root: &mut Value, mut patch: Value) -> Result<bool, String> {
    if patch.pointer("/gateway/mode").and_then(Value::as_str) == Some("local")
        && root.pointer("/gateway/controlUi").is_none()
        && patch.pointer("/gateway/controlUi").is_none()
    {
        patch["gateway"]["controlUi"] = json!({ "enabled": false });
    }
    merge_json_object_changed(root, patch)
}

fn local_proxy_block_is_owned(
    block: Option<&Value>,
    proxy_secret: &str,
    previous_official_identity: Option<(&str, &str)>,
) -> bool {
    let Some(block) = block.and_then(Value::as_object) else {
        return false;
    };
    let secret_matches = block
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        == Some(proxy_secret);
    let previous_identity_matches = previous_official_identity.is_some_and(
        |(official_base_url, official_secret)| {
            crate::services::official_model_proxy::is_uniopc_official_loopback_base_url(
                official_base_url,
            ) && block.get("baseUrl").and_then(Value::as_str) == Some(official_base_url)
                && block.get("apiKey").and_then(Value::as_str) == Some(official_secret)
        },
    );
    secret_matches || previous_identity_matches
}

fn merge_local_gateway_startup_config(
    root: &mut Value,
    proxy_base_url: Option<&str>,
    proxy_secret: Option<&str>,
) -> Result<bool, String> {
    let (Some(proxy_base_url), Some(proxy_secret)) = (
        proxy_base_url.map(str::trim).filter(|value| !value.is_empty()),
        proxy_secret.map(str::trim).filter(|value| !value.is_empty()),
    ) else {
        return Ok(false);
    };

    let previous_official_base_url = root
        .pointer("/models/providers/uniopc-official/baseUrl")
        .and_then(Value::as_str)
        .map(str::to_string);
    let previous_official_secret = root
        .pointer("/models/providers/uniopc-official/apiKey")
        .and_then(Value::as_str)
        .map(str::to_string);
    let previous_official_identity = previous_official_base_url
        .as_deref()
        .zip(previous_official_secret.as_deref());

    let mut providers = serde_json::Map::new();
    if root
        .pointer("/models/providers/uniopc-official")
        .and_then(Value::as_object)
        .is_some()
    {
        providers.insert(
            "uniopc-official".to_string(),
            json!({ "baseUrl": proxy_base_url, "apiKey": proxy_secret }),
        );
    }
    if local_proxy_block_is_owned(
        root.pointer("/models/providers/openai"),
        proxy_secret,
        previous_official_identity,
    ) {
        providers.insert(
            "openai".to_string(),
            json!({ "baseUrl": proxy_base_url, "apiKey": proxy_secret }),
        );
    }

    let mut patch = serde_json::Map::new();
    if !providers.is_empty() {
        patch.insert(
            "models".to_string(),
            json!({ "providers": Value::Object(providers) }),
        );
    }
    if local_proxy_block_is_owned(
        root.pointer("/tts/providers/minimax"),
        proxy_secret,
        previous_official_identity,
    ) {
        patch.insert(
            "tts".to_string(),
            json!({
                "providers": {
                    "minimax": {
                        "baseUrl": proxy_base_url,
                        "apiKey": proxy_secret
                    }
                }
            }),
        );
    }

    if patch.is_empty() {
        Ok(false)
    } else {
        merge_json_object_changed(root, Value::Object(patch))
    }
}

pub(crate) fn save_openclaw_gateway_config_patch(
    profile: &str,
    patch: Value,
) -> Result<(), String> {
    save_gateway_config_patch_impl(profile, patch, false)
}

// Apply defaults only immediately before a new owned child is spawned. A warm
// connection must not rewrite a watched controlUi setting and trigger a restart.
pub(crate) fn prepare_local_gateway_startup_config(profile: &str) -> Result<(), String> {
    let snapshot = openclaw_gateway::load_openclaw_config_for_profile(Some(profile))?;
    let mut patch = model::build_member_profile_static_startup_config_patch(&snapshot, profile);
    merge_json_object(&mut patch, json!({ "gateway": { "mode": "local" } }))?;
    save_gateway_config_patch_impl(profile, patch, true)
}

fn save_gateway_config_patch_impl(
    profile: &str,
    patch: Value,
    startup_defaults: bool,
) -> Result<(), String> {
    let path = openclaw_gateway::openclaw_config_path_for_profile(Some(profile))?;
    // A load error here means the file EXISTS but couldn't be read/parsed
    // (missing file loads as `Ok({})`). Falling back to `{}` in that case and
    // merging would rewrite the whole config down to just this patch — the
    // clobber class the byte guard below only catches at extreme sizes. Try the
    // backups; if none parse either, refuse the write outright.
    let mut root = match openclaw_gateway::load_openclaw_config_for_profile(Some(profile)) {
        Ok(root) => root,
        Err(error) => load_openclaw_config_backup_for_patch(&path).ok_or_else(|| {
            format!("Uniopc 引擎 config 已存在但无法解析，为防覆盖已跳过写入：{error}")
        })?,
    };
    // Recover the full config if the load came back empty OR thin — a transient
    // read failure, or the read catching the gateway mid-write. Using
    // `is_thin` alone missed the empty-`{}` case (it requires a `gateway` key),
    // so recovery never fired and the merge below wrote a gateway-only stub over
    // the real config.
    if openclaw_config_root_is_empty_or_thin(&root) {
        if let Some(recovered) = load_openclaw_config_backup_for_patch(&path) {
            root = recovered;
        }
    }
    let changed = if startup_defaults {
        let gateway_changed = merge_gateway_config_patch(&mut root, patch)?;
        let proxy_base_url = crate::services::official_model_proxy::proxy_base_url();
        let proxy_changed = merge_local_gateway_startup_config(
            &mut root,
            proxy_base_url.as_deref(),
            Some(crate::services::official_model_proxy::proxy_shared_secret()),
        )?;
        gateway_changed || proxy_changed
    } else {
        merge_json_object_changed(&mut root, patch)?
    };
    if !changed {
        // Avoid replacing an identical config. The Gateway watches this file,
        // so even a byte-for-byte semantic no-op creates reload work and can
        // briefly race the first chat turn on a cold launch.
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建 Uniopc 引擎 profile 配置目录失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("序列化 Uniopc 引擎 config 失败: {e}"))?;
    // Clobber guard: even after recovery, never shrink a substantial on-disk
    // config to a stub. If the merge base was still empty (backup also
    // unavailable) we would overwrite e.g. a 4.4KB provisioned config with a
    // ~123B gateway stub — the recurring `size-drop 4440->123` that produced an
    // invalid config and made the engine refuse to start. Leave the good file
    // intact and let the caller retry once the read settles.
    if let Ok(existing) = fs::read_to_string(&path) {
        if existing.len() >= SUBSTANTIAL_CONFIG_MIN_BYTES && raw.len() < STUB_CONFIG_MAX_BYTES {
            return Err(format!(
                "跳过 Uniopc 引擎 config 写入以防覆盖：磁盘已有完整配置（{} 字节），本次合并结果仅 {} 字节，疑似读取失败导致的残缺覆盖，请重试。",
                existing.len(),
                raw.len()
            ));
        }
    }
    write_config_atomic(&path, &raw)
}

fn openclaw_config_root_is_thin(root: &Value) -> bool {
    let Some(object) = root.as_object() else {
        return false;
    };
    object.contains_key("gateway")
        && !object.contains_key("meta")
        && !object.contains_key("agents")
        && !object.contains_key("models")
        && !object.contains_key("auth")
        && object.len() <= 4
}

/// A merge base we must NOT write a small gateway patch into: an empty object
/// (the read failed, or caught the gateway mid-write) or a gateway-only stub.
/// `is_thin` alone missed the empty-`{}` case — so backup recovery never fired
/// and the merge clobbered the real config with a 123-byte stub the engine then
/// rejected (`gateway.auth: Invalid input` → startup_failed → connection
/// refused).
fn openclaw_config_root_is_empty_or_thin(root: &Value) -> bool {
    match root.as_object() {
        Some(object) => object.is_empty() || openclaw_config_root_is_thin(root),
        None => true,
    }
}

/// A provisioned engine config is several KB (models/agents/plugins/secrets); a
/// gateway-only stub is ~123 bytes. The clobber guard refuses to shrink an
/// on-disk config at/above `SUBSTANTIAL_CONFIG_MIN_BYTES` down to a result below
/// `STUB_CONFIG_MAX_BYTES`. The wide gap means normal multi-KB patches never
/// trip it and a brand-new (absent) config writes freely.
const SUBSTANTIAL_CONFIG_MIN_BYTES: usize = 1024;
const STUB_CONFIG_MAX_BYTES: usize = 512;

fn openclaw_config_backup_is_recoverable(root: &Value) -> bool {
    let Some(object) = root.as_object() else {
        return false;
    };
    object.contains_key("gateway")
        && object.contains_key("meta")
        && (object.contains_key("agents")
            || object.contains_key("models")
            || object.contains_key("auth"))
}

fn load_openclaw_config_backup_for_patch(path: &std::path::Path) -> Option<Value> {
    let parent = path.parent()?;
    let mut candidates = fs::read_dir(parent)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("uniopc-engine.json.bak") || name.starts_with("uniopc-engine.json.backup.") {
                Some(entry.path())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().find_map(|candidate| {
        let raw = fs::read_to_string(candidate).ok()?;
        let value = serde_json::from_str::<Value>(&raw).ok()?;
        openclaw_config_backup_is_recoverable(&value).then_some(value)
    })
}

fn merge_json_object(target: &mut Value, patch: Value) -> Result<(), String> {
    let target_object = target
        .as_object_mut()
        .ok_or_else(|| "Uniopc 引擎 config root 必须是对象。".to_string())?;
    let patch_object = patch
        .as_object()
        .ok_or_else(|| "Uniopc 引擎 config patch 必须是对象。".to_string())?;
    for (key, value) in patch_object {
        if value.is_null() {
            target_object.remove(key);
            continue;
        }
        match (target_object.get_mut(key), value) {
            (Some(target_child @ Value::Object(_)), Value::Object(_)) => {
                merge_json_object(target_child, value.clone())?;
            }
            (_, value @ Value::Object(_)) => {
                // Fresh insert of an object: merge into an empty object so
                // null-valued keys are dropped (delete-sentinel semantics)
                // instead of persisted verbatim. Inserting `{...,"auth":null}`
                // literally makes the engine reject the whole config
                // (`gateway.auth: Invalid input`) and refuse to start — the
                // old behavior when the merge base lacked the key (empty root).
                let mut fresh = Value::Object(serde_json::Map::new());
                merge_json_object(&mut fresh, value.clone())?;
                target_object.insert(key.clone(), fresh);
            }
            (_, value) => {
                target_object.insert(key.clone(), value.clone());
            }
        }
    }
    Ok(())
}

fn merge_json_object_changed(target: &mut Value, patch: Value) -> Result<bool, String> {
    let before = target.clone();
    merge_json_object(target, patch)?;
    Ok(*target != before)
}

fn local_gateway_auth_repair_needed(snapshot: &GatewayConnectionSnapshot) -> bool {
    if snapshot.status == GatewayConnectionStatus::Connected {
        return false;
    }
    let known_auth_error = matches!(
        snapshot.last_error_code.as_deref(),
        Some(
            GATEWAY_ERROR_CODE_AUTH_TOKEN_MISMATCH
                | GATEWAY_ERROR_CODE_AUTH_TOKEN_MISSING
                | GATEWAY_ERROR_CODE_AUTH_UNAUTHORIZED
        )
    );
    let stale_process_password = snapshot.last_error.as_deref().is_some_and(|error| {
        let error = error.to_ascii_lowercase();
        error.contains("password_mismatch") || error.contains("password mismatch")
    });
    known_auth_error || stale_process_password
}

#[tauri::command]
pub async fn openclaw_effective_status(
    _app: AppHandle,
    input: GatewayConnectionProfileInput,
) -> Result<OpenClawEffectiveStatus, String> {
    let profile = require_profile(input.profile.as_deref())?;
    let default_config = GatewayConnectionConfig::not_configured(profile.clone());
    let openclaw_config = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile)).ok();
    let effective_config = openclaw_config.as_ref().and_then(|value| {
        effective_connection_config_from_openclaw_config(&default_config, value).ok()
    });
    let resolved =
        resolve_effective_connection_endpoint(&default_config, openclaw_config.as_ref(), None).ok();
    let app_endpoint_url = resolved.as_ref().map(|value| value.endpoint.url.clone());
    let app_connection_port = app_endpoint_url
        .as_deref()
        .and_then(port_from_gateway_ws_url);
    let openclaw_config_path = openclaw_gateway::openclaw_config_path_for_profile(Some(&profile))?;
    let openclaw_config_exists = openclaw_config_path.exists();
    let config_metadata = openclaw_gateway::config_metadata(Some(&profile)).ok();
    let config_ws_url = config_metadata.as_ref().map(|value| value.ws_url.clone());
    let config_port = config_ws_url.as_deref().and_then(port_from_gateway_ws_url);
    let config_auth_mode = config_metadata
        .as_ref()
        .map(|value| value.auth_mode.clone());
    let config_has_token = config_metadata
        .as_ref()
        .is_some_and(|value| value.has_token);
    let config_has_password = config_metadata
        .as_ref()
        .is_some_and(|value| value.has_password);

    let mut mismatches = Vec::new();
    if input.gateway_port.is_some() && config_port.is_some() && input.gateway_port != config_port {
        mismatches.push(format!(
            "云端/工作空间提示端口 {:?} 与 Uniopc 引擎 config 端口 {:?} 不一致。",
            input.gateway_port, config_port
        ));
    }
    if !openclaw_config_exists {
        mismatches.push("当前 profile 没有 Uniopc 引擎 config 文件。".to_string());
    }

    Ok(OpenClawEffectiveStatus {
        profile,
        requested_gateway_port: input.gateway_port,
        app_connection_mode: effective_config
            .as_ref()
            .map(|value| value.mode)
            .unwrap_or(GatewayConnectionMode::NotConfigured),
        app_connection_endpoint_url: app_endpoint_url,
        app_connection_port,
        app_connection_has_token: config_has_token || config_has_password,
        app_connection_updated_at: Utc::now().to_rfc3339(),
        openclaw_config_path: openclaw_config_path.to_string_lossy().to_string(),
        openclaw_config_exists,
        openclaw_config_ws_url: config_ws_url,
        openclaw_config_port: config_port,
        openclaw_config_auth_mode: config_auth_mode,
        openclaw_config_has_token: config_has_token,
        openclaw_config_has_password: config_has_password,
        mismatches,
    })
}

#[tauri::command]
pub async fn openclaw_connection_snapshot(
    app: AppHandle,
    input: GatewayConnectionProfileInput,
) -> Result<GatewayConnectionSnapshot, String> {
    let profile = require_profile(input.profile.as_deref())?;
    let config = GatewayConnectionConfig::not_configured(profile.clone());
    let openclaw_config = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile)).ok();
    let effective_config = openclaw_config
        .as_ref()
        .and_then(|value| effective_connection_config_from_openclaw_config(&config, value).ok());
    if let Some(effective_config) = effective_config.as_ref() {
        ensure_remote_ssh_tunnel_if_needed(&app, effective_config).await?;
        return Ok(
            probe_effective_connection_snapshot(&app, &config, openclaw_config.as_ref()).await,
        );
    }

    let inferred = local_config_for_profile(&profile);
    let snapshot = probe_effective_connection_snapshot(&app, &inferred, None).await;
    if snapshot.status == GatewayConnectionStatus::Connected {
        save_openclaw_gateway_config_patch(
            &profile,
            local_openclaw_gateway_config_patch(&profile, inferred.local_port),
        )?;
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn openclaw_connection_set_mode(
    app: AppHandle,
    input: GatewayConnectionModeInput,
) -> Result<GatewayConnectionSnapshot, String> {
    let profile = require_profile(input.profile.as_deref())?;
    save_openclaw_gateway_config_patch(&profile, mode_openclaw_gateway_config_patch(input.mode))?;
    if input.mode != GatewayConnectionMode::RemoteSshTunnel {
        app.state::<GatewayTunnelSupervisor>().stop().await;
    }
    let openclaw_config = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile)).ok();
    let config = GatewayConnectionConfig::not_configured(profile);
    Ok(probe_effective_connection_snapshot(&app, &config, openclaw_config.as_ref()).await)
}

#[tauri::command]
pub async fn openclaw_connection_save_remote_direct(
    app: AppHandle,
    input: GatewayRemoteDirectInput,
) -> Result<GatewayConnectionSnapshot, String> {
    let profile = require_profile(input.profile.as_deref())?;
    save_openclaw_gateway_config_patch(
        &profile,
        remote_direct_openclaw_gateway_config_patch(&input.remote_url, input.auth_token.clone())?,
    )?;
    app.state::<GatewayTunnelSupervisor>().stop().await;
    let openclaw_config = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile)).ok();
    let config = GatewayConnectionConfig::not_configured(profile);
    Ok(probe_effective_connection_snapshot(&app, &config, openclaw_config.as_ref()).await)
}

#[tauri::command]
pub async fn openclaw_connection_save_remote_ssh(
    app: AppHandle,
    input: GatewayRemoteSshInput,
) -> Result<GatewayConnectionSnapshot, String> {
    parse_ssh_target(&input.ssh_target)?;
    if input.ssh_remote_host.trim().is_empty() {
        return Err("SSH remote host 不能为空。".to_string());
    }
    let profile = require_profile(input.profile.as_deref())?;
    save_openclaw_gateway_config_patch(
        &profile,
        remote_ssh_openclaw_gateway_config_patch(
            &input.ssh_target,
            "",
            input.ssh_remote_port,
            input.ssh_local_port,
            input.auth_token.clone(),
        )?,
    )?;
    let openclaw_config = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile)).ok();
    let default_config = GatewayConnectionConfig::not_configured(profile);
    let config = openclaw_config
        .as_ref()
        .and_then(|value| {
            effective_connection_config_from_openclaw_config(&default_config, value).ok()
        })
        .unwrap_or(default_config);
    ensure_remote_ssh_tunnel_if_needed(&app, &config).await?;
    Ok(probe_effective_connection_snapshot(&app, &config, openclaw_config.as_ref()).await)
}

#[tauri::command]
pub async fn openclaw_connection_start_local(
    app: AppHandle,
    input: GatewayConnectionProfileInput,
) -> Result<GatewayConnectionSnapshot, String> {
    let profile = require_local_gateway_start_profile(input.profile.as_deref())?;
    let started_at = Instant::now();
    crate::services::engine_startup_metrics::record_startup_event(
        &app,
        &profile,
        "startup_requested",
        "started",
        0,
        None,
    );
    let metric_timing = std::sync::Arc::new(std::sync::Mutex::new(None));
    let runtime_preparation_ms = std::sync::Arc::new(AtomicU64::new(0));
    let provision_count = std::sync::Arc::new(AtomicU64::new(0));
    let spawn_count_before = app.state::<model::GatewaySupervisor>().spawn_count();
    let coordinator_app = app.clone();
    let coordinator = coordinator_app
        .state::<crate::services::startup_coordinator::GatewayStartupCoordinator>();
    let operation_profile = profile.clone();
    let registered_profile = profile.clone();
    let operation_timing = metric_timing.clone();
    let operation_runtime_preparation_ms = runtime_preparation_ms.clone();
    let operation_provisions = provision_count.clone();
    let finalizer_app = app.clone();
    let preparation_app = app.clone();
    let preparation_event_app = app.clone();
    let preparation_profile = profile.clone();
    let preparation_timing = runtime_preparation_ms.clone();
    let cleanup_app = app.clone();
    let result = coordinator
        .run_profile_with_preparation_hooks(profile.clone(), move |generation| {
            let _ = local_gateway_lifecycle().activate(&registered_profile, generation);
        }, move |_| async move {
            let runtime_started_at = Instant::now();
            crate::services::engine_startup_metrics::record_startup_event(
                &preparation_event_app,
                &preparation_profile,
                "runtime_preparation",
                "started",
                elapsed_ms(started_at),
                None,
            );
            let result = prepare_bundled_runtime(preparation_app).await;
            let elapsed = elapsed_ms(runtime_started_at);
            preparation_timing.store(elapsed, Ordering::SeqCst);
            crate::services::engine_startup_metrics::record_startup_event(
                &preparation_event_app,
                &preparation_profile,
                "runtime_preparation",
                if result.is_ok() { "ready" } else { "failed" },
                elapsed_ms(started_at),
                result.as_ref().err().cloned(),
            );
            result
        }, move |flight| async move {
            openclaw_connection_start_local_leader(
                app,
                input,
                operation_profile,
                started_at,
                flight,
                operation_timing,
                operation_runtime_preparation_ms,
                operation_provisions,
            )
            .await
        }, move |result, activity| {
            let metrics = metric_timing
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
                .unwrap_or_else(|| EngineStartupTiming {
                    runtime_preparation_ms: runtime_preparation_ms.load(Ordering::SeqCst),
                    ..Default::default()
                });
            let failure = result.as_ref().err().cloned().or_else(|| match result {
                Ok(snapshot) if snapshot.status != GatewayConnectionStatus::Connected => {
                    let cause = snapshot
                        .last_error
                        .as_deref()
                        .unwrap_or(snapshot.message.as_str());
                    Some(format!(
                        "Gateway 未就绪: {:?}; endpoint={}; cause={cause}",
                        snapshot.status,
                        snapshot.endpoint_url.as_deref().unwrap_or("unknown")
                    ))
                }
                _ => None,
            });
            crate::services::engine_startup_metrics::record_startup_event(
                &finalizer_app,
                &profile,
                "startup_finished",
                if failure.is_some() { "failed" } else { "connected" },
                elapsed_ms(started_at),
                failure.clone(),
            );
            crate::services::engine_startup_metrics::record_startup_metric(
                &finalizer_app,
                crate::services::engine_startup_metrics::startup_metric(
                    profile,
                    metrics.cold_start,
                    metrics.preflight_ms,
                    metrics.lock_wait_ms,
                    metrics.runtime_preparation_ms,
                    metrics.gateway_spawn_ms,
                    metrics.gateway_ready_ms,
                    elapsed_ms(started_at),
                    failure,
                    crate::services::engine_startup_metrics::StartupActivity {
                        singleflight_leaders: activity.leaders,
                        singleflight_followers: activity.followers,
                        singleflight_joined: activity.joined,
                        duplicate_suppressed: activity.suppressed,
                        provision_count: provision_count.load(Ordering::SeqCst),
                        spawn_count: finalizer_app
                            .state::<model::GatewaySupervisor>()
                            .spawn_count()
                            .saturating_sub(spawn_count_before),
                    },
                ),
            );
        })
        .await;
    if let Ok(snapshot) = &result {
        if snapshot.status == GatewayConnectionStatus::Connected {
            if let Some(runtime_id) = cleanup_app
                .state::<model::GatewaySupervisor>()
                .running_runtime_id_if_active()
                .await
            {
                crate::services::openclaw_bundled_runtime::
                    cleanup_stale_runtime_versions_after_gateway_connected(&runtime_id);
            }
        }
    }
    result
}

async fn openclaw_connection_start_local_leader(
    app: AppHandle,
    input: GatewayConnectionProfileInput,
    profile: String,
    started_at: Instant,
    flight: crate::services::startup_coordinator::StartupFlightContext,
    metric_timing: std::sync::Arc<std::sync::Mutex<Option<EngineStartupTiming>>>,
    runtime_preparation_ms: std::sync::Arc<AtomicU64>,
    provision_count: std::sync::Arc<AtomicU64>,
) -> Result<GatewayConnectionSnapshot, String> {
    let mut metrics = EngineStartupTiming::default();
    metrics.runtime_preparation_ms = runtime_preparation_ms.load(Ordering::SeqCst);
    let generation = flight.generation();
    let result = openclaw_connection_start_local_for_profile(
        app.clone(),
        input,
        profile.clone(),
        started_at,
        generation,
        &flight,
        &mut metrics,
        &provision_count,
    )
    .await;
    *metric_timing
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(metrics);
    result
}

#[derive(Clone, Default)]
struct EngineStartupTiming {
    cold_start: bool,
    preflight_ms: u64,
    lock_wait_ms: u64,
    runtime_preparation_ms: u64,
    gateway_spawn_ms: Option<u64>,
    gateway_ready_ms: u64,
}

fn elapsed_ms(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

async fn openclaw_connection_start_local_for_profile(
    app: AppHandle,
    input: GatewayConnectionProfileInput,
    profile: String,
    started_at: Instant,
    generation: u64,
    flight: &crate::services::startup_coordinator::StartupFlightContext,
    metrics: &mut EngineStartupTiming,
    provision_count: &AtomicU64,
) -> Result<GatewayConnectionSnapshot, String> {
    use crate::services::startup_readiness;
    metrics.lock_wait_ms = elapsed_ms(started_at);
    let ensure_current = || {
        flight.checkpoint()?;
        local_gateway_lifecycle().check(generation)
    };
    ensure_current()?;
    let _mutation_guard = local_gateway_lifecycle().lock_current(generation).await?;
    let preflight_started_at = Instant::now();
    crate::services::uniopc_runtime_paths::write_active_profile_key(&profile)?;
    let config = local_config_for_profile(&profile);
    app.state::<GatewayTunnelSupervisor>().stop().await;
    ensure_current()?;
    let existing = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile))
        .map_err(|_| "gateway_startup_profile_config_read_failed".to_string())?;
    let profile_is_set_up = model::openclaw_profile_config_is_initialized(&existing);
    let supervisor = app.state::<model::GatewaySupervisor>();
    let running_profile = supervisor.running_profile().await;
    let running = supervisor.is_running().await;
    let engine_matches_profile =
        owned_engine_matches_profile(&profile, running_profile.as_deref(), running)
            && supervisor.running_runtime_matches_active().await;
    ensure_current()?;
    metrics.cold_start = !engine_matches_profile;
    metrics.preflight_ms = elapsed_ms(preflight_started_at);
    let backend = LocalStartupBackend {
        app: &app,
        config: std::sync::Mutex::new(config),
        input: &input,
        generation,
        flight,
        provision_count,
        phases: Default::default(),
    };
    // Production and tests share activation branch selection, onboard/spawn
    // ownership, the deadline, and every postcondition through this entrypoint.
    let result = startup_readiness::start(
        &backend,
        profile_is_set_up,
        engine_matches_profile,
        GATEWAY_STARTUP_BUDGET,
    )
    .await?;
    ensure_current()?;
    metrics.preflight_ms = metrics.preflight_ms.saturating_add(
        result
            .preflight_elapsed
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
    );
    metrics.gateway_spawn_ms = result
        .spawn_elapsed
        .map(|d| d.as_millis().try_into().unwrap_or(u64::MAX));
    metrics.gateway_ready_ms = result
        .ready_elapsed
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    Ok(result.snapshot)
}


pub async fn openclaw_connection_start_local_for_runtime(
    app: AppHandle,
    input: GatewayConnectionProfileInput,
) -> Result<GatewayConnectionSnapshot, String> {
    openclaw_connection_start_local(app, input).await
}

// One machine, one engine: the local gateway always uses the single fixed
// port, which `local_for_profile` already assigns. Cloud-recorded / per-profile
// port hints are intentionally not consulted — stale hints used to poison
// connections after the gateway moved.
fn local_config_for_profile(profile: &str) -> GatewayConnectionConfig {
    GatewayConnectionConfig::local_for_profile(profile.to_string())
}

#[tauri::command]
pub async fn openclaw_connection_stop_local(
    app: AppHandle,
    input: GatewayConnectionProfileInput,
) -> Result<GatewayConnectionSnapshot, String> {
    let profile = require_profile(input.profile.as_deref())?;
    let _ = model::openclaw_stop_gateway_for_profile(&app, &profile).await?;
    let config = GatewayConnectionConfig::not_configured(profile.clone());
    let openclaw_config = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile)).ok();
    Ok(probe_effective_connection_snapshot(&app, &config, openclaw_config.as_ref()).await)
}

#[tauri::command]
pub async fn openclaw_connection_refresh(
    app: AppHandle,
    input: GatewayConnectionProfileInput,
) -> Result<GatewayConnectionSnapshot, String> {
    openclaw_connection_snapshot(app, input).await
}

#[derive(serde::Deserialize)]
pub struct MobileLanInput {
    pub profile: Option<String>,
    pub enabled: bool,
}

/// Turn LAN mobile access on/off for a profile (the Mobile page "允许手机连接此
/// 电脑" toggle). On = the gateway binds the LAN so a same-Wi-Fi phone can reach
/// it (still password-guarded); off = hardened loopback-only. Restarts the
/// gateway to apply and returns the resulting state incl. the LAN URL to show.
#[tauri::command]
pub(crate) async fn openclaw_mobile_lan_set_enabled(
    app: AppHandle,
    input: MobileLanInput,
) -> Result<model::MobileLanState, model::MobileLanSetError> {
    let profile = require_profile(input.profile.as_deref())
        .map_err(|message| model::MobileLanSetError::new(message, None, true))?;
    model::set_mobile_lan_enabled(&app, &profile, input.enabled).await
}

/// Read the current LAN mobile-access state (for the Mobile page to render the
/// toggle + LAN URL without flipping anything).
#[tauri::command]
pub(crate) async fn openclaw_mobile_lan_status(
    input: GatewayConnectionProfileInput,
) -> Result<model::MobileLanState, String> {
    let profile = require_profile(input.profile.as_deref())?;
    Ok(model::mobile_lan_state(&profile))
}

#[tauri::command]
pub async fn openclaw_connection_test_remote(
    app: AppHandle,
    input: GatewayConnectionProfileInput,
) -> Result<GatewayConnectionSnapshot, String> {
    let profile = require_profile(input.profile.as_deref())?;
    let default_config = GatewayConnectionConfig::not_configured(profile.clone());
    let openclaw_config = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile)).ok();
    let effective_config = openclaw_config
        .as_ref()
        .and_then(|value| {
            effective_connection_config_from_openclaw_config(&default_config, value).ok()
        })
        .unwrap_or(default_config);
    ensure_remote_ssh_tunnel_if_needed(&app, &effective_config).await?;
    Ok(
        probe_effective_connection_snapshot(&app, &effective_config, openclaw_config.as_ref())
            .await,
    )
}

pub async fn openclaw_connection_test_remote_for_runtime(
    app: AppHandle,
    input: GatewayConnectionProfileInput,
) -> Result<GatewayConnectionSnapshot, String> {
    openclaw_connection_test_remote(app, input).await
}

async fn ensure_remote_ssh_tunnel_if_needed(
    app: &AppHandle,
    config: &GatewayConnectionConfig,
) -> Result<(), String> {
    if config.mode == GatewayConnectionMode::RemoteSshTunnel {
        app.state::<GatewayTunnelSupervisor>()
            .ensure(config)
            .await?;
    }
    Ok(())
}

fn normalize_optional_secret(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn logout_during_activation_prevents_old_profile_mutation_without_waiting() {
        use std::sync::Arc;
        let lifecycle = Arc::new(LocalGatewayLifecycle::default());
        let active = Arc::new(tokio::sync::Mutex::new(Some("old")));
        let generation = lifecycle.generation();
        let (release, activation) = tokio::sync::oneshot::channel::<()>();
        let start_lifecycle = lifecycle.clone();
        let start_active = active.clone();
        let old_start = tokio::spawn(async move {
            activation.await.unwrap();
            let _guard = start_lifecycle.lock_current(generation).await?;
            *start_active.lock().await = Some("old");
            Ok::<_, String>(())
        });
        {
            lifecycle.invalidate(generation + 1);
            let _guard = tokio::time::timeout(
                Duration::from_millis(100),
                lifecycle.mutations.lock(),
            )
            .await
            .expect("logout must not wait for activation");
            *active.lock().await = None;
        }
        release.send(()).unwrap();
        assert!(old_start.await.unwrap().is_err());
        assert_eq!(*active.lock().await, None);
        let _guard = lifecycle.lock_current(lifecycle.generation()).await.unwrap();
        *active.lock().await = Some("new");
        assert!(lifecycle.check(generation).is_err());
        assert_eq!(*active.lock().await, Some("new"));
    }

    #[tokio::test]
    async fn logout_waits_for_owned_mutations_before_cleanup() {
        use std::sync::Arc;
        let lifecycle = Arc::new(LocalGatewayLifecycle::default());
        let active = Arc::new(tokio::sync::Mutex::new(Some("old")));
        let generation = lifecycle.generation();
        let guard = lifecycle.lock_current(generation).await.unwrap();
        let logout_lifecycle = lifecycle.clone();
        let logout_active = active.clone();
        let (invalidated, observed) = tokio::sync::oneshot::channel();
        let logout = tokio::spawn(async move {
            logout_lifecycle.invalidate(generation + 1);
            invalidated.send(()).unwrap();
            let _guard = logout_lifecycle.mutations.lock().await;
            *logout_active.lock().await = None;
            "stopped"
        });
        observed.await.unwrap();
        assert!(lifecycle.check(generation).is_err());
        assert!(!logout.is_finished(), "cleanup must wait for existing mutation");
        let next_lifecycle = lifecycle.clone();
        let next_active = active.clone();
        let next_start = tokio::spawn(async move {
            let _guard = next_lifecycle.lock_current(next_lifecycle.generation()).await.unwrap();
            *next_active.lock().await = Some("new");
        });
        drop(guard);
        assert_eq!(logout.await.unwrap(), "stopped");
        next_start.await.unwrap();
        assert_eq!(*active.lock().await, Some("new"));
        assert!(lifecycle.lock_current(generation).await.is_err());
        assert!(lifecycle.lock_current(lifecycle.generation()).await.is_ok());
    }

    #[test]
    fn newer_profile_intent_invalidates_the_previous_generation() {
        let lifecycle = LocalGatewayLifecycle::default();
        lifecycle.activate("profile-a", 1).unwrap();
        lifecycle.activate("profile-a", 1).unwrap();
        assert!(lifecycle.activate("profile-b", 1).is_err());
        lifecycle.activate("profile-b", 2).unwrap();
        assert!(lifecycle.activate("profile-a", 1).is_err());
        assert!(lifecycle.check(1).is_err());
        assert!(lifecycle.check(2).is_ok());
    }

    #[test]
    fn connected_reuse_requires_a_live_owned_matching_profile() {
        assert!(!owned_engine_matches_profile("owner", None, true));
        assert!(!owned_engine_matches_profile("owner", Some("other"), true));
        assert!(!owned_engine_matches_profile("owner", Some("owner"), false));
        assert!(owned_engine_matches_profile("owner", Some("owner"), true));
    }

    #[test]
    fn local_gateway_start_requires_a_workspace_profile() {
        assert!(require_local_gateway_start_profile(None).is_err());
        assert!(require_local_gateway_start_profile(Some("   ")).is_err());
        assert_eq!(
            require_local_gateway_start_profile(Some("owner-profile")).unwrap(),
            "owner-profile"
        );
    }

    #[test]
    fn write_config_atomic_writes_content_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("uniopc-cfg-atomic-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("openclaw.json");
        write_config_atomic(&path, "{\"gateway\":{}}").expect("atomic write should succeed");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"gateway\":{}}");
        // Overwrite once more; still exactly the new content and no stray temp.
        write_config_atomic(&path, "{\"gateway\":{\"mode\":\"local\"}}").unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"gateway\":{\"mode\":\"local\"}}"
        );
        let leftover_temp = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp-"));
        assert!(!leftover_temp, "temp file must be renamed away");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_gateway_port_from_ws_url() {
        assert_eq!(
            port_from_gateway_ws_url("ws://127.0.0.1:19263"),
            Some(19263)
        );
        assert_eq!(
            port_from_gateway_ws_url("wss://gateway.example.test:443/path"),
            Some(443)
        );
    }

    #[test]
    fn engine_port_ignores_cloud_hints_and_stale_config() {
        let fixed = crate::services::openclaw_connection::UNIOPC_ENGINE_PREFERRED_PORT;
        // One machine, one engine: the local config always resolves to the
        // single fixed port regardless of profile. Cloud-recorded / stale port
        // hints can no longer steer it — there is no longer any hint input.
        assert_eq!(local_config_for_profile("bootiful-wtf-4a58b3ae").local_port, fixed);
        assert_eq!(local_config_for_profile("lanjinyu01-32bb573f").local_port, fixed);
        assert_eq!(local_config_for_profile("owner-profile").local_port, fixed);
    }

    #[test]
    fn remote_direct_save_patch_targets_official_openclaw_config() {
        let patch = remote_direct_openclaw_gateway_config_patch(
            "https://owner.example.ts.net:19999/control/",
            Some("remote-token".to_string()),
        )
        .unwrap();

        assert_eq!(patch["gateway"]["mode"], "remote");
        assert_eq!(patch["gateway"]["remote"]["transport"], "direct");
        assert_eq!(
            patch["gateway"]["remote"]["url"],
            "wss://owner.example.ts.net:19999/control"
        );
        assert_eq!(patch["gateway"]["remote"]["token"], "remote-token");
        assert!(patch["gateway"]["remote"]["password"].is_null());
    }

    #[test]
    fn remote_ssh_save_patch_targets_official_openclaw_config() {
        let patch = remote_ssh_openclaw_gateway_config_patch(
            "lan@example.test:2222",
            "/Users/lan/.ssh/id_ed25519",
            18790,
            18791,
            Some("ssh-token".to_string()),
        )
        .unwrap();

        assert_eq!(patch["gateway"]["mode"], "remote");
        assert_eq!(patch["gateway"]["remote"]["transport"], "ssh");
        assert_eq!(patch["gateway"]["remote"]["url"], "ws://127.0.0.1:18791");
        assert_eq!(patch["gateway"]["remote"]["remotePort"], 18790);
        assert_eq!(
            patch["gateway"]["remote"]["sshTarget"],
            "lan@example.test:2222"
        );
        assert_eq!(
            patch["gateway"]["remote"]["sshIdentity"],
            "/Users/lan/.ssh/id_ed25519"
        );
        assert_eq!(patch["gateway"]["remote"]["token"], "ssh-token");
        assert!(patch["gateway"]["remote"]["password"].is_null());
    }

    #[test]
    fn empty_remote_credentials_patch_removes_existing_token_and_legacy_password() {
        let mut target = json!({
            "gateway": {
                "mode": "remote",
                "remote": {
                    "transport": "direct",
                    "url": "wss://owner.example.ts.net",
                    "token": "old-token",
                    "password": "old-password"
                }
            }
        });
        let patch = remote_direct_openclaw_gateway_config_patch("wss://owner.example.ts.net", None)
            .unwrap();

        merge_json_object(&mut target, patch).unwrap();

        assert_eq!(target["gateway"]["remote"]["transport"], "direct");
        assert!(target["gateway"]["remote"].get("token").is_none());
        assert!(target["gateway"]["remote"].get("password").is_none());
    }

    #[test]
    fn local_patch_removes_stale_remote_transport() {
        let mut target = json!({
            "gateway": {
                "mode": "remote",
                "auth": {
                    "token": "local-token"
                },
                "remote": {
                    "transport": "direct",
                    "url": "wss://owner.example.ts.net"
                }
            }
        });

        merge_json_object(&mut target, local_openclaw_gateway_config_patch("test-profile", 19263)).unwrap();

        assert_eq!(target["gateway"]["mode"], "local");
        assert_eq!(target["gateway"]["bind"], "loopback");
        assert_eq!(target["gateway"]["port"], 19263);
        // Local basic-auth keeps its password out of the config; the patch clears
        // any stale `gateway.auth` (here a leftover device token) so the config
        // stays stable and the gateway never restarts on a config change.
        assert!(target["gateway"].get("auth").is_none());
        assert!(target["gateway"].get("remote").is_none());
    }

    #[test]
    fn desktop_startup_defaults_skip_unused_control_ui_without_changing_tools() {
        let mut config = json!({"gateway": {"mode": "local"}, "plugins": {"entries": {"documents": {"enabled": true}}}});
        let plugins = config["plugins"].clone();
        let patch = json!({"gateway": {"mode": "local"}});
        assert!(merge_gateway_config_patch(&mut config, patch.clone()).unwrap());
        assert_eq!(config.pointer("/gateway/controlUi/enabled"), Some(&json!(false)));
        assert_eq!(config["plugins"], plugins);
        assert!(!merge_gateway_config_patch(&mut config, patch).unwrap());
    }

    #[test]
    fn desktop_startup_defaults_preserve_explicit_control_ui_and_remote_settings() {
        for settings in [json!({"enabled": true}), json!({"enabled": false}), json!({"root": "/custom-ui"}), json!({"allowedOrigins": ["https://example.test"]})] {
            let mut config = json!({"gateway": {"mode": "local", "controlUi": settings}});
            let original = config.clone();
            assert!(!merge_gateway_config_patch(&mut config, json!({"gateway": {"mode": "local"}})).unwrap());
            assert_eq!(config, original);
        }
        let mut config = json!({"gateway": {"mode": "remote"}});
        assert!(!merge_gateway_config_patch(&mut config, json!({"gateway": {"mode": "remote"}})).unwrap());
        assert!(config.pointer("/gateway/controlUi").is_none());
        assert!(merge_gateway_config_patch(&mut config, json!({"gateway": {"mode": "local", "controlUi": {"enabled": true}}})).unwrap());
        assert_eq!(config.pointer("/gateway/controlUi/enabled"), Some(&json!(true)));
    }

    #[test]
    fn pre_spawn_static_config_has_no_restart_causing_follow_up_write() {
        let mut config = json!({});
        let mut first_patch =
            model::build_member_profile_static_startup_config_patch(&config, "profile-a");
        merge_json_object(&mut first_patch, json!({ "gateway": { "mode": "local" } })).unwrap();
        assert!(merge_gateway_config_patch(&mut config, first_patch).unwrap());

        let mut post_ready_patch =
            model::build_member_profile_static_startup_config_patch(&config, "profile-a");
        merge_json_object(
            &mut post_ready_patch,
            json!({ "gateway": { "mode": "local" } }),
        )
        .unwrap();
        assert!(
            !merge_gateway_config_patch(&mut config, post_ready_patch).unwrap(),
            "PATH, default model and plugin registration must already be stable at first ready"
        );
    }

    #[test]
    fn local_gateway_auth_errors_force_reprovision_even_when_process_is_running() {
        let config = GatewayConnectionConfig::local("lanjinyu01-32bb573f".to_string(), 19183);
        let missing_token = GatewayConnectionSnapshot::from_config(
            &config,
            GatewayConnectionStatus::Unavailable,
            None,
            Some("Gateway health 请求失败: unauthorized: gateway token missing".to_string()),
        );
        let mismatched_token = GatewayConnectionSnapshot::from_config(
            &config,
            GatewayConnectionStatus::Unavailable,
            None,
            Some("gateway auth token_mismatch".to_string()),
        );
        let stale_process_password = GatewayConnectionSnapshot::from_config(
            &config,
            GatewayConnectionStatus::Unavailable,
            None,
            Some("gateway auth password_mismatch".to_string()),
        );
        let connected = GatewayConnectionSnapshot::from_config(
            &config,
            GatewayConnectionStatus::Connected,
            None,
            None,
        );

        assert!(local_gateway_auth_repair_needed(&missing_token));
        assert!(local_gateway_auth_repair_needed(&mismatched_token));
        assert!(local_gateway_auth_repair_needed(&stale_process_password));
        assert!(!local_gateway_auth_repair_needed(&connected));
    }

    #[test]
    fn gateway_connection_errors_are_classified_into_structured_codes() {
        let config = GatewayConnectionConfig::local("lanjinyu01-32bb573f".to_string(), 19183);
        let case = |error: &str| {
            GatewayConnectionSnapshot::from_config(
                &config,
                GatewayConnectionStatus::Unavailable,
                None,
                Some(error.to_string()),
            )
            .last_error_code
        };

        // Missing-token variants classify as repairable, even when the raw
        // text also mentions "unauthorized".
        assert_eq!(
            case("Gateway health 请求失败: unauthorized: gateway token missing").as_deref(),
            Some(GATEWAY_ERROR_CODE_AUTH_TOKEN_MISSING),
        );
        assert_eq!(
            case("device identity required").as_deref(),
            Some(GATEWAY_ERROR_CODE_AUTH_TOKEN_MISSING),
        );
        // Genuine mismatch is classified independently; local start repairs it,
        // while remote snapshots remain blocked by the frontend policy.
        assert_eq!(case("gateway auth token_mismatch").as_deref(), Some("auth_token_mismatch"));
        // Bare unauthorized keeps its own code.
        assert_eq!(
            case("Gateway health 请求失败: unauthorized").as_deref(),
            Some(GATEWAY_ERROR_CODE_AUTH_UNAUTHORIZED),
        );
        // Unrelated errors carry no code.
        assert_eq!(case("connection refused (os error 61)"), None);

        // Connected snapshots never need auth repair regardless of stale text.
        let connected = GatewayConnectionSnapshot::from_config(
            &config,
            GatewayConnectionStatus::Connected,
            None,
            None,
        );
        assert_eq!(connected.last_error_code, None);
    }

    #[test]
    fn thin_openclaw_config_roots_are_repaired_from_full_backups_before_patch() {
        let thin = json!({
            "gateway": {
                "mode": "local",
                "port": 19183
            }
        });
        let full = json!({
            "meta": {},
            "gateway": {
                "mode": "local",
                "auth": {
                    "token": "gateway-token"
                }
            },
            "agents": {},
            "models": {}
        });

        assert!(openclaw_config_root_is_thin(&thin));
        assert!(openclaw_config_backup_is_recoverable(&full));
    }

    #[test]
    fn merge_strips_nested_nulls_when_inserting_into_empty_root() {
        // Regression: merging the local gateway patch (with `auth`/`remote`
        // delete-sentinels) into an EMPTY root used to insert them verbatim,
        // producing `{"gateway":{...,"auth":null,"remote":null}}` — a config the
        // engine rejects with `gateway.auth: Invalid input`.
        let mut root = json!({});
        merge_json_object(
            &mut root,
            json!({ "gateway": { "mode": "local", "bind": "loopback", "port": 28790, "remote": null, "auth": null } }),
        )
        .unwrap();
        let gateway = root.get("gateway").and_then(Value::as_object).unwrap();
        assert_eq!(gateway.get("mode").and_then(Value::as_str), Some("local"));
        assert_eq!(gateway.get("port").and_then(Value::as_i64), Some(28790));
        assert!(!gateway.contains_key("auth"), "auth:null must not persist");
        assert!(!gateway.contains_key("remote"), "remote:null must not persist");
    }

    #[test]
    fn merge_still_strips_nulls_when_key_already_exists() {
        // The pre-existing-object path already recursed; keep it working.
        let mut root = json!({ "gateway": { "auth": { "password": "stale" }, "port": 1 } });
        merge_json_object(&mut root, json!({ "gateway": { "auth": null, "port": 28790 } })).unwrap();
        let gateway = root.get("gateway").and_then(Value::as_object).unwrap();
        assert!(!gateway.contains_key("auth"));
        assert_eq!(gateway.get("port").and_then(Value::as_i64), Some(28790));
    }

    #[test]
    fn local_gateway_start_inspects_profile_before_writing_gateway_config() {
        let source = include_str!("openclaw_connection.rs");
        let start = source
            .find("async fn openclaw_connection_start_local_for_profile(")
            .expect("local gateway start command");
        let end = source[start..]
            .find("pub async fn openclaw_connection_start_local_for_runtime")
            .map(|offset| start + offset)
            .expect("runtime wrapper");
        let command = &source[start..end];
        let inspect = command
            .find("openclaw_profile_config_is_initialized")
            .expect("semantic profile inspection");
        let dispatch = command.find("startup_readiness::start(").expect("shared production activation");
        assert!(inspect < dispatch, "classify completeness before any activation mutation");
    }

    #[test]
    fn local_gateway_start_uses_app_owned_coordinator_without_retry_cooldown() {
        let source = include_str!("openclaw_connection.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("production source");

        assert!(production.contains("GatewayStartupCoordinator>()"));
        assert!(production.contains(".run_profile_with_preparation_hooks"));
        assert!(production.contains("prepare_bundled_runtime(preparation_app)"));
        assert!(production.contains("move |result, activity|"));
        assert!(!production.contains("local_gateway_start_lock().lock().await"));
        assert!(!production.contains("LOCAL_GATEWAY_PROVISION_COOLDOWN"));
        assert!(!production.contains("local_gateway_provision_recently_attempted"));
        assert!(!production.contains("mark_local_gateway_provision_attempt"));
    }

    #[test]
    fn legacy_profile_provision_is_not_an_ipc_or_public_command() {
        let lib = include_str!("../lib.rs");
        let profiles = include_str!("model/profiles.rs");
        let model = include_str!("model/mod.rs");
        assert!(!lib.contains("commands::model::profiles::openclaw_profile_provision,"));
        assert!(!profiles.contains("#[tauri::command]\npub async fn openclaw_profile_provision"));
        assert!(model.contains("profile provision requires a coordinated startup generation"));
    }

    #[test]
    fn every_public_stop_and_reset_path_enters_the_coordinated_shutdown_gate() {
        let connection = include_str!("openclaw_connection.rs");
        let model = include_str!("model/mod.rs");
        let runtime = include_str!("model/runtime.rs");
        assert!(connection
            .split("pub async fn openclaw_connection_stop_local")
            .nth(1)
            .unwrap()
            .contains("openclaw_stop_gateway_for_profile"));
        for function in [
            "async fn openclaw_stop_gateway_impl",
            "pub(crate) async fn openclaw_reset_profile_data_impl",
            "pub(crate) async fn openclaw_stop_gateway_for_profile",
            "async fn openclaw_uninstall_impl",
        ] {
            let body = runtime.split(function).nth(1).expect(function);
            let body = body.split("\n    }").next().expect("function body");
            assert!(body.contains("local_gateway_shutdown_guard"), "{function}");
        }
        let mobile = model
            .split("pub(crate) async fn set_mobile_lan_enabled")
            .nth(1)
            .unwrap()
            .split("\n}")
            .next()
            .unwrap();
        assert!(mobile.contains("openclaw_connection_start_local_for_runtime"));
        assert!(!mobile.contains("ensure_running_for(profile)"));
        assert!(!mobile.contains("openclaw_stop_gateway_for_profile(app, profile)"));
        assert!(mobile.find("local_gateway_shutdown_guard").unwrap()
            < mobile.find("commit_mobile_lan_files").unwrap());
        assert!(mobile.find("commit_mobile_lan_files").unwrap()
            < mobile.find("drop(shutdown_guard)").unwrap());
        assert!(mobile.find("drop(shutdown_guard)").unwrap()
            < mobile.find("openclaw_connection_start_local_for_runtime").unwrap());
    }

    #[test]
    fn merge_reports_whether_a_gateway_config_patch_changed_the_document() {
        let original = json!({
            "gateway": { "mode": "local", "bind": "loopback", "port": 28790 },
            "models": { "providers": {} }
        });
        let mut unchanged = original.clone();
        let unchanged_patch = json!({
            "gateway": { "mode": "local", "bind": "loopback", "port": 28790 }
        });
        assert!(!merge_json_object_changed(&mut unchanged, unchanged_patch).unwrap());
        assert_eq!(unchanged, original);

        let mut changed = original;
        assert!(merge_json_object_changed(
            &mut changed,
            json!({ "gateway": { "port": 28791 } }),
        )
        .unwrap());
        assert_eq!(changed["gateway"]["port"], 28791);
    }

    #[test]
    fn gateway_startup_retargets_owned_model_proxy_before_automatic_work_can_run() {
        let mut config = json!({
            "gateway": { "mode": "local" },
            "models": {
                "providers": {
                    "uniopc-official": {
                        "baseUrl": "http://127.0.0.1:63059/v1",
                        "apiKey": "previous-run-secret",
                        "models": [{ "id": "minimax-m3" }]
                    },
                    "openai": {
                        "baseUrl": "http://127.0.0.1:63059/v1",
                        "apiKey": "previous-run-secret",
                        "models": [{ "id": "uniopc-image" }]
                    },
                    "customer-openai": {
                        "baseUrl": "https://customer.example/v1",
                        "apiKey": "customer-secret",
                        "models": [{ "id": "customer-model" }]
                    }
                }
            },
            "tts": {
                "provider": "minimax",
                "providers": {
                    "minimax": {
                        "baseUrl": "http://127.0.0.1:63059/v1",
                        "apiKey": "previous-run-secret"
                    }
                }
            }
        });

        assert!(merge_local_gateway_startup_config(
            &mut config,
            Some("http://127.0.0.1:52261/v1"),
            Some("stable-local-secret"),
        )
        .unwrap());

        assert_eq!(
            config.pointer("/models/providers/uniopc-official/baseUrl"),
            Some(&json!("http://127.0.0.1:52261/v1")),
        );
        assert_eq!(
            config.pointer("/models/providers/openai/baseUrl"),
            Some(&json!("http://127.0.0.1:52261/v1")),
        );
        assert_eq!(
            config.pointer("/tts/providers/minimax/baseUrl"),
            Some(&json!("http://127.0.0.1:52261/v1")),
        );
        assert_eq!(
            config.pointer("/models/providers/uniopc-official/models/0/id"),
            Some(&json!("minimax-m3")),
        );
        assert_eq!(
            config.pointer("/models/providers/customer-openai/baseUrl"),
            Some(&json!("https://customer.example/v1")),
        );
    }

    #[test]
    fn gateway_startup_preserves_foreign_loopback_standard_provider_slots() {
        let mut config = json!({
            "models": {
                "providers": {
                    "uniopc-official": {
                        "baseUrl": "http://127.0.0.1:63059/v1",
                        "apiKey": "previous-run-secret"
                    },
                    "openai": {
                        "baseUrl": "http://127.0.0.1:11434/v1",
                        "apiKey": "user-local-secret"
                    }
                }
            },
            "tts": {
                "providers": {
                    "minimax": {
                        "baseUrl": "http://127.0.0.1:11435/v1",
                        "apiKey": "user-tts-secret"
                    }
                }
            }
        });

        merge_local_gateway_startup_config(
            &mut config,
            Some("http://127.0.0.1:52261/v1"),
            Some("current-run-secret"),
        )
        .unwrap();

        assert_eq!(
            config.pointer("/models/providers/openai/baseUrl"),
            Some(&json!("http://127.0.0.1:11434/v1")),
        );
        assert_eq!(
            config.pointer("/tts/providers/minimax/baseUrl"),
            Some(&json!("http://127.0.0.1:11435/v1")),
        );
    }

    #[test]
    fn empty_or_thin_covers_the_empty_root_that_thin_missed() {
        // The empty-`{}` case is the one `is_thin` missed (it needs a `gateway`
        // key), which is why backup recovery never fired before the merge.
        assert!(openclaw_config_root_is_empty_or_thin(&json!({})));
        assert!(!openclaw_config_root_is_thin(&json!({})));
        assert!(openclaw_config_root_is_empty_or_thin(
            &json!({ "gateway": { "mode": "local", "port": 28790 } })
        ));
        assert!(!openclaw_config_root_is_empty_or_thin(
            &json!({ "gateway": {}, "meta": {}, "agents": {}, "models": {} })
        ));
    }

    #[test]
    fn not_configured_patch_removes_gateway_config() {
        let mut target = json!({
            "gateway": {
                "mode": "remote",
                "remote": {
                    "transport": "direct",
                    "url": "wss://owner.example.ts.net"
                }
            }
        });

        merge_json_object(
            &mut target,
            mode_openclaw_gateway_config_patch(GatewayConnectionMode::NotConfigured),
        )
        .unwrap();

        assert!(target.get("gateway").is_none());
    }
}
