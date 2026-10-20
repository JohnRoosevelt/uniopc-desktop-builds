use crate::services::openclaw_gateway_connection;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPluginApprovalResolveRequest {
    pub profile: Option<String>,
    pub id: String,
    pub decision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExecApprovalResolveRequest {
    pub profile: Option<String>,
    pub id: String,
    pub decision: String,
}

fn validate_decision(value: &str) -> Result<&str, String> {
    match value.trim() {
        "allow-once" => Ok("allow-once"),
        "deny" => Ok("deny"),
        _ => Err("无效的插件审批决定。".to_string()),
    }
}

#[tauri::command]
pub async fn conversation_list_plugin_approvals(
    app: AppHandle,
    profile: Option<String>,
) -> Result<Value, String> {
    openclaw_gateway_connection::request(
        &app,
        profile.as_deref(),
        "plugin.approval.list",
        json!({}),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await
}

#[tauri::command]
pub async fn conversation_list_exec_approvals(
    app: AppHandle,
    profile: Option<String>,
) -> Result<Value, String> {
    openclaw_gateway_connection::request(
        &app,
        profile.as_deref(),
        "exec.approval.list",
        json!({}),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await
}

#[tauri::command]
pub async fn conversation_resolve_exec_approval(
    app: AppHandle,
    req: ConversationExecApprovalResolveRequest,
) -> Result<Value, String> {
    let id = req.id.trim();
    if id.is_empty() {
        return Err("缺少命令审批 ID。".to_string());
    }
    let decision = match req.decision.trim() {
        "allow-once" => "allow-once",
        "deny" => "deny",
        _ => return Err("无效的命令审批决定。".to_string()),
    };
    openclaw_gateway_connection::request(
        &app,
        req.profile.as_deref(),
        "approval.resolve",
        json!({ "id": id, "kind": "exec", "decision": decision }),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await
}

#[tauri::command]
pub async fn conversation_resolve_plugin_approval(
    app: AppHandle,
    req: ConversationPluginApprovalResolveRequest,
) -> Result<Value, String> {
    let id = req.id.trim();
    if id.is_empty() {
        return Err("缺少插件审批 ID。".to_string());
    }
    let decision = validate_decision(&req.decision)?;
    openclaw_gateway_connection::request(
        &app,
        req.profile.as_deref(),
        "approval.resolve",
        json!({ "id": id, "kind": "plugin", "decision": decision }),
        openclaw_gateway_connection::GatewayRequestOptions::default(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::validate_decision;

    #[test]
    fn plugin_approval_only_accepts_runtime_decisions() {
        assert_eq!(validate_decision("allow-once"), Ok("allow-once"));
        assert_eq!(validate_decision("deny"), Ok("deny"));
        assert!(validate_decision("allow-always").is_err());
    }
}
