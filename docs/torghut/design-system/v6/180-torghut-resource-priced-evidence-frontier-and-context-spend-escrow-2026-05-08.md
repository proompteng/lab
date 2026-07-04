# 180. Torghut Resource-Priced Evidence Frontier And Context Spend Escrow (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut profitability, market-context reliability, route repair economics, Jangar resource-pressure escrow
consumption, capital gates, measurable hypotheses, validation, rollout, rollback, and guardrails.

Companion Jangar contract:

- `docs/agents/designs/176-jangar-resource-pressure-escrow-and-runner-qos-gates-2026-05-08.md`

Extends:

- `179-torghut-capital-repair-frontier-and-route-yield-clearance-2026-05-08.md`
- `178-torghut-route-sample-mint-and-capital-proof-ratchet-2026-05-08.md`
- `177-torghut-profit-repair-broker-and-capital-promotion-gates-2026-05-08.md`
- `docs/agents/designs/175-jangar-failure-debt-clearance-and-action-reentry-frontier-2026-05-08.md`

## Decision

I am selecting a **resource-priced evidence frontier with context spend escrow** for Torghut.

Torghut is not capital-ready, but it is producing useful repair evidence. On 2026-05-08 at 03:09Z, `/healthz`
returned `status=ok`, `/db-check` returned `ok=true` with Alembic head `0029_whitepaper_embedding_dimension_4096`,
and live `/readyz` returned `status=degraded` for the right reasons: proof floor `repair_only`, route state
`repair_only`, capital state `zero_notional`, max notional `0`, and blockers
`hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and `simple_submit_disabled`.
Route evidence covered 8 symbols, with AAPL probing, 4 symbols blocked by route evidence, and 3 missing route
evidence. Alpha readiness had 3 hypotheses, 0 promotion-eligible, and 3 rollback-required.

The new fact is that some evidence is not merely stale or incomplete; it is resource-degraded. During the same window,
Torghut market-context news jobs for AMD and GOOGL failed because their runner pods were evicted under node
ephemeral-storage pressure. A later AMD news job completed, and the proof floor treated market-closed context
staleness as informational. That does not make the failed resource path irrelevant. A capital system must know whether
the receipt it is spending was produced by a clean, budgeted Jangar runner or by an unbudgeted retry path.

The decision is to price evidence by expected profit contribution per resource-clean receipt. Torghut should rank
route and context repair packets by expected capital yield, evidence cost, resource cleanliness, alpha readiness, and
Jangar action state. Context spend escrow records which market-context, quant, TCA, route, and alpha receipts were
produced under clean resource leases. Resource-degraded receipts can inform repair, but they cannot improve paper or
live capital authority.

The tradeoff is slower paper reentry after a successful retry. I accept that. The profitable system should not reward
retry luck. It should promote only when the evidence pipeline is both economically useful and operationally clean.

## Success Metrics

Success means:

- Torghut emits `resource_priced_evidence_frontier` in shadow mode.
- Each packet includes `packet_id`, `symbol`, `repair_class`, `expected_profit_effect`, `expected_unblock_value`,
  `resource_cost_class`, `jangar_resource_escrow_ref`, `resource_clean`, `context_receipt_refs`,
  `route_receipt_refs`, `alpha_receipt_refs`, `paper_probe_notional_limit`, `max_notional`, `decision`, and
  `rollback_target`.
- Failed or evicted context jobs can create repair work, but they cannot increase `paper_probe_notional_limit`.
- Market-closed freshness holds stay informational only when the underlying receipt lineage is resource-clean.
- A route packet cannot advance to paper while Jangar resource escrow is missing, the proof floor is `repair_only`, or
  alpha readiness has 0 promotion-eligible hypotheses.
- Route repair ranking optimizes expected yield per clean evidence cost, not raw symbol volume.
- Live capital stays `zero_notional` until Jangar resource escrow, proof floor, route TCA, alpha readiness, and live
  submission all pass.

## Evidence Snapshot

All evidence in this pass was collected read-only.

### Runtime Evidence

- Torghut live revision `torghut-00292` and sim revision `torghut-sim-00391` were running.
- Torghut deployments for ClickHouse, keeper, CNPG, options catalog/enricher, TA, TA sim, websocket, and guardrail
  exporters were running.
- `/healthz` returned `status=ok`.
- `/readyz` and `/trading/health` returned `status=degraded`.
- Agents events showed `torghut-market-context-news-amd-fcv2j-job` and
  `torghut-market-context-news-googl-wcz7h-job` failed with `BackoffLimitExceeded` after ephemeral-storage evictions.
- The AMD failed job had CPU and memory requests/limits but no ephemeral-storage request or limit. It was evicted while
  the node was below its ephemeral-storage threshold.
- A later `torghut-market-context-news-amd-jzb6t-job` completed, proving the provider path recovered but not that the
  failed evidence lineage was clean.

### Data And Profit Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, `schema_graph_lineage_ready=true`, and known historical parent-fork
  warnings after `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and max notional `0`.
- Proof floor blockers were `hypothesis_not_promotion_eligible`,
  `execution_tca_route_universe_incomplete`, and `simple_submit_disabled`.
- Empirical evidence passed with candidate `chip-paper-microbar-composite@execution-proof`.
- Quant ingestion was informational because `quant_pipeline_stages_missing`, with latest metrics updated at
  `2026-05-08T03:08:22.580Z`.
- Market context was informational because of expected market-closed staleness, with quality score `0.675` and stale
  technicals, news, and regime domains.
- Execution TCA failed with `execution_tca_route_universe_incomplete`: 7334 orders, 7245 filled executions, average
  absolute slippage about 13.82 bps against an 8 bps guardrail.
- Route summary covered 8 symbols: AAPL probing, AMD/AVGO/INTC/NVDA blocked, and AMZN/GOOGL/ORCL missing.
- Alpha readiness had 3 hypotheses, 0 promotion-eligible, and 3 rollback-required. Dependency quorum was blocked by
  `empirical_jobs_degraded`.

### Source Evidence

- `services/torghut/app/trading/proof_floor.py` has 718 lines and already classifies live submission, alpha,
  empirical, quant, market-context, and execution TCA dimensions.
- `services/torghut/app/trading/route_reacquisition.py` has 374 lines and already builds route repair records and
  candidates.
- `services/torghut/app/trading/submission_council.py` has 1202 lines and is already high-risk enough. New scoring
  should live in a pure module and be consumed by the council.
- `services/torghut/app/trading/hypotheses.py` has 791 lines and owns alpha readiness inputs.
- Existing tests cover proof floor, route reacquisition, submission council, Jangar continuity, and market context.
  The missing surface is resource-clean receipt scoring and the rule that resource-degraded evidence cannot improve
  capital class.

## Problem

Torghut currently knows whether a proof dimension passes. It does not yet price whether the evidence was worth the
resources it consumed or whether the resource path was clean enough to spend for capital.

The current failure modes are:

1. A failed context job can be followed by a successful retry, but capital consumers do not see the resource-degraded
   lineage.
2. Market-closed staleness can be informational, but only if the underlying context receipt is trustworthy.
3. A route with many samples can still be unprofitable if its next repair requires expensive or dirty evidence.
4. Missing-symbol repair can consume context and route sampling capacity without a clear expected-profit denominator.
5. Alpha readiness can block all promotion while route repair still spends resources; the system needs to prefer
   repair packets that can actually unlock a capital class later.
6. Jangar can be serving while its runner QoS escrow is dirty, so Torghut must not treat every fresh receipt as
   equally capital-eligible.

Torghut needs to buy evidence like a portfolio, not merely collect it.

## Alternatives Considered

### Option A: Ignore Resource Lineage And Use Latest Successful Receipt

If the latest market-context or route receipt succeeds, let it replace failed attempts.

Advantages:

- Simple.
- Matches many dashboard freshness models.
- Avoids extra fields in proof floor payloads.

Disadvantages:

- Hides resource-degraded evidence paths.
- Rewards retry luck rather than stable evidence production.
- Lets paper/live gates improve without knowing whether Jangar runner QoS was clean.

Decision: reject for capital authority. Latest-success can remain a repair diagnostic.

### Option B: Freeze Context And Route Repair After Any Resource Eviction

Stop market-context and route repair for a fixed window after any Jangar or Agents resource eviction.

Advantages:

- Conservative.
- Easy to operate during obvious node pressure.
- Prevents immediate retry storms.

Disadvantages:

- Blocks no-notional repair that could be safe and useful.
- Does not rank which repairs are worth retrying first.
- Uses time as a proxy for resource cleanliness.

Decision: keep as emergency policy, not the normal architecture.

### Option C: Resource-Priced Evidence Frontier With Context Spend Escrow

Score repair packets by expected profit effect, expected unblock value, resource cost, receipt cleanliness, Jangar
escrow state, alpha readiness, and route risk. Use context spend escrow to mark which receipts may influence capital.

Advantages:

- Keeps capital safe while allowing targeted repair.
- Converts provider and route work into a resource-priced portfolio.
- Makes Jangar resource escrow a direct capital input.
- Lets resource-degraded receipts produce repair work without improving paper/live authority.

Disadvantages:

- Adds a reducer and payload shape.
- Requires careful score calibration.
- May hold paper longer after transient infrastructure failures.

Decision: select Option C.

## Architecture

Torghut adds a pure `resource_priced_evidence_frontier` reducer. It consumes proof floor, route reacquisition, market
context receipts, quant receipts, alpha readiness, execution TCA, empirical jobs, and Jangar resource-pressure escrow.

```text
resource_priced_evidence_frontier
  frontier_id
  generated_at
  account_label
  torghut_revision
  jangar_resource_escrow_ref
  proof_floor_ref
  capital_state
  context_spend_escrow_ref
  route_packets
  held_capital_classes
  next_safe_action
  rollback_target
```

Each route or context packet is scored independently:

```text
resource_priced_packet
  packet_id
  symbol
  repair_class                 # context_refresh | route_sample | slippage_repair | alpha_repair | quant_repair
  current_state                # missing | blocked | probing | informational | pass
  expected_unblock_value
  expected_profit_effect       # negative | unknown | low | medium | high
  resource_cost_class          # low | medium | high
  resource_clean
  jangar_resource_decision
  context_receipt_refs
  route_receipt_refs
  alpha_receipt_refs
  quant_receipt_refs
  capital_class_candidate      # observe | zero_notional_repair | paper_probe | live_micro | live_scale
  paper_probe_notional_limit
  max_notional
  stop_conditions
  rollback_target
```

Initial score:

```text
score =
  expected_unblock_value
  + expected_profit_effect_weight
  - resource_cost_weight
  - route_risk_weight
  - alpha_block_weight
  - jangar_resource_debt_weight
```

Rules:

- `resource_clean=false` forces `capital_class_candidate=zero_notional_repair`.
- `jangar_resource_decision in (hold, block)` forces `paper_probe_notional_limit=0`.
- `alpha_readiness.promotion_eligible_total=0` blocks paper/live even when route evidence improves.
- Context receipts from evicted jobs are repair evidence only.
- A later successful retry must cite its own clean Jangar escrow before it can refresh capital evidence.
- Missing-symbol routes should start with the cheapest clean sample that can improve expected unblock value.

## Measurable Trading Hypotheses

The frontier should test explicit hypotheses:

- H1: Clean, bounded context refreshes for symbols with stale news/regime domains improve alpha readiness within the
  next market session more often than broad context refreshes.
- H2: AAPL paper remains blocked until average absolute slippage clears the 8 bps target and at least one hypothesis
  becomes promotion-eligible.
- H3: Missing route symbols AMZN, GOOGL, and ORCL produce better option value when the first sample is zero-notional
  and resource-clean than when they are batched with all blocked symbols.
- H4: Resource-degraded receipts have lower downstream promotion value than clean receipts, even when their freshness
  timestamp is newer.
- H5: Ranking by expected yield per clean evidence cost retires proof-floor blockers faster than ranking by raw
  filled-execution count.

## Implementation Scope

1. Add `services/torghut/app/trading/resource_priced_evidence_frontier.py` as a pure reducer.
2. Add tests for resource-clean, resource-degraded, missing Jangar escrow, alpha-zero, route-missing, and route-blocked
   packets.
3. Extend Jangar continuity/resource consumer parsing to accept `jangar_resource_escrow_ref` and resource decision.
4. Add a shadow endpoint or proof-floor section for the frontier.
5. Feed the frontier into submission council as informational first, then as a paper/live gate.
6. Add provider receipt metadata for context jobs: runner job, Jangar escrow ref, resource decision, and retry lineage.

Do not add this logic to `submission_council.py` first. Keep the scoring pure so engineers can test ranking and capital
decisions without booting the service.

## Validation Gates

Local validation:

- Unit test: evicted market-context receipt leaves `paper_probe_notional_limit=0`.
- Unit test: latest successful retry without a clean Jangar escrow remains `zero_notional_repair`.
- Unit test: clean AAPL route packet still blocks paper when alpha readiness has 0 promotion-eligible hypotheses.
- Unit test: missing AMZN/GOOGL/ORCL routes rank as bounded sample work, not paper candidates.
- API/proof-floor test: frontier is present in shadow mode and does not change current `zero_notional` state.

Cluster validation:

- A sampled context job shows CPU, memory, and ephemeral-storage requests.
- A clean Jangar resource escrow id appears on new context receipts.
- Resource-degraded failed jobs remain visible as repair evidence and do not change proof floor capital state.
- Torghut stays `zero_notional` while proof floor is `repair_only` or Jangar resource escrow is dirty.

## Rollout

1. Shadow: compute the frontier with no submission-council enforcement.
2. Receipt lineage: attach Jangar resource escrow refs to new context and proof receipts.
3. Repair ranking: use the frontier to order zero-notional repair work.
4. Paper gate: require resource-clean packets for any paper probe.
5. Live gate: require resource-clean packets plus passing proof floor, route TCA, alpha readiness, and live submit.

## Rollback

Rollback is to ignore frontier decisions in submission council while leaving the shadow payload visible. Capital stays
at the existing proof-floor decision, which is currently `zero_notional`. If scoring creates bad repair priorities,
fall back to the prior route repair ladder and keep resource cleanliness as a hard paper/live veto.

## Risks

- Scores can look precise before there is enough data; keep weights simple and visible.
- Resource cleanliness can be over-weighted during harmless market-closed staleness if freshness and resource lineage
  are conflated.
- A strict Jangar dependency can slow Torghut repair when the right action is bounded zero-notional context work.
- Provider receipt metadata must not become another large unbounded status payload.

## Handoff To Engineer

Build the reducer and tests before touching submission council. The first implementation should prove packet scoring
and capital-class decisions from small fixtures based on this evidence: AMD/GOOGL evicted context jobs, AAPL probing
route, NVDA/AMD/INTC/AVGO blocked routes, AMZN/GOOGL/ORCL missing routes, and alpha readiness with 0
promotion-eligible hypotheses.

Acceptance gates:

- Resource-degraded receipts cannot improve paper/live capital.
- Clean retries need a new Jangar resource escrow ref.
- The frontier ranks repairs and explains every score component.
- Current live state remains `zero_notional` until existing proof-floor blockers clear.

## Handoff To Deployer

Deploy after Jangar resource-pressure escrow is in shadow mode. First watch context jobs, not capital. Confirm new
receipts carry resource lineage and that failed evicted jobs stay visible but non-promoting. Only then allow the
frontier to order repair work.

Acceptance gates:

- New context jobs have explicit ephemeral-storage requests.
- Failed resource-degraded receipts do not alter proof-floor capital state.
- The highest-ranked repair packet names its required clean receipts and stop conditions.
- Paper/live remain disabled while Jangar resource escrow is dirty or alpha readiness has no promotion-eligible
  hypotheses.
