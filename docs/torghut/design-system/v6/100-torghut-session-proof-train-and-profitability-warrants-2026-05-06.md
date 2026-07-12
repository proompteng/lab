# 100. Torghut Session Proof Train and Profitability Warrants (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

Torghut should implement **profitability warrants** that consume Jangar session proof train receipts and convert fresh
zero-notional proof into paper-capital, then eventually live-capital, requests.

The trading system is currently safe but not profitable. It is live-mode serving, schema-current, connected to
Postgres, ClickHouse, and Alpaca, and publishing current aggregate quant metrics through Jangar. It is not capital-ready:
empirical jobs are stale by more than forty days, all hypotheses are shadow or blocked, zero hypotheses are promotion
eligible, all three require rollback, live submission is disabled, quant evidence is not configured in Torghut's
submission gate, and the last 72-hour profitability window contains eight rejected decisions and zero executions.

The next architecture should not ask for live capital. It should create a market-session proof loop that turns stale
empirical proof, rejected-decision evidence, and scoped quant health into explicit warrants. A warrant can ask Jangar for
paper-capital authority only after the proof train has reduced the named proof debt. Live-capital authority remains a
separate, stricter warrant with no delay state.

The tradeoff is slower path to live trading. I accept that because the profitable path is not more orders from stale
evidence. It is a faster, more measurable loop from proof debt to paper validation to live eligibility.

## Evidence Snapshot

All assessment was read-only. Direct database shell access was unavailable to the runtime identity, so this document uses
typed service routes and source inspection as the audit path.

### Cluster Evidence

- `torghut-00225-deployment-6c9bbff5f6-bj9xx` and `torghut-sim-00306-deployment-75fb7bf4d9-c2k7m` were both
  `2/2 Running`.
- Torghut deployments were on image digest `18d356dfad7c570340444916885babbc8bc8b9649aef01791b66b9186c3f28b7`.
- The previous sim image pull failure mentioned in the shared soak had cleared.
- Recent rollout events still included readiness failures on prior revisions. Current serving health is not enough to
  infer proof freshness.
- `torghut-db-1`, ClickHouse replicas, Flink TA jobs, options catalog/enricher, websocket services, and guardrail
  exporters were running.
- Kubernetes `pods/exec` into Torghut Postgres and ClickHouse was forbidden. The design must use service routes and
  persisted artifacts for routine proof.

### Data And Route Evidence

- `GET /healthz` returned HTTP 200 with `status=ok`.
- `GET /db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, no missing heads, no unexpected heads, and lineage-ready state.
- The schema graph still reports known parent-fork warnings, but current and expected heads match.
- `GET /readyz` and `GET /trading/health` returned degraded payloads despite healthy Postgres, ClickHouse, Alpaca, and
  database schema checks.
- Degraded readiness reasons included `empirical_jobs` status `degraded`, live submission gate `simple_submit_disabled`,
  capital stage `shadow`, and quant evidence `quant_health_not_configured`.
- `GET /trading/status` showed `mode=live`, `running=true`, active revision `torghut-00225`, last run and reconcile at
  `2026-05-06T00:10:20Z`, `last_decision_at=2026-05-04T17:25:57.901670Z`, and no executions.
- Hypothesis runtime posture was three hypotheses total: one `blocked`, two `shadow`, three at capital stage `shadow`,
  zero promotion eligible, and three rollback required.
- Jangar dependency quorum in Torghut status was `block` with reason `empirical_jobs_degraded`.
- `GET /trading/empirical-jobs` returned four stale jobs:
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`. Each latest row was
  created `2026-03-21T09:03:22.150009+00:00` for candidate `intraday_tsmom_v1@prod` and dataset
  `torghut-full-day-20260318-884bec35`.
- `GET /trading/profitability/runtime` returned schema `torghut.runtime-profitability.v1`, a 72-hour decision count of
  eight, execution count zero, TCA sample count zero, and rejected decisions for
  `microbar-volume-continuation-long-top2-v11` on `AAPL`, `AMD`, `INTC`, and `NVDA`.
- Jangar aggregate quant health was fresh with 3,780 latest metrics and one-second lag, but Torghut's capital gate still
  reports quant evidence as not configured. That is a wiring and scoping gap.

### Source And Test Evidence

- `services/torghut/app/trading/empirical_jobs.py` already classifies empirical rows by job type, freshness,
  truthfulness, dataset snapshot, candidate ID, authority, and promotion eligibility.
- `services/torghut/app/trading/hypotheses.py` already compiles hypothesis state, capital stage, promotion eligibility,
  rollback requirement, dependency quorum, evidence continuity, market context, signal lag, and TCA blockers.
- `services/torghut/app/trading/submission_council.py` already blocks live submission on empirical jobs, Jangar
  dependency quorum, DSPy live readiness, quant evidence, certificate evidence, and critical toggle parity.
- `services/torghut/app/main.py` exposes the status, health, empirical job, profitability runtime, and DB-check routes
  needed for proof train input, but it is too broad to become the only profitability authority.
- Tests exist for empirical jobs, hypothesis governance, submission council quant evidence, trading API health/status,
  runtime profitability, and migration lineage. Missing coverage is the cross-route warrant: proof train receipt plus
  empirical recency plus scoped quant health plus rejection attribution producing a paper-capital request while live
  remains blocked.

## Problem

Torghut has proof surfaces, but it does not yet have session-scoped profitability warrants.

That leaves the system in a safe dead zone:

- empirical proof is stale and blocks dependency quorum;
- aggregate quant metrics are fresh, but the submission gate lacks configured scoped quant proof;
- recent decisions are rejected and are not being converted into ranked repair or retirement actions;
- live submission is disabled, which is correct, but there is no paper warrant path that names the proof gaps to close;
- runtime profitability can show an empty execution window without producing a concrete proof refresh plan.

The system needs to turn "capital is blocked" into "this exact proof must be refreshed before paper capital can be
requested."

## Alternatives Considered

### Option A: Open A Tiny Live Canary After Aggregate Quant Health Recovers

Use the fresh Jangar aggregate quant-health route as enough proof to open a very small live canary.

Pros:

- Fastest path to live executions.
- Tests the end-to-end order path.
- Avoids more architecture before action.

Cons:

- Ignores stale empirical jobs.
- Ignores Torghut's own `quant_health_not_configured` submission gate.
- Ignores zero executions and no TCA samples in the 72-hour window.
- Violates the existing shadow-first guardrails.

Decision: reject. This would trade safety for motion.

### Option B: Refresh Empirical Jobs And Then Revisit

Run the four stale empirical jobs, wait for `empirical_jobs` to turn healthy, then manually decide whether capital can
advance.

Pros:

- Directly targets the current quorum blocker.
- Reuses existing job contracts.
- Easy to measure.

Cons:

- Does not repair scoped quant evidence.
- Does not attribute rejected decisions.
- Does not produce a durable paper-capital warrant.
- Recreates manual judgment after every market session.

Decision: necessary first cargo, insufficient architecture.

### Option C: Profitability Warrants Consuming Session Proof Train Receipts

Require every paper or live capital request to cite fresh session proof train receipts and produce a typed warrant with
specific guardrails.

Pros:

- Converts proof debt into a repeatable market-session loop.
- Keeps live capital blocked while enabling zero-notional and paper proof progress.
- Makes empirical recency, scoped quant health, and rejection attribution explicit preconditions.
- Gives Jangar a small object to admit rather than forcing it to interpret the full trading status payload.
- Creates measurable hypotheses and rollback gates.

Cons:

- Requires new route and model tests.
- Adds warrant expiry and response digest handling.
- Forces strategy owners to accept retirement when warrants falsify the hypothesis.

Decision: select Option C.

## Architecture

### ProfitabilityWarrant

Torghut publishes a warrant per hypothesis, candidate, account, and session:

```text
profitability_warrant
  warrant_id
  schema_version
  generated_at
  fresh_until
  market_session
  hypothesis_id
  candidate_id
  strategy_id
  account
  requested_authority: zero_notional_repair | paper_capital | live_capital
  proof_train_receipts
  empirical_bundle
  scoped_quant_health
  rejection_attribution
  runtime_profitability_window
  capital_guardrails
  decision
  reason_codes
  evidence_refs
```

A warrant is an admission request, not an order. It never mutates capital by itself.

### Session Proof Inputs

Initial inputs:

- latest empirical job bundle from `build_empirical_jobs_status`;
- hypothesis runtime posture from `compile_hypothesis_runtime_statuses`;
- live submission gate from `build_live_submission_gate_payload`;
- Jangar session proof train receipts;
- scoped Jangar quant health for the exact account/window;
- runtime profitability window from `/trading/profitability/runtime`;
- recent rejected decisions grouped by strategy, symbol, and blocker reason;
- schema head and lineage data from `/db-check`.

### Warrant Decisions

`zero_notional_repair` can be `allow`, `delay`, or `block`.

`paper_capital` can be `allow`, `delay`, or `block`.

`live_capital` can only be `allow` or `block`.

The initial current-state decision must be:

- `zero_notional_repair=allow` for empirical refresh if Jangar train cargo is fresh and route budgets pass;
- `paper_capital=block` until empirical jobs are fresh, scoped quant health is configured, and rejected-decision
  attribution is complete;
- `live_capital=block` while `simple_submit_disabled` is active, paper warrant evidence is absent, or zero TCA samples
  exist.

### Required Initial Warrant Classes

1. `empirical_bundle_reclock_v1`
   - Debt: four stale empirical jobs from `2026-03-21`.
   - Success: all required jobs fresh under the configured stale window, truthful, same candidate, same dataset snapshot,
     authority `empirical`, and promotion authority eligible.
   - Capital effect: may unlock paper warrant evaluation, never live.

2. `scoped_quant_health_wiring_v1`
   - Debt: Torghut submission council reports `quant_health_not_configured` while Jangar aggregate quant health is fresh.
   - Success: scoped account/window quant health returns non-empty latest metrics, stage data when scoped, and a fresh
     digest consumed by the submission gate.
   - Capital effect: prerequisite for paper and live.

3. `rejected_decision_attribution_v1`
   - Debt: eight rejected decisions and zero executions in the 72-hour window.
   - Success: every recent rejection has a typed blocker owner, strategy/hypothesis mapping, and repair/retire decision.
   - Capital effect: can retire or demote a hypothesis; cannot promote alone.

4. `paper_tca_seed_v1`
   - Debt: zero executions and zero TCA samples.
   - Success: paper-only execution/TCA sample path collects enough samples to compute slippage and shortfall gates.
   - Capital effect: paper only until sample thresholds pass.

5. `status_route_budget_v1`
   - Debt: broad status payload pressure can make control-plane consumers overdepend on expensive reads.
   - Success: compact proof routes return bounded payloads with response digests and route budgets.
   - Capital effect: required for reliable warrant consumption.

## Measurable Trading Hypotheses

- Reclocking empirical jobs will reduce empirical proof age from the current `2026-03-21` bundle to the active session
  window and change authority from `blocked` to either `empirical` or a typed falsification reason.
- Scoped quant-health wiring will eliminate `quant_health_not_configured` from the live submission gate for the target
  account/window without treating aggregate metrics as account proof.
- Rejection attribution will reduce unknown blocker ownership to zero for the current `microbar-volume-continuation`
  lane and force either a repair candidate or hypothesis retirement.
- Paper TCA seeding will move the runtime profitability window from zero executions and zero TCA samples to a measurable
  paper sample set before any live request.
- A paper warrant that passes for two consecutive eligible sessions will predict a positive post-cost expectancy better
  than the current rejected-decision-only posture. If it does not, the warrant retires or demotes the hypothesis.

These are hypotheses, not profit guarantees. Each one can falsify the strategy and should be allowed to do so.

## Capital Guardrails

Capital remains closed unless all required warrant inputs are fresh and aligned:

- empirical bundle fresh, truthful, and same candidate/dataset lineage;
- scoped quant health configured and fresh for the account/window;
- Jangar train receipt fresh for the requested authority;
- no critical toggle mismatch;
- live submission gate not blocked by `simple_submit_disabled`;
- rejection attribution complete for recent decisions;
- paper TCA sample thresholds met before live;
- `live_capital` train decision is `allow`;
- rollback action is known and testable.

Live capital has no delay state. If any gate is missing or stale, it is blocked.

## Implementation Scope

Engineer stage should:

- Add a compact `ProfitabilityWarrant` builder under `services/torghut/app/trading`.
- Expose `GET /trading/control-plane/profitability-warrants` with filters for hypothesis, account, session, and
  authority.
- Reuse existing empirical job, hypothesis, submission council, and runtime profitability helpers.
- Add response digests and source refs rather than returning full heavyweight payloads by default.
- Add tests for current-state warrant decisions: empirical reclock allowed only with a Jangar train receipt, paper
  blocked by stale empirical jobs and missing scoped quant, live blocked by simple submit disabled and zero TCA samples.
- Add tests for two-session paper warrant progression and live-capital fail-closed behavior.

Jangar engineer stage should implement the companion session proof train and consume warrant summaries as cargo inputs.

## Validation Gates

Before merge of implementation:

- Unit tests cover stale empirical jobs, missing scoped quant health, rejected-decision attribution, zero TCA samples,
  expired proof train receipts, and live-capital fail-closed.
- `/trading/control-plane/profitability-warrants` returns the current state without mutating database rows.
- The endpoint can produce a compact response under the configured route budget.
- Existing `/trading/status`, `/trading/health`, `/trading/empirical-jobs`, and `/trading/profitability/runtime` tests
  remain green.

Before deployer enables paper-capital warrants:

- Jangar session proof train is live in shadow mode and fresh.
- Empirical job bundle has a current-session receipt or a typed falsification reason.
- Scoped quant health is configured and consumed by Torghut.
- Rejected-decision attribution is complete for the last 72-hour window.
- Paper capital request cites a warrant ID and train receipt ID.

Before deployer enables live-capital warrants:

- Two consecutive eligible paper sessions pass paper warrants.
- TCA sample thresholds and slippage budgets pass.
- `simple_submit_disabled` is no longer active by explicit config change.
- Jangar live-capital train decision is fresh and `allow`.
- Rollback has been dry-run for strategy disable, kill switch, and GitOps revert.

## Rollout Plan

1. Add warrant builder and route in observe mode.
2. Backfill current-state warrant fixtures from existing route payloads.
3. Wire Jangar train receipts as optional inputs.
4. Enable zero-notional repair warrants first.
5. Enable paper-capital warrants after empirical and scoped quant proof pass.
6. Keep live-capital warrants disabled until paper evidence and deployer rollback gates pass.

## Rollback Plan

- Disable warrant route consumption in Jangar while leaving Torghut status routes unchanged.
- If warrant builder fails, return `decision=block` for paper and live capital.
- If proof train receipts are stale, block all capital warrants and allow only explicitly configured zero-notional repair.
- If paper evidence falsifies a hypothesis, demote or retire the hypothesis rather than retrying live.

## Risks

- Warrant complexity can slow the trading loop. Mitigation: compact route, response digests, and cached inputs.
- Fresh empirical jobs can still prove the candidate is bad. Mitigation: treat falsification as useful output and retire
  the hypothesis.
- Paper evidence may not transfer to live. Mitigation: require live-specific guardrails and small live gates only after
  paper passes.
- Jangar and Torghut clocks can diverge. Mitigation: every warrant carries `generated_at`, `fresh_until`, market session,
  and train receipt timestamps.

## Engineer Handoff

Acceptance gates for engineer stage:

- Build warrant types and route without widening live submission permissions.
- Reuse existing helpers instead of duplicating empirical or hypothesis logic.
- Add tests proving the current live state blocks paper and live capital while allowing only bounded zero-notional repair
  when a fresh train receipt exists.
- Include route-budget and response-digest fields so Jangar can consume the endpoint safely.

## Deployer Handoff

Acceptance gates for deployer stage:

- Deploy observe-only warrants first.
- Confirm current state emits `paper_capital=block` and `live_capital=block`.
- Enable zero-notional repairs only after Jangar train cargo slots are fresh.
- Do not enable paper capital until empirical recency, scoped quant health, rejection attribution, and route budgets pass.
- Do not enable live capital until two paper sessions pass and rollback drills are complete.
