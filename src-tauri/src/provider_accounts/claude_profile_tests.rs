use super::claude_profile::{
    CLAUDE_OAUTH_PROFILE_TIMEOUT, CLAUDE_OAUTH_PROFILE_URL, ClaudeOAuthProfileError,
    MAX_CLAUDE_OAUTH_PROFILE_BODY, classify_claude_oauth_profile_status,
    decode_claude_oauth_profile_bytes,
};
use std::time::Duration;

#[test]
fn oauth_profile_transport_contract_is_fixed_and_bounded() {
    assert_eq!(
        CLAUDE_OAUTH_PROFILE_URL,
        "https://api.anthropic.com/api/oauth/profile"
    );
    assert_eq!(CLAUDE_OAUTH_PROFILE_TIMEOUT, Duration::from_secs(30));
    assert_eq!(MAX_CLAUDE_OAUTH_PROFILE_BODY, 1024 * 1024);
    assert_eq!(classify_claude_oauth_profile_status(200), Ok(()));
    assert_eq!(
        classify_claude_oauth_profile_status(302),
        Err(ClaudeOAuthProfileError::Redirect)
    );
    assert_eq!(
        classify_claude_oauth_profile_status(401),
        Err(ClaudeOAuthProfileError::Authentication)
    );
    assert_eq!(
        classify_claude_oauth_profile_status(403),
        Err(ClaudeOAuthProfileError::Authentication)
    );
    assert_eq!(
        classify_claude_oauth_profile_status(500),
        Err(ClaudeOAuthProfileError::HttpStatus(500))
    );
}

#[test]
fn oauth_profile_accepts_only_complete_verified_identity_shapes() {
    let nested = decode_claude_oauth_profile_bytes(
        br#"{"account":{"emailAddress":" Team.Member@Example.com "},"organization":{"uuid":"org-123"}}"#,
    );
    let aliases = decode_claude_oauth_profile_bytes(
        br#"{"email_address":"team.member@example.com","organization_uuid":"org-123"}"#,
    );
    assert!(nested.is_ok());
    assert!(aliases.is_ok());

    for body in [
        br#"{"account":{"emailAddress":"member@example.com"}}"#.as_slice(),
        br#"{"organization":{"uuid":"org-123"}}"#.as_slice(),
        br#"{"emailAddress":"member@example.com","organizationUuid":" org-123 "}"#.as_slice(),
        br#"{"emailAddress":"","organizationUuid":"org-123"}"#.as_slice(),
        b"not-json".as_slice(),
    ] {
        assert_eq!(
            decode_claude_oauth_profile_bytes(body).err(),
            Some(ClaudeOAuthProfileError::InvalidResponse)
        );
    }
}

#[test]
fn oauth_profile_rejects_oversize_bodies_without_echoing_secrets() {
    let secret = "bearer-secret-canary";
    let body = vec![b'x'; MAX_CLAUDE_OAUTH_PROFILE_BODY + 1];
    let error = match decode_claude_oauth_profile_bytes(&body) {
        Err(error) => error,
        Ok(_) => panic!("oversize profile body must fail"),
    };
    assert_eq!(error, ClaudeOAuthProfileError::InvalidResponse);
    assert!(!format!("{error:?}").contains(secret));
}
