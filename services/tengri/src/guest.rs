use std::{
    collections::{HashMap, HashSet},
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures::{Stream, StreamExt};
use k8s_openapi::api::core::v1::Secret;
use kube::{Api, Client, ResourceExt};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

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
    #[error("Nanoagent response exceeded the {0}-byte limit")]
    ResponseTooLarge(usize),
}

#[derive(Clone)]
pub struct GuestClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
    agent_id: String,
    terminal_identities: TerminalIdentityRegistry,
}

#[derive(Clone, Default)]
pub struct TerminalIdentityRegistry {
    state: Arc<Mutex<TerminalIdentityState>>,
    legacy_creation_locks: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
}

#[derive(Default)]
struct TerminalIdentityState {
    agents: HashMap<String, AgentTerminalIdentities>,
}

#[derive(Default)]
struct AgentTerminalIdentities {
    creation_ids: HashMap<String, String>,
    pending: HashMap<String, PendingLegacyCreation>,
}

struct PendingLegacyCreation {
    existing_session_ids: HashSet<String>,
    cwd: String,
}

impl TerminalIdentityRegistry {
    async fn lock_legacy_creation(&self, agent_id: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self
                .legacy_creation_locks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(agent_id).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(agent_id.to_owned(), Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }

    fn begin_legacy_creation(
        &self,
        agent_id: &str,
        creation_id: &str,
        cwd: &str,
        existing: &[TerminalSession],
    ) {
        let mut state = self.state();
        state
            .agents
            .entry(agent_id.to_owned())
            .or_default()
            .pending
            .insert(
                creation_id.to_owned(),
                PendingLegacyCreation {
                    existing_session_ids: existing
                        .iter()
                        .map(|session| session.id.clone())
                        .collect(),
                    cwd: cwd.to_owned(),
                },
            );
    }

    fn finish_creation(&self, agent_id: &str, creation_id: &str, session_id: &str) {
        let mut state = self.state();
        let identities = state.agents.entry(agent_id.to_owned()).or_default();
        identities.pending.remove(creation_id);
        identities
            .creation_ids
            .insert(session_id.to_owned(), creation_id.to_owned());
    }

    pub(crate) fn restore_legacy_creation(
        &self,
        agent_id: &str,
        creation_id: &str,
        cwd: &str,
        existing_session_ids: &[String],
        terminal_id: Option<&str>,
    ) {
        let mut state = self.state();
        let identities = state.agents.entry(agent_id.to_owned()).or_default();
        if let Some(terminal_id) = terminal_id {
            identities.pending.remove(creation_id);
            identities
                .creation_ids
                .insert(terminal_id.to_owned(), creation_id.to_owned());
            return;
        }
        identities.pending.insert(
            creation_id.to_owned(),
            PendingLegacyCreation {
                existing_session_ids: existing_session_ids.iter().cloned().collect(),
                cwd: cwd.to_owned(),
            },
        );
    }

    pub(crate) fn remove_creation(&self, agent_id: &str, creation_id: &str) {
        let mut state = self.state();
        let remove_agent = if let Some(identities) = state.agents.get_mut(agent_id) {
            identities.pending.remove(creation_id);
            identities
                .creation_ids
                .retain(|_, stored_creation_id| stored_creation_id != creation_id);
            identities.creation_ids.is_empty() && identities.pending.is_empty()
        } else {
            false
        };
        if remove_agent {
            state.agents.remove(agent_id);
        }
    }

    pub(crate) fn reconcile(&self, agent_id: &str, sessions: &mut [TerminalSession]) {
        let mut state = self.state();
        let Some(identities) = state.agents.get_mut(agent_id) else {
            return;
        };
        let active_session_ids = sessions
            .iter()
            .map(|session| session.id.clone())
            .collect::<HashSet<_>>();
        identities
            .creation_ids
            .retain(|session_id, _| active_session_ids.contains(session_id));
        for session in sessions.iter() {
            if !session.creation_id.is_empty() {
                identities
                    .creation_ids
                    .insert(session.id.clone(), session.creation_id.clone());
            }
        }

        let mut claimed_session_ids = identities
            .creation_ids
            .keys()
            .cloned()
            .collect::<HashSet<_>>();
        let mut reconciled = Vec::new();
        for (creation_id, pending) in &identities.pending {
            let candidates = sessions
                .iter()
                .filter(|session| {
                    session.creation_id.is_empty()
                        && session.cwd == pending.cwd
                        && !pending.existing_session_ids.contains(&session.id)
                        && !claimed_session_ids.contains(&session.id)
                })
                .collect::<Vec<_>>();
            if let [session] = candidates.as_slice() {
                identities
                    .creation_ids
                    .insert(session.id.clone(), creation_id.clone());
                claimed_session_ids.insert(session.id.clone());
                reconciled.push(creation_id.clone());
            }
        }
        for creation_id in reconciled {
            identities.pending.remove(&creation_id);
        }
        for session in sessions {
            if session.creation_id.is_empty()
                && let Some(creation_id) = identities.creation_ids.get(&session.id)
            {
                session.creation_id.clone_from(creation_id);
            }
        }
    }

    fn remove_session(&self, agent_id: &str, session_id: &str) {
        let mut state = self.state();
        let remove_agent = if let Some(identities) = state.agents.get_mut(agent_id) {
            identities.creation_ids.remove(session_id);
            identities.creation_ids.is_empty() && identities.pending.is_empty()
        } else {
            false
        };
        if remove_agent {
            state.agents.remove(agent_id);
        }
    }

    fn state(&self) -> MutexGuard<'_, TerminalIdentityState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
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
        Self::for_agent_with_terminal_identities(
            client,
            namespace,
            agent_id,
            TerminalIdentityRegistry::default(),
        )
        .await
    }

    pub async fn for_agent_with_terminal_identities(
        client: Client,
        namespace: &str,
        agent_id: &str,
        terminal_identities: TerminalIdentityRegistry,
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
            agent_id: agent_id.to_owned(),
            terminal_identities,
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
            Ok(creation) => {
                self.terminal_identities.finish_creation(
                    &self.agent_id,
                    creation_id,
                    &creation.session.id,
                );
                Ok(creation)
            }
            Err(error) if legacy_terminal_creation_id_rejection(&error) => {
                self.create_legacy_terminal(creation_id, cwd, columns, rows)
                    .await
            }
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

    async fn create_legacy_terminal(
        &self,
        creation_id: &str,
        cwd: &str,
        columns: u32,
        rows: u32,
    ) -> Result<TerminalCreation, GuestError> {
        let _legacy_creation_guard = self
            .terminal_identities
            .lock_legacy_creation(&self.agent_id)
            .await;
        let existing = self.list_terminals().await?;
        if let Some(session) = existing
            .iter()
            .find(|session| session.creation_id == creation_id)
        {
            return Ok(TerminalCreation {
                session: session.clone(),
                created: false,
            });
        }
        self.terminal_identities
            .begin_legacy_creation(&self.agent_id, creation_id, cwd, &existing);

        let result = async {
            let response =
                self.send_unary(self.request(Method::POST, "/v1/terminals").json(
                    &serde_json::json!({
                        "cwd": cwd,
                        "columns": columns,
                        "rows": rows
                    }),
                ))
                .await?;
            terminal_creation(response, creation_id).await
        }
        .await;

        match result {
            Ok(creation) => {
                self.terminal_identities.finish_creation(
                    &self.agent_id,
                    creation_id,
                    &creation.session.id,
                );
                Ok(creation)
            }
            Err(error) => {
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
                Err(error)
            }
        }
    }

    pub async fn list_terminals(&self) -> Result<Vec<TerminalSession>, GuestError> {
        let mut response: TerminalList = self
            .json(self.request(Method::GET, "/v1/terminals"))
            .await?;
        self.terminal_identities
            .reconcile(&self.agent_id, &mut response.sessions);
        Ok(response.sessions)
    }

    pub async fn terminate_terminal(&self, id: &str) -> Result<(), GuestError> {
        checked_response(
            self.send_unary(self.request(Method::DELETE, &format!("/v1/terminals/{id}")))
                .await?,
        )
        .await?;
        self.terminal_identities.remove_session(&self.agent_id, id);
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
    let mut session: TerminalSession = serde_json::from_slice(&body)?;
    if session.creation_id.is_empty() {
        session.creation_id = requested_creation_id.to_owned();
    }
    Ok(TerminalCreation { session, created })
}

fn legacy_terminal_creation_id_rejection(error: &GuestError) -> bool {
    matches!(
        error,
        GuestError::Api { status, message }
            if *status == StatusCode::BAD_REQUEST
                && message.contains("unknown field")
                && message.contains("creationId")
    )
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

    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use axum::{
        Json, Router,
        routing::{get, post},
    };
    use tokio::sync::Notify;

    fn legacy_terminal_json() -> Value {
        serde_json::json!({
            "id": "abcdefghijklmnopqrstuvwx",
            "cwd": "/workspace",
            "createdAt": "2026-08-28T00:00:00Z",
            "lastActivityAt": "2026-08-28T00:00:00Z",
            "attached": false
        })
    }

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
            agent_id: "agent-search".to_owned(),
            terminal_identities: TerminalIdentityRegistry::default(),
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
            agent_id: "agent-legacy".to_owned(),
            terminal_identities: TerminalIdentityRegistry::default(),
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
    async fn terminal_creation_accepts_legacy_sessions_without_creation_identity() {
        let response: reqwest::Response = http::Response::builder()
            .status(StatusCode::CREATED)
            .body(
                r#"{
                    "id":"abcdefghijklmnopqrstuvwx",
                    "cwd":"/workspace",
                    "createdAt":"2026-08-28T00:00:00Z",
                    "lastActivityAt":"2026-08-28T00:00:00Z",
                    "attached":false
                }"#,
            )
            .expect("legacy terminal response")
            .into();

        let creation = terminal_creation(response, "terminal-creation-legacy")
            .await
            .expect("legacy response remains compatible");
        assert!(creation.created);
        assert_eq!(creation.session.creation_id, "terminal-creation-legacy");
    }

    #[test]
    fn terminal_creation_retries_only_the_legacy_unknown_field_error() {
        let legacy = GuestError::Api {
            status: StatusCode::BAD_REQUEST,
            message: r#"{"error":"json: unknown field \"creationId\""}"#.to_owned(),
        };
        assert!(legacy_terminal_creation_id_rejection(&legacy));
        assert!(!legacy_terminal_creation_id_rejection(&GuestError::Api {
            status: StatusCode::BAD_REQUEST,
            message: "cwd is invalid".to_owned(),
        }));
        assert!(!legacy_terminal_creation_id_rejection(&GuestError::Api {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: r#"unknown field \"creationId\""#.to_owned(),
        }));
    }

    #[tokio::test]
    async fn terminal_creation_negotiates_with_a_legacy_guest() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let created = Arc::new(AtomicBool::new(false));
        let request_attempts = Arc::clone(&attempts);
        let creation_state = Arc::clone(&created);
        let list_state = Arc::clone(&created);
        let router = Router::new().route(
            "/v1/terminals",
            get(move || {
                let created = Arc::clone(&list_state);
                async move {
                    let sessions = if created.load(Ordering::SeqCst) {
                        vec![legacy_terminal_json()]
                    } else {
                        Vec::new()
                    };
                    Json(serde_json::json!({"sessions": sessions}))
                }
            })
            .post(move |Json(body): Json<Value>| {
                let request_attempts = Arc::clone(&request_attempts);
                let created = Arc::clone(&creation_state);
                async move {
                    request_attempts.fetch_add(1, Ordering::SeqCst);
                    if body.get("creationId").is_some() {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({
                                "error": "json: unknown field \"creationId\""
                            })),
                        );
                    }
                    created.store(true, Ordering::SeqCst);
                    (StatusCode::CREATED, Json(legacy_terminal_json()))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind legacy Nanoagent fixture");
        let address = listener.local_addr().expect("legacy Nanoagent address");
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve legacy Nanoagent fixture");
        });
        let client = GuestClient {
            http: reqwest::Client::new(),
            base_url: format!("http://{address}"),
            token: "test-bootstrap-token".to_owned(),
            agent_id: "agent-legacy".to_owned(),
            terminal_identities: TerminalIdentityRegistry::default(),
        };

        let creation = client
            .create_terminal("terminal-creation-legacy", "/workspace", 120, 32)
            .await
            .expect("legacy terminal creation succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert!(creation.created);
        assert_eq!(creation.session.creation_id, "terminal-creation-legacy");
        let sessions = client
            .list_terminals()
            .await
            .expect("legacy terminal listing succeeds");
        assert_eq!(sessions[0].creation_id, "terminal-creation-legacy");
        server.abort();
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
            agent_id: "agent-response-timeout".to_owned(),
            terminal_identities: TerminalIdentityRegistry::default(),
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
            agent_id: "agent-replayed-response".to_owned(),
            terminal_identities: TerminalIdentityRegistry::default(),
        };

        let replay = client
            .create_terminal(CREATION_ID, "/workspace", 120, 32)
            .await
            .expect("existing terminal is reconciled after its replay response is lost");

        assert!(!replay.created);
        assert_eq!(replay.session.creation_id, CREATION_ID);
        server.abort();
    }

    #[tokio::test]
    async fn legacy_terminal_creation_reconciles_after_its_response_is_lost() {
        let created = Arc::new(AtomicBool::new(false));
        let legacy_posts = Arc::new(AtomicUsize::new(0));
        let creation_state = Arc::clone(&created);
        let list_state = Arc::clone(&created);
        let post_attempts = Arc::clone(&legacy_posts);
        let creation_started = Arc::new(Notify::new());
        let handler_started = Arc::clone(&creation_started);
        let hold_response = Arc::new(Notify::new());
        let handler_hold = Arc::clone(&hold_response);
        let router = Router::new().route(
            "/v1/terminals",
            get(move || {
                let created = Arc::clone(&list_state);
                async move {
                    let sessions = if created.load(Ordering::SeqCst) {
                        vec![legacy_terminal_json()]
                    } else {
                        Vec::new()
                    };
                    Json(serde_json::json!({"sessions": sessions}))
                }
            })
            .post(move |Json(body): Json<Value>| {
                let created = Arc::clone(&creation_state);
                let creation_started = Arc::clone(&handler_started);
                let hold_response = Arc::clone(&handler_hold);
                let legacy_posts = Arc::clone(&post_attempts);
                async move {
                    if body.get("creationId").is_some() {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({
                                "error": "json: unknown field \"creationId\""
                            })),
                        );
                    }
                    legacy_posts.fetch_add(1, Ordering::SeqCst);
                    created.store(true, Ordering::SeqCst);
                    creation_started.notify_one();
                    hold_response.notified().await;
                    (StatusCode::CREATED, Json(legacy_terminal_json()))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind legacy Nanoagent fixture");
        let address = listener.local_addr().expect("legacy Nanoagent address");
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve legacy Nanoagent fixture");
        });
        let client = GuestClient {
            http: reqwest::Client::new(),
            base_url: format!("http://{address}"),
            token: "test-bootstrap-token".to_owned(),
            agent_id: "agent-lost-response".to_owned(),
            terminal_identities: TerminalIdentityRegistry::default(),
        };

        let create_client = client.clone();
        let create = tokio::spawn(async move {
            create_client
                .create_terminal("terminal-creation-lost", "/workspace", 120, 32)
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), creation_started.notified())
            .await
            .expect("legacy terminal was created before the response was lost");
        create.abort();
        let _ = create.await;

        let sessions = client
            .list_terminals()
            .await
            .expect("legacy terminal can be reconciled after cancellation");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].creation_id, "terminal-creation-lost");
        let replayed = client
            .create_terminal("terminal-creation-lost", "/workspace", 120, 32)
            .await
            .expect("legacy terminal retry reconciles instead of creating another PTY");
        assert!(!replayed.created);
        assert_eq!(replayed.session.id, sessions[0].id);
        assert_eq!(legacy_posts.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn legacy_terminal_creation_locks_are_scoped_per_agent() {
        let registry = TerminalIdentityRegistry::default();
        let first_agent = registry.lock_legacy_creation("agent-a").await;

        let other_agent = tokio::time::timeout(
            Duration::from_millis(100),
            registry.lock_legacy_creation("agent-b"),
        )
        .await
        .expect("an unrelated agent is not blocked by a legacy create");
        let same_agent = tokio::time::timeout(
            Duration::from_millis(25),
            registry.lock_legacy_creation("agent-a"),
        )
        .await;
        assert!(same_agent.is_err(), "the same agent must remain serialized");

        drop(other_agent);
        drop(first_agent);
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
            agent_id: "agent-timeout".to_owned(),
            terminal_identities: TerminalIdentityRegistry::default(),
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
            agent_id: "agent-watch".to_owned(),
            terminal_identities: TerminalIdentityRegistry::default(),
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
