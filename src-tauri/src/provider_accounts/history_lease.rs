use super::ProviderAccounts;
use super::state::{ConnectionRecord, ProviderState};
use crate::browser_sessions::{Browser, CancellationToken, CookieProvider};
use crate::cursor_history::{
    CredentialCandidate, CredentialLease, CredentialLeasePort, CredentialRequest, HistoryError,
    SecretCookie,
};
use sha2::{Digest, Sha256};

impl CredentialLeasePort for ProviderAccounts {
    fn acquire(&self, request: CredentialRequest<'_>) -> Result<CredentialLease, HistoryError> {
        if request.provider_id != "cursor" {
            return Err(HistoryError::UnsupportedProvider);
        }
        let connections = {
            let providers = self
                .providers
                .lock()
                .map_err(|_| HistoryError::CredentialLeaseChanged)?;
            lease_connections(
                &providers,
                request.provider_id,
                request.account_id,
                None,
                LeaseState::Acquire,
            )?
        };
        let mut candidates = Vec::new();
        let mut generations = Vec::new();
        for connection in connections {
            let (generation, cookie) = if matches!(
                connection.kind,
                super::ConnectionKind::Chrome | super::ConnectionKind::Arc
            ) {
                match self.browser_history_credential(
                    request.provider_id,
                    request.account_id,
                    &connection,
                ) {
                    Ok(value) => value,
                    Err(HistoryError::IdentityChanged) => {
                        return Err(HistoryError::IdentityChanged);
                    }
                    Err(_) => continue,
                }
            } else {
                let adapter = match self
                    .adapters
                    .lock()
                    .ok()
                    .and_then(|adapters| adapters.get(request.provider_id).cloned())
                {
                    Some(adapter) => adapter,
                    None => continue,
                };
                let generation = match adapter.credential_generation(&connection.connection_key) {
                    Ok(generation) => generation,
                    Err(_) => continue,
                };
                let credential =
                    match adapter.history_cookie(&connection.connection_key, &generation) {
                        Ok(credential) => credential,
                        Err(_) => continue,
                    };
                if adapter
                    .credential_generation(&connection.connection_key)
                    .ok()
                    .as_deref()
                    != Some(generation.as_str())
                {
                    return Err(HistoryError::CredentialLeaseChanged);
                }
                (
                    generation,
                    SecretCookie::new(credential.expose().to_string()),
                )
            };
            generations.push((connection.connection_id.clone(), generation));
            candidates.push(CredentialCandidate::new(connection.connection_id, cookie));
        }
        if candidates.is_empty() {
            return Err(HistoryError::AuthenticationUnavailable);
        }
        let generation = combined_generation(&generations);
        let lease = CredentialLease::new(
            request.provider_id.to_string(),
            request.account_id.to_string(),
            generation,
            candidates,
        );
        if !self.is_current(&lease) {
            return Err(HistoryError::CredentialLeaseChanged);
        }
        Ok(lease)
    }

    fn identity_matches(
        &self,
        lease: &CredentialLease,
        subject: &str,
    ) -> Result<bool, HistoryError> {
        if lease.provider_id() != "cursor" || subject.trim().is_empty() {
            return Ok(false);
        }
        let installation_key = self
            .resolve_installation_key()
            .map_err(|_| HistoryError::AuthenticationUnavailable)?;
        let providers = self
            .providers
            .lock()
            .map_err(|_| HistoryError::CredentialLeaseChanged)?;
        let account = providers
            .get(lease.provider_id())
            .and_then(|provider| {
                provider
                    .accounts
                    .iter()
                    .find(|account| account.account_id == lease.account_id())
            })
            .ok_or(HistoryError::CredentialLeaseChanged)?;
        if account.identity_namespace != "cursor-sub-v1" {
            return Ok(false);
        }
        Ok(account.identity_fingerprint
            == super::identity::fingerprint(
                &installation_key,
                lease.provider_id(),
                &account.identity_namespace,
                subject,
            ))
    }

    fn is_current(&self, lease: &CredentialLease) -> bool {
        let connections = self.providers.lock().ok().and_then(|providers| {
            lease_connections(
                &providers,
                lease.provider_id(),
                lease.account_id(),
                Some(lease),
                LeaseState::Runtime,
            )
            .ok()
        });
        let Some(connections) = connections else {
            return false;
        };
        self.current_generation(lease.provider_id(), &connections)
            .is_some_and(|generation| generation == lease.generation())
    }

    fn with_current_lease(
        &self,
        lease: &CredentialLease,
        operation: &mut dyn FnMut() -> Result<(), HistoryError>,
    ) -> Result<(), HistoryError> {
        let providers = self
            .providers
            .lock()
            .map_err(|_| HistoryError::CredentialLeaseChanged)?;
        let connections = lease_connections(
            &providers,
            lease.provider_id(),
            lease.account_id(),
            Some(lease),
            LeaseState::Runtime,
        )?;
        let locked_provider = self
            .registry_store
            .as_ref()
            .map(|store| store.lock_provider(lease.provider_id()))
            .transpose()
            .map_err(|_| HistoryError::CredentialLeaseChanged)?;
        if let Some(locked_provider) = &locked_provider {
            let disk_provider = locked_provider
                .provider()
                .ok_or(HistoryError::CredentialLeaseChanged)?;
            let mut disk = std::collections::HashMap::new();
            disk.insert(lease.provider_id().to_string(), disk_provider.clone());
            lease_connections(
                &disk,
                lease.provider_id(),
                lease.account_id(),
                Some(lease),
                LeaseState::Persisted,
            )?;
        }
        if self
            .current_generation(lease.provider_id(), &connections)
            .as_deref()
            != Some(lease.generation())
        {
            return Err(HistoryError::CredentialLeaseChanged);
        }
        operation()
    }
}

impl ProviderAccounts {
    fn current_generation(
        &self,
        provider_id: &str,
        connections: &[ConnectionRecord],
    ) -> Option<String> {
        let generations = connections
            .iter()
            .map(|connection| {
                let generation = if matches!(
                    connection.kind,
                    super::ConnectionKind::Chrome | super::ConnectionKind::Arc
                ) {
                    let broker = self.browser_broker.lock().ok()?.clone()?;
                    let session_ref = connection.session_ref.as_deref()?;
                    let credential = broker.session_credential(session_ref).ok()?;
                    browser_cookie_generation(credential.cookie_header())
                } else {
                    self.adapters
                        .lock()
                        .ok()?
                        .get(provider_id)
                        .cloned()?
                        .credential_generation(&connection.connection_key)
                        .ok()?
                };
                Some((connection.connection_id.clone(), generation))
            })
            .collect::<Option<Vec<_>>>()?;
        Some(combined_generation(&generations))
    }

    pub(super) fn browser_history_credential(
        &self,
        provider_id: &str,
        account_id: &str,
        connection: &ConnectionRecord,
    ) -> Result<(String, SecretCookie), HistoryError> {
        let broker = self
            .browser_broker
            .lock()
            .map_err(|_| HistoryError::AuthenticationUnavailable)?
            .clone()
            .ok_or(HistoryError::AuthenticationUnavailable)?;
        if let Some(session_ref) = connection.session_ref.as_deref() {
            if let Ok(credential) = broker.session_credential(session_ref) {
                if !self.browser_identity_matches(
                    provider_id,
                    account_id,
                    credential.normalized_identity(),
                )? {
                    return Err(HistoryError::IdentityChanged);
                }
                return Ok((
                    browser_cookie_generation(credential.cookie_header()),
                    SecretCookie::new(credential.cookie_header().to_string()),
                ));
            }
        }

        let browser = match connection.kind {
            super::ConnectionKind::Chrome => Browser::Chrome,
            super::ConnectionKind::Arc => Browser::Arc,
            _ => return Err(HistoryError::AuthenticationUnavailable),
        };
        let discovery = broker.discover_specific(
            browser,
            &connection.connection_key,
            CookieProvider::Cursor,
            &CancellationToken::new(),
        );
        let candidate_id = discovery
            .candidate
            .ok_or(HistoryError::AuthenticationUnavailable)?
            .candidate_id;
        let claim = broker
            .claim_candidate(&candidate_id)
            .map_err(|_| HistoryError::AuthenticationUnavailable)?;
        if !self.browser_identity_matches(provider_id, account_id, claim.normalized_identity())? {
            broker.release_session(claim.session_ref());
            return Err(HistoryError::IdentityChanged);
        }
        let session_ref = claim.session_ref().to_string();
        let credential = broker
            .session_credential(&session_ref)
            .map_err(|_| HistoryError::AuthenticationUnavailable)?;
        if let Err(error) = self.bind_browser_runtime_session(
            provider_id,
            account_id,
            &connection.connection_id,
            &session_ref,
        ) {
            broker.release_session(&session_ref);
            return Err(error);
        }
        Ok((
            browser_cookie_generation(credential.cookie_header()),
            SecretCookie::new(credential.cookie_header().to_string()),
        ))
    }

    fn browser_identity_matches(
        &self,
        provider_id: &str,
        account_id: &str,
        identity: &str,
    ) -> Result<bool, HistoryError> {
        let installation_key = self
            .resolve_installation_key()
            .map_err(|_| HistoryError::AuthenticationUnavailable)?;
        let providers = self
            .providers
            .lock()
            .map_err(|_| HistoryError::CredentialLeaseChanged)?;
        let account = providers
            .get(provider_id)
            .and_then(|provider| {
                provider
                    .accounts
                    .iter()
                    .find(|account| account.account_id == account_id)
            })
            .ok_or(HistoryError::CredentialLeaseChanged)?;
        Ok(account.identity_namespace == "cursor-sub-v1"
            && account.identity_fingerprint
                == super::identity::fingerprint(
                    &installation_key,
                    provider_id,
                    &account.identity_namespace,
                    identity,
                ))
    }

    fn bind_browser_runtime_session(
        &self,
        provider_id: &str,
        account_id: &str,
        connection_id: &str,
        session_ref: &str,
    ) -> Result<(), HistoryError> {
        let mut providers = self
            .providers
            .lock()
            .map_err(|_| HistoryError::CredentialLeaseChanged)?;
        let provider = providers
            .get_mut(provider_id)
            .ok_or(HistoryError::CredentialLeaseChanged)?;
        if provider.active_account_id.as_deref() != Some(account_id) {
            return Err(HistoryError::CredentialLeaseChanged);
        }
        let connection = provider
            .accounts
            .iter_mut()
            .find(|account| account.account_id == account_id)
            .and_then(|account| {
                account
                    .connections
                    .iter_mut()
                    .find(|connection| connection.connection_id == connection_id)
            })
            .ok_or(HistoryError::CredentialLeaseChanged)?;
        if !connection.attached {
            return Err(HistoryError::CredentialLeaseChanged);
        }
        connection.available = true;
        connection.session_ref = Some(session_ref.to_string());
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum LeaseState {
    Acquire,
    Runtime,
    Persisted,
}

fn lease_connections(
    providers: &std::collections::HashMap<String, ProviderState>,
    provider_id: &str,
    account_id: &str,
    lease: Option<&CredentialLease>,
    state: LeaseState,
) -> Result<Vec<ConnectionRecord>, HistoryError> {
    let provider = providers
        .get(provider_id)
        .ok_or(HistoryError::CredentialLeaseChanged)?;
    if provider.active_account_id.as_deref() != Some(account_id) {
        return Err(HistoryError::CredentialLeaseChanged);
    }
    let account = provider
        .accounts
        .iter()
        .find(|account| account.account_id == account_id)
        .ok_or(HistoryError::CredentialLeaseChanged)?;
    let mut connections = if let Some(lease) = lease {
        lease
            .candidates()
            .iter()
            .map(|candidate| {
                account
                    .connections
                    .iter()
                    .find(|connection| {
                        connection.connection_id == candidate.candidate_id()
                            && connection.attached
                            && (!matches!(state, LeaseState::Runtime) || connection.available)
                    })
                    .cloned()
                    .ok_or(HistoryError::CredentialLeaseChanged)
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        account
            .connections
            .iter()
            .filter(|connection| connection.attached)
            .filter(|connection| {
                connection.available
                    || matches!(
                        connection.kind,
                        super::ConnectionKind::Chrome | super::ConnectionKind::Arc
                    )
            })
            .cloned()
            .collect()
    };
    connections.sort_by_key(|connection| connection.kind);
    if connections.is_empty() {
        return Err(HistoryError::AuthenticationUnavailable);
    }
    Ok(connections)
}

pub(super) fn browser_cookie_generation(cookie: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"cursor-browser-cookie-generation-v1\0");
    digest.update(cookie.as_bytes());
    hex_digest(digest.finalize())
}

fn combined_generation(generations: &[(String, String)]) -> String {
    if generations.len() == 1 {
        return generations[0].1.clone();
    }
    let mut digest = Sha256::new();
    digest.update(b"cursor-history-generation-v1\0");
    for (connection_id, generation) in generations {
        digest.update((connection_id.len() as u64).to_be_bytes());
        digest.update(connection_id.as_bytes());
        digest.update((generation.len() as u64).to_be_bytes());
        digest.update(generation.as_bytes());
    }
    hex_digest(digest.finalize())
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    let digest = digest.as_ref();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}
