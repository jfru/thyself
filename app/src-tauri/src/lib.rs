mod claude;
mod commands;
mod db;
mod dev_server;
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
    dotenv::dotenv().ok();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    load_env();

    // Start the dev HTTP server on :3001 in debug builds
    #[cfg(debug_assertions)]
    {
        std::thread::spawn(|| {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(dev_server::start_dev_server());
        });
    }

    let db_conn = db::open_db().expect("Failed to open thyself database");
    let db_state = db::DbState {
        conn: std::sync::Mutex::new(db_conn),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(db_state)
        .invoke_handler(tauri::generate_handler![
            query_db,
            write_db,
            read_file,
            write_file,
            list_files,
            stream_chat,
            get_data_dir_path,
            get_tool_defs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
