use prost::Message;
use tonic::{Request, Status, metadata::MetadataValue, transport::Channel};

use super::*;

#[cfg(test)]
pub(super) mod test_server;
#[cfg(test)]
mod tests;

pub(crate) mod proto {
    tonic::include_proto!("proompteng.runtime.guest.v1");
}

type Client = proto::nanoagent_service_client::NanoagentServiceClient<Channel>;

#[derive(Clone)]
pub struct RpcClient {
    client: Client,
    authorization: MetadataValue<tonic::metadata::Ascii>,
}

impl RpcClient {
    pub fn new(channel: Channel, token: &str) -> Result<Self, GuestError> {
        let authorization =
            MetadataValue::try_from(format!("Bearer {token}")).map_err(|_| GuestError::Api {
                status: StatusCode::UNAUTHORIZED,
                message: "Invalid Nanoagent credentials".into(),
            })?;
        Ok(Self {
            client: Client::new(channel)
                .max_decoding_message_size(MAX_GUEST_JSON_BYTES)
                .max_encoding_message_size(MAX_GUEST_JSON_BYTES),
            authorization,
        })
    }

    #[cfg(test)]
    pub fn fixture(address: &str, token: &str) -> Result<Self, GuestError> {
        Self::new(
            Channel::from_shared(address.to_owned())
                .map_err(anyhow::Error::from)?
                .connect_timeout(GUEST_CONNECT_TIMEOUT)
                .connect_lazy(),
            token,
        )
    }

    fn request<T>(&self, value: T, timeout: Option<Duration>) -> Request<T> {
        let mut request = Request::new(value);
        request
            .metadata_mut()
            .insert("authorization", self.authorization.clone());
        if let Some(timeout) = timeout {
            request.set_timeout(timeout);
        }
        request
    }

    pub async fn refresh_spire_bootstrap(
        &self,
        pod_uid: &str,
        token: Vec<u8>,
        trust_bundle: Vec<u8>,
    ) -> Result<(), GuestError> {
        self.client
            .clone()
            .refresh_spire_bootstrap(self.request(
                proto::SpireBootstrap {
                    pod_uid: pod_uid.to_owned(),
                    token,
                    trust_bundle,
                },
                Some(GUEST_UNARY_TIMEOUT),
            ))
            .await
            .map_err(rpc_error)?;
        Ok(())
    }

    pub async fn verify_identity(&self, pod_uid: &str) -> Result<(), GuestError> {
        let info = self
            .client
            .clone()
            .get_info(self.request(proto::Empty {}, Some(GUEST_UNARY_TIMEOUT)))
            .await
            .map_err(|error| {
                if error.code() == tonic::Code::Unimplemented {
                    GuestError::Api { status: StatusCode::SERVICE_UNAVAILABLE, message: "Nanoagent requires gRPC. Sleep and resume the agent to use the current guest image.".into() }
                } else { rpc_error(error) }
            })?
            .into_inner();
        if info.microvm_id != pod_uid {
            return Err(GuestError::Api {
                status: StatusCode::BAD_GATEWAY,
                message: "Nanoagent identity does not match the current guest Pod".into(),
            });
        }
        if info.protocol_version != 1 {
            return Err(GuestError::Api { status: StatusCode::BAD_GATEWAY,
                message: "Nanoagent uses an unsupported guest protocol version. Sleep and resume the agent to use the current guest image.".into() });
        }
        Ok(())
    }

    pub async fn open_editor(&self) -> Result<(), GuestError> {
        let result = self
            .client
            .clone()
            .open_editor(self.request(proto::Empty {}, Some(Duration::from_secs(300))))
            .await
            .map_err(rpc_error)?
            .into_inner();
        if result.port != u32::from(EDITOR_PORT) {
            return Err(GuestError::Api {
                status: StatusCode::BAD_GATEWAY,
                message: "Nanoagent returned an unexpected editor port".into(),
            });
        }
        Ok(())
    }
    pub async fn list_files(&self, path: &str) -> Result<FileList, GuestError> {
        let result = self
            .client
            .clone()
            .list_files(self.request(proto::Path { path: path.into() }, Some(GUEST_UNARY_TIMEOUT)))
            .await
            .map_err(rpc_error)?
            .into_inner();
        Ok(FileList {
            path: result.path,
            entries: result.entries.into_iter().map(Into::into).collect(),
        })
    }
    pub async fn read_file(&self, path: &str) -> Result<FileContent, GuestError> {
        let result = self
            .client
            .clone()
            .read_file(self.request(proto::Path { path: path.into() }, Some(GUEST_UNARY_TIMEOUT)))
            .await
            .map_err(rpc_error)?
            .into_inner();
        if result.content.len() > MAX_GUEST_FILE_BYTES {
            return Err(GuestError::ResponseTooLarge(MAX_GUEST_FILE_BYTES));
        }
        validate_revision_content(&result.revision, &result.content)?;
        Ok(FileContent {
            path: path.into(),
            content: result.content,
            content_type: result.content_type,
            revision: result.revision,
        })
    }
    pub async fn write_file(
        &self,
        path: &str,
        content: &[u8],
        expected_revision: &str,
    ) -> Result<WriteResult, GuestError> {
        validate_expected_revision(expected_revision)?;
        if content.len() > MAX_GUEST_FILE_BYTES {
            return Err(GuestError::ResponseTooLarge(MAX_GUEST_FILE_BYTES));
        }
        let result = self
            .client
            .clone()
            .write_file(self.request(
                proto::FileWrite {
                    path: path.into(),
                    content: content.into(),
                    expected_revision: expected_revision.into(),
                },
                Some(GUEST_UNARY_TIMEOUT),
            ))
            .await
            .map_err(rpc_error)?
            .into_inner();
        validate_revision_content(&result.revision, content)?;
        Ok(WriteResult {
            path: result.path,
            size: result.size,
            revision: result.revision,
        })
    }
    pub async fn create_directory(&self, path: &str) -> Result<FileEntry, GuestError> {
        Ok(self
            .client
            .clone()
            .create_directory(
                self.request(proto::Path { path: path.into() }, Some(GUEST_UNARY_TIMEOUT)),
            )
            .await
            .map_err(rpc_error)?
            .into_inner()
            .into())
    }
    pub async fn move_file(
        &self,
        source_path: &str,
        destination_path: &str,
    ) -> Result<FileEntry, GuestError> {
        Ok(self
            .client
            .clone()
            .move_file(self.request(
                proto::FileMove {
                    source_path: source_path.into(),
                    destination_path: destination_path.into(),
                },
                Some(GUEST_UNARY_TIMEOUT),
            ))
            .await
            .map_err(rpc_error)?
            .into_inner()
            .into())
    }
    pub async fn delete_file(&self, path: &str, recursive: bool) -> Result<(), GuestError> {
        self.client
            .clone()
            .delete_file(self.request(
                proto::FileDelete {
                    path: path.into(),
                    recursive,
                },
                Some(GUEST_UNARY_TIMEOUT),
            ))
            .await
            .map_err(rpc_error)?;
        Ok(())
    }
    pub async fn search_files(
        &self,
        query: &str,
        path: &str,
        limit: u32,
    ) -> Result<FileSearchResult, GuestError> {
        let result = self
            .client
            .clone()
            .search_files(self.request(
                proto::FileSearch {
                    query: query.into(),
                    path: path.into(),
                    limit,
                },
                Some(GUEST_UNARY_TIMEOUT),
            ))
            .await
            .map_err(rpc_error)?
            .into_inner();
        Ok(FileSearchResult {
            entries: result.entries.into_iter().map(Into::into).collect(),
            truncated: result.truncated,
        })
    }
    pub async fn watch_files(
        &self,
        path: &str,
        after: Option<u64>,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<FileEvent, GuestError>> + Send>>, GuestError> {
        let mut stream = self
            .client
            .clone()
            .watch_files(self.request(
                proto::FileWatch {
                    path: path.into(),
                    after,
                },
                None,
            ))
            .await
            .map_err(rpc_error)?
            .into_inner();
        Ok(Box::pin(async_stream::try_stream! {
            while let Some(event) = stream.message().await.map_err(rpc_error)? {
                yield FileEvent {
                    sequence: event.sequence,
                    kind: event.kind,
                    path: event.path,
                    previous_path: event.previous_path,
                    entry: event.entry.map(Into::into),
                };
            }
        }))
    }
    pub async fn create_terminal(
        &self,
        creation_id: &str,
        cwd: &str,
        columns: u32,
        rows: u32,
    ) -> Result<TerminalCreation, GuestError> {
        let result = self
            .client
            .clone()
            .create_terminal(self.request(
                proto::TerminalCreate {
                    creation_id: creation_id.into(),
                    cwd: cwd.into(),
                    columns,
                    rows,
                },
                Some(GUEST_UNARY_TIMEOUT),
            ))
            .await
            .map_err(rpc_error)?
            .into_inner();
        let session: TerminalSession = result
            .session
            .ok_or_else(|| GuestError::Api {
                status: StatusCode::BAD_GATEWAY,
                message: "Nanoagent omitted the terminal session".into(),
            })?
            .into();
        if session.creation_id != creation_id {
            return Err(GuestError::TerminalCreationIdentityMismatch {
                expected: creation_id.into(),
                actual: session.creation_id,
                created_terminal_id: result.created.then_some(session.id),
            });
        }
        Ok(TerminalCreation {
            session,
            created: result.created,
        })
    }
    pub async fn list_terminals(&self) -> Result<Vec<TerminalSession>, GuestError> {
        Ok(self
            .client
            .clone()
            .list_terminals(self.request(proto::Empty {}, Some(GUEST_UNARY_TIMEOUT)))
            .await
            .map_err(rpc_error)?
            .into_inner()
            .sessions
            .into_iter()
            .map(Into::into)
            .collect())
    }
    pub async fn terminate_terminal(&self, id: &str) -> Result<(), GuestError> {
        self.client
            .clone()
            .terminate_terminal(self.request(
                proto::TerminalId { id: id.into() },
                Some(GUEST_UNARY_TIMEOUT),
            ))
            .await
            .map_err(rpc_error)?;
        Ok(())
    }
    pub(super) async fn codex_call(
        &self,
        method: &str,
        params: Value,
    ) -> Result<CodexCallResponse, GuestError> {
        let result = self
            .client
            .clone()
            .codex_call(self.request(
                proto::CodexRequest {
                    method: method.into(),
                    params_json: serde_json::to_vec(&params)?,
                },
                Some(GUEST_UNARY_TIMEOUT),
            ))
            .await
            .map_err(rpc_error)?
            .into_inner();
        Ok(CodexCallResponse {
            result: serde_json::from_slice(&result.result_json)?,
            event_sequence: result.event_sequence,
        })
    }
    pub async fn codex_login(&self) -> Result<CodexLoginSnapshot, GuestError> {
        let result = self
            .client
            .clone()
            .codex_login(self.request(proto::Empty {}, Some(GUEST_UNARY_TIMEOUT)))
            .await
            .map_err(rpc_error)?
            .into_inner();
        Ok(CodexLoginSnapshot {
            active: result.active,
            result: if result.result_json.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&result.result_json)?
            },
            started_at: result.started_at,
        })
    }
    pub async fn resolve_codex_approval(
        &self,
        approval_id: &str,
        decision: &str,
    ) -> Result<(), GuestError> {
        self.client
            .clone()
            .resolve_codex_approval(self.request(
                proto::CodexApproval {
                    approval_id: approval_id.into(),
                    decision: decision.into(),
                },
                Some(GUEST_UNARY_TIMEOUT),
            ))
            .await
            .map_err(rpc_error)?;
        Ok(())
    }
    pub async fn watch_codex_events(
        &self,
        after: u64,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<CodexEvent, GuestError>> + Send>>, GuestError>
    {
        let mut stream = self
            .client
            .clone()
            .watch_codex_events(self.request(proto::CodexWatch { after }, None))
            .await
            .map_err(rpc_error)?
            .into_inner();
        Ok(Box::pin(async_stream::try_stream! {
            while let Some(event) = stream.message().await.map_err(rpc_error)? {
                if event.raw_json.len() > MAX_GUEST_STREAM_LINE_BYTES {
                    Err(GuestError::ResponseTooLarge(MAX_GUEST_STREAM_LINE_BYTES))?;
                }
                yield CodexEvent {
                    sequence: event.sequence,
                    method: event.method,
                    approval_id: event.approval_id,
                    raw: serde_json::from_slice(&event.raw_json)?,
                };
            }
        }))
    }
    pub async fn attach_terminal(
        &self,
        inputs: tokio_stream::wrappers::ReceiverStream<proto::TerminalInput>,
    ) -> Result<tonic::Streaming<proto::TerminalOutput>, GuestError> {
        Ok(self
            .client
            .clone()
            .attach_terminal(self.request(inputs, None))
            .await
            .map_err(rpc_error)?
            .into_inner())
    }
}

fn validate_revision_content(revision: &str, content: &[u8]) -> Result<(), GuestError> {
    if revision.is_empty() {
        return Err(GuestError::MissingFileRevision);
    }
    if !is_file_revision(revision) {
        return Err(GuestError::InvalidFileRevision);
    }
    if revision_for_content(content) != revision {
        return Err(GuestError::FileRevisionMismatch);
    }
    Ok(())
}

impl From<proto::FileEntry> for FileEntry {
    fn from(value: proto::FileEntry) -> Self {
        Self {
            name: value.name,
            path: value.path,
            directory: value.directory,
            size: value.size,
            modified_at: value.modified_at,
        }
    }
}
impl From<proto::TerminalSession> for TerminalSession {
    fn from(value: proto::TerminalSession) -> Self {
        Self {
            id: value.id,
            creation_id: value.creation_id,
            cwd: value.cwd,
            created_at: value.created_at,
            last_activity_at: value.last_activity_at,
            attached: value.attached,
        }
    }
}

#[derive(prost::Message)]
struct RpcDetails {
    #[prost(message, repeated, tag = "3")]
    details: Vec<RpcDetail>,
}
#[derive(prost::Message)]
struct RpcDetail {
    #[prost(string, tag = "1")]
    type_url: String,
    #[prost(bytes = "vec", tag = "2")]
    value: Vec<u8>,
}

pub(crate) fn rpc_error(error: Status) -> GuestError {
    let mut status = match error.code() {
        tonic::Code::InvalidArgument => StatusCode::BAD_REQUEST,
        tonic::Code::Unauthenticated => StatusCode::UNAUTHORIZED,
        tonic::Code::PermissionDenied => StatusCode::FORBIDDEN,
        tonic::Code::NotFound => StatusCode::NOT_FOUND,
        tonic::Code::AlreadyExists | tonic::Code::Aborted | tonic::Code::FailedPrecondition => {
            StatusCode::CONFLICT
        }
        tonic::Code::ResourceExhausted => StatusCode::TOO_MANY_REQUESTS,
        tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        _ => StatusCode::BAD_GATEWAY,
    };
    let mut message = error.message().to_owned();
    if let Ok(details) = RpcDetails::decode(error.details()) {
        for detail in details.details {
            if detail.type_url == "type.googleapis.com/proompteng.runtime.guest.v1.OperationFailure"
                && let Ok(failure) = proto::OperationFailure::decode(detail.value.as_slice())
            {
                if failure.resource_too_large {
                    status = StatusCode::PAYLOAD_TOO_LARGE;
                }
                if !failure.current_revision.is_empty() {
                    message = serde_json::json!({"error": message, "currentRevision": failure.current_revision}).to_string();
                }
            }
        }
    }
    GuestError::Api { status, message }
}
