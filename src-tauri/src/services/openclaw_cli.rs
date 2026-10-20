use std::{env, path::PathBuf, sync::OnceLock};
use tokio::sync::{Mutex, MutexGuard};

// Loopback (the local gateway) plus the mainland-China backends that MUST be
// reached directly. Routing a domestic host through a China VPN proxy
// (HTTPS_PROXY) sends it overseas-and-back and intermittently ECONNRESETs
// mid-fetch — measured ~2/3 failure to `*.opentrust.net` vs 100% direct — which
// surfaces as "agent run failed before reply" on the uniopc-official model
// (llm-proxy lives on opentrust.net). `aliyuncs.com` covers the Bailian plan.
const OPENCLAW_NO_PROXY: &str = "127.0.0.1,localhost,::1,opentrust.net,aliyuncs.com";

/// The NO_PROXY value every openclaw spawn should carry. Exposed so proxied
/// spawns — the gateway child and CLI ops INHERIT `HTTPS_PROXY` for overseas
/// models — still bypass the proxy for the domestic model/Supabase backends.
pub fn no_proxy_value() -> &'static str {
    OPENCLAW_NO_PROXY
}

/// Windows `CREATE_NO_WINDOW`: spawn console subprocesses (the Node engine /
/// openclaw CLI) WITHOUT flashing a console window. Every openclaw spawn goes
/// through one of the two helpers below so the desktop app never pops a black
/// cmd/console window. No-op off Windows.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the console window for a `std::process::Command` spawn.
pub fn hide_console(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Suppress the console window for a `tokio::process::Command` spawn.
pub fn hide_console_tokio(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = command;
}
static OPENCLAW_CLI_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn local_bin_dir() -> PathBuf {
    crate::services::uniopc_runtime_paths::runtime_bin_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn local_node_bin_dir() -> PathBuf {
    crate::services::uniopc_runtime_paths::runtime_node_bin_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn path_prefixes() -> Vec<PathBuf> {
    let mut paths = vec![local_bin_dir(), local_node_bin_dir()];
    if let Some(home) = home_dir() {
        if !cfg!(target_os = "windows") {
            paths.push(home.join(".local").join("bin"));
        }
    }
    if cfg!(target_os = "macos") {
        paths.push(PathBuf::from("/opt/homebrew/bin"));
        paths.push(PathBuf::from("/usr/local/bin"));
    }
    paths
}

pub fn augmented_path(existing: Option<&str>) -> String {
    let mut paths = path_prefixes();
    let existing_value = existing
        .map(str::to_string)
        .or_else(|| env::var("PATH").ok())
        .unwrap_or_default();

    paths.extend(env::split_paths(&existing_value));

    let mut unique = Vec::<PathBuf>::new();
    for path in paths {
        if !unique.iter().any(|item| item == &path) {
            unique.push(path);
        }
    }

    env::join_paths(unique)
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or(existing_value)
}

fn cli_augmented_path() -> String {
    augmented_path(None)
}

/// Env pinning the engine's state to Uniopc's private layout. Inject at every
/// openclaw spawn so config/identity/sessions land in `state-v8/<profile>`. The
/// account is resolved from the explicit `profile` when present, else the
/// active-account marker (`active-profile.json`) — the master switch that makes
/// per-account isolation real: change this and the engine's entire on-disk
/// footprint (state-v8/workspace/oauth/sessions/extensions) moves with the account.
pub fn state_env_for_profile(profile: Option<&str>) -> Vec<(String, String)> {
    let mut envs = Vec::new();
    if let Ok(state_dir) =
        crate::services::uniopc_runtime_paths::state_v8_dir_for_profile_or_active(profile)
    {
        envs.push((
            "OPENCLAW_CONFIG_PATH".to_string(),
            state_dir.join("uniopc-engine.json").to_string_lossy().into_owned(),
        ));
        envs.push((
            "OPENCLAW_STATE_DIR".to_string(),
            state_dir.to_string_lossy().into_owned(),
        ));
        // Full self-containment: pin the default agent's workspace and the
        // OAuth dir INTO our private state dir. Without these the engine
        // defaults them to `<home>/.openclaw/…` (a shared home dir outside our
        // private layout) — that leak is what let a plain `rm -rf ~/.openclaw`
        // delete the default agent's workspace. Non-default agents already land
        // in `<state_dir>/workspace-<id>`; this brings the default agent in
        // line. (Config `agents.defaults.workspace`, baked at setup, still wins
        // over this env — so setup is passed `--workspace` too; see
        // OPENCLAW_ONBOARD_COMMAND.)
        envs.push((
            "OPENCLAW_WORKSPACE_DIR".to_string(),
            state_dir.join("workspace").to_string_lossy().into_owned(),
        ));
        envs.push((
            "OPENCLAW_OAUTH_DIR".to_string(),
            state_dir.join("oauth").to_string_lossy().into_owned(),
        ));
        // Generated media must stay in the profile's asset-protocol scope so
        // chat can hand its local path straight to a native video player.
        envs.push((
            "OPENCLAW_MEDIA_DIR".to_string(),
            state_dir.join("media").to_string_lossy().into_owned(),
        ));
    }
    // Pin the engine's OS-home level to our private data dir so ANY remaining
    // `<home>/.openclaw`-derived path stays inside Uniopc, never the user's real
    // `~/.openclaw`. State/workspace/oauth are pinned explicitly above; this is
    // the catch-all so a stock `~/.openclaw` install can never be touched.
    if let Ok(data_dir) = crate::services::uniopc_runtime_paths::uniopc_data_dir() {
        envs.push((
            "OPENCLAW_HOME".to_string(),
            data_dir.join("engine-home").to_string_lossy().into_owned(),
        ));
    }
    // Brand the engine's bot display name (the only upstream-supported
    // brand override; the rest is patched at bundle build time).
    // Brand aside: the local single-writer gateway runs `--auth password` with
    // our per-run in-memory password. Give spawned `openclaw` CLI subcommands
    // (models auth list, skills list, …) that same password so they authenticate
    // to the gateway instead of attempting a device handshake against it — that
    // mismatch is the `client:cli mode:probe → device-required → "resolved
    // command secrets locally"` fallback noise. The password stays out of
    // config/disk (writing it would restart the gateway); passing it via env is
    // exactly how the gateway child itself receives it.
    envs.push((
        "OPENCLAW_GATEWAY_PASSWORD".to_string(),
        crate::services::openclaw_connection::local_gateway_password().to_string(),
    ));
    envs.push(("OPENCLAW_BOT_NAME".to_string(), "Uniopc".to_string()));
    envs
}

pub fn local_loopback_env_overrides() -> [(&'static str, &'static str); 8] {
    [
        ("ALL_PROXY", ""),
        ("HTTPS_PROXY", ""),
        ("HTTP_PROXY", ""),
        ("all_proxy", ""),
        ("https_proxy", ""),
        ("http_proxy", ""),
        ("NO_PROXY", OPENCLAW_NO_PROXY),
        ("no_proxy", OPENCLAW_NO_PROXY),
    ]
}

/// npm on Windows installs the branded CLI as script shims with no .exe,
/// and CreateProcess cannot spawn those directly.
/// Resolve the engine to something spawnable: a real executable if present,
/// otherwise node.exe plus the package's JS entry (what the .cmd shim runs),
/// falling back to the shim through cmd.exe.
pub fn spawnable_command(program: &str, args: &[String]) -> (String, Vec<String>) {
    if program != "openclaw" {
        return (program.to_string(), args.to_vec());
    }

    if !cfg!(target_os = "windows") {
        // Core engine resolves ONLY to the bundled runtime binary — never a
        // system install on PATH (Homebrew / /usr/local). Returns the plain
        // name (unresolved) when the bundle is absent so callers fail loud
        // instead of silently spawning a stale global `openclaw`.
        if let Ok(bin) = crate::services::uniopc_runtime_paths::runtime_bin_dir() {
            let exe = bin.join("uniopc-engine");
            if exe.is_file() {
                return (exe.to_string_lossy().to_string(), args.to_vec());
            }
        }
        return (program.to_string(), args.to_vec());
    }

    // Windows core engine is embedded-only too: scan ONLY the bundled runtime
    // dirs, never the inherited system PATH — so a system `openclaw` on PATH can
    // never be picked. Not found → return the bare name so callers fail loud.
    let embedded_dirs: Vec<PathBuf> = [
        crate::services::uniopc_runtime_paths::runtime_bin_dir().ok(),
        // Natural Windows npm-prefix root: node.exe, uniopc-engine.cmd and
        // node_modules/uniopc-engine all live here, so the direct `node.exe
        // uniopc-engine.mjs` spawn path resolves without a bin/ copy.
        crate::services::uniopc_runtime_paths::runtime_tools_dir()
            .ok()
            .map(|tools| tools.join("node")),
        crate::services::uniopc_runtime_paths::runtime_node_bin_dir().ok(),
    ]
    .into_iter()
    .flatten()
    .collect();
    // Prefer the real Node executable plus the branded JS entry across every
    // embedded runtime directory. On Windows npm places `uniopc-engine.cmd` in
    // `bin/`, but keeps `node.exe` and `node_modules/uniopc-engine` together under
    // `tools/node/`; requiring the shim next to Node made us incorrectly spawn
    // `cmd /C ...uniopc-engine.cmd` even though a direct, windowless launch exists.
    for dir in &embedded_dirs {
        let exe = dir.join("uniopc-engine.exe");
        if exe.is_file() {
            return (exe.to_string_lossy().to_string(), args.to_vec());
        }
        let entry = dir
            .join("node_modules")
            .join("uniopc-engine")
            .join("uniopc-engine.mjs");
        let node = dir.join("node.exe");
        if entry.is_file() && node.is_file() {
            let mut full = vec![entry.to_string_lossy().to_string()];
            full.extend(args.iter().cloned());
            return (node.to_string_lossy().to_string(), full);
        }
    }

    // The command shim is a last resort after direct Node candidates.
    for dir in embedded_dirs {
        let cmd_shim = dir.join("uniopc-engine.cmd");
        if !cmd_shim.is_file() {
            continue;
        }
        let mut full = vec!["/C".to_string(), cmd_shim.to_string_lossy().to_string()];
        full.extend(args.iter().cloned());
        return ("cmd".to_string(), full);
    }

    (program.to_string(), args.to_vec())
}

pub async fn acquire_cli_lock() -> MutexGuard<'static, ()> {
    OPENCLAW_CLI_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await
}

/// Run an `openclaw` CLI invocation and return its stdout. This is the shared
/// bridge used for the official plugin lifecycle (`openclaw plugins install /
/// list / uninstall`) by both the bundled system plugin bootstrap and the
/// cloud-artifact install commands.
// True when a pinned bundled runtime version is compiled in (release builds).
// Mirrors `imai_openclaw_install_version()` so the CLI layer can enforce the
// same "core engine = bundled only" policy without a cross-module call.
fn pinned_bundle_expected() -> bool {
    option_env!("IMAI_OPENCLAW_VERSION")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value != "latest")
        .unwrap_or(false)
}

/// Cold provisioning installs many files; it has a separate, bounded budget.
/// The process owner enforces this deadline and cancels all descendants.
pub fn command_timeout(args: &[String]) -> std::time::Duration {
    let provisioning = args.first().is_some_and(|a| a == "onboard")
        || (args.first().is_some_and(|a| a == "plugins")
            && args
                .get(1)
                .is_some_and(|a| matches!(a.as_str(), "install" | "uninstall")));
    std::time::Duration::from_secs(if provisioning { 15 * 60 } else { 90 })
}

pub async fn openclaw_cli_output(
    args: Vec<String>,
    extra_env: Vec<(String, String)>,
) -> Result<String, String> {
    openclaw_cli_output_for_profile(None, args, extra_env).await
}

pub async fn openclaw_cli_output_for_profile(
    profile: Option<String>,
    args: Vec<String>,
    extra_env: Vec<(String, String)>,
) -> Result<String, String> {
    let _lock = acquire_cli_lock().await;
    let budget = command_timeout(&args);
    let (program, args) = spawnable_command("openclaw", &args);
    // Core engine is embedded-only: if it did not resolve to the bundled
    // runtime binary (still the bare name), refuse to fall back to a system
    // `openclaw` on PATH and fail loud — unless this is a dev build with no
    // pinned bundle compiled in.
    if program == "openclaw" && pinned_bundle_expected() {
        return Err(
                "内置 Uniopc 引擎运行时不可用（尚未激活或制品缺失），无法执行插件命令；不会回退到系统 openclaw。"
                    .to_string(),
            );
    }
    let mut command = tokio::process::Command::new(program);
    command
        .args(&args)
        .env("PATH", cli_augmented_path())
        .envs(state_env_for_profile(profile.as_deref()))
        .envs(extra_env);
    hide_console_tokio(&mut command);
    let output = crate::services::owned_command::output(command, budget)
        .await
        .map_err(|err| format!("无法执行 openclaw {}：{err}", args.join(" ")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!(
            "openclaw {} 失败，退出码 {}。",
            args.join(" "),
            output.status
        )
    } else {
        stderr
    })
}

pub async fn plugin_cli_output(args: Vec<String>) -> Result<String, String> {
    plugin_cli_output_for_profile(None, args).await
}

pub async fn plugin_cli_output_for_profile(
    profile: Option<&str>,
    args: Vec<String>,
) -> Result<String, String> {
    openclaw_cli_output_for_profile(
        profile.map(str::to_string),
        args,
        local_loopback_env_overrides()
            .into_iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provisioning_has_a_distinct_bounded_execution_budget() {
        for args in [vec!["onboard"], vec!["plugins", "install", "local-plugin"]] {
            assert_eq!(
                command_timeout(&args.into_iter().map(str::to_string).collect::<Vec<_>>())
                    .as_secs(),
                900
            );
        }
        assert_eq!(command_timeout(&["status".into()]).as_secs(), 90);
    }

    #[test]
    fn augmented_path_prefers_openclaw_install_locations() {
        let existing_bin = PathBuf::from("existing-bin");
        let existing = std::env::join_paths([&existing_bin])
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let path = augmented_path(Some(&existing));
        let parts = std::env::split_paths(&path).collect::<Vec<_>>();

        assert_eq!(parts.first(), Some(&local_bin_dir()));
        assert_eq!(parts.get(1), Some(&local_node_bin_dir()));
        assert_eq!(
            parts.iter().filter(|item| item == &&existing_bin).count(),
            1
        );
    }

    #[test]
    fn local_loopback_proxy_overrides_keep_gateway_local() {
        let overrides = local_loopback_env_overrides();
        assert!(overrides
            .iter()
            .any(|(key, value)| *key == "HTTP_PROXY" && value.is_empty()));
        assert!(overrides
            .iter()
            .any(|(key, value)| *key == "NO_PROXY" && value.contains("127.0.0.1")));
    }

    #[test]
    fn explicit_profile_never_becomes_the_path_input() {
        assert_eq!(super::cli_augmented_path(), super::augmented_path(None));
    }

    #[test]
    fn non_interactive_cli_route_is_native_and_hidden_on_windows() {
        let source = include_str!("openclaw_cli.rs");
        assert!(source.contains("pub async fn openclaw_cli_output"));
        assert!(source.contains("hide_console_tokio(&mut command)"));
    }

    #[test]
    fn state_environment_keeps_generated_media_inside_the_profile_media_dir() {
        let env = state_env_for_profile(Some("video-player-test"));
        let media_dir = env
            .iter()
            .find(|(key, _)| key == "OPENCLAW_MEDIA_DIR")
            .map(|(_, value)| std::path::PathBuf::from(value))
            .expect("engine environment must set OPENCLAW_MEDIA_DIR");

        assert_eq!(
            media_dir,
            crate::services::uniopc_runtime_paths::state_v8_dir_for_profile(Some(
                "video-player-test"
            ))
            .unwrap()
            .join("media")
        );
    }
}
