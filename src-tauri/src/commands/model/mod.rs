pub mod models;
pub mod profiles;
pub mod runtime;
mod types;

pub(crate) use self::models::implementation::openclaw_ready_model_refs_for_profile;
pub use self::models::{
    openclaw_login_minimax_oauth, openclaw_login_openai_codex, openclaw_media_capabilities_save,
    openclaw_models_snapshot, openclaw_official_bootstrap_snapshot, openclaw_use_custom_openai_model, openclaw_use_openai_api_model,
    openclaw_use_provider_api_key_model, openclaw_use_uniopc_official_model,
};
pub(crate) use self::profiles::openclaw_profile_provision;
pub use self::profiles::openclaw_profile_status;
pub(crate) use self::runtime::implementation::{
    openclaw_logout_active_profile_impl, openclaw_reset_profile_data_impl,
    openclaw_stop_gateway_for_profile,
};
pub use self::runtime::{
    openclaw_check_update, openclaw_install, openclaw_start_gateway, openclaw_status,
    openclaw_stop_gateway, openclaw_uninstall, openclaw_update,
};
pub use self::types::{
    OpenClawCustomModelRequest, OpenClawInstallResult, OpenClawMediaCapabilitiesSaveRequest,
    OpenClawModelCatalogEntry, OpenClawModelStatus, OpenClawModelsSnapshot,
    OpenClawProfileProvisionRequest, OpenClawProfileProvisionResult, OpenClawProfileStatusRequest,
    OpenClawProfileStatusResult, OpenClawProviderApiKeyRequest, OpenClawProviderSnapshot,
    OpenClawSetupProgress, OpenClawStatus, OpenClawUniopcOfficialRequest,
};
use self::types::{OpenClawGatewayStatus, OpenClawOfficialCatalogModel, ProviderApiKeySpec};
use self::{
    models::normalize_openclaw_model_ref,
    runtime::{
        implementation::stop_gateway_for_profile_under_shutdown_guard,
    },
};

use crate::services::openclaw_bundled_runtime;
use crate::services::openclaw_engine_contract::{is_exact_engine_version, OPENCLAW_ENGINE_VERSION};
use crate::services::openclaw_gateway;
use crate::services::openclaw_system_plugins;
use crate::services::uniopc_runtime_paths;
use rusqlite::Connection;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::time::{sleep, timeout, Duration};

const OPENCLAW_UNIX_INSTALL_SCRIPT_URL: &str = "https://openclaw.bot/install-cli.sh";
const OPENCLAW_WINDOWS_INSTALL_COMMAND: &str =
    "& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard";
const OPENCLAW_OPENAI_API_DEFAULT_MODEL: &str = "openai/gpt-5.4";
const OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER: &str = "openai-codex";
const OPENCLAW_OPENAI_CODEX_CLI_AUTH_PROVIDER: &str = "openai";
const OPENCLAW_OPENAI_CODEX_DEFAULT_MODEL: &str = "openai/gpt-5.5";
const OPENCLAW_OPENAI_CODEX_SYNC_PROFILE_ID: &str = "openai:codex-cli";
const OPENCLAW_DEEPSEEK_DEFAULT_MODEL: &str = "deepseek/deepseek-v4-flash";
const OPENCLAW_CODEX_LOGIN_TIMEOUT_SECS: u64 = 90;
const OPENCLAW_PROFILE_STATUS_HEALTH_TIMEOUT_SECS: u64 = 4;
const OPENCLAW_CONFIG_PATCH_RECOVERY_ATTEMPTS: usize = 20;
const OPENCLAW_CONFIG_PATCH_RECOVERY_DELAY_MS: u64 = 500;
const OPENCLAW_MINIMAX_AUTH_PROVIDER: &str = "minimax-portal";
const OPENCLAW_MINIMAX_DEFAULT_MODEL: &str = "minimax-portal/MiniMax-M2.7";
const OPENCLAW_LEGACY_SINGLETON_GATEWAY_PORT: u16 = 18789;
const OPENCLAW_DASHBOARD_URL: &str = "http://127.0.0.1:18790/";
const OPENCLAW_GATEWAY_WS_URL: &str = "ws://127.0.0.1:18790";
const OPENCLAW_UNINSTALL_COMMAND: &str =
    "openclaw uninstall --state --workspace --yes --non-interactive";

fn common_binary_candidates(name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(private_bin) = uniopc_runtime_paths::runtime_bin_dir() {
        if cfg!(target_os = "windows") {
            candidates.push(private_bin.join(format!("{name}.exe")));
        } else {
            candidates.push(private_bin.join(name));
        }
    }
    if let Some(home) = openclaw_home_dir() {
        if !cfg!(target_os = "windows") {
            candidates.push(home.join(".local").join("bin").join(name));
        }
    }

    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from(format!("/opt/homebrew/bin/{name}")));
        candidates.push(PathBuf::from(format!("/usr/local/bin/{name}")));
        if name == "codex" {
            candidates.push(PathBuf::from(
                "/Applications/Codex.app/Contents/Resources/codex",
            ));
        }
    } else if cfg!(target_os = "linux") {
        candidates.push(PathBuf::from(format!("/usr/local/bin/{name}")));
        candidates.push(PathBuf::from(format!("/usr/bin/{name}")));
    } else if cfg!(target_os = "windows") {
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local_app_data)
                    .join("Programs")
                    .join(name)
                    .join(format!("{name}.exe")),
            );
        }
    }

    candidates
}

fn existing_binary_path(name: &str) -> Option<String> {
    common_binary_candidates(name)
        .into_iter()
        .find(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
}

fn emit_openclaw_progress(app: &AppHandle, payload: OpenClawSetupProgress) -> Result<(), String> {
    app.emit("openclaw-setup-progress", payload)
        .map_err(|e| format!("发送 Uniopc 引擎 安装进度失败: {e}"))
}

fn openclaw_platform() -> String {
    if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else {
        std::env::consts::OS.to_string()
    }
}

fn openclaw_install_command() -> String {
    if cfg!(target_os = "windows") {
        format!("powershell -c \"{OPENCLAW_WINDOWS_INSTALL_COMMAND}\"")
    } else {
        openclaw_unix_cli_installer_command(&imai_openclaw_install_version())
    }
}

fn openclaw_unix_cli_installer_command(version: &str) -> String {
    // Network fallback installs straight into the private version dir so the
    // layout matches what the bundled extraction would have produced.
    let prefix = uniopc_runtime_paths::runtime_version_dir(version)
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .to_string();
    format!(
        "curl -fsSL --proto '=https' --tlsv1.2 {OPENCLAW_UNIX_INSTALL_SCRIPT_URL} | bash -s -- --json --no-onboard --prefix {} --version {}",
        shell_single_quote(&prefix),
        shell_single_quote(version)
    )
}

fn imai_openclaw_install_version() -> String {
    OPENCLAW_ENGINE_VERSION.to_string()
}

fn openclaw_platform_lifecycle_hint() -> &'static str {
    "Gateway 作为 Uniopc App 子进程随连接启动、随退出关闭，不安装常驻系统服务。"
}

fn openclaw_local_bin_dir() -> PathBuf {
    uniopc_runtime_paths::runtime_bin_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn openclaw_managed_node_bin_dir() -> PathBuf {
    uniopc_runtime_paths::runtime_node_bin_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn openclaw_path_prefixes() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    paths.push(openclaw_local_bin_dir());
    paths.push(openclaw_managed_node_bin_dir());
    if let Some(home) = openclaw_home_dir() {
        if !cfg!(target_os = "windows") {
            paths.push(home.join(".local").join("bin"));
        }
    }
    if cfg!(target_os = "macos") {
        paths.push(PathBuf::from("/opt/homebrew/bin"));
        paths.push(PathBuf::from("/usr/local/bin"));
    }
    paths
}

fn openclaw_augmented_path(existing: Option<&str>) -> String {
    let mut paths = openclaw_path_prefixes();
    let existing_value = existing
        .map(|value| value.to_string())
        .or_else(|| env::var("PATH").ok())
        .unwrap_or_default();

    paths.extend(env::split_paths(&existing_value));

    let mut unique = Vec::<PathBuf>::new();
    for path in paths {
        if !unique.iter().any(|item| item == &path) {
            unique.push(path);
        }
    }

    env::join_paths(unique)
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or(existing_value)
}

fn scutil_proxy_value(output: &str, key: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let (raw_key, raw_value) = trimmed.split_once(':')?;
        if raw_key.trim() == key {
            let value = raw_value.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        } else {
            None
        }
    })
}

fn scutil_proxy_enabled(output: &str, key: &str) -> bool {
    scutil_proxy_value(output, key)
        .map(|value| value == "1")
        .unwrap_or(false)
}

fn cli_proxy_env_from_macos_scutil_output(output: &str) -> Vec<(String, String)> {
    let mut envs = Vec::new();

    if scutil_proxy_enabled(output, "HTTPEnable") {
        if let (Some(host), Some(port)) = (
            scutil_proxy_value(output, "HTTPProxy"),
            scutil_proxy_value(output, "HTTPPort"),
        ) {
            envs.push(("HTTP_PROXY".to_string(), format!("http://{host}:{port}")));
        }
    }

    if scutil_proxy_enabled(output, "HTTPSEnable") {
        if let (Some(host), Some(port)) = (
            scutil_proxy_value(output, "HTTPSProxy"),
            scutil_proxy_value(output, "HTTPSPort"),
        ) {
            envs.push(("HTTPS_PROXY".to_string(), format!("http://{host}:{port}")));
        }
    }

    if envs.is_empty() && scutil_proxy_enabled(output, "SOCKSEnable") {
        if let (Some(host), Some(port)) = (
            scutil_proxy_value(output, "SOCKSProxy"),
            scutil_proxy_value(output, "SOCKSPort"),
        ) {
            envs.push(("ALL_PROXY".to_string(), format!("socks5://{host}:{port}")));
        }
    }

    envs
}

fn cli_proxy_env_from_process() -> Vec<(String, String)> {
    let mut envs = Vec::new();
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
        if let Ok(value) = env::var(key) {
            if !value.trim().is_empty() {
                envs.push((key.to_string(), value));
            }
        }
    }
    envs
}

/// Resolved once per app run (Accio-style startup resolution): proxy config
/// rarely changes mid-session, and the fallback used to spawn a `scutil`
/// subprocess on every engine CLI call.
static CLI_PROXY_ENV_CACHE: std::sync::OnceLock<Vec<(String, String)>> = std::sync::OnceLock::new();

fn resolve_cli_proxy_env() -> Vec<(String, String)> {
    let mut envs = cli_proxy_env_from_process();
    if envs.is_empty() && cfg!(target_os = "macos") {
        if let Ok(output) = std::process::Command::new("scutil").arg("--proxy").output() {
            let text = output_to_string(&output.stdout);
            envs = cli_proxy_env_from_macos_scutil_output(&text);
        }
    }
    // A proxy is in play: carry NO_PROXY so the domestic model/Supabase backends
    // (opentrust.net / aliyuncs.com) are reached DIRECTLY instead of routed
    // through a China VPN that ECONNRESETs them mid model-fetch. Applied here so
    // every `.envs(cli_proxy_env())` spawn (gateway child, CLI ops) inherits it.
    // No proxy → direct anyway, nothing to exclude.
    if !envs.is_empty() {
        let no_proxy = crate::services::openclaw_cli::no_proxy_value().to_string();
        envs.push(("NO_PROXY".to_string(), no_proxy.clone()));
        envs.push(("no_proxy".to_string(), no_proxy));
    }
    envs
}

fn cli_proxy_env() -> Vec<(String, String)> {
    CLI_PROXY_ENV_CACHE
        .get_or_init(resolve_cli_proxy_env)
        .clone()
}

/// Redacted one-line proxy summary for the runtime diagnostics page —
/// credentials in proxy URLs are never surfaced.
fn proxy_summary_for_diagnostics() -> String {
    let envs = cli_proxy_env();
    if envs.is_empty() {
        return "未配置代理（直连）".to_string();
    }
    let parts: Vec<String> = envs
        .iter()
        .map(|(key, value)| {
            let redacted = value
                .rsplit('@')
                .next()
                .map(|tail| {
                    if value.contains('@') {
                        let scheme = value.split("://").next().unwrap_or("");
                        if scheme.is_empty() {
                            tail.to_string()
                        } else {
                            format!("{scheme}://{tail}")
                        }
                    } else {
                        value.clone()
                    }
                })
                .unwrap_or_else(|| value.clone());
            format!("{key}={redacted}")
        })
        .collect();
    parts.join("; ")
}

fn cloud_agent_proxy_url_from_cli_proxy_env(envs: &[(String, String)]) -> Option<String> {
    for preferred_key in [
        "IMAI_CLOUD_AGENT_PROXY_URL",
        "ALL_PROXY",
        "all_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        if let Some((_, value)) = envs
            .iter()
            .find(|(key, value)| key == preferred_key && !value.trim().is_empty())
        {
            let value = value.trim();
            let proxy_url = value
                .strip_prefix("socks5://")
                .map(|rest| format!("socks5h://{rest}"))
                .unwrap_or_else(|| value.to_string());
            return Some(proxy_url);
        }
    }
    None
}

fn cloud_agent_proxy_url() -> Option<String> {
    cloud_agent_proxy_url_from_cli_proxy_env(&cli_proxy_env())
}

fn shell_export_proxy_env(envs: &[(String, String)]) -> String {
    let mut exports = Vec::new();
    for (key, value) in envs {
        exports.push(format!("export {}={};", key, shell_single_quote(value)));
        exports.push(format!(
            "export {}={};",
            key.to_lowercase(),
            shell_single_quote(value)
        ));
    }
    exports.join(" ")
}

/// Uniopc private-state env for an openclaw invocation: derive the profile
/// from an explicit `--profile <key>` argument (default otherwise). The
/// engine honors env over --profile (applyCliProfileEnv: existing
/// OPENCLAW_STATE_DIR wins), so injecting here pins every spawn to the
/// private layout.
fn openclaw_state_env(args: &[String]) -> Vec<(String, String)> {
    let profile = args
        .iter()
        .position(|arg| arg == "--profile")
        .and_then(|index| args.get(index + 1))
        .map(String::as_str);
    crate::services::openclaw_cli::state_env_for_profile(profile)
}

fn shell_export_openclaw_env(profile: Option<&str>) -> String {
    let path = openclaw_augmented_path(None);
    let mut exports = format!("export PATH={};", shell_single_quote(&path));
    for (key, value) in crate::services::openclaw_cli::state_env_for_profile(profile) {
        exports.push_str(&format!(" export {key}={};", shell_single_quote(&value)));
    }
    let proxy_exports = shell_export_proxy_env(&cli_proxy_env());
    if !proxy_exports.is_empty() {
        exports.push(' ');
        exports.push_str(&proxy_exports);
    }
    exports
}

fn strip_ansi_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for code_ch in chars.by_ref() {
                if ('@'..='~').contains(&code_ch) {
                    break;
                }
            }
            continue;
        }
        output.push(ch);
    }

    output
}

fn openclaw_install_failure_detail(error_tail: &str) -> String {
    let normalized = error_tail.to_lowercase();
    if (normalized.contains("stdin") && normalized.contains("not a tty"))
        || normalized.contains("need sudo access")
        || (normalized.contains("sudo") && normalized.contains("non-interactive"))
    {
        return "当前安装器需要 sudo/管理员交互，但 Uniopc 内部安装进程没有可交互终端。请在系统终端中安装依赖，或改用免 root 的 Uniopc 引擎 CLI 安装流程。"
            .to_string();
    }
    if normalized.contains("could not resolve")
        || normalized.contains("couldn't connect")
        || normalized.contains("failed to connect")
        || normalized.contains("operation timed out")
    {
        return "无法连接 Uniopc 引擎 安装源，请检查网络连接后重试。".to_string();
    }
    if normalized.contains("git") && normalized.contains("not found") {
        return "未检测到 Git。请先安装 Git 或 Xcode Command Line Tools 后重试。".to_string();
    }

    "Uniopc 引擎 安装失败。请查看下方日志，或在系统终端中运行官方安装命令。".to_string()
}

fn openclaw_codex_login_failure_detail(output_tail: &str) -> String {
    let normalized = output_tail.to_lowercase();
    if normalized.contains("state mismatch") {
        return "OpenAI Codex 授权页面已过期或来自上一次登录。请关闭旧的 OpenAI 登录页后重新点击登录。"
            .to_string();
    }
    if normalized.contains("unsupported_country_region_territory")
        || normalized.contains("country, region, or territory not supported")
    {
        return "OpenAI 拒绝了当前网络出口或账号地区的 Codex 订阅 token exchange。浏览器授权成功只代表登录页完成；请切换到支持地区的全局/TUN 代理节点后重试，或改用 OpenAI API Key。"
            .to_string();
    }
    if normalized.contains("device code authorization")
        || normalized.contains("device code auth")
        || normalized.contains("设备代码授权")
    {
        return "当前账号未开启 Codex 设备代码授权。Uniopc 已默认使用浏览器登录；如仍看到此提示，请在 ChatGPT 安全设置中开启 Codex 授权，或改用 OpenAI API Key。"
            .to_string();
    }
    if normalized.contains("device code request failed") {
        return "OpenAI Codex 设备配对请求失败。请检查网络环境后重试，或改用 OpenAI API Key。"
            .to_string();
    }
    if normalized.contains("oauth") && normalized.contains("failed") {
        return "OpenAI Codex 授权没有完成。请完成浏览器或设备码授权后刷新状态，或改用 OpenAI API Key。"
            .to_string();
    }

    "OpenAI Codex 授权没有完成。请查看下方日志后重试，或改用 OpenAI API Key。".to_string()
}

fn should_hide_codex_login_output(output_tail: &str) -> bool {
    let normalized = output_tail.to_lowercase();
    normalized.contains("unsupported_country_region_territory")
        || normalized.contains("country, region, or territory not supported")
}

fn ipinfo_country_from_output(output: &str) -> Option<String> {
    parse_json_object_from_output(output)?
        .get("country")?
        .as_str()
        .map(|country| country.trim().to_uppercase())
        .filter(|country| !country.is_empty())
}

fn openai_codex_network_preflight_failure(country: Option<&str>) -> Option<String> {
    match country.map(|value| value.trim().to_uppercase()) {
        Some(country) if country == "CN" => Some(
            "当前网络出口仍在中国大陆，暂不能完成 OpenAI Codex 订阅授权。请开启代理软件的全局/TUN 模式，或改用 OpenAI API Key / MiniMax。"
                .to_string(),
        ),
        _ => None,
    }
}

fn shell_single_quote(input: &str) -> String {
    format!("'{}'", input.replace('\'', "'\\''"))
}

fn openclaw_codex_login_terminal_command(profile: Option<&str>, _target_model: &str) -> String {
    format!(
        "{} {} login",
        shell_export_openclaw_env(profile),
        existing_binary_path("codex")
            .map(|path| shell_single_quote(&path))
            .unwrap_or_else(|| "codex".to_string())
    )
}

fn openclaw_codex_login_hidden_command(
    profile: Option<&str>,
    target_model: &str,
) -> (String, Vec<String>) {
    let command = openclaw_codex_login_terminal_command(profile, target_model);
    openclaw_pseudo_terminal_command(command)
}

fn openclaw_minimax_login_terminal_command(profile: Option<&str>, target_model: &str) -> String {
    let _ = target_model;
    let profile_args = profile
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|profile| format!(" --profile {}", shell_single_quote(profile)))
        .unwrap_or_default();
    format!(
        concat!(
            "{} ",
            "openclaw{} onboard --auth-choice minimax-cn-oauth ",
            "--accept-risk --mode local --flow quickstart ",
            "--gateway-bind loopback --skip-ui"
        ),
        shell_export_openclaw_env(profile),
        profile_args
    )
}

fn openclaw_pseudo_terminal_command(command: String) -> (String, Vec<String>) {
    if cfg!(target_family = "unix") {
        let shell = if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/sh"
        };
        return (
            "script".to_string(),
            vec![
                "-q".to_string(),
                "/dev/null".to_string(),
                shell.to_string(),
                "-lc".to_string(),
                command,
            ],
        );
    }

    (
        "powershell".to_string(),
        vec!["-NoProfile".to_string(), "-Command".to_string(), command],
    )
}

fn openclaw_update_command() -> String {
    if cfg!(target_os = "windows") {
        format!("powershell -c \"{OPENCLAW_WINDOWS_INSTALL_COMMAND}\"")
    } else {
        openclaw_unix_cli_installer_command(&imai_openclaw_install_version())
    }
}

fn openclaw_uninstall_command() -> String {
    OPENCLAW_UNINSTALL_COMMAND.to_string()
}

fn validate_openclaw_profile_handle(profile: &str) -> Result<String, String> {
    let value = profile.trim();
    if value.is_empty() {
        return Err("Uniopc 引擎 profile 不能为空。".to_string());
    }
    if value.len() > 64 {
        return Err("Uniopc 引擎 profile 不能超过 64 个字符。".to_string());
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("Uniopc 引擎 profile 只能包含字母、数字、- 或 _。".to_string());
    }
    Ok(value.to_string())
}

fn default_gateway_port_for_profile(profile: &str) -> u16 {
    crate::services::openclaw_connection::local_gateway_port_for_profile(profile)
}

fn is_legacy_singleton_gateway_port(port: u16) -> bool {
    port == OPENCLAW_LEGACY_SINGLETON_GATEWAY_PORT
        || port == port_from_ws_url(OPENCLAW_GATEWAY_WS_URL).unwrap_or_default()
}

fn port_from_ws_url(url: &str) -> Option<u16> {
    let without_scheme = url
        .trim()
        .strip_prefix("ws://")
        .or_else(|| url.trim().strip_prefix("wss://"))
        .unwrap_or_else(|| url.trim());
    let host_port = without_scheme.split('/').next().unwrap_or_default();
    let port_text = host_port.rsplit(':').next().unwrap_or_default();
    port_text.parse::<u16>().ok()
}

fn profile_gateway_urls_for_mode(
    profile: &str,
    gateway_port: Option<u16>,
    managed_member_profile: bool,
) -> (u16, String, String) {
    let default_port = default_gateway_port_for_profile(profile);
    let port = if managed_member_profile {
        default_port
    } else {
        gateway_port
            .filter(|port| !is_legacy_singleton_gateway_port(*port))
            .unwrap_or(default_port)
    };
    (
        port,
        format!("ws://127.0.0.1:{port}"),
        format!("http://127.0.0.1:{port}/"),
    )
}

fn dashboard_url_from_gateway_ws_url(ws_url: &str) -> Option<String> {
    port_from_ws_url(ws_url).map(|port| format!("http://127.0.0.1:{port}/"))
}

fn gateway_urls_from_probe(
    fallback: (u16, String, String),
    status: &OpenClawGatewayStatus,
) -> (u16, String, String) {
    let ws_url = status.ws_url.trim();
    if ws_url.is_empty() {
        return fallback;
    }

    let port = port_from_ws_url(ws_url).unwrap_or(fallback.0);
    let dashboard_url = if status.dashboard_url.trim().is_empty()
        || status.dashboard_url == OPENCLAW_DASHBOARD_URL
    {
        dashboard_url_from_gateway_ws_url(ws_url).unwrap_or(fallback.2)
    } else {
        status.dashboard_url.clone()
    };

    (port, status.ws_url.clone(), dashboard_url)
}

fn apply_configured_gateway_url_for_profile(
    urls: (u16, String, String),
    metadata: &openclaw_gateway::GatewayConfigMetadata,
    managed_member_profile: bool,
) -> (u16, String, String) {
    if managed_member_profile {
        return urls;
    }
    let mut next = urls;
    if metadata.ws_url.trim().is_empty() {
        return next;
    }
    if port_from_ws_url(&metadata.ws_url).is_some_and(is_legacy_singleton_gateway_port) {
        return next;
    }
    next.1 = metadata.ws_url.clone();
    if let Some(port) = port_from_ws_url(&next.1) {
        next.0 = port;
        next.2 = format!("http://127.0.0.1:{port}/");
    }
    next
}

fn local_profile_gateway_urls_for_mode(
    profile: &str,
    gateway_port: Option<u16>,
    managed_member_profile: bool,
) -> (u16, String, String) {
    let urls = profile_gateway_urls_for_mode(profile, gateway_port, managed_member_profile);
    openclaw_gateway::config_metadata(Some(profile))
        .map(|metadata| {
            apply_configured_gateway_url_for_profile(
                urls.clone(),
                &metadata,
                managed_member_profile,
            )
        })
        .unwrap_or(urls)
}

fn configured_gateway_port_for_profile(profile: &str) -> Option<u16> {
    openclaw_gateway::config_metadata(Some(profile))
        .ok()
        .and_then(|metadata| port_from_ws_url(&metadata.ws_url))
}

fn profile_gateway_port_mismatch(
    profile: &str,
    desired_port: u16,
    managed_member_profile: bool,
) -> Option<u16> {
    configured_gateway_port_for_profile(profile).filter(|port| {
        *port != desired_port && (managed_member_profile || is_legacy_singleton_gateway_port(*port))
    })
}

fn object_child_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Value {
    if !value.is_object() {
        *value = Value::Object(serde_json::Map::new());
    }
    value
        .as_object_mut()
        .expect("value was normalized to an object")
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()))
}

fn set_object_value(parent: &mut Value, key: &str, next: Value) -> bool {
    if !parent.is_object() {
        *parent = Value::Object(serde_json::Map::new());
    }
    let object = parent
        .as_object_mut()
        .expect("value was normalized to an object");
    if object.get(key) == Some(&next) {
        return false;
    }
    object.insert(key.to_string(), next);
    true
}

fn apply_openclaw_profile_isolation_config(config: &mut Value) -> bool {
    let mut changed = false;
    let discovery = object_child_mut(config, "discovery");
    let mdns = object_child_mut(discovery, "mdns");
    changed |= set_object_value(mdns, "mode", Value::String("off".to_string()));

    let plugins = object_child_mut(config, "plugins");
    let entries = object_child_mut(plugins, "entries");
    let bonjour = object_child_mut(entries, "bonjour");
    changed |= set_object_value(bonjour, "enabled", Value::Bool(false));

    changed
}

/// Per-profile opt-in marker for LAN mobile access. Present = the user turned on
/// "允许手机连接此电脑" on the Mobile page, so the gateway may bind the LAN
/// instead of loopback. Absent (default) keeps the hardened loopback-only bind.
fn mobile_lan_marker_path(profile: &str) -> Result<PathBuf, String> {
    Ok(uniopc_runtime_paths::state_v8_dir_for_profile(Some(profile))?.join(".mobile-lan-enabled"))
}

pub(crate) fn mobile_lan_enabled_for_profile(profile: &str) -> bool {
    mobile_lan_marker_path(profile)
        .map(|path| path.exists())
        .unwrap_or(false)
}

/// Current LAN mobile-access state for a profile: whether it is opted in, and
/// (when on) the LAN ws URL a same-network phone should dial. `gateway_url` is
/// None when opted in but the machine has no usable LAN IP (e.g. offline) — the
/// UI then tells the user to check Wi-Fi rather than showing a dead address.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileLanState {
    pub enabled: Option<bool>,
    pub gateway_url: Option<String>,
    pub port: u16,
    pub recovery_required: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileLanSetError {
    pub message: String,
    pub authoritative_enabled: Option<bool>,
    pub recovery_required: bool,
}

impl MobileLanSetError {
    pub(crate) fn new(
        message: String,
        authoritative_enabled: Option<bool>,
        recovery_required: bool,
    ) -> Self {
        Self {
            message,
            authoritative_enabled,
            recovery_required,
        }
    }
}

fn mobile_lan_authority_from_paths(marker_path: &Path, config_path: &Path) -> Result<bool, String> {
    let marker_enabled = snapshot_file(marker_path)?.is_some();
    let text = match fs::read_to_string(config_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !marker_enabled => {
            return Ok(false)
        }
        Err(error) => {
            return Err(format!(
                "recovery_required: 无法读取 Gateway config: {error}"
            ))
        }
    };
    let config: Value = json5::from_str(&text)
        .map_err(|error| format!("recovery_required: Gateway config 无效: {error}"))?;
    let config_enabled = match config.pointer("/gateway/bind").and_then(Value::as_str) {
        Some("lan") => true,
        Some("loopback") | None => false,
        Some(bind) => {
            return Err(format!(
                "recovery_required: Gateway bind `{bind}` 不是可识别的 mobile LAN 状态"
            ))
        }
    };
    if marker_enabled == config_enabled {
        Ok(marker_enabled)
    } else {
        Err(format!(
            "recovery_required: mobile LAN marker={marker_enabled} 与 config bind={config_enabled} 不一致"
        ))
    }
}

fn mobile_lan_authority_for_profile(profile: &str) -> Result<bool, String> {
    let marker = mobile_lan_marker_path(profile)?;
    let config = openclaw_gateway::openclaw_config_path_for_profile(Some(profile))?;
    mobile_lan_authority_from_paths(&marker, &config)
}

fn mobile_lan_set_error(message: String, profile: &str) -> MobileLanSetError {
    match mobile_lan_authority_for_profile(profile) {
        Ok(enabled) => MobileLanSetError::new(message, Some(enabled), false),
        Err(authority_error) => {
            MobileLanSetError::new(format!("{message}; {authority_error}"), None, true)
        }
    }
}

pub(crate) fn mobile_lan_state(profile: &str) -> MobileLanState {
    let authority = mobile_lan_authority_for_profile(profile);
    let enabled = authority.as_ref().ok().copied();
    let port = crate::services::openclaw_connection::local_gateway_port();
    let gateway_url = if enabled == Some(true) {
        crate::services::lan_address::lan_gateway_ws_url(port)
    } else {
        None
    };
    MobileLanState {
        enabled,
        gateway_url,
        port,
        recovery_required: authority.is_err(),
    }
}

fn write_mobile_lan_marker_path(path: &Path, enabled: bool) -> Result<(), String> {
    if enabled {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&path, b"1").map_err(|e| format!("写入移动端连接标记失败: {e}"))?;
    } else {
        // Absent = default loopback-only; removing a missing file is fine.
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("删除移动端连接标记失败: {error}")),
        }
    }
    Ok(())
}

fn snapshot_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if path.try_exists().map_err(|error| error.to_string())? {
        fs::read(path).map(Some).map_err(|error| error.to_string())
    } else {
        Ok(None)
    }
}

fn restore_file(path: &Path, snapshot: Option<&[u8]>) -> Result<(), String> {
    match snapshot {
        Some(bytes) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(path, bytes).map_err(|error| error.to_string())
        }
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    }
}

#[derive(Debug)]
struct MobileLanFileRollback {
    marker_before: Option<Vec<u8>>,
    config_before: Option<Vec<u8>>,
}

#[derive(Debug)]
struct MobileLanRestoreOutcome {
    marker: Result<(), String>,
    config: Result<(), String>,
}

impl MobileLanRestoreOutcome {
    fn fully_restored(&self) -> bool {
        self.config.is_ok() && self.marker.is_ok()
    }

    fn errors(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if let Err(error) = &self.config {
            errors.push(format!("config={error}"));
        }
        if let Err(error) = &self.marker {
            errors.push(format!("marker={error}"));
        }
        errors
    }
}

impl MobileLanFileRollback {
    fn restore_with<Marker, Config>(
        &self,
        marker_path: &Path,
        config_path: &Path,
        restore_marker: Marker,
        restore_config: Config,
    ) -> MobileLanRestoreOutcome
    where
        Marker: FnOnce(&Path, Option<&[u8]>) -> Result<(), String>,
        Config: FnOnce(&Path, Option<&[u8]>) -> Result<(), String>,
    {
        let config = restore_config(config_path, self.config_before.as_deref());
        let marker = restore_marker(marker_path, self.marker_before.as_deref());
        MobileLanRestoreOutcome { marker, config }
    }

    fn restore(&self, marker_path: &Path, config_path: &Path) -> MobileLanRestoreOutcome {
        self.restore_with(marker_path, config_path, restore_file, restore_file)
    }
}

async fn finish_mobile_lan_recovery<Prepare, PrepareFut, Restart, RestartFut>(
    prepare: Prepare,
    restart_old: Restart,
) -> Result<(), String>
where
    Prepare: FnOnce() -> PrepareFut,
    PrepareFut: std::future::Future<
        Output = (
            MobileLanRestoreOutcome,
            Result<(), String>,
            Result<bool, String>,
        ),
    >,
    Restart: FnOnce() -> RestartFut,
    RestartFut: std::future::Future<Output = Result<(), String>>,
{
    let (restore, stop, authority) = prepare().await;
    let mut errors = restore.errors();
    if let Err(error) = &stop {
        errors.push(format!("stop={error}"));
    }
    if let Err(error) = &authority {
        errors.push(error.clone());
    }
    if restore.fully_restored() && stop.is_ok() && authority.is_ok() {
        if let Err(error) = restart_old().await {
            errors.push(format!("restart_old={error}"));
        }
    } else if stop.is_err() {
        errors.push("Gateway 未确认停止，运行状态无法确认".to_string());
    } else {
        errors.push("旧 config/marker 未完整恢复；Gateway 保持 stopped".to_string());
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("mobile LAN 配置恢复失败: {}", errors.join(", ")))
    }
}

async fn commit_mobile_lan_files<Apply, Stop, StopFut>(
    marker_path: &Path,
    config_path: &Path,
    enabled: bool,
    apply_config: Apply,
    stop: Stop,
) -> Result<MobileLanFileRollback, String>
where
    Apply: FnOnce() -> Result<(), String>,
    Stop: FnOnce() -> StopFut,
    StopFut: std::future::Future<Output = Result<(), String>>,
{
    let marker_before = snapshot_file(marker_path)?;
    let config_before = snapshot_file(config_path)?;
    let result = write_mobile_lan_marker_path(marker_path, enabled).and_then(|_| apply_config());
    let result = match result {
        Ok(()) => stop().await,
        Err(error) => Err(error),
    };
    let rollback = MobileLanFileRollback {
        marker_before,
        config_before,
    };
    if let Err(error) = result {
        let restore = rollback.restore(marker_path, config_path);
        let errors = restore.errors();
        if !errors.is_empty() {
            return Err(format!(
                "{error}; mobile LAN 配置回滚失败: {}",
                errors.join(", ")
            ));
        }
        return Err(error);
    }
    Ok(rollback)
}

async fn complete_mobile_lan_restart<Start, StartFut, Recover, RecoverFut, Current>(
    start: Start,
    recover: Recover,
    current: Current,
) -> Result<(), MobileLanSetError>
where
    Start: FnOnce() -> StartFut,
    StartFut: std::future::Future<Output = Result<(), String>>,
    Recover: FnOnce() -> RecoverFut,
    RecoverFut: std::future::Future<Output = Result<(), String>>,
    Current: FnOnce() -> Result<bool, String>,
{
    let Err(start_error) = start().await else {
        return Ok(());
    };
    let recovery = recover().await;
    let runtime_recovery_required = recovery.is_err();
    let mut message = match recovery {
        Ok(()) => format!("切换移动端连接失败，已恢复原配置: {start_error}"),
        Err(recovery_error) => {
            format!("切换移动端连接失败: {start_error}; 恢复原运行配置失败: {recovery_error}")
        }
    };
    let (authoritative_enabled, recovery_required) = match current() {
        Ok(enabled) => (Some(enabled), runtime_recovery_required),
        Err(error) => {
            message.push_str(&format!("; {error}"));
            (None, true)
        }
    };
    Err(MobileLanSetError::new(
        message,
        authoritative_enabled,
        recovery_required,
    ))
}

/// Flip the per-profile LAN opt-in, rewrite the gateway bind to match, and
/// restart the gateway child so the new bind takes effect (a running child's
/// bind is frozen at spawn). Returns the resulting state (incl. the LAN URL).
pub(crate) async fn set_mobile_lan_enabled(
    app: &AppHandle,
    profile: &str,
    enabled: bool,
) -> Result<MobileLanState, MobileLanSetError> {
    let shutdown_guard =
        crate::commands::openclaw_connection::local_gateway_shutdown_guard(app).await;
    let marker_path = mobile_lan_marker_path(profile)
        .map_err(|message| mobile_lan_set_error(message, profile))?;
    let config_path = openclaw_gateway::openclaw_config_path_for_profile(Some(profile))
        .map_err(|message| mobile_lan_set_error(message, profile))?;
    let port = crate::services::openclaw_connection::local_gateway_port();
    let rollback = commit_mobile_lan_files(
        &marker_path,
        &config_path,
        enabled,
        || ensure_local_profile_gateway_config(profile, port).map(|_| ()),
        || stop_gateway_for_profile_under_shutdown_guard(app),
    )
    .await
    .map_err(|message| mobile_lan_set_error(message, profile))?;
    drop(shutdown_guard);
    let start_input = || crate::commands::openclaw_connection::GatewayConnectionProfileInput {
        profile: Some(profile.to_string()),
        gateway_port: None,
        cloud_agent_api_url: None,
        cloud_agent_auth_token: None,
        cloud_agent_token_expires_at: None,
        cloud_agent_id: None,
    };
    complete_mobile_lan_restart(
        || async {
            crate::commands::openclaw_connection::openclaw_connection_start_local_for_runtime(
                app.clone(),
                start_input(),
            )
            .await
            .map(|_| ())
        },
        || async {
            finish_mobile_lan_recovery(
                || async {
                    let recovery_guard =
                        crate::commands::openclaw_connection::local_gateway_shutdown_guard(app)
                            .await;
                    let restore = rollback.restore(&marker_path, &config_path);
                    let stopped = stop_gateway_for_profile_under_shutdown_guard(app).await;
                    let authority = mobile_lan_authority_from_paths(&marker_path, &config_path);
                    drop(recovery_guard);
                    (restore, stopped, authority)
                },
                || async {
                    crate::commands::openclaw_connection::openclaw_connection_start_local_for_runtime(
                        app.clone(),
                        start_input(),
                    )
                    .await
                    .map(|_| ())
                },
            )
            .await
        },
        || mobile_lan_authority_from_paths(&marker_path, &config_path),
    )
    .await?;
    Ok(mobile_lan_state(profile))
}

fn apply_local_profile_gateway_config(
    config: &mut Value,
    gateway_port: u16,
    allow_lan: bool,
) -> bool {
    let mut changed = false;
    let gateway = object_child_mut(config, "gateway");
    changed |= set_object_value(gateway, "mode", Value::String("local".to_string()));
    // Default is loopback-only (hardening). LAN bind is opt-in per profile and
    // is safe only because a non-loopback bind still requires gateway auth — the
    // spawned gateway runs `--auth password`, so the LAN is not left open.
    let bind = if allow_lan { "lan" } else { "loopback" };
    changed |= set_object_value(gateway, "bind", Value::String(bind.to_string()));
    changed |= set_object_value(
        gateway,
        "port",
        Value::Number(serde_json::Number::from(gateway_port)),
    );
    if gateway
        .as_object_mut()
        .and_then(|object| object.remove("remote"))
        .is_some()
    {
        changed = true;
    }
    changed |= apply_openclaw_profile_isolation_config(config);
    changed
}

pub(crate) fn ensure_local_profile_gateway_config(
    profile: &str,
    gateway_port: u16,
) -> Result<bool, String> {
    let path = openclaw_gateway::openclaw_config_path_for_profile(Some(profile))?;
    let mut config = openclaw_gateway::load_openclaw_config_for_profile(Some(profile))?;
    let allow_lan = mobile_lan_enabled_for_profile(profile);
    let changed = apply_local_profile_gateway_config(&mut config, gateway_port, allow_lan);
    if !changed && path.exists() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "创建 Uniopc 引擎 profile 配置目录失败 {}: {e}",
                parent.to_string_lossy()
            )
        })?;
    }
    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化 Uniopc 引擎 profile 配置失败: {e}"))?;
    fs::write(&path, format!("{serialized}\n")).map_err(|e| {
        format!(
            "写入 Uniopc 引擎 profile 配置失败 {}: {e}",
            path.to_string_lossy()
        )
    })?;
    Ok(changed)
}

fn ensure_profile_local_discovery_disabled(profile: &str) -> Result<bool, String> {
    let path = openclaw_gateway::openclaw_config_path_for_profile(Some(profile))?;
    let mut config = openclaw_gateway::load_openclaw_config_for_profile(Some(profile))?;
    let changed = apply_openclaw_profile_isolation_config(&mut config);
    if !changed {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "创建 Uniopc 引擎 profile 配置目录失败 {}: {e}",
                parent.to_string_lossy()
            )
        })?;
    }
    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化 Uniopc 引擎 profile 配置失败: {e}"))?;
    fs::write(&path, format!("{serialized}\n")).map_err(|e| {
        format!(
            "写入 Uniopc 引擎 profile 配置失败 {}: {e}",
            path.to_string_lossy()
        )
    })?;
    Ok(true)
}

fn extract_version_number(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|part| part.chars().any(|c| c.is_ascii_digit()) && part.contains('.'))
        .map(|part| {
            part.trim_matches(|c: char| {
                !(c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
            })
            .to_string()
        })
}

fn parse_version_parts(version: &str) -> Vec<u64> {
    version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

fn is_newer_version(latest: &str, current: &str) -> Option<bool> {
    let latest_parts = parse_version_parts(latest);
    let current_parts = parse_version_parts(current);
    if latest_parts.is_empty() || current_parts.is_empty() {
        return None;
    }

    let max_len = latest_parts.len().max(current_parts.len());
    for index in 0..max_len {
        let latest_part = *latest_parts.get(index).unwrap_or(&0);
        let current_part = *current_parts.get(index).unwrap_or(&0);
        if latest_part > current_part {
            return Some(true);
        }
        if latest_part < current_part {
            return Some(false);
        }
    }

    Some(false)
}

#[derive(Debug, Clone)]
struct OpenClawRuntimeCompatibility {
    ready: bool,
    message: Option<String>,
}

fn json_string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_package_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn profile_dir_for_openclaw_runtime(profile: Option<&str>) -> Option<PathBuf> {
    let config_path = openclaw_gateway::openclaw_config_path_for_profile(profile).ok()?;
    config_path.parent().map(Path::to_path_buf)
}

fn profile_codex_package_json(profile: Option<&str>) -> Option<Value> {
    let profile_dir = profile_dir_for_openclaw_runtime(profile)?;
    read_package_json(
        &profile_dir
            .join("npm")
            .join("node_modules")
            .join("@openclaw")
            .join("codex")
            .join("package.json"),
    )
}

fn openclaw_installed_package_version() -> Option<String> {
    let current = uniopc_runtime_paths::runtime_current_dir().ok()?;
    openclaw_bundled_runtime::installed_openclaw_version(&current)
}

fn codex_plugin_required_openclaw_version(package: &Value) -> Option<String> {
    package
        .get("peerDependencies")
        .and_then(|deps| deps.get("openclaw"))
        .and_then(Value::as_str)
        .and_then(extract_version_number)
}

fn codex_runtime_compatibility(
    profile: Option<&str>,
    host_version: Option<&str>,
) -> OpenClawRuntimeCompatibility {
    let Some(package) = profile_codex_package_json(profile) else {
        return OpenClawRuntimeCompatibility {
            ready: true,
            message: None,
        };
    };
    let plugin_version = json_string_field(&package, "version");
    let required_version =
        codex_plugin_required_openclaw_version(&package).or_else(|| plugin_version.clone());
    let host = host_version
        .and_then(extract_version_number)
        .or_else(openclaw_installed_package_version);

    let incompatible = match (required_version.as_deref(), host.as_deref()) {
        (Some(required), Some(current)) => {
            matches!(is_newer_version(required, current), Some(true))
        }
        _ => false,
    };
    if !incompatible {
        return OpenClawRuntimeCompatibility {
            ready: true,
            message: None,
        };
    }

    let plugin_label = plugin_version.unwrap_or_else(|| "未知版本".to_string());
    let required_label = required_version.unwrap_or_else(|| "较新版本".to_string());
    let host_label = host.unwrap_or_else(|| "未知版本".to_string());
    OpenClawRuntimeCompatibility {
        ready: false,
        message: Some(format!(
            "当前 @openclaw/codex {plugin_label} 需要 Uniopc 引擎 {required_label}+，本机 Uniopc 引擎 是 {host_label}。请先更新 Uniopc 引擎 并重启 Gateway。"
        )),
    }
}

fn openclaw_version_is_supported(version: Option<&str>) -> bool {
    version.is_some_and(is_exact_engine_version)
}

fn shell_program_and_args(command: &str) -> (&'static str, Vec<String>) {
    if cfg!(target_os = "windows") {
        (
            "powershell",
            vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-Command".to_string(),
                command.to_string(),
            ],
        )
    } else {
        ("sh", vec!["-lc".to_string(), command.to_string()])
    }
}

fn output_to_string(bytes: &[u8]) -> String {
    crate::services::white_label::sanitize_runtime_text(
        strip_ansi_sequences(&String::from_utf8_lossy(bytes)).trim(),
    )
}

fn command_event_output_text(bytes: &[u8]) -> Option<String> {
    let text = output_to_string(bytes);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn tail_lines(text: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

fn append_streaming_output(log: &mut String, line: &str, max_lines: usize) {
    if !log.is_empty() {
        log.push('\n');
    }
    log.push_str(line);
    *log = tail_lines(log, max_lines);
}

async fn shell_output(app: &AppHandle, command: &str) -> Result<String, String> {
    let (program, args) = shell_program_and_args(command);
    let output = app
        .shell()
        .command(program)
        .env("PATH", openclaw_augmented_path(None))
        .envs(cli_proxy_env())
        .envs(openclaw_state_env(&args))
        .args(args)
        .output()
        .await
        .map_err(|e| format!("执行命令失败: {e}"))?;

    let stdout = output_to_string(&output.stdout);
    let stderr = output_to_string(&output.stderr);
    let combined = [stdout.as_str(), stderr.as_str()]
        .into_iter()
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    if output.status.success() {
        Ok(combined)
    } else {
        Err(tail_lines(&combined, 20))
    }
}

// Resolve a program to spawn, enforcing "core engine = bundled runtime only".
// `spawnable_command` returns the bundled `openclaw` as an absolute path when it
// exists; if it comes back still unresolved (plain `"openclaw"`), the bundle is
// not present. In that case we refuse to fall back to a system install and fail
// loud — unless this is a dev build with no pinned version compiled in.
fn resolve_spawn_program(program: &str, args: &[String]) -> Result<(String, Vec<String>), String> {
    let (resolved_program, resolved_args) =
        crate::services::openclaw_cli::spawnable_command(program, args);
    if program == "openclaw"
        && resolved_program == "openclaw"
        && imai_openclaw_install_version() != "latest"
    {
        return Err(
            "内置 Uniopc 引擎运行时不可用（尚未激活或制品缺失）。请到「运行环境 → 版本」重新安装兼容版本后重试；不会回退到系统 openclaw。"
                .to_string(),
        );
    }
    Ok((resolved_program, resolved_args))
}

// ── Local gateway as an app-owned child process (pure sidecar model) ─────────
//
// Terminology anchor: "sidecar" throughout this codebase means the architectural
// pattern — a companion process whose lifecycle is coupled to the app — NOT
// Tauri's externalBin / `shell().sidecar()` mechanism. This app bundles no
// externalBin; the engine ships as a `resources/` tarball extracted at first
// launch, and the gateway is spawned via raw tokio below (see
// `spawn_local_gateway_child`). The accurate label is `GatewaySupervisor`.
//
// The app spawns `openclaw gateway run --port` on demand and kills it when the
// app quits (Cmd+Q). No system service; nothing survives the app. Modeled on
// `GatewayTunnelSupervisor` (raw tokio child so we can `try_wait`/`start_kill`
// without an event-stream monitor).
//
// Auth is basic (`--auth password`), single-writer: the app mints ONE password
// per process run (see `openclaw_connection::local_gateway_password`) and is both
// the server (passes it to the child via env) and the only client (injects it
// when resolving the local endpoint). The two sides can never diverge, so
// `auth_token_mismatch` — the failure mode of the old ed25519 device-auth/pairing
// path — is structurally impossible for the local gateway. Device auth + pairing
// remain for remote connections, where there genuinely are two independent parties.
// Respawn circuit breaker. `ensure_running` respawns whenever the held child has
// exited; with a child that crashes right after spawn (corrupt config, missing
// runtime, port bind loss) that turns into an unbounded reclaim→spawn→die grind
// on every connect retry. These bound it: a child that dies before living
// `GATEWAY_RESPAWN_STABLE_UPTIME` counts as a fast death; consecutive fast deaths
// throttle respawns on a backoff ladder and, past `GATEWAY_RESPAWN_CIRCUIT_THRESHOLD`,
// open the circuit — `ensure_running` then refuses for `GATEWAY_RESPAWN_CIRCUIT_COOLDOWN`
// and returns a terminal, actionable error (see the engine log on the runtime
// page) instead of retrying forever. A child that lives past the stable window,
// or any explicit `stop()`, resets the counter.
const GATEWAY_RESPAWN_STABLE_UPTIME: Duration = Duration::from_secs(15);
const GATEWAY_RESPAWN_CIRCUIT_THRESHOLD: u32 = 5;
const GATEWAY_RESPAWN_CIRCUIT_COOLDOWN: Duration = Duration::from_secs(60);
const GATEWAY_RESPAWN_BACKOFF_MS: &[u64] = &[500, 1_000, 2_000, 4_000];

/// Minimum spacing before the next respawn attempt given `count` consecutive fast
/// deaths (only consulted for `count` in `1..THRESHOLD`).
fn gateway_respawn_backoff(count: u32) -> Duration {
    let idx = (count.saturating_sub(1) as usize).min(GATEWAY_RESPAWN_BACKOFF_MS.len() - 1);
    Duration::from_millis(GATEWAY_RESPAWN_BACKOFF_MS[idx])
}

#[derive(Debug, PartialEq, Eq)]
enum RespawnDecision {
    /// Clear to spawn now.
    Spawn,
    /// Within the backoff window after a fast death — a transient "retrying" state.
    Throttled,
    /// Too many consecutive fast deaths and still inside the cooldown — give up
    /// (terminal, actionable error) until the cooldown elapses (then half-open).
    CircuitOpen,
}

/// Pure gate decision: given the consecutive-fast-death `count` and how long since
/// the last spawn attempt, decide whether to spawn, throttle, or stay open.
fn gateway_respawn_decision(count: u32, since_last_attempt: Option<Duration>) -> RespawnDecision {
    if count == 0 {
        return RespawnDecision::Spawn;
    }
    let Some(elapsed) = since_last_attempt else {
        return RespawnDecision::Spawn;
    };
    if count >= GATEWAY_RESPAWN_CIRCUIT_THRESHOLD {
        // Half-open once the cooldown passes; otherwise the circuit stays open.
        if elapsed >= GATEWAY_RESPAWN_CIRCUIT_COOLDOWN {
            RespawnDecision::Spawn
        } else {
            RespawnDecision::CircuitOpen
        }
    } else if elapsed >= gateway_respawn_backoff(count) {
        RespawnDecision::Spawn
    } else {
        RespawnDecision::Throttled
    }
}

/// Next fast-death `count` after a child exited having lived `lived`: a death
/// before the stable window increments; living past it (a legit long run that
/// then exited) resets to zero so the next crash starts fresh.
fn gateway_respawn_count_after_exit(lived: Duration, count: u32) -> u32 {
    if lived < GATEWAY_RESPAWN_STABLE_UPTIME {
        count.saturating_add(1)
    } else {
        0
    }
}

#[derive(Default)]
struct RespawnTracker {
    consecutive_fast_deaths: u32,
    last_attempt_at: Option<Instant>,
}

#[derive(Default)]
pub struct GatewaySupervisor {
    child: tokio::sync::Mutex<Option<GatewayChild>>,
    spawn_count: std::sync::atomic::AtomicU64,
    // Fast-death circuit-breaker state. A std mutex held only for synchronous
    // read/update (never across an `.await`), so it can't deadlock with `child`.
    respawn: std::sync::Mutex<RespawnTracker>,
    startup_allowance: std::sync::Mutex<crate::services::gateway_startup_progress::Allowance>,
    recovery_blocked: std::sync::atomic::AtomicBool,
}

struct GatewayChild {
    process: tokio::process::Child,
    // Active profile key at spawn time. The child's OPENCLAW_STATE_DIR/HOME env
    // was resolved from it and is frozen for the child's lifetime, so a caller
    // acting for a different account must NOT reuse this child (it would read
    // and write the previous account's state).
    profile: Option<String>,
    /// Verified bundled runtime identity used to spawn this child. A live
    /// child from a previous runtime must be restarted before a healthy
    /// connection can authorize old-runtime cleanup.
    runtime_id: String,
    // When this child was spawned — how the breaker tells a fast death (crash
    // right after spawn) from a healthy engine that later exited.
    spawned_at: Instant,
    identity: u64,
    generation: u64,
    progress: std::sync::Arc<std::sync::Mutex<crate::services::gateway_startup_progress::Progress>>,
    #[cfg(windows)]
    launch: FrozenGatewayLaunch,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
}

fn gateway_runtime_matches_active(active_runtime_id: Option<&str>, child_runtime_id: &str) -> bool {
    active_runtime_id.is_some_and(|active| active == child_runtime_id)
}

fn require_verified_openclaw_runtime(verified: bool) -> Result<(), String> {
    verified
        .then_some(())
        .ok_or_else(|| "OpenClaw 8.1 运行时未验证。".to_string())
}

// Leave time for OpenClaw's async server close and clean_stop lifecycle write.
// Busy or stuck engines remain bounded; a forced exit must stay visible as an
// unclean boot rather than forging or deleting the engine's breaker history.
#[cfg(unix)]
const GATEWAY_STOP_GRACE: Duration = Duration::from_secs(30);

#[cfg(unix)]
fn owned_child_exit_is_pending_reap(pid: u32) -> std::io::Result<bool> {
    // SAFETY: zero is a valid initial siginfo_t; waitid writes within this
    // allocated value. WNOWAIT observes exit without consuming child ownership.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == -1 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: waitid initializes the SIGCHLD layout read by this accessor.
    Ok(unsafe { info.si_pid() } != 0)
}

#[cfg(unix)]
async fn stop_owned_unix_gateway_process(
    process: &mut tokio::process::Child,
    grace: Duration,
) -> std::io::Result<std::process::ExitStatus> {
    let Some(pid) = process.id() else {
        return process.wait().await;
    };
    let group = -(pid as libc::pid_t);
    // SAFETY: this child was spawned with process_group(0), and its unreaped
    // leader pins the PID/PGID until the sole owner below calls wait().
    unsafe {
        libc::kill(group, libc::SIGTERM);
    }
    let graceful = tokio::time::timeout(grace, async {
        loop {
            match owned_child_exit_is_pending_reap(pid) {
                Ok(true) => return Ok::<_, std::io::Error>(()),
                Ok(false) => {}
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    match graceful {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            eprintln!("[uniopc] gateway non-reaping exit check failed: {error}");
            // Never signal a saved PGID after any fallback has reaped it. If
            // try_wait still reports a live owned child, it remains safe to kill.
            if let Some(status) = process.try_wait()? {
                return Ok(status);
            }
        }
        Err(_) => eprintln!(
            "[uniopc] gateway did not stop within {grace:?}; forcing owned process group exit"
        ),
    }
    // Even a clean leader can leave a TERM-ignoring descendant. WNOWAIT kept
    // the leader unreaped, so this group cannot have been recycled for another
    // process. Its clean exit status/cleanup marker is preserved by SIGKILL.
    unsafe {
        libc::kill(group, libc::SIGKILL);
    }
    let _ = process.start_kill();
    process.wait().await
}

impl GatewaySupervisor {
    /// A coordinator generation identifies a flight, not a process. Rebind
    /// only the exact live profile/runtime child while holding its ownership lock.
    pub async fn bind_startup_flight(
        &self,
        profile: &str,
        runtime: &str,
        generation: u64,
        check: impl Fn() -> Result<(), String> + Send + Sync,
    ) -> Result<bool, String> {
        check()?;
        let mut guard = self.child.lock().await;
        check()?;
        let Some(child) = guard.as_mut() else {
            return Ok(false);
        };
        if child.profile.as_deref() != Some(profile)
            || child.runtime_id != runtime
            || generation < child.generation
        {
            return Err("gateway_startup_identity_changed".into());
        }
        if !matches!(child.process.try_wait(), Ok(None)) {
            return Ok(false);
        }
        let mut allowance = self
            .startup_allowance
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        check()?;
        child.generation = generation;
        allowance.enter_episode(Some(profile), runtime);
        Ok(true)
    }

    pub async fn startup_http_observer(
        &self,
        profile: &str,
        generation: u64,
    ) -> Option<std::sync::Arc<std::sync::Mutex<crate::services::gateway_startup_progress::Progress>>>
    {
        let guard = self.child.lock().await;
        guard
            .as_ref()
            .filter(|c| c.profile.as_deref() == Some(profile) && c.generation == generation)
            .map(|c| c.progress.clone())
    }

    pub async fn startup_finalized(
        &self,
        profile: &str,
        generation: u64,
        check: impl Fn() -> Result<(), String> + Send + Sync,
    ) -> Result<(), String> {
        check()?;
        let mut guard = self.child.lock().await;
        check()?;
        let child = guard
            .as_mut()
            .filter(|c| c.profile.as_deref() == Some(profile) && c.generation == generation)
            .ok_or("gateway_startup_identity_changed")?;
        if !matches!(child.process.try_wait(), Ok(None)) {
            return Err("gateway_owned_child_exited".into());
        }
        // No await may separate this final cancellation/generation check from
        // anchoring/resetting the episode allowance.
        let mut allowance = self
            .startup_allowance
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        check()?;
        allowance.finalized(child.identity, Instant::now());
        Ok(())
    }

    /// Recovery never calls ensure_running: that path reclaims orphans and
    /// prepares mutable config. All validation and allowance consumption occur
    /// under the sole child lock; uncertainty keeps the dead child held.
    pub async fn recover_stalled_startup(
        &self,
        profile: &str,
        generation: u64,
        deadline: tokio::time::Instant,
        check: impl Fn() -> Result<(), String> + Send + Sync,
    ) -> Result<bool, String> {
        #[cfg(not(windows))]
        {
            let _ = (profile, generation, deadline, check);
            Ok(false)
        }
        #[cfg(windows)]
        {
            check()?;
            if self
                .recovery_blocked
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err("gateway_startup_termination_unconfirmed".into());
            }
            crate::commands::openclaw_connection::ensure_local_gateway_generation(generation)?;
            if crate::services::uniopc_runtime_paths::read_active_profile_key().as_deref()
                != Some(profile)
            {
                return Err("gateway_startup_identity_changed".into());
            }
            let mut guard = self.child.lock().await;
            let Some(child) = guard.as_mut() else {
                return Ok(false);
            };
            struct Poll<'a> {
                supervisor: &'a GatewaySupervisor,
                child: &'a mut GatewayChild,
                profile: &'a str,
                generation: u64,
                identity: u64,
                runtime: String,
                deadline: tokio::time::Instant,
                check: &'a (dyn Fn() -> Result<(), String> + Send + Sync),
            }
            impl crate::services::gateway_startup_progress::RecoveryPoll for Poll<'_> {
                fn check_identity(&mut self) -> Result<bool, String> {
                    (self.check)()?;
                    crate::commands::openclaw_connection::ensure_local_gateway_generation(
                        self.generation,
                    )?;
                    if self.child.identity != self.identity
                        || self.child.generation != self.generation
                        || self.child.profile.as_deref() != Some(self.profile)
                        || self.child.runtime_id != self.runtime
                        || crate::services::uniopc_runtime_paths::read_active_profile_key().as_deref() != Some(self.profile)
                        || !crate::services::openclaw_bundled_runtime::unverified_recovery_runtime_identity()
                            .is_some_and(|identity| identity.matches_runtime(&self.runtime))
                    {
                        return Err("gateway_startup_identity_changed".into());
                    }
                    Ok(matches!(self.child.process.try_wait(), Ok(None)))
                }
                fn eligible(&self) -> bool {
                    self.child
                        .progress
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .eligible(
                            Instant::now(),
                            self.deadline
                                .saturating_duration_since(tokio::time::Instant::now()),
                        )
                }
                fn allowance_available(&self) -> bool {
                    self.supervisor
                        .startup_allowance
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .available()
                }
                fn verify_runtime_and_config(&self) -> Result<(), String> {
                    if crate::services::openclaw_bundled_runtime::current_runtime_version()
                        .as_deref()
                        != Some(self.runtime.as_str())
                    {
                        return Err("gateway_startup_identity_changed".into());
                    }
                    self.child.launch.verify_config()
                }
                fn commit(&mut self) -> Result<bool, String> {
                    // Headers/listening cannot race the final identity check and consume.
                    let progress = self.child.progress.clone();
                    let progress = progress.lock().unwrap_or_else(|e| e.into_inner());
                    if !self.check_identity()?
                        || !progress.eligible(
                            Instant::now(),
                            self.deadline
                                .saturating_duration_since(tokio::time::Instant::now()),
                        )
                    {
                        return Ok(false);
                    }
                    let mut allowance = self
                        .supervisor
                        .startup_allowance
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    (self.check)()?;
                    if !allowance.consume() {
                        return Ok(false);
                    }
                    self.supervisor
                        .recovery_blocked
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    crate::services::owned_command::request_job_termination(&self.child.job)
                        .map_err(|_| "gateway_startup_termination_unconfirmed".to_string())?;
                    Ok(true)
                }
            }
            let identity = child.identity;
            let runtime = child.runtime_id.clone();
            if !crate::services::gateway_startup_progress::poll_recovery(&mut Poll {
                supervisor: self,
                child,
                profile,
                generation,
                identity,
                runtime,
                deadline,
                check: &check,
            })? {
                return Ok(false);
            }
            let launch = child.launch.clone();
            let runtime = child.runtime_id.clone();
            let identity = self.spawn_count() + 1;
            crate::services::owned_command::confirm_job_termination(&child.job, &mut child.process)
                .await
                .map_err(|_| "gateway_startup_termination_unconfirmed")?;
            check()?;
            crate::commands::openclaw_connection::ensure_local_gateway_generation(generation)?;
            if crate::services::uniopc_runtime_paths::read_active_profile_key().as_deref()
                != Some(profile)
            {
                return Err("gateway_startup_identity_changed".into());
            }
            if crate::services::openclaw_bundled_runtime::current_runtime_version().as_deref()
                != Some(runtime.as_str())
            {
                return Err("gateway_startup_identity_changed".into());
            }
            let replacement = launch
                .spawn(Some(profile.to_owned()), runtime, generation, identity)
                .await?;
            check()?;
            crate::commands::openclaw_connection::ensure_local_gateway_generation(generation)?;
            if crate::services::uniopc_runtime_paths::read_active_profile_key().as_deref()
                != Some(profile)
            {
                return Err("gateway_startup_identity_changed".into());
            }
            if crate::services::openclaw_bundled_runtime::current_runtime_version().as_deref()
                != Some(replacement.runtime_id.as_str())
            {
                return Err("gateway_startup_identity_changed".into());
            }
            if let Some(pid) = replacement.process.id() {
                crate::services::openclaw_connection::write_gateway_endpoint_record(
                    None,
                    launch.port,
                    pid,
                    generation,
                    gateway_process_creation_time(pid),
                );
            }
            *guard = Some(replacement);
            self.spawn_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.recovery_blocked
                .store(false, std::sync::atomic::Ordering::SeqCst);
            Ok(true)
        }
    }
    pub fn spawn_count(&self) -> u64 {
        self.spawn_count.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Ensure the local gateway child is running. Idempotent: if the held child
    /// is still alive, no-op; if it exited, respawn. Clears any stray gateway on
    /// our port (from a previously crashed app) before spawning.
    pub async fn ensure_running(&self) -> Result<(), String> {
        if self.recovery_blocked.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("gateway_startup_termination_unconfirmed".into());
        }
        let active_runtime_id = crate::services::openclaw_bundled_runtime::current_runtime_version()
            .ok_or_else(|| "OpenClaw 8.1 运行时未验证。".to_string())?;
        require_verified_openclaw_runtime(true)?;
        let runtime_mismatch = {
            let mut guard = self.child.lock().await;
            guard.as_mut().is_some_and(|child| {
                matches!(child.process.try_wait(), Ok(None))
                    && child.runtime_id != active_runtime_id
            })
        };
        if runtime_mismatch {
            self.stop().await;
        }
        let now = Instant::now();
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            if matches!(child.process.try_wait(), Ok(None)) {
                // Alive and past the stable window → the engine is healthy; forget
                // any earlier transient deaths so a future crash starts fresh.
                if now.duration_since(child.spawned_at) >= GATEWAY_RESPAWN_STABLE_UPTIME {
                    let mut tracker = self.respawn.lock().unwrap_or_else(|e| e.into_inner());
                    tracker.consecutive_fast_deaths = 0;
                }
                return Ok(());
            }
            // The child we spawned has exited. Classify it as a fast death (crash
            // right after spawn) or a healthy run that later ended.
            let lived = now.duration_since(child.spawned_at);
            *guard = None;
            let mut tracker = self.respawn.lock().unwrap_or_else(|e| e.into_inner());
            tracker.consecutive_fast_deaths =
                gateway_respawn_count_after_exit(lived, tracker.consecutive_fast_deaths);
        }

        // Respawn gate: throttle (backoff) or refuse (circuit open) if the child
        // keeps dying fast, instead of grinding reclaim→spawn→die forever.
        {
            let mut tracker = self.respawn.lock().unwrap_or_else(|e| e.into_inner());
            let since = tracker.last_attempt_at.map(|at| now.duration_since(at));
            match gateway_respawn_decision(tracker.consecutive_fast_deaths, since) {
                RespawnDecision::Spawn => {}
                RespawnDecision::Throttled => {
                    return Err("Uniopc 引擎 正在重启，请稍候…".to_string());
                }
                RespawnDecision::CircuitOpen => {
                    return Err(
                        "Uniopc 引擎 连续多次启动失败，已暂停自动重试。请打开「Uniopc 引擎 版本管理」查看引擎日志排查后重试。".to_string(),
                    );
                }
            }
            tracker.last_attempt_at = Some(now);
        }

        // Kill any orphan engine this profile left behind BEFORE binding a port:
        // a dynamic port would otherwise land the fresh engine on a different
        // port while the orphan keeps writing the same state/<profile> sqlite.
        reclaim_orphan_engines_before_start()?;
        let port = crate::services::openclaw_connection::pick_local_gateway_port();
        let active_profile = crate::services::uniopc_runtime_paths::read_active_profile_key();
        self.startup_allowance.lock().unwrap_or_else(|e| e.into_inner()).enter_episode(active_profile.as_deref(), &active_runtime_id);
        let mut child = match spawn_local_gateway_child(port, active_profile.as_deref()).await {
            Ok(child) => child,
            Err(error) => {
                // A spawn that can't even exec is itself a fast death — count it so
                // a persistent exec failure trips the breaker too.
                let mut tracker = self.respawn.lock().unwrap_or_else(|e| e.into_inner());
                tracker.consecutive_fast_deaths = tracker.consecutive_fast_deaths.saturating_add(1);
                return Err(error);
            }
        };
        if crate::services::openclaw_bundled_runtime::current_runtime_version().as_deref()
            != Some(active_runtime_id.as_str())
        {
            let _ = child.process.start_kill();
            let _ = child.process.wait().await;
            return Err("引擎运行时在 Gateway 启动期间发生变化，请重试。".to_string());
        }
        // Publish the bound port (every local resolver reads it) and record it +
        // the child pid so the next launch can reclaim this engine if we crash.
        crate::services::openclaw_connection::set_local_gateway_port(port);
        if let Some(pid) = child.process.id() {
            crate::services::openclaw_connection::write_gateway_endpoint_record(
                None,
                port,
                pid,
                crate::commands::openclaw_connection::local_gateway_generation(),
                gateway_process_creation_time(pid),
            );
        }
        child.identity = self.spawn_count() + 1;
        *guard = Some(child);
        self.spawn_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    /// Ensure the running child serves `profile`: a live child spawned for a
    /// different account is torn down and respawned (its state env is frozen at
    /// spawn), a matching or absent child goes through plain `ensure_running`.
    pub async fn ensure_running_for(&self, profile: &str) -> Result<(), String> {
        let mismatch = {
            let mut guard = self.child.lock().await;
            match guard.as_mut() {
                Some(child) => {
                    matches!(child.process.try_wait(), Ok(None))
                        && child.profile.as_deref() != Some(profile)
                }
                None => false,
            }
        };
        if mismatch {
            self.stop().await;
        }
        self.ensure_running().await
    }

    /// True when we hold a child that has not yet exited.
    pub async fn is_running(&self) -> bool {
        let mut guard = self.child.lock().await;
        match guard.as_mut() {
            Some(child) => matches!(child.process.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// The profile key the live child was spawned for (None: no live child, or
    /// spawned before any account was active).
    pub async fn running_profile(&self) -> Option<String> {
        let mut guard = self.child.lock().await;
        let child = guard.as_mut()?;
        if matches!(child.process.try_wait(), Ok(None)) {
            child.profile.clone()
        } else {
            None
        }
    }

    pub async fn running_runtime_matches_active(&self) -> bool {
        self.running_runtime_id_if_active().await.is_some()
    }

    pub async fn running_runtime_id_if_active(&self) -> Option<String> {
        let Some(active_runtime_id) =
            crate::services::openclaw_bundled_runtime::current_runtime_version()
        else {
            return None;
        };
        let mut guard = self.child.lock().await;
        guard.as_mut().and_then(|child| {
            (matches!(child.process.try_wait(), Ok(None))
                && gateway_runtime_matches_active(Some(&active_runtime_id), &child.runtime_id))
            .then(|| child.runtime_id.clone())
        })
    }

    /// Kill the gateway child (called on app quit). The child leads its own
    /// process group (see `spawn_local_gateway_child`), so we signal the whole
    /// group first — the gateway's Node grandchildren die with it instead of
    /// orphaning — then reap the leader.
    pub async fn stop(&self) {
        // An explicit stop is a fresh intent (app quit, account switch, or a
        // deliberate restart): clear the breaker so the next spawn isn't gated by
        // an earlier account's crash history. Automatic death-driven respawns
        // never call stop() (they null the child directly), so this can't erase
        // the fast-death count they accumulate.
        {
            let mut tracker = self.respawn.lock().unwrap_or_else(|e| e.into_inner());
            tracker.consecutive_fast_deaths = 0;
            tracker.last_attempt_at = None;
        }
        let mut guard = self.child.lock().await;
        self.startup_allowance.lock().unwrap_or_else(|e| e.into_inner()).detached();
        if let Some(mut child) = guard.take() {
            #[cfg(unix)]
            let _ = stop_owned_unix_gateway_process(&mut child.process, GATEWAY_STOP_GRACE).await;
            #[cfg(windows)]
            let _ = crate::services::owned_command::terminate_job(&child.job, &mut child.process).await;
            #[cfg(not(any(unix, windows)))]
            {
                let _ = child.process.start_kill();
                let _ = child.process.wait().await;
            }
        }
    }

    /// Restart the gateway child (kill + respawn). Used after the official-model
    /// token file is (re)written: the engine caches secrets in its runtime
    /// snapshot (read at boot, not per request), so a rewritten token file only
    /// takes effect on a fresh gateway — without this, a 401 re-mint writes a
    /// good token to the file but the still-running gateway keeps the revoked
    /// cached one and stays 401.
    pub async fn restart(&self) -> Result<(), String> {
        self.stop().await;
        self.ensure_running().await
    }
}

// Image generation targets our in-process loopback reverse proxy
// (`official_model_proxy`, bound to `http://127.0.0.1:<port>/v1`, same base the
// text model uses) so the per-request official token is injected in memory. But
// the bundled runtime's `openai` image provider runs its own SSRF guard that —
// unlike the text path — does NOT get the managed-proxy "configured-local-origin"
// bypass, so it rejects 127.0.0.1 as a private/loopback address with
// `Blocked hostname or private/internal/special-use IP address`. The runtime's
// `shouldAllowPrivateImageEndpoint` only trusts a `http://127.0.0.1:`/`localhost:`
// image base when this env is set. We point it at OUR own trusted loopback proxy,
// so the blast radius is exactly that one endpoint (narrower and safer than a
// blanket `browser.ssrfPolicy` private-network opt-in). The name is QA-flavored
// upstream; the version-pinned runtime means an upgrade that renames/removes it
// is a deliberate, reviewable event — `gateway_image_provider_env` is
// unit-asserted so our injection can't silently drop.
const OPENCLAW_ALLOW_LOCAL_IMAGE_PROVIDER_ENV: (&str, &str) =
    ("OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER", "1");

// Env letting the gateway child reach our trusted loopback image proxy through
// the runtime's image SSRF guard. Factored out so it is testable without a spawn.
fn gateway_image_provider_env() -> [(&'static str, &'static str); 1] {
    [OPENCLAW_ALLOW_LOCAL_IMAGE_PROVIDER_ENV]
}

// The authenticated local-document bridge is available only to the app-owned
// gateway child. Generic CLI/setup/login subprocesses must never inherit these
// credentials through `state_env_for_profile`.
fn gateway_local_documents_env() -> Vec<(String, String)> {
    crate::services::local_documents_bridge::bridge_environment()
}

// The local-document plugin authenticates each operation with both the
// turn/session context and the owning OpenClaw profile. The gateway process is
// profile-scoped already, but the plugin runs in Node and cannot infer that
// key from OPENCLAW_STATE_DIR safely. Pass it explicitly only to the app-owned
// gateway child, alongside the loopback bridge credentials.
fn gateway_profile_context_env(profile: Option<&str>) -> Vec<(String, String)> {
    let profile = profile
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(crate::services::uniopc_runtime_paths::read_active_profile_key);
    profile
        .map(|value| vec![("UNIOPC_OPENCLAW_PROFILE".to_string(), value)])
        .unwrap_or_default()
}

// Super IP renders through a plugin subprocess. Explicitly pin its output
// directory to the profile media root because that subprocess may receive a
// temporary workspace whose parent does not match OpenClaw's state layout.
// `MEDIA:<path>` is only playable by the desktop when the path is inside this
// asset-protocol scope.
fn gateway_superip_media_env(profile: Option<&str>) -> Vec<(String, String)> {
    crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(profile)
        .map(|state_dir| {
            vec![(
                "UNIOPC_SUPERIP_MEDIA_DIR".to_string(),
                state_dir.join("media").to_string_lossy().into_owned(),
            )]
        })
        .unwrap_or_default()
}

// Spawn `openclaw gateway run --port <fixed> --auth password` from the bundled
// runtime with the exact env of a normal openclaw CLI spawn (PATH → bundled bin
// first, proxy env for outbound, private OPENCLAW_STATE_DIR/HOME/WORKSPACE_DIR/
// OAUTH_DIR), plus the per-run gateway password via `OPENCLAW_GATEWAY_PASSWORD`
// (the runtime's own recommended surface — keeps the secret out of `ps` listings
// unlike `--password`).
/// Cap on the live gateway log before it is rotated to `<name>.log.prev` at the
/// next spawn, bounding on-disk size to roughly 2×CAP.
const GATEWAY_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

fn gateway_log_dir() -> Result<PathBuf, String> {
    let dir = uniopc_runtime_paths::uniopc_data_dir()?.join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 Uniopc 引擎 日志目录失败: {e}"))?;
    Ok(dir)
}

/// Per-profile gateway log path, e.g. `logs/gateway-<profile>.log`.
fn gateway_log_path(profile: Option<&str>) -> Result<PathBuf, String> {
    let key = uniopc_runtime_paths::sanitize_profile_key(
        profile
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("default"),
    );
    let dir = gateway_log_dir()?;
    let path = dir.join(format!("uniopc-engine-gateway-{key}.log"));
    migrate_legacy_gateway_log_names(&dir, &key)?;
    Ok(path)
}

fn migrate_legacy_gateway_log_names(directory: &Path, profile: &str) -> Result<(), String> {
    let legacy = directory.join(format!("gateway-{profile}.log"));
    for source in [legacy.clone(), directory.join(format!("gateway-{profile}.log.prev"))] {
        if !source.is_file() { continue; }
        let suffix = if source == legacy { String::new() } else { ".prev".to_string() };
        let destination = directory.join(format!("uniopc-engine-gateway-{profile}.log{suffix}"));
        let destination = if destination.exists() {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
            directory.join(format!("uniopc-engine-gateway-{profile}.legacy-{stamp}.log{suffix}"))
        } else { destination };
        let bytes = fs::read(&source).map_err(|error| format!("读取旧版 Uniopc 引擎日志失败: {error}"))?;
        let text = String::from_utf8_lossy(&bytes);
        let sanitized = crate::services::white_label::sanitize_runtime_text(&text);
        fs::write(&destination, sanitized).map_err(|error| format!("迁移 Uniopc 引擎日志失败: {error}"))?;
        fs::remove_file(&source).map_err(|error| format!("清理旧版 Uniopc 引擎日志失败: {error}"))?;
    }
    Ok(())
}

/// Open the gateway log for the child's stdout+stderr, rotating once if the
/// existing file is over the cap. Returns two append handles (stdout, stderr)
/// pointed at the same file so a boot failure leaves a diagnosable trail instead
/// of vanishing into `/dev/null`. Falls back to `null` on any FS error — a
/// logging problem must never block engine startup.
fn prepare_gateway_log(path: &Path) -> Result<(), String> {
    use std::io::Write;
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > GATEWAY_LOG_MAX_BYTES {
            let mut prev = path.to_path_buf();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                prev.set_file_name(format!("{name}.prev"));
                let _ = fs::rename(&path, &prev);
            }
        }
    }
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path)
        .map_err(|error| format!("创建 Uniopc 引擎日志文件失败: {error}"))?;
    // Run boundary so support can tell restarts apart in one file.
    let _ = writeln!(
        file,
        "\n===== Uniopc 引擎 gateway start {} =====",
        chrono::Utc::now().to_rfc3339()
    );
    Ok(())
}

fn forward_sanitized_gateway_output<R>(
    mut reader: R,
    path: Option<PathBuf>,
    progress: std::sync::Arc<std::sync::Mutex<crate::services::gateway_startup_progress::Progress>>,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    // Disk logging cannot delay milestone consumption or block the engine's
    // pipes. Bounded best-effort log delivery drops excess output under load.
    let (logs, mut pending) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let Some(path) = path else { return };
        let Ok(mut output) = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await
        else {
            return;
        };
        let mut line = Vec::new();
        while let Some(chunk) = pending.recv().await {
            for byte in chunk {
                if line.len() < 65536 {
                    line.push(byte);
                }
                if byte == b'\n' {
                    let text = String::from_utf8_lossy(&line);
                    let branded = crate::services::white_label::sanitize_runtime_text(&text);
                    if output.write_all(branded.as_bytes()).await.is_err() {
                        return;
                    }
                    line.clear();
                }
            }
        }
        let text = String::from_utf8_lossy(&line);
        let branded = crate::services::white_label::sanitize_runtime_text(&text);
        let _ = output.write_all(branded.as_bytes()).await;
        let _ = output.flush().await;
    });
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut chunk = [0u8; 4096];
        let mut line = Vec::with_capacity(192);
        let mut oversized = false;
        loop {
            let count = match reader.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for byte in &chunk[..count] {
                if *byte == b'\n' {
                    if !oversized {
                        if let Some(event) = crate::services::gateway_startup_progress::parse(&line)
                        {
                            progress
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .observe(event, Instant::now());
                        }
                    }
                    line.clear();
                    oversized = false;
                } else if !oversized {
                    if line.len() < 192 {
                        line.push(*byte);
                    } else {
                        line.clear();
                        oversized = true;
                    }
                }
            }
            let _ = logs.try_send(chunk[..count].to_vec());
        }
    });
}

/// Last `max_lines` of the profile's gateway log, plus its path, for the runtime
/// diagnostics page.
#[derive(serde::Serialize)]
pub struct GatewayLogTail {
    pub path: String,
    pub content: String,
    pub exists: bool,
}

fn capture_gateway_environment(
    source: &std::process::Command,
    inherited: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> BTreeMap<std::ffi::OsString, std::ffi::OsString> {
    // std::process::Command uses Windows' case-insensitive environment keys.
    // Let it merge inherited Path and explicit PATH before freezing the result.
    let mut merged = std::process::Command::new(source.get_program());
    merged.env_clear().envs(inherited);
    for (key, value) in source.get_envs() {
        match value {
            Some(value) => {
                merged.env(key, value);
            }
            None => {
                merged.env_remove(key);
            }
        }
    }
    #[cfg(windows)]
    merged.env_remove("NODE_OPTIONS");
    merged
        .get_envs()
        .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value.to_owned())))
        .collect()
}

/// Everything used for a replacement is captured before the first spawn.
/// In particular, spawn() performs no profile/config/plugin preparation.
#[derive(Clone)]
struct FrozenGatewayLaunch {
    program: std::ffi::OsString,
    args: Vec<std::ffi::OsString>,
    env: BTreeMap<std::ffi::OsString, std::ffi::OsString>,
    directory: Option<PathBuf>,
    log_path: Option<PathBuf>,
    port: u16,
    #[cfg(windows)]
    config_identity: Option<crate::services::gateway_startup_progress::ConfigIdentity>,
}
impl FrozenGatewayLaunch {
    fn capture(
        command: tokio::process::Command,
        log_path: Option<PathBuf>,
        port: u16,
    ) -> Result<Self, String> {
        let command = command.as_std();
        let env = capture_gateway_environment(command, std::env::vars_os());
        #[allow(unused_mut)]
        let mut result = Self {
            program: command.get_program().to_owned(),
            args: command.get_args().map(|a| a.to_owned()).collect(),
            env,
            directory: command.get_current_dir().map(Path::to_path_buf),
            log_path,
            port,
            #[cfg(windows)]
            config_identity: None,
        };
        #[cfg(windows)]
        {
            // Environment keys are case insensitive on Windows.
            result
                .env
                .retain(|key, _| !key.to_string_lossy().eq_ignore_ascii_case("NODE_OPTIONS"));
            let node =
                fs::canonicalize(&result.program).map_err(|_| "gateway_startup_node_unverified")?;
            let allowed = [
                crate::services::uniopc_runtime_paths::runtime_bin_dir()?,
                crate::services::uniopc_runtime_paths::runtime_tools_dir()?.join("node"),
                crate::services::uniopc_runtime_paths::runtime_node_bin_dir()?,
            ];
            if !allowed
                .iter()
                .any(|dir| fs::canonicalize(dir.join("node.exe")).ok().as_ref() == Some(&node))
            {
                return Err("gateway_startup_node_unverified".into());
            }
            // DNS is the only permitted prior preload; both paths must be
            // existing exact app-owned files, never a same-name foreign file.
            let expected_dns = fs::canonicalize(
                crate::services::uniopc_runtime_paths::uniopc_data_dir()?
                    .join("network/gateway-dns.cjs"),
            )
            .map_err(|_| "gateway_startup_launch_shape_invalid")?;
            let expected_entry = fs::canonicalize(
                Path::new(&result.program)
                    .parent()
                    .ok_or("gateway_startup_launch_shape_invalid")?
                    .join("node_modules/uniopc-engine/uniopc-engine.mjs"),
            )
            .map_err(|_| "gateway_startup_launch_shape_invalid")?;
            if result.args.len() != 9
                || result.args[0] != "--require"
                || fs::canonicalize(&result.args[1]).ok().as_ref() != Some(&expected_dns)
                || fs::canonicalize(&result.args[2]).ok().as_ref() != Some(&expected_entry)
                || result.args[3] != "gateway"
                || result.args[4] != "run"
                || result.args[5] != "--port"
                || result.args[6] != port.to_string().as_str()
                || result.args[7] != "--auth"
                || result.args[8] != "password"
            {
                return Err("gateway_startup_launch_shape_invalid".into());
            }
            let path = crate::services::uniopc_runtime_paths::uniopc_data_dir()?
                .join("network/gateway-startup.cjs");
            fs::write(
                &path,
                include_str!("../../services/gateway_startup_progress.cjs"),
            )
            .map_err(|_| "gateway_startup_preload_write_failed")?;
            result.args.splice(
                0..0,
                [std::ffi::OsString::from("--require"), path.into_os_string()],
            );
        }
        Ok(result)
    }
    #[cfg(windows)]
    fn verify_config(&self) -> Result<(), String> {
        self.config_identity
            .as_ref()
            .ok_or("gateway_startup_config_changed")?
            .verify()
    }
    async fn spawn(
        &self,
        profile: Option<String>,
        runtime_id: String,
        generation: u64,
        identity: u64,
    ) -> Result<GatewayChild, String> {
        #[cfg(windows)]
        if self.config_identity.is_some() {
            self.verify_config()?;
        }
        let mut command = tokio::process::Command::new(&self.program);
        command
            .args(&self.args)
            .env_clear()
            .envs(&self.env)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        command.env_remove("NODE_OPTIONS");
        if let Some(directory) = &self.directory {
            command.current_dir(directory);
        }
        #[cfg(windows)]
        command.stdin(std::process::Stdio::piped());
        #[cfg(not(windows))]
        command.stdin(std::process::Stdio::null());
        #[cfg(unix)]
        command.process_group(0);
        crate::services::openclaw_cli::hide_console_tokio(&mut command);
        let mut process = command
            .spawn()
            .map_err(|_| "gateway_startup_spawn_failed")?;
        #[cfg(windows)]
        let job = crate::services::owned_command::gate_gateway_child(
            &mut process,
            crate::services::owned_command::process_job,
        )
        .await
        .map_err(|_| "gateway_startup_containment_failed")?;
        let spawned_at = Instant::now();
        let progress = std::sync::Arc::new(std::sync::Mutex::new(
            crate::services::gateway_startup_progress::Progress::new(spawned_at, self.port),
        ));
        if let Some(stdout) = process.stdout.take() {
            forward_sanitized_gateway_output(stdout, self.log_path.clone(), progress.clone());
        }
        if let Some(stderr) = process.stderr.take() {
            forward_sanitized_gateway_output(stderr, self.log_path.clone(), progress.clone());
        }
        Ok(GatewayChild {
            process,
            profile,
            runtime_id,
            spawned_at,
            identity,
            generation,
            progress,
            #[cfg(windows)]
            launch: self.clone(),
            #[cfg(windows)]
            job,
        })
    }
}

async fn spawn_local_gateway_child(
    port: u16,
    profile: Option<&str>,
) -> Result<GatewayChild, String> {
    if let Some(profile) = profile {
        crate::commands::openclaw_connection::prepare_local_gateway_startup_config(profile)?;
        // OpenClaw 8.1 cannot replay assistant-side non-text media blocks:
        // its OpenAI transcript transformer treats them as text and calls
        // `text.trim()`. Remove these display-only blocks before the gateway
        // reads the transcript again. The desktop client reconstructs media
        // cards from the durable delivery metadata and message text.
        if let Err(error) = repair_openclaw_assistant_attachment_blocks(Some(profile)) {
            eprintln!("[openclaw] could not repair legacy assistant attachments: {error}");
        }
    }
    let expected_port = port;
    let port = port.to_string();
    let gateway_args: Vec<String> = vec![
        "gateway".to_string(),
        "run".to_string(),
        "--port".to_string(),
        port,
        // Basic auth, single-writer: server side of the shared per-run password.
        "--auth".to_string(),
        "password".to_string(),
    ];
    // Core engine is embedded-only: resolve `openclaw` to the bundled binary or
    // fail loud (never a system install).
    let (program, args) = resolve_spawn_program("openclaw", &gateway_args)?;
    if let Err(error) = crate::services::browser_egress::ensure(profile) {
        // Browser-only transport failure must not prevent ordinary chat startup.
        eprintln!("[browser-egress] {error}");
    }
    let (program, args) = crate::services::gateway_dns::command(program, args)?;
    let mut command = tokio::process::Command::new(&program);
    command
        .args(&args)
        .env("PATH", openclaw_augmented_path(None))
        .env(
            "OPENCLAW_GATEWAY_PASSWORD",
            crate::services::openclaw_connection::local_gateway_password(),
        )
        .envs(cli_proxy_env())
        .envs(openclaw_state_env(&gateway_args))
        .envs(gateway_local_documents_env())
        .envs(gateway_profile_context_env(profile))
        .envs(gateway_superip_media_env(profile))
        // Smart Montage resolves these app-owned paths before ever consulting
        // PATH, so final users never install FFmpeg themselves.
        .envs(
            crate::services::uniopc_runtime_paths::montage_media_runtime_env().unwrap_or_default(),
        )
        // OpenClaw 8.1 validates config before loading plugins, so plugin
        // credentials live in each entry's `config.env`, not root `env`.
        // This app-owned child is the sole place they become process vars.
        .envs(crate::commands::openclaw_plugins::gateway_plugin_private_env(profile))
        // Let the runtime's image SSRF guard trust our loopback image proxy.
        .envs(gateway_image_provider_env());
    // Capture the child's stdout/stderr to a rotating per-profile log so a boot
    // failure is diagnosable instead of discarded (see `gateway_log_stdio`).
    let log_path = gateway_log_path(profile).ok().filter(|path| prepare_gateway_log(path).is_ok());
    #[allow(unused_mut)]
    let mut launch = FrozenGatewayLaunch::capture(command, log_path, expected_port)?;
    #[cfg(windows)]
    { launch.config_identity = Some(crate::services::gateway_startup_progress::ConfigIdentity::capture(
        openclaw_gateway::openclaw_config_path_for_profile(profile)?
    )?); }
    let runtime_id = crate::services::openclaw_bundled_runtime::current_runtime_version()
        .ok_or("gateway_startup_runtime_unverified")?;
    launch.spawn(profile.map(str::to_string), runtime_id, crate::commands::openclaw_connection::local_gateway_generation(), 0).await

}

// Reclaim (kill) engines THIS app started for any profile in a previous
// run that outlived the app (crash, or a dev hot-reload that skipped the Cmd+Q
// teardown). We find it by the pid recorded in the profile's
// `gateway-endpoint.json` and verify it is really our engine (open files under
// our private data dir) before killing — pids are reused across reboots, so the
// recorded pid alone is not proof. This MUST run before we bind a fresh port:
// with a dynamic port the new engine would otherwise pick a *different* free
// port and two live engines would end up writing the same `state/<profile>`
// sqlite (corruption). A foreign process (co-installed `openclaw`, unrelated
// service) can never match the ownership check, so it is never touched.
fn required_orphan_marker(data_dir: Result<std::path::PathBuf, String>) -> Result<String, String> {
    data_dir
        .map(|dir| dir.to_string_lossy().into_owned())
        .map_err(|error| format!("无法验证旧 Uniopc 引擎所有权，已阻止启动: {error}"))
}

pub fn reclaim_orphan_engines_before_start() -> Result<(), String> {
    let marker = required_orphan_marker(crate::services::uniopc_runtime_paths::uniopc_data_dir())?;
    let active_profile = crate::services::uniopc_runtime_paths::resolve_profile_key(None);
    let records = crate::services::openclaw_connection::gateway_orphan_reclaim_scope(
        crate::services::openclaw_connection::all_gateway_endpoint_records()?,
        &active_profile,
    );
    let mut candidates = records
        .into_iter()
        .map(|record| {
            (
                record.pid as i32,
                Some(record.profile_key.clone()),
                Some(record),
            )
        })
        .collect::<Vec<_>>();
    if let Some(lock) = crate::services::openclaw_connection::read_official_gateway_lock(None) {
        if !candidates.iter().any(|(pid, _, _)| *pid == lock.pid as i32) {
            candidates.push((lock.pid as i32, Some(active_profile), None));
        }
    }
    let expected_instance_id = crate::services::openclaw_connection::gateway_owner_instance_id()?;
    for (pid, profile, record) in candidates {
        // Records can outlive their engine and pids are reused. The full command
        // line must still point into our private data directory before we act.
        let owned = process_belongs_to_uniopc_gateway(
            pid,
            &marker,
            profile.as_deref(),
            record.as_ref(),
            &expected_instance_id,
        );
        let recorded_endpoint_live = record
            .as_ref()
            .map(|record| recorded_gateway_port_accepts_connections(record.port));
        let decision = orphan_reclaim_decision(
            owned,
            process_is_live_or_unknown(pid as u32),
            recorded_endpoint_live,
        );
        if decision == OrphanReclaimDecision::Terminate {
            terminate_owned_gateway_process(
                pid,
                &marker,
                profile.as_deref(),
                record.as_ref(),
                &expected_instance_id,
            );
            let gone = (0..20).any(|_| {
                if !process_belongs_to_uniopc_gateway(
                    pid,
                    &marker,
                    profile.as_deref(),
                    record.as_ref(),
                    &expected_instance_id,
                ) {
                    true
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    false
                }
            });
            if !gone {
                return Err(format!(
                    "旧的 Uniopc 引擎进程 {pid} 无法结束；为避免同时运行多个引擎，已取消本次启动。"
                ));
            }
            if let Some(profile) = profile.as_deref() {
                crate::services::openclaw_connection::clear_gateway_endpoint_record(Some(profile));
            }
        } else if decision == OrphanReclaimDecision::ClearStaleRecord {
            // The PID is live but no longer belongs to the recorded Uniopc
            // gateway, and the endpoint it recorded is not listening. This is
            // a PID reuse after a previous gateway exit, not an engine that can
            // still write this profile. Drop only this stale record; never touch
            // the unrelated process that inherited the PID.
            if let Some(profile) = profile.as_deref() {
                crate::services::openclaw_connection::clear_gateway_endpoint_record(Some(profile));
            }
        } else if decision == OrphanReclaimDecision::Block {
            return Err(format!(
                "检测到无法验证所有权的旧 Uniopc 引擎进程 {pid}；为避免同一 profile 双写，已取消本次启动。"
            ));
        } else {
            // Preserve unverifiable/legacy evidence. A dead PID is harmless;
            // the next successful spawn atomically replaces this profile's record.
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum OrphanReclaimDecision {
    Terminate,
    ClearStaleRecord,
    Block,
    Isolate,
}

fn orphan_reclaim_decision(
    owned: bool,
    alive: bool,
    recorded_endpoint_live: Option<bool>,
) -> OrphanReclaimDecision {
    if owned {
        OrphanReclaimDecision::Terminate
    } else if alive && recorded_endpoint_live == Some(false) {
        OrphanReclaimDecision::ClearStaleRecord
    } else if alive {
        OrphanReclaimDecision::Block
    } else {
        OrphanReclaimDecision::Isolate
    }
}

fn recorded_gateway_port_accepts_connections(port: u16) -> bool {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};

    TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        std::time::Duration::from_millis(100),
    )
    .is_ok()
}

#[cfg(unix)]
fn endpoint_record_has_stable_owner(
    record: &crate::services::openclaw_connection::GatewayEndpointRecord,
    pid: i32,
    expected_profile: &str,
    expected_instance_id: &str,
) -> bool {
    record.pid == pid as u32
        && record.profile_key == expected_profile
        && record.instance_id.as_deref() == Some(expected_instance_id)
}

fn terminate_owned_gateway_process(
    pid: i32,
    marker: &str,
    profile: Option<&str>,
    record: Option<&crate::services::openclaw_connection::GatewayEndpointRecord>,
    expected_instance_id: &str,
) {
    #[cfg(windows)]
    {
        let (Some(profile), Some(record)) = (profile, record) else {
            return;
        };
        // OpenProcess pins the kernel process object. Identity is collected
        // from that handle and TerminateProcess targets the same handle, so PID
        // reuse between verification and termination cannot redirect the kill.
        if let Some(handle) = open_verified_gateway_process_handle(
            pid as u32,
            marker,
            profile,
            record,
            expected_instance_id,
        ) {
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(handle.0, 1);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .output();
        // TERM → wait → KILL: the Node runtime can ignore TERM (or a supervisor
        // relaunches it). Re-verify ownership before SIGKILL so a pid reused inside
        // the wait window is never hit. (Accio's resolve-port-conflict does the same
        // TERM→KILL escalation.)
        std::thread::sleep(std::time::Duration::from_millis(400));
        if process_belongs_to_uniopc_gateway(pid, marker, profile, record, expected_instance_id) {
            let _ = std::process::Command::new("kill")
                .arg("-KILL")
                .arg(pid.to_string())
                .output();
        }
    }
}

#[cfg(all(test, windows))]
mod gateway_process_identity_tests {
    use super::{
        orphan_reclaim_decision, required_orphan_marker, windows_command_line_is_uniopc_gateway,
        windows_process_matches_endpoint_record, OrphanReclaimDecision,
        WindowsGatewayProcessEvidence,
    };
    use crate::services::openclaw_connection::GatewayEndpointRecord;

    fn endpoint_record() -> GatewayEndpointRecord {
        GatewayEndpointRecord {
            profile_key: "profile-a".to_string(),
            port: 28790,
            pid: 4242,
            generation: 7,
            parent_pid: 100,
            instance_id: Some("desktop-instance-a".to_string()),
            process_created_at: Some("2026-09-09T05:00:02Z".to_string()),
            created_at: "2026-09-09T05:00:00Z".to_string(),
        }
    }

    fn process_evidence() -> WindowsGatewayProcessEvidence {
        WindowsGatewayProcessEvidence {
            image_path: r#"C:\Users\pc\AppData\Roaming\Uniopc\runtime\openclaw.exe"#.to_string(),
            parent_pid: 100,
            created_at: "2026-09-09T05:00:02Z".to_string(),
        }
    }

    #[test]
    fn endpoint_ownership_survives_generation_reset_but_rejects_pid_reuse_profile_or_instance() {
        let marker = r"C:\Users\pc\AppData\Roaming\Uniopc";
        let mut record = endpoint_record();
        // A restarted desktop may allocate generation 1 while this persisted
        // endpoint was launched by generation 2 in the previous process.
        record.generation = 2;
        let evidence = process_evidence();
        assert!(!windows_process_matches_endpoint_record(
            &record,
            "profile-b",
            "desktop-instance-a",
            &evidence,
            marker
        ));
        assert!(windows_process_matches_endpoint_record(
            &record,
            "profile-a",
            "desktop-instance-a",
            &evidence,
            marker
        ));
        assert!(!windows_process_matches_endpoint_record(
            &record,
            "profile-a",
            "desktop-instance-b",
            &evidence,
            marker
        ));

        let reused_pid = WindowsGatewayProcessEvidence {
            parent_pid: 999,
            created_at: "2026-09-09T06:00:00Z".to_string(),
            ..process_evidence()
        };
        assert!(!windows_process_matches_endpoint_record(
            &record,
            "profile-a",
            "desktop-instance-a",
            &reused_pid,
            marker
        ));
    }

    #[test]
    fn legacy_or_unverified_endpoint_is_never_killed_or_deleted_while_live() {
        assert_eq!(
            orphan_reclaim_decision(false, true, Some(true)),
            OrphanReclaimDecision::Block
        );
        assert_eq!(
            orphan_reclaim_decision(false, false, Some(false)),
            OrphanReclaimDecision::Isolate
        );
        assert_eq!(
            orphan_reclaim_decision(true, true, Some(true)),
            OrphanReclaimDecision::Terminate
        );
    }

    #[test]
    fn pid_reuse_with_a_closed_recorded_endpoint_is_reclaimable() {
        assert_eq!(
            orphan_reclaim_decision(false, true, Some(false)),
            OrphanReclaimDecision::ClearStaleRecord
        );
        // A lock record has no endpoint-port evidence, so it remains fail-closed.
        assert_eq!(
            orphan_reclaim_decision(false, true, None),
            OrphanReclaimDecision::Block
        );
    }

    #[test]
    fn unavailable_ownership_root_blocks_start_instead_of_falling_back_to_a_second_port() {
        let error = required_orphan_marker(Err("unavailable".to_string())).unwrap_err();
        assert!(error.contains("无法验证旧 Uniopc 引擎所有权"));
    }

    #[test]
    fn windows_termination_uses_the_verified_handle_object() {
        let source = include_str!("mod.rs");
        let start = source
            .find("fn terminate_owned_gateway_process")
            .expect("termination function");
        let end = source[start..]
            .find("#[cfg(all(test, windows))]")
            .map(|offset| start + offset)
            .expect("test module");
        let termination = &source[start..end];

        assert!(termination.contains("open_verified_gateway_process_handle"));
        assert!(termination.contains("TerminateProcess(handle.0"));
        assert!(!termination.contains("taskkill"));
    }

    #[test]
    fn only_accepts_bundled_gateway_run_command_lines() {
        let marker = r"C:\Users\pc\AppData\Roaming\Uniopc";
        assert!(windows_command_line_is_uniopc_gateway(
            r#""C:\Users\pc\AppData\Roaming\Uniopc\runtime\tools\node\node.exe" C:\Users\pc\AppData\Roaming\Uniopc\runtime\tools\node\node_modules\uniopc-engine\uniopc-engine.mjs gateway run --port 28790"#,
            marker,
        ));
        assert!(windows_command_line_is_uniopc_gateway(
            r#"C:\Users\pc\AppData\Roaming\Uniopc\runtime\uniopc-engine.exe gateway run --port 28790"#,
            marker,
        ));
        assert!(windows_command_line_is_uniopc_gateway(
            r#"C:\Windows\System32\cmd.exe /C C:\Users\pc\AppData\Roaming\Uniopc\runtime\uniopc-engine.cmd gateway run --port 28790"#,
            marker,
        ));
        assert!(!windows_command_line_is_uniopc_gateway(
            r#"powershell.exe Get-Content C:\Users\pc\AppData\Roaming\Uniopc\state-v8\x\openclaw.json"#,
            marker,
        ));
        assert!(!windows_command_line_is_uniopc_gateway(
            r#"C:\foreign\node.exe C:\foreign\openclaw.mjs gateway run --port 28790"#,
            marker,
        ));
        assert!(!windows_command_line_is_uniopc_gateway(
            r#"C:\foreign\openclaw.exe gateway run --config C:\Users\pc\AppData\Roaming\Uniopc\state-v8\profile-a\openclaw.json"#,
            marker,
        ));
        assert!(!windows_command_line_is_uniopc_gateway(
            r#"C:\Users\pc\AppData\Roaming\Uniopc-dev\openclaw.exe gateway run --port 28790"#,
            marker,
        ));
        assert!(!windows_command_line_is_uniopc_gateway(
            r#"C:\Users\pc\AppData\Roaming\Uniopc\fakeopenclaw.exe gateway run --port 28790"#,
            marker,
        ));
    }
}

#[cfg(windows)]
fn process_is_live_or_unknown(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // Access denied is unknown ownership, not proof of exit. Only the
            // OS "no such process" result permits a new same-profile writer.
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let mut exit_code = 0;
        let alive = GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code == STILL_ACTIVE;
        CloseHandle(handle);
        alive
    }
}

#[cfg(unix)]
fn unix_liveness_from_kill_error(error: Option<i32>) -> bool {
    error != Some(libc::ESRCH)
}

#[cfg(unix)]
fn process_is_live_or_unknown(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || unix_liveness_from_kill_error(std::io::Error::last_os_error().raw_os_error())
}

#[cfg(all(test, unix))]
mod unix_gateway_process_tests {
    use super::{
        endpoint_record_has_stable_owner, unix_gateway_process_title_is_uniopc_gateway,
        unix_liveness_from_kill_error,
    };
    use crate::services::openclaw_connection::GatewayEndpointRecord;

    #[test]
    fn only_esrch_proves_a_unix_process_is_absent() {
        assert!(!unix_liveness_from_kill_error(Some(libc::ESRCH)));
        assert!(unix_liveness_from_kill_error(None));
        assert!(unix_liveness_from_kill_error(Some(libc::EPERM)));
        assert!(unix_liveness_from_kill_error(Some(libc::EIO)));
    }

    #[test]
    fn legacy_unix_record_cannot_authorize_a_kill() {
        let record = GatewayEndpointRecord {
            profile_key: "profile-a".to_string(),
            port: 28790,
            pid: 42,
            generation: 1,
            parent_pid: 1,
            instance_id: None,
            process_created_at: None,
            created_at: "old".to_string(),
        };
        assert!(!endpoint_record_has_stable_owner(
            &record,
            42,
            "profile-a",
            "desktop-instance"
        ));
    }

    #[test]
    fn unix_gateway_title_accepts_the_bundled_runtime_alias_only() {
        assert!(unix_gateway_process_title_is_uniopc_gateway("openclaw"));
        assert!(unix_gateway_process_title_is_uniopc_gateway(
            "openclaw-gateway"
        ));
        assert!(!unix_gateway_process_title_is_uniopc_gateway("node"));
        assert!(!unix_gateway_process_title_is_uniopc_gateway(
            "openclaw-gateway-worker"
        ));
    }
}

// True when `pid` is our own bundled gateway. Two signals, because the obvious
// one is not reliable: the OpenClaw Node runtime overrides its process title to
// bare "openclaw", erasing the data-dir path from `ps` output — so an orphan of
// our OWN engine looks foreign by command line alone (this is exactly what let a
// stale gateway keep our port and trigger `password_mismatch`). Its open files
// (bundled node binary + state sqlite, both under our private data dir) still
// prove ownership, so fall back to those.
#[cfg(not(windows))]
fn unix_path_token_is_owned_gateway_entrypoint(token: &str, marker: &str) -> bool {
    let path = std::path::Path::new(token);
    path.starts_with(std::path::Path::new(marker))
        && matches!(
            path.file_name().and_then(|name| name.to_str()),
            Some("uniopc-engine" | "uniopc-engine.mjs")
        )
}

#[cfg(not(windows))]
fn unix_gateway_process_title_is_uniopc_gateway(title: &str) -> bool {
    matches!(title.trim(), "openclaw" | "openclaw-gateway")
}

#[cfg(not(windows))]
fn process_belongs_to_uniopc_gateway(
    pid: i32,
    marker: &str,
    profile: Option<&str>,
    record: Option<&crate::services::openclaw_connection::GatewayEndpointRecord>,
    expected_instance_id: &str,
) -> bool {
    let (Some(profile), Some(record)) = (profile, record) else {
        return false;
    };
    if !endpoint_record_has_stable_owner(record, pid, profile, expected_instance_id) {
        return false;
    }
    let command_line = process_command_line(pid).unwrap_or_default();
    let words = command_line_tokens(&command_line);
    let direct_identity = words
        .iter()
        .any(|word| unix_path_token_is_owned_gateway_entrypoint(word, marker))
        && words
            .windows(2)
            .any(|pair| pair[0] == "gateway" && pair[1] == "run");
    if direct_identity {
        return true;
    }
    let profile_marker =
        crate::services::uniopc_runtime_paths::state_v8_dir_for_profile(Some(profile))
            .ok()
            .map(|path| path.to_string_lossy().into_owned());
    unix_gateway_process_title_is_uniopc_gateway(&command_line)
        && profile_marker
            .as_deref()
            .is_some_and(|path| process_open_files_contain(pid, path))
}

// Windows: the PEB command line is fixed at CreateProcess and NOT touched by
// Node's process-title rewrite (that only renames the console title), so a
// single cmdline check is reliable here — our engine's cmdline carries the
// bundled runtime path under our private data dir. Any failure → false (treat
// as foreign / don't kill).
#[cfg(windows)]
fn command_line_tokens(command_line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for character in command_line.chars() {
        match character {
            '"' => quoted = !quoted,
            value if value.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            value => current.push(value),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(not(windows))]
fn command_line_tokens(command_line: &str) -> Vec<String> {
    command_line
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

#[cfg(windows)]
fn windows_command_line_is_uniopc_gateway(command_line: &str, marker: &str) -> bool {
    let words: Vec<String> = command_line_tokens(command_line)
        .into_iter()
        .map(|word| word.to_ascii_lowercase())
        .collect();
    let marker = marker.to_ascii_lowercase();
    let marker_path = std::path::Path::new(&marker);
    let token_is_owned = |token: &str, basename: &str| {
        let path = std::path::Path::new(token);
        path.starts_with(marker_path)
            && path.file_name().and_then(|name| name.to_str()) == Some(basename)
    };
    let direct_exe = words.first().is_some_and(|word| token_is_owned(word, "uniopc-engine.exe"));
    let bundled_node_script = words.len() >= 2
        && token_is_owned(&words[0], "node.exe")
        && token_is_owned(&words[1], "uniopc-engine.mjs");
    let cmd_shim = words.iter().enumerate().any(|(index, word)| {
        index >= 2
            && words[index - 1] == "/c"
            && words[0].ends_with("cmd.exe")
            && token_is_owned(word, "uniopc-engine.cmd")
    });
    (direct_exe || bundled_node_script || cmd_shim)
        && words
            .windows(2)
            .any(|pair| pair[0] == "gateway" && pair[1] == "run")
}

#[cfg(windows)]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsGatewayProcessEvidence {
    image_path: String,
    parent_pid: u32,
    created_at: String,
}

#[cfg(windows)]
fn windows_process_matches_endpoint_record(
    record: &crate::services::openclaw_connection::GatewayEndpointRecord,
    expected_profile: &str,
    expected_instance_id: &str,
    evidence: &WindowsGatewayProcessEvidence,
    marker: &str,
) -> bool {
    let timestamps_match = record.process_created_at.as_deref() == Some(&evidence.created_at);
    record.profile_key == expected_profile
        && record.instance_id.as_deref() == Some(expected_instance_id)
        && record.parent_pid != 0
        && record.parent_pid == evidence.parent_pid
        && timestamps_match
        && windows_image_is_uniopc_gateway(&evidence.image_path, marker)
}

#[cfg(windows)]
fn filetime_to_rfc3339(filetime: windows_sys::Win32::Foundation::FILETIME) -> Option<String> {
    let ticks = ((filetime.dwHighDateTime as u64) << 32) | filetime.dwLowDateTime as u64;
    let unix_ticks = ticks.checked_sub(116_444_736_000_000_000)?;
    let seconds = (unix_ticks / 10_000_000) as i64;
    let nanos = ((unix_ticks % 10_000_000) * 100) as u32;
    Some(chrono::DateTime::from_timestamp(seconds, nanos)?.to_rfc3339())
}

#[cfg(windows)]
fn gateway_process_creation_time(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut creation: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let read = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
        CloseHandle(handle);
        read.then(|| filetime_to_rfc3339(creation)).flatten()
    }
}

#[cfg(not(windows))]
fn gateway_process_creation_time(_pid: u32) -> Option<String> {
    None
}

#[cfg(windows)]
fn windows_image_is_uniopc_gateway(image_path: &str, marker: &str) -> bool {
    let normalized = image_path.replace('/', "\\").to_ascii_lowercase();
    let marker = marker
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase();
    let file = std::path::Path::new(&normalized)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    normalized.starts_with(&format!("{marker}\\")) && matches!(file, "openclaw.exe" | "node.exe")
}

#[cfg(windows)]
struct VerifiedGatewayProcessHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for VerifiedGatewayProcessHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn windows_parent_pid(pid: u32) -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ProcessID == pid {
                    found = Some(entry.th32ParentProcessID);
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }
}

#[cfg(windows)]
fn open_verified_gateway_process_handle(
    pid: u32,
    marker: &str,
    profile: &str,
    record: &crate::services::openclaw_connection::GatewayEndpointRecord,
    expected_instance_id: &str,
) -> Option<VerifiedGatewayProcessHandle> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            pid,
        );
        if handle.is_null() {
            return None;
        }
        let owned = VerifiedGatewayProcessHandle(handle);
        let mut image = vec![0u16; 32768];
        let mut image_len = image.len() as u32;
        if QueryFullProcessImageNameW(handle, 0, image.as_mut_ptr(), &mut image_len) == 0 {
            return None;
        }
        let image_path = String::from_utf16_lossy(&image[..image_len as usize]);
        let mut creation: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) == 0 {
            return None;
        }
        let created_at = filetime_to_rfc3339(creation)?;
        let evidence = WindowsGatewayProcessEvidence {
            image_path,
            parent_pid: windows_parent_pid(pid)?,
            created_at,
        };
        windows_process_matches_endpoint_record(
            record,
            profile,
            expected_instance_id,
            &evidence,
            marker,
        )
        .then_some(owned)
    }
}

#[cfg(windows)]
fn process_belongs_to_uniopc_gateway(
    pid: i32,
    marker: &str,
    profile: Option<&str>,
    record: Option<&crate::services::openclaw_connection::GatewayEndpointRecord>,
    expected_instance_id: &str,
) -> bool {
    let (Some(profile), Some(record)) = (profile, record) else {
        return false;
    };
    open_verified_gateway_process_handle(pid as u32, marker, profile, record, expected_instance_id)
        .is_some()
}

// Best-effort: does any file the pid has open live under `needle` (our data
// dir)? Authoritative even when the process title hides the data-dir from `ps`.
// Any failure → false (treat as foreign / don't kill).
#[cfg(not(windows))]
fn process_open_files_contain(pid: i32, needle: &str) -> bool {
    let Ok(output) = std::process::Command::new("lsof")
        .args(["-p", &pid.to_string()])
        .output()
    else {
        return false;
    };
    output.status.success() && String::from_utf8_lossy(&output.stdout).contains(needle)
}

// Best-effort: does the given pid's full command line contain `needle`? Used to
// distinguish our own bundled engine (path under our private data dir) from any
// foreign process holding the gateway port. Any failure → false (treat as
// foreign / don't kill).
#[cfg(not(windows))]
fn process_command_line(pid: i32) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(not(windows))]
fn process_command_contains(pid: i32, needle: &str) -> bool {
    process_command_line(pid).is_some_and(|command_line| command_line.contains(needle))
}

#[cfg(all(test, unix))]
mod stray_gateway_tests {
    use super::{
        process_command_contains, process_open_files_contain,
        unix_path_token_is_owned_gateway_entrypoint,
    };

    #[test]
    fn gateway_entrypoint_requires_exact_root_and_basename() {
        assert!(unix_path_token_is_owned_gateway_entrypoint(
            "/Users/lan/Library/Application Support/Uniopc/runtime/uniopc-engine.mjs",
            "/Users/lan/Library/Application Support/Uniopc",
        ));
        assert!(!unix_path_token_is_owned_gateway_entrypoint(
            "/Users/lan/Library/Application Support/Uniopc-backup/uniopc-engine.mjs",
            "/Users/lan/Library/Application Support/Uniopc",
        ));
        assert!(!unix_path_token_is_owned_gateway_entrypoint(
            "/Users/lan/Library/Application Support/Uniopc/runtime/fake-uniopc-engine.mjs",
            "/Users/lan/Library/Application Support/Uniopc",
        ));
    }

    #[test]
    fn identifies_own_process_and_rejects_foreign_pid() {
        let self_pid = std::process::id() as i32;
        // The test binary lives at target/.../deps/uniopc-<hash>, so its command
        // line contains "uniopc" — i.e. it looks like "our" process.
        assert!(process_command_contains(self_pid, "uniopc"));
        // A pid that cannot exist is treated as foreign (never killed).
        assert!(!process_command_contains(i32::MAX, "uniopc"));
    }

    #[test]
    fn open_files_prove_ownership_when_command_line_is_hidden() {
        let self_pid = std::process::id() as i32;
        // The test binary's own executable (open file) lives under a path
        // containing "uniopc" — this is the signal that survives a process-title
        // override, which is what the real gateway does to bare "openclaw".
        assert!(process_open_files_contain(self_pid, "uniopc"));
        assert!(!process_open_files_contain(i32::MAX, "uniopc"));
    }
}

async fn command_output_streaming(
    app: &AppHandle,
    program: &str,
    args: &[String],
    status: &str,
    detail: &str,
    percent: Option<f64>,
) -> Result<String, String> {
    let _openclaw_guard = if program == "openclaw" {
        Some(crate::services::openclaw_cli::acquire_cli_lock().await)
    } else {
        None
    };
    let (program, args) = resolve_spawn_program(program, args)?;
    let (mut rx, _child) = app
        .shell()
        .command(program.to_string())
        .env("PATH", openclaw_augmented_path(None))
        .envs(cli_proxy_env())
        .envs(openclaw_state_env(&args))
        .args(args.iter().map(|arg| arg.as_str()).collect::<Vec<_>>())
        .spawn()
        .map_err(|e| format!("执行命令失败: {e}"))?;

    let mut output_log = String::new();
    let mut exit_code = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                if let Some(text) = command_event_output_text(&bytes) {
                    append_streaming_output(&mut output_log, &text, 80);
                    emit_openclaw_progress(
                        app,
                        OpenClawSetupProgress {
                            phase: "running".to_string(),
                            status: status.to_string(),
                            detail: Some(detail.to_string()),
                            output_tail: Some(tail_lines(&output_log, 24)),
                            percent,
                        },
                    )?;
                }
            }
            CommandEvent::Error(error) => {
                append_streaming_output(&mut output_log, &error, 80);
                emit_openclaw_progress(
                    app,
                    OpenClawSetupProgress {
                        phase: "running".to_string(),
                        status: status.to_string(),
                        detail: Some(detail.to_string()),
                        output_tail: Some(tail_lines(&output_log, 24)),
                        percent,
                    },
                )?;
            }
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

// Interactive credential input keeps its existing short deadline. Captured
// non-interactive CLI calls own cancellation in the native process helper.
async fn command_output_with_timeout<F, T>(label: String, fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    timeout(Duration::from_secs(90), fut).await
        .map_err(|_| format!("Uniopc 引擎 command timed out after 90s: {label}"))?
}

async fn command_output_impl(
    app: &AppHandle,
    program: &str,
    args: &[String],
) -> Result<String, String> {
    command_output_impl_with_env(app, program, args, &[]).await
}

async fn command_output_impl_with_env(
    app: &AppHandle,
    program: &str,
    args: &[String],
    extra_env: &[(&str, &str)],
) -> Result<String, String> {
    // Tauri Shell cannot apply Windows CREATE_NO_WINDOW. Sending OpenClaw's
    // non-interactive CLI calls through the native helper prevents a visible
    // `openclaw-plugins` console while preserving the existing captured output.
    if program == "openclaw" {
        let mut env = cli_proxy_env();
        env.extend(
            extra_env
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string())),
        );
        return crate::services::openclaw_cli::openclaw_cli_output(args.to_vec(), env).await;
    }

    let (program, args) = resolve_spawn_program(program, args)?;
    let mut command = app
        .shell()
        .command(program)
        .env("PATH", openclaw_augmented_path(None))
        .envs(cli_proxy_env())
        .envs(openclaw_state_env(&args))
        .args(args.iter().map(|arg| arg.as_str()).collect::<Vec<_>>());
    for (key, value) in extra_env {
        command = command.env(*key, *value);
    }
    let output = command
        .output()
        .await
        .map_err(|e| format!("执行命令失败: {e}"))?;

    let stdout = output_to_string(&output.stdout);
    let stderr = output_to_string(&output.stderr);
    let combined = [stdout.as_str(), stderr.as_str()]
        .into_iter()
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    if output.status.success() {
        Ok(combined)
    } else {
        Err(tail_lines(&combined, 20))
    }
}

async fn command_output(app: &AppHandle, program: &str, args: &[String]) -> Result<String, String> {
    command_output_impl(app, program, args).await
}

fn openclaw_args_for_profile(_profile: &str, args: &[String]) -> Vec<String> {
    // One machine, one engine: local CLI calls always target the default
    // profile (state pinned via OPENCLAW_STATE_DIR at spawn). The cloud
    // profile name stays an identity anchor and never reaches the engine.
    args.to_vec()
}

pub(crate) async fn openclaw_output_for_profile(
    app: &AppHandle,
    profile: &str,
    args: &[&str],
) -> Result<String, String> {
    let args = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
    let args = openclaw_args_for_profile(profile, &args);
    command_output(app, "openclaw", &args).await
}

async fn openclaw_output(app: &AppHandle, args: &[&str]) -> Result<String, String> {
    let args = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
    command_output(app, "openclaw", &args).await
}

async fn shell_probe(app: &AppHandle, command: &str) -> Option<String> {
    shell_output(app, command)
        .await
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn json_string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_str()
}

fn json_string_at_any_root<'a>(value: &'a Value, roots: &[&str], path: &[&str]) -> Option<&'a str> {
    for root in roots {
        let mut full_path = Vec::with_capacity(path.len() + if root.is_empty() { 0 } else { 1 });
        if !root.is_empty() {
            full_path.push(*root);
        }
        full_path.extend_from_slice(path);
        if let Some(found) = json_string_at(value, &full_path) {
            return Some(found);
        }
    }
    None
}

fn json_object_at<'a>(
    value: &'a Value,
    path: &[&str],
) -> Option<&'a serde_json::Map<String, Value>> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_object()
}

fn json_array_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Vec<Value>> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_array()
}

fn json_bool_at(value: &Value, path: &[&str]) -> Option<bool> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_bool()
}

fn json_string_is_running(value: &Value, path: &[&str]) -> Option<bool> {
    json_string_at(value, path).map(|state| {
        matches!(
            state.trim().to_lowercase().as_str(),
            "running" | "ready" | "ok" | "active" | "started"
        )
    })
}

fn parse_openclaw_gateway_status(output: &str, command_succeeded: bool) -> OpenClawGatewayStatus {
    let value = parse_json_object_from_output(output);
    let running = value
        .as_ref()
        .and_then(|value| {
            json_bool_at(value, &["running"])
                .or_else(|| json_bool_at(value, &["runtime", "running"]))
                .or_else(|| json_bool_at(value, &["gateway", "running"]))
                .or_else(|| json_string_is_running(value, &["runtime"]))
                .or_else(|| json_string_is_running(value, &["status"]))
                .or_else(|| json_string_is_running(value, &["state"]))
                .or_else(|| json_string_is_running(value, &["runtime", "status"]))
                .or_else(|| json_string_is_running(value, &["runtime", "state"]))
                .or_else(|| json_string_is_running(value, &["service", "runtime", "status"]))
                .or_else(|| json_string_is_running(value, &["service", "runtime", "state"]))
        })
        .unwrap_or_else(|| {
            let normalized = output.to_lowercase();
            normalized.contains("runtime: running")
                || normalized.contains("\"running\":true")
                || normalized.contains("\"status\":\"running\"")
                || normalized.contains("\"state\":\"running\"")
        });

    let rpc_ok = value
        .as_ref()
        .and_then(|value| {
            json_bool_at(value, &["rpc", "ok"])
                .or_else(|| json_bool_at(value, &["rpcProbe", "ok"]))
                .or_else(|| json_bool_at(value, &["readProbe", "ok"]))
                .or_else(|| json_bool_at(value, &["probe", "ok"]))
                .or_else(|| json_bool_at(value, &["rpc_ok"]))
                .or_else(|| json_bool_at(value, &["rpcOk"]))
                .or_else(|| json_string_is_running(value, &["rpc", "status"]))
                .or_else(|| json_string_is_running(value, &["rpcProbe", "status"]))
        })
        .unwrap_or_else(|| {
            let normalized = output.to_lowercase();
            (normalized.contains("rpc probe: ok")
                || normalized.contains("\"rpcok\":true")
                || normalized.contains("\"rpc_ok\":true")
                || normalized.contains("\"ok\":true"))
                || (command_succeeded && running && !normalized.contains("rpc"))
        });

    let health_ok = value
        .as_ref()
        .and_then(|value| json_bool_at(value, &["health", "healthy"]))
        .unwrap_or_else(|| {
            let normalized = output.to_lowercase();
            normalized.contains("\"healthy\":true") || normalized.contains("health: healthy")
        });
    let rpc_blocked = gateway_rpc_is_blocked(output);

    let message = value
        .as_ref()
        .and_then(|value| {
            json_string_at(value, &["rpc", "error"])
                .or_else(|| json_string_at(value, &["rpcProbe", "error"]))
                .or_else(|| json_string_at(value, &["readProbe", "error"]))
                .or_else(|| json_string_at(value, &["lastError"]))
                .or_else(|| json_string_at(value, &["error"]))
                .or_else(|| json_string_at(value, &["message"]))
        })
        .map(str::to_string)
        .or_else(|| {
            if output.trim().is_empty() {
                None
            } else {
                Some(tail_lines(output, 6))
            }
        });

    let dashboard_url = value
        .as_ref()
        .and_then(|value| {
            json_string_at(value, &["dashboardUrl"])
                .or_else(|| json_string_at(value, &["dashboard_url"]))
                .or_else(|| json_string_at(value, &["url"]))
                .or_else(|| json_string_at(value, &["gateway", "url"]))
                .or_else(|| json_string_at(value, &["gateway", "dashboardUrl"]))
                .or_else(|| json_string_at(value, &["gateway", "dashboard_url"]))
        })
        .unwrap_or(OPENCLAW_DASHBOARD_URL)
        .to_string();

    let ws_url = value
        .as_ref()
        .and_then(|value| {
            json_string_at(value, &["wsUrl"])
                .or_else(|| json_string_at(value, &["ws_url"]))
                .or_else(|| json_string_at(value, &["websocketUrl"]))
                .or_else(|| json_string_at(value, &["gateway", "wsUrl"]))
                .or_else(|| json_string_at(value, &["gateway", "ws_url"]))
                .or_else(|| json_string_at(value, &["gateway", "probeUrl"]))
                .or_else(|| json_string_at(value, &["gateway", "probe_url"]))
                .or_else(|| json_string_at(value, &["rpc", "url"]))
        })
        .unwrap_or(OPENCLAW_GATEWAY_WS_URL)
        .to_string();
    let device_id = value.as_ref().and_then(|value| {
        json_string_at(value, &["deviceId"])
            .or_else(|| json_string_at(value, &["device_id"]))
            .or_else(|| json_string_at(value, &["identity", "deviceId"]))
            .or_else(|| json_string_at(value, &["gateway", "deviceId"]))
            .map(str::to_string)
    });
    let public_key = value.as_ref().and_then(|value| {
        json_string_at(value, &["publicKey"])
            .or_else(|| json_string_at(value, &["public_key"]))
            .or_else(|| json_string_at(value, &["identity", "publicKey"]))
            .or_else(|| json_string_at(value, &["gateway", "publicKey"]))
            .map(str::to_string)
    });

    OpenClawGatewayStatus {
        running,
        rpc_ok,
        health_ok,
        rpc_blocked,
        message,
        dashboard_url,
        ws_url,
        device_id,
        public_key,
    }
}

fn gateway_is_ready_for_app(status: &OpenClawGatewayStatus) -> bool {
    status.running && (status.rpc_ok || status.health_ok)
}

async fn openclaw_gateway_status(_app: &AppHandle) -> OpenClawGatewayStatus {
    let health_result = openclaw_gateway::health(None).await;
    let identity_result = if health_result.is_ok() {
        openclaw_gateway::gateway_identity_get(None).await.ok()
    } else {
        None
    };

    match health_result {
        Ok(health) => {
            let health_ok = health.get("ok").and_then(Value::as_bool).unwrap_or(true);
            let identity = identity_result.as_ref();
            OpenClawGatewayStatus {
                running: true,
                rpc_ok: true,
                health_ok,
                rpc_blocked: false,
                message: if health_ok {
                    None
                } else {
                    Some("Uniopc 引擎 health 返回非 ok。".to_string())
                },
                dashboard_url: OPENCLAW_DASHBOARD_URL.to_string(),
                ws_url: OPENCLAW_GATEWAY_WS_URL.to_string(),
                device_id: identity
                    .and_then(|value| json_string_at(value, &["deviceId"]))
                    .map(str::to_string),
                public_key: identity
                    .and_then(|value| json_string_at(value, &["publicKey"]))
                    .map(str::to_string),
            }
        }
        Err(error) => OpenClawGatewayStatus {
            running: false,
            rpc_ok: false,
            health_ok: false,
            rpc_blocked: gateway_rpc_is_blocked(&error),
            message: Some(error),
            dashboard_url: OPENCLAW_DASHBOARD_URL.to_string(),
            ws_url: OPENCLAW_GATEWAY_WS_URL.to_string(),
            device_id: None,
            public_key: None,
        },
    }
}

fn gateway_status_from_profile_health(
    profile: &str,
    health: &Value,
    urls: &(u16, String, String),
) -> OpenClawGatewayStatus {
    let health_ok = health.get("ok").and_then(Value::as_bool).unwrap_or(true);
    OpenClawGatewayStatus {
        running: health_ok,
        rpc_ok: health_ok,
        health_ok,
        rpc_blocked: false,
        message: if health_ok {
            None
        } else {
            Some(format!(
                "Uniopc 引擎 profile `{profile}` health 非 ok: {health}"
            ))
        },
        dashboard_url: urls.2.clone(),
        ws_url: urls.1.clone(),
        device_id: None,
        public_key: None,
    }
}

/// Poll an inexpensive readiness probe without exposing a startup race to its
/// caller. The profile-specific wrapper below supplies the real `/readyz` and
/// authenticated health probes; keeping the loop separate makes its retry
/// contract directly regression-testable.
async fn wait_for_gateway_ready_with_probe<'a>(
    attempts: usize,
    retry_delay: Duration,
    probe: &mut (dyn FnMut() -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>>
              + Send),
) -> bool {
    for attempt in 0..attempts {
        if probe().await {
            return true;
        }
        if attempt + 1 < attempts && !retry_delay.is_zero() {
            sleep(retry_delay).await;
        }
    }
    false
}

/// Wait for a config-triggered in-process restart to cross the only safe
/// boundary: the old ready instance must first become unavailable, and only a
/// later ready probe belongs to the reloaded instance. Accepting the initial
/// ready state lets queued chat run against stale provider endpoints.
async fn wait_for_gateway_restart_cycle_with_probe<'a>(
    attempts: usize,
    retry_delay: Duration,
    probe: &mut (dyn FnMut() -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>>
              + Send),
) -> bool {
    let mut observed_unready = false;
    for attempt in 0..attempts {
        let ready = probe().await;
        if observed_unready && ready {
            return true;
        }
        if !ready {
            observed_unready = true;
        }
        if attempt + 1 < attempts && !retry_delay.is_zero() {
            sleep(retry_delay).await;
        }
    }
    false
}

pub(crate) async fn wait_for_openclaw_profile_gateway_ready(profile: &str) -> bool {
    let mut probe = || {
        Box::pin(async {
            if !matches!(openclaw_gateway::http_ready(Some(profile)).await, Ok(true)) {
                return false;
            }
            matches!(
                openclaw_gateway::health(Some(profile)).await,
                Ok(value) if value.get("ok").and_then(Value::as_bool).unwrap_or(true)
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>>
    };
    // A managed cloud-plugin install adds an extension scan to Gateway startup.
    // On a cold development machine the old 20 s budget can expire just before
    // the restarted Gateway reports ready, leaving a successfully installed
    // plugin marked as failed and skipping its credential configuration.
    wait_for_gateway_ready_with_probe(140, Duration::from_millis(250), &mut probe).await
}

fn gateway_rpc_is_blocked(output: &str) -> bool {
    let normalized = output.to_lowercase();
    normalized.contains("connect eperm")
        || normalized.contains("operation not permitted")
        || normalized.contains("another process is listening on this port")
}

fn parse_json_object_from_output(text: &str) -> Option<serde_json::Value> {
    parse_json_value_from_output(text).filter(Value::is_object)
}

fn parse_json_value_from_output(text: &str) -> Option<serde_json::Value> {
    let object_start = text.find('{');
    let array_start = text.find('[');
    let start = match (object_start, array_start) {
        (Some(object), Some(array)) => object.min(array),
        (Some(object), None) => object,
        (None, Some(array)) => array,
        (None, None) => return None,
    };
    serde_json::from_str(&text[start..]).ok()
}

fn official_codex_access_token_from_auth_payload(auth: &Value) -> Option<String> {
    if json_string_at(auth, &["auth_mode"]) != Some("chatgpt") {
        return None;
    }
    json_string_at(auth, &["tokens", "access_token"])
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToString::to_string)
}

fn openclaw_home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn local_host_name() -> String {
    env::var("HOSTNAME")
        .or_else(|_| env::var("COMPUTERNAME"))
        .map(|value| value.trim().to_string())
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "owner-computer".to_string())
}

fn openclaw_agent_dir_for_profile(profile: Option<&str>) -> Result<PathBuf, String> {
    let config_path = openclaw_gateway::openclaw_config_path_for_profile(profile)?;
    let profile_dir = config_path
        .parent()
        .ok_or_else(|| "Uniopc 引擎 profile 配置路径无效。".to_string())?;
    Ok(profile_dir.join("agents").join("main").join("agent"))
}

fn strip_openclaw_assistant_attachment_blocks(event: &mut Value) -> bool {
    let Some(message) = event.get_mut("message").and_then(Value::as_object_mut) else {
        return false;
    };
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return false;
    }
    let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else {
        return false;
    };
    let before = content.len();
    content.retain(|block| {
        !matches!(
            block.get("type").and_then(Value::as_str),
            Some("attachment") | Some("video")
        )
    });
    content.len() != before
}

pub(crate) fn repair_openclaw_assistant_attachment_blocks(
    profile: Option<&str>,
) -> Result<usize, String> {
    let database_path =
        openclaw_agent_dir_for_profile(profile)?.join("openclaw-agent.sqlite");
    if !database_path.is_file() {
        return Ok(0);
    }
    let connection = Connection::open(&database_path)
        .map_err(|error| format!("open transcript database: {error}"))?;
    let mut statement = connection
        .prepare(
            "SELECT session_id, seq, event_json FROM transcript_events \
             WHERE event_json LIKE '%\"type\":\"attachment\"%' \
                OR event_json LIKE '%\"type\":\"video\"%'",
        )
        .map_err(|error| format!("query transcript database: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("read transcript database: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("decode transcript database row: {error}"))?;
    drop(statement);

    let mut repaired = 0;
    for (session_id, seq, event_json) in rows {
        let Ok(mut event) = serde_json::from_str::<Value>(&event_json) else {
            continue;
        };
        if !strip_openclaw_assistant_attachment_blocks(&mut event) {
            continue;
        }
        let serialized = serde_json::to_string(&event)
            .map_err(|error| format!("serialize repaired transcript event: {error}"))?;
        connection
            .execute(
                "UPDATE transcript_events SET event_json = ?1 WHERE session_id = ?2 AND seq = ?3",
                rusqlite::params![serialized, session_id, seq],
            )
            .map_err(|error| format!("write repaired transcript event: {error}"))?;
        repaired += 1;
    }
    Ok(repaired)
}

fn openclaw_auth_usage_stats_json_path(profile_id: &str) -> String {
    format!(
        "$.usageStats.\"{}\"",
        profile_id.replace('\\', "\\\\").replace('"', "\\\"")
    )
}

fn sqlite_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

const OPENCLAW_QWEN_CODING_PLAN_DEFAULT_MODEL: &str = "qwen/qwen3.7-plus";
const OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER: &str = "bailian-token-plan";
const OPENCLAW_BAILIAN_TOKEN_PLAN_DEFAULT_MODEL: &str = "bailian-token-plan/qwen3.7-plus";
const OPENCLAW_BAILIAN_TOKEN_PLAN_BASE_URL: &str =
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const OPENCLAW_UNIOPC_OFFICIAL_PROVIDER: &str = "uniopc-official";
const OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL: &str = "uniopc-official/uniopc-default";
const OPENCLAW_UNIOPC_OFFICIAL_VIDEO_MODEL: &str = "uniopc-official/uniopc-video";
const OPENCLAW_UNIOPC_OFFICIAL_TTS_MODEL: &str = "uniopc-official/uniopc-tts";
const OPENCLAW_UNIOPC_OFFICIAL_STT_MODEL: &str = "uniopc-official/uniopc-stt";
// Media model ids registered on the official provider so the gateway resolves
// uniopc-official/<media> refs. Image and video actually ride the built-in
// `openai` provider slot pointed at our loopback proxy (see
// `build_uniopc_official_config_patch`), and TTS rides the built-in `minimax`
// TTS provider, so this list is vestigial — only STT is still unwired.
const OPENCLAW_UNIOPC_OFFICIAL_MEDIA_MODEL_IDS: [&str; 1] = ["uniopc-video"];
// Non-chat ids that may appear under the official provider. Everything else on
// that provider is a chat alias routed by llm-proxy, so it inherits the
// official chat capabilities (image input + reasoning); these must not.
const OPENCLAW_UNIOPC_OFFICIAL_NON_CHAT_MODEL_IDS: [&str; 4] =
    ["uniopc-image", "uniopc-video", "uniopc-tts", "uniopc-stt"];

fn provider_api_key_spec(provider: &str) -> Result<ProviderApiKeySpec, String> {
    match provider.trim() {
        "openai" | "openai-api" => Ok(ProviderApiKeySpec {
            provider_prefix: "openai",
            env_key: "OPENAI_API_KEY",
            default_model: OPENCLAW_OPENAI_API_DEFAULT_MODEL,
            auth_choice: None,
            required_key_prefix: None,
        }),
        "bailian-token-plan" => Ok(ProviderApiKeySpec {
            provider_prefix: OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER,
            env_key: "",
            default_model: OPENCLAW_BAILIAN_TOKEN_PLAN_DEFAULT_MODEL,
            auth_choice: None,
            required_key_prefix: Some("sk-sp-"),
        }),
        "qwen" | "qwen-coding-cn" => Ok(ProviderApiKeySpec {
            provider_prefix: "qwen",
            env_key: "QWEN_API_KEY",
            default_model: OPENCLAW_QWEN_CODING_PLAN_DEFAULT_MODEL,
            auth_choice: Some("qwen-api-key-cn"),
            required_key_prefix: Some("sk-sp-"),
        }),
        "qwen-standard-cn" | "qwen-standard" => Ok(ProviderApiKeySpec {
            provider_prefix: "qwen",
            env_key: "QWEN_API_KEY",
            default_model: OPENCLAW_QWEN_CODING_PLAN_DEFAULT_MODEL,
            auth_choice: Some("qwen-standard-api-key-cn"),
            required_key_prefix: Some("sk-"),
        }),
        "zai" | "z.ai" | "z-ai" => Ok(ProviderApiKeySpec {
            provider_prefix: "zai",
            env_key: "ZAI_API_KEY",
            default_model: "zai/glm-5",
            auth_choice: None,
            required_key_prefix: None,
        }),
        "deepseek" => Ok(ProviderApiKeySpec {
            provider_prefix: "deepseek",
            env_key: "DEEPSEEK_API_KEY",
            default_model: OPENCLAW_DEEPSEEK_DEFAULT_MODEL,
            auth_choice: Some("deepseek-api-key"),
            required_key_prefix: None,
        }),
        "anthropic" => Ok(ProviderApiKeySpec {
            provider_prefix: "anthropic",
            env_key: "ANTHROPIC_API_KEY",
            default_model: "anthropic/claude-sonnet-4-6",
            auth_choice: None,
            required_key_prefix: None,
        }),
        other => Err(format!("暂不支持通过 API Key 接入 Provider: {other}")),
    }
}

fn validate_provider_api_key(spec: &ProviderApiKeySpec, api_key: &str) -> Result<(), String> {
    let Some(prefix) = spec.required_key_prefix else {
        return Ok(());
    };
    if !api_key.starts_with(prefix) {
        if spec.auth_choice == Some("qwen-api-key-cn") && api_key.starts_with("sk-ws-") {
            return Err(
                "当前选择的是 Qwen Coding Plan 订阅，请填写 sk-sp- 开头的 Coding Plan 专属 API Key；你现在填的是 sk-ws- 开头的百炼普通 API Key，会被订阅端点返回 401。"
                    .to_string(),
            );
        }
        return Err(format!(
            "当前 Provider 需要 {prefix} 开头的 API Key，请检查后重新填写。"
        ));
    }
    if spec.auth_choice == Some("qwen-standard-api-key-cn") && api_key.starts_with("sk-sp-") {
        return Err(
            "当前选择的是 Qwen 标准 API Key（按量付费）；sk-sp- 是 Coding Plan 订阅 Key，请选择 Qwen Coding Plan 订阅入口。"
                .to_string(),
        );
    }
    Ok(())
}

fn openclaw_provider_onboard_args(spec: &ProviderApiKeySpec) -> Vec<String> {
    let auth_choice = spec.auth_choice.unwrap_or(spec.provider_prefix);
    vec![
        "onboard".to_string(),
        "--non-interactive".to_string(),
        "--accept-risk".to_string(),
        "--mode".to_string(),
        "local".to_string(),
        "--flow".to_string(),
        "quickstart".to_string(),
        "--auth-choice".to_string(),
        auth_choice.to_string(),
        "--skip-health".to_string(),
        "--skip-ui".to_string(),
    ]
}

fn build_openclaw_default_model_patch(snapshot: &Value, model_ref: &str) -> Value {
    let mut models = existing_gateway_model_allowlist(snapshot);
    models
        .entry(model_ref.to_string())
        .or_insert_with(|| serde_json::json!({}));
    let mut patch = serde_json::json!({
        "agents": {
            "defaults": {
                "model": {
                    "primary": model_ref
                },
                "models": Value::Object(models)
            }
        }
    });
    if let Some(provider_patch) =
        build_openclaw_provider_model_registration_patch(snapshot, model_ref)
    {
        if let Some(object) = patch.as_object_mut() {
            object.insert("models".to_string(), provider_patch);
        }
    }
    patch
}

fn normalized_config_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn provider_model_parts(model_ref: &str) -> Option<(&str, &str)> {
    let (provider, model) = model_ref.trim().split_once('/')?;
    let provider = provider.trim();
    let model = model.trim();
    (!provider.is_empty() && !model.is_empty()).then_some((provider, model))
}

fn build_openclaw_media_capabilities_patch(req: &OpenClawMediaCapabilitiesSaveRequest) -> Value {
    let mut patch = serde_json::Map::new();

    let mut media_models = serde_json::Map::new();
    if let Some(image) = normalized_config_string(req.image_model.as_deref()) {
        media_models.insert("image".to_string(), Value::String(image));
    }
    if let Some(video) = normalized_config_string(req.video_model.as_deref()) {
        media_models.insert("video".to_string(), Value::String(video));
    }
    if !media_models.is_empty() {
        patch.insert(
            "agents".to_string(),
            serde_json::json!({ "defaults": { "mediaModels": media_models } }),
        );
    }

    // OpenClaw 8.1 owns TTS at the top level. The provider-specific model and
    // voice belong under `tts.providers.<provider>`; `messages.tts` is a
    // rejected legacy key.
    if let Some(tts_model_ref) = normalized_config_string(req.tts_model.as_deref()) {
        if let Some((provider, model)) = provider_model_parts(&tts_model_ref) {
            let mut provider_config = serde_json::Map::new();
            provider_config.insert("model".to_string(), Value::String(model.to_string()));
            if let Some(voice) = normalized_config_string(req.tts_voice.as_deref()) {
                let voice_key = if provider == "minimax" {
                    "voiceId"
                } else {
                    "voice"
                };
                provider_config.insert(voice_key.to_string(), Value::String(voice));
            }
            let mut providers = serde_json::Map::new();
            providers.insert(provider.to_string(), Value::Object(provider_config));
            patch.insert(
                "tts".to_string(),
                serde_json::json!({ "provider": provider, "providers": providers }),
            );
        }
    }

    // Audio understanding in 8.1 selects a preferred model and registers its
    // audio capability. The old `audio.transcriptionModel` key is not valid.
    if let Some(stt_model_ref) = normalized_config_string(req.stt_model.as_deref()) {
        if let Some((provider, model)) = provider_model_parts(&stt_model_ref) {
            patch.insert(
                "tools".to_string(),
                serde_json::json!({
                    "media": {
                        "audio": {
                            "enabled": true,
                            "preferredModel": stt_model_ref
                        },
                        "models": [{
                            "provider": provider,
                            "model": model,
                            "capabilities": ["audio"]
                        }]
                    }
                }),
            );
        }
    }

    Value::Object(patch)
}

fn build_openclaw_provider_model_registration_patch(
    snapshot: &Value,
    model_ref: &str,
) -> Option<Value> {
    let (provider, model_id) = model_ref.split_once('/')?;
    let provider = provider.trim();
    let model_id = model_id.trim();
    if provider.is_empty() || model_id.is_empty() {
        return None;
    }

    let mut provider_models = normalize_provider_models_for_patch(
        provider,
        &[],
        existing_gateway_provider_models(snapshot, provider),
    );
    let has_model = provider_models.iter().any(|entry| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .map(|id| id == model_id)
            .unwrap_or(false)
    });
    if !has_model {
        provider_models.push(model_registration_entry_for_model_id(
            provider,
            &[],
            model_id,
        ));
    }

    Some(serde_json::json!({
        "providers": {
            provider: {
                "models": provider_models
            }
        }
    }))
}

fn normalize_provider_models_for_patch(
    provider: &str,
    catalog: &[OpenClawOfficialCatalogModel],
    models: Vec<Value>,
) -> Vec<Value> {
    models
        .into_iter()
        .map(|entry| {
            let Some(id) = entry
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                return entry;
            };
            let has_name = entry
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .is_some();
            let id = id.to_string();

            // Official chat models: the catalog declaration is authoritative,
            // so rewrite the capability fields rather than only topping them
            // up. That is what lets the admin console turn a capability back
            // OFF — and what repairs entries written by older desktops that
            // guessed from the model id. The whole `models` array is replaced
            // in the config patch, so dropping a key here really removes it.
            if is_uniopc_official_chat_model(provider, &id) {
                let mut object = entry.as_object().cloned().unwrap_or_default();
                if !has_name {
                    object.insert(
                        "name".to_string(),
                        Value::String(display_name_for_model_id(&id)),
                    );
                }
                apply_official_chat_capabilities(
                    &mut object,
                    &official_chat_capabilities(catalog, &id),
                );
                return Value::Object(object);
            }

            let missing_image_input = model_supports_image_input(provider, &id)
                && !entry
                    .get("input")
                    .and_then(Value::as_array)
                    .map(|input| input.iter().any(|mode| mode.as_str() == Some("image")))
                    .unwrap_or(false);
            if has_name && !missing_image_input {
                return entry;
            }
            let mut object = entry.as_object().cloned().unwrap_or_default();
            if !has_name {
                object.insert(
                    "name".to_string(),
                    Value::String(display_name_for_model_id(&id)),
                );
            }
            if missing_image_input {
                // 早期注册只声明了 ["text"]，会让 gateway 拒收图片；就地补齐。
                let mut input = object
                    .get("input")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| vec![Value::String("text".to_string())]);
                input.push(Value::String("image".to_string()));
                object.insert("input".to_string(), Value::Array(input));
            }
            Value::Object(object)
        })
        .collect()
}

fn model_registration_entry_for_model_id(
    provider: &str,
    catalog: &[OpenClawOfficialCatalogModel],
    model_id: &str,
) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("id".to_string(), Value::String(model_id.to_string()));
    object.insert(
        "name".to_string(),
        Value::String(display_name_for_model_id(model_id)),
    );
    if is_uniopc_official_chat_model(provider, model_id) {
        apply_official_chat_capabilities(
            &mut object,
            &official_chat_capabilities(catalog, model_id),
        );
        return Value::Object(object);
    }
    // Everything else is a user-supplied endpoint with no capability
    // declaration available, so the id heuristic is all we have.
    if model_supports_image_input(provider, model_id) {
        object.insert("input".to_string(), serde_json::json!(["text", "image"]));
    }
    Value::Object(object)
}

// Capabilities of official chat models are decided by *provider membership*,
// not by the model id. The catalog alias is operator-editable in the admin
// console (the default row's alias moved `uniopc-default` -> `Qwen-3.7` once
// already), so any literal id comparison silently loses image input and the
// Think picker the moment someone renames a row.
fn is_uniopc_official_chat_model(provider: &str, model_id: &str) -> bool {
    provider.trim() == OPENCLAW_UNIOPC_OFFICIAL_PROVIDER
        && !OPENCLAW_UNIOPC_OFFICIAL_NON_CHAT_MODEL_IDS
            .iter()
            .any(|id| model_id.trim().eq_ignore_ascii_case(id))
}

/// What the catalog says an official chat model can do. Declared server-side
/// (`llm_upstream_config.supports_vision` / `supports_reasoning` /
/// `thinking_format`), delivered by mint-llm-token, and transcribed verbatim
/// into the gateway model entry — never inferred from the model id.
#[derive(Debug, Clone, PartialEq)]
struct OfficialChatCapabilities {
    image_input: bool,
    reasoning: bool,
    thinking_format: Option<String>,
}

fn official_chat_capabilities(
    catalog: &[OpenClawOfficialCatalogModel],
    model_id: &str,
) -> OfficialChatCapabilities {
    let declared = catalog
        .iter()
        .find(|entry| entry.id.trim().eq_ignore_ascii_case(model_id.trim()))
        .filter(|entry| {
            entry.supports_vision.is_some()
                || entry.supports_reasoning.is_some()
                || entry.thinking_format.is_some()
        });
    match declared {
        Some(entry) => OfficialChatCapabilities {
            image_input: entry.supports_vision.unwrap_or(false),
            reasoning: entry.supports_reasoning.unwrap_or(false),
            thinking_format: entry
                .thinking_format
                .as_deref()
                .map(str::trim)
                .filter(|format| !format.is_empty())
                .map(str::to_string),
        },
        // No declaration: either the backend predates the capability columns
        // or this id is a stale registration the catalog no longer lists.
        // Keep vision enabled for backwards compatibility, but never guess a
        // thinking protocol from an alias. An operator can point
        // `uniopc-default` at a non-Qwen upstream (for example MiniMax); the
        // Qwen fallback then sends an incompatible request and the gateway can
        // fail while parsing an absent reasoning field.
        None => OfficialChatCapabilities {
            image_input: true,
            reasoning: legacy_official_thinking_format(model_id).is_some(),
            thinking_format: legacy_official_thinking_format(model_id).map(str::to_string),
        },
    }
}

// Only an explicit Qwen id gets the legacy Qwen request/response protocol.
// `uniopc-default` is an operator alias and currently resolves to MiniMax, so
// treating it as Qwen causes a missing reasoning field in the gateway.
fn legacy_official_thinking_format(model_id: &str) -> Option<&'static str> {
    model_id
        .trim()
        .to_ascii_lowercase()
        .contains("qwen")
        .then_some("qwen")
}

fn apply_official_chat_capabilities(
    object: &mut serde_json::Map<String, Value>,
    capabilities: &OfficialChatCapabilities,
) {
    object.insert(
        "input".to_string(),
        if capabilities.image_input {
            serde_json::json!(["text", "image"])
        } else {
            serde_json::json!(["text"])
        },
    );
    object.insert("reasoning".to_string(), Value::Bool(capabilities.reasoning));
    let mut compat = object
        .get("compat")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    match capabilities.thinking_format.as_deref() {
        // A format without reasoning is a no-op the gateway ignores; drop it
        // so the written config matches what actually takes effect.
        Some(format) if capabilities.reasoning => {
            compat.insert(
                "thinkingFormat".to_string(),
                Value::String(format.to_string()),
            );
        }
        _ => {
            compat.remove("thinkingFormat");
        }
    }
    if compat.is_empty() {
        object.remove("compat");
    } else {
        object.insert("compat".to_string(), Value::Object(compat));
    }
}

fn model_supports_image_input(provider: &str, model_id: &str) -> bool {
    // uniopc-official chat models never reach here — their capabilities are
    // declared, not guessed (see `official_chat_capabilities`).
    debug_assert!(!is_uniopc_official_chat_model(provider, model_id));
    let normalized = model_id.trim().to_ascii_lowercase();
    normalized.contains("-vl")
        || normalized.contains("_vl")
        || normalized.contains("vision")
        || normalized.contains("visual")
        || normalized.starts_with("gpt-4o")
        || normalized.starts_with("gpt-4.1")
        || normalized.starts_with("gpt-5")
        || normalized.starts_with("claude")
        || normalized.starts_with("gemini")
}

fn display_name_for_model_id(model_id: &str) -> String {
    model_id
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            if part.eq_ignore_ascii_case("gpt") {
                return "GPT".to_string();
            }
            if part.chars().any(|ch| ch.is_ascii_digit()) {
                part.to_string()
            } else {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn build_member_profile_provision_config_patch(
    snapshot: &Value,
    openclaw_profile: &str,
    enable_cloud_workspace: bool,
    cloud_agent_api_url: Option<&str>,
    cloud_agent_auth_token: Option<&str>,
    cloud_agent_token_expires_at: Option<&str>,
    cloud_agent_id: Option<&str>,
    cloud_agent_proxy_url: Option<&str>,
    agent_path_env: Option<&str>,
) -> Value {
    let mut patch = build_member_profile_default_model_patch(snapshot);
    if let Some(object) = patch.as_object_mut() {
        let mut plugin_entries = serde_json::Map::new();
        plugin_entries.insert(
            "bonjour".to_string(),
            serde_json::json!({
                "enabled": false
            }),
        );
        plugin_entries.insert(
            openclaw_system_plugins::UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID.to_string(),
            serde_json::json!({
                "enabled": true
            }),
        );
        if let Ok(media_dir) = crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(Some(openclaw_profile)) {
            plugin_entries.insert(
                openclaw_system_plugins::UNIOPC_SUPER_IP_PLUGIN_ID.to_string(),
                serde_json::json!({
                    "config": { "env": {
                        "UNIOPC_SUPERIP_MEDIA_DIR": media_dir.join("media").to_string_lossy()
                    }}
                }),
            );
        }
        // Plugin placement on disk is owned by `openclaw plugins install`
        // (the bundled cloud-workspace plugin is installed through the CLI
        // before this patch is applied); the config only enables the entry.
        if enable_cloud_workspace {
            plugin_entries.insert(
                openclaw_system_plugins::IMAI_CLOUD_WORKSPACE_PLUGIN_ID.to_string(),
                serde_json::json!({
                    "enabled": true
                }),
            );
        }
        object.insert(
            "discovery".to_string(),
            serde_json::json!({
                "mdns": {
                    "mode": "off"
                }
            }),
        );
        object.insert(
            "plugins".to_string(),
            serde_json::json!({
                "entries": Value::Object(plugin_entries)
            }),
        );
        object.insert(
            "tools".to_string(),
            serde_json::json!({
                "alsoAllow": startup_allowed_system_plugin_tools(snapshot)
            }),
        );
        if cloud_agent_api_url.is_some()
            || cloud_agent_auth_token.is_some()
            || cloud_agent_token_expires_at.is_some()
            || cloud_agent_id.is_some()
            || cloud_agent_proxy_url.is_some()
            || agent_path_env.is_some()
            || !openclaw_profile.trim().is_empty()
        {
            let mut env = json_object_at(snapshot, &["parsed", "env"])
                .or_else(|| json_object_at(snapshot, &["sourceConfig", "env"]))
                .or_else(|| json_object_at(snapshot, &["config", "env"]))
                .or_else(|| json_object_at(snapshot, &["runtimeConfig", "env"]))
                .or_else(|| json_object_at(snapshot, &["resolved", "env"]))
                .or_else(|| json_object_at(snapshot, &["env"]))
                .cloned()
                .unwrap_or_default();
            let mut vars = env
                .get("vars")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            // OpenClaw 8.1 accepts only shellEnv + vars here. Preserve legacy
            // string variables in vars, with canonical values taking priority;
            // null at the old path is an RFC 7396 deletion, never a var value.
            for (key, value) in env.iter_mut() {
                if key != "vars" && key != "shellEnv" && value.is_string() {
                    vars.entry(key.clone()).or_insert_with(|| value.clone());
                    *value = Value::Null;
                }
            }
            if !openclaw_profile.trim().is_empty() {
                vars.insert(
                    "IMAI_OPENCLAW_PROFILE".to_string(),
                    Value::String(openclaw_profile.trim().to_string()),
                );
            }
            if let Some(api_url) = cloud_agent_api_url
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                vars.insert(
                    "UNIOPC_CLOUD_WORKSPACE_API_URL".to_string(),
                    Value::String(api_url.to_string()),
                );
            }
            if let Some(auth_token) = cloud_agent_auth_token
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                vars.insert(
                    "IMAI_CLOUD_AGENT_AUTH_TOKEN".to_string(),
                    Value::String(auth_token.to_string()),
                );
            }
            if let Some(expires_at) = cloud_agent_token_expires_at
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                vars.insert(
                    "IMAI_CLOUD_AGENT_TOKEN_EXPIRES_AT".to_string(),
                    Value::String(expires_at.to_string()),
                );
            }
            if let Some(agent_id) = cloud_agent_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                vars.insert(
                    "IMAI_AGENT_ID".to_string(),
                    Value::String(agent_id.to_string()),
                );
            }
            if let Some(proxy_url) = cloud_agent_proxy_url
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                vars.insert(
                    "IMAI_CLOUD_AGENT_PROXY_URL".to_string(),
                    Value::String(proxy_url.to_string()),
                );
            }
            if let Some(path) = agent_path_env
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                vars.insert("PATH".to_string(), Value::String(path.to_string()));
            }
            env.insert("vars".to_string(), Value::Object(vars));
            object.insert("env".to_string(), Value::Object(env));
        }
    }
    let browser_patch =
        crate::services::openclaw_browser::startup_config_patch(snapshot, openclaw_profile);
    if let Some(browser) = browser_patch.get("browser") {
        patch["browser"] = browser.clone();
    }
    if let Some(gateway) = browser_patch.get("gateway") {
        patch["gateway"] = gateway.clone();
    }
    if browser_patch.get("browser").is_some() {
        patch["plugins"]["entries"]["browser"] =
            browser_patch["plugins"]["entries"]["browser"].clone();
        for key in ["allow", "deny"] {
            if let Some(value) = browser_patch["plugins"].get(key) {
                patch["plugins"][key] = value.clone();
            }
        }
        let allowed = patch["tools"]["alsoAllow"]
            .as_array_mut()
            .expect("startup alsoAllow array");
        if !allowed.iter().any(|v| v.as_str() == Some("browser")) {
            allowed.push(serde_json::json!("browser"));
        }
    }
    patch
}

/// Minimal tool profiles require an explicit allowlist. Keep every installed
/// system plugin that the user has enabled in that allowlist; otherwise the
/// app can show an enabled plugin that `/plugin:<id>` rejects before a turn is
/// sent.
fn startup_allowed_system_plugin_tools(snapshot: &Value) -> Vec<String> {
    let mut allowed = snapshot
        .get("tools")
        .and_then(|tools| tools.get("alsoAllow"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let entries = snapshot
        .get("plugins")
        .and_then(|plugins| plugins.get("entries"))
        .and_then(Value::as_object);
    for plugin_id in openclaw_system_plugins::BUNDLED_SYSTEM_PLUGIN_IDS
        .iter()
        .chain(openclaw_system_plugins::CLOUD_SYSTEM_PLUGIN_IDS.iter())
    {
        let enabled = *plugin_id == openclaw_system_plugins::UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID
            || entries
                .and_then(|entries| entries.get(*plugin_id))
                .and_then(|entry| entry.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
        if enabled && !allowed.iter().any(|entry| entry == plugin_id) {
            allowed.push((*plugin_id).to_string());
        }
    }
    allowed
}

pub(crate) fn build_member_profile_static_startup_config_patch(
    snapshot: &Value,
    openclaw_profile: &str,
) -> Value {
    let path = openclaw_augmented_path(None);
    let existing_primary = json_string_at(snapshot, &["agents", "defaults", "model", "primary"])
        .map(str::to_string)
        .or_else(|| gateway_default_model_from_config(snapshot, false));
    let mut patch = build_member_profile_provision_config_patch(
        snapshot,
        openclaw_profile,
        false,
        None,
        None,
        None,
        Some("main"),
        None,
        Some(&path),
    );
    if let Some(existing_primary) = existing_primary {
        patch["agents"]["defaults"]["model"]["primary"] = Value::String(existing_primary);
    }
    patch
}

fn build_member_profile_hot_reload_config_patch(
    snapshot: &Value,
    openclaw_profile: &str,
    cloud_agent_api_url: Option<&str>,
    cloud_agent_auth_token: Option<&str>,
    cloud_agent_token_expires_at: Option<&str>,
    cloud_agent_id: Option<&str>,
    cloud_agent_proxy_url: Option<&str>,
) -> Value {
    let mut patch = build_member_profile_provision_config_patch(
        snapshot,
        openclaw_profile,
        true,
        cloud_agent_api_url,
        cloud_agent_auth_token,
        cloud_agent_token_expires_at,
        cloud_agent_id,
        cloud_agent_proxy_url,
        None,
    );
    if let Some(model) = patch
        .pointer_mut("/agents/defaults/model")
        .and_then(Value::as_object_mut)
    {
        model.remove("primary");
    }
    if let Some(entries) = patch
        .pointer_mut("/plugins/entries")
        .and_then(Value::as_object_mut)
    {
        entries.retain(|plugin_id, _| !openclaw_system_plugins::is_system_plugin_id(plugin_id));
        entries.remove("bonjour");
    }
    if let Some(vars) = patch
        .pointer_mut("/env/vars")
        .and_then(Value::as_object_mut)
    {
        vars.remove("PATH");
        vars.remove("IMAI_OPENCLAW_PROFILE");
        vars.remove("UNIOPC_CLOUD_WORKSPACE_API_URL");
    }
    if let Some(object) = patch.as_object_mut() {
        object.remove("discovery");
        // The pre-spawn patch already registers system tools. A config.get
        // snapshot redacts large arrays, so replaying alsoAllow here can
        // silently discard the user's entries (and the Gateway rejects it).
        object.remove("tools");
    }
    patch
}

// 成员档案只内置 Uniopc 官方模型。官方 provider 的凭据（baseUrl/apiKey）由前端
// connectUniopcOfficialModel 铸造令牌后写入；这里只设置默认模型指向，并在
// provider 已存在（曾连接过官方模型）时顺带刷新其模型注册（能力声明修复）。
// provider 尚不存在时不凭空注册，避免写出一个缺少 baseUrl 的自定义 provider。
fn build_member_profile_default_model_patch(snapshot: &Value) -> Value {
    let model_ref = OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL;
    let mut models = existing_gateway_model_allowlist(snapshot);
    models
        .entry(model_ref.to_string())
        .or_insert_with(|| serde_json::json!({}));
    let mut patch = serde_json::json!({
        "agents": {
            "defaults": {
                "model": {
                    "primary": model_ref
                },
                "models": Value::Object(models)
            }
        }
    });
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    let provider_configured = roots.iter().any(|root| {
        snapshot
            .get(root)
            .and_then(|value| value.get("models"))
            .and_then(|value| value.get("providers"))
            .and_then(|value| value.get(OPENCLAW_UNIOPC_OFFICIAL_PROVIDER))
            .is_some()
    });
    if provider_configured {
        if let Some(provider_patch) =
            build_openclaw_provider_model_registration_patch(snapshot, model_ref)
        {
            if let Some(object) = patch.as_object_mut() {
                object.insert("models".to_string(), provider_patch);
            }
        }
    }
    patch
}

fn existing_gateway_model_allowlist(snapshot: &Value) -> serde_json::Map<String, Value> {
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    for root in roots {
        if let Some(models) = json_object_at(snapshot, &[root, "agents", "defaults", "models"]) {
            return models.clone();
        }
    }
    serde_json::Map::new()
}

fn existing_gateway_provider_models(snapshot: &Value, provider: &str) -> Vec<Value> {
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    for root in roots {
        if let Some(models) =
            json_array_at(snapshot, &[root, "models", "providers", provider, "models"])
        {
            return models.clone();
        }
    }
    Vec::new()
}

// True when a fresh config snapshot actually contains the `uniopc-official`
// provider block (a non-empty baseUrl). The official-model connect is two steps
// — write the token file, then `config.patch` the provider/secrets/default — and
// a patch that is silently dropped or merged away (gateway mid-restart or
// desynced) leaves the token file on disk with NO provider in config. That
// half-write is exactly what strands the agent on "No API key found for provider
// openai" while the picker shows the official model unselected. Verifying the
// provider truly landed turns a phantom success into a retryable error.
fn snapshot_has_official_provider_configured(snapshot: &Value) -> bool {
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    roots.iter().any(|root| {
        json_object_at(
            snapshot,
            &[
                root,
                "models",
                "providers",
                OPENCLAW_UNIOPC_OFFICIAL_PROVIDER,
            ],
        )
        .and_then(|provider| provider.get("baseUrl"))
        .and_then(Value::as_str)
        .map(|url| !url.trim().is_empty())
        .unwrap_or(false)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OfficialModelGatewaySettleAction {
    KeepRunning,
    AwaitRestart,
}

fn official_model_gateway_settle_action(
    snapshot: &Value,
    proxy_base_url: &str,
    _proxy_secret: &str,
) -> OfficialModelGatewaySettleAction {
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    let proxy_base_url = proxy_base_url.trim_end_matches('/');
    let already_current = roots.iter().any(|root| {
        let Some(provider) = json_object_at(
            snapshot,
            &[
                root,
                "models",
                "providers",
                OPENCLAW_UNIOPC_OFFICIAL_PROVIDER,
            ],
        ) else {
            return false;
        };
        let base_matches = provider
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .map(|value| value.trim_end_matches('/') == proxy_base_url)
            .unwrap_or(false);
        // Gateway config snapshots redact inline credentials. The loopback
        // proxy restores its shared secret from the same persisted provider
        // block at startup, so its endpoint is the reliable identity here.
        // Comparing a masked `apiKey` makes a no-op config.patch wait for a
        // restart that will never happen, leaving a previous auth/billing
        // cooldown active after the account has been topped up.
        base_matches
    });

    if already_current {
        OfficialModelGatewaySettleAction::KeepRunning
    } else {
        OfficialModelGatewaySettleAction::AwaitRestart
    }
}

fn existing_gateway_plugin_policy_list(snapshot: &Value, field: &str) -> Option<Vec<String>> {
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    for root in roots {
        if let Some(items) = json_array_at(snapshot, &[root, "plugins", field]) {
            return Some(
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(str::to_string)
                    .collect(),
            );
        }
    }
    None
}

fn build_openclaw_provider_plugin_allow_patch(snapshot: &Value, plugin_id: &str) -> Option<Value> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        return None;
    }
    let mut allow = existing_gateway_plugin_policy_list(snapshot, "allow")?;
    let mut changed = false;
    if !allow.iter().any(|item| item == plugin_id) {
        allow.push(plugin_id.to_string());
        changed = true;
    }

    let mut plugins = serde_json::Map::new();
    plugins.insert(
        "allow".to_string(),
        Value::Array(allow.into_iter().map(Value::String).collect()),
    );

    if let Some(deny) = existing_gateway_plugin_policy_list(snapshot, "deny") {
        let next_deny = deny
            .into_iter()
            .filter(|item| item != plugin_id)
            .collect::<Vec<_>>();
        if next_deny.len()
            != existing_gateway_plugin_policy_list(snapshot, "deny")
                .map(|items| items.len())
                .unwrap_or(0)
        {
            changed = true;
        }
        plugins.insert(
            "deny".to_string(),
            Value::Array(next_deny.into_iter().map(Value::String).collect()),
        );
    }

    if !changed {
        return None;
    }
    Some(serde_json::json!({
        "plugins": Value::Object(plugins)
    }))
}

fn bailian_token_plan_model_id(model_ref: &str) -> &str {
    model_ref
        .trim()
        .split_once('/')
        .map(|(_, model)| model.trim())
        .filter(|model| !model.is_empty())
        .unwrap_or("qwen3.7-plus")
}

fn build_bailian_token_plan_config_patch(
    snapshot: &Value,
    api_key: &str,
    model_ref: &str,
) -> Value {
    let model_ref = normalize_openclaw_model_ref(
        model_ref,
        OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER,
        OPENCLAW_BAILIAN_TOKEN_PLAN_DEFAULT_MODEL,
    );
    let model_id = bailian_token_plan_model_id(&model_ref);
    let mut agent_models = existing_gateway_model_allowlist(snapshot);
    agent_models
        .entry(model_ref.clone())
        .or_insert_with(|| serde_json::json!({}));

    let mut provider_models = normalize_provider_models_for_patch(
        OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER,
        &[],
        existing_gateway_provider_models(snapshot, OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER),
    );
    if !provider_models.iter().any(|entry| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .map(|id| id == model_id)
            .unwrap_or(false)
    }) {
        provider_models.push(model_registration_entry_for_model_id(
            OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER,
            &[],
            model_id,
        ));
    }

    let mut providers = serde_json::Map::new();
    providers.insert(
        OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER.to_string(),
        serde_json::json!({
            "baseUrl": OPENCLAW_BAILIAN_TOKEN_PLAN_BASE_URL,
            "api": "openai-completions",
            "apiKey": api_key,
            "models": provider_models
        }),
    );

    serde_json::json!({
        "models": {
            "providers": Value::Object(providers)
        },
        "agents": {
            "defaults": {
                "model": {
                    "primary": model_ref
                },
                "models": Value::Object(agent_models)
            }
        }
    })
}

// Provider id for a user-added OpenAI-compatible endpoint. Derived from the
// label so two custom endpoints don't collide, and prefixed so a custom entry
// can never shadow a managed provider (`openai`, `qwen`, `uniopc-official`, …)
// — shadowing those would hijack the official media slots or the user's own
// preset setup.
pub(crate) const OPENCLAW_CUSTOM_PROVIDER_PREFIX: &str = "custom-";

fn custom_provider_id_from_label(label: &str) -> String {
    let slug: String = label
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '.' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    // Non-ASCII labels (e.g. all-Chinese) slugify to nothing — fall back to a
    // stable generic id rather than emitting a bare prefix.
    let slug = if slug.is_empty() {
        "endpoint".to_string()
    } else {
        slug
    };
    format!("{OPENCLAW_CUSTOM_PROVIDER_PREFIX}{slug}")
}

fn build_custom_openai_provider_config_patch(
    snapshot: &Value,
    provider_id: &str,
    base_url: &str,
    api_key: &str,
    model_id: &str,
) -> Value {
    let model_ref = format!("{provider_id}/{model_id}");
    let mut agent_models = existing_gateway_model_allowlist(snapshot);
    agent_models
        .entry(model_ref.clone())
        .or_insert_with(|| serde_json::json!({}));

    let mut provider_models = normalize_provider_models_for_patch(
        provider_id,
        &[],
        existing_gateway_provider_models(snapshot, provider_id),
    );
    if !provider_models.iter().any(|entry| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .map(|id| id == model_id)
            .unwrap_or(false)
    }) {
        provider_models.push(model_registration_entry_for_model_id(
            provider_id,
            &[],
            model_id,
        ));
    }

    let mut providers = serde_json::Map::new();
    providers.insert(
        provider_id.to_string(),
        serde_json::json!({
            "baseUrl": base_url,
            "api": "openai-completions",
            "apiKey": api_key,
            "models": provider_models
        }),
    );

    serde_json::json!({
        "models": { "providers": Value::Object(providers) },
        "agents": {
            "defaults": {
                "model": { "primary": model_ref },
                "models": Value::Object(agent_models)
            }
        }
    })
}

fn build_uniopc_official_config_patch(
    snapshot: &Value,
    base_url: &str,
    api_key_literal: &str,
    model_ref: &str,
    catalog_models: &[OpenClawOfficialCatalogModel],
) -> Value {
    let model_ref = normalize_openclaw_model_ref(
        model_ref,
        OPENCLAW_UNIOPC_OFFICIAL_PROVIDER,
        OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
    );
    // The official token is NOT in config — `base_url` points at the in-process
    // loopback proxy (`services::official_model_proxy`) and every apiKey below
    // is the per-run loopback shared secret, a constant. The proxy swaps that
    // secret for the real bearer token (held only in memory) on each request.
    // So rotating the token never touches config → no config.patch → no gateway
    // restart. This is the fix for the mint→restart churn (was: a `file` secret
    // ref the engine cached in its snapshot, forcing a restart to re-read).
    let api_key_ref = Value::String(api_key_literal.to_string());
    let model_id = model_ref
        .split_once('/')
        .map(|(_, model)| model.trim())
        .filter(|model| !model.is_empty())
        .unwrap_or("uniopc-default");
    let mut agent_models = existing_gateway_model_allowlist(snapshot);
    agent_models
        .entry(model_ref.clone())
        .or_insert_with(|| serde_json::json!({}));

    let mut provider_models = normalize_provider_models_for_patch(
        OPENCLAW_UNIOPC_OFFICIAL_PROVIDER,
        catalog_models,
        existing_gateway_provider_models(snapshot, OPENCLAW_UNIOPC_OFFICIAL_PROVIDER),
    );
    if !provider_models.iter().any(|entry| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .map(|existing| existing == model_id)
            .unwrap_or(false)
    }) {
        provider_models.push(model_registration_entry_for_model_id(
            OPENCLAW_UNIOPC_OFFICIAL_PROVIDER,
            catalog_models,
            model_id,
        ));
    }

    // Register every additional official catalog model (mint's `models[]`)
    // alongside the default. They all share this provider's loopback baseUrl —
    // switching models is pure alias routing on the relay side, so no extra
    // credentials or providers are involved. Ids removed from the catalog keep
    // their (stale) registration until the next connect; the relay routes
    // unknown aliases to its default upstream, so they degrade, never break.
    for catalog_model in catalog_models {
        let id = catalog_model.id.trim();
        if id.is_empty() || id == model_id {
            continue;
        }
        agent_models
            .entry(format!("{OPENCLAW_UNIOPC_OFFICIAL_PROVIDER}/{id}"))
            .or_insert_with(|| serde_json::json!({}));
        if !provider_models.iter().any(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .map(|existing| existing == id)
                .unwrap_or(false)
        }) {
            let mut object = model_registration_entry_for_model_id(
                OPENCLAW_UNIOPC_OFFICIAL_PROVIDER,
                catalog_models,
                id,
            )
            .as_object()
            .cloned()
            .unwrap_or_default();
            if let Some(name) = catalog_model
                .display_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                object.insert("name".to_string(), Value::String(name.to_string()));
            }
            provider_models.push(Value::Object(object));
        }
    }

    // Existing sessions can retain an older official-model alias even after an
    // operator changes the catalog's default. Keep every previously allowed
    // official chat alias registered with the provider too. The relay safely
    // routes an obsolete alias to its current upstream default; leaving the
    // alias in `agents.defaults.models` without this registration instead makes
    // the gateway reject the entire turn as "Unknown model".
    let legacy_official_model_ids = agent_models
        .keys()
        .filter_map(|model_ref| model_ref.split_once('/'))
        .filter_map(|(provider, id)| {
            let id = id.trim();
            (provider.trim() == OPENCLAW_UNIOPC_OFFICIAL_PROVIDER
                && !id.is_empty()
                && is_uniopc_official_chat_model(OPENCLAW_UNIOPC_OFFICIAL_PROVIDER, id))
            .then_some(id.to_string())
        })
        .collect::<Vec<_>>();
    for id in legacy_official_model_ids {
        if provider_models.iter().any(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .map(|existing| existing == id)
                .unwrap_or(false)
        }) {
            continue;
        }
        provider_models.push(model_registration_entry_for_model_id(
            OPENCLAW_UNIOPC_OFFICIAL_PROVIDER,
            catalog_models,
            &id,
        ));
    }

    let mut providers = serde_json::Map::new();
    providers.insert(
        OPENCLAW_UNIOPC_OFFICIAL_PROVIDER.to_string(),
        serde_json::json!({
            "baseUrl": base_url,
            "api": "openai-completions",
            "apiKey": api_key_ref.clone(),
            "models": provider_models
        }),
    );

    // Image generation rides Uniopc 引擎's built-in `openai` image provider (the
    // standard /v1/images/generations shape), pointed at our metering proxy.
    // Guard: never clobber a user's real OpenAI setup — only claim the openai
    // slot when it is absent or already ours (refreshing the token).
    let openai_slot_available = match uniopc_openai_slot_state(snapshot, base_url) {
        UniopcOpenAiSlot::Free | UniopcOpenAiSlot::Ours => true,
        UniopcOpenAiSlot::Foreign => false,
    };
    let _ = (
        OPENCLAW_UNIOPC_OFFICIAL_VIDEO_MODEL,
        OPENCLAW_UNIOPC_OFFICIAL_TTS_MODEL,
        OPENCLAW_UNIOPC_OFFICIAL_STT_MODEL,
        &OPENCLAW_UNIOPC_OFFICIAL_MEDIA_MODEL_IDS,
    );

    if openai_slot_available {
        // Register the media model ids we route through this slot. Stricter
        // engine schemas validate `models.providers.<id>.models` as a REQUIRED
        // array — omitting it made those engines reject the whole config with
        // `models.providers.openai.models: expected array, received undefined`,
        // so the official-model write silently failed back to the runtime's
        // baked-in Bedrock default. Merge with any existing openai models so we
        // don't clobber the "Ours" refresh case.
        let mut openai_models = normalize_provider_models_for_patch(
            "openai",
            &[],
            existing_gateway_provider_models(snapshot, "openai"),
        );
        for media_model_id in [OPENCLAW_UNIOPC_OFFICIAL_IMAGE_MODEL_ID, "uniopc-video"] {
            if !openai_models.iter().any(|entry| {
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|existing| existing == media_model_id)
                    .unwrap_or(false)
            }) {
                openai_models.push(model_registration_entry_for_model_id(
                    "openai",
                    &[],
                    media_model_id,
                ));
            }
        }
        providers.insert(
            "openai".to_string(),
            serde_json::json!({
                "baseUrl": base_url,
                "apiKey": api_key_ref.clone(),
                "models": openai_models
            }),
        );
    }

    let mut defaults = serde_json::Map::new();
    defaults.insert(
        "model".to_string(),
        serde_json::json!({ "primary": model_ref }),
    );
    defaults.insert("models".to_string(), Value::Object(agent_models));
    if openai_slot_available {
        // openai/<id>: the model id reaches our proxy verbatim and is ignored
        // there (the upstream model is fixed server-side).
        defaults.insert(
            "mediaModels".to_string(),
            serde_json::json!({
                "image": format!("openai/{}", OPENCLAW_UNIOPC_OFFICIAL_IMAGE_MODEL_ID),
                "video": "openai/uniopc-video"
            }),
        );
    }

    let mut patch = serde_json::Map::new();
    patch.insert(
        "models".to_string(),
        serde_json::json!({ "providers": Value::Object(providers) }),
    );
    patch.insert(
        "agents".to_string(),
        serde_json::json!({ "defaults": Value::Object(defaults) }),
    );
    // TTS rides Uniopc 引擎's minimax TTS provider pointed at our proxy: the
    // trailing /v1 is stripped by its normalizer, so requests land on
    // {proxy}/v1/t2a_v2 (metered per call). Skip if the user configured a
    // real MiniMax TTS of their own.
    if uniopc_tts_slot_available(snapshot, base_url) {
        patch.insert(
            "tts".to_string(),
            serde_json::json!({
                "provider": "minimax",
                "providers": {
                    "minimax": {
                        "apiKey": api_key_ref.clone(),
                        "baseUrl": base_url
                    }
                }
            }),
        );
    }

    // No `secrets.providers` block is written: apiKeys are now the loopback
    // shared secret (a plain string) and the real token lives in the proxy's
    // memory, not in any file the engine reads. A user migrating from the old
    // `file`-ref config keeps a now-inert `secrets.providers.uniopc-official`
    // entry (config merge blanks values rather than deleting keys — see the
    // env block above) — nothing references it, so it is harmless.

    Value::Object(patch)
}

// True when an existing provider block was set up by US — either the new
// loopback scheme (apiKey is the shared-secret string) or the OLD file-secret
// scheme (apiKey is a `{source:"file", provider:"uniopc-official"}` ref). This
// lets migration from the old scheme RECLAIM the openai/minimax media slots into
// the proxy, instead of mistaking the old direct-Supabase block (a non-loopback
// baseUrl) for a user's own custom provider and stranding media on the stale
// file token.
fn provider_apikey_is_uniopc_owned(provider_block: &Value) -> bool {
    match provider_block.get("apiKey") {
        Some(Value::String(key)) => {
            key == crate::services::official_model_proxy::proxy_shared_secret()
        }
        Some(Value::Object(map)) => {
            map.get("source").and_then(Value::as_str) == Some("file")
                && map.get("provider").and_then(Value::as_str)
                    == Some(OPENCLAW_UNIOPC_OFFICIAL_PROVIDER)
        }
        _ => false,
    }
}

fn uniopc_tts_slot_available(snapshot: &Value, our_base_url: &str) -> bool {
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    for root in roots {
        let Some(minimax) = snapshot
            .get(root)
            .and_then(|value| value.get("tts"))
            .and_then(|value| value.get("providers"))
            .and_then(|value| value.get("minimax"))
        else {
            continue;
        };
        let base_url = minimax
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_end_matches('/');
        // Present but foreign = the user's own MiniMax TTS — leave it. Reuse the
        // slot when it already points at us: this run's proxy URL, any loopback
        // URL left by a previous/fallback run, or an old
        // uniopc-owned block being migrated (recognized by its apiKey).
        return provider_apikey_is_uniopc_owned(minimax)
            || (!base_url.is_empty()
                && (base_url == our_base_url.trim_end_matches('/')
                    || crate::services::official_model_proxy::is_uniopc_official_loopback_base_url(
                        base_url,
                    )));
    }
    true
}

const OPENCLAW_UNIOPC_OFFICIAL_IMAGE_MODEL_ID: &str = "uniopc-image";

enum UniopcOpenAiSlot {
    Free,
    Ours,
    Foreign,
}

fn uniopc_openai_slot_state(snapshot: &Value, our_base_url: &str) -> UniopcOpenAiSlot {
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    for root in roots {
        let Some(openai) = snapshot
            .get(root)
            .and_then(|value| value.get("models"))
            .and_then(|value| value.get("providers"))
            .and_then(|value| value.get("openai"))
        else {
            continue;
        };
        // An old uniopc block (direct-Supabase baseUrl + file-secret apiKey) is
        // ours to migrate — recognize it by the apiKey regardless of baseUrl.
        if provider_apikey_is_uniopc_owned(openai) {
            return UniopcOpenAiSlot::Ours;
        }
        let base_url = openai
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_end_matches('/');
        if base_url.is_empty() {
            // Configured openai without a custom baseUrl = the user's real
            // OpenAI (api.openai.com). Leave it alone.
            return UniopcOpenAiSlot::Foreign;
        }
        if base_url == our_base_url.trim_end_matches('/')
            || crate::services::official_model_proxy::is_uniopc_official_loopback_base_url(base_url)
        {
            return UniopcOpenAiSlot::Ours;
        }
        return UniopcOpenAiSlot::Foreign;
    }
    UniopcOpenAiSlot::Free
}

fn openclaw_gateway_patch_error_may_be_restarting(error: &str) -> bool {
    let normalized = error.to_lowercase();
    normalized.contains("关闭连接")
        || normalized.contains("closed")
        || normalized.contains("connection reset")
        || normalized.contains("connection refused")
        || normalized.contains("gateway_transport_connection_refused")
        || normalized.contains("gateway starting")
        || normalized.contains("retry shortly")
        || normalized.contains("timeout")
        || normalized.contains("超时")
        || normalized.contains("restart")
}

async fn config_get_with_gateway_recovery(profile: Option<&str>) -> Result<Value, String> {
    let mut last_error = None;
    for _ in 0..OPENCLAW_CONFIG_PATCH_RECOVERY_ATTEMPTS {
        match openclaw_gateway::config_get(profile).await {
            Ok(value) => return Ok(value),
            Err(error) if openclaw_gateway_patch_error_may_be_restarting(&error) => {
                last_error = Some(error);
                sleep(Duration::from_millis(
                    OPENCLAW_CONFIG_PATCH_RECOVERY_DELAY_MS,
                ))
                .await;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "Uniopc 引擎 config.get 重试失败。".to_string()))
}

async fn openclaw_profile_default_model_is_effective(
    profile: Option<&str>,
    model_ref: &str,
) -> bool {
    match config_get_with_gateway_recovery(profile).await {
        Ok(config) => {
            gateway_default_model_from_config(&config, true)
                .or_else(|| gateway_default_model_from_config(&config, false))
                .as_deref()
                == Some(model_ref)
        }
        Err(_) => false,
    }
}

async fn wait_for_openclaw_profile_default_model(profile: Option<&str>, model_ref: &str) -> bool {
    for _ in 0..OPENCLAW_CONFIG_PATCH_RECOVERY_ATTEMPTS {
        if openclaw_profile_default_model_is_effective(profile, model_ref).await {
            return true;
        }
        sleep(Duration::from_millis(
            OPENCLAW_CONFIG_PATCH_RECOVERY_DELAY_MS,
        ))
        .await;
    }
    false
}

pub(crate) fn startup_defaults_delta(
    snapshot: &Value,
    profile: &str,
    cloud_agent_api_url: Option<&str>,
    cloud_agent_auth_token: Option<&str>,
    cloud_agent_token_expires_at: Option<&str>,
    cloud_agent_id: Option<&str>,
) -> Result<Value, String> {
    use crate::services::startup_readiness::{minimal_delta, safe_config};
    let config = safe_config(snapshot)?;
    let proxy_url = cloud_agent_proxy_url();
    // Keep the engine envelope for builders that read parsed/sourceConfig, but
    // use one canonical persisted snapshot for the delta comparison.
    let canonical = serde_json::json!({"sourceConfig": config, "parsed": config});
    let patch = build_member_profile_hot_reload_config_patch(
        &canonical,
        profile,
        cloud_agent_api_url,
        cloud_agent_auth_token,
        cloud_agent_token_expires_at,
        cloud_agent_id,
        proxy_url.as_deref(),
    );
    Ok(minimal_delta(config, &patch))
}

fn backup_file(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let backup_path = path.with_extension(format!("json.bak-uniopc-rebind-{timestamp}"));
    fs::copy(path, &backup_path).map_err(|e| {
        format!(
            "备份 Uniopc 引擎 授权文件失败 {}: {e}",
            path.to_string_lossy()
        )
    })?;
    Ok(Some(backup_path))
}

fn openclaw_env_var_is_effective(config: &Value, key: &str, value: &str) -> bool {
    let key = key.trim();
    if key.is_empty() {
        return false;
    }
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
        "",
    ];
    roots
        .iter()
        .find_map(|root| {
            json_string_at_any_root(config, &[*root], &["env", "vars", key])
                .or_else(|| json_string_at_any_root(config, &[*root], &["env", key]))
        })
        .map(|stored| stored == value)
        .unwrap_or(false)
}

fn official_model_target_preserving_existing_selection(
    config: &Value,
    requested_model: &str,
) -> String {
    let existing = gateway_default_model_from_config(config, false).or_else(|| {
        json_string_at(config, &["agents", "defaults", "model", "primary"]).map(str::to_string)
    });
    existing
        .filter(|model_ref| {
            model_ref
                .trim()
                .starts_with(&format!("{OPENCLAW_UNIOPC_OFFICIAL_PROVIDER}/"))
        })
        .unwrap_or_else(|| requested_model.to_string())
}

// Match JS truthiness before trimming, including whitespace resolved defaults.
fn official_bootstrap_requires_cli_auth(snapshot: &OpenClawModelsSnapshot) -> bool {
    let model = snapshot
        .resolved_default_model
        .as_deref()
        .filter(|model| !model.is_empty())
        .or(snapshot.primary_model.as_deref())
        .unwrap_or_default()
        .trim();
    !model.is_empty() && model.contains('/') && !model.starts_with("uniopc-official/")
}

async fn official_bootstrap_snapshot_with_auth<F, Fut>(
    config: &Value,
    models: &Value,
    auth: &Value,
    local_snapshot: OpenClawModelsSnapshot,
    load_auth: F,
) -> OpenClawModelsSnapshot
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Value>,
{
    if official_bootstrap_requires_cli_auth(&local_snapshot) {
        let agent_auth = load_auth().await;
        openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
            config,
            models,
            auth,
            Some(&agent_auth),
        )
    } else {
        local_snapshot
    }
}

async fn official_agent_migration_ready_models<F, Fut>(
    agents: &[Value],
    target_model: &str,
    load_ready: F,
) -> Result<BTreeSet<String>, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<BTreeSet<String>, String>>,
{
    // The legacy parser supplies all exclusions and alias handling. Empty model
    // candidates still migrate, without needing provider availability discovery.
    let needs_ready = agents.iter().any(|agent| {
        !agent_model_migration_targets(std::slice::from_ref(agent), &BTreeSet::new(), target_model)
            .is_empty()
            && json_string_at(agent, &["model"])
                .or_else(|| json_string_at(agent, &["defaultModel"]))
                .or_else(|| json_string_at(agent, &["default_model"]))
                .is_some_and(|model| !model.trim().is_empty())
    });
    let mut ready = if needs_ready {
        load_ready().await?
    } else {
        BTreeSet::new()
    };
    ready.insert(target_model.to_string());
    Ok(ready)
}

fn agent_model_migration_targets(
    agents: &[Value],
    ready_models: &BTreeSet<String>,
    target_model: &str,
) -> Vec<String> {
    let target_model = target_model.trim();
    if target_model.is_empty() {
        return Vec::new();
    }

    agents
        .iter()
        .filter(|agent| {
            !agent
                .get("isDefault")
                .or_else(|| agent.get("is_default"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|agent| {
            let id = json_string_at(agent, &["id"])
                .or_else(|| json_string_at(agent, &["agentId"]))
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let model = json_string_at(agent, &["model"])
                .or_else(|| json_string_at(agent, &["defaultModel"]))
                .or_else(|| json_string_at(agent, &["default_model"]))
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if model == Some(target_model) {
                return None;
            }
            if model
                .map(|model| ready_models.contains(model))
                .unwrap_or(false)
            {
                return None;
            }
            Some(id.to_string())
        })
        .collect()
}

async fn openclaw_model_status(_app: &AppHandle) -> Option<OpenClawModelStatus> {
    openclaw_model_status_from_gateway(false).await.ok()
}

async fn openclaw_model_status_from_gateway(
    refresh_auth: bool,
) -> Result<OpenClawModelStatus, String> {
    let config = openclaw_gateway::config_get(None).await?;
    let models = openclaw_gateway::models_list(None).await?;
    let auth = openclaw_gateway::models_auth_status(None, refresh_auth).await?;
    let agent_auth = openclaw_agent_auth_store_for_profile(None);
    Ok(openclaw_model_status_from_gateway_payloads_with_agent_auth(
        &config,
        &models,
        &auth,
        Some(&agent_auth),
    ))
}

async fn openclaw_agent_auth_store_for_profile_from_cli(
    app: &AppHandle,
    profile: Option<&str>,
) -> Option<Value> {
    let output = if let Some(profile) = profile {
        openclaw_output_for_profile(app, profile, &["models", "auth", "list", "--json"]).await
    } else {
        openclaw_output(app, &["models", "auth", "list", "--json"]).await
    }
    .ok()?;
    parse_json_value_from_output(&output)
}

fn openclaw_agent_auth_with_local_fallback(
    cli_auth: Option<Value>,
    local_auth: impl FnOnce() -> Value,
) -> Value {
    cli_auth.unwrap_or_else(local_auth)
}

async fn openclaw_agent_auth_store_for_profile_with_cli(
    app: &AppHandle,
    profile: Option<&str>,
) -> Value {
    openclaw_agent_auth_with_local_fallback(
        openclaw_agent_auth_store_for_profile_from_cli(app, profile).await,
        || openclaw_agent_auth_store_for_profile(profile),
    )
}

async fn openclaw_model_status_from_gateway_for_profile_with_cli_auth(
    app: &AppHandle,
    profile: Option<&str>,
    refresh_auth: bool,
) -> Result<OpenClawModelStatus, String> {
    let config = openclaw_gateway::config_get(profile).await?;
    let models = openclaw_gateway::configured_models_list(profile).await?;
    let auth = openclaw_gateway::models_auth_status(profile, refresh_auth).await?;
    let agent_auth = openclaw_agent_auth_store_for_profile_with_cli(app, profile).await;
    Ok(openclaw_model_status_from_gateway_payloads_with_agent_auth(
        &config,
        &models,
        &auth,
        Some(&agent_auth),
    ))
}

#[cfg(test)]
fn openclaw_model_status_from_gateway_payloads(
    config: &Value,
    models: &Value,
    auth: &Value,
) -> OpenClawModelStatus {
    openclaw_model_status_from_gateway_payloads_with_agent_auth(config, models, auth, None)
}

fn openclaw_model_status_from_gateway_payloads_with_agent_auth(
    config: &Value,
    models: &Value,
    auth: &Value,
    agent_auth: Option<&Value>,
) -> OpenClawModelStatus {
    let default_model = gateway_default_model_from_config(config, false);
    let resolved_default_model = gateway_default_model_from_config(config, true)
        .or_else(|| default_model.clone())
        .or_else(|| first_gateway_model_ref(models));
    let current_model_ref = resolved_default_model
        .as_deref()
        .or(default_model.as_deref());
    let providers_with_oauth = agent_auth
        .map(gateway_providers_with_oauth)
        .unwrap_or_else(|| gateway_providers_with_oauth(auth));
    let auth_profile_labels = agent_auth
        .map(gateway_auth_profile_labels)
        .unwrap_or_else(|| gateway_auth_profile_labels(auth));
    let openai_codex_oauth_ready = providers_with_oauth.iter().any(|provider| {
        provider.starts_with(OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER)
            || provider.starts_with(OPENCLAW_OPENAI_CODEX_CLI_AUTH_PROVIDER)
    });
    let minimax_oauth_ready = providers_with_oauth
        .iter()
        .any(|provider| provider.starts_with(OPENCLAW_MINIMAX_AUTH_PROVIDER));
    let missing_providers_in_use = current_model_ref
        .and_then(openclaw_provider_key_from_ref)
        .filter(|provider| {
            let model_ref = current_model_ref.unwrap_or_default();
            !gateway_model_authenticated_with_agent_auth(auth, model_ref, provider, agent_auth)
        })
        .map(|provider| vec![provider.to_string()])
        .unwrap_or_default();
    let provider_mode = current_model_ref.and_then(|model_ref| {
        openclaw_provider_mode_from_ref(model_ref, openai_codex_oauth_ready, minimax_oauth_ready)
    });
    let provider_ready = current_model_ref
        .map(|model_ref| {
            let Some(provider_key) = openclaw_provider_key_from_ref(model_ref) else {
                return false;
            };
            if provider_key == "ollama" {
                return false;
            }
            gateway_model_authenticated_with_agent_auth(auth, model_ref, provider_key, agent_auth)
        })
        .unwrap_or(false);

    OpenClawModelStatus {
        default_model,
        resolved_default_model,
        provider_ready,
        provider_mode,
        missing_providers_in_use,
        providers_with_oauth,
        auth_profile_labels,
        runtime_compat_ready: true,
        runtime_compat_message: None,
    }
}

fn openclaw_agent_auth_store_for_profile(profile: Option<&str>) -> Value {
    let Ok(agent_dir) = openclaw_agent_dir_for_profile(profile) else {
        return serde_json::json!({ "version": 1, "profiles": {} });
    };
    let path = agent_dir.join("auth-profiles.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .unwrap_or_else(|| serde_json::json!({ "version": 1, "profiles": {} }))
}

async fn openclaw_models_snapshot_from_gateway_for_profile(
    profile: Option<&str>,
    host_version: Option<&str>,
) -> Result<OpenClawModelsSnapshot, String> {
    let config = openclaw_gateway::config_get(profile).await?;
    let models = openclaw_gateway::configured_models_list(profile).await?;
    let auth = openclaw_gateway::models_auth_status(profile, false).await?;
    let agent_auth = openclaw_agent_auth_store_for_profile(profile);
    let mut snapshot = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
        &config,
        &models,
        &auth,
        Some(&agent_auth),
    );
    apply_codex_runtime_compatibility(profile, host_version, &mut snapshot);
    Ok(snapshot)
}

pub async fn openclaw_runtime_blocker_for_profile(
    profile: Option<&str>,
) -> Result<Option<String>, String> {
    let snapshot = openclaw_models_snapshot_from_gateway_for_profile(profile, None).await?;
    Ok(if snapshot.runtime_compat_ready {
        None
    } else {
        snapshot.runtime_compat_message
    })
}

fn normalize_openclaw_snapshot_profile(profile: Option<&str>) -> Option<String> {
    profile
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
fn openclaw_models_snapshot_from_gateway_payloads(
    config: &Value,
    models: &Value,
    auth: &Value,
) -> OpenClawModelsSnapshot {
    openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(config, models, auth, None)
}

fn openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
    config: &Value,
    models: &Value,
    auth: &Value,
    agent_auth: Option<&Value>,
) -> OpenClawModelsSnapshot {
    let status = openclaw_model_status_from_gateway_payloads_with_agent_auth(
        config, models, auth, agent_auth,
    );
    let fallback_models = gateway_fallback_models_from_config(config);
    let configured_refs =
        gateway_configured_model_refs(config, status.default_model.as_deref(), &fallback_models);
    let provider_registered_refs = gateway_provider_registered_model_refs(config);
    let model_entries = gateway_model_catalog_entries(
        models,
        auth,
        agent_auth,
        &configured_refs,
        &provider_registered_refs,
    );
    let configured_block_ids = config_provider_block_ids(config);
    let providers = gateway_provider_snapshots(
        auth,
        agent_auth,
        &model_entries,
        &configured_refs,
        &configured_block_ids,
    );

    OpenClawModelsSnapshot {
        primary_model: status.default_model,
        resolved_default_model: status.resolved_default_model,
        fallback_models,
        image_generation_model: gateway_image_generation_model_from_config(config),
        video_generation_model: gateway_video_generation_model_from_config(config),
        tts_model: gateway_tts_model_from_config(config),
        tts_voice: gateway_tts_voice_from_config(config),
        stt_model: gateway_stt_model_from_config(config),
        models: model_entries,
        providers,
        auth_profile_labels: status.auth_profile_labels,
        runtime_compat_ready: true,
        runtime_compat_message: None,
    }
}

fn apply_codex_runtime_compatibility(
    profile: Option<&str>,
    host_version: Option<&str>,
    snapshot: &mut OpenClawModelsSnapshot,
) {
    let compat = codex_runtime_compatibility(profile, host_version);
    if compat.ready {
        return;
    }
    snapshot.runtime_compat_ready = false;
    snapshot.runtime_compat_message = compat.message.clone();
    for model in &mut snapshot.models {
        if model.provider == OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER {
            model.provider_ready = false;
            model.provider_status = compat.message.clone();
        }
    }
    for provider in &mut snapshot.providers {
        if provider.id == OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER {
            provider.ready = false;
            provider.status = compat.message.clone();
        }
    }
}

fn gateway_default_model_from_config(config: &Value, prefer_resolved: bool) -> Option<String> {
    let roots = if prefer_resolved {
        [
            "resolved",
            "runtimeConfig",
            "config",
            "parsed",
            "sourceConfig",
        ]
    } else {
        [
            "parsed",
            "sourceConfig",
            "config",
            "runtimeConfig",
            "resolved",
        ]
    };
    for root in roots {
        if let Some(value) =
            json_string_at(config, &[root, "agents", "defaults", "model", "primary"])
                .or_else(|| json_string_at(config, &[root, "agents", "defaults", "model"]))
        {
            return Some(value.to_string());
        }
    }
    None
}

fn gateway_string_from_config(
    config: &Value,
    path: &[&str],
    prefer_resolved: bool,
) -> Option<String> {
    let roots = if prefer_resolved {
        [
            "resolved",
            "runtimeConfig",
            "config",
            "parsed",
            "sourceConfig",
        ]
    } else {
        [
            "parsed",
            "sourceConfig",
            "config",
            "runtimeConfig",
            "resolved",
        ]
    };
    for root in roots {
        let mut full_path = Vec::with_capacity(path.len() + 1);
        full_path.push(root);
        full_path.extend(path.iter().copied());
        if let Some(value) = json_string_at(config, &full_path) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn gateway_image_generation_model_from_config(config: &Value) -> Option<String> {
    gateway_string_from_config(
        config,
        &["agents", "defaults", "mediaModels", "image"],
        false,
    )
}

fn gateway_video_generation_model_from_config(config: &Value) -> Option<String> {
    gateway_string_from_config(
        config,
        &["agents", "defaults", "mediaModels", "video"],
        false,
    )
}

fn gateway_tts_model_from_config(config: &Value) -> Option<String> {
    let provider = gateway_string_from_config(config, &["tts", "provider"], false)?;
    let model = gateway_string_from_config(
        config,
        &["tts", "providers", provider.as_str(), "model"],
        false,
    )?;
    Some(format!("{provider}/{model}"))
}

fn gateway_tts_voice_from_config(config: &Value) -> Option<String> {
    let provider = gateway_string_from_config(config, &["tts", "provider"], false)?;
    gateway_string_from_config(
        config,
        &["tts", "providers", provider.as_str(), "voice"],
        false,
    )
    .or_else(|| {
        gateway_string_from_config(
            config,
            &["tts", "providers", provider.as_str(), "voiceId"],
            false,
        )
    })
}

fn gateway_stt_model_from_config(config: &Value) -> Option<String> {
    gateway_string_from_config(
        config,
        &["tools", "media", "audio", "preferredModel"],
        false,
    )
    .or_else(|| gateway_audio_model_from_config(config))
}

fn gateway_audio_model_from_config(config: &Value) -> Option<String> {
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    for root in roots {
        let Some(models) = json_array_at(config, &[root, "tools", "media", "models"]) else {
            continue;
        };
        for model in models {
            let Some(capabilities) = model.get("capabilities").and_then(Value::as_array) else {
                continue;
            };
            if !capabilities
                .iter()
                .any(|value| value.as_str() == Some("audio"))
            {
                continue;
            }
            let provider = model.get("provider").and_then(Value::as_str)?.trim();
            let model_id = model.get("model").and_then(Value::as_str)?.trim();
            if !provider.is_empty() && !model_id.is_empty() {
                return Some(format!("{provider}/{model_id}"));
            }
        }
    }
    None
}

fn gateway_fallback_models_from_config(config: &Value) -> Vec<String> {
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    for root in roots {
        if let Some(items) =
            json_array_at(config, &[root, "agents", "defaults", "model", "fallbacks"])
        {
            return items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect();
        }
    }
    Vec::new()
}

fn gateway_models_array(models: &Value) -> Option<&Vec<Value>> {
    models
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| models.as_array())
}

fn gateway_model_ref(entry: &Value) -> Option<String> {
    json_string_at(entry, &["ref"])
        .or_else(|| json_string_at(entry, &["modelRef"]))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let provider = json_string_at(entry, &["provider"])
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let model = json_string_at(entry, &["id"])
                .or_else(|| json_string_at(entry, &["model"]))
                .or_else(|| json_string_at(entry, &["name"]))?
                .trim();
            if model.is_empty() {
                return None;
            }
            if model.contains('/') {
                return Some(model.to_string());
            }
            Some(format!("{}/{}", provider?, model))
        })
}

fn first_gateway_model_ref(models: &Value) -> Option<String> {
    gateway_models_array(models)?
        .iter()
        .find_map(gateway_model_ref)
}

fn gateway_provider_requires_oauth(provider_key: &str) -> bool {
    matches!(
        provider_key,
        OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER | OPENCLAW_MINIMAX_AUTH_PROVIDER
    )
}

fn gateway_provider_oauth_ready(auth: &Value, provider_key: &str) -> bool {
    gateway_providers_with_oauth(auth)
        .iter()
        .any(|profile| profile == provider_key || profile.starts_with(&format!("{provider_key}:")))
}

fn auth_profile_provider_matches(profile_id: &str, profile: &Value, provider_key: &str) -> bool {
    let provider = json_string_at(profile, &["provider"]).unwrap_or(profile_id);
    provider == provider_key || provider.starts_with(&format!("{provider_key}:"))
}

fn auth_profile_status_label(profile: &Value) -> Option<&'static str> {
    if json_string_at(profile, &["cooldownUntil"]).is_some() {
        return Some("cooldown");
    }
    if profile.get("disabledUntil").is_some() {
        return Some("disabled");
    }
    let status = json_string_at(profile, &["status"])
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if gateway_status_value_is_ready(Some(status)) {
        None
    } else {
        Some(match status {
            "disabled" => "disabled",
            "expired" => "expired",
            "cooldown" => "cooldown",
            "missing" => "missing",
            "invalid" => "invalid",
            _ => "error",
        })
    }
}

fn auth_profile_is_ready(profile: &Value) -> bool {
    auth_profile_status_label(profile).is_none()
}

fn openclaw_auth_payload_has_ready_provider_profile(auth: &Value, provider_key: &str) -> bool {
    if let Some(profiles) = auth.get("profiles").and_then(Value::as_array) {
        return profiles.iter().any(|profile| {
            let profile_id = json_string_at(profile, &["profileId"])
                .or_else(|| json_string_at(profile, &["id"]))
                .unwrap_or_default();
            auth_profile_provider_matches(profile_id, profile, provider_key)
                && auth_profile_is_ready(profile)
        });
    }

    auth.get("profiles")
        .and_then(Value::as_object)
        .map(|profiles| {
            profiles.iter().any(|(profile_id, profile)| {
                auth_profile_provider_matches(profile_id, profile, provider_key)
                    && auth_profile_is_ready(profile)
            })
        })
        .unwrap_or(false)
}

fn openclaw_auth_payload_provider_status(auth: &Value, provider_key: &str) -> Option<&'static str> {
    if let Some(profiles) = auth.get("profiles").and_then(Value::as_array) {
        for profile in profiles {
            let profile_id = json_string_at(profile, &["profileId"])
                .or_else(|| json_string_at(profile, &["id"]))
                .unwrap_or_default();
            if auth_profile_provider_matches(profile_id, profile, provider_key) {
                if let Some(status) = auth_profile_status_label(profile) {
                    return Some(status);
                }
            }
        }
    }
    if let Some(profiles) = auth.get("profiles").and_then(Value::as_object) {
        for (profile_id, profile) in profiles {
            if auth_profile_provider_matches(profile_id, profile, provider_key) {
                if let Some(status) = auth_profile_status_label(profile) {
                    return Some(status);
                }
            }
        }
    }
    None
}

fn gateway_provider_authenticated_with_agent_auth(
    auth: &Value,
    provider_key: &str,
    agent_auth: Option<&Value>,
) -> bool {
    if gateway_provider_requires_oauth(provider_key) {
        return agent_auth
            .map(|auth| openclaw_auth_payload_has_oauth_provider(auth, provider_key))
            .unwrap_or_else(|| gateway_provider_oauth_ready(auth, provider_key));
    }
    if let Some(agent_auth) = agent_auth {
        if openclaw_auth_payload_has_ready_provider_profile(agent_auth, provider_key) {
            return true;
        }
        if openclaw_auth_payload_provider_status(agent_auth, provider_key).is_some() {
            return false;
        }
    }
    gateway_provider_ready(auth, provider_key)
}

fn openclaw_model_ref_is_codex_subscription(model_ref: &str) -> bool {
    matches!(
        model_ref.trim().split_once('/'),
        Some(("openai", "gpt-5.5")) | Some(("openai-codex", "gpt-5.5"))
    )
}

fn openclaw_codex_auth_ready_from_payloads(auth: &Value, agent_auth: Option<&Value>) -> bool {
    if let Some(agent_auth) = agent_auth {
        return {
            openclaw_auth_payload_has_oauth_provider(
                agent_auth,
                OPENCLAW_OPENAI_CODEX_CLI_AUTH_PROVIDER,
            ) || openclaw_auth_payload_has_oauth_provider(
                agent_auth,
                OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER,
            )
        };
    }

    gateway_provider_oauth_ready(auth, OPENCLAW_OPENAI_CODEX_CLI_AUTH_PROVIDER)
        || gateway_provider_oauth_ready(auth, OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER)
}

fn gateway_model_authenticated_with_agent_auth(
    auth: &Value,
    model_ref: &str,
    provider_key: &str,
    agent_auth: Option<&Value>,
) -> bool {
    if openclaw_model_ref_is_codex_subscription(model_ref) {
        return openclaw_codex_auth_ready_from_payloads(auth, agent_auth);
    }
    gateway_provider_authenticated_with_agent_auth(auth, provider_key, agent_auth)
}

fn gateway_configured_model_refs(
    config: &Value,
    primary_model: Option<&str>,
    fallback_models: &[String],
) -> BTreeSet<String> {
    let mut refs = BTreeSet::new();
    if let Some(primary) = primary_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        refs.insert(primary.to_string());
    }
    for model_ref in fallback_models {
        let trimmed = model_ref.trim();
        if !trimmed.is_empty() {
            refs.insert(trimmed.to_string());
        }
    }
    for (model_ref, _) in existing_gateway_model_allowlist(config) {
        let trimmed = model_ref.trim();
        if !trimmed.is_empty() {
            refs.insert(trimmed.to_string());
        }
    }
    refs
}

fn gateway_provider_registered_model_refs(config: &Value) -> BTreeSet<String> {
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    let mut refs = BTreeSet::new();
    for root in roots {
        let Some(providers) = json_object_at(config, &[root, "models", "providers"]) else {
            continue;
        };
        for (provider, provider_config) in providers {
            let Some(models) = provider_config.get("models").and_then(Value::as_array) else {
                continue;
            };
            for item in models {
                let Some(model_id) = json_string_at(item, &["ref"])
                    .or_else(|| json_string_at(item, &["modelRef"]))
                    .or_else(|| json_string_at(item, &["id"]))
                    .or_else(|| json_string_at(item, &["model"]))
                    .or_else(|| json_string_at(item, &["name"]))
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                if model_id.contains('/') {
                    refs.insert(model_id.to_string());
                } else {
                    refs.insert(format!("{provider}/{model_id}"));
                }
            }
        }
    }
    refs
}

fn gateway_model_catalog_entries(
    models: &Value,
    auth: &Value,
    agent_auth: Option<&Value>,
    configured_refs: &BTreeSet<String>,
    provider_registered_refs: &BTreeSet<String>,
) -> Vec<OpenClawModelCatalogEntry> {
    let mut entries = BTreeMap::<String, OpenClawModelCatalogEntry>::new();
    if let Some(items) = gateway_models_array(models) {
        for item in items {
            let Some(model_ref) = gateway_model_ref(item) else {
                continue;
            };
            let Some((provider, model)) = model_ref.split_once('/') else {
                continue;
            };
            let display_name = json_string_at(item, &["name"])
                .or_else(|| json_string_at(item, &["displayName"]))
                .unwrap_or(model)
                .to_string();
            let provider_status = agent_auth
                .and_then(|auth| openclaw_auth_payload_provider_status(auth, provider))
                .or_else(|| gateway_provider_status(auth, provider))
                .map(str::to_string);
            entries.insert(
                model_ref.clone(),
                OpenClawModelCatalogEntry {
                    configured: configured_refs.contains(&model_ref),
                    catalog_available: provider_registered_refs.contains(&model_ref),
                    provider_ready: gateway_model_authenticated_with_agent_auth(
                        auth, &model_ref, provider, agent_auth,
                    ),
                    provider_status,
                    model_ref: model_ref.clone(),
                    provider: provider.to_string(),
                    model: model.to_string(),
                    display_name,
                },
            );
        }
    }

    for model_ref in configured_refs {
        if entries.contains_key(model_ref) {
            continue;
        }
        let Some((provider, model)) = model_ref.split_once('/') else {
            continue;
        };
        entries.insert(
            model_ref.clone(),
            OpenClawModelCatalogEntry {
                model_ref: model_ref.clone(),
                provider: provider.to_string(),
                model: model.to_string(),
                display_name: model.to_string(),
                configured: true,
                catalog_available: false,
                provider_ready: gateway_model_authenticated_with_agent_auth(
                    auth, model_ref, provider, agent_auth,
                ),
                provider_status: agent_auth
                    .and_then(|auth| openclaw_auth_payload_provider_status(auth, provider))
                    .or_else(|| gateway_provider_status(auth, provider))
                    .map(str::to_string),
            },
        );
    }

    entries.into_values().collect()
}

fn gateway_provider_ready(auth: &Value, provider_key: &str) -> bool {
    auth.get("providers")
        .and_then(Value::as_array)
        .map(|providers| {
            providers.iter().any(|provider| {
                json_string_at(provider, &["provider"]) == Some(provider_key)
                    && gateway_status_value_is_ready(json_string_at(provider, &["status"]))
            })
        })
        .unwrap_or(false)
}

fn gateway_provider_status<'a>(auth: &'a Value, provider_key: &str) -> Option<&'a str> {
    auth.get("providers")
        .and_then(Value::as_array)?
        .iter()
        .find(|provider| json_string_at(provider, &["provider"]) == Some(provider_key))
        .and_then(|provider| json_string_at(provider, &["status"]))
}

fn gateway_status_value_is_ready(status: Option<&str>) -> bool {
    matches!(
        status.map(|value| value.trim().to_lowercase()),
        Some(value)
            if matches!(
                value.as_str(),
                "ok" | "ready" | "active" | "configured" | "valid" | "healthy"
            )
    )
}

fn gateway_providers_with_oauth(auth: &Value) -> Vec<String> {
    let mut providers = Vec::new();
    if let Some(items) = auth.get("providers").and_then(Value::as_array) {
        for provider in items {
            let provider_id = json_string_at(provider, &["provider"]).unwrap_or_default();
            if provider_id.is_empty() {
                continue;
            }
            let provider_ok = gateway_status_value_is_ready(json_string_at(provider, &["status"]));
            if let Some(profiles) = provider.get("profiles").and_then(Value::as_array) {
                for profile in profiles {
                    if json_string_at(profile, &["type"]) != Some("oauth") {
                        continue;
                    }
                    let profile_ok =
                        gateway_status_value_is_ready(json_string_at(profile, &["status"]));
                    if provider_ok || profile_ok {
                        providers.push(
                            json_string_at(profile, &["profileId"])
                                .unwrap_or(provider_id)
                                .to_string(),
                        );
                    }
                }
            } else if provider_ok && !gateway_provider_requires_oauth(provider_id) {
                providers.push(provider_id.to_string());
            }
        }
    }
    if let Some(items) = auth.get("profiles").and_then(Value::as_array) {
        for profile in items {
            if json_string_at(profile, &["type"]) != Some("oauth") {
                continue;
            }
            let provider = json_string_at(profile, &["provider"]).unwrap_or_default();
            let profile_id = json_string_at(profile, &["profileId"])
                .or_else(|| json_string_at(profile, &["id"]))
                .unwrap_or(provider);
            if !profile_id.trim().is_empty() {
                providers.push(profile_id.to_string());
            }
        }
    }
    if let Some(items) = auth.get("profiles").and_then(Value::as_object) {
        for (profile_id, profile) in items {
            if json_string_at(profile, &["type"]) != Some("oauth") {
                continue;
            }
            if !profile_id.trim().is_empty() {
                providers.push(profile_id.to_string());
            }
        }
    }
    providers.sort();
    providers.dedup();
    providers
}

fn auth_profiles_array(auth: &Value) -> Option<&Vec<Value>> {
    auth.get("profiles")
        .and_then(Value::as_array)
        .or_else(|| auth.as_array())
}

fn gateway_auth_profile_labels(auth: &Value) -> Vec<String> {
    let mut labels = Vec::new();
    if let Some(items) = auth.get("providers").and_then(Value::as_array) {
        for provider in items {
            if let Some(profiles) = provider.get("profiles").and_then(Value::as_array) {
                for profile in profiles {
                    if let Some(profile_id) = json_string_at(profile, &["profileId"]) {
                        let status = json_string_at(profile, &["status"]).unwrap_or("unknown");
                        if status == "ok" {
                            labels.push(profile_id.to_string());
                        } else {
                            labels.push(format!("{profile_id} [{status}]"));
                        }
                    }
                }
            }
        }
    }
    if let Some(profiles) = auth_profiles_array(auth) {
        for profile in profiles {
            let Some(profile_id) = json_string_at(profile, &["profileId"])
                .or_else(|| json_string_at(profile, &["id"]))
            else {
                continue;
            };
            if let Some(status) = auth_profile_status_label(profile) {
                labels.push(format!("{profile_id} [{status}]"));
            } else {
                labels.push(profile_id.to_string());
            }
        }
    }
    if let Some(profiles) = auth.get("profiles").and_then(Value::as_object) {
        for (profile_id, profile) in profiles {
            if let Some(status) = auth_profile_status_label(profile) {
                labels.push(format!("{profile_id} [{status}]"));
            } else {
                labels.push(profile_id.to_string());
            }
        }
    }
    labels.sort();
    labels.dedup();
    labels
}

// Provider ids that have a real config block under `models.providers` (a
// non-empty apiKey or baseUrl). Distinct from "referenced by a configured model
// ref" — a ref can point at `uniopc-official/*` while the provider block itself
// is missing/wiped, which is exactly the broken state that fails every send.
fn config_provider_block_ids(config: &Value) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    if let Some(providers) = config
        .get("models")
        .and_then(|models| models.get("providers"))
        .and_then(Value::as_object)
    {
        for (id, block) in providers {
            let non_empty = |field: &str| {
                block
                    .get(field)
                    .and_then(Value::as_str)
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
            };
            if non_empty("apiKey") || non_empty("baseUrl") {
                ids.insert(id.clone());
            }
        }
    }
    ids
}

fn gateway_provider_snapshots(
    auth: &Value,
    agent_auth: Option<&Value>,
    model_entries: &[OpenClawModelCatalogEntry],
    configured_refs: &BTreeSet<String>,
    configured_block_ids: &BTreeSet<String>,
) -> Vec<OpenClawProviderSnapshot> {
    let mut provider_ids = BTreeSet::<String>::new();
    if let Some(items) = auth.get("providers").and_then(Value::as_array) {
        for provider in items {
            if let Some(provider_id) = json_string_at(provider, &["provider"]) {
                if !provider_id.trim().is_empty() {
                    provider_ids.insert(provider_id.to_string());
                }
            }
        }
    }
    for entry in model_entries {
        provider_ids.insert(entry.provider.clone());
    }
    for model_ref in configured_refs {
        if let Some(provider) = openclaw_provider_key_from_ref(model_ref) {
            provider_ids.insert(provider.to_string());
        }
    }

    provider_ids
        .into_iter()
        .map(|id| {
            let ready = gateway_provider_authenticated_with_agent_auth(auth, &id, agent_auth);
            let status = agent_auth
                .and_then(|auth| openclaw_auth_payload_provider_status(auth, &id))
                .map(str::to_string)
                .or_else(|| gateway_provider_status(auth, &id).map(str::to_string));
            let auth_profiles = agent_auth
                .map(|auth| gateway_auth_profile_labels_for_provider(auth, &id))
                .unwrap_or_else(|| gateway_auth_profile_labels_for_provider(auth, &id));
            let recommended_model = model_entries
                .iter()
                .find(|entry| entry.provider == id && entry.provider_ready)
                .or_else(|| model_entries.iter().find(|entry| entry.provider == id))
                .map(|entry| entry.model_ref.clone())
                .or_else(|| recommended_model_for_provider(&id).map(str::to_string));
            let configured = configured_block_ids.contains(&id);
            OpenClawProviderSnapshot {
                label: provider_display_label(&id).to_string(),
                auth_kind: provider_auth_kind(&id).to_string(),
                login_supported: provider_login_supported(&id),
                id,
                configured,
                ready,
                status,
                auth_profiles,
                recommended_model,
            }
        })
        .collect()
}

fn gateway_auth_profile_labels_for_provider(auth: &Value, provider_key: &str) -> Vec<String> {
    let mut labels = Vec::new();
    if let Some(items) = auth.get("providers").and_then(Value::as_array) {
        for provider in items {
            if json_string_at(provider, &["provider"]) != Some(provider_key) {
                continue;
            }
            if let Some(profiles) = provider.get("profiles").and_then(Value::as_array) {
                for profile in profiles {
                    if let Some(profile_id) = json_string_at(profile, &["profileId"]) {
                        let status = json_string_at(profile, &["status"]).unwrap_or("unknown");
                        if status == "ok" {
                            labels.push(profile_id.to_string());
                        } else {
                            labels.push(format!("{profile_id} [{status}]"));
                        }
                    }
                }
            }
        }
    }
    if let Some(profiles) = auth_profiles_array(auth) {
        for profile in profiles {
            let provider = json_string_at(profile, &["provider"])
                .or_else(|| json_string_at(profile, &["id"]))
                .unwrap_or_default();
            if !provider.starts_with(provider_key) {
                continue;
            }
            let Some(profile_id) = json_string_at(profile, &["profileId"])
                .or_else(|| json_string_at(profile, &["id"]))
            else {
                continue;
            };
            if let Some(status) = auth_profile_status_label(profile) {
                labels.push(format!("{profile_id} [{status}]"));
            } else {
                labels.push(profile_id.to_string());
            }
        }
    }
    if let Some(profiles) = auth.get("profiles").and_then(Value::as_object) {
        for (profile_id, profile) in profiles {
            let provider = json_string_at(profile, &["provider"]).unwrap_or(profile_id);
            if !provider.starts_with(provider_key) {
                continue;
            }
            if let Some(status) = auth_profile_status_label(profile) {
                labels.push(format!("{profile_id} [{status}]"));
            } else {
                labels.push(profile_id.to_string());
            }
        }
    }
    labels.sort();
    labels.dedup();
    labels
}

fn provider_display_label(provider: &str) -> &'static str {
    match provider {
        "openai" => "OpenAI API",
        "openai-codex" => "OpenAI Codex",
        "minimax-portal" => "MiniMax",
        OPENCLAW_UNIOPC_OFFICIAL_PROVIDER => "Uniopc 官方模型",
        OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER => "阿里云百炼 Token Plan",
        "qwen" => "Qwen Coding Plan",
        "zai" => "Z.AI / GLM",
        "anthropic" => "Anthropic Claude",
        "github-copilot" => "GitHub Copilot",
        "google" | "google-gemini-cli" => "Google Gemini",
        _ => "Custom Provider",
    }
}

fn provider_auth_kind(provider: &str) -> &'static str {
    match provider {
        "openai-codex" | "github-copilot" | "google-gemini-cli" => "oauth",
        "minimax-portal" => "subscription_oauth",
        OPENCLAW_UNIOPC_OFFICIAL_PROVIDER => "official_token",
        OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER => "api_key",
        "qwen" | "zai" => "coding_plan_or_api_key",
        "anthropic" => "api_key_or_cli",
        _ => "api_key",
    }
}

fn provider_login_supported(provider: &str) -> bool {
    matches!(
        provider,
        "openai"
            | "openai-codex"
            | "minimax-portal"
            | OPENCLAW_UNIOPC_OFFICIAL_PROVIDER
            | OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER
            | "qwen"
            | "zai"
            | "deepseek"
            | "anthropic"
            | "github-copilot"
            | "google"
            | "google-gemini-cli"
    )
}

fn recommended_model_for_provider(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some(OPENCLAW_OPENAI_API_DEFAULT_MODEL),
        "openai-codex" => Some(OPENCLAW_OPENAI_CODEX_DEFAULT_MODEL),
        "minimax-portal" => Some(OPENCLAW_MINIMAX_DEFAULT_MODEL),
        OPENCLAW_UNIOPC_OFFICIAL_PROVIDER => Some(OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL),
        OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER => Some(OPENCLAW_BAILIAN_TOKEN_PLAN_DEFAULT_MODEL),
        "qwen" => Some(OPENCLAW_QWEN_CODING_PLAN_DEFAULT_MODEL),
        "zai" => Some("zai/glm-5"),
        "deepseek" => Some(OPENCLAW_DEEPSEEK_DEFAULT_MODEL),
        "anthropic" => Some("anthropic/claude-sonnet-4-6"),
        "github-copilot" => Some("github-copilot/gpt-4.1"),
        "google" | "google-gemini-cli" => Some("google/gemini-3.1-pro-preview"),
        _ => None,
    }
}

fn openclaw_auth_payload_has_oauth_provider(auth: &Value, provider_prefix: &str) -> bool {
    if gateway_providers_with_oauth(auth)
        .iter()
        .any(|provider| provider.starts_with(provider_prefix))
    {
        return true;
    }

    if let Some(profiles) = auth_profiles_array(auth) {
        return profiles.iter().any(|profile| {
            let provider = json_string_at(profile, &["provider"])
                .or_else(|| json_string_at(profile, &["id"]))
                .unwrap_or_default();
            json_string_at(profile, &["type"]) == Some("oauth")
                && provider.starts_with(provider_prefix)
        });
    }

    auth.get("profiles")
        .and_then(Value::as_object)
        .map(|profiles| {
            profiles.iter().any(|(profile_id, profile)| {
                let provider = json_string_at(profile, &["provider"]).unwrap_or(profile_id);
                json_string_at(profile, &["type"]) == Some("oauth")
                    && provider.starts_with(provider_prefix)
            })
        })
        .unwrap_or(false)
}

fn openclaw_provider_key_from_ref(model_ref: &str) -> Option<&str> {
    let trimmed = model_ref.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .split('/')
        .next()
        .filter(|provider| !provider.is_empty())
}

fn openclaw_provider_mode_from_ref(
    model_ref: &str,
    _openai_codex_oauth_ready: bool,
    minimax_oauth_ready: bool,
) -> Option<String> {
    match openclaw_provider_key_from_ref(model_ref) {
        Some("ollama") => None,
        Some("openai") if openclaw_model_ref_is_codex_subscription(model_ref) => {
            Some("openai-codex".to_string())
        }
        Some("openai") => Some("openai-api".to_string()),
        Some("openai-codex") => Some("openai-codex".to_string()),
        Some("minimax-portal") if minimax_oauth_ready => Some("minimax-oauth".to_string()),
        Some("minimax-portal") => Some("minimax".to_string()),
        Some("anthropic") => Some("anthropic".to_string()),
        Some("google") => Some("google".to_string()),
        Some("azure-openai") => Some("azure-openai".to_string()),
        Some(other) => Some(other.to_string()),
        None => None,
    }
}

/// Warm-start fast path: when `runtime/current` resolves to a valid install
/// of the pinned version, resolve binary/version/node from fixed private
/// paths. Saves the 3 login-shell spawns `build_openclaw_status` would
/// otherwise pay on every app start. Returns None whenever the private
/// runtime is not active (dev builds, pre-extraction) so the shell probes
/// stay the source of truth there.
fn bundled_runtime_status_probe() -> Option<(String, String, Option<String>)> {
    let required = imai_openclaw_install_version();
    if required == "latest" {
        return None;
    }
    if !openclaw_bundled_runtime::active_runtime_matches(&required) {
        return None;
    }
    let current = uniopc_runtime_paths::runtime_current_dir().ok()?;
    let shim = if cfg!(target_os = "windows") {
        // Windows npm-prefix layout: shim sits at tools/node/, not bin/.
        current.join("tools").join("node").join("uniopc-engine.cmd")
    } else {
        current.join("bin").join("uniopc-engine")
    };
    if !shim.exists() {
        return None;
    }
    let node_version = fs::read_link(current.join("tools").join("node"))
        .ok()
        .and_then(|target| {
            target
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .map(|name| {
            name.strip_prefix("node-")
                .map(str::to_string)
                .unwrap_or(name)
        });
    Some((shim.to_string_lossy().to_string(), required, node_version))
}

async fn build_openclaw_status(app: &AppHandle) -> OpenClawStatus {
    let supported =
        cfg!(target_os = "windows") || cfg!(target_os = "macos") || cfg!(target_os = "linux");
    let (binary_path, version, node_version) = if let Some((
        bundled_binary,
        bundled_version,
        bundled_node,
    )) = bundled_runtime_status_probe()
    {
        (
            Some(bundled_binary),
            Some(bundled_version),
            bundled_node.or_else(|| Some("已检测到 Node.js".to_string())),
        )
    } else if imai_openclaw_install_version() != "latest" {
        // A pinned bundle is expected but not active yet. The core engine is
        // embedded-only: never report a system `openclaw` as the engine —
        // surface "not installed" so the app activates the bundle instead of
        // silently running a stale global binary.
        (None, None, None)
    } else {
        let binary_path = if cfg!(target_os = "windows") {
            shell_probe(
                app,
                "Get-Command openclaw -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source",
            )
            .await
        } else {
            shell_probe(app, "command -v openclaw 2>/dev/null").await
        }
        .or_else(|| existing_binary_path("openclaw"));
        let version = if cfg!(target_os = "windows") {
            shell_probe(
                app,
                "if (Get-Command openclaw -ErrorAction SilentlyContinue) { try { openclaw --version } catch { openclaw -v } }",
            )
            .await
        } else {
            shell_probe(
                app,
                "openclaw --version 2>/dev/null || openclaw -v 2>/dev/null",
            )
            .await
        };
        let node_version = if cfg!(target_os = "windows") {
            shell_probe(
                app,
                "if (Get-Command node -ErrorAction SilentlyContinue) { node --version }",
            )
            .await
        } else {
            shell_probe(app, "node --version 2>/dev/null").await
        }
        .or_else(|| existing_binary_path("node").map(|_| "已检测到 Node.js".to_string()));
        (binary_path, version, node_version)
    };
    let installed = binary_path.is_some() || version.is_some();
    let gateway_status = if installed {
        openclaw_gateway_status(app).await
    } else {
        OpenClawGatewayStatus {
            running: false,
            rpc_ok: false,
            health_ok: false,
            rpc_blocked: false,
            message: None,
            dashboard_url: OPENCLAW_DASHBOARD_URL.to_string(),
            ws_url: OPENCLAW_GATEWAY_WS_URL.to_string(),
            device_id: None,
            public_key: None,
        }
    };
    let version_supported = !installed || openclaw_version_is_supported(version.as_deref());
    let gateway_running = gateway_is_ready_for_app(&gateway_status);
    let model_status = if installed && version_supported && gateway_running {
        openclaw_model_status(app).await
    } else {
        None
    };
    let provider_ready = model_status
        .as_ref()
        .map(|status| status.provider_ready)
        .unwrap_or(false);
    let provider_mode = model_status
        .as_ref()
        .and_then(|status| status.provider_mode.clone());
    let app_ready = installed && version_supported && provider_ready && gateway_running;
    let setup_stage = if !supported {
        "unsupported"
    } else if !installed {
        "missing_openclaw"
    } else if !version_supported {
        "unsupported_openclaw_version"
    } else if !gateway_running {
        "missing_gateway"
    } else if !provider_ready {
        "missing_provider"
    } else {
        "ready"
    }
    .to_string();
    let base_message = if !supported {
        "当前系统暂不支持 Uniopc 引擎 一键安装。".to_string()
    } else if !installed {
        if node_version.is_some() {
            "未检测到 Uniopc 引擎。可点击一键安装，安装脚本会复用当前 Node.js 环境。".to_string()
        } else {
            "未检测到 Uniopc 引擎。可点击一键安装，官方脚本会准备 Node.js 等依赖。".to_string()
        }
    } else if !version_supported {
        let current = version
            .as_deref()
            .and_then(extract_version_number)
            .unwrap_or_else(|| "未知版本".to_string());
        let required = imai_openclaw_install_version();
        format!(
            "已检测到 Uniopc 引擎 {current}，与 Uniopc 已验证兼容版本 {required} 不匹配。请先安装兼容版本。"
        )
    } else if !gateway_running {
        "已检测到 Uniopc 引擎，下一步启动 Gateway；模型和 provider 状态将通过 Gateway RPC 读取。"
            .to_string()
    } else if !provider_ready {
        "已检测到 Uniopc 引擎，但还没有可用的大模型来源。请先配置 OpenAI API 或 OpenAI Codex。"
            .to_string()
    } else if gateway_running {
        "已检测到 Uniopc 引擎，AI 员工运行基础已就绪。".to_string()
    } else {
        "Uniopc 引擎 状态未知。".to_string()
    };
    let message = if supported {
        format!("{base_message} {}", openclaw_platform_lifecycle_hint())
    } else {
        base_message
    };

    let default_model = model_status
        .as_ref()
        .and_then(|status| status.default_model.clone());
    let resolved_default_model = model_status
        .as_ref()
        .and_then(|status| status.resolved_default_model.clone());
    let auth_profile_labels = model_status
        .as_ref()
        .map(|status| status.auth_profile_labels.clone())
        .unwrap_or_default();
    let runtime_compat_ready = model_status
        .as_ref()
        .map(|status| status.runtime_compat_ready)
        .unwrap_or(true);
    let runtime_compat_message = model_status
        .as_ref()
        .and_then(|status| status.runtime_compat_message.clone());

    let status = OpenClawStatus {
        installed,
        supported,
        platform: openclaw_platform(),
        message,
        setup_stage,
        provider_ready,
        provider_mode,
        app_ready,
        version,
        latest_version: None,
        update_available: None,
        update_message: None,
        runtime_cleanup_warning: crate::services::openclaw_bundled_runtime::runtime_cleanup_warning(),
        binary_path,
        node_version,
        dashboard_url: gateway_status.dashboard_url.clone(),
        gateway_ws_url: gateway_status.ws_url.clone(),
        gateway_running,
        gateway_rpc_ok: gateway_status.rpc_ok,
        gateway_status_message: gateway_status.message.clone(),
        gateway_device_id: gateway_status.device_id.clone(),
        gateway_public_key: gateway_status.public_key.clone(),
        default_model,
        resolved_default_model,
        auth_profile_labels,
        runtime_compat_ready,
        runtime_compat_message,
        install_command: openclaw_install_command(),
        update_command: openclaw_update_command(),
        uninstall_command: openclaw_uninstall_command(),
        proxy_summary: proxy_summary_for_diagnostics(),
    };
    eprintln!(
        "[openclaw_status] installed={} binary_path={:?} version={:?} node_version={:?} gateway_running={} gateway_rpc_ok={} default_model={:?} resolved_default_model={:?}",
        status.installed,
        status.binary_path,
        status.version,
        status.node_version,
        status.gateway_running,
        status.gateway_rpc_ok,
        status.default_model,
        status.resolved_default_model
    );
    status
}

/// A config file alone does not mean onboard completed: the desktop can write
/// a gateway block before OpenClaw has created meaningful agent defaults.
/// OpenClaw 8.1 may take the workspace from `OPENCLAW_WORKSPACE_DIR` without
/// persisting `agents.defaults.workspace`, so workspace alone is not a valid
/// completion marker.
pub(crate) fn openclaw_profile_config_is_initialized(config: &Value) -> bool {
    config
        .pointer("/agents/defaults")
        .and_then(Value::as_object)
        .is_some_and(|defaults| !defaults.is_empty())
}

async fn openclaw_profile_provision_impl(
    app: AppHandle,
    input: OpenClawProfileProvisionRequest,
) -> Result<OpenClawProfileProvisionResult, String> {
    let profile = validate_openclaw_profile_handle(&input.profile)?;
    let ensure_current = || match input.startup_generation {
        Some(generation) => {
            crate::commands::openclaw_connection::ensure_local_gateway_generation(generation)
        }
        None => Err("profile provision requires a coordinated startup generation".to_string()),
    };
    ensure_current()?;
    uniopc_runtime_paths::write_active_profile_key(&profile)?;
    let (gateway_port, gateway_url, dashboard_url) = local_profile_gateway_urls_for_mode(
        &profile,
        input.gateway_port,
        input.managed_member_profile,
    );
    let gateway_port_text = gateway_port.to_string();
    let config = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile))?;
    // Provision owns only onboard and static isolation. The coordinator alone
    // owns spawn, the startup budget and every post-ready config RPC.
    let output = if !openclaw_profile_config_is_initialized(&config) {
        // Pin the default agent workspace into our private state dir at setup time.
        // Config `agents.defaults.workspace` (what onboard bakes here) is the ONLY
        // lever that beats the engine's `<home>/.openclaw/workspace` default AND any
        // stale value already baked on existing machines (env can't override a
        // config value). Matches OPENCLAW_WORKSPACE_DIR in state_env_for_profile.
        let workspace_dir =
            crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(Some(
                &profile,
            ))
            .map(|dir| dir.join("workspace").to_string_lossy().into_owned())
            .ok();
        let mut onboard_args: Vec<&str> = vec![
            "onboard",
            "--non-interactive",
            "--accept-risk",
            "--auth-choice",
            "skip",
            "--mode",
            "local",
            "--flow",
            "quickstart",
            "--gateway-bind",
            "loopback",
            "--gateway-port",
            gateway_port_text.as_str(),
            // Pure sidecar: onboard writes config + gateway block (mode/bind/port) +
            // workspace, but installs no system service. The gateway is spawned as an
            // app-owned child by GatewaySupervisor::ensure_running (see
            // openclaw_connection_start_local). OpenClaw 2026.8.1 otherwise waits
            // for an already-running gateway here, which cannot exist yet.
            "--skip-health",
            "--skip-ui",
            "--skip-channels",
            "--skip-search",
        ];
        if let Some(workspace_dir) = workspace_dir.as_deref() {
            onboard_args.push("--workspace");
            onboard_args.push(workspace_dir);
        }
        ensure_current()?;
        let output = openclaw_output_for_profile(&app, &profile, &onboard_args)
            .await
            .map_err(|error| format!("创建或启动 Uniopc 引擎 profile `{profile}` 失败: {error}"))?;

        output
    } else {
        String::new()
    };
    ensure_current()?;
    crate::commands::openclaw_plugins::cleanup_legacy_acpx_bridge_for_profile(&profile)?;
    ensure_current()?;
    ensure_profile_local_discovery_disabled(&profile)?;
    Ok(OpenClawProfileProvisionResult {
        profile,
        host_name: local_host_name(),
        gateway_port,
        gateway_url,
        dashboard_url,
        gateway_status: "prepared".to_string(),
        output_tail: Some(tail_lines(&output, 24)).filter(|s| !s.is_empty()),
    })
}

async fn openclaw_profile_status_impl(
    app: AppHandle,
    input: OpenClawProfileStatusRequest,
) -> Result<OpenClawProfileStatusResult, String> {
    let profile = validate_openclaw_profile_handle(&input.profile)?;
    let config_path = openclaw_gateway::openclaw_config_path_for_profile(Some(&profile))?;
    let profile_exists = config_path.exists();
    let managed_member_profile = input.managed_member_profile;
    let urls = if profile_exists {
        local_profile_gateway_urls_for_mode(&profile, input.gateway_port, managed_member_profile)
    } else {
        profile_gateway_urls_for_mode(&profile, input.gateway_port, managed_member_profile)
    };
    let configured_port_mismatch = if profile_exists {
        profile_gateway_port_mismatch(&profile, urls.0, managed_member_profile)
    } else {
        None
    };

    if !profile_exists {
        return Ok(OpenClawProfileStatusResult {
            profile,
            profile_exists,
            host_name: local_host_name(),
            gateway_port: urls.0,
            gateway_url: urls.1,
            dashboard_url: urls.2,
            gateway_running: false,
            gateway_rpc_ok: false,
            gateway_status: "offline".to_string(),
            provider_ready: false,
            provider_mode: None,
            default_model: None,
            resolved_default_model: None,
            runtime_compat_ready: true,
            runtime_compat_message: None,
            message: Some("本机尚未检测到这个 Uniopc 引擎 profile。".to_string()),
        });
    }

    let gateway_health_probe = timeout(
        Duration::from_secs(OPENCLAW_PROFILE_STATUS_HEALTH_TIMEOUT_SECS),
        openclaw_gateway::health(Some(&profile)),
    )
    .await;

    let gateway_probe = match gateway_health_probe {
        Ok(Ok(value)) => gateway_status_from_profile_health(&profile, &value, &urls),
        Ok(Err(health_error)) => {
            match openclaw_output_for_profile(&app, &profile, &["gateway", "status", "--json"])
                .await
            {
                Ok(output) => parse_openclaw_gateway_status(&output, true),
                Err(error) => OpenClawGatewayStatus {
                    running: false,
                    rpc_ok: false,
                    health_ok: false,
                    rpc_blocked: gateway_rpc_is_blocked(&error)
                        || gateway_rpc_is_blocked(&health_error),
                    message: Some(format!("{health_error}\n{error}")),
                    dashboard_url: urls.2.clone(),
                    ws_url: urls.1.clone(),
                    device_id: None,
                    public_key: None,
                },
            }
        }
        Err(_) => {
            match openclaw_output_for_profile(&app, &profile, &["gateway", "status", "--json"])
                .await
            {
                Ok(output) => parse_openclaw_gateway_status(&output, true),
                Err(error) => OpenClawGatewayStatus {
                    running: false,
                    rpc_ok: false,
                    health_ok: false,
                    rpc_blocked: gateway_rpc_is_blocked(&error),
                    message: Some(format!(
                        "Uniopc 引擎 profile `{profile}` health 检测超时。\n{error}"
                    )),
                    dashboard_url: urls.2.clone(),
                    ws_url: urls.1.clone(),
                    device_id: None,
                    public_key: None,
                },
            }
        }
    };
    let gateway_running =
        configured_port_mismatch.is_none() && gateway_is_ready_for_app(&gateway_probe);
    let resolved_urls = if configured_port_mismatch.is_some() {
        urls
    } else {
        gateway_urls_from_probe(urls, &gateway_probe)
    };
    let gateway_status = if gateway_running {
        "online"
    } else if configured_port_mismatch.is_some() {
        "degraded"
    } else if gateway_probe.running {
        "degraded"
    } else {
        "offline"
    };
    let message = if gateway_running {
        None
    } else if let Some(configured_port) = configured_port_mismatch {
        Some(format!(
            "Uniopc 引擎 profile `{profile}` Gateway 端口配置为 {configured_port}，应为 {expected_port}。请执行创建/修复以重启本机 Gateway。",
            expected_port = resolved_urls.0
        ))
    } else {
        gateway_probe.message.clone()
    };
    let model_status = if gateway_running {
        openclaw_model_status_from_gateway_for_profile_with_cli_auth(&app, Some(&profile), false)
            .await
            .ok()
    } else {
        None
    };

    Ok(OpenClawProfileStatusResult {
        profile,
        profile_exists,
        host_name: gateway_probe
            .device_id
            .clone()
            .unwrap_or_else(local_host_name),
        gateway_port: resolved_urls.0,
        gateway_url: resolved_urls.1,
        dashboard_url: resolved_urls.2,
        gateway_running,
        gateway_rpc_ok: gateway_running,
        gateway_status: gateway_status.to_string(),
        provider_ready: model_status
            .as_ref()
            .map(|status| status.provider_ready)
            .unwrap_or(false),
        provider_mode: model_status
            .as_ref()
            .and_then(|status| status.provider_mode.clone()),
        default_model: model_status
            .as_ref()
            .and_then(|status| status.default_model.clone()),
        resolved_default_model: model_status
            .as_ref()
            .and_then(|status| status.resolved_default_model.clone()),
        runtime_compat_ready: model_status
            .as_ref()
            .map(|status| status.runtime_compat_ready)
            .unwrap_or(true),
        runtime_compat_message: model_status
            .as_ref()
            .and_then(|status| status.runtime_compat_message.clone()),
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_delta_preserves_custom_selection_and_never_replays_redacted_secrets() {
        let config = serde_json::json!({
            "agents":{"defaults":{"model":{"primary":"customer/model"},"models":{"customer/model":{"alias":"mine"}}}},
            "tools":{"alsoAllow":["user-tool"]}, "plugins":{"entries":{"user-plugin":{"enabled":true}}},
            "env":{"vars":{"USER":"keep","USER_TOKEN":"__OPENCLAW_REDACTED__","IMAI_CLOUD_AGENT_AUTH_TOKEN":"__OPENCLAW_REDACTED__"}}
        });
        let snapshot = serde_json::json!({"sourceConfig":config,"hash":"snapshot-one"});
        let delta = startup_defaults_delta(&snapshot, "profile-a", None, Some("explicit-new-secret"), None, None).unwrap();
        assert_eq!(delta.pointer("/agents/defaults/model/primary"), None);
        assert_eq!(delta.get("tools"), None);
        assert_eq!(delta.pointer("/plugins/entries/user-plugin"), None);
        assert_eq!(delta.pointer("/env/vars/USER"), None);
        assert_eq!(delta.pointer("/env/vars/USER_TOKEN"), None);
        assert_eq!(delta.pointer("/env/vars/IMAI_CLOUD_AGENT_AUTH_TOKEN"), Some(&serde_json::json!("explicit-new-secret")));
        assert!(!delta.to_string().contains("REDACTED"));
        assert_eq!(delta.pointer("/agents/defaults/models/customer~1model"), None);
    }

    #[test]
    fn startup_defaults_are_noop_once_actual_nonsecret_delta_is_present() {
        let mut config = serde_json::json!({"agents":{"defaults":{"model":{"primary":"custom/model"}}}});
        fn apply(target: &mut Value, patch: Value) {
            if let Some(object) = patch.as_object() {
                if !target.is_object() { *target = serde_json::json!({}); }
                for (key, value) in object {
                    if value.is_null() { target.as_object_mut().unwrap().remove(key); }
                    else { apply(&mut target[key], value.clone()); }
                }
            } else { *target = patch; }
        }
        let delta = startup_defaults_delta(&serde_json::json!({"sourceConfig":config,"hash":"one"}), "profile-a", None, None, None, None).unwrap();
        apply(&mut config, delta);
        let warm = startup_defaults_delta(&serde_json::json!({"sourceConfig":config,"hash":"two"}), "profile-a", None, None, None, None).unwrap();
        assert_eq!(warm, serde_json::json!({}));
        assert_eq!(config.pointer("/agents/defaults/model/primary"), Some(&serde_json::json!("custom/model")));
    }

    #[test]
    fn an_old_gateway_child_cannot_authorize_runtime_cleanup() {
        assert!(!gateway_runtime_matches_active(
            Some("new-runtime-digest"),
            "old-runtime-digest"
        ));
        assert!(gateway_runtime_matches_active(
            Some("new-runtime-digest"),
            "new-runtime-digest"
        ));
        assert!(!gateway_runtime_matches_active(None, "old-runtime-digest"));
    }

    #[test]
    fn legacy_gateway_logs_move_to_branded_names_and_are_sanitized() {
        let root = std::env::temp_dir().join(format!("uniopc-log-migration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("gateway-default.log"), "OpenClaw started\n小龙虾 ready\n").unwrap();
        fs::write(root.join("gateway-default.log.prev"), "OpenClaw previous run\n").unwrap();
        migrate_legacy_gateway_log_names(&root, "default").unwrap();
        assert_eq!(fs::read_to_string(root.join("uniopc-engine-gateway-default.log")).unwrap(), "Uniopc started\nUniopc ready\n");
        assert_eq!(fs::read_to_string(root.join("uniopc-engine-gateway-default.log.prev")).unwrap(), "Uniopc previous run\n");
        assert!(!root.join("gateway-default.log").exists());
        assert!(!root.join("gateway-default.log.prev").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn mobile_lan_stop_failure_rolls_back_marker_and_config_bytes() {
        let root = std::env::temp_dir().join(format!(
            "uniopc-mobile-lan-rollback-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let marker = root.join("enabled");
        let config = root.join("openclaw.json");
        fs::write(&config, b"old-config").unwrap();

        let result = commit_mobile_lan_files(
            &marker,
            &config,
            true,
            || fs::write(&config, b"new-config").map_err(|error| error.to_string()),
            || async { Err("stop failed".to_string()) },
        )
        .await;

        assert_eq!(result.unwrap_err(), "stop failed".to_string());
        assert!(!marker.exists());
        assert_eq!(fs::read(&config).unwrap(), b"old-config");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn mobile_lan_restart_failures_restore_authoritative_disk_config_and_runtime() {
        for failure in [
            "runtime preparation failed",
            "spawn failed",
            "readiness failed",
        ] {
            let root = std::env::temp_dir().join(format!(
                "uniopc-mobile-lan-restart-rollback-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&root).unwrap();
            let marker = root.join("enabled");
            let config = root.join("openclaw.json");
            fs::write(&config, br#"{"gateway":{"bind":"loopback"}}"#).unwrap();

            let rollback = commit_mobile_lan_files(
                &marker,
                &config,
                true,
                || {
                    fs::write(&config, br#"{"gateway":{"bind":"lan"}}"#)
                        .map_err(|error| error.to_string())
                },
                || async { Ok(()) },
            )
            .await
            .unwrap();
            assert!(marker.exists());
            assert_eq!(fs::read(&config).unwrap(), br#"{"gateway":{"bind":"lan"}}"#);

            let old_runtime_restored =
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let restored = old_runtime_restored.clone();
            let marker_for_recovery = marker.clone();
            let config_for_recovery = config.clone();
            let error = complete_mobile_lan_restart(
                || async { Err(failure.to_string()) },
                || async move {
                    finish_mobile_lan_recovery(
                        || async {
                            (
                                rollback.restore(&marker_for_recovery, &config_for_recovery),
                                Ok(()),
                                mobile_lan_authority_from_paths(
                                    &marker_for_recovery,
                                    &config_for_recovery,
                                ),
                            )
                        },
                        || async move {
                            restored.store(true, std::sync::atomic::Ordering::SeqCst);
                            Ok(())
                        },
                    )
                    .await
                },
                || mobile_lan_authority_from_paths(&marker, &config),
            )
            .await
            .unwrap_err();

            assert_eq!(error.authoritative_enabled, Some(false));
            assert!(!error.recovery_required);
            assert!(error.message.contains(failure));
            assert!(
                !marker.exists(),
                "UI authority must match the restored marker"
            );
            assert_eq!(
                fs::read(&config).unwrap(),
                br#"{"gateway":{"bind":"loopback"}}"#
            );
            assert!(old_runtime_restored.load(std::sync::atomic::Ordering::SeqCst));
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn mobile_lan_partial_restore_never_publishes_a_boolean_lie() {
        for fail_config in [true, false] {
            let root = std::env::temp_dir().join(format!(
                "uniopc-mobile-lan-partial-rollback-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&root).unwrap();
            let marker = root.join("enabled");
            let config = root.join("openclaw.json");
            fs::write(&config, br#"{"gateway":{"bind":"loopback"}}"#).unwrap();
            let rollback = commit_mobile_lan_files(
                &marker,
                &config,
                true,
                || fs::write(&config, br#"{"gateway":{"bind":"lan"}}"#).map_err(|e| e.to_string()),
                || async { Ok(()) },
            )
            .await
            .unwrap();

            let marker_attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let config_attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let marker_count = marker_attempts.clone();
            let config_count = config_attempts.clone();
            let outcome = rollback.restore_with(
                &marker,
                &config,
                move |path, bytes| {
                    marker_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if fail_config {
                        restore_file(path, bytes)
                    } else {
                        Err("marker restore fault".to_string())
                    }
                },
                move |path, bytes| {
                    config_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if fail_config {
                        Err("config restore fault".to_string())
                    } else {
                        restore_file(path, bytes)
                    }
                },
            );

            let restart_attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let restart_count = restart_attempts.clone();
            let restart_marker = marker.clone();
            let restart_config = config.clone();
            let marker_for_authority = marker.clone();
            let config_for_authority = config.clone();
            let error = complete_mobile_lan_restart(
                || async { Err("readiness failed".to_string()) },
                || async {
                    finish_mobile_lan_recovery(
                        || async {
                            (
                                outcome,
                                Ok(()),
                                mobile_lan_authority_from_paths(
                                    &marker_for_authority,
                                    &config_for_authority,
                                ),
                            )
                        },
                        || async move {
                            restart_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            let mut value: Value = json5::from_str(
                                &fs::read_to_string(&restart_config)
                                    .map_err(|error| error.to_string())?,
                            )
                            .map_err(|error| error.to_string())?;
                            apply_local_profile_gateway_config(
                                &mut value,
                                18_790,
                                restart_marker.exists(),
                            );
                            fs::write(
                                &restart_config,
                                serde_json::to_vec(&value).map_err(|error| error.to_string())?,
                            )
                            .map_err(|error| error.to_string())?;
                            Ok(())
                        },
                    )
                    .await
                },
                || mobile_lan_authority_from_paths(&marker, &config),
            )
            .await
            .unwrap_err();

            assert!(error.recovery_required);
            assert_eq!(error.authoritative_enabled, None);
            assert_eq!(marker_attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert_eq!(config_attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert_eq!(
                restart_attempts.load(std::sync::atomic::Ordering::SeqCst),
                0,
                "ordinary restart must not re-read a partially restored marker"
            );
            if !fail_config {
                let restored: Value =
                    json5::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
                assert_eq!(
                    restored.pointer("/gateway/bind"),
                    Some(&Value::String("loopback".to_string())),
                    "marker failure must not let ordinary startup overwrite restored bind"
                );
            }
            assert!(mobile_lan_authority_from_paths(&marker, &config).is_err());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn mobile_lan_missing_config_keeps_the_default_disabled_authority() {
        let root = std::env::temp_dir().join(format!(
            "uniopc-mobile-lan-missing-config-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        assert_eq!(
            mobile_lan_authority_from_paths(&root.join("enabled"), &root.join("openclaw.json")),
            Ok(false)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn mobile_lan_failed_stop_reports_unknown_runtime_instead_of_stopped() {
        let outcome = MobileLanRestoreOutcome {
            marker: Ok(()),
            config: Ok(()),
        };
        let restart_attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let restart_count = restart_attempts.clone();
        let error = complete_mobile_lan_restart(
            || async { Err("readiness failed".to_string()) },
            || async {
                finish_mobile_lan_recovery(
                    || async { (outcome, Err("stop fault".to_string()), Ok(false)) },
                    || async move {
                        restart_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        Ok(())
                    },
                )
                .await
            },
            || Ok(false),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("运行状态无法确认"));
        assert!(!error.message.contains("保持 stopped"));
        assert!(error.recovery_required);
        assert_eq!(error.authoritative_enabled, Some(false));
        assert_eq!(
            restart_attempts.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
    }

    #[cfg(unix)]
    async fn held_startup_fixture() -> GatewayChild {
        let process = tokio::process::Command::new("/bin/sh")
            .args(["-c", "exec sleep 30"])
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        GatewayChild {
            process,
            profile: Some("fixture".into()),
            runtime_id: "runtime".into(),
            spawned_at: Instant::now(),
            identity: 42,
            generation: 1,
            progress: std::sync::Arc::new(std::sync::Mutex::new(
                crate::services::gateway_startup_progress::Progress::new(Instant::now(), 1234),
            )),
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn reused_child_binds_sequential_successes_and_retry_without_resetting_progress_or_allowance(
    ) {
        let supervisor = GatewaySupervisor::default();
        let child = held_startup_fixture().await;
        let progress = child.progress.clone();
        progress.lock().unwrap().responded = true;
        {
            let mut a = supervisor.startup_allowance.lock().unwrap();
            a.enter_episode(Some("fixture"), "runtime");
            assert!(a.consume());
        }
        *supervisor.child.lock().await = Some(child);
        for generation in [1, 2, 3, 4] {
            assert!(supervisor
                .bind_startup_flight("fixture", "runtime", generation, || Ok(()))
                .await
                .unwrap());
            // Flight 3 fails; flight 4 must still bind and fully finalize.
            if generation != 3 {
                supervisor
                    .startup_finalized("fixture", generation, || Ok(()))
                    .await
                    .unwrap();
            }
            let observed = supervisor
                .startup_http_observer("fixture", generation)
                .await
                .unwrap();
            assert!(std::sync::Arc::ptr_eq(&observed, &progress));
            assert!(observed.lock().unwrap().responded);
            assert!(!supervisor.startup_allowance.lock().unwrap().consume());
        }
        supervisor.stop().await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_finalize_waiting_for_child_lock_neither_anchors_nor_resets_allowance() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        for already_anchored in [false, true] {
            let supervisor = Arc::new(GatewaySupervisor::default());
            *supervisor.child.lock().await = Some(held_startup_fixture().await);
            {
                let mut a = supervisor.startup_allowance.lock().unwrap();
                a.enter_episode(Some("fixture"), "runtime");
                assert!(a.consume());
                if already_anchored {
                    a.finalized(42, Instant::now() - Duration::from_secs(20));
                }
            }
            let held = supervisor.child.lock().await;
            let cancelled = Arc::new(AtomicBool::new(false));
            let entered = Arc::new(tokio::sync::Notify::new());
            let task = {
                let supervisor = supervisor.clone();
                let cancelled = cancelled.clone();
                let entered = entered.clone();
                tokio::spawn(async move {
                    supervisor
                        .startup_finalized("fixture", 1, || {
                            entered.notify_one();
                            if cancelled.load(Ordering::SeqCst) {
                                Err("cancelled".into())
                            } else {
                                Ok(())
                            }
                        })
                        .await
                })
            };
            entered.notified().await;
            cancelled.store(true, Ordering::SeqCst);
            drop(held);
            assert_eq!(task.await.unwrap().unwrap_err(), "cancelled");
            {
                let mut a = supervisor.startup_allowance.lock().unwrap();
                assert!(!a.consume());
                if !already_anchored {
                    a.finalized(42, Instant::now() + Duration::from_secs(16));
                    assert!(
                        !a.consume(),
                        "cancelled finalization must not establish an anchor"
                    );
                }
            }
            supervisor.stop().await;
        }
    }
    #[tokio::test]
    async fn uncertain_gateway_recovery_stays_closed_across_stops_and_repeated_flights() {
        let supervisor = GatewaySupervisor::default();
        supervisor
            .recovery_blocked
            .store(true, std::sync::atomic::Ordering::SeqCst);
        for _ in 0..2 {
            assert_eq!(
                supervisor.ensure_running().await.unwrap_err(),
                "gateway_startup_termination_unconfirmed"
            );
            supervisor.stop().await;
        }
        assert_eq!(supervisor.spawn_count(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn frozen_gateway_respawn_reuses_launch_environment_without_preparation() {
        let dir = std::env::temp_dir().join(format!("uniopc-frozen-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("launches");
        let variable = format!("UNIOPC_FROZEN_{}", uuid::Uuid::new_v4().simple());
        std::env::set_var(&variable, "before");
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "printenv \"$2\" | tr -d '\\n' >> \"$1\"", "fixture"]);
        command.arg(&marker).arg(&variable);
        let launch = FrozenGatewayLaunch::capture(command, None, 1234).unwrap();
        std::env::set_var(&variable, "after");
        for identity in [1, 2] {
            let mut child = launch
                .spawn(
                    Some("fixture".into()),
                    "fixture-runtime".into(),
                    0,
                    identity,
                )
                .await
                .unwrap();
            assert!(child.process.wait().await.unwrap().success());
        }
        std::env::remove_var(&variable);
        assert_eq!(fs::read_to_string(&marker).unwrap(), "beforebefore");
        fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn gateway_stop_waits_for_term_cleanup_before_reaping() {
        use tokio::io::AsyncBufReadExt;
        let dir = std::env::temp_dir().join(format!("uniopc-stop-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("clean-stop");
        let mut process = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("trap 'sleep 0.1; printf clean > \"$1\"; exit 0' TERM; printf 'ready\\n'; while :; do sleep 0.02; done")
            .arg("fixture")
            .arg(&marker)
            .process_group(0)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn().unwrap();
        let mut stdout = tokio::io::BufReader::new(process.stdout.take().unwrap());
        let mut ready = String::new();
        tokio::time::timeout(Duration::from_secs(3), stdout.read_line(&mut ready))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready.trim(), "ready");
        let supervisor = GatewaySupervisor::default();
        assert!(supervisor.startup_allowance.lock().unwrap().consume());
        *supervisor.child.lock().await = Some(GatewayChild {
            process,
            profile: Some("fixture".into()),
            runtime_id: "fixture-runtime".into(),
            spawned_at: Instant::now(), identity: 1, generation: 0,
            progress: std::sync::Arc::new(std::sync::Mutex::new(crate::services::gateway_startup_progress::Progress::new(Instant::now(), 1234))),
        });
        supervisor.stop().await;
        assert!(!supervisor.startup_allowance.lock().unwrap().consume(), "ordinary stop must not reset the recovery allowance");
        let cleaned = fs::read_to_string(&marker);
        fs::remove_dir_all(dir).unwrap();
        assert_eq!(
            cleaned.unwrap(),
            "clean",
            "TERM cleanup must finish before stop returns"
        );
        assert!(!supervisor.is_running().await);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gateway_stop_timeout_kills_stubborn_owned_process_group() {
        use std::os::unix::process::ExitStatusExt;
        use tokio::io::AsyncBufReadExt;
        let mut process = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("trap '' TERM; sleep 30 & printf '%s\\n' \"$!\"; wait")
            .process_group(0)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let group = process.id().unwrap();
        let mut stdout = tokio::io::BufReader::new(process.stdout.take().unwrap());
        let mut descendant = String::new();
        tokio::time::timeout(Duration::from_secs(3), stdout.read_line(&mut descendant))
            .await
            .unwrap()
            .unwrap();
        let descendant: u32 = descendant.trim().parse().unwrap();
        let started = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            stop_owned_unix_gateway_process(&mut process, Duration::from_millis(80)),
        )
        .await;
        if result.is_err() {
            let _ = std::process::Command::new("kill")
                .arg("-KILL")
                .arg(format!("-{group}"))
                .output();
            let _ = process.wait().await;
        }
        let status = result.expect("forced stop must remain bounded").unwrap();
        assert_eq!(status.signal(), Some(9));
        assert!(started.elapsed() >= Duration::from_millis(80));
        let mut descendant_alive = true;
        for _ in 0..100 {
            let output = std::process::Command::new("ps")
                .args(["-p", &descendant.to_string(), "-o", "stat="])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            descendant_alive = output.status.success()
                && !state.trim().is_empty()
                && !state.trim().starts_with('Z');
            if !descendant_alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // Clean up the fixture even if a regression killed only the leader.
        if descendant_alive {
            let _ = std::process::Command::new("kill")
                .arg("-KILL")
                .arg(format!("-{group}"))
                .output();
        }
        assert!(
            !descendant_alive,
            "forced stop must terminate the owned descendant too"
        );
        assert!(process.try_wait().unwrap().is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gateway_stop_cleans_descendants_after_leader_finishes_gracefully() {
        use tokio::io::AsyncBufReadExt;
        let dir = std::env::temp_dir().join(format!("uniopc-stop-tree-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("clean-stop");
        let mut process = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("trap 'printf clean > \"$1\"; exit 0' TERM; sh -c 'trap \"\" TERM; printf \"childready\\n\"; exec sleep 30' & printf 'pid:%s\\n' \"$!\"; wait")
            .arg("fixture").arg(&marker)
            .process_group(0).kill_on_drop(true)
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null())
            .spawn().unwrap();
        let group = process.id().unwrap();
        let mut stdout = tokio::io::BufReader::new(process.stdout.take().unwrap());
        let mut descendant = None;
        let mut child_ready = false;
        for _ in 0..2 {
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(3), stdout.read_line(&mut line))
                .await
                .unwrap()
                .unwrap();
            if let Some(pid) = line.trim().strip_prefix("pid:") {
                descendant = Some(pid.parse::<u32>().unwrap());
            }
            if line.trim() == "childready" {
                child_ready = true;
            }
        }
        assert!(child_ready);
        let descendant = descendant.unwrap();
        let status = stop_owned_unix_gateway_process(&mut process, Duration::from_secs(1))
            .await
            .unwrap();
        let cleaned = fs::read_to_string(&marker);
        let mut alive = true;
        for _ in 0..30 {
            let output = std::process::Command::new("ps")
                .args(["-p", &descendant.to_string(), "-o", "stat="])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            alive = output.status.success()
                && !state.trim().is_empty()
                && !state.trim().starts_with('Z');
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        if alive {
            let _ = std::process::Command::new("kill")
                .arg("-KILL")
                .arg(format!("-{group}"))
                .output();
        }
        fs::remove_dir_all(dir).unwrap();
        assert!(
            status.success(),
            "leader must finish its TERM handler normally"
        );
        assert_eq!(cleaned.unwrap(), "clean");
        assert!(
            !alive,
            "clean leader exit must not orphan a TERM-ignoring descendant"
        );
    }

    #[tokio::test]
    async fn gateway_readiness_wait_keeps_probing_until_gateway_is_usable() {
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let probe_attempts = attempts.clone();

        let mut probe = move || {
            let probe_attempts = probe_attempts.clone();
            Box::pin(async move {
                probe_attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= 2
            }) as std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        };
        let ready = wait_for_gateway_ready_with_probe(4, Duration::ZERO, &mut probe).await;

        assert!(ready);
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn gateway_restart_wait_rejects_the_old_ready_instance() {
        let states =
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from([
                true, true, false, false, true,
            ])));
        let probe_states = states.clone();
        let mut probe = move || {
            let probe_states = probe_states.clone();
            Box::pin(async move {
                probe_states
                    .lock()
                    .expect("probe states")
                    .pop_front()
                    .unwrap_or(false)
            }) as std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        };

        let ready = wait_for_gateway_restart_cycle_with_probe(5, Duration::ZERO, &mut probe).await;

        assert!(ready);
        assert!(states.lock().expect("remaining states").is_empty());
    }

    #[test]
    fn respawn_backoff_ramps_within_threshold() {
        assert_eq!(gateway_respawn_backoff(1), Duration::from_millis(500));
        assert_eq!(gateway_respawn_backoff(2), Duration::from_millis(1_000));
        assert_eq!(gateway_respawn_backoff(4), Duration::from_millis(4_000));
        // Clamped at the top of the ladder.
        assert_eq!(gateway_respawn_backoff(9), Duration::from_millis(4_000));
    }

    #[test]
    fn respawn_decision_spawns_throttles_and_opens_circuit() {
        // No prior failures → always spawn.
        assert_eq!(gateway_respawn_decision(0, None), RespawnDecision::Spawn);
        assert_eq!(
            gateway_respawn_decision(0, Some(Duration::from_millis(1))),
            RespawnDecision::Spawn
        );
        // First fast death: throttle inside the 500ms window, spawn past it.
        assert_eq!(
            gateway_respawn_decision(1, Some(Duration::from_millis(100))),
            RespawnDecision::Throttled
        );
        assert_eq!(
            gateway_respawn_decision(1, Some(Duration::from_millis(600))),
            RespawnDecision::Spawn
        );
        // At/над the threshold: circuit open within cooldown, half-open (spawn) after.
        assert_eq!(
            gateway_respawn_decision(
                GATEWAY_RESPAWN_CIRCUIT_THRESHOLD,
                Some(Duration::from_secs(10))
            ),
            RespawnDecision::CircuitOpen
        );
        assert_eq!(
            gateway_respawn_decision(
                GATEWAY_RESPAWN_CIRCUIT_THRESHOLD,
                Some(Duration::from_secs(61))
            ),
            RespawnDecision::Spawn
        );
        // Missing timestamp never traps the gate.
        assert_eq!(
            gateway_respawn_decision(GATEWAY_RESPAWN_CIRCUIT_THRESHOLD, None),
            RespawnDecision::Spawn
        );
    }

    #[test]
    fn respawn_count_increments_on_fast_death_and_resets_on_healthy_run() {
        // Died before the stable window → fast death, count climbs.
        assert_eq!(
            gateway_respawn_count_after_exit(Duration::from_secs(2), 3),
            4
        );
        assert_eq!(
            gateway_respawn_count_after_exit(Duration::from_millis(50), 0),
            1
        );
        // Lived past the stable window then exited → legit run, count resets.
        assert_eq!(
            gateway_respawn_count_after_exit(Duration::from_secs(30), 4),
            0
        );
    }

    #[test]
    fn normal_gateway_start_has_no_acpx_network_preflight() {
        let source = include_str!("mod.rs");
        let start = source
            .find("pub async fn ensure_running_for")
            .expect("GatewaySupervisor::ensure_running_for");
        let end = source[start..]
            .find("/// True when we hold a child")
            .map(|offset| start + offset)
            .expect("end of GatewaySupervisor::ensure_running_for");
        let ensure_running_for = &source[start..end];

        assert!(ensure_running_for.contains("self.ensure_running().await"));
        assert!(!ensure_running_for.contains("ensure_acpx_installed_for_profile"));
        assert!(!ensure_running_for.contains("plugins install @openclaw/acpx"));
    }

    #[test]
    fn windows_gateway_stop_terminates_the_full_process_tree() {
        let source = include_str!("mod.rs");
        let stop_start = source
            .find("pub async fn stop(&self)")
            .expect("GatewaySupervisor::stop");
        let stop_end = source[stop_start..]
            .find("pub async fn restart(&self)")
            .map(|offset| stop_start + offset)
            .expect("GatewaySupervisor::restart");
        let stop = &source[stop_start..stop_end];

        assert!(stop.contains("#[cfg(windows)]"));
        assert!(stop.contains("terminate_job(&child.job, &mut child.process)"));
        assert!(!stop.contains("taskkill"));
    }

    // Loud-failure guard for the image-generation SSRF fix: the gateway child
    // MUST carry OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER=1 or the runtime's image
    // provider rejects our 127.0.0.1 loopback proxy with "Blocked hostname or
    // private/internal/special-use IP address" and image generation dies. If a
    // refactor drops the injection, fail here — not silently at a user's first
    // image request. (An upstream runtime rename of the flag is caught separately
    // at the version-pin recheck; this pins OUR half of the contract.)
    #[test]
    fn gateway_child_allows_loopback_image_provider() {
        let env = gateway_image_provider_env();
        assert!(env
            .iter()
            .any(|(key, value)| *key == "OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER" && *value == "1"));
    }

    #[test]
    fn only_gateway_child_receives_local_document_bridge_credentials() {
        crate::services::local_documents_bridge::configure_test_endpoint(32100);

        let env = gateway_local_documents_env();

        assert!(env.iter().any(|(key, value)| {
            key == "UNIOPC_LOCAL_DOCUMENTS_URL"
                && value == "http://127.0.0.1:32100/v1/documents/operation"
        }));
        assert!(env
            .iter()
            .any(|(key, value)| key == "UNIOPC_LOCAL_DOCUMENTS_TOKEN" && !value.is_empty()));
    }

    #[test]
    fn gateway_child_receives_the_active_openclaw_profile_for_local_documents() {
        assert_eq!(
            gateway_profile_context_env(Some("sales-owner-46f19d68b66f")),
            vec![(
                "UNIOPC_OPENCLAW_PROFILE".to_string(),
                "sales-owner-46f19d68b66f".to_string(),
            )]
        );
    }

    #[test]
    fn unix_install_command_uses_rootless_cli_installer() {
        if cfg!(target_os = "windows") {
            return;
        }

        let command = openclaw_install_command();

        assert!(command.contains("https://openclaw.bot/install-cli.sh"));
        assert!(command.contains("--json"));
        assert!(command.contains("--no-onboard"));
        assert!(command.contains("--prefix"));
        let runtime_path = if cfg!(target_os = "macos") {
            "Uniopc/runtime/v"
        } else {
            "uniopc/runtime/v"
        };
        assert!(command.contains(runtime_path));
        assert!(command.contains("--version"));
        assert!(!command.contains("install.sh | bash"));
    }

    #[test]
    fn official_provider_verify_detects_present_and_missing() {
        // Provider block landed → configured.
        let present = serde_json::json!({
            "parsed": { "models": { "providers": {
                "uniopc-official": { "baseUrl": "https://relay.example/v1", "apiKey": {} }
            } } }
        });
        assert!(snapshot_has_official_provider_configured(&present));

        // Token file written but the config.patch was dropped → only the openai
        // fallback (or nothing) is present, no uniopc-official provider. This is
        // the half-write we must catch and retry, not report as success.
        let missing = serde_json::json!({
            "parsed": { "models": { "providers": {
                "openai": { "baseUrl": "https://relay.example/v1" }
            } } }
        });
        assert!(!snapshot_has_official_provider_configured(&missing));

        // Present but blank baseUrl → not usable, treat as not configured.
        let blank = serde_json::json!({
            "parsed": { "models": { "providers": {
                "uniopc-official": { "baseUrl": "" }
            } } }
        });
        assert!(!snapshot_has_official_provider_configured(&blank));
    }

    #[test]
    fn official_model_proxy_endpoint_change_requires_gateway_restart() {
        let stale = serde_json::json!({
            "parsed": { "models": { "providers": {
                "uniopc-official": {
                    "baseUrl": "http://127.0.0.1:60664/v1",
                    "apiKey": "stable-local-secret"
                }
            } } }
        });
        let current = serde_json::json!({
            "parsed": { "models": { "providers": {
                "uniopc-official": {
                    "baseUrl": "http://127.0.0.1:56312/v1",
                    "apiKey": "stable-local-secret"
                }
            } } }
        });

        assert_eq!(
            official_model_gateway_settle_action(
                &stale,
                "http://127.0.0.1:56312/v1",
                "stable-local-secret",
            ),
            OfficialModelGatewaySettleAction::AwaitRestart,
        );
        assert_eq!(
            official_model_gateway_settle_action(
                &current,
                "http://127.0.0.1:56312/v1",
                "stable-local-secret",
            ),
            OfficialModelGatewaySettleAction::KeepRunning,
        );

        let redacted = serde_json::json!({
            "parsed": { "models": { "providers": {
                "uniopc-official": {
                    "baseUrl": "http://127.0.0.1:56312/v1",
                    "apiKey": "********"
                }
            } } }
        });
        assert_eq!(
            official_model_gateway_settle_action(
                &redacted,
                "http://127.0.0.1:56312/v1",
                "stable-local-secret",
            ),
            OfficialModelGatewaySettleAction::KeepRunning,
        );
    }

    #[test]
    fn unix_install_command_uses_imai_declared_openclaw_version_when_available() {
        if cfg!(target_os = "windows") {
            return;
        }

        let declared = option_env!("IMAI_OPENCLAW_VERSION")
            .expect("Uniopc release should declare a compatible Uniopc 引擎 version");
        let command = openclaw_install_command();

        assert!(command.contains(&format!("--version '{}'", declared)));
        assert!(!command.contains("--version 'latest'"));
    }

    #[test]
    fn unix_update_command_reinstalls_imai_declared_openclaw_version() {
        if cfg!(target_os = "windows") {
            return;
        }

        let declared = option_env!("IMAI_OPENCLAW_VERSION")
            .expect("Uniopc release should declare a compatible Uniopc 引擎 version");
        let command = openclaw_update_command();

        assert!(command.contains("https://openclaw.bot/install-cli.sh"));
        assert!(command.contains("--json"));
        assert!(command.contains("--no-onboard"));
        assert!(command.contains("--prefix"));
        let runtime_path = if cfg!(target_os = "macos") {
            "Uniopc/runtime/v"
        } else {
            "uniopc/runtime/v"
        };
        assert!(command.contains(runtime_path));
        assert!(command.contains(&format!("--version '{}'", declared)));
        assert!(!command.contains("openclaw update"));
        assert!(!command.contains("--version 'latest'"));
    }

    #[test]
    fn common_binary_candidates_include_openclaw_local_prefix() {
        let candidates = common_binary_candidates("openclaw");
        let executable = if cfg!(target_os = "windows") {
            "openclaw.exe"
        } else {
            "openclaw"
        };
        assert!(candidates.contains(&openclaw_local_bin_dir().join(executable)));
    }

    #[test]
    fn augmented_path_includes_openclaw_local_prefix_before_existing_path() {
        let path = openclaw_augmented_path(Some("/usr/bin"));
        let parts = std::env::split_paths(&path).collect::<Vec<_>>();
        let managed_node_bin = openclaw_local_bin_dir()
            .parent()
            .expect("openclaw prefix")
            .join("tools")
            .join("node")
            .join("bin");

        assert_eq!(parts.first(), Some(&openclaw_local_bin_dir()));
        assert_eq!(parts.get(1), Some(&managed_node_bin));
        assert_eq!(parts.last(), Some(&PathBuf::from("/usr/bin")));
    }

    #[test]
    fn openclaw_version_support_gate_accepts_only_the_exact_8_1_engine_version() {
        let declared = option_env!("IMAI_OPENCLAW_VERSION")
            .expect("Uniopc release should declare the exact Uniopc 引擎 version");

        assert_eq!(declared, "2026.8.1");
        assert!(openclaw_version_is_supported(Some(&format!(
            "openclaw {declared} (abc123)"
        ))));
        assert!(openclaw_version_is_supported(Some("2026.8.1")));
        assert!(!openclaw_version_is_supported(Some("2026.7.1-2")));
        assert!(!openclaw_version_is_supported(Some("2026.9.1")));
        assert!(!openclaw_version_is_supported(Some("2026.9.2")));
    }

    #[test]
    fn openclaw_version_support_gate_rejects_versions_older_than_imai_declared_version() {
        assert!(!openclaw_version_is_supported(Some(
            "openclaw 2026.4.1 (abc123)"
        )));
        assert!(!openclaw_version_is_supported(Some("2026.6.1")));
        assert!(!openclaw_version_is_supported(Some("openclaw 2026.3.31")));
    }

    #[test]
    fn openclaw_version_support_gate_rejects_different_major_versions() {
        assert!(!openclaw_version_is_supported(Some("openclaw 2027.1.1")));
    }

    #[test]
    fn openclaw_version_support_gate_rejects_unparseable_versions() {
        assert!(!openclaw_version_is_supported(None));
        assert!(!openclaw_version_is_supported(Some("dev")));
    }

    #[test]
    fn ansi_escape_sequences_are_removed_from_install_output() {
        let raw = "\u{1b}[38;2;255;77;77m\u{1b}[1mOpenClaw\u{1b}[0m failed";
        assert_eq!(strip_ansi_sequences(raw), "OpenClaw failed");
    }

    #[test]
    fn install_failure_detail_recognizes_sudo_tty_failure() {
        let tail = "Running in non-interactive mode because `stdin` is not a TTY\nNeed sudo access on macOS";

        assert_eq!(
            openclaw_install_failure_detail(tail),
            "当前安装器需要 sudo/管理员交互，但 Uniopc 内部安装进程没有可交互终端。请在系统终端中安装依赖，或改用免 root 的 Uniopc 引擎 CLI 安装流程。"
        );
    }

    #[test]
    fn command_event_output_is_cleaned_before_progress_display() {
        let raw = b"\x1b[38;2;255;77;77mInstalling OpenClaw\x1b[0m\n";

        assert_eq!(
            command_event_output_text(raw),
            Some("Installing Uniopc".to_string())
        );
    }

    #[test]
    fn streaming_output_log_keeps_recent_lines_only() {
        let mut log = String::new();

        append_streaming_output(&mut log, "one", 2);
        append_streaming_output(&mut log, "two", 2);
        append_streaming_output(&mut log, "three", 2);

        assert_eq!(log, "two\nthree");
    }

    #[test]
    fn macos_system_proxy_output_is_converted_to_cli_proxy_env() {
        let output = r#"<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}"#;

        let envs = cli_proxy_env_from_macos_scutil_output(output);

        assert!(envs.contains(&(
            "HTTP_PROXY".to_string(),
            "http://127.0.0.1:7890".to_string()
        )));
        assert!(envs.contains(&(
            "HTTPS_PROXY".to_string(),
            "http://127.0.0.1:7890".to_string()
        )));
        assert!(!envs.iter().any(|(key, _)| key == "ALL_PROXY"));
        assert_eq!(
            cloud_agent_proxy_url_from_cli_proxy_env(&envs).as_deref(),
            Some("http://127.0.0.1:7890")
        );
    }

    #[test]
    fn macos_socks_only_system_proxy_is_converted_to_cli_proxy_env() {
        let output = r#"<dictionary> {
  HTTPEnable : 0
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}"#;

        let envs = cli_proxy_env_from_macos_scutil_output(output);

        assert_eq!(
            envs,
            vec![(
                "ALL_PROXY".to_string(),
                "socks5://127.0.0.1:7890".to_string()
            )]
        );
        assert_eq!(
            cloud_agent_proxy_url_from_cli_proxy_env(&envs).as_deref(),
            Some("socks5h://127.0.0.1:7890")
        );
    }

    #[test]
    fn macos_system_proxy_prefers_http_for_cli_oauth_when_socks_is_also_enabled() {
        let output = r#"<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}"#;

        let envs = cli_proxy_env_from_macos_scutil_output(output);

        assert!(envs.contains(&(
            "HTTPS_PROXY".to_string(),
            "http://127.0.0.1:7890".to_string()
        )));
        assert!(!envs.iter().any(|(key, _)| key == "ALL_PROXY"));
        assert_eq!(
            cloud_agent_proxy_url_from_cli_proxy_env(&envs).as_deref(),
            Some("http://127.0.0.1:7890")
        );
    }

    #[test]
    fn proxy_shell_exports_include_upper_and_lowercase_names() {
        let exports = shell_export_proxy_env(&[
            (
                "HTTP_PROXY".to_string(),
                "http://127.0.0.1:7890".to_string(),
            ),
            (
                "ALL_PROXY".to_string(),
                "socks5://127.0.0.1:7890".to_string(),
            ),
        ]);

        assert!(exports.contains("export HTTP_PROXY='http://127.0.0.1:7890';"));
        assert!(exports.contains("export http_proxy='http://127.0.0.1:7890';"));
        assert!(exports.contains("export ALL_PROXY='socks5://127.0.0.1:7890';"));
        assert!(exports.contains("export all_proxy='socks5://127.0.0.1:7890';"));
    }

    #[test]
    fn codex_login_terminal_command_does_not_use_zsh_readonly_status_variable() {
        let command = openclaw_codex_login_terminal_command(Some("imai"), "openai-codex/gpt-5.5");

        assert!(!command.contains("status=$?"));
        assert!(!command.contains("openclaw_exit_code=$?"));
    }

    #[test]
    fn codex_login_terminal_command_exports_openclaw_path() {
        let command = openclaw_codex_login_terminal_command(Some("imai"), "openai-codex/gpt-5.5");

        assert!(command.contains("export PATH="));
        assert!(command.contains(openclaw_local_bin_dir().to_string_lossy().as_ref()));
    }

    #[test]
    fn codex_login_terminal_command_uses_official_codex_cli() {
        let command = openclaw_codex_login_terminal_command(Some("imai"), "openai-codex/gpt-5.5");

        assert!(command.contains("codex"));
        assert!(command.contains(" login"));
        assert!(!command.contains("models auth login"));
        assert!(!command.contains("--method oauth"));
    }

    #[test]
    fn codex_login_terminal_command_does_not_pass_openclaw_profile_to_codex_cli() {
        let command = openclaw_codex_login_terminal_command(
            Some("bootiful-wtf-4a58b3ae"),
            "openai-codex/gpt-5.5",
        );

        assert!(command.contains("codex"));
        assert!(command.contains(" login"));
        assert!(!command.contains("--profile 'bootiful-wtf-4a58b3ae'"));
        assert!(!command.contains("--profile 'imai'"));
    }

    #[test]
    fn codex_login_terminal_command_leaves_default_model_to_gateway_config_patch() {
        let command = openclaw_codex_login_terminal_command(Some("imai"), "openai-codex/gpt-5.5");

        assert!(!command.contains("config set agents.defaults.model.primary"));
        assert!(!command.contains("--set-default"));
        assert!(!command.contains("models set"));
    }

    #[test]
    fn gateway_patch_restart_errors_are_recoverable() {
        assert!(openclaw_gateway_patch_error_may_be_restarting(
            "Gateway config.patch 请求失败: Gateway 在返回响应前关闭连接。"
        ));
        assert!(openclaw_gateway_patch_error_may_be_restarting(
            "连接 Uniopc 引擎 超时: ws://127.0.0.1:18790"
        ));
        assert!(openclaw_gateway_patch_error_may_be_restarting(
            "gateway starting; retry shortly"
        ));
        assert!(!openclaw_gateway_patch_error_may_be_restarting(
            "Uniopc 引擎 config.get 缺少 hash，无法安全 patch 配置。"
        ));
    }

    #[test]
    fn env_var_effective_check_accepts_gateway_and_raw_config_shapes() {
        let gateway_config = serde_json::json!({
            "parsed": {
                "env": {
                    "DEEPSEEK_API_KEY": "sk-test"
                }
            }
        });
        assert!(openclaw_env_var_is_effective(
            &gateway_config,
            "DEEPSEEK_API_KEY",
            "sk-test"
        ));

        let raw_config = serde_json::json!({
            "env": {
                "DEEPSEEK_API_KEY": "sk-test"
            }
        });
        assert!(openclaw_env_var_is_effective(
            &raw_config,
            "DEEPSEEK_API_KEY",
            "sk-test"
        ));
        assert!(!openclaw_env_var_is_effective(
            &raw_config,
            "DEEPSEEK_API_KEY",
            "sk-other"
        ));
    }

    #[test]
    fn provider_onboard_args_do_not_include_api_key_secret() {
        let spec = provider_api_key_spec("deepseek").expect("deepseek spec");
        let args = openclaw_provider_onboard_args(&spec);

        assert!(args.contains(&"--auth-choice".to_string()));
        assert!(args.contains(&"deepseek-api-key".to_string()));
        assert!(!args.iter().any(|arg| arg.contains("sk-")));
        assert!(!args.contains(&"--deepseek-api-key".to_string()));
    }

    #[test]
    fn provider_auth_failure_state_sql_targets_profile_without_secret() {
        let path = openclaw_auth_usage_stats_json_path("deepseek:default");
        assert_eq!(path, "$.usageStats.\"deepseek:default\"");

        let inline_path = openclaw_auth_usage_stats_json_path("inline-api-key:uniopc-official");
        assert_eq!(
            inline_path,
            "$.usageStats.\"inline-api-key:uniopc-official\""
        );

        let literal = sqlite_string_literal(&path);
        assert_eq!(literal, "'$.usageStats.\"deepseek:default\"'");
        assert!(!literal.contains("sk-"));

        let escaped = sqlite_string_literal("owner's profile");
        assert_eq!(escaped, "'owner''s profile'");
    }

    #[test]
    fn codex_login_terminal_command_uses_neutral_verification_message() {
        let command = openclaw_codex_login_terminal_command(Some("imai"), "openai-codex/gpt-5.5");

        assert!(!command.contains("success"));
        assert!(!command.contains("Uniopc is checking Uniopc 引擎 auth status."));
        assert!(!command.contains("Uniopc 引擎 auth command finished."));
    }

    #[test]
    fn codex_login_failure_detail_recognizes_unsupported_region() {
        let output = r#"OpenAI device code request failed: HTTP 403 {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}"#;
        let detail = openclaw_codex_login_failure_detail(output);

        assert!(detail.contains("网络出口"));
        assert!(detail.contains("浏览器授权成功"));
        assert!(detail.contains("全局/TUN"));
    }

    #[test]
    fn codex_unsupported_region_failure_hides_raw_terminal_output() {
        let output = r#"OpenAI device code request failed: HTTP 403 {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}"#;

        assert!(should_hide_codex_login_output(output));
    }

    #[test]
    fn ipinfo_country_is_parsed_from_probe_output() {
        let output = r#"{"ip":"183.250.115.138","country":"CN","city":"Shanghai"}"#;

        assert_eq!(ipinfo_country_from_output(output), Some("CN".to_string()));
    }

    #[test]
    fn codex_network_preflight_rejects_mainland_china_exit() {
        assert_eq!(
            openai_codex_network_preflight_failure(Some("CN")),
            Some("当前网络出口仍在中国大陆，暂不能完成 OpenAI Codex 订阅授权。请开启代理软件的全局/TUN 模式，或改用 OpenAI API Key / MiniMax。".to_string())
        );
    }

    #[test]
    fn codex_login_hidden_command_uses_pseudo_terminal_without_opening_terminal_app() {
        let (program, args) = openclaw_codex_login_hidden_command(Some("imai"), "openai/gpt-5.5");

        if cfg!(target_family = "unix") {
            assert_eq!(program, "script");
            assert!(args.iter().any(|arg| arg == "/dev/null"));
            let shell = if cfg!(target_os = "macos") {
                "/bin/zsh"
            } else {
                "/bin/sh"
            };
            assert!(args.iter().any(|arg| arg == shell));
        }

        let joined = args.join(" ");
        assert!(!joined.contains("osascript"));
        assert!(!joined.contains("Terminal"));
        assert!(joined.contains("codex"));
        assert!(joined.contains(" login"));
        assert!(!joined.contains("models auth login"));
    }

    #[test]
    fn gateway_model_status_recognizes_openai_codex_runtime_route() {
        let config = serde_json::json!({
            "parsed": {
                "models": {
                    "providers": {
                        "openai": {
                            "models": [
                                {
                                    "id": "gpt-5.4",
                                    "name": "GPT-5.4"
                                }
                            ]
                        }
                    }
                },
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai/gpt-5.5"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({
            "models": [
                {
                    "provider": "openai",
                    "id": "gpt-5.5",
                    "name": "GPT-5.5"
                }
            ]
        });
        let gateway_auth = serde_json::json!({
            "providers": [],
            "runtimeAuthRoutes": [
                {
                    "provider": "openai",
                    "runtime": "codex",
                    "authProvider": "openai",
                    "status": "ok"
                }
            ]
        });
        let agent_auth = serde_json::json!({
            "version": 1,
            "profiles": {
                "openai:user@example.com": {
                    "provider": "openai",
                    "type": "oauth",
                    "email": "user@example.com"
                }
            }
        });

        let status = openclaw_model_status_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &gateway_auth,
            Some(&agent_auth),
        );

        assert!(status.provider_ready);
        assert_eq!(status.provider_mode.as_deref(), Some("openai-codex"));
        assert_eq!(
            status.providers_with_oauth,
            vec!["openai:user@example.com".to_string()]
        );
        assert!(status.missing_providers_in_use.is_empty());
    }

    #[test]
    fn minimax_login_terminal_command_uses_cn_oauth_auth_choice() {
        let command = openclaw_minimax_login_terminal_command(
            Some("owner-profile"),
            "minimax-portal/MiniMax-M2.7",
        );

        assert!(command.contains("openclaw --profile 'owner-profile' onboard"));
        assert!(command.contains("--auth-choice minimax-cn-oauth"));
        assert!(command.contains("--skip-ui"));
        assert!(!command.contains("--non-interactive"));
    }

    #[test]
    fn minimax_login_terminal_command_does_not_write_default_model_with_cli() {
        let command = openclaw_minimax_login_terminal_command(
            Some("owner-profile"),
            "minimax-portal/MiniMax-M2.7",
        );

        assert!(!command.contains("openclaw --profile 'owner-profile' models status --json"));
        assert!(!command.contains("openclaw --profile 'owner-profile' models set"));
    }

    #[test]
    fn gateway_model_status_uses_gateway_config_models_and_auth_payloads() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai-codex/gpt-5.5"
                        }
                    }
                }
            },
            "resolved": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai-codex/gpt-5.5"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({
            "models": [
                {
                    "provider": "openai-codex",
                    "id": "gpt-5.5",
                    "name": "GPT-5.5"
                }
            ]
        });
        let auth = serde_json::json!({
            "providers": [
                {
                    "provider": "openai-codex",
                    "status": "ok",
                    "profiles": [
                        {
                            "profileId": "openai-codex:user@example.com",
                            "type": "oauth",
                            "status": "ok"
                        }
                    ]
                }
            ]
        });

        let status = openclaw_model_status_from_gateway_payloads(&config, &models, &auth);

        assert_eq!(
            status.default_model.as_deref(),
            Some("openai-codex/gpt-5.5")
        );
        assert_eq!(
            status.resolved_default_model.as_deref(),
            Some("openai-codex/gpt-5.5")
        );
        assert!(status.provider_ready);
        assert_eq!(status.provider_mode.as_deref(), Some("openai-codex"));
        assert_eq!(
            status.providers_with_oauth,
            vec!["openai-codex:user@example.com".to_string()]
        );
        assert_eq!(
            status.auth_profile_labels,
            vec!["openai-codex:user@example.com".to_string()]
        );
    }

    #[test]
    fn gateway_model_status_requires_current_agent_auth_for_oauth_provider() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai-codex/gpt-5.5"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({
            "models": [
                {
                    "provider": "openai-codex",
                    "id": "gpt-5.5",
                    "name": "GPT-5.5"
                }
            ]
        });
        let gateway_auth = serde_json::json!({
            "providers": [
                {
                    "provider": "openai-codex",
                    "status": "ok",
                    "profiles": [
                        {
                            "profileId": "openai-codex:default",
                            "type": "oauth",
                            "status": "ok"
                        }
                    ]
                }
            ]
        });
        let empty_agent_auth = serde_json::json!({
            "version": 1,
            "profiles": {}
        });

        let status = openclaw_model_status_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &gateway_auth,
            Some(&empty_agent_auth),
        );
        let snapshot = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &gateway_auth,
            Some(&empty_agent_auth),
        );

        assert!(!status.provider_ready);
        assert_eq!(
            status.missing_providers_in_use,
            vec!["openai-codex".to_string()]
        );
        assert!(status.providers_with_oauth.is_empty());
        assert!(status.auth_profile_labels.is_empty());
        assert!(snapshot
            .models
            .iter()
            .any(|model| model.model_ref == "openai-codex/gpt-5.5" && !model.provider_ready));
        assert!(snapshot
            .providers
            .iter()
            .any(|provider| provider.id == "openai-codex"
                && !provider.ready
                && provider.auth_profiles.is_empty()));
    }

    #[test]
    fn gateway_model_status_uses_current_agent_auth_profile_label() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai-codex/gpt-5.5"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({ "models": [] });
        let gateway_auth = serde_json::json!({
            "providers": [
                {
                    "provider": "openai-codex",
                    "status": "ok",
                    "profiles": [
                        {
                            "profileId": "openai-codex:default",
                            "type": "oauth",
                            "status": "ok"
                        }
                    ]
                }
            ]
        });
        let agent_auth = serde_json::json!({
            "version": 1,
            "profiles": {
                "openai-codex:user@example.com": {
                    "provider": "openai-codex",
                    "type": "oauth",
                    "email": "user@example.com"
                }
            }
        });

        let status = openclaw_model_status_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &gateway_auth,
            Some(&agent_auth),
        );

        assert!(status.provider_ready);
        assert_eq!(status.provider_mode.as_deref(), Some("openai-codex"));
        assert_eq!(
            status.providers_with_oauth,
            vec!["openai-codex:user@example.com".to_string()]
        );
        assert_eq!(
            status.auth_profile_labels,
            vec!["openai-codex:user@example.com".to_string()]
        );
    }

    #[test]
    fn auth_ready_helper_accepts_cli_auth_list_payload() {
        let auth = serde_json::json!({
            "agentId": "main",
            "provider": null,
            "profiles": [
                {
                    "id": "openai-codex:user@example.com",
                    "provider": "openai-codex",
                    "type": "oauth",
                    "label": "openai-codex:user@example.com (user@example.com)"
                }
            ]
        });

        assert!(openclaw_auth_payload_has_oauth_provider(
            &auth,
            OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER
        ));
    }

    #[test]
    fn auth_ready_helper_accepts_cli_auth_list_array_output() {
        let output = r#"[{"id":"openai:user@example.com","provider":"openai","type":"oauth","label":"openai:user@example.com"}]"#;
        let auth = parse_json_value_from_output(output).expect("json array output");

        assert!(openclaw_auth_payload_has_oauth_provider(
            &auth,
            OPENCLAW_OPENAI_CODEX_CLI_AUTH_PROVIDER
        ));
    }

    #[test]
    fn official_codex_auth_payload_accepts_chatgpt_access_token() {
        let auth = serde_json::json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "access_token": "codex-access-token",
                "refresh_token": "codex-refresh-token",
                "account_id": "acct_123"
            }
        });

        assert_eq!(
            official_codex_access_token_from_auth_payload(&auth).as_deref(),
            Some("codex-access-token")
        );
    }

    #[test]
    fn official_codex_auth_payload_rejects_api_key_mode() {
        let auth = serde_json::json!({
            "auth_mode": "apikey",
            "tokens": {
                "access_token": "should-not-sync"
            }
        });

        assert!(official_codex_access_token_from_auth_payload(&auth).is_none());
    }

    #[test]
    fn codex_runtime_route_accepts_openai_oauth_profile() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai/gpt-5.5"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({
            "models": [
                {
                    "provider": "openai",
                    "id": "gpt-5.5",
                    "name": "GPT-5.5"
                }
            ]
        });
        let gateway_auth = serde_json::json!({ "providers": [] });
        let agent_auth = serde_json::json!([
            {
                "id": "openai:user@example.com",
                "provider": "openai",
                "type": "oauth",
                "label": "openai:user@example.com"
            }
        ]);

        let status = openclaw_model_status_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &gateway_auth,
            Some(&agent_auth),
        );

        assert!(status.provider_ready);
        assert_eq!(status.provider_mode.as_deref(), Some("openai-codex"));
        assert!(status.missing_providers_in_use.is_empty());
    }

    #[test]
    fn auth_ready_helper_accepts_auth_profiles_file_payload() {
        let auth = serde_json::json!({
            "version": 1,
            "profiles": {
                "openai-codex:user@example.com": {
                    "provider": "openai-codex",
                    "type": "oauth",
                    "email": "user@example.com"
                }
            }
        });

        assert!(openclaw_auth_payload_has_oauth_provider(
            &auth,
            OPENCLAW_OPENAI_CODEX_AUTH_PROVIDER
        ));
    }

    #[test]
    fn gateway_model_status_marks_missing_oauth_provider_not_ready() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai-codex/gpt-5.5"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({ "models": [] });
        let auth = serde_json::json!({
            "providers": [
                {
                    "provider": "openai-codex",
                    "status": "expired",
                    "profiles": [
                        {
                            "profileId": "openai-codex:user@example.com",
                            "type": "oauth",
                            "status": "expired"
                        }
                    ]
                }
            ]
        });

        let status = openclaw_model_status_from_gateway_payloads(&config, &models, &auth);

        assert!(!status.provider_ready);
        assert_eq!(
            status.missing_providers_in_use,
            vec!["openai-codex".to_string()]
        );
        assert_eq!(
            status.auth_profile_labels,
            vec!["openai-codex:user@example.com [expired]".to_string()]
        );
    }

    #[test]
    fn gateway_model_status_does_not_treat_catalog_codex_as_authenticated() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai-codex/gpt-5.5"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({
            "models": [
                {
                    "provider": "openai-codex",
                    "id": "gpt-5.5",
                    "name": "GPT-5.5"
                }
            ]
        });
        let auth = serde_json::json!({
            "providers": []
        });

        let status = openclaw_model_status_from_gateway_payloads(&config, &models, &auth);
        let snapshot = openclaw_models_snapshot_from_gateway_payloads(&config, &models, &auth);

        assert!(!status.provider_ready);
        assert_eq!(
            status.missing_providers_in_use,
            vec!["openai-codex".to_string()]
        );
        assert!(snapshot
            .models
            .iter()
            .any(|model| model.model_ref == "openai-codex/gpt-5.5" && !model.provider_ready));
        assert!(snapshot
            .providers
            .iter()
            .any(|provider| provider.id == "openai-codex" && !provider.ready));
    }

    #[test]
    fn gateway_model_status_requires_openai_auth_for_openai_models() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai/gpt-5.4"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({ "models": [] });
        let auth = serde_json::json!({ "providers": [] });

        let status = openclaw_model_status_from_gateway_payloads(&config, &models, &auth);

        assert!(!status.provider_ready);
        assert_eq!(status.missing_providers_in_use, vec!["openai".to_string()]);
    }

    #[test]
    fn gateway_model_status_accepts_agent_api_key_profile_for_current_provider() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "deepseek/deepseek-v4-flash"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({ "models": [] });
        let gateway_auth = serde_json::json!({ "providers": [] });
        let agent_auth = serde_json::json!({
            "profiles": [
                {
                    "id": "deepseek:default",
                    "provider": "deepseek",
                    "type": "api_key"
                }
            ]
        });

        let status = openclaw_model_status_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &gateway_auth,
            Some(&agent_auth),
        );

        assert!(status.provider_ready);
        assert!(status.missing_providers_in_use.is_empty());
        assert_eq!(
            status.auth_profile_labels,
            vec!["deepseek:default".to_string()]
        );

        let snapshot = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &gateway_auth,
            Some(&agent_auth),
        );
        assert!(snapshot
            .providers
            .iter()
            .any(|provider| provider.id == "deepseek" && provider.ready));
    }

    #[test]
    fn gateway_model_status_marks_agent_api_key_profile_cooldown() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "deepseek/deepseek-v4-flash"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({ "models": [] });
        let gateway_auth = serde_json::json!({ "providers": [] });
        let agent_auth = serde_json::json!({
            "profiles": {
                "deepseek:default": {
                    "provider": "deepseek",
                    "type": "api_key",
                    "cooldownUntil": "2026-06-26T13:30:00Z"
                }
            }
        });

        let status = openclaw_model_status_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &gateway_auth,
            Some(&agent_auth),
        );

        assert!(!status.provider_ready);
        assert_eq!(
            status.missing_providers_in_use,
            vec!["deepseek".to_string()]
        );
        assert_eq!(
            status.auth_profile_labels,
            vec!["deepseek:default [cooldown]".to_string()]
        );

        let snapshot = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &gateway_auth,
            Some(&agent_auth),
        );
        assert!(snapshot.providers.iter().any(|provider| {
            provider.id == "deepseek"
                && !provider.ready
                && provider.status.as_deref() == Some("cooldown")
        }));
    }

    #[test]
    fn gateway_model_status_marks_agent_api_key_profile_disabled() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "deepseek/deepseek-v4-flash"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({ "models": [] });
        let gateway_auth = serde_json::json!({ "providers": [] });
        let agent_auth = serde_json::json!({
            "profiles": [
                {
                    "id": "deepseek:default",
                    "provider": "deepseek",
                    "type": "api_key",
                    "disabledUntil": 1782469702002i64
                }
            ]
        });

        let snapshot = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &gateway_auth,
            Some(&agent_auth),
        );

        assert!(snapshot.providers.iter().any(|provider| {
            provider.id == "deepseek"
                && !provider.ready
                && provider.status.as_deref() == Some("disabled")
        }));
    }

    #[test]
    fn gateway_model_snapshot_does_not_fallback_to_gateway_auth_for_disabled_agent_profile() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "qwen/qwen3.7-plus"
                        },
                        "models": {
                            "deepseek/deepseek-v4-flash": {}
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({
            "models": [
                {
                    "provider": "deepseek",
                    "id": "deepseek-v4-flash",
                    "name": "DeepSeek V4 Flash"
                }
            ]
        });
        let gateway_auth = serde_json::json!({
            "providers": [
                {
                    "provider": "deepseek",
                    "status": "ok"
                }
            ]
        });
        let agent_auth = serde_json::json!({
            "profiles": [
                {
                    "id": "deepseek:default",
                    "provider": "deepseek",
                    "type": "api_key",
                    "disabledUntil": 1782469702002i64
                }
            ]
        });

        let snapshot = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
            &config,
            &models,
            &gateway_auth,
            Some(&agent_auth),
        );

        assert!(snapshot.models.iter().any(|model| {
            model.model_ref == "deepseek/deepseek-v4-flash"
                && !model.provider_ready
                && model.provider_status.as_deref() == Some("disabled")
        }));
        assert!(snapshot.providers.iter().any(|provider| {
            provider.id == "deepseek"
                && !provider.ready
                && provider.status.as_deref() == Some("disabled")
        }));
    }

    #[test]
    fn gateway_model_snapshot_accepts_provider_qualified_catalog_ids() {
        let config = serde_json::json!({
            "parsed": {
                "models": {
                    "providers": {
                        "openai": {
                            "models": [
                                {
                                    "id": "gpt-5.4",
                                    "name": "GPT-5.4"
                                }
                            ]
                        }
                    }
                },
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai/gpt-5.4"
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({
            "models": [
                {
                    "provider": "openai",
                    "id": "openai/gpt-5.4",
                    "name": "GPT-5.4"
                },
                {
                    "id": "zai/glm-5",
                    "name": "GLM-5"
                }
            ]
        });
        let auth = serde_json::json!({
            "providers": [
                {
                    "provider": "openai",
                    "status": "ok",
                    "profiles": [
                        {
                            "profileId": "openai:default",
                            "type": "api_key",
                            "status": "ok"
                        }
                    ]
                },
                {
                    "provider": "zai",
                    "status": "ok",
                    "profiles": [
                        {
                            "profileId": "zai:default",
                            "type": "api_key",
                            "status": "ok"
                        }
                    ]
                }
            ]
        });

        let snapshot = openclaw_models_snapshot_from_gateway_payloads(&config, &models, &auth);

        assert!(snapshot.models.iter().any(|model| {
            model.model_ref == "openai/gpt-5.4"
                && model.provider == "openai"
                && model.model == "gpt-5.4"
                && model.provider_ready
                && model.catalog_available
        }));
        assert!(snapshot.models.iter().any(|model| {
            model.model_ref == "zai/glm-5"
                && model.provider == "zai"
                && model.model == "glm-5"
                && model.provider_ready
                && !model.catalog_available
        }));
        assert!(!snapshot
            .models
            .iter()
            .any(|model| model.model_ref == "openai/openai/gpt-5.4"));
    }

    #[test]
    fn gateway_model_snapshot_combines_config_models_catalog_and_auth() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "openai-codex/gpt-5.5",
                            "fallbacks": ["openai/gpt-5.4"]
                        },
                        "models": {
                            "anthropic/claude-sonnet-4-6": {
                                "label": "Claude Sonnet"
                            }
                        }
                    }
                }
            }
        });
        let models = serde_json::json!({
            "models": [
                {
                    "provider": "openai-codex",
                    "id": "gpt-5.5",
                    "name": "GPT-5.5"
                },
                {
                    "provider": "openai",
                    "id": "gpt-5.4",
                    "name": "GPT-5.4"
                }
            ]
        });
        let auth = serde_json::json!({
            "providers": [
                {
                    "provider": "openai-codex",
                    "status": "ok",
                    "profiles": [
                        {
                            "profileId": "openai-codex:user@example.com",
                            "type": "oauth",
                            "status": "ok"
                        }
                    ]
                },
                {
                    "provider": "openai",
                    "status": "missing"
                }
            ]
        });

        let snapshot = openclaw_models_snapshot_from_gateway_payloads(&config, &models, &auth);

        assert_eq!(
            snapshot.primary_model.as_deref(),
            Some("openai-codex/gpt-5.5")
        );
        assert_eq!(snapshot.fallback_models, vec!["openai/gpt-5.4".to_string()]);
        assert!(snapshot
            .models
            .iter()
            .any(|model| model.model_ref == "anthropic/claude-sonnet-4-6" && model.configured));
        assert!(snapshot
            .models
            .iter()
            .any(|model| model.model_ref == "openai-codex/gpt-5.5" && model.provider_ready));
        assert!(snapshot
            .providers
            .iter()
            .any(|provider| provider.id == "openai-codex" && provider.ready));
        assert!(snapshot
            .providers
            .iter()
            .any(|provider| provider.id == "openai" && !provider.ready));
    }

    #[test]
    fn openclaw_models_snapshot_normalizes_profile_argument() {
        assert_eq!(
            normalize_openclaw_snapshot_profile(Some(" member-alice ")).as_deref(),
            Some("member-alice")
        );
        assert_eq!(normalize_openclaw_snapshot_profile(Some("  ")), None);
    }

    #[test]
    fn gateway_model_snapshot_marks_oauth_provider_without_profile_unavailable() {
        let config = serde_json::json!({});
        let models = serde_json::json!({
            "models": [
                { "provider": "openai-codex", "id": "gpt-5.5" },
                { "provider": "openai", "id": "gpt-5.4" }
            ]
        });
        let auth = serde_json::json!({
            "providers": [
                { "provider": "openai-codex", "status": "ok" },
                { "provider": "openai", "status": "missing" }
            ]
        });

        let snapshot = openclaw_models_snapshot_from_gateway_payloads(&config, &models, &auth);

        assert!(snapshot
            .models
            .iter()
            .any(|model| model.model_ref == "openai-codex/gpt-5.5" && !model.provider_ready));
        assert!(snapshot
            .models
            .iter()
            .any(|model| model.model_ref == "openai/gpt-5.4" && !model.provider_ready));
    }

    #[test]
    fn provider_api_key_specs_cover_coding_plan_providers() {
        let qwen =
            provider_api_key_spec("qwen").expect("qwen coding plan should support api key setup");
        assert_eq!(qwen.env_key, "QWEN_API_KEY");
        assert_eq!(qwen.provider_prefix, "qwen");
        assert_eq!(qwen.default_model, "qwen/qwen3.7-plus");
        assert_eq!(qwen.auth_choice, Some("qwen-api-key-cn"));
        assert_eq!(qwen.required_key_prefix, Some("sk-sp-"));

        let qwen_standard = provider_api_key_spec("qwen-standard-cn")
            .expect("qwen standard api key should support api key setup");
        assert_eq!(qwen_standard.provider_prefix, "qwen");
        assert_eq!(qwen_standard.default_model, "qwen/qwen3.7-plus");
        assert_eq!(qwen_standard.auth_choice, Some("qwen-standard-api-key-cn"));
        assert_eq!(qwen_standard.required_key_prefix, Some("sk-"));

        let token_plan = provider_api_key_spec("bailian-token-plan")
            .expect("bailian token plan should support api key setup");
        assert_eq!(
            token_plan.provider_prefix,
            OPENCLAW_BAILIAN_TOKEN_PLAN_PROVIDER
        );
        assert_eq!(token_plan.env_key, "");
        assert_eq!(
            token_plan.default_model,
            OPENCLAW_BAILIAN_TOKEN_PLAN_DEFAULT_MODEL
        );
        assert_eq!(token_plan.auth_choice, None);
        assert_eq!(token_plan.required_key_prefix, Some("sk-sp-"));

        let zai = provider_api_key_spec("zai").expect("zai should support api key setup");
        assert_eq!(zai.env_key, "ZAI_API_KEY");
        assert_eq!(zai.provider_prefix, "zai");
        assert_eq!(zai.default_model, "zai/glm-5");

        let deepseek =
            provider_api_key_spec("deepseek").expect("deepseek should support api key setup");
        assert_eq!(deepseek.env_key, "DEEPSEEK_API_KEY");
        assert_eq!(deepseek.provider_prefix, "deepseek");
        assert_eq!(deepseek.default_model, "deepseek/deepseek-v4-flash");
        assert_eq!(deepseek.auth_choice, Some("deepseek-api-key"));
        assert!(provider_login_supported("deepseek"));
        assert_eq!(
            recommended_model_for_provider("deepseek"),
            Some("deepseek/deepseek-v4-flash")
        );
    }

    #[test]
    fn qwen_coding_plan_rejects_standard_workspace_api_key() {
        let spec =
            provider_api_key_spec("qwen").expect("qwen coding plan should support api key setup");
        let error = validate_provider_api_key(&spec, "sk-ws-Hfake")
            .expect_err("standard workspace key should not be accepted for coding plan");

        assert!(error.contains("sk-sp-"));
        assert!(error.contains("sk-ws-"));
    }

    #[test]
    fn qwen_standard_api_key_rejects_coding_plan_key() {
        let spec = provider_api_key_spec("qwen-standard-cn")
            .expect("qwen standard api key should support api key setup");
        let error = validate_provider_api_key(&spec, "sk-sp-Hfake")
            .expect_err("coding plan key should not be accepted for standard endpoint");

        assert!(error.contains("Qwen 标准 API Key"));
        assert!(error.contains("Coding Plan"));
    }

    #[test]
    fn qwen_coding_plan_uses_official_openclaw_onboard_choice() {
        let spec =
            provider_api_key_spec("qwen").expect("qwen coding plan should support api key setup");
        let args = openclaw_provider_onboard_args(&spec);

        assert!(args
            .windows(2)
            .any(|pair| pair == ["--auth-choice", "qwen-api-key-cn"]));
        assert_eq!(
            recommended_model_for_provider("qwen"),
            Some("qwen/qwen3.7-plus")
        );
        assert!(provider_login_supported("qwen"));
    }

    #[test]
    fn bailian_token_plan_patch_uses_openai_compatible_endpoint() {
        let snapshot = serde_json::json!({
            "parsed": {
                "models": {
                    "providers": {
                        "bailian-token-plan": {
                            "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
                            "models": [
                                { "id": "qwen3.7-plus" }
                            ]
                        }
                    }
                },
                "agents": {
                    "defaults": {
                        "models": {
                            "openai/gpt-5.4": {}
                        }
                    }
                }
            }
        });

        let patch = build_bailian_token_plan_config_patch(
            &snapshot,
            "sk-sp-test",
            "bailian-token-plan/qwen3.7-plus",
        );

        assert_eq!(
            patch.pointer("/models/providers/bailian-token-plan/baseUrl"),
            Some(&Value::String(
                OPENCLAW_BAILIAN_TOKEN_PLAN_BASE_URL.to_string()
            ))
        );
        assert_eq!(
            patch.pointer("/models/providers/bailian-token-plan/api"),
            Some(&Value::String("openai-completions".to_string()))
        );
        assert_eq!(
            patch.pointer("/models/providers/bailian-token-plan/apiKey"),
            Some(&Value::String("sk-sp-test".to_string()))
        );
        assert_eq!(
            patch.pointer("/agents/defaults/model/primary"),
            Some(&Value::String(
                OPENCLAW_BAILIAN_TOKEN_PLAN_DEFAULT_MODEL.to_string()
            ))
        );
        assert_eq!(
            patch.pointer("/agents/defaults/models/bailian-token-plan~1qwen3.7-plus"),
            Some(&serde_json::json!({}))
        );
        assert_eq!(
            recommended_model_for_provider("bailian-token-plan"),
            Some(OPENCLAW_BAILIAN_TOKEN_PLAN_DEFAULT_MODEL)
        );
        assert!(provider_login_supported("bailian-token-plan"));
    }

    #[test]
    fn bailian_token_plan_patch_marks_vl_models_as_image_inputs() {
        let snapshot = serde_json::json!({});

        let patch = build_bailian_token_plan_config_patch(
            &snapshot,
            "sk-sp-test",
            "bailian-token-plan/qwen2.5-vl-72b-instruct",
        );

        assert_eq!(
            patch.pointer("/models/providers/bailian-token-plan/models/0/input"),
            Some(&serde_json::json!(["text", "image"]))
        );
    }

    #[tokio::test]
    async fn official_bootstrap_snapshot_selects_auth_from_final_default() {
        use std::cell::Cell;
        let auth = serde_json::json!({});
        for model in [
            None,
            Some(""),
            Some("  "),
            Some("raw"),
            Some("uniopc-official/test"),
            Some("openai-codex/test"),
            Some("custom-test/test"),
        ] {
            for catalog_ref in [None, Some("openai-codex/fallback")] {
                let config = model
                    .map(
                        |model| serde_json::json!({"agents":{"defaults":{"model":{"primary": model}}}}),
                    )
                    .unwrap_or_else(|| serde_json::json!({}));
                let models = catalog_ref
                    .map(|id| serde_json::json!({"models":[{"id":id}]}))
                    .unwrap_or_else(|| serde_json::json!({"models":[]}));
                let local = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
                    &config,
                    &models,
                    &auth,
                    Some(&auth),
                );
                // Same final resolution and truthiness as JS, after builder fallback.
                let final_ref = local
                    .resolved_default_model
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .or(local.primary_model.as_deref())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let expected_cli = !final_ref.is_empty()
                    && final_ref.contains('/')
                    && !final_ref.starts_with("uniopc-official/");
                let calls = Cell::new(0);
                let cli_auth = serde_json::json!({"profiles":{"codex":{"provider":"openai-codex","type":"oauth","access":"test"}}});
                let actual =
                    official_bootstrap_snapshot_with_auth(&config, &models, &auth, local, || async {
                        calls.set(calls.get() + 1);
                        cli_auth.clone()
                    })
                    .await;
                assert_eq!(
                    calls.get(),
                    usize::from(expected_cli),
                    "{model:?} {catalog_ref:?}"
                );
                if expected_cli {
                    let old = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
                        &config,
                        &models,
                        &auth,
                        Some(&cli_auth),
                    );
                    assert_eq!(
                        serde_json::to_value(actual).unwrap(),
                        serde_json::to_value(old).unwrap()
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn official_snapshot_cli_failure_retains_profile_local_fallback() {
        use std::cell::Cell;
        let config =
            serde_json::json!({"agents":{"defaults":{"model":{"primary":"openai-codex/test"}}}});
        let models = serde_json::json!({"models":[{"id":"openai-codex/test"}]});
        let gateway_auth = serde_json::json!({});
        for profile_label in ["profile-a", "profile-b"] {
            let local_auth = serde_json::json!({"profiles":{profile_label:{"provider":"openai-codex","type":"oauth","access":"test"}}});
            for cli_result in [
                None,
                Some(
                    serde_json::json!({"profiles":{"cli":{"provider":"openai-codex","type":"oauth","access":"test"}}}),
                ),
            ] {
                let calls = Cell::new(0);
                let old_auth =
                    openclaw_agent_auth_with_local_fallback(cli_result.clone(), || local_auth.clone());
                let old_snapshot = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
                    &config,
                    &models,
                    &gateway_auth,
                    Some(&old_auth),
                );
                let local_snapshot = openclaw_models_snapshot_from_gateway_payloads_with_agent_auth(
                    &config,
                    &models,
                    &gateway_auth,
                    Some(&local_auth),
                );
                let actual = official_bootstrap_snapshot_with_auth(
                    &config,
                    &models,
                    &gateway_auth,
                    local_snapshot,
                    || async {
                        calls.set(calls.get() + 1);
                        openclaw_agent_auth_with_local_fallback(cli_result, || local_auth.clone())
                    },
                )
                .await;
                assert_eq!(calls.get(), 1);
                assert_eq!(
                    serde_json::to_value(actual).unwrap(),
                    serde_json::to_value(old_snapshot).unwrap()
                );
            }
        }
    }

    #[tokio::test]
    async fn official_agent_migration_loads_auth_only_for_other_model_candidates() {
        use std::cell::Cell;
        let target = "uniopc-official/test";
        for agents in [
            serde_json::json!([]),
            serde_json::json!([{"id":"default","isDefault":true,"model":"openai-codex/test"}]),
            serde_json::json!([{"id":"a","model":target}]),
            serde_json::json!([{"id":"missing"},{"agentId":"blank","default_model":"  "}]),
            serde_json::json!([{"id":"a","model":"openai-codex/test"},{"id":"b","defaultModel":"custom-test/test"},{"id":"c","default_model":"unavailable/test"},{"id":"missing"}]),
        ] {
            let agents = agents.as_array().unwrap();
            let calls = Cell::new(0);
            let ready = official_agent_migration_ready_models(agents, target, || async {
                calls.set(calls.get() + 1);
                Ok([
                    "openai-codex/test".to_string(),
                    "custom-test/test".to_string(),
                ]
                .into_iter()
                .collect())
            })
            .await
            .unwrap();
            let targets = agent_model_migration_targets(agents, &ready, target);
            if agents.len() == 4 {
                assert_eq!(calls.get(), 1);
                assert_eq!(targets, vec!["c", "missing"]);
            } else {
                assert_eq!(calls.get(), 0);
                if agents.len() == 2 {
                    assert_eq!(targets, vec!["missing", "blank"]);
                } else {
                    assert!(targets.is_empty());
                }
            }
        }
        let agents = vec![serde_json::json!({"id":"a","model":"other/test"})];
        let error = official_agent_migration_ready_models(&agents, target, || async {
            Err("rpc failed".to_string())
        })
        .await
        .unwrap_err();
        assert_eq!(error, "rpc failed");
    }

    #[test]
    fn agent_model_migration_targets_only_unavailable_non_default_agents() {
        let agents = vec![
            serde_json::json!({
                "id": "main",
                "model": "deepseek/deepseek-v4-pro",
                "isDefault": true
            }),
            serde_json::json!({
                "id": "employee-old",
                "model": "deepseek/deepseek-v4-pro"
            }),
            serde_json::json!({
                "id": "employee-ready",
                "model": "openai-codex/gpt-5.5"
            }),
            serde_json::json!({
                "id": "employee-target",
                "model": "bailian-token-plan/qwen3.7-plus"
            }),
            serde_json::json!({
                "id": "employee-empty"
            }),
        ];
        let ready_models = BTreeSet::from([
            "openai-codex/gpt-5.5".to_string(),
            "bailian-token-plan/qwen3.7-plus".to_string(),
        ]);

        assert_eq!(
            agent_model_migration_targets(
                &agents,
                &ready_models,
                "bailian-token-plan/qwen3.7-plus"
            ),
            vec!["employee-old".to_string(), "employee-empty".to_string()]
        );
    }

    #[test]
    fn provider_plugin_allow_patch_preserves_existing_policy() {
        let snapshot = serde_json::json!({
            "parsed": {
                "plugins": {
                    "allow": ["uniopc-cloud-workspace", "acpx"],
                    "deny": ["qwen", "other"]
                }
            }
        });

        let patch = build_openclaw_provider_plugin_allow_patch(&snapshot, "qwen")
            .expect("qwen should be added to existing plugin allowlist");

        assert_eq!(
            patch.pointer("/plugins/allow"),
            Some(&serde_json::json!([
                "uniopc-cloud-workspace",
                "acpx",
                "qwen"
            ]))
        );
        assert_eq!(
            patch.pointer("/plugins/deny"),
            Some(&serde_json::json!(["other"]))
        );
    }

    #[test]
    fn openclaw_provider_mode_does_not_support_local_ollama_models() {
        assert_eq!(
            openclaw_provider_mode_from_ref("ollama/qwen3:4b", false, false),
            None
        );
    }

    #[test]
    fn openai_api_and_openai_codex_are_distinct_provider_modes() {
        assert_eq!(
            openclaw_provider_mode_from_ref("openai/gpt-5.4", true, false),
            Some("openai-api".to_string())
        );
        assert_eq!(
            openclaw_provider_mode_from_ref("openai/gpt-5.5", true, false),
            Some("openai-codex".to_string())
        );
        assert_eq!(
            openclaw_provider_mode_from_ref("openai-codex/gpt-5.5", true, false),
            Some("openai-codex".to_string())
        );
    }

    #[test]
    fn default_model_patch_preserves_existing_model_allowlist_entries() {
        let snapshot = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "models": {
                            "anthropic/claude-sonnet-4-6": {
                                "alias": "Sonnet"
                            }
                        }
                    }
                }
            }
        });

        let patch = build_openclaw_default_model_patch(&snapshot, "openai-codex/gpt-5.5");
        let models = patch
            .pointer("/agents/defaults/models")
            .and_then(Value::as_object)
            .expect("patch should include models allowlist");

        assert!(models.contains_key("anthropic/claude-sonnet-4-6"));
        assert!(models.contains_key("openai-codex/gpt-5.5"));
        assert_eq!(
            patch.pointer("/agents/defaults/model/primary"),
            Some(&Value::String("openai-codex/gpt-5.5".to_string()))
        );
        assert_eq!(
            patch.pointer("/models/providers/openai-codex/models/0/id"),
            Some(&Value::String("gpt-5.5".to_string()))
        );
        assert_eq!(
            patch.pointer("/models/providers/openai-codex/models/0/name"),
            Some(&Value::String("GPT-5.5".to_string()))
        );
    }

    #[test]
    fn default_model_patch_marks_vl_models_as_image_inputs() {
        let snapshot = serde_json::json!({});

        let patch = build_openclaw_default_model_patch(&snapshot, "qwen/qwen2.5-vl-72b-instruct");

        assert_eq!(
            patch.pointer("/models/providers/qwen/models/0/input"),
            Some(&serde_json::json!(["text", "image"]))
        );
    }

    #[test]
    fn default_model_patch_marks_gpt5_as_image_input() {
        let snapshot = serde_json::json!({});

        let patch = build_openclaw_default_model_patch(&snapshot, "openai/gpt-5.5");

        assert_eq!(
            patch.pointer("/models/providers/openai/models/0/input"),
            Some(&serde_json::json!(["text", "image"]))
        );
    }

    #[test]
    fn uniopc_official_patch_marks_default_model_as_image_input() {
        let snapshot = serde_json::json!({});

        let patch = build_uniopc_official_config_patch(
            &snapshot,
            "https://proxy.example.com/v1",
            "sk-test",
            OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
            &[],
        );

        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/input"),
            Some(&serde_json::json!(["text", "image"]))
        );
        assert_eq!(
            patch.pointer("/tts/provider"),
            Some(&serde_json::json!("minimax"))
        );
        assert!(patch.pointer("/messages/tts").is_none());
    }

    #[test]
    fn custom_provider_id_is_slugified_and_namespaced() {
        // Namespaced so a custom entry can never shadow a managed provider
        // (openai / qwen / uniopc-official) and hijack its slots.
        assert_eq!(
            custom_provider_id_from_label("My Endpoint"),
            "custom-my-endpoint"
        );
        assert_eq!(custom_provider_id_from_label("GLM-5.2"), "custom-glm-5.2");
        assert_eq!(custom_provider_id_from_label("openai"), "custom-openai");
        // Non-ASCII labels slugify to nothing — must not emit a bare prefix.
        assert_eq!(custom_provider_id_from_label("我的端点"), "custom-endpoint");
        assert_eq!(custom_provider_id_from_label("  "), "custom-endpoint");
    }

    #[test]
    fn custom_openai_provider_patch_registers_provider_and_default_model() {
        let snapshot = serde_json::json!({});
        let patch = build_custom_openai_provider_config_patch(
            &snapshot,
            "custom-my-endpoint",
            "https://api.example.com/v1",
            "sk-user-key",
            "glm-5.2",
        );

        assert_eq!(
            patch.pointer("/models/providers/custom-my-endpoint/baseUrl"),
            Some(&serde_json::json!("https://api.example.com/v1"))
        );
        // The user's own key is a literal here (unlike the official provider,
        // which carries the loopback shared secret) — it IS their credential.
        assert_eq!(
            patch.pointer("/models/providers/custom-my-endpoint/apiKey"),
            Some(&serde_json::json!("sk-user-key"))
        );
        assert_eq!(
            patch.pointer("/models/providers/custom-my-endpoint/api"),
            Some(&serde_json::json!("openai-completions"))
        );
        assert_eq!(
            patch.pointer("/models/providers/custom-my-endpoint/models/0/id"),
            Some(&serde_json::json!("glm-5.2"))
        );
        assert_eq!(
            patch.pointer("/agents/defaults/model/primary"),
            Some(&serde_json::json!("custom-my-endpoint/glm-5.2"))
        );
        assert!(patch
            .pointer("/agents/defaults/models/custom-my-endpoint~1glm-5.2")
            .is_some());
    }

    #[test]
    fn custom_openai_provider_patch_preserves_existing_models_of_that_provider() {
        // Adding a second model to the same custom endpoint must not drop the
        // first one from the provider's registration array.
        let snapshot = serde_json::json!({
            "parsed": {
                "models": {
                    "providers": {
                        "custom-my-endpoint": {
                            "models": [{ "id": "glm-5.2", "name": "GLM-5.2" }]
                        }
                    }
                }
            }
        });
        let patch = build_custom_openai_provider_config_patch(
            &snapshot,
            "custom-my-endpoint",
            "https://api.example.com/v1",
            "sk-user-key",
            "glm-5.2-air",
        );

        let ids: Vec<&str> = patch
            .pointer("/models/providers/custom-my-endpoint/models")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(ids, vec!["glm-5.2", "glm-5.2-air"]);
    }

    #[test]
    fn uniopc_official_patch_registers_catalog_models_with_display_names() {
        let snapshot = serde_json::json!({});
        let catalog = vec![
            OpenClawOfficialCatalogModel {
                // The default id also arrives in mint's `models[]`; it must not
                // be double-registered.
                id: "uniopc-default".to_string(),
                display_name: Some("Qwen-3.7".to_string()),
                supports_vision: Some(true),
                supports_reasoning: Some(true),
                thinking_format: Some("qwen".to_string()),
            },
            OpenClawOfficialCatalogModel {
                id: "glm-5.2".to_string(),
                display_name: Some("GLM-5.2".to_string()),
                supports_vision: Some(true),
                supports_reasoning: Some(true),
                thinking_format: Some(String::new()),
            },
            OpenClawOfficialCatalogModel {
                id: "minimax-m2.7".to_string(),
                display_name: None,
                supports_vision: Some(true),
                supports_reasoning: Some(true),
                thinking_format: None,
            },
            OpenClawOfficialCatalogModel {
                id: "  ".to_string(),
                display_name: Some("junk".to_string()),
                supports_vision: None,
                supports_reasoning: None,
                thinking_format: None,
            },
        ];

        let patch = build_uniopc_official_config_patch(
            &snapshot,
            "http://127.0.0.1:52731/v1",
            "loopback-secret-123",
            OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
            &catalog,
        );

        let models = patch
            .pointer("/models/providers/uniopc-official/models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let ids: Vec<&str> = models
            .iter()
            .filter_map(|entry| entry.get("id").and_then(Value::as_str))
            .collect();
        // Default first, catalog extras after, blank id dropped, no dupes.
        assert_eq!(ids, vec!["uniopc-default", "glm-5.2", "minimax-m2.7"]);

        let glm = models
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some("glm-5.2"))
            .expect("glm entry");
        assert_eq!(
            glm.get("name").and_then(Value::as_str),
            Some("GLM-5.2"),
            "catalog display name must land as the model name"
        );

        // Every catalog model joins the agent allowlist so sessions can select it.
        assert!(patch
            .pointer("/agents/defaults/models/uniopc-official~1glm-5.2")
            .is_some());
        assert!(patch
            .pointer("/agents/defaults/models/uniopc-official~1minimax-m2.7")
            .is_some());
        // The default stays the primary model.
        assert_eq!(
            patch.pointer("/agents/defaults/model/primary"),
            Some(&serde_json::json!(OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL))
        );
        // Capabilities are transcribed from the catalog declaration, so a
        // renamed alias keeps them.
        for id in ["uniopc-default", "glm-5.2", "minimax-m2.7"] {
            let entry = models
                .iter()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
                .unwrap_or_else(|| panic!("{id} entry"));
            assert_eq!(
                entry.get("input"),
                Some(&serde_json::json!(["text", "image"])),
                "{id} must accept image input"
            );
            assert_eq!(
                entry.get("reasoning").and_then(Value::as_bool),
                Some(true),
                "{id} must declare reasoning"
            );
        }
        // ...and the `enable_thinking` shim only lands where the catalog
        // declared a format. GLM declared '' and MiniMax declared nothing, so
        // neither may carry it: llm-proxy forwards the parameter verbatim and
        // those upstreams would reject it.
        assert_eq!(
            glm.pointer("/compat/thinkingFormat"),
            None,
            "a catalog row declaring no thinking format must not get the shim"
        );
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/compat/thinkingFormat"),
            Some(&serde_json::json!("qwen")),
            "the row that declared 'qwen' keeps it"
        );
    }

    #[test]
    fn uniopc_official_patch_keeps_legacy_allowed_aliases_registered() {
        let snapshot = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "models": {
                            "uniopc-official/uniopc-default": {},
                            "uniopc-official/minimax-m3": {}
                        }
                    }
                }
            }
        });
        let catalog = vec![OpenClawOfficialCatalogModel {
            id: "minimax-m3".to_string(),
            display_name: Some("MiniMax M3".to_string()),
            supports_vision: Some(true),
            supports_reasoning: Some(true),
            thinking_format: None,
        }];

        let patch = build_uniopc_official_config_patch(
            &snapshot,
            "http://127.0.0.1:52731/v1",
            "loopback-secret-123",
            "uniopc-official/minimax-m3",
            &catalog,
        );
        let ids = patch
            .pointer("/models/providers/uniopc-official/models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert!(ids.contains(&"minimax-m3"));
        assert!(ids.contains(&"uniopc-default"));
    }

    #[test]
    fn official_reconnect_preserves_an_existing_official_model_selection() {
        let official = serde_json::json!({
            "agents": { "defaults": { "model": { "primary": "uniopc-official/minimax-m3" } } }
        });
        assert_eq!(
            official_model_target_preserving_existing_selection(
                &official,
                OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
            ),
            "uniopc-official/minimax-m3"
        );

        let foreign = serde_json::json!({
            "agents": { "defaults": { "model": { "primary": "openai-codex/gpt-5.5" } } }
        });
        assert_eq!(
            official_model_target_preserving_existing_selection(
                &foreign,
                OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
            ),
            OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL
        );
    }

    #[test]
    fn official_model_capabilities_come_from_the_catalog_declaration() {
        // The catalog is authoritative in BOTH directions: it must be able to
        // turn a capability back off, and to repair entries a previous desktop
        // wrote by guessing from the model id.
        let snapshot = serde_json::json!({
            "parsed": {
                "models": {
                    "providers": {
                        "uniopc-official": {
                            "models": [
                                {
                                    "id": "Qwen-3.7",
                                    "name": "Qwen-3.7",
                                    "input": ["text"],
                                },
                                {
                                    // Written by an older desktop that assumed
                                    // every official chat model was multimodal.
                                    "id": "text-only-m1",
                                    "name": "Text Only M1",
                                    "input": ["text", "image"],
                                    "reasoning": true,
                                    "compat": { "thinkingFormat": "qwen" },
                                },
                            ]
                        }
                    }
                }
            }
        });
        let catalog = vec![
            OpenClawOfficialCatalogModel {
                id: "Qwen-3.7".to_string(),
                display_name: Some("Qwen-3.7".to_string()),
                supports_vision: Some(true),
                supports_reasoning: Some(true),
                thinking_format: Some("qwen".to_string()),
            },
            OpenClawOfficialCatalogModel {
                id: "text-only-m1".to_string(),
                display_name: Some("Text Only M1".to_string()),
                supports_vision: Some(false),
                supports_reasoning: Some(false),
                thinking_format: None,
            },
        ];

        let patch = build_uniopc_official_config_patch(
            &snapshot,
            "https://proxy.example.com/v1",
            "sk-test",
            "uniopc-official/Qwen-3.7",
            &catalog,
        );

        // Renamed default row: declaration restores what the id guess lost.
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/input"),
            Some(&serde_json::json!(["text", "image"]))
        );
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/compat/thinkingFormat"),
            Some(&serde_json::json!("qwen"))
        );
        // Declared text-only: the stale image/reasoning/shim keys are cleared,
        // not merely left alone. The whole models array is replaced in the
        // patch, so dropping a key here really removes it from the config.
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/1/input"),
            Some(&serde_json::json!(["text"]))
        );
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/1/reasoning"),
            Some(&serde_json::json!(false))
        );
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/1/compat"),
            None
        );
    }

    #[test]
    fn official_models_keep_capabilities_when_the_backend_predates_declarations() {
        // Desktop updated ahead of the backend: mint's models[] carries no
        // capability fields at all. Falling through to "text-only" would be a
        // silent regression, so the pre-declaration behaviour is kept.
        let snapshot = serde_json::json!({});
        let catalog = vec![OpenClawOfficialCatalogModel {
            id: "minimax-m2.7".to_string(),
            display_name: Some("MiniMax-M2.7".to_string()),
            supports_vision: None,
            supports_reasoning: None,
            thinking_format: None,
        }];

        let patch = build_uniopc_official_config_patch(
            &snapshot,
            "https://proxy.example.com/v1",
            "sk-test",
            OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
            &catalog,
        );

        let minimax = patch
            .pointer("/models/providers/uniopc-official/models")
            .and_then(Value::as_array)
            .and_then(|models| {
                models
                    .iter()
                    .find(|entry| entry.get("id").and_then(Value::as_str) == Some("minimax-m2.7"))
            })
            .expect("minimax entry");
        assert_eq!(
            minimax.get("input"),
            Some(&serde_json::json!(["text", "image"]))
        );
        assert_eq!(minimax.get("reasoning"), Some(&serde_json::json!(false)));
        // Still no Qwen shim for a non-Qwen id.
        assert_eq!(minimax.pointer("/compat/thinkingFormat"), None);
    }

    #[test]
    fn uniopc_official_patch_uses_string_apikey_and_no_file_secret() {
        // Loopback-proxy scheme: the apiKey is the plain loopback shared secret
        // (NOT a `{source:"file"}` ref), the baseUrl is the loopback proxy, and
        // there is NO `secrets.providers` block — the real token lives only in
        // the proxy's memory, so config is byte-stable across token rotations.
        let snapshot = serde_json::json!({});
        let patch = build_uniopc_official_config_patch(
            &snapshot,
            "http://127.0.0.1:52731/v1",
            "loopback-secret-123",
            OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
            &[],
        );

        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/apiKey"),
            Some(&serde_json::json!("loopback-secret-123")),
            "apiKey must be the plain shared secret string"
        );
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/baseUrl"),
            Some(&serde_json::json!("http://127.0.0.1:52731/v1"))
        );
        // The image/openai slot rides the same string secret + loopback base.
        assert_eq!(
            patch.pointer("/models/providers/openai/apiKey"),
            Some(&serde_json::json!("loopback-secret-123"))
        );
        assert!(
            patch.pointer("/secrets").is_none(),
            "no secrets.providers block should be written"
        );
    }

    #[test]
    fn uniopc_official_patch_reclaims_migrated_openai_media_slot() {
        // Migration case (real-machine found this): an OLD file-secret config
        // has `openai` pointing at direct Supabase with a `{source:"file"}`
        // apiKey. The slot must be recognized as ours (by the apiKey) and
        // repointed at the loopback proxy — NOT mistaken for the user's own
        // OpenAI and left on the stale file token.
        let snapshot = serde_json::json!({
            "parsed": {
                "models": { "providers": {
                    "openai": {
                        "baseUrl": "https://x.supabase.co/functions/v1/llm-proxy/v1",
                        "apiKey": { "source": "file", "provider": "uniopc-official", "id": "value" },
                        "models": [ { "id": "uniopc-image", "name": "img", "input": ["text"] } ]
                    }
                }}
            }
        });
        let patch = build_uniopc_official_config_patch(
            &snapshot,
            "http://127.0.0.1:52731/v1",
            "loopback-secret-123",
            OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
            &[],
        );

        assert_eq!(
            patch.pointer("/models/providers/openai/baseUrl"),
            Some(&serde_json::json!("http://127.0.0.1:52731/v1")),
            "migrated openai slot must be repointed at the loopback proxy"
        );
        assert_eq!(
            patch.pointer("/models/providers/openai/apiKey"),
            Some(&serde_json::json!("loopback-secret-123")),
            "migrated openai apiKey must become the plain shared secret"
        );
    }

    #[test]
    fn uniopc_official_patch_does_not_guess_thinking_for_the_default_alias() {
        let snapshot = serde_json::json!({});

        let patch = build_uniopc_official_config_patch(
            &snapshot,
            "https://proxy.example.com/v1",
            "sk-test",
            OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
            &[],
        );

        // The default alias can point to a non-Qwen upstream. Thinking needs a
        // catalog declaration instead of an alias-based guess.
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/reasoning"),
            Some(&serde_json::json!(false))
        );
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/compat/thinkingFormat"),
            None
        );
    }

    #[test]
    fn uniopc_official_patch_repairs_stale_entry_missing_thinking_capability() {
        let snapshot = serde_json::json!({
            "parsed": {
                "models": {
                    "providers": {
                        "uniopc-official": {
                            "models": [
                                { "id": "uniopc-default", "name": "Uniopc-Default", "input": ["text", "image"] }
                            ]
                        }
                    }
                }
            }
        });

        let patch = build_uniopc_official_config_patch(
            &snapshot,
            "https://proxy.example.com/v1",
            "sk-test",
            OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
            &[],
        );

        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/reasoning"),
            Some(&serde_json::json!(false))
        );
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/compat/thinkingFormat"),
            None
        );
        // 已有 compat 字段不能被整体覆盖。
        let snapshot_with_compat = serde_json::json!({
            "parsed": {
                "models": {
                    "providers": {
                        "uniopc-official": {
                            "models": [
                                {
                                    "id": "uniopc-default",
                                    "name": "Uniopc-Default",
                                    "input": ["text", "image"],
                                    "compat": { "supportsStore": false }
                                }
                            ]
                        }
                    }
                }
            }
        });
        let patch = build_uniopc_official_config_patch(
            &snapshot_with_compat,
            "https://proxy.example.com/v1",
            "sk-test",
            OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
            &[],
        );
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/compat/supportsStore"),
            Some(&serde_json::json!(false))
        );
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/compat/thinkingFormat"),
            None
        );
    }

    #[test]
    fn provider_model_normalization_repairs_stale_text_only_input() {
        let snapshot = serde_json::json!({
            "parsed": {
                "models": {
                    "providers": {
                        "uniopc-official": {
                            "models": [
                                { "id": "uniopc-default", "name": "Uniopc-Default", "input": ["text"] },
                                { "id": "uniopc-tts", "name": "Uniopc-Tts", "input": ["text"] }
                            ]
                        }
                    }
                }
            }
        });

        let patch = build_uniopc_official_config_patch(
            &snapshot,
            "https://proxy.example.com/v1",
            "sk-test",
            OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL,
            &[],
        );

        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/input"),
            Some(&serde_json::json!(["text", "image"]))
        );
        // 非视觉模型保持原样，不能被顺手改坏。
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/1/input"),
            Some(&serde_json::json!(["text"]))
        );
    }

    #[test]
    fn official_chat_capabilities_survive_an_operator_alias_rename() {
        // The default row's alias is operator-editable in the admin console;
        // renaming it must not strip image input or the Think picker. Stale
        // text-only entries left by the old id-literal check get repaired too.
        let snapshot = serde_json::json!({
            "parsed": {
                "models": {
                    "providers": {
                        "uniopc-official": {
                            "models": [
                                { "id": "Qwen-3.7", "name": "Qwen-3.7", "input": ["text"] },
                                { "id": "minimax-m2.7", "name": "MiniMax-M2.7", "input": ["text"] }
                            ]
                        }
                    }
                }
            }
        });

        let patch = build_uniopc_official_config_patch(
            &snapshot,
            "https://proxy.example.com/v1",
            "sk-test",
            "uniopc-official/Qwen-3.7",
            &[],
        );

        for index in 0..2 {
            assert_eq!(
                patch.pointer(&format!(
                    "/models/providers/uniopc-official/models/{index}/input"
                )),
                Some(&serde_json::json!(["text", "image"]))
            );
        }
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/reasoning"),
            Some(&serde_json::json!(true))
        );
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/1/reasoning"),
            Some(&serde_json::json!(false))
        );
        // Qwen family keeps the `enable_thinking` shim; MiniMax must not get it.
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/compat/thinkingFormat"),
            Some(&serde_json::json!("qwen"))
        );
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/1/compat"),
            None
        );
    }

    #[test]
    fn media_capabilities_patch_uses_openclaw_8_media_model_defaults() {
        let req = OpenClawMediaCapabilitiesSaveRequest {
            profile: Some("work".to_string()),
            image_model: Some("qwen/qwen-image".to_string()),
            video_model: Some("minimax/video-01".to_string()),
            tts_model: Some("openai/tts-1".to_string()),
            tts_voice: Some("alloy".to_string()),
            stt_model: Some("openai/whisper-1".to_string()),
        };

        let patch = build_openclaw_media_capabilities_patch(&req);

        assert_eq!(
            patch.pointer("/agents/defaults/mediaModels/image"),
            Some(&Value::String("qwen/qwen-image".to_string()))
        );
        assert_eq!(
            patch.pointer("/agents/defaults/mediaModels/video"),
            Some(&Value::String("minimax/video-01".to_string()))
        );
        assert_eq!(
            patch.pointer("/tts/provider"),
            Some(&Value::String("openai".to_string()))
        );
        assert_eq!(
            patch.pointer("/tts/providers/openai/model"),
            Some(&Value::String("tts-1".to_string()))
        );
        assert_eq!(
            patch.pointer("/tts/providers/openai/voice"),
            Some(&Value::String("alloy".to_string()))
        );
        assert_eq!(
            patch.pointer("/tools/media/audio/preferredModel"),
            Some(&Value::String("openai/whisper-1".to_string()))
        );
        assert_eq!(
            patch.pointer("/tools/media/models/0"),
            Some(&serde_json::json!({
                "provider": "openai",
                "model": "whisper-1",
                "capabilities": ["audio"]
            }))
        );
    }

    #[test]
    fn media_capabilities_snapshot_reads_openclaw_8_media_model_defaults() {
        let config = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": { "primary": "openai/gpt-5.4" },
                        "mediaModels": {
                            "image": "qwen/qwen-image",
                            "video": "minimax/video-01"
                        }
                    }
                },
                "tts": {
                    "provider": "openai",
                    "providers": {
                        "openai": {
                            "model": "tts-1",
                            "voice": "alloy"
                        }
                    }
                },
                "tools": {
                    "media": {
                        "audio": {
                            "preferredModel": "openai/whisper-1"
                        },
                        "models": [{
                            "provider": "openai",
                            "model": "whisper-1",
                            "capabilities": ["audio"]
                        }]
                    }
                }
            }
        });
        let models = serde_json::json!({ "models": [] });
        let auth = serde_json::json!({});

        let snapshot = openclaw_models_snapshot_from_gateway_payloads(&config, &models, &auth);

        assert_eq!(
            snapshot.image_generation_model.as_deref(),
            Some("qwen/qwen-image")
        );
        assert_eq!(
            snapshot.video_generation_model.as_deref(),
            Some("minimax/video-01")
        );
        assert_eq!(snapshot.tts_model.as_deref(), Some("openai/tts-1"));
        assert_eq!(snapshot.tts_voice.as_deref(), Some("alloy"));
        assert_eq!(snapshot.stt_model.as_deref(), Some("openai/whisper-1"));
    }

    #[test]
    fn member_profile_provision_config_patch_preserves_vars_and_shell_env() {
        for root in [
            "parsed",
            "sourceConfig",
            "config",
            "runtimeConfig",
            "resolved",
            "",
        ] {
            let existing = serde_json::json!({
                "env": {
                    "shellEnv": { "enabled": true, "timeoutMs": 750 },
                    "vars": { "KEEP_ME": "preserved", "IMAI_OPENCLAW_PROFILE": "old" }
                }
            });
            let snapshot = if root.is_empty() {
                existing.clone()
            } else {
                let mut wrapped = serde_json::Map::new();
                wrapped.insert(root.into(), existing.clone());
                Value::Object(wrapped)
            };
            let patch = build_member_profile_provision_config_patch(
                &snapshot,
                "new-profile",
                false,
                None,
                None,
                None,
                None,
                None,
                Some("/private/bin"),
            );
            assert_eq!(
                patch.pointer("/env/shellEnv"),
                existing.pointer("/env/shellEnv")
            );
            assert_eq!(
                patch.pointer("/env/vars/KEEP_ME"),
                Some(&serde_json::json!("preserved"))
            );
            assert_eq!(
                patch.pointer("/env/vars/IMAI_OPENCLAW_PROFILE"),
                Some(&serde_json::json!("new-profile"))
            );
            assert_eq!(
                patch.pointer("/env/vars/PATH"),
                Some(&serde_json::json!("/private/bin"))
            );
            let env = patch["env"].as_object().unwrap();
            assert!(env.keys().all(|key| key == "vars" || key == "shellEnv"));
            assert!(env["vars"]
                .as_object()
                .unwrap()
                .values()
                .all(Value::is_string));
        }
    }

    #[test]
    fn member_profile_provision_config_patch_migrates_legacy_strings_without_overriding_vars() {
        let snapshot = serde_json::json!({ "parsed": { "env": {
            "shellEnv": { "enabled": false },
            "vars": { "DUPLICATE": "canonical" },
            "DUPLICATE": "legacy", "LEGACY_ONLY": "keep", "PATH": "/old/bin"
        } } });
        let patch = build_member_profile_provision_config_patch(
            &snapshot,
            "profile",
            false,
            None,
            None,
            None,
            None,
            None,
            Some("/new/bin"),
        );
        assert_eq!(
            patch.pointer("/env/vars/DUPLICATE"),
            Some(&serde_json::json!("canonical"))
        );
        assert_eq!(
            patch.pointer("/env/vars/LEGACY_ONLY"),
            Some(&serde_json::json!("keep"))
        );
        assert_eq!(
            patch.pointer("/env/vars/PATH"),
            Some(&serde_json::json!("/new/bin"))
        );
        for key in ["DUPLICATE", "LEGACY_ONLY", "PATH"] {
            assert_eq!(
                patch["env"].get(key),
                Some(&Value::Null),
                "remove legacy key using merge-patch tombstone"
            );
        }
        assert!(patch["env"]["vars"]
            .as_object()
            .unwrap()
            .values()
            .all(Value::is_string));
    }

    #[test]
    fn env_var_effective_check_prefers_canonical_vars_and_retains_legacy_reads() {
        let nested = serde_json::json!({ "parsed": { "env": {
            "vars": { "TEST_KEY": "canonical" }, "TEST_KEY": "legacy"
        } } });
        assert!(openclaw_env_var_is_effective(
            &nested,
            "TEST_KEY",
            "canonical"
        ));
        assert!(!openclaw_env_var_is_effective(
            &nested, "TEST_KEY", "legacy"
        ));
        for root in [
            "parsed",
            "sourceConfig",
            "config",
            "runtimeConfig",
            "resolved",
            "",
        ] {
            let mut config = serde_json::json!({ "env": { "vars": { "TEST_KEY": "canonical" } } });
            if !root.is_empty() {
                let mut wrapped = serde_json::Map::new();
                wrapped.insert(root.into(), config);
                config = Value::Object(wrapped);
            }
            assert!(openclaw_env_var_is_effective(
                &config,
                "TEST_KEY",
                "canonical"
            ));
        }
        assert!(openclaw_env_var_is_effective(
            &serde_json::json!({"env":{"TEST_KEY":"legacy"}}),
            "TEST_KEY",
            "legacy"
        ));
    }

    #[test]
    fn member_profile_provision_config_patch_uses_uniopc_official_default_model() {
        let snapshot = serde_json::json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "models": {
                            "anthropic/claude-sonnet-4-6": {}
                        }
                    }
                }
            }
        });

        let patch = build_member_profile_provision_config_patch(
            &snapshot,
            "bootiful-wtf-4a58b3ae",
            true,
            Some("https://example.test/functions/v1/uniopc-cloud-workspace"),
            Some("imai_rt_token"),
            Some("2026-05-22T12:00:00.000Z"),
            Some("main"),
            Some("socks5h://127.0.0.1:7890"),
            Some("/Users/example/.openclaw/bin:/usr/bin"),
        );
        let models = patch
            .pointer("/agents/defaults/models")
            .and_then(Value::as_object)
            .expect("patch should include model allowlist");

        assert!(models.contains_key("anthropic/claude-sonnet-4-6"));
        assert!(models.contains_key(OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL));
        assert_eq!(
            patch.pointer("/agents/defaults/model/primary"),
            Some(&Value::String(
                OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL.to_string()
            ))
        );
        // 官方 provider 尚未连接（快照里不存在）时，不得凭空写出一个缺少
        // baseUrl/apiKey 的 provider 条目；凭据由官方模型连接流程负责。
        assert_eq!(patch.pointer("/models"), None);
        assert_eq!(
            patch.pointer("/discovery/mdns/mode"),
            Some(&Value::String("off".to_string()))
        );
        assert_eq!(
            patch.pointer("/plugins/entries/bonjour/enabled"),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            patch.pointer(&format!(
                "/plugins/entries/{}/enabled",
                openclaw_system_plugins::IMAI_CLOUD_WORKSPACE_PLUGIN_ID
            )),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            patch.pointer(&format!(
                "/plugins/entries/{}/enabled",
                openclaw_system_plugins::UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID
            )),
            Some(&Value::Bool(true)),
            "the bundled static plugin must be registered before the Gateway child starts"
        );
        // Plugin placement is owned by `openclaw plugins install`; the
        // provision patch must not write plugins.load.paths.
        assert_eq!(patch.pointer("/plugins/load/paths"), None);
        assert!(!patch.to_string().contains("gpt-5.5"));
        assert_eq!(
            patch.pointer("/env/vars/IMAI_OPENCLAW_PROFILE"),
            Some(&Value::String("bootiful-wtf-4a58b3ae".to_string()))
        );
        assert_eq!(
            patch.pointer("/env/vars/IMAI_AGENT_ID"),
            Some(&Value::String("main".to_string()))
        );
        assert_eq!(
            patch.pointer("/env/vars/UNIOPC_CLOUD_WORKSPACE_API_URL"),
            Some(&Value::String(
                "https://example.test/functions/v1/uniopc-cloud-workspace".to_string()
            ))
        );
        assert_eq!(
            patch.pointer("/env/vars/IMAI_CLOUD_AGENT_AUTH_TOKEN"),
            Some(&Value::String("imai_rt_token".to_string()))
        );
        assert_eq!(
            patch.pointer("/env/vars/IMAI_CLOUD_AGENT_TOKEN_EXPIRES_AT"),
            Some(&Value::String("2026-05-22T12:00:00.000Z".to_string()))
        );
        assert_eq!(
            patch.pointer("/env/vars/IMAI_CLOUD_AGENT_PROXY_URL"),
            Some(&Value::String("socks5h://127.0.0.1:7890".to_string()))
        );
        assert_eq!(
            patch.pointer("/env/vars/PATH"),
            Some(&Value::String(
                "/Users/example/.openclaw/bin:/usr/bin".to_string()
            ))
        );
    }

    #[test]
    fn pre_spawn_static_patch_contains_path_default_model_and_plugin_registration() {
        let patch =
            build_member_profile_static_startup_config_patch(&serde_json::json!({}), "profile-a");

        assert_eq!(
            patch.pointer("/agents/defaults/model/primary"),
            Some(&Value::String(
                OPENCLAW_UNIOPC_OFFICIAL_DEFAULT_MODEL.to_string()
            ))
        );
        assert!(patch
            .pointer("/env/vars/PATH")
            .and_then(Value::as_str)
            .is_some_and(|path| !path.trim().is_empty()));
        assert_eq!(
            patch.pointer(&format!(
                "/plugins/entries/{}/enabled",
                openclaw_system_plugins::UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID
            )),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn pre_spawn_static_patch_allows_enabled_system_plugin_tools_in_minimal_profile() {
        let patch = build_member_profile_static_startup_config_patch(
            &serde_json::json!({
                "tools": { "profile": "minimal", "alsoAllow": ["custom-tool"] },
                "plugins": {
                    "entries": {
                        "uniopc-superip": { "enabled": true },
                        "uniopc-montage": { "enabled": true },
                        "uniopc-socials": { "enabled": false }
                    }
                }
            }),
            "profile-a",
        );

        assert_eq!(
            patch.pointer("/tools/alsoAllow"),
            Some(&serde_json::json!([
                "custom-tool",
                "uniopc-local-workspace",
                "uniopc-montage",
                "uniopc-superip",
                "browser"
            ]))
        );
    }

    #[test]
    fn gateway_superip_media_output_uses_the_profile_media_root() {
        let env = gateway_superip_media_env(Some("profile-a"));
        assert_eq!(env.len(), 1);
        assert_eq!(env[0].0, "UNIOPC_SUPERIP_MEDIA_DIR");
        assert!(env[0].1.ends_with("state-v8/uniopc-2026_8_1/profile-a/media"));
    }

    #[test]
    fn pre_spawn_static_patch_preserves_an_existing_employee_model_selection() {
        let patch = build_member_profile_static_startup_config_patch(
            &serde_json::json!({
                "agents": {
                    "defaults": {
                        "model": { "primary": "anthropic/claude-sonnet-4-6" },
                        "models": { "anthropic/claude-sonnet-4-6": {} }
                    }
                }
            }),
            "profile-a",
        );

        assert_eq!(
            patch.pointer("/agents/defaults/model/primary"),
            Some(&Value::String("anthropic/claude-sonnet-4-6".to_string()))
        );
    }

    #[test]
    fn post_ready_patch_excludes_restart_causing_startup_fields() {
        let patch = build_member_profile_hot_reload_config_patch(
            &serde_json::json!({
                "tools": { "alsoAllow": ["custom-tool", "uniopc-local-workspace"] }
            }),
            "profile-a",
            Some("https://workspace.example.test"),
            Some("secret"),
            None,
            Some("main"),
            Some("socks5h://127.0.0.1:7890"),
        );

        assert_eq!(patch.pointer("/agents/defaults/model/primary"), None);
        assert_eq!(patch.pointer("/tools"), None, "hot reload must preserve existing tool grants");
        assert_eq!(patch.pointer("/env/vars/PATH"), None);
        assert_eq!(
            patch.pointer(&format!(
                "/plugins/entries/{}/enabled",
                openclaw_system_plugins::UNIOPC_LOCAL_WORKSPACE_PLUGIN_ID
            )),
            None
        );
        assert_eq!(
            patch.pointer(&format!(
                "/plugins/entries/{}/enabled",
                openclaw_system_plugins::IMAI_CLOUD_WORKSPACE_PLUGIN_ID
            )),
            None
        );
        assert_eq!(patch.pointer("/plugins/entries/bonjour/enabled"), None);
        assert_eq!(
            patch.pointer("/env/vars/UNIOPC_CLOUD_WORKSPACE_API_URL"),
            None
        );
    }

    #[test]
    fn post_ready_call_chain_only_applies_the_hot_patch() {
        let source = include_str!("mod.rs");
        let start = source
            .find("pub(crate) fn startup_defaults_delta")
            .expect("post-ready defaults");
        let end = source[start..]
            .find("fn backup_file")
            .map(|offset| start + offset)
            .expect("next helper");
        let call_chain = &source[start..end];

        assert!(call_chain.contains("build_member_profile_hot_reload_config_patch"));
        assert!(!call_chain.contains("build_member_profile_provision_config_patch"));
        assert!(!call_chain.contains("prepare_system_plugins_before_gateway_spawn"));
        assert!(!call_chain.contains("GatewaySupervisor"));
    }

    #[test]
    fn member_profile_provision_refreshes_official_provider_registration_when_connected() {
        let snapshot = serde_json::json!({
            "parsed": {
                "models": {
                    "providers": {
                        "uniopc-official": {
                            "baseUrl": "https://proxy.example.com/v1",
                            "api": "openai-completions",
                            "apiKey": "sk-test",
                            "models": [
                                { "id": "uniopc-default", "name": "Uniopc-Default", "input": ["text"] }
                            ]
                        }
                    }
                }
            }
        });

        let patch = build_member_profile_provision_config_patch(
            &snapshot,
            "bootiful-wtf-4a58b3ae",
            true,
            None,
            None,
            None,
            None,
            None,
            None,
        );

        // 已连接过官方模型的成员档案：注册条目被刷新，补上 image 能力声明。
        assert_eq!(
            patch.pointer("/models/providers/uniopc-official/models/0/input"),
            Some(&serde_json::json!(["text", "image"]))
        );
    }

    #[test]
    fn profile_provision_does_not_copy_model_auth_between_profiles() {
        let source = include_str!("mod.rs");
        let start = source
            .find("async fn openclaw_profile_provision_impl")
            .expect("profile provision function");
        let end = source[start..]
            .find("async fn openclaw_profile_status_impl")
            .map(|offset| start + offset)
            .expect("next command");
        let profile_provision = &source[start..end];

        assert!(!profile_provision.contains("sync_member_profile_codex_auth_from_owner"));
        assert!(!profile_provision.contains("auth_sync_output"));
    }

    #[test]
    fn profile_isolation_config_disables_local_discovery_without_touching_plugins() {
        let mut config = serde_json::json!({
            "gateway": {
                "port": 19263
            },
            "plugins": {
                "entries": {
                    "uniopc-cloud-workspace": {
                        "enabled": true
                    }
                }
            }
        });

        assert!(apply_openclaw_profile_isolation_config(&mut config));
        assert_eq!(
            config.pointer("/discovery/mdns/mode"),
            Some(&Value::String("off".to_string()))
        );
        assert_eq!(
            config.pointer("/plugins/entries/bonjour/enabled"),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            config.pointer("/plugins/entries/uniopc-cloud-workspace/enabled"),
            Some(&Value::Bool(true))
        );
        assert!(!apply_openclaw_profile_isolation_config(&mut config));
    }

    #[test]
    fn local_profile_gateway_config_overrides_remote_mode() {
        let mut config = serde_json::json!({
            "gateway": {
                "mode": "remote",
                "bind": "tailnet",
                "port": 18790,
                "remote": {
                    "transport": "ssh",
                    "url": "ws://127.0.0.1:18789"
                }
            }
        });

        assert!(apply_local_profile_gateway_config(
            &mut config,
            19279,
            false
        ));
        assert_eq!(
            config.pointer("/gateway/mode"),
            Some(&Value::String("local".to_string()))
        );
        assert_eq!(
            config.pointer("/gateway/bind"),
            Some(&Value::String("loopback".to_string()))
        );
        assert_eq!(
            config.pointer("/gateway/port"),
            Some(&Value::Number(serde_json::Number::from(19279)))
        );
        assert!(config.pointer("/gateway/remote").is_none());
        assert_eq!(
            config.pointer("/discovery/mdns/mode"),
            Some(&Value::String("off".to_string()))
        );
        assert_eq!(
            config.pointer("/plugins/entries/bonjour/enabled"),
            Some(&Value::Bool(false))
        );
        assert!(!apply_local_profile_gateway_config(
            &mut config,
            19279,
            false
        ));
    }

    #[test]
    fn local_profile_gateway_config_allows_lan_bind_when_opted_in() {
        let mut config = serde_json::json!({ "gateway": { "bind": "loopback" } });
        assert!(apply_local_profile_gateway_config(&mut config, 19279, true));
        assert_eq!(
            config.pointer("/gateway/bind"),
            Some(&Value::String("lan".to_string()))
        );
        assert_eq!(
            config.pointer("/gateway/mode"),
            Some(&Value::String("local".to_string()))
        );
    }

    #[test]
    fn profile_provision_leaves_gateway_lifecycle_and_rpcs_to_coordinator() {
        let source = include_str!("mod.rs");
        let provision = source.split("async fn openclaw_profile_provision_impl(").nth(1).unwrap()
            .split("async fn openclaw_profile_status_impl(").next().unwrap();
        assert!(provision.contains("openclaw_output_for_profile"));
        assert!(provision.contains("ensure_profile_local_discovery_disabled"));
        for forbidden in [".ensure_running", ".restart(", "wait_for_openclaw", "config_get(", "config_patch("] {
            assert!(!provision.contains(forbidden), "provision must not own {forbidden}");
        }
    }

    #[test]
    fn profile_initialization_requires_meaningful_agent_defaults() {
        assert!(!openclaw_profile_config_is_initialized(&serde_json::json!(
            {}
        )));
        assert!(!openclaw_profile_config_is_initialized(
            &serde_json::json!({
                "gateway": { "mode": "local", "port": 28790 }
            })
        ));
        assert!(!openclaw_profile_config_is_initialized(
            &serde_json::json!({
                "agents": { "defaults": {} }
            })
        ));
        assert!(openclaw_profile_config_is_initialized(&serde_json::json!({
            "agents": { "defaults": { "model": { "primary": "uniopc-official/qwen-3.7" } } }
        })));
        assert!(openclaw_profile_config_is_initialized(&serde_json::json!({
            "agents": { "defaults": { "workspace": "/tmp/uniopc-workspace" } }
        })));
    }

    #[test]
    fn partial_profile_is_repaired_by_onboard_instead_of_existing_recovery() {
        let source = include_str!("mod.rs");
        let start = source
            .find("async fn openclaw_profile_provision_impl")
            .expect("profile provision function");
        let end = source[start..]
            .find("async fn openclaw_profile_status_impl")
            .map(|offset| start + offset)
            .expect("next command");
        let profile_provision = &source[start..end];

        assert!(profile_provision.contains("openclaw_profile_config_is_initialized"));
        assert!(!profile_provision.contains("if config_path.exists()"));
    }

    #[test]
    fn local_startup_has_one_spawn_owner_and_common_postconditions() {
        let source = include_str!("../../services/startup_readiness.rs");
        let startup = source.split("pub async fn start<B: GatewayActivation>(").nth(1).unwrap()
            .split("/// Dropping the future").next().unwrap();
        assert_eq!(startup.matches("b.spawn()").count(), 1);
        assert_eq!(startup.matches("finalize(b,").count(), 1);
        assert!(!startup.contains("return Ok("), "warm and retry paths must not skip postconditions");
    }

    #[test]
    fn gateway_status_accepts_healthy_service_when_rpc_probe_is_blocked() {
        let output = r#"{
  "service": {
    "runtime": {
      "status": "running",
      "state": "active",
      "pid": 82570
    }
  },
  "gateway": {
    "probeUrl": "ws://127.0.0.1:18790"
  },
  "port": {
    "status": "busy",
    "listeners": [
      {
        "pid": 82570,
        "command": "node",
        "address": "127.0.0.1:18790"
      }
    ]
  },
  "rpc": {
    "ok": false,
    "error": "connect EPERM 127.0.0.1:18790 - Local (0.0.0.0:0)"
  },
  "health": {
    "healthy": true,
    "staleGatewayPids": []
  }
}"#;

        let status = parse_openclaw_gateway_status(output, true);

        assert!(status.running);
        assert!(!status.rpc_ok);
        assert!(status.health_ok);
        assert!(gateway_is_ready_for_app(&status));
    }

    #[test]
    fn gateway_status_parses_gateway_identity_fields() {
        let output = r#"{
  "running": true,
  "rpc": { "ok": true },
  "gateway": {
    "deviceId": "device-123",
    "publicKey": "public-key-abc"
  }
}"#;

        let status = parse_openclaw_gateway_status(output, true);

        assert_eq!(status.device_id.as_deref(), Some("device-123"));
        assert_eq!(status.public_key.as_deref(), Some("public-key-abc"));
    }

    #[test]
    fn gateway_status_accepts_profile_read_only_rpc() {
        let output = r#"{
  "service": {
    "runtime": {
      "status": "running",
      "state": "active",
      "pid": 10649
    }
  },
  "gateway": {
    "probeUrl": "ws://127.0.0.1:19263"
  },
  "rpc": {
    "ok": true,
    "kind": "connect",
    "capability": "read_only",
    "url": "ws://127.0.0.1:19263"
  }
}"#;

        let status = parse_openclaw_gateway_status(output, true);

        assert!(status.running);
        assert!(status.rpc_ok);
        assert_eq!(status.ws_url, "ws://127.0.0.1:19263");
        assert_eq!(
            gateway_urls_from_probe(
                profile_gateway_urls_for_mode("bootiful-wtf-4a58b3ae", None, false),
                &status
            ),
            (
                19263,
                "ws://127.0.0.1:19263".to_string(),
                "http://127.0.0.1:19263/".to_string(),
            )
        );
        assert!(gateway_is_ready_for_app(&status));
    }

    #[test]
    fn member_profile_gateway_port_is_stable_and_avoids_owner_default_port() {
        let first = default_gateway_port_for_profile("eurisblue-6ccfa8c9");
        let second = default_gateway_port_for_profile("eurisblue-6ccfa8c9");

        assert_eq!(first, second);
        // Singleton engine: before an engine binds a port, every profile resolves
        // to the stable preferred port — chosen clear of OpenClaw's own default
        // (18789). Once an engine binds, `local_gateway_port()` returns whatever
        // it actually got (preferred, or a free fallback).
        assert_eq!(
            first,
            crate::services::openclaw_connection::UNIOPC_ENGINE_PREFERRED_PORT
        );
        assert_ne!(
            first, 18789,
            "must not collide with OpenClaw's default port"
        );
        assert_eq!(
            default_gateway_port_for_profile("imai"),
            crate::services::openclaw_connection::UNIOPC_ENGINE_PREFERRED_PORT
        );
        assert_eq!(
            first,
            crate::services::openclaw_connection::local_gateway_port_for_profile(
                "eurisblue-6ccfa8c9"
            )
        );
    }

    #[test]
    fn profile_handle_validation_rejects_unsafe_cli_values() {
        assert_eq!(
            validate_openclaw_profile_handle(" eurisblue-6ccfa8c9 ").as_deref(),
            Ok("eurisblue-6ccfa8c9")
        );
        assert!(validate_openclaw_profile_handle("").is_err());
        assert!(validate_openclaw_profile_handle("../imai").is_err());
        assert!(validate_openclaw_profile_handle("euris blue").is_err());
    }

    #[test]
    fn profile_gateway_url_uses_explicit_or_stable_default_port() {
        assert_eq!(
            profile_gateway_urls_for_mode("eurisblue-6ccfa8c9", Some(19001), false),
            (
                19001,
                "ws://127.0.0.1:19001".to_string(),
                "http://127.0.0.1:19001/".to_string()
            )
        );

        let (port, ws_url, dashboard_url) =
            profile_gateway_urls_for_mode("eurisblue-6ccfa8c9", None, false);
        assert_eq!(port, default_gateway_port_for_profile("eurisblue-6ccfa8c9"));
        assert_eq!(ws_url, format!("ws://127.0.0.1:{port}"));
        assert_eq!(dashboard_url, format!("http://127.0.0.1:{port}/"));
    }

    #[test]
    fn owner_profile_gateway_url_ignores_legacy_singleton_cloud_port() {
        let profile = "lanjinyu01-32bb573f";
        let expected_port = default_gateway_port_for_profile(profile);

        assert_eq!(
            profile_gateway_urls_for_mode(profile, Some(18789), false),
            (
                expected_port,
                format!("ws://127.0.0.1:{expected_port}"),
                format!("http://127.0.0.1:{expected_port}/")
            )
        );
    }

    #[test]
    fn configured_gateway_url_overrides_stale_cloud_port_for_existing_profile() {
        let fallback = profile_gateway_urls_for_mode("bootiful-wtf-4a58b3ae", Some(18790), false);
        let metadata = openclaw_gateway::GatewayConfigMetadata {
            ws_url: "ws://127.0.0.1:19263".to_string(),
            auth_mode: "token".to_string(),
            has_token: true,
            has_password: false,
        };

        assert_eq!(
            apply_configured_gateway_url_for_profile(fallback, &metadata, false),
            (
                19263,
                "ws://127.0.0.1:19263".to_string(),
                "http://127.0.0.1:19263/".to_string()
            )
        );
    }

    #[test]
    fn owner_profile_gateway_url_ignores_legacy_singleton_config_metadata() {
        let profile = "lanjinyu01-32bb573f";
        let fallback = profile_gateway_urls_for_mode(profile, None, false);
        let expected_port = default_gateway_port_for_profile(profile);
        let metadata = openclaw_gateway::GatewayConfigMetadata {
            ws_url: "ws://127.0.0.1:18789".to_string(),
            auth_mode: "token".to_string(),
            has_token: true,
            has_password: false,
        };

        assert_eq!(
            apply_configured_gateway_url_for_profile(fallback, &metadata, false),
            (
                expected_port,
                format!("ws://127.0.0.1:{expected_port}"),
                format!("http://127.0.0.1:{expected_port}/")
            )
        );
    }

    #[test]
    fn managed_member_profile_gateway_url_ignores_stale_owner_port_metadata() {
        let profile = "eurisblue-6ccfa8c9";
        let fallback = profile_gateway_urls_for_mode(profile, None, true);
        let expected_port = default_gateway_port_for_profile(profile);
        let metadata = openclaw_gateway::GatewayConfigMetadata {
            ws_url: "ws://127.0.0.1:18790".to_string(),
            auth_mode: "token".to_string(),
            has_token: true,
            has_password: false,
        };

        assert_eq!(
            apply_configured_gateway_url_for_profile(fallback, &metadata, true),
            (
                expected_port,
                format!("ws://127.0.0.1:{expected_port}"),
                format!("http://127.0.0.1:{expected_port}/")
            )
        );
    }

    #[test]
    fn gateway_status_detects_blocked_rpc_connection() {
        let output = r#"{
  "service": {
    "runtime": {
      "status": "running",
      "state": "active",
      "pid": 40828
    }
  },
  "port": {
    "hints": ["Another process is listening on this port."]
  },
  "rpc": {
    "ok": false,
    "error": "connect EPERM 127.0.0.1:18790 - Local (0.0.0.0:0)"
  }
}"#;

        let status = parse_openclaw_gateway_status(output, true);

        assert!(status.running);
        assert!(status.rpc_blocked);
        assert!(!gateway_is_ready_for_app(&status));
    }

    #[test]
    fn gateway_supervisor_rejects_an_unverified_runtime() {
        assert_eq!(
            require_verified_openclaw_runtime(false).unwrap_err(),
            "OpenClaw 8.1 运行时未验证。"
        );
        assert!(require_verified_openclaw_runtime(true).is_ok());
    }

    #[test]
    fn strips_legacy_assistant_attachment_blocks_from_transcript_events() {
        let mut event = serde_json::json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "已生成文件。" },
                    { "type": "attachment", "attachment": { "name": "report.pdf" } }
                ]
            }
        });

        assert!(strip_openclaw_assistant_attachment_blocks(&mut event));
        assert_eq!(
            event.pointer("/message/content"),
            Some(&serde_json::json!([{ "type": "text", "text": "已生成文件。" }]))
        );
    }

    #[test]
    fn strips_assistant_video_blocks_but_keeps_delivery_metadata() {
        let mut event = serde_json::json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "视频已经生成。" },
                    { "type": "video", "url": "file:///tmp/video.mp4", "fileName": "video.mp4" }
                ],
                "openclawDelivery": {
                    "mediaUrls": ["/tmp/video.mp4"]
                }
            }
        });

        assert!(strip_openclaw_assistant_attachment_blocks(&mut event));
        assert_eq!(
            event.pointer("/message/content"),
            Some(&serde_json::json!([{ "type": "text", "text": "视频已经生成。" }]))
        );
        assert_eq!(
            event.pointer("/message/openclawDelivery/mediaUrls/0"),
            Some(&serde_json::json!("/tmp/video.mp4"))
        );
    }
}

#[cfg(all(test, windows))]
mod gateway_startup_windows_tests {
    use super::*;
    const FIXTURE: &str =
        "commands::model::gateway_startup_windows_tests::contained_descendant_fixture";
    #[test]
    fn contained_descendant_fixture() {
        let Ok(path) = std::env::var("UNIOPC_STARTUP_JOB_FIXTURE") else {
            return;
        };
        use windows_sys::Win32::System::{
            JobObjects::IsProcessInJob, Threading::GetCurrentProcess,
        };
        let mut in_job = 0;
        assert_ne!(
            unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) },
            0
        );
        assert_ne!(
            in_job, 0,
            "engine descendant ran before Job Object containment"
        );
        let path = PathBuf::from(path);
        fs::write(path.with_extension("ready"), std::process::id().to_string()).unwrap();
        for _ in 0..1500 {
            if path.with_extension("go").exists() {
                fs::write(&path, "descendant escaped").unwrap();
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    #[tokio::test]
    async fn windows_gateway_job_precedes_engine_descendant_and_termination_blocks_writes() {
        let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join("node.exe"))
            .find(|path| path.is_file())
            .expect("Windows candidate CI must provide Node");
        let dir = std::env::temp_dir().join(format!("uniopc-startup-job-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let preload = dir.join("startup.cjs");
        fs::write(
            &preload,
            include_str!("../../services/gateway_startup_progress.cjs"),
        )
        .unwrap();
        let hostile = dir.join("hostile.cjs");
        let hostile_marker = dir.join("hostile-ran");
        fs::write(
            &hostile,
            format!(
                "require('node:fs').writeFileSync({},'bad')",
                serde_json::to_string(&hostile_marker.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let markers: Vec<_> = (0..5)
            .map(|branch| dir.join(format!("escaped-{branch}")))
            .collect();
        let body = dir.join("body.cjs");
        let worker = dir.join("worker.cjs");
        let fork = dir.join("fork.cjs");
        let topology = dir.join("topology.ready");
        // Exercise a case alias in the real FrozenLaunch/ACK/held-job path.
        let startup_argument = preload.to_string_lossy().to_uppercase();
        let common = r#"
            const assert=require('node:assert/strict');
            assert.deepEqual(process.execArgv,['--trace-warnings']);
            function leaf(data,send){
              const child=require('node:child_process').spawn(data.executable,
                ['--exact',data.fixture,'--nocapture'],{stdio:'inherit',
                  env:{...process.env,UNIOPC_STARTUP_JOB_FIXTURE:data.marker}});
              child.on('error',()=>process.exit(1));
              child.on('spawn',()=>send({leafPid:child.pid}));
              child.on('exit',code=>process.exit(code||0));
            }
            function forkChild(data,send){
              const child=require('node:child_process').fork(data.fork,[JSON.stringify({...data,mode:'leaf'})],
                {stdio:['ignore','ignore','inherit','ipc']});
              child.on('error',()=>process.exit(1));child.on('message',send);
              child.on('exit',code=>process.exit(code||0));
            }
        "#;
        fs::write(&worker, common.to_string() + r#"
            const {parentPort,workerData:data,Worker}=require('node:worker_threads');
            const send=value=>parentPort.postMessage(value);
            if(data.mode==='probe')send(process.execArgv);
            else if(data.mode==='nested'){
              const w=new Worker(data.worker,{workerData:{...data,mode:'fork'}});
              w.on('message',send);w.on('error',()=>process.exit(1));w.on('exit',code=>process.exit(code||0));
            }else if(data.mode==='fork')forkChild(data,send);
            else leaf(data,send);
        "#).unwrap();
        fs::write(&fork, common.to_string() + r#"
            const data=JSON.parse(process.argv[2]);
            const send=value=>process.send({...value,forkPid:process.pid});
            if(data.mode==='worker'){
              const w=new (require('node:worker_threads').Worker)(data.worker,{workerData:{...data,mode:'leaf'}});
              w.on('message',send);w.on('error',()=>process.exit(1));w.on('exit',code=>process.exit(code||0));
            }else leaf(data,send);
        "#).unwrap();
        let context = serde_json::json!({"worker": worker, "fork": fork, "topology": topology,
            "preload": preload, "markers": markers, "executable": std::env::current_exe().unwrap(), "fixture": FIXTURE});
        fs::write(&body, format!("const context={context};\n") + r#"
            const assert=require('node:assert/strict');
            const {Worker}=require('node:worker_threads');
            const handles=[];
            function worker(data,explicit=false,probe=false){return new Promise((resolve,reject)=>{
              const options={workerData:data};
              if(explicit)options.execArgv=['--trace-warnings','--require',context.preload];
              const w=new Worker(context.worker,options);handles.push(w);
              let result;w.on('message',value=>{result=value;if(!probe)resolve(value)});w.on('error',reject);
              w.on('exit',code=>code?reject(new Error('worker exit '+code)):probe&&resolve(result));
            });}
            function fork(data){return new Promise((resolve,reject)=>{
              const child=require('node:child_process').fork(context.fork,[JSON.stringify(data)],
                {stdio:['ignore','ignore','inherit','ipc']});handles.push(child);
              child.on('message',resolve);child.on('error',reject);
              child.on('exit',code=>reject(new Error('fork exited '+code)));
            });}
            (async()=>{
              assert.deepEqual(process.execArgv,['--trace-warnings']);
              assert.equal(process.env.NODE_OPTIONS,undefined);
              assert.deepEqual(await worker({mode:'probe'},false,true),['--trace-warnings']);
              assert.deepEqual(await worker({mode:'probe'},true,true),['--trace-warnings']);
              const branches=[];
              for(let index=0;index<5;index++){
                const data={...context,marker:context.markers[index],mode:index===0?'worker':index<3?'fork':'nested'};
                branches.push(await(index===0?fork(data):worker(data,index===2||index===4)));
              }
              require('node:fs').writeFileSync(context.topology,JSON.stringify({rootPid:process.pid,branches}));
            })().catch(error=>{console.error(error);process.exit(1)});
        "#).unwrap();
        let mut env: BTreeMap<_, _> = std::env::vars_os().collect();
        env.insert(
            "NODE_OPTIONS".into(),
            format!(
                "--require {}",
                serde_json::to_string(&hostile.to_string_lossy()).unwrap()
            )
            .into(),
        );
        let launch = FrozenGatewayLaunch {
            program: node.into_os_string(),
            args: vec![
                "--require".into(),
                startup_argument.into(),
                "--trace-warnings".into(),
                body.into_os_string(),
            ],
            env,
            directory: None,
            log_path: None,
            port: 1234,
            config_identity: None,
        };
        let mut child = launch
            .spawn(Some("fixture".into()), "fixture".into(), 0, 1)
            .await
            .unwrap();
        for _ in 0..1000 {
            if markers
                .iter()
                .all(|marker| marker.with_extension("ready").exists())
                && topology.exists()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            markers.iter().all(|marker| marker.with_extension("ready").exists()) && topology.exists(),
            "default/explicit Worker, fork, Worker-to-fork or nested Worker-to-fork did not execute"
        );
        assert!(
            !hostile_marker.exists(),
            "inherited NODE_OPTIONS ran before the gate"
        );
        // Check the exact held job, not merely any enclosing CI runner job.
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::{
                JobObjects::IsProcessInJob,
                Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
            },
        };
        let topology: serde_json::Value =
            serde_json::from_slice(&fs::read(&topology).unwrap()).unwrap();
        let root_pid = topology["rootPid"].as_u64().unwrap() as u32;
        assert_eq!(Some(root_pid), child.process.id());
        let mut pids = vec![root_pid];
        let branches = topology["branches"].as_array().unwrap();
        assert_eq!(branches.len(), markers.len());
        for (branch, marker) in branches.iter().zip(&markers) {
            let leaf_pid = fs::read_to_string(marker.with_extension("ready"))
                .unwrap()
                .parse::<u32>()
                .unwrap();
            assert_eq!(branch["leafPid"].as_u64().unwrap() as u32, leaf_pid);
            pids.push(leaf_pid);
            pids.push(branch["forkPid"].as_u64().unwrap() as u32);
        }
        for pid in pids {
            let descendant = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            assert!(!descendant.is_null(), "descendant {pid} disappeared");
            let mut member = 0;
            let queried =
                unsafe { IsProcessInJob(descendant, child.job.as_raw_handle(), &mut member) };
            unsafe {
                CloseHandle(descendant);
            }
            assert_ne!(queried, 0);
            assert_ne!(
                member, 0,
                "descendant {pid} was created outside the exact held job"
            );
        }
        crate::services::owned_command::terminate_job(&child.job, &mut child.process)
            .await
            .unwrap();
        for marker in &markers {
            fs::write(marker.with_extension("go"), "go").unwrap();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            markers.iter().all(|marker| !marker.exists()),
            "terminated descendant wrote after zero-member proof"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn changed_config_blocks_frozen_replacement_before_engine_execution() {
        let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join("node.exe"))
            .find(|path| path.is_file())
            .expect("Windows candidate CI must provide Node");
        let dir =
            std::env::temp_dir().join(format!("uniopc-frozen-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.json");
        std::fs::write(&config, b"original").unwrap();
        let marker = dir.join("body-ran");
        let launch = FrozenGatewayLaunch {
            program: node.into_os_string(),
            args: vec![
                "-e".into(),
                format!(
                    "require('node:fs').writeFileSync({},'bad')",
                    serde_json::to_string(&marker.to_string_lossy()).unwrap()
                )
                .into(),
            ],
            env: std::env::vars_os().collect(),
            directory: None,
            log_path: None,
            port: 1234,
            config_identity: Some(
                crate::services::gateway_startup_progress::ConfigIdentity::capture(config.clone())
                    .unwrap(),
            ),
        };
        std::fs::write(&config, b"changed").unwrap();
        assert_eq!(
            launch
                .spawn(Some("fixture".into()), "runtime".into(), 1, 1)
                .await
                .err()
                .unwrap(),
            "gateway_startup_config_changed"
        );
        assert!(!marker.exists());
        assert_eq!(std::fs::read(&config).unwrap(), b"changed");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn windows_frozen_environment_merges_path_and_removes_keys_case_insensitively() {
        let mut source = std::process::Command::new("node.exe");
        source
            .env("PATH", "explicit-bundled-path")
            .env_remove("rEmOvE_mE");
        let env = capture_gateway_environment(
            &source,
            [
                ("Path".into(), "inherited-path".into()),
                ("NODE_options".into(), "hostile".into()),
                ("REMOVE_ME".into(), "old".into()),
            ],
        );
        let paths: Vec<_> = env
            .iter()
            .filter(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case("PATH"))
            .collect();
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].1, "explicit-bundled-path");
        assert!(!env.keys().any(
            |key| key.to_string_lossy().eq_ignore_ascii_case("NODE_OPTIONS")
                || key.to_string_lossy().eq_ignore_ascii_case("REMOVE_ME")
        ));
    }

    #[tokio::test]
    async fn windows_gateway_assignment_and_ack_failures_never_release_engine_body() {
        let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join("node.exe"))
            .find(|path| path.is_file())
            .expect("Windows candidate CI must provide Node");
        for missing_pipe in [false, true] {
            let dir =
                std::env::temp_dir().join(format!("uniopc-gate-fail-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            let preload = dir.join("startup.cjs");
            fs::write(
                &preload,
                include_str!("../../services/gateway_startup_progress.cjs"),
            )
            .unwrap();
            let marker = dir.join("body-ran");
            let body = format!(
                "require('node:fs').writeFileSync({},'bad')",
                serde_json::to_string(&marker.to_string_lossy()).unwrap()
            );
            let mut process = tokio::process::Command::new(&node)
                .args([
                    std::ffi::OsStr::new("--require"),
                    preload.as_os_str(),
                    std::ffi::OsStr::new("-e"),
                    std::ffi::OsStr::new(&body),
                ])
                .env_remove("NODE_OPTIONS")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(!marker.exists(), "engine body ran while ACK was withheld");
            let outcome = if missing_pipe {
                drop(process.stdin.take());
                crate::services::owned_command::gate_gateway_child(
                    &mut process,
                    crate::services::owned_command::process_job,
                )
                .await
            } else {
                crate::services::owned_command::gate_gateway_child(&mut process, |_| {
                    Err(std::io::Error::other("injected assignment failure"))
                })
                .await
            };
            assert!(outcome.is_err());
            assert!(
                process.id().is_none(),
                "failed gate must reap the direct child before returning"
            );
            assert!(
                !marker.exists(),
                "failed containment released the engine body"
            );
            fs::remove_dir_all(dir).unwrap();
        }
    }
    #[tokio::test]
    async fn windows_gateway_startup_pair_alias_duplicates_and_ambiguity_fail_closed() {
        let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join("node.exe"))
            .find(|path| path.is_file())
            .expect("Windows candidate CI must provide Node");
        let dir =
            std::env::temp_dir().join(format!("uniopc-preload-alias-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let preload = dir.join("startup.cjs");
        fs::write(
            &preload,
            include_str!("../../services/gateway_startup_progress.cjs"),
        )
        .unwrap();
        let hardlink = dir.join("startup-hardlink.cjs");
        fs::hard_link(&preload, &hardlink).unwrap();
        let original = preload.to_string_lossy().to_string();
        let marker = dir.join("body-ran");
        for args in [
            vec![
                "--require".to_string(),
                original.clone(),
                "--require".into(),
                original.to_uppercase(),
            ],
            vec![
                "--require".to_string(),
                original.clone(),
                "--require".into(),
                hardlink.to_string_lossy().to_string(),
            ],
            vec![format!("--require={original}")],
        ] {
            let mut args: Vec<std::ffi::OsString> = args.into_iter().map(Into::into).collect();
            args.extend([
                "-e".into(),
                format!(
                    "require('node:fs').writeFileSync({},'bad')",
                    serde_json::to_string(&marker.to_string_lossy()).unwrap()
                )
                .into(),
            ]);
            let launch = FrozenGatewayLaunch {
                program: node.clone().into_os_string(),
                args,
                env: std::env::vars_os().collect(),
                directory: None,
                log_path: None,
                port: 1234,
                config_identity: None,
            };
            let mut child = launch
                .spawn(Some("fixture".into()), "fixture".into(), 0, 1)
                .await
                .unwrap();
            let status = tokio::time::timeout(Duration::from_secs(5), child.process.wait())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(status.code(), Some(78));
            assert!(!marker.exists());
            crate::services::owned_command::terminate_job(&child.job, &mut child.process)
                .await
                .unwrap();
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
