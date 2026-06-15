use serde::Serialize;
use std::sync::{Mutex, OnceLock};

const UNKNOWN_TIME: &str = "";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LocalHttpApiServiceStatus {
    Starting {
        bind: String,
    },
    Running {
        bind: String,
        #[serde(rename = "startedAt")]
        started_at: String,
    },
    BindFailed {
        bind: String,
        error: String,
        #[serde(rename = "failedAt")]
        failed_at: String,
    },
}

fn service_status_slot() -> &'static Mutex<LocalHttpApiServiceStatus> {
    static STATUS: OnceLock<Mutex<LocalHttpApiServiceStatus>> = OnceLock::new();
    STATUS.get_or_init(|| {
        Mutex::new(LocalHttpApiServiceStatus::Starting {
            bind: String::new(),
        })
    })
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| UNKNOWN_TIME.to_string())
}

pub fn mark_starting(bind: &str) {
    let mut status = service_status_slot()
        .lock()
        .expect("local HTTP API status poisoned");
    *status = LocalHttpApiServiceStatus::Starting {
        bind: bind.to_string(),
    };
}

pub fn mark_running(bind: &str) {
    let mut status = service_status_slot()
        .lock()
        .expect("local HTTP API status poisoned");
    *status = LocalHttpApiServiceStatus::Running {
        bind: bind.to_string(),
        started_at: now_rfc3339(),
    };
}

pub fn mark_bind_failed(bind: &str, error: &str) {
    let mut status = service_status_slot()
        .lock()
        .expect("local HTTP API status poisoned");
    *status = LocalHttpApiServiceStatus::BindFailed {
        bind: bind.to_string(),
        error: error.to_string(),
        failed_at: now_rfc3339(),
    };
}

pub fn get_status() -> LocalHttpApiServiceStatus {
    service_status_slot()
        .lock()
        .expect("local HTTP API status poisoned")
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_transitions_are_readable() {
        mark_starting("127.0.0.1:6736");
        assert!(matches!(
            get_status(),
            LocalHttpApiServiceStatus::Starting { .. }
        ));

        mark_running("127.0.0.1:6736");
        match get_status() {
            LocalHttpApiServiceStatus::Running { bind, started_at } => {
                assert_eq!(bind, "127.0.0.1:6736");
                assert!(!started_at.is_empty());
            }
            other => panic!("expected running status, got {other:?}"),
        }

        mark_bind_failed("127.0.0.1:6736", "address in use");
        match get_status() {
            LocalHttpApiServiceStatus::BindFailed { bind, error, .. } => {
                assert_eq!(bind, "127.0.0.1:6736");
                assert_eq!(error, "address in use");
            }
            other => panic!("expected bind_failed status, got {other:?}"),
        }
    }
}
