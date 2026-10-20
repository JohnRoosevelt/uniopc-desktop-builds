use super::{
    build_gateway_session_create_params, build_gateway_session_list_params, json_trimmed_string_at,
    normalize_gateway_thinking_override, parse_gateway_session_list,
    ConversationSessionCreateRequest, ConversationSessionCreateResult,
    ConversationSessionFilesRequest, ConversationSessionListRequest, ConversationSessionListResult,
    ConversationSessionModelRequest, ConversationSessionModelResult,
    ConversationSessionPermissionRequest, ConversationSessionReasoningRequest,
    ConversationSessionReasoningResult, ConversationSessionRenameRequest,
    ConversationSessionRenameResult, ConversationSessionStateRequest,
    ConversationSessionThinkingRequest, ConversationSessionThinkingResult, TARGET_TRANSPORT,
};
use crate::commands::model::openclaw_ready_model_refs_for_profile;
use crate::services::{openclaw_connection, openclaw_gateway_connection};
use serde_json::{json, Value};
use tauri::AppHandle;

pub(super) fn build_session_control_patch(approval_mode: Option<&str>) -> Result<Value, String> {
    let mut patch = serde_json::Map::new();
    match approval_mode
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
    {
        "default" | "inherit" | "inherited" => {
            patch.insert("permissionMode".to_string(), Value::Null);
        }
        "read_only" | "read-only" => {
            patch.insert("permissionMode".to_string(), json!("read-only"));
        }
        "guarded" | "ask_on_risk" | "safe_execute" | "ask_before" | "always_ask" => {
            patch.insert("permissionMode".to_string(), json!("guarded"));
        }
        "workspace" => {
            patch.insert("permissionMode".to_string(), json!("workspace"));
        }
        "direct" | "full" | "full_trust" => {
            patch.insert("permissionMode".to_string(), json!("full"));
        }
        value => return Err(format!("未知 Uniopc 引擎 执行策略: {value}")),
    }

    Ok(Value::Object(patch))
}

pub(super) fn build_session_state_patch(
    action: &str,
    session_id: Option<&str>,
) -> Result<Value, String> {
    let action = action.trim();
    let mut patch = serde_json::Map::new();
    match action {
        "archive" => {
            let session_id = session_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "归档会话需要 Gateway session id，请先刷新会话列表。".to_string())?;
            patch.insert("archived".to_string(), json!(true));
            patch.insert("expectedSessionId".to_string(), json!(session_id));
        }
        "restore" => {
            patch.insert("archived".to_string(), json!(false));
        }
        "pin" => {
            patch.insert("pinned".to_string(), json!(true));
        }
        "unpin" => {
            patch.insert("pinned".to_string(), json!(false));
        }
        "mark_unread" => {
            patch.insert("unread".to_string(), json!(true));
        }
        "mark_read" => {
            patch.insert("unread".to_string(), json!(false));
        }
        _ => return Err(format!("未知 Uniopc 引擎 会话操作: {action}")),
    }
    Ok(Value::Object(patch))
}

pub(super) fn build_session_label_patch(label: &str) -> Result<Value, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("聊天名称不能为空。".to_string());
    }
    let mut patch = serde_json::Map::new();
    patch.insert("label".to_string(), json!(label));
    Ok(Value::Object(patch))
}

pub(super) fn build_session_model_patch(model: Option<&str>) -> Result<Value, String> {
    let mut patch = serde_json::Map::new();
    match model.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            patch.insert("model".to_string(), json!(value));
        }
        None => {
            patch.insert("model".to_string(), Value::Null);
        }
    }
    Ok(Value::Object(patch))
}

pub(super) fn build_session_thinking_patch(
    thinking_level: Option<&str>,
) -> Result<(Value, Option<String>), String> {
    let mut patch = serde_json::Map::new();
    match normalize_gateway_thinking_override(thinking_level)? {
        Some(level) => {
            patch.insert("thinkingLevel".to_string(), json!(level));
            Ok((Value::Object(patch), Some(level.to_string())))
        }
        None => {
            patch.insert("thinkingLevel".to_string(), Value::Null);
            Ok((Value::Object(patch), None))
        }
    }
}

fn normalize_gateway_reasoning_level(value: Option<&str>) -> Result<&'static str, String> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("off") | Some("hide") | Some("hidden") | Some("disabled") => Ok("off"),
        Some("on") | Some("show") | Some("visible") | Some("enabled") => Ok("on"),
        Some("stream") | Some("streaming") | Some("live") => Ok("stream"),
        Some(value) => Err(format!("未知 Uniopc 引擎 reasoning 模式: {value}")),
    }
}

pub(super) fn build_session_reasoning_patch(
    reasoning_level: Option<&str>,
) -> Result<(Value, String), String> {
    let level = normalize_gateway_reasoning_level(reasoning_level)?;
    let mut patch = serde_json::Map::new();
    patch.insert("reasoningLevel".to_string(), json!(level));
    Ok((Value::Object(patch), level.to_string()))
}

pub(super) fn build_session_patch_params(session_key: &str, patch: Value) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("key".to_string(), json!(session_key));
    if let Some(patch_object) = patch.as_object() {
        for (key, value) in patch_object {
            params.insert(key.clone(), value.clone());
        }
    }
    Value::Object(params)
}

pub(super) async fn apply_session_control_patch(
    app: &AppHandle,
    profile: Option<&str>,
    session_key: &str,
    approval_mode: Option<&str>,
) -> Result<(), String> {
    // Selecting Default patches the session explicitly through
    // conversation_set_session_permission. Sending a turn must not erase a
    // permission already stored by Gateway when the UI has no override.
    if matches!(approval_mode, None | Some("default")) {
        return Ok(());
    }
    let patch = build_session_control_patch(approval_mode)?;
    if patch
        .as_object()
        .map(|object| object.is_empty())
        .unwrap_or(true)
    {
        return Ok(());
    }
    openclaw_gateway_connection::request(
        app,
        profile,
        "sessions.patch",
        build_session_patch_params(session_key, patch),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await
    .map(|_| ())
}

pub(super) async fn validate_model_override_for_profile(
    app: &AppHandle,
    profile: Option<&str>,
    model_override: Option<&str>,
) -> Result<(), String> {
    let Some(model_ref) = model_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let ready_models = openclaw_ready_model_refs_for_profile(app, profile).await?;
    if ready_models.contains(model_ref) {
        return Ok(());
    }
    Err(format!(
        "当前 Uniopc 引擎 profile 不支持模型 `{model_ref}`，请在 AI 模型页完成该 profile 的模型配置。"
    ))
}

async fn conversation_list_sessions_impl(
    app: AppHandle,
    req: ConversationSessionListRequest,
) -> Result<ConversationSessionListResult, String> {
    let profile_key = openclaw_connection::normalize_profile(req.profile.as_deref());
    let offset = req.offset;
    let limit = req.limit.unwrap_or(40).clamp(1, 200);
    let value = openclaw_gateway_connection::request(
        &app,
        Some(&profile_key),
        "sessions.list",
        build_gateway_session_list_params(
            req.agent_id.as_deref(),
            req.search.as_deref(),
            offset,
            Some(limit),
        ),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await?;
    let sessions = parse_gateway_session_list(&value)?;
    let next_offset = if sessions.len() as u64 >= limit {
        Some(offset.unwrap_or(0).saturating_add(limit))
    } else {
        None
    };

    Ok(ConversationSessionListResult {
        total: sessions.len(),
        sessions,
        offset,
        next_offset,
        provider_type: "openclaw".to_string(),
        data_flow: "openclaw.gateway.sessions.list".to_string(),
        transport: TARGET_TRANSPORT.to_string(),
        gateway_aligned: true,
    })
}

/// Engine-derived "files this session touched" (`sessions.files.list`).
async fn conversation_session_files_impl(
    app: AppHandle,
    req: ConversationSessionFilesRequest,
) -> Result<Value, String> {
    let profile_key = openclaw_connection::normalize_profile(req.profile.as_deref());
    let session_key = req.session_key.trim();
    if session_key.is_empty() {
        return Err("session_key_required".to_string());
    }
    openclaw_gateway_connection::request(
        &app,
        Some(&profile_key),
        "sessions.files.list",
        json!({ "sessionKey": session_key }),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await
}

async fn conversation_create_session_impl(
    app: AppHandle,
    req: ConversationSessionCreateRequest,
) -> Result<ConversationSessionCreateResult, String> {
    let profile_key = openclaw_connection::normalize_profile(req.profile.as_deref());
    let agent_id = req
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少 Uniopc 引擎 agent id，无法创建新聊天。".to_string())?;
    let value = openclaw_gateway_connection::request(
        &app,
        Some(&profile_key),
        "sessions.create",
        build_gateway_session_create_params(agent_id),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await?;
    let session_key = json_trimmed_string_at(&value, &["key"])
        .or_else(|| json_trimmed_string_at(&value, &["sessionKey"]))
        .ok_or_else(|| "Gateway sessions.create 没有返回 session key。".to_string())?;

    Ok(ConversationSessionCreateResult {
        session_key: session_key.to_string(),
        session_id: json_trimmed_string_at(&value, &["sessionId"]).map(str::to_string),
        title: None,
        provider_type: "openclaw".to_string(),
        data_flow: "openclaw.gateway.sessions.create".to_string(),
        transport: TARGET_TRANSPORT.to_string(),
        gateway_aligned: true,
    })
}

async fn conversation_rename_session_impl(
    app: AppHandle,
    req: ConversationSessionRenameRequest,
) -> Result<ConversationSessionRenameResult, String> {
    let profile_key = openclaw_connection::normalize_profile(req.profile.as_deref());
    let session_key = req
        .session_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少 Gateway session key，无法重命名聊天。".to_string())?;
    let label = req
        .label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "聊天名称不能为空。".to_string())?;
    openclaw_gateway_connection::request(
        &app,
        Some(&profile_key),
        "sessions.patch",
        build_session_patch_params(session_key, build_session_label_patch(label)?),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await?;

    Ok(ConversationSessionRenameResult {
        session_key: session_key.to_string(),
        label: label.to_string(),
        title: label.to_string(),
        provider_type: "openclaw".to_string(),
        data_flow: "openclaw.gateway.sessions.patch.label".to_string(),
        transport: TARGET_TRANSPORT.to_string(),
        gateway_aligned: true,
    })
}

async fn conversation_set_session_reasoning_impl(
    app: AppHandle,
    req: ConversationSessionReasoningRequest,
) -> Result<ConversationSessionReasoningResult, String> {
    let profile_key = openclaw_connection::normalize_profile(req.profile.as_deref());
    let session_key = req
        .session_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少 Gateway session key，无法切换 reasoning。".to_string())?;
    let (patch, reasoning_level) = build_session_reasoning_patch(req.reasoning_level.as_deref())?;
    openclaw_gateway_connection::request(
        &app,
        Some(&profile_key),
        "sessions.patch",
        build_session_patch_params(session_key, patch),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await?;

    Ok(ConversationSessionReasoningResult {
        session_key: session_key.to_string(),
        reasoning_level,
        provider_type: "openclaw".to_string(),
        data_flow: "openclaw.gateway.sessions.patch.reasoningLevel".to_string(),
        transport: TARGET_TRANSPORT.to_string(),
        gateway_aligned: true,
    })
}

async fn conversation_set_session_model_impl(
    app: AppHandle,
    req: ConversationSessionModelRequest,
) -> Result<ConversationSessionModelResult, String> {
    let profile_key = openclaw_connection::normalize_profile(req.profile.as_deref());
    let session_key = req
        .session_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少 Gateway session key，无法切换模型。".to_string())?;
    let model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    openclaw_gateway_connection::request(
        &app,
        Some(&profile_key),
        "sessions.patch",
        build_session_patch_params(session_key, build_session_model_patch(model.as_deref())?),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await?;

    Ok(ConversationSessionModelResult {
        session_key: session_key.to_string(),
        model,
        provider_type: "openclaw".to_string(),
        data_flow: "openclaw.gateway.sessions.patch.model".to_string(),
        transport: TARGET_TRANSPORT.to_string(),
        gateway_aligned: true,
    })
}

async fn conversation_set_session_thinking_impl(
    app: AppHandle,
    req: ConversationSessionThinkingRequest,
) -> Result<ConversationSessionThinkingResult, String> {
    let profile_key = openclaw_connection::normalize_profile(req.profile.as_deref());
    let session_key = req
        .session_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少 Gateway session key，无法切换 thinking。".to_string())?;
    let (patch, thinking_level) = build_session_thinking_patch(req.thinking_level.as_deref())?;
    openclaw_gateway_connection::request(
        &app,
        Some(&profile_key),
        "sessions.patch",
        build_session_patch_params(session_key, patch),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await?;

    Ok(ConversationSessionThinkingResult {
        session_key: session_key.to_string(),
        thinking_level,
        provider_type: "openclaw".to_string(),
        data_flow: "openclaw.gateway.sessions.patch.thinkingLevel".to_string(),
        transport: TARGET_TRANSPORT.to_string(),
        gateway_aligned: true,
    })
}

#[tauri::command]
pub async fn conversation_list_sessions(
    app: AppHandle,
    req: ConversationSessionListRequest,
) -> Result<ConversationSessionListResult, String> {
    conversation_list_sessions_impl(app, req).await
}

#[tauri::command]
pub async fn conversation_session_files(
    app: AppHandle,
    req: ConversationSessionFilesRequest,
) -> Result<serde_json::Value, String> {
    conversation_session_files_impl(app, req).await
}

#[tauri::command]
pub async fn conversation_create_session(
    app: AppHandle,
    req: ConversationSessionCreateRequest,
) -> Result<ConversationSessionCreateResult, String> {
    conversation_create_session_impl(app, req).await
}

#[tauri::command]
pub async fn conversation_rename_session(
    app: AppHandle,
    req: ConversationSessionRenameRequest,
) -> Result<ConversationSessionRenameResult, String> {
    conversation_rename_session_impl(app, req).await
}

#[tauri::command]
pub async fn conversation_set_session_permission(
    app: AppHandle,
    req: ConversationSessionPermissionRequest,
) -> Result<Value, String> {
    let profile_key = openclaw_connection::normalize_profile(req.profile.as_deref());
    let session_key = req
        .session_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少 Gateway session key，无法设置权限。".to_string())?;
    let patch = build_session_control_patch(Some(&req.permission_mode))?;
    openclaw_gateway_connection::request(
        &app,
        Some(&profile_key),
        "sessions.patch",
        build_session_patch_params(session_key, patch),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await
}

#[tauri::command]
pub async fn conversation_patch_session_state(
    app: AppHandle,
    req: ConversationSessionStateRequest,
) -> Result<Value, String> {
    let profile_key = openclaw_connection::normalize_profile(req.profile.as_deref());
    let session_key = req
        .session_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少 Gateway session key，无法更新会话。".to_string())?;
    let patch = build_session_state_patch(&req.action, req.session_id.as_deref())?;
    openclaw_gateway_connection::request(
        &app,
        Some(&profile_key),
        "sessions.patch",
        build_session_patch_params(session_key, patch),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await
}

#[tauri::command]
pub async fn conversation_set_session_reasoning(
    app: AppHandle,
    req: ConversationSessionReasoningRequest,
) -> Result<ConversationSessionReasoningResult, String> {
    conversation_set_session_reasoning_impl(app, req).await
}

#[tauri::command]
pub async fn conversation_set_session_model(
    app: AppHandle,
    req: ConversationSessionModelRequest,
) -> Result<ConversationSessionModelResult, String> {
    conversation_set_session_model_impl(app, req).await
}

#[tauri::command]
pub async fn conversation_set_session_thinking(
    app: AppHandle,
    req: ConversationSessionThinkingRequest,
) -> Result<ConversationSessionThinkingResult, String> {
    conversation_set_session_thinking_impl(app, req).await
}

#[cfg(test)]
mod tests {
    use super::{
        build_session_control_patch, build_session_model_patch, build_session_patch_params,
        build_session_state_patch,
    };

    #[test]
    fn sessions_boundary_owns_gateway_patch_shape() {
        let patch = build_session_model_patch(Some("qwen/qwen3.7-plus"))
            .expect("model patch must be valid");
        assert_eq!(
            build_session_patch_params("agent:main:main", patch),
            serde_json::json!({
                "key": "agent:main:main",
                "model": "qwen/qwen3.7-plus"
            })
        );
    }

    #[test]
    fn session_permission_uses_official_permission_mode_not_retired_exec_fields() {
        for (mode, expected) in [
            ("read-only", serde_json::json!({ "permissionMode": "read-only" })),
            ("guarded", serde_json::json!({ "permissionMode": "guarded" })),
            ("workspace", serde_json::json!({ "permissionMode": "workspace" })),
            ("full", serde_json::json!({ "permissionMode": "full" })),
        ] {
            assert_eq!(build_session_control_patch(Some(mode)).unwrap(), expected);
        }
        let patch = build_session_control_patch(Some("workspace")).expect("workspace mode");
        assert_eq!(patch, serde_json::json!({ "permissionMode": "workspace" }));
        assert!(patch.get("execSecurity").is_none());
        assert!(patch.get("execAsk").is_none());

        let default_patch = build_session_control_patch(Some("default")).expect("default mode");
        assert_eq!(default_patch, serde_json::json!({ "permissionMode": null }));
    }

    #[test]
    fn archive_patch_requires_expected_session_id() {
        assert!(build_session_state_patch("archive", None).is_err());
        assert_eq!(
            build_session_state_patch("archive", Some("session-1")).expect("archive patch"),
            serde_json::json!({ "archived": true, "expectedSessionId": "session-1" })
        );
        assert_eq!(
            build_session_state_patch("pin", None).expect("pin patch"),
            serde_json::json!({ "pinned": true })
        );
    }
}
