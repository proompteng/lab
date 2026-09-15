# Forgejo Runners Argo CD App

This app deploys production Forgejo Actions runners in Kubernetes using a dual-arch layout:

- `forgejo-runners-amd64` (`kubernetes.io/arch=amd64`)
- `forgejo-runners-arm64` (`kubernetes.io/arch=arm64`)

Both shards run:

- one registration init container (`forgejo-runner register --no-interactive`)
- one runner daemon container (`forgejo-runner daemon`)
- one privileged `docker:dind` sidecar for Docker-based workflows

## Runner Labels

- amd64 shard: `ubuntu-latest:docker://ghcr.io/catthehacker/ubuntu:act-latest`, `docker:docker://ghcr.io/catthehacker/ubuntu:act-latest`
- arm64 shard: `ubuntu-24.04-arm64:docker://ghcr.io/catthehacker/ubuntu:act-latest`, `docker-arm64:docker://ghcr.io/catthehacker/ubuntu:act-latest`
- The shared `configmap-runner.yaml` must not set `runner.labels`; labels are injected only through each shard's `RUNNER_LABELS` registration env so amd64 and arm64 do not advertise the same queues.

## Secrets and Registration Token

The runner registration credentials are stored in:

- `sealedsecret-runner-token.yaml` (`SealedSecret`)

Regenerate the sealed secret with a real org runner token before syncing this app:

```bash
cd <repo-root>
scripts/seal-generic-secret.sh \
  forgejo-runners \
  forgejo-runners-token \
  argocd/applications/forgejo-runners/sealedsecret-runner-token.yaml \
  FORGEJO_INSTANCE_URL=https://code.proompteng.ai \
  FORGEJO_RUNNER_REGISTRATION_TOKEN='<ORG_RUNNER_TOKEN>' \
  RUNNER_NAME_PREFIX=forgejo-runners \
  RUNNER_LABELS='ubuntu-latest:docker://ghcr.io/catthehacker/ubuntu:act-latest,docker:docker://ghcr.io/catthehacker/ubuntu:act-latest'
```

## Forgejo-Only Action Supply Chain

Use Forgejo-hosted mirrored actions only. Do not reference GitHub-hosted actions directly in production workflows.

### Action allowlist (maintain this table)

| Action repo | Pinned SHA | Owner | Last review |
| --- | --- | --- | --- |
| `code.proompteng.ai/kalmyk/actions-checkout` | `TBD` | `kalmyk` | `TBD` |
| `code.proompteng.ai/kalmyk/actions-setup-node` | `TBD` | `kalmyk` | `TBD` |
| `code.proompteng.ai/kalmyk/actions-cache` | `TBD` | `kalmyk` | `TBD` |

### Policy requirements

- Workflow action references must be pinned to full commit SHA.
- Workflow action references must exist in the internal allowlist.
- Mirror refresh cadence: monthly and emergency refresh as needed.
- Use [`scripts/check-forgejo-actions-allowlist.sh`](../../../scripts/check-forgejo-actions-allowlist.sh) in CI:

```bash
scripts/check-forgejo-actions-allowlist.sh .forgejo/workflows argocd/applications/forgejo-runners/actions-allowlist.txt
```

## Rollout

1. Sync Forgejo app with actions enabled (`DEFAULT_ACTIONS_URL` set to Forgejo-hosted actions source).
2. Mirror required actions into Forgejo and pin SHAs.
3. Generate org runner token and reseal `forgejo-runners-token`.
4. Sync `forgejo-runners` Argo CD app.
5. Verify both shards are online in Forgejo Actions UI.
6. Run smoke workflows for amd64 and arm64 labels.

## Post-sync checks

```bash
kubectl -n forgejo-runners get pods
kubectl -n forgejo-runners get statefulset
kubectl -n forgejo-runners logs statefulset/forgejo-runners-amd64 -c runner --tail=200
kubectl -n forgejo-runners logs statefulset/forgejo-runners-arm64 -c runner --tail=200
```

## Smoke workflow example

```yaml
name: runners-smoke
on:
  workflow_dispatch:

jobs:
  amd64:
    runs-on: ubuntu-latest
    steps:
      - uses: code.proompteng.ai/kalmyk/actions-checkout@<PINNED_SHA>
      - run: docker version

  arm64:
    runs-on: ubuntu-24.04-arm64
    steps:
      - uses: code.proompteng.ai/kalmyk/actions-checkout@<PINNED_SHA>
      - run: docker version
```


## Runner 13 and Docker 29 rollout

The fleet uses Forgejo Runner 13.1.0 and Docker 29.8.0 on both architectures,
with immutable multi-architecture image digests. Docker retains the classic
`overlay2` image store explicitly. Docker is a Kubernetes native sidecar: its
startup probe must pass before the runner starts, and Kubernetes keeps it alive
until the runner has stopped. The runner allows 3h5m for graceful shutdown and
the Pod allows 3h10m, covering the configured 3h job timeout and cleanup.
AMD64 reconciles before ARM64. Original registration files, tokens, runner IDs,
labels and data PVCs are retained; registration is skipped when `/data/.runner`
already exists.

The initial transition starts from ordinary Docker and runner containers, whose
shutdown is unordered. Before enabling the new ApplicationSet registration,
use each existing runner's authenticated `RunnerService/Declare` endpoint to
replace its advertised labels temporarily with a unique maintenance label.
Keep the runner daemon and Docker running while its already assigned jobs finish.
Wait beyond the existing 30-second fetch timeout and verify that neither runner
has active assigned tasks before reconciling the exact merged root revision.
Do not delete registrations, change tokens, cancel builds or stop Docker to drain.
The new daemon reads the original registration file and advertises its original
labels automatically. If rollout is abandoned, wait for assigned jobs to finish and gracefully
restart only the idle runner process while leaving Docker running. The daemon
then redeclares its original labels and starts a fresh polling cursor with the
same registration. Verify labels and recent heartbeats for runner IDs 4 and 5 after rollout, plus the original PVC/Secret and
registration-file identities.

Before this transition, Docker 29.8.0 was tested on both native architectures with
an isolated daemon, imported image, container execution and cleanup. The workflow
compatibility audit covered the existing Bilig and Tsag workflow definitions.
Live acceptance must additionally execute a non-publishing local workflow through
the new runner and Docker daemon on each architecture.

Sources: [Runner 13 changes](https://forgejo.org/2026-08-runner-release-v13/),
[Docker 29 storage behavior](https://docs.docker.com/engine/storage/containerd/),
[Kubernetes native sidecar lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/).
