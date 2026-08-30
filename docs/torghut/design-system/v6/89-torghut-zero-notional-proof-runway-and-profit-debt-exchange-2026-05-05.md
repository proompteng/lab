# 89. Torghut Zero-Notional Proof Runway and Profit-Debt Exchange (2026-05-05)

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

Torghut should add a **Zero-Notional Proof Runway** and **Profit-Debt Exchange** before reopening paper or live capital.
The trading system needs a way to spend market-session time on proof that increases profitability odds without
pretending current evidence is trade-ready. The runway lets hypotheses compete for replay, empirical refresh, TCA
refresh, route repair, and options-readiness work. Broker orders stay blocked until the proof debt required for
`paper_submit` or `live_submit` is closed.

I am choosing this because the current state is a strong "learn, do not trade" signal. Live Torghut serves `/healthz`
with HTTP 200, Postgres and ClickHouse route checks are OK, Alpaca broker status is OK, and the schema route is current
at Alembic head `0029_whitepaper_embedding_dimension_4096`. The same evidence says capital should stay closed:
`/readyz` and `/trading/health` return 503 under `simple_submit_disabled`, capital stage is shadow, promotion eligible
count is zero, empirical job authority is blocked, options catalog `/readyz` is false, and the 72-hour profitability
window has 8 decisions with 0 executions and 0 TCA samples. Torghut sim is healthier at the app layer, but its proof
payload reports `jangar_status_fetch_failed` and `quant_health_fetch_failed`.

The design choice is to make proof work a first-class product. A hypothesis can earn proof runway budget without
earning capital. It must close specific profit debt before the capital stage can move.

## Scope and Success Metrics

Success means:

1. Every active hypothesis has a `profit_debt` inventory with empirical freshness, TCA freshness, route freshness,
   options readiness, platform credit, execution-sample count, and guardrail state.
2. Every selected proof job has `zero_notional=true`, a proof objective, a maximum runtime budget, a source dataset,
   and a falsification condition.
3. The proof runway ranks work by expected information value, opportunity window, risk reduction, and Jangar
   platform-credit availability.
4. No proof job can submit broker orders. Paper submit requires `paper_submit` credit from Jangar plus fresh empirical,
   TCA, quant-health, and replay proof.
5. Live submit remains blocked until a separate operator-approved live-submit credit exists and paper proof has been
   healthy for a configured window.
6. `/trading/health`, `/readyz`, `/trading/status`, `/trading/profitability/runtime`, and Jangar platform-credit
   projections agree on the same hold/repair/allow posture.

## Evidence Snapshot

All assessment was read-only.

### Cluster and Rollout Evidence

- `kubectl get pods -n torghut --sort-by=.status.startTime -o wide` showed 27 Running pods, including live
  `torghut-00219-deployment-5496d7f7dc-qmzhl`, sim `torghut-sim-00300-deployment-7fc94bffc9-hlf5k`, Postgres,
  ClickHouse, Keeper, TA workers, options workers, websocket forwarders, Symphony, and exporters.
- Recent Torghut events showed the live and sim Knative revisions becoming ready, and migration/backfill/bootstrap jobs
  completing.
- The same event stream showed scheduling pressure for backfills, Flink checkpoint and Kafka producer exceptions,
  transient startup/readiness probe failures, and repeated multiple-PDB warnings on ClickHouse pods.
- `torghut-options-catalog /readyz` returned HTTP 503 with `ready=false` and `last_success_ts=null`.
- `torghut-options-enricher /readyz` returned HTTP 200 with `ready=true` and
  `last_success_ts=2026-05-05T18:18:19.677499+00:00`.

Interpretation: the cluster can run proof work, but options and streaming debt still discount the current capital
posture.

### Source and Test Evidence

- `services/torghut/app/main.py` is the high-risk route aggregate for health, readiness, status, profitability,
  empirical jobs, market context, TCA, decisions, executions, and Jangar dependency proof.
- `services/torghut/app/trading/submission_council.py` already parses typed Jangar quant-health, blocks required
  missing quant evidence, exposes capital stages, and separates informational from blocking reasons.
- `services/torghut/app/trading/discovery/promotion_contract.py`,
  `services/torghut/app/trading/evidence_contracts.py`, and empirical job helpers are better first homes for pure
  proof-debt and runway scoring logic than `main.py`.
- Existing tests cover submission council behavior, invalid quant-health URLs, missing required quant evidence, trading
  API gates, empirical promotion truthfulness, profitability runtime, and readiness checks.
- The missing test is route parity: the same proof-debt digest must be visible in status, readiness, profitability, and
  scheduler-selected proof jobs, and it must never authorize notional by itself.

### Database, Schema, and Data Evidence

- Direct CNPG reads and SQL were blocked for this runtime because the service account cannot list CNPG clusters or
  create `pods/exec`.
- Torghut `/db-check` supplied least-privilege route proof: `ok=true`, `schema_current=true`, lineage ready, and known
  historical parent-fork warnings.
- Live `/trading/health` returned HTTP 503 with `live_submission_gate.allowed=false`,
  `reason=simple_submit_disabled`, `capital_stage=shadow`, Postgres OK, ClickHouse OK, Alpaca OK, and universe fresh
  from Jangar.
- Live `/trading/status` reported `mode=live`, `execution_lane=simple`, and live submission blocked.
- `/trading/empirical-jobs` reported 4 completed jobs but `status=degraded` and `authority=blocked`.
- `/trading/profitability/runtime?hours=72` reported `decision_count=8`, `execution_count=0`, and
  `tca_sample_count=0`.
- Sim `/trading/health` returned HTTP 200 but included `jangar_status_fetch_failed` and `quant_health_fetch_failed`,
  which makes it useful for local simulation but not enough for capital authority.

Interpretation: the schema is usable and the app can serve, but profit evidence is stale or absent where it matters.
Torghut needs to buy proof, not spend capital.

## Problem

Torghut has proof debt in several independent places:

1. empirical promotion proof is stale and authority is blocked;
2. the recent runtime has decisions but no executions or TCA samples;
3. options catalog readiness has no successful cycle timestamp;
4. Jangar platform credit is mixed because execution trust and dependency quorum are degraded;
5. quant-health is optional or failing depending on live versus sim context;
6. live submission is intentionally closed by `simple_submit_disabled`;
7. direct database proof is unavailable to the least-privilege worker.

The old answer was either "keep trading off" or "turn on paper to collect samples." Neither is enough. Keeping
everything off wastes the current session and lets proof age further. Turning on paper before proof debt closes uses
orders as diagnostics. The system needs a no-notional proof runway that collects the highest-value evidence first.

## Alternatives Considered

### Option A: Stay Fully Frozen Until All Gates Are Green

Torghut would run no proof jobs except existing background jobs until empirical jobs, options readiness, quant-health,
TCA freshness, and Jangar platform credit are all green.

Pros:

- safest posture for capital;
- easy to explain to operators;
- no chance that replay budget is mistaken for trading budget.

Cons:

- produces no new evidence during market hours;
- cannot falsify weak hypotheses;
- leaves options and empirical debt aging;
- gives Jangar no high-value consumer feedback for proof repair.

Decision: reject as the default. Keep it as an emergency posture if route integrity is unknown.

### Option B: Reopen Paper Micro-Notional

Torghut would use small paper orders to gather current fills and TCA samples.

Pros:

- fastest way to get execution samples;
- exercises broker, sizing, and order routes;
- can reveal live-path issues that replay misses.

Cons:

- current proof says empirical authority is blocked;
- options catalog readiness is false;
- recent runtime has no current execution baseline;
- Jangar platform debt is still open;
- it treats paper capital as instrumentation instead of earned authority.

Decision: reject for the current state. Paper reentry should be earned by proof runway closure.

### Option C: Zero-Notional Proof Runway and Profit-Debt Exchange

Torghut creates profit-debt rows, scores them, and selects zero-notional proof jobs that close the most uncertainty per
unit of session time.

Pros:

- keeps capital closed while still learning;
- makes stale empirical proof and missing TCA explicit;
- lets options and quant-health repair compete with strategy replay;
- gives Jangar a measurable consumer for platform-credit projections;
- defines a clean path from shadow to paper without weakening live guardrails.

Cons:

- adds a new scoring model;
- requires route parity tests across status and health;
- first version should be conservative and may leave some opportunities untested.

Decision: select Option C.

## Chosen Architecture

### ProfitDebt

Torghut records profit debt per hypothesis, route, and proof class:

```text
profit_debt
  debt_id
  hypothesis_id
  proof_class                  # empirical, tca, replay, route, options, platform_credit, quant_health
  evidence_ref
  evidence_age_seconds
  severity                     # low, medium, high, critical
  blocks                       # paper_submit, live_submit, promotion, sizing
  allows                       # replay, analysis, repair
  close_condition
  falsification_condition
  opportunity_window
  guardrail_ref
  observed_at
  fresh_until
```

Examples from the current run:

- empirical proof debt blocks `paper_submit` and `live_submit`;
- 72-hour execution debt blocks TCA and sizing confidence;
- options catalog readiness debt blocks options hypothesis promotion;
- Jangar platform-credit debt blocks non-shadow capital authority;
- quant-health route debt blocks required quant evidence if the next rollout makes it mandatory.

### ZeroNotionalProofJob

The runway schedules jobs that cannot place orders:

```text
zero_notional_proof_job
  job_id
  hypothesis_id
  proof_objective              # replay, empirical_refresh, tca_backfill, route_probe, options_catalog_cycle
  selected_debt
  expected_information_value
  max_runtime_seconds
  dataset_ref
  no_order_assertion
  output_digest
  close_condition
  falsification_condition
```

The `no_order_assertion` must be enforced in code. It is not a comment. Proof jobs can replay, simulate, backfill,
compare, or probe routes. They cannot call the broker submit path.

### Proof Runway Scoring

The first scoring model should be ordinal:

```text
score =
  information_value
  + capital_blocker_weight
  + session_opportunity_weight
  + platform_credit_weight
  - evidence_age_penalty
  - route_debt_penalty
  - runtime_cost_penalty
```

The model should prefer work that:

- closes a capital-blocking reason;
- creates fresh empirical or TCA evidence;
- can finish inside the current market or simulation window;
- has Jangar `repair` credit even when `paper_submit` and `live_submit` are held;
- has a clear falsification condition.

### Capital Credit Ladder

Torghut should not reopen capital by route liveness alone:

1. `shadow`: current state. Zero-notional proof jobs only.
2. `paper_probe`: requires fresh empirical proof, replay proof, TCA route proof, options readiness if options are in
   scope, Jangar `paper_submit=allow`, and no critical profit debt.
3. `paper_canary`: requires successful `paper_probe`, bounded drawdown, slippage budget, and route parity.
4. `live_canary`: requires operator approval, fresh paper proof, Jangar `live_submit=allow`, broker guardrails, and
   rollback switch.
5. `live`: outside this plan lane. Requires a separate go decision.

## Implementation Scope

Phase 0, shadow:

1. Add pure `ProfitDebt` builders from existing empirical jobs, TCA, profitability runtime, options readiness,
   quant-health, and Jangar platform-credit payloads.
2. Add `ZeroNotionalProofJob` selection without scheduling side effects.
3. Project proof debt and selected jobs in `/trading/status`, `/trading/health`, and
   `/trading/profitability/runtime`.
4. Add tests that proof jobs cannot set paper or live submit allowed.

Phase 1, proof execution:

1. Enable replay and empirical-refresh jobs for one hypothesis.
2. Require output digests, close conditions, and falsification conditions.
3. Feed close results back into profit debt.

Phase 2, paper eligibility:

1. Request Jangar `paper_submit` credit after profit debt closes for the selected lane.
2. Keep `simple_submit_disabled` until paper eligibility is earned and explicitly approved.
3. Add deployer rollback checks for re-closing paper if profit debt reappears.

## Validation Gates

Engineer gates:

- Unit tests prove empirical stale authority creates high-severity profit debt.
- Unit tests prove a 72-hour window with decisions but no executions creates execution-sample debt.
- Unit tests prove options catalog `ready=false` creates route debt.
- Unit tests prove Jangar `paper_submit=hold` or missing platform credit blocks paper eligibility.
- Route tests prove `/trading/status`, `/trading/health`, and `/trading/profitability/runtime` expose the same
  profit-debt digest.
- Tests prove `ZeroNotionalProofJob` cannot call broker submit, even when selected.

Deployer gates:

- Live `/healthz` may be 200 while `/readyz` and `/trading/health` remain 503 under capital hold.
- `simple_submit_disabled` remains the live-submit rollback switch until paper eligibility is explicitly approved.
- Options catalog `/readyz` must report `ready=true` with a fresh `last_success_ts` before options proof can promote.
- A 72-hour runtime window must show fresh replay or execution proof before any paper credit request.
- Jangar platform-credit route must report `paper_submit=allow` before Torghut paper submit can be enabled.

## Rollout

1. Ship proof-debt builders and route projections in shadow.
2. Run selected zero-notional proof jobs for one hypothesis during at least one market session.
3. Require a written proof closeout before requesting Jangar paper-submit credit.
4. Enable paper probe only after deployer confirms route parity and rollback switch.
5. Keep live submit blocked for this plan lane.

## Rollback

- Disable proof runway selection and keep route projections read-only.
- Clear scheduled zero-notional proof jobs without deleting debt history.
- Keep `simple_submit_disabled=true`.
- Revert the implementation PR if proof projections break `/trading/health`, `/readyz`, or `/trading/status`.
- If paper is later enabled and debt reappears, turn the paper-submit credit back to hold and revert the paper toggle.

## Risks

- The scoring model can overfit stale data. Start ordinal, not predictive.
- A proof job can be mistaken for trading work. Enforce `no_order_assertion` in code and tests.
- Route parity can drift if status and health build debt independently. Use pure builders and shared digests.
- Options readiness can block too much if modeled globally. Scope options debt to options hypotheses unless the route
  affects shared infrastructure.
- Platform-credit failures can hide profit opportunities. That is acceptable; capital should wait, but zero-notional
  proof work should continue under repair credit.

## Handoff

Engineer:

- add pure proof-debt builders first;
- keep broker submit unreachable from zero-notional proof jobs;
- make route digests deterministic;
- use existing empirical, TCA, profitability, and submission-council tests as the regression base.

Deployer:

- keep live and paper capital closed while proof runway is shadowed;
- validate route parity before enabling any proof job scheduler;
- require Jangar paper-submit credit and fresh profit proof before changing submit toggles;
- treat live submit as explicitly out of scope for this design PR.
