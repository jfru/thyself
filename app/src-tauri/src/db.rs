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
