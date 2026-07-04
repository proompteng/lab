# 164. Torghut Zero-Notional Route Repair Packets And Paper Rehearsal (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Torghut profitability, zero-notional route repair, paper rehearsal readiness, Jangar split-authority repair
packets, execution TCA, market-context freshness, validation, rollout, rollback, and acceptance gates.

Companion Jangar contract:

- `docs/agents/designs/160-jangar-split-authority-repair-escrow-and-dispatch-reentry-packets-2026-05-07.md`

Extends:

- `163-torghut-repair-outcome-attribution-and-capital-reentry-slo-2026-05-07.md`
- `162-torghut-profit-evidence-refill-and-capital-route-reentry-2026-05-07.md`
- `159-torghut-capital-cohort-frontier-and-routeability-repair-board-2026-05-07.md`
- `158-torghut-route-reacquisition-and-market-context-repair-cells-2026-05-07.md`

## Decision

I am selecting zero-notional route repair packets and paper rehearsal as the next Torghut profitability architecture
step.

Torghut is correctly closed for capital. Live readiness returns degraded/503, live proof floor is `repair_only`, capital
state is `zero_notional`, simple submit is disabled, market context is stale, and live routeability has zero routeable
symbols. Simulation is operational, but it is also repair-only and zero-notional: `NVDA` is probing, seven symbols are
missing, quant latest metrics are empty, market context is stale, and alpha readiness has zero promotion-eligible
hypotheses.

The opportunity is not to trade. The opportunity is to make route repair measurable enough that paper reentry can be
earned without leaking live notional. Torghut should consume Jangar split-authority repair packets as the authority for
zero-notional repair work, then publish paper rehearsal receipts only after routeability, TCA, market context, quant,
and alpha blockers retire.

The tradeoff is slower paper reentry. I accept that. A fast paper run with stale market context, missing route receipts,
and no Jangar repair packet would only create more ambiguous evidence. Repair work should be profitable because it
removes a priced blocker, not because it produces another run artifact.

## Runtime Objective And Success Metrics

Success means:

- `/trading/health`, `/trading/status`, and `/trading/autonomy` expose `zero_notional_route_repair_packets`.
- Each packet cites a Jangar `split_authority_repair_escrow.packet_ref`.
- Every packet names a target blocker: `execution_tca_route_universe_empty`,
  `execution_tca_route_universe_incomplete`, `execution_tca_symbol_missing`, `market_context_stale`,
  `quant_latest_metrics_empty`, `quant_pipeline_stages_missing`, or `hypothesis_not_promotion_eligible`.
- Live and simulation repair packets keep `max_notional=0` and `live_submit_enabled=false`.
- Paper rehearsal stays closed until at least two routeable or probing symbols have fresh TCA, market context receipt,
  quant receipt, alpha receipt, and Jangar packet closure.
- Live micro-canary remains blocked until paper rehearsal has clean zero-notional exits and Jangar `paper_canary`
  reentry is no longer held.
- Deployer output ranks repair work by expected unblock value, blocker age, and capital risk.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 from 18:18Z to 18:28Z. I did not mutate Kubernetes resources, database
records, ClickHouse data, broker state, GitOps resources, AgentRun objects, or trading flags.

### Runtime And Cluster Evidence

- Torghut live revision `torghut-00276-deployment` was `1/1` and simulation revision `torghut-sim-00376-deployment`
  was `1/1`.
- Older Knative revisions were scaled to zero.
- Torghut app, options catalog, and options enricher were on the latest promoted Torghut digest.
- Torghut TA and TA simulation had recently restarted and reached `RUNNING`.
- Recent Torghut events included startup/readiness probe refusals during rollout and multiple ClickHouse PDB match
  warnings.
- `torghut-whitepaper-autoresearch-profit-target-8r6w6` remained in `Error`.
- Direct Torghut database exec was blocked by RBAC from the `agents-sa` service account.

### Live Data Evidence

- Live `/trading/health` returned HTTP 503 when called with `curl -f`, and the non-failing payload reported
  `status=degraded`.
- Live Postgres, ClickHouse, Alpaca live account `PA3SX7FYNUTF`, Jangar universe, readiness cache, and broker status
  were healthy.
- Live submission gate was closed with `simple_submit_disabled`, capital stage `shadow`, and live submit disabled.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and max notional `0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`.
- Live TCA had 7334 orders, 7245 filled executions, latest TCA around 2026-05-07T14:23Z, average absolute slippage
  about 13.82 bps, guardrail 8 bps, zero routeable symbols, five blocked symbols, and three missing symbols.
- Live blocked symbols were AAPL, AMD, AVGO, INTC, and NVDA. Missing symbols were AMZN, GOOGL, and ORCL.
- Live quant evidence for `PA3SX7FYNUTF/15m` had 144 latest metrics updated around 18:25Z, no pipeline stages, and a
  missing update alarm.

### Simulation Data Evidence

- Simulation `/trading/health` returned `status=ok`, but proof floor remained `repair_only` and capital state
  `zero_notional`.
- Simulation route state was `repair_only` with one probing symbol, `NVDA`, seven missing symbols, and zero routeable
  symbols.
- Simulation TCA had average absolute slippage about 5.58 bps for NVDA, but TCA freshness was stale relative to the
  configured threshold and route universe coverage was incomplete.
- Simulation quant evidence for `TORGHUT_SIM/15m` had zero latest metrics, no stages, and an empty latest store alarm.
- Simulation market context was stale.
- Alpha readiness had three shadow hypotheses, zero promotion-eligible hypotheses, and three rollback-required
  hypotheses.

### Source Evidence

- `services/torghut/app/trading/proof_floor.py` owns proof-floor dimensions, blocker lists, repair ladders, and
  capital state.
- `services/torghut/app/trading/route_reacquisition.py` ranks route repair candidates and records missing, probing,
  blocked, and routeable symbol states.
- `services/torghut/app/trading/submission_council.py` consumes Jangar control-plane status and quant evidence before
  submission decisions.
- `services/torghut/app/trading/revenue_repair.py` can score repair value from proof-floor and status payloads, but it
  does not yet bind a repair item to a Jangar split-authority packet.
- Existing tests cover proof floor, route reacquisition, submission policy, quant readiness, trading API readiness, and
  revenue repair digests. The missing regression surface is zero-notional repair packet creation and paper rehearsal
  closure.

## Problem

Torghut has a ranked repair ladder, but not a packet-level contract that says which zero-notional repair is authorized
under Jangar's current split authority. Without that contract, route repair can become either too timid or too loose:
too timid because no repair is allowed while Jangar is split, or too loose because repair work can look like paper
readiness before the blocker actually retires.

The capital risk is clear:

1. Live routeability is zero, so live notional must stay zero.
2. Simulation has only one probing symbol and stale dependency receipts, so paper rehearsal cannot be promoted yet.
3. Market context and empirical jobs are stale, so any route edge is missing explanatory context.
4. Quant metrics exist for live but lack pipeline stages; simulation has no latest metrics at all.
5. Jangar currently holds paper and live classes, so Torghut must not infer paper authority from local repair progress.

## Alternatives Considered

### Option A: Run The Best Simulation Paper Probe Now

Pros:

- Fast feedback from the one probing `NVDA` path.
- Uses simulation health while live remains closed.
- Could produce more TCA data quickly.

Cons:

- Simulation still has seven missing symbols, empty quant metrics, stale market context, and no promotion-eligible
  hypotheses.
- Jangar paper is held.
- The probe would blur repair evidence with paper-readiness evidence.

Decision: reject. `NVDA` is a repair candidate, not a paper authority.

### Option B: Keep All Route Repair Closed Until Jangar Fully Converges

Pros:

- Very safe for capital and operations.
- No new payloads or reducers.
- Avoids coordinating with Jangar split authority.

Cons:

- Prevents zero-notional repair of the blockers that keep paper closed.
- Lets stale market context and missing symbols age further.
- Makes profitability depend on waiting instead of measurable repair.

Decision: reject. The right posture is zero-notional repair, not total inactivity.

### Option C: Add Zero-Notional Route Repair Packets And Paper Rehearsal Gates

Pros:

- Keeps capital closed while allowing measurable repair work.
- Binds each repair to Jangar packet authority and Torghut blocker delta.
- Separates repair candidate evidence from paper readiness.
- Produces a ranked handoff for market context, quant, TCA, and alpha repair.

Cons:

- Adds a reducer and status payload.
- Requires repair jobs to name their blocker before execution.
- Paper reentry remains delayed until receipts close.

Decision: select Option C.

## Architecture

Add a pure reducer named `zero_notional_route_repair_packets` under `services/torghut/app/trading/`.

Inputs:

- Profitability proof floor.
- Route reacquisition book.
- Execution TCA summary.
- Market-context freshness.
- Quant evidence status.
- Alpha readiness.
- Live submission gate.
- Jangar split-authority repair escrow packet.
- Jangar repair outcome ledger, when available.

Output shape:

```text
zero_notional_route_repair_packets
  generated_at
  account_label
  trading_mode
  jangar_packet_ref
  capital_state
  live_submit_enabled
  packet_state              # open, held, blocked, expired
  packets[]
    packet_id
    repair_class
    target_blocker
    symbol
    before_ref
    required_after_ref
    expected_unblock_value
    max_notional
    paper_rehearsal_limit
    rollback_trigger
    expires_at
  paper_rehearsal_gate
    state                   # closed, rehearsal_ready, blocked
    required_receipts[]
    missing_receipts[]
    candidate_symbols[]
    rollback_target
```

Repair classes:

- `route_tca_refresh`
- `route_universe_fill`
- `market_context_refresh`
- `quant_pipeline_stage_refill`
- `alpha_readiness_repair`
- `empirical_job_refresh`
- `submission_gate_recheck`

Trading hypotheses:

- AAPL and NVDA are first live route repair candidates because they have the largest evidence base, but both stay
  zero-notional until average absolute slippage is inside the 8 bps guardrail and market-context/quant receipts exist.
- AMZN, GOOGL, and ORCL are missing-live-symbol repair candidates; success means they move from missing to probing with
  zero notional and fresh context, not that they enter paper.
- Simulation NVDA is a rehearsal candidate only after stale TCA, market context, quant, and alpha receipts are closed.
- Any candidate that improves TCA while market context remains stale is `executed_but_not_capital_relevant`.

## Engineer Implementation Scope

1. Add the pure reducer and unit tests for live zero-routeable, simulation probing, missing-symbol, stale-context,
   stale-quant, expired-Jangar-packet, and paper-rehearsal-ready cases.
2. Expose the payload from `/trading/health`, `/trading/status`, and `/trading/autonomy`.
3. Feed the Jangar packet ref through existing control-plane status consumption.
4. Add revenue-repair digest support so packets appear in ranked repair output.
5. Keep live submission and notional unchanged.
6. Add tests proving paper rehearsal remains closed when Jangar `paper_canary` is held.

## Validation Gates

- `pytest services/torghut/tests/test_trading_api.py -k zero_notional_route_repair_packets`
- `pytest services/torghut/tests/test_route_reacquisition.py -k repair_packet`
- `pytest services/torghut/tests/test_revenue_repair.py -k repair_packet`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.zero_notional_route_repair_packets'`
- `curl -fsS http://torghut-sim.torghut.svc.cluster.local/trading/status | jq '.zero_notional_route_repair_packets'`
- Confirm every packet has `max_notional=0`.
- Confirm paper rehearsal is closed while Jangar `paper_canary` is held or blocked.

## Rollout Plan

1. Shadow: publish packets with no submission or scheduler behavior change.
2. Warn: include packets in revenue-repair digests and deployer status.
3. Enforce repair labeling: zero-notional repair jobs must name a packet and target blocker.
4. Paper rehearsal gate: allow rehearsal readiness only after packet closure and required receipts.
5. Live gate remains closed in this architecture stage.

## Rollback Plan

- Disable packet enforcement with `TORGHUT_ZERO_NOTIONAL_REPAIR_PACKET_ENFORCEMENT=false`.
- Continue emitting proof floor, route reacquisition book, and revenue repair digest.
- Keep live submit disabled and max notional zero.
- If packet ranking is wrong, remove it from deployer output but keep raw proof-floor blockers visible.
- If paper rehearsal opens early, force `paper_rehearsal_gate.state=blocked` until the reducer is fixed.

## Risks

- False progress: a symbol can move from missing to probing without capital relevance. The packet must require receipts
  before paper rehearsal.
- Stale TCA: simulation NVDA looks better than live, but stale TCA and missing context make it non-authoritative.
- Jangar coupling: packets depend on Jangar split-authority escrow. Torghut must degrade to repair-held when the Jangar
  packet is absent or expired.
- RBAC limits: direct database inspection is blocked from this lane; endpoint-derived schema and freshness evidence
  must cite that limitation.

## Handoff Contract

Engineer acceptance:

- The packet reducer is pure and covered by targeted tests.
- Live and simulation endpoints expose packet state in shadow mode.
- Packets always carry zero notional and explicit target blockers.
- Paper rehearsal tests prove Jangar paper hold keeps Torghut rehearsal closed.

Deployer acceptance:

- Live remains HTTP 503/degraded until proof floor closes.
- Live submit remains disabled and capital remains zero-notional.
- Repair ranking lists route, market-context, quant, and alpha blockers with packet refs.
- Paper rehearsal is not considered ready until Jangar packet closure and Torghut blocker receipts agree.
