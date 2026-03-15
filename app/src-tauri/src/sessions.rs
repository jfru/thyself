use crate::db::get_data_dir;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;

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

fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<SessionMeta> {
    let chat_str: String = row.get::<_, String>(6).unwrap_or_else(|_| "[]".into());
    let chat_history = serde_json::from_str(&chat_str).unwrap_or(serde_json::json!([]));
    Ok(SessionMeta {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        status: row.get(3)?,
        summary_file: row.get(4)?,
        chat_history,
        created_at: row.get(7)?,
    })
}

const SELECT_COLS: &str =
    "id, name, kind, status, summary_file, summary, chat_history, created_at";

pub fn create_session(
    conn: &Connection,
    name: Option<&str>,
    kind: Option<&str>,
) -> Result<SessionMeta, String> {
    let session_kind = kind.unwrap_or("conversation");

    let existing: Option<SessionMeta> = conn
        .query_row(
            &format!(
                "SELECT {} FROM sessions WHERE status = 'active' AND kind = ?1",
                SELECT_COLS
            ),
            [session_kind],
            row_to_session,
        )
        .ok();

    if let Some(mut session) = existing {
        if let Some(n) = name {
            if session.name != n {
                conn.execute(
                    "UPDATE sessions SET name = ?1 WHERE id = ?2",
                    rusqlite::params![n, session.id],
                )
                .map_err(|e| format!("Failed to update session name: {}", e))?;
                session.name = n.to_string();
            }
        }
        return Ok(session);
    }

    let id = uuid::Uuid::new_v4().to_string();
    let default_name = if session_kind == "setup" {
        "Setup"
    } else {
        "Current Session"
    };
    let session_name = name.unwrap_or(default_name);
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO sessions (id, name, kind, status, chat_history, created_at) VALUES (?1, ?2, ?3, 'active', '[]', ?4)",
        rusqlite::params![id, session_name, session_kind, now],
    )
    .map_err(|e| format!("Failed to create session: {}", e))?;

    Ok(SessionMeta {
        id,
        name: session_name.to_string(),
        created_at: now,
        status: "active".to_string(),
        kind: session_kind.to_string(),
        summary_file: None,
        chat_history: serde_json::json!([]),
    })
}

pub fn list_sessions(conn: &Connection) -> Result<Vec<SessionMeta>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM sessions ORDER BY created_at DESC",
            SELECT_COLS
        ))
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let sessions = stmt
        .query_map([], row_to_session)
        .map_err(|e| format!("Failed to query sessions: {}", e))?;

    sessions
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to collect sessions: {}", e))
}

pub fn load_session(
    conn: &Connection,
    session_id: &str,
) -> Result<(SessionMeta, Option<String>), String> {
    conn.query_row(
        &format!("SELECT {} FROM sessions WHERE id = ?1", SELECT_COLS),
        [session_id],
        |row| {
            let summary: Option<String> = row.get(5)?;
            let session = row_to_session(row)?;
            Ok((session, summary))
        },
    )
    .map_err(|e| format!("Session not found: {}", e))
}

pub fn save_messages(
    conn: &Connection,
    session_id: &str,
    messages: &Value,
) -> Result<(), String> {
    let json_str =
        serde_json::to_string(messages).map_err(|e| format!("Failed to serialize: {}", e))?;
    let changed = conn
        .execute(
            "UPDATE sessions SET chat_history = ?1 WHERE id = ?2",
            rusqlite::params![json_str, session_id],
        )
        .map_err(|e| format!("Failed to save messages: {}", e))?;

    if changed == 0 {
        return Err(format!("Session not found: {}", session_id));
    }
    Ok(())
}

pub fn complete_session(
    conn: &Connection,
    session_id: &str,
    title: &str,
    summary_file: &str,
    summary_content: &str,
) -> Result<(), String> {
    // Write .md file to disk as backup
    let sessions_dir = get_data_dir().join("sessions");
    fs::create_dir_all(&sessions_dir).ok();
    fs::write(sessions_dir.join(summary_file), summary_content).ok();

    let changed = conn
        .execute(
            "UPDATE sessions SET name = ?1, status = 'completed', summary_file = ?2, summary = ?3 WHERE id = ?4",
            rusqlite::params![title, summary_file, summary_content, session_id],
        )
        .map_err(|e| format!("Failed to complete session: {}", e))?;

    if changed == 0 {
        conn.execute(
            "INSERT INTO sessions (id, name, kind, status, summary_file, summary, chat_history, created_at) VALUES (?1, ?2, 'conversation', 'completed', ?3, ?4, '[]', datetime('now'))",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), title, summary_file, summary_content],
        )
        .map_err(|e| format!("Failed to insert completed session: {}", e))?;
    }

    Ok(())
}

/// Migrate sessions from legacy sessions.json into the database.
pub fn migrate_from_json(conn: &Connection) {
    if conn
        .execute_batch(crate::profiles::SESSIONS_TABLES)
        .is_err()
    {
        return;
    }

    let json_path = get_data_dir().join("sessions").join("sessions.json");
    if !json_path.exists() {
        return;
    }

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .unwrap_or(0);
    if count > 0 {
        return;
    }

    let data = match fs::read_to_string(&json_path) {
        Ok(d) => d,
        Err(_) => return,
    };
    let legacy: Vec<Value> = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(_) => return,
    };

    for s in &legacy {
        let id = s["id"].as_str().unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let name = s["name"].as_str().unwrap_or("Untitled");
        let kind = s["kind"].as_str().unwrap_or("conversation");
        let status = s["status"].as_str().unwrap_or("active");
        let created_at = s["createdAt"].as_str().unwrap_or("");
        let summary_file_val = s["summaryFile"].as_str();
        let chat_history =
            serde_json::to_string(&s["chatHistory"]).unwrap_or_else(|_| "[]".into());

        let summary_content = summary_file_val.and_then(|f| {
            let path = get_data_dir().join("sessions").join(f);
            fs::read_to_string(path).ok()
        });

        let _ = conn.execute(
            "INSERT OR IGNORE INTO sessions (id, name, kind, status, summary_file, summary, chat_history, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![id, name, kind, status, summary_file_val, summary_content, chat_history, created_at],
        );
    }
}
