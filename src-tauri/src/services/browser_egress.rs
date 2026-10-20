//! Optional per-profile browser exit. Its core has no TUN/system DNS/proxy
//! integration; only the dedicated Chromium process points at its loopback port.
use serde::Deserialize;
use std::{
    fs,
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

static CHILD: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Deserialize)]
struct Settings {
    profile: String,
    executable: PathBuf,
    port: u16,
    controller_port: u16,
    tunnel: Option<super::browser_egress_tunnel::Settings>,
}

fn directory() -> Result<PathBuf, String> {
    Ok(super::uniopc_runtime_paths::uniopc_data_dir()?.join("network/browser-egress"))
}

fn loopback(port: u16) -> SocketAddrV4 {
    SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)
}

pub fn ensure(profile: Option<&str>) -> Result<(), String> {
    let dir = directory()?;
    let path = dir.join("settings.json");
    if !path.exists() {
        return Ok(());
    }
    let settings: Settings = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "专用浏览器出口配置无效".to_string())?;
    if profile != Some(settings.profile.as_str()) {
        return Ok(());
    }
    if settings.port == 0
        || settings.controller_port == 0
        || settings.port == settings.controller_port
        || !settings.executable.is_absolute()
        || !settings.executable.is_file()
    {
        return Err("专用浏览器出口的程序或端口无效".to_string());
    }
    let mut child = CHILD
        .lock()
        .map_err(|_| "专用浏览器出口状态锁不可用".to_string())?;
    if let Some(current) = child.as_mut() {
        if current.try_wait().map_err(|e| e.to_string())?.is_none() {
            return super::browser_egress_tunnel::ensure(settings.tunnel.as_ref(), settings.port);
        }
        *child = None;
    }
    // Recover only our recorded child after a forced application exit. Never
    // kill an arbitrary owner of a port or the user's global proxy core.
    #[cfg(unix)]
    if let Ok(pid) = fs::read_to_string(dir.join("child.pid")).and_then(|s| {
        s.trim()
            .parse::<u32>()
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "pid"))
    }) {
        if let Ok(output) = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "args="])
            .output()
        {
            let args = String::from_utf8_lossy(&output.stdout);
            if args.contains(&settings.executable.to_string_lossy().to_string())
                && args.contains(&dir.join("config.yaml").to_string_lossy().to_string())
            {
                let _ = Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .status();
                let deadline = Instant::now() + Duration::from_secs(2);
                while TcpStream::connect_timeout(
                    &loopback(settings.port).into(),
                    Duration::from_millis(50),
                )
                .is_ok()
                    && Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    // Check both ports before starting. A collision fails closed instead of
    // silently sending browser traffic through another local service.
    let port_guard = TcpListener::bind(loopback(settings.port))
        .map_err(|_| "专用浏览器出口端口已被占用".to_string())?;
    let controller_guard = TcpListener::bind(loopback(settings.controller_port))
        .map_err(|_| "专用浏览器出口管理端口已被占用".to_string())?;
    drop((port_guard, controller_guard));
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("core.log"))
        .map_err(|e| e.to_string())?;
    let error_log = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(&settings.executable);
    command
        .args(["-d"])
        .arg(&dir)
        .arg("-f")
        .arg(dir.join("config.yaml"))
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(error_log);
    super::openclaw_cli::hide_console(&mut command);
    let mut running = command
        .spawn()
        .map_err(|_| "无法启动专用浏览器出口".to_string())?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if running.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err("专用浏览器出口启动失败，请查看本机出口日志".to_string());
        }
        if TcpStream::connect_timeout(&loopback(settings.port).into(), Duration::from_millis(50))
            .is_ok()
            && TcpStream::connect_timeout(
                &loopback(settings.controller_port).into(),
                Duration::from_millis(50),
            )
            .is_ok()
        {
            break;
        }
        if Instant::now() >= deadline {
            let _ = running.kill();
            let _ = running.wait();
            return Err("专用浏览器出口启动超时".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = fs::write(dir.join("child.pid"), running.id().to_string());
    *child = Some(running);
    super::browser_egress_tunnel::ensure(settings.tunnel.as_ref(), settings.port)
}

pub fn stop() {
    super::browser_egress_tunnel::stop();
    if let Ok(mut state) = CHILD.lock() {
        if let Some(mut child) = state.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
