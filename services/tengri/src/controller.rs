use std::{sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use futures::StreamExt;
use k8s_openapi::api::core::v1::{ContainerStatus, PersistentVolumeClaim, Pod, Secret};
use kube::{
    Api, Client, Resource, ResourceExt,
    api::{DeleteParams, Patch, PatchParams},
    runtime::{
        Controller,
        controller::Action,
        wait::{await_condition, conditions},
        watcher,
    },
};
use serde_json::json;
use thiserror::Error;
use tracing::{error, info};

use crate::{
    crd::{
        IDLE_MINUTES, MicroVM, MicroVMCondition, MicroVMDesiredState, MicroVMPhase, MicroVMStatus,
    },
    metrics,
    pod::{
        FINALIZER_NAME, MANAGER_NAME, bootstrap_secret_name, build_pod, ensure_bootstrap_secret,
        ensure_pvc, pvc_name,
    },
    tickets::TicketStore,
};

#[derive(Clone)]
pub struct ControllerContext {
    pub client: Client,
    pub namespace: String,
    pub tickets: TicketStore,
}

#[derive(Debug, Error)]
pub enum ReconcileError {
    #[error("Kubernetes API request failed: {0}")]
    Kubernetes(#[from] kube::Error),
    #[error("MicroVM {0} is missing a namespace")]
    MissingNamespace(String),
    #[error("Tengri capability cleanup failed: {0}")]
    TicketStore(String),
    #[error("timed out deleting owned resource {0}")]
    CleanupTimeout(String),
    #[error("failed waiting for owned resource deletion: {0}")]
    CleanupWait(#[from] kube::runtime::wait::Error),
}

pub async fn run(context: ControllerContext) {
    let client = context.client.clone();
    let namespace = context.namespace.clone();
    let microvms: Api<MicroVM> = Api::namespaced(client.clone(), &namespace);
    let pods: Api<Pod> = Api::namespaced(client, &namespace);

    Controller::new(microvms, watcher::Config::default())
        .owns(pods, watcher::Config::default())
        .run(reconcile, error_policy, Arc::new(context))
        .for_each(|result| async move {
            match result {
                Ok(reference) => info!(?reference, "reconciled MicroVM"),
                Err(reconcile_error) => {
                    error!(error = %reconcile_error, "MicroVM reconciliation failed")
                }
            }
        })
        .await;
}

async fn reconcile(
    microvm: Arc<MicroVM>,
    context: Arc<ControllerContext>,
) -> Result<Action, ReconcileError> {
    let name = microvm.name_any();
    let namespace = microvm
        .namespace()
        .ok_or_else(|| ReconcileError::MissingNamespace(name.clone()))?;
    let microvms: Api<MicroVM> = Api::namespaced(context.client.clone(), &namespace);
    let pods: Api<Pod> = Api::namespaced(context.client.clone(), &namespace);

    if microvm.meta().deletion_timestamp.is_some() {
        cleanup(&context.client, &namespace, &microvm, &context.tickets).await?;
        remove_finalizer(&microvms, &microvm).await?;
        return Ok(Action::await_change());
    }

    if !microvm
        .finalizers()
        .iter()
        .any(|value| value == FINALIZER_NAME)
    {
        add_finalizer(&microvms, &microvm).await?;
        return Ok(Action::requeue(Duration::from_secs(1)));
    }

    let now = Utc::now();
    if deadline_passed(&microvm.spec.expires_at, now) {
        info!(microvm = %name, "hard expiry reached; deleting MicroVM and persistent state");
        metrics::global().record_expiry_deletion();
        microvms.delete(&name, &DeleteParams::default()).await?;
        return Ok(Action::await_change());
    }

    let idle = is_idle(&microvm, now);
    if idle && microvm.spec.desired_state != MicroVMDesiredState::Sleeping {
        patch_desired_state(&microvms, &microvm, MicroVMDesiredState::Sleeping).await?;
        return Ok(Action::requeue(Duration::from_secs(1)));
    }

    if microvm.spec.desired_state == MicroVMDesiredState::Sleeping {
        context
            .tickets
            .remove_agent(&name)
            .map_err(|error| ReconcileError::TicketStore(error.to_string()))?;
        metrics::global().clear_pty_sessions(&name);
        // Sleeping is observable only after the Firecracker guest is gone. Waiting for
        // foreground deletion also prevents a resume from racing a terminating Pod.
        delete_and_wait(&pods, &name).await?;
        let status = sleeping_status(&microvm, idle, now);
        if microvm.status.as_ref() != Some(&status) {
            patch_status(&microvms, &microvm, status).await?;
        }
        return Ok(Action::requeue(next_requeue(&microvm, now)));
    }

    let bootstrap_secret =
        ensure_bootstrap_secret(context.client.clone(), &namespace, &microvm).await?;
    let home_claim = ensure_pvc(context.client.clone(), &namespace, &microvm).await?;
    let desired_pod = build_pod(&microvm, &namespace, &bootstrap_secret, &home_claim);
    let pod = pods
        .patch(
            &name,
            &PatchParams::apply(MANAGER_NAME).force(),
            &Patch::Apply(&desired_pod),
        )
        .await?;
    let status = derive_status(&microvm, &pod, &home_claim, now);

    if status.phase == MicroVMPhase::Ready
        && microvm.status.as_ref().map(|value| value.phase) != Some(MicroVMPhase::Ready)
    {
        let previous = microvm.status.as_ref().map(|value| value.phase);
        let since = if previous == Some(MicroVMPhase::Sleeping) {
            microvm
                .status
                .as_ref()
                .and_then(|value| value.last_activity_at.as_deref())
        } else {
            Some(microvm.spec.created_at.as_str())
        };
        if let Some(millis) = since.and_then(|value| elapsed_millis(value, now)) {
            if previous == Some(MicroVMPhase::Sleeping) {
                metrics::global().observe_resume(millis);
            } else {
                metrics::global().observe_boot(millis);
            }
        }
    }
    if status.phase == MicroVMPhase::Failed
        && microvm.status.as_ref().map(|value| value.phase) != Some(MicroVMPhase::Failed)
    {
        metrics::global().record_guest_failure();
    }

    if microvm.status.as_ref() != Some(&status) {
        patch_status(&microvms, &microvm, status).await?;
    }

    Ok(Action::requeue(next_requeue(&microvm, now)))
}

fn elapsed_millis(value: &str, now: DateTime<Utc>) -> Option<u64> {
    let started = DateTime::parse_from_rfc3339(value)
        .ok()?
        .with_timezone(&Utc);
    u64::try_from((now - started).num_milliseconds().max(0)).ok()
}

fn error_policy(
    _microvm: Arc<MicroVM>,
    error: &ReconcileError,
    _context: Arc<ControllerContext>,
) -> Action {
    error!(error = %error, "requeueing failed MicroVM reconciliation");
    Action::requeue(Duration::from_secs(10))
}

async fn cleanup(
    client: &Client,
    namespace: &str,
    microvm: &MicroVM,
    tickets: &TicketStore,
) -> Result<(), ReconcileError> {
    tickets
        .remove_agent(&microvm.name_any())
        .map_err(|error| ReconcileError::TicketStore(error.to_string()))?;
    metrics::global().clear_pty_sessions(&microvm.name_any());
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let secrets: Api<Secret> = Api::namespaced(client.clone(), namespace);
    let claims: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), namespace);
    delete_and_wait(&pods, &microvm.name_any()).await?;
    delete_and_wait(&secrets, &bootstrap_secret_name(microvm)).await?;
    delete_and_wait(&claims, &pvc_name(microvm)).await?;
    Ok(())
}

async fn delete_and_wait<K>(api: &Api<K>, name: &str) -> Result<(), ReconcileError>
where
    K: Clone + serde::de::DeserializeOwned + std::fmt::Debug + Resource + Send + 'static,
    <K as Resource>::DynamicType: Default,
{
    let Some(resource) = api.get_opt(name).await? else {
        return Ok(());
    };
    let uid = resource.uid().unwrap_or_default();
    match api.delete(name, &DeleteParams::foreground()).await {
        Ok(_) => {}
        Err(kube::Error::Api(response)) if response.code == 404 => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    tokio::time::timeout(
        Duration::from_secs(45),
        await_condition(api.clone(), name, conditions::is_deleted(&uid)),
    )
    .await
    .map_err(|_| ReconcileError::CleanupTimeout(name.to_owned()))??;
    Ok(())
}

async fn add_finalizer(api: &Api<MicroVM>, microvm: &MicroVM) -> Result<(), kube::Error> {
    let name = microvm.name_any();
    api.patch(
        &name,
        &PatchParams::default(),
        &Patch::Merge(json!({
            "metadata": {
                "finalizers": finalizers_with_tengri(microvm),
                "resourceVersion": microvm.resource_version(),
            }
        })),
    )
    .await?;
    Ok(())
}

async fn remove_finalizer(api: &Api<MicroVM>, microvm: &MicroVM) -> Result<(), kube::Error> {
    let name = microvm.name_any();
    api.patch(
        &name,
        &PatchParams::default(),
        &Patch::Merge(json!({
            "metadata": {
                "finalizers": finalizers_without_tengri(microvm),
                "resourceVersion": microvm.resource_version(),
            }
        })),
    )
    .await?;
    Ok(())
}

async fn patch_desired_state(
    api: &Api<MicroVM>,
    microvm: &MicroVM,
    state: MicroVMDesiredState,
) -> Result<(), kube::Error> {
    let name = microvm.name_any();
    api.patch(
        &name,
        &PatchParams::default(),
        &Patch::Merge(json!({
            "metadata": {"resourceVersion": microvm.resource_version()},
            "spec": {"desiredState": state},
        })),
    )
    .await?;
    Ok(())
}

pub async fn patch_status(
    api: &Api<MicroVM>,
    microvm: &MicroVM,
    status: MicroVMStatus,
) -> Result<(), kube::Error> {
    let name = microvm.name_any();
    api.patch_status(
        &name,
        &PatchParams::default(),
        &Patch::Merge(json!({
            "apiVersion": "runtime.proompteng.ai/v1alpha1",
            "kind": "MicroVM",
            "metadata": {
                "resourceVersion": microvm.resource_version(),
            },
            "status": status,
        })),
    )
    .await?;
    Ok(())
}

fn finalizers_with_tengri(microvm: &MicroVM) -> Vec<String> {
    let mut finalizers = microvm.finalizers().to_vec();
    if !finalizers.iter().any(|value| value == FINALIZER_NAME) {
        finalizers.push(FINALIZER_NAME.to_owned());
    }
    finalizers
}

fn finalizers_without_tengri(microvm: &MicroVM) -> Vec<String> {
    microvm
        .finalizers()
        .iter()
        .filter(|value| value.as_str() != FINALIZER_NAME)
        .cloned()
        .collect()
}

fn sleeping_status(microvm: &MicroVM, idle: bool, now: DateTime<Utc>) -> MicroVMStatus {
    let reason = if idle { "IdleTimeout" } else { "Requested" };
    let message = if idle {
        "Agent slept after 60 minutes without authenticated activity"
    } else {
        "Agent is sleeping; persistent home and workspace are retained"
    };
    MicroVMStatus {
        phase: MicroVMPhase::Sleeping,
        pvc_name: Some(pvc_name(microvm)),
        message: Some(message.to_owned()),
        last_activity_at: activity_at(microvm),
        conditions: vec![condition(microvm, "Ready", "False", reason, message, now)],
        observed_generation: microvm.meta().generation.unwrap_or_default(),
        ..MicroVMStatus::default()
    }
}

fn derive_status(
    microvm: &MicroVM,
    pod: &Pod,
    home_claim: &str,
    now: DateTime<Utc>,
) -> MicroVMStatus {
    let pod_status = pod.status.as_ref();
    let ready = pod_status
        .and_then(|status| status.conditions.as_ref())
        .and_then(|conditions| {
            conditions
                .iter()
                .find(|condition| condition.type_ == "Ready")
        })
        .is_some_and(|condition| condition.status == "True");
    let failed = pod_status
        .and_then(|status| status.container_statuses.as_ref())
        .and_then(|statuses| statuses.iter().find_map(container_failure));
    let scheduling_failure = pod_status
        .and_then(|status| status.conditions.as_ref())
        .and_then(|conditions| {
            conditions
                .iter()
                .find(|condition| condition.type_ == "PodScheduled" && condition.status == "False")
        })
        .and_then(|condition| {
            let reason = condition.reason.as_deref().unwrap_or_default();
            (reason == "Unschedulable").then(|| {
                (
                    reason.to_owned(),
                    condition.message.clone().unwrap_or_else(|| {
                        "No proven Firecracker node can schedule this agent".to_owned()
                    }),
                )
            })
        });
    let pod_phase = pod_status.and_then(|status| status.phase.as_deref());

    let (phase, reason, message, ready_at) = if let Some((reason, message)) = failed {
        (MicroVMPhase::Failed, reason, message, None)
    } else if let Some((reason, message)) = scheduling_failure {
        (MicroVMPhase::Failed, reason, message, None)
    } else if ready {
        (
            MicroVMPhase::Ready,
            "GuestReady".to_owned(),
            "Firecracker guest and Nanoagent are ready".to_owned(),
            microvm
                .status
                .as_ref()
                .and_then(|status| status.ready_at.clone())
                .or_else(|| Some(now.to_rfc3339())),
        )
    } else if pod_phase == Some("Failed") {
        (
            MicroVMPhase::Failed,
            pod_status
                .and_then(|status| status.reason.clone())
                .unwrap_or_else(|| "PodFailed".to_owned()),
            pod_status
                .and_then(|status| status.message.clone())
                .unwrap_or_else(|| "MicroVM Pod failed".to_owned()),
            None,
        )
    } else {
        (
            MicroVMPhase::Booting,
            "GuestBooting".to_owned(),
            "Starting the Firecracker guest".to_owned(),
            None,
        )
    };
    let condition_status = if ready { "True" } else { "False" };

    MicroVMStatus {
        phase,
        pod_name: pod.metadata.name.clone(),
        pvc_name: Some(home_claim.to_owned()),
        pod_ip: pod_status.and_then(|status| status.pod_ip.clone()),
        node_name: pod.spec.as_ref().and_then(|spec| spec.node_name.clone()),
        guest_ready: ready,
        failure_reason: (phase == MicroVMPhase::Failed).then_some(reason.clone()),
        message: Some(message.clone()),
        ready_at,
        last_activity_at: activity_at(microvm),
        conditions: vec![condition(
            microvm,
            "Ready",
            condition_status,
            &reason,
            &message,
            now,
        )],
        observed_generation: microvm.meta().generation.unwrap_or_default(),
    }
}

fn condition(
    microvm: &MicroVM,
    type_: &str,
    status: &str,
    reason: &str,
    message: &str,
    now: DateTime<Utc>,
) -> MicroVMCondition {
    let previous = microvm
        .status
        .as_ref()
        .and_then(|value| value.conditions.iter().find(|value| value.type_ == type_));
    let last_transition_at = previous
        .filter(|value| value.status == status && value.reason == reason)
        .map(|value| value.last_transition_at.clone())
        .unwrap_or_else(|| now.to_rfc3339());
    MicroVMCondition {
        type_: type_.to_owned(),
        status: status.to_owned(),
        reason: reason.to_owned(),
        message: message.to_owned(),
        last_transition_at,
    }
}

fn activity_at(microvm: &MicroVM) -> Option<String> {
    microvm
        .status
        .as_ref()
        .and_then(|status| status.last_activity_at.clone())
        .or_else(|| Some(microvm.spec.created_at.clone()))
}

fn is_idle(microvm: &MicroVM, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(&microvm.spec.idle_deadline)
        .map(|deadline| deadline.with_timezone(&Utc) <= now)
        .unwrap_or_else(|_| {
            activity_at(microvm)
                .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
                .map(|value| value.with_timezone(&Utc))
                .is_some_and(|value| now.signed_duration_since(value).num_minutes() >= IDLE_MINUTES)
        })
}

fn deadline_passed(value: &str, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc) <= now)
        .unwrap_or(false)
}

fn next_requeue(microvm: &MicroVM, now: DateTime<Utc>) -> Duration {
    let until_expiry = DateTime::parse_from_rfc3339(&microvm.spec.expires_at)
        .ok()
        .map(|value| {
            value
                .with_timezone(&Utc)
                .signed_duration_since(now)
                .num_seconds()
        })
        .unwrap_or(30)
        .clamp(1, 30);
    Duration::from_secs(until_expiry as u64)
}

fn container_failure(status: &ContainerStatus) -> Option<(String, String)> {
    let state = status.state.as_ref()?;
    if let Some(waiting) = &state.waiting {
        let reason = waiting.reason.as_deref().unwrap_or_default();
        if matches!(
            reason,
            "CrashLoopBackOff"
                | "CreateContainerConfigError"
                | "CreateContainerError"
                | "ErrImageNeverPull"
                | "ErrImagePull"
                | "ImagePullBackOff"
                | "InvalidImageName"
                | "RunContainerError"
        ) {
            return Some((
                reason.to_owned(),
                waiting.message.clone().unwrap_or_else(|| reason.to_owned()),
            ));
        }
    }
    if let Some(terminated) = &state.terminated
        && terminated.exit_code != 0
    {
        let reason = terminated
            .reason
            .clone()
            .unwrap_or_else(|| "GuestExited".to_owned());
        let message = terminated
            .message
            .clone()
            .unwrap_or_else(|| format!("Nanoagent exited with code {}", terminated.exit_code));
        return Some((reason, message));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{MicroVMArchitecture, MicroVMResources, MicroVMSpec};
    use k8s_openapi::api::core::v1::{
        ContainerState, ContainerStateWaiting, PodCondition, PodStatus,
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
                created_at: now.to_rfc3339(),
                idle_deadline: (now + chrono::Duration::minutes(IDLE_MINUTES)).to_rfc3339(),
                expires_at: (now + chrono::Duration::hours(4)).to_rfc3339(),
            },
        )
    }

    #[test]
    fn reports_image_pull_failure_precisely() {
        let now = Utc::now();
        let pod = Pod {
            status: Some(PodStatus {
                phase: Some("Pending".to_owned()),
                container_statuses: Some(vec![ContainerStatus {
                    name: "nanoagent".to_owned(),
                    image: "registry.example/nanoagent".to_owned(),
                    image_id: "".to_owned(),
                    ready: false,
                    restart_count: 0,
                    state: Some(ContainerState {
                        waiting: Some(ContainerStateWaiting {
                            reason: Some("ImagePullBackOff".to_owned()),
                            message: Some("unable to pull image".to_owned()),
                        }),
                        ..ContainerState::default()
                    }),
                    ..ContainerStatus::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };
        let status = derive_status(&test_microvm(now), &pod, "agent-home", now);
        assert_eq!(status.phase, MicroVMPhase::Failed);
        assert_eq!(status.failure_reason.as_deref(), Some("ImagePullBackOff"));
        assert_eq!(status.message.as_deref(), Some("unable to pull image"));
    }

    #[test]
    fn reports_unschedulable_firecracker_guest_precisely() {
        let now = Utc::now();
        let pod = Pod {
            status: Some(PodStatus {
                phase: Some("Pending".to_owned()),
                conditions: Some(vec![PodCondition {
                    type_: "PodScheduled".to_owned(),
                    status: "False".to_owned(),
                    reason: Some("Unschedulable".to_owned()),
                    message: Some("0/3 nodes match the proven runtime selector".to_owned()),
                    ..PodCondition::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };

        let status = derive_status(&test_microvm(now), &pod, "agent-home", now);
        assert_eq!(status.phase, MicroVMPhase::Failed);
        assert_eq!(status.failure_reason.as_deref(), Some("Unschedulable"));
        assert_eq!(
            status.message.as_deref(),
            Some("0/3 nodes match the proven runtime selector")
        );
    }

    #[test]
    fn reports_container_configuration_failure_precisely() {
        let now = Utc::now();
        let pod = Pod {
            status: Some(PodStatus {
                phase: Some("Pending".to_owned()),
                container_statuses: Some(vec![ContainerStatus {
                    name: "nanoagent".to_owned(),
                    image: "registry.example/nanoagent".to_owned(),
                    image_id: "".to_owned(),
                    ready: false,
                    restart_count: 0,
                    state: Some(ContainerState {
                        waiting: Some(ContainerStateWaiting {
                            reason: Some("CreateContainerConfigError".to_owned()),
                            message: Some("bootstrap Secret is missing".to_owned()),
                        }),
                        ..ContainerState::default()
                    }),
                    ..ContainerStatus::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };

        let status = derive_status(&test_microvm(now), &pod, "agent-home", now);
        assert_eq!(status.phase, MicroVMPhase::Failed);
        assert_eq!(
            status.failure_reason.as_deref(),
            Some("CreateContainerConfigError")
        );
        assert_eq!(
            status.message.as_deref(),
            Some("bootstrap Secret is missing")
        );
    }

    #[test]
    fn idle_timeout_sleeps_after_sixty_minutes() {
        let now = Utc::now();
        let microvm = test_microvm(now - chrono::Duration::minutes(61));
        assert!(is_idle(&microvm, now));
    }

    #[test]
    fn refreshed_idle_deadline_prevents_sleep_even_when_status_is_stale() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.status = Some(MicroVMStatus {
            last_activity_at: Some((now - chrono::Duration::hours(2)).to_rfc3339()),
            ..MicroVMStatus::default()
        });
        assert!(!is_idle(&microvm, now));
    }

    #[test]
    fn hard_expiry_is_independent_of_activity() {
        let now = Utc::now();
        let mut microvm = test_microvm(now - chrono::Duration::hours(5));
        microvm.status = Some(MicroVMStatus {
            last_activity_at: Some(now.to_rfc3339()),
            ..MicroVMStatus::default()
        });
        assert!(deadline_passed(&microvm.spec.expires_at, now));
    }

    #[test]
    fn tengri_finalizer_updates_preserve_other_controllers() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.metadata.finalizers = Some(vec!["storage.example/finalizer".to_owned()]);

        assert_eq!(
            finalizers_with_tengri(&microvm),
            vec![
                "storage.example/finalizer".to_owned(),
                FINALIZER_NAME.to_owned(),
            ]
        );

        microvm.metadata.finalizers = Some(finalizers_with_tengri(&microvm));
        assert_eq!(
            finalizers_without_tengri(&microvm),
            vec!["storage.example/finalizer".to_owned()]
        );
    }
}
