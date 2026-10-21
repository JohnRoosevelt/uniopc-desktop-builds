//! Fixed, bounded startup telemetry. Engine output is never used as progress.
use std::time::{Duration, Instant};

pub const PREFIX: &str = "UNIOPC_GATEWAY_STARTUP ";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Preload,
    ListenRequested(u16),
    Listening(u16),
    Heartbeat,
}

pub fn parse(line: &[u8]) -> Option<Event> {
    if line.len() > 192 {
        return None;
    }
    let text = std::str::from_utf8(line)
        .ok()?
        .trim_end_matches(['\r', '\n']);
    #[derive(serde::Deserialize)]
    #[serde(tag = "event", deny_unknown_fields)]
    enum Wire {
        #[serde(rename = "node_preload")]
        Preload {},
        #[serde(rename = "http_listen_requested")]
        Requested { port: u16 },
        #[serde(rename = "listening")]
        Listening { port: u16 },
        #[serde(rename = "heartbeat")]
        Heartbeat {
            uptime_ms: u64,
            rss_bytes: u64,
            lateness_ms: u64,
        },
    }
    match serde_json::from_str::<Wire>(text.strip_prefix(PREFIX)?).ok()? {
        Wire::Preload {} => Some(Event::Preload),
        Wire::Requested { port } if port != 0 => Some(Event::ListenRequested(port)),
        Wire::Listening { port } if port != 0 => Some(Event::Listening(port)),
        Wire::Heartbeat {
            uptime_ms,
            rss_bytes,
            lateness_ms,
        } if [uptime_ms, rss_bytes, lateness_ms]
            .into_iter()
            .all(|v| v <= 9_007_199_254_740_991) =>
        {
            Some(Event::Heartbeat)
        }
        _ => None,
    }
}

pub struct Progress {
    pub born: Instant,
    last_advance: Instant,
    milestone: u8,
    pub responded: bool,
    pub listening: bool,
    expected_port: u16,
}
impl Progress {
    pub fn new(now: Instant, expected_port: u16) -> Self {
        Self {
            born: now,
            last_advance: now,
            milestone: 0,
            responded: false,
            listening: false,
            expected_port,
        }
    }
    pub fn observe(&mut self, event: Event, now: Instant) {
        let milestone = match event {
            Event::Preload => 1,
            Event::ListenRequested(port) if port == self.expected_port => 2,
            Event::Listening(port) if port == self.expected_port => {
                self.listening = true;
                3
            }
            _ => return,
        };
        if milestone > self.milestone {
            self.milestone = milestone;
            self.last_advance = now;
        }
    }
    pub fn eligible(&self, now: Instant, remaining: Duration) -> bool {
        !self.responded
            && !self.listening
            && now.duration_since(self.born) >= Duration::from_secs(360)
            && now.duration_since(self.last_advance) >= Duration::from_secs(180)
            && remaining >= Duration::from_secs(300)
    }
}

/// The allowance belongs to the supervisor, never a flight or child. Only two
/// full authenticated finalizations on the same continuously held child reset it.
#[derive(Default)]
pub struct Allowance {
    consumed: bool,
    anchor: Option<(u64, Instant)>,
    episode: Option<(Option<String>, String)>,
}
impl Allowance {
    pub fn enter_episode(&mut self, profile: Option<&str>, runtime: &str) {
        let episode = (profile.map(str::to_owned), runtime.to_owned());
        if self.episode.as_ref() != Some(&episode) {
            self.episode = Some(episode);
            self.consumed = false;
            self.anchor = None;
        }
    }
    pub fn available(&self) -> bool {
        !self.consumed
    }
    pub fn consume(&mut self) -> bool {
        if self.consumed {
            false
        } else {
            self.consumed = true;
            self.anchor = None;
            true
        }
    }
    pub fn finalized(&mut self, child: u64, now: Instant) {
        match self.anchor {
            Some((id, at)) if id == child && now.duration_since(at) >= Duration::from_secs(15) => {
                self.consumed = false;
            }
            Some((id, _)) if id == child => {}
            _ => self.anchor = Some((child, now)),
        }
    }
    pub fn detached(&mut self) {
        self.anchor = None;
    }
}

/// Production recovery polling seam. Cheap checks must never execute Node.
/// The commit implementation repeats all checks under the final progress latch.
pub trait RecoveryPoll {
    fn check_identity(&mut self) -> Result<bool, String>;
    fn eligible(&self) -> bool;
    fn allowance_available(&self) -> bool;
    fn verify_runtime_and_config(&self) -> Result<(), String>;
    fn commit(&mut self) -> Result<bool, String>;
}

pub fn poll_recovery(poll: &mut impl RecoveryPoll) -> Result<bool, String> {
    if !poll.check_identity()? || !poll.eligible() || !poll.allowance_available() {
        return Ok(false);
    }
    poll.verify_runtime_and_config()?;
    if !poll.check_identity()? || !poll.eligible() || !poll.allowance_available() {
        return Ok(false);
    }
    poll.commit()
}

/// Exact read-only config identity. Neither bytes nor digest cross telemetry.
#[derive(Clone)]
pub struct ConfigIdentity {
    path: std::path::PathBuf,
    canonical: std::path::PathBuf,
    digest: [u8; 32],
}
impl ConfigIdentity {
    pub fn capture(path: std::path::PathBuf) -> Result<Self, String> {
        use sha2::{Digest, Sha256};
        let canonical =
            std::fs::canonicalize(&path).map_err(|_| "gateway_startup_config_changed")?;
        let bytes = std::fs::read(&path).map_err(|_| "gateway_startup_config_changed")?;
        Ok(Self {
            path,
            canonical,
            digest: Sha256::digest(bytes).into(),
        })
    }
    pub fn verify(&self) -> Result<(), String> {
        let current = Self::capture(self.path.clone())?;
        if current.canonical != self.canonical || current.digest != self.digest {
            return Err("gateway_startup_config_changed".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_poll_defers_full_verification_and_rechecks_before_commit() {
        use std::cell::Cell;
        struct Poll {
            ready: Cell<bool>,
            allowance: Cell<bool>,
            valid: Cell<Option<bool>>,
            verified: Cell<usize>,
            committed: usize,
            race: u8,
        }
        impl RecoveryPoll for Poll {
            fn check_identity(&mut self) -> Result<bool, String> {
                if self.race == 6 {
                    return Ok(false);
                }
                self.valid.get().ok_or_else(|| "identity_or_cancel".into())
            }
            fn eligible(&self) -> bool {
                self.ready.get()
            }
            fn allowance_available(&self) -> bool {
                self.allowance.get()
            }
            fn verify_runtime_and_config(&self) -> Result<(), String> {
                self.verified.set(self.verified.get() + 1);
                match self.race {
                    1 => self.valid.set(None),
                    2 => self.allowance.set(false),
                    3 => return Err("full_verification_failed".into()),
                    4 => self.ready.set(false),
                    5 => self.valid.set(Some(false)),
                    _ => {}
                }
                Ok(())
            }
            fn commit(&mut self) -> Result<bool, String> {
                self.allowance.set(false);
                self.committed += 1;
                Ok(true)
            }
        }
        for (ready, available, valid, race, expected_verifications, expected_commits) in [
            (false, true, true, 0, 0, 0),
            (true, false, true, 0, 0, 0),
            (true, true, false, 0, 0, 0),
            (true, true, true, 1, 1, 0),
            (true, true, true, 2, 1, 0),
            (true, true, true, 3, 1, 0),
            (true, true, true, 4, 1, 0),
            (true, true, true, 5, 1, 0),
            (true, true, true, 6, 0, 0),
            (true, true, true, 0, 1, 1),
        ] {
            let mut poll = Poll {
                ready: Cell::new(ready),
                allowance: Cell::new(available),
                valid: Cell::new(valid.then_some(true)),
                verified: Cell::new(0),
                committed: 0,
                race,
            };
            let _ = poll_recovery(&mut poll);
            assert_eq!(poll.verified.get(), expected_verifications);
            assert_eq!(poll.committed, expected_commits);
            if expected_verifications == 0 {
                for _ in 0..400 {
                    let _ = poll_recovery(&mut poll);
                }
                assert_eq!(
                    poll.verified.get(),
                    0,
                    "ordinary polling must not execute Node"
                );
            }
            if expected_commits == 1 {
                assert!(!poll_recovery(&mut poll).unwrap());
                assert_eq!(
                    poll.verified.get(),
                    1,
                    "spent allowance must skip Node on later polls"
                );
            }
        }
    }

    #[test]
    fn exact_boundaries_and_progress() {
        let now = Instant::now();
        let mut p = Progress::new(now, 1234);
        assert!(!p.eligible(now + Duration::from_secs(359), Duration::from_secs(300)));
        assert!(p.eligible(now + Duration::from_secs(360), Duration::from_secs(300)));
        assert!(!p.eligible(now + Duration::from_secs(360), Duration::from_secs(299)));
        p.observe(Event::Preload, now + Duration::from_secs(181));
        assert!(!p.eligible(now + Duration::from_secs(360), Duration::from_secs(300)));
        p.observe(Event::Preload, now + Duration::from_secs(350));
        p.observe(Event::Heartbeat, now + Duration::from_secs(350));
        p.observe(Event::Listening(99), now + Duration::from_secs(350));
        assert!(p.eligible(now + Duration::from_secs(361), Duration::from_secs(300)));
        p.observe(Event::Listening(1234), now + Duration::from_secs(361));
        assert!(!p.eligible(now + Duration::from_secs(600), Duration::from_secs(300)));
    }
    #[test]
    fn allowance_survives_detach_and_requires_two_finalizes() {
        let now = Instant::now();
        let mut a = Allowance::default();
        assert!(a.consume());
        a.detached();
        assert!(!a.consume());
        a.finalized(1, now);
        a.finalized(2, now + Duration::from_secs(20));
        assert!(!a.consume());
        a.finalized(2, now + Duration::from_secs(34));
        assert!(!a.consume());
        a.finalized(2, now + Duration::from_secs(35));
        assert!(a.consume());
        assert!(!a.consume());
    }
    #[test]
    fn new_profile_or_runtime_starts_a_new_episode_but_stops_and_flights_do_not() {
        let mut a = Allowance::default();
        a.enter_episode(Some("a"), "r1");
        assert!(a.consume());
        a.detached();
        a.enter_episode(Some("a"), "r1");
        assert!(!a.consume());
        a.enter_episode(Some("b"), "r1");
        assert!(a.consume());
        a.enter_episode(Some("b"), "r1");
        assert!(!a.consume());
        a.enter_episode(Some("b"), "r2");
        assert!(a.consume());
    }
    #[test]
    fn config_identity_rejects_changes_deletion_and_unreadable_files_without_mutation() {
        let dir =
            std::env::temp_dir().join(format!("uniopc-config-identity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, b"first").unwrap();
        let identity = ConfigIdentity::capture(path.clone()).unwrap();
        identity.verify().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0)).unwrap();
            // Root may bypass Unix mode bits; exercise the actual read-error
            // case whenever the test account lacks that privilege.
            if std::fs::read(&path).is_err() {
                assert!(identity.verify().is_err());
            }
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        std::fs::write(&path, b"second").unwrap();
        assert!(identity.verify().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        std::fs::remove_file(&path).unwrap();
        assert!(identity.verify().is_err());
        assert!(!path.exists());
        std::fs::create_dir(&path).unwrap();
        assert!(identity.verify().is_err());
        assert!(path.is_dir());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn parser_rejects_unbounded_or_arbitrary_data() {
        assert_eq!(
            parse(b"UNIOPC_GATEWAY_STARTUP {\"event\":\"node_preload\"}\n"),
            Some(Event::Preload)
        );
        for line in [
            "{\"event\":\"node_preload\",\"path\":\"secret\"}",
            "{\"event\":\"node_preload\",\"event\":\"node_preload\"}",
            "{\"event\":\"other\"}",
            "{\"event\":\"listening\",\"port\":65536}",
            "{\"event\":\"heartbeat\",\"uptime_ms\":-1,\"rss_bytes\":1,\"lateness_ms\":1}",
        ] {
            assert!(parse(format!("{PREFIX}{line}").as_bytes()).is_none());
        }
        assert!(parse(&vec![b'a'; 193]).is_none());
    }
}
