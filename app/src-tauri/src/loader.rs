use rusqlite::Connection;
use serde_json::Value;

pub struct ImportResult {
    pub messages: i64,
    pub conversations: i64,
    pub contacts: i64,
    pub earliest: Option<String>,
    pub latest: Option<String>,
}

/// Load messages from datarep JSON lines output into thyself.db.
/// Each line is a JSON object with fields that vary by source.
/// Common fields: content/text, sent_at, is_from_me, sender_name,
/// sender_phone_or_email, conversation_id, source_message_id.
pub fn load_messages_from_json(
    db_path: &std::path::Path,
    json_lines: &str,
    source: &str,
) -> Result<ImportResult, String> {
    let conn = Connection::open(db_path)
        .map_err(|e| format!("Failed to open thyself.db: {}", e))?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

    let mut messages_added: i64 = 0;
    let mut conversations_seen = std::collections::HashSet::new();
    let mut contacts_seen = std::collections::HashSet::new();
    let mut earliest: Option<String> = None;
    let mut latest: Option<String> = None;

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    for line in json_lines.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let record: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match source {
            "imessage" | "whatsapp" | "whatsapp_desktop" | "whatsapp_backup" => {
                messages_added += load_message_record(&tx, &record, source, &mut conversations_seen, &mut contacts_seen)?;
            }
            "gmail" => {
                messages_added += load_gmail_record(&tx, &record)?;
            }
            "chatgpt" => {
                messages_added += load_chatgpt_record(&tx, &record)?;
            }
            _ => {
                messages_added += load_message_record(&tx, &record, source, &mut conversations_seen, &mut contacts_seen)?;
            }
        }

        let sent_at = record
            .get("sent_at")
            .or_else(|| record.get("timestamp"))
            .and_then(|v| v.as_str())
            .map(String::from);

        if let Some(ref ts) = sent_at {
            if earliest.as_ref().map_or(true, |e| ts < e) {
                earliest = Some(ts.clone());
            }
            if latest.as_ref().map_or(true, |l| ts > l) {
                latest = Some(ts.clone());
            }
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(ImportResult {
        messages: messages_added,
        conversations: conversations_seen.len() as i64,
        contacts: contacts_seen.len() as i64,
        earliest,
        latest,
    })
}

fn load_message_record(
    conn: &Connection,
    record: &Value,
    source: &str,
    conversations_seen: &mut std::collections::HashSet<String>,
    contacts_seen: &mut std::collections::HashSet<String>,
) -> Result<i64, String> {
    let source_id = record
        .get("source_message_id")
        .or_else(|| record.get("source_id"))
        .or_else(|| record.get("id"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let source_label = match source {
        "whatsapp_desktop" | "whatsapp_backup" => "whatsapp",
        other => other,
    };

    if let Some(ref sid) = source_id {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE source = ?1 AND source_id = ?2)",
                rusqlite::params![source_label, sid],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if exists {
            return Ok(0);
        }
    }

    let content = record
        .get("content")
        .or_else(|| record.get("text"))
        .or_else(|| record.get("body"))
        .and_then(|v| v.as_str());

    let sent_at = record
        .get("sent_at")
        .or_else(|| record.get("timestamp"))
        .and_then(|v| v.as_str());

    let is_from_me = record
        .get("is_from_me")
        .and_then(|v| v.as_bool())
        .or_else(|| record.get("is_from_me").and_then(|v| v.as_i64()).map(|i| i != 0));

    let sender_name = record
        .get("sender_name")
        .or_else(|| record.get("sender"))
        .and_then(|v| v.as_str());

    let sender_id = record
        .get("sender_phone_or_email")
        .or_else(|| record.get("sender_phone"))
        .or_else(|| record.get("sender_email"))
        .and_then(|v| v.as_str());

    let conv_id_str = record
        .get("conversation_id")
        .and_then(|v| v.as_str())
        .map(String::from);

    let contact_id = if let Some(name) = sender_name {
        let key = sender_id.unwrap_or(name);
        contacts_seen.insert(key.to_string());
        Some(upsert_contact(conn, sender_name, sender_id, source_label)?)
    } else {
        None
    };

    let conversation_id = if let Some(ref cid) = conv_id_str {
        conversations_seen.insert(cid.clone());
        Some(upsert_conversation(conn, cid, source_label)?)
    } else {
        None
    };

    let word_count = content.map(|c| c.split_whitespace().count() as i64);

    conn.execute(
        "INSERT INTO messages (conversation_id, contact_id, source, source_id, is_from_me, content, sent_at, word_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![conversation_id, contact_id, source_label, source_id, is_from_me, content, sent_at, word_count],
    )
    .map_err(|e| format!("Failed to insert message: {}", e))?;

    Ok(1)
}

fn load_gmail_record(conn: &Connection, record: &Value) -> Result<i64, String> {
    let gmail_id = record
        .get("gmail_id")
        .or_else(|| record.get("id"))
        .or_else(|| record.get("message_id"))
        .and_then(|v| v.as_str());

    let gmail_id = match gmail_id {
        Some(id) => id,
        None => return Ok(0),
    };

    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM gmail_messages WHERE gmail_id = ?1)",
            [gmail_id],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if exists {
        return Ok(0);
    }

    let thread_id = record
        .get("thread_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let subject = record.get("subject").and_then(|v| v.as_str());
    let from_addr = record.get("from_addr").or_else(|| record.get("from")).and_then(|v| v.as_str());
    let from_name = record.get("from_name").and_then(|v| v.as_str());
    let to_addrs = record.get("to_addrs").or_else(|| record.get("to"));
    let to_str = to_addrs.map(|v| {
        if v.is_string() {
            v.as_str().unwrap_or("").to_string()
        } else {
            v.to_string()
        }
    });
    let sent_at = record.get("sent_at").or_else(|| record.get("date")).and_then(|v| v.as_str());
    let body_text = record
        .get("body_text")
        .or_else(|| record.get("body"))
        .or_else(|| record.get("content"))
        .and_then(|v| v.as_str());
    let is_from_me = record.get("is_from_me").and_then(|v| v.as_bool());
    let word_count = body_text.map(|b| b.split_whitespace().count() as i64);

    conn.execute(
        "INSERT OR IGNORE INTO gmail_messages (gmail_id, thread_id, subject, from_addr, from_name, to_addrs, sent_at, body_text, word_count, is_from_me)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![gmail_id, thread_id, subject, from_addr, from_name, to_str, sent_at, body_text, word_count, is_from_me],
    )
    .map_err(|e| format!("Failed to insert gmail message: {}", e))?;

    Ok(1)
}

fn load_chatgpt_record(conn: &Connection, record: &Value) -> Result<i64, String> {
    let msg_id = record
        .get("id")
        .or_else(|| record.get("message_id"))
        .and_then(|v| v.as_str());

    let msg_id = match msg_id {
        Some(id) => id,
        None => return Ok(0),
    };

    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM chatgpt_messages WHERE id = ?1)",
            [msg_id],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if exists {
        return Ok(0);
    }

    let conversation_id = record
        .get("conversation_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if let Some(title) = record.get("conversation_title").and_then(|v| v.as_str()) {
        conn.execute(
            "INSERT OR IGNORE INTO chatgpt_conversations (id, title) VALUES (?1, ?2)",
            rusqlite::params![conversation_id, title],
        )
        .ok();
    }

    let role = record.get("role").and_then(|v| v.as_str()).unwrap_or("unknown");
    let text = record.get("text").or_else(|| record.get("content")).and_then(|v| v.as_str());
    let create_time = record.get("create_time").and_then(|v| v.as_f64());

    conn.execute(
        "INSERT OR IGNORE INTO chatgpt_messages (id, conversation_id, role, text, create_time)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![msg_id, conversation_id, role, text, create_time],
    )
    .map_err(|e| format!("Failed to insert chatgpt message: {}", e))?;

    Ok(1)
}

fn upsert_contact(
    conn: &Connection,
    name: Option<&str>,
    identifier: Option<&str>,
    source: &str,
) -> Result<i64, String> {
    if let Some(ident) = identifier {
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM contacts WHERE phone = ?1 OR email = ?1 OR imessage_handle = ?1 OR whatsapp_jid = ?1",
                [ident],
                |row| row.get(0),
            )
            .ok();

        if let Some(id) = existing {
            return Ok(id);
        }
    }

    if let Some(n) = name {
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM contacts WHERE display_name = ?1",
                [n],
                |row| row.get(0),
            )
            .ok();
        if let Some(id) = existing {
            return Ok(id);
        }
    }

    let handle_col = match source {
        "imessage" => "imessage_handle",
        "whatsapp" => "whatsapp_jid",
        _ => "phone",
    };

    let is_phone = identifier.map_or(false, |i| i.starts_with('+') || i.chars().all(|c| c.is_ascii_digit()));
    let is_email = identifier.map_or(false, |i| i.contains('@'));

    conn.execute(
        &format!(
            "INSERT INTO contacts (display_name, phone, email, {}) VALUES (?1, ?2, ?3, ?4)",
            handle_col
        ),
        rusqlite::params![
            name,
            if is_phone { identifier } else { None },
            if is_email { identifier } else { None },
            identifier,
        ],
    )
    .map_err(|e| format!("Failed to insert contact: {}", e))?;

    Ok(conn.last_insert_rowid())
}

fn upsert_conversation(
    conn: &Connection,
    source_id: &str,
    source: &str,
) -> Result<i64, String> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM conversations WHERE source = ?1 AND source_id = ?2",
            rusqlite::params![source, source_id],
            |row| row.get(0),
        )
        .ok();

    if let Some(id) = existing {
        return Ok(id);
    }

    conn.execute(
        "INSERT INTO conversations (source, source_id) VALUES (?1, ?2)",
        rusqlite::params![source, source_id],
    )
    .map_err(|e| format!("Failed to insert conversation: {}", e))?;

    Ok(conn.last_insert_rowid())
}
