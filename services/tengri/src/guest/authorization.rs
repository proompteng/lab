use std::{path::Path, sync::Arc};

use kube::ResourceExt;
use tengri::guest_authorization::{
    GuestActor, GuestContext, GuestProof, GuestSigner, MaintenancePurpose, ObservationBudget,
    PROTOCOL_VERSION, body_sha256, request_action,
};
use tonic::Status;
use uuid::Uuid;

use crate::{
    authz::{WorkspaceAccess, WorkspaceAuthorization},
    control::{Database, Fence},
    crd::MicroVM,
    ofz::{
        self,
        proto::{self as authz, actor::Identity},
    },
    slot::Claim,
};

#[derive(Clone)]
pub struct GuestAuthority {
    signer: GuestSigner,
    recovery_generation: u64,
    database: AuthorityDatabase,
    pub(crate) authorization: WorkspaceAuthorization,
}

#[derive(Clone)]
enum AuthorityDatabase {
    Shared(Arc<Database>),
    #[cfg(test)]
    Fixture,
}

#[derive(Clone)]
enum Source {
    Probe,
    User(Arc<WorkspaceAccess>),
    Cleanup {
        terminal_id: String,
    },
    #[cfg(test)]
    Fixture,
}

#[derive(Clone)]
pub struct GuestAuthorization {
    authority: GuestAuthority,
    source: Source,
}

#[derive(Clone)]
pub(super) struct GuestRequestIssuer {
    authority: GuestAuthority,
    activity: Option<crate::activity::ActivityTracker>,
    source: Source,
    claim: Claim,
    pod_uid: String,
}

impl GuestAuthority {
    pub fn new(
        path: &Path,
        recovery_generation: u64,
        database: Arc<Database>,
        authorization: WorkspaceAuthorization,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            recovery_generation > 0 && recovery_generation <= i64::MAX as u64,
            "positive guest signing recovery generation required"
        );
        Ok(Self {
            signer: GuestSigner::from_file(path)?,
            recovery_generation,
            database: AuthorityDatabase::Shared(database),
            authorization,
        })
    }

    pub(crate) fn user(&self, access: WorkspaceAccess) -> GuestAuthorization {
        GuestAuthorization {
            authority: self.clone(),
            source: Source::User(Arc::new(access)),
        }
    }

    pub(crate) fn probe(&self) -> GuestAuthorization {
        GuestAuthorization {
            authority: self.clone(),
            source: Source::Probe,
        }
    }

    pub(crate) fn cleanup(&self, terminal_id: &str) -> GuestAuthorization {
        GuestAuthorization {
            authority: self.clone(),
            source: Source::Cleanup {
                terminal_id: terminal_id.into(),
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self::fixture_with_authorization(WorkspaceAuthorization::Fixture)
    }

    #[cfg(test)]
    pub(crate) fn fixture_with_authorization(authorization: WorkspaceAuthorization) -> Self {
        let seed: [u8; 32] = std::array::from_fn(|index| index as u8);
        Self {
            signer: GuestSigner::from_seed(&seed).unwrap(),
            recovery_generation: 1,
            database: AuthorityDatabase::Fixture,
            authorization,
        }
    }

    #[cfg(test)]
    pub(crate) fn fixture_authorization() -> GuestAuthorization {
        GuestAuthorization {
            authority: Self::fixture(),
            source: Source::Fixture,
        }
    }
}

impl GuestAuthorization {
    pub(super) fn bind(self, agent: &MicroVM) -> Result<GuestRequestIssuer, Status> {
        let claim = crate::slot::client::claim_for(agent)
            .map_err(|_| Status::unavailable("guest runtime claim unavailable"))?;
        let pod_uid = agent
            .spec
            .slot
            .as_ref()
            .ok_or_else(|| Status::unavailable("guest slot unavailable"))?
            .pod_uid
            .clone();
        if agent.uid().as_deref() != Some(&claim.microvm_uid)
            || agent.spec.runtime_epoch != claim.runtime_epoch
        {
            return Err(Status::permission_denied(
                "guest runtime differs from its workspace",
            ));
        }
        Ok(GuestRequestIssuer {
            activity: None,
            authority: self.authority,
            source: self.source,
            claim,
            pod_uid,
        })
    }

    #[cfg(test)]
    pub(super) fn fixture_issuer() -> GuestRequestIssuer {
        GuestRequestIssuer {
            activity: None,
            authority: GuestAuthority::fixture(),
            source: Source::Fixture,
            claim: Claim {
                microvm_id: "fixture".into(),
                microvm_uid: "11111111-1111-4111-8111-111111111111".into(),
                epoch: 7,
                runtime_epoch: "22222222-2222-4222-8222-222222222222".into(),
            },
            pod_uid: "33333333-3333-4333-8333-333333333333".into(),
        }
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn fixture_for_runtime(
        claim: Claim,
        pod_uid: String,
        database: Arc<Database>,
    ) -> GuestRequestIssuer {
        let mut authority = GuestAuthority::fixture();
        authority.database = AuthorityDatabase::Shared(database);
        GuestRequestIssuer {
            activity: None,
            authority,
            source: Source::Fixture,
            claim,
            pod_uid,
        }
    }
}

impl GuestRequestIssuer {
    pub(super) fn with_activity(mut self, activity: crate::activity::ActivityTracker) -> Self {
        self.activity = Some(activity);
        self
    }

    pub(super) fn claim(&self) -> &Claim {
        &self.claim
    }

    async fn fence(&self) -> Result<Fence, Status> {
        match &self.authority.database {
            AuthorityDatabase::Shared(database) => database.current_fence().await,
            #[cfg(test)]
            AuthorityDatabase::Fixture => Ok(Fence {
                owner: Uuid::parse_str("55555555-5555-4555-8555-555555555555").unwrap(),
                generation: 2,
            }),
        }
    }

    pub(super) async fn sign(
        &self,
        method: &str,
        target: &str,
        body: &[u8],
    ) -> Result<(GuestProof, Fence), Status> {
        let action = request_action(method)
            .ok_or_else(|| Status::permission_denied("unknown guest request"))?;
        let actor;
        let decision;
        let mut control = false;
        let probe =
            method == "/proompteng.runtime.guest.v1.NanoagentService/GetInfo" && target.is_empty();
        match &self.source {
            Source::User(access) if !probe => {
                let name = serde_json::to_value(action)
                    .map_err(|_| Status::internal("encode guest action"))?;
                let action = authz::Action::from_str_name(name.as_str().unwrap_or_default())
                    .ok_or_else(|| Status::permission_denied("unknown Ofz guest action"))?;
                control = crate::authz::is_control(action);
                let (context, checked) = access
                    .guest_decision(
                        action,
                        target,
                        &self.claim.microvm_uid,
                        &self.claim.runtime_epoch,
                    )
                    .await?;
                actor = match context.actor.and_then(|actor| actor.identity) {
                    Some(Identity::HumanId(subject)) => GuestActor::Human {
                        subject,
                        session_id: context.session_id,
                    },
                    Some(Identity::AgentId(subject)) => GuestActor::Agent {
                        subject,
                        grant_id: context.grant_id,
                    },
                    _ => {
                        return Err(Status::permission_denied(
                            "guest content requires a user or delegated agent",
                        ));
                    }
                };
                decision = checked;
            }
            Source::User(access) => {
                decision = access
                    .probe(&self.claim.microvm_uid, &self.claim.runtime_epoch)
                    .await?;
                actor = GuestActor::Workload {
                    subject: ofz::CONTROLLER_ID.into(),
                    purpose: MaintenancePurpose::Probe,
                };
            }
            Source::Probe => {
                if !probe {
                    return Err(Status::permission_denied(
                        "probe cannot authorize guest content",
                    ));
                }
                decision = self
                    .authority
                    .authorization
                    .guest_maintenance(
                        &self.claim.microvm_uid,
                        &self.claim.runtime_epoch,
                        authz::GuestMaintenancePurpose::Probe,
                        "",
                    )
                    .await?;
                actor = GuestActor::Workload {
                    subject: ofz::CONTROLLER_ID.into(),
                    purpose: MaintenancePurpose::Probe,
                };
            }
            Source::Cleanup { terminal_id } => {
                let purpose = if probe {
                    authz::GuestMaintenancePurpose::Probe
                } else if method
                    == "/proompteng.runtime.guest.v1.NanoagentService/TerminateTerminal"
                    && target == terminal_id
                {
                    authz::GuestMaintenancePurpose::TerminalCleanup
                } else {
                    return Err(Status::permission_denied(
                        "cleanup cannot authorize this guest operation",
                    ));
                };
                decision = self
                    .authority
                    .authorization
                    .guest_maintenance(
                        &self.claim.microvm_uid,
                        &self.claim.runtime_epoch,
                        purpose,
                        if probe { "" } else { terminal_id },
                    )
                    .await?;
                actor = GuestActor::Workload {
                    subject: ofz::CONTROLLER_ID.into(),
                    purpose: if probe {
                        MaintenancePurpose::Probe
                    } else {
                        MaintenancePurpose::TerminalCleanup
                    },
                };
            }
            #[cfg(test)]
            Source::Fixture => {
                actor = GuestActor::Human {
                    subject: "a".repeat(64),
                    session_id: "44444444-4444-4444-8444-444444444444".into(),
                };
                decision = authz::CheckResponse {
                    allowed: true,
                    revision: "fixture".into(),
                    audit_receipt_id: "66666666-6666-4666-8666-666666666666".into(),
                    valid_until_unix_ms: ofz::now_ms()? + 2000,
                    recovery_generation: 1,
                    effective_scope: None,
                };
            }
        }
        if decision.recovery_generation != self.authority.recovery_generation {
            return Err(Status::permission_denied(
                "guest signing key belongs to a different recovery generation",
            ));
        }
        let fence = self.fence().await?;
        let admission_deadline = if control {
            let at = self
                .activity
                .as_ref()
                .ok_or_else(|| Status::unavailable("guest control admission unavailable"))?
                .admit_control(&self.claim)
                .await?;
            // A delayed API response must not mint fresh authority after its
            // activity interval. Guest verification enforces this same deadline.
            (at.timestamp_millis() as u64).saturating_add(5000)
        } else {
            u64::MAX
        };
        let now = ofz::now_ms()?;
        let context = GuestContext {
            protocol_version: PROTOCOL_VERSION,
            actor,
            action,
            workspace_uid: self.claim.microvm_uid.clone(),
            runtime_epoch: self.claim.runtime_epoch.clone(),
            slot_epoch: self.claim.epoch,
            pod_uid: self.pod_uid.clone(),
            leader_owner: fence.owner.to_string(),
            leader_generation: fence.generation as u64,
            recovery_generation: decision.recovery_generation,
            audit_receipt_id: decision.audit_receipt_id,
            method: method.into(),
            target: target.into(),
            body_sha256: body_sha256(body),
            issued_at_unix_ms: now,
            deadline_unix_ms: decision
                .valid_until_unix_ms
                .min(now + 5000)
                .min(admission_deadline),
            nonce: Uuid::new_v4().to_string(),
            observation: decision.effective_scope.map(|scope| ObservationBudget {
                max_bytes: scope.max_bytes,
                max_items: scope.max_items,
            }),
        };
        let proof = self
            .authority
            .signer
            .sign(&context, now)
            .map_err(|_| Status::permission_denied("invalid or expired guest authority"))?;
        Ok((proof, fence))
    }

    pub(super) async fn recheck(&self, fence: Fence) -> Result<(), Status> {
        match &self.authority.database {
            AuthorityDatabase::Shared(database) => database.require_fence(fence).await?,
            #[cfg(test)]
            AuthorityDatabase::Fixture => {}
        }
        match &self.source {
            Source::User(access) => access.require().await,
            Source::Probe => self
                .authority
                .authorization
                .guest_maintenance(
                    &self.claim.microvm_uid,
                    &self.claim.runtime_epoch,
                    authz::GuestMaintenancePurpose::Probe,
                    "",
                )
                .await
                .map(|_| ()),
            Source::Cleanup { terminal_id } => self
                .authority
                .authorization
                .guest_maintenance(
                    &self.claim.microvm_uid,
                    &self.claim.runtime_epoch,
                    authz::GuestMaintenancePurpose::TerminalCleanup,
                    terminal_id,
                )
                .await
                .map(|_| ()),
            #[cfg(test)]
            Source::Fixture => Ok(()),
        }
    }
}
