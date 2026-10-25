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
- image: `registry.ide-newton.ts.net/lab/attic@sha256:...`, pinned by the
  Attic release workflow after a Nix-built OCI image passes platform checks

The Attic config uses an explicit allowed-host list:

- `attic.attic.svc.cluster.local`
- `attic.ide-newton.ts.net`

The API deployment runs database migrations in an init container, then starts
`atticd --mode api-server`. Garbage collection runs separately through
`CronJob/attic-gc`.

## Secret Inputs

Create this 1Password item and field in the `infra` vault before rollout:

```text
item: attic-cache
field: token-rs256-secret-base64
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
ATTIC_CACHE_ENDPOINT=https://attic.ide-newton.ts.net nix run .#cache-doctor
# Run this variant only from ARC or another cluster-capable shell.
ATTIC_CACHE_ENDPOINT=http://attic.attic.svc.cluster.local nix run .#cache-doctor
```

## Bootstrap Cache

Bootstrap is an operator action after the service is healthy. The bootstrap
token is short-lived and must stay in the operator shell only.

Create the bootstrap token:

```bash
BOOTSTRAP_TOKEN="$(kubectl -n attic exec deploy/attic -- \
  atticadm make-token \
    --sub bootstrap \
    --validity '2 hours' \
    --pull lab \
    --push lab \
    --create-cache lab \
    --configure-cache lab \
    --configure-cache-retention lab)"
```

Create and publish the cache from the route available to the operator shell:

```bash
ATTIC_BOOTSTRAP_ENDPOINT=http://attic.attic.svc.cluster.local
# Use this endpoint instead when operating from a developer host:
# ATTIC_BOOTSTRAP_ENDPOINT=https://attic.ide-newton.ts.net

attic login lab-bootstrap "$ATTIC_BOOTSTRAP_ENDPOINT" "$BOOTSTRAP_TOKEN"
attic cache create lab || true
attic cache configure lab --public
attic cache info lab
```

Capture the public key from `attic cache info lab` and store it as a GitHub
Actions variable:

```bash
gh variable set ATTIC_PUBLIC_KEY -R proompteng/lab --body '<public-key>'
```

Do not create `ATTIC_TOKEN` during bootstrap. Push credentials are added only in
the main-only push phase.

After bootstrap, prove public pull:

```bash
kubectl -n attic run attic-cache-smoke \
  --rm -i \
  --restart=Never \
  --image=curlimages/curl \
  -- curl -fsSL http://attic.attic.svc.cluster.local/lab/nix-cache-info

curl -fsSL https://attic.ide-newton.ts.net/lab/nix-cache-info
```

Prove Nix can build real repo derivations with the cache configured:

```bash
# ARC or another cluster-capable shell:
NIX_CONFIG=$'extra-substituters = http://attic.attic.svc.cluster.local/lab\nextra-trusted-public-keys = <ATTIC_PUBLIC_KEY>' \
  nix build .#atticd-image --print-build-logs

# Developer host:
NIX_CONFIG=$'extra-substituters = https://attic.ide-newton.ts.net/lab\nextra-trusted-public-keys = <ATTIC_PUBLIC_KEY>' \
  nix build .#atticd-image --print-build-logs
```

The proof path must use a real image derivation such as `.#atticd-image`, not a
synthetic cache-smoke derivation.

## Client Configuration

For a developer host:

```bash
export ATTIC_PUBLIC_KEY='<public key from attic cache info lab>'
export NIX_CONFIG=$'extra-substituters = https://attic.ide-newton.ts.net/lab\nextra-trusted-public-keys = '"${ATTIC_PUBLIC_KEY}"
nix run .#cache-doctor
```

For ARC CI jobs:

```text
substituters = http://attic.attic.svc.cluster.local/lab https://cache.nixos.org/
extra-trusted-public-keys = ${{ vars.ATTIC_PUBLIC_KEY }}
```

Keep Attic first so repo-built closures are attempted before the public cache,
while keeping `cache.nixos.org` as an explicit fallback for upstream Nixpkgs
dependencies.

## Push Boundary

Pushes require `ATTIC_TOKEN` and must be restricted to trusted `main` branch
workflows.

Cache correctness is proven by real Nix image workflows:

- pull requests consume the public Attic cache without `ATTIC_TOKEN`
- `main` builds real image derivations such as `.#atticd-image`
- `main` pushes only those real image output paths to Attic
- `main` also pushes the real OCI helper closures used by that workflow, such
  as `.#inspect-oci-archive`, `.#oci-push`, `.#create-oci-index`,
  `.#assert-oci-platforms`, `.#write-oci-release-contract`, and `.#cache-push`
- registry publication is handled by Skopeo from the Nix-built tarball, not by
  Docker Buildx
- the workflow summary records Attic substitutions, `cache.nixos.org`
  substitutions, local derivation builds, and phase timings for each real image
  run

The default `cache.nixos.org` fallback remains available for Nixpkgs
dependencies, so CI should not duplicate broad upstream Nixpkgs closures into
Attic.

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
