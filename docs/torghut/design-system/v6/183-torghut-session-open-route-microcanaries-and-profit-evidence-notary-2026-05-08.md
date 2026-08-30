# 183. Torghut Session-Open Route Microcanaries And Profit Evidence Notary (2026-05-08)

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

I am selecting **session-open route microcanaries with a profit evidence notary** as Torghut's next architecture step.

The current system is safe but revenue-inactive. At 2026-05-08T08:12Z, live Torghut was serving active revision
`torghut-00302` on runtime commit `809276e6db88bf4546f3fc6c75bd16c54815fb1d`, with Postgres and ClickHouse dependency
checks passing through the application. The live proof floor was still `repair_only`, `capital_state=zero_notional`,
`max_notional=0`, and live submission was blocked by `simple_submit_disabled`. That is the right capital safety posture.

The profit problem is that route evidence and scoped quant evidence are not strong enough to justify even paper
graduation. Live route/TCA had 7,334 orders and 7,245 filled executions, but average absolute slippage was about
13.82 bps against an 8 bps guardrail. One route was only probing (`AAPL`), four were blocked (`AMD`, `AVGO`, `INTC`,
`NVDA`), and three were missing (`AMZN`, `GOOGL`, `ORCL`). The sim lane was worse: route universe empty, NVDA slippage
about 110 bps, and seven missing symbols. Alpha readiness had three hypotheses, zero promotion-eligible hypotheses, and
two rollback-required hypotheses on live.

The selected design does not loosen thresholds to make routeable count look better. It creates a bounded paper-only
microcanary system that can repair the top route evidence gaps at the next market-open window. A route can move from
missing or blocked to probing only after the notary has fresh scoped quant health, market-context receipt, TCA receipt,
consumer-evidence route receipt, and Jangar session-auction admission. Live notional remains zero until proof floor,
alpha readiness, route/TCA, and capital gates pass.

The tradeoff is slower paper activation. I accept that because the current slippage evidence says broad threshold
loosening would turn a readiness problem into a trading-quality problem. Torghut needs more routeable post-cost evidence,
not just more routeable labels.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, trading flags, or GitOps
manifests.

### Runtime And Cluster Evidence

- Argo CD reported `torghut`, `torghut-options`, and `symphony-torghut` as `Synced` and `Healthy`.
- Active Torghut image digest was `sha256:056d6b0bc237adec3e3aa5e89a3f08ee81523ec18d8374c4a4e7d072e436f0f3`.
- Live deployment `torghut-00302-deployment`, sim deployment `torghut-sim-00400-deployment`, options catalog, options
  enricher, TA, websocket, Postgres, ClickHouse, and Keeper pods were running.
- A stale failed job remained: `torghut-whitepaper-autoresearch-profit-target-8r6w6` from 2026-05-07T12:39Z.
- The recent empirical retention job completed, but the empirical promotion job was older than the active proof repair
  window.
- Options catalog and enricher `/healthz` and `/readyz` returned ready; the enricher had a fresh success timestamp.

### Trading And Proof Evidence

- Live `/healthz` returned `status=ok`.
- Live `/readyz` returned `status=degraded`.
- Live `/trading/status` reported:
  - mode `live`, pipeline `simple`, execution lane `simple`;
  - live submission not allowed, reason `simple_submit_disabled`;
  - proof floor `repair_only`, route state `repair_only`, capital state `zero_notional`, max notional `0`;
  - alpha readiness: three hypotheses, zero promotion-eligible, two rollback-required;
  - quant ingestion informational state `quant_pipeline_degraded`, scoped window `15m`;
  - market-context informational state with expected market-closed staleness;
  - empirical proof pass for candidate `chip-paper-microbar-composite@execution-proof` and dataset
    `torghut-chip-full-day-20260505-4c330ce9-r1`.
- Live route/TCA reported 7,334 orders, 7,245 filled executions, average absolute slippage
  `13.8203637593029676` bps, guardrail `8` bps, route slippage guardrail `12` bps, one probing route, four blocked
  routes, and three missing routes.
- Sim `/readyz` returned `status=ok`, but sim proof remained `repair_only` with route universe empty, zero routeable
  symbols, one blocked NVDA route, seven missing symbols, and average absolute slippage about `110.162997276` bps.

### Database And Data Evidence

- Live and sim `/db-check` reported schema head `0029_whitepaper_embedding_dimension_4096`, current and expected head
  counts equal to one, and no missing or unexpected migration heads.
- The schema graph still reports known parent-fork warnings around execution provenance/governance and whitepaper
  workflow branches, but lineage readiness is true.
- Account-scope readiness checks are bypassed while multi-account mode is disabled.
- Direct observer access to deeper database state is limited: CNPG pod exec is forbidden for this service account,
  secrets cannot be listed, and ClickHouse HTTP requires credentials. That is acceptable for this design because the
  first implementation milestone must rely on application receipts, not direct DB mutation.

## Problem

Torghut has enough safety evidence to hold capital, but not enough route-specific evidence to create profit.

Current blockers are concrete:

1. Live submission is intentionally disabled.
2. Proof floor is `repair_only`.
3. Alpha readiness has no promotion-eligible hypotheses.
4. Scoped quant proof is degraded even when unscoped Jangar quant health is fresh.
5. Route/TCA quality is above guardrail for most active symbols.
6. Sim route evidence is too sparse to support paper graduation.
7. Direct database inspection is not guaranteed for observer agents, so receipts must be sufficient.

The system needs to create new evidence without weakening capital safety. The smallest useful move is not live trading.
It is paper-only route microcanaries that can convert missing/blocked routes into fresh, post-cost evidence while live
notional remains zero.

## Alternatives Considered

### Option A: Loosen Slippage Thresholds To Increase Routeable Count

Raise route slippage guardrails so more symbols become routeable immediately.

Advantages:

- Fastest apparent improvement in `routeable_candidate_count`.
- Low implementation effort.
- Easy to explain on a dashboard.

Disadvantages:

- Current aggregate slippage is already above guardrail.
- It weakens `fill_tca_or_slippage_quality`.
- It risks authorizing paper or live work from worse execution evidence.

Decision: reject. Routeable count that buys itself with worse slippage is not profit evidence.

### Option B: Wait For The Large Profit Escrow Runtime PR

Hold this lane until #5412 or equivalent large runtime work lands.

Advantages:

- Avoids intermediate architecture.
- Lets a broad profit-escrow system solve multiple problems together.
- Keeps current capital safety unchanged.

Disadvantages:

- Leaves today's healthy cluster without a smaller proof-repair milestone.
- The large path has review and diff-size risk.
- It does not force next-session route repair to be measured by value gate deltas.

Decision: reject as the only plan. The large PR may still matter, but it should not block scoped proof repair.

### Option C: Session-Open Route Microcanaries With Profit Evidence Notary

At the next market-open window, Torghut runs bounded paper-only route probes for top repair candidates admitted by
Jangar's session evidence auction. The notary records every required receipt and keeps live notional at zero.

Advantages:

- Creates fresh route evidence without live capital risk.
- Targets the exact blockers shown by current proof floor.
- Improves routeable evidence only when scoped quant, TCA, market context, consumer evidence, and Jangar admission are
  present.
- Gives deployers a small rollback surface.

Disadvantages:

- Requires new receipt and notary plumbing.
- Produces slower visible progress than threshold changes.
- Depends on next market-open data quality.

Decision: select Option C.

## Architecture

Torghut owns a `session_open_profit_evidence_notary`:

```text
session_open_profit_evidence_notary
  notary_id
  generated_at
  fresh_until
  account_label
  trading_mode
  serving_revision
  source_commit
  image_digest
  market_session
  jangar_session_epoch_id
  consumer_evidence_receipt_id
  scoped_quant_receipt_id
  market_context_receipt_id
  tca_receipt_id
  alpha_readiness_receipt_id
  proof_floor_state
  capital_state
  max_live_notional
  admitted_microcanaries[]
  rejected_microcanaries[]
  rollback_target
```

Each `route_microcanary` contains:

```text
route_microcanary
  microcanary_id
  symbol
  account_label
  hypothesis_ids
  current_route_state
  target_route_state
  paper_notional_limit
  live_notional_limit
  expected_unblock_value
  expected_cost_bps
  required_receipts
  stop_conditions
  success_conditions
  decision
```

Admission rules:

- `live_notional_limit` is always `0` while proof floor is `repair_only`.
- Paper notional is `0` until consumer evidence, scoped quant, market context, TCA, alpha, and Jangar session receipts
  are present and fresh.
- A missing symbol can run a paper probe only after sim creates a route/TCA receipt for that symbol.
- A blocked symbol can run a paper probe only if the proposed repair names why the prior slippage exceeded guardrail
  and how the microcanary will stop before worsening average absolute slippage.
- A probing symbol can graduate only when post-cost paper evidence improves without breaching slippage or freshness
  budgets.
- Threshold changes require a separate risk waiver and cannot authorize live notional.

## Measurable Trading Hypotheses

H1: Route microcanaries increase routeable or probing candidates without weakening TCA quality.

- Baseline: live has one probing route and zero fully routeable capital candidates; sim has zero routeable routes.
- Target: at least three symbols move from missing or blocked to probing across two market sessions.
- Guardrail: average absolute slippage for admitted probes stays at or below the configured route guardrail, or the
  notary retires the probe.

H2: Scoped quant receipt repair reduces stale-evidence holds.

- Baseline: unscoped Jangar quant health is fresh, but live scoped proof reports `quant_pipeline_degraded` and sim
  scoped proof reports `quant_latest_metrics_empty`.
- Target: scoped account/window quant receipt exists for live and sim before any paper probe runs.
- Guardrail: paper and live notional remain zero while scoped quant proof is missing or stale.

H3: Paper route repair beats newest-error repair.

- Baseline: repair candidates are ranked by route/TCA and expected unblock value, but scheduler work can still drift to
  newest failures.
- Target: top-ranked repair candidates produce a higher next-session probing count than newest-error selection.
- Guardrail: no probe may bypass alpha readiness, consumer evidence, or Jangar session admission.

H4: Capital safety remains intact.

- Baseline: live submission is blocked by `simple_submit_disabled`, proof floor is `repair_only`, and max notional is
  zero.
- Target: every notary receipt preserves live max notional `0` until proof floor passes.
- Guardrail: any receipt that moves live notional above zero while proof floor is `repair_only` is invalid and triggers
  rollback.

## Implementation Scope

Engineer milestone 1: observe-only receipts.

- Add a Torghut notary builder that composes proof floor, route reacquisition board, consumer evidence, scoped quant
  health, market context, and TCA state.
- Expose it through `/trading/status` and a dedicated `/trading/session-evidence-notary` endpoint.
- Add tests for degraded scoped quant, route slippage breach, sim route universe empty, missing direct DB observer
  access, and zero live notional.

Engineer milestone 2: paper-only microcanary planner.

- Add a planner that converts route repair records into candidate microcanaries.
- Keep all decisions `observe` or `repair` until required receipts are present.
- Add tests that reject threshold loosening, reject live notional, and rank candidates by expected unblock value.

Deployer milestone:

- Roll out observe-only first.
- Verify the notary on live and sim.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` and live capital state zero.
- Enable planner admission only after Jangar session evidence auction consumes the notary correctly.

## Validation Gates

Local and CI checks:

- Python tests for the notary and planner.
- Existing trading readiness tests remain green.
- Pyright profiles must pass before claiming type safety for Torghut code changes.

Runtime checks after rollout:

- `torghut`, `torghut-options`, and `symphony-torghut` stay `Synced` and `Healthy`.
- Live `/healthz`, `/db-check`, `/trading/status`, and `/trading/session-evidence-notary` return HTTP 200.
- Live `/readyz` may remain degraded while `simple_submit_disabled` is expected, but the notary must explain the
  capital hold.
- Sim notary must show whether route universe remains empty or has new paper-only probe receipts.
- Jangar session epoch must cite the Torghut notary before admitting route repair work.

Value gates:

- `routeable_candidate_count`: count missing, blocked, probing, and routeable states by symbol/account.
- `zero_notional_or_stale_evidence_rate`: count notary receipts blocked by scoped quant, market context, TCA, alpha,
  consumer evidence, or Jangar session receipts.
- `fill_tca_or_slippage_quality`: compare probe slippage against guardrails before and after repair.
- `capital_gate_safety`: live max notional must remain zero until proof floor passes.
- `post_cost_daily_net_pnl`: remain unclaimed until paper or live route receipts include post-cost PnL evidence.

## Rollout

1. Ship notary endpoint in observe-only mode.
2. Verify live and sim notary receipts during closed session and next market-open session.
3. Connect Jangar session evidence auction in observe-only mode.
4. Enable paper-only planner for one symbol at a time, starting with the highest expected unblock value that has fresh
   scoped receipts.
5. Expand to additional symbols only after TCA and quant freshness hold across two windows.

No rollout step changes live trading flags directly. All production changes move through PR, CI, image promotion, and
GitOps.

## Rollback

Rollback is a normal GitOps revert or feature-flag disablement.

Rollback triggers:

- Notary endpoint returns stale, malformed, or contradictory capital state.
- A planner decision sets live notional above zero while proof floor is `repair_only`.
- Paper probes worsen slippage beyond guardrail without retiring.
- Jangar admits Torghut material work without a fresh session epoch.
- Runtime health regresses for live, sim, options, or database dependencies.

Rollback target:

- Disable microcanary planning.
- Keep notary observe-only if safe; otherwise revert the notary PR.
- Preserve current proof-floor behavior: live submit disabled, capital state zero-notional.

## Risks

- Paper probes can create misleading confidence if market context is stale or session conditions are thin.
- A notary endpoint can become a second status route unless Jangar consumes it as the action boundary.
- Sim evidence may stay sparse if the route universe is not repaired first.
- Direct DB access limitations can hide table-level data drift; application receipts must remain honest about that
  boundary.

Mitigations:

- Require scoped quant, market context, TCA, consumer evidence, alpha, and Jangar receipts before paper probes.
- Keep live notional at zero until proof floor passes.
- Retire probes quickly when slippage worsens.
- Record data-access limitations in the notary rather than treating them as pass evidence.

## Handoff Contract

Engineer stage:

1. Implement observe-only notary receipt generation and endpoint.
2. Add tests for receipt freshness, route/TCA states, scoped quant degradation, sim route universe empty, and capital
   zero-notional invariants.
3. Implement the planner only after the notary is stable.
4. Map each planner decision to one of the value gates.

Deployer stage:

1. Verify image promotion and Argo sync after the implementation PR.
2. Verify live and sim notary endpoints.
3. Confirm live submission remains blocked and max live notional remains zero.
4. Publish the first paper-only microcanary only after Jangar session evidence auction admits it.
