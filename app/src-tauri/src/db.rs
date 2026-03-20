use rusqlite::{Connection, params_from_iter};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::profiles;

pub struct DbState {
    pub conn: Mutex<Option<Connection>>,
}

pub fn get_data_dir() -> PathBuf {
    profiles::get_active_data_dir()
}

pub fn open_db() -> Result<Option<Connection>, String> {
    let db_path = get_data_dir().join("thyself.db");
    if !db_path.exists() {
        return Ok(None);
    }
    Connection::open(&db_path)
        .map(Some)
        .map_err(|e| format!("Failed to open database: {}", e))
}

pub fn open_db_for_profile(data_dir: &str) -> Result<Connection, String> {
    let db_path = PathBuf::from(data_dir).join("thyself.db");
    if !db_path.exists() {
        return Err(format!("Database not found at {}", db_path.display()));
    }
    Connection::open(&db_path).map_err(|e| format!("Failed to open database: {}", e))
}

/// Mark any sync_runs stuck in "running" as failed.
/// Called on startup to clean up runs interrupted by a crash or quit.
pub fn cleanup_stale_sync_runs(conn: &Connection) {
    let has_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sync_runs'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if !has_table {
        return;
    }

    let _ = conn.execute(
        "UPDATE sync_runs SET status = 'failed', error_message = 'Interrupted — app restarted', finished_at = datetime('now') WHERE status = 'running'",
        [],
    );
}

/// Mark `running` rows older than `STALE_RUNNING_HOURS` as failed. Call from
/// `get_sync_status` so the UI recovers if the sync child process crashed without
/// updating SQLite while the app stayed open.
pub fn expire_stale_running_sync_runs(conn: &Connection) {
    const STALE_RUNNING_HOURS: i64 = 24;

    let has_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sync_runs'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if !has_table {
        return;
    }

    let sql = format!(
        "UPDATE sync_runs SET status = 'failed', error_message = 'Timed out — sync did not finish (stale running state)', finished_at = datetime('now') \
         WHERE status = 'running' AND started_at IS NOT NULL \
         AND datetime(started_at) < datetime('now', '-{} hours')",
        STALE_RUNNING_HOURS
    );
    let _ = conn.execute(&sql, []);
}

/// Mark any portrait_runs stuck in "running" as interrupted.
/// Called on startup so the UI can offer to resume.
pub fn cleanup_stale_portrait_runs(conn: &Connection) {
    let has_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='portrait_runs'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if !has_table {
        return;
    }

    let _ = conn.execute(
        "UPDATE portrait_runs SET status = 'interrupted', error_message = 'App closed during build', updated_at = datetime('now') WHERE status = 'running'",
        [],
    );
}

pub fn query_rows(conn: &Connection, sql: &str, params: &[Value]) -> Result<Value, String> {
    let bound: Vec<String> = params
        .iter()
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Null => String::new(),
            other => other.to_string(),
        })
        .collect();

    let mut stmt = conn.prepare(sql).map_err(|e| format!("SQL error: {}", e))?;

    let column_names: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect();

    let rows = stmt
        .query_map(params_from_iter(bound.iter()), |row| {
            let mut obj = serde_json::Map::new();
            for (i, col) in column_names.iter().enumerate() {
                let val: Value = match row.get_ref(i) {
                    Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                    Ok(rusqlite::types::ValueRef::Integer(n)) => json!(n),
                    Ok(rusqlite::types::ValueRef::Real(f)) => json!(f),
                    Ok(rusqlite::types::ValueRef::Text(s)) => {
                        let text = String::from_utf8_lossy(s).to_string();
                        if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                            if parsed.is_array() || parsed.is_object() {
                                parsed
                            } else {
                                Value::String(text)
                            }
                        } else {
                            Value::String(text)
                        }
                    }
                    Ok(rusqlite::types::ValueRef::Blob(b)) => {
                        Value::String(format!("<blob {} bytes>", b.len()))
                    }
                    Err(_) => Value::Null,
                };
                obj.insert(col.clone(), val);
            }
            Ok(Value::Object(obj))
        })
        .map_err(|e| format!("Query error: {}", e))?;

    let results: Vec<Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(json!({
        "columns": column_names,
        "rows": results,
        "row_count": results.len()
    }))
}

#[cfg(test)]
mod tests {
    use super::expire_stale_running_sync_runs;
    use rusqlite::Connection;

    fn setup_sync_runs_table(conn: &Connection) {
        conn
            .execute_batch(
                r"
            CREATE TABLE sync_runs (
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
            );
            ",
            )
            .expect("create sync_runs");
    }

    #[test]
    fn expire_stale_running_marks_only_old_rows_failed() {
        let conn = Connection::open_in_memory().expect("in memory");
        setup_sync_runs_table(&conn);
        conn.execute(
            "INSERT INTO sync_runs (source, started_at, status) VALUES ('imessage', datetime('now', '-25 hours'), 'running')",
            [],
        )
        .expect("insert stale");
        conn.execute(
            "INSERT INTO sync_runs (source, started_at, status) VALUES ('gmail', datetime('now', '-1 hours'), 'running')",
            [],
        )
        .expect("insert fresh");

        expire_stale_running_sync_runs(&conn);

        let stale: String = conn
            .query_row(
                "SELECT status FROM sync_runs WHERE source = 'imessage'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale, "failed");

        let fresh: String = conn
            .query_row(
                "SELECT status FROM sync_runs WHERE source = 'gmail'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fresh, "running");
    }
}
