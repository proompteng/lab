# SpiceDB operator

The platform ApplicationSet installs the upstream SpiceDB operator in the `spicedb-operator` namespace.
The operator watches `SpiceDBCluster` resources across the cluster. This application installs its controller,
RBAC, update graph, and CRD. A SpiceDB database, credentials, and permission schema require a separate application.

## Release

- Upstream bundle: [v1.27.0](https://github.com/authzed/spicedb-operator/releases/tag/v1.27.0).
- Bundle SHA-256: `4b8b8d3697f1b714f9d15d74952b7350200e0511f1793a435b0147758f67d4cc`.
- Image: `ghcr.io/authzed/spicedb-operator:v1.27.0`, pinned to its multi-architecture digest in `kustomization.yaml`.
- Supported image platforms: `linux/amd64` and `linux/arm64`.

The upstream controller runs as a non-root user with a read-only filesystem and dropped capabilities.
The ApplicationSet applies the restricted Pod Security policy and creates the namespace.
Kustomize removes the upstream Namespace resource so the child Application does not own it.
The namespace and CRD are retained during Argo pruning or Application deletion.

## Validate

Run these commands from the repository root:

```bash
nix develop -c kustomize build argocd/applications/spicedb-operator > /tmp/spicedb-operator.yaml
nix develop -c scripts/kubeconform.sh /tmp/spicedb-operator.yaml argocd/applicationsets/platform.yaml
nix develop -c bun run lint:argocd
```

The render must contain one Deployment, one CRD, one ConfigMap, one ServiceAccount, three ClusterRoles,
and one ClusterRoleBinding. It must not contain a Namespace or a SpiceDBCluster.

## Rollout and recovery

Merge the reviewed GitOps change before deployment. The root Application reconciles the platform ApplicationSet,
which creates the operator Application. The child uses native Kustomize and server-side apply with automatic sync.
Argo installs the CRD and RBAC before starting the controller. This upstream operator follows the existing platform
bundle installation pattern and does not use a repository-owned image build or a Kargo Stage.

After an authorized rollout, verify the exact Argo revision, CRD registration, controller image, and startup logs:

```bash
kubectl --context galactic-tailscale -n argocd get application spicedb-operator
kubectl --context galactic-tailscale -n spicedb-operator get crd spicedbclusters.authzed.com
kubectl --context galactic-tailscale -n spicedb-operator rollout status deployment/spicedb-operator --timeout=60s
kubectl --context galactic-tailscale -n spicedb-operator get pods -l app=spicedb-operator -o wide
kubectl --context galactic-tailscale -n spicedb-operator logs deployment/spicedb-operator --tail=100
```

A successful installation registers the `authzed.com/v1alpha1` API and starts the operator watches without errors.
Permission checks require a separately provisioned SpiceDBCluster and are not part of operator acceptance.

For an upgrade failure, revert the bundle and image pins together through a reviewed Git change after checking
upstream downgrade compatibility. Before uninstalling, account for every SpiceDBCluster. Removing the CRD deletes
its custom resources, so CRD deletion requires a separate, explicit action.
