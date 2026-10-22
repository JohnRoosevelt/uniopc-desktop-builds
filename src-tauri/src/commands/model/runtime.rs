//! Uniopc 引擎 runtime command boundary.
//!
//! Runtime ownership includes install/update/uninstall, Gateway lifecycle,
//! version checks, process execution, and startup health verification.

use super::{
    build_openclaw_observed_status, emit_openclaw_progress, gateway_log_path, GatewayLogTail,
    OpenClawInstallResult, OpenClawSetupProgress, OpenClawStatus,
};
use crate::services::uniopc_runtime_paths;
use std::fs;
use tauri::AppHandle;

pub(super) fn tail_gateway_log_text(text: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

pub(super) fn read_gateway_log_tail_impl(
    profile: Option<String>,
    max_lines: usize,
) -> Result<GatewayLogTail, String> {
    let profile = profile
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(uniopc_runtime_paths::read_active_profile_key);
    let path = gateway_log_path(profile.as_deref())?;
    let path_str = path.to_string_lossy().to_string();
    if !path.exists() {
        return Ok(GatewayLogTail {
            path: path_str,
            content: String::new(),
            exists: false,
        });
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 Uniopc 引擎 日志失败: {e}"))?;
    Ok(GatewayLogTail {
        path: path_str,
        content: crate::services::white_label::sanitize_runtime_text(&tail_gateway_log_text(&text, max_lines)),
        exists: true,
    })
}

async fn openclaw_status_impl(app: AppHandle) -> Result<OpenClawStatus, String> {
    Ok(build_openclaw_observed_status(&app).await)
}

async fn openclaw_check_update_impl(app: AppHandle) -> Result<OpenClawStatus, String> {
    emit_openclaw_progress(
        &app,
        OpenClawSetupProgress {
            phase: "checking_update".to_string(),
            status: "正在检测 Uniopc 引擎 兼容版本".to_string(),
            detail: Some("Uniopc 会比较当前 Uniopc 引擎 与本版本声明的兼容版本。".to_string()),
            output_tail: None,
            percent: Some(20.0),
        },
    )?;

    let status = implementation::build_openclaw_update_status(&app).await;
    emit_openclaw_progress(
        &app,
        OpenClawSetupProgress {
            phase: if status.update_available == Some(true) {
                "update_available".to_string()
            } else {
                "success".to_string()
            },
            status: status
                .update_message
                .clone()
                .unwrap_or_else(|| "检测完成".to_string()),
            detail: status.latest_version.clone(),
            output_tail: None,
            percent: Some(100.0),
        },
    )?;
    Ok(status)
}

pub(super) mod implementation {
    use super::super::*;

    pub(super) async fn build_openclaw_update_status(app: &AppHandle) -> OpenClawStatus {
        let mut status = build_openclaw_status(app).await;
        if !status.supported {
            status.update_message =
                Some("当前系统暂不支持自动安装 Uniopc 引擎 兼容版本。".to_string());
            return status;
        }
        if !status.installed {
            status.update_message = Some("请先安装 Uniopc 引擎，再检测兼容版本。".to_string());
            return status;
        }

        let target = imai_openclaw_install_version();
        let current = status.version.as_deref().and_then(extract_version_number);
        let compatibility = current.as_deref().is_some_and(is_exact_engine_version);
        status.latest_version = Some(target.clone());
        status.update_available = Some(!compatibility);
        status.update_message = Some(match current.as_deref() {
            Some(current) if compatibility => {
                format!("Uniopc 引擎 {current} 已符合精确引擎版本 {target}。")
            }
            Some(current) => {
                format!("Uniopc 引擎 {current} 与精确引擎版本 {target} 不匹配，请安装该版本。")
            }
            None => format!("精确引擎版本为 {target}，但无法读取当前 Uniopc 引擎版本。"),
        });

        status
    }

    // True when we ship a pinned bundled runtime for this machine that is not yet
    // the active one. A pre-existing *system* `openclaw` (e.g. an old Homebrew
    // install) must not let the app declare itself "installed & done" while our
    // bundled runtime sits unextracted — that is exactly how a stale global binary
    // shadows the version we ship. Accio never consults a system binary at all;
    // this is the minimal equivalent guard for our install gate.
    fn bundled_runtime_pending_activation(app: &AppHandle) -> bool {
        let required = imai_openclaw_install_version();
        if required == "latest" {
            // No version compiled in (dev build) — nothing bundled to prefer.
            return false;
        }
        if openclaw_bundled_runtime::active_runtime_matches(&required) {
            return false; // already the active runtime — nothing pending
        }
        // Only "pending" when a usable bundle actually ships for this platform/arch.
        openclaw_bundled_runtime::bundled_runtime_archive(app).is_ok()
    }

    async fn ensure_openclaw_gateway_started(app: &AppHandle) -> Result<String, String> {
        let profile = uniopc_runtime_paths::read_active_profile_key()
            .ok_or_else(|| "尚未选择 Uniopc 引擎 profile，无法启动 Gateway。".to_string())?;
        let snapshot =
            crate::commands::openclaw_connection::openclaw_connection_start_local_for_runtime(
                app.clone(),
                crate::commands::openclaw_connection::GatewayConnectionProfileInput {
                    profile: Some(profile),
                    gateway_port: None,
                    cloud_agent_api_url: None,
                    cloud_agent_auth_token: None,
                    cloud_agent_token_expires_at: None,
                    cloud_agent_id: None,
                },
            )
            .await?;
        if snapshot.status
            != crate::services::openclaw_connection::GatewayConnectionStatus::Connected
        {
            return Err(snapshot
                .last_error
                .unwrap_or_else(|| snapshot.message.clone()));
        }
        emit_openclaw_progress(
            app,
            OpenClawSetupProgress {
                phase: "success".to_string(),
                status: "Uniopc 引擎 已启动".to_string(),
                detail: snapshot.endpoint_url,
                output_tail: None,
                percent: Some(100.0),
            },
        )?;
        Ok(String::new())
    }

    async fn shell_output_streaming(
        app: &AppHandle,
        command: &str,
        status: &str,
        detail: &str,
        percent: Option<f64>,
    ) -> Result<String, String> {
        let (program, args) = shell_program_and_args(command);
        command_output_streaming(app, &program, &args, status, detail, percent).await
    }

    /// Install (or upgrade to) the bundled Uniopc 引擎 runtime before touching the
    /// network. Returns `Ok(Some(..))` when the bundle satisfied the request and
    /// `Ok(None)` when the caller should fall back to the official installer
    /// (dev build without a bundle, arch mismatch, or extraction failure).
    async fn try_install_bundled_openclaw_runtime(
        app: &AppHandle,
    ) -> Result<Option<OpenClawInstallResult>, String> {
        let required = imai_openclaw_install_version();
        if required == "latest" {
            // No pinned version compiled in (dev fallback): keep the network path.
            return Ok(None);
        }

        emit_openclaw_progress(
            app,
            OpenClawSetupProgress {
                phase: "starting".to_string(),
                status: "正在初始化 Uniopc 引擎 运行环境".to_string(),
                detail: Some("从安装包内置运行时安装，无需联网。".to_string()),
                output_tail: None,
                percent: Some(15.0),
            },
        )?;

        let app_for_task = app.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            openclaw_bundled_runtime::ensure_bundled_runtime_installed(&app_for_task)
        })
        .await
        .map_err(|e| format!("内置运行时安装任务失败: {e}"))?;

        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                // A broken bundle must not brick first launch: log and fall back
                // to the network installer.
                eprintln!("[bundled-runtime] 解压失败，回退官方安装器: {error}");
                return Ok(None);
            }
        };

        let installed_label = match outcome {
            openclaw_bundled_runtime::BundledRuntimeOutcome::Unavailable { reason } => {
                eprintln!("[bundled-runtime] 不可用，回退官方安装器: {reason}");
                return Ok(None);
            }
            openclaw_bundled_runtime::BundledRuntimeOutcome::AlreadyExtracted { version } => {
                format!("内置引擎 {version} 已就绪")
            }
            openclaw_bundled_runtime::BundledRuntimeOutcome::Extracted { version } => {
                format!("内置引擎 {version} 安装完成")
            }
        };

        emit_openclaw_progress(
            app,
            OpenClawSetupProgress {
                phase: "verifying".to_string(),
                status: "运行环境就绪，正在检测 Uniopc 引擎".to_string(),
                detail: Some(installed_label.clone()),
                output_tail: None,
                percent: Some(80.0),
            },
        )?;

        let next_status = build_openclaw_status(app).await;
        if !next_status.installed {
            // The bundle extracted but status still can't see the CLI — surface
            // the network path instead of failing hard.
            eprintln!("[bundled-runtime] 解压完成但状态检测未通过，回退官方安装器");
            return Ok(None);
        }

        emit_openclaw_progress(
            app,
            OpenClawSetupProgress {
                phase: "success".to_string(),
                status: "Uniopc 引擎 已安装".to_string(),
                detail: Some(installed_label),
                output_tail: None,
                percent: Some(100.0),
            },
        )?;

        Ok(Some(OpenClawInstallResult {
            status: next_status,
            output_tail: None,
        }))
    }

    #[cfg(target_os = "windows")]
    async fn try_provision_windows_runtime(
        app: &AppHandle,
    ) -> Result<Option<OpenClawInstallResult>, String> {
        let requested = imai_openclaw_install_version();

        emit_openclaw_progress(
            app,
            OpenClawSetupProgress {
                phase: "running".to_string(),
                status: "正在准备 Windows 引擎运行时".to_string(),
                detail: Some(
                    "首次会下载 Node.js 运行时并把 Uniopc 引擎安装到私有目录，耗时取决于网络。"
                        .to_string(),
                ),
                output_tail: None,
                percent: Some(10.0),
            },
        )?;

        let app_progress = app.clone();
        let requested_for_task = requested.clone();
        let provisioned = tokio::task::spawn_blocking(move || {
            crate::services::openclaw_windows_runtime::provision(
                &requested_for_task,
                |message, percent| {
                    let _ = app_progress.emit(
                        "openclaw-setup-progress",
                        OpenClawSetupProgress {
                            phase: "running".to_string(),
                            status: format!("正在准备 Windows 引擎运行时 · {message}"),
                            detail: None,
                            output_tail: None,
                            percent: Some(percent),
                        },
                    );
                },
            )
        })
        .await
        .map_err(|e| format!("Windows 引擎运行时供给任务失败: {e}"))?;

        let installed_version = match provisioned {
            Ok(version) => version,
            Err(error) => {
                emit_openclaw_progress(
                    app,
                    OpenClawSetupProgress {
                        phase: "failed".to_string(),
                        status: "Windows 引擎运行时准备失败".to_string(),
                        detail: Some(error.clone()),
                        output_tail: None,
                        percent: Some(100.0),
                    },
                )?;
                return Err(error);
            }
        };

        let next_status = build_openclaw_status(app).await;
        emit_openclaw_progress(
            app,
            OpenClawSetupProgress {
                phase: "success".to_string(),
                status: "Windows 引擎运行时已就绪".to_string(),
                detail: Some(installed_version),
                output_tail: None,
                percent: Some(100.0),
            },
        )?;
        Ok(Some(OpenClawInstallResult {
            status: next_status,
            output_tail: None,
        }))
    }

    pub(super) async fn openclaw_install_impl(
        app: AppHandle,
    ) -> Result<OpenClawInstallResult, String> {
        let status = build_openclaw_status(&app).await;
        if !status.supported {
            return Err(status.message);
        }

        // A pre-existing system `openclaw` reports `installed = true`, but if our
        // bundled runtime is not yet active we must still extract+activate it so
        // the version we ship wins — otherwise a stale global binary permanently
        // shadows it (the root cause of machines stuck on an old engine).
        if status.installed && !bundled_runtime_pending_activation(&app) {
            let next_status = build_openclaw_status(&app).await;
            emit_openclaw_progress(
                &app,
                OpenClawSetupProgress {
                    phase: "success".to_string(),
                    status: "Uniopc 引擎 已安装".to_string(),
                    detail: next_status
                        .version
                        .clone()
                        .or(next_status.binary_path.clone()),
                    output_tail: None,
                    percent: Some(100.0),
                },
            )?;

            return Ok(OpenClawInstallResult {
                status: next_status,
                output_tail: None,
            });
        }

        // Bundled runtime first: offline extraction in seconds. Only when no
        // usable bundle exists (dev build, arch mismatch) do we fall back to the
        // official network installer below.
        if let Some(result) = try_install_bundled_openclaw_runtime(&app).await? {
            return Ok(result);
        }

        // Windows has no prefix-relocatable installer and the pure sidecar refuses a
        // system openclaw, so provision an app-owned runtime (portable Node + npm
        // engine) into the private dir the sidecar spawns from.
        #[cfg(target_os = "windows")]
        {
            if let Some(result) = try_provision_windows_runtime(&app).await? {
                return Ok(result);
            }
        }

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "starting".to_string(),
                status: "准备执行 Uniopc 引擎 官方安装脚本".to_string(),
                detail: Some(status.install_command.clone()),
                output_tail: None,
                percent: Some(10.0),
            },
        )?;

        let install_command = if cfg!(target_os = "windows") {
            OPENCLAW_WINDOWS_INSTALL_COMMAND.to_string()
        } else {
            openclaw_install_command()
        };

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "running".to_string(),
                status: "正在安装 Uniopc 引擎".to_string(),
                detail: Some(
                    "首次安装会下载 Uniopc 引擎 CLI 和官方托管运行时；不依赖本机 npm 或 Homebrew。耗时取决于网络。".to_string(),
                ),
                output_tail: None,
                percent: Some(35.0),
            },
        )?;

        let install_detail =
            "首次安装会下载 Uniopc 引擎 CLI 和官方托管运行时；不依赖本机 npm 或 Homebrew。耗时取决于网络。";
        let output = match shell_output_streaming(
            &app,
            &install_command,
            "正在安装 Uniopc 引擎",
            install_detail,
            Some(35.0),
        )
        .await
        {
            Ok(output) => output,
            Err(error_tail) => {
                let detail = openclaw_install_failure_detail(&error_tail);
                emit_openclaw_progress(
                    &app,
                    OpenClawSetupProgress {
                        phase: "failed".to_string(),
                        status: "Uniopc 引擎 安装失败".to_string(),
                        detail: Some(detail.clone()),
                        output_tail: Some(error_tail.clone()),
                        percent: None,
                    },
                )?;
                return Err(format!("Uniopc 引擎 安装失败: {detail}\n{error_tail}"));
            }
        };

        // The network installer populated runtime/v<version>; make it active.
        if let Err(error) =
            openclaw_bundled_runtime::activate_runtime_version(&imai_openclaw_install_version())
        {
            eprintln!("[runtime] 激活网络安装的运行时失败: {error}");
        }

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "verifying".to_string(),
                status: "安装完成，正在检测 Uniopc 引擎".to_string(),
                detail: None,
                output_tail: Some(tail_lines(&output, 20)),
                percent: Some(80.0),
            },
        )?;

        let output_log = output;
        let next_status = build_openclaw_status(&app).await;
        let output_tail = Some(tail_lines(&output_log, 20));
        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: if next_status.installed {
                    "success".to_string()
                } else {
                    "warning".to_string()
                },
                status: if next_status.installed {
                    "Uniopc 引擎 已安装".to_string()
                } else {
                    "安装脚本已完成，但当前会话还未检测到 Uniopc 引擎".to_string()
                },
                detail: next_status
                    .version
                    .clone()
                    .or(next_status.binary_path.clone())
                    .or_else(|| Some("可能需要重启 Uniopc 或重新打开终端环境。".to_string())),
                output_tail: output_tail.clone(),
                percent: if next_status.installed {
                    Some(100.0)
                } else {
                    Some(90.0)
                },
            },
        )?;

        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail,
        })
    }

    pub(super) async fn openclaw_start_gateway_impl(
        app: AppHandle,
    ) -> Result<OpenClawInstallResult, String> {
        let output = ensure_openclaw_gateway_started(&app).await?;
        let next_status = build_openclaw_status(&app).await;

        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail: Some(tail_lines(&output, 20)),
        })
    }

    pub(super) async fn openclaw_stop_gateway_impl(
        app: AppHandle,
    ) -> Result<OpenClawInstallResult, String> {
        let _shutdown_guard =
            crate::commands::openclaw_connection::local_gateway_shutdown_guard(&app).await;
        let status = build_openclaw_status(&app).await;
        if !status.supported {
            return Err(status.message);
        }
        if !status.installed {
            return Err("请先安装 Uniopc 引擎，再关闭 Gateway。".to_string());
        }
        if !status.gateway_running {
            emit_openclaw_progress(
                &app,
                OpenClawSetupProgress {
                    phase: "success".to_string(),
                    status: "Uniopc 引擎 已是关闭状态".to_string(),
                    detail: Some(OPENCLAW_DASHBOARD_URL.to_string()),
                    output_tail: None,
                    percent: Some(100.0),
                },
            )?;
            return Ok(OpenClawInstallResult {
                status,
                output_tail: None,
            });
        }

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "stopping_gateway".to_string(),
                status: "正在关闭 Uniopc 引擎".to_string(),
                detail: Some("关闭后 Dashboard 将不可访问。".to_string()),
                output_tail: None,
                percent: Some(35.0),
            },
        )?;

        // Pure sidecar: the gateway is our app-owned child — kill it directly.
        {
            use tauri::Manager;
            app.state::<GatewaySupervisor>().stop().await;
        }
        let output = String::new();

        let stopped = !openclaw_gateway_status(&app).await.running;
        let next_status = build_openclaw_status(&app).await;
        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: if stopped { "success" } else { "warning" }.to_string(),
                status: if stopped {
                    "Uniopc 引擎 已关闭".to_string()
                } else {
                    "已发送关闭命令，正在等待服务退出".to_string()
                },
                detail: Some(OPENCLAW_DASHBOARD_URL.to_string()),
                output_tail: Some(tail_lines(&output, 20)),
                percent: Some(100.0),
            },
        )?;

        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail: Some(tail_lines(&output, 20)),
        })
    }

    /// Reset (wipe) one account's local engine data — the Accio "delete the account
    /// folder" gesture. Removes `state/<key>` entirely. If `profile` is omitted the
    /// active account is used. When the wiped account is the one currently running,
    /// its gateway child is stopped and the active-account marker cleared first so
    /// we never delete files out from under a live engine. Other accounts and the
    /// machine-level device identity are untouched. Returns the sanitized key wiped.
    pub(crate) async fn openclaw_reset_profile_data_impl(
        app: AppHandle,
        profile: Option<String>,
    ) -> Result<String, String> {
        use tauri::Manager;
        let _shutdown_guard =
            crate::commands::openclaw_connection::local_gateway_shutdown_guard(&app).await;
        let key = uniopc_runtime_paths::resolve_profile_key(profile.as_deref());
        let state_dir = uniopc_runtime_paths::state_v8_base_dir()?.join(&key);

        let active = uniopc_runtime_paths::read_active_profile_key()
            .map(|value| uniopc_runtime_paths::sanitize_profile_key(&value));
        if active.as_deref() == Some(key.as_str()) {
            app.state::<GatewaySupervisor>().stop().await;
            // Tear down the stream actor too, or it keeps resubscribing this account's
            // session against whatever engine comes up next (endpoint signature is
            // identical across local accounts).
            app.state::<crate::services::openclaw_gateway_stream::GatewayStreamManager>()
                .shutdown()
                .await;
            uniopc_runtime_paths::clear_active_profile_key()?;
        }

        if state_dir.exists() {
            std::fs::remove_dir_all(&state_dir)
                .map_err(|e| format!("删除账号 {key} 本地数据失败: {e}"))?;
        }
        Ok(key)
    }

    /// Log out of the active account: stop its running engine and forget the active
    /// marker (subsequent profile-less paths fall back to `state/default`). The
    /// account's data is left on disk — wiping is the separate, explicit
    /// `openclaw_reset_profile_data`.
    pub(crate) async fn openclaw_logout_active_profile_impl(app: AppHandle) -> Result<(), String> {
        use tauri::Manager;
        let _lifecycle_guard =
            crate::commands::openclaw_connection::local_gateway_shutdown_guard(&app).await;
        app.state::<GatewaySupervisor>().stop().await;
        app.state::<crate::services::openclaw_gateway_stream::GatewayStreamManager>()
            .shutdown()
            .await;
        uniopc_runtime_paths::clear_active_profile_key()
    }

    pub(crate) async fn openclaw_stop_gateway_for_profile(
        app: &AppHandle,
        profile: &str,
    ) -> Result<String, String> {
        let _profile = validate_openclaw_profile_handle(profile)?;
        let _shutdown_guard =
            crate::commands::openclaw_connection::local_gateway_shutdown_guard(app).await;
        stop_gateway_for_profile_under_shutdown_guard(app).await?;
        Ok(String::new())
    }

    pub(in crate::commands::model) async fn stop_gateway_for_profile_under_shutdown_guard(
        app: &AppHandle,
    ) -> Result<(), String> {
        // Pure sidecar: a single app-owned gateway child backs every profile — kill
        // it directly rather than driving a per-profile service.
        {
            use tauri::Manager;
            app.state::<GatewaySupervisor>().stop().await;
            app.state::<crate::services::openclaw_gateway_stream::GatewayStreamManager>()
                .shutdown()
                .await;
        }
        if openclaw_gateway_status(app).await.running {
            return Err("Uniopc 引擎 gateway 未能停止".to_string());
        }
        Ok(())
    }

    pub(super) async fn openclaw_update_impl(
        app: AppHandle,
    ) -> Result<OpenClawInstallResult, String> {
        let status = build_openclaw_status(&app).await;
        if !status.supported {
            return Err(status.message);
        }
        // On Windows, update also acts as a repair action. A stale or missing
        // app-private runtime is intentionally reported as not installed, but the
        // Windows provisioning path below can recreate that runtime without first
        // invoking the system-wide official installer.
        if !status.installed && !cfg!(target_os = "windows") {
            return Err("请先安装 Uniopc 引擎，再执行更新。".to_string());
        }

        // Bundled runtime first: upgrading to the pinned compatible version is an
        // offline extraction when the bundle carries it.
        if let Some(result) = try_install_bundled_openclaw_runtime(&app).await? {
            return Ok(result);
        }

        // The official Windows installer does not populate Uniopc's private,
        // versioned runtime directory. Reuse the same portable Node + npm path as
        // first install so an incompatible embedded bundle can be repaired in
        // place instead of leaving status pinned to the old version.
        #[cfg(target_os = "windows")]
        {
            if let Some(result) = try_provision_windows_runtime(&app).await? {
                return Ok(result);
            }
        }

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "updating".to_string(),
                status: "正在安装 Uniopc 兼容 Uniopc 引擎".to_string(),
                detail: Some(status.update_command.clone()),
                output_tail: None,
                percent: Some(35.0),
            },
        )?;

        let update_command = if cfg!(target_os = "windows") {
            OPENCLAW_WINDOWS_INSTALL_COMMAND.to_string()
        } else {
            openclaw_update_command()
        };
        let update_detail =
            "将重新运行 Uniopc 引擎 官方安装器，安装 Uniopc 已验证的 CLI/Gateway 兼容版本。";
        let output = match shell_output_streaming(
            &app,
            &update_command,
            "正在安装 Uniopc 兼容 Uniopc 引擎",
            update_detail,
            Some(35.0),
        )
        .await
        {
            Ok(output) => output,
            Err(error_tail) => {
                emit_openclaw_progress(
                    &app,
                    OpenClawSetupProgress {
                        phase: "failed".to_string(),
                        status: "Uniopc 引擎 兼容版本安装失败".to_string(),
                        detail: Some("请检查网络连接，或稍后重试。".to_string()),
                        output_tail: Some(error_tail.clone()),
                        percent: None,
                    },
                )?;
                return Err(format!("Uniopc 引擎 兼容版本安装失败: {error_tail}"));
            }
        };

        // The network installer populated runtime/v<version>; make it active.
        if let Err(error) =
            openclaw_bundled_runtime::activate_runtime_version(&imai_openclaw_install_version())
        {
            eprintln!("[runtime] 激活网络安装的运行时失败: {error}");
        }

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "verifying".to_string(),
                status: "安装完成，正在重新检测版本".to_string(),
                detail: None,
                output_tail: Some(tail_lines(&output, 20)),
                percent: Some(80.0),
            },
        )?;

        let next_status = build_openclaw_update_status(&app).await;
        let output_tail = Some(tail_lines(&output, 20));
        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "success".to_string(),
                status: next_status
                    .update_message
                    .clone()
                    .unwrap_or_else(|| "Uniopc 引擎 兼容版本安装完成".to_string()),
                detail: next_status.version.clone(),
                output_tail: output_tail.clone(),
                percent: Some(100.0),
            },
        )?;

        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail,
        })
    }

    pub(super) async fn openclaw_uninstall_impl(
        app: AppHandle,
    ) -> Result<OpenClawInstallResult, String> {
        let _shutdown_guard =
            crate::commands::openclaw_connection::local_gateway_shutdown_guard(&app).await;
        let status = build_openclaw_status(&app).await;
        if !status.supported {
            return Err(status.message);
        }
        if !status.installed {
            return Err("请先安装 Uniopc 引擎，再执行卸载。".to_string());
        }

        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: "uninstalling".to_string(),
                status: "正在卸载 Uniopc 引擎".to_string(),
                detail: Some(status.uninstall_command.clone()),
                output_tail: None,
                percent: Some(35.0),
            },
        )?;

        let output = command_output(
            &app,
            "openclaw",
            &[
                "uninstall".to_string(),
                "--service".to_string(),
                "--state".to_string(),
                "--workspace".to_string(),
                "--yes".to_string(),
                "--non-interactive".to_string(),
            ],
        )
        .await
        .map_err(|e| format!("Uniopc 引擎 卸载失败: {e}"))?;

        let next_status = build_openclaw_status(&app).await;
        let output_tail = Some(tail_lines(&output, 20));
        emit_openclaw_progress(
            &app,
            OpenClawSetupProgress {
                phase: if next_status.installed {
                    "warning".to_string()
                } else {
                    "success".to_string()
                },
                status: if next_status.installed {
                    "Uniopc 引擎 卸载命令已执行，但当前仍检测到安装。".to_string()
                } else {
                    "Uniopc 引擎 已卸载".to_string()
                },
                detail: next_status.binary_path.clone(),
                output_tail: output_tail.clone(),
                percent: Some(100.0),
            },
        )?;

        Ok(OpenClawInstallResult {
            status: next_status,
            output_tail,
        })
    }
}
/// Tail of the active (or given) profile's gateway log for the diagnostics page.
#[tauri::command]
pub async fn openclaw_gateway_log_tail(profile: Option<String>) -> Result<GatewayLogTail, String> {
    read_gateway_log_tail_impl(profile, 400)
}

#[tauri::command]
pub async fn openclaw_startup_metrics(
    app: AppHandle,
) -> Result<Vec<crate::services::engine_startup_metrics::EngineStartupMetric>, String> {
    crate::services::engine_startup_metrics::load_startup_metrics_for_active_profile(&app)
}

#[tauri::command]
pub async fn openclaw_startup_events(
    app: AppHandle,
) -> Result<crate::services::engine_startup_metrics::EngineStartupEventLog, String> {
    crate::services::engine_startup_metrics::load_startup_events_for_active_profile(&app)
}

#[tauri::command]
pub async fn openclaw_status(app: AppHandle) -> Result<OpenClawStatus, String> {
    openclaw_status_impl(app).await
}

#[tauri::command]
pub async fn openclaw_check_update(app: AppHandle) -> Result<OpenClawStatus, String> {
    openclaw_check_update_impl(app).await
}

#[tauri::command]
pub async fn openclaw_install(app: AppHandle) -> Result<OpenClawInstallResult, String> {
    implementation::openclaw_install_impl(app).await
}

#[tauri::command]
pub async fn openclaw_start_gateway(app: AppHandle) -> Result<OpenClawInstallResult, String> {
    implementation::openclaw_start_gateway_impl(app).await
}

#[tauri::command]
pub async fn openclaw_stop_gateway(app: AppHandle) -> Result<OpenClawInstallResult, String> {
    implementation::openclaw_stop_gateway_impl(app).await
}

#[tauri::command]
pub async fn openclaw_update(app: AppHandle) -> Result<OpenClawInstallResult, String> {
    implementation::openclaw_update_impl(app).await
}

#[tauri::command]
pub async fn openclaw_uninstall(app: AppHandle) -> Result<OpenClawInstallResult, String> {
    implementation::openclaw_uninstall_impl(app).await
}

#[cfg(test)]
mod tests {
    use super::tail_gateway_log_text;

    #[test]
    fn runtime_boundary_owns_gateway_log_tailing() {
        assert_eq!(
            tail_gateway_log_text("first\nsecond\nthird\n", 2),
            "second\nthird"
        );
    }
}
