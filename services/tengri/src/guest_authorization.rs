use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    sync::Arc,
};

use anyhow::{Context, ensure};
use aws_lc_rs::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const CONTEXT_HEADER: &str = "x-tengri-guest-authorization";
pub const SIGNATURE_HEADER: &str = "x-tengri-guest-signature";
pub const PROTOCOL_VERSION: u32 = 4;
pub const MAX_CONTEXT_BYTES: usize = 16 << 10;
pub const MAX_ADMISSION_MS: u64 = 5000;
const REQUEST_DOMAIN: &[u8] = b"tengri-guest-request-v4\0";
const RPC_PREFIX: &str = "/proompteng.runtime.guest.v1.NanoagentService/";

pub fn recovery_generation_from_file(path: &Path) -> anyhow::Result<u64> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .context("open guest recovery generation")?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.len() <= 20 && metadata.mode() & 0o022 == 0,
        "guest recovery generation must be a read-only bounded regular file"
    );
    let mut value = String::new();
    file.take(21).read_to_string(&mut value)?;
    let value = value.strip_suffix('\n').unwrap_or(&value);
    let generation: u64 = value.parse().context("invalid guest recovery generation")?;
    ensure!(
        generation > 0 && generation <= i64::MAX as u64 && generation.to_string() == value,
        "canonical positive guest recovery generation required"
    );
    Ok(generation)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GuestAction {
    #[serde(rename = "ACTION_WORKSPACE_METADATA_READ")]
    WorkspaceMetadataRead,
    #[serde(rename = "ACTION_FILES_OBSERVE")]
    FilesObserve,
    #[serde(rename = "ACTION_FILES_WRITE")]
    FilesWrite,
    #[serde(rename = "ACTION_TERMINAL_OBSERVE")]
    TerminalObserve,
    #[serde(rename = "ACTION_TERMINAL_CONTROL")]
    TerminalControl,
    #[serde(rename = "ACTION_CODEX_OBSERVE")]
    CodexObserve,
    #[serde(rename = "ACTION_CODEX_CONTROL")]
    CodexControl,
    #[serde(rename = "ACTION_BROWSER_OBSERVE")]
    BrowserObserve,
    #[serde(rename = "ACTION_BROWSER_CONTROL")]
    BrowserControl,
    #[serde(rename = "ACTION_EDITOR_OPEN")]
    EditorOpen,
    #[serde(rename = "ACTION_PREVIEW_OBSERVE")]
    PreviewObserve,
    #[serde(rename = "ACTION_PREVIEW_ACCESS")]
    PreviewAccess,
}

impl GuestAction {
    fn observer(self) -> bool {
        matches!(
            self,
            Self::WorkspaceMetadataRead
                | Self::FilesObserve
                | Self::TerminalObserve
                | Self::CodexObserve
                | Self::BrowserObserve
                | Self::PreviewObserve
        )
    }
}

pub fn rpc_action(method: &str) -> Option<GuestAction> {
    Some(match method.strip_prefix(RPC_PREFIX)? {
        "GetInfo" => GuestAction::WorkspaceMetadataRead,
        "OpenEditor" => GuestAction::EditorOpen,
        "OpenBrowser" => GuestAction::BrowserControl,
        "StatFile" | "ListFiles" | "ReadFile" | "SearchFiles" | "WatchFiles" => {
            GuestAction::FilesObserve
        }
        "WriteFile" | "CreateDirectory" | "MoveFile" | "DeleteFile" => GuestAction::FilesWrite,
        "ListTerminals" => GuestAction::TerminalObserve,
        "CreateTerminal" | "TerminateTerminal" | "AttachTerminal" => GuestAction::TerminalControl,
        "CodexCall" | "CodexLogin" | "WatchCodexEvents" => GuestAction::CodexControl,
        _ => return None,
    })
}

pub fn request_action(method: &str) -> Option<GuestAction> {
    match method {
        "HTTP GET" | "HTTP HEAD" | "HTTP POST" | "HTTP PUT" | "HTTP PATCH" | "HTTP DELETE"
        | "HTTP OPTIONS" => Some(GuestAction::PreviewAccess),
        _ => rpc_action(method),
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GuestActor {
    Human {
        subject: String,
        session_id: String,
    },
    Agent {
        subject: String,
        grant_id: String,
    },
    Workload {
        subject: String,
        purpose: MaintenancePurpose,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaintenancePurpose {
    Probe,
    TerminalCleanup,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
// Ofz checks the full policy before the controller signs one exact target. The
// guest receives only the output limits for that request, never a reusable policy.
pub struct ObservationBudget {
    pub max_bytes: u32,
    pub max_items: u32,
}

fn observation_target(action: GuestAction, target: &str) -> bool {
    match action {
        GuestAction::WorkspaceMetadataRead | GuestAction::PreviewObserve => target.is_empty(),
        GuestAction::FilesObserve => clean_file_path(target),
        GuestAction::TerminalObserve | GuestAction::CodexObserve => {
            !target.is_empty() && bounded_text(target, 128) && !target.contains(['/', '\\'])
        }
        GuestAction::BrowserObserve => matches!(target, "status" | "screenshot"),
        _ => false,
    }
}

fn clean_file_path(path: &str) -> bool {
    path.starts_with("/workspace/")
        && bounded_text(path, 4096)
        && !path.contains('\\')
        && path.split('/').skip(1).all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !matches!(
                    part,
                    ".ssh"
                        | ".aws"
                        | ".kube"
                        | ".codex"
                        | ".config"
                        | ".git"
                        | ".npmrc"
                        | ".netrc"
                        | ".pypirc"
                        | "credentials.json"
                        | "auth.json"
                        | ".env"
                )
                && !part.starts_with(".env.")
        })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestContext {
    pub protocol_version: u32,
    pub actor: GuestActor,
    pub action: GuestAction,
    pub workspace_uid: String,
    pub runtime_epoch: String,
    pub slot_epoch: u64,
    pub pod_uid: String,
    pub leader_owner: String,
    pub leader_generation: u64,
    pub recovery_generation: u64,
    pub audit_receipt_id: String,
    pub method: String,
    pub target: String,
    pub body_sha256: String,
    pub issued_at_unix_ms: u64,
    pub deadline_unix_ms: u64,
    pub nonce: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation: Option<ObservationBudget>,
}

pub struct GuestBinding<'a> {
    pub workspace_uid: &'a str,
    pub runtime_epoch: &'a str,
    pub slot_epoch: u64,
    pub pod_uid: &'a str,
    pub leader_owner: &'a str,
    pub leader_generation: u64,
    pub recovery_generation: u64,
    pub action: GuestAction,
    pub method: &'a str,
    pub target: &'a str,
    pub body: &'a [u8],
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|uid| !uid.is_nil() && uid.to_string() == value)
}

fn bounded_text(value: &str, max: usize) -> bool {
    value.len() <= max && !value.chars().any(|c| c.is_control() || c == '\u{fffd}')
}

pub fn body_sha256(body: &[u8]) -> String {
    format!("{:x}", Sha256::digest(body))
}

impl GuestContext {
    pub fn validate(&self, now_ms: u64) -> anyhow::Result<()> {
        ensure!(
            self.protocol_version == PROTOCOL_VERSION,
            "unsupported guest authorization protocol"
        );
        for uid in [
            &self.workspace_uid,
            &self.runtime_epoch,
            &self.pod_uid,
            &self.leader_owner,
            &self.audit_receipt_id,
            &self.nonce,
        ] {
            ensure!(canonical_uuid(uid), "invalid guest authorization binding");
        }
        ensure!(
            self.slot_epoch > 0
                && self.leader_generation > 0
                && self.leader_generation <= i64::MAX as u64
                && self.recovery_generation > 0,
            "invalid guest fencing generation"
        );
        match &self.actor {
            GuestActor::Human {
                subject,
                session_id,
            } => {
                ensure!(
                    subject.len() == 64
                        && subject
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                        && canonical_uuid(session_id),
                    "invalid human authorization binding"
                );
            }
            GuestActor::Agent { subject, grant_id } => {
                ensure!(
                    canonical_uuid(subject) && canonical_uuid(grant_id),
                    "invalid agent authorization binding"
                );
                ensure!(
                    self.action.observer() && self.observation.is_some(),
                    "agent authorization requires a bounded diagnostic action"
                );
            }
            GuestActor::Workload { subject, purpose } => {
                ensure!(
                    self.observation.is_none(),
                    "workload maintenance cannot carry an observation budget"
                );
                ensure!(
                    subject == "spiffe://proompteng.ai/ns/tengri/sa/tengri",
                    "invalid workload authorization binding"
                );
                ensure!(
                    match purpose {
                        MaintenancePurpose::Probe =>
                            self.action == GuestAction::WorkspaceMetadataRead
                                && self.method == format!("{RPC_PREFIX}GetInfo")
                                && self.target.is_empty(),
                        MaintenancePurpose::TerminalCleanup =>
                            self.action == GuestAction::TerminalControl
                                && self.method == format!("{RPC_PREFIX}TerminateTerminal")
                                && !self.target.is_empty(),
                    },
                    "workload authorization exceeds its maintenance purpose"
                );
            }
        }
        ensure!(
            request_action(&self.method) == Some(self.action),
            "guest RPC does not permit this action"
        );
        ensure!(
            bounded_text(&self.target, 4096),
            "invalid guest request target"
        );
        ensure!(
            self.body_sha256.len() == 64
                && self
                    .body_sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "invalid guest request hash"
        );
        ensure!(
            self.issued_at_unix_ms > 0
                && self.issued_at_unix_ms <= now_ms.saturating_add(1000)
                && self.deadline_unix_ms > now_ms
                && self.deadline_unix_ms > self.issued_at_unix_ms
                && self.deadline_unix_ms - self.issued_at_unix_ms <= MAX_ADMISSION_MS,
            "guest authorization expired or outside its deadline"
        );
        if let Some(budget) = &self.observation {
            ensure!(
                budget.max_bytes > 0
                    && budget.max_bytes <= 1 << 20
                    && budget.max_items > 0
                    && budget.max_items <= 200,
                "invalid guest observation bounds"
            );
            ensure!(
                observation_target(self.action, &self.target),
                "invalid guest observation target"
            );
        }
        Ok(())
    }

    pub fn require_binding(&self, expected: &GuestBinding<'_>) -> anyhow::Result<()> {
        ensure!(
            self.workspace_uid == expected.workspace_uid
                && self.runtime_epoch == expected.runtime_epoch
                && self.slot_epoch == expected.slot_epoch
                && self.pod_uid == expected.pod_uid
                && self.leader_owner == expected.leader_owner
                && self.leader_generation == expected.leader_generation
                && self.recovery_generation == expected.recovery_generation,
            "guest runtime or authority changed"
        );
        ensure!(
            self.action == expected.action
                && self.method == expected.method
                && self.target == expected.target
                && self.body_sha256 == body_sha256(expected.body),
            "guest request differs from its authorization"
        );
        Ok(())
    }
}

#[derive(Clone)]
pub struct GuestSigner(Arc<Ed25519KeyPair>);

impl GuestSigner {
    pub fn from_file(path: &Path) -> anyhow::Result<Self> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)
            .context("open guest signing key")?;
        let metadata = file.metadata().context("read guest signing-key metadata")?;
        ensure!(
            metadata.is_file() && metadata.len() == 32 && metadata.mode() & 0o027 == 0,
            "guest signing key must be a private 32-byte regular file"
        );
        let mut seed = Zeroizing::new([0; 32]);
        file.read_exact(seed.as_mut())
            .context("read guest signing key")
            .and_then(|()| Self::from_seed(seed.as_ref()))
    }

    pub fn from_seed(seed: &[u8]) -> anyhow::Result<Self> {
        ensure!(
            seed.len() == 32,
            "guest signing key must contain a 32-byte Ed25519 seed"
        );
        Ok(Self(Arc::new(
            Ed25519KeyPair::from_seed_unchecked(seed)
                .map_err(|_| anyhow::anyhow!("invalid guest signing key"))?,
        )))
    }

    pub fn public_key(&self) -> &[u8] {
        self.0.public_key().as_ref()
    }

    pub fn sign(&self, context: &GuestContext, now_ms: u64) -> anyhow::Result<GuestProof> {
        context.validate(now_ms)?;
        let payload = serde_json::to_vec(context)?;
        ensure!(
            payload.len() <= MAX_CONTEXT_BYTES,
            "guest authorization context exceeds its limit"
        );
        Ok(GuestProof {
            context: URL_SAFE_NO_PAD.encode(&payload),
            signature: URL_SAFE_NO_PAD
                .encode(self.0.sign(&[REQUEST_DOMAIN, &payload].concat()).as_ref()),
        })
    }
}

#[derive(Clone)]
pub struct GuestVerifier([u8; 32]);

impl GuestVerifier {
    pub fn from_file(path: &Path) -> anyhow::Result<Self> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)
            .context("open guest verification key")?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file() && metadata.len() == 32 && metadata.mode() & 0o022 == 0,
            "guest verification key must be a read-only 32-byte regular file"
        );
        let mut bytes = [0; 32];
        file.read_exact(&mut bytes)
            .context("read guest verification key")?;
        Self::from_bytes(&bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> anyhow::Result<Self> {
        Ok(Self(bytes.try_into().map_err(|_| {
            anyhow::anyhow!("guest verification key must contain 32 bytes")
        })?))
    }

    pub fn public_key(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn verify(&self, proof: &GuestProof, now_ms: u64) -> anyhow::Result<GuestContext> {
        ensure!(
            proof.context.len() <= MAX_CONTEXT_BYTES * 4 / 3 + 4 && proof.signature.len() == 86,
            "invalid guest proof size"
        );
        let payload = URL_SAFE_NO_PAD
            .decode(&proof.context)
            .context("invalid guest proof encoding")?;
        let signature = URL_SAFE_NO_PAD
            .decode(&proof.signature)
            .context("invalid guest signature encoding")?;
        ensure!(
            URL_SAFE_NO_PAD.encode(&payload) == proof.context
                && URL_SAFE_NO_PAD.encode(&signature) == proof.signature,
            "noncanonical guest proof encoding"
        );
        ensure!(
            payload.len() <= MAX_CONTEXT_BYTES,
            "guest authorization context exceeds its limit"
        );
        UnparsedPublicKey::new(&ED25519, &self.0)
            .verify(&[REQUEST_DOMAIN, &payload].concat(), &signature)
            .map_err(|_| anyhow::anyhow!("invalid guest authorization signature"))?;
        let context: GuestContext =
            serde_json::from_slice(&payload).context("invalid guest authorization context")?;
        context.validate(now_ms)?;
        Ok(context)
    }

    pub fn verify_for(
        &self,
        proof: &GuestProof,
        expected: &GuestBinding<'_>,
        now_ms: u64,
    ) -> anyhow::Result<GuestContext> {
        let context = self.verify(proof, now_ms)?;
        context.require_binding(expected)?;
        Ok(context)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestProof {
    pub context: String,
    pub signature: String,
}

impl GuestProof {
    pub fn from_headers(headers: &http::HeaderMap) -> anyhow::Result<Self> {
        fn one(headers: &http::HeaderMap, name: &'static str) -> anyhow::Result<String> {
            let mut values = headers.get_all(name).iter();
            let value = values
                .next()
                .context("guest authorization header missing")?;
            ensure!(
                values.next().is_none(),
                "guest authorization header repeated"
            );
            Ok(value
                .to_str()
                .context("invalid guest authorization header")?
                .into())
        }
        Ok(Self {
            context: one(headers, CONTEXT_HEADER)?,
            signature: one(headers, SIGNATURE_HEADER)?,
        })
    }
}
