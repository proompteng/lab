use async_stream::try_stream;
use futures::{Stream, StreamExt};
use kube::ResourceExt;
use std::{pin::Pin, sync::Arc, time::Duration};
use tokio::{sync::Mutex, time::sleep};
use tonic::Status;

use crate::{
    auth::Principal,
    crd::MicroVM,
    ofz::{
        self, Client,
        proto::{
            Action, BeginWorkspaceEnrollment, CompleteWorkspaceRemoval, EnrollWorkspace,
            RequestContext, Resource, ResourceKind, SetWorkspaceRuntime,
            execute_command_request::Command,
        },
    },
};

const REVOCATION_INTERVAL: Duration = Duration::from_secs(1);

pub(crate) fn is_control(action: Action) -> bool {
    matches!(
        action,
        Action::WorkspaceResume
            | Action::WorkspaceSleep
            | Action::WorkspacePowerConfigure
            | Action::FilesWrite
            | Action::TerminalControl
            | Action::CodexControl
            | Action::BrowserControl
            | Action::EditorOpen
            | Action::PreviewAccess
    )
}

#[derive(Clone)]
pub(crate) enum WorkspaceAuthorization {
    Ofz(Arc<Client>),
    #[cfg(test)]
    Fixture,
    #[cfg(test)]
    ControlledFixture(Arc<std::sync::atomic::AtomicU8>),
    #[cfg(test)]
    SynchronizedFixture(Arc<tokio::sync::Barrier>),
    #[cfg(test)]
    ExactFixture {
        action: Action,
        target: String,
    },
}

#[derive(Clone)]
pub(crate) struct WorkspaceAccess {
    authorization: WorkspaceAuthorization,
    context: RequestContext,
    recovery_generation: u64,
    action: Action,
    target: String,
    receipt: Arc<Mutex<String>>,
}

impl WorkspaceAuthorization {
    pub(crate) async fn guest_maintenance(
        &self,
        uid: &str,
        epoch: &str,
        purpose: ofz::proto::GuestMaintenancePurpose,
        target: &str,
    ) -> Result<ofz::proto::CheckResponse, Status> {
        match self {
            Self::Ofz(client) => client.guest_maintenance(uid, epoch, purpose, target).await,
            #[cfg(test)]
            Self::ControlledFixture(mode)
                if mode.load(std::sync::atomic::Ordering::SeqCst) != 0 =>
            {
                Err(Status::unavailable("Ofz maintenance unavailable"))
            }
            #[cfg(test)]
            _ => Ok(ofz::proto::CheckResponse {
                allowed: true,
                revision: "fixture".into(),
                audit_receipt_id: "66666666-6666-4666-8666-666666666666".into(),
                valid_until_unix_ms: ofz::now_ms()? + 2000,
                recovery_generation: 1,
                effective_scope: None,
            }),
        }
    }
    pub(crate) fn new(client: Client) -> Self {
        Self::Ofz(Arc::new(client))
    }

    pub(crate) fn access(
        &self,
        principal: &Principal,
        uid: &str,
        epoch: &str,
        target: &str,
    ) -> Result<WorkspaceAccess, Status> {
        let mut context = principal.policy_context()?;
        if context.workspace_uid.is_empty() && principal.action == Action::WorkspaceMetadataRead {
            context.workspace_uid = uid.into();
        }
        if context.workspace_uid != uid
            || (!context.runtime_epoch.is_empty() && context.runtime_epoch != epoch)
        {
            return Err(Status::permission_denied(
                "workspace UID or runtime epoch changed",
            ));
        }
        if !ofz::canonical_uuid(uid) {
            return Err(Status::unavailable("workspace UID unavailable"));
        }
        if context.runtime_epoch.is_empty() {
            context.runtime_epoch = epoch.into();
        }
        Ok(WorkspaceAccess {
            authorization: self.clone(),
            context,
            recovery_generation: principal.recovery_generation,
            action: principal.action,
            target: target.into(),
            receipt: Arc::new(Mutex::new(String::new())),
        })
    }

    pub(crate) fn agent_access(
        &self,
        principal: &Principal,
        agent: &MicroVM,
        target: &str,
    ) -> Result<WorkspaceAccess, Status> {
        self.access(
            principal,
            &agent
                .uid()
                .ok_or_else(|| Status::unavailable("workspace UID unavailable"))?,
            &agent.spec.runtime_epoch,
            target,
        )
    }

    pub(crate) async fn reservation(
        &self,
        principal: &Principal,
        id: &str,
    ) -> Result<ofz::proto::GetWorkspaceReservationResponse, Status> {
        match self {
            Self::Ofz(client) => client.reservation(principal, id).await,
            #[cfg(test)]
            _ => Err(Status::unavailable("reservation fixture must provide Ofz")),
        }
    }

    pub(crate) async fn removal_complete(&self, uid: &str) -> Result<bool, Status> {
        match self {
            Self::Ofz(client) => {
                let state = match client.workspace_state(uid).await {
                    Ok(state) => state,
                    Err(error) if error.code() == tonic::Code::NotFound => return Ok(false),
                    Err(error) => return Err(error),
                };
                Ok(state.workspace_uid == uid
                    && state.state == "removed"
                    && !state.running
                    && !state.runtime_allowed)
            }
            #[cfg(test)]
            _ => Ok(false),
        }
    }

    pub(crate) async fn runtime_state(
        &self,
        agent: &MicroVM,
    ) -> Result<ofz::proto::GetWorkspaceStateResponse, Status> {
        match self {
            Self::Ofz(client) => {
                client
                    .workspace_state(
                        &agent
                            .uid()
                            .ok_or_else(|| Status::unavailable("workspace UID required"))?,
                    )
                    .await
            }
            #[cfg(test)]
            Self::ControlledFixture(mode)
                if mode.load(std::sync::atomic::Ordering::SeqCst) == 5 =>
            {
                Err(Status::not_found("workspace not enrolled"))
            }
            #[cfg(test)]
            Self::ControlledFixture(mode)
                if (6..=9).contains(&mode.load(std::sync::atomic::Ordering::SeqCst)) =>
            {
                let mode = mode.load(std::sync::atomic::Ordering::SeqCst);
                let slot = agent.spec.slot.as_ref().expect("bound runtime fixture");
                Ok(ofz::proto::GetWorkspaceStateResponse {
                    workspace_uid: agent.uid().expect("runtime fixture UID"),
                    owner_id: agent.spec.owner_hash.clone(),
                    home_uid: slot.pvc_uid.clone(),
                    reservation_id: agent.spec.reservation_id.clone(),
                    home_bytes: 32 << 30,
                    runtime_epoch: if mode == 8 {
                        "22222222-2222-4222-8222-222222222222".into()
                    } else {
                        agent.spec.runtime_epoch.clone()
                    },
                    running: mode != 7,
                    state: if mode == 7 { "quarantined" } else { "active" }.into(),
                    runtime_allowed: mode != 7,
                    recovery_generation: 1,
                    valid_until_unix_ms: if mode == 9 {
                        ofz::now_ms()? - 1
                    } else {
                        ofz::now_ms()? + 2000
                    },
                    audit_receipt_id: "33333333-3333-4333-8333-333333333333".into(),
                    policy_version: agent.spec.policy_version,
                })
            }
            #[cfg(test)]
            _ => Err(Status::unavailable("runtime fixture must provide Ofz")),
        }
    }

    pub(crate) async fn ready(&self) -> anyhow::Result<()> {
        match self {
            #[cfg(test)]
            Self::SynchronizedFixture(barrier) => {
                barrier.wait().await;
            }
            Self::Ofz(client) => {
                let state = client.state().await?;
                anyhow::ensure!(
                    !state.fenced && state.archive_healthy,
                    "Ofz authority is fenced"
                );
            }
            #[cfg(test)]
            Self::ControlledFixture(mode)
                if mode.load(std::sync::atomic::Ordering::SeqCst) == 4 =>
            {
                anyhow::bail!("Ofz unavailable")
            }
            #[cfg(test)]
            _ => {}
        }
        Ok(())
    }

    pub(crate) async fn begin_enrollment(&self, agent: &MicroVM) -> anyhow::Result<()> {
        match self {
            Self::Ofz(client) => {
                let uid = agent
                    .uid()
                    .ok_or_else(|| anyhow::anyhow!("workspace UID required"))?;
                client
                    .command(
                        &ofz::operation_id(&uid, "begin-enrollment"),
                        Command::BeginWorkspaceEnrollment(BeginWorkspaceEnrollment {
                            reservation_id: agent.spec.reservation_id.clone(),
                            workspace_uid: uid,
                            owner_id: agent.spec.owner_hash.clone(),
                        }),
                    )
                    .await?;
            }
            #[cfg(test)]
            Self::ControlledFixture(mode)
                if mode.load(std::sync::atomic::Ordering::SeqCst) == 5 =>
            {
                return Err(Status::failed_precondition("workspace reservation expired").into());
            }
            #[cfg(test)]
            _ => {}
        }
        Ok(())
    }

    pub(crate) async fn enroll(&self, agent: &MicroVM) -> anyhow::Result<()> {
        match self {
            Self::Ofz(client) => {
                let uid = agent
                    .uid()
                    .ok_or_else(|| anyhow::anyhow!("workspace UID required"))?;
                let home = agent
                    .spec
                    .slot
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("retained home binding required"))?;
                let operation = ofz::operation_id(&uid, "enroll");
                client
                    .command(
                        &operation,
                        Command::EnrollWorkspace(EnrollWorkspace {
                            workspace_uid: uid,
                            owner_id: agent.spec.owner_hash.clone(),
                            home_uid: home.pvc_uid.clone(),
                            home_bytes: 32 * 1024 * 1024 * 1024,
                            reservation_id: agent.spec.reservation_id.clone(),
                        }),
                    )
                    .await?;
            }
            #[cfg(test)]
            Self::ControlledFixture(mode)
                if mode.load(std::sync::atomic::Ordering::SeqCst) == 4 =>
            {
                anyhow::bail!("Ofz unavailable")
            }
            #[cfg(test)]
            _ => {}
        }
        Ok(())
    }

    pub(crate) async fn stop_runtime(&self, agent: &MicroVM) -> anyhow::Result<()> {
        let client = match self {
            Self::Ofz(client) => client,
            #[cfg(test)]
            _ => return Ok(()),
        };
        {
            let uid = agent
                .uid()
                .ok_or_else(|| anyhow::anyhow!("workspace UID required"))?;
            if !agent.spec.runtime_epoch.is_empty() {
                client
                    .command(
                        &ofz::operation_id(&uid, &format!("stop/{}", agent.spec.runtime_epoch)),
                        Command::SetWorkspaceRuntime(SetWorkspaceRuntime {
                            workspace_uid: uid,
                            running: false,
                            runtime_epoch: agent.spec.runtime_epoch.clone(),
                        }),
                    )
                    .await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn complete_removal(&self, agent: &MicroVM) -> anyhow::Result<()> {
        let client = match self {
            Self::Ofz(client) => client,
            #[cfg(test)]
            _ => return Ok(()),
        };
        {
            let uid = agent
                .uid()
                .ok_or_else(|| anyhow::anyhow!("workspace UID required"))?;
            let home = agent
                .spec
                .slot
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("retained home binding required"))?;
            client
                .command(
                    &ofz::operation_id(&uid, "removed"),
                    Command::CompleteWorkspaceRemoval(CompleteWorkspaceRemoval {
                        workspace_uid: uid,
                        home_uid: home.pvc_uid.clone(),
                        reservation_id: agent.spec.reservation_id.clone(),
                    }),
                )
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn require_removing(&self, agent: &MicroVM) -> anyhow::Result<bool> {
        match self {
            Self::Ofz(client) => {
                let state = match client
                    .workspace_state(
                        &agent
                            .uid()
                            .ok_or_else(|| anyhow::anyhow!("workspace UID required"))?,
                    )
                    .await
                {
                    Ok(state) => state,
                    Err(error) if error.code() == tonic::Code::NotFound => return Ok(false),
                    Err(error) => return Err(error.into()),
                };
                let home = agent
                    .spec
                    .slot
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("retained home binding required"))?;
                anyhow::ensure!(
                    state.home_uid == home.pvc_uid
                        && state.reservation_id == agent.spec.reservation_id,
                    "approved removal home or reservation changed"
                );
                anyhow::ensure!(
                    matches!(state.state.as_str(), "removing" | "removed")
                        && !state.running
                        && !state.runtime_allowed,
                    "approved workspace removal required before cleanup"
                );
            }
            #[cfg(test)]
            Self::ControlledFixture(mode)
                if mode.load(std::sync::atomic::Ordering::SeqCst) == 5 =>
            {
                return Ok(false);
            }
            #[cfg(test)]
            Self::ControlledFixture(mode)
                if mode.load(std::sync::atomic::Ordering::SeqCst) == 4 =>
            {
                anyhow::bail!("Ofz unavailable")
            }
            #[cfg(test)]
            _ => {}
        }
        Ok(true)
    }

    pub(crate) async fn release_reservation(&self, agent: &MicroVM) -> anyhow::Result<()> {
        match self {
            Self::Ofz(client) => {
                client
                    .command(
                        &ofz::operation_id(&agent.spec.reservation_id, "cancel"),
                        Command::ReleaseReservation(crate::ofz::proto::ReleaseReservation {
                            reservation_id: agent.spec.reservation_id.clone(),
                        }),
                    )
                    .await?;
            }
            #[cfg(test)]
            Self::ControlledFixture(mode)
                if mode.load(std::sync::atomic::Ordering::SeqCst) == 4 =>
            {
                anyhow::bail!("Ofz unavailable")
            }
            #[cfg(test)]
            _ => {}
        }
        Ok(())
    }
}

impl WorkspaceAccess {
    pub(crate) async fn require(&self) -> Result<(), Status> {
        self.decision().await.map(|_| ())
    }

    pub(crate) async fn guest_decision(
        &self,
        action: Action,
        target: &str,
        uid: &str,
        epoch: &str,
    ) -> Result<(RequestContext, ofz::proto::CheckResponse), Status> {
        if self.context.workspace_uid != uid || self.context.runtime_epoch != epoch {
            return Err(Status::permission_denied(
                "guest runtime differs from its Ofz authority",
            ));
        }
        let parent = self.decision().await?;
        if self.action == action && self.target == target {
            return Ok((self.context.clone(), parent));
        }
        // A compound controller operation does not confer authority for its guest sub-operations.
        let mut context = self.context.clone();
        context.deadline_unix_ms = ofz::now_ms()? + ofz::AUDITED_REQUEST_BUDGET_MS;
        let operation = Self {
            context: context.clone(),
            action,
            target: target.into(),
            receipt: Arc::new(Mutex::new(String::new())),
            ..self.clone()
        };
        let mut decision = operation.decision().await?;
        let parent = self.decision().await?;
        decision.valid_until_unix_ms = decision.valid_until_unix_ms.min(parent.valid_until_unix_ms);
        if decision.valid_until_unix_ms <= ofz::now_ms()? {
            return Err(Status::deadline_exceeded(
                "compound guest authorization expired",
            ));
        }
        Ok((context, decision))
    }

    pub(crate) async fn probe(
        &self,
        uid: &str,
        epoch: &str,
    ) -> Result<ofz::proto::CheckResponse, Status> {
        if self.context.workspace_uid != uid || self.context.runtime_epoch != epoch {
            return Err(Status::permission_denied("guest probe runtime changed"));
        }
        self.require().await?;
        self.authorization
            .guest_maintenance(uid, epoch, ofz::proto::GuestMaintenancePurpose::Probe, "")
            .await
    }

    async fn decision(&self) -> Result<ofz::proto::CheckResponse, Status> {
        match &self.authorization {
            WorkspaceAuthorization::Ofz(client) => {
                let mut receipt = self.receipt.lock().await;
                let mut context = self.context.clone();
                let now = ofz::now_ms()?;
                if receipt.is_empty() && context.deadline_unix_ms <= now {
                    return Err(Status::deadline_exceeded(
                        "workspace authorization submission expired",
                    ));
                }
                let decision_deadline = now
                    + if receipt.is_empty() {
                        ofz::AUDITED_REQUEST_BUDGET_MS
                    } else {
                        2000
                    };
                context.deadline_unix_ms = decision_deadline;
                let decision = client
                    .check(
                        context.clone(),
                        self.action,
                        Resource {
                            kind: ResourceKind::Workspace as i32,
                            id: context.workspace_uid,
                        },
                        self.target.clone(),
                        receipt.clone(),
                        self.recovery_generation,
                    )
                    .await?;
                *receipt = decision.audit_receipt_id.clone();
                Ok(decision)
            }
            #[cfg(test)]
            WorkspaceAuthorization::ControlledFixture(mode) => {
                match mode.load(std::sync::atomic::Ordering::SeqCst) {
                    0 => self.fixture_decision(),
                    1 => Err(Status::permission_denied("workspace action denied")),
                    _ => Err(Status::unavailable("Ofz authority unavailable")),
                }
            }
            #[cfg(test)]
            WorkspaceAuthorization::SynchronizedFixture(barrier) => {
                barrier.wait().await;
                self.fixture_decision()
            }
            #[cfg(test)]
            WorkspaceAuthorization::Fixture => self.fixture_decision(),
            #[cfg(test)]
            WorkspaceAuthorization::ExactFixture { action, target } => {
                if self.action == *action && self.target == *target {
                    self.fixture_decision()
                } else {
                    Err(Status::permission_denied("workspace operation denied"))
                }
            }
        }
    }

    #[cfg(test)]
    fn fixture_decision(&self) -> Result<ofz::proto::CheckResponse, Status> {
        Ok(ofz::proto::CheckResponse {
            allowed: true,
            revision: "fixture".into(),
            audit_receipt_id: "66666666-6666-4666-8666-666666666666".into(),
            valid_until_unix_ms: ofz::now_ms()? + 2000,
            recovery_generation: self.recovery_generation,
            effective_scope: None,
        })
    }

    pub(crate) async fn revoked(&self) -> Status {
        loop {
            sleep(REVOCATION_INTERVAL).await;
            if let Err(error) = self.require().await {
                return error;
            }
        }
    }

    pub(crate) fn guard_stream<T: Send + 'static>(
        &self,
        stream: impl Stream<Item = Result<T, Status>> + Send + 'static,
    ) -> Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>> {
        let access = self.clone();
        Box::pin(try_stream! {
            access.require().await?;
            let revoked = access.revoked();
            tokio::pin!(revoked);
            let mut stream = Box::pin(stream);
            loop {
                let event = tokio::select! { biased; error = &mut revoked => Some(Err(error)), event = stream.next() => event };
                let Some(event) = event else { break };
                yield event?;
            }
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[tokio::test]
    async fn guest_suboperations_refresh_parent_after_their_audit() {
        let uid = "11111111-1111-4111-8111-111111111111";
        let principal = Principal::fixture(&"a".repeat(64), uid, Action::TerminalControl);
        let epoch = principal.context.runtime_epoch.clone();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let access = WorkspaceAuthorization::SynchronizedFixture(barrier.clone())
            .access(&principal, uid, &epoch, "terminal-parent")
            .unwrap();
        let mut operation = tokio::spawn(async move {
            access
                .guest_decision(Action::TerminalObserve, "", uid, &epoch)
                .await
        });
        barrier.wait().await;
        tokio::task::yield_now().await;
        sleep(Duration::from_millis(2100)).await;
        barrier.wait().await;
        let result = tokio::select! {
            result = &mut operation => result.unwrap(),
            _ = barrier.wait() => operation.await.unwrap(),
        };
        let (context, decision) = result.unwrap();
        assert!(decision.valid_until_unix_ms > ofz::now_ms().unwrap());
        assert!(decision.valid_until_unix_ms <= context.deadline_unix_ms);
    }

    #[tokio::test]
    async fn guest_suboperations_require_both_parent_and_exact_operation_permissions() {
        let uid = "11111111-1111-4111-8111-111111111111";
        let principal = Principal::fixture(&"a".repeat(64), uid, Action::TerminalControl);
        let epoch = &principal.context.runtime_epoch;
        for (action, target) in [
            (Action::TerminalControl, "terminal-parent"),
            (Action::TerminalObserve, ""),
            (Action::TerminalControl, "terminal-other"),
        ] {
            let authorization = WorkspaceAuthorization::ExactFixture {
                action,
                target: target.into(),
            };
            let access = authorization
                .access(&principal, uid, epoch, "terminal-parent")
                .unwrap();
            for (action, target) in [
                (Action::TerminalObserve, ""),
                (Action::TerminalControl, "terminal-other"),
            ] {
                assert_eq!(
                    access
                        .guest_decision(action, target, uid, epoch)
                        .await
                        .unwrap_err()
                        .code(),
                    tonic::Code::PermissionDenied,
                    "a permission for only the parent or only its sub-operation cannot authorize a compound operation"
                );
            }
        }
        let access = WorkspaceAuthorization::Fixture
            .access(&principal, uid, epoch, "terminal-parent")
            .unwrap();
        let (context, decision) = access
            .guest_decision(Action::TerminalObserve, "", uid, epoch)
            .await
            .unwrap();
        assert_eq!(context.actor, principal.context.actor);
        assert_eq!(context.session_id, principal.context.session_id);
        assert!(decision.valid_until_unix_ms <= context.deadline_unix_ms);
        for (uid, epoch) in [
            ("22222222-2222-4222-8222-222222222222", epoch.as_str()),
            (uid, "33333333-3333-4333-8333-333333333333"),
        ] {
            assert_eq!(
                access
                    .guest_decision(Action::TerminalObserve, "", uid, epoch)
                    .await
                    .unwrap_err()
                    .code(),
                tonic::Code::PermissionDenied
            );
        }
    }

    pub struct OfzFixture {
        pub authorization: WorkspaceAuthorization,
        pub mode: Arc<std::sync::atomic::AtomicU8>,
    }
    impl OfzFixture {
        pub async fn new() -> Self {
            let mode = Arc::new(std::sync::atomic::AtomicU8::new(0));
            Self {
                authorization: WorkspaceAuthorization::ControlledFixture(mode.clone()),
                mode,
            }
        }
    }
}
