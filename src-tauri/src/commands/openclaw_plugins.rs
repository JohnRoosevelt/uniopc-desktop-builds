mod compatibility;
pub mod plugins;

pub(crate) use self::plugins::implementation::tool_capabilities_for_profile;
#[cfg(test)]
use self::plugins::implementation::{
    agent_ids_from_config_snapshot, build_plugin_grants, cleanup_prepared_install,
    upsert_plugin_capability_notes, write_plugin_grants_snapshot_file, PLUGIN_CAPABILITY_NOTES_END,
    PLUGIN_CAPABILITY_NOTES_START, PLUGIN_GRANTS_SNAPSHOT_BASENAME,
};
use self::plugins::implementation::{normalize_profile, plugin_skill_names};
pub use self::plugins::{
    PluginGrantStatusInput, UniopcCloudPluginUninstallRequest, UniopcPluginLifecycleCancelRequest,
    UniopcPluginLifecycleCommitRequest, UniopcPluginLifecyclePrepareRequest,
};

#[cfg(test)]
use crate::commands::plugin_lifecycle::PluginLifecycleStaging;
use crate::services::{
    openclaw_gateway, openclaw_runtime,
    openclaw_system_plugins::{
        cli_install_plugin_dir_for_profile, cli_uninstall_plugin, installed_system_plugin_path,
        installed_system_plugin_path_for_profile, openclaw_extensions_dir,
        openclaw_extensions_dir_for_profile, prune_generated_plugin_dependencies,
        PluginInstallOptions, IMAI_CLOUD_WORKSPACE_PLUGIN_ID,
        UNIOPC_DOCUMENTS_PLUGIN_ID, UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID,
        UNIOPC_PRESENTATIONS_PLUGIN_ID, UNIOPC_PRIVATE_CONVERSION_PLUGIN_ID,
        UNIOPC_SOCIALS_PLUGIN_ID, UNIOPC_SUPER_IP_PLUGIN_ID, UNIOPC_WECHAT_MP_PLUGIN_ID,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
};
use tokio::time::{sleep, Duration};

/// 插件开关会整体重写的配置数组。
///
/// 引擎的 config.patch 拒绝**隐式**缩短数组(防误删守卫),被缩短的路径必须在
/// replacePaths 里点名。三条路径都由 build_plugin_toggle_patch 从快照完整重建
/// (不是增量),所以一律声明为整组替换 —— 语义等价,且省去"这次会不会缩短"
/// 的逐例判断:
///   * 停用缩短 plugins.allow / tools.alsoAllow(摘掉自己);
///   * 启用缩短 plugins.deny(把自己从黑名单摘掉)。
/// 早期只覆盖了停用的两条,启用路径在 deny 非空时会撞同一个守卫。
const PLUGIN_TOGGLE_REPLACE_PATHS: [&str; 3] = ["plugins.allow", "plugins.deny", "tools.alsoAllow"];

const PLUGIN_CONFIG_PATCH_RECOVERY_ATTEMPTS: usize = 10;
const PLUGIN_CONFIG_PATCH_RECOVERY_DELAY_MS: u64 = 500;
const CLOUD_AGENT_HEALTH_TIMEOUT_MS: u64 = 8000;
const ACPX_PLUGIN_ID: &str = "acpx";

#[derive(Debug, Clone)]
pub(crate) struct ProfilePluginDefinition {
    id: String,
    title: String,
    description: String,
    required_env: Vec<String>,
}

impl ProfilePluginDefinition {
    fn from_static(id: &str, title: &str, description: &str, required_env: &[&str]) -> Self {
        Self {
            id: id.to_string(),
            title: title.to_string(),
            description: description.to_string(),
            required_env: required_env.iter().map(|value| value.to_string()).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfilePluginRecord {
    pub id: String,
    pub title: String,
    pub description: String,
    pub enabled: bool,
    pub installed: bool,
    pub status: String,
    pub plugin_path: String,
    pub missing_env: Vec<String>,
    pub tool_bridge_enabled: bool,
    /// 本地已装 manifest(openclaw.plugin.json)的 version —— "当前版本"的
    /// 事实源。云端 assignment 的 observed_version 依赖观测回报,老装机常为空。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    /// Accio-style product layer read from the plugin's optional
    /// `plugin.json` + `resources/` + `skills/`; None for plugins that only
    /// ship the native `openclaw.plugin.json`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product: Option<PluginProductLayer>,
}

/// Product-layer packaging (Accio Work plugin standard) shipped alongside the
/// native manifest: localized display metadata, an inline icon, recommended
/// prompts, and the SKILL.md instruction packs bundled under `skills/`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProductLayer {
    pub display_name: String,
    pub description: String,
    pub icon_svg: String,
    pub category: String,
    pub tags: Vec<String>,
    pub recommend: Vec<PluginProductRecommendSection>,
    pub skills: Vec<PluginProductSkill>,
    /// Credential connectors declared by connectors/connectors.json (P1
    /// contract, see uniopc-supabase/docs/plugin-taxonomy.md §4). Empty for
    /// official cloud plugins (auto host credential) and pure skill packs.
    pub connectors: Vec<PluginProductConnector>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProductConnector {
    pub id: String,
    pub name: String,
    /// none | api-key | oauth2 (P2 reserved)
    pub auth_type: String,
    /// 阻塞制默认：install only completes after this connector is authorized.
    pub blocking: bool,
    /// blocking=true 时是否允许「暂时跳过」：跳过后插件先启用，凭据留待
    /// 详情页补全（对齐 Accio canSkipBlocking 语义）。缺省 false。
    pub can_skip_blocking: bool,
    /// `public` | `private`（缺省 `private`）。共享 OAuth app vs 每租户私有 app。
    /// 从 Accio 的 `oauth` 块吸收而来；当前仅透传，P2 oauth2 落地时行为化。
    pub visibility: String,
    /// 声明来源：`canonical`（Uniopc `connectors` 格式）| `accio-oauth`
    /// （legacy Accio `oauth` 块折叠而来）。便于审计移植件。
    pub provider: String,
    pub custom_description: String,
    pub get_link_url: String,
    pub fields: Vec<PluginProductConnectorField>,
    /// field key -> plugin env var name written on submit.
    pub env: HashMap<String, String>,
    /// Redacted credential state derived from the mapped profile env. This
    /// intentionally reveals neither values nor which stored fields are
    /// secrets; the renderer only needs to know whether input is required.
    pub credential_state: String,
    /// Required form field keys whose mapped environment variables are absent.
    /// Field keys are product metadata, not credential values.
    pub missing_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProductConnectorField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub placeholder: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProductRecommendSection {
    pub id: String,
    pub title: String,
    pub section_title: String,
    pub prompts: Vec<PluginProductRecommendPrompt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProductRecommendPrompt {
    pub id: String,
    pub text: String,
    pub skill_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProductSkill {
    pub id: String,
    pub display_name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfilePluginsSnapshot {
    pub profile: String,
    pub plugins: Vec<OpenClawProfilePluginRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawSupportedPluginsSnapshot {
    pub plugins: Vec<OpenClawSupportedPluginRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawSupportedPluginRecord {
    pub id: String,
    pub title: String,
    pub description: String,
    pub aliases: Vec<String>,
    pub required_env: Vec<String>,
    pub plugin_path: String,
    pub supports_start: bool,
    pub supports_stop: bool,
    pub supports_restart: bool,
    pub supports_repair: bool,
    pub supports_credential_issue: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfileToolCapabilitiesSnapshot {
    pub profile: String,
    pub gateway_supports_tool_constraints: bool,
    pub plugins: Vec<OpenClawProfileToolCapabilityPlugin>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfileToolCapabilityPlugin {
    pub id: String,
    pub title: String,
    pub description: String,
    pub official: bool,
    pub enabled: bool,
    pub installed: bool,
    pub status: String,
    pub business_health_state: String,
    pub business_health_label: String,
    pub readiness_reasons: Vec<String>,
    pub tools: Vec<OpenClawProfileToolCapability>,
    /// Manifest declares bundled skills (`openclaw.plugin.json` `skills`) —
    /// a skill-pack plugin is usable via "/" invocation even with zero tools.
    pub has_skills: bool,
    /// Names of the skills this plugin ships. The engine loads them as ordinary
    /// skills, so the same capability would otherwise surface twice in the UI
    /// (once as this plugin, once per skill); callers dedupe against this list.
    pub skill_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfileToolCapability {
    pub name: String,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfilePluginSetRequest {
    pub profile: Option<String>,
    pub plugin_id: String,
    pub enabled: bool,
    pub cloud_agent_api_url: Option<String>,
    pub cloud_agent_host_credential: Option<String>,
    /// Generic plugin env vars (connector credentials, e.g. third-party API
    /// keys declared by connectors.json). Merged into the plugin entry env
    /// alongside the cloud-agent auth pair.
    #[serde(default)]
    pub plugin_env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePluginPolicyInput {
    pub plugin_id: String,
    pub status: String,
    #[serde(default)]
    pub is_global: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfilePluginDoctorRequest {
    pub profile: Option<String>,
    #[serde(default)]
    pub policy_version: u64,
    #[serde(default)]
    pub plugins: Vec<ProfilePluginPolicyInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfilePluginDoctorItem {
    pub plugin_id: String,
    pub desired: String,
    pub actual: String,
    pub reasons: Vec<String>,
    pub repairable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfilePluginDoctorReport {
    pub profile: String,
    pub policy_version: u64,
    pub status: String,
    pub plugins: Vec<OpenClawProfilePluginDoctorItem>,
    pub snapshot: OpenClawProfilePluginsSnapshot,
    pub capabilities: Option<OpenClawProfileToolCapabilitiesSnapshot>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentPluginAuthInput {
    pub plugin_id: String,
    pub cloud_agent_api_url: String,
    pub cloud_agent_host_credential: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawProfilePluginReconcileRequest {
    pub profile: Option<String>,
    #[serde(default)]
    pub policy_version: u64,
    #[serde(default)]
    pub plugins: Vec<ProfilePluginPolicyInput>,
    #[serde(default)]
    pub cloud_agent_auth: Vec<CloudAgentPluginAuthInput>,
}

// 内置登记表只覆盖历史插件(保持既有中文标题/描述与行为逐字节不变)。
// 新的云端分发插件不需要进这张表:plugin_definition() 会退回到
// dynamic_plugin_definition(),按已安装制品的 openclaw.plugin.json 派生。
fn plugin_definitions() -> Vec<ProfilePluginDefinition> {
    vec![
        ProfilePluginDefinition::from_static(
            UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID,
            "本地工作区",
            "让 AI 员工在当前桌面 profile 内读取和编辑本地文档。",
            // URL, bearer token, and profile are injected only into the local
            // gateway child. They are not user credentials or persisted config.
            &[],
        ),
        ProfilePluginDefinition::from_static(
            UNIOPC_SOCIALS_PLUGIN_ID,
            "公域流量",
            "让 AI 员工调用公域流量、竞品分析、达人线索和社交媒体相关工具。",
            &["UNIOPC_SOCIALS_API_URL", "UNIOPC_SOCIALS_HOST_CREDENTIAL"],
        ),
        ProfilePluginDefinition::from_static(
            UNIOPC_PRIVATE_CONVERSION_PLUGIN_ID,
            "私域转化",
            "让 AI 员工调用私域转化的视频号、直播、评论和运营工作台工具。",
            &[
                "UNIOPC_PRIVATE_CONVERSION_API_URL",
                "UNIOPC_PRIVATE_CONVERSION_HOST_CREDENTIAL",
            ],
        ),
        ProfilePluginDefinition::from_static(
            UNIOPC_SUPER_IP_PLUGIN_ID,
            "超级IP",
            "让 AI 员工用克隆音色配音 + 数字人开场,加本地 Remotion 动效合成短视频。",
            &[
                "UNIOPC_SUPERIP_API_URL",
                "UNIOPC_SUPERIP_HOST_CREDENTIAL",
            ],
        ),
        // 用户自持凭据(2b):0.2.0 起公众号凭据由用户在 api-key 表单填写、写入
        // 引擎 env,请求本机直发微信,云函数已删除。这里的 required_env 必须与
        // 制品 manifest 的 requiredEnv 逐字节一致 —— 静态表优先于 manifest,
        // 一旦漂回 *_HOST_CREDENTIAL,definition_requires_cloud_agent_auth 会
        // 重新判真,桌面又会去铸 host credential 并把请求指向已不存在的
        // /functions/v1/wechat-mp。前端 CLOUD_AGENT_PLUGIN_IDS 已同步摘除。
        ProfilePluginDefinition::from_static(
            UNIOPC_WECHAT_MP_PLUGIN_ID,
            "公众号",
            "让 AI 员工把选题写成公众号文章、去除 AI 写作痕迹并推送到草稿箱(仅到草稿箱,由人工确认发布)。",
            &["WECHAT_MP_APP_ID", "WECHAT_MP_APP_SECRET"],
        ),
        // Skill packs: SKILL.md instruction packs loaded by the gateway via
        // the manifest `skills` field. No cloud runtime tools, no env.
        ProfilePluginDefinition::from_static(
            UNIOPC_DOCUMENTS_PLUGIN_ID,
            "文档处理",
            "官方技能包:让 AI 员工创建、编辑、分析 Word 文档(修订/批注/OOXML)与 PDF(提取/合并/表单)。",
            &[],
        ),
        ProfilePluginDefinition::from_static(
            UNIOPC_PRESENTATIONS_PLUGIN_ID,
            "演示文稿",
            "官方技能包:让 AI 员工创建、编辑、分析 PPTX 演示文稿(HTML 转 PPT/模板复用/缩略图)。",
            &[],
        ),
    ]
}

// 插件 id 会拼进 extensions 目录路径,必须限定形状(kebab-case,无路径分隔
// 符),防止 `../` 一类的输入逃出受管目录。与云端 PLUGIN_ID_PATTERN 同构。
fn is_safe_plugin_id(plugin_id: &str) -> bool {
    !plugin_id.is_empty()
        && plugin_id.len() <= 64
        && plugin_id
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && plugin_id.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.' || c == '_'
        })
}

// 启用/运行时由平台自动注入的 env,不参与"缺失配置"判定——否则动态派生
// 的 required_env 会让插件永远显示 missing_env。
const PLATFORM_INJECTED_ENV_KEYS: &[&str] = &[
    "UNIOPC_OPENCLAW_PROFILE",
    "UNIOPC_AGENT_ID",
    "OPENCLAW_AGENT_ID",
    "UNIOPC_LOCAL_DOCUMENTS_URL",
    "UNIOPC_LOCAL_DOCUMENTS_TOKEN",
];

fn definition_from_manifest(plugin_id: &str, manifest: &Value) -> ProfilePluginDefinition {
    let required_env = manifest
        .get("requiredEnv")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|key| !key.is_empty() && !PLATFORM_INJECTED_ENV_KEYS.contains(key))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    ProfilePluginDefinition {
        id: plugin_id.to_string(),
        title: manifest_string(manifest, "name").unwrap_or_else(|| plugin_id.to_string()),
        description: manifest_string(manifest, "description").unwrap_or_default(),
        required_env,
    }
}

fn installed_plugin_manifest(plugin_id: &str) -> Result<Option<Value>, String> {
    if !is_safe_plugin_id(plugin_id) {
        return Err(format!("插件 id `{plugin_id}` 不合法。"));
    }
    // 状态目录解析失败(如尚未初始化的环境)按"未安装"处理,让调用方给出
    // 统一的"不支持管理插件"错误,而不是把 state-dir 细节泄给用户。
    let Ok(plugin_dir) = installed_system_plugin_path(plugin_id) else {
        return Ok(None);
    };
    let manifest_path = crate::services::plugin_artifact::plugin_manifest_path(&plugin_dir);
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
        return Ok(None);
    };
    let manifest: Value = serde_json::from_str(&raw)
        .map_err(|err| format!("解析插件 `{plugin_id}` 的 manifest 失败:{err}"))?;
    Ok(Some(manifest))
}

// 云端分发的官方插件不再逐个登记:凡是官方 CLI 装到 extensions 下、带
// openclaw.plugin.json 的插件,管理动作(启停/授权/体检)直接按 manifest
// 驱动。requiredEnv 里的 *_API_URL / *_HOST_CREDENTIAL 键名同时决定
// 凭据注入的落点(见 cloud_agent_*_env_key_for)。
fn dynamic_plugin_definition(plugin_id: &str) -> Result<Option<ProfilePluginDefinition>, String> {
    Ok(installed_plugin_manifest(plugin_id)?
        .map(|manifest| definition_from_manifest(plugin_id, &manifest)))
}

fn plugin_definition(plugin_id: &str) -> Result<ProfilePluginDefinition, String> {
    let plugin_id = plugin_id.trim();
    if let Some(definition) = plugin_definitions()
        .into_iter()
        .find(|definition| definition.id == plugin_id)
    {
        return Ok(definition);
    }
    dynamic_plugin_definition(plugin_id)?.ok_or_else(|| format!("不支持管理插件 `{}`。", plugin_id))
}

fn plugin_aliases(plugin_id: &str) -> Vec<String> {
    match plugin_id.trim() {
        UNIOPC_PRIVATE_CONVERSION_PLUGIN_ID => vec!["uniopc-private-conversion".to_string()],
        // Legacy id before the uniopc-superip unification; keeps existing
        // gateway config entries and installs recognizable.
        UNIOPC_SUPER_IP_PLUGIN_ID => vec!["uniopc-super-ip".to_string()],
        _ => Vec::new(),
    }
}

fn snapshot_root(snapshot: &Value) -> &Value {
    snapshot
        .get("parsed")
        .or_else(|| snapshot.get("sourceConfig"))
        .or_else(|| snapshot.get("config"))
        .or_else(|| snapshot.get("runtimeConfig"))
        .or_else(|| snapshot.get("resolved"))
        .unwrap_or(snapshot)
}

fn plugin_entries_from_snapshot(snapshot: &Value) -> Map<String, Value> {
    snapshot_root(snapshot)
        .get("plugins")
        .and_then(|plugins| plugins.get("entries"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn plugin_load_paths_from_snapshot(snapshot: &Value) -> Vec<String> {
    snapshot_root(snapshot)
        .get("plugins")
        .and_then(|plugins| plugins.get("load"))
        .and_then(|load| load.get("paths"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn plugin_allow_from_snapshot(snapshot: &Value) -> Option<Vec<String>> {
    snapshot_root(snapshot)
        .get("plugins")
        .and_then(|plugins| plugins.get("allow"))
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
}

fn plugin_deny_from_snapshot(snapshot: &Value) -> Vec<String> {
    snapshot_root(snapshot)
        .get("plugins")
        .and_then(|plugins| plugins.get("deny"))
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
        .unwrap_or_default()
}

fn env_from_snapshot(snapshot: &Value) -> Map<String, Value> {
    snapshot_root(snapshot)
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// OpenClaw 8.1 validates plugin configuration independently. Credentials are
/// consequently stored under the owning plugin's config, never in root `env`
/// (which rejects arbitrary keys). The Gateway supervisor is the sole bridge
/// that turns these persisted values into process environment variables.
fn plugin_private_env_from_entries(
    entries: &Map<String, Value>,
    plugin_id: &str,
) -> Map<String, Value> {
    entries
        .get(plugin_id)
        .and_then(|entry| entry.get("config"))
        .and_then(|config| config.get("env"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn plugin_private_env_for_definition(
    entries: &Map<String, Value>,
    definition: &ProfilePluginDefinition,
) -> Map<String, Value> {
    let env = plugin_private_env_from_entries(entries, &definition.id);
    if !env.is_empty() {
        return env;
    }
    plugin_aliases(&definition.id)
        .into_iter()
        .map(|alias| plugin_private_env_from_entries(entries, &alias))
        .find(|env| !env.is_empty())
        .unwrap_or_default()
}

fn tools_config_from_snapshot(snapshot: &Value) -> Map<String, Value> {
    snapshot_root(snapshot)
        .get("tools")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn tools_profile_from_snapshot(snapshot: &Value) -> Option<String> {
    tools_config_from_snapshot(snapshot)
        .get("profile")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn tools_also_allow_from_snapshot(snapshot: &Value) -> Vec<String> {
    tools_config_from_snapshot(snapshot)
        .get("alsoAllow")
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
        .unwrap_or_default()
}

fn entry_enabled(entries: &Map<String, Value>, plugin_id: &str) -> bool {
    entries
        .get(plugin_id)
        .and_then(|entry| entry.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn acpx_tool_bridge_enabled(entries: &Map<String, Value>) -> bool {
    entries
        .get(ACPX_PLUGIN_ID)
        .and_then(|entry| entry.get("config"))
        .and_then(|config| config.get("pluginToolsMcpBridge"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Return a config patch that removes the ACPX bridge written by earlier
/// builds when that entry has no user-owned configuration. Keeping a missing
/// optional ACPX plugin enabled makes recent OpenClaw runtimes refuse Gateway
/// readiness, so this migration runs before normal Gateway startup.
pub(crate) fn legacy_acpx_bridge_cleanup_patch(snapshot: &Value) -> Option<Value> {
    let mut entries = plugin_entries_from_snapshot(snapshot);
    let acpx_entry = entries.get(ACPX_PLUGIN_ID)?.as_object()?.clone();
    let enabled = acpx_entry.get("enabled").and_then(Value::as_bool);
    let config = acpx_entry.get("config")?.as_object()?;
    if enabled != Some(true)
        || config.len() != 1
        || config.get("pluginToolsMcpBridge") != Some(&Value::Bool(true))
        || acpx_entry.len() != 2
    {
        return None;
    }

    entries.remove(ACPX_PLUGIN_ID);
    let mut plugins = Map::new();
    plugins.insert("entries".to_string(), Value::Object(entries));
    if let Some(allow) = plugin_allow_from_snapshot(snapshot) {
        plugins.insert(
            "allow".to_string(),
            json!(unique_also_allow_entries(&allow, ACPX_PLUGIN_ID, false)),
        );
    }

    let mut patch = Map::new();
    patch.insert("plugins".to_string(), Value::Object(plugins));
    let also_allow = tools_also_allow_from_snapshot(snapshot);
    if also_allow.iter().any(|entry| entry == ACPX_PLUGIN_ID) {
        patch.insert(
            "tools".to_string(),
            json!({ "alsoAllow": unique_also_allow_entries(&also_allow, ACPX_PLUGIN_ID, false) }),
        );
    }
    Some(Value::Object(patch))
}

pub(crate) fn cleanup_legacy_acpx_bridge_for_profile(profile: &str) -> Result<bool, String> {
    let snapshot = openclaw_gateway::load_openclaw_config_for_profile(Some(profile))?;
    let Some(patch) = legacy_acpx_bridge_cleanup_patch(&snapshot) else {
        return Ok(false);
    };
    crate::commands::openclaw_connection::save_openclaw_gateway_config_patch(profile, patch)?;
    Ok(true)
}

fn missing_required_env(env: &Map<String, Value>, required_env: &[String]) -> Vec<String> {
    required_env
        .iter()
        .filter(|key| {
            let key = key.as_str();
            let value = env
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if value.is_some() {
                return false;
            }
            if key.ends_with("_HOST_CREDENTIAL") && key != "UNIOPC_HOST_CREDENTIAL" {
                return env
                    .get("UNIOPC_HOST_CREDENTIAL")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_none();
            }
            true
        })
        .map(|key| key.to_string())
        .collect()
}

fn unique_also_allow_entries(existing: &[String], plugin_id: &str, enabled: bool) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    for entry in existing.iter().map(String::as_str) {
        let entry = entry.trim();
        if entry.is_empty() || (!enabled && entry == plugin_id) {
            continue;
        }
        if seen.insert(entry.to_string()) {
            entries.push(entry.to_string());
        }
    }
    if enabled {
        let plugin_id = plugin_id.trim();
        if !plugin_id.is_empty() && seen.insert(plugin_id.to_string()) {
            entries.push(plugin_id.to_string());
        }
    }
    entries
}

fn reconcile_allow(
    existing: Option<Vec<String>>,
    plugin_id: &str,
    enabled: bool,
) -> Option<Vec<String>> {
    match existing {
        Some(items) => Some(unique_also_allow_entries(&items, plugin_id, enabled)),
        None if enabled => Some(unique_also_allow_entries(&[], plugin_id, enabled)),
        None => None,
    }
}

fn reconcile_deny(existing: &[String], plugin_id: &str, enabled: bool) -> Vec<String> {
    if !enabled {
        return existing.to_vec();
    }
    existing
        .iter()
        .filter(|item| item.trim() != plugin_id)
        .cloned()
        .collect()
}

fn plugin_tools_allowed_by_runtime_policy(
    snapshot: &Value,
    plugin_id: &str,
    tool_names: &[String],
) -> bool {
    let profile = tools_profile_from_snapshot(snapshot)
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if profile.is_empty() || profile == "full" {
        return true;
    }

    let also_allow = tools_also_allow_from_snapshot(snapshot)
        .into_iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<std::collections::HashSet<_>>();
    if also_allow.contains("*") || also_allow.contains("group:plugins") {
        return true;
    }
    let plugin_key = plugin_id.trim().to_ascii_lowercase();
    if also_allow.contains(&plugin_key) {
        return true;
    }
    tool_names
        .iter()
        .map(|name| name.trim().to_ascii_lowercase())
        .any(|name| also_allow.contains(&name))
}

fn tool_title_from_name(name: &str) -> String {
    name.trim()
        .replace("imai_", "")
        .replace('_', " ")
        .split_whitespace()
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn manifest_declares_skills(plugin_path: &std::path::Path) -> bool {
    let manifest_path = crate::services::plugin_artifact::plugin_manifest_path(&plugin_path);
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    manifest
        .get("skills")
        .and_then(Value::as_array)
        .map(|skills| !skills.is_empty())
        .unwrap_or(false)
}

fn manifest_tools(plugin_path: &std::path::Path) -> Vec<OpenClawProfileToolCapability> {
    let manifest_path = crate::services::plugin_artifact::plugin_manifest_path(&plugin_path);
    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let manifest: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let metadata = manifest
        .get("toolMetadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    manifest
        .get("contracts")
        .and_then(|contracts| contracts.get("tools"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| {
            let item = metadata.get(name).and_then(Value::as_object);
            let description = item
                .and_then(|object| object.get("description"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let input_schema = item
                .and_then(|object| object.get("inputSchema"))
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "type": "object",
                        "additionalProperties": true
                    })
                });
            OpenClawProfileToolCapability {
                name: name.to_string(),
                title: tool_title_from_name(name),
                description,
                input_schema,
            }
        })
        .collect()
}

/// Preferred locale for product-layer display strings. The desktop UI is
/// Chinese-first; plugin.json carries the English defaults.
const PRODUCT_LAYER_PREFERRED_LOCALE: &str = "zh";

fn product_json_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// A connector's `visibility`, defaulting to `private` when absent — shared
/// across the canonical (`connectors`) and legacy Accio (`oauth`) parse paths.
fn connector_visibility(connector: &Value) -> String {
    let visibility = product_json_string(connector, "visibility");
    if visibility.is_empty() {
        "private".to_string()
    } else {
        visibility
    }
}

/// Title-case an Accio `oauth` connector id (e.g. `shopify` -> `Shopify`) for
/// display, since the legacy format carries no explicit `name`.
fn accio_connector_display_name(id: &str) -> String {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Parse the `--- key: value ---` frontmatter block of a SKILL.md.
///
/// Tolerates a glued terminator (`version: "1.11.0"---` with no newline before
/// the closing `---`) — upstream skill packs (e.g. Shopify's) ship this form.
/// Without the tolerance the parser runs past the frontmatter and scans the
/// whole markdown body for `key: value` lines.
fn skill_frontmatter(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return map;
    }
    for line in lines {
        let mut line = line.trim();
        if line == "---" {
            break;
        }
        let glued_terminator = line.ends_with("---");
        if glued_terminator {
            line = line[..line.len() - 3].trim_end();
        }
        if let Some((key, value)) = line.split_once(':') {
            let value = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            map.insert(key.trim().to_string(), value);
        }
        if glued_terminator {
            break;
        }
    }
    map
}

fn connector_credential_state(
    connector: &PluginProductConnector,
    env: &Map<String, Value>,
) -> (String, Vec<String>) {
    if connector.auth_type != "api-key" {
        return ("not_applicable".to_string(), Vec::new());
    }

    let required_fields = connector
        .fields
        .iter()
        .filter(|field| field.required)
        .collect::<Vec<_>>();
    let missing_fields = required_fields
        .iter()
        .filter(|field| {
            connector
                .env
                .get(&field.key)
                .and_then(|env_key| env.get(env_key))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
        })
        .map(|field| field.key.clone())
        .collect::<Vec<_>>();
    let state = if missing_fields.is_empty() {
        "configured"
    } else if missing_fields.len() == required_fields.len() {
        "unconfigured"
    } else {
        "partially_configured"
    };
    (state.to_string(), missing_fields)
}

fn plugin_product_layer_with_env(
    plugin_path: &Path,
    profile_env: &Map<String, Value>,
) -> Option<PluginProductLayer> {
    let manifest_raw = std::fs::read_to_string(plugin_path.join("plugin.json")).ok()?;
    let manifest: Value = serde_json::from_str(&manifest_raw).ok()?;

    let mut display_name = product_json_string(&manifest, "displayName");
    if display_name.is_empty() {
        display_name = product_json_string(&manifest, "name");
    }
    let mut description = product_json_string(&manifest, "description");

    if let Ok(raw) = std::fs::read_to_string(plugin_path.join("resources").join("i18n.json")) {
        if let Ok(i18n) = serde_json::from_str::<Value>(&raw) {
            let localized = |key: &str| -> Option<String> {
                i18n.get("entries")?
                    .get(key)?
                    .get(PRODUCT_LAYER_PREFERRED_LOCALE)?
                    .as_str()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            };
            if let Some(value) = localized("plugin.displayName") {
                display_name = value;
            }
            if let Some(value) = localized("plugin.description") {
                description = value;
            }
        }
    }

    let icon_rel = product_json_string(&manifest, "icon");
    let icon_svg = if icon_rel.is_empty() {
        String::new()
    } else {
        std::fs::read_to_string(plugin_path.join(&icon_rel)).unwrap_or_default()
    };

    let tags = manifest
        .get("tags")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let recommend = std::fs::read_to_string(plugin_path.join("resources").join("recommend.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_array().cloned())
        .map(|sections| {
            sections
                .iter()
                .map(|section| PluginProductRecommendSection {
                    id: product_json_string(section, "id"),
                    title: product_json_string(section, "title"),
                    section_title: product_json_string(section, "sectionTitle"),
                    prompts: section
                        .get("prompts")
                        .and_then(Value::as_array)
                        .map(|prompts| {
                            prompts
                                .iter()
                                .map(|prompt| PluginProductRecommendPrompt {
                                    id: product_json_string(prompt, "id"),
                                    text: product_json_string(prompt, "text"),
                                    skill_id: product_json_string(prompt, "skillId"),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();

    let mut skills = Vec::new();
    if let Ok(entries) = std::fs::read_dir(plugin_path.join("skills")) {
        for entry in entries.flatten() {
            let Ok(raw) = std::fs::read_to_string(entry.path().join("SKILL.md")) else {
                continue;
            };
            let front = skill_frontmatter(&raw);
            let id = front
                .get("name")
                .cloned()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| entry.file_name().to_string_lossy().to_string());
            skills.push(PluginProductSkill {
                id,
                display_name: front.get("displayName").cloned().unwrap_or_default(),
                description: front.get("description").cloned().unwrap_or_default(),
            });
        }
    }
    skills.sort_by(|left, right| left.id.cmp(&right.id));

    let mut connectors = Vec::new();
    if let Ok(raw) = std::fs::read_to_string(plugin_path.join("connectors").join("connectors.json"))
    {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            if let Some(entries) = value.get("connectors").and_then(Value::as_object) {
                for (id, connector) in entries {
                    let fields = connector
                        .get("fields")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .map(|field| PluginProductConnectorField {
                                    key: product_json_string(field, "key"),
                                    label: product_json_string(field, "label"),
                                    field_type: {
                                        let field_type = product_json_string(field, "type");
                                        if field_type.is_empty() {
                                            "text".to_string()
                                        } else {
                                            field_type
                                        }
                                    },
                                    placeholder: product_json_string(field, "placeholder"),
                                    required: field
                                        .get("required")
                                        .and_then(Value::as_bool)
                                        .unwrap_or(true),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let env = connector
                        .get("env")
                        .and_then(Value::as_object)
                        .map(|map| {
                            map.iter()
                                .filter_map(|(key, value)| {
                                    value
                                        .as_str()
                                        .map(|env_key| (key.clone(), env_key.to_string()))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    connectors.push(PluginProductConnector {
                        id: id.clone(),
                        name: product_json_string(connector, "name"),
                        auth_type: {
                            let auth_type = product_json_string(connector, "authType");
                            if auth_type.is_empty() {
                                "none".to_string()
                            } else {
                                auth_type
                            }
                        },
                        // 阻塞制：未显式声明时默认 blocking。
                        blocking: connector
                            .get("blocking")
                            .and_then(Value::as_bool)
                            .unwrap_or(true),
                        can_skip_blocking: connector
                            .get("canSkipBlocking")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        visibility: connector_visibility(connector),
                        provider: "canonical".to_string(),
                        custom_description: product_json_string(connector, "customDescription"),
                        get_link_url: product_json_string(connector, "getLinkUrl"),
                        fields,
                        env,
                        credential_state: String::new(),
                        missing_fields: Vec::new(),
                    });
                }
            } else if let Some(entries) = value.get("oauth").and_then(Value::as_object) {
                // Legacy Accio 格式（顶层 `oauth` 块 + 被忽略的 `mcpServers`）。
                // 每条折叠成 oauth2 连接器，让移植插件的授权在 App 内可见，
                // 而无需重打包制品。注意 blocking 尊重条目显式值、缺省 false：
                // Accio 语义是「用时才连」，不套 Uniopc 规范路径的阻塞制默认 true。
                for (id, connector) in entries {
                    connectors.push(PluginProductConnector {
                        id: id.clone(),
                        name: accio_connector_display_name(id),
                        auth_type: "oauth2".to_string(),
                        blocking: connector
                            .get("blocking")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        can_skip_blocking: connector
                            .get("canSkipBlocking")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        visibility: connector_visibility(connector),
                        provider: "accio-oauth".to_string(),
                        custom_description: String::new(),
                        get_link_url: String::new(),
                        fields: Vec::new(),
                        env: HashMap::new(),
                        credential_state: "not_applicable".to_string(),
                        missing_fields: Vec::new(),
                    });
                }
            }
        }
    }
    connectors.sort_by(|left, right| left.id.cmp(&right.id));
    for connector in &mut connectors {
        let (credential_state, missing_fields) = connector_credential_state(connector, profile_env);
        connector.credential_state = credential_state;
        connector.missing_fields = missing_fields;
    }

    Some(PluginProductLayer {
        display_name,
        description,
        icon_svg,
        category: product_json_string(&manifest, "category"),
        tags,
        recommend,
        skills,
        connectors,
    })
}

fn plugin_record_from_config(
    definition: &ProfilePluginDefinition,
    plugin_path: PathBuf,
    entries: &Map<String, Value>,
) -> OpenClawProfilePluginRecord {
    let plugin_path_string = plugin_path.to_string_lossy().to_string();
    let manifest_path = crate::services::plugin_artifact::plugin_manifest_path(&plugin_path);
    let installed = manifest_path.exists();
    let installed_version = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|manifest| manifest_string(&manifest, "version"));
    let entry_is_enabled = entry_enabled(entries, &definition.id);
    let enabled = installed && entry_is_enabled;
    let tool_bridge_enabled = acpx_tool_bridge_enabled(entries);
    let env = plugin_private_env_for_definition(entries, definition);
    let missing_env = missing_required_env(&env, &definition.required_env);
    let status = if !installed {
        "not_installed"
    } else if !enabled {
        "disabled"
    } else if !missing_env.is_empty() {
        "missing_env"
    } else {
        "ready"
    }
    .to_string();

    OpenClawProfilePluginRecord {
        id: definition.id.to_string(),
        title: definition.title.to_string(),
        description: definition.description.to_string(),
        enabled,
        installed,
        status,
        product: plugin_product_layer_with_env(&plugin_path, &env),
        plugin_path: plugin_path_string,
        missing_env,
        tool_bridge_enabled,
        installed_version,
    }
}

fn manifest_string(manifest: &Value, key: &str) -> Option<String> {
    manifest
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn custom_plugin_record_from_load_path(
    plugin_path: &str,
    known_plugin_ids: &HashSet<String>,
    known_plugin_paths: &HashSet<String>,
    entries: &Map<String, Value>,
) -> Option<OpenClawProfilePluginRecord> {
    let path = PathBuf::from(plugin_path);
    let plugin_path_string = path.to_string_lossy().to_string();
    if known_plugin_paths.contains(&plugin_path_string) {
        return None;
    }

    let manifest_path = crate::services::plugin_artifact::plugin_manifest_path(&path);
    let raw = std::fs::read_to_string(&manifest_path).ok()?;
    let manifest: Value = serde_json::from_str(&raw).ok()?;
    let id = manifest_string(&manifest, "id").or_else(|| {
        path.file_name()
            .and_then(|value| value.to_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })?;
    if id == ACPX_PLUGIN_ID || known_plugin_ids.contains(&id) {
        return None;
    }

    let title = manifest_string(&manifest, "name").unwrap_or_else(|| id.clone());
    let description = manifest_string(&manifest, "description").unwrap_or_default();
    let installed = manifest_path.exists();
    let enabled = installed && entry_enabled(entries, &id);
    let tool_bridge_enabled = acpx_tool_bridge_enabled(entries);
    let private_env = plugin_private_env_from_entries(entries, &id);
    let status = if !installed {
        "not_installed"
    } else if !enabled {
        "disabled"
    } else {
        "ready"
    }
    .to_string();

    Some(OpenClawProfilePluginRecord {
        id,
        title,
        description,
        enabled,
        installed,
        status,
        product: plugin_product_layer_with_env(&path, &private_env),
        plugin_path: plugin_path_string,
        missing_env: Vec::new(),
        tool_bridge_enabled,
        installed_version: manifest_string(&manifest, "version"),
    })
}

fn snapshot_from_config(
    profile: String,
    snapshot: &Value,
    plugin_paths: &[(ProfilePluginDefinition, PathBuf)],
) -> OpenClawProfilePluginsSnapshot {
    let entries = plugin_entries_from_snapshot(snapshot);
    let load_paths = plugin_load_paths_from_snapshot(snapshot);
    let known_plugin_ids = plugin_paths
        .iter()
        .map(|(definition, _)| definition.id.to_string())
        .collect::<HashSet<_>>();
    let known_plugin_paths = plugin_paths
        .iter()
        .map(|(_, path)| path.to_string_lossy().to_string())
        .collect::<HashSet<_>>();
    let mut plugins = plugin_paths
        .iter()
        .map(|(definition, path)| plugin_record_from_config(definition, path.clone(), &entries))
        .collect::<Vec<_>>();
    plugins.extend(load_paths.iter().filter_map(|path| {
        custom_plugin_record_from_load_path(path, &known_plugin_ids, &known_plugin_paths, &entries)
    }));
    OpenClawProfilePluginsSnapshot { profile, plugins }
}

fn plugin_snapshot_reaches_desired_state(
    snapshot: &OpenClawProfilePluginsSnapshot,
    plugin_id: &str,
    enabled: bool,
) -> bool {
    snapshot.plugins.iter().any(|plugin| {
        plugin.id == plugin_id
            && plugin.enabled == enabled
            && (!enabled || plugin.status == "ready")
    })
}

// 是否需要平台托管的 Cloud Agent 凭据:看 manifest 声明(requiredEnv 含
// *_HOST_CREDENTIAL 键),不再按插件 id 逐个登记。内置 7 个插件的
// required_env 与其 manifest 一致,行为不变。
fn definition_requires_cloud_agent_auth(definition: &ProfilePluginDefinition) -> bool {
    definition
        .required_env
        .iter()
        .any(|key| key.ends_with("_HOST_CREDENTIAL"))
}

fn cloud_agent_api_url_env_key(plugin_id: &str) -> &'static str {
    match plugin_id {
        UNIOPC_SOCIALS_PLUGIN_ID => "UNIOPC_SOCIALS_API_URL",
        UNIOPC_PRIVATE_CONVERSION_PLUGIN_ID => "UNIOPC_PRIVATE_CONVERSION_API_URL",
        UNIOPC_SUPER_IP_PLUGIN_ID => "UNIOPC_SUPERIP_API_URL",
        // uniopc-wechat-mp 不在此表:0.2.0 起它是用户自持凭据的本机直连插件,
        // 没有云函数,也就没有 API URL 可映射。
        _ => "UNIOPC_CLOUD_WORKSPACE_API_URL",
    }
}

// 凭据 env 的键名从 manifest requiredEnv 派生(*_API_URL / *_HOST_CREDENTIAL
// 各取第一个);内置插件派生结果与旧的按-id 映射逐字节相同,静态映射只作
// 兜底(比如 manifest 缺声明的历史安装)。
fn cloud_agent_api_url_env_key_for(definition: &ProfilePluginDefinition) -> String {
    definition
        .required_env
        .iter()
        .find(|key| key.ends_with("_API_URL"))
        .cloned()
        .unwrap_or_else(|| cloud_agent_api_url_env_key(&definition.id).to_string())
}

fn cloud_agent_host_credential_env_key_for(definition: &ProfilePluginDefinition) -> String {
    definition
        .required_env
        .iter()
        .find(|key| key.ends_with("_HOST_CREDENTIAL"))
        .cloned()
        .unwrap_or_else(|| cloud_agent_host_credential_env_key(&definition.id).to_string())
}

fn cloud_agent_host_credential_for_definition(
    env: &Map<String, Value>,
    definition: &ProfilePluginDefinition,
) -> String {
    let scoped = env_string(env, &cloud_agent_host_credential_env_key_for(definition));
    if scoped.is_empty() {
        env_string(env, "UNIOPC_HOST_CREDENTIAL")
    } else {
        scoped
    }
}

fn should_sync_gateway_service_env_after_plugin_patch(
    definition: &ProfilePluginDefinition,
    enabled: bool,
    existing_env: &Map<String, Value>,
    api_url: Option<&str>,
    host_credential: Option<&str>,
) -> bool {
    if !enabled || !definition_requires_cloud_agent_auth(definition) {
        return false;
    }
    let Some(api_url) = api_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let Some(host_credential) = host_credential
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };
    env_string(existing_env, &cloud_agent_api_url_env_key_for(definition)) != api_url
        || cloud_agent_host_credential_for_definition(existing_env, definition) != host_credential
}

fn plugin_policy_desired_state(
    policy: &[ProfilePluginPolicyInput],
) -> std::collections::HashMap<String, bool> {
    let mut desired = std::collections::HashMap::new();
    for plugin in policy {
        let plugin_id = plugin.plugin_id.trim();
        if plugin_id.is_empty() {
            continue;
        }
        desired.insert(
            plugin_id.to_string(),
            plugin.status.trim().eq_ignore_ascii_case("active"),
        );
    }
    desired.remove(IMAI_CLOUD_WORKSPACE_PLUGIN_ID);
    desired.insert(UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID.to_string(), true);
    desired
}

fn build_plugin_doctor_item(
    record: &OpenClawProfilePluginRecord,
    desired_enabled: bool,
) -> Option<OpenClawProfilePluginDoctorItem> {
    let desired = if desired_enabled {
        "enabled"
    } else {
        "disabled"
    };
    let mut reasons = Vec::new();
    let actual = if desired_enabled {
        if !record.installed {
            reasons.push("not_installed".to_string());
            "not_installed".to_string()
        } else if !record.enabled {
            reasons.push("missing_from_profile".to_string());
            "missing_from_profile".to_string()
        } else if record.status == "ready" {
            "enabled".to_string()
        } else {
            if !record.tool_bridge_enabled {
                reasons.push("bridge_disabled".to_string());
            }
            for key in &record.missing_env {
                reasons.push(format!("missing_env:{key}"));
            }
            record.status.clone()
        }
    } else if record.enabled {
        reasons.push("not_authorized".to_string());
        "enabled".to_string()
    } else {
        "disabled".to_string()
    };

    let mismatch = if desired_enabled {
        actual != "enabled"
    } else {
        record.enabled
    };
    if !mismatch {
        return None;
    }

    let repairable = if desired_enabled {
        record.installed
    } else {
        record.enabled
    };
    Some(OpenClawProfilePluginDoctorItem {
        plugin_id: record.id.clone(),
        desired: desired.to_string(),
        actual,
        reasons,
        repairable,
    })
}

fn build_plugin_doctor_report(
    profile: String,
    policy_version: u64,
    snapshot: &Value,
    plugin_paths: &[(ProfilePluginDefinition, PathBuf)],
    policy: &[ProfilePluginPolicyInput],
) -> OpenClawProfilePluginDoctorReport {
    let snapshot = snapshot_from_config(profile.clone(), snapshot, plugin_paths);
    let desired = plugin_policy_desired_state(policy);
    let plugins = snapshot
        .plugins
        .iter()
        .filter_map(|record| {
            let desired_enabled = desired.get(&record.id).copied().unwrap_or(false);
            build_plugin_doctor_item(record, desired_enabled)
        })
        .collect::<Vec<_>>();
    let status = if plugins.iter().any(|plugin| plugin.repairable) {
        "needs_repair"
    } else if plugins.is_empty() {
        "ok"
    } else {
        "blocked"
    }
    .to_string();

    OpenClawProfilePluginDoctorReport {
        profile,
        policy_version,
        status,
        plugins,
        snapshot,
        capabilities: None,
    }
}

fn refresh_plugin_doctor_status(report: &mut OpenClawProfilePluginDoctorReport) {
    report.status = if report.plugins.iter().any(|plugin| plugin.repairable) {
        "needs_repair"
    } else if report.plugins.is_empty() {
        "ok"
    } else {
        "blocked"
    }
    .to_string();
}

fn append_runtime_capability_doctor_items(
    report: &mut OpenClawProfilePluginDoctorReport,
    capabilities: &OpenClawProfileToolCapabilitiesSnapshot,
    policy: &[ProfilePluginPolicyInput],
) {
    let desired = plugin_policy_desired_state(policy);
    let existing = report
        .plugins
        .iter()
        .map(|item| item.plugin_id.clone())
        .collect::<HashSet<_>>();
    let mut runtime_items = capabilities
        .plugins
        .iter()
        .filter(|plugin| desired.get(&plugin.id).copied().unwrap_or(false))
        .filter(|plugin| plugin.installed && plugin.enabled && plugin.status != "ready")
        .filter(|plugin| !existing.contains(&plugin.id))
        .map(|plugin| OpenClawProfilePluginDoctorItem {
            plugin_id: plugin.id.clone(),
            desired: "enabled".to_string(),
            actual: plugin.status.clone(),
            reasons: plugin.readiness_reasons.clone(),
            repairable: false,
        })
        .collect::<Vec<_>>();
    report.plugins.append(&mut runtime_items);
    refresh_plugin_doctor_status(report);
}

fn build_plugin_toggle_patch(
    snapshot: &Value,
    plugin_id: &str,
    enabled: bool,
) -> Result<Value, String> {
    let mut entries = plugin_entries_from_snapshot(snapshot);
    let mut plugin_entry = entries
        .get(plugin_id)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    plugin_entry.insert("enabled".to_string(), Value::Bool(enabled));
    entries.insert(plugin_id.to_string(), Value::Object(plugin_entry));

    // Plugin placement on disk is owned by `openclaw plugins install`; the
    // toggle only manages entries/allow/deny and never writes load paths.
    let also_allow = unique_also_allow_entries(
        &tools_also_allow_from_snapshot(snapshot),
        plugin_id,
        enabled,
    );
    let allow = reconcile_allow(plugin_allow_from_snapshot(snapshot), plugin_id, enabled);
    let existing_deny = plugin_deny_from_snapshot(snapshot);
    let deny = reconcile_deny(&existing_deny, plugin_id, enabled);

    let mut plugins_patch = Map::new();
    plugins_patch.insert("entries".to_string(), Value::Object(entries));
    if let Some(allow) = allow {
        plugins_patch.insert("allow".to_string(), json!(allow));
    }
    if !deny.is_empty() || !existing_deny.is_empty() {
        plugins_patch.insert("deny".to_string(), json!(deny));
    }

    let patch = json!({
        "tools": {
            "alsoAllow": also_allow
        },
        "plugins": Value::Object(plugins_patch)
    });

    Ok(patch)
}

fn plugin_readiness_reasons(
    installed: bool,
    enabled: bool,
    _tool_bridge_enabled: bool,
    missing_env: &[String],
    runtime_allowed: bool,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if !installed {
        reasons.push("not_installed".to_string());
    }
    if installed && !enabled {
        reasons.push("disabled".to_string());
    }
    for key in missing_env {
        reasons.push(format!("missing_env:{key}"));
    }
    if enabled && missing_env.is_empty() && !runtime_allowed {
        reasons.push("runtime_not_allowed".to_string());
    }
    reasons
}

pub(crate) fn tool_capabilities_from_config(
    profile: String,
    snapshot: &Value,
    plugin_paths: &[(ProfilePluginDefinition, PathBuf)],
) -> OpenClawProfileToolCapabilitiesSnapshot {
    let entries = plugin_entries_from_snapshot(snapshot);
    let plugins = plugin_paths
        .iter()
        .map(|(definition, path)| {
            let record = plugin_record_from_config(definition, path.clone(), &entries);
            let manifest_tools = manifest_tools(path);
            let manifest_tool_names = manifest_tools
                .iter()
                .map(|tool| tool.name.clone())
                .collect::<Vec<_>>();
            let runtime_allowed = plugin_tools_allowed_by_runtime_policy(
                snapshot,
                &definition.id,
                &manifest_tool_names,
            );
            let status = if record.status == "ready" && !runtime_allowed {
                "runtime_blocked".to_string()
            } else {
                record.status
            };
            let readiness_reasons = plugin_readiness_reasons(
                record.installed,
                record.enabled,
                record.tool_bridge_enabled,
                &record.missing_env,
                runtime_allowed,
            );
            let tools = if status == "ready" {
                manifest_tools
            } else {
                Vec::new()
            };
            OpenClawProfileToolCapabilityPlugin {
                id: record.id,
                title: record.title,
                description: record.description,
                official: true,
                enabled: record.enabled,
                installed: record.installed,
                status,
                business_health_state: String::new(),
                business_health_label: String::new(),
                readiness_reasons,
                tools,
                has_skills: manifest_declares_skills(path),
                skill_names: plugin_skill_names(path),
            }
        })
        .collect();
    OpenClawProfileToolCapabilitiesSnapshot {
        profile,
        gateway_supports_tool_constraints: false,
        plugins,
    }
}

fn push_unique_tool_name(names: &mut Vec<String>, seen: &mut HashSet<String>, value: &str) {
    let name = value.trim();
    if !name.is_empty() && seen.insert(name.to_string()) {
        names.push(name.to_string());
    }
}

fn collect_tool_names_from_array(
    items: &[Value],
    names: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    for item in items {
        if let Some(name) = item.as_str() {
            push_unique_tool_name(names, seen, name);
            continue;
        }
        if let Some(name) = item.get("name").and_then(Value::as_str) {
            push_unique_tool_name(names, seen, name);
            continue;
        }
        if let Some(item_names) = item.get("names").and_then(Value::as_array) {
            collect_tool_names_from_array(item_names, names, seen);
        }
    }
}

fn collect_runtime_tool_names(value: &Value, names: &mut Vec<String>, seen: &mut HashSet<String>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let key = key.to_ascii_lowercase();
                if matches!(
                    key.as_str(),
                    "tools" | "registeredtools" | "toolregistrations"
                ) {
                    if let Some(items) = child.as_array() {
                        collect_tool_names_from_array(items, names, seen);
                    }
                    continue;
                }
                if matches!(
                    key.as_str(),
                    "manifest" | "contracts" | "config" | "metadata" | "package"
                ) {
                    continue;
                }
                collect_runtime_tool_names(child, names, seen);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_runtime_tool_names(item, names, seen);
            }
        }
        _ => {}
    }
}

fn runtime_inspect_tool_names(value: &Value) -> Vec<String> {
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    for key in [
        "runtime",
        "runtimeRegistrations",
        "registrations",
        "registered",
        "capabilities",
        "exports",
    ] {
        if let Some(child) = value.get(key) {
            collect_runtime_tool_names(child, &mut names, &mut seen);
        }
    }
    if names.is_empty() && !value.get("manifest").is_some() && !value.get("contracts").is_some() {
        collect_runtime_tool_names(value, &mut names, &mut seen);
    }
    if names.is_empty() {
        if let Some(items) = value.get("tools").and_then(Value::as_array) {
            collect_tool_names_from_array(items, &mut names, &mut seen);
        }
    }
    names
}

fn apply_runtime_tool_verification(
    plugin: &mut OpenClawProfileToolCapabilityPlugin,
    runtime_tool_names: &[String],
) {
    if plugin.status != "ready" {
        return;
    }
    // Skill-pack plugins (manifest `skills` only, e.g. uniopc-documents /
    // uniopc-shopify) declare no tool contract, so there is nothing for the
    // runtime probe to verify — an empty runtime tool list is their normal
    // healthy state, not a missing-tools failure.
    let declared_tool_names = plugin
        .tools
        .iter()
        .map(|tool| tool.name.trim())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    if declared_tool_names.is_empty() {
        return;
    }
    let runtime_tools = runtime_tool_names
        .iter()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .collect::<HashSet<_>>();
    let all_declared_tools_visible = !runtime_tools.is_empty()
        && declared_tool_names
            .iter()
            .all(|name| runtime_tools.contains(name));
    if all_declared_tools_visible {
        return;
    }
    plugin.status = "runtime_missing".to_string();
    if !plugin
        .readiness_reasons
        .iter()
        .any(|reason| reason == "runtime_missing_tools")
    {
        plugin
            .readiness_reasons
            .push("runtime_missing_tools".to_string());
    }
    plugin.tools.clear();
}

// The runtime inspect probe is the final source of truth for capability
// exposure. If it cannot complete, configuration/manifest data remains useful
// for diagnosis but must never make the plugin invocable through the "/" menu.
fn mark_runtime_inspect_unverified(plugin: &mut OpenClawProfileToolCapabilityPlugin) {
    if plugin.status != "ready" {
        return;
    }
    if !plugin
        .readiness_reasons
        .iter()
        .any(|reason| reason == "runtime_inspect_unverified")
    {
        plugin
            .readiness_reasons
            .push("runtime_inspect_unverified".to_string());
    }
    plugin.status = "runtime_unverified".to_string();
    plugin.tools.clear();
}

fn cloud_agent_health_probe(plugin_id: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match plugin_id {
        "uniopc-montage" => Some((
            "UNIOPC_MONTAGE_API_URL",
            "plugin_list_collections",
            "uniopc_montage_failed",
        )),
        UNIOPC_SOCIALS_PLUGIN_ID => Some((
            "UNIOPC_SOCIALS_API_URL",
            "uniopc_socials_get_settings",
            "uniopc_socials_failed",
        )),
        // 注意这里要填 **action**,不是工具名。private-conversion 的
        // "get settings" 工具对外发的 action 是 uniopc_private_conversion_context_get;
        // 曾误填工具名 uniopc_private_conversion_get_settings,服务端没有该 action,
        // 探针恒返回 unsupported_action → 插件被判 private_conversion_failed、
        // UI 常驻"运行异常"。socials 侥幸没踩到,只因它的 action 与工具同名。
        UNIOPC_PRIVATE_CONVERSION_PLUGIN_ID => Some((
            "UNIOPC_PRIVATE_CONVERSION_API_URL",
            "uniopc_private_conversion_context_get",
            "private_conversion_failed",
        )),
        _ => None,
    }
}

fn env_string(env: &Map<String, Value>, key: &str) -> String {
    env.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn cloud_agent_host_credential_env_key(plugin_id: &str) -> &'static str {
    match plugin_id {
        "uniopc-montage" => "UNIOPC_MONTAGE_HOST_CREDENTIAL",
        UNIOPC_SOCIALS_PLUGIN_ID => "UNIOPC_SOCIALS_HOST_CREDENTIAL",
        UNIOPC_PRIVATE_CONVERSION_PLUGIN_ID => "UNIOPC_PRIVATE_CONVERSION_HOST_CREDENTIAL",
        UNIOPC_SUPER_IP_PLUGIN_ID => "UNIOPC_SUPERIP_HOST_CREDENTIAL",
        // uniopc-wechat-mp 不在此表,理由同 cloud_agent_api_url_env_key。
        _ => "UNIOPC_CLOUD_WORKSPACE_HOST_CREDENTIAL",
    }
}

fn cloud_agent_health_failure_status(http_status: u16, code: &str, fallback: &str) -> String {
    let normalized = code.trim();
    if http_status == 401
        || http_status == 403
        || normalized == "unauthorized"
        || normalized == "未授权"
        || normalized == "invalid_host_credential"
        || normalized == "plugin_not_entitled"
        || normalized == "agent_not_authorized"
    {
        return "unauthorized".to_string();
    }
    if normalized == "missing_authorization" || normalized == "missing_host_credential" {
        return "missing_env".to_string();
    }
    if !normalized.is_empty() && normalized.ends_with("_failed") {
        return normalized.to_string();
    }
    fallback.to_string()
}

fn cloud_agent_health_response_is_ready(http_status: u16, code: &str, has_error: bool) -> bool {
    if (200..300).contains(&http_status) && !has_error {
        return true;
    }
    http_status == 400 && code.trim() == "missing_agent_identity"
}

fn business_health_status_blocks_capability(status: &str) -> bool {
    matches!(status, "unauthorized" | "missing_env")
}

// A just-restarted gateway can still be loading its plugin runtime when the
// doctor check probes it (config write + restart happen right before the
// refresh that calls this), so a single failed `plugins inspect --runtime` does
// not mean the plugin is broken. Retry a few times with a short delay before
// declaring the capability inspect-failed — this is what kept official plugins
// stuck showing "服务异常" / "修复并重启" on an otherwise-healthy engine.
const RUNTIME_INSPECT_MAX_ATTEMPTS: usize = 3;
const RUNTIME_INSPECT_RETRY_DELAY_MS: u64 = 700;

// One `--all` inspect covers every plugin in a single CLI spawn. The per-plugin
// variant (`plugins inspect <id>`) costs a full Node CLI start each (~4s), and
// every openclaw spawn is serialized behind the global CLI lock — with 4 ready
// plugins the capability snapshot took >70s while the "/" capability menu only
// waits 15s on the JS side. Each array entry has the same shape as the
// single-plugin output, so `runtime_inspect_tool_names` applies unchanged.
// The CLI bridge returns stdout and stderr concatenated, and the engine logs
// warnings to stderr (e.g. "[channels] failed to load bundled channel …"), so
// the combined output is JSON with junk lines around it. A strict
// `serde_json::from_str` therefore failed on EVERY in-app inspect — each call
// burned all 3 retries and every plugin fell open to `runtime_inspect_unverified`.
// Parse the first JSON value found, ignoring surrounding non-JSON noise.
fn parse_cli_json_lenient(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    for (index, byte) in trimmed.bytes().enumerate() {
        if byte == b'[' || byte == b'{' {
            let mut deserializer = serde_json::Deserializer::from_str(&trimmed[index..]);
            if let Ok(value) = Value::deserialize(&mut deserializer) {
                return Some(value);
            }
        }
    }
    None
}

fn inject_cloud_workspace_auth_env(
    patch: &mut Value,
    plugin_id: &str,
    existing_env: Map<String, Value>,
    definition: &ProfilePluginDefinition,
    api_url: Option<String>,
    host_credential: Option<String>,
) -> Result<(), String> {
    let mut env = existing_env;
    let api_url_env_key = cloud_agent_api_url_env_key_for(definition);
    let api_url = api_url
        .ok_or_else(|| "缺少 Cloud Agent API URL，无法开启 Cloud Workspace 插件。".to_string())?;
    let host_credential = host_credential.ok_or_else(|| {
        "缺少 Cloud Agent Host Credential，无法开启 Cloud Workspace 插件。".to_string()
    })?;
    env.insert(api_url_env_key, Value::String(api_url));
    env.insert(
        cloud_agent_host_credential_env_key_for(definition),
        Value::String(host_credential),
    );
    inject_plugin_env(patch, plugin_id, env, &HashMap::new());
    Ok(())
}

/// Merge generic plugin env vars (connector credentials) into the config
/// patch, mirroring inject_cloud_workspace_auth_env. Empty keys/values are
/// skipped so a half-filled form can never blank out existing credentials.
fn inject_plugin_env(
    patch: &mut Value,
    plugin_id: &str,
    existing_env: Map<String, Value>,
    extra_env: &HashMap<String, String>,
) {
    let mut env = existing_env;
    for (key, value) in extra_env {
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        env.insert(key.to_string(), Value::String(value.to_string()));
    }
    let Some(entries) = patch
        .get_mut("plugins")
        .and_then(Value::as_object_mut)
        .and_then(|plugins| plugins.get_mut("entries"))
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let entry = entries
        .entry(plugin_id.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(entry) = entry.as_object_mut() else {
        return;
    };
    let config = entry
        .entry("config".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(config) = config.as_object_mut() else {
        return;
    };
    let mut merged_env = config
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    merged_env.extend(env);
    config.insert("env".to_string(), Value::Object(merged_env));
}

/// Build the environment passed to the app-owned local Gateway child. Values
/// remain plugin-private in `openclaw.json`; no root config `env` is used.
pub(crate) fn gateway_plugin_private_env(profile: Option<&str>) -> Vec<(String, String)> {
    let Ok(snapshot) = openclaw_gateway::load_openclaw_config_for_profile(profile) else {
        return Vec::new();
    };
    gateway_plugin_private_env_from_config(&snapshot)
}

fn gateway_plugin_private_env_from_config(snapshot: &Value) -> Vec<(String, String)> {
    let entries = plugin_entries_from_snapshot(&snapshot);
    let mut values = BTreeMap::new();
    for (plugin_id, entry) in &entries {
        if !entry_enabled(&entries, plugin_id) {
            continue;
        }
        let env = entry
            .get("config")
            .and_then(|config| config.get("env"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, value) in env {
            let valid_name = !key.is_empty()
                && key
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
                && key
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '_');
            if valid_name {
                if let Some(value) = value
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    values.insert(key, value.to_string());
                }
            }
        }
    }
    values.into_iter().collect()
}

/// OpenClaw 8.1 rejects the root `env` entries written by the pre-8.1
/// lifecycle. Strip only Uniopc-owned legacy keys before talking to Gateway so
/// an otherwise valid local file can boot again. A marketplace update then
/// writes fresh credentials into the compatible plugin `config.env` schema.
fn legacy_root_plugin_env_cleanup_patch(snapshot: &Value) -> Option<Value> {
    let root_env = env_from_snapshot(snapshot);
    let mut removals = Map::new();
    for definition in plugin_definitions() {
        for key in definition.required_env {
            if root_env.contains_key(&key) {
                removals.insert(key, Value::Null);
            }
        }
    }
    // Dynamic official plugins are intentionally not in the static registry.
    // Their credential keys nevertheless follow this public contract, so clear
    // the legacy root form as well (for example `UNIOPC_MONTAGE_*`).
    for key in root_env.keys() {
        if key.starts_with("UNIOPC_")
            && (key.ends_with("_API_URL") || key.ends_with("_HOST_CREDENTIAL"))
        {
            removals.insert(key.clone(), Value::Null);
        }
    }
    (!removals.is_empty()).then(|| json!({ "env": Value::Object(removals) }))
}

fn plugin_enabled_matches(snapshot: &Value, plugin_id: &str, enabled: bool) -> bool {
    let entries = plugin_entries_from_snapshot(snapshot);
    let entry_matches = entry_enabled(&entries, plugin_id) == enabled;
    if !enabled {
        return entry_matches;
    }
    entry_matches && acpx_tool_bridge_enabled(&entries)
}

fn plugin_patch_error_may_be_restarting(error: &str) -> bool {
    let normalized = error.to_lowercase();
    normalized.contains("关闭连接")
        || normalized.contains("closed")
        || normalized.contains("connection reset")
        || normalized.contains("connection refused")
        || normalized.contains("timeout")
        || normalized.contains("超时")
        || normalized.contains("restart")
}

fn supported_plugin_records_for_paths(
    plugin_paths: Vec<(ProfilePluginDefinition, PathBuf)>,
) -> Vec<OpenClawSupportedPluginRecord> {
    plugin_paths
        .into_iter()
        .map(|(definition, path)| OpenClawSupportedPluginRecord {
            id: definition.id.clone(),
            title: definition.title.clone(),
            description: definition.description.clone(),
            aliases: plugin_aliases(&definition.id),
            required_env: definition.required_env.clone(),
            plugin_path: path.to_string_lossy().to_string(),
            supports_start: true,
            supports_stop: true,
            supports_restart: true,
            supports_repair: true,
            supports_credential_issue: definition_requires_cloud_agent_auth(&definition),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as STANDARD_BASE64, Engine as _};
    use std::io::{Cursor, Write};
    use tauri::Manager;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn lifecycle_fixture_zip(plugin_api_requirement: &str) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("package/openclaw.plugin.json", SimpleFileOptions::default())
            .expect("start manifest entry");
        writer
            .write_all(br#"{"id":"smart-montage","version":"2.0.0"}"#)
            .expect("write manifest");
        writer
            .start_file("package/package.json", SimpleFileOptions::default())
            .expect("start package metadata entry");
        writer
            .write_all(
                format!(
                    r#"{{"openclaw":{{"compat":{{"pluginApi":"{plugin_api_requirement}"}}}}}}"#
                )
                .as_bytes(),
            )
            .expect("write package metadata");
        writer
            .start_file("package/index.js", SimpleFileOptions::default())
            .expect("start plugin entry");
        writer
            .write_all(b"export default {};")
            .expect("write plugin entry");
        writer.finish().expect("finish fixture").into_inner()
    }

    #[test]
    fn compatibility_boundary_prepares_backend_owned_review() {
        let bytes = lifecycle_fixture_zip(">=2026.8.0 <2026.9.0");
        let artifact_sha256 = crate::services::plugin_artifact::sha256_hex(&bytes);
        let prepared = compatibility::prepare_plugin_install(UniopcPluginLifecyclePrepareRequest {
            profile: Some("default".to_string()),
            plugin_id: "smart-montage".to_string(),
            artifact_sha256,
            zip_base64: STANDARD_BASE64.encode(bytes),
        })
        .expect("compatible artifact must be prepared");
        let review = prepared.review.as_ref().expect("artifact review");

        assert_eq!(review.plugin_api_requirement, ">=2026.8.0 <2026.9.0");
        assert_eq!(review.host_version, "2026.8.1");
        cleanup_prepared_install(&prepared);
    }

    fn invoke_lifecycle_prepare(plugin_api_requirement: &str) -> Result<Value, Value> {
        let bytes = lifecycle_fixture_zip(plugin_api_requirement);
        let artifact_sha256 = crate::services::plugin_artifact::sha256_hex(&bytes);
        let app = tauri::test::mock_builder()
            .manage(PluginLifecycleStaging::default())
            .invoke_handler(tauri::generate_handler![
                plugins::uniopc_plugin_lifecycle_prepare
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build test app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build test webview");
        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "uniopc_plugin_lifecycle_prepare".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().expect("test url"),
                body: tauri::ipc::InvokeBody::Json(json!({
                    "req": {
                        "profile": "default",
                        "pluginId": "smart-montage",
                        "artifactSha256": artifact_sha256,
                        "zipBase64": STANDARD_BASE64.encode(bytes),
                    }
                })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .map(|body| {
            body.deserialize::<Value>()
                .expect("deserialize command result")
        });

        if let Ok(review) = &response {
            let stage_id = review["stageId"].as_str().expect("stage id");
            let prepared = app
                .state::<PluginLifecycleStaging>()
                .remove_for(stage_id, "default", "smart-montage")
                .expect("prepared install");
            cleanup_prepared_install(&prepared);
        }
        response
    }

    #[test]
    fn tauri_prepare_returns_backend_owned_plugin_api_compatibility() {
        let review = invoke_lifecycle_prepare(">=2026.8.0 <2026.9.0")
            .expect("compatible artifact must reach review");

        assert_eq!(review["pluginApiRequirement"], ">=2026.8.0 <2026.9.0");
        assert_eq!(review["hostVersion"], "2026.8.1");
    }

    #[test]
    fn tauri_prepare_returns_stable_error_for_incompatible_plugin_api() {
        let error = invoke_lifecycle_prepare(">=2027.1.0 <2028.0.0")
            .expect_err("future plugin API must fail before review");

        assert_eq!(error["code"], "plugin_api_incompatible");
        assert_eq!(error["pluginApiRequirement"], ">=2027.1.0 <2028.0.0");
        assert_eq!(error["hostVersion"], "2026.8.1");
        assert_eq!(error["retryable"], false);
        assert!(!error["message"]
            .as_str()
            .expect("branded lifecycle message")
            .contains("OpenClaw"));
    }

    #[test]
    fn tauri_prepare_does_not_echo_malformed_plugin_api_requirements() {
        let malicious = "TOP-SECRET-OpenClaw-TOKEN".to_string();
        let oversized = format!("LEAK-ME-{}", "x".repeat(1024 * 1024));

        for (requirement, marker) in [
            (malicious.as_str(), "TOP-SECRET"),
            (oversized.as_str(), "LEAK-ME"),
        ] {
            let error = invoke_lifecycle_prepare(requirement)
                .expect_err("malformed plugin API requirement must fail");
            let serialized = serde_json::to_string(&error).expect("serialize command error");

            assert_eq!(error["code"], "plugin_api_incompatible");
            assert_eq!(error.get("pluginApiRequirement"), None);
            assert!(serialized.len() <= 512, "error payload must remain bounded");
            assert!(!serialized.contains(marker), "error payload leaked input");
            assert!(
                !serialized.contains("OpenClaw"),
                "error payload leaked brand"
            );
        }
    }

    fn plugin_paths_for_test() -> Vec<(ProfilePluginDefinition, PathBuf)> {
        plugin_definitions()
            .into_iter()
            .map(|definition| {
                let path = std::env::temp_dir().join(format!(
                    "imai-plugin-doctor-{}-{}",
                    definition.id,
                    uuid::Uuid::new_v4()
                ));
                std::fs::create_dir_all(&path).ok();
                std::fs::write(crate::services::plugin_artifact::plugin_manifest_path(&path), "{}").ok();
                (definition, path)
            })
            .collect()
    }

    #[test]
    fn plugin_grants_snapshot_writes_versioned_shape_and_rejects_non_objects() {
        let dir = std::env::temp_dir().join(format!("uniopc-grants-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PLUGIN_GRANTS_SNAPSHOT_BASENAME);

        let grants = json!({
            "uniopc-socials": {
                "name": "公域获客",
                "status": "active",
                "agents": "all",
                "tools": ["uniopc_socials_get_settings"]
            }
        });
        write_plugin_grants_snapshot_file(&path, &grants).unwrap();

        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["version"], 1);
        assert!(written["updatedAt"].as_str().is_some());
        assert_eq!(written["grants"]["uniopc-socials"]["status"], "active");
        // 原子写不留 tmp 残骸。
        assert!(!path.with_extension("json.tmp").exists());

        assert!(write_plugin_grants_snapshot_file(&path, &json!(["not-an-object"])).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plugin_grants_merge_cloud_status_with_local_manifest_tools() {
        let installed = vec![
            (
                "uniopc-superip".to_string(),
                json!({
                    "name": "超级IP",
                    "contracts": { "tools": ["uniopc_superip_produce_video"] }
                }),
            ),
            (
                "uniopc-gatekeeper".to_string(),
                json!({
                    "name": "授权守门",
                    "contracts": { "tools": [] }
                }),
            ),
        ];
        let statuses = vec![PluginGrantStatusInput {
            plugin_id: "uniopc-superip".to_string(),
            status: "revoked".to_string(),
            name: Some("超级IP视频".to_string()),
            agents: None,
        }];

        let grants = build_plugin_grants(&statuses, &installed);

        // 云端状态 + 显示名生效,工具来自本地 manifest。
        assert_eq!(grants["uniopc-superip"]["status"], "revoked");
        assert_eq!(grants["uniopc-superip"]["name"], "超级IP视频");
        assert_eq!(
            grants["uniopc-superip"]["tools"][0],
            "uniopc_superip_produce_video"
        );
        assert_eq!(grants["uniopc-superip"]["agents"], "all");
        // 云端不认识的已装插件(如 gatekeeper 自身)默认 active,不设门。
        assert_eq!(grants["uniopc-gatekeeper"]["status"], "active");
    }

    #[test]
    fn disabling_shrinks_exactly_the_arrays_declared_in_replace_paths() {
        // 回归钉:停用会把插件从 plugins.allow / tools.alsoAllow 摘掉,引擎的
        // config.patch 会拒绝隐式缩短数组("would remove entries from array
        // path(s)")。凡是被 patch 缩短的数组,都必须在 PLUGIN_TOGGLE_SHRINKING_PATHS
        // 里点名,否则停用与卸载(第一步即 enabled=false)都会失败。
        let snapshot = json!({
            "parsed": {
                "plugins": {
                    "load": { "paths": [] },
                    "entries": { "uniopc-socials": { "enabled": true } },
                    "allow": ["uniopc-socials", "acpx"],
                    "deny": []
                },
                "tools": { "alsoAllow": ["uniopc-socials", "acpx"] }
            }
        });

        let patch = build_plugin_toggle_patch(&snapshot, "uniopc-socials", false)
            .expect("disable patch should build");

        let shrunk = |before: usize, path: &[&str]| -> bool {
            let mut node = &patch;
            for key in path {
                node = &node[*key];
            }
            node.as_array()
                .map(|items| items.len() < before)
                .unwrap_or(false)
        };

        assert!(shrunk(2, &["plugins", "allow"]), "plugins.allow 应被缩短");
        assert!(
            shrunk(2, &["tools", "alsoAllow"]),
            "tools.alsoAllow 应被缩短"
        );
        for path in ["plugins.allow", "tools.alsoAllow"] {
            assert!(
                PLUGIN_TOGGLE_REPLACE_PATHS.contains(&path),
                "{path} 会被缩短,必须列进 PLUGIN_TOGGLE_REPLACE_PATHS",
            );
        }
    }

    #[test]
    fn enabling_only_grows_arrays_so_it_needs_no_replace_paths() {
        let snapshot = json!({
            "parsed": {
                "plugins": {
                    "load": { "paths": [] },
                    "entries": {},
                    "allow": ["acpx"],
                    "deny": ["uniopc-socials"]
                },
                "tools": { "alsoAllow": ["acpx"] }
            }
        });

        let patch = build_plugin_toggle_patch(&snapshot, "uniopc-socials", true)
            .expect("enable patch should build");

        assert!(patch["plugins"]["allow"].as_array().unwrap().len() >= 2);
        assert!(patch["tools"]["alsoAllow"].as_array().unwrap().len() >= 2);
        // 启用把插件从 deny 里摘掉 —— 这同样是数组缩短,所以 plugins.deny 也
        // 必须在 replacePaths 里(早期只覆盖了停用侧的两条)。
        assert!(!patch["plugins"]["deny"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item == "uniopc-socials")),);
        assert!(patch["plugins"]["deny"].as_array().unwrap().len() < 1);
        assert!(PLUGIN_TOGGLE_REPLACE_PATHS.contains(&"plugins.deny"));
    }

    #[test]
    fn safe_plugin_id_rejects_path_escapes_and_odd_shapes() {
        assert!(is_safe_plugin_id("uniopc-foo"));
        assert!(is_safe_plugin_id("nativekids-picturebook"));
        assert!(!is_safe_plugin_id(""));
        assert!(!is_safe_plugin_id("../evil"));
        assert!(!is_safe_plugin_id("uniopc/foo"));
        assert!(!is_safe_plugin_id("Uniopc-Foo"));
        assert!(!is_safe_plugin_id("-leading-dash"));
    }

    #[test]
    fn dynamic_definition_derives_from_manifest_and_filters_platform_env() {
        let manifest = json!({
            "id": "uniopc-foo",
            "name": "Uniopc Foo",
            "description": "示例云插件",
            "requiredEnv": [
                "UNIOPC_FOO_API_URL",
                "UNIOPC_FOO_HOST_CREDENTIAL",
                "UNIOPC_OPENCLAW_PROFILE"
            ]
        });
        let definition = definition_from_manifest("uniopc-foo", &manifest);
        assert_eq!(definition.id, "uniopc-foo");
        assert_eq!(definition.title, "Uniopc Foo");
        // 平台自动注入的 env 不进 required_env,否则永远 missing_env。
        assert_eq!(
            definition.required_env,
            vec!["UNIOPC_FOO_API_URL", "UNIOPC_FOO_HOST_CREDENTIAL"]
        );
        assert!(definition_requires_cloud_agent_auth(&definition));
        // 凭据 env 键名直接来自 manifest 声明 —— 新插件零桌面登记的关键。
        assert_eq!(
            cloud_agent_api_url_env_key_for(&definition),
            "UNIOPC_FOO_API_URL"
        );
        assert_eq!(
            cloud_agent_host_credential_env_key_for(&definition),
            "UNIOPC_FOO_HOST_CREDENTIAL"
        );
    }

    #[test]
    fn skill_pack_manifest_without_env_needs_no_cloud_agent_auth() {
        let manifest = json!({ "id": "uniopc-bar-skills", "name": "Bar 技能包" });
        let definition = definition_from_manifest("uniopc-bar-skills", &manifest);
        assert!(definition.required_env.is_empty());
        assert!(!definition_requires_cloud_agent_auth(&definition));
    }

    #[test]
    fn wechat_mp_is_user_managed_and_never_requires_a_host_credential() {
        // 回归钉:公众号插件 0.2.0 起是用户自持凭据的本机直连插件(2b)。
        // 静态表优先于 manifest,所以这里一旦漂回 *_HOST_CREDENTIAL,桌面就会
        // 重新去铸 host credential、把请求指向已删除的 /functions/v1/wechat-mp,
        // 而且 api-key 表单永远弹不出来。
        let definition = plugin_definitions()
            .into_iter()
            .find(|definition| definition.id == UNIOPC_WECHAT_MP_PLUGIN_ID)
            .expect("wechat-mp definition missing");
        assert!(!definition_requires_cloud_agent_auth(&definition));
        assert_eq!(
            definition.required_env,
            vec!["WECHAT_MP_APP_ID", "WECHAT_MP_APP_SECRET"]
        );
        assert!(!definition
            .required_env
            .iter()
            .any(|key| key.ends_with("_API_URL")));
    }

    #[test]
    fn builtin_definitions_derive_same_env_keys_as_legacy_id_mapping() {
        // 回归钉:内置插件从 required_env 派生的键名必须与旧的按-id 静态映射
        // 逐字节一致,否则升级后凭据会写进错误的 env 键。
        for definition in plugin_definitions() {
            if !definition_requires_cloud_agent_auth(&definition) {
                continue;
            }
            assert_eq!(
                cloud_agent_api_url_env_key_for(&definition),
                cloud_agent_api_url_env_key(&definition.id),
                "api url env key drifted for {}",
                definition.id
            );
            assert_eq!(
                cloud_agent_host_credential_env_key_for(&definition),
                cloud_agent_host_credential_env_key(&definition.id),
                "host credential env key drifted for {}",
                definition.id
            );
        }
    }

    #[test]
    fn plugin_definition_still_rejects_unknown_uninstalled_plugin() {
        let error = plugin_definition("uniopc-definitely-not-installed-xyz")
            .expect_err("uninstalled unknown plugin must not resolve");
        assert!(error.contains("不支持管理插件"));
    }

    #[test]
    fn cloud_agent_health_failure_status_maps_auth_and_service_errors() {
        assert_eq!(
            cloud_agent_health_failure_status(500, "未授权", "uniopc_montage_failed"),
            "unauthorized"
        );
        assert_eq!(
            cloud_agent_health_failure_status(
                401,
                "invalid_host_credential",
                "uniopc_socials_failed"
            ),
            "unauthorized"
        );
        assert_eq!(
            cloud_agent_health_failure_status(
                403,
                "plugin_not_entitled",
                "private_conversion_failed"
            ),
            "unauthorized"
        );
        assert_eq!(
            cloud_agent_health_failure_status(
                500,
                "uniopc_socials_failed",
                "uniopc_socials_failed"
            ),
            "uniopc_socials_failed"
        );
        assert_eq!(
            cloud_agent_health_failure_status(500, "", "private_conversion_failed"),
            "private_conversion_failed"
        );
    }

    #[test]
    fn cloud_agent_health_response_accepts_profile_level_agent_identity_probe() {
        assert!(cloud_agent_health_response_is_ready(
            400,
            "missing_agent_identity",
            true
        ));
        assert!(!cloud_agent_health_response_is_ready(
            400,
            "unsupported_action",
            true
        ));
        assert!(cloud_agent_health_response_is_ready(200, "", false));
    }

    #[test]
    fn business_health_service_errors_do_not_hide_runtime_tools() {
        assert!(business_health_status_blocks_capability("unauthorized"));
        assert!(business_health_status_blocks_capability("missing_env"));
        assert!(!business_health_status_blocks_capability(
            "private_conversion_failed"
        ));
        assert!(!business_health_status_blocks_capability(
            "uniopc_socials_failed"
        ));
    }

    #[test]
    fn cloud_agent_health_probe_uses_runtime_plugin_actions() {
        assert_eq!(
            cloud_agent_health_probe("uniopc-montage"),
            Some((
                "UNIOPC_MONTAGE_API_URL",
                "plugin_list_collections",
                "uniopc_montage_failed"
            ))
        );
        assert_eq!(
            cloud_agent_health_probe(UNIOPC_SOCIALS_PLUGIN_ID),
            Some((
                "UNIOPC_SOCIALS_API_URL",
                "uniopc_socials_get_settings",
                "uniopc_socials_failed"
            ))
        );
        // 必须是 **action** 而非工具名:private-conversion 的 get-settings 工具
        // 对外发的 action 是 ..._context_get。此处曾误填工具名
        // uniopc_private_conversion_get_settings —— 服务端没有该分支,探针恒返回
        // unsupported_action,插件被判 private_conversion_failed、UI 常驻"运行异常"。
        // 跨仓契约测试(uniopc-supabase 的 plugin-action-contract.test.mjs)会核对
        // 这里的每个 action 在云函数分发器中确实存在。
        assert_eq!(
            cloud_agent_health_probe(UNIOPC_PRIVATE_CONVERSION_PLUGIN_ID),
            Some((
                "UNIOPC_PRIVATE_CONVERSION_API_URL",
                "uniopc_private_conversion_context_get",
                "private_conversion_failed"
            ))
        );
    }

    #[test]
    fn enabling_an_ordinary_plugin_does_not_enable_or_allow_acpx() {
        let patch = build_plugin_toggle_patch(
            &json!({
                "parsed": {
                    "tools": {
                        "profile": "coding",
                        "alsoAllow": ["existing-plugin"]
                    },
                    "plugins": {
                        "load": { "paths": ["/existing/plugin"] },
                        "entries": {
                            "existing": { "enabled": true },
                            "acpx": { "config": { "other": true } }
                        }
                    }
                }
            }),
            IMAI_CLOUD_WORKSPACE_PLUGIN_ID,
            true,
        )
        .expect("patch should build");

        // Plugin placement is owned by `openclaw plugins install`; the toggle
        // patch must never write plugins.load.paths.
        assert_eq!(patch["plugins"].get("load"), None);
        assert_eq!(
            patch["plugins"]["entries"][IMAI_CLOUD_WORKSPACE_PLUGIN_ID]["enabled"],
            true
        );
        assert_eq!(patch["plugins"]["entries"]["existing"]["enabled"], true);
        assert_eq!(patch["plugins"]["entries"]["acpx"]["config"]["other"], true);
        assert_eq!(
            patch["plugins"]["entries"]["acpx"]["config"].get("pluginToolsMcpBridge"),
            None
        );
        assert_eq!(
            patch["plugins"]["allow"],
            json!([IMAI_CLOUD_WORKSPACE_PLUGIN_ID])
        );
        assert_eq!(
            patch["tools"]["alsoAllow"],
            json!(["existing-plugin", IMAI_CLOUD_WORKSPACE_PLUGIN_ID])
        );
    }

    #[test]
    fn enable_patch_creates_plugin_allowlist_for_first_enabled_tool_plugin() {
        let patch = build_plugin_toggle_patch(
            &json!({
                "parsed": {
                    "plugins": {
                        "load": { "paths": [] },
                        "entries": {}
                    },
                    "tools": { "alsoAllow": [] }
                }
            }),
            IMAI_CLOUD_WORKSPACE_PLUGIN_ID,
            true,
        )
        .expect("patch should build");

        assert_eq!(
            patch["plugins"]["allow"],
            json!([IMAI_CLOUD_WORKSPACE_PLUGIN_ID])
        );
    }

    #[test]
    fn legacy_acpx_bridge_cleanup_removes_only_the_legacy_entry_and_access() {
        assert_eq!(
            legacy_acpx_bridge_cleanup_patch(&json!({
                "parsed": {
                    "plugins": {
                        "entries": {
                            "acpx": { "enabled": true, "config": { "pluginToolsMcpBridge": true } },
                            "uniopc-socials": { "enabled": true }
                        },
                        "allow": ["uniopc-socials", "acpx"]
                    },
                    "tools": { "alsoAllow": ["acpx", "uniopc-socials"] }
                }
            })),
            Some(json!({
                "plugins": {
                    "entries": { "uniopc-socials": { "enabled": true } },
                    "allow": ["uniopc-socials"]
                },
                "tools": { "alsoAllow": ["uniopc-socials"] }
            }))
        );
    }

    #[test]
    fn legacy_acpx_bridge_cleanup_preserves_user_owned_acpx_configuration() {
        assert_eq!(
            legacy_acpx_bridge_cleanup_patch(&json!({
                "parsed": {
                    "plugins": {
                        "entries": {
                            "acpx": {
                                "enabled": true,
                                "config": { "pluginToolsMcpBridge": true, "custom": "keep" }
                            }
                        }
                    }
                }
            })),
            None
        );
    }

    #[test]
    fn plugin_doctor_detects_missing_authorized_plugin() {
        let policy = vec![ProfilePluginPolicyInput {
            plugin_id: UNIOPC_SOCIALS_PLUGIN_ID.to_string(),
            status: "active".to_string(),
            is_global: false,
        }];
        let plugin_paths = plugin_paths_for_test();
        let local_workspace_path = plugin_paths
            .iter()
            .find(|(definition, _)| definition.id == UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID)
            .map(|(_, path)| path.to_string_lossy().to_string())
            .expect("local workspace path");
        let report = build_plugin_doctor_report(
            "member-a".to_string(),
            3,
            &json!({
                "parsed": {
                    "plugins": {
                        "load": { "paths": [local_workspace_path] },
                        "entries": {
                            "uniopc-local-workspace": { "enabled": true }
                        }
                    },
                    "tools": { "alsoAllow": ["uniopc-local-workspace"] }
                }
            }),
            &plugin_paths,
            &policy,
        );

        assert_eq!(report.status, "needs_repair");
        assert!(report.plugins.iter().any(|plugin| {
            plugin.plugin_id == UNIOPC_SOCIALS_PLUGIN_ID
                && plugin.actual == "missing_from_profile"
                && plugin.repairable
        }));
    }

    #[test]
    fn tool_capabilities_require_plugin_tools_allowed_in_runtime_policy() {
        let dir = std::env::temp_dir().join(format!(
            "imai-tool-capability-runtime-policy-test-{}",
            uuid::Uuid::new_v4()
        ));
        let plugin_dir = dir.join(UNIOPC_SOCIALS_PLUGIN_ID);
        std::fs::create_dir_all(&plugin_dir).expect("plugin dir");
        std::fs::write(
            crate::services::plugin_artifact::plugin_manifest_path(&plugin_dir),
            r#"{
          "id": "uniopc-socials",
          "name": "公域流量",
          "contracts": { "tools": ["imai_cloud_document_create"] },
          "toolMetadata": {}
        }"#,
        )
        .expect("manifest");

        let snapshot = json!({
            "parsed": {
                "tools": { "profile": "coding" },
                "plugins": {
                    "load": { "paths": [plugin_dir.to_string_lossy()] },
                    "entries": {
                        "uniopc-socials": {
                            "enabled": true,
                            "config": { "env": {
                                "UNIOPC_SOCIALS_API_URL": "https://example.test/functions/v1/socials",
                                "UNIOPC_SOCIALS_HOST_CREDENTIAL": "imai_hc_test"
                            }}
                        },
                        "acpx": {
                            "enabled": true,
                            "config": { "pluginToolsMcpBridge": true }
                        }
                    }
                },
            }
        });

        let result = tool_capabilities_from_config(
            "imai".to_string(),
            &snapshot,
            &[(
                plugin_definition(UNIOPC_SOCIALS_PLUGIN_ID).expect("definition"),
                plugin_dir,
            )],
        );

        assert_eq!(result.plugins[0].status, "runtime_blocked");
        assert!(result.plugins[0]
            .readiness_reasons
            .contains(&"runtime_not_allowed".to_string()));
        assert!(result.plugins[0].tools.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn defines_supported_cloud_plugin_profiles() {
        let socials = plugin_definition("uniopc-socials").expect("definition");
        let private_conversion =
            plugin_definition("uniopc-private-conversion").expect("definition");

        assert!(plugin_definition(IMAI_CLOUD_WORKSPACE_PLUGIN_ID).is_err());
        assert_eq!(socials.title, "公域流量");
        assert!(socials.description.contains("竞品分析"));
        assert_eq!(
            socials.required_env,
            &["UNIOPC_SOCIALS_API_URL", "UNIOPC_SOCIALS_HOST_CREDENTIAL"]
        );
        assert_eq!(private_conversion.title, "私域转化");
        assert_eq!(
            private_conversion.required_env,
            &[
                "UNIOPC_PRIVATE_CONVERSION_API_URL",
                "UNIOPC_PRIVATE_CONVERSION_HOST_CREDENTIAL"
            ]
        );
        assert!(plugin_definition("imai-short-drama-core").is_err());
        assert!(plugin_definition("imai-media-generation").is_err());
        assert!(plugin_definition("imai-growth-socials").is_err());
    }

    #[test]
    fn builds_disable_patch_without_removing_other_entries() {
        let patch = build_plugin_toggle_patch(
            &json!({
                "parsed": {
                    "plugins": {
                        "load": { "paths": ["/extensions/uniopc-socials"] },
                        "entries": {
                            "uniopc-socials": { "enabled": true },
                            "other": { "enabled": true }
                        }
                    }
                }
            }),
            UNIOPC_SOCIALS_PLUGIN_ID,
            false,
        )
        .expect("patch should build");

        assert_eq!(
            patch["plugins"]["entries"][UNIOPC_SOCIALS_PLUGIN_ID]["enabled"],
            false
        );
        assert_eq!(patch["plugins"]["entries"]["other"]["enabled"], true);
        assert_eq!(patch["plugins"].get("load"), None);
    }

    #[test]
    fn enable_patch_adds_allowed_plugin_and_removes_deny_block() {
        let patch = build_plugin_toggle_patch(
            &json!({
                "parsed": {
                    "plugins": {
                        "allow": ["existing-plugin"],
                        "deny": ["uniopc-socials", "blocked-plugin"],
                        "load": { "paths": [] },
                        "entries": {}
                    },
                    "tools": { "alsoAllow": [] }
                }
            }),
            UNIOPC_SOCIALS_PLUGIN_ID,
            true,
        )
        .expect("patch");

        assert_eq!(
            patch["plugins"]["allow"].as_array().unwrap(),
            &vec![json!("existing-plugin"), json!("uniopc-socials")]
        );
        assert_eq!(
            patch["plugins"]["deny"].as_array().unwrap(),
            &vec![json!("blocked-plugin")]
        );
    }

    #[test]
    fn disable_patch_removes_managed_plugin_from_allow_and_tools_but_keeps_entry_config() {
        let patch = build_plugin_toggle_patch(
            &json!({
                "parsed": {
                    "plugins": {
                        "allow": ["uniopc-socials", "existing-plugin"],
                        "deny": [],
                        "load": { "paths": ["/tmp/uniopc-socials"] },
                        "entries": {
                            "uniopc-socials": {
                                "enabled": true,
                                "config": { "account": "keep-me" }
                            }
                        }
                    },
                    "tools": { "alsoAllow": ["uniopc-socials", "other-tool"] }
                }
            }),
            UNIOPC_SOCIALS_PLUGIN_ID,
            false,
        )
        .expect("patch");

        assert_eq!(
            patch["plugins"]["entries"]["uniopc-socials"]["enabled"],
            json!(false)
        );
        assert_eq!(
            patch["plugins"]["entries"]["uniopc-socials"]["config"]["account"],
            json!("keep-me")
        );
        assert_eq!(
            patch["plugins"]["allow"].as_array().unwrap(),
            &vec![json!("existing-plugin")]
        );
        assert_eq!(
            patch["tools"]["alsoAllow"].as_array().unwrap(),
            &vec![json!("other-tool")]
        );
    }

    #[test]
    fn snapshot_reports_missing_env_for_enabled_cloud_plugin() {
        let dir =
            std::env::temp_dir().join(format!("imai-profile-plugin-test-{}", uuid::Uuid::new_v4()));
        let plugin_dir = dir.join(UNIOPC_SOCIALS_PLUGIN_ID);
        std::fs::create_dir_all(&plugin_dir).expect("plugin dir");
        std::fs::write(crate::services::plugin_artifact::plugin_manifest_path(&plugin_dir), "{}").expect("manifest");
        let snapshot = json!({
            "parsed": {
                "tools": {
                    "profile": "coding",
                    "alsoAllow": ["uniopc-socials"]
                },
                "plugins": {
                    "load": { "paths": [plugin_dir.to_string_lossy()] },
                    "entries": {
                        "uniopc-socials": {
                            "enabled": true,
                            "config": { "env": {
                                "UNIOPC_SOCIALS_API_URL": "https://api.example.com"
                            }}
                        },
                        "acpx": {
                            "enabled": true,
                            "config": { "pluginToolsMcpBridge": true }
                        }
                    }
                },
            }
        });

        let result = snapshot_from_config(
            "eurisblue".to_string(),
            &snapshot,
            &[(
                plugin_definition(UNIOPC_SOCIALS_PLUGIN_ID).expect("definition"),
                plugin_dir,
            )],
        );

        assert_eq!(result.plugins[0].enabled, true);
        assert_eq!(result.plugins[0].status, "missing_env");
        assert_eq!(
            result.plugins[0].missing_env,
            vec!["UNIOPC_SOCIALS_HOST_CREDENTIAL"]
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn snapshot_includes_custom_openclaw_plugins_from_load_paths() {
        let dir =
            std::env::temp_dir().join(format!("imai-custom-plugin-test-{}", uuid::Uuid::new_v4()));
        let plugin_dir = dir.join("custom-research");
        std::fs::create_dir_all(&plugin_dir).expect("plugin dir");
        std::fs::write(
            crate::services::plugin_artifact::plugin_manifest_path(&plugin_dir),
            r#"{
              "id": "custom-research",
              "name": "Custom Research",
              "description": "User provided research plugin."
            }"#,
        )
        .expect("manifest");
        std::fs::create_dir_all(plugin_dir.join("connectors")).expect("connector dir");
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"name":"custom-research","displayName":"Custom Research"}"#,
        )
        .expect("product manifest");
        std::fs::write(
            plugin_dir.join("connectors/connectors.json"),
            r#"{"connectors":{"research":{"name":"Research API","authType":"api-key","fields":[{"key":"api_key","label":"API Key","type":"password","required":true}],"env":{"api_key":"CUSTOM_RESEARCH_API_KEY"}}}}"#,
        )
        .expect("connector manifest");
        let snapshot = json!({
            "parsed": {
                "plugins": {
                    "load": { "paths": [plugin_dir.to_string_lossy()] },
                    "entries": {
                        "custom-research": {
                            "enabled": true,
                            "config": { "env": { "CUSTOM_RESEARCH_API_KEY": "private-value" } }
                        },
                        "acpx": {
                            "enabled": true,
                            "config": { "pluginToolsMcpBridge": true }
                        }
                    }
                },
            }
        });

        let result = snapshot_from_config("eurisblue".to_string(), &snapshot, &[]);
        let plugin = result
            .plugins
            .iter()
            .find(|item| item.id == "custom-research")
            .expect("custom plugin");

        assert_eq!(plugin.title, "Custom Research");
        assert_eq!(plugin.status, "ready");
        assert_eq!(plugin.installed, true);
        assert_eq!(
            plugin
                .product
                .as_ref()
                .and_then(|product| product.connectors.first())
                .map(|connector| connector.credential_state.as_str()),
            Some("configured")
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn plugin_patch_recovery_recognizes_gateway_restart_errors() {
        assert!(plugin_patch_error_may_be_restarting(
            "Gateway config.patch 请求失败: Gateway 在返回响应前关闭连接。"
        ));
        assert!(plugin_patch_error_may_be_restarting(
            "connection reset without response"
        ));
        assert!(!plugin_patch_error_may_be_restarting(
            "Uniopc 引擎 config.get 缺少 hash"
        ));
    }

    #[test]
    fn plugin_restart_error_is_recoverable_when_config_snapshot_reaches_desired_state() {
        let snapshot = OpenClawProfilePluginsSnapshot {
            profile: "lanjinyu01-32bb573f".to_string(),
            plugins: vec![OpenClawProfilePluginRecord {
                id: UNIOPC_SOCIALS_PLUGIN_ID.to_string(),
                title: "Public Traffic".to_string(),
                description: String::new(),
                enabled: true,
                installed: true,
                status: "ready".to_string(),
                product: None,
                plugin_path: "/tmp/uniopc-socials".to_string(),
                missing_env: Vec::new(),
                tool_bridge_enabled: true,
                installed_version: Some("0.1.1".to_string()),
            }],
        };

        assert!(plugin_snapshot_reaches_desired_state(
            &snapshot,
            UNIOPC_SOCIALS_PLUGIN_ID,
            true,
        ));
        assert!(!plugin_snapshot_reaches_desired_state(
            &snapshot,
            UNIOPC_SOCIALS_PLUGIN_ID,
            false,
        ));
        assert!(!plugin_snapshot_reaches_desired_state(
            &snapshot,
            IMAI_CLOUD_WORKSPACE_PLUGIN_ID,
            true,
        ));
    }

    #[test]
    fn plugin_enabled_match_accepts_local_profile_config_snapshot() {
        let snapshot = json!({
            "plugins": {
                "load": {
                    "paths": ["/Users/lan/.openclaw/extensions/uniopc-cloud-workspace"]
                },
                "entries": {
                    "acpx": {
                        "enabled": true,
                        "config": { "pluginToolsMcpBridge": true }
                    },
                    "uniopc-cloud-workspace": { "enabled": true }
                }
            },
            "env": {
                "UNIOPC_CLOUD_WORKSPACE_API_URL": "https://example.test/functions/v1/uniopc-cloud-workspace",
                "UNIOPC_CLOUD_WORKSPACE_HOST_CREDENTIAL": "imai_hc_token"
            }
        });

        assert!(plugin_enabled_matches(
            &snapshot,
            IMAI_CLOUD_WORKSPACE_PLUGIN_ID,
            true,
        ));
    }

    #[test]
    fn plugin_manifest_tools_are_exposed_as_capabilities() {
        let dir = std::env::temp_dir().join(format!(
            "imai-tool-capability-test-{}",
            uuid::Uuid::new_v4()
        ));
        let plugin_dir = dir.join(UNIOPC_SOCIALS_PLUGIN_ID);
        std::fs::create_dir_all(&plugin_dir).expect("plugin dir");
        std::fs::write(
            crate::services::plugin_artifact::plugin_manifest_path(&plugin_dir),
            r#"{
          "id": "uniopc-socials",
          "name": "公域流量",
          "contracts": { "tools": ["imai_cloud_document_create"] },
          "toolMetadata": {
            "imai_cloud_document_create": {
              "description": "Create a cloud document."
            }
          }
        }"#,
        )
        .expect("manifest");

        let snapshot = json!({
            "parsed": {
                "tools": {
                    "profile": "coding",
                    "alsoAllow": ["uniopc-socials"]
                },
                "plugins": {
                    "load": { "paths": [plugin_dir.to_string_lossy()] },
                    "entries": {
                        "uniopc-socials": {
                            "enabled": true,
                            "config": { "env": {
                                "UNIOPC_SOCIALS_API_URL": "https://example.test/functions/v1/socials",
                                "UNIOPC_SOCIALS_HOST_CREDENTIAL": "imai_hc_test"
                            }}
                        },
                        "acpx": {
                            "enabled": true,
                            "config": { "pluginToolsMcpBridge": true }
                        }
                    }
                },
            }
        });

        let result = tool_capabilities_from_config(
            "imai".to_string(),
            &snapshot,
            &[(
                plugin_definition(UNIOPC_SOCIALS_PLUGIN_ID).expect("definition"),
                plugin_dir,
            )],
        );

        assert_eq!(result.plugins[0].status, "ready");
        assert_eq!(
            result.plugins[0].tools[0].name,
            "imai_cloud_document_create"
        );
        assert_eq!(
            result.plugins[0].tools[0].description,
            "Create a cloud document."
        );
        assert_eq!(result.plugins[0].readiness_reasons.len(), 0);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tool_capabilities_report_readiness_reasons_for_missing_env() {
        let dir = std::env::temp_dir().join(format!(
            "imai-tool-capability-missing-env-test-{}",
            uuid::Uuid::new_v4()
        ));
        let plugin_dir = dir.join(UNIOPC_SOCIALS_PLUGIN_ID);
        std::fs::create_dir_all(&plugin_dir).expect("plugin dir");
        std::fs::write(
            crate::services::plugin_artifact::plugin_manifest_path(&plugin_dir),
            r#"{
          "id": "uniopc-socials",
          "name": "公域流量",
          "contracts": { "tools": ["imai_cloud_document_create"] },
          "toolMetadata": {}
        }"#,
        )
        .expect("manifest");

        let snapshot = json!({
            "parsed": {
                "plugins": {
                    "load": { "paths": [plugin_dir.to_string_lossy()] },
                    "entries": {
                        "uniopc-socials": { "enabled": true },
                        "acpx": {
                            "enabled": true,
                            "config": { "pluginToolsMcpBridge": true }
                        }
                    }
                },
                "env": {}
            }
        });

        let result = tool_capabilities_from_config(
            "imai".to_string(),
            &snapshot,
            &[(
                plugin_definition(UNIOPC_SOCIALS_PLUGIN_ID).expect("definition"),
                plugin_dir,
            )],
        );

        assert_eq!(result.plugins[0].status, "missing_env");
        assert!(result.plugins[0]
            .readiness_reasons
            .contains(&"missing_env:UNIOPC_SOCIALS_HOST_CREDENTIAL".to_string()));
        assert!(result.plugins[0].tools.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tool_capabilities_treat_missing_host_credential_as_missing_env() {
        let dir = std::env::temp_dir().join(format!(
            "imai-tool-capability-expired-env-test-{}",
            uuid::Uuid::new_v4()
        ));
        let plugin_dir = dir.join(UNIOPC_SOCIALS_PLUGIN_ID);
        std::fs::create_dir_all(&plugin_dir).expect("plugin dir");
        std::fs::write(
            crate::services::plugin_artifact::plugin_manifest_path(&plugin_dir),
            r#"{
          "id": "uniopc-socials",
          "name": "公域流量",
          "contracts": { "tools": ["imai_cloud_document_create"] },
          "toolMetadata": {}
        }"#,
        )
        .expect("manifest");

        let snapshot = json!({
            "parsed": {
                "tools": {
                    "profile": "coding",
                    "alsoAllow": ["uniopc-socials"]
                },
                "plugins": {
                    "load": { "paths": [plugin_dir.to_string_lossy()] },
                    "entries": {
                        "uniopc-socials": { "enabled": true },
                        "acpx": {
                            "enabled": true,
                            "config": { "pluginToolsMcpBridge": true }
                        }
                    }
                },
                "env": {
                    "UNIOPC_SOCIALS_API_URL": "https://example.test/functions/v1/socials"
                }
            }
        });

        let result = tool_capabilities_from_config(
            "imai".to_string(),
            &snapshot,
            &[(
                plugin_definition(UNIOPC_SOCIALS_PLUGIN_ID).expect("definition"),
                plugin_dir,
            )],
        );

        assert_eq!(result.plugins[0].status, "missing_env");
        assert!(result.plugins[0]
            .readiness_reasons
            .contains(&"missing_env:UNIOPC_SOCIALS_HOST_CREDENTIAL".to_string()));
        assert!(result.plugins[0].tools.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cloud_agent_plugin_enable_syncs_gateway_service_env_only_when_auth_env_changes() {
        let mut matching_env = Map::new();
        matching_env.insert(
            "UNIOPC_SOCIALS_API_URL".to_string(),
            json!("https://example.test/functions/v1/socials"),
        );
        matching_env.insert(
            "UNIOPC_SOCIALS_HOST_CREDENTIAL".to_string(),
            json!("imai_hc_socials"),
        );
        let mut missing_env = Map::new();
        missing_env.insert(
            "UNIOPC_SOCIALS_API_URL".to_string(),
            json!("https://example.test/functions/v1/socials"),
        );
        assert!(should_sync_gateway_service_env_after_plugin_patch(
            &plugin_definition(UNIOPC_SOCIALS_PLUGIN_ID).expect("known plugin"),
            true,
            &missing_env,
            Some("https://example.test/functions/v1/socials"),
            Some("imai_hc_socials"),
        ));
        assert!(should_sync_gateway_service_env_after_plugin_patch(
            &plugin_definition("uniopc-private-conversion").expect("known plugin"),
            true,
            &Map::new(),
            Some("https://example.test/functions/v1/private-conversion"),
            Some("private_hc"),
        ));
        assert!(!should_sync_gateway_service_env_after_plugin_patch(
            &plugin_definition(UNIOPC_SOCIALS_PLUGIN_ID).expect("known plugin"),
            true,
            &matching_env,
            Some("https://example.test/functions/v1/socials"),
            Some("imai_hc_socials"),
        ));
        assert!(!should_sync_gateway_service_env_after_plugin_patch(
            &plugin_definition(UNIOPC_SOCIALS_PLUGIN_ID).expect("known plugin"),
            false,
            &Map::new(),
            Some("https://example.test/functions/v1/socials"),
            Some("imai_hc_socials"),
        ));
        assert!(!should_sync_gateway_service_env_after_plugin_patch(
            &ProfilePluginDefinition::from_static("imai-short-drama-core", "", "", &[]),
            true,
            &Map::new(),
            None,
            None,
        ));
        assert!(!should_sync_gateway_service_env_after_plugin_patch(
            &ProfilePluginDefinition::from_static("imai-media-generation", "", "", &[]),
            true,
            &Map::new(),
            None,
            None,
        ));
    }

    #[test]
    fn injects_cloud_agent_auth_into_plugin_private_config() {
        let snapshot = json!({
            "parsed": {
                "env": {
                    "EXISTING": "keep"
                },
                "plugins": {
                    "load": { "paths": [] },
                    "entries": {}
                }
            }
        });
        let mut patch = build_plugin_toggle_patch(&snapshot, UNIOPC_SOCIALS_PLUGIN_ID, true)
            .expect("patch should build");

        inject_cloud_workspace_auth_env(
            &mut patch,
            UNIOPC_SOCIALS_PLUGIN_ID,
            env_from_snapshot(&snapshot),
            &plugin_definition(UNIOPC_SOCIALS_PLUGIN_ID).expect("known plugin"),
            Some("https://example.test/functions/v1/socials".to_string()),
            Some("imai_hc_token".to_string()),
        )
        .expect("auth env should inject");

        assert_eq!(
            patch["plugins"]["entries"][UNIOPC_SOCIALS_PLUGIN_ID]["config"]["env"]
                ["UNIOPC_SOCIALS_API_URL"],
            "https://example.test/functions/v1/socials"
        );
        assert_eq!(
            patch["plugins"]["entries"][UNIOPC_SOCIALS_PLUGIN_ID]["config"]["env"]
                ["UNIOPC_SOCIALS_HOST_CREDENTIAL"],
            "imai_hc_token"
        );
        assert!(patch.get("env").is_none());
    }

    #[test]
    fn legacy_root_plugin_credentials_are_removed_before_openclaw_81_starts() {
        let snapshot = json!({
            "env": {
                "UNIOPC_MONTAGE_API_URL": "https://example.test/functions/v1/montage",
                "UNIOPC_MONTAGE_HOST_CREDENTIAL": "hc_secret",
                "OTHER_ALLOWED_VALUE": "keep"
            }
        });

        let patch = legacy_root_plugin_env_cleanup_patch(&snapshot)
            .expect("legacy Uniopc credentials need a cleanup patch");

        assert!(patch["env"]["UNIOPC_MONTAGE_API_URL"].is_null());
        assert!(patch["env"]["UNIOPC_MONTAGE_HOST_CREDENTIAL"].is_null());
        assert!(patch["env"].get("OTHER_ALLOWED_VALUE").is_none());
    }

    #[test]
    fn gateway_inherits_only_enabled_plugin_private_environment() {
        let config = json!({
            "plugins": {
                "entries": {
                    "uniopc-socials": {
                        "enabled": true,
                        "config": { "env": {
                            "UNIOPC_SOCIALS_API_URL": "https://example.test/socials",
                            "UNIOPC_SOCIALS_HOST_CREDENTIAL": "hc_secret"
                        }}
                    },
                    "disabled-plugin": {
                        "enabled": false,
                        "config": { "env": { "DISABLED_SECRET": "do-not-pass" } }
                    }
                }
            },
            "env": { "UNIOPC_SOCIALS_API_URL": "legacy-root-value" }
        });

        assert_eq!(
            gateway_plugin_private_env_from_config(&config),
            vec![
                (
                    "UNIOPC_SOCIALS_API_URL".to_string(),
                    "https://example.test/socials".to_string()
                ),
                (
                    "UNIOPC_SOCIALS_HOST_CREDENTIAL".to_string(),
                    "hc_secret".to_string()
                ),
            ]
        );
    }

    #[test]
    fn injects_plugin_scoped_cloud_agent_host_credentials() {
        let snapshot = json!({
            "parsed": {
                "env": {
                    "UNIOPC_CLOUD_WORKSPACE_HOST_CREDENTIAL": "workspace_hc"
                },
                "plugins": {
                    "load": { "paths": [] },
                    "entries": {}
                }
            }
        });
        let mut patch =
            build_plugin_toggle_patch(&snapshot, UNIOPC_PRIVATE_CONVERSION_PLUGIN_ID, true)
                .expect("patch should build");

        inject_cloud_workspace_auth_env(
            &mut patch,
            UNIOPC_PRIVATE_CONVERSION_PLUGIN_ID,
            env_from_snapshot(&snapshot),
            &plugin_definition(UNIOPC_PRIVATE_CONVERSION_PLUGIN_ID).expect("known plugin"),
            Some("https://example.test/functions/v1/private-conversion".to_string()),
            Some("private_hc".to_string()),
        )
        .expect("auth env should inject");

        assert_eq!(
            patch["plugins"]["entries"][UNIOPC_PRIVATE_CONVERSION_PLUGIN_ID]["config"]["env"]
                ["UNIOPC_PRIVATE_CONVERSION_HOST_CREDENTIAL"],
            "private_hc"
        );
        assert!(patch.get("env").is_none());
    }

    #[test]
    fn runtime_inspect_tools_ignore_manifest_only_contracts() {
        let inspect = json!({
            "manifest": {
                "contracts": {
                    "tools": [
                        { "name": "manifest_only_tool" }
                    ]
                }
            },
            "runtime": {
                "tools": [
                    { "name": "imai_cloud_document_create" },
                    { "name": "imai_cloud_task_update_status" }
                ]
            }
        });

        assert_eq!(
            runtime_inspect_tool_names(&inspect),
            vec![
                "imai_cloud_document_create".to_string(),
                "imai_cloud_task_update_status".to_string(),
            ]
        );
    }

    #[test]
    fn runtime_inspect_tools_parse_official_top_level_names_array() {
        let inspect = json!({
            "plugin": {
                "id": "uniopc-cloud-workspace",
                "contracts": {
                    "tools": [
                        "imai_cloud_document_create"
                    ]
                }
            },
            "tools": [
                {
                    "names": [
                        "imai_cloud_context_get"
                    ],
                    "optional": false
                },
                {
                    "names": [
                        "imai_cloud_document_create"
                    ],
                    "optional": false
                }
            ]
        });

        assert_eq!(
            runtime_inspect_tool_names(&inspect),
            vec![
                "imai_cloud_context_get".to_string(),
                "imai_cloud_document_create".to_string(),
            ]
        );
    }

    #[test]
    fn runtime_verification_blocks_ready_plugin_when_registered_tools_are_missing() {
        let mut plugin = OpenClawProfileToolCapabilityPlugin {
            id: IMAI_CLOUD_WORKSPACE_PLUGIN_ID.to_string(),
            title: "云端工作区".to_string(),
            description: "desc".to_string(),
            official: true,
            enabled: true,
            installed: true,
            status: "ready".to_string(),
            business_health_state: String::new(),
            business_health_label: String::new(),
            readiness_reasons: Vec::new(),
            tools: vec![OpenClawProfileToolCapability {
                name: "imai_cloud_document_create".to_string(),
                title: "Create document".to_string(),
                description: String::new(),
                input_schema: json!({}),
            }],
            has_skills: false,
            skill_names: Vec::new(),
        };

        apply_runtime_tool_verification(&mut plugin, &[]);

        assert_eq!(plugin.status, "runtime_missing");
        assert_eq!(plugin.readiness_reasons, vec!["runtime_missing_tools"]);
        assert!(plugin.tools.is_empty());
    }

    #[test]
    fn plugin_capability_notes_upsert_replaces_managed_block_and_preserves_user_content() {
        let block =
            format!("{PLUGIN_CAPABILITY_NOTES_START}\nv2 内容\n{PLUGIN_CAPABILITY_NOTES_END}");

        let fresh = upsert_plugin_capability_notes("", &block);
        assert_eq!(fresh, format!("{block}\n"));

        let with_user_notes =
            upsert_plugin_capability_notes("# TOOLS.md\n\n用户自己的备注", &block);
        assert!(with_user_notes.starts_with("# TOOLS.md\n\n用户自己的备注"));
        assert!(with_user_notes.contains("v2 内容"));

        let replaced = upsert_plugin_capability_notes(
            &with_user_notes,
            &format!("{PLUGIN_CAPABILITY_NOTES_START}\nv3 内容\n{PLUGIN_CAPABILITY_NOTES_END}"),
        );
        assert!(replaced.contains("v3 内容"));
        assert!(!replaced.contains("v2 内容"));
        assert!(replaced.starts_with("# TOOLS.md\n\n用户自己的备注"));
        assert_eq!(replaced.matches(PLUGIN_CAPABILITY_NOTES_START).count(), 1);
    }

    #[test]
    fn agent_ids_from_config_snapshot_includes_main_fallback() {
        let ids = agent_ids_from_config_snapshot(&json!({
            "agents": { "list": [ { "id": "elon" }, { "id": "employee-1" } ] }
        }));
        assert_eq!(ids, vec!["elon", "employee-1", "main"]);

        let with_main = agent_ids_from_config_snapshot(&json!({
            "agents": { "list": [ { "id": "main" }, { "id": "luna" } ] }
        }));
        assert_eq!(with_main, vec!["main", "luna"]);
    }

    #[test]
    fn runtime_verification_keeps_skill_pack_plugin_ready_without_tools() {
        // Skill-pack plugins declare no tool contract; an empty runtime tool
        // list is their healthy state and must not become runtime_missing.
        let mut plugin = OpenClawProfileToolCapabilityPlugin {
            id: UNIOPC_DOCUMENTS_PLUGIN_ID.to_string(),
            title: "文档处理".to_string(),
            description: "desc".to_string(),
            official: true,
            enabled: true,
            installed: true,
            status: "ready".to_string(),
            business_health_state: String::new(),
            business_health_label: String::new(),
            readiness_reasons: Vec::new(),
            tools: Vec::new(),
            has_skills: true,
            skill_names: Vec::new(),
        };

        apply_runtime_tool_verification(&mut plugin, &[]);

        assert_eq!(plugin.status, "ready");
        assert!(plugin.readiness_reasons.is_empty());
    }

    #[test]
    fn cli_json_parse_tolerates_stderr_noise_around_payload() {
        // The CLI bridge concatenates stdout and stderr, and the engine logs
        // "[channels] …" warnings to stderr — the JSON payload must still parse.
        let noisy = "[channels] failed to load bundled channel setup entry imessage: missing generated module\n[{\"plugin\":{\"id\":\"uniopc-documents\"},\"tools\":[]}]\n[channels] failed to load bundled channel setup entry telegram: missing generated module";
        let value = parse_cli_json_lenient(noisy).expect("payload should parse");
        assert_eq!(
            value[0]["plugin"]["id"],
            Value::String("uniopc-documents".to_string())
        );
        assert!(parse_cli_json_lenient("no json here").is_none());
    }

    #[test]
    fn unverifiable_runtime_probe_clears_capabilities_and_fails_closed() {
        // A manifest/config entry is not runtime evidence. When the inspect
        // probe cannot complete, keep the diagnostic but remove the capability
        // from the conversation menu until a later refresh verifies it.
        let mut plugin = OpenClawProfileToolCapabilityPlugin {
            id: IMAI_CLOUD_WORKSPACE_PLUGIN_ID.to_string(),
            title: "云端工作区".to_string(),
            description: "desc".to_string(),
            official: true,
            enabled: true,
            installed: true,
            status: "ready".to_string(),
            business_health_state: String::new(),
            business_health_label: String::new(),
            readiness_reasons: Vec::new(),
            tools: vec![OpenClawProfileToolCapability {
                name: "imai_cloud_document_create".to_string(),
                title: "Create document".to_string(),
                description: String::new(),
                input_schema: json!({}),
            }],
            has_skills: false,
            skill_names: Vec::new(),
        };

        mark_runtime_inspect_unverified(&mut plugin);

        assert_eq!(plugin.status, "runtime_unverified");
        assert_eq!(plugin.readiness_reasons, vec!["runtime_inspect_unverified"]);
        assert!(plugin.tools.is_empty());
    }

    #[test]
    fn plugin_doctor_reports_runtime_capability_blocks() {
        let mut report = OpenClawProfilePluginDoctorReport {
            profile: "owner-profile".to_string(),
            policy_version: 1,
            status: "ok".to_string(),
            plugins: Vec::new(),
            snapshot: OpenClawProfilePluginsSnapshot {
                profile: "owner-profile".to_string(),
                plugins: Vec::new(),
            },
            capabilities: None,
        };
        let capabilities = OpenClawProfileToolCapabilitiesSnapshot {
            profile: "owner-profile".to_string(),
            gateway_supports_tool_constraints: false,
            plugins: vec![OpenClawProfileToolCapabilityPlugin {
                id: UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID.to_string(),
                title: "本地工作区".to_string(),
                description: String::new(),
                official: true,
                enabled: true,
                installed: true,
                status: "runtime_missing".to_string(),
                business_health_state: String::new(),
                business_health_label: String::new(),
                readiness_reasons: vec!["runtime_missing_tools".to_string()],
                tools: Vec::new(),
                has_skills: false,
                skill_names: Vec::new(),
            }],
        };
        let policy = vec![ProfilePluginPolicyInput {
            plugin_id: UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID.to_string(),
            status: "active".to_string(),
            is_global: true,
        }];

        append_runtime_capability_doctor_items(&mut report, &capabilities, &policy);

        assert_eq!(report.status, "blocked");
        assert_eq!(
            report.plugins[0].plugin_id,
            UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID
        );
        assert_eq!(report.plugins[0].actual, "runtime_missing");
        assert_eq!(report.plugins[0].repairable, false);
    }

    #[test]
    fn supported_plugin_records_include_canonical_local_workspace_contract() {
        let records = supported_plugin_records_for_paths(vec![(
            plugin_definitions()
                .into_iter()
                .find(|definition| definition.id == UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID)
                .unwrap(),
            PathBuf::from("/app/plugins/uniopc-local-workspace"),
        )]);
        let workspace = records
            .iter()
            .find(|record| record.id == UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID)
            .unwrap();

        assert_eq!(workspace.aliases, Vec::<String>::new());
        assert!(workspace.required_env.is_empty());
        assert_eq!(workspace.supports_start, true);
        assert_eq!(workspace.supports_stop, true);
        assert_eq!(workspace.supports_restart, true);
        assert_eq!(workspace.supports_repair, true);
        assert_eq!(workspace.supports_credential_issue, false);
        assert_eq!(
            workspace.plugin_path,
            "/app/plugins/uniopc-local-workspace".to_string()
        );
    }

    #[test]
    fn local_workspace_replaces_cloud_documents_as_the_required_foundation() {
        let local = plugin_definition(UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID).expect("definition");
        assert_eq!(local.title, "本地工作区");
        assert!(local.required_env.is_empty());
        assert!(!definition_requires_cloud_agent_auth(&local));

        let desired = plugin_policy_desired_state(&[ProfilePluginPolicyInput {
            plugin_id: IMAI_CLOUD_WORKSPACE_PLUGIN_ID.to_string(),
            status: "active".to_string(),
            is_global: true,
        }]);
        assert_eq!(desired.get(UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID), Some(&true));
        assert_eq!(desired.get(IMAI_CLOUD_WORKSPACE_PLUGIN_ID), None);
    }

    #[test]
    fn supported_plugin_records_include_private_conversion_runtime_contract() {
        let records = supported_plugin_records_for_paths(vec![(
            plugin_definition("uniopc-private-conversion").expect("definition"),
            PathBuf::from("/app/plugins/uniopc-private-conversion"),
        )]);
        let private_conversion = records
            .iter()
            .find(|record| record.id == "uniopc-private-conversion")
            .unwrap();

        assert_eq!(
            private_conversion.aliases,
            vec!["uniopc-private-conversion"]
        );
        assert_eq!(
            private_conversion.required_env,
            vec![
                "UNIOPC_PRIVATE_CONVERSION_API_URL",
                "UNIOPC_PRIVATE_CONVERSION_HOST_CREDENTIAL"
            ]
        );
        assert_eq!(private_conversion.supports_credential_issue, true);
        assert_eq!(
            private_conversion.plugin_path,
            "/app/plugins/uniopc-private-conversion".to_string()
        );
    }

    #[test]
    fn plugin_product_layer_reads_manifest_i18n_recommend_and_skills() {
        let dir =
            std::env::temp_dir().join(format!("uniopc-product-layer-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("resources")).unwrap();
        std::fs::create_dir_all(dir.join("skills/demo-skill")).unwrap();

        std::fs::write(
            dir.join("plugin.json"),
            r#"{"name":"demo","displayName":"Demo","description":"Demo plugin.","icon":"resources/icon.svg","category":"productivity-knowledge","tags":["a","b"]}"#,
        )
        .unwrap();
        std::fs::write(dir.join("resources/icon.svg"), "<svg/>").unwrap();
        std::fs::write(
            dir.join("resources/i18n.json"),
            r#"{"version":"1.0","defaultLocale":"en","entries":{"plugin.displayName":{"zh":"演示"},"plugin.description":{"zh":"演示描述"}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("resources/recommend.json"),
            r#"[{"id":"s1","title":"T","sectionTitle":"标题","prompts":[{"id":"p1","type":"text","text":"试试","skillId":"demo-skill"}]}]"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("skills/demo-skill/SKILL.md"),
            "---\nname: demo-skill\ndisplayName: Demo Skill\ndescription: \"Does demo things.\"\n---\n\n# Demo\n",
        )
        .unwrap();

        std::fs::create_dir_all(dir.join("connectors")).unwrap();
        std::fs::write(
            dir.join("connectors/connectors.json"),
            r#"{"connectors":{"demo":{"name":"Demo SaaS","authType":"api-key","customDescription":"Get a key from the dashboard","getLinkUrl":"https://example.com/keys","fields":[{"key":"api_key","label":"API Key","type":"password","placeholder":"sk-...","required":true}],"env":{"api_key":"DEMO_API_KEY"}}}}"#,
        )
        .unwrap();

        let product =
            plugin_product_layer_with_env(&dir, &Map::new()).expect("product layer should parse");
        assert_eq!(product.display_name, "演示");
        assert_eq!(product.description, "演示描述");
        assert_eq!(product.icon_svg, "<svg/>");
        assert_eq!(product.category, "productivity-knowledge");
        assert_eq!(product.tags, vec!["a", "b"]);
        assert_eq!(product.recommend.len(), 1);
        assert_eq!(product.recommend[0].section_title, "标题");
        assert_eq!(product.recommend[0].prompts[0].skill_id, "demo-skill");
        assert_eq!(product.skills.len(), 1);
        assert_eq!(product.skills[0].id, "demo-skill");
        assert_eq!(product.skills[0].display_name, "Demo Skill");
        assert_eq!(product.skills[0].description, "Does demo things.");
        assert_eq!(product.connectors.len(), 1);
        assert_eq!(product.connectors[0].id, "demo");
        assert_eq!(product.connectors[0].auth_type, "api-key");
        // 未显式声明 blocking 时默认阻塞制；canSkipBlocking 缺省 false。
        assert!(product.connectors[0].blocking);
        assert!(!product.connectors[0].can_skip_blocking);
        // 未显式声明 visibility 时默认 private；规范格式来源标 canonical。
        assert_eq!(product.connectors[0].visibility, "private");
        assert_eq!(product.connectors[0].provider, "canonical");
        assert_eq!(product.connectors[0].fields[0].field_type, "password");
        assert_eq!(
            product.connectors[0].env.get("api_key").map(String::as_str),
            Some("DEMO_API_KEY")
        );

        // Native-manifest-only directories yield no product layer.
        let empty =
            std::env::temp_dir().join(format!("uniopc-product-layer-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&empty);
        std::fs::create_dir_all(&empty).unwrap();
        assert!(plugin_product_layer_with_env(&empty, &Map::new()).is_none());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn api_key_connector_state_is_redacted_and_tracks_required_env() {
        let dir = std::env::temp_dir().join(format!(
            "uniopc-product-layer-credentials-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(dir.join("connectors")).unwrap();
        std::fs::write(
            dir.join("plugin.json"),
            r#"{"name":"demo","displayName":"Demo","description":"Demo plugin."}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("connectors/connectors.json"),
            r#"{"connectors":{"demo":{"name":"Demo SaaS","authType":"api-key","fields":[{"key":"api_key","label":"API Key","type":"password","required":true},{"key":"region","label":"Region","type":"text","required":true}],"env":{"api_key":"DEMO_API_KEY","region":"DEMO_REGION"}}}}"#,
        )
        .unwrap();

        let env = Map::from_iter([(
            "DEMO_API_KEY".to_string(),
            Value::String("private-value".to_string()),
        )]);
        let product =
            plugin_product_layer_with_env(&dir, &env).expect("product layer should parse");
        let connector = &product.connectors[0];

        assert_eq!(connector.credential_state, "partially_configured");
        assert_eq!(connector.missing_fields, vec!["region"]);
        assert!(!serde_json::to_string(&product)
            .unwrap()
            .contains("private-value"));

        let configured_env = Map::from_iter([
            (
                "DEMO_API_KEY".to_string(),
                Value::String("private-value".to_string()),
            ),
            ("DEMO_REGION".to_string(), Value::String("cn".to_string())),
        ]);
        let configured = plugin_product_layer_with_env(&dir, &configured_env)
            .expect("product layer should parse");
        assert_eq!(configured.connectors[0].credential_state, "configured");
        assert!(configured.connectors[0].missing_fields.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blank_api_key_updates_preserve_plugin_private_credentials() {
        let mut patch = json!({
            "plugins": {
                "entries": {
                    "demo-plugin": { "config": { "env": { "UNRELATED": "keep" } } }
                }
            }
        });
        let existing = Map::from_iter([
            (
                "DEMO_API_KEY".to_string(),
                Value::String("private-value".to_string()),
            ),
            ("DEMO_REGION".to_string(), Value::String("us".to_string())),
        ]);
        let updates = HashMap::from([
            ("DEMO_API_KEY".to_string(), "   ".to_string()),
            ("DEMO_REGION".to_string(), "cn".to_string()),
        ]);

        inject_plugin_env(&mut patch, "demo-plugin", existing, &updates);

        let env = &patch["plugins"]["entries"]["demo-plugin"]["config"]["env"];
        assert_eq!(env["DEMO_API_KEY"], "private-value");
        assert_eq!(env["DEMO_REGION"], "cn");
        assert_eq!(env["UNRELATED"], "keep");
    }

    #[test]
    fn skill_frontmatter_tolerates_glued_terminator() {
        // Upstream Shopify skill packs close the frontmatter on the last
        // key line: `version: "1.11.0"---` with no standalone `---`.
        let raw = "---\nname: shopify-admin\ndescription: \"Admin GraphQL helper\"\nmetadata:\n  author: Shopify\n  version: \"1.11.0\"---\n\n# Body\n\nname: should-not-leak\n";
        let front = skill_frontmatter(raw);
        assert_eq!(front.get("name").map(String::as_str), Some("shopify-admin"));
        assert_eq!(front.get("version").map(String::as_str), Some("1.11.0"));
        // Parsing must stop at the glued terminator — the body's
        // `name: should-not-leak` line must not overwrite the frontmatter.
        assert_eq!(front.get("name").map(String::as_str), Some("shopify-admin"));

        // Canonical form keeps working.
        let canonical = "---\nname: demo\ndisplayName: Demo\n---\nbody\n";
        let front = skill_frontmatter(canonical);
        assert_eq!(front.get("displayName").map(String::as_str), Some("Demo"));
    }

    #[test]
    fn plugin_product_layer_folds_legacy_accio_oauth_connectors() {
        let dir =
            std::env::temp_dir().join(format!("uniopc-product-layer-accio-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("connectors")).unwrap();

        std::fs::write(
            dir.join("plugin.json"),
            r#"{"name":"legacy","displayName":"Legacy","description":"Ported plugin.","category":"ecommerce"}"#,
        )
        .unwrap();
        // Accio 格式：顶层 mcpServers + oauth（无 Uniopc 的 `connectors` 键）。
        std::fs::write(
            dir.join("connectors/connectors.json"),
            r#"{"mcpServers":{},"oauth":{"shopify":{"visibility":"private","blocking":false,"canSkipBlocking":true},"twitter":{"visibility":"public","blocking":false}}}"#,
        )
        .unwrap();

        let product =
            plugin_product_layer_with_env(&dir, &Map::new()).expect("product layer should parse");
        assert_eq!(product.connectors.len(), 2);
        // 排序后 shopify 在 twitter 之前。
        let shopify = &product.connectors[0];
        assert_eq!(shopify.id, "shopify");
        assert_eq!(shopify.name, "Shopify");
        assert_eq!(shopify.auth_type, "oauth2");
        assert_eq!(shopify.provider, "accio-oauth");
        assert_eq!(shopify.visibility, "private");
        // legacy 路径尊重条目显式 blocking，不套阻塞制默认；canSkipBlocking 透传。
        assert!(!shopify.blocking);
        assert!(shopify.can_skip_blocking);
        assert!(shopify.fields.is_empty());
        assert!(shopify.env.is_empty());

        let twitter = &product.connectors[1];
        assert_eq!(twitter.id, "twitter");
        assert_eq!(twitter.visibility, "public");
        assert!(!twitter.can_skip_blocking);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
