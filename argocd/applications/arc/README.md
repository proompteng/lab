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
- One `arc-amd64` scale set keeps ten build runners on Turin under the existing workflow label. Its minimum and
  maximum are both ten. Each runner reserves four CPUs and 16Gi memory, with limits of 20 CPUs and 32Gi memory.
  The required hostname selector keeps these build runners on Turin.
  `arc-arm64` has eight build slots on Altra; `analysis-arm64` retains its separate one-slot limit.
- `analysis-arm64` keeps its 20Gi disposable workspace and one worker. Its single runner container reserves two CPUs,
  4Gi memory and 20Gi ephemeral storage, with limits of ten CPUs, 18Gi memory and 72Gi storage. These preserve the
  former runner-plus-DinD resource budget. Its workflow starts a private BuildKit OCI worker with build parallelism
  capped at one. It has no Docker daemon, socket volume, Docker startup wait or Kubernetes container hook.
- `arc-amd64-publish` serves up to two publication runners on Ryzen and Turin, with the same host allowlist and
  soft spreading. Each single-container runner
  requests one CPU, 2Gi memory and 2Gi ephemeral storage, with limits of four CPUs, 8Gi memory and 32Gi storage. Its
  workspace is disposable `emptyDir`; it uses the same Kargo-promoted runner image and GitHub credential as the build
  sets. Registry clients run in an unprivileged container with no Docker or BuildKit daemon, Kubernetes API token,
  scratch PVC or sidecar. Keep native image builds on the architecture-specific sets so queued builds cannot consume
  the publication runners.
- Shared Nix index publication, Agents receipt assembly, and the Tengri, Restate, Temporal, Codex devbox, Buzz and Kata
  publication jobs use `arc-amd64-publish`. Their native builds keep the existing architecture-specific labels.
- Optional Nix image-archive warming has a 30-minute upload budget and 30-second termination grace. A timeout keeps
  its failed cache status and warning, then releases the build runner. Registry publication remains authoritative.
- Each AMD64 build runner uses one 130Gi generic ephemeral PVC from the existing `rook-ceph-block` StorageClass
  for `/nix`, `/home/runner/.cache`, `/tmp`, and `/home/runner/_work`. The class provides an ext4 kernel-RBD
  filesystem in `replicapool`. The init rejects other filesystems, non-RBD devices and the runner root filesystem,
  then copies the image's Nix tree and cache with the existing byte, file-count, symlink and ownership checks.
  The PVC is deleted with its runner Pod. ARM64, analysis and publication workspaces retain their existing storage.
- A 130Gi RBD claim has a real filesystem capacity ceiling, unlike the former unbounded local-path directory.
  The init requires enough space for the seed plus 45Gi and verifies at least 45Gi remains after copying, including
  filesystem overhead. The claim size is separate from the runner's unchanged ephemeral-storage resource limit.
  A failed bootstrap remains an admission failure; do not weaken the free-space or complete-copy checks.
- New AMD64 scratch claims never use `local-path-ci-amd64`. Existing busy runners keep their old local claims until
  their normal Pod lifecycle ends; no data migration or active-job deletion is required. Retain the old local-path
  mappings for that cleanup. Ceph RBD data uses the existing HDD OSDs and dedicated BlueStore DB NVMe devices,
  separate from Turin's system NVMe and Talos `/var`. Image layers, runtime metadata and runner logs still use node
  storage, so verify system-disk and control-plane latency during representative builds.
- The AMD64 scratch init requests 2Gi and is limited to 8Gi of memory. Its full Nix-tree bootstrap exceeded the prior
  512Mi limit and was OOM-killed before the runner could register. This stays within the Pod's 16Gi aggregate
  memory request for the runner, so the init does not increase its scheduling reservation.
- Tailscale connectivity comes from the Omni-owned node configuration in
  `devices/galactic/omni/cluster-template.yaml`; no sidecar or additional secret is required in the runner pods. Follow
  `devices/galactic/omni/README.md` for changes. The retained Harvester/Ansible fleet configuration is not current Talos
  ownership.
- ARC runner and listener pods append the tailnet search suffix `ide-newton.ts.net` via `dnsConfig.searches`, so bare tailnet hosts such as `temporal-grpc` resolve from GitHub Actions jobs without hardcoding the full `*.ts.net` name.
- Generate the `github-token` SealedSecret with `scripts/generate-arc-github-token-secret.sh`. The script reads the token from 1Password via `${ARC_GITHUB_TOKEN_OP_PATH}` (defaults to `op://infra/github personal token/token`) and writes the sealed manifest to `argocd/applications/arc/github-token.yaml`.

## AMD64 capacity

The single `arc-amd64` scale set has `minRunners: 10` and `maxRunners: 10` on Turin, keeping ten runners available
instead of shrinking to one idle runner. Keep its existing GitHub identity and label.
Separate ARC sets with a duplicate label do not provide a reliable combined queue, and ARC 0.14.2 does not update an
existing registered set's labels. Native builds keep that one label; publication has its own `arc-amd64-publish` label
with `minRunners: 1` and `maxRunners: 2`.

Ten build runners request 40 CPUs and 160Gi memory in total, with aggregate limits of 200 CPUs and 320Gi memory.
The 2026-11-12 preflight measured 383.95 allocatable CPUs and 1037.66Gi memory on Turin. Conservatively adding all
ten runners to that snapshot's existing allocations gave 147.95 requested CPUs, 512.37Gi requested memory and
821.21Gi memory limits. CPU limits can slightly exceed allocatable CPU and throttle under contention. Recheck
current requests, memory pressure, Ceph headroom and etcd latency before promotion. Publication retains its
Ryzen/Turin host allowlist and soft spreading; no BIOS or node configuration change is part of this placement.

Verify the existing Ceph class, pool and CSI health before promoting ARC through Kargo. Busy runners
finish normally and retain their original claims until ARC retires them. ARM64 placement stays on Altra, with its
normal eight-slot maximum and the separate analysis set's one-slot maximum. Do not override a pressure taint.
The Kargo Stage updates the two native build sets, the publication set and the separate analysis set together.

Deploy new runner pools through the runner-image/Kargo path before changing workflow routing. Otherwise the image
workflow's own publication job can wait for a pool whose creation depends on that image. Keep publication outside
the native build queues and retain its validation, signatures and discovery gates.

Capacity changes use a reviewed Git change and the normal runner-image/Kargo delivery path. The manual
`ARC placement acceptance` workflow verifies ten distinct Turin build runners on ten different ext4 RBD devices
and two distinct publication runners, with at least 45 seconds of shared occupancy and exact BuildKit output
checksums. All four scratch mounts, `RUNNER_TEMP` and the private BuildKit cache must share each runner's RBD
filesystem. Run it after the existing build wave clears; its five-minute rendezvous fails promptly if a slot cannot
start. This proves slots, placement and tooling. Sustained throughput also requires the representative-build
observation below. The [ARC controller](https://github.com/actions/actions-runner-controller/blob/master/docs/gha-runner-scale-set-controller/README.md)
checks with the Actions service before deleting a runner. Do not delete runner Pods manually.

GitHub's [official ARC scale-set documentation](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets#example-jobs-queue-draining)
documents strict queue draining as setting both `minRunners` and `maxRunners` to `0`. Reserve that mode for an explicitly
coordinated emergency drain because the ordinary ARC image/Kargo workflow also requires an AMD64 runner.

### Ceph capacity and sustained-load acceptance

The 2026-11-12 incident reproduced under normal AMD64 CI load. Turin's etcd WAL `fdatasync` took 85.048 seconds
and 27.090 seconds at 09:30 UTC, and API readiness failed its etcd checks. At 09:31 UTC the shared system NVMe
averaged 78.86 MB/s writes, 116.6 ms per write and a weighted queue of 271.7 over two minutes. Read-only cgroup
samples from 09:30:59 to 09:32:57 attributed 32.09, 7.63 and 4.79 MB/s to three AMD64 runners, including one
scratch initializer. The quiet interval before that wave did not establish stability under build load.

Ceph preflight at 09:50 UTC found all six OSDs up/in and all 601 PGs active and clean, including ongoing scrubs.
`replicapool` retained its two replicas across hosts, with 9.94TiB `MAX AVAIL`; the cluster had 30.01TiB raw free.
Ten fully written 130Gi claims require 1.27TiB logical and approximately 2.54TiB raw at that replication factor.
This fits the measured capacity without reducing replication or changing a durable volume. RBD is thin-provisioned;
the arithmetic does not reserve pool headroom or prove throughput. `HEALTH_WARN` already reported BlueStore slow
operation indications on OSDs 3 and 5. Keep that warning visible and recheck it; capacity alone is not health proof.

Verify the promoted Kargo revision, ten-runner configuration, Turin placement and `rook-ceph-block` claims first.
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
