# Kata 4.1.0 / Talos v1.13.9 release receipt

Recorded on 2026-08-24 and updated on 2026-08-30. Status: **r4 complete on all three nodes; r5 accepted on Ryzen**.
Ryzen runs the signed r5 persistent-block extension, while Turin and Altra retain the signed r4 extension. All three
retain their machine-specific extensions, are Ready and schedulable, and pass all four native Kubernetes Kata
RuntimeClasses at their recorded release. This receipt separates artifact publication, node installation, and live
guest acceptance; only the last state proves that a runtime works.

## Final r4 artifact chain

Main-branch run [32679570540](https://github.com/proompteng/lab/actions/runs/32679570540) built, signed, and verified
the final artifacts from merge commit
[`699e4776dbeefdfc7c1a8348688f27428478ef82`](https://github.com/proompteng/lab/commit/699e4776dbeefdfc7c1a8348688f27428478ef82).

| Artifact                   | Platform                     | Immutable reference                                                                                              |
| -------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Kata runtime extension r4  | `linux/amd64`, `linux/arm64` | `ghcr.io/proompteng/talos-kata-runtimes@sha256:b7384435ad1393288e0235d8e467303348b252c2feb73973d309d07fee9afc44` |
| Extension child            | `linux/amd64`                | `sha256:d826a1502799c0ee2af1537fcb592f20e17fb184dd55ea08fecf3db3e328f566`                                        |
| Extension child            | `linux/arm64`                | `sha256:ad84cb227c60cafa50ad2c9cd9622fda347f9cc55fb923ba0331f3dba84d4baa`                                        |
| Combined extension catalog | OCI manifest                 | `ghcr.io/proompteng/talos-extensions@sha256:9cc2637cbf2ad061f5d39164ce558d71ab4608cdea702d42753f94d87539433a`    |
| Ryzen installer            | `linux/amd64`                | `ghcr.io/proompteng/talos-kata-runtimes@sha256:e12717e24f74b0d509a9c57cc2e5036854dfa3a9de0aafa33a3a0d2bf7b317d3` |
| Turin installer            | `linux/amd64`                | `ghcr.io/proompteng/talos-kata-runtimes@sha256:fffaddf186ff39e4352b17fd032bac60aa518abac459346f43fde95586897db0` |
| Altra installer            | `linux/arm64`                | `ghcr.io/proompteng/talos-kata-runtimes@sha256:08a58afa7ca1ed0d02e23b9ff940edb37b131f0f1291392f2c00bdc9049dcfa2` |
| Shell-capable Nanoagent    | `linux/amd64`, `linux/arm64` | `ghcr.io/proompteng/nanoagent@sha256:78b7b6e52e9b3f6003d2663a5e85fbfb55eabba018a6ee61f6b39a722f71ad7c`           |

The amd64 extension child uses config digest
`sha256:33607af06cc7064b91cefa7befb46d7e02421680dee2d41b37fd1dea970f99cb`; the arm64 child uses config digest
`sha256:8bdbaa43a44172ca93b8f1ad98631c3cc99542294ff4b0969c30746f88959130`. Every r4 extension, catalog, and installer
reference passed keyless Cosign verification with identity
`https://github.com/proompteng/lab/.github/workflows/kata-firecracker-extension.yaml@refs/heads/main`, issuer
`https://token.actions.githubusercontent.com`. The NUC Image Factory live `v1.13.9` catalog resolved the custom
extension to the r4 index digest before rollout.

Nanoagent was published from merge commit
[`0bd5113c453ce6b0c361253bafb7252614a0a887`](https://github.com/proompteng/lab/commit/0bd5113c453ce6b0c361253bafb7252614a0a887)
by successful [main-branch run 32686402214](https://github.com/proompteng/lab/actions/runs/32686402214). That workflow
built both architectures, generated provenance and an SBOM, and keylessly signed and verified the digest with the
main-branch `nanoagent.yaml` workflow identity. The image runs as UID 65532, retains Nanoagent as its entrypoint, and
contains BusyBox `/bin/sh` plus a writable `/workspace` for direct `kubectl exec` inspection.

## Published r5 artifacts and Ryzen acceptance

Main-branch run [33304758749](https://github.com/proompteng/lab/actions/runs/33304758749) built, signed, and verified
the persistent-block r5 candidate from merge commit
[`a0d7a0dcf5c1fe4f743850906cbe85700853d748`](https://github.com/proompteng/lab/commit/a0d7a0dcf5c1fe4f743850906cbe85700853d748).

| Artifact                  | Platform                     | Immutable reference                                                                                                          |
| ------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Kata runtime extension r5 | `linux/amd64`, `linux/arm64` | `registry.ide-newton.ts.net/lab/talos-kata-runtimes@sha256:8d34965e669a53d3f7d7565d674fbe140acc0874422676601bb5638c705f8e8d` |
| Ryzen installer r5        | `linux/amd64`                | `registry.ide-newton.ts.net/lab/talos-kata-runtimes@sha256:d489b3d7fc198d98dfbef8a8754933a5ce68f78920e4ce251f41a34594259def` |
| Turin installer r5        | `linux/amd64`                | `registry.ide-newton.ts.net/lab/talos-kata-runtimes@sha256:f4c47111721884fcc486fb2478ba51d904b227a53ea2174ee795a070e101894d` |
| Altra installer r5        | `linux/arm64`                | `registry.ide-newton.ts.net/lab/talos-kata-runtimes@sha256:33f3f2be96b06a049507381c3b142f1bba93f88af82990950313697a8aabd027` |

Every reference passed keyless Cosign verification with the main-branch Kata workflow identity and GitHub Actions
OIDC issuer. Publication alone is not acceptance. On 2026-08-30, Ryzen installed and accepted its r5 installer; Turin
and Altra remain on their accepted r4 installers. Each remaining r5 target still requires separate authorization and
must remove its four runtime labels before installation, then restore each label only after that runtime passes fresh
r5 acceptance.

### Ryzen r5 one-node acceptance

Ryzen (`talos-192-168-1-194`, Talos endpoint `100.100.244.141`) was the only node changed. Before the drain, Omni had
no active upgrade, all three etcd members were healthy non-learners, Ryzen was not the etcd leader, `/dev/kvm` was
present, and the PDB-blocked workload controllers were healthy. The authorized maintenance drain used
`--disable-eviction`; `--force` was not used. A pre-change etcd snapshot taken from Turin recorded hash `dfc7c229`,
revision `567055794`, size `504295456` bytes, and SHA-256
`061194ac112d5c22dc1b4834d6b456fc1c0d700c388b1ad74c358d819ddf4fc1`.

The exact Ryzen r5 installer
`registry.ide-newton.ts.net/lab/talos-kata-runtimes@sha256:d489b3d7fc198d98dfbef8a8754933a5ce68f78920e4ce251f41a34594259def`
was installed with `--drain=false --no-reboot`. One planned `powercycle` changed the host boot ID from
`f414aaa0-6697-48ba-9417-8984d9069dd3` to `18de7247-a600-46a4-94c6-8d598986deca`. Talos then reported
`kata-runtimes` version `4.1.0-r5`, plus the preserved AMDGPU, AMD microcode, glibc, and Tailscale extensions. CRI,
kubelet, etcd, and the Kubernetes node all returned healthy while Ryzen remained cordoned.

Fresh r5 runtime proofs used `verify-runtimes.sh` and restored each capability label only after its row passed:

| Runtime          | Guest boot ID                          | Guest kernel | MicroVM ID                             |
| ---------------- | -------------------------------------- | ------------ | -------------------------------------- |
| QEMU             | `01f121ab-e65e-493e-a73a-ae11e00abdd0` | `6.18.35`    | `62b617a9-1482-4787-8d7a-e4570c89a51e` |
| Cloud Hypervisor | `195c8254-d983-4218-9912-2ef848ab476d` | `6.18.35`    | `9f4786c3-7517-4cce-9106-eb29edd2547a` |
| Firecracker      | `d26d6565-76f8-4203-b822-f0f57e15741d` | `6.18.35`    | `f46f50a9-be73-4766-9518-5cdd6068f57b` |
| Dragonball       | `a9c9727f-14b7-439c-8302-0788f07971b1` | `6.18.35`    | `9c8131df-7a95-4c01-8999-44e579133002` |

The persistent-block acceptance used the fixed Tengri profile: a 16 GiB `rook-ceph-block` RWO raw-block PVC, 2 CPU,
4 GiB RAM, `kata-fc`, and Nanoagent digest
`registry.ide-newton.ts.net/lab/nanoagent@sha256:eca441df2babc69c6d52633905a2e796b2647d4f9a0f1e9efa98cec9958b7236`.
The first guest initialized `/dev/vdd` as ext4 at `/home/nanoagent` and wrote marker checksum
`4db70c68a4be20fc100c47ddc90fce92568f9002344aa7f19cd2f2b3ad045fbf` on guest boot
`a972f907-7f01-48b2-9b4a-fb31fae92006`. After deleting that Pod, a new Firecracker guest booted as
`28ce3b40-5bfd-463a-9647-7ccf68f5524c` on the same PVC with no initialization token and read the identical checksum.
A preliminary undersized harness was discarded and is not acceptance evidence.

After the temporary proof resources were deleted, Ryzen received
`runtime.proompteng.ai/kata-fc-persistent-block=ready` and was uncordoned. The production Tengri MicroVM
`agent-ca54ce88bbd7b553b257e3b8bed54093` then became `Ready` on Ryzen; its PVC recorded initialization `complete`,
the live Pod omitted the initialization token, and Nanoagent reported Firecracker guest boot
`8db18914-4c94-4449-8510-ecf24a0a25e5`. Post-rollout evidence showed all three nodes Ready and schedulable, three
healthy etcd voters, Torghut DB at two of two Ready, Restate at three of three Ready, and Ceph `HEALTH_OK` with all
three monitors in quorum. The local evidence bundle was `/tmp/galactic-kata-ryzen-r5.OX1bRA`; it is ephemeral and
must be reproduced from this procedure rather than copied into Git.

The original 12-runtime evidence rows below were captured before the rename with the immutable predecessor canary
`ghcr.io/proompteng/microvm-agent@sha256:5573551391d01240297680da6ac172d3c819b57d493c3c3e2e11fa1388b06640`.
That reference is retained only to preserve the historical proof chain; active GitOps uses Nanoagent.

## Nanoagent live migration

[PR #14025](https://github.com/proompteng/lab/pull/14025), merged as
[`77e85766f8c4f67bf276716a960a352f40ede1f4`](https://github.com/proompteng/lab/commit/77e85766f8c4f67bf276716a960a352f40ede1f4),
replaced the four legacy canary DaemonSets with `nanoagent-qemu`, `nanoagent-clh`, `nanoagent-fc`, and
`nanoagent-dragonball`. Argo CD reconciled that exact revision with pruning enabled, reached `Synced` and `Healthy`,
deleted all four predecessor DaemonSets, and reported all four Nanoagent DaemonSets at three of three Ready.

The final Nanoagent verifier bundle was captured at
`/tmp/galactic-nanoagent-proof-shell-20260824T034915Z`. It proved all 12 RuntimeClass, CRI sandbox, guest-evidence, and host
VMM combinations. A direct `/bin/sh` acceptance test in every container additionally proved UID 65532, Nanoagent as
PID 1, executable BusyBox shell, a writable `/workspace`, and a write/read/delete cycle. The shell-reported guest boot
ID and kernel matched the evidence endpoint for every row:

| Node                  | Runtime          | Architecture | Guest boot ID                          | Guest kernel |
| --------------------- | ---------------- | ------------ | -------------------------------------- | ------------ |
| `talos-192-168-1-194` | QEMU             | `amd64`      | `e65fb914-f1c3-4867-b731-ed8d5141728c` | `6.18.35`    |
| `talos-192-168-1-194` | Cloud Hypervisor | `amd64`      | `0d21f578-f174-4f18-abe9-61f14cafc2d0` | `6.18.35`    |
| `talos-192-168-1-194` | Firecracker      | `amd64`      | `ca51d6dd-fd18-4192-b12c-4ccff08ea466` | `6.18.35`    |
| `talos-192-168-1-194` | Dragonball       | `amd64`      | `92f6c1d2-2f70-48e4-93c0-6d065fe760f0` | `6.18.35`    |
| `turin`               | QEMU             | `amd64`      | `5208f2f7-b1ce-4efd-bd7d-a2880dddadcc` | `6.18.35`    |
| `turin`               | Cloud Hypervisor | `amd64`      | `3176fe96-f051-4768-adb4-0596e11ecf11` | `6.18.35`    |
| `turin`               | Firecracker      | `amd64`      | `198e3acd-98d8-4ea9-841e-5c0ae3eaa2a4` | `6.18.35`    |
| `turin`               | Dragonball       | `amd64`      | `bfdafe8e-b3d3-4a12-8fb1-a5544786e407` | `6.18.35`    |
| `talos-192-168-1-85`  | QEMU             | `arm64`      | `fd4926bd-2a8a-47d3-9db9-6a8079fb0d6d` | `6.18.35`    |
| `talos-192-168-1-85`  | Cloud Hypervisor | `arm64`      | `29db4e87-5242-4ffc-a80f-ad44ddd564fe` | `6.18.35`    |
| `talos-192-168-1-85`  | Firecracker      | `arm64`      | `6ec2c471-055e-4da8-924d-2a6ec631bb9e` | `6.18.35`    |
| `talos-192-168-1-85`  | Dragonball       | `arm64`      | `f69fc83d-89b8-49f8-8fa9-55ae8ba8579d` | `6.18.35`    |

The first Firecracker start on Turin and Altra exposed the already-documented compressed-layer retention edge case for
the newly published image. Only the missing digest-pinned Nanoagent OCI content was fetched into each node's existing
containerd content store. No node was upgraded, drained, rebooted, cordoned, or reconfigured. All three nodes remained
Ready and schedulable after acceptance.

## Correction history

This section records the historical r0-r4 correction chain. R4 remains accepted on Turin and Altra; Ryzen's accepted
r5 persistent-block extension is recorded above. The earlier artifacts remain immutable but are superseded:

1. the initial build exposed a non-empty Dragonball firmware value that runtime-rs rejects;
2. r1 cleared Dragonball firmware on both architectures;
3. r2 isolated the QEMU guest image from the Dragonball-specific arm64 kernel configuration;
4. r3 extended Dragonball's first-boot timeout; and
5. r4 selected MMIO disks for Dragonball on arm64, fixing its final boot blocker.

The final implementation also caps Firecracker at 32 vCPUs, uses a 100 ms initial VMM socket dial with a 45-second
reconnect budget, enables containerd's blockfile snapshotter only for `kata-fc`, retains compressed OCI layers, and
uses local CRI pulls so Firecracker can build its block-backed root filesystem.

Source history:

- [PR #14015](https://github.com/proompteng/lab/pull/14015): cap Firecracker vCPUs on large hosts;
- [PR #14018](https://github.com/proompteng/lab/pull/14018): clear Dragonball firmware;
- [PR #14019](https://github.com/proompteng/lab/pull/14019): isolate the QEMU guest image;
- [PR #14020](https://github.com/proompteng/lab/pull/14020): extend Dragonball boot timeout; and
- [PR #14021](https://github.com/proompteng/lab/pull/14021): use MMIO disks for Dragonball arm64.

Superseded references such as the initial extension
`sha256:f829d94e178a709d2c1bb46dd1c3c71dd7d50064db2843132768cf18d29d5d46` and r1 extension
`sha256:65a2f8262aaa57d2cf766b71840138a88bfb66e974622c7378fc25a6fe8ec1fc` must not be used for a new rollout.

## Sequential node installation

The resumed rollout completed Altra, Turin, then Ryzen. Before each machine, Kubernetes readiness, `/dev/kvm`, and
three healthy non-learner etcd voters were proved. A fresh etcd snapshot was taken from a non-target voter, and etcd
leadership was moved off the target when necessary. Ceph health and flags were recorded but did not block this rollout
under the explicit operator policy. Existing PDBs were bypassed only for the authorized maintenance drains by using
`kubectl drain --disable-eviction`; `--force` was never used.

| Machine                       | Installer digest                                                          | Post-install host boot ID              | Preserved extension set                        |
| ----------------------------- | ------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| Altra / `talos-192-168-1-85`  | `sha256:08a58afa7ca1ed0d02e23b9ff940edb37b131f0f1291392f2c00bdc9049dcfa2` | `7ffd1d61-9f88-4712-8d57-27ba8b505f6a` | Kata, NVIDIA kernel modules/toolkit, Tailscale |
| Turin / `turin`               | `sha256:fffaddf186ff39e4352b17fd032bac60aa518abac459346f43fde95586897db0` | `19c29240-caea-4db7-a1e6-4fba8515e0c5` | Kata, NVIDIA kernel modules/toolkit, Tailscale |
| Ryzen / `talos-192-168-1-194` | `sha256:e12717e24f74b0d509a9c57cc2e5036854dfa3a9de0aafa33a3a0d2bf7b317d3` | `9e25987c-2665-4a19-b578-befe3516a27c` | Kata, AMDGPU, AMD microcode, glibc, Tailscale  |

Snapshot receipts:

| Target | SHA-256                                                            | etcd hash  | Revision    | Size              |
| ------ | ------------------------------------------------------------------ | ---------- | ----------- | ----------------- |
| Altra  | `9625f50090ff7755b607bf7bfad14fb5b88423c635cb931f86dc46161cf2372f` | `4f163e33` | `523964071` | `372760608` bytes |
| Turin  | `7a6a95d5758559f986dd80b5b4e7428e792ad55f64ea6b28a20c4acdd0d65e10` | `f7baa3a8` | `524150330` | `372101120` bytes |
| Ryzen  | `500ebb1cc886cd4d1a0be2a34c0f86202c1677c9ab832a416ced90b993b0ef54` | `9a76eef0` | `524192701` | `374329376` bytes |

### Altra EFI firmware exception

Altra's ADLINK firmware returned `input/output error` while the Talos installer updated
`LoaderEntryDefault-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f`. The installer had already written a complete r4 UKI to the
system ESP on `/dev/nvme0n1p1`; `/dev/nvme1n1` is the Ceph disk and was not touched. The staged UKI hash was
`61c32f783d443887d4b4107f2f19e843ad2e0f4762098d1fcac7d1a632a62e5e`. The prior active UKI was retained as
`/EFI/Linux/Talos-v1.12.4.efi.pre-kata-r4-20260824T014021Z`, hash
`f6901e20d5902517a701b9d53e43657b4ab3aff1a207286daa7a7fc518030586`, before promoting the staged image to the
firmware-selected `Talos-v1.12.4.efi` filename. The exact guarded recovery procedure is in the cluster runbook.

### Turin reboot recovery

Turin installed r4 successfully, then its graceful power-cycle stopped Kubernetes and Talos services but remained in
the reboot actor while Ceph CSI mounts were being torn down. A second Talos reboot correctly refused to acquire the
lifecycle lock. After proving the other two etcd voters healthy and confirming Turin's boot ID had not changed, one
authorized IPMI `chassis power cycle` was sent through the existing BMC procedure. Credentials were neither printed nor
persisted. Turin returned on the new boot ID above, rejoined etcd, passed all four runtime proofs while still cordoned,
and was then uncordoned.

Ryzen's staged install and graceful power-cycle completed normally. It remained cordoned until its post-reboot runtime
proof passed, then was uncordoned.

## Final 12-runtime acceptance

The final verifier bundle was captured at
`/tmp/galactic-kata-r4-final-proof-20260824T015020Z`. The directory is ephemeral evidence; reproduce it with
`verify-runtimes.sh` rather than copying it into Git. For every row, the verifier proved the RuntimeClass, Ready native
Kubernetes canary Pod, CRI sandbox, architecture, guest boot ID, guest kernel, opaque bootstrap-token hash, microVM ID,
and host-side VMM process. Dragonball is linked into runtime-rs and is proved by its Kata shim plus configuration.

| Node                  | Runtime          | Architecture | Guest boot ID                          | Guest kernel | MicroVM ID                             |
| --------------------- | ---------------- | ------------ | -------------------------------------- | ------------ | -------------------------------------- |
| `talos-192-168-1-194` | QEMU             | `amd64`      | `eebd9d61-250f-417b-9b5e-6d3cd39a93b8` | `6.18.35`    | `3b9009c6-7ccd-4499-a55b-d4e59d2c011f` |
| `talos-192-168-1-194` | Cloud Hypervisor | `amd64`      | `4f0d2a66-57e4-4302-bc80-7b66f1f6904f` | `6.18.35`    | `566d161c-86ed-4afb-880d-8f2eb5faa02e` |
| `talos-192-168-1-194` | Firecracker      | `amd64`      | `b739702e-5662-48b7-a363-2971f0f59f8d` | `6.18.35`    | `7e325b8d-26df-4c80-96b6-118506309278` |
| `talos-192-168-1-194` | Dragonball       | `amd64`      | `126e5d28-3895-467c-abf2-11878569e2ad` | `6.18.35`    | `c31f3988-7103-4abd-b060-63381c4eef2c` |
| `turin`               | QEMU             | `amd64`      | `2e145a33-4ce9-4f8f-b9b5-85331e84b86c` | `6.18.35`    | `ed100cd7-59f5-4a9a-86e0-94ff15036ff0` |
| `turin`               | Cloud Hypervisor | `amd64`      | `e81ede37-da19-41b7-964d-0aeaa07b264d` | `6.18.35`    | `23b6ac80-92bd-45bf-97f3-ce275ecd6e0d` |
| `turin`               | Firecracker      | `amd64`      | `4d0368bf-f0fb-4d22-aaf8-1da5581d7435` | `6.18.35`    | `fd3f5e4c-ca08-40fc-8115-a23f5646fe82` |
| `turin`               | Dragonball       | `amd64`      | `9c5597a8-6c48-41cd-92f9-8f42c396dcb3` | `6.18.35`    | `b9c5b2d9-7496-4c08-bce5-4827f0a3a3a5` |
| `talos-192-168-1-85`  | QEMU             | `arm64`      | `a4100432-d5de-4a30-a3b2-ba8df2528cc2` | `6.18.35`    | `9312da87-a4d8-49bf-a3a8-2bba479cc312` |
| `talos-192-168-1-85`  | Cloud Hypervisor | `arm64`      | `68b5f701-6623-40d8-a437-53e07fbc7891` | `6.18.35`    | `8ccd3ea8-54ca-43fb-af5c-e8253680efa8` |
| `talos-192-168-1-85`  | Firecracker      | `arm64`      | `51143f67-6dd0-4dd8-9987-417754452d03` | `6.18.35`    | `5f4b488c-f921-405d-ad1d-58cdf2ee5cf9` |
| `talos-192-168-1-85`  | Dragonball       | `arm64`      | `45132fc7-7fcf-4786-adcf-8458ff9210b0` | `6.18.35`    | `d08c0577-e236-4307-aee1-9daa9547e327` |

Final live state:

- all three nodes are Ready, schedulable, and running Talos `v1.13.9`, Kubernetes `v1.36.4`, kernel
  `6.18.44-talos`, and containerd `2.2.7`;
- etcd has three healthy non-learner voters with no errors;
- all four RuntimeClasses map to their independent Kata handlers;
- all 12 canary Pods are Running and Ready and remain available for inspection; and
- Ceph is recorded as `HEALTH_WARN` with six of six OSDs up/in and three monitor quorum members. Its degraded and
  backfilling placement groups were explicitly non-blocking for this rollout.

There is no custom controller or CRD in this architecture. A normal Pod selects `kata-qemu`, `kata-clh`, `kata-fc`, or
`kata-dragonball`; containerd and Kata create one microVM sandbox for that Pod.
