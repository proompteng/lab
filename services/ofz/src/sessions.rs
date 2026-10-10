use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures::StreamExt;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tonic::Status;
use uuid::Uuid;

use crate::{
    decision,
    native::{Check, Native},
    policy::{self, BFF_ID},
    proto::{
        Action, Actor, CommandReceipt, CommandState, EstablishSessionRequest,
        InspectSessionRequest, RequestContext, RevokeSessionRequest, Session, actor::Identity,
    },
    store::{self, Database, sql_error},
};

#[derive(Clone)]
pub struct Issuer {
    url: String,
    audience: String,
    client: reqwest::Client,
}

#[derive(Clone, Deserialize)]
struct Claims {
    sub: String,
    sid: String,
    nonce: String,
    exp: u64,
    iat: u64,
    auth_time: u64,
    acr: String,
    github_id: String,
    identity_provider: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    picture: String,
}

impl Issuer {
    pub fn new(url: String, audience: String) -> anyhow::Result<Self> {
        let parsed = reqwest::Url::parse(&url)?;
        anyhow::ensure!(
            parsed.scheme() == "https"
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.query().is_none()
                && parsed.fragment().is_none()
                && !audience.is_empty(),
            "OIDC requires a fixed HTTPS issuer and audience"
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
            audience,
            client,
        })
    }

    async fn verify(&self, token: &str, nonce: &str, now: u64) -> Result<Claims, Status> {
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
        validation.set_audience(&[&self.audience]);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.set_required_spec_claims(&["exp", "iat", "iss", "aud", "sub"]);
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|_| Status::unauthenticated("identity verification failed"))?
            .claims;
        if claims.nonce != nonce
            || claims.identity_provider != "github"
            || !policy::canonical_uuid(&claims.sub)
            || claims.sid.is_empty()
            || claims.sid.len() > 256
            || claims.iat > now + 30
            || claims.iat + 120 < now
            || claims.exp <= now
            || claims.auth_time > now + 30
            || claims.auth_time > claims.iat + 30
        {
            return Err(Status::unauthenticated("identity claim binding failed"));
        }
        policy::github_human_id(&claims.github_id)?;
        if [&claims.name, &claims.email]
            .iter()
            .any(|value| value.len() > 256 || value.chars().any(char::is_control))
            || claims.picture.len() > 2048
            || !claims.picture.is_empty()
                && !reqwest::Url::parse(&claims.picture).is_ok_and(|url| {
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

pub async fn establish(
    database: &Database,
    native: &Native,
    issuer: &Issuer,
    peer: &str,
    request: EstablishSessionRequest,
) -> Result<Session, Status> {
    if peer != BFF_ID {
        return Err(Status::permission_denied(
            "session establishment caller denied",
        ));
    }
    decision::workload(native, peer, Action::SessionEstablish).await?;
    let operation = decision::parse_uuid(&request.operation_id)?;
    let state = database.state().await?;
    if state.fenced || !state.archive_healthy {
        return Err(Status::unavailable("identity audit archive unavailable"));
    }
    let claims = issuer
        .verify(&request.identity_token, &request.nonce, state.now_ms / 1000)
        .await?;
    let human = policy::github_human_id(&claims.github_id)?;
    if !native
        .check(&[Check::new("platform", "lab", "admit", "human", &human)])
        .await?
        .0
    {
        return Err(Status::permission_denied("platform admission required"));
    }
    let mut random = [0_u8; 32];
    rand::rng().fill_bytes(&mut random);
    let credential = URL_SAFE_NO_PAD.encode(random);
    let hash = Sha256::digest(credential.as_bytes()).to_vec();
    let nonce_hash = Sha256::digest(request.nonce.as_bytes()).to_vec();
    let id = Uuid::new_v4();
    let mut client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("control database pool unavailable"))?;
    let tx = client.transaction().await.map_err(sql_error)?;
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
    let session = Session {
        id: id.to_string(),
        human_id: human.clone(),
        expires_at_unix_ms: state.now_ms + 28_800_000,
        idle_deadline_unix_ms: state.now_ms + 1_800_000,
        mfa_at_unix_ms: if claims.acr == "2" {
            claims.auth_time * 1000
        } else {
            0
        },
        recovery_generation: state.recovery_generation,
        credential,
        github_id: claims.github_id.clone(),
        display_name: claims.name.clone(),
        email: claims.email.clone(),
        image_url: claims.picture.clone(),
    };
    tx.execute("INSERT INTO ofz.sessions(id,token_hash,human_id,identity_subject,identity_session,operation_id,expires_at_ms,idle_deadline_ms,mfa_at_ms,recovery_generation,github_id,display_name,email,image_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", &[&id,&hash,&human,&claims.sub,&claims.sid,&operation,&(session.expires_at_unix_ms as i64),&(session.idle_deadline_unix_ms as i64),&(session.mfa_at_unix_ms as i64),&(session.recovery_generation as i64),&claims.github_id,&claims.name,&claims.email,&claims.picture]).await.map_err(sql_error)?;
    let context = RequestContext {
        actor: Some(Actor {
            identity: Some(Identity::HumanId(human)),
        }),
        session_id: id.to_string(),
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
    decision::workload(native, peer, Action::SessionInspect).await?;
    if request.session_id.len() != 43 {
        return Err(Status::unauthenticated("invalid session credential"));
    }
    let hash = Sha256::digest(request.session_id.as_bytes()).to_vec();
    let client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("control database pool unavailable"))?;
    let row = client.query_opt("SELECT s.id,s.human_id,s.expires_at_ms,s.idle_deadline_ms,s.mfa_at_ms,s.recovery_generation,s.github_id,s.display_name,s.email,s.image_url FROM ofz.sessions s JOIN ofz.memberships m ON m.human_id=s.human_id AND m.role=1 CROSS JOIN ofz.platform_state p WHERE token_hash=$1 AND NOT revoked AND s.expires_at_ms>ofz.now_ms() AND s.idle_deadline_ms>ofz.now_ms() AND s.recovery_generation=p.recovery_generation", &[&hash]).await.map_err(sql_error)?.ok_or_else(|| Status::unauthenticated("session expired or revoked"))?;
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
    native: &Native,
    peer: &str,
    request: RevokeSessionRequest,
) -> Result<CommandReceipt, Status> {
    if peer != BFF_ID || request.credential.len() != 43 {
        return Err(Status::unauthenticated("BFF session credential required"));
    }
    decision::workload(native, peer, Action::PolicyCommand).await?;
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
            "SELECT id,human_id FROM ofz.sessions WHERE token_hash=$1 FOR UPDATE",
            &[&hash],
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
    tx.execute("UPDATE ofz.sessions SET revoked=true WHERE id=$1", &[&id])
        .await
        .map_err(sql_error)?;
    let audit = store::receipt(
        &context,
        peer,
        policy::platform(),
        Action::SessionInspect,
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
    };
    tx.execute("INSERT INTO ofz.session_revocations(operation_id,credential_hash,origin,receipt) VALUES($1,$2,$3,$4)", &[&operation,&hash,&request.origin,&store::encode(&receipt)?]).await.map_err(sql_error)?;
    tx.commit().await.map_err(sql_error)?;
    Ok(receipt)
}
