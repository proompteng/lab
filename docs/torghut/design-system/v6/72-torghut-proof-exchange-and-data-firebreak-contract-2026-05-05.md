# 72. Torghut Proof Exchange and Data Firebreak Contract (2026-05-05)

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

I am choosing a proof exchange with lane-local data firebreaks as Torghut's next architecture step.

The evidence from May 5 is not ambiguous: Torghut's `/healthz` stays up, but DB-backed readiness and status routes
can hang while SQLAlchemy pool exhaustion and idle-in-transaction timeouts are in the logs. At the same time, Jangar
has useful quant frames and symbols, but market-context domains and proof metrics are stale. That means the profitable
system is not the one that asks more route-time questions. It is the one that turns every expensive proof into a
bounded, durable exchange item and allocates capital only to lanes with fresh, falsifiable proof.

The tradeoff is deliberate. We will slow down promotion and add more evidence plumbing. In exchange, we stop letting
request handlers, readiness probes, and scheduler cycles compete for the same database pool while the trading system
is supposed to be proving or rejecting hypotheses.

## Current State Assessment

All live checks were read-only.

### Cluster and Rollout State

Evidence collected on `2026-05-05`:

- Torghut namespace pods showed:
  - two ClickHouse replicas running;
  - ClickHouse Keeper running;
  - `torghut-db-1` running;
  - `torghut-00201` running with both containers ready;
  - `torghut-ta`, `torghut-ta-sim`, and four `torghut-ta-taskmanager` pods running;
  - `torghut-ws` running with two restarts over four days;
  - one `torghut-sim-00280` pod running and one `torghut-sim-00280` pod in `ImagePullBackOff`.
- Torghut events showed a recent failed Knative revision, readiness timeouts, `ImagePullBackOff` on one sim pod, and
  eventual readiness of `torghut-00201`.
- Jangar control-plane status reported `dependency_quorum.decision="block"` with workflow runtime and controller
  availability blockers.

Interpretation:

- The production trading runtime is partially available, not globally down.
- Simulation and proof capacity are degraded. That should block promotion and proof expansion, not necessarily
  shadow observation.
- The architecture needs lane-local and capability-local answers.

### Source Architecture

Current in-tree foundations:

- `services/torghut/app/trading/submission_council.py` already has:
  - typed quant-health endpoint authority;
  - `build_live_submission_gate_payload`;
  - segment summaries for `market-context`, `ta-core`, `execution`, `empirical`, and `llm-review`;
  - promotion-certificate candidate evaluation;
  - lineage references for dataset snapshots and strategy hypotheses.
- `services/torghut/app/trading/scheduler/pipeline.py` uses the live-submission gate before live order submission.
- `services/torghut/app/main.py` uses shared readiness and status helpers across `/readyz`, `/trading/status`,
  `/trading/health`, and runtime surfaces.
- `services/torghut/config/trading/hypotheses/*.json` declares three current hypothesis lanes:
  - `H-CONT-01` continuation, shadow, depending on `execution`, `empirical`, `llm-review`, and `ta-core`;
  - `H-MICRO-01` microstructure breakout, blocked, depending on `execution`, `empirical`, and `ta-core`;
  - `H-REV-01` event reversion, shadow, depending on `execution`, `empirical`, `llm-review`, `market-context`, and
    `ta-core`.
- The codebase has broad test coverage by count: 151 app Python files and 138 test files under `services/torghut`.
- The largest risk-bearing files are large enough to justify stronger boundaries:
  - `app/trading/autonomy/lane.py` around 7,377 lines;
  - `app/trading/autonomy/policy_checks.py` around 6,072 lines;
  - `app/trading/scheduler/pipeline.py` around 4,273 lines;
  - `app/main.py` around 3,959 lines.

The missing piece is not a gate. The missing piece is a bounded proof exchange that moves expensive proof reads out
of route handlers and records which lane, account, window, and data budget produced each answer.

### Database, Data Quality, Freshness, and Consistency

Direct store reads were intentionally restricted:

- CNPG Postgres reads through `kubectl cnpg psql` failed because this service account cannot create `pods/exec` in
  `torghut` or `jangar`.
- direct ClickHouse HTTP reads returned HTTP 401.

Runtime evidence still gives a clear data-state picture:

- Torghut `/healthz` returned HTTP 200 repeatedly.
- Torghut `/readyz`, `/db-check`, and `/trading/status` timed out during the run.
- Torghut logs showed repeated SQLAlchemy pool exhaustion:
  `QueuePool limit of size 5 overflow 5 reached, connection timed out, timeout 30.00`.
- Torghut logs showed `IdleInTransactionSessionTimeout` on
  `SELECT max(trade_decisions.created_at) AS max_1 FROM trade_decisions`.
- Jangar market-context health for `NVDA` reported:
  - `overallState="degraded"`;
  - technicals freshness `44416s`, max `60s`;
  - fundamentals freshness `4648542s`, max `86400s`;
  - news freshness `4303313s`, max `300s`;
  - regime freshness `44416s`, max `120s`.
- Jangar symbols returned 12 active symbols: `AMAT`, `AMD`, `ASML`, `AVGO`, `INTC`, `KLAC`, `LRCX`, `MU`, `NVDA`,
  `QCOM`, `TSM`, and `TXN`.
- Jangar quant alerts had one open warning for `sharpe_annualized` below threshold on strategy
  `4b0051ba-ae40-43c1-9d8b-ad5a57a2b8f6`, account `PA3SX7FYNUTF`, window `5d`.
- Jangar quant snapshot for strategy `6b163d0c-dcef-438b-ab88-ce5e806e3493`, account `PA3SX7FYNUTF`, window `1d`
  returned a frame, but many metrics were `insufficient_data` or stale. The same frame reported
  `metrics_pipeline_lag_seconds=86400` and metadata with `taFreshnessSeconds=25719`,
  `contextFreshnessSeconds=38456`, and `latestExecutionFreshnessSeconds=86400`.

Interpretation:

- Route-time DB reads are a live reliability risk.
- Market-context freshness is not acceptable for event-reversion promotion.
- Quant evidence is not empty, but stale and insufficient metrics make it unsuitable for broad capital promotion.
- The correct economic posture is `observe` or bounded repair, not live scale.

## Problem Statement

Torghut has strong gate vocabulary, but too much proof is still compiled on demand. That makes the system brittle in
exactly the moments where it should be most conservative:

1. Readiness and status routes can compete with trading and reconciliation for the same DB pool.
2. Market-context and quant evidence are mixed into broad payloads instead of settled into lane-local proof records.
3. A healthy `/healthz` can hide DB-backed route degradation.
4. Simulation image failures and empirical proof gaps do not yet produce an explicit proof-capacity budget.
5. Profitability promotion still depends on route-time interpretation instead of a durable exchange item that can be
   audited and expired.

The six-month goal is a trading system that can keep observing and researching under partial degradation while
preventing capital movement unless the exact lane, account, and window have fresh proof.

## Alternatives Considered

### Option A: Increase DB Pool and Route Timeouts

Summary:

- tune SQLAlchemy pool size, overflow, and route timeouts;
- keep current readiness/status proof compilation model.

Pros:

- quick operational relief;
- less schema/API work;
- useful as an emergency mitigation.

Cons:

- masks unbounded proof reads instead of removing them;
- increases database blast radius;
- does not create better promotion evidence;
- leaves `/readyz` and `/trading/status` exposed to the same proof-read failure mode.

Decision: rejected as the architecture. It may be a tactical mitigation, but not the design.

### Option B: Suspend Proof-Heavy Lanes Until DB Pressure Clears

Summary:

- stop or demote empirical, market-context, and quant proof paths when database pressure appears.

Pros:

- safe in the narrow sense;
- reduces immediate load;
- easy for deployer stages to understand.

Cons:

- gives up too much information;
- turns local proof-read pressure into broad research downtime;
- does not distinguish stale-but-usable shadow evidence from promotion-grade evidence.

Decision: rejected as the default posture. It should remain a rollback lever.

### Option C: Proof Exchange With Lane-Local Data Firebreaks

Summary:

- compile bounded proof records asynchronously or on a controlled cadence;
- assign every proof record to lane, hypothesis, account, window, source cell, and query budget;
- make route handlers read the latest proof record, not compile the proof;
- open firebreaks when proof reads exceed budget or freshness constraints;
- allow shadow observation under firebreaks, block capital promotion, and bound repair probes.

Pros:

- directly addresses route-time DB pressure;
- preserves research and observation under partial degradation;
- makes profitability evidence measurable and falsifiable;
- gives Jangar a bounded proof-read cell to consume.

Cons:

- requires additive proof-exchange schema and compiler jobs;
- introduces another lifecycle that must be tested and monitored;
- slows promotion until proof exchange parity is established.

Decision: selected.

## Decision

Torghut will implement a proof exchange with lane-local data firebreaks.

A proof exchange item is an immutable or append-only record with:

- `proof_exchange_id`
- `hypothesis_id`
- `lane_id`
- `strategy_family`
- `account`
- `window`
- `source_cell_set_id`
- `source_receipt_digest`
- `data_budget_units`
- `query_budget_units`
- `input_freshness`
- `metric_summary`
- `profitability_summary`
- `guardrail_summary`
- `capital_decision`
- `reason_codes`
- `artifact_refs`
- `issued_at`
- `expires_at`

Initial `capital_decision` values:

- `shadow`
- `observe`
- `repair_probe`
- `0.10x canary`
- `0.25x canary`
- `0.50x live`
- `1.00x live`
- `quarantine`
- `rollback_required`

Only proof exchange items can authorize non-shadow capital. Route-time payloads can report, explain, and block, but
they cannot invent a more permissive capital decision than the latest valid proof exchange item.

## Architecture Contract

### Proof Compilers

Implement three bounded compilers:

1. `ta-core-proof`
   - consumes ClickHouse freshness projections and signal continuity;
   - emits signal lag, feature presence, and TA freshness.
2. `market-context-proof`
   - consumes Jangar market-context domain health;
   - emits domain freshness, provider freshness, and symbol coverage.
3. `profitability-proof`
   - consumes quant metrics, execution quality, TCA, rejection ratios, empirical jobs, and promotion certificates;
   - emits post-cost expectancy, sample sufficiency, drawdown, slippage, clean execution ratio, and alert state.

Each compiler must have:

- fixed timeout;
- max rows or window bounds;
- max query budget;
- independent freshness SLO;
- explicit `source_cell_set_id` from Jangar when using Jangar projections.

### Data Firebreaks

A data firebreak is opened per lane and capability when:

- route-time DB pool exhaustion is observed;
- proof compiler times out;
- ClickHouse returns auth, memory, or timeout errors;
- market-context freshness exceeds lane policy;
- quant metrics are stale or insufficient;
- simulation or empirical capacity is unavailable;
- Jangar proof-read cell is stale, expired, or over budget.

Firebreak effects:

- `ta-core` firebreak blocks all non-shadow capital for lanes requiring `ta-core`;
- `market-context` firebreak blocks event-reversion promotion and allows only shadow/observe for unrelated lanes;
- `empirical` firebreak blocks canary/live promotion and allows proof repair;
- `execution` firebreak blocks live submission;
- `simulation` firebreak blocks promotion but not source-code research.

### Route Behavior

`/healthz` remains liveness only.

`/readyz`, `/db-check`, `/trading/status`, and `/trading/health` must stop compiling heavyweight proof inline. They
should report:

- latest proof-exchange item ids;
- proof age and expiry;
- active firebreaks;
- route read budget status;
- degraded reason codes;
- whether the route used a stale-but-allowed cached proof.

The current state, where `/healthz` returns 200 but `/readyz` and `/trading/status` can time out, becomes an explicit
contract: liveness can be healthy while proof exchange is degraded. Capital cannot move in that condition.

### Profitability Hypotheses

The first proof-exchange targets:

- `H-CONT-01`: continuation lane, must prove fresh `ta-core`, execution cleanliness, and post-cost expectancy.
- `H-MICRO-01`: microstructure breakout lane, remains blocked until microstructure feature proof and empirical proof
  are fresh.
- `H-REV-01`: event-reversion lane, cannot leave shadow while market-context technicals, news, fundamentals, or
  regime domains are stale beyond policy.

The innovative bet is portfolio-level proof selection, not one perfect sleeve:

- keep whitepaper/autoresearch as the candidate generator;
- use proof exchange to score sleeve contribution under freshness and query-cost constraints;
- promote diversified sleeves only when their combined proof improves post-cost objective without exceeding
  correlation, symbol concentration, drawdown, and execution-risk caps.

## Validation Gates

Engineer-stage acceptance:

- Unit tests for proof item lifecycle: issued, expired, superseded, firebreak-opened, repair-probe, rollback-required.
- Tests proving route handlers return latest proof ids instead of executing proof compilers inline.
- Tests proving DB pool timeout or idle-in-transaction evidence opens a proof-read firebreak.
- Tests proving `H-REV-01` is held when market-context domains are stale, while unrelated lanes can remain in
  `observe`.
- Tests proving non-shadow capital requires a valid proof exchange item with a matching Jangar `source_cell_set_id`.
- Migration graph check remains clean or any intentional branch is allowlisted with a same-change explanation.

Deployer-stage acceptance:

- `GET /healthz` returns liveness without implying proof health.
- `GET /readyz` returns bounded proof-exchange status within the configured timeout.
- Jangar control-plane status exposes a healthy `torghut-quant-proof-read` runtime cell before promotion.
- No open firebreak exists for a lane before canary/live promotion.
- Quant proof for the target lane has:
  - latest metric frame age within policy;
  - no open critical alert;
  - post-cost expectancy above lane threshold;
  - sample count above lane threshold;
  - clean execution ratio at or above policy;
  - reject-rate and slippage below rollback thresholds.
- Market-context proof for lanes requiring it has all required domains within freshness policy.

## Rollout Plan

1. Add proof-exchange schema and read models in shadow mode.
2. Add compilers with strict budgets and artifact refs, but keep current route payloads as source of truth.
3. Expose proof ids and firebreaks on `/readyz`, `/trading/status`, and `/trading/health`.
4. Switch routes to read proof summaries instead of compiling heavyweight proof inline.
5. Bind Jangar `torghut-quant-proof-read` runtime cell to proof-exchange freshness and budget state.
6. Make non-shadow capital require a valid proof exchange item.
7. Enable `repair_probe` budgets for stale-but-usable lanes after two successful shadow cycles.

## Rollback Plan

- If proof compiler causes load: disable compiler schedule, keep latest proof items, and force all lanes to
  `observe`.
- If routes regress: switch route reads back to stale cache summaries, not inline proof compilation.
- If firebreaks over-block: lower enforcement to warning-only for the affected lane, but keep non-shadow capital
  blocked.
- If proof exchange schema has a defect: add a superseding schema version and leave bad items expired rather than
  rewriting history.
- If Torghut DB pool pressure persists: hold all promotion, keep `/healthz` only for liveness, and recover database
  capacity before proof generation resumes.

## Risks and Tradeoffs

- The proof exchange adds state, and state can drift. The antidote is receipt digests, expiry, and tests that force
  routes to agree.
- The design may slow down promotion. That is acceptable because current proof freshness and route reliability do not
  justify broad capital movement.
- Firebreaks can become too conservative if segment mapping is sloppy. Segment dependencies in hypothesis manifests
  must remain explicit and reviewed.
- If compilers are not truly bounded, the architecture fails. Query budgets are not documentation; they must be
  enforced in code.

## Handoff to Engineer

Implement the proof exchange before expanding strategy logic.

First code slice:

- add proof-exchange persistence and typed models;
- add a bounded compiler for market-context proof because current evidence shows domain staleness clearly;
- expose proof ids and firebreaks on `/trading/status`;
- add tests for stale market-context blocking `H-REV-01` while `H-CONT-01` stays observable.

Second code slice:

- add TA and profitability proof compilers;
- move readiness/status routes to proof-summary reads;
- bind live-submission gate to proof-exchange ids;
- connect Jangar runtime cell ids.

Do not add new live strategy breadth until route-time proof reads are bounded.

## Handoff to Deployer

Treat `/healthz` as liveness only.

Promotion is allowed only when:

- `/readyz` returns within timeout and cites fresh proof ids;
- Jangar `torghut-quant-proof-read` cell is healthy;
- target lane has no active firebreak;
- target proof item is unexpired and cites the current Jangar cell set;
- market-context, TA, empirical, execution, and simulation proof are fresh for the lane's manifest requirements;
- NATS/Jangar update names the proof id and any remaining risk.

Rollback immediately if:

- route-time DB pool exhaustion reappears during proof-read traffic;
- proof compilers exceed budget;
- any non-shadow lane loses its required proof item;
- a route reports a capital decision that is more permissive than the proof exchange.
