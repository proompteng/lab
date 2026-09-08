# 213. Torghut Repair-Bid Settlement Ledger And Route Warrant Runway (2026-05-15)

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

I am selecting a **repair-bid settlement ledger with route-warrant runway** as Torghut's next companion architecture
increment.

The live business evidence is still a zero-notional repair problem, not a capital-widening problem. On 2026-05-15 at
00:26Z, `/trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, and a top repair queue
item `repair_alpha_readiness`. That item targeted `routeable_candidate_count`, required
`torghut.executable-alpha-receipts.v1`, and carried `max_notional=0`. The alpha-readiness conveyor selected
`H-MICRO-01`, candidate `chip-paper-microbar-composite@execution-proof`, strategy
`microbar_volume_continuation_long_top2_chip_v1@paper`, and lane `microstructure-breakout`. The measured routeable
candidate delta was `0`.

The current no-delta result is valid. It preserves capital safety and denies repeat launch while the evidence window,
blocker set, source ref, and required receipts are unchanged. The problem is the export boundary: Jangar is now holding
source-serving on missing `route_warrant_exchange` and `repair_bid_settlement_ledger` contracts. Torghut has enough
internal repair context to explain top queue, lane, no-delta leases, required receipts, and missing blockers, but it
does not yet export the compact pair Jangar needs for material action custody.

The selected design adds two compact exports:

- `torghut.repair-bid-settlement-ledger.v1`, a compact ledger of selected and held repair lots for the live top queue;
- `torghut.route-warrant-exchange.v1`, a compact routeability warrant that says whether the selected lane can produce a
  routeable candidate and which receipt would change that decision.

Both exports remain zero notional. Both are included in `/trading/consumer-evidence` and summarized by
`/trading/revenue-repair`. Jangar's source-contract debt exchange consumes them and retires the missing contract pair
only when they are current, tied to the top queue, and not contradicted by active no-delta leases.

The tradeoff is that Torghut adds settlement exports before trying another alpha repair. I accept that because the top
business blocker is not lack of activity. It is lack of settled routeable-candidate evidence that Jangar can safely use
to admit the next bounded run.

## Governing Runtime Requirements

This contract implements the active Torghut and Jangar validation requirements:

- every implementation run must cite this design or its Jangar companion before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, service health, and business evidence;
- final handoff must name the revenue or control-plane metric improved or the smallest blocker preventing improvement.

Value-gate mapping:

- `routeable_candidate_count`: the route-warrant exchange must explain the selected lane's candidate count, delta, and
  required receipt before any repair is considered successful.
- `zero_notional_or_stale_evidence_rate`: stale ledgers and active no-delta leases preserve repair-only state.
- `fill_tca_or_slippage_quality`: execution quality work waits until the route warrant identifies a routeable
  candidate set or a route-specific TCA blocker.
- `post_cost_daily_net_pnl`: no paper or live stage is admitted by this design.
- `capital_gate_safety`: every ledger row and route warrant carries `max_notional=0`; nonzero notional invalidates the
  export.

Jangar value-gate mapping:

- `failed_agentrun_rate`: Jangar can deny repeat dispatch when the selected ledger lot and no-delta release key are
  unchanged.
- `pr_to_rollout_latency`: deployer handoff checks one compact route warrant and one compact repair-bid ledger instead
  of broad payload scans.
- `ready_status_truth`: Jangar can keep serving health separate from material contract authority.
- `manual_intervention_count`: the missing contract pair becomes a concrete export and validation command.
- `handoff_evidence_quality`: engineer and deployer stages cite ledger id, route warrant id, selected queue item,
  selected lane, and rollback target.

## Current Evidence

All evidence was collected read-only on 2026-05-15. I did not mutate database records, Kubernetes resources, trading
flags, broker state, AgentRuns, GitOps resources, or market data.

### Revenue-Repair Surface

- `/trading/revenue-repair` reported `business_state=repair_only` and `revenue_ready=false`.
- Top queue item: `repair_alpha_readiness`.
- Top reason: `hypothesis_not_promotion_eligible`.
- Value gate: `routeable_candidate_count`.
- Required output receipt: `torghut.executable-alpha-receipts.v1`.
- Capital rule: `zero_notional_repair_only`, with `max_notional=0`.
- Lower priority repairs included live submit gate, empirical jobs, degraded state, and empirical jobs not ready.

### Alpha-Readiness Conveyor Surface

- Conveyor schema: `torghut.alpha-readiness-settlement-conveyor.v1`.
- Conveyor state: `no_delta`.
- Selected queue code: `repair_alpha_readiness`.
- Selected lane: `H-MICRO-01`, `microstructure-breakout`.
- Selected strategy: `microbar_volume_continuation_long_top2_chip_v1@paper`.
- Routeable candidate count: `0 -> 0`, measured delta `0`.
- Active no-delta lease count: `3`.
- Missing receipts included `alpha_readiness_receipt`, `capital_replay_board`,
  `hypothesis_promotion_receipt`, `torghut.executable-alpha-receipts.v1`, `feature_replay_receipt`,
  `drift_check_receipt`, and `required_feature_set_receipt`.
- The selected lane preserved `drift_checks_missing` and `closed_session_signal_hold`.

### Consumer Evidence Surface

- `/trading/consumer-evidence` included a compact alpha-readiness conveyor ref with status `no_delta`.
- In the sampled response, `route_warrant_state`, `repair_bid_settlement_status`, routeability aggregate state, and
  profit freshness state were null.
- Jangar ready truth sampled shortly afterward saw Torghut consumer evidence intermittently unavailable on the hot
  path. That reinforces the need for compact, current, TTL-bound exports.

### Cluster And Data Surface

- `jangar` and `torghut` Argo applications were `Synced/Healthy`; `agents` was `OutOfSync/Healthy`.
- Jangar and agents deployments were rolled out, but recent events still showed readiness probe timeouts and
  BackoffLimitExceeded verify jobs.
- Direct CNPG psql is forbidden to the swarm service account. Torghut `/db-check` returned `ok=true`,
  `schema_current=true`, and `schema_graph_lineage_ready=true`, so application witnesses are the right data boundary.

### Source And Test Surface

- High-risk Torghut producers are `revenue_repair.py` at `1208` lines, `alpha_readiness_settlement_conveyor.py` at
  `849` lines, `jangar_controller_ingestion_carry.py` at `595` lines, and `consumer_evidence.py` at `406` lines.
- Existing tests cover revenue repair, consumer evidence, alpha-readiness settlement, executable alpha receipts, and
  repair-bid settlement surfaces.
- The missing test family is compact export parity: ledger id stability, selected lot compaction, route warrant state,
  active no-delta dedupe key, zero-notional enforcement, consumer-evidence export, and Jangar import compatibility.

## Problem

Torghut has a valid alpha-readiness no-delta conveyor, but Jangar needs a narrower contract to admit the next repair
without opening broad dispatch. The missing Jangar contracts are not generic. They are `route_warrant_exchange` and
`repair_bid_settlement_ledger`.

The concrete failure modes are:

1. Revenue repair can keep naming `repair_alpha_readiness` while Jangar sees no route warrant or settlement ledger.
2. Consumer evidence can carry a conveyor ref but leave route warrant and repair-bid settlement fields null.
3. Active no-delta leases can prevent duplicate alpha repair but still leave Jangar without a positive receipt to
   retire source-serving debt.
4. A healthy database head can be misread as route readiness even when routeable candidate count is zero.
5. A transient unavailable consumer-evidence read can force Jangar to hold broad work without a compact cached receipt.
6. Engineers can spend the next run on drift, feature replay, or TCA without first creating the contract Jangar is
   explicitly missing.

## Alternatives Considered

### Option A: Keep The Current Alpha Conveyor As The Only Export

Torghut would continue exporting the alpha-readiness conveyor ref and leave Jangar to infer route warrant and
repair-bid settlement state from broad revenue repair payloads.

Advantages:

- No new export schemas.
- No new compatibility surface.
- Existing no-delta behavior remains safe.

Disadvantages:

- Does not retire Jangar's missing contract pair.
- Keeps deployer and engineer handoffs dependent on broad payload inspection.
- Does not give Jangar a stable dedupe key for selected repair-bid debt.
- Does not improve `manual_intervention_count` or `handoff_evidence_quality`.

Decision: reject.

### Option B: Repair Drift And Feature Replay Before Exporting The Contract Pair

Torghut would work directly on `drift_checks_missing`, `feature_replay_receipt`, and
`required_feature_set_receipt` for `H-MICRO-01`.

Advantages:

- Directly targets real alpha blockers.
- Could eventually move `routeable_candidate_count`.
- Uses trading-domain evidence rather than control-plane plumbing.

Disadvantages:

- Jangar is currently blocked on missing route warrant and repair-bid settlement contracts, so another alpha repair
  can still be denied as duplicate no-delta debt.
- It does not create the export that lets Jangar admit one bounded repair lot.
- It risks spending a runner on evidence that cannot be routed or handed off cleanly.

Decision: reject as the next slice. Keep it as the second slice after contract exports are current.

### Option C: Repair-Bid Settlement Ledger With Route-Warrant Runway

Torghut emits compact settlement and route-warrant exports for the live top queue and selected lane. Jangar consumes
them through the companion source-contract debt exchange.

Advantages:

- Directly retires the source-serving contract pair Jangar is missing.
- Keeps all work zero notional.
- Converts no-delta leases into stable dispatch dedupe.
- Gives deployer and verifier stages one compact business receipt pair.
- Preserves Torghut ownership of trading lane selection.

Disadvantages:

- Adds two compact schemas.
- Requires Jangar compatibility tests.
- Does not itself clear drift or feature replay blockers.

Decision: select Option C.

## Architecture

Torghut adds `torghut.repair-bid-settlement-ledger.v1`:

```yaml
schema_version: torghut.repair-bid-settlement-ledger.v1
ledger_id: repair-bid-settlement-ledger:<digest>
generated_at: <iso8601>
fresh_until: <iso8601>
business_state: repair_only
revenue_ready: false
top_queue_code: repair_alpha_readiness
selected_hypothesis_id: H-MICRO-01
selected_value_gate: routeable_candidate_count
selected_lot_ids: []
dispatchable_lot_ids: []
held_lot_ids: []
active_dedupe_keys: []
active_no_delta_release_keys: []
required_output_receipts:
  - torghut.executable-alpha-receipts.v1
  - torghut.route-warrant-exchange.v1
max_notional: '0'
decision: allow|hold|block|no_delta
reason_codes: []
validation_commands: []
rollback_target: stop exporting repair_bid_settlement_ledger and keep max_notional=0
```

Torghut adds `torghut.route-warrant-exchange.v1`:

```yaml
schema_version: torghut.route-warrant-exchange.v1
route_warrant_id: route-warrant-exchange:<digest>
generated_at: <iso8601>
fresh_until: <iso8601>
selected_hypothesis_id: H-MICRO-01
selected_lane_id: microstructure-breakout
selected_strategy_id: microbar_volume_continuation_long_top2_chip_v1@paper
routeable_candidate_count_before: 0
routeable_candidate_count_after: 0
measured_routeable_candidate_delta: 0
route_warrant_state: missing|no_delta|repairable|routeable|blocked
required_receipts: []
missing_receipts: []
no_delta_release_key: <key|null>
repeat_launch_decision: allow|deny
max_notional: '0'
capital_rule: zero_notional_repair_only
reason_codes: []
```

Export rules:

- `/trading/revenue-repair` includes the full ledger and route warrant when requested by existing detail mode, plus
  compact refs in the default payload.
- `/trading/consumer-evidence` includes `repair_bid_settlement_ledger_id`, `repair_bid_settlement_status`,
  `route_warrant_id`, `route_warrant_state`, selected value gate, selected hypothesis, and validation command.
- The ledger is invalid if `max_notional` is not zero.
- The route warrant is `no_delta` when routeable candidate count stays zero and active no-delta release keys are
  unchanged.
- The route warrant is `repairable` only when a changed source ref, evidence window, blocker set, or required receipt
  set creates a bounded zero-notional repair.
- Jangar may retire source-serving debt only when both exports are fresh and tied to the same top queue and selected
  lane.

## Rollout Plan

1. Emit both exports in shadow from existing revenue repair, alpha-readiness conveyor, no-delta leases, and repair-bid
   settlement helpers.
2. Add consumer-evidence compact fields while keeping legacy fields unchanged.
3. Add tests for no-delta state, zero-notional enforcement, selected lane consistency, TTL freshness, and compact
   export parity.
4. Let Jangar consume the compact refs in observe mode through the companion source-contract debt exchange.
5. Enforce only after Jangar status shows the missing source-serving contracts retired or represented by current debt
   lots.

## Validation Gates

Required local checks for the first implementation PR:

- `uv run --frozen pytest services/torghut/tests/test_repair_bid_settlement.py`
- `uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py`
- `uv run --frozen pytest services/torghut/tests/test_consumer_evidence.py -k "repair_bid or route_warrant"`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Required live validation after rollout:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.repair_bid_settlement_ledger,.route_warrant_exchange'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.repair_bid_settlement_ledger_id,.repair_bid_settlement_status,.route_warrant_id,.route_warrant_state,.max_notional'`
- `curl -fsS http://agents.agents.svc.cluster.local/ready | jq '.source_contract_debt_exchange'`
- `curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.ready_truth_arbiter.material_readiness,.source_contract_debt_exchange'`

Acceptance gates:

- The repair-bid settlement ledger is fresh, zero-notional, and tied to `repair_alpha_readiness`.
- The route-warrant exchange is fresh, zero-notional, and tied to `H-MICRO-01`.
- Active no-delta release keys deny repeat launch when no release condition changed.
- Jangar no longer reports the two contracts as missing once the exports are current.
- Capital remains zero and live submit stays disabled.

## Rollback

Rollback is additive and low risk:

- Stop exporting the new compact fields by setting the route-warrant and repair-bid settlement export mode to
  `observe` or disabled.
- Keep existing revenue repair and consumer evidence payloads.
- Keep alpha-readiness conveyor no-delta behavior.
- Keep `max_notional=0`.
- Tell Jangar to keep source-contract debt exchange in observe mode and fall back to ready truth plus repair-bid
  admission.

## Risks

- False route warrant: mitigated by zero-notional enforcement, selected-lane parity, TTL freshness, and no-delta keys.
- Payload instability: mitigated by compact refs and backwards-compatible legacy fields.
- Over-focusing on control-plane contracts: accepted for the first slice because Jangar is explicitly missing this
  contract pair.
- Delayed alpha blocker repair: accepted until Jangar can safely admit the bounded repair lot that will fund those
  receipts.

## Engineer Handoff

Implement the first production slice in this order:

1. Add the repair-bid settlement ledger builder from current revenue repair and alpha-readiness conveyor inputs.
2. Add the route-warrant exchange builder for the selected top queue and lane.
3. Export compact refs through `/trading/consumer-evidence`.
4. Add tests for zero-notional enforcement, no-delta dedupe, compact export parity, and selected lane consistency.
5. Keep capital disabled and do not change live submit.

The implementation PR is complete when Jangar can consume current ledger and route-warrant refs, or can explain their
absence as explicit source-contract debt.

## Deployer Handoff

After the engineer PR merges and the image is promoted, verify:

- Torghut Argo sync and health;
- Torghut workload readiness;
- `/trading/revenue-repair` still reports `repair_only` and `max_notional=0`;
- `/trading/consumer-evidence` includes current ledger and route-warrant refs;
- Jangar source-contract debt exchange either retires the missing contracts or selects them as bounded zero-notional
  debt lots;
- no paper or live capital path is widened.

Only call the rollout healthy when the compact exports are current and Jangar ready truth no longer depends on manual
inspection of broad Torghut payloads for this missing contract pair.
