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
- Lab runner Pods contain only the runner container. Dockerfile workflows use `.github/actions/setup-buildkit` to
  connect Buildx's remote driver to a standalone native AMD64 or ARM64 BuildKit worker. Nix image builds retain their
  archive/Skopeo path. No Docker Engine, Podman service, builder sidecar, host runtime socket, or node configuration is
  needed by lab runners. The external `analysis-arm64` scale set retains its independently owned Docker contract.
- `buildkit.yaml` pins the worker image by digest and gives each native worker its own local cache PVC. AMD64 runs on
  Turin and ARM64 uses ARM64 capacity. Workers use BuildKit's OCI executor in a privileged Pod. Garbage collection
  reserves 10GB, targets at most 40GB of unused cache, and keeps 45GB free. Active builds can exceed the cache target.
- BuildKit's gRPC services are private cluster endpoints. Their ingress NetworkPolicy admits only lab ARC runner Pods
  in the same namespace. Worker Pods do not mount a Kubernetes service-account token. There are no new credentials,
  cluster permissions, host runtime mounts, or custom daemon wrappers.
- Container runtime lifecycle, systemd, KVM, and resilience fixtures were removed by request. Source checks,
  Dockerfile build-stage regressions, archive/content verification, paired guest checksums, immutable publication,
  signatures, receipt uploads, and Kargo discovery gates remain. CI no longer establishes those runtime behaviors.
- One `arc-amd64` scale set serves nine AMD64 slots under the existing workflow label. Each runner reserves 16Gi memory. Four cannot fit Ryzen's measured 61.82Gi allocatable. A required two-host spread
  with `maxSkew: 3` therefore places nine concurrent Pods as three on Ryzen and six on Turin. The minimum remains two.
  A missing host or insufficient Ryzen headroom leaves excess jobs queued. Re-evaluate this guard before increasing
  Ryzen's allocatable memory or changing reservations. `arc-arm64` has eight slots on Altra; `analysis-arm64` retains
  its separate one-slot limit.
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
existing registered set's labels. This migration adds neither a second AMD64 set nor a host-specific GitHub label.

Ryzen has 128GiB installed, but its current 64GiB GPU reservation leaves 61.82GiB allocatable. Three runners reserve
48Gi and six logical CPUs. The 2026-10-12 native inventory measured 11.94GiB and 6.57 logical CPUs
for retained workloads after application Ceph clients and Bayn left Ryzen. The resulting request total is about
59.94GiB and 12.57 logical CPUs. Require fresh non-runner requests below 13.82GiB before promotion. Runner memory limits match the 16Gi reservation.
Standalone BuildKit workers account for build memory separately from runner Pods. Check node pressure and etcd latency during actual builds. No BIOS change or
reboot is needed now.
A future all-five Ryzen move requires the [Bosgame memory procedure](../../../devices/ryzen/docs/bosgame-m5-talos-drivers.md#cpu-and-gpu-memory-allocation)
and a reviewed revision of the two-host spread.

Apply the local storage class and complete the [Ryzen placement rollout](../../../devices/galactic/scheduling/README.md)
before promoting ARC through Kargo. Verify the provisioner has reloaded all five per-class path maps, and exercise an
empty disposable claim on each eligible host before allowing runner scratch creation. Busy Turin runners must finish
normally. Existing Pods retain their original claims until ARC retires them. ARM64 placement stays on Altra and its
normal limit increases from five to eight; its minimum stays one and its existing node-local workspaces remain.
Check Altra's node filesystem and image filesystem before promotion: its 2026-10-12 disk-pressure event recovered
through native image reclamation and the kubelet's five-minute transition period. Do not override a pressure taint.
The Kargo Stage continues updating the same three runner scale sets.

Dispatch `.github/workflows/arc-placement-acceptance.yml` from `main` after reconciliation. All nine matrix jobs request
only `arc-amd64`, exercise local scratch, Nix and a direct BuildKit build with a local file export, then wait at a nine-slot barrier. The final job requires nine
distinct runner Pods, three on Ryzen and six on Turin, with at least 45 seconds of overlap. This proves ordinary shared-label
capacity rather than a separate host-pinned test route. Read back memory pressure, etcd latency and NVMe contention
throughout that window; Ryzen scratch shares its physical NVMe with Talos `/var`.

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
