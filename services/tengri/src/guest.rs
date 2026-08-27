use std::pin::Pin;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures::{Stream, StreamExt};
use k8s_openapi::api::core::v1::Secret;
use kube::{Api, Client, ResourceExt};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use thiserror::Error;

use crate::crd::{MicroVM, MicroVMPhase};

const GUEST_API_PORT: u16 = 8080;
const BOOTSTRAP_TOKEN_KEY: &str = "token";
const MAX_GUEST_ERROR_BYTES: usize = 64 << 10;
const MAX_GUEST_FILE_BYTES: usize = 4 << 20;
const MAX_GUEST_JSON_BYTES: usize = 10 << 20;
const MAX_GUEST_STREAM_LINE_BYTES: usize = 3 << 20;

#[derive(Debug, Error)]
pub enum GuestError {
    #[error("Kubernetes API request failed: {0}")]
    Kubernetes(#[from] kube::Error),
    #[error("MicroVM {0} is not ready")]
    NotReady(String),
    #[error("MicroVM {0} has no guest IP")]
    MissingGuestIp(String),
    #[error("bootstrap secret {0} is missing token data")]
    MissingToken(String),
    #[error("Nanoagent API request failed: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("Nanoagent API returned {status}: {message}")]
    Api { status: StatusCode, message: String },
    #[error("Nanoagent stream returned invalid UTF-8")]
    InvalidUtf8,
    #[error("Nanoagent returned invalid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("Nanoagent response exceeded the {0}-byte limit")]
    ResponseTooLarge(usize),
}

#[derive(Clone)]
pub struct GuestClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub size: i64,
    pub modified_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug)]
pub struct FileContent {
    pub path: String,
    pub content: Vec<u8>,
    pub content_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub size: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEvent {
    pub sequence: u64,
    pub kind: String,
    pub path: String,
    #[serde(default)]
    pub previous_path: String,
    #[serde(default)]
    pub entry: Option<FileEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub cwd: String,
    pub created_at: String,
    pub last_activity_at: String,
    pub attached: bool,
}

#[derive(Debug, Deserialize)]
struct TerminalList {
    sessions: Vec<TerminalSession>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexEvent {
    pub sequence: u64,
    pub method: String,
    #[serde(default)]
    pub approval_id: String,
    pub raw: Value,
}

#[derive(Debug, Deserialize)]
struct CodexCallResponse {
    result: Value,
}

impl GuestClient {
    pub async fn for_agent(
        client: Client,
        namespace: &str,
        agent_id: &str,
    ) -> Result<Self, GuestError> {
        let microvms: Api<MicroVM> = Api::namespaced(client.clone(), namespace);
        let microvm = microvms.get(agent_id).await?;
        let status = microvm
            .status
            .as_ref()
            .filter(|status| {
                status.phase == MicroVMPhase::Ready
                    && status.guest_ready
                    && status.observed_generation >= microvm.metadata.generation.unwrap_or_default()
            })
            .ok_or_else(|| GuestError::NotReady(agent_id.to_owned()))?;
        let guest_ip = status
            .pod_ip
            .as_ref()
            .ok_or_else(|| GuestError::MissingGuestIp(agent_id.to_owned()))?;
        let secret_name = format!("{}-bootstrap", microvm.name_any());
        let secrets: Api<Secret> = Api::namespaced(client, namespace);
        let secret = secrets.get(&secret_name).await?;
        let token_bytes = secret
            .data
            .as_ref()
            .and_then(|data| data.get(BOOTSTRAP_TOKEN_KEY))
            .ok_or_else(|| GuestError::MissingToken(secret_name.clone()))?;
        let token = String::from_utf8(token_bytes.0.clone())
            .map_err(|_| GuestError::MissingToken(secret_name))?;

        Ok(Self {
            http: reqwest::Client::builder().build()?,
            base_url: format!("http://{guest_ip}:{GUEST_API_PORT}"),
            token,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub async fn list_files(&self, path: &str) -> Result<FileList, GuestError> {
        self.json(
            self.request(Method::GET, "/v1/files")
                .query(&[("path", path)]),
        )
        .await
    }

    pub async fn read_file(&self, path: &str) -> Result<FileContent, GuestError> {
        let response = checked_response(
            self.request(Method::GET, "/v1/files/content")
                .query(&[("path", path)])
                .send()
                .await?,
        )
        .await?;
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_owned();
        let content = bounded_response_body(response, MAX_GUEST_FILE_BYTES).await?;
        Ok(FileContent {
            path: path.to_owned(),
            content,
            content_type,
        })
    }

    pub async fn write_file(&self, path: &str, content: &[u8]) -> Result<WriteResult, GuestError> {
        self.json(
            self.request(Method::PUT, "/v1/files/content")
                .json(&serde_json::json!({"path": path, "content": BASE64.encode(content)})),
        )
        .await
    }

    pub async fn create_directory(&self, path: &str) -> Result<FileEntry, GuestError> {
        self.json(
            self.request(Method::POST, "/v1/files/directory")
                .json(&serde_json::json!({"path": path})),
        )
        .await
    }

    pub async fn move_file(
        &self,
        source_path: &str,
        destination_path: &str,
    ) -> Result<FileEntry, GuestError> {
        self.json(
            self.request(Method::POST, "/v1/files/move")
                .json(&serde_json::json!({
                    "sourcePath": source_path,
                    "destinationPath": destination_path,
                })),
        )
        .await
    }

    pub async fn delete_file(&self, path: &str, recursive: bool) -> Result<(), GuestError> {
        checked_response(
            self.request(Method::DELETE, "/v1/files")
                .json(&serde_json::json!({"path": path, "recursive": recursive}))
                .send()
                .await?,
        )
        .await?;
        Ok(())
    }

    pub async fn search_files(
        &self,
        query: &str,
        path: &str,
        limit: u32,
    ) -> Result<Vec<FileEntry>, GuestError> {
        #[derive(Deserialize)]
        struct SearchResponse {
            entries: Vec<FileEntry>,
        }
        let result: SearchResponse = self
            .json(self.request(Method::GET, "/v1/files/search").query(&[
                ("query", query.to_owned()),
                ("path", path.to_owned()),
                ("limit", limit.to_string()),
            ]))
            .await?;
        Ok(result.entries)
    }

    pub async fn watch_files(
        &self,
        path: &str,
        after: u64,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<FileEvent, GuestError>> + Send>>, GuestError> {
        self.ndjson(
            self.request(Method::GET, "/v1/files/watch")
                .query(&[("path", path.to_owned()), ("after", after.to_string())]),
        )
        .await
    }

    pub async fn create_terminal(
        &self,
        cwd: &str,
        columns: u32,
        rows: u32,
    ) -> Result<TerminalSession, GuestError> {
        self.json(
            self.request(Method::POST, "/v1/terminals")
                .json(&serde_json::json!({"cwd": cwd, "columns": columns, "rows": rows})),
        )
        .await
    }

    pub async fn list_terminals(&self) -> Result<Vec<TerminalSession>, GuestError> {
        let response: TerminalList = self
            .json(self.request(Method::GET, "/v1/terminals"))
            .await?;
        Ok(response.sessions)
    }

    pub async fn terminate_terminal(&self, id: &str) -> Result<(), GuestError> {
        checked_response(
            self.request(Method::DELETE, &format!("/v1/terminals/{id}"))
                .send()
                .await?,
        )
        .await?;
        Ok(())
    }

    pub async fn codex_call(&self, method: &str, params: Value) -> Result<Value, GuestError> {
        let response: CodexCallResponse = self
            .json(
                self.request(Method::POST, "/v1/codex/call")
                    .json(&serde_json::json!({"method": method, "params": params})),
            )
            .await?;
        Ok(response.result)
    }

    pub async fn resolve_codex_approval(
        &self,
        approval_id: &str,
        decision: &str,
    ) -> Result<(), GuestError> {
        checked_response(
            self.request(Method::POST, &format!("/v1/codex/approvals/{approval_id}"))
                .json(&serde_json::json!({"decision": decision}))
                .send()
                .await?,
        )
        .await?;
        Ok(())
    }

    pub async fn watch_codex_events(
        &self,
        after: u64,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<CodexEvent, GuestError>> + Send>>, GuestError>
    {
        self.ndjson(
            self.request(Method::GET, "/v1/codex/events")
                .query(&[("after", after.to_string())]),
        )
        .await
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.base_url))
            .bearer_auth(&self.token)
    }

    async fn json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, GuestError> {
        let response = checked_response(request.send().await?).await?;
        let body = bounded_response_body(response, MAX_GUEST_JSON_BYTES).await?;
        Ok(serde_json::from_slice(&body)?)
    }

    async fn ndjson<T: DeserializeOwned + Send + 'static>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<T, GuestError>> + Send>>, GuestError> {
        let response = checked_response(request.send().await?).await?;
        let mut bytes = response.bytes_stream();
        let stream = async_stream::try_stream! {
            let mut buffer = Vec::new();
            while let Some(chunk) = bytes.next().await {
                buffer.extend_from_slice(&chunk?);
                for line in drain_ndjson_lines(&mut buffer, MAX_GUEST_STREAM_LINE_BYTES)? {
                    let line = std::str::from_utf8(&line)
                        .map_err(|_| GuestError::InvalidUtf8)?
                        .trim();
                    if !line.is_empty() {
                        yield serde_json::from_str::<T>(line)?;
                    }
                }
            }
            if !buffer.is_empty() {
                let line = std::str::from_utf8(&buffer).map_err(|_| GuestError::InvalidUtf8)?.trim();
                if !line.is_empty() {
                    yield serde_json::from_str::<T>(line)?;
                }
            }
        };
        Ok(Box::pin(stream))
    }
}

fn drain_ndjson_lines(buffer: &mut Vec<u8>, limit: usize) -> Result<Vec<Vec<u8>>, GuestError> {
    let mut lines = Vec::new();
    while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
        if newline > limit {
            return Err(GuestError::ResponseTooLarge(limit));
        }
        let mut line = buffer.drain(..=newline).collect::<Vec<_>>();
        line.pop();
        lines.push(line);
    }
    if buffer.len() > limit {
        return Err(GuestError::ResponseTooLarge(limit));
    }
    Ok(lines)
}

async fn checked_response(response: reqwest::Response) -> Result<reqwest::Response, GuestError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let message = bounded_response_body(response, MAX_GUEST_ERROR_BYTES)
        .await
        .ok()
        .and_then(|body| String::from_utf8(body).ok())
        .unwrap_or_else(|| {
            "Nanoagent request failed without a valid bounded response body".to_owned()
        });
    Err(GuestError::Api { status, message })
}

async fn bounded_response_body(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, GuestError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(GuestError::ResponseTooLarge(limit));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(GuestError::ResponseTooLarge(limit));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn guest_response_body_is_bounded_before_and_during_streaming() {
        let declared: reqwest::Response = http::Response::builder()
            .header(http::header::CONTENT_LENGTH, "5")
            .body("12345")
            .expect("declared response")
            .into();
        assert!(matches!(
            bounded_response_body(declared, 4).await,
            Err(GuestError::ResponseTooLarge(4))
        ));

        let streamed: reqwest::Response = http::Response::builder()
            .body("12345")
            .expect("streamed response")
            .into();
        assert!(matches!(
            bounded_response_body(streamed, 4).await,
            Err(GuestError::ResponseTooLarge(4))
        ));
    }

    #[test]
    fn ndjson_limit_applies_to_remainder_after_complete_lines() {
        let mut buffer = b"{}\n12345".to_vec();
        assert!(matches!(
            drain_ndjson_lines(&mut buffer, 4),
            Err(GuestError::ResponseTooLarge(4))
        ));
    }
}
