# Github Actions Runners

ARC separates architecture-specific runner pods from architecture-neutral control-plane pods.

- Chart version pinned in `application.yaml` is `0.14.2` for both the controller and the runner scale set.
- The architecture-neutral controller and listener pods run on AMD64 capacity; runner pods retain their scale set's
  explicit AMD64 or ARM64 selector.
- Upgrading from ≤0.9.x requires deleting the legacy `actions.github.com` CRDs and reinstalling the controller/runner charts before letting Argo CD reconcile.
- Keep the custom template (init container + privileged `docker:dind` sidecar with `DOCKER_HOST=unix:///var/run/docker.sock`) when reapplying so Docker builds continue to work under Kubernetes mode.
- The runner container intentionally waits for `docker version` before starting `run.sh`; without this guard, ARC can register a runner before the dind socket is ready.
- The `arc-amd64` runner uses one 80Gi generic ephemeral PVC on the existing Turin-only
  `local-path-turin-nvme-intel` class. Its `/nix`, `/home/runner/.cache`, `/tmp`, shared `/home/runner/_work`, and Docker data
  subpaths live on the dedicated rebuildable Intel NVMe scratch volume rather than the Talos `/var` disk. The init
  container copies the image's `/nix` tree before the main containers mount the scratch subpath, verifies the mount,
  capacity, regular-file byte count, regular-file count, and symlink count, then fails closed on any mismatch. The PVC
  is deleted with the runner Pod; no job or build state is durable. The ARM64 and `analysis-arm64` scale sets retain
  their existing `emptyDir` workspaces.
- The 80Gi value is the PVC request; the local-path provisioner does not configure an XFS project quota, so Kubernetes
  does not enforce an 80Gi per-runner ceiling. The init reserves at least 80Gi of free space after copying the image
  tree and cache. The 2026-09-08 validation snapshot measured 242,927,108 KiB (about 231.7GiB) free on the Intel XFS
  backing partition and found no existing PVC consumers. That is current headroom evidence, not a hard capacity or
  durability guarantee. A failed scratch bootstrap is a runner admission failure; investigate it before changing the
  storage class or falling back to `/var`.
- DinD mounts separate root-owned scratch subpaths at `/var/lib/docker` and `/var/lib/containerd`, covering both the
  daemon data root and the containerd image store. The runner's Nix store and cache remain owned by UID 1001. Keep the
  concurrency cap and validate `/var` I/O under the actual workload before resuming storage maintenance or increasing
  build capacity.
- The AMD64 scratch init requests 2Gi and is limited to 8Gi of memory. Its full Nix-tree bootstrap exceeded the prior
  512Mi limit and was OOM-killed before the runner could register. This stays within the Pod's existing 16Gi aggregate
  memory request for runner and DinD, so the init does not increase its scheduling reservation.
- Tailscale connectivity comes from the Omni-owned node configuration in
  `devices/galactic/omni/cluster-template.yaml`; no sidecar or additional secret is required in the runner pods. Follow
  `devices/galactic/omni/README.md` for changes. The retained Harvester/Ansible fleet configuration is not current Talos
  ownership.
- ARC runner and listener pods append the tailnet search suffix `ide-newton.ts.net` via `dnsConfig.searches`, so bare tailnet hosts such as `temporal-grpc` resolve from GitHub Actions jobs without hardcoding the full `*.ts.net` name.
- Generate the `github-token` SealedSecret with `scripts/generate-arc-github-token-secret.sh`. The script reads the token from 1Password via `${ARC_GITHUB_TOKEN_OP_PATH}` (defaults to `op://infra/github personal token/token`) and writes the sealed manifest to `argocd/applications/arc/github-token.yaml`.

## AMD64 maintenance throttle

The `arc-amd64` scale set is bounded to `minRunners: 0` and `maxRunners: 1` in `application.yaml`. During the original
incident, build scratch, etcd data, and Ceph monitor data shared Turin's `/var` NVMe; five concurrent builds saturated
that device and coincided with multi-second etcd fsyncs and read timeouts. Future AMD64 runner Pods move their Nix,
cache, `/tmp`, shared work, and Docker data paths to the Intel scratch PVC above, while control-plane data remains on
`/var`. The cap limits new AMD64 build concurrency while keeping the normal ARC image/Kargo path available. Existing busy runners finish
before the running count falls to one; the
[ARC controller](https://github.com/actions/actions-runner-controller/blob/master/docs/gha-runner-scale-set-controller/README.md)
checks with the Actions service before deleting a runner. Do not delete runner Pods manually.

GitHub's [official ARC scale-set documentation](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets#example-jobs-queue-draining)
documents strict queue draining as setting both `minRunners` and `maxRunners` to `0`: ARC does not create new runner Pods
for newly assigned jobs, so those jobs remain queued. That mode is reserved for an explicitly coordinated emergency
drain because the ordinary ARC image/Kargo workflow also requires an AMD64 runner and would otherwise have no recovery
path from GitOps.

Verify the cap through the `arc-runner` image build, automatic Kargo promotion, and Argo reconciliation. Then measure
etcd fsync/read latency and the NVMe queue under a real build before resuming storage maintenance. A quiet interval alone
does not prove that the contention is fixed.

Keep the cap until build storage is isolated from etcd or measured concurrent build load establishes adequate headroom.
Recovery to the prior capacity is a reviewed change to `minRunners: 1` and `maxRunners: 5`, delivered through the same
image/Kargo path. The ARM64 and `analysis-arm64` scale sets retain their current values.

For current node placement and taint operations, start with `devices/galactic/README.md` and verify the target Talos node
before changing scheduling state.
