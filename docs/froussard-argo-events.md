# Froussard ⇄ Argo Events Integration Notes

Argo Events sensors mutate WorkflowTemplate parameters via `template.k8s.parameters`. Capturing that structure ensures the Kafka payload lands in `spec.arguments` exactly as documented upstream.citehttps://argo-events.readthedocs.io/en/stable/sensors/kubernetes/trigger-reference.html

## Summary

- **Updated** `argocd/applications/froussard/github-codex-sensor.yaml:43` so that the
  sensor's trigger parameters live under `template.k8s.parameters`. This ensures Argo Events
  mutates the Kubernetes Workflow resource with the CloudEvent payload instead of modifying
  the trigger template structure.
- **Result**: Workflows spawned by the sensor now receive the full webhook JSON payload in
  `spec.arguments.parameters[0]` (`rawEvent`) and `spec.arguments.parameters[1]` (`eventBody`),
  eliminating the previous `{}` values.

## Verification Steps

1. Apply the manifests and allow the `github-codex` sensor deployment to roll.
2. Open a GitHub issue in `proompteng/lab` to emit a webhook.
3. Inspect the latest workflow with:
   ```bash
   kubectl get wf -n argo-workflows github-codex-planning-<suffix> -o jsonpath='{.spec.arguments.parameters[*].value}'
   ```
4. Confirm the logged payload via:
   ```bash
   kubectl logs -n argo-workflows github-codex-planning-<suffix> -c main
   ```
