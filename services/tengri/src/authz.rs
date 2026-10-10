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
            Action, CompleteWorkspaceRemoval, EnrollWorkspace, RequestContext, Resource,
            ResourceKind, SetWorkspaceRuntime, execute_command_request::Command,
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
        let mut context = principal.context.clone();
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
            _ => Err(Status::unavailable("runtime fixture must provide Ofz")),
        }
    }

    pub(crate) async fn ready(&self) -> anyhow::Result<()> {
        match self {
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
        match &self.authorization {
            WorkspaceAuthorization::Ofz(client) => {
                let mut receipt = self.receipt.lock().await;
                let mut context = self.context.clone();
                let decision_deadline = ofz::now_ms()? + 2000;
                context.deadline_unix_ms = if receipt.is_empty() {
                    self.context.deadline_unix_ms.min(decision_deadline)
                } else {
                    decision_deadline
                };
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
                *receipt = decision.audit_receipt_id;
            }
            #[cfg(test)]
            WorkspaceAuthorization::ControlledFixture(mode) => {
                match mode.load(std::sync::atomic::Ordering::SeqCst) {
                    0 => {}
                    1 => return Err(Status::permission_denied("workspace action denied")),
                    _ => return Err(Status::unavailable("Ofz authority unavailable")),
                }
            }
            #[cfg(test)]
            WorkspaceAuthorization::Fixture => {}
        }
        Ok(())
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
