use crate::datarep_client::{DatarepClient, DatarepResponse};
use crate::profiles;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

static RUNNING_SYNCS: std::sync::LazyLock<Mutex<HashMap<String, u32>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Kill a running sync subprocess for the given source key (e.g. "gmail", "imessage").
pub fn kill_sync_for_source(source: &str) {
    let pid = {
        let mut map = RUNNING_SYNCS.lock().unwrap();
        map.remove(source)
    };
    if let Some(pid) = pid {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
}

/// Kill running syncs for any of the given source keys.
pub fn kill_syncs_for_sources(sources: &[&str]) {
    for s in sources {
        kill_sync_for_source(s);
    }
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

pub fn find_project_root_pub() -> Option<PathBuf> {
    find_project_root()
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

    // Fallback: check the macOS app bundle Resources directory (production)
    // Executable is at Thyself.app/Contents/MacOS/Thyself
    // Bundled resources are at Thyself.app/Contents/Resources/
    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            let resources_dir = macos_dir
                .parent()
                .map(|contents| contents.join("Resources"));
            if let Some(ref dir) = resources_dir {
                if dir.join("config.py").exists() {
                    return Some(dir.clone());
                }
            }
        }
    }

    None
}

fn ensure_sync_runs_table(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            started_at DATETIME NOT NULL,
            finished_at DATETIME,
            messages_added INTEGER DEFAULT 0,
            progress_processed INTEGER DEFAULT 0,
            progress_total INTEGER,
            status TEXT DEFAULT 'running',
            error_message TEXT,
            last_message_at DATETIME
        )",
    )
    .map_err(|e| format!("Failed to ensure sync_runs table: {}", e))?;

    // Best-effort migration for existing databases.
    let mut stmt = conn
        .prepare("PRAGMA table_info(sync_runs)")
        .map_err(|e| format!("Failed to inspect sync_runs schema: {}", e))?;
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to read sync_runs schema: {}", e))?
        .filter_map(Result::ok)
        .collect();

    if !cols.iter().any(|c| c == "progress_processed") {
        conn.execute("ALTER TABLE sync_runs ADD COLUMN progress_processed INTEGER DEFAULT 0", [])
            .map_err(|e| format!("Failed to add progress_processed column: {}", e))?;
    }
    if !cols.iter().any(|c| c == "progress_total") {
        conn.execute("ALTER TABLE sync_runs ADD COLUMN progress_total INTEGER", [])
            .map_err(|e| format!("Failed to add progress_total column: {}", e))?;
    }

    Ok(())
}

fn source_message_count(conn: &rusqlite::Connection, source: &str) -> Result<i64, String> {
    match source {
        "imessage" => conn
            .query_row("SELECT COUNT(*) FROM messages WHERE source = 'imessage'", [], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("Failed to query source count: {}", e)),
        "whatsapp" => conn
            .query_row("SELECT COUNT(*) FROM messages WHERE source = 'whatsapp'", [], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("Failed to query source count: {}", e)),
        "gmail" => conn
            .query_row("SELECT COUNT(*) FROM gmail_messages", [], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("Failed to query source count: {}", e)),
        "chatgpt" => conn
            .query_row("SELECT COUNT(*) FROM chatgpt_messages", [], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("Failed to query source count: {}", e)),
        _ => conn
            .query_row("SELECT COUNT(*) FROM messages WHERE source = ?1", [source], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("Failed to query source count: {}", e)),
    }
}

fn source_last_message_at(conn: &rusqlite::Connection, source: &str) -> Result<Option<String>, String> {
    match source {
        "gmail" => conn
            .query_row("SELECT MAX(sent_at) FROM gmail_messages", [], |row| row.get::<_, Option<String>>(0))
            .map_err(|e| format!("Failed to query source last_message_at: {}", e)),
        "chatgpt" => conn
            .query_row(
                "SELECT MAX(create_time) FROM chatgpt_messages WHERE create_time IS NOT NULL",
                [],
                |row| row.get::<_, Option<f64>>(0),
            )
            .map_err(|e| format!("Failed to query chatgpt last_message_at: {}", e))
            .map(|opt| {
                opt.and_then(|ts| {
                    chrono::DateTime::from_timestamp(ts as i64, 0)
                        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string())
                })
            }),
        _ => conn
            .query_row("SELECT MAX(sent_at) FROM messages WHERE source = ?1", [source], |row| row.get::<_, Option<String>>(0))
            .map_err(|e| format!("Failed to query source last_message_at: {}", e)),
    }
}

fn start_sync_run(db_path: &std::path::Path, source_key: &str) -> Result<i64, String> {
    let conn = rusqlite::Connection::open(db_path)
        .map_err(|e| format!("Failed to open DB for sync run start: {}", e))?;
    ensure_sync_runs_table(&conn)?;
    // If a prior run for this source is still marked running, close it out so
    // one source has a single canonical active run (prevents stale "running").
    conn.execute(
        "UPDATE sync_runs
         SET finished_at = datetime('now'),
             status = 'failed',
             error_message = COALESCE(error_message, 'Superseded by a newer sync run')
         WHERE source = ?1 AND status = 'running'",
        [source_key],
    )
    .map_err(|e| format!("Failed to supersede existing running sync: {}", e))?;
    conn.execute(
        "INSERT INTO sync_runs (source, started_at, status) VALUES (?1, datetime('now'), 'running')",
        [source_key],
    )
    .map_err(|e| format!("Failed to start sync run: {}", e))?;
    Ok(conn.last_insert_rowid())
}

fn finish_sync_run(
    db_path: &std::path::Path,
    run_id: i64,
    messages_added: i64,
    last_message_at: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let conn = rusqlite::Connection::open(db_path)
        .map_err(|e| format!("Failed to open DB for sync run finish: {}", e))?;
    ensure_sync_runs_table(&conn)?;
    let status = if error.is_some() { "failed" } else { "completed" };
    conn.execute(
        "UPDATE sync_runs
         SET finished_at = datetime('now'),
             messages_added = ?1,
             status = ?2,
             error_message = ?3,
             last_message_at = ?4
         WHERE id = ?5",
        rusqlite::params![messages_added, status, error, last_message_at, run_id],
    )
    .map_err(|e| format!("Failed to finish sync run: {}", e))?;
    Ok(())
}

pub async fn execute_onboarding_tool(
    tool_name: &str,
    tool_input: &Value,
) -> Result<Value, String> {
    match tool_name {
        "add_data_source" => add_data_source(tool_input),
        "check_datarep" => check_datarep().await,
        "setup_datarep" => setup_datarep().await,
        "register_datarep_source" => register_datarep_source(tool_input).await,
        "datarep_scan" => datarep_scan(tool_input).await,
        "datarep_import" => datarep_import(tool_input).await,
        "datarep_reply" => datarep_reply(tool_input).await,
        "datarep_stream" => datarep_stream(tool_input).await,
        "datarep_auth" => datarep_auth(tool_input).await,
        "open_full_disk_access" => open_full_disk_access(),
        "restart_app" => restart_app(),
        "open_url" => open_url(tool_input),
        "start_portrait_build" => crate::commands::start_portrait_build().await,
        "install_weekly_sync" => install_weekly_sync(),
        "check_sync_schedule" => check_sync_schedule(),
        "uninstall_weekly_sync" => uninstall_weekly_sync(),
        _ => Err(format!("Unknown onboarding tool: {}", tool_name)),
    }
}

// ===========================================================================
// add_data_source — lets the agent add a source to the profile dynamically
// ===========================================================================

fn add_data_source(tool_input: &Value) -> Result<Value, String> {
    let source_id = tool_input["source_id"]
        .as_str()
        .ok_or("Missing 'source_id' parameter")?;

    let profile_id = profiles::get_active_profile_id()
        .ok_or_else(|| "No active profile".to_string())?;

    let profile = profiles::update_profile_add_source(&profile_id, source_id)?;

    Ok(json!({
        "status": "added",
        "source_id": source_id,
        "selected_sources": profile.selected_sources,
    }))
}

// ===========================================================================
// datarep tools
// ===========================================================================

async fn datarep_health_check() -> bool {
    reqwest::Client::new()
        .get("http://127.0.0.1:7080/health")
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn auto_start_datarep() -> bool {
    // Try `datarep init` first (idempotent, ensures config exists)
    let _ = tokio::process::Command::new("datarep")
        .args(["init"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;

    // Spawn `datarep start` in the background
    let spawn_result = tokio::process::Command::new("datarep")
        .args(["start"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();

    if spawn_result.is_err() {
        return false;
    }

    // Poll health for up to 15 seconds
    for _ in 0..15 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        if datarep_health_check().await {
            return true;
        }
    }
    false
}

async fn check_datarep() -> Result<Value, String> {
    let has_key = profiles::get_datarep_api_key().is_some();

    let mut healthy = datarep_health_check().await;

    if !healthy {
        eprintln!("[datarep] Not running, attempting auto-start...");
        healthy = auto_start_datarep().await;
        if healthy {
            eprintln!("[datarep] Auto-start succeeded");
        } else {
            eprintln!("[datarep] Auto-start failed");
        }
    }

    if healthy && has_key {
        Ok(json!({
            "status": "ready",
            "message": "Data connector is running and ready."
        }))
    } else if healthy && !has_key {
        Ok(json!({
            "status": "needs_registration",
            "message": "Data connector is running but needs to be registered. Call setup_datarep to register."
        }))
    } else {
        Ok(json!({
            "status": "not_running",
            "message": "Could not start the data connector. The app may need to be reinstalled."
        }))
    }
}

async fn setup_datarep() -> Result<Value, String> {
    let output = tokio::process::Command::new("datarep")
        .args(["app", "register", "thyself", "--sources", "imessage,whatsapp,gmail,chatgpt"])
        .output()
        .await
        .map_err(|e| format!("Failed to run datarep: {}. Is datarep installed?", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "datarep app register failed:\nstdout: {}\nstderr: {}",
            stdout, stderr
        ));
    }

    let api_key = stdout
        .lines()
        .find(|line| line.contains("dr_"))
        .and_then(|line| {
            line.split_whitespace()
                .find(|word| word.starts_with("dr_"))
        })
        .map(|k| k.trim().to_string())
        .ok_or_else(|| {
            format!(
                "Could not find API key (dr_...) in datarep output:\n{}",
                stdout
            )
        })?;

    if let Some(profile_id) = profiles::get_active_profile_id() {
        profiles::set_datarep_api_key(&profile_id, &api_key)?;
    }

    Ok(json!({
        "status": "registered",
        "message": "Thyself is registered with datarep. API key saved to profile.",
    }))
}

async fn register_datarep_source(tool_input: &Value) -> Result<Value, String> {
    let name = tool_input["name"]
        .as_str()
        .ok_or("Missing 'name' parameter")?;
    let source_type = tool_input["source_type"]
        .as_str()
        .unwrap_or("auto");
    let config = tool_input
        .get("config")
        .cloned()
        .unwrap_or(json!({}));

    let client = DatarepClient::from_profile()?;
    let result = client.register_source(name, source_type, config).await?;
    Ok(result)
}

async fn datarep_scan(tool_input: &Value) -> Result<Value, String> {
    let sources = tool_input["sources"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect::<Vec<_>>()
        })
        .ok_or("Missing 'sources' parameter — pass an array of source names to scan")?;

    let client = DatarepClient::from_profile()?;
    let mut results = json!({});

    for source in &sources {
        let query = "Count the total number of messages and conversations, and find the earliest and latest message dates. Return as JSON with fields: message_count, conversation_count, earliest_date (ISO8601), latest_date (ISO8601).";

        match client.get_streaming(source, query).await {
            Ok(DatarepResponse::Success { result }) => {
                let parsed = if let Some(s) = result.as_str() {
                    s.lines()
                        .rev()
                        .find(|l| !l.trim().is_empty())
                        .and_then(|l| serde_json::from_str::<Value>(l).ok())
                        .unwrap_or_else(|| json!({"status": "found", "raw_output": s}))
                } else {
                    result.clone()
                };

                let mut entry = json!({"status": "found"});
                if let Some(obj) = parsed.as_object() {
                    for (k, v) in obj {
                        entry[k] = v.clone();
                    }
                }
                results[source] = entry;
            }
            Ok(DatarepResponse::Question {
                session_id,
                question,
            }) => {
                results[source] = json!({
                    "status": "question",
                    "session_id": session_id,
                    "question": question,
                });
            }
            Ok(DatarepResponse::ActionRequired {
                action_type,
                explanation,
                steps,
                deep_link,
                ..
            }) => {
                results[source] = json!({
                    "status": if action_type == "os_permission" { "permission_denied" } else { "action_required" },
                    "action_type": action_type,
                    "explanation": explanation,
                    "steps": steps,
                    "deep_link": deep_link,
                });
            }
            Err(e) => {
                results[source] = json!({
                    "status": "error",
                    "message": e,
                });
            }
        }
    }

    Ok(results)
}

async fn datarep_import(tool_input: &Value) -> Result<Value, String> {
    let source = tool_input["source"]
        .as_str()
        .ok_or("Missing 'source' parameter")?;
    let source_id = tool_input["source_id"].as_str();

    let date_from = tool_input["date_from"].as_str();
    let date_to = tool_input["date_to"].as_str();

    let client = DatarepClient::from_profile()?;

    let date_clause = match (date_from, date_to) {
        (Some(from), Some(to)) => format!(" between {} and {}", from, to),
        (Some(from), None) => format!(" since {}", from),
        (None, Some(to)) => format!(" up to {}", to),
        (None, None) => String::new(),
    };

    let query = format!(
        "Retrieve all messages{} from {}. Output as NDJSON (one JSON object per line).",
        date_clause, source
    );

    let response = client.get_streaming(source, &query).await?;

    match response {
        DatarepResponse::Question {
            session_id,
            question,
        } => Ok(json!({
            "status": "question",
            "session_id": session_id,
            "question": question,
        })),
        DatarepResponse::Success { result } => {
            // Recipe should have been created. Find it and stream the data.
            let recipes = client.list_recipes(Some(source)).await?;
            if let Some(recipe) = recipes.first() {
                do_stream_and_load(&client, &recipe.id, source, source_id).await
            } else {
                // No recipe found — the result might contain inline data (legacy path)
                let json_lines = if let Some(s) = result.as_str() {
                    s.to_string()
                } else {
                    result.to_string()
                };
                let data_dir = profiles::get_active_data_dir();
                let db_path = data_dir.join("thyself.db");
                let import_result =
                    crate::loader::load_messages_from_json(&db_path, &json_lines, source)?;
                ensure_sync_installed();
                Ok(json!({
                    "status": "ok",
                    "source": source,
                    "messages_loaded": import_result.messages,
                    "conversations": import_result.conversations,
                    "contacts": import_result.contacts,
                    "earliest": import_result.earliest,
                    "latest": import_result.latest,
                }))
            }
        }
        DatarepResponse::ActionRequired {
            action_type,
            explanation,
            steps,
            deep_link,
            ..
        } => Ok(json!({
            "status": "action_required",
            "action_type": action_type,
            "explanation": explanation,
            "steps": steps,
            "deep_link": deep_link,
        })),
    }
}

async fn datarep_reply(tool_input: &Value) -> Result<Value, String> {
    let session_id = tool_input["session_id"]
        .as_str()
        .ok_or("Missing 'session_id' parameter")?;
    let answer = tool_input["answer"]
        .as_str()
        .ok_or("Missing 'answer' parameter")?;

    let client = DatarepClient::from_profile()?;

    match client.reply(session_id, answer).await {
        Ok(DatarepResponse::Success { result }) => Ok(json!({
            "status": "success",
            "result": result,
        })),
        Ok(DatarepResponse::Question {
            session_id,
            question,
        }) => Ok(json!({
            "status": "question",
            "session_id": session_id,
            "question": question,
        })),
        Ok(DatarepResponse::ActionRequired {
            action_type,
            explanation,
            steps,
            deep_link,
            ..
        }) => Ok(json!({
            "status": "action_required",
            "action_type": action_type,
            "explanation": explanation,
            "steps": steps,
            "deep_link": deep_link,
        })),
        Err(e) if e.contains("not found") => Ok(json!({
            "status": "session_completed",
            "message": "The session completed on its own (the requested action was likely detected automatically). Proceed to re-scan or stream data.",
        })),
        Err(e) => Err(e),
    }
}

async fn datarep_stream(tool_input: &Value) -> Result<Value, String> {
    let source = tool_input["source"].as_str();
    let recipe_id = tool_input["recipe_id"].as_str();
    let source_id = tool_input["source_id"].as_str();

    let client = DatarepClient::from_profile()?;

    let rid = if let Some(rid) = recipe_id {
        rid.to_string()
    } else if let Some(src) = source {
        let recipes = client.list_recipes(Some(src)).await?;
        recipes
            .first()
            .map(|r| r.id.clone())
            .ok_or_else(|| format!("No recipes found for source '{}'", src))?
    } else {
        return Err("Missing 'source' or 'recipe_id' parameter".to_string());
    };

    let source_label = source.unwrap_or(&rid);
    do_stream_and_load(&client, &rid, source_label, source_id).await
}

async fn do_stream_and_load(
    client: &DatarepClient,
    recipe_id: &str,
    source: &str,
    profile_source_id: Option<&str>,
) -> Result<Value, String> {
    use futures::StreamExt;

    let source_key = match source {
        "whatsapp_desktop" | "whatsapp_backup" => "whatsapp",
        other => other,
    };

    let data_dir = profiles::get_active_data_dir();
    let db_path = data_dir.join("thyself.db");

    let count_before = rusqlite::Connection::open(&db_path)
        .ok()
        .and_then(|conn| source_message_count(&conn, source_key).ok())
        .unwrap_or(0);

    let run_id = start_sync_run(&db_path, source_key).ok();

    let resp = client.stream_data(recipe_id).await?;
    let mut stream = resp.bytes_stream();
    let mut line_buffer = String::new();
    let mut all_lines = Vec::new();
    let mut stream_summary: Option<Value> = None;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        line_buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline_pos) = line_buffer.find('\n') {
            let line = line_buffer[..newline_pos].trim().to_string();
            line_buffer = line_buffer[newline_pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            if let Ok(val) = serde_json::from_str::<Value>(&line) {
                if val.get("_stream_complete").is_some() {
                    stream_summary = Some(val);
                    continue;
                }
            }

            all_lines.push(line);
        }
    }

    // Process remaining data in buffer
    let remaining = line_buffer.trim();
    if !remaining.is_empty() {
        if let Ok(val) = serde_json::from_str::<Value>(remaining) {
            if val.get("_stream_complete").is_some() {
                stream_summary = Some(val);
            } else {
                all_lines.push(remaining.to_string());
            }
        } else {
            all_lines.push(remaining.to_string());
        }
    }

    let json_text = all_lines.join("\n");
    let import_result =
        crate::loader::load_messages_from_json(&db_path, &json_text, source)?;

    let count_after = rusqlite::Connection::open(&db_path)
        .ok()
        .and_then(|conn| source_message_count(&conn, source_key).ok())
        .unwrap_or(count_before);
    let messages_added = {
        let delta = count_after.saturating_sub(count_before);
        if delta > 0 { delta } else { import_result.messages }
    };

    let last_message_at = source_last_message_at_from_db(&db_path, source_key);

    if let Some(id) = run_id {
        let _ = finish_sync_run(
            &db_path,
            id,
            messages_added,
            last_message_at.clone(),
            None,
        );
    }

    // Create an alias sync_run for the profile source ID if it differs
    // from the datarep source key, so the UI can find it.
    let alias_key = if let Some(pid) = profile_source_id {
        if pid != source_key { Some(pid.to_string()) } else { None }
    } else if let Some(active_id) = profiles::get_active_profile_id() {
        // Heuristic: if source_key isn't in selected_sources, find the one
        // unmatched profile source and create a sync_run for it.
        profiles::read_profiles().ok().and_then(|ps| {
            let profile = ps.iter().find(|p| p.id == active_id)?;
            if profile.selected_sources.contains(&source_key.to_string()) {
                return None;
            }
            let conn = rusqlite::Connection::open(&db_path).ok()?;
            ensure_sync_runs_table(&conn).ok()?;
            let unmatched: Vec<&str> = profile.selected_sources.iter()
                .filter(|s| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM sync_runs WHERE source = ?1 AND status = 'completed'",
                        [s.as_str()],
                        |row| row.get::<_, i64>(0),
                    ).unwrap_or(0) == 0
                })
                .map(|s| s.as_str())
                .collect();
            if unmatched.len() == 1 {
                Some(unmatched[0].to_string())
            } else {
                None
            }
        })
    } else {
        None
    };

    if let Some(ref alias) = alias_key {
        let effective_added = if messages_added > 0 { messages_added } else { import_result.messages };
        if let Ok(alias_run_id) = start_sync_run(&db_path, alias) {
            let _ = finish_sync_run(&db_path, alias_run_id, effective_added, last_message_at.clone(), None);
        }
    }

    // Retry failed rows if any
    if let Some(ref summary) = stream_summary {
        let failed = summary["rows_failed"].as_i64().unwrap_or(0);
        if failed > 0 {
            if let Ok(Some(retry_resp)) = client.stream_data_retry(recipe_id).await {
                let mut retry_stream = retry_resp.bytes_stream();
                let mut retry_buf = String::new();
                let mut retry_lines = Vec::new();

                while let Some(chunk) = retry_stream.next().await {
                    if let Ok(chunk) = chunk {
                        retry_buf.push_str(&String::from_utf8_lossy(&chunk));
                        while let Some(pos) = retry_buf.find('\n') {
                            let line = retry_buf[..pos].trim().to_string();
                            retry_buf = retry_buf[pos + 1..].to_string();
                            if !line.is_empty() {
                                if let Ok(val) = serde_json::from_str::<Value>(&line) {
                                    if val.get("_stream_complete").is_none() {
                                        retry_lines.push(line);
                                    }
                                }
                            }
                        }
                    }
                }

                if !retry_lines.is_empty() {
                    let retry_text = retry_lines.join("\n");
                    let _ = crate::loader::load_messages_from_json(
                        &db_path,
                        &retry_text,
                        source,
                    );
                }
            }
        }
    }

    ensure_sync_installed();

    Ok(json!({
        "status": "ok",
        "source": source,
        "recipe_id": recipe_id,
        "messages_added": messages_added,
        "messages_loaded": import_result.messages,
        "conversations": import_result.conversations,
        "contacts": import_result.contacts,
        "earliest": import_result.earliest,
        "latest": import_result.latest,
        "last_message_at": last_message_at,
        "stream_summary": stream_summary,
    }))
}

fn source_last_message_at_from_db(db_path: &std::path::Path, source: &str) -> Option<String> {
    rusqlite::Connection::open(db_path)
        .ok()
        .and_then(|conn| source_last_message_at(&conn, source).ok().flatten())
}

async fn datarep_auth(tool_input: &Value) -> Result<Value, String> {
    let source = tool_input["source"]
        .as_str()
        .ok_or("Missing 'source' parameter")?;

    let client = DatarepClient::from_profile()?;

    if let Some(cred_data) = tool_input.get("credentials") {
        let cred_type = tool_input["cred_type"]
            .as_str()
            .unwrap_or("custom");
        client.store_credentials(source, cred_type, cred_data.clone()).await?;
        return Ok(json!({
            "status": "credentials_stored",
            "source": source,
        }));
    }

    let result = client.initiate_oauth(source).await?;
    Ok(json!({
        "status": "authenticated",
        "source": source,
        "details": result,
    }))
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
            "Opened System Settings → Full Disk Access. In dev mode, grant FDA to your terminal app (Terminal, Warp, iTerm) or IDE (Cursor) — not the Thyself binary. You may need to restart the terminal and re-run tauri dev afterward.".to_string()
        } else {
            "Opened System Settings → Privacy & Security → Full Disk Access. Thyself should appear in the list — toggle it ON.".to_string()
        },
    }))
}

fn open_url(tool_input: &Value) -> Result<Value, String> {
    let url = tool_input["url"]
        .as_str()
        .ok_or("Missing 'url' parameter")?;

    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| format!("Failed to open URL: {}", e))?;

    Ok(json!({
        "status": "opened",
        "url": url,
    }))
}

// ---------------------------------------------------------------------------
// Weekly sync schedule (launchd)
// ---------------------------------------------------------------------------

const PLIST_LABEL: &str = "com.thyself.weekly-sync";
const PLIST_NAME: &str = "com.thyself.weekly-sync.plist";

fn launch_agents_dir() -> PathBuf {
    home_dir().join("Library/LaunchAgents")
}

fn installed_plist_path() -> PathBuf {
    launch_agents_dir().join(PLIST_NAME)
}

fn generate_sync_plist(project_root: &std::path::Path) -> String {
    let sync_script = project_root.join("sync/run_sync.sh");
    let log_dir = home_dir()
        .join("Library/Application Support/Thyself/logs");

    let mut path_parts = Vec::new();
    let pyenv_shims = home_dir().join(".pyenv/shims");
    if pyenv_shims.exists() {
        path_parts.push(pyenv_shims.display().to_string());
    }
    path_parts.extend([
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ]);
    let path_str = path_parts.join(":");

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>{script}</string>
    </array>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>0</integer>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>{log_dir}/sync-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{log_dir}/sync-stderr.log</string>

    <key>WorkingDirectory</key>
    <string>{project_root}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{path}</string>
    </dict>
</dict>
</plist>
"#,
        label = PLIST_LABEL,
        script = sync_script.display(),
        log_dir = log_dir.display(),
        project_root = project_root.display(),
        path = path_str,
    )
}

fn do_install_weekly_sync() -> Result<Value, String> {
    let project_root = find_project_root()
        .ok_or("Could not find project root (config.py not found)")?;

    let sync_script = project_root.join("sync/run_sync.sh");
    if !sync_script.exists() {
        return Err(format!("Sync script not found: {}", sync_script.display()));
    }

    // Ensure run_sync.sh is executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&sync_script) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&sync_script, perms);
        }
    }

    let agents_dir = launch_agents_dir();
    std::fs::create_dir_all(&agents_dir)
        .map_err(|e| format!("Failed to create LaunchAgents dir: {}", e))?;

    let log_dir = home_dir()
        .join("Library/Application Support/Thyself/logs");
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create log dir: {}", e))?;

    let plist_content = generate_sync_plist(&project_root);
    let plist_path = installed_plist_path();

    // Unload existing job (ignore errors if not loaded)
    let _ = std::process::Command::new("launchctl")
        .args(["unload", &plist_path.display().to_string()])
        .output();

    std::fs::write(&plist_path, &plist_content)
        .map_err(|e| format!("Failed to write plist: {}", e))?;

    let load_result = std::process::Command::new("launchctl")
        .args(["load", &plist_path.display().to_string()])
        .output()
        .map_err(|e| format!("Failed to run launchctl load: {}", e))?;

    if !load_result.status.success() {
        let stderr = String::from_utf8_lossy(&load_result.stderr);
        return Err(format!("launchctl load failed: {}", stderr));
    }

    Ok(json!({
        "status": "installed",
        "schedule": "Every Sunday at 3:00 AM",
        "plist_path": plist_path.display().to_string(),
        "sync_script": sync_script.display().to_string(),
    }))
}

fn install_weekly_sync() -> Result<Value, String> {
    do_install_weekly_sync()
}

fn check_sync_schedule() -> Result<Value, String> {
    let plist_path = installed_plist_path();

    let result = std::process::Command::new("launchctl")
        .args(["list", PLIST_LABEL])
        .output()
        .map_err(|e| format!("Failed to run launchctl: {}", e))?;

    if result.status.success() {
        Ok(json!({
            "status": "installed",
            "loaded": true,
            "schedule": "Every Sunday at 3:00 AM",
            "plist_path": plist_path.display().to_string(),
        }))
    } else if plist_path.exists() {
        Ok(json!({
            "status": "installed",
            "loaded": false,
            "message": "Plist exists but is not loaded. May need to be reloaded.",
            "plist_path": plist_path.display().to_string(),
        }))
    } else {
        Ok(json!({
            "status": "not_installed",
            "message": "Weekly sync is not configured.",
        }))
    }
}

fn uninstall_weekly_sync() -> Result<Value, String> {
    let plist_path = installed_plist_path();

    if plist_path.exists() {
        let _ = std::process::Command::new("launchctl")
            .args(["unload", &plist_path.display().to_string()])
            .output();

        std::fs::remove_file(&plist_path)
            .map_err(|e| format!("Failed to remove plist: {}", e))?;

        Ok(json!({
            "status": "uninstalled",
        }))
    } else {
        Ok(json!({
            "status": "not_installed",
            "message": "Weekly sync was not configured.",
        }))
    }
}

/// Best-effort install of the weekly sync schedule. Called automatically
/// after a successful initial import so new users get recurring sync
/// without needing to run a separate command.
fn ensure_sync_installed() {
    match do_install_weekly_sync() {
        Ok(_) => eprintln!("[sync] Weekly sync schedule installed"),
        Err(e) => eprintln!("[sync] Could not install weekly sync schedule: {}", e),
    }
}

// ---------------------------------------------------------------------------
// Tool definitions for the onboarding agent
// ---------------------------------------------------------------------------

pub fn get_onboarding_tool_definitions() -> Vec<Value> {
    vec![
        // --- UI tools ---
        json!({
            "name": "add_data_source",
            "description": "Add a data source to the user's profile so it appears as a card in the UI. Call this for each source the user mentions when you ask where they communicate. The source_id should be a lowercase identifier (e.g. 'imessage', 'whatsapp', 'gmail', 'chatgpt', 'slack', 'discord', 'telegram'). The card will appear in the setup panel immediately.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "source_id": {
                        "type": "string",
                        "description": "Lowercase identifier for the source (e.g. 'imessage', 'whatsapp', 'gmail', 'slack')"
                    },
                    "display_name": {
                        "type": "string",
                        "description": "Optional human-readable name (e.g. 'iMessage', 'WhatsApp'). If omitted, derived from source_id."
                    }
                },
                "required": ["source_id"]
            }
        }),
        // --- data connection tools ---
        json!({
            "name": "check_datarep",
            "description": "Check if the data connector is running and ready. Returns status: 'ready' (running + registered), 'needs_registration' (running but not registered), or 'not_running'. The system will auto-start the connector if needed. Call this at the start of onboarding before any source operations.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "setup_datarep",
            "description": "Register Thyself with the data connector and save the API key. Call this when check_datarep returns 'needs_registration'.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "register_datarep_source",
            "description": "Register a data source by name. Paths and configuration are discovered automatically. Must be called before scanning or importing that source.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Source name (e.g. 'imessage', 'whatsapp', 'gmail', 'chatgpt', 'slack')"
                    },
                    "source_type": {
                        "type": "string",
                        "description": "Optional type hint: 'local_db', 'rest_api', 'local_files'. Omit for auto-detection."
                    },
                    "config": {
                        "type": "object",
                        "description": "Optional source-specific configuration. Usually not needed — paths are discovered automatically."
                    }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "datarep_scan",
            "description": "Scan registered data sources for message counts, conversation counts, and date ranges. Returns per-source stats. If a source requires OS permissions (e.g. Full Disk Access), returns status 'permission_denied' with guidance.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "sources": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Source names to scan (required)"
                    }
                },
                "required": ["sources"]
            }
        }),
        json!({
            "name": "datarep_import",
            "description": "Import messages from a data source. Retrieves the data and loads it into the database. Supports all source types. Use date_from/date_to to import in chunks for large datasets.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": "Source name (e.g. 'imessage', 'whatsapp_desktop', 'gmail', 'chatgpt')"
                    },
                    "source_id": {
                        "type": "string",
                        "description": "Profile source ID from add_data_source (e.g. 'email_cantab'). Pass this when the datarep source name differs from the profile source ID so the UI status updates correctly."
                    },
                    "date_from": {
                        "type": "string",
                        "description": "Optional ISO8601 start date for chunked imports"
                    },
                    "date_to": {
                        "type": "string",
                        "description": "Optional ISO8601 end date for chunked imports"
                    }
                },
                "required": ["source"]
            }
        }),
        json!({
            "name": "datarep_reply",
            "description": "Continue a data connection session by replying to a question. When datarep_scan, datarep_import, or a previous datarep_reply returns status 'question', relay the question to the user. When the user answers, call this tool with the session_id and their answer. Returns the next response: 'success' (done), 'question' (another question), 'action_required' (needs user action), or 'session_completed' (the action was already detected automatically — proceed to re-scan or stream).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": "Session ID from the question response"
                    },
                    "answer": {
                        "type": "string",
                        "description": "The user's answer to relay"
                    }
                },
                "required": ["session_id", "answer"]
            }
        }),
        json!({
            "name": "datarep_stream",
            "description": "Stream data from a completed retrieval into the database. Call this after datarep_import or datarep_reply returns 'success' to load the retrieved data. Provide either 'source' (to find and use the latest recipe for that source) or 'recipe_id' (to stream a specific recipe). Always pass source_id when the datarep source name differs from the profile source ID.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": "Source name — finds the latest recipe for this source"
                    },
                    "recipe_id": {
                        "type": "string",
                        "description": "Specific recipe ID to stream"
                    },
                    "source_id": {
                        "type": "string",
                        "description": "Profile source ID from add_data_source (e.g. 'email_cantab'). Pass this when the datarep source name differs from the profile source ID so the UI status updates correctly."
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "datarep_auth",
            "description": "Initiate authentication for a data source. For OAuth sources (Gmail), this opens the browser for sign-in. For API key sources, pass credentials in the 'credentials' field. Call register_datarep_source first.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": "Source name to authenticate"
                    },
                    "cred_type": {
                        "type": "string",
                        "description": "Credential type: 'oauth2', 'api_key', 'custom'"
                    },
                    "credentials": {
                        "type": "object",
                        "description": "Optional credentials data to store (for non-OAuth flows)"
                    }
                },
                "required": ["source"]
            }
        }),
        json!({
            "name": "open_full_disk_access",
            "description": "Opens macOS System Settings directly to the Full Disk Access page. Call this when datarep_scan returns 'permission_denied' for any source. After calling this, tell the user to toggle Thyself ON in the list, then re-call datarep_scan to verify.",
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
            "name": "open_url",
            "description": "Open a URL in the user's default browser. Use for opening settings pages, documentation, or any web URL the user needs to visit.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to open in the browser"
                    }
                },
                "required": ["url"]
            }
        }),
        json!({
            "name": "start_portrait_build",
            "description": "Start building the user's life portrait from their connected data. Runs extraction and synthesis in the background. Only call this after presenting data stats and cost/time estimates and getting the user's explicit confirmation to proceed.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "install_weekly_sync",
            "description": "Install the automated weekly sync schedule. Sets up a macOS launchd job that runs every Sunday at 3 AM to sync all connected data sources. This is installed automatically after the first successful import, but you can call it explicitly to reinstall or verify. Returns the schedule details and file paths.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "check_sync_schedule",
            "description": "Check whether the automated weekly sync is installed and running. Returns status: 'installed' (with loaded=true/false) or 'not_installed'.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "uninstall_weekly_sync",
            "description": "Remove the automated weekly sync schedule. Unloads and deletes the launchd job. Only call this if the user explicitly asks to disable automatic syncing.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
    ]
}
