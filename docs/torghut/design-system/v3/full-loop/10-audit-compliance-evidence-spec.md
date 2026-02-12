# 10. Audit and Compliance Evidence Spec

## Objective
Define the mandatory evidence package for every promotion decision and major incident, ensuring traceability,
reproducibility, and compliance-aligned controls.

## Evidence Package Structure
- run metadata (`run_id`, `candidate_id`, timestamps, versions),
- strategy/config diff,
- dataset and feature version manifests,
- gate pass/fail outputs,
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
