# 179. Torghut Capital Repair Frontier And Route Yield Clearance (2026-05-08)

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

I am selecting a **capital repair frontier with route yield clearance** for Torghut.

The current live system is healthy enough to observe and repair, but it is not profitable enough to promote. On
2026-05-08 at 02:24Z, live Torghut revision `torghut-00292` was running and `/db-check` returned HTTP 200 with
`ok=true`, schema head `0029_whitepaper_embedding_dimension_4096`, and lineage ready. Live `/readyz` returned HTTP 503
`degraded` for the right reason: Postgres, ClickHouse, Alpaca, universe, database, empirical jobs, and quant evidence
were readable, while live submission was disabled and the proof floor was `repair_only` with `zero_notional` capital.

The route evidence is actionable. Live TCA had 7334 orders and 7245 filled executions, average absolute slippage of
about 13.82 bps, and latest execution evidence from 2026-04-02 while TCA was recomputed on 2026-05-07. AAPL was the
only probing symbol with 2033 orders and about 9.25 bps average absolute slippage. NVDA, AMD, INTC, and AVGO were
blocked above the guardrail. AMZN, GOOGL, and ORCL had no route samples. The proof floor named the capital blockers:
`hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and `simple_submit_disabled`.
Empirical jobs were fresh and truthful, but zero hypotheses were promotion-eligible and two required rollback.

The decision is to make Torghut choose repair work by expected capital yield, not by whichever blocker is loudest. A
capital repair frontier will score candidate repairs by expected unblock value, expected slippage improvement, evidence
cost, Jangar clearance state, and notional risk. A route yield clearance packet then states what sample or repair can
run, what capital class it may unlock, what evidence budget it can spend, and what stops it. Jangar's failure-debt
frontier is an upstream input: no paper or live capital can clear when Jangar source settlement, controller authority,
observer rights, or material action debt is held.

The tradeoff is slower capital reentry for a route that looks locally close, especially AAPL. I accept that. A route
with 9.25 bps slippage is a useful repair candidate, not a capital license. The profitable system should buy the
cheapest evidence that can close a blocker and should stop before paying live notional for an unsettled route.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Runtime Evidence

- Torghut live `torghut-00292` and sim `torghut-sim-00391` pods were running.
- Torghut namespace events showed the latest live and sim revisions had startup/readiness probe failures followed by
  `RevisionReady`.
- ClickHouse, keeper, CNPG, options catalog/enricher, TA, TA sim, websocket, and guardrail exporter pods were running.
- The namespace retained an errored `torghut-whitepaper-autoresearch-profit-target` pod from 13 hours earlier.
- Torghut events repeatedly warned that ClickHouse pods matched multiple PodDisruptionBudgets, and the keeper PDB had
  no matching pods. This is availability and rollout debt, not capital permission.
- Agents retained intermittent market-context job failures while current Jangar and Torghut cron jobs were still
  completing.

### Data And Profit Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, `schema_graph_lineage_ready=true`, and known parent-fork warnings for
  historical `0010` and `0015` branches.
- Live `/readyz` returned `status=degraded`, with `postgres`, `clickhouse`, `alpaca`, `database`, `universe`, and
  `empirical_jobs` healthy. `live_submission_gate` failed with `simple_submit_disabled`.
- Live proof floor was `repair_only`, route state was `repair_only`, capital state was `zero_notional`, and max
  notional was `0`.
- Live route summary covered 8 symbols: 0 routeable, 1 probing, 4 blocked, and 3 missing.
- Live repair candidates ranked `NVDA`, `AMD`, `INTC`, `AVGO`, `AMZN`, `GOOGL`, and `ORCL`, with expected unblock
  value 14.
- Live TCA average absolute slippage was about 13.82 bps. AAPL had 2033 orders at about 9.25 bps. NVDA had 3289
  orders at about 13.48 bps, AMD 823 at about 14.93 bps, INTC 66 at about 20.57 bps, and AVGO 1123 at about
  21.86 bps. AMZN, GOOGL, and ORCL had no route samples.
- Sim `/readyz` was `ok`, but sim proof floor was still `repair_only`, capital state was `zero_notional`, and sim TCA
  had only 5 filled executions at about 110.16 bps average absolute slippage.

### Source Evidence

- `services/torghut/app/main.py` has 4222 lines and already joins proof floor, route reacquisition, TCA, empirical
  jobs, quant evidence, market context, and database readiness. New capital scoring should live in a pure module.
- `services/torghut/app/trading/proof_floor.py` has 718 lines and already fails closed on live submit disabled, alpha
  readiness gaps, route universe gaps, quant/TCA evidence, and slippage breaches.
- `services/torghut/app/trading/route_reacquisition.py` has 374 lines and already builds repair candidates from proof
  floor dimensions.
- `services/torghut/app/trading/jangar_continuity.py` has 223 lines and already consumes Jangar continuity and source
  rollout truth. It is the right integration path for the new Jangar failure-debt frontier.
- Torghut has broad tests around proof floor, route reacquisition, trading API, submission council, and Jangar
  continuity. The next implementation should add a focused pure reducer test file rather than expanding route tests
  first.

## Problem

Torghut can now explain why capital is blocked. It still needs a capital repair frontier that chooses the next repair
by expected yield.

The current profitability failure modes are:

1. AAPL is close to a paper guardrail but still above the strict 8 bps target and lacks promotion-eligible hypothesis
   receipts.
2. NVDA, AMD, INTC, and AVGO have route samples, but their slippage breaches need repair budgets and stop conditions.
3. AMZN, GOOGL, and ORCL have no route samples, so promotion should buy bounded evidence before even considering
   paper.
4. Fresh empirical jobs can coexist with zero promotion-eligible hypotheses.
5. Sim readiness can be `ok` while sim route proof is not useful enough for capital because the route universe is empty
   and slippage is about 110 bps.
6. Jangar can allow observation while holding material action classes, so Torghut must discount or block capital when
   upstream clearance is not settled.

The profitable system should rank repairs by the chance that the next bounded sample clears a capital gate.

## Alternatives Considered

### Option A: Promote AAPL To Paper First

Use AAPL as the paper canary because it has the deepest current sample set and the lowest live slippage among scoped
symbols.

Advantages:

- Fastest way to get a paper observation.
- Uses existing route data.
- Small implementation surface.

Disadvantages:

- AAPL still misses the strict 8 bps paper target.
- Alpha readiness has zero promotion-eligible hypotheses.
- Jangar material action and capital clearance are not settled.

Decision: reject for immediate paper capital. AAPL should be the first high-priority repair candidate, not a capital
promotion.

### Option B: Run Broad Route Sample Minting For Every Symbol

Collect fresh route samples across all scoped symbols before any capital gate.

Advantages:

- Improves coverage quickly.
- Simple batch operator workflow.
- Helps stale TCA and missing-symbol gaps.

Disadvantages:

- Expensive and noisy.
- Does not account for expected unblock value.
- Can spend provider capacity on symbols that still lack alpha or Jangar clearance.

Decision: reject as the default. Broad minting is a fallback after the frontier proves capacity and priority.

### Option C: Capital Repair Frontier And Route Yield Clearance

Score each repair packet by expected capital yield, evidence cost, route risk, alpha readiness, and Jangar clearance.
Only the highest-yield repair packets run, and they carry explicit no-notional or paper-safe budgets.

Advantages:

- Converts blockers into a ranked portfolio of evidence purchases.
- Keeps capital zero while improving future option value.
- Makes upstream Jangar debt a first-class capital discount.
- Gives the deployer clear paper and live gates.

Disadvantages:

- Adds a new reducer and payload shape.
- Requires careful score calibration so repair priority is understandable.
- Slower than direct paper promotion.

Decision: select Option C.

## Architecture

Torghut adds a pure `capital_repair_frontier` reducer. It consumes proof floor, route reacquisition, TCA, alpha
readiness, empirical jobs, market context, quant evidence, and Jangar action reentry cells.

```text
capital_repair_frontier
  frontier_id
  generated_at
  account_label
  torghut_revision
  jangar_frontier_ref
  proof_floor_ref
  capital_state
  route_yield_packets
  held_capital_classes
  next_safe_action
  rollback_target
```

Each packet states why the repair is worth doing and what it is allowed to spend:

```text
route_yield_clearance_packet
  packet_id
  symbol
  current_route_state          # missing | blocked | probing | routeable
  repair_class                 # sample_mint | slippage_repair | alpha_repair | context_repair | quant_repair
  expected_unblock_value
  expected_slippage_delta_bps
  evidence_cost_class          # low | medium | high
  jangar_action_decision
  alpha_promotion_state
  tca_sample_count
  current_avg_abs_slippage_bps
  target_avg_abs_slippage_bps
  capital_class_candidate      # observe | zero_notional_repair | paper_probe | live_micro | live_scale
  max_notional
  stop_conditions
  rollback_target
```

Scoring starts simple and explicit:

```text
route_yield_score =
  expected_unblock_value
  + expected_slippage_delta_bps
  - evidence_cost_penalty
  - upstream_jangar_debt_penalty
  - alpha_readiness_penalty
  - capital_risk_penalty
```

Capital rules:

- `observe` is allowed when the route and data projections are readable.
- `zero_notional_repair` is allowed when the packet cannot submit notional and Jangar allows observe or repair.
- `paper_probe` requires Jangar paper clearance, paper-safe route sample count, average absolute slippage below 8 bps,
  no alpha rollback requirement, current market context, and quant stage proof beyond informational.
- `live_micro` requires paper settlement, live submit explicitly enabled, average absolute slippage below 12 bps, and
  Jangar live micro clearance.
- `live_scale` requires repeated live micro settlement, no active proof-floor blocker, no stale quant evidence, and
  Jangar live scale clearance.

## Measurable Hypotheses

- H1: AAPL repair can reduce average absolute slippage from about 9.25 bps to below 8 bps before any paper probe.
- H2: NVDA and AMD repairs can reduce average absolute slippage below 12 bps faster than creating first samples for
  all missing symbols.
- H3: INTC and AVGO should stay zero-notional until slippage improves below 12 bps or they are excluded from the active
  capital universe.
- H4: Missing samples for AMZN, GOOGL, and ORCL can each reach at least 20 paper-safe samples without breaching
  12 bps average absolute slippage.
- H5: At least one hypothesis must move from shadow or blocked to paper-eligible with no rollback-required state
  before paper notional.
- H6: Jangar material clearance must be `allow` for the matching capital class before Torghut increases notional.

## Guardrails

- `max_notional=0` while proof floor is `repair_only`.
- Any packet with `jangar_action_decision=hold` or `block` cannot exceed zero-notional repair.
- Missing route samples create sample-mint work, not live orders.
- A fresh TCA recomputation does not count as new route evidence when latest execution recency is stale.
- Sim evidence cannot promote live capital unless it has route coverage and slippage inside the same guardrails.
- Reducer failure fails closed to `observe` or `zero_notional_repair`.

## Implementation Scope

Engineer stage:

- Add `services/torghut/app/trading/capital_repair_frontier.py` as a pure reducer.
- Feed it from existing proof-floor, route-reacquisition, TCA, alpha readiness, empirical, market-context, quant, and
  Jangar continuity payloads.
- Expose the frontier from `/readyz` and `/trading/status` in shadow mode.
- Add `services/torghut/tests/test_capital_repair_frontier.py` covering AAPL probing, four high-slippage symbols,
  three missing symbols, sim route emptiness, missing Jangar clearance, alpha rollback, and live submit disabled.
- Keep proof floor authoritative for capital until the frontier matches it over at least one full market session.

Deployer stage:

- Wire Jangar `action_reentry_frontier` into the Torghut status payload.
- Run one shadow session where route yield packets are emitted but no new notional is allowed.
- Approve only zero-notional repairs until the frontier emits a positive paper gate and Jangar paper clearance agrees.
- Record every paper or live promotion with packet ID, proof-floor ref, Jangar frontier ref, and rollback target.

## Validation Gates

Local validation:

- `uv run --frozen pytest services/torghut/tests/test_profitability_proof_floor.py`
- `uv run --frozen pytest services/torghut/tests/test_route_reacquisition.py`
- `uv run --frozen pytest services/torghut/tests/test_jangar_continuity.py`
- New frontier tests cover scoring, capital gates, and fail-closed behavior.

Live validation:

- Torghut `/db-check` is `ok=true`, schema current, and lineage ready.
- Torghut `/readyz` may remain degraded while proof floor is repair-only, but it exposes the frontier in shadow mode.
- The frontier ranks AAPL and the high-volume blocked symbols ahead of broad missing-symbol refresh unless Jangar or
  alpha penalties change the score.
- Capital remains zero while proof floor is repair-only or Jangar clearance is held.
- Paper is not allowed until route slippage, alpha readiness, quant evidence, market context, and Jangar paper
  clearance converge.

## Rollout

1. Ship the frontier in shadow mode with no capital behavior changes.
2. Compare packet ranking with proof-floor repair ladder and route sample mint output for one market session.
3. Enable zero-notional repair packet dispatch when Jangar observe or repair clearance is allowed.
4. Enable paper packet consideration only after Jangar paper clearance and local route/alpha gates agree.
5. Enable live micro and live scale only after paper settlement and live submit operator approval.

## Rollback

- Disable frontier enforcement and keep proof floor authoritative.
- Keep frontier projection visible for debugging.
- Revert to route sample mint and proof-floor repair ladder for zero-notional work ordering.
- Keep live submission disabled while proof floor is repair-only, Jangar clearance is held, or reducer output is
  missing.

## Risks And Open Questions

- Scoring can overfit one snapshot. Mitigation: start with simple transparent terms and keep per-symbol explanations.
- Repair packets can consume provider capacity without clearing capital. Mitigation: require expected unlock and stop
  conditions on every packet.
- AAPL may look close enough to paper and still fail due to alpha or Jangar holds. That is expected and should be
  visible in packet penalties.
- Jangar frontier integration is new. Torghut must fail closed when the upstream frontier is absent.

## Handoff Contract

Engineer acceptance gates:

- Pure frontier reducer is implemented with tests for each route state and capital class.
- `/readyz` and `/trading/status` expose the shadow frontier without changing proof-floor enforcement.
- Frontier packets carry packet ID, proof-floor ref, Jangar frontier ref, capital candidate, max notional, stop
  conditions, and rollback target.
- Reducer failures preserve zero-notional capital.

Deployer acceptance gates:

- Jangar frontier refs are present before paper or live promotion.
- One shadow market session completes with packet ranking recorded.
- Capital notional remains zero while proof floor is repair-only or upstream clearance is held.
- Any paper or live promotion cites a packet ID and has a documented rollback target.
