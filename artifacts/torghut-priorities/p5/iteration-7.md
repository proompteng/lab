# Iteration 7 — Artifact-truth enforcement for stress metrics and dry-run coverage

## Scope

- Enforce artifact-based stress evidence in autonomous promotion evidence paths.
- Remove synthetic/hardcoded stress evidence references from governance test harness paths.
- Add/extend regression coverage for blocked promotion when stress evidence is missing, stale, or untrusted.
- Continue fail-closed behavior for missing or invalid dependencies.

## Changes

- `services/torghut/app/trading/autonomy/lane.py`
  - Switched stress evidence bundle generation to use `_STRESS_METRICS_CASES` constant.
- `services/torghut/app/trading/autonomy/policy_checks.py`
  - Added required-stress-evidence gating and immutable artifact-truth checks (if already implemented in the previous pass): required artifact set extension, normalized/trusted artifact path resolution, staleness/schema checks, and hard dependency fail-closed behavior.
- `services/torghut/tests/test_policy_checks.py`
  - Added regression checks for missing, stale, and untrusted stress evidence.
  - Fixed stress metrics fixture structure and removed `/tmp` hardcoded untrusted path dependency.
- `services/torghut/tests/test_governance_policy_dry_run.py`
  - Replaced `db:research_stress_metrics` with `gates/stress-metrics-v1.json` in promotion evidence fixture.
  - Added regression cases for missing, stale, and untrusted stress metrics in the dry-run harness path.
- `services/torghut/scripts/run_governance_policy_dry_run.py`
  - Added stress-metrics fixture artifact generation inside the harness root.
  - Added CLI toggles for missing/stale/untrusted stress-metrics simulation.
- `services/torghut/tests/test_autonomous_lane.py`
  - Asserted stress artifact reference in report output and artifact reference list from actuation payload.

## Verification

- Plan is to validate with Torghut-focused checks (`uv` + `pyright` profiles + relevant unit tests) before opening the PR.
