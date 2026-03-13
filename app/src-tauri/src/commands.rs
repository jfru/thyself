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
    crate::db::cleanup_stale_sync_runs(&new_conn);
    crate::db::cleanup_stale_portrait_runs(&new_conn);
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
pub async fn cmd_remove_data_source(
    state: State<'_, DbState>,
    profile_id: String,
    source_id: String,
) -> Result<Value, String> {
    let mut profiles_list = profiles::read_profiles()?;
    let profile = profiles_list
        .iter_mut()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;

    if !profile.selected_sources.iter().any(|s| s == &source_id) {
        return Ok(json!({
            "status": "ok",
            "sourceId": source_id,
            "deleted": {
                "messages": 0,
                "conversations": 0,
                "gmail_messages": 0,
                "chatgpt_messages": 0,
                "chatgpt_conversations": 0,
                "sync_runs": 0
            },
            "selectedSources": profile.selected_sources
        }));
    }

    match source_id.as_str() {
        "imessage" => onboarding_tools::kill_sync_for_source("imessage"),
        "whatsapp" => onboarding_tools::kill_syncs_for_sources(&["whatsapp_desktop", "whatsapp_web"]),
        "gmail" => onboarding_tools::kill_sync_for_source("gmail"),
        "chatgpt" => onboarding_tools::kill_sync_for_source("chatgpt"),
        _ => {}
    }

    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "No database available. Please complete onboarding first.".to_string())?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    let mut deleted_messages = 0usize;
    let mut deleted_conversations = 0usize;
    let mut deleted_gmail = 0usize;
    let mut deleted_chatgpt_messages = 0usize;
    let mut deleted_chatgpt_conversations = 0usize;
    let mut deleted_sync_runs = 0usize;

    match source_id.as_str() {
        "imessage" => {
            deleted_messages = tx
                .execute("DELETE FROM messages WHERE source = 'imessage'", [])
                .map_err(|e| format!("Failed deleting iMessage messages: {}", e))?;
            deleted_conversations = tx
                .execute("DELETE FROM conversations WHERE source = 'imessage'", [])
                .map_err(|e| format!("Failed deleting iMessage conversations: {}", e))?;
            deleted_sync_runs = tx
                .execute("DELETE FROM sync_runs WHERE source = 'imessage'", [])
                .map_err(|e| format!("Failed deleting iMessage sync runs: {}", e))?;
        }
        "whatsapp" => {
            deleted_messages = tx
                .execute("DELETE FROM messages WHERE source = 'whatsapp'", [])
                .map_err(|e| format!("Failed deleting WhatsApp messages: {}", e))?;
            deleted_conversations = tx
                .execute("DELETE FROM conversations WHERE source = 'whatsapp'", [])
                .map_err(|e| format!("Failed deleting WhatsApp conversations: {}", e))?;
            deleted_sync_runs = tx
                .execute(
                    "DELETE FROM sync_runs WHERE source IN ('whatsapp_desktop', 'whatsapp_web')",
                    [],
                )
                .map_err(|e| format!("Failed deleting WhatsApp sync runs: {}", e))?;
        }
        "gmail" => {
            deleted_gmail = tx
                .execute("DELETE FROM gmail_messages", [])
                .map_err(|e| format!("Failed deleting Gmail messages: {}", e))?;
            deleted_sync_runs = tx
                .execute("DELETE FROM sync_runs WHERE source = 'gmail'", [])
                .map_err(|e| format!("Failed deleting Gmail sync runs: {}", e))?;
        }
        "chatgpt" => {
            deleted_chatgpt_messages = tx
                .execute("DELETE FROM chatgpt_messages", [])
                .map_err(|e| format!("Failed deleting ChatGPT messages: {}", e))?;
            deleted_chatgpt_conversations = tx
                .execute("DELETE FROM chatgpt_conversations", [])
                .map_err(|e| format!("Failed deleting ChatGPT conversations: {}", e))?;
            deleted_sync_runs = tx
                .execute("DELETE FROM sync_runs WHERE source = 'chatgpt'", [])
                .map_err(|e| format!("Failed deleting ChatGPT sync runs: {}", e))?;
        }
        _ => return Err(format!("Unsupported source_id: {}", source_id)),
    }

    // Clean up dependent rows after conversation deletions.
    tx.execute(
        "DELETE FROM conversation_participants
         WHERE conversation_id NOT IN (SELECT id FROM conversations)",
        [],
    )
    .map_err(|e| format!("Failed cleaning conversation_participants: {}", e))?;

    tx.execute(
        "DELETE FROM messages
         WHERE conversation_id IS NOT NULL
           AND conversation_id NOT IN (SELECT id FROM conversations)",
        [],
    )
    .map_err(|e| format!("Failed cleaning dangling messages: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed committing data source removal: {}", e))?;

    let next_sources: Vec<String> = profile
        .selected_sources
        .iter()
        .filter(|s| *s != &source_id)
        .cloned()
        .collect();
    let updated_profile = profiles::update_profile(
        &profile_id,
        None,
        Some(next_sources.clone()),
        None,
        None,
        None,
    )?;

    Ok(json!({
        "status": "ok",
        "sourceId": source_id,
        "deleted": {
            "messages": deleted_messages,
            "conversations": deleted_conversations,
            "gmail_messages": deleted_gmail,
            "chatgpt_messages": deleted_chatgpt_messages,
            "chatgpt_conversations": deleted_chatgpt_conversations,
            "sync_runs": deleted_sync_runs
        },
        "selectedSources": next_sources,
        "profile": updated_profile
    }))
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
pub async fn create_session(name: Option<String>, kind: Option<String>) -> Result<Value, String> {
    let session = sessions::create_session(name.as_deref(), kind.as_deref())?;
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
                "kind": s.kind,
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
    let mut last_round_had_tools = false;
    let mut nudged_for_summary = false;

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
            last_round_had_tools = false;
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

            last_round_had_tools = true;
        } else {
            // Check if Claude ended after tool execution without producing any text.
            // This happens when Claude asks a question AND calls tools in the same
            // response — after the tools complete, it may end_turn with no text,
            // leaving the user seeing orphaned tool calls with no follow-up.
            let has_text = response["content"]
                .as_array()
                .map(|blocks| {
                    blocks.iter().any(|b| {
                        b["type"].as_str() == Some("text")
                            && !b["text"]
                                .as_str()
                                .unwrap_or("")
                                .trim()
                                .is_empty()
                    })
                })
                .unwrap_or(false);

            if last_round_had_tools && !has_text && !nudged_for_summary {
                nudged_for_summary = true;

                let content = response["content"].as_array().cloned().unwrap_or_default();
                let content_without_thinking: Vec<Value> = content
                    .iter()
                    .filter(|block| block["type"].as_str() != Some("thinking"))
                    .cloned()
                    .collect();

                if content_without_thinking.is_empty() {
                    // No visible content — append nudge to the last user message
                    // (the tool_results) to avoid consecutive same-role messages.
                    if let Some(last_msg) = conversation.last_mut() {
                        if let Some(arr) = last_msg.get_mut("content").and_then(|c| c.as_array_mut()) {
                            arr.push(json!({
                                "type": "text",
                                "text": "[System: You executed tool calls but produced no text about the results. Please share what you found, then continue the conversation naturally.]"
                            }));
                        }
                    }
                } else {
                    conversation.push(json!({
                        "role": "assistant",
                        "content": content_without_thinking
                    }));
                    conversation.push(json!({
                        "role": "user",
                        "content": "[System: You executed tool calls but produced no text about the results. Please share what you found, then continue the conversation naturally.]"
                    }));
                }

                last_round_had_tools = false;
                continue;
            }

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

    let has_progress_cols: bool = conn
        .prepare("PRAGMA table_info(sync_runs)")
        .ok()
        .and_then(|mut stmt| {
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .ok()?;
            let cols: Vec<String> = rows.filter_map(Result::ok).collect();
            Some(
                cols.iter().any(|c| c == "progress_processed")
                    && cols.iter().any(|c| c == "progress_total"),
            )
        })
        .unwrap_or(false);

    let latest_sql = if has_progress_cols {
        "SELECT source, started_at, finished_at, messages_added, status, error_message, last_message_at, progress_processed, progress_total
         FROM sync_runs
         WHERE id IN (SELECT MAX(id) FROM sync_runs GROUP BY source)
         ORDER BY source"
    } else {
        "SELECT source, started_at, finished_at, messages_added, status, error_message, last_message_at, NULL AS progress_processed, NULL AS progress_total
         FROM sync_runs
         WHERE id IN (SELECT MAX(id) FROM sync_runs GROUP BY source)
         ORDER BY source"
    };

    let mut latest_stmt = conn
        .prepare(latest_sql)
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
                "progress_processed": row.get::<_, Option<i64>>(7)?,
                "progress_total": row.get::<_, Option<i64>>(8)?,
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

    let history_sql = if has_progress_cols {
        "SELECT id, source, started_at, finished_at, messages_added, status, error_message, last_message_at, progress_processed, progress_total
         FROM sync_runs
         ORDER BY id DESC
         LIMIT 100"
    } else {
        "SELECT id, source, started_at, finished_at, messages_added, status, error_message, last_message_at, NULL AS progress_processed, NULL AS progress_total
         FROM sync_runs
         ORDER BY id DESC
         LIMIT 100"
    };

    let mut history_stmt = conn
        .prepare(history_sql)
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
                "progress_processed": row.get::<_, Option<i64>>(8)?,
                "progress_total": row.get::<_, Option<i64>>(9)?,
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

#[tauri::command]
pub fn cmd_open_icloud_settings() {
    onboarding_tools::perform_open_icloud_settings();
}

#[tauri::command]
pub fn cmd_open_finder_iphone() {
    onboarding_tools::perform_open_finder_iphone();
}

fn read_image_file(path: &str) -> Result<Value, String> {
    use base64::Engine;

    let data = fs::read(path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);

    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let media_type = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err(format!("Unsupported image type: {}", ext)),
    };

    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string();

    Ok(json!({
        "data": b64,
        "mediaType": media_type,
        "name": name,
    }))
}

#[tauri::command]
pub async fn pick_and_read_images() -> Result<Value, String> {
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(
            r#"set theFiles to choose file of type {"public.image"} with multiple selections allowed
set paths to ""
repeat with f in theFiles
    set paths to paths & (POSIX path of f) & linefeed
end repeat
return paths"#,
        )
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Ok(json!([]));
        }
        return Err(format!("File picker failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<&str> = stdout
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    let mut images = Vec::new();
    for path in paths {
        match read_image_file(path) {
            Ok(img) => images.push(img),
            Err(e) => eprintln!("Skipping {}: {}", path, e),
        }
    }

    Ok(Value::Array(images))
}

#[tauri::command]
pub async fn pick_files() -> Result<Value, String> {
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(
            r#"set theFiles to choose file with multiple selections allowed
set paths to ""
repeat with f in theFiles
    set paths to paths & (POSIX path of f) & linefeed
end repeat
return paths"#,
        )
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Ok(json!({ "images": [], "files": [] }));
        }
        return Err(format!("File picker failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    read_dropped_files(paths).await
}

#[tauri::command]
pub async fn pick_folder() -> Result<Value, String> {
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(r#"set theFolder to choose folder
return POSIX path of theFolder"#)
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") || stderr.contains("-128") {
            return Ok(json!({ "images": [], "files": [] }));
        }
        return Err(format!("Folder picker failed: {}", stderr));
    }

    let dir_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if dir_path.is_empty() {
        return Ok(json!({ "images": [], "files": [] }));
    }

    let name = std::path::Path::new(&dir_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&dir_path)
        .to_string();

    Ok(json!({
        "images": [],
        "files": [{ "type": "folder", "path": dir_path, "name": name }]
    }))
}

#[tauri::command]
pub async fn read_dropped_files(paths: Vec<String>) -> Result<Value, String> {
    let image_exts: std::collections::HashSet<&str> =
        ["jpg", "jpeg", "png", "gif", "webp"].iter().copied().collect();

    let mut images = Vec::new();
    let mut files = Vec::new();

    for path_str in &paths {
        let path = std::path::Path::new(path_str);
        if path.is_dir() {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(path_str)
                .to_string();
            files.push(json!({ "type": "folder", "path": path_str, "name": name }));
        } else if path.is_file() {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if image_exts.contains(ext.as_str()) {
                match read_image_file(path_str) {
                    Ok(img) => images.push(img),
                    Err(e) => eprintln!("Skipping image {}: {}", path_str, e),
                }
            } else {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(path_str)
                    .to_string();
                files.push(json!({ "type": "file", "path": path_str, "name": name }));
            }
        }
    }

    Ok(json!({ "images": images, "files": files }))
}

// ---------------------------------------------------------------------------
// Portrait build commands
// ---------------------------------------------------------------------------

static RUNNING_PORTRAIT: std::sync::LazyLock<std::sync::Mutex<Option<u32>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

fn ensure_portrait_runs_table(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS portrait_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            status TEXT NOT NULL DEFAULT 'running',
            phase TEXT NOT NULL DEFAULT 'preparing',
            total_batches INTEGER,
            completed_batches INTEGER DEFAULT 0,
            synthesis_batches INTEGER,
            synthesis_completed INTEGER DEFAULT 0,
            error_message TEXT,
            started_at DATETIME NOT NULL,
            updated_at DATETIME,
            finished_at DATETIME,
            extraction_months_covered TEXT,
            results_summary TEXT
        )"
    ).map_err(|e| format!("Failed to create portrait_runs table: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn start_portrait_build() -> Result<Value, String> {
    let data_dir = profiles::get_active_data_dir();
    let db_path = data_dir.join("thyself.db");

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("Failed to open DB: {}", e))?;
    ensure_portrait_runs_table(&conn)?;

    // Cancel any stale running portrait builds
    conn.execute(
        "UPDATE portrait_runs SET status = 'failed', error_message = 'Superseded by new build', finished_at = datetime('now') WHERE status = 'running'",
        [],
    ).map_err(|e| format!("Failed to supersede existing runs: {}", e))?;

    conn.execute(
        "INSERT INTO portrait_runs (status, phase, started_at) VALUES ('running', 'preparing', datetime('now'))",
        [],
    ).map_err(|e| format!("Failed to create portrait run: {}", e))?;
    let run_id = conn.last_insert_rowid();
    drop(conn);

    let project_root = onboarding_tools::find_project_root_pub()
        .ok_or("Could not find project root (config.py not found)")?;

    let api_key = profiles::get_active_api_key()
        .ok_or_else(|| "No API key configured".to_string())?;
    let subject_name = profiles::get_active_subject_name();

    let mut cmd = tokio::process::Command::new("python3");
    cmd.arg("-u")
        .arg("-m")
        .arg("extraction.portrait_build")
        .arg("--run-id")
        .arg(run_id.to_string())
        .arg("--db-path")
        .arg(db_path.display().to_string())
        .env("THYSELF_DATA_DIR", data_dir.display().to_string())
        .env("ANTHROPIC_API_KEY", &api_key)
        .env("THYSELF_SUBJECT_NAME", &subject_name)
        .current_dir(&project_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn portrait build: {}", e))?;

    if let Some(pid) = child.id() {
        *RUNNING_PORTRAIT.lock().unwrap() = Some(pid);
    }

    let db_for_monitor = db_path.clone();
    let run_id_for_monitor = run_id;
    tokio::spawn(async move {
        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();

        let stdout_task = tokio::spawn(async move {
            if let Some(pipe) = stdout_pipe {
                let mut out = String::new();
                let mut reader = tokio::io::BufReader::new(pipe);
                let mut buf = String::new();
                use tokio::io::AsyncBufReadExt;
                while reader.read_line(&mut buf).await.unwrap_or(0) > 0 {
                    out.push_str(&buf);
                    buf.clear();
                }
                out
            } else {
                String::new()
            }
        });

        let stderr_task = tokio::spawn(async move {
            if let Some(pipe) = stderr_pipe {
                let mut err = String::new();
                let mut reader = tokio::io::BufReader::new(pipe);
                let mut buf = String::new();
                use tokio::io::AsyncBufReadExt;
                while reader.read_line(&mut buf).await.unwrap_or(0) > 0 {
                    err.push_str(&buf);
                    buf.clear();
                }
                err
            } else {
                String::new()
            }
        });

        let status = child.wait().await;
        *RUNNING_PORTRAIT.lock().unwrap() = None;

        let _stdout = stdout_task.await.unwrap_or_default();
        let stderr = stderr_task.await.unwrap_or_default();

        if let Ok(exit) = status {
            if !exit.success() {
                if let Ok(conn) = rusqlite::Connection::open(&db_for_monitor) {
                    let current_status: Option<String> = conn
                        .query_row(
                            "SELECT status FROM portrait_runs WHERE id = ?1",
                            [run_id_for_monitor],
                            |row| row.get(0),
                        )
                        .ok();
                    if current_status.as_deref() == Some("running") {
                        let err_msg = if stderr.is_empty() {
                            format!("Process exited with code {}", exit.code().unwrap_or(-1))
                        } else {
                            stderr.chars().take(2000).collect()
                        };
                        let _ = conn.execute(
                            "UPDATE portrait_runs SET status = 'failed', error_message = ?1, finished_at = datetime('now') WHERE id = ?2",
                            rusqlite::params![err_msg, run_id_for_monitor],
                        );
                    }
                }
            }
        }
    });

    Ok(json!({
        "run_id": run_id,
        "status": "started"
    }))
}

#[tauri::command]
pub async fn cancel_portrait_build() -> Result<Value, String> {
    let pid = {
        let mut guard = RUNNING_PORTRAIT.lock().unwrap();
        guard.take()
    };

    if let Some(pid) = pid {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    let data_dir = profiles::get_active_data_dir();
    let db_path = data_dir.join("thyself.db");

    if let Ok(conn) = rusqlite::Connection::open(&db_path) {
        let _ = conn.execute(
            "UPDATE portrait_runs SET status = 'cancelled', finished_at = datetime('now') WHERE status = 'running'",
            [],
        );
    }

    Ok(json!({ "status": "cancelled" }))
}

#[tauri::command]
pub async fn get_portrait_status(state: State<'_, DbState>) -> Result<Value, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = match guard.as_ref() {
        Some(c) => c,
        None => return Ok(Value::Null),
    };

    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='portrait_runs'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if !table_exists {
        return Ok(Value::Null);
    }

    let result = conn.query_row(
        "SELECT id, status, phase, total_batches, completed_batches, synthesis_batches, synthesis_completed, error_message, started_at, updated_at, finished_at, extraction_months_covered, results_summary
         FROM portrait_runs ORDER BY id DESC LIMIT 1",
        [],
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "status": row.get::<_, String>(1)?,
                "phase": row.get::<_, String>(2)?,
                "total_batches": row.get::<_, Option<i64>>(3)?,
                "completed_batches": row.get::<_, Option<i64>>(4)?,
                "synthesis_batches": row.get::<_, Option<i64>>(5)?,
                "synthesis_completed": row.get::<_, Option<i64>>(6)?,
                "error_message": row.get::<_, Option<String>>(7)?,
                "started_at": row.get::<_, Option<String>>(8)?,
                "updated_at": row.get::<_, Option<String>>(9)?,
                "finished_at": row.get::<_, Option<String>>(10)?,
                "extraction_months_covered": row.get::<_, Option<String>>(11)?,
                "results_summary": row.get::<_, Option<String>>(12)?,
            }))
        },
    );

    match result {
        Ok(val) => Ok(val),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Value::Null),
        Err(e) => Err(format!("Failed to query portrait status: {}", e)),
    }
}

#[tauri::command]
pub async fn cmd_debug_log(_location: String, _message: String, _data: String) -> Result<(), String> {
    Ok(())
}
