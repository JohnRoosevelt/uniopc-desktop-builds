//! Uniopc 引擎 model/provider command boundary.
//!
//! Model ownership includes Gateway model snapshots, provider auth,
//! default-model patching, and provider API key/OAuth setup. It intentionally
//! excludes local OpenAI-compatible fallback config storage.

use super::{
    OpenClawCustomModelRequest, OpenClawInstallResult, OpenClawMediaCapabilitiesSaveRequest,
    OpenClawModelsSnapshot, OpenClawProviderApiKeyRequest, OpenClawUniopcOfficialRequest,
};
use tauri::AppHandle;

pub(super) fn normalize_openclaw_model_ref(
    model: &str,
    provider_prefix: &str,
    default_model: &str,
) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return default_model.to_string();
    }
    if trimmed.contains('/') {
        return trimmed.to_string();
    }
    format!("{provider_prefix}/{trimmed}")
}

async fn openclaw_models_snapshot_impl(
    app: AppHandle,
    profile: Option<String>,
) -> Result<OpenClawModelsSnapshot, String> {
    let normalized_profile = super::normalize_openclaw_snapshot_profile(profile.as_deref());
    implementation::openclaw_models_snapshot_from_gateway_for_profile_with_cli_auth(
        &app,
        normalized_profile.as_deref(),
        None,
    )
    .await
}

async fn openclaw_media_capabilities_save_impl(
    app: AppHandle,
    req: OpenClawMediaCapabilitiesSaveRequest,
) -> Result<OpenClawModelsSnapshot, String> {
    let status = super::build_openclaw_status(&app).await;
    if !status.supported {
        return Err(status.message);
    }
    if !status.installed {
        return Err("请先安装 Uniopc 引擎，再保存媒体能力配置。".to_string());
    }

    let profile = super::normalize_openclaw_snapshot_profile(req.profile.as_deref());
    let patch = super::build_openclaw_media_capabilities_patch(&req);
    crate::services::openclaw_gateway::config_patch(profile.as_deref(), patch).await?;
    let _ = implementation::wait_for_openclaw_gateway_ready(&app).await;
    implementation::openclaw_models_snapshot_from_gateway_for_profile_with_cli_auth(
        &app,
        profile.as_deref(),
        None,
    )
    .await
}

fn official_model_local_profile_state_from_config(
    config: &serde_json::Value,
    runtime_config_ready: bool,
) -> serde_json::Value {
    const PROVIDER: &str = "uniopc-official";
    let primary_model = config
        .pointer("/agents/defaults/model/primary")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            config
                .pointer("/agents/defaults/model")
                .and_then(serde_json::Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let provider = config.pointer("/models/providers/uniopc-official");
    let provider_configured = provider.is_some_and(|provider| {
        let base_url_ready = provider
            .get("baseUrl")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .is_some_and(|value| !value.is_empty());
        let api_key_ready = provider.get("apiKey").is_some_and(|value| match value {
            serde_json::Value::String(value) => !value.trim().is_empty(),
            serde_json::Value::Null => false,
            _ => true,
        });
        base_url_ready && api_key_ready
    });

    let provider_model_refs = provider
        .and_then(|provider| provider.get("models"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            ["ref", "modelRef", "id", "model", "name"]
                .into_iter()
                .find_map(|field| model.get(field).and_then(serde_json::Value::as_str))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.contains('/') {
                value.to_string()
            } else {
                format!("{PROVIDER}/{value}")
            }
        })
        .collect::<std::collections::BTreeSet<_>>();
    let allowed_models = config
        .pointer("/agents/defaults/models")
        .and_then(serde_json::Value::as_object);
    let model_refs = allowed_models
        .into_iter()
        .flat_map(|models| models.keys())
        .filter(|model_ref| {
            model_ref.starts_with("uniopc-official/")
                && provider_model_refs.contains(model_ref.as_str())
        })
        .cloned()
        .collect::<Vec<_>>();

    serde_json::json!({
        "configured": provider_configured,
        "runtimeReady": provider_configured && runtime_config_ready,
        "selected": primary_model.starts_with("uniopc-official/"),
        "primaryModel": primary_model,
        "modelRefs": model_refs,
    })
}

pub(super) mod implementation {
    use super::super::*;

    async fn command_output_impl_with_stdin(
        app: &AppHandle,
        program: &str,
        args: &[String],
        stdin: &str,
    ) -> Result<String, String> {
        let _openclaw_guard = if program == "openclaw" {
            Some(crate::services::openclaw_cli::acquire_cli_lock().await)
        } else {
            None
        };
        let (program, args) = resolve_spawn_program(program, args)?;
        let (mut rx, mut child) = app
            .shell()
            .command(program.to_string())
            .env("PATH", openclaw_augmented_path(None))
            .envs(cli_proxy_env())
            .envs(openclaw_state_env(&args))
            .args(args.iter().map(|arg| arg.as_str()).collect::<Vec<_>>())
            .spawn()
            .map_err(|e| format!("执行命令失败: {e}"))?;

        let mut input = stdin.to_string();
        if !input.ends_with('\n') {
            input.push('\n');
        }
        child
            .write(input.as_bytes())
            .map_err(|e| format!("写入命令输入失败: {e}"))?;
        drop(child);

        let mut output_log = String::new();
        let mut exit_code = None;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    if let Some(text) = command_event_output_text(&bytes) {
                        append_streaming_output(&mut output_log, &text, 80);
                    }
                }
                CommandEvent::Error(error) => append_streaming_output(&mut output_log, &error, 80),
                CommandEvent::Terminated(payload) => {
                    exit_code = payload.code;
                    break;
                }
                _ => {}
            }
        }

        if exit_code == Some(0) {
            Ok(output_log)
        } else {
            Err(tail_lines(&output_log, 20))
        }
    }

    async fn wait_for_openclaw_gateway_restart_cycle(app: &AppHandle) -> bool {
        let mut probe = || {
            Box::pin(async {
                if !matches!(openclaw_gateway::http_ready(None).await, Ok(true)) {
                    return false;
                }
                gateway_is_ready_for_app(&openclaw_gateway_status(app).await)
            }) as std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>>
        };
        wait_for_gateway_restart_cycle_with_probe(120, Duration::from_millis(250), &mut probe).await
    }

    // Readiness waits gate on the gateway's official HTTP `/readyz` probe first
    // (millisecond-cheap, no auth, 503 while startup sidecars settle) and only pay
    // the WS handshake for a single confirming `health` RPC once HTTP reports
    // ready. The old loops did the full WS handshake (3s connect / 8s request
    // timeouts) on every poll while the engine was still booting — the dominant
    // cost of cold-start readiness. The WS confirm is kept because `/readyz` says
    // nothing about our auth path (e.g. a password-mismatched stale gateway is
    // HTTP-ready but unusable). Budget unchanged (~15s / ~20s), interval tightened
    // to 250ms since probes are cheap.
    pub(super) async fn wait_for_openclaw_gateway_ready(app: &AppHandle) -> bool {
        for _ in 0..60 {
            if matches!(openclaw_gateway::http_ready(None).await, Ok(true)) {
                let status = openclaw_gateway_status(app).await;
                if gateway_is_ready_for_app(&status) {
                    return true;
                }
            }
            sleep(Duration::from_millis(250)).await;
        }
        false
    }

    async fn openclaw_set_default_model_with_cli(
        app: &AppHandle,
        profile: Option<&str>,
        model_ref: &str,
    ) -> Result<(), String> {
        match profile {
            Some(profile) => {
                openclaw_output_for_profile(app, profile, &["models", "set", model_ref]).await?;
            }
            None => {
                openclaw_output(app, &["models", "set", model_ref]).await?;
            }
        }
        Ok(())
    }

    pub(super) async fn openclaw_models_snapshot_from_gateway_for_profile_with_cli_auth(
        app: &AppHandle,
        profile: Option<&str>,
        host_version: Option<&str>,
    ) -> Result<OpenClawModelsSnapshot, String> {
        let config = openclaw_gateway::config_get(profile).await?;
        let models = openclaw_gateway::configured_models_list(profile).await?;
        let auth = openclaw_gateway::models_auth_status(profile, false).await?;
        let agent_auth = openclaw_agent_auth_store_for_profile_with_cli(app, profile).await;
        let mut snapshot = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &auth,
            Some(&agent_auth),
        );
        apply_codex_runtime_compatibility(profile, host_version, &mut snapshot);
        Ok(snapshot)
    }

    pub(super) async fn official_bootstrap_snapshot(
        app: &AppHandle,
        profile: Option<&str>,
    ) -> Result<OpenClawModelsSnapshot, String> {
        let mut metrics = OfficialCommandMetrics::new(app, profile, "official_bootstrap_snapshot");
        let started = std::time::Instant::now();
        let config = openclaw_gateway::config_get(profile).await?;
        let models = openclaw_gateway::configured_models_list(profile).await?;
        let auth = openclaw_gateway::models_auth_status(profile, false).await?;
        metrics.set("snapshotGatewayMs", started);
        let local_auth = openclaw_agent_auth_store_for_profile(profile);
        let local_snapshot = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &auth,
            Some(&local_auth),
        );
        let mut snapshot =
            official_bootstrap_snapshot_with_auth(&config, &models, &auth, local_snapshot, || async {
                let started = std::time::Instant::now();
                metrics.values.insert("authCliCount", 1);
                let auth = openclaw_agent_auth_store_for_profile_with_cli(app, profile).await;
                metrics.set("authCliMs", started);
                auth
            })
            .await;
        apply_codex_runtime_compatibility(profile, None, &mut snapshot);
        metrics.succeeded = true;
        Ok(snapshot)
    }

    // Emit one aggregate completion event, including on error. Never log payloads.
    struct OfficialCommandMetrics<'a> {
        app: &'a AppHandle,
        profile: String,
        phase: &'static str,
        started: std::time::Instant,
        values: std::collections::BTreeMap<&'static str, u64>,
        succeeded: bool,
    }
    impl<'a> OfficialCommandMetrics<'a> {
        fn new(app: &'a AppHandle, profile: Option<&'a str>, phase: &'static str) -> Self {
            Self {
                app,
                profile: crate::services::uniopc_runtime_paths::resolve_profile_key(profile),
                phase,
                started: std::time::Instant::now(),
                values: [
                    ("snapshotGatewayMs", 0),
                    ("authCliMs", 0),
                    ("authCliCount", 0),
                    ("statusPreMs", 0),
                    ("configMs", 0),
                    ("settleMs", 0),
                    ("verifyMs", 0),
                    ("clearAuthMs", 0),
                    ("migrationMs", 0),
                    ("statusPostMs", 0),
                ]
                .into_iter()
                .collect(),
                succeeded: false,
            }
        }
        fn set(&mut self, key: &'static str, started: std::time::Instant) {
            self.values
                .insert(key, started.elapsed().as_millis() as u64);
        }
    }
    impl Drop for OfficialCommandMetrics<'_> {
        fn drop(&mut self) {
            crate::services::engine_startup_metrics::record_startup_event(
                self.app,
                &self.profile,
                self.phase,
                if self.succeeded { "ready" } else { "failed" },
                self.started.elapsed().as_millis() as u64,
                serde_json::to_string(&self.values).ok(),
            );
        }
    }

    fn openclaw_env_var_is_effective_in_config_file(
        profile: Option<&str>,
        key: &str,
        value: &str,
    ) -> bool {
        openclaw_gateway::openclaw_config_path_for_profile(profile)
            .ok()
            .and_then(|path| fs::read_to_string(path).ok())
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .map(|config| openclaw_env_var_is_effective(&config, key, value))
            .unwrap_or(false)
    }

    fn official_codex_auth_json_path() -> Option<PathBuf> {
        env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| openclaw_home_dir().map(|home| home.join(".codex")))
            .map(|dir| dir.join("auth.json"))
    }

    fn official_codex_access_token_from_auth_file(path: &Path) -> Option<String> {
        fs::read_to_string(path)
            .ok()
            .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
            .and_then(|auth| official_codex_access_token_from_auth_payload(&auth))
    }

    async fn command_output_with_stdin(
        app: &AppHandle,
        program: &str,
        args: &[String],
        stdin: &str,
    ) -> Result<String, String> {
        if program == "openclaw" {
            let label = format!("openclaw {}", args.join(" "));
            return command_output_with_timeout(
                label,
                command_output_impl_with_stdin(app, program, args, stdin),
            )
            .await;
        }

        command_output_impl_with_stdin(app, program, args, stdin).await
    }

    async fn command_output_with_env(
        app: &AppHandle,
        program: &str,
        args: &[String],
        extra_env: &[(&str, &str)],
    ) -> Result<String, String> {
        command_output_impl_with_env(app, program, args, extra_env).await
    }

    async fn wait_for_openclaw_env_var(profile: Option<&str>, key: &str, value: &str) -> bool {
        for _ in 0..OPENCLAW_CONFIG_PATCH_RECOVERY_ATTEMPTS {
            if openclaw_env_var_is_effective_in_config_file(profile, key, value) {
                return true;
            }
            if let Ok(config) = config_get_with_gateway_recovery(profile).await {
                if openclaw_env_var_is_effective(&config, key, value) {
                    return true;
                }
            }
            sleep(Duration::from_millis(
                OPENCLAW_CONFIG_PATCH_RECOVERY_DELAY_MS,
            ))
            .await;
        }
        false
    }

    async fn sync_official_codex_token_to_openclaw_profile(
        app: &AppHandle,
        profile: &str,
        access_token: &str,
    ) -> Result<String, String> {
        let args = vec![
            "models".to_string(),
            "auth".to_string(),
            "paste-token".to_string(),
            "--provider".to_string(),
            OPENCLAW_OPENAI_CODEX_CLI_AUTH_PROVIDER.to_string(),
            "--profile-id".to_string(),
            OPENCLAW_OPENAI_CODEX_SYNC_PROFILE_ID.to_string(),
        ];
        let args = openclaw_args_for_profile(profile, &args);
        command_output_with_stdin(app, "openclaw", &args, access_token).await
    }

    async fn settle_official_model_gateway(
        app: &AppHandle,
        action: OfficialModelGatewaySettleAction,
    ) -> Result<(), String> {
        let ready = match action {
            OfficialModelGatewaySettleAction::KeepRunning => {
                wait_for_openclaw_gateway_ready(app).await
            }
            OfficialModelGatewaySettleAction::AwaitRestart => {
                wait_for_openclaw_gateway_restart_cycle(app).await
            }
        };
        if ready {
            Ok(())
        } else {
            Err("Uniopc 本地服务尚未完成模型配置重载，请稍后重试。".to_string())
        }
    }

    fn remove_provider_state_from_auth_state(path: &Path, provider: &str) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let raw = fs::read_to_string(path).map_err(|e| {
            format!(
                "读取 Uniopc 引擎 授权状态失败 {}: {e}",
                path.to_string_lossy()
            )
        })?;
        let mut value: Value = serde_json::from_str(&raw).map_err(|e| {
            format!(
                "解析 Uniopc 引擎 授权状态失败 {}: {e}",
                path.to_string_lossy()
            )
        })?;

        if let Some(last_good) = value.get_mut("lastGood").and_then(Value::as_object_mut) {
            last_good.remove(provider);
        }
        if let Some(usage_stats) = value.get_mut("usageStats").and_then(Value::as_object_mut) {
            let keys = usage_stats
                .keys()
                .filter(|key| key.starts_with(&format!("{provider}:")))
                .cloned()
                .collect::<Vec<_>>();
            for key in keys {
                usage_stats.remove(&key);
            }
        }

        let serialized = serde_json::to_string_pretty(&value)
            .map_err(|e| format!("序列化 Uniopc 引擎 授权状态失败: {e}"))?;
        fs::write(path, format!("{serialized}\n")).map_err(|e| {
            format!(
                "写入 Uniopc 引擎 授权状态失败 {}: {e}",
                path.to_string_lossy()
            )
        })
    }

    fn remove_provider_profiles_from_auth_store(
        path: &Path,
        provider: &str,
    ) -> Result<usize, String> {
        if !path.exists() {
            return Ok(0);
        }
        let raw = fs::read_to_string(path).map_err(|e| {
            format!(
                "读取 Uniopc 引擎 授权文件失败 {}: {e}",
                path.to_string_lossy()
            )
        })?;
        let mut value: Value = serde_json::from_str(&raw).map_err(|e| {
            format!(
                "解析 Uniopc 引擎 授权文件失败 {}: {e}",
                path.to_string_lossy()
            )
        })?;
        let profiles = value
            .get_mut("profiles")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| format!("Uniopc 引擎 授权文件格式无效: {}", path.to_string_lossy()))?;

        let keys = profiles
            .iter()
            .filter_map(|(key, entry)| {
                let entry_provider = entry.get("provider").and_then(Value::as_str);
                if entry_provider == Some(provider) || key.starts_with(&format!("{provider}:")) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        let removed = keys.len();
        for key in keys {
            profiles.remove(&key);
        }

        if removed > 0 {
            let serialized = serde_json::to_string_pretty(&value)
                .map_err(|e| format!("序列化 Uniopc 引擎 授权文件失败: {e}"))?;
            fs::write(path, format!("{serialized}\n")).map_err(|e| {
                format!(
                    "写入 Uniopc 引擎 授权文件失败 {}: {e}",
                    path.to_string_lossy()
                )
            })?;
        }
        Ok(removed)
    }

    // Best-effort removal of the orphan token file the OLD file-secret scheme wrote
    // to `<state>/secrets/uniopc-official.token`. Once every apiKey is the loopback
    // shared secret, nothing reads this file, so delete it on migration. Mirrors the
    // old writer's path (active profile). Never fatal — a failure or a missing file
    // is fine.
    fn remove_legacy_official_token_file() {
        if let Ok(state_dir) = uniopc_runtime_paths::state_v8_dir_for_profile_or_active(None) {
            let _ = std::fs::remove_file(state_dir.join("secrets").join("uniopc-official.token"));
        }
    }

    pub async fn openclaw_ready_model_refs_for_profile(
        app: &AppHandle,
        profile: Option<&str>,
    ) -> Result<BTreeSet<String>, String> {
        let snapshot =
            openclaw_models_snapshot_from_gateway_for_profile_with_cli_auth(app, profile, None)
                .await?;
        Ok(snapshot
            .models
            .into_iter()
            .filter(|model| model.provider_ready)
            .map(|model| model.model_ref)
            .collect())
    }

    async fn openclaw_output_for_profile_with_env(
        app: &AppHandle,
        profile: &str,
        args: &[String],
        extra_env: &[(&str, &str)],
    ) -> Result<String, String> {
        let args = openclaw_args_for_profile(profile, args);
        command_output_with_env(app, "openclaw", &args, extra_env).await
    }

    async fn openclaw_model_status_from_gateway_for_profile(
        profile: Option<&str>,
        refresh_auth: bool,
    ) -> Result<OpenClawModelStatus, String> {
        let config = openclaw_gateway::config_get(profile).await?;
        let models = openclaw_gateway::configured_models_list(profile).await?;
        let auth = openclaw_gateway::models_auth_status(profile, refresh_auth).await?;
        let agent_auth = openclaw_agent_auth_store_for_profile(profile);
        Ok(openclaw_model_status_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &auth,
            Some(&agent_auth),
        ))
    }

    async fn openclaw_codex_auth_ready_from_cli(app: &AppHandle, profile: Option<&str>) -> bool {
        let output = match profile {
            Some(profile) => {
                openclaw_output_for_profile(app, profile, &["models", "auth", "list", "--json"])
                    .await
            }
            None => openclaw_output(app, &["models", "auth", "list", "--json"]).await,
        };
        output
            .ok()
            .and_then(|output| parse_json_value_from_output(&output))
            .map(|auth| {
                openclaw_auth_payload_has_oauth_provider(&auth, OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER)
                    || openclaw_auth_payload_has_oauth_provider(
                        &auth,
                        OPENCLAW_OPENAI_CODEX_CLI_AUTH_PROVIDER,
                    )
            })
            .unwrap_or(false)
    }

    fn openclaw_agent_sqlite_path_for_profile(profile: Option<&str>) -> Result<PathBuf, String> {
        Ok(openclaw_agent_dir_for_profile(profile)?.join("openclaw-agent.sqlite"))
    }

    fn official_codex_access_token() -> Option<String> {
        official_codex_auth_json_path()
            .as_deref()
            .and_then(official_codex_access_token_from_auth_file)
    }

    fn escape_for_applescript(input: &str) -> String {
        input.replace('\\', "\\\\").replace('"', "\\\"")
    }

    async fn ensure_openclaw_default_model_for_profile(
        app: &AppHandle,
        profile: Option<&str>,
        model_ref: &str,
    ) -> Result<(), String> {
        let snapshot = match config_get_with_gateway_recovery(profile).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return openclaw_set_default_model_with_cli(app, profile, model_ref)
                    .await
                    .map_err(|cli_error| format!("{error}\nCLI fallback failed: {cli_error}"));
            }
        };
        let patch = build_openclaw_default_model_patch(&snapshot, model_ref);
        match openclaw_gateway::config_patch(profile, patch).await {
            Ok(_) => {
                let _ = wait_for_openclaw_gateway_ready(app).await;
                Ok(())
            }
            Err(error) if openclaw_gateway_patch_error_may_be_restarting(&error) => {
                if wait_for_openclaw_profile_default_model(profile, model_ref).await {
                    Ok(())
                } else {
                    openclaw_set_default_model_with_cli(app, profile, model_ref)
                        .await
                        .map_err(|cli_error| format!("{error}\nCLI fallback failed: {cli_error}"))
                }
            }
            Err(error) => openclaw_set_default_model_with_cli(app, profile, model_ref)
                .await
                .map_err(|cli_error| format!("{error}\nCLI fallback failed: {cli_error}")),
        }
    }

    async fn sync_unavailable_agent_models_to_default(
        app: &AppHandle,
        profile: Option<&str>,
        target_model: &str,
    ) -> Result<(), String> {
        let mut ready_models = openclaw_ready_model_refs_for_profile(app, profile).await?;
        ready_models.insert(target_model.to_string());
        let agents = openclaw_gateway::agents_list_json_with_device_auth(app, profile).await?;
        for agent_id in agent_model_migration_targets(&agents, &ready_models, target_model) {
            openclaw_gateway::agents_update_json(
                profile,
                &agent_id,
                serde_json::json!({
                    "model": target_model
                }),
            )
            .await
            .map_err(|error| {
                format!(
                    "Uniopc 引擎 已切换默认模型，但同步 AI 员工 `{agent_id}` 的模型失败：{error}"
                )
            })?;
        }
        Ok(())
    }

    async fn sync_official_agent_models_to_default(
        app: &AppHandle,
        profile: Option<&str>,
        target_model: &str,
        metrics: &mut OfficialCommandMetrics<'_>,
    ) -> Result<(), String> {
        let agents = openclaw_gateway::agents_list_json_with_device_auth(app, profile).await?;
        let ready_models = official_agent_migration_ready_models(&agents, target_model, || async {
            let started = std::time::Instant::now();
            let config = openclaw_gateway::config_get(profile).await?;
            let models = openclaw_gateway::configured_models_list(profile).await?;
            let auth = openclaw_gateway::models_auth_status(profile, false).await?;
            metrics.set("snapshotGatewayMs", started);
            let started = std::time::Instant::now();
            metrics.values.insert("authCliCount", 1);
            let agent_auth = openclaw_agent_auth_store_for_profile_with_cli(app, profile).await;
            metrics.set("authCliMs", started);
            let mut snapshot = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
                &config,
                &models,
                &auth,
                Some(&agent_auth),
            );
            apply_codex_runtime_compatibility(profile, None, &mut snapshot);
            Ok(snapshot
                .models
                .into_iter()
                .filter(|model| model.provider_ready)
                .map(|model| model.model_ref)
                .collect())
        })
        .await?;
        for agent_id in agent_model_migration_targets(&agents, &ready_models, target_model) {
            openclaw_gateway::agents_update_json(
                profile,
                &agent_id,
                serde_json::json!({"model": target_model}),
            )
            .await
            .map_err(|error| {
                format!("Uniopc 引擎 已切换默认模型，但同步 AI 员工 `{agent_id}` 的模型失败：{error}")
            })?;
        }
        Ok(())
    }

    async fn sync_official_codex_auth_if_available(
        app: &AppHandle,
        profile: &str,
    ) -> Result<bool, String> {
        let Some(access_token) = official_codex_access_token() else {
            return Ok(false);
        };
        sync_official_codex_token_to_openclaw_profile(app, profile, &access_token)
            .await
            .map(|_| true)
    }

    fn restore_backup(path: &Path, backup_path: &Option<PathBuf>) {
        if let Some(backup_path) = backup_path {
            let _ = fs::copy(backup_path, path);
        }
    }

    fn prepare_openclaw_provider_rebind(
        profile: Option<&str>,
        provider: &str,
    ) -> Result<(Option<PathBuf>, Option<PathBuf>, usize), String> {
        let agent_dir = openclaw_agent_dir_for_profile(profile)?;
        let profiles_path = agent_dir.join("auth-profiles.json");
        let state_path = agent_dir.join("auth-state.json");
        let profiles_backup = backup_file(&profiles_path)?;
        let state_backup = backup_file(&state_path)?;
        let removed = remove_provider_profiles_from_auth_store(&profiles_path, provider)?;
        remove_provider_state_from_auth_state(&state_path, provider)?;
        Ok((profiles_backup, state_backup, removed))
    }

    async fn openclaw_onboard_provider_api_key(
        app: &AppHandle,
        profile: Option<&str>,
        spec: &ProviderApiKeySpec,
        api_key: &str,
    ) -> Result<(), String> {
        if spec.auth_choice.is_none() {
            return Err(format!(
                "{} 暂未配置 Uniopc 引擎 官方 API Key 接入流程。",
                spec.provider_prefix
            ));
        }
        let args = openclaw_provider_onboard_args(spec);
        let env = [(spec.env_key, api_key)];
        if let Some(profile) = profile {
            openclaw_output_for_profile_with_env(app, profile, &args, &env)
                .await
                .map(|_| ())
        } else {
            command_output_with_env(app, "openclaw", &args, &env)
                .await
                .map(|_| ())
        }
    }

    async fn openclaw_codex_auth_ready(app: &AppHandle, profile: Option<&str>) -> bool {
        if openclaw_model_status_from_gateway_for_profile(profile, true)
            .await
            .map(|model_status| {
                model_status.providers_with_oauth.iter().any(|provider| {
                    provider.starts_with(OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER)
                        || provider.starts_with(OPENCLAW_OPENAI_CODEX_CLI_AUTH_PROVIDER)
                })
            })
            .unwrap_or(false)
        {
            return true;
        }

        openclaw_codex_auth_ready_from_cli(app, profile).await
    }

    async fn openai_codex_network_preflight(app: &AppHandle) -> Result<(), String> {
        let args = vec![
            "-sS".to_string(),
            "--max-time".to_string(),
            "8".to_string(),
            "https://ipinfo.io/json".to_string(),
        ];
        let output = command_output(app, "curl", &args)
            .await
            .map_err(|error| format!("无法完成 OpenAI 授权网络预检，请检查网络后重试。{error}"))?;
        let country = ipinfo_country_from_output(&output);
        if let Some(message) = openai_codex_network_preflight_failure(country.as_deref()) {
            return Err(message);
        }
        Ok(())
    }

    async fn launch_terminal_command(app: &AppHandle, command: &str) -> Result<String, String> {
        if cfg!(target_os = "macos") {
            let escaped = escape_for_applescript(command);
            let args = vec![
                "-e".to_string(),
                "tell application \"Terminal\" to activate".to_string(),
                "-e".to_string(),
                format!("tell application \"Terminal\" to do script \"{}\"", escaped),
            ];
            return command_output(app, "osascript", &args).await;
        }

        if cfg!(target_os = "windows") {
            let args = vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                format!(
                    "Start-Process powershell -ArgumentList '-NoExit','-Command','{}'",
                    command.replace('\'', "''")
                ),
            ];
            return command_output(app, "powershell", &args).await;
        }

        let args = vec![
            "-e".to_string(),
            format!("sh -lc '{}'", command.replace('\'', "'\\''")),
        ];
        command_output(app, "x-terminal-emulator", &args).await
    }

    async fn ensure_uniopc_official_model_for_profile(
        app: &AppHandle,
        profile: Option<&str>,
        base_url: &str,
        api_key: &str,
        model_ref: &str,
        catalog_models: &[OpenClawOfficialCatalogModel],
        metrics: &mut OfficialCommandMetrics<'_>,
    ) -> Result<(), String> {
        // `base_url` + `api_key` are the REAL upstream (mint output). Keep the token
        // in the loopback proxy's memory and point the gateway at the proxy instead —
        // the proxy injects the real bearer per request. Rotating the token is just
        // this in-memory write; config below is byte-stable across rotations, so no
        // config.patch and no gateway restart.
        crate::services::official_model_proxy::set_official_upstream(base_url, api_key);
        let proxy_base = crate::services::official_model_proxy::proxy_base_url()
            .ok_or_else(|| "本地模型反代尚未启动，无法接入官方模型。请稍后重试。".to_string())?;
        let proxy_secret = crate::services::official_model_proxy::proxy_shared_secret();
        let started = std::time::Instant::now();
        let snapshot = config_get_with_gateway_recovery(profile).await?;
        let settle_action =
            official_model_gateway_settle_action(&snapshot, &proxy_base, proxy_secret);
        let patch = build_uniopc_official_config_patch(
            &snapshot,
            &proxy_base,
            proxy_secret,
            model_ref,
            catalog_models,
        );
        let patched = openclaw_gateway::config_patch(profile, patch).await;
        metrics.set("configMs", started);
        match patched {
            Ok(_) => {
                let started = std::time::Instant::now();
                let settled = settle_official_model_gateway(app, settle_action).await;
                metrics.set("settleMs", started);
                settled?;
                // The new config is in place and no apiKey references the old file
                // secret anymore — best-effort delete the now-orphan token file the
                // old scheme left on disk (unreferenced; harmless if already gone).
                remove_legacy_official_token_file();
                // No sidecar restart here. The token is not in config and lives in
                // the proxy's memory, which the running gateway reaches per request;
                // `set_official_upstream` above already made the fresh token live. On
                // a 401 re-mint this path just overwrites that memory — the next
                // request picks it up with zero restart (was: a mandatory restart to
                // re-read the cached file secret, which interrupted the live turn).
                // Post-condition: `config_patch` returning Ok does NOT guarantee the
                // provider block persisted — a patch applied while the gateway is
                // mid-restart/desynced can be dropped, leaving the token file written
                // but no `uniopc-official` provider in config (the silent half-write
                // that strands the agent on "No API key found for provider openai").
                // Re-read config and confirm the provider actually landed; if it did
                // not, surface a retryable error so the caller reconnects instead of
                // reporting a phantom success.
                let started = std::time::Instant::now();
                let verify = config_get_with_gateway_recovery(profile).await;
                metrics.set("verifyMs", started);
                match verify {
                    Ok(verify) if snapshot_has_official_provider_configured(&verify) => Ok(()),
                    Ok(_) => Err("官方模型接入未生效：Uniopc 引擎配置里未出现 uniopc-official provider（config.patch 可能在网关重启窗口被丢弃）。请重试接入。".to_string()),
                    // Can't re-read config right now (gateway momentarily
                    // unreachable). Stay optimistic rather than force a needless
                    // re-mint — a genuine miss still surfaces on the next send's auth
                    // path, which the JS 401 recovery handles.
                    Err(verify_error) => {
                        eprintln!("[official-model] provider verify skipped: {verify_error}");
                        Ok(())
                    }
                }
            }
            Err(error) if openclaw_gateway_patch_error_may_be_restarting(&error) => {
                let started = std::time::Instant::now();
                let settled = settle_official_model_gateway(app, settle_action).await;
                metrics.set("settleMs", started);
                settled.map_err(|settle_error| format!("{error}\n{settle_error}"))?;
                let started = std::time::Instant::now();
                let verified = wait_for_openclaw_profile_default_model(profile, model_ref).await;
                metrics.set("verifyMs", started);
                verified.then_some(()).ok_or(error)
            }
            Err(error) => Err(error),
        }
    }

    async fn ensure_openclaw_provider_plugin_allowed_for_profile(
        profile: Option<&str>,
        provider_prefix: &str,
    ) -> Result<(), String> {
        let plugin_id = match provider_prefix {
            "qwen" => "qwen",
            _ => return Ok(()),
        };
        let snapshot = config_get_with_gateway_recovery(profile).await?;
        let Some(patch) = build_openclaw_provider_plugin_allow_patch(&snapshot, plugin_id) else {
            return Ok(());
        };
        openclaw_gateway::config_patch(profile, patch)
            .await
            .map(|_| ())
    }

    async fn ensure_openclaw_env_var(
        profile: Option<&str>,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        let mut env = serde_json::Map::new();
        env.insert(key.to_string(), Value::String(value.to_string()));
        match openclaw_gateway::config_patch(
            profile,
            serde_json::json!({
                "env": { "vars": Value::Object(env) }
            }),
        )
        .await
        {
            Ok(_) => Ok(()),
            Err(error) if openclaw_gateway_patch_error_may_be_restarting(&error) => {
                if wait_for_openclaw_env_var(profile, key, value).await {
                    Ok(())
                } else {
                    Err(error)
                }
            }
            Err(error) => Err(error),
        }
    }

    async fn ensure_openclaw_default_model(app: &AppHandle, model_ref: &str) -> Result<(), String> {
        ensure_openclaw_default_model_for_profile(app, None, model_ref).await
    }

    async fn clear_openclaw_provider_auth_failure_state(
        app: &AppHandle,
        profile: Option<&str>,
        provider_prefix: &str,
    ) -> Result<(), String> {
        let db_path = openclaw_agent_sqlite_path_for_profile(profile)?;
        if !db_path.exists() {
            return Ok(());
        }
        // OpenClaw records a configured `models.providers.*.apiKey` failure under
        // `inline-api-key:<provider>`, while provider-auth profiles use
        // `<provider>:default`.  A newly minted Uniopc token is a new credential,
        // so clear both representations.  Clearing only the latter left an inline
        // billing failure active for hours after the user had topped up credits.
        let profile_id = format!("{provider_prefix}:default");
        let inline_usage_id = format!("inline-api-key:{provider_prefix}");
        let profile_json_path = openclaw_auth_usage_stats_json_path(&profile_id);
        let inline_json_path = openclaw_auth_usage_stats_json_path(&inline_usage_id);
        let args = vec![
            db_path.to_string_lossy().to_string(),
            format!(
                "update auth_profile_state set state_json = json_remove(state_json, {}, {}), updated_at = cast(strftime('%s','now') as integer) * 1000 where state_key = 'primary';",
                sqlite_string_literal(&profile_json_path),
                sqlite_string_literal(&inline_json_path),
            ),
        ];
        command_output(app, "sqlite3", &args).await.map(|_| ())
    }

    async fn ensure_bailian_token_plan_model_for_profile(
        app: &AppHandle,
        profile: Option<&str>,
        api_key: &str,
        model_ref: &str,
    ) -> Result<(), String> {
        let snapshot = config_get_with_gateway_recovery(profile).await?;
        let patch = build_bailian_token_plan_config_patch(&snapshot, api_key, model_ref);
        match openclaw_gateway::config_patch(profile, patch).await {
            Ok(_) => {
                let _ = wait_for_openclaw_gateway_ready(app).await;
                Ok(())
            }
            Err(error) if openclaw_gateway_patch_error_may_be_restarting(&error) => {
                if wait_for_openclaw_profile_default_model(profile, model_ref).await {
                    Ok(())
                } else {
                    Err(error)
                }
            }
            Err(error) => Err(error),
        }
    }

    pub(super) async fn openclaw_use_provider_api_key_model_impl(
        app: AppHandle,
        req: OpenClawProviderApiKeyRequest,
    ) -> Result<OpenClawInstallResult, String> {
        let status = build_openclaw_status(&app).await;
        if !status.supported {
            return Err(status.message);
        }
        if !status.installed {
            return Err("请先安装 Uniopc 引擎，再切换远程模型。".to_string());
        }

        let spec = provider_api_key_spec(&req.provider)?;
        let api_key = req.api_key.trim();
        if api_key.is_empty() {
            return Err("请输入 Provider API Key。".to_string());
        }
        validate_provider_api_key(&spec, api_key)?;
        let target_model = normalize_openclaw_model_ref(
            req.model.as_deref().unwrap_or(spec.default_model),
            spec.provider_prefix,
            spec.default_model,
        );
        let profile = normalize_openclaw_snapshot_profile(req.profile.as_deref());

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "configuring_model".to_string(),
                status: format!("正在把 Uniopc 引擎 默认模型切换到 {}", spec.provider_prefix),
                detail: Some(target_model.clone()),
                output_tail: None,
                percent: Some(30.0),
            },
        )?;

        if spec.provider_prefix == OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER {
            ensure_bailian_token_plan_model_for_profile(
                &app,
                profile.as_deref(),
                api_key,
                &target_model,
            )
            .await?;
            let _ = clear_openclaw_provider_auth_failure_state(
                &app,
                profile.as_deref(),
                spec.provider_prefix,
            )
            .await;
        } else if spec.auth_choice.is_some() {
            ensure_openclaw_provider_plugin_allowed_for_profile(
                profile.as_deref(),
                spec.provider_prefix,
            )
            .await?;
            openclaw_onboard_provider_api_key(&app, profile.as_deref(), &spec, api_key).await?;
            let _ = clear_openclaw_provider_auth_failure_state(
                &app,
                profile.as_deref(),
                spec.provider_prefix,
            )
            .await;
            ensure_openclaw_default_model_for_profile(&app, profile.as_deref(), &target_model)
                .await?;
        } else {
            ensure_openclaw_env_var(profile.as_deref(), spec.env_key, api_key).await?;
            ensure_openclaw_default_model_for_profile(&app, profile.as_deref(), &target_model)
                .await?;
        }
        sync_unavailable_agent_models_to_default(&app, profile.as_deref(), &target_model).await?;

        let next_status = build_openclaw_status(&app).await;
        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail: None,
        })
    }

    pub(super) async fn openclaw_use_uniopc_official_model_impl(
        app: AppHandle,
        req: OpenClawUniopcOfficialRequest,
    ) -> Result<OpenClawInstallResult, String> {
        let profile = normalize_openclaw_snapshot_profile(req.profile.as_deref());
        let mut metrics =
            OfficialCommandMetrics::new(&app, profile.as_deref(), "official_full_connect");
        let started = std::time::Instant::now();
        let status = build_openclaw_status(&app).await;
        metrics.set("statusPreMs", started);
        if !status.supported {
            return Err(status.message);
        }
        if !status.installed {
            return Err("请先安装 Uniopc 引擎，再连接官方模型。".to_string());
        }

        let base_url = req.base_url.trim();
        if base_url.is_empty() {
            return Err("缺少官方模型网关地址。".to_string());
        }
        let api_key = req.api_key.trim();
        if api_key.is_empty() {
            return Err("缺少官方模型访问令牌。".to_string());
        }
        let requested_model = normalize_openclaw_model_ref(
            req.model
                .as_deref()
                .unwrap_or(OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL),
            OPENCLAW_UNIOPC_OFFICIAL_PROVIDER,
            OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
        );
        // Reconnecting the process-local official proxy is transport repair, not a
        // user model-selection action. Keep an existing official primary even if a
        // concurrent mint request carried the service default; this closes the late
        // single-flight window after the JS request has already crossed IPC.
        let target_model = openclaw_gateway::load_openclaw_config_for_profile(profile.as_deref())
            .map(|config| {
                official_model_target_preserving_existing_selection(&config, &requested_model)
            })
            .unwrap_or(requested_model);

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "configuring_model".to_string(),
                status: "正在连接 Uniopc 官方模型".to_string(),
                detail: Some(target_model.clone()),
                output_tail: None,
                percent: Some(30.0),
            },
        )?;

        let catalog_models = req.models.clone().unwrap_or_default();
        ensure_uniopc_official_model_for_profile(
            &app,
            profile.as_deref(),
            base_url,
            api_key,
            &target_model,
            &catalog_models,
            &mut metrics,
        )
        .await?;
        let started = std::time::Instant::now();
        let _ = clear_openclaw_provider_auth_failure_state(
            &app,
            profile.as_deref(),
            OPENCLAW_UNIOPC_OFFICIAL_PROVIDER,
        )
        .await;
        metrics.set("clearAuthMs", started);
        let started = std::time::Instant::now();
        let migrated = sync_official_agent_models_to_default(
            &app, profile.as_deref(), &target_model, &mut metrics,
        ).await;
        metrics.set("migrationMs", started);
        migrated?;

        let started = std::time::Instant::now();
        let next_status = build_openclaw_status(&app).await;
        metrics.set("statusPostMs", started);
        metrics.succeeded = true;
        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail: None,
        })
    }

    pub(super) async fn openclaw_use_custom_openai_model_impl(
        app: AppHandle,
        req: OpenClawCustomModelRequest,
    ) -> Result<OpenClawInstallResult, String> {
        let status = build_openclaw_status(&app).await;
        if !status.supported {
            return Err(status.message);
        }
        if !status.installed {
            return Err("请先安装 Uniopc 引擎，再接入自定义模型。".to_string());
        }

        let base_url = req.base_url.trim().trim_end_matches('/');
        if base_url.is_empty() {
            return Err("请填写 Base URL。".to_string());
        }
        if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
            return Err("Base URL 需要以 http:// 或 https:// 开头。".to_string());
        }
        let api_key = req.api_key.trim();
        if api_key.is_empty() {
            return Err("请填写 API Key。".to_string());
        }
        let model_id = req.model.trim();
        if model_id.is_empty() {
            return Err("请填写模型名称。".to_string());
        }
        if model_id.contains('/') {
            return Err("模型名称不能包含 /，请只填上游的模型 id。".to_string());
        }

        let label = req
            .label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .unwrap_or(model_id);
        let provider_id = custom_provider_id_from_label(label);
        let profile = normalize_openclaw_snapshot_profile(req.profile.as_deref());
        let model_ref = format!("{provider_id}/{model_id}");

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "configuring_model".to_string(),
                status: "正在接入自定义模型".to_string(),
                detail: Some(model_ref.clone()),
                output_tail: None,
                percent: Some(30.0),
            },
        )?;

        let snapshot = config_get_with_gateway_recovery(profile.as_deref()).await?;
        let patch = build_custom_openai_provider_config_patch(
            &snapshot,
            &provider_id,
            base_url,
            api_key,
            model_id,
        );
        match openclaw_gateway::config_patch(profile.as_deref(), patch).await {
            Ok(_) => {
                let _ = wait_for_openclaw_gateway_ready(&app).await;
            }
            Err(error) if openclaw_gateway_patch_error_may_be_restarting(&error) => {
                if !wait_for_openclaw_profile_default_model(profile.as_deref(), &model_ref).await {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }

        let _ = clear_openclaw_provider_auth_failure_state(&app, profile.as_deref(), &provider_id)
            .await;
        sync_unavailable_agent_models_to_default(&app, profile.as_deref(), &model_ref).await?;

        let next_status = build_openclaw_status(&app).await;
        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail: None,
        })
    }

    pub(super) async fn openclaw_use_openai_api_model_impl(
        app: AppHandle,
        api_key: String,
        model: Option<String>,
        profile: Option<String>,
    ) -> Result<OpenClawInstallResult, String> {
        let status = build_openclaw_status(&app).await;
        if !status.supported {
            return Err(status.message);
        }
        if !status.installed {
            return Err("请先安装 Uniopc 引擎，再切换远程模型。".to_string());
        }

        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err("请输入 OpenAI API Key。".to_string());
        }

        let target_model = normalize_openclaw_model_ref(
            model
                .as_deref()
                .unwrap_or(OPENCLAW_OPENAI_API_DEFAULT_MODEL),
            "openai",
            OPENCLAW_OPENAI_API_DEFAULT_MODEL,
        );
        let profile = normalize_openclaw_snapshot_profile(profile.as_deref());

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "configuring_model".to_string(),
                status: "正在把 Uniopc 引擎 默认模型切换到 OpenAI API".to_string(),
                detail: Some(target_model.clone()),
                output_tail: None,
                percent: Some(30.0),
            },
        )?;

        ensure_openclaw_env_var(profile.as_deref(), "OPENAI_API_KEY", api_key).await?;
        ensure_openclaw_default_model_for_profile(&app, profile.as_deref(), &target_model).await?;

        let next_status = build_openclaw_status(&app).await;
        let success = openclaw_model_status_from_gateway_for_profile(profile.as_deref(), false)
            .await
            .ok()
            .and_then(|status| status.resolved_default_model.or(status.default_model))
            .as_deref()
            == Some(target_model.as_str());

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: if success {
                    "success".to_string()
                } else {
                    "failed".to_string()
                },
                status: if success {
                    "Uniopc 引擎 已切换到 OpenAI API 模型".to_string()
                } else {
                    "Uniopc 引擎 默认模型切换未生效".to_string()
                },
                detail: Some(target_model.clone()),
                output_tail: None,
                percent: if success { Some(100.0) } else { None },
            },
        )?;

        if !success {
            return Err(format!(
                "Uniopc 引擎 默认模型仍是 {}，请检查远程模型配置。",
                next_status
                    .resolved_default_model
                    .clone()
                    .unwrap_or_else(|| "未知".to_string())
            ));
        }

        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail: None,
        })
    }

    async fn finish_openai_codex_login_with_synced_official_auth(
        app: &AppHandle,
        profile: &str,
        target_model: &str,
        output_tail: Option<String>,
    ) -> Result<OpenClawInstallResult, String> {
        ensure_openclaw_default_model_for_profile(app, Some(profile), target_model).await?;
        let next_status = build_openclaw_status(app).await;
        let result_output_tail = output_tail.clone();
        emit_openclaw_progress(
            app,
            OpenClawSetupProgress {
                phase: "success".to_string(),
                status: "OpenAI Codex 授权已完成".to_string(),
                detail: Some(
                    "Uniopc 已复用官方 Codex 登录并同步到 Uniopc 引擎 运行时。".to_string(),
                ),
                output_tail,
                percent: Some(100.0),
            },
        )?;

        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail: result_output_tail,
        })
    }

    pub(super) async fn openclaw_login_openai_codex_impl(
        app: AppHandle,
        model: Option<String>,
        force_rebind: Option<bool>,
        profile: Option<String>,
    ) -> Result<OpenClawInstallResult, String> {
        let status = build_openclaw_status(&app).await;
        if !status.supported {
            return Err(status.message);
        }
        if !status.installed {
            return Err("请先安装 Uniopc 引擎，再开始订阅登录。".to_string());
        }

        let target_model = normalize_openclaw_model_ref(
            model
                .as_deref()
                .unwrap_or(OPENCLAW_OPENAI_CODEX_DEFAULT_MODEL),
            OPENCLAW_OPENAI_CODEX_CLI_AUTH_PROVIDER,
            OPENCLAW_OPENAI_CODEX_DEFAULT_MODEL,
        );
        let profile = crate::services::openclaw_runtime::require_profile_key(
            normalize_openclaw_snapshot_profile(profile.as_deref()).as_deref(),
        )?;

        let force_rebind = force_rebind.unwrap_or(false);

        if !force_rebind {
            if let Ok(model_status) = openclaw_model_status_from_gateway_for_profile_with_cli_auth(
                &app,
                Some(&profile),
                false,
            )
            .await
            {
                let codex_auth_ready = model_status.providers_with_oauth.iter().any(|provider| {
                    provider.starts_with(OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER)
                        || provider.starts_with(OPENCLAW_OPENAI_CODEX_CLI_AUTH_PROVIDER)
                });
                if codex_auth_ready {
                    ensure_openclaw_default_model_for_profile(&app, Some(&profile), &target_model)
                        .await?;
                    let next_status = build_openclaw_status(&app).await;
                    emit_openclaw_progress(
                        &app,
                        OpenClawSetupProgress {
                            phase: "success".to_string(),
                            status: "检测到 OpenAI Codex 已登录，已直接切换默认模型".to_string(),
                            detail: Some(target_model.clone()),
                            output_tail: None,
                            percent: Some(100.0),
                        },
                    )?;

                    return Ok(OpenClawInstallResult {
                        status: next_status,
                        output_tail: None,
                    });
                }
            }
        }

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "auth".to_string(),
                status: "正在检测官方 Codex 登录".to_string(),
                detail: Some(
                    "Uniopc 会优先复用 ~/.codex/auth.json 中的 ChatGPT 登录。".to_string(),
                ),
                output_tail: None,
                percent: Some(12.0),
            },
        )?;
        match sync_official_codex_auth_if_available(&app, &profile).await {
            Ok(true) => {
                return finish_openai_codex_login_with_synced_official_auth(
                    &app,
                    &profile,
                    &target_model,
                    None,
                )
                .await;
            }
            Ok(false) => {}
            Err(error) => {
                emit_openclaw_progress(
                    &app,
                    OpenClawSetupProgress {
                        phase: "auth".to_string(),
                        status: "官方 Codex 登录同步失败，准备打开 Codex 登录".to_string(),
                        detail: Some("Uniopc 会继续尝试官方 Codex CLI 登录流程。".to_string()),
                        output_tail: Some(tail_lines(&error, 12)),
                        percent: Some(18.0),
                    },
                )?;
            }
        }

        let rebind_backups = if force_rebind {
            emit_openclaw_progress(
                &app,
                OpenClawSetupProgress {
                    phase: "auth".to_string(),
                    status: "正在准备重新绑定 OpenAI Codex".to_string(),
                    detail: Some(
                        "Uniopc 会先备份并移除当前 Codex 授权，再打开官方 Codex 登录。".to_string(),
                    ),
                    output_tail: None,
                    percent: Some(15.0),
                },
            )?;
            Some(prepare_openclaw_provider_rebind(
                Some(&profile),
                OPENCLAW_OPENAI_CODEX_CLI_AUTH_PROVIDER,
            )?)
        } else {
            None
        };

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "network".to_string(),
                status: "正在检查 OpenAI 授权网络".to_string(),
                detail: Some("Uniopc 会自动继承系统代理后再检查网络出口。".to_string()),
                output_tail: None,
                percent: Some(10.0),
            },
        )?;
        if let Err(detail) = openai_codex_network_preflight(&app).await {
            if let Some((profiles_backup, state_backup, _)) = &rebind_backups {
                let agent_dir = openclaw_agent_dir_for_profile(Some(&profile))?;
                restore_backup(&agent_dir.join("auth-profiles.json"), profiles_backup);
                restore_backup(&agent_dir.join("auth-state.json"), state_backup);
            }
            emit_openclaw_progress(
                &app,
                OpenClawSetupProgress {
                    phase: "failed".to_string(),
                    status: "OpenAI 授权网络不可用".to_string(),
                    detail: Some(detail.clone()),
                    output_tail: None,
                    percent: None,
                },
            )?;
            return Err(detail);
        }

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "auth".to_string(),
                status: "正在启动 OpenAI Codex 浏览器登录".to_string(),
                detail: Some("Uniopc 会打开 OpenAI 登录页面；完成授权后会自动继续。".to_string()),
                output_tail: None,
                percent: Some(20.0),
            },
        )?;

        let (program, args) = openclaw_codex_login_hidden_command(Some(&profile), &target_model);
        let login_result = timeout(
            Duration::from_secs(OPENCLAW_CODEX_LOGIN_TIMEOUT_SECS),
            command_output_streaming(
                &app,
                &program,
                &args,
                "正在等待 OpenAI Codex 浏览器登录完成",
                "请在打开的 OpenAI 页面完成授权，完成后 Uniopc 会自动继续。",
                Some(60.0),
            ),
        )
        .await;

        let login_output = match login_result {
            Err(_) => {
                if sync_official_codex_auth_if_available(&app, &profile)
                    .await
                    .unwrap_or(false)
                {
                    return finish_openai_codex_login_with_synced_official_auth(
                        &app,
                        &profile,
                        &target_model,
                        None,
                    )
                    .await;
                }
                if openclaw_codex_auth_ready(&app, Some(&profile)).await {
                    ensure_openclaw_default_model_for_profile(&app, Some(&profile), &target_model)
                        .await?;
                    let next_status = build_openclaw_status(&app).await;
                    emit_openclaw_progress(
                        &app,
                        OpenClawSetupProgress {
                            phase: "success".to_string(),
                            status: "OpenAI Codex 授权已完成".to_string(),
                            detail: Some(
                                "Uniopc 已复查 Uniopc 引擎 auth 状态并刷新模型配置。".to_string(),
                            ),
                            output_tail: None,
                            percent: Some(100.0),
                        },
                    )?;
                    return Ok(OpenClawInstallResult {
                        status: next_status,
                        output_tail: None,
                    });
                }
                if let Some((profiles_backup, state_backup, _)) = &rebind_backups {
                    let agent_dir = openclaw_agent_dir_for_profile(Some(&profile))?;
                    restore_backup(&agent_dir.join("auth-profiles.json"), profiles_backup);
                    restore_backup(&agent_dir.join("auth-state.json"), state_backup);
                }
                let detail =
                    "OpenAI Codex 授权超时或浏览器回调失败。请关闭失败页面后重新点击登录。"
                        .to_string();
                emit_openclaw_progress(
                    &app,
                    OpenClawSetupProgress {
                        phase: "failed".to_string(),
                        status: "OpenAI Codex 授权失败".to_string(),
                        detail: Some(detail.clone()),
                        output_tail: None,
                        percent: None,
                    },
                )?;
                return Err(detail);
            }
            Ok(Ok(output)) => output,
            Ok(Err(output_tail)) => {
                if sync_official_codex_auth_if_available(&app, &profile)
                    .await
                    .unwrap_or(false)
                {
                    return finish_openai_codex_login_with_synced_official_auth(
                        &app,
                        &profile,
                        &target_model,
                        Some(tail_lines(&output_tail, 20)),
                    )
                    .await;
                }
                if openclaw_codex_auth_ready(&app, Some(&profile)).await {
                    ensure_openclaw_default_model_for_profile(&app, Some(&profile), &target_model)
                        .await?;
                    let next_status = build_openclaw_status(&app).await;
                    emit_openclaw_progress(
                        &app,
                        OpenClawSetupProgress {
                            phase: "success".to_string(),
                            status: "OpenAI Codex 授权已完成".to_string(),
                            detail: Some(
                                "Uniopc 已复查 Uniopc 引擎 auth 状态并刷新模型配置。".to_string(),
                            ),
                            output_tail: Some(tail_lines(&output_tail, 20)),
                            percent: Some(100.0),
                        },
                    )?;
                    return Ok(OpenClawInstallResult {
                        status: next_status,
                        output_tail: Some(tail_lines(&output_tail, 20)),
                    });
                }
                if let Some((profiles_backup, state_backup, _)) = &rebind_backups {
                    let agent_dir = openclaw_agent_dir_for_profile(Some(&profile))?;
                    restore_backup(&agent_dir.join("auth-profiles.json"), profiles_backup);
                    restore_backup(&agent_dir.join("auth-state.json"), state_backup);
                }
                let detail = openclaw_codex_login_failure_detail(&output_tail);
                let output_tail = if should_hide_codex_login_output(&output_tail) {
                    None
                } else {
                    Some(tail_lines(&output_tail, 30))
                };
                emit_openclaw_progress(
                    &app,
                    OpenClawSetupProgress {
                        phase: "failed".to_string(),
                        status: "OpenAI Codex 授权未完成".to_string(),
                        detail: Some(detail.clone()),
                        output_tail,
                        percent: None,
                    },
                )?;
                return Err(detail);
            }
        };

        let codex_auth_ready = openclaw_codex_auth_ready(&app, Some(&profile)).await;

        if sync_official_codex_auth_if_available(&app, &profile)
            .await
            .unwrap_or(false)
        {
            return finish_openai_codex_login_with_synced_official_auth(
                &app,
                &profile,
                &target_model,
                Some(tail_lines(&login_output, 20)),
            )
            .await;
        }

        if !codex_auth_ready {
            let detail = openclaw_codex_login_failure_detail(&login_output);
            let output_tail = if should_hide_codex_login_output(&login_output) {
                None
            } else {
                Some(tail_lines(&login_output, 30))
            };
            if let Some((profiles_backup, state_backup, _)) = &rebind_backups {
                let agent_dir = openclaw_agent_dir_for_profile(Some(&profile))?;
                restore_backup(&agent_dir.join("auth-profiles.json"), profiles_backup);
                restore_backup(&agent_dir.join("auth-state.json"), state_backup);
            }
            emit_openclaw_progress(
                &app,
                OpenClawSetupProgress {
                    phase: "failed".to_string(),
                    status: "OpenAI Codex 授权未完成".to_string(),
                    detail: Some(detail.clone()),
                    output_tail,
                    percent: None,
                },
            )?;
            return Err(detail);
        }

        ensure_openclaw_default_model_for_profile(&app, Some(&profile), &target_model).await?;
        let next_status = build_openclaw_status(&app).await;

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "success".to_string(),
                status: "OpenAI Codex 浏览器登录已完成".to_string(),
                detail: Some(format!("Uniopc 会使用 {target_model} 作为默认模型。")),
                output_tail: Some(tail_lines(&login_output, 20)),
                percent: Some(100.0),
            },
        )?;

        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail: Some(tail_lines(&login_output, 20)),
        })
    }

    pub(super) async fn openclaw_login_minimax_oauth_impl(
        app: AppHandle,
        model: Option<String>,
        profile: Option<String>,
    ) -> Result<OpenClawInstallResult, String> {
        let status = build_openclaw_status(&app).await;
        if !status.supported {
            return Err(status.message);
        }
        if !status.installed {
            return Err("请先安装 Uniopc 引擎，再开始 MiniMax 订阅登录。".to_string());
        }

        let target_model = normalize_openclaw_model_ref(
            model.as_deref().unwrap_or(OPENCLAW_MINIMAX_DEFAULT_MODEL),
            OPENCLAW_MINIMAX_AUTH_PROVIDER,
            OPENCLAW_MINIMAX_DEFAULT_MODEL,
        );
        let profile = crate::services::openclaw_runtime::require_profile_key(profile.as_deref())?;

        if let Some(model_status) = openclaw_model_status(&app).await {
            let minimax_auth_ready = model_status
                .providers_with_oauth
                .iter()
                .any(|provider| provider.starts_with(OPENCLAW_MINIMAX_AUTH_PROVIDER));
            if minimax_auth_ready {
                ensure_openclaw_default_model(&app, &target_model).await?;
                let next_status = build_openclaw_status(&app).await;
                emit_openclaw_progress(
                    &app,
                    OpenClawSetupProgress {
                        phase: "success".to_string(),
                        status: "检测到 MiniMax 已登录，已直接切换默认模型".to_string(),
                        detail: Some(target_model.clone()),
                        output_tail: None,
                        percent: Some(100.0),
                    },
                )?;

                return Ok(OpenClawInstallResult {
                    status: next_status,
                    output_tail: None,
                });
            }
        }

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "auth".to_string(),
                status: "正在启动 MiniMax 订阅登录".to_string(),
                detail: Some(
                    "Uniopc 会打开系统终端并执行 Uniopc 引擎 官方 MiniMax OAuth 流程。".to_string(),
                ),
                output_tail: None,
                percent: Some(20.0),
            },
        )?;

        let command = openclaw_minimax_login_terminal_command(Some(&profile), &target_model);
        let terminal_output = launch_terminal_command(&app, &command).await?;
        let next_status = build_openclaw_status(&app).await;

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "auth".to_string(),
                status: "MiniMax 订阅登录已在系统终端启动".to_string(),
                detail: Some(
                    "请在终端里完成 Uniopc 引擎 提示；完成后回到 Uniopc 点击刷新状态。".to_string(),
                ),
                output_tail: Some(tail_lines(&terminal_output, 20)),
                percent: Some(40.0),
            },
        )?;

        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail: Some(tail_lines(&terminal_output, 20)),
        })
    }
}
#[tauri::command]
pub async fn openclaw_official_bootstrap_snapshot(
    app: AppHandle,
    profile: Option<String>,
) -> Result<OpenClawModelsSnapshot, String> {
    let profile = super::normalize_openclaw_snapshot_profile(profile.as_deref());
    implementation::official_bootstrap_snapshot(&app, profile.as_deref()).await
}

#[tauri::command]
pub async fn openclaw_models_snapshot(
    app: AppHandle,
    profile: Option<String>,
) -> Result<OpenClawModelsSnapshot, String> {
    openclaw_models_snapshot_impl(app, profile).await
}

#[tauri::command]
pub async fn openclaw_use_provider_api_key_model(
    app: AppHandle,
    req: OpenClawProviderApiKeyRequest,
) -> Result<OpenClawInstallResult, String> {
    implementation::openclaw_use_provider_api_key_model_impl(app, req).await
}

/// Add a user-supplied OpenAI-compatible endpoint (their own baseUrl + key) as
/// a `custom-*` provider and make its model the profile default.
#[tauri::command]
pub async fn openclaw_use_custom_openai_model(
    app: AppHandle,
    req: OpenClawCustomModelRequest,
) -> Result<OpenClawInstallResult, String> {
    implementation::openclaw_use_custom_openai_model_impl(app, req).await
}

#[tauri::command]
pub async fn openclaw_use_uniopc_official_model(
    app: AppHandle,
    req: OpenClawUniopcOfficialRequest,
) -> Result<OpenClawInstallResult, String> {
    implementation::openclaw_use_uniopc_official_model_impl(app, req).await
}

/// Whether the official-model upstream token has been injected into the loopback
/// proxy this session. The token is memory-only and does NOT survive an app
/// restart, so JS bootstraps a connect once per launch even when config already
/// carries the provider (a no-op config.patch that just re-injects the token).
#[tauri::command]
pub async fn official_model_upstream_ready() -> bool {
    crate::services::official_model_proxy::official_upstream_ready()
}

/// Read only the tiny official-model portion of this Profile's on-disk config.
/// This deliberately avoids Gateway RPC: the desktop can pre-warm the
/// process-local upstream token in parallel with engine/plugin startup instead
/// of waiting for config.get + models.list + auth.status first.
#[tauri::command]
pub async fn official_model_local_profile_state(
    profile: Option<String>,
) -> Result<serde_json::Value, String> {
    let config =
        crate::services::openclaw_gateway::load_openclaw_config_for_profile(profile.as_deref())?;
    let provider = config.pointer("/models/providers/uniopc-official");
    let runtime_config_ready = provider
        .and_then(|provider| {
            Some((
                provider.get("baseUrl")?.as_str()?,
                provider.get("apiKey")?.as_str()?,
            ))
        })
        .is_some_and(|(base_url, api_key)| {
            crate::services::official_model_proxy::proxy_config_matches(base_url, api_key)
        });
    Ok(official_model_local_profile_state_from_config(
        &config,
        runtime_config_ready,
    ))
}

/// Lightweight official-model token refresh: update ONLY the loopback proxy's
/// in-memory upstream token. Unlike the full connect (`openclaw_use_uniopc_official_model`)
/// it does NO config.patch, config read, or gateway-ready wait — the config
/// already points at the proxy, only the memory token needs replacing. Called by
/// the JS refresh listener on a proxy-signalled 401 so the blocked request picks
/// up the fresh token in ~mint latency instead of the full connect path.
#[tauri::command]
pub async fn official_model_refresh_token(base_url: String, api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() || base_url.trim().is_empty() {
        return Err("official model refresh: empty base_url or token".to_string());
    }
    crate::services::official_model_proxy::set_official_upstream(&base_url, &api_key);
    Ok(())
}

#[tauri::command]
pub async fn openclaw_use_openai_api_model(
    app: AppHandle,
    api_key: String,
    model: Option<String>,
    profile: Option<String>,
) -> Result<OpenClawInstallResult, String> {
    implementation::openclaw_use_openai_api_model_impl(app, api_key, model, profile).await
}

#[tauri::command]
pub async fn openclaw_media_capabilities_save(
    app: AppHandle,
    req: OpenClawMediaCapabilitiesSaveRequest,
) -> Result<OpenClawModelsSnapshot, String> {
    openclaw_media_capabilities_save_impl(app, req).await
}

#[tauri::command]
pub async fn openclaw_login_openai_codex(
    app: AppHandle,
    model: Option<String>,
    force_rebind: Option<bool>,
    profile: Option<String>,
) -> Result<OpenClawInstallResult, String> {
    implementation::openclaw_login_openai_codex_impl(app, model, force_rebind, profile).await
}

#[tauri::command]
pub async fn openclaw_login_minimax_oauth(
    app: AppHandle,
    model: Option<String>,
    profile: Option<String>,
) -> Result<OpenClawInstallResult, String> {
    implementation::openclaw_login_minimax_oauth_impl(app, model, profile).await
}

#[cfg(test)]
mod tests {
    use super::{normalize_openclaw_model_ref, official_model_local_profile_state_from_config};

    #[test]
    fn model_boundary_owns_provider_ref_normalization() {
        assert_eq!(
            normalize_openclaw_model_ref("qwen3.7-plus", "qwen", "qwen/qwen3.7-plus"),
            "qwen/qwen3.7-plus"
        );
        assert_eq!(
            normalize_openclaw_model_ref("openai/gpt-5.4", "qwen", "qwen/qwen3.7-plus"),
            "openai/gpt-5.4"
        );
    }

    #[test]
    fn local_official_state_exposes_only_models_registered_in_both_config_locations() {
        let config = serde_json::json!({
            "agents": { "defaults": {
                "model": { "primary": "uniopc-official/minimax-m3" },
                "models": {
                    "uniopc-official/minimax-m3": {},
                    "uniopc-official/stale": {},
                    "openai/gpt-5.4": {}
                }
            }},
            "models": { "providers": { "uniopc-official": {
                "baseUrl": "http://127.0.0.1:1234/v1",
                "apiKey": "loopback-secret",
                "models": [
                    { "id": "minimax-m3" },
                    { "id": "qwen-3.7" }
                ]
            }}}
        });

        let state = official_model_local_profile_state_from_config(&config, true);
        assert_eq!(state["configured"], true);
        assert_eq!(state["runtimeReady"], true);
        assert_eq!(state["selected"], true);
        assert_eq!(state["primaryModel"], "uniopc-official/minimax-m3");
        assert_eq!(
            state["modelRefs"],
            serde_json::json!(["uniopc-official/minimax-m3"])
        );
    }

    #[test]
    fn local_official_state_rejects_a_dangling_default_without_provider_credentials() {
        let config = serde_json::json!({
            "agents": { "defaults": {
                "model": { "primary": "uniopc-official/uniopc-default" },
                "models": { "uniopc-official/uniopc-default": {} }
            }}
        });

        let state = official_model_local_profile_state_from_config(&config, false);
        assert_eq!(state["configured"], false);
        assert_eq!(state["runtimeReady"], false);
        assert_eq!(state["selected"], true);
        assert_eq!(state["modelRefs"], serde_json::json!([]));
    }
}
