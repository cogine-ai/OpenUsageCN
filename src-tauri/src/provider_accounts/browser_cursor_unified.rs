//! Current-user monthly additional spend; never sum credits or model-history charges.
use crate::plugin_engine::runtime::{MetricLine, PluginOutput, ProgressFormat};
use serde_json::Value;
use std::io::Read;
use std::time::Duration;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const URL: &str = "https://cursor.com/api/dashboard/v2/usage-status?scope=user";
const MAX_BODY: u64 = 1024 * 1024;

pub(super) struct MonthlySpend {
    pub used: f64,
    pub limit: f64,
    pub start: String,
    pub reset: String,
}
fn is_personal(summary: &Value) -> bool {
    summary["membershipType"]
        .as_str()
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("unified_"))
        && summary["limitType"]
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case("user"))
}
fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}
pub(super) fn decode(
    summary: &Value,
    payload: &Value,
    now: OffsetDateTime,
) -> Result<Option<MonthlySpend>, &'static str> {
    if !is_personal(summary) {
        return Ok(None);
    }
    if payload["availability"].as_str() != Some("available") {
        return Err("monthly spend unavailable");
    }
    let monthly = &payload["monthlyUsage"];
    let used = number(&monthly["usedCents"]).ok_or("invalid monthly spend")?;
    let limit = number(&monthly["limitCents"]).ok_or("invalid monthly cap")?;
    let start = monthly["periodStart"]
        .as_str()
        .ok_or("monthly period unavailable")?;
    let reset = monthly["resetsAt"]
        .as_str()
        .ok_or("monthly period unavailable")?;
    let start_time =
        OffsetDateTime::parse(start, &Rfc3339).map_err(|_| "invalid monthly period")?;
    let reset_time =
        OffsetDateTime::parse(reset, &Rfc3339).map_err(|_| "invalid monthly period")?;
    if start_time > now || reset_time <= now || reset_time <= start_time {
        return Err("monthly period is not current");
    }
    Ok(Some(MonthlySpend {
        used: used / 100.0,
        limit: limit / 100.0,
        start: start.into(),
        reset: reset.into(),
    }))
}
fn request(client: &reqwest::blocking::Client, cookie: &str) -> reqwest::blocking::RequestBuilder {
    client
        .get(URL)
        .timeout(Duration::from_secs(5))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::COOKIE, cookie)
}
pub(super) fn fetch(
    client: &reqwest::blocking::Client,
    summary: &[u8],
    cookie: &str,
    now: OffsetDateTime,
    correlation: &str,
) -> Option<MonthlySpend> {
    let summary: Value = serde_json::from_slice(summary).ok()?;
    if !is_personal(&summary) {
        return None;
    }
    let result = (|| {
        let response = request(client, cookie)
            .send()
            .map_err(|_| "request failed")?;
        if !response.status().is_success() {
            return Err("HTTP response unsuccessful");
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_BODY)
        {
            return Err("response too large");
        }
        let mut body = Vec::new();
        response
            .take(MAX_BODY + 1)
            .read_to_end(&mut body)
            .map_err(|_| "response read failed")?;
        if body.len() as u64 > MAX_BODY {
            body.fill(0);
            return Err("response too large");
        }
        let payload = serde_json::from_slice(&body).map_err(|_| "invalid JSON")?;
        decode(&summary, &payload, now)
    })();
    match result {
        Ok(spend) => spend,
        Err(reason) => {
            log::warn!("Cursor optional personal monthly spend unavailable: reason={reason} correlationId={correlation}");
            None
        }
    }
}
pub(super) fn apply(mut output: PluginOutput, spend: Option<MonthlySpend>) -> PluginOutput {
    let Some(spend) = spend else {
        return output;
    };
    output.lines.retain(|line| match line {
        MetricLine::Progress {
            limit_resource_key,
            label,
            ..
        } => limit_resource_key.as_deref() != Some("onDemand") && label != "On-demand",
        MetricLine::Text { label, .. } => label != "On-demand" && label != "Billing Scope",
        _ => true,
    });
    output.lines.push(if spend.limit > 0.0 {
        let duration = OffsetDateTime::parse(&spend.reset, &Rfc3339)
            .ok()
            .zip(OffsetDateTime::parse(&spend.start, &Rfc3339).ok())
            .and_then(|(end, start)| u64::try_from((end - start).whole_milliseconds()).ok());
        MetricLine::Progress {
            label: "On-demand".into(),
            limit_resource_key: Some("onDemand".into()),
            used: spend.used,
            limit: spend.limit,
            format: ProgressFormat::Dollars,
            resets_at: Some(spend.reset),
            period_duration_ms: duration,
            color: None,
        }
    } else {
        MetricLine::Text {
            label: "On-demand".into(),
            value: format!("USD {:.2}", spend.used),
            subtitle: Some("No Positive Cap Reported".into()),
            color: None,
        }
    });
    output.lines.push(MetricLine::Text {
        label: "Billing Scope".into(),
        value: "Current User".into(),
        subtitle: None,
        color: None,
    });
    output
}

#[cfg(test)]
#[path = "browser_cursor_unified_tests.rs"]
mod tests;
