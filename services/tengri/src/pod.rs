use std::collections::BTreeMap;

use k8s_openapi::{
    api::core::v1::{PersistentVolumeClaim, Pod, Secret},
    apimachinery::pkg::apis::meta::v1::OwnerReference,
};
use kube::{ResourceExt, api::ObjectMeta};
use rand::distr::{Alphanumeric, SampleString};
use serde_json::json;

use crate::crd::{MicroVM, MicroVMArchitecture};

pub const FINALIZER_NAME: &str = "runtime.proompteng.ai/finalizer";
pub const STORAGE_LAYOUT_ANNOTATION: &str = "runtime.proompteng.ai/storage-layout";
pub const SINGLE_MOUNT_STORAGE_LAYOUT: &str = "home-workspace-v2";
pub const STORAGE_CLASS: &str = "rook-ceph-block";
pub const PERSISTENT_BLOCK_INITIALIZATION_ANNOTATION: &str =
    "runtime.proompteng.ai/persistent-block-initialization";
pub const SLOT_SELECTOR: &str = "app.kubernetes.io/name=tengri-slot";
pub const HOME_NAME_ANNOTATION: &str = "runtime.proompteng.ai/home-name";
pub const HOME_UID_ANNOTATION: &str = "runtime.proompteng.ai/home-uid";
pub const POD_UID_ANNOTATION: &str = "runtime.proompteng.ai/pod-uid";
pub const IMAGE_ANNOTATION: &str = "runtime.proompteng.ai/image";

pub fn metadata(namespace: &str, name: &str) -> ObjectMeta {
    ObjectMeta {
        name: Some(name.into()),
        namespace: Some(namespace.into()),
        labels: Some(BTreeMap::from([
            ("app.kubernetes.io/name".into(), "tengri-slot".into()),
            ("app.kubernetes.io/part-of".into(), "tengri".into()),
        ])),
        ..Default::default()
    }
}

pub fn bootstrap_secret_name(slot: &str) -> String {
    format!("{slot}-bootstrap")
}
pub fn pvc_name(slot: &str) -> String {
    format!("{slot}-home")
}

pub fn build_secret(namespace: &str, slot: &str) -> Secret {
    Secret {
        metadata: metadata(namespace, &bootstrap_secret_name(slot)),
        immutable: Some(true),
        string_data: Some(BTreeMap::from([(
            "token".into(),
            Alphanumeric.sample_string(&mut rand::rng(), 64),
        )])),
        type_: Some("Opaque".into()),
        ..Default::default()
    }
}

pub fn build_pvc(namespace: &str, slot: &str) -> PersistentVolumeClaim {
    let mut metadata = metadata(namespace, &pvc_name(slot));
    metadata.annotations = Some(BTreeMap::from([(
        PERSISTENT_BLOCK_INITIALIZATION_ANNOTATION.into(),
        "pending".into(),
    )]));
    serde_json::from_value(json!({"metadata": metadata, "spec": {
        "accessModes": ["ReadWriteOnce"], "storageClassName": STORAGE_CLASS, "volumeMode": "Block",
        "resources": {"requests": {"storage": "16Gi"}}
    }}))
    .expect("valid fixed home PVC")
}

pub fn validate_home(claim: &PersistentVolumeClaim) -> anyhow::Result<()> {
    use anyhow::{Context, ensure};
    let spec = claim.spec.as_ref().context("home PVC has no spec")?;
    ensure!(
        spec.storage_class_name.as_deref() == Some(STORAGE_CLASS)
            && spec.volume_mode.as_deref() == Some("Block")
            && spec
                .access_modes
                .as_ref()
                .is_some_and(|m| m == &["ReadWriteOnce"])
            && spec
                .resources
                .as_ref()
                .and_then(|r| r.requests.as_ref())
                .and_then(|r| r.get("storage"))
                .is_some_and(|q| q.0 == "16Gi"),
        "home PVC violates the private 16 GiB raw-block contract"
    );
    Ok(())
}

pub fn owned_metadata(mut metadata: ObjectMeta, microvm: &MicroVM) -> ObjectMeta {
    metadata.owner_references = Some(vec![OwnerReference {
        api_version: "runtime.proompteng.ai/v1alpha1".into(),
        kind: "MicroVM".into(),
        name: microvm.name_any(),
        uid: microvm.uid().expect("persisted MicroVM UID"),
        controller: Some(true),
        block_owner_deletion: Some(true),
    }]);
    metadata
}

pub fn build_slot_pod(
    namespace: &str,
    name: &str,
    guest_image: &str,
    runtime_image: &str,
    architecture: MicroVMArchitecture,
    home: &PersistentVolumeClaim,
) -> Pod {
    let mut metadata = metadata(namespace, name);
    metadata
        .labels
        .as_mut()
        .unwrap()
        .insert("spiffe.io/spire-managed-identity".into(), "true".into());
    metadata.annotations = Some(BTreeMap::from([(
        "sidecar.istio.io/inject".into(),
        "false".into(),
    )]));
    let pvc_uid = home.uid().expect("persisted home PVC UID");
    let initialized = home
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get(PERSISTENT_BLOCK_INITIALIZATION_ANNOTATION))
        .is_some_and(|value| value == "complete");
    let env = json!([
        {"name": "TENGRI_NAMESPACE", "valueFrom": {"fieldRef": {"fieldPath": "metadata.namespace"}}},
        {"name": "TENGRI_POD_UID", "valueFrom": {"fieldRef": {"fieldPath": "metadata.uid"}}},
        {"name": "TENGRI_PVC_UID", "value": pvc_uid},
        {"name": "TENGRI_GUEST_IMAGE", "value": guest_image},
        {"name": "TENGRI_INITIALIZE_HOME", "value": if initialized {"false"} else {"true"}}
    ]);
    let restricted = json!({"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true,
        "privileged": false, "runAsNonRoot": true, "runAsUser": 65532, "runAsGroup": 65532,
        "capabilities": {"drop": ["ALL"]}, "seccompProfile": {"type": "RuntimeDefault"}});
    let mut network = restricted.clone();
    network["runAsNonRoot"] = json!(false);
    network["runAsUser"] = json!(0);
    network["capabilities"]["add"] = json!(["NET_ADMIN"]);
    let mut runner = network.clone();
    runner["capabilities"]["add"] = json!(["MKNOD", "SETUID", "SETGID"]);
    serde_json::from_value(json!({"metadata": metadata, "spec": {
        "serviceAccountName": "tengri-slot", "automountServiceAccountToken": false,
        "enableServiceLinks": false, "terminationGracePeriodSeconds": 30,
        "securityContext": {"fsGroup": 65532, "seccompProfile": {"type": "RuntimeDefault"}},
        "nodeSelector": {"kubernetes.io/arch": architecture.kubernetes_label()},
        "initContainers": [
            {"name": "guest-artifacts", "image": guest_image, "command": ["/bin/cp", "/guest/rootfs.ext4", "/guest/vmlinux", "/artifacts/"],
                "securityContext": restricted, "resources": {"requests": {"cpu": "100m", "memory": "64Mi"}, "limits": {"cpu": "1", "memory": "2Gi"}},
                "volumeMounts": [{"name": "artifacts", "mountPath": "/artifacts"}]},
            {"name": "tap", "image": runtime_image, "command": ["/usr/local/bin/tengri-network"],
                "securityContext": network, "resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"cpu": "100m", "memory": "64Mi", "runtime.proompteng.ai/kvm-tun": "1"}}}
        ],
        "containers": [
            {"name": "supervisor", "image": runtime_image, "args": ["slot-supervisor"],
                "env": [env[0], env[1], {"name": "SPIFFE_ENDPOINT_SOCKET", "value": "unix:///spiffe-workload-api/spire-agent.sock"},
                    {"name": "SPIFFE_TRUST_DOMAIN", "value": "proompteng.ai"}],
                "ports": [{"name": "guest-api", "containerPort": 8443}, {"name": "health", "containerPort": 8080}],
                "securityContext": restricted,
                "resources": {"requests": {"cpu": "50m", "memory": "64Mi"}, "limits": {"cpu": "250m", "memory": "128Mi"}},
                "readinessProbe": {"httpGet": {"path": "/readyz", "port": "health"}, "periodSeconds": 1, "timeoutSeconds": 1, "failureThreshold": 3},
                "livenessProbe": {"httpGet": {"path": "/livez", "port": "health"}, "periodSeconds": 5, "timeoutSeconds": 1, "failureThreshold": 3},
                "volumeMounts": [{"name": "sockets", "mountPath": "/run/tengri"},
                    {"name": "workload-api", "mountPath": "/spiffe-workload-api", "readOnly": true}]},
            {"name": "runner", "image": runtime_image, "args": ["slot-runner"], "env": env,
                "securityContext": runner,
                "resources": {"requests": {"cpu": "4", "memory": "9Gi", "ephemeral-storage": "26Gi"},
                    "limits": {"cpu": "4", "memory": "9Gi", "ephemeral-storage": "26Gi", "runtime.proompteng.ai/kvm-tun": "1"}},
                "volumeDevices": [{"name": "home", "devicePath": "/dev/tengri-home"}],
                "volumeMounts": [{"name": "snapshots", "mountPath": "/var/lib/tengri"}, {"name": "sockets", "mountPath": "/run/tengri"},
                    {"name": "artifacts", "mountPath": "/guest", "readOnly": true}, {"name": "bootstrap", "mountPath": "/run/guest-bootstrap", "readOnly": true}]}
        ],
        "volumes": [
            {"name": "home", "persistentVolumeClaim": {"claimName": home.name_any()}},
            {"name": "snapshots", "emptyDir": {"sizeLimit": "24Gi"}}, {"name": "sockets", "emptyDir": {"sizeLimit": "1Mi"}},
            {"name": "artifacts", "emptyDir": {"sizeLimit": "2Gi"}},
            {"name": "bootstrap", "secret": {"secretName": bootstrap_secret_name(name), "defaultMode": 288}},
            {"name": "workload-api", "csi": {"driver": "csi.spiffe.io", "readOnly": true}}
        ]
    }})).expect("valid fixed slot Pod")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_memory_covers_the_guest_and_artifact_copy() {
        fn bytes(quantity: &str) -> u64 {
            for (suffix, multiplier) in [("Gi", 1_u64 << 30), ("Mi", 1_u64 << 20)] {
                if let Some(number) = quantity.strip_suffix(suffix) {
                    return number.parse::<u64>().unwrap() * multiplier;
                }
            }
            panic!("unsupported memory quantity");
        }
        let mut home = build_pvc("tengri", "test-slot");
        home.metadata.uid = Some("home-uid".into());
        let spec = build_slot_pod(
            "tengri",
            "test-slot",
            "guest-image",
            "runtime-image",
            MicroVMArchitecture::Amd64,
            &home,
        )
        .spec
        .unwrap();
        let runner = spec.containers.iter().find(|c| c.name == "runner").unwrap();
        let resources = runner.resources.as_ref().unwrap();
        let limit = bytes(&resources.limits.as_ref().unwrap()["memory"].0);
        assert_eq!(
            limit,
            bytes(&resources.requests.as_ref().unwrap()["memory"].0)
        );
        assert!(limit >= (u64::from(crate::crd::MEMORY_MIB) << 20) + (1 << 30));
        let copier = &spec.init_containers.as_ref().unwrap()[0];
        let copy_memory = &copier.resources.as_ref().unwrap().limits.as_ref().unwrap()["memory"].0;
        let artifacts = spec
            .volumes
            .as_ref()
            .unwrap()
            .iter()
            .find(|v| v.name == "artifacts")
            .unwrap();
        let artifact_capacity = &artifacts
            .empty_dir
            .as_ref()
            .unwrap()
            .size_limit
            .as_ref()
            .unwrap()
            .0;
        assert!(bytes(copy_memory) >= bytes(artifact_capacity));
    }

    #[test]
    fn slot_keeps_host_credentials_and_snapshot_disks_separate() {
        let mut home = build_pvc("tengri", "test-slot");
        home.metadata.uid = Some("home-uid".into());
        let pod = build_slot_pod(
            "tengri",
            "test-slot",
            "guest@sha256:aaa",
            "runtime@sha256:bbb",
            MicroVMArchitecture::Amd64,
            &home,
        );
        let spec = pod.spec.unwrap();
        assert!(spec.runtime_class_name.is_none());
        assert_eq!(spec.automount_service_account_token, Some(false));
        assert!(
            spec.host_network != Some(true)
                && spec.host_pid != Some(true)
                && spec.share_process_namespace != Some(true)
        );
        let supervisor = &spec.containers[0];
        let runner = &spec.containers[1];
        assert!(
            !supervisor
                .volume_mounts
                .as_ref()
                .unwrap()
                .iter()
                .any(|m| m.name == "snapshots" || m.name == "home")
        );
        assert!(
            !runner
                .volume_mounts
                .as_ref()
                .unwrap()
                .iter()
                .any(|m| m.name == "workload-api")
        );
        assert_eq!(
            runner
                .security_context
                .as_ref()
                .unwrap()
                .capabilities
                .as_ref()
                .unwrap()
                .add,
            Some(vec!["MKNOD".into(), "SETUID".into(), "SETGID".into()])
        );
        assert_eq!(
            runner.volume_devices.as_ref().unwrap()[0].device_path,
            "/dev/tengri-home"
        );
    }
}
