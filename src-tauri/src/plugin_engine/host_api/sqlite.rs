//! All SQLite subprocesses share their call budget across any read fallback.
use super::*;
use std::process::{Command, Output};

fn sqlite_command(path: &str, sql: &str, readonly: bool) -> Command {
    let mut command = Command::new("sqlite3");
    if readonly {
        command.args(["-readonly", "-json"]);
    }
    command.arg("--").arg(path).arg(sql);
    command
}
fn execute(
    path: &str,
    sql: &str,
    readonly: bool,
    deadline: Instant,
) -> Result<Output, &'static str> {
    crate::bounded_process::run(
        &mut sqlite_command(path, sql, readonly),
        None,
        deadline,
        8 * 1024 * 1024,
    )
    .map_err(|error| match error.kind() {
        std::io::ErrorKind::TimedOut => "SQLite read timed out. Try again.",
        std::io::ErrorKind::InvalidData => "SQLite response exceeded its limit.",
        _ => "SQLite process could not complete.",
    })
}
fn read(path: &str, sql: &str, strict: bool, deadline: Instant) -> Result<String, &'static str> {
    let primary = execute(path, sql, true, deadline)?;
    if primary.status.success() {
        return Ok(String::from_utf8_lossy(&primary.stdout).into_owned());
    }
    if strict {
        return Err("SQLite read failed. Check the local connection.");
    }
    let encoded = path
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('?', "%3F");
    let fallback = execute(&format!("file:{encoded}?immutable=1"), sql, true, deadline)?;
    if !fallback.status.success() {
        return Err("SQLite read failed. Check the local connection.");
    }
    Ok(String::from_utf8_lossy(&fallback.stdout).into_owned())
}
pub(super) fn inject<'js>(
    ctx: &Ctx<'js>,
    host: &Object<'js>,
    deadline: ProbeDeadline,
) -> rquickjs::Result<()> {
    let sqlite = Object::new(ctx.clone())?;
    for (name, strict) in [("query", false), ("queryReadOnly", true)] {
        sqlite.set(
            name,
            Function::new(
                ctx.clone(),
                move |vm: Ctx<'_>, path: String, sql: String| -> rquickjs::Result<String> {
                    if sql.lines().any(|line| line.trim_start().starts_with('.')) {
                        return Err(Exception::throw_message(
                            &vm,
                            "sqlite3 dot-commands are not allowed",
                        ));
                    }
                    let budget = deadline
                        .clamp_duration(Duration::from_secs(10))
                        .ok_or_else(|| probe_timeout_error(&vm))?;
                    read(&expand_path(&path), &sql, strict, Instant::now() + budget).map_err(
                        |message| {
                            log::warn!("SQLite query failed: {message}");
                            Exception::throw_message(&vm, message)
                        },
                    )
                },
            )?,
        )?;
    }
    sqlite.set(
        "exec",
        Function::new(
            ctx.clone(),
            move |vm: Ctx<'_>, path: String, sql: String| -> rquickjs::Result<()> {
                if sql.lines().any(|line| line.trim_start().starts_with('.')) {
                    return Err(Exception::throw_message(
                        &vm,
                        "sqlite3 dot-commands are not allowed",
                    ));
                }
                let budget = deadline
                    .clamp_duration(Duration::from_secs(10))
                    .ok_or_else(|| probe_timeout_error(&vm))?;
                let output = execute(&expand_path(&path), &sql, false, Instant::now() + budget)
                    .map_err(|message| {
                        log::warn!("SQLite statement failed: {message}");
                        Exception::throw_message(&vm, message)
                    })?;
                if !output.status.success() {
                    log::warn!("SQLite statement failed");
                    return Err(Exception::throw_message(&vm, "SQLite statement failed."));
                }
                Ok(())
            },
        )?,
    )?;
    host.set("sqlite", sqlite)
}
#[cfg(test)]
#[path = "sqlite_tests.rs"]
mod tests;
