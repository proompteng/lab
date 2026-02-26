# Janus-Q Engineering Implementation Plan

- Run ID: `wp-d72cb1a5c1febdcfbd9dae71`
- Milestone: `M1` (event schema/CAR + HGRM scaffold + fail-closed promotion gating)
- Last updated (UTC): `2026-02-26`

## M1 Scope Status

| Item | Status | Evidence |
| --- | --- | --- |
| Implement deterministic event-centric schema + CAR scaffold artifact | ✅ Completed | `services/torghut/app/trading/autonomy/janus_q.py` (`build_janus_event_car_artifact_v1`) and lane emission to `gates/janus-event-car-v1.json` |
| Implement deterministic HGRM reward scaffold artifact | ✅ Completed | `services/torghut/app/trading/autonomy/janus_q.py` (`build_janus_hgrm_reward_artifact_v1`) and lane emission to `gates/janus-hgrm-reward-v1.json` |
| Wire Janus-Q evidence into runtime profitability/gate payloads | ✅ Completed | `services/torghut/app/trading/autonomy/lane.py` (`janus_q` evidence in profitability payload, gate payload, promotion evidence/provenance) |
| Enforce fail-closed gate behavior for incomplete Janus evidence | ✅ Completed | `services/torghut/app/trading/autonomy/gates.py` (`gate6_require_janus_evidence`, schema/count checks) |
| Enforce fail-closed promotion prerequisite checks for missing Janus artifacts | ✅ Completed | `services/torghut/app/trading/autonomy/policy_checks.py` (required artifacts + artifact schema/count checks + promotion evidence checks) |
| Update policy defaults to require Janus evidence for paper/live progression | ✅ Completed | `services/torghut/config/autonomy-gates-v3.json`, `services/torghut/config/autonomous-gate-policy.json` |
| Add deterministic regression tests for Janus scaffold + gate/policy integration | ✅ Completed | `services/torghut/tests/test_janus_q_scaffold.py` + updates to `test_autonomy_gates.py`, `test_policy_checks.py`, `test_autonomous_lane.py`, `test_governance_policy_dry_run.py` |

## Determinism and Safety Constraints

- Live trading remains disabled by policy (`gate5_live_enabled: false` in default configs).
- Promotion remains fail-closed when required Janus artifacts/evidence are missing or incomplete.
- Janus artifacts include deterministic manifest hashes and explicit schema versions for auditability.

## Validation Evidence

- Syntax validation completed:
  - `python3 -m py_compile services/torghut/app/trading/autonomy/janus_q.py services/torghut/app/trading/autonomy/lane.py services/torghut/app/trading/autonomy/gates.py services/torghut/app/trading/autonomy/policy_checks.py services/torghut/scripts/run_governance_policy_dry_run.py services/torghut/scripts/run_autonomous_lane.py services/torghut/tests/test_janus_q_scaffold.py services/torghut/tests/test_autonomy_gates.py services/torghut/tests/test_policy_checks.py services/torghut/tests/test_autonomous_lane.py services/torghut/tests/test_governance_policy_dry_run.py`
  - Result: pass

- Targeted runtime tests added but full execution is currently blocked in this environment by missing Python dependencies/tooling (`sqlalchemy`, `pytest`, `uv`, and `python` alias in subprocess harnesses).

