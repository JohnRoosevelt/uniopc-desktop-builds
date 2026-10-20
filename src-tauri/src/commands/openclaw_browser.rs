use crate::{commands::model, services::openclaw_browser};
use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRuntimeRequest {
    pub profile: Option<String>,
    pub browser_profile: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEnabledRequest {
    pub profile: Option<String>,
    pub enabled: bool,
}

#[tauri::command]
pub async fn openclaw_browser_runtime_snapshot(
    req: BrowserRuntimeRequest,
) -> Result<openclaw_browser::BrowserRuntimeSnapshot, String> {
    openclaw_browser::runtime_snapshot(req.profile.as_deref(), req.browser_profile.as_deref()).await
}

#[tauri::command]
pub async fn openclaw_browser_dock_snapshot(
    req: BrowserRuntimeRequest,
) -> Result<openclaw_browser::BrowserDockSnapshot, String> {
    openclaw_browser::browser_dock_snapshot(req.profile.as_deref()).await
}

#[tauri::command]
pub async fn openclaw_browser_runtime_set_enabled(
    app: AppHandle,
    req: BrowserEnabledRequest,
) -> Result<Value, String> {
    let mut result = openclaw_browser::set_enabled(req.profile.as_deref(), req.enabled).await?;
    let _profile = req
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Uniopc 引擎 profile 不能为空，请先完成工作空间 profile 初始化。".to_string()
        })?;
    // Pure sidecar: respawn the app-owned gateway child so it picks up the new
    // browser config (no service to restart).
    let restart_result = {
        use tauri::Manager;
        app.state::<model::GatewaySupervisor>()
            .restart()
            .await
            .map(|()| Value::String(String::new()))
            .map_err(|error| format!("Uniopc 引擎 browser 配置已更新，但 Gateway 重启失败: {error}"))
    };
    if let Some(object) = result.as_object_mut() {
        match restart_result {
            Ok(output) => {
                object.insert("gatewayRestarted".to_string(), Value::Bool(true));
                object.insert("restartOutput".to_string(), output);
            }
            Err(error) => {
                object.insert("gatewayRestarted".to_string(), Value::Bool(false));
                object.insert("restartError".to_string(), Value::String(error));
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn openclaw_browser_action(
    req: openclaw_browser::BrowserActionInput,
) -> Result<Value, String> {
    openclaw_browser::action(req).await
}

#[tauri::command]
pub async fn openclaw_browser_dock_action(
    req: openclaw_browser::BrowserDockInput,
) -> Result<openclaw_browser::BrowserDockFrame, String> {
    openclaw_browser::browser_dock_frame(req).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDockStreamRequest { pub profile: Option<String>, pub target_id: Option<String> }

#[tauri::command]
pub async fn openclaw_browser_dock_stream_start(
    app: AppHandle,
    state: State<'_, openclaw_browser::BrowserDockStreams>,
    req: BrowserDockStreamRequest,
) -> Result<(), String> {
    let target_id = req.target_id.ok_or("浏览器标签 ID 缺失。")?;
    openclaw_browser::start_browser_dock_stream(app, &state, req.profile, target_id).await
}

#[tauri::command]
pub async fn openclaw_browser_dock_stream_stop(
    state: State<'_, openclaw_browser::BrowserDockStreams>,
    req: BrowserDockStreamRequest,
) -> Result<(), String> {
    openclaw_browser::stop_browser_dock_stream(&state, req.profile.as_deref(), req.target_id.as_deref()).await;
    Ok(())
}
