use std::collections::BTreeMap;

use time::{OffsetDateTime, UtcOffset};

use super::{
    HistoryError, HistoryTotals, ListCostCoverage, MeteredCoverage, ModelUsageBucket, RawNumber,
    ScriptedEvent, ScriptedTokenUsage,
};

const MAX_SAFE_CENTS: f64 = 9_007_199_254_740_991.0;

#[derive(Default)]
struct BucketAccumulator {
    input_tokens: u64,
    output_tokens: u64,
    cache_write_tokens: u64,
    cache_read_tokens: u64,
    request_count: u64,
    known_list_cost_cents: f64,
    has_known_list_cost: bool,
    list_cost_coverage: Option<ListCostCoverage>,
}

pub(super) fn aggregate_events(
    events: Vec<ScriptedEvent>,
    from_ms: i64,
    to_ms: i64,
    utc_offset_seconds: i32,
) -> Result<(Vec<ModelUsageBucket>, HistoryTotals), HistoryError> {
    if from_ms <= 0 || to_ms <= from_ms {
        return Err(HistoryError::InvalidWindow);
    }
    let offset = UtcOffset::from_whole_seconds(utc_offset_seconds)
        .map_err(|_| HistoryError::InvalidTimeZoneOffset)?;
    let mut buckets = BTreeMap::<(String, String), BucketAccumulator>::new();
    let mut metered_cents = 0.0;
    let mut metered_complete = true;

    for event in events {
        let Some(timestamp_ms) = integer_timestamp(&event.timestamp_ms) else {
            continue;
        };
        if timestamp_ms < from_ms || timestamp_ms >= to_ms {
            continue;
        }

        match valid_cents(&event.charged_cents) {
            Some(cents) if metered_complete => {
                let next = metered_cents + cents;
                if next.is_finite() && next <= MAX_SAFE_CENTS {
                    metered_cents = next;
                } else {
                    metered_complete = false;
                }
            }
            Some(_) => {}
            None => metered_complete = false,
        }

        let Some(token_usage) = event.token_usage else {
            continue;
        };
        let counts = token_counts(&token_usage)?;
        let total_tokens = counts
            .iter()
            .try_fold(0_u64, |sum, value| sum.checked_add(*value))
            .ok_or(HistoryError::TokenOverflow)?;
        if total_tokens == 0 {
            continue;
        }
        let local_date = local_date(timestamp_ms, offset).ok_or(HistoryError::InvalidWindow)?;
        let bucket = buckets.entry((local_date, event.model_name)).or_default();
        bucket.input_tokens = checked_add(bucket.input_tokens, counts[0])?;
        bucket.output_tokens = checked_add(bucket.output_tokens, counts[1])?;
        bucket.cache_write_tokens = checked_add(bucket.cache_write_tokens, counts[2])?;
        bucket.cache_read_tokens = checked_add(bucket.cache_read_tokens, counts[3])?;
        bucket.request_count = checked_add(bucket.request_count, 1)?;
        update_list_cost(bucket, &token_usage.total_cents);
    }

    let buckets = buckets
        .into_iter()
        .map(|((local_date, model_name), bucket)| {
            let list_cost_coverage = bucket
                .list_cost_coverage
                .unwrap_or(ListCostCoverage::Complete);
            let known_list_cost_usd =
                if list_cost_coverage == ListCostCoverage::Invalid || !bucket.has_known_list_cost {
                    None
                } else {
                    Some(bucket.known_list_cost_cents / 100.0)
                };
            ModelUsageBucket {
                local_date,
                model_name,
                input_tokens: bucket.input_tokens,
                output_tokens: bucket.output_tokens,
                cache_write_tokens: bucket.cache_write_tokens,
                cache_read_tokens: bucket.cache_read_tokens,
                request_count: bucket.request_count,
                known_list_cost_usd,
                list_cost_coverage,
            }
        })
        .collect();
    let totals = if metered_complete {
        HistoryTotals {
            metered_charged_usd: Some(metered_cents / 100.0),
            metered_coverage: MeteredCoverage::Complete,
        }
    } else {
        HistoryTotals {
            metered_charged_usd: None,
            metered_coverage: MeteredCoverage::Incomplete,
        }
    };
    Ok((buckets, totals))
}

fn integer_timestamp(value: &RawNumber) -> Option<i64> {
    match value {
        RawNumber::Integer(value) => i64::try_from(*value).ok().filter(|value| *value > 0),
        RawNumber::Missing | RawNumber::Decimal(_) | RawNumber::Invalid => None,
    }
}

fn token_counts(token_usage: &ScriptedTokenUsage) -> Result<[u64; 4], HistoryError> {
    Ok([
        token_count(&token_usage.input_tokens)?,
        token_count(&token_usage.output_tokens)?,
        token_count(&token_usage.cache_write_tokens)?,
        token_count(&token_usage.cache_read_tokens)?,
    ])
}

fn token_count(value: &RawNumber) -> Result<u64, HistoryError> {
    match value {
        RawNumber::Integer(value) => {
            u64::try_from(*value).map_err(|_| HistoryError::MalformedTokenValue)
        }
        RawNumber::Missing | RawNumber::Decimal(_) | RawNumber::Invalid => {
            Err(HistoryError::MalformedTokenValue)
        }
    }
}

fn checked_add(left: u64, right: u64) -> Result<u64, HistoryError> {
    left.checked_add(right).ok_or(HistoryError::TokenOverflow)
}

fn local_date(timestamp_ms: i64, offset: UtcOffset) -> Option<String> {
    let nanos = i128::from(timestamp_ms).checked_mul(1_000_000)?;
    let date = OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .ok()?
        .to_offset(offset)
        .date();
    Some(format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        date.month() as u8,
        date.day()
    ))
}

fn valid_cents(value: &RawNumber) -> Option<f64> {
    let value = match value {
        RawNumber::Integer(value) => *value as f64,
        RawNumber::Decimal(value) => *value,
        RawNumber::Missing | RawNumber::Invalid => return None,
    };
    (value.is_finite() && value >= 0.0 && value <= MAX_SAFE_CENTS).then_some(value)
}

fn update_list_cost(bucket: &mut BucketAccumulator, value: &RawNumber) {
    if bucket.list_cost_coverage == Some(ListCostCoverage::Invalid) {
        return;
    }
    match value {
        RawNumber::Missing => {
            bucket.list_cost_coverage = Some(ListCostCoverage::Partial);
        }
        _ => match valid_cents(value) {
            Some(cents) => {
                let next = bucket.known_list_cost_cents + cents;
                if next.is_finite() && next <= MAX_SAFE_CENTS {
                    bucket.known_list_cost_cents = next;
                    bucket.has_known_list_cost = true;
                    bucket
                        .list_cost_coverage
                        .get_or_insert(ListCostCoverage::Complete);
                } else {
                    bucket.list_cost_coverage = Some(ListCostCoverage::Invalid);
                }
            }
            None => bucket.list_cost_coverage = Some(ListCostCoverage::Invalid),
        },
    }
}
