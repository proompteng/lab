# 172. Torghut Repair Yield Ledger And Session Proof Capital Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut quant profitability, repair-yield measurement, market-context freshness, route repair, session-bound
proof, capital promotion gates, validation, rollout, rollback, and Jangar material-action handoff.

Companion Jangar contract:

- `docs/agents/designs/168-jangar-source-heartbeat-witness-settlement-and-material-action-bonds-2026-05-07.md`

Extends:

- `171-torghut-profit-evidence-half-life-and-capital-carry-governor-2026-05-07.md`
- `170-torghut-capital-surface-repair-cadence-and-route-edge-market-2026-05-07.md`
- `169-torghut-route-reacquisition-board-and-profit-repair-packets-2026-05-07.md`
- `docs/agents/designs/168-jangar-source-heartbeat-witness-settlement-and-material-action-bonds-2026-05-07.md`

## Decision

I am selecting a repair-yield ledger with session-proof capital gates as Torghut's next profitability architecture
step.

The latest promoted Torghut image is serving. `/trading/status` reports live mode, active revision `torghut-00289`,
build commit `476f73d0a0b4f2f9c37d2106a591b8ebe3600238`, scheduler running, kill switch off, and live submission
disabled by policy. `/db-check` is healthy and current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
Direct Torghut Postgres read-only sampling succeeded through the app credential and showed 69 public base tables,
fresh maintenance on `execution_tca_metrics`, and a large options contract catalog with about 2.39 million rows.

The profitable interpretation is still conservative. The proof floor is `repair_only`, route state is `repair_only`,
capital state is `zero_notional`, and max notional is `0`. The blocking reasons are stable:
`hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, `market_context_stale`, and
`simple_submit_disabled`. Provider health is not enough to clear the market-context blocker: fundamentals and news
providers succeeded at 23:11Z, but the bundle remained stale, with technicals/regime about 9,482 seconds old, news
about 19,713 seconds old, and fundamentals about 4,872,481 seconds old. Route repair also remains debt, with AAPL only
probing, four blocked symbols, and three missing symbols.

Torghut should stop treating repair execution as progress unless the repair reduces a named blocker. The new object is
a `repair_yield_ledger`. It records each no-notional repair candidate, its before/after blocker set, the session and
revision it belongs to, and the measured blocker delta. A companion `session_proof_capital_gate` then decides whether
the evidence is usable for observe, zero-notional repair, paper candidate, live micro, or live scale.

The tradeoff is that a successful refresh job can have zero yield. I want that visible. Profitability improves when
repairs are paid for actual blocker retirement, not for activity.

## Runtime Objective And Success Metrics

Success means:

- `/readyz`, `/trading/health`, and `/trading/status` expose `repair_yield_ledger` and
  `session_proof_capital_gate`.
- Every repair candidate has `before_blockers`, `after_blockers`, `yield_score`, `session_id`, `revision_ref`,
  `capital_effect`, and `next_gate`.
- Provider success without domain freshness improvement yields `0` for the relevant market-context blocker.
- Route repair yield is measured by changes in route states, slippage guardrail status, missing-symbol count, and
  dependency receipts.
- Quant repair yield is measured by stage coverage, latest metric freshness, and max stage lag.
- Alpha repair yield is measured by promotion-eligible count, rollback-required count, and hypothesis state changes.
- Paper candidate remains blocked unless at least two symbols are route-edge candidates, market context is fresh inside
  its session window, quant stage evidence exists, alpha readiness has at least one promotion-eligible hypothesis, and
  Jangar material-action bond is settled.
- Live micro remains blocked unless paper has a settled session proof, live submit is enabled, TCA is current, and
  route provenance coverage is at least 95 percent.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 between 23:08Z and 23:17Z. I did not mutate Kubernetes resources,
database records, ClickHouse tables, GitOps resources, broker state, empirical artifacts, AgentRuns, or trading flags.

### Cluster And Rollout Evidence

- Branch: `codex/swarm-torghut-quant-discover`, based on `main` at
  `250e2e1fd chore(torghut): promote image 476f73d0 (#5982)`.
- Torghut live revision `torghut-00288` was ready and `torghut-00289` was starting during the pod read. The status
  endpoint later reported active revision `torghut-00289`.
- Torghut sim revision `torghut-sim-00387` was ready and `torghut-sim-00388` was starting during the pod read.
- Current live and sim Knative deployments were on
  `registry.ide-newton.ts.net/lab/torghut@sha256:333d1405453894729d7ea68a9e38b78e6c988d301e7699c5cd576c7d6af8c5fe`.
- `torghut-db-migrations` completed in 88 seconds and was 102 seconds old when sampled.
- ClickHouse, Keeper, Postgres, TA, TA sim, options TA, options catalog, options enricher, websockets, guardrail
  exporters, and Symphony Torghut were running.
- A retained `torghut-whitepaper-autoresearch-profit-target-8r6w6` Error pod remained visible.
- Recent warnings included repeated Knative startup/readiness probe failures during revision handoff, options
  catalog/enricher readiness failures during replacement, ClickHouse multiple-PDB ambiguity warnings, and
  FlinkDeployment status modification warnings.

### Endpoint Evidence

- `/healthz` returned `{"status":"ok","service":"torghut"}`.
- `/db-check` returned `ok=true`, checked at `2026-05-07T23:11:09.781924+00:00`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, and no duplicate revisions or orphan parents.
- `/readyz` returned `status=degraded` with Postgres, ClickHouse, Alpaca, database, universe, empirical jobs, DSPy
  runtime, and scheduler checks healthy or acceptable. It still marked live submission and proof floor unhealthy.
- `/trading/status` reported:
  - mode `live`;
  - build `v0.568.5-467-g476f73d0a`;
  - commit `476f73d0a0b4f2f9c37d2106a591b8ebe3600238`;
  - active revision `torghut-00289`;
  - live submission gate `allowed=false`, reason `simple_submit_disabled`, capital stage `shadow`;
  - proof floor `repair_only`, route state `repair_only`, capital state `zero_notional`, max notional `0`.
- Quant control-plane health through Jangar had `latestMetricsCount=144`, `latestMetricsUpdatedAt=2026-05-07T23:11:42.063Z`,
  `metricsPipelineLagSeconds=6`, and `stageCount=0`.

### Trading Evidence

- Blocking reasons were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`,
  `market_context_stale`, and `simple_submit_disabled`.
- Market context last checked at `2026-05-07T23:11:40.093641Z`, but last bundle `as_of` was
  `2026-05-07T20:33:02Z`, freshness was 9,482 seconds, and all domains were stale.
- Domain freshness from the status payload:
  - technicals: 9,482 seconds old against a 60 second max;
  - fundamentals: 4,872,481 seconds old against an 86,400 second degraded max;
  - news: 19,713 seconds old against a 300 second max;
  - regime: 9,482 seconds old against a 120 second max.
- Provider health showed fundamentals and news attempts and successes at 23:11Z, with no consecutive failures. That
  proves provider liveness but not evidence yield.
- Alpha readiness had three hypotheses, zero promotion eligible, and three rollback required.
- Execution TCA covered 7,334 orders and 7,245 filled executions. Aggregate average absolute slippage was
  `13.8203637593029676` bps against an 8 bps guardrail.
- Route reacquisition summary: eight scope symbols, zero routeable, one probing (`AAPL`), four blocked (`NVDA`, `AMD`,
  `INTC`, `AVGO`), three missing (`AMZN`, `GOOGL`, `ORCL`), seven repair candidates, expected unblock value 14.

### Database And Data Evidence

- Direct Torghut Postgres SQL used a read-only transaction through `torghut-db-app`.
- Current database was `torghut`, user `torghut_app`, with server time `2026-05-07T23:14:21.681Z`.
- `alembic_version` had one row: `0029_whitepaper_embedding_dimension_4096`.
- `information_schema.tables` reported 69 public base tables.
- Largest sampled public tables:
  - `torghut_options_contract_catalog`: about 2,386,113 live rows, autovacuum
    `2026-05-07T02:55:48.218Z`, autoanalyze `2026-05-07T20:52:04.570Z`;
  - `position_snapshots`: about 43,757 live rows, autoanalyze `2026-05-07T19:37:59.106Z`;
  - `execution_tca_metrics`: about 13,775 live rows, autovacuum `2026-05-07T14:24:03.171Z`,
    autoanalyze `2026-05-07T14:24:03.407Z`;
  - options subscription and watermark tables had fresh maintenance within minutes.
- Listing secrets by namespace and listing StatefulSets were forbidden to the current service account. Direct named
  app secret reads and typed service endpoints filled the database witness gap for this pass.

### Source Evidence

- `services/torghut/app/main.py` is 4,214 lines and assembles readiness, health, trading status, proof floor, route
  repair, market context, quant evidence, and API surfaces.
- `services/torghut/app/trading/scheduler/pipeline.py` is 4,413 lines and remains the highest-risk decision pipeline.
- `services/torghut/app/trading/proof_floor.py` is 701 lines, `route_reacquisition.py` is 374 lines, `tca.py` is
  972 lines, and `market_context.py` is 290 lines.
- `services/torghut/app/trading/revenue_repair.py` already builds a repair digest from status and readiness payloads.
- Torghut has 145 Python test files under `services/torghut/tests`.
- Existing tests cover proof-floor blockers, route reacquisition, revenue repair digest, readiness verification,
  TCA, market context, and live submission gates. The missing contract is yield accounting across before/after repair
  attempts, session, revision, and Jangar material-action bonds.

## Problem

Torghut has a repair loop, but the loop is not yet paid by yield.

That matters because the current state contains successful activity without blocker retirement:

1. The promoted image is live.
2. Database schema is current.
3. Provider health for market context is green.
4. Quant latest metrics are fresh.
5. The proof floor still blocks capital because domain evidence is stale, route edge is incomplete, alpha readiness is
   not promotion eligible, and live submit is disabled.

If Torghut treats successful refreshes as progress, it will spend repair budget without moving closer to profitable
capital. If it freezes all repair until every surface is fresh, it wastes the chance to repair no-notional blockers
while the market is closed. The right object is a ledger that measures blocker reduction per repair attempt and per
session.

## Alternatives Considered

### Option A: Increase Refresh Cadence

Run market-context, TCA, quant, and alpha repair more often until the status clears.

Advantages:

- Straightforward operational change.
- Can improve stale surfaces quickly when the issue is cadence.
- Keeps capital closed.

Disadvantages:

- Provider success already occurs without clearing stale domain evidence.
- More cadence can increase cost and load without yield.
- It does not bind repair output to a session or active revision.

Decision: reject as the architecture default. Cadence is one input to yield, not proof of yield.

### Option B: Open Paper On The AAPL Probe After Market Context Refresh

Use AAPL as the first paper repair route once market context turns fresh.

Advantages:

- AAPL is the only probing symbol and has the strongest current route evidence.
- Paper feedback would produce newer execution observations.
- It creates a visible path toward live micro capital.

Disadvantages:

- AAPL still lacks dependency receipts and has slippage above the 8 bps guardrail.
- Alpha readiness has zero promotion-eligible hypotheses.
- Quant stage evidence is empty.
- The Jangar material-action bond for paper is not settled.

Decision: reject. A probing symbol is not a paper symbol.

### Option C: Repair-Yield Ledger With Session-Proof Capital Gates

Measure every no-notional repair by blocker reduction and bind capital gates to session, revision, route, market
context, quant, alpha, and Jangar material-action evidence.

Advantages:

- Separates useful repair from busy repair.
- Makes provider liveness and domain freshness different facts.
- Gives route/TCA repair an explicit before/after score.
- Makes paper and live capital depend on settled session proof instead of stale aggregate proof.

Disadvantages:

- Requires storing and comparing before/after repair snapshots.
- Adds another payload to health and status routes.
- Some repair attempts will visibly score zero, which may frustrate operators.

Decision: select Option C.

## Architecture

Torghut emits:

```text
repair_yield_ledger
  schema_version
  ledger_id
  generated_at
  account_label
  trading_mode
  active_revision
  session_id
  jangar_material_action_bond_id
  before_blockers
  after_blockers
  repair_attempts
  symbol_yield
  aggregate_yield_score
  capital_effect
  next_gate
  rollback_target
```

Each repair attempt includes:

```text
repair_attempt
  attempt_id
  repair_class
  started_at
  completed_at
  revision_ref
  session_id
  target_symbols
  before_receipt_ref
  after_receipt_ref
  before_blockers
  after_blockers
  retired_blockers
  introduced_blockers
  unchanged_blockers
  yield_score
  cost_basis
  capital_effect
  next_repair_action
```

Repair classes:

- `market_context_domain_refresh`
- `execution_tca_recompute`
- `route_symbol_probe`
- `quant_stage_materialization`
- `alpha_readiness_repair`
- `live_submission_authority_check`
- `revision_burn_in_check`

Capital gate output:

```text
session_proof_capital_gate
  gate_id
  account_label
  active_revision
  session_id
  generated_at
  jangar_material_action_bond_id
  repair_yield_ledger_id
  gate_state
  allowed_surface
  blocking_reasons
  required_receipts
  paper_candidate_symbols
  live_micro_candidate_symbols
  max_notional
  rollback_target
```

Gate states:

- `observe_only`
- `zero_notional_repair`
- `paper_hold`
- `paper_candidate`
- `live_micro_hold`
- `live_micro_candidate`
- `live_scale_hold`
- `live_scale_candidate`

## Trading Hypotheses

The ledger must support measurable hypotheses before it can unlock paper:

- H1: A route repair for `NVDA` or `AMD` reduces average absolute slippage below the active guardrail, or retires the
  symbol with a written no-go receipt, within two market sessions.
- H2: Market-context repair clears at least technicals, news, and regime freshness for the active scope symbols within
  one session without relying on provider heartbeat alone.
- H3: Quant stage materialization produces at least one stage receipt for the active account/window and keeps latest
  metrics lag below 120 seconds for a full repair window.
- H4: Alpha readiness repair moves at least one hypothesis to promotion eligible with zero rollback-required blockers
  before paper candidate opens.
- H5: Any paper candidate must carry a Jangar material-action bond whose action class is `paper_canary` and whose
  settlement decision is not held or blocked.

Guardrails:

- Max notional remains `0` for every repair class until the session proof gate reaches `paper_candidate`.
- Provider success alone has yield score `0`.
- A route symbol with missing TCA cannot become paper eligible in the same repair attempt that first creates its TCA.
- A revision less than one readiness window old can only be `observe_only` or `zero_notional_repair`.

## Implementation Scope

Engineer stage:

- Add `services/torghut/app/trading/repair_yield.py`.
- Build the ledger from existing status, readiness, proof-floor, route-reacquisition, market-context, TCA, quant,
  alpha-readiness, empirical, and Jangar material-action evidence.
- Add `repair_yield_ledger` and `session_proof_capital_gate` to `/readyz`, `/trading/health`, and `/trading/status`.
- Extend `services/torghut/app/trading/revenue_repair.py` to include yield score and smallest unblocker.
- Add tests for zero-yield provider success, positive route blocker retirement, unchanged route blockers, quant stage
  receipt gating, alpha readiness gating, revision burn-in, and Jangar bond holds.

Deployer stage:

- Roll out advisory mode first.
- Confirm status payloads include the ledger while max notional stays `0`.
- Run one closed-session and one open-session evidence cycle before considering paper candidate.
- Keep live submit disabled until paper session proof is settled.

## Validation Gates

Local validation:

- `uv run --frozen pytest services/torghut/tests/test_repair_yield.py`
- `uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py`
- `uv run --frozen pytest services/torghut/tests/test_verify_trading_readiness.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Cluster validation:

- `curl -fsS http://torghut.torghut.svc.cluster.local/readyz`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/health`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status`
- Verify `repair_yield_ledger.aggregate_yield_score` is `0` when provider health is green but market-context domains
  remain stale.
- Verify `session_proof_capital_gate.allowed_surface` remains `zero_notional_repair` or lower until route, market,
  quant, alpha, submission, and Jangar bond gates converge.

## Rollout Plan

1. Add payloads in advisory mode.
2. Backfill one in-memory before/after repair snapshot per endpoint response without storing durable history.
3. Add durable repair attempt receipts after the schema is reviewed.
4. Teach Jangar to consume the session proof gate for `paper_canary` and `live_micro_canary`.
5. Enable enforcement for paper candidate only after two consecutive repair windows produce nonzero yield and no
   introduced blockers.

## Rollback Plan

Rollback is safe because the ledger is a stricter advisory layer at first:

- remove enforcement and keep existing proof floor behavior;
- keep live submit disabled;
- keep max notional `0`;
- preserve emitted repair receipts for audit;
- revert to existing route reacquisition and proof-floor status if the ledger mis-scores a blocker.

If a nonzero-yield repair later proves false, mark the attempt `invalidated`, return the gate to
`zero_notional_repair`, and require a new before/after receipt for the same blocker.

## Risks And Mitigations

- Risk: the ledger becomes another status blob without changing behavior.
  Mitigation: paper/live gates must cite `repair_yield_ledger_id` and `session_proof_capital_gate.gate_id`.
- Risk: yield scoring rewards small cosmetic changes.
  Mitigation: score only retired blockers or measured guardrail improvements, not successful job completion.
- Risk: closed-session repair creates evidence that looks fresh but is not tradable.
  Mitigation: bind every repair attempt to `session_id` and require open-session confirmation for paper.
- Risk: route repair focuses on high-volume symbols while ignoring missing symbols.
  Mitigation: score missing-symbol bootstrap separately and prohibit same-attempt paper graduation.

## Handoff Contract

Engineer acceptance gates:

- The three Torghut status routes emit `repair_yield_ledger` and `session_proof_capital_gate`.
- Provider heartbeat success with stale domains produces zero market-context yield.
- Route, quant, alpha, and live-submission repairs have explicit before/after tests.
- The reducer is pure and does not perform network calls or database writes.

Deployer acceptance gates:

- Advisory output is visible for at least one closed-session and one open-session cycle.
- Max notional remains `0` until paper candidate gates settle.
- Every no-go cites one repair attempt, one unchanged blocker, and one next repair action.
- Jangar paper/live material-action bonds are settled before Torghut opens any capital surface.
