use crate::plugin_engine::runtime::{MetricLine, PluginOutput, ProgressFormat};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[cfg(test)]
#[path = "browser_cursor_weekly_tests.rs"]
mod tests;

/// This is the same response used by the optional Grok Bot reading, not another request.
pub(super) fn decode_shared_weekly(
    body: &[u8],
    now: OffsetDateTime,
) -> Result<Option<MetricLine>, &'static str> {
    let usage: Value = serde_json::from_slice(body).map_err(|_| "invalid JSON")?;
    if !usage.is_object() {
        return Err("invalid usage metadata");
    }
    if usage["isUnified"].as_bool() != Some(true) {
        return Ok(None);
    }
    if usage["usesPooledEnterpriseAllowance"].as_bool() == Some(true) {
        return Ok(None);
    }
    let paid = match usage.get("includedLimitZero") {
        Some(Value::Bool(zero)) => !zero,
        Some(Value::Null) | None => usage["hasNonZeroIncludedLimit"]
            .as_bool()
            .ok_or("included allowance unknown")?,
        Some(_) => return Err("invalid included allowance"),
    };
    // A future trial expiry does not establish a recurring, paid weekly allowance.
    if !paid {
        return Ok(None);
    }
    let used = usage["usagePercent"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or("invalid usage percentage")?;
    let reset = usage["nextResetTimestampUtc"]
        .as_str()
        .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
        .filter(|reset| *reset > now);
    let Some(reset) = reset else { return Ok(None) };
    Ok(Some(MetricLine::Progress {
        label: "Shared Weekly Usage".to_string(),
        limit_resource_key: Some("weekly".to_string()),
        used: used.min(100.0),
        limit: 100.0,
        format: ProgressFormat::Percent,
        resets_at: reset.format(&Rfc3339).ok(),
        period_duration_ms: Some(7 * 24 * 60 * 60 * 1_000),
        color: None,
    }))
}

/// Requests stay binding; the shared pool replaces monthly lanes rather than adding to them.
pub(super) fn apply_shared_weekly(output: &mut PluginOutput, weekly: MetricLine) -> bool {
    if output.lines.iter().any(|line| matches!(line,
        MetricLine::Progress { limit_resource_key: Some(key), used, limit, .. }
            if key == "requests" && used.is_finite() && *used >= 0.0 && limit.is_finite() && *limit > 0.0
    )) {
        return false;
    }
    output.lines.retain(|line| match line {
        MetricLine::Progress {
            limit_resource_key: Some(key),
            ..
        } => !matches!(
            key.as_str(),
            "totalUsage" | "autoUsage" | "apiUsage" | "grokBotUsage"
        ),
        MetricLine::Text { label, .. } => label != "Grok Bot",
        _ => true,
    });
    output.lines.insert(0, weekly);
    true
}

pub(super) fn finish_with_allowance(
    mut output: PluginOutput,
    weekly: Option<MetricLine>,
    grok_body: Result<Vec<u8>, &'static str>,
    now: OffsetDateTime,
    correlation_id: &str,
) -> PluginOutput {
    if let Some(weekly) = weekly {
        apply_shared_weekly(&mut output, weekly);
        // A binding request quota must not relabel the shared pool as separate Grok usage.
    } else {
        super::browser_cursor_grok::append_grok_usage(&mut output, grok_body, now, correlation_id);
    }
    output
}

/// The typed summary decoder has already validated its fields and reported NoQuota.
/// Only an explicit absence of legacy request data permits using weekly usage instead.
pub(super) fn recover_summary_without_quota(
    summary_body: &[u8],
    legacy_body: &[u8],
    display_name: &str,
    icon_url: &str,
) -> Option<PluginOutput> {
    let legacy: Value = serde_json::from_slice(legacy_body).ok()?;
    if !legacy.is_object() || legacy.get("error").is_some() || legacy.get("gpt-4").is_some() {
        return None;
    }
    let summary: Value = serde_json::from_slice(summary_body).ok()?;
    if !summary.is_object()
        || summary.get("error").is_some()
        || !["membershipType", "individualUsage", "teamUsage"]
            .iter()
            .any(|key| !summary[*key].is_null())
    {
        return None;
    }
    let mut lines = Vec::new();
    let on_demand = summary
        .pointer("/individualUsage/onDemand")
        .filter(|block| !block.is_null())
        .or_else(|| summary.pointer("/teamUsage/onDemand"));
    if let Some(block) = on_demand.filter(|block| block["enabled"].as_bool() != Some(false)) {
        if let Some((used, limit)) =
            block["used"]
                .as_f64()
                .zip(block["limit"].as_f64())
                .filter(|(used, limit)| {
                    used.is_finite() && *used >= 0.0 && limit.is_finite() && *limit > 0.0
                })
        {
            lines.push(MetricLine::Progress {
                label: "On-demand".to_string(),
                limit_resource_key: Some("onDemand".to_string()),
                used: used / 100.0,
                limit: limit / 100.0,
                format: ProgressFormat::Dollars,
                resets_at: None,
                period_duration_ms: None,
                color: None,
            });
        }
    }
    Some(PluginOutput {
        provider_id: "cursor".to_string(),
        display_name: display_name.to_string(),
        icon_url: icon_url.to_string(),
        plan: summary["membershipType"]
            .as_str()
            .and_then(super::browser_cursor_probe::plan_label),
        lines,
    })
}
