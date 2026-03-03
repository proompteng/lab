# Incident Report: Jangar Control-Plane Reconcile Storm Starved API Readiness

- **Date**: 1 Mar 2026 (PST) / 2 Mar 2026 (UTC)
- **Detected by**: memories CLI failures + Kubernetes readiness alerts
- **Reported by**: gregkonush
- **Services Affected**: Jangar API (`http://jangar`, `http://jangar.ide-newton.ts.net`)
- **Severity**: High (control-plane API unavailable)

## Impact Summary

- Jangar pod remained `1/2` ready (`deployment/jangar` unavailable).
- `GET /health` accepted TCP connections but never returned headers (30s timeout in-pod).
- External calls to Jangar-backed endpoints (including memories operations) failed during the incident window.
- Roll forward from image `9a5f8042` to `c5ef6a3e` did not recover service; failure mode persisted.

## Timeline (PST)

| Time | Event |
| --- | --- |
| 22:36:51 | New `jangar-95d7b868d-*` pod starts failing readiness: `GET /health` connection refused, then probe timeouts. |
| 22:36-23:03 | Pod remains `1/2` ready; service unavailable; worker rollout proceeds but does not fix API readiness. |
| 23:03:59 | New rollout to image `c5ef6a3e` (`jangar-7c5b867bfb-*`) shows identical readiness failure pattern. |
| 23:04+ | In-pod `/health` checks consistently time out (`code=000`, ~30s). |
| 23:06+ | `kubectl top` shows Jangar app pinned near CPU limit (~2000m). |
| 23:06+ | `agents/swarm/jangar-control-plane` status `resourceVersion` advances every few seconds while semantic status remains unchanged (only `updatedAt` churn). |
| 00:06 (Mar 2) | Swarm throttling/image rollout lands; health endpoint recovers quickly, but CPU remains pinned. |
| 00:12 (Mar 2) | `CronJob` watch-only sampling shows sustained event storm (`~21 MODIFIED/20s`) on schedule-runner cronjobs in `agents` namespace. |
| 00:17 (Mar 2) | Confirmed second hot path: each cronjob MODIFIED event triggered full `reconcileSchedule` (target lookup + apply checks + status write), causing sustained `kubectl` subprocess churn. |

## Root Cause

Jangar entered a **compound control-plane reconcile loop** in the API pod:

1. `Swarm` watch `MODIFIED` events (status-only, no spec change) repeatedly entered expensive reconcile paths and spawned repeated `kubectl` subprocess work.
2. A second, independent storm came from `CronJob` watch `MODIFIED` events for schedule-runner jobs; each event called full `reconcileSchedule`, including target resolution and desired/live apply comparisons.
3. Both paths execute inside the same API process as HTTP serving; under high event rate this saturated CPU (~2 cores), starving the Bun event loop.
4. `/health` timed out under starvation, so readiness stayed unhealthy and the service remained out of rotation.

## Evidence

- Pod readiness failures:
  - `Readiness probe failed: Get "http://<pod-ip>:8080/health": context deadline exceeded`
- In-pod health request starvation:
  - `curl -m 30 http://127.0.0.1:8080/health` -> `code=000`, timeout with 0 bytes.
- Sustained saturation:
  - `kubectl -n jangar top pod jangar-7c5b867bfb-sc89n` -> ~`2011m` CPU.
- Controller process churn inside app container:
  - many long-lived `kubectl get ... --watch ...` subprocesses plus repeated short-lived `kubectl apply -f - -o json` children.
- No-op swarm status churn:
  - `agents/swarm/jangar-control-plane` `resourceVersion` changed repeatedly while normalized status hash (excluding `updatedAt` and condition transition timestamps) stayed constant.
- Schedule-runner cronjob event storm:
  - `kubectl get cronjobs -n agents -l schedules.proompteng.ai/schedule --watch-only --output-watch-events --request-timeout=20s -o json` produced ~21 `MODIFIED` events in 20 seconds across `*-sched-cron` resources.
- Post-swarm-fix residual signal:
  - After Swarm throttling rollout, health responded `200` but CPU remained ~2000m until cronjob reconcile path was isolated.

## Contributing Factors

- Control-plane reconcilers share the same process/runtime budget as HTTP serving.
- Reconcile path shells out to `kubectl` for watch/apply operations, amplifying per-reconcile overhead.
- Readiness probe identified unhealthiness but could not self-heal the livelock condition.

## What Was Not the Root Cause

- Not a single bad image build: failure reproduced across `9a5f8042` and `c5ef6a3e`.
- Not a database outage signal: DB pod stayed healthy and no DB-down event pattern matched this failure.

## Remediation Actions Taken

1. Captured runtime evidence from failing pods and swarm status objects.
2. Confirmed issue persisted across rollout/restart, ruling out one-off pod corruption.
3. Shipped no-op apply guards + queue coalescing for supporting primitives reconciles.
4. Updated watch processing to reconcile latest resource snapshots, not stale event payloads.
5. Added Swarm status-only reconcile throttling.
6. Identified and fixed schedule-runner cronjob hot path by:
   - using throttled status-only reconciliation for cronjob `MODIFIED` events,
   - retaining full schedule reconciliation only for delete/recreate paths.
7. Pinned GitOps manifests to the fixed image and validated rollout.

## Preventive / Follow-up Actions

1. Add explicit per-watch event-rate telemetry by kind (`event_type`, `kind`, `namespace`) to detect controller storms before readiness impact.
2. Keep status-only throttles on high-churn watches (`Swarm`, `CronJob`) and add equivalent guards for any future high-frequency sources.
3. Continue replacing full reconcile calls on status-heartbeat events with targeted status refresh routines.
4. Move heavy control-plane reconciliation out of the request-serving pod (separate deployment/process budget).
5. Add alerts for sustained Jangar CPU saturation + readiness degradation + watch event surge correlation.

## Commands Used During Incident

```bash
# Symptom
bun run --filter memories retrieve-memory --query "jangar service incident root cause previous issues" --limit 5

# Runtime health
kubectl -n jangar get pods -o wide
kubectl -n jangar describe pod <jangar-pod>
kubectl -n jangar logs <jangar-pod> -c app --since=30m
kubectl -n jangar top pod <jangar-pod>

# In-pod HTTP behavior
kubectl -n jangar exec <jangar-pod> -c app -- /bin/bash -lc \
  'curl -sS -m 30 -o /tmp/h.out -w "code=%{http_code} total=%{time_total}\n" http://127.0.0.1:8080/health'

# Swarm status churn verification
kubectl -n agents get swarm jangar-control-plane -o json
kubectl -n agents get swarms.swarm.proompteng.ai --watch --output-watch-events -o json --request-timeout=20s

# Cronjob watch event-rate verification
kubectl -n agents get cronjobs -l schedules.proompteng.ai/schedule \
  --watch-only --output-watch-events --request-timeout=20s -o json
```
