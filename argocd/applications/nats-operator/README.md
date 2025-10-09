# NATS Operator

- Managed by the platform `ApplicationSet` (`argocd/applicationsets/platform.yaml`) which generates the Argo CD `Application` pointing at this path.
- This kustomization renders the upstream [NATS Operator](https://github.com/nats-io/nats-operator) Helm chart (v0.8.3) via the Kustomize `helmCharts` plugin and disables the example NATS cluster.
- Do **not** add nested `Application` manifests here; let the `ApplicationSet` continue owning the Argo CD `Application` resource.
- Controller namespace: `nats-operator` (auto-created by Argo CD sync).

Check status:

```bash
kubectl -n argocd get application nats-operator
kubectl -n nats-operator get deploy,pod
```
