use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::Jwk};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tonic::Status;
#[cfg(test)]
use uuid::Uuid;

use crate::policy;

#[derive(Deserialize)]
struct Proof {
    htu: String,
    htm: String,
    iat: u64,
    jti: String,
    ath: String,
    bht: String,
}

pub(crate) fn authenticate_proof(
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
        let claims = json!({"htu":"https://proompteng.ai/api/platform/relay/agent","htm":"POST","iat":chrono::Utc::now().timestamp(),"jti":Uuid::new_v4().to_string(),"ath":URL_SAFE_NO_PAD.encode(Sha256::digest(credential.as_bytes())),"bht":URL_SAFE_NO_PAD.encode(body)});
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
        let audience = "https://proompteng.ai/api/platform/relay/agent";
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
