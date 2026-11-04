use serde_json::Value;

use super::{
    EventBilling, HistoryBillingTotals, HistoryError, MeteredCoverage, RawNumber, ScriptedEvent,
};

pub(super) fn classify(kind: Option<&Value>, chargeable: Option<&Value>) -> EventBilling {
    match (
        kind.and_then(Value::as_str),
        chargeable.and_then(Value::as_bool),
    ) {
        (_, Some(false)) => EventBilling::NotCharged,
        (Some("USAGE_EVENT_KIND_USAGE_BASED"), Some(true)) => EventBilling::OnDemand,
        _ => EventBilling::Unknown,
    }
}

pub(super) fn valid_totals(value: &HistoryBillingTotals) -> bool {
    value.known_on_demand_charged_usd.is_finite()
        && (0.0..=90_071_992_547_409.9).contains(&value.known_on_demand_charged_usd)
        && value.usage_event_count <= 9_007_199_254_740_991
        && value.unclassified_event_count <= value.usage_event_count
        && (value.on_demand_coverage == MeteredCoverage::Complete)
            == (value.unclassified_event_count == 0)
}

#[derive(Default)]
pub(super) struct BillingAccumulator {
    events: u64,
    unknown: u64,
    known_cents: f64,
}

impl BillingAccumulator {
    pub(super) fn add(&mut self, event: &ScriptedEvent) -> Result<(), HistoryError> {
        self.events = self
            .events
            .checked_add(1)
            .ok_or(HistoryError::TokenOverflow)?;
        match event.billing {
            EventBilling::NotCharged => {}
            EventBilling::Unknown => self.unknown += 1,
            EventBilling::OnDemand => {
                let cents = match &event.charged_cents {
                    RawNumber::Integer(n) if *n >= 0 && *n <= 9_007_199_254_740_991 => {
                        Some(*n as f64)
                    }
                    RawNumber::Decimal(n) if n.is_finite() && *n >= 0.0 => Some(*n),
                    _ => None,
                };
                if let Some(cents) =
                    cents.filter(|cents| self.known_cents + cents <= 9_007_199_254_740_991.0)
                {
                    self.known_cents += cents;
                } else {
                    self.unknown += 1;
                }
            }
        }
        Ok(())
    }

    pub(super) fn finish(self) -> HistoryBillingTotals {
        HistoryBillingTotals {
            usage_event_count: self.events,
            known_on_demand_charged_usd: self.known_cents / 100.0,
            on_demand_coverage: if self.unknown == 0 {
                MeteredCoverage::Complete
            } else {
                MeteredCoverage::Incomplete
            },
            unclassified_event_count: self.unknown,
        }
    }
}
