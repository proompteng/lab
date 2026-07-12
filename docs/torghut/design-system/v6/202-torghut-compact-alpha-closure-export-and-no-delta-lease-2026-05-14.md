# 202. Torghut Compact Alpha Closure Export And No-Delta Lease (2026-05-14)

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

I am selecting a **compact alpha closure export with a no-delta lease** for Torghut's Jangar-facing evidence boundary.

Torghut has crossed an important line: it no longer only says that alpha readiness is blocked. It now emits the
closure market that explains what should happen next. On 2026-05-14, `/trading/revenue-repair` returned
`business_state=repair_only`, `revenue_ready=false`, top queue item `repair_alpha_readiness`, selected value gate
`routeable_candidate_count`, max notional `0`, and an `alpha_repair_closure_board` with a nested
`alpha_closure_settlement_market`. That market selected `H-MICRO-01`, selected `feature_replay_closure`, required
`torghut.alpha-closure-settlement-receipt.v1`, and had a consumed no-delta budget.

The problem is not that Torghut lacks proof. The problem is that the proof is trapped in the full business endpoint.
Jangar consumes `/trading/consumer-evidence` for stage and admission decisions. That projection currently exposes
executable alpha repair receipts, but it does not expose `alpha_repair_closure_board_ref`,
`alpha_closure_settlement_market_ref`, or the no-delta budget state. As a result, Jangar can see a repair-only system
but cannot safely deny the exact repeated closure that Torghut already marked no-delta.

The selected design exports a compact passport from Torghut consumer evidence. It is not the full board, and it is not
an order or execution command. It is a launch-custody object for Jangar: board id, market id, selected hypothesis,
selected value gate, required receipt, active dedupe key, no-delta state, source refs, validation commands, max
notional, and rollback target.

The tradeoff is that Torghut now owns one more compatibility surface. I accept that. The alternative is worse:
Jangar either polls a large endpoint in admission or continues to launch from stale executable repair receipts. A small
passport is the correct boundary between Torghut strategy evidence and Jangar launch custody.

## Governing Runtime Requirements

This contract follows the active validation requirements:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Torghut value-gate mapping:

- `routeable_candidate_count`: the passport preserves the selected alpha closure market and value gate.
- `zero_notional_or_stale_evidence_rate`: missing or stale passport holds Jangar admission.
- `fill_tca_or_slippage_quality`: TCA remains a graduation guardrail, not an excuse to bypass alpha closure.
- `post_cost_daily_net_pnl`: post-cost blockers stay in the board and settlement receipt, but are not capital
  authority.
- `capital_gate_safety`: max notional remains `0`; live submit remains disabled.

Jangar value-gate mapping:

- `failed_agentrun_rate`: consumed no-delta budget becomes a pre-launch denial.
- `pr_to_rollout_latency`: deployers can verify a compact passport on the same consumer-evidence route Jangar uses.
- `ready_status_truth`: `repair_only` is not launch authority without a valid passport.
- `manual_intervention_count`: operators no longer compare full Torghut payloads by hand.
- `handoff_evidence_quality`: every handoff cites the same passport id, board id, market id, and rollback target.

## Current Evidence

All evidence was collected read-only on 2026-05-14.

### Cluster And Serving Evidence

- Argo `agents`, `jangar`, and `torghut` were `Synced/Healthy/Succeeded` at
  `29f0d1c9fd417fc65666896b6b5433be668c78a5`.
- Agents workloads were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Jangar was available: `deployment/jangar=1/1`.
- Torghut Knative revisions were rolling to `torghut-00376` and `torghut-sim-00474`; recent events showed startup and
  readiness probe failures before revisions became ready.
- Jangar `/ready` returned `status=ok` with execution trust healthy.
- Retained AgentRun evidence still showed failure pressure: `791` total AgentRuns, `121` Failed, and recent failures
  from Jangar verify, Torghut quant verify and implement, and market-context fundamentals.

### Database And Data Evidence

- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, schema graph lineage
  ready, and account scope ready.
- Known historical parent forks remain under `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Direct CNPG and pod exec access were forbidden to the current service account. That is acceptable for this lane
  because `/db-check` is the read-only application witness.
- `/readyz` returned HTTP 503 with `status=degraded`, which is correct while live submission is disabled and the proof
  floor is repair-only.
- The `ta-core` segment was blocked by `feature_rows_missing` and `required_feature_set_unavailable`.
- Promotion eligible total was `0`.

### Revenue Repair And Closure Evidence

- `/trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, and queue count `2`.
- Top queue item:
  - `code=repair_alpha_readiness`
  - `reason=hypothesis_not_promotion_eligible`
  - `value_gate=routeable_candidate_count`
  - `expected_unblock_value=4`
  - `required_output_receipt=torghut.executable-alpha-receipts.v1`
  - `max_notional=0`
  - `capital_rule=zero_notional_repair_only`
- `alpha_repair_closure_board.status=selected`.
- Board id: `alpha-repair-closure-board:ae9a8b5d68641483f4d9b541`.
- Settlement market id: `alpha-closure-settlement-market:2b8cebb98cc14f7b9a7dd031`.
- Selected market:
  - `selected_hypothesis_id=H-MICRO-01`
  - `selected_repair_class=feature_replay_closure`
  - `selected_lot_class=feature_lineage`
  - `selected_value_gate=routeable_candidate_count`
  - `required_output_receipt=torghut.alpha-closure-settlement-receipt.v1`
  - `max_notional=0`
  - `capital_rule=zero_notional_repair_only`
- No-delta budget:
  - `state=consumed`
  - `used_attempts=1`
  - `remaining_attempts=0`
  - release conditions: `evidence_window_changes`, `blocker_set_changes`, `source_ref_changes`,
    `required_receipt_changes`
- Pending settlement receipt preserved `drift_checks_missing`, `feature_rows_missing`,
  `required_feature_set_unavailable`, and `closed_session_signal_hold`.
- Jangar consumer evidence did not expose compact alpha closure refs. It observed
  `executable_alpha_repair_receipts`, but not the current board or no-delta lease.

## Problem

Torghut's full revenue-repair endpoint is now ahead of its consumer-evidence projection.

That creates five concrete failure modes.

First, Jangar can launch from a current executable repair receipt without seeing that the selected alpha closure market
has a consumed no-delta budget.

Second, Jangar can choose the wrong hypothesis. The executable receipt selection can point at `H-CONT-01`, while the
closure market has selected `H-MICRO-01` for feature replay.

Third, deployer validation has two sources of truth. The full revenue-repair endpoint proves the board; the
consumer-evidence endpoint is what Jangar actually consumes.

Fourth, no-delta release conditions are not carried across the boundary. Torghut says "do not retry until evidence
changes"; Jangar cannot enforce that without polling the full board.

Fifth, large payload coupling would make admission fragile. Copying the full board into Jangar is a tempting shortcut,
but it would turn a business diagnostic endpoint into a launch-control API.

## Alternatives Considered

### Option A: Leave The Board Only On `/trading/revenue-repair`

Torghut keeps current behavior and expects Jangar or deployers to fetch the full endpoint when needed.

Advantages:

- No new Torghut schema.
- The full board remains available for diagnostics.
- No risk of compact/full projection mismatch.

Disadvantages:

- Jangar admission cannot enforce no-delta denial without direct full-payload coupling.
- Deployer proof remains manual.
- Failed AgentRuns can repeat from stale executable receipts.
- The consumer-evidence boundary remains incomplete.

Decision: reject.

### Option B: Mirror The Full Alpha Closure Board Into Consumer Evidence

Torghut copies the full board, settlement market, receipts, and no-delta arrays into `/trading/consumer-evidence`.

Advantages:

- Jangar has all fields.
- No separate compact schema is needed.
- Debugging is straightforward.

Disadvantages:

- Payload size and volatility increase sharply.
- Strategy-specific details leak into the launch boundary.
- Schema changes in the full board can break Jangar admission.
- It obscures the one thing Jangar needs: whether exactly one zero-notional slot is allowed, held, or denied.

Decision: reject.

### Option C: Export A Compact Alpha Closure Passport

Torghut publishes a small, stable passport on consumer evidence and keeps the full board on revenue repair.

Advantages:

- Preserves a clean ownership boundary.
- Carries no-delta state to Jangar without copying the full board.
- Gives deployers one lightweight proof object.
- Lets Torghut evolve internal board details while keeping the launch contract stable.
- Keeps all capital safety fields explicit.

Disadvantages:

- Adds schema compatibility work.
- Requires shadow comparison against the full board before enforcement.
- Needs tests in both Torghut and Jangar.

Decision: select Option C.

## Architecture

Torghut emits `alpha_closure_passport` inside `/trading/consumer-evidence`.

```text
alpha_closure_passport
  schema_version = torghut.alpha-closure-passport.v1
  passport_id
  generated_at
  fresh_until
  source_revenue_repair_ref
  source_alpha_repair_closure_board_ref
  source_alpha_closure_settlement_market_ref
  source_repair_outcome_dividend_ref
  serving_revision
  serving_image_digest
  source_commit
  business_state = repair_only
  revenue_ready = false
  board_status
  market_status
  selected_hypothesis_id
  selected_repair_class
  selected_lot_class
  selected_value_gate
  required_output_receipt
  active_dedupe_key
  no_delta_budget
  pending_settlement_receipt_ref
  before_blocker_codes[]
  release_conditions[]
  validation_commands[]
  max_notional = 0
  capital_rule = zero_notional_repair_only
  rollback_target
```

The no-delta lease is compact:

```text
no_delta_budget
  max_attempts_per_dedupe_key = 1
  used_attempts
  remaining_attempts
  state = available | consumed | unavailable
  release_conditions[]
  active_dedupe_key
  next_allowed_attempt_after
```

Export rules:

1. Export only when `/trading/revenue-repair` has a valid alpha closure board.
2. Keep the passport additive and optional.
3. Preserve the full board on `/trading/revenue-repair`.
4. Include no more than the latest selected market and active no-delta lease.
5. Set `state=unavailable` with reason codes if the board is missing, stale, schema-invalid, or nonzero notional.
6. Never use passport generation to submit orders, mutate receipts, or change capital flags.
7. Keep `max_notional=0` and `capital_rule=zero_notional_repair_only`.

Jangar consumes only the passport for stage admission. Deployer and incident diagnostics may still fetch the full
board from `/trading/revenue-repair`.

## Implementation Scope

M1: Build the compact passport helper.

- Input: revenue repair digest, alpha repair closure board, repair outcome dividend, serving build metadata, current
  time.
- Output: `alpha_closure_passport`.
- Tests: selected board, missing board, stale board, consumed no-delta, available no-delta, nonzero notional,
  selected hypothesis, and required receipt.

M2: Expose the passport on `/trading/consumer-evidence`.

- Keep it additive.
- Do not remove executable alpha repair receipts.
- Do not change `/readyz`.
- Do not change live submit, capital stage, or notional.

M3: Compact status for Jangar.

- Include `passport_id`, `board_id`, `market_id`, `selected_hypothesis_id`, `selected_value_gate`,
  `required_output_receipt`, `active_dedupe_key`, `no_delta_budget.state`, `remaining_attempts`, `max_notional`,
  `capital_rule`, and `rollback_target`.

M4: Validation with Jangar.

- Jangar should show the passport in control-plane status.
- In the current evidence state, Jangar should hold or deny launch because no-delta is consumed.
- Jangar should not open paper or live actions.

## Validation Gates

Architecture PR validation:

- `bunx oxfmt --check docs/agents/designs/197-jangar-compact-alpha-closure-ingestion-and-stage-credit-repair-gate-2026-05-14.md docs/torghut/design-system/v6/202-torghut-compact-alpha-closure-export-and-no-delta-lease-2026-05-14.md docs/agents/release-handoffs/jangar-alpha-closure-ingestion-2026-05-14.md docs/agents/README.md docs/torghut/design-system/v6/index.md`
- `git diff --check`

Engineer validation:

- `cd services/torghut && uv run --frozen pytest tests/test_alpha_repair_closure_board.py -k compact`
- `cd services/torghut && uv run --frozen pytest tests/test_trading_api.py -k consumer_evidence`
- `cd services/torghut && uv run --frozen pytest tests/test_build_revenue_repair_digest.py -k alpha_repair_closure`
- `cd services/torghut && uv run --frozen ruff check app/trading tests/test_alpha_repair_closure_board.py tests/test_trading_api.py`
- Jangar companion validation from doc 197 must pass if the PR spans both services.

Deployer validation:

- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` includes the full alpha closure board.
- `GET http://torghut.torghut.svc.cluster.local/trading/consumer-evidence` includes `alpha_closure_passport`.
- `GET http://torghut.torghut.svc.cluster.local/db-check` stays schema-current.
- `/readyz` may remain HTTP 503 while `simple_submit_disabled` and repair-only proof floor are true.
- Jangar status includes the compact passport and alpha closure repair gate.
- No nonzero notional or live submit flag appears in the passport.

## Rollout

Phase 0 merges this architecture contract.

Phase 1 adds the compact passport helper and unit tests.

Phase 2 exposes the passport on `/trading/consumer-evidence` in observe mode.

Phase 3 validates that the passport matches the full board on `/trading/revenue-repair` for one rollout window.

Phase 4 lets Jangar consume the passport in shadow mode.

Phase 5 lets Jangar enforce denial for consumed no-delta keys.

## Rollback

Rollback is additive:

- stop emitting `alpha_closure_passport`;
- keep `/trading/revenue-repair` full alpha closure board unchanged;
- keep executable alpha repair receipts unchanged;
- keep live submission disabled and max notional zero;
- preserve no-delta receipts and repair outcome records for audit;
- do not delete jobs, AgentRuns, database rows, or trading evidence.

## Risks

- Compact passport drift from the full board can cause wrong launch decisions. Mitigation: shadow compare passport refs
  against the full board before enforcement.
- A consumed no-delta budget can block a valid retry. Mitigation: release on evidence window, blocker set, source ref,
  or required receipt change.
- Payload consumers may treat passport presence as capital readiness. Mitigation: include `business_state=repair_only`,
  `revenue_ready=false`, `max_notional=0`, and `capital_rule=zero_notional_repair_only`.
- Jangar may still hold dispatch because of source-serving mismatch. That is correct; this passport only removes the
  ambiguity around alpha closure, not source rollout proof.

## Handoff

Engineer: implement the compact passport as a pure projection. Do not change order submission, capital flags,
readiness semantics, or existing revenue-repair board generation. The current live passport should report consumed
no-delta and therefore should not open a new Jangar repair slot.

Deployer: prove the full board and compact passport are both present after rollout, prove Jangar ingests the passport,
and prove max notional remains zero. Do not claim revenue readiness while `routeable_candidate_count=0` and
`revenue_ready=false`.

Revenue metric improved: `routeable_candidate_count` remains the target, but the immediate control-plane improvement
is launch quality. The smallest current blocker is missing compact passport visibility in Jangar plus consumed
no-delta debt for the `H-MICRO-01` feature replay closure.
