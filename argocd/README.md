# ArgoCD Applications

This directory contains the ArgoCD application configurations for deploying applications to Kubernetes clusters.

## Structure

```
argocd/
├── applications/     # Individual application manifests
│   ├── kitty-krew/   # Example of kustomize-based application
│   │   ├── base/     # Base resources
│   │   ├── overlays/ # Environment-specific overlays
│   │   └── kustomization.yaml  # Root kustomization
│   └── ...
├── applicationsets/  # ApplicationSet definitions
└── root.yaml         # Root application
```

## Bootstrap Prerequisites

- **Redis auth secret**: The upstream HA manifest expects a `argocd/argocd-redis` secret with the `auth` key. On a fresh cluster create it before the first sync:

  ```bash
  openssl rand -base64 32 | tr -d '\n' | \
    kubectl -n argocd create secret generic argocd-redis --from-literal=auth="$(cat)"
  ```

  Prefer a managed source (SealedSecret, ExternalSecret, etc.) for long-term storage; the imperative command above is a one-time bootstrap.

## ApplicationSets

The [root Application](root.yaml) loads the definitions in `applicationsets/`. The
[bootstrap](applicationsets/bootstrap.yaml), [platform](applicationsets/platform.yaml), and
[product](applicationsets/product.yaml) ApplicationSets use explicit lists, not directory discovery. A directory under
`applications/` is not deployed just because it exists.

Keep these directories even though they are not direct Application sources:

- [ClickHouse upgrade acceptance](applications/clickhouse-upgrade-acceptance/README.md) contains the isolated ClickHouse
  and Keeper rehearsals and tests used by the [upgrade runbook](../docs/runbooks/clickhouse-final-stable-upgrades.md).
- [PostgreSQL upgrade acceptance](applications/postgres-upgrade-acceptance/README.md) contains the retained-snapshot
  recovery rehearsal and the readiness gate exercised by the [PostgreSQL gate tests](../scripts/cluster-upgrades/postgres_upgrade_gate_test.py).
- [Storage upgrade acceptance](applications/storage-upgrade-acceptance/README.md) contains the RBD, CephFS, and RGW
  canaries exercised by the [Rook upgrade contract tests](../packages/scripts/src/shared/__tests__/rook-upgrade-contract.test.ts).
- [`symphony-base`](applications/symphony-base/) is used by the Symphony overlays and watched by the
  [Symphony Kargo Warehouse](applications/kargo/warehouses.yaml).

## Bootstrap MetalLB

MetalLB stays manual because it owns cluster-critical networking. On a fresh or rebuilt cluster, follow the bounded,
context-aware **Bootstrap MetalLB before the root handoff** gate in `devices/galactic/docs/bootstrap-argocd.md`. Do not
use a direct manifest apply as a normal reconciliation path after the root Application adopts the resources.

## Kustomize Approach (kitty-krew)

The `kitty-krew` application demonstrates a reusable pattern using Kustomize for managing multi-environment deployments:

### Base Resources

The `base/` directory contains the foundational resources:

- `deployment.yaml` - Base deployment configuration
- `service.yaml` - Service definition
- `configmap.yaml` - Common configuration values
- `kustomization.yaml` - Lists all resources and common labels

### Environment Overlays

The `overlays/` directory contains environment-specific configurations:

- `dev/` - Development environment
- `prod/` - Production environment

Each overlay:

1. References the base resources
2. Applies environment-specific patches
3. Sets appropriate image tags
4. Configures environment-specific values

### Root Kustomization

The root `kustomization.yaml` references the dev overlay by default:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - overlays/dev # Default to dev overlay
```

## Using the Pattern for New Applications

To create a new application using this pattern:

1. Copy the `kitty-krew` directory structure to a new directory with your application name
2. Update resource names, labels, and selectors
3. Modify environment-specific configurations in the overlays
4. Add an enabled entry to the appropriate ApplicationSet with the new source path

## Switching Environments

To switch from dev to production:

```yaml
# In your-app/kustomization.yaml
resources:
  - overlays/prod # Switch to prod overlay
```

## Best Practices

- Keep base configurations minimal and reusable
- Use overlays for environment-specific configurations
- Use strategic patches to only specify changing values
- Define resource limits appropriately for each environment
- Keep root kustomization.yaml pointing to dev by default
- Use ConfigMaps for application configuration
- Follow naming conventions consistently

## Debugging

To debug application deployment:

```bash
# Preview what will be deployed (dev)
kubectl kustomize argocd/applications/kitty-krew

# Preview production overlay
kubectl kustomize argocd/applications/kitty-krew/overlays/prod
```

### Private Docker registry credentials (with 1Password CLI)

- **Install 1Password CLI (macOS)**

```bash
brew install 1password-cli
op --version
# Sign in (interactive) so `op read` works in your shell
op signin
```

- **Registry access**

  The Tailscale registry at `registry.ide-newton.ts.net` allows anonymous pulls, so no `docker-registry` secrets are required in `argocd` or workload namespaces. Prune any legacy `registry` or `kalmyk-registry` secrets before syncing.
