use std::{sync::Arc, time::Duration};

use anyhow::{Context, ensure};
use chrono::Utc;
use futures::StreamExt;
use k8s_openapi::api::{
    coordination::v1::Lease,
    core::v1::{PersistentVolumeClaim, Pod, Secret},
};
use kube::{
    Api, Client, ResourceExt,
    api::{DeleteParams, ListParams, Patch, PatchParams, PostParams, Preconditions},
    runtime::{Controller, controller::Action, watcher},
};
use serde_json::json;

use crate::{
    activity::{idle_deadline_passed, last_activity_at},
    crd::{
        MicroVM, MicroVMArchitecture, MicroVMCondition, MicroVMDesiredState, MicroVMPhase,
        MicroVMSlot, MicroVMStatus,
    },
    identity::WorkloadIdentity,
    metrics,
    pod::{
        self, FINALIZER_NAME, HOME_NAME_ANNOTATION, HOME_UID_ANNOTATION, IMAGE_ANNOTATION,
        POD_UID_ANNOTATION, SLOT_SELECTOR,
    },
    slot::{
        Claim, SlotState,
        client::{SlotClient, claim_for},
    },
    tickets::TicketStore,
};

const SLOT_COUNT: usize = 6;
const STOPPED_POD_ANNOTATION: &str = "runtime.proompteng.ai/stopped-slot-pod-uid";
const RETIRING_ANNOTATION: &str = "runtime.proompteng.ai/retiring-slot";

#[derive(Clone)]
pub struct ControllerContext {
    pub client: Client,
    pub namespace: String,
    pub tickets: TicketStore,
    pub guest_image: Arc<str>,
    pub runtime_image: Arc<str>,
    pub architecture: MicroVMArchitecture,
    pub identity: WorkloadIdentity,
    pub authorization: crate::authz::WorkspaceAuthorization,
}

pub async fn run(context: ControllerContext) {
    let maintenance = context.clone();
    let pool = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            if let Err(error) = maintain_pool(&maintenance).await {
                tracing::error!(error = %error, "slot pool preparation failed");
            }
        }
    });
    let microvms = Api::<MicroVM>::namespaced(context.client.clone(), &context.namespace);
    let pods = Api::<Pod>::namespaced(context.client.clone(), &context.namespace);
    Controller::new(microvms, watcher::Config::default())
        .owns(pods, watcher::Config::default())
        .run(
            reconcile,
            |_, error: &ReconcileError, _| {
                tracing::warn!(error = %error, "MicroVM reconciliation will retry");
                Action::requeue(Duration::from_secs(2))
            },
            Arc::new(context),
        )
        .for_each(|result| async move {
            if let Err(error) = result {
                tracing::error!(error = %error, "MicroVM reconciliation failed");
            }
        })
        .await;
    pool.abort();
}

#[derive(Debug, thiserror::Error)]
#[error("MicroVM lifecycle failed: {0}")]
struct ReconcileError(#[from] anyhow::Error);

async fn reconcile(
    microvm: Arc<MicroVM>,
    context: Arc<ControllerContext>,
) -> Result<Action, ReconcileError> {
    let result = if microvm.metadata.deletion_timestamp.is_some() {
        cleanup(&context, &microvm).await.map(|_| ())
    } else {
        converge(
            &context.client,
            &context.namespace,
            &microvm,
            &context.identity,
            &context.tickets,
        )
        .await
        .map(|_| ())
    };
    if let Err(error) = &result
        && let Ok(Some(current)) =
            Api::<MicroVM>::namespaced(context.client.clone(), &context.namespace)
                .get_opt(&microvm.name_any())
                .await
        && current.uid() == microvm.uid()
        && current.metadata.generation == microvm.metadata.generation
    {
        let mut status = current.status.clone().unwrap_or_default();
        let capacity = error.downcast_ref::<NoPreparedSlot>().is_some();
        status.phase = if capacity {
            MicroVMPhase::Pending
        } else {
            MicroVMPhase::Failed
        };
        status.guest_ready = false;
        status.failure_reason = Some(
            if capacity {
                "PoolPreparing"
            } else {
                "SnapshotLifecycleFailed"
            }
            .into(),
        );
        status.message = Some(error.to_string());
        status.conditions = vec![MicroVMCondition {
            type_: "Ready".into(),
            status: "False".into(),
            reason: status.failure_reason.clone().expect("failure reason"),
            message: error.to_string(),
            last_transition_at: Utc::now().to_rfc3339(),
        }];
        status.observed_generation = microvm.metadata.generation.unwrap_or_default();
        let _ = patch_status(
            &context.client,
            &context.namespace,
            &current,
            &status,
            metrics::global(),
        )
        .await;
    }
    result?;
    Ok(Action::requeue(Duration::from_secs(5)))
}

pub async fn converge(
    client: &Client,
    namespace: &str,
    microvm: &MicroVM,
    identity: &WorkloadIdentity,
    tickets: &TicketStore,
) -> anyhow::Result<MicroVM> {
    ensure!(
        microvm.metadata.deletion_timestamp.is_none(),
        "agent is terminating"
    );
    let started = std::time::Instant::now();
    let api = Api::<MicroVM>::namespaced(client.clone(), namespace);
    let microvm = ensure_slot(client, namespace, microvm, identity).await?;
    let pod = bound_pod(client, namespace, &microvm).await?;
    let binding = microvm.spec.slot.as_ref().context("missing slot binding")?;
    let supervisor = SlotClient::new(
        identity,
        namespace,
        &pod,
        &binding.pvc_uid,
        &microvm.spec.image,
    )?;
    let claim = claim_for(&microvm)?;
    let now = Utc::now();
    if idle_deadline_passed(&microvm, now)
        && microvm.spec.desired_state != MicroVMDesiredState::Sleeping
    {
        api.patch(&microvm.name_any(), &PatchParams::default(), &Patch::Merge(json!({
            "metadata": {"resourceVersion": microvm.resource_version()}, "spec": {"desiredState": "Sleeping"}
        }))).await?;
        return api.get(&microvm.name_any()).await.map_err(Into::into);
    }
    let status = supervisor.status().await?;
    ensure!(
        matches!(status.state, SlotState::Vacant { .. }) || status.state.claim() == Some(&claim),
        "slot owner or epoch changed"
    );
    let state = match microvm.spec.desired_state {
        MicroVMDesiredState::Running => {
            if status.state.serves(&claim) {
                status
            } else {
                supervisor.lifecycle("restore", &claim).await?
            }
        }
        MicroVMDesiredState::Sleeping => {
            tickets.remove_agent(&microvm.name_any())?;
            metrics::global().clear_pty_sessions(&microvm.name_any());
            if matches!(status.state, SlotState::Sleeping { .. }) {
                status
            } else {
                supervisor.lifecycle("sleep", &claim).await?
            }
        }
    };
    let mut current = api.get(&microvm.name_any()).await?;
    for _ in 0..3 {
        ensure!(
            current.uid() == microvm.uid() && current.spec.slot == microvm.spec.slot,
            "agent incarnation changed during its lifecycle"
        );
        ensure!(
            current.metadata.generation == microvm.metadata.generation,
            "agent desired state changed during its lifecycle; retry"
        );
        ensure!(
            current.metadata.deletion_timestamp.is_none(),
            "agent is terminating"
        );
        let status = status_for(&current, &pod, &state.state);
        match patch_status(client, namespace, &current, &status, metrics::global()).await {
            Ok(updated) => {
                if status.phase == MicroVMPhase::Ready
                    && current.status.as_ref().is_none_or(|s| !s.guest_ready)
                {
                    let millis = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
                    if current
                        .status
                        .as_ref()
                        .is_some_and(|s| s.phase == MicroVMPhase::Sleeping)
                    {
                        metrics::global().observe_resume(millis);
                    } else {
                        metrics::global().observe_boot(millis);
                    }
                }
                return Ok(updated);
            }
            Err(error) if matches!(error.downcast_ref::<kube::Error>(), Some(kube::Error::Api(response)) if response.code == 409) =>
            {
                current = api.get(&microvm.name_any()).await?;
            }
            Err(error) => return Err(error),
        }
    }
    anyhow::bail!("agent status changed concurrently; retry the request")
}

fn status_for(microvm: &MicroVM, pod: &Pod, state: &SlotState) -> MicroVMStatus {
    let now = Utc::now();
    let phase = match state {
        SlotState::Awake { .. } => MicroVMPhase::Ready,
        SlotState::Sleeping { .. } => MicroVMPhase::Sleeping,
        SlotState::Failed { .. } | SlotState::Stopped { .. } => MicroVMPhase::Failed,
        _ => MicroVMPhase::Booting,
    };
    let ready = phase == MicroVMPhase::Ready;
    let (reason, message) = match state {
        SlotState::Awake { .. } => (
            "SnapshotRestored",
            "Files, terminal, and initialized Codex passed the guest resume hook",
        ),
        SlotState::Sleeping { .. } => (
            "GuestStopped",
            "Guest process is stopped and snapshot pages are evicted",
        ),
        SlotState::Failed { message, .. } => ("SnapshotLifecycleFailed", message.as_str()),
        SlotState::Stopped { .. } => ("GuestTerminated", "Guest process termination is proven"),
        _ => (
            "SnapshotLifecycleInProgress",
            "Slot preparation or lifecycle operation is in progress",
        ),
    };
    let binding = microvm.spec.slot.as_ref().expect("bound MicroVM");
    let previous_transition = microvm
        .status
        .as_ref()
        .filter(|s| s.phase == phase)
        .and_then(|s| s.conditions.first())
        .map(|c| c.last_transition_at.clone());
    MicroVMStatus {
        phase,
        pod_name: Some(binding.name.clone()),
        pod_uid: Some(binding.pod_uid.clone()),
        pvc_name: Some(binding.pvc_name.clone()),
        pod_ip: pod.status.as_ref().and_then(|s| s.pod_ip.clone()),
        node_name: pod.spec.as_ref().and_then(|s| s.node_name.clone()),
        guest_ready: ready,
        failure_reason: (phase == MicroVMPhase::Failed).then(|| reason.into()),
        message: (phase == MicroVMPhase::Failed).then(|| message.into()),
        ready_at: ready.then(|| {
            microvm
                .status
                .as_ref()
                .and_then(|s| s.ready_at.clone())
                .unwrap_or_else(|| now.to_rfc3339())
        }),
        last_activity_at: last_activity_at(microvm),
        observed_generation: microvm.metadata.generation.unwrap_or_default(),
        conditions: vec![MicroVMCondition {
            type_: "Ready".into(),
            status: if ready { "True" } else { "False" }.into(),
            reason: reason.into(),
            message: message.into(),
            last_transition_at: previous_transition.unwrap_or_else(|| now.to_rfc3339()),
        }],
        ..Default::default()
    }
}

async fn patch_status(
    client: &Client,
    namespace: &str,
    microvm: &MicroVM,
    status: &MicroVMStatus,
    metrics: &metrics::Metrics,
) -> anyhow::Result<MicroVM> {
    if microvm.status.as_ref() == Some(status) {
        return Ok(microvm.clone());
    }
    let updated = Api::<MicroVM>::namespaced(client.clone(), namespace)
        .patch_status(
            &microvm.name_any(),
            &PatchParams::default(),
            &Patch::Merge(json!({"metadata": {"resourceVersion": microvm.resource_version()}, "status": status})),
        )
        .await?;
    if status.phase == MicroVMPhase::Failed
        && microvm
            .status
            .as_ref()
            .is_none_or(|s| s.phase != MicroVMPhase::Failed)
    {
        metrics.record_guest_failure();
    }
    Ok(updated)
}

pub async fn ensure_slot(
    client: &Client,
    namespace: &str,
    microvm: &MicroVM,
    identity: &WorkloadIdentity,
) -> anyhow::Result<MicroVM> {
    let api = Api::<MicroVM>::namespaced(client.clone(), namespace);
    let leases = Api::<Lease>::namespaced(client.clone(), namespace);
    let pods = Api::<Pod>::namespaced(client.clone(), namespace);
    let mut current = microvm.clone();
    for _ in 0..SLOT_COUNT + 1 {
        ensure!(
            current.metadata.deletion_timestamp.is_none(),
            "agent is terminating"
        );
        if let Some(binding) = &current.spec.slot {
            let mut lease = leases.get(&binding.name).await?;
            let expected = claim_for(&current)?;
            if let Some(holder) = lease.spec.as_ref().and_then(|s| s.holder_identity.as_ref()) {
                let holder: Claim = serde_json::from_str(holder)?;
                if holder != expected {
                    // This candidate lost the Lease CAS before any guest could be started.
                    let pod = pods.get(&binding.name).await?;
                    let status = SlotClient::new(
                        identity,
                        namespace,
                        &pod,
                        &binding.pvc_uid,
                        &current.spec.image,
                    )?
                    .status()
                    .await?;
                    ensure!(
                        status.state.claim() != Some(&expected),
                        "slot claim changed after execution; retain disks for fenced recovery"
                    );
                    ensure!(
                        current
                            .status
                            .as_ref()
                            .is_none_or(|s| s.pod_uid.as_ref() != Some(&binding.pod_uid)),
                        "active slot Lease was reassigned; retain disks for fenced recovery"
                    );
                    current = api.patch(&current.name_any(), &PatchParams::default(), &Patch::Merge(json!({"metadata": {"resourceVersion": current.resource_version()}, "spec": {"slot": null}}))).await?;
                    continue;
                }
            } else {
                let spec = lease.spec.get_or_insert_default();
                ensure!(
                    u64::try_from(spec.lease_transitions.unwrap_or_default())?.checked_add(1)
                        == Some(expected.epoch),
                    "slot candidate was cancelled"
                );
                spec.holder_identity = Some(serde_json::to_string(&expected)?);
                spec.lease_transitions = Some(i32::try_from(expected.epoch)?);
                lease.metadata = pod::owned_metadata(lease.metadata, &current);
                match leases
                    .replace(&binding.name, &PostParams::default(), &lease)
                    .await
                {
                    Ok(claimed) => lease = claimed,
                    Err(kube::Error::Api(error)) if error.code == 409 => {
                        current = api.get(&current.name_any()).await?;
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            if current.status.as_ref().and_then(|s| s.pod_uid.as_ref()) == Some(&binding.pod_uid) {
                ensure!(
                    lease.annotations().get(POD_UID_ANNOTATION) == Some(&binding.pod_uid)
                        && lease.annotations().get(HOME_UID_ANNOTATION) == Some(&binding.pvc_uid)
                        && lease.annotations().get(HOME_NAME_ANNOTATION) == Some(&binding.pvc_name),
                    "slot Pod or home binding changed"
                );
                return Ok(current);
            }
            return bind_microvm(client, namespace, &current, &lease).await;
        }
        let enrolled = leases
            .list(&ListParams::default().labels(SLOT_SELECTOR))
            .await?
            .items
            .into_iter()
            .filter(|lease| {
                lease
                    .spec
                    .as_ref()
                    .and_then(|s| s.holder_identity.as_ref())
                    .is_some_and(|holder| {
                        serde_json::from_str::<Claim>(holder).is_ok_and(|claim| {
                            claim.microvm_id == current.name_any()
                                && Some(claim.microvm_uid) == current.uid()
                        })
                    })
            })
            .collect::<Vec<_>>();
        ensure!(
            enrolled.len() <= 1,
            "agent has multiple slot claims; retain all homes for recovery"
        );
        if let Some(lease) = enrolled.first() {
            return bind_microvm(client, namespace, &current, lease).await;
        }
        ensure!(
            current
                .status
                .as_ref()
                .and_then(|s| s.pvc_name.as_ref())
                .is_none(),
            "retained home requires explicit slot enrollment; refusing to replace its PVC"
        );
        let candidate = prepared_slot(client, namespace, &current.spec.image, identity).await?;
        // Bind the MicroVM first. Its resourceVersion prevents two slots for the same UID.
        match api.patch(&current.name_any(), &PatchParams::default(), &Patch::Merge(json!({"metadata": {"resourceVersion": current.resource_version()}, "spec": {"slot": candidate}}))).await {
            Ok(bound) => current = bound,
            Err(kube::Error::Api(error)) if error.code == 409 => current = api.get(&current.name_any()).await?,
            Err(error) => return Err(error.into()),
        }
        ensure!(
            current.uid() == microvm.uid(),
            "agent incarnation changed while claiming a slot"
        );
    }
    anyhow::bail!("slot claims changed concurrently; retry the request")
}

pub async fn prepared_slot(
    client: &Client,
    namespace: &str,
    image: &str,
    identity: &WorkloadIdentity,
) -> anyhow::Result<MicroVMSlot> {
    let leases = Api::<Lease>::namespaced(client.clone(), namespace);
    let pods = Api::<Pod>::namespaced(client.clone(), namespace);
    let list = leases
        .list(&ListParams::default().labels(SLOT_SELECTOR))
        .await?;
    let mut candidate = None;
    for lease in list.items {
        if lease
            .spec
            .as_ref()
            .and_then(|s| s.holder_identity.as_ref())
            .is_some()
        {
            continue;
        }
        let annotations = lease.annotations();
        if annotations.get(IMAGE_ANNOTATION).map(String::as_str) != Some(image) {
            continue;
        }
        let Some(pod) = pods.get_opt(&lease.name_any()).await? else {
            continue;
        };
        let Some(pod_uid) = annotations.get(POD_UID_ANNOTATION) else {
            continue;
        };
        ensure!(
            pod.uid().as_ref() == Some(pod_uid),
            "slot Pod identity changed"
        );
        if !pod
            .status
            .as_ref()
            .and_then(|s| s.conditions.as_ref())
            .is_some_and(|conditions| {
                conditions
                    .iter()
                    .any(|c| c.type_ == "Ready" && c.status == "True")
            })
        {
            continue;
        }
        let pvc_uid = annotations
            .get(HOME_UID_ANNOTATION)
            .context("slot has no home UID")?;
        let status = match async {
            SlotClient::new(identity, namespace, &pod, pvc_uid, image)?
                .status()
                .await
        }
        .await
        {
            Ok(status) => status,
            Err(error) => {
                tracing::warn!(slot = %lease.name_any(), error = %error, "prepared slot is unreachable");
                continue;
            }
        };
        if !matches!(status.state, SlotState::Vacant { .. }) {
            continue;
        }
        candidate = Some(MicroVMSlot {
            name: lease.name_any(),
            pod_uid: pod_uid.clone(),
            pvc_name: annotations
                .get(HOME_NAME_ANNOTATION)
                .context("slot has no home name")?
                .clone(),
            pvc_uid: pvc_uid.clone(),
            epoch: u64::try_from(
                lease
                    .spec
                    .as_ref()
                    .and_then(|s| s.lease_transitions)
                    .unwrap_or_default(),
            )?
            .checked_add(1)
            .context("slot epoch exhausted")?,
        });
        break;
    }
    candidate.ok_or_else(|| NoPreparedSlot.into())
}

#[derive(Debug, thiserror::Error)]
#[error("no prepared slot is available; pool capacity is full or still preparing")]
pub struct NoPreparedSlot;

async fn bind_microvm(
    client: &Client,
    namespace: &str,
    microvm: &MicroVM,
    lease: &Lease,
) -> anyhow::Result<MicroVM> {
    let claim: Claim = serde_json::from_str(
        lease
            .spec
            .as_ref()
            .and_then(|s| s.holder_identity.as_deref())
            .context("slot has no owner")?,
    )?;
    ensure!(
        claim.microvm_uid == microvm.uid().context("MicroVM has no UID")?
            && claim.microvm_id == microvm.name_any(),
        "slot is claimed by another agent"
    );
    let annotations = lease.annotations();
    let slot = binding_for(lease, &claim)?;
    ensure!(
        annotations.get(IMAGE_ANNOTATION) == Some(&microvm.spec.image),
        "slot boot image differs from its agent"
    );
    let api = Api::<MicroVM>::namespaced(client.clone(), namespace);
    let current = api.get(&microvm.name_any()).await?;
    ensure!(
        current.uid() == microvm.uid()
            && current
                .spec
                .slot
                .as_ref()
                .is_none_or(|existing| existing == &slot),
        "agent slot changed concurrently"
    );
    let bound = if current.spec.slot.is_none() {
        api.patch(&current.name_any(), &PatchParams::default(), &Patch::Merge(json!({"metadata": {"resourceVersion": current.resource_version()}, "spec": {"slot": slot}}))).await?
    } else {
        current
    };
    adopt_resources(client, namespace, &bound).await?;
    Ok(bound)
}

fn binding_for(lease: &Lease, claim: &Claim) -> anyhow::Result<MicroVMSlot> {
    claim.validate()?;
    let annotations = lease.annotations();
    Ok(MicroVMSlot {
        name: lease.name_any(),
        pod_uid: annotations
            .get(POD_UID_ANNOTATION)
            .context("missing slot Pod UID")?
            .clone(),
        pvc_name: annotations
            .get(HOME_NAME_ANNOTATION)
            .context("missing home name")?
            .clone(),
        pvc_uid: annotations
            .get(HOME_UID_ANNOTATION)
            .context("missing home UID")?
            .clone(),
        epoch: claim.epoch,
    })
}

async fn adopt_resources(
    client: &Client,
    namespace: &str,
    microvm: &MicroVM,
) -> anyhow::Result<()> {
    let slot = microvm.spec.slot.as_ref().context("missing slot")?;
    let pods = Api::<Pod>::namespaced(client.clone(), namespace);
    let pod = pods.get(&slot.name).await?;
    ensure!(
        pod.uid().as_deref() == Some(&slot.pod_uid),
        "slot Pod changed during adoption"
    );
    let owner = pod::owned_metadata(Default::default(), microvm).owner_references;
    ensure_adoptable(&pod.metadata, microvm)?;
    pods.patch(&slot.name, &PatchParams::default(), &Patch::Merge(json!({"metadata": {"resourceVersion": pod.resource_version(), "ownerReferences": owner}}))).await?;
    let homes = Api::<PersistentVolumeClaim>::namespaced(client.clone(), namespace);
    let home = homes.get(&slot.pvc_name).await?;
    ensure_adoptable(&home.metadata, microvm)?;
    pod::validate_home(&home)?;
    ensure!(
        home.uid().as_deref() == Some(&slot.pvc_uid),
        "home PVC changed during adoption"
    );
    homes.patch(&slot.pvc_name, &PatchParams::default(), &Patch::Merge(json!({"metadata": {"resourceVersion": home.resource_version(), "ownerReferences": owner,
        "annotations": {pod::PERSISTENT_BLOCK_INITIALIZATION_ANNOTATION: "complete"}}}))).await?;
    let secrets = Api::<Secret>::namespaced(client.clone(), namespace);
    let secret_name = pod::bootstrap_secret_name(&slot.name);
    let secret = secrets.get(&secret_name).await?;
    ensure_adoptable(&secret.metadata, microvm)?;
    secrets.patch(&secret_name, &PatchParams::default(), &Patch::Merge(json!({"metadata": {"resourceVersion": secret.resource_version(), "ownerReferences": owner}}))).await?;
    Ok(())
}

fn ensure_adoptable(metadata: &kube::api::ObjectMeta, microvm: &MicroVM) -> anyhow::Result<()> {
    ensure!(
        metadata
            .owner_references
            .as_ref()
            .is_none_or(|owners| owners.iter().all(|owner| owner.kind == "MicroVM"
                && Some(owner.uid.as_str()) == microvm.metadata.uid.as_deref())),
        "slot resource belongs to another owner"
    );
    Ok(())
}

async fn bound_pod(client: &Client, namespace: &str, microvm: &MicroVM) -> anyhow::Result<Pod> {
    let slot = microvm.spec.slot.as_ref().context("agent has no slot")?;
    let lease = Api::<Lease>::namespaced(client.clone(), namespace)
        .get(&slot.name)
        .await?;
    let claim: Claim = serde_json::from_str(
        lease
            .spec
            .as_ref()
            .and_then(|s| s.holder_identity.as_deref())
            .context("slot owner is missing")?,
    )?;
    ensure!(
        claim == claim_for(microvm)?,
        "slot Lease owner or epoch changed"
    );
    let pod = Api::<Pod>::namespaced(client.clone(), namespace)
        .get(&slot.name)
        .await?;
    ensure!(
        pod.uid().as_deref() == Some(&slot.pod_uid) && pod.metadata.deletion_timestamp.is_none(),
        "slot Pod is missing or replaced; retain its claim until the old VMM and storage writer are fenced"
    );
    Ok(pod)
}

async fn cleanup(context: &ControllerContext, microvm: &MicroVM) -> anyhow::Result<()> {
    context
        .authorization
        .remove(&context.namespace, &microvm.name_any())
        .await
        .context("remove workspace authorization")?;
    context.tickets.remove_agent(&microvm.name_any())?;
    metrics::global().clear_pty_sessions(&microvm.name_any());
    let client = &context.client;
    let namespace = &context.namespace;
    let api = Api::<MicroVM>::namespaced(client.clone(), namespace);
    let unclaimed = if microvm.annotations().contains_key(STOPPED_POD_ANNOTATION) {
        false
    } else if let Some(slot) = &microvm.spec.slot {
        release_unclaimed_slot(client, namespace, microvm, slot).await?
    } else {
        false
    };
    if !unclaimed && let Some(slot) = &microvm.spec.slot {
        if microvm.annotations().get(STOPPED_POD_ANNOTATION) != Some(&slot.pod_uid) {
            let pod = bound_pod(client, namespace, microvm).await?;
            let supervisor = SlotClient::new(
                &context.identity,
                namespace,
                &pod,
                &slot.pvc_uid,
                &microvm.spec.image,
            )?;
            let status = supervisor.lifecycle("stop", &claim_for(microvm)?).await?;
            ensure!(
                matches!(status.state, SlotState::Stopped { .. }),
                "VMM termination is not proven; retain owner and disks"
            );
            // Persist the receipt before deleting the only process that can prove termination.
            api.patch(
                &microvm.name_any(),
                &PatchParams::default(),
                &Patch::Merge(json!({
                    "metadata": {"resourceVersion": microvm.resource_version(),
                        "annotations": {STOPPED_POD_ANNOTATION: slot.pod_uid}}
                })),
            )
            .await?;
        }
        delete_slot_assets(client, namespace, slot, Some(microvm)).await?;
        let leases = Api::<Lease>::namespaced(client.clone(), namespace);
        if let Some(lease) = leases.get_opt(&slot.name).await? {
            let claim: Claim = serde_json::from_str(
                lease
                    .spec
                    .as_ref()
                    .and_then(|s| s.holder_identity.as_deref())
                    .context("missing deletion claim")?,
            )?;
            ensure!(
                claim == claim_for(microvm)?,
                "slot owner changed during deletion"
            );
            leases
                .delete(&slot.name, &delete_metadata(&lease.metadata)?)
                .await?;
        }
    } else if microvm.spec.slot.is_none() {
        ensure!(
            microvm
                .status
                .as_ref()
                .and_then(|s| s.pvc_name.as_ref())
                .is_none(),
            "retained home must be enrolled before owner-scoped deletion"
        );
        let leases = Api::<Lease>::namespaced(client.clone(), namespace)
            .list(&ListParams::default().labels(SLOT_SELECTOR))
            .await?;
        ensure!(
            !leases.items.iter().any(|lease| lease
                .spec
                .as_ref()
                .and_then(|s| s.holder_identity.as_ref())
                .is_some_and(|holder| serde_json::from_str::<Claim>(holder)
                    .is_ok_and(|c| Some(c.microvm_uid) == microvm.uid()))),
            "interrupted slot claim must be recovered before deleting the agent"
        );
    }
    let current = api.get(&microvm.name_any()).await?;
    ensure!(
        current.uid() == microvm.uid(),
        "agent replaced during deletion"
    );
    let finalizers: Vec<_> = current
        .finalizers()
        .iter()
        .filter(|f| f.as_str() != FINALIZER_NAME)
        .collect();
    api.patch(
        &current.name_any(),
        &PatchParams::default(),
        &Patch::Merge(json!({
            "metadata": {"resourceVersion": current.resource_version(), "finalizers": finalizers}
        })),
    )
    .await?;
    Ok(())
}

async fn release_unclaimed_slot(
    client: &Client,
    namespace: &str,
    microvm: &MicroVM,
    slot: &MicroVMSlot,
) -> anyhow::Result<bool> {
    let leases = Api::<Lease>::namespaced(client.clone(), namespace);
    let mut lease = leases.get(&slot.name).await?;
    let holder = lease
        .spec
        .as_ref()
        .and_then(|spec| spec.holder_identity.as_deref())
        .map(serde_json::from_str::<Claim>)
        .transpose()?;
    if holder.as_ref() == Some(&claim_for(microvm)?) {
        return Ok(false);
    }
    ensure!(
        microvm
            .status
            .as_ref()
            .is_none_or(|status| status.pod_uid.is_none() && status.pvc_name.is_none()),
        "active slot claim changed; retain owner and disks"
    );
    if let Some(holder) = holder {
        ensure!(
            holder.epoch > slot.epoch,
            "slot is claimed by another agent"
        );
        // A later epoch can only be claimed after this candidate was cancelled.
        return Ok(true);
    }
    ensure_asset_owner(&lease.metadata, None)?;
    let spec = lease.spec.get_or_insert_default();
    let epoch = u64::try_from(spec.lease_transitions.unwrap_or_default())?;
    ensure!(
        epoch == slot.epoch || epoch.checked_add(1) == Some(slot.epoch),
        "slot candidate epoch changed"
    );
    if epoch != slot.epoch {
        // CAS against a concurrent claim, then make its stale candidate unusable.
        spec.lease_transitions = Some(i32::try_from(slot.epoch)?);
        leases
            .replace(&slot.name, &PostParams::default(), &lease)
            .await?;
    }
    Ok(true)
}

fn delete_uid(uid: &str) -> DeleteParams {
    DeleteParams {
        preconditions: Some(Preconditions {
            uid: Some(uid.into()),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn delete_metadata(metadata: &kube::api::ObjectMeta) -> anyhow::Result<DeleteParams> {
    let mut parameters = delete_uid(metadata.uid.as_deref().context("resource has no UID")?);
    parameters
        .preconditions
        .as_mut()
        .expect("UID precondition")
        .resource_version = Some(
        metadata
            .resource_version
            .clone()
            .context("resource has no version")?,
    );
    Ok(parameters)
}

fn ensure_asset_owner(
    metadata: &kube::api::ObjectMeta,
    owner: Option<&MicroVM>,
) -> anyhow::Result<()> {
    match owner {
        Some(owner) => ensure_adoptable(metadata, owner),
        None => {
            ensure!(
                metadata.owner_references.as_ref().is_none_or(Vec::is_empty),
                "prepared slot asset was adopted; refusing retirement"
            );
            Ok(())
        }
    }
}

async fn delete_slot_assets(
    client: &Client,
    namespace: &str,
    slot: &MicroVMSlot,
    owner: Option<&MicroVM>,
) -> anyhow::Result<()> {
    let pods = Api::<Pod>::namespaced(client.clone(), namespace);
    if let Some(pod) = pods.get_opt(&slot.name).await? {
        ensure!(
            pod.uid().as_ref() == Some(&slot.pod_uid),
            "slot Pod replaced during deletion"
        );
        ensure_asset_owner(&pod.metadata, owner)?;
        if pod.metadata.deletion_timestamp.is_none() {
            pods.delete(&slot.name, &delete_metadata(&pod.metadata)?)
                .await?;
        }
        tokio::time::timeout(
            Duration::from_secs(30),
            kube::runtime::wait::await_condition(
                pods,
                &slot.name,
                kube::runtime::wait::conditions::is_deleted(&slot.pod_uid),
            ),
        )
        .await
        .context("slot Pod deletion is still pending; retain its home")??;
    }
    let homes = Api::<PersistentVolumeClaim>::namespaced(client.clone(), namespace);
    if let Some(home) = homes.get_opt(&slot.pvc_name).await? {
        ensure!(
            home.uid().as_ref() == Some(&slot.pvc_uid),
            "home replaced during deletion"
        );
        ensure_asset_owner(&home.metadata, owner)?;
        homes
            .delete(&slot.pvc_name, &delete_metadata(&home.metadata)?)
            .await?;
    }
    let secrets = Api::<Secret>::namespaced(client.clone(), namespace);
    let name = pod::bootstrap_secret_name(&slot.name);
    if let Some(secret) = secrets.get_opt(&name).await? {
        ensure_asset_owner(&secret.metadata, owner)?;
        secrets
            .delete(&name, &delete_metadata(&secret.metadata)?)
            .await?;
    }
    Ok(())
}

async fn maintain_pool(context: &ControllerContext) -> anyhow::Result<()> {
    let leases = Api::<Lease>::namespaced(context.client.clone(), &context.namespace);
    let list = leases
        .list(&ListParams::default().labels(SLOT_SELECTOR))
        .await?;
    for lease in &list.items {
        if let Err(error) = maintain_slot(context, lease).await {
            tracing::error!(slot = lease.name_any(), error = %error, "slot preparation or retirement failed");
        }
    }
    for _ in list.items.len()..SLOT_COUNT {
        let name = format!("tengri-slot-{}", uuid::Uuid::new_v4().simple());
        let lease = Lease {
            metadata: pod::metadata(&context.namespace, &name),
            spec: Some(Default::default()),
        };
        let lease = leases.create(&PostParams::default(), &lease).await?;
        prepare_slot(context, &lease).await?;
    }
    Ok(())
}

async fn maintain_slot(context: &ControllerContext, lease: &Lease) -> anyhow::Result<()> {
    if lease.annotations().contains_key(RETIRING_ANNOTATION) {
        return retire_slot(context, lease).await;
    }
    if lease
        .spec
        .as_ref()
        .and_then(|s| s.holder_identity.as_ref())
        .is_some()
    {
        return prepare_slot(context, lease).await;
    }
    if let Some(uid) = lease.annotations().get(POD_UID_ANNOTATION) {
        let pod = Api::<Pod>::namespaced(context.client.clone(), &context.namespace)
            .get(&lease.name_any())
            .await?;
        ensure!(
            pod.uid().as_ref() == Some(uid),
            "prepared slot Pod was replaced"
        );
        let image = lease
            .annotations()
            .get(IMAGE_ANNOTATION)
            .context("slot has no image")?;
        let status = SlotClient::new(
            &context.identity,
            &context.namespace,
            &pod,
            lease
                .annotations()
                .get(HOME_UID_ANNOTATION)
                .context("slot has no home UID")?,
            image,
        )?
        .status()
        .await?;
        let unused = matches!(
            status.state,
            SlotState::Vacant { .. } | SlotState::Failed { claim: None, .. }
        );
        let runtime = pod
            .spec
            .as_ref()
            .and_then(|s| s.containers.iter().find(|c| c.name == "runner"))
            .and_then(|c| c.image.as_deref());
        if unused
            && (image.as_str() != context.guest_image.as_ref()
                || runtime != Some(context.runtime_image.as_ref())
                || matches!(status.state, SlotState::Failed { .. }))
        {
            ensure_asset_owner(&pod.metadata, None)?;
            let claim = Claim {
                microvm_id: lease.name_any(),
                microvm_uid: lease.uid().context("Lease has no UID")?,
                epoch: u64::try_from(
                    lease
                        .spec
                        .as_ref()
                        .and_then(|s| s.lease_transitions)
                        .unwrap_or_default(),
                )?
                .checked_add(1)
                .context("slot epoch exhausted")?,
            };
            let mut reserved = lease.clone();
            let spec = reserved.spec.get_or_insert_default();
            spec.holder_identity = Some(serde_json::to_string(&claim)?);
            spec.lease_transitions = Some(i32::try_from(claim.epoch)?);
            reserved
                .annotations_mut()
                .insert(RETIRING_ANNOTATION.into(), claim.microvm_uid.clone());
            let reserved = Api::<Lease>::namespaced(context.client.clone(), &context.namespace)
                .replace(&lease.name_any(), &PostParams::default(), &reserved)
                .await?;
            return retire_slot(context, &reserved).await;
        }
    }
    prepare_slot(context, lease).await
}

async fn retire_slot(context: &ControllerContext, lease: &Lease) -> anyhow::Result<()> {
    let leases = Api::<Lease>::namespaced(context.client.clone(), &context.namespace);
    let claim: Claim = serde_json::from_str(
        lease
            .spec
            .as_ref()
            .and_then(|s| s.holder_identity.as_deref())
            .context("retiring slot has no claim")?,
    )?;
    ensure!(
        lease.annotations().get(RETIRING_ANNOTATION) == Some(&claim.microvm_uid)
            && lease.uid().as_ref() == Some(&claim.microvm_uid)
            && claim.microvm_id == lease.name_any(),
        "retiring slot claim changed"
    );
    let slot = binding_for(lease, &claim)?;
    if lease.annotations().get(STOPPED_POD_ANNOTATION) != Some(&slot.pod_uid) {
        let pod = Api::<Pod>::namespaced(context.client.clone(), &context.namespace)
            .get(&slot.name)
            .await?;
        ensure!(
            pod.uid().as_ref() == Some(&slot.pod_uid),
            "retiring slot Pod changed"
        );
        ensure_asset_owner(&pod.metadata, None)?;
        let status = SlotClient::new(
            &context.identity,
            &context.namespace,
            &pod,
            &slot.pvc_uid,
            lease
                .annotations()
                .get(IMAGE_ANNOTATION)
                .context("retiring slot has no image")?,
        )?
        .lifecycle("stop", &claim)
        .await?;
        ensure!(
            matches!(status.state, SlotState::Stopped { .. }),
            "prepared VMM stop is unproven"
        );
        leases.patch(&slot.name, &PatchParams::default(), &Patch::Merge(json!({
            "metadata": {"resourceVersion": lease.resource_version(), "annotations": {STOPPED_POD_ANNOTATION: slot.pod_uid}}
        }))).await?;
    }
    delete_slot_assets(&context.client, &context.namespace, &slot, None).await?;
    let current = leases.get(&slot.name).await?;
    ensure!(
        current
            .spec
            .as_ref()
            .and_then(|s| s.holder_identity.as_ref())
            == lease.spec.as_ref().and_then(|s| s.holder_identity.as_ref())
            && current.annotations().get(STOPPED_POD_ANNOTATION) == Some(&slot.pod_uid),
        "retirement claim changed"
    );
    leases
        .delete(&slot.name, &delete_metadata(&current.metadata)?)
        .await?;
    Ok(())
}

async fn prepare_slot(context: &ControllerContext, lease: &Lease) -> anyhow::Result<()> {
    if lease
        .spec
        .as_ref()
        .and_then(|s| s.holder_identity.as_ref())
        .is_some()
        && lease.annotations().contains_key(POD_UID_ANNOTATION)
    {
        return Ok(());
    }
    let client = &context.client;
    let namespace = &context.namespace;
    let name = lease.name_any();
    let homes = Api::<PersistentVolumeClaim>::namespaced(client.clone(), namespace);
    let home_name = lease
        .annotations()
        .get(HOME_NAME_ANNOTATION)
        .cloned()
        .unwrap_or_else(|| pod::pvc_name(&name));
    let home = match homes.get_opt(&home_name).await? {
        Some(home) => {
            pod::validate_home(&home)?;
            home
        }
        None => {
            ensure!(
                !lease.annotations().contains_key(HOME_NAME_ANNOTATION),
                "retained home is missing; refusing replacement"
            );
            homes
                .create(&PostParams::default(), &pod::build_pvc(namespace, &name))
                .await?
        }
    };
    ensure!(
        lease
            .annotations()
            .get(HOME_UID_ANNOTATION)
            .is_none_or(|uid| home.uid().as_ref() == Some(uid)),
        "retained home identity changed; refusing replacement"
    );
    let secrets = Api::<Secret>::namespaced(client.clone(), namespace);
    let secret_name = pod::bootstrap_secret_name(&name);
    if secrets.get_opt(&secret_name).await?.is_none() {
        secrets
            .create(&PostParams::default(), &pod::build_secret(namespace, &name))
            .await?;
    }
    let pods = Api::<Pod>::namespaced(client.clone(), namespace);
    let image = lease
        .annotations()
        .get(IMAGE_ANNOTATION)
        .map(String::as_str)
        .unwrap_or(&context.guest_image);
    let pod = match pods.get_opt(&name).await? {
        Some(pod) => pod,
        None => {
            ensure!(
                !lease.annotations().contains_key(POD_UID_ANNOTATION),
                "slot Pod was lost; retain home and require explicit fenced recovery"
            );
            pods.create(
                &PostParams::default(),
                &pod::build_slot_pod(
                    namespace,
                    &name,
                    image,
                    &context.runtime_image,
                    context.architecture,
                    &home,
                ),
            )
            .await?
        }
    };
    ensure!(
        lease
            .annotations()
            .get(POD_UID_ANNOTATION)
            .is_none_or(|uid| pod.uid().as_ref() == Some(uid)),
        "slot Pod identity changed; refusing adoption"
    );
    let mut annotations = lease.annotations().clone();
    annotations.insert(HOME_NAME_ANNOTATION.into(), home.name_any());
    annotations.insert(
        HOME_UID_ANNOTATION.into(),
        home.uid().context("home PVC has no UID")?,
    );
    annotations.insert(
        POD_UID_ANNOTATION.into(),
        pod.uid().context("slot Pod has no UID")?,
    );
    annotations.insert(IMAGE_ANNOTATION.into(), image.into());
    if &annotations != lease.annotations() {
        Api::<Lease>::namespaced(client.clone(), namespace)
            .patch(
                &name,
                &PatchParams::default(),
                &Patch::Merge(json!({"metadata": {
                    "resourceVersion": lease.resource_version(), "annotations": annotations
                }})),
            )
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{MicroVMResources, MicroVMSpec};
    use http::{Method, Request, Response};
    use kube::client::Body;
    use std::{collections::VecDeque, sync::Mutex};

    struct Exchange {
        method: Method,
        path: &'static str,
        code: u16,
        response: serde_json::Value,
        body: Option<serde_json::Value>,
    }

    fn mock(exchanges: Vec<Exchange>) -> (Client, Arc<Mutex<VecDeque<Exchange>>>) {
        let pending = Arc::new(Mutex::new(VecDeque::from(exchanges)));
        let requests = pending.clone();
        let service = tower::service_fn(move |request: Request<Body>| {
            let exchange = requests
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected Kubernetes request");
            async move {
                assert_eq!(request.method(), exchange.method);
                assert_eq!(request.uri().path(), exchange.path);
                if let Some(expected) = exchange.body {
                    let body: serde_json::Value =
                        serde_json::from_slice(&request.into_body().collect_bytes().await.unwrap())
                            .unwrap();
                    assert_eq!(body, expected);
                }
                Ok::<_, std::io::Error>(
                    Response::builder()
                        .status(exchange.code)
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(&exchange.response).unwrap()))
                        .unwrap(),
                )
            }
        });
        (Client::new(service, "tengri"), pending)
    }

    fn agent() -> MicroVM {
        let mut microvm = MicroVM::new(
            "agent-test",
            MicroVMSpec {
                display_name: "test".into(),
                owner_hash: "a".repeat(64),
                desired_state: MicroVMDesiredState::Running,
                image: "guest-image".into(),
                architecture: MicroVMArchitecture::Amd64,
                resources: MicroVMResources::default(),
                power: Default::default(),
                created_at: Utc::now().to_rfc3339(),
                idle_deadline: (Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
                slot: Some(MicroVMSlot {
                    name: "slot-test".into(),
                    pod_uid: "original-pod".into(),
                    pvc_name: "original-home".into(),
                    pvc_uid: "original-pvc".into(),
                    epoch: 2,
                }),
            },
        );
        microvm.metadata.uid = Some("original-owner".into());
        microvm.metadata.resource_version = Some("10".into());
        microvm.metadata.generation = Some(2);
        microvm.metadata.finalizers = Some(vec![FINALIZER_NAME.into()]);
        microvm
    }

    fn context(client: Client) -> ControllerContext {
        ControllerContext {
            client,
            namespace: "tengri".into(),
            tickets: TicketStore::new(
                "https://tengri.example".into(),
                "test-signing-secret".repeat(2),
            )
            .unwrap(),
            identity: WorkloadIdentity::Fixture(8080),
            authorization: crate::authz::WorkspaceAuthorization::Fixture,
            guest_image: Arc::from("guest-image"),
            runtime_image: Arc::from("runtime-image"),
            architecture: MicroVMArchitecture::Amd64,
        }
    }

    fn get(path: &'static str, response: serde_json::Value) -> Exchange {
        Exchange {
            method: Method::GET,
            path,
            code: 200,
            response,
            body: None,
        }
    }

    fn missing(path: &'static str) -> Exchange {
        Exchange {
            method: Method::GET,
            path,
            code: 404,
            response: json!({"apiVersion":"v1", "kind":"Status", "status":"Failure", "reason":"NotFound", "message":"not found", "code":404}),
            body: None,
        }
    }

    #[tokio::test]
    async fn a_deleting_agent_cannot_start_another_restore() {
        let mut microvm = agent();
        microvm.metadata.deletion_timestamp =
            Some(k8s_openapi::apimachinery::pkg::apis::meta::v1::Time(
                k8s_openapi::jiff::Timestamp::now(),
            ));
        let (client, pending) = mock(vec![]);
        let context = context(client);
        let error = converge(
            &context.client,
            &context.namespace,
            &microvm,
            &context.identity,
            &context.tickets,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("agent is terminating"));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn retained_home_cannot_be_replaced_without_explicit_enrollment() {
        let mut microvm = agent();
        microvm.spec.slot = None;
        microvm.status = Some(MicroVMStatus {
            pvc_name: Some("retained-home".into()),
            ..Default::default()
        });
        let (client, pending) = mock(vec![get(
            "/apis/coordination.k8s.io/v1/namespaces/tengri/leases",
            json!({"apiVersion":"coordination.k8s.io/v1", "kind":"LeaseList", "items":[]}),
        )]);
        let error = ensure_slot(
            &client,
            "tengri",
            &microvm,
            &WorkloadIdentity::Fixture(8080),
        )
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("retained home requires explicit slot enrollment")
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failed_authorization_removal_keeps_the_slot_and_home() {
        let (client, pending) = mock(vec![]);
        let mut context = context(client);
        let fixture = crate::authz::tests::SpiceFixture::new().await;
        context.authorization = fixture.authorization.clone();
        fixture.mode.store(4, std::sync::atomic::Ordering::SeqCst);
        let error = cleanup(&context, &agent()).await.unwrap_err();
        assert!(error.to_string().contains("remove workspace authorization"));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn deletion_before_claim_fences_the_candidate_and_keeps_prepared_assets() {
        let microvm = agent();
        let lease = json!({
            "metadata": {"name":"slot-test", "uid":"lease-uid", "resourceVersion":"20"},
            "spec": {"leaseTransitions":1}
        });
        let fenced = json!({
            "metadata": {"name":"slot-test", "uid":"lease-uid", "resourceVersion":"21"},
            "spec": {"leaseTransitions":2}
        });
        let (client, pending) = mock(vec![
            get(
                "/apis/coordination.k8s.io/v1/namespaces/tengri/leases/slot-test",
                lease,
            ),
            Exchange {
                method: Method::PUT,
                path: "/apis/coordination.k8s.io/v1/namespaces/tengri/leases/slot-test",
                code: 200,
                response: fenced,
                body: Some(json!({
                    "apiVersion":"coordination.k8s.io/v1", "kind":"Lease",
                    "metadata":{"name":"slot-test", "uid":"lease-uid", "resourceVersion":"20"},
                    "spec":{"leaseTransitions":2}
                })),
            },
            get(
                "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent-test",
                serde_json::to_value(&microvm).unwrap(),
            ),
            Exchange {
                method: Method::PATCH,
                path: "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent-test",
                code: 200,
                response: serde_json::to_value(&microvm).unwrap(),
                body: Some(json!({"metadata":{"resourceVersion":"10", "finalizers":[]}})),
            },
        ]);
        cleanup(&context(client), &microvm).await.unwrap();
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_cancelled_candidate_cannot_claim_the_vacant_slot() {
        let microvm = agent();
        let (client, pending) = mock(vec![get(
            "/apis/coordination.k8s.io/v1/namespaces/tengri/leases/slot-test",
            json!({"metadata":{"uid":"lease-uid", "resourceVersion":"21"}, "spec":{"leaseTransitions":2}}),
        )]);
        let error = ensure_slot(
            &client,
            "tengri",
            &microvm,
            &WorkloadIdentity::Fixture(8080),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("slot candidate was cancelled"));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_concurrent_claim_keeps_the_deleting_agents_finalizer() {
        let microvm = agent();
        let (client, pending) = mock(vec![
            get(
                "/apis/coordination.k8s.io/v1/namespaces/tengri/leases/slot-test",
                json!({"metadata":{"name":"slot-test", "uid":"lease-uid", "resourceVersion":"20"}, "spec":{"leaseTransitions":1}}),
            ),
            Exchange {
                method: Method::PUT,
                path: "/apis/coordination.k8s.io/v1/namespaces/tengri/leases/slot-test",
                code: 409,
                response: json!({"apiVersion":"v1", "kind":"Status", "status":"Failure", "reason":"Conflict", "message":"slot claimed concurrently", "code":409}),
                body: None,
            },
        ]);
        let error = cleanup(&context(client), &microvm).await.unwrap_err();
        assert!(error.to_string().contains("slot claimed concurrently"));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelled_deletion_retries_do_not_touch_a_later_owners_assets() {
        let microvm = agent();
        for holder in [
            None,
            Some(Claim {
                microvm_id: "next-agent".into(),
                microvm_uid: "next-owner".into(),
                epoch: 3,
            }),
        ] {
            let (client, pending) = mock(vec![
                get(
                    "/apis/coordination.k8s.io/v1/namespaces/tengri/leases/slot-test",
                    json!({"metadata":{"name":"slot-test", "uid":"lease-uid", "resourceVersion":"21"}, "spec":{
                        "leaseTransitions": if holder.is_some() {3} else {2},
                        "holderIdentity": holder.map(|claim| serde_json::to_string(&claim).unwrap())
                    }}),
                ),
                get(
                    "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent-test",
                    serde_json::to_value(&microvm).unwrap(),
                ),
                Exchange {
                    method: Method::PATCH,
                    path: "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent-test",
                    code: 200,
                    response: serde_json::to_value(&microvm).unwrap(),
                    body: Some(json!({"metadata":{"resourceVersion":"10", "finalizers":[]}})),
                },
            ]);
            cleanup(&context(client), &microvm).await.unwrap();
            assert!(pending.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn lost_pod_without_a_stop_receipt_keeps_the_home_and_finalizer() {
        let microvm = agent();
        let (client, pending) = mock(vec![
            get(
                "/apis/coordination.k8s.io/v1/namespaces/tengri/leases/slot-test",
                json!({"metadata":{"uid":"lease-uid"}, "spec":{"holderIdentity":serde_json::to_string(&claim_for(&microvm).unwrap()).unwrap()}}),
            ),
            get(
                "/apis/coordination.k8s.io/v1/namespaces/tengri/leases/slot-test",
                json!({"metadata":{"uid":"lease-uid"}, "spec":{"holderIdentity":serde_json::to_string(&claim_for(&microvm).unwrap()).unwrap()}}),
            ),
            missing("/api/v1/namespaces/tengri/pods/slot-test"),
        ]);
        let error = cleanup(&context(client), &microvm).await.unwrap_err();
        assert!(error.to_string().contains("not found"));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cleanup_does_not_delete_a_replaced_home_after_the_pod_is_gone() {
        let mut microvm = agent();
        microvm
            .annotations_mut()
            .insert(STOPPED_POD_ANNOTATION.into(), "original-pod".into());
        let (client, pending) = mock(vec![
            missing("/api/v1/namespaces/tengri/pods/slot-test"),
            get(
                "/api/v1/namespaces/tengri/persistentvolumeclaims/original-home",
                json!({"metadata":{"uid":"replacement-pvc"}}),
            ),
        ]);
        let error = cleanup(&context(client), &microvm).await.unwrap_err();
        assert!(error.to_string().contains("home replaced during deletion"));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_stop_receipt_makes_cleanup_retryable_after_all_assets_were_deleted() {
        let mut microvm = agent();
        microvm
            .annotations_mut()
            .insert(STOPPED_POD_ANNOTATION.into(), "original-pod".into());
        let (client, pending) = mock(vec![
            missing("/api/v1/namespaces/tengri/pods/slot-test"),
            missing("/api/v1/namespaces/tengri/persistentvolumeclaims/original-home"),
            missing("/api/v1/namespaces/tengri/secrets/slot-test-bootstrap"),
            missing("/apis/coordination.k8s.io/v1/namespaces/tengri/leases/slot-test"),
            get(
                "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent-test",
                serde_json::to_value(&microvm).unwrap(),
            ),
            Exchange {
                method: Method::PATCH,
                path: "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent-test",
                code: 200,
                response: serde_json::to_value(&microvm).unwrap(),
                body: Some(json!({"metadata":{"resourceVersion":"10", "finalizers":[]}})),
            },
        ]);
        cleanup(&context(client), &microvm).await.unwrap();
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unreachable_vacancy_does_not_abort_the_remaining_pool_scan() {
        let lease = |name: &str| {
            json!({
                "metadata": {"name": name, "annotations": {
                    IMAGE_ANNOTATION: "guest-image",
                    POD_UID_ANNOTATION: format!("{name}-pod"),
                    HOME_UID_ANNOTATION: format!("{name}-home"),
                    HOME_NAME_ANNOTATION: format!("{name}-pvc")
                }}, "spec": {}
            })
        };
        let (client, pending) = mock(vec![
            get(
                "/apis/coordination.k8s.io/v1/namespaces/tengri/leases",
                json!({"metadata": {}, "items": [lease("unreachable"), lease("preparing")]}),
            ),
            get(
                "/api/v1/namespaces/tengri/pods/unreachable",
                json!({"metadata":{"uid":"unreachable-pod"}, "status": {
                    "podIP":"127.0.0.1", "conditions":[{"type":"Ready", "status":"True"}]
                }}),
            ),
            get(
                "/api/v1/namespaces/tengri/pods/preparing",
                json!({"metadata":{"uid":"preparing-pod"}, "status": {
                    "conditions":[{"type":"Ready", "status":"False"}]
                }}),
            ),
        ]);
        let result = prepared_slot(
            &client,
            "tengri",
            "guest-image",
            &WorkloadIdentity::Fixture(8080),
        )
        .await;
        assert!(
            result
                .unwrap_err()
                .downcast_ref::<NoPreparedSlot>()
                .is_some()
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn persisted_failure_transitions_increment_the_counter_once() {
        let metrics = metrics::Metrics::default();
        let failures = || {
            metrics
                .render(&[], Default::default())
                .lines()
                .find_map(|line| line.strip_prefix("tengri_guest_failures_total "))
                .unwrap()
                .parse::<u64>()
                .unwrap()
        };
        let before = failures();
        metrics::global().record_guest_failure();
        let microvm = agent();
        let mut failed = microvm.clone();
        failed.status = Some(MicroVMStatus {
            phase: MicroVMPhase::Failed,
            message: Some("snapshot write failed".into()),
            ..Default::default()
        });
        let mut still_failed = failed.clone();
        still_failed.status.as_mut().unwrap().message = Some("snapshot retry failed".into());
        let patch = |response: &MicroVM| Exchange {
            method: Method::PATCH,
            path: "/apis/runtime.proompteng.ai/v1alpha1/namespaces/tengri/microvms/agent-test/status",
            code: 200,
            response: serde_json::to_value(response).unwrap(),
            body: None,
        };
        let (client, pending) = mock(vec![patch(&failed), patch(&still_failed)]);
        let updated = patch_status(
            &client,
            "tengri",
            &microvm,
            failed.status.as_ref().unwrap(),
            &metrics,
        )
        .await
        .unwrap();
        assert_eq!(failures(), before + 1);
        patch_status(
            &client,
            "tengri",
            &updated,
            still_failed.status.as_ref().unwrap(),
            &metrics,
        )
        .await
        .unwrap();
        assert_eq!(failures(), before + 1);
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unchanged_status_does_not_write_to_kubernetes() {
        let mut microvm = agent();
        let state = SlotState::Awake {
            claim: claim_for(&microvm).unwrap(),
        };
        let status = status_for(&microvm, &Pod::default(), &state);
        microvm.status = Some(status.clone());
        assert_eq!(status_for(&microvm, &Pod::default(), &state), status);
        let (client, pending) = mock(vec![]);
        assert_eq!(
            patch_status(
                &client,
                "tengri",
                &microvm,
                &status,
                &metrics::Metrics::default()
            )
            .await
            .unwrap()
            .resource_version(),
            Some("10".into())
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn preparing_and_failed_slots_cannot_claim_that_ram_was_released() {
        let microvm = agent();
        assert_eq!(
            status_for(&microvm, &Pod::default(), &SlotState::Preparing).conditions[0].reason,
            "SnapshotLifecycleInProgress"
        );
        let failed = status_for(
            &microvm,
            &Pod::default(),
            &SlotState::Failed {
                claim: Some(claim_for(&microvm).unwrap()),
                message: "disk flush failed".into(),
            },
        );
        assert_eq!(failed.message.as_deref(), Some("disk flush failed"));
        assert_eq!(failed.conditions[0].message, "disk flush failed");
        assert!(!failed.guest_ready);
    }

    #[test]
    fn retirement_refuses_assets_adopted_by_any_microvm() {
        let microvm = agent();
        let metadata = pod::owned_metadata(Default::default(), &microvm);
        assert!(ensure_asset_owner(&metadata, None).is_err());
        assert!(ensure_asset_owner(&metadata, Some(&microvm)).is_ok());
        let mut other = microvm;
        other.metadata.uid = Some("different-owner".into());
        assert!(ensure_asset_owner(&metadata, Some(&other)).is_err());
    }
}
