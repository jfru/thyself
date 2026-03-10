use crate::profiles;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

const APPLE_EPOCH_OFFSET: i64 = 978_307_200;
const NANOSECONDS: i64 = 1_000_000_000;

// #region agent log
const DEBUG_LOG_PATH: &str = "/Users/jfru/thyself/.cursor/debug-2ee486.log";
fn debug_log(location: &str, message: &str, data: &str, hypothesis: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(DEBUG_LOG_PATH) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
        let _ = writeln!(f, r#"{{"sessionId":"2ee486","location":"{}","message":"{}","data":{},"hypothesisId":"{}","timestamp":{}}}"#, location, message, data, hypothesis, ts);
    }
}
// #endregion

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn is_dev_mode() -> bool {
    std::env::current_exe()
        .map(|p| {
            let s = p.display().to_string();
            s.contains("tauri_current_app") || s.contains("target/debug")
        })
        .unwrap_or(false)
}

fn open_sqlite_conn(path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(path)
        .map_err(|e| format!("sqlite_open: {}", e))?;
    conn.pragma_update(None, "query_only", "ON").ok();
    Ok(conn)
}

fn open_readonly(path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    let fname = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp_copy = std::env::temp_dir().join(format!("thyself_{fname}"));
    let _ = std::fs::remove_file(tmp_copy.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(tmp_copy.with_extension("sqlite-shm"));
    let _ = std::fs::remove_file(&tmp_copy);

    // #region agent log
    debug_log("onboarding_tools.rs:open_readonly", "open_readonly called", &format!(r#"{{"path":"{}","exists":{}}}"#, path.display(), path.exists()), "H4");
    // #endregion

    // Strategy 1: Direct copy (works if app has FDA)
    match std::fs::copy(path, &tmp_copy) {
        Ok(bytes) => {
            // #region agent log
            debug_log("onboarding_tools.rs:strategy1", "direct copy SUCCESS", &format!(r#"{{"bytes":{}}}"#, bytes), "H2");
            // #endregion
            return open_sqlite_conn(&tmp_copy);
        }
        Err(e) => {
            // #region agent log
            debug_log("onboarding_tools.rs:strategy1", "direct copy FAILED", &format!(r#"{{"error":"{}","kind":"{:?}"}}"#, e, e.kind()), "H2");
            // #endregion
        }
    }

    // Strategy 2 (dev mode): shell cp inherits terminal FDA
    let dev_mode = is_dev_mode();
    // #region agent log
    let exe_path = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    debug_log("onboarding_tools.rs:strategy2", "dev mode check", &format!(r#"{{"is_dev_mode":{},"exe_path":"{}"}}"#, dev_mode, exe_path), "H3");
    // #endregion
    if dev_mode {
        let ok = std::process::Command::new("cp")
            .arg(path.as_os_str())
            .arg(tmp_copy.as_os_str())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        // #region agent log
        debug_log("onboarding_tools.rs:strategy2", "shell cp result", &format!(r#"{{"success":{}}}"#, ok), "H3");
        // #endregion
        if ok {
            return open_sqlite_conn(&tmp_copy);
        }
    }

    Err("permission_denied".to_string())
}

fn apple_ns_to_iso(ns: i64) -> String {
    let unix_seconds = (ns / NANOSECONDS) + APPLE_EPOCH_OFFSET;
    chrono::DateTime::from_timestamp(unix_seconds, 0)
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn apple_seconds_to_iso(seconds: f64) -> String {
    let unix_seconds = seconds as i64 + APPLE_EPOCH_OFFSET;
    chrono::DateTime::from_timestamp(unix_seconds, 0)
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn find_project_root() -> Option<PathBuf> {
    if let Ok(cwd) = std::env::current_dir() {
        let candidates = [
            Some(cwd.clone()),
            cwd.parent().map(|p| p.to_path_buf()),
            cwd.parent()
                .and_then(|p| p.parent().map(|pp| pp.to_path_buf())),
        ];
        for dir in candidates.into_iter().flatten() {
            if dir.join("config.py").exists() {
                return Some(dir);
            }
        }
    }
    None
}

pub async fn execute_onboarding_tool(
    tool_name: &str,
    tool_input: &Value,
) -> Result<Value, String> {
    match tool_name {
        "scan_message_sources" => scan_message_sources(),
        "open_full_disk_access" => open_full_disk_access(),
        "restart_app" => restart_app(),
        "monitor_imessage_download" => monitor_imessage_download(tool_input).await,
        "generate_backup_password" => generate_backup_password(),
        "check_iphone_connection" => check_iphone_connection().await,
        "find_iphone_backups" => find_iphone_backups(),
        "monitor_iphone_backup" => monitor_iphone_backup(tool_input).await,
        "extract_from_backup" => extract_from_backup(tool_input).await,
        "import_messages" => import_messages(tool_input).await,
        _ => Err(format!("Unknown onboarding tool: {}", tool_name)),
    }
}

// ---------------------------------------------------------------------------
// scan_message_sources
// ---------------------------------------------------------------------------

fn scan_message_sources() -> Result<Value, String> {
    // #region agent log
    let home = home_dir();
    debug_log("onboarding_tools.rs:scan", "scan_message_sources called", &format!(r#"{{"home_dir":"{}"}}"#, home.display()), "H4,H5");
    // #endregion

    let mut results = json!({});

    // === iMessage ===
    let chat_db_path = home.join("Library/Messages/chat.db");
    results["imessage"] = scan_single_source(
        &chat_db_path,
        "iMessage",
        |conn| query_source_stats_imessage(conn),
    );

    // === WhatsApp Desktop ===
    let wa_db_path = home
        .join("Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite");
    results["whatsapp_desktop"] = scan_single_source(
        &wa_db_path,
        "WhatsApp Desktop",
        |conn| query_source_stats_whatsapp(conn),
    );

    // #region agent log
    debug_log("onboarding_tools.rs:scan", "scan results", &format!(r#"{{"imessage_status":"{}","whatsapp_status":"{}"}}"#, results["imessage"]["status"].as_str().unwrap_or("?"), results["whatsapp_desktop"]["status"].as_str().unwrap_or("?")), "H1,H2,H3,H4");
    // #endregion

    Ok(results)
}

fn scan_single_source(
    path: &std::path::Path,
    label: &str,
    query: impl FnOnce(&rusqlite::Connection) -> Value,
) -> Value {
    if !path.exists() {
        return json!({
            "status": "not_found",
            "path": path.display().to_string(),
        });
    }

    match open_readonly(path) {
        Ok(conn) => query(&conn),
        Err(e) if e == "permission_denied" => {
            if is_dev_mode() {
                json!({
                    "status": "permission_denied_dev",
                    "path": path.display().to_string(),
                    "message": format!("{} database exists but can't be read in dev mode. Tauri dev copies the binary to a temp path, so Full Disk Access grants don't persist across rebuilds. The production .app build won't have this issue. The database file exists and is ready.", label),
                })
            } else {
                json!({
                    "status": "permission_denied",
                    "path": path.display().to_string(),
                    "message": format!("Full Disk Access required to read the {} database.", label),
                })
            }
        },
        Err(e) => json!({
            "status": "error",
            "path": path.display().to_string(),
            "message": format!("Failed to open {} database: {}", label, e),
        }),
    }
}

fn query_source_stats_imessage(conn: &rusqlite::Connection) -> Value {
    let msg_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM message WHERE text IS NOT NULL AND text != ''",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let conv_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM chat", [], |row| row.get(0))
        .unwrap_or(0);

    let (min_date, max_date): (Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT MIN(date), MAX(date) FROM message WHERE text IS NOT NULL AND text != ''",
            [],
            |row| Ok((row.get(0).ok(), row.get(1).ok())),
        )
        .unwrap_or((None, None));

    let path = home_dir().join("Library/Messages/chat.db");
    json!({
        "status": "found",
        "path": path.display().to_string(),
        "message_count": msg_count,
        "conversation_count": conv_count,
        "earliest_date": min_date.map(apple_ns_to_iso),
        "latest_date": max_date.map(apple_ns_to_iso),
    })
}

fn query_source_stats_whatsapp(conn: &rusqlite::Connection) -> Value {
    let msg_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM ZWAMESSAGE", [], |row| row.get(0))
        .unwrap_or(0);

    let conv_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ZWACHATSESSION WHERE ZCONTACTJID IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let (min_date, max_date): (Option<f64>, Option<f64>) = conn
        .query_row(
            "SELECT MIN(ZMESSAGEDATE), MAX(ZMESSAGEDATE) FROM ZWAMESSAGE WHERE ZMESSAGEDATE > 0",
            [],
            |row| Ok((row.get(0).ok(), row.get(1).ok())),
        )
        .unwrap_or((None, None));

    let path = home_dir()
        .join("Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite");
    json!({
        "status": "found",
        "path": path.display().to_string(),
        "message_count": msg_count,
        "conversation_count": conv_count,
        "earliest_date": min_date.map(apple_seconds_to_iso),
        "latest_date": max_date.map(apple_seconds_to_iso),
    })
}

// ---------------------------------------------------------------------------
// open_full_disk_access
// ---------------------------------------------------------------------------

fn restart_app() -> Result<Value, String> {
    Ok(json!({"status": "restart_ready"}))
}

/// Called by the frontend when user clicks the Restart button.
/// Spawns a delayed reopen then exits.
pub fn perform_restart() {
    let exe = std::env::current_exe().unwrap_or_default();
    let mut app_path = None;
    let mut current = exe.as_path();
    while let Some(parent) = current.parent() {
        if current.extension().and_then(|e| e.to_str()) == Some("app") {
            app_path = Some(current.to_path_buf());
            break;
        }
        current = parent;
    }

    if let Some(ref app) = app_path {
        let _ = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("sleep 1 && open {:?}", app.display().to_string()))
            .spawn();
    }

    std::process::exit(0);
}

fn open_full_disk_access() -> Result<Value, String> {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();

    // Attempt to read a TCC-protected file so macOS adds this app
    // to the Full Disk Access list (unchecked).
    let _ = std::fs::read("/Library/Application Support/com.apple.TCC/TCC.db");

    let url = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles";
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| format!("Failed to open System Settings: {}", e))?;

    let is_dev = exe.contains("tauri_current_app") || exe.contains("target/debug");

    Ok(json!({
        "status": "opened",
        "executable": exe,
        "is_dev": is_dev,
        "message": if is_dev {
            format!("Opened System Settings → Full Disk Access. In dev mode the binary runs from a temp path ({}). You need to add THIS specific binary, or grant FDA to your terminal app (e.g. Warp, Terminal) instead.", exe)
        } else {
            "Opened System Settings → Privacy & Security → Full Disk Access. Thyself should appear in the list — toggle it ON.".to_string()
        },
    }))
}

// ---------------------------------------------------------------------------
// monitor_imessage_download
// ---------------------------------------------------------------------------

fn query_imessage_stats() -> Result<(i64, Option<String>), String> {
    let chat_db_path = home_dir().join("Library/Messages/chat.db");
    let conn = open_readonly(&chat_db_path)?;

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM message WHERE text IS NOT NULL AND text != ''",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let min_date: Option<i64> = conn
        .query_row(
            "SELECT MIN(date) FROM message WHERE text IS NOT NULL AND text != ''",
            [],
            |row| row.get(0),
        )
        .ok()
        .flatten();

    let earliest = min_date.map(apple_ns_to_iso);
    Ok((count, earliest))
}

async fn monitor_imessage_download(tool_input: &Value) -> Result<Value, String> {
    let duration = tool_input["duration_seconds"].as_u64().unwrap_or(30);
    let interval = tool_input["interval_seconds"].as_u64().unwrap_or(5);

    let (initial_count, initial_earliest) = query_imessage_stats()?;
    let mut prev_count = initial_count;
    let mut final_count = initial_count;
    let mut final_earliest = initial_earliest.clone();
    let mut stable_polls = 0;

    let polls = duration / interval.max(1);
    for _ in 0..polls {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        let (count, earliest) = query_imessage_stats()?;

        if count == prev_count {
            stable_polls += 1;
        } else {
            stable_polls = 0;
        }

        prev_count = count;
        final_count = count;
        final_earliest = earliest;
    }

    let messages_added = final_count - initial_count;
    let status = if messages_added == 0 {
        "no_change"
    } else if stable_polls >= 2 {
        "complete"
    } else {
        "downloading"
    };

    Ok(json!({
        "initial_count": initial_count,
        "final_count": final_count,
        "messages_added": messages_added,
        "initial_earliest": initial_earliest,
        "final_earliest": final_earliest,
        "status": status,
    }))
}

// ---------------------------------------------------------------------------
// generate_backup_password
// ---------------------------------------------------------------------------

fn generate_backup_password() -> Result<Value, String> {
    let active_id = profiles::get_active_profile_id()
        .ok_or_else(|| "No active profile".to_string())?;

    if let Ok(Some(ref pw)) = profiles::get_backup_password(&active_id) {
        if !pw.is_empty() {
            return Ok(json!({
                "password": pw,
                "source": "existing",
            }));
        }
    }

    use rand::Rng;
    let mut rng = rand::rng();
    let charset = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let password: String = (0..24)
        .map(|_| {
            let idx = rng.random_range(0..charset.len());
            charset[idx] as char
        })
        .collect();

    profiles::set_backup_password(&active_id, &password)?;

    Ok(json!({
        "password": password,
        "source": "generated",
    }))
}

// ---------------------------------------------------------------------------
// check_iphone_connection
// ---------------------------------------------------------------------------

async fn check_iphone_connection() -> Result<Value, String> {
    let output = tokio::process::Command::new("system_profiler")
        .args(["SPUSBDataType", "-json"])
        .output()
        .await
        .map_err(|e| format!("Failed to run system_profiler: {}", e))?;

    if !output.status.success() {
        return Err("system_profiler failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let data: Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse system_profiler output: {}", e))?;

    fn find_iphone(items: &[Value]) -> Option<Value> {
        for item in items {
            if let Some(name) = item["_name"].as_str() {
                if name.contains("iPhone") {
                    return Some(json!({
                        "status": "found",
                        "device_name": name,
                        "serial_number": item["serial_num"].as_str().unwrap_or(""),
                    }));
                }
            }
            if let Some(sub_items) = item["_items"].as_array() {
                if let Some(found) = find_iphone(sub_items) {
                    return Some(found);
                }
            }
        }
        None
    }

    if let Some(usb_data) = data["SPUSBDataType"].as_array() {
        if let Some(found) = find_iphone(usb_data) {
            return Ok(found);
        }
    }

    Ok(json!({
        "status": "not_found",
        "message": "No iPhone detected. Please connect your iPhone via USB and unlock it.",
    }))
}

// ---------------------------------------------------------------------------
// find_iphone_backups
// ---------------------------------------------------------------------------

fn find_iphone_backups() -> Result<Value, String> {
    let backup_dir = home_dir().join("Library/Application Support/MobileSync/Backup");

    if !backup_dir.exists() {
        return Ok(json!({
            "backups": [],
            "message": "No backup directory found",
        }));
    }

    let mut backups = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&backup_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let info_plist = path.join("Info.plist");
            if !info_plist.exists() {
                continue;
            }

            let plist_data = match plist::Value::from_file(&info_plist) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let dict = match plist_data.as_dictionary() {
                Some(d) => d,
                None => continue,
            };

            let device_name = dict
                .get("Device Name")
                .and_then(|v| v.as_string())
                .unwrap_or("Unknown Device")
                .to_string();

            let last_backup_date = dict
                .get("Last Backup Date")
                .and_then(|v| v.as_date())
                .map(|d| d.to_xml_format())
                .unwrap_or_default();

            let product_type = dict
                .get("Product Type")
                .and_then(|v| v.as_string())
                .unwrap_or("")
                .to_string();

            // Check encryption via Manifest.plist ManifestKey
            let manifest_plist = path.join("Manifest.plist");
            let is_encrypted = if manifest_plist.exists() {
                match plist::Value::from_file(&manifest_plist) {
                    Ok(v) => v
                        .as_dictionary()
                        .map(|d| d.contains_key("ManifestKey"))
                        .unwrap_or(false),
                    Err(_) => false,
                }
            } else {
                false
            };

            backups.push(json!({
                "device_name": device_name,
                "product_type": product_type,
                "last_backup_date": last_backup_date,
                "is_encrypted": is_encrypted,
                "path": path.display().to_string(),
            }));
        }
    }

    backups.sort_by(|a, b| {
        b["last_backup_date"]
            .as_str()
            .unwrap_or("")
            .cmp(a["last_backup_date"].as_str().unwrap_or(""))
    });

    Ok(json!({
        "backups": backups,
        "count": backups.len(),
    }))
}

// ---------------------------------------------------------------------------
// monitor_iphone_backup
// ---------------------------------------------------------------------------

async fn monitor_iphone_backup(tool_input: &Value) -> Result<Value, String> {
    let duration = tool_input["duration_seconds"].as_u64().unwrap_or(30);
    let interval = tool_input["interval_seconds"].as_u64().unwrap_or(5);

    let backup_dir = home_dir().join("Library/Application Support/MobileSync/Backup");

    let find_newest_backup = || -> Option<PathBuf> {
        let entries = std::fs::read_dir(&backup_dir).ok()?;
        let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Ok(metadata) = std::fs::metadata(&path) {
                if let Ok(modified) = metadata.modified() {
                    if newest
                        .as_ref()
                        .map(|(_, t)| modified > *t)
                        .unwrap_or(true)
                    {
                        newest = Some((path, modified));
                    }
                }
            }
        }
        newest.map(|(path, _)| path)
    };

    let backup_path = match find_newest_backup() {
        Some(p) => p,
        None => {
            return Ok(json!({
                "status": "not_started",
                "message": "No backup directory found",
            }))
        }
    };

    let get_mtime = |p: &PathBuf| -> Option<std::time::SystemTime> {
        std::fs::metadata(p).ok()?.modified().ok()
    };

    let initial_mtime = get_mtime(&backup_path);
    let mut prev_mtime = initial_mtime;
    let mut mtime_changed = false;
    let mut stable_polls = 0;

    let polls = duration / interval.max(1);
    for _ in 0..polls {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        let current_mtime = get_mtime(&backup_path);

        if current_mtime != prev_mtime {
            mtime_changed = true;
            stable_polls = 0;
        } else {
            stable_polls += 1;
        }
        prev_mtime = current_mtime;
    }

    let manifest_db = backup_path.join("Manifest.db");
    let has_manifest = manifest_db.exists();

    let manifest_plist = backup_path.join("Manifest.plist");
    let is_encrypted = if manifest_plist.exists() {
        match plist::Value::from_file(&manifest_plist) {
            Ok(v) => v
                .as_dictionary()
                .map(|d| d.contains_key("ManifestKey"))
                .unwrap_or(false),
            Err(_) => false,
        }
    } else {
        false
    };

    let info_plist = backup_path.join("Info.plist");
    let device_name = if info_plist.exists() {
        plist::Value::from_file(&info_plist)
            .ok()
            .and_then(|v| v.into_dictionary())
            .and_then(|d| {
                d.get("Device Name")
                    .and_then(|v| v.as_string().map(|s| s.to_string()))
            })
            .unwrap_or_default()
    } else {
        String::new()
    };

    let status = if stable_polls >= 2 && has_manifest && !mtime_changed {
        "complete"
    } else if mtime_changed {
        "in_progress"
    } else if has_manifest {
        "complete"
    } else {
        "not_started"
    };

    Ok(json!({
        "status": status,
        "device_name": device_name,
        "backup_path": backup_path.display().to_string(),
        "is_encrypted": is_encrypted,
    }))
}

// ---------------------------------------------------------------------------
// extract_from_backup
// ---------------------------------------------------------------------------

async fn extract_from_backup(tool_input: &Value) -> Result<Value, String> {
    let backup_path = tool_input["backup_path"]
        .as_str()
        .ok_or("Missing 'backup_path' parameter")?;
    let password = tool_input["password"]
        .as_str()
        .ok_or("Missing 'password' parameter")?;

    let project_root =
        find_project_root().ok_or("Could not find project root (config.py not found)")?;

    let script = project_root.join("extract_whatsapp.py");
    if !script.exists() {
        return Err(format!(
            "Extract script not found: {}",
            script.display()
        ));
    }

    let data_dir = profiles::get_active_data_dir();

    let output = tokio::process::Command::new("python3")
        .arg(&script)
        .env("THYSELF_IPHONE_BACKUP", backup_path)
        .env("WA_BACKUP_PW", password)
        .env("THYSELF_DATA_DIR", data_dir.display().to_string())
        .current_dir(&project_root)
        .output()
        .await
        .map_err(|e| format!("Failed to run extract_whatsapp.py: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(json!({
            "status": "ok",
            "output": stdout,
        }))
    } else {
        Err(format!(
            "extract_whatsapp.py failed:\nstdout: {}\nstderr: {}",
            stdout, stderr
        ))
    }
}

// ---------------------------------------------------------------------------
// import_messages
// ---------------------------------------------------------------------------

async fn import_messages(tool_input: &Value) -> Result<Value, String> {
    let source = tool_input["source"]
        .as_str()
        .ok_or("Missing 'source' parameter")?;
    let method = tool_input["method"]
        .as_str()
        .ok_or("Missing 'method' parameter")?;

    let project_root =
        find_project_root().ok_or("Could not find project root (config.py not found)")?;

    let script = match (source, method) {
        ("imessage", "local_sync") => project_root.join("sync/imessage_sync.py"),
        ("whatsapp", "local_sync") => project_root.join("sync/whatsapp_desktop_sync.py"),
        ("whatsapp", "backup_import") => project_root.join("import_whatsapp.py"),
        _ => {
            return Err(format!(
                "Unknown source/method combination: {}/{}",
                source, method
            ))
        }
    };

    if !script.exists() {
        return Err(format!("Import script not found: {}", script.display()));
    }

    let data_dir = profiles::get_active_data_dir();

    let output = tokio::process::Command::new("python3")
        .arg(&script)
        .env("THYSELF_DATA_DIR", data_dir.display().to_string())
        .current_dir(&project_root)
        .output()
        .await
        .map_err(|e| format!("Failed to run {}: {}", script.display(), e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(json!({
            "status": "ok",
            "output": stdout,
            "source": source,
            "method": method,
        }))
    } else {
        Err(format!(
            "{} failed:\nstdout: {}\nstderr: {}",
            script.display(),
            stdout,
            stderr
        ))
    }
}

// ---------------------------------------------------------------------------
// Tool definitions for the onboarding agent
// ---------------------------------------------------------------------------

pub fn get_onboarding_tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "scan_message_sources",
            "description": "Scan this Mac for iMessage and WhatsApp databases. Returns message counts, conversation counts, and date ranges for each source found. Use this as the first step to understand what message data is available locally.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "open_full_disk_access",
            "description": "Opens macOS System Settings directly to the Full Disk Access page. Call this when scan_message_sources returns 'permission_denied' for any source. After calling this, tell the user to toggle Thyself ON in the list, then re-call scan_message_sources to verify.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "restart_app",
            "description": "Show a restart button to the user. Call this when the app needs to restart (e.g. after granting Full Disk Access and re-scan still fails). A restart button will appear in the chat for the user to click.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "monitor_imessage_download",
            "description": "Monitor the iCloud Messages download progress by polling the Mac's chat.db. Call this after guiding the user to disable Messages in iCloud (System Settings → iCloud → Messages → OFF → 'Disable and Download Messages'). Returns download progress including messages added and how far back the earliest date has moved. Status is 'downloading', 'complete', or 'no_change'.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "duration_seconds": {
                        "type": "integer",
                        "description": "How long to monitor in seconds (default: 30)"
                    },
                    "interval_seconds": {
                        "type": "integer",
                        "description": "Polling interval in seconds (default: 5)"
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "generate_backup_password",
            "description": "Generate a random backup password for iPhone backup encryption. The password is saved to the user's profile automatically and will be used later for extraction. Display the returned password in a code block so the user can copy-paste it into Finder's backup encryption field. If a password was already generated, returns the existing one.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "check_iphone_connection",
            "description": "Check if an iPhone is connected to this Mac via USB. Returns the device name and serial number if found. Use this to verify the iPhone is plugged in before guiding the user through backup creation.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "find_iphone_backups",
            "description": "List all iPhone backups available on this Mac. Returns device name, backup date, encryption status, and path for each backup. Use this to find existing backups or verify a new backup was created.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "monitor_iphone_backup",
            "description": "Monitor iPhone backup progress by polling the backup directory. Call this after the user clicks 'Back Up Now' in Finder. Returns status: 'in_progress', 'complete', or 'not_started'.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "duration_seconds": {
                        "type": "integer",
                        "description": "How long to monitor in seconds (default: 30)"
                    },
                    "interval_seconds": {
                        "type": "integer",
                        "description": "Polling interval in seconds (default: 5)"
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "extract_from_backup",
            "description": "Extract WhatsApp databases from an encrypted iPhone backup. Runs the decryption and extraction process. This can take 30-120 seconds depending on backup size.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "backup_path": {
                        "type": "string",
                        "description": "Full path to the iPhone backup directory"
                    },
                    "password": {
                        "type": "string",
                        "description": "The backup encryption password"
                    }
                },
                "required": ["backup_path", "password"]
            }
        }),
        json!({
            "name": "import_messages",
            "description": "Import messages from a local database or extracted backup into Thyself. For iMessage, use source='imessage' with method='local_sync' (reads Mac's chat.db). For WhatsApp, use source='whatsapp' with method='local_sync' (WhatsApp Desktop) or method='backup_import' (from extracted iPhone backup).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "enum": ["imessage", "whatsapp"],
                        "description": "Which message source to import"
                    },
                    "method": {
                        "type": "string",
                        "enum": ["local_sync", "backup_import"],
                        "description": "Import method: local_sync reads from local Mac databases, backup_import reads from extracted iPhone backup"
                    }
                },
                "required": ["source", "method"]
            }
        }),
    ]
}
