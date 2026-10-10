use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::ensure;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use prost::Message;
use sha2::{Digest, Sha256};
use tonic::{Request, Status};

use crate::{
    control::Database,
    ofz::{
        self,
        proto::{Action, RequestContext, actor::Identity},
    },
};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Principal {
    pub owner_hash: String,
    pub context: RequestContext,
    pub recovery_generation: u64,
    pub action: Action,
}

#[cfg(test)]
impl Principal {
    pub(crate) fn fixture(owner_hash: &str, workspace_uid: &str, action: Action) -> Self {
        Self {
            owner_hash: owner_hash.into(),
            recovery_generation: 1,
            action,
            context: RequestContext {
                actor: Some(ofz::proto::Actor {
                    identity: Some(Identity::HumanId(owner_hash.into())),
                }),
                session_id: "11111111-1111-4111-8111-111111111111".into(),
                trace_id: uuid::Uuid::new_v4().to_string(),
                contract_version: 1,
                workspace_uid: workspace_uid.into(),
                runtime_epoch: "44444444-4444-4444-8444-444444444444".into(),
                origin: "https://proompteng.ai".into(),
                deadline_unix_ms: ofz::now_ms().unwrap() + 5000,
                ..Default::default()
            },
        }
    }
}

#[cfg(test)]
pub(crate) fn signed_fixture_request<T: Message>(
    message: T,
    principal: &Principal,
    rpc_path: &str,
) -> Request<T> {
    let mut request = Request::new(message);
    let bytes = principal.context.encode_to_vec();
    let nonce = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let mut mac = Hmac::<Sha256>::new_from_slice(&[0x68; 32]).unwrap();
    mac.update(
        signing_payload(
            rpc_path,
            &request.get_ref().encode_to_vec(),
            &nonce,
            &bytes,
            principal.recovery_generation,
        )
        .as_bytes(),
    );
    request.metadata_mut().insert_bin(
        "x-tengri-context-bin",
        tonic::metadata::MetadataValue::from_bytes(&bytes),
    );
    request
        .metadata_mut()
        .insert("x-tengri-nonce", nonce.parse().unwrap());
    request.metadata_mut().insert(
        "x-tengri-recovery-generation",
        principal.recovery_generation.to_string().parse().unwrap(),
    );
    request.metadata_mut().insert(
        "x-tengri-signature",
        format!("{:x}", mac.finalize().into_bytes())
            .parse()
            .unwrap(),
    );
    request
}

#[derive(Clone)]
pub struct Authenticator {
    key: SigningKey,
    database: Arc<Database>,
    origin: Arc<str>,
}

#[derive(Clone)]
enum SigningKey {
    Mounted(Arc<PathBuf>),
    #[cfg(test)]
    Fixture([u8; 32]),
}

fn parse_key(key: &str) -> anyhow::Result<[u8; 32]> {
    decode_hex(key.trim_end())
        .and_then(|key| key.try_into().ok())
        .ok_or_else(|| {
            anyhow::anyhow!("BFF request key must be 32 bytes encoded as lowercase hexadecimal")
        })
}

impl Authenticator {
    pub fn new(database: Arc<Database>, key_file: &Path, origin: String) -> anyhow::Result<Self> {
        let key = std::fs::read_to_string(key_file)?;
        parse_key(&key)?;
        let url = reqwest::Url::parse(&origin)?;
        ensure!(
            url.scheme() == "https"
                && url.origin().ascii_serialization() == origin
                && url.username().is_empty()
                && url.password().is_none(),
            "canonical HTTPS desktop origin required"
        );
        Ok(Self {
            key: SigningKey::Mounted(Arc::new(key_file.to_owned())),
            database,
            origin: origin.into(),
        })
    }

    #[cfg(test)]
    pub fn fixture(database: Arc<Database>, origin: String) -> Self {
        Self {
            key: SigningKey::Fixture([0x68; 32]),
            database,
            origin: origin.into(),
        }
    }

    pub async fn authorize<T: Message>(
        &self,
        request: &Request<T>,
        rpc_path: &str,
    ) -> Result<Principal, Status> {
        let metadata = request.metadata();
        if metadata.get_all_bin("x-tengri-context-bin").iter().count() != 1 {
            return Err(Status::unauthenticated("one signed context required"));
        }
        let bytes = metadata
            .get_bin("x-tengri-context-bin")
            .and_then(|v| v.to_bytes().ok())
            .filter(|v| v.len() <= 2048)
            .ok_or_else(|| Status::unauthenticated("bounded signed context required"))?;
        let context = RequestContext::decode(bytes.clone())
            .map_err(|_| Status::unauthenticated("invalid signed context"))?;
        if context.encode_to_vec() != bytes {
            return Err(Status::unauthenticated("noncanonical signed context"));
        }
        let nonce = header(request, "x-tengri-nonce")?;
        if !URL_SAFE_NO_PAD
            .decode(&nonce)
            .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == nonce)
        {
            return Err(Status::unauthenticated("invalid nonce"));
        }
        let generation = header(request, "x-tengri-recovery-generation")?;
        let recovery_generation: u64 = generation
            .parse()
            .ok()
            .filter(|v| *v > 0)
            .ok_or_else(|| Status::unauthenticated("recovery generation required"))?;
        if recovery_generation.to_string() != generation {
            return Err(Status::unauthenticated("noncanonical recovery generation"));
        }
        let signature = header(request, "x-tengri-signature")?;
        let signature = decode_hex(&signature)
            .filter(|v| v.len() == 32)
            .ok_or_else(|| Status::unauthenticated("invalid request signature"))?;
        let payload = signing_payload(
            rpc_path,
            &request.get_ref().encode_to_vec(),
            &nonce,
            &bytes,
            recovery_generation,
        );
        let key = match &self.key {
            SigningKey::Mounted(path) => parse_key(
                &tokio::fs::read_to_string(path.as_ref())
                    .await
                    .map_err(|_| Status::unavailable("request key unavailable"))?,
            )
            .map_err(|_| Status::unavailable("request key unavailable"))?,
            #[cfg(test)]
            SigningKey::Fixture(key) => *key,
        };
        let mut mac = Hmac::<Sha256>::new_from_slice(&key)
            .map_err(|_| Status::internal("invalid request key"))?;
        mac.update(payload.as_bytes());
        mac.verify_slice(&signature)
            .map_err(|_| Status::unauthenticated("invalid request signature"))?;
        let now = ofz::now_ms()?;
        let human = match context.actor.as_ref().and_then(|a| a.identity.as_ref()) {
            Some(Identity::HumanId(human)) if ofz::canonical_human(human) => human.clone(),
            _ => return Err(Status::unauthenticated("verified human context required")),
        };
        if context.contract_version != 1
            || !ofz::canonical_uuid(&context.session_id)
            || !context.grant_id.is_empty()
            || !ofz::canonical_uuid(&context.trace_id)
            || context.origin != self.origin.as_ref()
            || context.deadline_unix_ms <= now
            || context.deadline_unix_ms > now + 5000
            || !context.workspace_uid.is_empty() && !ofz::canonical_uuid(&context.workspace_uid)
            || !context.runtime_epoch.is_empty() && !ofz::canonical_uuid(&context.runtime_epoch)
        {
            return Err(Status::unauthenticated(
                "signed identity, runtime, origin or deadline binding rejected",
            ));
        }
        let method = rpc_path
            .strip_prefix("/proompteng.runtime.v1.MicroVMControlPlane/")
            .ok_or_else(|| Status::permission_denied("unknown RPC contract"))?;
        let action = ofz::action("controller", method)?;
        let replay_key = Sha256::digest(format!("{}\n{nonce}", context.session_id)).to_vec();
        self.database
            .consume_nonce(&replay_key, context.deadline_unix_ms as i64)
            .await?;
        Ok(Principal {
            owner_hash: human,
            context,
            recovery_generation,
            action,
        })
    }
}

fn header<T>(request: &Request<T>, name: &'static str) -> Result<String, Status> {
    if request.metadata().get_all(name).iter().count() != 1 {
        return Err(Status::unauthenticated("one signed header required"));
    }
    request
        .metadata()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() <= 128)
        .map(str::to_owned)
        .ok_or_else(|| Status::unauthenticated("invalid signed header"))
}

pub fn signing_payload(
    rpc_path: &str,
    body: &[u8],
    nonce: &str,
    context: &[u8],
    generation: u64,
) -> String {
    format!(
        "tengri.ofz.v1\n{rpc_path}\n{:x}\n{nonce}\n{}\n{generation}",
        Sha256::digest(body),
        URL_SAFE_NO_PAD.encode(context)
    )
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2)
        || !value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
    {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|part| u8::from_str_radix(std::str::from_utf8(part).ok()?, 16).ok())
        .collect()
}

pub fn deterministic_agent_id(owner_hash: &str, reservation_id: &str) -> String {
    format!(
        "agent-{:x}",
        Sha256::digest(format!("ofz.workspace.v1\n{owner_hash}\n{reservation_id}"))
    )[..38]
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bff_protobuf_and_independent_hmac_vector_match_rust() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/ofz-request-v1.json")).unwrap();
        let field = |name: &str| vector[name].as_str().unwrap();
        let context = base64::engine::general_purpose::STANDARD
            .decode(field("contextBase64"))
            .unwrap();
        let decoded = RequestContext::decode(context.as_slice()).unwrap();
        assert_eq!(decoded.encode_to_vec(), context);
        assert_eq!(
            decoded.workspace_uid,
            "33333333-3333-4333-8333-333333333333"
        );
        let payload = signing_payload(
            field("rpcPath"),
            &decode_hex(field("bodyHex")).unwrap(),
            field("nonce"),
            &context,
            7,
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(&parse_key(field("keyHex")).unwrap()).unwrap();
        mac.update(payload.as_bytes());
        mac.verify_slice(&decode_hex(field("signature")).unwrap())
            .unwrap();
    }

    #[test]
    fn signed_contract_binds_every_field_and_has_no_key_bundle() {
        let payload = signing_payload(
            "/rpc",
            b"body",
            "nonce",
            b"actor/session/uid/epoch/origin/deadline",
            7,
        );
        for changed in [
            signing_payload(
                "/other",
                b"body",
                "nonce",
                b"actor/session/uid/epoch/origin/deadline",
                7,
            ),
            signing_payload(
                "/rpc",
                b"changed",
                "nonce",
                b"actor/session/uid/epoch/origin/deadline",
                7,
            ),
            signing_payload(
                "/rpc",
                b"body",
                "replay",
                b"actor/session/uid/epoch/origin/deadline",
                7,
            ),
            signing_payload("/rpc", b"body", "nonce", b"different-context", 7),
            signing_payload(
                "/rpc",
                b"body",
                "nonce",
                b"actor/session/uid/epoch/origin/deadline",
                8,
            ),
        ] {
            assert_ne!(payload, changed);
        }
        assert!(decode_hex(&"a".repeat(64)).is_some());
        for value in ["aa,bb", "AA", "abc", "ab\n"] {
            assert!(decode_hex(value).is_none());
        }
    }
}
