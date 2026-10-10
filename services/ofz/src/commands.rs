use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_postgres::{Client, GenericClient};
use tonic::Status;
use uuid::Uuid;

use crate::{
    decision::{self, parse_uuid},
    native::{Check, Native, Relationship, Update},
    policy::{self, BFF_ID, CONTROLLER_ID},
    proto::{
        Action, CommandReceipt, CommandState, ExecuteCommandRequest, PlatformRole, Resource,
        ResourceKind, WorkspaceRole, execute_command_request::Command,
    },
    store::{self, Database, State, sql_error},
};

pub(crate) const HOME_BYTES: u64 = 32 * 1024 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
pub struct Prepared {
    request: ExecuteCommandRequest,
    pub(crate) changes: Vec<Update>,
    previous_owner: Option<String>,
    grant_hash: Option<Vec<u8>>,
    recovery_generation: u64,
    action: i32,
    resource: Resource,
    audit_id: String,
    emergency_activated: bool,
}

fn relation(kind: &str, id: &str, role: &str, human: &str, enabled: bool) -> Update {
    let relationship = Relationship::new(kind, id, role, "human", human);
    if enabled {
        Update::touch(relationship)
    } else {
        Update::delete(relationship)
    }
}

fn member_role(role: i32) -> Result<&'static str, Status> {
    match PlatformRole::try_from(role) {
        Ok(PlatformRole::Member) => Ok("member"),
        Ok(PlatformRole::Administrator) => Ok("administrator"),
        Ok(PlatformRole::Auditor) => Ok("auditor"),
        Ok(PlatformRole::Operator) => Ok("operator"),
        _ => Err(Status::invalid_argument("explicit platform role required")),
    }
}

fn collaborator_role(role: i32) -> Result<&'static str, Status> {
    match WorkspaceRole::try_from(role) {
        Ok(WorkspaceRole::Developer) => Ok("developer"),
        Ok(WorkspaceRole::Viewer) => Ok("viewer"),
        _ => Err(Status::invalid_argument(
            "use ownership transfer to change the owner",
        )),
    }
}

fn valid_human(id: &str) -> Result<(), Status> {
    if policy::canonical_human_id(id) {
        Ok(())
    } else {
        Err(Status::invalid_argument("canonical human ID required"))
    }
}

async fn active_member<C: GenericClient + Sync>(client: &C, id: &str) -> Result<(), Status> {
    valid_human(id)?;
    if client
        .query_opt(
            "SELECT 1 FROM ofz.memberships WHERE human_id=$1 AND role=1",
            &[&id],
        )
        .await
        .map_err(sql_error)?
        .is_none()
    {
        return Err(Status::failed_precondition(
            "active platform member required",
        ));
    }
    Ok(())
}

async fn owner<C: GenericClient + Sync>(client: &C, uid: &str) -> Result<String, Status> {
    let uid = parse_uuid(uid)?;
    let row = client
        .query_opt(
            "SELECT owner_id FROM ofz.workspaces WHERE uid=$1 AND state<>'removed'",
            &[&uid],
        )
        .await
        .map_err(sql_error)?
        .ok_or_else(|| Status::permission_denied("access denied"))?;
    Ok(row.get(0))
}

fn command_target(command: &Command) -> Result<(Action, Resource, bool), Status> {
    let result = match command {
        Command::SetMembership(c) => (Action::MembersManage, policy::platform(), !c.enabled),
        Command::SetWorkspaceRole(c) => (
            Action::CollaboratorsManage,
            policy::workspace(&c.workspace_uid),
            !c.enabled,
        ),
        Command::TransferWorkspace(c) => (
            Action::WorkspaceTransfer,
            policy::workspace(&c.workspace_uid),
            false,
        ),
        Command::CreateGrant(c) => (
            Action::GrantsManage,
            policy::workspace(&c.workspace_uid),
            false,
        ),
        Command::RevokeGrant(_) => {
            return Err(Status::internal("grant command requires stored target"));
        }
        Command::SetTargetAccess(c) => (Action::TargetsManage, policy::platform(), !c.enabled),
        Command::SetQuota(_) => (Action::QuotasManage, policy::platform(), false),
        Command::EnrollWorkspace(_) => (Action::WorkspaceEnroll, policy::platform(), false),
        Command::RemoveWorkspace(c) => (
            Action::WorkspaceDelete,
            policy::workspace(&c.workspace_uid),
            true,
        ),
        Command::EmergencyAccess(_) => (Action::MembersManage, policy::platform(), false),
        Command::ReserveWorkspace(_) => (Action::WorkspaceCreate, policy::platform(), false),
        Command::ReleaseReservation(_) => (Action::WorkspaceEnroll, policy::platform(), true),
        Command::SetWorkspaceRuntime(c) => (
            if c.running {
                Action::WorkspaceResume
            } else {
                Action::WorkspaceSleep
            },
            policy::workspace(&c.workspace_uid),
            !c.running,
        ),
    };
    Ok(result)
}

pub(crate) fn fingerprint(request: &ExecuteCommandRequest, peer: &str) -> Result<Vec<u8>, Status> {
    let mut canonical = request.clone();
    // Retries have a fresh transport deadline/trace but must preserve actor and session.
    if let Some(context) = canonical.context.as_mut() {
        context.deadline_unix_ms = 0;
        context.trace_id.clear();
    }
    let mut hash = Sha256::new();
    hash.update(peer.as_bytes());
    hash.update(
        serde_json::to_vec(&canonical)
            .map_err(|_| Status::internal("encode command fingerprint"))?,
    );
    Ok(hash.finalize().to_vec())
}

pub async fn execute(
    database: &Database,
    native: &Native,
    peer: &str,
    request: ExecuteCommandRequest,
) -> Result<CommandReceipt, Status> {
    decision::workload(native, peer, Action::PolicyCommand).await?;
    let operation = parse_uuid(&request.operation_id)?;
    let context = request
        .context
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("context required"))?;
    if context.contract_version != crate::CONTRACT_VERSION {
        return Err(Status::failed_precondition(
            "authorization contract mismatch",
        ));
    }
    let actor = decision::actor_id(context)?;
    let hash = fingerprint(&request, peer)?;
    let mut connection = database.command_connection().await?;
    reconcile(database, native, &mut connection.client).await?;
    if let Some(row) = connection.client.query_opt("SELECT actor_id,workload_id,fingerprint,receipt FROM ofz.commands WHERE operation_id=$1", &[&operation]).await.map_err(sql_error)? {
        if row.get::<_, String>(0) != actor || row.get::<_, String>(1) != peer || row.get::<_, Vec<u8>>(2) != hash {
            return Err(Status::already_exists("operation ID bound to a different command"));
        }
        let state = database.state().await?;
        if context.deadline_unix_ms <= state.now_ms || context.deadline_unix_ms > state.now_ms + 30_000 { return Err(Status::deadline_exceeded("invalid command deadline")); }
        if matches!(context.actor.as_ref().and_then(|a| a.identity.as_ref()), Some(crate::proto::actor::Identity::HumanId(_))) {
            decision::session(database, context, Action::PlatformAdmit, &state).await?;
        } else if context.actor != Some(decision::workload_actor(peer)) { return Err(Status::unauthenticated("invalid authenticated context")); }
        return store::decode(row.get(3));
    }
    if request.reason.trim().len() < 3
        || request.reason.len() > 512
        || request.reason.contains(['\0', '\n', '\r'])
    {
        return Err(Status::invalid_argument("bounded audit reason required"));
    }
    let state = store::state(&connection.client).await?;
    decision::validate_context(context, peer, &state)?;
    if state.version != request.expected_version {
        return Err(Status::aborted("policy version conflict"));
    }
    let submitted = request.clone();
    let (prepared, credential) =
        match prepare(database, native, &connection.client, peer, request, &state).await {
            Ok(prepared) => prepared,
            Err(mut error) => {
                let mut audit = store::receipt(
                    submitted
                        .context
                        .as_ref()
                        .ok_or_else(|| Status::unauthenticated("context required"))?,
                    peer,
                    policy::platform(),
                    Action::PolicyCommand,
                    false,
                    &submitted.operation_id,
                    "policy command rejected",
                );
                audit.policy_command = Some(submitted);
                let id = database.audit(&audit, "").await?;
                error.metadata_mut().insert(
                    "x-ofz-audit-receipt",
                    id.parse()
                        .map_err(|_| Status::internal("invalid audit ID"))?,
                );
                return Err(error);
            }
        };
    persist(&mut connection.client, peer, &prepared, &hash).await?;
    let receipt = apply_pending(native, &mut connection.client, &prepared).await?;
    Ok(CommandReceipt {
        agent_credential: credential.unwrap_or_default(),
        ..receipt
    })
}

pub(crate) async fn prepare(
    database: &Database,
    native: &Native,
    client: &Client,
    peer: &str,
    request: ExecuteCommandRequest,
    state: &State,
) -> Result<(Prepared, Option<String>), Status> {
    let context = request
        .context
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("context required"))?;
    let command = request
        .command
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("typed command required"))?;
    let (action, resource, revoke) = if let Command::RevokeGrant(c) = command {
        let grant = decision::grant(database, &c.grant_id).await?;
        (
            Action::GrantsManage,
            policy::workspace(&grant.workspace_uid),
            true,
        )
    } else {
        command_target(command)?
    };
    let controller_command = matches!(
        command,
        Command::EnrollWorkspace(_) | Command::ReleaseReservation(_)
    ) || matches!(command, Command::SetWorkspaceRuntime(c) if !c.running);
    if controller_command {
        if peer != CONTROLLER_ID || context.actor != Some(decision::workload_actor(peer)) {
            return Err(Status::permission_denied("controller command required"));
        }
        decision::workload(native, peer, Action::WorkspaceEnroll).await?;
        if context.deadline_unix_ms <= state.now_ms
            || context.deadline_unix_ms > state.now_ms + 30_000
        {
            return Err(Status::deadline_exceeded("invalid command deadline"));
        }
        if state.fenced && !revoke {
            return Err(Status::unavailable("platform fenced"));
        }
    } else {
        if !matches!(peer, BFF_ID | CONTROLLER_ID) {
            return Err(Status::permission_denied("policy caller denied"));
        }
        decision::human(context)?;
        let (allowed, _, _, _) = decision::evaluate(
            database,
            native,
            peer,
            decision::Evaluation {
                context,
                action,
                resource: &resource,
                target: "",
            },
            revoke,
        )
        .await?;
        if !allowed {
            return Err(Status::permission_denied("access denied"));
        }
    }
    let mut prepared = Prepared {
        request: request.clone(),
        changes: vec![],
        previous_owner: None,
        grant_hash: None,
        recovery_generation: state.recovery_generation,
        action: action as i32,
        resource,
        audit_id: Uuid::new_v4().to_string(),
        emergency_activated: false,
    };
    let mut credential = None;
    match command {
        Command::SetMembership(c) => {
            valid_human(&c.human_id)?;
            let role = member_role(c.role)?;
            if c.enabled && c.role != PlatformRole::Member as i32 {
                active_member(client, &c.human_id).await?;
            }
            if !c.enabled && matches!(c.role, 1 | 2) {
                let count: i64 = client.query_one("SELECT count(*) FROM ofz.memberships a JOIN ofz.memberships m USING(human_id) WHERE a.role=2 AND m.role=1 AND a.human_id<>$1", &[&c.human_id]).await.map_err(sql_error)?.get(0);
                let minimum: i32 = client
                    .query_one("SELECT minimum_administrators FROM ofz.platform_state", &[])
                    .await
                    .map_err(sql_error)?
                    .get(0);
                if count < minimum as i64 {
                    return Err(Status::failed_precondition(
                        "two independent administrators must remain",
                    ));
                }
            }
            prepared
                .changes
                .push(relation("platform", "lab", role, &c.human_id, c.enabled));
        }
        Command::SetWorkspaceRole(c) => {
            let current = owner(client, &c.workspace_uid).await?;
            valid_human(&c.human_id)?;
            if c.human_id == current {
                return Err(Status::failed_precondition(
                    "owner cannot be a collaborator",
                ));
            }
            let role = collaborator_role(c.role)?;
            if c.enabled {
                active_member(client, &c.human_id).await?;
            }
            if let Some(row) = client
                .query_opt(
                    "SELECT role FROM ofz.collaborators WHERE workspace_uid=$1 AND human_id=$2",
                    &[&parse_uuid(&c.workspace_uid)?, &c.human_id],
                )
                .await
                .map_err(sql_error)?
            {
                let previous: i32 = row.get(0);
                prepared.changes.push(relation(
                    "workspace",
                    &c.workspace_uid,
                    collaborator_role(previous)?,
                    &c.human_id,
                    false,
                ));
                // A Developer losing privilege requires quarantine even if converted to Viewer.
                if previous == WorkspaceRole::Developer as i32 && (!c.enabled || c.role != previous)
                {
                    prepared.previous_owner = Some(c.human_id.clone());
                }
            }
            if c.enabled {
                prepared.changes.push(relation(
                    "workspace",
                    &c.workspace_uid,
                    role,
                    &c.human_id,
                    true,
                ));
            }
        }
        Command::TransferWorkspace(c) => {
            active_member(client, &c.next_owner_id).await?;
            let previous = owner(client, &c.workspace_uid).await?;
            if previous == c.next_owner_id {
                return Err(Status::failed_precondition(
                    "workspace already has this owner",
                ));
            }
            let running: bool = client
                .query_one(
                    "SELECT running FROM ofz.workspaces WHERE uid=$1",
                    &[&parse_uuid(&c.workspace_uid)?],
                )
                .await
                .map_err(sql_error)?
                .get(0);
            quota(
                client,
                &c.next_owner_id,
                1,
                i64::from(running),
                HOME_BYTES as i64,
                false,
            )
            .await?;
            prepared.previous_owner = Some(previous.clone());
            prepared.changes.extend([
                relation("workspace", &c.workspace_uid, "owner", &previous, false),
                relation(
                    "workspace",
                    &c.workspace_uid,
                    "owner",
                    &c.next_owner_id,
                    true,
                ),
            ]);
            for role in ["developer", "viewer"] {
                prepared.changes.push(relation(
                    "workspace",
                    &c.workspace_uid,
                    role,
                    &c.next_owner_id,
                    false,
                ));
            }
        }
        Command::CreateGrant(c) => {
            parse_uuid(&c.grant_id)?;
            parse_uuid(&c.agent_id)?;
            let issuer = decision::human(context)?;
            if owner(client, &c.workspace_uid).await? != issuer {
                return Err(Status::permission_denied("only the owner may delegate"));
            }
            decision::active_workspace(database, &c.workspace_uid).await?;
            let expiry = c.expires_at_unix_ms;
            if expiry <= state.now_ms || expiry > state.now_ms + 3_600_000 {
                return Err(Status::invalid_argument(
                    "grant lifetime must be at most one hour",
                ));
            }
            if c.proof_key_thumbprint.len() != 43
                || !c
                    .proof_key_thumbprint
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(Status::invalid_argument("proof-key thumbprint required"));
            }
            let resource = c
                .resource
                .as_ref()
                .ok_or_else(|| Status::invalid_argument("grant resource required"))?;
            let scope = c
                .scope
                .as_ref()
                .ok_or_else(|| Status::invalid_argument("explicit observation scope required"))?;
            if c.actions.is_empty() || c.actions.len() > 16 {
                return Err(Status::invalid_argument(
                    "explicit diagnostic actions required",
                ));
            }
            decision::validate_scope(&c.actions, scope)?;
            let mut checks = vec![];
            for value in &c.actions {
                let action = Action::try_from(*value)
                    .map_err(|_| Status::invalid_argument("unknown grant action"))?;
                let kind = resource.validate_for(action)?;
                if !action.permission()?.diagnostic {
                    return Err(Status::permission_denied("delegation is observation only"));
                }
                if kind == "workspace" && resource.id != c.workspace_uid {
                    return Err(Status::permission_denied("grant workspace mismatch"));
                }
                checks.push(Check::new(
                    kind,
                    &resource.id,
                    action.permission()?.name,
                    "human",
                    issuer,
                ));
            }
            if !native.check(&checks).await?.0 {
                return Err(Status::permission_denied("issuer lacks target permission"));
            }
            if client
                .query_opt(
                    "SELECT 1 FROM ofz.grants WHERE id=$1",
                    &[&parse_uuid(&c.grant_id)?],
                )
                .await
                .map_err(sql_error)?
                .is_some()
            {
                return Err(Status::already_exists("grant ID already used"));
            }
            let mut random = [0_u8; 32];
            rand::rng().fill_bytes(&mut random);
            let token = URL_SAFE_NO_PAD.encode(random);
            prepared.grant_hash = Some(Sha256::digest(token.as_bytes()).to_vec());
            credential = Some(token);
            let mut subject =
                Relationship::new("agent_grant", &c.grant_id, "subject", "agent", &c.agent_id);
            subject.optional_expires_at = Some(
                DateTime::<Utc>::from_timestamp_millis(expiry as i64)
                    .ok_or_else(|| Status::invalid_argument("invalid grant expiry"))?,
            );
            prepared.changes.extend([
                Update::touch(subject),
                relation("agent_grant", &c.grant_id, "issuer", issuer, true),
                Update::touch(Relationship::new(
                    "agent_grant",
                    &c.grant_id,
                    "workspace",
                    "workspace",
                    &c.workspace_uid,
                )),
            ]);
            if resource.kind != ResourceKind::Workspace as i32 {
                let kind = resource.validate_for(
                    Action::try_from(c.actions[0])
                        .map_err(|_| Status::invalid_argument("unknown action"))?,
                )?;
                prepared.changes.push(Update::touch(Relationship::new(
                    "agent_grant",
                    &c.grant_id,
                    kind,
                    kind,
                    &resource.id,
                )));
            }
        }
        Command::RevokeGrant(c) => {
            let grant = decision::grant(database, &c.grant_id).await?;
            prepared.changes.push(Update::delete(Relationship::new(
                "agent_grant",
                &grant.id,
                "subject",
                "agent",
                &grant.agent_id,
            )));
        }
        Command::SetTargetAccess(c) => {
            active_member(client, &c.human_id).await?;
            let target = c
                .resource
                .as_ref()
                .ok_or_else(|| Status::invalid_argument("target required"))?;
            let action = Action::try_from(c.action)
                .map_err(|_| Status::invalid_argument("unknown target action"))?;
            let kind = target.validate_for(action)?;
            let relation_name = match action {
                Action::KubeStatusRead => "status_reader",
                Action::KubeLogsRead => "log_reader",
                Action::KubeEventsRead => "event_reader",
                Action::ConnectorRead => "reader",
                _ => {
                    return Err(Status::invalid_argument(
                        "only reviewed diagnostic targets allowed",
                    ));
                }
            };
            // Eligibility is separately installed by the reviewed catalog migration.
            if !native
                .check(&[Check::new(kind, &target.id, "platform", "platform", "lab")])
                .await?
                .0
            {
                return Err(Status::permission_denied(
                    "target is not in the reviewed catalog",
                ));
            }
            prepared.changes.push(relation(
                kind,
                &target.id,
                relation_name,
                &c.human_id,
                c.enabled,
            ));
        }
        Command::SetQuota(c) => {
            active_member(client, &c.human_id).await?;
            if c.total_workspaces > 6
                || c.active_workspaces > c.total_workspaces
                || c.retained_bytes > 192 * 1024 * 1024 * 1024
            {
                return Err(Status::invalid_argument("quota exceeds fleet ceiling"));
            }
            let (total, active, bytes) = usage(client, Some(&c.human_id)).await?;
            if total > c.total_workspaces as i64
                || active > c.active_workspaces as i64
                || bytes > c.retained_bytes as i64
            {
                return Err(Status::failed_precondition(
                    "quota below current retained usage",
                ));
            }
        }
        Command::ReserveWorkspace(c) => {
            parse_uuid(&c.reservation_id)?;
            if c.home_bytes != HOME_BYTES {
                return Err(Status::invalid_argument(
                    "prepared homes are exactly 32 GiB",
                ));
            }
            let human = decision::human(context)?;
            quota(client, human, 1, 0, c.home_bytes as i64, true).await?;
            if client
                .query_opt(
                    "SELECT 1 FROM ofz.reservations WHERE id=$1",
                    &[&parse_uuid(&c.reservation_id)?],
                )
                .await
                .map_err(sql_error)?
                .is_some()
            {
                return Err(Status::already_exists("reservation ID already used"));
            }
        }
        Command::EnrollWorkspace(c) => {
            parse_uuid(&c.workspace_uid)?;
            parse_uuid(&c.home_uid)?;
            active_member(client, &c.owner_id).await?;
            let row = client
                .query_opt(
                    "SELECT owner_id,home_bytes,state FROM ofz.reservations WHERE id=$1",
                    &[&parse_uuid(&c.reservation_id)?],
                )
                .await
                .map_err(sql_error)?
                .ok_or_else(|| {
                    Status::failed_precondition("capacity reservation required before enrollment")
                })?;
            if row.get::<_, String>(0) != c.owner_id
                || row.get::<_, i64>(1) != c.home_bytes as i64
                || row.get::<_, String>(2) != "reserved"
            {
                return Err(Status::failed_precondition("reservation binding mismatch"));
            }
            if client
                .query_opt(
                    "SELECT 1 FROM ofz.workspaces WHERE uid=$1 OR home_uid=$2",
                    &[&parse_uuid(&c.workspace_uid)?, &parse_uuid(&c.home_uid)?],
                )
                .await
                .map_err(sql_error)?
                .is_some()
            {
                return Err(Status::already_exists(
                    "workspace or home UID already enrolled",
                ));
            }
            prepared.changes.extend([
                Update::touch(Relationship::new(
                    "workspace",
                    &c.workspace_uid,
                    "platform",
                    "platform",
                    "lab",
                )),
                relation("workspace", &c.workspace_uid, "owner", &c.owner_id, true),
            ]);
        }
        Command::ReleaseReservation(c) => {
            let row = client
                .query_opt(
                    "SELECT state FROM ofz.reservations WHERE id=$1",
                    &[&parse_uuid(&c.reservation_id)?],
                )
                .await
                .map_err(sql_error)?
                .ok_or_else(|| Status::not_found("reservation not found"))?;
            if row.get::<_, String>(0) != "reserved" {
                return Err(Status::failed_precondition(
                    "enrolled capacity requires confirmed home removal",
                ));
            }
        }
        Command::SetWorkspaceRuntime(c) => {
            let human = owner(client, &c.workspace_uid).await?;
            parse_uuid(&c.runtime_epoch)?;
            let row = client
                .query_one(
                    "SELECT running,state,runtime_epoch FROM ofz.workspaces WHERE uid=$1",
                    &[&parse_uuid(&c.workspace_uid)?],
                )
                .await
                .map_err(sql_error)?;
            if c.running && row.get::<_, String>(1) != "active" {
                return Err(Status::failed_precondition("workspace quarantined"));
            }
            if c.running && !row.get::<_, bool>(0) {
                quota(client, &human, 0, 1, 0, true).await?;
            }
            if !c.running
                && row
                    .get::<_, Option<Uuid>>(2)
                    .is_some_and(|epoch| epoch.to_string() != c.runtime_epoch)
            {
                return Err(Status::aborted("runtime epoch changed"));
            }
        }
        Command::RemoveWorkspace(c) => {
            let uid = parse_uuid(&c.workspace_uid)?;
            let current = owner(client, &c.workspace_uid).await?;
            if client
                .query_one("SELECT running FROM ofz.workspaces WHERE uid=$1", &[&uid])
                .await
                .map_err(sql_error)?
                .get::<_, bool>(0)
            {
                return Err(Status::failed_precondition(
                    "stop and fence the guest before removal",
                ));
            }
            prepared.changes.push(relation(
                "workspace",
                &c.workspace_uid,
                "owner",
                &current,
                false,
            ));
            for row in client
                .query(
                    "SELECT human_id,role FROM ofz.collaborators WHERE workspace_uid=$1",
                    &[&uid],
                )
                .await
                .map_err(sql_error)?
            {
                prepared.changes.push(relation(
                    "workspace",
                    &c.workspace_uid,
                    collaborator_role(row.get(1))?,
                    &row.get::<_, String>(0),
                    false,
                ));
            }
            prepared.changes.push(Update::delete(Relationship::new(
                "workspace",
                &c.workspace_uid,
                "platform",
                "platform",
                "lab",
            )));
        }
        Command::EmergencyAccess(c) => {
            owner(client, &c.workspace_uid).await?;
            active_member(client, &c.human_id).await?;
            if c.incident_id.trim().len() < 3
                || c.incident_id.len() > 128
                || c.incident_id.contains(['\0', '\n', '\r'])
                || c.expires_at_unix_ms <= state.now_ms
                || c.expires_at_unix_ms > state.now_ms + 1_800_000
            {
                return Err(Status::invalid_argument(
                    "bounded incident and thirty-minute deadline required",
                ));
            }
            if !c.custodian_approval_id.is_empty() {
                let approval = parse_uuid(&c.custodian_approval_id)?;
                let row = client.query_opt("SELECT a.human_id,a.request FROM ofz.emergency_approvals a WHERE a.operation_id=$1 AND a.consumed_by IS NULL AND a.expires_at_ms>ofz.now_ms()", &[&approval]).await.map_err(sql_error)?.ok_or_else(|| Status::permission_denied("independent custodian approval required"))?;
                let first_human: String = row.get(0);
                if first_human == decision::human(context)? {
                    return Err(Status::permission_denied(
                        "two independent custodians required",
                    ));
                }
                let first_request: ExecuteCommandRequest = store::decode(row.get(1))?;
                let Some(Command::EmergencyAccess(first)) = first_request.command.as_ref() else {
                    return Err(Status::failed_precondition("invalid custodian approval"));
                };
                if first.workspace_uid != c.workspace_uid
                    || first.human_id != c.human_id
                    || first.incident_id != c.incident_id
                    || first.expires_at_unix_ms != c.expires_at_unix_ms
                    || !first.custodian_approval_id.is_empty()
                {
                    return Err(Status::permission_denied(
                        "custodian approval binding mismatch",
                    ));
                }
                let first_context = first_request
                    .context
                    .as_ref()
                    .ok_or_else(|| Status::failed_precondition("invalid custodian context"))?;
                decision::session(database, first_context, Action::MembersManage, state).await?;
                if !native
                    .check(&[Check::new(
                        "platform",
                        "lab",
                        "manage_members",
                        "human",
                        &first_human,
                    )])
                    .await?
                    .0
                {
                    return Err(Status::permission_denied("custodian no longer authorized"));
                }
                let mut emergency = Relationship::new(
                    "workspace",
                    &c.workspace_uid,
                    "emergency",
                    "human",
                    &c.human_id,
                );
                emergency.optional_expires_at = Some(
                    DateTime::<Utc>::from_timestamp_millis(c.expires_at_unix_ms as i64)
                        .ok_or_else(|| Status::invalid_argument("invalid emergency deadline"))?,
                );
                prepared.changes.push(Update::touch(emergency));
                prepared.emergency_activated = true;
            }
        }
    }
    Ok((prepared, credential))
}

async fn usage<C: GenericClient + Sync>(
    client: &C,
    human: Option<&str>,
) -> Result<(i64, i64, i64), Status> {
    let row = client.query_one("SELECT (SELECT count(*) FROM ofz.workspaces WHERE state<>'removed' AND ($1::text IS NULL OR owner_id=$1))+(SELECT count(*) FROM ofz.reservations WHERE state='reserved' AND ($1::text IS NULL OR owner_id=$1)), (SELECT count(*) FROM ofz.workspaces WHERE running AND state<>'removed' AND ($1::text IS NULL OR owner_id=$1)), coalesce((SELECT sum(home_bytes) FROM ofz.workspaces WHERE state<>'removed' AND ($1::text IS NULL OR owner_id=$1)),0)::bigint+coalesce((SELECT sum(home_bytes) FROM ofz.reservations WHERE state='reserved' AND ($1::text IS NULL OR owner_id=$1)),0)::bigint", &[&human]).await.map_err(sql_error)?;
    Ok((row.get(0), row.get(1), row.get(2)))
}

async fn quota<C: GenericClient + Sync>(
    client: &C,
    human: &str,
    add_total: i64,
    add_active: i64,
    add_bytes: i64,
    check_fleet: bool,
) -> Result<(), Status> {
    let (total, active, bytes) = usage(client, Some(human)).await?;
    let limits = client.query_opt("SELECT total_workspaces,active_workspaces,retained_bytes FROM ofz.quotas WHERE human_id=$1", &[&human]).await.map_err(sql_error)?;
    let (max_total, max_active, max_bytes) = limits
        .map(|r| {
            (
                r.get::<_, i32>(0) as i64,
                r.get::<_, i32>(1) as i64,
                r.get::<_, i64>(2),
            )
        })
        .unwrap_or((2, 1, 64 * 1024 * 1024 * 1024));
    if total + add_total > max_total
        || active + add_active > max_active
        || bytes + add_bytes > max_bytes
    {
        return Err(Status::resource_exhausted(
            "member workspace quota exceeded",
        ));
    }
    if !check_fleet {
        return Ok(());
    }
    let (total, active, bytes) = usage(client, None).await?;
    let limits = client
        .query_one(
            "SELECT fleet_workspaces,fleet_active,fleet_bytes FROM ofz.platform_state",
            &[],
        )
        .await
        .map_err(sql_error)?;
    if total + add_total > limits.get::<_, i32>(0) as i64
        || active + add_active > limits.get::<_, i32>(1) as i64
        || bytes + add_bytes > limits.get::<_, i64>(2)
    {
        return Err(Status::resource_exhausted("fleet workspace quota exceeded"));
    }
    Ok(())
}

pub(crate) async fn persist(
    client: &mut Client,
    peer: &str,
    prepared: &Prepared,
    fingerprint: &[u8],
) -> Result<(), Status> {
    let context = prepared
        .request
        .context
        .as_ref()
        .ok_or_else(|| Status::internal("missing prepared context"))?;
    let operation = parse_uuid(&prepared.request.operation_id)?;
    let actor = decision::actor_id(context)?;
    let value = store::encode(prepared)?;
    let tx = client.transaction().await.map_err(sql_error)?;
    tx.execute("INSERT INTO ofz.commands(operation_id,actor_id,workload_id,fingerprint,expected_version,prepared) VALUES($1,$2,$3,$4,$5,$6)", &[&operation,&actor,&peer,&fingerprint,&(prepared.request.expected_version as i64),&value]).await.map_err(sql_error)?;
    // Denial takes effect with the durable intent, before native policy can grant
    // a new owner access and before a crash can delay the SQL receipt indefinitely.
    match prepared.request.command.as_ref() {
        Some(Command::TransferWorkspace(c)) => {
            restrict_workspace(&tx, &c.workspace_uid).await?;
        }
        Some(Command::RemoveWorkspace(c)) => {
            restrict_workspace(&tx, &c.workspace_uid).await?;
        }
        Some(Command::SetWorkspaceRole(c)) if prepared.previous_owner.is_some() => {
            restrict_workspace(&tx, &c.workspace_uid).await?;
        }
        Some(Command::SetMembership(c)) if !c.enabled && c.role == PlatformRole::Member as i32 => {
            tx.execute(
                "UPDATE ofz.sessions SET revoked=true WHERE human_id=$1",
                &[&c.human_id],
            )
            .await
            .map_err(sql_error)?;
            tx.execute(
                "UPDATE ofz.grants SET revoked=true WHERE issuer_id=$1",
                &[&c.human_id],
            )
            .await
            .map_err(sql_error)?;
            tx.execute("UPDATE ofz.workspaces SET state='quarantined' WHERE state<>'removed' AND (owner_id=$1 OR uid IN (SELECT workspace_uid FROM ofz.collaborators WHERE human_id=$1 AND role=2))", &[&c.human_id]).await.map_err(sql_error)?;
            tx.execute("UPDATE ofz.grants SET revoked=true WHERE workspace_uid IN (SELECT uid FROM ofz.workspaces WHERE state='quarantined')", &[]).await.map_err(sql_error)?;
        }
        Some(Command::RevokeGrant(c)) => {
            tx.execute(
                "UPDATE ofz.grants SET revoked=true WHERE id=$1",
                &[&parse_uuid(&c.grant_id)?],
            )
            .await
            .map_err(sql_error)?;
        }
        _ => {}
    }
    tx.commit().await.map_err(sql_error)?;
    Ok(())
}

async fn restrict_workspace<C: GenericClient + Sync>(client: &C, uid: &str) -> Result<(), Status> {
    let uid = parse_uuid(uid)?;
    client
        .execute(
            "UPDATE ofz.workspaces SET state='quarantined' WHERE uid=$1 AND state<>'removed'",
            &[&uid],
        )
        .await
        .map_err(sql_error)?;
    client
        .execute(
            "UPDATE ofz.grants SET revoked=true WHERE workspace_uid=$1",
            &[&uid],
        )
        .await
        .map_err(sql_error)?;
    Ok(())
}

pub async fn recover(database: &Database, native: &Native) -> Result<(), Status> {
    let mut connection = database.command_connection().await?;
    reconcile(database, native, &mut connection.client).await
}

pub(crate) async fn reconcile(
    _database: &Database,
    native: &Native,
    client: &mut Client,
) -> Result<(), Status> {
    let rows = client
        .query(
            "SELECT prepared FROM ofz.commands WHERE state=1 ORDER BY expected_version",
            &[],
        )
        .await
        .map_err(sql_error)?;
    for row in rows {
        let prepared = store::decode(row.get(0))?;
        apply_pending(native, client, &prepared).await?;
    }
    Ok(())
}

async fn apply_pending(
    native: &Native,
    client: &mut Client,
    prepared: &Prepared,
) -> Result<CommandReceipt, Status> {
    let (applied, observed_revision) = native.applied(&prepared.request.operation_id).await?;
    let revision = if applied {
        observed_revision
    } else {
        native
            .apply(
                &prepared.request.operation_id,
                prepared.request.expected_version,
                &prepared.changes,
            )
            .await?
    };
    finalize(client, prepared, &revision, applied).await
}

pub(crate) async fn finalize(
    client: &mut Client,
    prepared: &Prepared,
    revision: &str,
    recovered_revision: bool,
) -> Result<CommandReceipt, Status> {
    let tx = client.transaction().await.map_err(sql_error)?;
    let state = store::state(&tx).await?;
    if state.version != prepared.request.expected_version
        || state.recovery_generation != prepared.recovery_generation
    {
        return Err(Status::failed_precondition(
            "pending policy version requires recovery",
        ));
    }
    let context = prepared
        .request
        .context
        .as_ref()
        .ok_or_else(|| Status::internal("prepared context missing"))?;
    let command = prepared
        .request
        .command
        .as_ref()
        .ok_or_else(|| Status::internal("prepared command missing"))?;
    match command {
        Command::SetMembership(c) => {
            if c.enabled {
                tx.execute("INSERT INTO ofz.memberships(human_id,role) VALUES($1,$2) ON CONFLICT DO NOTHING", &[&c.human_id,&c.role]).await.map_err(sql_error)?;
            } else {
                tx.execute(
                    "DELETE FROM ofz.memberships WHERE human_id=$1 AND role=$2",
                    &[&c.human_id, &c.role],
                )
                .await
                .map_err(sql_error)?;
            }
            if !c.enabled && c.role == PlatformRole::Member as i32 {
                tx.execute(
                    "UPDATE ofz.sessions SET revoked=true WHERE human_id=$1",
                    &[&c.human_id],
                )
                .await
                .map_err(sql_error)?;
                tx.execute(
                    "UPDATE ofz.grants SET revoked=true WHERE issuer_id=$1",
                    &[&c.human_id],
                )
                .await
                .map_err(sql_error)?;
                tx.execute("UPDATE ofz.workspaces SET state='quarantined' WHERE state<>'removed' AND (owner_id=$1 OR uid IN (SELECT workspace_uid FROM ofz.collaborators WHERE human_id=$1 AND role=2))", &[&c.human_id]).await.map_err(sql_error)?;
            }
        }
        Command::SetWorkspaceRole(c) => {
            let uid = parse_uuid(&c.workspace_uid)?;
            tx.execute(
                "DELETE FROM ofz.collaborators WHERE workspace_uid=$1 AND human_id=$2",
                &[&uid, &c.human_id],
            )
            .await
            .map_err(sql_error)?;
            if c.enabled {
                tx.execute(
                    "INSERT INTO ofz.collaborators(workspace_uid,human_id,role) VALUES($1,$2,$3)",
                    &[&uid, &c.human_id, &c.role],
                )
                .await
                .map_err(sql_error)?;
            }
            if prepared.previous_owner.is_some() {
                tx.execute(
                    "UPDATE ofz.workspaces SET state='quarantined' WHERE uid=$1",
                    &[&uid],
                )
                .await
                .map_err(sql_error)?;
            }
        }
        Command::TransferWorkspace(c) => {
            let uid = parse_uuid(&c.workspace_uid)?;
            tx.execute(
                "UPDATE ofz.workspaces SET owner_id=$2,state='quarantined' WHERE uid=$1",
                &[&uid, &c.next_owner_id],
            )
            .await
            .map_err(sql_error)?;
            tx.execute(
                "DELETE FROM ofz.collaborators WHERE workspace_uid=$1 AND human_id=$2",
                &[&uid, &c.next_owner_id],
            )
            .await
            .map_err(sql_error)?;
            tx.execute(
                "UPDATE ofz.grants SET revoked=true WHERE workspace_uid=$1",
                &[&uid],
            )
            .await
            .map_err(sql_error)?;
        }
        Command::CreateGrant(c) => {
            let resource = c
                .resource
                .as_ref()
                .ok_or_else(|| Status::internal("prepared grant resource missing"))?;
            let scope = store::encode(&c.scope)?;
            let hash = prepared
                .grant_hash
                .as_ref()
                .ok_or_else(|| Status::internal("prepared credential hash missing"))?;
            tx.execute("INSERT INTO ofz.grants(id,agent_id,issuer_id,workspace_uid,resource_kind,resource_id,actions,scope,proof_key_thumbprint,credential_hash,expires_at_ms,recovery_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", &[&parse_uuid(&c.grant_id)?,&parse_uuid(&c.agent_id)?,&decision::human(context)?,&parse_uuid(&c.workspace_uid)?,&resource.kind,&resource.id,&c.actions,&scope,&c.proof_key_thumbprint,hash,&(c.expires_at_unix_ms as i64),&(prepared.recovery_generation as i64)]).await.map_err(sql_error)?;
        }
        Command::RevokeGrant(c) => {
            tx.execute(
                "UPDATE ofz.grants SET revoked=true WHERE id=$1",
                &[&parse_uuid(&c.grant_id)?],
            )
            .await
            .map_err(sql_error)?;
        }
        Command::SetTargetAccess(_) => {}
        Command::SetQuota(c) => {
            tx.execute("INSERT INTO ofz.quotas(human_id,total_workspaces,active_workspaces,retained_bytes) VALUES($1,$2,$3,$4) ON CONFLICT(human_id) DO UPDATE SET total_workspaces=excluded.total_workspaces,active_workspaces=excluded.active_workspaces,retained_bytes=excluded.retained_bytes", &[&c.human_id,&(c.total_workspaces as i32),&(c.active_workspaces as i32),&(c.retained_bytes as i64)]).await.map_err(sql_error)?;
        }
        Command::ReserveWorkspace(c) => {
            tx.execute("INSERT INTO ofz.reservations(id,owner_id,home_bytes,state) VALUES($1,$2,$3,'reserved')", &[&parse_uuid(&c.reservation_id)?,&decision::human(context)?,&(c.home_bytes as i64)]).await.map_err(sql_error)?;
        }
        Command::EnrollWorkspace(c) => {
            tx.execute("INSERT INTO ofz.workspaces(uid,owner_id,home_uid,home_bytes,reservation_id) VALUES($1,$2,$3,$4,$5)", &[&parse_uuid(&c.workspace_uid)?,&c.owner_id,&parse_uuid(&c.home_uid)?,&(c.home_bytes as i64),&parse_uuid(&c.reservation_id)?]).await.map_err(sql_error)?;
            tx.execute(
                "UPDATE ofz.reservations SET state='enrolled' WHERE id=$1",
                &[&parse_uuid(&c.reservation_id)?],
            )
            .await
            .map_err(sql_error)?;
        }
        Command::ReleaseReservation(c) => {
            tx.execute(
                "UPDATE ofz.reservations SET state='released' WHERE id=$1",
                &[&parse_uuid(&c.reservation_id)?],
            )
            .await
            .map_err(sql_error)?;
        }
        Command::SetWorkspaceRuntime(c) => {
            tx.execute(
                "UPDATE ofz.workspaces SET running=$2,runtime_epoch=$3 WHERE uid=$1",
                &[
                    &parse_uuid(&c.workspace_uid)?,
                    &c.running,
                    &parse_uuid(&c.runtime_epoch)?,
                ],
            )
            .await
            .map_err(sql_error)?;
        }
        Command::RemoveWorkspace(c) => {
            tx.execute(
                "UPDATE ofz.workspaces SET state='quarantined' WHERE uid=$1",
                &[&parse_uuid(&c.workspace_uid)?],
            )
            .await
            .map_err(sql_error)?;
            tx.execute(
                "UPDATE ofz.grants SET revoked=true WHERE workspace_uid=$1",
                &[&parse_uuid(&c.workspace_uid)?],
            )
            .await
            .map_err(sql_error)?;
            // Retained homes continue counting against quota until separately confirmed destroyed.
        }
        Command::EmergencyAccess(c) => {
            if prepared.emergency_activated {
                let updated = tx.execute("UPDATE ofz.emergency_approvals SET consumed_by=$2 WHERE operation_id=$1 AND consumed_by IS NULL", &[&parse_uuid(&c.custodian_approval_id)?,&parse_uuid(&prepared.request.operation_id)?]).await.map_err(sql_error)?;
                if updated != 1 {
                    return Err(Status::failed_precondition(
                        "custodian approval already consumed",
                    ));
                }
            } else {
                tx.execute("INSERT INTO ofz.emergency_approvals(operation_id,human_id,request,expires_at_ms) VALUES($1,$2,$3,$4)", &[&parse_uuid(&prepared.request.operation_id)?,&decision::human(context)?,&store::encode(&prepared.request)?,&(c.expires_at_unix_ms as i64)]).await.map_err(sql_error)?;
            }
        }
    }
    let operation = parse_uuid(&prepared.request.operation_id)?;
    let row = tx
        .query_one(
            "SELECT workload_id FROM ofz.commands WHERE operation_id=$1",
            &[&operation],
        )
        .await
        .map_err(sql_error)?;
    let peer: String = row.get(0);
    let action = Action::try_from(prepared.action)
        .map_err(|_| Status::internal("prepared action invalid"))?;
    let mut audit = store::receipt(
        context,
        &peer,
        prepared.resource.clone(),
        action,
        true,
        &prepared.request.operation_id,
        &prepared.request.reason,
    );
    audit.id = prepared.audit_id.clone();
    audit.policy_command = Some(prepared.request.clone());
    audit.revision = revision.into();
    store::record_audit(&tx, &audit, "").await?;
    let receipt = CommandReceipt {
        operation_id: prepared.request.operation_id.clone(),
        state: CommandState::Committed as i32,
        version: prepared.request.expected_version + 1,
        revision: revision.into(),
        audit_receipt_id: audit.id,
        agent_credential: String::new(),
        recovered_revision,
    };
    let value = store::encode(&receipt)?;
    let updated = tx
        .execute(
            "UPDATE ofz.platform_state SET version=$1 WHERE version=$2",
            &[
                &(receipt.version as i64),
                &(prepared.request.expected_version as i64),
            ],
        )
        .await
        .map_err(sql_error)?;
    if updated != 1 {
        return Err(Status::aborted("control version changed"));
    }
    tx.execute(
        "UPDATE ofz.commands SET state=2,receipt=$2 WHERE operation_id=$1 AND state=1",
        &[&operation, &value],
    )
    .await
    .map_err(sql_error)?;
    tx.commit().await.map_err(sql_error)?;
    Ok(receipt)
}

pub async fn get(
    database: &Database,
    native: &Native,
    peer: &str,
    request: crate::proto::GetCommandRequest,
) -> Result<CommandReceipt, Status> {
    decision::workload(native, peer, Action::PolicyCommand).await?;
    let context = request
        .context
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("context required"))?;
    let actor = decision::actor_id(context)?;
    let mut connection = database.command_connection().await?;
    reconcile(database, native, &mut connection.client).await?;
    let row = connection
        .client
        .query_opt(
            "SELECT actor_id,workload_id,receipt FROM ofz.commands WHERE operation_id=$1",
            &[&parse_uuid(&request.operation_id)?],
        )
        .await
        .map_err(sql_error)?
        .ok_or_else(|| Status::not_found("operation not found"))?;
    if row.get::<_, String>(0) != actor || row.get::<_, String>(1) != peer {
        return Err(Status::permission_denied(
            "operation belongs to another actor",
        ));
    }
    let state = database.state().await?;
    decision::validate_context(context, peer, &state)?;
    if matches!(
        context.actor.as_ref().and_then(|a| a.identity.as_ref()),
        Some(crate::proto::actor::Identity::HumanId(_))
    ) {
        decision::session(database, context, Action::PlatformAdmit, &state).await?;
    } else if context.actor != Some(decision::workload_actor(peer)) {
        return Err(Status::unauthenticated("invalid actor"));
    }
    store::decode(row.get(2))
}
