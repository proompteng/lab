# Iteration 3 - Governed actuation metadata for autonomous loop closure

Date: 2026-03-01

Scope:
- Close the autonomy loop so scheduler decisions are governed by `actuation-intent.json`.
- Extend actuation artifacts with PR-ready governance metadata + rollback evidence links.
- Preserve deterministic hard-gating for promotion when rollback readiness is not met.
- Add pass/fail coverage for scheduler actuation-blocking behavior.
- Update docs/runbook alignment for governance handoff inputs.

Changes made:
1. `services/torghut/app/trading/autonomy/lane.py`
   - `_build_actuation_intent_payload` now emits a `governance` block (`repository`, `base`, `head`,
     `artifact_path`, `change`, `reason`, `priority_id`).
   - `run_autonomous_lane` wires governance metadata from scheduler inputs and emits it in every actuation intent.
2. `services/torghut/app/trading/scheduler.py`
   - `run_autonomy` orchestration now passes governance metadata into lane execution (`governance_head`,
     `governance_artifact_path`, `priority_id`, defaults).
   - `_apply_autonomy_lane_result` now reads `actuation-intent.json` as the canonical actuation gate and applies
     `effective_promotion_allowed = promotion_allowed && actuation_allowed` for metrics and state transitions.
   - Recommendation trace tracking now prefers the actuation-intent trace ID when present.
3. `services/torghut/tests/test_trading_scheduler_autonomy.py`
   - Added assertions for governance argument propagation, output path injection, and deterministic defaults.
   - Added explicit scheduler pass-path for actuation-intent trace precedence under allowed promotion.
   - Added regression coverage for blocked promotion path when actuation intent denies actuation.
4. `services/torghut/tests/test_autonomous_lane.py`
   - Added governance block assertions in the existing pass-path lane test.
   - Added override test for explicit governance values (repository/base/head/artifact path/change/reason/priority).
5. `docs/torghut/design-system/v1/operations-actuation-runner.md`
   - Added alignment note that autonomous actuation PR inputs should map from actuation-intent `governance` metadata.

Pass/fail validation:
- Pass path: `actuation-intent.json` contains `actuation_allowed=true`, governance metadata, and rollback evidence
  references under `artifact_refs`.
- Override path: explicit governance metadata is faithfully emitted when lane caller supplies custom repository/base/
  head/artifact inputs.
- Fail path: scheduler outcome records `blocked_*` counters when actuation intent blocks promotion.

Validation run:
- `cd services/torghut && . .venv/bin/activate && PYTHONPATH=. python -m pytest tests/test_autonomous_lane.py tests/test_trading_scheduler_autonomy.py`
- `cd services/torghut && . .venv/bin/activate && pyright --project pyrightconfig.json`
- `cd services/torghut && . .venv/bin/activate && pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && . .venv/bin/activate && pyright --project pyrightconfig.scripts.json`
- `cd services/torghut && . .venv/bin/activate && ruff check app/trading/autonomy/lane.py app/trading/scheduler.py tests/test_autonomous_lane.py tests/test_trading_scheduler_autonomy.py`
