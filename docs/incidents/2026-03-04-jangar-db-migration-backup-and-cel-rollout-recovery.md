# Incident Report: Jangar DB Migration Corruption, Backup Drift, and CRD CEL Rollout Regression

- **Date**: 4 Mar 2026 (UTC)
- **Detected by**: failing `memories` operations, CNPG backup phase drift, and `agents-ci / integration` failures on PR rollout
- **Reported by**: gregkonush
- **Services Affected**: Jangar API, memories service path, CNPG backup posture, GitHub Actions rollout path for PR `#4044`
- **Severity**: High (partial production feature outage + blocked production rollout)

## Impact Summary

- `memories` save/retrieve paths failed while Kysely migrations were in a corrupted state.
- CNPG backup CR history showed repeated `walArchivingFailing` entries and stale bucket/server layout, reducing operator confidence in restore posture.
- Required GitHub Actions check (`agents-ci / integration`) failed, blocking merge and rollout for remediation PR `#4044`.
- User-facing risk: write-path instability and delayed production fix deployment.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 2026-03-04 ~16:3x | Jangar DB migration state found inconsistent (`kysely_migration` ordering mismatch; missing migration row). |
| 2026-03-04 ~16:3x-17:1x | Live DB repair executed (schema + migration ledger repair), pending migrations applied, memories recovered. |
| 2026-03-04 22:50 | Fix PR `#4044` opened for durable infra/app changes. |
| 2026-03-04 22:54 | `agents-ci / integration` fails: invalid CRD CEL rule using `has(self.parameters, 'prompt')`. |
| 2026-03-04 23:00 | First CEL patch attempt fails again (`self.parameters.prompt` used at map-field scope). |
| 2026-03-04 23:03-23:07 | Final CEL fix switched to map-safe key-membership rules; checks pass. |
| 2026-03-04 23:07:49 | PR `#4044` merged to `main` (merge commit `95735e00630c4125ac2982d9313f5214504fd305`). |
| 2026-03-04 23:09-23:18 | Argo CD refresh/reconcile; `jangar` app reaches `Synced Healthy` on merge revision. |
| 2026-03-04 23:10:25-23:19:32 | Manual CNPG backup executed and completed (`jangar-db-manual-20260304231024`). |

## Root Cause

This incident combined three independent failures:

1. **Migration ledger corruption in production DB**
   - `kysely_migration` entries were not in expected order and a required migration row was missing.
   - Jangar migration startup checks treated this as corruption and blocked normal schema progress, breaking memories paths.

2. **Backup configuration drift and stale failure history**
   - CNPG backup topology had drift from desired destination/server naming convention.
   - Historical backup CRs retained `walArchivingFailing` phases from pre-fix windows.

3. **CRD CEL validation rule regression in rollout CI**
   - Rule form `has(self.parameters, 'prompt')` is rejected by Kubernetes CEL in the CI API server.
   - Follow-up rule form `has(self.parameters.prompt)` failed for field-scoped map validation because `self` at that location is already the map value type.

## Remediation Applied

1. **Production DB repair**
   - Repaired migration ledger consistency and missing schema elements.
   - Confirmed migrations complete and memories save/retrieve recovered.

2. **Durable application/infra fixes in PR `#4044`**
   - Hardened migration runner behavior around unordered history handling.
   - Updated CNPG backup destination/server mapping and related migration job paths.
   - Increased CNPG PVC request to `200Gi` for operational headroom and to avoid pressure-driven incidents.

3. **Production rollout unblocked via GitHub Actions**
   - Fixed CRD CEL rules at source annotations + chart CRD + schema mirrors:
     - top-level: `!has(self.parameters) || !('prompt' in self.parameters)`
     - workflow-step map field: `!('prompt' in self)`
   - Re-ran checks; `agents-ci / integration` passed, then merged.

4. **Post-merge production verification**
   - Argo `jangar` app synced to merge revision and remained healthy.
   - Jangar and worker deployments ready.
   - CNPG status showed WAL archiving healthy (`WALs waiting to be archived: 0`).
   - Manual backup completed successfully to Ceph object storage.

5. **Cleanup**
   - Deleted stale backup CRs with `walArchivingFailing` phase:
     - `jangar-db-daily-20260302110000`
     - `jangar-db-daily-20260303110000`
     - `jangar-db-daily-20260304110000`

## Current Verified State (After Remediation)

- Jangar app: `Synced Healthy` in Argo CD on `95735e00630c4125ac2982d9313f5214504fd305`.
- Jangar runtime: `deployment/jangar` and `deployment/jangar-worker` at `1/1` ready.
- DB logical size (`jangar`): ~`3949 MB`; CNPG cluster-reported size: ~`4.6G`.
- WAL directory footprint: ~`640 MB`.
- Continuous backup: working; last manual backup completed successfully.
- Memories: save/retrieve smoke checks successful.

## Preventive Actions

1. Add CI guard that validates AgentRun CRD CEL rules against a Kubernetes version matrix used by `agents-ci`.
2. Add migration-ledger integrity preflight that emits explicit repair guidance before startup failure.
3. Add scheduled synthetic restore/backup verification alerting for CNPG object-store path + serverName consistency.
4. Add runbook entry for interpreting CNPG historical backup phases vs current archiving health.
5. Keep GitHub Actions as required rollout gate for Jangar production changes; avoid local rollout bypass.

## References

- PR: `https://github.com/proompteng/lab/pull/4044`
- Merge commit: `95735e00630c4125ac2982d9313f5214504fd305`
- Incident-related follow-up commits on PR branch:
  - `b4292573`
  - `6fc114cf`
