use std::{pin::Pin, time::Duration};

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
const GUEST_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const GUEST_UNARY_TIMEOUT: Duration = Duration::from_secs(30);

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
    #[error("Nanoagent does not support atomic Codex snapshot cursors")]
    MissingCodexSnapshotCursor,
    #[error("Nanoagent returned terminal creation identity {actual:?}; expected {expected:?}")]
    TerminalCreationIdentityMismatch { expected: String, actual: String },
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub entries: Vec<FileEntry>,
    #[serde(default)]
    pub truncated: bool,
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
    #[serde(default)]
    pub creation_id: String,
    pub cwd: String,
    pub created_at: String,
    pub last_activity_at: String,
    pub attached: bool,
}

#[derive(Debug)]
pub struct TerminalCreation {
    pub session: TerminalSession,
    pub created: bool,
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
#[serde(rename_all = "camelCase")]
struct CodexCallResponse {
    result: Value,
    #[serde(default)]
    event_sequence: Option<u64>,
}

#[derive(Debug)]
pub struct CodexCallResult {
    pub result: Value,
    pub event_sequence: u64,
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
            http: reqwest::Client::builder()
                .connect_timeout(GUEST_CONNECT_TIMEOUT)
                .build()?,
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
            self.send_unary(
                self.request(Method::GET, "/v1/files/content")
                    .query(&[("path", path)]),
            )
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
            self.send_unary(
                self.request(Method::DELETE, "/v1/files")
                    .json(&serde_json::json!({"path": path, "recursive": recursive})),
            )
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
    ) -> Result<FileSearchResult, GuestError> {
        self.json(self.request(Method::GET, "/v1/files/search").query(&[
            ("query", query.to_owned()),
            ("path", path.to_owned()),
            ("limit", limit.to_string()),
        ]))
        .await
    }

    pub async fn watch_files(
        &self,
        path: &str,
        after: Option<u64>,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<FileEvent, GuestError>> + Send>>, GuestError> {
        self.ndjson(self.file_watch_request(path, after)).await
    }

    fn file_watch_request(&self, path: &str, after: Option<u64>) -> reqwest::RequestBuilder {
        let request = self
            .request(Method::GET, "/v1/files/watch")
            .query(&[("path", path)]);
        match after {
            Some(after) => request.query(&[("after", after)]),
            None => request,
        }
    }

    pub async fn create_terminal(
        &self,
        creation_id: &str,
        cwd: &str,
        columns: u32,
        rows: u32,
    ) -> Result<TerminalCreation, GuestError> {
        let response = match self
            .send_unary(
                self.request(Method::POST, "/v1/terminals")
                    .json(&serde_json::json!({
                        "creationId": creation_id,
                        "cwd": cwd,
                        "columns": columns,
                        "rows": rows
                    })),
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return self
                    .reconcile_terminal_creation_error(creation_id, error)
                    .await;
            }
        };
        match terminal_creation(response, creation_id).await {
            Ok(creation) => Ok(creation),
            Err(error) => {
                self.reconcile_terminal_creation_error(creation_id, error)
                    .await
            }
        }
    }

    async fn reconcile_terminal_creation_error(
        &self,
        creation_id: &str,
        original_error: GuestError,
    ) -> Result<TerminalCreation, GuestError> {
        if let Ok(sessions) = self.list_terminals().await
            && let Some(session) = sessions
                .into_iter()
                .find(|session| session.creation_id == creation_id)
        {
            return Ok(TerminalCreation {
                session,
                created: false,
            });
        }
        Err(original_error)
    }

    pub async fn list_terminals(&self) -> Result<Vec<TerminalSession>, GuestError> {
        let response: TerminalList = self
            .json(self.request(Method::GET, "/v1/terminals"))
            .await?;
        Ok(response.sessions)
    }

    pub async fn terminate_terminal(&self, id: &str) -> Result<(), GuestError> {
        checked_response(
            self.send_unary(self.request(Method::DELETE, &format!("/v1/terminals/{id}")))
                .await?,
        )
        .await?;
        Ok(())
    }

    pub async fn codex_call(&self, method: &str, params: Value) -> Result<Value, GuestError> {
        Ok(self.codex_call_response(method, params).await?.result)
    }

    pub async fn codex_call_with_sequence(
        &self,
        method: &str,
        params: Value,
    ) -> Result<CodexCallResult, GuestError> {
        let response = self.codex_call_response(method, params).await?;
        Ok(CodexCallResult {
            result: response.result,
            event_sequence: response
                .event_sequence
                .ok_or(GuestError::MissingCodexSnapshotCursor)?,
        })
    }

    async fn codex_call_response(
        &self,
        method: &str,
        params: Value,
    ) -> Result<CodexCallResponse, GuestError> {
        self.json(
            self.request(Method::POST, "/v1/codex/call")
                .json(&serde_json::json!({"method": method, "params": params})),
        )
        .await
    }

    pub async fn resolve_codex_approval(
        &self,
        approval_id: &str,
        decision: &str,
    ) -> Result<(), GuestError> {
        checked_response(
            self.send_unary(
                self.request(Method::POST, &format!("/v1/codex/approvals/{approval_id}"))
                    .json(&serde_json::json!({"decision": decision})),
            )
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

    async fn send_unary(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, GuestError> {
        Ok(self.unary_request(request).send().await?)
    }

    fn unary_request(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request.timeout(GUEST_UNARY_TIMEOUT)
    }

    async fn json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, GuestError> {
        let response = checked_response(self.send_unary(request).await?).await?;
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

async fn terminal_creation(
    response: reqwest::Response,
    requested_creation_id: &str,
) -> Result<TerminalCreation, GuestError> {
    let response = checked_response(response).await?;
    let created = response.status() == StatusCode::CREATED;
    let body = bounded_response_body(response, MAX_GUEST_JSON_BYTES).await?;
    let session: TerminalSession = serde_json::from_slice(&body)?;
    if session.creation_id != requested_creation_id {
        return Err(GuestError::TerminalCreationIdentityMismatch {
            expected: requested_creation_id.to_owned(),
            actual: session.creation_id,
        });
    }
    Ok(TerminalCreation { session, created })
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

    use std::collections::HashMap;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use axum::{
        Json, Router,
        routing::{get, post},
    };
    fn terminal_json(creation_id: &str) -> Value {
        serde_json::json!({
            "id": "abcdefghijklmnopqrstuvwx",
            "creationId": creation_id,
            "cwd": "/workspace",
            "createdAt": "2026-08-28T00:00:00Z",
            "lastActivityAt": "2026-08-28T00:00:00Z",
            "attached": false
        })
    }

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

    #[tokio::test]
    async fn file_search_preserves_truncation_metadata() {
        let router = Router::new().route(
            "/v1/files/search",
            get(|| async {
                Json(serde_json::json!({
                    "entries": [{
                        "name": "main.rs",
                        "path": "/workspace/main.rs",
                        "directory": false,
                        "size": 42,
                        "modifiedAt": "2026-08-28T00:00:00Z"
                    }],
                    "truncated": true
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Nanoagent search fixture");
        let address = listener.local_addr().expect("Nanoagent search address");
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve Nanoagent search fixture");
        });
        let client = GuestClient {
            http: reqwest::Client::new(),
            base_url: format!("http://{address}"),
            token: "test-bootstrap-token".to_owned(),
        };

        let result = client
            .search_files("main", "/workspace", 100)
            .await
            .expect("search response");
        assert!(result.truncated);
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].path, "/workspace/main.rs");
        server.abort();
    }

    #[tokio::test]
    async fn legacy_codex_calls_without_snapshot_cursors_remain_compatible() {
        let router = Router::new().route(
            "/v1/codex/call",
            post(|| async { Json(serde_json::json!({"result": {"authenticated": true}})) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind legacy Nanoagent Codex fixture");
        let address = listener
            .local_addr()
            .expect("legacy Nanoagent Codex address");
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve legacy Nanoagent Codex fixture");
        });
        let client = GuestClient {
            http: reqwest::Client::new(),
            base_url: format!("http://{address}"),
            token: "test-bootstrap-token".to_owned(),
        };

        let account = client
            .codex_call("account/read", serde_json::json!({}))
            .await
            .expect("legacy non-snapshot call");
        assert_eq!(account["authenticated"], true);
        assert!(matches!(
            client
                .codex_call_with_sequence(
                    "thread/resume",
                    serde_json::json!({"threadId": "thread"})
                )
                .await,
            Err(GuestError::MissingCodexSnapshotCursor)
        ));
        server.abort();
    }

    #[test]
    fn file_search_accepts_legacy_response_without_truncation_metadata() {
        let result: FileSearchResult = serde_json::from_value(serde_json::json!({"entries": []}))
            .expect("legacy Nanoagent search response");
        assert!(!result.truncated);
    }

    #[tokio::test]
    async fn terminal_creation_distinguishes_new_sessions_from_idempotent_replays() {
        let body = r#"{
            "id":"abcdefghijklmnopqrstuvwx",
            "creationId":"terminal-creation-status",
            "cwd":"/workspace",
            "createdAt":"2026-08-28T00:00:00Z",
            "lastActivityAt":"2026-08-28T00:00:00Z",
            "attached":false
        }"#;
        for (status, expected_created) in [(StatusCode::CREATED, true), (StatusCode::OK, false)] {
            let response: reqwest::Response = http::Response::builder()
                .status(status)
                .body(body)
                .expect("terminal response")
                .into();
            let creation = terminal_creation(response, "terminal-creation-status")
                .await
                .expect("valid terminal creation response");
            assert_eq!(creation.created, expected_created);
            assert_eq!(creation.session.creation_id, "terminal-creation-status");
        }
    }

    #[tokio::test]
    async fn terminal_creation_rejects_a_missing_or_changed_creation_identity() {
        for actual in ["", "different-terminal-creation"] {
            let response: reqwest::Response = http::Response::builder()
                .status(StatusCode::CREATED)
                .body(terminal_json(actual).to_string())
                .expect("terminal response")
                .into();

            assert!(matches!(
                terminal_creation(response, "terminal-creation-current").await,
                Err(GuestError::TerminalCreationIdentityMismatch { expected, actual: returned })
                    if expected == "terminal-creation-current" && returned == actual
            ));
        }
    }

    #[tokio::test]
    async fn terminal_creation_reconciliation_does_not_claim_a_new_session() {
        const CREATION_ID: &str = "terminal-creation-timeout";
        let created = Arc::new(AtomicBool::new(false));
        let creation_state = Arc::clone(&created);
        let list_state = Arc::clone(&created);
        let router = Router::new().route(
            "/v1/terminals",
            get(move || {
                let created = Arc::clone(&list_state);
                async move {
                    let sessions = if created.load(Ordering::SeqCst) {
                        vec![terminal_json(CREATION_ID)]
                    } else {
                        Vec::new()
                    };
                    Json(serde_json::json!({"sessions": sessions}))
                }
            })
            .post(move |Json(body): Json<Value>| {
                let created = Arc::clone(&creation_state);
                async move {
                    assert_eq!(
                        body.get("creationId").and_then(Value::as_str),
                        Some(CREATION_ID)
                    );
                    created.store(true, Ordering::SeqCst);
                    (StatusCode::CREATED, "unreadable terminal response")
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Nanoagent reconciliation fixture");
        let address = listener
            .local_addr()
            .expect("Nanoagent reconciliation address");
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve Nanoagent reconciliation fixture");
        });
        let client = GuestClient {
            http: reqwest::Client::new(),
            base_url: format!("http://{address}"),
            token: "test-bootstrap-token".to_owned(),
        };

        let creation = client
            .create_terminal(CREATION_ID, "/workspace", 120, 32)
            .await
            .expect("created terminal is reconciled after its response times out");

        assert!(!creation.created);
        assert_eq!(creation.session.id, "abcdefghijklmnopqrstuvwx");
        assert_eq!(creation.session.creation_id, CREATION_ID);
        server.abort();
    }

    #[tokio::test]
    async fn terminal_creation_reconciles_a_lost_replay_without_recounting_it() {
        const CREATION_ID: &str = "terminal-creation-replay";
        let router = Router::new().route(
            "/v1/terminals",
            get(|| async {
                Json(serde_json::json!({
                    "sessions": [terminal_json(CREATION_ID)]
                }))
            })
            .post(|| async { (StatusCode::OK, "unreadable terminal replay") }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Nanoagent replay fixture");
        let address = listener.local_addr().expect("Nanoagent replay address");
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve Nanoagent replay fixture");
        });
        let client = GuestClient {
            http: reqwest::Client::new(),
            base_url: format!("http://{address}"),
            token: "test-bootstrap-token".to_owned(),
        };

        let replay = client
            .create_terminal(CREATION_ID, "/workspace", 120, 32)
            .await
            .expect("existing terminal is reconciled after its replay response is lost");

        assert!(!replay.created);
        assert_eq!(replay.session.creation_id, CREATION_ID);
        server.abort();
    }

    #[test]
    fn ndjson_limit_applies_to_remainder_after_complete_lines() {
        let mut buffer = b"{}\n12345".to_vec();
        assert!(matches!(
            drain_ndjson_lines(&mut buffer, 4),
            Err(GuestError::ResponseTooLarge(4))
        ));
    }

    #[test]
    fn unary_guest_requests_have_a_deadline_while_streams_remain_long_lived() {
        let client = GuestClient {
            http: reqwest::Client::new(),
            base_url: "http://127.0.0.1:8080".to_owned(),
            token: "token".to_owned(),
        };
        let unary = client
            .unary_request(client.request(Method::GET, "/v1/files"))
            .build()
            .expect("unary request");
        let stream = client
            .request(Method::GET, "/v1/files/watch")
            .build()
            .expect("stream request");

        assert_eq!(unary.timeout(), Some(&GUEST_UNARY_TIMEOUT));
        assert_eq!(stream.timeout(), None);
    }

    #[test]
    fn file_watch_preserves_optional_cursor_presence() {
        let client = GuestClient {
            http: reqwest::Client::new(),
            base_url: "http://127.0.0.1:8080".to_owned(),
            token: "token".to_owned(),
        };
        let initial = client
            .file_watch_request("/workspace", None)
            .build()
            .expect("initial file watch request");
        let from_zero = client
            .file_watch_request("/workspace", Some(0))
            .build()
            .expect("zero-cursor file watch request");
        let resumed = client
            .file_watch_request("/workspace", Some(42))
            .build()
            .expect("resumed file watch request");

        let initial_query = initial.url().query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(
            initial_query.get("path").map(|value| value.as_ref()),
            Some("/workspace")
        );
        assert!(!initial_query.contains_key("after"));
        let zero_query = from_zero.url().query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(
            zero_query.get("after").map(|value| value.as_ref()),
            Some("0")
        );
        let resumed_query = resumed.url().query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(
            resumed_query.get("path").map(|value| value.as_ref()),
            Some("/workspace")
        );
        assert_eq!(
            resumed_query.get("after").map(|value| value.as_ref()),
            Some("42")
        );
    }
}
