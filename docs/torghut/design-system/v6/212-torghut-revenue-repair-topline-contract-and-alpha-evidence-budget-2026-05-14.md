# 212. Torghut Revenue-Repair Topline Contract And Alpha Evidence Budget (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut revenue-repair endpoint contract, alpha-readiness repair queue, routeable-candidate evidence budget,
Jangar material evidence settlement import, zero-notional guardrails, validation, rollout, rollback, and handoff.

Companion Jangar contract:

- `docs/agents/designs/206-jangar-material-evidence-settlement-spine-and-repair-dispatch-budget-2026-05-14.md`

Extends:

- `211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md`
- `210-torghut-source-bound-verification-carry-import-and-no-delta-release-2026-05-14.md`
- `209-torghut-verification-carry-import-and-alpha-repair-release-2026-05-14.md`
- `206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md`
- `205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md`
- `197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md`

## Decision

I am selecting a **revenue-repair topline contract with an alpha evidence budget** as Torghut's next profitability
architecture increment.

The current business surface is specific. On 2026-05-14T20:24Z to 20:26Z, Jangar `/ready` carried Torghut
`business_state=repair_only`, `revenue_ready=false`, and top queue item `repair_alpha_readiness` with value gate
`routeable_candidate_count`. A direct read of Torghut `/trading/revenue-repair` returned `business_state=repair_only`
and the same first `repair_queue` entry, but the direct payload did not expose a top-level `top_repair_queue_item`,
routeable-candidate counts, route-warrant state, evidence-clock state, or repair-bid settlement summary in the compact
shape Jangar expected. Torghut `/readyz` correctly returned HTTP `503` because live submission is disabled and the
profitability proof floor is `repair_only`; database, ClickHouse, Alpaca, schema, and static universe checks were OK.

The selected design makes `/trading/revenue-repair` the authoritative business evidence surface by tightening its
topline contract. The endpoint must always expose the first-class fields Jangar needs to distinguish capital-safety
repair-only truth from transport or schema gaps:

- `business_state`, `revenue_ready`, `capital_state`, `capital_stage`, `max_notional`, and `live_submission_allowed`;
- `top_repair_queue_item`, with `repair_queue[0]` as the deterministic source;
- `selected_value_gate`, `required_output_receipt`, and `required_receipts`;
- routeable candidate counts before and after the selected alpha repair window;
- no-delta release key state and the selected no-delta repair reentry decision;
- repair-bid settlement selected, dispatchable, and held lots;
- freshness, evidence-clock, route-warrant, and Jangar material settlement import refs.

The companion Jangar settlement spine can infer the top queue item from `repair_queue[0]` during observe mode, but
Torghut should not rely on inference as a contract. The next implementation should make the direct endpoint and the
consumer evidence projection agree on the same top queue item and freshness window.

The tradeoff is that Torghut will expose more compact control-plane metadata on a business endpoint. I accept that.
This endpoint is already the live business evidence surface for revenue repair, and Jangar cannot safely budget repair
work when the top queue is only recoverable by reading nested or parallel projections.

## Runtime Requirements

This contract implements the active cross-swarm validation contract:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, workload readiness, service health,
  and trading evidence after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Torghut value-gate mapping:

- `routeable_candidate_count`: primary gate; the top repair budget must target alpha readiness and either move
  accepted routeable candidates above zero or write an explicit no-delta settlement with changed release conditions.
- `zero_notional_or_stale_evidence_rate`: missing topline fields, stale alpha evidence, stale market context, or stale
  empirical receipts keep `max_notional=0`.
- `fill_tca_or_slippage_quality`: execution TCA repair wins only if the alpha budget names it as the blocking
  prerequisite.
- `post_cost_daily_net_pnl`: no paper or live capital follows until routeable candidates have current post-cost proof.
- `capital_gate_safety`: live submission remains disabled and all repair tickets are zero notional.

Jangar value-gate mapping:

- `failed_agentrun_rate`: a stable topline contract prevents duplicate no-delta repair AgentRuns from partial
  evidence.
- `pr_to_rollout_latency`: deployers can compare Jangar settlement id and Torghut topline fields directly.
- `ready_status_truth`: Torghut `/readyz=503` can mean correct capital-safety hold, not service outage.
- `manual_intervention_count`: no human needs to reconcile `/ready`, `/trading/revenue-repair`, and
  `/trading/consumer-evidence` by hand.
- `handoff_evidence_quality`: every handoff cites endpoint generation time, top queue item, selected value gate,
  evidence budget, validation command, and rollback target.

## Current Evidence

All evidence below was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records,
GitOps resources, AgentRuns, broker state, trading flags, or market data.

### Runtime And Cluster

- Torghut live revision `torghut-00417` was running with `2/2` containers ready.
- Torghut sim revision `torghut-sim-00512` was running with `2/2` containers ready.
- Torghut database, ClickHouse shards, Keeper, options services, TA services, WebSocket services, and guardrail
  exporters were running.
- Torghut retained many failed profit-feedback and whitepaper-autoresearch pods. Those are not the current top
  revenue-repair item, but they are audit debt that should feed Jangar material settlement if they become fresh active
  failures.
- Argo reported `torghut=Synced/Healthy`.

### Revenue Repair

- `GET /trading/revenue-repair` returned `business_state=repair_only`.
- `repair_queue[0]` was `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, dimension
  `alpha_readiness`, priority `70`, action implied by the catalog as clearing hypothesis blockers before capital,
  value gate `routeable_candidate_count`, required output `torghut.executable-alpha-receipts.v1`, and
  `max_notional=0`.
- Direct read top-level fields were missing or null for `top_repair_queue_item`, routeable candidate counts,
  route-warrant state, evidence-clock state, and repair-bid settlement summary.
- Jangar `/ready` was able to carry a top repair queue item for the same business state, which means the system has
  the evidence somewhere but the direct business surface is not yet contract-complete.

### Readiness And Database

- `GET /readyz` returned HTTP `503` with `status=degraded`.
- Postgres, ClickHouse, Alpaca, database schema, static universe, DSPy observation path, and optional quant evidence
  were acceptable for observation.
- The failing gates were `live_submission_gate=simple_submit_disabled` and
  `profitability_proof_floor=repair_only`.
- `/readyz.alpha_readiness` showed 3 hypotheses, 0 promotion-eligible hypotheses, stale or missing alpha windows,
  empirical jobs not ready, and market-context stale domains.
- `/db-check` returned `ok=true`, `schema_current=true`, no missing heads, no unexpected heads, head delta count `0`,
  and `schema_graph_lineage_ready=true`.
- Schema lineage still warned about historical parent forks under
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`; these are not current head
  blockers, but they prove that head currentness is not enough to infer alpha route readiness.

### Source And Test Surface

- `services/torghut/app/trading/revenue_repair.py` is the business digest source and currently spans 1208 lines.
- `services/torghut/app/trading/no_delta_repair_reentry_auction.py` owns no-delta reentry and spans 891 lines.
- `services/torghut/app/main.py` assembles the endpoint surface and spans 7102 lines, making endpoint shape tests
  mandatory for any topline change.
- Existing tests cover revenue repair digest, executable alpha receipts, alpha readiness conveyor, no-delta auction,
  repair bid settlement, routeability acceptance, consumer evidence, and readiness.
- Missing tests: direct `/trading/revenue-repair` always exposes the same top queue item as consumer evidence, queue
  head fallback, routeable-count fields, repair-bid summary, Jangar material settlement import, and zero-notional
  capital safety under partial transport.

## Problem

Torghut is correctly holding capital, but its business evidence surface is not contract-complete for Jangar material
settlement.

The concrete failure modes are:

1. Jangar can see `repair_alpha_readiness` through `/ready` while `/trading/revenue-repair.top_repair_queue_item` is
   absent.
2. Missing top-level fields can be misclassified as `business_state_missing` rather than partial transport or schema
   evidence.
3. Routeable-candidate counts can be null, leaving the repair budget unable to prove movement or no-delta.
4. Repair-bid settlement details can be nested away from the direct business surface, forcing operators to inspect
   multiple endpoints.
5. Torghut `/readyz=503` can be treated as service failure even when it is the correct capital-safety state.
6. Alpha-readiness work can be repeated without a changed release condition if the top-line no-delta budget is not
   explicit.

The endpoint needs a typed top-line contract that makes the top repair queue item, evidence budget, freshness, and
capital guardrails impossible to confuse with transport failure.

## Alternatives Considered

### Option A: Let Jangar Infer From `repair_queue[0]` Forever

This option leaves `/trading/revenue-repair` unchanged and makes Jangar infer the top queue item whenever the explicit
field is missing.

Advantages:

- Fastest implementation in Jangar.
- Preserves the current Torghut endpoint shape.
- Gives observe-mode consumers a usable stopgap.

Disadvantages:

- Keeps the business contract ambiguous.
- Makes schema mismatches look like business decisions.
- Forces every downstream consumer to duplicate fallback logic.
- Does not help deployers prove endpoint parity.

Decision: reject as steady state. Permit inference only as an observe-mode bridge.

### Option B: Move All Business Evidence To `/trading/consumer-evidence`

This option makes Jangar ignore `/trading/revenue-repair` and rely only on the consumer-evidence projection.

Advantages:

- Consumer evidence already carries a rich cross-plane payload.
- It is closer to Jangar's current `/ready` projection.
- It reduces one direct endpoint dependency.

Disadvantages:

- The mission requirement names `/trading/revenue-repair` as the live business evidence surface.
- Consumer evidence mixes many contracts and can be too large for a direct repair budget.
- It does not make the business endpoint safer for humans or deployers.
- It hides revenue repair behind a projection path instead of fixing the source.

Decision: reject.

### Option C: Revenue-Repair Topline Contract With Alpha Evidence Budget

This option tightens `/trading/revenue-repair` and exports the compact fields Jangar needs while keeping rich
consumer evidence available.

Advantages:

- Directly targets the live top queue item.
- Keeps `/trading/revenue-repair` authoritative.
- Lets Jangar distinguish business holds from transport gaps.
- Gives implementers and deployers one compact validation surface.
- Preserves zero-notional capital safety.

Disadvantages:

- Requires endpoint shape tests and backward-compatible field additions.
- Adds a second compact projection to maintain beside consumer evidence.
- Can expose nulls as explicit holds until all producers are wired.

Decision: accept.

## Architecture Contract

`/trading/revenue-repair` must emit these top-line fields every time the endpoint returns HTTP 200:

- `schema_version=torghut.revenue-repair-digest.v1`.
- `generated_at`, `fresh_until`, `business_state`, `revenue_ready`, `capital_state`, `capital_stage`,
  `live_submission_allowed`, `max_notional`.
- `repair_queue` and `top_repair_queue_item`.
- `selected_value_gate`, `required_output_receipt`, `required_receipts`.
- `selected_hypothesis_id`, `selected_candidate_id`, `selected_strategy_id`, `selected_dataset_snapshot_ref`.
- `routeable_candidate_count_before`, `routeable_candidate_count_after`, `accepted_routeable_candidate_count`, and
  `routeable_candidate_delta`.
- `alpha_no_delta_release_key`, `no_delta_reentry_decision`, `no_delta_reentry_reason_codes`.
- `repair_bid_settlement_status`, `repair_bid_settlement_selected_lot_ids`,
  `repair_bid_settlement_dispatchable_lot_ids`, and `repair_bid_settlement_held_lot_ids`.
- `evidence_clock_state`, `evidence_clock_custody_status`, `route_warrant_state`.
- `jangar_material_evidence_settlement_ref`, when imported from Jangar.
- `validation_commands` for the selected top repair lane.
- `rollback_target`.

If a value is not available, the endpoint must return a typed reason instead of silent null where possible:

- `field_unavailable_reason_codes`.
- `transport_evidence_refs`.
- `producer_component`.
- `expected_repair_action`.

The endpoint may remain HTTP 200 when business state is `repair_only`. `/readyz` may remain HTTP 503 when capital
safety requires it.

## Alpha Evidence Budget

The budget is deliberately small:

- maximum selected tickets: `1`;
- maximum parallelism: `1`;
- max notional: `0`;
- live submission: disabled;
- target value gate: `routeable_candidate_count`;
- primary receipt: `torghut.executable-alpha-receipts.v1`;
- secondary receipts: empirical job freshness, market-context freshness, execution TCA currentness, or Jangar
  material settlement only when named as release conditions.

Measurable hypotheses:

- If H-MICRO-01 is selected and empirical evidence becomes current, the next settlement must either increase accepted
  routeable candidate count above zero or write a new no-delta settlement with a changed release key.
- If market-context freshness is selected, news, regime, and technicals freshness must move under the configured
  staleness window before alpha reentry is attempted again.
- If execution TCA is selected, fill/slippage quality must become current for the selected candidate before alpha
  reentry is attempted again.
- If Jangar material settlement is selected, the imported settlement id must match the source revenue-repair digest
  and the top queue item before Torghut opens another no-delta repair ticket.

## Implementation Scope

Engineer stage should implement this in two bounded changes:

1. Add a direct topline serializer in `revenue_repair.py` and endpoint assembly in `main.py`, with tests that prove
   `top_repair_queue_item` equals `repair_queue[0]` and that missing producer data produces typed reason codes.
2. Add Jangar material settlement import fields behind an optional parser, defaulting to absent-but-typed until the
   Jangar companion PR ships.

The implementation must be backward compatible. Existing consumers can continue reading `repair_queue`.

## Validation Gates

Required local checks for Torghut implementation:

- `pytest services/torghut/tests/test_build_revenue_repair_digest.py`
- `pytest services/torghut/tests/test_no_delta_repair_reentry_auction.py`
- `pytest services/torghut/tests/test_consumer_evidence.py -k revenue`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Required live read-only checks after rollout:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq
'{business_state,revenue_ready,top_repair_queue_item,selected_value_gate,routeable_candidate_delta,max_notional}'`
- `curl -sS http://torghut.torghut.svc.cluster.local/readyz`
- `curl -fsS http://agents.agents.svc.cluster.local/ready | jq
'{business_state,revenue_ready,top_repair_queue_item,material_evidence_settlement_spine}'`
- `kubectl get applications -n argocd torghut jangar agents`

Acceptance gates:

- `top_repair_queue_item` is present and equals `repair_queue[0]`.
- `business_state=repair_only` and `max_notional=0` remain explicit while alpha readiness is blocked.
- Routeable candidate count movement or no-delta release-key state is present.
- Jangar can classify missing data as transport/schema hold rather than business truth.
- No implementation opens live submission or positive-notional capital.

## Rollout

1. Ship top-line fields as additive JSON under the existing endpoint.
2. Keep `/readyz` degraded when capital safety requires it.
3. Compare `/trading/revenue-repair`, `/trading/consumer-evidence`, and Jangar `/ready` for three refresh windows.
4. Let Jangar consume the fields in observe mode first.
5. Only after Jangar settlement parity should a single zero-notional repair ticket be admitted.

## Rollback

Rollback is additive:

- stop emitting new top-line fields or ignore them in Jangar;
- keep existing `repair_queue` and consumer evidence as the source for current dashboards;
- keep live submission disabled;
- keep `max_notional=0`;
- keep alpha no-delta release keys active until changed evidence invalidates them.

## Risks

- Endpoint shape growth can make `/trading/revenue-repair` too large. Keep the top-line compact and leave verbose
  arrays in consumer evidence.
- Explicit null reasons may reveal producer gaps that were previously hidden. That is desirable, but dashboards should
  label them as transport or producer debt.
- Jangar import fields can be stale if source SHA and revenue-repair digest are not part of the tuple. Include both.
- A one-ticket budget can delay unrelated profitable work. The current evidence shows alpha readiness is the top
  queue item, so that is the correct constraint for this pass.

## Engineer Handoff

Next implementation milestone:

- Objective: make `/trading/revenue-repair` contract-complete for top repair, routeable-candidate movement,
  no-delta state, repair-bid settlement, and Jangar settlement import.
- Files likely changed: `services/torghut/app/trading/revenue_repair.py`, `services/torghut/app/main.py`, focused
  Torghut tests, and possibly consumer-evidence serialization tests.
- Production gate: direct endpoint and consumer evidence agree on the top queue item and value gate.
- Required evidence: local tests above plus live endpoint parity after rollout.

## Deployer Handoff

After engineer PR merge and image promotion, deployer must prove:

- Argo `torghut`, `jangar`, and `agents` are `Synced/Healthy`.
- Torghut live revision is ready.
- `/trading/revenue-repair.top_repair_queue_item.code=repair_alpha_readiness` while the top queue remains unchanged.
- `/readyz` degradation is limited to capital-safety and proof-floor reasons.
- Jangar settlement can read the same top queue item without queue-head inference.
