# Iteration 5 — Contamination-safe promotion evidence

## Inputs
- repository: `proompteng/lab`
- base: `main`
- head: `codex/torghut-p1-contam-loop5-20260301a`
- artifactPath: `artifacts/torghut-priorities/p1`
- priorityId: `P1`

## Scope completed
- Replaced synthetic/fallback gate inputs used for autonomy promotion decisions with artifact-derived/runtime-evaluated data:
  - `runbookValidated` now resolves from the strategy configmap path and requires a valid YAML config payload.
  - `rollbackReadiness` now derives readiness from runtime config validity, strategy availability, and live approval-token presence.
- Hardened DSPy promotion gate evidence resolution to immutable artifact truth:
  - Promotion-gate overrides can no longer smuggle metric compatibility values.
  - `evalReportRef` override is removed from promotion parameters while still tracked as requested input for audit.
  - Gate evaluation now resolves strictly to `${artifactRoot}/eval/dspy-eval-report.json` and fails if missing, stale, invalid, malformed, or path-overridden.
- Added/strengthened regression coverage in `services/torghut/tests` for fail-closed behavior on missing/invalid runbook evidence and DSPy evidence integrity failures.

## Notes
- No user-facing behavior changes outside gating decisions were introduced.
- Promotion can only proceed when all required evidence checks pass and are artifact-authoritative.
