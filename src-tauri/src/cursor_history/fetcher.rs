#[cfg(test)]
use super::CredentialRequest;
use super::{
    AuthOutcome, CompleteHistory, CredentialLease, CredentialLeasePort, HistoryError,
    HistoryTransport, PageRequest, ScriptedHistory, aggregate_scripted_history,
};

const PAGE_SIZE: usize = 1_000;
const MAX_PAGES: u16 = 200;

#[derive(Clone)]
pub(crate) struct FetchRequest {
    pub provider_id: String,
    pub account_id: String,
    pub from_ms: i64,
    pub to_ms: i64,
    pub fetched_at_ms: i64,
    pub time_zone: String,
}

#[cfg(test)]
pub(crate) fn fetch_complete_history(
    credentials: &dyn CredentialLeasePort,
    transport: &dyn HistoryTransport,
    request: FetchRequest,
) -> Result<CompleteHistory, HistoryError> {
    let lease = credentials.acquire(CredentialRequest {
        provider_id: &request.provider_id,
        account_id: &request.account_id,
    })?;
    fetch_complete_history_with_lease(credentials, transport, &lease, request, &|| false)
}

pub(crate) fn fetch_complete_history_with_lease(
    credentials: &dyn CredentialLeasePort,
    transport: &dyn HistoryTransport,
    lease: &CredentialLease,
    request: FetchRequest,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<CompleteHistory, HistoryError> {
    if lease.provider_id() != request.provider_id || lease.account_id() != request.account_id {
        return Err(HistoryError::CredentialLeaseMismatch);
    }
    check_current(credentials, lease, is_cancelled)?;

    let correlation_id = uuid::Uuid::new_v4().to_string();
    let mut accepted = None;
    for candidate in lease.candidates() {
        check_current(credentials, lease, is_cancelled)?;
        match transport
            .authenticate(candidate, &correlation_id)
            .map_err(HistoryError::Transport)?
        {
            AuthOutcome::CandidateRejected => continue,
            AuthOutcome::Authenticated(identity) => {
                check_current(credentials, lease, is_cancelled)?;
                if !credentials.identity_matches(&lease, identity.subject())? {
                    return Err(HistoryError::IdentityChanged);
                }
                accepted = Some(candidate);
                break;
            }
        }
    }
    let candidate = accepted.ok_or(HistoryError::AuthenticationUnavailable)?;

    let mut pages = Vec::new();
    for page in 1..=MAX_PAGES {
        check_current(credentials, lease, is_cancelled)?;
        let response = transport
            .fetch_page(
                candidate,
                &PageRequest {
                    page,
                    page_size: PAGE_SIZE,
                    start_date_ms: request.from_ms.to_string(),
                    end_date_ms: request.to_ms.to_string(),
                },
                &correlation_id,
            )
            .map_err(HistoryError::Transport)?;
        check_current(credentials, lease, is_cancelled)?;
        let is_final = response.events.len() < PAGE_SIZE;
        pages.push(response);
        if is_final {
            break;
        }
    }

    check_current(credentials, lease, is_cancelled)?;
    let history = aggregate_scripted_history(ScriptedHistory {
        account_id: request.account_id,
        from_ms: request.from_ms,
        to_ms: request.to_ms,
        fetched_at_ms: request.fetched_at_ms,
        time_zone: request.time_zone,
        requested_page_size: PAGE_SIZE,
        pages,
    })?;
    check_current(credentials, lease, is_cancelled)?;
    Ok(history)
}

fn check_current(
    credentials: &dyn CredentialLeasePort,
    lease: &CredentialLease,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(), HistoryError> {
    if is_cancelled() {
        return Err(HistoryError::Cancelled);
    }
    if !credentials.is_current(lease) {
        return Err(HistoryError::CredentialLeaseChanged);
    }
    Ok(())
}
