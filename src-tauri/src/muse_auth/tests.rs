use super::*;
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
struct Fake(Mutex<VecDeque<Reply>>);
impl Http for Fake {
    fn request(&self, _: &str, _: &[(&str, &str)], _: Option<&str>) -> Result<Reply, String> {
        self.0
            .lock()
            .unwrap()
            .pop_front()
            .ok_or("unexpected request".into())
    }
}
fn fake(bodies: &[&str]) -> Fake {
    Fake(Mutex::new(
        bodies
            .iter()
            .map(|s| Reply {
                status: 200,
                body: s.to_string(),
            })
            .collect(),
    ))
}
const START_JSON: &str = r#"{"device_code":"synthetic-device-secret","user_code":"FAKE-2468","verification_uri":"https://auth.meta.com/device","expires_in":600,"interval":5}"#;
fn ready(c: &Controller) {
    let mut s = c.session.lock().unwrap();
    let s = s.as_mut().unwrap();
    s.next_poll = Instant::now();
}
fn begin(c: &Controller) -> String {
    let view = c.start(&fake(&[START_JSON]), HashMap::new()).unwrap();
    ready(c);
    view.login_id
}
#[test]
fn authorization_is_verified_before_saving_and_model_keys_never_leave_response() {
    let c = Controller::default();
    let id = begin(&c);
    let mut saved = None;
    let response=c.poll(&id,&fake(&[r#"{"access_token":"dca:synthetic-authorized","expires_in":3600}"#, r#"{"user_email":"synthetic@example.invalid","is_subs_active":false,"api_key":"private-model-key"}"#]), |_,values|{saved=Some(values);Ok(())}).unwrap();
    assert_eq!(response.state, "succeeded");
    let saved = saved.unwrap();
    assert_eq!(saved.len(), 2);
    assert_eq!(saved["accessToken"], "dca:synthetic-authorized");
    assert!(saved["tokenExpiresAt"].as_str().unwrap().ends_with('Z'));
    assert!(!serde_json::to_string(&saved)
        .unwrap()
        .contains("private-model-key"));
    assert!(c.session.lock().unwrap().is_none());
}
#[test]
fn pending_and_slow_down_do_not_save_or_busy_poll() {
    let c = Controller::default();
    let id = begin(&c);
    let http = fake(&[r#"{"error":"slow_down"}"#]);
    let r = c
        .poll(&id, &http, |_, _| panic!("pending must not save"))
        .unwrap();
    assert_eq!(r.state, "slowDown");
    assert_eq!(r.interval_seconds, 10);
    assert_eq!(
        c.poll(&id, &http, |_, _| panic!()).unwrap().state,
        "pending"
    );
}
#[test]
fn denied_expired_and_invalid_identity_preserve_previous_credentials() {
    for replies in [
        vec![r#"{"error":"access_denied"}"#],
        vec![r#"{"error":"expired_token"}"#],
        vec![r#"{"access_token":"wrong-prefix"}"#],
        vec![
            r#"{"access_token":"dca:synthetic"}"#,
            r#"{"api_key":"do-not-save"}"#,
        ],
    ] {
        let c = Controller::default();
        let id = begin(&c);
        assert!(c
            .poll(&id, &fake(&replies), |_, _| panic!(
                "failed grant must not save"
            ))
            .is_err());
    }
}
#[test]
fn untrusted_verification_urls_are_rejected() {
    for uri in [
        "https://auth.meta.com.evil.invalid/device",
        "http://auth.meta.com/device",
        "https://secret@auth.meta.com/device",
        "https://auth.meta.com:8443/device",
    ] {
        let body = START_JSON.replace("https://auth.meta.com/device", uri);
        assert!(Controller::default()
            .start(&fake(&[&body]), HashMap::new())
            .is_err());
    }
}
#[test]
fn a_replaced_or_cancelled_session_cannot_commit_a_late_grant() {
    struct Blocking {
        entered: mpsc::Sender<()>,
        resume: Mutex<mpsc::Receiver<()>>,
        count: Mutex<usize>,
    }
    impl Http for Blocking {
        fn request(&self, _: &str, _: &[(&str, &str)], _: Option<&str>) -> Result<Reply, String> {
            let mut n = self.count.lock().unwrap();
            *n += 1;
            let body = if *n == 1 {
                self.entered.send(()).unwrap();
                self.resume.lock().unwrap().recv().unwrap();
                r#"{"access_token":"dca:late-grant"}"#
            } else {
                r#"{"user_email":"private@example.invalid","is_subs_active":true}"#
            };
            Ok(Reply {
                status: 200,
                body: body.into(),
            })
        }
    }
    let c = Arc::new(Controller::default());
    let id = begin(&c);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let saved = Arc::new(AtomicBool::new(false));
    let worker_c = Arc::clone(&c);
    let worker_saved = Arc::clone(&saved);
    let worker_id = id.clone();
    let worker = std::thread::spawn(move || {
        worker_c.poll(
            &worker_id,
            &Blocking {
                entered: entered_tx,
                resume: Mutex::new(resume_rx),
                count: Mutex::new(0),
            },
            |_, _| {
                worker_saved.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
    });
    entered_rx.recv().unwrap();
    c.cancel(&id).unwrap();
    let newer = begin(&c);
    resume_tx.send(()).unwrap();
    assert!(worker.join().unwrap().is_err());
    assert!(!saved.load(Ordering::SeqCst));
    assert_eq!(c.session.lock().unwrap().as_ref().unwrap().id, newer);
}
#[test]
fn changed_configuration_rejects_an_otherwise_valid_grant() {
    let c = Controller::default();
    let id = begin(&c);
    assert!(c
        .poll(
            &id,
            &fake(&[
                r#"{"access_token":"dca:valid"}"#,
                r#"{"user_email":"valid@example.invalid","is_subs_active":true}"#
            ]),
            |_, _| Err("connection changed".into())
        )
        .is_err());
    assert!(c.session.lock().unwrap().is_none());
}

#[test]
fn token_expiry_starts_at_receipt_and_expired_verification_never_saves() {
    use std::cell::Cell;
    struct DelayedIdentity {
        elapsed: Cell<u64>,
        delay: u64,
    }
    impl Http for DelayedIdentity {
        fn request(&self, url: &str, _: &[(&str, &str)], _: Option<&str>) -> Result<Reply, String> {
            let body = if url == TOKEN {
                r#"{"access_token":"dca:synthetic-short-lived","expires_in":60}"#
            } else {
                self.elapsed.set(self.delay);
                r#"{"user_email":"synthetic@example.invalid","is_subs_active":true}"#
            };
            Ok(Reply {
                status: 200,
                body: body.into(),
            })
        }
    }
    let received_at = Instant::now();
    let received_utc = time::OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
    for delay in [20, 60, 75] {
        let c = Controller::default();
        let id = begin(&c);
        let http = DelayedIdentity {
            elapsed: Cell::new(0),
            delay,
        };
        let original = HashMap::from([("accessToken".to_string(), json!("dca:previous"))]);
        let mut credentials = original.clone();
        let result = c.poll_with_clock(
            &id,
            &http,
            |_, values| {
                credentials = values;
                Ok(())
            },
            || {
                let elapsed = http.elapsed.get();
                (
                    received_at + Duration::from_secs(elapsed),
                    received_utc + time::Duration::seconds(elapsed as i64),
                )
            },
        );
        if delay < 60 {
            assert_eq!(result.unwrap().state, "succeeded");
            let expected = (received_utc + time::Duration::seconds(60))
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap();
            assert_eq!(credentials["tokenExpiresAt"], expected);
        } else {
            assert!(result.is_err());
            assert_eq!(credentials, original);
        }
        assert!(c.session.lock().unwrap().is_none());
    }
}

#[test]
fn start_transport_status_and_schema_failures_clear_the_failed_session() {
    for replies in [
        Vec::new(),
        vec![Reply {
            status: 503,
            body: "private-response".into(),
        }],
        vec![Reply {
            status: 200,
            body: "not-json".into(),
        }],
        vec![Reply {
            status: 200,
            body: r#"{"device_code":"private-device-code"}"#.into(),
        }],
    ] {
        let c = Controller::default();
        assert!(c
            .start(&Fake(Mutex::new(replies.into())), HashMap::new())
            .is_err());
        assert!(c.session.lock().unwrap().is_none());
    }
}

#[test]
fn failed_start_does_not_clear_a_newer_session() {
    struct Replaced<'a>(&'a Controller);
    impl Http for Replaced<'_> {
        fn request(&self, _: &str, _: &[(&str, &str)], _: Option<&str>) -> Result<Reply, String> {
            self.0.start(&fake(&[START_JSON]), HashMap::new()).unwrap();
            Err("synthetic network failure".into())
        }
    }
    let c = Controller::default();
    assert!(c.start(&Replaced(&c), HashMap::new()).is_err());
    let session = c.session.lock().unwrap();
    assert!(!session.as_ref().unwrap().busy);
    assert_eq!(
        session.as_ref().unwrap().device_code,
        "synthetic-device-secret"
    );
}
