# 193. Torghut Route Repair Yield Board And Hypothesis Reentry Guardrails (2026-05-13)

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

I am selecting a **Route Repair Yield Board** with hypothesis reentry guardrails for Torghut.

Torghut is not ready for live capital, and that is the correct decision. The active consumer-evidence endpoint for
revision `torghut-00347` showed `max_notional=0`, `routeable_candidate_count=0`, `capital_decision=repair_only`, and
seven non-current evidence clocks. The current clocks were useful but insufficient: ClickHouse TA and empirical replay
were current, while quant health, Postgres TCA, hypothesis lineage, rollout proof, routeability acceptance, profit
signal quorum, and the capital gate were stale, split, or blocked.

The selected design does not try to unlock capital by weakening guardrails. It treats zero-notional as a repair market.
Every repair class must declare expected profit value, cost, evidence half-life, and promotion criteria before it can
consume Jangar repair authority. Capital reentry is allowed only when the repair board proves that a hypothesis has a
routeable candidate, current TCA, positive post-cost expectancy, accepted routeability, and Jangar authority settlement.

The tradeoff is slower paper/live reentry. I accept that because the profitability target is not "place an order"; it
is "place a routeable, measured order with a credible edge and a rollback trigger." Torghut should use the current
Jangar control plane to make repair work more profitable before it asks for capital.

## Evidence Snapshot

All assessment was read-only.

### Runtime Evidence

- Active build: `v0.569.1-187-g0a4ce485e`, commit `0a4ce485e3e336468839d3650e8ea1d2145a3779`, image digest
  `sha256:c62e82a9de7af99bdcc6592db4b4eff5e2904708d94ede7e84a5adfea864f30c`, revision `torghut-00347`.
- Torghut dependency mode: caller evaluated by Jangar; Torghut omits recursive control-plane fetch in consumer
  evidence.
- Consumer evidence receipt:
  - `candidate_id=chip-paper-microbar-composite@execution-proof`
  - `dataset_snapshot_ref=torghut-chip-full-day-20260505-4c330ce9-r1`
  - `empirical_jobs_state=healthy`
  - `forecast_registry_state=degraded`
  - `tca_state=pass`
  - `paper_readiness_state=blocked`
  - `live_readiness_state=blocked`
  - `max_notional=0`
  - reason codes included `forecast_registry_degraded`, `simple_submit_disabled`, and
    `hypothesis_not_promotion_eligible`
- Route-proven profit receipt:
  - `proof_floor_state=repair_only`
  - `route_state=repair_only`
  - `capital_state=zero_notional`
  - `route_repair_value=14`
  - `decision=repair`
  - rollback target `previous_torghut_image_or_pr_revert`
- Evidence clock:
  - 10 clocks total, 3 current, 7 non-current.
  - Current: `clickhouse_ta`, `market_context`, and `empirical_replay`.
  - Non-current: `torghut_quant`, `postgres_tca`, `hypothesis_lineage`, `rollout`, `routeability_acceptance`,
    `profit_signal_quorum`, and `capital_gate`.
  - `zero_notional_or_stale_evidence_rate=0.7`.
  - `capital_decision=repair_only`, `max_notional=0`.
- Postgres TCA was stale: computed age around 24,850 seconds, latest execution created at
  `2026-04-02T19:00:29Z`, average absolute slippage about 13.82 bps against an 8 bps guardrail, and expected
  shortfall samples were missing for promotion.
- Routeability acceptance had zero accepted routeable candidates and was blocked by quant health, alpha readiness,
  proof floor, capital state, TCA dependency receipts, forecast registry, research candidates/promotions, simple
  submit, and routeability acceptance blockers.
- Profit leases existed for `H-CONT-01`, `H-MICRO-01`, and `H-REV-01`, but all three were `repair_only` with missing
  proof and blockers such as `equity_ta_rows_missing`, `hypothesis_not_promotion_eligible`,
  `rejection_drag_unmeasured`, `research_candidates_empty`, `research_promotions_empty`, and
  `vnext_promotion_decisions_empty`.

### Cluster Evidence

- Argo CD reported `torghut` `Synced/Healthy` at `bbe9dd519fef8e1e141f58f1fde24c88226ca8df`.
- Current Knative revisions `torghut-00347` and `torghut-sim-00445` were ready.
- Supporting runtime deployments were available, including Torghut WS, TA, options catalog, options enricher, ClickHouse
  guardrails exporter, and LLM guardrails exporter.
- Recent events included normal revision readiness, startup/readiness 503s during rollout, a completed empirical jobs
  backfill, and a failed whitepaper autoresearch workflow. These are not capital blockers by themselves, but they
  increase the need for explicit repair yield accounting.

### Data Evidence

- Jangar-owned Torghut market-context data in the Jangar database was current enough for audit but not enough for
  capital:
  - `torghut_market_context_runs`: 298 rows, max `updated_at=2026-05-13T04:20:40Z`.
  - `torghut_market_context_evidence`: 1262 rows, max `updated_at=2026-05-13T04:20:39Z`.
  - `torghut_market_context_dispatch_state`: 18 rows, max `updated_at=2026-05-13T04:16:21Z`.
- The consumer evidence itself identified missing or stale sources outside that Jangar table: quant health, TCA,
  routeability acceptance, profit signal quorum, promotion tables, and proof-floor capital state.

## Problem

Torghut has repair activity, but not a capital-aware repair yield board.

The current control plane correctly prevents capital because the routeable edge is not proven. The problem is that the
repair backlog is too broad to optimize. A repair lot can be technically valid and still be a poor use of scarce
Jangar dispatch capacity if it does not move one of the capital value gates. The system needs to rank repair work by
expected value and prove when a hypothesis is allowed back into paper rehearsal.

The value gates are already visible:

- `zero_notional_or_stale_evidence_rate`
- `fill_tca_or_slippage_quality`
- `routeable_candidate_count`
- `capital_gate_safety`
- `post_cost_daily_net_pnl`

The missing artifact is a board that turns those gates into measurable, bounded trading hypotheses.

## Options Considered

### Option A: Keep All Capital At Zero Until Every Clock Is Current

Leave Torghut in observe-only/repair-only mode until quant health, TCA, hypothesis lineage, rollout proof, routeability,
profit signal quorum, and capital gate are all current.

Advantages:

- Strongest safety posture.
- Easy to reason about.
- Avoids accidental paper/live promotion from partial evidence.

Disadvantages:

- Does not prioritize repair work by expected profit value.
- Keeps profitable paper candidates idle if one unrelated clock is stale.
- Gives Jangar no way to compare repair yield against AgentRun capacity.
- Does not shorten time from repair PR to measurable trading outcome.

Decision: reject as the full architecture. Zero notional remains the rollback state, not the product strategy.

### Option B: Promote The Best Historical Hypothesis To Paper With Tight Notional

Pick the least-bad candidate from empirical replay or historical profit windows and allow paper micro-canary with a very
small notional after Jangar dispatch is healthy.

Advantages:

- Produces trading feedback quickly.
- Tests the pipeline end to end.
- Forces routeability and TCA gaps into the open.

Disadvantages:

- Current evidence shows `routeable_candidate_count=0`.
- Post-cost expectancy and expected shortfall proof are not present.
- Slippage is above the guardrail.
- It optimizes for activity, not profitable evidence.

Decision: reject. This is how paper systems drift into noisy, unprofitable experiments.

### Option C: Route Repair Yield Board With Hypothesis Reentry Guardrails

Rank repair lots by expected impact on the five value gates, require each repair to produce a receipt, and allow paper
reentry only after a hypothesis passes explicit guardrails.

Advantages:

- Makes repair work economically comparable.
- Preserves zero-notional safety while enabling useful repair dispatch.
- Gives Jangar a clear consumer contract: dispatch repair lots, not capital, until reentry criteria are met.
- Converts Torghut blockers into measurable hypotheses with acceptance thresholds.
- Reduces manual debate because each repair lot declares expected gate movement and rollback trigger.

Disadvantages:

- Requires new Torghut status fields and tests.
- Requires careful anti-gaming rules so repair lots do not overstate expected yield.
- Paper reentry remains blocked until routeable candidates and TCA proof are real.

Decision: select Option C.

## Architecture

Add a `route_repair_yield_board` to Torghut consumer evidence and mirror its compact decision into Jangar
`torghut_consumer_evidence`.

The board has four layers:

1. **Repair lots**: current compacted lots such as quant pipeline, feature lineage, execution TCA, rollout image,
   empirical replay, and promotion custody.
2. **Value gate deltas**: expected movement in `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`,
   `routeable_candidate_count`, `capital_gate_safety`, and `post_cost_daily_net_pnl`.
3. **Hypothesis reentry packets**: per-hypothesis receipts for `H-CONT-01`, `H-MICRO-01`, and `H-REV-01` with proof
   state, source freshness, TCA readiness, routeability, expected edge, and rejection drag.
4. **Capital guardrails**: paper/live admission rules with max notional, paper settlement requirement, rollback
   trigger, and Jangar authority settlement ref.

### Measurable Hypotheses

H1: Quant-stage repair yield.

- Claim: retiring `quant_health_not_configured` should lower `zero_notional_or_stale_evidence_rate` from 0.70 to at
  most 0.45 within one repair window.
- Required receipt: scoped quant latest metrics and pipeline stage receipt.
- Guardrail: no paper/live capital; repair dispatch only.
- Failure condition: quant clock remains stale or routeability still reports quant health blockers after the repair
  receipt.

H2: Execution TCA freshness yield.

- Claim: refreshing Postgres TCA should reduce computed TCA age below 6 hours, produce nonzero expected shortfall
  samples, and bring average absolute slippage at or below the configured 8 bps guardrail before paper reentry.
- Required receipt: execution TCA current receipt with sample count, latest execution timestamp, and slippage stats.
- Guardrail: paper remains held while expected shortfall samples are missing or slippage exceeds guardrail.
- Failure condition: TCA clock remains stale or routeability still reports TCA dependency blockers.

H3: Hypothesis reentry yield.

- Claim: one of `H-CONT-01`, `H-MICRO-01`, or `H-REV-01` can become paper-rehearsal eligible only after it has current
  source freshness, a nonempty route universe, a promotion decision, positive post-cost expectancy, measured rejection
  drag, and accepted routeability.
- Required receipt: hypothesis reentry packet.
- Guardrail: `max_notional=0` until Jangar settlement allows paper canary and Torghut emits at least one routeable
  candidate.
- Failure condition: routeable candidate count remains zero or profit signal quorum remains observe-only.

H4: Capital reentry safety.

- Claim: paper canary may open only after H1-H3 clear, source/serving rollout proof is current, and Jangar authority
  settlement allows `paper_canary`.
- Required receipt: capital reentry packet with Jangar settlement ID, Torghut revision, image digest, max notional,
  paper rollback trigger, and proof-floor state.
- Guardrail: live micro-canary and live scale remain blocked until paper settlement proves positive post-cost PnL and
  no unresolved routeability blockers.
- Failure condition: any evidence clock returns to stale/split/blocked, or Jangar deploy/merge authority is held.

## Implementation Scope

Engineer stage should implement this as a status/receipt PR before any trading behavior changes:

- Add `route_repair_yield_board` to the Torghut consumer-evidence builder.
- Add `hypothesis_reentry_packets[]` keyed by hypothesis ID.
- Add `capital_reentry_guardrail` with `paper_canary`, `live_micro_canary`, and `live_scale` decisions.
- Mirror compact fields into Jangar status:
  - `route_repair_yield_board_id`
  - `top_repair_lot_ids`
  - `expected_value_gate_deltas`
  - `routeable_candidate_count`
  - `capital_reentry_decision`
  - `jangar_authority_settlement_ref`
- Add tests for quant repair, TCA repair, hypothesis reentry, routeability acceptance, zero-notional rollback, and
  Jangar authority settlement consumption.

Do not enable paper or live capital in this PR. The first PR creates receipts and tests. Capital behavior changes come
after the receipts are visible in Jangar and have passed at least one deploy verification cycle.

## Validation Gates

Torghut validation maps to the same swarm value gates:

- `failed_agentrun_rate`: Jangar dispatches only the top bounded repair lots instead of broad retry work.
- `pr_to_rollout_latency`: deployer can tell from one receipt which repair lot moved which value gate.
- `ready_status_truth`: Torghut can be service-ready while capital remains zero-notional; the receipt must make that
  distinction explicit.
- `manual_intervention_count`: no hand-joining of TCA, routeability, forecast, hypothesis, and Jangar authority refs.
- `handoff_evidence_quality`: every repair lot cites expected gate delta, validation command, rollback trigger, and
  max notional.

Minimum local checks for the implementation PR:

```bash
uv run --frozen pytest services/torghut/tests/test_repair_bid_settlement.py
uv run --frozen pytest services/torghut/tests/test_routeability_repair_acceptance.py
uv run --frozen pytest services/torghut/tests/test_profit_signal_quorum.py
uv run --frozen pytest services/torghut/tests/test_tca_adaptive_policy.py
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

Read-only runtime validation:

```bash
curl -fsS http://torghut-00347-private.torghut.svc.cluster.local/trading/consumer-evidence \
  | jq '.route_repair_yield_board, .hypothesis_reentry_packets, .capital_reentry_guardrail'
curl -fsS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents \
  | jq '.torghut_consumer_evidence | {route_repair_yield_board_id,routeable_candidate_count,capital_reentry_decision}'
kubectl get applications.argoproj.io -n argocd torghut -o wide
kubectl get deployments,pods -n torghut -o wide
```

## Rollout Plan

1. Shadow receipts: publish the board and packets with `max_notional=0`.
2. Jangar mirror: include compact board fields in Jangar status and NATS handoffs.
3. Repair dispatch: allow Jangar to dispatch only selected repair lots while paper/live remain blocked.
4. Paper rehearsal: open `paper_canary` only after routeable candidate count is positive, TCA is current, slippage is
   within guardrail, post-cost expectancy is positive, and Jangar authority settlement allows paper.
5. Live micro-canary: require successful paper settlement and explicit human/operator release gate unless the system has
   already implemented an audited autonomous capital policy.

## Rollback

Rollback is simple and must stay simple:

- Set `max_notional=0`.
- Mark all `hypothesis_reentry_packets` as `repair_only`.
- Keep repair receipts visible so the failure can be diagnosed.
- Revert to existing consumer-evidence fields if the board is malformed.
- Do not disable service readiness just because capital is blocked.

## Risks

- Repair lots may overstate expected yield. Mitigation: require measured post-repair deltas and penalize lots that fail
  to move their declared value gate.
- Paper reentry may happen with stale data. Mitigation: every reentry packet must carry evidence-clock refs and a
  fresh-until timestamp.
- Jangar may dispatch too much repair work. Mitigation: cap repair lots by `max_parallelism`, `ttl_seconds`, and
  settlement reentry windows.
- Operators may confuse zero-notional repair with capital readiness. Mitigation: keep capital decisions explicit and
  make `max_notional=0` visible in every compact status.

## Engineer Handoff

Implement the receipt surface first. The code PR must not alter live or paper submission behavior. It is accepted when
tests prove the board ranks repair lots, emits hypothesis reentry packets, keeps max notional zero under current
evidence, and mirrors compact fields into Jangar.

## Deployer Handoff

Before any paper or live reentry claim, capture:

- Torghut active revision, commit, and image digest.
- `route_repair_yield_board_id` and top repair lots.
- `zero_notional_or_stale_evidence_rate`.
- Routeable candidate count.
- TCA age, expected shortfall sample count, and slippage guardrail state.
- Hypothesis reentry packet for the selected hypothesis.
- Jangar authority settlement ID and paper/live action decision.

Do not allow paper canary if routeable candidate count is zero or `max_notional` is zero. Do not allow live micro-canary
until paper settlement proves positive post-cost PnL and every capital guardrail is current.
