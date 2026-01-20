# Runbooks (Agents)

Status: Current (2026-01-19)

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

## Argo CD Application (GitOps)
Use the sample Application manifest in `argocd/applications/agents/application.yaml`:

```bash
kubectl apply -n argocd -f argocd/applications/agents/application.yaml
kubectl -n argocd get applications.argoproj.io agents
```

The Application renders `argocd/applications/agents` (Helm + kustomize) and installs CRDs + Jangar
into the `agents` namespace using `argocd/applications/agents/values.yaml`.
Update the values file with your Jangar image tag, database secret, and (optional) agent runner image.
If `controller.namespaces` spans multiple namespaces or `"*"`, set `rbac.clusterScoped=true`.

Argo CD smoke test:
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

This installs the chart with gRPC enabled, applies sample CRDs, submits a multi-step workflow runtime
AgentRun via `agentctl`, and validates:
- AgentRun phase transitions Pending → Running → Succeeded.
- Workflow job creation (one Job per step) and Job completion.
- Runtime ref is set to the workflow job runner.

Override `AGENTS_NAMESPACE`, `AGENTS_RELEASE_NAME`, `AGENTS_VALUES_FILE`, or `AGENTS_GRPC_LOCAL_PORT` if needed.
Ensure the `agentrun-sample.yaml` workload image includes `agent-runner` or set
`env.vars.JANGAR_AGENT_RUNNER_IMAGE` in your values.

## Codex reruns/system improvements (native)
- Configure `JANGAR_CODEX_RERUN_ORCHESTRATION` and/or `JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION` (plus the matching
  `*_NAMESPACE` variables if needed).
- Ensure the referenced Orchestration exists and watch OrchestrationRun status for progress.
- To use the Argo adapter instead, set `ARGO_SERVER_URL` along with `JANGAR_CODEX_RERUN_TEMPLATE` and/or
  `JANGAR_SYSTEM_IMPROVEMENT_TEMPLATE`.

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
