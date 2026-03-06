use crate::claude::StreamEvent;
use crate::commands::run_chat_loop;
use crate::db::{self, get_data_dir, DbState};
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
    let conn = state.db.conn.lock().unwrap();
    let params = body.params.unwrap_or_default();
    match db::query_rows(&conn, &body.sql, &params) {
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
    let conn = state.db.conn.lock().unwrap();
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

async fn handle_create_session() -> impl IntoResponse {
    match sessions::create_session() {
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
    let conn = state.db.conn.lock().unwrap();

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

    let latest: Vec<Value> = conn
        .prepare(
            "SELECT source, started_at, finished_at, messages_added, status, error_message, last_message_at
             FROM sync_runs WHERE id IN (SELECT MAX(id) FROM sync_runs GROUP BY source) ORDER BY source",
        )
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

    let history: Vec<Value> = conn
        .prepare(
            "SELECT id, source, started_at, finished_at, messages_added, status, error_message, last_message_at
             FROM sync_runs ORDER BY id DESC LIMIT 100",
        )
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
