# Iteration 5 - Harden scheduler-to-lane actuation handoff inputs

Date: 2026-03-01

Inputs:
- repository: `proompteng/lab`
- base: `main`
- head: `agentruns/torghut-autonomy-<timestamp>` (or explicit override)
- artifactPath: `services/torghut/artifacts` (or explicit override)
- priorityId: optional

Scope:
1. Ensure autonomy outputs continue to emit PR-ready actuation metadata with rollback evidence links.
2. Wire scheduler orchestration inputs for governed actuation metadata (`repository`, `base`, `head`, artifact root, and optional `priority_id`).
3. Preserve explicit confirmation gates and auditable decision records while blocking promotion when hard gates fail.
4. Add regression coverage for pass/fail and override propagation.
5. Align actuation runbook docs with the governance artifact metadata contract.

Implemented and verified:
- `services/torghut/app/trading/scheduler.py`
  - `_run_autonomous_cycle` now accepts explicit governance inputs:
    - `governance_repository`, `governance_base`, `governance_head`, `governance_artifact_root`, and `priority_id`.
  - Artifact root resolution now uses `governance_artifact_root` when provided.
  - Governance metadata from these inputs is forwarded to `run_autonomous_lane`.
  - `priority_id` is propagated from scheduler to lane for actuation intent persistence.
- `services/torghut/tests/test_trading_scheduler_autonomy.py`
  - Added `test_run_autonomous_cycle_accepts_governance_overrides` asserting:
    - custom repository/base/head/path values are passed through to lane input
    - `priority_id` is forwarded
    - generated outputs land under the override artifact root
- `docs/torghut/design-system/v1/operations-actuation-runner.md`
  - Aligned run parameters and required contract keys with governance payload handoff fields:
    - added `artifact_path` and `priority_id`.
  - Updated run metadata field naming to `priority_id` for consistency.

Checks added/verified:
- `services/torghut/tests/test_trading_scheduler_autonomy.py::TestTradingSchedulerAutonomy::test_run_autonomous_cycle_accepts_governance_overrides`
- Existing pass/fail coverage for:
  - actuation allowed/blocked transitions
  - rollback readiness enforcement
  - no-signal handling

Operationally, this is a non-functional closure: the deterministic actuation gate remains unchanged, while inputs for governance handoff are now explicit and test-covered.
