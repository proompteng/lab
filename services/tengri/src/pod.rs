use std::collections::BTreeMap;

use k8s_openapi::{
    api::core::v1::{
        Capabilities, Container, ContainerPort, EmptyDirVolumeSource, EnvVar, EnvVarSource,
        HTTPGetAction, PersistentVolumeClaim, PersistentVolumeClaimSpec,
        PersistentVolumeClaimVolumeSource, Pod, PodSecurityContext, PodSpec, Probe,
        ResourceRequirements, SeccompProfile, Secret, SecretKeySelector, SecurityContext,
        Toleration, TopologySpreadConstraint, Volume, VolumeDevice, VolumeMount,
        VolumeResourceRequirements,
    },
    apimachinery::pkg::{api::resource::Quantity, apis::meta::v1::LabelSelector},
};
use kube::{
    Api, Client, Error as KubeError, Resource, ResourceExt,
    api::{ObjectMeta, Patch, PatchParams},
};
use rand::distr::{Alphanumeric, SampleString};
use sha2::{Digest, Sha256};

use crate::crd::MicroVM;

pub const MANAGER_NAME: &str = "tengri.runtime.proompteng.ai";
pub const FINALIZER_NAME: &str = "runtime.proompteng.ai/finalizer";
pub const BOOTSTRAP_TOKEN_KEY: &str = "token";
pub const STORAGE_CLASS: &str = "rook-ceph-block";
pub const STORAGE_LAYOUT_ANNOTATION: &str = "runtime.proompteng.ai/storage-layout";
pub const SINGLE_MOUNT_STORAGE_LAYOUT: &str = "home-workspace-v2";
pub const PERSISTENT_BLOCK_CAPABILITY_LABEL: &str =
    "runtime.proompteng.ai/kata-fc-persistent-block";
const HOME_BLOCK_DEVICE_PATH: &str = "/dev/tengri-home";
const HOME_BLOCK_MOUNT_PATH: &str = "/home/nanoagent";
const KATA_HOME_BLOCK_ANNOTATION_PREFIX: &str = "io.katacontainers.volume.tengri-home";
const GUEST_UID: i64 = 1_000;
const MAX_DNS_LABEL_LENGTH: usize = 63;
const MAX_DNS_SUBDOMAIN_LENGTH: usize = 253;
const MAX_LABEL_VALUE_LENGTH: usize = 63;
const HASH_SUFFIX_LENGTH: usize = 16;

pub fn bootstrap_secret_name(microvm: &MicroVM) -> String {
    bounded_child_name(&microvm.name_any(), "bootstrap")
}

pub fn pvc_name(microvm: &MicroVM) -> String {
    bounded_child_name(&microvm.name_any(), "home")
}

fn bounded_child_name(parent: &str, suffix: &str) -> String {
    let candidate = format!("{parent}-{suffix}");
    if candidate.len() <= MAX_DNS_SUBDOMAIN_LENGTH
        && candidate
            .split('.')
            .all(|label| label.len() <= MAX_DNS_LABEL_LENGTH)
    {
        return candidate;
    }

    let digest = stable_digest(parent);
    let normalized = parent.replace('.', "-");
    let prefix_length = MAX_DNS_LABEL_LENGTH - suffix.len() - HASH_SUFFIX_LENGTH - 2;
    let prefix = normalized[..prefix_length].trim_end_matches('-');
    format!("{}-{}-{suffix}", prefix, &digest[..HASH_SUFFIX_LENGTH])
}

fn bounded_label_value(value: &str) -> String {
    if value.len() <= MAX_LABEL_VALUE_LENGTH {
        return value.to_owned();
    }

    let digest = stable_digest(value);
    let prefix_length = MAX_LABEL_VALUE_LENGTH - HASH_SUFFIX_LENGTH - 1;
    format!(
        "{}-{}",
        &value[..prefix_length],
        &digest[..HASH_SUFFIX_LENGTH]
    )
}

fn stable_digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub async fn ensure_bootstrap_secret(
    client: Client,
    namespace: &str,
    microvm: &MicroVM,
) -> Result<String, KubeError> {
    let name = bootstrap_secret_name(microvm);
    let secrets: Api<Secret> = Api::namespaced(client, namespace);
    if let Some(secret) = secrets.get_opt(&name).await? {
        if is_controlled_by_microvm(&secret, microvm) {
            return Ok(name);
        }
        return Err(KubeError::Api(
            kube::core::Status {
                code: 422,
                reason: "Invalid".to_owned(),
                message: format!(
                    "bootstrap Secret {name} already exists and is not controlled by MicroVM {}",
                    microvm.name_any()
                ),
                ..kube::core::Status::default()
            }
            .boxed(),
        ));
    }

    let token = Alphanumeric.sample_string(&mut rand::rng(), 64);
    let secret = Secret {
        metadata: managed_metadata(microvm, namespace, &name),
        immutable: Some(true),
        string_data: Some(BTreeMap::from([(BOOTSTRAP_TOKEN_KEY.to_owned(), token)])),
        type_: Some("Opaque".to_owned()),
        ..Secret::default()
    };
    let params = PatchParams::apply(MANAGER_NAME).force();
    secrets
        .patch(&name, &params, &Patch::Apply(&secret))
        .await?;
    Ok(name)
}

pub(crate) fn is_controlled_by_microvm<K>(resource: &K, microvm: &MicroVM) -> bool
where
    K: Resource,
{
    let Some(microvm_uid) = microvm.meta().uid.as_deref() else {
        return false;
    };
    resource
        .meta()
        .owner_references
        .as_deref()
        .unwrap_or_default()
        .iter()
        .any(|owner| owner.controller == Some(true) && owner.uid == microvm_uid)
}

pub async fn ensure_pvc(
    client: Client,
    namespace: &str,
    microvm: &MicroVM,
) -> Result<String, KubeError> {
    let name = pvc_name(microvm);
    let claims: Api<PersistentVolumeClaim> = Api::namespaced(client, namespace);
    if let Some(existing) = claims.get_opt(&name).await? {
        if !is_controlled_by_microvm(&existing, microvm) {
            return Err(KubeError::Api(
                kube::core::Status {
                    code: 422,
                    reason: "Invalid".to_owned(),
                    message: format!(
                        "persistent home claim {name} already exists and is not controlled by MicroVM {}",
                        microvm.name_any()
                    ),
                    ..kube::core::Status::default()
                }
                .boxed(),
            ));
        }

        let volume_mode = existing
            .spec
            .as_ref()
            .and_then(|spec| spec.volume_mode.as_deref())
            .unwrap_or("Filesystem");
        if volume_mode != "Block" {
            return Err(KubeError::Api(
                kube::core::Status {
                    code: 422,
                    reason: "Invalid".to_owned(),
                    message: format!(
                        "persistent home claim {name} uses unsupported volume mode {volume_mode}; delete and recreate the agent"
                    ),
                    ..kube::core::Status::default()
                }
                .boxed(),
            ));
        }
    }

    let claim = build_pvc(microvm, namespace);
    let params = PatchParams::apply(MANAGER_NAME).force();
    claims.patch(&name, &params, &Patch::Apply(&claim)).await?;
    Ok(name)
}

pub fn build_pvc(microvm: &MicroVM, namespace: &str) -> PersistentVolumeClaim {
    PersistentVolumeClaim {
        metadata: managed_metadata(microvm, namespace, &pvc_name(microvm)),
        spec: Some(PersistentVolumeClaimSpec {
            access_modes: Some(vec!["ReadWriteOnce".to_owned()]),
            resources: Some(VolumeResourceRequirements {
                requests: Some(BTreeMap::from([(
                    "storage".to_owned(),
                    Quantity(format!("{}Gi", microvm.spec.resources.workspace_gib)),
                )])),
                ..VolumeResourceRequirements::default()
            }),
            storage_class_name: Some(STORAGE_CLASS.to_owned()),
            volume_mode: Some("Block".to_owned()),
            ..PersistentVolumeClaimSpec::default()
        }),
        ..PersistentVolumeClaim::default()
    }
}

pub fn build_pod(
    microvm: &MicroVM,
    namespace: &str,
    bootstrap_secret: &str,
    home_claim: &str,
) -> Result<Pod, KubeError> {
    let name = microvm.name_any();
    let initialization_token = persistent_block_initialization_token(microvm)?;
    let mut node_selector = BTreeMap::from([(
        "runtime.proompteng.ai/kata-fc".to_owned(),
        "ready".to_owned(),
    )]);
    node_selector.insert(
        PERSISTENT_BLOCK_CAPABILITY_LABEL.to_owned(),
        "ready".to_owned(),
    );
    node_selector.insert(
        "kubernetes.io/arch".to_owned(),
        microvm.spec.architecture.kubernetes_label().to_owned(),
    );
    let annotations = BTreeMap::from([
        (
            "runtime.proompteng.ai/isolation".to_owned(),
            "firecracker".to_owned(),
        ),
        (
            STORAGE_LAYOUT_ANNOTATION.to_owned(),
            SINGLE_MOUNT_STORAGE_LAYOUT.to_owned(),
        ),
        (
            format!("{KATA_HOME_BLOCK_ANNOTATION_PREFIX}.mount_path"),
            HOME_BLOCK_MOUNT_PATH.to_owned(),
        ),
        (
            format!("{KATA_HOME_BLOCK_ANNOTATION_PREFIX}.fs_type"),
            "ext4".to_owned(),
        ),
        (
            format!("{KATA_HOME_BLOCK_ANNOTATION_PREFIX}.fs_group"),
            GUEST_UID.to_string(),
        ),
        (
            format!("{KATA_HOME_BLOCK_ANNOTATION_PREFIX}.initialization_token"),
            initialization_token,
        ),
    ]);

    Ok(Pod {
        metadata: ObjectMeta {
            annotations: Some(annotations),
            ..managed_metadata(microvm, namespace, &name)
        },
        spec: Some(PodSpec {
            automount_service_account_token: Some(false),
            containers: vec![build_container(microvm, bootstrap_secret)],
            enable_service_links: Some(false),
            node_selector: Some(node_selector),
            restart_policy: Some("Always".to_owned()),
            runtime_class_name: Some("kata-fc".to_owned()),
            security_context: Some(PodSecurityContext {
                fs_group: Some(GUEST_UID),
                fs_group_change_policy: Some("OnRootMismatch".to_owned()),
                run_as_group: Some(GUEST_UID),
                run_as_non_root: Some(true),
                run_as_user: Some(GUEST_UID),
                seccomp_profile: Some(SeccompProfile {
                    type_: "RuntimeDefault".to_owned(),
                    ..SeccompProfile::default()
                }),
                ..PodSecurityContext::default()
            }),
            termination_grace_period_seconds: Some(30),
            tolerations: Some(control_plane_tolerations()),
            topology_spread_constraints: Some(vec![TopologySpreadConstraint {
                label_selector: Some(LabelSelector {
                    match_labels: Some(BTreeMap::from([(
                        "app.kubernetes.io/name".to_owned(),
                        "nanoagent".to_owned(),
                    )])),
                    ..LabelSelector::default()
                }),
                max_skew: 1,
                topology_key: "kubernetes.io/hostname".to_owned(),
                when_unsatisfiable: "ScheduleAnyway".to_owned(),
                ..TopologySpreadConstraint::default()
            }]),
            volumes: Some(build_volumes(home_claim)),
            ..PodSpec::default()
        }),
        ..Pod::default()
    })
}

fn persistent_block_initialization_token(microvm: &MicroVM) -> Result<String, KubeError> {
    let uid = microvm.metadata.uid.as_deref().ok_or_else(|| {
        KubeError::Api(
            kube::core::Status {
                code: 422,
                reason: "Invalid".to_owned(),
                message: format!(
                    "MicroVM {} is missing the UID required to initialize persistent storage",
                    microvm.name_any()
                ),
                ..kube::core::Status::default()
            }
            .boxed(),
        )
    })?;

    Ok(format!("tengri-{}", stable_digest(uid)))
}

pub fn has_current_storage_layout(microvm: &MicroVM) -> bool {
    microvm
        .metadata
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get(STORAGE_LAYOUT_ANNOTATION))
        .map(String::as_str)
        == Some(SINGLE_MOUNT_STORAGE_LAYOUT)
}

fn build_volumes(home_claim: &str) -> Vec<Volume> {
    vec![
        Volume {
            name: "home".to_owned(),
            persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                claim_name: home_claim.to_owned(),
                read_only: Some(false),
            }),
            ..Volume::default()
        },
        Volume {
            name: "tmp".to_owned(),
            empty_dir: Some(EmptyDirVolumeSource {
                size_limit: Some(Quantity("2Gi".to_owned())),
                ..EmptyDirVolumeSource::default()
            }),
            ..Volume::default()
        },
    ]
}

pub fn managed_labels(microvm_name: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("app.kubernetes.io/name".to_owned(), "nanoagent".to_owned()),
        (
            "app.kubernetes.io/component".to_owned(),
            "microvm".to_owned(),
        ),
        (
            "app.kubernetes.io/managed-by".to_owned(),
            "tengri".to_owned(),
        ),
        ("app.kubernetes.io/part-of".to_owned(), "tengri".to_owned()),
        (
            "runtime.proompteng.ai/microvm".to_owned(),
            bounded_label_value(microvm_name),
        ),
        (
            "runtime.proompteng.ai/vmm".to_owned(),
            "firecracker".to_owned(),
        ),
    ])
}

fn managed_metadata(microvm: &MicroVM, namespace: &str, name: &str) -> ObjectMeta {
    ObjectMeta {
        name: Some(name.to_owned()),
        namespace: Some(namespace.to_owned()),
        owner_references: Some(microvm.controller_owner_ref(&()).into_iter().collect()),
        labels: Some(managed_labels(&microvm.name_any())),
        ..ObjectMeta::default()
    }
}

fn build_container(microvm: &MicroVM, bootstrap_secret: &str) -> Container {
    let resources = &microvm.spec.resources;
    let fixed = BTreeMap::from([
        (
            "cpu".to_owned(),
            Quantity(format!("{}m", resources.cpu_millis)),
        ),
        (
            "memory".to_owned(),
            Quantity(format!("{}Mi", resources.memory_mib)),
        ),
    ]);
    let mut env = vec![
        EnvVar {
            name: "MICROVM_ID".to_owned(),
            value_from: Some(EnvVarSource {
                field_ref: Some(k8s_openapi::api::core::v1::ObjectFieldSelector {
                    field_path: "metadata.uid".to_owned(),
                    ..Default::default()
                }),
                ..EnvVarSource::default()
            }),
            ..EnvVar::default()
        },
        secret_env(
            "MICROVM_BOOTSTRAP_TOKEN",
            bootstrap_secret,
            BOOTSTRAP_TOKEN_KEY,
        ),
        EnvVar {
            name: "CODEX_HOME".to_owned(),
            value: Some("/home/nanoagent/.codex".to_owned()),
            ..EnvVar::default()
        },
        EnvVar {
            name: "HOME".to_owned(),
            value: Some("/home/nanoagent".to_owned()),
            ..EnvVar::default()
        },
        EnvVar {
            name: "NANOAGENT_HOME".to_owned(),
            value: Some("/home/nanoagent".to_owned()),
            ..EnvVar::default()
        },
        EnvVar {
            name: "NANOAGENT_WORKSPACE".to_owned(),
            value: Some("/workspace".to_owned()),
            ..EnvVar::default()
        },
    ];
    env.extend([
        EnvVar {
            name: "CODEX_BINARY".to_owned(),
            value: Some("/home/nanoagent/.local/bin/codex".to_owned()),
            ..EnvVar::default()
        },
        EnvVar {
            name: "PATH".to_owned(),
            value: Some(
                "/home/nanoagent/.local/bin:/home/nanoagent/go/bin:/home/nanoagent/.cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
                    .to_owned(),
            ),
            ..EnvVar::default()
        },
        EnvVar {
            name: "XDG_CACHE_HOME".to_owned(),
            value: Some("/home/nanoagent/.cache".to_owned()),
            ..EnvVar::default()
        },
    ]);
    let volume_mounts = vec![VolumeMount {
        name: "tmp".to_owned(),
        mount_path: "/tmp".to_owned(),
        ..VolumeMount::default()
    }];

    Container {
        name: "nanoagent".to_owned(),
        image: Some(microvm.spec.image.clone()),
        image_pull_policy: Some("IfNotPresent".to_owned()),
        env: Some(env),
        ports: Some(vec![ContainerPort {
            name: Some("guest-api".to_owned()),
            container_port: 8080,
            protocol: Some("TCP".to_owned()),
            ..ContainerPort::default()
        }]),
        readiness_probe: Some(http_probe("/readyz", 5, 3)),
        startup_probe: Some(http_probe("/readyz", 5, 180)),
        liveness_probe: Some(http_probe("/livez", 15, 3)),
        resources: Some(ResourceRequirements {
            limits: Some(fixed.clone()),
            requests: Some(fixed),
            ..ResourceRequirements::default()
        }),
        security_context: Some(SecurityContext {
            allow_privilege_escalation: Some(false),
            capabilities: Some(Capabilities {
                drop: Some(vec!["ALL".to_owned()]),
                ..Capabilities::default()
            }),
            privileged: Some(false),
            read_only_root_filesystem: Some(true),
            run_as_non_root: Some(true),
            run_as_group: Some(GUEST_UID),
            run_as_user: Some(GUEST_UID),
            seccomp_profile: Some(SeccompProfile {
                type_: "RuntimeDefault".to_owned(),
                ..SeccompProfile::default()
            }),
            ..SecurityContext::default()
        }),
        volume_mounts: Some(volume_mounts),
        volume_devices: Some(vec![VolumeDevice {
            name: "home".to_owned(),
            device_path: HOME_BLOCK_DEVICE_PATH.to_owned(),
        }]),
        working_dir: Some("/home/nanoagent".to_owned()),
        ..Container::default()
    }
}

fn secret_env(name: &str, secret_name: &str, key: &str) -> EnvVar {
    EnvVar {
        name: name.to_owned(),
        value_from: Some(EnvVarSource {
            secret_key_ref: Some(SecretKeySelector {
                name: secret_name.to_owned(),
                key: key.to_owned(),
                optional: Some(false),
            }),
            ..EnvVarSource::default()
        }),
        ..EnvVar::default()
    }
}

fn control_plane_tolerations() -> Vec<Toleration> {
    [
        "node-role.kubernetes.io/control-plane",
        "node-role.kubernetes.io/master",
    ]
    .into_iter()
    .map(|key| Toleration {
        effect: Some("NoSchedule".to_owned()),
        key: Some(key.to_owned()),
        operator: Some("Exists".to_owned()),
        ..Toleration::default()
    })
    .collect()
}

fn http_probe(path: &str, period_seconds: i32, failure_threshold: i32) -> Probe {
    Probe {
        http_get: Some(HTTPGetAction {
            path: Some(path.to_owned()),
            port: k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(
                "guest-api".to_owned(),
            ),
            scheme: Some("HTTP".to_owned()),
            ..HTTPGetAction::default()
        }),
        period_seconds: Some(period_seconds),
        failure_threshold: Some(failure_threshold),
        timeout_seconds: Some(2),
        ..Probe::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{MicroVMArchitecture, MicroVMDesiredState, MicroVMResources, MicroVMSpec};
    use http::{Request, Response, StatusCode};
    use kube::client::Body as KubeBody;

    fn test_microvm() -> MicroVM {
        let mut microvm = MicroVM::new(
            "agent-1234",
            MicroVMSpec {
                display_name: "Tengri".to_owned(),
                owner_hash: "owner".to_owned(),
                desired_state: MicroVMDesiredState::Running,
                image: format!("registry.example/nanoagent@sha256:{}", "a".repeat(64)),
                architecture: MicroVMArchitecture::Arm64,
                resources: MicroVMResources::default(),
                created_at: "2026-08-26T00:00:00Z".to_owned(),
                idle_deadline: "2026-08-26T01:00:00Z".to_owned(),
                expires_at: "2026-08-26T04:00:00Z".to_owned(),
            },
        );
        microvm.metadata.uid = Some("microvm-uid".to_owned());
        microvm.metadata.annotations = Some(BTreeMap::from([(
            STORAGE_LAYOUT_ANNOTATION.to_owned(),
            SINGLE_MOUNT_STORAGE_LAYOUT.to_owned(),
        )]));
        microvm
    }

    #[tokio::test]
    async fn rejects_an_existing_bootstrap_secret_owned_by_another_resource() {
        let microvm = test_microvm();
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let ensure =
            tokio::spawn(async move { ensure_bootstrap_secret(client, "tengri", &microvm).await });

        let (request, response) = handle.next_request().await.expect("Secret lookup");
        assert_eq!(request.method(), http::Method::GET);
        assert_eq!(
            request.uri().path(),
            "/api/v1/namespaces/tengri/secrets/agent-1234-bootstrap"
        );
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    br#"{"apiVersion":"v1","kind":"Secret","metadata":{"name":"agent-1234-bootstrap","namespace":"tengri","uid":"secret-uid","ownerReferences":[{"apiVersion":"v1","kind":"ConfigMap","name":"foreign","uid":"foreign-uid","controller":true}]}}"#
                        .to_vec(),
                ))
                .expect("foreign Secret response"),
        );

        let error = ensure
            .await
            .expect("Secret ensure task")
            .expect_err("foreign Secret must be rejected");
        match error {
            KubeError::Api(response) => {
                assert_eq!(response.code, 422);
                assert_eq!(response.reason, "Invalid");
                assert!(response.message.contains("not controlled by MicroVM"));
            }
            other => panic!("unexpected Secret collision error: {other}"),
        }
        if let Ok(Some(_)) =
            tokio::time::timeout(std::time::Duration::from_millis(25), handle.next_request()).await
        {
            panic!("foreign Secret must not be patched");
        }
    }

    #[tokio::test]
    async fn rejects_a_legacy_filesystem_claim_instead_of_mutating_it() {
        let microvm = test_microvm();
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let ensure = tokio::spawn(async move { ensure_pvc(client, "tengri", &microvm).await });

        let (request, response) = handle.next_request().await.expect("PVC lookup");
        assert_eq!(request.method(), http::Method::GET);
        assert_eq!(
            request.uri().path(),
            "/api/v1/namespaces/tengri/persistentvolumeclaims/agent-1234-home"
        );
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    br#"{"apiVersion":"v1","kind":"PersistentVolumeClaim","metadata":{"name":"agent-1234-home","namespace":"tengri","uid":"claim-uid","ownerReferences":[{"apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM","name":"agent-1234","uid":"microvm-uid","controller":true}]},"spec":{"accessModes":["ReadWriteOnce"],"resources":{"requests":{"storage":"16Gi"}},"storageClassName":"rook-ceph-block","volumeMode":"Filesystem"}}"#
                        .to_vec(),
                ))
                .expect("filesystem PVC response"),
        );

        let error = ensure
            .await
            .expect("PVC ensure task")
            .expect_err("legacy filesystem PVC must be rejected");
        match error {
            KubeError::Api(response) => {
                assert_eq!(response.code, 422);
                assert!(
                    response
                        .message
                        .contains("unsupported volume mode Filesystem")
                );
                assert!(response.message.contains("delete and recreate the agent"));
            }
            other => panic!("unexpected legacy PVC error: {other}"),
        }
        if let Ok(Some(_)) =
            tokio::time::timeout(std::time::Duration::from_millis(25), handle.next_request()).await
        {
            panic!("legacy filesystem PVC must not be patched");
        }
    }

    #[test]
    fn pod_is_guaranteed_unprivileged_and_firecracker_backed() {
        let microvm = test_microvm();
        let pod =
            build_pod(&microvm, "tengri", "agent-bootstrap", "agent-home").expect("pod projection");
        let annotations = pod.metadata.annotations.as_ref().expect("annotations");
        assert_eq!(
            annotations
                .get(STORAGE_LAYOUT_ANNOTATION)
                .map(String::as_str),
            Some(SINGLE_MOUNT_STORAGE_LAYOUT),
        );
        assert_eq!(
            annotations
                .get(&format!("{KATA_HOME_BLOCK_ANNOTATION_PREFIX}.mount_path"))
                .map(String::as_str),
            Some(HOME_BLOCK_MOUNT_PATH),
        );
        assert_eq!(
            annotations
                .get(&format!("{KATA_HOME_BLOCK_ANNOTATION_PREFIX}.fs_type"))
                .map(String::as_str),
            Some("ext4"),
        );
        assert_eq!(
            annotations
                .get(&format!("{KATA_HOME_BLOCK_ANNOTATION_PREFIX}.fs_group"))
                .map(String::as_str),
            Some("1000"),
        );
        assert_eq!(
            annotations
                .get(&format!(
                    "{KATA_HOME_BLOCK_ANNOTATION_PREFIX}.initialization_token"
                ))
                .map(String::as_str),
            Some(
                persistent_block_initialization_token(&microvm)
                    .unwrap()
                    .as_str()
            ),
        );
        let spec = pod.spec.expect("pod spec");
        assert_eq!(spec.runtime_class_name.as_deref(), Some("kata-fc"));
        assert_eq!(spec.automount_service_account_token, Some(false));
        assert_eq!(
            spec.node_selector
                .as_ref()
                .and_then(|labels| labels.get("kubernetes.io/arch"))
                .map(String::as_str),
            Some("arm64")
        );
        assert_eq!(
            spec.node_selector
                .as_ref()
                .and_then(|labels| labels.get(PERSISTENT_BLOCK_CAPABILITY_LABEL))
                .map(String::as_str),
            Some("ready")
        );
        assert!(
            spec.volumes
                .as_ref()
                .is_some_and(|volumes| volumes.iter().any(|volume| volume
                    .persistent_volume_claim
                    .as_ref()
                    .is_some_and(|claim| claim.claim_name == "agent-home")))
        );
        let container = &spec.containers[0];
        assert_eq!(container.working_dir.as_deref(), Some("/home/nanoagent"));
        let resources = container.resources.as_ref().expect("resources");
        assert_eq!(resources.requests, resources.limits);
        let security = container.security_context.as_ref().expect("security");
        assert_eq!(security.allow_privilege_escalation, Some(false));
        assert_eq!(security.privileged, Some(false));
        assert_eq!(security.read_only_root_filesystem, Some(true));
        assert!(
            container
                .env
                .as_ref()
                .is_some_and(|env| env.iter().all(|value| value.name != "OPENAI_API_KEY"))
        );
        let env = container.env.as_ref().expect("environment");
        for (name, value) in [
            ("CODEX_BINARY", "/home/nanoagent/.local/bin/codex"),
            ("CODEX_HOME", "/home/nanoagent/.codex"),
            ("HOME", "/home/nanoagent"),
            ("NANOAGENT_HOME", "/home/nanoagent"),
            ("NANOAGENT_WORKSPACE", "/workspace"),
            (
                "PATH",
                "/home/nanoagent/.local/bin:/home/nanoagent/go/bin:/home/nanoagent/.cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            ),
            ("XDG_CACHE_HOME", "/home/nanoagent/.cache"),
        ] {
            assert!(
                env.iter()
                    .any(|entry| { entry.name == name && entry.value.as_deref() == Some(value) })
            );
        }
        assert!(
            container
                .volume_mounts
                .as_ref()
                .expect("volume mounts")
                .iter()
                .all(|mount| mount.name != "home")
        );
        let home_devices = container
            .volume_devices
            .as_ref()
            .expect("volume devices")
            .iter()
            .filter(|device| device.name == "home")
            .collect::<Vec<_>>();
        assert_eq!(home_devices.len(), 1);
        assert_eq!(home_devices[0].device_path, HOME_BLOCK_DEVICE_PATH);
        let tmp_mounts = container
            .volume_mounts
            .as_ref()
            .expect("volume mounts")
            .iter()
            .filter(|mount| mount.name == "tmp")
            .collect::<Vec<_>>();
        assert_eq!(tmp_mounts.len(), 1);
        assert_eq!(tmp_mounts[0].mount_path, "/tmp");
        assert!(spec.init_containers.is_none());
        let volumes = spec.volumes.as_ref().expect("volumes");
        assert_eq!(volumes.len(), 2);
    }

    #[test]
    fn stale_or_missing_storage_layouts_are_rejected_instead_of_falling_back() {
        let mut microvm = test_microvm();
        assert!(has_current_storage_layout(&microvm));

        microvm.metadata.annotations = Some(BTreeMap::from([(
            STORAGE_LAYOUT_ANNOTATION.to_owned(),
            "home-workspace-v1".to_owned(),
        )]));
        assert!(!has_current_storage_layout(&microvm));

        microvm.metadata.annotations = None;
        assert!(!has_current_storage_layout(&microvm));
    }

    #[test]
    fn pod_probes_match_the_published_nanoagent_lifecycle_api() {
        fn probe_path(probe: &Probe) -> Option<&str> {
            probe
                .http_get
                .as_ref()
                .and_then(|request| request.path.as_deref())
        }

        let pod = build_pod(&test_microvm(), "tengri", "agent-bootstrap", "agent-home")
            .expect("pod projection");
        let container = &pod.spec.expect("pod spec").containers[0];

        assert_eq!(
            probe_path(container.readiness_probe.as_ref().expect("readiness probe")),
            Some("/readyz"),
        );
        assert_eq!(
            probe_path(container.startup_probe.as_ref().expect("startup probe")),
            Some("/readyz"),
        );
        let startup_probe = container.startup_probe.as_ref().expect("startup probe");
        assert_eq!(startup_probe.period_seconds, Some(5));
        assert_eq!(startup_probe.failure_threshold, Some(180));
        assert_eq!(
            startup_probe.period_seconds.unwrap() * startup_probe.failure_threshold.unwrap(),
            15 * 60,
        );
        assert_eq!(
            probe_path(container.liveness_probe.as_ref().expect("liveness probe")),
            Some("/livez"),
        );
    }

    #[test]
    fn pvc_uses_rook_ceph_block_and_fixed_capacity() {
        let claim = build_pvc(&test_microvm(), "tengri");
        let spec = claim.spec.expect("pvc spec");
        assert_eq!(spec.storage_class_name.as_deref(), Some(STORAGE_CLASS));
        assert_eq!(spec.volume_mode.as_deref(), Some("Block"));
        assert_eq!(
            spec.resources
                .and_then(|value| value.requests)
                .and_then(|values| values.get("storage").cloned()),
            Some(Quantity("16Gi".to_owned()))
        );
    }

    #[test]
    fn pod_projection_rejects_a_microvm_without_a_uid() {
        let mut microvm = test_microvm();
        microvm.metadata.uid = None;

        let error = build_pod(&microvm, "tengri", "agent-bootstrap", "agent-home")
            .expect_err("UID-less MicroVM must be rejected");
        match error {
            KubeError::Api(response) => {
                assert_eq!(response.code, 422);
                assert!(response.message.contains("missing the UID"));
            }
            other => panic!("unexpected missing UID error: {other}"),
        }
    }

    #[test]
    fn derived_names_and_labels_are_bounded_and_collision_resistant() {
        let long_name_a = format!("agent-{}a", "x".repeat(246));
        let long_name_b = format!("agent-{}b", "x".repeat(246));
        assert_eq!(long_name_a.len(), MAX_DNS_SUBDOMAIN_LENGTH);

        let mut microvm_a = test_microvm();
        microvm_a.metadata.name = Some(long_name_a.clone());
        let mut microvm_b = test_microvm();
        microvm_b.metadata.name = Some(long_name_b.clone());

        let secret_a = bootstrap_secret_name(&microvm_a);
        let secret_b = bootstrap_secret_name(&microvm_b);
        let pvc_a = pvc_name(&microvm_a);
        assert_eq!(secret_a.len(), MAX_DNS_LABEL_LENGTH);
        assert_eq!(pvc_a.len(), MAX_DNS_LABEL_LENGTH);
        assert_ne!(secret_a, secret_b);

        let label_a = managed_labels(&long_name_a)
            .remove("runtime.proompteng.ai/microvm")
            .expect("microVM label");
        let label_b = managed_labels(&long_name_b)
            .remove("runtime.proompteng.ai/microvm")
            .expect("microVM label");
        assert_eq!(label_a.len(), MAX_LABEL_VALUE_LENGTH);
        assert_ne!(label_a, label_b);

        let dotted_name = [
            "a".repeat(50),
            "b".repeat(50),
            "c".repeat(63),
            "d".repeat(63),
            "e".repeat(14),
        ]
        .join(".");
        let mut dotted_microvm = test_microvm();
        dotted_microvm.metadata.name = Some(dotted_name);
        let dotted_secret = bootstrap_secret_name(&dotted_microvm);
        assert!(dotted_secret.len() <= MAX_DNS_SUBDOMAIN_LENGTH);
        assert!(
            dotted_secret
                .split('.')
                .all(|label| label.len() <= MAX_DNS_LABEL_LENGTH)
        );
    }
}
