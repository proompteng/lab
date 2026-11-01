use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures::StreamExt;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tonic::Status;
use uuid::Uuid;

use crate::{
    decision,
    native::{Check, Native},
    policy,
    proto::{
        Action, Actor, BeginSignInRequest, CommandReceipt, CommandState, ConsumeSignInRequest,
        ConsumeSignInResponse, EstablishSessionRequest, InspectSessionRequest, RequestContext,
        RevokeSessionRequest, Session, actor::Identity,
    },
    registry,
    store::{self, Database, sql_error},
};

fn opaque_hash(value: &str) -> Result<Vec<u8>, Status> {
    if value.len() != 43
        || !URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == 32)
    {
        return Err(Status::invalid_argument("256-bit sign-in value required"));
    }
    Ok(Sha256::digest(value.as_bytes()).to_vec())
}

pub async fn begin_sign_in(
    database: &Database,
    peer: &str,
    request: BeginSignInRequest,
) -> Result<(), Status> {
    let (gateway, _) = registry::configured()?.session_gateway(peer)?;
    let state_hash = opaque_hash(&request.state)?;
    let binding_hash = opaque_hash(&request.binding)?;
    opaque_hash(&request.verifier)?;
    opaque_hash(&request.nonce)?;
    let operation = decision::parse_uuid(&request.operation_id)?;
    let mut client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("sign-in database unavailable"))?;
    let tx = client.transaction().await.map_err(sql_error)?;
    // Only disposable sign-in state changes here; failover discards this unlogged table.
    tx.batch_execute("SET LOCAL synchronous_commit='local'")
        .await
        .map_err(sql_error)?;
    tx.query_one(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        &[&format!("ofz.sign-in:{gateway}")],
    )
    .await
    .map_err(sql_error)?;
    tx.execute(
        "DELETE FROM ofz.sign_in_attempts WHERE gateway_service=$1 AND expires_at_ms<=ofz.now_ms()",
        &[&gateway],
    )
    .await
    .map_err(sql_error)?;
    let count: i64 = tx
        .query_one(
            "SELECT count(*) FROM ofz.sign_in_attempts WHERE gateway_service=$1",
            &[&gateway],
        )
        .await
        .map_err(sql_error)?
        .get(0);
    if count >= 2000 {
        return Err(Status::resource_exhausted(
            "sign-in attempt capacity exhausted",
        ));
    }
    tx.execute("INSERT INTO ofz.sign_in_attempts(gateway_service,state_hash,binding_hash,verifier,nonce,operation_id,expires_at_ms) VALUES($1,$2,$3,$4,$5,$6,ofz.now_ms()+300000)", &[&gateway,&state_hash,&binding_hash,&request.verifier,&request.nonce,&operation]).await.map_err(sql_error)?;
    tx.commit().await.map_err(sql_error)
}

pub async fn consume_sign_in(
    database: &Database,
    peer: &str,
    request: ConsumeSignInRequest,
) -> Result<ConsumeSignInResponse, Status> {
    let (gateway, _) = registry::configured()?.session_gateway(peer)?;
    let state_hash = opaque_hash(&request.state)?;
    let binding_hash = opaque_hash(&request.binding)?;
    let mut client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("sign-in database unavailable"))?;
    let tx = client.transaction().await.map_err(sql_error)?;
    tx.batch_execute("SET LOCAL synchronous_commit='local'")
        .await
        .map_err(sql_error)?;
    let row = tx.query_opt("DELETE FROM ofz.sign_in_attempts WHERE gateway_service=$1 AND state_hash=$2 AND binding_hash=$3 AND expires_at_ms>ofz.now_ms() RETURNING verifier,nonce,operation_id", &[&gateway,&state_hash,&binding_hash]).await.map_err(sql_error)?.ok_or_else(|| Status::unauthenticated("sign-in attempt expired or consumed"))?;
    tx.commit().await.map_err(sql_error)?;
    Ok(ConsumeSignInResponse {
        verifier: row.get(0),
        nonce: row.get(1),
        operation_id: row.get::<_, Uuid>(2).to_string(),
    })
}

#[derive(Clone)]
pub struct Issuer {
    url: String,
    client: reqwest::Client,
}

#[derive(Clone, Deserialize)]
struct Claims {
    sub: String,
    azp: String,
    sid: String,
    nonce: String,
    exp: u64,
    iat: u64,
    auth_time: u64,
    acr: String,
    github_id: String,
    identity_provider: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    picture: Option<String>,
}

impl Issuer {
    pub fn new(url: String) -> anyhow::Result<Self> {
        let parsed = reqwest::Url::parse(&url)?;
        anyhow::ensure!(
            parsed.scheme() == "https"
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.query().is_none()
                && parsed.fragment().is_none(),
            "OIDC requires a fixed HTTPS issuer"
        );
        let mut builder = reqwest::Client::builder()
            .timeout(crate::DECISION_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy();
        if let Ok(address) = std::env::var("OFZ_OIDC_CONNECT_IP") {
            let address: std::net::IpAddr = address.parse()?;
            builder = builder.resolve(
                parsed
                    .host_str()
                    .ok_or_else(|| anyhow::anyhow!("OIDC issuer hostname required"))?,
                std::net::SocketAddr::new(address, parsed.port_or_known_default().unwrap_or(443)),
            );
        }
        if let Ok(path) = std::env::var("OFZ_OIDC_CA_FILE") {
            let bytes = std::fs::read(path)?;
            for cert in reqwest::Certificate::from_pem_bundle(&bytes)? {
                builder = builder.add_root_certificate(cert);
            }
        }
        let client = builder.build()?;
        Ok(Self {
            url: url.trim_end_matches('/').into(),
            client,
        })
    }

    async fn verify(
        &self,
        token: &str,
        nonce: &str,
        now: u64,
        audience: &str,
    ) -> Result<Claims, Status> {
        if token.len() > 16384
            || nonce.len() < 32
            || nonce.len() > 128
            || !nonce
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(Status::unauthenticated("invalid identity response"));
        }
        let header =
            decode_header(token).map_err(|_| Status::unauthenticated("invalid identity token"))?;
        if header.alg != Algorithm::RS256 || header.jku.is_some() || header.x5u.is_some() {
            return Err(Status::unauthenticated("untrusted identity signing method"));
        }
        let kid = header
            .kid
            .as_ref()
            .filter(|id| id.len() <= 128)
            .ok_or_else(|| Status::unauthenticated("identity signing key required"))?;
        let response = self
            .client
            .get(format!("{}/protocol/openid-connect/certs", self.url))
            .send()
            .await
            .map_err(|_| Status::unavailable("identity issuer unavailable"))?;
        if !response.status().is_success() {
            return Err(Status::unavailable("identity issuer rejected key request"));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Status::unavailable("identity keys interrupted"))?;
            if bytes.len() + chunk.len() > 65536 {
                return Err(Status::resource_exhausted("identity key response limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let keys: JwkSet = serde_json::from_slice(&bytes)
            .map_err(|_| Status::unavailable("invalid identity key set"))?;
        let key = keys
            .find(kid)
            .ok_or_else(|| Status::unauthenticated("unknown identity signing key"))?;
        let key = DecodingKey::from_jwk(key)
            .map_err(|_| Status::unauthenticated("invalid identity signing key"))?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.url]);
        validation.set_audience(&[audience]);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.set_required_spec_claims(&["exp", "iat", "iss", "aud", "sub"]);
        let claims = decode::<serde_json::Value>(token, &key, &validation)
            .map_err(|error| {
                use jsonwebtoken::errors::ErrorKind;
                Status::unauthenticated(match error.kind() {
                    ErrorKind::InvalidAudience => "identity audience rejected",
                    ErrorKind::InvalidIssuer => "identity issuer rejected",
                    ErrorKind::ExpiredSignature => "identity response expired",
                    _ => "identity signature or standard claims rejected",
                })
            })?
            .claims;
        for field in [
            "sub",
            "azp",
            "sid",
            "nonce",
            "acr",
            "github_id",
            "identity_provider",
        ] {
            if !claims.get(field).is_some_and(serde_json::Value::is_string) {
                return Err(Status::unauthenticated(format!(
                    "identity string claim required: {field}"
                )));
            }
        }
        for field in ["exp", "iat", "auth_time"] {
            if claims
                .get(field)
                .and_then(serde_json::Value::as_u64)
                .is_none()
            {
                return Err(Status::unauthenticated(format!(
                    "identity timestamp claim required: {field}"
                )));
            }
        }
        let claims: Claims = serde_json::from_value(claims)
            .map_err(|_| Status::unauthenticated("identity claims incomplete"))?;
        if claims.acr != "2" {
            return Err(Status::unauthenticated(
                "verified passkey assurance required",
            ));
        }
        if claims.azp != audience
            || claims.nonce != nonce
            || claims.identity_provider != "github"
            || !policy::canonical_uuid(&claims.sub)
            || claims.sid.is_empty()
            || claims.sid.len() > 256
            || claims.iat > now + 30
            || claims.iat + 120 < now
            || claims.exp <= now
            || claims.auth_time > now + 30
            || claims.auth_time > claims.iat + 30
            || claims.auth_time + 120 < now
        {
            return Err(Status::unauthenticated("identity claim binding failed"));
        }
        policy::github_human_id(&claims.github_id)?;
        let picture = claims.picture.as_deref().unwrap_or_default();
        if [&claims.name, &claims.email]
            .into_iter()
            .flatten()
            .any(|value| value.len() > 256 || value.chars().any(char::is_control))
            || picture.len() > 2048
            || !picture.is_empty()
                && !reqwest::Url::parse(picture).is_ok_and(|url| {
                    url.scheme() == "https"
                        && url.host_str() == Some("avatars.githubusercontent.com")
                        && url.username().is_empty()
                        && url.password().is_none()
                        && url.port().is_none()
                })
        {
            return Err(Status::unauthenticated("invalid identity display metadata"));
        }
        Ok(claims)
    }
}

async fn established<C: tokio_postgres::GenericClient + Sync>(
    client: &C,
    operation: Uuid,
    fingerprint: &[u8],
    credential_hash: &[u8],
) -> Result<bool, Status> {
    let Some(row) = client
        .query_opt(
            "SELECT establishment_fingerprint,token_hash FROM ofz.session_credentials WHERE operation_id=$1",
            &[&operation],
        )
        .await
        .map_err(sql_error)?
    else {
        return Ok(false);
    };
    if row.get::<_, Vec<u8>>(0) != fingerprint || row.get::<_, Vec<u8>>(1) != credential_hash {
        return Err(Status::already_exists("session operation ID collision"));
    }
    Ok(true)
}

async fn recover_session(
    database: &Database,
    native: &Native,
    peer: &str,
    credential: &str,
    state: &store::State,
) -> Result<Session, Status> {
    let mut session = inspect(
        database,
        native,
        peer,
        InspectSessionRequest {
            session_id: credential.into(),
        },
    )
    .await?;
    let after = database.state().await?;
    if after.version != state.version
        || after.recovery_generation != state.recovery_generation
        || after.fenced
        || !after.archive_healthy
    {
        return Err(Status::aborted("session authority changed during retry"));
    }
    // A retry must not revive an expired or revoked session, or extend its idle time.
    decision::session(
        database,
        &RequestContext {
            actor: Some(Actor {
                identity: Some(Identity::HumanId(session.human_id.clone())),
            }),
            session_id: session.id.clone(),
            origin: registry::configured()?
                .session_gateway(peer)?
                .1
                .origin
                .clone(),
            ..Default::default()
        },
        Action::SessionInspect,
        &after,
    )
    .await?;
    session.credential = credential.into();
    Ok(session)
}

pub async fn establish(
    database: &Database,
    native: &Native,
    issuer: &Issuer,
    peer: &str,
    request: EstablishSessionRequest,
) -> Result<Session, Status> {
    let operation_id = if policy::canonical_uuid(&request.operation_id) {
        request.operation_id.clone()
    } else {
        String::new()
    };
    match establish_verified(database, native, issuer, peer, request).await {
        Ok(session) => Ok(session),
        Err(mut error) => {
            let context = RequestContext {
                actor: Some(Actor {
                    identity: Some(Identity::WorkloadId(peer.into())),
                }),
                contract_version: crate::CONTRACT_VERSION,
                ..Default::default()
            };
            let receipt = store::receipt(
                &context,
                peer,
                policy::platform(),
                Action::SessionEstablish,
                false,
                &operation_id,
                error.message(),
            );
            let id = database.audit(&receipt, "").await?;
            error.metadata_mut().insert(
                "x-ofz-audit-receipt",
                id.parse()
                    .map_err(|_| Status::internal("invalid audit receipt"))?,
            );
            Err(error)
        }
    }
}

async fn establish_verified(
    database: &Database,
    native: &Native,
    issuer: &Issuer,
    peer: &str,
    request: EstablishSessionRequest,
) -> Result<Session, Status> {
    let (gateway_service, gateway) = registry::configured()?.session_gateway(peer)?;
    let operation = decision::parse_uuid(&request.operation_id)?;
    if !URL_SAFE_NO_PAD
        .decode(&request.credential)
        .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == request.credential)
    {
        return Err(Status::invalid_argument(
            "canonical 256-bit session credential required",
        ));
    }
    let hash = Sha256::digest(request.credential.as_bytes()).to_vec();
    let fingerprint = Sha256::digest(store::encode(&request)?.to_string().as_bytes()).to_vec();
    if !request.previous_credential.is_empty()
        && (request.previous_credential.len() != 43
            || !request
                .previous_credential
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'))
    {
        return Err(Status::invalid_argument(
            "invalid previous session credential",
        ));
    }
    let state = database.state().await?;
    if state.fenced || !state.archive_healthy {
        return Err(Status::unavailable("identity audit archive unavailable"));
    }
    let exists = {
        let client = database
            .pool
            .get()
            .await
            .map_err(|_| Status::unavailable("control database pool unavailable"))?;
        established(&**client, operation, &fingerprint, &hash).await?
    };
    if exists {
        return recover_session(database, native, peer, &request.credential, &state).await;
    }
    let claims = issuer
        .verify(
            &request.identity_token,
            &request.nonce,
            state.now_ms / 1000,
            &gateway.oidc_client_id,
        )
        .await?;
    let human = policy::github_human_id(&claims.github_id)?;
    if !native
        .check(&[Check::new("platform", "lab", "admit", "human", &human)])
        .await?
        .0
    {
        return Err(Status::permission_denied("platform admission required"));
    }
    let nonce_hash = Sha256::digest(request.nonce.as_bytes()).to_vec();
    let mut client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("control database pool unavailable"))?;
    let tx = client.transaction().await.map_err(sql_error)?;
    tx.query_one(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        &[&format!("ofz.session:{operation}")],
    )
    .await
    .map_err(sql_error)?;
    if established(&*tx, operation, &fingerprint, &hash).await? {
        drop(tx);
        drop(client);
        return recover_session(database, native, peer, &request.credential, &state).await;
    }
    tx.query_one(
        "SELECT recovery_generation FROM ofz.platform_state FOR SHARE",
        &[],
    )
    .await
    .map_err(sql_error)?;
    let previous = if request.previous_credential.is_empty() {
        None
    } else {
        let previous_hash = Sha256::digest(request.previous_credential.as_bytes()).to_vec();
        tx.query_opt(
            "SELECT s.id,s.human_id,s.identity_subject,s.revoked,s.expires_at_ms,s.idle_deadline_ms,s.recovery_generation \
             FROM ofz.sessions s JOIN ofz.session_credentials c ON c.session_id=s.id \
             WHERE c.token_hash=$1 AND s.gateway_service=$2 AND NOT c.revoked FOR UPDATE OF s,c",
            &[&previous_hash,&gateway_service],
        )
        .await
        .map_err(sql_error)?
    };
    let current = store::state(&*tx).await?;
    if current.version != state.version
        || current.recovery_generation != state.recovery_generation
        || current.fenced
        || !current.archive_healthy
    {
        return Err(Status::aborted(
            "identity authority changed during verification",
        ));
    }
    let state = current;
    if tx
        .query_opt(
            "SELECT 1 FROM ofz.memberships WHERE human_id=$1 AND role=1",
            &[&human],
        )
        .await
        .map_err(sql_error)?
        .is_none()
    {
        return Err(Status::permission_denied("platform admission required"));
    }
    if tx.execute("INSERT INTO ofz.replay(domain,nonce_hash,expires_at_ms) VALUES('oidc',$1,$2) ON CONFLICT DO NOTHING", &[&nonce_hash,&((state.now_ms+600_000) as i64)]).await.map_err(sql_error)? != 1 { return Err(Status::unauthenticated("identity response already used")); }
    // Fresh verification rotates the browser secret, not the authority of an authorized run.
    // A revoked/expired session or a different broker identity cannot inherit that authority.
    let retained = previous.as_ref().filter(|row| {
        row.get::<_, String>(1) == human
            && row.get::<_, String>(2) == claims.sub
            && !row.get::<_, bool>(3)
            && row.get::<_, i64>(4) > state.now_ms as i64
            && row.get::<_, i64>(5) > state.now_ms as i64
            && row.get::<_, i64>(6) == state.recovery_generation as i64
    });
    let id = retained.map_or_else(Uuid::new_v4, |row| row.get(0));
    if let Some(previous) = &previous {
        let previous_id: Uuid = previous.get(0);
        tx.execute(
            "UPDATE ofz.session_credentials SET revoked=true WHERE session_id=$1 AND NOT revoked",
            &[&previous_id],
        )
        .await
        .map_err(sql_error)?;
        if retained.is_none() && !previous.get::<_, bool>(3) {
            tx.execute(
                "UPDATE ofz.sessions SET revoked=true WHERE id=$1",
                &[&previous_id],
            )
            .await
            .map_err(sql_error)?;
            let context = RequestContext {
                actor: Some(Actor {
                    identity: Some(Identity::HumanId(previous.get(1))),
                }),
                session_id: previous_id.to_string(),
                origin: gateway.origin.clone(),
                contract_version: crate::CONTRACT_VERSION,
                ..Default::default()
            };
            store::record_audit(
                &*tx,
                &store::receipt(
                    &context,
                    peer,
                    policy::platform(),
                    Action::SessionRevoke,
                    true,
                    &request.operation_id,
                    "browser authority replaced",
                ),
                "",
            )
            .await?;
        }
    }
    let session = Session {
        id: id.to_string(),
        human_id: human.clone(),
        expires_at_unix_ms: state.now_ms + 28_800_000,
        idle_deadline_unix_ms: state.now_ms + 1_800_000,
        mfa_at_unix_ms: claims.auth_time * 1000,
        recovery_generation: state.recovery_generation,
        credential: request.credential.clone(),
        github_id: claims.github_id.clone(),
        display_name: claims.name.unwrap_or_default(),
        email: claims.email.unwrap_or_default(),
        image_url: claims.picture.unwrap_or_default(),
    };
    tx.execute(
        "INSERT INTO ofz.sessions(id,human_id,identity_subject,identity_session,expires_at_ms,idle_deadline_ms,mfa_at_ms,recovery_generation,github_id,display_name,email,image_url,gateway_service) \
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) \
         ON CONFLICT(id) DO UPDATE SET identity_session=EXCLUDED.identity_session,expires_at_ms=EXCLUDED.expires_at_ms,\
         idle_deadline_ms=EXCLUDED.idle_deadline_ms,mfa_at_ms=EXCLUDED.mfa_at_ms,display_name=EXCLUDED.display_name,email=EXCLUDED.email,image_url=EXCLUDED.image_url",
        &[&id,&human,&claims.sub,&claims.sid,&(session.expires_at_unix_ms as i64),&(session.idle_deadline_unix_ms as i64),&(session.mfa_at_unix_ms as i64),&(session.recovery_generation as i64),&claims.github_id,&session.display_name,&session.email,&session.image_url,&gateway_service],
    ).await.map_err(sql_error)?;
    tx.execute(
        "INSERT INTO ofz.session_credentials(token_hash,session_id,operation_id,establishment_fingerprint) VALUES($1,$2,$3,$4)",
        &[&hash,&id,&operation,&fingerprint],
    ).await.map_err(sql_error)?;
    let context = RequestContext {
        actor: Some(Actor {
            identity: Some(Identity::HumanId(human)),
        }),
        session_id: id.to_string(),
        origin: gateway.origin.clone(),
        grant_id: String::new(),
        trace_id: String::new(),
        deadline_unix_ms: state.now_ms + 2000,
        contract_version: crate::CONTRACT_VERSION,
        ..Default::default()
    };
    store::record_audit(
        &*tx,
        &store::receipt(
            &context,
            peer,
            policy::platform(),
            Action::SessionEstablish,
            true,
            &request.operation_id,
            "verified broker session",
        ),
        "",
    )
    .await?;
    tx.commit().await.map_err(sql_error)?;
    Ok(session)
}

pub async fn inspect(
    database: &Database,
    native: &Native,
    peer: &str,
    request: InspectSessionRequest,
) -> Result<Session, Status> {
    let (gateway_service, _) = registry::configured()?.session_gateway(peer)?;
    if request.session_id.len() != 43 {
        return Err(Status::unauthenticated("invalid session credential"));
    }
    let hash = Sha256::digest(request.session_id.as_bytes()).to_vec();
    let client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("control database pool unavailable"))?;
    let row = client.query_opt("SELECT s.id,s.human_id,s.expires_at_ms,s.idle_deadline_ms,s.mfa_at_ms,s.recovery_generation,s.github_id,s.display_name,s.email,s.image_url FROM ofz.sessions s JOIN ofz.session_credentials c ON c.session_id=s.id JOIN ofz.memberships m ON m.human_id=s.human_id AND m.role=1 CROSS JOIN ofz.platform_state p WHERE c.token_hash=$1 AND s.gateway_service=$2 AND NOT c.revoked AND NOT s.revoked AND s.expires_at_ms>ofz.now_ms() AND s.idle_deadline_ms>ofz.now_ms() AND s.recovery_generation=p.recovery_generation", &[&hash,&gateway_service]).await.map_err(sql_error)?.ok_or_else(|| Status::unauthenticated("session expired or revoked"))?;
    let human: String = row.get(1);
    if !native
        .check(&[Check::new("platform", "lab", "admit", "human", &human)])
        .await?
        .0
    {
        return Err(Status::permission_denied("platform admission required"));
    }
    // Observation and stream rechecks do not extend the idle deadline.
    Ok(Session {
        id: row.get::<_, Uuid>(0).to_string(),
        human_id: human,
        expires_at_unix_ms: row.get::<_, i64>(2) as u64,
        idle_deadline_unix_ms: row.get::<_, i64>(3) as u64,
        mfa_at_unix_ms: row.get::<_, i64>(4) as u64,
        recovery_generation: row.get::<_, i64>(5) as u64,
        credential: String::new(),
        github_id: row.get(6),
        display_name: row.get(7),
        email: row.get(8),
        image_url: row.get(9),
    })
}

pub async fn revoke(
    database: &Database,
    peer: &str,
    request: RevokeSessionRequest,
) -> Result<CommandReceipt, Status> {
    let (gateway_service, gateway) = registry::configured()?.session_gateway(peer)?;
    if request.credential.len() != 43 || request.origin != gateway.origin {
        return Err(Status::unauthenticated(
            "gateway session credential and origin required",
        ));
    }
    let operation = decision::parse_uuid(&request.operation_id)?;
    let state = database.state().await?;
    let hash = Sha256::digest(request.credential.as_bytes()).to_vec();
    let mut client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("control database pool unavailable"))?;
    let tx = client.transaction().await.map_err(sql_error)?;
    let session = tx
        .query_opt(
            "SELECT s.id,s.human_id,c.revoked FROM ofz.sessions s JOIN ofz.session_credentials c ON c.session_id=s.id WHERE c.token_hash=$1 AND s.gateway_service=$2 FOR UPDATE OF s,c",
            &[&hash,&gateway_service],
        )
        .await
        .map_err(sql_error)?
        .ok_or_else(|| Status::unauthenticated("unknown session credential"))?;
    let id: Uuid = session.get(0);
    let context = RequestContext {
        actor: Some(Actor {
            identity: Some(Identity::HumanId(session.get(1))),
        }),
        session_id: id.to_string(),
        deadline_unix_ms: state.now_ms + 2000,
        contract_version: crate::CONTRACT_VERSION,
        origin: request.origin.clone(),
        ..Default::default()
    };
    decision::validate_context(&context, peer, &state)?;
    if let Some(row) = tx.query_opt("SELECT credential_hash,origin,receipt FROM ofz.session_revocations WHERE operation_id=$1", &[&operation]).await.map_err(sql_error)? {
        if row.get::<_,Vec<u8>>(0) != hash || row.get::<_,String>(1) != request.origin {
            return Err(Status::already_exists("session operation ID collision"));
        }
        return store::decode(row.get(2));
    }
    if session.get::<_, bool>(2) {
        return Err(Status::unauthenticated("session credential replaced"));
    }
    tx.execute(
        "UPDATE ofz.session_credentials SET revoked=true WHERE session_id=$1 AND NOT revoked",
        &[&id],
    )
    .await
    .map_err(sql_error)?;
    tx.execute("UPDATE ofz.sessions SET revoked=true WHERE id=$1", &[&id])
        .await
        .map_err(sql_error)?;
    let audit = store::receipt(
        &context,
        peer,
        policy::platform(),
        Action::SessionRevoke,
        true,
        &operation.to_string(),
        "session revoked",
    );
    store::record_audit(&*tx, &audit, "").await?;
    let receipt = CommandReceipt {
        operation_id: operation.to_string(),
        state: CommandState::Committed as i32,
        version: state.version,
        revision: String::new(),
        audit_receipt_id: audit.id,
        agent_credential: String::new(),
        recovered_revision: false,
        runtime_intent: None,
    };
    tx.execute("INSERT INTO ofz.session_revocations(operation_id,credential_hash,origin,receipt) VALUES($1,$2,$3,$4)", &[&operation,&hash,&request.origin,&store::encode(&receipt)?]).await.map_err(sql_error)?;
    tx.commit().await.map_err(sql_error)?;
    Ok(receipt)
}
