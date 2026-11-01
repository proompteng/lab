use sha2::{Digest, Sha256};
use tokio_postgres::{Client, Row};
use tonic::Status;
use uuid::Uuid;

use super::{authorization, catalog, onboarding, workspaces};
use crate::{
    decision,
    native::{Check, Native, Relationship, Update},
    policy, proto, registry,
    store::{self, Database, sql_error},
};

pub(crate) fn reason(value: &str) -> Result<(), Status> {
    if !(3..=512).contains(&value.trim().len())
        || value.len() > 512
        || value.contains(['\0', '\n', '\r'])
    {
        return Err(Status::invalid_argument(
            "a short access request reason is required",
        ));
    }
    Ok(())
}

pub(crate) fn scope_hash(
    resource: &proto::PlatformResource,
    actions: &[String],
) -> Result<Vec<u8>, Status> {
    let mut actions = actions.to_vec();
    actions.sort();
    Ok(Sha256::digest(store::encode(&(resource, actions))?.to_string()).to_vec())
}

pub(crate) async fn enrolled(
    native: &Native,
    client: &registry::ServiceRegistration,
    workspace: &str,
    human: &str,
) -> Result<bool, Status> {
    registry::configured()?.workspace(workspace)?;
    if !client.roles.iter().any(|role| role == "relay.client") {
        return Ok(false);
    }
    let mut checks = vec![
        Check::new("platform", "lab", "admit", "human", human),
        Check::new("platform_workspace", workspace, "use", "human", human),
    ];
    checks.extend(client.identities.iter().map(|identity| {
        Check::new(
            "platform_workspace",
            workspace,
            "use",
            "workload",
            &policy::workload_object_id(identity),
        )
    }));
    Ok(native.check(&checks).await?.0)
}

pub(crate) fn scope(
    workspace: &str,
    resource: &proto::PlatformResource,
    actions: &[String],
) -> Result<proto::PlatformConnectionScope, Status> {
    let workspace = registry::configured()?.workspace(workspace)?;
    let entry = workspace
        .resources
        .iter()
        .find(|entry| entry.kind == resource.kind && entry.id == resource.id)
        .ok_or_else(|| {
            Status::permission_denied("resource is outside this workspace's approved integrations")
        })?;
    if !resource.target.is_empty() || !(1..=16).contains(&actions.len()) {
        return Err(Status::invalid_argument(
            "one approved resource and bounded actions are required",
        ));
    }
    let catalog = catalog::configured()?;
    let definition = catalog.resource(&resource.kind)?;
    let mut unique = std::collections::BTreeSet::new();
    for action in actions {
        let action = catalog.action(action)?;
        if action.resource_kind != resource.kind
            || !definition.workspace_scoped
            || !unique.insert(&action.id)
            || !action.grant_relation.as_ref().is_some_and(|name| {
                definition.relations.iter().any(|relation| {
                    &relation.name == name
                        && relation.subjects.iter().any(|subject| subject == "human")
                })
            })
        {
            return Err(Status::permission_denied(
                "action is not available for a member access request",
            ));
        }
    }
    Ok(proto::PlatformConnectionScope {
        workspace_id: workspace.id.clone(),
        workspace_name: workspace.name.clone(),
        resource: Some(resource.clone()),
        resource_name: entry.name.clone(),
        actions: actions.to_vec(),
    })
}

pub(crate) async fn requestable(
    native: &Native,
    client: &registry::ServiceRegistration,
    human: &str,
) -> Result<Vec<proto::PlatformConnectionScope>, Status> {
    let mut scopes = Vec::new();
    let catalog = catalog::configured()?;
    for workspace in &registry::configured()?.workspaces {
        if !enrolled(native, client, &workspace.id, human).await? {
            continue;
        }
        for entry in &workspace.resources {
            let definition = catalog.resource(&entry.kind)?;
            let actions: Vec<_> = catalog
                .actions
                .iter()
                .filter(|action| {
                    action.resource_kind == entry.kind
                        && definition.workspace_scoped
                        && action.grant_relation.as_ref().is_some_and(|name| {
                            definition.relations.iter().any(|relation| {
                                &relation.name == name
                                    && relation.subjects.iter().any(|subject| subject == "human")
                            })
                        })
                })
                .map(|action| action.id.clone())
                .collect();
            if !actions.is_empty() {
                scopes.push(scope(
                    &workspace.id,
                    &proto::PlatformResource {
                        kind: entry.kind.clone(),
                        id: entry.id.clone(),
                        target: String::new(),
                    },
                    &actions,
                )?);
            }
        }
    }
    Ok(scopes)
}

pub(crate) async fn prepare_create(
    client: &Client,
    native: &Native,
    caller: &registry::ServiceRegistration,
    request: &proto::CreatePlatformAccessRequestRequest,
) -> Result<(), Status> {
    reason(&request.reason)?;
    let resource = request
        .resource
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("request resource required"))?;
    scope(&request.workspace_id, resource, &request.actions)?;
    let human = &request
        .requester
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("requester required"))?
        .human_id;
    if !enrolled(native, caller, &request.workspace_id, human).await? {
        return Err(Status::permission_denied(
            "workspace member and enrolled client required",
        ));
    }
    let workspace = decision::parse_uuid(&request.workspace_id)?;
    if client
        .query_one(
            "SELECT count(*) FROM ofz.platform_access_requests WHERE issuer_id=$1 AND state=1",
            &[human],
        )
        .await
        .map_err(sql_error)?
        .get::<_, i64>(0)
        >= 8
    {
        return Err(Status::resource_exhausted(
            "too many pending access requests",
        ));
    }
    if client
        .query_one(
            "SELECT count(*) FROM ofz.platform_access_requests WHERE workspace_id=$1 AND state=1",
            &[&workspace],
        )
        .await
        .map_err(sql_error)?
        .get::<_, i64>(0)
        >= 128
    {
        return Err(Status::resource_exhausted(
            "workspace access request queue is full",
        ));
    }
    if client.query_opt("SELECT id FROM ofz.platform_access_requests WHERE issuer_id=$1 AND client_service=$2 AND workspace_id=$3 AND scope_hash=$4 AND state=1", &[human, &caller.id, &workspace, &scope_hash(resource, &request.actions)?]).await.map_err(sql_error)?.is_some() {
        return Err(Status::already_exists("this access request is already pending"));
    }
    Ok(())
}

pub(crate) async fn prepare_review(
    client: &Client,
    native: &Native,
    request: &proto::ReviewPlatformAccessRequestRequest,
) -> Result<Vec<Update>, Status> {
    reason(&request.reason)?;
    let decision = proto::PlatformAccessRequestDecision::try_from(request.decision)
        .map_err(|_| Status::invalid_argument("approve or decline is required"))?;
    if decision == proto::PlatformAccessRequestDecision::Unspecified {
        return Err(Status::invalid_argument("approve or decline is required"));
    }
    let row = client.query_opt("SELECT issuer_id,client_service,resource,actions,state FROM ofz.platform_access_requests WHERE id=$1 AND workspace_id=$2", &[&decision::parse_uuid(&request.request_id)?, &decision::parse_uuid(&request.workspace_id)?]).await.map_err(sql_error)?
        .ok_or_else(|| Status::not_found("access request unavailable"))?;
    if row.get::<_, i16>(4) != proto::PlatformAccessRequestState::Pending as i16 {
        return Err(Status::failed_precondition(
            "access request is no longer pending",
        ));
    }
    if decision == proto::PlatformAccessRequestDecision::Decline {
        return Ok(Vec::new());
    }
    let human: String = row.get(0);
    let client_id: String = row.get(1);
    let caller = registry::configured()?
        .by_id(&client_id)
        .ok_or_else(|| Status::permission_denied("requesting client is no longer registered"))?;
    if !enrolled(native, caller, &request.workspace_id, &human).await? {
        return Err(Status::permission_denied(
            "requester or client is no longer enrolled",
        ));
    }
    let resource: proto::PlatformResource = store::decode(row.get(2))?;
    let actions: Vec<String> = store::decode(row.get(3))?;
    scope(&request.workspace_id, &resource, &actions)?;
    let catalog = catalog::configured()?;
    let definition = catalog.resource(&resource.kind)?;
    let mut changes = Vec::new();
    let mut relations = std::collections::BTreeSet::new();
    for action in &actions {
        if native
            .check(&authorization::resource_checks(
                &resource, action, "human", &human,
            )?)
            .await?
            .0
        {
            continue;
        }
        let relation = catalog
            .action(action)?
            .grant_relation
            .as_ref()
            .ok_or_else(|| Status::permission_denied("request action is no longer assignable"))?;
        if relations.insert(relation) {
            changes.push(Update::touch(Relationship::new(
                &definition.native_type,
                &resource.id,
                relation,
                "human",
                &human,
            )));
        }
    }
    Ok(changes)
}

pub(crate) async fn prepare_cancel(
    client: &Client,
    caller: &registry::ServiceRegistration,
    request: &proto::CancelPlatformAccessRequestRequest,
) -> Result<String, Status> {
    let row = client.query_opt("SELECT workspace_id,state FROM ofz.platform_access_requests WHERE id=$1 AND issuer_id=$2 AND client_service=$3", &[&decision::parse_uuid(&request.request_id)?, &request.requester.as_ref().ok_or_else(|| Status::unauthenticated("requester required"))?.human_id, &caller.id]).await.map_err(sql_error)?
        .ok_or_else(|| Status::not_found("access request unavailable"))?;
    if row.get::<_, i16>(1) != proto::PlatformAccessRequestState::Pending as i16 {
        return Err(Status::failed_precondition(
            "access request is no longer pending",
        ));
    }
    Ok(row.get::<_, Uuid>(0).to_string())
}

fn decode(row: Row) -> Result<proto::PlatformAccessRequest, Status> {
    let workspace_id = row.get::<_, Uuid>(3).to_string();
    let resource: proto::PlatformResource = store::decode(row.get(4))?;
    let workspace = registry::configured()?.workspace(&workspace_id)?;
    Ok(proto::PlatformAccessRequest {
        id: row.get::<_, Uuid>(0).to_string(),
        requester_human_id: row.get(1),
        client_service: row.get(2),
        scope: Some(proto::PlatformConnectionScope {
            workspace_id,
            workspace_name: workspace.name.clone(),
            resource_name: workspace
                .resources
                .iter()
                .find(|entry| entry.kind == resource.kind && entry.id == resource.id)
                .map(|entry| entry.name.clone())
                .unwrap_or_else(|| "Resource no longer available".into()),
            resource: Some(resource),
            actions: store::decode(row.get(5))?,
        }),
        reason: row.get(6),
        state: i32::from(row.get::<_, i16>(7)),
        decision_reason: row.get(8),
        created_at_unix_ms: row.get::<_, i64>(9) as u64,
        updated_at_unix_ms: row.get::<_, i64>(10) as u64,
    })
}

pub(crate) async fn for_member(
    client: &Client,
    human: &str,
    caller: &str,
    scopes: &[proto::PlatformConnectionScope],
) -> Result<Vec<proto::PlatformAccessRequest>, Status> {
    let mut result = Vec::new();
    for row in client.query("SELECT id,issuer_id,client_service,workspace_id,resource,actions,reason,state,decision_reason,created_at_ms,updated_at_ms FROM ofz.platform_access_requests WHERE issuer_id=$1 AND client_service=$2 ORDER BY (state=1) DESC,updated_at_ms DESC LIMIT 128", &[&human, &caller]).await.map_err(sql_error)? {
        let workspace_id = row.get::<_, Uuid>(3).to_string();
        if scopes.iter().any(|scope| scope.workspace_id == workspace_id) { result.push(decode(row)?); }
    }
    Ok(result)
}

pub async fn list(
    database: &Database,
    native: &Native,
    peer: &str,
    request: proto::ListPlatformAccessRequestsRequest,
) -> Result<proto::ListPlatformAccessRequestsResponse, Status> {
    onboarding::verify(database).await?;
    let session = request
        .administrator
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("administrator session required"))?;
    workspaces::gateway(peer, session)?;
    let trace = Uuid::new_v4().to_string();
    let (context, initial, _) =
        authorization::human_context(database, session, &trace, false).await?;
    workspaces::manage(native, &request.workspace_id, &session.human_id).await?;
    let connection = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("access request database unavailable"))?;
    let requests = connection.query("SELECT id,issuer_id,client_service,workspace_id,resource,actions,reason,state,decision_reason,created_at_ms,updated_at_ms FROM ofz.platform_access_requests WHERE workspace_id=$1 AND state=1 ORDER BY created_at_ms LIMIT 128", &[&decision::parse_uuid(&request.workspace_id)?]).await.map_err(sql_error)?.into_iter().map(decode).collect::<Result<Vec<_>, _>>()?;
    let mut receipt = store::receipt(
        &context,
        peer,
        policy::platform(),
        proto::Action::PolicyCheck,
        true,
        &trace,
        "list workspace access requests",
    );
    receipt.platform_workspace_id = request.workspace_id.clone();
    receipt.platform_action = "ofz.access_requests.list".into();
    database.audit(&receipt, "ofz.access_requests.list").await?;
    let (_, current, _) = authorization::human_context(database, session, &trace, false).await?;
    if current.version != initial.version
        || current.recovery_generation != initial.recovery_generation
    {
        return Err(Status::aborted("workspace authority changed"));
    }
    workspaces::manage(native, &request.workspace_id, &session.human_id).await?;
    Ok(proto::ListPlatformAccessRequestsResponse { requests })
}
