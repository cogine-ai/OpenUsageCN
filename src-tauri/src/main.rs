// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if openusagecn_lib::cli::should_run_from_env() {
        std::process::exit(openusagecn_lib::cli::run_from_env());
    }
    openusagecn_lib::run()
}
