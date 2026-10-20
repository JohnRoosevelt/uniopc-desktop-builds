//! Public Uniopc plugin runtime command facade.
//!
//! Command names and outward DTOs remain stable here while artifact
//! compatibility and runtime implementation details stay behind the domain
//! boundary.

use super::{
    OpenClawProfilePluginDoctorReport, OpenClawProfilePluginDoctorRequest,
    OpenClawProfilePluginReconcileRequest, OpenClawProfilePluginSetRequest,
    OpenClawProfilePluginsSnapshot, OpenClawProfileToolCapabilitiesSnapshot,
    OpenClawSupportedPluginsSnapshot,
};
use crate::commands::plugin_lifecycle::{
    PluginArtifactReview, PluginLifecycleError, PluginLifecycleStaging, PreparedPluginInstall,
};
use tauri::{AppHandle, State};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniopcPluginLifecyclePrepareRequest {
    pub profile: Option<String>,
    pub plugin_id: String,
    pub artifact_sha256: String,
    pub zip_base64: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniopcPluginLifecycleCommitRequest {
    pub stage_id: String,
    pub profile: String,
    pub plugin_id: String,
    pub artifact_sha256: String,
    pub enable: bool,
    pub cloud_agent_api_url: Option<String>,
    pub cloud_agent_host_credential: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniopcPluginLifecycleCancelRequest {
    pub stage_id: String,
    pub profile: String,
    pub plugin_id: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniopcCloudPluginUninstallRequest {
    pub profile: Option<String>,
    pub plugin_id: String,
}

/// 云端授权状态,由前端从 catalog + entitlement 推导后传入。
/// 工具清单**不**由前端提供 —— 本地已装 manifest 的 `contracts.tools`
/// 才是工具的事实源,两边的事实各自权威、在这里合并。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginGrantStatusInput {
    pub plugin_id: String,
    pub status: String,
    #[serde(default)]
    pub name: Option<String>,
    /// "all" 或 agent id 数组(P1 装备制预留;缺省 = 全员)。
    #[serde(default)]
    pub agents: Option<serde_json::Value>,
}

pub(super) mod implementation {
    use super::super::*;
    use super::*;

    fn cloud_agent_host_credential_for_plugin(env: &Map<String, Value>, plugin_id: &str) -> String {
        let scoped = env_string(env, cloud_agent_host_credential_env_key(plugin_id));
        if scoped.is_empty() {
            env_string(env, "UNIOPC_HOST_CREDENTIAL")
        } else {
            scoped
        }
    }

    async fn runtime_inspect_all_plugins(
        app: &AppHandle,
        profile: &str,
    ) -> Option<HashMap<String, Value>> {
        for attempt in 0..RUNTIME_INSPECT_MAX_ATTEMPTS {
            let output = crate::commands::model::openclaw_output_for_profile(
                app,
                profile,
                &["plugins", "inspect", "--all", "--runtime", "--json"],
            )
            .await;
            if let Ok(output) = output {
                if let Some(Value::Array(items)) = parse_cli_json_lenient(&output) {
                    let mut by_id = HashMap::new();
                    for item in items {
                        if let Some(id) = item
                            .get("plugin")
                            .and_then(|plugin| plugin.get("id"))
                            .and_then(Value::as_str)
                        {
                            by_id.insert(id.to_string(), item);
                        }
                    }
                    return Some(by_id);
                }
            }
            if attempt + 1 < RUNTIME_INSPECT_MAX_ATTEMPTS {
                sleep(Duration::from_millis(RUNTIME_INSPECT_RETRY_DELAY_MS)).await;
            }
        }
        None
    }

    // Pure sidecar: the gateway config env is injected fresh on every child spawn,
    // so applying a plugin-config change is just respawning the app-owned gateway
    // child — there is no service env to reinstall.
    async fn respawn_gateway_after_plugin_patch(app: &AppHandle) -> Result<(), String> {
        use tauri::Manager;
        app.state::<crate::commands::model::GatewaySupervisor>()
            .restart()
            .await
            .map_err(|error| {
                format!("插件授权已写入 Uniopc 引擎 config，但重启 Gateway 失败: {error}")
            })
    }

    async fn probe_cloud_agent_business_health(
        plugin_id: &str,
        profile: &str,
        env: &Map<String, Value>,
    ) -> Result<(), String> {
        let Some((api_url_key, action, fallback_code)) = cloud_agent_health_probe(plugin_id) else {
            return Ok(());
        };
        let api_url = env_string(env, api_url_key);
        let host_credential = cloud_agent_host_credential_for_plugin(env, plugin_id);
        if api_url.is_empty() || host_credential.is_empty() {
            return Err("missing_env".to_string());
        }
        let openclaw_profile = {
            let value = env_string(env, "UNIOPC_OPENCLAW_PROFILE");
            if value.is_empty() {
                profile.to_string()
            } else {
                value
            }
        };
        let body = json!({
            "action": action,
            "payload": {},
            "agent": {
                "openclawProfile": openclaw_profile,
                "openclawAgentId": env_string(env, "UNIOPC_AGENT_ID"),
            },
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(CLOUD_AGENT_HEALTH_TIMEOUT_MS))
            .no_proxy()
            .build()
            .map_err(|_| fallback_code.to_string())?;
        let response = client
            .post(api_url)
            .header("x-uniopc-host-credential", host_credential)
            .json(&body)
            .send()
            .await
            .map_err(|_| fallback_code.to_string())?;
        let status = response.status().as_u16();
        let value = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        let code = value
            .get("code")
            .or_else(|| value.get("error"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if cloud_agent_health_response_is_ready(status, code, value.get("error").is_some()) {
            return Ok(());
        }
        Err(cloud_agent_health_failure_status(
            status,
            code,
            fallback_code,
        ))
    }

    // Side-effect free: plugins are placed on disk by the official
    // `openclaw plugins install` lifecycle (bundled bootstrap or the cloud-artifact
    // install command); this only resolves the expected managed location.
    // 不再按 id 白名单——任何形状合法的插件 id 都解析到官方 CLI 的受管
    // extensions 目录,新增云插件因此无需改桌面代码。
    fn plugin_path_for_app(_app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
        let plugin_id = plugin_id.trim();
        if !is_safe_plugin_id(plugin_id) {
            return Err(format!("不支持管理插件 `{plugin_id}`。"));
        }
        installed_system_plugin_path(plugin_id)
    }

    fn note_business_health_warning(
        plugin: &mut OpenClawProfileToolCapabilityPlugin,
        status: String,
        reason: String,
    ) {
        if plugin.status != "ready" {
            return;
        }
        plugin.business_health_state = status;
        plugin.business_health_label = "服务异常".to_string();
        if !plugin.readiness_reasons.iter().any(|item| item == &reason) {
            plugin.readiness_reasons.push(reason);
        }
    }

    fn mark_business_health_failed(
        plugin: &mut OpenClawProfileToolCapabilityPlugin,
        status: String,
        reason: String,
    ) {
        if plugin.status != "ready" {
            return;
        }
        plugin.status = status.clone();
        plugin.business_health_state = status;
        plugin.business_health_label = if plugin.business_health_state == "unauthorized" {
            "未授权".to_string()
        } else if plugin.business_health_state == "missing_env" {
            "待管理员配置".to_string()
        } else {
            "服务异常".to_string()
        };
        if !plugin.readiness_reasons.iter().any(|item| item == &reason) {
            plugin.readiness_reasons.push(reason);
        }
        plugin.tools.clear();
    }

    // 扫描 extensions 目录里已安装、但不在内置登记表里的官方云插件(约定 id
    // 前缀 `uniopc-`,见 AUTHORING.md §3.5),让新插件同样出现在快照/体检/
    // 能力列表里。非 uniopc- 前缀的第三方插件保持既有 custom 插件路径。
    fn installed_dynamic_plugin_definitions(
        known_ids: &HashSet<String>,
    ) -> Vec<ProfilePluginDefinition> {
        let Ok(extensions_dir) = openclaw_extensions_dir() else {
            return Vec::new();
        };
        installed_dynamic_plugin_definitions_in(&extensions_dir, known_ids)
    }

    fn installed_dynamic_plugin_definitions_for_profile(
        profile: &str,
        known_ids: &HashSet<String>,
    ) -> Vec<ProfilePluginDefinition> {
        let Ok(extensions_dir) = openclaw_extensions_dir_for_profile(Some(profile)) else {
            return Vec::new();
        };
        installed_dynamic_plugin_definitions_in(&extensions_dir, known_ids)
    }

    fn installed_dynamic_plugin_definitions_in(
        extensions_dir: &Path,
        known_ids: &HashSet<String>,
    ) -> Vec<ProfilePluginDefinition> {
        let Ok(entries) = std::fs::read_dir(extensions_dir) else {
            return Vec::new();
        };
        let mut definitions = Vec::new();
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !name.starts_with("uniopc-")
                || known_ids.contains(&name)
                || !is_safe_plugin_id(&name)
            {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(crate::services::plugin_artifact::plugin_manifest_path(&entry.path())) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            definitions.push(definition_from_manifest(&name, &manifest));
        }
        definitions.sort_by(|a, b| a.id.cmp(&b.id));
        definitions
    }

    async fn verify_runtime_tool_capabilities(
        app: &AppHandle,
        profile: &str,
        capabilities: &mut OpenClawProfileToolCapabilitiesSnapshot,
    ) {
        if !capabilities
            .plugins
            .iter()
            .any(|plugin| plugin.status == "ready")
        {
            return;
        }
        let inspected = runtime_inspect_all_plugins(app, profile).await;
        for plugin in capabilities
            .plugins
            .iter_mut()
            .filter(|plugin| plugin.status == "ready")
        {
            match inspected.as_ref().and_then(|by_id| by_id.get(&plugin.id)) {
                Some(value) => {
                    let runtime_tool_names = runtime_inspect_tool_names(value);
                    apply_runtime_tool_verification(plugin, &runtime_tool_names);
                }
                None => mark_runtime_inspect_unverified(plugin),
            }
        }
    }

    async fn verify_cloud_agent_business_health(
        profile: &str,
        entries: &Map<String, Value>,
        capabilities: &mut OpenClawProfileToolCapabilitiesSnapshot,
    ) {
        let probe_plugin_ids: Vec<String> = capabilities
            .plugins
            .iter()
            .filter(|plugin| {
                plugin.status == "ready" && cloud_agent_health_probe(&plugin.id).is_some()
            })
            .map(|plugin| plugin.id.clone())
            .collect();
        if probe_plugin_ids.is_empty() {
            return;
        }
        let probes =
            futures_util::future::join_all(probe_plugin_ids.into_iter().map(|plugin_id| {
                let profile = profile.to_string();
                let env = plugin_private_env_from_entries(entries, &plugin_id);
                async move {
                    let result =
                        probe_cloud_agent_business_health(&plugin_id, &profile, &env).await;
                    (plugin_id, result)
                }
            }))
            .await;
        for (plugin_id, result) in probes {
            let Some(plugin) = capabilities
                .plugins
                .iter_mut()
                .find(|plugin| plugin.id == plugin_id)
            else {
                continue;
            };
            if let Err(status) = result {
                let reason = format!("business_health:{status}");
                if !business_health_status_blocks_capability(&status) {
                    note_business_health_warning(plugin, status, reason);
                    continue;
                }
                mark_business_health_failed(plugin, status.clone(), reason);
            }
        }
    }

    async fn restart_gateway_after_plugin_patch(
        app: &AppHandle,
        profile: &str,
        _sync_service_env: bool,
    ) -> Result<(), String> {
        respawn_gateway_after_plugin_patch(app).await?;
        if crate::commands::model::wait_for_openclaw_profile_gateway_ready(profile).await {
            return Ok(());
        }
        Err(
            "插件授权已写入 Uniopc 引擎 config，但 Gateway 重启后未能就绪。请稍后重试，或前往运行中心检查 Uniopc 引擎日志。"
                .to_string(),
        )
    }

    pub(crate) fn plugin_paths_for_app(
        app: &AppHandle,
    ) -> Result<Vec<(ProfilePluginDefinition, PathBuf)>, String> {
        let mut plugin_paths = plugin_definitions()
            .into_iter()
            .map(|definition| {
                plugin_path_for_app(app, &definition.id).map(|path| (definition, path))
            })
            .collect::<Result<Vec<_>, String>>()?;
        // 内置 id + 其历史别名都算已知,防止旧别名目录(如 uniopc-super-ip)
        // 被当成新插件重复上报。
        let mut known_ids = plugin_paths
            .iter()
            .map(|(definition, _)| definition.id.clone())
            .collect::<HashSet<_>>();
        for id in known_ids.clone() {
            known_ids.extend(plugin_aliases(&id));
        }
        for definition in installed_dynamic_plugin_definitions(&known_ids) {
            let path = installed_system_plugin_path(&definition.id)?;
            plugin_paths.push((definition, path));
        }
        Ok(plugin_paths)
    }

    fn plugin_paths_for_profile(
        _app: &AppHandle,
        profile: &str,
    ) -> Result<Vec<(ProfilePluginDefinition, PathBuf)>, String> {
        let mut plugin_paths = plugin_definitions()
            .into_iter()
            .map(|definition| {
                installed_system_plugin_path_for_profile(Some(profile), &definition.id)
                    .map(|path| (definition, path))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut known_ids = plugin_paths
            .iter()
            .map(|(definition, _)| definition.id.clone())
            .collect::<HashSet<_>>();
        for id in known_ids.clone() {
            known_ids.extend(plugin_aliases(&id));
        }
        for definition in installed_dynamic_plugin_definitions_for_profile(profile, &known_ids) {
            let path = installed_system_plugin_path_for_profile(Some(profile), &definition.id)?;
            plugin_paths.push((definition, path));
        }
        Ok(plugin_paths)
    }

    fn plugin_manifest_supports_private_env(plugin_path: &Path) -> bool {
        std::fs::read_to_string(crate::services::plugin_artifact::plugin_manifest_path(&plugin_path))
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|manifest| manifest.get("configSchema").cloned())
            .and_then(|schema| schema.get("properties").cloned())
            .and_then(|properties| properties.get("env").cloned())
            .and_then(|env| env.get("type").and_then(Value::as_str).map(str::to_string))
            .as_deref()
            == Some("object")
    }

    pub(crate) async fn tool_capabilities_for_profile(
        app: &AppHandle,
        profile: &str,
    ) -> Result<OpenClawProfileToolCapabilitiesSnapshot, String> {
        let plugin_paths = plugin_paths_for_profile(app, profile)?;
        let snapshot = openclaw_gateway::config_get(Some(profile)).await?;
        let entries = plugin_entries_from_snapshot(&snapshot);
        let mut capabilities =
            tool_capabilities_from_config(profile.to_string(), &snapshot, &plugin_paths);
        verify_runtime_tool_capabilities(app, profile, &mut capabilities).await;
        verify_cloud_agent_business_health(profile, &entries, &mut capabilities).await;
        Ok(capabilities)
    }

    async fn restart_gateway_after_plugin_patch_or_recover(
        app: &AppHandle,
        profile: &str,
        sync_service_env: bool,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<Option<OpenClawProfilePluginsSnapshot>, String> {
        match restart_gateway_after_plugin_patch(app, profile, sync_service_env).await {
            Ok(()) => Ok(None),
            Err(restart_error) => {
                if let Ok(config_snapshot) = openclaw_gateway::config_get(Some(profile)).await {
                    let plugin_snapshot = snapshot_from_config(
                        profile.to_string(),
                        &config_snapshot,
                        &plugin_paths_for_profile(app, profile)?,
                    );
                    if plugin_snapshot_reaches_desired_state(&plugin_snapshot, plugin_id, enabled) {
                        return Ok(Some(plugin_snapshot));
                    }
                }
                Err(restart_error)
            }
        }
    }

    fn require_plugin_private_env_schema(
        app: &AppHandle,
        definition: &ProfilePluginDefinition,
    ) -> Result<(), String> {
        let plugin_path = plugin_path_for_app(app, &definition.id)?;
        if plugin_manifest_supports_private_env(&plugin_path) {
            return Ok(());
        }
        Err(format!(
            "插件 `{}` 仍是旧版包，无法在 OpenClaw 8.1 中安全写入凭据；请回到插件市场更新后再启用。",
            definition.title
        ))
    }

    fn recover_plugins_after_patch_from_local_config(
        profile: &str,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<Option<Value>, String> {
        let snapshot = openclaw_gateway::load_openclaw_config_for_profile(Some(profile))?;
        if plugin_enabled_matches(&snapshot, plugin_id, enabled) {
            Ok(Some(snapshot))
        } else {
            Ok(None)
        }
    }

    async fn recover_plugins_after_patch(
        profile: &str,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<Option<Value>, String> {
        let mut last_read_error = None;
        for attempt in 0..PLUGIN_CONFIG_PATCH_RECOVERY_ATTEMPTS {
            match openclaw_gateway::config_get(Some(profile)).await {
                Ok(snapshot) => {
                    if plugin_enabled_matches(&snapshot, plugin_id, enabled) {
                        return Ok(Some(snapshot));
                    }
                    last_read_error = None;
                }
                Err(error) => last_read_error = Some(error),
            }
            if attempt + 1 < PLUGIN_CONFIG_PATCH_RECOVERY_ATTEMPTS {
                sleep(Duration::from_millis(PLUGIN_CONFIG_PATCH_RECOVERY_DELAY_MS)).await;
            }
        }
        match last_read_error {
            Some(error) => Err(error),
            None => Ok(None),
        }
    }

    fn optional_non_empty(value: Option<&String>) -> Option<String> {
        value
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    pub(in crate::commands::openclaw_plugins) fn normalize_profile(
        profile: Option<&str>,
    ) -> String {
        openclaw_runtime::normalize_profile_key(profile)
    }

    fn cleanup_legacy_root_plugin_env(profile: &str) -> Result<bool, String> {
        let snapshot = openclaw_gateway::load_openclaw_config_for_profile(Some(profile))?;
        let Some(patch) = legacy_root_plugin_env_cleanup_patch(&snapshot) else {
            return Ok(false);
        };
        crate::commands::openclaw_connection::save_openclaw_gateway_config_patch(profile, patch)?;
        Ok(true)
    }

    fn cloud_agent_auth_for_plugin<'a>(
        rows: &'a [CloudAgentPluginAuthInput],
        plugin_id: &str,
    ) -> Option<&'a CloudAgentPluginAuthInput> {
        rows.iter()
            .find(|row| row.plugin_id.trim() == plugin_id.trim())
    }

    pub(super) async fn openclaw_profile_plugins_list_impl(
        app: AppHandle,
        profile: Option<String>,
    ) -> Result<OpenClawProfilePluginsSnapshot, String> {
        let profile_key = normalize_profile(profile.as_deref());
        let plugin_paths = plugin_paths_for_profile(&app, &profile_key)?;
        // This list drives the App Center's installed tab. The profile config
        // is atomically written by the plugin lifecycle and is therefore the
        // install-state source of truth. The gateway can return an older
        // snapshot while it reloads, which previously made a loaded plugin
        // appear as "运行异常" and kept it out of "已安装".
        let snapshot = match openclaw_gateway::load_openclaw_config_for_profile(Some(&profile_key)) {
            Ok(snapshot) => snapshot,
            Err(_) => openclaw_gateway::config_get(Some(&profile_key)).await?,
        };
        Ok(snapshot_from_config(profile_key, &snapshot, &plugin_paths))
    }

    pub(super) async fn openclaw_supported_plugins_list_impl(
        app: AppHandle,
    ) -> Result<OpenClawSupportedPluginsSnapshot, String> {
        Ok(OpenClawSupportedPluginsSnapshot {
            plugins: supported_plugin_records_for_paths(plugin_paths_for_app(&app)?),
        })
    }

    /// Verify and stage a cloud-distributed artifact after the browser has obtained
    /// the entitlement-gated download authorization from Uniopc SaaS. This command
    /// intentionally performs no CLI installation or configuration mutation: the
    /// returned review must be explicitly confirmed by the user before commit.
    pub(super) fn uniopc_plugin_lifecycle_prepare_impl(
        staging: State<'_, PluginLifecycleStaging>,
        req: UniopcPluginLifecyclePrepareRequest,
    ) -> Result<PluginArtifactReview, PluginLifecycleError> {
        let prepared = compatibility::prepare_plugin_install(req)?;
        let review = prepared
            .review
            .clone()
            .ok_or_else(|| PluginLifecycleError::artifact("插件安装暂存缺少能力审阅信息。"))?;
        staging.insert(prepared);
        Ok(review)
    }

    /// Commit can only consume the exact profile/plugin/artifact stage returned by
    /// `uniopc_plugin_lifecycle_prepare`. The CLI receives capability consent here,
    /// never during artifact download or page rendering.
    pub(super) async fn uniopc_plugin_lifecycle_commit_impl(
        app: AppHandle,
        staging: State<'_, PluginLifecycleStaging>,
        req: UniopcPluginLifecycleCommitRequest,
    ) -> Result<OpenClawProfilePluginsSnapshot, String> {
        let profile = normalize_profile(Some(&req.profile));
        let plugin_id = req.plugin_id.trim().to_string();
        let artifact_sha256 = req.artifact_sha256.trim().to_lowercase();
        let prepared = staging
            .get_for_hash(&req.stage_id, &profile, &plugin_id, &artifact_sha256)
            .ok_or_else(|| "插件审阅已失效，无法提交安装；请重新打开安装确认。".to_string())?;
        let source_dir = prepared
            .source_dir
            .as_deref()
            .ok_or_else(|| "插件审阅暂存不完整，无法提交安装。".to_string())?;

        // The Montage plugin invokes FFmpeg locally. Provision it as part of
        // this reviewed install, before the plugin is enabled or Gateway is
        // restarted, so a final user never has to install system software.
        if plugin_id == "uniopc-montage" {
            tokio::task::spawn_blocking(crate::services::montage_media_runtime::ensure_installed)
                .await
                .map_err(|error| format!("准备智能混剪媒体运行时失败: {error}"))??;
        }

        // The artifact was fully verified and capability-reviewed before this
        // commit. Only now is it safe to prepare a replacement of the previous
        // managed install. npm may have generated hard-linked native binaries
        // under node_modules; OpenClaw's atomic backup intentionally refuses to
        // move those links. Remove only those generated directories, keeping
        // the manifest/configuration in place for the CLI's normal replacement.
        let installed_dir = installed_system_plugin_path_for_profile(Some(&profile), &plugin_id)?;
        prune_generated_plugin_dependencies(&installed_dir)?;

        // Cloud plugin state is per Uniopc profile. The unscoped CLI helper
        // targets the legacy/default OpenClaw state, so upgrades of an older
        // profile install the new files somewhere else and the following
        // profile patch is rejected by Gateway as INVALID_REQUEST.
        let install_result = cli_install_plugin_dir_for_profile(
            &profile,
            source_dir,
            PluginInstallOptions::reviewed_replacement(),
        )
        .await;
        if let Err(error) = install_result {
            cleanup_prepared_install(&prepared);
            staging.remove_for(&req.stage_id, &profile, &plugin_id);
            return Err(error);
        }

        // `openclaw plugins install --force` atomically rewrites the profile
        // config. The Gateway intentionally rejects every config.patch until
        // that external write has been reloaded, so patching the host
        // credential immediately afterwards can exhaust the optimistic retry
        // budget with `gateway.configChangedSinceLastLoad`. Reload first;
        // `openclaw_profile_plugin_set_impl` can then safely make its own
        // enable/credential patch and performs the final reload afterwards.
        if let Err(error) = restart_gateway_after_plugin_patch(&app, &profile, false).await {
            cleanup_prepared_install(&prepared);
            staging.remove_for(&req.stage_id, &profile, &plugin_id);
            return Err(error);
        }

        let result = openclaw_profile_plugin_set_impl(
            app,
            OpenClawProfilePluginSetRequest {
                profile: Some(profile.clone()),
                plugin_id: plugin_id.clone(),
                enabled: req.enable,
                cloud_agent_api_url: req.cloud_agent_api_url,
                cloud_agent_host_credential: req.cloud_agent_host_credential,
                plugin_env: None,
            },
        )
        .await;
        cleanup_prepared_install(&prepared);
        staging.remove_for(&req.stage_id, &profile, &plugin_id);
        result
    }

    pub(super) fn uniopc_plugin_lifecycle_cancel_impl(
        staging: State<'_, PluginLifecycleStaging>,
        req: UniopcPluginLifecycleCancelRequest,
    ) -> Result<(), String> {
        let profile = normalize_profile(Some(&req.profile));
        let plugin_id = req.plugin_id.trim().to_string();
        let prepared = staging
            .remove_for(&req.stage_id, &profile, &plugin_id)
            .ok_or_else(|| "插件审阅已失效或不属于当前账号。".to_string())?;
        cleanup_prepared_install(&prepared);
        Ok(())
    }

    pub(in crate::commands::openclaw_plugins) fn cleanup_prepared_install(
        prepared: &PreparedPluginInstall,
    ) {
        if let Some(stage_dir) = prepared.stage_dir.as_deref() {
            let _ = std::fs::remove_dir_all(stage_dir);
        }
    }

    /// Uninstall a cloud-distributed plugin: disable its entry first, then remove
    /// it through the official `openclaw plugins uninstall` lifecycle.
    pub(super) async fn uniopc_cloud_plugin_uninstall_impl(
        app: AppHandle,
        req: UniopcCloudPluginUninstallRequest,
    ) -> Result<OpenClawProfilePluginsSnapshot, String> {
        let plugin_id = req.plugin_id.trim().to_string();
        if !is_safe_plugin_id(&plugin_id) {
            return Err(format!("插件 `{plugin_id}` 不支持云端卸载。"));
        }
        let snapshot = openclaw_profile_plugin_set_impl(
            app.clone(),
            OpenClawProfilePluginSetRequest {
                profile: req.profile.clone(),
                plugin_id: plugin_id.clone(),
                enabled: false,
                cloud_agent_api_url: None,
                cloud_agent_host_credential: None,
                plugin_env: None,
            },
        )
        .await?;
        cli_uninstall_plugin(&plugin_id).await?;
        let _ = snapshot;
        openclaw_profile_plugins_list_impl(app, req.profile).await
    }

    pub(super) async fn openclaw_profile_plugin_doctor_check_impl(
        app: AppHandle,
        req: OpenClawProfilePluginDoctorRequest,
    ) -> Result<OpenClawProfilePluginDoctorReport, String> {
        let profile = normalize_profile(req.profile.as_deref());
        let plugin_paths = plugin_paths_for_profile(&app, &profile)?;
        let snapshot = openclaw_gateway::config_get(Some(&profile)).await?;
        let mut report = build_plugin_doctor_report(
            profile.clone(),
            req.policy_version,
            &snapshot,
            &plugin_paths,
            &req.plugins,
        );
        let capabilities = tool_capabilities_for_profile(&app, &report.profile).await?;
        append_runtime_capability_doctor_items(&mut report, &capabilities, &req.plugins);
        report.capabilities = Some(capabilities);
        Ok(report)
    }

    pub(super) async fn openclaw_profile_tool_capabilities_list_impl(
        app: AppHandle,
        profile: Option<String>,
    ) -> Result<OpenClawProfileToolCapabilitiesSnapshot, String> {
        let profile_key = normalize_profile(profile.as_deref());
        let capabilities = tool_capabilities_for_profile(&app, &profile_key).await?;
        // Keep every agent's TOOLS.md plugin-capability notes in sync. This read
        // path is hit after every plugin lifecycle change and on each "/" menu
        // open, so piggybacking here converges without wiring every mutation
        // site; spawned so the caller pays no latency, diffed so steady state
        // writes nothing.
        {
            let app = app.clone();
            let profile_key = profile_key.clone();
            tauri::async_runtime::spawn(async move {
                sync_plugin_capability_notes_to_agents(&app, &profile_key).await;
            });
        }
        Ok(capabilities)
    }

    pub(in crate::commands::openclaw_plugins) const PLUGIN_CAPABILITY_NOTES_START: &str =
        "<!-- uniopc:plugin-capabilities:start -->";
    pub(in crate::commands::openclaw_plugins) const PLUGIN_CAPABILITY_NOTES_END: &str =
        "<!-- uniopc:plugin-capabilities:end -->";

    pub(in crate::commands::openclaw_plugins) fn plugin_skill_names(
        plugin_path: &Path,
    ) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(plugin_path.join("skills")) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| !name.starts_with('.') && name != "node_modules")
            .collect();
        names.sort();
        names
    }

    // Agents evaluate "is plugin X usable" from what they can see, and plugin
    // tools are only one of two capability forms — skill packs (documents /
    // presentations / shopify) ship zero tools by design and used to get reported
    // as "未暴露工具 → 不可用". This renders the authoritative plugin↔capability
    // mapping into a managed TOOLS.md block (a standard OpenClaw bootstrap file
    // injected into every agent's system prompt) so every asking path gets the
    // correct picture, not just "/" invocations.
    fn render_plugin_capability_notes(
        capabilities: &OpenClawProfileToolCapabilitiesSnapshot,
        plugin_paths: &[(ProfilePluginDefinition, PathBuf)],
    ) -> String {
        let mut lines = vec![
            PLUGIN_CAPABILITY_NOTES_START.to_string(),
            "## 已装能力对照(Uniopc 桌面自动维护,勿手改)".to_string(),
            String::new(),
            "下表是这台机器已安装的能力。**这是给你自己查的内部映射,不要讲给用户听。**".to_string(),
            String::new(),
            "怎么用:".to_string(),
            "- 用户说\"演示文稿/做个 PPT\"这类需求时,查下表找到对应能力,直接开工。能力可能以工具(tools)形式注册,也可能以技能(Skill,已在你的 Skill 列表里)形式提供——**两种都算可用**。".to_string(),
            "- **能力列为空或只有技能、没有工具,都不等于不可用。** 只有状态列不是 ready 时才算不可用。".to_string(),
            "- 对于技能包，先使用已加载的 Skill；**不要用 read/exec 猜测或读取 `extensions/<plugin>/SKILL.md`**。技能文件位于各自的 `skills/<skill>/SKILL.md` 目录，根目录没有通用的 SKILL.md。".to_string(),
            "- 用户明确指定文件扩展名时按扩展名直接路由：指定 `.docx` 就直接使用 docx Skill 创建或编辑 Word 文件；用户明确要求本地文档或 Markdown 时才调用 `uniopc_local_documents_*`。不要把这两条实现路径再交给用户二次选择。".to_string(),
            "- **对用户一律用「能力名」称呼**(如\"演示文稿\"),不要说 plugin / skill / 技能包 / 工具接口 / 能力形态这些内部词,也不要向用户解释插件与技能的区别——那是实现细节。用户问某能力可不可用,直接回答可用或不可用加一句原因即可。".to_string(),
            String::new(),
            "| 能力名 | 内部 ID | 状态 | 内部实现(勿外传) |".to_string(),
            "|---|---|---|---|".to_string(),
        ];
        for plugin in &capabilities.plugins {
            let skills = plugin_paths
                .iter()
                .find(|(definition, _)| definition.id == plugin.id)
                .map(|(_, path)| plugin_skill_names(path))
                .unwrap_or_default();
            let mut forms = Vec::new();
            if !plugin.tools.is_empty() {
                forms.push(format!("工具 ×{}", plugin.tools.len()));
            }
            if !skills.is_empty() {
                forms.push(format!("技能包:{}", skills.join("、")));
            }
            if forms.is_empty() {
                forms.push("(无)".to_string());
            }
            lines.push(format!(
                "| {} | {} | {} | {} |",
                plugin.title,
                plugin.id,
                plugin.status,
                forms.join(";"),
            ));
        }
        lines.push(PLUGIN_CAPABILITY_NOTES_END.to_string());
        lines.join("\n")
    }

    pub(in crate::commands::openclaw_plugins) fn upsert_plugin_capability_notes(
        existing: &str,
        block: &str,
    ) -> String {
        if let (Some(start), Some(end)) = (
            existing.find(PLUGIN_CAPABILITY_NOTES_START),
            existing.find(PLUGIN_CAPABILITY_NOTES_END),
        ) {
            if start < end {
                let after = &existing[end + PLUGIN_CAPABILITY_NOTES_END.len()..];
                return format!("{}{}{}", &existing[..start], block, after);
            }
        }
        if existing.trim().is_empty() {
            return format!("{block}\n");
        }
        format!("{}\n\n{}\n", existing.trim_end(), block)
    }

    pub(in crate::commands::openclaw_plugins) fn agent_ids_from_config_snapshot(
        snapshot: &Value,
    ) -> Vec<String> {
        let mut ids: Vec<String> = snapshot_root(snapshot)
            .get("agents")
            .and_then(|agents| agents.get("list"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        if !ids.iter().any(|id| id == "main") {
            ids.push("main".to_string());
        }
        ids
    }

    pub(crate) async fn sync_plugin_capability_notes_to_agents(app: &AppHandle, profile: &str) {
        let Ok(plugin_paths) = plugin_paths_for_profile(app, profile) else {
            return;
        };
        let Ok(snapshot) = openclaw_gateway::config_get(Some(profile)).await else {
            return;
        };
        let capabilities =
            tool_capabilities_from_config(profile.to_string(), &snapshot, &plugin_paths);
        let block = render_plugin_capability_notes(&capabilities, &plugin_paths);
        for agent_id in agent_ids_from_config_snapshot(&snapshot) {
            let existing = openclaw_gateway::agent_files_get(Some(profile), &agent_id, "TOOLS.md")
                .await
                .ok()
                .and_then(|value| crate::commands::openclaw_agents::gateway_file_content(&value))
                .unwrap_or_default();
            let next = upsert_plugin_capability_notes(&existing, &block);
            if next != existing {
                let _ =
                    openclaw_gateway::agent_files_set(Some(profile), &agent_id, "TOOLS.md", &next)
                        .await;
            }
        }
    }

    pub(super) async fn openclaw_profile_plugin_set_impl(
        app: AppHandle,
        req: OpenClawProfilePluginSetRequest,
    ) -> Result<OpenClawProfilePluginsSnapshot, String> {
        let profile = normalize_profile(req.profile.as_deref());
        let definition = plugin_definition(&req.plugin_id)?;
        if cleanup_legacy_root_plugin_env(&profile)? {
            respawn_gateway_after_plugin_patch(&app).await?;
            if !crate::commands::model::wait_for_openclaw_profile_gateway_ready(&profile).await {
                return Err(
                    "已清理旧版插件配置，但 Uniopc 引擎尚未就绪；请点击“重启引擎”后重试。"
                        .to_string(),
                );
            }
        }
        if req.enabled
            && (definition_requires_cloud_agent_auth(&definition)
                || req.plugin_env.as_ref().is_some_and(|env| !env.is_empty()))
        {
            require_plugin_private_env_schema(&app, &definition)?;
        }
        let snapshot = openclaw_gateway::config_get(Some(&profile)).await?;
        let existing_env = plugin_private_env_for_definition(
            &plugin_entries_from_snapshot(&snapshot),
            &definition,
        );
        let auth_api_url = optional_non_empty(req.cloud_agent_api_url.as_ref());
        let auth_host_credential = optional_non_empty(req.cloud_agent_host_credential.as_ref());
        let mut patch = build_plugin_toggle_patch(&snapshot, &definition.id, req.enabled)?;
        if req.enabled && definition_requires_cloud_agent_auth(&definition) {
            inject_cloud_workspace_auth_env(
                &mut patch,
                &definition.id,
                existing_env.clone(),
                &definition,
                auth_api_url.clone(),
                auth_host_credential.clone(),
            )?;
        }
        if req.enabled {
            if let Some(extra_env) = req.plugin_env.as_ref().filter(|env| !env.is_empty()) {
                inject_plugin_env(&mut patch, &definition.id, existing_env.clone(), extra_env);
            }
        }
        let should_sync_gateway_service_env = should_sync_gateway_service_env_after_plugin_patch(
            &definition,
            req.enabled,
            &existing_env,
            auth_api_url.as_deref(),
            auth_host_credential.as_deref(),
        );
        // 插件开关重写的三个数组一律走整组替换。裸 config_patch 会被引擎的防误删
        // 守卫拦下并报 "config.patch would remove entries from array path(s):
        // plugins.allow, tools.alsoAllow" —— 停用与卸载(第一步即 enabled=false)
        // 因此都是坏的。同款先例:openclaw_channels(bindings)、openclaw_agents
        // (agents.list)。
        let patch_result = openclaw_gateway::config_patch_replacing(
            Some(&profile),
            patch,
            &PLUGIN_TOGGLE_REPLACE_PATHS,
        )
        .await;
        match recover_plugins_after_patch(&profile, &definition.id, req.enabled).await {
            Ok(Some(refreshed_snapshot)) => {
                if let Some(recovered_snapshot) = restart_gateway_after_plugin_patch_or_recover(
                    &app,
                    &profile,
                    should_sync_gateway_service_env,
                    &definition.id,
                    req.enabled,
                )
                .await?
                {
                    return Ok(recovered_snapshot);
                }
                return Ok(snapshot_from_config(
                    profile.clone(),
                    &refreshed_snapshot,
                    &plugin_paths_for_profile(&app, &profile)?,
                ));
            }
            Ok(None) if patch_result.is_ok() => {}
            Err(read_error) if patch_result.is_ok() => return Err(read_error),
            Ok(None) | Err(_) => {
                if let Err(patch_error) = patch_result {
                    if plugin_patch_error_may_be_restarting(&patch_error) {
                        if let Some(refreshed_snapshot) =
                            recover_plugins_after_patch_from_local_config(
                                &profile,
                                &definition.id,
                                req.enabled,
                            )?
                        {
                            if let Some(recovered_snapshot) =
                                restart_gateway_after_plugin_patch_or_recover(
                                    &app,
                                    &profile,
                                    should_sync_gateway_service_env,
                                    &definition.id,
                                    req.enabled,
                                )
                                .await?
                            {
                                return Ok(recovered_snapshot);
                            }
                            return Ok(snapshot_from_config(
                                profile.clone(),
                                &refreshed_snapshot,
                                &plugin_paths_for_profile(&app, &profile)?,
                            ));
                        }
                    }
                    return Err(patch_error);
                }
            }
        }
        if let Some(recovered_snapshot) = restart_gateway_after_plugin_patch_or_recover(
            &app,
            &profile,
            should_sync_gateway_service_env,
            &definition.id,
            req.enabled,
        )
        .await?
        {
            return Ok(recovered_snapshot);
        }
        openclaw_profile_plugins_list_impl(app, Some(profile)).await
    }

    pub(super) async fn openclaw_profile_plugin_reconcile_impl(
        app: AppHandle,
        req: OpenClawProfilePluginReconcileRequest,
    ) -> Result<OpenClawProfilePluginDoctorReport, String> {
        let profile = normalize_profile(req.profile.as_deref());
        let plugin_paths = plugin_paths_for_profile(&app, &profile)?;
        let snapshot = openclaw_gateway::config_get(Some(&profile)).await?;
        let report = build_plugin_doctor_report(
            profile.clone(),
            req.policy_version,
            &snapshot,
            &plugin_paths,
            &req.plugins,
        );

        for item in report.plugins.iter().filter(|item| item.repairable) {
            let enabled = item.desired == "enabled";
            let requires_auth = plugin_definition(&item.plugin_id)
                .map(|definition| definition_requires_cloud_agent_auth(&definition))
                .unwrap_or(false);
            let auth = if enabled && requires_auth {
                Some(
                    cloud_agent_auth_for_plugin(&req.cloud_agent_auth, &item.plugin_id)
                        .ok_or_else(|| format!("missing_cloud_agent_auth:{}", item.plugin_id))?,
                )
            } else {
                None
            };
            openclaw_profile_plugin_set_impl(
                app.clone(),
                OpenClawProfilePluginSetRequest {
                    profile: Some(profile.clone()),
                    plugin_id: item.plugin_id.clone(),
                    enabled,
                    cloud_agent_api_url: auth.map(|row| row.cloud_agent_api_url.clone()),
                    cloud_agent_host_credential: auth
                        .map(|row| row.cloud_agent_host_credential.clone()),
                    plugin_env: None,
                },
            )
            .await?;
        }

        let refreshed = openclaw_gateway::config_get(Some(&profile)).await?;
        let mut report = build_plugin_doctor_report(
            profile.clone(),
            req.policy_version,
            &refreshed,
            &plugin_paths_for_profile(&app, &profile)?,
            &req.plugins,
        );
        let capabilities = tool_capabilities_for_profile(&app, &report.profile).await?;
        append_runtime_capability_doctor_items(&mut report, &capabilities, &req.plugins);
        report.capabilities = Some(capabilities);
        Ok(report)
    }

    /// 授权快照文件名。uniopc-gatekeeper 插件在引擎进程内按
    /// `$OPENCLAW_STATE_DIR/<该文件>` 读取(桌面每次 spawn 引擎都注入
    /// OPENCLAW_STATE_DIR,所以无需给 gateway 加任何 env)。
    pub(in crate::commands::openclaw_plugins) const PLUGIN_GRANTS_SNAPSHOT_BASENAME: &str =
        "uniopc-plugin-grants.json";

    fn plugin_grants_snapshot_path(profile: Option<&str>) -> Result<PathBuf, String> {
        Ok(
            crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(profile)?
                .join(PLUGIN_GRANTS_SNAPSHOT_BASENAME),
        )
    }

    fn installed_uniopc_plugin_manifests_for_profile(profile: &str) -> Vec<(String, Value)> {
        let Ok(extensions_dir) = openclaw_extensions_dir_for_profile(Some(profile)) else {
            return Vec::new();
        };
        installed_uniopc_plugin_manifests_in(&extensions_dir)
    }

    fn installed_uniopc_plugin_manifests_in(extensions_dir: &Path) -> Vec<(String, Value)> {
        let Ok(entries) = std::fs::read_dir(&extensions_dir) else {
            return Vec::new();
        };
        let mut manifests = Vec::new();
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !name.starts_with("uniopc-") || !is_safe_plugin_id(&name) {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(crate::services::plugin_artifact::plugin_manifest_path(&entry.path())) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            manifests.push((name, manifest));
        }
        manifests.sort_by(|a, b| a.0.cmp(&b.0));
        manifests
    }

    pub(in crate::commands::openclaw_plugins) fn build_plugin_grants(
        statuses: &[PluginGrantStatusInput],
        installed: &[(String, Value)],
    ) -> Value {
        let status_by_id: HashMap<&str, &PluginGrantStatusInput> = statuses
            .iter()
            .map(|item| (item.plugin_id.trim(), item))
            .collect();
        let mut grants = Map::new();
        for (plugin_id, manifest) in installed {
            let tools: Vec<String> = manifest
                .get("contracts")
                .and_then(|contracts| contracts.get("tools"))
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let provided = status_by_id.get(plugin_id.as_str());
            // 云端没给状态的已装插件(本地/实验插件、gatekeeper 自身)不设门:
            // 授权归云端 entitlement 管,快照只物化云端已知的插件。
            let status = provided
                .map(|item| item.status.trim().to_string())
                .filter(|status| !status.is_empty())
                .unwrap_or_else(|| "active".to_string());
            let name = provided
                .and_then(|item| item.name.clone())
                .filter(|name| !name.trim().is_empty())
                .or_else(|| {
                    manifest
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| plugin_id.clone());
            let agents = provided
                .and_then(|item| item.agents.clone())
                .unwrap_or_else(|| json!("all"));
            grants.insert(
                plugin_id.clone(),
                json!({
                    "name": name,
                    "status": status,
                    "agents": agents,
                    "tools": tools,
                }),
            );
        }
        Value::Object(grants)
    }

    pub(in crate::commands::openclaw_plugins) fn write_plugin_grants_snapshot_file(
        path: &Path,
        grants: &Value,
    ) -> Result<(), String> {
        if !grants.is_object() {
            return Err("grants 必须是对象:{pluginId: {status, name, agents, tools}}".to_string());
        }
        let snapshot = json!({
            "version": 1,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
            "grants": grants,
        });
        let serialized = serde_json::to_string_pretty(&snapshot)
            .map_err(|error| format!("序列化授权快照失败: {error}"))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("创建授权快照目录失败: {error}"))?;
        }
        // 原子写:gatekeeper 以 mtime 判缓存,绝不能让它读到半个文件。
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serialized).map_err(|error| format!("写入授权快照失败: {error}"))?;
        std::fs::rename(&tmp, path).map_err(|error| format!("落盘授权快照失败: {error}"))?;
        Ok(())
    }

    /// 前端在 entitlement 加载完成 / 策略版本推送时调用,把云端授权状态与本地
    /// 已装 manifest 的工具清单合并,物化成 per-profile 快照。gatekeeper 逐调用
    /// stat 该文件,写入即生效,无需重启引擎。
    pub(super) async fn uniopc_plugin_grants_write_impl(
        profile: Option<String>,
        entitlements: Vec<PluginGrantStatusInput>,
    ) -> Result<String, String> {
        let profile_key = normalize_profile(profile.as_deref());
        let path = plugin_grants_snapshot_path(Some(&profile_key))?;
        let grants = build_plugin_grants(
            &entitlements,
            &installed_uniopc_plugin_manifests_for_profile(&profile_key),
        );
        write_plugin_grants_snapshot_file(&path, &grants)?;
        Ok(path.to_string_lossy().into_owned())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn capability_notes_tell_agents_not_to_guess_a_skill_file_at_plugin_root() {
            let notes = render_plugin_capability_notes(
                &OpenClawProfileToolCapabilitiesSnapshot {
                    profile: "test".to_string(),
                    gateway_supports_tool_constraints: true,
                    plugins: Vec::new(),
                },
                &[],
            );

            assert!(notes.contains("不要用 read/exec 猜测或读取"));
            assert!(notes.contains("skills/<skill>/SKILL.md"));
            assert!(notes.contains("指定 `.docx` 就直接使用 docx Skill"));
        }

        #[test]
        fn dynamic_plugin_scan_uses_the_given_profile_extensions_directory() {
            let extensions_dir = std::env::temp_dir().join(format!(
                "uniopc-dynamic-plugin-scan-{}",
                uuid::Uuid::new_v4()
            ));
            let plugin_dir = extensions_dir.join("uniopc-socials");
            std::fs::create_dir_all(&plugin_dir).expect("create plugin directory");
            std::fs::write(
                crate::services::plugin_artifact::plugin_manifest_path(&plugin_dir),
                r#"{"name":"公域流量","description":"test"}"#,
            )
            .expect("write manifest");

            let found = installed_dynamic_plugin_definitions_in(&extensions_dir, &HashSet::new());
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].id, "uniopc-socials");
            assert_eq!(found[0].title, "公域流量");

            std::fs::remove_dir_all(extensions_dir).expect("remove fixture");
        }
    }
}
#[tauri::command]
pub async fn openclaw_profile_plugins_list(
    app: AppHandle,
    profile: Option<String>,
) -> Result<OpenClawProfilePluginsSnapshot, String> {
    implementation::openclaw_profile_plugins_list_impl(app, profile).await
}

#[tauri::command]
pub async fn openclaw_supported_plugins_list(
    app: AppHandle,
) -> Result<OpenClawSupportedPluginsSnapshot, String> {
    implementation::openclaw_supported_plugins_list_impl(app).await
}

#[tauri::command]
pub fn uniopc_plugin_lifecycle_prepare(
    staging: State<'_, PluginLifecycleStaging>,
    req: UniopcPluginLifecyclePrepareRequest,
) -> Result<PluginArtifactReview, PluginLifecycleError> {
    implementation::uniopc_plugin_lifecycle_prepare_impl(staging, req)
}

#[tauri::command]
pub async fn uniopc_plugin_lifecycle_commit(
    app: AppHandle,
    staging: State<'_, PluginLifecycleStaging>,
    req: UniopcPluginLifecycleCommitRequest,
) -> Result<OpenClawProfilePluginsSnapshot, String> {
    implementation::uniopc_plugin_lifecycle_commit_impl(app, staging, req).await
}

#[tauri::command]
pub fn uniopc_plugin_lifecycle_cancel(
    staging: State<'_, PluginLifecycleStaging>,
    req: UniopcPluginLifecycleCancelRequest,
) -> Result<(), String> {
    implementation::uniopc_plugin_lifecycle_cancel_impl(staging, req)
}

#[tauri::command]
pub async fn uniopc_cloud_plugin_uninstall(
    app: AppHandle,
    req: UniopcCloudPluginUninstallRequest,
) -> Result<OpenClawProfilePluginsSnapshot, String> {
    implementation::uniopc_cloud_plugin_uninstall_impl(app, req).await
}

#[tauri::command]
pub async fn openclaw_profile_plugin_doctor_check(
    app: AppHandle,
    req: OpenClawProfilePluginDoctorRequest,
) -> Result<OpenClawProfilePluginDoctorReport, String> {
    implementation::openclaw_profile_plugin_doctor_check_impl(app, req).await
}

#[tauri::command]
pub async fn openclaw_profile_tool_capabilities_list(
    app: AppHandle,
    profile: Option<String>,
) -> Result<OpenClawProfileToolCapabilitiesSnapshot, String> {
    implementation::openclaw_profile_tool_capabilities_list_impl(app, profile).await
}

#[tauri::command]
pub async fn openclaw_profile_plugin_set(
    app: AppHandle,
    req: OpenClawProfilePluginSetRequest,
) -> Result<OpenClawProfilePluginsSnapshot, String> {
    implementation::openclaw_profile_plugin_set_impl(app, req).await
}

#[tauri::command]
pub async fn openclaw_profile_plugin_reconcile(
    app: AppHandle,
    req: OpenClawProfilePluginReconcileRequest,
) -> Result<OpenClawProfilePluginDoctorReport, String> {
    implementation::openclaw_profile_plugin_reconcile_impl(app, req).await
}

#[tauri::command]
pub async fn uniopc_plugin_grants_write(
    profile: Option<String>,
    entitlements: Vec<PluginGrantStatusInput>,
) -> Result<String, String> {
    implementation::uniopc_plugin_grants_write_impl(profile, entitlements).await
}
