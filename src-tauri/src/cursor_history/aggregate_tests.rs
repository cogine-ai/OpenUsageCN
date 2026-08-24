use super::{
    CompleteHistory, HistoryTotals, ListCostCoverage, MeteredCoverage, ModelUsageBucket, RawNumber,
    ScriptedEvent, ScriptedHistory, ScriptedPage, ScriptedTokenUsage, aggregate_scripted_history,
};

const FROM_MS: i64 = 1_704_067_200_000;
const TO_MS: i64 = 1_704_153_600_000;

fn token_event(
    timestamp_ms: i128,
    model_name: &str,
    tokens: [i128; 4],
    total_cents: RawNumber,
    charged_cents: RawNumber,
) -> ScriptedEvent {
    ScriptedEvent {
        timestamp_ms: RawNumber::Integer(timestamp_ms),
        model_name: model_name.to_string(),
        token_usage: Some(ScriptedTokenUsage {
            input_tokens: RawNumber::Integer(tokens[0]),
            output_tokens: RawNumber::Integer(tokens[1]),
            cache_write_tokens: RawNumber::Integer(tokens[2]),
            cache_read_tokens: RawNumber::Integer(tokens[3]),
            total_cents,
        }),
        charged_cents,
        owning_user: None,
        owning_team: None,
    }
}

fn non_token_event(timestamp_ms: i128, charged_cents: RawNumber) -> ScriptedEvent {
    ScriptedEvent {
        timestamp_ms: RawNumber::Integer(timestamp_ms),
        model_name: "ignored-without-tokens".to_string(),
        token_usage: None,
        charged_cents,
        owning_user: None,
        owning_team: None,
    }
}

fn aggregate(events: Vec<ScriptedEvent>) -> CompleteHistory {
    aggregate_scripted_history(script(events)).expect("fixture is a complete history")
}

fn assert_los_angeles_local_date(timestamp_ms: i64, expected_date: &str) {
    let event = token_event(
        i128::from(timestamp_ms),
        "model-dst",
        [1, 0, 0, 0],
        RawNumber::Integer(0),
        RawNumber::Integer(0),
    );
    let history = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-dst".to_string(),
        from_ms: timestamp_ms - 60_000,
        to_ms: timestamp_ms + 60_000,
        fetched_at_ms: timestamp_ms + 120_000,
        time_zone: "America/Los_Angeles".to_string(),
        requested_page_size: 1_000,
        pages: vec![ScriptedPage {
            page: 1,
            events: vec![event],
            total_usage_events_count: Some(1),
        }],
    })
    .expect("IANA rules map the event into an account-local date");

    assert_eq!(history.buckets[0].local_date, expected_date);
}

fn script(events: Vec<ScriptedEvent>) -> ScriptedHistory {
    let total = u64::try_from(events.len()).expect("fixture count fits u64");
    ScriptedHistory {
        account_id: "account-cost".to_string(),
        from_ms: FROM_MS,
        to_ms: TO_MS,
        fetched_at_ms: TO_MS + 1,
        time_zone: "UTC".to_string(),
        requested_page_size: 1_000,
        pages: vec![ScriptedPage {
            page: 1,
            events,
            total_usage_events_count: Some(total),
        }],
    }
}

#[test]
fn aggregates_four_token_classes_by_local_date_and_raw_model() {
    let result = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-model-history".to_string(),
        from_ms: 1_704_067_200_000,
        to_ms: 1_704_153_600_000,
        fetched_at_ms: 1_704_160_000_000,
        time_zone: "Etc/GMT+1".to_string(),
        requested_page_size: 1_000,
        pages: vec![ScriptedPage {
            page: 1,
            events: vec![
                ScriptedEvent {
                    timestamp_ms: RawNumber::Integer(1_704_069_000_000),
                    model_name: "cursor-small".to_string(),
                    token_usage: Some(ScriptedTokenUsage {
                        input_tokens: RawNumber::Integer(10),
                        output_tokens: RawNumber::Integer(20),
                        cache_write_tokens: RawNumber::Integer(30),
                        cache_read_tokens: RawNumber::Integer(40),
                        total_cents: RawNumber::Decimal(125.0),
                    }),
                    charged_cents: RawNumber::Decimal(50.0),
                    owning_user: None,
                    owning_team: None,
                },
                ScriptedEvent {
                    timestamp_ms: RawNumber::Integer(1_704_069_900_000),
                    model_name: "cursor-small".to_string(),
                    token_usage: Some(ScriptedTokenUsage {
                        input_tokens: RawNumber::Integer(1),
                        output_tokens: RawNumber::Integer(2),
                        cache_write_tokens: RawNumber::Integer(3),
                        cache_read_tokens: RawNumber::Integer(4),
                        total_cents: RawNumber::Decimal(75.0),
                    }),
                    charged_cents: RawNumber::Decimal(25.0),
                    owning_user: None,
                    owning_team: None,
                },
            ],
            total_usage_events_count: Some(2),
        }],
    })
    .expect("the complete page maps into an account-local aggregate");

    assert_eq!(result.account_id, "account-model-history");
    assert_eq!(
        result.buckets,
        vec![ModelUsageBucket {
            local_date: "2023-12-31".to_string(),
            model_name: "cursor-small".to_string(),
            input_tokens: 11,
            output_tokens: 22,
            cache_write_tokens: 33,
            cache_read_tokens: 44,
            request_count: 2,
            known_list_cost_usd: Some(2.0),
            list_cost_coverage: ListCostCoverage::Complete,
        }]
    );
    assert_eq!(
        result.totals,
        HistoryTotals {
            metered_charged_usd: Some(0.75),
            metered_coverage: MeteredCoverage::Complete,
        }
    );
}

#[test]
fn local_dates_use_historical_iana_offsets_across_dst_changes() {
    // 2024-03-10 07:30Z was still 2024-03-09 in Los Angeles (UTC-8).
    assert_los_angeles_local_date(1_710_055_800_000, "2024-03-09");

    // 2024-11-03 07:30Z was already 2024-11-03 in Los Angeles (UTC-7).
    assert_los_angeles_local_date(1_730_619_000_000, "2024-11-03");
}

#[test]
fn missing_total_cents_preserves_known_cost_and_marks_partial() {
    let history = aggregate(vec![
        token_event(
            1_704_069_000_000,
            "model-a",
            [1, 0, 0, 0],
            RawNumber::Decimal(125.0),
            RawNumber::Integer(0),
        ),
        token_event(
            1_704_069_100_000,
            "model-a",
            [1, 0, 0, 0],
            RawNumber::Missing,
            RawNumber::Integer(0),
        ),
        token_event(
            1_704_069_200_000,
            "model-a",
            [1, 0, 0, 0],
            RawNumber::Decimal(25.0),
            RawNumber::Integer(0),
        ),
    ]);

    assert_eq!(history.buckets[0].known_list_cost_usd, Some(1.5));
    assert_eq!(
        history.buckets[0].list_cost_coverage,
        ListCostCoverage::Partial
    );
}

#[test]
fn invalid_total_cents_latches_invalid_for_the_bucket() {
    let history = aggregate(vec![
        token_event(
            1_704_069_000_000,
            "model-a",
            [1, 0, 0, 0],
            RawNumber::Decimal(100.0),
            RawNumber::Integer(0),
        ),
        token_event(
            1_704_069_100_000,
            "model-a",
            [1, 0, 0, 0],
            RawNumber::Decimal(f64::NAN),
            RawNumber::Integer(0),
        ),
        token_event(
            1_704_069_200_000,
            "model-a",
            [1, 0, 0, 0],
            RawNumber::Decimal(50.0),
            RawNumber::Integer(0),
        ),
    ]);

    assert_eq!(history.buckets[0].known_list_cost_usd, None);
    assert_eq!(
        history.buckets[0].list_cost_coverage,
        ListCostCoverage::Invalid
    );
}

#[test]
fn metered_total_includes_valid_non_token_events() {
    let history = aggregate(vec![
        token_event(
            1_704_069_000_000,
            "model-a",
            [1, 0, 0, 0],
            RawNumber::Integer(0),
            RawNumber::Decimal(50.0),
        ),
        non_token_event(1_704_069_100_000, RawNumber::Decimal(25.0)),
    ]);

    assert_eq!(history.buckets[0].request_count, 1);
    assert_eq!(
        history.totals,
        HistoryTotals {
            metered_charged_usd: Some(0.75),
            metered_coverage: MeteredCoverage::Complete,
        }
    );
}

#[test]
fn any_unpriced_valid_event_makes_the_whole_window_metered_total_incomplete() {
    let history = aggregate(vec![
        non_token_event(1_704_069_000_000, RawNumber::Decimal(50.0)),
        non_token_event(1_704_069_100_000, RawNumber::Missing),
        non_token_event(1_704_069_200_000, RawNumber::Decimal(25.0)),
        non_token_event(1_704_069_300_000, RawNumber::Invalid),
    ]);

    assert_eq!(
        history.totals,
        HistoryTotals {
            metered_charged_usd: None,
            metered_coverage: MeteredCoverage::Incomplete,
        }
    );
}

#[test]
fn legitimate_equal_events_remain_separate_requests_with_the_raw_model() {
    let event = token_event(
        1_704_069_000_000,
        "",
        [2, 3, 5, 7],
        RawNumber::Decimal(10.0),
        RawNumber::Decimal(4.0),
    );
    let history = aggregate(vec![event.clone(), event]);

    assert_eq!(history.buckets[0].model_name, "");
    assert_eq!(history.buckets[0].request_count, 2);
    assert_eq!(history.buckets[0].input_tokens, 4);
    assert_eq!(history.buckets[0].known_list_cost_usd, Some(0.2));
    assert_eq!(history.totals.metered_charged_usd, Some(0.08));
}

#[test]
fn ownership_fields_do_not_change_or_escape_the_aggregate() {
    let plain = token_event(
        1_704_069_000_000,
        "model-a",
        [1, 0, 0, 0],
        RawNumber::Integer(0),
        RawNumber::Integer(0),
    );
    let mut owned = plain.clone();
    owned.owning_user = Some("private-user@example.test".to_string());
    owned.owning_team = Some("private-team-identifier".to_string());

    let plain_history = aggregate(vec![plain]);
    let owned_history = aggregate(vec![owned]);
    let serialized = serde_json::to_string(&owned_history).expect("aggregate serializes");

    assert_eq!(owned_history, plain_history);
    assert!(!serialized.contains("private-user"));
    assert!(!serialized.contains("private-team"));
    assert!(!serialized.contains("owningUser"));
    assert!(!serialized.contains("owningTeam"));
}

#[test]
fn proven_adjacent_boundary_overlap_is_removed_before_aggregation() {
    let repeated = token_event(
        1_704_069_000_000,
        "model-a",
        [1, 0, 0, 0],
        RawNumber::Decimal(20.0),
        RawNumber::Decimal(10.0),
    );
    let mut first_page = vec![non_token_event(0, RawNumber::Missing); 999];
    first_page.push(repeated.clone());
    let history = aggregate_scripted_history(ScriptedHistory {
        account_id: "account-overlap".to_string(),
        from_ms: FROM_MS,
        to_ms: TO_MS,
        fetched_at_ms: TO_MS + 1,
        time_zone: "UTC".to_string(),
        requested_page_size: 1_000,
        pages: vec![
            ScriptedPage {
                page: 1,
                events: first_page,
                total_usage_events_count: Some(1_000),
            },
            ScriptedPage {
                page: 2,
                events: vec![repeated],
                total_usage_events_count: Some(1_000),
            },
        ],
    })
    .expect("the exact boundary overlap reconciles the total");

    assert_eq!(history.buckets[0].request_count, 1);
    assert_eq!(history.buckets[0].known_list_cost_usd, Some(0.2));
    assert_eq!(history.totals.metered_charged_usd, Some(0.1));
}

#[test]
fn malformed_token_values_fail_the_account_aggregate() {
    let mut event = token_event(
        1_704_069_000_000,
        "model-a",
        [1, 0, 0, 0],
        RawNumber::Integer(0),
        RawNumber::Integer(0),
    );
    event
        .token_usage
        .as_mut()
        .expect("fixture has token usage")
        .input_tokens = RawNumber::Decimal(1.5);

    let error = aggregate_scripted_history(script(vec![event]))
        .expect_err("fractional token counts cannot produce a complete aggregate");

    assert_eq!(error, super::HistoryError::MalformedTokenValue);
}

#[test]
fn missing_and_integer_decimal_token_fields_map_to_exact_zero_or_counts() {
    let mut event = token_event(
        1_704_069_000_000,
        "model-a",
        [0, 0, 0, 0],
        RawNumber::Integer(0),
        RawNumber::Integer(0),
    );
    let usage = event.token_usage.as_mut().expect("fixture has token usage");
    usage.input_tokens = RawNumber::Missing;
    usage.output_tokens = RawNumber::Decimal(2.0);
    usage.cache_write_tokens = RawNumber::Missing;
    usage.cache_read_tokens = RawNumber::Integer(3);

    let history = aggregate_scripted_history(script(vec![event]))
        .expect("optional zero fields and integer decimals are valid token counters");

    assert_eq!(history.buckets[0].input_tokens, 0);
    assert_eq!(history.buckets[0].output_tokens, 2);
    assert_eq!(history.buckets[0].cache_write_tokens, 0);
    assert_eq!(history.buckets[0].cache_read_tokens, 3);
}

#[test]
fn aggregate_token_totals_cannot_exceed_javascript_safe_integer_range() {
    let events = vec![
        token_event(
            1_704_069_000_000,
            "model-a",
            [9_007_199_254_740_991, 0, 0, 0],
            RawNumber::Integer(0),
            RawNumber::Integer(0),
        ),
        token_event(
            1_704_069_100_000,
            "model-a",
            [1, 0, 0, 0],
            RawNumber::Integer(0),
            RawNumber::Integer(0),
        ),
    ];

    let error = aggregate_scripted_history(script(events))
        .expect_err("frontend token totals must remain exact JavaScript integers");

    assert_eq!(error, super::HistoryError::TokenOverflow);
}

#[test]
fn four_class_token_sum_overflow_fails_the_account_aggregate() {
    let event = token_event(
        1_704_069_000_000,
        "model-a",
        [i128::from(u64::MAX), 1, 0, 0],
        RawNumber::Integer(0),
        RawNumber::Integer(0),
    );

    let error = aggregate_scripted_history(script(vec![event]))
        .expect_err("overflow cannot publish a partial aggregate");

    assert_eq!(error, super::HistoryError::TokenOverflow);
}
