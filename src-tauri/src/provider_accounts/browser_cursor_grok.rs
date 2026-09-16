use crate::plugin_engine::runtime::{MetricLine, PluginOutput, ProgressFormat};
use serde_json::Value;
use std::io::Read;
use std::time::Duration;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const GROK_USAGE_URL: &str = "https://cursor.com/api/dashboard/get-sand-usage-status";
const MAX_BODY_BYTES: u64 = 1024 * 1024;

pub(super) fn append_grok_usage(
    output: &mut PluginOutput,
    result: Result<Vec<u8>, &'static str>,
    now: OffsetDateTime,
    correlation_id: &str,
) {
    match result.and_then(|body| decode_grok_usage(&body, now)) {
        Ok(Some(line)) => output.lines.push(line),
        Ok(None) => {}
        Err(reason) => {
            // Never log response bodies, cookies, identities, or transport error URLs.
            log::warn!(
                "Cursor optional Grok Bot usage failed: reason={} correlationId={}",
                reason,
                correlation_id
            );
            output.lines.push(MetricLine::Text {
                label: "Grok Bot".to_string(),
                value: "Unavailable".to_string(),
                color: None,
                subtitle: None,
            });
        }
    }
}

pub(super) fn fetch_grok_usage(
    client: &reqwest::blocking::Client,
    cookie_header: &str,
) -> Result<Vec<u8>, &'static str> {
    let mut response = grok_request(client, cookie_header)
        .send()
        .map_err(|_| "request failed")?;
    if !response.status().is_success() {
        return Err("HTTP response unsuccessful");
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BODY_BYTES)
    {
        return Err("response too large");
    }
    let mut body = Vec::new();
    response
        .by_ref()
        .take(MAX_BODY_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| "response read failed")?;
    if body.len() as u64 > MAX_BODY_BYTES {
        body.fill(0);
        return Err("response too large");
    }
    Ok(body)
}

pub(super) fn grok_request(
    client: &reqwest::blocking::Client,
    cookie_header: &str,
) -> reqwest::blocking::RequestBuilder {
    client
        .post(GROK_USAGE_URL)
        .timeout(Duration::from_secs(5))
        .header(reqwest::header::ORIGIN, "https://cursor.com")
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::COOKIE, cookie_header)
        .body("{}")
}

pub(super) fn decode_grok_usage(
    body: &[u8],
    now: OffsetDateTime,
) -> Result<Option<MetricLine>, &'static str> {
    let usage: Value = serde_json::from_slice(body).map_err(|_| "invalid JSON")?;
    if !usage.is_object() {
        return Err("invalid usage metadata");
    }
    if usage["usesPooledEnterpriseAllowance"].as_bool() == Some(true) {
        return Ok(None);
    }
    let has_limit = usage["includedLimitZero"]
        .as_bool()
        .map(|zero| !zero)
        .or_else(|| usage["hasNonZeroIncludedLimit"].as_bool());
    let trial = has_limit != Some(true)
        && timestamp(&usage["sandTrialExpiresAt"]).is_some_and(|end| end > now);
    if has_limit == Some(false) && !trial {
        return Ok(None);
    }
    if has_limit.is_none() && !trial {
        return Err("included allowance unknown");
    }
    let percent = usage["usagePercent"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or("invalid usage percentage")?;
    let reset = (!trial)
        .then(|| timestamp(&usage["nextResetTimestampUtc"]))
        .flatten();
    let duration = reset
        .zip(timestamp(&usage["currentPeriodStart"]))
        .filter(|(end, start)| end > start)
        .and_then(|(end, start)| u64::try_from((end - start).whole_milliseconds()).ok())
        .filter(|duration| *duration > 0);
    Ok(Some(MetricLine::Progress {
        label: "Grok Bot".to_string(),
        limit_resource_key: Some("grokBotUsage".to_string()),
        used: percent.min(100.0),
        limit: 100.0,
        format: ProgressFormat::Percent,
        resets_at: reset.and_then(|value| value.format(&Rfc3339).ok()),
        period_duration_ms: duration,
        color: None,
    }))
}

fn timestamp(value: &Value) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value.as_str()?, &Rfc3339)
        .ok()
        .filter(|value| value.unix_timestamp() > 0)
}
