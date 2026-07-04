# 174. Torghut Continuity-Priced Route Repair Market And Capital Holds (2026-05-08)

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

I am selecting a **continuity-priced route repair market with capital holds** for Torghut.

The current Torghut state is not a live-capital state. On 2026-05-08 at 00:10Z, `/healthz` reported ok, but
`/readyz` and `/trading/health` were degraded. Postgres, ClickHouse, Alpaca, scheduler, universe, and empirical jobs
were ok. The degraded state came from the capital path: live submission was disabled, the profitability proof floor
was `repair_only`, capital state was `zero_notional`, alpha readiness had 3 hypotheses with 0 promotion-eligible and 2
rollback-required, and route TCA was incomplete.

That is not wasted evidence. It is a repair market. The proof floor already named the highest-value work:
`repair_route_universe`, `repair_alpha_readiness`, `repair_execution_tca`, `repair_feature_coverage`, and
`repair_drift_governance`. The route reacquisition board already split the universe into 1 probing symbol, 4 blocked
symbols, and 3 missing symbols. What is missing is a hard consumer rule: no route repair packet can admit paper probes
or live capital unless it cites a fresh Jangar continuity epoch and its own route, market-context, quant, and alpha
receipts.

The tradeoff is that Torghut stays zero-notional longer. I accept that. The goal is not to make the dashboard greener;
the goal is to spend repair work on the routes most likely to recover profitable, executable hypotheses without
allowing stale Jangar or stale route evidence to sneak into capital authority.

## Success Metrics

Success means:

- Torghut emits `continuity_priced_route_repair_market` in shadow mode.
- Every route repair packet contains `packet_id`, `account_label`, `symbol`, `state`, `current_blocker`,
  `expected_unblock_value`, `expected_cost_class`, `expected_profit_effect`, `required_receipts`,
  `jangar_continuity_epoch_id`, `paper_probe_notional_limit`, `max_notional`, and `rollback_target`.
- `paper_probe_notional_limit` remains `0` while Jangar continuity is missing, proof floor is `repair_only`, or alpha
  readiness has no promotion-eligible hypotheses.
- Route repair ranking prefers high expected unblock value with bounded cost, not simply the highest historical fill
  count.
- Market-closed stale context can remain informational, but stale context cannot become a paper/live bypass.
- A live submission gate cannot open until the route packet cites a fresh Jangar continuity epoch and a passing proof
  floor.

## Evidence Snapshot

All evidence was collected read-only.

### Cluster And Runtime Evidence

- Torghut namespace deployments were available for the active Knative live and sim revisions, TA jobs, options
  services, websocket services, ClickHouse, and Postgres.
- `torghut-db-1` and `jangar-db-1` were both `1/1 Running`; service-account access could list pods but could not list
  CNPG cluster custom resources.
- `/healthz` returned `status=ok`.
- `/readyz` returned `status=degraded`.
- `/trading/health` returned `status=degraded`.

### Data And Profit Evidence

- `/db-check` reported `ok=true`, current Alembic head `0029_whitepaper_embedding_dimension_4096`, and no missing or
  unexpected heads.
- Schema lineage was ready, with warnings for known parent forks after revisions
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Proof floor state was `repair_only`; route state was `repair_only`; capital state was `zero_notional`.
- Proof floor blockers were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and
  `simple_submit_disabled`.
- Alpha readiness had 3 hypotheses, state totals `blocked=1` and `shadow=2`, 0 promotion-eligible hypotheses, and 2
  rollback-required hypotheses.
- Execution TCA covered 7,334 orders and 7,245 filled executions, but aggregate slippage exceeded the 8 bps guardrail.
- Route TCA had 8 scope symbols: 1 probing, 4 blocked, 3 missing, and 0 capital-eligible symbols.
- AAPL was probing but still zero-notional because dependency receipts blocked capital.
- NVDA, AMD, INTC, and AVGO were blocked by route evidence. AMZN, GOOGL, and ORCL were missing route evidence.
- Market context was degraded but market-closed staleness was informational in the proof floor; it still named stale
  technicals, fundamentals, news, and regime domains.
- Quant evidence had 144 latest rows for the sampled account/window and a 57 second metrics lag, but no pipeline
  stages were present, so it remained informational.

### Source Evidence

- `services/torghut/app/trading/proof_floor.py` is 718 lines and already builds dimension-level proof receipts and a
  repair ladder.
- `services/torghut/app/trading/route_reacquisition.py` is 374 lines and already builds route reacquisition state.
- `services/torghut/app/trading/submission_council.py` is 1,202 lines and gates submission on quant health, alpha
  readiness, market context, promotion certificates, and live submission settings.
- `services/torghut/app/trading/hypotheses.py` is 791 lines and owns the runtime hypothesis readiness model.
- Tests already cover proof floor, route reacquisition, submission council, market context, hypotheses, quant
  readiness, and trading readiness. The missing test surface is the Jangar continuity dependency on route repair
  packets.

## Problem

Torghut has repair evidence but not enough continuity authority. A route can look attractive because it has historical
fills or a high expected unblock value, while Jangar is still proving source/leader/watch continuity and Torghut is
still missing alpha or route receipts.

That creates two bad outcomes:

1. Repair work can be scheduled without a clear profit denominator.
2. Paper/live capital can be tempted by partial evidence when the system should stay zero-notional.

The repair system needs to price work, but capital admission must remain pinned to complete receipts.

## Alternatives Considered

### Option A: Keep Zero-Notional Until Everything Is Green

Do not run route repair or paper rehearsals until all proof floor dimensions pass.

Advantages:

- Simple and safe.
- No accidental capital exposure.

Disadvantages:

- Leaves the highest-value repair work unordered.
- Makes no distinction between a missing route receipt and a low-cost receipt settlement.
- Slows profitability recovery.

Decision: reject as the normal operating model.

### Option B: Let Torghut Repair Locally Without Jangar Continuity

Use Torghut proof floor and route reacquisition alone. Treat Jangar continuity as informational.

Advantages:

- Faster local iteration.
- Less dependency on Jangar implementation work.

Disadvantages:

- Reintroduces source/control-plane ambiguity into paper and live decisions.
- Gives no deployer proof that the Jangar control plane was stable during the route repair window.
- Lets route repair packets drift from the system that owns material action authority.

Decision: reject for paper/live admission. Local observe-only simulation can continue.

### Option C: Continuity-Priced Route Repair Market

Rank route repair packets by expected value and cost, but require a fresh Jangar continuity epoch before any packet can
move beyond zero-notional observe or simulation.

Advantages:

- Keeps capital safe.
- Makes repair work economically ordered.
- Gives Jangar a clear consumer contract.
- Lets Torghut improve profitability by spending on the repairs most likely to unblock executable routes.

Disadvantages:

- Requires Torghut to store a Jangar continuity ref.
- Adds a new admission reason when the Jangar epoch is missing or stale.
- Keeps paper probes closed during Jangar continuity gaps.

Decision: select Option C.

## Architecture

Torghut emits a route repair packet for each symbol/account/window that could plausibly recover executable profit.

```text
route_repair_packet
  schema_version
  packet_id
  generated_at
  account_label
  symbol
  state
  current_blocker
  expected_unblock_value
  expected_cost_class
  expected_profit_effect
  required_receipts
    tca_route_receipt
    market_context_receipt
    quant_pipeline_receipt
    alpha_readiness_receipt
    jangar_continuity_epoch
  paper_probe_notional_limit
  max_notional
  rollback_target
```

The packet reducer applies these rules:

1. If `jangar_continuity_epoch` is missing, stale, or not action-grade, `paper_probe_notional_limit=0`.
2. If proof floor is not `pass`, `max_notional=0`.
3. If alpha readiness has no promotion-eligible hypotheses, packets can be ranked but cannot admit capital.
4. If route TCA is missing, the packet state is `missing` and the next action is simulation or TCA backfill.
5. If route TCA fails guardrails, the packet state is `blocked` and the next action is route evidence repair.
6. If only low-cost receipts are missing and Jangar continuity is fresh, the packet can move to `paper_candidate` with
   zero live notional and an explicit paper rehearsal budget.

## Implementation Scope

Engineer stage:

- Add a nullable `jangar_continuity_epoch_id` and `jangar_continuity_decision` to route repair packet output.
- Extend proof floor and route reacquisition tests to cover missing, stale, and fresh Jangar continuity.
- Add a Torghut readiness reason `jangar_continuity_epoch_missing` that blocks paper/live but not observe-only repair.
- Keep market-closed context as informational only when the hypothesis dependency set allows it.
- Require route packets to carry receipts before they can become paper candidates.

Deployer stage:

- Roll out in shadow mode.
- Confirm current state remains zero-notional.
- Confirm AAPL remains probing, not capital-eligible, until Jangar continuity and receipt settlement are present.
- Confirm NVDA, AMD, INTC, AVGO, AMZN, GOOGL, and ORCL remain repair candidates with paper limits at 0.

## Validation Gates

Local validation:

- `bunx oxfmt --check docs/agents/designs/170-jangar-continuity-witness-ledger-and-attested-dispatch-packets-2026-05-08.md docs/torghut/design-system/v6/174-torghut-continuity-priced-route-repair-market-and-capital-holds-2026-05-08.md docs/agents/README.md docs/torghut/design-system/v6/index.md`
- Targeted Torghut tests after implementation:
  - `pytest services/torghut/tests/test_profitability_proof_floor.py`
  - `pytest services/torghut/tests/test_route_reacquisition.py`
  - `pytest services/torghut/tests/test_submission_council.py`
  - `pytest services/torghut/tests/test_verify_trading_readiness.py`

Cluster validation:

- `/trading/health` must expose route repair packets in shadow mode.
- Current proof floor remains `repair_only` and capital state remains `zero_notional`.
- Missing Jangar continuity creates a blocking paper/live reason without blocking observe-only repair.
- A fresh Jangar continuity epoch can remove only the Jangar continuity blocker; it must not override alpha, TCA,
  market-context, or submission-gate blockers.

## Rollout

1. Emit route repair packets in shadow mode.
2. Add dashboard rows for expected unblock value, cost class, Jangar continuity state, and paper notional limit.
3. Keep live submission disabled until proof floor passes and Jangar continuity is fresh.
4. Allow only observe-only repair and zero-notional paper rehearsals until route packets carry all required receipts.
5. Promote enforcement only after the Jangar continuity ledger is stable across deploy cycles.

## Rollback

- If packet generation fails, keep the existing proof floor and submission council decisions.
- If Jangar continuity is unavailable, treat it as a paper/live hold and continue observe-only repair.
- If paper packet admission misclassifies a route, set `paper_probe_notional_limit=0` and require route evidence
  repair before reentry.
- If proof floor and packet state disagree, proof floor wins and capital remains zero-notional.

## Handoff To Engineer

Start with packet output and tests. Do not wire paper admission to the new packet until missing, stale, and fresh
Jangar continuity are covered by tests.

## Handoff To Deployer

Treat this contract as a capital hold, not a launch plan. The first successful deployment is one where current route
repair work becomes clearer while live submission remains disabled and every route still has `max_notional=0` until
receipts close.
