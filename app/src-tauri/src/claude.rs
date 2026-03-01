use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CLAUDE_API_URL: &str = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL: &str = "claude-sonnet-4-20250514";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEvent {
    pub event_type: String,
    pub data: Value,
}

/// Streams a chat request to the Claude API.
/// `emit_fn` is called for each SSE event — callers provide the transport
/// (Tauri app.emit, HTTP SSE channel, etc.).
pub async fn stream_chat_request(
    emit_fn: &(dyn Fn(&str, &str, &Value) + Send + Sync),
    api_key: &str,
    messages: Vec<Value>,
    system_prompt: &str,
    tools: Vec<Value>,
    stream_id: &str,
) -> Result<Value, String> {
    let client = Client::new();
    let model = std::env::var("THYSELF_CHAT_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());

    let mut body = json!({
        "model": model,
        "max_tokens": 16384,
        "stream": true,
        "system": system_prompt,
        "messages": messages,
        "thinking": {
            "type": "enabled",
            "budget_tokens": 8000
        }
    });

    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }

    let response = client
        .post(CLAUDE_API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "interleaved-thinking-2025-05-14")
        .header("content-type", "application/json")
        .body(serde_json::to_string(&body).unwrap())
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let err_body = response.text().await.unwrap_or_default();
        return Err(format!("API error {}: {}", status, err_body));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut full_response = json!({
        "content": [],
        "stop_reason": null
    });
    let mut content_blocks: Vec<Value> = Vec::new();
    let mut tool_input_buffers: Vec<String> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(pos) = buffer.find("\n\n") {
            let event_str = buffer[..pos].to_string();
            buffer = buffer[pos + 2..].to_string();

            let mut event_type = String::new();
            let mut event_data = String::new();

            for line in event_str.lines() {
                if let Some(t) = line.strip_prefix("event: ") {
                    event_type = t.to_string();
                } else if let Some(d) = line.strip_prefix("data: ") {
                    event_data = d.to_string();
                }
            }

            if event_type.is_empty() || event_data.is_empty() {
                continue;
            }

            let data: Value = match serde_json::from_str(&event_data) {
                Ok(v) => v,
                Err(_) => continue,
            };

            match event_type.as_str() {
                "content_block_start" => {
                    let block = &data["content_block"];
                    let index = data["index"].as_u64().unwrap_or(0) as usize;
                    while content_blocks.len() <= index {
                        content_blocks.push(Value::Null);
                        tool_input_buffers.push(String::new());
                    }
                    content_blocks[index] = block.clone();
                    tool_input_buffers[index] = String::new();

                    emit_fn(stream_id, "content_block_start", &json!({
                        "index": index,
                        "content_block": block
                    }));
                }
                "content_block_delta" => {
                    let index = data["index"].as_u64().unwrap_or(0) as usize;
                    let delta = &data["delta"];

                    match delta["type"].as_str() {
                        Some("text_delta") => {
                            let text = delta["text"].as_str().unwrap_or("");
                            if let Some(block) = content_blocks.get_mut(index) {
                                if let Some(existing) = block["text"].as_str() {
                                    block["text"] = Value::String(format!("{}{}", existing, text));
                                }
                            }
                            emit_fn(stream_id, "text_delta", &json!({
                                "index": index,
                                "text": text
                            }));
                        }
                        Some("thinking_delta") => {
                            let thinking = delta["thinking"].as_str().unwrap_or("");
                            if let Some(block) = content_blocks.get_mut(index) {
                                if let Some(existing) = block["thinking"].as_str() {
                                    block["thinking"] = Value::String(format!("{}{}", existing, thinking));
                                }
                            }
                            emit_fn(stream_id, "thinking_delta", &json!({
                                "index": index,
                                "thinking": thinking
                            }));
                        }
                        Some("input_json_delta") => {
                            let partial = delta["partial_json"].as_str().unwrap_or("");
                            if index < tool_input_buffers.len() {
                                tool_input_buffers[index].push_str(partial);
                            }
                            emit_fn(stream_id, "tool_input_delta", &json!({
                                "index": index,
                                "partial_json": partial
                            }));
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    let index = data["index"].as_u64().unwrap_or(0) as usize;
                    if let Some(block) = content_blocks.get_mut(index) {
                        if block["type"].as_str() == Some("tool_use") {
                            let json_str = tool_input_buffers.get(index).map(|s| s.as_str()).unwrap_or("{}");
                            if let Ok(input) = serde_json::from_str::<Value>(json_str) {
                                block["input"] = input;
                            }
                        }
                    }
                    emit_fn(stream_id, "content_block_stop", &json!({
                        "index": index,
                        "content_block": content_blocks.get(index).unwrap_or(&Value::Null)
                    }));
                }
                "message_start" => {
                    emit_fn(stream_id, "message_start", &data);
                }
                "message_delta" => {
                    if let Some(reason) = data["delta"]["stop_reason"].as_str() {
                        full_response["stop_reason"] = Value::String(reason.to_string());
                    }
                    emit_fn(stream_id, "message_delta", &data);
                }
                "message_stop" => {
                    // Suppressed: run_chat_loop emits the final message_stop
                    // after the full tool-use loop completes.
                }
                _ => {}
            }
        }
    }

    full_response["content"] = Value::Array(content_blocks);
    Ok(full_response)
}
