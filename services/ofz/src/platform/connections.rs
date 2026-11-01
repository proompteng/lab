use super::{authorization, catalog, onboarding};
use crate::{
    native::{Check, Native, Relationship, Update},
    proto::{self, platform_subject},
    registry::{self, ServiceRegistration},
    store::{self, Database, sql_error},
};
use tonic::Status;
use uuid::Uuid;

pub(crate) fn stable_binding(binding: Option<&proto::PlatformBinding>) -> (&str, &str) {
    binding.map_or(("", ""), |binding| (&binding.service, &binding.id))
}

pub(crate) async fn scope_authority(
    database: &Database,
    native: &Native,
    client: &ServiceRegistration,
    actions: &[String],
    resources: &[proto::PlatformResource],
    binding: Option<&proto::PlatformBinding>,
    human: &str,
) -> Result<(), Status> {
    if actions.is_empty() || actions.len() > 16 || resources.is_empty() || resources.len() > 16 {
        return Err(Status::invalid_argument(
            "bounded connection scope required",
        ));
    }
    let catalog = catalog::configured()?;
    let mut checks = authorization::binding_checks(database, client, binding, human).await?;
    checks.push(Check::new("platform", "lab", "admit", "human", human));
    let mut unique_actions = std::collections::BTreeSet::new();
    for action in actions {
        if !unique_actions.insert(action) {
            return Err(Status::invalid_argument("duplicate connection action"));
        }
        let definition = catalog.action(action)?;
        let matching: Vec<_> = resources
            .iter()
            .filter(|resource| resource.kind == definition.resource_kind)
            .collect();
        if matching.is_empty() {
            return Err(Status::invalid_argument(
                "connection action has no resource",
            ));
        }
        for resource in matching {
            checks.push(authorization::resource_check(
                resource, action, "human", human,
            )?);
        }
    }
    let mut unique_resources = std::collections::BTreeSet::new();
    for resource in resources {
        if !unique_resources.insert((&resource.kind, &resource.id, &resource.target)) {
            return Err(Status::invalid_argument("duplicate connection resource"));
        }
        if !actions.iter().any(|action| {
            catalog
                .action(action)
                .is_ok_and(|action| action.resource_kind == resource.kind)
        }) {
            return Err(Status::invalid_argument(
                "connection resource has no action",
            ));
        }
    }
    if !native.check(&checks).await?.0 {
        return Err(Status::permission_denied(
            "issuer lacks connection authority",
        ));
    }
    Ok(())
}

pub(crate) async fn connection_changes(
    database: &Database,
    native: &Native,
    client: &ServiceRegistration,
    request: &proto::PutPlatformConnectionRequest,
    human: &str,
) -> Result<Vec<Update>, Status> {
    match scope_authority(
        database,
        native,
        client,
        &request.actions,
        &request.resources,
        request.binding.as_ref(),
        human,
    )
    .await
    {
        Ok(()) => return Ok(Vec::new()),
        Err(error) if error.code() != tonic::Code::PermissionDenied => return Err(error),
        Err(_) => {}
    }
    if !client
        .roles
        .iter()
        .any(|role| role == "platform.administration")
    {
        return Err(Status::permission_denied(
            "administrator approval required for this connection scope",
        ));
    }
    let mut checks =
        authorization::binding_checks(database, client, request.binding.as_ref(), human).await?;
    checks.push(Check::new("platform", "lab", "admit", "human", human));
    checks.push(Check::new(
        "platform",
        "lab",
        "manage_targets",
        "human",
        human,
    ));
    if !native.check(&checks).await?.0 {
        return Err(Status::permission_denied(
            "administrator approval required for this connection scope",
        ));
    }
    let catalog = catalog::configured()?;
    let mut changes = Vec::new();
    let mut keys = std::collections::BTreeSet::new();
    for action in &request.actions {
        let action = catalog.action(action)?;
        let resource = catalog.resource(&action.resource_kind)?;
        let relation = action
            .grant_relation
            .as_ref()
            .and_then(|name| {
                resource.relations.iter().find(|relation| {
                    &relation.name == name
                        && relation.subjects.iter().any(|subject| subject == "human")
                })
            })
            .ok_or_else(|| {
                Status::permission_denied(
                    "selected action requires a separately assigned permission",
                )
            })?;
        for target in request
            .resources
            .iter()
            .filter(|target| target.kind == action.resource_kind)
        {
            if keys.insert((&resource.native_type, &target.id, &relation.name)) {
                changes.push(Update::touch(Relationship::new(
                    &resource.native_type,
                    &target.id,
                    &relation.name,
                    "human",
                    human,
                )));
            }
        }
    }
    if changes.len() > 128 {
        return Err(Status::invalid_argument(
            "connection permission changes exceed their limit",
        ));
    }
    Ok(changes)
}

pub(crate) async fn list(
    database: &Database,
    native: &Native,
    peer: &str,
    request: proto::ListPlatformConnectionsRequest,
) -> Result<proto::ListPlatformConnectionsResponse, Status> {
    onboarding::verify(database).await?;
    let issuer = request
        .issuer
        .ok_or_else(|| Status::unauthenticated("human session required"))?;
    let subject = proto::PlatformSubject {
        client_service: request.client_service.clone(),
        identity: Some(platform_subject::Identity::Human(issuer.clone())),
    };
    let client = authorization::caller(peer, &subject, registry::configured()?)?;
    if !client.allows_origin(&issuer.origin) {
        return Err(Status::permission_denied(
            "registered human gateway required",
        ));
    }
    let trace = Uuid::new_v4().to_string();
    let (_, initial, _) = authorization::human_context(database, &issuer, &trace, false).await?;
    if initial.fenced || !initial.archive_healthy {
        return Err(Status::unavailable("connection authority is fenced"));
    }
    let admitted = [Check::new(
        "platform",
        "lab",
        "admit",
        "human",
        &issuer.human_id,
    )];
    if !native.check(&admitted).await?.0 {
        return Err(Status::permission_denied("platform membership required"));
    }
    let (binding_service, binding_id) = stable_binding(request.binding.as_ref());
    if binding_service.len() > 128
        || binding_id.len() > 256
        || binding_service.is_empty() != binding_id.is_empty()
    {
        return Err(Status::invalid_argument(
            "invalid connection binding filter",
        ));
    }
    let connections = {
        let connection = database
            .pool
            .get()
            .await
            .map_err(|_| Status::unavailable("connection database unavailable"))?;
        let rows = connection.query(
            "SELECT c.id,c.client_reference,c.actions,c.resources,c.binding_service,c.binding_id,c.version,c.enabled,c.last_delegation_id,c.credential_generation,c.recovery_generation,d.binding,d.proof_key_thumbprint,d.expires_at_ms,COALESCE(c.enabled AND d.active AND NOT d.revoked AND d.connection_version=c.version AND d.recovery_generation=$5 AND d.expires_at_ms>ofz.now_ms(),false) FROM ofz.platform_connections c LEFT JOIN ofz.platform_delegations d ON d.id=c.last_delegation_id WHERE c.issuer_id=$1 AND c.client_service=$2 AND ($3='' OR (c.binding_service=$3 AND c.binding_id=$4)) ORDER BY c.client_reference,c.id LIMIT 129",
            &[&issuer.human_id, &client.id, &binding_service, &binding_id, &(initial.recovery_generation as i64)],
        ).await.map_err(sql_error)?;
        if rows.len() > 128 {
            return Err(Status::resource_exhausted(
                "connection list requires a narrower binding",
            ));
        }
        rows.into_iter()
            .map(|row| {
                let service: String = row.get(4);
                let binding = if service.is_empty() {
                    None
                } else {
                    Some(proto::PlatformBinding {
                        service,
                        id: row.get(5),
                        generation: String::new(),
                    })
                };
                let expiry = row
                    .get::<_, Option<i64>>(13)
                    .map(u64::try_from)
                    .transpose()
                    .map_err(|_| Status::unavailable("invalid stored credential expiry"))?
                    .unwrap_or_default();
                Ok(proto::PlatformConnection {
                    id: row.get::<_, Uuid>(0).to_string(),
                    client_service: client.id.clone(),
                    client_reference: row.get(1),
                    actions: store::decode(row.get(2))?,
                    resources: store::decode(row.get(3))?,
                    binding,
                    version: row.get::<_, i64>(6) as u64,
                    enabled: row.get(7),
                    delegation_id: row
                        .get::<_, Option<Uuid>>(8)
                        .map(|id| id.to_string())
                        .unwrap_or_default(),
                    credential_generation: row.get::<_, i64>(9) as u64,
                    recovery_generation: row.get::<_, i64>(10) as u64,
                    credential_binding: match row.get::<_, Option<serde_json::Value>>(11) {
                        Some(value) => store::decode(value)?,
                        None => None,
                    },
                    proof_key_thumbprint: row.get::<_, Option<String>>(12).unwrap_or_default(),
                    expires_at_unix_ms: expiry,
                    credential_active: row.get(14),
                })
            })
            .collect::<Result<Vec<_>, Status>>()?
    };
    let (_, current, _) = authorization::human_context(database, &issuer, &trace, false).await?;
    if current.version != initial.version
        || current.recovery_generation != initial.recovery_generation
        || !native.check(&admitted).await?.0
    {
        return Err(Status::aborted(
            "connection authority changed during listing",
        ));
    }
    onboarding::verify(database).await?;
    Ok(proto::ListPlatformConnectionsResponse {
        connections,
        recovery_generation: current.recovery_generation,
    })
}
