use super::{
    ConversationAbortRequest, ConversationAbortResult, ConversationSubscribeSessionResult,
    ConversationTurnRequest, ConversationTurnResult,
};
use tauri::AppHandle;

#[tauri::command]
pub async fn conversation_import_attachments(
    profile: Option<String>,
    paths: Vec<String>,
) -> Result<Vec<super::ImportedConversationAttachment>, String> {
    super::conversation_import_attachments(profile, paths).await
}

#[tauri::command]
pub async fn conversation_import_attachment_data_url(
    profile: Option<String>,
    name: String,
    data_url: String,
) -> Result<super::ImportedConversationAttachment, String> {
    super::conversation_import_attachment_data_url(profile, name, data_url).await
}

#[tauri::command]
pub async fn conversation_send_turn(
    app: AppHandle,
    req: ConversationTurnRequest,
) -> Result<ConversationTurnResult, String> {
    super::conversation_send_turn_impl(app, req).await
}

#[tauri::command]
pub async fn conversation_abort_turn(
    app: AppHandle,
    req: ConversationAbortRequest,
) -> Result<ConversationAbortResult, String> {
    super::conversation_abort_turn_impl(app, req).await
}

#[tauri::command]
pub async fn conversation_subscribe_session(
    app: AppHandle,
    session_key: String,
    profile: Option<String>,
) -> Result<ConversationSubscribeSessionResult, String> {
    super::conversation_subscribe_session_impl(app, session_key, profile).await
}
