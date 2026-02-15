# Bootstrap

Prereqs:
1. Kubernetes is up and reachable via `kubectl`.
1. At least one node is `Ready`.

Install the Argo CD CLI:

```bash
brew install argocd
```

Prepare the cluster resources required by Harvester:

```bash
k --kubeconfig ~/.kube/altra.yaml apply -f tofu/harvester/templates/
```

## MetalLB (when to install)

Install MetalLB any time after the cluster is reachable, and before you sync
any Applications that create `Service` resources of type `LoadBalancer`
(Traefik, registry, etc.). Argo CD itself can be installed without MetalLB,
but anything waiting on a `LoadBalancer` IP will stay pending until MetalLB is
up.

If you expose Argo CD via a `LoadBalancer` Service, install MetalLB first.

Install:

```bash
kubectl apply -k argocd/applications/metallb-system
kubectl -n metallb-system rollout status deploy/controller --timeout=180s
kubectl -n metallb-system rollout status ds/speaker --timeout=300s
```

## Traefik (IngressRoute CRDs)

This repo uses Traefik `IngressRoute` resources (`apiVersion: traefik.io/v1alpha1`) in multiple apps, including the Argo CD install:
- `argocd/applications/argocd/base/ingressroute.yaml`

On a brand new cluster, install Traefik's CRDs before applying `argocd/applications/argocd`:

```bash
kubectl apply --server-side --force-conflicts -k https://github.com/traefik/traefik-helm-chart/traefik/crds/?ref=v39.0.1
kubectl get crd ingressroutes.traefik.io
```

Traefik itself is managed as an Argo CD Application:
- `argocd/applications/traefik`
- enabled by default in `argocd/applicationsets/bootstrap.yaml`

## Deploy Argo CD itself

## Install the ApplicationSet CRD (avoid `annotations too long`)

The upstream `applicationsets.argoproj.io` CRD can be large enough that `kubectl apply` fails with:

`metadata.annotations: Too long: may not be more than 262144 bytes`

Recommended (server-side apply):

```bash
kubectl apply --server-side -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.3.0/manifests/crds/applicationset-crd.yaml
```

Fallback (create-only):

```bash
curl -fsSL https://raw.githubusercontent.com/argoproj/argo-cd/v3.3.0/manifests/crds/applicationset-crd.yaml | kubectl create -f -
```

Verify:

```bash
kubectl get crd applicationsets.argoproj.io
```

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
