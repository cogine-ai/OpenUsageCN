use super::ProviderAccounts;
use crate::cursor_history::BillingCycle;
use crate::plugin_engine::runtime::MetricLine;

impl ProviderAccounts {
    pub(crate) fn cursor_billing_cycle(
        &self,
        account_id: &str,
        now_ms: i64,
    ) -> Result<Option<BillingCycle>, String> {
        let is_active = self
            .providers
            .lock()
            .map_err(|_| "Provider account state is unavailable.".to_string())?
            .get("cursor")
            .is_some_and(|provider| provider.active_account_id.as_deref() == Some(account_id));
        if !is_active {
            return Err("The selected Cursor account changed.".to_string());
        }
        let Some(store) = &self.snapshot_store else {
            return Ok(None);
        };
        let Some(snapshot) = store.load("cursor", account_id)? else {
            return Ok(None);
        };
        if !snapshot.cursor_billing_period_verified {
            return Ok(None);
        }
        Ok(billing_cycle_from_lines(&snapshot.lines, now_ms))
    }
}

fn billing_cycle_from_lines(lines: &[MetricLine], now_ms: i64) -> Option<BillingCycle> {
    lines.iter().find_map(|line| {
        let MetricLine::Progress {
            label,
            resets_at: Some(resets_at),
            period_duration_ms: Some(period_duration_ms),
            ..
        } = line
        else {
            return None;
        };
        if label != "Total usage" {
            return None;
        }
        let end = time::OffsetDateTime::parse(
            resets_at.trim(),
            &time::format_description::well_known::Rfc3339,
        )
        .ok()?
        .unix_timestamp_nanos()
        .checked_div(1_000_000)
        .and_then(|value| i64::try_from(value).ok())?;
        let duration = i64::try_from(*period_duration_ms).ok()?;
        let start = end.checked_sub(duration)?;
        (start > 0 && start < now_ms && end > now_ms).then_some(BillingCycle {
            start_ms: start,
            end_ms: end,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::billing_cycle_from_lines;
    use crate::plugin_engine::runtime::{MetricLine, PluginOutput, ProgressFormat};
    use crate::provider_accounts::{ProviderAccounts, state::ProviderState};

    #[test]
    fn pre_upgrade_quota_cache_keeps_usage_but_cannot_prove_a_billing_cycle() {
        let root = std::env::temp_dir().join(format!(
            "openusage-old-cursor-cycle-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let lines = vec![line(Some("2026-09-01T00:00:00Z"), Some(30 * 86_400_000))];
        let raw = serde_json::json!({"version": 1, "providers": {"cursor": {"account-a": {
            "displayName": "Cursor", "plan": "Pro", "lines": lines,
            "startedAt": "2026-08-24T00:00:00Z", "fetchedAt": "2026-08-24T00:00:01Z"
        }}}});
        std::fs::write(
            root.join("provider-account-snapshots.json"),
            serde_json::to_string(&raw).unwrap(),
        )
        .unwrap();
        let accounts = ProviderAccounts::with_store([0; 32], &root).unwrap();
        accounts.providers.lock().unwrap().insert(
            "cursor".to_string(),
            ProviderState {
                active_account_id: Some("account-a".to_string()),
                ..Default::default()
            },
        );
        assert!(
            accounts
                .cursor_billing_cycle("account-a", 1_787_529_600_000)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            accounts
                .snapshot_store
                .as_ref()
                .unwrap()
                .load("cursor", "account-a")
                .unwrap()
                .unwrap()
                .lines
                .len(),
            1
        );

        let exact = PluginOutput {
            provider_id: "cursor".to_string(),
            display_name: "Cursor".to_string(),
            plan: None,
            icon_url: String::new(),
            lines: vec![line(Some("2026-09-01T00:00:00Z"), Some(31 * 86_400_000))],
        };
        accounts
            .snapshot_store
            .as_ref()
            .unwrap()
            .save(
                "cursor",
                "account-a",
                &exact,
                "2026-08-24T01:00:00Z",
                "2026-08-24T01:00:01Z",
            )
            .unwrap();
        let cycle = accounts
            .cursor_billing_cycle("account-a", 1_787_529_600_000)
            .unwrap()
            .expect("new exact dates");
        assert_eq!(cycle.start_ms, 1_785_542_400_000);
    }

    #[test]
    fn fresh_browser_and_local_snapshots_require_explicit_total_usage_dates() {
        use crate::provider_accounts::browser_cursor_probe::{
            build_legacy_output, build_usage_summary_output,
        };
        let root = std::env::temp_dir().join(format!(
            "openusage-cursor-cycle-sources-{}",
            uuid::Uuid::new_v4()
        ));
        let accounts = ProviderAccounts::with_store([0; 32], &root).unwrap();
        accounts.providers.lock().unwrap().insert(
            "cursor".to_string(),
            ProviderState {
                active_account_id: Some("account-a".to_string()),
                ..Default::default()
            },
        );
        let missing_start = build_usage_summary_output(
            br#"{
            "billingCycleEnd":"2026-09-01T00:00:00Z",
            "individualUsage":{"plan":{"used":10,"limit":100}}
        }"#,
            "Cursor",
            "",
        )
        .unwrap();
        let legacy = build_legacy_output(
            br#"{
            "startOfMonth":"2026-08-01","gpt-4":{"numRequests":10,"maxRequestUsage":100}
        }"#,
            None,
            "Cursor",
            "",
        )
        .unwrap();
        let mut arbitrary_period = missing_start.clone();
        let mut guessed = line(Some("2026-09-01T00:00:00Z"), Some(30 * 86_400_000));
        if let MetricLine::Progress { label, .. } = &mut guessed {
            *label = "Requests".to_string();
        }
        arbitrary_period.lines = vec![guessed];
        for output in [missing_start, legacy, arbitrary_period] {
            accounts
                .snapshot_store
                .as_ref()
                .unwrap()
                .save(
                    "cursor",
                    "account-a",
                    &output,
                    "2026-08-24T02:00:00Z",
                    "2026-08-24T02:00:01Z",
                )
                .unwrap();
            assert!(
                accounts
                    .cursor_billing_cycle("account-a", 1_787_529_600_000)
                    .unwrap()
                    .is_none()
            );
            let stored = accounts
                .snapshot_store
                .as_ref()
                .unwrap()
                .load("cursor", "account-a")
                .unwrap()
                .unwrap();
            assert!(!stored.lines.is_empty(), "usage remains available");
            assert!(!stored.cursor_billing_period_verified);
        }
        let exact = build_usage_summary_output(
            br#"{
            "billingCycleStart":"2026-08-01T00:00:00Z","billingCycleEnd":"2026-09-01T00:00:00Z",
            "individualUsage":{"plan":{"used":10,"limit":100}}
        }"#,
            "Cursor",
            "",
        )
        .unwrap();
        accounts
            .snapshot_store
            .as_ref()
            .unwrap()
            .save(
                "cursor",
                "account-a",
                &exact,
                "2026-08-24T03:00:00Z",
                "2026-08-24T03:00:01Z",
            )
            .unwrap();
        assert!(
            accounts
                .cursor_billing_cycle("account-a", 1_787_529_600_000)
                .unwrap()
                .is_some()
        );
    }

    fn line(resets_at: Option<&str>, period_duration_ms: Option<u64>) -> MetricLine {
        MetricLine::Progress {
            label: "Total usage".to_string(),
            limit_resource_key: Some("totalUsage".to_string()),
            used: 25.0,
            limit: 100.0,
            format: ProgressFormat::Percent,
            resets_at: resets_at.map(str::to_string),
            period_duration_ms,
            color: None,
        }
    }

    #[test]
    fn history_uses_the_active_account_snapshot_billing_cycle_when_it_is_current() {
        let cycle = billing_cycle_from_lines(
            &[line(
                Some("2026-09-01T00:00:00Z"),
                Some(31 * 24 * 60 * 60 * 1_000),
            )],
            1_787_529_600_000,
        )
        .expect("current cycle");

        assert_eq!(cycle.start_ms, 1_785_542_400_000);
        assert_eq!(cycle.end_ms, 1_788_220_800_000);
    }

    #[test]
    fn expired_or_incomplete_quota_metadata_falls_back_to_the_bounded_window() {
        assert!(billing_cycle_from_lines(&[line(None, None)], 1_787_529_600_000).is_none());
        assert!(
            billing_cycle_from_lines(
                &[line(
                    Some("2026-08-01T00:00:00Z"),
                    Some(30 * 24 * 60 * 60 * 1_000),
                )],
                1_787_529_600_000,
            )
            .is_none()
        );
    }
}
