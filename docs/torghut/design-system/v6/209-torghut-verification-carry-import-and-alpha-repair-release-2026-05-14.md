# 209. Torghut Verification Carry Import And Alpha Repair Release (2026-05-14)

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

I am selecting a **verification-carry import board with alpha-repair release accounting** as Torghut's next
profitability contract.

Torghut has made the right local move. On 2026-05-14 at about 16:10Z, `/trading/revenue-repair` emitted
`no_delta_repair_reentry_auction`, selected `H-MICRO-01`, kept the selected value gate
`routeable_candidate_count`, measured routeable candidate count as `0 -> 0`, and denied reentry because the active
no-delta release key had not changed. That is correct. Repeating the same alpha repair would burn capacity and still
leave `routeable_candidate_count=0`.

The current blocker is the cross-plane import. The same auction reported
`jangar_verification_carry.status=unavailable`, required `jangar.verify-trust-foreclosure-ticket.v1`, and included
`jangar_verification_carry_unavailable` in the denial reasons. That is also correct: Jangar live `/ready` and
control-plane status still returned `verify_trust_foreclosure_board=null`, even though source has the board
implementation and GitOps desired state points at a newer Jangar image.

This means Torghut should not open the alpha-repair release just because time passes or because Jangar source contains
the board. It should import a Jangar foreclosure-carry rollout witness and classify the carry state as current,
rollout-lagging, field-absent, stale, unavailable, or denied. That imported state then becomes one of the auction
release conditions. If the carry is current, Torghut can price the next zero-notional alpha prerequisite. If the carry
is lagging or absent, Torghut keeps the top repair item closed and records a Jangar-stage blocker rather than launching
another no-delta alpha run.

The tradeoff is that Torghut becomes more dependent on Jangar deployer proof before it can spend its next repair slot.
I accept that. The live business metric is not generic job throughput; it is routeable candidate recovery under
capital safety. A Jangar carry that exists only in source cannot reduce trading risk or failed AgentRuns.

## Governing Runtime Requirements

This contract implements the active cross-swarm runtime requirements:

- every run must cite the governing Torghut or Jangar design before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove Argo, workload readiness, service health, and trading evidence
  after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Torghut value-gate mapping:

- `routeable_candidate_count`: primary value gate; reentry can open only when carry is current or the selected ticket
  explicitly repairs carry import.
- `zero_notional_or_stale_evidence_rate`: source-only or stale Jangar carry is denial evidence.
- `fill_tca_or_slippage_quality`: TCA repair can win only after verification carry is current or explicitly not
  required for the selected alpha release.
- `post_cost_daily_net_pnl`: no paper or live capital follows from this contract.
- `capital_gate_safety`: all tickets remain `max_notional=0`; live submission stays disabled.

Jangar value-gate mapping:

- `failed_agentrun_rate`: duplicate no-delta alpha repair stays denied while Jangar carry is unavailable.
- `pr_to_rollout_latency`: Torghut records the Jangar carry state and rollout lag as an imported release condition.
- `ready_status_truth`: Torghut distinguishes service degradation for capital safety from missing cross-plane carry.
- `manual_intervention_count`: no human has to manually compare source, live Jangar status, and auction denial reason.
- `handoff_evidence_quality`: handoffs cite auction id, imported carry state, active no-delta key, required receipt,
  validation commands, and rollback target.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records, trading
flags, GitOps resources, AgentRuns, or market data.

### Torghut Runtime Evidence

- Torghut live revision was `torghut-00397`; simulation revision was `torghut-sim-00494`; both pods were running.
- Torghut `/readyz` returned `status=degraded`. The observed degradation was aligned with capital holds rather than
  serving unavailability.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, `schema_missing_heads=[]`,
  `schema_unexpected_heads=[]`, `schema_head_delta_count=0`, and `schema_graph_lineage_ready=true`.
- The DB witness still carried historical parent-fork warnings for
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`; schema currentness is
  required but not sufficient for repair release.
- Recent Torghut namespace events showed revision replacement, successful migration/bootstrap jobs, and running data
  services. They also showed startup/readiness probe noise during rollout and a recent
  `torghut-profit-summary-feedback` workflow failure with exit code `2`.

### Revenue Repair Evidence

- `/trading/revenue-repair` generated at `2026-05-14T16:10:21.721419+00:00`.
- `business_state=repair_only` and `revenue_ready=false`.
- `alpha_readiness_settlement_conveyor.status=no_delta` and `settlement_state=no_delta`.
- Selected queue code was `repair_alpha_readiness`; selected value gate was `routeable_candidate_count`.
- Selected lane was `H-MICRO-01`, candidate `chip-paper-microbar-composite@execution-proof`, strategy
  `microbar_volume_continuation_long_top2_chip_v1@paper`.
- Routeable candidate count remained `0 -> 0`; `accepted_routeable_candidate_count=0`;
  `measured_routeable_candidate_delta=0`.
- `alpha_repair_dividend_ledger.status=no_delta`, `selected_hypothesis_id=H-MICRO-01`, and
  `jangar_custody.launch_decision=deny`.
- Dividend ledger reason was `no_delta_release_key_active`; capital state remained `zero_notional` with
  `max_notional=0`.
- `no_delta_repair_reentry_auction.reentry_decision=deny`.
- Auction reason codes were `active_no_delta_release_key`, `no_release_condition_changed`,
  `zero_notional_reentry_ticket_not_selected`, `jangar_verification_carry_unavailable`, and
  `duplicate_no_delta_reentry_denied`.
- Auction `jangar_verification_carry.status=unavailable`, `jangar_execution_trust_status=unavailable`,
  `jangar_source_rollout_truth_state=unknown`, and `required_jangar_receipt=jangar.verify-trust-foreclosure-ticket.v1`.

### Jangar Evidence Imported By Torghut

- Jangar `/ready` returned `status=ok`, `business_state=repair_only`, `revenue_ready=false`, and top repair
  `repair_alpha_readiness`.
- Jangar `/ready.execution_trust.status=degraded` because `jangar-control-plane:plan` and
  `jangar-control-plane:verify` had consecutive failures.
- Jangar `/ready.verify_trust_foreclosure_board=null`.
- Jangar control-plane status also returned `verify_trust_foreclosure_board=null`.
- Jangar database witness was healthy with `29` registered migrations, `29` applied migrations, and no unapplied or
  unexpected migrations.
- Jangar watch reliability was healthy with `1327` events, `0` errors, and `0` restarts in the 15 minute window.
- `agents` workload was healthy but running old image `0f963a1d`; GitOps desired state pointed at `77e207de`.
- Argo CD reported `agents` `OutOfSync` and `Healthy`.

### Source And Test Surface

- Torghut no-delta auction source is `services/torghut/app/trading/no_delta_repair_reentry_auction.py`.
- Revenue repair digest construction is in `services/torghut/app/trading/revenue_repair.py`.
- API export wiring is in `services/torghut/app/main.py`.
- Existing tests include `test_no_delta_repair_reentry_auction.py`, `test_build_revenue_repair_digest.py`,
  `test_alpha_readiness_settlement_conveyor.py`, `test_alpha_repair_dividend_ledger.py`,
  `test_consumer_evidence.py`, `test_routeability_repair_acceptance.py`, and `test_trading_api.py`.
- The missing test family is the import board: source-only Jangar carry deny, rollout-lagging carry hold,
  current carry allow-pricing, stale carry deny, and carry-import mismatch escalation.

## Problem

Torghut now knows how to deny repeated alpha repair when the no-delta release key is active. It does not yet have a
capital-safe way to distinguish these Jangar states:

1. Jangar source contains the foreclosure board but live status does not emit it.
2. Jangar live status emits a fresh foreclosure board but Torghut has not imported it.
3. Jangar emits stale carry.
4. Jangar emits current carry but still denies material action because plan/verify debt is active.
5. Jangar emits current carry and explicitly selects one stage-debt repair ticket.

Without that classification, every missing carry becomes the same `jangar_verification_carry_unavailable` reason. That
is safe, but it is not precise enough to shorten the next PR-to-rollout loop or to decide whether the top alpha repair
queue item can move.

The current business blocker is specific: `routeable_candidate_count=0`, active no-delta release key unchanged, and
Jangar verification carry unavailable.

## Alternatives Considered

### Option A: Keep Denying Until Jangar Carry Appears

This option leaves the current auction as-is. Missing Jangar carry remains a simple denial reason.

Advantages:

- Safe.
- No new source work.
- Keeps duplicate no-delta repair closed.

Disadvantages:

- It does not distinguish rollout lag from source absence or import bugs.
- It gives deployers no Torghut-side proof that the Jangar promotion fixed the carry path.
- It keeps the top queue item blocked without selecting the smallest cross-plane repair.
- It does not improve handoff evidence beyond the current denial reason.

Decision: reject as the target state. Keep it as the fallback behavior.

### Option B: Ignore Jangar Carry For Zero-Notional Alpha Repair

This option lets Torghut reopen the alpha repair lane because all work is zero-notional.

Advantages:

- Fastest path to another alpha run.
- Keeps Torghut locally autonomous.
- Could find a routeable candidate if the previous no-delta was incidental.

Disadvantages:

- It repeats the exact failed pattern while the no-delta key is unchanged.
- It ignores Jangar plan/verify debt and increases failed AgentRun pressure.
- It does not clear the cross-plane release condition that the auction already identified.
- It weakens capital safety discipline by treating zero-notional as reason to bypass control-plane truth.

Decision: reject.

### Option C: Verification-Carry Import Board With Alpha-Repair Release Accounting

This option imports Jangar's foreclosure-carry rollout witness, classifies the carry state, and feeds that state into
the no-delta auction as a release condition and repair-ticket selector.

Advantages:

- Targets the live blocker directly.
- Keeps duplicate no-delta repair denied.
- Gives deployers a Torghut-side receipt after Jangar rollout.
- Lets the auction select a Jangar-stage repair ticket only when it can retire the missing carry condition.
- Preserves `max_notional=0`.

Disadvantages:

- Adds an import reducer and tests.
- Requires Jangar and Torghut payload schemas to stay aligned.
- Can hold Torghut-local work until Jangar carry is fixed.

Decision: select Option C.

## Architecture

Torghut emits two additive payloads:

```text
torghut.verification-carry-import-board.v1
  import_board_id
  generated_at
  fresh_until
  source_revenue_repair_ref
  active_no_delta_auction_ref
  active_no_delta_release_key
  imported_jangar_witness_ref
  imported_jangar_board_ref
  imported_jangar_stage_debt_admission_ref
  jangar_carry_state:
    current | rollout_lagging | field_absent | stale | unavailable | denied | import_mismatch
  jangar_execution_trust_status
  jangar_blocking_windows[]
  jangar_desired_image_ref
  jangar_observed_image_ref
  release_condition_state
  reason_codes[]
  validation_commands[]
  rollback_target

torghut.alpha-repair-release-accounting.v1
  release_accounting_id
  generated_at
  fresh_until
  selected_queue_code: repair_alpha_readiness
  selected_value_gate: routeable_candidate_count
  selected_hypothesis_id
  active_no_delta_release_key
  routeable_candidate_count_before
  routeable_candidate_count_after
  release_conditions[]
  selected_repair_ticket
  reentry_decision: allow | hold | deny
  max_notional: "0"
  reason_codes[]
```

The import board does not authorize capital. It is an evidence bridge between Jangar's material-action authority and
Torghut's no-delta auction.

### Carry States

- `current`: Jangar witness and board are fresh, source/live image facts agree, and Torghut imported matching refs.
- `rollout_lagging`: Jangar desired image is ahead of live workload image.
- `field_absent`: Jangar live status does not emit the required board or witness field.
- `stale`: imported Jangar fields exist but are expired.
- `unavailable`: Jangar carry is missing and no more specific state is known.
- `denied`: Jangar carry is present and explicitly denies material action.
- `import_mismatch`: Jangar reports a current witness but Torghut imported a different board id, source ref, or stage
  debt admission ref.

### Release Accounting Rules

Torghut denies alpha repair reentry when:

- active no-delta release key is unchanged;
- no release condition changed;
- imported Jangar carry state is `rollout_lagging`, `field_absent`, `stale`, `unavailable`, or `import_mismatch`;
- selected ticket is missing a required output receipt or validation command;
- `max_notional` is not `0`.

Torghut holds reentry when:

- Jangar carry state is `denied` but includes a current stage-debt repair admission;
- Jangar plan or verify debt is active and the selected ticket is Jangar-owned;
- Torghut can observe a changed release condition but not enough evidence to choose the next zero-notional ticket.

Torghut allows one bounded zero-notional reentry ticket when:

- Jangar carry state is `current`, or the ticket explicitly repairs Jangar carry import;
- exactly one release condition changed;
- the selected ticket targets `routeable_candidate_count` or a named prerequisite to the alpha-readiness lane;
- the ticket cites a required output receipt and validation command;
- paper and live capital remain denied.

### Release Conditions

The active no-delta key can be released only by one or more of these changes:

- source revenue-repair ref changed;
- evidence window changed;
- blocker set changed;
- required receipt set changed;
- selected hypothesis changed;
- Jangar foreclosure-carry rollout witness became current;
- Jangar stage-debt repair admission selected the carry blocker;
- schema-lineage receipt became current;
- empirical receipt became current;
- market-context receipt became current;
- execution-TCA receipt became current.

A timer is still not a release condition. Time can expire a lease; it cannot create evidence.

## Implementation Scope

Engineer milestone 1:

- Add `verification_carry_import_board.py` as a pure reducer under `services/torghut/app/trading/`.
- Feed it from optional Jangar `foreclosure_carry_rollout_witness`, `verify_trust_foreclosure_board`, and
  `stage_debt_repair_admission` payloads when present in Jangar status or consumer evidence.
- Expose compact import-board refs on `/trading/revenue-repair`, `/trading/consumer-evidence`, and `/readyz`.
- Keep enforcement in observe mode and preserve current no-delta denial behavior.

Engineer milestone 2:

- Feed import-board carry state into `no_delta_repair_reentry_auction`.
- Add release-accounting output that records whether `routeable_candidate_count` changed, stayed no-delta, or was
  blocked by Jangar carry.
- Add tests for source-only carry denial, rollout-lagging hold, current carry allow-pricing, stale carry denial,
  import mismatch, and zero-notional enforcement.

Deployer milestone:

- After Jangar rollout, prove Torghut imports a non-unavailable carry state.
- Prove duplicate no-delta alpha repair remains denied unless the imported carry or another release condition changes.
- Prove `/readyz` remains degraded while proof floor is repair-only.

## Validation Gates

Local validation for Torghut implementation:

- `uv run --frozen pytest services/torghut/tests/test_no_delta_repair_reentry_auction.py`
- `uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k revenue_repair`
- `uv run --frozen pytest services/torghut/tests/test_consumer_evidence.py -k alpha`
- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k no_delta`
- `ruff check services/torghut/app/trading services/torghut/tests`

Live validation:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.verification_carry_import_board, .no_delta_repair_reentry_auction.jangar_verification_carry'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.verification_carry_import_board'`
- `curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://torghut.torghut.svc.cluster.local/readyz`
- `curl -fsS http://agents.agents.svc.cluster.local/ready | jq '.foreclosure_carry_rollout_witness, .verify_trust_foreclosure_board'`
- `kubectl -n argocd get applications.argoproj.io agents -o json | jq '{sync: .status.sync.status, health: .status.health.status, revision: .status.sync.revision}'`

Acceptance:

- Missing Jangar witness yields `jangar_carry_state=unavailable` or a more specific rollout/field state.
- Jangar source-only carry does not release alpha repair.
- Current Jangar carry updates the auction release-condition state.
- Duplicate no-delta repair remains denied when release conditions are unchanged.
- Every selected ticket remains `max_notional=0`.

## Rollout

Phase 0 is documentation and tests.

Phase 1 emits `verification_carry_import_board` in observe mode on revenue repair and consumer evidence.

Phase 2 mirrors the compact import state to `/readyz`.

Phase 3 feeds carry state into the existing no-delta auction while preserving deny-on-unknown.

Phase 4 permits one zero-notional ticket only when Jangar carry is current or the selected ticket repairs the carry
condition.

Phase 5 lets deployer handoff count a Jangar carry fix only when both Jangar status and Torghut import board agree.

## Rollback

Rollback is to stop emitting `verification_carry_import_board` and keep the existing no-delta auction,
alpha-readiness settlement conveyor, alpha repair dividend ledger, and proof-floor holds.

If the import board falsely denies useful work:

- remove it from auction release-condition scoring;
- preserve the compact output for debugging;
- keep duplicate no-delta suppression active;
- keep `max_notional=0`.

If the import board falsely allows reentry:

- force `jangar_carry_state=denied` unless Jangar witness and board refs are fresh and matching;
- deny selected tickets until source/live/import refs are reconciled;
- keep paper and live capital denied.

## Risks

- Risk: Torghut blocks on Jangar for too long. Mitigation: the selected ticket can be a Jangar-stage repair when it
  directly retires the missing carry condition.
- Risk: carry schema drift creates false `import_mismatch`. Mitigation: version every payload and keep compact refs
  backward compatible.
- Risk: no-delta evidence hides progress on a prerequisite. Mitigation: release accounting records changed
  prerequisite receipts separately from routeable candidate delta.
- Risk: operators misread `/readyz` degradation as outage. Mitigation: readiness remains degraded for capital safety,
  while import-board status explains the actionable blocker.

## Handoff

Engineer next action: implement `torghut.verification-carry-import-board.v1` in observe mode and add tests proving
that Jangar source-only carry does not release alpha repair, while current imported carry changes the auction
release-condition state without opening capital.

Deployer next action: after Jangar promotion, prove Torghut imports a non-unavailable Jangar carry state and that
duplicate no-delta alpha repair remains denied unless a release condition changed.

The smallest blocker preventing revenue impact is current and measurable: `repair_alpha_readiness` remains the top
queue item, `routeable_candidate_count=0`, the active no-delta key is unchanged, and Jangar verification carry is
unavailable because live Jangar has not emitted the foreclosure board.
