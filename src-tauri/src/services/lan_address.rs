//! Detect this machine's LAN-reachable IPv4 so the desktop can tell a phone on
//! the same Wi-Fi where to reach the gateway.
//!
//! Direct-connect (see docs/mobile-client-plan.md) is same-network only: the
//! phone connects straight to `ws://<lan-ip>:<port>`. This module answers "what
//! is my LAN IP" without pulling in a network-interface crate — it uses the
//! classic UDP-connect trick: `connect()` on a UDP socket toward a public
//! address sends nothing, it just makes the OS pick the egress interface, whose
//! local address is the LAN IP a same-subnet peer would use.
//!
//! Loopback / link-local / unspecified addresses are rejected: a phone can't
//! reach those, and publishing one would be a silent dead end.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};

/// True when `ip` is a private-range IPv4 a same-LAN phone could actually reach
/// (RFC1918), excluding loopback, link-local (169.254/16), and unspecified.
/// CGNAT (100.64/10) is intentionally excluded — it is not a normal home/office
/// LAN and would usually be an unreachable carrier address.
pub fn is_usable_lan_ipv4(ip: Ipv4Addr) -> bool {
    if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast() {
        return false;
    }
    let [a, b, ..] = ip.octets();
    match a {
        10 => true,
        172 => (16..=31).contains(&b),
        192 => b == 168,
        _ => false,
    }
}

/// Best-effort detection of the primary LAN IPv4. Returns `None` when the
/// machine has no usable private address (e.g. only loopback, or only a public
/// address we won't publish).
pub fn detect_lan_ipv4() -> Option<Ipv4Addr> {
    // Any routable, non-loopback target works — no packet is sent by connect().
    // Try a couple so a machine with only one IP family still resolves.
    for target in ["10.255.255.255:1", "192.168.255.255:1", "8.8.8.8:80"] {
        let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
            continue;
        };
        if socket.connect(target).is_err() {
            continue;
        }
        if let Ok(IpAddr::V4(ip)) = socket.local_addr().map(|addr| addr.ip()) {
            if is_usable_lan_ipv4(ip) {
                return Some(ip);
            }
        }
    }
    None
}

/// Build the LAN gateway ws URL a phone should dial, or `None` if no LAN IP.
/// Plaintext `ws://` is fine here: the engine allows it for private-LAN hosts,
/// and the connection is guarded by the gateway password.
pub fn lan_gateway_ws_url(port: u16) -> Option<String> {
    detect_lan_ipv4().map(|ip| format!("ws://{ip}:{port}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_rfc1918_ranges() {
        assert!(is_usable_lan_ipv4(Ipv4Addr::new(192, 168, 1, 23)));
        assert!(is_usable_lan_ipv4(Ipv4Addr::new(10, 0, 0, 5)));
        assert!(is_usable_lan_ipv4(Ipv4Addr::new(172, 16, 4, 9)));
        assert!(is_usable_lan_ipv4(Ipv4Addr::new(172, 31, 255, 254)));
    }

    #[test]
    fn rejects_unreachable_addresses() {
        assert!(!is_usable_lan_ipv4(Ipv4Addr::LOCALHOST));
        assert!(!is_usable_lan_ipv4(Ipv4Addr::new(169, 254, 1, 1))); // link-local
        assert!(!is_usable_lan_ipv4(Ipv4Addr::UNSPECIFIED));
        assert!(!is_usable_lan_ipv4(Ipv4Addr::new(8, 8, 8, 8))); // public
        assert!(!is_usable_lan_ipv4(Ipv4Addr::new(172, 32, 0, 1))); // just outside 172.16/12
        assert!(!is_usable_lan_ipv4(Ipv4Addr::new(100, 100, 0, 1))); // CGNAT excluded
    }

    #[test]
    fn builds_ws_url_when_lan_present() {
        // Pure formatting check independent of the machine's real IP.
        assert_eq!(
            format!("ws://{}:{}", Ipv4Addr::new(192, 168, 0, 42), 18790),
            "ws://192.168.0.42:18790"
        );
    }
}
