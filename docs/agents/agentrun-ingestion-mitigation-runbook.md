# AgentRun Ingestion Mitigation Runbook

Use this runbook when `agents-controllers` is healthy enough to serve traffic but `AgentRun` ingestion may be stale, blind, or partially reconciled.

## Scope

- Namespace: `agents`
- Controller deployment: `agents-controllers`
- Non-rollout actions only

## Snapshot And Evidence

Capture the current state before any backfill action:

```bash
bun packages/scripts/src/jangar/agentrun-ingestion-mitigation.ts \
  --namespace agents \
  --output artifacts/jangar/agentrun-ingestion/live-snapshot.json
```

The JSON report includes:

- current `AgentRun` inventory and classification
- canonical vs duplicate-terminal vs untouched counts
- safe delete/recreate candidates
- controller deployment image
- leader identity / leader pod
- `/ready` probe result
- `jangar_kube_watch_events_total` evidence for `agentruns.agents.proompteng.ai`

## Backfill

Only apply backfill after the controller is healthy enough to accept new work again.

```bash
bun packages/scripts/src/jangar/agentrun-ingestion-mitigation.ts \
  --namespace agents \
  --apply-backfill \
  --output artifacts/jangar/agentrun-ingestion/live-backfill.json
```

Backfill rules:

- delete untouched duplicates only when a canonical run for the same `spec.idempotencyKey` already exists in `Running`, `Succeeded`, `Failed`, or `Cancelled`
- recreate untouched runs only when no canonical run exists and the control-plane status does not currently report degraded `agentrun_ingestion`

## Post-Backfill Verification

Confirm the controller is reporting healthy ingestion and watch activity:

```bash
kubectl get --raw \
  '/api/v1/namespaces/agents/pods/<leader-pod>:8080/proxy/api/agents/control-plane/status?namespace=agents'
```

Expected:

- `agentrun_ingestion.status` is `healthy`
- `untouched_run_count` is `0`
- `last_watch_event_at` and `last_resync_at` are populated after new work arrives

Confirm watch metrics still include `AgentRun` events:

```bash
kubectl get --raw \
  '/api/v1/namespaces/agents/pods/<leader-pod>:8080/proxy/metrics' \
  | rg 'jangar_kube_watch_events_total.*agentruns.agents.proompteng.ai'
```

## Notes

- This runbook intentionally excludes rollout restart. Use the normal GitOps/canary process for deployment changes.
- The mitigation script auto-discovers the leader-election lease name and controller HTTP port from the deployment when possible.
