mod claude;
mod commands;
mod db;
mod dev_server;
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
