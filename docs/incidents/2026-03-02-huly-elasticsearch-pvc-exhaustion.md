# Incident Report: Huly Elasticsearch CrashLoop Due to PVC Exhaustion

- **Date**: 01 Mar 2026 (PST) / 02 Mar 2026 (UTC)
- **Detected by**: Argo CD `Application/huly` stuck `Synced` + `Progressing`
- **Reported by**: gregkonush
- **Services Affected**: `huly` namespace `elastic` deployment (`elasticsearch:7.14.2`)
- **Severity**: Medium (Huly app remained partially degraded while Elasticsearch was unavailable)

## Impact Summary

- `elastic` in namespace `huly` remained in `CrashLoopBackOff` for ~4.5 hours.
- Argo CD app `huly` did not become fully healthy because the deployment had `0/1` available replicas.
- Components depending on Elasticsearch indexing/search were at risk of degraded behavior during the incident window.

## User-Facing Symptom

- Argo CD showed `huly` as `Synced` but `Progressing` instead of `Healthy`.
- `kubectl -n huly get pods` showed `elastic-*` repeatedly restarting.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 2026-03-02 02:25 | `huly` resources deployed; `elastic` pod starts with PVC `elastic` size `100Mi`. |
| 2026-03-02 02:25 - 07:01 | `elastic` repeatedly restarts (`CrashLoopBackOff`), deployment remains unavailable (`0/1`). |
| 2026-03-02 07:01 | Elasticsearch logs show `net usable_space [0b]` and `java.io.IOException: No space left on device`. |
| 2026-03-02 07:01 | Startup aborts with `Failed to load persistent cache`; pod exits with code `1`. |
| 2026-03-02 ~07:05 | PVC request increased to `5Gi`, deployment restarted, pod becomes `1/1 Running`. |
| 2026-03-02 ~07:06 | PVC reflects `request=5Gi capacity=5Gi`; `Application/huly` health turns `Healthy`. |

## Root Cause

Elasticsearch data volume was undersized in GitOps manifest (`100Mi`), which quickly exhausted available filesystem space (`0b` usable). During startup, Elasticsearch attempted to repopulate its persistent cache and failed with `No space left on device`, causing process exit and crash loops.

Manifest source:

- `argocd/applications/huly/elastic/elastic-persistentvolumeclaim.yaml`
- `spec.resources.requests.storage: 100Mi` (pre-fix)

## Contributing Factors

- No alert or guardrail on minimum storage sizing for Elasticsearch workloads.
- Single-replica deployment with `Recreate` strategy meant no redundancy during restart failures.

## What Was Not The Root Cause

- Not an image pull or registry issue (`image already present`).
- Not a node scheduling issue (pod scheduled consistently).
- Not a storage class expansion limitation (`rook-ceph-block` supports expansion).

## Corrective Actions Taken

1. Increased Elasticsearch PVC request from `100Mi` to `5Gi` in manifest:
   - `argocd/applications/huly/elastic/elastic-persistentvolumeclaim.yaml`
2. Applied the updated PVC request to cluster (`kubectl -n huly apply -f ...`).
3. Restarted deployment to ensure clean recovery:
   - `kubectl -n huly rollout restart deployment/elastic`
4. Verified rollout completed and pod stabilized (`1/1 Running`).
5. Verified PVC expansion completed (`request=5Gi`, `capacity=5Gi`).

## Validation

- `kubectl -n huly get pods -l app=elastic` => `READY 1/1`, `STATUS Running`, `RESTARTS 0`.
- `kubectl -n huly get pvc elastic` => `request=5Gi`, `capacity=5Gi`, `phase=Bound`.
- `kubectl -n argocd get application huly` => health `Healthy` after remediation.

## Follow-up Actions

1. Set a sane default storage floor for Elasticsearch in Huly manifests (for example, `>=5Gi` unless explicitly justified).
2. Add an operational check that flags `Application` states that remain `Progressing` for longer than expected.
3. Add runbook guidance for PVC expansion + restart procedure for stateful workloads in `huly`.
4. Consider resource requests/limits and JVM tuning review for this Elasticsearch deployment.

