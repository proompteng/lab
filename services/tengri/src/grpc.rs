use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Weak},
    time::Duration,
};

use async_stream::try_stream;
use chrono::{DateTime, Utc};
use futures::{Stream, StreamExt};
use kube::{
    Api, Client, Resource, ResourceExt,
    api::{DeleteParams, ListParams, Patch, PatchParams, PostParams},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, oneshot};
use tokio::time::{Instant, sleep};
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::{
    activity::{
        ActivityTracker, RESUME_STARTED_AT_ANNOTATION, effective_idle_deadline,
        idle_deadline_passed, last_activity_at,
    },
    auth::{Authenticator, Principal, deterministic_agent_id},
    crd::{
        IDLE_MINUTES, LIFETIME_HOURS, MicroVM, MicroVMArchitecture, MicroVMDesiredState,
        MicroVMPhase, MicroVMResources, MicroVMSpec,
    },
    gateway::PreviewOrigin,
    guest::{
        GuestClient, GuestError, TerminalCreation as GuestTerminalCreation,
        TerminalIdentityRegistry,
    },
    metrics,
    pod::{SINGLE_MOUNT_STORAGE_LAYOUT, STORAGE_LAYOUT_ANNOTATION},
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
    ResumeAgentRequest, ResumeCodexThreadRequest, RevokePreviewSessionRequest, SearchFilesRequest,
    SearchFilesResponse, SendCodexTurnRequest, SleepAgentRequest, StartCodexLoginRequest,
    SteerCodexTurnRequest, TerminalSession, TerminalTicket, TerminateTerminalRequest,
    WatchAgentRequest, WatchCodexEventsRequest, WatchFilesRequest, WriteFileRequest,
    WriteFileResponse, micro_vm_control_plane_server::MicroVmControlPlane,
};

const OWNER_LABEL: &str = "runtime.proompteng.ai/owner";
const CONTROL_PLANE_SERVICE: &str = "proompteng.runtime.v1.MicroVMControlPlane";
const MAX_AGENTS: usize = 6;
const MAX_CODEX_EVENT_TEXT_BYTES: usize = 512 << 10;
const CODEX_LOGIN_ATTEMPT_TTL_MINUTES: i64 = 15;
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const LEGACY_TERMINAL_TICKET_TIMEOUT: Duration = Duration::from_secs(30);
const LEGACY_TERMINAL_CREATION_PREFIX: &str = "legacy-grpc-";
const PROVISIONAL_TERMINAL_CLEANUP_RETRY: Duration = Duration::from_secs(2);
const PROVISIONAL_TERMINAL_ANNOTATION_PREFIX: &str = "runtime.proompteng.ai/provisional-terminal-";
const PROVISIONAL_TERMINAL_CREATION_ANNOTATION_PREFIX: &str =
    "runtime.proompteng.ai/provisional-terminal-create-";

#[derive(Clone)]
pub struct ControlPlane {
    client: Client,
    namespace: Arc<str>,
    default_image: Arc<str>,
    architecture: MicroVMArchitecture,
    auth: Authenticator,
    tickets: TicketStore,
    preview_origin: PreviewOrigin,
    activity: ActivityTracker,
    create_lock: Arc<Mutex<()>>,
    terminal_identities: TerminalIdentityRegistry,
    provisional_terminal_leases: ProvisionalTerminalLeaseManager,
}

pub struct ControlPlaneConfig {
    pub namespace: String,
    pub default_image: String,
    pub architecture: MicroVMArchitecture,
    pub internal_hmac_secret: String,
    pub ticket_signing_secret: String,
    pub public_url: String,
    pub preview_origin: PreviewOrigin,
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
        let namespace: Arc<str> = config.namespace.into();
        let terminal_identities = TerminalIdentityRegistry::default();
        let provisional_terminal_leases = ProvisionalTerminalLeaseManager::new(
            client.clone(),
            namespace.clone(),
            terminal_identities.clone(),
        );
        Ok(Self {
            client,
            namespace,
            default_image: config.default_image.into(),
            architecture: config.architecture,
            auth,
            tickets: TicketStore::new(config.public_url, config.ticket_signing_secret)?,
            preview_origin: config.preview_origin,
            activity,
            create_lock: Arc::new(Mutex::new(())),
            terminal_identities,
            provisional_terminal_leases,
        })
    }

    pub fn tickets(&self) -> TicketStore {
        self.tickets.clone()
    }

    pub async fn recover_provisional_terminal_leases(&self) -> Result<(), kube::Error> {
        self.provisional_terminal_leases.recover().await
    }

    async fn authorize<T: prost::Message>(
        &self,
        request: &Request<T>,
        method: &'static str,
    ) -> Result<Principal, Status> {
        let rpc_path = format!("/{CONTROL_PLANE_SERVICE}/{method}");
        self.auth.authorize(request, &rpc_path).await
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
            let patch = wake_patch(&agent, now);
            match api
                .patch(id, &PatchParams::default(), &Patch::Merge(&patch))
                .await
            {
                Ok(_) => {
                    self.activity.touch(id);
                    return self.wait_ready(principal, id).await;
                }
                Err(error) if is_conflict(&error) => continue,
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
        GuestClient::for_agent_with_terminal_identities(
            self.client.clone(),
            &self.namespace,
            id,
            self.terminal_identities.clone(),
        )
        .await
        .map_err(map_guest_error)
    }
}

fn wake_patch(agent: &MicroVM, now: DateTime<Utc>) -> Value {
    let mut patch = json!({
        "metadata": {"resourceVersion": agent.resource_version()},
        "spec": {
            "desiredState": MicroVMDesiredState::Running,
            "idleDeadline": (now + chrono::Duration::minutes(IDLE_MINUTES)).to_rfc3339(),
        }
    });
    let resuming = agent.spec.desired_state == MicroVMDesiredState::Sleeping
        || agent.status.as_ref().map(|status| status.phase) == Some(MicroVMPhase::Sleeping);
    if resuming {
        patch["metadata"]["annotations"][RESUME_STARTED_AT_ANNOTATION] =
            Value::String(now.to_rfc3339());
    }
    patch
}

fn agent_ready_for_guest(agent: &MicroVM) -> bool {
    let generation = agent.meta().generation.unwrap_or_default();
    agent.status.as_ref().is_some_and(|status| {
        status.phase == MicroVMPhase::Ready
            && status.guest_ready
            && status.observed_generation >= generation
    })
}

fn apply_new_agent_metadata(microvm: &mut MicroVM, owner_hash: &str, storage_layout: &str) {
    microvm
        .metadata
        .labels
        .get_or_insert_default()
        .insert(OWNER_LABEL.to_owned(), owner_hash[..32].to_owned());
    microvm.metadata.annotations.get_or_insert_default().insert(
        STORAGE_LAYOUT_ANNOTATION.to_owned(),
        storage_layout.to_owned(),
    );
}

#[tonic::async_trait]
impl MicroVmControlPlane for ControlPlane {
    async fn create_agent(
        &self,
        request: Request<CreateAgentRequest>,
    ) -> Result<Response<Agent>, Status> {
        let principal = self.authorize(&request, "CreateAgent").await?;
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
        apply_new_agent_metadata(
            &mut microvm,
            &principal.owner_hash,
            SINGLE_MOUNT_STORAGE_LAYOUT,
        );
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
        let principal = self.authorize(&request, "ListAgents").await?;
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
        let principal = self.authorize(&request, "GetAgent").await?;
        let agent = self.owned_agent(&principal, &request.get_ref().id).await?;
        Ok(Response::new(agent_from_microvm(&agent)))
    }

    type WatchAgentStream = Pin<Box<dyn Stream<Item = Result<Agent, Status>> + Send>>;

    async fn watch_agent(
        &self,
        request: Request<WatchAgentRequest>,
    ) -> Result<Response<Self::WatchAgentStream>, Status> {
        let principal = self.authorize(&request, "WatchAgent").await?;
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
        let principal = self.authorize(&request, "SleepAgent").await?;
        let id = request.get_ref().id.clone();
        for _ in 0..3 {
            let agent = self.owned_agent(&principal, &id).await?;
            if agent.spec.desired_state == MicroVMDesiredState::Sleeping {
                return Ok(Response::new(agent_from_microvm(&agent)));
            }
            let api: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
            match api
                .patch(
                    &id,
                    &PatchParams::default(),
                    &Patch::Merge(json!({
                        "metadata": {"resourceVersion": agent.resource_version()},
                        "spec": {"desiredState": MicroVMDesiredState::Sleeping}
                    })),
                )
                .await
            {
                Ok(updated) => return Ok(Response::new(agent_from_microvm(&updated))),
                Err(error) if is_conflict(&error) => continue,
                Err(error) => return Err(map_kube_error(error)),
            }
        }
        Err(Status::aborted(
            "agent lifecycle changed concurrently; retry the request",
        ))
    }

    async fn resume_agent(
        &self,
        request: Request<ResumeAgentRequest>,
    ) -> Result<Response<Agent>, Status> {
        let principal = self.authorize(&request, "ResumeAgent").await?;
        let agent = self.wake_agent(&principal, &request.get_ref().id).await?;
        Ok(Response::new(agent_from_microvm(&agent)))
    }

    async fn delete_agent(
        &self,
        request: Request<DeleteAgentRequest>,
    ) -> Result<Response<Empty>, Status> {
        let principal = self.authorize(&request, "DeleteAgent").await?;
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
        let principal = self.authorize(&request, "ListFiles").await?;
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
        let principal = self.authorize(&request, "ReadFile").await?;
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
        let principal = self.authorize(&request, "WriteFile").await?;
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
        let principal = self.authorize(&request, "CreateDirectory").await?;
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
        let principal = self.authorize(&request, "MoveFile").await?;
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
        let principal = self.authorize(&request, "DeleteFile").await?;
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
        let principal = self.authorize(&request, "SearchFiles").await?;
        let request = request.into_inner();
        let limit = request.limit.clamp(1, 200);
        let result = self
            .guest(&principal, &request.agent_id)
            .await?
            .search_files(&request.query, &request.path, limit)
            .await
            .map_err(map_guest_error)?;
        Ok(Response::new(SearchFilesResponse {
            entries: result.entries.into_iter().map(file_entry).collect(),
            truncated: result.truncated,
        }))
    }

    type WatchFilesStream = Pin<Box<dyn Stream<Item = Result<FileEvent, Status>> + Send>>;

    async fn watch_files(
        &self,
        request: Request<WatchFilesRequest>,
    ) -> Result<Response<Self::WatchFilesStream>, Status> {
        let principal = self.authorize(&request, "WatchFiles").await?;
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
        let principal = self.authorize(&request, "CreateTerminal").await?;
        let request = request.into_inner();
        let guest = self.guest(&principal, &request.agent_id).await?;
        let creation_guard = self
            .provisional_terminal_leases
            .lock_new_creation(&request.agent_id)
            .await?;
        if request.creation_id.is_empty() {
            let creation_id = compatible_terminal_creation_id("");
            let existing_sessions = guest.list_terminals().await.map_err(map_guest_error)?;
            let creation_record = self
                .provisional_terminal_leases
                .begin_creation(
                    &request.agent_id,
                    &creation_id,
                    &request.cwd,
                    &existing_sessions,
                    LEGACY_TERMINAL_TICKET_TIMEOUT,
                )
                .await?;
            let create_guest = guest.clone();
            let provisional_terminal_leases = self.provisional_terminal_leases.clone();
            let provisional_agent_id = request.agent_id.clone();
            let completion_creation_id = creation_id.clone();
            let cwd = request.cwd.clone();
            let columns = request.columns;
            let rows = request.rows;
            let failed_provisional_terminal_leases = provisional_terminal_leases.clone();
            let failed_agent_id = request.agent_id.clone();
            let failed_creation_id = creation_id.clone();
            let creation = detached_terminal_creation(
                async move {
                    create_guest
                        .create_terminal(&creation_id, &cwd, columns, rows)
                        .await
                },
                move |creation| async move {
                    if creation.created {
                        let terminal_id = creation.session.id.clone();
                        metrics::global().record_pty_created(&provisional_agent_id, &terminal_id);
                    }
                    provisional_terminal_leases
                        .record_terminal_id(
                            &provisional_agent_id,
                            &completion_creation_id,
                            creation_record,
                            &creation.session.id,
                            LEGACY_TERMINAL_TICKET_TIMEOUT,
                        )
                        .await?;
                    Ok(creation)
                },
                move |error| async move {
                    if terminal_creation_failure_is_definitive(&error) {
                        failed_provisional_terminal_leases
                            .clear_creation(&failed_agent_id, &failed_creation_id)
                            .await?;
                    } else {
                        failed_provisional_terminal_leases
                            .settle_ambiguous_creation(&failed_agent_id, &failed_creation_id)
                            .await?;
                    }
                    Err(map_guest_error(error))
                },
                creation_guard,
            )
            .await?;
            return Ok(Response::new(terminal_session(creation.session)));
        }

        let _creation_guard = creation_guard;
        let creation = guest
            .create_terminal(
                &request.creation_id,
                &request.cwd,
                request.columns,
                request.rows,
            )
            .await
            .map_err(map_guest_error)?;
        if creation.created {
            metrics::global().record_pty_created(&request.agent_id, &creation.session.id);
        }
        Ok(Response::new(terminal_session(creation.session)))
    }

    async fn list_terminals(
        &self,
        request: Request<ListTerminalsRequest>,
    ) -> Result<Response<ListTerminalsResponse>, Status> {
        let principal = self.authorize(&request, "ListTerminals").await?;
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
        let principal = self.authorize(&request, "TerminateTerminal").await?;
        let request = request.into_inner();
        let guest = self.guest(&principal, &request.agent_id).await?;
        match guest.terminate_terminal(&request.terminal_id).await {
            Ok(()) => {}
            Err(error) if terminal_is_absent(&error) => {}
            Err(error) => return Err(map_guest_error(error)),
        }
        self.provisional_terminal_leases
            .clear(&request.agent_id, &request.terminal_id)
            .await?;
        metrics::global().record_pty_terminated(&request.agent_id, &request.terminal_id);
        Ok(Response::new(Empty {}))
    }

    async fn issue_terminal_ticket(
        &self,
        request: Request<IssueTerminalTicketRequest>,
    ) -> Result<Response<TerminalTicket>, Status> {
        let principal = self.authorize(&request, "IssueTerminalTicket").await?;
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
        let Some(terminal) = terminals
            .iter()
            .find(|terminal| terminal.id == request.terminal_id)
        else {
            return Err(Status::not_found("terminal session was not found"));
        };
        let issued = self
            .provisional_terminal_leases
            .issue_and_confirm(
                &request.agent_id,
                &request.terminal_id,
                &terminal.creation_id,
                || {
                    self.tickets.issue_terminal(
                        &principal.owner_hash,
                        &request.agent_id,
                        &request.terminal_id,
                    )
                },
            )
            .await?;
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
        let principal = self.authorize(&request, "GetCodexAccount").await?;
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
        let principal = self.authorize(&request, "StartCodexLogin").await?;
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
            // App-server does not publish a device-code expiry, so Tengri bounds the UI attempt.
            expires_at: codex_login_expires_at(Utc::now()),
            raw_json: value.to_string(),
        }))
    }

    async fn create_codex_thread(
        &self,
        request: Request<CreateCodexThreadRequest>,
    ) -> Result<Response<CodexThread>, Status> {
        let principal = self.authorize(&request, "CreateCodexThread").await?;
        let request = request.into_inner();
        let snapshot = self
            .guest(&principal, &request.agent_id)
            .await?
            .codex_call_with_sequence(
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
        let value = snapshot.result;
        Ok(Response::new(CodexThread {
            id: json_string(&value, &["/thread/id"]),
            raw_json: value.to_string(),
            event_sequence: snapshot.event_sequence,
        }))
    }

    async fn resume_codex_thread(
        &self,
        request: Request<ResumeCodexThreadRequest>,
    ) -> Result<Response<CodexThread>, Status> {
        let principal = self.authorize(&request, "ResumeCodexThread").await?;
        let request = request.into_inner();
        validate_codex_id(&request.thread_id)?;
        let snapshot = self
            .guest(&principal, &request.agent_id)
            .await?
            .codex_call_with_sequence(
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
        let value = snapshot.result;
        Ok(Response::new(CodexThread {
            id: json_string(&value, &["/thread/id"]),
            raw_json: value.to_string(),
            event_sequence: snapshot.event_sequence,
        }))
    }

    async fn send_codex_turn(
        &self,
        request: Request<SendCodexTurnRequest>,
    ) -> Result<Response<CodexTurn>, Status> {
        let principal = self.authorize(&request, "SendCodexTurn").await?;
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
        let principal = self.authorize(&request, "SteerCodexTurn").await?;
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
        let principal = self.authorize(&request, "InterruptCodexTurn").await?;
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
        let principal = self.authorize(&request, "ResolveCodexApproval").await?;
        let request = request.into_inner();
        validate_codex_id(&request.approval_id)?;
        let decision = match CodexApprovalDecision::try_from(request.decision)
            .unwrap_or(CodexApprovalDecision::Unspecified)
        {
            CodexApprovalDecision::ApproveOnce => "approveOnce",
            CodexApprovalDecision::ApproveSession => "approveSession",
            CodexApprovalDecision::ApproveExecPolicyAmendment => "approveExecPolicyAmendment",
            CodexApprovalDecision::ApproveNetworkPolicyAmendment => "approveNetworkPolicyAmendment",
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
        let principal = self.authorize(&request, "WatchCodexEvents").await?;
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
        let principal = self.authorize(&request, "IssuePreviewSession").await?;
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
        let fragment = validate_preview_fragment(&request.fragment)?;
        self.guest(&principal, &request.agent_id).await?;
        let issued = self.tickets.issue_preview(
            &principal.owner_hash,
            &request.agent_id,
            port,
            &path,
            &fragment,
        )?;
        metrics::global().record_preview_session();
        let preview_origin = self.preview_origin.origin(&issued.id);
        Ok(Response::new(PreviewSession {
            id: issued.id,
            launch_url: issued.url,
            expires_at: issued.expires_at,
            preview_origin,
        }))
    }

    async fn revoke_preview_session(
        &self,
        request: Request<RevokePreviewSessionRequest>,
    ) -> Result<Response<Empty>, Status> {
        let principal = self.authorize(&request, "RevokePreviewSession").await?;
        let request = request.into_inner();
        validate_preview_session_id(&request.session_id)?;
        self.owned_agent(&principal, &request.agent_id).await?;
        self.tickets.revoke_preview(
            &principal.owner_hash,
            &request.agent_id,
            &request.session_id,
        )?;
        Ok(Response::new(Empty {}))
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
        last_activity_at: last_activity_at(microvm)
            .unwrap_or_else(|| microvm.spec.created_at.clone()),
        idle_deadline: effective_idle_deadline(microvm)
            .unwrap_or_else(|| microvm.spec.idle_deadline.clone()),
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
        creation_id: session.creation_id,
        cwd: session.cwd,
        created_at: session.created_at,
        last_activity_at: session.last_activity_at,
        attached: session.attached,
    }
}

fn codex_event(event: crate::guest::CodexEvent) -> CodexEvent {
    let method = event.method.clone();
    let raw_json = bounded_codex_raw_json(&event);
    CodexEvent {
        sequence: event.sequence,
        kind: codex_event_kind(&method, &event.approval_id, &event.raw) as i32,
        method,
        thread_id: json_string(
            &event.raw,
            &[
                "/params/threadId",
                "/params/thread/id",
                "/params/conversationId",
            ],
        ),
        turn_id: json_string(&event.raw, &["/params/turnId", "/params/turn/id"]),
        item_id: json_string(&event.raw, &["/params/itemId", "/params/item/id"]),
        text: codex_event_text(&event.raw),
        approval_id: event.approval_id,
        raw_json,
    }
}

fn bounded_codex_raw_json(event: &crate::guest::CodexEvent) -> String {
    let raw_json = event.raw.to_string();
    if raw_json.len() <= MAX_CODEX_EVENT_TEXT_BYTES {
        return raw_json;
    }

    let bounded = match event
        .raw
        .pointer("/params/availableDecisions")
        .filter(|_| !event.approval_id.is_empty())
    {
        Some(available_decisions) => json!({
            "params": {
                "availableDecisions": bounded_approval_decisions(available_decisions),
            },
            "rawOmitted": true,
        }),
        None => json!({"rawOmitted": true}),
    }
    .to_string();

    debug_assert!(bounded.len() <= MAX_CODEX_EVENT_TEXT_BYTES);
    bounded
}

fn bounded_approval_decisions(value: &Value) -> Value {
    let Some(decisions) = value.as_array() else {
        return Value::Null;
    };
    let mut bounded = Vec::new();
    for decision in decisions.iter().take(16) {
        let canonical = match decision.as_str() {
            Some(value @ ("accept" | "acceptForSession" | "decline" | "cancel")) => {
                Some(Value::String(value.to_owned()))
            }
            _ if decision
                .pointer("/acceptWithExecpolicyAmendment/execpolicy_amendment")
                .is_some() =>
            {
                Some(json!({
                    "acceptWithExecpolicyAmendment": {"execpolicy_amendment": true},
                }))
            }
            _ if decision
                .pointer("/applyNetworkPolicyAmendment/network_policy_amendment")
                .is_some() =>
            {
                Some(json!({
                    "applyNetworkPolicyAmendment": {"network_policy_amendment": true},
                }))
            }
            _ => None,
        };
        if let Some(canonical) = canonical
            && !bounded.contains(&canonical)
        {
            bounded.push(canonical);
        }
    }
    Value::Array(bounded)
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
    } else if normalized_method == "tengri/eventomitted" {
        CodexEventKind::Warning
    } else if codex_event_is_failure(&normalized_method, raw)
        || normalized_method == "error"
        || normalized_method.contains("error")
    {
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

fn codex_event_is_failure(normalized_method: &str, raw: &Value) -> bool {
    if normalized_method == "turn/completed" {
        return matches!(
            raw.pointer("/params/turn/status").and_then(Value::as_str),
            Some("failed")
        ) || raw
            .pointer("/params/turn/error")
            .is_some_and(|error| !error.is_null());
    }
    normalized_method == "account/login/completed"
        && (raw.pointer("/params/success").and_then(Value::as_bool) == Some(false)
            || raw
                .pointer("/params/error")
                .is_some_and(|error| !error.is_null()))
}

fn codex_login_expires_at(now: DateTime<Utc>) -> String {
    (now + chrono::Duration::minutes(CODEX_LOGIN_ATTEMPT_TTL_MINUTES)).to_rfc3339()
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
    if let Some(outcome) = codex_command_outcome(value) {
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
            "/params/error",
            "/params/error/message",
            "/params/turn/error/message",
        ],
    );
    if !direct.is_empty() {
        return direct;
    }
    for pointer in ["/params/item/summary", "/params/item/content"] {
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
    for pointer in [
        "/params/item/result/structuredContent",
        "/params/item/result/structured_content",
    ] {
        if let Some(structured) = value
            .pointer(pointer)
            .filter(|structured| !structured.is_null())
            && let Ok(text) = serde_json::to_string_pretty(structured)
        {
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

fn codex_command_outcome(value: &Value) -> Option<String> {
    let item = value.pointer("/params/item")?;
    if item.get("type").and_then(Value::as_str) != Some("commandExecution") {
        return None;
    }
    if item
        .get("aggregatedOutput")
        .and_then(Value::as_str)
        .is_some_and(|output| !output.is_empty())
    {
        return None;
    }

    let status = item.get("status").and_then(Value::as_str)?;
    let label = match status {
        "completed" => "Command completed",
        "failed" => "Command failed",
        "declined" => "Command declined",
        _ => return None,
    };
    Some(match item.get("exitCode").and_then(Value::as_i64) {
        Some(exit_code) => format!("{label} (exit {exit_code})"),
        None => label.to_owned(),
    })
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

fn compatible_terminal_creation_id(value: &str) -> String {
    if !value.is_empty() {
        return value.to_owned();
    }
    format!(
        "{LEGACY_TERMINAL_CREATION_PREFIX}{}",
        Uuid::new_v4().simple()
    )
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvisionalTerminalCreationRecord {
    expires_at: String,
    cwd: String,
    existing_session_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal_id: Option<String>,
}

fn provisional_terminal_cleanup_id(
    sessions: &[crate::guest::TerminalSession],
    creation_id: &str,
    record: &ProvisionalTerminalCreationRecord,
) -> Result<Option<String>, usize> {
    if let Some(session) = sessions
        .iter()
        .find(|session| session.creation_id == creation_id)
    {
        return Ok(Some(session.id.clone()));
    }
    if let Some(terminal_id) = &record.terminal_id {
        return Ok(sessions
            .iter()
            .any(|session| session.id == *terminal_id)
            .then(|| terminal_id.clone()));
    }

    let candidates = sessions
        .iter()
        .filter(|session| {
            session.creation_id.is_empty()
                && session.cwd == record.cwd
                && !record.existing_session_ids.contains(&session.id)
        })
        .map(|session| session.id.clone())
        .collect::<Vec<_>>();
    match candidates.as_slice() {
        [] => Ok(None),
        [terminal_id] => Ok(Some(terminal_id.clone())),
        _ => Err(candidates.len()),
    }
}

#[derive(Clone)]
struct ProvisionalTerminalLeaseManager {
    client: Client,
    namespace: Arc<str>,
    terminal_identities: TerminalIdentityRegistry,
    registry: ProvisionalTerminalLeaseRegistry,
    creation_intents: ProvisionalTerminalLeaseRegistry,
    recovered_creation_intents: Arc<Mutex<HashSet<(String, String)>>>,
    creation_locks: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
}

impl ProvisionalTerminalLeaseManager {
    fn new(
        client: Client,
        namespace: Arc<str>,
        terminal_identities: TerminalIdentityRegistry,
    ) -> Self {
        Self {
            client,
            namespace,
            terminal_identities,
            registry: ProvisionalTerminalLeaseRegistry::default(),
            creation_intents: ProvisionalTerminalLeaseRegistry::default(),
            recovered_creation_intents: Arc::new(Mutex::new(HashSet::new())),
            creation_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn lock_creation(&self, agent_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.creation_locks.lock().await;
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(agent_id).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(Mutex::new(()));
                locks.insert(agent_id.to_owned(), Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }

    async fn lock_new_creation(
        &self,
        agent_id: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, Status> {
        let guard = self.lock_creation(agent_id).await;
        if self
            .recovered_creation_intents
            .lock()
            .await
            .iter()
            .any(|(tracked_agent_id, _)| tracked_agent_id == agent_id)
        {
            return Err(Status::failed_precondition(
                "a previous terminal creation is still reconciling; retry shortly",
            ));
        }
        Ok(guard)
    }

    async fn begin_creation(
        &self,
        agent_id: &str,
        creation_id: &str,
        cwd: &str,
        existing_sessions: &[crate::guest::TerminalSession],
        timeout: Duration,
    ) -> Result<ProvisionalTerminalCreationRecord, Status> {
        let expires_at = Utc::now()
            + chrono::Duration::from_std(timeout)
                .map_err(|_| Status::internal("terminal lease duration is invalid"))?;
        let mut existing_session_ids = existing_sessions
            .iter()
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        existing_session_ids.sort();
        existing_session_ids.dedup();
        let record = ProvisionalTerminalCreationRecord {
            expires_at: expires_at.to_rfc3339(),
            cwd: if cwd.trim().is_empty() { "/" } else { cwd }.to_owned(),
            existing_session_ids,
            terminal_id: None,
        };
        let serialized = serde_json::to_string(&record).map_err(|error| {
            Status::internal(format!(
                "failed to encode terminal creation intent: {error}"
            ))
        })?;
        let manager = self.clone();
        let persisted_agent_id = agent_id.to_owned();
        let persisted_creation_id = creation_id.to_owned();
        let persisted_record = record.clone();
        let (result_sender, result_receiver) = oneshot::channel();
        tokio::spawn(async move {
            let persistence = manager
                .patch_creation_annotation(
                    &persisted_agent_id,
                    &persisted_creation_id,
                    Some(&serialized),
                )
                .await;
            manager
                .schedule_creation(
                    &persisted_agent_id,
                    &persisted_creation_id,
                    timeout,
                    persisted_record.clone(),
                    persistence.is_ok(),
                )
                .await;
            let result = persistence
                .map(|()| persisted_record)
                .map_err(map_kube_error);
            let _ = result_sender.send(result);
        });

        result_receiver
            .await
            .map_err(|_| Status::internal("terminal creation intent task ended without a result"))?
    }

    async fn record_terminal_id(
        &self,
        agent_id: &str,
        creation_id: &str,
        mut record: ProvisionalTerminalCreationRecord,
        terminal_id: &str,
        timeout: Duration,
    ) -> Result<(), Status> {
        record.expires_at = (Utc::now()
            + chrono::Duration::from_std(timeout)
                .map_err(|_| Status::internal("terminal lease duration is invalid"))?)
        .to_rfc3339();
        record.terminal_id = Some(terminal_id.to_owned());
        let serialized = serde_json::to_string(&record).map_err(|error| {
            Status::internal(format!(
                "failed to encode terminal creation intent: {error}"
            ))
        })?;
        let manager = self.clone();
        let key_agent_id = agent_id.to_owned();
        let key_creation_id = creation_id.to_owned();
        let patch_agent_id = key_agent_id.clone();
        let patch_creation_id = key_creation_id.clone();
        self.creation_intents
            .settle_creation(&key_agent_id, &key_creation_id, move || async move {
                manager
                    .patch_creation_annotation(
                        &patch_agent_id,
                        &patch_creation_id,
                        Some(&serialized),
                    )
                    .await
                    .map_err(map_kube_error)
            })
            .await
    }

    async fn recover(&self) -> Result<(), kube::Error> {
        let agents: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        let now = Utc::now();
        for agent in agents.list(&ListParams::default()).await?.items {
            for lease in recoverable_provisional_terminal_leases(&agent, now) {
                self.schedule(&lease.agent_id, &lease.terminal_id, lease.delay)
                    .await;
            }
            for intent in recoverable_provisional_terminal_creation_intents(&agent, now) {
                self.recovered_creation_intents
                    .lock()
                    .await
                    .insert((intent.agent_id.clone(), intent.creation_id.clone()));
                self.terminal_identities.restore_legacy_creation(
                    &intent.agent_id,
                    &intent.creation_id,
                    &intent.record.cwd,
                    &intent.record.existing_session_ids,
                    intent.record.terminal_id.as_deref(),
                );
                self.schedule_creation(
                    &intent.agent_id,
                    &intent.creation_id,
                    intent.delay,
                    intent.record,
                    false,
                )
                .await;
            }
        }
        Ok(())
    }

    async fn settle_ambiguous_creation(
        &self,
        agent_id: &str,
        creation_id: &str,
    ) -> Result<(), Status> {
        self.creation_intents
            .settle_creation(agent_id, creation_id, || async { Ok(()) })
            .await
    }

    async fn schedule(&self, agent_id: &str, terminal_id: &str, timeout: Duration) {
        let cleanup = self.clone();
        let cleanup_agent_id = agent_id.to_owned();
        self.registry
            .register(
                agent_id,
                terminal_id,
                timeout,
                PROVISIONAL_TERMINAL_CLEANUP_RETRY,
                move |terminal_id| {
                    let cleanup = cleanup.clone();
                    let agent_id = cleanup_agent_id.clone();
                    async move { cleanup.cleanup_once(&agent_id, &terminal_id).await }
                },
            )
            .await;
    }

    async fn schedule_creation(
        &self,
        agent_id: &str,
        creation_id: &str,
        timeout: Duration,
        record: ProvisionalTerminalCreationRecord,
        creating: bool,
    ) {
        let cleanup = self.clone();
        let cleanup_agent_id = agent_id.to_owned();
        let cleanup_record = record.clone();
        self.creation_intents
            .register_with_state(
                agent_id,
                creation_id,
                timeout,
                PROVISIONAL_TERMINAL_CLEANUP_RETRY,
                creating,
                move |creation_id| {
                    let cleanup = cleanup.clone();
                    let agent_id = cleanup_agent_id.clone();
                    let record = cleanup_record.clone();
                    async move {
                        cleanup
                            .cleanup_creation_once(&agent_id, &creation_id, &record)
                            .await
                    }
                },
            )
            .await;
    }

    async fn cleanup_once(&self, agent_id: &str, terminal_id: &str) -> bool {
        let guest = match GuestClient::for_agent_with_terminal_identities(
            self.client.clone(),
            &self.namespace,
            agent_id,
            self.terminal_identities.clone(),
        )
        .await
        {
            Ok(guest) => Some(guest),
            Err(error) if agent_is_absent(&error) => None,
            Err(error) => {
                tracing::warn!(
                    agent_id,
                    terminal_id,
                    %error,
                    "failed to connect to the guest while cleaning up an unconfirmed terminal"
                );
                return false;
            }
        };

        if let Some(guest) = guest {
            match guest.terminate_terminal(terminal_id).await {
                Ok(()) => {}
                Err(error) if terminal_is_absent(&error) => {}
                Err(error) => {
                    tracing::warn!(
                        agent_id,
                        terminal_id,
                        %error,
                        "failed to clean up an unconfirmed terminal; retrying"
                    );
                    return false;
                }
            }
        }

        match self.patch_annotation(agent_id, terminal_id, None).await {
            Ok(()) => {
                metrics::global().record_pty_terminated(agent_id, terminal_id);
                true
            }
            Err(error) if kube_resource_is_absent(&error) => true,
            Err(error) => {
                tracing::warn!(
                    agent_id,
                    terminal_id,
                    %error,
                    "failed to clear a provisional terminal lease; retrying"
                );
                false
            }
        }
    }

    async fn cleanup_creation_once(
        &self,
        agent_id: &str,
        creation_id: &str,
        record: &ProvisionalTerminalCreationRecord,
    ) -> bool {
        let _creation_guard = self.lock_creation(agent_id).await;
        let guest = match GuestClient::for_agent_with_terminal_identities(
            self.client.clone(),
            &self.namespace,
            agent_id,
            self.terminal_identities.clone(),
        )
        .await
        {
            Ok(guest) => Some(guest),
            Err(error) if agent_is_absent(&error) => None,
            Err(error) => {
                tracing::warn!(
                    agent_id,
                    creation_id,
                    %error,
                    "failed to connect to the guest while cleaning up a provisional terminal creation"
                );
                return false;
            }
        };

        if let Some(guest) = guest {
            let sessions = match guest.list_terminals().await {
                Ok(sessions) => sessions,
                Err(error) => {
                    tracing::warn!(
                        agent_id,
                        creation_id,
                        %error,
                        "failed to list terminals while cleaning up a provisional terminal creation"
                    );
                    return false;
                }
            };
            let terminal_id = match provisional_terminal_cleanup_id(&sessions, creation_id, record)
            {
                Ok(terminal_id) => terminal_id,
                Err(candidate_count) => {
                    tracing::warn!(
                        agent_id,
                        creation_id,
                        candidate_count,
                        "provisional terminal creation matches multiple legacy sessions; retrying"
                    );
                    return false;
                }
            };
            if let Some(terminal_id) = terminal_id {
                match guest.terminate_terminal(&terminal_id).await {
                    Ok(()) => metrics::global().record_pty_terminated(agent_id, &terminal_id),
                    Err(error) if terminal_is_absent(&error) => {}
                    Err(error) => {
                        tracing::warn!(
                            agent_id,
                            creation_id,
                            terminal_id,
                            %error,
                            "failed to clean up a provisional terminal creation; retrying"
                        );
                        return false;
                    }
                }
            }
        }

        let cleared = match self
            .patch_creation_annotation(agent_id, creation_id, None)
            .await
        {
            Ok(()) => true,
            Err(error) if kube_resource_is_absent(&error) => true,
            Err(error) => {
                tracing::warn!(
                    agent_id,
                    creation_id,
                    %error,
                    "failed to clear a provisional terminal creation; retrying"
                );
                false
            }
        };
        if cleared {
            self.terminal_identities
                .remove_creation(agent_id, creation_id);
            self.recovered_creation_intents
                .lock()
                .await
                .remove(&(agent_id.to_owned(), creation_id.to_owned()));
        }
        cleared
    }

    async fn issue_and_confirm<T, I>(
        &self,
        agent_id: &str,
        terminal_id: &str,
        creation_id: &str,
        issue: I,
    ) -> Result<T, Status>
    where
        I: FnOnce() -> Result<T, Status>,
    {
        if provisional_terminal_creation_annotation_key(creation_id).is_some() {
            let manager = self.clone();
            let confirmation_agent_id = agent_id.to_owned();
            let confirmation_creation_id = creation_id.to_owned();
            let confirmed = self
                .creation_intents
                .issue_and_confirm(agent_id, creation_id, move |tracked| async move {
                    let issued = issue()?;
                    if tracked {
                        manager
                            .patch_creation_annotation(
                                &confirmation_agent_id,
                                &confirmation_creation_id,
                                None,
                            )
                            .await
                            .map_err(map_kube_error)?;
                    }
                    Ok(issued)
                })
                .await?;
            self.recovered_creation_intents
                .lock()
                .await
                .remove(&(agent_id.to_owned(), creation_id.to_owned()));
            return Ok(confirmed);
        }

        let manager = self.clone();
        let confirmation_agent_id = agent_id.to_owned();
        let confirmation_terminal_id = terminal_id.to_owned();
        self.registry
            .issue_and_confirm(agent_id, terminal_id, move |tracked| async move {
                let issued = issue()?;
                if tracked {
                    manager
                        .patch_annotation(&confirmation_agent_id, &confirmation_terminal_id, None)
                        .await
                        .map_err(map_kube_error)?;
                }
                Ok(issued)
            })
            .await
    }

    async fn clear(&self, agent_id: &str, terminal_id: &str) -> Result<(), Status> {
        if self.registry.clear(agent_id, terminal_id).await {
            self.patch_annotation(agent_id, terminal_id, None)
                .await
                .map_err(map_kube_error)?;
        }
        Ok(())
    }

    async fn clear_creation(&self, agent_id: &str, creation_id: &str) -> Result<(), Status> {
        let manager = self.clone();
        let clear_agent_id = agent_id.to_owned();
        let clear_creation_id = creation_id.to_owned();
        self.creation_intents
            .clear_tracked(
                agent_id,
                creation_id,
                PROVISIONAL_TERMINAL_CLEANUP_RETRY,
                move |tracked| {
                    let manager = manager.clone();
                    let clear_agent_id = clear_agent_id.clone();
                    let clear_creation_id = clear_creation_id.clone();
                    async move {
                        if tracked {
                            match manager
                                .patch_creation_annotation(
                                    &clear_agent_id,
                                    &clear_creation_id,
                                    None,
                                )
                                .await
                            {
                                Ok(()) => {}
                                Err(error) if kube_resource_is_absent(&error) => {}
                                Err(error) => return Err(map_kube_error(error)),
                            }
                            manager
                                .terminal_identities
                                .remove_creation(&clear_agent_id, &clear_creation_id);
                        }
                        Ok(())
                    }
                },
            )
            .await?;
        self.recovered_creation_intents
            .lock()
            .await
            .remove(&(agent_id.to_owned(), creation_id.to_owned()));
        Ok(())
    }

    async fn patch_annotation(
        &self,
        agent_id: &str,
        terminal_id: &str,
        value: Option<&str>,
    ) -> Result<(), kube::Error> {
        self.patch_annotations_for_agent(
            agent_id,
            vec![(
                provisional_terminal_annotation_key(terminal_id),
                value.map(str::to_owned),
            )],
        )
        .await
    }

    async fn patch_creation_annotation(
        &self,
        agent_id: &str,
        creation_id: &str,
        value: Option<&str>,
    ) -> Result<(), kube::Error> {
        let key = provisional_terminal_creation_annotation_key(creation_id)
            .expect("generated legacy creation IDs must have valid annotation keys");
        self.patch_annotations_for_agent(agent_id, vec![(key, value.map(str::to_owned))])
            .await
    }

    async fn patch_annotations_for_agent(
        &self,
        agent_id: &str,
        updates: Vec<(String, Option<String>)>,
    ) -> Result<(), kube::Error> {
        let annotations = updates
            .into_iter()
            .map(|(key, value)| (key, value.map_or(Value::Null, Value::String)))
            .collect::<serde_json::Map<_, _>>();
        let patch = json!({"metadata": {"annotations": annotations}});
        let agents: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        agents
            .patch(agent_id, &PatchParams::default(), &Patch::Merge(&patch))
            .await?;
        Ok(())
    }
}

#[derive(Debug, Eq, PartialEq)]
struct RecoverableProvisionalTerminalLease {
    agent_id: String,
    terminal_id: String,
    delay: Duration,
}

fn recoverable_provisional_terminal_leases(
    agent: &MicroVM,
    now: DateTime<Utc>,
) -> Vec<RecoverableProvisionalTerminalLease> {
    let agent_id = agent.name_any();
    agent
        .metadata
        .annotations
        .iter()
        .flat_map(|annotations| annotations.iter())
        .filter_map(|(key, value)| {
            if key.starts_with(PROVISIONAL_TERMINAL_CREATION_ANNOTATION_PREFIX) {
                return None;
            }
            let terminal_id = key.strip_prefix(PROVISIONAL_TERMINAL_ANNOTATION_PREFIX)?;
            if terminal_id.is_empty()
                || terminal_id.len() > 128
                || !terminal_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                tracing::warn!(
                    agent_id,
                    annotation = key,
                    "ignoring an invalid provisional terminal lease"
                );
                return None;
            }
            let expires_at = DateTime::parse_from_rfc3339(value)
                .map(|value| value.with_timezone(&Utc))
                .unwrap_or(now);
            let delay = (expires_at - now).to_std().unwrap_or(Duration::ZERO);
            Some(RecoverableProvisionalTerminalLease {
                agent_id: agent_id.clone(),
                terminal_id: terminal_id.to_owned(),
                delay,
            })
        })
        .collect()
}

#[derive(Debug, Eq, PartialEq)]
struct RecoverableProvisionalTerminalCreationIntent {
    agent_id: String,
    creation_id: String,
    delay: Duration,
    record: ProvisionalTerminalCreationRecord,
}

fn recoverable_provisional_terminal_creation_intents(
    agent: &MicroVM,
    now: DateTime<Utc>,
) -> Vec<RecoverableProvisionalTerminalCreationIntent> {
    let agent_id = agent.name_any();
    agent
        .metadata
        .annotations
        .iter()
        .flat_map(|annotations| annotations.iter())
        .filter_map(|(key, value)| {
            let suffix = key.strip_prefix(PROVISIONAL_TERMINAL_CREATION_ANNOTATION_PREFIX)?;
            if suffix.len() != 32
                || !suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            {
                tracing::warn!(
                    agent_id,
                    annotation = key,
                    "ignoring an invalid provisional terminal creation"
                );
                return None;
            }
            let record = match serde_json::from_str::<ProvisionalTerminalCreationRecord>(value) {
                Ok(record) => record,
                Err(error) => {
                    tracing::warn!(
                        agent_id,
                        annotation = key,
                        %error,
                        "ignoring an invalid provisional terminal creation record"
                    );
                    return None;
                }
            };
            let expires_at = DateTime::parse_from_rfc3339(&record.expires_at)
                .map(|value| value.with_timezone(&Utc))
                .unwrap_or(now);
            let delay = (expires_at - now).to_std().unwrap_or(Duration::ZERO);
            Some(RecoverableProvisionalTerminalCreationIntent {
                agent_id: agent_id.clone(),
                creation_id: format!("{LEGACY_TERMINAL_CREATION_PREFIX}{suffix}"),
                delay,
                record,
            })
        })
        .collect()
}

fn provisional_terminal_annotation_key(terminal_id: &str) -> String {
    format!("{PROVISIONAL_TERMINAL_ANNOTATION_PREFIX}{terminal_id}")
}

fn provisional_terminal_creation_annotation_key(creation_id: &str) -> Option<String> {
    let suffix = creation_id.strip_prefix(LEGACY_TERMINAL_CREATION_PREFIX)?;
    if suffix.len() != 32
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return None;
    }
    Some(format!(
        "{PROVISIONAL_TERMINAL_CREATION_ANNOTATION_PREFIX}{suffix}"
    ))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProvisionalTerminalLease {
    Creating(Uuid),
    AwaitingTicket(Uuid),
    Expiring(Uuid),
    Clearing(Uuid),
}

#[derive(Clone, Default)]
struct ProvisionalTerminalLeaseRegistry {
    leases: Arc<Mutex<HashMap<(String, String), ProvisionalTerminalLease>>>,
}

impl ProvisionalTerminalLeaseRegistry {
    async fn register<C, CF>(
        &self,
        agent_id: &str,
        terminal_id: &str,
        timeout: Duration,
        retry_delay: Duration,
        cleanup: C,
    ) where
        C: FnMut(String) -> CF + Send + 'static,
        CF: Future<Output = bool> + Send + 'static,
    {
        self.register_with_state(agent_id, terminal_id, timeout, retry_delay, false, cleanup)
            .await;
    }

    async fn register_with_state<C, CF>(
        &self,
        agent_id: &str,
        terminal_id: &str,
        timeout: Duration,
        retry_delay: Duration,
        creating: bool,
        mut cleanup: C,
    ) where
        C: FnMut(String) -> CF + Send + 'static,
        CF: Future<Output = bool> + Send + 'static,
    {
        let key = (agent_id.to_owned(), terminal_id.to_owned());
        let token = Uuid::new_v4();
        let state = if creating {
            ProvisionalTerminalLease::Creating(token)
        } else {
            ProvisionalTerminalLease::AwaitingTicket(token)
        };
        self.leases.lock().await.insert(key.clone(), state);

        let registry = self.clone();
        let cleanup_terminal_id = terminal_id.to_owned();
        tokio::spawn(async move {
            if creating {
                loop {
                    let creation_settled = {
                        let leases = registry.leases.lock().await;
                        match leases.get(&key).copied() {
                            Some(ProvisionalTerminalLease::Creating(current))
                                if current == token =>
                            {
                                false
                            }
                            Some(ProvisionalTerminalLease::AwaitingTicket(current))
                                if current == token =>
                            {
                                true
                            }
                            _ => return,
                        }
                    };
                    if creation_settled {
                        break;
                    }
                    sleep(retry_delay).await;
                }
            }
            sleep(timeout).await;
            {
                let mut leases = registry.leases.lock().await;
                match leases.get(&key).copied() {
                    Some(ProvisionalTerminalLease::AwaitingTicket(current)) if current == token => {
                        leases.insert(key.clone(), ProvisionalTerminalLease::Expiring(token));
                    }
                    _ => return,
                }
            }

            loop {
                if cleanup(cleanup_terminal_id.clone()).await {
                    let mut leases = registry.leases.lock().await;
                    if matches!(
                        leases.get(&key),
                        Some(ProvisionalTerminalLease::Expiring(current)) if *current == token
                    ) {
                        leases.remove(&key);
                    }
                    return;
                }
                sleep(retry_delay).await;
                let leases = registry.leases.lock().await;
                if !matches!(
                    leases.get(&key),
                    Some(ProvisionalTerminalLease::Expiring(current)) if *current == token
                ) {
                    return;
                }
            }
        });
    }

    async fn settle_creation<I, IF>(
        &self,
        agent_id: &str,
        terminal_id: &str,
        action: I,
    ) -> Result<(), Status>
    where
        I: FnOnce() -> IF,
        IF: Future<Output = Result<(), Status>>,
    {
        let key = (agent_id.to_owned(), terminal_id.to_owned());
        let mut leases = self.leases.lock().await;
        match leases.get(&key).copied() {
            Some(ProvisionalTerminalLease::Creating(token)) => {
                let result = action().await;
                leases.insert(key, ProvisionalTerminalLease::AwaitingTicket(token));
                result
            }
            Some(ProvisionalTerminalLease::AwaitingTicket(_)) => action().await,
            Some(ProvisionalTerminalLease::Expiring(_)) => Err(Status::not_found(
                "terminal session expired before creation completed",
            )),
            Some(ProvisionalTerminalLease::Clearing(_)) => Err(Status::not_found(
                "terminal creation is being cleared after a definitive failure",
            )),
            None => Ok(()),
        }
    }

    async fn issue_and_confirm<T, I, IF>(
        &self,
        agent_id: &str,
        terminal_id: &str,
        issue: I,
    ) -> Result<T, Status>
    where
        I: FnOnce(bool) -> IF,
        IF: Future<Output = Result<T, Status>>,
    {
        let key = (agent_id.to_owned(), terminal_id.to_owned());
        let mut leases = self.leases.lock().await;
        match leases.get(&key) {
            Some(ProvisionalTerminalLease::Creating(_)) => {
                return Err(Status::failed_precondition(
                    "terminal creation has not completed",
                ));
            }
            Some(ProvisionalTerminalLease::Expiring(_)) => {
                return Err(Status::not_found(
                    "terminal session expired before ticket issuance",
                ));
            }
            Some(ProvisionalTerminalLease::Clearing(_)) => {
                return Err(Status::not_found(
                    "terminal creation failed before ticket issuance",
                ));
            }
            _ => {}
        }
        let tracked = leases.contains_key(&key);
        let issued = issue(tracked).await?;
        leases.remove(&key);
        Ok(issued)
    }

    async fn clear_tracked<I, IF>(
        &self,
        agent_id: &str,
        terminal_id: &str,
        retry_delay: Duration,
        mut action: I,
    ) -> Result<(), Status>
    where
        I: FnMut(bool) -> IF,
        IF: Future<Output = Result<(), Status>>,
    {
        let key = (agent_id.to_owned(), terminal_id.to_owned());
        let token = {
            let mut leases = self.leases.lock().await;
            let token = match leases.get(&key).copied() {
                Some(ProvisionalTerminalLease::Creating(token))
                | Some(ProvisionalTerminalLease::AwaitingTicket(token))
                | Some(ProvisionalTerminalLease::Expiring(token))
                | Some(ProvisionalTerminalLease::Clearing(token)) => Some(token),
                None => None,
            };
            if let Some(token) = token {
                leases.insert(key.clone(), ProvisionalTerminalLease::Clearing(token));
            }
            token
        };
        let Some(token) = token else {
            return action(false).await;
        };

        loop {
            match action(true).await {
                Ok(()) => {
                    let mut leases = self.leases.lock().await;
                    if matches!(
                        leases.get(&key),
                        Some(ProvisionalTerminalLease::Clearing(current)) if *current == token
                    ) {
                        leases.remove(&key);
                    }
                    return Ok(());
                }
                Err(error) => {
                    tracing::warn!(
                        agent_id,
                        terminal_id,
                        %error,
                        "failed to clear a definitive terminal creation failure; retrying"
                    );
                    sleep(retry_delay).await;
                }
            }
        }
    }

    async fn clear(&self, agent_id: &str, terminal_id: &str) -> bool {
        self.leases
            .lock()
            .await
            .remove(&(agent_id.to_owned(), terminal_id.to_owned()))
            .is_some()
    }
}

fn terminal_creation_failure_is_definitive(error: &GuestError) -> bool {
    matches!(error, GuestError::Api { .. })
}

async fn detached_terminal_creation<C, S, SF, F, FF, R>(
    creation: C,
    on_success: S,
    on_failure: F,
    retained_until_settled: R,
) -> Result<GuestTerminalCreation, Status>
where
    C: Future<Output = Result<GuestTerminalCreation, GuestError>> + Send + 'static,
    S: FnOnce(GuestTerminalCreation) -> SF + Send + 'static,
    SF: Future<Output = Result<GuestTerminalCreation, Status>> + Send + 'static,
    F: FnOnce(GuestError) -> FF + Send + 'static,
    FF: Future<Output = Result<GuestTerminalCreation, Status>> + Send + 'static,
    R: Send + 'static,
{
    let (result_sender, result_receiver) = oneshot::channel();
    tokio::spawn(async move {
        let result = match creation.await {
            Ok(creation) => on_success(creation).await,
            Err(error) => on_failure(error).await,
        };
        drop(retained_until_settled);
        let _ = result_sender.send(result);
    });

    match result_receiver.await {
        Ok(Ok(creation)) => Ok(creation),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(Status::internal(
            "terminal creation task ended without a result",
        )),
    }
}

fn validate_preview_session_id(value: &str) -> Result<(), Status> {
    if value.len() != 24
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return Err(Status::invalid_argument("invalid preview session id"));
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

fn validate_preview_fragment(value: &str) -> Result<String, Status> {
    if value.is_empty() {
        return Ok(String::new());
    }
    if !value.starts_with('#')
        || value.len() > 4_096
        || value
            .chars()
            .any(|character| character <= '\u{001f}' || character == '\u{007f}')
    {
        return Err(Status::invalid_argument(
            "preview fragment must start with #, contain no control characters, and be at most 4096 bytes",
        ));
    }
    Ok(value.to_owned())
}

fn validate_digest_pinned_image(image: &str) -> anyhow::Result<()> {
    let (repository, digest) = image
        .rsplit_once("@sha256:")
        .ok_or_else(|| anyhow::anyhow!("TENGRI_DEFAULT_IMAGE must be pinned by sha256 digest"))?;
    anyhow::ensure!(
        !repository.is_empty()
            && !repository
                .chars()
                .any(|character| character == '@' || character.is_whitespace()),
        "TENGRI_DEFAULT_IMAGE has an invalid image repository"
    );
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

fn is_conflict(error: &kube::Error) -> bool {
    matches!(error, kube::Error::Api(response) if response.code == 409)
}

fn kube_resource_is_absent(error: &kube::Error) -> bool {
    matches!(error, kube::Error::Api(response) if response.code == 404)
}

fn agent_is_absent(error: &GuestError) -> bool {
    matches!(error, GuestError::Kubernetes(error) if kube_resource_is_absent(error))
}

fn terminal_is_absent(error: &GuestError) -> bool {
    matches!(error, GuestError::Api { status, .. } if *status == reqwest::StatusCode::NOT_FOUND)
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
        GuestError::MissingCodexSnapshotCursor => Status::failed_precondition(
            "This agent cannot safely restore Codex threads; save the workspace, then delete and recreate the agent",
        ),
        other => Status::internal(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use crate::activity::LAST_ACTIVITY_ANNOTATION;
    use crate::auth::owner_hash;
    use crate::crd::MicroVMStatus;
    use http::{Response as HttpResponse, StatusCode as HttpStatusCode};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
    use kube::client::Body as KubeBody;

    #[test]
    fn missing_codex_snapshot_cursor_reports_the_destructive_recovery() {
        let status = map_guest_error(GuestError::MissingCodexSnapshotCursor);
        assert_eq!(status.code(), tonic::Code::FailedPrecondition);
        assert_eq!(
            status.message(),
            "This agent cannot safely restore Codex threads; save the workspace, then delete and recreate the agent"
        );
    }

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
    fn new_agents_are_marked_for_the_versioned_single_mount_layout() {
        let hash = owner_hash("github:42");
        let mut agent = provisional_terminal_test_agent(Utc::now());

        apply_new_agent_metadata(&mut agent, &hash, SINGLE_MOUNT_STORAGE_LAYOUT);

        assert_eq!(
            agent
                .metadata
                .labels
                .as_ref()
                .and_then(|labels| labels.get(OWNER_LABEL))
                .map(String::as_str),
            Some(&hash[..32]),
        );
        assert_eq!(
            agent
                .metadata
                .annotations
                .as_ref()
                .and_then(|annotations| annotations.get(STORAGE_LAYOUT_ANNOTATION))
                .map(String::as_str),
            Some(SINGLE_MOUNT_STORAGE_LAYOUT),
        );
    }

    #[test]
    fn default_image_must_be_digest_pinned() {
        assert!(validate_digest_pinned_image("registry.example/nanoagent:latest").is_err());
        assert!(validate_digest_pinned_image(&format!("@sha256:{}", "a".repeat(64))).is_err());
        assert!(
            validate_digest_pinned_image(&format!(
                "registry.example/nano agent@sha256:{}",
                "a".repeat(64)
            ))
            .is_err()
        );
        assert!(
            validate_digest_pinned_image(&format!(
                "registry.example/nanoagent@staging@sha256:{}",
                "a".repeat(64)
            ))
            .is_err()
        );
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
    fn waking_a_sleeping_agent_persists_the_resume_start_time() {
        let now = Utc::now();
        let mut agent = MicroVM::new(
            "agent-sleeping",
            MicroVMSpec {
                display_name: "Sleeping agent".to_owned(),
                owner_hash: "a".repeat(64),
                desired_state: MicroVMDesiredState::Sleeping,
                image: format!("registry.example/nanoagent@sha256:{}", "b".repeat(64)),
                architecture: MicroVMArchitecture::Amd64,
                resources: MicroVMResources::default(),
                created_at: (now - chrono::Duration::hours(1)).to_rfc3339(),
                idle_deadline: now.to_rfc3339(),
                expires_at: (now + chrono::Duration::hours(LIFETIME_HOURS)).to_rfc3339(),
            },
        );
        agent.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Sleeping,
            ..MicroVMStatus::default()
        });

        let patch = wake_patch(&agent, now);
        assert_eq!(
            patch["metadata"]["annotations"][RESUME_STARTED_AT_ANNOTATION],
            now.to_rfc3339()
        );
        assert_eq!(
            patch["spec"]["desiredState"],
            serde_json::json!(MicroVMDesiredState::Running)
        );
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
    fn agent_projection_reports_the_activity_extended_idle_deadline() {
        let now = Utc::now();
        let mut agent = MicroVM::new(
            "agent-active",
            MicroVMSpec {
                display_name: "Active agent".to_owned(),
                owner_hash: "a".repeat(64),
                desired_state: MicroVMDesiredState::Running,
                image: format!("registry.example/nanoagent@sha256:{}", "b".repeat(64)),
                architecture: MicroVMArchitecture::Amd64,
                resources: MicroVMResources::default(),
                created_at: (now - chrono::Duration::hours(1)).to_rfc3339(),
                idle_deadline: now.to_rfc3339(),
                expires_at: (now + chrono::Duration::hours(LIFETIME_HOURS)).to_rfc3339(),
            },
        );
        let activity_at = now + chrono::Duration::minutes(15);
        agent.metadata.annotations = Some(std::collections::BTreeMap::from([(
            LAST_ACTIVITY_ANNOTATION.to_owned(),
            activity_at.to_rfc3339(),
        )]));

        let projected = agent_from_microvm(&agent);
        assert_eq!(projected.last_activity_at, activity_at.to_rfc3339());
        assert_eq!(
            projected.idle_deadline,
            (activity_at + chrono::Duration::minutes(IDLE_MINUTES)).to_rfc3339(),
        );
    }

    #[test]
    fn lifecycle_conflicts_are_retried_instead_of_reported_as_existing_agents() {
        let conflict = kube::Error::Api(
            kube::core::Status {
                code: 409,
                reason: "Conflict".to_owned(),
                ..kube::core::Status::default()
            }
            .boxed(),
        );
        let already_exists = kube::Error::Api(
            kube::core::Status {
                code: 409,
                reason: "AlreadyExists".to_owned(),
                ..kube::core::Status::default()
            }
            .boxed(),
        );
        let invalid = kube::Error::Api(
            kube::core::Status {
                code: 422,
                reason: "Invalid".to_owned(),
                ..kube::core::Status::default()
            }
            .boxed(),
        );

        assert!(is_conflict(&conflict));
        assert!(is_conflict(&already_exists));
        assert!(!is_conflict(&invalid));
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
                        "type": "reasoning",
                        "summary": ["Public reasoning summary"],
                        "content": ["Internal reasoning content"]
                    }
                }
            })),
            "Public reasoning summary"
        );
        assert_eq!(
            codex_event_text(&json!({
                "params": {
                    "item": {
                        "type": "commandExecution",
                        "status": "completed",
                        "aggregatedOutput": "",
                        "exitCode": 0
                    }
                }
            })),
            "Command completed (exit 0)"
        );
        assert_eq!(
            codex_event_text(&json!({
                "params": {
                    "item": {
                        "type": "mcpToolCall",
                        "status": "completed",
                        "result": {
                            "content": [],
                            "structuredContent": {"id": "ENG-123", "state": "Done"}
                        }
                    }
                }
            })),
            "{\n  \"id\": \"ENG-123\",\n  \"state\": \"Done\"\n}"
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
            codex_event_kind("tengri/eventOmitted", "", &json!({})),
            CodexEventKind::Warning
        );
        let legacy_approval = codex_event(crate::guest::CodexEvent {
            sequence: 7,
            method: "execCommandApproval".to_owned(),
            approval_id: "approval-legacy".to_owned(),
            raw: json!({"params": {"conversationId": "thread-legacy"}}),
        });
        assert_eq!(legacy_approval.thread_id, "thread-legacy");
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
            codex_event_kind(
                "turn/completed",
                "",
                &json!({
                    "params": {
                        "turn": {
                            "id": "turn-failed",
                            "status": "failed",
                            "error": {"message": "turn failed"}
                        }
                    }
                }),
            ),
            CodexEventKind::Error
        );
        assert_eq!(
            codex_event_kind(
                "account/login/completed",
                "",
                &json!({"params": {"success": false, "error": "device code expired"}}),
            ),
            CodexEventKind::Error
        );
        assert_eq!(
            codex_event_text(&json!({"params": {"error": "device code expired"}})),
            "device code expired"
        );
        let login_started_at = DateTime::parse_from_rfc3339("2026-08-27T13:00:00Z")
            .expect("login timestamp")
            .with_timezone(&Utc);
        assert_eq!(
            codex_login_expires_at(login_started_at),
            "2026-08-27T13:15:00+00:00"
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
    fn oversized_approvals_retain_only_supported_decision_metadata() {
        let event = codex_event(crate::guest::CodexEvent {
            sequence: 9,
            method: "item/commandExecution/requestApproval".to_owned(),
            approval_id: "approval-large".to_owned(),
            raw: json!({
                "params": {
                    "threadId": "thread-large",
                    "command": "x".repeat(MAX_CODEX_EVENT_TEXT_BYTES + 1),
                    "availableDecisions": ["decline"]
                }
            }),
        });

        assert_eq!(event.thread_id, "thread-large");
        assert!(event.raw_json.len() <= MAX_CODEX_EVENT_TEXT_BYTES);
        let raw: Value = serde_json::from_str(&event.raw_json).expect("bounded approval JSON");
        assert_eq!(raw.pointer("/rawOmitted"), Some(&Value::Bool(true)));
        assert_eq!(
            raw.pointer("/params/availableDecisions"),
            Some(&json!(["decline"])),
        );

        assert_eq!(
            bounded_approval_decisions(&json!([
                "accept",
                "acceptForSession",
                "cancel",
                {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": {"ignored": "x".repeat(MAX_CODEX_EVENT_TEXT_BYTES)}}},
                {"applyNetworkPolicyAmendment": {"network_policy_amendment": {"ignored": true}}},
                "unsupported"
            ])),
            json!([
                "accept",
                "acceptForSession",
                "cancel",
                {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": true}},
                {"applyNetworkPolicyAmendment": {"network_policy_amendment": true}}
            ]),
        );
        assert_eq!(bounded_approval_decisions(&Value::Null), Value::Null);
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

    #[test]
    fn preview_fragment_is_bounded_and_kept_separate_from_the_proxy_path() {
        assert_eq!(
            validate_preview_fragment("#editor").expect("preview fragment"),
            "#editor",
        );
        assert_eq!(validate_preview_fragment("").expect("empty fragment"), "");
        let exact = format!("#{}x", "é".repeat(2_047));
        assert_eq!(exact.len(), 4_096);
        assert_eq!(
            validate_preview_fragment(&exact).expect("maximum preview fragment"),
            exact,
        );
        assert!(validate_preview_fragment("editor").is_err());
        assert!(validate_preview_fragment("#editor\nprivate").is_err());
        assert!(validate_preview_fragment(&format!("#{}", "é".repeat(2_048))).is_err());
    }

    #[test]
    fn legacy_terminal_requests_receive_independent_creation_identities() {
        let first = compatible_terminal_creation_id("");
        let second = compatible_terminal_creation_id("");
        assert!((16..=128).contains(&first.len()));
        assert!(
            first
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        );
        assert_ne!(first, second);
        assert_eq!(
            compatible_terminal_creation_id("tengri-existing-creation"),
            "tengri-existing-creation"
        );
    }

    fn legacy_guest_terminal_creation(id: &str) -> GuestTerminalCreation {
        GuestTerminalCreation {
            session: guest_terminal_session(id, "legacy-grpc-test", "/workspace"),
            created: true,
        }
    }

    fn guest_terminal_session(
        id: &str,
        creation_id: &str,
        cwd: &str,
    ) -> crate::guest::TerminalSession {
        crate::guest::TerminalSession {
            id: id.to_owned(),
            creation_id: creation_id.to_owned(),
            cwd: cwd.to_owned(),
            created_at: "2026-08-28T00:00:00Z".to_owned(),
            last_activity_at: "2026-08-28T00:00:00Z".to_owned(),
            attached: false,
        }
    }

    fn provisional_creation_record(
        expires_at: DateTime<Utc>,
        existing_session_ids: Vec<String>,
        terminal_id: Option<&str>,
    ) -> ProvisionalTerminalCreationRecord {
        ProvisionalTerminalCreationRecord {
            expires_at: expires_at.to_rfc3339(),
            cwd: "/workspace".to_owned(),
            existing_session_ids,
            terminal_id: terminal_id.map(str::to_owned),
        }
    }

    fn kube_not_found_response(name: &str) -> HttpResponse<KubeBody> {
        HttpResponse::builder()
            .status(HttpStatusCode::NOT_FOUND)
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(KubeBody::from(
                serde_json::to_vec(&json!({
                    "apiVersion": "v1",
                    "kind": "Status",
                    "metadata": {},
                    "status": "Failure",
                    "message": format!("microvms.runtime.proompteng.ai {name} not found"),
                    "reason": "NotFound",
                    "details": {
                        "name": name,
                        "group": "runtime.proompteng.ai",
                        "kind": "microvms"
                    },
                    "code": 404
                }))
                .expect("Kubernetes not-found response JSON"),
            ))
            .expect("Kubernetes not-found response")
    }

    #[test]
    fn legacy_terminal_cleanup_finds_the_unique_session_created_after_the_snapshot() {
        let creation_id = "legacy-grpc-0123456789abcdef0123456789abcdef";
        let record =
            provisional_creation_record(Utc::now(), vec!["terminal-before".to_owned()], None);
        let sessions = vec![
            guest_terminal_session("terminal-before", "", "/workspace"),
            guest_terminal_session("terminal-new", "", "/workspace"),
            guest_terminal_session("terminal-other-cwd", "", "/tmp"),
        ];

        assert_eq!(
            provisional_terminal_cleanup_id(&sessions, creation_id, &record),
            Ok(Some("terminal-new".to_owned())),
        );
    }

    #[test]
    fn legacy_terminal_cleanup_uses_the_persisted_terminal_id_after_restart() {
        let creation_id = "legacy-grpc-0123456789abcdef0123456789abcdef";
        let record = provisional_creation_record(
            Utc::now(),
            vec!["terminal-before".to_owned()],
            Some("terminal-created"),
        );
        let sessions = vec![
            guest_terminal_session("terminal-before", "", "/workspace"),
            guest_terminal_session("terminal-created", "", "/workspace"),
            guest_terminal_session("terminal-later", "", "/workspace"),
        ];

        assert_eq!(
            provisional_terminal_cleanup_id(&sessions, creation_id, &record),
            Ok(Some("terminal-created".to_owned())),
        );
    }

    #[test]
    fn legacy_terminal_cleanup_retries_instead_of_guessing_between_candidates() {
        let creation_id = "legacy-grpc-0123456789abcdef0123456789abcdef";
        let record = provisional_creation_record(Utc::now(), Vec::new(), None);
        let sessions = vec![
            guest_terminal_session("terminal-first", "", "/workspace"),
            guest_terminal_session("terminal-second", "", "/workspace"),
        ];

        assert_eq!(
            provisional_terminal_cleanup_id(&sessions, creation_id, &record),
            Err(2),
        );
    }

    fn provisional_terminal_test_agent(now: DateTime<Utc>) -> MicroVM {
        MicroVM::new(
            "agent-legacy",
            MicroVMSpec {
                display_name: "Legacy agent".to_owned(),
                owner_hash: "a".repeat(64),
                desired_state: MicroVMDesiredState::Running,
                image: format!("registry.example/nanoagent@sha256:{}", "b".repeat(64)),
                architecture: MicroVMArchitecture::Amd64,
                resources: MicroVMResources::default(),
                created_at: now.to_rfc3339(),
                idle_deadline: (now + chrono::Duration::minutes(IDLE_MINUTES)).to_rfc3339(),
                expires_at: (now + chrono::Duration::hours(LIFETIME_HOURS)).to_rfc3339(),
            },
        )
    }

    #[tokio::test]
    async fn provisional_terminal_lease_is_persisted_on_the_microvm() {
        let (service, mut handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            TerminalIdentityRegistry::default(),
        );
        let persistence = tokio::spawn(async move {
            manager
                .patch_annotation(
                    "agent-legacy",
                    "terminal-durable",
                    Some("2026-08-28T21:00:00Z"),
                )
                .await
        });

        let (request, response) = handle.next_request().await.expect("MicroVM lease patch");
        assert_eq!(request.method(), http::Method::PATCH);
        assert_eq!(
            request.uri().path(),
            "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent-legacy"
        );
        let body: Value = serde_json::from_slice(
            &request
                .into_body()
                .collect_bytes()
                .await
                .expect("lease patch body"),
        )
        .expect("lease patch JSON");
        assert_eq!(
            body["metadata"]["annotations"]
                [provisional_terminal_annotation_key("terminal-durable")],
            "2026-08-28T21:00:00Z"
        );
        response.send_response(
            HttpResponse::builder()
                .status(HttpStatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&provisional_terminal_test_agent(Utc::now()))
                        .expect("MicroVM response JSON"),
                ))
                .expect("MicroVM lease patch response"),
        );
        persistence
            .await
            .expect("lease persistence task")
            .expect("lease persistence request");
    }

    #[tokio::test]
    async fn legacy_creation_intent_is_persisted_before_the_guest_request() {
        let (service, mut handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            TerminalIdentityRegistry::default(),
        );
        let creation_id = "legacy-grpc-0123456789abcdef0123456789abcdef".to_owned();
        let existing_sessions = vec![guest_terminal_session(
            "terminal-existing",
            "",
            "/workspace",
        )];
        let persistence = tokio::spawn(async move {
            manager
                .begin_creation(
                    "agent-legacy",
                    &creation_id,
                    "/workspace",
                    &existing_sessions,
                    Duration::from_secs(60),
                )
                .await
        });

        let (request, response) = handle
            .next_request()
            .await
            .expect("MicroVM creation intent patch");
        assert_eq!(request.method(), http::Method::PATCH);
        let body: Value = serde_json::from_slice(
            &request
                .into_body()
                .collect_bytes()
                .await
                .expect("creation intent patch body"),
        )
        .expect("creation intent patch JSON");
        let key = provisional_terminal_creation_annotation_key(
            "legacy-grpc-0123456789abcdef0123456789abcdef",
        )
        .expect("creation intent key");
        let record: ProvisionalTerminalCreationRecord = serde_json::from_str(
            body["metadata"]["annotations"][key]
                .as_str()
                .expect("serialized creation record"),
        )
        .expect("creation record JSON");
        assert!(DateTime::parse_from_rfc3339(&record.expires_at).is_ok());
        assert_eq!(record.cwd, "/workspace");
        assert_eq!(record.existing_session_ids, vec!["terminal-existing"]);
        assert_eq!(record.terminal_id, None);
        response.send_response(
            HttpResponse::builder()
                .status(HttpStatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&provisional_terminal_test_agent(Utc::now()))
                        .expect("MicroVM response JSON"),
                ))
                .expect("MicroVM creation intent response"),
        );
        persistence
            .await
            .expect("creation intent persistence task")
            .expect("creation intent persistence request");
    }

    #[tokio::test]
    async fn canceled_persistence_waiter_still_registers_applied_creation_intent() {
        let (service, mut handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            TerminalIdentityRegistry::default(),
        );
        let creation_id = "legacy-grpc-0123456789abcdef0123456789abcdef";
        let lease_guard = manager.creation_intents.leases.lock().await;
        let persistence_manager = manager.clone();
        let persistence = tokio::spawn(async move {
            persistence_manager
                .begin_creation(
                    "agent-legacy",
                    creation_id,
                    "/workspace",
                    &[],
                    Duration::from_secs(60),
                )
                .await
        });

        let (_request, response) = handle
            .next_request()
            .await
            .expect("MicroVM creation intent patch");
        response.send_response(
            HttpResponse::builder()
                .status(HttpStatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&provisional_terminal_test_agent(Utc::now()))
                        .expect("MicroVM response JSON"),
                ))
                .expect("MicroVM creation intent response"),
        );
        tokio::task::yield_now().await;
        persistence.abort();
        assert!(
            persistence
                .await
                .expect_err("persistence waiter must be canceled")
                .is_cancelled()
        );
        drop(lease_guard);

        let key = ("agent-legacy".to_owned(), creation_id.to_owned());
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if matches!(
                    manager.creation_intents.leases.lock().await.get(&key),
                    Some(ProvisionalTerminalLease::Creating(_))
                ) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached persistence must register cleanup after caller cancellation");
        assert!(manager.creation_intents.clear(&key.0, &key.1).await);
    }

    #[tokio::test]
    async fn persisted_ticket_deadline_refreshes_when_terminal_creation_settles() {
        let (service, mut handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            TerminalIdentityRegistry::default(),
        );
        let creation_id = "legacy-grpc-0123456789abcdef0123456789abcdef";
        let timeout = Duration::from_secs(60);
        let original_record = provisional_creation_record(
            Utc::now() - chrono::Duration::minutes(1),
            vec!["terminal-existing".to_owned()],
            None,
        );
        manager
            .schedule_creation(
                "agent-legacy",
                creation_id,
                timeout,
                original_record.clone(),
                true,
            )
            .await;

        let settled_after = Utc::now();
        let settlement_manager = manager.clone();
        let settlement = tokio::spawn(async move {
            settlement_manager
                .record_terminal_id(
                    "agent-legacy",
                    creation_id,
                    original_record,
                    "terminal-created",
                    timeout,
                )
                .await
        });
        let (request, response) = handle
            .next_request()
            .await
            .expect("settled creation intent patch");
        let body: Value = serde_json::from_slice(
            &request
                .into_body()
                .collect_bytes()
                .await
                .expect("settled creation patch body"),
        )
        .expect("settled creation patch JSON");
        let key = provisional_terminal_creation_annotation_key(creation_id)
            .expect("creation intent annotation key");
        let serialized = body["metadata"]["annotations"][&key]
            .as_str()
            .expect("serialized settled creation record");
        let record: ProvisionalTerminalCreationRecord =
            serde_json::from_str(serialized).expect("settled creation record JSON");
        let refreshed_expiry = DateTime::parse_from_rfc3339(&record.expires_at)
            .expect("refreshed expiry")
            .with_timezone(&Utc);
        assert_eq!(record.terminal_id.as_deref(), Some("terminal-created"));
        assert!(
            refreshed_expiry >= settled_after + chrono::Duration::seconds(59),
            "a restart after slow creation must retain the full ticket-confirmation window",
        );

        let mut recovered_agent = provisional_terminal_test_agent(settled_after);
        recovered_agent.metadata.annotations = Some(std::collections::BTreeMap::from([(
            key,
            serialized.to_owned(),
        )]));
        let restart_at = settled_after + chrono::Duration::seconds(30);
        let recovered =
            recoverable_provisional_terminal_creation_intents(&recovered_agent, restart_at);
        assert_eq!(recovered.len(), 1);
        assert!(recovered[0].delay >= Duration::from_secs(29));

        response.send_response(
            HttpResponse::builder()
                .status(HttpStatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&recovered_agent).expect("MicroVM response JSON"),
                ))
                .expect("settled creation patch response"),
        );
        settlement
            .await
            .expect("settlement task")
            .expect("settled creation persistence");
    }

    #[tokio::test]
    async fn persisted_terminal_identity_is_not_reintroduced_after_ticket_confirmation() {
        let registry = ProvisionalTerminalLeaseRegistry::default();
        registry
            .register(
                "agent-legacy",
                "legacy-grpc-confirmed",
                Duration::from_secs(60),
                Duration::from_millis(1),
                |_| async { true },
            )
            .await;
        let writes = Arc::new(AtomicUsize::new(0));
        let tracked_writes = writes.clone();
        registry
            .settle_creation("agent-legacy", "legacy-grpc-confirmed", move || {
                let tracked_writes = tracked_writes.clone();
                async move {
                    tracked_writes.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            })
            .await
            .expect("tracked write");
        registry
            .issue_and_confirm("agent-legacy", "legacy-grpc-confirmed", |_| async {
                Ok(())
            })
            .await
            .expect("ticket confirmation");
        let confirmed_writes = writes.clone();
        registry
            .settle_creation("agent-legacy", "legacy-grpc-confirmed", move || {
                let confirmed_writes = confirmed_writes.clone();
                async move {
                    confirmed_writes.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            })
            .await
            .expect("confirmed creation no-op");

        assert_eq!(writes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn legacy_creation_snapshots_are_serialized_per_agent_only() {
        let (service, _handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            TerminalIdentityRegistry::default(),
        );
        let first_agent = manager.lock_creation("agent-a").await;
        let other_agent =
            tokio::time::timeout(Duration::from_millis(50), manager.lock_creation("agent-b"))
                .await
                .expect("another agent must not be blocked");
        assert!(
            tokio::time::timeout(Duration::from_millis(10), manager.lock_creation("agent-a"))
                .await
                .is_err(),
            "the same agent must remain serialized",
        );
        drop(first_agent);
        tokio::time::timeout(Duration::from_millis(50), manager.lock_creation("agent-a"))
            .await
            .expect("same agent lock after release");
        drop(other_agent);
    }

    #[tokio::test]
    async fn idless_snapshot_waits_for_an_explicit_mixed_version_creation() {
        let (service, _handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            TerminalIdentityRegistry::default(),
        );
        let sessions = Arc::new(Mutex::new(vec![guest_terminal_session(
            "terminal-existing",
            "",
            "/workspace",
        )]));

        let explicit_creation_guard = manager.lock_creation("agent-legacy").await;
        let snapshot_manager = manager.clone();
        let snapshot_sessions = sessions.clone();
        let (started_sender, started_receiver) = oneshot::channel();
        let snapshot = tokio::spawn(async move {
            started_sender.send(()).expect("snapshot start receiver");
            let _idless_creation_guard = snapshot_manager.lock_creation("agent-legacy").await;
            snapshot_sessions.lock().await.clone()
        });
        started_receiver.await.expect("snapshot started");
        tokio::task::yield_now().await;
        assert!(
            !snapshot.is_finished(),
            "the ID-less snapshot must wait for an explicit creation",
        );
        sessions.lock().await.push(guest_terminal_session(
            "terminal-explicit",
            "",
            "/workspace",
        ));
        drop(explicit_creation_guard);

        let snapshot = tokio::time::timeout(Duration::from_secs(1), snapshot)
            .await
            .expect("serialized snapshot timeout")
            .expect("serialized snapshot task");
        assert_eq!(
            snapshot
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            vec!["terminal-existing", "terminal-explicit"]
        );
    }

    #[tokio::test]
    async fn recovered_legacy_cleanup_waits_for_a_mixed_version_retry() {
        let (service, mut handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let terminal_identities = TerminalIdentityRegistry::default();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            terminal_identities.clone(),
        );
        let stale_creation_id = "legacy-grpc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let retry_creation_id = "legacy-grpc-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let record = provisional_creation_record(
            Utc::now() - chrono::Duration::seconds(1),
            vec!["terminal-existing".to_owned()],
            None,
        );
        terminal_identities.restore_legacy_creation(
            "agent-legacy",
            stale_creation_id,
            &record.cwd,
            &record.existing_session_ids,
            None,
        );

        let retry_guard = manager.lock_creation("agent-legacy").await;
        let cleanup_manager = manager.clone();
        let cleanup_record = record.clone();
        let cleanup = tokio::spawn(async move {
            cleanup_manager
                .cleanup_creation_once("agent-legacy", stale_creation_id, &cleanup_record)
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(25), handle.next_request())
                .await
                .is_err(),
            "stale cleanup must not inspect Kubernetes or guest state during a retry",
        );

        terminal_identities.restore_legacy_creation(
            "agent-legacy",
            retry_creation_id,
            "/workspace",
            &["terminal-existing".to_owned()],
            Some("terminal-retry"),
        );
        drop(retry_guard);
        let (request, _response) =
            tokio::time::timeout(Duration::from_secs(1), handle.next_request())
                .await
                .expect("cleanup resumes after retry settlement")
                .expect("MicroVM lookup request");
        assert_eq!(
            request.uri().path(),
            "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent-legacy"
        );
        cleanup.abort();

        let mut sessions = vec![
            guest_terminal_session("terminal-existing", "", "/workspace"),
            guest_terminal_session("terminal-retry", "", "/workspace"),
        ];
        terminal_identities.reconcile("agent-legacy", &mut sessions);
        assert_eq!(sessions[1].creation_id, retry_creation_id);
        assert_eq!(
            provisional_terminal_cleanup_id(&sessions, stale_creation_id, &record),
            Ok(None),
            "the stale cleanup must not claim the retry's valid terminal",
        );
    }

    #[tokio::test]
    async fn durable_cleanup_removes_a_restored_legacy_identity() {
        let (service, mut handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let terminal_identities = TerminalIdentityRegistry::default();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            terminal_identities.clone(),
        );
        let creation_id = "legacy-grpc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let record = provisional_creation_record(
            Utc::now() - chrono::Duration::seconds(1),
            vec!["terminal-existing".to_owned()],
            None,
        );
        terminal_identities.restore_legacy_creation(
            "agent-legacy",
            creation_id,
            &record.cwd,
            &record.existing_session_ids,
            None,
        );

        let cleanup_manager = manager.clone();
        let cleanup_record = record.clone();
        let cleanup = tokio::spawn(async move {
            cleanup_manager
                .cleanup_creation_once("agent-legacy", creation_id, &cleanup_record)
                .await
        });
        let (request, response) = handle.next_request().await.expect("MicroVM lookup request");
        assert_eq!(request.method(), http::Method::GET);
        response.send_response(kube_not_found_response("agent-legacy"));
        let (request, response) = handle
            .next_request()
            .await
            .expect("creation annotation clear request");
        assert_eq!(request.method(), http::Method::PATCH);
        response.send_response(kube_not_found_response("agent-legacy"));
        assert!(cleanup.await.expect("cleanup task"));

        let mut later_sessions = vec![guest_terminal_session("terminal-later", "", "/workspace")];
        terminal_identities.reconcile("agent-legacy", &mut later_sessions);
        assert!(
            later_sessions[0].creation_id.is_empty(),
            "a cleared identity must not claim a later legacy terminal",
        );
    }

    #[tokio::test]
    async fn legacy_terminal_without_a_ticket_is_cleaned_up_after_the_handler_returns() {
        let registry = ProvisionalTerminalLeaseRegistry::default();
        let (cleanup_sender, mut cleanup_receiver) = tokio::sync::mpsc::unbounded_channel();
        registry
            .register(
                "agent-legacy",
                "legacy-grpc-test",
                Duration::from_millis(10),
                Duration::from_millis(1),
                move |creation_id| {
                    let cleanup_sender = cleanup_sender.clone();
                    async move {
                        cleanup_sender.send(creation_id).expect("cleanup receiver");
                        true
                    }
                },
            )
            .await;
        let creation = detached_terminal_creation(
            async { Ok(legacy_guest_terminal_creation("terminal-unconfirmed")) },
            |creation| async move { Ok(creation) },
            |error| async move { Err(map_guest_error(error)) },
            (),
        )
        .await
        .expect("terminal creation");

        assert_eq!(creation.session.id, "terminal-unconfirmed");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), cleanup_receiver.recv())
                .await
                .expect("cleanup timeout")
                .expect("cleanup result"),
            "legacy-grpc-test"
        );
    }

    #[tokio::test]
    async fn mixed_version_creation_lock_is_held_through_identity_persistence() {
        let (service, _handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            TerminalIdentityRegistry::default(),
        );
        let creation_guard = manager.lock_creation("agent-legacy").await;
        let (persistence_started_sender, persistence_started_receiver) = oneshot::channel();
        let (persistence_release_sender, persistence_release_receiver) = oneshot::channel();
        let creation = tokio::spawn(detached_terminal_creation(
            async { Ok(legacy_guest_terminal_creation("terminal-created")) },
            move |creation| async move {
                persistence_started_sender
                    .send(())
                    .expect("persistence started receiver");
                persistence_release_receiver
                    .await
                    .expect("persistence release");
                Ok(creation)
            },
            |error| async move { Err(map_guest_error(error)) },
            creation_guard,
        ));

        persistence_started_receiver
            .await
            .expect("identity persistence started");
        assert!(
            tokio::time::timeout(
                Duration::from_millis(25),
                manager.lock_creation("agent-legacy"),
            )
            .await
            .is_err(),
            "another legacy create must remain blocked while identity persistence is in flight",
        );

        persistence_release_sender
            .send(())
            .expect("persistence receiver");
        creation
            .await
            .expect("creation task")
            .expect("terminal creation");
        tokio::time::timeout(
            Duration::from_millis(100),
            manager.lock_creation("agent-legacy"),
        )
        .await
        .expect("creation lock releases after identity persistence");
    }

    #[tokio::test]
    async fn cleanup_waits_for_delayed_terminal_creation_to_settle() {
        let registry = ProvisionalTerminalLeaseRegistry::default();
        let settled = Arc::new(AtomicBool::new(false));
        let cleanup_settled = settled.clone();
        let (cleanup_sender, mut cleanup_receiver) = tokio::sync::mpsc::unbounded_channel();
        registry
            .register_with_state(
                "agent-legacy",
                "legacy-grpc-delayed",
                Duration::from_millis(1),
                Duration::from_millis(1),
                true,
                move |_| {
                    let cleanup_sender = cleanup_sender.clone();
                    let cleanup_settled = cleanup_settled.clone();
                    async move {
                        cleanup_sender
                            .send(cleanup_settled.load(Ordering::SeqCst))
                            .expect("cleanup receiver");
                        true
                    }
                },
            )
            .await;

        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(cleanup_receiver.try_recv().is_err());
        assert!(matches!(
            registry
                .leases
                .lock()
                .await
                .get(&("agent-legacy".to_owned(), "legacy-grpc-delayed".to_owned()))
                .copied(),
            Some(ProvisionalTerminalLease::Creating(_))
        ));

        let settled_for_action = settled.clone();
        registry
            .settle_creation("agent-legacy", "legacy-grpc-delayed", move || async move {
                settled_for_action.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
            .expect("delayed creation settlement");
        assert!(
            tokio::time::timeout(Duration::from_secs(1), cleanup_receiver.recv())
                .await
                .expect("delayed cleanup timeout")
                .expect("delayed cleanup result")
        );
    }

    #[tokio::test]
    async fn ambiguous_creation_failure_starts_timed_cleanup() {
        let (service, _handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            TerminalIdentityRegistry::default(),
        );
        let (cleanup_sender, mut cleanup_receiver) = tokio::sync::mpsc::unbounded_channel();
        manager
            .creation_intents
            .register_with_state(
                "agent-legacy",
                "legacy-grpc-ambiguous",
                Duration::from_millis(10),
                Duration::from_millis(1),
                true,
                move |creation_id| {
                    let cleanup_sender = cleanup_sender.clone();
                    async move {
                        cleanup_sender.send(creation_id).expect("cleanup receiver");
                        true
                    }
                },
            )
            .await;

        manager
            .settle_ambiguous_creation("agent-legacy", "legacy-grpc-ambiguous")
            .await
            .expect("ambiguous creation settlement");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), cleanup_receiver.recv())
                .await
                .expect("ambiguous cleanup timeout")
                .expect("ambiguous cleanup result"),
            "legacy-grpc-ambiguous",
        );
    }

    #[tokio::test]
    async fn ticket_timeout_starts_after_terminal_creation_settles() {
        let registry = ProvisionalTerminalLeaseRegistry::default();
        let (cleanup_sender, mut cleanup_receiver) = tokio::sync::mpsc::unbounded_channel();
        registry
            .register_with_state(
                "agent-legacy",
                "legacy-grpc-ticket-window",
                Duration::from_millis(200),
                Duration::from_millis(5),
                true,
                move |creation_id| {
                    let cleanup_sender = cleanup_sender.clone();
                    async move {
                        cleanup_sender.send(creation_id).expect("cleanup receiver");
                        true
                    }
                },
            )
            .await;

        tokio::time::sleep(Duration::from_millis(150)).await;
        registry
            .settle_creation("agent-legacy", "legacy-grpc-ticket-window", || async {
                Ok(())
            })
            .await
            .expect("terminal creation settlement");
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(100), cleanup_receiver.recv())
                .await
                .ok()
                .flatten(),
            None,
            "the pre-creation interval must not consume the ticket-confirmation window",
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(200), cleanup_receiver.recv())
                .await
                .expect("cleanup after the post-creation ticket window")
                .expect("cleanup result"),
            "legacy-grpc-ticket-window",
        );
    }

    #[tokio::test]
    async fn definitive_failure_clear_retries_after_leaving_creating_state() {
        let registry = ProvisionalTerminalLeaseRegistry::default();
        registry
            .register_with_state(
                "agent-legacy",
                "legacy-grpc-definitive-failure",
                Duration::from_secs(60),
                Duration::from_millis(1),
                true,
                |_| async { true },
            )
            .await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let clear_attempts = attempts.clone();
        let first_attempt_started = Arc::new(tokio::sync::Notify::new());
        let clear_started = first_attempt_started.clone();
        let first_attempt_release = Arc::new(tokio::sync::Notify::new());
        let clear_release = first_attempt_release.clone();
        let clear_registry = registry.clone();
        let clear = tokio::spawn(async move {
            clear_registry
                .clear_tracked(
                    "agent-legacy",
                    "legacy-grpc-definitive-failure",
                    Duration::from_millis(1),
                    move |tracked| {
                        let clear_attempts = clear_attempts.clone();
                        let clear_started = clear_started.clone();
                        let clear_release = clear_release.clone();
                        async move {
                            assert!(tracked);
                            if clear_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                                clear_started.notify_one();
                                clear_release.notified().await;
                                return Err(Status::unavailable("transient Kubernetes failure"));
                            }
                            Ok(())
                        }
                    },
                )
                .await
        });

        first_attempt_started.notified().await;
        assert!(matches!(
            registry
                .leases
                .lock()
                .await
                .get(&(
                    "agent-legacy".to_owned(),
                    "legacy-grpc-definitive-failure".to_owned(),
                ))
                .copied(),
            Some(ProvisionalTerminalLease::Clearing(_)),
        ));
        first_attempt_release.notify_one();
        clear
            .await
            .expect("definitive failure clear task")
            .expect("retried definitive failure clear");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert!(
            registry
                .leases
                .lock()
                .await
                .get(&(
                    "agent-legacy".to_owned(),
                    "legacy-grpc-definitive-failure".to_owned(),
                ))
                .is_none(),
        );
    }

    #[tokio::test]
    async fn ticket_confirmation_before_response_handling_cancels_creation_cleanup() {
        let registry = ProvisionalTerminalLeaseRegistry::default();
        let (cleanup_sender, mut cleanup_receiver) = tokio::sync::mpsc::unbounded_channel();
        registry
            .register(
                "agent-legacy",
                "legacy-grpc-confirmed",
                Duration::from_millis(10),
                Duration::from_millis(1),
                move |terminal_id| {
                    let cleanup_sender = cleanup_sender.clone();
                    async move {
                        cleanup_sender.send(terminal_id).expect("cleanup receiver");
                        true
                    }
                },
            )
            .await;

        let ticket = registry
            .issue_and_confirm(
                "agent-legacy",
                "legacy-grpc-confirmed",
                |tracked| async move {
                    assert!(tracked);
                    Ok("terminal-ticket")
                },
            )
            .await
            .expect("ticket issuance");

        assert_eq!(ticket, "terminal-ticket");
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(50), cleanup_receiver.recv())
                .await
                .ok()
                .flatten(),
            None
        );
    }

    #[tokio::test]
    async fn canceled_legacy_handler_still_registers_terminal_cleanup() {
        let registry = ProvisionalTerminalLeaseRegistry::default();
        let (started_sender, started_receiver) = oneshot::channel();
        let (release_sender, release_receiver) = oneshot::channel();
        let (cleanup_sender, mut cleanup_receiver) = tokio::sync::mpsc::unbounded_channel();
        registry
            .register(
                "agent-legacy",
                "legacy-grpc-test",
                Duration::from_millis(10),
                Duration::from_millis(1),
                move |creation_id| {
                    let cleanup_sender = cleanup_sender.clone();
                    async move {
                        cleanup_sender.send(creation_id).expect("cleanup receiver");
                        true
                    }
                },
            )
            .await;
        let handler = tokio::spawn(detached_terminal_creation(
            async move {
                started_sender.send(()).expect("started receiver");
                release_receiver.await.expect("creation release");
                Ok(legacy_guest_terminal_creation("terminal-canceled-handler"))
            },
            |creation| async move { Ok(creation) },
            |error| async move { Err(map_guest_error(error)) },
            (),
        ));
        started_receiver.await.expect("creation started");
        handler.abort();
        release_sender.send(()).expect("creation receiver");

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), cleanup_receiver.recv())
                .await
                .expect("cleanup timeout")
                .expect("cleanup result"),
            "legacy-grpc-test"
        );
    }

    #[tokio::test]
    async fn failed_provisional_terminal_cleanup_is_retried() {
        let registry = ProvisionalTerminalLeaseRegistry::default();
        let attempts = Arc::new(AtomicUsize::new(0));
        let cleanup_attempts = attempts.clone();
        let (cleanup_sender, mut cleanup_receiver) = tokio::sync::mpsc::unbounded_channel();
        registry
            .register(
                "agent-legacy",
                "terminal-retry",
                Duration::from_millis(1),
                Duration::from_millis(1),
                move |terminal_id| {
                    let cleanup_attempts = cleanup_attempts.clone();
                    let cleanup_sender = cleanup_sender.clone();
                    async move {
                        let attempt = cleanup_attempts.fetch_add(1, Ordering::SeqCst) + 1;
                        if attempt == 1 {
                            return false;
                        }
                        cleanup_sender.send(terminal_id).expect("cleanup receiver");
                        true
                    }
                },
            )
            .await;

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), cleanup_receiver.recv())
                .await
                .expect("cleanup retry timeout")
                .expect("cleanup retry result"),
            "terminal-retry"
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn replacement_registry_recovers_a_durable_provisional_terminal_lease() {
        let now = Utc::now();
        let mut agent = provisional_terminal_test_agent(now);
        agent.metadata.annotations = Some(std::collections::BTreeMap::from([(
            provisional_terminal_annotation_key("terminal-recovered"),
            (now - chrono::Duration::seconds(1)).to_rfc3339(),
        )]));
        let recovered = recoverable_provisional_terminal_leases(&agent, now);
        assert_eq!(
            recovered,
            vec![RecoverableProvisionalTerminalLease {
                agent_id: "agent-legacy".to_owned(),
                terminal_id: "terminal-recovered".to_owned(),
                delay: Duration::ZERO,
            }]
        );

        let replacement_registry = ProvisionalTerminalLeaseRegistry::default();
        let (cleanup_sender, mut cleanup_receiver) = tokio::sync::mpsc::unbounded_channel();
        replacement_registry
            .register(
                &recovered[0].agent_id,
                &recovered[0].terminal_id,
                recovered[0].delay,
                Duration::from_millis(1),
                move |terminal_id| {
                    let cleanup_sender = cleanup_sender.clone();
                    async move {
                        cleanup_sender.send(terminal_id).expect("cleanup receiver");
                        true
                    }
                },
            )
            .await;

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), cleanup_receiver.recv())
                .await
                .expect("recovered cleanup timeout")
                .expect("recovered cleanup result"),
            "terminal-recovered"
        );
    }

    #[tokio::test]
    async fn replacement_recovers_creation_intent_before_guest_response() {
        let now = Utc::now();
        let creation_id = "legacy-grpc-fedcba9876543210fedcba9876543210";
        let record = provisional_creation_record(
            now - chrono::Duration::seconds(1),
            vec!["terminal-existing".to_owned()],
            Some("terminal-created"),
        );
        let mut agent = provisional_terminal_test_agent(now);
        agent.metadata.annotations = Some(std::collections::BTreeMap::from([(
            provisional_terminal_creation_annotation_key(creation_id)
                .expect("creation intent annotation key"),
            serde_json::to_string(&record).expect("creation record JSON"),
        )]));
        let recovered = recoverable_provisional_terminal_creation_intents(&agent, now);
        assert_eq!(
            recovered,
            vec![RecoverableProvisionalTerminalCreationIntent {
                agent_id: "agent-legacy".to_owned(),
                creation_id: creation_id.to_owned(),
                delay: Duration::ZERO,
                record,
            }]
        );

        let replacement_registry = ProvisionalTerminalLeaseRegistry::default();
        let (cleanup_sender, mut cleanup_receiver) = tokio::sync::mpsc::unbounded_channel();
        replacement_registry
            .register(
                &recovered[0].agent_id,
                &recovered[0].creation_id,
                recovered[0].delay,
                Duration::from_millis(1),
                move |creation_id| {
                    let cleanup_sender = cleanup_sender.clone();
                    async move {
                        cleanup_sender.send(creation_id).expect("cleanup receiver");
                        true
                    }
                },
            )
            .await;

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), cleanup_receiver.recv())
                .await
                .expect("recovered creation cleanup timeout")
                .expect("recovered creation cleanup result"),
            creation_id
        );
    }

    #[tokio::test]
    async fn live_creation_awaiting_ticket_does_not_block_another_create() {
        let (service, _handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            TerminalIdentityRegistry::default(),
        );
        let creation_id = "legacy-grpc-0123456789abcdef0123456789abcdef";
        manager
            .schedule_creation(
                "agent-legacy",
                creation_id,
                Duration::from_secs(60),
                provisional_creation_record(Utc::now(), Vec::new(), None),
                true,
            )
            .await;
        manager
            .settle_ambiguous_creation("agent-legacy", creation_id)
            .await
            .expect("live creation settlement");

        let guard = manager
            .lock_new_creation("agent-legacy")
            .await
            .expect("a live creation awaiting its ticket must not block another create");
        drop(guard);
        assert!(
            manager
                .creation_intents
                .clear("agent-legacy", creation_id)
                .await
        );
    }

    #[tokio::test]
    async fn restart_restores_legacy_identity_before_ticket_confirmation() {
        let now = Utc::now();
        let creation_id = "legacy-grpc-fedcba9876543210fedcba9876543210";
        let terminal_id = "terminal-created";
        let record = provisional_creation_record(
            now + chrono::Duration::minutes(1),
            vec!["terminal-existing".to_owned()],
            Some(terminal_id),
        );
        let mut agent = provisional_terminal_test_agent(now);
        agent.metadata.annotations = Some(std::collections::BTreeMap::from([(
            provisional_terminal_creation_annotation_key(creation_id)
                .expect("creation intent annotation key"),
            serde_json::to_string(&record).expect("creation record JSON"),
        )]));

        let (service, mut handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let terminal_identities = TerminalIdentityRegistry::default();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            terminal_identities.clone(),
        );
        let recovery_manager = manager.clone();
        let recovery = tokio::spawn(async move { recovery_manager.recover().await });
        let (request, response) = handle.next_request().await.expect("MicroVM list request");
        assert_eq!(request.method(), http::Method::GET);
        assert_eq!(
            request.uri().path(),
            "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms"
        );
        response.send_response(
            HttpResponse::builder()
                .status(HttpStatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&json!({
                        "apiVersion": "runtime.proompteng.ai/v1alpha1",
                        "kind": "MicroVMList",
                        "metadata": {},
                        "items": [agent.clone()]
                    }))
                    .expect("MicroVM list JSON"),
                ))
                .expect("MicroVM list response"),
        );
        recovery
            .await
            .expect("recovery task")
            .expect("creation intent recovery");

        let admission_error = match manager.lock_new_creation("agent-legacy").await {
            Ok(_) => panic!("a recovered creation intent must block a later creation"),
            Err(error) => error,
        };
        assert_eq!(admission_error.code(), tonic::Code::FailedPrecondition);
        assert_eq!(
            admission_error.message(),
            "a previous terminal creation is still reconciling; retry shortly"
        );
        let unrelated_guard = manager
            .lock_new_creation("agent-other")
            .await
            .expect("another agent must remain independent");
        drop(unrelated_guard);

        let mut sessions = vec![guest_terminal_session(terminal_id, "", "/workspace")];
        terminal_identities.reconcile("agent-legacy", &mut sessions);
        assert_eq!(sessions[0].creation_id, creation_id);

        let confirmation_manager = manager.clone();
        let confirmed_creation_id = sessions[0].creation_id.clone();
        let confirmation = tokio::spawn(async move {
            confirmation_manager
                .issue_and_confirm("agent-legacy", terminal_id, &confirmed_creation_id, || {
                    Ok("terminal-ticket")
                })
                .await
        });
        let (request, response) = handle
            .next_request()
            .await
            .expect("creation intent confirmation patch");
        let body: Value = serde_json::from_slice(
            &request
                .into_body()
                .collect_bytes()
                .await
                .expect("confirmation patch body"),
        )
        .expect("confirmation patch JSON");
        let key = provisional_terminal_creation_annotation_key(creation_id)
            .expect("creation intent annotation key");
        assert_eq!(body["metadata"]["annotations"][key], Value::Null);
        response.send_response(
            HttpResponse::builder()
                .status(HttpStatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&agent).expect("MicroVM response JSON"),
                ))
                .expect("MicroVM confirmation response"),
        );
        assert_eq!(
            confirmation
                .await
                .expect("confirmation task")
                .expect("ticket confirmation"),
            "terminal-ticket"
        );
        manager
            .lock_new_creation("agent-legacy")
            .await
            .expect("ticket confirmation must release creation admission");
    }

    #[tokio::test]
    async fn definitive_legacy_terminal_limit_failure_clears_intent_before_retry() {
        let (service, mut handle) =
            tower_test::mock::pair::<http::Request<KubeBody>, HttpResponse<KubeBody>>();
        let terminal_identities = TerminalIdentityRegistry::default();
        let manager = ProvisionalTerminalLeaseManager::new(
            Client::new(service, "tengri"),
            Arc::<str>::from("tengri"),
            terminal_identities.clone(),
        );
        let now = Utc::now();
        let failed_creation_id = "legacy-grpc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let record = provisional_creation_record(
            now + chrono::Duration::minutes(1),
            vec!["terminal-existing".to_owned()],
            None,
        );
        terminal_identities.restore_legacy_creation(
            "agent-legacy",
            failed_creation_id,
            &record.cwd,
            &record.existing_session_ids,
            None,
        );
        manager
            .schedule_creation(
                "agent-legacy",
                failed_creation_id,
                Duration::from_secs(60),
                record,
                true,
            )
            .await;

        let failed_manager = manager.clone();
        let failure = tokio::spawn(detached_terminal_creation(
            async {
                Err(GuestError::Api {
                    status: reqwest::StatusCode::CONFLICT,
                    message: "at most four terminal sessions are allowed".to_owned(),
                })
            },
            |creation| async move { Ok(creation) },
            move |error| async move {
                if terminal_creation_failure_is_definitive(&error) {
                    failed_manager
                        .clear_creation("agent-legacy", failed_creation_id)
                        .await?;
                }
                Err(map_guest_error(error))
            },
            (),
        ));
        let (request, response) = handle
            .next_request()
            .await
            .expect("failed creation intent clear patch");
        let body: Value = serde_json::from_slice(
            &request
                .into_body()
                .collect_bytes()
                .await
                .expect("creation clear patch body"),
        )
        .expect("creation clear patch JSON");
        let key = provisional_terminal_creation_annotation_key(failed_creation_id)
            .expect("creation intent annotation key");
        assert_eq!(body["metadata"]["annotations"][key], Value::Null);
        response.send_response(
            HttpResponse::builder()
                .status(HttpStatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&provisional_terminal_test_agent(now))
                        .expect("MicroVM response JSON"),
                ))
                .expect("MicroVM creation clear response"),
        );
        let error = failure
            .await
            .expect("failure task")
            .expect_err("terminal limit must fail");
        assert_eq!(error.code(), tonic::Code::AlreadyExists);
        assert!(
            !manager
                .creation_intents
                .issue_and_confirm("agent-legacy", failed_creation_id, |tracked| async move {
                    Ok(tracked)
                })
                .await
                .expect("cleared intent check")
        );

        let retry_creation_id = "legacy-grpc-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        terminal_identities.restore_legacy_creation(
            "agent-legacy",
            retry_creation_id,
            "/workspace",
            &["terminal-existing".to_owned()],
            None,
        );
        let mut retry_sessions = vec![
            guest_terminal_session("terminal-existing", "", "/workspace"),
            guest_terminal_session("terminal-retry", "", "/workspace"),
        ];
        terminal_identities.reconcile("agent-legacy", &mut retry_sessions);
        assert_eq!(retry_sessions[1].creation_id, retry_creation_id);
        assert!(!terminal_creation_failure_is_definitive(
            &GuestError::InvalidUtf8
        ));
    }
}
