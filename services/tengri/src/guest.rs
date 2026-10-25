use std::{pin::Pin, sync::Arc, time::Duration};

use futures::Stream;
use k8s_openapi::api::core::v1::Secret;
use kube::{Api, Client};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::identity::WorkloadIdentity;

pub(crate) mod authorization;
mod codex_history;
pub use codex_history::CodexHistoryPart;
mod codex_options;
mod pool;
pub(crate) mod rpc;

pub use codex_options::CodexOptions;
pub use pool::GuestPool;

pub(crate) const GUEST_API_PORT: u16 = 8443;
pub const EDITOR_PORT: u16 = 13337;
pub const BROWSER_PORT: u16 = 13339;
pub const EDITOR_BRIDGE_PORT: u16 = 13338;
const BOOTSTRAP_TOKEN_KEY: &str = "token";
const MAX_GUEST_FILE_BYTES: usize = 4 << 20;
const MAX_GUEST_JSON_BYTES: usize = 10 << 20;
const MAX_GUEST_STREAM_LINE_BYTES: usize = 3 << 20;
const GUEST_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const GUEST_UNARY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum GuestError {
    #[error("Codex rejected the operation before dispatch")]
    CodexOperationRejected,
    #[error("Kubernetes API request failed: {0}")]
    Kubernetes(#[from] kube::Error),
    #[error("SPIFFE guest transport failed: {0}")]
    Identity(#[from] anyhow::Error),
    #[error("MicroVM {0} is not ready")]
    NotReady(String),
    #[error("MicroVM {0} has no guest IP")]
    MissingGuestIp(String),
    #[error("bootstrap secret {0} is missing token data")]
    MissingToken(String),
    #[error("Nanoagent API returned {status}: {message}")]
    Api { status: StatusCode, message: String },
    #[error("Nanoagent returned invalid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("Nanoagent returned invalid Codex history: {0}")]
    InvalidCodexHistory(&'static str),
    #[error("Codex conversation history retrieval timed out")]
    CodexHistoryTimeout,
    #[error("Nanoagent returned terminal creation identity {actual:?}; expected {expected:?}")]
    TerminalCreationIdentityMismatch {
        expected: String,
        actual: String,
        created_terminal_id: Option<String>,
    },
    #[error("Nanoagent did not return a strong SHA-256 file revision")]
    MissingFileRevision,
    #[error("Nanoagent returned an invalid file revision")]
    InvalidFileRevision,
    #[error("Nanoagent file revision does not match the returned content")]
    FileRevisionMismatch,
    #[error("Nanoagent response exceeded the {0}-byte limit")]
    ResponseTooLarge(usize),
}

#[derive(Clone)]
pub struct GuestClient {
    base_url: String,
    token: String,
    pub(crate) http: reqwest::Client,
    pub(crate) preview_tls: Option<Arc<rustls::ClientConfig>>,
    pub(crate) rpc: rpc::RpcClient,
    pub(crate) claim_headers: reqwest::header::HeaderMap,
}

#[derive(Clone)]
pub(super) struct GuestTransport {
    base_url: String,
    token: String,
    http: reqwest::Client,
    preview_tls: Option<Arc<rustls::ClientConfig>>,
    channel: tonic::transport::Channel,
    claim_headers: reqwest::header::HeaderMap,
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
    pub revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub size: i64,
    #[serde(default)]
    pub revision: String,
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
pub(crate) struct CodexCallResponse {
    pub(crate) result: Value,
    #[serde(default)]
    event_sequence: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginSnapshot {
    pub active: bool,
    #[serde(default)]
    pub result: Value,
    #[serde(default)]
    pub started_at: String,
}

#[derive(Debug)]
pub struct CodexCallResult {
    pub result: Value,
    pub event_sequence: u64,
}

impl GuestTransport {
    async fn connect(
        client: Client,
        namespace: &str,
        target: pool::GuestTarget,
        identity: &WorkloadIdentity,
        issuer: authorization::GuestRequestIssuer,
    ) -> Result<Self, GuestError> {
        let pool::GuestTarget {
            claim,
            pod_uid,
            address,
            slot_name,
        } = target;
        let secret_name = crate::pod::bootstrap_secret_name(&slot_name);
        let secrets: Api<Secret> = Api::namespaced(client, namespace);
        let secret = secrets.get(&secret_name).await?;
        let token_bytes = secret
            .data
            .as_ref()
            .and_then(|data| data.get(BOOTSTRAP_TOKEN_KEY))
            .ok_or_else(|| GuestError::MissingToken(secret_name.clone()))?;
        let token = String::from_utf8(token_bytes.0.clone())
            .map_err(|_| GuestError::MissingToken(secret_name))?;

        let tls = identity.guest_tls(identity.guest_id(namespace, &pod_uid)?)?;
        let channel = identity.guest_channel(address, tls.clone())?;
        let preview_tls = tls.map(|config| {
            let mut config = config.as_ref().clone();
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            Arc::new(config)
        });
        let mut claim_headers = reqwest::header::HeaderMap::new();
        claim_headers.insert(
            crate::slot::supervisor::CLAIM_UID_HEADER,
            claim.microvm_uid.parse().map_err(anyhow::Error::from)?,
        );
        claim_headers.insert(
            crate::slot::supervisor::CLAIM_EPOCH_HEADER,
            claim
                .epoch
                .to_string()
                .parse()
                .map_err(anyhow::Error::from)?,
        );
        claim_headers.insert(
            crate::slot::supervisor::RUNTIME_EPOCH_HEADER,
            claim.runtime_epoch.parse().map_err(anyhow::Error::from)?,
        );
        let mut http = reqwest::Client::builder()
            .default_headers(claim_headers.clone())
            .redirect(reqwest::redirect::Policy::none())
            .http1_only()
            .connect_timeout(GUEST_CONNECT_TIMEOUT);
        if let Some(config) = &preview_tls {
            http = http.use_preconfigured_tls(config.as_ref().clone());
        }
        let http = http.build().map_err(anyhow::Error::from)?;
        let scheme = if preview_tls.is_some() {
            "https"
        } else {
            "http"
        };
        let base_url = format!("{scheme}://{address}");
        let rpc = rpc::RpcClient::new(channel.clone(), &token, issuer)?;
        rpc.verify_identity(&pod_uid).await?;
        Ok(Self {
            base_url,
            token,
            http,
            preview_tls,
            channel,
            claim_headers,
        })
    }

    fn authorize(
        self,
        issuer: authorization::GuestRequestIssuer,
    ) -> Result<GuestClient, GuestError> {
        Ok(GuestClient {
            rpc: rpc::RpcClient::new(self.channel, &self.token, issuer)?,
            base_url: self.base_url,
            token: self.token,
            http: self.http,
            preview_tls: self.preview_tls,
            claim_headers: self.claim_headers,
        })
    }
}

impl GuestClient {
    pub async fn codex_activity(&self) -> Result<rpc::proto::CodexActivity, GuestError> {
        self.rpc.codex_activity().await
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    pub async fn open_editor(&self) -> Result<(), GuestError> {
        self.rpc.open_editor().await
    }

    pub async fn open_browser(&self) -> Result<(), GuestError> {
        self.rpc.open_browser().await
    }
    pub async fn stat_file(&self, path: &str) -> Result<FileEntry, GuestError> {
        self.rpc.stat_file(path).await
    }
    pub async fn list_files(&self, path: &str) -> Result<FileList, GuestError> {
        self.rpc.list_files(path).await
    }
    pub async fn read_file(&self, path: &str) -> Result<FileContent, GuestError> {
        self.rpc.read_file(path).await
    }
    pub async fn write_file(
        &self,
        path: &str,
        content: &[u8],
        expected_revision: &str,
    ) -> Result<WriteResult, GuestError> {
        self.rpc.write_file(path, content, expected_revision).await
    }
    pub async fn create_directory(&self, path: &str) -> Result<FileEntry, GuestError> {
        self.rpc.create_directory(path).await
    }
    pub async fn move_file(
        &self,
        source_path: &str,
        destination_path: &str,
    ) -> Result<FileEntry, GuestError> {
        self.rpc.move_file(source_path, destination_path).await
    }
    pub async fn delete_file(&self, path: &str, recursive: bool) -> Result<(), GuestError> {
        self.rpc.delete_file(path, recursive).await
    }
    pub async fn search_files(
        &self,
        query: &str,
        path: &str,
        limit: u32,
    ) -> Result<FileSearchResult, GuestError> {
        self.rpc.search_files(query, path, limit).await
    }
    pub async fn watch_files(
        &self,
        path: &str,
        after: Option<u64>,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<FileEvent, GuestError>> + Send>>, GuestError> {
        self.rpc.watch_files(path, after).await
    }
    pub async fn create_terminal(
        &self,
        creation_id: &str,
        cwd: &str,
        columns: u32,
        rows: u32,
    ) -> Result<TerminalCreation, GuestError> {
        match self
            .rpc
            .create_terminal(creation_id, cwd, columns, rows)
            .await
        {
            Ok(result) => Ok(result),
            Err(error @ GuestError::TerminalCreationIdentityMismatch { .. }) => Err(error),
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
        self.rpc.list_terminals().await
    }
    pub async fn terminate_terminal(&self, id: &str) -> Result<(), GuestError> {
        self.rpc.terminate_terminal(id).await
    }
    pub async fn codex_call(&self, method: &str, params: Value) -> Result<Value, GuestError> {
        Ok(self.rpc.codex_call(method, params).await?.result)
    }
    pub async fn codex_login(&self) -> Result<CodexLoginSnapshot, GuestError> {
        self.rpc.codex_login().await
    }
    pub async fn codex_call_with_sequence(
        &self,
        method: &str,
        params: Value,
    ) -> Result<CodexCallResult, GuestError> {
        let response = self.rpc.codex_call(method, params).await?;
        Ok(CodexCallResult {
            result: response.result,
            event_sequence: response.event_sequence,
        })
    }
    pub async fn watch_codex_events(
        &self,
        after: u64,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<CodexEvent, GuestError>> + Send>>, GuestError>
    {
        self.rpc.watch_codex_events(after).await
    }
}

fn revision_for_content(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn is_file_revision(value: &str) -> bool {
    value.len() == Sha256::output_size() * 2
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn validate_expected_revision(value: &str) -> Result<(), GuestError> {
    if value != "missing" && !is_file_revision(value) {
        return Err(GuestError::InvalidFileRevision);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn guest_connection_verifies_the_ready_pod_uid_instead_of_the_microvm_name() {
        use rpc::test_server::TestService;
        use std::sync::Arc;
        use tokio_stream::wrappers::TcpListenerStream;

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let fixture_port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(
                    rpc::proto::nanoagent_service_server::NanoagentServiceServer::new(
                        TestService {
                            get_info: Some(Arc::new(|request| {
                                assert_eq!(
                                    request.metadata().get("authorization").unwrap(),
                                    "Bearer fixture-token"
                                );
                                assert_eq!(
                                    request.metadata().get("x-tengri-microvm-uid").unwrap(),
                                    "11111111-1111-4111-8111-111111111111"
                                );
                                assert_eq!(
                                    request.metadata().get("x-tengri-claim-epoch").unwrap(),
                                    "1"
                                );
                                Ok(rpc::proto::GuestInfo {
                                    microvm_id: "33333333-3333-4333-8333-333333333333".into(),
                                    protocol_version: tengri::GUEST_API_PROTOCOL_VERSION,
                                    ..Default::default()
                                })
                            })),
                            ..Default::default()
                        },
                    ),
                )
                .serve_with_incoming(TcpListenerStream::new(listener))
                .await
                .unwrap();
        });
        for (pod_uid, ready) in [
            (Some("33333333-3333-4333-8333-333333333333"), true),
            (Some("previous-pod-uid"), false),
            (None, false),
        ] {
            let service = tower::service_fn(
                move |request: http::Request<kube::client::Body>| async move {
                    let value = if request.uri().path().ends_with("/microvms/agent-fixture") {
                        serde_json::json!({"apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM","metadata":{"name":"agent-fixture","uid":"11111111-1111-4111-8111-111111111111","generation":1},"spec":{
                        "reservationId":"55555555-5555-4555-8555-555555555555","policyVersion":1,"runtimeEpoch":"44444444-4444-4444-8444-444444444444","displayName":"Guest fixture","ownerHash":"a".repeat(64),"desiredState":"Running","image":"test","architecture":"amd64",
                        "resources":{"cpuMillis":4000,"memoryMib":8192,"workspaceGib":32},"createdAt":"2026-10-01T00:00:00Z","idleDeadline":"2099-01-01T00:00:00Z",
                        "slot": {"name":"slot-fixture","podUid":"33333333-3333-4333-8333-333333333333","pvcName":"home-fixture","pvcUid":"home-uid","epoch":1}
                    },"status":{"phase":"Ready","guestReady":true,"observedGeneration":1,"podIp":"127.0.0.1","podUid":pod_uid}})
                    } else {
                        assert!(
                            request
                                .uri()
                                .path()
                                .ends_with("/secrets/slot-fixture-bootstrap")
                        );
                        serde_json::json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"slot-fixture-bootstrap"},"data":{"token":"Zml4dHVyZS10b2tlbg=="}})
                    };
                    Ok::<_, std::io::Error>(
                        http::Response::builder()
                            .header(http::header::CONTENT_TYPE, "application/json")
                            .body(kube::client::Body::from(value.to_string().into_bytes()))
                            .unwrap(),
                    )
                },
            );
            let result = GuestPool::new(
                Client::new(service, "tengri"),
                "tengri",
                WorkloadIdentity::Fixture(fixture_port),
            )
            .for_agent(
                "agent-fixture",
                None,
                authorization::GuestAuthority::fixture_authorization(),
            )
            .await;
            assert_eq!(
                result.is_ok(),
                ready,
                "pod UID {pod_uid:?}: {}",
                result
                    .err()
                    .map(|error| error.to_string())
                    .unwrap_or_default()
            );
        }
        server.abort();
    }

    #[tokio::test]
    async fn an_editor_session_cannot_bind_to_a_recreated_microvm() {
        let service = tower::service_fn(|request: http::Request<kube::client::Body>| async move {
            assert!(
                request.uri().path().ends_with("/microvms/editor-fixture"),
                "stale session read a bootstrap secret"
            );
            let value = serde_json::json!({"apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM","metadata":{"name":"editor-fixture","uid":"new-incarnation"},"spec":{
                "reservationId":"55555555-5555-4555-8555-555555555555","policyVersion":1,"runtimeEpoch":"44444444-4444-4444-8444-444444444444","displayName":"Editor fixture","ownerHash":"a".repeat(64),"desiredState":"Running","image":"test","architecture":"amd64",
                "resources":{"cpuMillis":4000,"memoryMib":8192,"workspaceGib":32},"createdAt":"2026-09-08T00:00:00Z","idleDeadline":"2099-01-01T00:00:00Z"
            }});
            Ok::<_, std::io::Error>(
                http::Response::builder()
                    .header(http::header::CONTENT_TYPE, "application/json")
                    .body(kube::client::Body::from(value.to_string().into_bytes()))
                    .unwrap(),
            )
        });
        let result = GuestPool::new(
            Client::new(service, "tengri"),
            "tengri",
            WorkloadIdentity::Fixture(8080),
        )
        .for_agent(
            "editor-fixture",
            Some("old-incarnation"),
            authorization::GuestAuthority::fixture_authorization(),
        )
        .await;
        assert!(matches!(
            result,
            Err(GuestError::Api {
                status: StatusCode::GONE,
                ..
            })
        ));
    }
}
