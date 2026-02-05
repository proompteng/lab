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
bun run packages/scripts/src/agents/deploy-service.ts
kubectl apply -n argocd -f argocd/applications/agents/application.yaml
kubectl -n argocd get applications.argoproj.io agents
```

The Application renders `argocd/applications/agents` (Helm + kustomize) and installs CRDs + Jangar
into the `agents` namespace using `argocd/applications/agents/values.yaml`.
Update the values file with your Jangar image tag, database secret, and (optional) runner image via `runner.image.*`.
The chart defaults `controller.jobTtlSecondsAfterFinished` to a safe value; set it to `0` to disable job cleanup.
If `controller.namespaces` spans multiple namespaces or `"*"`, set `rbac.clusterScoped=true`.

GitOps rollout notes (native workflow runtime):
- No external workflow engine is required for native AgentRun/OrchestrationRun execution.
- Keep `controller.enabled`, `orchestrationController.enabled`, and `supportingController.enabled` at their defaults
  unless you are intentionally disabling native runtime components.
- To point Codex reruns/system improvements at native orchestration, set
  `workflowRuntime.native.rerunOrchestration` and/or `workflowRuntime.native.systemImprovementOrchestration`
  (plus the matching `workflowRuntime.native.*Namespace` values if needed) in `argocd/applications/agents/values.yaml`.

CI runners use `argocd/applications/agents-ci` to provision the `agents-ci` namespace and RBAC for ARC
so GitHub Actions can execute smoke tests against the chart.

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
packages/scripts/src/agents/smoke-agents.ts
```

This installs the chart, applies deterministic smoke CRs, submits a multi-step workflow runtime
AgentRun via `agentctl` (kube mode), and validates:
- AgentRun phase transitions Pending → Running → Succeeded.
- Workflow job creation (one Job per step) and Job completion.
- Runtime ref is set to the workflow job runner.

Override `AGENTS_NAMESPACE`, `AGENTS_RELEASE_NAME`, `AGENTS_VALUES_FILE`, `AGENTS_RUN_FILE`,
`AGENTS_RUN_NAME`, `AGENTS_CREATE_NAMESPACE`, or `AGENTCTL_BIN` if needed.
If you do not have an external database handy, set `AGENTS_DB_BOOTSTRAP=true` to spin up a local
Postgres in-cluster and wire `database.url` automatically (or provide `AGENTS_DB_URL` yourself).
Ensure the `agentrun-workflow-smoke.yaml` workload image includes `agent-runner` or set
`env.vars.JANGAR_AGENT_RUNNER_IMAGE` in your values.

## Workflow runtime validation (native)
Confirm the workflow adapter is healthy and no Argo Workflows are required:
```bash
curl -fsS http://localhost:8080/api/agents/control-plane/status?namespace=agents | jq '.runtime_adapters'
kubectl api-resources --api-group=argoproj.io --no-headers || true
kubectl -n agents get workflows.argoproj.io 2>/dev/null || true
```

Expected outcomes:
- `runtime_adapters` contains `workflow` with `status: healthy` and a native runtime message.
- The Argo Workflows resource check returns empty output (no CRD or no workflows).

## Native workflow e2e proof
This runbook validates the native workflow runtime end-to-end (AgentProvider → Agent → ImplementationSpec → AgentRun)
and confirms that the Codex implementation step opens a PR against `proompteng/lab`.

Prereqs:
- `codex-github-token` secret in the target namespace (GH token with repo permissions).
- OpenAI key available via `AGENTS_E2E_OPENAI_KEY` or an existing `codex-openai-key` secret
  (the script will create/update it when the env var is set).

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
AGENTS_E2E_PROMPT="Add optional autoscaling support to the Agents Helm chart (HPA + values schema + README)." \
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
