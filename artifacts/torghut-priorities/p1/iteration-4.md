# Iteration 4 — Enforce artifact-derived promotion evidence and fail-closed checks

## Scope

- Replace synthetic promotion evidence references in autonomy promotion payloads with runtime artifact references.
- Require promotion evidence artifacts to be local, loadable JSON, and non-stale when age policy is set.
- Add fail-closed regression tests for missing/untrusted/stale promotion evidence.
- Keep DSPy promotion-gate reference immutability behavior and artifact-truth assertions in scope.

## Changes

- `services/torghut/app/trading/autonomy/lane.py`
  - Replaced hardcoded `stress_metrics.artifact_ref` values with the runtime `evaluation_report_path` in both promotion gate-report constructions.

- `services/torghut/app/trading/autonomy/policy_checks.py`
  - Extended evidence evaluation to validate all promotion evidence artifact references for:
    - `fold_metrics`
    - `stress_metrics`
    - `janus` evidence (`event_car`, `hgrm_reward`)
  - Added artifact trust checks: missing reference, untrusted scheme/`db:` prefix, outside-artifact-root paths, non-file paths, non-JSON payloads, and optional staleness checks using `promotion_evidence_max_age_seconds` and evaluation-time `now`.
  - Wired evaluation to pass `artifact_root` and `now` into evidence checkers so enforcement is end-to-end and deterministic.

- `services/torghut/tests/test_policy_checks.py`
  - Updated default fixture evidence refs to local artifact paths (`backtest/evaluation-report.json`).
  - Added regression tests for promotion blocked when stress evidence reference is missing, untrusted, and stale.

- `services/torghut/tests/test_governance_policy_dry_run.py`
  - Updated dry-run fixture stress evidence ref to runtime artifact path to match strict artifact validation behavior.

## Verification

- `python3 -m compileall -q services/torghut/app/trading/autonomy/lane.py services/torghut/app/trading/autonomy/policy_checks.py services/torghut/tests/test_policy_checks.py services/torghut/tests/test_governance_policy_dry_run.py` — **passed**
- `cd services/torghut && PATH=/tmp/torghut-venv/bin:$PATH PYTHONPATH=. DB_DSN='sqlite:///tmp/torghut-test.db' python3 -m unittest tests.test_policy_checks tests.test_governance_policy_dry_run` — **passed (24 tests)**
- `cd services/torghut && PATH=/tmp/torghut-venv/bin:$PATH PYTHONPATH=. DB_DSN='sqlite:///tmp/torghut-test.db' python3 -m unittest tests.test_llm_dspy_workflow` — **passed (17 tests)**
- `bunx oxfmt --check services/torghut/app/trading/autonomy/lane.py services/torghut/app/trading/autonomy/policy_checks.py services/torghut/tests/test_policy_checks.py services/torghut/tests/test_governance_policy_dry_run.py` — no-op (`Expected at least one target file`; python paths currently unmatched in oxfmt discovery)
- `bunx pyright --project services/torghut/pyrightconfig.json` — **failed** (`pyright` environment lacks many project deps: `alpaca`, `pydantic`, `sqlalchemy`, etc. imports unresolved). This is environmental/dependency scope, not behavior-specific to these changes.
