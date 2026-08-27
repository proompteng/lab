use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use kube::{
    Api, Client,
    api::{Patch, PatchParams},
};
use serde_json::json;
use tracing::warn;

use crate::crd::{IDLE_MINUTES, MicroVM};

const ACTIVITY_WRITE_INTERVAL: Duration = Duration::from_secs(20);
pub const LAST_ACTIVITY_ANNOTATION: &str = "runtime.proompteng.ai/last-activity-at";
pub const RESUME_STARTED_AT_ANNOTATION: &str = "runtime.proompteng.ai/resume-started-at";

#[derive(Clone)]
pub struct ActivityTracker {
    client: Client,
    namespace: Arc<str>,
    last_write: Arc<Mutex<HashMap<String, Instant>>>,
}

impl ActivityTracker {
    pub fn new(client: Client, namespace: String) -> Self {
        Self {
            client,
            namespace: namespace.into(),
            last_write: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn touch_now(&self, agent_id: &str, now: DateTime<Utc>) -> Result<(), kube::Error> {
        let agents: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        agents
            .patch(
                agent_id,
                &PatchParams::default(),
                &Patch::Merge(activity_metadata_patch(now)),
            )
            .await?;
        agents
            .patch_status(
                agent_id,
                &PatchParams::default(),
                &Patch::Merge(json!({"status": {"lastActivityAt": now.to_rfc3339()}})),
            )
            .await?;
        Ok(())
    }

    pub fn touch(&self, agent_id: &str) {
        let now = Instant::now();
        let should_write = self.last_write.lock().is_ok_and(|mut writes| {
            writes
                .retain(|_, touched_at| now.duration_since(*touched_at) < Duration::from_secs(300));
            match writes.get(agent_id) {
                Some(touched_at) if now.duration_since(*touched_at) < ACTIVITY_WRITE_INTERVAL => {
                    false
                }
                _ => {
                    writes.insert(agent_id.to_owned(), now);
                    true
                }
            }
        });
        if !should_write {
            return;
        }

        let tracker = self.clone();
        let agent_id = agent_id.to_owned();
        tokio::spawn(async move {
            if let Err(error) = tracker.touch_now(&agent_id, Utc::now()).await {
                warn!(agent_id, error = %error, "failed to record authenticated agent activity");
            }
        });
    }
}

pub fn last_activity_at(microvm: &MicroVM) -> Option<String> {
    let annotation = microvm
        .metadata
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get(LAST_ACTIVITY_ANNOTATION));
    let status = microvm
        .status
        .as_ref()
        .and_then(|status| status.last_activity_at.as_ref());

    [annotation, status, Some(&microvm.spec.created_at)]
        .into_iter()
        .flatten()
        .filter_map(|value| {
            DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|parsed| (parsed, value))
        })
        .max_by_key(|(parsed, _)| *parsed)
        .map(|(_, value)| value.to_owned())
}

pub fn idle_deadline_passed(microvm: &MicroVM, now: DateTime<Utc>) -> bool {
    let configured_deadline = DateTime::parse_from_rfc3339(&microvm.spec.idle_deadline)
        .ok()
        .map(|value| value.with_timezone(&Utc));
    let activity_deadline = last_activity_at(microvm)
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .map(|value| value.with_timezone(&Utc) + chrono::Duration::minutes(IDLE_MINUTES));

    configured_deadline
        .into_iter()
        .chain(activity_deadline)
        .max()
        .is_some_and(|deadline| deadline <= now)
}

fn activity_metadata_patch(now: DateTime<Utc>) -> serde_json::Value {
    json!({
        "metadata": {
            "annotations": {
                LAST_ACTIVITY_ANNOTATION: now.to_rfc3339(),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{
        MicroVMArchitecture, MicroVMDesiredState, MicroVMResources, MicroVMSpec, MicroVMStatus,
    };

    fn test_microvm(now: DateTime<Utc>) -> MicroVM {
        MicroVM::new(
            "agent",
            MicroVMSpec {
                display_name: "Agent".to_owned(),
                owner_hash: "owner".to_owned(),
                desired_state: MicroVMDesiredState::Running,
                image: format!("registry.example/nanoagent@sha256:{}", "a".repeat(64)),
                architecture: MicroVMArchitecture::Amd64,
                resources: MicroVMResources::default(),
                created_at: (now - chrono::Duration::hours(2)).to_rfc3339(),
                idle_deadline: (now - chrono::Duration::hours(1)).to_rfc3339(),
                expires_at: (now + chrono::Duration::hours(2)).to_rfc3339(),
            },
        )
    }

    #[test]
    fn activity_heartbeat_updates_metadata_without_mutating_spec() {
        let now = Utc::now();
        let patch = activity_metadata_patch(now);

        assert_eq!(
            patch.pointer(&format!(
                "/metadata/annotations/{}",
                LAST_ACTIVITY_ANNOTATION.replace('/', "~1")
            )),
            Some(&json!(now.to_rfc3339())),
        );
        assert!(patch.get("spec").is_none());
    }

    #[test]
    fn newest_activity_source_extends_the_effective_idle_deadline() {
        let now = Utc::now();
        let now_text = now.to_rfc3339();
        let mut microvm = test_microvm(now);
        microvm.status = Some(MicroVMStatus {
            last_activity_at: Some((now - chrono::Duration::minutes(30)).to_rfc3339()),
            ..MicroVMStatus::default()
        });
        microvm.metadata.annotations = Some(std::collections::BTreeMap::from([(
            LAST_ACTIVITY_ANNOTATION.to_owned(),
            now_text.clone(),
        )]));

        assert_eq!(
            last_activity_at(&microvm).as_deref(),
            Some(now_text.as_str())
        );
        assert!(!idle_deadline_passed(&microvm, now));
        assert!(idle_deadline_passed(
            &microvm,
            now + chrono::Duration::minutes(IDLE_MINUTES + 1),
        ));
    }
}
