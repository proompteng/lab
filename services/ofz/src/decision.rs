use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tonic::Status;
use uuid::Uuid;

use crate::{
    native::{Check, Native},
    policy::{self, BFF_ID, CONNECTOR_BROKER_ID, CONTROLLER_ID, KUBE_BROKER_ID},
    proto::{
        Action, Actor, CheckRequest, CheckResponse, ObservationScope, RequestContext, Resource,
        actor::Identity,
    },
    store::{self, Database, State, sql_error},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Grant {
    pub id: String,
    pub agent_id: String,
    pub issuer_id: String,
    pub workspace_uid: String,
    pub resource: Resource,
    pub actions: Vec<i32>,
    pub scope: ObservationScope,
    pub expires_at_ms: u64,
    pub recovery_generation: u64,
    pub revoked: bool,
}

pub async fn grant(database: &Database, id: &str) -> Result<Grant, Status> {
    let id = parse_uuid(id)?;
    let client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("control database pool unavailable"))?;
    let row = client.query_opt("SELECT agent_id,issuer_id,workspace_uid,resource_kind,resource_id,actions,scope,expires_at_ms,recovery_generation,revoked FROM ofz.grants WHERE id=$1", &[&id]).await.map_err(sql_error)?
        .ok_or_else(|| Status::permission_denied("access denied"))?;
    Ok(Grant {
        id: id.to_string(),
        agent_id: row.get::<_, Uuid>(0).to_string(),
        issuer_id: row.get(1),
        workspace_uid: row.get::<_, Uuid>(2).to_string(),
        resource: Resource {
            kind: row.get(3),
            id: row.get(4),
        },
        actions: row.get(5),
        scope: store::decode(row.get(6))?,
        expires_at_ms: row.get::<_, i64>(7) as u64,
        recovery_generation: row.get::<_, i64>(8) as u64,
        revoked: row.get(9),
    })
}

pub fn parse_uuid(value: &str) -> Result<Uuid, Status> {
    if !policy::canonical_uuid(value) {
        return Err(Status::invalid_argument("canonical UID required"));
    }
    Uuid::parse_str(value).map_err(|_| Status::invalid_argument("canonical UID required"))
}

pub async fn active_workspace(database: &Database, uid: &str) -> Result<(), Status> {
    let client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("control database pool unavailable"))?;
    if client
        .query_opt(
            "SELECT 1 FROM ofz.workspaces WHERE uid=$1 AND state='active'",
            &[&parse_uuid(uid)?],
        )
        .await
        .map_err(sql_error)?
        .is_none()
    {
        return Err(Status::permission_denied("workspace unavailable"));
    }
    Ok(())
}

pub fn actor_id(context: &RequestContext) -> Result<String, Status> {
    let actor = context
        .actor
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("actor required"))?;
    actor.subject().map(|(_, id)| id)
}

pub async fn workload(native: &Native, peer: &str, action: Action) -> Result<String, Status> {
    if !policy::allowed_workload(peer) {
        return Err(Status::unauthenticated("unattested workload"));
    }
    let permission = action.permission()?;
    let (allowed, revision) = native
        .check(&[Check::new(
            "platform",
            "lab",
            permission.name,
            "workload",
            &policy::workload_object_id(peer),
        )])
        .await?;
    if !allowed {
        return Err(Status::permission_denied("workload action denied"));
    }
    Ok(revision)
}

pub async fn session(
    database: &Database,
    context: &RequestContext,
    action: Action,
    state: &State,
) -> Result<u64, Status> {
    let human = match context.actor.as_ref().and_then(|a| a.identity.as_ref()) {
        Some(Identity::HumanId(id)) => id,
        _ => return Err(Status::permission_denied("human session required")),
    };
    let session = parse_uuid(&context.session_id)
        .map_err(|_| Status::unauthenticated("valid session required"))?;
    if !context.grant_id.is_empty() {
        return Err(Status::permission_denied(
            "human cannot use delegated context",
        ));
    }
    let client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("control database pool unavailable"))?;
    let row = client.query_opt("SELECT expires_at_ms,idle_deadline_ms,mfa_at_ms FROM ofz.sessions WHERE id=$1 AND human_id=$2 AND NOT revoked AND recovery_generation=$3 AND expires_at_ms>ofz.now_ms() AND idle_deadline_ms>ofz.now_ms() AND EXISTS (SELECT 1 FROM ofz.memberships WHERE human_id=$2 AND role=1)", &[&session,human,&(state.recovery_generation as i64)]).await.map_err(sql_error)?
        .ok_or_else(|| Status::unauthenticated("session expired or revoked"))?;
    let mfa: i64 = row.get(2);
    if policy::requires_mfa(action) && (mfa <= 0 || mfa as u64 > state.now_ms) {
        return Err(Status::permission_denied(
            "multifactor authentication required",
        ));
    }
    if policy::requires_fresh_mfa(action) && state.now_ms.saturating_sub(mfa as u64) > 300_000 {
        return Err(Status::permission_denied(
            "fresh multifactor authentication required",
        ));
    }
    Ok((row.get::<_, i64>(0) as u64).min(row.get::<_, i64>(1) as u64))
}

pub fn scope_allows(scope: &ObservationScope, action: Action, target: &str) -> bool {
    match action {
        Action::WorkspaceMetadataRead | Action::PreviewObserve => target.is_empty(),
        Action::FilesObserve => {
            clean_absolute(target)
                && !credential_path(target)
                && scope.file_roots.iter().any(|root| {
                    target == root
                        || target
                            .strip_prefix(root)
                            .is_some_and(|tail| tail.starts_with('/'))
                })
        }
        Action::CodexObserve => {
            !target.is_empty() && scope.thread_ids.iter().any(|id| id == target)
        }
        Action::TerminalObserve => {
            !target.is_empty() && scope.terminal_ids.iter().any(|id| id == target)
        }
        Action::BrowserObserve => {
            target == "status" || (scope.browser_screenshot && target == "screenshot")
        }
        Action::KubeStatusRead
        | Action::KubeLogsRead
        | Action::KubeEventsRead
        | Action::ConnectorRead => {
            !target.is_empty() && target.len() <= 256 && !target.contains(['\0', '\n', '\r'])
        }
        _ => false,
    }
}

pub fn clean_absolute(path: &str) -> bool {
    path.starts_with('/')
        && path.len() > 1
        && path.len() <= 4096
        && !path.ends_with('/')
        && !path.contains(['\0', '\\'])
        && path
            .split('/')
            .skip(1)
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

pub fn credential_path(path: &str) -> bool {
    path.split('/').any(|part| {
        matches!(
            part,
            ".ssh"
                | ".aws"
                | ".kube"
                | ".codex"
                | ".config"
                | ".git"
                | ".npmrc"
                | ".netrc"
                | ".pypirc"
                | "credentials.json"
                | "auth.json"
        ) || part == ".env"
            || part.starts_with(".env.")
    })
}

pub fn validate_scope(actions: &[i32], scope: &ObservationScope) -> Result<(), Status> {
    if scope.max_bytes == 0
        || scope.max_bytes > 1_048_576
        || scope.max_items == 0
        || scope.max_items > 200
        || scope.file_roots.len() > 16
        || scope.thread_ids.len() > 32
        || scope.terminal_ids.len() > 16
    {
        return Err(Status::invalid_argument(
            "bounded observation scope required",
        ));
    }
    if scope.file_roots.iter().any(|root| {
        !clean_absolute(root) || !root.starts_with("/workspace/") || credential_path(root)
    }) || scope
        .thread_ids
        .iter()
        .chain(&scope.terminal_ids)
        .any(|id| id.is_empty() || id.len() > 128 || id.contains(['/', '\\', '\0']))
    {
        return Err(Status::invalid_argument("invalid observation scope"));
    }
    if actions.contains(&(Action::FilesObserve as i32)) && scope.file_roots.is_empty()
        || actions.contains(&(Action::CodexObserve as i32)) && scope.thread_ids.is_empty()
        || actions.contains(&(Action::TerminalObserve as i32)) && scope.terminal_ids.is_empty()
    {
        return Err(Status::invalid_argument(
            "content access requires an explicit scope",
        ));
    }
    Ok(())
}

pub fn grant_checks(grant: &Grant, action: Action) -> Result<Vec<Check>, Status> {
    let kind = grant.resource.validate_for(action)?;
    let permission = action.permission()?;
    let mut checks = vec![
        Check::new("agent_grant", &grant.id, "use", "agent", &grant.agent_id),
        Check::new(
            "agent_grant",
            &grant.id,
            "issuer",
            "human",
            &grant.issuer_id,
        ),
        Check::new(
            "agent_grant",
            &grant.id,
            "workspace",
            "workspace",
            &grant.workspace_uid,
        ),
        Check::new(
            "workspace",
            &grant.workspace_uid,
            "manage_grants",
            "human",
            &grant.issuer_id,
        ),
        Check::new(
            kind,
            &grant.resource.id,
            permission.name,
            "human",
            &grant.issuer_id,
        ),
    ];
    if kind != "workspace" {
        checks.push(Check::new(
            "agent_grant",
            &grant.id,
            kind,
            kind,
            &grant.resource.id,
        ));
    }
    Ok(checks)
}

pub struct Evaluation<'a> {
    pub context: &'a RequestContext,
    pub action: Action,
    pub resource: &'a Resource,
    pub target: &'a str,
}

pub fn validate_context(context: &RequestContext, peer: &str, state: &State) -> Result<(), Status> {
    if context.contract_version != crate::CONTRACT_VERSION {
        return Err(Status::failed_precondition(
            "authorization contract mismatch",
        ));
    }
    if !policy::allowed_workload(peer) {
        return Err(Status::unauthenticated("unattested workload"));
    }
    let actor = context
        .actor
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("actor required"))?;
    let (kind, _) = actor.subject()?;
    if context.deadline_unix_ms <= state.now_ms || context.deadline_unix_ms > state.now_ms + 30_000
    {
        return Err(Status::deadline_exceeded("invalid authorization deadline"));
    }
    if context.trace_id.len() > 128 || context.trace_id.contains(['\n', '\r', '\0']) {
        return Err(Status::invalid_argument("invalid trace ID"));
    }
    if !context.workspace_uid.is_empty() && !policy::canonical_uuid(&context.workspace_uid)
        || !context.runtime_epoch.is_empty() && !policy::canonical_uuid(&context.runtime_epoch)
    {
        return Err(Status::invalid_argument("invalid runtime binding"));
    }
    if kind != "workload" {
        let origin = reqwest::Url::parse(&context.origin)
            .map_err(|_| Status::unauthenticated("canonical origin required"))?;
        if origin.scheme() != "https"
            || origin.host_str().is_none()
            || origin.origin().ascii_serialization() != context.origin
        {
            return Err(Status::unauthenticated("canonical HTTPS origin required"));
        }
    } else if context.actor != Some(workload_actor(peer))
        || !context.session_id.is_empty()
        || !context.grant_id.is_empty()
    {
        return Err(Status::unauthenticated("invalid workload context"));
    }
    Ok(())
}

pub async fn evaluate(
    database: &Database,
    native: &Native,
    peer: &str,
    evaluation: Evaluation<'_>,
    allow_fenced_revoke: bool,
) -> Result<(bool, String, u64, State), Status> {
    let Evaluation {
        context,
        action,
        resource,
        target,
    } = evaluation;
    let kind = resource.validate_for(action)?;
    let actor = context
        .actor
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("actor required"))?;
    let (actor_kind, subject) = actor.subject()?;
    if kind == "workspace" && context.workspace_uid != resource.id {
        return Err(Status::permission_denied(
            "workspace context binding mismatch",
        ));
    }
    let state = database.state().await?;
    validate_context(context, peer, &state)?;
    if (state.fenced || !state.archive_healthy) && !allow_fenced_revoke {
        return Err(Status::unavailable("protected access fenced"));
    }
    let mut valid_until = context.deadline_unix_ms.min(state.now_ms + 2000);
    let needs_active_workspace = kind == "workspace"
        && !matches!(
            action,
            Action::WorkspaceMetadataRead
                | Action::WorkspacePolicyRead
                | Action::GrantsManage
                | Action::CollaboratorsManage
                | Action::WorkspaceDelete
                | Action::WorkspaceTransfer
        );
    let mut grant_workspace = None;
    let mut checks = match actor.identity.as_ref() {
        Some(Identity::HumanId(_)) => {
            if !matches!(peer, BFF_ID | CONTROLLER_ID) {
                return Err(Status::permission_denied("human caller denied"));
            }
            valid_until = valid_until.min(session(database, context, action, &state).await?);
            vec![Check::new(
                kind,
                &resource.id,
                action.permission()?.name,
                actor_kind,
                &subject,
            )]
        }
        Some(Identity::AgentId(_)) => {
            if !matches!(
                peer,
                BFF_ID | CONTROLLER_ID | KUBE_BROKER_ID | CONNECTOR_BROKER_ID
            ) || !context.session_id.is_empty()
            {
                return Err(Status::permission_denied("delegated caller denied"));
            }
            let grant = grant(database, &context.grant_id).await?;
            grant_workspace = Some(grant.workspace_uid.clone());
            if grant.revoked
                || context.workspace_uid != grant.workspace_uid
                || grant.agent_id != subject
                || grant.resource != *resource
                || !grant.actions.contains(&(action as i32))
                || !action.permission()?.diagnostic
                || grant.expires_at_ms <= state.now_ms
                || grant.recovery_generation != state.recovery_generation
                || !scope_allows(&grant.scope, action, target)
            {
                return Err(Status::permission_denied("access denied"));
            }
            valid_until = valid_until.min(grant.expires_at_ms);
            grant_checks(&grant, action)?
        }
        Some(Identity::WorkloadId(id))
            if id == peer && context.session_id.is_empty() && context.grant_id.is_empty() =>
        {
            vec![Check::new(
                kind,
                &resource.id,
                action.permission()?.name,
                actor_kind,
                &subject,
            )]
        }
        _ => return Err(Status::unauthenticated("invalid authenticated context")),
    };
    checks.push(Check::new(
        "platform",
        "lab",
        "check",
        "workload",
        &policy::workload_object_id(peer),
    ));
    let (mut allowed, revision) = native.check(&checks).await?;
    if allowed {
        let active_uid = grant_workspace.as_deref().or(if needs_active_workspace {
            Some(resource.id.as_str())
        } else {
            None
        });
        if let Some(uid) = active_uid {
            match active_workspace(database, uid).await {
                Ok(()) => {}
                Err(error) if error.code() == tonic::Code::PermissionDenied => allowed = false,
                Err(error) => return Err(error),
            }
        }
        if allowed
            && matches!(
                action,
                Action::FilesObserve
                    | Action::FilesWrite
                    | Action::TerminalObserve
                    | Action::TerminalControl
                    | Action::CodexObserve
                    | Action::CodexControl
                    | Action::BrowserObserve
                    | Action::BrowserControl
                    | Action::EditorOpen
                    | Action::PreviewAccess
            )
        {
            let client = database
                .pool
                .get()
                .await
                .map_err(|_| Status::unavailable("control database pool unavailable"))?;
            let epoch = if context.runtime_epoch.is_empty() {
                None
            } else {
                Some(parse_uuid(&context.runtime_epoch)?)
            };
            allowed = if let Some(epoch) = epoch {
                client.query_opt("SELECT 1 FROM ofz.workspaces WHERE uid=$1 AND runtime_epoch=$2 AND running AND state='active'", &[&parse_uuid(&context.workspace_uid)?,&epoch]).await.map_err(sql_error)?.is_some()
            } else {
                false
            };
        }
    }
    // A dependency response arriving beyond the bound cannot authorize a disclosure.
    let after = database.state().await?;
    if after.now_ms >= valid_until
        || after.recovery_generation != state.recovery_generation
        || ((after.fenced || !after.archive_healthy) && !allow_fenced_revoke)
    {
        return Err(Status::deadline_exceeded("authorization decision expired"));
    }
    Ok((allowed, revision, valid_until, after))
}

pub async fn check(
    database: &Database,
    native: &Native,
    peer: &str,
    request: CheckRequest,
) -> Result<CheckResponse, Status> {
    let context = request
        .context
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("context required"))?;
    let resource = request
        .resource
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("resource required"))?;
    let action =
        Action::try_from(request.action).map_err(|_| Status::invalid_argument("unknown action"))?;
    let result = evaluate(
        database,
        native,
        peer,
        Evaluation {
            context,
            action,
            resource,
            target: &request.target,
        },
        false,
    )
    .await;
    let (allowed, revision, valid_until, state) = match result {
        Ok(result) => result,
        Err(mut error) => {
            if request.stream_receipt_id.is_empty()
                && policy::allowed_workload(peer)
                && context
                    .actor
                    .as_ref()
                    .is_some_and(|actor| actor.subject().is_ok())
                && resource.validate_for(action).is_ok()
                && context.trace_id.len() <= 128
            {
                let audit = store::receipt(
                    context,
                    peer,
                    resource.clone(),
                    action,
                    false,
                    "",
                    "authorization rejected",
                );
                let id = database.audit(&audit, &request.target).await?;
                error.metadata_mut().insert(
                    "x-ofz-audit-receipt",
                    id.parse()
                        .map_err(|_| Status::internal("invalid audit ID"))?,
                );
            }
            return Err(error);
        }
    };
    let audit_receipt_id = if request.stream_receipt_id.is_empty() {
        let receipt = store::receipt(
            context,
            peer,
            resource.clone(),
            action,
            allowed,
            "",
            "protected access",
        );
        database.audit(&receipt, &request.target).await?
    } else {
        let id = parse_uuid(&request.stream_receipt_id)?;
        let client = database
            .pool
            .get()
            .await
            .map_err(|_| Status::unavailable("control database pool unavailable"))?;
        let actor = store::encode(&context.actor)?;
        let resource = store::encode(resource)?;
        let target_hash = Sha256::digest(request.target.as_bytes()).to_vec();
        let bound = client.query_opt("SELECT receipt FROM ofz.audit WHERE id=$1 AND receipt->'actor'=$2 AND receipt->'resource'=$3 AND (receipt->>'action')::integer=$4 AND receipt->>'workload_id'=$5 AND receipt->>'allowed'='true' AND target_hash=$6 AND created_at_ms>ofz.now_ms()-28800000", &[&id,&actor,&resource,&(action as i32),&peer,&target_hash]).await.map_err(sql_error)?;
        let bound =
            bound.ok_or_else(|| Status::permission_denied("stream receipt binding mismatch"))?;
        let receipt: crate::proto::AuditReceipt = store::decode(bound.get(0))?;
        if receipt.session_id != context.session_id
            || receipt.grant_id != context.grant_id
            || receipt.workspace_uid != context.workspace_uid
            || receipt.runtime_epoch != context.runtime_epoch
            || receipt.origin != context.origin
            || receipt.recovery_generation != state.recovery_generation
        {
            return Err(Status::permission_denied("stream receipt binding mismatch"));
        }
        request.stream_receipt_id
    };
    Ok(CheckResponse {
        allowed,
        revision,
        audit_receipt_id,
        valid_until_unix_ms: valid_until,
        recovery_generation: state.recovery_generation,
    })
}

pub fn human(context: &RequestContext) -> Result<&str, Status> {
    match context.actor.as_ref().and_then(|a| a.identity.as_ref()) {
        Some(Identity::HumanId(id)) if policy::canonical_human_id(id) => Ok(id),
        _ => Err(Status::permission_denied("human session required")),
    }
}

pub fn workload_actor(peer: &str) -> Actor {
    Actor {
        identity: Some(Identity::WorkloadId(peer.into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_scope_does_not_escape_selected_content() {
        let scope = ObservationScope {
            file_roots: vec!["/workspace/project".into()],
            thread_ids: vec!["approved".into()],
            terminal_ids: vec!["output".into()],
            browser_screenshot: false,
            max_bytes: 65536,
            max_items: 100,
        };
        assert!(scope_allows(
            &scope,
            Action::FilesObserve,
            "/workspace/project/src/main.rs"
        ));
        for path in [
            "/workspace/project2/src",
            "/workspace/project/../.ssh",
            "/workspace/project//src",
            "/etc/passwd",
        ] {
            assert!(!scope_allows(&scope, Action::FilesObserve, path), "{path}");
        }
        assert!(!scope_allows(&scope, Action::CodexObserve, "other"));
        assert!(!scope_allows(&scope, Action::BrowserObserve, "screenshot"));
        assert!(!scope_allows(&scope, Action::TerminalControl, "output"));
    }
}
