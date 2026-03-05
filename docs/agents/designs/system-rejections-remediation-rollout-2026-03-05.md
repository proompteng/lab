# System Rejections Remediation Rollout (2026-03-05)

Status: Implementing (2026-03-05)

Docs index: [README](../README.md)
Operational baseline: [jangar-torghut-live-analysis-playbook](./jangar-torghut-live-analysis-playbook.md)

## Objective

Reduce defect-driven rejections across Torghut trading and Jangar/Torghut agent orchestration, while preserving
fail-closed risk controls and rolling changes out only through GitHub Actions + GitOps.

## Scope

- Trading rejection classes with clear defect signatures:
  - `universe_source_unavailable:*`
  - `qty_below_min`
  - `llm_error`
- AgentRun failures with invalid/missing required prompt configuration.
- Torghut database backup and WAL archive continuity.

Non-goals:

- Relaxing intentional policy rejects (`shorts_not_allowed`, hard risk caps) without governance review.
- Direct cluster mutation as a standard rollout mechanism.

## Baseline Snapshot (Observed 2026-03-05 UTC)

- Mar 4, 2026 ET trading day: `132/132` decisions rejected, `0` executions.
- Dominant reject reasons on Mar 4 ET:
  - `llm_veto` 51
  - `qty_below_min` 46
  - `universe_source_unavailable:error:jangar_http_error_cache_stale` 35
- Last 14 days: rejected `1126`, filled `36`, expired `61`.
- Agent failures (24h):
  - `torghut-news-agent` and `torghut-fundamentals-agent` failed with
    `MissingSystemPromptConfiguration`.
- Backup posture:
  - `jangar-db`: continuous backup configured.
  - `torghut-db`: continuous backup not configured.

## Rejection Taxonomy

### Defect rejects (must trend to near-zero)

- Invalid/missing Agent defaults required by controller contracts.
- Universe continuity failures that hard-block execution despite viable fallback options.
- Sizing rejects caused by configuration/runtime mismatch rather than explicit risk policy.

### Policy rejects (expected but monitored)

- `llm_veto`
- `shorts_not_allowed`
- concentration/capacity limits

### External rejects

- broker-side rejects (e.g., API/account restrictions).

## Design Changes

### 1. Agent defaults hardening (P0)

- Add explicit `spec.defaults.systemPromptRef` for Torghut market-context agents.
- Use dedicated prompt ConfigMaps to avoid accidental dependence on unrelated defaults.
- Add manifest-level contract check in CI to prevent regressions.

### 2. Universe continuity with bounded fallback (P0)

- Preserve fail-closed posture for empty/no-data cases.
- Add deterministic fallback path for Jangar unavailability:
  - fallback to configured static symbols only when enabled,
  - mark resolution as `degraded`,
  - emit explicit fallback reason codes and cache age.
- Keep kill-switch semantics intact when no valid fallback exists.

### 3. Sizing reject reduction (P1)

- Enable fractional equities in live config for long-side equity orders.
- Retain short-increasing constraints and broker policy checks.
- Keep full reason attribution in allocator/execution metadata for audits.

### 4. Torghut DB backup/WAL continuity (P1)

- Configure CNPG `barmanObjectStore` for `torghut-db`.
- Add Ceph ObjectBucketClaim dedicated to Torghut DB backups.
- Configure retention policy and daily scheduled backup.

## Rollout Contract (GitHub Actions Only)

1. Work branch from fresh `main`.
2. PR required; no direct cluster `kubectl apply` for normal rollout.
3. Required checks:
   - lint/format for touched paths,
   - Torghut targeted tests,
   - manifest contract checks,
   - policy checks.
4. Merge via squash only after green checks.
5. Argo CD sync from merged manifests.
6. Post-deploy verify via playbook endpoints and rejection metrics.

## Acceptance Criteria

- `MissingSystemPromptConfiguration` failures for Torghut market-context agents: `0` for 7 consecutive days.
- `universe_source_unavailable:*cache_stale` reject reasons: `0` during market hours for 5 consecutive trading days.
- `qty_below_min` reject ratio: `< 2%` of daily decisions for 5 consecutive trading days.
- Torghut backup SLO:
  - successful scheduled backup daily,
  - continuous WAL archive healthy,
  - documented restore drill success in non-prod.

## Operational Verification

- Agent health:
  - `kubectl -n agents get agent`
  - `kubectl -n agents get agentrun --sort-by=.metadata.creationTimestamp`
- Trading control plane:
  - `/trading/status`
  - `/trading/health`
- Rejection distribution:
  - `trade_decisions` grouped by `risk_reasons` on ET trading-day window.
- Backup health:
  - `kubectl -n torghut get cluster torghut-db -o yaml` backup section and status conditions.

## Risks and Mitigations

- Risk: static fallback could mask prolonged Jangar outage.
  - Mitigation: degraded status, explicit reason codes, alerting, bounded fallback policy.
- Risk: fractional equities behavior divergence across execution adapters.
  - Mitigation: long-side only enablement + targeted adapter tests and broker precheck rejects preserved.
- Risk: backup path misconfiguration in Ceph credentials.
  - Mitigation: OBC-managed credentials, scheduled backup status checks, restore drill requirement.

## Ownership

- Torghut service/runtime: trading rejection reductions and fallback logic.
- Agents platform/Jangar: agent defaults contract compliance.
- SRE/Data platform: CNPG backup and restore validation.
