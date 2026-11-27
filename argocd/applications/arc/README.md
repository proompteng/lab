# Github Actions Runners

ARC separates architecture-specific runner pods from architecture-neutral control-plane pods.

- The controller and runner scale sets use chart `0.15.1`. Upgrade the controller and its CRDs before promoting a runner chart that needs new CRD fields.
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
  Shared ARM workflows use the same private-process model for application image builds.
- Container runtime lifecycle, systemd, KVM, and resilience fixtures were removed by request. Source checks,
  Dockerfile build-stage regressions, archive/content verification, paired guest checksums, immutable publication,
  signatures, receipt uploads, and Kargo discovery gates remain. CI no longer establishes those runtime behaviors.
- The default execution queues are `arc-arm64` on Altra (`talos-192-168-1-85`) and `arc-amd64` on Turin.
  Both have `minRunners: 5` and `maxRunners: 10`. Each worker requests four CPUs and 8Gi memory, with limits
  of 20 CPUs and 16Gi memory. Required hostname selectors keep workers off Ryzen.
- Publication jobs use the normal `arc-amd64` queue. They retain their existing manifest/index validation,
  signatures, receipts and discovery gates, but no longer have reserved workers or a separate scheduling label.
- External repositories dispatch their workflows into lab to use the common pools. Repository-scoped scale sets
  cannot serve another repository directly. The shared entry point checks out an immutable source commit and calls
  application-owned actions; application build details stay in the owning repository.
- Optional Nix image-archive warming has a 30-minute upload budget and 30-second termination grace. A timeout keeps
  its failed cache status and warning, then releases the build runner. Registry publication remains authoritative.
- Each default build runner uses one 64Gi generic ephemeral PVC from the existing `rook-ceph-block` StorageClass
  for `/nix`, `/home/runner/.cache`, `/tmp`, `/var/tmp`, and `/home/runner/_work`. The class provides an ext4 kernel-RBD
  filesystem in `replicapool`. The init rejects other filesystems, non-RBD devices and the runner root filesystem,
  then copies the image's Nix tree and cache with the existing byte, file-count, symlink and ownership checks.
  The PVC is deleted with its runner Pod. Publication and external application builds use the same scratch volume.
- `/var/tmp` has a separate `var-tmp` subdirectory with explicit mode `01777`. All runner sets expose `CARGO_HOME`
  and `RUSTUP_HOME` beneath their scratch cache. The init creates these directories after verifying the seed
  copy, assigns them to UID 1001 with mode `00700`, and checks the free-space reserve afterward.
- The Ceph init requires enough space for the seed plus 45Gi and verifies at least 45Gi remains after copying, including
  filesystem overhead. The 64Gi RBD claim is separate from the runner's 100Gi local ephemeral-storage resource limit.
  A failed bootstrap remains an admission failure; do not weaken the free-space or complete-copy checks.
- New AMD64 scratch claims never use `local-path-ci-amd64`. Existing busy runners keep their old local claims until
  their normal Pod lifecycle ends; no data migration or active-job deletion is required. Retain the old local-path
  mappings for that cleanup. Ceph RBD data uses the existing HDD OSDs and dedicated BlueStore DB NVMe devices,
  separate from the build nodes' system NVMe and Talos `/var`. ARM64 build scratch no longer uses node-local
  `emptyDir` or the runner overlay. Image layers, runtime metadata and runner logs still use node
  storage, so verify system-disk and control-plane latency during representative builds.
- Each scratch init requests 2Gi and is limited to 8Gi of memory. The AMD64 Nix-tree bootstrap exceeded the prior
  512Mi limit and was OOM-killed before the runner could register. This stays within the Pod's 8Gi aggregate
  memory request for the runner, so the init does not increase its scheduling reservation.
- Tailscale connectivity comes from the Omni-owned node configuration in
  `devices/galactic/omni/cluster-template.yaml`; no sidecar or additional secret is required in the runner pods. Follow
  `devices/galactic/omni/README.md` for changes. The retained Harvester/Ansible fleet configuration is not current Talos
  ownership.
- ARC runner and listener pods append the tailnet search suffix `ide-newton.ts.net` via `dnsConfig.searches`, so bare tailnet hosts such as `temporal-grpc` resolve from GitHub Actions jobs without hardcoding the full `*.ts.net` name.
- Generate the `github-token` SealedSecret with `scripts/generate-arc-github-token-secret.sh`. The script reads the token from 1Password via `${ARC_GITHUB_TOKEN_OP_PATH}` (defaults to `op://infra/github personal token/token`) and writes the sealed manifest to `argocd/applications/arc/github-token.yaml`.

## Opt-in tmpfs runners

Set `runs-on` to one of these labels to run on memory-backed scratch.

| AMD64 on Turin | ARM64 on Altra | Scratch capacity | Runner memory limit |
| --- | --- | ---: | ---: |
| `arc-amd64-tmpfs` | `arc-arm64-tmpfs` | 16 GiB | 18 GiB |
| `arc-amd64-tmpfs-large` | `arc-arm64-tmpfs-large` | 24 GiB | 28 GiB |

The standard labels scale from zero to three workers per architecture. The large labels scale from zero to two.
Each worker requests 8 GiB of memory. Scratch and job processes share the memory limit. Bootstrap allows up to
4 GiB for the seed and verifies the copy and remaining capacity. Jobs with larger scratch requirements, such as
the Restate Cargo cache export, use the default 64 GiB Ceph labels.

OpenCode release images, the main Bayn image and the Bayn broker-feed image use the standard tmpfs labels through
`nix-oci-build-common.yml`. These families accounted for 812 of 2,030 ARC build jobs in the 14 days ending
2026-11-27 UTC. Their observed concurrency at job start was three at p95 on each architecture.

After promotion, dispatch `ARC tmpfs acceptance` to verify both limits, placement, scratch mounts, Nix and BuildKit on
all four labels.

## Runner capacity and delivery

Each default queue keeps five idle runners and grows to ten. At maximum, each host reserves 40 CPUs and 80Gi memory
for ten workers, with aggregate limits of 200 CPUs and 160Gi memory. Altra and Turin retain their existing node roles,
networking and application workloads. Ryzen hosts the ARC controller, listeners and CI telemetry, not lab job workers.
Do not add duplicate ARC scale sets with the same label; Update labels through the documented runner-set change procedure.

Capacity and scratch changes follow the reviewed Git, runner-image, Warehouse/Freight and `arc-runner` Kargo path.
The Stage updates every init/runner image pair together. Each init must seed the image its runner executes.
Publish workflows now use the existing AMD64 label, so delivery does not depend on creating a new queue first.
Finish accepted jobs normally and let ARC retire old Pods and claims; do not shrink existing PVCs or delete active jobs.
Older workflow revisions still targeting the retired publication label must finish before retirement or be updated to
the normal AMD64 label before being run again.

Verify the promoted Kargo revision, node selectors, min/max settings and `rook-ceph-block` claims. The manual
`ARC placement acceptance` workflow requires ten distinct ARM64 Pods on Altra and ten distinct AMD64 Pods on Turin,
each with its own ext4 RBD filesystem from a 64Gi claim. It checks the five scratch mounts, Rust cache homes, `RUNNER_TEMP`,
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
Ten fully written claims at the then-current 100Gi size required 0.98TiB logical and approximately 1.95TiB raw.
This fit the measured capacity without reducing replication or changing a durable volume. `HEALTH_WARN` already
reported BlueStore slow operation indications on OSDs 3 and 5. Recheck that warning during acceptance.

ARM64 builds reproduced the same system-disk contention on Altra later that day. From 13:20:49 to 13:23:35 UTC,
the active Kata ARM64 runner Pod wrote 19.75 MB/s to Altra's system NVMe, while the device averaged 42.67 MB/s.
The Pod's workspace was a local XFS `emptyDir`; its Nix and temporary/cache paths were on the overlay.
Altra's etcd logged 1.459, 2.421 and 1.074-second WAL syncs inside that measured interval. The ARM64 build set now
uses the same verified Ceph bootstrap, five mounts and Rust cache homes as AMD64, with its five-to-ten
capacity, ARM64 placement, service account and runner resources. Accepted jobs finish on their existing storage.
At 13:25 UTC, `replicapool` had 9.66TiB `MAX AVAIL` and the cluster had 29.45TiB raw free, with replication still two.
The current twenty 64Gi claims cap logical scratch capacity at 1.25TiB, or about 2.5TiB raw with two replicas.
RBD is thin-provisioned and uses physical disk space as jobs write data. Retain the existing BlueStore warning and
qualify actual ARM64 builds and all three etcd members after rollout.

When heavy native CI reproduces system-disk contention, deliver the independently reviewed storage prerequisite
through its normal CI, runner-image and Kargo path first. Verify the new mounts and a clean control-plane baseline
before resuming the affected native gates. A cancelled or incomplete run remains unqualified; storage admission
and a successful runner rollout do not replace native build or sustained-throughput acceptance.

Verify the promoted Kargo revision, both five-to-ten runner configurations, host placement and 64Gi `rook-ceph-block` claims first.
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
