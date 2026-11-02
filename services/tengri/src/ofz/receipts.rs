use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use prost::Message;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, OwnedMutexGuard};
use tonic::Status;

use super::proto::CheckRequest;

const CAPACITY: usize = 4096;
const MAX_AGE: Duration = Duration::from_secs(7 * 60 * 60);

#[derive(Debug)]
pub(super) struct Receipt {
    pub id: String,
    pub created: Instant,
}

impl Receipt {
    pub fn fresh(&self) -> bool {
        self.created.elapsed() < MAX_AGE
    }
}

type Slot = Arc<Mutex<Option<Receipt>>>;

pub(super) enum Binding {
    Reused(String),
    New(OwnedMutexGuard<Option<Receipt>>),
}

impl Binding {
    pub fn id(&self) -> &str {
        match self {
            Self::Reused(id) => id,
            Self::New(_) => "",
        }
    }

    pub fn record(self, id: String) {
        if let Self::New(mut receipt) = self {
            *receipt = Some(Receipt {
                id,
                created: Instant::now(),
            });
        }
    }
}

#[derive(Default)]
pub(super) struct Cache {
    entries: Mutex<HashMap<[u8; 32], (Instant, Slot)>>,
}

impl Cache {
    pub async fn bind(&self, request: &CheckRequest, recovery: u64) -> Result<Binding, Status> {
        let slot = self.slot(request, recovery).await?;
        let remaining = super::remaining_deadline(request)?.min(super::DURABLE_TIMEOUT);
        let mut receipt = tokio::time::timeout(remaining, slot.lock_owned())
            .await
            .map_err(|_| Status::deadline_exceeded("authorization receipt deadline expired"))?;
        if receipt.as_ref().is_some_and(|receipt| !receipt.fresh()) {
            *receipt = None;
        }
        if let Some(receipt) = receipt.as_ref() {
            Ok(Binding::Reused(receipt.id.clone()))
        } else {
            Ok(Binding::New(receipt))
        }
    }

    pub async fn slot(&self, request: &CheckRequest, recovery: u64) -> Result<Slot, Status> {
        let key = key(request, recovery);
        let mut entries = self.entries.lock().await;
        if let Some((used, slot)) = entries.get_mut(&key) {
            *used = Instant::now();
            return Ok(slot.clone());
        }
        if entries.len() == CAPACITY {
            let oldest = entries
                .iter()
                .filter(|(_, (_, slot))| Arc::strong_count(slot) == 1)
                .min_by_key(|(_, (used, _))| *used)
                .map(|(key, _)| *key)
                .ok_or_else(|| Status::resource_exhausted("audit receipt cache busy"))?;
            entries.remove(&oldest);
        }
        let slot = Arc::new(Mutex::new(None));
        entries.insert(key, (Instant::now(), slot.clone()));
        Ok(slot)
    }
}

fn key(request: &CheckRequest, recovery: u64) -> [u8; 32] {
    let mut binding = request.clone();
    binding.stream_receipt_id.clear();
    if let Some(context) = &mut binding.context {
        context.trace_id.clear();
        context.deadline_unix_ms = 0;
    }
    let mut digest = Sha256::new();
    digest.update(b"tengri.audit-binding.v1\n");
    digest.update(recovery.to_be_bytes());
    digest.update(binding.encode_to_vec());
    digest.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth::Principal,
        ofz::proto::{Action, Actor, Resource, ResourceKind, actor::Identity},
    };

    fn request() -> CheckRequest {
        CheckRequest {
            context: Some(
                Principal::fixture(
                    &"a".repeat(64),
                    "11111111-1111-4111-8111-111111111111",
                    Action::PreviewAccess,
                )
                .context,
            ),
            action: Action::PreviewAccess as i32,
            resource: Some(Resource {
                kind: ResourceKind::Workspace as i32,
                id: "11111111-1111-4111-8111-111111111111".into(),
            }),
            target: "/editor/file".into(),
            stream_receipt_id: String::new(),
        }
    }

    #[tokio::test]
    async fn receipts_share_only_the_exact_authority_and_target() {
        let cache = Cache::default();
        let original = request();
        let slot = cache.slot(&original, 1).await.unwrap();
        let mut same = original.clone();
        same.context.as_mut().unwrap().trace_id = uuid::Uuid::new_v4().to_string();
        same.context.as_mut().unwrap().deadline_unix_ms += 1;
        assert!(Arc::ptr_eq(&slot, &cache.slot(&same, 1).await.unwrap()));
        let mut variants = Vec::new();
        for field in [
            "session",
            "grant",
            "workspace",
            "epoch",
            "origin",
            "actor",
            "contract",
            "action",
            "resource",
            "target",
        ] {
            let mut changed = original.clone();
            let context = changed.context.as_mut().unwrap();
            match field {
                "session" => context.session_id = "different".into(),
                "grant" => context.grant_id = "different".into(),
                "workspace" => context.workspace_uid = "different".into(),
                "epoch" => context.runtime_epoch = "different".into(),
                "origin" => context.origin = "https://other.example".into(),
                "actor" => {
                    context.actor = Some(Actor {
                        identity: Some(Identity::HumanId("b".repeat(64))),
                    })
                }
                "contract" => context.contract_version += 1,
                "action" => changed.action = Action::FilesWrite as i32,
                "resource" => changed.resource.as_mut().unwrap().id = "different".into(),
                "target" => changed.target = "/editor/other".into(),
                _ => unreachable!(),
            }
            variants.push(changed);
        }
        for changed in variants {
            assert!(!Arc::ptr_eq(&slot, &cache.slot(&changed, 1).await.unwrap()));
        }
        assert!(!Arc::ptr_eq(
            &slot,
            &cache.slot(&original, 2).await.unwrap()
        ));
        *slot.lock().await = Some(Receipt {
            id: "old".into(),
            created: Instant::now() - MAX_AGE,
        });
        assert!(!slot.lock().await.as_ref().unwrap().fresh());
    }

    #[tokio::test]
    async fn cache_never_evicts_an_inflight_binding_or_exceeds_its_bound() {
        let cache = Cache::default();
        let mut request = request();
        let mut retained = Vec::new();
        for n in 0..CAPACITY {
            request.target = n.to_string();
            retained.push(cache.slot(&request, 1).await.unwrap());
        }
        request.target = "overflow".into();
        assert_eq!(
            cache.slot(&request, 1).await.unwrap_err().code(),
            tonic::Code::ResourceExhausted
        );
        retained.pop();
        assert!(cache.slot(&request, 1).await.is_ok());
        assert_eq!(cache.entries.lock().await.len(), CAPACITY);
    }
}
