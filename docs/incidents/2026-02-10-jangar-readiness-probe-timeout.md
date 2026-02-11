# Incident Report: Jangar Readiness Probe Timeout Causing API Unavailability

- **Date**: 10 Feb 2026 (PST) / 11 Feb 2026 (UTC)
- **Detected by**: memories CLI failures and direct `curl` checks
- **Reported by**: gregkonush
- **Services Affected**: Jangar API (`http://jangar`), memories endpoints (`/api/memories`)
- **Severity**: High (control-plane API unavailable externally)

## Impact Summary

- External access to `http://jangar` intermittently failed with `Connection refused`.
- `bun run --filter memories retrieve-memory ...` and `save-memory ...` failed while Jangar was out of service.
- Jangar deployment showed `0/1` available with pod `1/2` ready, so traffic was not routed through the Service/LB.
- Agent controller logs emitted repeated DB timeout warnings (idempotency terminal updates), increasing noise and load.

## Timeline (PST)

| Time | Event |
| --- | --- |
| ~20:38 | `curl http://jangar/healthz` fails with `Connection refused`; memories CLI also fails to reach `http://jangar/api/memories`. |
| ~20:39 | Kubernetes checks show `deployment/jangar` at `0/1` available; pod is `1/2` ready. |
| ~20:39 | Pod events show repeated readiness failures: `Get "http://<pod-ip>:8080/health": context deadline exceeded`, with thousands of probe failures over ~19h. |
| ~20:40 | CNPG cluster `jangar-db` verified healthy (`Ready=True`), services/endpoints present; DB not down. |
| ~20:40 | In-pod connectivity test confirms TCP reachability to `jangar-db-rw:5432`; DB URL resolves correctly. |
| ~20:41 | In-pod health checks show `/health` returning `200` but taking ~2.4s–3.9s. |
| ~20:41 | `kubectl top` shows Jangar app container pinned near CPU limit (`~2000m`), indicating sustained saturation. |
| ~20:42 | Emergency mitigation applied: readiness probe `timeoutSeconds` raised from `1` to `5`, `failureThreshold` to `6`; deployment rolled out. |
| ~20:43 | New Jangar pod becomes `2/2` ready; deployment returns to `1/1` available. |
| ~20:43 | External validation succeeds: `http://jangar/health` returns `200`; `http://jangar/api/memories` returns `200`. |
| ~20:44 | GitOps manifest updated with the same readiness settings to prevent regression on Argo resync. |

## Root Cause

The Jangar readiness probe was configured too aggressively for observed runtime latency:

- Probe: `GET /health`, `timeoutSeconds: 1`, `failureThreshold: 3`
- Actual `/health` latency under load: ~2.4–3.9 seconds

Because health responses exceeded probe timeout, Kubernetes marked the pod unready even though the app was alive and serving.
This removed the pod from Service/LB routing and produced effective API downtime.

## Contributing Factors

- Sustained CPU saturation at the app container limit (~2 cores) increased health endpoint response time.
- No buffer in readiness timeout for transient load spikes.
- Repeated controller work and retry/error loops increased log volume and likely contributed to contention.
- Log noise from expected `NotFound` delete/apply cases made triage slower.

## What Was Not the Root Cause

- Postgres outage was ruled out:
  - CNPG cluster status was healthy.
  - Service endpoints were present.
  - In-pod DB TCP connectivity and direct DB query path were functional.

## Remediation Actions Taken

1. Patched live deployment readiness probe:
   - `timeoutSeconds: 5`
   - `failureThreshold: 6`
2. Verified rollout success and restored readiness (`2/2` pod, deployment `1/1` available).
3. Verified external API recovery:
   - `GET /health` -> `200`
   - `GET /api/memories` -> `200`
4. Persisted fix in GitOps manifest:
   - `argocd/applications/jangar/deployment.yaml`

## Preventive / Follow-up Actions

1. **Health endpoint hardening**: keep `/health` lightweight and decouple expensive checks from readiness path.
2. **Probe policy**: define minimum readiness timeout standards for CPU-bound services (avoid 1s defaults for non-trivial handlers).
3. **Load control**: reduce controller churn/backoff behavior during repeated DB errors to lower contention.
4. **Capacity**: evaluate raising app CPU limits/requests or splitting heavy background responsibilities from request-serving path.
5. **Alerting**: add alerts for:
   - deployment availability dropping below desired replicas,
   - sustained readiness probe failures,
   - repeated pg-pool connection timeout bursts.
6. **Noise reduction**: downgrade or suppress expected `NotFound` controller paths to reduce signal loss during incidents.

## Commands Used During Incident

```bash
# Symptom
curl -sv --max-time 5 http://jangar/health

# Deployment state
kubectl -n jangar get deploy jangar -o wide
kubectl -n jangar describe pod -l app=jangar
kubectl -n jangar top pod <pod> --containers

# DB checks
kubectl -n jangar get cluster.postgresql.cnpg.io jangar-db -o yaml
kubectl -n jangar get endpoints jangar-db-rw -o wide
kubectl -n jangar exec deploy/jangar -c app -- node -e '<tcp test to jangar-db-rw:5432>'

# In-pod health latency
kubectl -n jangar exec deploy/jangar -c app -- \
  curl -sS -o /dev/null -w 'code=%{http_code} total=%{time_total}\n' http://127.0.0.1:8080/health

# Emergency fix
kubectl -n jangar patch deployment jangar --type='json' -p='[
  {"op":"add","path":"/spec/template/spec/containers/0/readinessProbe/timeoutSeconds","value":5},
  {"op":"add","path":"/spec/template/spec/containers/0/readinessProbe/failureThreshold","value":6}
]'
kubectl -n jangar rollout status deploy/jangar
```

