# 206. Torghut No-Delta Repair Reentry Auction And Verification Carry (2026-05-14)

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

I am selecting a **no-delta repair reentry auction with Jangar verification carry** as Torghut's next profitability
contract.

The live business surface is clear. On 2026-05-14 around 12:11Z, `GET /trading/revenue-repair` returned
`business_state=repair_only`, `revenue_ready=false`, top queue item `repair_alpha_readiness`, top value gate
`routeable_candidate_count`, capital rule `zero_notional_repair_only`, and `max_notional=0`. `/readyz` returned HTTP
`503`, but for the right reasons: `live_submission_gate=simple_submit_disabled` and
`profitability_proof_floor=repair_only`. Postgres, ClickHouse, Alpaca, database schema, static universe, and optional
quant evidence were healthy.

Torghut has already built the first layer of the repair machinery. The alpha-readiness settlement conveyor selected
`H-MICRO-01`, measured `routeable_candidate_count` as `0 -> 0`, and returned `status=no_delta`. The alpha repair
dividend ledger returned `launch_decision=deny`, `launch_decision_reason=no_delta_release_key_active`, and denied
`paper_canary`, `live_micro_canary`, and `live_scale`. That is the correct safety posture. It is also the current
profitability blocker: the system needs to know what must change before spending another repair slot.

The selected design adds a Torghut-owned `no_delta_repair_reentry_auction`. The auction does not let workers rerun the
same alpha repair after a timer. It prices the release conditions that can invalidate the active no-delta key:
changed source revenue-repair digest, changed evidence window, changed blocker set, changed required receipt set, or a
new Jangar verify-trust foreclosure ticket. If none of those changed, the auction denies reentry and keeps capital at
zero. If one changed, it selects the smallest zero-notional repair that can clear the top alpha-readiness queue item or
fund a named prerequisite to that queue item.

The tradeoff is that Torghut will sometimes hold useful execution or empirical work behind the alpha no-delta release
key. I accept that. The objective is not generic activity; it is routeable candidate recovery under capital safety. A
second unchanged no-delta launch would raise failed AgentRun pressure and still leave `routeable_candidate_count=0`.

## Governing Runtime Requirements

This contract implements the active cross-swarm runtime requirements:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove Argo, workload readiness, service health, and trading evidence
  after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Torghut value-gate mapping:

- `routeable_candidate_count`: primary value gate; reentry must increase accepted routeable candidates or record a new
  no-delta debt with a changed release condition.
- `zero_notional_or_stale_evidence_rate`: unchanged no-delta evidence keeps reentry denied.
- `fill_tca_or_slippage_quality`: execution TCA repair can win only when it is a named prerequisite to unlock the
  alpha-readiness lane.
- `post_cost_daily_net_pnl`: no lane can promote to capital until post-cost evidence is positive and current.
- `capital_gate_safety`: every auction ticket has `max_notional=0`; live submission remains disabled.

Jangar value-gate mapping:

- `failed_agentrun_rate`: no-delta release keys suppress duplicate repair AgentRuns.
- `pr_to_rollout_latency`: verification carry gives deployers one packet that binds source, image, status, and Torghut
  business evidence.
- `ready_status_truth`: `/readyz` can stay degraded for capital safety while the auction remains observable.
- `manual_intervention_count`: the top repair lane and denial reason are machine-readable.
- `handoff_evidence_quality`: handoffs cite auction id, release key, selected ticket, validation command, and rollback.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records, broker
state, trading flags, GitOps resources, AgentRuns, or market data.

### Cluster And Runtime

- Torghut live revision was `torghut-00389`; sim revision was `torghut-sim-00487`.
- Live and sim pods were running with two containers ready.
- Current Torghut image digest was `sha256:f451b35a66392e9d769ebab8b6c7708f617b5449d6473aed8b349ea34f60187b`.
- Torghut DB pod, ClickHouse shards, Keeper, options catalog, options enricher, TA, TA sim, WebSocket services, and
  guardrail exporters were running.
- Recent Torghut events showed successful database migrations and revision readiness, plus transient startup/readiness
  probe failures during revision replacement.
- Recent Torghut events also showed profit-feedback workflows failing with exit code `127` and a Flink options-TA
  checkpoint restart. Those are not the current revenue-repair top queue item, but they are verification carry risk.

### Database And Schema

- `GET /db-check` returned HTTP `200` with `ok=true` and `schema_current=true`.
- Current and expected Alembic head was `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- `schema_missing_heads=[]`, `schema_unexpected_heads=[]`, `schema_head_delta_count=0`.
- `schema_graph_lineage_ready=true`, no duplicate revisions, and no orphan parents.
- The schema witness still reported historical parent forks under
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `GET /readyz` returned HTTP `503`, but Postgres, ClickHouse, Alpaca, database schema, static universe, optional
  empirical job dependency, DSPy runtime, and optional quant evidence were acceptable for observation.
- The failing readiness dependencies were `live_submission_gate=simple_submit_disabled` and
  `profitability_proof_floor=repair_only`, which are correct capital-safety holds.

### Revenue Repair

- `GET /trading/revenue-repair` generated at `2026-05-14T12:11:24.819445+00:00`.
- `business_state=repair_only`, `revenue_ready=false`, `capital_stage=shadow`, `capital_state=zero_notional`,
  `live_submission_allowed=false`, and `max_notional=0`.
- Top queue item was `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, priority `70`, action
  `clear_hypothesis_blockers_before_capital`, value gate `routeable_candidate_count`, and required output
  `torghut.executable-alpha-receipts.v1`.
- Blockers included `hypothesis_not_promotion_eligible`, `degraded`, `simple_submit_disabled`, and
  `empirical_jobs_not_ready`.
- Alpha readiness had `3` hypotheses, `0` promotion-eligible hypotheses, and all hypotheses blocked:
  `H-CONT-01`, `H-MICRO-01`, and `H-REV-01`.
- The alpha-readiness settlement conveyor reported `status=no_delta`, `settlement_state=no_delta`,
  selected lane `H-MICRO-01`, selected value gate `routeable_candidate_count`, routeable candidate count `0 -> 0`,
  measured delta `0`, and `repeat_launch_decision=deny`.
- The alpha repair dividend ledger reported `status=no_delta`, `dividend_state=no_delta`,
  `active_no_delta_release_key`, routeable candidate count `0 -> 0`, and
  `next_allowed_attempt_after=2026-05-14T12:27:46.541488+00:00`.
- Jangar custody in the dividend ledger denied `paper_canary`, `live_micro_canary`, and `live_scale`.

### Source And Test Surface

- `services/torghut/app/main.py` is `6990` lines and assembles `/readyz`, `/trading/status`,
  `/trading/revenue-repair`, and `/trading/consumer-evidence`.
- `services/torghut/app/trading/revenue_repair.py` is `1161` lines and owns the revenue-repair digest.
- `services/torghut/app/trading/alpha_readiness_settlement_conveyor.py` is `848` lines and owns the active no-delta
  release-key logic.
- `services/torghut/app/trading/alpha_repair_dividend_ledger.py` is `637` lines and owns the Jangar-facing no-delta
  custody summary.
- Existing tests include `test_build_revenue_repair_digest.py`, `test_alpha_readiness_settlement_conveyor.py`,
  `test_alpha_repair_dividend_ledger.py`, `test_executable_alpha_repair_receipts.py`,
  `test_repair_bid_settlement.py`, `test_repair_outcome_dividend.py`, `test_route_evidence_clearinghouse.py`,
  `test_routeability_repair_acceptance.py`, and `test_consumer_evidence.py`.
- The missing test family is the auction itself: unchanged release key deny, changed evidence-window allow,
  changed blocker-set allow, changed required-receipt-set allow, Jangar verify carry hold, zero-notional enforcement,
  and compact consumer-evidence export.

## Problem

Torghut can now prove that an alpha repair produced no routeable-candidate delta. It does not yet have a first-class
auction that decides what evidence must change before another alpha repair can launch.

The concrete failure modes are:

1. A worker can repeat the selected `H-MICRO-01` repair after waiting, even if the evidence window and blocker set did
   not change.
2. Execution TCA repair can compete with the top alpha-readiness queue item instead of acting as a named prerequisite.
3. Jangar verify-stage debt can be ignored by Torghut's revenue-repair queue, even though failed verification raises
   the cost of every repair PR.
4. `/readyz` degradation can be misread as service breakage instead of correct capital-safety behavior.
5. Schema head currentness can be mistaken for strategy-lineage readiness.
6. Deployer handoff can cite revision readiness without proving that routeable candidate count changed or no-delta
   debt was recorded.

The system needs a reentry auction that turns no-delta evidence into a launch-deny key until a release condition
changes.

## Alternatives Considered

### Option A: Rerun The Selected Alpha Lane After Cooldown

This option lets the current `next_allowed_attempt_after` timestamp reopen `H-MICRO-01` without requiring a changed
release condition.

Advantages:

- Simple.
- Gives the top queue item another chance.
- Fits the existing settlement conveyor shape.

Disadvantages:

- It repeats the exact failure mode: routeable candidate count stayed `0`.
- It spends runner capacity without explaining what changed.
- It can make verify-stage failure debt worse.
- It does not reduce stale evidence rate or improve capital safety.

Decision: reject.

### Option B: Switch The Next Run To Execution TCA Repair

This option treats `fill_tca_or_slippage_quality` as the immediate path because TCA evidence has blocked and missing
symbols.

Advantages:

- TCA evidence is concrete and measurable.
- It can improve downstream route quality.
- It may unlock future paper candidates once alpha is eligible.

Disadvantages:

- It does not clear the top `/trading/revenue-repair` queue item.
- It risks proving better execution for hypotheses that still cannot promote.
- It does not explain the active alpha no-delta release key.
- It can create a parallel repair stream that Jangar has to reconcile manually.

Decision: reject as primary. Permit TCA only when the auction names it as a prerequisite to release the alpha lane.

### Option C: No-Delta Repair Reentry Auction With Verification Carry

This option makes Torghut price release conditions and choose one zero-notional ticket only when the active no-delta
key is cleared or changed.

Advantages:

- Directly targets `repair_alpha_readiness`, the live top queue item.
- Prevents duplicate no-delta repair AgentRuns.
- Lets prerequisite TCA, empirical, market-context, or schema-lineage work compete only when tied to alpha release.
- Gives Jangar a compact verification-carry input.
- Keeps capital and live submission locked down.

Disadvantages:

- Adds a reducer and tests.
- Requires stable release-key calculation.
- Can hold useful work until enough evidence changes.

Decision: select Option C.

## Architecture

Torghut emits two additive payloads:

```text
torghut.no-delta-repair-reentry-auction.v1
  auction_id
  generated_at
  fresh_until
  source_revenue_repair_ref
  active_alpha_conveyor_ref
  active_alpha_dividend_ref
  active_no_delta_release_key
  selected_queue_code: repair_alpha_readiness
  selected_value_gate: routeable_candidate_count
  routeable_candidate_count_before
  routeable_candidate_count_after
  release_conditions[]
  candidate_tickets[]
  selected_ticket
  reentry_decision: allow | hold | deny
  reason_codes[]
  max_notional: "0"
  rollback_target

torghut.jangar-verification-carry.v1
  carry_id
  generated_at
  fresh_until
  jangar_execution_trust_status
  jangar_source_rollout_truth_state
  jangar_foreclosure_board_ref
  held_action_classes[]
  blocked_action_classes[]
  required_jangar_receipt
  reason_codes[]
```

### Release Conditions

The active no-delta key can be released only by one or more of these changes:

- `source_revenue_repair_ref_changed`
- `evidence_window_changed`
- `blocker_set_changed`
- `required_receipt_set_changed`
- `selected_hypothesis_changed`
- `jangar_verify_foreclosure_ticket_current`
- `schema_lineage_receipt_current`
- `empirical_receipt_current`
- `market_context_receipt_current`
- `execution_tca_receipt_current`

A timestamp alone is not a release condition. Time can expire a lease, but it cannot create evidence.

### Auction Tickets

Each candidate ticket has:

```text
candidate_ticket
  ticket_id
  ticket_class:
    alpha_evidence_window | empirical_receipt | market_context_receipt |
    execution_tca_receipt | schema_lineage_receipt | jangar_verify_carry
  target_value_gate
  expected_gate_delta
  release_condition
  required_output_receipt
  validation_commands[]
  max_runtime_seconds
  max_parallelism
  max_notional: "0"
  state: selected | held | denied
  hold_reason_codes[]
```

The auction selects at most one ticket for Jangar material dispatch. The first implementation should keep the selected
ticket in observe mode and expose it in `/trading/revenue-repair` and `/trading/consumer-evidence`.

### Reentry Rules

Torghut denies reentry when:

- no release condition changed;
- active no-delta release key matches the selected lane;
- `max_notional` is not `0`;
- Jangar verification carry is degraded and no foreclosure ticket exists;
- the selected ticket does not target the live top queue item or a named prerequisite.

Torghut holds reentry when:

- release condition state is unknown;
- DB schema witness is unavailable;
- Jangar verification carry is unavailable;
- required validation command is missing;
- consumer-evidence export has not carried the auction ref.

Torghut allows reentry when:

- at least one release condition changed;
- the selected ticket is zero-notional and has one required output receipt;
- Jangar verification carry is current or the selected ticket is explicitly scoped to retire that carry;
- the ticket target is `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`, or a named prerequisite
  that releases alpha readiness.

No reentry decision authorizes paper or live capital.

## Implementation Scope

Engineer milestone 1:

- Add `no_delta_repair_reentry_auction.py` as a pure reducer under `services/torghut/app/trading/`.
- Build it from revenue-repair digest, alpha-readiness settlement conveyor, alpha repair dividend ledger, repair bid
  settlement, and optional Jangar verification carry.
- Expose compact auction refs on `/trading/revenue-repair` and `/trading/consumer-evidence`.
- Keep enforcement in observe mode and preserve existing no-delta denial fields.

Engineer milestone 2:

- Feed the auction decision into revenue-repair queue ordering.
- Deny unchanged no-delta reentry even after cooldown.
- Allow one selected zero-notional prerequisite ticket when a release condition changed.
- Add tests for unchanged deny, changed-release-condition allow, Jangar verify carry hold, and consumer-evidence parity.

Deployer milestone:

- After rollout, prove `/trading/revenue-repair` carries the auction ref, selected ticket, and zero-notional decision.
- Prove Jangar consumes the compact ref before material dispatch is counted as accepted evidence.

## Validation Gates

Local validation:

- `uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py`
- `uv run --frozen pytest services/torghut/tests/test_alpha_repair_dividend_ledger.py`
- `uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k revenue_repair`
- `uv run --frozen pytest services/torghut/tests/test_consumer_evidence.py -k alpha`
- `ruff check services/torghut/app/trading services/torghut/tests`

Live validation:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.no_delta_repair_reentry_auction'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.no_delta_repair_reentry_auction'`
- `curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://torghut.torghut.svc.cluster.local/readyz`
- `curl -fsS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents | jq '.verify_trust_foreclosure_board'`

Acceptance:

- Current unchanged no-delta release key yields `reentry_decision=deny`.
- Changed release condition yields at most one selected zero-notional ticket.
- Auction selected ticket cites one required output receipt and at least one validation command.
- Consumer evidence carries the compact auction ref for Jangar.
- `/readyz` remains degraded while proof floor is repair-only; service degradation must not enable capital.

## Rollout

Phase 0 is documentation and test fixtures.

Phase 1 emits the auction in observe mode on `/trading/revenue-repair`.

Phase 2 mirrors compact refs to `/trading/consumer-evidence`.

Phase 3 feeds the decision into Jangar material-action admission but denies only duplicate unchanged no-delta reentry.

Phase 4 lets changed release conditions open one bounded zero-notional ticket.

Phase 5 allows deployer handoff to treat routeable candidate delta or no-delta debt as the accepted revenue-repair
settlement evidence.

## Rollback

Rollback is to stop emitting `no_delta_repair_reentry_auction` and keep existing alpha-readiness settlement conveyor,
alpha repair dividend ledger, repair bid settlement, and capital proof-floor contracts.

If the auction falsely denies useful work:

- keep the existing conveyor and dividend fields;
- remove the auction ref from queue ordering;
- preserve `max_notional=0`;
- keep live submission disabled.

If the auction falsely allows duplicate no-delta work:

- force `reentry_decision=deny` whenever `active_no_delta_release_key` is present;
- require a new source revenue-repair ref before reentry;
- leave paper and live action classes denied.

## Risks

- Risk: release-key calculation changes too often and hides duplicate work. Mitigation: base the key on source ref,
  evidence window, blocker set, required receipt set, selected hypothesis, account, window, and trading mode.
- Risk: Jangar verification carry blocks Torghut-local repair. Mitigation: carry is a hold unless the selected ticket
  explicitly retires verify debt.
- Risk: TCA work is starved. Mitigation: TCA can win as a prerequisite ticket when it releases alpha readiness.
- Risk: operators treat no-delta as failure. Mitigation: no-delta is an accepted settlement outcome when it carries a
  release key, validation command, and next action.

## Handoff

Engineer next action: implement `torghut.no-delta-repair-reentry-auction.v1` in observe mode and prove unchanged
no-delta denies repeat launch while changed evidence conditions select one zero-notional ticket.

Deployer next action: after rollout, prove the auction appears on `/trading/revenue-repair` and
`/trading/consumer-evidence`, Jangar consumes the compact ref, and Torghut remains `max_notional=0`.

The smallest blocker preventing revenue impact is current and measurable: `repair_alpha_readiness` is still the top
queue item, selected `H-MICRO-01` produced no routeable-candidate delta, and the active no-delta release key denies
another unchanged launch.
