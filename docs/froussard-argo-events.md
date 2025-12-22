# Froussard ⇄ Argo Events Integration Notes

Argo Events sensors mutate WorkflowTemplate parameters via `template.k8s.parameters`. Capturing that structure ensures the Kafka payload lands in `spec.arguments` exactly as described in the [Argo Events trigger reference](https://argo-events.readthedocs.io/en/stable/sensors/kubernetes/trigger-reference.html).

## Summary

- **Updated** `argocd/applications/froussard/github-codex-sensor.yaml` to be implementation-only.
- **Updated** `argocd/applications/froussard/components/codex-implementation-argo-fallback/` to include the implementation-only sensor when you need to temporarily hand dispatch back to Argo Events.
- **Result**: Facteur owns the default implementation dispatch path; Argo Events is used only when the fallback component is intentionally enabled.

## Verification Steps

1. Roll the manifests so the trimmed `github-codex` sensor is synced.
2. Verify that Facteur submits `github-codex-implementation` for a Codex issue.
3. To exercise the fallback path, add `components/codex-implementation-argo-fallback/` to the Argo CD Application (or uncomment the component in `kustomization.yaml`), sync, and confirm the implementation trigger appears under the sensor.

## Validation Log (2025-10-31)

- `go test ./services/facteur/...` → ✅ (commit ec517332)
- `kubectl apply -k argocd/applications/froussard` → synced trimmed sensor + supporting manifests
- `kubectl get sensor github-codex -n argo-workflows -o yaml` → dependencies include only `implementation` events (fallback enabled)
