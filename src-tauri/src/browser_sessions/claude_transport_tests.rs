use super::ClaudeAccountTransportError;
use super::claude_transport::{
    CLAUDE_ACCOUNT_URL, CLAUDE_ORIGIN, MAX_CLAUDE_ACCOUNT_BODY, classify_claude_status,
    decode_claude_account_bytes,
};

#[test]
fn claude_account_endpoint_is_fixed_and_redirects_are_rejected() {
    assert_eq!(CLAUDE_ACCOUNT_URL, "https://claude.ai/api/account");
    assert_eq!(CLAUDE_ORIGIN, "https://claude.ai");
    assert_eq!(classify_claude_status(200), Ok(()));
    assert_eq!(
        classify_claude_status(302),
        Err(ClaudeAccountTransportError::Redirect)
    );
    assert_eq!(
        classify_claude_status(401),
        Err(ClaudeAccountTransportError::Authentication)
    );
    assert_eq!(
        classify_claude_status(503),
        Err(ClaudeAccountTransportError::HttpStatus(503))
    );
}

#[test]
fn account_decoder_reads_only_email_membership_org_and_seat() {
    let evidence = decode_claude_account_bytes(
        br#"{
          "email_address":"Person@Example.COM",
          "id":"membership-secret-id",
          "memberships":[
            {
              "id":"first-secret-id",
              "seat_tier":"team_standard",
              "organization":{"uuid":"11111111-1111-1111-1111-111111111111","name":"Private Org"}
            },
            {
              "seat_tier":"team_tier_1",
              "organization":{"uuid":"22222222-2222-2222-2222-222222222222"}
            }
          ]
        }"#,
        &[],
    )
    .expect("valid account body");

    assert_eq!(
        evidence.email.as_ref().map(|value| value.expose()),
        Some("Person@Example.COM")
    );
    assert_eq!(evidence.memberships.len(), 2);
    assert_eq!(
        evidence.memberships[0]
            .organization_uuid
            .as_ref()
            .map(|value| value.expose()),
        Some("11111111-1111-1111-1111-111111111111")
    );
    assert_eq!(
        evidence.memberships[1]
            .seat_tier
            .as_ref()
            .map(|value| value.expose()),
        Some("team_tier_1")
    );
}

#[test]
fn account_decoder_keeps_only_the_last_valid_session_key_rotation() {
    let evidence = decode_claude_account_bytes(
        br#"{"email_address":"person@example.com","memberships":[]}"#,
        &[
            "sessionKey=not-a-claude-key; Path=/; HttpOnly",
            "other=value; Expires=Wed, 09 Jun 2027 10:18:14 GMT, sessionKey=sk-ant-rotated-one; Path=/",
            "sessionKey=sk-ant-rotated-two; Path=/; Secure",
        ],
    )
    .expect("valid account body");

    assert_eq!(
        evidence
            .rotated_cookie_header
            .as_ref()
            .map(|value| value.expose()),
        Some("sessionKey=sk-ant-rotated-two")
    );
}

#[test]
fn account_decoder_ignores_invalid_or_attribute_like_session_keys() {
    let evidence = decode_claude_account_bytes(
        br#"{"email_address":"person@example.com","memberships":[]}"#,
        &[
            "sessionKey=ordinary-value; Path=/",
            "other=value; sessionKey=sk-ant-not-a-separate-cookie; Path=/",
        ],
    )
    .expect("valid account body");

    assert!(evidence.rotated_cookie_header.is_none());
}

#[test]
fn account_decoder_rejects_malformed_and_oversized_bodies() {
    assert!(matches!(
        decode_claude_account_bytes(br#"{"email_address":}"#, &[]),
        Err(ClaudeAccountTransportError::InvalidResponse)
    ));
    assert!(matches!(
        decode_claude_account_bytes(&vec![b'x'; MAX_CLAUDE_ACCOUNT_BODY + 1], &[]),
        Err(ClaudeAccountTransportError::InvalidResponse)
    ));
}

#[test]
fn account_decoder_treats_missing_identity_fields_as_absent_evidence() {
    let evidence = decode_claude_account_bytes(
        br#"{"memberships":[{"seat_tier":"team_standard","organization":{}}]}"#,
        &[],
    )
    .expect("well-formed partial response");

    assert!(evidence.email.is_none());
    assert!(evidence.memberships[0].organization_uuid.is_none());
}
