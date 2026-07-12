# 197. Torghut Alpha Readiness Strike Ledger And Routeable Candidate Ladder (2026-05-13)

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

I am selecting an **alpha-readiness strike ledger** as the next Torghut quant architecture contract.

The live business surface is no longer asking for a generic proof loop. `/trading/revenue-repair` is explicit:
`business_state=repair_only`, `revenue_ready=false`, `routeable_candidate_count=0`,
`zero_notional_or_stale_evidence_rate=1.0`, `capital_state=zero_notional`, `max_notional=0`, and the top repair queue
item is `repair_alpha_readiness` for `hypothesis_not_promotion_eligible`. The required output receipt is
`torghut.executable-alpha-receipts.v1`, with `alpha_readiness_receipt`, `hypothesis_promotion_receipt`, and
`capital_replay_board` as required receipts.

The mismatch is in dispatch priority. The compacted repair ledger has six lots. It dispatches `quant_pipeline`,
`feature_lineage`, and `execution_tca` first. It selects but holds `rollout_image` and `empirical_replay` on
`dispatch_limit_exceeded`, and it holds the `promotion_custody` lot on `selection_limit_exceeded`. That means the
current runner allocation can keep refreshing evidence around the top business blocker while the routeable-candidate
blocker remains parked.

The strike ledger fixes that mismatch without changing capital posture. When `/trading/revenue-repair.repair_queue[0]`
targets `routeable_candidate_count`, Torghut must publish a bounded zero-notional promotion-custody strike packet that
Jangar can admit ahead of lower-leverage repair lots. The packet must prove before/after evidence, retire or preserve
specific reason codes, and leave `simple_submit_disabled=true`, `capital_state=zero_notional`, and `max_notional=0`
until separate paper/live gates pass.

The tradeoff is throughput. I am taking one dispatch slot away from broad evidence refresh when the revenue queue says
alpha readiness is the top blocker. That is the right trade: clearing quant freshness while routeable candidates stay
at zero does not improve the business metric. The strike lane is narrower, more opinionated, and easier to falsify.

## Governing Runtime Requirements

This contract follows the Torghut quant swarm validation contract:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

The value-gate mapping is direct:

- `routeable_candidate_count`: primary gate. The strike ledger exists to move at least one executable alpha receipt
  from candidate-only to paper-replay-candidate evidence without enabling notional.
- `zero_notional_or_stale_evidence_rate`: the strike packet must report which freshness blockers remain after the
  promotion-custody run.
- `fill_tca_or_slippage_quality`: no alpha receipt can advance if the target symbol still violates the route TCA
  guardrail or lacks required route coverage.
- `post_cost_daily_net_pnl`: promotion custody must bind the candidate to post-cost evidence or deny it with a measured
  blocker.
- `capital_gate_safety`: live submission stays disabled, paper/live canary classes stay held, and the packet carries
  `max_notional=0`.

## Read-Only Evidence Snapshot

Evidence was collected read-only on 2026-05-13 around 20:10 UTC. I did not mutate Kubernetes resources, database
records, trading flags, broker state, or AgentRuns.

### Business Surface

- `/trading/revenue-repair` returned schema `torghut.revenue-repair-digest.v1`.
- `business_state=repair_only` and `revenue_ready=false`.
- Capital state was closed: `live_submission_allowed=false`, `live_submission_reason=simple_submit_disabled`,
  `capital_stage=shadow`, `proof_floor_state=repair_only`, `route_state=repair_only`, `capital_state=zero_notional`,
  and `max_notional=0`.
- The repair queue had two visible business blockers:
  - `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, value gate `routeable_candidate_count`,
    priority `70`, expected unblock value `2`, required output `torghut.executable-alpha-receipts.v1`.
  - `live_submit_gate_closed`, reason `simple_submit_disabled`, value gate `capital_gate_safety`, priority `50`, and
    capital rule `zero_notional_repair_only`.
- Route evidence reported `accepted_routeable_candidate_count=0`, `zero_notional_or_stale_evidence_rate=1.0`,
  `selected_repair_bid_count=32`, and held action classes `paper_canary`, `live_micro_canary`, and `live_scale`.
- Routeability acceptance was blocked with reason codes including `hypothesis_not_promotion_eligible`,
  `alpha_readiness_fail`, `proof_floor_repair_only`, `capital_state_zero_notional`,
  `route_tca_passed_but_dependency_receipts_block_capital`, `execution_tca_route_universe_exclusions_applied`,
  `execution_tca_symbol_missing`, `hypothesis_not_promotion_eligible`, `research_candidates_empty`,
  `research_promotions_empty`, `vnext_promotion_decisions_empty`, `simple_submit_disabled`, and
  `torghut_dependency_quorum_not_required`.
- The compacted repair ledger exposed six lots:
  - `quant_pipeline`, priority `100`, dispatchable, expected delta `retire_quant_health_not_configured`.
  - `feature_lineage`, priority `95`, dispatchable, expected delta `retire_research_candidates_empty`.
  - `execution_tca`, priority `90`, dispatchable, expected delta
    `retire_route_tca_passed_but_dependency_receipts_block_capital`.
  - `rollout_image`, priority `80`, selected but held on `dispatch_limit_exceeded`.
  - `empirical_replay`, priority `70`, selected but held on `dispatch_limit_exceeded`.
  - `promotion_custody`, priority `60`, held on `selection_limit_exceeded`, expected delta
    `retire_hypothesis_not_promotion_eligible`.

### Cluster And Rollout

- `argocd/torghut` was `Synced/Healthy` at revision `d4703334a83b3fa8933486f56491626580eab8b6`.
- `argocd/jangar` was `Synced/Healthy` at revision `6f1aa11d5a128d7cb6e42aa4aeb67660a380d57e`.
- `argocd/argo-workflows` was `Synced/Healthy`.
- Torghut live revision `torghut-00364` and sim revision `torghut-sim-00462` were running with image digest
  `sha256:90ac72f8bcdd8964dbca684e461e44daedbd143070f7d437ade6560c21a10db8`.
- Torghut options catalog and options enricher were available on the same Torghut image digest.
- ClickHouse, Keeper, Postgres, TA, TA sim, WebSocket, options TA, and guardrail exporters were running.
- Recent Torghut events showed expected Knative startup/readiness probe failures for `torghut-00364` and
  `torghut-sim-00462` before both revisions became ready.
- The cluster was still noisy: several `torghut-whitepaper-autoresearch-profit-target-*` pods were in `Error`, while
  one current instance was running.
- Jangar deployment was available, the agents deployment was available, and agents controllers were `2/2` ready.
- Some cluster resources were intentionally not reachable from this service account: Knative service listing, CNPG
  cluster listing, pod exec into `torghut-db-1`, and PodDisruptionBudget listing were denied by RBAC.

### Database And Data

- `/db-check` reported `ok=true`, `schema_current=true`, current and expected head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, one current head, one expected head, no missing heads, no
  unexpected heads, and `account_scope_ready=true`.
- Schema lineage was ready. The known parent-fork warnings remained at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Direct database introspection through `kubectl exec -n torghut torghut-db-1 -- psql` was denied by RBAC, so this
  assessment uses `/db-check` plus Torghut's database-backed trading evidence surfaces.
- Live `/readyz` returned HTTP 503 `status=degraded` because `live_submission_gate` was blocked by
  `simple_submit_disabled` and `profitability_proof_floor` was `repair_only`. Postgres, ClickHouse, Alpaca, universe,
  database, and empirical jobs were healthy.
- `/trading/health` showed `promotion_eligible_total=0`, `state_totals.shadow=3`,
  `rollback_required_total=3`, and live gate `allowed=false`.
- The profit lease projection counted `research_candidates=0`, `research_promotions=0`,
  `strategy_promotion_decisions=1`, and `vnext_promotion_decisions=0`.
- Profit windows were quarantined for the three active hypotheses. The recurring reasons were
  `post_cost_expectancy_non_positive`, `quant_health_not_configured`, `schema_lineage_missing`,
  `route_universe_empty`, and `market_context_evidence_missing`.
- Execution TCA had `7334` orders and `7245` filled executions. Latest execution timestamp was
  `2026-04-02T19:00:29.586040+00:00`; average absolute slippage was `13.8203637593029676` bps against an `8` bps
  guardrail. AAPL had route evidence, four symbols were blocked by slippage or exclusions, and AMZN, GOOGL, and ORCL
  lacked symbol TCA.

### Source And Test Surface

- `services/torghut/app/trading/revenue_repair.py` already maps
  `hypothesis_not_promotion_eligible` to `repair_alpha_readiness`, value gate `routeable_candidate_count`, and
  required output `torghut.executable-alpha-receipts.v1`.
- `services/torghut/app/trading/executable_alpha_receipts.py` builds the zero-notional capital replay board and
  candidate executable alpha receipts. The current receipts are projections: `after_refs` are empty, measured delta is
  `not_run`, and guardrails are blocked while evidence is missing.
- `services/torghut/app/trading/submission_council.py` correctly fails closed when `promotion_eligible_total <= 0` and
  requires valid promotion certificate evidence before live submission can pass.
- `services/torghut/app/trading/profit_leases.py` ties live promotion to source classes, promotion tables, rejection
  drag, quant metrics, empirical jobs, and capital controls.
- `services/torghut/app/trading/repair_bid_settlement.py` compacts repair bids and limits dispatch to three lots, but
  its static priority puts `promotion_custody` behind quant, feature-lineage, execution TCA, rollout image, and
  empirical replay.
- Focused regression tests already exist for revenue repair, executable alpha receipts, profit leases, proof floor,
  repair-bid settlement, route reacquisition, quality-adjusted frontier, and submission council. The missing test is a
  revenue-priority regression proving the promotion-custody lot receives reserved capacity when revenue repair ranks
  alpha readiness first.

## Problem

Torghut has enough evidence to name the business blocker, but not enough architecture discipline to ensure the next
runner slot attacks that blocker.

The concrete failure modes are:

1. `routeable_candidate_count` can stay at zero while lower-leverage repair lots consume all dispatchable slots.
2. `promotion_custody` can remain held even when `/trading/revenue-repair` says alpha readiness is the top repair item.
3. The executable-alpha receipt projection can be present but never run to an after-state.
4. Source evidence can look "current enough" while promotion tables remain empty and rejection drag remains unmeasured.
5. Jangar can report control-plane health while the business lane is starved by repair-slot economics.
6. Operators may be tempted to flip `simple_submit_disabled` because the visible top blocker says alpha readiness, even
   though the right answer is zero-notional promotion-custody proof.

The system is safe. It is not yet economically direct.

## Alternatives Considered

### Option A: Keep Static Repair Lot Priority

Leave `quant_pipeline`, `feature_lineage`, and `execution_tca` as the first three dispatchable lots until they clear.

Advantages:

- Lowest implementation risk.
- Keeps freshness, lineage, and TCA work moving.
- Does not change Jangar admission behavior.

Disadvantages:

- Does not target the top live business blocker.
- Can leave `routeable_candidate_count=0` indefinitely.
- Makes the revenue repair queue advisory instead of authoritative.
- Gives implementers no acceptance gate for the alpha-readiness milestone.

Decision: reject. Static priority is now conflicting with the business evidence surface.

### Option B: Open Paper Or Live Submission After Evidence Refresh

Treat the recent evidence improvements as enough to begin paper or micro-live submission once low-level freshness
repairs pass.

Advantages:

- Fastest apparent path to trading.
- Avoids another architecture artifact.
- Lets route TCA and profit leases be tested under live conditions.

Disadvantages:

- Violates the live evidence: `promotion_eligible_total=0`, `capital_state=zero_notional`, `max_notional=0`, and
  `simple_submit_disabled` are still active.
- Does not produce `alpha_readiness_receipt`, `hypothesis_promotion_receipt`, or a settled capital replay board.
- Weakens capital safety to create activity instead of improving readiness.

Decision: reject. The correct next move is proof, not notional.

### Option C: Alpha-Readiness Strike Ledger

Reserve bounded zero-notional repair capacity for promotion custody when the revenue repair queue ranks
`routeable_candidate_count` first. The strike ledger turns candidate replays into after-receipts, or writes a denial
that names the irreducible blocker.

Advantages:

- Targets the top revenue repair item.
- Keeps capital closed.
- Produces a direct acceptance gate for `routeable_candidate_count`.
- Gives Jangar a compact admission packet and a terminal outcome receipt.
- Turns promotion-custody starvation into an observable control-plane failure.

Disadvantages:

- Adds one more contract between Torghut and Jangar.
- Reduces generic repair throughput while the strike lane is active.
- Requires focused tests across revenue repair, repair-bid settlement, executable-alpha receipts, and submission
  council.

Decision: select Option C.

## Architecture

Torghut publishes an `alpha_readiness_strike_ledger` as part of `/trading/revenue-repair` and, after rollout, as a
compact field in `/trading/consumer-evidence` for Jangar admission.

```text
alpha_readiness_strike_ledger
  schema_version = torghut.alpha-readiness-strike-ledger.v1
  generated_at
  fresh_until
  account_id
  window
  trading_mode
  capital_stage = shadow
  max_notional = 0
  revenue_repair_digest_ref
  selected_business_blocker
  routeable_candidate_count_before
  zero_notional_or_stale_evidence_rate_before
  promotion_custody_lot_ref
  strike_slots
  candidate_replays[]
  required_after_receipts[]
  guarded_action_classes[]
  rollback_target
```

Each `candidate_replay` records:

```text
candidate_replay
  replay_id
  hypothesis_id
  candidate_id
  strategy_id
  target_symbols[]
  lane_id
  strategy_family
  before_refs
    executable_alpha_receipt_ref
    capital_replay_board_ref
    proof_floor_ref
    profit_lease_ref
    route_reacquisition_ref
    tca_route_ref
    market_context_ref
    quant_health_ref
  required_after_refs[]
  acceptance_gate
  falsification_rules[]
  max_runtime_seconds
  max_notional = 0
  expected_value_gate_delta
```

Each `strike_slot` records:

```text
strike_slot
  slot_id
  lot_id
  source_repair_bid_ids[]
  lot_class = promotion_custody
  target_value_gate = routeable_candidate_count
  admission_reason = revenue_queue_top_gate
  preempted_lot_class
  dedupe_key
  ttl_seconds
  state = dispatchable | held | closed
  required_output_receipt = torghut.promotion-custody-decision-receipt.v1
  capital_rule = zero_notional_repair_only
```

The ledger is not capital approval. It is an admission packet for proof work. It exists to answer one question: did the
next zero-notional repair run improve the routeable candidate ladder, or did it prove exactly why that ladder remains
blocked?

## Promotion-Custody Ladder

The strike ledger defines four stages:

1. `candidate_projected`: current state. Executable alpha receipts exist, but `after_refs` are empty and measured delta
   is `not_run`.
2. `strike_admitted`: Jangar accepted one zero-notional promotion-custody run because the revenue queue ranked
   `routeable_candidate_count` first.
3. `receipt_settled`: the run returned `torghut.promotion-custody-decision-receipt.v1` with retired and preserved
   reason codes.
4. `paper_replay_candidate` or `denied`: Torghut either increments paper replay candidate evidence with notional still
   zero, or records the smallest blocker that prevents routeable-candidate admission.

No stage permits live orders. Paper probe admission remains a separate decision after capital safety, TCA, market
context, quant, source lineage, and deployer gates pass.

## Measurable Trading Hypotheses

### Hypothesis 1: Promotion-Custody Slot Reservation

If the top revenue repair item targets `routeable_candidate_count`, reserving one zero-notional dispatch slot for
`promotion_custody` will reduce the time to a settled alpha-readiness receipt without increasing capital risk.

Validation:

- `promotion_custody` is no longer held solely by `selection_limit_exceeded`.
- The ledger reports one strike slot with `max_notional=0`.
- Jangar launches at most one active promotion-custody strike per account/window/dedupe key.
- The required output receipt is `torghut.promotion-custody-decision-receipt.v1`.

### Hypothesis 2: Routeable Candidate Ladder

If a candidate replay settles after-receipts for TCA, market context, quant health, empirical proof, and promotion
custody, then `routeable_candidate_count` should rise from `0` to at least `1` paper replay candidate while
`live_submission_allowed=false`.

Validation:

- `routeable_candidate_count_before=0`.
- `routeable_candidate_count_after>=1` only when all required after-receipts pass.
- `capital_state` remains `zero_notional`.
- `paper_canary`, `live_micro_canary`, and `live_scale` remain held until separate promotion gates pass.

### Hypothesis 3: Denial Is A Useful Outcome

If promotion custody cannot advance a candidate, a typed denial with preserved reason codes is still valuable because
it prevents repeated no-delta repair dispatch.

Validation:

- The strike receipt records `decision=denied`, `preserved_reason_codes[]`, and `next_repair_class`.
- Jangar burns or rolls forward credit according to the companion contract.
- The revenue repair digest moves the next blocker to the front or keeps alpha readiness at the front with a new
  smallest unblocker.

## Implementation Scope

The next engineer milestone is intentionally bounded:

1. Add `build_alpha_readiness_strike_ledger()` under `services/torghut/app/trading/`.
2. Feed it from the existing revenue repair digest, repair-bid settlement ledger, executable alpha receipts, capital
   replay board, live submission gate, proof floor, profit lease projection, and route reacquisition board.
3. Reserve one strike slot when all conditions hold:
   - `/trading/revenue-repair.repair_queue[0].value_gate == routeable_candidate_count`;
   - a compacted `promotion_custody` lot exists;
   - the lot is held only by `selection_limit_exceeded` or lower-priority dispatch economics;
   - active dedupe does not already contain the promotion-custody key;
   - `max_notional=0`.
4. Include the ledger in `/trading/revenue-repair`.
5. Include a compact admission view in `/trading/consumer-evidence`.
6. Add focused tests:
   - revenue queue alpha readiness first reserves a promotion-custody strike slot;
   - non-alpha top queue leaves static lot ordering unchanged;
   - active dedupe holds duplicate strike admission;
   - any nonzero notional in the source payload fails the ledger;
   - submission council remains blocked while `simple_submit_disabled` is active.

Do not change broker submission, risk limits, GitOps live-promotion flags, or database records in this milestone.

## Validation Gates

Local validation:

- `uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py`
- `uv run --frozen pytest services/torghut/tests/test_repair_bid_settlement.py`
- `uv run --frozen pytest services/torghut/tests/test_executable_alpha_receipts.py`
- `uv run --frozen pytest services/torghut/tests/test_submission_council.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Post-rollout validation:

- Argo reports Torghut synced and healthy at the promoted image.
- `/db-check` reports schema current and account scope ready.
- `/trading/revenue-repair` reports `alpha_readiness_strike_ledger.schema_version`.
- If alpha readiness remains top queue, the ledger exposes one zero-notional `promotion_custody` strike slot.
- If the strike settles successfully, `routeable_candidate_count` increases or the denial names the smallest blocker.
- `/readyz` may remain HTTP 503 while `simple_submit_disabled` and proof-floor holds are active; that is acceptable
  if the response explains the same blockers and capital remains closed.

## Rollout

Roll out in observe mode:

1. Ship the ledger behind a Torghut feature flag or default-on read-only projection. It must not launch work by itself.
2. Promote the image through normal CI/CD and GitOps.
3. Verify `/trading/revenue-repair` and `/trading/consumer-evidence` include the ledger with `max_notional=0`.
4. Enable Jangar admission of one promotion-custody strike slot through the companion contract.
5. Watch for duplicate dedupe keys, no-delta receipts, and any accidental change in live submission state.

## Rollback

Rollback is simple and capital-safe:

- Disable strike-ledger consumption in Jangar.
- Keep Torghut publishing the digest, or hide the strike ledger behind the feature flag.
- Fall back to the existing repair-bid settlement ordering.
- Keep `simple_submit_disabled=true`.
- Keep `capital_state=zero_notional`.
- Keep `paper_canary`, `live_micro_canary`, and `live_scale` held.

Rollback does not require database mutation.

## Risks

- The strike lane can starve freshness work if left active after alpha readiness is no longer the top revenue blocker.
  Mitigation: the lane activates only from `/trading/revenue-repair.repair_queue[0]`.
- Promotion custody may settle a denial rather than a candidate. That is acceptable if the denial names the smallest
  blocker and stops repeated no-delta dispatch.
- Source lineage and promotion table emptiness may remain the true blocker. The strike receipt must preserve those
  reason codes instead of masking them.
- TCA is not good enough for live trading: aggregate slippage is above guardrail and several symbols lack route TCA.
  The strike ledger cannot override that.
- Jangar runner capacity is finite. The companion contract must enforce one active strike per account/window/dedupe key.

## Handoff

Engineer handoff:

- Implement the strike ledger as a pure projection first.
- Write the revenue-priority regression before changing dispatch selection.
- Keep all notional values at `0`.
- Treat `promotion_custody` as a proof-producing run, not a promotion by itself.

Deployer handoff:

- After rollout, prove Argo sync, image digest, `/db-check`, `/trading/revenue-repair`, `/trading/consumer-evidence`,
  and `/readyz` blocker consistency.
- Do not enable paper or live submit from this contract.
- Report the improved metric as `routeable_candidate_count` if a candidate advances, or the smallest remaining blocker
  if the strike settles a denial.
