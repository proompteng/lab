# 212. Torghut Consumer-Evidence Parity And Alpha Release Freshness (2026-05-14)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: strategy/alpha/discovery/profile modules and tests exist, but research strategy proposals are not all promoted runtime strategies.
- Matched implementation area: Strategy, alpha, TSMOM, regime, portfolio, and sizing.
- Current source evidence:
  - `services/torghut/app/strategies/catalog.py`
  - `services/torghut/app/trading/alpha/tsmom.py`
  - `services/torghut/app/trading/strategy_runtime`
  - `services/torghut/app/trading/discovery/candidate_specs.py`
  - `services/torghut/app/trading/portfolio`
- Design drift note: A research/stress module is not enough to call a strategy live; promotion still depends on proof/readiness gates.


## Decision

I am selecting **consumer-evidence parity as the release precondition for the next alpha-readiness repair**.

The live business evidence is clear. `/trading/revenue-repair` on 2026-05-14 at 20:10Z returned
`business_state=repair_only`, `revenue_ready=false`, `readyz_status=degraded`, active revision `torghut-00415`, and
top repair `repair_alpha_readiness`. The selected value gate remained `routeable_candidate_count`; accepted routeable
candidates were still `0`; and capital stayed `max_notional=0`.

The selected lane was not random. The alpha-readiness settlement conveyor selected `H-MICRO-01` with strategy
`microbar_volume_continuation_long_top2_chip_v1@paper`, lane `microstructure-breakout`, reason
`drift_checks_missing`, and lane score `105`. It carried the required receipts that can plausibly move the value gate:
`feature_replay_receipt`, `drift_check_receipt`, `required_feature_set_receipt`, and
`torghut.alpha-readiness-settlement-receipt.v1`. It also reported no routeable-candidate delta and denied repeat
launch under the active no-delta release key.

The control-plane dependency is now the narrow risk. Direct revenue repair classified Jangar controller-ingestion carry
as `lagging` and named a Jangar settlement ref. The Jangar-facing consumer-evidence compact path could still show the
same carry family as `unavailable` with a missing settlement ref. Jangar is supposed to consume the compact boundary.
If the compact boundary is stale or lossy, Jangar cannot safely distinguish "run H-MICRO feature replay" from
"refresh the evidence projection first."

The selected design adds `torghut.consumer-evidence-parity-ledger.v1`. It is a Torghut-side ledger that compares the
direct revenue-repair digest to the compact consumer-evidence payload before Jangar acts on it. The ledger must be
mirrored through `/trading/consumer-evidence` and included in `/trading/revenue-repair`. It produces a parity state and
a selected zero-notional release action:

- `current`: consumer evidence and revenue repair agree on the carry state, selected lane, no-delta release key,
  routeable-candidate count, and max notional;
- `lagging`: direct revenue repair has newer refs than compact consumer evidence;
- `stale`: either surface expired;
- `missing`: required compact refs are absent;
- `contradicted`: fresh surfaces disagree on selected lane, value gate, release key, or notional.

The tradeoff is that Torghut will sometimes select projection refresh ahead of H-MICRO feature replay. I accept that.
Profitability improves when the next repair is the one that can actually change `routeable_candidate_count`, not when
we create more zero-notional work against an unchanged release key.

## Governing Runtime Requirements

This contract implements the active cross-swarm requirements:

- every implementation run must cite this design or its companion Jangar design before changing code;
- implement stages must ship production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, service health, and business evidence;
- final handoff must name the control-plane or revenue metric improved or the smallest blocker preventing improvement.

Jangar value-gate mapping:

- `failed_agentrun_rate`: Jangar does not launch duplicate repair work from stale consumer evidence.
- `pr_to_rollout_latency`: deployers can see whether the rollout is blocked by source, serving, or projection parity.
- `ready_status_truth`: Torghut keeps revenue truth and consumer truth separate until parity is proven.
- `manual_intervention_count`: the ledger replaces manual endpoint diffing.
- `handoff_evidence_quality`: handoffs cite parity ledger id, selected release action, no-delta release key, and
  validation commands.

Torghut value-gate mapping:

- `routeable_candidate_count`: H-MICRO feature replay is selected only when parity is current or the release key has
  changed.
- `zero_notional_or_stale_evidence_rate`: stale compact projection becomes explicit repair debt.
- `fill_tca_or_slippage_quality`: TCA remains a separate lane and cannot bypass alpha-readiness parity.
- `post_cost_daily_net_pnl`: no paper or live widening is authorized.
- `capital_gate_safety`: all actions remain `max_notional=0`.

## Current Evidence

All evidence below was collected read-only on 2026-05-14. I did not mutate database rows, Kubernetes resources,
trading flags, broker state, market data, or AgentRuns.

### Revenue-Repair Surface

- `/trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, active revision
  `torghut-00415`, and `readyz_status=degraded`.
- The repair queue had five items. The top item was `repair_alpha_readiness`, reason
  `hypothesis_not_promotion_eligible`, priority `70`, value gate `routeable_candidate_count`, required output
  `torghut.executable-alpha-receipts.v1`, and `max_notional=0`.
- Lower-priority items were live submit disabled, empirical jobs degraded, generic degraded state, and empirical jobs
  not ready.
- Routeability acceptance reported aggregate state `blocked` and accepted routeable candidates `0`.
- Route evidence clearinghouse reported accepted routeable candidates `0`, held route claims `3`, and selected repair
  bids across `post_cost_daily_net_pnl`, `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`,
  `fill_tca_or_slippage_quality`, and `capital_gate_safety`.

### Alpha-Readiness Surface

- All three primary hypotheses were still `shadow` and not promotion eligible.
- `H-MICRO-01` was selected because it is the best current routeable-candidate repair lane.
- The preserved blocker for H-MICRO was `drift_checks_missing`.
- The conveyor reported `routeable_candidate_count_before=0`, `routeable_candidate_count_after=0`, and measured delta
  `0`.
- The settlement receipt funded only `torghut.alpha-readiness-settlement-receipt.v1`; it still missed
  `alpha_readiness_receipt`, `capital_replay_board`, `hypothesis_promotion_receipt`,
  `torghut.executable-alpha-receipts.v1`, `feature_replay_receipt`, `drift_check_receipt`, and
  `required_feature_set_receipt`.
- Active no-delta leases existed for H-MICRO, H-REV, and H-CONT. Repeat launch was denied.

### Jangar Carry And Consumer Evidence Surface

- Direct revenue repair reported `jangar_controller_ingestion_carry.carry_state=lagging`.
- The same direct payload carried a non-null `source_jangar_settlement_ref`, Jangar settlement decision `hold`,
  `jangar_controller_ingestion_current=false`, and a non-null repair-slot escrow ref.
- The compact consumer-evidence payload sampled in the same window reported carry `unavailable`,
  `source_jangar_settlement_ref=null`, and reason codes `jangar_controller_ingestion_settlement_missing` and
  `jangar_verify_foreclosure_board_missing`.
- The compact no-delta auction ref still denied reentry with active no-delta release key and
  `jangar_verification_carry_unavailable`.

### Data And Schema Surface

- `/db-check` returned `ok=true`, `schema_current=true`, and `schema_graph_lineage_ready=true`.
- The Torghut database pod `torghut-db-1` was `1/1 Running`, with two restarts 37 hours earlier.
- Direct CNPG cluster reads are blocked for the swarm worker by Kubernetes RBAC. That is the right operational
  posture. Torghut should expose business and schema truth through typed endpoints, not privileged database access.
- No evidence authorizes live submission. Capital remains `zero_notional`.

### Source And Test Surface

- The implementation ownership is narrow:
  - `services/torghut/app/trading/consumer_evidence_parity_ledger.py`;
  - `services/torghut/app/main.py` for revenue-repair and consumer-evidence projection;
  - `services/torghut/app/trading/no_delta_repair_reentry_auction.py` for selected release condition consumption;
  - `services/torghut/tests/test_consumer_evidence_parity_ledger.py`;
  - targeted updates to `test_build_revenue_repair_digest.py`, `test_trading_api.py`, and
    `test_no_delta_repair_reentry_auction.py`.
- Existing adjacent coverage already includes Jangar carry import, no-delta auction, alpha readiness conveyor, alpha
  repair dividend ledger, and revenue-repair digest construction.
- The missing coverage is compact/direct parity: current, lagging, stale, missing, contradicted, and projection-refresh
  ticket selection.

## Problem

Torghut currently publishes enough direct revenue-repair evidence to make a good decision, but the compact
consumer-evidence boundary can lag or drop the exact refs Jangar needs. That creates four bad outcomes:

1. Jangar holds on an unavailable carry state after Torghut has already classified it as lagging.
2. Jangar launches or denies work from a compact payload that does not match the direct business digest.
3. H-MICRO feature replay competes with projection refresh even when the no-delta release key is unchanged.
4. Deployer handoffs have to summarize two large endpoints by hand.

The fix is not a bigger endpoint dump. The fix is a compact parity ledger with explicit release actions.

## Alternatives Considered

### Option A: Make `/trading/revenue-repair` The Only Authority

Jangar would stop consuming compact consumer evidence and call direct revenue repair for all material decisions.

Advantages:

- Uses the richest payload.
- Avoids compact projection loss.
- Fastest way to reason about H-MICRO release conditions.

Disadvantages:

- It makes Jangar more tightly coupled to a large endpoint.
- It risks putting direct Torghut fetch latency on Jangar status paths.
- It removes the purpose of the Jangar-facing consumer-evidence contract.
- It does not solve projection truth for other consumers.

Decision: reject.

### Option B: Keep Consumer Evidence As Best Effort

Torghut keeps mirroring compact refs and relies on Jangar to tolerate nulls, stale refs, and missing settlement ids.

Advantages:

- No new Torghut reducer.
- No compatibility change.
- Existing no-delta denial remains safe.

Disadvantages:

- It keeps the current failure mode.
- It increases manual endpoint diffing.
- It cannot select projection refresh as a repair action.
- It can keep `routeable_candidate_count` stuck while the system argues about carry state.

Decision: reject.

### Option C: Publish Consumer-Evidence Parity Ledger

Torghut compares direct revenue repair to compact consumer evidence and publishes a compact parity ledger through both
surfaces.

Advantages:

- Names the exact projection drift.
- Lets Jangar hold or repair for the right reason.
- Preserves compact consumer evidence as the Jangar boundary.
- Protects no-delta releases from duplicate alpha repair.
- Gives H-MICRO feature replay a clean precondition.

Disadvantages:

- Adds a reducer, tests, and one compact schema.
- Requires care to avoid comparing diagnostic-only fields that may legitimately differ.
- Can delay H-MICRO repair until projection truth catches up.

Decision: select Option C.

## Architecture

### Contract Shape

Torghut adds:

```yaml
schema_version: torghut.consumer-evidence-parity-ledger.v1
ledger_id: consumer-evidence-parity-ledger:<digest>
generated_at: <iso8601>
fresh_until: <iso8601>
source_revenue_repair_ref: <digest-ref>
source_consumer_evidence_ref: <receipt/ref|null>
business_state: repair_only|ready|blocked
revenue_ready: true|false
selected_value_gate: routeable_candidate_count
selected_hypothesis_id: H-MICRO-01|null
revenue_no_delta_release_key: <key|null>
consumer_no_delta_release_key: <key|null>
revenue_carry_state: current|repairable|lagging|unavailable|stale|contradicted|unknown
consumer_carry_state: current|repairable|lagging|unavailable|stale|contradicted|unknown
revenue_routeable_candidate_count: <int|null>
consumer_routeable_candidate_count: <int|null>
parity_state: current|lagging|stale|missing|contradicted
selected_release_action: none|consumer_evidence_projection_refresh|alpha_feature_replay|controller_ingestion_repair
selected_ticket_id: <id|null>
required_output_receipt: <schema|null>
max_notional: '0'
reason_codes: []
validation_commands: []
rollback_target: <string>
```

The compact ref mirrored through `/trading/consumer-evidence` must include:

```yaml
schema_version: torghut.consumer-evidence-parity-ledger-ref.v1
ledger_schema_version: torghut.consumer-evidence-parity-ledger.v1
ledger_id: <id>
generated_at: <iso8601>
fresh_until: <iso8601>
parity_state: current|lagging|stale|missing|contradicted
selected_release_action: <action>
selected_value_gate: routeable_candidate_count
selected_hypothesis_id: H-MICRO-01|null
revenue_carry_state: <state>
consumer_carry_state: <state>
reason_codes: []
max_notional: '0'
```

### Compared Fields

The parity ledger compares only fields that must agree for material action:

- selected value gate;
- selected hypothesis id;
- no-delta release key;
- no-delta reentry decision;
- routeable-candidate count before and after;
- Jangar controller-ingestion carry state;
- Jangar settlement ref presence;
- repair-slot escrow ref presence;
- max notional;
- freshness windows;
- required output receipt for the selected repair.

It must not compare diagnostic-only fields such as full repair queue ordering, full evidence window arrays, raw route
claims, or descriptive text. Those can differ without invalidating the compact action boundary.

### Release Action Rules

`consumer_evidence_projection_refresh` is selected when:

- direct revenue repair has a fresh Jangar settlement ref that compact consumer evidence lacks;
- direct revenue repair has a newer carry state than compact consumer evidence;
- direct revenue repair and compact consumer evidence disagree on no-delta release key or selected lane;
- compact consumer evidence is stale while direct revenue repair is fresh.

`alpha_feature_replay` is selected only when:

- parity state is `current`;
- selected lane is H-MICRO or another lane explicitly chosen by the alpha-readiness conveyor;
- no-delta release key changed, expired, or was retired by a receipt;
- required feature replay, drift check, and feature-set receipts are still missing;
- max notional is `0`.

`controller_ingestion_repair` is selected when:

- Jangar settlement says controller ingestion is repairable;
- direct and compact surfaces agree on that selected Jangar repair;
- the selected ticket is zero-notional.

`none` is selected when:

- parity state is current but no release condition changed;
- parity state is contradicted and the safe answer is block;
- live or paper notional would be required.

## Implementation Scope

Engineer milestone 1: Torghut parity reducer.

- Add `services/torghut/app/trading/consumer_evidence_parity_ledger.py`.
- Unit-test current, lagging, stale, missing, contradicted, and projection-refresh action selection.
- Value gates: `zero_notional_or_stale_evidence_rate`, `handoff_evidence_quality`.

Engineer milestone 2: Revenue-repair and consumer-evidence projection.

- Attach full parity ledger to `/trading/revenue-repair`.
- Mirror compact parity ref through `/trading/consumer-evidence`.
- Ensure generated refs are stable for the same compared field set.
- Value gates: `ready_status_truth`, `manual_intervention_count`.

Engineer milestone 3: No-delta auction release action.

- Let the no-delta auction prefer `consumer_evidence_projection_refresh` while parity is lagging or missing.
- Permit `alpha_feature_replay` only after parity is current and release conditions changed.
- Value gates: `routeable_candidate_count`, `failed_agentrun_rate`, `capital_gate_safety`.

## Validation Gates

Required local checks for the Torghut implementation PR:

```bash
cd services/torghut && uv run --frozen pytest tests/test_consumer_evidence_parity_ledger.py
cd services/torghut && uv run --frozen pytest tests/test_build_revenue_repair_digest.py -k consumer_evidence_parity
cd services/torghut && uv run --frozen pytest tests/test_trading_api.py -k consumer_evidence_parity
cd services/torghut && uv run --frozen pytest tests/test_no_delta_repair_reentry_auction.py -k consumer_evidence_projection
cd services/torghut && uv run --frozen pyright --project pyrightconfig.json
cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json
cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json
```

Required rollout checks before deployer marks it healthy:

```bash
kubectl get applications.argoproj.io -n argocd torghut agents jangar symphony-torghut
kubectl get deployments -n torghut
curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.consumer_evidence_parity_ledger'
curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.consumer_evidence_parity_ledger'
curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.consumer_evidence_parity_settlement'
curl -fsS http://agents.agents.svc.cluster.local/ready | jq '{status,business_state,revenue_ready,top_repair_queue_item}'
```

Acceptance requires:

- full and compact parity refs are present;
- parity state is not `missing` for fields required by Jangar;
- selected release action is projection refresh while compact evidence lags;
- selected release action is alpha feature replay only after parity is current and release conditions changed;
- routeable candidate count is reported on both surfaces;
- `max_notional` remains `0`;
- no live submission is enabled.

## Rollout Plan

1. Ship the parity ledger in observe mode.
2. Mirror compact refs to `/trading/consumer-evidence`.
3. Validate direct revenue-repair and compact consumer-evidence parity over at least one healthy Torghut rollout.
4. Let Jangar consume parity in observe mode.
5. Permit no-delta auction selection of projection refresh.
6. Permit H-MICRO alpha feature replay only after parity current and release conditions changed.

## Rollback Plan

Rollback is additive:

- stop emitting `consumer_evidence_parity_ledger`;
- keep existing no-delta auction, alpha-readiness conveyor, alpha repair dividend ledger, and Jangar carry import;
- keep `/trading/consumer-evidence` on its prior compact fields;
- keep `max_notional=0`;
- keep live submit disabled until repair queue clears.

Rollback success is:

- `/trading/revenue-repair` still returns `repair_only`;
- `/trading/consumer-evidence` still returns existing compact refs;
- Jangar continues to hold material actions through existing controller-ingestion, no-delta, and repair-slot gates;
- no paper or live capital is enabled.

## Risks And Mitigations

- Risk: parity compares too much and creates false lag. Mitigation: compare only material action fields listed above.
- Risk: parity current is mistaken for routeability. Mitigation: routeable-candidate count and capital gates remain
  separate acceptance criteria.
- Risk: projection refresh becomes a sink for repeated zero-delta work. Mitigation: selection requires a stale or
  missing compact ref and must carry its own dedupe key.
- Risk: H-MICRO feature replay is delayed. Mitigation: this is acceptable until the consumer boundary proves the same
  selected lane and no-delta release key as direct revenue repair.
- Risk: Jangar and Torghut name different states. Mitigation: companion designs define the shared state vocabulary.

## Handoff Contract

Engineer handoff must include:

- governing design refs: this document and the Jangar companion;
- files changed and tests run;
- direct revenue-repair parity sample;
- compact consumer-evidence parity sample;
- selected release action;
- whether `routeable_candidate_count` moved above `0`; if not, the smallest blocker.

Deployer handoff must include:

- PR URL and merge commit;
- Argo status for `torghut`, `agents`, `jangar`, and `symphony-torghut`;
- workload readiness for the active Torghut revision and dependent services;
- `/trading/revenue-repair` parity state;
- `/trading/consumer-evidence` parity ref;
- Jangar full-status parity result after consumption;
- rollback target.

The next bounded implementation milestone is Torghut milestone 1: add the parity reducer and mirror the compact
parity ref. It maps to `zero_notional_or_stale_evidence_rate`, `failed_agentrun_rate`, `ready_status_truth`, and
`handoff_evidence_quality`, and it is the smallest safe blocker before another H-MICRO feature replay attempt.
