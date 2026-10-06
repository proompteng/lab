//! A private image-built tool disk keeps the guest root within the installed 512 MiB limit.
//! The disk is disposable; the separate home PVC is never opened or reformatted here.
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::FileTypeExt,
};

use anyhow::{Context, bail, ensure};
use k8s_openapi::{
    api::core::v1::{
        Capabilities, Container, PersistentVolumeClaim, PersistentVolumeClaimSpec,
        PersistentVolumeClaimVolumeSource, Pod, PodSpec, ResourceRequirements, SeccompProfile,
        SecurityContext, Volume, VolumeDevice, VolumeResourceRequirements,
    },
    apimachinery::pkg::{api::resource::Quantity, apis::meta::v1::OwnerReference},
};
use kube::{
    Api, Client, Resource, ResourceExt,
    api::{DeleteParams, ListParams, ObjectMeta, Patch, PatchParams, PostParams, Preconditions},
};
use sha2::{Digest, Sha256};

use crate::{
    crd::MicroVM,
    pod::{STORAGE_CLASS, is_controlled_by_microvm},
};

const IMAGE: &str = "runtime.proompteng.ai/tool-seed-image";
const COMPLETE: &str = "runtime.proompteng.ai/tool-seed-complete";
const COMPONENT: &str = "app.kubernetes.io/component";
const ROLE: &str = "tool-seeds";
const DEVICE: &str = "/dev/tengri-tools";
const SEED_BYTES: u64 = 1 << 30;
const BOOT_BYTES: usize = 1024;
const IMAGE_FILE: &str = "/usr/share/tengri/nanoagent-seeds.ext4";

fn reject(message: impl Into<String>) -> kube::Error {
    kube::Error::Api(
        kube::core::Status {
            code: 422,
            reason: "ToolSeedsRejected".into(),
            message: message.into(),
            ..Default::default()
        }
        .boxed(),
    )
}

pub fn claim_name(microvm: &MicroVM) -> String {
    crate::pod::bounded_child_name(&microvm.name_any(), "tools")
}

fn initializer_name(uid: &str) -> String {
    format!(
        "tools-init-{}",
        &format!("{:x}", Sha256::digest(uid.as_bytes()))[..40]
    )
}

fn annotation<'a>(metadata: &'a ObjectMeta, key: &str) -> Option<&'a str> {
    metadata.annotations.as_ref()?.get(key).map(String::as_str)
}

fn metadata(name: &str, namespace: &str, image: &str) -> ObjectMeta {
    ObjectMeta {
        name: Some(name.into()),
        namespace: Some(namespace.into()),
        labels: Some(BTreeMap::from([
            ("app.kubernetes.io/name".into(), "tengri".into()),
            (COMPONENT.into(), ROLE.into()),
        ])),
        annotations: Some(BTreeMap::from([(IMAGE.into(), image.into())])),
        ..Default::default()
    }
}

fn disk_spec() -> PersistentVolumeClaimSpec {
    PersistentVolumeClaimSpec {
        access_modes: Some(vec!["ReadWriteOnce".into()]),
        storage_class_name: Some(STORAGE_CLASS.into()),
        volume_mode: Some("Block".into()),
        resources: Some(VolumeResourceRequirements {
            requests: Some(BTreeMap::from([("storage".into(), Quantity("1Gi".into()))])),
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn validate_disk(claim: &PersistentVolumeClaim, microvm: &MicroVM) -> Result<(), kube::Error> {
    let expected = disk_spec();
    let valid = claim.spec.as_ref().is_some_and(|s| {
        s.access_modes == expected.access_modes
            && s.storage_class_name == expected.storage_class_name
            && s.volume_mode == expected.volume_mode
            && s.resources == expected.resources
            && s.data_source.is_none()
            && s.data_source_ref.is_none()
    });
    if !is_controlled_by_microvm(claim, microvm)
        || claim
            .metadata
            .labels
            .as_ref()
            .and_then(|l| l.get(COMPONENT))
            .map(String::as_str)
            != Some(ROLE)
        || !valid
    {
        return Err(reject(format!(
            "tool seed claim {} has an unexpected owner or storage contract",
            claim.name_any()
        )));
    }
    if claim.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Lost") {
        return Err(reject(format!(
            "tool seed claim {} lost its backing volume",
            claim.name_any()
        )));
    }
    Ok(())
}

fn uses_claim(pod: &Pod, name: &str) -> bool {
    pod.spec
        .as_ref()
        .and_then(|s| s.volumes.as_ref())
        .is_some_and(|volumes| {
            volumes.iter().any(|v| {
                v.persistent_volume_claim
                    .as_ref()
                    .is_some_and(|p| p.claim_name == name)
            })
        })
}

fn delete_params(uid: String) -> DeleteParams {
    DeleteParams::foreground().preconditions(Preconditions {
        uid: Some(uid),
        ..Default::default()
    })
}

/// Called only with no guest Pod. A completed matching disk is reused without a copy on resume.
pub async fn ensure_ready(
    client: Client,
    namespace: &str,
    microvm: &MicroVM,
    image: &str,
) -> Result<Option<String>, kube::Error> {
    let claims: Api<PersistentVolumeClaim> = Api::namespaced(client.clone(), namespace);
    let pods: Api<Pod> = Api::namespaced(client, namespace);
    let name = claim_name(microvm);
    let claim = match claims.get_opt(&name).await? {
        Some(claim) => claim,
        None => {
            let mut meta = metadata(&name, namespace, image);
            meta.owner_references = microvm.controller_owner_ref(&()).map(|r| vec![r]);
            claims
                .create(
                    &PostParams::default(),
                    &PersistentVolumeClaim {
                        metadata: meta,
                        spec: Some(disk_spec()),
                        ..Default::default()
                    },
                )
                .await?
        }
    };
    validate_disk(&claim, microvm)?;
    if claim.metadata.deletion_timestamp.is_some() {
        return Ok(None);
    }
    let uid = claim
        .uid()
        .ok_or_else(|| reject("tool seed claim has no UID"))?;
    if annotation(&claim.metadata, IMAGE) != Some(image) {
        // Only this disposable owned disk is replaced. A mounted disk, or a disk
        // without the image receipt, is never silently destroyed.
        if annotation(&claim.metadata, IMAGE).is_none() {
            return Err(reject(format!(
                "tool seed claim {name} has no image receipt"
            )));
        }
        let users = pods.list(&ListParams::default()).await?;
        if let Some(pod) = users.iter().find(|p| uses_claim(p, &name)) {
            if pod.name_any() != initializer_name(&uid) {
                return Err(reject(format!(
                    "refusing to replace tool seed claim {name} while a Pod uses it"
                )));
            }
            validate_initializer(
                pod,
                &claim,
                annotation(&claim.metadata, IMAGE).expect("checked image receipt"),
            )?;
            if pod.metadata.deletion_timestamp.is_none() {
                pods.delete(
                    &pod.name_any(),
                    &delete_params(
                        pod.uid()
                            .ok_or_else(|| reject("tool initializer has no UID"))?,
                    ),
                )
                .await?;
            }
            return Ok(None);
        }
        claims.delete(&name, &delete_params(uid)).await?;
        return Ok(None);
    }
    let pod_name = initializer_name(&uid);
    if let Some(pod) = pods.get_opt(&pod_name).await? {
        validate_initializer(&pod, &claim, image)?;
        if retryable_initializer_failure(&pod) && pod.metadata.deletion_timestamp.is_none() {
            pods.delete(
                &pod_name,
                &delete_params(
                    pod.uid()
                        .ok_or_else(|| reject("tool initializer has no UID"))?,
                ),
            )
            .await?;
            return Err(reject(format!(
                "tool seed initializer {pod_name} was interrupted; retrying its owned disk"
            )));
        }
        if let Some(status) = &pod.status {
            if let Some((reason, message)) = status
                .container_statuses
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find_map(crate::controller::container_failure)
            {
                return Err(reject(format!(
                    "tool seed initializer {pod_name}: {reason}: {message}"
                )));
            }
            if let Some(condition) = status
                .conditions
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|condition| {
                    condition.type_ == "PodScheduled"
                        && condition.status == "False"
                        && condition.reason.as_deref() == Some("Unschedulable")
                })
            {
                return Err(reject(format!(
                    "tool seed initializer {pod_name} is unschedulable: {}",
                    condition.message.as_deref().unwrap_or("no suitable node")
                )));
            }
        }
        match pod.status.as_ref().and_then(|s| s.phase.as_deref()) {
            Some("Succeeded") => {
                if annotation(&claim.metadata, COMPLETE) != Some("true") {
                    claims.patch(&name, &PatchParams::default(), &Patch::Merge(&serde_json::json!({
                        "metadata": {"resourceVersion": claim.resource_version(), "annotations": {(COMPLETE): "true"}}
                    }))).await?;
                }
                if pod.metadata.deletion_timestamp.is_none() {
                    pods.delete(
                        &pod_name,
                        &delete_params(
                            pod.uid()
                                .ok_or_else(|| reject("tool initializer has no UID"))?,
                        ),
                    )
                    .await?;
                }
                // Wait for the initializer to release the RWO volume before attaching it to Kata.
                return Ok(None);
            }
            Some("Failed") => {
                return Err(reject(format!(
                    "tool seed initializer {pod_name} failed: {}",
                    pod.status
                        .as_ref()
                        .and_then(|s| s.message.as_deref())
                        .unwrap_or("inspect its container termination message")
                )));
            }
            _ => return Ok(None),
        }
    }
    if annotation(&claim.metadata, COMPLETE) == Some("true") {
        return Ok(claim
            .status
            .as_ref()
            .and_then(|s| s.phase.as_deref())
            .filter(|p| *p == "Bound")
            .map(|_| name));
    }
    pods.create(
        &PostParams::default(),
        &build_initializer(namespace, microvm, &claim, image)?,
    )
    .await?;
    Ok(None)
}

fn validate_initializer(
    pod: &Pod,
    claim: &PersistentVolumeClaim,
    image: &str,
) -> Result<(), kube::Error> {
    let uid = claim
        .uid()
        .ok_or_else(|| reject("tool seed claim has no UID"))?;
    let owned = pod
        .metadata
        .owner_references
        .as_ref()
        .is_some_and(|owners| {
            owners.iter().any(|o| {
                o.uid == uid && o.kind == "PersistentVolumeClaim" && o.controller == Some(true)
            })
        });
    if !owned
        || pod.spec.as_ref().is_none_or(|s| {
            s.containers.len() != 1
                || s.containers[0].image.as_deref() != Some(image)
                || s.containers[0]
                    .command
                    .as_ref()
                    .is_some_and(|command| !command.is_empty())
                || s.containers[0].args != Some(vec!["--populate-tool-seeds".into(), uid.clone()])
                || s.containers[0].volume_devices
                    != Some(vec![VolumeDevice {
                        name: "tools".into(),
                        device_path: DEVICE.into(),
                    }])
                || s.volumes.as_deref().is_none_or(|volumes| {
                    volumes.len() != 1
                        || volumes[0].name != "tools"
                        || volumes[0]
                            .persistent_volume_claim
                            .as_ref()
                            .is_none_or(|volume| {
                                volume.claim_name != claim.name_any()
                                    || volume.read_only == Some(true)
                            })
                })
        })
    {
        return Err(reject(format!(
            "tool seed initializer {} has an unexpected owner or image",
            pod.name_any()
        )));
    }

    Ok(())
}

fn retryable_initializer_failure(pod: &Pod) -> bool {
    let Some(status) = &pod.status else {
        return false;
    };
    status.phase.as_deref() == Some("Failed")
        && (matches!(
            status.reason.as_deref(),
            Some(
                "Evicted"
                    | "DeadlineExceeded"
                    | "NodeLost"
                    | "NodeShutdown"
                    | "Shutdown"
                    | "Preempted"
            )
        ) || status
            .container_statuses
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|container| {
                container
                    .state
                    .as_ref()
                    .and_then(|s| s.terminated.as_ref())
                    .and_then(|t| t.reason.as_deref())
                    == Some("OOMKilled")
            }))
}

fn build_initializer(
    namespace: &str,
    microvm: &MicroVM,
    claim: &PersistentVolumeClaim,
    image: &str,
) -> Result<Pod, kube::Error> {
    let uid = claim
        .uid()
        .ok_or_else(|| reject("tool seed claim has no UID"))?;
    let mut meta = metadata(&initializer_name(&uid), namespace, image);
    meta.annotations
        .as_mut()
        .expect("seed annotations")
        .insert("sidecar.istio.io/inject".into(), "false".into());
    meta.owner_references = Some(vec![OwnerReference {
        api_version: "v1".into(),
        kind: "PersistentVolumeClaim".into(),
        name: claim.name_any(),
        uid: uid.clone(),
        controller: Some(true),
        block_owner_deletion: Some(false),
    }]);
    Ok(Pod {
        metadata: meta,
        spec: Some(PodSpec {
            automount_service_account_token: Some(false),
            service_account_name: Some("nanoagent".into()),
            restart_policy: Some("Never".into()),
            active_deadline_seconds: Some(300),
            enable_service_links: Some(false),
            node_selector: Some(BTreeMap::from([(
                "kubernetes.io/arch".into(),
                microvm.spec.architecture.kubernetes_label().into(),
            )])),
            containers: vec![Container {
                name: "copy-image-built-tools".into(),
                termination_message_policy: Some("FallbackToLogsOnError".into()),
                image: Some(image.into()),
                args: Some(vec!["--populate-tool-seeds".into(), uid]),
                security_context: Some(SecurityContext {
                    run_as_user: Some(0),
                    run_as_group: Some(0),
                    run_as_non_root: Some(false),
                    allow_privilege_escalation: Some(false),
                    privileged: Some(false),
                    read_only_root_filesystem: Some(true),
                    capabilities: Some(Capabilities {
                        drop: Some(vec!["ALL".into()]),
                        ..Default::default()
                    }),
                    seccomp_profile: Some(SeccompProfile {
                        type_: "RuntimeDefault".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                resources: Some(ResourceRequirements {
                    requests: Some(BTreeMap::from([
                        ("cpu".into(), Quantity("100m".into())),
                        ("memory".into(), Quantity("64Mi".into())),
                    ])),
                    limits: Some(BTreeMap::from([
                        ("cpu".into(), Quantity("1".into())),
                        ("memory".into(), Quantity("128Mi".into())),
                    ])),
                    ..Default::default()
                }),
                volume_devices: Some(vec![VolumeDevice {
                    name: "tools".into(),
                    device_path: DEVICE.into(),
                }]),
                ..Default::default()
            }],
            volumes: Some(vec![Volume {
                name: "tools".into(),
                persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                    claim_name: claim.name_any(),
                    ..Default::default()
                }),
                ..Default::default()
            }]),
            ..Default::default()
        }),
        ..Default::default()
    })
}

pub fn attach(pod: &mut Pod, claim: &str) {
    let annotations = pod.metadata.annotations.get_or_insert_default();
    annotations.insert(
        "io.katacontainers.volume.tengri-tools.mount_path".into(),
        "/usr/share/nanoagent".into(),
    );
    annotations.insert(
        "io.katacontainers.volume.tengri-tools.fs_type".into(),
        "ext4".into(),
    );
    // This is already formatted. Never supply an initialization token or change ownership.
    let spec = pod.spec.as_mut().expect("Tengri guest Pod spec");
    spec.volumes.get_or_insert_default().push(Volume {
        name: "tools".into(),
        persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
            claim_name: claim.into(),
            ..Default::default()
        }),
        ..Default::default()
    });
    spec.containers[0]
        .volume_devices
        .get_or_insert_default()
        .push(VolumeDevice {
            name: "tools".into(),
            device_path: DEVICE.into(),
        });
}

pub fn validate_image() -> anyhow::Result<String> {
    let expected = std::fs::read_to_string(format!("{IMAGE_FILE}.sha256"))?;
    let digest = expected
        .split_whitespace()
        .next()
        .context("seed image checksum is absent")?;
    ensure!(
        digest.len() == 64 && digest.bytes().all(|c| c.is_ascii_hexdigit()),
        "invalid seed image checksum"
    );
    let mut source = File::open(IMAGE_FILE)?;
    ensure!(
        source.metadata()?.len() == SEED_BYTES,
        "unexpected tool seed image length"
    );
    ensure!(
        hash_file(&mut source, false)? == digest,
        "tool seed image checksum mismatch"
    );
    source.seek(SeekFrom::Start(1080))?;
    let mut magic = [0; 2];
    source.read_exact(&mut magic)?;
    ensure!(magic == [0x53, 0xef], "tool seed image is not ext4");
    Ok(digest.into())
}

fn hash_file(file: &mut File, normalize_boot: bool) -> anyhow::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    if normalize_boot {
        hash.update([0; BOOT_BYTES]);
        file.seek(SeekFrom::Start(BOOT_BYTES as u64))?;
    }
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn copy_image(
    source: &mut File,
    destination: &mut File,
    token: &str,
    digest: &str,
) -> anyhow::Result<()> {
    ensure!(
        !token.is_empty()
            && token.len() <= 128
            && token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-'),
        "invalid seed initialization token"
    );
    let mut marker = [0; BOOT_BYTES];
    let text = format!("TENGRI-TOOL-SEEDS-V1\0{token}");
    marker[..text.len()].copy_from_slice(text.as_bytes());
    let mut existing = [0; BOOT_BYTES];
    destination.seek(SeekFrom::Start(0))?;
    destination.read_exact(&mut existing)?;
    if existing != [0; BOOT_BYTES] && existing != marker {
        bail!("refusing to overwrite an unrecognized disk boot area");
    }
    if existing == [0; BOOT_BYTES] {
        // A zero boot area alone does not identify a blank disk: an existing ext4
        // filesystem also leaves it zero. Check the entire new device before the first write.
        let mut buffer = [0; 65536];
        loop {
            let n = destination.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            ensure!(
                buffer[..n].iter().all(|byte| *byte == 0),
                "refusing to overwrite a nonblank unmarked disk"
            );
        }
    }
    destination.seek(SeekFrom::Start(0))?;
    destination.write_all(&marker)?;
    destination.sync_all()?;
    source.seek(SeekFrom::Start(BOOT_BYTES as u64))?;
    destination.seek(SeekFrom::Start(BOOT_BYTES as u64))?;
    std::io::copy(source, destination)?;
    destination.sync_all()?;
    ensure!(
        hash_file(destination, true)? == digest,
        "tool seed disk readback checksum mismatch"
    );
    Ok(())
}

pub fn populate(token: &str) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let digest = validate_image()?;
    let mut destination = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(DEVICE)?;
    ensure!(
        destination.metadata()?.file_type().is_block_device(),
        "seed destination must be the supplied block device"
    );
    ensure!(
        destination.seek(SeekFrom::End(0))? == SEED_BYTES,
        "seed block device must be exactly 1 GiB"
    );
    copy_image(
        &mut File::open(IMAGE_FILE)?,
        &mut destination,
        token,
        &digest,
    )?;
    println!("tool_seed_populate_ms={}", started.elapsed().as_millis());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{MicroVMArchitecture, MicroVMDesiredState, MicroVMResources, MicroVMSpec};
    use http::{Request, Response, StatusCode};
    use k8s_openapi::api::core::v1::PersistentVolumeClaimStatus;
    use kube::client::Body;

    fn microvm() -> MicroVM {
        let mut vm = MicroVM::new(
            "agent",
            MicroVMSpec {
                display_name: "Agent".into(),
                owner_hash: "owner".into(),
                desired_state: MicroVMDesiredState::Running,
                image: "guest-image".into(),
                architecture: MicroVMArchitecture::Amd64,
                resources: MicroVMResources::default(),
                power: Default::default(),
                created_at: "2026-10-06T00:00:00Z".into(),
                idle_deadline: "2026-10-07T00:00:00Z".into(),
                expires_at: String::new(),
            },
        );
        vm.metadata.uid = Some("microvm-uid".into());
        vm
    }

    fn claim(vm: &MicroVM) -> PersistentVolumeClaim {
        let mut meta = metadata(&claim_name(vm), "tengri", "controller-image");
        meta.uid = Some("claim-uid".into());
        meta.owner_references = vm.controller_owner_ref(&()).map(|r| vec![r]);
        PersistentVolumeClaim {
            metadata: meta,
            spec: Some(disk_spec()),
            status: Some(PersistentVolumeClaimStatus {
                phase: Some("Bound".into()),
                ..Default::default()
            }),
        }
    }

    fn response(status: StatusCode, value: serde_json::Value) -> Response<Body> {
        Response::builder()
            .status(status)
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&value).unwrap()))
            .unwrap()
    }

    #[test]
    fn initializer_has_a_bounded_name_and_only_the_disposable_disk() {
        let vm = microvm();
        let claim = claim(&vm);
        let pod = build_initializer("tengri", &vm, &claim, "controller-image").unwrap();
        assert!(pod.name_any().len() <= 63);
        validate_initializer(&pod, &claim, "controller-image").unwrap();
        let spec = pod.spec.unwrap();
        assert_eq!(spec.automount_service_account_token, Some(false));
        assert_eq!(spec.runtime_class_name, None);
        assert_eq!(spec.volumes.as_ref().unwrap().len(), 1);
        assert_eq!(
            spec.volumes.unwrap()[0]
                .persistent_volume_claim
                .as_ref()
                .unwrap()
                .claim_name,
            "agent-tools"
        );
        let security = spec.containers[0].security_context.as_ref().unwrap();
        assert_eq!(security.privileged, Some(false));
        assert_eq!(security.allow_privilege_escalation, Some(false));
        assert_eq!(
            security.capabilities.as_ref().unwrap().drop,
            Some(vec!["ALL".into()])
        );
    }

    #[test]
    fn unrelated_or_incompatible_claims_are_rejected() {
        let vm = microvm();
        let original = claim(&vm);
        validate_disk(&original, &vm).unwrap();
        let mut foreign = original.clone();
        foreign.metadata.owner_references = None;
        assert!(validate_disk(&foreign, &vm).is_err());
        let mut home = original.clone();
        home.spec
            .as_mut()
            .unwrap()
            .resources
            .as_mut()
            .unwrap()
            .requests
            .as_mut()
            .unwrap()
            .insert("storage".into(), Quantity("16Gi".into()));
        assert!(validate_disk(&home, &vm).is_err());
        let mut filesystem = original.clone();
        filesystem.spec.as_mut().unwrap().volume_mode = Some("Filesystem".into());
        assert!(validate_disk(&filesystem, &vm).is_err());
        let mut lost = original;
        lost.status.as_mut().unwrap().phase = Some("Lost".into());
        assert!(validate_disk(&lost, &vm).is_err());
    }

    #[test]
    fn initializer_cannot_substitute_its_command_or_target_disk() {
        let vm = microvm();
        let disk = claim(&vm);
        let original = build_initializer("tengri", &vm, &disk, "controller-image").unwrap();
        let mut forged = original.clone();
        forged.spec.as_mut().unwrap().containers[0].command = Some(vec!["/bin/true".into()]);
        assert!(validate_initializer(&forged, &disk, "controller-image").is_err());
        let mut wrong_device = original.clone();
        wrong_device.spec.as_mut().unwrap().containers[0]
            .volume_devices
            .as_mut()
            .unwrap()[0]
            .device_path = "/dev/wrong".into();
        assert!(validate_initializer(&wrong_device, &disk, "controller-image").is_err());
        let mut wrong_claim = original;
        wrong_claim.spec.as_mut().unwrap().volumes.as_mut().unwrap()[0]
            .persistent_volume_claim
            .as_mut()
            .unwrap()
            .claim_name = "agent-home".into();
        assert!(validate_initializer(&wrong_claim, &disk, "controller-image").is_err());
    }

    type Exchange = (&'static str, String, StatusCode, serde_json::Value);
    fn scripted_client(
        exchanges: Vec<Exchange>,
    ) -> (
        Client,
        std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<Exchange>>>,
    ) {
        let remaining = std::sync::Arc::new(std::sync::Mutex::new(
            std::collections::VecDeque::from(exchanges),
        ));
        let requests = remaining.clone();
        let service = tower::service_fn(move |request: Request<Body>| {
            let (method, path, status, body) = requests
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected Kubernetes mutation");
            assert_eq!(request.method(), method);
            assert_eq!(request.uri().path(), path);
            async move { Ok::<_, std::io::Error>(response(status, body)) }
        });
        (Client::new(service, "tengri"), remaining)
    }
    fn not_found() -> serde_json::Value {
        serde_json::json!({"kind":"Status","status":"Failure","reason":"NotFound","code":404})
    }

    #[tokio::test]
    async fn first_provision_creates_only_an_owned_seed_disk_and_helper() {
        let vm = microvm();
        let disk = claim(&vm);
        let pod = build_initializer("tengri", &vm, &disk, "controller-image").unwrap();
        let prefix = "/api/v1/namespaces/tengri";
        let (client, pending) = scripted_client(vec![
            (
                "GET",
                format!("{prefix}/persistentvolumeclaims/agent-tools"),
                StatusCode::NOT_FOUND,
                not_found(),
            ),
            (
                "POST",
                format!("{prefix}/persistentvolumeclaims"),
                StatusCode::CREATED,
                serde_json::to_value(&disk).unwrap(),
            ),
            (
                "GET",
                format!("{prefix}/pods/{}", pod.name_any()),
                StatusCode::NOT_FOUND,
                not_found(),
            ),
            (
                "POST",
                format!("{prefix}/pods"),
                StatusCode::CREATED,
                serde_json::to_value(&pod).unwrap(),
            ),
        ]);
        assert_eq!(
            ensure_ready(client, "tengri", &vm, "controller-image")
                .await
                .unwrap(),
            None
        );
        assert!(pending.lock().unwrap().is_empty());
        assert!(is_controlled_by_microvm(&disk, &vm));
        assert_eq!(
            pod.metadata.owner_references.unwrap()[0].uid,
            disk.uid().unwrap()
        );
    }

    #[tokio::test]
    async fn interrupted_helper_retries_without_replacing_the_disk() {
        let vm = microvm();
        let disk = claim(&vm);
        let mut pod = build_initializer("tengri", &vm, &disk, "controller-image").unwrap();
        pod.metadata.uid = Some("interrupted-helper".into());
        pod.status = Some(k8s_openapi::api::core::v1::PodStatus {
            phase: Some("Failed".into()),
            reason: Some("Evicted".into()),
            ..Default::default()
        });
        let prefix = "/api/v1/namespaces/tengri";
        let (client, pending) = scripted_client(vec![
            (
                "GET",
                format!("{prefix}/persistentvolumeclaims/agent-tools"),
                StatusCode::OK,
                serde_json::to_value(&disk).unwrap(),
            ),
            (
                "GET",
                format!("{prefix}/pods/{}", pod.name_any()),
                StatusCode::OK,
                serde_json::to_value(&pod).unwrap(),
            ),
            (
                "DELETE",
                format!("{prefix}/pods/{}", pod.name_any()),
                StatusCode::OK,
                serde_json::to_value(&pod).unwrap(),
            ),
            (
                "GET",
                format!("{prefix}/persistentvolumeclaims/agent-tools"),
                StatusCode::OK,
                serde_json::to_value(&disk).unwrap(),
            ),
            (
                "GET",
                format!("{prefix}/pods/{}", pod.name_any()),
                StatusCode::NOT_FOUND,
                not_found(),
            ),
            (
                "POST",
                format!("{prefix}/pods"),
                StatusCode::CREATED,
                serde_json::to_value(&pod).unwrap(),
            ),
        ]);
        assert!(
            ensure_ready(client.clone(), "tengri", &vm, "controller-image")
                .await
                .is_err()
        );
        assert_eq!(
            ensure_ready(client, "tengri", &vm, "controller-image")
                .await
                .unwrap(),
            None
        );
        assert!(pending.lock().unwrap().is_empty());
        pod.status.as_mut().unwrap().reason = Some("Error".into());
        assert!(!retryable_initializer_failure(&pod));
    }

    #[tokio::test]
    async fn changed_image_detaches_old_helper_before_deleting_only_the_tool_claim() {
        let vm = microvm();
        let disk = claim(&vm);
        let mut pod = build_initializer("tengri", &vm, &disk, "controller-image").unwrap();
        pod.metadata.uid = Some("old-helper".into());
        let prefix = "/api/v1/namespaces/tengri";
        let (client, pending) = scripted_client(vec![
            (
                "GET",
                format!("{prefix}/persistentvolumeclaims/agent-tools"),
                StatusCode::OK,
                serde_json::to_value(&disk).unwrap(),
            ),
            (
                "GET",
                format!("{prefix}/pods"),
                StatusCode::OK,
                serde_json::json!({"apiVersion":"v1","kind":"PodList","items":[pod]}),
            ),
            (
                "DELETE",
                format!("{prefix}/pods/{}", pod.name_any()),
                StatusCode::OK,
                serde_json::to_value(&pod).unwrap(),
            ),
            (
                "GET",
                format!("{prefix}/persistentvolumeclaims/agent-tools"),
                StatusCode::OK,
                serde_json::to_value(&disk).unwrap(),
            ),
            (
                "GET",
                format!("{prefix}/pods"),
                StatusCode::OK,
                serde_json::json!({"apiVersion":"v1","kind":"PodList","items":[]}),
            ),
            (
                "DELETE",
                format!("{prefix}/persistentvolumeclaims/agent-tools"),
                StatusCode::OK,
                serde_json::to_value(&disk).unwrap(),
            ),
        ]);
        assert_eq!(
            ensure_ready(client.clone(), "tengri", &vm, "new-image")
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            ensure_ready(client, "tengri", &vm, "new-image")
                .await
                .unwrap(),
            None
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn changed_image_refuses_to_delete_a_disk_used_by_a_guest_or_foreign_pod() {
        let vm = microvm();
        let disk = claim(&vm);
        let mut consumer = Pod {
            spec: Some(PodSpec {
                containers: vec![Container::default()],
                ..Default::default()
            }),
            ..Default::default()
        };
        consumer.metadata.name = Some("another-pod".into());
        attach(&mut consumer, "agent-tools");
        let prefix = "/api/v1/namespaces/tengri";
        let (client, pending) = scripted_client(vec![
            (
                "GET",
                format!("{prefix}/persistentvolumeclaims/agent-tools"),
                StatusCode::OK,
                serde_json::to_value(&disk).unwrap(),
            ),
            (
                "GET",
                format!("{prefix}/pods"),
                StatusCode::OK,
                serde_json::json!({"apiVersion":"v1","kind":"PodList","items":[consumer]}),
            ),
        ]);
        assert!(
            ensure_ready(client, "tengri", &vm, "new-image")
                .await
                .is_err()
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn guest_attachment_never_formats_or_reowns_the_tool_disk() {
        let mut pod = Pod {
            spec: Some(PodSpec {
                containers: vec![Container::default()],
                ..Default::default()
            }),
            ..Default::default()
        };
        attach(&mut pod, "agent-tools");
        let annotations = pod.metadata.annotations.unwrap();
        assert_eq!(
            annotations["io.katacontainers.volume.tengri-tools.mount_path"],
            "/usr/share/nanoagent"
        );
        assert!(
            !annotations
                .keys()
                .any(|key| key.ends_with("initialization_token") || key.ends_with("fs_group"))
        );
        assert_eq!(
            pod.spec.unwrap().containers[0]
                .volume_devices
                .as_ref()
                .unwrap()[0]
                .device_path,
            DEVICE
        );
    }

    #[tokio::test]
    async fn retained_disk_resume_has_no_mutation_or_copy() {
        let vm = microvm();
        let mut disk = claim(&vm);
        disk.metadata
            .annotations
            .as_mut()
            .unwrap()
            .insert(COMPLETE.into(), "true".into());
        let (service, mut handle) = tower_test::mock::pair::<Request<Body>, Response<Body>>();
        let ensure = tokio::spawn(async move {
            ensure_ready(
                Client::new(service, "tengri"),
                "tengri",
                &vm,
                "controller-image",
            )
            .await
        });
        let (request, send) = handle.next_request().await.unwrap();
        assert_eq!(request.method(), "GET");
        assert_eq!(
            request.uri().path(),
            "/api/v1/namespaces/tengri/persistentvolumeclaims/agent-tools"
        );
        send.send_response(response(
            StatusCode::OK,
            serde_json::to_value(disk).unwrap(),
        ));
        let (request, send) = handle.next_request().await.unwrap();
        assert_eq!(request.method(), "GET");
        send.send_response(response(
            StatusCode::NOT_FOUND,
            serde_json::json!({"kind":"Status","status":"Failure","reason":"NotFound","code":404}),
        ));
        assert_eq!(ensure.await.unwrap().unwrap(), Some("agent-tools".into()));
    }

    #[tokio::test]
    async fn initializer_success_is_recorded_before_detaching() {
        use http_body_util::BodyExt as _;
        let vm = microvm();
        let mut disk = claim(&vm);
        disk.metadata.resource_version = Some("7".into());
        let mut pod = build_initializer("tengri", &vm, &disk, "controller-image").unwrap();
        pod.metadata.uid = Some("initializer-uid".into());
        pod.status = Some(k8s_openapi::api::core::v1::PodStatus {
            phase: Some("Succeeded".into()),
            ..Default::default()
        });
        let (service, mut handle) = tower_test::mock::pair::<Request<Body>, Response<Body>>();
        let ensure = tokio::spawn(async move {
            ensure_ready(
                Client::new(service, "tengri"),
                "tengri",
                &vm,
                "controller-image",
            )
            .await
        });
        let (_, send) = handle.next_request().await.unwrap();
        send.send_response(response(
            StatusCode::OK,
            serde_json::to_value(&disk).unwrap(),
        ));
        let (_, send) = handle.next_request().await.unwrap();
        send.send_response(response(
            StatusCode::OK,
            serde_json::to_value(&pod).unwrap(),
        ));
        let (request, send) = handle.next_request().await.unwrap();
        assert_eq!(request.method(), "PATCH");
        let body: serde_json::Value =
            serde_json::from_slice(&request.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["metadata"]["annotations"][COMPLETE], "true");
        assert_eq!(body["metadata"]["resourceVersion"], "7");
        send.send_response(response(
            StatusCode::OK,
            serde_json::to_value(disk).unwrap(),
        ));
        let (request, send) = handle.next_request().await.unwrap();
        assert_eq!(request.method(), "DELETE");
        let body: serde_json::Value =
            serde_json::from_slice(&request.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["preconditions"]["uid"], "initializer-uid");
        send.send_response(response(StatusCode::OK, serde_json::to_value(pod).unwrap()));
        assert_eq!(ensure.await.unwrap().unwrap(), None);
    }

    struct TestFiles(std::path::PathBuf);
    impl TestFiles {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("tengri-tool-seeds-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn file(&self, name: &str, bytes: &[u8]) -> File {
            let path = self.0.join(name);
            std::fs::write(&path, bytes).unwrap();
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .unwrap()
        }
    }
    impl Drop for TestFiles {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn copy_is_verified_retryable_and_refuses_another_disk() {
        let files = TestFiles::new();
        let mut bytes = vec![42; 16384];
        bytes[..BOOT_BYTES].fill(0);
        let mut source = files.file("source", &bytes);
        let digest = hash_file(&mut source, false).unwrap();
        let mut destination = files.file("destination", &vec![0; bytes.len()]);
        copy_image(&mut source, &mut destination, "owned-claim", &digest).unwrap();
        assert_eq!(hash_file(&mut destination, true).unwrap(), digest);
        destination.seek(SeekFrom::Start(5000)).unwrap();
        destination.write_all(b"interrupted copy").unwrap();
        copy_image(&mut source, &mut destination, "owned-claim", &digest).unwrap();
        assert_eq!(hash_file(&mut destination, true).unwrap(), digest);
        assert!(copy_image(&mut source, &mut destination, "different-claim", &digest).is_err());
        let mut unmarked_existing = files.file("existing", &bytes);
        assert!(copy_image(&mut source, &mut unmarked_existing, "owned-claim", &digest).is_err());
        assert_eq!(hash_file(&mut unmarked_existing, false).unwrap(), digest);
        assert!(copy_image(&mut source, &mut destination, "../invalid", &digest).is_err());
    }

    #[test]
    #[ignore = "source-owned 1 GiB artifact timing, enabled explicitly with TENGRI_SEED_BENCHMARK_IMAGE"]
    fn benchmark_verified_seed_population() {
        let image = std::env::var("TENGRI_SEED_BENCHMARK_IMAGE")
            .expect("set source-owned seed artifact path");
        let files = TestFiles::new();
        let started = std::time::Instant::now();
        let mut source = File::open(image).unwrap();
        assert_eq!(source.metadata().unwrap().len(), SEED_BYTES);
        let digest = hash_file(&mut source, false).unwrap();
        let mut destination = files.file("private-test-disk", &[]);
        destination.set_len(SEED_BYTES).unwrap();
        copy_image(
            &mut source,
            &mut destination,
            "source-owned-benchmark",
            &digest,
        )
        .unwrap();
        println!(
            "source_owned_seed_populate_ms={}",
            started.elapsed().as_millis()
        );
    }
}
