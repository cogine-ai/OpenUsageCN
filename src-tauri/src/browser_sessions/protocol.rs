use serde::{Deserialize, Serialize};

pub(crate) const PROTOCOL_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) enum Browser {
    Chrome,
    Arc,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) enum CookieProvider {
    Cursor,
    Claude,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReadCookiesRequest<'a> {
    pub version: u8,
    pub operation: &'static str,
    pub browser: Browser,
    pub profile_key: &'a str,
    pub provider: CookieProvider,
}

#[derive(Serialize)]
pub(super) struct ListProfilesRequest {
    pub version: u8,
    pub operation: &'static str,
    pub browser: Browser,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListProfilesWireResponse {
    pub version: u8,
    pub operation: String,
    pub ok: bool,
    pub browser: Browser,
    pub profiles: Vec<BrowserProfile>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum ListProfilesWireResult {
    Success(ListProfilesWireResponse),
    Error(HelperErrorWireResponse),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserProfile {
    pub profile_key: String,
    pub display_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListProfilesResponse {
    pub profiles: Vec<BrowserProfile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReadCookiesWireResponse {
    pub version: u8,
    pub operation: String,
    pub ok: bool,
    pub browser: Browser,
    pub profile_key: String,
    pub provider: CookieProvider,
    pub candidates: Vec<CookieCandidate>,
    pub warnings: Vec<HelperWarning>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HelperWarning {
    pub code: HelperWarningCode,
    #[serde(rename = "message")]
    pub _message: String,
}

impl Drop for HelperWarning {
    fn drop(&mut self) {
        zero_string(&mut self._message);
    }
}

#[derive(Deserialize)]
pub(super) enum HelperWarningCode {
    CookieReadWarning,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum ReadCookiesWireResult {
    Success(ReadCookiesWireResponse),
    Error(HelperErrorWireResponse),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HelperErrorWireResponse {
    pub version: u8,
    pub operation: String,
    pub ok: bool,
    pub error: HelperErrorWire,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HelperErrorWire {
    pub code: HelperErrorCode,
    #[serde(rename = "message")]
    pub _message: String,
}

impl Drop for HelperErrorWire {
    fn drop(&mut self) {
        zero_string(&mut self._message);
    }
}

#[derive(Clone, Copy, Deserialize)]
pub(super) enum HelperErrorCode {
    UnsupportedVersion,
    InvalidRequest,
    UnsupportedBrowser,
    UnsupportedProvider,
    InvalidProfileKey,
    UnsupportedOperation,
    ProfileDiscoveryFailed,
    CookieReadFailed,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub(super) struct CookieCandidate {
    pub store_id: String,
    pub host: String,
    pub cookie_header: String,
}

impl CookieCandidate {
    pub(super) fn into_parts(mut self) -> (String, String, String) {
        (
            std::mem::take(&mut self.store_id),
            std::mem::take(&mut self.host),
            std::mem::take(&mut self.cookie_header),
        )
    }

    fn clear_secrets(&mut self) {
        zero_string(&mut self.store_id);
        zero_string(&mut self.cookie_header);
    }

    #[cfg(test)]
    fn clear_secrets_for_test(&mut self) {
        self.clear_secrets();
    }
}

impl Drop for CookieCandidate {
    fn drop(&mut self) {
        self.clear_secrets();
    }
}

fn zero_string(value: &mut String) {
    unsafe { value.as_bytes_mut().fill(0) };
    value.clear();
}

pub(super) struct ReadCookiesResponse {
    pub candidates: Vec<CookieCandidate>,
    pub warnings: Vec<BrowserSessionWarning>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BrowserSessionWarningCode {
    CookieReadWarning,
}

pub(super) struct BrowserSessionWarning {
    pub code: BrowserSessionWarningCode,
    pub message: &'static str,
}

#[cfg(test)]
mod tests {
    use super::CookieCandidate;

    #[test]
    fn cookie_candidate_secret_fields_can_be_zeroized_before_discard() {
        let mut candidate = CookieCandidate {
            store_id: "/Users/alice/Private/Profile 2".to_string(),
            host: "cursor.com".to_string(),
            cookie_header: "WorkosCursorSessionToken=secret".to_string(),
        };

        candidate.clear_secrets_for_test();

        assert!(candidate.store_id.is_empty());
        assert!(candidate.cookie_header.is_empty());
        assert_eq!(candidate.host, "cursor.com");
    }
}
