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

## Fleet triage

Open [Agents Fleet Operations](https://grafana.k8s.proompteng.ai/d/agents-fleet-operations). In Mimir,
`up{job="agents"}` should show separate targets for `agents`, `agents-controllers`, and `agents-alloy`.
Controller metrics can carry a watched `namespace` such as `synthesis` even though the targets live in `agents`.

- `AgentsUntouchedBacklogHigh` and `AgentsControllerReconcileSlow`: compare the affected namespace's queue,
  concurrency cap, and p95 latency. Look for `agentrun_ingestion_stalled` and Kubernetes API errors in controller logs.
- `AgentsRunFailureRateHigh`: compare `Failed` with all non-cancelled completions. Search controller logs for
  `agentrun_terminal_status_committed`, then inspect the failed runner. If a `trace_id` is present, open it in Tempo
  for the committed lifecycle span. The span uses runner timestamps when available.
- `AgentsQuotaNearLimit`: inspect the reported `limit_id` before dispatching more work. Only seven-day windows from
  completed runners are shown. A missing sample means unobserved or expired, not unused quota. The throughput panels
  count completed runners, including individual workflow steps, retries, and loop iterations once their progress is
  saved. Cached input and reasoning are subsets, not additional token totals.
- Compare Pod RAM with the runner `/workspace` tmpfs panel. The latter is filesystem usage for that mount only,
  sampled every heartbeat. cAdvisor working-set bytes are not a separate tmpfs measurement. Verify `up` and collection
  errors separately for the `agents-db-next` CNPG exporters.

### Loki structured metadata activation

Leave `AGENTS_LOKI_STRUCTURED_METADATA=false` in the Alloy Deployment while Loki's active index is BoltDB Shipper.
Loki rejects pushes containing structured metadata with that index. JSON parsing and the workspace metric still work,
and the original lines remain queryable with `| json`. Once a separately validated TSDB migration is active and Loki
accepts structured metadata, set the flag to `true` in Git and verify a completed run with:

```logql
{job="agents",container="agents-controllers"} | event_type="agentrun_terminal_status_committed" | agent_run="<run-name>"
```

Use `agent_run` as a metadata filter, not in the stream selector. Revert the flag if Loki rejects new pushes.

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
