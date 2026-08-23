use super::HistoryError;

pub(crate) struct BillingCycle {
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct HistoryWindow {
    pub from_ms: i64,
    pub to_ms: i64,
    pub time_zone: String,
    pub utc_offset_seconds: i32,
}

pub(crate) fn current_period_window(
    now_ms: i64,
    billing_cycle: Option<BillingCycle>,
    time_zone: String,
    utc_offset_seconds: i32,
) -> Result<HistoryWindow, HistoryError> {
    const THIRTY_DAYS_MS: i64 = 30 * 86_400_000;

    if time_zone.trim().is_empty()
        || time::UtcOffset::from_whole_seconds(utc_offset_seconds).is_err()
    {
        return Err(HistoryError::InvalidTimeZoneOffset);
    }
    let fallback_start = now_ms
        .checked_sub(THIRTY_DAYS_MS)
        .filter(|value| *value > 0)
        .ok_or(HistoryError::InvalidWindow)?;
    let from_ms = billing_cycle
        .filter(|cycle| cycle.start_ms > 0 && cycle.start_ms < now_ms && cycle.end_ms > now_ms)
        .map_or(fallback_start, |cycle| cycle.start_ms.max(fallback_start));
    if from_ms >= now_ms {
        return Err(HistoryError::InvalidWindow);
    }
    Ok(HistoryWindow {
        from_ms,
        to_ms: now_ms,
        time_zone,
        utc_offset_seconds,
    })
}
