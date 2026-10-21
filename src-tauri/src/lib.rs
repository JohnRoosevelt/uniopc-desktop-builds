pub mod commands;
pub mod services;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// Ambient proxy env vars a launching shell may export (upper + lower case).
const AMBIENT_PROXY_ENV_VARS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

/// Connect directly by default — never inherit an ambient proxy.
///
/// Every in-process HTTP channel (Supabase via plugin-http, the updater, cloud
/// host checks) targets China-direct backends and needs no proxy. But reqwest
/// auto-reads `HTTP(S)_PROXY`/`ALL_PROXY` from the launching shell, which
/// silently forces all traffic through a local proxy port and breaks the app
/// whenever that proxy/VPN is off (e.g. `tauri dev` from a terminal that
/// exports `HTTPS_PROXY=127.0.0.1:7890`). A GUI-launched release build never
/// sees those vars, which is why it works without a VPN; strip them here so
/// dev, release, and every child process behave identically — direct.
///
/// Users who genuinely need a proxy set a system-level (TUN/transparent) proxy,
/// which the OS network stack honors regardless of these env vars.
fn disable_ambient_proxy_env() {
    for key in AMBIENT_PROXY_ENV_VARS {
        std::env::remove_var(key);
    }
}

pub fn run() {
    // Preserve the trusted control-plane routes, then clear ambient proxy
    // variables before any other reqwest client or Tauri plugin is built.
    commands::trusted_network::capture_process_proxy_routes();
    disable_ambient_proxy_env();
    run_admin_host_app();
}

fn base_builder(ensure_system_plugins: bool) -> tauri::Builder<tauri::Wry> {
    // single-instance MUST be the first registered plugin. A second app instance
    // would otherwise compete for the same singleton gateway and profile
    // state (same fixed port, same profile pid file). The
    // second launch now just focuses the existing window and exits.
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init());

    let stable_window_state_flags = tauri_plugin_window_state::StateFlags::POSITION
        | tauri_plugin_window_state::StateFlags::MAXIMIZED
        | tauri_plugin_window_state::StateFlags::VISIBLE;

    builder = builder
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(stable_window_state_flags)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );
    }

    builder.setup(move |app| {
        app.manage(services::openclaw_connection::GatewayTunnelSupervisor::default());
        app.manage(services::openclaw_gateway_stream::GatewayStreamManager::default());
        app.manage(services::local_documents_bridge::managed_state());
        app.manage(services::native_browser::NativeBrowserState::default());
        app.manage(services::openclaw_browser::BrowserDockStreams::default());
        app.manage(commands::montage_local::LocalMontageRenders::default());
        app.manage(commands::plugin_lifecycle::PluginLifecycleStaging::default());
        app.manage(services::startup_coordinator::GatewayStartupCoordinator::default());
        // Pure sidecar: the local gateway is an app-owned child process managed
        // by this supervisor (spawned on connect, killed on Cmd+Q). No system
        // service is ever installed.
        app.manage(commands::model::GatewaySupervisor::default());
        let _ = ensure_system_plugins;

        // Closing the window only hides Uniopc.  This keeps the local Gateway
        // warm and makes the explicit tray "退出" action the sole normal way
        // to terminate the desktop process.
        if let Some(window) = app.get_webview_window("main") {
            let close_window = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    // A hidden macOS full-screen window otherwise leaves an
                    // empty full-screen Space behind. Leave full screen before
                    // hiding, including when the red traffic-light is used.
                    #[cfg(target_os = "macos")]
                    if close_window.is_fullscreen().unwrap_or(false) {
                        let _ = close_window.set_fullscreen(false);
                    }
                    let _ = close_window.hide();
                }
            });
        }

        let show_item = MenuItem::with_id(app, "show", "显示 Uniopc", true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, "quit", "退出 Uniopc", true, None::<&str>)?;
        let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
        let tray_icon = app.default_window_icon().cloned()
            .ok_or_else(|| "Uniopc 缺少应用图标，无法创建托盘图标。")?;
        TrayIconBuilder::with_id("uniopc-tray")
            .menu(&tray_menu)
            .icon(tray_icon)
            .tooltip("Uniopc 正在后台运行")
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                "show" => show_main_window(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                    show_main_window(&tray.app_handle());
                }
            })
            .build(app)?;

        let local_documents_bridge_app = app.handle().clone();
        if let Err(error) = tauri::async_runtime::block_on(
            services::local_documents_bridge::start(local_documents_bridge_app),
        ) {
            eprintln!("[local-documents-bridge] failed to start: {error}");
        }

        // Start the in-process loopback reverse-proxy for the official model
        // token. It reuses the last local port/secret when available (falling
        // back to an ephemeral port) and injects the in-memory upstream bearer
        // per request, so the rotating real token never touches config/disk.
        // Bind before React can warm the gateway. The former spawned task could
        // race an existing gateway config that still pointed to its previous
        // loopback port, yielding ECONNREFUSED that OpenClaw reported as an
        // authentication failure. Binding a local TCP listener is quick and
        // does not wait for the network or the model upstream.
        if let Err(error) = tauri::async_runtime::block_on(
            services::official_model_proxy::start(app.handle().clone()),
        ) {
            eprintln!("[official-model-proxy] failed to start: {error}");
        }

        // Bundled runtime is the single source of truth: activate it on every
        // launch, unconditionally, so a pre-existing global `openclaw` on the
        // machine can never shadow the version we ship. Idempotent (a matching
        // `runtime/current` short-circuits) and backgrounded so it never blocks
        // window creation — Accio-style "bundled always wins" rather than our
        // old "any system openclaw counts as installed" behavior.
        let bundled_app = app.handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            match services::openclaw_bundled_runtime::ensure_bundled_runtime_installed(&bundled_app)
            {
                Ok(outcome) => {
                    eprintln!("[bundled-runtime] startup activation: {outcome:?}");
                }
                Err(error) => {
                    eprintln!("[bundled-runtime] startup activation failed: {error}");
                }
            }

            // Orphan recovery belongs to GatewaySupervisor immediately before
            // spawn. A background sweep here can kill a newly started child.
        });

        // Gateway warm-up starts from React as soon as login resolves the
        // current profile. Do not pre-start the last account here: first-time
        // plugin preparation can take minutes and would block the signed-in
        // account behind the singleton Gateway startup lock.

        Ok(())
    })
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn run_tauri(builder: tauri::Builder<tauri::Wry>, error_message: &str) {
    let app = builder
        .build(tauri::generate_context!())
        .expect(error_message);
    app.run(|app_handle, event| {
        match event {
            // Pure sidecar: kill the local gateway child when the app actually
            // quits (Cmd+Q → RunEvent::Exit). Closing the last window on macOS
            // does NOT emit Exit (the app stays in the Dock), so the gateway
            // keeps running while the app process is alive — only a real quit
            // stops it.
            tauri::RunEvent::Exit => {
                let supervisor = app_handle.state::<commands::model::GatewaySupervisor>();
                tauri::async_runtime::block_on(async {
                    let _lifecycle_guard = commands::openclaw_connection::local_gateway_shutdown_guard(app_handle).await;
                    supervisor.stop().await;
                    services::browser_egress::stop();
                });
            }
            // The app stays in the Dock after the last window closes, so a Dock
            // click must bring a window back — otherwise the user is stuck in a
            // windowless app and can only force-quit.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                } else if let Some(config) = app_handle.config().app.windows.first().cloned() {
                    match tauri::WebviewWindowBuilder::from_config(app_handle, &config) {
                        Ok(window_builder) => {
                            if let Err(error) = window_builder.build() {
                                eprintln!("[reopen] failed to rebuild main window: {error}");
                            }
                        }
                        Err(error) => {
                            eprintln!("[reopen] invalid main window config: {error}");
                        }
                    }
                }
            }
            _ => {}
        }
    });
}

fn run_admin_host_app() {
    let builder = base_builder(true).invoke_handler(tauri::generate_handler![
        // conversations
        commands::conversations::pairing::conversation_bridge_status,
        commands::conversations::pairing::conversation_attempt_gateway_connect,
        commands::conversations::pairing::conversation_gateway_approve_latest_pairing,
        commands::conversations::pairing::conversation_gateway_pairing_status,
        commands::conversations::pairing::openclaw_profile_approve_latest_pairing,
        commands::conversations::pairing::openclaw_profile_pairing_status,
        commands::conversations::pairing::openclaw_profile_redeem_remote_setup,
        commands::conversations::pairing::openclaw_profile_remote_setup_code,
        commands::conversations::sessions::conversation_list_sessions,
        commands::conversations::sessions::conversation_session_files,
        commands::conversations::sessions::conversation_create_session,
        commands::conversations::sessions::conversation_rename_session,
        commands::conversations::sessions::conversation_set_session_permission,
        commands::conversations::sessions::conversation_patch_session_state,
        commands::conversations::sessions::conversation_set_session_model,
        commands::conversations::sessions::conversation_set_session_reasoning,
        commands::conversations::sessions::conversation_set_session_thinking,
        commands::conversations::history::conversation_load_history,
        commands::conversations::pairing::conversation_prepare_gateway_connect_preview,
        commands::conversations::turns::conversation_abort_turn,
        commands::conversations::turns::conversation_subscribe_session,
        commands::conversations::turns::conversation_send_turn,
        commands::conversations::turns::conversation_import_attachments,
        commands::conversations::turns::conversation_import_attachment_data_url,
        commands::conversations::approvals::conversation_list_plugin_approvals,
        commands::conversations::approvals::conversation_resolve_plugin_approval,
        commands::conversations::approvals::conversation_list_exec_approvals,
        commands::conversations::approvals::conversation_resolve_exec_approval,
        // local documents
        commands::local_documents::local_documents_list,
        commands::local_documents::local_document_get,
        commands::local_documents::local_document_create,
        commands::local_documents::local_document_update,
        commands::local_documents::local_document_archive,
        // model
        commands::model::runtime::openclaw_status,
        commands::model::models::openclaw_models_snapshot,
        commands::model::models::openclaw_official_bootstrap_snapshot,
        commands::model::models::openclaw_use_provider_api_key_model,
        commands::model::models::openclaw_use_custom_openai_model,
        commands::model::models::openclaw_use_uniopc_official_model,
        commands::model::models::official_model_upstream_ready,
        commands::model::models::official_model_local_profile_state,
        commands::model::models::official_model_refresh_token,
        commands::model::models::openclaw_use_openai_api_model,
        commands::model::models::openclaw_media_capabilities_save,
        commands::model::models::openclaw_login_openai_codex,
        commands::model::models::openclaw_login_minimax_oauth,
        commands::model::runtime::openclaw_check_update,
        commands::model::profiles::openclaw_profile_status,
        commands::model::profiles::openclaw_reset_profile_data,
        commands::model::profiles::openclaw_logout_active_profile,
        commands::model::runtime::openclaw_install,
        commands::model::runtime::openclaw_start_gateway,
        commands::model::runtime::openclaw_stop_gateway,
        commands::model::runtime::openclaw_update,
        commands::model::runtime::openclaw_uninstall,
        commands::model::runtime::openclaw_gateway_log_tail,
        commands::model::runtime::openclaw_startup_metrics,
        commands::model::runtime::openclaw_startup_events,
        commands::external_open::open_external_url,
        commands::artifacts::artifact_stat_paths,
        commands::artifacts::artifact_reveal_in_dir,
        commands::artifacts::artifact_open_path,
        commands::artifacts::artifact_index_read,
        commands::artifacts::artifact_index_write,
        commands::artifacts::artifact_read_text,
        commands::artifacts::resolve_media_asset_path,
        commands::mac_permissions::mac_permissions_status,
        commands::mac_permissions::mac_permissions_request,
        commands::native_voice_input::native_voice_input_start,
        commands::native_voice_input::native_voice_input_stop,
        commands::native_voice_input::native_voice_input_cancel,
        commands::montage_local::montage_local_render_start,
        commands::montage_local::montage_local_render_status,
        commands::openclaw_connection::openclaw_connection_snapshot,
        commands::openclaw_connection::openclaw_effective_status,
        commands::openclaw_connection::openclaw_connection_set_mode,
        commands::openclaw_connection::openclaw_connection_save_remote_direct,
        commands::openclaw_connection::openclaw_connection_save_remote_ssh,
        commands::openclaw_connection::openclaw_connection_start_local,
        commands::openclaw_connection::openclaw_connection_stop_local,
        commands::openclaw_connection::openclaw_connection_refresh,
        commands::openclaw_connection::openclaw_mobile_lan_set_enabled,
        commands::openclaw_connection::openclaw_mobile_lan_status,
        commands::openclaw_connection::openclaw_connection_test_remote,
        commands::openclaw_browser::openclaw_browser_runtime_snapshot,
        commands::openclaw_browser::openclaw_browser_dock_snapshot,
        commands::openclaw_browser::openclaw_browser_runtime_set_enabled,
        commands::openclaw_browser::openclaw_browser_action,
        commands::openclaw_browser::openclaw_browser_dock_action,
        commands::openclaw_browser::openclaw_browser_dock_stream_start,
        commands::openclaw_browser::openclaw_browser_dock_stream_stop,
        // native browser surface
        commands::native_browser::native_browser_open,
        commands::native_browser::native_browser_resize,
        commands::native_browser::native_browser_action,
        commands::openclaw_cron::openclaw_cron_list,
        commands::openclaw_cron::openclaw_cron_get,
        commands::openclaw_cron::openclaw_cron_add,
        commands::openclaw_cron::openclaw_cron_update,
        commands::openclaw_cron::openclaw_cron_patch,
        commands::openclaw_cron::openclaw_cron_remove,
        commands::openclaw_cron::openclaw_cron_run,
        commands::openclaw_cron::openclaw_cron_runs,
        commands::openclaw_cron::openclaw_cron_status,
        commands::openclaw_mcp::openclaw_mcp_servers_list,
        commands::openclaw_mcp::openclaw_mcp_server_set,
        commands::openclaw_mcp::openclaw_mcp_server_unset,
        commands::openclaw_plugins::plugins::openclaw_supported_plugins_list,
        commands::openclaw_plugins::plugins::openclaw_profile_plugins_list,
        commands::openclaw_plugins::plugins::openclaw_profile_plugin_doctor_check,
        commands::openclaw_plugins::plugins::openclaw_profile_plugin_reconcile,
        commands::openclaw_plugins::plugins::openclaw_profile_tool_capabilities_list,
        commands::openclaw_plugins::plugins::openclaw_profile_plugin_set,
        commands::openclaw_plugins::plugins::uniopc_plugin_lifecycle_prepare,
        commands::openclaw_plugins::plugins::uniopc_plugin_lifecycle_commit,
        commands::openclaw_plugins::plugins::uniopc_plugin_lifecycle_cancel,
        commands::openclaw_plugins::plugins::uniopc_cloud_plugin_uninstall,
        commands::openclaw_plugins::plugins::uniopc_plugin_grants_write,
        commands::trusted_network::trusted_plugin_catalog_fetch,
        commands::trusted_network::trusted_host_credential_issue,
        commands::openclaw_agents::openclaw_agents_list,
        commands::openclaw_agents::openclaw_agent_templates_list,
        commands::openclaw_agents::openclaw_agents_create,
        commands::openclaw_agents::openclaw_agents_update,
        commands::openclaw_agents::openclaw_agents_delete,
        commands::openclaw_agents::openclaw_skillhub_snapshot,
        commands::openclaw_agents::openclaw_agent_skills_set,
        commands::openclaw_agents::openclaw_agent_tools_deny_set,
        commands::openclaw_agents::openclaw_agent_capabilities_snapshot,
        commands::openclaw_agents::openclaw_agent_documents_list,
        commands::openclaw_agents::openclaw_agent_document_get,
        commands::openclaw_agents::openclaw_agent_document_save,
        commands::openclaw_channels::openclaw_feishu_overview,
        commands::openclaw_channels::openclaw_feishu_save_account,
        commands::openclaw_channels::openclaw_feishu_bind_employee,
        commands::openclaw_channels::openclaw_feishu_unbind_employee,
        commands::openclaw_channels::openclaw_wechat_overview,
        commands::openclaw_channels::openclaw_wechat_install_plugin,
        commands::openclaw_channels::openclaw_wechat_qr_start,
        commands::openclaw_channels::openclaw_wechat_qr_wait,
        commands::openclaw_channels::openclaw_channel_bind_employee,
        commands::openclaw_channels::openclaw_channel_unbind_employee,
        commands::openclaw_channels::openclaw_channel_pairing_requests,
        commands::openclaw_channels::openclaw_channel_pairing_approve,
        commands::openclaw_channels::openclaw_channel_set_policy,
        commands::openclaw_channels::openclaw_open_external_url,
    ]);

    run_tauri(builder, "error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disable_ambient_proxy_env_removes_all_proxy_vars() {
        // Serialized implicitly: this is the only test touching these vars.
        for key in AMBIENT_PROXY_ENV_VARS {
            std::env::set_var(key, "http://127.0.0.1:7890");
        }
        disable_ambient_proxy_env();
        for key in AMBIENT_PROXY_ENV_VARS {
            assert!(
                std::env::var(key).is_err(),
                "{key} should be cleared so reqwest connects directly",
            );
        }
    }
}
