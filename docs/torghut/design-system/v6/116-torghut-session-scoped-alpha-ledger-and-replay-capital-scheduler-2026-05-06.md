# 116. Torghut Session-Scoped Alpha Ledger And Replay Capital Scheduler (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: historical simulation, replay, Lean backtest APIs, and local replay scripts exist, but older monolithic simulation assumptions have been split.
- Matched implementation area: Simulation, replay, backtesting, and Lean.
- Current source evidence:
  - `services/torghut/scripts/run_local_simple_lane_replay.py`
  - `services/torghut/scripts/verify_historical_simulation_parity.py`
  - `services/torghut/app/api/trading_misc/lean_backtests.py`
  - `services/jangar/src/routes/api/torghut/simulation/runs.ts`
  - `argocd/applications/torghut/historical-simulation-workflowtemplate.yaml`
- Design drift note: Simulation docs must be checked against current split scripts and Jangar simulation routes.


## Decision

Torghut should add a **session-scoped alpha ledger and replay capital scheduler** before any new paper or live capital
path.

The current system is operational enough to learn, but not safe enough to size. Torghut `/healthz` returns HTTP `200`,
live revision `torghut-00235` and sim revision `torghut-sim-00319` are running, Postgres and ClickHouse are healthy,
Alpaca is reachable as live account `PA3SX7FYNUTF`, the Jangar universe is fresh with 12 symbols, and global Jangar
quant metrics are fresh. That is enough to keep observation, replay, and proof repair moving.

The same service state says capital should remain held. Torghut `/readyz` is HTTP `503`, live submission is disabled,
empirical jobs are degraded, dependency quorum is blocked, three hypotheses require rollback, and zero hypotheses are
promotion eligible. Market context health is degraded and stale. Signal lag is high, but Torghut correctly labels the
state `expected_market_closed_staleness` because the market is closed. The architecture should use that closed-market
time to produce replay receipts and pre-open proof, not treat it as either live signal failure or permission to ignore
other proof debt.

The selected design makes each hypothesis carry a session ledger. The capital scheduler then spends the next proof or
paper slot on the hypothesis with the best expected information value, capital-unlock probability, and risk-adjusted
post-cost edge. Broker capital stays at zero until the exact account, strategy, window, and market session has a
Jangar settlement that allows the action.

The tradeoff is slower capital reentry. I accept that because the current blockers are high-signal: stale empirical
jobs from March, stale market context, open scoped quant alerts, and rollback-required hypotheses. The fastest path to
profit is to rank and close those proof gaps, not to route around them.

## Evidence Snapshot

### Cluster And Runtime Evidence

- Torghut pods were running for live, simulation, Postgres, ClickHouse replicas, Keeper, options catalog/enricher,
  options TA, live TA, sim TA, websocket services, guardrail exporters, Alloy, and Symphony.
- Recent Torghut events included failed sim `teardown-clean` and `activity` analysis runs, Knative startup/readiness
  probe failures during sim rollout, and duplicate ClickHouse PodDisruptionBudget matches.
- `torghut-sim-00319` became the latest ready simulation revision after the prior sim revision had probe misses.
- Temporal core services were running, but one Elasticsearch replica was pending because anti-affinity could not be
  satisfied on the available nodes.
- Rook/Ceph events reported OSD scheduling and reconcile failures, creating a proof-artifact/checkpoint confidence
  risk for Flink-backed replay.

### Database And Data Evidence

- Direct CNPG access was forbidden by RBAC, so database assessment used Torghut `/db-check`, Torghut readiness, and
  Jangar projections.
- `/db-check` returned HTTP `200`, expected and current Alembic head
  `0029_whitepaper_embedding_dimension_4096`, `schema_graph_lineage_ready=true`, and `account_scope_ready=true`.
- `/db-check` warned that account-scope checks are bypassed while multi-account trading is disabled.
- `/readyz` returned HTTP `503` with healthy Postgres, ClickHouse, Alpaca, database schema, and Jangar universe.
- `/readyz` also reported `simple_submit_disabled`, capital stage `shadow`, empirical jobs `degraded`, promotion
  eligible total `0`, rollback required total `3`, and quant evidence `quant_health_not_configured`.
- `/trading/status` reported `last_run_at=2026-05-06T11:12:04Z`, `last_reconcile_at=2026-05-06T11:11:58Z`,
  market session closed, signal lag around `51176` seconds, signal state `expected_market_closed_staleness`, and
  no signal alert active.
- `/trading/status` reported three hypotheses: `H-CONT-01` and `H-REV-01` in shadow, `H-MICRO-01` blocked, all with
  capital multiplier `0`, rollback required, and no promotion eligibility.
- Empirical jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` were
  stale despite being truthful and persisted from the March 18 dataset snapshot.
- Jangar market-context health for `AAPL` had degraded domains and a bundle quality score around `0.4575`.
- Jangar quant health had fresh global metrics, but quant alerts still contained open critical scoped lag alerts.

### Source Evidence

- `services/torghut/app/main.py` assembles readiness, trading health, empirical jobs, hypothesis readiness, live
  submission gates, and control-plane contract payloads.
- `services/torghut/app/trading/hypotheses.py` already evaluates dependency quorum, signal continuity, market context,
  feature coverage, drift governance, promotion eligibility, rollback requirements, and capital stage by hypothesis.
- `services/torghut/app/trading/submission_council.py` already consumes Jangar quant health and dependency quorum.
- `services/torghut/app/trading/empirical_jobs.py` already classifies empirical job freshness, truthfulness, and
  promotion authority.
- `services/torghut/app/trading/scheduler/pipeline.py` records market-context observations, signal continuity, LLM
  decision context, rejection reasons, and order-submission preparation.
- Existing tests cover the natural seams: `test_hypotheses.py`, `test_empirical_jobs.py`,
  `test_submission_council.py`, `test_trading_api.py`, `test_market_context.py`, and `test_promotion_truthfulness.py`.

## Problem

Torghut knows why capital is blocked, but it does not yet decide which session proof should be produced next.

The current blockers are materially different:

- closed-market signal staleness is expected and should schedule replay;
- stale empirical jobs are a proof gap and should block capital;
- stale market context should block event-reversion capital and LLM discretion;
- open scoped quant alerts should block the affected account/strategy/window;
- rollback-required hypotheses should block paper/live action until rehearsal clears them;
- storage/search instability should lower proof confidence, not stop all research.

Without a session ledger, these facts compete as broad readiness reasons. The next profitable architecture is a
capital scheduler that uses closed-market time to make tomorrow's proof cheaper and more precise.

## Alternatives Considered

### Option A: Keep Shadow-Only Until Every Current Readiness Reason Is Green

Pros:

- Maximally conservative for broker capital.
- Simple to operate.
- Compatible with the existing `simple_submit_disabled` posture.

Cons:

- Does not choose which proof gap to close first.
- Leaves stale empirical jobs and stale market-context data to manual prioritization.
- Wastes closed-market time that could produce replay receipts and pre-open context.
- Delays profit learning even when read-only replay is safe.

Decision: reject as the architecture. Keep it as the emergency posture.

### Option B: Promote Only The Fastest Path Back To Intraday TSMOM

Pros:

- Reuses the most familiar strategy family and empirical artifacts.
- Minimizes implementation scope.
- Could recover paper trials faster than building a broader scheduler.

Cons:

- Concentrates learning on one family even when event-reversion and microstructure gaps have different proof costs.
- Does not solve stale scoped quant alerts or market-context freshness.
- Risks optimizing for what is easiest to replay rather than what has the best expected edge.

Decision: reject as the primary system. TSMOM stays a candidate in the scheduler.

### Option C: Session-Scoped Alpha Ledger With Replay Capital Scheduling

Pros:

- Turns market-closed time into replay, context refresh, and rollback rehearsal work.
- Ranks hypotheses by expected information value, capital unlock probability, post-cost edge, proof cost, and risk.
- Consumes Jangar session settlement before paper/live actions.
- Keeps zero-notional research active while live submission stays disabled.
- Produces concrete handoff gates for engineer and deployer stages.

Cons:

- Adds a ledger and scheduler contract.
- Requires conservative scoring to avoid converting proof gaps into permission to trade.
- Needs clean expiry semantics for stale session proof.

Decision: select Option C.

## Architecture

Torghut adds a durable `session_alpha_ledger` and a `replay_capital_schedule`.

```text
session_alpha_ledger
  ledger_id
  market_session_id
  account
  hypothesis_id
  strategy_id
  window
  capital_stage
  jangar_settlement_id
  signal_state
  market_context_state
  empirical_job_state
  quant_alert_state
  rollback_state
  post_cost_edge_bps
  avg_abs_slippage_bps
  expected_information_value
  capital_unlock_probability
  proof_confidence
  decision                # observe, replay, repair, paper_canary, live_hold
  reasons
  evidence_refs
  expires_at
```

```text
replay_capital_schedule
  schedule_id
  created_at
  target_market_session_id
  budget_seconds
  max_parallel_replays
  candidates
  selected_actions
  rejected_actions
  expected_capital_stage_after_close
  rollback_plan_ref
```

The first scheduler candidates are:

- `H-CONT-01` continuation: run closed-market replay and signal-lag proof first because it is shadow, depends on
  signal continuity and empirical jobs, and already has positive post-cost expectancy proxy but unacceptable slippage.
- `H-REV-01` event reversion: refresh market context and run pre-open event replay because it is directly blocked by
  market-context freshness.
- `H-MICRO-01` microstructure breakout: defer paper work until feature rows and drift checks exist; spend only low-cost
  feature-coverage proof until then.

## Measurable Trading Hypotheses

- `H-CONT-01`: If closed-market replay clears signal continuity and empirical replay for the active universe, then a
  paper canary should produce at least `6` post-cost bps with average absolute slippage under `12` bps over 40 samples.
- `H-REV-01`: If market-context bundles are fresh before the open and event-reversion replay clears rollback rehearsal,
  then a paper canary should produce at least `8` post-cost bps with average absolute slippage under `12` bps over 30
  samples.
- `H-MICRO-01`: If feature coverage and drift checks become available for microstructure signals, then the hypothesis
  may enter replay only after feature batch rows are non-zero and scoped quant alerts are clean for the selected
  window.

These are not live-trading permissions. They are proof targets that can graduate only through Jangar settlement.

## Guardrails

- Broker-facing live submission remains disabled until a separate deployer gate enables it.
- Capital multiplier stays `0` unless the exact account/hypothesis/window has a Jangar settlement allowing paper or
  live action.
- Stale empirical jobs block paper/live capital even if route health and global quant metrics are fresh.
- Market-context stale state blocks event-reversion paper/live action and LLM discretion.
- Open critical scoped quant alerts block the affected scoped action until netted by newer scoped proof.
- Rollback-required hypotheses cannot run paper/live canaries until rollback rehearsal is recorded.
- Storage/search degradation can delay replay-dependent capital but should not block zero-notional observation.

## Validation Gates

Engineer acceptance:

- Add unit coverage for ledger scoring when market is closed and signal staleness is expected.
- Add unit coverage that stale empirical jobs block paper/live while allowing replay/repair scheduling.
- Add unit coverage that fresh global quant metrics do not clear open scoped alerts for capital.
- Add API coverage that `/readyz` and `/trading/status` expose current `ledger_id`, `jangar_settlement_id`, selected
  replay actions, and blocked reasons.
- Add a dry-run script or command that produces a replay schedule for the current three hypotheses without broker
  side effects.

Deployer acceptance:

- Show a current ledger entry for each active hypothesis before any paper canary.
- Show the Jangar settlement ID and replay receipt that authorize the selected action.
- Show empirical job freshness, market-context freshness, quant alert state, and rollback state for the selected
  account/hypothesis/window.
- Show the rollback plan and disable flag path before enabling paper enforcement.

## Rollout Plan

1. Implement ledger and scheduler in dry-run mode with no broker side effects.
2. Expose the dry-run schedule in `/trading/status` and Jangar Torghut quant UI.
3. Run closed-market replay schedules for three sessions and compare predicted proof closure to actual readiness
   improvements.
4. Allow paper canary scheduling only after Jangar session settlement exists for the exact candidate.
5. Consider live micro-canary only after paper canary settlement, broker reconciliation, TCA freshness, and rollback
   rehearsal are clean.

## Rollback Plan

- Disable scheduler consumption and keep existing shadow-only posture.
- Preserve ledger records for audit, but ignore their decisions for capital.
- If scoring is wrong, force all candidate decisions to `repair` and set capital stage to `shadow`.
- If Jangar settlement is missing or malformed, fail closed for paper/live and keep replay/repair read-only.

## Risks

- Replay can overfit stale March artifacts. Mitigation: require current session IDs and explicit expiry.
- The scheduler may favor cheap proof over profitable proof. Mitigation: include expected post-cost edge and capital
  unlock probability, not only runtime cost.
- Market-context refresh can be provider-healthy but still stale at bundle level. Mitigation: capital gates read bundle
  freshness, domain states, and quality score, not provider success alone.
- Storage/checkpoint instability can make replay artifacts unreliable. Mitigation: proof confidence consumes Jangar
  rollout/storage confidence and delays capital when artifact confidence is low.

## Handoff

Engineer stage owns the dry-run ledger, scheduler scoring, tests, and API projection. It should not change broker
submission behavior in the first slice.

Deployer stage owns proof of current session settlement before paper enforcement: one ledger entry, one replay receipt,
one Jangar settlement, clean rollback rehearsal, and a documented disable path. Live capital remains out of scope until
paper settlement is positive after costs and cleanly reconciled.
