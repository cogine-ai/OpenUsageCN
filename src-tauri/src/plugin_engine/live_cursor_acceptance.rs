//! Opt-in device acceptance. Never part of CI; uses the real Desktop login read-only.
use super::{account_runtime, host_api, manifest, runtime};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};

struct AcceptanceLogger;
impl log::Log for AcceptanceLogger {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        let message = record.args().to_string();
        if message.contains("[plugin:cursor]") && message.contains("HTTP ") {
            let endpoint = if message.contains("/api/auth/me") {
                "identity"
            } else if message.contains("/oauth/token") {
                "token refresh"
            } else {
                "quota"
            };
            if let Some((_, tail)) = message.split_once(" -> ") {
                if let Some(status) = tail
                    .split_whitespace()
                    .next()
                    .filter(|s| s.len() == 3 && s.bytes().all(|c| c.is_ascii_digit()))
                {
                    println!("ACCEPTANCE: {endpoint} response status={status}");
                }
            } else {
                println!("ACCEPTANCE: {endpoint} request started");
            }
        }
        if message.contains("scoped identity verification request failed") {
            println!("ACCEPTANCE: identity transport failed before a response was received");
        }
        if message.contains("scoped identity verification failed") {
            println!("ACCEPTANCE: identity response was rejected");
        }
    }
    fn flush(&self) {}
}
static LOGGER: AcceptanceLogger = AcceptanceLogger;
fn log_acceptance() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);
}

struct LoginSnapshot {
    database: Vec<u8>,
    keychain: Vec<u8>,
}

fn snapshot() -> LoginSnapshot {
    let db = dirs::home_dir()
        .unwrap()
        .join("Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    let output = Command::new("/usr/bin/sqlite3").arg("-readonly").arg("-json").arg(db)
        .arg("SELECT key,value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/refreshToken','cursorAuth/cachedEmail','cursorAuth/stripeMembershipType','cursorAuth/stripeSubscriptionStatus') ORDER BY key")
        .output().expect("Cursor login database could not be inspected");
    assert!(
        output.status.success(),
        "Cursor login database could not be inspected"
    );
    let rows: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("Invalid login database response");
    for key in ["cursorAuth/accessToken", "cursorAuth/refreshToken"] {
        let row = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["key"] == key)
            .expect("Desktop credential is missing");
        assert!(
            row["value"]
                .as_str()
                .unwrap()
                .starts_with("cursor-safe-storage:v1:"),
            "Expected encrypted Desktop credentials"
        );
    }
    // No -w or -g: snapshot item metadata, including modification date, never password data.
    let metadata = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "Cursor Safe Storage",
            "-a",
            "Cursor Key",
        ])
        .output()
        .expect("Keychain metadata could not be inspected");
    assert!(
        metadata.status.success(),
        "Cursor Key item metadata is unavailable"
    );
    LoginSnapshot {
        database: Sha256::digest(output.stdout).to_vec(),
        keychain: Sha256::digest(metadata.stdout).to_vec(),
    }
}

#[test]
#[ignore = "Uses this Mac's real Cursor login and makes authenticated read-only usage requests"]
fn encrypted_desktop_login_and_live_usage_remain_read_only() {
    assert_eq!(
        std::env::var("OPENUSAGE_LIVE_CURSOR_ACCEPTANCE").as_deref(),
        Ok("1"),
        "Explicit device acceptance opt-in required"
    );
    log_acceptance();
    let before = snapshot();
    let plugins = manifest::load_plugins_from_dir(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"),
    );
    let plugin = plugins
        .iter()
        .find(|plugin| plugin.manifest.id == "cursor")
        .expect("Cursor plugin missing");
    let temporary = tempfile::tempdir().unwrap();
    let app_data = temporary.path().to_path_buf();
    let result = (|| -> Result<(), String> {
        let mut password = super::keychain_control::read_password(
            "Cursor Safe Storage",
            Some("Cursor Key"),
            host_api::ProbeDeadline::at(Instant::now() + Duration::from_secs(10)),
        )?;
        unsafe {
            password.as_bytes_mut().fill(0);
        }
        let generation = account_runtime::credential_generation(
            plugin,
            &app_data,
            "device-acceptance",
            "cursor-desktop",
        )?;
        println!("ACCEPTANCE: Keychain read and encrypted Desktop credential decoding succeeded.");
        for iteration in 1..=2 {
            let output = runtime::run_probe_for_connection(
                plugin,
                &app_data,
                "device-acceptance",
                "cursor-desktop",
                &generation,
            );
            if let Some(error) = runtime::probe_error_message(&output) {
                return Err(host_api::redact_log_message(error));
            }
            let metrics = output
                .lines
                .iter()
                .filter(|line| matches!(line, runtime::MetricLine::Progress { .. }))
                .count();
            if metrics == 0 {
                return Err("Real Cursor response contained no quota metrics.".into());
            }
            let unchanged = account_runtime::credential_generation(
                plugin,
                &app_data,
                "device-acceptance",
                "cursor-desktop",
            )? == generation;
            if !unchanged {
                return Err("Desktop credentials changed during device acceptance.".into());
            }
            println!(
                "ACCEPTANCE: live quota refresh {iteration} succeeded; {metrics} quota metrics; credential generation unchanged."
            );
        }
        Ok(())
    })();
    // Perform the integrity checks even when Keychain or the network rejects the attempt.
    let after = snapshot();
    assert!(
        before.database == after.database,
        "Cursor login state changed during acceptance; do not overwrite or restore automatically"
    );
    assert!(
        before.keychain == after.keychain,
        "Keychain item metadata changed during acceptance"
    );
    println!(
        "ACCEPTANCE: encrypted access/refresh credentials, cached login identity/plan, and Keychain item metadata are unchanged."
    );
    if let Err(error) = result {
        panic!("Device acceptance blocked: {error}");
    }
}

fn cli_snapshot() -> Result<Vec<u8>, String> {
    let mut digest = Sha256::new();
    for service in ["cursor-access-token", "cursor-refresh-token"] {
        let mut value = super::keychain_control::read_password(
            service,
            None,
            host_api::ProbeDeadline::at(Instant::now() + Duration::from_secs(10)),
        )?;
        digest.update(value.as_bytes());
        unsafe {
            value.as_bytes_mut().fill(0);
        }
        let output = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", service])
            .output()
            .map_err(|_| "CLI Keychain metadata inspection failed.")?;
        if !output.status.success() {
            return Err("CLI Keychain metadata inspection failed.".into());
        }
        digest.update(output.stdout);
    }
    Ok(digest.finalize().to_vec())
}

#[test]
#[ignore = "Uses this Mac's real Cursor CLI login for authenticated read-only quota requests"]
fn cli_login_and_live_usage_remain_read_only() {
    assert_eq!(
        std::env::var("OPENUSAGE_LIVE_CURSOR_ACCEPTANCE").as_deref(),
        Ok("1")
    );
    log_acceptance();
    let desktop_before = snapshot();
    let cli_before = cli_snapshot().expect("CLI Keychain is not readable");
    let plugins = manifest::load_plugins_from_dir(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"),
    );
    let plugin = plugins.iter().find(|p| p.manifest.id == "cursor").unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let app_data = temporary.path().to_path_buf();
    let result = (|| -> Result<(), String> {
        let js = rquickjs::Runtime::new().unwrap();
        let context = rquickjs::Context::full(&js).unwrap();
        context.with(|ctx| {
            host_api::inject_host_api_with_deadline(&ctx, "cursor", &app_data, "device-acceptance", &[],
                host_api::ProbeDeadline::at(Instant::now() + Duration::from_secs(10))).unwrap();
            host_api::inject_utils(&ctx).unwrap();
            let diagnostic: String = ctx.eval(r#"JSON.stringify((function(){
                try {
                    const value = __openusage_ctx.host.keychain.readGenericPassword("cursor-access-token");
                    const payload = __openusage_ctx.jwt.decodePayload(value);
                    return {readable: true, length: value.length, subjectPresent: !!(payload && payload.sub)};
                } catch (e) { return {readable:false, error:String(e)}; }
            })())"#).unwrap();
            println!("ACCEPTANCE: JS credential structure: {}", host_api::redact_log_message(&diagnostic));
        });
        let generation = account_runtime::credential_generation(
            plugin,
            &app_data,
            "device-acceptance",
            "cursor-cli",
        )?;
        println!(
            "ACCEPTANCE: CLI access and refresh Keychain entries can be read without an authorization prompt."
        );
        for iteration in 1..=2 {
            let output = runtime::run_probe_for_connection(
                plugin,
                &app_data,
                "device-acceptance",
                "cursor-cli",
                &generation,
            );
            if let Some(error) = runtime::probe_error_message(&output) {
                return Err(host_api::redact_log_message(error));
            }
            let metrics = output
                .lines
                .iter()
                .filter(|line| matches!(line, runtime::MetricLine::Progress { .. }))
                .count();
            if metrics == 0 {
                return Err("Real Cursor CLI response contained no quota metrics.".into());
            }
            println!(
                "ACCEPTANCE: CLI real quota refresh {iteration} succeeded with {metrics} metrics."
            );
        }
        Ok(())
    })();
    let desktop_after = snapshot();
    let cli_after = cli_snapshot().expect("CLI Keychain is no longer readable");
    assert!(
        desktop_before.database == desktop_after.database
            && desktop_before.keychain == desktop_after.keychain,
        "Desktop login state or Keychain metadata changed"
    );
    assert!(
        cli_before == cli_after,
        "CLI credentials or Keychain metadata changed"
    );
    println!(
        "ACCEPTANCE: both CLI Keychain credential values/metadata and Desktop encrypted credentials/login metadata are unchanged."
    );
    if let Err(error) = result {
        panic!("CLI device acceptance failed: {error}");
    }
}

#[test]
#[ignore = "Direct read-only endpoint diagnostic; does not publish a snapshot to any account"]
fn direct_cli_quota_endpoint_diagnostic_remains_read_only() {
    assert_eq!(
        std::env::var("OPENUSAGE_LIVE_CURSOR_ACCEPTANCE").as_deref(),
        Ok("1")
    );
    let desktop_before = snapshot();
    let cli_before = cli_snapshot().expect("CLI Keychain is not readable");
    let result = (|| -> Result<(), String> {
        let mut token = super::keychain_control::read_password(
            "cursor-access-token",
            None,
            host_api::ProbeDeadline::at(Instant::now() + Duration::from_secs(10)),
        )?;
        let client = crate::config::blocking_client_builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Diagnostic client could not be created.")?;
        let response = client
            .post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage")
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .header("Connect-Protocol-Version", "1")
            .body("{}")
            .send();
        unsafe {
            token.as_bytes_mut().fill(0);
        }
        let response = response.map_err(|_| "Quota diagnostic transport failed.")?;
        println!(
            "ACCEPTANCE: direct CLI quota endpoint status={}",
            response.status().as_u16()
        );
        if !response.status().is_success() {
            return Err("Quota endpoint rejected the diagnostic request.".into());
        }
        let body = response
            .bytes()
            .map_err(|_| "Quota response body could not be read.")?;
        let payload: serde_json::Value =
            serde_json::from_slice(&body).map_err(|_| "Quota endpoint returned invalid JSON.")?;
        let plan = payload
            .get("planUsage")
            .and_then(|v| v.as_object())
            .ok_or("Quota response did not contain planUsage.")?;
        let fields: Vec<_> = [
            "totalPercentUsed",
            "autoPercentUsed",
            "apiPercentUsed",
            "totalSpend",
            "limit",
            "remaining",
        ]
        .into_iter()
        .filter(|field| {
            plan.get(*field)
                .is_some_and(|value| value.as_f64().is_some_and(f64::is_finite))
        })
        .collect();
        if fields.is_empty() {
            return Err("Quota response did not contain valid numeric metrics.".into());
        }
        println!(
            "ACCEPTANCE: quota response has valid numeric fields: {}; not published because scoped identity acceptance is blocked.",
            fields.join(", ")
        );
        Ok(())
    })();
    let desktop_after = snapshot();
    let cli_after = cli_snapshot().expect("CLI Keychain is no longer readable");
    assert!(
        desktop_before.database == desktop_after.database
            && desktop_before.keychain == desktop_after.keychain
            && cli_before == cli_after,
        "Login credential or Keychain metadata changed"
    );
    println!("ACCEPTANCE: all checked login credentials and Keychain metadata are unchanged.");
    if let Err(error) = result {
        panic!("Direct quota diagnostic failed: {error}");
    }
}
