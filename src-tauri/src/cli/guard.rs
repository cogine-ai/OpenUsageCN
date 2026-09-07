use crate::local_http_api::limits::LimitsEnvelope;
use crate::plugin_engine::manifest::LimitResourceKind;
use crate::usage_reader::{LimitsRead, LimitsReadError, read_limits_once};
use serde::Serialize;
use std::io::Write;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(super) const USAGE: &str =
    "openusage guard <provider> [--window session|weekly] [--min-remaining <percent>] [--force]";

struct Arguments {
    provider_id: String,
    window: String,
    min_remaining: f64,
    force: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Decision {
    schema: &'static str,
    provider_id: String,
    window: String,
    min_remaining_percent: f64,
    decision: &'static str,
    reason: &'static str,
    remaining_percent: Option<f64>,
    fetched_at: Option<String>,
    expires_at: Option<String>,
}

impl Decision {
    fn unknown(args: &Arguments, reason: &'static str) -> Self {
        Self {
            schema: "openusage.guard.v1",
            provider_id: args.provider_id.clone(),
            window: args.window.clone(),
            min_remaining_percent: args.min_remaining,
            decision: "unknown",
            reason,
            remaining_percent: None,
            fetched_at: None,
            expires_at: None,
        }
    }

    fn exit_code(&self) -> i32 {
        match self.decision {
            "allowed" => 0,
            "blocked" => 1,
            _ => 3,
        }
    }
}

pub(super) fn run(args: &[String]) -> i32 {
    execute(
        args,
        read_limits_once,
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    )
}

fn execute(
    raw: &[String],
    read: impl FnOnce(Option<&str>, bool) -> Result<LimitsRead, LimitsReadError>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let args = match parse(raw) {
        Ok(args) => args,
        Err(message) => {
            let _ = writeln!(err, "openusage: {message}\nUsage: {USAGE}");
            return 2;
        }
    };
    let result = match read(Some(&args.provider_id), args.force) {
        Ok(read) => evaluate(
            &args,
            &read.envelope,
            read.refresh_failed,
            OffsetDateTime::now_utc(),
        ),
        Err(LimitsReadError::UnknownProvider(id)) => {
            let _ = writeln!(err, "openusage: unknown provider '{id}'");
            return 2;
        }
        Err(error) => {
            let message = match error {
                LimitsReadError::NoDataDirectory => {
                    "could not locate the OpenUsageCN data directory"
                }
                _ => "no OpenUsageCN provider plugins were found",
            };
            let _ = writeln!(err, "openusage: {message}");
            Decision::unknown(&args, "read_failed")
        }
    };
    let exit_code = result.exit_code();
    if let Err(error) = serde_json::to_writer(&mut *out, &result)
        .map_err(std::io::Error::other)
        .and_then(|()| writeln!(out))
    {
        let _ = writeln!(err, "openusage: could not write guard result: {error}");
        return 4;
    }
    exit_code
}

fn parse(raw: &[String]) -> Result<Arguments, String> {
    let mut provider = None;
    let mut window = None;
    let mut min_remaining = None;
    let mut force = false;
    let mut args = raw.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--force" if !force => force = true,
            "--window" if window.is_none() => {
                let value = args.next().ok_or("--window requires session or weekly")?;
                if !matches!(value.as_str(), "session" | "weekly") {
                    return Err("--window must be session or weekly".into());
                }
                window = Some(value.clone());
            }
            "--min-remaining" if min_remaining.is_none() => {
                let value = args.next().ok_or("--min-remaining requires a percentage")?;
                let percent = value
                    .parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite() && (0.0..=100.0).contains(n))
                    .ok_or("--min-remaining must be a number between 0 and 100")?;
                min_remaining = Some(percent);
            }
            value if !value.starts_with('-') && provider.is_none() => {
                provider = Some(value.to_string());
            }
            _ => return Err(format!("unexpected or repeated argument '{arg}'")),
        }
    }
    Ok(Arguments {
        provider_id: provider.ok_or("guard requires one provider")?,
        window: window.unwrap_or_else(|| "session".into()),
        min_remaining: min_remaining.unwrap_or(10.0),
        force,
    })
}

fn evaluate(
    args: &Arguments,
    envelope: &LimitsEnvelope,
    refresh_failed: bool,
    now: OffsetDateTime,
) -> Decision {
    let mut result = Decision::unknown(args, "no_snapshot");
    if refresh_failed
        || envelope
            .errors
            .iter()
            .any(|error| error.provider_id == args.provider_id)
    {
        result.reason = "refresh_failed";
        return result;
    }
    let Some(provider) = envelope.providers.get(&args.provider_id) else {
        return result;
    };
    result.fetched_at = Some(provider.fetched_at.clone());
    result.expires_at = Some(provider.expires_at.clone());
    if provider.stale
        || OffsetDateTime::parse(&provider.expires_at, &Rfc3339)
            .map_or(true, |expires| now >= expires)
    {
        result.reason = "stale";
        return result;
    }
    let Some(resource) = provider.resources.get(&args.window) else {
        result.reason = "window_unavailable";
        return result;
    };
    if let Some(reset) = &resource.resets_at {
        match OffsetDateTime::parse(reset, &Rfc3339) {
            Ok(reset) if reset > now => {}
            Ok(_) => {
                result.reason = "window_reset";
                return result;
            }
            Err(_) => {
                result.reason = "invalid_data";
                return result;
            }
        }
    }
    let (Some(remaining), Some(limit)) = (resource.remaining, resource.limit) else {
        result.reason = "invalid_data";
        return result;
    };
    if resource.kind != LimitResourceKind::Consumption
        || !remaining.is_finite()
        || !limit.is_finite()
        || limit <= 0.0
        || remaining < 0.0
        || remaining > limit
    {
        result.reason = "invalid_data";
        return result;
    }
    let percent = remaining / limit * 100.0;
    result.remaining_percent = Some(percent);
    if percent >= args.min_remaining {
        result.decision = "allowed";
        result.reason = "threshold_met";
    } else {
        result.decision = "blocked";
        result.reason = "below_threshold";
    }
    result
}

#[cfg(test)]
#[path = "guard_tests.rs"]
mod tests;
