# Historical Simulation Production Plan (Full-Day + Automated Argo + End-of-Run Analytics)

Last updated: **2026-02-28**
Status: **proposed implementation plan**
Owner: `services/torghut`

## 1) Outcome

Deliver a production-grade historical simulation workflow where one CLI command:

1. safely stages simulation runtime,
2. automatically handles Argo reconcile control for Torghut during the run,
3. replays a full trading day,
4. runs TA + Torghut with no strategy/risk behavior changes,
5. emits a complete statistical report (trade-level P&L, execution quality, LLM behavior, stability),
6. restores runtime and Argo settings automatically.

## 2) Current Gaps (Code-Derived)

Current starter script (`services/torghut/scripts/start_historical_simulation.py`) supports `plan|apply|teardown`, isolated topics/DBs, and replay, but has these gaps:

- Argo automation toggling is manual and outside the script.
- No first-class `run` mode that orchestrates apply -> wait -> report -> teardown.
- No enforced full-day coverage policy for simulation windows.
- No built-in end-of-run analytics artifact with per-trade P&L and system stability diagnostics.
- LLM evaluation endpoint exists (`/trading/llm-evaluation`) but is "today"-windowed and not tied to simulation run windows.

## 3) Target Operator Experience

Single command from `services/torghut`:

```bash
uv run python scripts/start_historical_simulation.py \
  --mode run \
  --run-id sim-2026-03-02-full-day-01 \
  --dataset-manifest config/simulation/full-day-2026-02-27.yaml \
  --confirm START_HISTORICAL_SIMULATION
```

Expected behavior:

- Auto-checks prerequisites and isolation guards.
- Temporarily sets Torghut Argo automation to `manual` (with captured prior value).
- Applies simulation config and replays data.
- Waits for completion criteria.
- Runs analysis script and writes final report bundle.
- Tears down simulation runtime config.
- Restores Argo automation to previous value (`auto` or `manual`) even on failures.

## 4) Scope and Non-Goals

In scope:

- Automation inside simulation run command.
- Full-day enforcement and coverage validation.
- Complete post-run report for performance/stability/LLM behavior.
- Production-safe rollback and idempotency.

Out of scope:

- Strategy logic changes for simulation-only behavior.
- Changes to contract schemas on Kafka topics.
- Replacing existing execution adapters beyond simulation persistence/route constraints already implemented.

## 5) Workstream A: Script Orchestration Upgrade

Primary file:

- `services/torghut/scripts/start_historical_simulation.py`

Changes:

- Add mode: `run`.
- Add mode: `report` (standalone analytics, rerunnable without replay).
- `run` state machine:
  - `preflight`
  - `argocd_prepare`
  - `apply`
  - `monitor`
  - `report`
  - `teardown`
  - `argocd_restore`
- Persist state transitions in run artifacts (`run-state.json`) so interrupted runs can be resumed safely.
- Add hard `finally` restore block for Argo + runtime restoration.

Acceptance criteria:

- `--mode run` from clean state yields report + teardown in one command.
- Re-running same `run_id` is idempotent and does not corrupt prior artifacts.

## 6) Workstream B: Argo Automation Control Inside Script

Goal: remove manual playbook steps for ApplicationSet automation mode switching.

Changes:

- Add `argocd` manifest block:

```yaml
argocd:
  manage_automation: true
  applicationset_name: product
  applicationset_namespace: argocd
  app_name: torghut
  desired_mode_during_run: manual
  restore_mode_after_run: previous
  verify_timeout_seconds: 600
```

- Script logic:
  - Read current automation mode for Torghut element in `ApplicationSet/product`.
  - Persist previous mode in state.
  - Patch to `manual` before apply.
  - Verify `Application torghut` no longer self-reverts simulation patches.
  - Restore previous mode during teardown/failure handling.

Safety controls:

- If pre-run mode capture fails -> abort before apply.
- If restore fails -> non-zero exit and explicit "restore-required" marker in artifacts.
- No silent success when Argo is left in unexpected mode.

Acceptance criteria:

- No manual `kubectl patch applicationset` needed in normal run path.
- Argo mode is restored after success and after forced failure injection.

## 7) Workstream C: Full Trading Day Enforcement

Goal: ensure each production simulation run covers a complete actionable session.

Changes:

- Add explicit window policy in manifest:

```yaml
window:
  profile: us_equities_regular
  trading_day: '2026-02-27'
  timezone: America/New_York
  start: '2026-02-27T14:30:00Z'
  end: '2026-02-27T21:00:00Z'
  min_coverage_minutes: 390
```

- Validate:
  - `end - start >= min_coverage_minutes`.
  - Source topic dump has coverage across full interval (not only sparse early slice).
  - For symbols with decisions/executions, actionable event distribution spans session instead of a narrow burst.

- Add optional strict mode:
  - fail run if replayed event timestamps do not cover at least `95%` of target session minutes.

Acceptance criteria:

- Script rejects short windows for full-day profile.
- Report includes explicit coverage stats and pass/fail.

## 8) Workstream D: End-of-Run Analytics Script

New file:

- `services/torghut/scripts/analyze_historical_simulation.py`

Inputs:

- `--run-id`
- `--dataset-manifest`
- `--simulation-db` (optional override)
- `--window-start` and `--window-end` (auto-derived from manifest by default)

Outputs under `artifacts/torghut/simulations/<run_token>/report/`:

- `simulation-report.json`
- `simulation-report.md`
- `trade-pnl.csv`
- `execution-latency.csv`
- `llm-review-summary.csv`

Metrics to compute:

1. Data integrity and replay
- dump/replay counts by topic
- partition/offset continuity checks
- out-of-window record rate

2. Signal -> decision -> execution funnel
- signals consumed
- decisions created/submitted/executed
- conversion rates and suppression reasons
- per-symbol and per-strategy funnel

3. Execution quality
- fill rate, cancel/reject rate
- expected vs actual adapter mismatch
- fallback ratio/reasons
- order lifecycle completeness (`execution_order_events` presence)
- latency: signal->decision, decision->submit, submit->first update

4. P&L and cost
- TCA proxy (`realized_pnl_proxy_notional`)
- trade-level realized P&L (FIFO lot matching by symbol)
- end-of-window unrealized P&L using final simulation price snapshot
- gross/net P&L with explicit cost assumptions
- per-trade and per-symbol contribution tables

5. LLM behavior and evals
- reviews by model and prompt version
- verdict distribution (approve/veto/adjust/abstain/escalate/error)
- confidence/calibration summary
- fallback and deterministic guardrail rates
- token usage and cost proxy
- relation between LLM verdict type and execution outcomes

6. Stability and safety snapshot
- feature-quality gate failures
- no-signal streak and continuity alerts
- scheduler/runtime errors
- rollback/emergency-stop flags
- route provenance coverage and mismatch ratios

7. Governance verdict
- PASS/WARN/FAIL with reason codes
- reasons include low sample size, missing execution telemetry, insufficient coverage, high fallback/error rates, etc.

Acceptance criteria:

- `simulation-report.json` is deterministic for same run artifacts.
- Report always includes caveats distinguishing proxy metrics vs full mark-to-market metrics.

## 9) Workstream E: Metrics Contract for Reports

Define a versioned report schema:

- `schema_version: torghut.simulation-report.v1`
- `run_metadata`
- `coverage`
- `funnel`
- `execution_quality`
- `pnl`
- `llm`
- `stability`
- `verdict`
- `artifacts`

This schema must be treated as a stable contract for downstream dashboards/CI checks.

## 10) Workstream F: Production Safety and Rollback

Requirements:

- Always restore runtime config + Argo mode on exit (`try/finally`).
- Emit `restore_status` block in final manifest.
- Add lock file per active run to prevent concurrent mutation runs.
- Keep hard blocks:
  - production DB target forbidden
  - production topic replay target forbidden
  - live execution mode forbidden during simulation

Failure handling:

- If report generation fails, teardown still executes.
- If teardown fails, script exits non-zero and writes explicit manual remediation commands.

## 11) Workstream G: Test Plan

Unit tests:

- window/full-day validation
- Argo mode capture/patch/restore path logic
- report metric aggregators (P&L FIFO, latency buckets, funnel rates)

Integration tests (targeted):

- `plan -> run -> report -> teardown` happy path with fixture dump
- Argo restore on injected failure
- idempotent rerun with existing dump/replay markers

Manual verification in cluster:

- one full-day simulation run with non-zero decisions/executions
- ensure runtime restored to live defaults and Argo mode restored
- verify report artifact includes all required sections and non-empty metrics where expected

## 12) Rollout Plan

Phase 1: Script foundations

- add `run` and `report` modes
- add state machine + resumable state

Phase 2: Argo automation

- wire ApplicationSet automation control/restore in-script
- validate failure restore path

Phase 3: Full-day enforcement

- enforce session coverage checks
- add strict coverage threshold

Phase 4: Analytics reporter

- implement report schema + computations
- add CSV exports and markdown executive summary

Phase 5: Productionization

- update playbook + README
- add CI smoke job for report schema validity
- execute one full-day empirical run and store artifact links

## 13) Definition of Done

Done means all are true:

- One command executes full simulation lifecycle with automated Argo handling.
- Run enforces full-day session coverage and fails short windows.
- Final report includes:
  - trade-level P&L analysis,
  - execution quality and latency,
  - LLM behavior/evaluation metrics,
  - system stability snapshot,
  - explicit PASS/WARN/FAIL verdict.
- Runtime + Argo settings are restored automatically on success/failure.
- Evidence bundle is sufficient to explain performance without ad-hoc manual queries.

## 14) Immediate Next Implementation Steps

1. Extend `start_historical_simulation.py` with `run` and `report` modes and Argo automation management.
2. Create `analyze_historical_simulation.py` with `torghut.simulation-report.v1` output schema.
3. Update playbook to replace manual Argo steps with in-script automation.
4. Execute one strict full-day run and validate report quality against the DoD.
