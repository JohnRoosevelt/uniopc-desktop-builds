use crate::services::{openclaw_gateway, openclaw_runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::time::{sleep, Duration};

const MCP_CONFIG_PATCH_RECOVERY_ATTEMPTS: usize = 10;
const MCP_CONFIG_PATCH_RECOVERY_DELAY_MS: u64 = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawMcpServerRecord {
    pub name: String,
    pub transport: String,
    pub summary: String,
    pub config: Value,
    pub has_secrets: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawMcpServersSnapshot {
    pub profile: String,
    pub servers: Vec<OpenClawMcpServerRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawMcpServerSetRequest {
    pub profile: Option<String>,
    pub name: String,
    pub config: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawMcpServerUnsetRequest {
    pub profile: Option<String>,
    pub name: String,
}

fn normalize_profile(profile: Option<&str>) -> String {
    openclaw_runtime::normalize_profile_key(profile)
}

fn validate_server_name(name: &str) -> Result<String, String> {
    let value = name.trim();
    if value.is_empty() {
        return Err("MCP server 名称不能为空。".to_string());
    }
    if value.len() > 80 {
        return Err("MCP server 名称不能超过 80 个字符。".to_string());
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '@' | '/'))
    {
        return Err("MCP server 名称只能包含字母、数字、-、_、.、@ 或 /。".to_string());
    }
    Ok(value.to_string())
}

/// Basenames we refuse as a stdio MCP `command`. A shell interpreter as the
/// launched program turns `args: ["-c", "..."]` into arbitrary shell execution —
/// the most direct RCE gadget if this command is ever reached from injected
/// webview JS. This is defense-in-depth (a lenient block, not an allowlist):
/// node/npx/uvx/python-based MCP servers still work; only the classic
/// `sh -c` / `powershell -Command` shape is denied.
const BLOCKED_STDIO_COMMANDS: &[&str] = &[
    "sh", "bash", "zsh", "dash", "csh", "ksh", "fish", "ash", "cmd", "cmd.exe", "powershell",
    "powershell.exe", "pwsh", "pwsh.exe",
];

/// Validate a stdio MCP `command`. Lenient: rejects only control chars, `..`
/// path traversal, and shell interpreters — everything else (bare program names
/// resolved via PATH, absolute paths to real tools) is allowed.
fn validate_stdio_command(command: &str) -> Result<(), String> {
    if command.chars().any(|ch| ch.is_control()) {
        return Err("stdio MCP server command 不能包含控制字符。".to_string());
    }
    if command.split(['/', '\\']).any(|part| part == "..") {
        return Err("stdio MCP server command 不能包含 .. 路径。".to_string());
    }
    let basename = command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .trim()
        .to_ascii_lowercase();
    if BLOCKED_STDIO_COMMANDS.contains(&basename.as_str()) {
        return Err(
            "出于安全考虑，stdio MCP server command 不能是 shell 解释器（如 bash/sh/powershell）。请直接指向 MCP server 可执行文件。".to_string(),
        );
    }
    Ok(())
}

fn object_config(value: Value) -> Result<Map<String, Value>, String> {
    match value {
        Value::Object(object) => Ok(object),
        _ => Err("MCP server 配置必须是 JSON 对象。".to_string()),
    }
}

fn string_array(value: Option<&Value>, key: &str) -> Result<(), String> {
    if let Some(value) = value {
        let items = value
            .as_array()
            .ok_or_else(|| format!("MCP server `{key}` 必须是字符串数组。"))?;
        if items.iter().any(|item| !item.is_string()) {
            return Err(format!("MCP server `{key}` 必须是字符串数组。"));
        }
    }
    Ok(())
}

fn string_map(value: Option<&Value>, key: &str) -> Result<(), String> {
    if let Some(value) = value {
        let object = value
            .as_object()
            .ok_or_else(|| format!("MCP server `{key}` 必须是字符串对象。"))?;
        if object.values().any(|item| !item.is_string()) {
            return Err(format!("MCP server `{key}` 必须是字符串对象。"));
        }
    }
    Ok(())
}

fn validate_timeout(value: Option<&Value>) -> Result<(), String> {
    if let Some(value) = value {
        match value.as_u64() {
            Some(ms) if ms > 0 => Ok(()),
            _ => Err("MCP server `connectionTimeoutMs` 必须是正整数。".to_string()),
        }?;
    }
    Ok(())
}

fn inferred_transport(config: &Value) -> String {
    if config.get("command").and_then(Value::as_str).is_some() {
        return "stdio".to_string();
    }
    config
        .get("transport")
        .or_else(|| config.get("type"))
        .and_then(Value::as_str)
        .map(|value| {
            if value == "http" {
                "streamable-http".to_string()
            } else {
                value.to_string()
            }
        })
        .unwrap_or_else(|| "sse".to_string())
}

fn has_secret_values(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let lowered = key.to_ascii_lowercase();
            lowered.contains("token")
                || lowered.contains("secret")
                || lowered.contains("key")
                || lowered.contains("authorization")
                || has_secret_values(value)
        }),
        Value::Array(items) => items.iter().any(has_secret_values),
        Value::String(value) => {
            value.starts_with("Bearer ")
                || value
                    .to_ascii_lowercase()
                    .contains("authorization: bearer ")
        }
        _ => false,
    }
}

fn server_summary(config: &Value, transport: &str) -> String {
    if transport == "stdio" {
        let command = config
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("stdio");
        let args = config
            .get("args")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        return [command, args.as_str()]
            .into_iter()
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ");
    }
    config
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or(transport)
        .to_string()
}

fn normalize_server_record(name: &str, config: &Value) -> Result<OpenClawMcpServerRecord, String> {
    let name = validate_server_name(name)?;
    let transport = inferred_transport(config);
    Ok(OpenClawMcpServerRecord {
        name,
        summary: server_summary(config, &transport),
        transport,
        has_secrets: has_secret_values(config),
        config: config.clone(),
    })
}

fn normalize_set_request(
    req: OpenClawMcpServerSetRequest,
) -> Result<(String, String, Value), String> {
    let profile = normalize_profile(req.profile.as_deref());
    let name = validate_server_name(&req.name)?;
    let mut object = object_config(req.config)?;
    if object.get("type").and_then(Value::as_str) == Some("http") {
        object.remove("type");
        object.insert(
            "transport".to_string(),
            Value::String("streamable-http".to_string()),
        );
    }
    let config = Value::Object(object);
    let transport = inferred_transport(&config);
    if transport == "stdio" {
        let command = config
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "stdio MCP server 需要 command。".to_string())?;
        validate_stdio_command(command)?;
        string_array(config.get("args"), "args")?;
        string_map(config.get("env"), "env")?;
    } else {
        config
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "远程 MCP server 需要 url。".to_string())?;
        string_map(config.get("headers"), "headers")?;
        validate_timeout(config.get("connectionTimeoutMs"))?;
    }
    Ok((profile, name, config))
}

fn build_servers_patch(servers: &Value, name: &str, config: Value) -> Result<Value, String> {
    let mut object = servers.as_object().cloned().unwrap_or_default();
    object.insert(validate_server_name(name)?, config);
    Ok(json!({ "mcp": { "servers": Value::Object(object) } }))
}

fn build_unset_patch(servers: &Value, name: &str) -> Result<Value, String> {
    let mut object = servers.as_object().cloned().unwrap_or_default();
    let name = validate_server_name(name)?;
    if !object.contains_key(&name) {
        return Err(format!("MCP server `{name}` 不存在。"));
    }
    // Gateway config.patch follows JSON Merge Patch semantics. Omitting an
    // object key only leaves its current value untouched; an explicit null is
    // the deletion marker.
    object.insert(name, Value::Null);
    Ok(json!({ "mcp": { "servers": Value::Object(object) } }))
}

fn servers_from_snapshot(snapshot: &Value) -> Value {
    snapshot
        .get("parsed")
        .or_else(|| snapshot.get("sourceConfig"))
        .or_else(|| snapshot.get("config"))
        .or_else(|| snapshot.get("runtimeConfig"))
        .or_else(|| snapshot.get("resolved"))
        .and_then(|root| root.get("mcp"))
        .and_then(|mcp| mcp.get("servers"))
        .cloned()
        .or_else(|| {
            snapshot
                .get("mcp")
                .and_then(|mcp| mcp.get("servers"))
                .cloned()
        })
        .unwrap_or_else(|| json!({}))
}

fn sorted_records(servers: &Value) -> Result<Vec<OpenClawMcpServerRecord>, String> {
    let object = servers
        .as_object()
        .ok_or_else(|| "Uniopc 引擎 MCP servers 配置格式无效。".to_string())?;
    let mut records = object
        .iter()
        .map(|(name, config)| normalize_server_record(name, config))
        .collect::<Result<Vec<_>, _>>()?;
    records.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(records)
}

fn snapshot_from_servers(
    profile: String,
    servers: &Value,
) -> Result<OpenClawMcpServersSnapshot, String> {
    Ok(OpenClawMcpServersSnapshot {
        profile,
        servers: sorted_records(servers)?,
    })
}

fn server_config_matches(servers: &Value, name: &str, expected: &Value) -> bool {
    servers
        .get(name)
        .map(|actual| actual == expected)
        .unwrap_or(false)
}

fn server_is_missing(servers: &Value, name: &str) -> bool {
    servers.get(name).is_none()
}

async fn recover_servers_after_patch<F>(
    profile: &str,
    mut is_expected_state: F,
) -> Result<Option<Value>, String>
where
    F: FnMut(&Value) -> bool,
{
    let mut last_read_error = None;
    for attempt in 0..MCP_CONFIG_PATCH_RECOVERY_ATTEMPTS {
        match openclaw_gateway::config_get(Some(profile)).await {
            Ok(snapshot) => {
                let servers = servers_from_snapshot(&snapshot);
                if is_expected_state(&servers) {
                    return Ok(Some(servers));
                }
                last_read_error = None;
            }
            Err(error) => {
                last_read_error = Some(error);
            }
        }
        if attempt + 1 < MCP_CONFIG_PATCH_RECOVERY_ATTEMPTS {
            sleep(Duration::from_millis(MCP_CONFIG_PATCH_RECOVERY_DELAY_MS)).await;
        }
    }

    match last_read_error {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn openclaw_mcp_servers_list(
    profile: Option<String>,
) -> Result<OpenClawMcpServersSnapshot, String> {
    let profile_key = normalize_profile(profile.as_deref());
    let snapshot = openclaw_gateway::config_get(Some(&profile_key)).await?;
    let servers = servers_from_snapshot(&snapshot);
    snapshot_from_servers(profile_key, &servers)
}

#[tauri::command]
pub async fn openclaw_mcp_server_set(
    req: OpenClawMcpServerSetRequest,
) -> Result<OpenClawMcpServersSnapshot, String> {
    let (profile, name, config) = normalize_set_request(req)?;
    let snapshot = openclaw_gateway::config_get(Some(&profile)).await?;
    let servers = servers_from_snapshot(&snapshot);
    let patch = build_servers_patch(&servers, &name, config.clone())?;
    let patch_result = openclaw_gateway::config_patch(Some(&profile), patch).await;
    match recover_servers_after_patch(&profile, |servers| {
        server_config_matches(servers, &name, &config)
    })
    .await
    {
        Ok(Some(refreshed_servers)) => return snapshot_from_servers(profile, &refreshed_servers),
        Ok(None) if patch_result.is_ok() => {}
        Err(read_error) if patch_result.is_ok() => return Err(read_error),
        Ok(None) | Err(_) => {
            if let Err(patch_error) = patch_result {
                return Err(patch_error);
            }
        }
    }
    openclaw_mcp_servers_list(Some(profile)).await
}

#[tauri::command]
pub async fn openclaw_mcp_server_unset(
    req: OpenClawMcpServerUnsetRequest,
) -> Result<OpenClawMcpServersSnapshot, String> {
    let profile = normalize_profile(req.profile.as_deref());
    let name = validate_server_name(&req.name)?;
    let snapshot = openclaw_gateway::config_get(Some(&profile)).await?;
    let servers = servers_from_snapshot(&snapshot);
    let patch = build_unset_patch(&servers, &name)?;
    // JSON merge-patch deletes this server record, including its `args` array.
    // Gateway requires that exact array path in `replacePaths`; bracket notation
    // keeps valid server names containing dots, dashes, slashes, or @ unambiguous.
    let replace_args_path = servers
        .get(&name)
        .and_then(|server| server.get("args"))
        .filter(|args| args.is_array())
        .map(|_| format!(r#"mcp.servers[\"{name}\"].args"#));
    let replace_paths = replace_args_path
        .as_deref()
        .map(|path| vec![path])
        .unwrap_or_default();
    let patch_result = openclaw_gateway::config_patch_replacing(
        Some(&profile),
        patch,
        &replace_paths,
    )
    .await;
    match recover_servers_after_patch(&profile, |servers| server_is_missing(servers, &name)).await {
        Ok(Some(refreshed_servers)) => return snapshot_from_servers(profile, &refreshed_servers),
        Ok(None) if patch_result.is_ok() => {}
        Err(read_error) if patch_result.is_ok() => return Err(read_error),
        Ok(None) | Err(_) => {
            if let Err(patch_error) = patch_result {
                return Err(patch_error);
            }
        }
    }
    openclaw_mcp_servers_list(Some(profile)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_stdio_server_record() {
        let record = normalize_server_record(
            "context7",
            &json!({
                "command": "uvx",
                "args": ["context7-mcp"],
                "env": {"CONTEXT7_API_KEY": "secret"}
            }),
        )
        .expect("record should normalize");

        assert_eq!(record.name, "context7");
        assert_eq!(record.transport, "stdio");
        assert_eq!(record.summary, "uvx context7-mcp");
        assert_eq!(record.has_secrets, true);
    }

    #[test]
    fn detects_bearer_token_inside_stdio_args() {
        let record = normalize_server_record(
            "tikhub-tiktok",
            &json!({
                "command": "npx",
                "args": [
                    "mcp-remote",
                    "https://mcp.tikhub.io/tiktok/mcp",
                    "--header",
                    "Authorization: Bearer tk_live_key"
                ]
            }),
        )
        .expect("record should normalize");

        assert_eq!(record.has_secrets, true);
    }

    #[test]
    fn rejects_shell_interpreter_as_stdio_command() {
        for command in ["bash", "/bin/sh", "PowerShell", "C:\\Windows\\System32\\cmd.exe"] {
            let err = normalize_set_request(OpenClawMcpServerSetRequest {
                profile: None,
                name: "evil".to_string(),
                config: json!({ "command": command, "args": ["-c", "echo pwned"] }),
            })
            .expect_err("shell interpreter command should be rejected");
            assert!(err.contains("shell"), "unexpected error for {command}: {err}");
        }
    }

    #[test]
    fn allows_real_mcp_launchers_and_rejects_traversal() {
        // Legit launchers keep working.
        for command in ["uvx", "npx", "node", "/usr/local/bin/python3"] {
            assert!(
                validate_stdio_command(command).is_ok(),
                "{command} should be allowed"
            );
        }
        // Traversal and control chars are denied.
        assert!(validate_stdio_command("../../bin/sh").is_err());
        assert!(validate_stdio_command("foo\nbar").is_err());
    }

    #[test]
    fn rejects_remote_server_without_url() {
        let err = normalize_set_request(OpenClawMcpServerSetRequest {
            profile: None,
            name: "docs".to_string(),
            config: json!({
                "transport": "streamable-http"
            }),
        })
        .expect_err("remote MCP server without url should fail");

        assert!(err.contains("url"));
    }

    #[test]
    fn builds_patch_that_preserves_existing_servers() {
        let patch = build_servers_patch(
            &json!({
                "existing": {"url": "https://mcp.example.com"},
                "context7": {"command": "uvx", "args": ["context7-mcp"]}
            }),
            "docs",
            json!({"url": "https://docs.example.com", "transport": "streamable-http"}),
        )
        .expect("patch should build");

        assert_eq!(
            patch["mcp"]["servers"]["existing"]["url"],
            "https://mcp.example.com"
        );
        assert_eq!(
            patch["mcp"]["servers"]["docs"]["transport"],
            "streamable-http"
        );
    }

    #[test]
    fn builds_unset_patch_and_errors_for_missing_server() {
        let patch = build_unset_patch(
            &json!({
                "context7": {"command": "uvx", "args": ["context7-mcp"]},
                "docs": {"url": "https://docs.example.com"}
            }),
            "docs",
        )
        .expect("patch should build");

        assert!(patch["mcp"]["servers"]["docs"].is_null());
        assert!(patch["mcp"]["servers"].get("context7").is_some());

        let err = build_unset_patch(&json!({}), "missing").expect_err("missing server should fail");
        assert!(err.contains("不存在"));
    }

    #[test]
    fn snapshot_records_sort_by_name() {
        let records = sorted_records(&json!({
            "zeta": {"url": "https://zeta.example.com"},
            "alpha": {"command": "uvx", "args": ["alpha-mcp"]}
        }))
        .expect("records should parse");

        assert_eq!(records[0].name, "alpha");
        assert_eq!(records[1].name, "zeta");
    }

    #[test]
    fn detects_successful_write_after_patch_response_error() {
        let expected = json!({
            "command": "npx",
            "args": ["mcp-remote", "https://mcp.tikhub.io/tiktok/mcp"]
        });
        let servers = json!({
            "tikhub-tiktok": expected.clone(),
            "other": {"command": "uvx"}
        });

        assert!(server_config_matches(&servers, "tikhub-tiktok", &expected));
        assert!(!server_config_matches(
            &servers,
            "tikhub-tiktok",
            &json!({"command": "uvx"})
        ));
        assert!(!server_config_matches(&servers, "missing", &expected));
    }

    #[test]
    fn detects_successful_unset_after_patch_response_error() {
        let servers = json!({
            "other": {"command": "uvx"}
        });

        assert!(server_is_missing(&servers, "tikhub-tiktok"));
        assert!(!server_is_missing(&servers, "other"));
    }
}
