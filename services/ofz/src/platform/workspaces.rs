use std::collections::{BTreeMap, BTreeSet};
use tonic::Status;
use uuid::Uuid;

use super::{authorization, catalog, onboarding};
use crate::{
    native::{Check, Native},
    policy, proto, registry,
    store::{self, Database, sql_error},
};

pub(crate) fn gateway(peer: &str, session: &proto::PlatformHumanSession) -> Result<(), Status> {
    let service = registry::configured()?
        .service(peer)
        .ok_or_else(|| Status::permission_denied("registered administration gateway required"))?;
    if !service
        .roles
        .iter()
        .any(|role| role == "platform.administration")
        || !service.allows_origin(&session.origin)
    {
        return Err(Status::permission_denied(
            "registered administration gateway required",
        ));
    }
    Ok(())
}

pub(crate) fn resource_workspace_id(
    resources: &[proto::PlatformResource],
) -> Result<String, Status> {
    let mut id = None;
    for resource in resources {
        if !catalog::configured()?
            .resource(&resource.kind)?
            .workspace_scoped
        {
            continue;
        }
        let workspace = registry::configured()?.resource_workspace(&resource.kind, &resource.id)?;
        if id.is_some_and(|id| id != workspace.id) {
            return Err(Status::invalid_argument(
                "connection resources must belong to one workspace",
            ));
        }
        id = Some(workspace.id.as_str());
    }
    Ok(id.unwrap_or_default().into())
}

pub(crate) async fn manage(native: &Native, id: &str, human: &str) -> Result<String, Status> {
    registry::configured()?.workspace(id)?;
    let (allowed, revision) = native
        .check(&[Check::new(
            "platform_workspace",
            id,
            "manage",
            "human",
            human,
        )])
        .await?;
    if !allowed {
        return Err(Status::permission_denied(
            "workspace administrator required",
        ));
    }
    Ok(revision)
}

pub(crate) fn subject(kind: &str, id: &str) -> Result<(&'static str, String), Status> {
    match kind {
        "human" => {
            proto::Actor {
                identity: Some(proto::actor::Identity::HumanId(id.into())),
            }
            .subject()?;
            Ok(("human", id.into()))
        }
        "workload" if registry::configured()?.service(id).is_some() => {
            Ok(("workload", policy::workload_object_id(id)))
        }
        "workspace" => {
            registry::configured()?.workspace(id)?;
            Ok(("platform_workspace", id.into()))
        }
        _ => Err(Status::invalid_argument(
            "registered policy recipient required",
        )),
    }
}

pub(crate) async fn membership_changes(
    native: &Native,
    workspace: &str,
    changes: &[proto::PolicyRelationship],
) -> Result<(), Status> {
    let membership: Vec<_> = changes
        .iter()
        .filter(|change| {
            change
                .resource
                .as_ref()
                .is_some_and(|resource| resource.kind == "platform.workspace")
        })
        .collect();
    if membership.is_empty() {
        return Ok(());
    }
    let mut administrators: BTreeSet<_> = native
        .workspace_relationships(workspace)
        .await?
        .into_iter()
        .filter(|relationship| {
            relationship.relation == "administrator"
                && relationship.subject.object.object_type == "human"
        })
        .map(|relationship| relationship.subject.object.object_id)
        .collect();
    let mut admitted = Vec::new();
    for change in membership {
        if change.subject_kind == "human" && change.enabled {
            admitted.push(Check::new(
                "platform",
                "lab",
                "admit",
                "human",
                &change.subject_id,
            ));
        }
        if change.relation == "administrator" {
            if change.enabled {
                administrators.insert(change.subject_id.clone());
            } else {
                administrators.remove(&change.subject_id);
            }
        }
        if change.relation == "client"
            && !registry::configured()?
                .service(&change.subject_id)
                .is_some_and(|service| service.roles.iter().any(|role| role == "relay.client"))
        {
            return Err(Status::permission_denied(
                "registered Relay client required",
            ));
        }
    }
    for checks in admitted.chunks(64) {
        if !native.check(checks).await?.0 {
            return Err(Status::permission_denied(
                "workspace members must be admitted platform identities",
            ));
        }
    }
    let checks: Vec<_> = administrators
        .iter()
        .map(|human| Check::new("platform", "lab", "admit", "human", human))
        .collect();
    let mut active = false;
    for checks in checks.chunks(64) {
        active |= native
            .check_each(checks)
            .await?
            .0
            .into_iter()
            .any(|value| value);
    }
    if !active {
        return Err(Status::failed_precondition(
            "workspace must retain an active administrator",
        ));
    }
    Ok(())
}

pub(crate) fn resource_scope(id: &str, resource: &proto::PlatformResource) -> Result<(), Status> {
    registry::configured()?.workspace(id)?;
    let matches = if resource.kind == "platform.workspace" {
        resource.id == id
    } else {
        registry::configured()?
            .resource_workspace(&resource.kind, &resource.id)?
            .id
            == id
    };
    if !matches || !resource.target.is_empty() {
        return Err(Status::permission_denied(
            "resource belongs to another workspace",
        ));
    }
    Ok(())
}

fn metadata(workspace: &registry::WorkspaceRegistration) -> proto::RegisteredPlatformWorkspace {
    proto::RegisteredPlatformWorkspace {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        resources: workspace
            .resources
            .iter()
            .map(|resource| proto::RegisteredWorkspaceResource {
                name: resource.name.clone(),
                resource: Some(proto::PlatformResource {
                    kind: resource.kind.clone(),
                    id: resource.id.clone(),
                    target: String::new(),
                }),
            })
            .collect(),
    }
}

pub(crate) fn client_metadata(
    service: &registry::ServiceRegistration,
) -> proto::RegisteredRelayClient {
    proto::RegisteredRelayClient {
        id: service.id.clone(),
        identities: service.identities.clone(),
        display_name: service.name().into(),
    }
}

fn read_receipt(
    context: &proto::RequestContext,
    peer: &str,
    workspace: &str,
    action: proto::Action,
    revision: String,
    allowed: bool,
) -> proto::AuditReceipt {
    let mut receipt = store::receipt(
        context,
        peer,
        policy::platform(),
        action,
        allowed,
        &context.trace_id,
        "workspace administration read",
    );
    receipt.platform_action = if action == proto::Action::AuditRead {
        "ofz.workspaces.activity"
    } else {
        "ofz.workspaces.read"
    }
    .into();
    receipt.platform_workspace_id = workspace.into();
    receipt.revision = revision;
    receipt
}

async fn authorize_read(
    database: &Database,
    native: &Native,
    peer: &str,
    session: &proto::PlatformHumanSession,
    workspace: &str,
    action: proto::Action,
) -> Result<(proto::RequestContext, store::State, String), Status> {
    gateway(peer, session)?;
    let (context, state, _) =
        authorization::human_context(database, session, &Uuid::new_v4().to_string(), false).await?;
    onboarding::verify(database).await?;
    let revision = match manage(native, workspace, &session.human_id).await {
        Ok(revision) => revision,
        Err(error) => {
            let mut receipt = read_receipt(&context, peer, workspace, action, String::new(), false);
            receipt.recovery_generation = state.recovery_generation;
            database.audit(&receipt, workspace).await?;
            return Err(error);
        }
    };
    Ok((context, state, revision))
}

async fn finish_read(
    database: &Database,
    native: &Native,
    session: &proto::PlatformHumanSession,
    initial: &store::State,
    mut receipt: proto::AuditReceipt,
) -> Result<(), Status> {
    receipt.recovery_generation = initial.recovery_generation;
    database
        .audit(&receipt, &receipt.platform_workspace_id)
        .await?;
    let (_, current, _) =
        authorization::human_context(database, session, &receipt.operation_id, false).await?;
    if current.version != initial.version
        || current.recovery_generation != initial.recovery_generation
    {
        return Err(Status::aborted("workspace authority changed during read"));
    }
    manage(native, &receipt.platform_workspace_id, &session.human_id).await?;
    onboarding::verify(database).await?;
    Ok(())
}

pub async fn list(
    database: &Database,
    native: &Native,
    peer: &str,
    request: proto::ListPlatformWorkspacesRequest,
) -> Result<proto::ListPlatformWorkspacesResponse, Status> {
    let session = request
        .administrator
        .ok_or_else(|| Status::unauthenticated("human session required"))?;
    gateway(peer, &session)?;
    let (context, state, _) =
        authorization::human_context(database, &session, &Uuid::new_v4().to_string(), false)
            .await?;
    onboarding::verify(database).await?;
    let registry = registry::configured()?;
    let checks: Vec<_> = registry
        .workspaces
        .iter()
        .map(|workspace| {
            Check::new(
                "platform_workspace",
                &workspace.id,
                "manage",
                "human",
                &session.human_id,
            )
        })
        .collect();
    let (allowed, revision) = if checks.is_empty() {
        (Vec::new(), String::new())
    } else {
        native.check_each(&checks).await?
    };
    let mut receipt = read_receipt(
        &context,
        peer,
        "",
        proto::Action::PolicyRead,
        revision,
        true,
    );
    receipt.platform_action = "ofz.workspaces.list".into();
    receipt.recovery_generation = state.recovery_generation;
    database.audit(&receipt, "workspace directory").await?;
    let (_, current, _) =
        authorization::human_context(database, &session, &context.trace_id, false).await?;
    if current.version != state.version
        || current.recovery_generation != state.recovery_generation
        || (!checks.is_empty() && native.check_each(&checks).await?.0 != allowed)
    {
        return Err(Status::aborted(
            "workspace authority changed during listing",
        ));
    }
    onboarding::verify(database).await?;
    Ok(proto::ListPlatformWorkspacesResponse {
        workspaces: registry
            .workspaces
            .iter()
            .zip(allowed)
            .filter(|(_, allowed)| *allowed)
            .map(|(workspace, _)| metadata(workspace))
            .collect(),
    })
}

pub async fn get(
    database: &Database,
    native: &Native,
    peer: &str,
    request: proto::GetPlatformWorkspaceRequest,
) -> Result<proto::GetPlatformWorkspaceResponse, Status> {
    let session = request
        .administrator
        .ok_or_else(|| Status::unauthenticated("human session required"))?;
    let (context, state, revision) = authorize_read(
        database,
        native,
        peer,
        &session,
        &request.workspace_id,
        proto::Action::PolicyRead,
    )
    .await?;
    let relationships = native
        .workspace_relationships(&request.workspace_id)
        .await?;
    let mut roles = BTreeMap::<String, proto::PlatformWorkspaceRole>::new();
    let mut clients = BTreeSet::new();
    for relationship in relationships {
        let subject = relationship.subject.object;
        match (relationship.relation.as_str(), subject.object_type.as_str()) {
            ("member", "human") => {
                roles
                    .entry(subject.object_id)
                    .or_insert(proto::PlatformWorkspaceRole::Member);
            }
            ("administrator", "human") => {
                roles.insert(
                    subject.object_id,
                    proto::PlatformWorkspaceRole::Administrator,
                );
            }
            ("client", "workload") => {
                clients.insert(subject.object_id);
            }
            ("platform", "platform") if subject.object_id == "lab" => {}
            _ => {
                return Err(Status::failed_precondition(
                    "workspace contains an unregistered relationship",
                ));
            }
        }
    }
    let ids: Vec<_> = roles.keys().cloned().collect();
    let connection = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("workspace directory unavailable"))?;
    let people = connection.query("SELECT h.id,h.github_id,COALESCE((SELECT display_name FROM ofz.sessions s WHERE s.human_id=h.id ORDER BY mfa_at_ms DESC LIMIT 1),''),EXISTS(SELECT 1 FROM ofz.memberships m WHERE m.human_id=h.id AND m.role=1) FROM ofz.humans h WHERE h.id=ANY($1)", &[&ids]).await.map_err(sql_error)?;
    let members = people
        .iter()
        .map(|row| proto::PlatformWorkspaceMember {
            human_id: row.get(0),
            github_id: row.get(1),
            display_name: row.get(2),
            role: roles[&row.get::<_, String>(0)] as i32,
            admitted: row.get(3),
        })
        .collect();
    let registry = registry::configured()?;
    let enrolled_clients = registry
        .services
        .iter()
        .filter(|service| service.roles.iter().any(|role| role == "relay.client"))
        .map(|service| proto::PlatformWorkspaceClient {
            client: Some(client_metadata(service)),
            enabled: service
                .identities
                .iter()
                .all(|identity| clients.contains(&policy::workload_object_id(identity))),
        })
        .collect();
    finish_read(
        database,
        native,
        &session,
        &state,
        read_receipt(
            &context,
            peer,
            &request.workspace_id,
            proto::Action::PolicyRead,
            revision,
            true,
        ),
    )
    .await?;
    Ok(proto::GetPlatformWorkspaceResponse {
        workspace: Some(metadata(registry.workspace(&request.workspace_id)?)),
        members,
        clients: enrolled_clients,
        policy_version: state.version,
    })
}

pub async fn activity(
    database: &Database,
    native: &Native,
    peer: &str,
    request: proto::ReadWorkspaceActivityRequest,
) -> Result<proto::ReadWorkspaceActivityResponse, Status> {
    let session = request
        .administrator
        .ok_or_else(|| Status::unauthenticated("human session required"))?;
    let (context, state, revision) = authorize_read(
        database,
        native,
        peer,
        &session,
        &request.workspace_id,
        proto::Action::AuditRead,
    )
    .await?;
    let cursor = if request.cursor.is_empty() {
        i64::MAX
    } else {
        request
            .cursor
            .parse::<i64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| Status::invalid_argument("invalid activity cursor"))?
    };
    let connection = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("workspace activity unavailable"))?;
    let rows = connection.query("SELECT sequence,receipt FROM ofz.audit WHERE sequence<$1 AND receipt ? 'platform_workspace_id' AND receipt->>'platform_workspace_id'=$2 AND (receipt->>'allowed'='false' OR receipt->>'platform_action' NOT IN ('ofz.workspaces.read','ofz.workspaces.activity','ofz.relationships.read')) ORDER BY sequence DESC LIMIT 101", &[&cursor,&request.workspace_id]).await.map_err(sql_error)?;
    let mut receipts = Vec::new();
    for row in rows.iter().take(100) {
        receipts.push(store::decode::<proto::AuditReceipt>(row.get(1))?);
    }
    let cursor = if rows.len() > 100 {
        rows[99].get::<_, i64>(0).to_string()
    } else {
        String::new()
    };
    finish_read(
        database,
        native,
        &session,
        &state,
        read_receipt(
            &context,
            peer,
            &request.workspace_id,
            proto::Action::AuditRead,
            revision,
            true,
        ),
    )
    .await?;
    Ok(proto::ReadWorkspaceActivityResponse { receipts, cursor })
}
