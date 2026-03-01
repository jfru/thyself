use crate::claude::{stream_chat_request, StreamEvent};
use crate::db::{get_data_dir, DbState};
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
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let params = params.unwrap_or_default();
    crate::db::query_rows(&conn, &sql, &params)
}

#[tauri::command]
pub async fn write_db(
    state: State<'_, DbState>,
    sql: String,
    params: Option<Vec<String>>,
) -> Result<Value, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let params = params.unwrap_or_default();
    conn.execute(
        &sql,
        rusqlite::params_from_iter(params.iter()),
    )
    .map_err(|e| format!("Write error: {}", e))?;
    Ok(json!({"status": "ok"}))
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
    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .map_err(|_| "ANTHROPIC_API_KEY not set".to_string())?;

    let tool_defs = if tools.is_empty() {
        get_tool_definitions()
    } else {
        tools
    };

    let mut conversation = messages;
    let final_response;

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
                if block["type"].as_str() == Some("tool_use") {
                    let tool_name = block["name"].as_str().unwrap_or("");
                    let tool_id = block["id"].as_str().unwrap_or("");
                    let tool_input = &block["input"];

                    let result = {
                        let conn = db.conn.lock().map_err(|e| e.to_string())?;
                        execute_tool(&conn, tool_name, tool_input)
                    };

                    let (content_val, is_error) = match result {
                        Ok(val) => {
                            let text = serde_json::to_string_pretty(&val).unwrap_or_default();
                            let truncated = if text.len() > 50000 {
                                format!("{}...\n[truncated — {} total chars]", &text[..50000], text.len())
                            } else {
                                text
                            };
                            (truncated, false)
                        }
                        Err(e) => (e, true),
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

            conversation.push(json!({
                "role": "user",
                "content": tool_results
            }));
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
