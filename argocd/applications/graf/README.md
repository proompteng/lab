# Graf (Neo4j)

- Managed through the platform `ApplicationSet` (`argocd/applicationsets/platform.yaml`).
- This directory exposes a `kustomization.yaml` that renders the latest Neo4j Helm chart (2025.10.1) via the Kustomize `helmCharts` plugin. The chart now installs its CRDs and uses the `longhorn` storage class for the data volume.
- The Argo CD `graf` application deploys the chart into the `graf` namespace and creates the Helm release named `graf`. It also applies `knative-service.yaml`, which registers the Kotlin persistence service in the same namespace so Temporal/Knative can reach the graph API.
- The Knative service pulls its image from the shared Tailscale registry host `registry.ide-newton.ts.net`.
- A `graf-neo4j-browser` LoadBalancer service is applied alongside the Helm release; it carries `tailscale.com/hostname=graf` so operators can reach the Neo4j Browser via that tailnet DNS name.

Check status:

```bash
kubectl -n argocd get application graf
kubectl -n graf get sts,svc,secret
kubectl -n graf get ksvc graf-service
kubectl -n graf get svc graf-neo4j-browser
```
