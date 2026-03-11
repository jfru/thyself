use crate::db::get_data_dir;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub status: String,
    #[serde(default = "default_session_kind")]
    pub kind: String,
    #[serde(rename = "summaryFile")]
    pub summary_file: Option<String>,
    #[serde(rename = "chatHistory")]
    pub chat_history: Value,
}

fn default_session_kind() -> String {
    "conversation".to_string()
}

fn manifest_path() -> PathBuf {
    get_data_dir().join("sessions").join("sessions.json")
}

fn ensure_sessions_dir() -> Result<(), String> {
    let dir = get_data_dir().join("sessions");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))
}

pub fn read_manifest() -> Result<Vec<SessionMeta>, String> {
    let path = manifest_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read manifest: {}", e))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse manifest: {}", e))
}

fn write_manifest(sessions: &[SessionMeta]) -> Result<(), String> {
    ensure_sessions_dir()?;
    let data =
        serde_json::to_string_pretty(sessions).map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(manifest_path(), data).map_err(|e| format!("Failed to write manifest: {}", e))
}

pub fn create_session(name: Option<&str>, kind: Option<&str>) -> Result<SessionMeta, String> {
    let mut manifest = read_manifest()?;
    let session_kind = kind.unwrap_or("conversation");

    // #region agent log
    {
        use std::io::Write;
        let path = "/Users/jfru/thyself/.cursor/debug-2ee486.log";
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
            let active_count = manifest.iter().filter(|s| s.status == "active").count();
            let history_len = manifest.iter().find(|s| s.status == "active").map(|s| {
                if let serde_json::Value::Array(arr) = &s.chat_history { arr.len() } else { 0 }
            }).unwrap_or(0);
            let _ = writeln!(f, r#"{{"sessionId":"2ee486","location":"sessions.rs:create_session","message":"called","data":{{"manifest_len":{},"active_count":{},"active_history_len":{}}},"timestamp":{}}}"#, manifest.len(), active_count, history_len, ts);
        }
    }
    // #endregion

    if let Some(idx) = manifest
        .iter()
        .position(|s| s.status == "active" && s.kind == session_kind)
    {
        if let Some(n) = name {
            if manifest[idx].name != n {
                manifest[idx].name = n.to_string();
                write_manifest(&manifest)?;
            }
        }
        return Ok(manifest[idx].clone());
    }

    let session = SessionMeta {
        id: uuid::Uuid::new_v4().to_string(),
        name: name
            .unwrap_or(if session_kind == "setup" {
                "Setup"
            } else {
                "Current Session"
            })
            .to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        status: "active".to_string(),
        kind: session_kind.to_string(),
        summary_file: None,
        chat_history: serde_json::json!([]),
    };
    manifest.push(session.clone());
    write_manifest(&manifest)?;
    Ok(session)
}

pub fn save_messages(session_id: &str, messages: &Value) -> Result<(), String> {
    let mut manifest = read_manifest()?;
    if let Some(session) = manifest.iter_mut().find(|s| s.id == session_id) {
        session.chat_history = messages.clone();
        write_manifest(&manifest)?;
        Ok(())
    } else {
        Err(format!("Session not found: {}", session_id))
    }
}

pub fn complete_session(
    session_id: &str,
    title: &str,
    summary_file: &str,
    content: &str,
) -> Result<(), String> {
    ensure_sessions_dir()?;

    let file_path = get_data_dir().join("sessions").join(summary_file);
    fs::write(&file_path, content)
        .map_err(|e| format!("Failed to write session file: {}", e))?;

    let mut manifest = read_manifest()?;
    if let Some(session) = manifest.iter_mut().find(|s| s.id == session_id) {
        session.name = title.to_string();
        session.status = "completed".to_string();
        session.summary_file = Some(summary_file.to_string());
    } else {
        // Backwards compatibility: if no matching session, create a completed entry
        manifest.push(SessionMeta {
            id: uuid::Uuid::new_v4().to_string(),
            name: title.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            status: "completed".to_string(),
            kind: "conversation".to_string(),
            summary_file: Some(summary_file.to_string()),
            chat_history: serde_json::json!([]),
        });
    }
    write_manifest(&manifest)
}
