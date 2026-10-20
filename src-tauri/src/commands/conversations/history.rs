use super::ConversationHistoryResult;
use tauri::AppHandle;

#[tauri::command]
pub async fn conversation_load_history(
    app: AppHandle,
    session_key: String,
    profile: Option<String>,
    // Model / thinking-level metadata costs a second gateway round trip
    // (`sessions.list`, 200 sessions). It only changes when the user changes it,
    // so a post-turn refresh skips it and asks for the transcript alone.
    include_session_meta: Option<bool>,
) -> Result<ConversationHistoryResult, String> {
    super::conversation_load_history_impl(
        app,
        session_key,
        profile,
        include_session_meta.unwrap_or(true),
    )
    .await
}
