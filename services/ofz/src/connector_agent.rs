use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::Jwk};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tonic::Status;
use uuid::Uuid;

use crate::{
    decision,
    native::Native,
    policy,
    proto::{self, Action, Actor, Resource, ResourceKind, actor::Identity},
    store::{Database, sql_error},
};

#[derive(Deserialize)]
struct Proof {
    htu: String,
    htm: String,
    iat: u64,
    jti: String,
    ath: String,
    bht: String,
}

fn authenticate_proof(
    proof: &str,
    credential: &str,
    thumbprint: &str,
    body: &[u8],
    now: u64,
    audience: &str,
) -> Result<String, Status> {
    if proof.len() > 16384 || body.len() != 32 || credential.len() != 43 {
        return Err(Status::unauthenticated("invalid connector credential"));
    }
    let header =
        decode_header(proof).map_err(|_| Status::unauthenticated("invalid connector proof"))?;
    if header.typ.as_deref() != Some("dpop+jwt") || header.alg != Algorithm::ES256 {
        return Err(Status::unauthenticated("ES256 DPoP proof required"));
    }
    let jwk: Jwk = header
        .jwk
        .ok_or_else(|| Status::unauthenticated("proof key required"))?;
    let json =
        serde_json::to_value(&jwk).map_err(|_| Status::unauthenticated("invalid proof key"))?;
    if json["kty"] != "EC" || json["crv"] != "P-256" || json.get("d").is_some() {
        return Err(Status::unauthenticated("public P-256 proof key required"));
    }
    let canonical = serde_json::json!({"crv":"P-256","kty":"EC","x":json["x"],"y":json["y"]});
    let fingerprint = URL_SAFE_NO_PAD.encode(Sha256::digest(
        serde_json::to_vec(&canonical).map_err(|_| Status::unauthenticated("invalid proof key"))?,
    ));
    if fingerprint != thumbprint {
        return Err(Status::unauthenticated("proof key does not match grant"));
    }
    let key =
        DecodingKey::from_jwk(&jwk).map_err(|_| Status::unauthenticated("invalid proof key"))?;
    let mut validation = Validation::new(Algorithm::ES256);
    validation.required_spec_claims.clear();
    validation.validate_exp = false;
    validation.validate_aud = false;
    let claim = decode::<Proof>(proof, &key, &validation)
        .map_err(|_| Status::unauthenticated("invalid proof signature"))?
        .claims;
    if claim.htu != audience
        || claim.htm != "POST"
        || claim.iat.abs_diff(now / 1000) > 30
        || !policy::canonical_uuid(&claim.jti)
        || claim.ath != URL_SAFE_NO_PAD.encode(Sha256::digest(credential.as_bytes()))
        || claim.bht != URL_SAFE_NO_PAD.encode(body)
    {
        return Err(Status::unauthenticated("connector proof binding mismatch"));
    }
    Ok(claim.jti)
}

pub async fn check(
    database: &Database,
    native: &Native,
    peer: &str,
    request: proto::CheckConnectorAgentRequest,
) -> Result<proto::CheckConnectorAgentResponse, Status> {
    policy::require_connectors()?;
    if peer != policy::CONNECTOR_BROKER_ID {
        return Err(Status::permission_denied("connector broker required"));
    }
    let action = Action::try_from(request.action)
        .map_err(|_| Status::invalid_argument("invalid connector action"))?;
    if !matches!(action, Action::ConnectorRead | Action::ConnectorInvoke) {
        return Err(Status::invalid_argument("connector action required"));
    }
    decision::workload(native, peer, Action::ConnectorExecute).await?;
    let grant = decision::grant(database, &request.grant_id).await?;
    if grant.scope.connector_operations.is_empty() {
        return Err(Status::permission_denied(
            "a scoped connector grant is required",
        ));
    }
    let state = database.state().await?;
    let client = database
        .pool
        .get()
        .await
        .map_err(|_| Status::unavailable("control database unavailable"))?;
    client.execute("DELETE FROM ofz.replay WHERE ctid IN (SELECT ctid FROM ofz.replay WHERE domain='relay-dpop-v1' AND expires_at_ms<=ofz.now_ms() LIMIT 128)", &[]).await.map_err(sql_error)?;
    let row=client.query_opt("SELECT credential_hash,proof_key_thumbprint FROM ofz.grants WHERE id=$1 AND NOT revoked AND expires_at_ms>ofz.now_ms()", &[&decision::parse_uuid(&request.grant_id)?]).await.map_err(sql_error)?.ok_or_else(||Status::unauthenticated("grant unavailable"))?;
    if row.get::<_, Vec<u8>>(0) != Sha256::digest(request.credential.as_bytes()).to_vec() {
        return Err(Status::unauthenticated("invalid grant credential"));
    }
    let audience = std::env::var("OFZ_CONNECTOR_AUDIENCE")
        .unwrap_or_else(|_| "https://proompteng.ai/api/tengri/connectors/agent".into());
    let nonce = authenticate_proof(
        &request.proof,
        &request.credential,
        &row.get::<_, String>(1),
        &request.request_hash,
        state.now_ms,
        &audience,
    )?;
    let nonce_hash = Sha256::digest(format!("{}:{nonce}", request.grant_id).as_bytes()).to_vec();
    let inserted=client.execute("INSERT INTO ofz.replay(domain,nonce_hash,expires_at_ms) VALUES('relay-dpop-v1',$1,ofz.now_ms()+120000) ON CONFLICT DO NOTHING", &[&nonce_hash]).await.map_err(sql_error)?;
    if inserted != 1 {
        return Err(Status::unauthenticated("connector proof was already used"));
    }
    let runtime=client.query_opt("SELECT runtime_epoch FROM ofz.workspaces WHERE uid=$1 AND state='active' AND running AND runtime_epoch IS NOT NULL", &[&decision::parse_uuid(&grant.workspace_uid)?]).await.map_err(sql_error)?.ok_or_else(||Status::permission_denied("connector workspace is not running"))?;
    let context = proto::RequestContext {
        actor: Some(Actor {
            identity: Some(Identity::AgentId(grant.agent_id)),
        }),
        grant_id: grant.id,
        trace_id: Uuid::new_v4().to_string(),
        deadline_unix_ms: state.now_ms + 25000,
        workspace_uid: grant.workspace_uid,
        runtime_epoch: runtime.get::<_, Uuid>(0).to_string(),
        origin: reqwest::Url::parse(&audience)
            .map_err(|_| Status::unavailable("invalid connector audience"))?
            .origin()
            .ascii_serialization(),
        contract_version: crate::CONTRACT_VERSION,
        ..Default::default()
    };
    let decision = decision::check(
        database,
        native,
        peer,
        proto::CheckRequest {
            context: Some(context.clone()),
            action: action as i32,
            resource: Some(Resource {
                kind: ResourceKind::ConnectorConnection as i32,
                id: request.connection_id,
            }),
            target: request.operation,
            stream_receipt_id: String::new(),
        },
    )
    .await?;
    if !decision.allowed {
        return Err(Status::permission_denied(
            "connector operation is not granted",
        ));
    }
    Ok(proto::CheckConnectorAgentResponse {
        context: Some(context),
        decision: Some(decision),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde_json::json;

    // Public, disposable test identity; never used by any deployment or account.
    const PRIVATE: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgb3mwQ1ybAy0Qu6MF\ngvmPAOzhUjrBqpFEwkCsskNp4/GhRANCAATjTDefKlXYsAvsBdZ01abePnLWZ4p3\ndMpDKQda2ovnajmPSw46G5Kaa3KQOjc03YNaGpz5LCfwEcdYPU/5gDFK\n-----END PRIVATE KEY-----\n";
    pub(crate) fn signed_proof(credential: &str, body: &[u8]) -> (String, String) {
        let public = json!({"crv":"P-256","kty":"EC","x":"40w3nypV2LAL7AXWdNWm3j5y1meKd3TKQykHWtqL52o","y":"OY9LDjobkpprcpA6NzTdg1oanPksJ_ARx1g9T_mAMUo"});
        let thumbprint =
            URL_SAFE_NO_PAD.encode(Sha256::digest(serde_json::to_vec(&public).unwrap()));
        let claims = json!({"htu":"https://proompteng.ai/api/tengri/connectors/agent","htm":"POST","iat":chrono::Utc::now().timestamp(),"jti":Uuid::new_v4().to_string(),"ath":URL_SAFE_NO_PAD.encode(Sha256::digest(credential.as_bytes())),"bht":URL_SAFE_NO_PAD.encode(body)});
        let mut header = Header::new(Algorithm::ES256);
        header.typ = Some("dpop+jwt".into());
        header.jwk = Some(serde_json::from_value(public).unwrap());
        let der = base64::engine::general_purpose::STANDARD
            .decode(
                PRIVATE
                    .lines()
                    .filter(|line| !line.starts_with("-----"))
                    .collect::<String>(),
            )
            .unwrap();
        (
            thumbprint,
            encode(&header, &claims, &EncodingKey::from_ec_der(&der)).unwrap(),
        )
    }
    #[test]
    fn proof_binds_key_credential_destination_method_body_and_time() {
        let public = json!({"crv":"P-256","kty":"EC","x":"40w3nypV2LAL7AXWdNWm3j5y1meKd3TKQykHWtqL52o","y":"OY9LDjobkpprcpA6NzTdg1oanPksJ_ARx1g9T_mAMUo"});
        let thumbprint =
            URL_SAFE_NO_PAD.encode(Sha256::digest(serde_json::to_vec(&public).unwrap()));
        let credential = "a".repeat(43);
        let body = Sha256::digest(b"operation body").to_vec();
        let audience = "https://proompteng.ai/api/tengri/connectors/agent";
        let now = 1_800_000_000_000u64;
        let claims = json!({"htu":audience,"htm":"POST","iat":now/1000,"jti":Uuid::new_v4().to_string(),
            "ath":URL_SAFE_NO_PAD.encode(Sha256::digest(credential.as_bytes())),"bht":URL_SAFE_NO_PAD.encode(&body)});
        let mut header = Header::new(Algorithm::ES256);
        header.typ = Some("dpop+jwt".into());
        header.jwk = Some(serde_json::from_value(public).unwrap());
        let der = base64::engine::general_purpose::STANDARD
            .decode(
                PRIVATE
                    .lines()
                    .filter(|line| !line.starts_with("-----"))
                    .collect::<String>(),
            )
            .unwrap();
        let key = EncodingKey::from_ec_der(&der);
        let token = encode(&header, &claims, &key).unwrap();
        authenticate_proof(&token, &credential, &thumbprint, &body, now, audience).unwrap();
        assert!(
            authenticate_proof(&token, &"b".repeat(43), &thumbprint, &body, now, audience).is_err()
        );
        assert!(
            authenticate_proof(&token, &credential, &"b".repeat(43), &body, now, audience).is_err()
        );
        assert!(
            authenticate_proof(&token, &credential, &thumbprint, &[0; 32], now, audience).is_err()
        );
        assert!(
            authenticate_proof(
                &token,
                &credential,
                &thumbprint,
                &body,
                now + 31000,
                audience
            )
            .is_err()
        );
        assert!(
            authenticate_proof(
                &token,
                &credential,
                &thumbprint,
                &body,
                now,
                "https://other.example/agent"
            )
            .is_err()
        );
        for (field, value) in [
            ("htm", json!("GET")),
            ("iat", json!(now / 1000 + 31)),
            ("jti", json!("")),
        ] {
            let mut changed = claims.clone();
            changed[field] = value;
            let token = encode(&header, &changed, &key).unwrap();
            assert!(
                authenticate_proof(&token, &credential, &thumbprint, &body, now, audience).is_err()
            );
        }
        header.typ = Some("JWT".into());
        let token = encode(&header, &claims, &key).unwrap();
        assert!(
            authenticate_proof(&token, &credential, &thumbprint, &body, now, audience).is_err()
        );
    }
}
