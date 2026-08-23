use super::*;

#[test]
fn auth_me_requires_a_nonempty_string_subject() {
    let valid =
        transport::decode_auth_body(br#"{"sub":"stable-subject"}"#).expect("valid auth response");
    match valid {
        AuthOutcome::Authenticated(identity) => assert_eq!(identity.subject(), "stable-subject"),
        AuthOutcome::CandidateRejected => panic!("nonempty subject must authenticate"),
    }

    assert!(matches!(
        transport::decode_auth_body(br#"{}"#).expect("missing sub is a candidate rejection"),
        AuthOutcome::CandidateRejected
    ));
    assert!(matches!(
        transport::decode_auth_body(br#"{"sub":"  "}"#).expect("blank sub is a rejection"),
        AuthOutcome::CandidateRejected
    ));
    assert!(matches!(
        transport::decode_auth_body(br#"{"sub":17}"#),
        Err(TransportError::InvalidResponse)
    ));
}

#[test]
fn page_request_uses_cursor_string_dates_and_fixed_page_size() {
    let body = transport::encode_page_body(&PageRequest {
        page: 9,
        page_size: 1_000,
        start_date_ms: "1700000000000".to_string(),
        end_date_ms: "1700086400000".to_string(),
    })
    .expect("page request should encode");
    let body: serde_json::Value = serde_json::from_slice(&body).expect("valid JSON body");

    assert_eq!(
        body,
        serde_json::json!({
            "page": 9,
            "pageSize": 1000,
            "startDate": "1700000000000",
            "endDate": "1700086400000"
        })
    );
}

#[test]
fn actual_cursor_page_schema_maps_numeric_strings_and_four_token_classes() {
    let page = transport::decode_page_body(
        4,
        br#"{
          "usageEventsDisplay": [{
            "timestamp": "1700000000000",
            "model": "raw-model-name",
            "tokenUsage": {
              "inputTokens": "11",
              "outputTokens": 12,
              "cacheWriteTokens": "13",
              "cacheReadTokens": 14,
              "totalCents": "1.25"
            },
            "chargedCents": 2.5,
            "owningUser": "must-not-escape",
            "owningTeam": "must-not-escape"
          }],
          "totalUsageEventsCount": "41"
        }"#,
    )
    .expect("valid Cursor JSON should decode");

    assert_eq!(page.page, 4);
    assert_eq!(page.total_usage_events_count, Some(41));
    assert_eq!(page.events.len(), 1);
    let event = &page.events[0];
    assert!(matches!(
        event.timestamp_ms,
        RawNumber::Integer(1_700_000_000_000)
    ));
    assert_eq!(event.model_name, "raw-model-name");
    let usage = event.token_usage.as_ref().expect("token usage");
    assert!(matches!(usage.input_tokens, RawNumber::Integer(11)));
    assert!(matches!(usage.output_tokens, RawNumber::Integer(12)));
    assert!(matches!(usage.cache_write_tokens, RawNumber::Integer(13)));
    assert!(matches!(usage.cache_read_tokens, RawNumber::Integer(14)));
    assert!(matches!(usage.total_cents, RawNumber::Decimal(value) if value == 1.25));
    assert!(matches!(event.charged_cents, RawNumber::Decimal(value) if value == 2.5));
}

#[test]
fn blank_optional_token_fields_decode_as_missing_zero_values() {
    let page = transport::decode_page_body(
        1,
        br#"{
          "usageEventsDisplay": [{
            "timestamp": "1700000000000",
            "model": "model",
            "tokenUsage": {
              "inputTokens": "",
              "outputTokens": 2.0,
              "cacheReadTokens": 3
            },
            "chargedCents": 0
          }],
          "totalUsageEventsCount": 1
        }"#,
    )
    .expect("blank optional token counters should decode");

    let usage = page.events[0].token_usage.as_ref().expect("token usage");
    assert!(matches!(usage.input_tokens, RawNumber::Missing));
    assert!(matches!(usage.output_tokens, RawNumber::Decimal(value) if value == 2.0));
    assert!(matches!(usage.cache_write_tokens, RawNumber::Missing));
    assert!(matches!(usage.cache_read_tokens, RawNumber::Integer(3)));
}

#[test]
fn ownership_field_shape_does_not_control_whether_a_page_decodes() {
    let page = transport::decode_page_body(
        1,
        br#"{
          "usageEventsDisplay": [{
            "timestamp": "1700000000000",
            "model": "model",
            "chargedCents": 0,
            "owningUser": 17,
            "owningTeam": {"id":"team"}
          }],
          "totalUsageEventsCount": 1
        }"#,
    )
    .expect("ownership metadata must not reject an otherwise valid page");

    assert_eq!(page.events.len(), 1);
}

#[test]
fn fixed_transport_rejects_a_body_before_it_can_grow_past_the_limit() {
    let oversized = vec![b'x'; 33];
    assert!(matches!(
        transport::read_bounded(std::io::Cursor::new(oversized), 32),
        Err(TransportError::InvalidResponse)
    ));
    assert_eq!(
        transport::read_bounded(std::io::Cursor::new(vec![b'x'; 32]), 32)
            .expect("body at the limit"),
        vec![b'x'; 32]
    );
}
