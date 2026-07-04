# 197. Torghut Executable Alpha Repair Receipts And Zero-Notional Reentry (2026-05-13)

Status: Accepted for Jangar engineer and deployer handoff
Date: 2026-05-13
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut executable alpha repair, revenue-repair queue clearing, zero-notional capital safety, repair receipts,
Jangar material reentry, validation, rollout, rollback, and handoff.

Companion Jangar contract:

- `docs/agents/designs/192-jangar-material-readiness-reentry-clearinghouse-and-source-rollout-receipts-2026-05-13.md`

Extends:

- `196-torghut-profit-carry-passports-and-repair-capacity-futures-2026-05-13.md`
- `193-torghut-route-repair-yield-board-and-hypothesis-reentry-guardrails-2026-05-13.md`
- `192-torghut-repair-receipt-frontier-and-profit-cutover-2026-05-13.md`
- `190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`
- `168-torghut-executable-alpha-receipts-and-capital-replay-board-2026-05-07.md`
- `docs/agents/designs/192-jangar-material-readiness-reentry-clearinghouse-and-source-rollout-receipts-2026-05-13.md`

## Decision

I am selecting **executable alpha repair receipts with zero-notional reentry** as Torghut's next architecture
increment.

The current business evidence is unambiguous. `GET /trading/revenue-repair` returned
`schema_version=torghut.revenue-repair-digest.v1`, `revenue_ready=false`, `business_state=repair_only`, and
`operating_rule=keep_live_submit_disabled_until_repair_queue_clears`. Capital stayed at `max_notional=0`,
`capital_stage=shadow`, and `capital_state=zero_notional`. The top repair queue item was
`repair_alpha_readiness`, with reason `hypothesis_not_promotion_eligible`, value gate
`routeable_candidate_count`, and required output receipt `torghut.executable-alpha-receipts.v1`. The second queue
item was `live_submit_gate_closed`, but it correctly remains downstream of alpha readiness and proof-floor repair.

`GET /readyz` returned HTTP 503 with `status=degraded`. That is the right readiness truth. Scheduler, Postgres,
ClickHouse, Alpaca, database schema, universe, readiness cache, and empirical jobs were OK. The degradations were
capital and proof state: live submit disabled, profitability proof floor repair-only, zero notional capital, zero
promotion-eligible hypotheses, and alpha hypotheses stuck in shadow. `GET /db-check` returned `ok=true`,
`schema_current=true`, current and expected Alembic head `0031_autoresearch_candidate_spec_epoch_uniqueness`, no
missing heads, no unexpected heads, and lineage ready with known parent-fork warnings.

The selected design makes the top queue item actionable without making it capital-unsafe. Torghut must emit a compact
`torghut.executable-alpha-repair-receipt.v1` for each alpha repair attempt. The receipt names the hypothesis, lineage
state, stale or missing evidence, required receipts, expected blocker delta, validation command, capital rule, and
no-delta settlement if the repair fails to retire a blocker. Jangar's material readiness clearinghouse may spend
runner capacity only on receipts that stay zero-notional and tie back to the live `/trading/revenue-repair` queue.

The tradeoff is that this design slows generic route or market-context work when alpha readiness is the top repair
queue item. I accept that. Torghut does not need more parallel repair noise. It needs a narrow loop that clears the
highest-value blocker while preserving capital safety and producing receipts that Jangar can trust.

## Governing Runtime Requirements

This contract follows the active Jangar validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Torghut value gates:

- `routeable_candidate_count`
- `zero_notional_or_stale_evidence_rate`
- `fill_tca_or_slippage_quality`
- `capital_gate_safety`
- `post_cost_daily_net_pnl`

Jangar cross-plane value gates:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Current Evidence

Evidence was collected read-only on 2026-05-13. I did not mutate Kubernetes resources, database rows, broker state,
trading flags, GitOps resources, AgentRuns, or market data.

### Runtime And Cluster

- Argo CD reported `torghut` and `torghut-options` as `Synced/Healthy`.
- Current live and sim Knative revisions were ready at `torghut-00365` and `torghut-sim-00463` on image digest
  `sha256:463a60692de94f5ff8ebd7201d792316bbf5dbc0bb02419612d776c9735f9acf`.
- Torghut serving pods, options catalog, options enricher, TA, TA sim, WebSocket services, ClickHouse, Keeper,
  guardrail exporters, and `torghut-db-1` were running.
- Recent events showed normal rollout probe noise and successful DB migration and backfill jobs, but also recurring
  whitepaper autoresearch profit-target errors and scheduled Torghut quant AgentRun failures. That confirms repair
  work needs sharper admission rather than broader launch.

### Database And Data Quality

- `/db-check` returned `ok=true`, `schema_current=true`, `current_heads=["0031_autoresearch_candidate_spec_epoch_uniqueness"]`,
  `expected_heads=["0031_autoresearch_candidate_spec_epoch_uniqueness"]`, and no missing or unexpected heads.
- Schema graph lineage was ready. Known parent-fork warnings remained for historical branches around
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Account-scope checks were ready, with the warning that account scope checks are bypassed while
  `trading_multi_account_enabled` is false.
- `/readyz` dependency state proved the storage path was not the current business blocker: Postgres, ClickHouse,
  Alpaca, database schema, universe, readiness cache, empirical jobs, and scheduler were OK.

### Revenue Repair And Alpha Readiness

- `/trading/revenue-repair` returned `revenue_ready=false`, `business_state=repair_only`, and
  `operating_rule=keep_live_submit_disabled_until_repair_queue_clears`.
- Capital remained `live_submission_allowed=false`, `live_submission_reason=simple_submit_disabled`,
  `capital_stage=shadow`, `proof_floor_state=repair_only`, `route_state=repair_only`,
  `capital_state=zero_notional`, and `max_notional=0`.
- The top repair queue item was:
  - `code=repair_alpha_readiness`
  - `reason=hypothesis_not_promotion_eligible`
  - `dimension=alpha_readiness`
  - `action=clear_hypothesis_blockers_before_capital`
  - `priority=70`
  - `expected_unblock_value=2`
  - `value_gate=routeable_candidate_count`
  - `required_output_receipt=torghut.executable-alpha-receipts.v1`
- The second repair queue item was `live_submit_gate_closed`, requiring `torghut.capital-hold-repair-receipt.v1`.
  It must stay downstream until alpha readiness and proof-floor receipts improve.
- `/readyz` evaluated three alpha hypotheses. All stayed shadow-only. `H-CONT-01` and `H-REV-01` lacked strategy
  hypothesis lineage. `H-MICRO-01` had lineage but stale window evidence. Promotion eligible total was `0`.
- Profit leases were current but blocked: three leases had `capital_decision=repair_only` and proof state `blocked`.
  Blocking reasons included `autoresearch_portfolio_candidates_blocked`, `autoresearch_portfolio_ready_empty`,
  `equity_ta_rows_missing`, `hypothesis_not_promotion_eligible`, and `rejection_drag_unmeasured`.

## Problem

Torghut has a clear repair queue, but the current action surface is too broad for capital-safe Jangar admission.

The current failure modes are:

- The top queue item is alpha readiness, but repair evidence is scattered across `/readyz`, `/trading/status`,
  profit leases, capital replay, route repair, and revenue repair.
- Alpha hypotheses can be shadow-only for different reasons: missing strategy lineage, stale evidence window, blocked
  autoresearch portfolio, missing equity TA rows, or unmeasured rejection drag.
- Jangar can see that Torghut is repair-only, but not which single receipt should be funded next without reading long
  payloads.
- Generic route or market-context repairs can consume runner capacity even when the live queue says
  `repair_alpha_readiness` is the top blocker.
- Live submit is correctly disabled, but the system still needs a measurable zero-notional path to learn.

The next architecture must turn the top repair queue item into a compact contract. That contract must be safe for
zero-notional execution, measurable enough to know whether it retired a blocker, and precise enough for Jangar to
admit or hold it without manual synthesis.

## Alternatives Considered

### Option A: Continue Existing Revenue Repair Queue Dispatch

This option keeps using `/trading/revenue-repair` and existing repair bid settlement fields as the operative
contract.

Advantages:

- No new schema.
- Keeps the current queue visible.
- Low implementation cost.

Disadvantages:

- The queue item is not a proof receipt.
- Does not encode no-delta settlement.
- Does not bind a repair attempt to a Jangar material reentry receipt.
- Does not distinguish missing lineage from stale window evidence in the dispatch contract.

Decision: reject as the primary path. The queue remains the business evidence surface, but workers need a receipt.

### Option B: Prioritize Execution TCA Because It Has Dispatchable Lots

This option funds execution TCA repair first because Jangar consumer evidence and repair-bid settlement often show
execution TCA as a dispatchable selected lot.

Advantages:

- Execution TCA is a real blocker.
- It maps to existing tests such as `pytest services/torghut/tests/test_repair_bid_settlement.py -k execution_tca`.
- Fill quality is a direct trading guardrail.

Disadvantages:

- It is not the current top `/trading/revenue-repair` queue item.
- It can improve route diagnostics while leaving promotion-eligible hypotheses at zero.
- It risks spending capacity on route proof before alpha readiness can consume it.

Decision: reject as the next architecture increment. Execution TCA remains a secondary receipt class behind alpha
readiness when revenue repair says alpha is first.

### Option C: Executable Alpha Repair Receipts

This option makes the top alpha readiness queue item produce a typed receipt per hypothesis and per repair attempt.

Advantages:

- Directly follows the live business evidence surface.
- Keeps `max_notional=0` until capital reentry proof exists.
- Gives Jangar one compact receipt to admit, hold, or reject.
- Separates missing lineage, stale evidence, blocked portfolio candidates, missing TA rows, and rejection drag.
- Creates no-delta settlement when a repair fails to retire a blocker.

Disadvantages:

- Adds a schema and tests.
- Requires stable reason-code mapping from existing alpha/profit payloads.
- Can hold other useful repairs until the top alpha queue item is settled or explicitly waived.

Decision: select Option C.

## Architecture

### Executable Alpha Repair Receipt

```text
executable_alpha_repair_receipt
  schema_version = torghut.executable-alpha-repair-receipt.v1
  receipt_id
  generated_at
  fresh_until
  source_revenue_repair_ref
  account
  window
  hypothesis_id
  candidate_id
  strategy_id
  lineage_status = ready | missing | stale | contradictory
  evidence_window_status = current | stale | missing
  alpha_readiness_state = shadow | repair_only | promotion_candidate | blocked
  repair_class
  target_value_gate
  expected_unblock_value
  expected_gate_delta
  required_input_refs[]
  required_output_receipts[]
  validation_commands[]
  max_notional
  capital_rule = zero_notional_repair_only
  no_delta_settlement_required
  rollback_target
```

`repair_class` is one of:

- `strategy_lineage_repair`
- `evidence_window_refresh`
- `autoresearch_portfolio_repair`
- `equity_ta_refill`
- `rejection_drag_measurement`
- `capital_replay_board_refresh`
- `promotion_decision_receipt`

The first production version should cover the reason codes observed in this assessment:

- `hypothesis_not_promotion_eligible`
- `hypothesis_window_evidence_missing`
- `hypothesis_window_evidence_stale`
- `strategy_hypothesis_missing`
- `autoresearch_portfolio_candidates_blocked`
- `autoresearch_portfolio_ready_empty`
- `equity_ta_rows_missing`
- `hypothesis_not_promotion_eligible`
- `rejection_drag_unmeasured`

### Receipt Selection

When `/trading/revenue-repair` says the top queue item is `repair_alpha_readiness`, Torghut should select at most one
primary executable alpha repair receipt per Jangar capacity window. Selection order:

1. missing strategy hypothesis lineage;
2. stale or missing hypothesis window evidence;
3. autoresearch portfolio blocked or ready-empty;
4. missing equity TA rows;
5. rejection drag unmeasured;
6. missing promotion decision receipt;
7. capital replay board refresh.

This order is deliberate. A fresh TCA receipt does not help if the hypothesis cannot be linked to a strategy or
promotion surface. A paper canary does not help if rejection drag is still unmeasured and capital is zero-notional.

### Jangar Reentry Binding

Each receipt must include a Jangar binding:

```text
jangar_reentry
  governing_design_ref
  required_material_reentry_receipt = jangar.material-reentry-receipt.v1
  action_class = torghut_observe | dispatch_repair
  max_parallelism
  max_runtime_seconds
  value_gates[]
  rollback_target = keep max_notional=0 and live submit disabled
```

Jangar may admit the repair only when:

- the receipt is fresh;
- `max_notional` is `0`;
- the source revenue-repair digest is current;
- the receipt maps to the top queue item or to an explicitly selected dispatchable repair lot;
- the validation command is present;
- Jangar watch/source reentry gates are not higher priority blockers.

### No-Delta Settlement

Every repair attempt must produce one of:

- `retired`: the target reason code disappeared from `/trading/revenue-repair`, `/readyz`, or the alpha evidence
  surface within the receipt TTL;
- `improved`: the target value gate improved but the reason code remains;
- `no_delta`: the repair ran and did not improve the target gate;
- `invalidated`: the underlying queue item changed before the repair completed.

`no_delta` is not a failure by itself. It becomes a capacity tax for the next Jangar material reentry window so the
system stops spending equal capacity on repeated low-yield repairs.

### Capital Safety

This contract does not enable paper or live capital. Capital stays blocked until all of the following are true:

- executable alpha receipts produce at least one promotion-eligible hypothesis;
- proof floor is not repair-only;
- routeability acceptance is not blocked;
- execution TCA and market-context receipts are current;
- live submit remains explicitly enabled by policy;
- Jangar ready truth moves `paper_canary` out of hold;
- a separate capital reentry receipt names max notional and rollback.

Until then, every receipt in this contract must carry `max_notional=0`.

## Implementation Scope

### Engineer Milestone 1: Receipt Builder

Implement a pure receipt builder around existing Torghut evidence surfaces, likely near
`services/torghut/app/trading/executable_alpha_receipts.py` and `services/torghut/app/trading/revenue_repair.py`.

Acceptance gates:

- Given the current revenue-repair shape with top queue item `repair_alpha_readiness`, the builder emits
  `torghut.executable-alpha-repair-receipt.v1`.
- Missing strategy lineage maps to `repair_class=strategy_lineage_repair`.
- Stale window evidence maps to `repair_class=evidence_window_refresh`.
- Blocked autoresearch portfolio maps to `repair_class=autoresearch_portfolio_repair`.
- Every receipt includes `max_notional=0`, `capital_rule=zero_notional_repair_only`, validation commands, and
  `no_delta_settlement_required=true`.

Suggested command:

- `pytest services/torghut/tests/test_executable_alpha_repair_receipts.py`

### Engineer Milestone 2: Revenue Repair Digest Integration

Add a compact `executable_alpha_repair_receipts` section to `/trading/revenue-repair` and mirror the selected receipt
into `/trading/consumer-evidence` for Jangar. Do not make `/readyz` green because of the receipt; it remains degraded
until the blocker is actually retired.

Acceptance gates:

- `/trading/revenue-repair` keeps `revenue_ready=false` while capital is zero-notional.
- The top queue item and selected receipt agree on `target_value_gate=routeable_candidate_count`.
- The consumer evidence payload exposes only the compact receipt, not a large nested diagnostics dump.
- Existing tests for revenue repair and consumer evidence are updated.

Suggested commands:

- `pytest services/torghut/tests/test_build_revenue_repair_digest.py -k alpha`
- `pytest services/torghut/tests/test_repair_bid_settlement.py -k feature_lineage`
- `pytest services/torghut/tests/test_executable_alpha_receipts.py`

### Engineer Milestone 3: No-Delta Settlement

Record repair outcomes against the receipt ID. A repeated no-delta class should raise capacity cost in Jangar's next
material reentry receipt but must not enable capital.

Acceptance gates:

- A receipt that does not retire `hypothesis_not_promotion_eligible` emits `no_delta`.
- A receipt that makes one hypothesis promotion-eligible emits `retired` or `improved`.
- The settlement carries before and after reason codes and value gate measurements.

## Validation Gates

This contract is successful when:

- `routeable_candidate_count`: at least one executable alpha repair receipt moves a hypothesis toward routeable
  candidacy or records no-delta with evidence.
- `zero_notional_or_stale_evidence_rate`: repair attempts stay zero-notional and retire stale/missing alpha evidence
  reasons.
- `fill_tca_or_slippage_quality`: execution TCA remains a guardrail and is not bypassed by alpha repair.
- `capital_gate_safety`: paper/live stays blocked until a separate capital reentry receipt exists.
- `post_cost_daily_net_pnl`: no repair claims profit improvement without post-cost replay or explicit no-delta.
- `failed_agentrun_rate`: Jangar launches fewer low-yield Torghut repairs because admission follows the top receipt.
- `handoff_evidence_quality`: the final handoff cites receipt IDs, before/after reason codes, and validation commands.

## Rollout Plan

1. Add receipt builder in tests first.
2. Expose receipts in `/trading/revenue-repair` in observe mode.
3. Mirror the selected compact receipt into `/trading/consumer-evidence`.
4. Let Jangar material reentry clearinghouse read the receipt but not enforce for one deploy cycle.
5. Enforce zero-notional repair admission only after the selected receipt matches observed repair work.
6. Keep `/readyz` degraded until the underlying blocker is gone.
7. Consider paper canary only after capital reentry proof is produced in a separate PR.

## Rollback Plan

Rollback is safe and capital-preserving:

- stop emitting `executable_alpha_repair_receipts`;
- keep `/trading/revenue-repair` and existing repair bid settlement payloads intact;
- keep live submit disabled;
- keep `max_notional=0`;
- keep Jangar material reentry enforcement in observe mode;
- mark any generated receipts as superseded rather than deleting them.

## Risks

- Reason-code mapping can drift as alpha readiness evolves. Mitigation: test mappings against representative
  `/readyz` and `/trading/revenue-repair` payloads.
- The top queue item can change while a repair runs. Mitigation: `invalidated` settlement and TTL-bound receipts.
- Engineers may treat receipt emission as readiness. Mitigation: `/readyz` remains degraded until blockers retire.
- A repair may repeatedly produce no-delta. Mitigation: Jangar capacity tax and required no-delta handoff.

## Handoff To Engineer

Build the receipt builder before changing scheduler or capital behavior. The first production PR should:

- add `torghut.executable-alpha-repair-receipt.v1`;
- map current alpha readiness blockers to repair classes;
- expose compact receipts in `/trading/revenue-repair`;
- keep `max_notional=0`;
- add tests for missing lineage, stale window evidence, blocked autoresearch portfolio, missing TA rows, rejection
  drag, and no-delta settlement;
- cite this design in code or test fixtures that define the receipt contract.

The bounded implementation milestone is: **emit compact executable alpha repair receipts for the current top
`repair_alpha_readiness` queue item without enabling paper or live capital**.

## Handoff To Deployer

Do not treat a new executable alpha receipt as revenue readiness. It is a repair ticket. After rollout, prove:

- Argo `torghut` and `torghut-options` are `Synced/Healthy`;
- current live revision is ready;
- `/db-check` remains `ok=true` and schema-current;
- `/trading/revenue-repair` still reports `max_notional=0`;
- the selected receipt is fresh and maps to the top queue item;
- `/readyz` remains degraded until alpha readiness actually improves;
- live submit is still disabled unless a separate capital reentry receipt is present.

## Metrics And Reporting

The next Torghut verify handoff must include:

- selected executable alpha receipt ID;
- before and after alpha readiness reason codes;
- before and after `routeable_candidate_count`;
- no-delta, improved, retired, or invalidated settlement;
- validation commands and results;
- evidence that max notional stayed zero;
- smallest blocker preventing paper canary if alpha readiness remains blocked.
