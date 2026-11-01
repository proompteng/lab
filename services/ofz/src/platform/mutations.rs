use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_postgres::Client;
use tonic::Status;
use uuid::Uuid;

use super::{authorization, catalog, connections, onboarding, workspaces};
use crate::{
    decision,
    native::{Native, Relationship, Update},
    policy, proto, registry,
    store::{self, Database, State, sql_error},
};

#[derive(Clone, Serialize, Deserialize)]
pub enum Command {
    Relationships(proto::WritePolicyRelationshipsRequest),
    PutConnection(proto::PutPlatformConnectionRequest),
    RevokeConnection(proto::RevokePlatformConnectionRequest),
    Create(proto::CreatePlatformDelegationRequest),
    Activate(proto::ActivatePlatformDelegationRequest),
    Revoke(proto::RevokePlatformDelegationRequest),
}
impl Command {
    fn session(&self) -> Option<&proto::PlatformHumanSession> {
        match self {
            Self::Relationships(r) => r.administrator.as_ref(),
            Self::PutConnection(r) => r.issuer.as_ref(),
            Self::RevokeConnection(r) => r.issuer.as_ref(),
            Self::Create(r) => r.issuer.as_ref(),
            Self::Activate(r) => r.issuer.as_ref(),
            Self::Revoke(r) => r.issuer.as_ref(),
        }
    }
    fn operation(&self) -> &str {
        match self {
            Self::Relationships(r) => &r.operation_id,
            Self::PutConnection(r) => &r.operation_id,
            Self::RevokeConnection(r) => &r.operation_id,
            Self::Create(r) => &r.operation_id,
            Self::Activate(r) => &r.operation_id,
            Self::Revoke(r) => &r.operation_id,
        }
    }
    fn action(&self) -> &str {
        match self {
            Self::Relationships(_) => "ofz.relationships.write",
            Self::PutConnection(_) => "ofz.connections.put",
            Self::RevokeConnection(_) => "ofz.connections.revoke",
            Self::Create(_) => "ofz.delegations.create",
            Self::Activate(_) => "ofz.delegations.activate",
            Self::Revoke(_) => "ofz.delegations.revoke",
        }
    }
    fn fingerprint(&self) -> Result<Vec<u8>, Status> {
        let mut intent = self.clone();
        // Consent survives renewal; replay still checks the current session and runtime authority.
        if let Self::PutConnection(request) = &mut intent {
            if let Some(issuer) = &mut request.issuer {
                issuer.session_id.clear();
            }
            if let Some(binding) = &mut request.binding {
                binding.generation.clear();
            }
        }
        Ok(Sha256::digest(
            serde_json::to_vec(&intent)
                .map_err(|_| Status::invalid_argument("invalid platform command"))?,
        )
        .to_vec())
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
    #[serde(default)]
    workspace_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Outcome {
    pub delegation_id: String,
    pub decision: proto::PlatformDecision,
    #[serde(default)]
    pub version: u64,
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
        || !service.allows_origin(
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
    let connection_id = decision::parse_uuid(&request.connection_id)?;
    {
        let connection = database
            .pool
            .get()
            .await
            .map_err(|_| Status::unavailable("connection database unavailable"))?;
        let row = connection.query_opt("SELECT issuer_id,client_service,actions,resources,binding_service,binding_id,version,enabled,workspace_id FROM ofz.platform_connections WHERE id=$1", &[&connection_id]).await.map_err(sql_error)?
            .ok_or_else(|| Status::not_found("connection unavailable"))?;
        if row.get::<_, String>(0) != human || row.get::<_, String>(1) != client.id {
            return Err(Status::not_found("connection unavailable"));
        }
        if !row.get::<_, bool>(7)
            || row.get::<_, i64>(6) as u64 != request.expected_connection_version
        {
            return Err(Status::failed_precondition(
                "connection is disabled or changed",
            ));
        }
        let actions: Vec<String> = store::decode(row.get(2))?;
        let resources: Vec<proto::PlatformResource> = store::decode(row.get(3))?;
        let (service, id) = connections::stable_binding(request.binding.as_ref());
        if row
            .get::<_, Option<Uuid>>(8)
            .map(|id| id.to_string())
            .as_deref()
            != Some(&workspaces::resource_workspace_id(&request.resources)?)
        {
            return Err(Status::permission_denied("connection workspace changed"));
        }
        if request.actions != actions
            || request.resources != resources
            || service != row.get::<_, String>(4)
            || id != row.get::<_, String>(5)
        {
            return Err(Status::permission_denied(
                "credential scope differs from saved connection",
            ));
        }
    }
    connections::scope_authority(
        database,
        native,
        client,
        &request.actions,
        &request.resources,
        request.binding.as_ref(),
        human,
    )
    .await
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
        authorization::human_context(database, session, command.operation(), false).await?;
    let fingerprint = command.fingerprint()?;
    let mut connection = database.command_connection().await?;
    crate::commands::reconcile(database, native, &mut connection.client).await?;
    let client = &mut connection.client;
    onboarding::verify(database).await?;
    if let Some(row)=client.query_opt("SELECT workload_id,fingerprint,response FROM ofz.platform_commands WHERE operation_id=$1 AND completed", &[&operation]).await.map_err(sql_error)? {
        if row.get::<_,String>(0)!=peer || row.get::<_,Vec<u8>>(1)!=fingerprint {return Err(Status::already_exists("operation ID belongs to another command"));}
        if let Command::PutConnection(request) = &command {
            connections::scope_authority(database,native,caller,&request.actions,&request.resources,request.binding.as_ref(),&session.human_id).await?;
        }
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
        workspace_id: String::new(),
    };
    let mut credential = String::new();
    let validation:Result<(),Status>=async {
    match &command {
        Command::Relationships(request) => {
            if request.expected_policy_version != current.version {
                return Err(Status::aborted("policy version conflict"));
            }
            if !(1..=128).contains(&request.relationships.len())
                || request.reason.trim().len() < 3 || request.reason.len() > 512
                || request.reason.contains(['\0', '\n', '\r'])
            {
                return Err(Status::invalid_argument(
                    "bounded relationships and audit reason required",
                ));
            }
            prepared.workspace_id = request.workspace_id.clone();
            workspaces::manage(native, &request.workspace_id, &session.human_id).await?;
            authorization::human_context(database, session, command.operation(), true).await?;
            workspaces::membership_changes(native, &request.workspace_id, &request.relationships).await?;
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
                workspaces::resource_scope(&request.workspace_id, resource)?;
                if relationship.subject_kind == "workspace" && relationship.subject_id != request.workspace_id {
                    return Err(Status::permission_denied("workspace grant cannot reference another workspace"));
                }
                let (subject_kind, subject) = workspaces::subject(&relationship.subject_kind, &relationship.subject_id)?;
                if !keys.insert((
                    &resource.kind,
                    &resource.id,
                    &relationship.relation,
                    &relationship.subject_kind,
                    &relationship.subject_id,
                )) {
                    return Err(Status::invalid_argument("duplicate relationship"));
                }
                if resource.kind != "platform.workspace" && relationship.subject_kind != "workspace" && relationship.enabled
                    && !native.check(&[crate::native::Check::new("platform_workspace", &request.workspace_id, "use", subject_kind, &subject)]).await?.0 {
                    return Err(Status::permission_denied("policy recipient is not enrolled in this workspace"));
                }
                let native = Relationship::new(
                    &definition.native_type,
                    &resource.id,
                    &relationship.relation,
                    subject_kind,
                    &subject,
                );
                prepared.changes.push(if relationship.enabled {
                    Update::touch(native)
                } else {
                    Update::delete(native)
                });
            }
        }
        Command::PutConnection(request) => {
            let id = decision::parse_uuid(&request.connection_id)?;
            if request.client_service != caller.id
                || request.client_reference.is_empty() || request.client_reference.len() > 256
                || !request.client_reference.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/_-.".contains(&byte))
                || request.expected_version >= i64::MAX as u64
            {
                return Err(Status::invalid_argument("invalid connection intent"));
            }
            let previous = client.query_opt("SELECT issuer_id,client_service,client_reference,version,workspace_id FROM ofz.platform_connections WHERE id=$1", &[&id]).await.map_err(sql_error)?;
            prepared.workspace_id = workspaces::resource_workspace_id(&request.resources)?;
            decision::parse_uuid(&prepared.workspace_id)?;
            if let Some(row) = previous {
                if row.get::<_, Option<Uuid>>(4).map(|id| id.to_string()).as_deref() != Some(&prepared.workspace_id) {
                    return Err(Status::permission_denied("connection workspace changed"));
                }
                if row.get::<_, String>(0) != session.human_id || row.get::<_, String>(1) != caller.id {
                    return Err(Status::not_found("connection unavailable"));
                }
                if row.get::<_, String>(2) != request.client_reference || row.get::<_, i64>(3) as u64 != request.expected_version {
                    return Err(Status::aborted("connection version or reference changed"));
                }
            } else if request.expected_version != 0 {
                return Err(Status::not_found("connection unavailable"));
            }
            if client.query_opt("SELECT id FROM ofz.platform_connections WHERE issuer_id=$1 AND client_service=$2 AND client_reference=$3 AND id<>$4", &[&session.human_id,&caller.id,&request.client_reference,&id]).await.map_err(sql_error)?.is_some() {
                return Err(Status::already_exists("connection reference already exists"));
            }
            connections::scope_authority(database,native,caller,&request.actions,&request.resources,request.binding.as_ref(),&session.human_id).await?;
        }
        Command::RevokeConnection(request) => {
            let id = decision::parse_uuid(&request.connection_id)?;
            let row = client.query_opt("SELECT issuer_id,client_service,workspace_id FROM ofz.platform_connections WHERE id=$1", &[&id]).await.map_err(sql_error)?
                .ok_or_else(|| Status::not_found("connection unavailable"))?;
            if request.client_service != caller.id || row.get::<_, String>(0) != session.human_id || row.get::<_, String>(1) != caller.id {
                return Err(Status::not_found("connection unavailable"));
            }
            prepared.workspace_id = row.get::<_, Option<Uuid>>(2).map(|id| id.to_string()).unwrap_or_default();
        }
        Command::Create(request) => {
            prepared.workspace_id = workspaces::resource_workspace_id(&request.resources)?;
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
                > authorization::human_context(database, session, command.operation(), false)
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
            let row=client.query_opt("SELECT d.issuer_id,d.client_service,d.agent_id,d.actions,d.resources,d.binding,d.expires_at_ms,d.proof_key_thumbprint,d.connection_id,d.connection_version,d.workspace_id FROM ofz.platform_delegations d JOIN ofz.platform_connections c ON c.id=d.connection_id AND c.enabled AND c.version=d.connection_version AND c.last_delegation_id=d.id WHERE d.id=$1 AND NOT d.revoked AND d.recovery_generation=$2 AND d.expires_at_ms>ofz.now_ms()", &[&decision::parse_uuid(&request.delegation_id)?,&(current.recovery_generation as i64)]).await.map_err(sql_error)?.ok_or_else(||Status::permission_denied("delegation is not available for activation"))?;
            if row.get::<_, String>(0) != session.human_id
                || row.get::<_, String>(1) != caller.id
                || row.get::<_, String>(7) != request.proof_key_thumbprint
            {
                return Err(Status::permission_denied(
                    "delegation installation acknowledgement differs",
                ));
            }
            prepared.workspace_id = row.get::<_, Option<Uuid>>(10).map(|id| id.to_string()).unwrap_or_default();
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
                connection_id: row.get::<_, Uuid>(8).to_string(),
                expected_connection_version: row.get::<_, i64>(9) as u64,
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
            let row=client.query_opt("SELECT issuer_id,client_service,agent_id,workspace_id FROM ofz.platform_delegations WHERE id=$1", &[&decision::parse_uuid(&request.delegation_id)?]).await.map_err(sql_error)?.ok_or_else(||Status::not_found("delegation not found"))?;
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
            prepared.workspace_id = row.get::<_, Option<Uuid>>(3).map(|id| id.to_string()).unwrap_or_default();
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
        receipt.platform_workspace_id = prepared.workspace_id.clone();
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
        Command::PutConnection(r) => {
            let id = decision::parse_uuid(&r.connection_id)?;
            let issuer = &r
                .issuer
                .as_ref()
                .ok_or_else(|| Status::internal("prepared issuer missing"))?
                .human_id;
            let (binding_service, binding_id) = connections::stable_binding(r.binding.as_ref());
            let version = (r.expected_version + 1) as i64;
            let generation = (prepared.version + 1) as i64;
            let changed = if r.expected_version == 0 {
                tx.execute("INSERT INTO ofz.platform_connections(id,issuer_id,client_service,client_reference,actions,resources,binding_service,binding_id,version,enabled,credential_generation,recovery_generation,workspace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,true,$9,$10,$11)", &[&id,issuer,&r.client_service,&r.client_reference,&store::encode(&r.actions)?,&store::encode(&r.resources)?,&binding_service,&binding_id,&generation,&(prepared.recovery_generation as i64),&decision::parse_uuid(&prepared.workspace_id)?]).await.map_err(sql_error)?
            } else {
                tx.execute("UPDATE ofz.platform_connections SET actions=$5,resources=$6,binding_service=$7,binding_id=$8,version=$9,enabled=true,last_delegation_id=NULL,credential_generation=$10,recovery_generation=$11,updated_at_ms=ofz.now_ms() WHERE id=$1 AND issuer_id=$2 AND client_service=$3 AND version=$4", &[&id,issuer,&r.client_service,&(r.expected_version as i64),&store::encode(&r.actions)?,&store::encode(&r.resources)?,&binding_service,&binding_id,&version,&generation,&(prepared.recovery_generation as i64)]).await.map_err(sql_error)?
            };
            if changed != 1 {
                return Err(Status::aborted("connection version changed"));
            }
            tx.execute("UPDATE ofz.platform_delegations SET revoked=true,active=false WHERE connection_id=$1", &[&id]).await.map_err(sql_error)?;
        }
        Command::RevokeConnection(r) => {
            let id = decision::parse_uuid(&r.connection_id)?;
            tx.execute("UPDATE ofz.platform_connections SET enabled=false,version=version+1,last_delegation_id=NULL,credential_generation=$2,recovery_generation=$3,updated_at_ms=ofz.now_ms() WHERE id=$1", &[&id,&((prepared.version+1) as i64),&(prepared.recovery_generation as i64)]).await.map_err(sql_error)?;
            tx.execute("UPDATE ofz.platform_delegations SET revoked=true,active=false WHERE connection_id=$1", &[&id]).await.map_err(sql_error)?;
        }
        Command::Create(r) => {
            let connection_id = decision::parse_uuid(&r.connection_id)?;
            let delegation_id = decision::parse_uuid(&prepared.delegation_id)?;
            tx.execute("UPDATE ofz.platform_delegations SET revoked=true,active=false WHERE connection_id=$1", &[&connection_id]).await.map_err(sql_error)?;
            tx.execute("INSERT INTO ofz.platform_delegations(id,operation_id,agent_id,issuer_id,client_service,credential_hash,proof_key_thumbprint,actions,resources,binding,expires_at_ms,recovery_generation,connection_id,connection_version,credential_generation,workspace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)", &[&delegation_id,&operation,&decision::parse_uuid(&r.agent_id)?,&r.issuer.as_ref().ok_or_else(||Status::internal("prepared issuer missing"))?.human_id,&r.client_service,&prepared.credential_hash,&r.proof_key_thumbprint,&store::encode(&r.actions)?,&store::encode(&r.resources)?,&store::encode(&r.binding)?,&(r.expires_at_unix_ms as i64),&(prepared.recovery_generation as i64),&connection_id,&(r.expected_connection_version as i64),&((prepared.version+1) as i64),&decision::parse_uuid(&prepared.workspace_id)?]).await.map_err(sql_error)?;
            if tx.execute("UPDATE ofz.platform_connections SET last_delegation_id=$2,credential_generation=$3,recovery_generation=$4,updated_at_ms=ofz.now_ms() WHERE id=$1 AND enabled AND version=$5", &[&connection_id,&delegation_id,&((prepared.version+1) as i64),&(prepared.recovery_generation as i64),&(r.expected_connection_version as i64)]).await.map_err(sql_error)? != 1 {
                return Err(Status::aborted("connection changed during credential issuance"));
            }
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
        match &prepared.command {
            Command::Relationships(request) => &request.reason,
            _ => "platform policy command",
        },
    );
    receipt.revision = revision.clone();
    receipt.platform_action = prepared.command.action().into();
    receipt.platform_workspace_id = prepared.workspace_id.clone();
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
        version: prepared.version + 1,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_consent_keeps_its_identity_across_verification_and_runtime_changes() {
        let request = proto::PutPlatformConnectionRequest {
            operation_id: Uuid::new_v4().to_string(),
            issuer: Some(proto::PlatformHumanSession {
                human_id: "1".repeat(64),
                session_id: Uuid::new_v4().to_string(),
                origin: "https://proompteng.ai".into(),
            }),
            client_service: "tengri-web".into(),
            connection_id: Uuid::new_v4().to_string(),
            client_reference: "workspace/galactic".into(),
            actions: vec!["kubernetes.status.read".into()],
            resources: vec![proto::PlatformResource {
                kind: "kubernetes.namespace".into(),
                id: "galactic/namespace".into(),
                ..Default::default()
            }],
            binding: Some(proto::PlatformBinding {
                service: "tengri".into(),
                id: "workspace".into(),
                generation: Uuid::new_v4().to_string(),
            }),
            ..Default::default()
        };
        let expected = Command::PutConnection(request.clone())
            .fingerprint()
            .unwrap();
        let mut renewed = request.clone();
        renewed.issuer.as_mut().unwrap().session_id = Uuid::new_v4().to_string();
        renewed.binding.as_mut().unwrap().generation = Uuid::new_v4().to_string();
        assert_eq!(
            Command::PutConnection(renewed).fingerprint().unwrap(),
            expected
        );
        let mut another_human = request.clone();
        another_human.issuer.as_mut().unwrap().human_id = "2".repeat(64);
        assert_ne!(
            Command::PutConnection(another_human).fingerprint().unwrap(),
            expected
        );
        let mut another_scope = request.clone();
        another_scope.actions.push("kubernetes.logs.read".into());
        assert_ne!(
            Command::PutConnection(another_scope).fingerprint().unwrap(),
            expected
        );
        let mut another_workspace = request.clone();
        another_workspace.binding.as_mut().unwrap().id = "another-workspace".into();
        assert_ne!(
            Command::PutConnection(another_workspace)
                .fingerprint()
                .unwrap(),
            expected
        );
        let mut another_origin = request;
        another_origin.issuer.as_mut().unwrap().origin = "https://another.example".into();
        assert_ne!(
            Command::PutConnection(another_origin)
                .fingerprint()
                .unwrap(),
            expected
        );
    }
}
