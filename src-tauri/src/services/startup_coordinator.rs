use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

const SUPERSEDED_STARTUP_ERROR: &str = "startup_superseded_by_newer_intent";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct StartupKey {
    profile: String,
    generation: u64,
}

impl StartupKey {
    pub fn new(profile: impl Into<String>, generation: u64) -> Self {
        Self {
            profile: profile.into(),
            generation,
        }
    }
}

struct StartupFlight<T> {
    result: Mutex<Option<Result<T, String>>>,
    cancelled: Arc<AtomicBool>,
    joined: Arc<AtomicU64>,
    finished: tokio::sync::Notify,
}

impl<T> Default for StartupFlight<T> {
    fn default() -> Self {
        Self {
            result: Mutex::new(None),
            cancelled: Arc::new(AtomicBool::new(false)),
            joined: Arc::new(AtomicU64::new(0)),
            finished: tokio::sync::Notify::new(),
        }
    }
}

impl<T: Clone> StartupFlight<T> {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    async fn result(&self) -> Result<T, String> {
        loop {
            let finished = self.finished.notified();
            if let Some(result) = self
                .result
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
            {
                return result;
            }
            finished.await;
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StartupCoordinatorMetrics {
    pub leaders: u64,
    pub followers: u64,
    pub joined: u64,
    pub suppressed: u64,
    pub superseded: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StartupFlightMetrics {
    pub leaders: u64,
    pub followers: u64,
    pub joined: u64,
    pub suppressed: u64,
    pub superseded: u64,
}

#[derive(Default)]
struct StartupCoordinatorCounters {
    leaders: AtomicU64,
    followers: AtomicU64,
    joined: AtomicU64,
    suppressed: AtomicU64,
    superseded: AtomicU64,
}

#[derive(Clone)]
pub struct StartupFlightContext {
    joined: Arc<AtomicU64>,
    cancelled: Arc<AtomicBool>,
    generation: u64,
}

impl StartupFlightContext {
    pub fn joined_count(&self) -> u64 {
        self.joined.load(Ordering::SeqCst)
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn checkpoint(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err(SUPERSEDED_STARTUP_ERROR.to_string())
        } else {
            Ok(())
        }
    }
}

struct StartupCoordinatorState<T> {
    flights: HashMap<StartupKey, Arc<StartupFlight<T>>>,
    latest: Option<StartupKey>,
    next_generation: u64,
}

impl<T> Default for StartupCoordinatorState<T> {
    fn default() -> Self {
        Self {
            flights: HashMap::new(),
            latest: None,
            next_generation: 0,
        }
    }
}

/// App-owned coordinator for the complete inspect/repair/spawn startup flow.
/// Calls for the same profile generation share one result, while the execution
/// gate preserves the one-active-Gateway invariant across different profiles.
pub struct StartupCoordinator<T> {
    state: Arc<tokio::sync::Mutex<StartupCoordinatorState<T>>>,
    execution: Arc<tokio::sync::Mutex<()>>,
    counters: Arc<StartupCoordinatorCounters>,
}

pub type GatewayStartupCoordinator =
    StartupCoordinator<crate::services::openclaw_connection::GatewayConnectionSnapshot>;

impl<T> Default for StartupCoordinator<T> {
    fn default() -> Self {
        Self {
            state: Arc::new(tokio::sync::Mutex::new(StartupCoordinatorState::default())),
            execution: Arc::new(tokio::sync::Mutex::new(())),
            counters: Arc::new(StartupCoordinatorCounters::default()),
        }
    }
}

impl<T: Clone + Send + 'static> StartupCoordinator<T> {
    pub fn metrics(&self) -> StartupCoordinatorMetrics {
        StartupCoordinatorMetrics {
            leaders: self.counters.leaders.load(Ordering::SeqCst),
            followers: self.counters.followers.load(Ordering::SeqCst),
            joined: self.counters.joined.load(Ordering::SeqCst),
            suppressed: self.counters.suppressed.load(Ordering::SeqCst),
            superseded: self.counters.superseded.load(Ordering::SeqCst),
        }
    }

    pub async fn invalidate<Registered>(&self, registered: Registered)
    where
        Registered: FnOnce(u64),
    {
        let mut state = self.state.lock().await;
        state.next_generation = state.next_generation.saturating_add(1);
        if let Some(stale) = state.latest.as_ref().and_then(|key| state.flights.get(key)) {
            stale.cancel();
            self.counters.superseded.fetch_add(1, Ordering::SeqCst);
        }
        state.latest = None;
        registered(state.next_generation);
    }

    pub async fn invalidate_and_lock<Registered>(
        &self,
        registered: Registered,
    ) -> tokio::sync::OwnedMutexGuard<()>
    where
        Registered: FnOnce(u64),
    {
        self.invalidate(registered).await;
        self.execution.clone().lock_owned().await
    }

    #[cfg(test)]
    async fn run<F, Fut>(&self, key: StartupKey, operation: F) -> Result<T, String>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
    {
        self.run_profile(key.profile, move |_| operation()).await
    }

    pub async fn run_profile<F, Fut>(&self, profile: impl Into<String>, operation: F) -> Result<T, String>
    where
        F: FnOnce(StartupFlightContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
    {
        self.run_profile_with_finalizer(profile, operation, |_, _| {}).await
    }

    pub async fn run_profile_with_finalizer<F, Fut, Finalize>(
        &self,
        profile: impl Into<String>,
        operation: F,
        finalizer: Finalize,
    ) -> Result<T, String>
    where
        F: FnOnce(StartupFlightContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
        Finalize: FnOnce(&Result<T, String>, StartupFlightMetrics) + Send + 'static,
    {
        self.run_profile_with_hooks(profile, |_| {}, operation, finalizer)
            .await
    }

    pub async fn run_profile_with_hooks<F, Fut, Registered, Finalize>(
        &self,
        profile: impl Into<String>,
        registered: Registered,
        operation: F,
        finalizer: Finalize,
    ) -> Result<T, String>
    where
        F: FnOnce(StartupFlightContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
        Registered: FnOnce(u64) + Send + 'static,
        Finalize: FnOnce(&Result<T, String>, StartupFlightMetrics) + Send + 'static,
    {
        self.run_profile_with_preparation_hooks(
            profile,
            registered,
            |_| async { Ok(()) },
            operation,
            finalizer,
        )
        .await
    }

    pub async fn run_profile_with_preparation<Prepare, PrepareFut, F, Fut>(
        &self,
        profile: impl Into<String>,
        preparation: Prepare,
        operation: F,
    ) -> Result<T, String>
    where
        Prepare: FnOnce(StartupFlightContext) -> PrepareFut + Send + 'static,
        PrepareFut: Future<Output = Result<(), String>> + Send + 'static,
        F: FnOnce(StartupFlightContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
    {
        self.run_profile_with_preparation_hooks(
            profile,
            |_| {},
            preparation,
            operation,
            |_, _| {},
        )
        .await
    }

    pub async fn run_profile_with_preparation_hooks<
        Prepare,
        PrepareFut,
        F,
        Fut,
        Registered,
        Finalize,
    >(
        &self,
        profile: impl Into<String>,
        registered: Registered,
        preparation: Prepare,
        operation: F,
        finalizer: Finalize,
    ) -> Result<T, String>
    where
        Prepare: FnOnce(StartupFlightContext) -> PrepareFut + Send + 'static,
        PrepareFut: Future<Output = Result<(), String>> + Send + 'static,
        F: FnOnce(StartupFlightContext) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
        Registered: FnOnce(u64) + Send + 'static,
        Finalize: FnOnce(&Result<T, String>, StartupFlightMetrics) + Send + 'static,
    {
        let profile = profile.into();
        let mut registered = Some(registered);
        let (key, flight, leader) = {
            let mut state = self.state.lock().await;
            let joined = state
                .latest
                .as_ref()
                .filter(|key| key.profile == profile)
                .and_then(|key| state.flights.get(key).map(|flight| (key.clone(), flight.clone())));
            match joined {
                Some((key, flight)) => {
                    flight.joined.fetch_add(1, Ordering::SeqCst);
                    self.counters.followers.fetch_add(1, Ordering::SeqCst);
                    self.counters.joined.fetch_add(1, Ordering::SeqCst);
                    self.counters.suppressed.fetch_add(1, Ordering::SeqCst);
                    (key, flight, false)
                }
                None => {
                    let flight = Arc::new(StartupFlight::default());
                    state.next_generation = state.next_generation.saturating_add(1);
                    let key = StartupKey::new(profile, state.next_generation);
                    if let Some(stale) = state.latest.as_ref().and_then(|key| state.flights.get(key)) {
                        stale.cancel();
                        self.counters.superseded.fetch_add(1, Ordering::SeqCst);
                    }
                    state.latest = Some(key.clone());
                    state.flights.insert(key.clone(), flight.clone());
                    if let Some(registered) = registered.take() {
                        registered(key.generation);
                    }
                    self.counters.leaders.fetch_add(1, Ordering::SeqCst);
                    (key, flight, true)
                }
            }
        };

        if !leader {
            return flight.result().await;
        }

        let execution = self.execution.clone();
        let context = StartupFlightContext {
            joined: flight.joined.clone(),
            cancelled: flight.cancelled.clone(),
            generation: key.generation,
        };
        let operation_task = tokio::spawn(async move {
            preparation(context.clone()).await?;
            context.checkpoint()?;
            let _execution_guard = execution.lock().await;
            context.checkpoint()?;
            operation(context).await
        });
        let driver_flight = flight.clone();
        let driver_state = self.state.clone();
        tokio::spawn(async move {
            let mut result = match operation_task.await {
                Ok(result) => result,
                Err(error) => Err(format!("startup_driver_failed: {error}")),
            };
            let mut state = driver_state.lock().await;
            let is_latest = state
                    .flights
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &driver_flight))
                    && state.latest.as_ref() == Some(&key);
            let superseded = !is_latest || driver_flight.cancelled.load(Ordering::SeqCst);
            if superseded {
                result = Err(SUPERSEDED_STARTUP_ERROR.to_string());
            }
            let joined = driver_flight.joined.load(Ordering::SeqCst);
            let activity = StartupFlightMetrics {
                leaders: 1,
                followers: joined,
                joined,
                suppressed: joined,
                superseded: u64::from(superseded),
            };
            let finalized = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                finalizer(&result, activity);
            }));
            if finalized.is_err() {
                result = Err("startup_finalizer_failed".to_string());
            }
            *driver_flight
                .result
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(result);
            if state
                .flights
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &driver_flight))
            {
                state.flights.remove(&key);
            }
            drop(state);
            driver_flight.finished.notify_waiters();
        });

        flight.result().await
    }
}

#[cfg(test)]
mod tests {
    use super::{StartupCoordinator, StartupKey, SUPERSEDED_STARTUP_ERROR};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn concurrent_callers_share_one_startup_sequence_and_result() {
        let coordinator = Arc::new(StartupCoordinator::<&'static str>::default());
        let key = StartupKey::new("profile-a", 7);
        let inspections = Arc::new(AtomicUsize::new(0));
        let repairs = Arc::new(AtomicUsize::new(0));
        let spawns = Arc::new(AtomicUsize::new(0));
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();

        let leader = {
            let coordinator = coordinator.clone();
            let key = key.clone();
            let inspections = inspections.clone();
            let repairs = repairs.clone();
            let spawns = spawns.clone();
            tokio::spawn(async move {
                coordinator
                    .run(key, || async move {
                        inspections.fetch_add(1, Ordering::SeqCst);
                        repairs.fetch_add(1, Ordering::SeqCst);
                        spawns.fetch_add(1, Ordering::SeqCst);
                        let _ = entered_tx.send(());
                        let _ = release_rx.await;
                        Ok("connected")
                    })
                    .await
            })
        };
        entered_rx.await.expect("leader entered startup sequence");

        let joined = (0..2)
            .map(|_| {
                let coordinator = coordinator.clone();
                let key = key.clone();
                let inspections = inspections.clone();
                let repairs = repairs.clone();
                let spawns = spawns.clone();
                tokio::spawn(async move {
                    coordinator
                        .run(key, || async move {
                            inspections.fetch_add(1, Ordering::SeqCst);
                            repairs.fetch_add(1, Ordering::SeqCst);
                            spawns.fetch_add(1, Ordering::SeqCst);
                            Ok("duplicate")
                        })
                        .await
                })
            })
            .collect::<Vec<_>>();
        tokio::task::yield_now().await;
        assert_eq!(inspections.load(Ordering::SeqCst), 1);
        assert_eq!(repairs.load(Ordering::SeqCst), 1);
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        let metrics = coordinator.metrics();
        assert_eq!(metrics.leaders, 1);
        assert_eq!(metrics.followers, 2);
        assert_eq!(metrics.joined, 2);
        assert_eq!(metrics.suppressed, 2);
        let _ = release_tx.send(());

        assert_eq!(leader.await.expect("leader task"), Ok("connected"));
        for caller in joined {
            assert_eq!(caller.await.expect("joined task"), Ok("connected"));
        }
        assert_eq!(inspections.load(Ordering::SeqCst), 1);
        assert_eq!(repairs.load(Ordering::SeqCst), 1);
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_flight_is_removed_so_explicit_retry_runs_fresh_operation() {
        let coordinator = StartupCoordinator::<&'static str>::default();
        let key = StartupKey::new("profile-a", 11);
        let attempts = Arc::new(AtomicUsize::new(0));

        let first_attempts = attempts.clone();
        let first = coordinator
            .run(key.clone(), move || async move {
                first_attempts.fetch_add(1, Ordering::SeqCst);
                Err("runtime activation failed".to_string())
            })
            .await;
        let retry_attempts = attempts.clone();
        let retry = coordinator
            .run(key, move || async move {
                retry_attempts.fetch_add(1, Ordering::SeqCst);
                Ok("connected")
            })
            .await;

        assert_eq!(first, Err("runtime activation failed".to_string()));
        assert_eq!(retry, Ok("connected"));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn aborting_leader_caller_does_not_strand_followers_and_retry() {
        let coordinator = Arc::new(StartupCoordinator::<&'static str>::default());
        let key = StartupKey::new("profile-a", 12);
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();

        let leader = {
            let coordinator = coordinator.clone();
            let key = key.clone();
            tokio::spawn(async move {
                coordinator
                    .run(key, || async move {
                        let _ = entered_tx.send(());
                        let _ = release_rx.await;
                        Err("stable startup failure".to_string())
                    })
                    .await
            })
        };
        entered_rx.await.expect("driver entered operation");
        leader.abort();

        let follower = {
            let coordinator = coordinator.clone();
            let key = key.clone();
            tokio::spawn(async move {
                coordinator
                    .run(key, || async { Ok("duplicate") })
                    .await
            })
        };
        let _ = release_tx.send(());
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), follower)
                .await
                .expect("follower must not hang")
                .expect("follower task"),
            Err("stable startup failure".to_string())
        );
        assert_eq!(
            coordinator
                .run(key, || async { Ok("retried") })
                .await,
            Ok("retried")
        );
    }

    #[tokio::test]
    async fn panicking_operation_publishes_error_and_removes_flight() {
        let coordinator = StartupCoordinator::<&'static str>::default();
        let key = StartupKey::new("profile-a", 13);

        let failure = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            coordinator.run(key.clone(), || async {
                panic!("fixture panic");
            }),
        )
        .await
        .expect("panic is converted into a stable result");
        assert!(failure
            .expect_err("panic must not become success")
            .contains("startup_driver_failed"));
        assert_eq!(
            coordinator
                .run(key, || async { Ok("retried") })
                .await,
            Ok("retried")
        );
    }

    #[tokio::test]
    async fn different_targets_never_execute_startup_mutations_in_parallel() {
        let coordinator = Arc::new(StartupCoordinator::<()>::default());
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));

        let tasks = ["profile-a", "profile-b"].map(|profile| {
            let coordinator = coordinator.clone();
            let active = active.clone();
            let max_active = max_active.clone();
            tokio::spawn(async move {
                coordinator
                    .run(StartupKey::new(profile, 3), || async move {
                        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                        max_active.fetch_max(current, Ordering::SeqCst);
                        tokio::task::yield_now().await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .await
            })
        });

        let mut completed = 0;
        let mut superseded = 0;
        for task in tasks {
            match task.await.expect("startup task") {
                Ok(()) => completed += 1,
                Err(error) if error == SUPERSEDED_STARTUP_ERROR => superseded += 1,
                result => panic!("unexpected startup result: {result:?}"),
            }
        }
        assert_eq!(completed, 1);
        assert_eq!(superseded, 1);
        assert_eq!(max_active.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn blocking_runtime_finishes_then_lower_generation_is_suppressed() {
        let coordinator = Arc::new(StartupCoordinator::<&'static str>::default());
        let lock = Arc::new(std::sync::Mutex::new(()));
        let held = lock.lock().expect("fixture lock");
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();

        let stale = {
            let coordinator = coordinator.clone();
            let lock = lock.clone();
            tokio::spawn(async move {
                coordinator
                    .run_profile("profile-a", move |flight| async move {
                        assert_eq!(flight.generation(), 1);
                        let _ = entered_tx.send(());
                        tokio::task::spawn_blocking(move || {
                            drop(lock.lock().expect("runtime lock"));
                        })
                        .await
                        .expect("blocking runtime");
                        Ok("stale-connected")
                    })
                    .await
            })
        };
        entered_rx.await.expect("stale runtime entered");

        let latest = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .run_profile("profile-b", |flight| async move {
                        assert_eq!(flight.generation(), 2);
                        Ok("latest-connected")
                    })
                    .await
            })
        };
        drop(held);

        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), latest)
                .await
                .expect("latest is not permanently blocked")
                .expect("latest task"),
            Ok("latest-connected")
        );
        assert_eq!(
            stale.await.expect("stale task"),
            Err(SUPERSEDED_STARTUP_ERROR.to_string())
        );
    }

    #[tokio::test]
    async fn finalizer_snapshots_late_join_before_publishing_result() {
        let coordinator = Arc::new(StartupCoordinator::<&'static str>::default());
        let observed = Arc::new(std::sync::Mutex::new(None));
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();

        let leader = {
            let coordinator = coordinator.clone();
            let observed = observed.clone();
            tokio::spawn(async move {
                coordinator
                    .run_profile_with_finalizer(
                        "profile-a",
                        move |_| async move {
                            let _ = entered_tx.send(());
                            let _ = release_rx.await;
                            Ok("connected")
                        },
                        move |result, activity| {
                            *observed.lock().expect("observed") =
                                Some((result.clone(), activity));
                        },
                    )
                    .await
            })
        };
        entered_rx.await.expect("leader entered");
        let follower = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .run_profile("profile-a", |_| async { Ok("duplicate") })
                    .await
            })
        };
        tokio::task::yield_now().await;
        let _ = release_tx.send(());
        assert_eq!(leader.await.expect("leader"), Ok("connected"));
        assert_eq!(follower.await.expect("follower"), Ok("connected"));
        let (result, activity) = observed
            .lock()
            .expect("observed")
            .clone()
            .expect("finalizer ran");
        assert_eq!(result, Ok("connected"));
        assert_eq!(activity.followers, 1);
        assert_eq!(activity.joined, 1);
        assert_eq!(activity.suppressed, 1);
    }

    #[tokio::test]
    async fn finalizer_runs_for_superseded_and_panicking_leaders() {
        let coordinator = Arc::new(StartupCoordinator::<&'static str>::default());
        let finalized = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let stale = {
            let coordinator = coordinator.clone();
            let finalized = finalized.clone();
            tokio::spawn(async move {
                coordinator
                    .run_profile_with_finalizer(
                        "profile-a",
                        move |_| async move {
                            let _ = entered_tx.send(());
                            let _ = release_rx.await;
                            Ok("stale")
                        },
                        move |result, activity| finalized.lock().unwrap().push((result.clone(), activity)),
                    )
                    .await
            })
        };
        entered_rx.await.unwrap();
        let latest = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .run_profile("profile-b", |_| async { Ok("latest") })
                    .await
            })
        };
        let _ = release_tx.send(());
        assert_eq!(stale.await.unwrap(), Err(SUPERSEDED_STARTUP_ERROR.to_string()));
        assert_eq!(latest.await.unwrap(), Ok("latest"));

        let panic_finalized = finalized.clone();
        let panic_result = coordinator
            .run_profile_with_finalizer(
                "profile-c",
                |_| async { panic!("fixture panic") },
                move |result, activity| panic_finalized.lock().unwrap().push((result.clone(), activity)),
            )
            .await;
        assert!(panic_result.unwrap_err().contains("startup_driver_failed"));
        let rows = finalized.lock().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1.superseded, 1);
        assert!(rows[1].0.as_ref().unwrap_err().contains("startup_driver_failed"));
    }

    #[tokio::test]
    async fn invalidation_uses_the_same_monotonic_generation_allocator() {
        let coordinator = StartupCoordinator::<u64>::default();
        let invalidated = Arc::new(AtomicUsize::new(0));
        let observed = invalidated.clone();
        coordinator
            .invalidate(move |generation| {
                observed.store(generation as usize, Ordering::SeqCst);
            })
            .await;
        assert_eq!(invalidated.load(Ordering::SeqCst), 1);
        assert_eq!(
            coordinator
                .run_profile("profile-a", |flight| async move { Ok(flight.generation()) })
                .await,
            Ok(2)
        );
    }

    #[tokio::test]
    async fn latest_intent_waits_on_shared_activation_without_entering_stale_mutation() {
        let profiles = Arc::new(StartupCoordinator::<&'static str>::default());
        let activation = Arc::new(StartupCoordinator::<()>::default());
        let mutations = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (activation_entered_tx, activation_entered_rx) = tokio::sync::oneshot::channel();
        let (activation_release_tx, activation_release_rx) = tokio::sync::oneshot::channel();
        let activation_release = Arc::new(tokio::sync::Mutex::new(Some(activation_release_rx)));

        let stale = {
            let profiles = profiles.clone();
            let activation = activation.clone();
            let activation_release = activation_release.clone();
            let mutations = mutations.clone();
            tokio::spawn(async move {
                profiles
                    .run_profile_with_preparation(
                        "profile-a",
                        move |_| async move {
                            activation
                                .run_profile("runtime-v1", move |_| async move {
                                    let _ = activation_entered_tx.send(());
                                    if let Some(release) = activation_release.lock().await.take() {
                                        let _ = release.await;
                                    }
                                    Ok(())
                                })
                                .await
                        },
                        move |_| async move {
                            mutations.lock().unwrap().push("profile-a");
                            Ok("stale")
                        },
                    )
                    .await
            })
        };
        activation_entered_rx.await.unwrap();
        let (latest_registered_tx, latest_registered_rx) = tokio::sync::oneshot::channel();
        let latest = {
            let profiles = profiles.clone();
            let activation = activation.clone();
            let mutations = mutations.clone();
            tokio::spawn(async move {
                profiles
                    .run_profile_with_preparation_hooks(
                        "profile-b",
                        move |_| { let _ = latest_registered_tx.send(()); },
                        move |_| async move {
                            activation.run_profile("runtime-v1", |_| async { Ok(()) }).await
                        },
                        move |_| async move {
                            mutations.lock().unwrap().push("profile-b");
                            Ok("latest")
                        },
                        |_, _| {},
                    )
                    .await
            })
        };
        tokio::time::timeout(std::time::Duration::from_millis(100), latest_registered_rx)
            .await
            .expect("B registers latest while shared activation is held")
            .unwrap();
        assert!(mutations.lock().unwrap().is_empty());
        let _ = activation_release_tx.send(());
        assert_eq!(stale.await.unwrap(), Err(SUPERSEDED_STARTUP_ERROR.to_string()));
        assert_eq!(latest.await.unwrap(), Ok("latest"));
        assert_eq!(*mutations.lock().unwrap(), vec!["profile-b"]);
    }

    #[tokio::test]
    async fn shutdown_returns_during_held_preparation_and_stale_start_never_spawns() {
        let coordinator = Arc::new(StartupCoordinator::<&'static str>::default());
        let spawns = Arc::new(AtomicUsize::new(0));
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let stale = {
            let coordinator = coordinator.clone();
            let spawns = spawns.clone();
            tokio::spawn(async move {
                coordinator
                    .run_profile_with_preparation(
                        "profile-a",
                        move |_| async move {
                            let _ = entered_tx.send(());
                            let _ = release_rx.await;
                            Ok(())
                        },
                        move |_| async move {
                            spawns.fetch_add(1, Ordering::SeqCst);
                            Ok("connected")
                        },
                    )
                    .await
            })
        };
        entered_rx.await.unwrap();

        let stopped = Arc::new(AtomicUsize::new(0));
        let cleared = Arc::new(AtomicUsize::new(0));
        let deleted = Arc::new(AtomicUsize::new(0));
        let shutdown = {
            let coordinator = coordinator.clone();
            let stopped = stopped.clone();
            let cleared = cleared.clone();
            let deleted = deleted.clone();
            tokio::spawn(async move {
                let guard = coordinator.invalidate_and_lock(|_| {}).await;
                stopped.fetch_add(1, Ordering::SeqCst);
                cleared.fetch_add(1, Ordering::SeqCst);
                deleted.fetch_add(1, Ordering::SeqCst);
                drop(guard);
            })
        };
        tokio::time::timeout(std::time::Duration::from_millis(100), shutdown)
            .await
            .expect("stop/reset returns while stale preparation is still held")
            .unwrap();
        assert_eq!(spawns.load(Ordering::SeqCst), 0);
        assert_eq!(stopped.load(Ordering::SeqCst), 1);
        assert_eq!(cleared.load(Ordering::SeqCst), 1);
        assert_eq!(deleted.load(Ordering::SeqCst), 1);

        let _ = release_tx.send(());
        assert_eq!(stale.await.unwrap(), Err(SUPERSEDED_STARTUP_ERROR.to_string()));
        assert_eq!(spawns.load(Ordering::SeqCst), 0);
    }
}
