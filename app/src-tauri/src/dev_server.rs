use crate::claude::StreamEvent;
use crate::commands::run_chat_loop;
use crate::db::{self, get_data_dir, DbState};
use crate::onboarding_tools;
use crate::profiles;
use crate::sessions;
use crate::tools::get_tool_definitions;
use axum::{
    extract::State as AxumState,
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse, Json,
    },
    routing::{get, post},
    Router,
};
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tower_http::cors::{Any, CorsLayer};

struct AppState {
    db: DbState,
    active_streams: std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
}

pub async fn start_dev_server() {
    let db_conn = match db::open_db() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[dev-server] Failed to open db: {}", e);
            return;
        }
    };

    let state = Arc::new(AppState {
        db: DbState {
            conn: std::sync::Mutex::new(db_conn),
        },
        active_streams: std::sync::Mutex::new(HashMap::new()),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/query_db", post(handle_query_db))
        .route("/api/write_db", post(handle_write_db))
        .route("/api/read_file", post(handle_read_file))
        .route("/api/write_file", post(handle_write_file))
        .route("/api/list_files", post(handle_list_files))
        .route("/api/stream_chat", post(handle_stream_chat))
        .route("/api/stop_chat", post(handle_stop_chat))
        .route("/api/create_session", post(handle_create_session))
        .route("/api/list_sessions", get(handle_list_sessions))
        .route("/api/load_session", post(handle_load_session))
        .route("/api/save_session_messages", post(handle_save_session_messages))
        .route("/api/data_dir", get(handle_data_dir))
        .route("/api/tool_defs", get(handle_tool_defs))
        .route("/api/sync_status", get(handle_sync_status))
        .route("/api/health", get(handle_health))
        .route("/api/cmd_debug_log", post(handle_debug_log))
        .route("/api/list_profiles", get(handle_list_profiles))
        .route("/api/cmd_create_profile", post(handle_create_profile))
        .route("/api/cmd_switch_profile", post(handle_switch_profile))
        .route("/api/cmd_delete_profile", post(handle_delete_profile))
        .route("/api/get_active_profile", get(handle_get_active_profile))
        .route("/api/cmd_update_profile", post(handle_update_profile))
        .route("/api/cmd_remove_data_source", post(handle_remove_data_source))
        .route("/api/get_subject_name", get(handle_get_subject_name))
        .route("/api/validate_api_key", post(handle_validate_api_key))
        .route("/api/cmd_open_icloud_settings", post(handle_open_icloud_settings))
        .route("/api/cmd_open_finder_iphone", post(handle_open_finder_iphone))
        .route("/api/import_chatgpt_export", post(handle_import_chatgpt_export))
        .route("/api/read_dropped_files", post(handle_read_dropped_files))
        .route("/api/start_portrait_build", post(handle_start_portrait_build))
        .route("/api/cancel_portrait_build", post(handle_cancel_portrait_build))
        .route("/api/get_portrait_status", get(handle_get_portrait_status))
        .layer(cors)
        .with_state(state);

    let listener = match tokio::net::TcpListener::bind("127.0.0.1:3001").await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[dev-server] Failed to bind :3001: {}", e);
            return;
        }
    };
    eprintln!("[dev-server] Listening on http://127.0.0.1:3001");
    axum::serve(listener, app).await.ok();
}

async fn handle_health() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
struct QueryDbReq {
    sql: String,
    params: Option<Vec<Value>>,
}

async fn handle_query_db(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(body): Json<QueryDbReq>,
) -> impl IntoResponse {
    let guard = state.db.conn.lock().unwrap();
    let conn = match guard.as_ref() {
        Some(c) => c,
        None => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "No database available"}))),
    };
    let params = body.params.unwrap_or_default();
    match db::query_rows(conn, &body.sql, &params) {
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))),
    }
}

#[derive(Deserialize)]
struct WriteDbReq {
    sql: String,
    params: Option<Vec<String>>,
}

async fn handle_write_db(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(body): Json<WriteDbReq>,
) -> impl IntoResponse {
    let guard = state.db.conn.lock().unwrap();
    let conn = match guard.as_ref() {
        Some(c) => c,
        None => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "No database available"}))),
    };
    let params = body.params.unwrap_or_default();
    match conn.execute(&body.sql, rusqlite::params_from_iter(params.iter())) {
        Ok(_) => (StatusCode::OK, Json(json!({"status": "ok"}))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("{}", e)})),
        ),
    }
}

#[derive(Deserialize)]
struct ReadFileReq {
    path: String,
}

async fn handle_read_file(Json(body): Json<ReadFileReq>) -> impl IntoResponse {
    let full_path = get_data_dir().join(&body.path);
    match std::fs::read_to_string(&full_path) {
        Ok(content) => (StatusCode::OK, Json(json!(content))),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("{}", e)})),
        ),
    }
}

#[derive(Deserialize)]
struct WriteFileReq {
    path: String,
    content: String,
}

async fn handle_write_file(Json(body): Json<WriteFileReq>) -> impl IntoResponse {
    let full_path = get_data_dir().join(&body.path);
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    match std::fs::write(&full_path, &body.content) {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({"status": "ok", "path": full_path.display().to_string()})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("{}", e)})),
        ),
    }
}

#[derive(Deserialize)]
struct ListFilesReq {
    dir: String,
    pattern: Option<String>,
}

async fn handle_list_files(Json(body): Json<ListFilesReq>) -> impl IntoResponse {
    let search_dir = get_data_dir().join(&body.dir);
    if !search_dir.exists() {
        return Json(json!([]));
    }
    let pat = body.pattern.unwrap_or_else(|| "*".to_string());
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
    Json(json!(files))
}

async fn handle_data_dir() -> Json<Value> {
    Json(json!(get_data_dir().display().to_string()))
}

async fn handle_tool_defs() -> Json<Value> {
    Json(json!(get_tool_definitions()))
}

#[derive(Deserialize)]
struct StreamChatReq {
    messages: Vec<Value>,
    #[serde(rename = "systemPrompt")]
    system_prompt: String,
    tools: Option<Vec<Value>>,
    #[serde(rename = "streamId")]
    stream_id: String,
}

async fn handle_stream_chat(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(body): Json<StreamChatReq>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();

    let stream_id = body.stream_id.clone();
    let cancel_flag = Arc::new(AtomicBool::new(false));

    state
        .active_streams
        .lock()
        .unwrap()
        .insert(stream_id.clone(), cancel_flag.clone());

    let state_for_cleanup = state.clone();
    let cleanup_id = stream_id.clone();

    tokio::spawn(async move {
        let tx_for_emit = tx.clone();
        let emit_fn = move |_sid: &str, etype: &str, data: &Value| {
            let _ = tx_for_emit.send(StreamEvent {
                event_type: etype.to_string(),
                data: data.clone(),
            });
        };

        let result = run_chat_loop(
            &emit_fn,
            &state.db,
            body.messages,
            body.system_prompt,
            body.tools.unwrap_or_default(),
            body.stream_id,
            Some(cancel_flag),
        )
        .await;

        if let Err(e) = result {
            if e != "Cancelled by user" {
                let _ = tx.send(StreamEvent {
                    event_type: "error".to_string(),
                    data: json!({"error": e}),
                });
            }
        }

        let _ = tx.send(StreamEvent {
            event_type: "done".to_string(),
            data: json!({}),
        });

        state_for_cleanup
            .active_streams
            .lock()
            .unwrap()
            .remove(&cleanup_id);
    });

    let stream = async_stream::stream! {
        while let Some(event) = rx.recv().await {
            if event.event_type == "done" {
                break;
            }
            let payload = serde_json::to_string(&event).unwrap_or_default();
            yield Ok(Event::default()
                .event(&stream_id)
                .data(payload));
        }
    };

    Sse::new(stream)
}

#[derive(Deserialize)]
struct StopChatReq {
    #[serde(rename = "streamId")]
    stream_id: String,
}

async fn handle_stop_chat(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(body): Json<StopChatReq>,
) -> impl IntoResponse {
    let streams = state.active_streams.lock().unwrap();
    if let Some(flag) = streams.get(&body.stream_id) {
        flag.store(true, Ordering::Relaxed);
        (StatusCode::OK, Json(json!({"status": "stopped"})))
    } else {
        (StatusCode::NOT_FOUND, Json(json!({"error": "stream not found"})))
    }
}

async fn handle_create_session(
    body: Option<Json<Value>>,
) -> impl IntoResponse {
    let name = body
        .as_ref()
        .and_then(|b| b.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let kind = body
        .as_ref()
        .and_then(|b| b.get("kind"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    match sessions::create_session(name.as_deref(), kind.as_deref()) {
        Ok(session) => (
            StatusCode::OK,
            Json(serde_json::to_value(&session).unwrap_or(json!({}))),
        ),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))),
    }
}

async fn handle_list_sessions() -> impl IntoResponse {
    match sessions::read_manifest() {
        Ok(manifest) => {
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
            Json(json!(summary))
        }
        Err(_) => Json(json!([])),
    }
}

#[derive(Deserialize)]
struct LoadSessionReq {
    #[serde(rename = "sessionId")]
    session_id: String,
}

async fn handle_load_session(Json(body): Json<LoadSessionReq>) -> impl IntoResponse {
    let manifest = match sessions::read_manifest() {
        Ok(m) => m,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))),
    };
    let session = match manifest.iter().find(|s| s.id == body.session_id) {
        Some(s) => s,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "Session not found"})),
            )
        }
    };

    let summary = session.summary_file.as_ref().and_then(|file| {
        let path = get_data_dir().join("sessions").join(file);
        std::fs::read_to_string(&path).ok()
    });

    (
        StatusCode::OK,
        Json(json!({
            "session": session,
            "summary": summary,
        })),
    )
}

#[derive(Deserialize)]
struct SaveSessionMessagesReq {
    #[serde(rename = "sessionId")]
    session_id: String,
    messages: Value,
}

async fn handle_save_session_messages(
    Json(body): Json<SaveSessionMessagesReq>,
) -> impl IntoResponse {
    match sessions::save_messages(&body.session_id, &body.messages) {
        Ok(_) => (StatusCode::OK, Json(json!({"status": "ok"}))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))),
    }
}

async fn handle_sync_status(
    AxumState(state): AxumState<Arc<AppState>>,
) -> impl IntoResponse {
    let guard = state.db.conn.lock().unwrap();
    let conn = match guard.as_ref() {
        Some(c) => c,
        None => return Json(json!({
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
        return Json(json!({
            "latest_by_source": {},
            "history": [],
            "has_sync_runs": false
        }));
    }

    let has_progress_cols: bool = conn
        .prepare("PRAGMA table_info(sync_runs)")
        .ok()
        .and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| row.get::<_, String>(1)).ok()?;
            let cols: Vec<String> = rows.filter_map(Result::ok).collect();
            Some(
                cols.iter().any(|c| c == "progress_processed")
                    && cols.iter().any(|c| c == "progress_total"),
            )
        })
        .unwrap_or(false);

    let latest_sql = if has_progress_cols {
        "SELECT source, started_at, finished_at, messages_added, status, error_message, last_message_at, progress_processed, progress_total
         FROM sync_runs WHERE id IN (SELECT MAX(id) FROM sync_runs GROUP BY source) ORDER BY source"
    } else {
        "SELECT source, started_at, finished_at, messages_added, status, error_message, last_message_at, NULL AS progress_processed, NULL AS progress_total
         FROM sync_runs WHERE id IN (SELECT MAX(id) FROM sync_runs GROUP BY source) ORDER BY source"
    };

    let latest: Vec<Value> = conn
        .prepare(latest_sql)
        .and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| {
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
            })?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    let mut latest_map = serde_json::Map::new();
    for row in &latest {
        if let Some(source) = row["source"].as_str() {
            latest_map.insert(source.to_string(), row.clone());
        }
    }

    let history_sql = if has_progress_cols {
        "SELECT id, source, started_at, finished_at, messages_added, status, error_message, last_message_at, progress_processed, progress_total
         FROM sync_runs ORDER BY id DESC LIMIT 100"
    } else {
        "SELECT id, source, started_at, finished_at, messages_added, status, error_message, last_message_at, NULL AS progress_processed, NULL AS progress_total
         FROM sync_runs ORDER BY id DESC LIMIT 100"
    };

    let history: Vec<Value> = conn
        .prepare(history_sql)
        .and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| {
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
            })?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    Json(json!({
        "latest_by_source": Value::Object(latest_map),
        "history": history,
        "has_sync_runs": true
    }))
}

// --- Profile handlers ---

async fn handle_list_profiles() -> impl IntoResponse {
    let profiles = profiles::read_profiles().unwrap_or_default();
    let active_id = profiles::get_active_profile_id();
    Json(json!({
        "profiles": profiles,
        "activeProfileId": active_id,
    }))
}

#[derive(Deserialize)]
struct CreateProfileReq {
    name: String,
    #[serde(rename = "apiKey")]
    api_key: String,
    #[serde(rename = "subjectName")]
    subject_name: String,
    email: Option<String>,
    #[serde(rename = "selectedSources")]
    selected_sources: Vec<String>,
}

async fn handle_create_profile(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(body): Json<CreateProfileReq>,
) -> impl IntoResponse {
    match profiles::create_profile(body.name, body.api_key, body.subject_name, body.email, body.selected_sources) {
        Ok(profile) => {
            if let Ok(new_conn) = db::open_db_for_profile(&profile.data_dir) {
                let mut guard = state.db.conn.lock().unwrap();
                *guard = Some(new_conn);
            }
            (StatusCode::OK, Json(serde_json::to_value(&profile).unwrap_or(json!({}))))
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))),
    }
}

#[derive(Deserialize)]
struct SwitchProfileReq {
    #[serde(rename = "profileId")]
    profile_id: String,
}

async fn handle_switch_profile(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(body): Json<SwitchProfileReq>,
) -> impl IntoResponse {
    match profiles::switch_profile(&body.profile_id) {
        Ok(profile) => {
            if let Ok(new_conn) = db::open_db_for_profile(&profile.data_dir) {
                let mut guard = state.db.conn.lock().unwrap();
                *guard = Some(new_conn);
            }
            (StatusCode::OK, Json(serde_json::to_value(&profile).unwrap_or(json!({}))))
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))),
    }
}

#[derive(Deserialize)]
struct DeleteProfileReq {
    #[serde(rename = "profileId")]
    profile_id: String,
}

async fn handle_delete_profile(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(body): Json<DeleteProfileReq>,
) -> impl IntoResponse {
    match profiles::delete_profile(&body.profile_id) {
        Ok(next_profile) => {
            if let Some(ref p) = next_profile {
                if let Ok(new_conn) = db::open_db_for_profile(&p.data_dir) {
                    let mut guard = state.db.conn.lock().unwrap();
                    *guard = Some(new_conn);
                }
            } else {
                let mut guard = state.db.conn.lock().unwrap();
                *guard = None;
            }
            (StatusCode::OK, Json(json!({
                "nextProfile": next_profile.map(|p| serde_json::to_value(&p).unwrap_or(Value::Null)),
            })))
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))),
    }
}

async fn handle_get_active_profile() -> impl IntoResponse {
    let active_id = profiles::get_active_profile_id();
    if let Some(id) = active_id {
        let profiles = profiles::read_profiles().unwrap_or_default();
        if let Some(profile) = profiles.iter().find(|p| p.id == id) {
            return Json(serde_json::to_value(profile).unwrap_or(Value::Null));
        }
    }
    Json(Value::Null)
}

#[derive(Deserialize)]
struct UpdateProfileReq {
    #[serde(rename = "profileId")]
    profile_id: String,
    #[serde(rename = "onboardingStatus")]
    onboarding_status: Option<String>,
    #[serde(rename = "selectedSources")]
    selected_sources: Option<Vec<String>>,
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
    #[serde(rename = "subjectName")]
    subject_name: Option<String>,
    email: Option<String>,
}

async fn handle_update_profile(Json(body): Json<UpdateProfileReq>) -> impl IntoResponse {
    match profiles::update_profile(
        &body.profile_id,
        body.onboarding_status,
        body.selected_sources,
        body.api_key,
        body.subject_name,
        body.email,
    ) {
        Ok(profile) => (StatusCode::OK, Json(serde_json::to_value(&profile).unwrap_or(json!({})))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))),
    }
}

#[derive(Deserialize)]
struct RemoveDataSourceReq {
    #[serde(rename = "profileId")]
    profile_id: String,
    #[serde(rename = "sourceId")]
    source_id: String,
}

async fn handle_remove_data_source(
    AxumState(state): AxumState<Arc<AppState>>,
    Json(body): Json<RemoveDataSourceReq>,
) -> impl IntoResponse {
    let mut profiles_list = match profiles::read_profiles() {
        Ok(p) => p,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))),
    };
    let profile = match profiles_list.iter_mut().find(|p| p.id == body.profile_id) {
        Some(p) => p,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": format!("Profile not found: {}", body.profile_id)})),
            )
        }
    };

    match body.source_id.as_str() {
        "imessage" => onboarding_tools::kill_sync_for_source("imessage"),
        "whatsapp" => onboarding_tools::kill_syncs_for_sources(&["whatsapp_desktop", "whatsapp_web"]),
        "gmail" => onboarding_tools::kill_sync_for_source("gmail"),
        "chatgpt" => onboarding_tools::kill_sync_for_source("chatgpt"),
        _ => {}
    }

    let guard = state.db.conn.lock().unwrap();
    let conn = match guard.as_ref() {
        Some(c) => c,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "No database available"})),
            )
        }
    };
    let tx = match conn.unchecked_transaction() {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("Failed to start transaction: {}", e)})),
            )
        }
    };

    let mut deleted = json!({
        "messages": 0,
        "conversations": 0,
        "gmail_messages": 0,
        "chatgpt_messages": 0,
        "chatgpt_conversations": 0,
        "sync_runs": 0
    });

    let result = match body.source_id.as_str() {
        "imessage" => {
            let m = tx.execute("DELETE FROM messages WHERE source = 'imessage'", []);
            let c = tx.execute("DELETE FROM conversations WHERE source = 'imessage'", []);
            let s = tx.execute("DELETE FROM sync_runs WHERE source = 'imessage'", []);
            match (m, c, s) {
                (Ok(mm), Ok(cc), Ok(ss)) => {
                    deleted["messages"] = json!(mm);
                    deleted["conversations"] = json!(cc);
                    deleted["sync_runs"] = json!(ss);
                    Ok(())
                }
                _ => Err("Failed deleting iMessage data".to_string()),
            }
        }
        "whatsapp" => {
            let m = tx.execute("DELETE FROM messages WHERE source = 'whatsapp'", []);
            let c = tx.execute("DELETE FROM conversations WHERE source = 'whatsapp'", []);
            let s = tx.execute(
                "DELETE FROM sync_runs WHERE source IN ('whatsapp_desktop', 'whatsapp_web')",
                [],
            );
            match (m, c, s) {
                (Ok(mm), Ok(cc), Ok(ss)) => {
                    deleted["messages"] = json!(mm);
                    deleted["conversations"] = json!(cc);
                    deleted["sync_runs"] = json!(ss);
                    Ok(())
                }
                _ => Err("Failed deleting WhatsApp data".to_string()),
            }
        }
        "gmail" => {
            let g = tx.execute("DELETE FROM gmail_messages", []);
            let s = tx.execute("DELETE FROM sync_runs WHERE source = 'gmail'", []);
            match (g, s) {
                (Ok(gg), Ok(ss)) => {
                    deleted["gmail_messages"] = json!(gg);
                    deleted["sync_runs"] = json!(ss);
                    Ok(())
                }
                _ => Err("Failed deleting Gmail data".to_string()),
            }
        }
        "chatgpt" => {
            let m = tx.execute("DELETE FROM chatgpt_messages", []);
            let c = tx.execute("DELETE FROM chatgpt_conversations", []);
            let s = tx.execute("DELETE FROM sync_runs WHERE source = 'chatgpt'", []);
            match (m, c, s) {
                (Ok(mm), Ok(cc), Ok(ss)) => {
                    deleted["chatgpt_messages"] = json!(mm);
                    deleted["chatgpt_conversations"] = json!(cc);
                    deleted["sync_runs"] = json!(ss);
                    Ok(())
                }
                _ => Err("Failed deleting ChatGPT data".to_string()),
            }
        }
        _ => Err(format!("Unsupported source_id: {}", body.source_id)),
    };

    if let Err(e) = result {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": e})));
    }

    if tx
        .execute(
            "DELETE FROM conversation_participants
             WHERE conversation_id NOT IN (SELECT id FROM conversations)",
            [],
        )
        .is_err()
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "Failed cleaning conversation participants"})),
        );
    }

    if tx
        .execute(
            "DELETE FROM messages
             WHERE conversation_id IS NOT NULL
               AND conversation_id NOT IN (SELECT id FROM conversations)",
            [],
        )
        .is_err()
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "Failed cleaning dangling messages"})),
        );
    }

    if let Err(e) = tx.commit() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("Failed to commit removal: {}", e)})),
        );
    }

    let next_sources: Vec<String> = profile
        .selected_sources
        .iter()
        .filter(|s| *s != &body.source_id)
        .cloned()
        .collect();
    let updated = match profiles::update_profile(
        &body.profile_id,
        None,
        Some(next_sources.clone()),
        None,
        None,
        None,
    ) {
        Ok(p) => p,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))),
    };

    (
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "sourceId": body.source_id,
            "deleted": deleted,
            "selectedSources": next_sources,
            "profile": updated,
        })),
    )
}

async fn handle_get_subject_name() -> impl IntoResponse {
    Json(json!(profiles::get_active_subject_name()))
}

#[derive(Deserialize)]
struct ValidateApiKeyReq {
    #[serde(rename = "apiKey")]
    api_key: String,
}

async fn handle_validate_api_key(Json(body): Json<ValidateApiKeyReq>) -> impl IntoResponse {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &body.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "hi"}]
        }))
        .send()
        .await;

    match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            if status == 200 || status == 201 {
                (StatusCode::OK, Json(json!({"valid": true})))
            } else if status == 401 {
                (StatusCode::OK, Json(json!({"valid": false, "error": "Invalid API key"})))
            } else {
                let body = r.text().await.unwrap_or_default();
                (StatusCode::OK, Json(json!({"valid": false, "error": format!("Unexpected response ({}): {}", status, body)})))
            }
        }
        Err(e) => (StatusCode::OK, Json(json!({"valid": false, "error": format!("Request failed: {}", e)}))),
    }
}

// #region agent log
#[derive(serde::Deserialize)]
struct DebugLogReq {
    location: String,
    message: String,
    data: String,
}

async fn handle_debug_log(Json(body): Json<DebugLogReq>) -> impl IntoResponse {
    use std::io::Write;
    let path = "/Users/jfru/thyself/.cursor/debug-2ee486.log";
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, r#"{{"sessionId":"2ee486","location":"{}","message":"{}","data":{},"timestamp":{}}}"#, body.location, body.message, body.data, ts);
    }
    StatusCode::OK
}
// #endregion

async fn handle_open_icloud_settings() -> impl IntoResponse {
    crate::onboarding_tools::perform_open_icloud_settings();
    Json(json!({"status": "opened"}))
}

async fn handle_open_finder_iphone() -> impl IntoResponse {
    crate::onboarding_tools::perform_open_finder_iphone();
    Json(json!({"status": "opened"}))
}

#[derive(Deserialize)]
struct ImportChatGptReq {
    path: String,
}

async fn handle_import_chatgpt_export(
    Json(body): Json<ImportChatGptReq>,
) -> impl IntoResponse {
    let input = json!({ "path": body.path });
    match onboarding_tools::execute_onboarding_tool("import_chatgpt_export", &input).await {
        Ok(result) => (StatusCode::OK, Json(result)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        ),
    }
}

#[derive(Deserialize)]
struct ReadDroppedFilesReq {
    paths: Vec<String>,
}

async fn handle_read_dropped_files(
    Json(body): Json<ReadDroppedFilesReq>,
) -> impl IntoResponse {
    match crate::commands::read_dropped_files(body.paths).await {
        Ok(result) => (StatusCode::OK, Json(result)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        ),
    }
}

async fn handle_start_portrait_build() -> impl IntoResponse {
    match crate::commands::start_portrait_build().await {
        Ok(result) => (StatusCode::OK, Json(result)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        ),
    }
}

async fn handle_cancel_portrait_build() -> impl IntoResponse {
    match crate::commands::cancel_portrait_build().await {
        Ok(result) => (StatusCode::OK, Json(result)),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        ),
    }
}

async fn handle_get_portrait_status(
    AxumState(state): AxumState<Arc<AppState>>,
) -> impl IntoResponse {
    let guard = match state.db.conn.lock() {
        Ok(g) => g,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))),
    };
    let conn = match guard.as_ref() {
        Some(c) => c,
        None => return (StatusCode::OK, Json(Value::Null)),
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
        return (StatusCode::OK, Json(Value::Null));
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
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(rusqlite::Error::QueryReturnedNoRows) => (StatusCode::OK, Json(Value::Null)),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": format!("Query failed: {}", e) }))),
    }
}

