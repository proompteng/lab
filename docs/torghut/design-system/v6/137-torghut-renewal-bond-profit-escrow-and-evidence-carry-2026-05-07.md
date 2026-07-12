# 137. Torghut Renewal Bond Profit Escrow And Evidence Carry (2026-05-07)

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

I am selecting **renewal-bond profit escrow with evidence carry** as the next Torghut profitability contract.

Torghut has useful proof, but it still does not have tradable proof. At `2026-05-07T05:10Z`, Torghut `/healthz`
returned OK and `/readyz` had healthy Postgres, ClickHouse, Alpaca, database schema, universe, and empirical jobs. The
database was schema-current at Alembic head `0029_whitepaper_embedding_dimension_4096`, with no missing or unexpected
heads. Empirical jobs were fresh and promotion-authority eligible for
`chip-paper-microbar-composite@execution-proof`.

Capital still had to remain at zero. `/readyz` was degraded because the live submission gate was closed,
profitability proof floor was `repair_only`, capital state was `zero_notional`, and blocking reasons were
`hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`. Quant latest metrics
were fresh, but ingestion lag was `41138` seconds and materialization lag was `20` seconds. The Jangar market-context
route reported `overallState=down`, with technicals and regime in error, fundamentals and news missing, and ClickHouse
ingestion unavailable because `CH_HOST` was not configured. TCA was stale from `2026-04-02T20:59:45.136640Z`, with
`13775` orders and average absolute slippage near `568.6` bps against an `8` bps guardrail.

The selected design does not promote paper from fresh empirical proof while platform renewal is in flight. It creates a
profit escrow account for each Jangar stage renewal bond and lets empirical proof carry value into zero-notional repair
priority. The tradeoff is that a strong empirical artifact may sit idle while stage trust, TCA, market context, or
alpha readiness is repaired. I accept that because the path to profitability is not faster capital; it is preserving
proof value while repairing the blockers that would turn capital into noise.

## Runtime Objective And Success Metrics

This contract increases profitability by converting in-flight platform renewal and stale trading evidence into an
ordered zero-notional repair portfolio.

Success means:

- Torghut can consume Jangar stage states `current`, `renewing`, `repair_only`, `stale`, and `blocked`.
- `renewing` keeps observation and repair work open, but paper and live notional stay `0`.
- Fresh empirical proof earns evidence carry so it prioritizes repairs without bypassing stale TCA, market context, or
  alpha readiness.
- Market-context contradictions are explicit when Jangar route health is down but Torghut local status has no current
  market-context payload.
- Capital reentry requires current Jangar stage trust, current TCA, fresh quant ingestion, fresh market context, and at
  least one promotion-eligible hypothesis.
- `/readyz` and the trading status route expose the escrow verdict and selected zero-notional repairs.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps manifests, ClickHouse tables, or empirical artifacts.

### Runtime And Database Evidence

- `deployment/torghut-00250-deployment` and `deployment/torghut-sim-00350-deployment` were both `1/1` available.
- Torghut `/healthz` returned `{"status":"ok","service":"torghut"}`.
- Torghut `/readyz` returned `status=degraded`.
- Postgres, ClickHouse, Alpaca, universe, empirical jobs, and DSPy runtime dependency checks were not the immediate
  hard blockers.
- Database readiness was healthy and schema-current: current head and expected head
  `0029_whitepaper_embedding_dimension_4096`, `schema_head_delta_count=0`, and `schema_graph_branch_count=1`.
- Database lineage still reported parent-fork warnings around `0010` and `0015`; that is schema-quality debt but not a
  current head mismatch.
- Readiness cache was stale by route policy: age `16.602` seconds against an `8` second TTL.

### Profit And Freshness Evidence

- Proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and max notional `0`.
- Proof-floor blockers were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and
  `simple_submit_disabled`.
- Empirical proof passed with candidate `chip-paper-microbar-composite@execution-proof` and dataset snapshot
  `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Quant evidence was degraded but non-empty: `144` latest metrics, latest update at `2026-05-07T05:10:17.035Z`,
  compute lag `1` second, ingestion lag `41138` seconds, and materialization lag `20` seconds.
- Jangar market-context health was down: technicals and regime were error, fundamentals and news were missing, and
  ClickHouse ingestion reported `CH_HOST is not configured`.
- Torghut local trading status had market context optional and empty; the contradiction must be explicit before capital
  can rely on either surface.
- TCA settlement was stale from `2026-04-02T20:59:45.136640Z`, with `13775` orders and average absolute slippage
  `568.6138848199565249` bps.
- Hypothesis readiness had `3` hypotheses, `0` promotion eligible, `3` rollback required, and all capital multipliers
  at `0`.
- Signal lag was `29503` seconds in an expected market-closed state; closed-session staleness is tolerable for
  observation, not for reentry.

### Source Evidence

- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines and owns much of the live decision path.
- `services/torghut/app/trading/scheduler/governance.py` is `1917` lines and already gates autonomy on Jangar universe
  and dependency proof.
- `services/torghut/app/trading/scheduler/simple_pipeline.py` is `683` lines and blocks simple live submission before
  order execution.
- `services/torghut/app/main.py` already builds `/readyz`, trading status, empirical jobs, proof floor, market-context,
  and TCA payloads from shared reducers.
- Torghut has `141` Python tests covering scheduler safety, readiness, policy, TCA, empirical jobs, market context, and
  trading behavior. The right implementation is a separate escrow reducer and route payload, not another submission
  branch.

## Problem

Torghut now has three useful but disconnected facts:

1. Empirical proof is fresh enough to preserve.
2. Platform and trading evidence are not fresh enough to spend capital.
3. Jangar may be actively renewing stages, but Torghut only sees dependency delay.

Without a renewal-bond escrow, Torghut either waits with no prioritization or over-values the newest empirical proof.
Both are bad. Waiting lets proof decay without spending repair effort against the highest-value blocker. Over-valuing
empirical proof can route paper capital into stale TCA, stale market context, or an unproven platform window.

The market-context evidence also shows a contract gap. Jangar reports market-context health down, while Torghut local
status has optional empty market-context evidence. A capital gate should not silently choose the more permissive view.
It should record a contradiction and require repair before paper.

## Alternatives Considered

### Option A: Keep All Capital And Repair Work Frozen Until Jangar Is Current

Pros:

- Strong safety posture.
- Simple operator rule.
- Avoids acting on contradictory market-context evidence.

Cons:

- Wastes fresh empirical proof half-life.
- Does not order TCA, quant ingestion, alpha readiness, market context, and Jangar repair.
- Produces no evidence for why one zero-notional repair should run before another.

Decision: reject.

### Option B: Let Fresh Empirical Proof Promote A Paper Canary During Renewal

Pros:

- Fastest path to new paper observations.
- Uses the current eligible empirical artifact.
- Avoids waiting for every platform proof surface.

Cons:

- Treats in-flight Jangar renewal as equivalent to terminal platform trust.
- Ignores stale TCA and extreme slippage.
- Ignores market-context contradictions.
- Lets alpha readiness remain not promotion eligible.

Decision: reject.

### Option C: Renewal-Bond Profit Escrow With Evidence Carry

Pros:

- Keeps max notional at `0` while preserving the value of fresh empirical proof.
- Lets Jangar `renewing` state authorize observation and repair but not paper or live.
- Prices each stale evidence surface by expected unblock value and proof decay.
- Makes contradictory market-context surfaces explicit.
- Produces deployable route evidence for paper and live reentry.

Cons:

- Requires a new reducer and route fields.
- Requires calibration of evidence carry and repair priority.
- May keep paper disabled longer than a direct empirical-promotion path.

Decision: select Option C.

## Architecture

Torghut consumes Jangar stage trust and renewal bonds as capital inputs.

```text
jangar_stage_trust_input
  generated_at
  required_stages
  stage_states              # current, renewing, repair_only, stale, blocked
  active_renewal_bond_refs
  controller_ingestion_settlement_ref
  material_action_effects
  fresh_until
```

Torghut emits a renewal-bond profit escrow receipt.

```text
renewal_bond_profit_escrow
  receipt_id
  generated_at
  account_label
  torghut_revision
  market_window
  jangar_stage_trust_ref
  proof_floor_ref
  empirical_proof_refs
  market_context_refs
  quant_ingestion_ref
  tca_ref
  capital_state             # zero_notional, shadow, paper_ready, live_micro_ready
  max_notional
  evidence_carry_accounts
  selected_zero_notional_repairs
  contradiction_refs
  fresh_until
```

Evidence carry accounts preserve fresh proof value without authorizing capital.

```text
evidence_carry_account
  carry_id
  proof_ref
  hypothesis_id
  proof_age_seconds
  proof_half_life_seconds
  blocked_by
  expected_unblock_value
  decay_risk
  selected_repair_bid_ref
  max_notional              # always 0 while any hard blocker remains
```

### Capital Semantics

- `jangar_state=renewing`: allow observation and zero-notional repair only.
- `jangar_state=current`: permit paper consideration, still subject to proof floor, TCA, quant, market context, and
  hypothesis eligibility.
- `market_context_contradiction`: hard hold for paper/live until Jangar and Torghut agree on a current market-context
  receipt.
- `empirical_proof_fresh`: adds carry value to selected repairs, never clears a blocker by itself.
- `execution_tca_stale`: hard hold for paper/live until TCA is current and slippage is inside guardrail.

## Implementation Scope

Engineer stage should implement the minimum production slice:

- Add a `renewal_bond_profit_escrow` reducer that consumes Jangar stage trust, proof floor, empirical jobs, quant
  evidence, market context, TCA, and hypothesis readiness.
- Add evidence carry scoring for fresh empirical proofs blocked by stale platform or trading evidence.
- Add a market-context contradiction detector that compares Jangar market-context health with Torghut local
  market-context status.
- Surface the escrow receipt in `/readyz` and `/trading/status` while keeping all notional at `0`.
- Add tests for Jangar `renewing` consumption, empirical proof non-bypass, TCA stale hold, market-context
  contradiction hold, and repair ranking.

Out of scope for the first implementation:

- Enabling live submission.
- Changing broker credentials, account settings, or live promotion toggles.
- Writing repair artifacts outside normal Torghut application paths.
- Replacing the existing proof-floor reducer.

## Validation Gates

Local validation:

- `uv sync --frozen --extra dev`
- `uv run --frozen pytest tests/test_trading_scheduler_safety.py tests/test_profitability_proof_floor.py`
- `uv run --frozen pytest tests/test_policy_checks.py tests/test_tca_adaptive_policy.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Cluster validation after deploy:

- `curl -sS http://torghut-00250-private.torghut.svc.cluster.local/readyz | jq '.renewal_bond_profit_escrow,.proof_floor'`
- `curl -sS http://torghut-00250-private.torghut.svc.cluster.local/trading/status | jq '.renewal_bond_profit_escrow,.hypotheses.summary'`
- `curl -sS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents | jq '.stage_trust,.stage_renewal_bonds'`
- Confirm max notional remains `0` while Jangar stage state is `renewing` or market context is contradictory.
- Confirm the first selected zero-notional repair targets the highest expected unblock value, not the newest proof by
  timestamp alone.

## Rollout Plan

1. Ship escrow receipt in observe-only mode.
2. Compare selected repair bids with the existing proof-floor repair ladder for one full closed-session and one market
   session.
3. Let zero-notional repair jobs consume selected repair bids.
4. Require `jangar_state=current` and no market-context contradiction before paper readiness can become true.
5. Require current TCA and promotion-eligible hypothesis before paper canary.
6. Require paper outcome receipts and broker rollback before live micro.

## Rollback Plan

- Disable escrow receipt consumption and fall back to the existing proof-floor reducer.
- Continue publishing evidence carry diagnostics in observe-only mode.
- Keep paper and live capital held if Jangar stage trust is missing, renewing, stale, or blocked.
- Revert the Torghut image through GitOps if escrow generation affects route latency or readiness availability.

## Risks And Mitigations

- **Over-valuing empirical carry:** cap carry at repair priority only; it never raises notional.
- **Market-context false contradiction:** require both source refs and timestamps in the contradiction payload.
- **Jangar feed absence:** absence is a hard paper/live hold and observe-only fallback.
- **Repair scoring drift:** compare against proof-floor ladder before any consumer uses the new score.
- **Route bloat:** expose compact receipts and keep detailed repair candidates behind existing trading status.

## Handoff To Engineer

Implement the escrow as a reducer and receipt. Keep it separate from order submission and proof-floor enforcement. The
first useful behavior is better repair ordering with max notional fixed at `0`.

## Handoff To Deployer

Do not enable paper or live from a renewal bond. A Jangar `renewing` state can keep observation and zero-notional repair
alive, but capital waits for `current` stage trust plus fresh TCA, quant ingestion, market context, and a
promotion-eligible hypothesis.
