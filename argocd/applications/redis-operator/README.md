# Redis Operator

- Managed via the platform `ApplicationSet` (`argocd/applicationsets/platform.yaml`) which generates the Argo CD `Application` for this path.
- This directory now exposes a `kustomization.yaml` that renders the [OT-Container-Kit Redis Operator](https://github.com/OT-CONTAINER-KIT/redis-operator) Helm chart (v0.25.0) via the Kustomize `helmCharts` plugin.
- Do **not** add nested `Application` manifests here; let the `ApplicationSet` continue owning the Argo CD `Application` resource.
- Controller namespace: `redis-operator` (auto-created by Argo CD sync).

Check status:

```bash
kubectl -n argocd get application redis-operator
kubectl -n redis-operator get deploy,pod
```
