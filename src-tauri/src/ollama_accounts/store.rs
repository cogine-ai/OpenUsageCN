use super::model::{AccountError, AccountProbe, Primary, Record, StoredAccounts};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, MutexGuard, OnceLock},
    time::Instant,
};

pub(super) struct StoreGuard<'a> {
    state: MutexGuard<'a, Transient>,
    file: std::fs::File,
}

impl std::ops::Deref for StoreGuard<'_> {
    type Target = Transient;
    fn deref(&self) -> &Transient {
        &self.state
    }
}

impl std::ops::DerefMut for StoreGuard<'_> {
    fn deref_mut(&mut self) -> &mut Transient {
        &mut self.state
    }
}

impl Drop for StoreGuard<'_> {
    fn drop(&mut self) {
        if self.file.unlock().is_err() {
            log::error!("Ollama account store lock could not be released");
        }
    }
}

pub(super) struct Pending {
    pub api_key: String,
    pub target: Option<(String, u64)>,
    pub probe: AccountProbe,
    pub created: Instant,
}

#[derive(Default)]
pub(super) struct Transient {
    pub pending: HashMap<String, Pending>,
}

pub(super) struct RefreshGuard {
    file: std::fs::File,
}

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        if self.file.unlock().is_err() {
            log::error!("Ollama connection refresh lock could not be released");
        }
    }
}

pub(super) fn acquire_refresh(id: &str, deadline: Instant) -> Result<RefreshGuard, String> {
    let file = open_refresh_lock_file(id)?;
    loop {
        if Instant::now() >= deadline {
            log::warn!("Ollama refresh timed out waiting for the same connection");
            return Err("账号刷新已超时，请稍后重试。".into());
        }
        match file.try_lock() {
            Ok(()) => return Ok(RefreshGuard { file }),
            Err(std::fs::TryLockError::WouldBlock) => {
                std::thread::sleep(std::time::Duration::from_millis(5))
            }
            Err(_) => {
                log::error!("Ollama connection refresh lock is unavailable");
                return Err(changed());
            }
        }
    }
}

#[cfg(test)]
thread_local! { pub(super) static TEST_PATH: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) }; }

pub(super) fn lock() -> Result<StoreGuard<'static>, String> {
    static STATE: OnceLock<Mutex<Transient>> = OnceLock::new();
    let state = STATE
        .get_or_init(|| Mutex::new(Transient::default()))
        .lock()
        .unwrap_or_else(|poisoned| {
            log::error!("Ollama account store lock recovered after a worker panic");
            poisoned.into_inner()
        });
    let file = open_lock_file()?;
    let started = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(StoreGuard { state, file }),
            Err(std::fs::TryLockError::WouldBlock)
                if started.elapsed() < std::time::Duration::from_secs(10) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(5))
            }
            Err(_) => {
                log::error!("Ollama account store lock is unavailable");
                return Err("账号配置正在被其他进程使用，请稍后重试。".into());
            }
        }
    }
}

pub(super) fn open_lock_file() -> Result<std::fs::File, String> {
    open_named_lock_file(".ollama-accounts.lock")
}

pub(super) fn open_refresh_lock_file(id: &str) -> Result<std::fs::File, String> {
    open_named_lock_file(&format!(
        ".ollama-refresh-{}.lock",
        crate::safe_file::sha256_hex(id.as_bytes())
    ))
}

fn open_named_lock_file(name: &str) -> Result<std::fs::File, String> {
    let lock_path = path()?.with_file_name(name);
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| storage_error())?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(lock_path).map_err(|_| storage_error())
}

pub(super) fn path() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(path) = TEST_PATH.with(|p| p.borrow().clone()) {
        return Ok(path);
    }
    Ok(crate::provider_config::config_path()?.with_file_name("ollama-accounts.json"))
}

pub(super) fn read() -> Result<StoredAccounts, String> {
    read_from(&path()?)
}

pub(super) fn read_from(path: &std::path::Path) -> Result<StoredAccounts, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(StoredAccounts::default()),
        Err(_) => return Err(storage_error()),
    };
    let stored: StoredAccounts = serde_json::from_slice(&bytes).map_err(|_| storage_error())?;
    let mut ids = std::collections::HashSet::new();
    if stored.version != 1
        || stored.connections.len() > 100
        || stored.connections.iter().any(|r| {
            r.connection_id.is_empty()
                || !ids.insert(&r.connection_id)
                || r.api_key.is_empty()
                || r.api_key.len() > 8192
                || r.identity_fingerprint.len() != 64
        })
        || matches!(&stored.primary, Primary::Connection { connection_id } if !stored.connections.iter().any(|r| &r.connection_id == connection_id))
    {
        return Err(storage_error());
    }
    for r in &stored.connections {
        crate::plugin_engine::host_api::register_secret_for_redaction(&r.api_key);
    }
    Ok(stored)
}

pub(super) fn write(stored: &mut StoredAccounts, projection_changed: bool) -> Result<(), String> {
    stored.revision = stored.revision.checked_add(1).ok_or_else(storage_error)?;
    if projection_changed {
        stored.projection_revision = stored
            .projection_revision
            .checked_add(1)
            .ok_or_else(storage_error)?;
    }
    if projection_changed {
        clear_projection()?;
    }
    write_to(&path()?, stored)?;
    Ok(())
}

#[cfg(test)]
thread_local! { pub(super) static FAIL_CLEAR: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

fn clear_projection() -> Result<(), String> {
    #[cfg(test)]
    if FAIL_CLEAR.with(|fail| fail.get()) {
        return Err("synthetic cache cleanup failure".into());
    }
    crate::clear_ollama_projection()
}

pub(super) fn write_to(path: &std::path::Path, stored: &StoredAccounts) -> Result<(), String> {
    let text = serde_json::to_string(stored).map_err(|_| storage_error())?;
    crate::safe_file::write_text(path, &text).map_err(|_| storage_error())
}

pub(super) fn storage_error() -> String {
    log::error!("Ollama account storage could not be read or updated; existing files kept");
    "无法读取或保存 Ollama 账号配置。原配置文件已保留，请检查文件访问权限。".into()
}

pub(super) fn changed() -> String {
    "连接已发生变化，请重新打开或验证 Key。".into()
}

pub(super) fn validate_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 40 || label.chars().any(char::is_control) {
        return Err("名称须为 1 到 40 个字符。".into());
    }
    Ok(label.to_string())
}

pub(super) fn validate_key(key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty()
        || key.len() > 8192
        || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("请填写有效的 Ollama API Key。".into());
    }
    crate::plugin_engine::host_api::register_secret_for_redaction(key);
    Ok(key.into())
}

pub(super) fn apply_probe(
    record: &mut Record,
    result: Result<AccountProbe, AccountError>,
    plugin: &crate::plugin_engine::manifest::LoadedPlugin,
) {
    match result {
        Ok(probe) if probe.identity.fingerprint == record.identity_fingerprint => {
            record.identity = probe.identity.display;
            record.snapshot = Some(super::output(plugin, probe.plan, probe.lines));
            record.last_updated_at = Some(super::now());
            record.error = None;
        }
        Ok(_) => {
            record.snapshot = None;
            record.last_updated_at = None;
            record.error = Some(super::runtime::friendly_error("identityChanged"));
        }
        Err(error) => {
            if error.code == "identityChanged" {
                record.snapshot = None;
                record.last_updated_at = None;
            }
            record.error = Some(error);
        }
    }
}

#[cfg(test)]
#[path = "store_poison_tests.rs"]
mod poison_tests;
