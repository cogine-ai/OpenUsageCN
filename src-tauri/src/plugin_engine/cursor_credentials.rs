//! Cursor's Electron Safe Storage envelope. The Keychain password never crosses into JS.
use super::host_api::ProbeDeadline;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rquickjs::{Ctx, Exception, Function, Object};

const PREFIX: &str = "cursor-safe-storage:v1:";
const PRIMARY_ACCOUNT: &str = "Cursor Key";
const LEGACY_ACCOUNT: &str = "Cursor";

#[cfg(target_os = "macos")]
thread_local! {
    static AUTHORIZED_PASSWORD: std::cell::RefCell<Option<AuthorizedPassword>> = const { std::cell::RefCell::new(None) };
}

#[cfg(target_os = "macos")]
struct AuthorizedPassword {
    account: &'static str,
    secret: String,
}

#[cfg(target_os = "macos")]
impl Drop for AuthorizedPassword {
    fn drop(&mut self) {
        unsafe { self.secret.as_bytes_mut().fill(0) };
    }
}

// A grant is tied to this probe worker and cannot outlive the explicit refresh.
pub(crate) struct DesktopAuthorization(std::marker::PhantomData<std::rc::Rc<()>>);

#[cfg(target_os = "macos")]
impl DesktopAuthorization {
    fn enter(password: AuthorizedPassword) -> Self {
        AUTHORIZED_PASSWORD.with(|slot| slot.replace(Some(password)));
        Self(std::marker::PhantomData)
    }
}

#[cfg(target_os = "macos")]
impl Drop for DesktopAuthorization {
    fn drop(&mut self) {
        AUTHORIZED_PASSWORD.with(|password| password.replace(None));
    }
}

pub(crate) fn authorize_desktop() -> Result<DesktopAuthorization, &'static str> {
    #[cfg(target_os = "macos")]
    {
        let result = super::keychain_control::read_cursor_app_password(PRIMARY_ACCOUNT, true)
            .map(|secret| AuthorizedPassword {
                account: PRIMARY_ACCOUNT,
                secret,
            })
            .or_else(|error| {
                if !error.starts_with("missing:") {
                    return Err(error);
                }
                super::keychain_control::read_cursor_app_password(LEGACY_ACCOUNT, true).map(
                    |secret| AuthorizedPassword {
                        account: LEGACY_ACCOUNT,
                        secret,
                    },
                )
            });
        match result {
            Ok(password) => Ok(DesktopAuthorization::enter(password)),
            Err(error) => {
                log::warn!("Cursor desktop authorization could not read Keychain: {error}");
                let kind = error.split_once(':').map(|(kind, _)| kind);
                Err(match kind {
                    Some("missing") => "请先在 Cursor 桌面版登录，再授权并刷新。",
                    Some("denied") => {
                        "钥匙串授权未完成。点击「授权并刷新」，在系统弹窗中允许访问。"
                    }
                    Some("locked") => "钥匙串当前不可用。请解锁 Mac 后重试。",
                    Some("busy") => "钥匙串授权正在进行，请稍后重试。",
                    _ => "无法读取 Cursor 桌面版的钥匙串项目，请重试。",
                })
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    Err("Cursor 桌面钥匙串授权仅支持 macOS。")
}

fn read_password(account: &str, deadline: ProbeDeadline) -> Result<String, String> {
    if deadline.has_elapsed() {
        return Err("timedOut: Cursor Keychain read exceeded its time limit.".into());
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(result) = AUTHORIZED_PASSWORD.with(|slot| {
            slot.borrow().as_ref().map(|password| {
                if password.account == account {
                    Ok(password.secret.clone())
                } else {
                    Err("missing: Keychain item was not found.".into())
                }
            })
        }) {
            return result;
        }
        super::keychain_control::read_cursor_app_password(account, false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        Err("Cursor Safe Storage is supported only on macOS.".into())
    }
}

pub(super) fn inject<'js>(
    ctx: &Ctx<'js>,
    host: &Object<'js>,
    deadline: ProbeDeadline,
) -> rquickjs::Result<()> {
    let cursor = Object::new(ctx.clone())?;
    cursor.set(
        "decryptToken",
        Function::new(ctx.clone(), move |ctx: Ctx<'_>, value: String| {
            decrypt_with(&value, |account| read_password(account, deadline)).map_err(|error| {
                log::warn!("Cursor credential decryption failed: {}", error);
                Exception::throw_message(&ctx, &error)
            })
        })?,
    )?;
    host.set("cursor", cursor)
}

fn decrypt_with(
    value: &str,
    mut password: impl FnMut(&str) -> Result<String, String>,
) -> Result<String, String> {
    let encoded = value
        .strip_prefix(PREFIX)
        .ok_or("Cursor credential encryption version is unsupported.")?;
    let data = STANDARD
        .decode(encoded)
        .map_err(|_| "Cursor encrypted credential is invalid.")?;
    if data.len() <= 3 || &data[..3] != b"v10" || (data.len() - 3) % 16 != 0 {
        return Err("Cursor encrypted credential is invalid.".into());
    }
    let mut secret = match password(PRIMARY_ACCOUNT) {
        Err(error) if error.starts_with("missing:") => password(LEGACY_ACCOUNT)?,
        result => result?,
    };
    let result = decrypt(&data[3..], secret.as_bytes());
    // Do not leave the Safe Storage password in an ordinary string allocation.
    unsafe { secret.as_bytes_mut().fill(0) };
    let token = String::from_utf8(result?).map_err(|error| {
        let mut bytes = error.into_bytes();
        bytes.fill(0);
        "Cursor decrypted credential is invalid."
    })?;
    if token.trim().is_empty() {
        return Err("Cursor decrypted credential is empty.".into());
    }
    Ok(token)
}

#[cfg(target_os = "macos")]
fn decrypt(data: &[u8], password: &[u8]) -> Result<Vec<u8>, String> {
    crypt(data, password, 1)
}

#[cfg(not(target_os = "macos"))]
fn decrypt(_data: &[u8], _password: &[u8]) -> Result<Vec<u8>, String> {
    Err("Cursor Safe Storage is supported only on macOS.".into())
}

#[cfg(target_os = "macos")]
fn crypt(data: &[u8], password: &[u8], operation: u32) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    #[link(name = "System")]
    unsafe extern "C" {
        fn CCKeyDerivationPBKDF(
            algorithm: u32,
            password: *const u8,
            password_len: usize,
            salt: *const u8,
            salt_len: usize,
            prf: u32,
            rounds: u32,
            key: *mut u8,
            key_len: usize,
        ) -> i32;
        fn CCCrypt(
            operation: u32,
            algorithm: u32,
            options: u32,
            key: *const c_void,
            key_len: usize,
            iv: *const c_void,
            input: *const c_void,
            input_len: usize,
            output: *mut c_void,
            output_len: usize,
            written: *mut usize,
        ) -> i32;
    }
    let mut key = [0_u8; 16];
    // PBKDF2-HMAC-SHA1, Electron's macOS v10 salt/iteration count; AES-128-CBC + PKCS7.
    let derived = unsafe {
        CCKeyDerivationPBKDF(
            2,
            password.as_ptr(),
            password.len(),
            b"saltysalt".as_ptr(),
            9,
            1,
            1003,
            key.as_mut_ptr(),
            key.len(),
        )
    };
    if derived != 0 {
        key.fill(0);
        return Err("Cursor Safe Storage key derivation failed.".into());
    }
    let mut output = vec![0; data.len() + 16];
    let mut written = 0;
    let status = unsafe {
        CCCrypt(
            operation,
            0,
            1,
            key.as_ptr().cast(),
            key.len(),
            [0x20_u8; 16].as_ptr().cast(),
            data.as_ptr().cast(),
            data.len(),
            output.as_mut_ptr().cast(),
            output.len(),
            &mut written,
        )
    };
    key.fill(0);
    if status != 0 {
        output.fill(0);
        return Err("Cursor credential could not be decrypted.".into());
    }
    output.truncate(written);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_envelope_never_reads_keychain() {
        for value in [
            "cursor-safe-storage:v2:AA==",
            "cursor-safe-storage:v1:!",
            "cursor-safe-storage:v1:djEw",
        ] {
            assert!(
                decrypt_with(value, |_| panic!("must validate before reading password")).is_err()
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn decrypts_both_accounts_and_does_not_retry_denial() {
        // Independent vector generated with hashlib.pbkdf2_hmac and OpenSSL AES-CBC.
        let envelope = format!("{PREFIX}djEwW1T4gMlKXzks3HZdocQh/o5vZifrNOOfZrD629Aaq18=");
        let mut accounts = vec![];
        let token = decrypt_with(&envelope, |account| {
            accounts.push(account.to_owned());
            if account == "Cursor Key" {
                Err("missing: item".into())
            } else {
                Ok("synthetic-password".into())
            }
        })
        .unwrap();
        assert_eq!(token, "header.payload.signature");
        assert_eq!(accounts, ["Cursor Key", "Cursor"]);
        let mut attempts = 0;
        assert!(
            decrypt_with(&envelope, |_| {
                attempts += 1;
                Err("denied: access".into())
            })
            .is_err()
        );
        assert_eq!(attempts, 1);
        assert!(decrypt_with(&envelope, |_| Ok("wrong-password".into())).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn one_time_grant_can_decrypt_multiple_credentials_only_on_the_request_worker() {
        use std::time::{Duration, Instant};

        let deadline = ProbeDeadline::at(Instant::now() + Duration::from_secs(5));
        let grant = DesktopAuthorization::enter(AuthorizedPassword {
            account: LEGACY_ACCOUNT,
            secret: "synthetic-password".into(),
        });
        let envelope = format!("{PREFIX}djEwW1T4gMlKXzks3HZdocQh/o5vZifrNOOfZrD629Aaq18=");
        for _ in 0..2 {
            assert_eq!(
                decrypt_with(&envelope, |account| read_password(account, deadline)).unwrap(),
                "header.payload.signature"
            );
        }
        std::thread::spawn(|| AUTHORIZED_PASSWORD.with(|slot| assert!(slot.borrow().is_none())))
            .join()
            .unwrap();
        drop(grant);
        AUTHORIZED_PASSWORD.with(|slot| assert!(slot.borrow().is_none()));
    }
}
