//! Native bridge for the Smart Montage application's local final render.
//!
//! Copywriting and MiniMax narration stay in their cloud services; this command
//! starts the reviewed, installed `uniopc-montage` plugin for FFmpeg/Remotion
//! work.  The renderer receives only its own scoped host credential and reports
//! a JSON-lines progress protocol.  The webview never sees that credential.

use crate::commands::openclaw_plugins::gateway_plugin_private_env;
use crate::services::{openclaw_cli, openclaw_system_plugins, uniopc_runtime_paths};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Arc};
use tauri::State;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
};
use uuid::Uuid;

const PLUGIN_ID: &str = "uniopc-montage";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMontageStartRequest {
    pub profile: String,
    pub collection_id: String,
    pub voice_id: String,
    pub transcript: String,
    #[serde(default)]
    pub voice_source: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub captions: Option<bool>,
    #[serde(default)]
    pub resume_job_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMontageStatusRequest {
    pub profile: String,
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMontageJob {
    pub job_id: String,
    pub profile: String,
    pub status: String,
    pub stage: String,
    pub message: String,
    pub error: String,
    pub resume_job_id: String,
    pub output_path: String,
    pub work_url: String,
    pub duration_seconds: f64,
}

#[derive(Default, Clone)]
pub struct LocalMontageRenders {
    jobs: Arc<Mutex<HashMap<String, LocalMontageJob>>>,
}

fn clean(value: &str) -> String {
    value.trim().to_string()
}

fn ensure_request(input: &LocalMontageStartRequest) -> Result<(), String> {
    if clean(&input.profile).is_empty() {
        return Err("本机混剪缺少当前桌面 profile，请重新登录后再试".to_string());
    }
    if clean(&input.collection_id).is_empty() {
        return Err("请选择视频素材集合".to_string());
    }
    if clean(&input.voice_id).is_empty() {
        return Err("请选择旁白音色".to_string());
    }
    let transcript_length = input.transcript.trim().chars().count();
    if transcript_length == 0 || transcript_length > 20_000 {
        return Err("文案不能为空且不能超过 20000 字".to_string());
    }
    if let Some(source) = input.voice_source.as_deref() {
        if !source.trim().is_empty() && !matches!(source.trim(), "minimax" | "macos" | "windows") {
            return Err("不支持的旁白来源".to_string());
        }
    }
    Ok(())
}

fn montage_private_env(profile: &str) -> Result<Vec<(String, String)>, String> {
    let values = gateway_plugin_private_env(Some(profile));
    let api_url = values
        .iter()
        .find(|(key, _)| key == "UNIOPC_MONTAGE_API_URL")
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    let credential = values
        .iter()
        .find(|(key, _)| key == "UNIOPC_MONTAGE_HOST_CREDENTIAL")
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    if api_url.is_empty() || credential.is_empty() {
        return Err("本机智能混剪插件尚未完成授权；请在「插件」中更新 Smart Montage 并重启 Uniopc".to_string());
    }
    // Never forward the aggregate plugin env map: an installed renderer only
    // receives the two values it requires for its own business service.
    Ok(vec![
        ("UNIOPC_MONTAGE_API_URL".to_string(), api_url),
        ("UNIOPC_MONTAGE_HOST_CREDENTIAL".to_string(), credential),
    ])
}

fn installed_runner(profile: &str) -> Result<PathBuf, String> {
    let plugin_dir = openclaw_system_plugins::installed_system_plugin_path_for_profile(Some(profile), PLUGIN_ID)?;
    let runner = plugin_dir.join("bin").join("local-render.mjs");
    if !runner.is_file() {
        return Err("Smart Montage 插件版本不支持本机渲染；请在插件市场更新到最新版本并重启".to_string());
    }
    Ok(runner)
}

fn bundled_node() -> Result<PathBuf, String> {
    let binary = if cfg!(windows) { "node.exe" } else { "node" };
    let path = uniopc_runtime_paths::runtime_node_bin_dir()?.join(binary);
    if !path.is_file() {
        return Err("Uniopc 本机运行时尚未就绪；请重启 Uniopc 后重试".to_string());
    }
    Ok(path)
}

fn fresh_job(profile: String) -> LocalMontageJob {
    LocalMontageJob {
        job_id: format!("desktop-montage-{}", Uuid::new_v4()),
        profile,
        status: "queued".to_string(),
        stage: "queued".to_string(),
        message: "等待本机渲染器启动".to_string(),
        error: String::new(),
        resume_job_id: String::new(),
        output_path: String::new(),
        work_url: String::new(),
        duration_seconds: 0.0,
    }
}

async fn update_job(jobs: &Arc<Mutex<HashMap<String, LocalMontageJob>>>, job_id: &str, patch: impl FnOnce(&mut LocalMontageJob)) {
    if let Some(job) = jobs.lock().await.get_mut(job_id) {
        patch(job);
    }
}

async fn consume_renderer_output(
    jobs: Arc<Mutex<HashMap<String, LocalMontageJob>>>,
    job_id: String,
    mut child: tokio::process::Child,
) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_jobs = jobs.clone();
    let stdout_job_id = job_id.clone();
    let read_stdout = tokio::spawn(async move {
        let Some(stdout) = stdout else { return; };
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue; };
            let name = event.get("event").and_then(Value::as_str).unwrap_or_default();
            match name {
                "started" => update_job(&stdout_jobs, &stdout_job_id, |job| {
                    job.status = "running".to_string();
                    job.stage = "starting".to_string();
                    job.message = "本机渲染器已启动".to_string();
                }).await,
                "progress" => {
                    let stage = event.get("stage").and_then(Value::as_str).unwrap_or("rendering");
                    let message = event.get("message").and_then(Value::as_str).unwrap_or("正在本机制作视频");
                    update_job(&stdout_jobs, &stdout_job_id, |job| {
                        job.status = "running".to_string();
                        job.stage = stage.to_string();
                        job.message = message.to_string();
                    }).await;
                }
                "completed" => update_job(&stdout_jobs, &stdout_job_id, |job| {
                    job.status = "completed".to_string();
                    job.stage = "completed".to_string();
                    job.message = "本机视频和字幕已完成，并已归入作品".to_string();
                    job.output_path = event.get("outputPath").and_then(Value::as_str).unwrap_or_default().to_string();
                    job.work_url = event.get("workUrl").and_then(Value::as_str).unwrap_or_default().to_string();
                    job.duration_seconds = event.get("durationSeconds").and_then(Value::as_f64).unwrap_or(0.0);
                }).await,
                "failed" => update_job(&stdout_jobs, &stdout_job_id, |job| {
                    job.status = "failed".to_string();
                    job.stage = "failed".to_string();
                    job.error = event.get("error").and_then(Value::as_str).unwrap_or("本机渲染失败").to_string();
                    job.message = job.error.clone();
                    job.resume_job_id = event.get("resumeJobId").and_then(Value::as_str).unwrap_or_default().to_string();
                }).await,
                _ => {}
            }
        }
    });
    let stderr_jobs = jobs.clone();
    let stderr_job_id = job_id.clone();
    let read_stderr = tokio::spawn(async move {
        let Some(stderr) = stderr else { return String::new(); };
        let mut lines = BufReader::new(stderr).lines();
        let mut messages = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() { messages.push(line); }
        }
        let combined = messages.join("\n");
        if !combined.is_empty() {
            update_job(&stderr_jobs, &stderr_job_id, |job| {
                if job.status != "completed" && job.error.is_empty() { job.error = combined.clone(); }
            }).await;
        }
        combined
    });
    let result = child.wait().await;
    let _ = read_stdout.await;
    let stderr_text = read_stderr.await.unwrap_or_default();
    update_job(&jobs, &job_id, |job| {
        if job.status != "completed" && job.status != "failed" {
            job.status = "failed".to_string();
            job.stage = "failed".to_string();
            job.error = if !stderr_text.is_empty() {
                stderr_text
            } else {
                match result {
                    Ok(status) => format!("本机渲染器异常退出: {status}"),
                    Err(error) => format!("等待本机渲染器结束失败: {error}"),
                }
            };
            job.message = job.error.clone();
        }
    }).await;
}

#[tauri::command]
pub async fn montage_local_render_start(
    input: LocalMontageStartRequest,
    renders: State<'_, LocalMontageRenders>,
) -> Result<LocalMontageJob, String> {
    ensure_request(&input)?;
    tokio::task::spawn_blocking(crate::services::montage_media_runtime::ensure_installed)
        .await
        .map_err(|error| format!("准备智能混剪媒体运行时失败: {error}"))??;
    let profile = clean(&input.profile);
    let private_env = montage_private_env(&profile)?;
    let runner = installed_runner(&profile)?;
    let node = bundled_node()?;
    let mut job = fresh_job(profile.clone());
    {
        let jobs = renders.jobs.lock().await;
        if let Some(active) = jobs.values().find(|item| item.profile == profile && matches!(item.status.as_str(), "queued" | "running")) {
            return Err(format!("当前已有本机混剪任务 {} 正在进行，请等待完成后再开始", active.job_id));
        }
    }
    let job_id = job.job_id.clone();
    let request = json!({
        "jobId": job_id,
        "collectionId": clean(&input.collection_id),
        "voiceId": clean(&input.voice_id),
        "voiceSource": input.voice_source.as_deref().map(clean).filter(|value| !value.is_empty()).unwrap_or_else(|| "minimax".to_string()),
        "transcript": input.transcript.trim(),
        "title": input.title.as_deref().map(clean).filter(|value| !value.is_empty()),
        "captions": input.captions.unwrap_or(true),
        "resumeJobId": input.resume_job_id.as_deref().map(clean).filter(|value| !value.is_empty()),
    });
    let mut command = Command::new(node);
    command
        .arg(runner)
        .current_dir(openclaw_system_plugins::installed_system_plugin_path_for_profile(Some(&profile), PLUGIN_ID)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", openclaw_cli::augmented_path(None))
        .env("UNIOPC_OPENCLAW_PROFILE", &profile);
    for (key, value) in private_env { command.env(key, value); }
    for (key, value) in uniopc_runtime_paths::montage_media_runtime_env()? { command.env(key, value); }
    openclaw_cli::hide_console_tokio(&mut command);
    let mut child = command.spawn().map_err(|error| format!("无法启动本机混剪渲染器: {error}"))?;
    let payload = serde_json::to_vec(&request).map_err(|error| format!("无法创建本机混剪请求: {error}"))?;
    let mut stdin = child.stdin.take().ok_or_else(|| "本机混剪渲染器没有可用输入通道".to_string())?;
    stdin.write_all(&payload).await.map_err(|error| format!("无法发送本机混剪请求: {error}"))?;
    stdin.shutdown().await.map_err(|error| format!("无法完成本机混剪请求: {error}"))?;
    job.status = "running".to_string();
    job.stage = "starting".to_string();
    job.message = "正在启动本机 FFmpeg/Remotion 渲染".to_string();
    renders.jobs.lock().await.insert(job_id.clone(), job.clone());
    let jobs = renders.jobs.clone();
    tokio::spawn(async move { consume_renderer_output(jobs, job_id, child).await; });
    Ok(job)
}

#[tauri::command]
pub async fn montage_local_render_status(
    input: LocalMontageStatusRequest,
    renders: State<'_, LocalMontageRenders>,
) -> Result<LocalMontageJob, String> {
    let job = renders.jobs.lock().await.get(&clean(&input.job_id)).cloned()
        .ok_or_else(|| "未找到本机混剪任务；应用或电脑重启后请在作品页查看已完成作品".to_string())?;
    if job.profile != clean(&input.profile) {
        return Err("不能查看其他桌面 profile 的本机混剪任务".to_string());
    }
    Ok(job)
}
