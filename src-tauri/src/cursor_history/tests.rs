use super::{
    CompleteHistory, HistoryCoverage, HistoryError, HistoryScope, HistoryTotals, RawNumber,
    ScriptedEvent, ScriptedHistory, ScriptedPage, aggregate_scripted_history,
};

fn pagination_event() -> ScriptedEvent {
    ScriptedEvent {
        timestamp_ms: RawNumber::Missing,
        model_name: String::new(),
        token_usage: None,
        charged_cents: RawNumber::Missing,
        owning_user: None,
        owning_team: None,
    }
}

#[test]
fn short_final_page_returns_complete_account_aggregate() {
    let result = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1_700_000_000_000,
        to_ms: 1_700_086_400_000,
        fetched_at_ms: 1_700_090_000_000,
        time_zone: "America/Los_Angeles".to_string(),
        utc_offset_seconds: -7 * 60 * 60,
        requested_page_size: 1_000,
        pages: vec![ScriptedPage {
            page: 1,
            events: Vec::new(),
            total_usage_events_count: Some(0),
        }],
    })
    .expect("an empty short final page is complete");

    assert_eq!(
        result,
        CompleteHistory {
            account_id: "account-a".to_string(),
            buckets: Vec::new(),
            coverage: HistoryCoverage {
                from_ms: 1_700_000_000_000,
                to_ms: 1_700_086_400_000,
                fetched_at_ms: 1_700_090_000_000,
                time_zone: "America/Los_Angeles".to_string(),
                complete: true,
                scope: HistoryScope::SessionVisible,
            },
            totals: HistoryTotals {
                metered_charged_usd: Some(0.0),
                metered_coverage: super::MeteredCoverage::Complete,
            },
        }
    );
}

#[test]
fn rejects_a_page_size_other_than_one_thousand() {
    let error = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 999,
        pages: vec![ScriptedPage {
            page: 1,
            events: Vec::new(),
            total_usage_events_count: Some(0),
        }],
    })
    .expect_err("the history ledger contract fixes pageSize at 1000");

    assert_eq!(error, HistoryError::UnexpectedPageSize { actual: 999 });
}

#[test]
fn missing_page_fails_the_complete_fetch() {
    let error = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 1_000,
        pages: vec![
            ScriptedPage {
                page: 1,
                events: Vec::new(),
                total_usage_events_count: None,
            },
            ScriptedPage {
                page: 3,
                events: Vec::new(),
                total_usage_events_count: None,
            },
        ],
    })
    .expect_err("a gap means the fetch is incomplete");

    assert_eq!(
        error,
        HistoryError::MissingPage {
            expected: 2,
            actual: 3,
        }
    );
}

#[test]
fn more_than_two_hundred_pages_is_incomplete() {
    let pages = (1..=201)
        .map(|page| ScriptedPage {
            page,
            events: Vec::new(),
            total_usage_events_count: None,
        })
        .collect();

    let error = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 1_000,
        pages,
    })
    .expect_err("the ledger has a hard 200-page cap");

    assert_eq!(error, HistoryError::PageLimitExceeded { actual: 201 });
}

#[test]
fn changing_authoritative_total_fails_the_complete_fetch() {
    let error = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 1_000,
        pages: vec![
            ScriptedPage {
                page: 1,
                events: vec![pagination_event(); 1_000],
                total_usage_events_count: Some(1_001),
            },
            ScriptedPage {
                page: 2,
                events: vec![pagination_event()],
                total_usage_events_count: Some(1_002),
            },
        ],
    })
    .expect_err("the authoritative total must remain stable");

    assert_eq!(
        error,
        HistoryError::TotalCountDrift {
            expected: Some(1_001),
            actual: Some(1_002),
            page: 2,
        }
    );
}

#[test]
fn a_full_last_page_is_incomplete_even_when_the_total_is_reached() {
    let error = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 1_000,
        pages: vec![ScriptedPage {
            page: 1,
            events: vec![pagination_event(); 1_000],
            total_usage_events_count: Some(1_000),
        }],
    })
    .expect_err("a short or empty page must prove the end of the ledger");

    assert_eq!(error, HistoryError::FinalPageNotShort { page: 1 });
}

#[test]
fn collected_rows_must_reach_the_authoritative_total() {
    let error = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 1_000,
        pages: vec![ScriptedPage {
            page: 1,
            events: vec![pagination_event()],
            total_usage_events_count: Some(2),
        }],
    })
    .expect_err("a stable total also has to be reached");

    assert_eq!(
        error,
        HistoryError::CountMismatch {
            expected: 2,
            actual: 1,
        }
    );
}

#[test]
fn exact_adjacent_boundary_overlap_can_reconcile_an_overcount() {
    let result = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 1_000,
        pages: vec![
            ScriptedPage {
                page: 1,
                events: vec![pagination_event(); 1_000],
                total_usage_events_count: Some(1_000),
            },
            ScriptedPage {
                page: 2,
                events: vec![pagination_event()],
                total_usage_events_count: Some(1_000),
            },
        ],
    });

    assert!(result.is_ok(), "the single exact boundary repeat is proven");
}

#[test]
fn rows_after_a_short_page_are_incomplete() {
    let error = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 1_000,
        pages: vec![
            ScriptedPage {
                page: 1,
                events: Vec::new(),
                total_usage_events_count: None,
            },
            ScriptedPage {
                page: 2,
                events: Vec::new(),
                total_usage_events_count: None,
            },
        ],
    })
    .expect_err("only the final page may be short or empty");

    assert_eq!(error, HistoryError::RowsAfterFinalPage { page: 1 });
}

#[test]
fn a_response_page_cannot_exceed_one_thousand_rows() {
    let error = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 1_000,
        pages: vec![ScriptedPage {
            page: 1,
            events: vec![pagination_event(); 1_001],
            total_usage_events_count: Some(1_001),
        }],
    })
    .expect_err("the response also has to honor the fixed page size");

    assert_eq!(
        error,
        HistoryError::PageTooLarge {
            page: 1,
            actual: 1_001,
        }
    );
}

#[test]
fn a_missing_first_page_is_incomplete() {
    let error = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 1_000,
        pages: Vec::new(),
    })
    .expect_err("a fetch without page one proves nothing");

    assert_eq!(error, HistoryError::NoPages);
}

#[test]
fn an_unexplained_overcount_is_not_globally_deduplicated() {
    let mut different_event = pagination_event();
    different_event.model_name = "not-the-boundary-event".to_string();
    let error = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 1_000,
        pages: vec![
            ScriptedPage {
                page: 1,
                events: vec![pagination_event(); 1_000],
                total_usage_events_count: Some(1_000),
            },
            ScriptedPage {
                page: 2,
                events: vec![different_event],
                total_usage_events_count: Some(1_000),
            },
        ],
    })
    .expect_err("only an exact adjacent boundary repeat can explain an overcount");

    assert_eq!(
        error,
        HistoryError::CountMismatch {
            expected: 1_000,
            actual: 1_001,
        }
    );
}

#[test]
fn an_ambiguous_partial_boundary_overlap_fails_closed() {
    let error = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-a".to_string(),
        from_ms: 1,
        to_ms: 2,
        fetched_at_ms: 3,
        time_zone: "UTC".to_string(),
        utc_offset_seconds: 0,
        requested_page_size: 1_000,
        pages: vec![
            ScriptedPage {
                page: 1,
                events: vec![pagination_event(); 1_000],
                total_usage_events_count: Some(1_001),
            },
            ScriptedPage {
                page: 2,
                events: vec![pagination_event(); 2],
                total_usage_events_count: Some(1_001),
            },
        ],
    })
    .expect_err("one of two identical boundary rows cannot be selected safely");

    assert_eq!(
        error,
        HistoryError::CountMismatch {
            expected: 1_001,
            actual: 1_002,
        }
    );
}
