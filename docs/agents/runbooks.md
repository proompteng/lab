# Runbooks (Agents)

Status: Draft (2026-01-16)

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

Argo CD smoke test:
```bash
kubectl -n argocd get applications.argoproj.io agents -o yaml
kubectl -n agents get deploy,svc
kubectl get crd | rg agents.proompteng.ai
kubectl -n agents apply -f charts/agents/examples/agentrun-sample.yaml
kubectl -n agents wait --for=condition=complete job \
  -l agents.proompteng.ai/agent-run=codex-run-sample --timeout=5m
```

## Smoke test (kind/minikube)
```bash
scripts/agents/smoke-agents.sh
```

This installs the chart, applies sample CRDs, submits a job runtime AgentRun, and waits for the Job
to complete. Override `AGENTS_NAMESPACE`, `AGENTS_RELEASE_NAME`, or `AGENTS_VALUES_FILE` if needed.
Ensure the `agentrun-sample.yaml` workload image includes `agent-runner` or set
`env.vars.JANGAR_AGENT_RUNNER_IMAGE` in your values.

## Stuck AgentRun
- Check status/conditions: `kubectl -n agents get agentrun <name> -o yaml`
- If runtimeRef exists, check runtime object (job/workflow).
- If no runtimeRef, inspect Jangar logs for submission errors.

## Failed Integration Sync
- Inspect ImplementationSource status.
- Check credentials secret exists and is valid.
- Temporarily disable webhook and use polling.

## Memory Outage
- Check Memory status and connection secret.
- Failover to alternative Memory (set default).
- Re-run failed AgentRuns.

## CRD Missing
- Reinstall chart or apply CRD YAMLs directly.
- Verify `kubectl api-resources | rg agents`.
