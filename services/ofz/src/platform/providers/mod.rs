#[cfg(test)]
pub(crate) mod integration;
mod protocol;
mod vault;

use std::{collections::BTreeMap, sync::OnceLock};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_postgres::Row;
use tonic::Status;
use uuid::Uuid;

use super::{authorization, executions, onboarding, requests, workspaces};
use crate::{
    decision,
    native::Native,
    policy, proto, registry,
    store::{self, Database, State, sql_error},
};
use protocol::{Account, Ownership, Profile, Protocol, Tokens};
use vault::Vault;

pub struct Providers {
    profiles: BTreeMap<String, Protocol>,
    vault: Option<Vault>,
}

#[derive(Serialize, Deserialize)]
struct Attempt {
    state: String,
    verifier: String,
    authorization_url: String,
    return_path: String,
    origin: String,
}

impl Providers {
    pub(crate) fn registrations(&self) -> Vec<proto::RegisteredProviderProfile> {
        self.profiles
            .values()
            .map(|protocol| proto::RegisteredProviderProfile {
                id: protocol.profile.id.clone(),
                connector_id: protocol.profile.connector_id.clone(),
                destination: protocol.profile.resource_url.clone(),
            })
            .collect()
    }
    pub fn disabled() -> Self {
        Self {
            profiles: BTreeMap::new(),
            vault: None,
        }
    }
    pub fn from_environment() -> anyhow::Result<Self> {
        let profiles = registrations()?.clone();
        if profiles.is_empty() {
            return Ok(Self::disabled());
        }
        let key = std::fs::read(std::env::var("OFZ_PROVIDER_CREDENTIAL_KEY_FILE")?)?;
        Self::new(profiles, &key)
    }
    fn new(profiles: Vec<Profile>, key: &[u8]) -> anyhow::Result<Self> {
        anyhow::ensure!(profiles.len() <= 64, "too many provider profiles");
        let mut configured = BTreeMap::new();
        let mut connectors = std::collections::BTreeSet::new();
        for profile in profiles {
            let protocol = Protocol::new(profile)?;
            anyhow::ensure!(
                connectors.insert(protocol.profile.connector_id.clone()),
                "provider profiles must have distinct connector IDs"
            );
            anyhow::ensure!(
                configured
                    .insert(protocol.profile.id.clone(), protocol)
                    .is_none(),
                "duplicate provider profile"
            );
        }
        Ok(Self {
            profiles: configured,
            vault: Some(Vault::new(key)?),
        })
    }
    fn profile(&self, id: &str) -> Result<&Protocol, Status> {
        self.profiles
            .get(id)
            .ok_or_else(|| Status::not_found("provider connection is not available"))
    }
    fn vault(&self) -> Result<&Vault, Status> {
        self.vault
            .as_ref()
            .ok_or_else(|| Status::failed_precondition("provider connections are not configured"))
    }
}

fn registrations() -> Result<&'static Vec<Profile>, Status> {
    static PROFILES: OnceLock<Result<Vec<Profile>, String>> = OnceLock::new();
    PROFILES
        .get_or_init(|| {
            let bytes = match std::env::var("OFZ_PROVIDER_PROFILES_FILE") {
                Ok(path) => std::fs::read(path)
                    .map_err(|_| "provider registration file unavailable".to_owned())?,
                Err(std::env::VarError::NotPresent) => {
                    include_bytes!("../../../platform/provider-profiles.json").to_vec()
                }
                Err(_) => return Err("invalid provider registration path".into()),
            };
            if bytes.len() > 262_144 {
                return Err("provider registrations exceed their byte budget".into());
            }
            let mut profiles: Vec<Profile> = serde_json::from_slice(&bytes)
                .map_err(|_| "invalid provider registrations".to_owned())?;
            if profiles.len() > 64 {
                return Err("too many provider registrations".into());
            }
            profiles.sort_by(|a, b| a.id.cmp(&b.id));
            let mut previous = None;
            let mut connectors = std::collections::BTreeSet::new();
            for profile in &profiles {
                if !connectors.insert(&profile.connector_id) {
                    return Err("provider profiles must have distinct connector IDs".into());
                }
                if previous == Some(&profile.id) {
                    return Err("duplicate provider profile".into());
                }
                Protocol::new(profile.clone())
                    .map_err(|_| "invalid registered provider profile".to_owned())?;
                previous = Some(&profile.id);
            }
            Ok(profiles)
        })
        .as_ref()
        .map_err(|message| Status::failed_precondition(message.clone()))
}

pub(crate) fn configuration_hash() -> Result<Vec<u8>, Status> {
    Ok(hash(serde_json::to_vec(registrations()?).map_err(
        |_| Status::internal("encode provider registrations"),
    )?))
}

fn hash(value: impl AsRef<[u8]>) -> Vec<u8> {
    Sha256::digest(value).to_vec()
}
fn opaque(value: &str) -> Result<Vec<u8>, Status> {
    if value.len() != 43
        || !URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == 32)
    {
        return Err(Status::invalid_argument("256-bit browser binding required"));
    }
    Ok(hash(value))
}
fn credential_binding(id: Uuid, profile_hash: &[u8]) -> Vec<u8> {
    [
        b"provider-credential/".as_slice(),
        id.as_bytes(),
        profile_hash,
    ]
    .concat()
}
fn attempt_binding(id: Uuid, operation: Uuid) -> Vec<u8> {
    [
        b"provider-attempt/".as_slice(),
        id.as_bytes(),
        operation.as_bytes(),
    ]
    .concat()
}
fn callback(profile: &Profile, origin: &str) -> String {
    format!(
        "{origin}/api/platform/provider-connections/callback/{}",
        profile.id
    )
}
fn owner(profile: &Profile, human: &str, client: &str) -> (String, String) {
    match profile.ownership {
        Ownership::Personal => (human.into(), client.into()),
        Ownership::Workspace => (profile.workspace_id.clone(), String::new()),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Inspect,
    Connect,
    Disconnect,
}

async fn owner_session(
    database: &Database,
    peer: &str,
    human: &proto::PlatformHumanSession,
    operation: &str,
) -> Result<
    (
        proto::RequestContext,
        State,
        &'static registry::ServiceRegistration,
    ),
    Status,
> {
    let client = registry::configured()?
        .service(peer)
        .ok_or_else(|| Status::permission_denied("registered gateway required"))?;
    if !client.allows_origin(&human.origin) {
        return Err(Status::permission_denied(
            "registered provider gateway required",
        ));
    }
    let (context, state, _) =
        authorization::human_context(database, human, operation, false).await?;
    if state.fenced || !state.archive_healthy {
        return Err(Status::unavailable(
            "provider connection changes are fenced",
        ));
    }
    Ok((context, state, client))
}

async fn authority(
    database: &Database,
    native: &Native,
    peer: &str,
    human: &proto::PlatformHumanSession,
    profile: &Profile,
    operation: &str,
    access: Access,
) -> Result<
    (
        proto::RequestContext,
        State,
        &'static registry::ServiceRegistration,
    ),
    Status,
> {
    let (context, state, client) = owner_session(database, peer, human, operation).await?;
    if profile.ownership == Ownership::Workspace
        && client
            .roles
            .iter()
            .any(|role| role == "platform.administration")
    {
        workspaces::manage(native, &profile.workspace_id, &human.human_id).await?;
    } else {
        if access != Access::Inspect && profile.ownership == Ownership::Workspace {
            return Err(Status::permission_denied(
                "workspace administrator must connect this account",
            ));
        }
        if !requests::enrolled(native, client, &profile.workspace_id, &human.human_id).await? {
            return Err(Status::permission_denied(
                "workspace member and enrolled client required",
            ));
        }
        if access == Access::Connect {
            let mut permitted = false;
            for action in &profile.actions {
                if native
                    .check(&authorization::resource_checks(
                        &profile.resource,
                        action,
                        "human",
                        &human.human_id,
                    )?)
                    .await?
                    .0
                {
                    permitted = true;
                    break;
                }
            }
            if !permitted {
                return Err(Status::permission_denied(
                    "provider account requires approved resource access",
                ));
            }
        }
    }
    onboarding::verify(database).await?;
    Ok((context, state, client))
}

fn metadata(protocol: &Protocol, row: Option<&Row>) -> Result<proto::ProviderConnection, Status> {
    let profile = &protocol.profile;
    let workspace = registry::configured()?.workspace(&profile.workspace_id)?;
    let resource = workspace
        .resources
        .iter()
        .find(|entry| entry.kind == profile.resource.kind && entry.id == profile.resource.id)
        .ok_or_else(|| Status::failed_precondition("provider resource is no longer registered"))?;
    let mut result = proto::ProviderConnection {
        profile_id: profile.id.clone(),
        name: profile.name.clone(),
        connector_id: profile.connector_id.clone(),
        scope: Some(proto::PlatformConnectionScope {
            workspace_id: profile.workspace_id.clone(),
            workspace_name: workspace.name.clone(),
            resource: Some(profile.resource.clone()),
            resource_name: resource.name.clone(),
            actions: profile.actions.clone(),
        }),
        workspace_managed: profile.ownership == Ownership::Workspace,
        provider_scopes: profile.scopes.clone(),
        state: proto::ProviderConnectionState::Disconnected as i32,
        ..Default::default()
    };
    if let Some(row) = row {
        result.connection_id = row.get::<_, Uuid>(0).to_string();
        let state: String = row.get(1);
        result.state = if state == "disconnected" {
            proto::ProviderConnectionState::Disconnected
        } else if state == "ready" && row.get::<_, Vec<u8>>(2) == protocol.fingerprint {
            proto::ProviderConnectionState::Ready
        } else {
            proto::ProviderConnectionState::Reconnect
        } as i32;
        if let Some(account) = row.get::<_, Option<serde_json::Value>>(3) {
            result.account_name = store::decode::<Account>(account)?.name;
        }
    }
    Ok(result)
}

impl Providers {
    pub async fn list(
        &self,
        database: &Database,
        native: &Native,
        peer: &str,
        request: proto::ListProviderConnectionsRequest,
    ) -> Result<proto::ListProviderConnectionsResponse, Status> {
        let human = request
            .human
            .as_ref()
            .ok_or_else(|| Status::unauthenticated("provider owner session required"))?;
        let trace = Uuid::new_v4().to_string();
        let gateway = registry::configured()?
            .service(peer)
            .ok_or_else(|| Status::permission_denied("registered provider gateway required"))?;
        if !gateway.allows_origin(&human.origin) {
            return Err(Status::permission_denied(
                "registered provider gateway required",
            ));
        }
        authorization::human_context(database, human, &trace, false).await?;
        if !native
            .check(&[crate::native::Check::new(
                "platform",
                "lab",
                "admit",
                "human",
                &human.human_id,
            )])
            .await?
            .0
        {
            return Err(Status::permission_denied("platform membership required"));
        }
        if !request.workspace_id.is_empty()
            && gateway
                .roles
                .iter()
                .any(|role| role == "platform.administration")
        {
            workspaces::manage(native, &request.workspace_id, &human.human_id).await?;
        }
        onboarding::verify(database).await?;
        let mut connections = Vec::new();
        for protocol in self.profiles.values() {
            let profile = &protocol.profile;
            if !request.workspace_id.is_empty() && request.workspace_id != profile.workspace_id {
                continue;
            }
            let (_, initial, caller) = match authority(
                database,
                native,
                peer,
                human,
                profile,
                &trace,
                Access::Inspect,
            )
            .await
            {
                Ok(authority) => authority,
                Err(error) if error.code() == tonic::Code::PermissionDenied => continue,
                Err(error) => return Err(error),
            };
            let (owner, client) = owner(profile, &human.human_id, &caller.id);
            let connection = database
                .pool
                .get()
                .await
                .map_err(|_| Status::unavailable("provider database unavailable"))?;
            let row = connection.query_opt("SELECT id,state,profile_hash,account FROM ofz.provider_connections WHERE workspace_id=$1 AND profile_id=$2 AND owner_id=$3 AND client_service=$4", &[&decision::parse_uuid(&profile.workspace_id)?, &profile.id, &owner, &client]).await.map_err(sql_error)?;
            let info = metadata(protocol, row.as_ref())?;
            let (context, current, _) = authority(
                database,
                native,
                peer,
                human,
                profile,
                &trace,
                Access::Inspect,
            )
            .await?;
            if initial.recovery_generation != current.recovery_generation {
                return Err(Status::aborted("provider authority changed"));
            }
            let receipt = provider_audit(
                &context,
                peer,
                profile,
                &trace,
                "ofz.providers.list",
                "provider connection viewed",
            );
            database.audit(&receipt, "ofz.providers.list").await?;
            connections.push(info);
        }
        Ok(proto::ListProviderConnectionsResponse { connections })
    }

    pub async fn begin(
        &self,
        database: &Database,
        native: &Native,
        peer: &str,
        request: proto::BeginProviderConnectionRequest,
    ) -> Result<proto::BeginProviderConnectionResponse, Status> {
        let protocol = self.profile(&request.profile_id)?;
        let profile = &protocol.profile;
        let operation = decision::parse_uuid(&request.operation_id)?;
        let human = request
            .human
            .as_ref()
            .ok_or_else(|| Status::unauthenticated("provider owner session required"))?;
        let binding_hash = opaque(&request.binding)?;
        if !request.return_path.starts_with('/')
            || request.return_path.starts_with("//")
            || request.return_path.len() > 2048
            || request.return_path.contains(['\\', '#'])
            || request.return_path.chars().any(char::is_control)
        {
            return Err(Status::invalid_argument(
                "local provider return path required",
            ));
        }
        let (context, _, caller) = authority(
            database,
            native,
            peer,
            human,
            profile,
            &request.operation_id,
            Access::Connect,
        )
        .await?;
        let (owner, client) = owner(profile, &human.human_id, &caller.id);
        let fingerprint = hash(
            store::encode(&(
                &human.human_id,
                &human.origin,
                &request.profile_id,
                &request.return_path,
                &binding_hash,
                &protocol.fingerprint,
            ))?
            .to_string(),
        );
        let id = {
            let connection = database
                .pool
                .get()
                .await
                .map_err(|_| Status::unavailable("provider database unavailable"))?;
            connection.query_one("INSERT INTO ofz.provider_connections(id,workspace_id,profile_id,owner_id,client_service,profile_hash,state) VALUES($1,$2,$3,$4,$5,$6,'disconnected') ON CONFLICT(workspace_id,profile_id,owner_id,client_service) DO UPDATE SET id=ofz.provider_connections.id RETURNING id", &[&Uuid::new_v4(), &decision::parse_uuid(&profile.workspace_id)?, &profile.id, &owner, &client, &protocol.fingerprint]).await.map_err(sql_error)?.get::<_, Uuid>(0)
        };
        let mut locked = database.provider_connection(id).await?;
        let connection = &mut locked.client;
        if let Some(row) = connection.query_opt("SELECT workload_id,human_id,fingerprint,sealed,expires_at_ms,phase FROM ofz.provider_attempts WHERE operation_id=$1", &[&operation]).await.map_err(sql_error)? {
            if row.get::<_, String>(0) != peer || row.get::<_, String>(1) != human.human_id || row.get::<_, Vec<u8>>(2) != fingerprint { return Err(Status::already_exists("provider operation belongs to another intent")); }
            if row.get::<_, i64>(4) <= database.state().await?.now_ms as i64 || row.get::<_, String>(5) != "pending" { return Err(Status::failed_precondition("provider attempt expired or already completed")); }
            let attempt: Attempt = self.vault()?.open(&attempt_binding(id, operation), &row.get::<_, Vec<u8>>(3))?;
            return Ok(proto::BeginProviderConnectionResponse { authorization_url: attempt.authorization_url, connection_id: id.to_string() });
        }
        connection
            .execute(
                "DELETE FROM ofz.provider_attempts WHERE expires_at_ms<=ofz.now_ms()",
                &[],
            )
            .await
            .map_err(sql_error)?;
        if connection.query_one("SELECT count(*) FROM ofz.provider_attempts WHERE human_id=$1 AND phase IN ('pending','exchanging')", &[&human.human_id]).await.map_err(sql_error)?.get::<_, i64>(0) >= 8 { return Err(Status::resource_exhausted("finish or cancel a pending provider connection")); }
        let mut bytes = [0; 32];
        rand::rng().fill_bytes(&mut bytes);
        let state = URL_SAFE_NO_PAD.encode(bytes);
        let (authorization_url, verifier) = protocol
            .authorize(&callback(profile, &human.origin), state.clone())
            .await?;
        let attempt = Attempt {
            state: state.clone(),
            verifier,
            authorization_url: authorization_url.clone(),
            return_path: request.return_path,
            origin: human.origin.clone(),
        };
        let revision: i64 = connection
            .query_one(
                "SELECT revision FROM ofz.provider_connections WHERE id=$1",
                &[&id],
            )
            .await
            .map_err(sql_error)?
            .get(0);
        authority(
            database,
            native,
            peer,
            human,
            profile,
            &request.operation_id,
            Access::Connect,
        )
        .await?;
        let tx = connection.transaction().await.map_err(sql_error)?;
        tx.execute("INSERT INTO ofz.provider_attempts(operation_id,connection_id,workload_id,human_id,profile_hash,state_hash,binding_hash,fingerprint,sealed,expected_revision,phase,expires_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',ofz.now_ms()+300000)", &[&operation, &id, &peer, &human.human_id, &protocol.fingerprint, &hash(state), &binding_hash, &fingerprint, &self.vault()?.seal(&attempt_binding(id, operation), &attempt)?, &revision]).await.map_err(sql_error)?;
        store::record_audit(
            &tx,
            &provider_audit(
                &context,
                peer,
                profile,
                &request.operation_id,
                "ofz.providers.begin",
                "provider connection authorization started",
            ),
            "ofz.providers.begin",
        )
        .await?;
        tx.commit().await.map_err(sql_error)?;
        Ok(proto::BeginProviderConnectionResponse {
            authorization_url,
            connection_id: id.to_string(),
        })
    }

    pub async fn complete(
        &self,
        database: &Database,
        native: &Native,
        peer: &str,
        request: proto::CompleteProviderConnectionRequest,
    ) -> Result<proto::CompleteProviderConnectionResponse, Status> {
        let protocol = self.profile(&request.profile_id)?;
        let profile = &protocol.profile;
        let human = request
            .human
            .as_ref()
            .ok_or_else(|| Status::unauthenticated("provider owner session required"))?;
        let state_hash = opaque(&request.state)?;
        let binding_hash = opaque(&request.binding)?;
        if request.code.is_empty() == request.error.is_empty()
            || request.error.len() > 128
            || !request
                .error
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || (!request.issuer.is_empty() && request.issuer != profile.issuer)
        {
            return Err(Status::invalid_argument(
                "provider callback binding is invalid",
            ));
        }
        let id = {
            let connection = database
                .pool
                .get()
                .await
                .map_err(|_| Status::unavailable("provider database unavailable"))?;
            connection.query_opt("SELECT connection_id FROM ofz.provider_attempts WHERE state_hash=$1 AND workload_id=$2 AND human_id=$3 AND binding_hash=$4 AND expires_at_ms>ofz.now_ms()", &[&state_hash, &peer, &human.human_id, &binding_hash]).await.map_err(sql_error)?.ok_or_else(|| Status::not_found("provider attempt expired or unavailable"))?.get::<_, Uuid>(0)
        };
        let mut locked = database.provider_connection(id).await?;
        let connection = &mut locked.client;
        let row = connection.query_one("SELECT operation_id,profile_hash,sealed,expected_revision,phase,code_hash,problem FROM ofz.provider_attempts WHERE state_hash=$1", &[&state_hash]).await.map_err(sql_error)?;
        let operation: Uuid = row.get(0);
        let attempt: Attempt = self
            .vault()?
            .open(&attempt_binding(id, operation), &row.get::<_, Vec<u8>>(2))?;
        if attempt.origin != human.origin
            || row.get::<_, Vec<u8>>(1) != protocol.fingerprint
            || attempt.state != request.state
        {
            return Err(Status::permission_denied(
                "provider attempt belongs to another gateway or profile",
            ));
        }
        let (context, _, caller) =
            owner_session(database, peer, human, &operation.to_string()).await?;
        onboarding::verify(database).await?;
        let (owner, client) = owner(profile, &human.human_id, &caller.id);
        let record = connection.query_opt("SELECT revision,account,state FROM ofz.provider_connections WHERE id=$1 AND profile_id=$2 AND owner_id=$3 AND client_service=$4", &[&id, &profile.id, &owner, &client]).await.map_err(sql_error)?.ok_or_else(|| Status::not_found("provider connection unavailable"))?;
        let phase: String = row.get(4);
        let code_hash = hash(store::encode(&(&request.code, &request.error))?.to_string());
        if matches!(phase.as_str(), "complete" | "cancelled" | "failed")
            && row.get::<_, Option<Vec<u8>>>(5).as_ref() == Some(&code_hash)
        {
            return Ok(proto::CompleteProviderConnectionResponse {
                connection_id: id.to_string(),
                return_path: attempt.return_path,
                connected: phase == "complete" && record.get::<_, String>(2) == "ready",
                problem: row.get(6),
            });
        }
        if phase != "pending" {
            return Err(Status::failed_precondition(
                "provider authorization could not be confirmed; reconnect without resubmitting this code",
            ));
        }
        if record.get::<_, i64>(0) != row.get::<_, i64>(3) {
            return Err(Status::aborted(
                "provider connection changed during authorization",
            ));
        }
        use proto::ProviderConnectionProblem as Problem;
        let access = authority(
            database,
            native,
            peer,
            human,
            profile,
            &operation.to_string(),
            Access::Connect,
        )
        .await;
        if let Err(error) = &access
            && error.code() != tonic::Code::PermissionDenied
        {
            return Err(error.clone());
        }
        let exchange: Result<(Tokens, Account), (Problem, Status)> = async {
            access.map_err(|error| (Problem::AccessRemoved, error))?;
            if !request.error.is_empty() {
                let problem = if request.error == "access_denied" { Problem::Cancelled } else { Problem::AuthorizationFailed };
                return Err((problem, Status::cancelled("provider authorization cancelled")));
            }
            connection.execute("UPDATE ofz.provider_attempts SET phase='exchanging',code_hash=$2 WHERE operation_id=$1", &[&operation, &code_hash]).await.map_err(|error| (Problem::AuthorizationFailed, sql_error(error)))?;
            let now = database
                .state()
                .await
                .map_err(|error| (Problem::AuthorizationFailed, error))?
                .now_ms;
            let tokens = protocol
                .exchange(
                    &callback(profile, &human.origin),
                    request.code,
                    attempt.verifier,
                    now,
                )
                .await
                .map_err(|error| (Problem::AuthorizationFailed, error))?;
            let account = protocol
                .account(&tokens)
                .await
                .map_err(|error| (Problem::AuthorizationFailed, error))?;
            if let Some(previous) = record.get::<_, Option<serde_json::Value>>(1) {
                let previous: Account = store::decode(previous)
                    .map_err(|error| (Problem::AuthorizationFailed, error))?;
                if previous.id != account.id {
                    let _ = protocol.revoke(&tokens).await;
                    return Err((
                        Problem::AccountMismatch,
                        Status::failed_precondition(
                            "reconnect using the original provider account",
                        ),
                    ));
                }
            }
            authority(
                database,
                native,
                peer,
                human,
                profile,
                &operation.to_string(),
                Access::Connect,
            )
            .await
            .map_err(|error| (Problem::AccessRemoved, error))?;
            Ok((tokens, account))
        }
        .await;
        let (tokens, account) = match exchange {
            Ok(result) => result,
            Err((problem, error)) => {
                let tx = connection.transaction().await.map_err(sql_error)?;
                tx.execute("UPDATE ofz.provider_attempts SET phase=$2,problem=$3,code_hash=$4 WHERE operation_id=$1", &[&operation, &if problem == Problem::Cancelled { "cancelled" } else { "failed" }, &(problem as i32), &code_hash]).await.map_err(sql_error)?;
                let cancelled = problem == Problem::Cancelled;
                let (action, reason) = if cancelled {
                    ("ofz.providers.cancel", "provider authorization cancelled")
                } else {
                    ("ofz.providers.failed", "provider authorization failed")
                };
                let mut receipt = provider_audit(
                    &context,
                    peer,
                    profile,
                    &operation.to_string(),
                    action,
                    reason,
                );
                receipt.allowed = cancelled;
                store::record_audit(&tx, &receipt, action).await?;
                tx.commit().await.map_err(sql_error)?;
                if !cancelled {
                    tracing::warn!(grpc_code = ?error.code(), problem = problem.as_str_name(), audit_receipt = %receipt.id, "provider authorization failed");
                }
                return Ok(proto::CompleteProviderConnectionResponse {
                    connection_id: id.to_string(),
                    return_path: attempt.return_path,
                    connected: false,
                    problem: problem as i32,
                });
            }
        };
        let tx = connection.transaction().await.map_err(sql_error)?;
        if tx.execute("UPDATE ofz.provider_connections SET state='ready',revision=revision+1,profile_hash=$2,account=$3,credential=$4,expires_at_ms=$5,updated_at_ms=ofz.now_ms() WHERE id=$1 AND revision=$6", &[&id, &protocol.fingerprint, &store::encode(&account)?, &self.vault()?.seal(&credential_binding(id, &protocol.fingerprint), &tokens)?, &tokens.expires_at_ms.map(|value| value as i64), &row.get::<_, i64>(3)]).await.map_err(sql_error)? != 1 { return Err(Status::aborted("provider connection changed during authorization")); }
        tx.execute(
            "UPDATE ofz.provider_attempts SET phase='complete' WHERE operation_id=$1",
            &[&operation],
        )
        .await
        .map_err(sql_error)?;
        store::record_audit(
            &tx,
            &provider_audit(
                &context,
                peer,
                profile,
                &operation.to_string(),
                "ofz.providers.connected",
                "provider account verified and connected",
            ),
            "ofz.providers.connected",
        )
        .await?;
        tx.commit().await.map_err(sql_error)?;
        Ok(proto::CompleteProviderConnectionResponse {
            connection_id: id.to_string(),
            return_path: attempt.return_path,
            connected: true,
            problem: proto::ProviderConnectionProblem::Unspecified as i32,
        })
    }

    pub async fn disconnect(
        &self,
        database: &Database,
        native: &Native,
        peer: &str,
        request: proto::DisconnectProviderConnectionRequest,
    ) -> Result<proto::DisconnectProviderConnectionResponse, Status> {
        let protocol = self.profile(&request.profile_id)?;
        let profile = &protocol.profile;
        let id = decision::parse_uuid(&request.connection_id)?;
        let operation = decision::parse_uuid(&request.operation_id)?;
        let human = request
            .human
            .as_ref()
            .ok_or_else(|| Status::unauthenticated("provider owner session required"))?;
        let (context, state, caller) = authority(
            database,
            native,
            peer,
            human,
            profile,
            &request.operation_id,
            Access::Disconnect,
        )
        .await?;
        let fingerprint = hash(
            store::encode(&(
                &human.human_id,
                &human.origin,
                &request.profile_id,
                &request.connection_id,
            ))?
            .to_string(),
        );
        let (owner, client) = owner(profile, &human.human_id, &caller.id);
        let mut locked = database.provider_connection(id).await?;
        let connection = &mut locked.client;
        if let Some(row) = connection.query_opt("SELECT workload_id,human_id,fingerprint,decision,provider_revocation_confirmed FROM ofz.provider_disconnects WHERE operation_id=$1", &[&operation]).await.map_err(sql_error)? {
            if row.get::<_, String>(0) != peer || row.get::<_, String>(1) != human.human_id || row.get::<_, Vec<u8>>(2) != fingerprint { return Err(Status::already_exists("provider operation belongs to another intent")); }
            return Ok(proto::DisconnectProviderConnectionResponse { decision: Some(store::decode(row.get(3))?), provider_revocation_confirmed: row.get(4) });
        }
        let row = connection.query_opt("SELECT credential,profile_hash FROM ofz.provider_connections WHERE id=$1 AND profile_id=$2 AND owner_id=$3 AND client_service=$4", &[&id, &profile.id, &owner, &client]).await.map_err(sql_error)?.ok_or_else(|| Status::not_found("provider connection unavailable"))?;
        let tokens: Option<Tokens> = row
            .get::<_, Option<Vec<u8>>>(0)
            .map(|sealed| {
                self.vault()?
                    .open(&credential_binding(id, &row.get::<_, Vec<u8>>(1)), &sealed)
            })
            .transpose()?;
        let tx = connection.transaction().await.map_err(sql_error)?;
        tx.execute("UPDATE ofz.provider_connections SET state='disconnected',revision=revision+1,credential=NULL,expires_at_ms=NULL,updated_at_ms=ofz.now_ms() WHERE id=$1", &[&id]).await.map_err(sql_error)?;
        let receipt = provider_audit(
            &context,
            peer,
            profile,
            &request.operation_id,
            "ofz.providers.disconnected",
            "provider connection disconnected",
        );
        store::record_audit(&tx, &receipt, "ofz.providers.disconnected").await?;
        let decision = proto::PlatformDecision {
            allowed: true,
            revision: String::new(),
            audit_receipt_id: receipt.id,
            valid_until_unix_ms: state.now_ms + 2_000,
            recovery_generation: state.recovery_generation,
        };
        tx.execute("INSERT INTO ofz.provider_disconnects(operation_id,workload_id,human_id,fingerprint,connection_id,decision) VALUES($1,$2,$3,$4,$5,$6)", &[&operation, &peer, &human.human_id, &fingerprint, &id, &store::encode(&decision)?]).await.map_err(sql_error)?;
        tx.commit().await.map_err(sql_error)?;
        let confirmed = if let Some(tokens) = tokens {
            protocol.revoke(&tokens).await.is_ok()
        } else {
            false
        };
        if confirmed {
            connection.execute("UPDATE ofz.provider_disconnects SET provider_revocation_confirmed=true WHERE operation_id=$1", &[&operation]).await.map_err(sql_error)?;
        }
        Ok(proto::DisconnectProviderConnectionResponse {
            decision: Some(decision),
            provider_revocation_confirmed: confirmed,
        })
    }

    pub async fn credential(
        &self,
        database: &Database,
        native: &Native,
        peer: &str,
        request: proto::ResolveProviderCredentialRequest,
    ) -> Result<proto::ResolveProviderCredentialResponse, Status> {
        if !registry::configured()?.has_role(peer, "relay.executor") {
            return Err(Status::permission_denied(
                "attested connector executor required",
            ));
        }
        let protocol = self.profile(&request.profile_id)?;
        let profile = &protocol.profile;
        if request.destination != profile.resource_url
            || request.connector_id != profile.connector_id
        {
            return Err(Status::permission_denied(
                "provider credential destination differs from registration",
            ));
        }
        let authorization = request
            .authorization
            .as_ref()
            .ok_or_else(|| Status::permission_denied("execution authorization required"))?;
        if authorization.audit_receipt_id.is_empty()
            || !profile.actions.contains(&authorization.action)
            || authorization.resources.is_empty()
            || authorization.resources.iter().any(|resource| {
                resource.kind != profile.resource.kind || resource.id != profile.resource.id
            })
        {
            return Err(Status::permission_denied(
                "provider credential exceeds its registered scope",
            ));
        }
        let initial = authorization::evaluate(database, native, peer, authorization, false).await?;
        if !initial.allowed {
            return Err(Status::permission_denied(
                "current provider execution authority required",
            ));
        }
        let (owner, client) = {
            let connection = database
                .pool
                .get()
                .await
                .map_err(|_| Status::unavailable("provider database unavailable"))?;
            let row = connection.query_opt("SELECT a.receipt FROM ofz.platform_executions e JOIN ofz.audit a ON a.id=e.authorization_receipt_id WHERE e.operation_id=$1 AND e.authorization_receipt_id=$2 AND e.outcome='started'", &[&decision::parse_uuid(&authorization.operation_id)?, &decision::parse_uuid(&authorization.audit_receipt_id)?]).await.map_err(sql_error)?.ok_or_else(|| Status::permission_denied("durable authorized execution start required"))?;
            let receipt: proto::AuditReceipt = store::decode(row.get(0))?;
            let subject = authorization
                .subject
                .as_ref()
                .ok_or_else(|| Status::permission_denied("execution subject required"))?;
            let resources: Vec<_> = authorization
                .resources
                .iter()
                .map(|resource| format!("{}/{}#{}", resource.kind, resource.id, resource.target))
                .collect();
            if !receipt.allowed
                || receipt.workload_id != peer
                || receipt.platform_client != subject.client_service
                || receipt.platform_action != authorization.action
                || receipt.platform_request_hash != authorization.request_hash
                || receipt.platform_resources != resources
                || receipt.actor != initial.context.actor
                || receipt.grant_id != initial.context.grant_id
                || receipt.recovery_generation != initial.state.recovery_generation
            {
                return Err(Status::permission_denied(
                    "provider authorization differs from the accepted execution",
                ));
            }
            match profile.ownership {
                Ownership::Workspace => (profile.workspace_id.clone(), String::new()),
                Ownership::Personal => match executions::owner(&connection, &receipt).await? {
                    executions::Owner::Human(human) => (human, subject.client_service.clone()),
                    executions::Owner::Workload(_) => {
                        return Err(Status::permission_denied(
                            "personal provider credentials require a human issuer",
                        ));
                    }
                },
            }
        };
        let id = {
            let connection = database
                .pool
                .get()
                .await
                .map_err(|_| Status::unavailable("provider database unavailable"))?;
            connection.query_opt("SELECT id FROM ofz.provider_connections WHERE workspace_id=$1 AND profile_id=$2 AND owner_id=$3 AND client_service=$4", &[&decision::parse_uuid(&profile.workspace_id)?, &profile.id, &owner, &client]).await.map_err(sql_error)?.ok_or_else(|| Status::failed_precondition("connect your provider account before using this tool"))?.get::<_, Uuid>(0)
        };
        let mut locked = database.provider_connection(id).await?;
        let connection = &mut locked.client;
        let row = connection.query_one("SELECT state,profile_hash,credential,expires_at_ms,account FROM ofz.provider_connections WHERE id=$1", &[&id]).await.map_err(sql_error)?;
        if row.get::<_, String>(0) != "ready" || row.get::<_, Vec<u8>>(1) != protocol.fingerprint {
            return Err(Status::failed_precondition(
                "provider connection requires reconnection",
            ));
        }
        let sealed: Option<Vec<u8>> = row.get(2);
        let mut tokens: Tokens = self.vault()?.open(
            &credential_binding(id, &protocol.fingerprint),
            &sealed
                .ok_or_else(|| Status::failed_precondition("provider credentials unavailable"))?,
        )?;
        let now = database.state().await?.now_ms;
        if tokens
            .expires_at_ms
            .is_some_and(|expiry| expiry <= now + 30_000)
        {
            connection.execute("UPDATE ofz.provider_connections SET state='refreshing',updated_at_ms=ofz.now_ms() WHERE id=$1", &[&id]).await.map_err(sql_error)?;
            let refreshed = async {
                let tokens = protocol.refresh(&tokens, now).await?;
                let account = protocol.account(&tokens).await?;
                let original: Account =
                    store::decode(row.get::<_, Option<serde_json::Value>>(4).ok_or_else(
                        || Status::failed_precondition("provider account identity unavailable"),
                    )?)?;
                if account.id != original.id {
                    return Err(Status::failed_precondition(
                        "provider refreshed a different account; reconnect required",
                    ));
                }
                Ok::<_, Status>(tokens)
            }
            .await;
            tokens = match refreshed {
                Ok(tokens) => tokens,
                Err(error) => {
                    connection.execute("UPDATE ofz.provider_connections SET state='reconnect',credential=NULL,expires_at_ms=NULL,updated_at_ms=ofz.now_ms() WHERE id=$1", &[&id]).await.map_err(sql_error)?;
                    return Err(error);
                }
            };
            let tx = connection.transaction().await.map_err(sql_error)?;
            tx.execute("UPDATE ofz.provider_connections SET state='ready',credential=$2,expires_at_ms=$3,revision=revision+1,updated_at_ms=ofz.now_ms() WHERE id=$1", &[&id, &self.vault()?.seal(&credential_binding(id, &protocol.fingerprint), &tokens)?, &tokens.expires_at_ms.map(|value| value as i64)]).await.map_err(sql_error)?;
            store::record_audit(
                &tx,
                &provider_audit(
                    &initial.context,
                    peer,
                    profile,
                    &authorization.operation_id,
                    "ofz.providers.refreshed",
                    "provider credential refreshed",
                ),
                "ofz.providers.refreshed",
            )
            .await?;
            tx.commit().await.map_err(sql_error)?;
        }
        let revision: i64 = connection
            .query_one(
                "SELECT revision FROM ofz.provider_connections WHERE id=$1",
                &[&id],
            )
            .await
            .map_err(sql_error)?
            .get(0);
        if connection.execute("UPDATE ofz.platform_executions SET provider_connection_id=$3,provider_credential_revision=$4 WHERE operation_id=$1 AND authorization_receipt_id=$2 AND outcome='started' AND (provider_connection_id IS NULL OR provider_connection_id=$3)", &[&decision::parse_uuid(&authorization.operation_id)?, &decision::parse_uuid(&authorization.audit_receipt_id)?, &id, &revision]).await.map_err(sql_error)? != 1 {
            return Err(Status::permission_denied("provider connection differs from its accepted execution"));
        }
        let current = authorization::evaluate(database, native, peer, authorization, false).await?;
        if !current.allowed
            || current.state.recovery_generation != initial.state.recovery_generation
        {
            return Err(Status::permission_denied(
                "provider execution authority changed",
            ));
        }
        let mut receipt = provider_audit(
            &current.context,
            peer,
            profile,
            &authorization.operation_id,
            "ofz.providers.credential",
            "provider credential supplied to its authorized executor",
        );
        receipt.action = proto::Action::PolicyCheck as i32;
        database.audit(&receipt, "ofz.providers.credential").await?;
        Ok(proto::ResolveProviderCredentialResponse {
            access_token: tokens.access,
            connection_id: id.to_string(),
            expires_at_unix_ms: tokens.expires_at_ms.unwrap_or(0),
        })
    }
}

pub(crate) async fn verify_execution_connection(
    database: &Database,
    operation: &str,
    receipt: &str,
) -> Result<(), Status> {
    let connection = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("provider database unavailable"))?;
    let row = connection.query_opt("SELECT p.state,p.revision,e.provider_credential_revision FROM ofz.platform_executions e JOIN ofz.provider_connections p ON p.id=e.provider_connection_id WHERE e.operation_id=$1 AND e.authorization_receipt_id=$2", &[&decision::parse_uuid(operation)?, &decision::parse_uuid(receipt)?]).await.map_err(sql_error)?;
    if row.is_some_and(|row| {
        row.get::<_, String>(0) != "ready"
            || Some(row.get::<_, i64>(1)) != row.get::<_, Option<i64>>(2)
    }) {
        return Err(Status::failed_precondition(
            "provider connection changed or requires reconnection",
        ));
    }
    Ok(())
}

fn provider_audit(
    context: &proto::RequestContext,
    peer: &str,
    profile: &Profile,
    operation: &str,
    action: &str,
    reason: &str,
) -> proto::AuditReceipt {
    let mut receipt = store::receipt(
        context,
        peer,
        policy::platform(),
        proto::Action::PolicyCommand,
        true,
        operation,
        reason,
    );
    receipt.platform_workspace_id = profile.workspace_id.clone();
    receipt.platform_action = action.into();
    receipt.platform_resources = vec![format!("{}/{}", profile.resource.kind, profile.resource.id)];
    receipt
}
