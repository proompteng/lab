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

## Secrets and Registration Token

The runner registration credentials are stored in:

- `sealedsecret-runner-token.yaml` (`SealedSecret`)

Regenerate the sealed secret with a real org runner token before syncing this app:

```bash
cd /Users/gregkonush/.codex/worktrees/f89a/lab
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
- Use [`scripts/check-forgejo-actions-allowlist.sh`](/Users/gregkonush/.codex/worktrees/f89a/lab/scripts/check-forgejo-actions-allowlist.sh) in CI:

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
