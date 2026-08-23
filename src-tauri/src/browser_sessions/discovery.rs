use super::model::{AllProfilesDiscovery, ProfileDiscoveryResult, ProfileDiscoveryStatus};
use super::roster::CandidateInput;
use super::{Browser, BrowserSessionBroker, CancellationToken, CookieProvider, ValidationOutcome};
use std::time::Duration;
use std::{collections::VecDeque, sync::Arc, thread};

const PROVIDER_VALIDATION_TIMEOUT: Duration = Duration::from_secs(30);
const READ_COOKIES_TIMEOUT: Duration = Duration::from_secs(15);
const ALL_PROFILES_TIMEOUT: Duration = Duration::from_secs(60);
const ALL_PROFILES_CONCURRENCY: usize = 6;

impl BrowserSessionBroker {
    pub(crate) fn discover_specific(
        &self,
        browser: Browser,
        profile_key: &str,
        provider: CookieProvider,
        cancellation: &CancellationToken,
    ) -> ProfileDiscoveryResult {
        self.discover_specific_until(browser, profile_key, provider, cancellation, None)
    }

    #[cfg(test)]
    pub(crate) fn attach_candidate(
        &self,
        candidate_id: &str,
    ) -> Result<super::SessionRefHandle, super::BrowserSessionError> {
        self.claim_candidate(candidate_id)
            .map(super::AttachedSessionClaim::into_handle)
    }

    pub(crate) fn claim_candidate(
        &self,
        candidate_id: &str,
    ) -> Result<super::AttachedSessionClaim, super::BrowserSessionError> {
        self.roster
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .attach(self.clock.now(), candidate_id)
    }

    pub(crate) fn session_credential(
        &self,
        session_ref: &str,
    ) -> Result<super::BrokerSessionCredential, super::BrowserSessionError> {
        self.roster
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .credential(self.clock.now(), session_ref)
    }

    pub(crate) fn session_binding(
        &self,
        session_ref: &str,
    ) -> Result<super::SessionBindingSummary, super::BrowserSessionError> {
        self.roster
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .binding(self.clock.now(), session_ref)
    }

    pub(crate) fn release_session(&self, session_ref: &str) -> bool {
        self.roster
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .release(session_ref)
    }

    #[cfg(test)]
    pub(crate) fn retained_session_count(&self) -> usize {
        self.roster
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retained_session_count()
    }

    pub(crate) fn discover_all(
        &self,
        browser: Browser,
        provider: CookieProvider,
        cancellation: &CancellationToken,
    ) -> Result<AllProfilesDiscovery, super::BrowserSessionError> {
        if cancellation.is_cancelled() {
            return Err(super::BrowserSessionError::cancelled());
        }
        let started = self.clock.now().monotonic;
        let deadline = started.saturating_add(ALL_PROFILES_TIMEOUT);
        let profiles = self.list_profiles(browser)?.profiles;
        if cancellation.is_cancelled() {
            return Err(super::BrowserSessionError::cancelled());
        }
        if self.clock.now().monotonic >= deadline {
            return Err(super::BrowserSessionError::overall_timed_out());
        }

        let profile_count = profiles.len();
        let queue = Arc::new(std::sync::Mutex::new(
            profiles
                .into_iter()
                .enumerate()
                .map(|(index, profile)| (index, profile.profile_key))
                .collect::<VecDeque<_>>(),
        ));
        let results = Arc::new(std::sync::Mutex::new(
            (0..profile_count)
                .map(|_| None)
                .collect::<Vec<Option<ProfileDiscoveryResult>>>(),
        ));

        thread::scope(|scope| {
            for _ in 0..profile_count.min(ALL_PROFILES_CONCURRENCY) {
                let queue = Arc::clone(&queue);
                let results = Arc::clone(&results);
                let cancellation = cancellation.clone();
                scope.spawn(move || {
                    loop {
                        let Some((index, profile_key)) = queue
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .pop_front()
                        else {
                            break;
                        };
                        let result = if cancellation.is_cancelled() {
                            ProfileDiscoveryResult::failed(
                                &profile_key,
                                super::BrowserSessionError::cancelled(),
                            )
                        } else if self.clock.now().monotonic >= deadline {
                            ProfileDiscoveryResult::failed(
                                &profile_key,
                                super::BrowserSessionError::overall_timed_out(),
                            )
                        } else {
                            self.discover_specific_until(
                                browser,
                                &profile_key,
                                provider,
                                &cancellation,
                                Some(deadline),
                            )
                        };
                        results
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())[index] = Some(result);
                    }
                });
            }
        });

        let profiles = Arc::try_unwrap(results)
            .ok()
            .expect("all discovery workers released their result references")
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let verified = profiles
            .iter()
            .filter(|result| result.status == ProfileDiscoveryStatus::Verified)
            .count();
        let partial = verified > 0
            && profiles
                .iter()
                .any(|result| result.status == ProfileDiscoveryStatus::Failed);
        Ok(AllProfilesDiscovery {
            browser,
            provider,
            profiles,
            partial,
        })
    }

    pub(super) fn discover_specific_until(
        &self,
        browser: Browser,
        profile_key: &str,
        provider: CookieProvider,
        cancellation: &CancellationToken,
        deadline: Option<Duration>,
    ) -> ProfileDiscoveryResult {
        if cancellation.is_cancelled() {
            return ProfileDiscoveryResult::failed(
                profile_key,
                super::BrowserSessionError::cancelled(),
            );
        }
        let sidecar_timeout = match remaining(self.clock.now().monotonic, deadline) {
            Some(remaining) if remaining.is_zero() => {
                return ProfileDiscoveryResult::failed(
                    profile_key,
                    super::BrowserSessionError::overall_timed_out(),
                );
            }
            Some(remaining) => remaining.min(READ_COOKIES_TIMEOUT),
            None => READ_COOKIES_TIMEOUT,
        };
        let mut response =
            match self.read_cookies_with_timeout(browser, profile_key, provider, sidecar_timeout) {
                Ok(response) => response,
                Err(error) => {
                    let error = if cancellation.is_cancelled() {
                        super::BrowserSessionError::cancelled()
                    } else {
                        error
                    };
                    return ProfileDiscoveryResult::failed(profile_key, error);
                }
            };
        if cancellation.is_cancelled() {
            return ProfileDiscoveryResult::failed(
                profile_key,
                super::BrowserSessionError::cancelled(),
            );
        }
        if response.candidates.is_empty() {
            return ProfileDiscoveryResult::empty(profile_key);
        }
        response
            .candidates
            .sort_by_key(|candidate| host_priority(provider, &candidate.host));

        for candidate in response.candidates {
            if cancellation.is_cancelled() {
                return ProfileDiscoveryResult::failed(
                    profile_key,
                    super::BrowserSessionError::cancelled(),
                );
            }
            let provider_timeout = match remaining(self.clock.now().monotonic, deadline) {
                Some(remaining) if remaining.is_zero() => {
                    return ProfileDiscoveryResult::failed(
                        profile_key,
                        super::BrowserSessionError::overall_timed_out(),
                    );
                }
                Some(remaining) => remaining.min(PROVIDER_VALIDATION_TIMEOUT),
                None => PROVIDER_VALIDATION_TIMEOUT,
            };
            let validation = self.transport.validate(
                provider,
                &candidate.cookie_header,
                provider_timeout,
                cancellation,
            );
            if cancellation.is_cancelled() {
                return ProfileDiscoveryResult::failed(
                    profile_key,
                    super::BrowserSessionError::cancelled(),
                );
            }
            match validation {
                Ok(ValidationOutcome::Verified(identity)) => {
                    let now = self.clock.now();
                    if deadline.is_some_and(|deadline| now.monotonic >= deadline) {
                        return ProfileDiscoveryResult::failed(
                            profile_key,
                            super::BrowserSessionError::overall_timed_out(),
                        );
                    }
                    let (store_id, host, cookie_header) = candidate.into_parts();
                    let summary = self
                        .roster
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .insert_candidate(
                            now,
                            CandidateInput {
                                provider,
                                browser,
                                profile_key: profile_key.to_string(),
                                host,
                                store_id,
                                cookie_header,
                                identity,
                            },
                        );
                    return ProfileDiscoveryResult::verified(profile_key, summary);
                }
                Ok(
                    ValidationOutcome::RejectedAuthentication | ValidationOutcome::MissingIdentity,
                ) => {
                    continue;
                }
                Err(error) => {
                    return ProfileDiscoveryResult::failed(
                        profile_key,
                        super::BrowserSessionError::from_transport(error),
                    );
                }
            }
        }
        ProfileDiscoveryResult::failed(
            profile_key,
            super::BrowserSessionError::authentication_rejected(),
        )
    }
}

fn remaining(now: Duration, deadline: Option<Duration>) -> Option<Duration> {
    deadline.map(|deadline| deadline.saturating_sub(now))
}

fn host_priority(provider: CookieProvider, host: &str) -> usize {
    match provider {
        CookieProvider::Cursor => match host {
            "cursor.com" => 0,
            "www.cursor.com" => 1,
            "cursor.sh" => 2,
            "authenticator.cursor.sh" => 3,
            _ => usize::MAX,
        },
        CookieProvider::Claude => 0,
    }
}
