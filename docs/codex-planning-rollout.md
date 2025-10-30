# Codex Planning Dispatch Rollout

This runbook sequences the handoff of planning workflow dispatch from Argo Events to Facteur once the knowledge-base ingestion work is ready.

## Prerequisites

- Issues [#1635](https://github.com/proompteng/lab/issues/1635) and [#1636](https://github.com/proompteng/lab/issues/1636) are closed and deployed. Facteur build should include the `codex_dispatch` configuration and guarded dispatcher.
- Cluster access with `kubectl`, `argo`, and `kn` CLIs configured for the shared environments.
- Latest `facteur-config` ConfigMap synced (`kubectl -n facteur get configmap facteur-config -o yaml | yq '.data'`). Confirm `codex_dispatch.planning_enabled: "false"` before starting.
- Export the existing Argo sensor spec for rollback:
  ```bash
  kubectl -n argo-workflows get sensor github-codex -o yaml > /tmp/github-codex-sensor-precutover.yaml
  ```
- Coordinate a maintenance window with the platform team; the cutover touches cluster-scoped Argo resources and Discord automations.

## Staging / Canary Dry Run

1. Render a temporary ConfigMap manifest with planning enabled:
   ```bash
   kubectl kustomize kubernetes/facteur/overlays/cluster \
     | yq '(.data."config.yaml" | from_yaml | .codex_dispatch.planning_enabled) = true | .data."config.yaml" = (.data."config.yaml" | tostring)' \
     > /tmp/facteur-config-planning.yaml
   kubectl apply -f /tmp/facteur-config-planning.yaml
   ```
2. Recycle the Knative Service so the new env var lands:
   ```bash
   kubectl -n facteur rollout restart deploy/facteur
   kubectl -n facteur rollout status deploy/facteur
   ```
3. Watch logs for the planning toggle:
   ```bash
   kubectl -n facteur logs deploy/facteur -f | rg "codex"
   ```
   Expect to see `codex task received` followed by `workflow submitted: stage=PLANNING …` after the dry run below.
4. Trigger a synthetic task:
   ```bash
   base64 --decode <<'EOF' >/tmp/codex-planning.bin
   CAESEERyeSBydW4gZGlzcGF0Y2gaDnByb29tcHRlbmcvbGFiIgRtYWluKhZjb2RleC9wbGFubmluZy1kcnktcnVuMOcHOixodHRwczovL2dpdGh1Yi5jb20vcHJvb21wdGVuZy9sYWIvaXNzdWVzLzk5OUINQ29kZXggZHJ5IHJ1bkoYVGVzdGluZyBwbGFubmluZyBoYW5kb2ZmegxkcnktcnVuLTAwMDE=
   EOF
   kubectl -n facteur port-forward svc/facteur 8080:80 >/tmp/facteur-port-forward.log &
   PF_PID=$!
   curl -sS -X POST http://localhost:8080/codex/tasks --data-binary @/tmp/codex-planning.bin
   kill $PF_PID
   ```
   The sample payload encodes a `github.v1.CodexTask` with stage planning, repo metadata, and delivery ID `dry-run-0001`.
5. Validate the workflow surfaced in Argo:
   ```bash
   argo list -n argo-workflows | rg codex-planning
   kubectl -n argo-workflows get wf -l codex.stage=planning -o wide
   argo logs codex-planning-<suffix> -n argo-workflows
   ```
6. Flip the flag back to `false` and restart the deployment to keep staging quiescent until production cutover.

## Production Enablement

1. Update `kubernetes/facteur/overlays/cluster/config.yaml` with `codex_dispatch.planning_enabled: true` (commit + PR or cherry-pick the staging patch once approved).
2. Deploy the change:
   ```bash
   kubectl apply -k kubernetes/facteur/overlays/cluster
   kubectl -n facteur rollout status deploy/facteur
   ```
3. Confirm the ConfigMap and env injection:
   ```bash
   kubectl -n facteur get configmap facteur-config -o yaml | yq '.data."config.yaml" | from_yaml | .codex_dispatch'
   kubectl -n facteur get deploy/facteur -o jsonpath='{.spec.template.spec.containers[0].env[*]}'
   ```
4. Monitor Facteur logs for planning submissions, and capture the first production workflow ID and correlation ID.
5. Disable the Argo Events planning trigger:
   ```bash
   kubectl apply -f argocd/applications/froussard/github-codex-sensor.yaml
   kubectl -n argo-workflows get sensor github-codex -o jsonpath='{.spec.triggers[*].template.name}'
   ```
   `planning-workflow` should be absent from the list; only implementation/review triggers remain.
6. Record evidence in issue #1638: workflow name, Discord channel link (if applicable), and key metrics.

## Monitoring & Evidence Checklist

- Facteur logs include paired entries:
  - `codex task received: stage=CODEX_TASK_STAGE_PLANNING …`
  - `workflow submitted: stage=PLANNING repo=… issue=… workflow=codex-planning-…`
- `argo get codex-planning-<suffix> -n argo-workflows` shows success and references the correct payload parameters.
- OTEL / Loki dashboards chart `codex.stage=planning` without error spikes during the transition window.
- Discord relay posts planning output to the expected channel when credentials are configured.

## Rollback

If planning dispatch fails or needs to be reverted quickly:

1. Disable the flag and recycle Facteur:
   ```bash
   kubectl apply -f - <<'YAML'
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: facteur-config
     namespace: facteur
   data:
     config.yaml: |
       # existing contents with codex_dispatch.planning_enabled: false
   YAML
   kubectl -n facteur rollout restart deploy/facteur
   ```
   (Alternatively re-render the overlay with `planning_enabled: false` and reapply.)
2. Restore the Argo sensor:
   ```bash
   kubectl apply -f /tmp/github-codex-sensor-precutover.yaml
   kubectl -n argo-workflows get sensor github-codex -o jsonpath='{.spec.triggers[*].template.name}'
   ```
   `planning-workflow` should return to the trigger list.
3. Cancel lingering workflows started via Facteur:
   ```bash
   kubectl -n argo-workflows get wf -l codex.stage=planning --field-selector status.phase=Running -o name \
     | xargs -r -n1 argo terminate -n argo-workflows
   ```
4. Post-mortem: attach Facteur logs, workflow names, and Discord/alert output to issue #1638 (or the follow-up incident ticket) before reattempting the cutover.
