use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub(super) fn fingerprint(
    installation_key: &[u8; 32],
    provider_id: &str,
    identity_namespace: &str,
    normalized_identity: &str,
) -> String {
    let mut mac = HmacSha256::new_from_slice(installation_key)
        .expect("HMAC-SHA256 accepts a 256-bit installation key");
    for field in [
        "identity-fingerprint-v1",
        provider_id,
        identity_namespace,
        normalized_identity,
    ] {
        mac.update(&(field.len() as u64).to_be_bytes());
        mac.update(field.as_bytes());
    }
    let bytes = mac.finalize().into_bytes();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_frames_provider_namespace_and_full_identity() {
        let key = [41_u8; 32];
        let cursor = fingerprint(&key, "cursor", "cursor-sub-v1", "auth0|User");

        assert_ne!(
            cursor,
            fingerprint(&key, "claude", "cursor-sub-v1", "auth0|User")
        );
        assert_ne!(
            cursor,
            fingerprint(&key, "cursor", "cursor-sub-v2", "auth0|User")
        );
        assert_ne!(
            cursor,
            fingerprint(&key, "cursor", "cursor-sub-v1", "auth0|user")
        );
        assert_eq!(cursor.len(), 64);
    }
}
