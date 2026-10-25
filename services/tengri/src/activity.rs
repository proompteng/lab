use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use anyhow::Context;
use chrono::{DateTime, Utc};
use kube::{
    Api, Client, ResourceExt,
    api::{Patch, PatchParams},
};
use serde_json::json;
use tracing::warn;

use crate::{
    crd::MicroVM,
    guest::{GuestPool, authorization::GuestAuthority},
};

#[derive(Clone)]
pub struct AgentWorkMonitor {
    guests: GuestPool,
    authority: GuestAuthority,
    activity: ActivityTracker,
}

impl AgentWorkMonitor {
    pub fn new(guests: GuestPool, authority: GuestAuthority, activity: ActivityTracker) -> Self {
        Self {
            guests,
            authority,
            activity,
        }
    }

    // Read directly from the guest; an absent subscriber, lost replay window or
    // controller restart must never turn ongoing work into an idle workspace.
    pub async fn permits_sleep(&self, microvm: &MicroVM) -> anyhow::Result<bool> {
        let guest = self
            .guests
            .for_microvm(microvm, self.authority.probe())
            .await?;
        let work = guest.codex_activity().await?;
        let now = Utc::now();
        let idle_ms = work.idle_for_ms.min(i64::MAX as u64) as i64;
        if work.working || idle_ms < i64::from(microvm.spec.power.idle_timeout_minutes) * 60_000 {
            let changed_at = if work.working {
                now
            } else {
                now.checked_sub_signed(chrono::Duration::milliseconds(idle_ms))
                    .ok_or_else(|| anyhow::anyhow!("invalid agent idle interval"))?
            };
            self.activity.touch_agent_work(microvm, changed_at).await?;
            return Ok(false);
        }
        Ok(true)
    }
}

const ACTIVITY_WRITE_INTERVAL: Duration = Duration::from_secs(20);
pub const LAST_AGENT_WORK_ANNOTATION: &str = "runtime.proompteng.ai/last-agent-work-at";
pub const LAST_ACTIVITY_ANNOTATION: &str = "runtime.proompteng.ai/last-activity-at";
pub const RESUME_STARTED_AT_ANNOTATION: &str = "runtime.proompteng.ai/resume-started-at";
pub const ACTIVE_RUN_ANNOTATION: &str = "runtime.proompteng.ai/active-run";
const IDLE_SLEEP_PREFIX: &str = "idle-sleep/";

pub fn has_idle_sleep_claim(microvm: &MicroVM) -> bool {
    microvm
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(ACTIVE_RUN_ANNOTATION))
        .is_some_and(|claim| claim == &format!("{IDLE_SLEEP_PREFIX}{}", microvm.spec.runtime_epoch))
}

pub fn is_idle_sleep_claim(value: &str) -> bool {
    value.starts_with(IDLE_SLEEP_PREFIX)
}

pub async fn claim_idle_sleep(
    client: Client,
    namespace: &str,
    microvm: &MicroVM,
) -> anyhow::Result<MicroVM> {
    use kube::ResourceExt;
    let api: Api<MicroVM> = Api::namespaced(client, namespace);
    let uid = microvm
        .uid()
        .context("MicroVM UID required for idle sleep")?;
    let version = microvm
        .resource_version()
        .context("MicroVM resource version required for idle sleep")?;
    Ok(api.patch(&microvm.name_any(),&PatchParams::default(),&Patch::Merge(json!({"metadata":{"uid":uid,"resourceVersion":version,"annotations":{ACTIVE_RUN_ANNOTATION:format!("{IDLE_SLEEP_PREFIX}{}",microvm.spec.runtime_epoch)}}}))).await?)
}

#[derive(Clone)]
pub struct ActivityTracker {
    client: Client,
    namespace: Arc<str>,
    last_write: Arc<Mutex<HashMap<String, Instant>>>,
    admissions: Arc<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>>,
}

impl ActivityTracker {
    pub fn new(client: Client, namespace: String) -> Self {
        Self {
            client,
            namespace: namespace.into(),
            last_write: Arc::new(Mutex::new(HashMap::new())),
            admissions: Default::default(),
        }
    }

    // Control admission and idle sleep contend on the same resource version.
    // Record activity before issuing guest authority, including on cached clients.
    pub(crate) async fn admit_control(
        &self,
        claim: &crate::slot::Claim,
    ) -> Result<DateTime<Utc>, tonic::Status> {
        // Browser module loads and other parallel controls must not exhaust the
        // CAS retries by racing each other. Serialize only this workspace's
        // admission, retaining no idle lock entries or authority between calls.
        let admission = {
            let mut admissions = self.admissions.lock().map_err(|_| {
                tonic::Status::unavailable("workspace control admission unavailable")
            })?;
            admissions.retain(|_, lock| lock.strong_count() > 0);
            let lock = admissions
                .get(&claim.microvm_uid)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| Arc::new(tokio::sync::Mutex::new(())));
            admissions.insert(claim.microvm_uid.clone(), Arc::downgrade(&lock));
            lock
        };
        let _admission = admission.lock().await;
        let agents: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        for _ in 0..3 {
            let agent = agents.get(&claim.microvm_id).await.map_err(|_| {
                tonic::Status::unavailable("workspace control admission unavailable")
            })?;
            if agent.uid().as_deref() != Some(&claim.microvm_uid)
                || agent.spec.runtime_epoch != claim.runtime_epoch
                || agent.metadata.deletion_timestamp.is_some()
                || agent.spec.desired_state != crate::crd::MicroVMDesiredState::Running
                || agent
                    .metadata
                    .annotations
                    .as_ref()
                    .and_then(|a| a.get(ACTIVE_RUN_ANNOTATION))
                    .is_some_and(|value| is_idle_sleep_claim(value))
            {
                return Err(tonic::Status::failed_precondition(
                    "workspace is sleeping or unavailable; resume it explicitly",
                ));
            }
            let version = agent.resource_version().ok_or_else(|| {
                tonic::Status::unavailable("workspace control admission has no resource version")
            })?;
            let now = Utc::now();
            let mut patch = activity_metadata_patch(now);
            patch["metadata"]["uid"] = json!(claim.microvm_uid);
            patch["metadata"]["resourceVersion"] = json!(version);
            match agents
                .patch(
                    &claim.microvm_id,
                    &PatchParams::default(),
                    &Patch::Merge(patch),
                )
                .await
            {
                Ok(_) => return Ok(now),
                Err(kube::Error::Api(error)) if error.code == 409 => continue,
                Err(_) => {
                    return Err(tonic::Status::unavailable(
                        "workspace control activity could not be recorded",
                    ));
                }
            }
        }
        Err(tonic::Status::unavailable(
            "workspace control admission changed concurrently; retry",
        ))
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
        Ok(())
    }

    async fn touch_agent_work(
        &self,
        microvm: &MicroVM,
        at: DateTime<Utc>,
    ) -> Result<(), kube::Error> {
        let agents: Api<MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        agents
            .patch(
                &microvm.name_any(),
                &PatchParams::default(),
                &Patch::Merge(json!({
                    "metadata": { "uid": microvm.uid(), "resourceVersion": microvm.resource_version(),
                        "annotations": { LAST_AGENT_WORK_ANNOTATION: at.to_rfc3339() } }
                })),
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
    let agent_work = microvm
        .metadata
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get(LAST_AGENT_WORK_ANNOTATION));
    let status = microvm
        .status
        .as_ref()
        .and_then(|status| status.last_activity_at.as_ref());

    [
        annotation,
        agent_work,
        status,
        Some(&microvm.spec.created_at),
    ]
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
    if microvm
        .metadata
        .annotations
        .as_ref()
        .is_some_and(|values| values.contains_key(ACTIVE_RUN_ANNOTATION))
    {
        return false;
    }
    effective_idle_deadline_at(microvm).is_some_and(|deadline| deadline <= now)
}

pub fn effective_idle_deadline(microvm: &MicroVM) -> Option<String> {
    effective_idle_deadline_at(microvm).map(|deadline| deadline.to_rfc3339())
}

fn effective_idle_deadline_at(microvm: &MicroVM) -> Option<DateTime<Utc>> {
    let minutes = microvm.spec.power.idle_timeout_minutes;
    if minutes == 0 {
        return None;
    }
    let configured_deadline = DateTime::parse_from_rfc3339(&microvm.spec.idle_deadline)
        .ok()
        .map(|value| value.with_timezone(&Utc));
    let activity_deadline = last_activity_at(microvm)
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .map(|value| value.with_timezone(&Utc) + chrono::Duration::minutes(i64::from(minutes)));

    configured_deadline
        .into_iter()
        .chain(activity_deadline)
        .max()
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
        IDLE_MINUTES, MicroVMArchitecture, MicroVMDesiredState, MicroVMResources, MicroVMSpec,
        MicroVMStatus,
    };
    use http::{Request, Response, StatusCode};
    use kube::client::Body as KubeBody;

    fn test_microvm(now: DateTime<Utc>) -> MicroVM {
        MicroVM::new(
            "agent",
            MicroVMSpec {
                policy_version: 0,
                reservation_id: "33333333-3333-4333-8333-333333333333".into(),
                runtime_epoch: "44444444-4444-4444-8444-444444444444".into(),
                display_name: "Agent".to_owned(),
                owner_hash: "owner".to_owned(),
                desired_state: MicroVMDesiredState::Running,
                image: format!("registry.example/nanoagent@sha256:{}", "a".repeat(64)),
                architecture: MicroVMArchitecture::Amd64,
                resources: MicroVMResources::default(),
                power: Default::default(),
                created_at: (now - chrono::Duration::hours(2)).to_rfc3339(),
                idle_deadline: (now - chrono::Duration::hours(1)).to_rfc3339(),
                slot: None,
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

    #[tokio::test]
    async fn activity_heartbeat_has_one_metadata_writer() {
        let now = Utc::now();
        let response_microvm = test_microvm(now);
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let tracker = ActivityTracker::new(client, "tengri".to_owned());

        let heartbeat = tokio::spawn(async move { tracker.touch_now("agent", now).await });
        let (request, response) = handle
            .next_request()
            .await
            .expect("activity metadata patch");
        assert_eq!(request.method(), http::Method::PATCH);
        assert_eq!(
            request.uri().path(),
            "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent"
        );
        let body: serde_json::Value = serde_json::from_slice(
            &request
                .into_body()
                .collect_bytes()
                .await
                .expect("activity patch body"),
        )
        .expect("activity patch JSON");
        assert_eq!(
            body.pointer(&format!(
                "/metadata/annotations/{}",
                LAST_ACTIVITY_ANNOTATION.replace('/', "~1")
            )),
            Some(&json!(now.to_rfc3339())),
        );
        assert!(body.get("status").is_none());
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&response_microvm).expect("MicroVM response JSON"),
                ))
                .expect("activity patch response"),
        );

        heartbeat
            .await
            .expect("activity heartbeat task")
            .expect("activity heartbeat result");
        match tokio::time::timeout(Duration::from_millis(50), handle.next_request()).await {
            Err(_) | Ok(None) => {}
            Ok(Some(_)) => {
                panic!("activity heartbeat must not race the controller on the status subresource")
            }
        }
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
        assert_eq!(
            effective_idle_deadline(&microvm).as_deref(),
            Some(
                (now + chrono::Duration::minutes(IDLE_MINUTES))
                    .to_rfc3339()
                    .as_str()
            ),
        );
        assert!(!idle_deadline_passed(&microvm, now));
        assert!(idle_deadline_passed(
            &microvm,
            now + chrono::Duration::minutes(IDLE_MINUTES + 1),
        ));
    }

    #[test]
    fn guest_work_and_user_activity_extend_idle_independently() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.metadata.annotations = Some(std::collections::BTreeMap::from([
            (LAST_ACTIVITY_ANNOTATION.to_owned(), now.to_rfc3339()),
            (
                LAST_AGENT_WORK_ANNOTATION.to_owned(),
                (now - chrono::Duration::minutes(10)).to_rfc3339(),
            ),
        ]));
        assert_eq!(last_activity_at(&microvm), Some(now.to_rfc3339()));
        microvm.metadata.annotations.as_mut().unwrap().insert(
            LAST_AGENT_WORK_ANNOTATION.to_owned(),
            (now + chrono::Duration::minutes(10)).to_rfc3339(),
        );
        assert_eq!(
            last_activity_at(&microvm),
            Some((now + chrono::Duration::minutes(10)).to_rfc3339())
        );
        assert!(!idle_deadline_passed(
            &microvm,
            now + chrono::Duration::minutes(IDLE_MINUTES)
        ));
    }

    #[test]
    fn disabled_idle_sleep_ignores_even_expired_deadlines() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.spec.power.idle_timeout_minutes = 0;
        assert_eq!(effective_idle_deadline(&microvm), None);
        assert!(!idle_deadline_passed(
            &microvm,
            now + chrono::Duration::days(10)
        ));
    }

    #[test]
    fn an_active_run_survives_idle_expiry_and_worker_outage() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.metadata.annotations.get_or_insert_default().insert(
            ACTIVE_RUN_ANNOTATION.into(),
            "11111111-1111-4111-8111-111111111111".into(),
        );
        assert!(!idle_deadline_passed(
            &microvm,
            now + chrono::Duration::days(2)
        ));
        microvm
            .metadata
            .annotations
            .as_mut()
            .unwrap()
            .remove(ACTIVE_RUN_ANNOTATION);
        assert!(idle_deadline_passed(
            &microvm,
            now + chrono::Duration::days(2)
        ));
    }

    #[tokio::test]
    async fn a_stale_idle_decision_cannot_overwrite_a_concurrent_run_pin() {
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let mut agent = test_microvm(Utc::now());
        agent.metadata.uid = Some("11111111-1111-4111-8111-111111111111".into());
        agent.metadata.resource_version = Some("11".into());
        let claim = tokio::spawn(async move {
            claim_idle_sleep(Client::new(service, "tengri"), "tengri", &agent).await
        });
        let (request, response) = handle.next_request().await.unwrap();
        let patch: serde_json::Value =
            serde_json::from_slice(&request.into_body().collect_bytes().await.unwrap()).unwrap();
        assert_eq!(
            patch["metadata"]["uid"],
            "11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(patch["metadata"]["resourceVersion"], "11");
        assert!(
            patch["metadata"]["annotations"][ACTIVE_RUN_ANNOTATION]
                .as_str()
                .unwrap()
                .starts_with(IDLE_SLEEP_PREFIX)
        );
        response.send_response(Response::builder().status(StatusCode::CONFLICT).header("content-type","application/json").body(KubeBody::from(br#"{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Conflict","message":"resource version changed","code":409}"#.to_vec())).unwrap());
        let error = claim.await.unwrap().unwrap_err();
        assert!(
            matches!(error.downcast_ref::<kube::Error>(),Some(kube::Error::Api(error)) if error.code==409)
        );
    }

    #[test]
    fn idle_sleep_claims_survive_controller_replacement_and_bind_the_runtime_epoch() {
        let mut agent = test_microvm(Utc::now());
        agent.metadata.annotations.get_or_insert_default().insert(
            ACTIVE_RUN_ANNOTATION.into(),
            format!("{IDLE_SLEEP_PREFIX}{}", agent.spec.runtime_epoch),
        );
        assert!(has_idle_sleep_claim(&agent));
        agent.spec.runtime_epoch = "another-runtime".into();
        assert!(!has_idle_sleep_claim(&agent));
    }

    #[test]
    fn activity_uses_the_selected_idle_timeout() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.spec.power.idle_timeout_minutes = 5;
        microvm.metadata.annotations = Some(std::collections::BTreeMap::from([(
            LAST_ACTIVITY_ANNOTATION.to_owned(),
            now.to_rfc3339(),
        )]));
        assert!(!idle_deadline_passed(
            &microvm,
            now + chrono::Duration::minutes(4)
        ));
        assert!(idle_deadline_passed(
            &microvm,
            now + chrono::Duration::minutes(5)
        ));
    }
}
