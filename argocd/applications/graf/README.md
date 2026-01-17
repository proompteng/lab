# Graf (Neo4j)

- Managed through the platform `ApplicationSet` (`argocd/applicationsets/platform.yaml`).
- This directory exposes a `kustomization.yaml` that renders the latest Neo4j Helm chart (2025.10.1) via the Kustomize `helmCharts` plugin. The chart now installs its CRDs and uses the `longhorn` storage class for the data volume.
- The Argo CD `graf` application deploys the chart into the `graf` namespace and creates the Helm release named `graf`. It also applies `knative-service.yaml`, which registers the Kotlin persistence service in the same namespace so Temporal/Knative can reach the graph API.
- The Knative service pulls its image from the shared Tailscale registry host `registry.ide-newton.ts.net/proompteng/graf:latest`.
- A `graf-neo4j-browser` LoadBalancer service is applied alongside the Helm release; it carries `tailscale.com/hostname=neo4j` so operators can reach the Neo4j Browser via that tailnet DNS name.
- The Graf API Knative service is exposed through a Tailscale LoadBalancer at host `graf`.
- Neo4j credentials live in the `graf-auth` SealedSecret checked in as `graf-auth-secret.yaml`; the Helm values reference it via `neo4j.passwordFromSecret`. Rotate them by generating a new password, updating the sealed secret, and applying it before syncing Argo CD.
- The `/v1` graph APIs now require a bearer token. The Knative service reads `GRAF_API_BEARER_TOKENS` from the `graf-api` SealedSecret defined in `graf-api-secret.yaml` (`bearer-tokens` key, comma or newline separated). The checked-in manifest currently contains a placeholder (`REPLACE_WITH_ACTUAL_TOKENS`), so re-seal it with the real tokens before the next sync:
- The Codex workflow template and its RBAC helpers live in `argocd/applications/argo-workflows` because they must stay in the `argo-workflows` namespace; they are no longer rendered through this `graf` kustomization.

  ```bash
  cat <<'YAML' > /tmp/graf-api-secret.yaml
  apiVersion: v1
  kind: Secret
  metadata:
    name: graf-api
    namespace: graf
  type: Opaque
  stringData:
    bearer-tokens: "<token1>,<token2>"
  YAML

  kubeseal --controller-name sealed-secrets \
    --controller-namespace sealed-secrets \
    --format yaml \
    -f /tmp/graf-api-secret.yaml \
    > argocd/applications/graf/graf-api-secret.yaml

  rm /tmp/graf-api-secret.yaml
  git add argocd/applications/graf/graf-api-secret.yaml
  ```

  Unauthenticated requests to `/v1/*` now return 401 while `/` and `/healthz` remain open for probes.

Check status:

```bash
kubectl -n argocd get application graf
kubectl -n graf get sts,svc,secret
kubectl -n graf get ksvc graf
kubectl -n graf get svc graf-neo4j-browser
```
