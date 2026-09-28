# Agents Log Observability Runbook

## Overview

This runbook covers collection and verification of logs for ephemeral AgentRun Job pods in namespace `agents`.

The log shipping path is:

1. pod logs in `agents` namespace,
2. `agents-alloy` (Grafana Alloy) Kubernetes log source,
3. Loki gateway in namespace `observability`.

## GitOps Source of Truth

- `argocd/applications/agents/alloy-rbac.yaml`
- `argocd/applications/agents/alloy-configmap.yaml`
- `argocd/applications/agents/alloy-deployment.yaml`
- `argocd/applications/agents/kustomization.yaml`
- `argocd/applications/observability/graf-mimir-rules.yaml`

## Operational SLO

1. `agents-alloy` availability: at least one ready replica at all times.
2. Job log ingestion latency: logs visible in Loki within 30 seconds (p95) for active AgentRun jobs.
3. Data loss budget: no sustained periods where AgentRun step pods are running while `agents-alloy` is unavailable.

## Rollout Steps

1. Merge GitOps changes to `main`.
2. Sync Argo CD applications:
   - `argocd app sync agents`
   - `argocd app sync observability`
3. Confirm deployment readiness:
   - `kubectl -n agents rollout status deploy/agents-alloy`
4. Confirm config and RBAC objects exist:
   - `kubectl -n agents get sa,role,rolebinding,configmap,deploy | rg agents-alloy`

## Validation

1. Ensure collector pod is running:
   - `kubectl -n agents get pods -l app.kubernetes.io/name=agents-alloy`
2. Inspect collector logs for discovery/push errors:
   - `kubectl -n agents logs deploy/agents-alloy --tail=200`
3. Run a short-lived test job in `agents` and emit log lines:
   - `kubectl -n agents create job agents-log-smoke --image=busybox:1.36 -- sh -lc 'echo agents-smoke-start; sleep 5; echo agents-smoke-end'`
4. Query Loki:
   - `{job="agents",namespace="agents"} |= "agents-smoke"`
5. Clean up smoke job:
   - `kubectl -n agents delete job agents-log-smoke`

## Alert Reference

Alert definitions are in `argocd/applications/observability/graf-mimir-rules.yaml` under `agents-log-collection.rules`:

1. `AgentsAlloyDeploymentUnavailable`
2. `AgentsAlloyContainerRestarts`
3. `AgentsJobsRunningWithoutLogCollector`

## Troubleshooting

1. `AgentsAlloyDeploymentUnavailable`:
   - `kubectl -n agents describe deploy agents-alloy`
   - `kubectl -n agents get pods -l app.kubernetes.io/name=agents-alloy -o wide`
2. RBAC errors in Alloy logs:
   - verify `agents-alloy` Role includes `pods` and `pods/log` with `get,list,watch`.
3. Loki push/connectivity errors:
   - confirm endpoint in ConfigMap:
     - `kubectl -n agents get cm agents-alloy -o yaml | rg loki/api/v1/push`
   - verify gateway service exists:
     - `kubectl -n observability get svc observability-loki-loki-distributed-gateway`

## Rollback

1. Revert these resources from `argocd/applications/agents/kustomization.yaml`:
   - `alloy-rbac.yaml`
   - `alloy-configmap.yaml`
   - `alloy-deployment.yaml`
2. Sync `agents` app.
3. Leave alerts muted until collector is intentionally re-enabled.
