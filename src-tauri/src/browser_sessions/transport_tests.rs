use super::transport::{
    CURSOR_AUTH_URL, CURSOR_ORIGIN, CursorStatusAction, FixedProviderIdentityTransport,
    classify_cursor_status, decode_cursor_identity_bytes,
};
use super::*;
use std::time::Duration;

#[test]
fn cursor_validation_policy_has_one_fixed_https_endpoint_and_origin() {
    assert_eq!(CURSOR_AUTH_URL, "https://cursor.com/api/auth/me");
    assert_eq!(CURSOR_ORIGIN, "https://cursor.com");
    assert_eq!(
        classify_cursor_status(200),
        Ok(CursorStatusAction::ReadIdentity)
    );
    assert_eq!(
        classify_cursor_status(401),
        Ok(CursorStatusAction::RejectedAuthentication)
    );
    assert_eq!(
        classify_cursor_status(403),
        Ok(CursorStatusAction::RejectedAuthentication)
    );
    assert_eq!(
        classify_cursor_status(302),
        Err(ProviderTransportError::Redirect)
    );
    assert_eq!(
        classify_cursor_status(503),
        Err(ProviderTransportError::HttpStatus(503))
    );
}

#[test]
fn cursor_200_requires_valid_json_with_a_stable_subject() {
    for body in [br#"{}"#.as_slice(), br#"{"sub":null}"#, br#"{"sub":"  "}"#] {
        assert!(matches!(
            decode_cursor_identity_bytes(body),
            Ok(ValidationOutcome::MissingIdentity)
        ));
    }
    for body in [br#"not-json"#.as_slice(), br#"{"sub":7}"#] {
        assert!(matches!(
            decode_cursor_identity_bytes(body),
            Err(ProviderTransportError::InvalidResponse)
        ));
    }
    let identity = match decode_cursor_identity_bytes(
        br#"{"sub":" auth0|stable ","email":" work@example.com ","name":" Work User "}"#,
    )
    .expect("valid identity response")
    {
        ValidationOutcome::Verified(identity) => identity,
        _ => panic!("stable subject must verify"),
    };
    assert_eq!(identity.expose(), "auth0|stable");
    let display = identity
        .display()
        .expect("provider supplied display identity");
    assert_eq!(display.email.as_deref(), Some("work@example.com"));
    assert_eq!(display.name.as_deref(), Some("Work User"));
}

#[test]
fn cursor_identity_without_a_visible_account_name_is_not_presented_as_verified() {
    for body in [
        br#"{"sub":"auth0|stable"}"#.as_slice(),
        br#"{"sub":"auth0|stable","email":"  ","name":""}"#,
        br#"{"sub":"auth0|stable","email":"hidden\nname"}"#,
        br#"{"sub":"auth0|stable","email":"person@example.com","name":"hidden\nname"}"#,
    ] {
        assert!(matches!(
            decode_cursor_identity_bytes(body),
            Ok(ValidationOutcome::MissingIdentity)
        ));
    }
    assert!(matches!(
        decode_cursor_identity_bytes(br#"{"sub":"auth0|stable","name":"Verified User"}"#),
        Ok(ValidationOutcome::Verified(_))
    ));
    assert!(matches!(
        decode_cursor_identity_bytes(br#"{"sub":"auth0|stable","email":9}"#),
        Err(ProviderTransportError::InvalidResponse)
    ));
}

#[test]
fn display_identity_is_redacted_from_json_and_literal_logs() {
    let identity = VerifiedIdentity::new("auth0|display-test".to_string())
        .unwrap()
        .with_display(
            Some("redaction@example.com".to_string()),
            Some("Redaction Display Name".to_string()),
        )
        .unwrap();
    let json = serde_json::to_string(&identity.display()).unwrap();
    let redacted = crate::plugin_engine::host_api::redact_log_message(&json);
    assert!(!redacted.contains("redaction@example.com"));
    assert!(!redacted.contains("Redaction Display Name"));
    let literal = crate::plugin_engine::host_api::redact_log_message(
        "User redaction@example.com Redaction Display Name",
    );
    assert!(!literal.contains("redaction@example.com"));
    assert!(!literal.contains("Redaction Display Name"));
}

#[test]
fn production_transport_does_not_guess_a_claude_identity_contract() {
    let result = FixedProviderIdentityTransport.validate(
        CookieProvider::Claude,
        "sessionKey=must-not-be-used",
        Duration::from_secs(30),
        &CancellationToken::new(),
    );
    assert!(matches!(
        result,
        Err(ProviderTransportError::UnsupportedProvider)
    ));
}
