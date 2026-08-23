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
        Ok(billing_cycle_from_lines(&snapshot.lines, now_ms))
    }
}

fn billing_cycle_from_lines(lines: &[MetricLine], now_ms: i64) -> Option<BillingCycle> {
    lines.iter().find_map(|line| {
        let MetricLine::Progress {
            resets_at: Some(resets_at),
            period_duration_ms: Some(period_duration_ms),
            ..
        } = line
        else {
            return None;
        };
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
    use crate::plugin_engine::runtime::{MetricLine, ProgressFormat};

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
