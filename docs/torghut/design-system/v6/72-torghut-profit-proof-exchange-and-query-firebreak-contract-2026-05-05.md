# 72. Torghut Profit Proof Exchange and Query Firebreak Contract (2026-05-05)

Status: Ready for implementation

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


## Executive Summary

The decision is to introduce a Torghut profit proof exchange and query firebreak. Torghut may keep trading services
alive when proof routes are degraded, but no non-observe capital promotion may proceed without a fresh proof receipt
that Jangar can consume as a proof cell.

The May 5 state says the current design is too expensive at the wrong time:

- `GET /healthz` returns HTTP `200`.
- `GET /readyz`, `GET /db-check`, and `GET /trading/health` time out from the cluster.
- Torghut logs show repeated `IdleInTransactionSessionTimeout` on
  `SELECT max(trade_decisions.created_at) FROM trade_decisions`.
- Jangar typed quant health times out for a known strategy/account/window.
- Jangar market-context for `AAPL` and `NVDA` is stale across technicals, fundamentals, news, and regime.
- Empirical jobs are truthful but stale, with March 21 artifacts still cited in `/trading/autonomy`.
- `torghut-sim-00280` has `ImagePullBackOff` on one node for a digest that reports `no match for platform`, which makes
  simulation proof availability non-portable even when a sibling pod is running.

The profit opportunity is not to loosen the guardrails. The opportunity is to stop wasting live time and database pool
capacity proving the same facts in request paths. Fresh proof should be produced once, stored as a bounded receipt, and
consumed by Jangar and Torghut promotion gates.

## Current Evidence

### Cluster and Rollout

Read-only cluster evidence:

- Torghut namespace pod states:
  - `Running 17`
  - `ImagePullBackOff 1`
  - `Completed 1`
- Recent events:
  - `torghut-sim-00280-deployment-6f844b4647-np4x6` failed to pull
    `registry.ide-newton.ts.net/lab/torghut@sha256:d278...` with `no match for platform`;
  - `torghut-00202` later became ready after startup and readiness timeouts;
  - `torghut-sim-00280` continued to emit readiness timeout and image backoff events.

Interpretation:

- The main serving route can recover.
- Simulation proof capacity is not portable across nodes.
- Promotion cannot depend on "one pod somewhere has the image" as proof.

### Source Architecture and High-Risk Modules

High-risk source paths:

- `services/torghut/app/main.py`
  - `/readyz` and `/trading/health` call `_evaluate_trading_health_payload`;
  - `_evaluate_trading_health_payload` can trigger dependency checks, hypothesis payload building, market-context
    status, empirical job status, quant evidence status, and live submission gate work;
  - `/db-check` calls `_evaluate_database_contract` directly;
  - current behavior makes health routes vulnerable to DB and proof-query latency.
- `services/torghut/app/db.py`
  - uses a small SQLAlchemy pool;
  - route-time proof scans can starve the same pool used by runtime work.
- `services/jangar/src/server/torghut-quant-runtime.ts`
  - materializes quant snapshots by reading strategy/account/metric state from Torghut database pools;
  - route consumers need bounded cached projections, not fresh deep reads under pressure.
- `services/torghut/app/trading/submission_council.py`
  - already points at typed Jangar quant health;
  - needs proof-receipt semantics so typed health timeout becomes a clear `hold`, not ambiguous operational noise.

Test gap:

- Existing tests cover many individual readiness and submission behaviors, but there is no property test proving a
  timed-out freshness scan cannot promote capital when a stale-but-truthful receipt exists.

### Database, Freshness, and Consistency

Observed data quality:

- Jangar market-context for `AAPL`:
  - technicals stale from `2026-05-04T20:19:07Z`;
  - fundamentals stale from `2026-03-12T13:42:49Z`;
  - news stale from `2026-03-16T19:36:22.853Z`;
  - regime stale from `2026-05-04T20:19:07Z`;
  - quality score `0.4575`.
- Jangar market-context for `NVDA`:
  - stale technicals, fundamentals, news, and regime;
  - risk flags include source errors and `market_context_stale`;
  - quality score `0.7025`.
- Torghut `/trading/autonomy`:
  - `enabled=false`;
  - empirical jobs are `degraded`;
  - `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` are completed and
    truthful but stale;
  - all cite `torghut-full-day-20260318-884bec35` and March 21 artifact refs.

Interpretation:

- The system has enough persisted evidence structure to be disciplined.
- The evidence is stale or too expensive to prove on demand.
- Profitability architecture must price freshness and query cost explicitly.

## Problem Statement

Torghut cannot become reliably profitable if the act of proving readiness competes with the act of running the trading
system. Right now a health request can do work that belongs in a proof producer:

- schema and account-scope checks;
- latest trade-decision freshness scans;
- hypothesis summaries;
- market-context status;
- empirical job readiness;
- live submission gate assembly.

That creates two bad outcomes:

1. request paths time out, which blocks operators and Jangar consumers;
2. teams are tempted to bypass proof because the proof route is slow, which would put stale data into capital decisions.

The right answer is not permissive fallback. The right answer is a bounded proof exchange.

## Alternatives Considered

### Option A: Increase Database Pool and Route Timeouts

Summary:

- raise SQLAlchemy pool size and timeout budgets;
- keep current health and readiness computation mostly intact.

Pros:

- fastest operational relief;
- low schema cost;
- easy to roll back.

Cons:

- scales the expensive pattern instead of removing it;
- still couples operator routes to proof scans;
- does not produce durable receipts for Jangar;
- can hide stale evidence behind a larger pool.

Decision: rejected as the primary architecture. Pool tuning remains a tactical mitigation.

### Option B: Disable Heavy Checks on Readiness

Summary:

- keep `/healthz` and `/readyz` shallow;
- move promotion checks elsewhere later.

Pros:

- improves route availability quickly;
- reduces rollout flakiness.

Cons:

- creates a blind spot unless promotion checks are implemented immediately;
- risks confusing liveness with profit authority;
- does not answer how Jangar should consume Torghut proof.

Decision: rejected as incomplete.

### Option C: Profit Proof Exchange with Query Firebreaks

Summary:

- produce lane-local profit receipts asynchronously;
- store proof receipts with freshness, query budget, image portability, and post-cost metrics;
- let health routes project the latest unexpired receipt;
- let Jangar consume the receipt as an evidence-epoch proof cell.

Pros:

- removes expensive scans from request paths;
- makes stale-but-truthful evidence explicit;
- supports measured profitability hypotheses;
- allows serving to stay up while promotion blocks.

Cons:

- requires additive schema and producer jobs;
- requires operators to learn receipt states;
- promotion may initially be blocked more often until receipts are fresh.

Decision: selected.

## Decision

Torghut will implement a profit proof exchange. Every non-observe capital movement must cite one fresh
`profit_proof_receipt`.

Receipt fields:

- `profit_proof_receipt_id`
- `lane_id`
- `strategy_id`
- `account`
- `window_id`
- `hypothesis_id`
- `dataset_snapshot_ref`
- `market_context_ref`
- `quant_health_ref`
- `image_portability_ref`
- `query_firebreak_ref`
- `post_cost_net_pnl`
- `gross_pnl`
- `fees`
- `slippage_bps`
- `drawdown`
- `turnover`
- `trade_count`
- `confidence`
- `decision`
- `reason_codes`
- `observed_at`
- `fresh_until`
- `artifact_refs`

Decisions:

- `allow_probe`
- `allow_observe`
- `hold`
- `block`
- `revoke`

## Measurable Trading Hypotheses

The proof exchange must evaluate hypotheses as portfolio components, not as isolated backtest winners.

Initial hypotheses:

1. Continuation sleeve:
   - claim: high-volume intraday continuation can contribute positive post-cost PnL when market-context freshness is
     green and spread/slippage remain bounded;
   - minimum proof: positive post-cost net PnL across at least two non-overlapping market windows, max drawdown under the
     configured sleeve cap, and no stale technical/regime context.
2. Rebound sleeve:
   - claim: washout rebound can diversify the continuation sleeve when correlation and concentration limits are enforced;
   - minimum proof: positive marginal portfolio contribution after correlation penalty and no single best-day dependency.
3. Research-backed sleeve:
   - claim: whitepaper-derived hypotheses can improve the portfolio only if they pass runtime-native replay and shadow
     validation before constrained live capital;
   - minimum proof: linked whitepaper claim ids, executable candidate spec, replay evidence, and shadow receipt.

Promotion guardrails:

- no promotion with stale market-context proof;
- no promotion with stale empirical proof;
- no promotion when typed quant health times out and no unexpired receipt exists;
- no promotion when image portability proof is missing for simulation lanes;
- no promotion when query firebreak budget is exhausted;
- no promotion when post-cost PnL is positive only before fees or slippage.

## Query Firebreak

The query firebreak is a budget and projection layer for expensive proof reads.

Rules:

1. `/healthz` remains shallow.
2. `/readyz`, `/db-check`, `/trading/health`, and Jangar quant health routes read bounded projections first.
3. Expensive freshness scans such as `SELECT max(trade_decisions.created_at)` move to producer jobs with explicit
   statement timeout and receipt output.
4. If a producer times out, it writes or updates a `query_firebreak_ref` with `decision="hold"` or `decision="block"`.
5. Route-time code may use the last unexpired receipt, but it must label stale or missing receipts clearly.

Initial query budgets:

- latest trade-decision freshness: background only, max 2 seconds, never on `/readyz`;
- market-context freshness: projection only on route paths, producer refresh per symbol set;
- quant health summary: bounded projection by strategy/account/window;
- schema contract: low-frequency producer with explicit migration-head digest.

## Implementation Scope

### Phase 1: Receipt Schema and Shadow Producers

Additive work:

- create `profit_proof_receipts`;
- create `query_firebreak_receipts`;
- create a producer that writes latest trade-decision freshness receipts without route-time scans;
- expose `/trading/proof-receipts/latest`;
- update `/trading/autonomy` to include receipt ids and freshness.

Validation:

- unit tests for receipt expiry and stale projection;
- property tests proving stale receipts hold promotion;
- route tests proving `/healthz` stays shallow and `/readyz` can project without deep scans.

### Phase 2: Jangar Proof-Cell Integration

Additive work:

- have Jangar pull or receive Torghut proof receipts and attach them to `torghut:profit-proof-exchange` proof cells;
- typed quant health should return `hold` with receipt reason codes when the live query times out and no receipt is
  fresh;
- NATS handoff messages should cite the receipt id and top blocker reason.

Validation:

- Jangar route tests for fresh, stale, missing, and timeout receipt states;
- Torghut tests proving submission council blocks non-observe capital when Jangar proof cell is stale.

### Phase 3: Promotion Enforcement

Behavior changes:

- non-observe capital requires `profit_proof_receipt.decision in allow_probe|allow_observe` as configured for the lane;
- constrained live requires positive post-cost proof and fresh market-context/quant/image/query cells;
- scaled live remains disabled until multiple unexpired windows pass.

Validation:

- replay and shadow proof receipts for each initial hypothesis;
- deployer can run one command to show the active receipt id, epoch id, and blocker reasons.

## Rollout Plan

1. Ship tables and producers in shadow mode.
2. Stop route-time latest trade-decision scans after projection parity is proven.
3. Attach receipt ids to `/trading/autonomy`, Jangar typed quant health, and NATS handoff.
4. Enforce observe/probe promotion only.
5. Enforce constrained-live promotion after two fresh proof windows.
6. Keep scaled-live promotion disabled until the portfolio objective and drawdown gates are proven.

## Rollback Plan

- Disable promotion enforcement first.
- Keep proof producers running if they are healthy; they are diagnostic.
- Re-enable old route-time checks only as an emergency diagnostic path, not as promotion authority.
- Never promote capital from a route-time fallback after enforcement has been enabled.

## Acceptance Gates for Engineer Stage

Engineer stage is accepted only when:

1. routes can project receipt state without running heavyweight scans;
2. stale receipt tests fail promotion closed;
3. query firebreak receipts capture timeout, statement, and age without leaking sensitive connection details;
4. Jangar can consume the latest proof receipt as a proof cell;
5. image portability proof exists for simulation lanes before simulation evidence is accepted.

## Acceptance Gates for Deployer Stage

Deployer stage is accepted only when:

1. `/healthz` remains fast and shallow;
2. `/readyz` and `/trading/health` no longer time out during a proof refresh;
3. a fresh `profit_proof_receipt_id` appears in Torghut and Jangar projections;
4. stale market-context or quant-health proof blocks promotion while serving remains available;
5. rollback flags can disable enforcement without deleting receipt history.

## Risks

- Receipts can become another stale surface. Mitigation: explicit `fresh_until`, producer lag metrics, and fail-closed
  promotion.
- Producers can overload the same database. Mitigation: separate query budgets, statement timeouts, and low-frequency
  background work.
- Operators may mistake `allow_observe` for live promotion. Mitigation: distinct decisions and explicit capital-stage
  mapping.
- Short proof windows can block good trades. Mitigation: allow bounded probe capital only when freshness insurance is
  explicitly funded and recorded.

## Handoff

Engineer:

- build receipt schema and shadow producers first;
- remove route-time heavyweight scans only after projection parity is tested;
- make every timeout a receipt state, not an uncaught exception.

Deployer:

- verify proof receipt freshness before enabling promotion enforcement;
- treat image-platform mismatch as simulation-proof failure;
- keep serving and promotion decisions separate in release notes and rollback decisions.
