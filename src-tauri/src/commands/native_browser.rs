use crate::services::native_browser::{self, NativeBrowserBounds, NativeBrowserState};
use serde::Deserialize;
use tauri::{AppHandle, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBrowserOpenRequest {
    pub url: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBrowserResizeRequest {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize)]
pub struct NativeBrowserActionRequest {
    pub action: String,
}

fn bounds(x: f64, y: f64, width: f64, height: f64) -> NativeBrowserBounds {
    NativeBrowserBounds { x, y, width, height }
}

#[tauri::command]
pub async fn native_browser_open(
    app: AppHandle,
    state: State<'_, NativeBrowserState>,
    req: NativeBrowserOpenRequest,
) -> Result<native_browser::NativeBrowserSnapshot, String> {
    native_browser::open_or_navigate(&app, &state, &req.url, bounds(req.x, req.y, req.width, req.height))
}

#[tauri::command]
pub async fn native_browser_resize(
    state: State<'_, NativeBrowserState>,
    req: NativeBrowserResizeRequest,
) -> Result<native_browser::NativeBrowserSnapshot, String> {
    native_browser::resize(&state, bounds(req.x, req.y, req.width, req.height))
}

#[tauri::command]
pub async fn native_browser_action(
    state: State<'_, NativeBrowserState>,
    req: NativeBrowserActionRequest,
) -> Result<native_browser::NativeBrowserSnapshot, String> {
    native_browser::action(&state, &req.action)
}
