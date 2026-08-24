use super::*;
use std::collections::VecDeque;
use std::io;
use std::sync::Mutex;

struct ScriptedRunner {
    responses: Mutex<VecDeque<io::Result<CommandResult>>>,
    calls: Mutex<Vec<RecordedCall>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RecordedCall {
    args: Vec<String>,
    stdin: Option<Vec<u8>>,
}

impl ScriptedRunner {
    fn with_responses(responses: Vec<io::Result<CommandResult>>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().unwrap().clone()
    }
}

impl CommandRunner for ScriptedRunner {
    fn run(&self, args: &[String], stdin: Option<&[u8]>) -> io::Result<CommandResult> {
        self.calls.lock().unwrap().push(RecordedCall {
            args: args.to_vec(),
            stdin: stdin.map(<[u8]>::to_vec),
        });
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected security command")
    }
}

#[test]
fn test_adapters_can_construct_a_typed_installation_key() {
    let key = InstallationKey::from_bytes([7; 32]);
    assert!(key.as_bytes() == &[7; 32]);
}

#[test]
fn reads_the_one_app_owned_installation_key_item() {
    let runner = ScriptedRunner::with_responses(vec![Ok(CommandResult::success(
        b"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f\n",
    ))]);
    let store = MacOsInstallationKeyStore::with_runner(&runner, FixedGenerator([9; 32]));
    let key = store.read().expect("key is valid");
    assert!(
        key.as_bytes()
            == &[
                0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
                23, 24, 25, 26, 27, 28, 29, 30, 31
            ]
    );
    assert_eq!(
        runner.calls(),
        vec![RecordedCall {
            args: vec![
                "find-generic-password".to_string(),
                "-s".to_string(),
                INSTALLATION_KEY_SERVICE.to_string(),
                "-a".to_string(),
                INSTALLATION_KEY_ACCOUNT.to_string(),
                "-w".to_string(),
            ],
            stdin: None,
        }]
    );
}

#[test]
fn reports_a_missing_keychain_item_separately() {
    let runner = ScriptedRunner::with_responses(vec![Ok(CommandResult::failure(
        44,
        "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
    ))]);
    let store = MacOsInstallationKeyStore::with_runner(&runner, FixedGenerator([9; 32]));
    let error = store
        .read()
        .err()
        .expect("missing item must not be accepted");

    assert_eq!(error, InstallationKeyError::Missing);
}

#[test]
fn reports_denied_or_disallowed_keychain_access_separately() {
    for response in [
        CommandResult::failure(
            51,
            "security: SecKeychainItemCopyContent: User interaction is not allowed.",
        ),
        CommandResult::failure(128, "security: The user canceled the operation."),
        CommandResult::failure(1, "security: errSecAuthFailed"),
    ] {
        let runner = ScriptedRunner::with_responses(vec![Ok(response)]);
        let store = MacOsInstallationKeyStore::with_runner(&runner, FixedGenerator([9; 32]));
        assert_eq!(store.read().err(), Some(InstallationKeyError::Denied));
    }
}

#[test]
fn creates_via_interactive_security_without_secret_process_arguments() {
    let runner = ScriptedRunner::with_responses(vec![Ok(CommandResult::success(b""))]);
    let store = MacOsInstallationKeyStore::with_runner(&runner, FixedGenerator([9; 32]));
    let key = store.create().expect("new key is stored");

    assert!(key.as_bytes() == &[9; 32]);
    let calls = runner.calls();
    assert_eq!(
        calls,
        vec![RecordedCall {
            args: vec!["-q".to_string(), "-i".to_string()],
            stdin: Some(
                b"add-generic-password -s ai.cogine.openusagecn.provider-accounts -a installation-key-v1 -w 0909090909090909090909090909090909090909090909090909090909090909\n"
                    .to_vec(),
            ),
        }],
        "the installation key must not appear in process arguments"
    );
}

#[test]
fn create_race_returns_the_key_that_won_the_keychain_insert() {
    let runner = ScriptedRunner::with_responses(vec![
        Ok(CommandResult::failure(
            45,
            "security: SecKeychainAddGenericPassword: The specified item already exists in the keychain.",
        )),
        Ok(CommandResult::success(
            b"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f\n",
        )),
    ]);
    let store = MacOsInstallationKeyStore::with_runner(&runner, FixedGenerator([9; 32]));

    let key = store.create().expect("race winner is reread");

    assert_eq!(key.as_bytes()[0], 0);
    assert_eq!(key.as_bytes()[31], 31);
    let calls = runner.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1].args, find_args());
    assert_eq!(calls[1].stdin, None);
}

#[test]
fn rejects_values_that_are_not_exactly_32_encoded_bytes() {
    for value in [vec![b'0'; 62], vec![b'g'; 64], vec![0xff; 64]] {
        let runner = ScriptedRunner::with_responses(vec![Ok(CommandResult::success(&value))]);
        let store = MacOsInstallationKeyStore::with_runner(&runner, FixedGenerator([9; 32]));

        assert_eq!(store.read().err(), Some(InstallationKeyError::Invalid));
    }
}

#[test]
fn separates_an_unavailable_security_tool_from_other_io_failures() {
    for (kind, expected) in [
        (io::ErrorKind::NotFound, InstallationKeyError::Unavailable),
        (io::ErrorKind::PermissionDenied, InstallationKeyError::Io),
    ] {
        let runner = ScriptedRunner::with_responses(vec![Err(io::Error::from(kind))]);
        let store = MacOsInstallationKeyStore::with_runner(&runner, FixedGenerator([9; 32]));

        assert_eq!(store.read().err(), Some(expected));
    }
}

#[test]
fn reports_an_unclassified_security_failure_as_unavailable() {
    let runner = ScriptedRunner::with_responses(vec![Ok(CommandResult::failure(
        70,
        "security subsystem unavailable",
    ))]);
    let store = MacOsInstallationKeyStore::with_runner(&runner, FixedGenerator([9; 32]));

    assert_eq!(store.read().err(), Some(InstallationKeyError::Unavailable));
}

#[cfg(not(target_os = "macos"))]
#[test]
fn unsupported_platform_neither_reads_nor_generates_a_key() {
    let store = SystemInstallationKeyStore::new();

    assert_eq!(store.read().err(), Some(InstallationKeyError::Unsupported));
    assert_eq!(
        store.create().err(),
        Some(InstallationKeyError::Unsupported)
    );
}
