use std::{sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use futures::StreamExt;
use k8s_openapi::api::core::v1::{ContainerStatus, Event, PersistentVolumeClaim, Pod, Secret};
use kube::{
    Api, Client, Resource, ResourceExt,
    api::{DeleteParams, ListParams, Patch, PatchParams, Preconditions},
    runtime::{
        Controller,
        controller::Action,
        wait::{await_condition, conditions},
        watcher,
    },
};
use serde_json::json;
use thiserror::Error;
use tracing::{error, info, warn};

use crate::{
    activity::{RESUME_STARTED_AT_ANNOTATION, idle_deadline_passed, last_activity_at},
    crd::{MicroVM, MicroVMCondition, MicroVMDesiredState, MicroVMPhase, MicroVMStatus},
    metrics,
    pod::{
        FINALIZER_NAME, KATA_HOME_BLOCK_INITIALIZATION_TOKEN_ANNOTATION, MANAGER_NAME,
        PersistentBlockInitialization, bootstrap_secret_name, build_pod, ensure_bootstrap_secret,
        ensure_pvc, has_current_storage_layout, is_controlled_by_microvm, mark_pvc_initialized,
        pvc_name,
    },
    tickets::TicketStore,
};

const BOOTSTRAP_SECRET_REJECTED: &str = "BootstrapSecretRejected";
const GUEST_IMAGE_UPDATE_REASON: &str = "GuestImageUpdate";
const GUEST_IMAGE_UPDATE_STARTED_AT_ANNOTATION: &str =
    "runtime.proompteng.ai/guest-image-update-started-at";
const UNSCHEDULABLE_FAILURE_GRACE_SECONDS: i64 = 30;
const POD_SANDBOX_FAILURE_GRACE_SECONDS: i64 = 30;
const MAX_FAILURE_MESSAGE_CHARS: usize = 2_048;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PodSandboxFailure {
    reason: String,
    message: String,
}

#[derive(Clone)]
pub struct ControllerContext {
    pub client: Client,
    pub namespace: String,
    pub tickets: TicketStore,
    pub guest_image: Arc<str>,
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
        let status = terminating_status(&microvm, Utc::now());
        if microvm.status.as_ref() != Some(&status) {
            patch_status(&microvms, &microvm, status).await?;
        }
        cleanup(&context.client, &namespace, &microvm, &context.tickets).await?;
        let current = microvms.get(&name).await?;
        remove_finalizer(&microvms, &current).await?;
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

    if microvm.spec.image != context.guest_image.as_ref() {
        patch_guest_image(&microvms, &microvm, &context.guest_image, &now.to_rfc3339()).await?;
        info!(
            microvm = %name,
            previous_image = %microvm.spec.image,
            desired_image = %context.guest_image,
            "updating MicroVM to the current Nanoagent release"
        );
        return Ok(Action::requeue(Duration::from_secs(1)));
    }

    let idle = idle_deadline_passed(&microvm, now);
    if idle && microvm.spec.desired_state != MicroVMDesiredState::Sleeping {
        patch_desired_state(&microvms, &microvm, MicroVMDesiredState::Sleeping).await?;
        return Ok(Action::requeue(Duration::from_secs(1)));
    }

    if microvm.spec.desired_state == MicroVMDesiredState::Sleeping {
        persist_storage_initialization_if_proven(&context.client, &pods, &namespace, &microvm)
            .await?;
        context
            .tickets
            .remove_agent(&name)
            .map_err(|error| ReconcileError::TicketStore(error.to_string()))?;
        metrics::global().clear_pty_sessions(&name);
        // Sleeping is observable only after the Firecracker guest is gone. Waiting for
        // foreground deletion also prevents a resume from racing a terminating Pod.
        delete_owned_and_wait(&pods, &name, &microvm).await?;
        if guest_image_update_started_at(&microvm).is_some() {
            clear_guest_image_update_started_at(&microvms, &microvm).await?;
        }
        let status = sleeping_status(&microvm, idle, now);
        if microvm.status.as_ref() != Some(&status) {
            patch_status(&microvms, &microvm, status).await?;
        }
        return Ok(Action::requeue(next_requeue(&microvm, now)));
    }

    if let Some(existing) = pods.get_opt(&name).await?
        && is_controlled_by_microvm(&existing, &microvm)
        && !runtime_pod_uses_image(&existing, &microvm.spec.image)
    {
        persist_storage_initialization_from_pod(
            &context.client,
            &pods,
            &namespace,
            &microvm,
            &existing,
        )
        .await?;
        context
            .tickets
            .remove_agent(&name)
            .map_err(|error| ReconcileError::TicketStore(error.to_string()))?;
        metrics::global().clear_pty_sessions(&name);

        let status = guest_image_update_status(&microvm, now);
        if microvm.status.as_ref() != Some(&status) {
            patch_status(&microvms, &microvm, status).await?;
        }
        info!(
            microvm = %name,
            desired_image = %microvm.spec.image,
            "replacing Firecracker guest Pod for the current Nanoagent release"
        );
        delete_owned_and_wait(&pods, &name, &microvm).await?;
        return Ok(Action::requeue(Duration::from_secs(1)));
    }

    let bootstrap_secret =
        match ensure_bootstrap_secret(context.client.clone(), &namespace, &microvm).await {
            Ok(secret) => secret,
            Err(error) => {
                report_provisioning_failure(
                    &microvms,
                    &pods,
                    &microvm,
                    BOOTSTRAP_SECRET_REJECTED,
                    "Bootstrap Secret",
                    &error,
                    now,
                )
                .await;
                return Err(error.into());
            }
        };
    let home_claim = match ensure_pvc(context.client.clone(), &namespace, &microvm).await {
        Ok(claim) => claim,
        Err(error) => {
            report_provisioning_failure(
                &microvms,
                &pods,
                &microvm,
                "PersistentVolumeClaimRejected",
                "persistent home claim",
                &error,
                now,
            )
            .await;
            return Err(error.into());
        }
    };
    let pod = match ensure_runtime_pod(
        &pods,
        &microvm,
        &namespace,
        &bootstrap_secret,
        &home_claim.name,
        home_claim.initialization,
    )
    .await
    {
        Ok(pod) => pod,
        Err(error) => {
            report_provisioning_failure(
                &microvms,
                &pods,
                &microvm,
                "MicroVMPodRejected",
                "Firecracker Pod",
                &error,
                now,
            )
            .await;
            return Err(error.into());
        }
    };
    if let Err(error) = persist_storage_initialization(
        &context.client,
        &pods,
        &namespace,
        &microvm,
        &pod,
        home_claim.initialization,
    )
    .await
    {
        report_provisioning_failure(
            &microvms,
            &pods,
            &microvm,
            "PersistentVolumeClaimInitializationStateRejected",
            "persistent home claim initialization state",
            &error,
            now,
        )
        .await;
        return Err(error.into());
    }
    let sandbox_failure = pod_sandbox_failure(&context.client, &namespace, &pod, now).await?;
    let status = derive_status(
        &microvm,
        &pod,
        &home_claim.name,
        sandbox_failure.as_ref(),
        now,
    );

    let ready_transition = status.phase == MicroVMPhase::Ready
        && microvm.status.as_ref().map(|value| value.phase) != Some(MicroVMPhase::Ready);
    let latency = ready_transition
        .then(|| readiness_latency(&microvm, now))
        .flatten();
    if status.phase == MicroVMPhase::Failed
        && microvm.status.as_ref().map(|value| value.phase) != Some(MicroVMPhase::Failed)
    {
        metrics::global().record_guest_failure();
    }

    if microvm.status.as_ref() != Some(&status) {
        patch_status(&microvms, &microvm, status.clone()).await?;
    }
    if let Some(latency) = latency {
        match latency {
            ReadinessLatency::Boot(millis) => metrics::global().observe_boot(millis),
            ReadinessLatency::Resume(millis) => metrics::global().observe_resume(millis),
        }
    }
    if status.phase == MicroVMPhase::Ready && resume_started_at(&microvm).is_some() {
        clear_resume_started_at(&microvms, &microvm).await?;
    }
    if status.phase == MicroVMPhase::Ready && guest_image_update_started_at(&microvm).is_some() {
        clear_guest_image_update_started_at(&microvms, &microvm).await?;
    }

    Ok(Action::requeue(next_requeue(&microvm, now)))
}

async fn ensure_runtime_pod(
    pods: &Api<Pod>,
    microvm: &MicroVM,
    namespace: &str,
    bootstrap_secret: &str,
    home_claim: &str,
    initialization: PersistentBlockInitialization,
) -> Result<Pod, kube::Error> {
    let name = microvm.name_any();
    if let Some(existing) = pods.get_opt(&name).await? {
        if is_controlled_by_microvm(&existing, microvm) {
            // Pod templates are immutable. Keep the current Firecracker guest through a
            // controller rollout; the next normal sleep/resume boundary creates the new
            // template without disrupting an active or still-booting agent.
            return Ok(existing);
        }
        return Err(kube::Error::Api(
            kube::core::Status {
                code: 422,
                reason: "Invalid".to_owned(),
                message: format!(
                    "Pod {name} already exists and is not controlled by MicroVM {}",
                    microvm.name_any()
                ),
                ..kube::core::Status::default()
            }
            .boxed(),
        ));
    }

    if !has_current_storage_layout(microvm) {
        return Err(kube::Error::Api(
            kube::core::Status {
                code: 422,
                reason: "Invalid".to_owned(),
                message: format!(
                    "MicroVM {name} uses an unsupported storage layout; delete and recreate the agent"
                ),
                ..kube::core::Status::default()
            }
            .boxed(),
        ));
    }

    let desired = build_pod(
        microvm,
        namespace,
        bootstrap_secret,
        home_claim,
        initialization,
    )?;
    pods.patch(
        &name,
        &PatchParams::apply(MANAGER_NAME).force(),
        &Patch::Apply(&desired),
    )
    .await
}

async fn persist_storage_initialization_if_proven(
    client: &Client,
    pods: &Api<Pod>,
    namespace: &str,
    microvm: &MicroVM,
) -> Result<(), kube::Error> {
    if !has_current_storage_layout(microvm) {
        return Ok(());
    }
    let Some(pod) = pods.get_opt(&microvm.name_any()).await? else {
        return Ok(());
    };
    persist_storage_initialization_from_pod(client, pods, namespace, microvm, &pod).await
}

async fn persist_storage_initialization_from_pod(
    client: &Client,
    pods: &Api<Pod>,
    namespace: &str,
    microvm: &MicroVM,
    pod: &Pod,
) -> Result<(), kube::Error> {
    if !is_controlled_by_microvm(pod, microvm) || !pod_proves_storage_initialized(pod) {
        return Ok(());
    }
    let home_claim = ensure_pvc(client.clone(), namespace, microvm).await?;
    persist_storage_initialization(
        client,
        pods,
        namespace,
        microvm,
        pod,
        home_claim.initialization,
    )
    .await
}

async fn persist_storage_initialization(
    client: &Client,
    pods: &Api<Pod>,
    namespace: &str,
    microvm: &MicroVM,
    pod: &Pod,
    initialization: PersistentBlockInitialization,
) -> Result<(), kube::Error> {
    if !pod_proves_storage_initialized(pod) {
        return Ok(());
    }

    if initialization == PersistentBlockInitialization::Pending {
        mark_pvc_initialized(client.clone(), namespace, microvm).await?;
    }
    clear_pod_initialization_token(pods, pod).await?;
    Ok(())
}

async fn clear_pod_initialization_token(pods: &Api<Pod>, pod: &Pod) -> Result<(), kube::Error> {
    let has_token = pod
        .metadata
        .annotations
        .as_ref()
        .is_some_and(|annotations| {
            annotations.contains_key(KATA_HOME_BLOCK_INITIALIZATION_TOKEN_ANNOTATION)
        });
    if !has_token {
        return Ok(());
    }

    let name = pod.name_any();
    let mut patch = json!({
        "metadata": {
            "resourceVersion": pod.resource_version(),
            "annotations": {},
        }
    });
    patch["metadata"]["annotations"][KATA_HOME_BLOCK_INITIALIZATION_TOKEN_ANNOTATION] =
        serde_json::Value::Null;
    pods.patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum ReadinessLatency {
    Boot(u64),
    Resume(u64),
}

fn readiness_latency(microvm: &MicroVM, now: DateTime<Utc>) -> Option<ReadinessLatency> {
    if guest_image_update_started_at(microvm).is_some() {
        return None;
    }
    if let Some(started_at) = resume_started_at(microvm) {
        return Some(ReadinessLatency::Resume(
            elapsed_millis(started_at, now).unwrap_or_default(),
        ));
    }
    Some(ReadinessLatency::Boot(
        elapsed_millis(&microvm.spec.created_at, now).unwrap_or_default(),
    ))
}

fn resume_started_at(microvm: &MicroVM) -> Option<&str> {
    microvm
        .metadata
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get(RESUME_STARTED_AT_ANNOTATION))
        .map(String::as_str)
}

fn guest_image_update_started_at(microvm: &MicroVM) -> Option<&str> {
    microvm
        .metadata
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get(GUEST_IMAGE_UPDATE_STARTED_AT_ANNOTATION))
        .map(String::as_str)
}

async fn clear_resume_started_at(api: &Api<MicroVM>, microvm: &MicroVM) -> Result<(), kube::Error> {
    let mut patch = json!({"metadata": {"annotations": {}}});
    patch["metadata"]["annotations"][RESUME_STARTED_AT_ANNOTATION] = serde_json::Value::Null;
    api.patch(
        &microvm.name_any(),
        &PatchParams::default(),
        &Patch::Merge(&patch),
    )
    .await?;
    Ok(())
}

async fn clear_guest_image_update_started_at(
    api: &Api<MicroVM>,
    microvm: &MicroVM,
) -> Result<(), kube::Error> {
    let mut patch = json!({"metadata": {"annotations": {}}});
    patch["metadata"]["annotations"][GUEST_IMAGE_UPDATE_STARTED_AT_ANNOTATION] =
        serde_json::Value::Null;
    api.patch(
        &microvm.name_any(),
        &PatchParams::default(),
        &Patch::Merge(&patch),
    )
    .await?;
    Ok(())
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
    delete_owned_and_wait(&pods, &microvm.name_any(), microvm).await?;
    delete_owned_and_wait(&secrets, &bootstrap_secret_name(microvm), microvm).await?;
    delete_owned_and_wait(&claims, &pvc_name(microvm), microvm).await?;
    Ok(())
}

async fn delete_owned_and_wait<K>(
    api: &Api<K>,
    name: &str,
    microvm: &MicroVM,
) -> Result<(), ReconcileError>
where
    K: Clone + serde::de::DeserializeOwned + std::fmt::Debug + Resource + Send + 'static,
    <K as Resource>::DynamicType: Default,
{
    let Some(resource) = api.get_opt(name).await? else {
        return Ok(());
    };
    if !is_controlled_by_microvm(&resource, microvm) {
        warn!(
            resource = name,
            microvm = %microvm.name_any(),
            "skipping cleanup of resource not controlled by MicroVM"
        );
        return Ok(());
    }
    let Some(uid) = resource.uid() else {
        warn!(
            resource = name,
            microvm = %microvm.name_any(),
            "skipping cleanup of owned resource without a Kubernetes UID"
        );
        return Ok(());
    };
    let params = DeleteParams::foreground().preconditions(Preconditions {
        uid: Some(uid.clone()),
        resource_version: resource.resource_version(),
    });
    match api.delete(name, &params).await {
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

async fn patch_guest_image(
    api: &Api<MicroVM>,
    microvm: &MicroVM,
    image: &str,
    started_at: &str,
) -> Result<(), kube::Error> {
    let mut patch = json!({
        "metadata": {
            "resourceVersion": microvm.resource_version(),
            "annotations": {},
        },
        "spec": {"image": image},
    });
    patch["metadata"]["annotations"][GUEST_IMAGE_UPDATE_STARTED_AT_ANNOTATION] = json!(started_at);
    api.patch(
        &microvm.name_any(),
        &PatchParams::default(),
        &Patch::Merge(&patch),
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
    // The controller is the sole status writer. Do not precondition status patches on the
    // resource version because authenticated activity updates metadata independently and can
    // otherwise make every reconcile fail with a harmless but noisy 409 conflict.
    api.patch_status(
        &name,
        &PatchParams::default(),
        &Patch::Merge(json!({
            "apiVersion": "runtime.proompteng.ai/v1alpha1",
            "kind": "MicroVM",
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
        last_activity_at: last_activity_at(microvm),
        conditions: vec![condition(microvm, "Ready", "False", reason, message, now)],
        observed_generation: microvm.meta().generation.unwrap_or_default(),
        ..MicroVMStatus::default()
    }
}

fn guest_image_update_status(microvm: &MicroVM, now: DateTime<Utc>) -> MicroVMStatus {
    let message = "Restarting the Firecracker guest on the current Nanoagent release; persistent home and workspace are retained";
    MicroVMStatus {
        phase: MicroVMPhase::Booting,
        pvc_name: Some(pvc_name(microvm)),
        message: Some(message.to_owned()),
        last_activity_at: last_activity_at(microvm),
        conditions: vec![condition(
            microvm,
            "Ready",
            "False",
            GUEST_IMAGE_UPDATE_REASON,
            message,
            now,
        )],
        observed_generation: microvm.meta().generation.unwrap_or_default(),
        ..MicroVMStatus::default()
    }
}

fn runtime_pod_uses_image(pod: &Pod, image: &str) -> bool {
    pod.spec
        .as_ref()
        .and_then(|spec| {
            spec.containers
                .iter()
                .find(|container| container.name == "nanoagent")
        })
        .and_then(|container| container.image.as_deref())
        == Some(image)
}

fn terminating_status(microvm: &MicroVM, now: DateTime<Utc>) -> MicroVMStatus {
    let message = "Agent is terminating; owned runtime and persistent state are being deleted";
    let mut status = microvm.status.clone().unwrap_or_default();
    status.phase = MicroVMPhase::Terminating;
    status.guest_ready = false;
    status.failure_reason = None;
    status.message = Some(message.to_owned());
    status.conditions = vec![condition(
        microvm,
        "Ready",
        "False",
        "Terminating",
        message,
        now,
    )];
    status.observed_generation = microvm.meta().generation.unwrap_or_default();
    status
}

async fn report_provisioning_failure(
    api: &Api<MicroVM>,
    pods: &Api<Pod>,
    microvm: &MicroVM,
    reason: &str,
    resource: &str,
    error: &kube::Error,
    now: DateTime<Utc>,
) {
    if !is_terminal_provisioning_error(error) {
        return;
    }

    if reason != BOOTSTRAP_SECRET_REJECTED
        && microvm
            .status
            .as_ref()
            .is_some_and(|status| status.phase == MicroVMPhase::Ready && status.guest_ready)
    {
        match existing_guest_is_usable(pods, microvm).await {
            Ok(true) => {
                preserve_ready_status(api, microvm, reason).await;
                warn!(
                    microvm = %microvm.name_any(),
                    reason,
                    error = %error,
                    "preserving ready agent status after desired resource re-apply was rejected"
                );
                return;
            }
            Ok(false) => {}
            Err(lookup_error) => {
                warn!(
                    microvm = %microvm.name_any(),
                    reason,
                    error = %lookup_error,
                    "could not verify the existing ready guest; preserving its last known usable status"
                );
                return;
            }
        }
    }

    let message = provisioning_failure_message(resource, error);
    let status = provisioning_failure_status(microvm, reason, &message, now);
    if microvm.status.as_ref() == Some(&status) {
        return;
    }
    if let Err(status_error) = patch_status(api, microvm, status).await {
        warn!(
            microvm = %microvm.name_any(),
            reason,
            error = %status_error,
            "failed to publish terminal provisioning error"
        );
    }
}

async fn preserve_ready_status(api: &Api<MicroVM>, microvm: &MicroVM, reason: &str) {
    let Some(mut status) = microvm.status.clone() else {
        return;
    };
    status.observed_generation = microvm.meta().generation.unwrap_or_default();
    if microvm.status.as_ref() == Some(&status) {
        return;
    }
    if let Err(error) = patch_status(api, microvm, status).await {
        warn!(
            microvm = %microvm.name_any(),
            reason,
            error = %error,
            "failed to advance the observed generation of the preserved ready agent"
        );
    }
}

async fn existing_guest_is_usable(pods: &Api<Pod>, microvm: &MicroVM) -> Result<bool, kube::Error> {
    let Some(pod_name) = microvm
        .status
        .as_ref()
        .and_then(|status| status.pod_name.as_deref())
    else {
        return Ok(false);
    };
    Ok(pods
        .get_opt(pod_name)
        .await?
        .as_ref()
        .is_some_and(|pod| pod_is_usable(pod, microvm)))
}

fn pod_is_usable(pod: &Pod, microvm: &MicroVM) -> bool {
    pod.meta().deletion_timestamp.is_none()
        && is_controlled_by_microvm(pod, microvm)
        && pod_is_ready(pod)
}

fn is_terminal_provisioning_error(error: &kube::Error) -> bool {
    matches!(error, kube::Error::Api(response) if (400..500).contains(&response.code) && !is_retryable_provisioning_response(response))
}

fn is_retryable_provisioning_response(response: &kube::core::Status) -> bool {
    matches!(response.code, 401 | 408 | 409 | 429)
        || (response.code == 403
            && [response.reason.as_str(), response.message.as_str()]
                .iter()
                .any(|value| value.to_ascii_lowercase().contains("quota")))
}

fn provisioning_failure_message(resource: &str, error: &kube::Error) -> String {
    let detail = match error {
        kube::Error::Api(response) => {
            let reason = if response.reason.is_empty() {
                "Kubernetes admission rejected the resource"
            } else {
                response.reason.as_str()
            };
            if response.message.is_empty() {
                format!("{reason} (HTTP {})", response.code)
            } else {
                format!("{reason} (HTTP {}): {}", response.code, response.message)
            }
        }
        _ => "Kubernetes API request failed".to_owned(),
    };
    format!("{resource} provisioning failed: {detail}")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(1_024)
        .collect()
}

fn provisioning_failure_status(
    microvm: &MicroVM,
    reason: &str,
    message: &str,
    now: DateTime<Utc>,
) -> MicroVMStatus {
    let previous = microvm.status.clone().unwrap_or_default();
    MicroVMStatus {
        phase: MicroVMPhase::Failed,
        guest_ready: false,
        failure_reason: Some(reason.to_owned()),
        message: Some(message.to_owned()),
        ready_at: None,
        last_activity_at: last_activity_at(microvm),
        conditions: vec![condition(microvm, "Ready", "False", reason, message, now)],
        observed_generation: microvm.meta().generation.unwrap_or_default(),
        ..previous
    }
}

async fn pod_sandbox_failure(
    client: &Client,
    namespace: &str,
    pod: &Pod,
    now: DateTime<Utc>,
) -> Result<Option<PodSandboxFailure>, kube::Error> {
    if !pod_sandbox_is_stuck(pod, now) {
        return Ok(None);
    }
    let Some(uid) = pod.metadata.uid.as_deref() else {
        return Ok(None);
    };

    let events: Api<Event> = Api::namespaced(client.clone(), namespace);
    let listed = events
        .list(&ListParams::default().fields(&format!("involvedObject.uid={uid}")))
        .await?;
    Ok(latest_pod_sandbox_failure(pod, listed.items.iter()))
}

fn pod_sandbox_is_stuck(pod: &Pod, now: DateTime<Utc>) -> bool {
    pod_sandbox_transition_time(pod).is_some_and(|transitioned_at| {
        now.timestamp().saturating_sub(transitioned_at.as_second())
            >= POD_SANDBOX_FAILURE_GRACE_SECONDS
    })
}

fn pod_sandbox_transition_time(pod: &Pod) -> Option<k8s_openapi::jiff::Timestamp> {
    pod.status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .and_then(|conditions| {
            conditions.iter().find(|condition| {
                condition.type_ == "PodReadyToStartContainers" && condition.status == "False"
            })
        })
        .and_then(|condition| condition.last_transition_time.as_ref())
        .map(|transitioned_at| transitioned_at.0)
}

fn event_observed_time(event: &Event) -> Option<k8s_openapi::jiff::Timestamp> {
    event
        .series
        .as_ref()
        .and_then(|series| series.last_observed_time.as_ref())
        .map(|last_observed_time| last_observed_time.0)
        .or_else(|| {
            event
                .last_timestamp
                .as_ref()
                .map(|last_timestamp| last_timestamp.0)
        })
        .or_else(|| event.event_time.as_ref().map(|event_time| event_time.0))
        .or_else(|| {
            event
                .first_timestamp
                .as_ref()
                .map(|first_timestamp| first_timestamp.0)
        })
        .or_else(|| {
            event
                .metadata
                .creation_timestamp
                .as_ref()
                .map(|created_at| created_at.0)
        })
}

fn latest_pod_sandbox_failure<'a>(
    pod: &Pod,
    events: impl Iterator<Item = &'a Event>,
) -> Option<PodSandboxFailure> {
    let pod_uid = pod.metadata.uid.as_deref()?;
    let transitioned_at = pod_sandbox_transition_time(pod)?;
    events
        .filter(|event| {
            event.type_.as_deref() == Some("Warning")
                && event.reason.as_deref() == Some("FailedCreatePodSandBox")
                && event.involved_object.uid.as_deref() == Some(pod_uid)
                && event_observed_time(event)
                    .is_some_and(|observed_at| observed_at >= transitioned_at)
        })
        .max_by_key(|event| {
            (
                event_observed_time(event),
                event
                    .metadata
                    .resource_version
                    .as_deref()
                    .and_then(|value| value.parse::<u128>().ok())
                    .unwrap_or_default(),
            )
        })
        .map(|event| PodSandboxFailure {
            reason: "FailedCreatePodSandBox".to_owned(),
            message: bounded_failure_message(
                event
                    .message
                    .as_deref()
                    .unwrap_or("Kubernetes failed to create the Firecracker Pod sandbox"),
            ),
        })
}

fn retained_pod_sandbox_failure(
    microvm: &MicroVM,
    pod: &Pod,
    now: DateTime<Utc>,
) -> Option<PodSandboxFailure> {
    if !pod_sandbox_is_stuck(pod, now) {
        return None;
    }

    let status = microvm.status.as_ref()?;
    let pod_uid = pod.metadata.uid.as_deref()?;
    let transition_at = pod_sandbox_transition_time(pod)?.to_string();
    if status.phase != MicroVMPhase::Failed
        || status.failure_reason.as_deref() != Some("FailedCreatePodSandBox")
        || status.pod_uid.as_deref() != Some(pod_uid)
        || status.pod_sandbox_transition_at.as_deref() != Some(transition_at.as_str())
    {
        return None;
    }

    Some(PodSandboxFailure {
        reason: "FailedCreatePodSandBox".to_owned(),
        message: status.message.clone().unwrap_or_else(|| {
            "Kubernetes failed to create the Firecracker Pod sandbox".to_owned()
        }),
    })
}

fn bounded_failure_message(message: &str) -> String {
    let mut chars = message.chars();
    let bounded: String = chars.by_ref().take(MAX_FAILURE_MESSAGE_CHARS).collect();
    if chars.next().is_some() {
        format!("{bounded}…")
    } else {
        bounded
    }
}

fn resource_age_seconds(resource: &impl Resource, now: DateTime<Utc>) -> i64 {
    resource
        .meta()
        .creation_timestamp
        .as_ref()
        .map(|created_at| now.timestamp().saturating_sub(created_at.0.as_second()))
        .unwrap_or(i64::MAX)
}

fn derive_status(
    microvm: &MicroVM,
    pod: &Pod,
    home_claim: &str,
    sandbox_failure: Option<&PodSandboxFailure>,
    now: DateTime<Utc>,
) -> MicroVMStatus {
    let retained_sandbox_failure = sandbox_failure
        .is_none()
        .then(|| retained_pod_sandbox_failure(microvm, pod, now))
        .flatten();
    let sandbox_failure = sandbox_failure.or(retained_sandbox_failure.as_ref());
    let pod_status = pod.status.as_ref();
    let ready = pod_is_ready(pod);
    let failed = pod_status.and_then(|status| {
        status
            .init_container_statuses
            .iter()
            .flatten()
            .chain(status.container_statuses.iter().flatten())
            .find_map(container_failure)
    });
    let scheduling_failure = unschedulable_failure_is_terminal(pod, now)
        .then(|| {
            pod_status
                .and_then(|status| status.conditions.as_ref())
                .and_then(|conditions| {
                    conditions.iter().find(|condition| {
                        condition.type_ == "PodScheduled" && condition.status == "False"
                    })
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
                })
        })
        .flatten();
    let pod_phase = pod_status.and_then(|status| status.phase.as_deref());

    let (phase, reason, message, ready_at) = if let Some((reason, message)) = failed {
        (MicroVMPhase::Failed, reason, message, None)
    } else if let Some((reason, message)) = scheduling_failure {
        (MicroVMPhase::Failed, reason, message, None)
    } else if let Some(failure) = sandbox_failure {
        (
            MicroVMPhase::Failed,
            failure.reason.clone(),
            failure.message.clone(),
            None,
        )
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
        pod_uid: pod.metadata.uid.clone(),
        pvc_name: Some(home_claim.to_owned()),
        pod_ip: pod_status.and_then(|status| status.pod_ip.clone()),
        node_name: pod.spec.as_ref().and_then(|spec| spec.node_name.clone()),
        guest_ready: ready,
        failure_reason: (phase == MicroVMPhase::Failed).then_some(reason.clone()),
        message: Some(message.clone()),
        ready_at,
        last_activity_at: last_activity_at(microvm),
        pod_sandbox_transition_at: (reason == "FailedCreatePodSandBox")
            .then(|| pod_sandbox_transition_time(pod).map(|value| value.to_string()))
            .flatten(),
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

fn unschedulable_failure_is_terminal(pod: &Pod, now: DateTime<Utc>) -> bool {
    resource_age_seconds(pod, now) >= UNSCHEDULABLE_FAILURE_GRACE_SECONDS
}

fn pod_is_ready(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .and_then(|conditions| {
            conditions
                .iter()
                .find(|condition| condition.type_ == "Ready")
        })
        .is_some_and(|condition| condition.status == "True")
}

fn pod_proves_storage_initialized(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|status| status.container_statuses.as_ref())
        .and_then(|statuses| statuses.iter().find(|status| status.name == "nanoagent"))
        .is_some_and(|status| {
            status
                .state
                .as_ref()
                .is_some_and(|state| state.running.is_some() || state.terminated.is_some())
                || status
                    .last_state
                    .as_ref()
                    .is_some_and(|state| state.terminated.is_some())
        })
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
        let message = terminated.message.clone().unwrap_or_else(|| {
            format!(
                "Container {} exited with code {}",
                status.name, terminated.exit_code
            )
        });
        return Some((reason, message));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{IDLE_MINUTES, MicroVMArchitecture, MicroVMResources, MicroVMSpec};
    use http::{Request, Response, StatusCode};
    use k8s_openapi::api::core::v1::{
        ContainerState, ContainerStateRunning, ContainerStateTerminated, ContainerStateWaiting,
        ObjectReference, PodCondition, PodStatus,
    };
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
    use kube::client::Body as KubeBody;

    fn test_microvm(now: DateTime<Utc>) -> MicroVM {
        let mut microvm = MicroVM::new(
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
        );
        microvm.metadata.uid = Some("microvm-uid".to_owned());
        microvm
    }

    #[tokio::test]
    async fn owned_cleanup_uses_uid_and_resource_version_preconditions() {
        let microvm = test_microvm(Utc::now());
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let pods: Api<Pod> = Api::namespaced(client, "tengri");
        let cleanup =
            tokio::spawn(async move { delete_owned_and_wait(&pods, "agent", &microvm).await });

        let (request, response) = handle.next_request().await.expect("owned Pod lookup");
        assert_eq!(request.method(), http::Method::GET);
        assert_eq!(request.uri().path(), "/api/v1/namespaces/tengri/pods/agent");
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    br#"{"apiVersion":"v1","kind":"Pod","metadata":{"name":"agent","namespace":"tengri","uid":"pod-uid","resourceVersion":"17","ownerReferences":[{"apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM","name":"agent","uid":"microvm-uid","controller":true}]}}"#
                        .to_vec(),
                ))
                .expect("owned Pod response"),
        );

        let (request, response) = handle.next_request().await.expect("owned Pod deletion");
        assert_eq!(request.method(), http::Method::DELETE);
        assert_eq!(request.uri().path(), "/api/v1/namespaces/tengri/pods/agent");
        let body: serde_json::Value = serde_json::from_slice(
            &request
                .into_body()
                .collect_bytes()
                .await
                .expect("delete request body"),
        )
        .expect("delete options JSON");
        assert_eq!(body["propagationPolicy"], "Foreground");
        assert_eq!(body["preconditions"]["uid"], "pod-uid");
        assert_eq!(body["preconditions"]["resourceVersion"], "17");
        response.send_response(
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    br#"{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"NotFound","message":"Pod agent was already deleted","code":404}"#
                        .to_vec(),
                ))
                .expect("Pod not found response"),
        );

        cleanup
            .await
            .expect("owned cleanup task")
            .expect("owned cleanup result");
    }

    #[tokio::test]
    async fn cleanup_skips_a_same_named_resource_not_owned_by_the_microvm() {
        let microvm = test_microvm(Utc::now());
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let secrets: Api<Secret> = Api::namespaced(client, "tengri");
        let cleanup = tokio::spawn(async move {
            delete_owned_and_wait(&secrets, "agent-bootstrap", &microvm).await
        });

        let (request, response) = handle.next_request().await.expect("foreign Secret lookup");
        assert_eq!(request.method(), http::Method::GET);
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    br#"{"apiVersion":"v1","kind":"Secret","metadata":{"name":"agent-bootstrap","namespace":"tengri","uid":"foreign-secret-uid","ownerReferences":[{"apiVersion":"v1","kind":"ConfigMap","name":"foreign","uid":"foreign-uid","controller":true}]}}"#
                        .to_vec(),
                ))
                .expect("foreign Secret response"),
        );

        cleanup
            .await
            .expect("foreign cleanup task")
            .expect("foreign resource is skipped");
        if let Ok(Some(_)) =
            tokio::time::timeout(Duration::from_millis(25), handle.next_request()).await
        {
            panic!("foreign resource must not be deleted");
        }
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
        let status = derive_status(&test_microvm(now), &pod, "agent-home", None, now);
        assert_eq!(status.phase, MicroVMPhase::Failed);
        assert_eq!(status.failure_reason.as_deref(), Some("ImagePullBackOff"));
        assert_eq!(status.message.as_deref(), Some("unable to pull image"));
    }

    #[test]
    fn reports_unschedulable_firecracker_guest_precisely() {
        let now = Utc::now();
        let pod = Pod {
            metadata: kube::core::ObjectMeta {
                creation_timestamp: Some(Time(
                    k8s_openapi::jiff::Timestamp::from_second(
                        now.timestamp() - UNSCHEDULABLE_FAILURE_GRACE_SECONDS - 1,
                    )
                    .expect("old Pod creation timestamp"),
                )),
                ..kube::core::ObjectMeta::default()
            },
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

        let status = derive_status(&test_microvm(now), &pod, "agent-home", None, now);
        assert_eq!(status.phase, MicroVMPhase::Failed);
        assert_eq!(status.failure_reason.as_deref(), Some("Unschedulable"));
        assert_eq!(
            status.message.as_deref(),
            Some("0/3 nodes match the proven runtime selector")
        );
    }

    #[test]
    fn reports_current_pod_sandbox_failure_precisely() {
        let now = Utc::now();
        let pod = Pod {
            metadata: kube::core::ObjectMeta {
                uid: Some("current-pod-uid".to_owned()),
                creation_timestamp: Some(Time(
                    k8s_openapi::jiff::Timestamp::from_second(
                        now.timestamp() - POD_SANDBOX_FAILURE_GRACE_SECONDS - 1,
                    )
                    .expect("old Pod creation timestamp"),
                )),
                ..kube::core::ObjectMeta::default()
            },
            status: Some(PodStatus {
                phase: Some("Pending".to_owned()),
                conditions: Some(vec![PodCondition {
                    type_: "PodReadyToStartContainers".to_owned(),
                    status: "False".to_owned(),
                    last_transition_time: Some(Time(
                        k8s_openapi::jiff::Timestamp::from_second(
                            now.timestamp() - POD_SANDBOX_FAILURE_GRACE_SECONDS - 1,
                        )
                        .expect("old sandbox transition timestamp"),
                    )),
                    ..PodCondition::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };
        assert!(pod_sandbox_is_stuck(&pod, now));

        let events = [
            Event {
                metadata: kube::core::ObjectMeta {
                    resource_version: Some("40".to_owned()),
                    ..kube::core::ObjectMeta::default()
                },
                involved_object: ObjectReference {
                    uid: Some("previous-pod-uid".to_owned()),
                    ..ObjectReference::default()
                },
                message: Some("stale failure".to_owned()),
                reason: Some("FailedCreatePodSandBox".to_owned()),
                type_: Some("Warning".to_owned()),
                ..Event::default()
            },
            Event {
                metadata: kube::core::ObjectMeta {
                    resource_version: Some("42".to_owned()),
                    ..kube::core::ObjectMeta::default()
                },
                involved_object: ObjectReference {
                    uid: Some("current-pod-uid".to_owned()),
                    ..ObjectReference::default()
                },
                message: Some("flannel has no IP addresses available".to_owned()),
                reason: Some("FailedCreatePodSandBox".to_owned()),
                type_: Some("Warning".to_owned()),
                last_timestamp: Some(Time(
                    k8s_openapi::jiff::Timestamp::from_second(now.timestamp())
                        .expect("current sandbox event timestamp"),
                )),
                ..Event::default()
            },
        ];
        let failure =
            latest_pod_sandbox_failure(&pod, events.iter()).expect("current Pod sandbox failure");
        assert_eq!(failure.reason, "FailedCreatePodSandBox");
        assert_eq!(failure.message, "flannel has no IP addresses available");

        let status = derive_status(&test_microvm(now), &pod, "agent-home", Some(&failure), now);
        assert_eq!(status.phase, MicroVMPhase::Failed);
        assert_eq!(
            status.failure_reason.as_deref(),
            Some("FailedCreatePodSandBox")
        );
        assert_eq!(
            status.message.as_deref(),
            Some("flannel has no IP addresses available")
        );
    }

    #[test]
    fn ignores_transient_or_recovered_pod_sandbox_events() {
        let now = Utc::now();
        let mut pod = Pod {
            metadata: kube::core::ObjectMeta {
                uid: Some("current-pod-uid".to_owned()),
                creation_timestamp: Some(Time(
                    k8s_openapi::jiff::Timestamp::from_second(
                        now.timestamp() - POD_SANDBOX_FAILURE_GRACE_SECONDS - 1,
                    )
                    .expect("old Pod creation timestamp"),
                )),
                ..kube::core::ObjectMeta::default()
            },
            status: Some(PodStatus {
                conditions: Some(vec![PodCondition {
                    type_: "PodReadyToStartContainers".to_owned(),
                    status: "False".to_owned(),
                    last_transition_time: Some(Time(
                        k8s_openapi::jiff::Timestamp::from_second(now.timestamp())
                            .expect("recent sandbox transition timestamp"),
                    )),
                    ..PodCondition::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };
        assert!(!pod_sandbox_is_stuck(&pod, now));

        pod.status
            .as_mut()
            .and_then(|status| status.conditions.as_mut())
            .expect("Pod conditions")[0]
            .status = "True".to_owned();
        assert!(!pod_sandbox_is_stuck(&pod, now));
    }

    #[test]
    fn ignores_stale_pod_sandbox_failure_from_previous_transition() {
        let now = Utc::now();
        let transitioned_at = now.timestamp() - POD_SANDBOX_FAILURE_GRACE_SECONDS - 1;
        let pod = Pod {
            metadata: kube::core::ObjectMeta {
                uid: Some("current-pod-uid".to_owned()),
                ..kube::core::ObjectMeta::default()
            },
            status: Some(PodStatus {
                conditions: Some(vec![PodCondition {
                    type_: "PodReadyToStartContainers".to_owned(),
                    status: "False".to_owned(),
                    last_transition_time: Some(Time(
                        k8s_openapi::jiff::Timestamp::from_second(transitioned_at)
                            .expect("current sandbox transition timestamp"),
                    )),
                    ..PodCondition::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };
        let historical_event = Event {
            involved_object: ObjectReference {
                uid: Some("current-pod-uid".to_owned()),
                ..ObjectReference::default()
            },
            message: Some("historical sandbox failure".to_owned()),
            reason: Some("FailedCreatePodSandBox".to_owned()),
            type_: Some("Warning".to_owned()),
            last_timestamp: Some(Time(
                k8s_openapi::jiff::Timestamp::from_second(transitioned_at - 1)
                    .expect("historical sandbox event timestamp"),
            )),
            ..Event::default()
        };

        assert!(pod_sandbox_is_stuck(&pod, now));
        assert!(latest_pod_sandbox_failure(&pod, [&historical_event].into_iter()).is_none());
    }

    #[test]
    fn retains_published_pod_sandbox_failure_until_the_pod_or_transition_changes() {
        let now = Utc::now();
        let transitioned_at = now.timestamp() - POD_SANDBOX_FAILURE_GRACE_SECONDS - 1;
        let transition = k8s_openapi::jiff::Timestamp::from_second(transitioned_at)
            .expect("sandbox transition timestamp");
        let mut pod = Pod {
            metadata: kube::core::ObjectMeta {
                name: Some("agent".to_owned()),
                uid: Some("current-pod-uid".to_owned()),
                ..kube::core::ObjectMeta::default()
            },
            status: Some(PodStatus {
                phase: Some("Pending".to_owned()),
                conditions: Some(vec![PodCondition {
                    type_: "PodReadyToStartContainers".to_owned(),
                    status: "False".to_owned(),
                    last_transition_time: Some(Time(transition)),
                    ..PodCondition::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };
        let mut microvm = test_microvm(now);
        microvm.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Failed,
            pod_name: Some("agent".to_owned()),
            pod_uid: Some("current-pod-uid".to_owned()),
            pvc_name: Some("agent-home".to_owned()),
            failure_reason: Some("FailedCreatePodSandBox".to_owned()),
            message: Some("flannel has no IP addresses available".to_owned()),
            pod_sandbox_transition_at: Some(transition.to_string()),
            ..MicroVMStatus::default()
        });

        let retained = derive_status(&microvm, &pod, "agent-home", None, now);
        assert_eq!(retained.phase, MicroVMPhase::Failed);
        assert_eq!(
            retained.message.as_deref(),
            Some("flannel has no IP addresses available")
        );

        pod.status
            .as_mut()
            .and_then(|status| status.conditions.as_mut())
            .expect("Pod conditions")[0]
            .last_transition_time = Some(Time(
            k8s_openapi::jiff::Timestamp::from_second(now.timestamp())
                .expect("new sandbox transition timestamp"),
        ));
        let after_transition = derive_status(&microvm, &pod, "agent-home", None, now);
        assert_eq!(after_transition.phase, MicroVMPhase::Booting);

        pod.status
            .as_mut()
            .and_then(|status| status.conditions.as_mut())
            .expect("Pod conditions")[0]
            .last_transition_time = Some(Time(transition));
        pod.metadata.uid = Some("replacement-pod-uid".to_owned());
        let after_replacement = derive_status(&microvm, &pod, "agent-home", None, now);
        assert_eq!(after_replacement.phase, MicroVMPhase::Booting);
    }

    #[test]
    fn keeps_new_pod_booting_while_its_pvc_binds() {
        let now = Utc::now();
        let pod = Pod {
            metadata: kube::core::ObjectMeta {
                creation_timestamp: Some(Time(
                    k8s_openapi::jiff::Timestamp::from_second(now.timestamp())
                        .expect("new Pod creation timestamp"),
                )),
                ..kube::core::ObjectMeta::default()
            },
            status: Some(PodStatus {
                phase: Some("Pending".to_owned()),
                conditions: Some(vec![PodCondition {
                    type_: "PodScheduled".to_owned(),
                    status: "False".to_owned(),
                    reason: Some("Unschedulable".to_owned()),
                    message: Some("pod has unbound immediate PersistentVolumeClaims".to_owned()),
                    ..PodCondition::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };

        let status = derive_status(&test_microvm(now), &pod, "agent-home", None, now);
        assert_eq!(status.phase, MicroVMPhase::Booting);
        assert_eq!(status.failure_reason, None);
        assert_eq!(
            status.message.as_deref(),
            Some("Starting the Firecracker guest")
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

        let status = derive_status(&test_microvm(now), &pod, "agent-home", None, now);
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
    fn container_creation_proves_persistent_storage_initialization() {
        let running = Pod {
            status: Some(PodStatus {
                container_statuses: Some(vec![ContainerStatus {
                    name: "nanoagent".to_owned(),
                    state: Some(ContainerState {
                        running: Some(ContainerStateRunning::default()),
                        ..ContainerState::default()
                    }),
                    ..ContainerStatus::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };
        assert!(pod_proves_storage_initialized(&running));

        let restarted = Pod {
            status: Some(PodStatus {
                container_statuses: Some(vec![ContainerStatus {
                    name: "nanoagent".to_owned(),
                    state: Some(ContainerState {
                        waiting: Some(ContainerStateWaiting::default()),
                        ..ContainerState::default()
                    }),
                    last_state: Some(ContainerState {
                        terminated: Some(ContainerStateTerminated::default()),
                        ..ContainerState::default()
                    }),
                    ..ContainerStatus::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };
        assert!(pod_proves_storage_initialized(&restarted));

        let never_created = Pod {
            status: Some(PodStatus {
                container_statuses: Some(vec![ContainerStatus {
                    name: "nanoagent".to_owned(),
                    state: Some(ContainerState {
                        waiting: Some(ContainerStateWaiting::default()),
                        ..ContainerState::default()
                    }),
                    ..ContainerStatus::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };
        assert!(!pod_proves_storage_initialized(&never_created));
    }

    #[tokio::test]
    async fn successful_initialization_removes_authorization_from_the_live_pod() {
        let pod = Pod {
            metadata: kube::core::ObjectMeta {
                name: Some("agent".to_owned()),
                namespace: Some("tengri".to_owned()),
                resource_version: Some("9".to_owned()),
                annotations: Some(std::collections::BTreeMap::from([(
                    KATA_HOME_BLOCK_INITIALIZATION_TOKEN_ANNOTATION.to_owned(),
                    "tengri-token".to_owned(),
                )])),
                ..kube::core::ObjectMeta::default()
            },
            ..Pod::default()
        };
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let pods = Api::namespaced(client, "tengri");
        let clear = tokio::spawn(async move { clear_pod_initialization_token(&pods, &pod).await });

        let (request, response) = handle.next_request().await.expect("Pod annotation patch");
        assert_eq!(request.method(), http::Method::PATCH);
        assert_eq!(request.uri().path(), "/api/v1/namespaces/tengri/pods/agent");
        let body: serde_json::Value = serde_json::from_slice(
            &request
                .into_body()
                .collect_bytes()
                .await
                .expect("collect Pod patch"),
        )
        .expect("Pod patch JSON");
        assert_eq!(body["metadata"]["resourceVersion"], "9");
        assert_eq!(
            body["metadata"]["annotations"][KATA_HOME_BLOCK_INITIALIZATION_TOKEN_ANNOTATION],
            serde_json::Value::Null
        );
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    br#"{"apiVersion":"v1","kind":"Pod","metadata":{"name":"agent","namespace":"tengri"}}"#
                        .to_vec(),
                ))
                .expect("Pod patch response"),
        );

        clear
            .await
            .expect("clear authorization task")
            .expect("clear authorization");
    }

    #[test]
    fn reports_init_container_failure_precisely() {
        let now = Utc::now();
        let pod = Pod {
            status: Some(PodStatus {
                phase: Some("Pending".to_owned()),
                init_container_statuses: Some(vec![ContainerStatus {
                    name: "prepare-runtime-identity".to_owned(),
                    image: "registry.example/nanoagent".to_owned(),
                    image_id: "registry.example/nanoagent@sha256:abc".to_owned(),
                    ready: false,
                    restart_count: 1,
                    state: Some(ContainerState {
                        terminated: Some(ContainerStateTerminated {
                            exit_code: 1,
                            reason: Some("Error".to_owned()),
                            ..ContainerStateTerminated::default()
                        }),
                        ..ContainerState::default()
                    }),
                    ..ContainerStatus::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };

        let status = derive_status(&test_microvm(now), &pod, "agent-home", None, now);
        assert_eq!(status.phase, MicroVMPhase::Failed);
        assert_eq!(status.failure_reason.as_deref(), Some("Error"));
        assert_eq!(
            status.message.as_deref(),
            Some("Container prepare-runtime-identity exited with code 1")
        );
    }

    #[test]
    fn idle_timeout_sleeps_after_sixty_minutes() {
        let now = Utc::now();
        let microvm = test_microvm(now - chrono::Duration::minutes(61));
        assert!(idle_deadline_passed(&microvm, now));
    }

    #[test]
    fn refreshed_idle_deadline_prevents_sleep_even_when_status_is_stale() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.status = Some(MicroVMStatus {
            last_activity_at: Some((now - chrono::Duration::hours(2)).to_rfc3339()),
            ..MicroVMStatus::default()
        });
        assert!(!idle_deadline_passed(&microvm, now));
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
    fn resume_latency_uses_the_persisted_wake_marker_after_booting_status() {
        let now = Utc::now();
        let mut microvm = test_microvm(now - chrono::Duration::hours(2));
        microvm.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Booting,
            ..MicroVMStatus::default()
        });
        microvm.metadata.annotations = Some(std::collections::BTreeMap::from([(
            RESUME_STARTED_AT_ANNOTATION.to_owned(),
            (now - chrono::Duration::seconds(3)).to_rfc3339(),
        )]));

        assert_eq!(
            readiness_latency(&microvm, now),
            Some(ReadinessLatency::Resume(3_000))
        );
        microvm.metadata.annotations = None;
        assert_eq!(
            readiness_latency(&microvm, now),
            Some(ReadinessLatency::Boot(7_200_000))
        );
    }

    #[test]
    fn guest_image_update_does_not_record_the_agent_age_as_boot_latency() {
        let now = Utc::now();
        let mut microvm = test_microvm(now - chrono::Duration::hours(2));
        microvm.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Booting,
            conditions: vec![condition(
                &microvm,
                "Ready",
                "False",
                "GuestBooting",
                "Starting the Firecracker guest",
                now,
            )],
            ..MicroVMStatus::default()
        });
        microvm.metadata.annotations = Some(std::collections::BTreeMap::from([(
            GUEST_IMAGE_UPDATE_STARTED_AT_ANNOTATION.to_owned(),
            (now - chrono::Duration::seconds(5)).to_rfc3339(),
        )]));

        assert_eq!(readiness_latency(&microvm, now), None);
    }

    #[test]
    fn deletion_publishes_terminating_without_discarding_resource_identity() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.metadata.generation = Some(9);
        microvm.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Ready,
            pod_name: Some("agent-1234".to_owned()),
            pvc_name: Some("agent-1234-home".to_owned()),
            guest_ready: true,
            failure_reason: Some("OldFailure".to_owned()),
            ..MicroVMStatus::default()
        });

        let status = terminating_status(&microvm, now);
        assert_eq!(status.phase, MicroVMPhase::Terminating);
        assert!(!status.guest_ready);
        assert_eq!(status.pod_name.as_deref(), Some("agent-1234"));
        assert_eq!(status.pvc_name.as_deref(), Some("agent-1234-home"));
        assert_eq!(status.failure_reason, None);
        assert_eq!(status.conditions[0].reason, "Terminating");
        assert_eq!(status.observed_generation, 9);
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

    #[tokio::test]
    async fn status_patch_is_not_invalidated_by_independent_metadata_updates() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.metadata.namespace = Some("tengri".to_owned());
        microvm.metadata.resource_version = Some("17".to_owned());
        let response_microvm = microvm.clone();
        let status = MicroVMStatus {
            phase: MicroVMPhase::Ready,
            guest_ready: true,
            last_activity_at: Some(now.to_rfc3339()),
            ..MicroVMStatus::default()
        };
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let microvms = Api::namespaced(client, "tengri");

        let update = tokio::spawn(async move { patch_status(&microvms, &microvm, status).await });
        let (request, response) = handle.next_request().await.expect("status patch");
        assert_eq!(request.method(), http::Method::PATCH);
        assert_eq!(
            request.uri().path(),
            "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent/status"
        );
        let body: serde_json::Value = serde_json::from_slice(
            &request
                .into_body()
                .collect_bytes()
                .await
                .expect("status patch body"),
        )
        .expect("status patch JSON");
        assert!(body.pointer("/metadata/resourceVersion").is_none());
        assert_eq!(body["status"]["phase"], "Ready");
        assert_eq!(body["status"]["guestReady"], true);
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&response_microvm).expect("MicroVM response JSON"),
                ))
                .expect("status patch response"),
        );

        update
            .await
            .expect("status patch task")
            .expect("status patch result");
    }

    #[test]
    fn terminal_admission_errors_become_precise_failed_statuses() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.metadata.generation = Some(7);
        let error = kube::Error::Api(
            kube::core::Status {
                code: 422,
                message: "runtimeClassName kata-fc is not available\nfor this architecture"
                    .to_owned(),
                reason: "Invalid".to_owned(),
                ..kube::core::Status::default()
            }
            .boxed(),
        );

        assert!(is_terminal_provisioning_error(&error));
        let message = provisioning_failure_message("Firecracker Pod", &error);
        assert_eq!(
            message,
            "Firecracker Pod provisioning failed: Invalid (HTTP 422): runtimeClassName kata-fc is not available for this architecture"
        );
        let status = provisioning_failure_status(&microvm, "MicroVMPodRejected", &message, now);
        assert_eq!(status.phase, MicroVMPhase::Failed);
        assert!(!status.guest_ready);
        assert_eq!(status.failure_reason.as_deref(), Some("MicroVMPodRejected"));
        assert_eq!(status.observed_generation, 7);
        assert_eq!(status.conditions[0].reason, "MicroVMPodRejected");
    }

    #[tokio::test]
    async fn rejected_reapply_preserves_a_usable_ready_guest_at_the_current_generation() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.metadata.namespace = Some("tengri".to_owned());
        microvm.metadata.generation = Some(8);
        microvm.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Ready,
            pod_name: Some("agent".to_owned()),
            guest_ready: true,
            ready_at: Some(now.to_rfc3339()),
            observed_generation: 7,
            ..MicroVMStatus::default()
        });
        let response_microvm = microvm.clone();
        let error = kube::Error::Api(
            kube::core::Status {
                code: 422,
                reason: "Invalid".to_owned(),
                message: "immutable field changed".to_owned(),
                ..kube::core::Status::default()
            }
            .boxed(),
        );
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let microvms = Api::namespaced(client.clone(), "tengri");
        let pods = Api::namespaced(client, "tengri");

        let report = tokio::spawn(async move {
            report_provisioning_failure(
                &microvms,
                &pods,
                &microvm,
                "MicroVMPodRejected",
                "Firecracker Pod",
                &error,
                now,
            )
            .await;
        });
        let (request, response) = handle.next_request().await.expect("existing Pod lookup");
        assert_eq!(request.uri().path(), "/api/v1/namespaces/tengri/pods/agent");
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    br#"{"apiVersion":"v1","kind":"Pod","metadata":{"name":"agent","namespace":"tengri","ownerReferences":[{"apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM","name":"agent","uid":"microvm-uid","controller":true}]},"status":{"conditions":[{"status":"True","type":"Ready"}]}}"#
                        .to_vec(),
                ))
                .expect("ready Pod response"),
        );

        let (request, response) = handle
            .next_request()
            .await
            .expect("status generation update");
        assert_eq!(request.method(), http::Method::PATCH);
        assert_eq!(
            request.uri().path(),
            "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent/status"
        );
        let body: serde_json::Value = serde_json::from_slice(
            &request
                .into_body()
                .collect_bytes()
                .await
                .expect("status patch body"),
        )
        .expect("status patch JSON");
        assert_eq!(body["status"]["phase"], "Ready");
        assert_eq!(body["status"]["guestReady"], true);
        assert_eq!(body["status"]["observedGeneration"], 8);
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&response_microvm).expect("MicroVM response JSON"),
                ))
                .expect("status patch response"),
        );

        tokio::time::timeout(Duration::from_millis(100), report)
            .await
            .expect("ready guest status must be preserved at the current generation")
            .expect("provisioning report task");
    }

    #[tokio::test]
    async fn same_named_foreign_ready_pod_is_not_a_usable_guest() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Ready,
            pod_name: Some("agent".to_owned()),
            guest_ready: true,
            ..MicroVMStatus::default()
        });
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let pods = Api::namespaced(client, "tengri");
        let check = tokio::spawn(async move { existing_guest_is_usable(&pods, &microvm).await });

        let (request, response) = handle.next_request().await.expect("existing Pod lookup");
        assert_eq!(request.uri().path(), "/api/v1/namespaces/tengri/pods/agent");
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    br#"{"apiVersion":"v1","kind":"Pod","metadata":{"name":"agent","namespace":"tengri","ownerReferences":[{"apiVersion":"v1","kind":"ConfigMap","name":"foreign","uid":"foreign-uid","controller":true}]},"status":{"conditions":[{"status":"True","type":"Ready"}]}}"#
                        .to_vec(),
                ))
                .expect("foreign ready Pod response"),
        );

        assert!(!check.await.expect("guest check task").expect("Pod lookup"));
    }

    #[tokio::test]
    async fn ensure_runtime_pod_reuses_an_owned_current_release_pod() {
        let now = Utc::now();
        let microvm = test_microvm(now);
        let image = microvm.spec.image.clone();
        let response_pod: Pod = serde_json::from_value(json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": "agent",
                "namespace": "tengri",
                "ownerReferences": [{
                    "apiVersion": "runtime.proompteng.ai/v1alpha1",
                    "kind": "MicroVM",
                    "name": "agent",
                    "uid": "microvm-uid",
                    "controller": true,
                }],
            },
            "spec": {
                "containers": [{"name": "nanoagent", "image": image}],
            },
            "status": {"phase": "Pending"},
        }))
        .expect("booting Pod");
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let pods = Api::namespaced(client, "tengri");
        let ensure = tokio::spawn(async move {
            ensure_runtime_pod(
                &pods,
                &microvm,
                "tengri",
                "agent-bootstrap",
                "agent-home",
                PersistentBlockInitialization::Pending,
            )
            .await
        });

        let (request, response) = handle.next_request().await.expect("existing Pod lookup");
        assert_eq!(request.method(), http::Method::GET);
        assert_eq!(request.uri().path(), "/api/v1/namespaces/tengri/pods/agent");
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&response_pod).expect("Pod response JSON"),
                ))
                .expect("Pod response"),
        );

        let pod = ensure
            .await
            .expect("ensure task")
            .expect("owned Pod is preserved");
        assert_eq!(
            pod.status.and_then(|status| status.phase).as_deref(),
            Some("Pending")
        );
        if let Ok(Some((request, _))) =
            tokio::time::timeout(Duration::from_millis(25), handle.next_request()).await
        {
            panic!(
                "owned Pod must not be reapplied: {} {}",
                request.method(),
                request.uri()
            );
        }
    }

    #[tokio::test]
    async fn guest_image_patch_updates_only_the_controller_owned_digest() {
        let mut microvm = test_microvm(Utc::now());
        microvm.metadata.namespace = Some("tengri".to_owned());
        microvm.metadata.resource_version = Some("41".to_owned());
        let desired_image = format!("registry.example/nanoagent@sha256:{}", "b".repeat(64));
        let mut response_microvm = microvm.clone();
        response_microvm.spec.image = desired_image.clone();

        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let microvms = Api::namespaced(client, "tengri");
        let patch_image = desired_image.clone();
        let started_at = "2026-08-31T08:00:00Z";
        let patch = tokio::spawn(async move {
            patch_guest_image(&microvms, &microvm, &patch_image, started_at).await
        });

        let (request, response) = handle.next_request().await.expect("MicroVM image patch");
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
                .expect("patch request body"),
        )
        .expect("merge patch JSON");
        assert_eq!(body["metadata"]["resourceVersion"], "41");
        assert_eq!(
            body["metadata"]["annotations"][GUEST_IMAGE_UPDATE_STARTED_AT_ANNOTATION],
            started_at
        );
        assert_eq!(body["spec"], json!({"image": desired_image}));
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&response_microvm).expect("MicroVM response JSON"),
                ))
                .expect("MicroVM response"),
        );

        patch
            .await
            .expect("image patch task")
            .expect("controller-owned image patch");
    }

    #[test]
    fn runtime_pod_must_use_the_exact_configured_nanoagent_digest() {
        let current_image = format!("registry.example/nanoagent@sha256:{}", "b".repeat(64));
        let old_image = format!("registry.example/nanoagent@sha256:{}", "a".repeat(64));
        let current: Pod = serde_json::from_value(json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {"name": "agent"},
            "spec": {"containers": [{"name": "nanoagent", "image": current_image}]},
        }))
        .expect("current release Pod");
        let old: Pod = serde_json::from_value(json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {"name": "agent"},
            "spec": {"containers": [{"name": "nanoagent", "image": old_image}]},
        }))
        .expect("old release Pod");

        assert!(runtime_pod_uses_image(&current, &current_image));
        assert!(!runtime_pod_uses_image(&old, &current_image));
        assert!(!runtime_pod_uses_image(&Pod::default(), &current_image));
    }

    #[test]
    fn guest_image_update_status_reports_a_guest_restart_and_retains_the_pvc() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.metadata.generation = Some(9);
        let status = guest_image_update_status(&microvm, now);

        assert_eq!(status.phase, MicroVMPhase::Booting);
        assert!(!status.guest_ready);
        assert_eq!(status.pvc_name.as_deref(), Some("agent-home"));
        assert_eq!(status.pod_name, None);
        assert_eq!(status.failure_reason, None);
        assert_eq!(status.observed_generation, 9);
        assert_eq!(status.conditions[0].reason, GUEST_IMAGE_UPDATE_REASON);
        assert!(
            status.message.as_deref().is_some_and(
                |message| message.contains("persistent home and workspace are retained")
            )
        );
    }

    #[test]
    fn terminating_owned_ready_pod_is_not_a_usable_guest() {
        let now = Utc::now();
        let microvm = test_microvm(now);
        let pod: Pod = serde_json::from_value(json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": "agent",
                "namespace": "tengri",
                "deletionTimestamp": now.to_rfc3339(),
                "ownerReferences": [{
                    "apiVersion": "runtime.proompteng.ai/v1alpha1",
                    "kind": "MicroVM",
                    "name": "agent",
                    "uid": "microvm-uid",
                    "controller": true,
                }],
            },
            "status": {"conditions": [{"status": "True", "type": "Ready"}]},
        }))
        .expect("terminating ready Pod");

        assert!(!pod_is_usable(&pod, &microvm));
    }

    #[tokio::test]
    async fn rejected_reapply_does_not_advance_an_unverified_ready_guest() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.metadata.namespace = Some("tengri".to_owned());
        microvm.metadata.generation = Some(8);
        microvm.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Ready,
            pod_name: Some("agent".to_owned()),
            guest_ready: true,
            ready_at: Some(now.to_rfc3339()),
            observed_generation: 7,
            ..MicroVMStatus::default()
        });
        let error = kube::Error::Api(
            kube::core::Status {
                code: 422,
                reason: "Invalid".to_owned(),
                message: "immutable field changed".to_owned(),
                ..kube::core::Status::default()
            }
            .boxed(),
        );
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let microvms = Api::namespaced(client.clone(), "tengri");
        let pods = Api::namespaced(client, "tengri");

        let report = tokio::spawn(async move {
            report_provisioning_failure(
                &microvms,
                &pods,
                &microvm,
                "MicroVMPodRejected",
                "Firecracker Pod",
                &error,
                now,
            )
            .await;
        });
        let (request, response) = handle.next_request().await.expect("existing Pod lookup");
        assert_eq!(request.uri().path(), "/api/v1/namespaces/tengri/pods/agent");
        response.send_response(
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    br#"{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"InternalError","message":"Pod lookup failed","code":500}"#
                        .to_vec(),
                ))
                .expect("Pod lookup failure response"),
        );

        tokio::time::timeout(Duration::from_millis(100), report)
            .await
            .expect("unverified guest must retain its previous generation")
            .expect("provisioning report task");
        if let Ok(Some(_)) =
            tokio::time::timeout(Duration::from_millis(25), handle.next_request()).await
        {
            panic!("unverified guest must not receive a status generation update");
        }
    }

    #[tokio::test]
    async fn bootstrap_secret_rejection_does_not_preserve_a_ready_pod() {
        let now = Utc::now();
        let mut microvm = test_microvm(now);
        microvm.metadata.namespace = Some("tengri".to_owned());
        microvm.metadata.generation = Some(4);
        microvm.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Ready,
            pod_name: Some("agent".to_owned()),
            guest_ready: true,
            ready_at: Some(now.to_rfc3339()),
            observed_generation: 3,
            ..MicroVMStatus::default()
        });
        let response_microvm = microvm.clone();
        let error = kube::Error::Api(
            kube::core::Status {
                code: 422,
                reason: "Invalid".to_owned(),
                message: "bootstrap Secret is unavailable".to_owned(),
                ..kube::core::Status::default()
            }
            .boxed(),
        );
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let microvms = Api::namespaced(client.clone(), "tengri");
        let pods = Api::namespaced(client, "tengri");

        let report = tokio::spawn(async move {
            report_provisioning_failure(
                &microvms,
                &pods,
                &microvm,
                "BootstrapSecretRejected",
                "Bootstrap Secret",
                &error,
                now,
            )
            .await;
        });

        let (request, response) = handle.next_request().await.expect("failed status update");
        assert_eq!(request.method(), http::Method::PATCH);
        assert_eq!(
            request.uri().path(),
            "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent/status"
        );
        let body: serde_json::Value = serde_json::from_slice(
            &request
                .into_body()
                .collect_bytes()
                .await
                .expect("failed status patch body"),
        )
        .expect("failed status patch JSON");
        assert_eq!(body["status"]["phase"], "Failed");
        assert_eq!(body["status"]["guestReady"], false);
        assert_eq!(body["status"]["failureReason"], "BootstrapSecretRejected");
        assert_eq!(body["status"]["observedGeneration"], 4);
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    serde_json::to_vec(&response_microvm).expect("MicroVM response JSON"),
                ))
                .expect("failed status patch response"),
        );

        tokio::time::timeout(Duration::from_millis(100), report)
            .await
            .expect("bootstrap rejection must publish Failed")
            .expect("provisioning report task");
    }

    #[test]
    fn transient_kubernetes_failures_remain_retryable() {
        for code in [401, 408, 409, 429, 500] {
            let error = kube::Error::Api(
                kube::core::Status {
                    code,
                    reason: "Retryable".to_owned(),
                    ..kube::core::Status::default()
                }
                .boxed(),
            );
            assert!(!is_terminal_provisioning_error(&error));
        }

        let exhausted_quota = kube::Error::Api(
            kube::core::Status {
                code: 403,
                reason: "Forbidden".to_owned(),
                message: "exceeded quota: tengri-agents".to_owned(),
                ..kube::core::Status::default()
            }
            .boxed(),
        );
        assert!(!is_terminal_provisioning_error(&exhausted_quota));

        let forbidden = kube::Error::Api(
            kube::core::Status {
                code: 403,
                reason: "Forbidden".to_owned(),
                message: "service account cannot create pods".to_owned(),
                ..kube::core::Status::default()
            }
            .boxed(),
        );
        assert!(is_terminal_provisioning_error(&forbidden));
    }
}
