//! App-owned Meta device grants. No third-party CLI credentials are read or modified.
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

mod transport;
use transport::Http;
#[cfg(test)]
use transport::Reply;
#[cfg(test)]
mod tests;

const CLIENT_ID: &str = "1031625952748946";
const START: &str = "https://auth.meta.com/oidc/device/authorization/";
const TOKEN: &str = "https://auth.meta.com/oidc/device/token/";
const USAGE: &str = "https://api.meta.ai/muse-code/key";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginView {
    login_id: String,
    user_code: String,
    verification_uri: String,
    expires_at: i64,
    interval_seconds: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PollView {
    state: &'static str,
    interval_seconds: u64,
}
struct Session {
    id: String,
    device_code: String,
    deadline: Instant,
    next_poll: Instant,
    interval: u64,
    expected: HashMap<String, Value>,
    busy: bool,
}
#[derive(Default)]
struct Controller {
    session: Mutex<Option<Session>>,
}
fn controller() -> &'static Controller {
    static STATE: OnceLock<Controller> = OnceLock::new();
    STATE.get_or_init(Controller::default)
}
fn changed() -> String {
    "授权已取消或被新的连接替代，请重新连接。".into()
}
fn invalid() -> String {
    "Meta 返回的授权信息无法验证，请稍后重试。".into()
}

pub(crate) fn fields() -> Vec<crate::plugin_engine::manifest::PluginConfigField> {
    let manifest: Value = serde_json::from_str(include_str!("../../../plugins/muse/plugin.json"))
        .expect("bundled Muse manifest");
    serde_json::from_value(manifest["config"]["fields"].clone())
        .expect("bundled Muse credential fields")
}

impl Controller {
    fn start(
        &self,
        http: &impl Http,
        expected: HashMap<String, Value>,
    ) -> Result<LoginView, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = Instant::now();
        *self.session.lock().map_err(|_| changed())? = Some(Session {
            id: id.clone(),
            device_code: String::new(),
            deadline: now + Duration::from_secs(900),
            next_poll: now,
            interval: 5,
            expected,
            busy: true,
        });
        let result = (|| {
            let reply = http.request(START, &[("client_id", CLIENT_ID)], None)?;
            if reply.status != 200 {
                return Err("无法开始 Meta 授权，请稍后重试。".into());
            }
            let value = reply.json()?;
            let code = text(&value, "device_code")?;
            let user_code = text(&value, "user_code")?;
            let uri = text(&value, "verification_uri")?;
            let parsed = reqwest::Url::parse(&uri).map_err(|_| invalid())?;
            let host = parsed.host_str().ok_or_else(invalid)?;
            if parsed.scheme() != "https"
                || !(host == "meta.com" || host.ends_with(".meta.com"))
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.port_or_known_default() != Some(443)
            {
                return Err(invalid());
            }
            let ttl = seconds(&value, "expires_in", 900)?.min(900);
            let interval = seconds(&value, "interval", 5)?.min(60);
            crate::plugin_engine::host_api::register_secret_for_redaction(&code);
            let mut locked = self.session.lock().map_err(|_| changed())?;
            let current = locked.as_mut().filter(|s| s.id == id).ok_or_else(changed)?;
            current.device_code = code;
            current.deadline = Instant::now() + Duration::from_secs(ttl);
            current.interval = interval;
            current.next_poll = Instant::now() + Duration::from_secs(interval);
            current.busy = false;
            Ok(LoginView {
                login_id: id.clone(),
                user_code,
                verification_uri: uri,
                expires_at: (time::OffsetDateTime::now_utc().unix_timestamp() + ttl as i64) * 1000,
                interval_seconds: interval,
            })
        })();
        if result.is_err() {
            log::warn!("Muse device authorization could not start");
            self.cancel(&id)?;
        }
        result
    }

    fn poll(
        &self,
        id: &str,
        http: &impl Http,
        save: impl FnOnce(
            &HashMap<String, Value>,
            HashMap<String, Value>,
            Instant,
        ) -> Result<(), String>,
    ) -> Result<PollView, String> {
        self.poll_with_clock(id, http, save, || {
            (Instant::now(), time::OffsetDateTime::now_utc())
        })
    }

    fn poll_with_clock(
        &self,
        id: &str,
        http: &impl Http,
        save: impl FnOnce(
            &HashMap<String, Value>,
            HashMap<String, Value>,
            Instant,
        ) -> Result<(), String>,
        now: impl Fn() -> (Instant, time::OffsetDateTime),
    ) -> Result<PollView, String> {
        let (code, expected) = {
            let mut locked = self.session.lock().map_err(|_| changed())?;
            let current = locked.as_mut().filter(|s| s.id == id).ok_or_else(changed)?;
            if Instant::now() >= current.deadline {
                *locked = None;
                return Err("验证码已过期，请重新连接。".into());
            }
            if current.busy || Instant::now() < current.next_poll {
                return Ok(PollView {
                    state: "pending",
                    interval_seconds: current.interval,
                });
            }
            current.busy = true;
            (current.device_code.clone(), current.expected.clone())
        };
        let result = (|| {
            let reply = http.request(
                TOKEN,
                &[
                    ("client_id", CLIENT_ID),
                    ("device_code", &code),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ],
                None,
            )?;
            let (received_at, received_utc) = now();
            let data = reply.json()?;
            if let Some(error) = data.get("error").and_then(Value::as_str) {
                return match error {
                    "authorization_pending" => Ok((None, false)),
                    "slow_down" => Ok((None, true)),
                    "expired_token" => Err("验证码已过期，请重新连接。".into()),
                    "access_denied" => Err("授权未完成，请重新连接。".into()),
                    _ => Err("Meta 授权失败，请重新连接。".into()),
                };
            }
            if reply.status != 200 {
                return Err("Meta 授权失败，请重新连接。".into());
            }
            let token = text(&data, "access_token")?;
            if !token.starts_with("dca:") || token.len() <= 4 {
                return Err(invalid());
            }
            crate::plugin_engine::host_api::register_secret_for_redaction(&token);
            // expires_in starts at token receipt, before the separate identity request.
            let expiry = match data.get("expires_in") {
                None | Some(Value::Null) => None,
                Some(value) => {
                    let seconds = value
                        .as_u64()
                        .filter(|n| *n > 0 && *n <= 366 * 86400)
                        .ok_or_else(invalid)?;
                    Some((
                        received_at + Duration::from_secs(seconds),
                        received_utc + time::Duration::seconds(seconds as i64),
                    ))
                }
            };
            let verified = http.request(USAGE, &[], Some(&token))?;
            if verified.status != 200 {
                return Err("无法验证 Muse Code 账号，请重新连接。".into());
            }
            let identity = verified.json()?;
            text(&identity, "user_email")?;
            if !identity
                .get("is_subs_active")
                .is_some_and(Value::is_boolean)
            {
                return Err(invalid());
            }
            let expiry_text = expiry
                .map(|(_, utc)| {
                    utc.format(&time::format_description::well_known::Rfc3339)
                        .map_err(|_| invalid())
                })
                .transpose()?
                .unwrap_or_default();
            Ok((
                Some((
                    HashMap::from([
                        ("accessToken".into(), json!(token)),
                        ("tokenExpiresAt".into(), json!(expiry_text)),
                    ]),
                    expiry.map(|(deadline, _)| deadline),
                )),
                false,
            ))
        })();
        let mut locked = self.session.lock().map_err(|_| changed())?;
        let current = locked.as_mut().filter(|s| s.id == id).ok_or_else(changed)?;
        current.busy = false;
        if Instant::now() >= current.deadline {
            *locked = None;
            return Err("验证码已过期，请重新连接。".into());
        }
        match result {
            Ok((Some((values, token_deadline)), _)) => {
                let save_valid_until = token_deadline
                    .map_or(current.deadline, |deadline| deadline.min(current.deadline));
                *locked = None;
                if now().0 >= save_valid_until {
                    log::warn!("Muse authorization expired before saving the connection");
                    return Err("Muse Code 授权已过期，请重新连接。".into());
                }
                save(&expected, values, save_valid_until).map_err(|error| {
                    log::warn!("Muse device authorization could not save the connection");
                    error
                })?;
                Ok(PollView {
                    state: "succeeded",
                    interval_seconds: 0,
                })
            }
            Ok((None, slower)) => {
                if slower {
                    current.interval = current.interval.saturating_add(5).min(60);
                }
                current.next_poll = Instant::now() + Duration::from_secs(current.interval);
                Ok(PollView {
                    state: if slower { "slowDown" } else { "pending" },
                    interval_seconds: current.interval,
                })
            }
            Err(error) => {
                *locked = None;
                log::warn!("Muse device authorization did not complete");
                Err(error)
            }
        }
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        let mut locked = self.session.lock().map_err(|_| changed())?;
        if locked.as_ref().is_some_and(|s| s.id == id) {
            *locked = None;
        }
        Ok(())
    }
}

fn text(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(invalid)
}
fn seconds(value: &Value, key: &str, default: u64) -> Result<u64, String> {
    match value.get(key) {
        None => Ok(default),
        Some(value) => value.as_u64().filter(|n| *n > 0).ok_or_else(invalid),
    }
}

#[tauri::command]
pub(crate) async fn start_muse_login() -> Result<LoginView, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let expected = crate::provider_config::resolved_values_from_disk("muse", &fields())?;
        controller().start(&transport::Client, expected)
    })
    .await
    .map_err(|_| "授权服务暂不可用，请重试。".to_string())?
}
#[tauri::command]
pub(crate) async fn poll_muse_login(
    login_id: String,
    app: tauri::AppHandle,
) -> Result<PollView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        controller().poll(
            &login_id,
            &transport::Client,
            |expected, values, save_valid_until| {
                use tauri::{Emitter, Manager};
                let state = app.state::<std::sync::Mutex<crate::AppState>>();
                let batches = std::sync::Arc::clone(
                    &state
                        .lock()
                        .map_err(|_| "应用状态暂不可用。")?
                        .latest_probe_batches,
                );
                batches.with_connection_commit(
                    "muse",
                    &format!("muse-login-{}", uuid::Uuid::new_v4()),
                    || {
                        crate::provider_config::save_login_values(
                            "muse",
                            &fields(),
                            expected,
                            values,
                            save_valid_until,
                            || {
                                crate::local_http_api::cache::replace_account_projection(
                                    "muse", None,
                                )
                            },
                        )
                    },
                    |previous_batch_id| {
                        #[derive(Clone, Serialize)]
                        #[serde(rename_all = "camelCase")]
                        struct Committed {
                            provider_id: &'static str,
                            previous_batch_id: Option<String>,
                        }
                        if app
                            .emit(
                                "provider:connection-committed",
                                Committed {
                                    provider_id: "muse",
                                    previous_batch_id,
                                },
                            )
                            .is_err()
                        {
                            log::error!(
                                "Muse committed connection notification could not be delivered"
                            );
                        }
                    },
                )
            },
        )
    })
    .await
    .map_err(|_| "授权服务暂不可用，请重试。".to_string())?
}
#[tauri::command]
pub(crate) async fn cancel_muse_login(login_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || controller().cancel(&login_id))
        .await
        .map_err(|_| "授权服务暂不可用，请重试。".to_string())?
}
