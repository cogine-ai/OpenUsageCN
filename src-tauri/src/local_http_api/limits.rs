use super::cache::{CacheState, CachedPluginSnapshot};
use crate::plugin_engine::manifest::{LimitResourceKind, LoadedPlugin};
use crate::plugin_engine::runtime::{MetricLine, ProgressFormat};
use serde::Serialize;
use std::collections::BTreeMap;
use time::OffsetDateTime;

pub const LIMITS_SCHEMA: &str = "openusage.limits.v1";
pub const CACHE_FRESHNESS_SECONDS: i64 = 300;

#[derive(Debug, Clone)]
pub struct ProviderLimitCatalog {
    pub provider_id: String,
    pub resources: Vec<LimitCatalogResource>,
}

#[derive(Debug, Clone)]
pub struct LimitCatalogResource {
    pub key: String,
    pub metric_label: String,
    pub kind: LimitResourceKind,
    pub count_unit: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsEnvelope {
    pub schema: &'static str,
    pub generated_at: String,
    pub providers: BTreeMap<String, LimitsProvider>,
    pub errors: Vec<LimitsError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsError {
    pub provider_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsProvider {
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub fetched_at: String,
    pub expires_at: String,
    pub stale: bool,
    pub resources: BTreeMap<String, LimitsResource>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsResource {
    pub kind: LimitResourceKind,
    pub unit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub utilization: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_seconds: Option<f64>,
}

pub fn catalog_from_plugins(plugins: &[LoadedPlugin]) -> Vec<ProviderLimitCatalog> {
    plugins
        .iter()
        .map(|plugin| ProviderLimitCatalog {
            provider_id: plugin.manifest.id.clone(),
            resources: plugin
                .manifest
                .lines
                .iter()
                .filter_map(|line| {
                    line.limit_resource
                        .as_ref()
                        .map(|resource| LimitCatalogResource {
                            key: resource.key.clone(),
                            metric_label: line.label.clone(),
                            kind: resource.kind,
                            count_unit: resource.count_unit.clone(),
                        })
                })
                .collect(),
        })
        .collect()
}

pub(super) fn envelope_from_state(provider_ids: &[String], state: &CacheState) -> LimitsEnvelope {
    let generated_at = OffsetDateTime::now_utc();
    let mut providers = BTreeMap::new();
    let mut errors: Vec<LimitsError> = provider_ids
        .iter()
        .filter_map(|provider_id| {
            state.errors.get(provider_id).map(|message| LimitsError {
                provider_id: provider_id.clone(),
                message: crate::plugin_engine::host_api::redact_log_message(message),
            })
        })
        .collect();
    for provider_id in provider_ids {
        let (Some(snapshot), Some(catalog)) = (
            state.snapshots.get(provider_id),
            state.limit_catalog.get(provider_id),
        ) else {
            continue;
        };
        match provider_from_snapshot(snapshot, catalog, generated_at) {
            Ok((provider, resource_errors)) => {
                providers.insert(provider_id.clone(), provider);
                errors.extend(resource_errors.into_iter().map(|message| LimitsError {
                    provider_id: provider_id.clone(),
                    message,
                }));
            }
            Err(message) => {
                log::error!("limits projection failed for provider {provider_id}: {message}");
                errors.push(LimitsError {
                    provider_id: provider_id.clone(),
                    message,
                });
            }
        }
    }

    LimitsEnvelope {
        schema: LIMITS_SCHEMA,
        generated_at: format_timestamp(generated_at),
        providers,
        errors,
    }
}

pub(crate) fn current_envelope(provider_ids: &[String]) -> LimitsEnvelope {
    let state = super::cache::cache_state()
        .lock()
        .expect("cache state poisoned");
    envelope_from_state(provider_ids, &state)
}

pub fn snapshot_is_stale(snapshot: &CachedPluginSnapshot, now: OffsetDateTime) -> bool {
    snapshot_fetched_at(snapshot)
        .map(|fetched_at| now >= fetched_at + time::Duration::seconds(CACHE_FRESHNESS_SECONDS))
        .unwrap_or(true)
}

fn provider_from_snapshot(
    snapshot: &CachedPluginSnapshot,
    catalog: &ProviderLimitCatalog,
    generated_at: OffsetDateTime,
) -> Result<(LimitsProvider, Vec<String>), String> {
    let fetched_at = snapshot_fetched_at(snapshot)
        .ok_or_else(|| "Cached freshness timestamp is invalid.".to_string())?;
    let expires_at = fetched_at + time::Duration::seconds(CACHE_FRESHNESS_SECONDS);
    let mut resources = BTreeMap::new();
    let mut resource_errors = Vec::new();
    for descriptor in &catalog.resources {
        let line = snapshot
            .lines
            .iter()
            .find(|line| match line {
                MetricLine::Progress {
                    limit_resource_key: Some(key),
                    ..
                } => key == &descriptor.key,
                _ => false,
            })
            .or_else(|| {
                snapshot.lines.iter().find(|line| match line {
                    MetricLine::Progress {
                        label,
                        limit_resource_key: None,
                        ..
                    } => label == &descriptor.metric_label,
                    _ => false,
                })
            });
        let Some(line) = line else {
            continue;
        };
        match resource_from_line(descriptor, line) {
            Ok(resource) => {
                resources.insert(descriptor.key.clone(), resource);
            }
            Err(message) => {
                let message = format!("Resource '{}': {message}", descriptor.key);
                log::error!(
                    "limits projection skipped invalid resource for provider {}: {message}",
                    catalog.provider_id
                );
                resource_errors.push(message);
            }
        }
    }

    Ok((
        LimitsProvider {
            display_name: snapshot.display_name.clone(),
            plan: snapshot.plan.clone(),
            fetched_at: format_timestamp(fetched_at),
            expires_at: format_timestamp(expires_at),
            stale: generated_at >= expires_at,
            resources,
        },
        resource_errors,
    ))
}

fn resource_from_line(
    descriptor: &LimitCatalogResource,
    line: &MetricLine,
) -> Result<LimitsResource, String> {
    let MetricLine::Progress {
        used,
        limit,
        format,
        resets_at,
        period_duration_ms,
        ..
    } = line
    else {
        return Err("expected a progress line".to_string());
    };
    if !used.is_finite() || !limit.is_finite() || *used < 0.0 || *limit <= 0.0 {
        return Err("contains invalid numeric limits".to_string());
    }

    let bounded_remaining = (*limit - *used).max(0.0);
    Ok(LimitsResource {
        kind: descriptor.kind,
        unit: progress_unit(format, descriptor.count_unit.as_deref())
            .ok_or_else(|| "count resource is missing a stable unit".to_string())?,
        used: (descriptor.kind == LimitResourceKind::Consumption).then_some(*used),
        available: (descriptor.kind == LimitResourceKind::Balance).then_some(*used),
        limit: Some(*limit),
        remaining: Some(bounded_remaining),
        utilization: Some(*used / *limit),
        resets_at: resets_at.clone(),
        window_seconds: period_duration_ms.map(|milliseconds| milliseconds as f64 / 1_000.0),
    })
}

fn progress_unit(format: &ProgressFormat, count_unit: Option<&str>) -> Option<String> {
    match format {
        ProgressFormat::Percent => Some("percent".to_string()),
        ProgressFormat::Dollars => Some("usd".to_string()),
        ProgressFormat::Count { .. } => count_unit
            .map(str::trim)
            .filter(|unit| !unit.is_empty())
            .map(str::to_string),
    }
}

fn snapshot_fetched_at(snapshot: &CachedPluginSnapshot) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(
        &snapshot.fetched_at,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()
}

fn format_timestamp(value: OffsetDateTime) -> String {
    value
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_engine::manifest::LimitResourceKind;
    use crate::plugin_engine::runtime::MetricLine;

    fn snapshot() -> CachedPluginSnapshot {
        CachedPluginSnapshot {
            provider_id: "codex".to_string(),
            display_name: "Codex".to_string(),
            plan: Some("Plus".to_string()),
            lines: vec![MetricLine::Progress {
                label: "Session".to_string(),
                limit_resource_key: None,
                used: 34.0,
                limit: 100.0,
                format: ProgressFormat::Percent,
                resets_at: Some("2026-07-14T09:00:00Z".to_string()),
                period_duration_ms: Some(18_000_000),
                color: Some("#fff".to_string()),
            }],
            fetched_at: "2026-07-14T02:00:00Z".to_string(),
        }
    }

    #[test]
    fn resource_projection_uses_raw_scalars_and_omits_presentation() {
        let resource = resource_from_line(
            &LimitCatalogResource {
                key: "session".to_string(),
                metric_label: "Session".to_string(),
                kind: LimitResourceKind::Consumption,
                count_unit: None,
            },
            &snapshot().lines[0],
        )
        .unwrap();
        let json = serde_json::to_value(resource).unwrap();

        assert_eq!(json["used"], 34.0);
        assert_eq!(json["remaining"], 66.0);
        assert_eq!(json["utilization"], 0.34);
        assert_eq!(json["unit"], "percent");
        assert_eq!(json["windowSeconds"], 18_000.0);
        assert!(json.get("color").is_none());
        assert!(json.get("label").is_none());
    }

    #[test]
    fn stale_snapshot_uses_five_minute_freshness_window() {
        let snapshot = snapshot();
        let fresh_now = OffsetDateTime::parse(
            "2026-07-14T02:04:59Z",
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap();
        let stale_now = OffsetDateTime::parse(
            "2026-07-14T02:05:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap();

        assert!(!snapshot_is_stale(&snapshot, fresh_now));
        assert!(snapshot_is_stale(&snapshot, stale_now));
    }

    #[test]
    fn utilization_preserves_overage_snapshots() {
        let mut snapshot = snapshot();
        let MetricLine::Progress { used, .. } = &mut snapshot.lines[0] else {
            unreachable!()
        };
        *used = 125.0;
        let resource = resource_from_line(
            &LimitCatalogResource {
                key: "session".to_string(),
                metric_label: "Session".to_string(),
                kind: LimitResourceKind::Consumption,
                count_unit: None,
            },
            &snapshot.lines[0],
        )
        .unwrap();

        assert_eq!(resource.remaining, Some(0.0));
        assert_eq!(resource.utilization, Some(1.25));
    }

    #[test]
    fn count_resources_require_a_stable_unit() {
        let line = MetricLine::Progress {
            label: "Requests".to_string(),
            limit_resource_key: None,
            used: 12.0,
            limit: 100.0,
            format: ProgressFormat::Count {
                suffix: "req".to_string(),
            },
            resets_at: None,
            period_duration_ms: None,
            color: None,
        };
        let error = resource_from_line(
            &LimitCatalogResource {
                key: "requests".to_string(),
                metric_label: "Requests".to_string(),
                kind: LimitResourceKind::Consumption,
                count_unit: None,
            },
            &line,
        )
        .unwrap_err();

        assert_eq!(error, "count resource is missing a stable unit");
    }

    #[test]
    fn explicit_resource_key_survives_runtime_label_changes() {
        let mut snapshot = snapshot();
        let MetricLine::Progress {
            label,
            limit_resource_key,
            ..
        } = &mut snapshot.lines[0]
        else {
            unreachable!()
        };
        *label = "Remote Name".to_string();
        *limit_resource_key = Some("session".to_string());
        let catalog = ProviderLimitCatalog {
            provider_id: "codex".to_string(),
            resources: vec![LimitCatalogResource {
                key: "session".to_string(),
                metric_label: "Session".to_string(),
                kind: LimitResourceKind::Consumption,
                count_unit: None,
            }],
        };

        let (provider, errors) = provider_from_snapshot(
            &snapshot,
            &catalog,
            OffsetDateTime::parse(
                "2026-07-14T02:01:00Z",
                &time::format_description::well_known::Rfc3339,
            )
            .unwrap(),
        )
        .unwrap();

        assert!(provider.resources.contains_key("session"));
        assert!(errors.is_empty());
    }

    fn test_cache_state() -> CacheState {
        super::super::cache::empty_cache_state_for_tests()
    }

    #[test]
    fn envelope_from_state_redacts_probe_errors() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        let mut state = test_cache_state();
        state
            .errors
            .insert("codex".to_string(), format!("refresh failed: token={jwt}"));

        let envelope = envelope_from_state(&["codex".to_string()], &state);

        assert_eq!(envelope.errors.len(), 1);
        assert_eq!(envelope.errors[0].provider_id, "codex");
        assert!(
            !envelope.errors[0].message.contains(jwt),
            "probe error leaked JWT: {}",
            envelope.errors[0].message
        );
        assert!(envelope.providers.is_empty());
    }

    #[test]
    fn envelope_from_state_keeps_valid_resources_when_projection_degrades() {
        let mut snapshot = snapshot();
        snapshot.lines.push(MetricLine::Progress {
            label: "Requests".to_string(),
            limit_resource_key: None,
            used: 12.0,
            limit: 100.0,
            format: ProgressFormat::Count {
                suffix: "req".to_string(),
            },
            resets_at: None,
            period_duration_ms: None,
            color: None,
        });
        let catalog = ProviderLimitCatalog {
            provider_id: "codex".to_string(),
            resources: vec![
                LimitCatalogResource {
                    key: "session".to_string(),
                    metric_label: "Session".to_string(),
                    kind: LimitResourceKind::Consumption,
                    count_unit: None,
                },
                LimitCatalogResource {
                    key: "requests".to_string(),
                    metric_label: "Requests".to_string(),
                    kind: LimitResourceKind::Consumption,
                    count_unit: None,
                },
            ],
        };
        let mut state = test_cache_state();
        state.snapshots.insert("codex".to_string(), snapshot);
        state
            .limit_catalog
            .insert("codex".to_string(), catalog);

        let envelope = envelope_from_state(&["codex".to_string()], &state);

        assert!(envelope.providers.contains_key("codex"));
        assert!(envelope.providers["codex"].resources.contains_key("session"));
        assert!(!envelope.providers["codex"].resources.contains_key("requests"));
        assert_eq!(envelope.errors.len(), 1);
        assert_eq!(
            envelope.errors[0].message,
            "Resource 'requests': count resource is missing a stable unit"
        );
    }

    #[test]
    fn invalid_resource_does_not_remove_valid_provider_resources() {
        let mut snapshot = snapshot();
        snapshot.lines.push(MetricLine::Progress {
            label: "Requests".to_string(),
            limit_resource_key: None,
            used: 12.0,
            limit: 100.0,
            format: ProgressFormat::Count {
                suffix: "req".to_string(),
            },
            resets_at: None,
            period_duration_ms: None,
            color: None,
        });
        let catalog = ProviderLimitCatalog {
            provider_id: "codex".to_string(),
            resources: vec![
                LimitCatalogResource {
                    key: "session".to_string(),
                    metric_label: "Session".to_string(),
                    kind: LimitResourceKind::Consumption,
                    count_unit: None,
                },
                LimitCatalogResource {
                    key: "requests".to_string(),
                    metric_label: "Requests".to_string(),
                    kind: LimitResourceKind::Consumption,
                    count_unit: None,
                },
            ],
        };

        let (provider, errors) = provider_from_snapshot(
            &snapshot,
            &catalog,
            OffsetDateTime::parse(
                "2026-07-14T02:01:00Z",
                &time::format_description::well_known::Rfc3339,
            )
            .unwrap(),
        )
        .unwrap();

        assert!(provider.resources.contains_key("session"));
        assert!(!provider.resources.contains_key("requests"));
        assert_eq!(
            errors,
            vec!["Resource 'requests': count resource is missing a stable unit"]
        );
    }
}
