use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy)]
pub(crate) struct ClockReading {
    pub monotonic: Duration,
    pub unix_ms: u64,
}

pub(crate) trait BrokerClock: Send + Sync {
    fn now(&self) -> ClockReading;
}

pub(super) struct SystemBrokerClock {
    started_at: Instant,
    started_unix_ms: u64,
}

impl SystemBrokerClock {
    pub(super) fn new() -> Self {
        Self {
            started_at: Instant::now(),
            started_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
        }
    }
}

impl BrokerClock for SystemBrokerClock {
    fn now(&self) -> ClockReading {
        let monotonic = self.started_at.elapsed();
        ClockReading {
            monotonic,
            unix_ms: self
                .started_unix_ms
                .saturating_add(monotonic.as_millis().try_into().unwrap_or(u64::MAX)),
        }
    }
}
