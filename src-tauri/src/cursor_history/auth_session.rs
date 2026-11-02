use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;

use super::{AuthOutcome, CredentialCandidate, TransportError};

// Called only after auth/me accepted this exact candidate. JWT decoding here binds the
// server's abbreviated subject to the local session; it does not verify a token itself.
pub(super) fn decode_accepted_auth(
    body: &[u8],
    candidate: &CredentialCandidate,
) -> Result<AuthOutcome, TransportError> {
    let raw: Value = serde_json::from_slice(body).map_err(|_| TransportError::InvalidResponse)?;
    if raw
        .get("sub")
        .and_then(Value::as_str)
        .is_some_and(|subject| subject != subject.trim())
    {
        return Ok(AuthOutcome::CandidateRejected);
    }
    let outcome = super::transport::decode_auth_body(body)?;
    let AuthOutcome::Authenticated(identity) = &outcome else {
        return Ok(outcome);
    };
    if candidate.is_local_session() && !identity.subject().contains('|') {
        if let Some(subject) = full_local_subject(candidate.cookie(), identity.subject()) {
            return Ok(AuthOutcome::Authenticated(
                super::transport::AuthIdentity::new(subject),
            ));
        }
    }
    Ok(outcome)
}

fn full_local_subject(cookie: &str, server_subject: &str) -> Option<String> {
    let mut session = None;
    for part in cookie.split(';') {
        let (name, value) = part.trim().split_once('=')?;
        if name == "WorkosCursorSessionToken" {
            if session.replace(value).is_some() {
                return None;
            }
        }
    }
    let value = session?;
    let (user, token) = value.split_once("%3A%3A")?;
    if user != server_subject || token.contains('%') || user.is_empty() || user.contains(':') {
        return None;
    }
    let mut parts = token.split('.');
    let header = URL_SAFE_NO_PAD.decode(parts.next()?).ok()?;
    let payload = URL_SAFE_NO_PAD.decode(parts.next()?).ok()?;
    let signature = URL_SAFE_NO_PAD.decode(parts.next()?).ok()?;
    if parts.next().is_some() || signature.is_empty() {
        return None;
    }
    if !serde_json::from_slice::<Value>(&header).ok()?.is_object() {
        return None;
    }
    #[derive(serde::Deserialize)]
    struct Claims {
        sub: String,
    }
    let claims: Claims = serde_json::from_slice(&payload).ok()?;
    let subject = claims.sub.as_str();
    let (provider, component) = subject.split_once('|')?;
    if provider.is_empty()
        || subject.chars().any(char::is_whitespace)
        || component.contains('|')
        || component != user
    {
        return None;
    }
    Some(subject.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor_history::SecretCookie;

    fn cookie(subject: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#);
        let payload = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&serde_json::json!({"sub":subject})).unwrap());
        format!("WorkosCursorSessionToken=user%3A%3A{header}.{payload}.c2ln")
    }

    fn subject(cookie: String, local: bool, server: &str) -> String {
        let candidate = if local {
            CredentialCandidate::new_local("local".into(), SecretCookie::new(cookie))
        } else {
            CredentialCandidate::new("browser".into(), SecretCookie::new(cookie))
        };
        let body = serde_json::to_vec(&serde_json::json!({"sub":server})).unwrap();
        match decode_accepted_auth(&body, &candidate).unwrap() {
            AuthOutcome::Authenticated(identity) => identity.subject().to_string(),
            _ => panic!("expected identity"),
        }
    }

    #[test]
    fn accepted_local_bare_subject_is_bound_to_its_exact_jwt() {
        assert_eq!(subject(cookie("auth0|user"), true, "user"), "auth0|user");
        assert_eq!(subject(cookie("google|user"), true, "user"), "google|user");
        assert_eq!(
            subject(cookie("auth0|user"), true, "other|user"),
            "other|user"
        );
        assert_eq!(subject(cookie("auth0|user"), false, "user"), "user");
    }

    #[test]
    fn whitespace_padded_server_subjects_are_rejected_before_expansion() {
        let candidate =
            CredentialCandidate::new_local("local".into(), SecretCookie::new(cookie("auth0|user")));
        for server in [" user", "user ", "\tuser\n", " auth0|user", "auth0|user "] {
            let body = serde_json::to_vec(&serde_json::json!({"sub":server})).unwrap();
            assert!(matches!(
                decode_accepted_auth(&body, &candidate),
                Ok(AuthOutcome::CandidateRejected)
            ));
        }
    }

    #[test]
    fn ambiguous_opaque_or_mismatched_local_sessions_do_not_expand_subjects() {
        let valid = cookie("auth0|user");
        for invalid in [
            format!("{valid}; {valid}"),
            format!("WorkosCursorSessionToken; {valid}"),
            format!("{valid}%3A%3Aextra"),
            valid.replace("user%3A", "other%3A"),
            cookie("auth0|other"),
            cookie("auth0|nested|user"),
            cookie("user"),
            cookie("|user"),
            cookie(" auth0|user"),
            cookie("auth0|user "),
            cookie("auth0|us er"),
            "WorkosCursorSessionToken=user%3A%3Aopaque".into(),
            "WorkosCursorSessionToken=opaque".into(),
        ] {
            assert_eq!(subject(invalid, true, "user"), "user");
        }
    }
}
