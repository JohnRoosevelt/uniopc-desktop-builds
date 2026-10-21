//! The owned Gateway's single startup deadline. Used by every local startup
//! path, including a retry that reuses a child left alive by an earlier flight.
use serde_json::{Map, Value};
use std::future::Future;
use std::time::Duration;
use tokio::time::{sleep, Instant};

pub const CANCEL_POLL: Duration = Duration::from_millis(250);
pub const DEADLINE_ERROR: &str = "gateway_startup_deadline_exceeded";
pub const RECOVERED: &str = "gateway_startup_recovered";
pub const CHILD_EXIT_ERROR: &str = "gateway_owned_child_exited";

pub trait GatewayStartup: Sync {
    type Snapshot: Send;
    fn check(&self) -> Result<(), String>;
    fn recover_stalled(&self, _deadline: Instant) -> impl Future<Output = Result<bool, String>> + Send {
        async { Ok(false) }
    }
    fn finalized(&self) -> impl Future<Output = Result<(), String>> + Send {
        async { Ok(()) }
    }
    fn child_running(&self) -> impl Future<Output = bool> + Send;
    fn http_ready(&self) -> impl Future<Output = Result<bool, String>> + Send;
    fn auth_ready(&self) -> impl Future<Output = Result<Option<Self::Snapshot>, String>> + Send;
    fn config_get(&self) -> impl Future<Output = Result<Value, String>> + Send;
    fn defaults_patch(&self, snapshot: &Value) -> Result<Value, String>;
    fn config_patch(
        &self,
        snapshot: &Value,
        delta: Value,
    ) -> impl Future<Output = Result<(), String>> + Send;
    fn contains_explicit_secret(&self, delta: &Value) -> bool;
    fn verify_plugins(&self) -> impl Future<Output = Result<(), String>> + Send;
    fn phase(&self, _phase: &str, _elapsed: Duration, _count: usize) {}
}

/// Activation callbacks are the production seam: tests exercise the same
/// fresh/existing/repair branch selection and spawn ownership as the command.
pub trait GatewayActivation: GatewayStartup {
    fn stop_and_reclaim(&self) -> impl Future<Output = Result<(), String>> + Send;
    fn onboard(&self) -> impl Future<Output = Result<(), String>> + Send;
    fn prepare_spawn(&self) -> impl Future<Output = Result<(), String>> + Send;
    fn spawn(&self) -> impl Future<Output = Result<(), String>> + Send;
    fn auth_repair_needed(&self, error: &str) -> bool;
}

pub struct Started<S> {
    pub snapshot: S,
    pub preflight_elapsed: Duration,
    pub spawn_elapsed: Option<Duration>,
    pub ready_elapsed: Duration,
}

/// One activation and one finalize, inside the app-owned singleflight leader.
/// A retry with an existing owned child reuses it and repeats postconditions.
pub async fn start<B: GatewayActivation>(
    b: &B,
    initialized: bool,
    has_owned_child: bool,
    budget: Duration,
) -> Result<Started<B::Snapshot>, String> {
    b.check()?;
    let began = Instant::now();
    let mut deadline = has_owned_child.then(|| Instant::now() + budget);
    let mut repair = false;
    if initialized && has_owned_child {
        if let Err(error) = wait_ready(b, deadline.unwrap()).await {
            repair = b.auth_repair_needed(&error);
            if !repair {
                return Err(error);
            }
        }
    }
    let preflight_elapsed = began.elapsed();
    let mut spawn_elapsed = None;
    if !has_owned_child || !initialized || repair {
        let preparation_deadline =
            deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(900));
        current(preparation_deadline, || b.check(), b.stop_and_reclaim()).await??;
        if !initialized || repair {
            let began = Instant::now();
            b.phase("profile_onboard", Duration::ZERO, 0);
            current(
                Instant::now() + Duration::from_secs(900),
                || b.check(),
                b.onboard(),
            )
            .await??;
            b.phase("profile_onboard", began.elapsed(), 1);
        }
        let began = Instant::now();
        b.phase("plugin_prepare", Duration::ZERO, 0);
        current(
            deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(900)),
            || b.check(),
            b.prepare_spawn(),
        )
        .await??;
        b.phase("plugin_prepare", began.elapsed(), 1);
        let began = Instant::now();
        current(
            deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(900)),
            || b.check(),
            b.spawn(),
        )
        .await??;
        spawn_elapsed = Some(began.elapsed());
        b.phase("gateway_spawn", began.elapsed(), 1);
        deadline.get_or_insert_with(|| Instant::now() + budget);
    }
    let began = Instant::now();
    let snapshot = finalize(b, deadline.expect("owned Gateway deadline")).await?;
    b.check()?;
    Ok(Started {
        snapshot,
        preflight_elapsed,
        spawn_elapsed,
        ready_elapsed: began.elapsed(),
    })
}

/// Dropping the future cancels further async work, not an already sent RPC or
/// a synchronous syscall. Owned CLI commands retain their drop-time tree guard.
pub async fn current<F: Future, C: Fn() -> Result<(), String>>(
    deadline: Instant,
    check: C,
    future: F,
) -> Result<F::Output, String> {
    tokio::pin!(future);
    loop {
        check()?;
        if Instant::now() >= deadline {
            return Err(DEADLINE_ERROR.into());
        }
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => return Err(DEADLINE_ERROR.into()),
            _ = sleep(CANCEL_POLL) => {},
            value = &mut future => { check()?; return Ok(value); }
        }
    }
}

pub(crate) async fn owned<B: GatewayStartup, F: Future>(
    b: &B,
    deadline: Instant,
    future: F,
) -> Result<F::Output, String> {
    tokio::pin!(future);
    loop {
        b.check()?;
        if Instant::now() >= deadline {
            return Err(DEADLINE_ERROR.into());
        }
        let recovery_began = Instant::now();
        if current(
            deadline,
            || b.check(),
            b.recover_stalled(deadline),
        ).await?? {
            b.phase("gateway_startup_recovery", recovery_began.elapsed(), 1);
            return Err(RECOVERED.into());
        }
        if !current(deadline, || b.check(), b.child_running()).await? {
            return Err(CHILD_EXIT_ERROR.into());
        }
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => return Err(DEADLINE_ERROR.into()),
            _ = sleep(CANCEL_POLL) => {},
            value = &mut future => { b.check()?; return Ok(value); }
        }
    }
}

pub fn transient(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    if error.contains("unauthorized")
        || error.contains("auth_")
        || error.contains("password_mismatch")
        || error.contains("invalid")
        || error.contains("schema")
    {
        return false;
    }
    error.contains("gateway_transport_connection_refused")
        || error.contains("gateway_transport_unavailable")
        || error.contains("connection refused")
        || error.contains("connection reset")
        || error.contains("connection closed")
        || error.contains("without closing handshake")
        || error.contains("gateway restarting")
        || error.contains("超时")
        || error.contains("timed out")
}

pub(crate) async fn wait_ready<B: GatewayStartup>(
    b: &B,
    deadline: Instant,
) -> Result<B::Snapshot, String> {
    let start = Instant::now();
    b.phase("gateway_ready_wait", Duration::ZERO, 0);
    let mut polls = 0;
    let mut http_recorded = false;
    loop {
        polls += 1;
        let result = match owned(b, deadline, b.http_ready()).await {
            Err(error) if error == RECOVERED => continue,
            other => other?,
        };
        match result {
            Ok(true) => {
                if !http_recorded {
                    b.phase("http_ready", start.elapsed(), polls);
                    http_recorded = true;
                }
                match owned(b, deadline, b.auth_ready()).await? {
                    Ok(Some(snapshot)) => {
                        b.phase("auth_ready", start.elapsed(), polls);
                        return Ok(snapshot);
                    }
                    Ok(None) => {}
                    Err(error) if transient(&error) => {}
                    Err(error) => return Err(error),
                }
            }
            Ok(false) => {}
            Err(error) if transient(&error) => {}
            Err(error) => return Err(error),
        }
        match owned(b, deadline, sleep(CANCEL_POLL)).await {
            Err(error) if error == RECOVERED => continue,
            other => other?,
        }
    }
}

/// Recover a read-only RPC without resetting the flight's deadline. A failed
/// read must reacquire HTTP and authenticated readiness before another RPC.
async fn read_config<B: GatewayStartup>(b: &B, deadline: Instant) -> Result<Value, String> {
    loop {
        match owned(b, deadline, b.config_get()).await? {
            Ok(snapshot) => {
                safe_config(&snapshot)?;
                require_hash(&snapshot)?;
                return Ok(snapshot);
            }
            Err(error) if transient(&error) => {
                owned(b, deadline, sleep(CANCEL_POLL)).await?;
                wait_ready(b, deadline).await?;
            }
            Err(error) => return Err(error),
        }
    }
}

/// Read S/H, derive D, submit D only with H. Conflicts discard the complete
/// transaction. Confirmed ACKs survive readback/reload failures without replay.
pub async fn finalize<B: GatewayStartup>(b: &B, deadline: Instant) -> Result<B::Snapshot, String> {
    wait_ready(b, deadline).await?;
    let start = Instant::now();
    b.phase("defaults_apply_verify", Duration::ZERO, 0);
    let mut attempts = 0;
    let mut reread = None;
    loop {
        attempts += 1;
        let snapshot = match reread.take() {
            Some(snapshot) => snapshot,
            None => read_config(b, deadline).await?,
        };
        let delta = b.defaults_patch(&snapshot)?;
        if empty(&delta) {
            break;
        }
        b.check()?;
        let explicit_secret = b.contains_explicit_secret(&delta);
        match owned(b, deadline, b.config_patch(&snapshot, delta.clone())).await? {
            Ok(()) => {
                wait_ready(b, deadline).await?;
                let verified = read_config(b, deadline).await?;
                if !delta_verified(safe_config(&verified)?, &delta) {
                    return Err("gateway_startup_defaults_verification_failed".into());
                }
                break;
            }
            Err(error) if crate::services::openclaw_gateway::config_patch_conflict(&error) => {
                // A definite rejection is safe to rebuild, including new secrets.
                owned(b, deadline, sleep(CANCEL_POLL)).await?;
                wait_ready(b, deadline).await?;
            }
            Err(error) if transient(&error) => {
                // Delivery may have succeeded. Observe before deciding whether
                // any new transaction is needed; never replay the old delta.
                wait_ready(b, deadline).await?;
                let observed = read_config(b, deadline).await?;
                if explicit_secret {
                    // Redaction/hash changes/health cannot confirm a secret.
                    // One bounded readonly recovery, then leave retry to a new
                    // user flight; this flight must not replay or connect.
                    let _visible_fields_match = delta_verified(safe_config(&observed)?, &delta);
                    owned(b, deadline, async {}).await?;
                    return Err("startup_config_commit_unconfirmed".into());
                }
                if delta_verified(safe_config(&observed)?, &delta) {
                    break;
                }
                reread = Some(observed);
            }
            Err(error) => return Err(error),
        }
    }
    b.phase("defaults_apply_verify", start.elapsed(), attempts);
    let start = Instant::now();
    b.phase("system_plugins_verify", Duration::ZERO, 0);
    loop {
        match owned(b, deadline, b.verify_plugins()).await? {
            Ok(()) => break,
            Err(error) if transient(&error) => {
                owned(b, deadline, sleep(CANCEL_POLL)).await?;
                wait_ready(b, deadline).await?;
            }
            Err(error) => return Err(error),
        }
    }
    b.phase("system_plugins_verify", start.elapsed(), 1);
    let snapshot = wait_ready(b, deadline).await?;
    owned(b, deadline, b.finalized()).await??;
    Ok(snapshot)
}

pub fn require_hash(snapshot: &Value) -> Result<&str, String> {
    snapshot
        .get("hash")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "gateway_startup_snapshot_hash_missing".into())
}

pub fn safe_config(snapshot: &Value) -> Result<&Value, String> {
    // sourceConfig is the persisted schema, rather than an expanded runtime
    // view. The engine may redact secrets; minimal_delta never replays them.
    ["sourceConfig", "parsed", "config"]
        .iter()
        .find_map(|key| snapshot.get(key).filter(|v| v.is_object()))
        .ok_or_else(|| "gateway_startup_config_snapshot_missing".into())
}

pub fn empty(value: &Value) -> bool {
    value.as_object().is_some_and(Map::is_empty)
}

fn redacted(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|v| v.contains("__OPENCLAW_REDACTED__") || v == "[REDACTED]" || v == "***")
}

/// RFC7396 delta, containing only requested differences. Preserve unknown
/// fields and never copy redaction sentinels from config.get into config.patch.
pub fn minimal_delta(current: &Value, desired: &Value) -> Value {
    // None is a no-op; Some({}) is a real RFC7396 object creation.
    fn difference(current: Option<&Value>, desired: &Value) -> Option<Value> {
        if let Some(object) = desired.as_object() {
            let mut result = Map::new();
            for (key, value) in object {
                if let Some(delta) = difference(current.and_then(|c| c.get(key)), value) {
                    result.insert(key.clone(), delta);
                }
            }
            if !result.is_empty() || (object.is_empty() && !current.is_some_and(Value::is_object)) {
                Some(Value::Object(result))
            } else {
                None
            }
        } else if redacted(desired)
            || current == Some(desired)
            || (desired.is_null() && current.is_none())
            || desired
                .as_array()
                .is_some_and(|v| v.iter().any(contains_redaction))
        {
            None
        } else {
            Some(desired.clone())
        }
    }
    difference(Some(current), desired).unwrap_or_else(|| Value::Object(Map::new()))
}

fn contains_redaction(value: &Value) -> bool {
    redacted(value)
        || value
            .as_array()
            .is_some_and(|a| a.iter().any(contains_redaction))
        || value
            .as_object()
            .is_some_and(|o| o.values().any(contains_redaction))
}
fn secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("token") || k.contains("secret") || k.contains("password") || k == "apikey"
}
fn delta_verified(current: &Value, delta: &Value) -> bool {
    if let Some(object) = delta.as_object() {
        current.is_object()
            && object.iter().all(|(key, value)| {
                secret_key(key) || delta_verified(current.get(key).unwrap_or(&Value::Null), value)
            })
    } else {
        current == delta
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    struct State {
        config: Value,
        revision: usize,
        reads: usize,
        patches: Vec<(usize, Value)>,
        plugins: usize,
        conflicts: bool,
        fail_defaults: bool,
        onboards: usize,
        spawns: usize,
        prepares: usize,
        running: bool,
        authenticated: bool,
        config_failures: usize,
        readback_failures: usize,
        plugin_failures: usize,
        unknown_patch: Option<bool>,
        auth_checks: usize,
    }
    struct Fake {
        began: Instant,
        http_at: Duration,
        auth_at: Duration,
        exit_at: Option<Duration>,
        cancel_at: Option<Duration>,
        hung: &'static str,
        auth_error: Option<&'static str>,
        desired: Value,
        preserve_tools: bool,
        verify_delay: Duration,
        http_fixture: Option<(crate::services::openclaw_gateway::GatewayEndpoint, std::sync::Arc<tokio::sync::Notify>)>,
        http_errors: std::sync::atomic::AtomicUsize,
        recovery: bool,
        replacement_ready: bool,
        recovery_error: Option<&'static str>,
        recoveries: std::sync::atomic::AtomicUsize,
        recovery_full_verifications: std::sync::atomic::AtomicUsize,
        state: Mutex<State>,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                began: Instant::now(),
                http_at: Duration::ZERO,
                auth_at: Duration::ZERO,
                exit_at: None,
                cancel_at: None,
                hung: "",
                auth_error: None,
                desired: json!({"env":{"vars":{"APP":"ready"}}}),
                preserve_tools: false,
                verify_delay: Duration::ZERO,
                http_fixture: None,
                http_errors: std::sync::atomic::AtomicUsize::new(0),
                recovery: false, replacement_ready: true, recovery_error: None,
                recoveries: std::sync::atomic::AtomicUsize::new(0),
                recovery_full_verifications: std::sync::atomic::AtomicUsize::new(0),
                state: Mutex::new(State {
                    config: json!({}),
                    revision: 1,
                    reads: 0,
                    patches: vec![],
                    plugins: 0,
                    conflicts: false,
                    fail_defaults: false,
                    onboards: 0,
                    spawns: 0,
                    prepares: 0,
                    running: true,
                    authenticated: false,
                    config_failures: 0,
                    readback_failures: 0,
                    plugin_failures: 0,
                    unknown_patch: None,
                    auth_checks: 0,
                }),
            }
        }
        fn deadline(&self, secs: u64) -> Instant {
            self.began + Duration::from_secs(secs)
        }
    }
    impl GatewayStartup for Fake {
        type Snapshot = &'static str;
        fn check(&self) -> Result<(), String> {
            if self.cancel_at.is_some_and(|at| self.began.elapsed() >= at) {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        }
        async fn recover_stalled(&self, deadline: Instant) -> Result<bool, String> {
            use crate::services::gateway_startup_progress::{poll_recovery, RecoveryPoll};
            use std::sync::atomic::Ordering::SeqCst;
            struct Poll<'a>(&'a Fake, Instant);
            impl RecoveryPoll for Poll<'_> {
                fn check_identity(&mut self) -> Result<bool, String> {
                    self.0.check()?;
                    Ok(self.0.state.lock().unwrap().running)
                }
                fn eligible(&self) -> bool {
                    self.0.recovery
                        && self.0.began.elapsed() >= Duration::from_secs(360)
                        && self.1.saturating_duration_since(Instant::now()) >= Duration::from_secs(300)
                }
                fn allowance_available(&self) -> bool {
                    self.0.recoveries.load(SeqCst) == 0
                }
                fn verify_runtime_and_config(&self) -> Result<(), String> {
                    self.0.recovery_full_verifications.fetch_add(1, SeqCst);
                    if let Some(error) = self.0.recovery_error {
                        return Err(error.into());
                    }
                    Ok(())
                }
                fn commit(&mut self) -> Result<bool, String> {
                    if self
                        .0
                        .recoveries
                        .compare_exchange(0, 1, SeqCst, SeqCst)
                        .is_err()
                    {
                        return Ok(false);
                    }
                    self.0.state.lock().unwrap().spawns += 1;
                    Ok(true)
                }
            }
            poll_recovery(&mut Poll(self, deadline))
        }
        async fn child_running(&self) -> bool {
            self.state.lock().unwrap().running
                && !self.exit_at.is_some_and(|at| self.began.elapsed() >= at)
        }
        async fn http_ready(&self) -> Result<bool, String> {
            if self.hung == "http" {
                std::future::pending::<()>().await;
            }
            if let Some((endpoint, recovered)) = &self.http_fixture {
                let result = crate::services::openclaw_gateway::http_ready_for_endpoint(endpoint).await;
                if result.is_err() {
                    self.http_errors.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    recovered.notify_one();
                }
                return result;
            }
            if self.recovery { return Ok(self.replacement_ready && self.recoveries.load(std::sync::atomic::Ordering::SeqCst) == 1); }
            Ok(self.began.elapsed() >= self.http_at)
        }
        async fn auth_ready(&self) -> Result<Option<Self::Snapshot>, String> {
            assert!(
                self.began.elapsed() >= self.http_at,
                "WS before HTTP readiness"
            );
            if self.hung == "auth" {
                std::future::pending::<()>().await;
            }
            if let Some(error) = self.auth_error {
                return Err(error.into());
            }
            let ready = self.began.elapsed() >= self.auth_at;
            let mut state = self.state.lock().unwrap();
            state.auth_checks += 1;
            state.authenticated = ready;
            Ok(ready.then_some("connected"))
        }
        async fn config_get(&self) -> Result<Value, String> {
            assert!(
                self.began.elapsed() >= self.http_at && self.began.elapsed() >= self.auth_at,
                "config RPC before authenticated readiness"
            );
            if self.hung == "config" {
                std::future::pending::<()>().await;
            }
            let mut state = self.state.lock().unwrap();
            assert!(
                state.authenticated,
                "RPC before re-authentication after transport failure"
            );
            state.reads += 1;
            if state.config_failures > 0 {
                state.config_failures -= 1;
                state.authenticated = false;
                return Err("gateway_transport_connection_refused".into());
            }
            if !state.patches.is_empty() && state.readback_failures > 0 {
                state.readback_failures -= 1;
                state.authenticated = false;
                return Err("connection reset".into());
            }
            if state.fail_defaults {
                state.fail_defaults = false;
                return Err("defaults_failed_once".into());
            }
            Ok(json!({"hash": state.revision.to_string(), "sourceConfig": state.config}))
        }
        fn defaults_patch(&self, snapshot: &Value) -> Result<Value, String> {
            let config = safe_config(snapshot)?;
            let mut desired = self.desired.clone();
            if self.preserve_tools {
                let mut allowed = config
                    .pointer("/tools/alsoAllow")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if !allowed.contains(&json!("required-tool")) {
                    allowed.push(json!("required-tool"));
                }
                desired["tools"] = json!({"alsoAllow": allowed});
            }
            Ok(minimal_delta(config, &desired))
        }
        async fn config_patch(&self, snapshot: &Value, delta: Value) -> Result<(), String> {
            let mut state = self.state.lock().unwrap();
            let hash: usize = require_hash(snapshot)?.parse().unwrap();
            assert!(state.authenticated);
            state.patches.push((hash, delta.clone()));
            let unknown_patch = state.unknown_patch.take();
            if unknown_patch == Some(false) {
                state.authenticated = false;
                return Err("connection closed".into());
            }
            if state.conflicts {
                state.conflicts = false;
                state.revision += 1;
                state.config = json!({"agents":{"defaults":{"model":{"primary":"custom/model"}}},"models":{"providers":{"user":{"models":[{"id":"added"}]}}},"tools":{"alsoAllow":["user-tool"]},"plugins":{"entries":{"user":{"enabled":true}}},"env":{"vars":{"USER":"keep"}}});
                return Err("config changed since last load".into());
            }
            assert_eq!(
                hash, state.revision,
                "delta submitted with a refreshed, unrelated hash"
            );
            fn merge(target: &mut Value, delta: Value) {
                if let Some(o) = delta.as_object() {
                    if !target.is_object() {
                        *target = json!({});
                    }
                    for (key, value) in o {
                        if value.is_null() {
                            target.as_object_mut().unwrap().remove(key);
                        } else {
                            merge(&mut target[key], value.clone());
                        }
                    }
                } else {
                    *target = delta;
                }
            }
            merge(&mut state.config, delta);
            state.revision += 1;
            // Real config.get redacts secrets. An ACK, rather than comparing
            // these placeholders, is the startup contract for explicit secrets.
            if let Some(vars) = state
                .config
                .pointer_mut("/env/vars")
                .and_then(Value::as_object_mut)
            {
                for (key, value) in vars {
                    if secret_key(key) {
                        *value = json!("__OPENCLAW_REDACTED__");
                    }
                }
            }
            if unknown_patch == Some(true) {
                state.authenticated = false;
                return Err("connection closed".into());
            }
            Ok(())
        }
        fn contains_explicit_secret(&self, delta: &Value) -> bool {
            fn contains(value: &Value) -> bool {
                value.as_object().is_some_and(|object| {
                    object.iter().any(|(key, value)| {
                        (secret_key(key) && value.is_string() && !redacted(value))
                            || contains(value)
                    })
                })
            }
            contains(delta)
        }
        async fn verify_plugins(&self) -> Result<(), String> {
            if self.hung == "plugins" {
                std::future::pending::<()>().await;
            }
            sleep(self.verify_delay).await;
            let mut state = self.state.lock().unwrap();
            assert!(state.authenticated);
            if state.plugin_failures > 0 {
                state.plugin_failures -= 1;
                state.authenticated = false;
                return Err("gateway_transport_unavailable".into());
            }
            state.plugins += 1;
            Ok(())
        }
    }

    impl GatewayActivation for Fake {
        async fn stop_and_reclaim(&self) -> Result<(), String> {
            self.check()?;
            self.state.lock().unwrap().running = false;
            Ok(())
        }
        async fn onboard(&self) -> Result<(), String> {
            self.check()?;
            self.state.lock().unwrap().onboards += 1;
            Ok(())
        }
        async fn prepare_spawn(&self) -> Result<(), String> {
            self.check()?;
            self.state.lock().unwrap().prepares += 1;
            Ok(())
        }
        async fn spawn(&self) -> Result<(), String> {
            self.check()?;
            let mut state = self.state.lock().unwrap();
            state.spawns += 1;
            state.running = true;
            Ok(())
        }
        fn auth_repair_needed(&self, error: &str) -> bool {
            error.contains("password_mismatch")
        }
    }

    // A real socket fault is armed only after defaults and plugins complete.
    // Keep faulting until the production helper returns an error, so a hidden
    // HTTP client retry cannot accidentally satisfy this regression test.
    #[tokio::test]
    async fn http_readiness_final_probe_transport_recovers_without_replaying_ack() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use std::sync::{Arc, atomic::Ordering};
        for fault in ["close", "truncated"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let recovered = Arc::new(tokio::sync::Notify::new());
            let mut fake = Fake::new();
            fake.http_fixture = Some((crate::services::openclaw_gateway::GatewayEndpoint {
                url: format!("ws://{address}"), token: None, password: None, device_token: None,
            }, recovered.clone()));
            let fake = Arc::new(fake);
            let server_fake = fake.clone();
            let server = tokio::spawn(async move {
                let mut fault_observed = false;
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut buffer = [0; 4096];
                    socket.read(&mut buffer).await.unwrap();
                    let final_probe = server_fake.state.lock().unwrap().plugins > 0;
                    if final_probe && !fault_observed {
                        if fault == "truncated" {
                            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"ready\":").await.unwrap();
                        }
                        drop(socket);
                        // Wait for the helper's result, while still accepting
                        // any transparent retry and giving it the same fault.
                        tokio::select! {
                            _ = recovered.notified() => fault_observed = true,
                            _ = tokio::task::yield_now() => {}
                        }
                    } else {
                        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"ready\":true}").await.unwrap();
                    }
                    if server_fake.http_errors.load(Ordering::SeqCst) > 0 {
                        fault_observed = true;
                    }
                }
            });
            let result = tokio::time::timeout(Duration::from_secs(5), start(fake.as_ref(), false, false, Duration::from_secs(3))).await.unwrap().unwrap();
            assert_eq!(result.snapshot, "connected");
            assert!(fake.http_errors.load(Ordering::SeqCst) > 0, "fault must cross production helper");
            let state = fake.state.lock().unwrap();
            assert_eq!(state.spawns, 1);
            assert_eq!(state.patches.len(), 1);
            assert_eq!(state.plugins, 1);
            server.abort();
        }
    }

    #[tokio::test]
    async fn http_readiness_continuous_fault_obeys_original_deadline_cancel_and_exit() {
        use tokio::io::AsyncReadExt;
        for ending in ["deadline", "cancel", "exit"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut buffer = [0; 4096];
                    let _ = socket.read(&mut buffer).await;
                    // EOF before response headers, on every request.
                }
            });
            let mut fake = Fake::new();
            fake.http_fixture = Some((crate::services::openclaw_gateway::GatewayEndpoint {
                url: format!("ws://{address}"), token: None, password: None, device_token: None,
            }, std::sync::Arc::new(tokio::sync::Notify::new())));
            if ending == "cancel" { fake.cancel_at = Some(Duration::from_millis(100)); }
            if ending == "exit" { fake.exit_at = Some(Duration::from_millis(100)); }
            let error = start(&fake, false, false, Duration::from_millis(700)).await.err().unwrap();
            assert_eq!(error, match ending {
                "cancel" => "cancelled", "exit" => CHILD_EXIT_ERROR, _ => DEADLINE_ERROR,
            });
            assert!(fake.http_errors.load(std::sync::atomic::Ordering::SeqCst) > 0);
            assert!(fake.began.elapsed() < Duration::from_secs(2));
            let state = fake.state.lock().unwrap();
            assert_eq!(state.spawns, 1);
            assert!(state.patches.is_empty());
            server.abort();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn cold_start_waits_300_seconds_before_any_config_and_finishes_connected() {
        let mut fake = Fake::new();
        fake.http_at = Duration::from_secs(300);
        fake.auth_at = Duration::from_secs(301);
        let fake = std::sync::Arc::new(fake);
        let running = {
            let fake = fake.clone();
            tokio::spawn(async move {
                start(fake.as_ref(), false, false, Duration::from_secs(900))
                    .await
                    .map(|r| r.snapshot)
            })
        };
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(299)).await;
        {
            let state = fake.state.lock().unwrap();
            assert_eq!(state.reads, 0, "no config RPC before ready");
            assert_eq!((state.onboards, state.spawns), (1, 1));
        }
        assert_eq!(running.await.unwrap().unwrap(), "connected");
        let state = fake.state.lock().unwrap();
        assert_eq!(state.onboards, 1);
        assert_eq!(state.spawns, 1);
        assert_eq!(state.patches.len(), 1);
        assert_eq!(state.plugins, 1);
        assert!(fake.began.elapsed() >= Duration::from_secs(301));
        assert!(fake.began.elapsed() < Duration::from_millis(301_500));
    }

    #[tokio::test(start_paused = true)]
    async fn same_profile_callers_share_one_complete_activation() {
        use crate::services::startup_coordinator::StartupCoordinator;
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let coordinator = Arc::new(StartupCoordinator::<&'static str>::default());
        let mut fake = Fake::new();
        fake.http_at = Duration::from_secs(300);
        let fake = Arc::new(fake);
        let activations = Arc::new(AtomicUsize::new(0));
        let mut callers = Vec::new();
        for _ in 0..8 {
            let coordinator = coordinator.clone();
            let fake = fake.clone();
            let activations = activations.clone();
            callers.push(tokio::spawn(async move {
                coordinator
                    .run_profile("profile-a", move |_| async move {
                        activations.fetch_add(1, Ordering::SeqCst);
                        start(fake.as_ref(), false, false, Duration::from_secs(900))
                            .await
                            .map(|r| r.snapshot)
                    })
                    .await
            }));
        }
        for caller in callers {
            assert_eq!(caller.await.unwrap().unwrap(), "connected");
        }
        assert_eq!(activations.load(Ordering::SeqCst), 1);
        assert_eq!(coordinator.metrics().leaders, 1);
        assert_eq!(fake.state.lock().unwrap().patches.len(), 1);
        assert_eq!(fake.state.lock().unwrap().plugins, 1);
        assert_eq!(fake.state.lock().unwrap().onboards, 1);
        assert_eq!(fake.state.lock().unwrap().spawns, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn shared_deadline_bounds_http_auth_hung_probes_and_phase_switches() {
        for phase in ["http", "auth", "config", "plugins"] {
            let mut fake = Fake::new();
            fake.hung = phase;
            assert_eq!(
                finalize(&fake, fake.deadline(3)).await.unwrap_err(),
                DEADLINE_ERROR
            );
            assert_eq!(fake.began.elapsed(), Duration::from_secs(3));
        }
        let mut fake = Fake::new();
        fake.http_at = Duration::from_secs(2);
        fake.auth_at = Duration::from_millis(2750);
        fake.verify_delay = Duration::from_secs(1);
        assert_eq!(
            start(&fake, true, true, Duration::from_secs(3))
                .await
                .err()
                .unwrap(),
            DEADLINE_ERROR
        );
        assert_eq!(fake.began.elapsed(), Duration::from_secs(3));
        for (http_at, auth_at) in [(4, 0), (0, 4)] {
            let mut fake = Fake::new();
            fake.http_at = Duration::from_secs(http_at);
            fake.auth_at = Duration::from_secs(auth_at);
            assert_eq!(
                finalize(&fake, fake.deadline(3)).await.unwrap_err(),
                DEADLINE_ERROR
            );
            assert_eq!(fake.state.lock().unwrap().reads, 0);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_and_child_exit_drop_hung_work_without_later_mutations() {
        for phase in ["http", "auth", "config", "plugins"] {
            for cancel in [false, true] {
                let mut fake = Fake::new();
                fake.hung = phase;
                if cancel {
                    fake.cancel_at = Some(Duration::from_millis(600));
                } else {
                    fake.exit_at = Some(Duration::from_millis(600));
                }
                let error = finalize(&fake, fake.deadline(900)).await.unwrap_err();
                assert_eq!(
                    error,
                    if cancel {
                        "cancelled"
                    } else {
                        CHILD_EXIT_ERROR
                    }
                );
                assert!(fake.began.elapsed() <= Duration::from_millis(850));
                let state = fake.state.lock().unwrap();
                assert_eq!(state.plugins, 0);
                if phase != "plugins" {
                    assert_eq!(state.patches.len(), 0);
                }
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn conflict_rebuilds_delta_and_preserves_concurrent_user_configuration() {
        let mut fake = Fake::new();
        fake.preserve_tools = true;
        fake.state.lock().unwrap().conflicts = true;
        finalize(&fake, fake.deadline(900)).await.unwrap();
        let state = fake.state.lock().unwrap();
        assert_eq!(
            state
                .patches
                .iter()
                .map(|(hash, _)| *hash)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(state.config.pointer("/env/vars/USER"), Some(&json!("keep")));
        assert_eq!(
            state.config.pointer("/agents/defaults/model/primary"),
            Some(&json!("custom/model"))
        );
        assert_eq!(
            state.config.pointer("/tools/alsoAllow"),
            Some(&json!(["user-tool", "required-tool"]))
        );
        assert_eq!(
            state.config.pointer("/plugins/entries/user/enabled"),
            Some(&json!(true))
        );
        assert_eq!(
            state.config.pointer("/models/providers/user/models/0/id"),
            Some(&json!("added"))
        );
        assert_eq!(
            state.patches[1].1,
            json!({"env":{"vars":{"APP":"ready"}},"tools":{"alsoAllow":["user-tool","required-tool"]}})
        );
        assert_ne!(
            state.patches[0].1, state.patches[1].1,
            "conflict must rebuild the delta, not refresh its hash"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn retry_after_defaults_failure_reuses_child_and_runs_all_postconditions() {
        let fake = Fake::new();
        fake.state.lock().unwrap().fail_defaults = true;
        assert_eq!(
            start(&fake, false, false, Duration::from_secs(900))
                .await
                .err()
                .unwrap(),
            "defaults_failed_once"
        );
        assert_eq!(
            start(&fake, true, true, Duration::from_secs(900))
                .await
                .unwrap()
                .snapshot,
            "connected"
        );
        assert_eq!(fake.state.lock().unwrap().plugins, 1);
        assert_eq!(fake.state.lock().unwrap().onboards, 1);
        assert_eq!(fake.state.lock().unwrap().spawns, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn warm_consistent_config_has_zero_patches_and_secret_update_has_exact_delta() {
        let mut fake = Fake::new();
        fake.state.lock().unwrap().config = fake.desired.clone();
        finalize(&fake, fake.deadline(900)).await.unwrap();
        assert_eq!(fake.state.lock().unwrap().patches.len(), 0);
        fake.state.lock().unwrap().config["env"]["vars"]["USER_TOKEN"] =
            json!("__OPENCLAW_REDACTED__");
        fake.desired["env"]["vars"]["USER_TOKEN"] = json!("explicit-new-secret");
        finalize(&fake, fake.deadline(900)).await.unwrap();
        let state = fake.state.lock().unwrap();
        assert_eq!(
            state.patches[0].1,
            json!({"env":{"vars":{"USER_TOKEN":"explicit-new-secret"}}})
        );
        assert!(!state.patches[0].1.to_string().contains("REDACTED"));
    }

    #[tokio::test(start_paused = true)]
    async fn authentication_and_schema_fail_immediately_without_config_mutation() {
        for error in [
            "unauthorized password_mismatch",
            "invalid schema",
            "gateway request rejected",
        ] {
            let mut fake = Fake::new();
            fake.auth_error = Some(error);
            assert_eq!(
                finalize(&fake, fake.deadline(900)).await.unwrap_err(),
                error
            );
            assert_eq!(fake.began.elapsed(), Duration::ZERO);
            assert_eq!(fake.state.lock().unwrap().reads, 0);
        }
    }

    #[test]
    fn missing_empty_model_allowlist_object_is_added_then_noop() {
        let target = json!({"models":{"new/model":{}}});
        assert_eq!(minimal_delta(&json!({}), &target), target);
        assert_eq!(minimal_delta(&target, &target), json!({}));
        assert!(!delta_verified(&json!({}), &target));
    }

    #[tokio::test(start_paused = true)]
    async fn initialized_child_uses_shared_activation_without_onboard_or_spawn() {
        let mut fake = Fake::new();
        fake.http_at = Duration::from_secs(300);
        assert_eq!(
            start(&fake, true, true, Duration::from_secs(900))
                .await
                .unwrap()
                .snapshot,
            "connected"
        );
        let state = fake.state.lock().unwrap();
        assert_eq!((state.onboards, state.prepares, state.spawns), (0, 0, 0));
        assert_eq!(state.plugins, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn transient_reads_and_plugin_verification_reauthenticate_without_repatching() {
        for phase in ["initial_read", "readback", "plugins"] {
            let fake = Fake::new();
            {
                let mut state = fake.state.lock().unwrap();
                match phase {
                    "initial_read" => state.config_failures = 2,
                    "readback" => state.readback_failures = 3,
                    _ => state.plugin_failures = 2,
                }
            }
            assert_eq!(
                finalize(&fake, fake.deadline(900)).await.unwrap(),
                "connected"
            );
            let state = fake.state.lock().unwrap();
            assert_eq!(
                state.patches.len(),
                1,
                "confirmed ACK must not be replayed after {phase} failure"
            );
            assert!(state.auth_checks >= 4);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn unknown_nonsecret_commit_observes_then_rebuilds_only_if_needed() {
        for applied in [true, false] {
            let fake = Fake::new();
            {
                let mut state = fake.state.lock().unwrap();
                state.unknown_patch = Some(applied);
                state.config = json!({"env":{"vars":{"OLD_TOKEN":"__OPENCLAW_REDACTED__"}}});
            }
            assert_eq!(
                finalize(&fake, fake.deadline(900)).await.unwrap(),
                "connected"
            );
            let state = fake.state.lock().unwrap();
            assert_eq!(state.patches.len(), if applied { 1 } else { 2 });
            assert_eq!(state.config.pointer("/env/vars/APP"), Some(&json!("ready")));
            assert!(state.reads >= 2);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn unknown_explicit_secret_commit_is_never_replayed_or_reported_connected() {
        for applied in [true, false] {
            let mut fake = Fake::new();
            fake.desired =
                json!({"env":{"vars":{"IMAI_CLOUD_AGENT_AUTH_TOKEN":"explicit-new-secret"}}});
            fake.state.lock().unwrap().unknown_patch = Some(applied);
            assert_eq!(
                finalize(&fake, fake.deadline(900)).await.unwrap_err(),
                "startup_config_commit_unconfirmed"
            );
            let state = fake.state.lock().unwrap();
            assert_eq!(state.patches.len(), 1);
            assert_eq!(state.plugins, 0);
            assert!(state.reads >= 2);
            assert_eq!(state.patches[0].1, fake.desired);
            assert!(!state.patches[0].1.to_string().contains("REDACTED"));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn transient_recovery_respects_deadline_cancellation_and_child_exit() {
        for ending in ["deadline", "cancel", "exit"] {
            let mut fake = Fake::new();
            fake.state.lock().unwrap().readback_failures = usize::MAX;
            if ending == "cancel" {
                fake.cancel_at = Some(Duration::from_millis(600));
            }
            if ending == "exit" {
                fake.exit_at = Some(Duration::from_millis(600));
            }
            let error = finalize(&fake, fake.deadline(2)).await.unwrap_err();
            assert_eq!(
                error,
                match ending {
                    "cancel" => "cancelled",
                    "exit" => CHILD_EXIT_ERROR,
                    _ => DEADLINE_ERROR,
                }
            );
            let state = fake.state.lock().unwrap();
            assert_eq!(state.patches.len(), 1);
            assert_eq!(state.plugins, 0);
            assert!(
                fake.began.elapsed()
                    <= if ending == "deadline" {
                        Duration::from_secs(2)
                    } else {
                        Duration::from_millis(850)
                    }
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn ordinary_recovery_polling_never_runs_full_runtime_verification() {
        let mut fake = Fake::new();
        fake.recovery = true;
        owned(&fake, fake.deadline(900), sleep(Duration::from_secs(359)))
            .await
            .unwrap();
        assert_eq!(
            fake.recovery_full_verifications
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(fake.state.lock().unwrap().spawns, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_initial_child_recovers_once_and_repeats_full_postconditions() {
        let mut fake = Fake::new();
        fake.recovery = true;
        let result = start(&fake, true, true, Duration::from_secs(900))
            .await
            .unwrap();
        assert_eq!(result.snapshot, "connected");
        let state = fake.state.lock().unwrap();
        assert_eq!(state.spawns, 1);
        assert_eq!(state.prepares, 0);
        assert_eq!(state.onboards, 0);
        assert_eq!(state.plugins, 1);
        assert_eq!(state.patches.len(), 1);
        assert!(fake.began.elapsed() >= Duration::from_secs(360));
        assert_eq!(
            fake.recovery_full_verifications
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }
    #[tokio::test(start_paused = true)]
    async fn stalled_replacement_never_gets_a_third_spawn_or_new_deadline() {
        let mut fake = Fake::new();
        fake.recovery = true;
        fake.replacement_ready = false;
        assert_eq!(
            start(&fake, true, true, Duration::from_secs(900))
                .await
                .err()
                .unwrap(),
            DEADLINE_ERROR
        );
        assert_eq!(fake.state.lock().unwrap().spawns, 1);
        assert_eq!(fake.began.elapsed(), Duration::from_secs(900));
        assert_eq!(
            start(&fake, true, true, Duration::from_secs(900))
                .await
                .err()
                .unwrap(),
            DEADLINE_ERROR
        );
        assert_eq!(fake.state.lock().unwrap().spawns, 1);
        assert_eq!(
            fake.recovery_full_verifications
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[tokio::test(start_paused = true)]
    async fn uncertain_termination_wrong_identity_and_cancellation_never_spawn_replacement() {
        for error in [
            "gateway_startup_termination_unconfirmed",
            "gateway_startup_identity_changed",
            "cancelled",
        ] {
            let mut fake = Fake::new();
            fake.recovery = true;
            fake.recovery_error = Some(error);
            if error == "cancelled" {
                fake.cancel_at = Some(Duration::from_secs(360));
            }
            assert_eq!(
                start(&fake, true, true, Duration::from_secs(900))
                    .await
                    .err()
                    .unwrap(),
                error
            );
            let state = fake.state.lock().unwrap();
            assert_eq!(state.spawns, 0);
            assert_eq!(state.prepares, 0);
            assert_eq!(state.onboards, 0);
            assert_eq!(state.plugins, 0);
        }
    }
    #[test]
    fn unsafe_snapshots_fail_and_redacted_values_never_enter_delta() {
        assert!(safe_config(&json!({"hash":"a"})).is_err());
        assert!(require_hash(&json!({"sourceConfig":{}})).is_err());
        assert_eq!(
            minimal_delta(
                &json!({}),
                &json!({"env":{"vars":{"TOKEN":"__OPENCLAW_REDACTED__"}},"array":["***"]})
            ),
            json!({})
        );
    }
}
