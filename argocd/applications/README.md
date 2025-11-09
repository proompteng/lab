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
- Deploys: `argocd/applications/facteur/overlays/cluster` (kustomize apply managed by Argo CD)
- Secrets: `facteur-discord`, `facteur-redis` (provide updated SealedSecrets in `overlays/cluster/secrets.yaml` before enabling sync)
- Helper scripts: `bun packages/scripts/src/facteur/deploy-service.ts` (build/push Knative image + apply overlay), `bun packages/scripts/src/facteur/reseal-secrets.ts`

### froussard

- Git path: `argocd/applications/froussard`
- Deploys: manifest bundle rooted at `argocd/applications/froussard` (Argo Workflow sensors, Kafka event sources, Knative service). Use `pnpm run froussard:deploy` (invokes `packages/scripts/src/froussard/deploy-service.ts`) for local rollouts.
- Secrets: `github-secret`, `github-token`, `discord-bot`, `discord-codex-bot`, `kafka-username-secret`. Update via `bun packages/scripts/src/froussard/reseal-secrets.ts`.
- Notes: Froussard depends on Argo Events (topics under `components/`), so keep the Kafka topics + sensors in sync when updating the service image.

### graf

- Git path: `argocd/applications/graf`
- Deploys: `kubectl kustomize --enable-helm argocd/applications/graf | kubectl apply -f -` (Argo CD runs the same render; Helm release `neo4j` plus Knative service)
- Secrets: `graf-auth` (Neo4j credentials). Managed as a plain Secret referenced by the Knative service.
- Helper script: `bun packages/scripts/src/graf/deploy-service.ts` builds/pushes the Kotlin image, writes the digest back to `knative-service.yaml`, and runs `kn service apply`.
- Neo4j notes: the Helm release is published as `graf-db`, so Bolt/HTTP clients should use `graf-db.graf.svc.cluster.local` while Knative owns `Service/graf`.
