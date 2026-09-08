# Github Actions Runners

ARC separates architecture-specific runner pods from architecture-neutral control-plane pods.

- Chart version pinned in `application.yaml` is `0.14.2` for both the controller and the runner scale set.
- The architecture-neutral controller and listener pods run on AMD64 capacity; runner pods retain their scale set's
  explicit AMD64 or ARM64 selector.
- Upgrading from ≤0.9.x requires deleting the legacy `actions.github.com` CRDs and reinstalling the controller/runner charts before letting Argo CD reconcile.
- Keep the custom template (init container + privileged `docker:dind` sidecar with `DOCKER_HOST=unix:///var/run/docker.sock`) when reapplying so Docker builds continue to work under Kubernetes mode.
- The runner container intentionally waits for `docker version` before starting `run.sh`; without this guard, ARC can register a runner before the dind socket is ready.
- Runner workspaces use bounded node-local `emptyDir` volumes; analysis is hard-capped at one 20Gi workspace on the
  Altra node while local kubelet capacity is constrained. No ephemeral runner work directory uses replicated Ceph RBD.
- Tailscale connectivity comes from the Omni-owned node configuration in
  `devices/galactic/omni/cluster-template.yaml`; no sidecar or additional secret is required in the runner pods. Follow
  `devices/galactic/omni/README.md` for changes. The retained Harvester/Ansible fleet configuration is not current Talos
  ownership.
- ARC runner and listener pods append the tailnet search suffix `ide-newton.ts.net` via `dnsConfig.searches`, so bare tailnet hosts such as `temporal-grpc` resolve from GitHub Actions jobs without hardcoding the full `*.ts.net` name.
- Generate the `github-token` SealedSecret with `scripts/generate-arc-github-token-secret.sh`. The script reads the token from 1Password via `${ARC_GITHUB_TOKEN_OP_PATH}` (defaults to `op://infra/github personal token/token`) and writes the sealed manifest to `argocd/applications/arc/github-token.yaml`.

## AMD64 maintenance throttle

The `arc-amd64` scale set is bounded to `minRunners: 0` and `maxRunners: 1` in `application.yaml`. Turin's build scratch,
etcd data, and Ceph monitor data share its `/var` NVMe. Five concurrent builds saturated that device and coincided with
multi-second etcd fsyncs and read timeouts. The cap limits new AMD64 build concurrency while keeping the normal ARC
image/Kargo path available. Existing busy runners finish before the running count falls to one; the
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
