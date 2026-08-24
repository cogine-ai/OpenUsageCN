use super::BrowserSessionError;
use super::claude_transport::{ClaudeAccountTransport, FixedClaudeAccountTransport};
use super::clock::{BrokerClock, SystemBrokerClock};
use super::protocol::{
    Browser, BrowserSessionWarning, BrowserSessionWarningCode, CookieProvider,
    HelperErrorWireResponse, HelperWarningCode, ListProfilesRequest, ListProfilesResponse,
    ListProfilesWireResult, PROTOCOL_VERSION, ReadCookiesRequest, ReadCookiesResponse,
    ReadCookiesWireResult,
};
use super::roster::BrokerRoster;
use super::runner::{FixedSidecarRunner, ProcessOutput, SidecarRunner};
use super::transport::{FixedProviderIdentityTransport, ProviderIdentityTransport};
use serde::de::DeserializeOwned;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

const READ_COOKIES_TIMEOUT: Duration = Duration::from_secs(15);
const LIST_PROFILES_TIMEOUT: Duration = Duration::from_secs(5);
const STDOUT_LIMIT: usize = 2 * 1024 * 1024;

pub(crate) struct BrowserSessionBroker {
    pub(super) runner: Arc<dyn SidecarRunner>,
    pub(super) transport: Arc<dyn ProviderIdentityTransport>,
    pub(super) claude_transport: Arc<dyn ClaudeAccountTransport>,
    pub(super) clock: Arc<dyn BrokerClock>,
    pub(super) roster: std::sync::Mutex<BrokerRoster>,
}

impl BrowserSessionBroker {
    pub(crate) fn new() -> Self {
        Self {
            runner: Arc::new(FixedSidecarRunner),
            transport: Arc::new(FixedProviderIdentityTransport),
            claude_transport: Arc::new(FixedClaudeAccountTransport),
            clock: Arc::new(SystemBrokerClock::new()),
            roster: std::sync::Mutex::new(BrokerRoster::default()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_runner(runner: Arc<dyn SidecarRunner>) -> Self {
        Self {
            runner,
            transport: Arc::new(FixedProviderIdentityTransport),
            claude_transport: Arc::new(FixedClaudeAccountTransport),
            clock: Arc::new(SystemBrokerClock::new()),
            roster: std::sync::Mutex::new(BrokerRoster::default()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_dependencies(
        runner: Arc<dyn SidecarRunner>,
        transport: Arc<dyn ProviderIdentityTransport>,
        clock: Arc<dyn BrokerClock>,
    ) -> Self {
        Self {
            runner,
            transport,
            claude_transport: Arc::new(FixedClaudeAccountTransport),
            clock,
            roster: std::sync::Mutex::new(BrokerRoster::default()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_claude_transport(
        mut self,
        transport: Arc<dyn ClaudeAccountTransport>,
    ) -> Self {
        self.claude_transport = transport;
        self
    }

    pub(crate) fn list_profiles(
        &self,
        browser: Browser,
    ) -> Result<ListProfilesResponse, BrowserSessionError> {
        let request = serde_json::to_vec(&ListProfilesRequest {
            version: PROTOCOL_VERSION,
            operation: "ListProfiles",
            browser,
        })
        .map_err(|_| BrowserSessionError::helper_failed())?;
        let output = self
            .runner
            .run(&request, LIST_PROFILES_TIMEOUT, STDOUT_LIMIT)
            .map_err(BrowserSessionError::from_process)?;
        let response = match parse_response::<ListProfilesWireResult>(output)? {
            ListProfilesWireResult::Success(response) => response,
            ListProfilesWireResult::Error(response) => {
                return Err(map_helper_error(response, "ListProfiles"));
            }
        };
        if response.version != PROTOCOL_VERSION
            || response.operation != "ListProfiles"
            || !response.ok
            || response.browser != browser
            || !profiles_are_valid(&response.profiles)
        {
            return Err(BrowserSessionError::invalid_response());
        }
        Ok(ListProfilesResponse {
            profiles: response.profiles,
        })
    }

    #[cfg(test)]
    pub(super) fn read_cookies(
        &self,
        browser: Browser,
        profile_key: &str,
        provider: CookieProvider,
    ) -> Result<ReadCookiesResponse, BrowserSessionError> {
        self.read_cookies_with_timeout(browser, profile_key, provider, READ_COOKIES_TIMEOUT)
    }

    pub(super) fn read_cookies_with_timeout(
        &self,
        browser: Browser,
        profile_key: &str,
        provider: CookieProvider,
        timeout: Duration,
    ) -> Result<ReadCookiesResponse, BrowserSessionError> {
        if !is_exact_profile_key(profile_key) {
            return Err(BrowserSessionError::invalid_profile_key());
        }
        let request = serde_json::to_vec(&ReadCookiesRequest {
            version: PROTOCOL_VERSION,
            operation: "ReadCookies",
            browser,
            profile_key,
            provider,
        })
        .map_err(|_| BrowserSessionError::helper_failed())?;
        let output = self
            .runner
            .run(&request, timeout.min(READ_COOKIES_TIMEOUT), STDOUT_LIMIT)
            .map_err(BrowserSessionError::from_process)?;
        let response = match parse_response::<ReadCookiesWireResult>(output)? {
            ReadCookiesWireResult::Success(response) => response,
            ReadCookiesWireResult::Error(response) => {
                return Err(map_helper_error(response, "ReadCookies"));
            }
        };
        if response.version != PROTOCOL_VERSION
            || response.operation != "ReadCookies"
            || !response.ok
            || response.browser != browser
            || response.profile_key != profile_key
            || response.provider != provider
            || response
                .candidates
                .iter()
                .any(|candidate| !candidate_is_allowed(candidate, provider))
        {
            return Err(BrowserSessionError::invalid_response());
        }
        let result = ReadCookiesResponse {
            candidates: response.candidates,
            warnings: response
                .warnings
                .into_iter()
                .map(|warning| match warning.code {
                    HelperWarningCode::CookieReadWarning => BrowserSessionWarning {
                        code: BrowserSessionWarningCode::CookieReadWarning,
                        message: "Some browser cookies could not be read.",
                    },
                })
                .collect(),
        };
        for warning in &result.warnings {
            log::warn!(
                "Browser cookie helper warning code={:?} browser={:?} provider={:?}: {}",
                warning.code,
                browser,
                provider,
                warning.message
            );
        }
        Ok(result)
    }
}

fn profiles_are_valid(profiles: &[super::protocol::BrowserProfile]) -> bool {
    let mut keys = HashSet::with_capacity(profiles.len());
    profiles.iter().all(|profile| {
        is_exact_profile_key(&profile.profile_key)
            && !profile.display_name.trim().is_empty()
            && profile.display_name.len() <= 256
            && !profile.display_name.chars().any(char::is_control)
            && keys.insert(profile.profile_key.as_str())
    })
}

fn candidate_is_allowed(
    candidate: &super::protocol::CookieCandidate,
    provider: CookieProvider,
) -> bool {
    if candidate.store_id.is_empty()
        || candidate.store_id.len() > 4_096
        || candidate.store_id.chars().any(char::is_control)
        || candidate.cookie_header.is_empty()
        || candidate.cookie_header.chars().any(char::is_control)
        || !allowed_hosts(provider).contains(&candidate.host.as_str())
    {
        return false;
    }

    candidate.cookie_header.split(';').all(|entry| {
        let entry = entry.trim_start();
        let Some((name, _value)) = entry.split_once('=') else {
            return false;
        };
        !name.is_empty() && allowed_cookie_names(provider).contains(&name)
    })
}

fn allowed_hosts(provider: CookieProvider) -> &'static [&'static str] {
    match provider {
        CookieProvider::Cursor => &[
            "cursor.com",
            "www.cursor.com",
            "cursor.sh",
            "authenticator.cursor.sh",
        ],
        CookieProvider::Claude => &["claude.ai"],
    }
}

fn allowed_cookie_names(provider: CookieProvider) -> &'static [&'static str] {
    match provider {
        CookieProvider::Cursor => &[
            "WorkosCursorSessionToken",
            "__Secure-next-auth.session-token",
            "next-auth.session-token",
            "wos-session",
            "__Secure-wos-session",
            "authjs.session-token",
            "__Secure-authjs.session-token",
        ],
        CookieProvider::Claude => &["sessionKey"],
    }
}

fn parse_response<T: DeserializeOwned>(
    mut output: ProcessOutput,
) -> Result<T, BrowserSessionError> {
    if output.stdout.len() > STDOUT_LIMIT {
        output.stdout.fill(0);
        return Err(BrowserSessionError::from_process(
            super::ProcessRunError::OutputTooLarge,
        ));
    }
    let response = serde_json::from_slice(&output.stdout);
    output.stdout.fill(0);
    response.map_err(|_| BrowserSessionError::invalid_response())
}

fn map_helper_error(
    response: HelperErrorWireResponse,
    expected_operation: &str,
) -> BrowserSessionError {
    if response.version != PROTOCOL_VERSION
        || response.operation != expected_operation
        || response.ok
    {
        return BrowserSessionError::invalid_response();
    }
    BrowserSessionError::from_helper(response.error.code)
}

fn is_exact_profile_key(profile_key: &str) -> bool {
    !profile_key.is_empty()
        && profile_key.len() <= 128
        && profile_key.trim() == profile_key
        && !matches!(profile_key, "." | ".." | "All Profiles")
        && !profile_key
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
}
