use super::keychain::{InstallationKey, InstallationKeyError, InstallationKeyStore};
use super::*;
use std::sync::{Arc, Mutex};
use std::time::Instant;

struct BudgetStore {
    seen: Mutex<Option<Instant>>,
    fail: bool,
}
impl InstallationKeyStore for BudgetStore {
    fn read(&self, deadline: Instant) -> Result<InstallationKey, InstallationKeyError> {
        *self.seen.lock().unwrap() = Some(deadline);
        Err(if self.fail {
            InstallationKeyError::Timeout
        } else {
            InstallationKeyError::Missing
        })
    }
    fn create(&self, deadline: Instant) -> Result<InstallationKey, InstallationKeyError> {
        assert!(!self.fail, "a timeout must never create a replacement key");
        assert_eq!(Some(deadline), *self.seen.lock().unwrap());
        Ok(InstallationKey::from_bytes([31; 32]))
    }
}
#[test]
fn resolver_passes_the_same_deadline_and_never_creates_after_timeout() {
    for fail in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(BudgetStore {
            seen: Mutex::new(None),
            fail,
        });
        let accounts = ProviderAccounts::open_with_key_store(dir.path(), store.clone()).unwrap();
        let result = accounts.resolve_installation_key();
        if fail {
            assert!(result.unwrap_err().contains("timed out"));
            assert!(accounts.installation_key.lock().unwrap().is_none());
            assert!(!dir.path().join("provider-accounts.json").exists());
        } else {
            assert_eq!(result.unwrap(), [31; 32]);
        }
        assert!(
            store
                .seen
                .lock()
                .unwrap()
                .unwrap()
                .saturating_duration_since(Instant::now())
                .as_secs()
                <= 10
        );
    }
}
