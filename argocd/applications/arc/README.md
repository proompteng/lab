# Github Actions Runners

ARC separates architecture-specific runner pods from architecture-neutral control-plane pods.

- Chart version pinned in `application.yaml` is `0.14.2` for both the controller and the runner scale set.
- The custom image pins Actions runner `2.337.0` in `nix/images/arc-runner.nix`, independently of the ARC chart version.
  Update its upstream index digest and both platform archive hashes together. Confirm the repository's accepted
  runner version with `gh api repos/proompteng/lab/actions/runners/downloads`, then verify `Runner.Listener --version`
  in the delivered runner. Restarting the controller does not update that binary.
- The architecture-neutral controller and listener pods run on Ryzen's AMD64 capacity; runner pods retain their scale
  set's explicit AMD64 or ARM64 selector.
- Upgrading from ≤0.9.x requires deleting the legacy `actions.github.com` CRDs and reinstalling the controller/runner charts before letting Argo CD reconcile.
- Lab runner Pods contain only the runner container. `.github/actions/setup-buildkit` starts a rootful BuildKit OCI
  worker inside the current ephemeral runner and connects Buildx's remote driver to its private Unix socket. The
  daemon and its scratch cache belong to that one job and disappear with its runner Pod. There is no shared builder
  service or persistent cache that a pull request can poison for a later release. Existing registry and GitHub cache
  scopes retain their policies.
- The runner keeps UID 1001. Its existing sudo access starts BuildKit as root in the privileged container. This moves
  the existing rootful build capability out of DinD without adding a sidecar, Docker Engine, Podman, host runtime
  socket, node configuration, new credential, or cluster permission. Nix-only jobs never start a builder. The
  `analysis-arm64` set uses the same private-process model through its workflow in `gregkonush/analysis`.
- Container runtime lifecycle, systemd, KVM, and resilience fixtures were removed by request. Source checks,
  Dockerfile build-stage regressions, archive/content verification, paired guest checksums, immutable publication,
  signatures, receipt uploads, and Kargo discovery gates remain. CI no longer establishes those runtime behaviors.
- Lab has two execution queues: `arc-arm64` on Altra (`talos-192-168-1-85`) and `arc-amd64` on Turin.
  Both have `minRunners: 5` and `maxRunners: 10`. Each worker requests four CPUs and 16Gi memory, with limits
  of 20 CPUs and 32Gi memory. Required hostname selectors keep workers off Ryzen.
- Publication jobs use the normal `arc-amd64` queue. They retain their existing manifest/index validation,
  signatures, receipts and discovery gates, but no longer have reserved workers or a separate scheduling label.
- The separately registered `analysis-arm64` runner serves `gregkonush/analysis`, not `proompteng/lab`.
  GitHub repository-scoped scale sets cannot share that registration. It retains its one-worker, 20Gi local workspace
  until an explicit retirement or repository migration; it is not one of the two lab queues.
- Optional Nix image-archive warming has a 30-minute upload budget and 30-second termination grace. A timeout keeps
  its failed cache status and warning, then releases the build runner. Registry publication remains authoritative.
- Each AMD64 and normal ARM64 build runner uses one 100Gi generic ephemeral PVC from the existing `rook-ceph-block` StorageClass
  for `/nix`, `/home/runner/.cache`, `/tmp`, `/var/tmp`, and `/home/runner/_work`. The class provides an ext4 kernel-RBD
  filesystem in `replicapool`. The init rejects other filesystems, non-RBD devices and the runner root filesystem,
  then copies the image's Nix tree and cache with the existing byte, file-count, symlink and ownership checks.
  The PVC is deleted with its runner Pod. Publication uses the same scratch volume; analysis retains its separate storage.
- `/var/tmp` has a separate `var-tmp` subdirectory with explicit mode `01777`; large archive tools can use their
  normal temporary directory without writing to the runner overlay. Both native build sets expose `CARGO_HOME`
  and `RUSTUP_HOME` beneath the Ceph-backed cache. The init creates these directories after verifying the seed
  copy, assigns them to UID 1001 with mode `00700`, and checks the 45Gi free-space reserve afterward.
- A 100Gi RBD claim has a real filesystem capacity ceiling, unlike the former unbounded local-path directory.
  The init requires enough space for the seed plus 45Gi and verifies at least 45Gi remains after copying, including
  filesystem overhead. The claim size is separate from the runner's 100Gi local ephemeral-storage resource limit.
  A failed bootstrap remains an admission failure; do not weaken the free-space or complete-copy checks.
- New AMD64 scratch claims never use `local-path-ci-amd64`. Existing busy runners keep their old local claims until
  their normal Pod lifecycle ends; no data migration or active-job deletion is required. Retain the old local-path
  mappings for that cleanup. Ceph RBD data uses the existing HDD OSDs and dedicated BlueStore DB NVMe devices,
  separate from the build nodes' system NVMe and Talos `/var`. ARM64 build scratch no longer uses node-local
  `emptyDir` or the runner overlay. Image layers, runtime metadata and runner logs still use node
  storage, so verify system-disk and control-plane latency during representative builds.
- Each native build scratch init requests 2Gi and is limited to 8Gi of memory. The AMD64 Nix-tree bootstrap exceeded the prior
  512Mi limit and was OOM-killed before the runner could register. This stays within the Pod's 16Gi aggregate
  memory request for the runner, so the init does not increase its scheduling reservation.
- Tailscale connectivity comes from the Omni-owned node configuration in
  `devices/galactic/omni/cluster-template.yaml`; no sidecar or additional secret is required in the runner pods. Follow
  `devices/galactic/omni/README.md` for changes. The retained Harvester/Ansible fleet configuration is not current Talos
  ownership.
- ARC runner and listener pods append the tailnet search suffix `ide-newton.ts.net` via `dnsConfig.searches`, so bare tailnet hosts such as `temporal-grpc` resolve from GitHub Actions jobs without hardcoding the full `*.ts.net` name.
- Generate the `github-token` SealedSecret with `scripts/generate-arc-github-token-secret.sh`. The script reads the token from 1Password via `${ARC_GITHUB_TOKEN_OP_PATH}` (defaults to `op://infra/github personal token/token`) and writes the sealed manifest to `argocd/applications/arc/github-token.yaml`.

## Runner capacity and delivery

Each lab queue keeps five idle runners and grows to ten. At maximum, each host reserves 40 CPUs and 160Gi memory
for ten workers, with aggregate limits of 200 CPUs and 320Gi memory. Altra and Turin retain their existing node roles,
networking and application workloads. Ryzen hosts the ARC controller, listeners and CI telemetry, not lab job workers.
Do not add duplicate ARC scale sets with the same label; ARC 0.14.2 does not update an existing registered set's labels.

Capacity and scratch changes follow the reviewed Git, runner-image, Warehouse/Freight and `arc-runner` Kargo path.
The Stage updates both native init/runner image pairs together; each init must seed the image its runner executes.
Publish workflows now use the existing AMD64 label, so delivery does not depend on creating a new queue first.
Finish accepted jobs normally and let ARC retire old Pods and claims; do not shrink existing PVCs or delete active jobs.
Older workflow revisions still targeting the retired publication label must finish before retirement or be updated to
the normal AMD64 label before being run again.

Verify the promoted Kargo revision, node selectors, min/max settings and `rook-ceph-block` claims. The manual
`ARC placement acceptance` workflow requires ten distinct ARM64 Pods on Altra and ten distinct AMD64 Pods on Turin,
each with its own 100Gi ext4 RBD filesystem. It checks the five scratch mounts, Rust cache homes, `RUNNER_TEMP`,
private BuildKit cache and exact output checksums, then requires at least 45 seconds of common twenty-worker occupancy.
Run it after the existing build wave clears; its five-minute readiness budget fails if all slots cannot start.
This proves placement and tooling, not sustained throughput.

The optional `native_qualification` input retains the separate thirty-minute common native-work proof on the ten
AMD64 builders. It does not establish ARM64 sustained throughput; use representative ARM64 jobs and the storage/control
plane observations below for that. Preserve pressure taints and existing bootstrap admission checks.

GitHub's [official ARC scale-set documentation](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets#example-jobs-queue-draining)
documents strict queue draining as setting both `minRunners` and `maxRunners` to `0`. Reserve that mode for an explicitly
coordinated emergency drain because the runner-image/Kargo workflow itself needs the normal build queues.

### Ceph capacity and sustained-load acceptance

The 2026-11-12 incident reproduced under normal AMD64 CI load. Turin's etcd WAL `fdatasync` took 85.048 seconds
and 27.090 seconds at 09:30 UTC, and API readiness failed its etcd checks. At 09:31 UTC the shared system NVMe
averaged 78.86 MB/s writes, 116.6 ms per write and a weighted queue of 271.7 over two minutes. Read-only cgroup
samples from 09:30:59 to 09:32:57 attributed 32.09, 7.63 and 4.79 MB/s to three AMD64 runners, including one
scratch initializer. The quiet interval before that wave did not establish stability under build load.

Ceph preflight at 09:50 UTC found all six OSDs up/in and all 601 PGs active and clean, including ongoing scrubs.
`replicapool` retained its two replicas across hosts, with 9.94TiB `MAX AVAIL`; the cluster had 30.01TiB raw free.
Ten fully written 100Gi claims require 0.98TiB logical and approximately 1.95TiB raw at that replication factor.
This fits the measured capacity without reducing replication or changing a durable volume. RBD is thin-provisioned;
the arithmetic does not reserve pool headroom or prove throughput. `HEALTH_WARN` already reported BlueStore slow
operation indications on OSDs 3 and 5. Keep that warning visible and recheck it; capacity alone is not health proof.

ARM64 builds reproduced the same system-disk contention on Altra later that day. From 13:20:49 to 13:23:35 UTC,
the active Kata ARM64 runner Pod wrote 19.75 MB/s to Altra's system NVMe, while the device averaged 42.67 MB/s.
The Pod's workspace was a local XFS `emptyDir`; its Nix and temporary/cache paths were on the overlay.
Altra's etcd logged 1.459, 2.421 and 1.074-second WAL syncs inside that measured interval. The ARM64 build set now
uses the same verified Ceph bootstrap, five mounts and Rust cache homes as AMD64, with its five-to-ten
capacity, ARM64 placement, service account and runner resources. Accepted jobs finish on their existing storage.
At 13:25 UTC, `replicapool` had 9.66TiB `MAX AVAIL` and the cluster had 29.45TiB raw free, with replication still two.
The ten AMD64 plus ten ARM64 maximum requires 1.95TiB logical and approximately 3.91TiB raw if every 100Gi
claim is fully written. Retain the existing BlueStore warning and qualify actual ARM64 builds and all three
etcd members after rollout; the ten-slot AMD64 workflow alone does not prove ARM64 throughput.

When heavy native CI reproduces system-disk contention, deliver the independently reviewed storage prerequisite
through its normal CI, runner-image and Kargo path first. Verify the new mounts and a clean control-plane baseline
before resuming the affected native gates. A cancelled or incomplete run remains unqualified; storage admission
and a successful runner rollout do not replace native build or sustained-throughput acceptance.

Verify the promoted Kargo revision, both five-to-ten runner configurations, host placement and 100Gi `rook-ceph-block` claims first.
After the slot/output acceptance succeeds, record a continuous 30-minute representative native-image-build window
at the intended concurrency with healthy API/etcd readiness, no new slow WAL-sync warnings or recurring
reconciliation timeouts, and measured system-device write/flush latency and queue depth. Record Ceph slow operations,
PG state, pool headroom, build duration and errors over the same window. Investigate persistent Ceph latency before
claiming ten-runner throughput or stability. Preserve existing pool durability and let accepted jobs finish normally.

GitHub can reject an outdated runner binary and ARC then marks its scale set `Outdated`, removes its listener, and
stops scheduling jobs. A successful controller health check does not prove runner capacity. If every build runner
is stopped, the runner image workflow cannot rebuild itself. An explicitly authorized bootstrap must first restore
enough runner capacity to execute the existing reviewed build and Kargo path. Keep the original desired state and
record the temporary changes and their restoration. Do not publish an operator-built image or bypass PR checks.

For current node placement and taint operations, start with `devices/galactic/README.md` and verify the target Talos node
before changing scheduling state.
