use crate::claude::{stream_chat_request, StreamEvent};
use crate::db::{get_data_dir, DbState};
use crate::onboarding_tools;
use crate::profiles;
use crate::sessions;
use crate::tools::{execute_tool, get_tool_definitions};
use serde_json::{json, Value};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn query_db(
    state: State<'_, DbState>,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<Value, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref()
        .ok_or_else(|| "No database available. Please complete onboarding first.".to_string())?;
    let params = params.unwrap_or_default();
    crate::db::query_rows(conn, &sql, &params)
}

#[tauri::command]
pub async fn write_db(
    state: State<'_, DbState>,
    sql: String,
    params: Option<Vec<String>>,
) -> Result<Value, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref()
        .ok_or_else(|| "No database available. Please complete onboarding first.".to_string())?;
    let params = params.unwrap_or_default();
    conn.execute(
        &sql,
        rusqlite::params_from_iter(params.iter()),
    )
    .map_err(|e| format!("Write error: {}", e))?;
    Ok(json!({"status": "ok"}))
}

// --- Profile commands ---

#[tauri::command]
pub async fn list_profiles() -> Result<Value, String> {
    // #region agent log
    {
        use std::io::Write;
        let path = "/Users/jfru/thyself/.cursor/debug-2ee486.log";
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, r#"{{"sessionId":"2ee486","location":"commands.rs:list_profiles","message":"called","data":{{}},"timestamp":{}}}"#, ts);
        }
    }
    // #endregion
    let profiles = profiles::read_profiles()?;
    let active_id = profiles::get_active_profile_id();
    Ok(json!({
        "profiles": profiles,
        "activeProfileId": active_id,
    }))
}

#[tauri::command]
pub async fn cmd_create_profile(
    state: State<'_, DbState>,
    name: String,
    api_key: String,
    subject_name: String,
    email: Option<String>,
    selected_sources: Vec<String>,
) -> Result<Value, String> {
    let profile = profiles::create_profile(name, api_key, subject_name, email, selected_sources)?;

    // Open the new profile's database
    let new_conn = crate::db::open_db_for_profile(&profile.data_dir)?;
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    *guard = Some(new_conn);

    Ok(serde_json::to_value(&profile).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn cmd_switch_profile(
    state: State<'_, DbState>,
    profile_id: String,
) -> Result<Value, String> {
    let profile = profiles::switch_profile(&profile_id)?;

    let new_conn = crate::db::open_db_for_profile(&profile.data_dir)?;
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    *guard = Some(new_conn);

    Ok(serde_json::to_value(&profile).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_active_profile() -> Result<Value, String> {
    let active_id = profiles::get_active_profile_id();
    if let Some(id) = active_id {
        let profiles = profiles::read_profiles()?;
        if let Some(profile) = profiles.iter().find(|p| p.id == id) {
            return Ok(serde_json::to_value(profile).map_err(|e| e.to_string())?);
        }
    }
    Ok(Value::Null)
}

#[tauri::command]
pub async fn cmd_delete_profile(
    state: State<'_, DbState>,
    profile_id: String,
) -> Result<Value, String> {
    let next_profile = profiles::delete_profile(&profile_id)?;

    if let Some(ref p) = next_profile {
        let new_conn = crate::db::open_db_for_profile(&p.data_dir)?;
        let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
        *guard = Some(new_conn);
    } else {
        let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    Ok(json!({
        "nextProfile": next_profile.map(|p| serde_json::to_value(&p).unwrap_or(Value::Null)),
    }))
}

#[tauri::command]
pub async fn cmd_update_profile(
    profile_id: String,
    onboarding_status: Option<String>,
    selected_sources: Option<Vec<String>>,
    api_key: Option<String>,
    subject_name: Option<String>,
    email: Option<String>,
) -> Result<Value, String> {
    let profile = profiles::update_profile(
        &profile_id,
        onboarding_status,
        selected_sources,
        api_key,
        subject_name,
        email,
    )?;
    Ok(serde_json::to_value(&profile).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_subject_name() -> Result<String, String> {
    Ok(profiles::get_active_subject_name())
}

#[tauri::command]
pub async fn validate_api_key(api_key: String) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "hi"}]
        }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status().as_u16();
    if status == 200 || status == 201 {
        Ok(json!({"valid": true}))
    } else if status == 401 {
        Ok(json!({"valid": false, "error": "Invalid API key"}))
    } else {
        let body = resp.text().await.unwrap_or_default();
        Ok(json!({"valid": false, "error": format!("Unexpected response ({}): {}", status, body)}))
    }
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    let full_path = get_data_dir().join(&path);
    fs::read_to_string(&full_path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<Value, String> {
    let full_path = get_data_dir().join(&path);
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    fs::write(&full_path, &content)
        .map_err(|e| format!("Failed to write {}: {}", path, e))?;
    Ok(json!({"status": "ok", "path": full_path.display().to_string()}))
}

#[tauri::command]
pub async fn list_files(dir: String, pattern: Option<String>) -> Result<Vec<String>, String> {
    let search_dir = get_data_dir().join(&dir);
    if !search_dir.exists() {
        return Ok(vec![]);
    }

    let pat = pattern.unwrap_or_else(|| "*".to_string());
    let glob_pattern = search_dir.join(&pat);
    let mut files: Vec<String> = Vec::new();

    if let Ok(entries) = glob::glob(glob_pattern.to_str().unwrap_or("")) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name() {
                files.push(name.to_string_lossy().to_string());
            }
        }
    }

    files.sort();
    Ok(files)
}

#[tauri::command]
pub async fn create_session() -> Result<Value, String> {
    let session = sessions::create_session()?;
    Ok(serde_json::to_value(&session).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn list_sessions() -> Result<Value, String> {
    let manifest = sessions::read_manifest()?;
    let summary: Vec<Value> = manifest
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "name": s.name,
                "createdAt": s.created_at,
                "status": s.status,
                "summaryFile": s.summary_file,
            })
        })
        .collect();
    Ok(json!(summary))
}

#[tauri::command]
pub async fn load_session(session_id: String) -> Result<Value, String> {
    let manifest = sessions::read_manifest()?;
    let session = manifest
        .iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let summary = if let Some(ref file) = session.summary_file {
        let path = get_data_dir().join("sessions").join(file);
        fs::read_to_string(&path).ok()
    } else {
        None
    };

    Ok(json!({
        "session": session,
        "summary": summary,
    }))
}

#[tauri::command]
pub async fn save_session_messages(session_id: String, messages: Value) -> Result<Value, String> {
    sessions::save_messages(&session_id, &messages)?;
    Ok(json!({"status": "ok"}))
}

/// Runs the full chat loop (streaming + tool use rounds) with a generic emitter.
/// Used by both the Tauri command and the dev HTTP server.
pub async fn run_chat_loop(
    emit_fn: &(dyn Fn(&str, &str, &Value) + Send + Sync),
    db: &DbState,
    messages: Vec<Value>,
    system_prompt: String,
    tools: Vec<Value>,
    stream_id: String,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<Value, String> {
    let api_key = profiles::get_active_api_key()
        .ok_or_else(|| "No API key configured. Please complete onboarding.".to_string())?;

    let mut tool_defs = if tools.is_empty() {
        get_tool_definitions()
    } else {
        tools
    };

    tool_defs.push(json!({
        "type": "web_search_20250305",
        "name": "web_search",
        "max_uses": 5
    }));

    let mut conversation = messages;
    let final_response;

    const EPISTEMIC_REMINDER: &str = "\n\n[Reminder: Present interpretations as hypotheses, not conclusions. Verify historical claims against data. Ask before narrating the user's experience. Distinguish therapeutic frameworks from established fact.]";

    loop {
        if let Some(ref flag) = cancel {
            if flag.load(Ordering::Relaxed) {
                emit_fn(&stream_id, "message_stop", &json!({}));
                return Err("Cancelled by user".to_string());
            }
        }

        let response = stream_chat_request(
            emit_fn,
            &api_key,
            conversation.clone(),
            &system_prompt,
            tool_defs.clone(),
            &stream_id,
        )
        .await?;

        let stop_reason = response["stop_reason"].as_str().unwrap_or("end_turn");

        if stop_reason == "pause_turn" {
            let content = response["content"].as_array().cloned().unwrap_or_default();
            let content_without_thinking: Vec<Value> = content
                .iter()
                .filter(|block| block["type"].as_str() != Some("thinking"))
                .cloned()
                .collect();
            conversation.push(json!({
                "role": "assistant",
                "content": content_without_thinking
            }));
            continue;
        }

        if stop_reason == "tool_use" {
            let content = response["content"].as_array().cloned().unwrap_or_default();

            let content_without_thinking: Vec<Value> = content
                .iter()
                .filter(|block| block["type"].as_str() != Some("thinking"))
                .cloned()
                .collect();

            conversation.push(json!({
                "role": "assistant",
                "content": content_without_thinking
            }));

            let mut tool_results: Vec<Value> = Vec::new();
            for block in &content {
                let block_type = block["type"].as_str().unwrap_or("");
                if block_type == "tool_use" {
                    let tool_name = block["name"].as_str().unwrap_or("");
                    let tool_id = block["id"].as_str().unwrap_or("");
                    let tool_input = &block["input"];

                    let result = {
                        let guard = db.conn.lock().map_err(|e| e.to_string())?;
                        match guard.as_ref() {
                            Some(conn) => execute_tool(conn, tool_name, tool_input),
                            None => Err("No database available".to_string()),
                        }
                    };

                    // Fall through to onboarding tools if base tool not found
                    let result = match &result {
                        Err(e)
                            if e.starts_with("Unknown tool:")
                                || e == "No database available" =>
                        {
                            match onboarding_tools::execute_onboarding_tool(
                                tool_name, tool_input,
                            )
                            .await
                            {
                                Ok(val) => Ok(val),
                                Err(e2) if e2.starts_with("Unknown onboarding tool:") => {
                                    result
                                }
                                Err(e2) => Err(e2),
                            }
                        }
                        _ => result,
                    };

                    let (content_val, is_error) = match result {
                        Ok(val) => {
                            let text = serde_json::to_string_pretty(&val).unwrap_or_default();
                            let truncated = if text.len() > 50000 {
                                format!("{}...\n[truncated — {} total chars]", &text[..50000], text.len())
                            } else {
                                text
                            };
                            (format!("{}{}", truncated, EPISTEMIC_REMINDER), false)
                        }
                        Err(e) => (format!("{}{}", e, EPISTEMIC_REMINDER), true),
                    };

                    emit_fn(
                        &stream_id,
                        "tool_result",
                        &json!({
                            "tool_use_id": tool_id,
                            "tool_name": tool_name,
                            "content": content_val,
                            "is_error": is_error
                        }),
                    );

                    tool_results.push(json!({
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": content_val,
                        "is_error": is_error
                    }));
                }
            }

            if !tool_results.is_empty() {
                conversation.push(json!({
                    "role": "user",
                    "content": tool_results
                }));
            }
        } else {
            final_response = response;
            break;
        }
    }

    emit_fn(&stream_id, "message_stop", &json!({}));
    Ok(final_response)
}

#[tauri::command]
pub async fn stream_chat(
    app: AppHandle,
    state: State<'_, DbState>,
    messages: Vec<Value>,
    system_prompt: String,
    tools: Vec<Value>,
    stream_id: String,
) -> Result<Value, String> {
    let emit_fn = move |sid: &str, etype: &str, data: &Value| {
        let event = StreamEvent {
            event_type: etype.to_string(),
            data: data.clone(),
        };
        let _ = app.emit(&format!("stream-event-{}", sid), event);
    };

    run_chat_loop(&emit_fn, &state, messages, system_prompt, tools, stream_id, None).await
}

#[tauri::command]
pub async fn get_data_dir_path() -> Result<String, String> {
    Ok(get_data_dir().display().to_string())
}

#[tauri::command]
pub async fn get_tool_defs() -> Result<Vec<Value>, String> {
    Ok(get_tool_definitions())
}

#[tauri::command]
pub async fn get_sync_status(state: State<'_, DbState>) -> Result<Value, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = match guard.as_ref() {
        Some(c) => c,
        None => return Ok(json!({
            "latest_by_source": {},
            "history": [],
            "has_sync_runs": false
        })),
    };

    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sync_runs'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if !table_exists {
        return Ok(json!({
            "latest_by_source": {},
            "history": [],
            "has_sync_runs": false
        }));
    }

    let mut latest_stmt = conn
        .prepare(
            "SELECT source, started_at, finished_at, messages_added, status, error_message, last_message_at
             FROM sync_runs
             WHERE id IN (SELECT MAX(id) FROM sync_runs GROUP BY source)
             ORDER BY source",
        )
        .map_err(|e| format!("SQL error: {}", e))?;

    let latest_rows: Vec<Value> = latest_stmt
        .query_map([], |row| {
            Ok(json!({
                "source": row.get::<_, String>(0)?,
                "started_at": row.get::<_, Option<String>>(1)?,
                "finished_at": row.get::<_, Option<String>>(2)?,
                "messages_added": row.get::<_, i64>(3)?,
                "status": row.get::<_, String>(4)?,
                "error_message": row.get::<_, Option<String>>(5)?,
                "last_message_at": row.get::<_, Option<String>>(6)?,
            }))
        })
        .map_err(|e| format!("Query error: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let mut latest_map = serde_json::Map::new();
    for row in &latest_rows {
        if let Some(source) = row["source"].as_str() {
            latest_map.insert(source.to_string(), row.clone());
        }
    }

    let mut history_stmt = conn
        .prepare(
            "SELECT id, source, started_at, finished_at, messages_added, status, error_message, last_message_at
             FROM sync_runs
             ORDER BY id DESC
             LIMIT 100",
        )
        .map_err(|e| format!("SQL error: {}", e))?;

    let history: Vec<Value> = history_stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "source": row.get::<_, String>(1)?,
                "started_at": row.get::<_, Option<String>>(2)?,
                "finished_at": row.get::<_, Option<String>>(3)?,
                "messages_added": row.get::<_, i64>(4)?,
                "status": row.get::<_, String>(5)?,
                "error_message": row.get::<_, Option<String>>(6)?,
                "last_message_at": row.get::<_, Option<String>>(7)?,
            }))
        })
        .map_err(|e| format!("Query error: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(json!({
        "latest_by_source": Value::Object(latest_map),
        "history": history,
        "has_sync_runs": true
    }))
}

#[tauri::command]
pub fn cmd_perform_restart() {
    onboarding_tools::perform_restart();
}

// #region agent log
#[tauri::command]
pub async fn cmd_debug_log(location: String, message: String, data: String) -> Result<(), String> {
    use std::io::Write;
    let path = "/Users/jfru/thyself/.cursor/debug-2ee486.log";
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, r#"{{"sessionId":"2ee486","location":"{}","message":"{}","data":{},"timestamp":{}}}"#, location, message, data, ts);
    }
    Ok(())
}
// #endregion
