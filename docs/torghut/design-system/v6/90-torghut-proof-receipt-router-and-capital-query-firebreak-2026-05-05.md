# 90. Torghut Proof Receipt Router and Capital Query Firebreak (2026-05-05)

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

Torghut should add a **Proof Receipt Router** and a **Capital Query Firebreak**. The zero-notional proof runway decides
what the system should learn. This cut decides how proof is produced safely: expensive database and route reads happen
behind bounded receipt producers, while capital gates consume the latest unexpired receipt instead of compiling proof
on request.

I am choosing this because the current runtime is economically useful but not capital-ready. The live Torghut pod set
is running on revision `torghut-00220`, `/trading/status` returned HTTP 200 in 2.919s, and the 72-hour runtime
profitability route returned HTTP 200 in 4.323s. Those routes show the right capital posture: shadow stage, live submit
blocked by `simple_submit_disabled`, three hypotheses with capital multipliers at zero, dependency quorum blocked by
`empirical_jobs_degraded`, options catalog not ready, and a 72-hour window with 8 decisions, 0 executions, and 0 TCA
samples.

The same assessment shows why request-time proof is unsafe. `/db-check` timed out after 15 seconds with no body.
`/readyz` timed out after 15 seconds. `/trading/health` returned HTTP 503 after 6.625s. Recent Torghut warning events
include startup/readiness probe churn for revisions `00220` and `00301`, Flink job exceptions, repeated multiple-PDB
warnings on ClickHouse pods, and options catalog/enricher readiness failures. Options catalog `/readyz` returned HTTP
503 with `last_success_ts=null`, while the older options enricher route was ready.

The design decision is to route proof work through receipts. A hypothesis may receive zero-notional proof budget while
capital stays closed. Paper or live capital may only move when the receipt router has fresh Jangar platform credit,
fresh Torghut profit proof, fresh route proof, and a query firebreak state that is within budget.

## Success Metrics

1. `/readyz`, `/db-check`, `/trading/health`, `/trading/status`, and `/trading/profitability/runtime` expose proof
   receipt references rather than each performing deep proof scans independently.
2. A `capital_query_firebreak` opens when DB proof routes time out, options readiness has no successful cycle, Flink
   proof jobs are failing, or a Jangar platform receipt is held.
3. Zero-notional proof jobs remain allowed under firebreak when their producer budget is within limits and they cannot
   submit broker orders.
4. `paper_submit` requires unexpired receipts for empirical proof, replay proof, route proof, TCA proof where
   applicable, options readiness for options lanes, Jangar platform credit, and rollback readiness.
5. `live_submit` requires a separate live receipt after paper proof has been healthy for the configured window.
6. Receipt state is lane, hypothesis, account, and window scoped; a stale event-reversion receipt cannot block a
   continuation replay unless shared infrastructure is implicated.
7. Profitability hypotheses measure expected information value, not just historical PnL: stale proof must generate
   a prioritized receipt request with a falsification condition.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster, Rollout, and Events

- `kubectl get pods -n torghut -o wide` showed 27 pods, all in Running phase. Live `torghut-00220` and sim
  `torghut-sim-00301` were `2/2 Running`.
- `torghut-db-migrations-vnd27` was still Running during the sample, so schema and route proof were in-flight rather
  than fully settled from the worker perspective.
- `torghut-options-catalog-5645fd65b-n4g8q` had a fresh pod but options catalog `/readyz` still returned
  `ready=false`.
- `torghut-options-enricher-55c7df4477-c7qf4` was not yet ready while the older enricher pod remained ready. That is
  rollout churn, not proof completion.
- Warning events included startup/readiness failures for Torghut live and sim revisions, websocket readiness HTTP 503,
  Flink `JobException`, Flink options-TA recovery suppression, ClickHouse multiple-PDB ambiguity, and options
  catalog/enricher probe failures.
- No failed pods were currently present in the Torghut namespace, so the failure is proof readiness and route budget,
  not a namespace-wide crash.

### Route, Database, and Data Evidence

- `GET http://torghut.torghut/db-check` timed out after 15 seconds with HTTP 000.
- `GET http://torghut.torghut/readyz` timed out after 15 seconds with HTTP 000.
- `GET http://torghut.torghut/trading/health` returned HTTP 503 in 6.625s. Postgres, ClickHouse, Alpaca, and Jangar
  universe were OK, but `live_submission_gate.ok=false`, `capital_stage=shadow`, and `simple_submit_disabled`.
- `GET http://torghut.torghut/trading/status` returned HTTP 200 in 2.919s. It reported active revision
  `torghut-00220`, shadow capital stage for all three hypotheses, three rollback-required hypotheses, zero promotion
  eligible hypotheses, and dependency quorum blocked on `empirical_jobs_degraded`.
- The same status payload reported `tca.order_count=13775`, but `last_computed_at=2026-04-02T20:59:45.136640Z` and
  extreme average absolute slippage, so TCA volume is not current capital proof.
- `GET /trading/profitability/runtime?hours=72` returned HTTP 200 in 4.323s with 8 decisions, 0 executions, and
  0 TCA samples.
- `torghut-options-catalog /readyz` returned HTTP 503 with `last_success_ts=null`. `torghut-options-enricher /readyz`
  returned HTTP 200 with `last_success_ts=2026-05-05T18:58:31.729949+00:00`.

### Source Architecture and Test Surface

- `services/torghut/app/main.py` is the high-risk route aggregate. It owns health, readiness, trading status,
  profitability, empirical jobs, market context, TCA, decisions, executions, and Jangar dependency proof routes.
- `services/torghut/app/trading/submission_council.py` already separates capital stages, Jangar quant health, live
  submission gate state, and blocking versus informational reasons. It is the right consumer for receipt state.
- `services/torghut/app/trading/hypotheses.py` already pulls Jangar control-plane status and converts dependency
  quorum into hypothesis reasons such as `jangar_dependency_block`, `market_context_stale`, and
  `signal_lag_exceeded`.
- `services/jangar/src/server/torghut-quant-runtime.ts` and metrics helpers materialize Torghut proof into Jangar
  routes. Those consumers need a bounded proof receipt, not a fresh deep read under request pressure.
- Existing tests cover submission gates, trading route payloads, empirical truthfulness, and profitability runtime
  shape. The missing test class is receipt parity: every route that reports capital posture must cite the same receipt
  digest and must not promote capital on a timed-out receipt producer.

## Problem

Torghut cannot use capital as a diagnostic tool. It also cannot get profitable by freezing every proof producer when a
route is slow. The current state needs a middle path:

1. run proof work that is safe and zero-notional;
2. stop request handlers from doing unbounded proof scans;
3. tell Jangar exactly which platform receipt and Torghut profit receipt block capital;
4. distinguish lane-local proof debt from shared infrastructure firebreaks;
5. preserve a clean operator story when `/healthz` is up but `/readyz` or `/db-check` times out.

That is a routing problem as much as a trading problem. Proof producers need budgets, receipts, and capital semantics.

## Alternatives Considered

### Option A: Tune Torghut Pools and Keep Current Proof Routes

Raise SQLAlchemy and route timeouts, add more DB connections, and leave routes as the main proof compiler.

Pros:

- quick operational improvement;
- low schema cost;
- likely reduces some readiness timeouts.

Cons:

- repeats the same expensive pattern at larger scale;
- increases blast radius on Postgres and ClickHouse;
- does not produce a Jangar-consumable receipt;
- can hide stale empirical or TCA proof behind a successful route.

Decision: reject as the architecture. Use only for emergency relief.

### Option B: Block All Proof Work Until Readiness Is Green

Hold every empirical, replay, options, and capital-related job until `/readyz`, `/db-check`, options, and Jangar
platform proof are green.

Pros:

- conservative;
- easy to enforce;
- protects DB and broker paths during incidents.

Cons:

- wastes market-session information;
- cannot repair stale empirical or options proof;
- gives no lane-local ranking;
- turns a route timeout into broad research downtime.

Decision: reject as default. Keep as emergency posture when route integrity is unknown.

### Option C: Proof Receipt Router and Capital Query Firebreak

Route proof requests to bounded producers, persist receipts, and let capital gates consume receipt state rather than
performing deep request-time reads.

Pros:

- keeps safe proof work moving while capital is closed;
- turns DB/route pressure into a first-class firebreak;
- makes profitability proof lane-local and auditable;
- gives Jangar a compact platform-capital interface;
- supports measurable hypotheses and falsification.

Cons:

- adds receipt lifecycle and stale-receipt handling;
- requires parity work across status, health, readiness, scheduler, and submission council;
- initial enforcement may hold capital more often until receipts are fresh.

Decision: select Option C.

## Chosen Architecture

### ProfitProofReceipt

Torghut emits one receipt per lane, hypothesis, account, window, and producer:

```text
profit_proof_receipt
  receipt_id
  receipt_digest
  hypothesis_id
  lane_id
  strategy_family
  account
  window_id
  producer                 # empirical, replay, tca, route, options, platform_credit, quant_health
  source_dataset_ref
  jangar_platform_receipt_digest
  query_budget_id
  budget_status            # within_budget, over_budget, timed_out, unavailable
  decision                 # allow_observe, allow_replay, allow_paper, allow_live, hold, block
  reason_codes
  observed_at
  fresh_until
  falsification_condition
  artifact_refs
```

Receipts are not orders. Receipts can allow replay, analysis, or paper only when their producer and capital semantics
say so.

### ProofReceiptRouter

The router ranks proof work by expected information value:

- capital unlock probability;
- freshness debt severity;
- market-session opportunity window;
- query cost and DB pressure;
- shared-infrastructure blast radius;
- falsification value for the hypothesis.

The first router outputs should be:

- `H-CONT-01`: continuation replay and signal-lag proof, no notional;
- `H-MICRO-01`: feature-coverage and drift-governance proof, no notional;
- `H-REV-01`: market-context freshness and event-reversion replay, no notional;
- options lanes: options catalog readiness proof before any options promotion;
- platform credit: consume Jangar receipt before paper/live decisions.

### CapitalQueryFirebreak

The firebreak is a capital gate, not a serving gate:

```text
capital_query_firebreak
  firebreak_id
  scope                    # lane, hypothesis, account, global
  opened_by_receipt
  opened_reason
  affected_actions         # paper_submit, live_submit, promotion, sizing
  allowed_actions          # observe, replay, repair
  opened_at
  fresh_until
  close_condition
  rollback_switch
```

Rules:

- `/healthz` can remain healthy while capital firebreak is open.
- `/readyz` must report the active firebreak and the stale or missing receipts.
- `paper_submit` and `live_submit` fail closed on missing, stale, timed-out, or over-budget receipts.
- Zero-notional jobs may continue when their producer budget is within limits and broker submit is impossible by
  construction.

## Implementation Scope

Engineer stage:

1. Add pure receipt and firebreak builders in Torghut trading control-plane code.
2. Add route projection fields to `/trading/status`, `/trading/health`, `/readyz`, and runtime profitability.
3. Move DB-heavy proof scans behind bounded producers or cached latest receipt reads.
4. Add submission-council checks that require receipt digests for paper/live gates.
5. Add zero-notional proof job payload validation that makes broker submit impossible.
6. Add Jangar receipt consumption fields for platform credit.

Deployer stage:

1. Observe receipt projection with no behavior change.
2. Enforce firebreak for paper/live capital first.
3. Enforce proof-router budgets for DB-heavy producers after route parity is green.
4. Keep emergency switch to close all proof work if DB pool pressure persists.

## Validation Gates

- Unit tests prove timed-out `/db-check`, stale empirical proof, stale TCA, options readiness false, and Jangar
  platform hold all produce `hold` or `block` receipts.
- Route tests prove `/trading/status`, `/trading/health`, `/readyz`, and runtime profitability cite the same receipt
  digest for the same hypothesis/window.
- Submission-council tests prove `paper_submit` and `live_submit` cannot proceed without fresh receipts.
- Zero-notional tests prove proof jobs cannot call broker submit and cannot set nonzero notional.
- Deployer validation requires one market-session observe window with no DB route timeouts before paper canary.

## Rollout

1. **Shadow receipts:** emit receipts and firebreaks without changing broker behavior.
2. **Route parity:** make all capital posture routes cite the same receipt digest.
3. **Paper hold enforcement:** require fresh receipts before paper canary.
4. **Proof router enforcement:** schedule zero-notional proof jobs from receipt debt and query budgets.
5. **Live enforcement:** require paper history, TCA, rollback dry-run, and operator approval receipts before live.

## Rollback

- Disable receipt enforcement and keep receipt projection for diagnosis.
- If route timeouts continue, force `capital_query_firebreak=global` and allow only observe/repair.
- If the receipt router misranks work, pin proof jobs manually by lane while preserving zero-notional constraints.
- If Jangar platform receipt consumption fails, hold Torghut capital and keep local replay/analysis open.

## Risks

- A receipt router can optimize for easy proof instead of valuable proof; scoring must include expected information
  value and capital unlock probability.
- Stale TCA volume can look impressive while current execution samples are absent; freshness must be explicit.
- Options readiness can block only options promotion unless shared infrastructure is implicated.
- Route parity work can lag producers; do not enforce capital off a route that cannot cite the active receipt digest.

## Handoff

Engineer acceptance gate: every paper/live capital decision must cite a fresh `profit_proof_receipt` and a Jangar
platform receipt, while zero-notional proof jobs remain broker-submit impossible.

Deployer acceptance gate: Torghut remains shadow while `/db-check` or `/readyz` time out, options catalog has no
successful cycle, or empirical/TCA/platform receipts are stale. Observe and zero-notional repair can continue under
bounded budgets.
