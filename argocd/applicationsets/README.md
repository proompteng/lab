# Bootstrap

Install the Argo CD CLI:

```bash
brew install argocd
```

Prepare the cluster resources required by Harvester:

```bash
k --kubeconfig ~/.kube/altra.yaml apply -f tofu/harvester/templates/
```

Lay down MetalLB so LoadBalancer services (Traefik, registry, etc.) receive an address range:

```bash
kubectl apply -k argocd/applications/metallb-system
kubectl -n metallb-system rollout status deploy/controller --timeout=180s
kubectl -n metallb-system rollout status ds/speaker --timeout=300s
```

## Deploy Argo CD itself

Apply the Argo CD manifests with Kustomize to get the control plane and Lovely plugin online:

```bash
k apply -k argocd/applications/argocd
```

Retrieve the initial admin password, log in, and rotate credentials:

```bash
argocd admin initial-password -n argocd
argocd login argocd.proompteng.ai --grpc-web
argocd account update-password --account admin --server argocd.proompteng.ai
```

Add this repository to Argo CD:

```bash
argocd repo add https://github.com/proompteng/lab.git
```

Then transfer control of Sealed Secrets to Argo CD:

```bash
argocd app sync sealed-secrets
```

> **Note:** Avoid manual `kubectl` installs of Sealed Secrets. Bootstrapping the controller outside Argo CD generates a new RSA keypair, and the next sync will break every existing `SealedSecret` (`no key could decrypt secret`). Let Argo CD create and manage the controller after this first sync.

## Stage-based ApplicationSets

The repo now provides four staged ApplicationSets:

- `bootstrap.yaml` (core prerequisites)
- `platform.yaml` (shared infrastructure & tooling)
- `product.yaml` (product-facing workloads)
- `cdk8s.yaml` (TypeScript-driven CMP workloads powered by the cdk8s plugin)

Sync the `root` Application to register the staged sets:

```bash
argocd app create root --file argocd/root.yaml
argocd app sync root
```

Preview what each stage would create before syncing:

```bash
argocd appset preview --app bootstrap --output table
```

Sync individual stages when you are ready:

```bash
argocd appset create --upsert argocd/applicationsets/bootstrap.yaml
argocd appset create --upsert argocd/applicationsets/platform.yaml
argocd appset create --upsert argocd/applicationsets/product.yaml
argocd appset create --upsert argocd/applicationsets/cdk8s.yaml
```

Need only the core bootstrap stack? Stop after the first command—leave the other stages for later.

All generated Applications default to manual sync. Promote a workload by running `argocd app sync <name>`. Once stable, flip its `automation` value to `auto` inside the relevant stage file to enable automatic reconcilation.

### Cluster targeting

Each ApplicationSet element can optionally define a `clusters` value:

- `in-cluster` (default when omitted)
- `ryzen`
- `all` (installs to both)

When targeting `ryzen`, the Application destination uses the Argo CD cluster name `ryzen`.

## Crossplane (platform stage)

Crossplane is installed via the `platform.yaml` ApplicationSet. Keep automation set to `manual` until the install is validated.

Apply Crossplane via kubectl (Codex deployment step uses the same sequence):

```bash
kubectl create namespace crossplane-system --dry-run=client -o yaml | kubectl apply -f -
helm repo add crossplane https://charts.crossplane.io/stable
helm repo update
helm template crossplane crossplane/crossplane \
  --version 2.1.3 \
  --namespace crossplane-system \
  --include-crds | kubectl apply -n crossplane-system -f -
kubectl -n crossplane-system rollout status deployment/crossplane --timeout=600s
kubectl -n crossplane-system wait --for=condition=Ready pod -l app.kubernetes.io/name=crossplane --timeout=600s
```

Validation:

- `argocd app get crossplane` reports Synced/Healthy.
- `kubectl get pods -n crossplane-system` shows all Crossplane pods Ready.
- Crossplane chart version is pinned to `2.1.3`.

### Bringing the control plane up before Dex is ready

Dex relies on Sealed Secrets to decrypt the Argo Workflows SSO credentials. When rebuilding a cluster you can bring Argo CD online first and delay Dex until Sealed Secrets and Argo Workflows are configured.

1. Disable the Dex deployment (scales to zero and removes its network policy):
   ```bash
   bun scripts/disable-dex.ts --disable
   ```
   Pass `--namespace <ns>` if Argo CD runs outside the default `argocd` namespace, or add `--dry-run` to preview the kubectl commands.

2. After Sealed Secrets is healthy and the SSO secrets have been applied, re-enable Dex:
   ```bash
   bun scripts/restore-dex.ts
   # optionally: bun scripts/restore-dex.ts --sync
   # or: bun scripts/disable-dex.ts --enable
   # or: kubectl -n argocd scale deployment argocd-dex-server --replicas=1
   ```
   Use `--sync` to call `argocd app sync` automatically; otherwise sync the `argocd` application manually so the network policy and overlays reconcile.

### Removing stuck Applications

Should an Application get stuck in a deleting phase, drop the finalizers:

```bash
kubectl get application -n argocd
kubectl edit application
```

Remove the `finalizers` array from the spec and save.
