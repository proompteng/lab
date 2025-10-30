# Froussard ⇄ Argo Events Integration Notes

Argo Events sensors mutate WorkflowTemplate parameters via `template.k8s.parameters`. Capturing that structure ensures the Kafka payload lands in `spec.arguments` exactly as described in the [Argo Events trigger reference](https://argo-events.readthedocs.io/en/stable/sensors/kubernetes/trigger-reference.html).

## Summary

- **Updated** `argocd/applications/froussard/github-codex-sensor.yaml` to remove the planning dependency/trigger. Planning workflows are now dispatched by Facteur when `FACTEUR_CODEX_ENABLE_PLANNING_ORCHESTRATION` is set.
- **Added** `argocd/applications/froussard/components/codex-planning-argo-fallback/`, a Kustomize component that re-instates the planning dependency/trigger if the service flag is disabled and Argo Events needs to resume ownership.
- **Result**: Implementation and review stages continue to flow through the sensor. Planning runs originate from Facteur by default while the fallback component provides a documented rollback path.

## Verification Steps

1. Roll the manifests so the trimmed `github-codex` sensor is synced.
2. Enable planning orchestration on Facteur (`FACTEUR_CODEX_ENABLE_PLANNING_ORCHESTRATION=true`) and replay a planning payload with `curl` as described in `docs/codex-workflow.md`.
3. Verify that Argo submits `github-codex-planning` via the Facteur orchestrator and that the `github-codex` sensor did not create a duplicate workflow.
4. To exercise the fallback path, add `components/codex-planning-argo-fallback/` to the Argo CD Application (or uncomment the component in `kustomization.yaml`), sync, and confirm the planning trigger reappears under the sensor.
