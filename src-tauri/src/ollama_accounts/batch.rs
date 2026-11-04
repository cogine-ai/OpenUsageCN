use super::{Primary, legacy, model::AccountError, store};
use crate::plugin_engine::{manifest::LoadedPlugin, runtime::PluginOutput};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Clone)]
enum Target {
    Legacy,
    Named(String),
}

/// GUI refreshes independent rows; the returned single projection is still explicitly selected.
#[cfg(test)]
pub(super) fn run_gui_probe(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
    changed: impl Fn() + Sync,
) -> (PluginOutput, Option<String>) {
    let deadline = Instant::now() + Duration::from_secs(60);
    run_gui_probe_before(plugin, dir, version, deadline, changed)
}

pub(crate) fn run_gui_probe_before(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
    deadline: Instant,
    changed: impl Fn() + Sync,
) -> (PluginOutput, Option<String>) {
    let prepared = (|| {
        legacy::synchronize(plugin, deadline)?;
        let _guard = store::lock_until(deadline)?;
        let stored = store::read()?;
        let stamp = super::generation_before(plugin, &stored, deadline)?;
        Ok::<_, String>((stored, stamp))
    })();
    let (stored, stamp) = match prepared {
        Ok(value) => value,
        Err(error) => {
            return (
                crate::plugin_engine::runtime::provider_account_probe_error(plugin, &error),
                None,
            );
        }
    };
    if let Err(error) = refresh_all(plugin, dir, version, &stored, deadline, &changed) {
        log::error!(
            "Ollama all-account refresh could not complete: {}",
            crate::plugin_engine::host_api::redact_log_message(&error)
        );
    }
    let output = (|| {
        let _guard = store::lock_until(deadline)?;
        let current = store::read()?;
        if super::generation_before(plugin, &current, deadline)? != stamp {
            return Err(store::changed());
        }
        Ok(primary_output(plugin, &current))
    })()
    .unwrap_or_else(|error: String| {
        crate::plugin_engine::runtime::provider_account_probe_error(plugin, &error)
    });
    changed();
    (output, Some(stamp))
}

pub(super) fn refresh_all(
    plugin: &LoadedPlugin,
    dir: &PathBuf,
    version: &str,
    stored: &super::model::StoredAccounts,
    deadline: Instant,
    changed: &(impl Fn() + Sync),
) -> Result<(), String> {
    let mut targets: Vec<_> = stored
        .connections
        .iter()
        .map(|r| Target::Named(r.connection_id.clone()))
        .collect();
    if stored.legacy.configured {
        targets.push(Target::Legacy);
    }
    // Start the selected row promptly without issuing a second request for it.
    targets.sort_by_key(|target| match (target, &stored.primary) {
        (Target::Legacy, Primary::Legacy) => 0,
        (Target::Named(id), Primary::Connection { connection_id }) if id == connection_id => 0,
        _ => 1,
    });
    let queue = Mutex::new(VecDeque::from(targets));
    let failures = Mutex::new(Vec::new());
    // Reserve time to record unfinished rows. Neither one slow account nor one lock blocks siblings.
    let work_deadline = deadline
        .checked_sub(Duration::from_millis(250))
        .unwrap_or(deadline);
    #[cfg(test)]
    let test_path = store::TEST_PATH.with(|value| value.borrow().clone());
    #[cfg(test)]
    let test_env = legacy::TEST_ENV.with(|value| value.borrow().clone());
    #[cfg(test)]
    let test_configuration = legacy::TEST_CONFIGURATION.with(|value| value.borrow().clone());
    std::thread::scope(|scope| {
        for _ in 0..4.min(stored.connections.len() + usize::from(stored.legacy.configured)) {
            let queue = &queue;
            let failures = &failures;
            let changed = &changed;
            #[cfg(test)]
            let test_path = test_path.clone();
            #[cfg(test)]
            let test_env = test_env.clone();
            #[cfg(test)]
            let test_configuration = test_configuration.clone();
            scope.spawn(move || {
                #[cfg(test)]
                {
                    store::TEST_PATH.with(|value| *value.borrow_mut() = test_path);
                    legacy::TEST_ENV.with(|value| *value.borrow_mut() = test_env);
                    legacy::TEST_CONFIGURATION
                        .with(|value| *value.borrow_mut() = test_configuration);
                }
                loop {
                    let target = queue.lock().unwrap_or_else(|p| p.into_inner()).pop_front();
                    let Some(target) = target else { break };
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let account_deadline =
                            work_deadline.min(Instant::now() + Duration::from_secs(30));
                        match &target {
                            Target::Legacy => {
                                legacy::refresh(plugin, dir, version, account_deadline).map(|_| ())
                            }
                            Target::Named(id) => {
                                super::refresh(plugin, dir, version, id, account_deadline)
                            }
                        }
                    }))
                    .unwrap_or_else(|_| {
                        log::error!("Ollama account refresh worker panicked");
                        Err("账号刷新意外停止，请重试；上次成功数据已保留。".into())
                    });
                    if let Err(error) = result {
                        log::warn!(
                            "Ollama individual refresh did not complete: {}",
                            crate::plugin_engine::host_api::redact_log_message(&error)
                        );
                        failures
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .push((target, error));
                    }
                    changed();
                }
            });
        }
    });
    let failures = failures.into_inner().unwrap_or_else(|p| p.into_inner());
    if !failures.is_empty() {
        let _guard = store::lock_until(deadline)?;
        let mut current = store::read()?;
        for (target, message) in failures {
            let error = Some(AccountError {
                code: "refreshIncomplete".into(),
                message,
            });
            match target {
                Target::Legacy
                    if current.legacy.revision == stored.legacy.revision
                        && current.legacy.last_updated_at == stored.legacy.last_updated_at =>
                {
                    current.legacy.error = error
                }
                Target::Named(id) => {
                    if let Some(row) = current
                        .connections
                        .iter_mut()
                        .find(|r| r.connection_id == id)
                    {
                        if stored.connections.iter().any(|old| {
                            old.connection_id == id
                                && old.revision == row.revision
                                && old.last_updated_at == row.last_updated_at
                        }) {
                            row.error = error;
                        }
                    }
                }
                _ => (),
            }
        }
        store::write_before(&mut current, false, Some(deadline))?;
    }
    Ok(())
}

fn primary_output(plugin: &LoadedPlugin, stored: &super::model::StoredAccounts) -> PluginOutput {
    let fail = |message: &str| {
        crate::plugin_engine::runtime::provider_account_probe_error(plugin, message)
    };
    match &stored.primary {
        Primary::Legacy => legacy::current_output(plugin, stored),
        Primary::None => fail("尚未设置主账号；请在账号管理中选择菜单栏和本地 API 使用的连接。"),
        Primary::Connection { connection_id } => stored
            .connections
            .iter()
            .find(|r| &r.connection_id == connection_id)
            .map(|row| {
                row.error
                    .as_ref()
                    .map(|error| fail(&error.message))
                    .or_else(|| row.snapshot.clone())
                    .unwrap_or_else(|| fail("此账号尚未读取用量，请刷新。"))
            })
            .unwrap_or_else(|| fail("主账号已变化，请刷新。")),
    }
}
