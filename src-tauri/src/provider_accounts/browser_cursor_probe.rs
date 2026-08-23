use crate::plugin_engine::runtime::{MetricLine, PluginOutput, ProgressFormat};
use serde::Deserialize;
use std::io::Read;
use std::time::{Duration, Instant};

const USAGE_SUMMARY_URL: &str = "https://cursor.com/api/usage-summary";
const LEGACY_USAGE_URL: &str = "https://cursor.com/api/usage";
const MAX_BODY_BYTES: usize = 1024 * 1024;

pub(super) struct FixedBrowserCursorProbe {
    client: reqwest::blocking::Client,
}

impl FixedBrowserCursorProbe {
    pub(super) fn new() -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "Cursor browser usage is unavailable.".to_string())?;
        Ok(Self { client })
    }

    pub(super) fn probe(
        &self,
        cookie_header: &str,
        subject: &str,
        display_name: &str,
        icon_url: &str,
        correlation_id: &str,
    ) -> Result<PluginOutput, String> {
        let summary_body = self.get_json(
            USAGE_SUMMARY_URL,
            cookie_header,
            "usage-summary",
            correlation_id,
        )?;
        match decode_usage_summary_output(&summary_body, display_name, icon_url) {
            Ok(output) => Ok(output),
            Err(DecodeError::NoQuota { membership_type }) => {
                let user_id = subject
                    .rsplit_once('|')
                    .map(|(_, user_id)| user_id)
                    .unwrap_or(subject)
                    .trim();
                if user_id.is_empty() {
                    return Err("Cursor browser usage did not include an account ID.".to_string());
                }
                let mut url = reqwest::Url::parse(LEGACY_USAGE_URL)
                    .map_err(|_| "Cursor browser usage is unavailable.".to_string())?;
                url.query_pairs_mut().append_pair("user", user_id);
                let legacy_body =
                    self.get_json(url.as_str(), cookie_header, "legacy-usage", correlation_id)?;
                decode_legacy_output(
                    &legacy_body,
                    membership_type.as_deref(),
                    display_name,
                    icon_url,
                )
                .map_err(decode_error_message)
            }
            Err(error) => Err(decode_error_message(error)),
        }
    }

    fn get_json(
        &self,
        url: &str,
        cookie_header: &str,
        endpoint_class: &str,
        correlation_id: &str,
    ) -> Result<Vec<u8>, String> {
        let started = Instant::now();
        let mut response = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::COOKIE, cookie_header)
            .send()
            .map_err(|_| "Cursor browser usage could not be refreshed. Try again.".to_string())?;
        let status = response.status().as_u16();
        log::debug!(
            "Cursor browser transport endpointClass={} status={} durationMs={} correlationId={}",
            endpoint_class,
            status,
            started.elapsed().as_millis(),
            correlation_id
        );
        if status == 401 || status == 403 {
            return Err("The selected Cursor browser session expired. Scan it again.".to_string());
        }
        if (300..400).contains(&status) {
            return Err("Cursor browser usage rejected an unexpected redirect.".to_string());
        }
        if !response.status().is_success() {
            return Err("Cursor browser usage could not be refreshed. Try again.".to_string());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_BODY_BYTES as u64)
        {
            return Err("Cursor browser usage returned too much data.".to_string());
        }
        let mut body = Vec::new();
        response
            .by_ref()
            .take(MAX_BODY_BYTES as u64 + 1)
            .read_to_end(&mut body)
            .map_err(|_| "Cursor browser usage could not be refreshed. Try again.".to_string())?;
        if body.len() > MAX_BODY_BYTES {
            body.fill(0);
            return Err("Cursor browser usage returned too much data.".to_string());
        }
        Ok(body)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    membership_type: Option<String>,
    billing_cycle_start: Option<String>,
    billing_cycle_end: Option<String>,
    individual_usage: Option<IndividualUsage>,
    team_usage: Option<TeamUsage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndividualUsage {
    plan: Option<UsageBlock>,
    on_demand: Option<UsageBlock>,
    overall: Option<UsageBlock>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamUsage {
    on_demand: Option<UsageBlock>,
    pooled: Option<UsageBlock>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageBlock {
    enabled: Option<bool>,
    used: Option<f64>,
    limit: Option<f64>,
    remaining: Option<f64>,
    total_percent_used: Option<f64>,
    auto_percent_used: Option<f64>,
    api_percent_used: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyUsage {
    #[serde(rename = "gpt-4")]
    gpt4: Option<LegacyModelUsage>,
    start_of_month: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyModelUsage {
    num_requests: Option<f64>,
    num_requests_total: Option<f64>,
    max_request_usage: Option<f64>,
}

enum DecodeError {
    Invalid,
    NoQuota { membership_type: Option<String> },
}

#[cfg(test)]
pub(super) fn build_usage_summary_output(
    body: &[u8],
    display_name: &str,
    icon_url: &str,
) -> Result<PluginOutput, String> {
    decode_usage_summary_output(body, display_name, icon_url).map_err(decode_error_message)
}

fn decode_usage_summary_output(
    body: &[u8],
    display_name: &str,
    icon_url: &str,
) -> Result<PluginOutput, DecodeError> {
    let summary: UsageSummary = serde_json::from_slice(body).map_err(|_| DecodeError::Invalid)?;
    validate_summary(&summary)?;
    let membership_type = normalized_text(summary.membership_type.as_deref());
    let individual = summary.individual_usage.as_ref();
    let team = summary.team_usage.as_ref();
    let primary = individual
        .and_then(|usage| usage.plan.as_ref())
        .or_else(|| individual.and_then(|usage| usage.overall.as_ref()))
        .or_else(|| team.and_then(|usage| usage.pooled.as_ref()));
    let Some(primary) = primary.filter(|block| block.enabled != Some(false)) else {
        return Err(DecodeError::NoQuota { membership_type });
    };
    let period_duration_ms = billing_period_ms(
        summary.billing_cycle_start.as_deref(),
        summary.billing_cycle_end.as_deref(),
    );
    let resets_at = summary.billing_cycle_end.clone();
    let is_team = membership_type.as_deref().is_some_and(|plan| {
        let plan = plan.to_ascii_lowercase();
        plan == "team" || plan == "enterprise"
    });
    let mut lines = Vec::new();
    let limit = positive(primary.limit);
    let used = nonnegative(primary.used).or_else(|| {
        limit
            .zip(nonnegative(primary.remaining))
            .map(|(limit, remaining)| limit - remaining)
    });
    let percent = nonnegative(primary.total_percent_used)
        .or_else(|| used.zip(limit).map(|(used, limit)| used / limit * 100.0));
    if is_team {
        let (used, limit) = used.zip(limit).ok_or(DecodeError::NoQuota {
            membership_type: membership_type.clone(),
        })?;
        lines.push(progress(
            "Total usage",
            Some("totalUsage"),
            used / 100.0,
            limit / 100.0,
            ProgressFormat::Dollars,
            resets_at.clone(),
            period_duration_ms,
        ));
    } else {
        let percent = percent.ok_or(DecodeError::NoQuota {
            membership_type: membership_type.clone(),
        })?;
        lines.push(progress(
            "Total usage",
            Some("totalUsage"),
            percent,
            100.0,
            ProgressFormat::Percent,
            resets_at.clone(),
            period_duration_ms,
        ));
    }
    if let Some(value) = nonnegative(primary.auto_percent_used) {
        lines.push(progress(
            "Auto usage",
            Some("autoUsage"),
            value,
            100.0,
            ProgressFormat::Percent,
            resets_at.clone(),
            period_duration_ms,
        ));
    }
    if let Some(value) = nonnegative(primary.api_percent_used) {
        lines.push(progress(
            "API usage",
            Some("apiUsage"),
            value,
            100.0,
            ProgressFormat::Percent,
            resets_at.clone(),
            period_duration_ms,
        ));
    }
    let on_demand = individual
        .and_then(|usage| usage.on_demand.as_ref())
        .or_else(|| team.and_then(|usage| usage.on_demand.as_ref()));
    if let Some(block) = on_demand.filter(|block| block.enabled != Some(false)) {
        if let Some((used, limit)) = nonnegative(block.used).zip(positive(block.limit)) {
            lines.push(progress(
                "On-demand",
                Some("onDemand"),
                used / 100.0,
                limit / 100.0,
                ProgressFormat::Dollars,
                None,
                None,
            ));
        }
    }
    Ok(output(
        display_name,
        icon_url,
        membership_type.as_deref(),
        lines,
    ))
}

#[cfg(test)]
pub(super) fn build_legacy_output(
    body: &[u8],
    membership_type: Option<&str>,
    display_name: &str,
    icon_url: &str,
) -> Result<PluginOutput, String> {
    decode_legacy_output(body, membership_type, display_name, icon_url)
        .map_err(decode_error_message)
}

fn decode_legacy_output(
    body: &[u8],
    membership_type: Option<&str>,
    display_name: &str,
    icon_url: &str,
) -> Result<PluginOutput, DecodeError> {
    let usage: LegacyUsage = serde_json::from_slice(body).map_err(|_| DecodeError::Invalid)?;
    let model = usage.gpt4.ok_or(DecodeError::Invalid)?;
    let used = nonnegative(model.num_requests_total)
        .or_else(|| nonnegative(model.num_requests))
        .ok_or(DecodeError::Invalid)?;
    let limit = positive(model.max_request_usage).ok_or(DecodeError::Invalid)?;
    let resets_at = usage.start_of_month.as_deref().and_then(legacy_reset_at);
    let lines = vec![progress(
        "Requests",
        Some("requests"),
        used,
        limit,
        ProgressFormat::Count {
            suffix: "requests".to_string(),
        },
        resets_at,
        Some(30 * 24 * 60 * 60 * 1_000),
    )];
    Ok(output(display_name, icon_url, membership_type, lines))
}

fn output(
    display_name: &str,
    icon_url: &str,
    membership_type: Option<&str>,
    lines: Vec<MetricLine>,
) -> PluginOutput {
    PluginOutput {
        provider_id: "cursor".to_string(),
        display_name: display_name.to_string(),
        plan: membership_type.and_then(plan_label),
        lines,
        icon_url: icon_url.to_string(),
    }
}

fn progress(
    label: &str,
    resource: Option<&str>,
    used: f64,
    limit: f64,
    format: ProgressFormat,
    resets_at: Option<String>,
    period_duration_ms: Option<u64>,
) -> MetricLine {
    MetricLine::Progress {
        label: label.to_string(),
        limit_resource_key: resource.map(str::to_string),
        used,
        limit,
        format,
        resets_at,
        period_duration_ms,
        color: None,
    }
}

fn validate_summary(summary: &UsageSummary) -> Result<(), DecodeError> {
    let blocks = summary
        .individual_usage
        .iter()
        .flat_map(|usage| [&usage.plan, &usage.on_demand, &usage.overall])
        .chain(
            summary
                .team_usage
                .iter()
                .flat_map(|usage| [&usage.on_demand, &usage.pooled]),
        );
    for block in blocks.flatten() {
        for value in [
            block.used,
            block.limit,
            block.remaining,
            block.total_percent_used,
            block.auto_percent_used,
            block.api_percent_used,
        ]
        .into_iter()
        .flatten()
        {
            if !value.is_finite() || value < 0.0 {
                return Err(DecodeError::Invalid);
            }
        }
    }
    Ok(())
}

fn normalized_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn nonnegative(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value >= 0.0)
}

fn positive(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value > 0.0)
}

fn plan_label(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" => None,
        "pro_plus" => Some("Pro+".to_string()),
        _ => Some(
            normalized
                .split(['_', '-'])
                .filter(|part| !part.is_empty())
                .map(|part| {
                    let mut chars = part.chars();
                    chars
                        .next()
                        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join(" "),
        ),
    }
}

fn billing_period_ms(start: Option<&str>, end: Option<&str>) -> Option<u64> {
    let format = &time::format_description::well_known::Rfc3339;
    let start = time::OffsetDateTime::parse(start?, format).ok()?;
    let end = time::OffsetDateTime::parse(end?, format).ok()?;
    u64::try_from((end - start).whole_milliseconds()).ok()
}

fn legacy_reset_at(start: &str) -> Option<String> {
    let date = time::Date::parse(
        start,
        &time::format_description::parse("[year]-[month]-[day]").ok()?,
    )
    .ok()?;
    let reset = date.midnight().assume_utc() + time::Duration::days(30);
    reset
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

fn decode_error_message(error: DecodeError) -> String {
    match error {
        DecodeError::Invalid => "Cursor browser usage returned invalid data.".to_string(),
        DecodeError::NoQuota { .. } => {
            "Cursor browser usage did not include an available quota.".to_string()
        }
    }
}
