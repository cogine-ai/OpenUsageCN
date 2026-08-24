use std::fmt;
#[cfg(target_os = "macos")]
use std::fs::File;
use std::io;
#[cfg(target_os = "macos")]
use std::io::{Read, Write};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

pub(crate) const INSTALLATION_KEY_SERVICE: &str = "ai.cogine.openusagecn.provider-accounts";
pub(crate) const INSTALLATION_KEY_ACCOUNT: &str = "installation-key-v1";

#[cfg(target_os = "macos")]
const SECURITY_TOOL_PATH: &str = "/usr/bin/security";

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
    fn run(&self, args: &[String], stdin: Option<&[u8]>) -> io::Result<CommandResult>;
}

impl<T: CommandRunner + ?Sized> CommandRunner for &T {
    fn run(&self, args: &[String], stdin: Option<&[u8]>) -> io::Result<CommandResult> {
        (**self).run(args, stdin)
    }
}

#[cfg(target_os = "macos")]
struct SecurityCommandRunner;

#[cfg(target_os = "macos")]
impl CommandRunner for SecurityCommandRunner {
    fn run(&self, args: &[String], stdin: Option<&[u8]>) -> io::Result<CommandResult> {
        let mut command = Command::new(SECURITY_TOOL_PATH);
        command.args(args);
        let output = if let Some(input) = stdin {
            let mut child = command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;
            let write_result = {
                let mut child_stdin = child.stdin.take().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "security stdin is unavailable")
                })?;
                child_stdin.write_all(input)
            };
            let output = child.wait_with_output()?;
            write_result?;
            output
        } else {
            command.output()?
        };
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
        let result = self
            .runner
            .run(&find_args(), None)
            .map_err(classify_command_io)?;
        if !result.succeeded() {
            return Err(classify_security_failure(&result));
        }
        decode_key(&result.stdout)
    }

    fn create(&self) -> Result<InstallationKey, InstallationKeyError> {
        let key = InstallationKey(self.generator.generate().map_err(classify_command_io)?);
        let encoded = encode_key(&key);
        let command = add_command(&encoded);
        let result = self
            .runner
            .run(&interactive_args(), Some(command.as_bytes()))
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

fn interactive_args() -> Vec<String> {
    vec!["-q".to_string(), "-i".to_string()]
}

fn add_command(encoded_key: &str) -> String {
    format!(
        "add-generic-password -s {INSTALLATION_KEY_SERVICE} -a {INSTALLATION_KEY_ACCOUNT} -w {encoded_key}\n"
    )
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
#[path = "keychain_tests.rs"]
mod tests;
