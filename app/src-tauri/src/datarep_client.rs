use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:7080";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum DatarepResponse {
    #[serde(rename = "success")]
    Success { result: Value },
    #[serde(rename = "action_required")]
    ActionRequired {
        action_type: String,
        source: String,
        explanation: String,
        #[serde(default)]
        steps: Vec<String>,
        deep_link: Option<String>,
        #[serde(default = "default_true")]
        retryable: bool,
        context: Option<Value>,
    },
    #[serde(rename = "question")]
    Question {
        session_id: String,
        question: String,
    },
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatarepSource {
    pub name: String,
    pub source_type: String,
    pub config: Value,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatarepRecipe {
    pub id: String,
    pub source_name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub times_used: i64,
}

struct SseEvent {
    event_type: String,
    data: String,
}

fn extract_sse_event(buffer: &mut String) -> Option<SseEvent> {
    let pos = buffer.find("\n\n")?;
    let raw = buffer[..pos].to_string();
    *buffer = buffer[pos + 2..].to_string();

    let mut event_type = String::new();
    let mut data_parts: Vec<&str> = Vec::new();

    for line in raw.lines() {
        if let Some(val) = line.strip_prefix("event: ") {
            event_type = val.trim().to_string();
        } else if let Some(val) = line.strip_prefix("data: ") {
            data_parts.push(val);
        }
    }

    if event_type.is_empty() && data_parts.is_empty() {
        return None;
    }

    Some(SseEvent {
        event_type,
        data: data_parts.join("\n"),
    })
}

pub struct DatarepClient {
    client: Client,
    base_url: String,
    api_key: String,
}

impl DatarepClient {
    pub fn new(api_key: String) -> Self {
        Self {
            client: Client::new(),
            base_url: DEFAULT_BASE_URL.to_string(),
            api_key,
        }
    }

    pub fn from_profile() -> Result<Self, String> {
        let key = crate::profiles::get_datarep_api_key()
            .ok_or("No datarep API key configured. Run check_datarep first.")?;
        Ok(Self::new(key))
    }

    pub async fn health(&self) -> Result<bool, String> {
        let resp = self
            .client
            .get(format!("{}/health", self.base_url))
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await
            .map_err(|e| format!("datarep not reachable: {}", e))?;
        Ok(resp.status().is_success())
    }

    pub async fn get(&self, source: &str, query: &str) -> Result<DatarepResponse, String> {
        let resp = self
            .client
            .post(format!("{}/get", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&serde_json::json!({ "source": source, "query": query }))
            .timeout(std::time::Duration::from_secs(600))
            .send()
            .await
            .map_err(|e| format!("datarep /get failed: {}", e))?;

        self.parse_response(resp).await
    }

    pub async fn sync(
        &self,
        source: &str,
        query: Option<&str>,
    ) -> Result<DatarepResponse, String> {
        let mut body = serde_json::json!({ "source": source });
        if let Some(q) = query {
            body["query"] = Value::String(q.to_string());
        }

        let resp = self
            .client
            .post(format!("{}/sync", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&body)
            .timeout(std::time::Duration::from_secs(600))
            .send()
            .await
            .map_err(|e| format!("datarep /sync failed: {}", e))?;

        self.parse_response(resp).await
    }

    pub async fn list_sources(&self) -> Result<Vec<DatarepSource>, String> {
        let resp = self
            .client
            .get(format!("{}/sources", self.base_url))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| format!("datarep /sources failed: {}", e))?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("datarep /sources returned error: {}", text));
        }

        resp.json::<Vec<DatarepSource>>()
            .await
            .map_err(|e| format!("Failed to parse sources response: {}", e))
    }

    pub async fn register_source(
        &self,
        name: &str,
        source_type: &str,
        config: Value,
    ) -> Result<Value, String> {
        let resp = self
            .client
            .post(format!("{}/sources", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&serde_json::json!({
                "name": name,
                "source_type": source_type,
                "config": config,
            }))
            .send()
            .await
            .map_err(|e| format!("datarep source registration failed: {}", e))?;

        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse register_source response: {}", e))?;

        if status.is_success() || status.as_u16() == 409 {
            Ok(body)
        } else {
            Err(format!(
                "datarep source registration failed ({}): {}",
                status,
                body.get("detail").and_then(|d| d.as_str()).unwrap_or("unknown error")
            ))
        }
    }

    pub async fn initiate_oauth(&self, source: &str) -> Result<Value, String> {
        let resp = self
            .client
            .post(format!("{}/auth/oauth", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&serde_json::json!({ "source": source }))
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| format!("datarep OAuth initiation failed: {}", e))?;

        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse OAuth response: {}", e))?;

        if status.is_success() {
            Ok(body)
        } else {
            Err(format!(
                "datarep OAuth failed ({}): {}",
                status,
                body.get("detail").and_then(|d| d.as_str()).unwrap_or("unknown error")
            ))
        }
    }

    pub async fn store_credentials(
        &self,
        source: &str,
        cred_type: &str,
        data: Value,
    ) -> Result<Value, String> {
        let resp = self
            .client
            .post(format!("{}/auth/credentials", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&serde_json::json!({
                "source": source,
                "cred_type": cred_type,
                "data": data,
            }))
            .send()
            .await
            .map_err(|e| format!("datarep credential storage failed: {}", e))?;

        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse credentials response: {}", e))?;

        if status.is_success() {
            Ok(body)
        } else {
            Err(format!(
                "datarep credential storage failed ({}): {}",
                status,
                body.get("detail").and_then(|d| d.as_str()).unwrap_or("unknown error")
            ))
        }
    }

    pub async fn list_recipes(
        &self,
        source: Option<&str>,
    ) -> Result<Vec<DatarepRecipe>, String> {
        let mut url = format!("{}/recipes", self.base_url);
        if let Some(s) = source {
            url = format!("{}?source={}", url, s);
        }

        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| format!("datarep /recipes failed: {}", e))?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("datarep /recipes returned error: {}", text));
        }

        resp.json::<Vec<DatarepRecipe>>()
            .await
            .map_err(|e| format!("Failed to parse recipes response: {}", e))
    }

    pub async fn run_recipe(&self, recipe_id: &str) -> Result<DatarepResponse, String> {
        let resp = self
            .client
            .post(format!("{}/recipe/run", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&serde_json::json!({ "recipe_id": recipe_id }))
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await
            .map_err(|e| format!("datarep recipe run failed: {}", e))?;

        self.parse_response(resp).await
    }

    pub async fn get_streaming(
        &self,
        source: &str,
        query: &str,
    ) -> Result<DatarepResponse, String> {
        let resp = self
            .client
            .post(format!("{}/get", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&serde_json::json!({
                "source": source,
                "query": query,
                "stream": true
            }))
            .timeout(std::time::Duration::from_secs(600))
            .send()
            .await
            .map_err(|e| format!("datarep /get failed: {}", e))?;

        self.parse_sse_stream(resp).await
    }

    pub async fn reply(
        &self,
        session_id: &str,
        answer: &str,
    ) -> Result<DatarepResponse, String> {
        let resp = self
            .client
            .post(format!(
                "{}/sessions/{}/reply",
                self.base_url, session_id
            ))
            .bearer_auth(&self.api_key)
            .json(&serde_json::json!({
                "answer": answer,
                "stream": true
            }))
            .timeout(std::time::Duration::from_secs(600))
            .send()
            .await
            .map_err(|e| {
                format!("datarep /sessions/{}/reply failed: {}", session_id, e)
            })?;

        if resp.status().as_u16() == 404 {
            return Err(format!("Session '{}' not found", session_id));
        }

        self.parse_sse_stream(resp).await
    }

    pub async fn stream_data(
        &self,
        recipe_id: &str,
    ) -> Result<reqwest::Response, String> {
        let resp = self
            .client
            .get(format!("{}/data/{}", self.base_url, recipe_id))
            .bearer_auth(&self.api_key)
            .timeout(std::time::Duration::from_secs(3600))
            .send()
            .await
            .map_err(|e| format!("datarep /data/{} failed: {}", recipe_id, e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "datarep /data/{} returned {}: {}",
                recipe_id, status, text
            ));
        }

        Ok(resp)
    }

    pub async fn stream_data_retry(
        &self,
        recipe_id: &str,
    ) -> Result<Option<reqwest::Response>, String> {
        let resp = self
            .client
            .get(format!("{}/data/{}/retry", self.base_url, recipe_id))
            .bearer_auth(&self.api_key)
            .timeout(std::time::Duration::from_secs(3600))
            .send()
            .await
            .map_err(|e| {
                format!("datarep /data/{}/retry failed: {}", recipe_id, e)
            })?;

        if resp.status().as_u16() == 404 {
            return Ok(None);
        }

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "datarep /data/{}/retry returned {}: {}",
                recipe_id, status, text
            ));
        }

        Ok(Some(resp))
    }

    async fn parse_sse_stream(
        &self,
        resp: reqwest::Response,
    ) -> Result<DatarepResponse, String> {
        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|e| format!("SSE stream error: {}", e))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(event) = extract_sse_event(&mut buffer) {
                match event.event_type.as_str() {
                    "question" => {
                        let data: Value =
                            serde_json::from_str(&event.data).map_err(|e| {
                                format!("Failed to parse question event: {}", e)
                            })?;
                        return Ok(DatarepResponse::Question {
                            session_id: data["session_id"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                            question: data["question"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                        });
                    }
                    "result" => {
                        let data: Value =
                            serde_json::from_str(&event.data).map_err(|e| {
                                format!("Failed to parse result event: {}", e)
                            })?;
                        return self.parse_response_value(&data);
                    }
                    _ => continue,
                }
            }
        }

        Err("SSE stream ended without a result or question event".to_string())
    }

    fn parse_response_value(
        &self,
        body: &Value,
    ) -> Result<DatarepResponse, String> {
        match body.get("status").and_then(|s| s.as_str()) {
            Some("success") => Ok(DatarepResponse::Success {
                result: body.get("result").cloned().unwrap_or(Value::Null),
            }),
            Some("question") => Ok(DatarepResponse::Question {
                session_id: body["session_id"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                question: body["question"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
            }),
            Some("action_required") => Ok(DatarepResponse::ActionRequired {
                action_type: body["action_type"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string(),
                source: body["source"].as_str().unwrap_or("").to_string(),
                explanation: body["explanation"]
                    .as_str()
                    .unwrap_or("Action required")
                    .to_string(),
                steps: body["steps"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
                deep_link: body["deep_link"].as_str().map(String::from),
                retryable: body["retryable"].as_bool().unwrap_or(true),
                context: body.get("context").cloned(),
            }),
            Some("error") => Err(format!(
                "datarep error: {}",
                body.get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown")
            )),
            _ => Ok(DatarepResponse::Success {
                result: body.clone(),
            }),
        }
    }

    async fn parse_response(
        &self,
        resp: reqwest::Response,
    ) -> Result<DatarepResponse, String> {
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse datarep response: {}", e))?;

        let result = self.parse_response_value(&body);
        if result.is_ok() {
            return result;
        }

        if status.is_success() {
            Ok(DatarepResponse::Success { result: body })
        } else {
            Err(format!(
                "datarep error ({}): {}",
                status,
                body.get("detail")
                    .and_then(|d| d.as_str())
                    .unwrap_or(&body.to_string())
            ))
        }
    }
}
