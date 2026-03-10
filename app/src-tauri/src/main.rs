// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--dev-server") {
        app_lib::run_dev_server_only();
    } else {
        app_lib::run()
    }
}
