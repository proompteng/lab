# Lab Nix Cache

Attic is the lab Nix binary cache. It stores Nix store outputs so ARC CI and
developer machines can reuse toolchain and helper derivations instead of
rebuilding them.

Supported endpoints:

- In-cluster and ARC CI: `http://attic.attic.svc.cluster.local/lab`
- Developer host over Tailscale: `https://attic.ide-newton.ts.net/lab`

Only those endpoints are part of this rollout. Do not add a second DNS-backed
ingress path in this phase.

## Server

The GitOps app is `argocd/applications/attic` in namespace `attic`.

Backends:

- database: `Cluster/attic-db`, app secret `attic-db-app`
- object storage: `ObjectBucketClaim/attic-cache`
- signing key: `ExternalSecret/attic-secrets`
- image: `registry.ide-newton.ts.net/lab/attic:latest`

The Attic config uses an explicit allowed-host list:

- `attic.attic.svc.cluster.local`
- `attic.ide-newton.ts.net`

The API deployment runs database migrations in an init container, then starts
`atticd --mode api-server`. Garbage collection runs separately through
`CronJob/attic-gc`.

## Secret Inputs

Create the 1Password item in the `infra` vault before rollout:

```text
attic-cache/token-rs256-secret-base64
```

Generate the value with:

```bash
openssl genrsa -traditional 4096 | base64 | tr -d '\n'
```

Do not commit the generated value and do not paste it into PR text.

The CI push token is not part of the service rollout. Add it only after the
cache exists, public pull is verified, and main-only push wiring is ready.

## Operator Checks

Cluster health:

```bash
kubectl -n argocd get application attic -o json | jq '{sync:.status.sync.status, health:.status.health.status, revision:.status.sync.revision}'
kubectl -n attic get deploy,pod,svc,ingress,externalsecret,objectbucketclaim
kubectl -n attic get cluster attic-db
```

In-cluster endpoint:

```bash
kubectl -n attic run attic-cache-smoke \
  --rm -i \
  --restart=Never \
  --image=curlimages/curl \
  -- curl -fsSL http://attic.attic.svc.cluster.local/lab/nix-cache-info
```

Host endpoint:

```bash
curl -fsSL https://attic.ide-newton.ts.net/lab/nix-cache-info
```

Local doctor:

```bash
nix run .#cache-doctor
ATTIC_CACHE_URL=http://attic.attic.svc.cluster.local/lab nix run .#cache-doctor
```

## Client Configuration

For a developer host:

```bash
export ATTIC_PUBLIC_KEY='<public key from attic cache info lab>'
export NIX_CONFIG=$'extra-substituters = https://attic.ide-newton.ts.net/lab\nextra-trusted-public-keys = '"${ATTIC_PUBLIC_KEY}"
nix run .#cache-doctor
```

For ARC CI jobs:

```text
extra-substituters = http://attic.attic.svc.cluster.local/lab
extra-trusted-public-keys = ${{ vars.ATTIC_PUBLIC_KEY }}
```

Use `extra-*` settings so the default `cache.nixos.org` fallback remains
available.

## Push Boundary

Pushes require `ATTIC_TOKEN` and must be restricted to trusted `main` branch
workflows.

The helper refuses to run without a token:

```bash
export ATTIC_CACHE_ENDPOINT=http://attic.attic.svc.cluster.local
export ATTIC_CACHE_NAME=lab
# Set ATTIC_TOKEN in the shell environment before invoking the helper.
nix run .#cache-push -- ./result
```

Pull request workflows must not receive `ATTIC_TOKEN`.

## Container Build Boundary

Attic caches Nix store paths. It does not directly cache Docker layers,
`bun install`, `pip install`, image export, or registry push time. Container
build acceleration remains a separate BuildKit and Dockerfile optimization
phase.
