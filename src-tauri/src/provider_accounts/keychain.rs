use std::fmt;
#[cfg(target_os = "macos")]
use std::fs::File;
use std::io;
#[cfg(target_os = "macos")]
use std::io::Read;
#[cfg(target_os = "macos")]
use std::process::Command;

pub(crate) const INSTALLATION_KEY_SERVICE: &str = "ai.cogine.openusagecn.provider-accounts";
pub(crate) const INSTALLATION_KEY_ACCOUNT: &str = "installation-key-v1";

pub(crate) struct InstallationKey([u8; 32]);

impl InstallationKey {
    #[cfg(test)]
    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub(crate) fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub(crate) fn into_bytes(self) -> [u8; 32] {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstallationKeyError {
    Missing,
    Denied,
    Unavailable,
    Io,
    Invalid,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
}

impl fmt::Display for InstallationKeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Missing => "installation key is missing",
            Self::Denied => "installation key access was denied",
            Self::Unavailable => "installation key storage is unavailable",
            Self::Io => "installation key storage could not be accessed",
            Self::Invalid => "installation key has an invalid value",
            Self::Unsupported => "installation key storage is unsupported on this platform",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for InstallationKeyError {}

pub(crate) trait InstallationKeyStore: Send + Sync {
    fn read(&self) -> Result<InstallationKey, InstallationKeyError>;
    fn create(&self) -> Result<InstallationKey, InstallationKeyError>;
}

struct CommandResult {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl CommandResult {
    #[cfg(test)]
    fn success(stdout: &[u8]) -> Self {
        Self {
            code: Some(0),
            stdout: stdout.to_vec(),
            stderr: Vec::new(),
        }
    }

    #[cfg(test)]
    fn failure(code: i32, stderr: &str) -> Self {
        Self {
            code: Some(code),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    fn succeeded(&self) -> bool {
        self.code == Some(0)
    }
}

trait CommandRunner: Send + Sync {
    fn run(&self, args: &[String]) -> io::Result<CommandResult>;
}

impl<T: CommandRunner + ?Sized> CommandRunner for &T {
    fn run(&self, args: &[String]) -> io::Result<CommandResult> {
        (**self).run(args)
    }
}

#[cfg(target_os = "macos")]
struct SecurityCommandRunner;

#[cfg(target_os = "macos")]
impl CommandRunner for SecurityCommandRunner {
    fn run(&self, args: &[String]) -> io::Result<CommandResult> {
        let output = Command::new("security").args(args).output()?;
        Ok(CommandResult {
            code: output.status.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

trait KeyGenerator: Send + Sync {
    fn generate(&self) -> io::Result<[u8; 32]>;
}

#[cfg(target_os = "macos")]
struct SystemKeyGenerator;

#[cfg(target_os = "macos")]
impl KeyGenerator for SystemKeyGenerator {
    fn generate(&self) -> io::Result<[u8; 32]> {
        let mut key = [0_u8; 32];
        File::open("/dev/urandom")?.read_exact(&mut key)?;
        Ok(key)
    }
}

#[cfg(test)]
struct FixedGenerator([u8; 32]);

#[cfg(test)]
impl KeyGenerator for FixedGenerator {
    fn generate(&self) -> io::Result<[u8; 32]> {
        Ok(self.0)
    }
}

struct MacOsInstallationKeyStore<R, G> {
    runner: R,
    generator: G,
}

impl<R: CommandRunner, G: KeyGenerator> MacOsInstallationKeyStore<R, G> {
    fn with_runner(runner: R, generator: G) -> Self {
        Self { runner, generator }
    }

    fn read(&self) -> Result<InstallationKey, InstallationKeyError> {
        let result = self.runner.run(&find_args()).map_err(classify_command_io)?;
        if !result.succeeded() {
            return Err(classify_security_failure(&result));
        }
        decode_key(&result.stdout)
    }

    fn create(&self) -> Result<InstallationKey, InstallationKeyError> {
        let key = InstallationKey(self.generator.generate().map_err(classify_command_io)?);
        let encoded = encode_key(&key);
        let result = self
            .runner
            .run(&add_args(&encoded))
            .map_err(classify_command_io)?;
        if result.succeeded() {
            Ok(key)
        } else if is_duplicate_item(&result) {
            self.read()
        } else {
            Err(classify_security_failure(&result))
        }
    }
}

pub(crate) struct SystemInstallationKeyStore;

impl SystemInstallationKeyStore {
    pub(crate) fn new() -> Self {
        Self
    }
}

impl Default for SystemInstallationKeyStore {
    fn default() -> Self {
        Self::new()
    }
}

impl InstallationKeyStore for SystemInstallationKeyStore {
    fn read(&self) -> Result<InstallationKey, InstallationKeyError> {
        #[cfg(target_os = "macos")]
        {
            return MacOsInstallationKeyStore::with_runner(
                SecurityCommandRunner,
                SystemKeyGenerator,
            )
            .read();
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(InstallationKeyError::Unsupported)
        }
    }

    fn create(&self) -> Result<InstallationKey, InstallationKeyError> {
        #[cfg(target_os = "macos")]
        {
            return MacOsInstallationKeyStore::with_runner(
                SecurityCommandRunner,
                SystemKeyGenerator,
            )
            .create();
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(InstallationKeyError::Unsupported)
        }
    }
}

fn find_args() -> Vec<String> {
    vec![
        "find-generic-password".to_string(),
        "-s".to_string(),
        INSTALLATION_KEY_SERVICE.to_string(),
        "-a".to_string(),
        INSTALLATION_KEY_ACCOUNT.to_string(),
        "-w".to_string(),
    ]
}

fn add_args(encoded_key: &str) -> Vec<String> {
    vec![
        "add-generic-password".to_string(),
        "-s".to_string(),
        INSTALLATION_KEY_SERVICE.to_string(),
        "-a".to_string(),
        INSTALLATION_KEY_ACCOUNT.to_string(),
        "-w".to_string(),
        encoded_key.to_string(),
    ]
}

fn classify_command_io(error: io::Error) -> InstallationKeyError {
    if error.kind() == io::ErrorKind::NotFound {
        InstallationKeyError::Unavailable
    } else {
        InstallationKeyError::Io
    }
}

fn classify_security_failure(result: &CommandResult) -> InstallationKeyError {
    let stderr = String::from_utf8_lossy(&result.stderr).to_ascii_lowercase();
    if result.code == Some(44)
        || stderr.contains("could not be found")
        || stderr.contains("errsecitemnotfound")
    {
        InstallationKeyError::Missing
    } else if matches!(result.code, Some(36) | Some(51) | Some(128))
        || stderr.contains("interaction is not allowed")
        || stderr.contains("user canceled")
        || stderr.contains("authorization denied")
        || stderr.contains("errsecauthfailed")
    {
        InstallationKeyError::Denied
    } else {
        InstallationKeyError::Unavailable
    }
}

fn is_duplicate_item(result: &CommandResult) -> bool {
    let stderr = String::from_utf8_lossy(&result.stderr).to_ascii_lowercase();
    result.code == Some(45)
        || stderr.contains("already exists")
        || stderr.contains("duplicate item")
        || stderr.contains("errsecduplicateitem")
}

fn decode_key(stdout: &[u8]) -> Result<InstallationKey, InstallationKeyError> {
    let text = std::str::from_utf8(stdout).map_err(|_| InstallationKeyError::Invalid)?;
    let encoded = text.trim_end_matches(['\r', '\n']);
    if encoded.len() != 64 || !encoded.is_ascii() {
        return Err(InstallationKeyError::Invalid);
    }

    let mut key = [0_u8; 32];
    for (index, chunk) in encoded.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(chunk).map_err(|_| InstallationKeyError::Invalid)?;
        key[index] = u8::from_str_radix(pair, 16).map_err(|_| InstallationKeyError::Invalid)?;
    }
    Ok(InstallationKey(key))
}

fn encode_key(key: &InstallationKey) -> String {
    let mut encoded = String::with_capacity(64);
    for byte in key.as_bytes() {
        use fmt::Write as _;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io;
    use std::sync::Mutex;

    struct ScriptedRunner {
        responses: Mutex<VecDeque<io::Result<CommandResult>>>,
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl ScriptedRunner {
        fn with_responses(responses: Vec<io::Result<CommandResult>>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl CommandRunner for ScriptedRunner {
        fn run(&self, args: &[String]) -> io::Result<CommandResult> {
            self.calls.lock().unwrap().push(args.to_vec());
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
                    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
                    22, 23, 24, 25, 26, 27, 28, 29, 30, 31
                ]
        );
        assert_eq!(
            runner.calls(),
            vec![vec![
                "find-generic-password".to_string(),
                "-s".to_string(),
                INSTALLATION_KEY_SERVICE.to_string(),
                "-a".to_string(),
                INSTALLATION_KEY_ACCOUNT.to_string(),
                "-w".to_string(),
            ]]
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
    fn creates_with_add_only_and_never_updates_an_existing_item() {
        let runner = ScriptedRunner::with_responses(vec![Ok(CommandResult::success(b""))]);
        let store = MacOsInstallationKeyStore::with_runner(&runner, FixedGenerator([9; 32]));
        let key = store.create().expect("new key is stored");

        assert!(key.as_bytes() == &[9; 32]);
        let calls = runner.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            &calls[0][..6],
            &[
                "add-generic-password".to_string(),
                "-s".to_string(),
                INSTALLATION_KEY_SERVICE.to_string(),
                "-a".to_string(),
                INSTALLATION_KEY_ACCOUNT.to_string(),
                "-w".to_string(),
            ]
        );
        assert!(calls[0][6] == "0909090909090909090909090909090909090909090909090909090909090909");
        assert!(!calls[0].iter().any(|arg| arg == "-U"));
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
        assert_eq!(runner.calls().len(), 2);
        assert_eq!(runner.calls()[1], find_args());
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
}
