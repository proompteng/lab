use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use hmac::{Hmac, Mac};
use prost::Message;
use sha2::{Digest, Sha256};
use tonic::{GrpcMethod, Request, Status};

const SUBJECT_HEADER: &str = "x-tengri-subject";
const TIMESTAMP_HEADER: &str = "x-tengri-timestamp";
const NONCE_HEADER: &str = "x-tengri-nonce";
const SIGNATURE_HEADER: &str = "x-tengri-signature";
const MAX_CLOCK_SKEW: Duration = Duration::from_secs(300);

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
pub struct Principal {
    pub owner_hash: String,
}

#[derive(Clone)]
pub struct Authenticator {
    secret: Arc<[u8]>,
    nonces: Arc<Mutex<HashMap<String, Instant>>>,
}

impl Authenticator {
    pub fn new(secret: String) -> anyhow::Result<Self> {
        anyhow::ensure!(
            secret.len() >= 32,
            "TENGRI_INTERNAL_HMAC_SECRET must contain at least 32 bytes"
        );
        Ok(Self {
            secret: Arc::from(secret.into_bytes()),
            nonces: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn authorize<T: Message>(&self, request: &Request<T>) -> Result<Principal, Status> {
        let subject = metadata(request, SUBJECT_HEADER)?;
        let timestamp = metadata(request, TIMESTAMP_HEADER)?;
        let nonce = metadata(request, NONCE_HEADER)?;
        let signature = metadata(request, SIGNATURE_HEADER)?;
        validate_subject(&subject)?;
        validate_nonce(&nonce)?;

        let timestamp_seconds = timestamp
            .parse::<u64>()
            .map_err(|_| Status::unauthenticated("invalid authentication timestamp"))?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Status::internal("system clock is unavailable"))?
            .as_secs();
        if now.abs_diff(timestamp_seconds) > MAX_CLOCK_SKEW.as_secs() {
            return Err(Status::unauthenticated("authentication timestamp expired"));
        }

        let signature = decode_hex(&signature)
            .ok_or_else(|| Status::unauthenticated("invalid request signature"))?;
        let grpc_method = request
            .extensions()
            .get::<GrpcMethod<'static>>()
            .ok_or_else(|| Status::unauthenticated("missing authenticated RPC identity"))?;
        let rpc_path = format!("/{}/{}", grpc_method.service(), grpc_method.method());
        let mut mac = HmacSha256::new_from_slice(&self.secret)
            .map_err(|_| Status::internal("invalid authentication configuration"))?;
        let body_hash = encode_hex(&Sha256::digest(request.get_ref().encode_to_vec()));
        mac.update(signing_payload(&subject, &timestamp, &nonce, &rpc_path, &body_hash).as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| Status::unauthenticated("invalid request signature"))?;

        let replay_key = format!("{subject}:{nonce}");
        let mut nonces = self
            .nonces
            .lock()
            .map_err(|_| Status::internal("authentication state is unavailable"))?;
        let cutoff = Instant::now()
            .checked_sub(MAX_CLOCK_SKEW)
            .unwrap_or_else(Instant::now);
        nonces.retain(|_, inserted_at| *inserted_at >= cutoff);
        if nonces.insert(replay_key, Instant::now()).is_some() {
            return Err(Status::unauthenticated("request nonce was already used"));
        }

        Ok(Principal {
            owner_hash: owner_hash(&subject),
        })
    }
}

pub fn owner_hash(subject: &str) -> String {
    encode_hex(&Sha256::digest(subject.as_bytes()))
}

pub fn deterministic_agent_id(owner_hash: &str) -> String {
    format!("agent-{}", &owner_hash[..owner_hash.len().min(32)])
}

fn metadata<T>(request: &Request<T>, name: &'static str) -> Result<String, Status> {
    request
        .metadata()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Status::unauthenticated(format!("missing {name}")))
}

fn validate_subject(subject: &str) -> Result<(), Status> {
    let github_id = subject.strip_prefix("github:").unwrap_or_default();
    if subject.len() > 256
        || github_id.is_empty()
        || !github_id.bytes().all(|value| value.is_ascii_digit())
    {
        return Err(Status::unauthenticated("invalid GitHub subject"));
    }
    Ok(())
}

fn validate_nonce(nonce: &str) -> Result<(), Status> {
    if nonce.len() < 16
        || nonce.len() > 128
        || !nonce
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-' || value == b'_')
    {
        return Err(Status::unauthenticated("invalid request nonce"));
    }
    Ok(())
}

fn signing_payload(
    subject: &str,
    timestamp: &str,
    nonce: &str,
    rpc_path: &str,
    body_hash: &str,
) -> String {
    format!("{subject}\n{timestamp}\n{nonce}\n{rpc_path}\n{body_hash}")
}

fn encode_hex(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(value.len() * 2);
    for byte in value {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16)?;
            let low = (pair[1] as char).to_digit(16)?;
            Some(((high << 4) | low) as u8)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, PartialEq, Message)]
    struct TestRequest {
        #[prost(string, tag = "1")]
        id: String,
    }

    #[test]
    fn identity_produces_stable_dns_safe_agent_name() {
        let owner = owner_hash("github:123456");
        assert_eq!(owner.len(), 64);
        assert_eq!(
            deterministic_agent_id(&owner),
            deterministic_agent_id(&owner)
        );
        assert!(deterministic_agent_id(&owner).starts_with("agent-"));
    }

    #[test]
    fn rejects_replayed_signed_request() {
        let secret = "s".repeat(32);
        let auth = Authenticator::new(secret.clone()).expect("authenticator");
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_secs()
            .to_string();
        let nonce = "nonce-1234567890";
        let subject = "github:42";
        let rpc_path = "/proompteng.runtime.v1.MicroVMControlPlane/GetAgent";
        let body = TestRequest {
            id: "agent-1".to_owned(),
        };
        let body_hash = encode_hex(&Sha256::digest(body.encode_to_vec()));
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac");
        mac.update(signing_payload(subject, &timestamp, nonce, rpc_path, &body_hash).as_bytes());
        let signature = encode_hex(&mac.finalize().into_bytes());
        let request = || {
            let mut request = Request::new(body.clone());
            request.extensions_mut().insert(GrpcMethod::new(
                "proompteng.runtime.v1.MicroVMControlPlane",
                "GetAgent",
            ));
            request
                .metadata_mut()
                .insert(SUBJECT_HEADER, subject.parse().expect("subject"));
            request
                .metadata_mut()
                .insert(TIMESTAMP_HEADER, timestamp.parse().expect("timestamp"));
            request
                .metadata_mut()
                .insert(NONCE_HEADER, nonce.parse().expect("nonce"));
            request
                .metadata_mut()
                .insert(SIGNATURE_HEADER, signature.parse().expect("signature"));
            request
        };
        assert!(auth.authorize(&request()).is_ok());
        assert_eq!(
            auth.authorize(&request()).expect_err("replay").code(),
            tonic::Code::Unauthenticated
        );
    }

    #[test]
    fn rejects_signatures_replayed_for_another_rpc_or_body() {
        let secret = "s".repeat(32);
        let auth = Authenticator::new(secret.clone()).expect("authenticator");
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_secs()
            .to_string();
        let nonce = "nonce-1234567890";
        let subject = "github:42";
        let signed_path = "/proompteng.runtime.v1.MicroVMControlPlane/GetAgent";
        let body = TestRequest {
            id: "agent-1".to_owned(),
        };
        let body_hash = encode_hex(&Sha256::digest(body.encode_to_vec()));
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac");
        mac.update(signing_payload(subject, &timestamp, nonce, signed_path, &body_hash).as_bytes());
        let signature = encode_hex(&mac.finalize().into_bytes());
        let request = |body: TestRequest, method: &'static str| {
            let mut request = Request::new(body);
            request.extensions_mut().insert(GrpcMethod::new(
                "proompteng.runtime.v1.MicroVMControlPlane",
                method,
            ));
            request
                .metadata_mut()
                .insert(SUBJECT_HEADER, subject.parse().expect("subject"));
            request
                .metadata_mut()
                .insert(TIMESTAMP_HEADER, timestamp.parse().expect("timestamp"));
            request
                .metadata_mut()
                .insert(NONCE_HEADER, nonce.parse().expect("nonce"));
            request
                .metadata_mut()
                .insert(SIGNATURE_HEADER, signature.parse().expect("signature"));
            request
        };

        assert_eq!(
            auth.authorize(&request(body.clone(), "DeleteAgent"))
                .expect_err("method substitution")
                .code(),
            tonic::Code::Unauthenticated,
        );
        assert_eq!(
            auth.authorize(&request(
                TestRequest {
                    id: "agent-2".to_owned(),
                },
                "GetAgent",
            ))
            .expect_err("body substitution")
            .code(),
            tonic::Code::Unauthenticated,
        );
        assert!(auth.authorize(&request(body, "GetAgent")).is_ok());
    }

    #[test]
    fn rejects_empty_or_non_numeric_github_subjects() {
        for subject in ["github:", "github:user", "email:42", ""] {
            assert_eq!(
                validate_subject(subject)
                    .expect_err("invalid subject")
                    .code(),
                tonic::Code::Unauthenticated,
            );
        }
        assert!(validate_subject("github:42").is_ok());
    }
}
