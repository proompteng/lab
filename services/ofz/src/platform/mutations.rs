use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_postgres::Client;
use tonic::Status;
use uuid::Uuid;

use super::{authorization, catalog, onboarding};
use crate::{
    decision,
    native::{Check, Native, Relationship, Update},
    policy, proto, registry,
    store::{self, Database, State, sql_error},
};

#[derive(Clone, Serialize, Deserialize)]
pub enum Command {
    Relationships(proto::WritePolicyRelationshipsRequest),
    Create(proto::CreatePlatformDelegationRequest),
    Activate(proto::ActivatePlatformDelegationRequest),
    Revoke(proto::RevokePlatformDelegationRequest),
}
impl Command {
    fn session(&self) -> Option<&proto::PlatformHumanSession> {
        match self {
            Self::Relationships(r) => r.administrator.as_ref(),
            Self::Create(r) => r.issuer.as_ref(),
            Self::Activate(r) => r.issuer.as_ref(),
            Self::Revoke(r) => r.issuer.as_ref(),
        }
    }
    fn operation(&self) -> &str {
        match self {
            Self::Relationships(r) => &r.operation_id,
            Self::Create(r) => &r.operation_id,
            Self::Activate(r) => &r.operation_id,
            Self::Revoke(r) => &r.operation_id,
        }
    }
    fn action(&self) -> &str {
        match self {
            Self::Relationships(_) => "ofz.relationships.write",
            Self::Create(_) => "ofz.delegations.create",
            Self::Activate(_) => "ofz.delegations.activate",
            Self::Revoke(_) => "ofz.delegations.revoke",
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Prepared {
    command: Command,
    context: proto::RequestContext,
    peer: String,
    version: u64,
    recovery_generation: u64,
    changes: Vec<Update>,
    delegation_id: String,
    credential_hash: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Outcome {
    pub delegation_id: String,
    pub decision: proto::PlatformDecision,
    #[serde(skip)]
    pub credential: String,
}

fn identity(
    peer: &str,
    command: &Command,
) -> Result<&'static registry::ServiceRegistration, Status> {
    let service = registry::configured()?
        .service(peer)
        .ok_or_else(|| Status::permission_denied("registered service required"))?;
    let role = if matches!(command, Command::Relationships(_)) {
        "platform.administration"
    } else {
        "relay.client"
    };
    if !service.roles.iter().any(|r| r == role)
        || !service.roles.iter().any(|r| r == "platform.human-session")
        || !service.origins.contains(
            &command
                .session()
                .ok_or_else(|| Status::unauthenticated("human session required"))?
                .origin,
        )
    {
        return Err(Status::permission_denied(
            "service cannot administer this platform operation",
        ));
    }
    Ok(service)
}

async fn delegation_authority(
    database: &Database,
    native: &Native,
    client: &registry::ServiceRegistration,
    request: &proto::CreatePlatformDelegationRequest,
    human: &str,
    state: &State,
) -> Result<(), Status> {
    if request.client_service != client.id
        || !policy::canonical_uuid(&request.agent_id)
        || request.actions.is_empty()
        || request.actions.len() > 16
        || request.resources.is_empty()
        || request.resources.len() > 16
        || request.proof_key_thumbprint.len() != 43
        || !request
            .proof_key_thumbprint
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        || request.expires_at_unix_ms <= state.now_ms
        || request.expires_at_unix_ms > state.now_ms + 28_800_000
        || client.proof_audience.is_none()
    {
        return Err(Status::invalid_argument("invalid bounded delegation"));
    }
    let catalog = catalog::configured()?;
    let mut checks =
        authorization::binding_checks(database, client, request.binding.as_ref(), human).await?;
    checks.push(Check::new("platform", "lab", "admit", "human", human));
    let mut actions = std::collections::BTreeSet::new();
    for action in &request.actions {
        if !actions.insert(action) {
            return Err(Status::invalid_argument("duplicate delegation action"));
        }
        let definition = catalog.action(action)?;
        let matching: Vec<_> = request
            .resources
            .iter()
            .filter(|r| r.kind == definition.resource_kind)
            .collect();
        if matching.is_empty() {
            return Err(Status::invalid_argument(
                "delegation action has no resource",
            ));
        }
        for resource in matching {
            checks.push(authorization::resource_check(
                resource, action, "human", human,
            )?);
        }
    }
    for resource in &request.resources {
        if !request.actions.iter().any(|a| {
            catalog
                .action(a)
                .is_ok_and(|a| a.resource_kind == resource.kind)
        }) {
            return Err(Status::invalid_argument(
                "delegation resource has no action",
            ));
        }
    }
    if !native.check(&checks).await?.0 {
        return Err(Status::permission_denied(
            "issuer lacks delegated authority",
        ));
    }
    Ok(())
}

pub async fn execute(
    database: &Database,
    native: &Native,
    peer: &str,
    command: Command,
) -> Result<Outcome, Status> {
    let caller = identity(peer, &command)?;
    let operation = decision::parse_uuid(command.operation())?;
    let session = command
        .session()
        .ok_or_else(|| Status::unauthenticated("human session required"))?;
    let (context, state, _) =
        authorization::human_context(database, session, command.operation(), true).await?;
    let fingerprint = Sha256::digest(
        serde_json::to_vec(&command)
            .map_err(|_| Status::invalid_argument("invalid platform command"))?,
    )
    .to_vec();
    let mut connection = database.command_connection().await?;
    crate::commands::reconcile(database, native, &mut connection.client).await?;
    let client = &mut connection.client;
    onboarding::verify(database).await?;
    if let Some(row)=client.query_opt("SELECT workload_id,fingerprint,response FROM ofz.platform_commands WHERE operation_id=$1 AND completed", &[&operation]).await.map_err(sql_error)? {
        if row.get::<_,String>(0)!=peer || row.get::<_,Vec<u8>>(1)!=fingerprint {return Err(Status::already_exists("operation ID belongs to another command"));}
        return store::decode(row.get(2));
    }
    let current = store::state(client).await?;
    if state.version != current.version || state.recovery_generation != current.recovery_generation
    {
        return Err(Status::aborted("platform authority changed"));
    }
    if current.fenced || !current.archive_healthy {
        return Err(Status::unavailable("platform policy changes are fenced"));
    }
    let mut prepared = Prepared {
        command: command.clone(),
        context,
        peer: peer.into(),
        version: current.version,
        recovery_generation: current.recovery_generation,
        changes: Vec::new(),
        delegation_id: String::new(),
        credential_hash: Vec::new(),
    };
    let mut credential = String::new();
    let validation:Result<(),Status>=async {
    match &command {
        Command::Relationships(request) => {
            if request.expected_policy_version != current.version {
                return Err(Status::aborted("policy version conflict"));
            }
            if !(1..=128).contains(&request.relationships.len())
                || !(3..=512).contains(&request.reason.trim().len())
                || request.reason.contains(['\0', '\n', '\r'])
            {
                return Err(Status::invalid_argument(
                    "bounded relationships and audit reason required",
                ));
            }
            if !native
                .check(&[Check::new(
                    "platform",
                    "lab",
                    "manage_targets",
                    "human",
                    &session.human_id,
                )])
                .await?
                .0
            {
                return Err(Status::permission_denied(
                    "platform policy administrator required",
                ));
            }
            let catalog = catalog::configured()?;
            let mut keys = std::collections::BTreeSet::new();
            for relationship in &request.relationships {
                let resource = relationship
                    .resource
                    .as_ref()
                    .ok_or_else(|| Status::invalid_argument("relationship resource required"))?;
                if resource.id.is_empty()
                    || resource.id.len() > 256
                    || !resource
                        .id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"/_|-=+".contains(&b))
                    || !resource.target.is_empty()
                {
                    return Err(Status::invalid_argument(
                        "relationship must name a policy resource",
                    ));
                }
                let definition = catalog.resource(&resource.kind)?;
                let relation = definition
                    .relations
                    .iter()
                    .find(|r| r.name == relationship.relation)
                    .ok_or_else(|| {
                        Status::permission_denied("relation is not onboarded for writing")
                    })?;
                if !relation.subjects.contains(&relationship.subject_kind) {
                    return Err(Status::permission_denied(
                        "relationship subject kind is not onboarded",
                    ));
                }
                let subject = match relationship.subject_kind.as_str() {
                    "human" => {
                        proto::Actor {
                            identity: Some(proto::actor::Identity::HumanId(
                                relationship.subject_id.clone(),
                            )),
                        }
                        .subject()?;
                        relationship.subject_id.clone()
                    }
                    "workload" => {
                        if registry::configured()?
                            .service(&relationship.subject_id)
                            .is_none()
                        {
                            return Err(Status::permission_denied(
                                "relationship workload is not registered",
                            ));
                        }
                        policy::workload_object_id(&relationship.subject_id)
                    }
                    _ => {
                        return Err(Status::permission_denied(
                            "unsupported relationship subject",
                        ));
                    }
                };
                if !keys.insert((
                    &resource.kind,
                    &resource.id,
                    &relationship.relation,
                    &relationship.subject_kind,
                    &relationship.subject_id,
                )) {
                    return Err(Status::invalid_argument("duplicate relationship"));
                }
                let native = Relationship::new(
                    &definition.native_type,
                    &resource.id,
                    &relationship.relation,
                    &relationship.subject_kind,
                    &subject,
                );
                prepared.changes.push(if relationship.enabled {
                    Update::touch(native)
                } else {
                    Update::delete(native)
                });
            }
        }
        Command::Create(request) => {
            delegation_authority(
                database,
                native,
                caller,
                request,
                &session.human_id,
                &current,
            )
            .await?;
            if request.expires_at_unix_ms
                > authorization::human_context(database, session, command.operation(), true)
                    .await?
                    .2
            {
                return Err(Status::invalid_argument(
                    "delegation cannot outlive its issuing session",
                ));
            }
            prepared.delegation_id = Uuid::new_v4().to_string();
            let mut bytes = [0; 32];
            rand::rng().fill_bytes(&mut bytes);
            credential = URL_SAFE_NO_PAD.encode(bytes);
            prepared.credential_hash = Sha256::digest(credential.as_bytes()).to_vec();
        }
        Command::Activate(request) => {
            let row=client.query_opt("SELECT issuer_id,client_service,agent_id,actions,resources,binding,expires_at_ms,proof_key_thumbprint FROM ofz.platform_delegations WHERE id=$1 AND NOT revoked AND recovery_generation=$2 AND expires_at_ms>ofz.now_ms()", &[&decision::parse_uuid(&request.delegation_id)?,&(current.recovery_generation as i64)]).await.map_err(sql_error)?.ok_or_else(||Status::permission_denied("delegation is not available for activation"))?;
            if row.get::<_, String>(0) != session.human_id
                || row.get::<_, String>(1) != caller.id
                || row.get::<_, String>(7) != request.proof_key_thumbprint
            {
                return Err(Status::permission_denied(
                    "delegation installation acknowledgement differs",
                ));
            }
            let create = proto::CreatePlatformDelegationRequest {
                operation_id: request.operation_id.clone(),
                issuer: Some(session.clone()),
                client_service: row.get(1),
                agent_id: row.get::<_, Uuid>(2).to_string(),
                actions: store::decode(row.get(3))?,
                resources: store::decode(row.get(4))?,
                binding: store::decode(row.get(5))?,
                expires_at_unix_ms: row.get::<_, i64>(6) as u64,
                proof_key_thumbprint: row.get(7),
            };
            delegation_authority(
                database,
                native,
                caller,
                &create,
                &session.human_id,
                &current,
            )
            .await?;
            let mut subject = Relationship::new(
                "platform_delegation",
                &request.delegation_id,
                "subject",
                "agent",
                &create.agent_id,
            );
            subject.optional_expires_at =
                chrono::DateTime::from_timestamp_millis(create.expires_at_unix_ms as i64);
            prepared.changes = vec![
                Update::touch(subject),
                Update::touch(Relationship::new(
                    "platform_delegation",
                    &request.delegation_id,
                    "issuer",
                    "human",
                    &session.human_id,
                )),
            ];
            prepared.delegation_id = request.delegation_id.clone();
        }
        Command::Revoke(request) => {
            let row=client.query_opt("SELECT issuer_id,client_service,agent_id FROM ofz.platform_delegations WHERE id=$1", &[&decision::parse_uuid(&request.delegation_id)?]).await.map_err(sql_error)?.ok_or_else(||Status::not_found("delegation not found"))?;
            if row.get::<_, String>(0) != session.human_id || row.get::<_, String>(1) != caller.id {
                return Err(Status::permission_denied("delegation issuer required"));
            }
            prepared.changes = vec![Update::delete(Relationship::new(
                "platform_delegation",
                &request.delegation_id,
                "subject",
                "agent",
                &row.get::<_, Uuid>(2).to_string(),
            ))];
            prepared.delegation_id = request.delegation_id.clone();
        }
    }
    Ok(()) }.await;
    if let Err(mut error) = validation {
        let mut receipt = store::receipt(
            &prepared.context,
            peer,
            policy::platform(),
            proto::Action::PolicyCommand,
            false,
            &operation.to_string(),
            "platform policy command rejected",
        );
        receipt.platform_action = command.action().into();
        receipt.platform_client = caller.id.clone();
        receipt.platform_request_hash = fingerprint.clone();
        let audit = database.audit(&receipt, command.action()).await?;
        error.metadata_mut().insert(
            "x-ofz-audit-receipt",
            audit
                .parse()
                .map_err(|_| Status::internal("invalid audit receipt"))?,
        );
        return Err(error);
    }
    client.execute("INSERT INTO ofz.platform_commands(operation_id,workload_id,fingerprint,prepared) VALUES($1,$2,$3,$4)", &[&operation,&peer,&fingerprint,&store::encode(&prepared)?]).await.map_err(sql_error)?;
    let mut outcome = apply(native, client, &prepared).await?;
    outcome.credential = credential;
    Ok(outcome)
}

pub(crate) async fn recover(native: &Native, client: &mut Client) -> Result<(), Status> {
    for row in client
        .query(
            "SELECT prepared FROM ofz.platform_commands WHERE NOT completed",
            &[],
        )
        .await
        .map_err(sql_error)?
    {
        apply(native, client, &store::decode(row.get(0))?).await?;
    }
    Ok(())
}
async fn apply(
    native: &Native,
    client: &mut Client,
    prepared: &Prepared,
) -> Result<Outcome, Status> {
    let operation = decision::parse_uuid(prepared.command.operation())?;
    let state = store::state(client).await?;
    if state.version != prepared.version
        || state.recovery_generation != prepared.recovery_generation
    {
        return Err(Status::failed_precondition(
            "pending platform command requires recovery",
        ));
    }
    let marker = format!("platform-command/{operation}");
    let (applied, observed) = native.applied(&marker).await?;
    let revision = if applied {
        observed
    } else {
        native
            .apply(&marker, prepared.version, &prepared.changes)
            .await?
    };
    let tx = client.transaction().await.map_err(sql_error)?;
    match &prepared.command {
        Command::Create(r) => {
            tx.execute("INSERT INTO ofz.platform_delegations(id,operation_id,agent_id,issuer_id,client_service,credential_hash,proof_key_thumbprint,actions,resources,binding,expires_at_ms,recovery_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", &[&decision::parse_uuid(&prepared.delegation_id)?,&operation,&decision::parse_uuid(&r.agent_id)?,&r.issuer.as_ref().ok_or_else(||Status::internal("prepared issuer missing"))?.human_id,&r.client_service,&prepared.credential_hash,&r.proof_key_thumbprint,&store::encode(&r.actions)?,&store::encode(&r.resources)?,&store::encode(&r.binding)?,&(r.expires_at_unix_ms as i64),&(prepared.recovery_generation as i64)]).await.map_err(sql_error)?;
        }
        Command::Activate(_) => {
            tx.execute(
                "UPDATE ofz.platform_delegations SET active=true WHERE id=$1 AND NOT revoked",
                &[&decision::parse_uuid(&prepared.delegation_id)?],
            )
            .await
            .map_err(sql_error)?;
        }
        Command::Revoke(_) => {
            tx.execute(
                "UPDATE ofz.platform_delegations SET revoked=true,active=false WHERE id=$1",
                &[&decision::parse_uuid(&prepared.delegation_id)?],
            )
            .await
            .map_err(sql_error)?;
        }
        Command::Relationships(_) => {}
    }
    let mut receipt = store::receipt(
        &prepared.context,
        &prepared.peer,
        policy::platform(),
        proto::Action::PolicyCommand,
        true,
        &operation.to_string(),
        "platform policy command",
    );
    receipt.revision = revision.clone();
    receipt.platform_action = prepared.command.action().into();
    // Scope and relationship changes are inspectable without retaining delegated credentials.
    receipt.platform_resources = vec![
        serde_json::to_string(&prepared.command)
            .map_err(|_| Status::internal("encode platform policy audit"))?,
    ];
    store::record_audit(&tx, &receipt, prepared.command.action()).await?;
    if tx.execute("UPDATE ofz.platform_state SET version=version+1 WHERE singleton AND version=$1 AND recovery_generation=$2", &[&(prepared.version as i64),&(prepared.recovery_generation as i64)]).await.map_err(sql_error)?!=1 {return Err(Status::aborted("platform version changed"));}
    let outcome = Outcome {
        delegation_id: prepared.delegation_id.clone(),
        decision: proto::PlatformDecision {
            allowed: true,
            revision,
            audit_receipt_id: receipt.id,
            valid_until_unix_ms: state.now_ms + 2000,
            recovery_generation: prepared.recovery_generation,
        },
        credential: String::new(),
    };
    tx.execute(
        "UPDATE ofz.platform_commands SET completed=true,response=$1 WHERE operation_id=$2",
        &[&store::encode(&outcome)?, &operation],
    )
    .await
    .map_err(sql_error)?;
    tx.commit().await.map_err(sql_error)?;
    Ok(outcome)
}
