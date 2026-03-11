mod claude;
mod commands;
mod db;
mod dev_server;
mod onboarding_tools;
mod profiles;
mod sessions;
mod tools;

use commands::*;

fn load_env() {
    if let Ok(cwd) = std::env::current_dir() {
        for dir in [
            Some(cwd.clone()),
            cwd.parent().map(|p| p.to_path_buf()),
            cwd.parent()
                .and_then(|p| p.parent().map(|pp| pp.to_path_buf())),
        ]
        .into_iter()
        .flatten()
        {
            let env_path = dir.join(".env");
            if env_path.exists() {
                dotenv::from_path(&env_path).ok();
                return;
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        let data_env = home
            .join("Library/Application Support/Thyself")
            .join(".env");
        if data_env.exists() {
            dotenv::from_path(&data_env).ok();
            return;
        }
    }

    dotenv::dotenv().ok();
}

pub fn run_dev_server_only() {
    load_env();
    if let Err(e) = profiles::migrate_legacy_data() {
        eprintln!("Warning: legacy data migration failed: {}", e);
    }
    eprintln!("[dev-server-only] Starting on http://localhost:3001");
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(dev_server::start_dev_server());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    load_env();

    // Migrate legacy single-user data to the profile system
    if let Err(e) = profiles::migrate_legacy_data() {
        eprintln!("Warning: legacy data migration failed: {}", e);
    }

    #[cfg(debug_assertions)]
    {
        std::thread::spawn(|| {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(dev_server::start_dev_server());
        });
    }

    // DB connection is optional — may not exist yet if no profile is set up
    let db_conn = db::open_db().expect("Failed to check for database");
    let db_state = db::DbState {
        conn: std::sync::Mutex::new(db_conn),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(db_state)
        .setup(|app| {
            // #region agent log
            {
                use std::io::Write;
                let path = "/Users/jfru/thyself/.cursor/debug-2ee486.log";
                let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                    let _ = writeln!(f, r#"{{"sessionId":"2ee486","location":"lib.rs:setup","message":"tauri setup called","data":{{}},"timestamp":{}}}"#, ts);
                }
            }
            // #endregion
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_title("Thyself DEV");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            query_db,
            write_db,
            read_file,
            write_file,
            list_files,
            stream_chat,
            get_data_dir_path,
            get_tool_defs,
            create_session,
            list_sessions,
            load_session,
            save_session_messages,
            get_sync_status,
            list_profiles,
            cmd_create_profile,
            cmd_switch_profile,
            cmd_delete_profile,
            get_active_profile,
            cmd_update_profile,
            get_subject_name,
            validate_api_key,
            cmd_perform_restart,
            cmd_open_icloud_settings,
            cmd_open_finder_iphone,
            cmd_debug_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
