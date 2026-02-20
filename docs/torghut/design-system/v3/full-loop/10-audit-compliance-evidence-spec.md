# 10. Audit and Compliance Evidence Spec

## Objective
Define the mandatory evidence package for every promotion decision and major incident, ensuring traceability,
reproducibility, and compliance-aligned controls.

## Evidence Package Structure
- run metadata (`run_id`, `candidate_id`, timestamps, versions),
- strategy/config diff,
- dataset and feature version manifests,
- gate pass/fail outputs,
- profitability evidence contract (`profitability-evidence-v4.json`) with:
  - risk-adjusted metrics (`return_over_drawdown`, `sharpe_like`, regime pass ratio),
  - cost/fill realism (`cost_bps`, turnover, recorded-vs-fallback impact assumptions),
  - confidence/calibration summary (sample count, mean/std confidence, calibration error),
  - reproducibility hashes (artifact sha256 map + manifest hash),
- benchmark comparison (`profitability-benchmark-v4.json`) baseline vs candidate across:
  - `market:all`,
  - one or more `regime:*` slices,
- validator output (`profitability-evidence-validation.json`) with machine-readable pass/fail reasons,
- promotion gate decision (`promotion-evidence-gate.json`) with reason codes and artifact pointers,
- shadow/paper/live metrics,
- risk and execution control logs,
- approval records and reviewer identities.

## Evidence Sources
- Postgres decision/execution/audit tables,
- ClickHouse signal and market context snapshots,
- Git commits and PR metadata,
- AgentRun/ImplementationSpec run artifacts,
- monitoring alerts and incident logs.

## Retention Policy
- promotion evidence retained for required policy duration.
- incident evidence retained for extended duration.
- immutable checksums for archived artifacts.

## Access and Integrity
- write-once evidence manifests,
- role-scoped read access,
- hash verification for artifact integrity,
- no sensitive secret leakage in evidence payloads.
- no promotion when profitability evidence artifacts or reproducibility hashes are missing.

## Compliance Mapping
- pre-trade control evidence,
- kill-switch and rollback evidence,
- model governance and approval evidence,
- post-incident corrective action evidence.

## Agent Implementation Scope (Significant)
Workstream A: evidence schema
- define JSON and table schemas for evidence package.

Workstream B: collectors/exporters
- implement artifact collectors and evidence exporter CLI.

Workstream C: retention controls
- enforce retention lifecycle and archive verification.

Workstream D: audit report generation
- produce human-readable and machine-readable audit packs.

Owned areas:
- `services/torghut/app/models/entities.py`
- `services/torghut/migrations/**`
- `services/torghut/scripts/**`
- `docs/torghut/design-system/v3/**`

Minimum deliverables:
- evidence schema and migrations,
- exporter and validator,
- retention policy implementation,
- audit report templates.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v3-audit-pack-v1`.
- Compatibility alias (deprecated): `torghut-v3-audit-evidence-impl-v1`.
- Required keys:
  - `runId`
  - `artifactRefs`
  - `complianceProfile`
  - `outputPath`
- Exit criteria:
  - evidence package can be generated for any promoted run,
  - integrity hashes validated,
  - required compliance fields complete.
