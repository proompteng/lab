# 186. Torghut Proof-Lease Repair Market And Capital Hold (2026-05-08)

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

I am selecting a **proof-lease repair market with capital hold** as Torghut's next profitability contract.

Torghut is safe, current enough to diagnose, and not ready to promote. At `2026-05-08T16:08Z`, live `/healthz` returned
OK, while live `/readyz` returned HTTP 503 with `status=degraded`. Postgres, ClickHouse, broker, universe, empirical
jobs, and schema currentness were healthy. The database schema head was `0030_evidence_epochs`, lineage was ready, and
account scope was ready. The degraded state came from business and proof signals: live submission remained disabled,
the proof floor was `repair_only` with `capital_state=zero_notional`, alpha readiness had three shadow hypotheses and
zero promotion-eligible hypotheses, market-context news was stale, `ta-core` was blocked on signal lag, and scoped
quant pipeline stages had ingestion and materialization failures.

Torghut already emits a `profit_lease_projection`. That is the right raw material, but it is not yet a repair market.
All three live leases were `repair_only` with `proof_state=missing`; blocking reasons included
`equity_ta_rows_missing`, `hypothesis_not_promotion_eligible`, `rejection_drag_high`,
`research_candidates_empty`, `research_promotions_empty`, and `vnext_promotion_decisions_empty`. The system needs to
rank those proof gaps by expected capital value and route them back to Jangar as zero-notional repair work, while
keeping paper and live action held until a full proof lease clears.

The selected architecture turns proof leases into repair bids. Each bid names the missing proof source, expected value
gate, current Jangar controller-witness carry receipt, max notional, and stop condition. Repair bids can spend agent
work. They cannot spend capital. Capital remains held until scoped quant, market context, lineage, promotion, TCA, and
Jangar carry receipts all converge.

The tradeoff is that Torghut will continue to look conservative while individual proof repairs proceed. That is the
right posture. A profitable system should buy the next proof that can unlock routeability; it should not trade because
one global health endpoint is fresh.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, trading flags, GitOps
manifests, or AgentRun objects.

### Runtime And Cluster Evidence

- Torghut live revision `torghut-00311` and sim revision `torghut-sim-00409` were running `2/2`.
- Torghut Postgres, ClickHouse, Keeper, WebSocket, options WebSocket, TA, options TA, options catalog, and options
  enricher pods were running.
- Argo CD reported `torghut` and `torghut-options` `Synced` and `Healthy`.
- Recent Torghut events showed normal rollout churn, readiness warmup for options services, and repeated ClickHouse
  multiple-PDB warnings.
- Jangar control-plane status reported current Torghut consumer evidence with receipt
  `torghut-route-proven-profit:d269b7c44c6c79a0`, decision `repair`, and max notional `0`.

### Readiness And Schema Evidence

- `/healthz` returned `{"status":"ok","service":"torghut"}`.
- `/readyz` returned HTTP 503 and `status=degraded`.
- Postgres, ClickHouse, Alpaca, universe, scheduler, empirical jobs, and database schema checks were OK.
- Current and expected schema heads were both `0030_evidence_epochs`.
- Schema lineage was ready, with known historical parent-fork warnings and no missing or unexpected heads.
- Live submission was closed by `simple_submit_disabled`, `capital_stage=shadow`, and blocked reasons
  `hypothesis_not_promotion_eligible` plus `simple_submit_disabled`.
- The proof floor was `repair_only`, `capital_state=zero_notional`, and required.

### Quant, Context, And Lease Evidence

- Jangar scoped quant health for `PA3SX7FYNUTF/15m` reported `latestMetricsCount=180` and latest metrics updated at
  `2026-05-08T16:07:41Z`.
- Scoped pipeline stages were degraded. Compute was OK; ingestion was false for two active strategies with lag up to
  `610253` seconds; materialization was false for both sampled strategies.
- Torghut readiness reported `quant_metrics_update_missing` and `quant_pipeline_degraded` as informational proof
  debt, not capital authority.
- Market context last checked `NVDA` at `2026-05-08T16:04:21Z`; technicals, fundamentals, and regime were OK, while
  news was stale and risk flags included `news_stale`.
- Segment summary blocked `market-context` for event reversion and `ta-core` for all sampled hypotheses that depended
  on TA.
- Profit lease projection generated three leases, one each for `H-CONT-01`, `H-MICRO-01`, and `H-REV-01`.
- Every lease had `capital_decision=repair_only` and `proof_state=missing`.
- Lease source provenance showed quant metrics current, empirical job evidence current, but equity TA rows missing,
  research candidates and promotions empty, vNext promotions empty, and rejection drag high.

### Source Evidence

- `services/torghut/app/trading/profit_leases.py` already builds the lease projection and source-provenance structure.
- `services/torghut/app/trading/submission_council.py` carries the projection into readiness and status payloads.
- `services/torghut/app/trading/profit_signal_quorum.py`, `consumer_evidence.py`, and `profit_repair_settlement.py`
  already provide receipt vocabulary that can consume repair bids without making capital decisions.
- `services/torghut/app/main.py` is still over 5,000 lines and should not absorb another large reducer. The repair
  market should live in a pure module and be exposed by existing routes.
- Existing tests cover readyz, proof floor, consumer evidence, quality-adjusted frontier, profit signal quorum,
  profit leases, route reacquisition, and market context. The missing tests are for ranking proof-lease repairs and
  ensuring a current repair bid never widens paper or live notional.

## Problem

Torghut has a clear capital hold, but not a clear repair auction.

The current failure modes are:

1. Global service and schema health can be green while scoped proof leases are missing.
2. Quant latest metrics can be current while ingestion and materialization are stale.
3. Market-context bundles can be recent while a required domain, such as news, is stale.
4. One hypothesis can have partial lineage while other hypotheses lack lineage entirely.
5. Rejection drag, empty research candidate tables, and missing vNext promotions all appear as blockers, but not as a
   ranked repair plan.
6. Jangar controller witness uncertainty should influence repair admission without becoming Torghut's capital source
   of truth.

Torghut needs to convert proof-lease gaps into priced repair bids that Jangar can execute under zero notional.

## Alternatives Considered

### Option A: Keep Profit Lease Projection As Advisory Text

Leave `profit_lease_projection` as a status payload and let operators or agents decide what to repair.

Advantages:

- No new schema or reducer.
- Keeps current status stable.
- Avoids ranking errors.

Disadvantages:

- Does not reduce manual intervention.
- Does not prevent agents from choosing low-value proof repairs.
- Does not connect repair work to a measurable routeability or profit gate.

Decision: reject. Advisory text is not enough for autonomous repair selection.

### Option B: Hard-Code A Fixed Repair Order

Always repair equity TA first, then market context, then research candidates, then rejection drag, then promotion
decisions.

Advantages:

- Simple to implement.
- Easy to explain.
- Likely improves the current state because equity TA is missing.

Disadvantages:

- Ignores account, hypothesis, window, and route value.
- Can waste repair capacity on proof that does not unlock a capital gate.
- Does not adapt when market context or Jangar carry becomes the higher-value blocker.

Decision: reject as the target. Use only as an emergency fallback when scoring is unavailable.

### Option C: Proof-Lease Repair Market With Capital Hold

Turn each missing or stale proof source into a repair bid with expected value, required receipts, Jangar carry state,
max notional, and stop conditions. Let Jangar consume the bid for zero-notional repair admission.

Advantages:

- Ranks repair work by expected impact on routeability and proof quality.
- Keeps paper and live capital held until the full lease clears.
- Gives Jangar a bounded, testable repair target.
- Uses existing proof-lease and profit-signal vocabulary instead of adding a competing capital gate.

Disadvantages:

- Requires scoring calibration.
- Needs tests to prevent repair bids from being interpreted as capital permission.
- Adds another receipt to status payloads.

Decision: select Option C.

## Architecture

Torghut adds a `proof_lease_repair_market` receipt beside `profit_lease_projection`.

```text
proof_lease_repair_market
  schema_version
  market_id
  generated_at
  fresh_until
  account
  window
  jangar_controller_witness_carry_ref
  capital_hold_state
  bids[]
  capital_action_decision
  rollback_target
```

Each bid is local to a proof lease:

```text
proof_lease_repair_bid
  bid_id
  proof_lease_id
  hypothesis_id
  lane_id
  repair_class              # equity_ta | quant_ingestion | quant_materialization | market_context | lineage | promotion | rejection_drag
  missing_or_stale_source
  value_gate                # routeable_candidate_count | zero_notional_or_stale_evidence_rate | fill_tca_or_slippage_quality | capital_gate_safety
  expected_unlock
  expected_cost_class
  decision                  # observe | repair | hold | block
  max_notional
  required_jangar_action_class
  required_receipts[]
  stop_conditions[]
  rollback_target
```

Decision rules:

- A repair bid always has `max_notional=0`.
- `capital_action_decision` remains `hold` while any required lease is `repair_only`, any required proof state is
  `missing`, or Jangar controller-witness carry is not current.
- Missing equity TA rows become a repair bid only when they are tied to a hypothesis lane and value gate.
- Stale news context becomes a market-context repair bid for lanes that depend on news.
- Rejection drag becomes a repair bid only when a candidate or promotion table can identify the affected lane.
- Quant ingestion and materialization failures are separate bids because they have different owners and stop
  conditions.

## Measurable Hypotheses

Hypothesis 1: Proof-lease repair bids reduce stale-evidence waste.

- Measure: lower `zero_notional_or_stale_evidence_rate` for leases that receive a repair bid.
- Gate: repair bid completion must refresh or explicitly retire the missing source.
- Expected value: less repeated repair work on proof that does not unlock routeability.

Hypothesis 2: Bid ranking improves routeability faster than fixed-order repair.

- Measure: increase `routeable_candidate_count` or reduce blockers per lease within two market sessions.
- Gate: compare selected bids against fixed-order fallback in shadow mode.
- Expected value: higher repair ROI under the same agent capacity.

Hypothesis 3: Capital hold remains intact under repair pressure.

- Measure: `paper_canary`, `live_micro_canary`, and `live_scale` stay held or blocked while any bid has
  `decision=repair`.
- Gate: route tests inject current repair bids and assert max notional remains zero.
- Expected value: safer profitability repair without accidental promotion.

## Implementation Milestones

| Milestone | Scope                                                                                                 | Value gates                                                               |
| --------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| M0        | Merge this design and companion Jangar contract.                                                      | `handoff_evidence_quality`                                                |
| M1        | Add a pure proof-lease repair-market builder and fixtures for current live degraded evidence.         | `zero_notional_or_stale_evidence_rate`, `handoff_evidence_quality`        |
| M2        | Expose the receipt in `/readyz` and `/trading/status` with capital hold unchanged.                    | `capital_gate_safety`, `handoff_evidence_quality`                         |
| M3        | Teach Jangar Torghut consumer evidence to map bids into bounded repair action classes.                | `manual_intervention_count`, `failed_agentrun_rate`                       |
| M4        | Run one shadow session comparing bid ranking to fixed-order repair.                                   | `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`       |
| M5        | Permit only bid-backed zero-notional repair launches when Jangar controller-witness carry is current. | `failed_agentrun_rate`, `capital_gate_safety`, `handoff_evidence_quality` |

## Validation Gates

Engineer stages must prove:

- current live degraded evidence produces repair bids for missing equity TA, stale or missing scoped proof, empty
  research/promotion evidence, and rejection drag;
- every repair bid has `max_notional=0`;
- a missing or stale Jangar controller-witness carry receipt holds repair admission but does not change Torghut capital
  truth;
- `/readyz` and `/trading/status` expose the same repair-market id;
- paper and live action stay held when a repair bid exists;
- fixed-order fallback is available if scoring is unavailable.

Deployer stages must prove:

- Torghut live and sim `/readyz` still report schema currentness and proof-floor state;
- `proof_lease_repair_market` is fresh and includes the top bids;
- Jangar control-plane status consumes the receipt without recursive route failure;
- live and paper max notional remain zero unless a separate capital gate clears.

## Rollout

1. Ship the pure builder and tests.
2. Expose the market receipt in shadow mode.
3. Compare market bid order against current repair launches for one session.
4. Let Jangar consume bids for observe-only and zero-notional repair.
5. Require current Jangar controller-witness carry before bid-backed repair launches.
6. Consider paper action only after proof leases clear and existing capital gates independently allow.

## Rollback

- Remove the repair-market receipt from admission and continue publishing `profit_lease_projection`.
- Keep proof floor, live submission gate, and existing quality-adjusted frontier as capital sources of truth.
- Do not delete lease or bid evidence during rollback.
- If scoring fails, use the fixed fallback order in observe mode only.
- If Jangar controller-witness carry is unavailable, deny bid-backed repair launches and keep capital held.

## Risks And Mitigations

- **Bad ranking:** an early scoring model may choose low-value repair. Mitigation: shadow compare against fixed-order
  fallback and require value-gate attribution.
- **Capital bleed:** repair bids could be mistaken for paper permission. Mitigation: enforce `max_notional=0` in tests
  and status consumers.
- **Route coupling:** Torghut could become too dependent on Jangar witness shape. Mitigation: consume a versioned
  reference and fail closed for admission while preserving local capital truth.
- **Status size:** the receipt could become verbose. Mitigation: publish top bids and refs, not raw evidence payloads.
- **Manual override pressure:** operators may want to bypass bids for speed. Mitigation: require an explicit waiver
  ref and keep proof floor in repair-only until receipts clear.

## Engineer Handoff

Start with M1 in `services/torghut/app/trading`. Build the proof-lease repair market as a pure module fed by
`profit_lease_projection`, scoped quant state, market-context state, hypothesis lineage, promotion state, route/TCA,
and Jangar controller-witness carry. The first PR must include fixtures matching the observed live state: three
repair-only leases, missing equity TA rows, current quant metrics with degraded ingestion/materialization, stale news
context, high rejection drag, and empty research/promotion evidence.

Do not change paper or live capital behavior in the first PR.

## Deployer Handoff

Deploy shadow mode only. Acceptance is a fresh `proof_lease_repair_market` id on `/readyz` and `/trading/status`, no
increase in max notional, top bids tied to value gates, and Jangar still reporting paper/live Torghut material actions
as held or blocked.

The next bounded implementation milestone is M1: pure proof-lease repair-market builder with tests. It targets
`zero_notional_or_stale_evidence_rate`, `capital_gate_safety`, and `handoff_evidence_quality`.
