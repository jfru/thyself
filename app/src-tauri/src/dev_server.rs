use crate::claude::StreamEvent;
use crate::commands::run_chat_loop;
use crate::db::{self, get_data_dir, DbState};
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
        .route("/api/data_dir", get(handle_data_dir))
        .route("/api/tool_defs", get(handle_tool_defs))
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
