use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
struct Owners {
    latest_by_provider: HashMap<String, String>,
    last_probe_by_provider: HashMap<String, String>,
}

#[derive(Default)]
pub(crate) struct LatestProbeBatches {
    owners: Mutex<Owners>,
}

impl LatestProbeBatches {
    pub(crate) fn begin_batch(&self, batch_id: &str, provider_ids: &[String]) {
        let mut owners = self.owners.lock().expect("latest probe batches poisoned");
        for provider_id in provider_ids {
            owners
                .latest_by_provider
                .insert(provider_id.clone(), batch_id.to_string());
            owners
                .last_probe_by_provider
                .insert(provider_id.clone(), batch_id.to_string());
        }
    }

    /// A configuration barrier is not a frontend probe and must not erase its causal ID.
    pub(crate) fn invalidate_provider(&self, batch_id: &str, provider_id: &str) {
        self.owners
            .lock()
            .expect("latest probe batches poisoned")
            .latest_by_provider
            .insert(provider_id.to_owned(), batch_id.to_owned());
    }

    /// No probe can begin or publish between credential commit and its invalidation event.
    pub(crate) fn with_connection_commit<R>(
        &self,
        provider_id: &str,
        barrier_id: &str,
        save: impl FnOnce() -> Result<R, String>,
        notify: impl FnOnce(Option<String>),
    ) -> Result<R, String> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| "连接状态暂不可用，请重试。")?;
        let previous = owners.last_probe_by_provider.get(provider_id).cloned();
        let result = save()?;
        owners
            .latest_by_provider
            .insert(provider_id.to_owned(), barrier_id.to_owned());
        notify(previous);
        Ok(result)
    }

    /// Keeps the ownership lock through `commit` so a newer batch cannot start
    /// between the latest check and the caller's cache/event publication.
    pub(crate) fn commit_if_latest<R>(
        &self,
        batch_id: &str,
        provider_id: &str,
        commit: impl FnOnce() -> R,
    ) -> Option<R> {
        let owners = self.owners.lock().expect("latest probe batches poisoned");
        if owners
            .latest_by_provider
            .get(provider_id)
            .map(String::as_str)
            == Some(batch_id)
        {
            Some(commit())
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LatestProbeBatches;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[test]
    fn newer_batch_supersedes_older_for_same_provider() {
        let batches = LatestProbeBatches::default();
        let committed = AtomicUsize::new(0);

        batches.begin_batch("batch-a", &["codex".to_string()]);
        batches.begin_batch("batch-b", &["codex".to_string()]);

        assert_eq!(
            batches.commit_if_latest("batch-a", "codex", || {
                committed.fetch_add(1, Ordering::SeqCst);
                "old"
            }),
            None
        );
        assert_eq!(committed.load(Ordering::SeqCst), 0);
        assert_eq!(
            batches.commit_if_latest("batch-b", "codex", || {
                committed.fetch_add(1, Ordering::SeqCst);
                "new"
            }),
            Some("new")
        );
        assert_eq!(committed.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn supersession_is_scoped_per_provider() {
        let batches = LatestProbeBatches::default();

        batches.begin_batch("batch-a", &["codex".to_string(), "claude".to_string()]);
        batches.begin_batch("batch-b", &["codex".to_string()]);

        assert_eq!(
            batches.commit_if_latest("batch-a", "claude", || "claude-a"),
            Some("claude-a")
        );
        assert_eq!(
            batches.commit_if_latest("batch-a", "codex", || "codex-a"),
            None
        );
        assert_eq!(
            batches.commit_if_latest("batch-b", "codex", || "codex-b"),
            Some("codex-b")
        );
    }

    #[test]
    fn new_batch_waits_until_current_commit_finishes() {
        let batches = Arc::new(LatestProbeBatches::default());
        batches.begin_batch("batch-a", &["codex".to_string()]);

        let (commit_started_tx, commit_started_rx) = mpsc::channel();
        let (release_commit_tx, release_commit_rx) = mpsc::channel();
        let commit_batches = Arc::clone(&batches);
        let commit_thread = std::thread::spawn(move || {
            commit_batches.commit_if_latest("batch-a", "codex", || {
                commit_started_tx.send(()).unwrap();
                release_commit_rx.recv().unwrap();
            })
        });
        commit_started_rx.recv().unwrap();

        let (begin_attempted_tx, begin_attempted_rx) = mpsc::channel();
        let (begin_finished_tx, begin_finished_rx) = mpsc::channel();
        let begin_batches = Arc::clone(&batches);
        let begin_thread = std::thread::spawn(move || {
            begin_attempted_tx.send(()).unwrap();
            begin_batches.begin_batch("batch-b", &["codex".to_string()]);
            begin_finished_tx.send(()).unwrap();
        });
        begin_attempted_rx.recv().unwrap();

        let began_during_commit = begin_finished_rx
            .recv_timeout(Duration::from_millis(100))
            .is_ok();
        release_commit_tx.send(()).unwrap();
        assert_eq!(commit_thread.join().unwrap(), Some(()));
        begin_thread.join().unwrap();

        assert!(!began_during_commit);
    }
    #[test]
    fn repeated_connection_commits_keep_the_last_real_probe_and_failed_saves_keep_ownership() {
        let batches = LatestProbeBatches::default();
        batches.begin_batch("old-probe", &["muse".into(), "codex".into()]);
        for id in ["login-a", "login-b"] {
            batches
                .with_connection_commit(
                    "muse",
                    id,
                    || Ok(()),
                    |previous| assert_eq!(previous.as_deref(), Some("old-probe")),
                )
                .unwrap();
        }
        assert_eq!(batches.commit_if_latest("old-probe", "muse", || ()), None);
        assert_eq!(
            batches.commit_if_latest("old-probe", "codex", || ()),
            Some(())
        );
        assert!(batches
            .with_connection_commit::<()>(
                "muse",
                "failed",
                || Err("save failed".into()),
                |_| panic!("failed saves must not notify")
            )
            .is_err());
        assert_eq!(batches.commit_if_latest("login-b", "muse", || ()), Some(()));
        batches.invalidate_provider("config-change", "muse");
        batches
            .with_connection_commit(
                "muse",
                "login-c",
                || Ok(()),
                |previous| assert_eq!(previous.as_deref(), Some("old-probe")),
            )
            .unwrap();
    }
    #[test]
    fn a_new_probe_waits_for_connection_save_and_notification_then_becomes_current() {
        let batches = Arc::new(LatestProbeBatches::default());
        batches.begin_batch("old", &["muse".into()]);
        let (saving_tx, saving_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (notified_tx, notified_rx) = mpsc::channel();
        let owner = batches.clone();
        let saving = std::thread::spawn(move || {
            owner.with_connection_commit(
                "muse",
                "login",
                || {
                    saving_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                },
                |previous| {
                    assert_eq!(previous.as_deref(), Some("old"));
                    notified_tx.send(()).unwrap();
                },
            )
        });
        saving_rx.recv().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let newer = batches.clone();
        let thread = std::thread::spawn(move || {
            newer.begin_batch("new", &["muse".into()]);
            started_tx.send(()).unwrap();
        });
        assert!(started_rx.recv_timeout(Duration::from_millis(30)).is_err());
        release_tx.send(()).unwrap();
        saving.join().unwrap().unwrap();
        notified_rx.recv().unwrap();
        thread.join().unwrap();
        assert_eq!(batches.commit_if_latest("new", "muse", || ()), Some(()));
    }
}
