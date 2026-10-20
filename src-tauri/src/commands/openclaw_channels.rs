use crate::{
    commands::model::{openclaw_status, OpenClawStatus},
    services::{openclaw_cli, openclaw_gateway},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::time::{sleep, Duration};

/// Engine-side pairing requests expire after this window (PAIRING_PENDING_TTL_MS
/// in the runtime's pairing store). We read the store files directly — the
/// engine only prunes them when it touches the file — so expired entries must
/// be filtered here too or the UI shows codes that can no longer be approved.
const PAIRING_PENDING_TTL_MS: i64 = 3600 * 1000;

/// The channels the desktop UI surfaces today. Pairing files are per-channel.
const PAIRING_CHANNEL_IDS: [&str; 2] = ["feishu", "openclaw-weixin"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawFeishuSupport {
    pub chat_types: Vec<String>,
    pub threads: bool,
    pub media: bool,
    pub reactions: bool,
    pub edit: bool,
    pub reply: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawFeishuBinding {
    pub agent_id: String,
    pub account_id: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawFeishuAccount {
    pub account_id: String,
    pub is_default: bool,
    pub configured: bool,
    pub enabled: bool,
    pub domain: String,
    pub app_id: Option<String>,
    pub has_app_secret: bool,
    pub current_agent_id: Option<String>,
    pub dm_policy: Option<String>,
    pub group_policy: Option<String>,
    pub actions: Vec<String>,
    pub support: OpenClawFeishuSupport,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawFeishuOverview {
    pub openclaw: OpenClawStatus,
    pub plugin_enabled: bool,
    pub plugin_status: String,
    pub supported: bool,
    pub accounts: Vec<OpenClawFeishuAccount>,
    pub bindings: Vec<OpenClawFeishuBinding>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawWeChatSupport {
    pub chat_types: Vec<String>,
    pub threads: bool,
    pub media: bool,
    pub reactions: bool,
    pub edit: bool,
    pub reply: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawWeChatBinding {
    pub agent_id: String,
    pub account_id: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawWeChatAccount {
    pub account_id: String,
    pub is_default: bool,
    pub configured: bool,
    pub enabled: bool,
    pub current_agent_id: Option<String>,
    pub dm_policy: Option<String>,
    pub group_policy: Option<String>,
    pub actions: Vec<String>,
    pub support: OpenClawWeChatSupport,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawWeChatOverview {
    pub openclaw: OpenClawStatus,
    pub plugin_installed: bool,
    pub plugin_enabled: bool,
    pub plugin_status: String,
    pub supported: bool,
    pub accounts: Vec<OpenClawWeChatAccount>,
    pub bindings: Vec<OpenClawWeChatBinding>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawWeChatQrStartResult {
    pub account_id: String,
    pub session_key: String,
    pub qr_data_url: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawWeChatQrWaitResult {
    pub account_id: String,
    pub session_key: String,
    pub connected: bool,
    pub qr_data_url: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawChannelActionResult {
    pub ok: bool,
    pub message: String,
    pub output: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFeishuAccountRequest {
    pub account_id: Option<String>,
    pub app_id: String,
    pub app_secret: Option<String>,
    pub domain: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindChannelEmployeeRequest {
    pub channel_id: String,
    pub account_id: Option<String>,
    pub employee_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawWeChatQrStartRequest {
    pub account_id: Option<String>,
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawWeChatQrWaitRequest {
    pub account_id: Option<String>,
    pub timeout_ms: Option<u64>,
}

fn gateway_call_error_is_retryable(error: &str) -> bool {
    let lowered = error.to_lowercase();
    lowered.contains("gateway closed")
        || lowered.contains("gateway timeout")
        || lowered.contains("connection refused")
        || lowered.contains("abnormal closure")
}

fn humanize_wechat_qr_error(error: String) -> String {
    let lowered = error.to_lowercase();
    if lowered.contains("web login provider is not available") {
        return "当前 Uniopc 引擎 网关没有启用微信二维码登录提供器，所以 Uniopc 暂时拿不到可展示的二维码。你可以先去运行中心检查 Uniopc 引擎 / 微信插件状态，或者先用终端方式完成一次登录。".to_string();
    }
    error
}

fn gateway_call_error_is_wechat_provider_warming(error: &str) -> bool {
    let lowered = error.to_lowercase();
    lowered.contains("web login provider is not available")
        || lowered.contains("没有启用微信二维码登录提供器")
}

async fn run_openclaw_gateway_call_json(
    _app: &AppHandle,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match openclaw_gateway::call_json(None, method, params.clone(), false).await {
        Ok(value) => Ok(value),
        Err(error) if gateway_call_error_is_retryable(&error) => {
            sleep(Duration::from_millis(1200)).await;
            openclaw_gateway::call_json(None, method, params, false).await.map_err(|retry_error| {
                format!(
                    "Uniopc 引擎 当前不可用，无法发起二维码登录。请先检查运行中心里的 Uniopc 引擎 状态。\n原始错误：{retry_error}"
                )
            })
        }
        Err(error) => Err(humanize_wechat_qr_error(error)),
    }
}

fn ensure_json_object_child<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    let needs_object = object.get(key).and_then(Value::as_object).is_none();
    if needs_object {
        object.insert(key.to_string(), Value::Object(Map::new()));
    }
    object
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("Uniopc 引擎 配置字段 {key} 格式无效。"))
}

async fn load_gateway_config() -> Result<Value, String> {
    let value = openclaw_gateway::config_get(None).await?;
    Ok(value
        .get("config")
        .cloned()
        .or_else(|| value.get("value").cloned())
        .unwrap_or(value))
}

async fn load_gateway_channel_status(probe: bool) -> Result<Value, String> {
    openclaw_gateway::channels_status(None, probe).await
}

async fn load_gateway_agent_bindings() -> Result<Value, String> {
    // The bundled engine (2026.6.11) has no `agents.bindings` RPC — channel→agent
    // bindings live in the config's top-level `bindings[]` array (see the engine's
    // channel-routing docs). Read them from config; calling the old RPC fails with
    // "unknown method" and used to silently blank the whole channel overview.
    let config = load_gateway_config().await?;
    Ok(config
        .get("bindings")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new())))
}

fn binding_entry_matches(item: &Value, agent_id: &str, channel_id: &str, account_id: &str) -> bool {
    let match_value = item.get("match");
    let channel = match_value
        .and_then(|value| value.get("channel"))
        .and_then(Value::as_str);
    let account = match_value
        .and_then(|value| value.get("accountId"))
        .and_then(Value::as_str)
        .unwrap_or("default");
    let agent = item.get("agentId").and_then(Value::as_str);
    channel == Some(channel_id) && account == account_id && agent == Some(agent_id)
}

/// Rewrite the config `bindings[]` array: drop this agent's entry for the
/// channel account, and re-append it when binding. Pure so it is testable.
fn rewrite_agent_bindings(
    mut bindings: Vec<Value>,
    agent_id: &str,
    channel_id: &str,
    account_id: &str,
    bind: bool,
) -> Vec<Value> {
    bindings.retain(|item| !binding_entry_matches(item, agent_id, channel_id, account_id));
    if bind {
        bindings.push(json!({
            "agentId": agent_id,
            "match": { "channel": channel_id, "accountId": account_id }
        }));
    }
    bindings
}

async fn set_gateway_agent_binding(
    agent_id: &str,
    channel_id: &str,
    account_id: &str,
    bind: bool,
) -> Result<Value, String> {
    // Same engine constraint as above: no agents.bind/agents.unbind RPC —
    // bind/unbind is a config edit on the top-level `bindings[]` array.
    let mut config = load_gateway_config().await?;
    let root = config
        .as_object_mut()
        .ok_or_else(|| "Uniopc 引擎 配置格式无效。".to_string())?;
    let bindings = root
        .get("bindings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let next = rewrite_agent_bindings(bindings, agent_id, channel_id, account_id, bind);
    root.insert("bindings".to_string(), Value::Array(next));
    // Unbinding shrinks the bindings array — the engine requires replacePaths
    // to confirm intentional array-entry removal.
    openclaw_gateway::config_patch_replacing(None, config, &["bindings"]).await
}

fn normalize_account_id(value: Option<&str>) -> String {
    let normalized = value.unwrap_or("default").trim();
    if normalized.is_empty() {
        "default".to_string()
    } else {
        normalized.to_string()
    }
}

fn has_configured_secret(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Object(_)) => true,
        _ => false,
    }
}

fn value_as_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

/// Read a policy key (dmPolicy / groupPolicy) with account-level config taking
/// precedence over the channel root, mirroring how the engine resolves it.
fn channel_policy_value(
    channel_cfg: Option<&Map<String, Value>>,
    account_cfg: Option<&Map<String, Value>>,
    key: &str,
) -> Option<String> {
    value_as_string(account_cfg.and_then(|value| value.get(key)))
        .or_else(|| value_as_string(channel_cfg.and_then(|value| value.get(key))))
}

fn channel_config_section<'a>(config: &'a Value, channel_id: &str) -> Option<&'a Map<String, Value>> {
    config
        .as_object()
        .and_then(|value| value.get("channels"))
        .and_then(Value::as_object)
        .and_then(|value| value.get(channel_id))
        .and_then(Value::as_object)
}

fn parse_channel_support(value: Option<&Value>) -> OpenClawWeChatSupport {
    let support_value = value.and_then(Value::as_object);
    OpenClawWeChatSupport {
        chat_types: support_value
            .and_then(|item| item.get("chatTypes"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        threads: support_value
            .and_then(|item| item.get("threads"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        media: support_value
            .and_then(|item| item.get("media"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        reactions: support_value
            .and_then(|item| item.get("reactions"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        edit: support_value
            .and_then(|item| item.get("edit"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        reply: support_value
            .and_then(|item| item.get("reply"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn empty_wechat_support() -> OpenClawWeChatSupport {
    OpenClawWeChatSupport {
        chat_types: Vec::new(),
        threads: false,
        media: false,
        reactions: false,
        edit: false,
        reply: false,
    }
}

fn empty_support() -> OpenClawFeishuSupport {
    OpenClawFeishuSupport {
        chat_types: Vec::new(),
        threads: false,
        media: false,
        reactions: false,
        edit: false,
        reply: false,
    }
}

fn generic_support_to_feishu(value: OpenClawWeChatSupport) -> OpenClawFeishuSupport {
    OpenClawFeishuSupport {
        chat_types: value.chat_types,
        threads: value.threads,
        media: value.media,
        reactions: value.reactions,
        edit: value.edit,
        reply: value.reply,
    }
}

fn parse_channel_bindings(value: &Value, channel_id: &str) -> Vec<OpenClawWeChatBinding> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let match_value = item.get("match")?.as_object()?;
                    let channel = match_value.get("channel")?.as_str()?;
                    if channel != channel_id {
                        return None;
                    }
                    let account_id = match_value
                        .get("accountId")
                        .and_then(Value::as_str)
                        .unwrap_or("default")
                        .to_string();
                    Some(OpenClawWeChatBinding {
                        agent_id: item
                            .get("agentId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        account_id,
                        description: item
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or(channel_id)
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_feishu_bindings(value: &Value) -> Vec<OpenClawFeishuBinding> {
    parse_channel_bindings(value, "feishu")
        .into_iter()
        .map(|binding| OpenClawFeishuBinding {
            agent_id: binding.agent_id,
            account_id: binding.account_id,
            description: binding.description,
        })
        .collect()
}

fn parse_feishu_accounts(
    capabilities: &Value,
    config: &Value,
    bindings: &[OpenClawFeishuBinding],
) -> Vec<OpenClawFeishuAccount> {
    let capability_accounts = capabilities
        .get("channels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let root = config.as_object();
    let feishu_cfg = root
        .and_then(|value| value.get("channels"))
        .and_then(Value::as_object)
        .and_then(|value| value.get("feishu"))
        .and_then(Value::as_object);

    let default_account = feishu_cfg
        .and_then(|value| value.get("defaultAccount"))
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_string();

    let mut account_ids = capability_accounts
        .iter()
        .filter_map(|item| {
            item.get("accountId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<Vec<_>>();

    if let Some(accounts) = feishu_cfg
        .and_then(|value| value.get("accounts"))
        .and_then(Value::as_object)
    {
        for account_id in accounts.keys() {
            if !account_ids.iter().any(|item| item == account_id) {
                account_ids.push(account_id.clone());
            }
        }
    }

    if account_ids.is_empty() {
        account_ids.push("default".to_string());
    }

    account_ids.sort();
    account_ids.dedup();

    account_ids
        .into_iter()
        .map(|account_id| {
            let capability = capability_accounts.iter().find(|item| {
                item.get("accountId")
                    .and_then(Value::as_str)
                    .unwrap_or("default")
                    == account_id
            });
            let account_cfg = feishu_cfg
                .and_then(|value| value.get("accounts"))
                .and_then(Value::as_object)
                .and_then(|value| value.get(&account_id))
                .and_then(Value::as_object);

            let app_id = value_as_string(account_cfg.and_then(|value| value.get("appId")))
                .or_else(|| value_as_string(feishu_cfg.and_then(|value| value.get("appId"))));
            let has_app_secret =
                has_configured_secret(account_cfg.and_then(|value| value.get("appSecret")))
                    || has_configured_secret(feishu_cfg.and_then(|value| value.get("appSecret")));
            let domain = value_as_string(account_cfg.and_then(|value| value.get("domain")))
                .or_else(|| value_as_string(feishu_cfg.and_then(|value| value.get("domain"))))
                .unwrap_or_else(|| "feishu".to_string());

            let support = parse_channel_support(capability.and_then(|item| item.get("support")));

            let actions = capability
                .and_then(|item| item.get("actions"))
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            let current_binding = bindings
                .iter()
                .find(|binding| binding.account_id == account_id);
            let dm_policy = channel_policy_value(feishu_cfg, account_cfg, "dmPolicy");
            let group_policy = channel_policy_value(feishu_cfg, account_cfg, "groupPolicy");

            OpenClawFeishuAccount {
                account_id: account_id.clone(),
                is_default: default_account == account_id,
                configured: capability
                    .and_then(|item| item.get("configured"))
                    .and_then(Value::as_bool)
                    .unwrap_or(app_id.is_some() && has_app_secret),
                enabled: account_cfg
                    .and_then(|value| value.get("enabled"))
                    .and_then(Value::as_bool)
                    .or_else(|| {
                        capability
                            .and_then(|item| item.get("enabled"))
                            .and_then(Value::as_bool)
                    })
                    .unwrap_or(true),
                domain,
                app_id,
                has_app_secret,
                current_agent_id: current_binding.map(|binding| binding.agent_id.clone()),
                dm_policy,
                group_policy,
                actions,
                support: if support.chat_types.is_empty()
                    && !support.threads
                    && !support.media
                    && !support.reactions
                    && !support.edit
                    && !support.reply
                {
                    empty_support()
                } else {
                    generic_support_to_feishu(support)
                },
            }
        })
        .collect()
}

fn parse_wechat_accounts(
    capabilities: &Value,
    config: &Value,
    bindings: &[OpenClawWeChatBinding],
) -> Vec<OpenClawWeChatAccount> {
    let weixin_cfg = channel_config_section(config, "openclaw-weixin");
    let capability_accounts = capabilities
        .get("channels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut account_ids = capability_accounts
        .iter()
        .filter_map(|item| {
            item.get("accountId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<Vec<_>>();

    account_ids.sort();
    account_ids.dedup();

    account_ids
        .into_iter()
        .map(|account_id| {
            let capability = capability_accounts.iter().find(|item| {
                item.get("accountId")
                    .and_then(Value::as_str)
                    .unwrap_or("default")
                    == account_id
            });

            let support = parse_channel_support(capability.and_then(|item| item.get("support")));
            let actions = capability
                .and_then(|item| item.get("actions"))
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            let current_binding = bindings
                .iter()
                .find(|binding| binding.account_id == account_id);
            let account_cfg = weixin_cfg
                .and_then(|value| value.get("accounts"))
                .and_then(Value::as_object)
                .and_then(|value| value.get(&account_id))
                .and_then(Value::as_object);
            let dm_policy = channel_policy_value(weixin_cfg, account_cfg, "dmPolicy");
            let group_policy = channel_policy_value(weixin_cfg, account_cfg, "groupPolicy");

            OpenClawWeChatAccount {
                account_id: account_id.clone(),
                is_default: account_id == "default",
                configured: capability
                    .and_then(|item| item.get("configured"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                enabled: capability
                    .and_then(|item| item.get("enabled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                current_agent_id: current_binding.map(|binding| binding.agent_id.clone()),
                dm_policy,
                group_policy,
                actions,
                support: if support.chat_types.is_empty()
                    && !support.threads
                    && !support.media
                    && !support.reactions
                    && !support.edit
                    && !support.reply
                {
                    empty_wechat_support()
                } else {
                    support
                },
            }
        })
        .collect()
}

async fn load_feishu_overview(app: &AppHandle) -> Result<OpenClawFeishuOverview, String> {
    let openclaw = openclaw_status(app.clone()).await?;
    let capabilities = load_gateway_channel_status(false).await?;
    let bindings = parse_feishu_bindings(&load_gateway_agent_bindings().await?);
    let config = load_gateway_config().await?;
    let feishu_status = capabilities
        .get("channels")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("channel")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    == Some("feishu")
            })
        });
    let plugin_enabled = feishu_status
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let plugin_status = feishu_status
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .unwrap_or(if plugin_enabled {
            "enabled"
        } else {
            "disabled"
        })
        .to_string();

    Ok(OpenClawFeishuOverview {
        openclaw,
        plugin_enabled,
        plugin_status,
        supported: true,
        accounts: parse_feishu_accounts(&capabilities, &config, &bindings),
        bindings,
    })
}

async fn load_wechat_overview(app: &AppHandle) -> Result<OpenClawWeChatOverview, String> {
    let openclaw = openclaw_status(app.clone()).await?;
    let capabilities = load_gateway_channel_status(false).await?;
    let config = load_gateway_config().await?;
    let bindings = parse_channel_bindings(&load_gateway_agent_bindings().await?, "openclaw-weixin");
    let wechat_status = capabilities
        .get("channels")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("channel")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    == Some("openclaw-weixin")
            })
        });
    let plugin_installed = wechat_status.is_some();
    let plugin_enabled = wechat_status
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(plugin_installed);
    let plugin_status = wechat_status
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .unwrap_or(if plugin_installed {
            "enabled"
        } else {
            "not-installed"
        })
        .to_string();

    Ok(OpenClawWeChatOverview {
        openclaw,
        plugin_installed,
        plugin_enabled,
        plugin_status,
        supported: true,
        accounts: parse_wechat_accounts(&capabilities, &config, &bindings),
        bindings,
    })
}

fn parse_gateway_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

async fn fetch_wechat_qr_snapshot(
    app: &AppHandle,
    account_id: &str,
) -> Result<OpenClawWeChatQrStartResult, String> {
    let value = run_wechat_qr_start_gateway_call(app, account_id, false, 1000).await?;

    Ok(OpenClawWeChatQrStartResult {
        account_id: account_id.to_string(),
        session_key: parse_gateway_string(&value, "sessionKey")
            .unwrap_or_else(|| account_id.to_string()),
        qr_data_url: parse_gateway_string(&value, "qrDataUrl"),
        message: parse_gateway_string(&value, "message")
            .unwrap_or_else(|| "二维码已就绪，请使用微信扫码。".to_string()),
    })
}

async fn run_wechat_qr_start_gateway_call(
    app: &AppHandle,
    account_id: &str,
    force: bool,
    timeout_ms: u64,
) -> Result<Value, String> {
    let params = json!({
        "accountId": account_id,
        "force": force,
        "verbose": false,
        "timeoutMs": timeout_ms
    });

    let mut last_error = None;
    for _ in 0..8 {
        match run_openclaw_gateway_call_json(app, "web.login.start", params.clone()).await {
            Ok(value) => return Ok(value),
            Err(error) if gateway_call_error_is_wechat_provider_warming(&error) => {
                last_error = Some(error);
                sleep(Duration::from_millis(1200)).await;
            }
            Err(error) => return Err(error),
        }
    }

    Err(last_error
        .unwrap_or_else(|| "微信二维码登录能力还没有准备好，请稍后再试一次。".to_string()))
}

async fn run_wechat_qr_wait_gateway_call(
    app: &AppHandle,
    account_id: &str,
    timeout_ms: u64,
) -> Result<Value, String> {
    let params = json!({
        "accountId": account_id,
        "timeoutMs": timeout_ms
    });

    let mut last_error = None;
    for _ in 0..12 {
        match run_openclaw_gateway_call_json(app, "web.login.wait", params.clone()).await {
            Ok(value) => return Ok(value),
            Err(error) if gateway_call_error_is_wechat_provider_warming(&error) => {
                last_error = Some(error);
                sleep(Duration::from_millis(1500)).await;
            }
            Err(error) => return Err(error),
        }
    }

    Err(last_error.unwrap_or_else(|| "微信登录状态暂时还没有准备好，请稍后再试一次。".to_string()))
}

fn set_bool(object: &mut Map<String, Value>, key: &str, value: bool) {
    object.insert(key.to_string(), Value::Bool(value));
}

fn set_string(object: &mut Map<String, Value>, key: &str, value: &str) {
    object.insert(key.to_string(), Value::String(value.to_string()));
}

#[tauri::command]
pub async fn openclaw_feishu_overview(app: AppHandle) -> Result<OpenClawFeishuOverview, String> {
    load_feishu_overview(&app).await
}

#[tauri::command]
pub async fn openclaw_feishu_save_account(
    app: AppHandle,
    req: SaveFeishuAccountRequest,
) -> Result<OpenClawFeishuOverview, String> {
    let account_id = normalize_account_id(req.account_id.as_deref());
    let app_id = req.app_id.trim();
    if app_id.is_empty() {
        return Err("Feishu App ID 不能为空。".to_string());
    }

    let mut config = load_gateway_config().await?;
    let root = config
        .as_object_mut()
        .ok_or_else(|| "Uniopc 引擎 配置格式无效。".to_string())?;
    let channels = ensure_json_object_child(root, "channels")?;
    let feishu = ensure_json_object_child(channels, "feishu")?;
    set_bool(feishu, "enabled", true);
    set_string(feishu, "defaultAccount", &account_id);

    let accounts = ensure_json_object_child(feishu, "accounts")?;
    let account = ensure_json_object_child(accounts, &account_id)?;

    set_bool(account, "enabled", true);
    set_string(account, "appId", app_id);
    set_string(
        account,
        "domain",
        req.domain
            .as_deref()
            .filter(|value| matches!(value.trim(), "feishu" | "lark"))
            .unwrap_or("feishu"),
    );
    set_string(account, "connectionMode", "websocket");
    set_string(account, "webhookPath", "/feishu/events");
    set_string(account, "dmPolicy", "pairing");
    set_string(account, "groupPolicy", "allowlist");
    set_string(account, "reactionNotifications", "own");
    set_bool(account, "typingIndicator", true);
    set_bool(account, "resolveSenderNames", true);

    if let Some(secret) = req
        .app_secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        set_string(account, "appSecret", secret);
    } else if !has_configured_secret(account.get("appSecret")) {
        return Err("Feishu App Secret 不能为空。".to_string());
    }

    openclaw_gateway::config_patch(None, config).await?;

    load_feishu_overview(&app).await
}

#[tauri::command]
pub async fn openclaw_feishu_bind_employee(
    app: AppHandle,
    account_id: String,
    employee_id: String,
) -> Result<OpenClawFeishuOverview, String> {
    let account_id = normalize_account_id(Some(account_id.as_str()));
    let employee_id = employee_id.trim();
    if employee_id.is_empty() {
        return Err("缺少员工 ID。".to_string());
    }

    let bindings = parse_feishu_bindings(&load_gateway_agent_bindings().await?);

    for binding in bindings
        .iter()
        .filter(|binding| binding.account_id == account_id)
    {
        if binding.agent_id == employee_id {
            return load_feishu_overview(&app).await;
        }
        set_gateway_agent_binding(binding.agent_id.as_str(), "feishu", &account_id, false).await?;
    }

    let _ = set_gateway_agent_binding(employee_id, "feishu", &account_id, true).await?;

    load_feishu_overview(&app).await
}

#[tauri::command]
pub async fn openclaw_feishu_unbind_employee(
    app: AppHandle,
    account_id: String,
    employee_id: String,
) -> Result<OpenClawFeishuOverview, String> {
    let account_id = normalize_account_id(Some(account_id.as_str()));
    let employee_id = employee_id.trim();
    if employee_id.is_empty() {
        return Err("缺少员工 ID。".to_string());
    }

    let _ = set_gateway_agent_binding(employee_id, "feishu", &account_id, false).await?;

    load_feishu_overview(&app).await
}

#[tauri::command]
pub async fn openclaw_wechat_overview(app: AppHandle) -> Result<OpenClawWeChatOverview, String> {
    load_wechat_overview(&app).await
}

#[tauri::command]
pub async fn openclaw_wechat_install_plugin(
    app: AppHandle,
) -> Result<OpenClawWeChatOverview, String> {
    let _ = openclaw_gateway::call_json(
        None,
        "plugins.install",
        json!({
            "id": "@tencent-weixin/openclaw-weixin",
            "pluginId": "openclaw-weixin"
        }),
        true,
    )
    .await?;
    let _ = openclaw_gateway::config_patch(
        None,
        json!({
            "plugins": {
                "entries": {
                    "openclaw-weixin": {
                        "enabled": true
                    }
                }
            }
        }),
    )
    .await?;
    load_wechat_overview(&app).await
}

#[tauri::command]
pub async fn openclaw_wechat_qr_start(
    app: AppHandle,
    req: Option<OpenClawWeChatQrStartRequest>,
) -> Result<OpenClawWeChatQrStartResult, String> {
    let account_id =
        normalize_account_id(req.as_ref().and_then(|value| value.account_id.as_deref()));
    let force = req.as_ref().and_then(|value| value.force).unwrap_or(false);
    let value = run_wechat_qr_start_gateway_call(&app, &account_id, force, 1000).await?;

    Ok(OpenClawWeChatQrStartResult {
        account_id: account_id.clone(),
        session_key: parse_gateway_string(&value, "sessionKey").unwrap_or(account_id),
        qr_data_url: parse_gateway_string(&value, "qrDataUrl"),
        message: parse_gateway_string(&value, "message")
            .unwrap_or_else(|| "二维码已就绪，请使用微信扫码。".to_string()),
    })
}

#[tauri::command]
pub async fn openclaw_wechat_qr_wait(
    app: AppHandle,
    req: Option<OpenClawWeChatQrWaitRequest>,
) -> Result<OpenClawWeChatQrWaitResult, String> {
    let account_id =
        normalize_account_id(req.as_ref().and_then(|value| value.account_id.as_deref()));
    let timeout_ms = req
        .as_ref()
        .and_then(|value| value.timeout_ms)
        .unwrap_or(1500)
        .max(1000);
    let value = run_wechat_qr_wait_gateway_call(&app, &account_id, timeout_ms).await?;

    let connected = value
        .get("connected")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let message = parse_gateway_string(&value, "message").unwrap_or_else(|| {
        if connected {
            "微信登录成功。".to_string()
        } else {
            "正在等待微信扫码确认。".to_string()
        }
    });

    let snapshot = if connected {
        None
    } else {
        fetch_wechat_qr_snapshot(&app, &account_id).await.ok()
    };

    Ok(OpenClawWeChatQrWaitResult {
        account_id: account_id.clone(),
        session_key: snapshot
            .as_ref()
            .map(|item| item.session_key.clone())
            .unwrap_or_else(|| account_id.clone()),
        connected,
        qr_data_url: snapshot.and_then(|item| item.qr_data_url),
        message,
    })
}

#[tauri::command]
pub async fn openclaw_channel_bind_employee(
    app: AppHandle,
    req: BindChannelEmployeeRequest,
) -> Result<OpenClawChannelActionResult, String> {
    let channel_id = req.channel_id.trim();
    if channel_id.is_empty() {
        return Err("缺少渠道 ID。".to_string());
    }

    let account_id = normalize_account_id(req.account_id.as_deref());
    let employee_id = req.employee_id.trim();
    if employee_id.is_empty() {
        return Err("缺少员工 ID。".to_string());
    }

    if channel_id == "openclaw-weixin" {
        let overview = load_wechat_overview(&app).await?;
        let exists = overview
            .accounts
            .iter()
            .any(|account| account.account_id == account_id);
        if !exists {
            return Err("还没有检测到这个微信账号。请先完成扫码登录，再回来绑定。".to_string());
        }
    }

    let spec = format!("{channel_id}:{account_id}");
    let bindings = parse_channel_bindings(&load_gateway_agent_bindings().await?, channel_id);

    for binding in bindings
        .iter()
        .filter(|binding| binding.account_id == account_id)
    {
        if binding.agent_id == employee_id {
            return Ok(OpenClawChannelActionResult {
                ok: true,
                message: "渠道账号已绑定到当前员工。".to_string(),
                output: Some(spec),
            });
        }

        set_gateway_agent_binding(binding.agent_id.as_str(), channel_id, &account_id, false)
            .await?;
    }

    let _ = set_gateway_agent_binding(employee_id, channel_id, &account_id, true).await?;

    Ok(OpenClawChannelActionResult {
        ok: true,
        message: "渠道账号已绑定到当前员工。".to_string(),
        output: Some(spec),
    })
}

#[tauri::command]
pub async fn openclaw_channel_unbind_employee(
    _app: AppHandle,
    req: BindChannelEmployeeRequest,
) -> Result<OpenClawChannelActionResult, String> {
    let channel_id = req.channel_id.trim();
    if channel_id.is_empty() {
        return Err("缺少渠道 ID。".to_string());
    }

    let account_id = normalize_account_id(req.account_id.as_deref());
    let employee_id = req.employee_id.trim();
    if employee_id.is_empty() {
        return Err("缺少员工 ID。".to_string());
    }

    let spec = format!("{channel_id}:{account_id}");
    let _ = set_gateway_agent_binding(employee_id, channel_id, &account_id, false).await?;

    Ok(OpenClawChannelActionResult {
        ok: true,
        message: "渠道账号已从当前员工解绑。".to_string(),
        output: Some(spec),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawPairingRequestItem {
    pub channel_id: String,
    pub account_id: String,
    pub id: String,
    pub code: String,
    pub created_at: String,
    pub last_seen_at: String,
    pub expires_at_ms: i64,
    pub meta: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawPairingSnapshot {
    pub requests: Vec<OpenClawPairingRequestItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveChannelPairingRequest {
    pub channel_id: String,
    pub code: String,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChannelPolicyRequest {
    pub channel_id: String,
    pub account_id: Option<String>,
    pub dm_policy: Option<String>,
    pub group_policy: Option<String>,
}

fn parse_pairing_created_at_ms(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|value| value.timestamp_millis())
}

/// Parse one engine pairing-store file (`{version:1, requests:[…]}`). The store
/// keeps a single file per channel; multi-account entries carry their account
/// in `meta.accountId`. Entries past the engine TTL are dropped — they can no
/// longer be approved even though the engine hasn't pruned the file yet.
fn parse_pairing_store_entries(
    channel_id: &str,
    raw: &str,
    now_ms: i64,
) -> Vec<OpenClawPairingRequestItem> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    value
        .get("requests")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_str)?.to_string();
                    let code = item.get("code").and_then(Value::as_str)?.to_string();
                    let created_at = item.get("createdAt").and_then(Value::as_str)?.to_string();
                    let created_ms = parse_pairing_created_at_ms(&created_at)?;
                    let expires_at_ms = created_ms.saturating_add(PAIRING_PENDING_TTL_MS);
                    if expires_at_ms <= now_ms {
                        return None;
                    }
                    let meta = item.get("meta").and_then(Value::as_object).cloned();
                    let account_id = meta
                        .as_ref()
                        .and_then(|value| value.get("accountId"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("default")
                        .to_string();
                    Some(OpenClawPairingRequestItem {
                        channel_id: channel_id.to_string(),
                        account_id,
                        id,
                        code,
                        created_at,
                        last_seen_at: item
                            .get("lastSeenAt")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        expires_at_ms,
                        meta,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn openclaw_channel_pairing_requests() -> Result<OpenClawPairingSnapshot, String> {
    let state_dir = crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(None)?;
    // Every engine spawn gets OPENCLAW_OAUTH_DIR=<state>/oauth, and the pairing
    // store lives in the OAuth dir; <state>/credentials is the engine's default
    // when that env is absent, kept as a fallback for stores written before the
    // env pinning landed.
    let dirs = [state_dir.join("oauth"), state_dir.join("credentials")];
    let now_ms = chrono::Utc::now().timestamp_millis();

    let mut seen = std::collections::HashSet::new();
    let mut requests = Vec::new();
    for channel_id in PAIRING_CHANNEL_IDS {
        for dir in &dirs {
            let path = dir.join(format!("{channel_id}-pairing.json"));
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            for item in parse_pairing_store_entries(channel_id, &raw, now_ms) {
                if seen.insert((item.channel_id.clone(), item.code.clone())) {
                    requests.push(item);
                }
            }
        }
    }
    requests.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(OpenClawPairingSnapshot { requests })
}

fn humanize_pairing_approve_error(error: String) -> String {
    if error.contains("No pending pairing request") {
        return "没有找到这个配对码对应的待批准请求，可能已过期（配对码有效期 1 小时）或已被处理。请刷新待批准列表。"
            .to_string();
    }
    error
}

#[tauri::command]
pub async fn openclaw_channel_pairing_approve(
    req: ApproveChannelPairingRequest,
) -> Result<OpenClawChannelActionResult, String> {
    let channel_id = req.channel_id.trim().to_ascii_lowercase();
    let channel_ok = !channel_id.is_empty()
        && channel_id.len() <= 64
        && channel_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !channel_ok {
        return Err("渠道 ID 无效。".to_string());
    }
    let code = req.code.trim().to_ascii_uppercase();
    if !(4..=16).contains(&code.len()) || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("配对码格式无效。".to_string());
    }

    // Approval must go through the engine CLI, not a direct file edit: approve
    // also bootstraps commands.ownerAllowFrom on first approval and notifies
    // the requester on the channel (--notify).
    let mut args = vec![
        "pairing".to_string(),
        "approve".to_string(),
        "--channel".to_string(),
        channel_id,
        code.clone(),
        "--notify".to_string(),
    ];
    if let Some(account) = req
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default")
    {
        args.push("--account".to_string());
        args.push(account.to_string());
    }

    let output = openclaw_cli::plugin_cli_output(args)
        .await
        .map_err(humanize_pairing_approve_error)?;

    Ok(OpenClawChannelActionResult {
        ok: true,
        message: "已批准配对请求，对方现在可以和这位员工对话了。".to_string(),
        output: Some(output),
    })
}

const DM_POLICY_VALUES: [&str; 4] = ["pairing", "allowlist", "open", "disabled"];
const GROUP_POLICY_VALUES: [&str; 3] = ["allowlist", "open", "disabled"];

fn normalized_policy(value: Option<&str>, allowed: &[&str], label: &str) -> Result<Option<String>, String> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let lowered = raw.to_ascii_lowercase();
    if allowed.contains(&lowered.as_str()) {
        Ok(Some(lowered))
    } else {
        Err(format!("{label} 不支持取值 {raw}。"))
    }
}

fn allow_from_is_wildcard_only(target: &Map<String, Value>) -> bool {
    target
        .get("allowFrom")
        .and_then(Value::as_array)
        .map(|items| items.len() == 1 && items[0].as_str() == Some("*"))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn openclaw_channel_set_policy(
    req: SetChannelPolicyRequest,
) -> Result<OpenClawChannelActionResult, String> {
    let channel_id = req.channel_id.trim().to_string();
    if channel_id.is_empty() {
        return Err("缺少渠道 ID。".to_string());
    }
    let dm_policy = normalized_policy(req.dm_policy.as_deref(), &DM_POLICY_VALUES, "私聊准入策略")?;
    let group_policy =
        normalized_policy(req.group_policy.as_deref(), &GROUP_POLICY_VALUES, "群聊准入策略")?;
    if dm_policy.is_none() && group_policy.is_none() {
        return Err("没有要修改的准入策略。".to_string());
    }

    let mut config = load_gateway_config().await?;
    let root = config
        .as_object_mut()
        .ok_or_else(|| "Uniopc 引擎 配置格式无效。".to_string())?;
    let channels = ensure_json_object_child(root, "channels")?;
    let channel = ensure_json_object_child(channels, &channel_id)?;
    // feishu keeps per-account config (mirrors openclaw_feishu_save_account);
    // plugin channels (openclaw-weixin) are configured at the channel root.
    let target = if channel_id == "feishu" {
        let account_id = normalize_account_id(req.account_id.as_deref());
        let accounts = ensure_json_object_child(channel, "accounts")?;
        ensure_json_object_child(accounts, &account_id)?
    } else {
        channel
    };

    if let Some(policy) = dm_policy.as_deref() {
        set_string(target, "dmPolicy", policy);
        if policy == "open" {
            // "open" only actually opens DMs when allowFrom is ["*"] — the
            // engine treats it as allowlist otherwise.
            target.insert("allowFrom".to_string(), json!(["*"]));
        } else if allow_from_is_wildcard_only(target) {
            // Leaving the wildcard behind would keep DMs wide open under a
            // stricter policy; only remove it when it is exactly ["*"] so a
            // hand-curated allowlist is never clobbered.
            target.remove("allowFrom");
        }
    }
    if let Some(policy) = group_policy.as_deref() {
        set_string(target, "groupPolicy", policy);
    }

    openclaw_gateway::config_patch(None, config).await?;

    Ok(OpenClawChannelActionResult {
        ok: true,
        message: "准入策略已更新。".to_string(),
        output: None,
    })
}

#[tauri::command]
pub async fn openclaw_open_external_url(
    app: AppHandle,
    url: String,
) -> Result<OpenClawChannelActionResult, String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("mailto:"))
    {
        return Err("只允许打开 http / https / mailto 外链。".to_string());
    }

    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|e| format!("打开外部链接失败: {e}"))?;

    Ok(OpenClawChannelActionResult {
        ok: true,
        message: "已在系统浏览器中打开链接。".to_string(),
        output: Some(trimmed.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_json(entries: &str) -> String {
        format!("{{\"version\":1,\"requests\":[{entries}]}}")
    }

    #[test]
    fn pairing_entries_drop_expired_requests() {
        let now_ms = parse_pairing_created_at_ms("2026-07-21T10:00:00.000Z").unwrap();
        let raw = store_json(
            r#"{"id":"ou_live","code":"ABCD2345","createdAt":"2026-07-21T09:30:00.000Z","lastSeenAt":"2026-07-21T09:30:00.000Z"},
               {"id":"ou_stale","code":"WXYZ7890","createdAt":"2026-07-21T08:30:00.000Z","lastSeenAt":"2026-07-21T08:30:00.000Z"}"#,
        );
        let entries = parse_pairing_store_entries("feishu", &raw, now_ms);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "ou_live");
        assert_eq!(entries[0].channel_id, "feishu");
        assert_eq!(entries[0].account_id, "default");
        assert!(entries[0].expires_at_ms > now_ms);
    }

    #[test]
    fn pairing_entries_read_account_id_from_meta() {
        let now_ms = parse_pairing_created_at_ms("2026-07-21T10:00:00.000Z").unwrap();
        let raw = store_json(
            r#"{"id":"ou_x","code":"CODE2345","createdAt":"2026-07-21T09:59:00.000Z","lastSeenAt":"2026-07-21T09:59:00.000Z","meta":{"accountId":"sales","name":"客户A"}}"#,
        );
        let entries = parse_pairing_store_entries("feishu", &raw, now_ms);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].account_id, "sales");
        assert_eq!(
            entries[0]
                .meta
                .as_ref()
                .and_then(|meta| meta.get("name"))
                .and_then(Value::as_str),
            Some("客户A")
        );
    }

    #[test]
    fn pairing_entries_tolerate_malformed_store() {
        let now_ms = 0;
        assert!(parse_pairing_store_entries("feishu", "not json", now_ms).is_empty());
        assert!(parse_pairing_store_entries("feishu", "{}", now_ms).is_empty());
        let missing_code = store_json(r#"{"id":"ou_x","createdAt":"2026-07-21T09:59:00.000Z"}"#);
        assert!(parse_pairing_store_entries("feishu", &missing_code, i64::MIN).is_empty());
    }

    #[test]
    fn policy_validation_rejects_unknown_values() {
        assert_eq!(
            normalized_policy(Some("pairing"), &DM_POLICY_VALUES, "私聊准入策略").unwrap(),
            Some("pairing".to_string())
        );
        assert_eq!(
            normalized_policy(None, &DM_POLICY_VALUES, "私聊准入策略").unwrap(),
            None
        );
        assert!(normalized_policy(Some("yolo"), &DM_POLICY_VALUES, "私聊准入策略").is_err());
        assert!(normalized_policy(Some("pairing"), &GROUP_POLICY_VALUES, "群聊准入策略").is_err());
    }

    #[test]
    fn rewrite_agent_bindings_replaces_own_entry_and_keeps_others() {
        let existing = vec![
            json!({ "agentId": "main", "match": { "channel": "feishu", "accountId": "default" } }),
            json!({ "agentId": "sales", "match": { "channel": "feishu", "accountId": "sales-acct" } }),
        ];
        let bound = rewrite_agent_bindings(existing.clone(), "main", "feishu", "default", true);
        assert_eq!(bound.len(), 2);
        assert!(bound
            .iter()
            .any(|item| item.get("agentId").and_then(Value::as_str) == Some("sales")));

        let unbound = rewrite_agent_bindings(existing, "main", "feishu", "default", false);
        assert_eq!(unbound.len(), 1);
        assert_eq!(
            unbound[0].get("agentId").and_then(Value::as_str),
            Some("sales")
        );

        // 无 accountId 的旧条目按 default 账号匹配
        let legacy = vec![json!({ "agentId": "main", "match": { "channel": "feishu" } })];
        assert!(rewrite_agent_bindings(legacy, "main", "feishu", "default", false).is_empty());
    }

    #[test]
    fn wildcard_allow_from_detection_only_matches_exact_wildcard() {
        let mut target = Map::new();
        target.insert("allowFrom".to_string(), json!(["*"]));
        assert!(allow_from_is_wildcard_only(&target));
        target.insert("allowFrom".to_string(), json!(["*", "ou_x"]));
        assert!(!allow_from_is_wildcard_only(&target));
        target.remove("allowFrom");
        assert!(!allow_from_is_wildcard_only(&target));
    }
}
