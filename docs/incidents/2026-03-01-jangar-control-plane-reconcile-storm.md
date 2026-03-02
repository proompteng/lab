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

## Root Cause

Jangar entered a **control-plane reconcile feedback loop** in the API pod:

1. In-process controllers continuously reconciled watched resources and spawned frequent `kubectl apply -f - -o json` subprocesses.
2. Swarm status was being rewritten repeatedly with no semantic state change (observed as `resourceVersion` churn where normalized status stayed constant except `updatedAt`).
3. The resulting process/API churn saturated the app CPU budget (~2 cores), starving the Bun HTTP event loop.
4. `/health` stopped returning responses, so readiness never became healthy and the service stayed out of rotation.

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
3. Documented incident and root-cause path for follow-on fix PRs.

## Preventive / Follow-up Actions

1. Add explicit reconcile dedupe/guardrails so status writes are skipped when only heartbeat fields would change.
2. Stop unconditional apply loops in reconcile paths (especially schedule/swarm flows); compare desired/current before apply.
3. Move heavy control-plane reconciliation out of the request-serving pod (separate deployment/process budget).
4. Add an alert for sustained `kubectl apply` subprocess churn in Jangar app pods.
5. Add regression tests for no-op reconciliation (resourceVersion should not churn under stable inputs).

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
```
