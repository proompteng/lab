# 176. Torghut Revision-Priced Route Frontier And Capital Carry (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut route repair, proof-floor capital holds, market-context retry spend, Jangar revision carry
consumption, paper admission, live promotion, and rollback.

Companion Jangar contract:

- `docs/agents/designs/172-jangar-revision-carry-ledger-and-source-to-serving-action-bonds-2026-05-08.md`

Extends:

- `175-torghut-failure-costed-context-repair-and-route-custody-2026-05-08.md`
- `174-torghut-continuity-priced-route-repair-market-and-capital-holds-2026-05-08.md`
- `172-torghut-repair-yield-ledger-and-session-proof-capital-gates-2026-05-07.md`
- `docs/agents/designs/171-jangar-terminal-debt-exchange-and-retry-custody-2026-05-08.md`

## Decision

I am selecting a **revision-priced route frontier with capital carry** for Torghut.

Torghut is operationally reachable but not promotable. On 2026-05-08 at 01:09Z, `/db-check` was ok with Alembic head
`0029_whitepaper_embedding_dimension_4096`, Postgres and ClickHouse were healthy, Alpaca was reachable, the Jangar
universe cache had 8 scoped symbols, and the live and sim Knative revisions were available. That is enough to observe
and repair.

It is not enough to spend capital. `/readyz` returned HTTP 503 degraded. The profitability proof floor was
`repair_only`, capital state was `zero_notional`, live submission was disabled, alpha readiness had 3 hypotheses with
0 promotion eligible and 2 rollback required, and route evidence had 1 probing symbol, 4 blocked symbols, and 3
missing symbols. Market context was informational because the market was closed, but recent provider jobs showed both
fresh completions and fresh failures across `INTC`, `AMZN`, and `AMD`.

The decision is to price route repair by the Jangar revision that produced the evidence. A Torghut route cannot move
from repair to paper because its latest context retry completed. It can move only when the context receipt, TCA route
receipt, alpha readiness receipt, proof-floor receipt, and Jangar revision carry epoch all agree that the evidence was
produced by a source-settled control-plane revision. Until that happens, Torghut should use repair spend to buy the
highest expected unblock value under zero notional.

The tradeoff is slower paper reentry after rapid Jangar promotions. I accept that. Profitability improves when Torghut
does not pay for context repair or route probes that will be invalidated by a superseded control-plane image, missing
source ref, or unsettled controller handoff.

## Success Metrics

Success means:

- Torghut emits `revision_priced_route_frontier` in shadow mode beside the route reacquisition board.
- Every route frontier record contains `symbol`, `state`, `jangar_revision_carry_ref`, `torghut_revision_ref`,
  `market_context_receipt_ref`, `execution_tca_receipt_ref`, `alpha_readiness_ref`, `proof_floor_ref`,
  `expected_unblock_value`, `expected_repair_cost`, `revision_carry_discount`, `net_repair_priority`,
  `paper_probe_notional_limit`, and `rollback_target`.
- Repairs produced by a Jangar epoch below `material_ready` are observe-only unless the packet is explicitly
  zero-notional and evidence-preserving.
- Fresh market-context completion cannot override route TCA failure, alpha failure, simple submit disabled, or missing
  Jangar revision carry.
- Missing or blocked symbols are ranked by expected edge after revision carry, not just by provider retry recency.
- Paper and live notional stay at zero until proof floor, source-settled Jangar carry, and route-local receipts all
  converge.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Cluster And Runtime Evidence

- Torghut live revision `torghut-00291-deployment` and sim revision `torghut-sim-00390-deployment` were available.
- Torghut Postgres, ClickHouse, keeper, websocket, options catalog, options enricher, live TA, sim TA, and supporting
  exporters were running.
- Recent Torghut events showed repeated `MultiplePodDisruptionBudgets` warnings for ClickHouse pods, `NoPods` for the
  keeper PodDisruptionBudget, and Flink status update conflicts for `torghut-options-ta`.
- Agents namespace events showed old market-context provider failures for `INTC`, `AMZN`, and `ORCL`, followed by
  recent completions for `INTC`, `AMZN`, and `AMD` on the current Jangar schedule-runner image.
- The four Torghut quant cron schedules were active and recently completed on the current Jangar image.

### Data And Profitability Evidence

- `/readyz` returned HTTP 503 with proof floor `repair_only`, route state `repair_only`, capital state
  `zero_notional`, and blockers `hypothesis_not_promotion_eligible`,
  `execution_tca_route_universe_incomplete`, and `simple_submit_disabled`.
- The proof floor showed 3 hypotheses, 0 promotion-eligible hypotheses, 2 rollback-required hypotheses, and reason
  totals including missing feature rows, missing drift checks, unavailable required feature sets, and slippage budget
  breaches.
- Route TCA had 8 scoped symbols: `AAPL` probing, `AMD`, `AVGO`, `INTC`, and `NVDA` blocked, and `AMZN`, `GOOGL`, and
  `ORCL` missing.
- The repair ladder ranked live submit closure, route universe repair, alpha readiness repair, execution TCA repair,
  feature coverage, drift governance, and next-open market context verification.
- `/db-check` returned `ok=true`; schema current heads matched expected head `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage remained ready with warnings for known parent forks at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.

### Source Evidence

- `services/torghut/tests/test_profitability_proof_floor.py` already covers market-context pass, stale, closed-session
  informational hold, route blockers, alpha blockers, and proof-floor repair ladder behavior.
- `services/torghut/tests/test_route_reacquisition.py` covers market-context receipt presence, stale receipt blocking,
  route candidates, and repair candidate rankings.
- `services/torghut/tests/test_market_context.py` covers required context, stale context, low quality, degraded last
  good, and domain errors.
- `services/jangar/src/server/torghut-market-context-agents.ts` is 2032 lines and already knows provider failures,
  active runs, cooldowns, stale snapshots, and dispatch state.
- The missing source contract is not another provider retry check. It is a Torghut consumer check that discounts route
  repair value when the Jangar revision carry epoch is not source-settled.

## Problem

Torghut's current repair board can say which route or context dependency is missing, stale, blocked, or probing. It
does not yet say whether the evidence belongs to a settled control-plane revision.

That matters because route repair is not free:

1. Provider retries spend budget and can produce receipts from a Jangar image that is already superseded.
2. Route TCA repairs can look promising while simple submit is still disabled and alpha has no promotion-eligible
   hypothesis.
3. Market-closed context staleness can be informational, while fresh Kubernetes provider failures are stronger debt.
4. A completed context retry under an unsettled Jangar revision can make a route appear closer to paper than it is.
5. Missing Jangar source/GitOps refs should reduce the capital value of every downstream receipt until carry is
   source-settled.

Torghut needs to rank route repair by expected edge after revision carry, not by raw evidence recency.

## Alternatives Considered

### Option A: Keep Route Reacquisition As The Main Repair Board

Continue ranking route repair by TCA state, market-context state, alpha readiness, and proof-floor blockers.

Advantages:

- Uses the current implementation and tests.
- Gives a clear symbol-level board.
- Keeps Jangar coupling low.

Disadvantages:

- Does not know whether receipts came from source-settled Jangar authority.
- Can overvalue fresh context completions produced during rollout churn.
- Does not price old runner or missing source debt.

Decision: keep the board, but make revision-priced frontier the capital-facing projection.

### Option B: Freeze All Torghut Repair During Jangar Rollouts

Suspend market-context retry and route repair while Jangar revision carry is below `material_ready`.

Advantages:

- Simple and conservative.
- Avoids producing evidence from unsettled images.
- Easy rollback story.

Disadvantages:

- Stops zero-notional repairs that are useful and evidence-preserving.
- Misses market-window opportunities to refresh context or run simulation probes.
- Treats all repair spend as equally risky.

Decision: reject as the default. Freeze is useful only when carry cannot be computed.

### Option C: Revision-Priced Route Frontier

Keep observe and zero-notional repair running, but discount or block each route's capital value based on the Jangar
revision carry state and the receipts that route depends on.

Advantages:

- Preserves useful repair while preventing false capital readiness.
- Prices provider retry cost against expected unblock value.
- Gives Jangar one downstream contract for capital carry.
- Makes route candidates robust to rollout churn and missing source refs.

Disadvantages:

- Adds one more proof dimension to Torghut promotion logic.
- Requires tests that model Jangar carry states and source-ref absence.
- Requires deployers to inspect revision carry before paper probes.

Decision: select Option C.

## Architecture

Torghut adds a `revision_priced_route_frontier` projection. It consumes the existing proof floor, route reacquisition
book, market-context repair packet, and Jangar revision carry epoch.

```text
revision_priced_route_record
  symbol
  account_label
  state                         # blocked | missing | probing | repair_candidate | paper_candidate
  jangar_revision_carry_ref
  jangar_carry_state
  torghut_revision_ref
  market_context_receipt_ref
  execution_tca_receipt_ref
  alpha_readiness_ref
  proof_floor_ref
  expected_unblock_value
  expected_repair_cost
  revision_carry_discount
  net_repair_priority
  paper_probe_notional_limit
  rollback_target
```

Capital state rules:

- `observe`: always allowed when Jangar route health and Torghut dependencies are healthy enough to read.
- `zero_notional_repair`: allowed when Jangar carry is at least `observe_only` and the repair packet is
  evidence-preserving.
- `paper_candidate`: requires Jangar `material_ready`, proof floor at least paper-ready, fresh context and route
  receipts, no alpha rollback requirement, and simple submit still explicitly controlled.
- `live_candidate`: requires Jangar `capital_ready`, paper settlement, live submit enablement, and route-local
  slippage under guardrail.

Repair priority:

```text
net_repair_priority =
  expected_unblock_value
  - expected_repair_cost
  - revision_carry_discount
  - terminal_debt_discount
```

Missing source/GitOps refs in Jangar should make `revision_carry_discount` large enough that no paper/live route
candidate can graduate, while still allowing observe-only repair when notional is zero.

## Implementation Scope

Engineer stage:

- Add a Torghut parser for Jangar `revision_carry_ledger` in the trading control-plane client.
- Extend route reacquisition or proof-floor projection with `revision_priced_route_frontier`.
- Add tests for Jangar carry states `observe_only`, `repair_only`, `material_ready`, and `capital_ready`.
- Add tests proving fresh market-context receipts under `repair_only` carry remain zero-notional.
- Add tests proving source-ref absence or old runner carry debt prevents paper/live candidate graduation.

Deployer stage:

- Verify Jangar revision carry after each Jangar or Agents rollout before treating new Torghut receipts as capital
  evidence.
- Keep route repairs zero-notional while proof floor is `repair_only` or Jangar carry is below `material_ready`.
- Prefer repairs with high expected unblock value after carry discount: route universe, alpha readiness, and TCA
  settlement before low-value context refreshes in closed sessions.

## Validation Gates

Required local validation:

- `bunx oxfmt --check docs/agents/designs/172-jangar-revision-carry-ledger-and-source-to-serving-action-bonds-2026-05-08.md docs/torghut/design-system/v6/176-torghut-revision-priced-route-frontier-and-capital-carry-2026-05-08.md docs/torghut/design-system/v6/index.md`

Required engineer validation:

- Proof-floor tests show `repair_only` remains zero-notional when Jangar carry is below `material_ready`.
- Route frontier tests show `AAPL`-style probing routes do not become paper candidates without Jangar material-ready
  carry.
- Market-context tests show fresh provider completion cannot override route TCA, alpha readiness, or simple submit
  blockers.
- Trading readiness tests include a required Jangar revision carry ref for paper/live modes.

Required deployer validation:

- Capture `/readyz`, `/db-check`, Jangar control-plane status, and the route frontier after each rollout.
- Confirm no paper probe is scheduled while `paper_probe_notional_limit` is `0`.
- Confirm live submission remains disabled unless Jangar carry is `capital_ready` and proof floor has graduated.

## Rollout Plan

1. Emit route frontier in shadow mode with no capital behavior change.
2. Add the Jangar carry ref to route repair and proof-floor diagnostics.
3. Use frontier ranking for zero-notional repair scheduling.
4. Require `material_ready` carry before any paper candidate is exposed.
5. Require `capital_ready` carry before live micro canary or scale candidates are exposed.

## Rollback

- Disable route frontier enforcement and keep the projection visible.
- Continue using current proof floor and route reacquisition blockers.
- Keep capital at zero notional while proof floor is `repair_only` or simple submit is disabled.
- Do not replay receipts produced under a rejected Jangar carry epoch as promotion evidence.

## Risks

- Jangar carry refs may be absent during early rollout. Torghut must treat absence as a capital hold, not as a reason
  to drop useful observe-only repair.
- Route frontier could over-discount repair during high rollout cadence. The discount should be action-aware so cheap
  context observation can continue while capital stays held.
- Profitability may look slower in the short term because fewer routes become paper candidates. That is the intended
  effect until route edge, alpha readiness, and source-settled control-plane evidence converge.

## Handoff To Engineer And Deployer

Engineer acceptance gate: expose a revision-priced route frontier that consumes Jangar carry and proves zero-notional
repair, paper candidate, and live candidate transitions with tests.

Deployer acceptance gate: never treat fresh context or TCA receipts as capital evidence unless they cite a Jangar
revision carry epoch at the required state.

Rollback gate: if the frontier blocks unexpectedly, disable enforcement only, keep the projection, and keep Torghut
capital at zero notional until the cited Jangar carry epoch is repaired.
