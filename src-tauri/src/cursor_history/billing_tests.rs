use super::*;

fn history(events: serde_json::Value) -> CompleteHistory {
    let count = events.as_array().unwrap().len();
    let page = transport::decode_page_body(
        1,
        &serde_json::to_vec(&serde_json::json!({
            "totalUsageEventsCount": count, "usageEventsDisplay": events,
        }))
        .unwrap(),
    )
    .unwrap();
    aggregate_scripted_history(ScriptedHistory {
        account_id: "billing-account".into(),
        from_ms: 1_700_000_000_000,
        to_ms: 1_700_086_400_000,
        fetched_at_ms: 1_700_090_000_000,
        time_zone: "UTC".into(),
        requested_page_size: 1000,
        pages: vec![page],
    })
    .unwrap()
}

#[test]
fn only_explicit_on_demand_charges_are_separated_from_legacy_plan_deductions() {
    let result = history(serde_json::json!([
        {"timestamp":"1700000001000", "kind":"USAGE_EVENT_KIND_USAGE_BASED", "isChargeable":true, "chargedCents":125,
         "model":"model-a", "tokenUsage":{"inputTokens":10,"outputTokens":2,"cacheWriteTokens":0,"cacheReadTokens":0,"totalCents":200}},
        {"timestamp":"1700000002000", "kind":"USAGE_EVENT_KIND_INCLUDED_IN_PRO", "isChargeable":false, "chargedCents":999},
        {"timestamp":"1700000003000", "kind":"USAGE_EVENT_KIND_USAGE_BASED", "isChargeable":false, "chargedCents":50},
        {"timestamp":"1700000004000", "kind":"USAGE_EVENT_KIND_FREE_CREDIT", "isChargeable":false, "chargedCents":40}
    ]));
    let billing = result.totals.billing.as_ref().unwrap();
    assert_eq!(billing.usage_event_count, 4);
    assert_eq!(billing.known_on_demand_charged_usd, 1.25);
    assert_eq!(billing.on_demand_coverage, MeteredCoverage::Complete);
    assert_eq!(billing.unclassified_event_count, 0);
    assert_eq!(result.totals.metered_charged_usd, Some(12.14));
    assert_eq!(result.buckets.len(), 1);
    assert_eq!(result.buckets[0].request_count, 1);
    assert_eq!(result.buckets[0].known_list_cost_usd, Some(2.0));
}

#[test]
fn unknown_kinds_flags_or_amounts_keep_a_known_subtotal_with_explicit_incomplete_coverage() {
    let result = history(serde_json::json!([
        {"timestamp":"1700000001000", "kind":"USAGE_EVENT_KIND_USAGE_BASED", "isChargeable":true, "chargedCents":"3.5"},
        {"timestamp":"1700000002000", "kind":"USAGE_EVENT_KIND_USAGE_BASED", "chargedCents":50},
        {"timestamp":"1700000003000", "kind":"FUTURE_KIND", "isChargeable":true, "chargedCents":999},
        {"timestamp":"1700000004000", "kind":"USAGE_EVENT_KIND_USAGE_BASED", "isChargeable":"true", "chargedCents":20},
        {"timestamp":"1700000005000", "kind":"USAGE_EVENT_KIND_USAGE_BASED", "isChargeable":true},
        {"timestamp":"1700000006000", "kind":"USAGE_EVENT_KIND_USAGE_BASED", "isChargeable":true, "chargedCents":-1},
        {"timestamp":"1700000007000", "kind":12, "isChargeable":true, "chargedCents":20},
        {"timestamp":"1699999999999", "kind":"USAGE_EVENT_KIND_USAGE_BASED", "isChargeable":true, "chargedCents":500},
        {"timestamp":"invalid", "kind":"USAGE_EVENT_KIND_USAGE_BASED", "isChargeable":true, "chargedCents":500}
    ]));
    let billing = result.totals.billing.as_ref().unwrap();
    assert_eq!(billing.usage_event_count, 7);
    assert_eq!(billing.known_on_demand_charged_usd, 0.035);
    assert_eq!(billing.on_demand_coverage, MeteredCoverage::Incomplete);
    assert_eq!(billing.unclassified_event_count, 6);
    assert!(result.buckets.is_empty());
    assert_eq!(result.totals.metered_charged_usd, None);
}

#[test]
fn old_snapshots_do_not_turn_missing_billing_classification_into_zero() {
    let result = history(serde_json::json!([]));
    let mut value = serde_json::to_value(result).unwrap();
    value["totals"].as_object_mut().unwrap().remove("billing");
    let old: CompleteHistory = serde_json::from_value(value).unwrap();
    assert!(old.totals.billing.is_none());
    let csv = export::history_csv(&old).unwrap();
    assert!(csv.contains("\"Usage Events\",\"Known On-Demand Charges USD\",\"On-Demand Coverage\",\"Unclassified Events\""));
    assert!(csv.contains("\"Unavailable\""));
}

#[test]
fn appended_csv_fields_preserve_column_alignment_and_subtotal_meaning() {
    let result = history(serde_json::json!([
        {"timestamp":"1700000001000", "kind":"USAGE_EVENT_KIND_USAGE_BASED", "isChargeable":true, "chargedCents":125,
         "model":"model-a", "tokenUsage":{"inputTokens":1,"outputTokens":0,"cacheWriteTokens":0,"cacheReadTokens":0,"totalCents":100}},
        {"timestamp":"1700000002000", "chargedCents":999}
    ]));
    let csv = export::history_csv(&result).unwrap();
    let rows: Vec<_> = csv.lines().collect();
    assert_eq!(rows.len(), 3);
    assert!(rows[1].ends_with("\"2\",\"1.25\",\"Incomplete\",\"1\""));
    assert!(rows[2].ends_with("\"\",\"\",\"\",\"\""));
    assert_eq!(
        rows[0].matches("\",\"").count(),
        rows[1].matches("\",\"").count()
    );
    assert_eq!(
        rows[0].matches("\",\"").count(),
        rows[2].matches("\",\"").count()
    );
}

#[test]
fn invalid_billing_cache_cannot_replace_a_complete_account_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let store = HistoryStore::new(directory.path());
    let mut result = history(serde_json::json!([]));
    store.save("cursor", "billing-account", &result).unwrap();
    result
        .totals
        .billing
        .as_mut()
        .unwrap()
        .known_on_demand_charged_usd = -1.0;
    result.coverage.fetched_at_ms += 1;
    assert_eq!(
        store.save("cursor", "billing-account", &result),
        Err(HistoryError::StorageInvalid)
    );
    assert_eq!(
        store
            .load("cursor", "billing-account")
            .unwrap()
            .unwrap()
            .totals
            .billing
            .unwrap()
            .known_on_demand_charged_usd,
        0.0
    );
}
