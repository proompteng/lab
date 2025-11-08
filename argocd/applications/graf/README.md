# Graf (Neo4j)

- Managed through the platform `ApplicationSet` (`argocd/applicationsets/platform.yaml`).
- This directory exposes a `kustomization.yaml` that renders the latest Neo4j Helm chart (2025.10.1) via the Kustomize `helmCharts` plugin.
- The Argo CD `graf` application deploys the chart into the `graf` namespace and creates the Helm release named `graf`.

Check status:

```bash
kubectl -n argocd get application graf
kubectl -n graf get sts,svc,secret
```
