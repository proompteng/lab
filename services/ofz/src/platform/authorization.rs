use sha2::{Digest, Sha256};
use tonic::Status;
use uuid::Uuid;

use super::{catalog, onboarding};
use crate::{
    decision,
    native::{Check, Native},
    policy,
    proto::{self, actor::Identity, platform_subject},
    registry::{self, ServiceRegistration},
    store::{self, Database, State, sql_error},
};

pub struct Evaluation {
    pub context: proto::RequestContext,
    pub allowed: bool,
    pub revision: String,
    pub valid_until: u64,
    pub state: State,
}

pub fn resource_check(
    resource: &proto::PlatformResource,
    action: &str,
    kind: &str,
    subject: &str,
) -> Result<Check, Status> {
    if resource.id.is_empty()
        || resource.id.len() > 256
        || !resource
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_|-=+".contains(&b))
        || resource.target.len() > 1024
        || resource.target.contains(['\0', '\n', '\r'])
    {
        return Err(Status::invalid_argument(
            "invalid platform resource identity or target",
        ));
    }
    let catalog = catalog::configured()?;
    let action = catalog.action(action)?;
    if action.resource_kind != resource.kind {
        return Err(Status::permission_denied(
            "action does not apply to this resource",
        ));
    }
    Ok(Check::new(
        &catalog.resource(&resource.kind)?.native_type,
        &resource.id,
        &action.permission,
        kind,
        subject,
    ))
}

pub fn caller<'a>(
    peer: &str,
    subject: &proto::PlatformSubject,
    registry: &'a registry::Registry,
) -> Result<&'a ServiceRegistration, Status> {
    let client = registry
        .by_id(&subject.client_service)
        .ok_or_else(|| Status::permission_denied("unregistered client service"))?;
    if !client.roles.iter().any(|role| role == "platform.client") {
        return Err(Status::permission_denied(
            "service is not a platform client",
        ));
    }
    if registry.has_role(peer, "relay.executor")
        && !client.roles.iter().any(|role| role == "relay.client")
    {
        return Err(Status::permission_denied(
            "client is not enrolled for Relay execution",
        ));
    }
    if !client.identities.iter().any(|identity| identity == peer)
        && !registry.has_role(peer, "relay.executor")
    {
        return Err(Status::permission_denied(
            "caller cannot assert another client identity",
        ));
    }
    Ok(client)
}

pub async fn human_context(
    database: &Database,
    session: &proto::PlatformHumanSession,
    operation: &str,
    administration: bool,
) -> Result<(proto::RequestContext, State, u64), Status> {
    let state = database.state().await?;
    let context = proto::RequestContext {
        actor: Some(proto::Actor {
            identity: Some(Identity::HumanId(session.human_id.clone())),
        }),
        session_id: session.session_id.clone(),
        origin: session.origin.clone(),
        trace_id: operation.into(),
        deadline_unix_ms: state.now_ms + 25_000,
        contract_version: crate::CONTRACT_VERSION,
        ..Default::default()
    };
    context
        .actor
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("human actor required"))?
        .subject()?;
    let expiry = decision::session(
        database,
        &context,
        if administration {
            proto::Action::TargetsManage
        } else {
            proto::Action::WorkspaceMetadataRead
        },
        &state,
    )
    .await?;
    Ok((context, state, expiry))
}

pub async fn binding_checks(
    database: &Database,
    client: &ServiceRegistration,
    binding: Option<&proto::PlatformBinding>,
    human: &str,
) -> Result<Vec<Check>, Status> {
    match (&client.binding, binding) {
        (None, None) => Ok(Vec::new()),
        (Some(policy), Some(binding))
            if binding.service == policy.service
                && !binding.id.is_empty()
                && !binding.generation.is_empty() =>
        {
            let connection = database
                .pool
                .get()
                .await
                .map_err(|_| Status::unavailable("binding database pool unavailable"))?;
            let row = connection.query_opt("SELECT issuer_id FROM ofz.platform_bindings WHERE service=$1 AND id=$2 AND generation=$3 AND active", &[&binding.service,&binding.id,&binding.generation]).await.map_err(sql_error)?
                .ok_or_else(|| Status::permission_denied("execution binding is no longer active"))?;
            if row.get::<_, String>(0) != human {
                return Err(Status::permission_denied(
                    "delegation issuer no longer owns this execution",
                ));
            }
            Ok(vec![resource_check(
                &proto::PlatformResource {
                    kind: policy.resource_kind.clone(),
                    id: binding.id.clone(),
                    target: String::new(),
                },
                &policy.action,
                "human",
                human,
            )?])
        }
        _ => Err(Status::permission_denied(
            "registered execution binding required",
        )),
    }
}

pub async fn evaluate(
    database: &Database,
    native: &Native,
    peer: &str,
    request: &proto::CheckPlatformAccessRequest,
    consume_proof: bool,
) -> Result<Evaluation, Status> {
    if !policy::canonical_uuid(&request.operation_id)
        || request.request_hash.len() != 32
        || request.resources.is_empty()
        || request.resources.len() > 16
    {
        return Err(Status::invalid_argument(
            "bounded resources, operation ID and request hash required",
        ));
    }
    onboarding::verify(database).await?;
    let registry = registry::configured()?;
    let subject = request
        .subject
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("platform subject required"))?;
    let client = caller(peer, subject, registry)?;
    let state = database.state().await?;
    if state.fenced || !state.archive_healthy {
        return Err(Status::unavailable("platform authorization is fenced"));
    }
    let mut context = proto::RequestContext {
        trace_id: request.operation_id.clone(),
        deadline_unix_ms: state.now_ms + 25_000,
        contract_version: crate::CONTRACT_VERSION,
        ..Default::default()
    };
    let mut valid_until = decision::decision_deadline(context.deadline_unix_ms, &state)?;
    let mut checks = Vec::new();
    match subject
        .identity
        .as_ref()
        .ok_or_else(|| Status::unauthenticated("platform subject identity required"))?
    {
        platform_subject::Identity::WorkloadId(identity) => {
            if !client.identities.contains(identity) || request.binding.is_some() {
                return Err(Status::permission_denied(
                    "invalid workload subject or binding",
                ));
            }
            context.actor = Some(proto::Actor {
                identity: Some(Identity::WorkloadId(identity.clone())),
            });
            let id = policy::workload_object_id(identity);
            for resource in &request.resources {
                checks.push(resource_check(resource, &request.action, "workload", &id)?);
            }
        }
        platform_subject::Identity::Human(session) => {
            if !client
                .roles
                .iter()
                .any(|role| role == "platform.human-session")
                || !client.origins.contains(&session.origin)
            {
                return Err(Status::permission_denied(
                    "client cannot assert this human session",
                ));
            }
            let (human, _, expiry) =
                human_context(database, session, &request.operation_id, false).await?;
            context = human;
            valid_until = valid_until.min(expiry);
            checks.push(Check::new(
                "platform",
                "lab",
                "admit",
                "human",
                &session.human_id,
            ));
            for resource in &request.resources {
                checks.push(resource_check(
                    resource,
                    &request.action,
                    "human",
                    &session.human_id,
                )?);
            }
        }
        platform_subject::Identity::Delegation(proof) => {
            if !registry.has_role(peer, "relay.executor") {
                return Err(Status::permission_denied(
                    "delegated execution requires Relay",
                ));
            }
            let id = decision::parse_uuid(&proof.delegation_id)?;
            let connection = database
                .pool
                .get()
                .await
                .map_err(|_| Status::unavailable("delegation database pool unavailable"))?;
            let row = connection.query_opt("SELECT agent_id,issuer_id,client_service,credential_hash,proof_key_thumbprint,actions,resources,binding,expires_at_ms,recovery_generation FROM ofz.platform_delegations WHERE id=$1 AND active AND NOT revoked AND expires_at_ms>ofz.now_ms()", &[&id]).await.map_err(sql_error)?
                .ok_or_else(|| Status::unauthenticated("active delegation required"))?;
            if row.get::<_, String>(2) != client.id
                || row.get::<_, Vec<u8>>(3) != Sha256::digest(proof.credential.as_bytes()).to_vec()
                || row.get::<_, i64>(9) as u64 != state.recovery_generation
            {
                return Err(Status::unauthenticated("invalid delegation authority"));
            }
            let actions: Vec<String> = store::decode(row.get(5))?;
            let resources: Vec<proto::PlatformResource> = store::decode(row.get(6))?;
            let binding: Option<proto::PlatformBinding> = store::decode(row.get(7))?;
            if !actions.contains(&request.action)
                || binding != request.binding
                || request.resources.iter().any(|resource| {
                    !resources.iter().any(|scope| {
                        scope.kind == resource.kind
                            && scope.id == resource.id
                            && (scope.target.is_empty() || scope.target == resource.target)
                    })
                })
            {
                return Err(Status::permission_denied(
                    "request exceeds its delegation scope",
                ));
            }
            let audience = client.proof_audience.as_deref().ok_or_else(|| {
                Status::failed_precondition("client has no registered proof audience")
            })?;
            let nonce = super::proof::authenticate_proof(
                &proof.proof,
                &proof.credential,
                &row.get::<_, String>(4),
                &request.request_hash,
                state.now_ms,
                audience,
            )?;
            if consume_proof {
                connection.execute("DELETE FROM ofz.replay WHERE ctid IN (SELECT ctid FROM ofz.replay WHERE domain='platform-dpop-v1' AND expires_at_ms<=ofz.now_ms() LIMIT 128)", &[]).await.map_err(sql_error)?;
                let hash = Sha256::digest(format!("{id}:{nonce}").as_bytes()).to_vec();
                if connection.execute("INSERT INTO ofz.replay(domain,nonce_hash,expires_at_ms) VALUES('platform-dpop-v1',$1,ofz.now_ms()+120000) ON CONFLICT DO NOTHING", &[&hash]).await.map_err(sql_error)? != 1 {
                    return Err(Status::unauthenticated("delegation proof was already used"));
                }
            }
            let issuer: String = row.get(1);
            let agent: Uuid = row.get(0);
            context.actor = Some(proto::Actor {
                identity: Some(Identity::AgentId(agent.to_string())),
            });
            context.grant_id = id.to_string();
            valid_until = valid_until.min(row.get::<_, i64>(8) as u64);
            checks.extend(binding_checks(database, client, binding.as_ref(), &issuer).await?);
            checks.push(Check::new(
                "platform_delegation",
                &id.to_string(),
                "use",
                "agent",
                &agent.to_string(),
            ));
            checks.push(Check::new(
                "platform_delegation",
                &id.to_string(),
                "issuer",
                "human",
                &issuer,
            ));
            checks.push(Check::new("platform", "lab", "admit", "human", &issuer));
            for resource in &request.resources {
                checks.push(resource_check(resource, &request.action, "human", &issuer)?);
            }
        }
    }
    let (allowed, revision) = native.check(&checks).await?;
    Ok(Evaluation {
        context,
        allowed,
        revision,
        valid_until,
        state,
    })
}

pub async fn check(
    database: &Database,
    native: &Native,
    peer: &str,
    request: proto::CheckPlatformAccessRequest,
) -> Result<proto::PlatformDecision, Status> {
    onboarding::verify(database).await?;
    if !request.audit_receipt_id.is_empty()
        && !registry::configured()?.has_role(peer, "relay.executor")
    {
        return Err(Status::permission_denied(
            "only an executor may revalidate an invocation",
        ));
    }
    let initial = evaluate(
        database,
        native,
        peer,
        &request,
        request.audit_receipt_id.is_empty(),
    )
    .await?;
    let target = serde_json::to_string(&(
        &request.action,
        &request.resources,
        &request.request_hash,
        &request.binding,
        request
            .subject
            .as_ref()
            .map(|subject| &subject.client_service),
    ))
    .map_err(|_| Status::invalid_argument("invalid platform audit binding"))?;
    let mut receipt = store::receipt(
        &initial.context,
        peer,
        policy::platform(),
        proto::Action::PolicyCheck,
        initial.allowed,
        &request.operation_id,
        "platform operation authorization",
    );
    receipt.revision = initial.revision;
    receipt.recovery_generation = initial.state.recovery_generation;
    receipt.platform_action = request.action.clone();
    receipt.platform_resources = request
        .resources
        .iter()
        .map(|resource| format!("{}/{}#{}", resource.kind, resource.id, resource.target))
        .collect();
    receipt.platform_client = request
        .subject
        .as_ref()
        .map(|subject| subject.client_service.clone())
        .unwrap_or_default();
    receipt.platform_request_hash = request.request_hash.clone();
    let recorded = if initial.allowed {
        database
            .observation_audit(&receipt, &target, &request.audit_receipt_id)
            .await?
    } else {
        database.audit(&receipt, &target).await?;
        receipt
    };
    if !initial.allowed {
        return Ok(proto::PlatformDecision {
            allowed: false,
            revision: recorded.revision,
            audit_receipt_id: recorded.id,
            recovery_generation: initial.state.recovery_generation,
            valid_until_unix_ms: initial.valid_until,
        });
    }
    let current = evaluate(database, native, peer, &request, false).await?;
    if !current.allowed
        || current.state.version != initial.state.version
        || current.state.recovery_generation != initial.state.recovery_generation
    {
        return Err(Status::permission_denied(
            "platform authority changed during authorization",
        ));
    }
    onboarding::verify(database).await?;
    Ok(proto::PlatformDecision {
        allowed: true,
        revision: recorded.revision,
        audit_receipt_id: recorded.id,
        recovery_generation: current.state.recovery_generation,
        valid_until_unix_ms: current.valid_until,
    })
}

pub async fn record_execution(
    database: &Database,
    peer: &str,
    request: proto::RecordPlatformExecutionRequest,
) -> Result<proto::RecordPlatformExecutionResponse, Status> {
    if !registry::configured()?.has_role(peer, "relay.executor") {
        return Err(Status::permission_denied("connector executor required"));
    }
    let operation = decision::parse_uuid(&request.operation_id)?;
    let authorization = decision::parse_uuid(&request.authorization_receipt_id)?;
    if request.request_hash.len() != 32
        || !matches!(
            request.outcome.as_str(),
            "started" | "succeeded" | "failed" | "withheld"
        )
        || (request.outcome == "started"
            && (request.upstream_status != 0 || !request.result_hash.is_empty()))
        || (request.outcome == "succeeded" && request.result_hash.len() != 32)
        || (!request.result_hash.is_empty() && request.result_hash.len() != 32)
        || request.upstream_status > 599
    {
        return Err(Status::invalid_argument(
            "invalid platform execution outcome",
        ));
    }
    let mut client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("execution audit database unavailable"))?;
    let tx = client.transaction().await.map_err(sql_error)?;
    let row = tx
        .query_opt(
            "SELECT receipt FROM ofz.audit WHERE id=$1 AND created_at_ms>ofz.now_ms()-60000",
            &[&authorization],
        )
        .await
        .map_err(sql_error)?
        .ok_or_else(|| Status::permission_denied("recent execution authorization required"))?;
    let mut receipt: proto::AuditReceipt = store::decode(row.get(0))?;
    let state = store::state(&*tx).await?;
    if !receipt.allowed
        || receipt.workload_id != peer
        || receipt.operation_id != operation.to_string()
        || receipt.platform_request_hash != request.request_hash
        || receipt.platform_action.is_empty()
        || receipt.recovery_generation != state.recovery_generation
    {
        return Err(Status::permission_denied(
            "execution outcome differs from its authorization",
        ));
    }
    let previous=tx.query_opt("SELECT authorization_receipt_id,outcome,upstream_status,result_hash,audit_receipt_id FROM ofz.platform_executions WHERE operation_id=$1 FOR UPDATE", &[&operation]).await.map_err(sql_error)?;
    if let Some(row) = &previous {
        if row.get::<_, Uuid>(0) != authorization || request.outcome == "started" {
            return Err(Status::already_exists("execution ID already used"));
        }
        if row.get::<_, String>(1) == request.outcome
            && row.get::<_, i32>(2) == request.upstream_status as i32
            && row.get::<_, Vec<u8>>(3) == request.result_hash
        {
            return Ok(proto::RecordPlatformExecutionResponse {
                audit_receipt_id: row.get::<_, Uuid>(4).to_string(),
            });
        }
        let withheld_after_success = row.get::<_, String>(1) == "succeeded"
            && request.outcome == "withheld"
            && row.get::<_, i32>(2) == request.upstream_status as i32
            && row.get::<_, Vec<u8>>(3) == request.result_hash;
        if !withheld_after_success && row.get::<_, String>(1) != "started" {
            return Err(Status::already_exists("execution already completed"));
        }
    } else if request.outcome != "started" {
        return Err(Status::failed_precondition(
            "execution has no durable start",
        ));
    }
    receipt.id = Uuid::new_v4().to_string();
    receipt.created_at_unix_ms = state.now_ms;
    receipt.reason = format!(
        "connector execution {} (upstream status {})",
        request.outcome, request.upstream_status
    );
    receipt.platform_action = format!("relay.execution.{}", request.outcome);
    receipt.allowed = request.outcome == "started" || request.outcome == "succeeded";
    let target = serde_json::to_string(&(&request.authorization_receipt_id, &request.result_hash))
        .map_err(|_| Status::internal("encode execution audit target"))?;
    store::record_audit(&*tx, &receipt, &target).await?;
    let statement = if request.outcome == "started" {
        "INSERT INTO ofz.platform_executions(operation_id,authorization_receipt_id,outcome,upstream_status,result_hash,audit_receipt_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(operation_id) DO NOTHING"
    } else {
        "UPDATE ofz.platform_executions SET outcome=$3,upstream_status=$4,result_hash=$5,audit_receipt_id=$6 WHERE operation_id=$1 AND authorization_receipt_id=$2"
    };
    let changed = tx
        .execute(
            statement,
            &[
                &operation,
                &authorization,
                &request.outcome,
                &(request.upstream_status as i32),
                &request.result_hash,
                &decision::parse_uuid(&receipt.id)?,
            ],
        )
        .await
        .map_err(sql_error)?;
    if changed != 1 {
        return Err(Status::already_exists("execution ID already used"));
    }
    tx.commit().await.map_err(sql_error)?;
    Ok(proto::RecordPlatformExecutionResponse {
        audit_receipt_id: receipt.id,
    })
}
