use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl, Wry};

const NATIVE_BROWSER_LABEL: &str = "uniopc-native-browser";

/// A real, user-operated browser surface hosted as a child WebView of the main
/// Tauri window. It deliberately has no IPC capability: remote page scripts
/// must never inherit the commands available to Uniopc's trusted React UI.
#[derive(Default)]
pub struct NativeBrowserState {
    webview: Mutex<Option<Webview<Wry>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBrowserSnapshot {
    pub visible: bool,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct NativeBrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn parse_http_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "请输入有效的 http:// 或 https:// 地址。".to_string())?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("浏览器只允许打开 http:// 或 https:// 地址。".to_string()),
    }
}

fn normalized_bounds(bounds: NativeBrowserBounds) -> Result<(LogicalPosition<f64>, LogicalSize<f64>), String> {
    if !bounds.x.is_finite()
        || !bounds.y.is_finite()
        || !bounds.width.is_finite()
        || !bounds.height.is_finite()
        || bounds.width < 80.0
        || bounds.height < 80.0
    {
        return Err("浏览器显示区域无效，请调整窗口后重试。".to_string());
    }
    Ok((
        LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)),
        LogicalSize::new(bounds.width, bounds.height),
    ))
}

pub fn open_or_navigate(
    app: &AppHandle,
    state: &NativeBrowserState,
    url: &str,
    bounds: NativeBrowserBounds,
) -> Result<NativeBrowserSnapshot, String> {
    let url = parse_http_url(url)?;
    let (position, size) = normalized_bounds(bounds)?;
    let existing = state
        .webview
        .lock()
        .map_err(|_| "浏览器状态被占用，请重试。".to_string())?
        .clone();

    let webview = if let Some(webview) = existing {
        webview
            .set_position(position)
            .map_err(|error| format!("定位浏览器失败：{error}"))?;
        webview
            .set_size(size)
            .map_err(|error| format!("调整浏览器大小失败：{error}"))?;
        webview
            .navigate(url.clone())
            .map_err(|error| format!("打开网页失败：{error}"))?;
        webview
            .show()
            .map_err(|error| format!("显示浏览器失败：{error}"))?;
        webview
    } else {
        let window = app
            .get_window("main")
            .ok_or_else(|| "主窗口尚未准备好，无法打开浏览器。".to_string())?;
        let builder = tauri::webview::WebviewBuilder::new(
            NATIVE_BROWSER_LABEL,
            WebviewUrl::External(url.clone()),
        )
        .on_navigation(|target| matches!(target.scheme(), "http" | "https"));
        let webview = window
            .add_child(builder, position, size)
            .map_err(|error| format!("创建本机浏览器失败：{error}"))?;
        *state
            .webview
            .lock()
            .map_err(|_| "浏览器状态被占用，请重试。".to_string())? = Some(webview.clone());
        webview
    };
    let _ = webview.set_focus();
    Ok(NativeBrowserSnapshot {
        visible: true,
        url: url.to_string(),
    })
}

pub fn resize(
    state: &NativeBrowserState,
    bounds: NativeBrowserBounds,
) -> Result<NativeBrowserSnapshot, String> {
    let (position, size) = normalized_bounds(bounds)?;
    let webview = state
        .webview
        .lock()
        .map_err(|_| "浏览器状态被占用，请重试。".to_string())?
        .clone()
        .ok_or_else(|| "浏览器尚未打开。".to_string())?;
    webview
        .set_position(position)
        .and_then(|_| webview.set_size(size))
        .map_err(|error| format!("调整浏览器大小失败：{error}"))?;
    Ok(NativeBrowserSnapshot {
        visible: true,
        url: webview.url().map(|url| url.to_string()).unwrap_or_default(),
    })
}

pub fn action(
    state: &NativeBrowserState,
    action: &str,
) -> Result<NativeBrowserSnapshot, String> {
    let mut browser_state = state
        .webview
        .lock()
        .map_err(|_| "浏览器状态被占用，请重试。".to_string())?;
    let webview = browser_state
        .clone()
        .ok_or_else(|| "浏览器尚未打开。".to_string())?;
    let current_url = webview.url().map(|url| url.to_string()).unwrap_or_default();
    match action.trim() {
        "back" => webview.eval("history.back()"),
        "forward" => webview.eval("history.forward()"),
        "reload" => webview.reload(),
        // Tauri's child WebViews turn their host into a multi-webview window.
        // Closing instead of only hiding restores the main window's normal
        // single-webview lifecycle (and keeps dev tooling available) as soon
        // as the conversation drawer closes.
        "hide" => {
            let result = webview.close();
            if result.is_ok() {
                *browser_state = None;
            }
            result
        }
        "show" => webview.show(),
        _ => return Err("不支持的本机浏览器操作。".to_string()),
    }
    .map_err(|error| format!("浏览器操作失败：{error}"))?;
    Ok(NativeBrowserSnapshot {
        visible: action.trim() != "hide",
        url: current_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_urls_can_be_opened_in_native_browser() {
        assert!(parse_http_url("https://example.com").is_ok());
        assert!(parse_http_url("http://example.com").is_ok());
        assert!(parse_http_url("file:///etc/passwd").is_err());
        assert!(parse_http_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn browser_bounds_need_a_usable_viewport() {
        assert!(normalized_bounds(NativeBrowserBounds { x: 1.0, y: 1.0, width: 300.0, height: 400.0 }).is_ok());
        assert!(normalized_bounds(NativeBrowserBounds { x: 1.0, y: 1.0, width: 20.0, height: 400.0 }).is_err());
    }
}
