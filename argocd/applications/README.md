# ArgoCD Applications

Install `krew` plugin manager for `kubectl`

```bash
brew install krew
```

Update `.zshrc` file

```bash
export PATH="${KREW_ROOT:-$HOME/.krew}/bin:$PATH"
```

Install CloudNativePG plugin to manager postgres clusters

```bash
kubectl krew install cnpg
```

Shell into ecran postgres cluster

```bash
kubectl cnpg psql ecran-cluster -n ecran
```

## Additional Details

### Krew Plugin Manage

`krew` is a plugin manager for `kubectl`, the Kubernetes command-line tool. It allows you to easily discover, install, and manage kubectl plugins.

### CloudNativePG Plugin

The CloudNativePG plugin (`cnpg`) is used to manage PostgreSQL clusters in Kubernetes environments. It provides a set of custom resources and controllers to automate the deployment and management of PostgreSQL clusters.

### Accessing the Ecran PostgreSQL Cluster

The `kubectl cnpg psql` command provides direct access to the PostgreSQL shell of the specified cluster. This is useful for running queries, managing databases, or troubleshooting issues directly on the cluster.

### Environment Variables

Remember to source your `.zshrc` file or restart your terminal session after updating it with the new PATH:

### Temporal

Create a default namespace

```bash
kubectl port-forward -n temporal svc/temporal-frontend-headless 7233:7233
```

Create a namespace

```bash
temporal operator namespace create default
```

### facteur

- Git path: `argocd/applications/facteur`
- Deploys: `argocd/applications/facteur/overlays/cluster`
- Secrets: `facteur-discord`, `facteur-redis` (provide SealedSecrets in `overlays/cluster/secrets.yaml` before enabling sync)
