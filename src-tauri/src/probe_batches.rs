use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct LatestProbeBatches {
    latest_by_provider: Mutex<HashMap<String, String>>,
}

impl LatestProbeBatches {
    pub(crate) fn begin_batch(&self, batch_id: &str, provider_ids: &[String]) {
        let mut latest_by_provider = self
            .latest_by_provider
            .lock()
            .expect("latest probe batches poisoned");
        for provider_id in provider_ids {
            latest_by_provider.insert(provider_id.clone(), batch_id.to_string());
        }
    }

    /// Keeps the ownership lock through `commit` so a newer batch cannot start
    /// between the latest check and the caller's cache/event publication.
    pub(crate) fn commit_if_latest<R>(
        &self,
        batch_id: &str,
        provider_id: &str,
        commit: impl FnOnce() -> R,
    ) -> Option<R> {
        let latest_by_provider = self
            .latest_by_provider
            .lock()
            .expect("latest probe batches poisoned");
        if latest_by_provider.get(provider_id).map(String::as_str) == Some(batch_id) {
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
    use std::sync::{Arc, mpsc};
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
}
