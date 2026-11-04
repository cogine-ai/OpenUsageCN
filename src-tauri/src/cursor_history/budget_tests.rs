use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use super::*;

struct Credentials;

impl CredentialLeasePort for Credentials {
    fn acquire(&self, request: CredentialRequest<'_>) -> Result<CredentialLease, HistoryError> {
        Ok(CredentialLease::new(
            request.provider_id.to_string(),
            request.account_id.to_string(),
            "generation".into(),
            vec![CredentialCandidate::new(
                "session".into(),
                SecretCookie::new("secret".into()),
            )],
        ))
    }

    fn identity_matches(&self, _: &CredentialLease, subject: &str) -> Result<bool, HistoryError> {
        Ok(subject == "subject")
    }

    fn is_current(&self, _: &CredentialLease) -> bool {
        true
    }

    fn with_current_lease(
        &self,
        _: &CredentialLease,
        operation: &mut dyn FnMut() -> Result<(), HistoryError>,
    ) -> Result<(), HistoryError> {
        operation()
    }
}

struct BudgetTransport {
    expire_auth: bool,
    expire_page: bool,
    full_first_page: bool,
    auth_timeouts: Mutex<Vec<Duration>>,
    page_timeouts: Mutex<Vec<Duration>>,
}

impl BudgetTransport {
    fn new(expire_auth: bool, expire_page: bool) -> Self {
        Self {
            expire_auth,
            expire_page,
            full_first_page: false,
            auth_timeouts: Mutex::new(vec![]),
            page_timeouts: Mutex::new(vec![]),
        }
    }
}

// Wait to a known deadline rather than assuming a sleep was long enough.
fn wait_until(deadline: Instant) {
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        std::thread::sleep(left);
    }
}

impl HistoryTransport for BudgetTransport {
    fn authenticate(
        &self,
        _: &CredentialCandidate,
        _: &str,
        timeout: Duration,
    ) -> Result<AuthOutcome, TransportError> {
        self.auth_timeouts.lock().unwrap().push(timeout);
        if self.expire_auth {
            wait_until(Instant::now() + timeout);
        }
        Ok(AuthOutcome::Authenticated(AuthIdentity::new(
            "subject".into(),
        )))
    }

    fn fetch_page(
        &self,
        _: &CredentialCandidate,
        request: &PageRequest,
        _: &str,
        timeout: Duration,
    ) -> Result<ScriptedPage, TransportError> {
        self.page_timeouts.lock().unwrap().push(timeout);
        if self.full_first_page && request.page == 1 {
            return Ok(ScriptedPage {
                page: request.page,
                events: vec![
                    ScriptedEvent {
                        timestamp_ms: RawNumber::Integer(request.start_date_ms.parse().unwrap()),
                        model_name: "model".into(),
                        token_usage: None,
                        charged_cents: RawNumber::Integer(0),
                        billing: super::EventBilling::Unknown,
                        owning_user: None,
                        owning_team: None,
                    };
                    1000
                ],
                total_usage_events_count: Some(1000),
            });
        }
        if self.expire_page {
            wait_until(Instant::now() + timeout);
        }
        Ok(ScriptedPage {
            page: request.page,
            events: vec![],
            total_usage_events_count: Some(if self.full_first_page { 1000 } else { 0 }),
        })
    }
}

fn demand() -> HistoryDemand {
    HistoryDemand {
        provider_id: "cursor".into(),
        account_id: "account-a".into(),
        now_ms: 1_800_000_000_000,
        billing_cycle: None,
        time_zone: "UTC".into(),
    }
}

#[test]
fn auth_consuming_the_budget_stops_before_any_page_request() {
    let transport = Arc::new(BudgetTransport::new(true, false));
    let root = std::env::temp_dir().join(format!("cursor-auth-budget-{}", uuid::Uuid::new_v4()));
    let service = HistoryService::new(
        Arc::new(Credentials),
        transport.clone(),
        HistoryStore::new(&root),
        HistoryScheduler::isolated_for_test(),
    );
    let refresh = service
        .refresh_before_deadline(demand(), Instant::now() + Duration::from_millis(20))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        refresh.error,
        Some(HistoryError::Transport(TransportError::Timeout))
    );
    assert!(refresh.snapshot.is_none());
    assert!(transport.page_timeouts.lock().unwrap().is_empty());
}

#[test]
fn a_complete_page_arriving_after_the_deadline_cannot_replace_the_cache() {
    let mut paged_transport = BudgetTransport::new(false, true);
    paged_transport.full_first_page = true;
    let transport = Arc::new(paged_transport);
    let root = std::env::temp_dir().join(format!("cursor-page-budget-{}", uuid::Uuid::new_v4()));
    let store = HistoryStore::new(&root);
    let previous = super::store_tests::complete_history("account-a", 1_700_000_000_001);
    store.save("cursor", "account-a", &previous).unwrap();
    let service = HistoryService::new(
        Arc::new(Credentials),
        transport.clone(),
        store.clone(),
        HistoryScheduler::isolated_for_test(),
    );
    let refresh = service
        .refresh_before_deadline(demand(), Instant::now() + Duration::from_secs(1))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        refresh.error,
        Some(HistoryError::Transport(TransportError::Timeout))
    );
    assert!(refresh.stale);
    assert_eq!(refresh.snapshot, Some(previous.clone()));
    assert_eq!(store.load("cursor", "account-a").unwrap(), Some(previous));
    let auth = transport.auth_timeouts.lock().unwrap();
    let pages = transport.page_timeouts.lock().unwrap();
    assert_eq!(auth.len(), 1);
    assert_eq!(pages.len(), 2);
    assert!(pages[1] < pages[0], "successive pages share one deadline");
    assert!(
        pages[0] < auth[0],
        "pagination must receive the budget left after authentication"
    );
}

#[test]
fn a_queued_job_times_out_without_waiting_for_an_active_job_to_finish() {
    let scheduler = HistoryScheduler::isolated_for_test();
    let mut blockers = vec![];
    let mut release = vec![];
    for account in ["block-a", "block-b"] {
        let (start_tx, start_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        blockers.push(
            scheduler
                .schedule(key(account), move |_| {
                    start_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .unwrap(),
        );
        start_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        release.push(release_tx);
    }
    let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let worker_called = called.clone();
    let expired = scheduler
        .schedule_with_deadline(
            key("queued"),
            Instant::now() + Duration::from_millis(20),
            move |_| {
                worker_called.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        done_tx.send(expired.wait()).unwrap();
    });
    let outcome = done_rx.recv_timeout(Duration::from_secs(1));
    // Always release active jobs, even if this regression fails.
    for sender in release {
        sender.send(()).unwrap();
    }
    for job in blockers {
        job.wait().unwrap();
    }
    assert_eq!(
        outcome.unwrap(),
        Err(HistoryError::Transport(TransportError::Timeout))
    );
    assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
}

fn key(account: &str) -> HistoryJobKey {
    HistoryJobKey {
        provider_id: "cursor".into(),
        account_id: account.into(),
        from_ms: 1_700_000_000_000,
        to_ms: 1_700_086_400_000,
        time_zone: "UTC".into(),
        credential_generation: "generation".into(),
    }
}
