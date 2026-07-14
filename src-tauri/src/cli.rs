use crate::usage_reader::{LimitsReadError, read_limits_once};
use std::ffi::OsStr;

const EXIT_OK: i32 = 0;
const EXIT_INVALID_ARGUMENTS: i32 = 2;
const EXIT_NO_SNAPSHOT: i32 = 3;
const EXIT_READ_FAILED: i32 = 4;

#[derive(Debug, PartialEq, Eq)]
struct CliArguments {
    provider_id: Option<String>,
    force: bool,
}

pub fn should_run_from_env() -> bool {
    let invoked_as_openusage = std::env::args_os()
        .next()
        .as_deref()
        .and_then(|argument| std::path::Path::new(argument).file_name())
        == Some(OsStr::new("openusage"));
    invoked_as_openusage || std::env::args().nth(1).as_deref() == Some("--openusage-cli")
}

pub fn run_from_env() -> i32 {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--openusage-cli") {
        args.remove(0);
    }
    if args
        .iter()
        .any(|argument| argument == "--help" || argument == "-h")
    {
        println!("Usage: openusage [provider] [--force]");
        return EXIT_OK;
    }
    if args
        .iter()
        .any(|argument| argument == "--version" || argument == "-V")
    {
        println!("openusage {}", env!("CARGO_PKG_VERSION"));
        return EXIT_OK;
    }

    let arguments = match parse_arguments(&args) {
        Ok(arguments) => arguments,
        Err(message) => {
            eprintln!("openusage: {message}");
            eprintln!("Usage: openusage [provider] [--force]");
            return EXIT_INVALID_ARGUMENTS;
        }
    };
    let read = match read_limits_once(arguments.provider_id.as_deref(), arguments.force) {
        Ok(read) => read,
        Err(LimitsReadError::UnknownProvider(provider_id)) => {
            eprintln!("openusage: unknown provider '{provider_id}'");
            return EXIT_INVALID_ARGUMENTS;
        }
        Err(LimitsReadError::NoDataDirectory) => {
            eprintln!("openusage: could not locate the OpenUsageCN data directory");
            return EXIT_READ_FAILED;
        }
        Err(LimitsReadError::NoProviderPlugins) => {
            eprintln!("openusage: no OpenUsageCN provider plugins were found");
            return EXIT_READ_FAILED;
        }
    };
    let json = match serde_json::to_string(&read.envelope) {
        Ok(json) => json,
        Err(error) => {
            eprintln!("openusage: could not serialize limits: {error}");
            return EXIT_READ_FAILED;
        }
    };
    println!("{json}");

    exit_code_for_result(read.refresh_failed, read.missing_snapshot)
}

fn exit_code_for_result(refresh_failed: bool, missing_snapshot: bool) -> i32 {
    if refresh_failed {
        EXIT_READ_FAILED
    } else if missing_snapshot {
        EXIT_NO_SNAPSHOT
    } else {
        EXIT_OK
    }
}

fn parse_arguments(args: &[String]) -> Result<CliArguments, String> {
    let mut provider_id = None;
    let mut force = false;
    for argument in args {
        if argument == "--force" {
            if force {
                return Err("--force may only be provided once".to_string());
            }
            force = true;
        } else if argument.starts_with('-') {
            return Err(format!("unknown option '{argument}'"));
        } else if provider_id.replace(argument.clone()).is_some() {
            return Err("only one provider may be requested".to_string());
        }
    }
    Ok(CliArguments { provider_id, force })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_provider_and_force_in_either_order() {
        assert_eq!(
            parse_arguments(&["codex".to_string(), "--force".to_string()]),
            Ok(CliArguments {
                provider_id: Some("codex".to_string()),
                force: true,
            })
        );
        assert_eq!(
            parse_arguments(&["--force".to_string(), "claude".to_string()]),
            Ok(CliArguments {
                provider_id: Some("claude".to_string()),
                force: true,
            })
        );
    }

    #[test]
    fn rejects_unknown_or_ambiguous_arguments() {
        assert!(parse_arguments(&["--json".to_string()]).is_err());
        assert!(parse_arguments(&["codex".to_string(), "claude".to_string()]).is_err());
        assert!(parse_arguments(&["--force".to_string(), "--force".to_string()]).is_err());
    }

    #[test]
    fn refresh_failure_takes_precedence_over_missing_snapshot() {
        assert_eq!(exit_code_for_result(true, true), EXIT_READ_FAILED);
        assert_eq!(exit_code_for_result(false, true), EXIT_NO_SNAPSHOT);
        assert_eq!(exit_code_for_result(false, false), EXIT_OK);
    }
}
