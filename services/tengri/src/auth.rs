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

use crate::ofz::{
    self,
    proto::{Action, RequestContext, actor::Identity},
};

mod replay;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Principal {
    pub owner_hash: String,
    pub context: RequestContext,
    pub recovery_generation: u64,
    pub action: Action,
    #[serde(skip)]
    verified_rpc_admission: bool,
}

impl Principal {
    pub(crate) fn refresh_run_context(&mut self) -> Result<(), Status> {
        self.context.deadline_unix_ms = ofz::now_ms()? + ofz::AUDITED_REQUEST_BUDGET_MS;
        Ok(())
    }

    pub(crate) fn policy_context(&self) -> Result<RequestContext, Status> {
        let mut context = self.context.clone();
        if self.verified_rpc_admission {
            context.deadline_unix_ms = ofz::now_ms()? + ofz::AUDITED_REQUEST_BUDGET_MS;
        }
        Ok(context)
    }
}

#[cfg(test)]
impl Principal {
    pub(crate) fn fixture(owner_hash: &str, workspace_uid: &str, action: Action) -> Self {
        Self {
            owner_hash: owner_hash.into(),
            recovery_generation: 1,
            action,
            verified_rpc_admission: false,
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
    audience: &str,
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
            audience,
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
    request
        .metadata_mut()
        .insert("x-tengri-audience", audience.parse().unwrap());
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
    audience: Arc<str>,
    replay: Arc<replay::Window>,
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
    async fn signing_key(&self) -> Result<[u8; 32], Status> {
        match &self.key {
            SigningKey::Mounted(path) => parse_key(
                &tokio::fs::read_to_string(path.as_ref())
                    .await
                    .map_err(|_| Status::unavailable("request key unavailable"))?,
            )
            .map_err(|_| Status::unavailable("request key unavailable")),
            #[cfg(test)]
            SigningKey::Fixture(key) => Ok(*key),
        }
    }

    pub(crate) async fn seal_run(&self, domain: &str, payload: &[u8]) -> Result<String, Status> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.signing_key().await?)
            .map_err(|_| Status::internal("invalid request key"))?;
        mac.update(b"tengri.durable-run.v1\n");
        mac.update(domain.as_bytes());
        mac.update(b"\n");
        mac.update(payload);
        Ok(format!("{:x}", mac.finalize().into_bytes()))
    }

    pub(crate) async fn verify_run(
        &self,
        domain: &str,
        payload: &[u8],
        signature: &str,
    ) -> Result<(), Status> {
        let signature = decode_hex(signature)
            .filter(|value| value.len() == 32)
            .ok_or_else(|| Status::unauthenticated("invalid durable run signature"))?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.signing_key().await?)
            .map_err(|_| Status::internal("invalid request key"))?;
        mac.update(b"tengri.durable-run.v1\n");
        mac.update(domain.as_bytes());
        mac.update(b"\n");
        mac.update(payload);
        mac.verify_slice(&signature)
            .map_err(|_| Status::unauthenticated("invalid durable run signature"))
    }

    pub fn new(key_file: &Path, origin: String) -> anyhow::Result<Self> {
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
            audience: uuid::Uuid::new_v4().to_string().into(),
            replay: Arc::new(replay::Window::default()),
            origin: origin.into(),
        })
    }

    #[cfg(test)]
    pub fn fixture(origin: String) -> Self {
        Self {
            key: SigningKey::Fixture([0x68; 32]),
            audience: uuid::Uuid::new_v4().to_string().into(),
            replay: Arc::new(replay::Window::default()),
            origin: origin.into(),
        }
    }

    pub fn audience(&self) -> &str {
        &self.audience
    }

    #[tracing::instrument(name = "auth.verify_request", skip_all)]
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
        let audience = header(request, "x-tengri-audience")?;
        if audience != self.audience.as_ref() {
            return Err(Status::unauthenticated("request receiver changed"));
        }
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
            &audience,
        );
        let key = self.signing_key().await?;
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
        self.replay
            .consume(replay_key.try_into().unwrap(), context.deadline_unix_ms)
            .await?;
        Ok(Principal {
            owner_hash: human,
            context,
            recovery_generation,
            action,
            verified_rpc_admission: true,
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
    audience: &str,
) -> String {
    format!(
        "tengri.ofz.v2\n{audience}\n{rpc_path}\n{:x}\n{nonce}\n{}\n{generation}",
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

    #[tokio::test]
    async fn signed_authentication_does_not_wait_for_postgresql() {
        let auth = Authenticator::fixture("https://proompteng.ai".into());
        let principal = Principal::fixture(&"a".repeat(64), "", Action::WorkspaceMetadataRead);
        let path = "/proompteng.runtime.v1.MicroVMControlPlane/ListAgents";
        let request = signed_fixture_request(
            crate::grpc::proto::ListAgentsRequest {},
            &principal,
            path,
            auth.audience(),
        );
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            auth.authorize(&request, path),
        )
        .await;
        assert!(
            matches!(result, Ok(Ok(_))),
            "signed authentication waited for PostgreSQL: {result:?}"
        );
        assert_eq!(
            auth.clone()
                .authorize(&request, path)
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unauthenticated
        );
        let restarted = Authenticator::fixture("https://proompteng.ai".into());
        assert_eq!(
            restarted
                .authorize(&request, path)
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unauthenticated
        );
        let mut rebound = request;
        rebound
            .metadata_mut()
            .insert("x-tengri-audience", restarted.audience().parse().unwrap());
        assert_eq!(
            restarted
                .authorize(&rebound, path)
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unauthenticated
        );
        let fresh = signed_fixture_request(
            crate::grpc::proto::ListAgentsRequest {},
            &principal,
            path,
            restarted.audience(),
        );
        assert!(restarted.authorize(&fresh, path).await.is_ok());
    }

    #[tokio::test]
    async fn altered_or_expired_requests_and_duplicate_headers_fail_closed() {
        let auth = Authenticator::fixture("https://proompteng.ai".into());
        let principal = Principal::fixture(&"a".repeat(64), "", Action::WorkspaceMetadataRead);
        let path = "/proompteng.runtime.v1.MicroVMControlPlane/GetAgent";
        let request = signed_fixture_request(
            crate::grpc::proto::GetAgentRequest { id: "agent".into() },
            &principal,
            path,
            auth.audience(),
        );
        let mut changed = Request::new(crate::grpc::proto::GetAgentRequest {
            id: "another".into(),
        });
        *changed.metadata_mut() = request.metadata().clone();
        assert_eq!(
            auth.authorize(&changed, path).await.unwrap_err().code(),
            tonic::Code::Unauthenticated
        );
        for deadline in [ofz::now_ms().unwrap() - 1, ofz::now_ms().unwrap() + 5500] {
            let mut expired = principal.clone();
            expired.context.deadline_unix_ms = deadline;
            let request = signed_fixture_request(
                crate::grpc::proto::GetAgentRequest { id: "agent".into() },
                &expired,
                path,
                auth.audience(),
            );
            assert_eq!(
                auth.authorize(&request, path).await.unwrap_err().code(),
                tonic::Code::Unauthenticated
            );
        }
        let mut duplicated = request;
        let mut legacy = Request::new(crate::grpc::proto::GetAgentRequest { id: "agent".into() });
        *legacy.metadata_mut() = duplicated.metadata().clone();
        let context = principal.context.encode_to_vec();
        let nonce = header(&legacy, "x-tengri-nonce").unwrap();
        let payload = format!(
            "tengri.ofz.v1\n{path}\n{:x}\n{nonce}\n{}\n{}",
            Sha256::digest(legacy.get_ref().encode_to_vec()),
            URL_SAFE_NO_PAD.encode(context),
            principal.recovery_generation
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(&[0x68; 32]).unwrap();
        mac.update(payload.as_bytes());
        legacy.metadata_mut().insert(
            "x-tengri-signature",
            format!("{:x}", mac.finalize().into_bytes())
                .parse()
                .unwrap(),
        );
        assert_eq!(
            auth.authorize(&legacy, path).await.unwrap_err().code(),
            tonic::Code::Unauthenticated
        );
        legacy.metadata_mut().remove("x-tengri-audience");
        assert_eq!(
            auth.authorize(&legacy, path).await.unwrap_err().code(),
            tonic::Code::Unauthenticated
        );
        let audience = duplicated
            .metadata()
            .get("x-tengri-audience")
            .unwrap()
            .clone();
        duplicated
            .metadata_mut()
            .append("x-tengri-audience", audience);
        assert_eq!(
            auth.authorize(&duplicated, path).await.unwrap_err().code(),
            tonic::Code::Unauthenticated
        );
    }

    #[test]
    fn bff_protobuf_and_independent_hmac_vector_match_rust() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/ofz-request-v2.json")).unwrap();
        let field = |name: &str| vector[name].as_str().unwrap();
        let context = base64::engine::general_purpose::STANDARD
            .decode(field("contextBase64"))
            .unwrap();
        assert_eq!(
            RequestContext::decode(context.as_slice())
                .unwrap()
                .encode_to_vec(),
            context
        );
        let body = decode_hex(field("bodyHex")).unwrap();
        let payload = signing_payload(
            field("rpcPath"),
            &body,
            field("nonce"),
            &context,
            7,
            field("audience"),
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(&parse_key(field("keyHex")).unwrap()).unwrap();
        mac.update(payload.as_bytes());
        mac.verify_slice(&decode_hex(field("signature")).unwrap())
            .unwrap();
        for changed in [
            signing_payload(
                "/other",
                &body,
                field("nonce"),
                &context,
                7,
                field("audience"),
            ),
            signing_payload(
                field("rpcPath"),
                b"other",
                field("nonce"),
                &context,
                7,
                field("audience"),
            ),
            signing_payload(
                field("rpcPath"),
                &body,
                "other",
                &context,
                7,
                field("audience"),
            ),
            signing_payload(
                field("rpcPath"),
                &body,
                field("nonce"),
                b"other",
                7,
                field("audience"),
            ),
            signing_payload(
                field("rpcPath"),
                &body,
                field("nonce"),
                &context,
                8,
                field("audience"),
            ),
            signing_payload(
                field("rpcPath"),
                &body,
                field("nonce"),
                &context,
                7,
                "88888888-8888-4888-8888-888888888888",
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
