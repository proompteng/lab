use std::{pin::Pin, sync::Arc, time::Duration};

use async_stream::try_stream;
use chrono::{DateTime, Utc};
use futures::Stream;
use kube::{
    Api, Client, Resource, ResourceExt,
    api::{DeleteParams, ListParams, Patch, PatchParams, PostParams},
};
use serde_json::json;
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
};

pub mod proto {
    tonic::include_proto!("proompteng.runtime.v1");
}

use proto::{
    Agent, AgentCondition, AgentPhase, Architecture, CreateAgentRequest, DeleteAgentRequest, Empty,
    GetAgentRequest, ListAgentsRequest, ListAgentsResponse, ResumeAgentRequest, SleepAgentRequest,
    WatchAgentRequest, micro_vm_control_plane_server::MicroVmControlPlane,
};

const OWNER_LABEL: &str = "runtime.proompteng.ai/owner";
const MAX_AGENTS: usize = 6;
const READY_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct ControlPlane {
    client: Client,
    namespace: Arc<str>,
    default_image: Arc<str>,
    architecture: MicroVMArchitecture,
    auth: Authenticator,
    activity: ActivityTracker,
    create_lock: Arc<Mutex<()>>,
}

pub struct ControlPlaneConfig {
    pub namespace: String,
    pub default_image: String,
    pub architecture: MicroVMArchitecture,
    pub internal_hmac_secret: String,
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
            activity,
            create_lock: Arc::new(Mutex::new(())),
        })
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
}
