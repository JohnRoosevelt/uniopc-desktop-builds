use crate::{
    commands::model,
    services::{openclaw_gateway, openclaw_gateway_contract::AgentFileDescriptor},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tokio::time::{sleep, Duration};

const GATEWAY_EMPLOYEE_FILE_WRITE_ATTEMPTS: usize = 14;
const GATEWAY_EMPLOYEE_FILE_WRITE_DELAY_MS: u64 = 500;
// A newly provisioned profile writes its gateway configuration before the
// gateway has finished its in-process reload. `agents.list` used to make one
// direct request during that small window and surface "Connection refused" to
// an otherwise authorized user. Only retry that startup-specific transport
// failure; authentication and gateway errors still return immediately.
const GATEWAY_EMPLOYEE_LIST_STARTUP_RETRY_DELAYS_MS: &[u64] =
    &[250, 500, 1_000, 1_500, 2_500, 3_000];

// Levels accepted by the gateway's normalizeThinkLevel. "" clears the override.
const OPENCLAW_AGENT_THINKING_LEVELS: [&str; 6] =
    ["off", "minimal", "low", "medium", "high", "xhigh"];

fn normalize_agent_thinking_default(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() || OPENCLAW_AGENT_THINKING_LEVELS.contains(&normalized.as_str()) {
        return Ok(normalized);
    }
    Err(format!(
        "无效的思考强度 `{value}`，可选：跟随默认 / {}。",
        OPENCLAW_AGENT_THINKING_LEVELS.join(" / ")
    ))
}

fn config_root_from_snapshot(snapshot: &Value) -> Option<&Value> {
    snapshot
        .get("parsed")
        .or_else(|| snapshot.get("sourceConfig"))
        .or_else(|| snapshot.get("config"))
        .or_else(|| snapshot.get("runtimeConfig"))
        .or_else(|| snapshot.get("resolved"))
}

// agents.update does not accept thinkingDefault, so the per-agent entry is
// rewritten through config.patch. agents.list is an array — the whole list is
// re-sent (mirrors the gateway's own applyAgentConfig read-modify-write).
fn build_agent_thinking_default_patch(
    snapshot: &Value,
    agent_id: &str,
    thinking_default: &str,
) -> Value {
    let list = config_root_from_snapshot(snapshot)
        .and_then(|root| root.get("agents"))
        .and_then(|agents| agents.get("list"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next_list: Vec<Value> = list;
    let index = next_list.iter().position(|entry| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .map(|id| id.trim() == agent_id)
            .unwrap_or(false)
    });
    let mut entry = match index {
        Some(found) => next_list[found].as_object().cloned().unwrap_or_default(),
        None => {
            let mut created = serde_json::Map::new();
            created.insert("id".to_string(), Value::String(agent_id.to_string()));
            created
        }
    };
    if thinking_default.is_empty() {
        entry.remove("thinkingDefault");
    } else {
        entry.insert(
            "thinkingDefault".to_string(),
            Value::String(thinking_default.to_string()),
        );
    }
    match index {
        Some(found) => next_list[found] = Value::Object(entry),
        None => {
            // Keep the implicit default agent's placeholder first (mirrors the
            // gateway's applyAgentConfig behaviour for a previously-empty list).
            if next_list.is_empty() && agent_id != "main" {
                next_list.push(json!({ "id": "main" }));
            }
            next_list.push(Value::Object(entry));
        }
    }
    json!({ "agents": { "list": next_list } })
}

// Per-agent capability fields live on the same agents.list entry as
// thinkingDefault and follow the same read-modify-write config.patch
// discipline. Engine semantics (agent-filter / agent-tools.policy): a missing
// `skills` key = follow shared defaults (all skills), an explicit list = an
// allowlist; `tools.deny` filters runtime tools by name (plugin tools
// included). Product semantics map "empty selection" to key REMOVAL — never
// an explicit empty list, which the engine would read as "deny everything".
fn build_agent_capability_patch(
    snapshot: &Value,
    agent_id: &str,
    skills: Option<&[String]>,
    tools_deny: Option<&[String]>,
) -> Value {
    let list = config_root_from_snapshot(snapshot)
        .and_then(|root| root.get("agents"))
        .and_then(|agents| agents.get("list"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next_list: Vec<Value> = list;
    let index = next_list.iter().position(|entry| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .map(|id| id.trim() == agent_id)
            .unwrap_or(false)
    });
    let mut entry = match index {
        Some(found) => next_list[found].as_object().cloned().unwrap_or_default(),
        None => {
            let mut created = serde_json::Map::new();
            created.insert("id".to_string(), Value::String(agent_id.to_string()));
            created
        }
    };
    if let Some(skills) = skills {
        if skills.is_empty() {
            entry.remove("skills");
        } else {
            entry.insert(
                "skills".to_string(),
                Value::Array(skills.iter().map(|s| Value::String(s.clone())).collect()),
            );
        }
    }
    if let Some(deny) = tools_deny {
        let mut tools = entry
            .get("tools")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if deny.is_empty() {
            tools.remove("deny");
        } else {
            tools.insert(
                "deny".to_string(),
                Value::Array(deny.iter().map(|s| Value::String(s.clone())).collect()),
            );
        }
        if tools.is_empty() {
            entry.remove("tools");
        } else {
            entry.insert("tools".to_string(), Value::Object(tools));
        }
    }
    match index {
        Some(found) => next_list[found] = Value::Object(entry),
        None => {
            if next_list.is_empty() && agent_id != "main" {
                next_list.push(json!({ "id": "main" }));
            }
            next_list.push(Value::Object(entry));
        }
    }
    json!({ "agents": { "list": next_list } })
}

async fn set_agent_thinking_default(
    profile: Option<&str>,
    agent_id: &str,
    thinking_default: &str,
) -> Result<(), String> {
    let snapshot = openclaw_gateway::config_get(profile).await?;
    let current = config_root_from_snapshot(&snapshot)
        .and_then(|root| root.get("agents"))
        .and_then(|agents| agents.get("list"))
        .and_then(Value::as_array)
        .and_then(|list| {
            list.iter().find(|entry| {
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| id.trim() == agent_id)
                    .unwrap_or(false)
            })
        })
        .and_then(|entry| entry.get("thinkingDefault"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if current == thinking_default {
        return Ok(());
    }
    let patch = build_agent_thinking_default_patch(&snapshot, agent_id, thinking_default);
    openclaw_gateway::config_patch(profile, patch)
        .await
        .map(|_| ())
        .map_err(|error| format!("保存员工思考强度失败: {error}"))
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenClawEmployee {
    pub id: String,
    pub name: String,
    pub role: String,
    pub description: String,
    pub emoji: Option<String>,
    pub model: Option<String>,
    pub workspace: String,
    pub agent_dir: String,
    pub is_default: bool,
    pub bindings: u64,
    pub routes: Vec<String>,
    pub providers: Vec<String>,
    pub status: String,
    pub activation_error: Option<String>,
    pub activated_at: Option<String>,
    // Per-agent thinking strength (agents.list[].thinkingDefault); None follows
    // the gateway/model default. Configured in employee settings, never per-message.
    pub thinking_default: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenClawEmployeeDocument {
    pub id: String,
    pub relative_path: String,
    pub title: String,
    pub kind: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenClawEmployeeDocumentDetail {
    pub relative_path: String,
    pub title: String,
    pub kind: String,
    pub content: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawSkillSummary {
    pub name: String,
    pub description: String,
    pub emoji: Option<String>,
    pub eligible: bool,
    pub disabled: bool,
    pub bundled: bool,
    pub source: String,
    pub missing_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawAgentSkillAssignment {
    pub id: String,
    pub name: String,
    pub role: String,
    pub emoji: Option<String>,
    pub is_default: bool,
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawSkillhubSnapshot {
    pub skills: Vec<OpenClawSkillSummary>,
    pub agents: Vec<OpenClawAgentSkillAssignment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOpenClawEmployeeDocumentInput {
    pub relative_path: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOpenClawEmployeeRequest {
    pub name: String,
    pub role: Option<String>,
    pub description: Option<String>,
    pub emoji: Option<String>,
    pub model: Option<String>,
    pub profile: Option<String>,
    // 角色模板实例化:提供时 SOUL.md/AGENTS.md 用模板内容,skills 创建后自动绑定。
    #[serde(default)]
    pub soul_md: Option<String>,
    #[serde(default)]
    pub agents_md: Option<String>,
    #[serde(default)]
    pub skills: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOpenClawEmployeeRequest {
    pub id: String,
    pub name: Option<String>,
    pub role: Option<String>,
    pub description: Option<String>,
    pub emoji: Option<String>,
    pub model: Option<String>,
    pub profile: Option<String>,
    // None = leave untouched; Some("") = follow default; Some(level) = pin level.
    #[serde(default)]
    pub thinking_default: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetOpenClawAgentSkillsRequest {
    pub agent_id: String,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteOpenClawEmployeeResult {
    pub id: String,
    pub deleted: bool,
}

#[derive(Debug, Clone)]
struct IdentityInfo {
    name: Option<String>,
    emoji: Option<String>,
}

#[derive(Debug, Clone)]
struct AgentInstructions {
    role: Option<String>,
    description: Option<String>,
}

fn employees_root_dir() -> Result<PathBuf, String> {
    Ok(crate::services::uniopc_runtime_paths::uniopc_data_dir()?.join("employees"))
}

fn employee_workspace_dir(id: &str) -> Result<PathBuf, String> {
    Ok(employees_root_dir()?.join(id))
}

fn employee_workspace_dir_for_profile(profile: Option<&str>, id: &str) -> Result<PathBuf, String> {
    let normalized = profile.map(str::trim).filter(|value| !value.is_empty());
    if let Some(profile_id) = normalized {
        // Sanitize the JS-supplied profile before it becomes a path segment.
        // Every other profile→path site routes through this; this one bypassed it,
        // so `../../..` (or an absolute value, which `join` would treat as a new
        // root) could escape the workspaces tree.
        let safe_profile = crate::services::uniopc_runtime_paths::sanitize_profile_key(profile_id);
        return Ok(crate::services::uniopc_runtime_paths::uniopc_data_dir()?
            .join("workspaces")
            .join(safe_profile)
            .join("agents")
            .join(id));
    }
    employee_workspace_dir(id)
}

fn slugify_employee_id(input: &str) -> String {
    let slug = input
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch
            } else if ch.is_ascii_whitespace() || ch == '-' || ch == '_' {
                '-'
            } else {
                '-'
            }
        })
        .collect::<String>();

    let compact = slug
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    if compact.is_empty() {
        format!("employee-{}", uuid::Uuid::new_v4().simple())
    } else {
        compact
    }
}

fn is_reserved_profile_agent_id(id: &str) -> bool {
    id.trim().eq_ignore_ascii_case("main")
}

fn should_update_gateway_agent_metadata(agent_id: &str) -> bool {
    !is_reserved_profile_agent_id(agent_id)
}

fn identity_file_content(name: &str, emoji: Option<&str>, role: Option<&str>) -> String {
    let creature = role.unwrap_or("AI员工");
    format!(
        "# IDENTITY.md\n\n- **Name:** {name}\n- **Creature:** {creature}\n- **Vibe:** 专业、可靠、结果导向\n- **Emoji:** {}\n",
        emoji.unwrap_or("🤖")
    )
}

fn agents_file_content(name: &str, role: &str, description: &str) -> String {
    format!(
        "# {name}\n\n## 角色\n{role}\n\n## 主要职责\n{description}\n\n## 工作方式\n- 默认使用中文\n- 回答优先给可执行结果\n- 对传统企业老板和业务负责人保持清晰、直接、专业\n- 少讲空话，优先给下一步行动\n"
    )
}

// The implicit `main` agent is branded only when the Gateway explicitly lists
// AGENTS.md as missing. Existing or unreadable files fail safe and are never
// overwritten during roster refresh.
const DEFAULT_ASSISTANT_NAME: &str = "Uniopc 助理";
const DEFAULT_ASSISTANT_EMOJI: &str = "🦄";
const DEFAULT_ASSISTANT_ROLE: &str = "通用助理";
const DEFAULT_ASSISTANT_DESCRIPTION: &str =
    "Uniopc 的默认 AI 助理，负责日常对话、任务整理和推动业务下一步。";
const WORKSPACE_TEMPLATE_AGENT_TITLE: &str = "AGENTS.md - Your Workspace";

async fn seed_default_agent_identity(profile: Option<&str>, agent_id: &str) -> Result<(), String> {
    set_gateway_employee_file_with_retry(
        profile,
        agent_id,
        "AGENTS.md",
        &agents_file_content(
            DEFAULT_ASSISTANT_NAME,
            DEFAULT_ASSISTANT_ROLE,
            DEFAULT_ASSISTANT_DESCRIPTION,
        ),
    )
    .await?;
    Ok(())
}

fn apply_default_assistant_persona(employee: &mut OpenClawEmployee) {
    employee.name = DEFAULT_ASSISTANT_NAME.to_string();
    employee.role = DEFAULT_ASSISTANT_ROLE.to_string();
    employee.description = DEFAULT_ASSISTANT_DESCRIPTION.to_string();
    employee.emoji = Some(DEFAULT_ASSISTANT_EMOJI.to_string());
}

fn employee_doc_title(relative_path: &str) -> String {
    match relative_path {
        "IDENTITY.md" => "身份文档".to_string(),
        "AGENTS.md" => "工作指令".to_string(),
        "SOUL.md" => "灵魂与边界".to_string(),
        "USER.md" => "服务对象".to_string(),
        "MEMORY.md" => "长期记忆".to_string(),
        path if path.starts_with("memory/") => path
            .strip_prefix("memory/")
            .unwrap_or(path)
            .trim_end_matches(".md")
            .to_string(),
        _ => relative_path.trim_end_matches(".md").to_string(),
    }
}

fn employee_doc_kind(relative_path: &str) -> String {
    match relative_path {
        "IDENTITY.md" | "AGENTS.md" | "SOUL.md" | "USER.md" => "profile".to_string(),
        "MEMORY.md" => "memory".to_string(),
        path if path.starts_with("memory/") => "memory".to_string(),
        _ => "workspace".to_string(),
    }
}

pub(crate) fn gateway_file_content(value: &Value) -> Option<String> {
    value_as_string(value.get("content"))
        .or_else(|| value_as_string(value.get("text")))
        .or_else(|| {
            value
                .get("file")
                .and_then(|file| value_as_string(file.get("content")))
        })
}

fn value_as_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn gateway_file_updated_at(value: &Value) -> String {
    value_as_string(value.get("updatedAt"))
        .or_else(|| value_as_string(value.get("updated_at")))
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
}

fn require_listed_agent_file(files: &[AgentFileDescriptor], name: &str) -> Result<(), String> {
    if AgentFileDescriptor::supports(files, name) {
        Ok(())
    } else {
        Err(format!("该员工未公开文档 `{name}`。"))
    }
}

fn gateway_file_summary(file: &AgentFileDescriptor) -> OpenClawEmployeeDocument {
    let updated_at = file
        .updated_at_ms
        .and_then(|value| i64::try_from(value).ok())
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default();
    OpenClawEmployeeDocument {
        id: file.name.clone(),
        relative_path: file.name.clone(),
        title: employee_doc_title(&file.name),
        kind: employee_doc_kind(&file.name),
        updated_at,
    }
}

fn gateway_file_detail(
    relative_path: &str,
    value: &Value,
) -> Result<OpenClawEmployeeDocumentDetail, String> {
    let content = gateway_file_content(value)
        .ok_or_else(|| "Gateway agents.files.get 没有返回文件内容。".to_string())?;
    Ok(OpenClawEmployeeDocumentDetail {
        relative_path: relative_path.to_string(),
        title: value_as_string(value.get("title"))
            .unwrap_or_else(|| employee_doc_title(relative_path)),
        kind: value_as_string(value.get("kind"))
            .unwrap_or_else(|| employee_doc_kind(relative_path)),
        content,
        updated_at: gateway_file_updated_at(value),
    })
}

#[cfg(test)]
fn identity_info_from_markdown(raw: &str) -> IdentityInfo {
    IdentityInfo {
        name: extract_markdown_field(&raw, "Name"),
        emoji: extract_markdown_field(&raw, "Emoji"),
    }
}

fn agent_instructions_from_markdown(raw: &str) -> AgentInstructions {
    AgentInstructions {
        role: extract_section_content(&raw, "角色"),
        description: extract_section_content(&raw, "主要职责"),
    }
}

fn agents_file_name_from_markdown(raw: &str) -> Option<String> {
    raw.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn default_agent_seed_needed(files: &[AgentFileDescriptor]) -> bool {
    files
        .iter()
        .find(|file| file.name == "AGENTS.md")
        .is_some_and(|file| file.missing)
}

fn apply_listed_agent_profile(
    employee: &mut OpenClawEmployee,
    files: &[AgentFileDescriptor],
    agents_content: Option<&str>,
) -> bool {
    if default_agent_seed_needed(files) {
        return true;
    }
    let Some(agents_file) = files.iter().find(|file| file.name == "AGENTS.md") else {
        return false;
    };
    debug_assert!(!agents_file.missing);
    let Some(content) = agents_content else {
        return false;
    };
    let instructions = agent_instructions_from_markdown(content);
    if let Some(name) = agents_file_name_from_markdown(content) {
        if !(employee.is_default && name == WORKSPACE_TEMPLATE_AGENT_TITLE) {
            employee.name = name;
        }
    }
    if let Some(role) = instructions.role {
        employee.role = role;
    }
    if let Some(description) = instructions.description {
        employee.description = description;
    }
    false
}

#[cfg(test)]
fn extract_markdown_field(raw: &str, field: &str) -> Option<String> {
    let prefix = format!("- **{field}:**");
    raw.lines()
        .find_map(|line| line.trim().strip_prefix(&prefix).map(str::trim))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_section_content(raw: &str, heading: &str) -> Option<String> {
    let target = format!("## {heading}");
    let mut in_section = false;
    let mut lines = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed == target {
            in_section = true;
            continue;
        }
        if in_section && trimmed.starts_with("## ") {
            break;
        }
        if in_section {
            lines.push(line);
        }
    }

    let value = lines.join("\n").trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn map_openclaw_employee(item: &Value) -> OpenClawEmployee {
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("main")
        .to_string();
    let workspace = item
        .get("workspace")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let agent_dir = item
        .get("agentDir")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut identity = IdentityInfo {
        name: None,
        emoji: None,
    };
    let gateway_identity = item.get("identity");
    if identity.name.is_none() {
        identity.name = item
            .get("identityName")
            .and_then(Value::as_str)
            .or_else(|| {
                gateway_identity
                    .and_then(|value| value.get("name"))
                    .and_then(Value::as_str)
            })
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }
    if identity.emoji.is_none() {
        identity.emoji = item
            .get("identityEmoji")
            .and_then(Value::as_str)
            .or_else(|| {
                gateway_identity
                    .and_then(|value| value.get("emoji"))
                    .and_then(Value::as_str)
            })
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }
    let instructions = AgentInstructions {
        role: item
            .get("role")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        description: item
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    };

    let reserved_default = is_reserved_profile_agent_id(&id);
    let is_default = item
        .get("isDefault")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || reserved_default;

    if reserved_default
        && identity
            .name
            .as_deref()
            .is_some_and(|name| name.eq_ignore_ascii_case("main"))
    {
        identity.name = None;
    }

    OpenClawEmployee {
        id: id.clone(),
        name: identity.name.unwrap_or_else(|| {
            if reserved_default {
                DEFAULT_ASSISTANT_NAME.to_string()
            } else {
                id.clone()
            }
        }),
        role: instructions.role.unwrap_or_else(|| {
            if reserved_default {
                DEFAULT_ASSISTANT_ROLE.to_string()
            } else {
                "AI员工".to_string()
            }
        }),
        description: instructions.description.unwrap_or_else(|| {
            if reserved_default {
                DEFAULT_ASSISTANT_DESCRIPTION.to_string()
            } else {
                "负责持续对话和业务执行。".to_string()
            }
        }),
        emoji: identity.emoji.or_else(|| {
            if reserved_default {
                Some(DEFAULT_ASSISTANT_EMOJI.to_string())
            } else {
                None
            }
        }),
        model: item
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        workspace,
        agent_dir,
        is_default,
        bindings: item.get("bindings").and_then(Value::as_u64).unwrap_or(0),
        routes: item
            .get("routes")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        providers: item
            .get("providers")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        status: "active".to_string(),
        activation_error: None,
        activated_at: Some(chrono::Utc::now().to_rfc3339()),
        thinking_default: item
            .get("thinkingDefault")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    }
}

async fn load_openclaw_agents(
    app: &AppHandle,
    profile: Option<&str>,
) -> Result<Vec<OpenClawEmployee>, String> {
    let _ = crate::services::openclaw_gateway_connection::refresh(app, profile).await;
    let items = load_openclaw_agent_items_with_startup_retry(app, profile).await?;
    let mut employees = Vec::new();
    for item in items {
        let mut employee = map_openclaw_employee(&item);
        let files = openclaw_gateway::agent_file_descriptors(profile, &employee.id)
            .await
            .unwrap_or_default();
        let agents_content = if files
            .iter()
            .any(|file| file.name == "AGENTS.md" && !file.missing)
        {
            openclaw_gateway::listed_agent_file_get(
                profile,
                &employee.id,
                &files,
                "AGENTS.md",
            )
            .await
            .ok()
            .and_then(|value| gateway_file_content(&value))
        } else {
            None
        };
        let should_seed = apply_listed_agent_profile(
            &mut employee,
            &files,
            agents_content.as_deref(),
        );
        if is_reserved_profile_agent_id(&employee.id)
            && should_seed
            && seed_default_agent_identity(profile, &employee.id)
                .await
                .is_ok()
        {
            apply_default_assistant_persona(&mut employee);
            employees.push(employee);
            continue;
        }
        employees.push(employee);
    }
    Ok(employees)
}

fn is_gateway_starting_transport_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("connection refused")
        || normalized.contains("os error 61")
        || normalized.contains("connection reset")
        || normalized.contains("broken pipe")
}

async fn load_openclaw_agent_items_with_startup_retry(
    app: &AppHandle,
    profile: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut last_error = String::new();
    for delay_ms in
        std::iter::once(&0_u64).chain(GATEWAY_EMPLOYEE_LIST_STARTUP_RETRY_DELAYS_MS.iter())
    {
        if *delay_ms > 0 {
            sleep(Duration::from_millis(*delay_ms)).await;
            // The gateway may have come up on a just-written local endpoint,
            // so refresh the connection snapshot before trying again.
            let _ = crate::services::openclaw_gateway_connection::refresh(app, profile).await;
        }
        match openclaw_gateway::agents_list_json_with_device_auth(app, profile).await {
            Ok(items) => return Ok(items),
            Err(error) if is_gateway_starting_transport_error(&error) => {
                last_error = error;
            }
            Err(error) => return Err(format!("Uniopc 引擎 agents.list failed: {error}")),
        }
    }
    Err(format!(
        "Uniopc 引擎正在启动，员工列表暂时不可用。请稍后重试。最后一次连接错误：{last_error}"
    ))
}

#[tauri::command]
pub async fn openclaw_skillhub_snapshot(
    app: AppHandle,
    profile: Option<String>,
) -> Result<OpenClawSkillhubSnapshot, String> {
    let profile_ref = profile.as_deref();
    let skills = load_openclaw_skills(profile_ref).await?;
    let agents = load_openclaw_agents(&app, profile_ref)
        .await
        .unwrap_or_default();
    let assignment_futures = agents.into_iter().map(|agent| async move {
        match openclaw_gateway::skills_status(profile_ref, Some(&agent.id)).await {
            Ok(skill_status) => Some(OpenClawAgentSkillAssignment {
                id: agent.id.clone(),
                name: agent.name,
                role: agent.role,
                emoji: agent.emoji,
                is_default: agent.is_default,
                skills: gateway_agent_skill_names(&skill_status),
            }),
            Err(_) => None,
        }
    });
    let assignments = futures_util::future::join_all(assignment_futures)
        .await
        .into_iter()
        .flatten()
        .collect();

    Ok(OpenClawSkillhubSnapshot {
        skills,
        agents: assignments,
    })
}

#[tauri::command]
pub async fn openclaw_agent_skills_set(
    app: AppHandle,
    req: SetOpenClawAgentSkillsRequest,
) -> Result<OpenClawAgentSkillAssignment, String> {
    let agent_id = req.agent_id.trim();
    if agent_id.is_empty() {
        return Err("缺少 Agent ID。".to_string());
    }
    let profile_ref = req.profile.as_deref();
    let normalized_skills = normalize_skill_names(&req.skills);
    // agents.update rejects a root-level `skills` property on engine
    // 2026.6.11; the real per-agent surface is the agents.list[].skills
    // filter in config (resolveEffectiveAgentSkillFilter), written here via
    // the same config.patch discipline as thinkingDefault.
    let snapshot = openclaw_gateway::config_get(profile_ref).await?;
    let patch = build_agent_capability_patch(&snapshot, agent_id, Some(&normalized_skills), None);
    // replacePaths: key removal (clearing a filter) and entry rewrites only
    // land when agents.list is replaced wholesale — plain merge keeps stale keys.
    openclaw_gateway::config_patch_replacing(profile_ref, patch, &["agents.list"])
        .await
        .map_err(|error| format!("保存员工技能分配失败: {error}"))?;

    let agents = load_openclaw_agents(&app, profile_ref).await?;
    let Some(agent) = agents.into_iter().find(|item| item.id == agent_id) else {
        return Err(format!(
            "Uniopc 引擎 已保存配置，但刷新 agent `{agent_id}` 失败。"
        ));
    };
    Ok(OpenClawAgentSkillAssignment {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        emoji: agent.emoji,
        is_default: agent.is_default,
        skills: normalized_skills,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetOpenClawAgentToolsDenyRequest {
    pub agent_id: String,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

/// Per-agent runtime tool blocklist (agents.list[].tools.deny). Assigning a
/// plugin to an employee = removing that plugin's tool names from the deny
/// list; unassigning = adding them. Empty deny removes the key (all tools).
#[tauri::command]
pub async fn openclaw_agent_tools_deny_set(
    req: SetOpenClawAgentToolsDenyRequest,
) -> Result<Vec<String>, String> {
    let agent_id = req.agent_id.trim();
    if agent_id.is_empty() {
        return Err("缺少 Agent ID。".to_string());
    }
    let profile_ref = req.profile.as_deref();
    let normalized = normalize_skill_names(&req.deny);
    let snapshot = openclaw_gateway::config_get(profile_ref).await?;
    let patch = build_agent_capability_patch(&snapshot, agent_id, None, Some(&normalized));
    openclaw_gateway::config_patch_replacing(profile_ref, patch, &["agents.list"])
        .await
        .map_err(|error| format!("保存员工工具屏蔽失败: {error}"))?;
    Ok(normalized)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawPluginCapabilityInventory {
    pub plugin_id: String,
    pub name: String,
    pub tools: Vec<String>,
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawAgentCapabilityState {
    pub id: String,
    /// None = no filter (all skills); Some = explicit allowlist.
    pub skills: Option<Vec<String>>,
    pub tools_deny: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawAgentCapabilitiesSnapshot {
    pub plugins: Vec<OpenClawPluginCapabilityInventory>,
    pub agents: Vec<OpenClawAgentCapabilityState>,
}

fn plugin_capability_inventory(plugin_dir: &Path) -> Option<OpenClawPluginCapabilityInventory> {
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(crate::services::plugin_artifact::plugin_manifest_path(&plugin_dir)).ok()?,
    )
    .ok()?;
    let plugin_id = manifest
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())?
        .to_string();
    let name = manifest
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&plugin_id)
        .to_string();
    let tools = manifest
        .pointer("/contracts/tools")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .or_else(|| item.get("name").and_then(Value::as_str))
                })
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut skills = Vec::new();
    if let Ok(entries) = std::fs::read_dir(plugin_dir.join("skills")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("SKILL.md").is_file() {
                if let Some(id) = path.file_name().and_then(|name| name.to_str()) {
                    skills.push(id.to_string());
                }
            }
        }
    }
    skills.sort();
    Some(OpenClawPluginCapabilityInventory {
        plugin_id,
        name,
        tools,
        skills,
    })
}

fn agent_capability_states(snapshot: &Value) -> Vec<OpenClawAgentCapabilityState> {
    config_root_from_snapshot(snapshot)
        .and_then(|root| root.get("agents"))
        .and_then(|agents| agents.get("list"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    let id = entry.get("id").and_then(Value::as_str)?.trim().to_string();
                    let skills = entry.get("skills").and_then(Value::as_array).map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                            .collect()
                    });
                    let tools_deny = entry
                        .pointer("/tools/deny")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(OpenClawAgentCapabilityState {
                        id,
                        skills,
                        tools_deny,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Inventory of installed plugins (tools + skills) plus each agent's current
/// capability state — the data source for the per-employee assignment UI.
#[tauri::command]
pub async fn openclaw_agent_capabilities_snapshot(
    profile: Option<String>,
) -> Result<OpenClawAgentCapabilitiesSnapshot, String> {
    let mut plugins = Vec::new();
    if let Ok(entries) =
        std::fs::read_dir(crate::services::openclaw_system_plugins::openclaw_extensions_dir()?)
    {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(inventory) = plugin_capability_inventory(&path) {
                    plugins.push(inventory);
                }
            }
        }
    }
    plugins.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id));
    let snapshot = openclaw_gateway::config_get(profile.as_deref()).await?;
    Ok(OpenClawAgentCapabilitiesSnapshot {
        plugins,
        agents: agent_capability_states(&snapshot),
    })
}

fn humanize_openclaw_agents_error(error: &str) -> String {
    let normalized = error.to_lowercase();
    let is_plugin_runtime_error = normalized.contains("plugin-runtime-deps")
        || normalized.contains("pluginloadfailureerror")
        || normalized.contains("failed to install bundled runtime deps")
        || normalized.contains("failed to load bundled channel");

    if !is_plugin_runtime_error {
        return replace_openclaw_branding(error);
    }

    let reason = if normalized.contains("enotempty") {
        "Uniopc 引擎 插件缓存正在重建或上次安装没有清理干净。"
    } else if normalized.contains("eperm") || normalized.contains("operation not permitted") {
        "Uniopc 引擎 插件缓存暂时无法写入。"
    } else {
        "Uniopc 引擎 插件运行环境暂时不可用。"
    };
    let detail = replace_openclaw_branding(&tail_lines(error, 4));

    format!(
        "{reason}Uniopc 已保留本地员工状态；请稍等后刷新，或到运行中心重启/修复 Uniopc 引擎。\n原始错误摘要：{detail}"
    )
}

fn replace_openclaw_branding(text: &str) -> String {
    const INTERNAL_NAME: &[u8] = b"openclaw";
    let mut remaining = text;
    let mut result = String::with_capacity(text.len());

    while !remaining.is_empty() {
        if remaining.as_bytes().len() >= INTERNAL_NAME.len()
            && remaining.as_bytes()[..INTERNAL_NAME.len()].eq_ignore_ascii_case(INTERNAL_NAME)
        {
            result.push_str("Uniopc 引擎");
            remaining = &remaining[INTERNAL_NAME.len()..];
            continue;
        }
        let character = remaining
            .chars()
            .next()
            .expect("remaining text is not empty");
        result.push(character);
        remaining = &remaining[character.len_utf8()..];
    }

    result
}

fn tail_lines(text: &str, count: usize) -> String {
    let mut lines = text
        .lines()
        .rev()
        .take(count)
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    lines.reverse();
    lines.join("\n")
}

fn normalize_skill_names(skills: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for skill in skills {
        let trimmed = skill.trim();
        if trimmed.is_empty() || out.iter().any(|item: &String| item == trimmed) {
            continue;
        }
        out.push(trimmed.to_string());
    }
    out
}

fn map_openclaw_skill(value: &Value) -> Option<OpenClawSkillSummary> {
    let name = value.get("name").and_then(Value::as_str)?.to_string();
    let missing_count = value
        .get("missing")
        .and_then(Value::as_object)
        .map(|missing| {
            missing
                .values()
                .filter_map(Value::as_array)
                .map(Vec::len)
                .sum()
        })
        .unwrap_or(0);

    Some(OpenClawSkillSummary {
        name,
        description: value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        emoji: value
            .get("emoji")
            .and_then(Value::as_str)
            .map(str::to_string),
        eligible: value
            .get("eligible")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        disabled: value
            .get("disabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        bundled: value
            .get("bundled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        source: value
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        missing_count,
    })
}

async fn load_openclaw_skills(profile: Option<&str>) -> Result<Vec<OpenClawSkillSummary>, String> {
    let value = openclaw_gateway::skills_status(profile, None).await?;
    let skills = value
        .get("skills")
        .or_else(|| value.get("items"))
        .and_then(Value::as_array)
        .ok_or_else(|| "Uniopc 引擎 skills.status 没有返回 skills 数组。".to_string())?;
    Ok(skills.iter().filter_map(map_openclaw_skill).collect())
}

fn skill_name_from_value(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("name")
                .or_else(|| value.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

fn skill_value_is_assigned(value: &Value) -> bool {
    if value.is_string() {
        return true;
    }
    value
        .get("assigned")
        .or_else(|| value.get("selected"))
        .or_else(|| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn gateway_agent_skill_names(value: &Value) -> Vec<String> {
    let arrays = [
        value.pointer("/agent/skills"),
        value.pointer("/assignment/skills"),
        value.get("assignedSkills"),
        value.get("enabledSkills"),
        value.get("skills"),
    ];
    for array in arrays.into_iter().flatten().filter_map(Value::as_array) {
        let names = array
            .iter()
            .filter(|item| skill_value_is_assigned(item))
            .filter_map(skill_name_from_value)
            .collect::<Vec<_>>();
        if !names.is_empty() {
            return normalize_skill_names(&names);
        }
    }
    Vec::new()
}

#[derive(Debug, Clone)]
struct EmployeeActivationJob {
    id: String,
    name: String,
    role: String,
    description: String,
    emoji: String,
    model: Option<String>,
    profile: Option<String>,
    workspace_text: String,
    soul_md: Option<String>,
    agents_md: Option<String>,
}

const STANDARD_EMPLOYEE_TOOLS_GUIDANCE: &str = "- 先阅读当前工作区文档，再执行动作。\n- 修改关键业务内容前，优先确认当前工作区文档和员工规则。\n- 对外部系统操作保持谨慎，避免误删或覆盖。\n";

fn with_employee_tools_guidance(agents_md: String) -> String {
    if agents_md
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("## Tools"))
    {
        return agents_md;
    }
    format!("{agents_md}\n\n## Tools\n{STANDARD_EMPLOYEE_TOOLS_GUIDANCE}")
}

fn employee_activation_documents(job: &EmployeeActivationJob) -> Vec<(String, String)> {
    let agents_md = job
        .agents_md
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| agents_file_content(&job.name, &job.role, &job.description));
    let mut documents = vec![
        (
            "IDENTITY.md".to_string(),
            identity_file_content(&job.name, Some(&job.emoji), Some(&job.role)),
        ),
        (
            "AGENTS.md".to_string(),
            with_employee_tools_guidance(agents_md),
        ),
    ];
    if let Some(soul_md) = job
        .soul_md
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        documents.push(("SOUL.md".to_string(), soul_md.to_string()));
    }
    documents.extend([
        (
            "USER.md".to_string(),
            "# USER.md\n\n- 你服务的是当前业务负责人和业务团队。\n- 默认使用中文。\n- 回答优先给结论、执行建议和下一步动作。\n".to_string(),
        ),
        (
            "MEMORY.md".to_string(),
            "# MEMORY.md\n\n## 长期记忆\n\n- 暂无。\n".to_string(),
        ),
    ]);
    documents
}

async fn write_gateway_employee_files(job: &EmployeeActivationJob) -> Result<(), String> {
    let files = openclaw_gateway::agent_file_descriptors(job.profile.as_deref(), &job.id).await?;
    let mut writes = 0;
    for (relative_path, content) in employee_activation_documents(job) {
        if !AgentFileDescriptor::supports(&files, &relative_path) {
            continue;
        }
        set_gateway_employee_file_with_retry(
            job.profile.as_deref(),
            &job.id,
            &relative_path,
            &content,
        )
        .await?;
        writes += 1;
    }
    if writes == 0 {
        Err("Gateway 未公开可持久化的员工文档。".to_string())
    } else {
        Ok(())
    }
}

async fn set_gateway_employee_file_with_retry(
    profile: Option<&str>,
    agent_id: &str,
    relative_path: &str,
    content: &str,
) -> Result<(), String> {
    let mut last_error = None;
    for attempt in 0..GATEWAY_EMPLOYEE_FILE_WRITE_ATTEMPTS {
        match openclaw_gateway::agent_files_set(profile, agent_id, relative_path, content).await {
            Ok(_) => return Ok(()),
            Err(error) => {
                let should_retry = is_transient_gateway_employee_write_error(&error);
                last_error = Some(error);
                if !should_retry || attempt + 1 >= GATEWAY_EMPLOYEE_FILE_WRITE_ATTEMPTS {
                    break;
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(
                    GATEWAY_EMPLOYEE_FILE_WRITE_DELAY_MS,
                ))
                .await;
            }
        }
    }

    Err(last_error.unwrap_or_else(|| format!("写入 {relative_path} 失败。")))
}

fn is_transient_gateway_employee_write_error(error: &str) -> bool {
    let normalized = error.to_lowercase();
    normalized.contains("connection refused")
        || normalized.contains("timed out")
        || normalized.contains("timeout")
        || normalized.contains("closed")
        || normalized.contains("not found")
        || error.contains("连接 Uniopc 引擎")
        || error.contains("连接 Gateway")
        || error.contains("超时")
        || error.contains("关闭连接")
        || error.contains("未找到")
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

fn existing_employee_model_allowlist(snapshot: &Value) -> serde_json::Map<String, Value> {
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

fn existing_employee_provider_models(snapshot: &Value, provider: &str) -> Vec<Value> {
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

fn existing_employee_provider_config(
    snapshot: &Value,
    provider: &str,
) -> Option<serde_json::Map<String, Value>> {
    let roots = [
        "parsed",
        "sourceConfig",
        "config",
        "runtimeConfig",
        "resolved",
    ];
    for root in roots {
        if let Some(config) = json_object_at(snapshot, &[root, "models", "providers", provider]) {
            return Some(config.clone());
        }
    }
    None
}

fn build_employee_model_registration_patch(snapshot: &Value, model_ref: &str) -> Option<Value> {
    let (provider, model_id) = model_ref.split_once('/')?;
    let provider = provider.trim();
    let model_id = model_id.trim();
    if provider.is_empty() || model_id.is_empty() {
        return None;
    }

    let mut allowed_models = existing_employee_model_allowlist(snapshot);
    let model_ref = format!("{provider}/{model_id}");
    let allowlist_changed = !allowed_models.contains_key(&model_ref);
    allowed_models.entry(model_ref).or_insert_with(|| json!({}));

    let provider_config = existing_employee_provider_config(snapshot, provider);
    let mut provider_patch = serde_json::Map::new();
    let mut provider_changed = false;
    if let Some(mut config) = provider_config {
        if config.get("baseUrl").and_then(Value::as_str).is_some() {
            let mut provider_models = normalize_provider_models_for_patch(
                config
                    .remove("models")
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or_else(|| existing_employee_provider_models(snapshot, provider)),
            );
            let has_provider_model = provider_models.iter().any(|entry| {
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| id == model_id)
                    .unwrap_or(false)
            });
            if !has_provider_model {
                provider_models.push(json!({
                    "id": model_id,
                    "name": display_name_for_model_id(model_id)
                }));
                provider_changed = true;
            }
            config.insert("models".to_string(), Value::Array(provider_models));
            if provider_changed {
                provider_patch.insert(provider.to_string(), Value::Object(config));
            }
        }
    }

    if !allowlist_changed && !provider_changed {
        return None;
    }

    let mut patch = json!({
        "agents": {
            "defaults": {
                "models": Value::Object(allowed_models)
            }
        }
    });

    if !provider_patch.is_empty() {
        patch["models"] = json!({
            "providers": Value::Object(provider_patch)
        });
    }

    Some(patch)
}

fn normalize_provider_models_for_patch(models: Vec<Value>) -> Vec<Value> {
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
            if has_name {
                return entry;
            }
            let mut object = entry.as_object().cloned().unwrap_or_default();
            object.insert(
                "name".to_string(),
                Value::String(display_name_for_model_id(id)),
            );
            Value::Object(object)
        })
        .collect()
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

async fn ensure_openclaw_employee_model_registered(
    profile: Option<&str>,
    model_ref: &str,
) -> Result<(), String> {
    let Some((provider, model_id)) = model_ref.split_once('/') else {
        return Ok(());
    };
    if provider.trim().is_empty() || model_id.trim().is_empty() {
        return Ok(());
    }

    let snapshot = openclaw_gateway::config_get(profile).await?;
    let Some(patch) = build_employee_model_registration_patch(&snapshot, model_ref) else {
        return Ok(());
    };
    openclaw_gateway::config_patch(profile, patch)
        .await
        .map(|_| ())
        .map_err(|error| format!("Uniopc 引擎 模型注册失败，无法创建可对话员工：{error}"))
}

fn trimmed_nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn employee_model_provider(model_ref: &str) -> Option<&str> {
    model_ref
        .split_once('/')
        .map(|(provider, _)| provider.trim())
}

fn is_blocked_employee_provider_status(status: Option<&str>) -> bool {
    matches!(
        status.map(str::trim),
        Some("cooldown" | "disabled" | "expired" | "missing")
    )
}

fn is_profile_default_employee_model(
    snapshot: &model::OpenClawModelsSnapshot,
    model_ref: &str,
) -> bool {
    trimmed_nonempty(snapshot.resolved_default_model.as_deref()) == Some(model_ref)
        || trimmed_nonempty(snapshot.primary_model.as_deref()) == Some(model_ref)
}

fn can_use_under_reported_employee_model(
    snapshot: &model::OpenClawModelsSnapshot,
    entry: &model::OpenClawModelCatalogEntry,
) -> bool {
    matches!(
        employee_model_provider(&entry.model_ref),
        Some("qwen" | "bailian-token-plan")
    ) && is_profile_default_employee_model(snapshot, &entry.model_ref)
        && !is_blocked_employee_provider_status(entry.provider_status.as_deref())
}

fn auth_profile_prefixes_for_employee_provider(provider: &str) -> Vec<String> {
    if provider == "openai-codex" {
        return vec!["openai-codex:".to_string(), "openai:".to_string()];
    }
    vec![format!("{provider}:")]
}

fn employee_provider_ready_from_auth_profiles(
    snapshot: &model::OpenClawModelsSnapshot,
    provider: &str,
) -> bool {
    let prefixes = auth_profile_prefixes_for_employee_provider(provider);
    snapshot.auth_profile_labels.iter().any(|label| {
        let trimmed = label.trim();
        !trimmed.contains('[') && prefixes.iter().any(|prefix| trimmed.starts_with(prefix))
    })
}

fn can_use_auth_profile_employee_model(
    snapshot: &model::OpenClawModelsSnapshot,
    entry: &model::OpenClawModelCatalogEntry,
) -> bool {
    let Some(provider) = employee_model_provider(&entry.model_ref) else {
        return false;
    };
    snapshot.runtime_compat_ready
        && is_profile_default_employee_model(snapshot, &entry.model_ref)
        && !is_blocked_employee_provider_status(entry.provider_status.as_deref())
        && employee_provider_ready_from_auth_profiles(snapshot, provider)
}

fn select_available_employee_model(
    snapshot: &model::OpenClawModelsSnapshot,
    requested: Option<&str>,
    existing: Option<&str>,
) -> Result<String, String> {
    let candidate = trimmed_nonempty(requested)
        .or_else(|| trimmed_nonempty(existing))
        .or_else(|| trimmed_nonempty(snapshot.resolved_default_model.as_deref()))
        .or_else(|| trimmed_nonempty(snapshot.primary_model.as_deref()))
        .ok_or_else(|| {
            "当前 Uniopc 引擎 profile 还没有默认模型，请先在 Profile 模型页完成模型配置。"
                .to_string()
        })?;

    let Some(entry) = snapshot
        .models
        .iter()
        .find(|entry| entry.model_ref == candidate)
    else {
        return Err(format!(
            "模型 `{candidate}` 不在当前 Uniopc 引擎 profile 的真实模型列表中，请先在 Profile 模型页完成模型配置。"
        ));
    };

    if !entry.provider_ready
        && !can_use_under_reported_employee_model(snapshot, entry)
        && !can_use_auth_profile_employee_model(snapshot, entry)
    {
        return Err(format!(
            "模型 `{candidate}` 尚未连接或授权不可用，请先在 Profile 模型页完成模型配置。"
        ));
    }

    Ok(candidate.to_string())
}

async fn resolve_available_employee_model(
    app: &AppHandle,
    profile: Option<String>,
    requested: Option<&str>,
    existing: Option<&str>,
) -> Result<String, String> {
    let snapshot = model::openclaw_models_snapshot(app.clone(), profile).await?;
    select_available_employee_model(&snapshot, requested, existing)
}

async fn activate_openclaw_employee(
    app: &AppHandle,
    job: EmployeeActivationJob,
) -> Result<OpenClawEmployee, String> {
    if let Some(model) = job.model.as_deref() {
        ensure_openclaw_employee_model_registered(job.profile.as_deref(), model).await?;
    }

    let value = match openclaw_gateway::agents_create_json(
        job.profile.as_deref(),
        &openclaw_gateway::GatewayAgentCreateRequest {
            agent_id: job.id.clone(),
            name: job.name.clone(),
            workspace: job.workspace_text.clone(),
            model: job.model.clone(),
            emoji: job.emoji.clone(),
        },
    )
    .await
    {
        Ok(value) => value,
        Err(gateway_error) => {
            let create_error = format!("Uniopc 引擎 agents.create failed: {gateway_error}");
            let agents = match load_openclaw_agents(&app, job.profile.as_deref()).await {
                Ok(agents) => agents,
                Err(list_error) => {
                    let combined =
                        format!("{create_error}\n\n复核 Uniopc 引擎 员工列表也失败：{list_error}");
                    return Err(humanize_openclaw_agents_error(&combined));
                }
            };

            if let Some(existing) = agents.into_iter().find(|item| item.id == job.id) {
                write_gateway_employee_files(&job).await?;
                return Ok(OpenClawEmployee {
                    name: job.name.clone(),
                    role: job.role.clone(),
                    description: job.description.clone(),
                    emoji: Some(job.emoji.clone()),
                    model: job.model.clone(),
                    status: "active".to_string(),
                    activation_error: None,
                    activated_at: Some(chrono::Utc::now().to_rfc3339()),
                    ..existing
                });
            }

            let message = humanize_openclaw_agents_error(&create_error);
            return Err(message);
        }
    };

    write_gateway_employee_files(&job).await?;

    let employee = load_openclaw_agents(&app, job.profile.as_deref())
        .await
        .ok()
        .and_then(|items| items.into_iter().find(|item| item.id == job.id))
        .unwrap_or_else(|| map_openclaw_employee(&value));
    Ok(employee)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawAgentTemplate {
    pub id: String,
    pub plugin_id: String,
    pub template_id: String,
    pub name: String,
    pub description: Option<String>,
    pub emoji: Option<String>,
    pub soul_md: Option<String>,
    pub agents_md: Option<String>,
    pub default_skill_ids: Vec<String>,
    pub required_plugin_ids: Vec<String>,
    pub model: Option<String>,
    // Display-only role metadata rendered by the create dialog's detail
    // panel; passed through verbatim from plugin.json.
    pub capabilities: Vec<Value>,
    pub style_tags: Vec<String>,
    pub work_modes: Vec<Value>,
}

/// Read a template-referenced markdown file, constrained to the plugin dir
/// (rejects absolute paths and `..` traversal).
fn read_template_md(plugin_dir: &Path, relative: Option<&str>) -> Option<String> {
    let relative = relative.map(str::trim).filter(|value| !value.is_empty())?;
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return None;
    }
    std::fs::read_to_string(plugin_dir.join(path)).ok()
}

fn template_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn template_value_list(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.is_object())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn agent_templates_from_plugin_dir(plugin_dir: &Path) -> Vec<OpenClawAgentTemplate> {
    let plugin_id = match plugin_dir.file_name().and_then(|name| name.to_str()) {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => return Vec::new(),
    };
    let manifest: Value = match std::fs::read_to_string(plugin_dir.join("plugin.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
    {
        Some(value) => value,
        None => return Vec::new(),
    };
    let Some(entries) = manifest.get("agentTemplates").and_then(Value::as_array) else {
        return Vec::new();
    };

    entries
        .iter()
        .filter_map(|entry| {
            let template_id = entry.get("id").and_then(Value::as_str)?.trim().to_string();
            let name = entry
                .get("name")
                .and_then(Value::as_str)?
                .trim()
                .to_string();
            if template_id.is_empty() || name.is_empty() {
                return None;
            }
            let text_field = |key: &str| {
                entry
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            let soul_md = text_field("soulMd").or_else(|| {
                read_template_md(plugin_dir, entry.get("soulMdFile").and_then(Value::as_str))
            });
            let agents_md = text_field("agentsMd").or_else(|| {
                read_template_md(
                    plugin_dir,
                    entry.get("agentsMdFile").and_then(Value::as_str),
                )
            });
            Some(OpenClawAgentTemplate {
                id: format!("{plugin_id}:{template_id}"),
                plugin_id: plugin_id.clone(),
                template_id,
                name,
                description: text_field("description"),
                emoji: text_field("emoji"),
                soul_md,
                agents_md,
                default_skill_ids: template_string_list(entry.get("defaultSkillIds")),
                required_plugin_ids: template_string_list(entry.get("requiredPluginIds")),
                model: text_field("model"),
                capabilities: template_value_list(entry.get("capabilities")),
                style_tags: template_string_list(entry.get("styleTags")),
                work_modes: template_value_list(entry.get("workModes")),
            })
        })
        .collect()
}

/// Aggregate the `agentTemplates` declared by installed plugins (the official
/// extensions dir). Role templates ship inside cloud-distributed plugin
/// packages — e.g. `uniopc-employee-roles` — so updating roles never requires
/// a desktop release.
#[tauri::command]
pub async fn openclaw_agent_templates_list() -> Result<Vec<OpenClawAgentTemplate>, String> {
    let extensions_dir = crate::services::openclaw_system_plugins::openclaw_extensions_dir()?;
    let entries = match std::fs::read_dir(&extensions_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut templates = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            templates.extend(agent_templates_from_plugin_dir(&path));
        }
    }
    templates.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(templates)
}

#[tauri::command]
pub async fn openclaw_agents_list(
    app: AppHandle,
    profile: Option<String>,
) -> Result<Vec<OpenClawEmployee>, String> {
    load_openclaw_agents(&app, profile.as_deref())
        .await
        .map_err(|error| humanize_openclaw_agents_error(&error))
}

#[tauri::command]
pub async fn openclaw_agent_documents_list(
    _app: AppHandle,
    agent_id: String,
    profile: Option<String>,
) -> Result<Vec<OpenClawEmployeeDocument>, String> {
    let agent_id = agent_id.trim();
    let items = openclaw_gateway::agent_file_descriptors(profile.as_deref(), agent_id)
        .await?
        .iter()
        .map(gateway_file_summary)
        .collect::<Vec<_>>();
    Ok(items)
}

#[tauri::command]
pub async fn openclaw_agent_document_get(
    _app: AppHandle,
    agent_id: String,
    relative_path: String,
    profile: Option<String>,
) -> Result<OpenClawEmployeeDocumentDetail, String> {
    let agent_id = agent_id.trim();
    let value =
        openclaw_gateway::agent_files_get(profile.as_deref(), agent_id, &relative_path).await?;
    gateway_file_detail(&relative_path, &value)
}

#[tauri::command]
pub async fn openclaw_agent_document_save(
    _app: AppHandle,
    agent_id: String,
    input: SaveOpenClawEmployeeDocumentInput,
    profile: Option<String>,
) -> Result<OpenClawEmployeeDocumentDetail, String> {
    let agent_id = agent_id.trim();
    let files = openclaw_gateway::agent_file_descriptors(profile.as_deref(), agent_id).await?;
    require_listed_agent_file(&files, &input.relative_path)?;
    let value = openclaw_gateway::listed_agent_file_set(
        profile.as_deref(),
        agent_id,
        &files,
        &input.relative_path,
        &input.content,
    )
    .await?;
    let detail = gateway_file_detail(&input.relative_path, &value).unwrap_or_else(|_| {
        OpenClawEmployeeDocumentDetail {
            relative_path: input.relative_path.clone(),
            title: employee_doc_title(&input.relative_path),
            kind: employee_doc_kind(&input.relative_path),
            content: input.content,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    });
    Ok(detail)
}

#[tauri::command]
pub async fn openclaw_agents_create(
    app: AppHandle,
    req: CreateOpenClawEmployeeRequest,
) -> Result<OpenClawEmployee, String> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err("员工名称不能为空。".to_string());
    }

    let role = req.role.as_deref().unwrap_or("通用员工").trim().to_string();
    let description = req
        .description
        .as_deref()
        .unwrap_or("负责持续对话、整理任务并推动业务下一步。")
        .trim()
        .to_string();
    let emoji = req.emoji.as_deref().unwrap_or("🤖").trim().to_string();
    let model = match trimmed_nonempty(req.model.as_deref()) {
        Some(requested) => Some(
            resolve_available_employee_model(&app, req.profile.clone(), Some(requested), None)
                .await?,
        ),
        None => None,
    };

    let id = slugify_employee_id(name);
    if is_reserved_profile_agent_id(&id) {
        return Err(
            "`main` 是每个 Uniopc 引擎 profile 的默认 AI 员工，不能作为新员工 id。".to_string(),
        );
    }
    let workspace = employee_workspace_dir_for_profile(req.profile.as_deref(), &id)?;
    let workspace_text = workspace.to_string_lossy().to_string();
    let job = EmployeeActivationJob {
        id: id.clone(),
        name: name.to_string(),
        role: role.clone(),
        description: description.clone(),
        emoji: emoji.clone(),
        model: model.clone(),
        profile: req.profile.clone(),
        workspace_text: workspace_text.clone(),
        soul_md: req.soul_md.clone(),
        agents_md: req.agents_md.clone(),
    };

    let employee = activate_openclaw_employee(&app, job).await?;
    if employee.status == "activation_failed" {
        return Err(employee
            .activation_error
            .clone()
            .unwrap_or_else(|| "Uniopc 引擎 创建 AI 员工失败。".to_string()));
    }

    // Template skills are NOT bound here: gateway 2026.6.11 `agents.update`
    // rejects a root `skills` property (per-agent skills are a workspace
    // concept upstream). The frontend attempts a soft bind via
    // `openclaw_agent_skills_set` after creation and downgrades failure to a
    // notice — the skills are global plugin skills, so the employee can
    // already use them either way.
    Ok(employee)
}

#[tauri::command]
pub async fn openclaw_agents_update(
    app: AppHandle,
    req: UpdateOpenClawEmployeeRequest,
) -> Result<OpenClawEmployee, String> {
    let agent_id = req.id.trim().to_string();
    if agent_id.is_empty() {
        return Err("员工 id 不能为空。".to_string());
    }
    let agents = load_openclaw_agents(&app, req.profile.as_deref()).await?;
    let current = agents
        .into_iter()
        .find(|item| item.id == agent_id)
        .ok_or_else(|| "找不到要更新的员工。".to_string())?;

    let name = req
        .name
        .as_deref()
        .unwrap_or(&current.name)
        .trim()
        .to_string();
    let role = req
        .role
        .as_deref()
        .unwrap_or(&current.role)
        .trim()
        .to_string();
    let description = req
        .description
        .as_deref()
        .unwrap_or(&current.description)
        .trim()
        .to_string();
    let emoji = req
        .emoji
        .as_deref()
        .unwrap_or(current.emoji.as_deref().unwrap_or("🤖"))
        .trim()
        .to_string();
    let model = match trimmed_nonempty(req.model.as_deref())
        .or_else(|| trimmed_nonempty(current.model.as_deref()))
    {
        Some(candidate) => Some(
            resolve_available_employee_model(&app, req.profile.clone(), Some(candidate), None)
                .await?,
        ),
        None => None,
    };
    if let Some(model) = model.as_deref() {
        ensure_openclaw_employee_model_registered(req.profile.as_deref(), model).await?;
    }
    if should_update_gateway_agent_metadata(&agent_id) {
        let mut patch = json!({
            "name": name.clone(),
            "emoji": emoji.clone()
        });
        if let Some(model) = model.as_ref() {
            patch["model"] = Value::String(model.clone());
        }
        openclaw_gateway::agents_update_json(req.profile.as_deref(), agent_id.as_str(), patch)
            .await?;
    }

    if let Some(raw_thinking) = req.thinking_default.as_deref() {
        let thinking_default = normalize_agent_thinking_default(raw_thinking)?;
        set_agent_thinking_default(req.profile.as_deref(), &agent_id, &thinking_default).await?;
    }

    let files = openclaw_gateway::agent_file_descriptors(req.profile.as_deref(), &agent_id).await?;
    require_listed_agent_file(&files, "AGENTS.md")?;
    openclaw_gateway::listed_agent_file_set(
        req.profile.as_deref(),
        &agent_id,
        &files,
        "AGENTS.md",
        &agents_file_content(&name, &role, &description),
    )
    .await?;

    let updated = load_openclaw_agents(&app, req.profile.as_deref()).await?;
    let refreshed = updated
        .into_iter()
        .find(|item| item.id == agent_id)
        .ok_or_else(|| "更新员工后未能重新读取该员工。".to_string())?;
    let employee = OpenClawEmployee {
        name: name.clone(),
        role: role.clone(),
        description: description.clone(),
        emoji: Some(emoji.clone()),
        model: model.clone(),
        ..refreshed
    };
    Ok(employee)
}

#[tauri::command]
pub async fn openclaw_agents_delete(
    _app: AppHandle,
    id: String,
    profile: Option<String>,
) -> Result<DeleteOpenClawEmployeeResult, String> {
    let normalized = id.trim();
    if normalized.is_empty() {
        return Err("缺少员工 id。".to_string());
    }
    if is_reserved_profile_agent_id(normalized) {
        return Err("默认 AI 员工 `main` 属于当前业务空间 profile，不能删除。".to_string());
    }

    openclaw_gateway::agents_delete(profile.as_deref(), normalized, true)
        .await
        .map_err(|error| format!("Uniopc 引擎 agents.delete failed: {error}"))?;
    Ok(DeleteOpenClawEmployeeResult {
        id: normalized.to_string(),
        deleted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_only_gateway_startup_transport_errors() {
        assert!(is_gateway_starting_transport_error(
            "IO error: Connection refused (os error 61)"
        ));
        assert!(is_gateway_starting_transport_error(
            "connection reset by peer"
        ));
        assert!(!is_gateway_starting_transport_error(
            "device authentication rejected"
        ));
        assert!(!is_gateway_starting_transport_error(
            "gateway returned 401 unauthorized"
        ));
    }

    #[test]
    fn agent_capability_patch_sets_and_clears_skills_and_tools_deny() {
        let snapshot = json!({
            "parsed": { "agents": { "list": [
                { "id": "main" },
                { "id": "writer", "thinkingDefault": "low",
                  "tools": { "deny": ["old_tool"], "profile": "full" },
                  "skills": ["docx"] }
            ] } }
        });

        // 设置技能白名单 + 工具屏蔽,保留 entry 其它字段与 tools.profile
        let patch = build_agent_capability_patch(
            &snapshot,
            "writer",
            Some(&["pptx".to_string(), "pdf".to_string()]),
            Some(&["socials_search".to_string()]),
        );
        let entry = &patch["agents"]["list"][1];
        assert_eq!(entry["skills"], json!(["pptx", "pdf"]));
        assert_eq!(entry["tools"]["deny"], json!(["socials_search"]));
        assert_eq!(entry["tools"]["profile"], json!("full"));
        assert_eq!(entry["thinkingDefault"], json!("low"));
        assert_eq!(patch["agents"]["list"][0], json!({ "id": "main" }));

        // 清空 = 移除键(绝不写空数组,引擎会解读为全部拒绝)
        let cleared = build_agent_capability_patch(&snapshot, "writer", Some(&[]), Some(&[]));
        let entry = cleared["agents"]["list"][1].as_object().unwrap();
        assert!(!entry.contains_key("skills"));
        assert_eq!(entry["tools"], json!({ "profile": "full" }));

        // 不存在的 agent:补 main 占位并追加新条目
        let empty = json!({ "parsed": { "agents": {} } });
        let created =
            build_agent_capability_patch(&empty, "newbie", Some(&["docx".to_string()]), None);
        let list = created["agents"]["list"].as_array().unwrap();
        assert_eq!(list[0], json!({ "id": "main" }));
        assert_eq!(list[1]["id"], json!("newbie"));
        assert_eq!(list[1]["skills"], json!(["docx"]));
    }

    #[test]
    fn agent_capability_states_distinguish_no_filter_from_allowlist() {
        let snapshot = json!({
            "parsed": { "agents": { "list": [
                { "id": "main" },
                { "id": "writer", "skills": ["docx"], "tools": { "deny": ["x_tool"] } }
            ] } }
        });
        let states = agent_capability_states(&snapshot);
        assert_eq!(states.len(), 2);
        assert_eq!(states[0].skills, None);
        assert!(states[0].tools_deny.is_empty());
        assert_eq!(states[1].skills, Some(vec!["docx".to_string()]));
        assert_eq!(states[1].tools_deny, vec!["x_tool".to_string()]);
    }

    #[test]
    fn agent_templates_parse_manifest_and_reject_traversal() {
        let dir = std::env::temp_dir().join(format!(
            "uniopc-agent-templates-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let plugin_dir = dir.join("uniopc-employee-roles");
        std::fs::create_dir_all(plugin_dir.join("templates/demo")).unwrap();
        std::fs::write(plugin_dir.join("templates/demo/SOUL.md"), "# soul").unwrap();
        std::fs::write(plugin_dir.join("templates/demo/AGENTS.md"), "# agents").unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            serde_json::to_string(&json!({
                "name": "uniopc-employee-roles",
                "agentTemplates": [
                    {
                        "id": "demo",
                        "name": "演示角色",
                        "description": "desc",
                        "emoji": "📣",
                        "soulMdFile": "templates/demo/SOUL.md",
                        "agentsMdFile": "templates/demo/AGENTS.md",
                        "defaultSkillIds": ["docx", " docx ", ""],
                        "requiredPluginIds": ["uniopc-documents"]
                    },
                    { "id": "", "name": "无 id 跳过" },
                    {
                        "id": "evil",
                        "name": "越界",
                        "soulMdFile": "../../outside.md"
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let templates = agent_templates_from_plugin_dir(&plugin_dir);
        assert_eq!(templates.len(), 2);
        let demo = &templates[0];
        assert_eq!(demo.id, "uniopc-employee-roles:demo");
        assert_eq!(demo.plugin_id, "uniopc-employee-roles");
        assert_eq!(demo.name, "演示角色");
        assert_eq!(demo.soul_md.as_deref(), Some("# soul"));
        assert_eq!(demo.agents_md.as_deref(), Some("# agents"));
        assert_eq!(
            demo.default_skill_ids,
            vec!["docx".to_string(), "docx".to_string()]
        );
        assert_eq!(
            demo.required_plugin_ids,
            vec!["uniopc-documents".to_string()]
        );
        let evil = templates.iter().find(|t| t.template_id == "evil").unwrap();
        assert_eq!(evil.soul_md, None);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn agent_thinking_default_normalization_accepts_gateway_levels_only() {
        assert_eq!(normalize_agent_thinking_default(""), Ok(String::new()));
        assert_eq!(
            normalize_agent_thinking_default(" OFF "),
            Ok("off".to_string())
        );
        assert_eq!(
            normalize_agent_thinking_default("low"),
            Ok("low".to_string())
        );
        assert!(normalize_agent_thinking_default("超级思考").is_err());
    }

    #[test]
    fn agent_thinking_default_patch_rewrites_only_target_entry() {
        let snapshot = serde_json::json!({
            "parsed": {
                "agents": {
                    "list": [
                        { "id": "main", "name": "主员工" },
                        { "id": "sales", "name": "销售", "thinkingDefault": "off" }
                    ]
                }
            }
        });

        let patch = build_agent_thinking_default_patch(&snapshot, "sales", "low");
        assert_eq!(
            patch.pointer("/agents/list/1/thinkingDefault"),
            Some(&serde_json::json!("low"))
        );
        assert_eq!(patch.pointer("/agents/list/0/thinkingDefault"), None);
        assert_eq!(
            patch.pointer("/agents/list/0/name"),
            Some(&serde_json::json!("主员工"))
        );

        // "" 清除覆盖，回到跟随默认。
        let cleared = build_agent_thinking_default_patch(&snapshot, "sales", "");
        assert_eq!(cleared.pointer("/agents/list/1/thinkingDefault"), None);

        // 配置里还没有条目时补一个，且保住隐式 main 占位。
        let empty = serde_json::json!({ "parsed": {} });
        let created = build_agent_thinking_default_patch(&empty, "sales", "low");
        assert_eq!(
            created.pointer("/agents/list/0/id"),
            Some(&serde_json::json!("main"))
        );
        assert_eq!(
            created.pointer("/agents/list/1/id"),
            Some(&serde_json::json!("sales"))
        );
        assert_eq!(
            created.pointer("/agents/list/1/thinkingDefault"),
            Some(&serde_json::json!("low"))
        );
    }

    #[test]
    fn main_agent_is_reserved_for_profile_default_employee() {
        assert!(is_reserved_profile_agent_id("main"));
        assert!(is_reserved_profile_agent_id(" main "));
        assert!(!is_reserved_profile_agent_id("sales"));
    }

    #[test]
    fn bare_main_agent_falls_back_to_branded_assistant_persona() {
        let item = serde_json::json!({
            "id": "main",
            "workspace": "/tmp/missing-workspace",
            "agentDir": "/tmp/agent",
            "isDefault": true
        });

        let employee = map_openclaw_employee(&item);

        assert_eq!(employee.name, DEFAULT_ASSISTANT_NAME);
        assert_eq!(employee.role, DEFAULT_ASSISTANT_ROLE);
        assert_eq!(employee.description, DEFAULT_ASSISTANT_DESCRIPTION);
        assert_eq!(employee.emoji.as_deref(), Some(DEFAULT_ASSISTANT_EMOJI));
        assert!(employee.is_default);
    }

    #[test]
    fn default_agent_ignores_main_as_a_gateway_identity_name() {
        let item = serde_json::json!({
            "id": "main",
            "identityName": "main",
            "workspace": "/tmp/missing-workspace",
            "agentDir": "/tmp/agent",
            "isDefault": true
        });

        let employee = map_openclaw_employee(&item);

        assert_eq!(employee.name, DEFAULT_ASSISTANT_NAME);
    }

    #[test]
    fn non_reserved_agent_keeps_generic_fallbacks() {
        let item = serde_json::json!({
            "id": "sales",
            "workspace": "/tmp/missing-workspace",
            "agentDir": "/tmp/agent"
        });

        let employee = map_openclaw_employee(&item);

        assert_eq!(employee.name, "sales");
        assert_eq!(employee.role, "AI员工");
        assert_eq!(employee.emoji, None);
        assert!(!employee.is_default);
    }

    #[test]
    fn seeded_default_assistant_identity_round_trips_to_display_fields() {
        let identity = identity_file_content(
            DEFAULT_ASSISTANT_NAME,
            Some(DEFAULT_ASSISTANT_EMOJI),
            Some(DEFAULT_ASSISTANT_ROLE),
        );
        let parsed = identity_info_from_markdown(&identity);
        assert_eq!(parsed.name.as_deref(), Some(DEFAULT_ASSISTANT_NAME));
        assert_eq!(parsed.emoji.as_deref(), Some(DEFAULT_ASSISTANT_EMOJI));

        let agents = agents_file_content(
            DEFAULT_ASSISTANT_NAME,
            DEFAULT_ASSISTANT_ROLE,
            DEFAULT_ASSISTANT_DESCRIPTION,
        );
        let instructions = agent_instructions_from_markdown(&agents);
        assert_eq!(instructions.role.as_deref(), Some(DEFAULT_ASSISTANT_ROLE));
        assert_eq!(
            instructions.description.as_deref(),
            Some(DEFAULT_ASSISTANT_DESCRIPTION)
        );
    }

    #[test]
    fn employee_activation_documents_keep_tool_guidance_in_agents_md() {
        let job = EmployeeActivationJob {
            id: "elon".to_string(),
            name: "Elon".to_string(),
            role: "CEO".to_string(),
            description: "负责公司整体业务".to_string(),
            emoji: "🤖".to_string(),
            model: None,
            profile: None,
            workspace_text: String::new(),
            soul_md: None,
            agents_md: None,
        };

        let documents = employee_activation_documents(&job);
        let paths = documents
            .iter()
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec!["IDENTITY.md", "AGENTS.md", "USER.md", "MEMORY.md"]
        );
        let agents = documents
            .iter()
            .find_map(|(path, content)| (path == "AGENTS.md").then_some(content))
            .expect("AGENTS.md should be written");
        assert!(agents.contains("## Tools"));
        assert!(agents.contains("先阅读当前工作区文档，再执行动作。"));
    }

    #[test]
    fn employee_activation_documents_preserve_a_template_tools_section() {
        let job = EmployeeActivationJob {
            id: "elon".to_string(),
            name: "Elon".to_string(),
            role: "CEO".to_string(),
            description: "负责公司整体业务".to_string(),
            emoji: "🤖".to_string(),
            model: None,
            profile: None,
            workspace_text: String::new(),
            soul_md: None,
            agents_md: Some("# Elon\n\n## Tools\n- 仅允许使用 CRM".to_string()),
        };

        let agents = employee_activation_documents(&job)
            .into_iter()
            .find_map(|(path, content)| (path == "AGENTS.md").then_some(content))
            .expect("AGENTS.md should be written");
        assert_eq!(agents.matches("## Tools").count(), 1);
        assert!(agents.contains("- 仅允许使用 CRM"));
    }

    #[test]
    fn gateway_file_access_is_limited_to_the_list_response() {
        let payload = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/openclaw-2026.8.1/agent-files.json"
        )))
        .expect("fixture JSON");
        let files = AgentFileDescriptor::from_list_payload(payload).expect("captured files list");

        assert!(require_listed_agent_file(&files, "AGENTS.md").is_ok());
        assert!(require_listed_agent_file(&files, "TOOLS.md").is_err());
        assert!(require_listed_agent_file(&files, "IDENTITY.md").is_err());
    }

    #[test]
    fn custom_agents_profile_is_not_seeded_or_reverted_to_defaults() {
        let files = vec![AgentFileDescriptor {
            name: "AGENTS.md".to_string(),
            missing: false,
            expected_absent: false,
            size: Some(128),
            updated_at_ms: Some(1),
        }];
        let mut employee = map_openclaw_employee(&json!({ "id": "main", "isDefault": true }));
        let custom = "# 用户自定义助理\n\n## 角色\n增长顾问\n\n## 主要职责\n保留用户设置";

        let should_seed = apply_listed_agent_profile(&mut employee, &files, Some(custom));

        assert!(!should_seed);
        assert_eq!(employee.name, "用户自定义助理");
        assert_eq!(employee.role, "增长顾问");
        assert_eq!(employee.description, "保留用户设置");
    }

    #[test]
    fn default_agent_ignores_the_workspace_template_heading() {
        let files = vec![AgentFileDescriptor {
            name: "AGENTS.md".to_string(),
            missing: false,
            expected_absent: false,
            size: Some(128),
            updated_at_ms: Some(1),
        }];
        let mut employee = map_openclaw_employee(&json!({ "id": "main", "isDefault": true }));
        let template = "# AGENTS.md - Your Workspace\n\nKeep workspace conventions here.";

        let should_seed = apply_listed_agent_profile(&mut employee, &files, Some(template));

        assert!(!should_seed);
        assert_eq!(employee.name, DEFAULT_ASSISTANT_NAME);
    }

    #[test]
    fn default_seed_requires_agents_to_be_listed_and_missing() {
        let existing = AgentFileDescriptor {
            name: "AGENTS.md".to_string(),
            missing: false,
            expected_absent: false,
            size: Some(1),
            updated_at_ms: None,
        };
        let missing = AgentFileDescriptor { missing: true, size: None, ..existing.clone() };

        assert!(!default_agent_seed_needed(&[existing]));
        assert!(default_agent_seed_needed(&[missing]));
        assert!(!default_agent_seed_needed(&[]));
    }

    #[test]
    fn reserved_main_uses_identity_files_as_gateway_update_surface() {
        assert!(!should_update_gateway_agent_metadata("main"));
        assert!(!should_update_gateway_agent_metadata(" main "));
        assert!(should_update_gateway_agent_metadata("sales"));
    }

    #[test]
    fn retries_transient_gateway_file_write_errors_after_create() {
        assert!(is_transient_gateway_employee_write_error(
            "连接 Uniopc 引擎 失败: IO error: Connection refused (os error 61)"
        ));
        assert!(is_transient_gateway_employee_write_error(
            r#"Uniopc 引擎 agent "employee-abc" not found"#
        ));
        assert!(!is_transient_gateway_employee_write_error(
            "Gateway agents.files.set 参数无效"
        ));
    }

    #[test]
    fn humanizes_openclaw_plugin_runtime_cache_errors() {
        let error = "OpenClaw PluginLoadFailureError: plugin load failed: qqbot: Error: ENOTEMPTY: directory not empty, rmdir '/Users/lan/.openclaw/plugin-runtime-deps/openclaw-2026.4.24/dist/extensions/qqbot'";
        let message = humanize_openclaw_agents_error(error);

        assert!(message.contains("Uniopc 引擎 插件缓存"));
        assert!(message.contains("运行中心"));
        assert!(message.contains("原始错误摘要"));
        assert!(!message.contains("loader-"));
        assert!(!message.to_ascii_lowercase().contains("openclaw"));
    }

    #[test]
    fn leaves_unrelated_openclaw_agent_errors_unchanged() {
        let error = "Uniopc 引擎 profile 没有返回可用 agent。";
        assert_eq!(humanize_openclaw_agents_error(error), error);
    }

    #[test]
    fn maps_gateway_identity_fields_into_employee_display() {
        let item = serde_json::json!({
            "id": "main",
            "identityName": "Main Agent",
            "identityEmoji": "robot",
            "workspace": "/tmp/missing-workspace",
            "agentDir": "/tmp/agent",
            "model": "qwen/qwen3.7-plus",
            "isDefault": true
        });

        let employee = map_openclaw_employee(&item);

        assert_eq!(employee.name, "Main Agent");
        assert_eq!(employee.emoji.as_deref(), Some("robot"));
    }

    #[test]
    fn maps_gateway_nested_identity_fields_into_employee_display() {
        let item = serde_json::json!({
            "id": "employee-cto",
            "identity": {
                "name": "张小龙",
                "emoji": "🤖"
            },
            "workspace": "/tmp/missing-workspace",
            "model": {
                "primary": "qwen/qwen3.7-plus"
            },
            "isDefault": false
        });

        let employee = map_openclaw_employee(&item);

        assert_eq!(employee.name, "张小龙");
        assert_eq!(employee.emoji.as_deref(), Some("🤖"));
    }

    #[test]
    fn employee_model_registration_patch_preserves_custom_provider_config() {
        let snapshot = json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "model": {
                            "primary": "anthropic/claude-sonnet-4-6"
                        },
                        "models": {
                            "anthropic/claude-sonnet-4-6": {}
                        }
                    }
                },
                "models": {
                    "providers": {
                        "acme": {
                            "baseUrl": "https://models.example.test/v1",
                            "api": "openai-completions",
                            "models": [
                                { "id": "small" }
                            ]
                        }
                    }
                }
            }
        });

        let patch = build_employee_model_registration_patch(&snapshot, "acme/large").unwrap();
        let allowlist = patch
            .pointer("/agents/defaults/models")
            .and_then(Value::as_object)
            .expect("patch should include allowed models");
        let provider_models = patch
            .pointer("/models/providers/acme/models")
            .and_then(Value::as_array)
            .expect("patch should include provider model registry");

        assert!(allowlist.contains_key("anthropic/claude-sonnet-4-6"));
        assert!(allowlist.contains_key("acme/large"));
        assert_eq!(patch.pointer("/agents/defaults/model/primary"), None);
        assert_eq!(
            patch.pointer("/models/providers/acme/baseUrl"),
            Some(&Value::String("https://models.example.test/v1".to_string()))
        );
        assert!(provider_models
            .iter()
            .any(
                |entry| entry.get("id").and_then(Value::as_str) == Some("small")
                    && entry.get("name").and_then(Value::as_str) == Some("Small")
            ));
        assert!(provider_models
            .iter()
            .any(
                |entry| entry.get("id").and_then(Value::as_str) == Some("large")
                    && entry.get("name").and_then(Value::as_str) == Some("Large")
            ));
    }

    #[test]
    fn employee_model_registration_patch_does_not_create_invalid_builtin_provider_overlay() {
        let snapshot = json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "models": {
                            "anthropic/claude-sonnet-4-6": {}
                        }
                    }
                },
                "models": {
                    "providers": {
                        "openai-codex": {
                            "models": [
                                { "id": "gpt-5.4" }
                            ]
                        }
                    }
                }
            }
        });

        let patch =
            build_employee_model_registration_patch(&snapshot, "openai-codex/gpt-5.5").unwrap();
        let allowlist = patch
            .pointer("/agents/defaults/models")
            .and_then(Value::as_object)
            .expect("patch should include allowed models");

        assert!(allowlist.contains_key("anthropic/claude-sonnet-4-6"));
        assert!(allowlist.contains_key("openai-codex/gpt-5.5"));
        assert_eq!(patch.pointer("/models/providers/openai-codex"), None);
    }

    #[test]
    fn employee_model_registration_patch_skips_when_model_is_already_registered() {
        let snapshot = json!({
            "parsed": {
                "agents": {
                    "defaults": {
                        "models": {
                            "openai-codex/gpt-5.5": {}
                        }
                    }
                },
                "models": {
                    "providers": {
                        "openai-codex": {
                            "models": [
                                { "id": "gpt-5.5" }
                            ]
                        }
                    }
                }
            }
        });

        assert_eq!(
            build_employee_model_registration_patch(&snapshot, "openai-codex/gpt-5.5"),
            None
        );
    }

    #[test]
    fn employee_model_selection_requires_ready_gateway_model() {
        let snapshot = crate::commands::model::OpenClawModelsSnapshot {
            primary_model: Some("openai-codex/gpt-5.5".to_string()),
            resolved_default_model: Some("openai-codex/gpt-5.5".to_string()),
            fallback_models: Vec::new(),
            image_generation_model: None,
            video_generation_model: None,
            tts_model: None,
            tts_voice: None,
            stt_model: None,
            models: vec![
                crate::commands::model::OpenClawModelCatalogEntry {
                    model_ref: "openai-codex/gpt-5.5".to_string(),
                    provider: "openai-codex".to_string(),
                    model: "gpt-5.5".to_string(),
                    display_name: "GPT-5.5".to_string(),
                    configured: true,
                    catalog_available: true,
                    provider_ready: false,
                    provider_status: Some("missing".to_string()),
                },
                crate::commands::model::OpenClawModelCatalogEntry {
                    model_ref: "qwen/qwen3.7-plus".to_string(),
                    provider: "qwen".to_string(),
                    model: "qwen3.7-plus".to_string(),
                    display_name: "Qwen 3.7 Plus".to_string(),
                    configured: true,
                    catalog_available: true,
                    provider_ready: true,
                    provider_status: None,
                },
            ],
            providers: Vec::new(),
            auth_profile_labels: Vec::new(),
            runtime_compat_ready: true,
            runtime_compat_message: None,
        };

        assert!(select_available_employee_model(&snapshot, None, None).is_err());
        assert!(
            select_available_employee_model(&snapshot, Some("openai-codex/gpt-5.5"), None).is_err()
        );
        assert_eq!(
            select_available_employee_model(&snapshot, Some("qwen/qwen3.7-plus"), None).unwrap(),
            "qwen/qwen3.7-plus"
        );
    }

    #[test]
    fn employee_model_selection_allows_current_qwen_profile_default_when_readiness_is_under_reported(
    ) {
        let snapshot = crate::commands::model::OpenClawModelsSnapshot {
            primary_model: Some("qwen/qwen3.7-plus".to_string()),
            resolved_default_model: Some("qwen/qwen3.7-plus".to_string()),
            fallback_models: Vec::new(),
            image_generation_model: None,
            video_generation_model: None,
            tts_model: None,
            tts_voice: None,
            stt_model: None,
            models: vec![crate::commands::model::OpenClawModelCatalogEntry {
                model_ref: "qwen/qwen3.7-plus".to_string(),
                provider: "qwen".to_string(),
                model: "qwen3.7-plus".to_string(),
                display_name: "Qwen 3.7 Plus".to_string(),
                configured: true,
                catalog_available: true,
                provider_ready: false,
                provider_status: None,
            }],
            providers: Vec::new(),
            auth_profile_labels: Vec::new(),
            runtime_compat_ready: true,
            runtime_compat_message: None,
        };

        assert_eq!(
            select_available_employee_model(&snapshot, None, None).unwrap(),
            "qwen/qwen3.7-plus"
        );
    }

    #[test]
    fn employee_model_selection_allows_current_token_plan_profile_default_when_readiness_is_under_reported(
    ) {
        let snapshot = crate::commands::model::OpenClawModelsSnapshot {
            primary_model: Some("bailian-token-plan/qwen3.7-plus".to_string()),
            resolved_default_model: Some("bailian-token-plan/qwen3.7-plus".to_string()),
            fallback_models: Vec::new(),
            image_generation_model: None,
            video_generation_model: None,
            tts_model: None,
            tts_voice: None,
            stt_model: None,
            models: vec![crate::commands::model::OpenClawModelCatalogEntry {
                model_ref: "bailian-token-plan/qwen3.7-plus".to_string(),
                provider: "bailian-token-plan".to_string(),
                model: "qwen3.7-plus".to_string(),
                display_name: "qwen3.7-Plus".to_string(),
                configured: true,
                catalog_available: true,
                provider_ready: false,
                provider_status: None,
            }],
            providers: Vec::new(),
            auth_profile_labels: Vec::new(),
            runtime_compat_ready: true,
            runtime_compat_message: None,
        };

        assert_eq!(
            select_available_employee_model(&snapshot, None, None).unwrap(),
            "bailian-token-plan/qwen3.7-plus"
        );
    }

    #[test]
    fn employee_model_selection_allows_current_codex_default_when_auth_profile_is_ready() {
        let snapshot = crate::commands::model::OpenClawModelsSnapshot {
            primary_model: Some("openai-codex/gpt-5.5".to_string()),
            resolved_default_model: Some("openai-codex/gpt-5.5".to_string()),
            fallback_models: Vec::new(),
            image_generation_model: None,
            video_generation_model: None,
            tts_model: None,
            tts_voice: None,
            stt_model: None,
            models: vec![crate::commands::model::OpenClawModelCatalogEntry {
                model_ref: "openai-codex/gpt-5.5".to_string(),
                provider: "openai-codex".to_string(),
                model: "gpt-5.5".to_string(),
                display_name: "GPT-5.5".to_string(),
                configured: true,
                catalog_available: true,
                provider_ready: false,
                provider_status: None,
            }],
            providers: Vec::new(),
            auth_profile_labels: vec!["openai-codex:codex-cli".to_string()],
            runtime_compat_ready: true,
            runtime_compat_message: None,
        };

        assert_eq!(
            select_available_employee_model(&snapshot, None, None).unwrap(),
            "openai-codex/gpt-5.5"
        );
    }

    #[test]
    fn employee_runtime_crud_does_not_hide_gateway_failures_with_cli_fallback() {
        let source = include_str!("openclaw_agents.rs");
        let fallback_phrase = ["falling back to ", "CLI"].concat();

        assert!(!source.contains(&fallback_phrase));
    }

    #[test]
    fn openclaw_agents_list_does_not_persist_gateway_agents_to_local_db() {
        let source = include_str!("openclaw_agents.rs");

        assert!(!source.contains(&["sync_openclaw_", "employees("].concat()));
        assert!(!source.contains(&["merge_local_runtime_", "employees("].concat()));
        assert!(!source.contains(&["load_local_openclaw_", "employees("].concat()));
        assert!(!source.contains(&["Db", "Pool"].concat()));
        assert!(!source.contains(&["rusq", "lite"].concat()));
    }
}
