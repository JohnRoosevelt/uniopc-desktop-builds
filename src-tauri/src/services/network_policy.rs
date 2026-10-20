//! Policy boundary for Uniopc-owned control-plane traffic.
//!
//! This module deliberately does not expose a generic HTTP client. Callers must
//! identify a URL as a trusted service and match a versioned allowlist compiled
//! into the desktop binary before the Fake-IP exception or bounded route
//! fallback is usable.

use reqwest::Url;
use serde::Serialize;
use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct TrustedOrigin {
    scheme: String,
    host: String,
    port: Option<u16>,
}

impl TrustedOrigin {
    fn parse_origin(value: &str) -> Option<Self> {
        let parsed = Url::parse(value).ok()?;
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !matches!(parsed.path(), "" | "/")
        {
            return None;
        }
        Some(Self::from_url(&parsed)?)
    }

    fn from_url(value: &Url) -> Option<Self> {
        Some(Self {
            scheme: value.scheme().to_ascii_lowercase(),
            host: value.host_str()?.trim_end_matches('.').to_ascii_lowercase(),
            port: value.port_or_known_default(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct NetworkPolicy {
    allowlist_version: String,
    trusted_origins: BTreeSet<TrustedOrigin>,
}

impl NetworkPolicy {
    pub fn from_compiled_origins(
        version: &str,
        origins: &[&str],
    ) -> Result<Self, NetworkPolicyError> {
        let version = version.trim();
        if version.is_empty() {
            return Err(NetworkPolicyError::new(
                NetworkErrorCode::TrustedAllowlistInvalid,
            ));
        }
        let trusted_origins = origins
            .iter()
            .filter_map(|origin| TrustedOrigin::parse_origin(origin))
            .collect::<BTreeSet<_>>();
        if trusted_origins.len() != origins.len() || trusted_origins.is_empty() {
            return Err(NetworkPolicyError::new(
                NetworkErrorCode::TrustedAllowlistInvalid,
            ));
        }
        Ok(Self {
            allowlist_version: version.to_string(),
            trusted_origins,
        })
    }

    pub fn allowlist_version(&self) -> &str {
        &self.allowlist_version
    }

    pub fn plan(
        &self,
        target: RequestTarget<'_>,
        environment: &NetworkEnvironment,
    ) -> Result<RoutePlan, NetworkPolicyError> {
        let RequestTarget::TrustedService(raw_url) = target else {
            // Generic web and plugin-tool URLs remain owned by their existing
            // SSRF guard. They cannot opt into this control-plane exception.
            return Err(NetworkPolicyError::new(
                NetworkErrorCode::GenericUrlPolicyUnchanged,
            ));
        };
        if environment.offline {
            return Err(NetworkPolicyError::new(NetworkErrorCode::Offline));
        }

        let url = Url::parse(raw_url)
            .ok()
            .filter(|url| url.scheme() == "https")
            .ok_or_else(|| NetworkPolicyError::new(NetworkErrorCode::OriginNotTrusted))?;
        let origin = TrustedOrigin::from_url(&url)
            .ok_or_else(|| NetworkPolicyError::new(NetworkErrorCode::OriginNotTrusted))?;
        if !self.trusted_origins.contains(&origin) {
            return Err(NetworkPolicyError::new(NetworkErrorCode::OriginNotTrusted));
        }

        let dns_category = classify_dns_addresses(&environment.resolved_addresses)?;
        let routes = if environment.dns_resolution_failed {
            if environment.explicit_proxy_configured {
                vec![NetworkRoute::ExplicitProxy]
            } else if environment.system_proxy_available {
                vec![NetworkRoute::SystemProxy]
            } else if environment.system_proxy_auto_configured {
                // WinHTTP exposes PAC/auto-detect state, but this process does
                // not evaluate PAC. Never mistake its presence for a concrete
                // remote-DNS proxy route.
                return Err(NetworkPolicyError::new(NetworkErrorCode::DnsUnavailable));
            } else {
                return Err(NetworkPolicyError::new(NetworkErrorCode::DnsUnavailable));
            }
        } else if environment.explicit_proxy_configured {
            vec![NetworkRoute::ExplicitProxy, NetworkRoute::Direct]
        } else if environment.system_proxy_available {
            vec![NetworkRoute::Direct, NetworkRoute::SystemProxy]
        } else {
            vec![NetworkRoute::Direct]
        };

        debug_assert!(routes.len() <= 2);
        Ok(RoutePlan {
            dns_category,
            routes,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub enum RequestTarget<'a> {
    TrustedService(&'a str),
    GenericUrl(&'a str),
}

#[derive(Clone, Debug, Default)]
pub struct NetworkEnvironment {
    pub offline: bool,
    pub system_proxy_available: bool,
    pub system_proxy_auto_configured: bool,
    pub explicit_proxy_configured: bool,
    pub dns_resolution_failed: bool,
    pub resolved_addresses: Vec<IpAddr>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkRoute {
    Direct,
    SystemProxy,
    ExplicitProxy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DnsAddressCategory {
    Unknown,
    Public,
    TunFakeIp,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoutePlan {
    pub dns_category: DnsAddressCategory,
    routes: Vec<NetworkRoute>,
}

impl RoutePlan {
    pub fn routes(&self) -> &[NetworkRoute] {
        &self.routes
    }

    pub fn route_for_attempt(&self, attempt: usize) -> Option<NetworkRoute> {
        self.routes.get(attempt).copied()
    }

    pub fn execute_bounded<T, E>(
        &self,
        mut attempt: impl FnMut(NetworkRoute) -> Result<T, E>,
    ) -> Result<T, E> {
        let mut last_error = None;
        for route in self.routes.iter().copied().take(2) {
            match attempt(route) {
                Ok(value) => return Ok(value),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.expect("route plans always contain at least one route"))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetworkErrorCode {
    TrustedAllowlistInvalid,
    OriginNotTrusted,
    GenericUrlPolicyUnchanged,
    UnsafeDns,
    Offline,
    TransportUnavailable,
    Timeout,
    DnsUnavailable,
    RedirectDenied,
    AuthRequired,
    ResponseTooLarge,
    ResponseEncodingDenied,
    ResponseInvalid,
}

impl NetworkErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TrustedAllowlistInvalid => "trusted_allowlist_invalid",
            Self::OriginNotTrusted => "trusted_service_origin_denied",
            Self::GenericUrlPolicyUnchanged => "generic_url_policy_unchanged",
            Self::UnsafeDns => "trusted_service_unsafe_dns",
            Self::Offline => "trusted_service_offline",
            Self::TransportUnavailable => "trusted_service_unavailable",
            Self::Timeout => "trusted_service_timeout",
            Self::DnsUnavailable => "trusted_service_dns_unavailable",
            Self::RedirectDenied => "trusted_service_redirect_denied",
            Self::AuthRequired => "trusted_service_auth_required",
            Self::ResponseTooLarge => "trusted_catalog_response_too_large",
            Self::ResponseEncodingDenied => "trusted_catalog_response_encoding_denied",
            Self::ResponseInvalid => "trusted_catalog_response_invalid",
        }
    }

    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::Offline | Self::TransportUnavailable | Self::Timeout | Self::DnsUnavailable
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetworkPolicyError {
    code: NetworkErrorCode,
}

impl NetworkPolicyError {
    fn new(code: NetworkErrorCode) -> Self {
        Self { code }
    }

    pub fn code(&self) -> &'static str {
        self.code.as_str()
    }

    pub fn retryable(&self) -> bool {
        self.code.retryable()
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkTimings {
    pub dns_ms: Option<u64>,
    pub connect_ms: Option<u64>,
    pub tls_ms: Option<u64>,
    pub first_byte_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkTelemetry {
    route: NetworkRoute,
    dns_category: DnsAddressCategory,
    #[serde(flatten)]
    timings: NetworkTimings,
    error_code: Option<&'static str>,
}

impl NetworkTelemetry {
    pub fn new(
        route: NetworkRoute,
        dns_category: DnsAddressCategory,
        timings: NetworkTimings,
        error_code: Option<NetworkErrorCode>,
    ) -> Self {
        Self {
            route,
            dns_category,
            timings,
            error_code: error_code.map(NetworkErrorCode::as_str),
        }
    }
}

fn classify_dns_addresses(addresses: &[IpAddr]) -> Result<DnsAddressCategory, NetworkPolicyError> {
    if addresses.is_empty() {
        return Ok(DnsAddressCategory::Unknown);
    }
    let mut saw_fake_ip = false;
    for address in addresses {
        let address = match address {
            IpAddr::V6(address) => address
                .to_ipv4_mapped()
                .map(IpAddr::V4)
                .unwrap_or(IpAddr::V6(*address)),
            address => *address,
        };
        if is_tun_fake_ip(address) {
            saw_fake_ip = true;
        } else if is_unsafe_address(address) {
            return Err(NetworkPolicyError::new(NetworkErrorCode::UnsafeDns));
        }
    }
    Ok(if saw_fake_ip {
        DnsAddressCategory::TunFakeIp
    } else {
        DnsAddressCategory::Public
    })
}

fn is_tun_fake_ip(address: IpAddr) -> bool {
    let IpAddr::V4(address) = address else {
        return false;
    };
    let octets = address.octets();
    octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)
}

fn is_unsafe_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_unsafe_ipv4(address),
        IpAddr::V6(address) => is_unsafe_ipv6(address),
    }
}

pub(crate) fn is_unsafe_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_unspecified()
        || address.is_multicast()
        || address.is_broadcast()
        || octets[0] == 0
        || (octets[0] == 100 && octets[1] & 0b1100_0000 == 0b0100_0000)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
        || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
        || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
        || octets[0] >= 240
}

fn is_unsafe_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_unsafe_ipv4(mapped);
    }
    address.is_loopback()
        || address.is_unspecified()
        || address.is_unique_local()
        || address.is_unicast_link_local()
        || address.is_multicast()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn compiled_policy() -> NetworkPolicy {
        NetworkPolicy::from_compiled_origins(
            "desktop-trusted-services-v1",
            &["https://catalog.example.test"],
        )
        .expect("compiled allowlist")
    }

    fn environment(addresses: Vec<IpAddr>) -> NetworkEnvironment {
        NetworkEnvironment {
            offline: false,
            system_proxy_available: false,
            system_proxy_auto_configured: false,
            explicit_proxy_configured: false,
            dns_resolution_failed: addresses.is_empty(),
            resolved_addresses: addresses,
        }
    }

    #[test]
    fn direct_public_dns_uses_only_the_direct_route() {
        let plan = compiled_policy()
            .plan(
                RequestTarget::TrustedService("https://catalog.example.test/v2/feed?token=secret"),
                &environment(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))]),
            )
            .expect("trusted catalog route");

        assert_eq!(plan.dns_category, DnsAddressCategory::Public);
        assert_eq!(plan.routes(), &[NetworkRoute::Direct]);
    }

    #[test]
    fn a_system_proxy_is_the_single_bounded_fallback_after_direct() {
        let mut env = environment(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))]);
        env.system_proxy_available = true;

        let plan = compiled_policy()
            .plan(
                RequestTarget::TrustedService("https://catalog.example.test/v2/feed"),
                &env,
            )
            .expect("trusted catalog route");

        assert_eq!(
            plan.routes(),
            &[NetworkRoute::Direct, NetworkRoute::SystemProxy]
        );
        assert_eq!(plan.route_for_attempt(0), Some(NetworkRoute::Direct));
        assert_eq!(plan.route_for_attempt(1), Some(NetworkRoute::SystemProxy));
        assert_eq!(plan.route_for_attempt(2), None);
    }

    #[test]
    fn an_enterprise_explicit_proxy_precedes_the_single_direct_fallback() {
        let mut env = environment(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 4, 4))]);
        env.system_proxy_available = true;
        env.explicit_proxy_configured = true;

        let plan = compiled_policy()
            .plan(
                RequestTarget::TrustedService("https://catalog.example.test/v2/feed"),
                &env,
            )
            .expect("trusted catalog route");

        assert_eq!(
            plan.routes(),
            &[NetworkRoute::ExplicitProxy, NetworkRoute::Direct]
        );
    }

    #[test]
    fn offline_mode_returns_a_stable_retryable_error_without_a_route() {
        let mut env = environment(vec![]);
        env.offline = true;

        let error = compiled_policy()
            .plan(
                RequestTarget::TrustedService("https://catalog.example.test/v2/feed"),
                &env,
            )
            .unwrap_err();

        assert_eq!(error.code(), "trusted_service_offline");
        assert!(error.retryable());
    }

    #[test]
    fn trusted_catalog_allows_the_tun_fake_ip_range_without_global_ssrf_relaxation() {
        let mut env = environment(vec![IpAddr::V4(Ipv4Addr::new(198, 18, 23, 9))]);
        env.system_proxy_available = true;

        let plan = compiled_policy()
            .plan(
                RequestTarget::TrustedService("https://catalog.example.test/v2/feed"),
                &env,
            )
            .expect("trusted TUN route");

        assert_eq!(plan.dns_category, DnsAddressCategory::TunFakeIp);
        assert_eq!(
            plan.routes(),
            &[NetworkRoute::Direct, NetworkRoute::SystemProxy]
        );

        let generic_error = compiled_policy()
            .plan(
                RequestTarget::GenericUrl("http://198.18.23.9/latest/meta-data"),
                &env,
            )
            .unwrap_err();
        assert_eq!(generic_error.code(), "generic_url_policy_unchanged");
        assert!(!generic_error.retryable());
    }

    #[test]
    fn trusted_origin_still_rejects_private_or_loopback_dns_answers() {
        for address in [
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 7)),
        ] {
            let error = compiled_policy()
                .plan(
                    RequestTarget::TrustedService("https://catalog.example.test/v2/feed"),
                    &environment(vec![address]),
                )
                .unwrap_err();
            assert_eq!(error.code(), "trusted_service_unsafe_dns");
        }
    }

    #[test]
    fn direct_dns_failure_is_fail_closed() {
        let error = compiled_policy()
            .plan(
                RequestTarget::TrustedService("https://catalog.example.test/v2/feed"),
                &environment(vec![]),
            )
            .unwrap_err();

        assert_eq!(error.code(), "trusted_service_dns_unavailable");
        assert!(error.retryable());
    }

    #[test]
    fn dns_failure_can_only_use_an_explicit_remote_dns_proxy_route() {
        let mut environment = environment(vec![]);
        environment.system_proxy_available = true;

        let plan = compiled_policy()
            .plan(
                RequestTarget::TrustedService("https://catalog.example.test/v2/feed"),
                &environment,
            )
            .expect("proxy performs remote DNS");

        assert_eq!(plan.dns_category, DnsAddressCategory::Unknown);
        assert_eq!(plan.routes(), &[NetworkRoute::SystemProxy]);
    }

    #[test]
    fn ipv4_mapped_ipv6_reuses_ipv4_private_and_loopback_classification() {
        for address in [
            IpAddr::V6(Ipv4Addr::new(127, 0, 0, 1).to_ipv6_mapped()),
            IpAddr::V6(Ipv4Addr::new(10, 0, 0, 7).to_ipv6_mapped()),
        ] {
            let error = compiled_policy()
                .plan(
                    RequestTarget::TrustedService("https://catalog.example.test/v2/feed"),
                    &environment(vec![address]),
                )
                .unwrap_err();
            assert_eq!(error.code(), "trusted_service_unsafe_dns");
        }
    }

    #[test]
    fn ipv4_mapped_fake_ip_is_classified_as_the_scoped_tun_range() {
        let plan = compiled_policy()
            .plan(
                RequestTarget::TrustedService("https://catalog.example.test/v2/feed"),
                &environment(vec![IpAddr::V6(
                    Ipv4Addr::new(198, 18, 1, 2).to_ipv6_mapped(),
                )]),
            )
            .expect("mapped TUN fake IP");

        assert_eq!(plan.dns_category, DnsAddressCategory::TunFakeIp);
    }

    #[test]
    fn trusted_origin_rejects_special_use_dns_outside_the_fake_ip_exception() {
        for address in [
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)),
            IpAddr::V4(Ipv4Addr::new(240, 0, 0, 1)),
        ] {
            let error = compiled_policy()
                .plan(
                    RequestTarget::TrustedService("https://catalog.example.test/v2/feed"),
                    &environment(vec![address]),
                )
                .unwrap_err();
            assert_eq!(error.code(), "trusted_service_unsafe_dns");
        }
    }

    #[test]
    fn deterministic_proxy_tun_fixture_executes_only_one_route_switch() {
        let mut env = environment(vec![IpAddr::V4(Ipv4Addr::new(198, 19, 0, 7))]);
        env.system_proxy_available = true;
        let plan = compiled_policy()
            .plan(
                RequestTarget::TrustedService("https://catalog.example.test/v2/feed"),
                &env,
            )
            .expect("trusted TUN route");
        let mut attempts = Vec::new();

        let response = plan.execute_bounded(|route| {
            attempts.push(route);
            match route {
                NetworkRoute::Direct => Err("direct reset"),
                NetworkRoute::SystemProxy => Ok("catalog response"),
                NetworkRoute::ExplicitProxy => Err("unexpected explicit proxy"),
            }
        });

        assert_eq!(response, Ok("catalog response"));
        assert_eq!(
            attempts,
            vec![NetworkRoute::Direct, NetworkRoute::SystemProxy]
        );
    }

    #[test]
    fn route_telemetry_serializes_only_sanitized_fields() {
        let telemetry = NetworkTelemetry::new(
            NetworkRoute::SystemProxy,
            DnsAddressCategory::TunFakeIp,
            NetworkTimings {
                dns_ms: Some(3),
                connect_ms: Some(8),
                tls_ms: Some(13),
                first_byte_ms: Some(21),
            },
            Some(NetworkErrorCode::TransportUnavailable),
        );

        let value = serde_json::to_value(telemetry).expect("serialize telemetry");
        assert_eq!(value["route"], "system_proxy");
        assert_eq!(value["dnsCategory"], "tun_fake_ip");
        assert_eq!(value["errorCode"], "trusted_service_unavailable");
        let serialized = value.to_string().to_ascii_lowercase();
        for forbidden in ["token", "authorization", "header", "query", "url", "secret"] {
            assert!(
                !serialized.contains(forbidden),
                "telemetry leaked {forbidden}"
            );
        }
    }
}
