use crate::db::{get_data_dir, query_rows};
use crate::sessions;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::fs;

pub fn execute_tool(
    conn: &Connection,
    tool_name: &str,
    tool_input: &Value,
) -> Result<Value, String> {
    match tool_name {
        "query_database" => {
            let sql = tool_input["sql"]
                .as_str()
                .ok_or("Missing 'sql' parameter")?;

            let sql_upper = sql.trim().to_uppercase();
            if !sql_upper.starts_with("SELECT")
                && !sql_upper.starts_with("WITH")
                && !sql_upper.starts_with("PRAGMA")
            {
                return Err("Only SELECT/WITH/PRAGMA queries are allowed".to_string());
            }

            let params: Vec<Value> = tool_input["params"]
                .as_array()
                .cloned()
                .unwrap_or_default();

            query_rows(conn, sql, &params)
        }

        "write_correction" => {
            let sql = "INSERT INTO corrections (correction_type, layer, target, original_claim, corrected_claim, evidence, months_affected) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";

            let params: Vec<String> = vec![
                tool_input["correction_type"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                tool_input["layer"].as_str().unwrap_or("").to_string(),
                tool_input["target"].as_str().unwrap_or("").to_string(),
                tool_input["original_claim"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                tool_input["corrected_claim"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                tool_input["evidence"].as_str().unwrap_or("").to_string(),
                tool_input["months_affected"]
                    .as_str()
                    .unwrap_or("[]")
                    .to_string(),
            ];

            conn.execute(
                sql,
                rusqlite::params![
                    params[0], params[1], params[2], params[3], params[4], params[5], params[6]
                ],
            )
            .map_err(|e| format!("Failed to insert correction: {}", e))?;

            Ok(json!({"status": "ok", "message": "Correction recorded"}))
        }

        "read_session_files" => {
            let sessions_dir = get_data_dir().join("sessions");
            if !sessions_dir.exists() {
                return Ok(json!({"files": [], "message": "No sessions directory found"}));
            }

            let pattern = sessions_dir.join("*.md");
            let mut files: Vec<Value> = Vec::new();

            if let Ok(entries) = glob::glob(pattern.to_str().unwrap_or("")) {
                for entry in entries.flatten() {
                    if let Ok(content) = fs::read_to_string(&entry) {
                        files.push(json!({
                            "path": entry.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                            "content": content
                        }));
                    }
                }
            }

            files.sort_by(|a, b| {
                a["path"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["path"].as_str().unwrap_or(""))
            });

            Ok(json!({"files": files, "count": files.len()}))
        }

        "write_session_file" => {
            let title = tool_input["title"]
                .as_str()
                .ok_or("Missing 'title' parameter")?;
            let filename = tool_input["filename"]
                .as_str()
                .ok_or("Missing 'filename' parameter")?;
            let content = tool_input["content"]
                .as_str()
                .ok_or("Missing 'content' parameter")?;
            let session_id = tool_input["session_id"]
                .as_str()
                .unwrap_or("");

            if session_id.is_empty() {
                let sessions_dir = get_data_dir().join("sessions");
                fs::create_dir_all(&sessions_dir)
                    .map_err(|e| format!("Failed to create sessions dir: {}", e))?;
                let file_path = sessions_dir.join(filename);
                fs::write(&file_path, content)
                    .map_err(|e| format!("Failed to write session file: {}", e))?;

                sessions::complete_session("", title, filename, content).ok();

                Ok(json!({"status": "ok", "path": file_path.display().to_string()}))
            } else {
                sessions::complete_session(session_id, title, filename, content)?;
                let file_path = get_data_dir().join("sessions").join(filename);
                Ok(json!({"status": "ok", "path": file_path.display().to_string()}))
            }
        }

        "read_file" => {
            let path = tool_input["path"]
                .as_str()
                .ok_or("Missing 'path' parameter")?;
            let full_path = get_data_dir().join(path);

            if !full_path.exists() {
                return Err(format!("File not found: {}", full_path.display()));
            }

            let content = fs::read_to_string(&full_path)
                .map_err(|e| format!("Failed to read file: {}", e))?;

            Ok(json!({"path": path, "content": content}))
        }

        "list_files" => {
            let dir = tool_input["directory"]
                .as_str()
                .unwrap_or("");
            let pattern = tool_input["pattern"]
                .as_str()
                .unwrap_or("*");

            let search_dir = get_data_dir().join(dir);
            if !search_dir.exists() {
                return Ok(json!({"files": [], "message": "Directory not found"}));
            }

            let glob_pattern = search_dir.join(pattern);
            let mut files: Vec<String> = Vec::new();

            if let Ok(entries) = glob::glob(glob_pattern.to_str().unwrap_or("")) {
                for entry in entries.flatten() {
                    if let Some(name) = entry.file_name() {
                        files.push(name.to_string_lossy().to_string());
                    }
                }
            }

            files.sort();
            Ok(json!({"files": files, "count": files.len()}))
        }

        _ => Err(format!("Unknown tool: {}", tool_name)),
    }
}

pub fn get_tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "query_database",
            "description": "Run a read-only SQL query against the thyself.db SQLite database. Returns rows as JSON. Use this to explore the user's life data and to verify claims about their history or patterns before stating them. Always check the corrections table when referencing extraction or synthesis data. Supports SELECT and WITH queries only.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "The SQL query to execute (SELECT/WITH only)"
                    },
                    "params": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional bind parameters for the query"
                    }
                },
                "required": ["sql"]
            }
        }),
        json!({
            "name": "write_correction",
            "description": "Record a correction when the user pushes back or provides context the data doesn't capture. Don't just pivot to a new interpretation — record what was wrong and why. Types: person_confusion, attribution_error, factual_error, dataset_caveat, framing_error.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "correction_type": {
                        "type": "string",
                        "enum": ["person_confusion", "attribution_error", "factual_error", "dataset_caveat", "framing_error"],
                        "description": "Type of correction"
                    },
                    "layer": {
                        "type": "string",
                        "enum": ["extraction", "synthesis"],
                        "description": "Which processing layer the error is in"
                    },
                    "target": {
                        "type": "string",
                        "description": "What's wrong (e.g. table.column or specific claim)"
                    },
                    "original_claim": {
                        "type": "string",
                        "description": "What the data currently says"
                    },
                    "corrected_claim": {
                        "type": "string",
                        "description": "What the user says is actually true"
                    },
                    "evidence": {
                        "type": "string",
                        "description": "Evidence or context for the correction"
                    },
                    "months_affected": {
                        "type": "string",
                        "description": "JSON array of YYYY-MM months affected, e.g. [\"2024-03\", \"2024-04\"]"
                    }
                },
                "required": ["correction_type", "layer", "target", "original_claim", "corrected_claim"]
            }
        }),
        json!({
            "name": "read_session_files",
            "description": "Read previous session markdown files for context. Use this to check prior session context before making claims about previous conversations or established patterns. Call this at the start of every conversation and again mid-conversation when referencing prior sessions.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "write_session_file",
            "description": "Write a session summary at the end of a conversation. Provide a short descriptive title, a dated filename, and markdown content summarizing key insights, corrections, open questions, and next steps. Do NOT include the conversation transcript — just the summary.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short descriptive session title, e.g. 'Exploring relationship patterns with Dad'"
                    },
                    "filename": {
                        "type": "string",
                        "description": "Filename like session_YYYY-MM-DD.md"
                    },
                    "content": {
                        "type": "string",
                        "description": "Markdown summary — key insights, corrections recorded, open questions, next steps. Do NOT include the conversation transcript."
                    },
                    "session_id": {
                        "type": "string",
                        "description": "The active session ID (provided in the system prompt). Pass this to link the summary to the current session."
                    }
                },
                "required": ["title", "filename", "content"]
            }
        }),
        json!({
            "name": "read_file",
            "description": "Read any file from the data directory (extraction results, synthesis output, etc.)",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from data dir (e.g. 'synthesis_results/synthesis_merged.json')"
                    }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "list_files",
            "description": "List files in a directory within the data directory",
            "input_schema": {
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": "Relative directory path (e.g. 'sessions', 'extraction_results')"
                    },
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern for filtering (e.g. '*.md', '*.json'). Default: '*'"
                    }
                },
                "required": ["directory"]
            }
        }),
    ]
}
