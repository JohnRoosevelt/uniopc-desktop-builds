#[cfg(test)]
mod tests {
    use super::{
        append_startup_metric_at, load_startup_metrics_for_profile_at, load_startup_metrics_at,
        startup_metric, EngineStartupMetric, StartupActivity,
    };

    fn temp_metrics_path() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("uniopc-engine-startup-metrics-{}", uuid::Uuid::new_v4()))
            .join("recent.json")
    }

    #[test]
    fn legacy_startup_metrics_default_new_phase_timings_to_zero() {
        let metric: EngineStartupMetric = serde_json::from_value(serde_json::json!({
            "recordedAt": "2026-09-06", "profile": "test", "coldStart": true,
            "preflightMs": 10, "gatewaySpawnMs": 20, "gatewayReadyMs": 30,
            "totalMs": 60, "failure": null
        })).unwrap();
        assert_eq!(metric.lock_wait_ms, 0);
        assert_eq!(metric.runtime_preparation_ms, 0);
        assert_eq!(metric.singleflight_joined, 0);
        assert_eq!(metric.spawn_count, 0);
        assert!(metric.events.is_empty());
    }

    #[test]
    fn startup_metric_history_keeps_the_latest_twenty_including_failures() {
        let path = temp_metrics_path();
        for index in 0..21_u64 {
            append_startup_metric_at(
                &path,
                EngineStartupMetric {
                    recorded_at: format!("2026-09-03T09:48:{index:02}Z"),
                    profile: format!("profile-{index}"),
                    cold_start: true,
                    preflight_ms: 10,
                    lock_wait_ms: 0,
                    runtime_preparation_ms: 0,
                    gateway_spawn_ms: Some(20),
                    gateway_ready_ms: 30,
                    total_ms: 60,
                    failure: (index == 20).then(|| "RPC readiness timed out".to_string()),
                    singleflight_leaders: 1,
                    singleflight_followers: 0,
                    singleflight_joined: 0,
                    duplicate_suppressed: 0,
                    provision_count: 1,
                    spawn_count: 1,
                    events: vec!["startup_singleflight_started".to_string()],
                },
            )
            .expect("append metric");
        }

        let metrics = load_startup_metrics_at(&path).expect("load metrics");

        assert_eq!(metrics.len(), 20);
        assert_eq!(metrics.first().map(|metric| metric.profile.as_str()), Some("profile-1"));
        assert_eq!(metrics.last().map(|metric| metric.profile.as_str()), Some("profile-20"));
        assert_eq!(
            metrics.last().and_then(|metric| metric.failure.as_deref()),
            Some("RPC readiness timed out")
        );

        let _ = std::fs::remove_dir_all(path.parent().expect("metrics directory"));
    }

    #[test]
    fn startup_metric_exposes_join_suppression_provision_and_spawn_counts() {
        let metric = startup_metric(
            "profile-a".to_string(),
            true,
            1,
            2,
            3,
            Some(4),
            5,
            6,
            None,
            StartupActivity {
                singleflight_leaders: 1,
                singleflight_followers: 2,
                singleflight_joined: 2,
                duplicate_suppressed: 2,
                provision_count: 1,
                spawn_count: 1,
            },
        );

        assert_eq!(metric.singleflight_leaders, 1);
        assert_eq!(metric.singleflight_followers, 2);
        assert_eq!(metric.singleflight_joined, 2);
        assert_eq!(metric.duplicate_suppressed, 2);
        assert_eq!(metric.provision_count, 1);
        assert_eq!(metric.spawn_count, 1);
        assert!(metric
            .events
            .iter()
            .any(|event| event == "startup_singleflight_joined"));
    }

    #[test]
    fn startup_metric_history_only_returns_the_requested_profile() {
        let path = temp_metrics_path();
        for profile in ["profile-a", "profile-b", "profile-a"] {
            append_startup_metric_at(
                &path,
                EngineStartupMetric {
                    recorded_at: "2026-09-13T09:10:34Z".to_string(),
                    profile: profile.to_string(),
                    cold_start: true,
                    preflight_ms: 1,
                    lock_wait_ms: 2,
                    runtime_preparation_ms: 3,
                    gateway_spawn_ms: Some(4),
                    gateway_ready_ms: 5,
                    total_ms: 6,
                    failure: None,
                    singleflight_leaders: 1,
                    singleflight_followers: 0,
                    singleflight_joined: 0,
                    duplicate_suppressed: 0,
                    provision_count: 1,
                    spawn_count: 1,
                    events: vec![],
                },
            )
            .expect("append metric");
        }

        let metrics = load_startup_metrics_for_profile_at(&path, "profile-a")
            .expect("load profile metrics");
        assert_eq!(metrics.len(), 2);
        assert!(metrics.iter().all(|metric| metric.profile == "profile-a"));

        let _ = std::fs::remove_dir_all(path.parent().expect("metrics directory"));
    }
}
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};
use tauri::{AppHandle, Manager};

const MAX_STARTUP_METRICS: usize = 20;
const METRICS_FILE_NAME: &str = "engine-startup-metrics.json";
const STARTUP_EVENTS_FILE_NAME: &str = "engine-startup-events.jsonl";
const STARTUP_EVENTS_MAX_BYTES: u64 = 2 * 1024 * 1024;
const STARTUP_EVENTS_MAX_LINES: usize = 500;
static STARTUP_EVENTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStartupEvent {
    pub recorded_at: String,
    pub profile: String,
    pub phase: String,
    pub outcome: String,
    pub elapsed_ms: u64,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineStartupEventLog {
    pub path: String,
    pub content: String,
    pub exists: bool,
}

/// Append one low-volume startup lifecycle event. Callers must pass only
/// operational details; this log must never receive prompts or credentials.
pub(crate) fn record_startup_event(
    app: &AppHandle,
    profile: &str,
    phase: &str,
    outcome: &str,
    elapsed_ms: u64,
    detail: Option<String>,
) {
    let result = startup_events_path(app).and_then(|path| {
        let _guard = STARTUP_EVENTS_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(
            fs::metadata(&path),
            Ok(metadata) if metadata.len() >= STARTUP_EVENTS_MAX_BYTES
        ) {
            let mut previous = path.clone();
            previous.set_extension("jsonl.prev");
            let _ = fs::remove_file(&previous);
            let _ = fs::rename(&path, previous);
        }
        let parent = path
            .parent()
            .ok_or_else(|| "启动事件日志缺少父目录".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建启动事件目录失败: {error}"))?;
        let event = EngineStartupEvent {
            recorded_at: Utc::now().to_rfc3339(),
            profile: profile.to_string(),
            phase: phase.to_string(),
            outcome: outcome.to_string(),
            elapsed_ms,
            detail: detail.map(|value| value.chars().take(2_000).collect()),
        };
        let serialized = serde_json::to_vec(&event)
            .map_err(|error| format!("序列化启动事件失败: {error}"))?;
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| format!("打开启动事件日志失败: {error}"))?;
        file.write_all(&serialized)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_data())
            .map_err(|error| format!("写入启动事件日志失败: {error}"))
    });
    if let Err(error) = result {
        eprintln!("[engine-startup-events] {error}");
    }
}

pub(crate) fn load_startup_events_for_active_profile(
    app: &AppHandle,
) -> Result<EngineStartupEventLog, String> {
    let profile = crate::services::uniopc_runtime_paths::resolve_profile_key(None);
    let path = startup_events_path(app)?;
    let _guard = STARTUP_EVENTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut events = Vec::new();
    for source in [previous_events_path(&path), path.clone()] {
        if source.exists() {
            let raw = fs::read_to_string(&source)
                .map_err(|error| format!("读取启动事件日志失败: {error}"))?;
            events.extend(raw.lines().filter_map(|line| {
                serde_json::from_str::<EngineStartupEvent>(line)
                    .ok()
                    .filter(|event| event.profile == profile)
            }));
        }
    }
    let start = events.len().saturating_sub(STARTUP_EVENTS_MAX_LINES);
    let content = events[start..]
        .iter()
        .filter_map(|event| serde_json::to_string(event).ok())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(EngineStartupEventLog {
        path: path.to_string_lossy().to_string(),
        content,
        exists: path.exists() || previous_events_path(&path).exists(),
    })
}

fn startup_events_path(app: &AppHandle) -> Result<PathBuf, String> {
    metrics_path(app).map(|path| path.with_file_name(STARTUP_EVENTS_FILE_NAME))
}

fn previous_events_path(path: &Path) -> PathBuf {
    path.with_extension("jsonl.prev")
}

/// One local engine initialization attempt. This is developer-only diagnostic
/// data: it deliberately contains no prompt, token, or credential.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStartupMetric {
    pub recorded_at: String,
    pub profile: String,
    pub cold_start: bool,
    pub preflight_ms: u64,
    #[serde(default)]
    pub lock_wait_ms: u64,
    #[serde(default)]
    pub runtime_preparation_ms: u64,
    pub gateway_spawn_ms: Option<u64>,
    pub gateway_ready_ms: u64,
    pub total_ms: u64,
    pub failure: Option<String>,
    #[serde(default)]
    pub singleflight_leaders: u64,
    #[serde(default)]
    pub singleflight_followers: u64,
    #[serde(default)]
    pub singleflight_joined: u64,
    #[serde(default)]
    pub duplicate_suppressed: u64,
    #[serde(default)]
    pub provision_count: u64,
    #[serde(default)]
    pub spawn_count: u64,
    #[serde(default)]
    pub events: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct StartupActivity {
    pub singleflight_leaders: u64,
    pub singleflight_followers: u64,
    pub singleflight_joined: u64,
    pub duplicate_suppressed: u64,
    pub provision_count: u64,
    pub spawn_count: u64,
}

pub(crate) fn append_startup_metric_at(
    path: &Path,
    metric: EngineStartupMetric,
) -> Result<(), String> {
    let mut metrics = load_startup_metrics_at(path).unwrap_or_default();
    metrics.push(metric);
    let first_kept = metrics.len().saturating_sub(MAX_STARTUP_METRICS);
    metrics.drain(0..first_kept);

    let parent = path
        .parent()
        .ok_or_else(|| "初始化指标文件缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建初始化指标目录失败: {error}"))?;
    let serialized = serde_json::to_string_pretty(&metrics)
        .map_err(|error| format!("序列化初始化指标失败: {error}"))?;
    fs::write(path, format!("{serialized}\n"))
        .map_err(|error| format!("写入初始化指标失败: {error}"))
}

pub(crate) fn load_startup_metrics_at(path: &Path) -> Result<Vec<EngineStartupMetric>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|error| format!("读取初始化指标失败: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("解析初始化指标失败: {error}"))
}

pub(crate) fn load_startup_metrics_for_profile_at(
    path: &Path,
    profile: &str,
) -> Result<Vec<EngineStartupMetric>, String> {
    Ok(load_startup_metrics_at(path)?
        .into_iter()
        .filter(|metric| metric.profile == profile)
        .collect())
}

pub(crate) fn load_startup_metrics_for_active_profile(
    app: &AppHandle,
) -> Result<Vec<EngineStartupMetric>, String> {
    let profile = crate::services::uniopc_runtime_paths::resolve_profile_key(None);
    let persistent_path = metrics_path(app)?;
    if persistent_path.exists() {
        return load_startup_metrics_for_profile_at(&persistent_path, &profile);
    }
    load_startup_metrics_for_profile_at(&legacy_metrics_path(app)?, &profile)
}

fn metrics_path(_app: &AppHandle) -> Result<PathBuf, String> {
    // Keep startup history beside Uniopc's independently managed engine state,
    // so removing/reinstalling the desktop bundle does not erase failure data.
    crate::services::uniopc_runtime_paths::uniopc_data_dir()
        .map(|dir| dir.join("diagnostics").join(METRICS_FILE_NAME))
}

fn legacy_metrics_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("diagnostics").join(METRICS_FILE_NAME))
        .map_err(|error| format!("定位旧版初始化指标目录失败: {error}"))
}

/// Best-effort persistence must never delay or fail an engine startup.
pub(crate) fn record_startup_metric(app: &AppHandle, metric: EngineStartupMetric) {
    let result = metrics_path(app).and_then(|path| {
        if !path.exists() {
            if let Ok(legacy_path) = legacy_metrics_path(app) {
                if let Ok(legacy_metrics) = load_startup_metrics_at(&legacy_path) {
                    if !legacy_metrics.is_empty() {
                        let parent = path
                            .parent()
                            .ok_or_else(|| "初始化指标文件缺少父目录".to_string())?;
                        fs::create_dir_all(parent)
                            .map_err(|error| format!("创建初始化指标目录失败: {error}"))?;
                        let serialized = serde_json::to_string_pretty(&legacy_metrics)
                            .map_err(|error| format!("迁移初始化指标失败: {error}"))?;
                        fs::write(&path, format!("{serialized}\n"))
                            .map_err(|error| format!("保存迁移后的初始化指标失败: {error}"))?;
                    }
                }
            }
        }
        append_startup_metric_at(&path, metric)
    });
    if let Err(error) = result {
        eprintln!("[engine-startup-metrics] {error}");
    }
}

pub(crate) fn startup_metric(
    profile: String,
    cold_start: bool,
    preflight_ms: u64,
    lock_wait_ms: u64,
    runtime_preparation_ms: u64,
    gateway_spawn_ms: Option<u64>,
    gateway_ready_ms: u64,
    total_ms: u64,
    failure: Option<String>,
    activity: StartupActivity,
) -> EngineStartupMetric {
    let mut events = vec!["startup_singleflight_started".to_string()];
    if activity.singleflight_joined > 0 {
        events.push("startup_singleflight_joined".to_string());
    }
    EngineStartupMetric {
        recorded_at: Utc::now().to_rfc3339(),
        profile,
        cold_start,
        preflight_ms,
        lock_wait_ms,
        runtime_preparation_ms,
        gateway_spawn_ms,
        gateway_ready_ms,
        total_ms,
        failure,
        singleflight_leaders: activity.singleflight_leaders,
        singleflight_followers: activity.singleflight_followers,
        singleflight_joined: activity.singleflight_joined,
        duplicate_suppressed: activity.duplicate_suppressed,
        provision_count: activity.provision_count,
        spawn_count: activity.spawn_count,
        events,
    }
}
