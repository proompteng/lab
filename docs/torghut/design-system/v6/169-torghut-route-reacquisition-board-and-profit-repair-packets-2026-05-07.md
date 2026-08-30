# 169. Torghut Route Reacquisition Board And Profit Repair Packets (2026-05-07)

Status: Accepted for engineer and deployer handoff

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


## Decision

I am selecting a **route reacquisition board backed by Jangar proof repair packets** as the next Torghut profitability
architecture step.

Torghut is running, but it is not capital-ready. Live revision `torghut-00284` and sim revision `torghut-sim-00384`
are ready, Postgres and ClickHouse health checks pass, schema head `0029_whitepaper_embedding_dimension_4096` is
current, and Alpaca reports the live account active. That is not enough. `/trading/health` returns HTTP 503 and
`status=degraded` because the live submission gate is closed, profit proof floor is `repair_only`, capital is
`zero_notional`, market context is stale, alpha readiness has zero promotion-eligible hypotheses, scoped quant health
is missing stages, and execution TCA route universe is incomplete.

The board makes repair work measurable. Torghut will not ask for capital because a service is up. It will ask for a
bounded repair packet tied to a route, hypothesis, account, window, and expected profit effect. The board consumes
Jangar packet IDs, ranks repair candidates by expected unblock value, and emits receipts that can retire packets:
routeability receipts, market-context receipts, scoped quant-stage receipts, TCA recalibration receipts, and alpha
promotion receipts. Capital remains zero notional until those receipts prove that a route has fresh data, routeable
symbols, acceptable post-cost execution, and a hypothesis that survived paper rehearsal.

The tradeoff is slower capital reentry. The board will keep live submission disabled even when broker, database, and
universe checks are healthy. I accept that because the current proof floor already shows the safer posture:
zero-notional repair work is the correct state while routeability and context are incomplete.

## Success Metrics

Success means:

- `/trading/health` and `/trading/status` emit `route_reacquisition_board`.
- Each board row cites a Jangar `proof_packet_id`, route symbol, account label, proof window, current blocker, repair
  action, expected unblock value, success receipt, and capital effect.
- The current universe of eight symbols is partitioned into `routeable`, `probing`, `blocked`, `missing`, and
  `retired` states.
- A repair action can move a symbol from `missing` or `blocked` to `probing` only through fresh market context, scoped
  quant stages, and a TCA receipt.
- Paper rehearsal remains zero notional until at least one symbol has route TCA within guardrail, market-context
  freshness under 300 seconds, scoped quant stages present, and a linked hypothesis with paper edge receipt.
- Live capital remains closed until promotion eligibility is nonzero, rollback-required hypotheses are cleared, and
  Jangar dependency quorum is not blocking on empirical jobs.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07.

### Cluster And Runtime Evidence

- Torghut pods were running for live, sim, ClickHouse, Keeper, TA, TA sim, options catalog, options enricher,
  WebSocket, and guardrail exporters. One retained whitepaper autoresearch pod remained in `Error`.
- Live `torghut-00284-deployment` and sim `torghut-sim-00384-deployment` were both `1/1`.
- Recent Torghut events showed startup and readiness probe failures during revision turnover, followed by revision
  readiness and virtual service updates.
- Jangar agents namespace still had retained failures: 38 `Error` pods and 14 failed jobs, plus a current verify pod
  missing expected ConfigMaps.

### Data Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, no missing/unexpected heads, and one schema branch. It still
  reports parent-fork warnings in the migration graph, which are acceptable only while lineage is ready.
- `/trading/status` reported active revision `torghut-00284`, live mode, signal continuity as expected market-closed
  staleness, `running=true`, and last run at `2026-05-07T21:24:18Z`.
- TCA summary covered 7334 orders with average absolute slippage about 13.82 bps, 7245 filled executions, latest
  execution on `2026-04-02T19:00:29Z`, and zero unsettled executions.
- Route evidence over the eight-symbol universe showed one probing symbol, four blocked symbols, and three missing
  symbols. Missing symbols were `AMZN`, `GOOGL`, and `ORCL`; blocked symbols included `AMD`, `AVGO`, `INTC`, and
  `NVDA`.
- `/trading/health` reported profit floor `repair_only`, capital `zero_notional`, `market_context_stale`,
  `execution_tca_route_universe_incomplete`, `hypothesis_not_promotion_eligible`, and `simple_submit_disabled`.
- Jangar typed quant health for `account=paper&window=1d` had zero latest metrics and no stages. Torghut's configured
  15-minute quant evidence had latest metrics but still no stages, so it is informational rather than a capital
  receipt.

### Source Evidence

- `services/torghut/app/main.py` already builds `/trading/health`, `/trading/status`, proof floor, route reacquisition
  book, TCA summaries, database contract checks, and dependency health.
- `services/torghut/app/trading/submission_council.py` already consumes the typed Jangar quant health endpoint and
  distinguishes `quant_pipeline_stages_missing`, `quant_latest_metrics_empty`, and `quant_health_degraded`.
- `services/torghut/app/trading/autonomy/lane.py` is 7377 lines and owns high-leverage promotion, evidence, rollback,
  and profitability artifacts. The board should consume its receipts rather than embedding new promotion policy in the
  FastAPI route.

## Problem

Torghut has a good holdback but not a strong enough repair market. The current payload says capital is zero notional
and names blockers, but it does not yet create a prioritized, packet-backed set of repairs with measurable profit
hypotheses.

The platform needs to distinguish:

1. A route that is blocked by bad TCA.
2. A route that is missing TCA history.
3. A route that has acceptable execution but lacks market context and alpha proof.
4. A hypothesis that is blocked by stale empirical jobs.
5. A candidate that should remain retired because repair cost exceeds expected edge.

Without this board, repair work can become a queue of broad reruns. Broad reruns spend compute and operator attention
without saying which packet they retire or how they increase the chance of profitable capital reentry.

## Alternatives Considered

### Option A: Refresh All Evidence Feeds

Rerun empirical jobs, market context, quant metrics, TCA settlement, and hypothesis checks in bulk.

Advantages:

- Simple operator model.
- Likely clears some stale data.
- Does not require new route contracts.

Disadvantages:

- Expensive and unfocused.
- Does not rank repair by expected unblock value.
- Does not tie repair work to Jangar runtime packets.
- Can refresh evidence without improving routeability or profit.

Decision: useful as an emergency repair, but not the six-month architecture.

### Option B: Open Paper Probes For Every Missing Symbol

Use zero or tiny notional paper probes for `AMZN`, `GOOGL`, and `ORCL`, then let TCA and market data catch up.

Advantages:

- Directly attacks missing route evidence.
- Produces concrete data.
- Easy to explain to traders.

Disadvantages:

- Can create low-quality data without context or hypothesis backing.
- Does not repair blocked high-activity symbols such as `NVDA`, `AMD`, and `AVGO`.
- Does not handle stale empirical jobs or quant stage gaps.

Decision: a board action, not the primary architecture.

### Option C: Packet-Backed Route Reacquisition Board

Rank route and hypothesis repairs by Jangar packet, expected unblock value, repair cost, and capital effect.

Advantages:

- Converts broad blockers into measurable repairs.
- Prevents capital release without fresh receipts.
- Gives Jangar a consumer for proof packets.
- Lets Torghut optimize for profit per repair rather than number of reruns.
- Keeps rollback simple: retire, requeue, or fail one packet.

Disadvantages:

- Requires new status fields and tests.
- Needs discipline around expected-unblock scoring.
- Some repairs will stay zero notional longer than traders may want.

Decision: select Option C.

## Architecture

### RouteReacquisitionBoard

Torghut emits:

```text
route_reacquisition_board
  schema_version
  generated_at
  account_label
  trading_mode
  active_revision
  jangar_broker_ref
  capital_state
  market_session_open
  rows
  summary
  rollback_target
```

Each row includes:

```text
route_reacquisition_row
  proof_packet_id
  symbol
  hypothesis_id
  state
  current_blocker
  repair_action
  expected_unblock_value
  expected_cost_class
  expected_profit_effect
  required_receipts
  current_receipts
  capital_effect
  notional_limit
  rollback_trigger
```

States:

- `missing`: no usable route or TCA receipt.
- `blocked`: route exists but fails a guardrail.
- `probing`: enough proof exists for zero-notional or paper rehearsal.
- `routeable`: route proof is fresh and within guardrail.
- `capital_eligible`: routeable plus alpha and dependency receipts are satisfied.
- `retired`: repair cost or risk exceeds expected profit effect.

### Required Receipts

Minimum receipts before `probing`:

- Jangar packet state `bounded_repair_allowed`.
- Fresh market-context receipt for the symbol or its hypothesis family.
- Scoped quant-stage receipt for the account/window.
- TCA settlement receipt or simulation-probe receipt.
- Rollback target that keeps live submission disabled.

Minimum receipts before `capital_eligible`:

- Jangar packet state `settled`.
- Execution TCA average absolute slippage under the configured route guardrail.
- Promotion-eligible hypothesis count greater than zero.
- Rollback-required hypothesis count zero for the participating route.
- Jangar dependency quorum not blocked by empirical jobs.
- Profitability proof floor state `capital_eligible` or stricter successor.

## Measurable Trading Hypotheses

The board starts with explicit hypotheses:

- Repairing the four blocked high-history symbols (`NVDA`, `AMD`, `AVGO`, `INTC`) has higher expected unblock value
  than probing missing symbols because they already have filled execution history.
- Missing-symbol probes for `AMZN`, `GOOGL`, and `ORCL` should not receive paper notional until simulation produces
  TCA and market-context receipts.
- A route with average absolute slippage above 12 bps should stay blocked unless a new TCA settlement proves a narrower
  route.
- A stale market-context receipt should hold paper rehearsal even when TCA is fresh.
- A scoped quant store with no stages should stay informational; it cannot be a capital receipt.

## Implementation Scope

Engineer stage should:

- Add the board payload to `/trading/health` and `/trading/status`.
- Consume Jangar `proof_settlement_broker.proof_packets` when configured; otherwise emit `jangar_packet_missing`
  informational rows and keep capital closed.
- Normalize current route reacquisition data into board rows.
- Add tests for blocked, missing, probing, routeable, retired, and capital-eligible states.
- Keep live submission disabled unless the proof floor and board both allow capital.

## Validation Gates

Required local validation:

- Targeted Torghut route/status tests for the board states and packet consumption.
- Existing trading health tests still pass.
- `bunx oxfmt --check docs/agents/designs/165-jangar-proof-settlement-broker-and-profit-repair-packet-gates-2026-05-07.md docs/torghut/design-system/v6/169-torghut-route-reacquisition-board-and-profit-repair-packets-2026-05-07.md docs/torghut/design-system/v6/index.md`

Required deployer validation:

- `/trading/health` shows `route_reacquisition_board.capital_state=zero_notional` until receipts are fresh.
- Board summary reproduces the current partition: one probing symbol, four blocked symbols, and three missing symbols,
  or explains any changed partition with fresh receipts.
- No route moves to `capital_eligible` while Jangar dependency quorum is `block`.
- Repair attempts cite one Jangar proof packet and emit one success or failure receipt.

## Rollout

1. **Observe-only**: emit board rows without changing submission behavior.
2. **Repair-only**: allow repairs that cite one Jangar packet and keep notional zero.
3. **Paper rehearsal**: allow paper rehearsal only for `probing` rows with fresh market context, scoped quant stages,
   and TCA/simulation receipts.
4. **Capital reentry**: allow capital only for `capital_eligible` rows and only after Jangar broker packets are settled.

## Rollback

Rollback is simple:

- Disable board enforcement and keep the payload in observe-only mode.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` and capital zero notional.
- Mark in-flight board rows `retired` or `blocked` if their Jangar packet expires or is contradicted.
- Revert to the current proof floor holdbacks if board generation fails.

## Risks

- Expected unblock value can become a vanity score. It must be backed by route history, hypothesis state, and receipt
  freshness.
- Paper probes can create misleading data if run without market context. Require context receipts before probing.
- Jangar packet fetch failures must not fail open. Missing packets are informational for visibility and blocking for
  capital.
- Routeability can improve while alpha readiness remains blocked. The board must keep those states separate.

## Handoff To Engineer

Implement the board as a read model first. The first regression should start from the current degraded state: zero
notional, one probing symbol, four blocked symbols, three missing symbols, market context stale, quant stages missing,
and Jangar dependency quorum blocked. The expected output is a board that permits no capital, ranks repairs, and names
the Jangar packet required to retire each blocker.

## Handoff To Deployer

Deploy observe-only, compare the board summary with `/trading/health` proof floor and TCA details, then enable
repair-only mode. Do not enable paper or live capital until route rows have fresh receipts and Jangar packets are
settled.
