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
    let identity = match decode_cursor_identity_bytes(br#"{"sub":" auth0|stable "}"#)
        .expect("valid identity response")
    {
        ValidationOutcome::Verified(identity) => identity,
        _ => panic!("stable subject must verify"),
    };
    assert_eq!(identity.expose(), "auth0|stable");
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
