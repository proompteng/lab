# 120. Torghut Capital Activation Receipts And Shadow Profit Proof Queue (2026-05-06)

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

I am selecting a **capital activation receipt plus shadow profit proof queue** for Torghut.

The current Torghut surface is operationally better than the earlier soak but still not capital-ready. Argo CD reports
Torghut `Synced` and `Healthy` at revision `54f5a353c5481f1ac2c54866499d035bef74b37b`, live revision
`torghut-00237` and sim revision `torghut-sim-00323` are running, `/db-check` is HTTP `200`, Postgres and ClickHouse
are reachable from the service, and sim `/readyz` is `ok`. That is enough to observe and repair.

It is not enough to allocate capital. Live `/readyz` and `/trading/health` were HTTP `503` with
`simple_submit_disabled`. Live quant health was not configured by the live route. The Jangar typed live quant route was
routable but stale by `68122` seconds. The sim quant route was reachable but empty. Market context for `AAPL` was
`down`, with missing fundamentals/news and source errors for technicals/regime. Empirical jobs were truthful but stale
from `2026-03-21`, and Jangar still showed `50` open quant alerts.

The selected design requires Torghut to issue one activation receipt per account, strategy, window, hypothesis, and
market session before moving from observe to shadow repair, paper canary, live micro-canary, or live scale. The receipt
names the Jangar controller witness receipt it consumed, the proof repairs still required, the expected profit
hypothesis, and the maximum notional. Separately, a shadow profit proof queue ranks zero-notional repairs that are
expected to unlock profitable paper canaries without increasing live risk.

The tradeoff is that paper will move more slowly. I accept that. Paper should be a market-quality falsification lane,
not a place where disabled empirical jobs, empty sim metrics, and missing market context get laundered into live
permission.

## Evidence Snapshot

All evidence collection was read-only. No trading flags, orders, database rows, Argo applications, Kubernetes
resources, or broker records were changed.

### Cluster And Rollout Evidence

- Torghut was `Synced` and `Healthy` in Argo CD at revision `54f5a353c5481f1ac2c54866499d035bef74b37b`.
- Live revision `torghut-00237` and sim revision `torghut-sim-00323` were running.
- ClickHouse, Keeper, Torghut Postgres, live TA, sim TA, options TA, options catalog, options enricher, websocket, Alloy,
  and Symphony pods were running.
- Recent events showed rollout settlement: new live/sim revisions became ready, old live/sim revisions scaled down, and
  bootstrap/backfill jobs completed.
- Transient readiness probe misses occurred during rollout replacement for old Torghut revisions and options pods, but
  the current pods were running in the sample.
- The service account could not list Knative services in the Torghut namespace and could not exec into Torghut or
  Jangar database pods. Routine validation must use service-owned projections.

### Data, Schema, And Freshness Evidence

- Torghut `/db-check` returned HTTP `200`, `ok=true`, `schema_current=true`, `current_heads` matching
  `0029_whitepaper_embedding_dimension_4096`, `schema_graph_lineage_ready=true`, and `account_scope_ready=true`.
- Live `/readyz` returned HTTP `503`, `status=degraded`, `live_submission_gate.allowed=false`, and reason
  `simple_submit_disabled`.
- Live `/trading/health` returned HTTP `503` with Postgres, ClickHouse, Alpaca, database, and universe healthy, but live
  submission blocked and quant health not configured.
- Sim `/readyz` returned `status=ok` and `live_submission_gate.allowed=true` because it is non-live mode, but
  `quant_evidence.status=degraded`, `latest_metrics_count=0`, and `empty_latest_store_alarm=true`.
- Jangar typed quant health for live account `PA3SX7FYNUTF` returned `status=ok` but had
  `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z` and `metricsPipelineLagSeconds=68122`.
- Jangar typed quant health for `TORGHUT_SIM` returned `status=degraded`, `latestMetricsCount=0`, and no latest metric
  timestamp.
- Jangar market-context health for `AAPL` was `overallState=down`; ClickHouse ingestion reported
  `CH_HOST is not configured`; fundamentals and news were not configured; technicals and regime were in error.
- Jangar quant alerts returned `50` open alerts, with `37` critical and `13` warning.
- Torghut `/trading/autonomy` reported stale empirical jobs `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward` for candidate `intraday_tsmom_v1@prod` and dataset
  `torghut-full-day-20260318-884bec35`.

### Source Evidence

- `services/torghut/app/main.py` assembles readiness, trading health, DB checks, empirical jobs, quant evidence,
  autonomy, decisions, and executions in one high-risk `4051` line route surface.
- `services/torghut/app/trading/submission_council.py` builds live submission gates from dependency quorum, empirical
  readiness, DSPy runtime, toggle parity, quant health, and market context, but it does not issue a durable activation
  receipt.
- `services/torghut/app/trading/empirical_jobs.py` already validates job freshness, truthfulness, lineage, candidate
  ids, and dataset snapshots. It is the right source for empirical repair receipts.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` exposes typed account/window quant
  freshness and correctly distinguishes live account freshness from empty sim latest metrics.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/alerts.ts` exposes open alert state that should
  become a capital activation input.
- Existing tests cover empirical job freshness, submission gates, quant health, market context, autonomy evidence, and
  trading API behavior. Missing tests prove the full activation tuple and repair ranking across those surfaces.

## Problem

Torghut has truthful local gates, but no single capital activation record.

Right now a human has to read:

1. live readiness,
2. sim readiness,
3. database schema checks,
4. empirical job age,
5. typed quant freshness,
6. market-context health,
7. open quant alerts,
8. live submission toggles,
9. Jangar action budgets,
10. controller witness state.

That is too much interpretation during a market window. The system should emit a receipt that says: this account,
strategy, window, hypothesis, and market session are allowed only for observe, shadow repair, paper canary, live
micro-canary, or live scale, with max notional and required repairs attached.

The profitability problem is similar. Not every repair has equal expected value. Replaying stale empirical jobs,
backfilling empty sim metrics, restoring market context, and wiring live quant health all reduce risk, but the order
should be tied to expected alpha unlock and capital-readmission value.

## Alternatives Considered

### Option A: Patch Toggles And Endpoint URLs First

Pros:

- Fast way to improve live `/readyz` and quant route visibility.
- Directly addresses obvious disabled or missing configuration.
- Low code risk.

Cons:

- Does not prove the next paper or live candidate has fresh empirical, quant, market-context, and controller witness
  evidence.
- Can turn a configuration fix into premature capital activation.
- Does not rank repairs by profit value.

Decision: reject as the architecture. Keep endpoint/toggle fixes as repair queue items.

### Option B: Keep The Existing Live Submission Gate As Final Authority

Pros:

- Already blocks live capital today.
- Already includes empirical jobs, quant evidence, market context, and dependency quorum.
- Well covered by existing tests.

Cons:

- It is live-focused and does not define observe, shadow repair, or paper canary receipts.
- It does not persist or expose a durable activation tuple for deployers and Jangar.
- It does not give the repair scheduler a measurable profit objective.

Decision: reject as the next architecture. Keep it as an input to the activation receipt.

### Option C: Capital Activation Receipts With A Shadow Profit Proof Queue

Pros:

- Makes capital stage, scope, evidence refs, max notional, and rollback target explicit.
- Allows zero-notional repair even when paper and live capital are blocked.
- Ranks proof repairs by expected profit unlock and risk reduction.
- Gives Jangar one Torghut-owned receipt to consume for paper and live decisions.
- Prevents sim success from masking empty sim quant metrics or stale empirical proof.

Cons:

- Requires another projection and route payload.
- Requires each repair to publish closure receipts, not just logs.
- Slows paper activation until the proof tuple is current.

Decision: select Option C.

## Architecture

Torghut adds two projections and one tuple.

```text
torghut_capital_activation_receipt
  receipt_id
  generated_at
  expires_at
  account
  strategy_id
  hypothesis_id
  window
  market_session
  requested_stage                # observe, shadow_repair, paper_canary, live_micro_canary, live_scale
  approved_stage
  decision                       # allow, observe_only, repair_only, hold, block
  max_notional
  jangar_activation_receipt_ref
  empirical_job_refs
  quant_health_ref
  market_context_ref
  quant_alert_refs
  broker_ref
  tca_ref
  expected_profit_hypothesis_ref
  required_repairs
  rollback_target
```

```text
shadow_profit_proof_queue
  queue_id
  generated_at
  repair_items
    repair_id
    repair_class                 # empirical_replay, sim_quant_backfill, market_context_restore,
                                 # live_quant_wiring, alert_retirement, broker_reconciliation
    account
    strategy_id
    hypothesis_id
    expected_alpha_unlock        # none, low, medium, high, critical
    risk_reduction
    max_runtime_minutes
    max_query_budget
    max_notional                 # always 0 in shadow repair
    closure_receipt_schema
```

```text
profit_activation_tuple
  account
  strategy_id
  hypothesis_id
  window
  market_session
  empirical_fresh
  quant_latest_non_empty
  market_context_current
  critical_alerts_open
  broker_reconciled
  tca_current
  paper_closure_current
```

Stage rules:

- `observe` is allowed when service routes and DB projections are available.
- `shadow_repair` is allowed with max notional `0` when a repair can close a named activation gap.
- `paper_canary` requires fresh empirical jobs, non-empty sim quant latest metrics, market-context current for the
  hypothesis universe, no unresolved critical alert for the account/window, and a Jangar activation receipt.
- `live_micro_canary` requires paper closure, live readiness HTTP `200`, live trading health HTTP `200`, live quant
  health configured and fresh, broker reconciliation, TCA evidence, and explicit rollout window.
- `live_scale` requires multiple live micro-canary sessions and remains out of scope for the first implementation.

## Profit Hypotheses And Guardrails

- Hypothesis 1: replaying stale empirical jobs for `intraday_tsmom_v1@prod` will unlock paper canary evaluation faster
  than changing live toggles. Success means all four empirical jobs are fresh and truthfully linked to the current
  dataset snapshot.
- Hypothesis 2: restoring market-context ingestion will reduce LLM and autonomy blocks for the active universe. Success
  means the route moves from `down` to at least `degraded_last_good` for the traded symbols, with explicit risk flags.
- Hypothesis 3: backfilling sim quant latest metrics will reduce false paper confidence. Success means
  `TORGHUT_SIM` has non-empty 15-minute latest metrics and stage evidence before paper canary.
- Hypothesis 4: wiring live quant health is valuable only after paper proof is current. Success means live quant health
  is configured, fresh, account-scoped, and still max notional `0` until paper closure.
- Guardrail: no queue item can raise `max_notional` above `0`; only an activation receipt can do that.

## Implementation Scope

Torghut engineer scope:

- Add a pure activation receipt builder that consumes existing readiness, trading health, empirical jobs, quant health,
  market context, open alerts, broker state, and Jangar activation receipts.
- Expose the current receipt in `/readyz`, `/trading/health`, and `/trading/status`.
- Add a shadow profit proof queue route or payload section that ranks zero-notional repairs.
- Teach empirical replay, sim quant backfill, market-context restore, and alert retirement jobs to emit closure
  receipts.
- Add tests for disabled empirical jobs, stale empirical jobs, empty sim quant latest metrics, live quant not
  configured, market-context down, open critical alerts, and simple submit disabled.

Jangar engineer scope:

- Consume Torghut activation receipts as the Torghut-owned input to Jangar action SLO budgets and settlement.
- Keep Jangar's failure-domain `torghut_capital` allowance from overriding a Torghut receipt with `hold` or `block`.
- Surface Torghut repair queue top item and max notional in Jangar status.

Deployer scope:

- Before paper canary, cite the Torghut activation receipt id and show max notional.
- Before live micro-canary, cite the paper closure receipt, broker/TCA evidence, and Jangar activation receipt.
- Treat a missing or expired receipt as `hold`, not as permission to infer from pod health.

## Validation Gates

Engineer acceptance:

- Unit tests prove `simple_submit_disabled` blocks live but still allows observe and shadow repair.
- Unit tests prove sim `/readyz=ok` with empty sim quant latest metrics holds paper canary.
- Unit tests prove stale empirical jobs produce `shadow_repair=allow`, `paper_canary=hold`, and `live_micro=block`.
- Unit tests prove market-context `down` blocks paper unless a documented last-good degraded mode applies.
- Integration tests prove Jangar status consumes the Torghut receipt and does not allow `torghut_capital` without it.

Deployer acceptance:

- A deployer can capture the activation receipt id for the active account, strategy, window, hypothesis, and market
  session.
- The receipt shows `max_notional=0` while live `/readyz` is `503`, live submission is disabled, empirical proof is
  stale, sim quant latest metrics are empty, market context is down, or critical alerts are open.
- The shadow profit proof queue has at least one repair item with expected alpha unlock, risk reduction, budget, and
  closure schema.

Profit acceptance:

- Within two market sessions, either open critical quant alerts fall from `37` to `18` or fewer, or every remaining
  critical alert has a closure-debt reason.
- The first paper canary after implementation cites fresh empirical jobs, non-empty sim metrics, market context, and a
  post-cost expected edge.
- Live notional remains `0` until paper PnL, TCA, broker reconciliation, and rollback rehearsal are current.

## Rollout Plan

1. Emit activation receipts in shadow mode from existing route inputs.
2. Add the shadow profit proof queue with empirical replay, sim quant backfill, market-context restore, and live quant
   wiring repair classes.
3. Echo receipt ids in Jangar status and NATS handoff updates.
4. Enforce receipt presence for paper canary after seven healthy shadow receipt epochs.
5. Enforce live micro-canary receipt only after paper closure and broker/TCA evidence.
6. Leave live scale disabled until multiple live micro-canary sessions close.

## Rollback Plan

- Disable activation receipt enforcement and return to existing live submission gates.
- Continue emitting shadow receipts so engineers can compare old and new decisions.
- If the profit proof queue starves urgent repair, fall back to fixed priority: empirical replay, sim quant backfill,
  market-context restore, live quant wiring, alert retirement.
- If a receipt is malformed or stale, hold paper/live capital and allow only observe plus zero-notional repair.

## Risks

- The receipt can duplicate the live submission gate. Mitigation: the gate remains an input; the receipt owns stage,
  scope, max notional, expiry, and rollback target.
- Profit ranking can overfit stale expected alpha. Mitigation: queue items expire at market-session boundaries and
  require closure receipts.
- Paper mode can bypass proof discipline. Mitigation: paper canary requires fresh empirical, sim quant, and
  market-context evidence.
- Jangar can over-trust Torghut receipts. Mitigation: Jangar still applies controller witnesses, transport contracts,
  and settlement before material actions.

## Handoff

Engineer stage should build the activation receipt builder first, then the shadow profit proof queue. Keep all repair
items zero-notional until receipts and closure schemas are stable.

Deployer stage should treat the receipt id, not pod readiness or paper mode alone, as the capital gate. No paper or live
capital should move without the receipt naming max notional, proof refs, required repairs, expiry, and rollback target.
