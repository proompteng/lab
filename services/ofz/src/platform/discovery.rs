use super::{authorization, catalog, onboarding};
use crate::{
    native::{Check, Native},
    policy, proto, registry,
    store::{self, Database},
};
use tonic::Status;
use uuid::Uuid;

pub(crate) async fn scopes(
    native: &Native,
    client: &registry::ServiceRegistration,
    kind: &str,
    subject: &str,
) -> Result<Vec<proto::PlatformConnectionScope>, Status> {
    let catalog = catalog::configured()?;
    let mut scopes = Vec::new();
    let mut checks = Vec::new();
    let mut candidates = Vec::new();
    for workspace in &registry::configured()?.workspaces {
        for entry in &workspace.resources {
            let resource = proto::PlatformResource {
                kind: entry.kind.clone(),
                id: entry.id.clone(),
                target: String::new(),
            };
            let index = scopes.len();
            for action in catalog
                .actions
                .iter()
                .filter(|action| action.resource_kind == resource.kind)
            {
                let start = checks.len();
                checks.extend(authorization::resource_checks(
                    &resource, &action.id, kind, subject,
                )?);
                if kind == "human" {
                    checks.push(Check::new("platform", "lab", "admit", "human", subject));
                }
                for identity in &client.identities {
                    checks.push(Check::new(
                        "platform_workspace",
                        &workspace.id,
                        "use",
                        "workload",
                        &policy::workload_object_id(identity),
                    ));
                }
                if checks.len() > 4096 {
                    return Err(Status::resource_exhausted(
                        "connection catalog exceeds its discovery budget",
                    ));
                }
                candidates.push((index, action.id.clone(), start..checks.len()));
            }
            scopes.push(proto::PlatformConnectionScope {
                workspace_id: workspace.id.clone(),
                workspace_name: workspace.name.clone(),
                resource: Some(resource),
                resource_name: entry.name.clone(),
                actions: Vec::new(),
            });
        }
    }
    let mut allowed = Vec::new();
    for checks in checks.chunks(64) {
        allowed.extend(native.check_each(checks).await?.0);
    }
    for (index, action, range) in candidates {
        if allowed[range].iter().all(|value| *value) {
            scopes[index].actions.push(action);
        }
    }
    scopes.retain(|scope| !scope.actions.is_empty());
    Ok(scopes)
}

pub async fn discover(
    database: &Database,
    native: &Native,
    peer: &str,
    request: proto::DiscoverPlatformAccessRequest,
) -> Result<proto::DiscoverPlatformAccessResponse, Status> {
    onboarding::verify(database).await?;
    let subject = request
        .subject
        .ok_or_else(|| Status::unauthenticated("discovery subject required"))?;
    let client = authorization::caller(peer, &subject, registry::configured()?)?;
    let trace = Uuid::new_v4().to_string();
    let mut state = database.state().await?;
    if state.fenced || !state.archive_healthy {
        return Err(Status::unavailable("connector discovery is fenced"));
    }
    let (kind, id, context) = match subject.identity.as_ref() {
        Some(proto::platform_subject::Identity::Human(session)) => {
            if !client.allows_origin(&session.origin) {
                return Err(Status::permission_denied(
                    "registered human gateway required",
                ));
            }
            let (context, current, _) =
                authorization::human_context(database, session, &trace, false).await?;
            state = current;
            ("human", session.human_id.clone(), context)
        }
        Some(proto::platform_subject::Identity::WorkloadId(identity))
            if client.identities.contains(identity) =>
        {
            (
                "workload",
                policy::workload_object_id(identity),
                proto::RequestContext {
                    actor: Some(proto::Actor {
                        identity: Some(proto::actor::Identity::WorkloadId(identity.clone())),
                    }),
                    trace_id: trace.clone(),
                    deadline_unix_ms: state.now_ms + 25_000,
                    contract_version: crate::CONTRACT_VERSION,
                    ..Default::default()
                },
            )
        }
        _ => {
            return Err(Status::permission_denied(
                "discovery requires a human session or attested workload",
            ));
        }
    };
    let scopes = scopes(native, client, kind, &id).await?;
    let mut receipt = store::receipt(
        &context,
        peer,
        policy::platform(),
        proto::Action::PolicyCheck,
        true,
        &trace,
        "discover authorized connector access",
    );
    receipt.platform_action = "ofz.access.discover".into();
    receipt.platform_client = client.id.clone();
    receipt.recovery_generation = state.recovery_generation;
    receipt.platform_resources = scopes
        .iter()
        .filter_map(|scope| scope.resource.as_ref())
        .map(|resource| format!("{}/{}", resource.kind, resource.id))
        .collect();
    database.audit(&receipt, "ofz.access.discover").await?;
    let current = if let Some(proto::platform_subject::Identity::Human(session)) =
        subject.identity.as_ref()
    {
        authorization::human_context(database, session, &trace, false)
            .await?
            .1
    } else {
        database.state().await?
    };
    if current.version != state.version
        || current.recovery_generation != state.recovery_generation
        || current.fenced
        || !current.archive_healthy
    {
        return Err(Status::aborted("discovery authority changed"));
    }
    onboarding::verify(database).await?;
    Ok(proto::DiscoverPlatformAccessResponse { scopes })
}
