# Runbooks (Agents)

Status: Current (2026-01-20)

## Install
1. `helm install agents charts/agents -n agents --create-namespace`
2. Verify CRDs: `kubectl get crd | rg agents.proompteng.ai`
3. Verify Jangar: `kubectl -n agents get deploy,svc`

## Upgrade
1. `helm upgrade agents charts/agents -n agents`
2. Confirm rollout: `kubectl -n agents rollout status deploy/agents`

## Rollback
1. `helm rollback agents <REV> -n agents`
2. Verify status and re-run smoke test.

## Argo CD Application (GitOps, optional)
If you use Argo CD for GitOps (optional), use the sample Application manifest in
`argocd/applications/agents/application.yaml`:

These commands apply only to Argo CD-based installs:

```bash
kubectl apply -n argocd -f argocd/applications/agents/application.yaml
kubectl -n argocd get applications.argoproj.io agents
```

The Application renders `argocd/applications/agents` (Helm + kustomize) and installs CRDs + Jangar
into the `agents` namespace using `argocd/applications/agents/values.yaml`.
Update the values file with your Jangar image tag, database secret, and (optional) agent runner image.
If `controller.namespaces` spans multiple namespaces or `"*"`, set `rbac.clusterScoped=true`.

GitOps rollout notes (native workflow runtime):
- No external workflow engine is required for native AgentRun/OrchestrationRun execution.
- Keep `controller.enabled`, `orchestrationController.enabled`, and `supportingController.enabled` at their defaults
  unless you are intentionally disabling native runtime components.
- To point Codex reruns/system improvements at native orchestration, set
  `workflowRuntime.native.rerunOrchestration` and/or `workflowRuntime.native.systemImprovementOrchestration`
  (plus the matching `workflowRuntime.native.*Namespace` values if needed) in `argocd/applications/agents/values.yaml`.

Optional Argo CD smoke test (only for Argo CD-based installs):
```bash
kubectl -n argocd get applications.argoproj.io agents -o yaml
kubectl -n agents get deploy,svc
kubectl -n agents rollout status deploy/agents
kubectl get crd | rg agents.proompteng.ai
kubectl -n agents port-forward svc/agents 8080:80
curl -fsS http://localhost:8080/health
kubectl -n agents apply -f charts/agents/examples/agentrun-sample.yaml
kubectl -n agents apply -f charts/agents/examples/orchestration-sample.yaml
kubectl -n agents apply -f charts/agents/examples/orchestrationrun-sample.yaml
kubectl -n agents wait --for=condition=complete job \
  -l agents.proompteng.ai/agent-run=codex-run-sample --timeout=5m
```

## Smoke test (kind/minikube)
```bash
scripts/agents/smoke-agents.sh
```

This installs the chart with gRPC enabled, applies sample CRs, submits a multi-step workflow runtime
AgentRun via `agentctl`, and validates:
- AgentRun phase transitions Pending → Running → Succeeded.
- Workflow job creation (one Job per step) and Job completion.
- Runtime ref is set to the workflow job runner.

Override `AGENTS_NAMESPACE`, `AGENTS_RELEASE_NAME`, `AGENTS_VALUES_FILE`, `AGENTS_RUN_FILE`,
`AGENTS_RUN_NAME`, or `AGENTS_GRPC_LOCAL_PORT` if needed.
Ensure the `agentrun-workflow-smoke.yaml` workload image includes `agent-runner` or set
`env.vars.JANGAR_AGENT_RUNNER_IMAGE` in your values.

## Native workflow e2e proof (no Argo)
This runbook validates the native workflow runtime end-to-end (AgentProvider → Agent → ImplementationSpec → AgentRun)
without Argo and confirms that the Codex implementation step opens a PR against `proompteng/lab`.

Prereqs:
- Agents chart is installed in `agents` and Jangar is reachable.
- A GitHub token secret exists (see below).

Create the GitHub token secret once (or set `AGENTS_E2E_GH_TOKEN`):
```bash
kubectl -n agents create secret generic codex-github-token \
  --from-literal=GH_TOKEN="<token>"
```

Run the native workflow script (override the issue/task as needed):
```bash
AGENTS_E2E_ISSUE_NUMBER=2614 \
AGENTS_E2E_PROMPT="Add a short \"Verification checklist\" subsection under the Native workflow e2e proof runbook that lists AgentRun success, artifact output, and PR verification steps." \
scripts/agents/native-workflow-e2e.sh
```

Expected outputs:
- AgentRun reaches `Succeeded` with `status.runtimeRef.type=workflow`.
- Output directory contains:
  - `agentrun.json` (final status snapshot)
  - `jobs.txt` (Job → Pod mapping)
  - `logs/<job>.log` (job logs)
  - `artifacts/<job>-runner.log` and `artifacts/<job>-status.json` (agent-runner artifacts)
 - Script summary includes the output paths and, when available, the PR URL.

Verify the PR was created:
```bash
gh pr list --repo proompteng/lab --head "codex/agents/${AGENTS_E2E_ISSUE_NUMBER}"
```

Notes:
- The script applies `charts/agents/examples/agentprovider-native-workflow.yaml`,
  `charts/agents/examples/agent-native-workflow.yaml`, and
  `charts/agents/examples/implementationspec-native-workflow.yaml` before submitting the AgentRun.
- Set `AGENTS_E2E_VERIFY_PR=false` to skip the optional PR lookup (uses `gh` if available).

Troubleshooting:
- AgentRun failed: `kubectl -n agents get agentrun <name> -o yaml` and inspect job logs in the output directory.
- No PR created: confirm `codex-github-token` exists and includes `GH_TOKEN`, and the agent image has `gh` + `git`.
- Stuck in Pending/Running: check `kubectl -n agents get job -l agents.proompteng.ai/agent-run=<name>` and controller logs.

## Codex reruns/system improvements (native)
- Configure `JANGAR_CODEX_RERUN_ORCHESTRATION` and/or `JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION` (plus the matching
  `*_NAMESPACE` variables if needed).
- Ensure the referenced Orchestration exists and watch OrchestrationRun status for progress.

## Jangar /health 500 (router init error)
- Symptom: `/health` returns 500 with `ReferenceError: Cannot access 'aE' before initialization`.
- Root cause: Jangar builds picked up an incompatible Nitro `latest` bundle output.
- Fix: Pin Nitro to `3.0.0` in `services/jangar/package.json` and deploy a pinned Jangar image digest
  (avoid `latest`).

## Stuck AgentRun
- Check status/conditions: `kubectl -n agents get agentrun <name> -o yaml`
- If runtimeRef exists, check runtime object (job/workflow).
- If no runtimeRef, inspect Jangar logs for submission errors.

## Failed Integration Sync
- Inspect ImplementationSource status.
- Check credentials secret exists and is valid.
- Verify webhook delivery logs and signature headers.

## Memory Outage
- Check Memory status and connection secret.
- Failover to alternative Memory (set default).
- Re-run failed AgentRuns.

## CRD Missing
- Reinstall chart or apply CRD YAMLs directly.
- Verify `kubectl api-resources | rg agents`.
