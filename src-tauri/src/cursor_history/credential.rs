use super::HistoryError;

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SecretCookie(String);

impl SecretCookie {
    pub(crate) fn new(value: String) -> Self {
        Self(value)
    }

    pub(super) fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for SecretCookie {
    fn drop(&mut self) {
        unsafe { self.0.as_bytes_mut().fill(0) };
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct CredentialCandidate {
    candidate_id: String,
    cookie: SecretCookie,
}

impl CredentialCandidate {
    pub(crate) fn new(candidate_id: String, cookie: SecretCookie) -> Self {
        Self {
            candidate_id,
            cookie,
        }
    }

    pub(crate) fn candidate_id(&self) -> &str {
        &self.candidate_id
    }

    pub(super) fn cookie(&self) -> &str {
        self.cookie.expose()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct CredentialLease {
    provider_id: String,
    account_id: String,
    generation: String,
    candidates: Vec<CredentialCandidate>,
}

impl CredentialLease {
    pub(crate) fn new(
        provider_id: String,
        account_id: String,
        generation: String,
        candidates: Vec<CredentialCandidate>,
    ) -> Self {
        Self {
            provider_id,
            account_id,
            generation,
            candidates,
        }
    }

    pub(crate) fn provider_id(&self) -> &str {
        &self.provider_id
    }

    pub(crate) fn account_id(&self) -> &str {
        &self.account_id
    }

    pub(crate) fn generation(&self) -> &str {
        &self.generation
    }

    pub(crate) fn candidates(&self) -> &[CredentialCandidate] {
        &self.candidates
    }
}

pub(crate) struct CredentialRequest<'a> {
    pub provider_id: &'a str,
    pub account_id: &'a str,
}

pub(crate) trait CredentialLeasePort: Send + Sync {
    fn acquire(&self, request: CredentialRequest<'_>) -> Result<CredentialLease, HistoryError>;

    fn identity_matches(
        &self,
        lease: &CredentialLease,
        subject: &str,
    ) -> Result<bool, HistoryError>;

    fn is_current(&self, lease: &CredentialLease) -> bool;

    /// Runs the commit while the ProviderAccounts generation/account binding is held stable.
    /// The eventual ProviderAccounts adapter must implement this atomically with selection and
    /// credential-generation changes; a check followed by an unlocked write is not sufficient.
    fn with_current_lease(
        &self,
        lease: &CredentialLease,
        operation: &mut dyn FnMut() -> Result<(), HistoryError>,
    ) -> Result<(), HistoryError>;
}
