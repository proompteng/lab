# Tailscale Operator Secrets

Use `scripts/generate-tailscale-sealed-secret.ts` after installing the Tailscale operator to refresh the OAuth client credentials managed by Sealed Secrets. The script:

1. Reads `client_id` and `client_secret` from 1Password via the CLI (`op`).
2. Generates a plain Kubernetes `Secret` and pipes it through `kubeseal` using the controller in the `sealed-secrets` namespace.
3. Overwrites `argocd/applications/tailscale/base/secrets.yaml`; commit the change and let Argo CD sync it.

## Prerequisites

- Logged in to the 1Password CLI (`op`).
- `kubectl` context pointing at the cluster where Sealed Secrets is installed.
- `kubeseal` CLI installed.

## Usage

```bash
# Optional: override default 1Password item paths
export TAILSCALE_OP_CLIENT_ID_PATH="op://infra/tailscale operator/client_id"
export TAILSCALE_OP_CLIENT_SECRET_PATH="op://infra/tailscale operator/client_secret"

# Optional: override controller name/namespace if they differ
export TAILSCALE_SEALED_CONTROLLER_NAME=sealed-secrets
export TAILSCALE_SEALED_CONTROLLER_NAMESPACE=sealed-secrets

# Regenerate the sealed secret (writes to argocd/applications/tailscale/base/secrets.yaml)
./scripts/generate-tailscale-sealed-secret.ts

# Regenerate the sealed secret and write it somewhere else first
./scripts/generate-tailscale-sealed-secret.ts /tmp/tailscale-sealed-secret.yaml
```

After committing the refreshed `secrets.yaml`, Argo CD will reconcile the new credentials automatically.

The same Argo application also carries the operator-managed `Connector` used for
cluster subnet routing. Keep the Connector manifest in this directory aligned
with the live pod and service CIDRs when cluster networking changes.
