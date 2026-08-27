use std::{pin::Pin, sync::Arc, time::Duration};

use async_stream::try_stream;
use chrono::{DateTime, Utc};
use futures::{Stream, StreamExt};
use kube::{
    Api, Client, Resource, ResourceExt,
    api::{DeleteParams, ListParams, Patch, PatchParams, PostParams},
};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep};
use tonic::{Request, Response, Status};

use crate::{
    activity::{ActivityTracker, idle_deadline_passed},
    auth::{Authenticator, Principal, deterministic_agent_id},
    crd::{
        IDLE_MINUTES, LIFETIME_HOURS, MicroVM, MicroVMArchitecture, MicroVMDesiredState,
        MicroVMPhase, MicroVMResources, MicroVMSpec,
    },
    guest::{GuestClient, GuestError},
    metrics,
    tickets::TicketStore,
};

pub mod proto {
    tonic::include_proto!("proompteng.runtime.v1");
}

use proto::{
    Agent, AgentCondition, AgentPhase, Architecture, CodexAccount, CodexApprovalDecision,
    CodexEvent, CodexEventKind, CodexLogin, CodexThread, CodexTurn, CreateAgentRequest,
    CreateCodexThreadRequest, CreateDirectoryRequest, CreateTerminalRequest, DeleteAgentRequest,
    DeleteFileRequest, Empty, FileEntry, FileEvent, FileEventKind, GetAgentRequest,
    GetCodexAccountRequest, InterruptCodexTurnRequest, IssuePreviewSessionRequest,
    IssueTerminalTicketRequest, ListAgentsRequest, ListAgentsResponse, ListFilesRequest,
    ListFilesResponse, ListTerminalsRequest, ListTerminalsResponse, MoveFileRequest,
    PreviewSession, ReadFileRequest, ReadFileResponse, ResolveCodexApprovalRequest,
    ResumeAgentRequest, ResumeCodexThreadRequest, SearchFilesRequest, SearchFilesResponse,
    SendCodexTurnRequest, SleepAgentRequest, StartCodexLoginRequest, SteerCodexTurnRequest,
    TerminalSession, TerminalTicket, TerminateTerminalRequest, WatchAgentRequest,
    WatchCodexEventsRequest, WatchFilesRequest, WriteFileRequest, WriteFileResponse,
    micro_vm_control_plane_server::MicroVmControlPlane,
};

const OWNER_LABEL: &str = "runtime.proompteng.ai/owner";
const MAX_AGENTS: usize = 6;
const MAX_CODEX_EVENT_TEXT_BYTES: usize = 512 << 10;
const READY_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct ControlPlane {
    client: Client,
    namespace: Arc<str>,
    default_image: Arc<str>,
    architecture: MicroVMArchitecture,
    auth: Authenticator,
    tickets: TicketStore,
    activity: ActivityTracker,
    create_lock: Arc<Mutex<()>>,
}

pub struct ControlPlaneConfig {
    pub namespace: String,
    pub default_image: String,
    pub architecture: MicroVMArchitecture,
    pub internal_hmac_secret: String,
    pub ticket_signing_secret: String,
    pub public_url: String,
}

impl ControlPlane {
    pub fn new(
        client: Client,
        config: ControlPlaneConfig,
        activity: ActivityTracker,
    ) -> anyhow::Result<Self> {
        validate_digest_pinned_image(&config.default_image)?;
        let auth = Authenticator::new(
            client.clone(),
            config.namespace.clone(),
            config.internal_hmac_secret,
        )?;
        Ok(Self {
            client,
            namespace: config.namespace.into(),
            default_image: config.default_image.into(),
            architecture: config.architecture,
            auth,
            tickets: TicketStore::new(config.public_url, config.ticket_signing_secret)?,
            activity,
            create_lock: Arc::new(Mutex::new(())),
        })
    }

    pub fn tickets(&self) -> TicketStore {
        self.tickets.clone()
    }

    async fn authorize<T: prost::Message>(
        &self,
        request: &Request<T>,
    ) -> Result<Principal, Status> {
        self.auth.authorize(request).await
    }

    async fn owned_agent(&self, principal: &Principal, id: &str) -> Result<MicroVM, Status> {
        validate_resource_id(id)?;
        if id != deterministic_agent_id(&principal.owner_hash) {
            return Err(Status::permission_denied(
                "agent belongs to another identity",
            ));
        }
        let api: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        let agent = api.get(id).await.map_err(map_kube_error)?;
        ensure_owner(principal, &agent)?;
        Ok(agent)
    }

    async fn wake_agent(&self, principal: &Principal, id: &str) -> Result<MicroVM, Status> {
        for _ in 0..3 {
            let agent = self.owned_agent(principal, id).await?;
            let now = Utc::now();
            if deadline_passed(&agent.spec.expires_at, now) {
                return Err(Status::failed_precondition(
                    "agent has reached its hard expiry",
                ));
            }

            let needs_wake_patch = agent.spec.desired_state != MicroVMDesiredState::Running
                || idle_deadline_passed(&agent, now);
            if !needs_wake_patch {
                self.activity.touch(id);
                if agent_ready_for_guest(&agent) {
                    return Ok(agent);
                }
                return self.wait_ready(principal, id).await;
            }

            let api: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
            match api
                .patch(
                    id,
                    &PatchParams::default(),
                    &Patch::Merge(json!({
                        "metadata": {"resourceVersion": agent.resource_version()},
                        "spec": {
                            "desiredState": MicroVMDesiredState::Running,
                            "idleDeadline": (now + chrono::Duration::minutes(IDLE_MINUTES)).to_rfc3339(),
                        }
                    })),
                )
                .await
            {
                Ok(_) => {
                    self.activity.touch(id);
                    return self.wait_ready(principal, id).await;
                }
                Err(kube::Error::Api(response)) if response.code == 409 => continue,
                Err(error) => return Err(map_kube_error(error)),
            }
        }
        Err(Status::aborted(
            "agent lifecycle changed concurrently; retry the request",
        ))
    }

    async fn wait_ready(&self, principal: &Principal, id: &str) -> Result<MicroVM, Status> {
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            let agent = self.owned_agent(principal, id).await?;
            if agent_ready_for_guest(&agent) {
                return Ok(agent);
            }
            match agent.status.as_ref().map(|status| status.phase) {
                Some(MicroVMPhase::Failed) => {
                    let status = agent.status.as_ref().expect("checked status");
                    return Err(Status::failed_precondition(format!(
                        "{}: {}",
                        status.failure_reason.as_deref().unwrap_or("GuestFailed"),
                        status.message.as_deref().unwrap_or("guest failed to start"),
                    )));
                }
                Some(MicroVMPhase::Terminating) => {
                    return Err(Status::failed_precondition("agent is terminating"));
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                return Err(Status::deadline_exceeded(
                    "agent did not become ready within 120 seconds",
                ));
            }
            sleep(Duration::from_millis(750)).await;
        }
    }

    async fn guest(&self, principal: &Principal, id: &str) -> Result<GuestClient, Status> {
        self.wake_agent(principal, id).await?;
        GuestClient::for_agent(self.client.clone(), &self.namespace, id)
            .await
            .map_err(map_guest_error)
    }
}

fn agent_ready_for_guest(agent: &MicroVM) -> bool {
    let generation = agent.meta().generation.unwrap_or_default();
    agent.status.as_ref().is_some_and(|status| {
        status.phase == MicroVMPhase::Ready
            && status.guest_ready
            && status.observed_generation >= generation
    })
}

#[tonic::async_trait]
impl MicroVmControlPlane for ControlPlane {
    async fn create_agent(
        &self,
        request: Request<CreateAgentRequest>,
    ) -> Result<Response<Agent>, Status> {
        let principal = self.authorize(&request).await?;
        let display_name = validate_display_name(&request.get_ref().display_name)?;
        let id = deterministic_agent_id(&principal.owner_hash);
        // Serialize the optimistic count-and-create path within the singleton control plane.
        // The namespace ResourceQuota remains the atomic Kubernetes admission backstop if the
        // Deployment is ever scaled or another writer creates MicroVM resources directly.
        let _create_guard = self.create_lock.lock().await;
        let api: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        if let Some(existing) = api.get_opt(&id).await.map_err(map_kube_error)? {
            ensure_owner(&principal, &existing)?;
            return Ok(Response::new(agent_from_microvm(&existing)));
        }
        let count = api
            .list(&ListParams::default())
            .await
            .map_err(map_kube_error)?
            .items
            .len();
        if count >= MAX_AGENTS {
            metrics::global().record_quota_rejection();
            return Err(Status::resource_exhausted(
                "global six-agent capacity is full",
            ));
        }
        let now = Utc::now();
        let mut microvm = MicroVM::new(
            &id,
            MicroVMSpec {
                display_name,
                owner_hash: principal.owner_hash.clone(),
                desired_state: MicroVMDesiredState::Running,
                image: self.default_image.to_string(),
                architecture: self.architecture,
                resources: MicroVMResources::default(),
                created_at: now.to_rfc3339(),
                idle_deadline: (now + chrono::Duration::minutes(IDLE_MINUTES)).to_rfc3339(),
                expires_at: (now + chrono::Duration::hours(LIFETIME_HOURS)).to_rfc3339(),
            },
        );
        microvm.metadata.labels = Some(std::collections::BTreeMap::from([(
            OWNER_LABEL.to_owned(),
            principal.owner_hash[..32].to_owned(),
        )]));
        let created = match api.create(&PostParams::default(), &microvm).await {
            Ok(created) => created,
            Err(kube::Error::Api(response)) if response.code == 409 => {
                let existing = api.get(&id).await.map_err(map_kube_error)?;
                ensure_owner(&principal, &existing)?;
                existing
            }
            Err(error) => {
                let status = map_kube_error(error);
                if status.code() == tonic::Code::ResourceExhausted {
                    metrics::global().record_quota_rejection();
                }
                return Err(status);
            }
        };
        Ok(Response::new(agent_from_microvm(&created)))
    }

    async fn list_agents(
        &self,
        request: Request<ListAgentsRequest>,
    ) -> Result<Response<ListAgentsResponse>, Status> {
        let principal = self.authorize(&request).await?;
        let api: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        let selector = format!("{OWNER_LABEL}={}", &principal.owner_hash[..32]);
        let mut agents = api
            .list(&ListParams::default().labels(&selector))
            .await
            .map_err(map_kube_error)?
            .items
            .iter()
            .filter(|agent| agent.spec.owner_hash == principal.owner_hash)
            .map(agent_from_microvm)
            .collect::<Vec<_>>();
        agents.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(Response::new(ListAgentsResponse { agents }))
    }

    async fn get_agent(
        &self,
        request: Request<GetAgentRequest>,
    ) -> Result<Response<Agent>, Status> {
        let principal = self.authorize(&request).await?;
        let agent = self.owned_agent(&principal, &request.get_ref().id).await?;
        Ok(Response::new(agent_from_microvm(&agent)))
    }

    type WatchAgentStream = Pin<Box<dyn Stream<Item = Result<Agent, Status>> + Send>>;

    async fn watch_agent(
        &self,
        request: Request<WatchAgentRequest>,
    ) -> Result<Response<Self::WatchAgentStream>, Status> {
        let principal = self.authorize(&request).await?;
        let id = request.into_inner().id;
        self.owned_agent(&principal, &id).await?;
        let service = self.clone();
        let stream = try_stream! {
            let mut previous = String::new();
            loop {
                let agent = service.owned_agent(&principal, &id).await?;
                let current = serde_json::to_string(&agent).map_err(|error| Status::internal(error.to_string()))?;
                if current != previous {
                    previous = current;
                    yield agent_from_microvm(&agent);
                }
                sleep(Duration::from_secs(1)).await;
            }
        };
        Ok(Response::new(Box::pin(stream)))
    }

    async fn sleep_agent(
        &self,
        request: Request<SleepAgentRequest>,
    ) -> Result<Response<Agent>, Status> {
        let principal = self.authorize(&request).await?;
        let id = request.get_ref().id.clone();
        let agent = self.owned_agent(&principal, &id).await?;
        let api: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        let updated = api
            .patch(
                &id,
                &PatchParams::default(),
                &Patch::Merge(json!({
                    "metadata": {"resourceVersion": agent.resource_version()},
                    "spec": {"desiredState": MicroVMDesiredState::Sleeping}
                })),
            )
            .await
            .map_err(map_kube_error)?;
        Ok(Response::new(agent_from_microvm(&updated)))
    }

    async fn resume_agent(
        &self,
        request: Request<ResumeAgentRequest>,
    ) -> Result<Response<Agent>, Status> {
        let principal = self.authorize(&request).await?;
        let agent = self.wake_agent(&principal, &request.get_ref().id).await?;
        Ok(Response::new(agent_from_microvm(&agent)))
    }

    async fn delete_agent(
        &self,
        request: Request<DeleteAgentRequest>,
    ) -> Result<Response<Empty>, Status> {
        let principal = self.authorize(&request).await?;
        let id = request.get_ref().id.clone();
        self.owned_agent(&principal, &id).await?;
        let api: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        api.delete(&id, &DeleteParams::default())
            .await
            .map_err(map_kube_error)?;
        Ok(Response::new(Empty {}))
    }

    async fn list_files(
        &self,
        request: Request<ListFilesRequest>,
    ) -> Result<Response<ListFilesResponse>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let result = self
            .guest(&principal, &request.agent_id)
            .await?
            .list_files(&request.path)
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(ListFilesResponse {
            path: result.path,
            entries: result.entries.into_iter().map(file_entry).collect(),
        }))
    }

    async fn read_file(
        &self,
        request: Request<ReadFileRequest>,
    ) -> Result<Response<ReadFileResponse>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let result = self
            .guest(&principal, &request.agent_id)
            .await?
            .read_file(&request.path)
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(ReadFileResponse {
            path: result.path,
            content: result.content,
            content_type: result.content_type,
        }))
    }

    async fn write_file(
        &self,
        request: Request<WriteFileRequest>,
    ) -> Result<Response<WriteFileResponse>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let result = self
            .guest(&principal, &request.agent_id)
            .await?
            .write_file(&request.path, &request.content)
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(WriteFileResponse {
            path: result.path,
            size: result.size,
        }))
    }

    async fn create_directory(
        &self,
        request: Request<CreateDirectoryRequest>,
    ) -> Result<Response<FileEntry>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let entry = self
            .guest(&principal, &request.agent_id)
            .await?
            .create_directory(&request.path)
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(file_entry(entry)))
    }

    async fn move_file(
        &self,
        request: Request<MoveFileRequest>,
    ) -> Result<Response<FileEntry>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let entry = self
            .guest(&principal, &request.agent_id)
            .await?
            .move_file(&request.source_path, &request.destination_path)
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(file_entry(entry)))
    }

    async fn delete_file(
        &self,
        request: Request<DeleteFileRequest>,
    ) -> Result<Response<Empty>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        self.guest(&principal, &request.agent_id)
            .await?
            .delete_file(&request.path, request.recursive)
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(Empty {}))
    }

    async fn search_files(
        &self,
        request: Request<SearchFilesRequest>,
    ) -> Result<Response<SearchFilesResponse>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let limit = request.limit.clamp(1, 200);
        let entries = self
            .guest(&principal, &request.agent_id)
            .await?
            .search_files(&request.query, &request.path, limit)
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(SearchFilesResponse {
            entries: entries.into_iter().map(file_entry).collect(),
        }))
    }

    type WatchFilesStream = Pin<Box<dyn Stream<Item = Result<FileEvent, Status>> + Send>>;

    async fn watch_files(
        &self,
        request: Request<WatchFilesRequest>,
    ) -> Result<Response<Self::WatchFilesStream>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let activity = self.activity.clone();
        let agent_id = request.agent_id.clone();
        let stream = self
            .guest(&principal, &request.agent_id)
            .await?
            .watch_files(&request.path, request.after_sequence)
            .await
            .map_err(map_guest_error)?
            .map(move |event| {
                if event.is_ok() {
                    activity.touch(&agent_id);
                }
                event
                    .map(|event| FileEvent {
                        sequence: event.sequence,
                        kind: file_event_kind(&event.kind) as i32,
                        path: event.path,
                        previous_path: event.previous_path,
                        entry: event.entry.map(file_entry),
                    })
                    .map_err(map_guest_error)
            });
        Ok(Response::new(Box::pin(stream)))
    }

    async fn create_terminal(
        &self,
        request: Request<CreateTerminalRequest>,
    ) -> Result<Response<TerminalSession>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let terminal = self
            .guest(&principal, &request.agent_id)
            .await?
            .create_terminal(&request.cwd, request.columns, request.rows)
            .await
            .map_err(map_guest_error)?;
        metrics::global().record_pty_created(&request.agent_id, &terminal.id);
        Ok(Response::new(terminal_session(terminal)))
    }

    async fn list_terminals(
        &self,
        request: Request<ListTerminalsRequest>,
    ) -> Result<Response<ListTerminalsResponse>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let sessions = self
            .guest(&principal, &request.agent_id)
            .await?
            .list_terminals()
            .await
            .map_err(map_guest_error)?;
        metrics::global().replace_pty_sessions(
            &request.agent_id,
            sessions.iter().map(|session| session.id.clone()),
        );
        Ok(Response::new(ListTerminalsResponse {
            sessions: sessions.into_iter().map(terminal_session).collect(),
        }))
    }

    async fn terminate_terminal(
        &self,
        request: Request<TerminateTerminalRequest>,
    ) -> Result<Response<Empty>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        self.guest(&principal, &request.agent_id)
            .await?
            .terminate_terminal(&request.terminal_id)
            .await
            .map_err(map_guest_error)?;
        metrics::global().record_pty_terminated(&request.agent_id, &request.terminal_id);
        Ok(Response::new(Empty {}))
    }

    async fn issue_terminal_ticket(
        &self,
        request: Request<IssueTerminalTicketRequest>,
    ) -> Result<Response<TerminalTicket>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let terminals = self
            .guest(&principal, &request.agent_id)
            .await?
            .list_terminals()
            .await
            .map_err(map_guest_error)?;
        metrics::global().replace_pty_sessions(
            &request.agent_id,
            terminals.iter().map(|terminal| terminal.id.clone()),
        );
        if !terminals
            .iter()
            .any(|terminal| terminal.id == request.terminal_id)
        {
            return Err(Status::not_found("terminal session was not found"));
        }
        let issued = self.tickets.issue_terminal(
            &principal.owner_hash,
            &request.agent_id,
            &request.terminal_id,
        )?;
        Ok(Response::new(TerminalTicket {
            websocket_url: issued.url,
            ticket: issued.token,
            expires_at: issued.expires_at,
        }))
    }

    async fn get_codex_account(
        &self,
        request: Request<GetCodexAccountRequest>,
    ) -> Result<Response<CodexAccount>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let value = self
            .guest(&principal, &request.agent_id)
            .await?
            .codex_call("account/read", json!({"refreshToken": true}))
            .await
            .map_err(map_guest_error)?;
        let authenticated = value
            .pointer("/account")
            .is_some_and(|value| !value.is_null());
        Ok(Response::new(CodexAccount {
            authenticated,
            email: json_string(&value, &["/account/email", "/email"]),
            plan: json_string(&value, &["/account/planType", "/planType", "/plan"]),
            raw_json: value.to_string(),
        }))
    }

    async fn start_codex_login(
        &self,
        request: Request<StartCodexLoginRequest>,
    ) -> Result<Response<CodexLogin>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let value = self
            .guest(&principal, &request.agent_id)
            .await?
            .codex_call("account/login/start", json!({"type": "chatgptDeviceCode"}))
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(CodexLogin {
            login_id: json_string(&value, &["/loginId"]),
            verification_url: json_string(&value, &["/verificationUrl", "/authUrl"]),
            user_code: json_string(&value, &["/userCode"]),
            expires_at: String::new(),
            raw_json: value.to_string(),
        }))
    }

    async fn create_codex_thread(
        &self,
        request: Request<CreateCodexThreadRequest>,
    ) -> Result<Response<CodexThread>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let value = self
            .guest(&principal, &request.agent_id)
            .await?
            .codex_call(
                "thread/start",
                json!({
                    "cwd": "/workspace",
                    "runtimeWorkspaceRoots": ["/workspace"],
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": null,
                    "sandbox": "danger-full-access",
                    "ephemeral": false,
                    "experimentalRawEvents": false,
                }),
            )
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(CodexThread {
            id: json_string(&value, &["/thread/id"]),
            raw_json: value.to_string(),
        }))
    }

    async fn resume_codex_thread(
        &self,
        request: Request<ResumeCodexThreadRequest>,
    ) -> Result<Response<CodexThread>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        validate_codex_id(&request.thread_id)?;
        let value = self
            .guest(&principal, &request.agent_id)
            .await?
            .codex_call(
                "thread/resume",
                json!({
                    "threadId": request.thread_id,
                    "cwd": "/workspace",
                    "runtimeWorkspaceRoots": ["/workspace"],
                    "approvalPolicy": "on-request",
                    "sandbox": "danger-full-access",
                }),
            )
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(CodexThread {
            id: json_string(&value, &["/thread/id"]),
            raw_json: value.to_string(),
        }))
    }

    async fn send_codex_turn(
        &self,
        request: Request<SendCodexTurnRequest>,
    ) -> Result<Response<CodexTurn>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        validate_codex_id(&request.thread_id)?;
        let text = validate_prompt(&request.text)?;
        let value = self
            .guest(&principal, &request.agent_id)
            .await?
            .codex_call(
                "turn/start",
                json!({
                    "threadId": request.thread_id,
                    "input": [{"type": "text", "text": text, "text_elements": []}],
                    "cwd": "/workspace",
                    "runtimeWorkspaceRoots": ["/workspace"],
                    "approvalPolicy": "on-request",
                    "sandboxPolicy": {"type": "dangerFullAccess"},
                }),
            )
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(CodexTurn {
            id: json_string(&value, &["/turn/id"]),
            thread_id: request.thread_id,
            raw_json: value.to_string(),
        }))
    }

    async fn steer_codex_turn(
        &self,
        request: Request<SteerCodexTurnRequest>,
    ) -> Result<Response<CodexTurn>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        validate_codex_id(&request.thread_id)?;
        validate_codex_id(&request.turn_id)?;
        let text = validate_prompt(&request.text)?;
        let value = self
            .guest(&principal, &request.agent_id)
            .await?
            .codex_call(
                "turn/steer",
                json!({
                    "threadId": request.thread_id,
                    "expectedTurnId": request.turn_id,
                    "input": [{"type": "text", "text": text, "text_elements": []}],
                }),
            )
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(CodexTurn {
            id: json_string(&value, &["/turn/id", "/turnId"]),
            thread_id: request.thread_id,
            raw_json: value.to_string(),
        }))
    }

    async fn interrupt_codex_turn(
        &self,
        request: Request<InterruptCodexTurnRequest>,
    ) -> Result<Response<Empty>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        validate_codex_id(&request.thread_id)?;
        validate_codex_id(&request.turn_id)?;
        self.guest(&principal, &request.agent_id)
            .await?
            .codex_call(
                "turn/interrupt",
                json!({"threadId": request.thread_id, "turnId": request.turn_id}),
            )
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(Empty {}))
    }

    async fn resolve_codex_approval(
        &self,
        request: Request<ResolveCodexApprovalRequest>,
    ) -> Result<Response<Empty>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        validate_codex_id(&request.approval_id)?;
        let decision = match CodexApprovalDecision::try_from(request.decision)
            .unwrap_or(CodexApprovalDecision::Unspecified)
        {
            CodexApprovalDecision::ApproveOnce => "approveOnce",
            CodexApprovalDecision::ApproveSession => "approveSession",
            CodexApprovalDecision::Deny => "deny",
            CodexApprovalDecision::Unspecified => {
                return Err(Status::invalid_argument("approval decision is required"));
            }
        };
        self.guest(&principal, &request.agent_id)
            .await?
            .resolve_codex_approval(&request.approval_id, decision)
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(Empty {}))
    }

    type WatchCodexEventsStream = Pin<Box<dyn Stream<Item = Result<CodexEvent, Status>> + Send>>;

    async fn watch_codex_events(
        &self,
        request: Request<WatchCodexEventsRequest>,
    ) -> Result<Response<Self::WatchCodexEventsStream>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let activity = self.activity.clone();
        let agent_id = request.agent_id.clone();
        let stream = self
            .guest(&principal, &request.agent_id)
            .await?
            .watch_codex_events(request.after_sequence)
            .await
            .map_err(map_guest_error)?
            .map(move |event| {
                if event.is_ok() {
                    activity.touch(&agent_id);
                }
                event.map(codex_event).map_err(map_guest_error)
            });
        Ok(Response::new(Box::pin(stream)))
    }

    async fn issue_preview_session(
        &self,
        request: Request<IssuePreviewSessionRequest>,
    ) -> Result<Response<PreviewSession>, Status> {
        let principal = self.authorize(&request).await?;
        let request = request.into_inner();
        let port = u16::try_from(request.port)
            .ok()
            .filter(|port| *port >= 1024 && *port != 8080)
            .ok_or_else(|| {
                Status::invalid_argument(
                    "preview port must be between 1024 and 65535 and cannot be 8080",
                )
            })?;
        let path = validate_preview_path(&request.path)?;
        self.guest(&principal, &request.agent_id).await?;
        let issued =
            self.tickets
                .issue_preview(&principal.owner_hash, &request.agent_id, port, &path)?;
        metrics::global().record_preview_session();
        Ok(Response::new(PreviewSession {
            id: issued.token.clone(),
            launch_url: issued.url,
            expires_at: issued.expires_at,
        }))
    }
}

fn agent_from_microvm(microvm: &MicroVM) -> Agent {
    let status = microvm.status.as_ref();
    let resources = &microvm.spec.resources;
    Agent {
        id: microvm.name_any(),
        display_name: microvm.spec.display_name.clone(),
        phase: phase_to_proto(agent_phase(microvm)) as i32,
        architecture: architecture_to_proto(microvm.spec.architecture) as i32,
        cpu_millis: resources.cpu_millis,
        memory_mib: resources.memory_mib,
        workspace_gib: resources.workspace_gib,
        node_name: status
            .and_then(|value| value.node_name.clone())
            .unwrap_or_default(),
        message: status
            .and_then(|value| value.message.clone())
            .unwrap_or_default(),
        created_at: microvm.spec.created_at.clone(),
        ready_at: status
            .and_then(|value| value.ready_at.clone())
            .unwrap_or_default(),
        last_activity_at: status
            .and_then(|value| value.last_activity_at.clone())
            .unwrap_or_else(|| microvm.spec.created_at.clone()),
        idle_deadline: microvm.spec.idle_deadline.clone(),
        expires_at: microvm.spec.expires_at.clone(),
        conditions: status
            .map(|value| {
                value
                    .conditions
                    .iter()
                    .map(|condition| AgentCondition {
                        r#type: condition.type_.clone(),
                        status: condition.status.clone(),
                        reason: condition.reason.clone(),
                        message: condition.message.clone(),
                        last_transition_at: condition.last_transition_at.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn agent_phase(microvm: &MicroVM) -> MicroVMPhase {
    if microvm.meta().deletion_timestamp.is_some() {
        MicroVMPhase::Terminating
    } else {
        microvm
            .status
            .as_ref()
            .map(|status| status.phase)
            .unwrap_or_default()
    }
}

fn file_entry(entry: crate::guest::FileEntry) -> FileEntry {
    FileEntry {
        name: entry.name,
        path: entry.path,
        directory: entry.directory,
        size: entry.size,
        modified_at: entry.modified_at,
    }
}

fn terminal_session(session: crate::guest::TerminalSession) -> TerminalSession {
    TerminalSession {
        id: session.id,
        cwd: session.cwd,
        created_at: session.created_at,
        last_activity_at: session.last_activity_at,
        attached: session.attached,
    }
}

fn codex_event(event: crate::guest::CodexEvent) -> CodexEvent {
    let method = event.method.clone();
    let raw_json = event.raw.to_string();
    let raw_json = if raw_json.len() <= MAX_CODEX_EVENT_TEXT_BYTES {
        raw_json
    } else {
        "{}".to_owned()
    };
    CodexEvent {
        sequence: event.sequence,
        kind: codex_event_kind(&method, &event.approval_id, &event.raw) as i32,
        method,
        thread_id: json_string(&event.raw, &["/params/threadId", "/params/thread/id"]),
        turn_id: json_string(&event.raw, &["/params/turnId", "/params/turn/id"]),
        item_id: json_string(&event.raw, &["/params/itemId", "/params/item/id"]),
        text: codex_event_text(&event.raw),
        approval_id: event.approval_id,
        raw_json,
    }
}

fn codex_event_kind(method: &str, approval_id: &str, raw: &Value) -> CodexEventKind {
    let normalized_method = method.to_ascii_lowercase();
    if !approval_id.is_empty() {
        return CodexEventKind::Approval;
    }
    if let Some(kind) = raw
        .pointer("/params/item")
        .and_then(|item| codex_thread_item_kind(&normalized_method, item))
    {
        kind
    } else if normalized_method == "error" || normalized_method.contains("error") {
        CodexEventKind::Error
    } else if normalized_method.contains("warning") || normalized_method.contains("notice") {
        CodexEventKind::Warning
    } else if normalized_method.contains("tokenusage") || normalized_method.contains("ratelimits") {
        CodexEventKind::Usage
    } else if normalized_method.contains("filechange") || normalized_method.contains("diff") {
        CodexEventKind::FileDiff
    } else if normalized_method.contains("commandexecution")
        || normalized_method.contains("tool")
        || normalized_method.contains("mcp")
    {
        if normalized_method.contains("output") || normalized_method.contains("progress") {
            CodexEventKind::ToolOutput
        } else {
            CodexEventKind::ToolCall
        }
    } else if normalized_method.contains("plan") {
        CodexEventKind::Plan
    } else if normalized_method.contains("reasoning") {
        CodexEventKind::ReasoningSummary
    } else if normalized_method.contains("agentmessage") {
        CodexEventKind::AssistantText
    } else {
        CodexEventKind::ThreadState
    }
}

fn codex_thread_item_kind(normalized_method: &str, item: &Value) -> Option<CodexEventKind> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    Some(match item_type {
        "userMessage" => CodexEventKind::UserMessage,
        "agentMessage" => CodexEventKind::AssistantText,
        "reasoning" => CodexEventKind::ReasoningSummary,
        "plan" => CodexEventKind::Plan,
        "fileChange" => CodexEventKind::FileDiff,
        "commandExecution" => {
            if item
                .get("aggregatedOutput")
                .is_some_and(|value| !value.is_null())
                || matches!(
                    item.get("status").and_then(Value::as_str),
                    Some("completed" | "failed" | "declined")
                )
            {
                CodexEventKind::ToolOutput
            } else {
                CodexEventKind::ToolCall
            }
        }
        "mcpToolCall" | "dynamicToolCall" => {
            if item.get("result").is_some_and(|value| !value.is_null())
                || item.get("error").is_some_and(|value| !value.is_null())
                || item
                    .get("contentItems")
                    .is_some_and(|value| !value.is_null())
                || matches!(
                    item.get("status").and_then(Value::as_str),
                    Some("completed" | "failed")
                )
            {
                CodexEventKind::ToolOutput
            } else {
                CodexEventKind::ToolCall
            }
        }
        "webSearch" => {
            if normalized_method == "item/completed"
                || item.get("action").is_some_and(|value| !value.is_null())
            {
                CodexEventKind::ToolOutput
            } else {
                CodexEventKind::ToolCall
            }
        }
        "imageView" | "subAgentActivity" => CodexEventKind::ToolCall,
        "imageGeneration" => {
            if matches!(
                item.get("status").and_then(Value::as_str),
                Some("completed" | "failed")
            ) {
                CodexEventKind::ToolOutput
            } else {
                CodexEventKind::ToolCall
            }
        }
        "collabAgentToolCall" => {
            if matches!(
                item.get("status").and_then(Value::as_str),
                Some("completed" | "failed")
            ) {
                CodexEventKind::ToolOutput
            } else {
                CodexEventKind::ToolCall
            }
        }
        _ => return None,
    })
}

fn codex_event_text(value: &Value) -> String {
    bounded_codex_text(codex_event_text_unbounded(value))
}

fn codex_event_text_unbounded(value: &Value) -> String {
    if let Some(outcome) = codex_collaboration_outcome(value) {
        return outcome;
    }

    let direct = json_string(
        value,
        &[
            "/params/delta",
            "/params/text",
            "/params/message",
            "/params/reason",
            "/params/summary",
            "/params/details",
            "/params/diff",
            "/params/command",
            "/params/item/text",
            "/params/item/aggregatedOutput",
            "/params/item/command",
            "/params/item/query",
            "/params/item/path",
            "/params/item/savedPath",
            "/params/item/result",
            "/params/item/revisedPrompt",
            "/params/item/failure/message",
            "/params/item/prompt",
            "/params/item/agentPath",
            "/params/error/message",
            "/params/turn/error/message",
        ],
    );
    if !direct.is_empty() {
        return direct;
    }
    for pointer in ["/params/item/content", "/params/item/summary"] {
        let text = value
            .pointer(pointer)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                item.as_str()
                    .or_else(|| item.get("text").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return text;
        }
    }
    for pointer in [
        "/params/item/contentItems",
        "/params/item/result/content",
        "/params/item/changes",
    ] {
        let text = value
            .pointer(pointer)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| {
                item.as_str()
                    .or_else(|| item.get("text").and_then(Value::as_str))
                    .or_else(|| item.get("diff").and_then(Value::as_str))
                    .or_else(|| item.get("path").and_then(Value::as_str))
                    .or_else(|| match item.get("type").and_then(Value::as_str) {
                        Some("inputImage") => Some("[Image output]"),
                        Some("inputAudio") => Some("[Audio output]"),
                        _ => None,
                    })
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return text;
        }
    }
    if let Some(plan) = value.pointer("/params/plan").and_then(Value::as_array) {
        let explanation = value
            .pointer("/params/explanation")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let steps = plan
            .iter()
            .filter_map(|step| {
                let text = step.get("step")?.as_str()?;
                let status = step
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending");
                let marker = if status == "completed" { "x" } else { " " };
                Some(format!("- [{marker}] {text}"))
            })
            .collect::<Vec<_>>()
            .join("\n");
        return [explanation, steps.as_str()]
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    String::new()
}

fn codex_collaboration_outcome(value: &Value) -> Option<String> {
    let item = value.pointer("/params/item")?;
    if item.get("type").and_then(Value::as_str) != Some("collabAgentToolCall") {
        return None;
    }

    let status = item.get("status").and_then(Value::as_str)?;
    if !matches!(status, "completed" | "failed") {
        return None;
    }

    let tool = item
        .get("tool")
        .and_then(Value::as_str)
        .filter(|tool| !tool.is_empty());
    let mut lines = vec![match tool {
        Some(tool) => format!("Agent collaboration {tool}: {status}"),
        None => format!("Agent collaboration: {status}"),
    }];

    if let Some(states) = item.get("agentsStates").and_then(Value::as_object) {
        let mut states = states.iter().collect::<Vec<_>>();
        states.sort_by(|(left, _), (right, _)| left.cmp(right));
        for (thread_id, state) in states {
            let agent_status = state
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let message = state
                .get("message")
                .and_then(Value::as_str)
                .filter(|message| !message.is_empty());
            lines.push(match message {
                Some(message) => format!("{thread_id}: {agent_status} — {message}"),
                None => format!("{thread_id}: {agent_status}"),
            });
        }
    }

    Some(lines.join("\n"))
}

fn bounded_codex_text(text: String) -> String {
    if text.len() <= MAX_CODEX_EVENT_TEXT_BYTES {
        return text;
    }
    const MARKER: &str = "\n… output truncated …";
    let mut end = MAX_CODEX_EVENT_TEXT_BYTES.saturating_sub(MARKER.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &text[..end], MARKER)
}

fn file_event_kind(kind: &str) -> FileEventKind {
    match kind {
        "created" => FileEventKind::Created,
        "changed" => FileEventKind::Changed,
        "removed" => FileEventKind::Removed,
        "renamed" => FileEventKind::Renamed,
        _ => FileEventKind::Reset,
    }
}

fn phase_to_proto(phase: MicroVMPhase) -> AgentPhase {
    match phase {
        MicroVMPhase::Pending => AgentPhase::Pending,
        MicroVMPhase::Booting => AgentPhase::Booting,
        MicroVMPhase::Ready => AgentPhase::Ready,
        MicroVMPhase::Sleeping => AgentPhase::Sleeping,
        MicroVMPhase::Failed => AgentPhase::Failed,
        MicroVMPhase::Terminating => AgentPhase::Terminating,
    }
}

fn architecture_to_proto(architecture: MicroVMArchitecture) -> Architecture {
    match architecture {
        MicroVMArchitecture::Amd64 => Architecture::Amd64,
        MicroVMArchitecture::Arm64 => Architecture::Arm64,
    }
}

fn ensure_owner(principal: &Principal, agent: &MicroVM) -> Result<(), Status> {
    if agent.spec.owner_hash != principal.owner_hash {
        return Err(Status::permission_denied(
            "agent belongs to another identity",
        ));
    }
    Ok(())
}

fn validate_display_name(value: &str) -> Result<String, Status> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 64 {
        return Err(Status::invalid_argument(
            "display_name must contain between 1 and 64 characters",
        ));
    }
    Ok(value.to_owned())
}

fn validate_resource_id(value: &str) -> Result<(), Status> {
    if value.is_empty()
        || value.len() > 63
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(Status::invalid_argument("invalid agent id"));
    }
    Ok(())
}

fn validate_codex_id(value: &str) -> Result<(), Status> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(Status::invalid_argument("invalid Codex identifier"));
    }
    Ok(())
}

fn validate_prompt(value: &str) -> Result<String, Status> {
    let value = value.trim();
    if value.is_empty() || value.len() > 64 << 10 {
        return Err(Status::invalid_argument(
            "message must contain between 1 byte and 64 KiB",
        ));
    }
    Ok(value.to_owned())
}

fn validate_preview_path(value: &str) -> Result<String, Status> {
    let value = if value.is_empty() { "/" } else { value };
    if !value.starts_with('/') || value.len() > 4_096 || value.contains(['\0', '\r', '\n', '#']) {
        return Err(Status::invalid_argument(
            "preview path must be an absolute path without a fragment and at most 4096 bytes",
        ));
    }
    let parsed = reqwest::Url::parse(&format!("http://guest.invalid{value}"))
        .map_err(|_| Status::invalid_argument("preview path is invalid"))?;
    if parsed.host_str() != Some("guest.invalid") || parsed.fragment().is_some() {
        return Err(Status::invalid_argument("preview path is invalid"));
    }
    let mut normalized = parsed.path().to_owned();
    if let Some(query) = parsed.query() {
        normalized.push('?');
        normalized.push_str(query);
    }
    Ok(normalized)
}

fn validate_digest_pinned_image(image: &str) -> anyhow::Result<()> {
    let (_, digest) = image
        .rsplit_once("@sha256:")
        .ok_or_else(|| anyhow::anyhow!("TENGRI_DEFAULT_IMAGE must be pinned by sha256 digest"))?;
    anyhow::ensure!(
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')),
        "TENGRI_DEFAULT_IMAGE has an invalid sha256 digest"
    );
    Ok(())
}

fn json_string(value: &Value, pointers: &[&str]) -> String {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

fn deadline_passed(value: &str, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc) <= now)
        .unwrap_or(false)
}

fn map_kube_error(error: kube::Error) -> Status {
    if let kube::Error::Api(response) = &error {
        return match response.code {
            403 if response.message.contains("quota") => {
                Status::resource_exhausted(response.message.clone())
            }
            403 => Status::permission_denied(response.message.clone()),
            404 => Status::not_found(response.message.clone()),
            409 => Status::already_exists(response.message.clone()),
            422 => Status::invalid_argument(response.message.clone()),
            _ => Status::internal(response.message.clone()),
        };
    }
    Status::internal(error.to_string())
}

fn map_guest_error(error: GuestError) -> Status {
    metrics::global().record_guest_failure();
    match error {
        GuestError::NotReady(message) | GuestError::MissingGuestIp(message) => {
            Status::unavailable(message)
        }
        GuestError::Api { status, message } if status == reqwest::StatusCode::NOT_FOUND => {
            Status::not_found(message)
        }
        GuestError::Api { status, message } if status == reqwest::StatusCode::CONFLICT => {
            Status::already_exists(message)
        }
        GuestError::Api { status, message }
            if status == reqwest::StatusCode::BAD_REQUEST
                || status == reqwest::StatusCode::UNPROCESSABLE_ENTITY =>
        {
            Status::invalid_argument(message)
        }
        GuestError::Api { status, message } if status == reqwest::StatusCode::FORBIDDEN => {
            Status::permission_denied(message)
        }
        other => Status::internal(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::owner_hash;
    use crate::crd::MicroVMStatus;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;

    #[test]
    fn caller_cannot_select_resource_policy() {
        let request = CreateAgentRequest {
            display_name: "My agent".to_owned(),
        };
        assert_eq!(request.display_name, "My agent");
        assert_eq!(MicroVMResources::default().cpu_millis, 2_000);
        assert_eq!(MicroVMResources::default().memory_mib, 4_096);
        assert_eq!(MicroVMResources::default().workspace_gib, 16);
    }

    #[test]
    fn deterministic_identity_is_one_agent_per_github_subject() {
        let first = deterministic_agent_id(&owner_hash("github:42"));
        let second = deterministic_agent_id(&owner_hash("github:42"));
        let other = deterministic_agent_id(&owner_hash("github:43"));
        assert_eq!(first, second);
        assert_ne!(first, other);
    }

    #[test]
    fn default_image_must_be_digest_pinned() {
        assert!(validate_digest_pinned_image("registry.example/nanoagent:latest").is_err());
        assert!(
            validate_digest_pinned_image(&format!(
                "registry.example/nanoagent@sha256:{}",
                "a".repeat(64)
            ))
            .is_ok()
        );
    }

    #[test]
    fn ready_running_agent_does_not_require_a_resume_transition() {
        let now = Utc::now();
        let mut agent = MicroVM::new(
            "agent-ready",
            MicroVMSpec {
                display_name: "Ready agent".to_owned(),
                owner_hash: "a".repeat(64),
                desired_state: MicroVMDesiredState::Running,
                image: format!("registry.example/nanoagent@sha256:{}", "b".repeat(64)),
                architecture: MicroVMArchitecture::Amd64,
                resources: MicroVMResources::default(),
                created_at: now.to_rfc3339(),
                idle_deadline: (now + chrono::Duration::minutes(IDLE_MINUTES)).to_rfc3339(),
                expires_at: (now + chrono::Duration::hours(LIFETIME_HOURS)).to_rfc3339(),
            },
        );
        agent.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Ready,
            guest_ready: true,
            ..MicroVMStatus::default()
        });

        assert!(agent_ready_for_guest(&agent));
        agent.status.as_mut().expect("status").guest_ready = false;
        assert!(!agent_ready_for_guest(&agent));
    }

    #[test]
    fn stale_ready_status_cannot_skip_a_sleep_or_resume_transition() {
        let now = Utc::now();
        let mut agent = MicroVM::new(
            "agent-transitioning",
            MicroVMSpec {
                display_name: "Transitioning agent".to_owned(),
                owner_hash: "a".repeat(64),
                desired_state: MicroVMDesiredState::Running,
                image: format!("registry.example/nanoagent@sha256:{}", "b".repeat(64)),
                architecture: MicroVMArchitecture::Amd64,
                resources: MicroVMResources::default(),
                created_at: now.to_rfc3339(),
                idle_deadline: (now + chrono::Duration::minutes(IDLE_MINUTES)).to_rfc3339(),
                expires_at: (now + chrono::Duration::hours(LIFETIME_HOURS)).to_rfc3339(),
            },
        );
        agent.metadata.generation = Some(2);
        agent.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Ready,
            guest_ready: true,
            observed_generation: 1,
            ..MicroVMStatus::default()
        });

        assert!(!agent_ready_for_guest(&agent));
        agent.status.as_mut().expect("status").observed_generation = 2;
        assert!(agent_ready_for_guest(&agent));
    }

    #[test]
    fn deletion_timestamp_is_exposed_as_terminating() {
        let now = Utc::now();
        let mut agent = MicroVM::new(
            "agent-deleting",
            MicroVMSpec {
                display_name: "Deleting agent".to_owned(),
                owner_hash: "a".repeat(64),
                desired_state: MicroVMDesiredState::Running,
                image: format!("registry.example/nanoagent@sha256:{}", "b".repeat(64)),
                architecture: MicroVMArchitecture::Amd64,
                resources: MicroVMResources::default(),
                created_at: now.to_rfc3339(),
                idle_deadline: (now + chrono::Duration::minutes(IDLE_MINUTES)).to_rfc3339(),
                expires_at: (now + chrono::Duration::hours(LIFETIME_HOURS)).to_rfc3339(),
            },
        );
        agent.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Ready,
            guest_ready: true,
            ..MicroVMStatus::default()
        });
        agent.metadata.deletion_timestamp = Some(Time(k8s_openapi::jiff::Timestamp::now()));

        assert_eq!(agent_phase(&agent), MicroVMPhase::Terminating);
        assert_eq!(
            agent_from_microvm(&agent).phase,
            AgentPhase::Terminating as i32,
        );
    }

    #[test]
    fn codex_events_are_typed_without_fabrication() {
        assert_eq!(
            codex_event_kind("item/agentMessage/delta", "", &json!({})),
            CodexEventKind::AssistantText
        );
        assert_eq!(
            codex_event_kind(
                "item/commandExecution/requestApproval",
                "approval-1",
                &json!({}),
            ),
            CodexEventKind::Approval
        );
        assert_eq!(
            codex_event_kind("item/fileChange/patchUpdated", "", &json!({})),
            CodexEventKind::FileDiff
        );
        assert_eq!(
            codex_event_kind(
                "item/completed",
                "",
                &json!({"params": {"item": {"type": "userMessage"}}}),
            ),
            CodexEventKind::UserMessage
        );
        assert_eq!(
            codex_event_kind(
                "item/completed",
                "",
                &json!({"params": {"item": {"type": "agentMessage", "text": "done"}}}),
            ),
            CodexEventKind::AssistantText
        );
        assert_eq!(
            codex_event_kind(
                "item/completed",
                "",
                &json!({
                    "params": {
                        "item": {
                            "type": "commandExecution",
                            "status": "completed",
                            "aggregatedOutput": "12 pass"
                        }
                    }
                }),
            ),
            CodexEventKind::ToolOutput
        );
        assert_eq!(
            codex_event_kind(
                "item/started",
                "",
                &json!({"params": {"item": {"type": "webSearch", "query": "Kata Firecracker", "action": null}}}),
            ),
            CodexEventKind::ToolCall
        );
        assert_eq!(
            codex_event_kind(
                "item/completed",
                "",
                &json!({"params": {"item": {"type": "webSearch", "query": "Kata Firecracker", "action": null}}}),
            ),
            CodexEventKind::ToolOutput
        );
        assert_eq!(
            codex_event_kind(
                "thread/item",
                "",
                &json!({
                    "params": {
                        "item": {
                            "type": "webSearch",
                            "query": "Kata Firecracker",
                            "action": {"type": "search", "query": "Kata Firecracker", "queries": null}
                        }
                    }
                }),
            ),
            CodexEventKind::ToolOutput
        );
        assert_eq!(
            codex_event_text(&json!({
                "params": {
                    "item": {
                        "type": "imageGeneration",
                        "status": "completed",
                        "result": "generated-image-result"
                    }
                }
            })),
            "generated-image-result"
        );
        assert_eq!(
            codex_event_text(&json!({
                "params": {
                    "item": {
                        "type": "imageGeneration",
                        "status": "completed",
                        "revisedPrompt": "refined image prompt"
                    }
                }
            })),
            "refined image prompt"
        );
        assert_eq!(
            codex_event_kind(
                "item/completed",
                "",
                &json!({"params": {"item": {"type": "imageView", "path": "/workspace/image.png"}}}),
            ),
            CodexEventKind::ToolCall
        );
        assert_eq!(
            codex_event_kind(
                "item/completed",
                "",
                &json!({"params": {"item": {"type": "imageGeneration", "status": "completed", "result": "opaque"}}}),
            ),
            CodexEventKind::ToolOutput
        );
        assert_eq!(
            codex_event_text(&json!({
                "params": {
                    "item": {
                        "type": "collabAgentToolCall",
                        "tool": "spawnAgent",
                        "status": "completed",
                        "prompt": "repeat only the input",
                        "agentsStates": {
                            "thread-b": {"status": "failed", "message": "test failed"},
                            "thread-a": {"status": "completed", "message": "PR opened"}
                        }
                    }
                }
            })),
            "Agent collaboration spawnAgent: completed\nthread-a: completed — PR opened\nthread-b: failed — test failed"
        );
        assert_eq!(
            codex_event_text(&json!({
                "params": {"item": {"content": [{"type": "text", "text": "actual input"}]}}
            })),
            "actual input"
        );
        assert_eq!(
            codex_event_text(&json!({
                "params": {
                    "item": {
                        "type": "fileChange",
                        "changes": [{"path": "/workspace/main.rs", "diff": "+fn main() {}"}]
                    }
                }
            })),
            "+fn main() {}"
        );
        assert_eq!(
            codex_event_kind("configWarning", "", &json!({})),
            CodexEventKind::Warning
        );
        assert_eq!(
            codex_event_text(&json!({
                "params": {
                    "explanation": "Implementation order",
                    "plan": [
                        {"step": "Build runtime", "status": "completed"},
                        {"step": "Verify guest", "status": "inProgress"}
                    ]
                }
            })),
            "Implementation order\n\n- [x] Build runtime\n- [ ] Verify guest"
        );
        assert_eq!(
            codex_event_text(&json!({"params": {"turn": {"error": {"message": "turn failed"}}}})),
            "turn failed"
        );
        assert_eq!(
            codex_event_text(&json!({
                "params": {"item": {"contentItems": [{"type": "inputImage", "imageUrl": "opaque"}]}}
            })),
            "[Image output]"
        );
        let bounded = codex_event_text(&json!({"params": {"text": "😀".repeat(200_000)}}));
        assert!(bounded.len() <= MAX_CODEX_EVENT_TEXT_BYTES);
        assert!(bounded.ends_with("… output truncated …"));
        assert!(bounded.is_char_boundary(bounded.len()));
    }

    #[test]
    fn preview_path_is_normalized_and_cannot_smuggle_a_fragment() {
        assert_eq!(
            validate_preview_path("/app?mode=dev").expect("preview path"),
            "/app?mode=dev",
        );
        assert_eq!(validate_preview_path("").expect("default path"), "/");
        assert!(validate_preview_path("https://private.example").is_err());
        assert!(validate_preview_path("/app#stolen").is_err());
        assert!(validate_preview_path("/app\r\nX-Injected: 1").is_err());
    }
}
