use crate::services::{openclaw_gateway, openclaw_runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;

const DEFAULT_BROWSER_REQUEST_TIMEOUT_SECS: u64 = 20;
const DEFAULT_BROWSER_ACTION_PROFILE: &str = "openclaw";
const BROWSER_TOOL_ID: &str = "browser";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRuntimeError {
    pub kind: String,
    pub message: String,
    pub next_action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRuntimeSnapshot {
    pub profile: String,
    pub browser_profile: String,
    pub enabled: bool,
    pub status: String,
    pub execution_target: String,
    pub execution_target_label: String,
    pub message: String,
    pub next_action: String,
    pub browser_status: Option<Value>,
    pub profiles: Vec<Value>,
    pub tabs: Vec<Value>,
    pub pending_requests: Vec<Value>,
    pub paired_devices: Vec<Value>,
    pub error: Option<BrowserRuntimeError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDockSnapshot {
    pub profile: String,
    pub status: String,
    pub message: String,
    pub tabs: Vec<Value>,
    pub local_managed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionInput {
    pub profile: Option<String>,
    pub action: String,
    pub browser_profile: Option<String>,
    pub url: Option<String>,
    pub label: Option<String>,
    pub target_id: Option<String>,
    pub text: Option<String>,
    pub key: Option<String>,
    pub selector: Option<String>,
    pub ref_id: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDockInput {
    pub profile: Option<String>,
    pub target_id: String,
    pub action: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub delta_x: Option<f64>,
    pub delta_y: Option<f64>,
    pub text: Option<String>,
    pub key: Option<String>,
    pub modifiers: Option<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDockFrame {
    pub target_id: String,
    pub url: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub image: String,
}

#[derive(Default)]
pub struct BrowserDockStreams {
    tasks: tokio::sync::Mutex<std::collections::HashMap<String, tokio::task::JoinHandle<()>>>,
}

pub async fn start_browser_dock_stream(
    app: tauri::AppHandle,
    state: &BrowserDockStreams,
    profile: Option<String>,
    target_id: String,
) -> Result<(), String> {
    // Validate the target synchronously so an invalid or personal-browser target
    // never starts a background CDP session.
    managed_tab_websocket(profile.as_deref(), &target_id).await?;
    let key = format!("{}:{target_id}", profile.as_deref().unwrap_or_default());
    let mut tasks = state.tasks.lock().await;
    if let Some(previous) = tasks.remove(&key) { previous.abort(); }
    let stream_profile = profile.clone();
    let stream_target = target_id.clone();
    let task = tokio::spawn(async move {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        loop {
            let (ws_url, tab) = match managed_tab_websocket(stream_profile.as_deref(), &stream_target).await {
                Ok(value) => value,
                Err(_) => break,
            };
            let Ok((mut socket, _)) = tokio_tungstenite::connect_async(&ws_url).await else {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            };
            let mut page_url = tab.get("url").and_then(Value::as_str).unwrap_or_default().to_string();
            let mut page_title = tab.get("title").and_then(Value::as_str).unwrap_or_default().to_string();
            let mut main_frame_id: Option<String> = None;
            // Subscribe to navigation before screencast frames can arrive.
            // Frame metadata is also queried for every image below; the image
            // is held until that query returns so a new page is never emitted
            // with the previous page's URL/title.
            let enable = json!({"id":1,"method":"Page.enable"});
            if socket.send(Message::Text(enable.to_string().into())).await.is_err() { continue; }
            let start = json!({"id":2,"method":"Page.startScreencast","params":{"format":"jpeg","quality":65,"maxWidth":1280,"maxHeight":1000,"everyNthFrame":1}});
            if socket.send(Message::Text(start.to_string().into())).await.is_err() { continue; }
            let stream_result = async {
                let mut next_command_id = 10_u64;
                let mut navigation_epoch = 0_u64;
                let mut page_loading = false;
                let mut awaiting_fresh_capture = true;
                let mut pending_captures = std::collections::HashMap::<u64, u64>::new();
                let mut pending_metadata = std::collections::HashMap::<u64, (u64, String)>::new();
                let initial_capture_id = next_command_id;
                next_command_id += 1;
                pending_captures.insert(initial_capture_id, navigation_epoch);
                if socket.send(Message::Text(json!({"id":initial_capture_id,"method":"Page.captureScreenshot","params":{"format":"jpeg","quality":72,"captureBeyondViewport":false}}).to_string().into())).await.is_err() { return Err(()); }
                while let Some(message) = socket.next().await {
                    let Message::Text(text) = message.map_err(|_| ())? else { continue };
                    let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                    if let Some(id) = value.get("id").and_then(Value::as_u64) {
                        if let Some(epoch) = pending_captures.remove(&id) {
                            if epoch == navigation_epoch && !page_loading {
                                if let Some(data) = value.pointer("/result/data").and_then(Value::as_str) {
                                    let metadata_id = next_command_id;
                                    next_command_id += 1;
                                    pending_metadata.insert(metadata_id, (epoch, format!("data:image/jpeg;base64,{data}")));
                                    if socket.send(Message::Text(json!({"id":metadata_id,"method":"Runtime.evaluate","params":{"expression":"({url: location.href, title: document.title})","returnByValue":true}}).to_string().into())).await.is_err() { return Err(()); }
                                }
                            }
                            continue;
                        }
                        if let Some((epoch, image)) = pending_metadata.remove(&id) {
                            if epoch == navigation_epoch && !page_loading {
                                let Some(metadata) = value.pointer("/result/result/value") else { continue };
                                if let Some(url) = metadata.get("url").and_then(Value::as_str) { page_url = url.to_string(); }
                                if let Some(title) = metadata.get("title").and_then(Value::as_str) { page_title = title.to_string(); }
                                use tauri::Emitter;
                                let _ = app.emit_to(tauri::EventTarget::window("main"), "openclaw-browser-frame", json!({"profile":stream_profile,"targetId":stream_target,"url":page_url,"title":page_title,"image":image}));
                                awaiting_fresh_capture = false;
                            }
                        }
                        continue;
                    }
                    let method = value.pointer("/method").and_then(Value::as_str);
                    if method == Some("Page.frameNavigated") {
                        if let Some(frame) = value.pointer("/params/frame") {
                            if frame.get("parentId").is_none() {
                                main_frame_id = frame.get("id").and_then(Value::as_str).map(str::to_string);
                                if let Some(url) = frame.get("url").and_then(Value::as_str) { page_url = url.to_string(); }
                                navigation_epoch += 1;
                                page_loading = true;
                                awaiting_fresh_capture = true;
                            }
                        }
                        continue;
                    }
                    if method == Some("Page.navigatedWithinDocument") {
                        let frame_id = value.pointer("/params/frameId").and_then(Value::as_str);
                        if main_frame_id.as_deref().is_none_or(|main_id| Some(main_id) == frame_id) {
                            if let Some(url) = value.pointer("/params/url").and_then(Value::as_str) { page_url = url.to_string(); }
                            navigation_epoch += 1;
                            page_loading = false;
                            awaiting_fresh_capture = true;
                            let capture_id = next_command_id;
                            next_command_id += 1;
                            pending_captures.insert(capture_id, navigation_epoch);
                            if socket.send(Message::Text(json!({"id":capture_id,"method":"Page.captureScreenshot","params":{"format":"jpeg","quality":72,"captureBeyondViewport":false}}).to_string().into())).await.is_err() { return Err(()); }
                        }
                        continue;
                    }
                    if method == Some("Page.frameStoppedLoading") {
                        let frame_id = value.pointer("/params/frameId").and_then(Value::as_str);
                        if main_frame_id.as_deref().is_none_or(|main_id| Some(main_id) == frame_id) {
                            page_loading = false;
                            awaiting_fresh_capture = true;
                            let capture_id = next_command_id;
                            next_command_id += 1;
                            pending_captures.insert(capture_id, navigation_epoch);
                            if socket.send(Message::Text(json!({"id":capture_id,"method":"Page.captureScreenshot","params":{"format":"jpeg","quality":72,"captureBeyondViewport":false}}).to_string().into())).await.is_err() { return Err(()); }
                        }
                        continue;
                    }
                    if method != Some("Page.screencastFrame") { continue; }
                    let params = value.get("params").cloned().unwrap_or_default();
                    let Some(data) = params.get("data").and_then(Value::as_str) else { continue };
                    let session_id = params.get("sessionId").cloned().unwrap_or(Value::Null);
                    let ack_id = next_command_id;
                    next_command_id += 1;
                    let ack = json!({"id":ack_id,"method":"Page.screencastFrameAck","params":{"sessionId":session_id}});
                    if socket.send(Message::Text(ack.to_string().into())).await.is_err() { return Err(()); }
                    if page_loading || awaiting_fresh_capture { continue; }
                    let metadata_id = next_command_id;
                    next_command_id += 1;
                    let image = format!("data:image/jpeg;base64,{data}");
                    pending_metadata.insert(metadata_id, (navigation_epoch, image));
                    let metadata_request = json!({"id":metadata_id,"method":"Runtime.evaluate","params":{"expression":"({url: location.href, title: document.title})","returnByValue":true}});
                    if socket.send(Message::Text(metadata_request.to_string().into())).await.is_err() { return Err(()); }
                }
                Err::<(), ()>(())
            }.await;
            let _ = socket.send(Message::Text(json!({"id":3,"method":"Page.stopScreencast"}).to_string().into())).await;
            if stream_result.is_err() { tokio::time::sleep(std::time::Duration::from_millis(500)).await; }
        }
    });
    tasks.insert(key, task);
    Ok(())
}

pub async fn stop_browser_dock_stream(state: &BrowserDockStreams, profile: Option<&str>, target_id: Option<&str>) {
    let mut tasks = state.tasks.lock().await;
    let keys: Vec<String> = tasks.keys().filter(|key| {
        let (owner, target) = key.split_once(':').unwrap_or(("", ""));
        profile.is_none_or(|profile| owner == profile) && target_id.is_none_or(|target_id| target == target_id)
    }).cloned().collect();
    for key in keys { if let Some(task) = tasks.remove(&key) { task.abort(); } }
}

/// Captures and controls a tab from this workspace's managed OpenClaw browser.
/// The endpoint is derived from the workspace config and the tab is revalidated
/// against that endpoint on every call; callers cannot supply an arbitrary CDP URL.
// A local Gateway endpoint is shared by the desktop process. Never label its
// browser response as another workspace merely because that config was loaded.
fn browser_status_belongs_to_workspace(status: &Value, port: u16, user_data_dir: &std::path::Path) -> bool {
    if status.get("cdpPort").and_then(Value::as_u64) != Some(port as u64) { return false; }
    let Some(actual) = status.get("userDataDir").and_then(Value::as_str) else {
        // Before the managed browser starts, upstream has no process data dir.
        // Its reserved CDP port still identifies the workspace; this only
        // permits the stopped state, never an active control channel.
        return status.get("running").and_then(Value::as_bool) == Some(false)
            && status.get("cdpReady").and_then(Value::as_bool) != Some(true);
    };
    let actual = std::path::Path::new(actual);
    match (actual.canonicalize(), user_data_dir.canonicalize()) {
        (Ok(actual), Ok(expected)) => actual == expected,
        _ => actual == user_data_dir,
    }
}

fn browser_dock_error_message(error: &BrowserRuntimeError) -> String {
    match error.kind.as_str() {
        "scope_upgrade_pending_approval" => "浏览器权限等待批准，请在运行中心完成批准后重试。",
        "gateway_browser_rpc_unsupported" => "当前引擎尚未提供浏览器能力，请在运行中心修复或更新引擎。",
        "browser_disabled" => "工作区浏览器已关闭，请在运行中心启用后重试。",
        "node_host_required" => "当前连接不支持本机共享浏览器，请在运行中心连接本机工作区。",
        "control_api_unreachable" => "工作区引擎连接已中断，请在运行中心重新连接后重试。",
        _ => "暂时无法连接工作区浏览器，请在运行中心检查引擎和浏览器状态。",
    }.to_string()
}

fn browser_dock_editing_commands(key: &str, modifiers: u8) -> Vec<&'static str> {
    let primary = if cfg!(target_os = "macos") { 4 } else { 2 };
    // CDP dispatches modifier key events without invoking macOS menu editing
    // commands. Explicitly request the primary Select All edit command.
    if modifiers == primary && key.eq_ignore_ascii_case("a") { vec!["selectAll"] } else { Vec::new() }
}

fn dock_tabs_belong_to_port(tabs: &[Value], port: u16) -> bool {
    tabs.iter().all(|tab| {
        tab.get("wsUrl").or_else(|| tab.get("webSocketDebuggerUrl"))
            .and_then(Value::as_str)
            .is_some_and(|url| url.starts_with(&format!("ws://127.0.0.1:{port}/")) || url.starts_with(&format!("ws://localhost:{port}/")))
    })
}

fn workspace_browser_data_dir(profile: &str) -> Result<std::path::PathBuf, String> {
    Ok(crate::services::uniopc_runtime_paths::state_v8_dir_for_profile(Some(profile))?.join("browser/openclaw/user-data"))
}

pub async fn browser_dock_frame(input: BrowserDockInput) -> Result<BrowserDockFrame, String> {
    let (ws_url, tab) = managed_tab_websocket(input.profile.as_deref(), &input.target_id).await?;
    match input.action.as_str() {
        "frame" => {
            for attempt in 0..2 {
                let before = cdp_command(&ws_url, 1, "Runtime.evaluate", json!({"expression":"({url:location.href,title:document.title,width:window.innerWidth,height:window.innerHeight})", "returnByValue":true})).await?;
                let screenshot = cdp_command(&ws_url, 2, "Page.captureScreenshot", json!({"format":"jpeg", "quality":72, "captureBeyondViewport":false})).await?;
                let after = cdp_command(&ws_url, 3, "Runtime.evaluate", json!({"expression":"({url:location.href,title:document.title,width:window.innerWidth,height:window.innerHeight})", "returnByValue":true})).await?;
                let before_state = before.pointer("/result/result/value").cloned().unwrap_or(Value::Null);
                let after_state = after.pointer("/result/result/value").cloned().unwrap_or(Value::Null);
                if before_state.get("url") != after_state.get("url") || before_state.get("title") != after_state.get("title") {
                    if attempt == 0 { continue; }
                    return Err("截图期间网页发生跳转，请稍后重试。".to_string());
                }
                let data = screenshot.pointer("/result/data").and_then(Value::as_str).ok_or_else(|| "工作区浏览器没有返回截图。".to_string())?;
                let width = after_state.get("width").and_then(Value::as_f64).unwrap_or(1280.0);
                let height = after_state.get("height").and_then(Value::as_f64).unwrap_or(800.0);
                return Ok(BrowserDockFrame {
                    target_id: input.target_id,
                    url: after_state.get("url").and_then(Value::as_str).unwrap_or_default().to_string(),
                    title: after_state.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
                    width, height,
                    image: format!("data:image/jpeg;base64,{data}"),
                });
            }
            Err("无法确认截图对应的网页。".to_string())
        }
        "click" => {
            let x_ratio = input.x.ok_or("点击坐标缺失。")?;
            let y_ratio = input.y.ok_or("点击坐标缺失。")?;
            if !(0.0..=1.0).contains(&x_ratio) || !(0.0..=1.0).contains(&y_ratio) { return Err("点击坐标超出面板范围。".to_string()); }
            let metrics = cdp_command(&ws_url, 1, "Runtime.evaluate", json!({"expression":"({width: window.innerWidth, height: window.innerHeight})", "returnByValue":true})).await?;
            let x = x_ratio * metrics.pointer("result.result.value.width").and_then(Value::as_f64).unwrap_or(1280.0);
            let y = y_ratio * metrics.pointer("result.result.value.height").and_then(Value::as_f64).unwrap_or(800.0);
            cdp_command(&ws_url, 2, "Input.dispatchMouseEvent", json!({"type":"mousePressed", "x":x, "y":y, "button":"left", "clickCount":1})).await?;
            cdp_command(&ws_url, 3, "Input.dispatchMouseEvent", json!({"type":"mouseReleased", "x":x, "y":y, "button":"left", "clickCount":1})).await?;
            Ok(BrowserDockFrame { target_id: input.target_id, url: tab.get("url").and_then(Value::as_str).unwrap_or_default().to_string(), title: tab.get("title").and_then(Value::as_str).unwrap_or_default().to_string(), width:0.0, height:0.0, image:String::new() })
        }
        "scroll" => {
            let x_ratio = input.x.unwrap_or(0.5); let y_ratio = input.y.unwrap_or(0.5);
            if !(0.0..=1.0).contains(&x_ratio) || !(0.0..=1.0).contains(&y_ratio) { return Err("滚动坐标超出面板范围。".to_string()); }
            let metrics = cdp_command(&ws_url, 1, "Runtime.evaluate", json!({"expression":"({width: window.innerWidth, height: window.innerHeight})", "returnByValue":true})).await?;
            let x = x_ratio * metrics.pointer("result.result.value.width").and_then(Value::as_f64).unwrap_or(1280.0);
            let y = y_ratio * metrics.pointer("result.result.value.height").and_then(Value::as_f64).unwrap_or(800.0);
            cdp_command(&ws_url, 2, "Input.dispatchMouseEvent", json!({"type":"mouseWheel", "x":x, "y":y, "deltaX":input.delta_x.unwrap_or(0.0), "deltaY":input.delta_y.unwrap_or(0.0)})).await?;
            Ok(BrowserDockFrame { target_id: input.target_id, url: tab.get("url").and_then(Value::as_str).unwrap_or_default().to_string(), title: tab.get("title").and_then(Value::as_str).unwrap_or_default().to_string(), width:0.0, height:0.0, image:String::new() })
        }
        "text" => {
            let text = input.text.unwrap_or_default();
            cdp_command(&ws_url, 1, "Input.insertText", json!({"text":text})).await?;
            Ok(BrowserDockFrame { target_id: input.target_id, url: tab.get("url").and_then(Value::as_str).unwrap_or_default().to_string(), title: tab.get("title").and_then(Value::as_str).unwrap_or_default().to_string(), width:0.0, height:0.0, image:String::new() })
        }
        "key" => {
            let key = input.key.ok_or("按键缺失。")?;
            if key.len() > 32 { return Err("按键格式无效。".to_string()); }
            let modifiers = input.modifiers.unwrap_or(0);
            if modifiers > 15 { return Err("按键修饰符无效。".to_string()); }
            let upper = key.to_ascii_uppercase();
            let key_code = match key.as_str() { "Enter" => 13, "Tab" => 9, "Backspace" => 8, "Escape" => 27, "ArrowUp" => 38, "ArrowDown" => 40, "ArrowLeft" => 37, "ArrowRight" => 39, " " => 32, _ if key.len() == 1 && upper.as_bytes()[0].is_ascii_alphanumeric() => upper.as_bytes()[0] as u32, _ => 0 };
            let code = if key.len() == 1 && upper.as_bytes()[0].is_ascii_alphabetic() { format!("Key{upper}") } else { key.clone() };
            cdp_command(&ws_url, 1, "Input.dispatchKeyEvent", json!({"type":"keyDown", "key":key, "code":code, "windowsVirtualKeyCode":key_code, "modifiers":modifiers, "commands":browser_dock_editing_commands(&key, modifiers)})).await?;
            cdp_command(&ws_url, 2, "Input.dispatchKeyEvent", json!({"type":"keyUp", "key":key, "code":code, "windowsVirtualKeyCode":key_code, "modifiers":modifiers})).await?;
            Ok(BrowserDockFrame { target_id: input.target_id, url: tab.get("url").and_then(Value::as_str).unwrap_or_default().to_string(), title: tab.get("title").and_then(Value::as_str).unwrap_or_default().to_string(), width:0.0, height:0.0, image:String::new() })
        }
        _ => Err("不支持的 Browser Runtime 面板操作。".to_string()),
    }
}

async fn managed_tab_websocket(profile: Option<&str>, target_id: &str) -> Result<(String, Value), String> {
    let profile_key = openclaw_runtime::require_profile_key(profile)?;
    let config = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile_key))?;
    if config.pointer("/gateway/mode").and_then(Value::as_str) == Some("remote") {
        return Err("右侧实时浏览器目前仅支持本机托管的 Browser Runtime。".to_string());
    }
    if config.pointer("/browser/enabled").and_then(Value::as_bool) != Some(true) {
        return Err("Browser Runtime 已关闭，请在运行中心启用后重试。".to_string());
    }
    if !browser_tool_policy_ready(&config) { return Err("Browser 工具策略未启用，已停止控制页面。".to_string()); }
    let managed = config.pointer("/browser/profiles/openclaw").ok_or("没有找到当前工作区的 OpenClaw 浏览器配置。")?;
    if managed.get("driver").and_then(Value::as_str) != Some("openclaw")
        || managed.get("cdpUrl").is_some_and(|value| !value.is_null())
        || managed.get("userDataDir").is_some_and(|value| !value.is_null())
        || managed.get("attachOnly").and_then(Value::as_bool) != Some(false)
    {
        return Err("当前工作区没有使用隔离托管的 OpenClaw 浏览器，已拒绝连接其他浏览器。".to_string());
    }
    let port = managed.get("cdpPort").and_then(Value::as_u64).ok_or("没有找到当前工作区的 Browser Runtime CDP 端口。")?;
    let expected_port = managed_browser_cdp_port(&profile_key)? as u64;
    if port != expected_port { return Err("Browser Runtime CDP 端口与当前工作区隔离配置不匹配。".to_string()); }
    let status = status_for_connection(Some(&profile_key), Some(DEFAULT_BROWSER_ACTION_PROFILE)).await
        .map_err(|_| "无法连接当前工作区引擎，请在运行中心重新连接后重试。".to_string())?;
    if !browser_status_belongs_to_workspace(&status, expected_port as u16, &workspace_browser_data_dir(&profile_key)?) {
        return Err("当前工作区的浏览器未连接，请先在运行中心连接该工作区。".to_string());
    }
    if !browser_status_is_ready(&status) {
        return Err("当前工作区的 OpenClaw Browser Runtime 尚未就绪，已停止读取或控制标签。".to_string());
    }
    let url = format!("http://127.0.0.1:{port}/json/list");
    let tabs: Vec<Value> = reqwest::Client::new().get(url).timeout(std::time::Duration::from_secs(3)).send().await.map_err(|e| format!("连接工作区 Browser Runtime 失败：{e}"))?.error_for_status().map_err(|e| format!("读取 Browser Runtime 标签失败：{e}"))?.json().await.map_err(|e| format!("解析 Browser Runtime 标签失败：{e}"))?;
    let tab = tabs.into_iter().find(|tab| tab.get("id").and_then(Value::as_str) == Some(target_id) && tab.get("type").and_then(Value::as_str) == Some("page")).ok_or("该标签已不在当前工作区的 Browser Runtime 中，请刷新标签列表。")?;
    let ws = tab.get("webSocketDebuggerUrl").and_then(Value::as_str).ok_or("浏览器标签没有提供 CDP 控制通道。")?.to_string();
    if !ws.starts_with(&format!("ws://127.0.0.1:{port}/")) && !ws.starts_with(&format!("ws://localhost:{port}/")) { return Err("Browser Runtime 返回了非本机 CDP 地址，已拒绝连接。".to_string()); }
    Ok((ws, tab))
}

async fn cdp_command(ws_url: &str, id: u64, method: &str, params: Value) -> Result<Value, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let (mut socket, _) = tokio::time::timeout(std::time::Duration::from_secs(3), tokio_tungstenite::connect_async(ws_url)).await.map_err(|_| "连接 Browser Runtime 控制通道超时。".to_string())?.map_err(|e| format!("连接 Browser Runtime 控制通道失败：{e}"))?;
    socket.send(Message::Text(json!({"id":id,"method":method,"params":params}).to_string().into())).await.map_err(|e| format!("发送浏览器操作失败：{e}"))?;
    loop {
        let message = tokio::time::timeout(std::time::Duration::from_secs(3), socket.next()).await.map_err(|_| "Browser Runtime 操作超时。".to_string())?.ok_or("Browser Runtime 控制通道已关闭。")?.map_err(|e| format!("读取浏览器响应失败：{e}"))?;
        if let Message::Text(text) = message {
            let value: Value = serde_json::from_str(&text).map_err(|e| format!("解析浏览器响应失败：{e}"))?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = value.get("error") { return Err(format!("浏览器操作失败：{error}")); }
                return Ok(value);
            }
        }
    }
}

fn browser_profile(profile: Option<&str>) -> String {
    profile
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(openclaw_runtime::DEFAULT_BROWSER_PROFILE)
        .to_string()
}

fn browser_request_with_timeout(
    method: &str,
    path: &str,
    profile: Option<&str>,
    body: Option<Value>,
    timeout_ms: u64,
) -> Value {
    let query = json!({ "profile": browser_profile(profile) });
    let mut request = json!({
        "method": method,
        "path": path,
        "query": query,
        "timeoutMs": timeout_ms
    });
    if let Some(body) = body {
        if let Some(object) = request.as_object_mut() {
            object.insert("body".to_string(), body);
        }
    }
    request
}

fn browser_request_query(
    method: &str,
    path: &str,
    query: Value,
    body: Option<Value>,
    timeout_ms: u64,
) -> Value {
    let mut request = json!({
        "method": method,
        "path": path,
        "query": query,
        "timeoutMs": timeout_ms
    });
    if let Some(body) = body {
        if let Some(object) = request.as_object_mut() {
            object.insert("body".to_string(), body);
        }
    }
    request
}

async fn status_for_connection(
    connection_profile: Option<&str>,
    browser_profile: Option<&str>,
) -> Result<Value, String> {
    proxy_request(
        connection_profile,
        "GET",
        "/",
        browser_profile,
        None,
        DEFAULT_BROWSER_REQUEST_TIMEOUT_SECS * 1000,
    )
    .await
}

async fn profiles_for_connection(connection_profile: Option<&str>) -> Result<Value, String> {
    openclaw_gateway::request_json_for_profile(
        connection_profile,
        "browser.request",
        json!({
            "method": "GET",
            "path": "/profiles",
            "timeoutMs": DEFAULT_BROWSER_REQUEST_TIMEOUT_SECS * 1000
        }),
        false,
        3,
        DEFAULT_BROWSER_REQUEST_TIMEOUT_SECS,
    )
    .await
}

async fn tabs_for_connection(
    connection_profile: Option<&str>,
    browser_profile: Option<&str>,
) -> Result<Value, String> {
    proxy_request(
        connection_profile,
        "GET",
        "/tabs",
        browser_profile,
        None,
        DEFAULT_BROWSER_REQUEST_TIMEOUT_SECS * 1000,
    )
    .await
}

async fn open_url_for_connection(
    connection_profile: Option<&str>,
    browser_profile: Option<&str>,
    url: &str,
    label: Option<&str>,
) -> Result<Value, String> {
    let trimmed_url = url.trim();
    if trimmed_url.is_empty() {
        return Err("URL 不能为空。".to_string());
    }
    if !trimmed_url.starts_with("http://") && !trimmed_url.starts_with("https://") {
        return Err("URL 必须以 http:// 或 https:// 开头。".to_string());
    }
    let mut body = json!({ "url": trimmed_url });
    if let Some(label) = label.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(object) = body.as_object_mut() {
            object.insert("label".to_string(), Value::String(label.to_string()));
        }
    }
    proxy_request(
        connection_profile,
        "POST",
        "/tabs/open",
        browser_profile,
        Some(body),
        DEFAULT_BROWSER_REQUEST_TIMEOUT_SECS * 1000,
    )
    .await
}

async fn snapshot_for_connection(
    connection_profile: Option<&str>,
    browser_profile: Option<&str>,
    target_id: Option<&str>,
) -> Result<Value, String> {
    let mut query = json!({
        "profile": browser_profile
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_BROWSER_ACTION_PROFILE),
        "format": "ai",
        "limit": "120"
    });
    if let Some(target_id) = target_id.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(object) = query.as_object_mut() {
            object.insert("targetId".to_string(), Value::String(target_id.to_string()));
        }
    }
    proxy_request_query(
        connection_profile,
        "GET",
        "/snapshot",
        query,
        None,
        DEFAULT_BROWSER_REQUEST_TIMEOUT_SECS * 1000,
    )
    .await
}

pub async fn runtime_snapshot(
    profile: Option<&str>,
    browser_profile_override: Option<&str>,
) -> Result<BrowserRuntimeSnapshot, String> {
    let profile_key = openclaw_runtime::require_profile_key(profile)?;
    let config = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile_key))?;
    let browser_profile = browser_profile_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BROWSER_ACTION_PROFILE)
        .to_string();
    let enabled = browser_enabled_from_config(&config);
    let tool_policy_ready = browser_tool_policy_ready(&config);
    let execution_target = execution_target_from_config(&config);
    let execution_target_label = match execution_target.as_str() {
        "this_mac" => "This Mac browser".to_string(),
        "host" => "Host browser".to_string(),
        _ => "Unavailable".to_string(),
    };

    let mut browser_status = None;
    let mut profiles = Vec::new();
    let mut tabs = Vec::new();
    let mut error = None;

    // Do not send browser requests until the engine has explicitly allowed the
    // official browser tool. Older or partially migrated engine profiles reject
    // those requests with an opaque `INVALID_REQUEST`, which otherwise leaks
    // straight into the conversations dock.
    if enabled && !tool_policy_ready {
        error = Some(BrowserRuntimeError {
            kind: "browser_tool_policy_missing".to_string(),
            message: "Official browser tool is not allowed in Uniopc 引擎 tools policy."
                .to_string(),
            next_action: "repair_browser_tool_policy".to_string(),
        });
    } else if enabled {
        match status_for_connection(Some(&profile_key), Some(&browser_profile)).await {
            Ok(value) => {
                browser_status = Some(value);
                if let Ok(value) = profiles_for_connection(Some(&profile_key)).await {
                    profiles = value
                        .get("profiles")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                }
                if let Ok(value) =
                    tabs_for_connection(Some(&profile_key), Some(&browser_profile)).await
                {
                    tabs = value
                        .get("tabs")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                }
            }
            Err(raw_error) => {
                error = Some(classify_browser_runtime_error(&raw_error));
            }
        }
    }

    let (pending_requests, paired_devices) = pairing_state(Some(&profile_key)).await;
    if error.is_none() && pending_requests.iter().any(pairing_requests_browser_scopes) {
        error = Some(BrowserRuntimeError {
            kind: "scope_upgrade_pending_approval".to_string(),
            message: "Browser Runtime scope upgrade pending approval.".to_string(),
            next_action: "approve_pairing_scope_upgrade".to_string(),
        });
    }

    let (status, message, next_action) = if !enabled {
        (
            "disabled".to_string(),
            "Browser Runtime disabled in Uniopc 引擎 config.".to_string(),
            "enable_browser_runtime".to_string(),
        )
    } else if let Some(error) = error.as_ref() {
        (
            error.kind.clone(),
            error.message.clone(),
            error.next_action.clone(),
        )
    } else if browser_status.as_ref().is_some_and(browser_status_is_ready) {
        (
            "ready".to_string(),
            "Browser Runtime ready.".to_string(),
            "use_browser".to_string(),
        )
    } else if browser_status.is_some() {
        (
            "stopped".to_string(),
            "专用浏览器尚未启动；AI 可调用 browser start 后继续。".to_string(),
            "start_browser_runtime".to_string(),
        )
    } else {
        (
            "unavailable".to_string(),
            "Browser Runtime status could not be determined.".to_string(),
            "run_browser_doctor".to_string(),
        )
    };

    Ok(BrowserRuntimeSnapshot {
        profile: profile_key,
        browser_profile,
        enabled,
        status,
        execution_target,
        execution_target_label,
        message,
        next_action,
        browser_status,
        profiles,
        tabs,
        pending_requests,
        paired_devices,
        error,
    })
}

/// Lightweight dock refresh: avoid fetching pairing and profile diagnostics on
/// the 1s UI cadence used to reflect navigation and newly opened tabs.
pub async fn browser_dock_snapshot(profile: Option<&str>) -> Result<BrowserDockSnapshot, String> {
    let profile_key = openclaw_runtime::require_profile_key(profile)?;
    let config = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile_key))?;
    let profile_config = config.pointer("/browser/profiles/openclaw");
    let local_managed = config.pointer("/gateway/mode").and_then(Value::as_str) != Some("remote")
        && profile_config.and_then(|value| value.get("driver")).and_then(Value::as_str) == Some("openclaw")
        && profile_config.and_then(|value| value.get("cdpUrl")).is_none_or(Value::is_null)
        && profile_config.and_then(|value| value.get("userDataDir")).is_none_or(Value::is_null);
    if !local_managed {
        return Ok(BrowserDockSnapshot { profile: profile_key, status: "unsupported_target".to_string(), message: "右侧实时面板只支持本机隔离托管的 OpenClaw 浏览器。".to_string(), tabs: Vec::new(), local_managed: false });
    }
    if !browser_enabled_from_config(&config) {
        return Ok(BrowserDockSnapshot { profile: profile_key, status: "disabled".to_string(), message: "Browser Runtime 已关闭，请在运行中心启用。".to_string(), tabs: Vec::new(), local_managed });
    }
    if !browser_tool_policy_ready(&config) {
        return Ok(BrowserDockSnapshot { profile: profile_key, status: "browser_tool_policy_missing".to_string(), message: "Browser 工具策略未启用，请在运行中心修复。".to_string(), tabs: Vec::new(), local_managed });
    }
    let port = managed_browser_cdp_port(&profile_key)?;
    let user_data_dir = workspace_browser_data_dir(&profile_key)?;
    match status_for_connection(Some(&profile_key), Some(DEFAULT_BROWSER_ACTION_PROFILE)).await {
        Ok(status) if !browser_status_belongs_to_workspace(&status, port, &user_data_dir) => {
            Ok(BrowserDockSnapshot { profile: profile_key, status: "workspace_not_connected".to_string(), message: "当前工作区的浏览器未连接，请先在运行中心连接该工作区。".to_string(), tabs: Vec::new(), local_managed })
        }
        Ok(status) if browser_status_is_ready(&status) => {
            let tabs = tabs_for_connection(Some(&profile_key), Some(DEFAULT_BROWSER_ACTION_PROFILE)).await
                .ok()
                .and_then(|value| value.get("tabs").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            if !dock_tabs_belong_to_port(&tabs, port) {
                return Ok(BrowserDockSnapshot { profile: profile_key, status: "workspace_not_connected".to_string(), message: "工作区连接已变化，请重新连接当前工作区浏览器。".to_string(), tabs: Vec::new(), local_managed });
            }
            Ok(BrowserDockSnapshot { profile: profile_key, status: "ready".to_string(), message: "Browser Runtime ready.".to_string(), tabs, local_managed })
        }
        Ok(_) => Ok(BrowserDockSnapshot { profile: profile_key, status: "stopped".to_string(), message: "专用浏览器尚未启动；可在对话中要求 AI 打开网页。".to_string(), tabs: Vec::new(), local_managed }),
        Err(error) => {
            let classified = classify_browser_runtime_error(&error);
            Ok(BrowserDockSnapshot { profile: profile_key, message: browser_dock_error_message(&classified), status: classified.kind, tabs: Vec::new(), local_managed })
        }
    }
}

pub async fn set_enabled(profile: Option<&str>, enabled: bool) -> Result<Value, String> {
    let profile_key = openclaw_runtime::require_profile_key(profile)?;
    let root = openclaw_gateway::load_openclaw_config_for_profile(Some(&profile_key))?;
    let patch = browser_runtime_config_patch(&root, enabled, &profile_key)?;
    match openclaw_gateway::config_patch(Some(&profile_key), patch.clone()).await {
        Ok(result) => {
            return Ok(json!({
                "profile": profile_key,
                "enabled": enabled,
                "appliedVia": "gateway_config_patch",
                "patch": patch,
                "result": result
            }));
        }
        Err(gateway_error) => {
            persist_browser_runtime_config_patch(&profile_key, root, patch.clone())?;
            return Ok(json!({
                "profile": profile_key,
                "enabled": enabled,
                "appliedVia": "local_file_fallback",
                "warning": format!("Gateway config.patch 失败，已写入本地配置；重启 Gateway 后生效：{gateway_error}"),
                "patch": patch
            }));
        }
    }
}

fn browser_runtime_config_patch(config: &Value, enabled: bool, profile_key: &str) -> Result<Value, String> {
    let mut root = Map::new();
    let local_managed = enabled && config.pointer("/gateway/mode").and_then(Value::as_str) != Some("remote");
    let browser = if local_managed {
        json!({
            "enabled": true,
            "defaultProfile": "openclaw",
            "allowSystemProfileImport": false,
            "profiles": { "openclaw": {
                "driver": "openclaw",
                "cdpPort": managed_browser_cdp_port(profile_key)?,
                "cdpUrl": null,
                "userDataDir": null,
                "attachOnly": false
            }}
        })
    } else { json!({ "enabled": enabled }) };
    root.insert("browser".to_string(), browser);
    root.insert(
        "tools".to_string(),
        json!({
            "alsoAllow": reconcile_string_array(
                string_array_at(config, &["tools", "alsoAllow"]).unwrap_or_default(),
                BROWSER_TOOL_ID,
                enabled,
            )
        }),
    );

    let mut plugins_patch = Map::new();
    plugins_patch.insert(
        "entries".to_string(),
        json!({ "browser": { "enabled": enabled } }),
    );
    if local_managed {
        root.insert("gateway".to_string(), json!({ "nodes": { "browser": { "mode": "off" } } }));
    }
    if let Some(allow) = string_array_at(config, &["plugins", "allow"]) {
        plugins_patch.insert(
            "allow".to_string(),
            json!(reconcile_string_array(allow, BROWSER_TOOL_ID, enabled)),
        );
    }
    if enabled {
        if let Some(deny) = string_array_at(config, &["plugins", "deny"]) {
            plugins_patch.insert(
                "deny".to_string(),
                json!(reconcile_string_array(deny, BROWSER_TOOL_ID, false)),
            );
        }
    }
    if !plugins_patch.is_empty() {
        root.insert("plugins".to_string(), Value::Object(plugins_patch));
    }

    Ok(Value::Object(root))
}

// Persist a workspace-specific CDP endpoint: a browser can survive Gateway restart
// and must never be adopted by the next workspace using the same Gateway port.
fn managed_browser_cdp_port(profile_key: &str) -> Result<u16, String> {
    let root = crate::services::uniopc_runtime_paths::uniopc_data_dir()?.join("browser-ports");
    let state = crate::services::uniopc_runtime_paths::state_v8_dir_for_profile(Some(profile_key))?;
    reserve_browser_cdp_port(&root, &state.to_string_lossy())
}

fn reserve_browser_cdp_port(root: &std::path::Path, owner: &str) -> Result<u16, String> {
    use std::io::Write;
    fs::create_dir_all(root).map_err(|e| format!("创建浏览器端口目录失败：{e}"))?;
    // Serialize claims across desktop processes; dropping the descriptor releases
    // the advisory lock even when a claim fails.
    #[cfg(unix)]
    let _lock = {
        use std::os::fd::AsRawFd;
        let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
            .open(root.join(".lock")).map_err(|e| format!("打开浏览器端口锁失败：{e}"))?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(format!("锁定浏览器端口失败：{}", std::io::Error::last_os_error()));
        }
        lock
    };
    let digest = Sha256::digest(owner.as_bytes());
    let start = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 20000;
    for offset in 0..20000 {
        let port = 40000 + ((start + offset) % 20000) as u16;
        let path = root.join(port.to_string());
        // Never claim an endpoint already occupied by an unrelated process.
        // Existing claims may be held by this workspace's persistent Chrome.
        let _probe = if !path.exists() {
            match std::net::TcpListener::bind(("127.0.0.1", port)) {
                Ok(listener) => Some(listener),
                Err(_) => continue,
            }
        } else { None };
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(owner.as_bytes()).map_err(|e| format!("保存浏览器端口归属失败：{e}"))?;
                return Ok(port);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if fs::read_to_string(&path).ok().as_deref() == Some(owner) { return Ok(port); }
            }
            Err(e) => return Err(format!("预留浏览器端口失败：{e}")),
        }
    }
    Err("没有可用的专用浏览器端口，请到运行中心重新检测。".to_string())
}

pub(crate) fn startup_config_patch(config: &Value, profile_key: &str) -> Value {
    if config.pointer("/gateway/mode").and_then(Value::as_str) == Some("remote") { return json!({}); }
    let explicitly_disabled = config.pointer("/plugins/enabled").and_then(Value::as_bool) == Some(false) || config.pointer("/browser/enabled").and_then(Value::as_bool)
        == Some(false)
        || config
            .pointer("/plugins/entries/browser/enabled")
            .and_then(Value::as_bool)
            == Some(false)
        || string_array_at(config, &["plugins", "deny"])
            .unwrap_or_default()
            .iter()
            .any(|s| s == "browser")
        || string_array_at(config, &["tools", "deny"])
            .unwrap_or_default()
            .iter()
            .any(|s| matches!(s.as_str(), "browser" | "group:ui" | "*"));
    if explicitly_disabled {
        return json!({});
    }
    browser_runtime_config_patch(config, true, profile_key).unwrap_or_else(|error| {
        eprintln!("[browser] workspace browser configuration unavailable: {error}");
        json!({})
    })
}

fn string_array_at(value: &Value, path: &[&str]) -> Option<Vec<String>> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_array().map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    })
}

fn reconcile_string_array(existing: Vec<String>, item: &str, enabled: bool) -> Vec<String> {
    let item = item.trim();
    let mut seen = std::collections::HashSet::new();
    let mut values = Vec::new();
    for existing in existing {
        let existing = existing.trim();
        if existing.is_empty() || (!enabled && existing == item) {
            continue;
        }
        if seen.insert(existing.to_string()) {
            values.push(existing.to_string());
        }
    }
    if enabled && !item.is_empty() && seen.insert(item.to_string()) {
        values.push(item.to_string());
    }
    values
}

fn browser_tool_policy_ready(config: &Value) -> bool {
    let tools_allow_browser = string_array_at(config, &["tools", "alsoAllow"])
        .unwrap_or_default()
        .iter()
        .any(|item| item == BROWSER_TOOL_ID);
    let plugins_allow_browser = string_array_at(config, &["plugins", "allow"])
        .map(|items| items.iter().any(|item| item == BROWSER_TOOL_ID))
        .unwrap_or(true);
    let plugins_deny_browser = string_array_at(config, &["plugins", "deny"])
        .unwrap_or_default()
        .iter()
        .any(|item| item == BROWSER_TOOL_ID);

    let plugin_enabled = config.pointer("/plugins/enabled").and_then(Value::as_bool) != Some(false) && config
        .pointer("/plugins/entries/browser/enabled")
        .and_then(Value::as_bool)
        != Some(false);
    let tool_denied = string_array_at(config, &["tools", "deny"])
        .unwrap_or_default()
        .iter()
        .any(|item| matches!(item.as_str(), "browser" | "group:ui" | "*"));
    tools_allow_browser
        && plugins_allow_browser
        && !plugins_deny_browser
        && plugin_enabled
        && !tool_denied
}

#[cfg(test)]
fn browser_enabled_config_patch(enabled: bool) -> Value {
    json!({ "browser": { "enabled": enabled } })
}

fn persist_browser_runtime_config_patch(
    profile_key: &str,
    mut root: Value,
    patch: Value,
) -> Result<(), String> {
    let path = openclaw_gateway::openclaw_config_path_for_profile(Some(profile_key))?;
    merge_json_object(&mut root, patch)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 Uniopc 引擎 配置目录失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("序列化 Uniopc 引擎 browser 配置失败: {e}"))?;
    fs::write(path, raw).map_err(|e| format!("保存 Uniopc 引擎 browser 配置失败: {e}"))?;
    Ok(())
}

pub async fn action(input: BrowserActionInput) -> Result<Value, String> {
    let action = input.action.trim().to_ascii_lowercase();
    let profile = input.profile.as_deref();
    let browser_profile = input.browser_profile.as_deref();
    let timeout_ms = input
        .timeout_ms
        .unwrap_or(DEFAULT_BROWSER_REQUEST_TIMEOUT_SECS * 1000);

    match action.as_str() {
        "status" => status_for_connection(profile, browser_profile).await,
        "profiles" => profiles_for_connection(profile).await,
        "tabs" => tabs_for_connection(profile, browser_profile).await,
        "open" => {
            open_url_for_connection(
                profile,
                browser_profile,
                input.url.as_deref().unwrap_or_default(),
                input.label.as_deref(),
            )
            .await
        }
        "snapshot" => {
            snapshot_for_connection(profile, browser_profile, input.target_id.as_deref()).await
        }
        "start" => {
            proxy_request(profile, "POST", "/start", browser_profile, None, timeout_ms).await
        }
        "stop" => proxy_request(profile, "POST", "/stop", browser_profile, None, timeout_ms).await,
        "doctor" => {
            proxy_request(profile, "GET", "/doctor", browser_profile, None, timeout_ms).await
        }
        "screenshot" => proxy_get_with_target(profile, "/screenshot", &input, timeout_ms).await,
        "console" => proxy_get_with_target(profile, "/console", &input, timeout_ms).await,
        "navigate" => {
            let body = json_body(&input, &["url", "targetId", "label"])?;
            proxy_request(
                profile,
                "POST",
                "/navigate",
                browser_profile,
                Some(body),
                timeout_ms,
            )
            .await
        }
        "click" | "type" | "key" => {
            let body = official_act_body(&input, &action)?;
            proxy_request(
                profile,
                "POST",
                "/act",
                browser_profile,
                Some(body),
                timeout_ms,
            )
            .await
        }
        "focus" => {
            let body = json_body(&input, &["targetId"])?;
            proxy_request(
                profile,
                "POST",
                "/tabs/focus",
                browser_profile,
                Some(body),
                timeout_ms,
            )
            .await
        }
        "close" => {
            let target_id = input.target_id.as_deref().map(str::trim)
                .filter(|target| !target.is_empty())
                .ok_or("关闭浏览器标签需要 targetId。")?;
            let path = format!("/tabs/{}", urlencoding::encode(target_id));
            proxy_request(profile, "DELETE", &path, browser_profile, None, timeout_ms).await
        }
        other => Err(format!("Unsupported Uniopc 引擎 browser action: {other}")),
    }
}

async fn proxy_get_with_target(
    profile: Option<&str>,
    path: &str,
    input: &BrowserActionInput,
    timeout_ms: u64,
) -> Result<Value, String> {
    let mut query = json!({ "profile": browser_profile(input.browser_profile.as_deref()) });
    if let Some(target_id) = input
        .target_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        if let Some(object) = query.as_object_mut() {
            object.insert("targetId".to_string(), Value::String(target_id.to_string()));
        }
    }
    proxy_request_query(profile, "GET", path, query, None, timeout_ms).await
}

async fn proxy_request(
    profile: Option<&str>,
    method: &str,
    path: &str,
    browser_profile: Option<&str>,
    body: Option<Value>,
    timeout_ms: u64,
) -> Result<Value, String> {
    openclaw_gateway::request_json_for_profile(
        profile,
        "browser.request",
        browser_request_with_timeout(method, path, browser_profile, body, timeout_ms),
        false,
        3,
        DEFAULT_BROWSER_REQUEST_TIMEOUT_SECS,
    )
    .await
}

async fn proxy_request_query(
    profile: Option<&str>,
    method: &str,
    path: &str,
    query: Value,
    body: Option<Value>,
    timeout_ms: u64,
) -> Result<Value, String> {
    openclaw_gateway::request_json_for_profile(
        profile,
        "browser.request",
        browser_request_query(method, path, query, body, timeout_ms),
        false,
        3,
        DEFAULT_BROWSER_REQUEST_TIMEOUT_SECS,
    )
    .await
}

// The official Runtime accepts interactive snapshot refs through /act.
// Keep typed text exact (including whitespace and empty values used to clear fields).
fn official_act_body(input: &BrowserActionInput, action: &str) -> Result<Value, String> {
    let fields: &[&str] = match action {
        "click" | "type" => &["targetId", "selector", "ref"],
        "key" => &["targetId", "key"],
        _ => return Err("不支持的浏览器交互。".to_string()),
    };
    let mut body = json_body(input, fields)?;
    if action == "key" {
        if body.get("key").is_none() {
            return Err("浏览器按键操作需要 key。".to_string());
        }
    } else if body.get("ref").is_none() && body.get("selector").is_none() {
        return Err("浏览器交互需要当前快照的 ref 或 selector。".to_string());
    }
    body["kind"] = json!(if action == "key" { "press" } else { action });
    if action == "type" {
        body["text"] = json!(input.text.as_ref().ok_or("浏览器输入操作需要 text。")?);
        body["submit"] = json!(false);
    }
    Ok(body)
}

fn json_body(input: &BrowserActionInput, fields: &[&str]) -> Result<Value, String> {
    let mut body = serde_json::Map::new();
    for field in fields {
        let value = match *field {
            "url" => input.url.as_deref(),
            "label" => input.label.as_deref(),
            "targetId" => input.target_id.as_deref(),
            "selector" => input.selector.as_deref(),
            "ref" => input.ref_id.as_deref(),
            "text" => input.text.as_deref(),
            "key" => input.key.as_deref(),
            _ => None,
        };
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            body.insert((*field).to_string(), Value::String(value.to_string()));
        }
    }
    if body.is_empty() {
        return Err("Uniopc 引擎 browser action requires parameters.".to_string());
    }
    Ok(Value::Object(body))
}

async fn pairing_state(profile: Option<&str>) -> (Vec<Value>, Vec<Value>) {
    match openclaw_gateway::call_json(profile, "device.pair.list", json!({}), false).await {
        Ok(value) => (
            extract_object_array(&value, &["pending", "pendingRequests", "requests"]),
            extract_object_array(&value, &["pairedDevices", "devices", "paired"]),
        ),
        Err(_) => (Vec::new(), Vec::new()),
    }
}

fn extract_object_array(value: &Value, keys: &[&str]) -> Vec<Value> {
    for key in keys {
        if let Some(items) = value.get(*key).and_then(Value::as_array) {
            return items.clone();
        }
    }
    Vec::new()
}

fn pairing_requests_browser_scopes(value: &Value) -> bool {
    value
        .get("scopes")
        .and_then(Value::as_array)
        .is_some_and(|scopes| {
            scopes.iter().filter_map(Value::as_str).any(|scope| {
                matches!(
                    scope.trim(),
                    "operator.admin" | "operator.approvals" | "operator.pairing"
                )
            })
        })
}

fn browser_status_is_ready(status: &Value) -> bool {
    status.get("cdpReady").and_then(Value::as_bool) == Some(true)
        && status.get("running").and_then(Value::as_bool) == Some(true)
}

fn browser_enabled_from_config(config: &Value) -> bool {
    config
        .get("browser")
        .and_then(Value::as_object)
        .and_then(|browser| browser.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn execution_target_from_config(config: &Value) -> String {
    let mode = config
        .get("gateway")
        .and_then(Value::as_object)
        .and_then(|gateway| gateway.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("local");
    if mode == "remote" {
        "host".to_string()
    } else {
        "this_mac".to_string()
    }
}

fn classify_browser_runtime_error(error: &str) -> BrowserRuntimeError {
    let normalized = error.to_ascii_lowercase();
    let (kind, next_action, message) = if normalized.contains("unknown method: browser.request") {
        (
            "gateway_browser_rpc_unsupported",
            "repair_browser_tool_policy",
            "当前 Gateway 未注册 browser.request。请到运行中心修复并开启浏览器控制，重启引擎后重新检测。".to_string(),
        )
    } else if normalized.contains("browser request rejected") {
        ("browser_request_rejected", "repair_browser_tool_policy", "浏览器控制请求被引擎拒绝。请检查浏览器插件和工具策略，修复并开启后重启再检测。".to_string())
    } else if normalized.contains("scope upgrade")
        || normalized.contains("more scopes")
        || normalized.contains("pairing required")
    {
        (
            "scope_upgrade_pending_approval",
            "approve_pairing_scope_upgrade",
            error.trim().to_string(),
        )
    } else if normalized.contains("browser_disabled") || normalized.contains("browser disabled") {
        (
            "browser_disabled",
            "enable_browser_runtime",
            error.trim().to_string(),
        )
    } else if normalized.contains("openclaw node start")
        || normalized.contains("browser control is owned by the cli node-host")
    {
        (
            "node_host_required",
            "start_host_browser_node",
            error.trim().to_string(),
        )
    } else if normalized.contains("cannot reach")
        || normalized.contains("unavailable")
        || normalized.contains("connection")
        || normalized.contains("connect")
    {
        (
            "control_api_unreachable",
            "run_browser_doctor",
            error.trim().to_string(),
        )
    } else {
        (
            "browser_error",
            "run_browser_doctor",
            error.trim().to_string(),
        )
    };
    BrowserRuntimeError {
        kind: kind.to_string(),
        message,
        next_action: next_action.to_string(),
    }
}

fn merge_json_object(target: &mut Value, patch: Value) -> Result<(), String> {
    let target_object = target
        .as_object_mut()
        .ok_or_else(|| "Uniopc 引擎 config root 必须是对象。".to_string())?;
    let patch_object = patch
        .as_object()
        .ok_or_else(|| "Uniopc 引擎 browser config patch 必须是对象。".to_string())?;
    for (key, value) in patch_object {
        if value.is_null() { target_object.remove(key); continue; }
        if value.is_object() {
            let child = target_object.entry(key.clone()).or_insert_with(|| json!({}));
            if !child.is_object() { *child = json!({}); }
            merge_json_object(child, value.clone())?;
        } else {
            target_object.insert(key.clone(), value.clone());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn official_interactions_use_current_refs_and_preserve_input() {
        let input: BrowserActionInput = serde_json::from_value(json!({
            "action":"type", "targetId":"owned-tab", "refId":"e12", "text":"  中文\n "
        })).unwrap();
        assert_eq!(official_act_body(&input, "type").unwrap(), json!({
            "kind":"type", "targetId":"owned-tab", "ref":"e12", "text":"  中文\n ", "submit":false
        }));
        let empty: BrowserActionInput = serde_json::from_value(json!({
            "action":"type", "refId":"e12", "text":""
        })).unwrap();
        assert_eq!(official_act_body(&empty, "type").unwrap()["text"], "");
        let missing: BrowserActionInput = serde_json::from_value(json!({
            "action":"click", "targetId":"owned-tab"
        })).unwrap();
        assert!(official_act_body(&missing, "click").is_err());
        let key: BrowserActionInput = serde_json::from_value(json!({
            "action":"key", "targetId":"owned-tab", "key":"Enter"
        })).unwrap();
        assert_eq!(official_act_body(&key, "key").unwrap(), json!({
            "kind":"press", "targetId":"owned-tab", "key":"Enter"
        }));
    }

    #[test]
    fn browser_ready_requires_a_live_cdp_connection() {
        assert!(!browser_status_is_ready(&json!({"enabled":true, "running":false, "cdpReady":false})));
        assert!(!browser_status_is_ready(&json!({"running":true, "cdpReady":false})));
        assert!(!browser_status_is_ready(&json!({})));
        assert!(browser_status_is_ready(&json!({"running":true, "cdpReady":true})));
    }

    #[test]
    fn browser_repair_local_fallback_deletes_legacy_session_binding() {
        let mut config = json!({"browser":{"profiles":{"openclaw":{"driver":"existing-session", "userDataDir":"/personal/chrome", "cdpUrl":"http://127.0.0.1:9222"}}}});
        let patch = browser_runtime_config_patch(&config, true, "workspace-a").unwrap();
        merge_json_object(&mut config, patch).unwrap();
        assert_eq!(config["browser"]["profiles"]["openclaw"]["driver"], "openclaw");
        assert!(config["browser"]["profiles"]["openclaw"].get("cdpUrl").is_none());
        assert!(config["browser"]["profiles"]["openclaw"].get("userDataDir").is_none());
        assert_eq!(startup_config_patch(&json!({"gateway":{"mode":"remote"}}), "workspace-a"), json!({}));
    }

    #[test]
    fn browser_dock_connection_failure_gives_a_recovery_action() {
        let classified = classify_browser_runtime_error("连接 Uniopc 引擎 失败: IO error: Connection refused (os error 61)");
        assert_eq!(browser_dock_error_message(&classified), "工作区引擎连接已中断，请在运行中心重新连接后重试。");
    }

    #[test]
    fn browser_dock_primary_select_all_requests_the_chromium_edit_command() {
        let primary = if cfg!(target_os = "macos") { 4 } else { 2 };
        assert_eq!(browser_dock_editing_commands("a", primary), vec!["selectAll"]);
        assert_eq!(browser_dock_editing_commands("A", primary), vec!["selectAll"]);
        assert!(browser_dock_editing_commands("a", 0).is_empty());
        assert!(browser_dock_editing_commands("a", primary | 8).is_empty());
        assert!(browser_dock_editing_commands("c", primary).is_empty());
    }

    #[test]
    fn browser_dock_rejects_another_workspaces_gateway_and_tabs() {
        let a = std::path::Path::new("/isolated/workspace-a/browser/openclaw/user-data");
        let b = std::path::Path::new("/isolated/workspace-b/browser/openclaw/user-data");
        let status_a = json!({"cdpPort":55091,"userDataDir":a});
        let status_b = json!({"cdpPort":47809,"userDataDir":b});
        assert!(browser_status_belongs_to_workspace(&status_a, 55091, a));
        assert!(browser_status_belongs_to_workspace(&status_b, 47809, b));
        assert!(!browser_status_belongs_to_workspace(&status_a, 47809, b));
        assert!(!browser_status_belongs_to_workspace(&status_a, 55091, b));
        assert!(!browser_status_belongs_to_workspace(&json!({"cdpPort":55091}), 55091, a));
        assert!(browser_status_belongs_to_workspace(&json!({"cdpPort":55091,"running":false,"cdpReady":false,"userDataDir":null}), 55091, a));
        assert!(!browser_status_belongs_to_workspace(&json!({"cdpPort":55091,"running":false}), 47809, b));
        assert!(!browser_status_belongs_to_workspace(&json!({"cdpPort":55091,"running":true,"cdpReady":true}), 55091, a));
        let tabs_a = vec![json!({"targetId":"a", "url":"https://workspace-a.example", "wsUrl":"ws://127.0.0.1:55091/devtools/page/a"})];
        assert!(dock_tabs_belong_to_port(&tabs_a, 55091));
        assert!(!dock_tabs_belong_to_port(&tabs_a, 47809));
        assert!(!dock_tabs_belong_to_port(&[json!({"wsUrl":"ws://127.0.0.1:550910/devtools/page/a"})], 55091));
    }

    #[test]
    fn browser_port_reservation_is_persistent_and_resolves_collisions() {
        let root = std::env::temp_dir().join(format!("uniopc-browser-ports-{}", uuid::Uuid::new_v4()));
        let owner = "workspace-a";
        let digest = Sha256::digest(owner.as_bytes());
        let first = 40000 + (u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 20000) as u16;
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(first.to_string()), "other-workspace").unwrap();
        let port = reserve_browser_cdp_port(&root, owner).unwrap();
        assert_ne!(port, first);
        assert_eq!(reserve_browser_cdp_port(&root, owner).unwrap(), port);
        assert_ne!(reserve_browser_cdp_port(&root, "workspace-b").unwrap(), port);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn browser_startup_respects_explicit_disables_and_denies() {
        for config in [
            json!({"browser":{"enabled":false}}),
            json!({"plugins":{"entries":{"browser":{"enabled":false}}}}),
            json!({"plugins":{"deny":["browser"]}}),
            json!({"tools":{"deny":["group:ui"]}}),
        ] {
            assert_eq!(startup_config_patch(&config, "workspace-a"), json!({}));
        }
        let patch = startup_config_patch(&json!({"tools":{"alsoAllow":["custom"]},"plugins":{"allow":["custom"]}}), "workspace-a");
        assert_eq!(patch["browser"]["defaultProfile"], "openclaw");
        assert_eq!(patch["browser"]["profiles"]["openclaw"]["driver"], "openclaw");
        assert_eq!(patch["gateway"]["nodes"]["browser"]["mode"], "off");
        assert_eq!(patch["tools"]["alsoAllow"], json!(["custom", "browser"]));
        assert_eq!(patch["plugins"]["allow"], json!(["custom", "browser"]));
    }

    #[test]
    fn browser_runtime_classifies_scope_upgrade_errors_as_needing_approval() {
        let classified = classify_browser_runtime_error(
            "scope upgrade pending approval: pairing required: device is asking for more scopes than currently approved",
        );

        assert_eq!(classified.kind, "scope_upgrade_pending_approval");
        assert_eq!(classified.next_action, "approve_pairing_scope_upgrade");
    }

    #[test]
    fn browser_runtime_explains_missing_gateway_browser_rpc_without_leaking_raw_error() {
        let classified =
            classify_browser_runtime_error("INVALID_REQUEST: unknown method: browser.request");

        assert_eq!(classified.kind, "gateway_browser_rpc_unsupported");
        assert_eq!(classified.next_action, "repair_browser_tool_policy");
        assert!(classified.message.contains("修复并开启"));
        assert!(!classified.message.contains("INVALID_REQUEST"));
    }

    #[test]
    fn browser_enabled_patch_matches_official_config_shape() {
        assert_eq!(
            browser_enabled_config_patch(true),
            json!({ "browser": { "enabled": true } })
        );
        assert_eq!(
            browser_enabled_config_patch(false),
            json!({ "browser": { "enabled": false } })
        );
    }

    #[test]
    fn browser_runtime_enable_patch_allows_official_browser_tool() {
        let patch = browser_runtime_config_patch(
            &json!({
                "browser": { "enabled": false },
                "tools": {
                    "profile": "coding",
                    "alsoAllow": ["uniopc-cloud-workspace"]
                },
                "plugins": {
                    "allow": ["uniopc-cloud-workspace"],
                    "deny": ["browser", "other"]
                }
            }),
            true,
            "workspace-a",
        ).unwrap();

        assert_eq!(patch["browser"]["enabled"], true);
        assert_eq!(
            patch["tools"]["alsoAllow"],
            json!(["uniopc-cloud-workspace", "browser"])
        );
        assert_eq!(
            patch["plugins"]["allow"],
            json!(["uniopc-cloud-workspace", "browser"])
        );
        assert_eq!(patch["plugins"]["deny"], json!(["other"]));
    }

    #[test]
    fn browser_runtime_enable_patch_does_not_create_restrictive_plugin_allow_list() {
        let patch = browser_runtime_config_patch(
            &json!({ "tools": { "profile": "coding" } }),
            true,
            "workspace-a",
        ).unwrap();

        assert_eq!(patch["browser"]["enabled"], true);
        assert_eq!(patch["tools"]["alsoAllow"], json!(["browser"]));
        assert!(patch["plugins"].get("allow").is_none());
        assert_eq!(patch["plugins"]["entries"]["browser"]["enabled"], true);
    }

    #[test]
    fn browser_runtime_disable_patch_removes_official_browser_tool_allow() {
        let patch = browser_runtime_config_patch(
            &json!({
                "browser": { "enabled": true },
                "tools": {
                    "profile": "coding",
                    "alsoAllow": ["browser", "uniopc-cloud-workspace"]
                },
                "plugins": {
                    "allow": ["browser", "uniopc-cloud-workspace"]
                }
            }),
            false,
            "workspace-a",
        ).unwrap();

        assert_eq!(patch["browser"]["enabled"], false);
        assert_eq!(
            patch["tools"]["alsoAllow"],
            json!(["uniopc-cloud-workspace"])
        );
        assert_eq!(patch["plugins"]["allow"], json!(["uniopc-cloud-workspace"]));
    }

    #[test]
    fn browser_tool_policy_requires_official_browser_tool_allow() {
        assert!(!browser_tool_policy_ready(&json!({
            "tools": { "profile": "coding" }
        })));
        assert!(browser_tool_policy_ready(&json!({
            "tools": { "profile": "coding", "alsoAllow": ["browser"] }
        })));
        assert!(!browser_tool_policy_ready(&json!({
            "tools": { "alsoAllow": ["browser"] },
            "plugins": { "allow": ["uniopc-cloud-workspace"] }
        })));
        assert!(!browser_tool_policy_ready(&json!({
            "tools": { "alsoAllow": ["browser"] },
            "plugins": { "deny": ["browser"] }
        })));
    }
}
