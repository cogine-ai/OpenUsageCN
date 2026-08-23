use super::*;

const DAY_MS: i64 = 86_400_000;

#[test]
fn current_cycle_is_capped_to_latest_thirty_days_and_missing_cycle_falls_back() {
    let now = 1_800_000_000_000;
    let capped = current_period_window(
        now,
        Some(BillingCycle {
            start_ms: now - 45 * DAY_MS,
            end_ms: now + 5 * DAY_MS,
        }),
        "Asia/Taipei".to_string(),
        8 * 60 * 60,
    )
    .expect("valid current cycle");
    assert_eq!(capped.from_ms, now - 30 * DAY_MS);
    assert_eq!(capped.to_ms, now);

    let fallback = current_period_window(now, None, "UTC".to_string(), 0)
        .expect("missing cycle falls back to thirty days");
    assert_eq!(fallback.from_ms, now - 30 * DAY_MS);
    assert_eq!(fallback.to_ms, now);
}

#[test]
fn invalid_iana_time_zone_is_rejected_at_the_request_boundary() {
    let error = match current_period_window(
        1_800_000_000_000,
        None,
        "not/a-real-time-zone".to_string(),
        0,
    ) {
        Ok(_) => panic!("unknown IANA zones cannot produce trustworthy local dates"),
        Err(error) => error,
    };

    assert_eq!(error, HistoryError::InvalidTimeZone);
}
