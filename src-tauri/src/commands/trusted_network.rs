use crate::services::network_policy::{
    NetworkEnvironment, NetworkErrorCode, NetworkPolicy, NetworkRoute, NetworkTelemetry,
    NetworkTimings, RequestTarget,
};
use crate::services::openclaw_gateway;
use futures_util::StreamExt;
use reqwest::{
    header::{ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_LENGTH},
    Client, Proxy, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::io;
use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub const COMPILED_TRUSTED_SUPABASE_ORIGINS: [&str; 2] = [
    "https://spb-bp1f48p09a51z42o.supabase.opentrust.net",
    "https://rzxdwuccqjwhrxtpdvlw.supabase.co",
];
const DEBUG_TRUSTED_SUPABASE_ORIGINS: [&str; 3] = [
    "https://spb-bp1f48p09a51z42o.supabase.opentrust.net",
    "https://rzxdwuccqjwhrxtpdvlw.supabase.co",
    "https://spb-bp10i1915oj07495.supabase.opentrust.net",
];
const CATALOG_RPC_PATH: &str = "/rest/v1/rpc/list_my_cloud_plugin_catalog";
const HOST_CREDENTIAL_FUNCTION_PATH: &str = "/functions/v1/issue-agent-runtime-token";
const DNS_LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CATALOG_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub struct CapturedProxyRoutes {
    system_proxy: Option<String>,
    explicit_proxy: Option<String>,
    auto_configured: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct PlatformProxyConfig {
    proxy: Option<String>,
    auto_configured: bool,
}

static CAPTURED_PROXY_ROUTES: OnceLock<CapturedProxyRoutes> = OnceLock::new();

#[cfg(debug_assertions)]
fn trusted_supabase_origins() -> &'static [&'static str] {
    &DEBUG_TRUSTED_SUPABASE_ORIGINS
}

#[cfg(not(debug_assertions))]
fn trusted_supabase_origins() -> &'static [&'static str] {
    &COMPILED_TRUSTED_SUPABASE_ORIGINS
}

pub fn capture_process_proxy_routes() {
    let explicit_proxy = proxy_from_env(&["UNIOPC_TRUSTED_SERVICE_PROXY"]);
    let environment_proxy = proxy_from_env(&[
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ]);
    let platform = platform_proxy_config();
    let _ = CAPTURED_PROXY_ROUTES.set(CapturedProxyRoutes {
        system_proxy: environment_proxy.or(platform.proxy),
        explicit_proxy,
        auto_configured: platform.auto_configured,
    });
}

fn proxy_from_env(keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| std::env::var(key).ok())
        .find_map(|value| validated_proxy_url(&value))
}

fn validated_proxy_url(value: &str) -> Option<String> {
    let value = value.trim();
    let normalized = if value.contains("://") {
        value.to_string()
    } else {
        format!("http://{value}")
    };
    let url = Url::parse(&normalized).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    Some(url.to_string())
}

fn parse_windows_proxy_server(value: &str) -> Option<String> {
    let value = value.trim();
    let selected = if value.contains('=') {
        let entries = value.split(';').filter_map(|entry| entry.split_once('='));
        let mut https = None;
        let mut http = None;
        for (scheme, address) in entries {
            match scheme.trim().to_ascii_lowercase().as_str() {
                "https" => https = validated_proxy_url(address),
                "http" => http = validated_proxy_url(address),
                _ => {}
            }
        }
        https.or(http)
    } else {
        validated_proxy_url(value)
    };
    selected
}

fn proxy_config_from_ie_values(
    proxy_enabled: bool,
    proxy_server: Option<&str>,
    auto_config_url: Option<&str>,
    auto_detect: bool,
) -> PlatformProxyConfig {
    PlatformProxyConfig {
        proxy: proxy_enabled
            .then(|| proxy_server.and_then(parse_windows_proxy_server))
            .flatten(),
        auto_configured: auto_detect
            || auto_config_url
                .map(str::trim)
                .is_some_and(|value| !value.is_empty()),
    }
}

#[cfg(not(windows))]
fn platform_proxy_config() -> PlatformProxyConfig {
    PlatformProxyConfig::default()
}

#[cfg(windows)]
fn platform_proxy_config() -> PlatformProxyConfig {
    windows_ie_proxy_config().unwrap_or_else(windows_registry_proxy_config)
}

#[cfg(windows)]
fn windows_ie_proxy_config() -> Option<PlatformProxyConfig> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpGetIEProxyConfigForCurrentUser, WINHTTP_CURRENT_USER_IE_PROXY_CONFIG,
    };

    struct GlobalWide(*mut u16);

    impl GlobalWide {
        unsafe fn to_string(&self) -> Option<String> {
            if self.0.is_null() {
                return None;
            }
            let mut length = 0;
            while *self.0.add(length) != 0 {
                length += 1;
            }
            Some(String::from_utf16_lossy(std::slice::from_raw_parts(
                self.0, length,
            )))
        }
    }

    impl Drop for GlobalWide {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = GlobalFree(self.0.cast());
                }
            }
        }
    }

    let mut config = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG {
        fAutoDetect: 0,
        lpszAutoConfigUrl: null_mut(),
        lpszProxy: null_mut(),
        lpszProxyBypass: null_mut(),
    };
    if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) } == 0 {
        return None;
    }
    let auto_url = unsafe { GlobalWide(config.lpszAutoConfigUrl).to_string() };
    let proxy = unsafe { GlobalWide(config.lpszProxy).to_string() };
    let _bypass = unsafe { GlobalWide(config.lpszProxyBypass).to_string() };
    Some(proxy_config_from_ie_values(
        proxy
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        proxy.as_deref(),
        auto_url.as_deref(),
        config.fAutoDetect != 0,
    ))
}

#[cfg(windows)]
fn windows_registry_proxy_config() -> PlatformProxyConfig {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings");
    let Ok(settings) = settings else {
        return PlatformProxyConfig::default();
    };
    let enabled = settings
        .get_value::<u32, _>("ProxyEnable")
        .map(|value| value != 0)
        .unwrap_or(false);
    let proxy = settings.get_value::<String, _>("ProxyServer").ok();
    let auto_url = settings.get_value::<String, _>("AutoConfigURL").ok();
    proxy_config_from_ie_values(enabled, proxy.as_deref(), auto_url.as_deref(), false)
}

fn trusted_catalog_url(service_origin: &str) -> Result<Url, TrustedNetworkCommandError> {
    if !trusted_supabase_origins().contains(&service_origin) {
        return Err(TrustedNetworkCommandError::denied());
    }
    Url::parse(&format!("{service_origin}{CATALOG_RPC_PATH}"))
        .map_err(|_| TrustedNetworkCommandError::denied())
}

fn trusted_host_credential_url(service_origin: &str) -> Result<Url, TrustedNetworkCommandError> {
    if !trusted_supabase_origins().contains(&service_origin) {
        return Err(TrustedNetworkCommandError::denied());
    }
    Url::parse(&format!("{service_origin}{HOST_CREDENTIAL_FUNCTION_PATH}"))
        .map_err(|_| TrustedNetworkCommandError::denied())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedHostCredentialInput {
    pub service_origin: String,
    pub access_token: Option<String>,
    pub host_credential: Option<String>,
    pub profile: String,
    pub plugin_id: String,
    pub agent_id: Option<String>,
    #[serde(default)]
    pub reset_host_credential: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedHostCredentialResponse {
    pub status: u16,
    pub payload: Value,
}

fn gateway_host_credential_from_config(config: &Value, plugin_id: &str) -> Option<String> {
    if !plugin_id.starts_with("uniopc-") || plugin_id.contains('/') || plugin_id.contains('~') {
        return None;
    }
    config
        .pointer(&format!("/plugins/entries/{plugin_id}/config/env"))
        .and_then(Value::as_object)
        .and_then(|env| {
            env.iter()
                .find(|(key, _)| {
                    key.ends_with("_HOST_CREDENTIAL") && key.as_str() != "UNIOPC_HOST_CREDENTIAL"
                })
                .map(|(_, value)| value)
                .or_else(|| env.get("UNIOPC_HOST_CREDENTIAL"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|credential| credential.starts_with("uniopc_hc_"))
        .map(str::to_owned)
}

fn gateway_host_credential(profile: &str, plugin_id: &str) -> Option<String> {
    let config = openclaw_gateway::load_openclaw_config_for_profile(Some(profile)).ok()?;
    gateway_host_credential_from_config(&config, plugin_id)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedCatalogResponse {
    pub rows: Vec<Value>,
    pub source: &'static str,
    pub route: NetworkRoute,
    pub telemetry: Vec<NetworkTelemetry>,
}

fn online_catalog_response(
    rows: Vec<Value>,
    route: NetworkRoute,
    telemetry: Vec<NetworkTelemetry>,
) -> TrustedCatalogResponse {
    TrustedCatalogResponse {
        rows,
        source: "online",
        route,
        telemetry,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedNetworkCommandError {
    pub code: &'static str,
    pub retryable: bool,
    pub telemetry: Vec<NetworkTelemetry>,
}

impl TrustedNetworkCommandError {
    fn unavailable() -> Self {
        Self {
            code: "trusted_service_unavailable",
            retryable: true,
            telemetry: vec![],
        }
    }

    fn timeout() -> Self {
        Self {
            code: "trusted_service_timeout",
            retryable: true,
            telemetry: vec![],
        }
    }

    fn denied() -> Self {
        Self {
            code: "trusted_service_origin_denied",
            retryable: false,
            telemetry: vec![],
        }
    }

    fn auth_required() -> Self {
        Self {
            code: "trusted_service_auth_required",
            retryable: false,
            telemetry: vec![],
        }
    }

    fn with_telemetry(mut self, telemetry: Vec<NetworkTelemetry>) -> Self {
        self.telemetry = telemetry;
        self
    }
}

fn client_for_route(
    route: NetworkRoute,
    proxies: &CapturedProxyRoutes,
) -> Result<Client, TrustedNetworkCommandError> {
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip();
    builder = match route {
        NetworkRoute::Direct => builder.no_proxy(),
        NetworkRoute::SystemProxy => builder.proxy(
            Proxy::all(
                proxies
                    .system_proxy
                    .as_deref()
                    .ok_or_else(TrustedNetworkCommandError::unavailable)?,
            )
            .map_err(|_| TrustedNetworkCommandError::unavailable())?,
        ),
        NetworkRoute::ExplicitProxy => builder.proxy(
            Proxy::all(
                proxies
                    .explicit_proxy
                    .as_deref()
                    .ok_or_else(TrustedNetworkCommandError::unavailable)?,
            )
            .map_err(|_| TrustedNetworkCommandError::unavailable())?,
        ),
    };
    builder
        .build()
        .map_err(|_| TrustedNetworkCommandError::unavailable())
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum DnsResolution {
    Resolved(Vec<IpAddr>),
    Failed,
    TimedOut,
}

async fn resolve_addresses_with<F>(timeout: Duration, lookup: F) -> DnsResolution
where
    F: Future<Output = io::Result<Vec<IpAddr>>>,
{
    match tokio::time::timeout(timeout, lookup).await {
        Ok(Ok(addresses)) if !addresses.is_empty() => DnsResolution::Resolved(addresses),
        Ok(_) => DnsResolution::Failed,
        Err(_) => DnsResolution::TimedOut,
    }
}

async fn resolved_addresses(url: &Url) -> (DnsResolution, Option<u64>) {
    let Some(host) = url.host_str() else {
        return (DnsResolution::Failed, None);
    };
    let started = Instant::now();
    let port = url.port_or_known_default().unwrap_or(443);
    let resolution = resolve_addresses_with(DNS_LOOKUP_TIMEOUT, async move {
        tokio::net::lookup_host((host, port))
            .await
            .map(|items| items.map(|item| item.ip()).collect())
    })
    .await;
    (resolution, Some(started.elapsed().as_millis() as u64))
}

fn build_network_environment(
    offline: bool,
    proxies: &CapturedProxyRoutes,
    resolution: &DnsResolution,
) -> NetworkEnvironment {
    NetworkEnvironment {
        offline,
        system_proxy_available: proxies.system_proxy.is_some(),
        system_proxy_auto_configured: proxies.auto_configured,
        explicit_proxy_configured: proxies.explicit_proxy.is_some(),
        dns_resolution_failed: !matches!(resolution, DnsResolution::Resolved(_)),
        resolved_addresses: match resolution {
            DnsResolution::Resolved(addresses) => addresses.clone(),
            DnsResolution::Failed | DnsResolution::TimedOut => vec![],
        },
    }
}

async fn read_bounded_catalog_rows(
    response: reqwest::Response,
) -> Result<Vec<Value>, NetworkErrorCode> {
    if response
        .headers()
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err(NetworkErrorCode::ResponseEncodingDenied);
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > MAX_CATALOG_RESPONSE_BYTES as u64)
    {
        return Err(NetworkErrorCode::ResponseTooLarge);
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| NetworkErrorCode::TransportUnavailable)?;
        if body.len().saturating_add(chunk.len()) > MAX_CATALOG_RESPONSE_BYTES {
            return Err(NetworkErrorCode::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| NetworkErrorCode::ResponseInvalid)
}

#[tauri::command]
pub async fn trusted_plugin_catalog_fetch(
    service_origin: String,
    access_token: String,
    anon_key: String,
    offline: bool,
) -> Result<TrustedCatalogResponse, TrustedNetworkCommandError> {
    if access_token.trim().is_empty() || anon_key.trim().is_empty() {
        return Err(TrustedNetworkCommandError::auth_required());
    }
    let url = trusted_catalog_url(service_origin.trim())?;
    let proxies = CAPTURED_PROXY_ROUTES.get().cloned().unwrap_or_default();
    let (resolution, dns_ms) = resolved_addresses(&url).await;
    let environment = build_network_environment(offline, &proxies, &resolution);
    let policy = NetworkPolicy::from_compiled_origins(
        "desktop-trusted-services-v1",
        trusted_supabase_origins(),
    )
    .map_err(|_| TrustedNetworkCommandError::denied())?;
    let plan = policy
        .plan(RequestTarget::TrustedService(url.as_str()), &environment)
        .map_err(|error| TrustedNetworkCommandError {
            code: error.code(),
            retryable: error.retryable(),
            telemetry: vec![],
        })?;

    let mut telemetry = Vec::new();
    let mut last_error_code = NetworkErrorCode::TransportUnavailable;
    for route in plan.routes().iter().copied().take(2) {
        let client = client_for_route(route, &proxies)?;
        let started = Instant::now();
        let response = client
            .post(url.clone())
            .header("apikey", anon_key.trim())
            .bearer_auth(access_token.trim())
            .header(ACCEPT_ENCODING, "identity")
            .json(&serde_json::json!({}))
            .send()
            .await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match response {
            Ok(response) if response.status().is_redirection() => {
                telemetry.push(NetworkTelemetry::new(
                    route,
                    plan.dns_category,
                    NetworkTimings {
                        dns_ms,
                        connect_ms: Some(elapsed_ms),
                        tls_ms: None,
                        first_byte_ms: Some(elapsed_ms),
                    },
                    Some(NetworkErrorCode::RedirectDenied),
                ));
                return Err(TrustedNetworkCommandError {
                    code: NetworkErrorCode::RedirectDenied.as_str(),
                    retryable: false,
                    telemetry,
                });
            }
            Ok(response) if response.status().is_success() => {
                match read_bounded_catalog_rows(response).await {
                    Ok(rows) => {
                        telemetry.push(NetworkTelemetry::new(
                            route,
                            plan.dns_category,
                            NetworkTimings {
                                dns_ms,
                                connect_ms: Some(elapsed_ms),
                                tls_ms: None,
                                first_byte_ms: Some(elapsed_ms),
                            },
                            None,
                        ));
                        return Ok(online_catalog_response(rows, route, telemetry));
                    }
                    Err(code) => {
                        telemetry.push(NetworkTelemetry::new(
                            route,
                            plan.dns_category,
                            NetworkTimings {
                                dns_ms,
                                connect_ms: Some(elapsed_ms),
                                tls_ms: None,
                                first_byte_ms: Some(elapsed_ms),
                            },
                            Some(code),
                        ));
                        return Err(TrustedNetworkCommandError {
                            code: code.as_str(),
                            retryable: code.retryable(),
                            telemetry,
                        });
                    }
                }
            }
            Ok(response) if matches!(response.status().as_u16(), 401 | 403) => {
                telemetry.push(NetworkTelemetry::new(
                    route,
                    plan.dns_category,
                    NetworkTimings {
                        dns_ms,
                        connect_ms: Some(elapsed_ms),
                        tls_ms: None,
                        first_byte_ms: Some(elapsed_ms),
                    },
                    Some(NetworkErrorCode::AuthRequired),
                ));
                return Err(TrustedNetworkCommandError::auth_required().with_telemetry(telemetry));
            }
            Ok(_) => {
                telemetry.push(NetworkTelemetry::new(
                    route,
                    plan.dns_category,
                    NetworkTimings {
                        dns_ms,
                        connect_ms: Some(elapsed_ms),
                        tls_ms: None,
                        first_byte_ms: Some(elapsed_ms),
                    },
                    Some(NetworkErrorCode::TransportUnavailable),
                ));
            }
            Err(error) => {
                let code = if error.is_timeout() {
                    NetworkErrorCode::Timeout
                } else {
                    NetworkErrorCode::TransportUnavailable
                };
                last_error_code = code;
                telemetry.push(NetworkTelemetry::new(
                    route,
                    plan.dns_category,
                    NetworkTimings {
                        dns_ms,
                        connect_ms: Some(elapsed_ms),
                        tls_ms: None,
                        first_byte_ms: None,
                    },
                    Some(code),
                ));
            }
        }
    }
    if last_error_code == NetworkErrorCode::Timeout {
        Err(TrustedNetworkCommandError::timeout().with_telemetry(telemetry))
    } else {
        Err(TrustedNetworkCommandError::unavailable().with_telemetry(telemetry))
    }
}

#[tauri::command]
pub async fn trusted_host_credential_issue(
    input: TrustedHostCredentialInput,
) -> Result<TrustedHostCredentialResponse, TrustedNetworkCommandError> {
    let profile = input.profile.trim();
    let plugin_id = input.plugin_id.trim();
    let access_token = input.access_token.as_deref().unwrap_or("").trim();
    let host_credential = input.host_credential.as_deref().unwrap_or("").trim();
    if profile.is_empty() || plugin_id.is_empty() {
        return Err(TrustedNetworkCommandError::auth_required());
    }
    let gateway_credential = if input.reset_host_credential {
        None
    } else {
        gateway_host_credential(profile, plugin_id)
    };
    if access_token.is_empty() && host_credential.is_empty() && gateway_credential.is_none() {
        return Err(TrustedNetworkCommandError::auth_required());
    }
    let url = trusted_host_credential_url(input.service_origin.trim())?;
    let proxies = CAPTURED_PROXY_ROUTES.get().cloned().unwrap_or_default();
    let client = client_for_route(NetworkRoute::Direct, &proxies)?;
    let mut candidates: Vec<&str> = Vec::new();
    if !host_credential.is_empty() && !input.reset_host_credential {
        candidates.push(host_credential);
    }
    if let Some(credential) = gateway_credential.as_deref() {
        if credential != host_credential {
            candidates.push(credential);
        }
    }
    if candidates.is_empty() || !access_token.is_empty() {
        candidates.push("");
    }
    for (index, candidate) in candidates.iter().enumerate() {
        let mut request = client
            .post(url.clone())
            .header(ACCEPT_ENCODING, "identity")
            .json(&serde_json::json!({
                "profile": profile,
                "pluginId": plugin_id,
                "agentId": input.agent_id.as_deref().unwrap_or("").trim(),
                "resetHostCredential": input.reset_host_credential,
            }));
        request = if candidate.is_empty() {
            request.bearer_auth(access_token)
        } else {
            request.header("x-imai-host-credential", *candidate)
        };
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                TrustedNetworkCommandError::timeout()
            } else {
                TrustedNetworkCommandError::unavailable()
            }
        })?;
        if response.status().is_redirection() {
            return Err(TrustedNetworkCommandError::denied());
        }
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| TrustedNetworkCommandError::unavailable())?;
        if bytes.len() > 64 * 1024 {
            return Err(TrustedNetworkCommandError::unavailable());
        }
        let payload = serde_json::from_slice(&bytes)
            .map_err(|_| TrustedNetworkCommandError::unavailable())?;
        // Retry only after a rejected Host Credential. A 403 entitlement error
        // or a service failure must never cause a new credential to be minted.
        if status != 401 || candidate.is_empty() || index + 1 == candidates.len() {
            return Ok(TrustedHostCredentialResponse { status, payload });
        }
    }
    Err(TrustedNetworkCommandError::unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn catalog_url_is_fixed_below_a_compiled_trusted_origin() {
        assert_eq!(
            trusted_catalog_url("https://spb-bp1f48p09a51z42o.supabase.opentrust.net")
                .expect("compiled origin")
                .as_str(),
            "https://spb-bp1f48p09a51z42o.supabase.opentrust.net/rest/v1/rpc/list_my_cloud_plugin_catalog"
        );
        assert!(trusted_catalog_url("https://attacker.example/catalog").is_err());
        assert_eq!(
            trusted_catalog_url("https://spb-bp10i1915oj07495.supabase.opentrust.net").is_ok(),
            cfg!(debug_assertions)
        );
        assert!(trusted_catalog_url(
            "https://spb-bp1f48p09a51z42o.supabase.opentrust.net/redirect"
        )
        .is_err());
    }

    #[test]
    fn host_credential_url_is_fixed_below_a_compiled_trusted_origin() {
        assert_eq!(
            trusted_host_credential_url("https://spb-bp1f48p09a51z42o.supabase.opentrust.net")
                .expect("compiled origin")
                .as_str(),
            "https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/issue-agent-runtime-token"
        );
        assert!(trusted_host_credential_url("https://attacker.example").is_err());
        assert_eq!(
            trusted_host_credential_url("https://spb-bp10i1915oj07495.supabase.opentrust.net").is_ok(),
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn gateway_host_credential_is_read_only_from_the_matching_plugin() {
        let config = json!({
            "plugins": { "entries": {
                "uniopc-montage": { "config": { "env": {
                    "UNIOPC_MONTAGE_HOST_CREDENTIAL": "uniopc_hc_montage"
                } } },
                "uniopc-socials": { "config": { "env": {
                    "UNIOPC_SOCIALS_HOST_CREDENTIAL": "uniopc_hc_socials"
                } } }
            } }
        });
        assert_eq!(gateway_host_credential_from_config(&config, "uniopc-montage").as_deref(), Some("uniopc_hc_montage"));
        assert_eq!(gateway_host_credential_from_config(&config, "uniopc-socials").as_deref(), Some("uniopc_hc_socials"));
        assert_eq!(gateway_host_credential_from_config(&config, "uniopc-other"), None);
        assert_eq!(gateway_host_credential_from_config(&config, "uniopc-montage/config"), None);
    }

    #[test]
    fn v2_primary_origin_uses_the_same_fixed_routes() {
        let origin = "https://spb-bp1f48p09a51z42o.supabase.opentrust.net";
        assert_eq!(
            trusted_catalog_url(origin).expect("v2 primary origin").as_str(),
            "https://spb-bp1f48p09a51z42o.supabase.opentrust.net/rest/v1/rpc/list_my_cloud_plugin_catalog"
        );
        assert_eq!(
            trusted_host_credential_url(origin)
                .expect("v2 primary origin")
                .as_str(),
            "https://spb-bp1f48p09a51z42o.supabase.opentrust.net/functions/v1/issue-agent-runtime-token"
        );
    }

    #[test]
    fn unsigned_online_rows_are_only_an_ephemeral_online_response() {
        let response = online_catalog_response(
            vec![json!({"plugin_id": "uniopc-cloud-workspace"})],
            NetworkRoute::Direct,
            vec![],
        );

        assert_eq!(response.source, "online");
        let serialized = serde_json::to_value(response)
            .expect("serialize response")
            .to_string();
        assert!(!serialized.contains("cacheSnapshot"));
        assert!(!serialized.contains("signatureVerified"));
    }

    #[test]
    fn command_error_dto_contains_no_url_header_or_credential_fields() {
        let error = TrustedNetworkCommandError::unavailable();
        assert!(error.telemetry.is_empty());
        let value = serde_json::to_value(error).expect("serialize command error");

        assert_eq!(value["code"], "trusted_service_unavailable");
        assert_eq!(value["retryable"], true);
        let serialized = value.to_string().to_ascii_lowercase();
        for forbidden in ["url", "query", "header", "token", "authorization", "secret"] {
            assert!(!serialized.contains(forbidden), "error leaked {forbidden}");
        }
    }

    #[tokio::test]
    async fn client_never_follows_a_redirect_to_a_local_metadata_target() {
        let target = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("target listener");
        let target_addr = target.local_addr().expect("target address");
        let target_hit = Arc::new(AtomicBool::new(false));
        let target_hit_for_task = Arc::clone(&target_hit);
        let target_task = tokio::spawn(async move {
            if let Ok(Ok((mut socket, _))) =
                tokio::time::timeout(Duration::from_millis(500), target.accept()).await
            {
                target_hit_for_task.store(true, Ordering::SeqCst);
                let mut request = [0_u8; 1024];
                let _ = socket.read(&mut request).await;
                let _ = socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[]")
                    .await;
            }
        });

        let redirect = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("redirect listener");
        let redirect_addr = redirect.local_addr().expect("redirect address");
        let redirect_task = tokio::spawn(async move {
            let (mut socket, _) = redirect.accept().await.expect("redirect request");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{target_addr}/latest/meta-data\r\nContent-Length: 0\r\n\r\n"
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("redirect response");
        });

        let response = client_for_route(NetworkRoute::Direct, &CapturedProxyRoutes::default())
            .expect("direct client")
            .get(format!("http://{redirect_addr}/catalog"))
            .header("apikey", "must-not-leak")
            .send()
            .await
            .expect("redirect response");
        redirect_task.await.expect("redirect task");
        target_task.await.expect("target task");

        assert!(response.status().is_redirection());
        assert_eq!(
            NetworkErrorCode::RedirectDenied.as_str(),
            "trusted_service_redirect_denied"
        );
        assert!(!NetworkErrorCode::RedirectDenied.retryable());
        assert!(!target_hit.load(Ordering::SeqCst));
    }

    #[test]
    fn windows_proxy_strings_select_https_without_treating_pac_as_a_proxy() {
        assert_eq!(
            parse_windows_proxy_server("http=proxy.local:8080;https=secure.local:8443"),
            Some("http://secure.local:8443/".to_string())
        );
        assert_eq!(
            parse_windows_proxy_server("proxy.local:7890"),
            Some("http://proxy.local:7890/".to_string())
        );
        let pac_only =
            proxy_config_from_ie_values(false, None, Some("https://pac.local/config.pac"), false);
        assert_eq!(pac_only.proxy, None);
        assert!(pac_only.auto_configured);

        let environment = build_network_environment(
            false,
            &CapturedProxyRoutes {
                system_proxy: pac_only.proxy,
                explicit_proxy: None,
                auto_configured: pac_only.auto_configured,
            },
            &DnsResolution::Failed,
        );
        assert!(!environment.system_proxy_available);
        assert!(environment.system_proxy_auto_configured);
    }

    #[tokio::test]
    async fn dns_resolver_timeout_is_bounded_and_reported() {
        let result = resolve_addresses_with(Duration::from_millis(10), async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok(vec!["8.8.8.8".parse().expect("ip")])
        })
        .await;

        assert_eq!(result, DnsResolution::TimedOut);
    }

    #[test]
    fn injected_offline_and_dns_failure_state_reaches_the_rust_policy() {
        let proxies = CapturedProxyRoutes::default();
        let environment = build_network_environment(true, &proxies, &DnsResolution::Failed);

        assert!(environment.offline);
        assert!(!environment.system_proxy_auto_configured);
        assert!(environment.dns_resolution_failed);
        assert!(environment.resolved_addresses.is_empty());
    }

    #[tokio::test]
    async fn response_body_rejects_content_length_stream_overflow_and_compression() {
        let too_large = response_from_raw(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_CATALOG_RESPONSE_BYTES + 1
        ))
        .await;
        assert_eq!(
            read_bounded_catalog_rows(too_large).await.unwrap_err(),
            NetworkErrorCode::ResponseTooLarge
        );

        let compressed = response_from_raw(
            "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\n\r\n[]".to_string(),
        )
        .await;
        assert_eq!(
            read_bounded_catalog_rows(compressed).await.unwrap_err(),
            NetworkErrorCode::ResponseEncodingDenied
        );

        let oversized_body = " ".repeat(MAX_CATALOG_RESPONSE_BYTES + 1);
        let streaming = response_from_raw(format!(
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{oversized_body}"
        ))
        .await;
        assert_eq!(
            read_bounded_catalog_rows(streaming).await.unwrap_err(),
            NetworkErrorCode::ResponseTooLarge
        );
    }

    async fn response_from_raw(raw_response: String) -> reqwest::Response {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("request");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            socket
                .write_all(raw_response.as_bytes())
                .await
                .expect("response");
        });
        client_for_route(NetworkRoute::Direct, &CapturedProxyRoutes::default())
            .expect("client")
            .get(format!("http://{address}/catalog"))
            .send()
            .await
            .expect("response")
    }
}
