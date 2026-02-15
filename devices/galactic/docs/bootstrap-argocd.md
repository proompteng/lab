# Bootstrap Argo CD (galactic)

This runbook documents how to bring up Argo CD on the `galactic` cluster in a way that is repeatable and avoids common bootstrap pitfalls.

## Prereqs

1. `kubectl` can reach the cluster (context `galactic`).
1. Core components are healthy:
   - `kubectl get nodes`
   - `kubectl -n kube-system get pods | rg -n 'coredns|kube-flannel|kube-proxy'`

If Argo CD pods are failing with Redis timeouts or probe failures, fix networking first:
- `devices/galactic/docs/troubleshooting-networking.md`

## Install the ApplicationSet CRD first

Symptoms when missing:
- `argocd-applicationset-controller` CrashLoopBackOff.
- Logs contain: `no matches for kind "ApplicationSet" in version "argoproj.io/v1alpha1"`.

The upstream `applicationsets.argoproj.io` CRD can be large enough that `kubectl apply` fails with:

`CustomResourceDefinition.apiextensions.k8s.io "applicationsets.argoproj.io" is invalid: metadata.annotations: Too long: may not be more than 262144 bytes`

This is typically caused by `kubectl apply` trying to store the full object in the `kubectl.kubernetes.io/last-applied-configuration` annotation.

Recommended (server-side apply, avoids last-applied annotation):

```bash
kubectl apply --server-side -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.3.0/manifests/crds/applicationset-crd.yaml
```

Fallback (create-only, avoids last-applied annotation):

```bash
curl -fsSL https://raw.githubusercontent.com/argoproj/argo-cd/v3.3.0/manifests/crds/applicationset-crd.yaml | kubectl create -f -
```

Verify:

```bash
kubectl get crd applicationsets.argoproj.io
```

## Install Traefik CRDs (required by this repo's Argo CD manifests)

This repo's Argo CD install includes `IngressRoute` resources (Traefik CRDs):
- `argocd/applications/argocd/base/ingressroute.yaml`

On a fresh cluster, applying `argocd/applications/argocd` will fail until the Traefik CRDs exist.

Install the CRDs (pinned to the chart version we deploy):

```bash
kubectl apply --server-side --force-conflicts -k https://github.com/traefik/traefik-helm-chart/traefik/crds/?ref=v39.0.1
```

Verify:

```bash
kubectl get crd ingressroutes.traefik.io
```

## Deploy Argo CD

Apply the repo-managed Argo CD manifests:

```bash
kubectl apply -k argocd/applications/argocd
```

Wait for Argo CD control plane to be up:

```bash
kubectl -n argocd get pods
kubectl -n argocd rollout status deploy/argocd-server --timeout=180s
kubectl -n argocd rollout status deploy/argocd-repo-server --timeout=300s
```

## Access the UI (no ingress)

Port-forward:

```bash
kubectl -n argocd port-forward svc/argocd-server 8080:80
```

Then open `http://127.0.0.1:8080`.

## Credentials

Get the initial admin password:

```bash
argocd admin initial-password -n argocd
```

## Next steps

1. Register the repo and create the root Application:
   - `argocd/applicationsets/README.md`
1. Install stage-based ApplicationSets once the prerequisites (CRDs, MetalLB, etc.) are in place:
   - `argocd/applicationsets/bootstrap.yaml`
