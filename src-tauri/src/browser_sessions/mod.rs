mod broker;
mod cancellation;
mod claude;
mod claude_transport;
mod clock;
mod discovery;
mod error;
mod model;
mod protocol;
mod roster;
mod runner;
mod transport;

pub(crate) use broker::BrowserSessionBroker;
pub(crate) use cancellation::CancellationToken;
#[cfg(test)]
pub(crate) use claude::ClaudeTeamPlan;
pub(crate) use claude::{
    ClaudeProfileDiscovery, ClaudeTeamEnrichment, ClaudeTeamWarningCode,
    VerifiedClaudeOAuthIdentity,
};
pub(crate) use claude_transport::{ClaudeAccountEvidence, ClaudeAccountTransportError};
#[cfg(test)]
pub(crate) use claude_transport::{ClaudeAccountTransport, ClaudeMembershipEvidence};
#[cfg(test)]
pub(crate) use clock::BrokerClock;
pub(crate) use clock::ClockReading;
pub(crate) use error::BrowserSessionError;
#[cfg(test)]
pub(crate) use error::BrowserSessionErrorCode;
pub(crate) use model::{
    AllProfilesDiscovery, AttachedSessionClaim, BrokerSessionCredential, SessionBindingSummary,
};
#[cfg(test)]
pub(crate) use model::{BrowserCandidateSummary, ProfileDiscoveryStatus, SessionRefHandle};
pub(crate) use protocol::{Browser, CookieProvider, ListProfilesResponse};
pub(crate) use runner::ProcessRunError;
#[cfg(test)]
pub(crate) use runner::{ProcessOutput, SidecarRunner};
#[cfg(test)]
pub(crate) use transport::{ProviderIdentityTransport, ProviderTransportError};
pub(crate) use transport::{ValidationOutcome, VerifiedIdentity};

#[cfg(test)]
mod claude_rotation_tests;
#[cfg(test)]
mod claude_tests;
#[cfg(test)]
mod claude_transport_tests;
#[cfg(test)]
mod discovery_tests;
#[cfg(test)]
mod fallback_tests;
#[cfg(test)]
mod orchestration_tests;
#[cfg(test)]
mod roster_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod transport_tests;
