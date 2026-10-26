# Github Actions Runners

ARC separates architecture-specific runner pods from architecture-neutral control-plane pods.

- Chart version pinned in `application.yaml` is `0.14.2` for both the controller and the runner scale set.
- The custom image pins Actions runner `2.337.0` in `nix/images/arc-runner.nix`, independently of the ARC chart version.
  Update its upstream index digest and both platform archive hashes together. Confirm the repository's accepted
  runner version with `gh api repos/proompteng/lab/actions/runners/downloads`, then verify `Runner.Listener --version`
  in the delivered runner. Restarting the controller does not update that binary.
- The architecture-neutral controller and listener pods run on AMD64 capacity; runner pods retain their scale set's
  explicit AMD64 or ARM64 selector.
- Upgrading from ≤0.9.x requires deleting the legacy `actions.github.com` CRDs and reinstalling the controller/runner charts before letting Argo CD reconcile.
- Lab runner Pods contain only the runner container. `.github/actions/setup-buildkit` starts a rootful BuildKit OCI
  worker inside the current ephemeral runner and connects Buildx's remote driver to its private Unix socket. The
  daemon and its scratch cache belong to that one job and disappear with its runner Pod. There is no shared builder
  service or persistent cache that a pull request can poison for a later release. Existing registry and GitHub cache
  scopes retain their policies.
- The runner keeps UID 1001. Its existing sudo access starts BuildKit as root in the privileged container. This moves
  the existing rootful build capability out of DinD without adding a sidecar, Docker Engine, Podman, host runtime
  socket, node configuration, new credential, or cluster permission. Nix-only jobs never start a builder. The external
  `analysis-arm64` scale set retains its independently owned Docker contract.
- Container runtime lifecycle, systemd, KVM, and resilience fixtures were removed by request. Source checks,
  Dockerfile build-stage regressions, archive/content verification, paired guest checksums, immutable publication,
  signatures, receipt uploads, and Kargo discovery gates remain. CI no longer establishes those runtime behaviors.
- One `arc-amd64` scale set serves nine AMD64 build slots under the existing workflow label. Each runner reserves
  16Gi memory. Host spread is a scheduling preference; the scheduler can use Turin when Ryzen has no room for another
  runner. Node affinity, memory requests and the scratch bootstrap's free-space check still apply. The minimum remains
  two. `arc-arm64` has eight build slots on Altra; `analysis-arm64` retains its separate one-slot limit.
- `arc-amd64-publish` reserves two idle publication runners and scales to four on Turin. Each single-container runner
  requests one CPU, 2Gi memory and 2Gi ephemeral storage, with limits of four CPUs, 8Gi memory and 32Gi storage. Its
  workspace is disposable `emptyDir`; it uses the same Kargo-promoted runner image and GitHub credential as the build
  sets. Registry clients run in an unprivileged container with no Docker or BuildKit daemon, Kubernetes API token,
  scratch PVC or sidecar. Keep native image builds on the architecture-specific sets so queued builds cannot consume
  the publication runners.
- Shared Nix index publication, Agents receipt assembly, and the Tengri, Restate, Temporal, Codex devbox, Buzz and Kata
  publication jobs use `arc-amd64-publish`. Their native builds keep the existing architecture-specific labels.
- Optional Nix image-archive warming has a two-minute upload budget and 30-second termination grace. A timeout keeps
  its failed cache status and warning, then releases the build runner. Registry publication remains authoritative.
- `local-path-ci-amd64` uses per-class node paths: Turin's Transcend scratch mount and Ryzen's local XFS mount. Other
  storage classes retain their existing paths. Each runner uses one 45Gi generic ephemeral PVC for `/nix`,
  `/home/runner/.cache`, `/tmp`, and `/home/runner/_work`. The init copies the image's Nix tree before the
  main containers mount it, checks XFS and free capacity, then verifies file bytes, counts and symlinks. The PVC is
  deleted with the runner Pod. ARM64 and `analysis-arm64` retain their existing `emptyDir` workspaces.
- The 45Gi value is a PVC request. The local-path provisioner does not configure an XFS project quota, so Kubernetes
  does not enforce a 45Gi per-runner ceiling. The init requires at least 45Gi free after copying the image tree and
  cache. A failed scratch bootstrap is a runner admission failure; investigate it before changing the class.
- Ryzen's local partition shares a physical NVMe with Talos `/var`. Moving builds frees Turin's scratch device and
  avoids Ceph-volume traffic from Ryzen, but does not prove isolation from Ryzen's etcd or control-plane I/O.
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

The single `arc-amd64` scale set has `minRunners: 2` and `maxRunners: 9`. Keep its existing GitHub identity and label.
Separate ARC sets with a duplicate label do not provide a reliable combined queue, and ARC 0.14.2 does not update an
existing registered set's labels. Native builds keep that one label; publication has its own `arc-amd64-publish` label.

Ryzen has 128GiB installed, but its 64GiB GPU reservation leaves about 61.82GiB allocatable. Its non-runner requests
change as other workloads move. The 2026-10-26 queue investigation measured 27.63GiB, enough for two 16Gi runners,
instead of the three assumed by the former hard spread. That rule stranded runners despite Turin's free capacity.
`ScheduleAnyway` keeps host balance as a preference without imposing a fixed three/six split. Each build runner still
requests four CPUs and 16Gi and permits 20 CPUs and 32Gi. Check fresh node requests, pressure, local scratch capacity
and etcd latency during actual builds. No BIOS or node configuration change is part of this queue fix.

Apply the local storage class and complete the [Ryzen placement rollout](../../../devices/galactic/scheduling/README.md)
before promoting ARC through Kargo. Verify the provisioner has reloaded all five per-class path maps, and exercise an
empty disposable claim on each eligible host before allowing runner scratch creation. Busy Turin runners must finish
normally. Existing Pods retain their original claims until ARC retires them. ARM64 placement stays on Altra and its
normal limit increases from five to eight; its minimum stays one and its existing node-local workspaces remain.
Check Altra's node filesystem and image filesystem before promotion: its 2026-10-12 disk-pressure event recovered
through native image reclamation and the kubelet's five-minute transition period. Do not override a pressure taint.
The Kargo Stage updates the two native build sets, the publication set and the separate analysis set together.

Dispatch `.github/workflows/arc-placement-acceptance.yml` from `main` after reconciliation. All nine matrix jobs request
only `arc-amd64`, exercise local scratch, Nix and a direct BuildKit build with a local file export, then wait at a nine-slot barrier. The final job requires nine
distinct runner Pods on the two eligible hosts, at most three on Ryzen, with at least 45 seconds of overlap. It also
checks the publication pool's registry access and tooling. This proves ordinary shared-label capacity without assuming
an exact host split. Read back memory pressure, etcd latency and NVMe contention
throughout that window; Ryzen scratch shares its physical NVMe with Talos `/var`.

Deploy new runner pools through the runner-image/Kargo path before changing workflow routing. Otherwise the image
workflow's own publication job can wait for a pool whose creation depends on that image. Once the new pool is ready,
migrate publication jobs directly to `arc-amd64-publish`; retain their validation, signatures and discovery gates.

Capacity changes use a reviewed Git change and the normal runner-image/Kargo delivery path. If storage contention
returns, restore `minRunners: 0` and `maxRunners: 1` through that path. Existing busy runners finish before the count
falls; the [ARC controller](https://github.com/actions/actions-runner-controller/blob/master/docs/gha-runner-scale-set-controller/README.md)
checks with the Actions service before deleting a runner. Do not delete runner Pods manually.

GitHub's [official ARC scale-set documentation](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets#example-jobs-queue-draining)
documents strict queue draining as setting both `minRunners` and `maxRunners` to `0`. Reserve that mode for an explicitly
coordinated emergency drain because the ordinary ARC image/Kargo workflow also requires an AMD64 runner.

GitHub can reject an outdated runner binary and ARC then marks its scale set `Outdated`, removes its listener, and
stops scheduling jobs. A successful controller health check does not prove runner capacity. If every build runner
is stopped, the runner image workflow cannot rebuild itself. An explicitly authorized bootstrap must first restore
enough runner capacity to execute the existing reviewed build and Kargo path. Keep the original desired state and
record the temporary changes and their restoration. Do not publish an operator-built image or bypass PR checks.

For current node placement and taint operations, start with `devices/galactic/README.md` and verify the target Talos node
before changing scheduling state.
