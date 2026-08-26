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
                &Patch::Merge(json!({
                    "spec": {
                        "idleDeadline": (now + chrono::Duration::minutes(IDLE_MINUTES)).to_rfc3339(),
                    }
                })),
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
