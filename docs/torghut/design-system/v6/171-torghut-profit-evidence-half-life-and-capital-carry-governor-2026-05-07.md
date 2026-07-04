# 171. Torghut Profit Evidence Half-Life And Capital Carry Governor (2026-05-07)

Status: Accepted for engineer and deployer handoff

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


## Decision

I am selecting a **profit evidence half-life portfolio with a capital carry governor** as the next Torghut profitability
architecture step.

Torghut is running, but the capital posture remains correctly conservative. The live app reports revision
`torghut-00285`, mode `live`, capital stage `shadow`, and `live_submission_gate.allowed=false` because simple submit is
disabled. `/trading/health` returns HTTP 503 with status `degraded`: alpha readiness has three hypotheses, zero
promotion-eligible, and three rollback-required; the proof floor is `repair_only`; market context is stale; and the
execution TCA route universe is incomplete. The route book is useful because it ranks `NVDA`, `AMD`, `AVGO`, `INTC`,
`AMZN`, `GOOGL`, and `ORCL` repair work. It is not yet capital evidence.

The direct Jangar database sample adds a sharper data-plane view. Torghut quant latest metrics are fresh across
windows, but `quant_pipeline_health` carries roughly 51 million rows and no sampled autovacuum or autoanalyze
timestamp. Jangar market-context snapshots have fresh news but fundamentals are stale from March. TCA is recent enough
for repair ranking, yet the symbols still fail the routeability guardrail: one probing symbol, four blocked symbols,
and three missing symbols. That shape needs a half-life model, not a binary health bit.

The design answer is to score every profit evidence surface by useful lifetime, decay it as it ages, and charge
capital gates for the carry. Repair can use decayed evidence when the expected unblock value is high and max notional
is zero. Paper and live capital cannot. A symbol graduates only when its route, TCA, market context, quant, hypothesis,
and Jangar terminal evidence all sit inside their useful half-life and the aggregate carry stays below the capital
budget.

The tradeoff is slower capital reentry for symbols that look attractive but have stale or expensive proof. I am
choosing that tradeoff because Torghut profitability depends on post-cost evidence quality, not activity volume.

## Success Metrics

Success means:

- `/trading/status` and `/trading/health` emit `profit_evidence_half_life`.
- Each payload includes `portfolio_id`, `generated_at`, `account_label`, `revision`, `evidence_positions`,
  `capital_carry_budget`, `repair_budget`, `symbol_carry`, `route_repair_priority`, `capital_gate`, and
  `rollback_target`.
- Evidence positions cover market context, execution TCA, route book, quant latest, quant pipeline health, alpha
  readiness, empirical jobs, Jangar terminal evidence, and live submission authority.
- Repair ranking may use stale evidence only when the capital effect is `zero_notional_repair`.
- Paper probe remains blocked while market context is stale, alpha promotion-eligible total is zero, rollback-required
  total is nonzero, route universe is incomplete, or Jangar terminal carry is above budget.
- Live capital remains blocked unless every mandatory position is fresh, direct or high-confidence delegated, and below
  carry budget.

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-07.

### Runtime And Cluster Evidence

- Torghut pods were running for live revision `torghut-00285`, sim revision `torghut-sim-00385`, ClickHouse, Keeper,
  TA, TA sim, options catalog, options enricher, WebSocket, guardrail exporters, and databases.
- One retained whitepaper autoresearch pod remained in `Error`.
- Recent Torghut events showed migration completion and new Knative revisions becoming ready, but also startup and
  readiness probe failures during transition.
- Listing Knative services, revisions, and routes in `torghut` was forbidden to the current service account. That
  keeps Knative revision truth as delegated evidence unless deployer grants scoped read access.
- ClickHouse pods were running, but recent events repeatedly warned that ClickHouse pods matched multiple
  PodDisruptionBudgets. That is a rollout resilience issue, not a trading edge.

### Trading Evidence

- `/trading/status` reported `mode=live`, `capital_stage=shadow`, `live_submission_gate.allowed=false`, and
  `live_submit_enabled=false` behavior through the simple-submit disabled reason.
- `/trading/health` returned HTTP 503 with `status=degraded`.
- The proof floor was `repair_only`, capital state `zero_notional`, max notional `0`, and blocking reasons:
  `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, `market_context_stale`, and
  `simple_submit_disabled`.
- Alpha readiness had three hypotheses, zero promotion-eligible, and three rollback-required.
- Quant evidence was informational rather than required. Latest metrics were fresh, but pipeline health remained
  degraded with large stage lag.
- Execution TCA covered 7,334 orders and 7,245 filled executions. `AAPL` was probing, `AMD`, `AVGO`, `INTC`, and
  `NVDA` were blocked, and `AMZN`, `GOOGL`, and `ORCL` were missing.
- Repair ladder expected unblock value favored route universe repair, alpha readiness repair, execution TCA refresh,
  market-context refresh, feature coverage, drift governance, and next-session signal continuity.

### Database And Data Evidence

- Direct Jangar SQL showed `torghut_control_plane.quant_metrics_latest` is fresh: account `PA3SX7FYNUTF` had 144 rows
  for each sampled window, with the 15-minute window updated at `2026-05-07T22:24:05Z`.
- Direct Jangar SQL showed `torghut_control_plane.quant_pipeline_health` at about 51,090,363 live rows, no sampled
  autovacuum timestamp, and no sampled autoanalyze timestamp.
- Direct Jangar SQL showed `public.torghut_market_context_snapshots` had news updated on 2026-05-07, but fundamentals
  had newest `as_of` 2026-03-12 and newest update 2026-03-16.
- Direct Torghut Postgres and ClickHouse semantic queries were not available from this runtime; Torghut DB and
  ClickHouse health came through typed service routes and Kubernetes pod/service observations.

## Problem

Torghut already blocks live money. The remaining profitability problem is deciding which repair work deserves compute
and which evidence can graduate from repair to capital. The current status has strong facts, but it does not charge
each fact for age, volume, or observation confidence.

That matters because evidence decays differently:

1. A TCA aggregate from the same trading day can be useful for route repair.
2. Market context news from hours ago may be weak but still informative after close.
3. Fundamentals from March should not raise a May capital gate.
4. Fresh quant latest metrics do not compensate for a degraded ingestion health table.
5. A 51 million row health history may be valuable for audit, but it can become expensive carry unless it is
   partitioned, summarized, or explicitly budgeted.

Without a half-life portfolio, Torghut can do the right conservative thing today while still failing to rank tomorrow's
repairs by post-cost value.

## Alternatives Considered

### Option A: Keep Existing Proof Floor Gates Only

Let the current proof floor and route reacquisition book decide all repair and capital behavior.

Advantages:

- Already implemented.
- Keeps capital blocked today.
- Avoids new status payloads.

Disadvantages:

- Does not quantify how stale or costly each evidence surface is.
- Cannot decide whether stale evidence is still acceptable for zero-notional repair.
- Does not make high-volume quant health carry visible.

Decision: keep the proof floor, but add carry accounting.

### Option B: Refresh Every Evidence Surface Before Any Repair

Require fresh market context, quant health, TCA, hypotheses, and Jangar terminal evidence before even zero-notional
repair work.

Advantages:

- Strongest evidence quality.
- Simple guardrail story.
- Reduces repair loops based on stale facts.

Disadvantages:

- Blocks useful low-risk repair during closed sessions.
- Wastes time refreshing low-value surfaces before obvious route/TCA cleanup.
- Does not prioritize by expected unblock value.

Decision: reject as too slow for repair.

### Option C: Profit Evidence Half-Life Portfolio

Assign each evidence surface a useful lifetime, decay score, capital effect, and carry cost. Allow zero-notional repair
under a repair budget, while keeping paper and live capital blocked above the stricter capital budget.

Advantages:

- Turns stale evidence into priced repair debt.
- Separates repair usefulness from capital eligibility.
- Gives Jangar a clean consumer for terminal debris carry.
- Makes data compaction and freshness work measurable.

Disadvantages:

- Requires stable half-life defaults and symbol-level scoring.
- Adds a new mental model to an already detailed status surface.
- Needs careful testing so decay cannot accidentally unlock capital.

Decision: select Option C.

## Architecture

Torghut emits:

```text
profit_evidence_half_life
  schema_version
  portfolio_id
  generated_at
  account_label
  revision
  trading_mode
  evidence_positions
  symbol_carry
  repair_budget
  capital_carry_budget
  route_repair_priority
  capital_gate
  rollback_target
```

Each evidence position includes:

```text
evidence_position
  position_id
  surface
  symbol_scope
  observed_at
  fresh_until
  half_life_seconds
  age_seconds
  decay_score
  observation_mode
  confidence
  carry_cost
  capital_effect
  source_ref
  smallest_unblocker
```

Initial surfaces:

- `execution_tca_route`
- `market_context_news`
- `market_context_fundamentals`
- `quant_metrics_latest`
- `quant_pipeline_health`
- `alpha_readiness`
- `empirical_jobs`
- `route_reacquisition_book`
- `jangar_terminal_evidence`
- `live_submission_authority`

Capital effects:

- `observe_only`
- `zero_notional_repair`
- `paper_hold`
- `live_hold`
- `capital_eligible`

## Half-Life Defaults

Initial defaults should be conservative:

- Execution TCA route aggregate: 24 hours for repair, 4 hours for paper.
- Market context news: 30 minutes during market hours, 6 hours during closed session for repair only.
- Market context fundamentals: 7 days for repair, 24 hours for capital-sensitive hypothesis promotion.
- Quant latest metrics: 2 minutes for capital, 15 minutes for repair.
- Quant pipeline health: 5 minutes for capital, 30 minutes for repair.
- Alpha readiness: 5 minutes.
- Empirical jobs: 7 days when dataset hash and revision match.
- Jangar terminal evidence: 15 minutes.
- Live submission authority: 30 seconds.

Any missing surface receives maximum carry and can only support `observe_only` unless the proof floor explicitly marks
it non-required.

## Measurable Trading Hypotheses

The first hypotheses are:

- Route universe repair has positive expected value when blocked symbols have high filled history and TCA age is below
  the repair half-life, even if paper remains blocked.
- Closed-session news evidence can support zero-notional repair but not paper probes unless the next open confirms
  freshness.
- Fundamentals older than 7 days should contribute zero capital confidence even when route/TCA is fresh.
- Quant latest freshness without quant pipeline health freshness should not improve capital state.
- Reducing `quant_pipeline_health` carry through partitioning, summaries, or retention should lower status latency
  without increasing capital eligibility by itself.

## Implementation Scope

Engineer stage:

- Add a `profit_evidence_half_life` assembler near the proof floor and trading health code.
- Feed it from existing proof floor dimensions, route reacquisition records, market-context freshness, quant latest,
  quant pipeline health, alpha readiness, empirical jobs, and the Jangar terminal evidence payload.
- Add symbol-level carry for AAPL, AMD, AVGO, INTC, NVDA, AMZN, GOOGL, and ORCL.
- Add tests proving stale fundamentals and degraded quant pipeline health cannot unlock paper or live capital.
- Add tests proving high-history route debt can remain eligible for zero-notional repair when capital is held.

Deployer stage:

- Roll out status payload only.
- Observe one closed-session cycle and one open-session preflight before changing any repair automation.
- Keep live submit disabled and max notional at `0`.
- Use carry output to rank repair jobs, not to release paper capital, until all mandatory surfaces are fresh.

Out of scope:

- Enabling live submission.
- Changing Alpaca credentials or broker authority.
- Deleting or compacting quant history in this design PR.
- Treating Jangar terminal evidence as a substitute for Torghut trading proof.

## Validation Gates

Required local checks:

- `bunx oxfmt --check docs/agents/designs/167-jangar-terminal-evidence-half-life-and-debris-retirement-2026-05-07.md docs/torghut/design-system/v6/171-torghut-profit-evidence-half-life-and-capital-carry-governor-2026-05-07.md docs/jangar/application-architecture.md docs/torghut/design-system/v6/index.md`

Required engineer checks:

- Unit tests for half-life decay and carry budget behavior.
- A fixture matching the current degraded health response: zero promotion-eligible hypotheses, stale market context,
  route universe incomplete, and quant pipeline degraded.
- A contract test proving `zero_notional_repair` may rank route repairs while `paper_probe` and `live` remain held.

Required deployer checks:

- `curl /trading/status | jq '.proof_floor, .profit_evidence_half_life'`.
- `curl /trading/health` must continue to return degraded while proof floor blockers remain.
- Direct SQL sample for `quant_metrics_latest`, `quant_pipeline_health`, and market-context snapshots through Jangar
  or a scoped read-only credential.
- No capital-stage widening until the half-life payload and existing proof floor agree.

## Rollout

1. Emit the payload in status and health responses.
2. Compare carry scores against current proof floor blockers for at least one closed-session cycle.
3. Use route repair priority for zero-notional job ordering only.
4. Add deployer review for any rule that would move a symbol from `blocked` or `missing` to `probing`.
5. Consider paper probes only after market context, quant pipeline health, alpha readiness, route/TCA, and Jangar
   terminal evidence are all below capital carry budget.

## Rollback

Rollback is conservative:

- Stop consuming `profit_evidence_half_life` for repair ordering.
- Keep the current proof floor, live submission gate, and route reacquisition book as the capital source of truth.
- Keep max notional `0`.
- Re-enable carry consumption only after replaying the previous health fixture and proving no capital gate widens.

## Risks

- Carry scores can hide the raw blocker. Every position must cite the source ref and blocker reason.
- Closed-session rules can be abused to keep stale evidence alive. Closed-session carry may support repair only, never
  paper or live capital.
- Data compaction work can be mistaken for profit. Lowering database carry improves reliability, not alpha, unless a
  trading hypothesis independently improves post-cost edge.
- Symbol-level scoring can overfit recent route debt. The first rollout must keep all notional at zero.

## Handoff Contract

Engineer acceptance:

- `profit_evidence_half_life` appears in Torghut status and health payloads.
- Stale fundamentals, degraded quant pipeline health, zero promotion-eligible hypotheses, and route universe debt hold
  paper and live gates.
- High-history blocked routes can still rank for zero-notional repair.
- Tests prove no carry combination bypasses the existing proof floor.

Deployer acceptance:

- Status output matches current degraded proof floor.
- Repair ordering is advisory until one open-session validation pass completes.
- Live submit remains disabled and max notional remains `0`.
- Rollback returns Torghut to the current proof-floor-only behavior.
