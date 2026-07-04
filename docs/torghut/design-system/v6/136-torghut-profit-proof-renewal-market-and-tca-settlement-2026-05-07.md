# 136. Torghut Profit-Proof Renewal Market And TCA Settlement (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Torghut profitability proof renewal, execution TCA settlement, market-context freshness, quant ingestion repair,
Jangar proof-floor actuation, paper/live capital reentry, validation, and rollback.

Companion Jangar contract:

- `docs/agents/designs/132-jangar-renewable-passport-ledger-and-proof-floor-actuation-2026-05-07.md`

Extends:

- `135-torghut-forecast-evidence-bonds-and-capital-reentry-escrow-2026-05-06.md`
- `135-torghut-capital-qualified-alpha-router-and-execution-repair-ladder-2026-05-06.md`
- `134-torghut-profitability-proof-floor-and-evidence-repair-market-2026-05-06.md`
- `132-torghut-forecast-profit-tournament-and-capital-reentry-guardrails-2026-05-06.md`

## Decision

I am selecting a **profit-proof renewal market with execution TCA settlement** as Torghut's next profitability contract.

Torghut has live services and useful empirical artifacts, but it is not capital-qualified. At `2026-05-07T04:56Z`,
the live Torghut route returned degraded trading health even though scheduler, Postgres, ClickHouse, Alpaca, universe,
readiness cache, and empirical jobs were individually healthy. The proof floor was `repair_only`, capital state was
`zero_notional`, live submission was closed by `simple_submit_disabled`, no hypothesis was promotion eligible, and all
three hypothesis slots either stayed in shadow or were blocked.

The critical blocker is not one missing flag. It is stale proof. Execution TCA was last computed at
`2026-04-02T20:59:45Z` with average absolute slippage around `568.6` bps against an `8` bps guardrail. Scoped quant
evidence for account `PA3SX7FYNUTF`, window `15m`, had current compute but stale ingestion at `40284` seconds.
Market context was stale across technicals, fundamentals, news, and regime. Forecast service remained degraded in
Jangar status with `registry_empty`.

The selected direction turns each stale proof dimension into a renewal bid with expected unblock value, validation
cost, expiry, and capital effect. Torghut should not ask Jangar for paper or live reentry until the proof-floor bundle
contains current TCA settlement, quant ingestion, market context, forecast bond, hypothesis readiness, and empirical job
proof. The tradeoff is that paper canary stays held even when empirical jobs are fresh. I accept that because empirical
freshness without current execution and market proof is not a profitable trading system; it is a research artifact.

## Success Metrics

The contract succeeds when:

- Torghut emits a `profit_proof_renewal_market` with bids for stale execution TCA, quant ingestion, market context,
  forecast registry, and alpha readiness.
- Jangar can consume a compact `proof_floor_actuation_id` for each account/window/action class.
- Repair work is zero-notional and ranked by expected unblock value.
- Paper canary remains blocked until execution TCA, quant ingestion, market context, forecast, empirical, and
  hypothesis-readiness proofs are all current.
- Live micro remains blocked until paper closeout proves fillability and execution quality.
- Every proof has `fresh_until`, source refs, reason codes, and rollback criteria.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading flags,
GitOps manifests, ClickHouse tables, or empirical artifacts.

### Runtime Evidence

- Torghut live `torghut-00250-deployment` and sim `torghut-sim-00350-deployment` were both available.
- Supporting services were running: Postgres, ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog,
  options enricher, websocket services, guardrail exporters, Alloy, and Symphony.
- `GET /trading/health` returned `status=degraded`.
- Dependency subchecks showed Postgres `ok`, ClickHouse `ok`, Alpaca broker `ok`, universe `ok` with `12` symbols,
  scheduler running, readiness cache fresh, and empirical jobs `healthy`.
- Live submission remained closed with reason `simple_submit_disabled` and capital stage `shadow`.

### Data And Profitability Evidence

- Profitability proof floor returned `route_state=repair_only`, `capital_state=zero_notional`, and max notional `0`.
- Blocking reasons were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`.
- Repair ladder entries included live submit gate closure, alpha readiness repair, execution TCA repair, feature
  coverage, drift governance, and closed-session signal hold.
- Alpha readiness had `3` hypotheses, with `1` blocked, `2` shadow, `0` promotion eligible, and `3` rollback required.
- Empirical dimension passed with candidate `chip-paper-microbar-composite@execution-proof` and dataset snapshot
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Quant latest-store health was fresh globally: `latestMetricsCount=4032`, `latestMetricsUpdatedAt` around
  `2026-05-07T04:56:19Z`, and `metricsPipelineLagSeconds=0`.
- Scoped quant evidence for `PA3SX7FYNUTF`, window `15m`, was degraded because ingestion lag was `40284` seconds even
  though compute was current.
- Market context health was degraded. Technicals were about `203833` seconds stale against `60`; fundamentals about
  `4806811` against `86400`; news about `4439997` against `300`; regime about `203833` against `120`.
- Direct database inspection was blocked by RBAC: CNPG cluster listing was forbidden and `kubectl cnpg psql` failed
  because this service account cannot create `pods/exec` in `jangar` or `torghut`.

### Source Evidence

- `services/torghut/app/trading/proof_floor.py` already builds a structured proof-floor receipt with dimensions,
  blocking reasons, repair ladder entries, capital state, and rollback target.
- `services/torghut/app/trading/submission_council.py` already evaluates promotion eligibility, empirical jobs,
  quant evidence, and live submission gate state.
- `services/torghut/app/trading/hypotheses.py` already summarizes promotion eligibility and hypothesis state totals.
- `services/torghut/app/main.py` projects proof-floor, alpha readiness, and control-plane contract fields into the
  live trading API.
- `services/torghut/migrations/versions/0021_strategy_hypothesis_governance.py` persists hypothesis governance,
  metric windows, capital allocations, and promotion decisions.
- Source currently contains `31` Alembic migration files. The runtime route reports database dependencies healthy, but
  direct DB verification is not available from this runner.

## Problem

Torghut has enough evidence to repair intelligently, but not enough evidence to reenter capital.

The current failure modes are:

1. **Empirical proof outruns live proof.** Fresh empirical jobs can make the system look close to paper, while TCA,
   market context, and live ingestion remain stale.
2. **Repair work lacks a market.** The proof floor lists repair ladder entries, but it does not yet assign expected
   unblock value, freshness budget, validation cost, and Jangar action impact in one durable market object.
3. **TCA is too old for capital decisions.** Execution settlement from `2026-04-02` cannot qualify a May 7 paper or
   live action.
4. **Quant freshness is split.** Global latest metrics are fresh, but scoped account/window ingestion is stale.
5. **Market context is stale across every domain.** Forecast and LLM review cannot price current risk without fresh
   technical, fundamental, news, and regime context.
6. **Least-privilege proof is non-negotiable.** Jangar cannot depend on privileged DB or ClickHouse shell access for
   routine capital decisions.

## Alternatives Considered

### Option A: Promote Paper On Fresh Empirical Jobs

Pros:

- Fastest path to new observations.
- Uses the valid empirical artifacts already present.
- Avoids new schemas.

Cons:

- Ignores stale execution TCA and stale market context.
- Ignores scoped quant ingestion lag.
- Paper observations would be contaminated by known proof-floor blockers.

Decision: reject.

### Option B: Keep Capital Frozen Until All Proof Is Healthy, With Manual Repair

Pros:

- Strong capital safety.
- Simple operator message.
- No chance of stale TCA widening live risk.

Cons:

- Does not rank repair by profitability impact.
- Leaves fresh empirical proof idle.
- Forces humans to assemble route, database, and proof-floor context repeatedly.

Decision: reject.

### Option C: Profit-Proof Renewal Market With TCA Settlement

Pros:

- Keeps capital at zero while funding the highest-leverage repairs.
- Makes stale TCA a first-class settlement blocker.
- Separates global quant freshness from account/window freshness.
- Gives Jangar one proof-floor actuation handle per action class.
- Converts forecast, market context, alpha readiness, and TCA repair into measurable bids.

Cons:

- Adds a market object and settlement reducer.
- Requires careful bid scoring to avoid optimizing for easy repairs with low profit value.
- Delays paper until a complete bond set exists.

Decision: select Option C.

## Architecture

Torghut emits a profit-proof renewal market per account and market window.

```text
profit_proof_renewal_market
  market_id
  generated_at
  account_label
  market_window
  torghut_revision
  proof_floor_receipt_ref
  current_capital_state
  renewal_bids
  selected_bid_ids
  jangar_actuation_ref
  fresh_until
```

Each renewal bid is explicit about value, cost, validation, and capital effect.

```text
profit_proof_renewal_bid
  bid_id
  dimension              # execution_tca, quant_ingestion, market_context, forecast, alpha_readiness
  blocker_code
  current_state
  target_state
  expected_unblock_value
  validation_cost_class  # cheap, medium, expensive
  max_runtime_seconds
  source_refs
  validation_gate
  rollback_gate
  capital_effect         # zero_notional_repair, paper_unlock, live_unlock
  fresh_until
```

Execution TCA settlement becomes a required bond before paper:

```text
execution_tca_settlement
  settlement_id
  generated_at
  account_label
  strategy_family
  order_count
  last_computed_at
  avg_abs_slippage_bps
  slippage_guardrail_bps
  stale_seconds
  state                  # current, stale, failed, insufficient
  required_repairs
  fresh_until
```

Paper reentry consumes a complete bond set:

- proof-floor route state is not `repair_only`;
- live submit gate is not `simple_submit_disabled`;
- at least one hypothesis is promotion eligible for paper;
- scoped quant ingestion and materialization are current for the account/window;
- market context technicals, news, and regime are within freshness budgets, and fundamentals are within the longer
  session budget;
- execution TCA settlement is current and inside slippage guardrails;
- Jangar proof-floor actuation is `paper_ready`.

Live micro reentry adds:

- paper canary closeout with fillability and post-cost expectancy proof;
- execution TCA settlement refreshed after paper;
- broker/account scope proof current;
- rollback target available with max notional and kill switch confirmed.

## Implementation Scope

Engineer stage owns:

1. Add pure builders for `profit_proof_renewal_market`, `profit_proof_renewal_bid`, and `execution_tca_settlement`.
2. Extend the proof-floor payload with selected renewal bids and Jangar actuation refs.
3. Add account/window-specific quant freshness to renewal bid scoring.
4. Add TCA settlement freshness and slippage guardrail state to paper/live eligibility.
5. Add tests for stale TCA, stale market context, fresh empirical-but-stale-live proof, and paper unlock once all bonds
   are current.

Deployer stage owns:

1. Capture current `/trading/health`, Jangar Torghut quant health, and market-context health before enforcement.
2. Verify renewal market route emission in shadow.
3. Confirm repair bids do not enable non-zero notional.
4. Confirm paper remains held while TCA or scoped quant ingestion is stale.
5. Enable paper reentry only after a complete bond set is current for one account/window.

## Validation Gates

Minimum local/CI gates:

- `uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_submission_council.py -q`
- `uv run --frozen pytest tests/test_trading_api.py tests/test_verify_quant_readiness.py -q`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Read-only runtime gates:

- `/trading/health` exposes renewal bids and keeps `capital_state=zero_notional` while blockers remain.
- Jangar quant health for the target account/window reports all stages current before paper.
- Market context health is `ok` or explicitly stale-but-nonblocking only for domains outside the requested action class.
- Execution TCA settlement has `fresh_until` in the future and slippage inside guardrail.
- Jangar status consumes the same `proof_floor_actuation_id` that Torghut emits.

## Rollout

1. Emit renewal market in shadow with no submission behavior changes.
2. Add Jangar proof-floor actuation consumption in shadow.
3. Require renewal market for `paper_canary` while keeping live classes blocked.
4. Require execution TCA settlement and paper closeout before `live_micro_canary`.
5. Require repeated paper/live proof before `live_scale`.

## Rollback

- Keep `simple_submit_disabled` and `capital_state=zero_notional`.
- Disable paper/live consumption of renewal market and return to existing proof-floor holds.
- Keep renewal bid emission for debugging.
- If a bid scorer is wrong, remove that dimension from selection but keep it visible as unranked proof debt.
- If Jangar actuation is unavailable, Torghut must hold paper/live and allow only observe and zero-notional repair.

## Risks

- Bid scoring could favor low-cost repairs with low profit impact. Mitigation: require expected unblock value and
  action-class effect in every selected bid.
- TCA settlement may be expensive to refresh during market hours. Mitigation: allow settlement repair off live capital
  and cap runtime.
- Market context freshness can flap. Mitigation: require `fresh_until` and consecutive fresh windows for paper.
- Forecast registry repair can look complete before calibration is valid. Mitigation: forecast bids require calibration
  and fallback metrics, not just a non-empty registry.
- Jangar/Torghut actuation ids can diverge. Mitigation: both sides cite the same actuation id and source refs.

## Handoff Contract

Engineer acceptance:

- A unit test proves fresh empirical jobs do not unlock paper when TCA is stale.
- A unit test proves scoped quant ingestion stale creates a renewal bid even when global latest metrics are fresh.
- A route test proves renewal bids are visible with expected unblock value, validation gate, rollback gate, and capital
  effect.
- A Jangar integration/contract test proves proof-floor actuation keeps paper/live held until all required bonds are
  current.

Deployer acceptance:

- Record `/trading/health` before and after renewal market shadowing.
- Confirm repair bids are zero-notional and do not toggle live submission.
- Confirm paper remains held until TCA, quant, market context, forecast, alpha readiness, and Jangar actuation are
  current.
- Confirm rollback leaves renewal evidence visible while restoring existing capital holds.
