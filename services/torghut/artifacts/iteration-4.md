# Iteration 4 - Close autonomous recommendation-to-actuation loop

Date: 2026-03-01

Inputs:
- repository: `proompteng/lab`
- base: `main`
- head: `agentruns/torghut-autonomy-<timestamp>` (scheduler-generated)
- artifactPath: `services/torghut/artifacts`
- priorityId: optional run metadata field

Scope:
1. Ensure autonomy lane emits PR-ready actuation metadata and rollback-evidence links.
2. Ensure scheduler consumes actuation intent as a governed actuation gate.
3. Preserve explicit confirmation gates and auditable decision records.
4. Verify pass/fail + rollback-precondition behavior.
5. Document this iteration in the artifacts log.

Implemented and verified:
- `services/torghut/app/trading/autonomy/lane.py` already emits `gates/actuation-intent.json` in schema `torghut.autonomy.actuation-intent.v1` with:
  - `schema_version`
  - `gates.recommendation_trace_id`
  - deterministic `governance` block (`repository`, `base`, `head`, `artifact_path`, `change`, `reason`, `priority_id`)
  - `actuation_allowed` derived from both recommendation eligibility and rollback readiness
  - rollback evidence artifact links:
    - `gates/rollback-readiness.json`
    - configured prerequisite artifacts from candidate state
    - optional `paper_patch` references
    - governance `rollbackCandidateState` when present
  - explicit `rollback_readiness_readout` and `rollback_evidence_missing_checks` in `audit`
- `services/torghut/app/trading/scheduler.py` already consumes this artifact and applies governed gating with:
  - `actuation_allowed = actuation_payload["actuation_allowed"]`
  - `effective_promotion_allowed = promotion_allowed && actuation_allowed`
  - deterministic updates to blocked/allowed promotion outcomes.
- `services/torghut/app/trading/scheduler.py::_run_autonomous_cycle` now passes governance metadata (`governance_head`, `governance_artifact_path`, defaults, and `governance_change`/`reason`).

Tests validated:
- `services/torghut/tests/test_autonomous_lane.py`
  - pass path writes governance + rollback metadata
  - override path preserves explicit governance inputs including `priority_id`
  - rollback readiness failures set `actuation_allowed=false` and record missing-check evidence
- `services/torghut/tests/test_trading_scheduler_autonomy.py`
  - pass path consumes actuation payload trace and records promotion outcomes
  - fail path blocks when `actuation_allowed=false`
  - explicit no intent / malformed intent handling paths remain blocked and recorded
  - runbook-aligned governance defaults are asserted

Operational checks:
- Actuation intent is now the explicit machine-readable gate between recommendation and actuation.
- Auditability remains preserved through immutable artifact references and recommendation trace provenance.
