# 86. Torghut Profit Repair Auction and Proof Runway Consumer (2026-05-05)

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

Torghut should consume Jangar `ConsumerAuthorityResult` decisions and allocate recovery work through a
`ProfitRepairAuction`. Capital stays in shadow when proof is stale, but learning does not stop. Every blocked or
rejected trading decision becomes opportunity-cost evidence, and the next repair budget goes to the hypothesis with
the best combination of expected post-cost edge, proof gap, data freshness debt, and executable guardrails.

I am choosing this over either restarting paper trading from route health or waiting passively for all empirical jobs to
recover. The current Torghut state is live but not profit-ready: schema is current, the service is running, and the
scheduler loop is active, but live submission is disabled, all three hypotheses are capped at shadow, zero hypotheses
are promotion eligible, empirical jobs are stale, signal continuity is alerting, and runtime profitability has decisions
but no executions or TCA samples in the last 72 hours.

The tradeoff is that the auction makes recovery explicit and sometimes slower than flipping a submit flag. That is the
right tradeoff. Torghut needs profitable evidence, not just activity.

## Evidence Captured

All checks were read-only.

### Cluster and Rollout Evidence

- `kubectl get pods -n torghut -o wide` showed Torghut live revision `torghut-00217`, Torghut sim, Postgres,
  ClickHouse, Keeper, TA workers, options services, websocket forwarders, and exporters running.
- Recent agents namespace events still showed preemption, scheduling backpressure, image pull failures, and readiness
  timeouts around Jangar and Torghut swarm work. Torghut should not treat control-plane route liveness as capital
  authority.
- The agents service account cannot exec into `torghut-db-1`, so capital proof must come from application routes and
  persisted evidence, not an operator shell.

### Database and Data Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, lineage ready, and no missing or unexpected heads.
- `/trading/status` reported `mode=live`, `execution_lane=simple`, active revision `torghut-00217`,
  `kill_switch_enabled=false`, and `live_submission_gate.allowed=false` because `simple_submit_disabled`.
- The same status reported three hypotheses: two shadow, one blocked, all capped at shadow, zero promotion eligible,
  and three rollback required.
- Signal continuity was alerting on `no_signals_in_window`; universe came from a Jangar cache hit with roughly
  295-second age during the sample.
- Empirical jobs were all stale under the 86400-second freshness budget: `benchmark_parity`,
  `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`. The artifacts are truthful historical proof,
  not current capital authority.
- Runtime profitability over 72 hours reported 8 decisions, 0 executions, 0 TCA samples, and no realized PnL sample.
- TCA summary data exists historically, but the sampled status still carried last computed time
  `2026-04-02T20:59:45.136640Z` and average absolute slippage near 568 bps, far outside live-widening tolerance.

### Source Architecture and Test Gaps

- `services/torghut/app/trading/submission_council.py` is the right proof-aware capital gate, but the live sampled
  path is still the simple lane with submit disabled.
- `services/torghut/app/trading/hypotheses.py` already computes hypothesis state, promotion eligibility, dependency
  quorum, rollback requirements, and capital stage caps.
- `services/torghut/app/trading/profitability_archive.py`, empirical job routes, and runtime profitability routes
  already expose enough evidence to build repair bids.
- The missing acceptance shape is cross-route parity: `/trading/status`, `/trading/empirical-jobs`,
  `/trading/profitability/runtime`, the scheduler, and broker-bound submission must all consume the same Jangar runway
  decision and the same proof freshness budget.

## Problem

Torghut is not down. It is unprofitable-by-authority: the system can run, but it cannot justify paper or live capital
from fresh evidence. If we simply restart submission, we convert liveness into capital. If we wait for batch proof
without recording blocked decisions, we waste market sessions and learn nothing from the current runtime.

The system needs a recovery mechanism that:

1. keeps broker capital shadowed until proof is fresh;
2. turns rejected or disabled decisions into measurable opportunity-cost evidence;
3. ranks repair work by expected profitability impact;
4. requires Jangar action-class authorization before paper or live widening;
5. distinguishes historical truthful proof from current executable proof.

## Alternatives Considered

### Option A: Resume Paper on Route and Schema Health

Allow paper submissions when `/healthz` and `/db-check` are green and the scheduler is running.

Pros:

- fastest way to generate new fills and TCA samples;
- simple operational toggle;
- may expose broker and execution issues quickly.

Cons:

- ignores stale empirical jobs and signal continuity alerts;
- turns route liveness into capital authority;
- creates fills that are not tied to Jangar runway proof;
- can mask the fact that all hypotheses currently require rollback or shadow.

Decision: reject. Route health is necessary, not sufficient.

### Option B: Freeze Until Every Proof Job Is Fresh

Keep all hypotheses in shadow and perform no new decision/replay work until empirical jobs and quant proof are fresh.

Pros:

- safest capital posture;
- prevents stale proof misuse;
- easy to audit.

Cons:

- wastes live market sessions;
- records no opportunity-cost signal from disabled decisions;
- delays strategy improvement;
- does not prioritize which stale proof to repair first.

Decision: reject. Freezing capital is correct; freezing learning is not.

### Option C: Profit Repair Auction with Proof Runway Consumer

Keep capital shadowed unless Jangar and Torghut proof are fresh, but auction repair effort toward the hypothesis with
the highest expected post-cost improvement and most actionable proof gap.

Pros:

- keeps learning active without risking capital;
- produces measurable repair work instead of generic "make proof fresh" tasks;
- aligns Torghut capital with Jangar action classes;
- treats stale empirical artifacts as priors, not authority;
- creates a controlled path back to paper and live execution.

Cons:

- needs a new repair-bid object and route parity tests;
- opportunity-cost replay is not a substitute for live fills;
- requires strict separation between counterfactual, paper, and live proof.

Decision: select Option C.

## Chosen Architecture

### JangarRunwayConsumer

Torghut consumes Jangar authority as a required input for capital decisions:

```text
jangar_runway_consumer
  account
  window
  release_digest
  runway_id
  decision_digest
  paper_submit_decision
  live_submit_decision
  dispatch_decision
  observed_at
  fresh_until
  blocked_reasons
  evidence_refs
```

Missing, expired, wrong-account, wrong-window, or wrong-release Jangar authority holds paper and blocks live capital.
Shadow decision recording and replay remain allowed while the runway is held.

### ProfitRepairAuction

Torghut creates a repair auction each control-plane cycle:

```text
profit_repair_auction
  auction_id
  account
  window
  release_digest
  generated_at
  jangar_runway_id
  bids:
    hypothesis_id
    strategy_family
    current_state
    capital_stage_ceiling
    proof_gap
    expected_post_cost_edge_bps
    opportunity_cost_proxy
    data_freshness_debt_seconds
    execution_sample_gap
    tca_sample_gap
    repair_action
    guardrail_failures
    bid_score
  winner
  no_capital_reason
```

Bid score is not a profit guarantee. It is a prioritization rule for repair work. Paper or live capital still requires
fresh proof and Jangar authorization.

### Measurable Hypotheses

The initial repair auction should rank these hypotheses:

- `H-CONT-01` continuation repair: restore signal continuity and empirical proof for continuation strategies.
  Success means no active signal-continuity alert for two cycles, empirical jobs fresh within 24 hours, at least 40
  paper executions, average absolute slippage under 12 bps, and post-cost expectancy above 6 bps before live canary.
- `H-REV-01` event reversion repair: refresh market-context proof and news/fundamental freshness for event reversion.
  Success means required market-context domains inside the hypothesis freshness budget, no stale Jangar dependency
  quorum, at least 30 paper executions, and post-cost expectancy above 8 bps before live canary.
- `H-MICRO-01` microstructure breakout repair: unblock feature coverage and drift governance for order-book and
  liquidity features. Success means feature rows present, drift checks passing, at least 60 paper executions, average
  absolute slippage under 8 bps, and post-cost expectancy above 10 bps before live canary.
- Baseline `intraday_tsmom_v1@prod` proof refresh: rerun the stale empirical proof jobs and use their outputs as a
  current benchmark prior. Success means all four empirical jobs fresh, truthful, and promotion-authority eligible for
  the current dataset snapshot.

### Capital Rules

- `shadow`: allowed when service and schema are healthy enough to record decisions or replay.
- `repair`: required when empirical jobs are stale, signal continuity is alerting, execution/TCA samples are missing,
  or Jangar authority is held.
- `paper_warmup`: requires Jangar `paper_submit=allow`, fresh empirical jobs, no active rollback requirement for the
  selected hypothesis, and a bounded single-hypothesis warmup cap.
- `live_canary`: requires Jangar `live_submit=allow`, nonzero paper executions and TCA samples in the current proof
  window, slippage and expectancy inside the hypothesis contract, and kill-switch rollback dry-run evidence.
- `scaled_live`: requires a clean live canary window, no stale proof classes, and explicit operator approval.

For the May 5 sampled state, the correct result is `capital_stage_ceiling=shadow`, `no_capital_reason` including
`simple_submit_disabled`, `empirical_jobs_stale`, `signal_continuity_alert_active`, `no_runtime_execution_samples`, and
`no_tca_samples_current_window`.

## Engineer Scope

Implement in this order:

1. Add a Torghut parser for Jangar `ConsumerAuthorityResult`, scoped by account, window, release digest, and action
   class.
2. Add pure `ProfitRepairAuction` scoring using existing hypothesis, empirical job, runtime profitability, signal
   continuity, and TCA summaries.
3. Expose the current auction in `/trading/status` and a dedicated route.
4. Make the broker-bound submission council require the Jangar runway for paper and live action classes.
5. Record blocked decisions into replay/opportunity-cost evidence before discarding them.
6. Add cross-route tests proving status, empirical jobs, runtime profitability, scheduler, and submission council agree
   on the same capital ceiling.

## Validation Gates

- Unit: missing Jangar runway keeps `shadow` recording allowed and blocks paper/live capital.
- Unit: stale empirical jobs produce repair bids but cannot authorize paper or live capital.
- Unit: 8 decisions, 0 executions, and 0 TCA samples in the 72-hour window produce `capital_stage_ceiling=shadow`.
- Unit: signal-continuity alert blocks `H-CONT-01` widening even when schema is healthy.
- Contract: submission council, `/trading/status`, and `/trading/profitability/runtime` expose the same Jangar runway
  digest and capital ceiling.
- Integration: a fake fresh Jangar runway plus fresh empirical jobs allows only one bounded paper warmup winner; live
  remains blocked until paper execution and TCA samples exist.
- Manual validation: no route or deployer workflow requires database pod exec to prove capital state.

## Rollout Plan

1. Shadow mode: compute repair auctions and Jangar consumer decisions without changing submission behavior.
2. Read authority: surface auction winner, no-capital reason, and Jangar runway id in Torghut status.
3. Paper fuse: require Jangar `paper_submit=allow` and fresh proof before enabling one bounded paper warmup.
4. Live fuse: require Jangar `live_submit=allow`, current paper/TCA proof, and rollback dry-run evidence.
5. Scaled live: widen only after a clean canary window and explicit operator approval.

## Rollback Plan

- Disable Jangar consumer enforcement and keep auction emission.
- Force all hypotheses to `shadow` if the Jangar runway route is unavailable or stale.
- Disable paper warmup without deleting blocked-decision replay evidence.
- Keep kill switch, strategy disable, and GitOps rollback dry-run evidence as mandatory for any future live canary.

Rollback is complete only when Torghut still records repair bids and blocked-decision evidence while broker capital is
shadowed.

## Risks and Open Questions

- Opportunity-cost replay can overstate edge if feature snapshots are incomplete. Mark it counterfactual until paper
  execution confirms fill quality.
- Auction scoring can over-prioritize easy repairs. Keep hard capital gates separate from bid score.
- Jangar account/window mismatch must fail closed.
- Stale historical empirical jobs are useful priors but must never clear current capital gates alone.
- Paper warmup needs explicit notional, symbol, and duration caps before any live canary.

## Handoff

Engineer acceptance gate: the May 5 fixture must select a repair state, not a capital state. The expected output is a
repair auction with shadow-only capital, stale empirical proof, no runtime execution/TCA samples, and a Jangar runway
hold for paper/live.

Deployer acceptance gate: Torghut does not leave shadow because the service is healthy. It leaves shadow only when the
Jangar runway action class, empirical jobs, runtime profitability, signal continuity, TCA, and rollback dry-run proof
are all fresh for the same account, window, hypothesis, and release digest.
