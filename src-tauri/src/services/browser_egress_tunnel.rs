//! A fixed public HTTPS destination, not a general-purpose browser proxy.
//! Browser URL/SSRF checks and end-to-end website TLS stay enabled. The relay
//! pins the remote IPv4 address in CONNECT, so the exit cannot re-resolve it
//! to a private target. No URL, Host header or client bytes select destinations.
use serde::Deserialize;
use std::{
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    sync::Mutex,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    task::JoinSet,
};

static TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

#[derive(Clone, Deserialize)]
pub struct Settings {
    pub port: u16,
    pub target_host: String,
    pub target_ipv4: Ipv4Addr,
}

fn valid_target(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !super::network_policy::is_unsafe_ipv4(ip)
        && !(octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
}

fn valid_settings(settings: &Settings, proxy_port: u16) -> bool {
    settings.port != 0
        && settings.port != proxy_port
        && valid_target(settings.target_ipv4)
        && settings.target_host.contains('.')
        && !settings.target_host.ends_with(".internal")
        && !settings.target_host.ends_with(".local")
        && settings.target_host.split('.').all(|p| {
            !p.is_empty()
                && p.len() <= 63
                && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

pub fn ensure(settings: Option<&Settings>, proxy_port: u16) -> Result<(), String> {
    let Some(settings) = settings else {
        return Ok(());
    };
    if !valid_settings(settings, proxy_port) {
        return Err("专用站点通道只允许固定公网HTTPS目标".to_string());
    }
    let mut task = TASK
        .lock()
        .map_err(|_| "专用站点通道状态不可用".to_string())?;
    if task.as_ref().is_some_and(|t| !t.inner().is_finished()) {
        return Ok(());
    }
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, settings.port))
        .map_err(|_| "专用站点通道端口已被占用".to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let settings = settings.clone();
    *task = Some(tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            return;
        };
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break; };
                    if connections.len() >= 32 { drop(stream); continue; }
                    let target = settings.target_ipv4;
                    connections.spawn(async move { let _ = relay(stream, proxy_port, target).await; });
                }
                _ = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        // JoinSet aborts connections when this task is stopped; sockets close.
    }));
    Ok(())
}

async fn relay(
    mut browser: TcpStream,
    proxy_port: u16,
    target: Ipv4Addr,
) -> Result<(), std::io::Error> {
    let mut upstream = tokio::time::timeout(
        Duration::from_secs(5),
        TcpStream::connect(SocketAddrV4::new(Ipv4Addr::LOCALHOST, proxy_port)),
    )
    .await??;
    let request = format!("CONNECT {target}:443 HTTP/1.1\r\nHost: {target}:443\r\n\r\n");
    upstream.write_all(request.as_bytes()).await?;
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut header = Vec::new();
        loop {
            if header.len() >= 4096 {
                return Err(std::io::Error::other("oversized proxy response"));
            }
            header.push(upstream.read_u8().await?);
            if header.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let line = header.split(|b| *b == b'\r').next().unwrap_or_default();
        if !line.starts_with(b"HTTP/1.1 200 ") && !line.starts_with(b"HTTP/1.0 200 ") {
            return Err(std::io::Error::other("fixed public tunnel refused"));
        }
        Ok::<(), std::io::Error>(())
    })
    .await??;
    let _ = tokio::time::timeout(
        Duration::from_secs(1800),
        tokio::io::copy_bidirectional(&mut browser, &mut upstream),
    )
    .await;
    Ok(())
}

pub fn stop() {
    if let Ok(mut task) = TASK.lock() {
        if let Some(task) = task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tunnel_refuses_private_metadata_synthetic_and_documentation_addresses() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.100.100.200",
            "198.18.0.1",
            "198.19.255.255",
            "192.0.2.1",
            "203.0.113.1",
            "224.0.0.1",
            "0.0.0.0",
        ] {
            assert!(!valid_target(ip.parse().unwrap()), "{ip}");
        }
        assert!(valid_target("185.199.108.153".parse().unwrap()));
    }
    #[test]
    fn tunnel_configuration_cannot_loop_to_its_own_proxy_port() {
        let mut s = Settings {
            port: 49236,
            target_host: "www.selenium.dev".into(),
            target_ipv4: "185.199.108.153".parse().unwrap(),
        };
        assert!(valid_settings(&s, 49234));
        assert!(!valid_settings(&s, 49236));
        s.target_host = "metadata.google.internal".into();
        assert!(!valid_settings(&s, 49234));
    }
}
