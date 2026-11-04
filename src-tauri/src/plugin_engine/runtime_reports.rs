use super::*;
use crate::provider_reports::ReportsOutput;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub(crate) fn run_reports(
    plugin: &LoadedPlugin,
    app_data_dir: &PathBuf,
    app_version: &str,
    deadline_at: Instant,
    cancelled: Arc<AtomicBool>,
) -> Result<ReportsOutput, String> {
    run_reports_with_configuration(
        plugin,
        app_data_dir,
        app_version,
        deadline_at,
        cancelled,
        None,
    )
}

pub(crate) fn run_reports_with_configuration(
    plugin: &LoadedPlugin,
    app_data_dir: &PathBuf,
    app_version: &str,
    deadline_at: Instant,
    cancelled: Arc<AtomicBool>,
    configuration: Option<&std::collections::HashMap<String, serde_json::Value>>,
) -> Result<ReportsOutput, String> {
    let check = || {
        if cancelled.load(Ordering::Acquire) {
            Err("Server reports request was cancelled.".to_string())
        } else if Instant::now() >= deadline_at {
            Err("Server reports timed out. Try again.".to_string())
        } else {
            Ok(())
        }
    };
    check()?;
    let runtime = Runtime::new().map_err(|_| "Could not start server reports.")?;
    let interrupt = Arc::clone(&cancelled);
    runtime.set_interrupt_handler(Some(Box::new(move || {
        interrupt.load(Ordering::Acquire) || Instant::now() >= deadline_at
    })));
    let context = Context::full(&runtime).map_err(|_| "Could not start report context.")?;
    let result = context.with(|ctx| {
        let config = plugin
            .manifest
            .config
            .as_ref()
            .map(|c| c.fields.as_slice())
            .unwrap_or(&[]);
        host_api::inject_host_api_with_deadline(
            &ctx,
            &plugin.manifest.id,
            app_data_dir,
            app_version,
            config,
            host_api::ProbeDeadline::at(deadline_at),
        )
        .map_err(|_| "Could not load report settings.".to_string())?;
        if let Some(configuration) = configuration {
            host_api::override_configuration(&ctx, configuration)
                .map_err(|_| "Could not load this account's report settings.".to_string())?;
        }
        host_api::patch_http_wrapper(&ctx)
            .map_err(|_| "Could not prepare report transport.".to_string())?;
        host_api::inject_utils(&ctx)
            .map_err(|_| "Could not prepare report helpers.".to_string())?;
        ctx.eval::<(), _>(plugin.entry_script.as_bytes())
            .map_err(|_| "Could not load report plugin.".to_string())?;
        check()?;
        let globals = ctx.globals();
        let plugin_object: Object = globals
            .get("__openusage_plugin")
            .map_err(|_| "Report plugin is unavailable.".to_string())?;
        let function: rquickjs::Function = plugin_object
            .get("probeReports")
            .map_err(|_| "Server reports are unavailable for this plugin.".to_string())?;
        let input: Value = globals
            .get("__openusage_ctx")
            .map_err(|_| "Report context is unavailable.".to_string())?;
        let value: Value = function
            .call((input,))
            .map_err(|_| extract_error_string(&ctx))?;
        let object: Object = if let Some(promise) = value.clone().into_promise() {
            promise.finish().map_err(|_| extract_error_string(&ctx))?
        } else {
            value.into_object().ok_or("Report result is invalid.")?
        };
        check()?;
        let stringify: rquickjs::Function = globals
            .get::<_, Object>("JSON")
            .and_then(|json| json.get("stringify"))
            .map_err(|_| "Report serialization is unavailable.".to_string())?;
        let serialized: String = stringify
            .call((object,))
            .map_err(|_| "Report result cannot be read.".to_string())?;
        if serialized.len() > 2 * 1024 * 1024 {
            return Err("Report result is too large.".to_string());
        }
        let output: ReportsOutput = serde_json::from_str(&serialized)
            .map_err(|_| "Report result has invalid fields.".to_string())?;
        validate(&output)?;
        check()?;
        Ok(output)
    });
    check()?;
    result
}

fn valid_date(date: &str) -> bool {
    time::format_description::parse("[year]-[month]-[day]")
        .ok()
        .is_some_and(|format| date.len() == 10 && time::Date::parse(date, &format).is_ok())
}

fn validate(output: &ReportsOutput) -> Result<(), String> {
    let bad = || "Report result has invalid fields.".to_string();
    if output.scope_key.len() != 64
        || !output
            .scope_key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || output.lines.len() > 512
        || output.reports.is_empty()
        || output.reports.len() > 16
    {
        return Err(bad());
    }
    let mut ids = std::collections::HashSet::new();
    for report in &output.reports {
        if report.id.is_empty()
            || report.id.len() > 128
            || !ids.insert(&report.id)
            || report.label.is_empty()
            || report.label.len() > 256
            || report.message.as_ref().is_some_and(|s| s.len() > 4096)
        {
            return Err(bad());
        }
        if report.retry_at.as_ref().is_some_and(|s| {
            time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).is_err()
        }) {
            return Err(bad());
        }
        if let Some(coverage) = &report.coverage {
            if coverage.time_zone != "UTC"
                || !valid_date(&coverage.from_date)
                || !valid_date(&coverage.to_date)
                || coverage.from_date > coverage.to_date
                || coverage.reported_dates.len() > 366
                || coverage.missing_dates.len() > 366
            {
                return Err(bad());
            }
            let mut dates = std::collections::HashSet::new();
            for date in coverage
                .reported_dates
                .iter()
                .chain(&coverage.missing_dates)
            {
                if !valid_date(date)
                    || date < &coverage.from_date
                    || date > &coverage.to_date
                    || !dates.insert(date)
                {
                    return Err(bad());
                }
            }
        }
    }
    for line in &output.lines {
        match line {
            MetricLine::Text {
                label,
                value,
                subtitle,
                ..
            } if !label.is_empty()
                && label.len() <= 256
                && value.len() <= 16384
                && subtitle.as_ref().is_none_or(|s| s.len() <= 4096) => {}
            MetricLine::BarChart {
                label,
                points,
                note,
                ..
            } if !label.is_empty()
                && label.len() <= 256
                && !points.is_empty()
                && points.len() <= 366
                && note.as_ref().is_none_or(|s| s.len() <= 4096)
                && points.iter().all(|p| {
                    !p.label.is_empty()
                        && p.label.len() <= 256
                        && p.value.is_finite()
                        && p.value >= 0.0
                        && p.value_label.as_ref().is_none_or(|s| s.len() <= 1024)
                }) => {}
            _ => return Err(bad()),
        }
    }
    Ok(())
}
