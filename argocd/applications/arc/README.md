# Github Actions Runners

ARC separates architecture-specific runner pods from architecture-neutral control-plane pods.

- Chart version pinned in `application.yaml` is `0.14.2` for both the controller and the runner scale set.
- The architecture-neutral controller and listener pods run on AMD64 capacity; runner pods retain their scale set's
  explicit AMD64 or ARM64 selector.
- Upgrading from ≤0.9.x requires deleting the legacy `actions.github.com` CRDs and reinstalling the controller/runner charts before letting Argo CD reconcile.
- Keep the custom template (init container + privileged `docker:dind` sidecar with `DOCKER_HOST=unix:///var/run/docker.sock`) when reapplying so Docker builds continue to work under Kubernetes mode.
- The runner container intentionally waits for `docker version` before starting `run.sh`; without this guard, ARC can register a runner before the dind socket is ready.
- The `arc-amd64` runner uses one 45Gi generic ephemeral PVC on the existing Turin-only
  `local-path-turin-nvme-transcend` class. Its `/nix`, `/home/runner/.cache`, `/tmp`, shared `/home/runner/_work`, and Docker data
  subpaths live on the dedicated rebuildable Transcend NVMe scratch volume rather than the Talos `/var` disk. The init
  container copies the image's `/nix` tree before the main containers mount the scratch subpath, verifies the mount,
  capacity, regular-file byte count, regular-file count, and symlink count, then fails closed on any mismatch. The PVC
  is deleted with the runner Pod; no job or build state is durable. The ARM64 and `analysis-arm64` scale sets retain
  their existing `emptyDir` workspaces.
- The 45Gi value is the PVC request; the local-path provisioner does not configure an XFS project quota, so Kubernetes
  does not enforce a 45Gi per-runner ceiling. The init requires at least 45Gi of free space after copying the image
  tree and cache. The 2026-09-14 validation snapshot measured about 233GiB free on the Transcend XFS
  backing partition and found no existing PVC consumers. That is current headroom evidence, not a hard capacity or
  durability guarantee. A failed scratch bootstrap is a runner admission failure; investigate it before changing the
  storage class or falling back to `/var`.
- DinD mounts separate root-owned scratch subpaths at `/var/lib/docker` and `/var/lib/containerd`, covering both the
  daemon data root and the containerd image store. The runner's Nix store and cache remain owned by UID 1001. Validate
  `/var` I/O under the actual workload before resuming storage maintenance or increasing build capacity further.
- The AMD64 scratch init requests 2Gi and is limited to 8Gi of memory. Its full Nix-tree bootstrap exceeded the prior
  512Mi limit and was OOM-killed before the runner could register. This stays within the Pod's existing 16Gi aggregate
  memory request for runner and DinD, so the init does not increase its scheduling reservation.
- Tailscale connectivity comes from the Omni-owned node configuration in
  `devices/galactic/omni/cluster-template.yaml`; no sidecar or additional secret is required in the runner pods. Follow
  `devices/galactic/omni/README.md` for changes. The retained Harvester/Ansible fleet configuration is not current Talos
  ownership.
- ARC runner and listener pods append the tailnet search suffix `ide-newton.ts.net` via `dnsConfig.searches`, so bare tailnet hosts such as `temporal-grpc` resolve from GitHub Actions jobs without hardcoding the full `*.ts.net` name.
- Generate the `github-token` SealedSecret with `scripts/generate-arc-github-token-secret.sh`. The script reads the token from 1Password via `${ARC_GITHUB_TOKEN_OP_PATH}` (defaults to `op://infra/github personal token/token`) and writes the sealed manifest to `argocd/applications/arc/github-token.yaml`.

## AMD64 capacity

The `arc-amd64` scale set uses `minRunners: 1` and `maxRunners: 5` in `application.yaml`. One idle runner stays available,
and the set can scale to five runners. Five 45Gi requests total 225Gi, leaving about 12Gi of the Transcend filesystem
unallocated. These requests do not reserve space or cap writes; the bootstrap free-space check is also shared across
runners. Actual concurrent-build usage still needs validation. The Intel disk holds Bayn ledger storage and is no
longer the target for new AMD64 runner scratch volumes. ARM64 and `analysis-arm64` retain their existing limits.

The September 8 maintenance throttle reduced AMD64 capacity to `minRunners: 0` and `maxRunners: 1` after five concurrent
builds saturated Turin's `/var` NVMe, which also held etcd and Ceph monitor data. AMD64 build scratch now uses the separate
Transcend NVMe PVC described above. Restoring capacity does not establish disk headroom or etcd latency under concurrent
builds; check those under actual workload before increasing capacity further.

Capacity changes use a reviewed Git change and the normal runner-image/Kargo delivery path. If storage contention
returns, restore `minRunners: 0` and `maxRunners: 1` through that path. Existing busy runners finish before the count
falls; the [ARC controller](https://github.com/actions/actions-runner-controller/blob/master/docs/gha-runner-scale-set-controller/README.md)
checks with the Actions service before deleting a runner. Do not delete runner Pods manually.

GitHub's [official ARC scale-set documentation](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets#example-jobs-queue-draining)
documents strict queue draining as setting both `minRunners` and `maxRunners` to `0`. Reserve that mode for an explicitly
coordinated emergency drain because the ordinary ARC image/Kargo workflow also requires an AMD64 runner.

For current node placement and taint operations, start with `devices/galactic/README.md` and verify the target Talos node
before changing scheduling state.
