use crate::services::native_voice_input::{self, NativeVoiceInputResult};
use tauri::AppHandle;

#[tauri::command]
pub async fn native_voice_input_start(
    app: AppHandle,
    locale: Option<String>,
) -> Result<NativeVoiceInputResult, String> {
    native_voice_input::start(app, locale).await
}

#[tauri::command]
pub async fn native_voice_input_stop(app: AppHandle) -> Result<NativeVoiceInputResult, String> {
    native_voice_input::stop(app).await
}

#[tauri::command]
pub async fn native_voice_input_cancel(app: AppHandle) -> Result<NativeVoiceInputResult, String> {
    native_voice_input::cancel(app).await
}
