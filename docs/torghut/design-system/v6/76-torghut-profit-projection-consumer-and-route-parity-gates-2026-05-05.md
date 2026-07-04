# 76. Torghut Profit Projection Consumer and Route-Parity Gates (2026-05-05)

Status: Ready for implementation

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: route repair, paper-route probing, quote routeability, and TCA/freshness surfaces exist but remain gate-controlled.
- Matched implementation area: Routeability, TCA, fill quality, and market context.
- Current source evidence:
  - `services/torghut/app/trading/route_reacquisition.py`
  - `services/torghut/app/trading/route_reacquisition_probe.py`
  - `services/torghut/app/trading/scheduler/paper_route_probe/probe_processing.py`
  - `services/torghut/app/trading/scheduler/submission_preparation/quote_routeability.py`
  - `services/torghut/app/trading/tca`
- Design drift note: Routeability claims need current repair/probe/TCA/readiness evidence.


## Executive Summary

The decision is to make Torghut consume Jangar evidence projections as a first-class profit input and to enforce route
parity around the resulting capital decision. Torghut already has useful gates in `submission_council.py`,
`completion.py`, autonomy policy checks, and readiness/status routes. The live problem is that those gates still depend
on multiple route-time fetches and can fail differently across `/readyz`, `/trading/status`, `/trading/health`, and
Jangar quant-health.

I am choosing a projection consumer over another local readiness patch because the current evidence is explicit:
Torghut `/healthz` is healthy, `/db-check` is schema-current, Jangar market-context health for `NVDA` is degraded with
stale domains, and Torghut trading routes timed out or returned an empty reply during this pass. A profitable system
cannot let those surfaces disagree without one durable receipt that tells capital what to do.

The tradeoff is stricter capital admission. Some lanes that currently collect route-local optimistic signals will stay
in observe or shadow until the Jangar projection, Torghut schema, market context, execution, and hypothesis evidence all
agree. I am accepting that cost because profitability is not just finding alpha. It is refusing to spend capital when
the evidence chain is stale or unreadable.

## Success Criteria

This contract is done when:

1. `/readyz`, `/trading/status`, `/trading/health`, scheduler live submission, and Jangar quant-health consume the same
   `profit_projection_receipt_id`;
2. non-observe capital requires a fresh Jangar `torghut_profit` projection snapshot from the companion Jangar broker;
3. route timeout, empty reply, stale market-context domain, dependency-quorum block, schema warning, and hypothesis
   rollback are distinct reason codes;
4. stale domains block only lanes that depend on those domains;
5. every capital move records projection id, hypothesis id, account, lane, strategy family, data-domain clocks, schema
   digest, execution digest, decision, expiry, and rollback action;
6. deployer rollback can move all lanes to observe/shadow without deleting projection evidence.

## Current State Evidence

All cluster and database checks in this run were read-only.

### Cluster and Rollout

Observed facts:

- `kubectl get pods -n torghut -o wide` showed Torghut service pods, Torghut DB, ClickHouse, Keeper, TA task managers,
  websocket forwarder, guardrail exporters, options services, and Symphony-Torghut running.
- `torghut-ws-options` had one recent restart, and recent Torghut events showed readiness warnings during rollout before
  the latest revisions became ready.
- `torghut-db-migrations`, `torghut-empirical-jobs-backfill`, and `torghut-whitepaper-semantic-backfill` jobs completed
  during the observed window.
- The constrained worker cannot list `apps` workloads in `torghut` and cannot exec into `torghut-db-1`, so deploy
  verification must consume projected evidence instead of raw database shell checks.

### Source Architecture

Important source surfaces:

- `services/torghut/app/trading/submission_council.py`
  - builds the live submission gate;
  - fetches typed Jangar quant health from `/api/torghut/trading/control-plane/quant/health`;
  - composes market-context segments, empirical status, DSPy state, runtime hypotheses, quant health, and dependency
    quorum.
- `services/torghut/app/trading/completion.py`
  - checks dependency quorum in completion gate traceability.
- `services/torghut/app/trading/autonomy/policy_checks.py`
  - blocks or delays promotion when Jangar dependency quorum is missing, delayed, or blocked.
- `services/torghut/app/main.py`
  - surfaces live submission gate detail through `/readyz`, `/trading/status`, and `/trading/health`.
- `services/torghut/tests/test_trading_api.py` and `services/torghut/tests/test_submission_council.py`
  - already cover route parity and live-submission blocking behavior, so the next implementation can add projection id
    parity without inventing a new test style.

Interpretation: Torghut does not need a new local safety vocabulary. It needs one durable projection receipt that all
existing routes and scheduler paths consume.

### Database, Schema, Freshness, and Consistency

Schema evidence:

- `GET /healthz` returned `{"status":"ok","service":"torghut"}`.
- `GET /db-check` returned `ok=true`.
- Current and expected Alembic head are both `0029_whitepaper_embedding_dimension_4096`.
- `schema_graph_lineage_ready=true`.
- Duplicate revisions and orphan parents are empty.
- Parent-fork warnings remain present around `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Account-scope checks are ready, with the expected warning that checks are bypassed when multi-account trading is
  disabled.

Freshness and route evidence:

- `GET /readyz` timed out during this pass.
- `GET /trading/status` timed out during this pass.
- Jangar quant-health returned an empty reply during this pass.
- `GET /api/torghut/market-context/health?symbol=NVDA` through Jangar returned `overallState="degraded"`.
- Market-context bundle freshness was about `48740s` against a `300s` target.
- Technicals and regime were stale by tens of thousands of seconds; fundamentals and news were stale by millions of
  seconds.
- Provider attempts for fundamentals and news succeeded during the pass, which means ingestion can be working while the
  aggregate bundle remains stale.

Interpretation: schema health is necessary but not sufficient. Torghut needs route parity and freshness receipts before
profit authority can move beyond observe/shadow.

## Problem Statement

Torghut has the ingredients for capital safety, but it still asks too many hot-path surfaces to independently answer the
same capital question. When `/healthz` is up, `/db-check` is current, `/readyz` times out, Jangar quant-health returns
empty reply, and market context is stale, the system needs one capital answer with typed reasons. It cannot leave that
composition to route callers.

The expensive failure modes are:

1. live-capital language survives because one route was healthy while another route timed out;
2. stale market context becomes a generic system warning instead of a lane-local veto;
3. Jangar dependency quorum is consumed as a route-time payload without a shared projection id;
4. deployment and trading automation cannot distinguish schema-current from data-fresh;
5. rollback evidence disappears into route logs instead of remaining as a durable capital receipt.

## Alternatives Considered

### Option A: Keep Current Route-Time Fetches and Add Retries

Add retries and shorter timeouts around `/readyz`, `/trading/status`, Jangar quant-health, and market-context fetches.

Pros:

- small change;
- helps transient HTTP failures;
- keeps existing route boundaries.

Cons:

- retries do not create a shared capital decision;
- route calls can still observe different points in time;
- stale data and timeout remain consumer-side interpretation;
- no durable receipt for rollback or profitability review.

Decision: rejected.

### Option B: Global Observe Mode on Any Unknown

Force every lane to observe whenever any Jangar, schema, market-context, or trading route is unknown.

Pros:

- operationally safe;
- easy to reason about in an incident;
- cheap to implement.

Cons:

- blocks unrelated lanes;
- reduces opportunity collection and repair probes;
- hides which evidence class actually failed;
- does not improve route parity.

Decision: rejected as the default architecture, though it remains a manual emergency posture.

### Option C: Profit Projection Consumer and Route-Parity Gates

Torghut consumes one Jangar `torghut_profit` projection snapshot, combines it with local schema, market-context,
execution, and hypothesis evidence, writes a `profit_projection_receipt`, and makes all routes and scheduler decisions
consume that receipt.

Pros:

- makes route parity enforceable;
- preserves lane-local capital decisions;
- records typed reason codes for profitability and rollback analysis;
- integrates directly with the Jangar least-privilege projection broker;
- gives deployer and engineer stages concrete acceptance gates.

Cons:

- requires additive persistence and route wiring;
- requires a retention policy for receipt payloads;
- will temporarily hold more lanes in observe/shadow until evidence is fresh.

Decision: selected.

## Decision

Implement Torghut Profit Projection Consumer and Route-Parity Gates.

Torghut will:

1. fetch or receive the Jangar `torghut_profit` projection snapshot;
2. combine it with local Torghut schema, market-context, execution, hypothesis, empirical, and broker/account evidence;
3. write a durable profit projection receipt;
4. make `/readyz`, `/trading/status`, `/trading/health`, scheduler live submission, and Jangar quant-health cite the
   same receipt id;
5. use that receipt as the only authority for non-observe capital.

## Target Model

Add or project:

```text
torghut_profit_projection_receipts
  receipt_id
  jangar_projection_snapshot_id
  account
  lane
  hypothesis_id
  strategy_family
  schema_digest
  market_context_digest
  execution_digest
  empirical_digest
  broker_digest
  decision                 # observe, shadow, probe, live, scale, quarantine
  allowed_stage
  requested_stage
  reason_codes
  observed_at
  fresh_until
  rollback_action
  evidence_digest

torghut_route_parity_checks
  parity_check_id
  receipt_id
  route_name               # readyz, trading_status, trading_health, scheduler, jangar_quant_health
  route_decision
  route_reason_codes
  observed_at
  fresh_until
  parity_status            # match, mismatch, missing, stale
```

Reason-code classes:

- `jangar_projection_missing`
- `jangar_projection_stale`
- `jangar_projection_blocked`
- `schema_current_with_warnings`
- `market_context_domain_stale`
- `market_context_bundle_stale`
- `trading_route_timeout`
- `trading_route_empty_reply`
- `quant_health_unavailable`
- `hypothesis_not_promotion_eligible`
- `hypothesis_rollback_required`
- `execution_revision_unready`
- `broker_unavailable`

## Measurable Trading Hypotheses

### H1: Projection-Gated Capital Reduces Stale-Data Losses

Hypothesis: Lanes that require technicals, regime, fundamentals, or news have better post-cost results when entries are
blocked after the relevant projection expires and reopened only after a fresh projection returns.

Measurement:

- compare post-cost PnL, hit rate, drawdown, slippage, and missed-opportunity count between projection-gated shadow
  trades and legacy route-time status decisions;
- require at least two market sessions of shadow evidence before live probe;
- treat domain-specific stale data as a lane-local veto, not a global freeze.

Guardrails:

- non-observe capital is blocked if `market_context_bundle_stale` affects the lane;
- observe/shadow evidence can continue collecting while the domain is stale;
- stale fundamentals must not block pure intraday technical lanes unless the lane declares that dependency.

### H2: Route-Parity Receipts Reduce False Live Readiness

Hypothesis: Requiring `/readyz`, `/trading/status`, `/trading/health`, scheduler, and Jangar quant-health to share one
receipt id reduces false live readiness and shortens rollback diagnosis.

Measurement:

- count parity mismatches per day;
- measure time from route mismatch to rollback action;
- require zero route-parity mismatches for one full trading session before `live` or `scale`.

Guardrails:

- any route timeout or empty reply marks the receipt `observe` or `quarantine` for affected lanes;
- route mismatch cannot be overridden by broker reachability alone;
- deployment promotion fails if Jangar projection and Torghut receipt ids disagree.

### H3: Profit Receipts Improve Capital Allocation Discipline

Hypothesis: Capital allocated only to lanes with fresh profit projection receipts produces better risk-adjusted return
than capital allocated from aggregate health status.

Measurement:

- rank lanes by receipt freshness, post-cost PnL, drawdown, capacity, and evidence age;
- compare capital-weighted Sharpe and max drawdown against the previous aggregate-health gate;
- keep a holdout set in shadow to detect overfitting to projection freshness.

Guardrails:

- no `scale` without multiple fresh receipts across distinct sessions;
- no `live` if `hypothesis_rollback_required` or `hypothesis_not_promotion_eligible` is present;
- probe capital must have explicit max loss and automatic expiry.

## Implementation Scope

Engineer scope:

1. Add a Jangar projection consumer in Torghut with cache TTL, timeout classification, and digest validation.
2. Add a profit projection receipt builder that composes Jangar projection, `/db-check`, market context, execution,
   empirical jobs, hypothesis state, and broker/account state.
3. Add receipt id projection to `/readyz`, `/trading/status`, `/trading/health`, scheduler live submission, and Jangar
   quant-health payloads.
4. Add route-parity tests that fail when routes emit different receipt ids or decisions.
5. Add lane-local stale-domain logic so stale data blocks only declared dependencies.
6. Add retention defaults for compact receipts and optional detailed payload refs.

Non-goals:

- replacing Torghut's existing submission council;
- global observe mode as the default response to any stale domain;
- direct database exec from deploy workers;
- relying on route-time retries as promotion authority.

## Validation Gates

Engineer local gates:

- `uv sync --frozen --extra dev`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- targeted tests covering:
  - Jangar projection missing/stale/blocked;
  - route timeout and empty reply classification;
  - `/readyz`, `/trading/status`, `/trading/health`, scheduler, and Jangar quant-health receipt-id parity;
  - stale market-context domain blocking only dependent lanes;
  - hypothesis rollback forcing observe/quarantine.

Deployer gates:

- Jangar projection route returns a fresh `torghut_profit` projection snapshot.
- Torghut `/db-check` remains schema-current.
- Torghut profit receipt includes the Jangar projection snapshot id.
- `/readyz`, `/trading/status`, `/trading/health`, scheduler snapshot, and Jangar quant-health share the same receipt id.
- Non-observe capital remains blocked while market-context domains needed by the lane are stale.
- Rollback to observe/shadow does not delete receipt history.

## Rollout Plan

1. Ship receipt generation in shadow mode.
2. Emit receipt id on routes without changing capital behavior.
3. Compare route parity for one full trading session.
4. Enforce route parity for non-observe capital.
5. Enforce Jangar projection freshness for probe/live/scale.
6. Allow lane-local probe only after projection and receipt freshness pass.
7. Allow live only after post-cost profit evidence and route parity pass across configured windows.

Feature flags:

- `TORGHUT_PROFIT_PROJECTIONS_ENABLED=true`
- `TORGHUT_PROFIT_PROJECTIONS_ENFORCEMENT=shadow|route_parity|capital`
- `TORGHUT_PROFIT_PROJECTION_RECEIPT_TTL_SECONDS=300`
- `TORGHUT_PROFIT_PROJECTION_DETAIL_RETENTION_DAYS=14`

## Rollback Plan

- Set `TORGHUT_PROFIT_PROJECTIONS_ENFORCEMENT=shadow` to stop behavioral blocks while retaining receipts.
- Move all non-observe lanes to observe if receipt generation fails closed.
- Keep route receipt ids visible during rollback so operators can compare old and new decisions.
- Do not delete receipts or parity rows.
- If Jangar projection is unavailable, use the last receipt only for observe/shadow evidence collection, never for live
  or scale.

## Risks and Open Questions

- Receipt retention can grow quickly. Keep compact rows longer than detailed payload refs.
- Market-context dependency declarations must be explicit or stale domains may block too much or too little.
- Empty reply versus timeout must remain distinct because they imply different repair owners.
- The first implementation should use Jangar projection ids, not parse free-form status strings.
- Profitability measurement must include missed-opportunity cost so projection gating does not silently overfit toward
  inactivity.

## Handoff to Engineer

Start with projection consumption and route parity. Do not begin capital enforcement until routes can all cite the same
receipt id in tests and in a shadow deploy.

Acceptance gates:

- receipt builder handles missing, stale, blocked, timeout, and empty-reply projection cases;
- all relevant routes expose one `profit_projection_receipt_id`;
- lane-local market-context stale decisions are tested;
- non-observe capital is impossible without a fresh Jangar projection id;
- rollback keeps receipt history available.

## Handoff to Deployer

Deploy with enforcement in `shadow`. Watch one full trading session for route-parity mismatches and stale-domain
decisions before enabling capital enforcement.

Rollback gate:

- if route parity mismatches appear after enforcement, set enforcement back to `shadow`;
- if Jangar projection goes stale, keep Torghut in observe/shadow and keep collecting receipt evidence;
- if a stale data domain blocks unrelated lanes, disable lane-local enforcement and keep the receipt defect for engineer
  repair.
