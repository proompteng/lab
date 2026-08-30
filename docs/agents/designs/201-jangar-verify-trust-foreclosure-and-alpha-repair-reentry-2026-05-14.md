# 201. Jangar Verify-Trust Foreclosure And Alpha-Repair Reentry (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane verify trust, source-rollout truth, material-action admission, Torghut alpha-repair reentry,
no-delta suppression, validation, rollout, rollback, and cross-swarm handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md`

Extends:

- `200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`
- `199-jangar-material-action-custody-flight-recorder-and-merge-reentry-slo-2026-05-14.md`
- `188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `180-jangar-execution-trust-debt-retirement-and-profit-repair-settlement-2026-05-08.md`
- `175-jangar-failure-debt-clearance-and-action-reentry-frontier-2026-05-08.md`

## Decision

I am selecting a **verify-trust foreclosure board with alpha-repair reentry admission** as the next Jangar
control-plane contract.

The current system is healthy in the places that used to be the obvious blockers, and degraded in the place that now
matters. On 2026-05-14 around 12:11Z, Jangar's control-plane status reported healthy agents, supporting, and
orchestration controllers; healthy watch reliability with `548` events, `0` errors, and `1` restart in a 15 minute
window; and a healthy database with `29` registered Kysely migrations and `29` applied migrations. `/ready` returned
`status=ok`. Those are good signs.

They are not enough to admit material work. The same evidence reported `execution_trust.status=degraded` because
`jangar-control-plane:verify` had consecutive failures. Source rollout truth was in
`heartbeat_projection_split`, with `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`,
`paper_canary`, `live_micro_canary`, and `live_scale` held. Recent `AgentRun` inventory showed `124` failed runs,
`667` succeeded runs, `6` running runs, `11` pending runs, and `12` templates in the `agents` namespace. That is not a
serving outage, but it is an admission problem.

Torghut confirms the same shape from the business side. `/trading/revenue-repair` remained
`business_state=repair_only`, `revenue_ready=false`, with top queue item `repair_alpha_readiness`, value gate
`routeable_candidate_count`, and `max_notional=0`. The current alpha-readiness settlement conveyor was already in
`no_delta`, selected `H-MICRO-01`, measured `routeable_candidate_count` as `0 -> 0`, and carried an active no-delta
release key. Jangar should not spend another verify or repair launch on the same unchanged proof package.

The selected design adds a Jangar `verify_trust_foreclosure_board` and a narrower `alpha_repair_reentry_admission`
decision. The board converts verify-stage failure debt, source-rollout truth, controller witness state, Torghut
consumer evidence, and Torghut no-delta release keys into one machine-readable answer: allow observe-only work, hold
material action, deny duplicate no-delta repair, or open one bounded reentry slot with an explicit validation receipt.

The tradeoff is that Jangar becomes stricter about proof reuse. Some repair work that looks safe at the Kubernetes
level will be denied until it proves either a changed Torghut release condition or a current verify-trust retirement
receipt. I accept that. The business metric is fewer failed AgentRuns and shorter green PR-to-healthy GitOps rollout
time. Re-running unchanged no-delta repairs increases both failure rate and operator ambiguity.

## Governing Runtime Requirements

This contract implements the active swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Value-gate mapping:

- `failed_agentrun_rate`: deny duplicate no-delta launches and require verify-debt foreclosure before new material
  dispatch.
- `pr_to_rollout_latency`: require the reentry board to carry source SHA, image digest, Argo/workload evidence, and
  service health in one packet.
- `ready_status_truth`: preserve `/ready` serving truth while separating material-action authority.
- `manual_intervention_count`: replace manual synthesis of verify failures, no-delta keys, and rollout split with one
  compact decision.
- `handoff_evidence_quality`: every handoff cites the foreclosure board id, Torghut release key, decision, validation
  command, and rollback target.

Torghut value-gate mapping:

- `routeable_candidate_count`: no alpha repair reentry is allowed unless the launch can move this gate or record a new
  no-delta result under a changed release condition.
- `zero_notional_or_stale_evidence_rate`: unchanged evidence and stale release keys are denial evidence.
- `fill_tca_or_slippage_quality`: TCA work is admitted only as a named prerequisite to release the alpha-readiness
  blocker, not as a competing generic lane.
- `post_cost_daily_net_pnl`: post-cost evidence remains required before paper or live capital.
- `capital_gate_safety`: every reentry action is `max_notional=0`; paper and live action classes stay held or blocked.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records, trading
flags, AgentRuns, GitOps resources, broker state, or market data.

### Cluster And Rollout Evidence

- The active identity was `system:serviceaccount:agents:agents-sa`.
- Agents deployments were available: `agents` `1/1`, `agents-controllers` `2/2`, and `agents-alloy` `1/1`.
- Jangar serving image was `registry.ide-newton.ts.net/lab/jangar-control-plane:af7de0d0` at digest
  `sha256:f668fea1bf077292bd788b29aff026ae75cb7430f192c9e003944359fc84f5aa`.
- Agents controller image was `registry.ide-newton.ts.net/lab/jangar:af7de0d0` at digest
  `sha256:5f883f91b8b02671d9ff6b3cff82c35a25d16ee3d80dffd8039126fbc03413bb`.
- Recent agents events were mostly successful scheduled jobs and completions, but still included verify
  `BackoffLimitExceeded` and readiness-probe timeouts on Jangar and controller pods.
- Torghut live and sim revisions rolled to `torghut-00389` and `torghut-sim-00487` on image digest
  `sha256:f451b35a66392e9d769ebab8b6c7708f617b5449d6473aed8b349ea34f60187b`.
- Torghut events showed normal revision replacement and completed migration/bootstrap jobs, plus transient probe
  failures during startup, profit-feedback workflows failing with exit code `127`, and a Flink options-TA checkpoint
  restart.

### Jangar Control-Plane Evidence

- `/api/agents/control-plane/status?namespace=agents` generated at `2026-05-14T12:11:21.595Z`.
- Controllers were healthy with fresh heartbeat authority.
- Watch reliability was healthy with `548` total events, `0` errors, and `1` restart.
- Database was connected and healthy with `latency_ms=3`.
- Migration consistency was healthy: `registered_count=29`, `applied_count=29`, `unapplied_count=0`,
  `unexpected_count=0`, latest migration
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Execution trust was degraded by `stages:agents:jangar-control-plane:verify:verify consecutive failures`.
- Route-stability window was stable for serving, but only `serve_readonly` and `torghut_observe` were allowed.
- `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary` were held; live capital
  classes were blocked.
- The deployer summary reported `heartbeat_projection_split` and rollback target
  `hold material dispatch until controller heartbeat authority settles`.

### Torghut Business Evidence

- Jangar `/ready` returned `business_state=repair_only`, `revenue_ready=false`, and top queue item
  `repair_alpha_readiness`.
- The top value gate was `routeable_candidate_count`; required output was `torghut.executable-alpha-receipts.v1`;
  capital rule was `zero_notional_repair_only`; `max_notional=0`.
- Torghut consumer evidence was current at the time of assessment, but accepted routeable candidate count was `0`.
- Torghut `/readyz` returned HTTP `503`, correctly degraded by `live_submission_gate=simple_submit_disabled` and
  `profitability_proof_floor=repair_only`.
- Torghut `/db-check` returned HTTP `200`, `ok=true`, `schema_current=true`, current and expected Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, and
  `schema_graph_lineage_ready=true`.
- The schema witness still reported historical parent-fork warnings, so DB head alone is not a sufficient launch
  authority.
- The alpha-readiness settlement conveyor reported `status=no_delta`, selected lane `H-MICRO-01`,
  `repeat_launch_decision=deny`, measured routeable candidate delta `0`, and validation command
  `uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py`.
- The alpha repair dividend ledger reported `status=no_delta`, `launch_decision=deny`,
  `launch_decision_reason=no_delta_release_key_active`, and denied `paper_canary`, `live_micro_canary`, and
  `live_scale`.

### Source And Test Surface

- Jangar's high-risk integration file is `services/jangar/src/server/control-plane-status-types.ts` at `2974` lines.
- Jangar control-plane reducers in scope include `control-plane-status.ts` (`766` lines),
  `control-plane-route-stability-escrow.ts` (`490` lines), and `control-plane-material-action-verdict.ts`
  (`680` lines).
- There are `40` Jangar server tests matching `*control-plane*test.ts`, including ready truth, material gate digest,
  material reentry, material action verdict, source rollout truth, and authority provenance.
- Torghut's high-risk producer file is `services/torghut/app/main.py` at `6990` lines.
- Torghut revenue and alpha producer files in scope include `revenue_repair.py` (`1161` lines),
  `alpha_readiness_settlement_conveyor.py` (`848` lines), `alpha_evidence_foundry.py` (`608` lines), and
  `alpha_repair_dividend_ledger.py` (`637` lines).
- Torghut already has focused tests for revenue repair, repair bid settlement, repair outcome dividend,
  executable alpha receipts, alpha readiness settlement conveyor, alpha evidence foundry, alpha repair closure, route
  reacquisition, routeability repair acceptance, and consumer evidence.
- The remaining gap is the cross-plane foreclosure contract: verify-trust debt must be bound to a Torghut no-delta
  release key and a specific reentry receipt before Jangar spends another material launch.

## Problem

Jangar currently exposes the relevant facts, but it does not reduce them into one admission object that prevents the
wrong next launch.

The concrete failure modes are:

1. `/ready` can be serving `ok` while verify-stage trust is degraded.
2. Source-rollout truth can be split while Kubernetes deployments are available.
3. Torghut can report a fresh alpha settlement, but the settlement can be no-delta with an active release key.
4. Workers can keep launching broad implement or verify runs that do not retire the active debt class.
5. Deployer handoff can cite service health without proving source SHA, image digest, workload readiness, and Torghut
   business state in one place.
6. Direct database inspection is correctly unavailable to the worker identity, so admission has to rely on application
   DB witnesses rather than ad hoc psql.

The control plane needs a foreclosure board that turns failure debt into either a closed receipt or a denied launch.

## Alternatives Considered

### Option A: Keep Retrying Verify Until It Turns Green

This option leaves current schedules and status surfaces alone. Verify-stage debt is treated as an operational retry
problem.

Advantages:

- No new reducer.
- It may clear transient flakes without code changes.
- It preserves existing stage behavior.

Disadvantages:

- It already failed the live evidence test: verify has consecutive failures.
- It does not suppress repeated no-delta repair attempts.
- It spends runner capacity without naming the debt class being retired.
- It does not shorten PR-to-rollout latency because deployer proof remains scattered.

Decision: reject.

### Option B: Freeze All Material Work Until Verify Is Healthy

This option blocks every material action whenever execution trust is degraded.

Advantages:

- Strong reliability posture.
- Easy to reason about under incident conditions.
- Prevents risky capital or merge widening.

Disadvantages:

- It blocks the zero-notional evidence repair that may be required to make verify green.
- It conflates safe observe-only Torghut evidence with material dispatch.
- It still does not explain which verify failure must be retired.
- It increases manual intervention when the right action is a bounded proof repair.

Decision: keep as an emergency brake, reject as the normal architecture.

### Option C: Verify-Trust Foreclosure Board With Alpha-Repair Reentry Admission

This option emits a foreclosure board that joins verify trust, source-rollout truth, route-stability escrow, Torghut
consumer evidence, Torghut no-delta release keys, and deployer proof into one compact decision.

Advantages:

- Targets the current failure mode directly.
- Reduces duplicate AgentRuns by denying unchanged no-delta launches.
- Preserves serve-readonly and Torghut observe paths while holding material action.
- Gives deployers one packet for source, image, workload, service, and business evidence.
- Keeps least-privilege database boundaries intact.

Disadvantages:

- Adds one Jangar reducer and tests.
- Requires Torghut to expose stable no-delta release-key and reentry-auction fields.
- Can delay useful repairs until the release condition changes or the verify-debt ticket is current.

Decision: select Option C.

## Architecture

Jangar emits two additive, shadow-first payloads:

```text
jangar.verify-trust-foreclosure-board.v1
  board_id
  generated_at
  fresh_until
  namespace
  execution_trust_ref
  execution_trust_status
  source_rollout_truth_ref
  source_rollout_truth_state
  controller_witness_ref
  database_projection_ref
  route_stability_ref
  torghut_consumer_evidence_ref
  torghut_alpha_repair_dividend_ref
  active_no_delta_release_key
  debt_classes[]
  foreclosure_tickets[]
  action_decisions[]
  deployer_packet
  rollback_target

jangar.alpha-repair-reentry-admission.v1
  admission_id
  generated_at
  fresh_until
  selected_value_gate
  selected_hypothesis_id
  release_key_state: clear | active | changed | missing
  material_action_class
  decision: allow | hold | deny
  reason_codes[]
  required_output_receipt
  validation_command
  rollback_target
```

The board is not a replacement for `/ready`. `/ready` remains a serving-health surface. The board is a material-action
surface.

### Debt Classification

Each board build classifies current debt into these stable categories:

- `verify_trust_degraded`: execution trust reports degraded or blocked verify windows.
- `source_rollout_truth_split`: source SHA, desired image, live image, or GitOps revision disagree.
- `controller_witness_stale`: heartbeat authority is stale or split.
- `torghut_no_delta_active`: Torghut reports an active no-delta release key for the selected alpha lane.
- `torghut_business_repair_only`: Torghut remains `revenue_ready=false` or `business_state=repair_only`.
- `capital_gate_hold`: Torghut proof floor, paper canary, or live action classes are held or blocked.

### Admission Rules

Jangar allows `serve_readonly` when serving route health is current.

Jangar allows `torghut_observe` when Torghut consumer evidence or revenue-repair evidence is current, even if material
work is held.

Jangar denies `dispatch_repair` when:

- the selected Torghut alpha lane has `repeat_launch_decision=deny`;
- a no-delta release key is active and no release condition changed;
- `max_notional` is not `0`;
- required output receipt or validation command is missing;
- the launch does not cite the governing Jangar and Torghut design ids.

Jangar holds `dispatch_repair` when:

- execution trust is degraded and no current foreclosure ticket names the debt class;
- source-rollout truth is split and the repair does not target that split;
- controller witness is stale;
- Torghut consumer evidence is unavailable or stale;
- Torghut `/readyz` is degraded for a reason other than the expected capital-safety holds;
- database application witness is missing or schema currentness is unknown.

Jangar allows one bounded `dispatch_repair` only when:

- the repair targets the top Torghut queue item or a named prerequisite to release it;
- the Torghut no-delta release key is clear, changed, or tied to a new release condition;
- the board has a current foreclosure ticket;
- `max_notional=0`;
- the validation command is specific and fast;
- the rollback target preserves zero notional and disables repeated launch for the same release key.

Jangar holds `merge_ready`, `deploy_widen`, and all capital action classes until verify trust is healthy and source
rollout truth converges.

### Foreclosure Tickets

A foreclosure ticket is the smallest unit of accepted debt retirement:

```text
foreclosure_ticket
  ticket_id
  debt_class
  source_ref
  expected_delta
  required_output_receipt
  validation_commands[]
  max_runtime_seconds
  max_parallelism
  ttl_seconds
  dedupe_key
  state: open | closed | denied | expired
```

Tickets do not create work by themselves. They are admission receipts. A worker still needs a production PR, tests, and
CI.

## Implementation Scope

Engineer milestone 1:

- Add `verify_trust_foreclosure_board` and `alpha_repair_reentry_admission` types to the Jangar control-plane data
  model.
- Build the board from existing execution-trust, source-rollout truth, route-stability escrow, database, watch,
  controller witness, Torghut consumer evidence, and revenue-repair settlement custody inputs.
- Expose compact board refs on `/ready` and `/api/agents/control-plane/status`.
- Keep enforcement in observe mode for one deploy.

Implementation update on 2026-05-14:

- Jangar now parses `torghut.no-delta-repair-reentry-auction-ref.v1` from Torghut consumer evidence.
- `verify_trust_foreclosure_board.alpha_repair_reentry_admission` prefers the auction ref over older closure,
  dividend, and conveyor refs when selecting the release key, selected hypothesis, selected value gate, denial reasons,
  validation command, and Torghut evidence ref.
- The behavior remains read-model only; `/ready` serving status and Torghut `max_notional=0` safety semantics are
  unchanged.

Engineer milestone 2:

- Wire the board into material-action verdicts for `dispatch_repair`, `merge_ready`, `deploy_widen`, `paper_canary`,
  `live_micro_canary`, and `live_scale`.
- Deny duplicate no-delta reentry when Torghut reports `launch_decision=deny` for the same release key.
- Add regression tests for serving `ok` with material hold, verify-debt foreclosure, source-rollout split,
  no-delta denial, changed release-key allow, and application DB witness fallback.

Deployer milestone:

- Verify the board in live status before enforcement.
- Promote only after Argo sync, workload readiness, `/ready`, control-plane status, Torghut `/readyz`,
  `/trading/revenue-repair`, and `/trading/consumer-evidence` all report the expected states.

## Validation Gates

Local validation for the Jangar implementation:

- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-ready-truth-arbiter.test.ts`
- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-material-action-verdict.test.ts`
- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-material-reentry-clearinghouse.test.ts`
- `bunx oxfmt --check services/jangar/src/server services/jangar/src/data docs/agents/designs/201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`

Live validation for deployer:

- `curl -fsS http://agents.agents.svc.cluster.local/ready | jq '.execution_trust, .business_state, .top_repair_queue_item'`
- `curl -fsS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents | jq '.verify_trust_foreclosure_board, .route_stability_escrow.route_stability_window'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.alpha_readiness_settlement_conveyor, .alpha_repair_dividend_ledger'`
- `curl -sS -w '\nHTTP_STATUS:%{http_code}\n' http://torghut.torghut.svc.cluster.local/readyz`

Acceptance:

- Serving can be `ok` while material action is held, and the board explains the split.
- Duplicate no-delta repair is denied with the active release key.
- A changed release condition opens at most one bounded zero-notional reentry ticket.
- Merge and deploy widening stay held while verify trust is degraded.
- Handoff names the metric: failed AgentRuns reduced by suppressing duplicate no-delta and verify-debt launches.

## Rollout

Phase 0 is documentation and tests.

Phase 1 emits the board in observe mode on control-plane status and `/ready`.

Phase 2 adds material-action verdict integration but keeps `dispatch_repair` in hold-on-unknown.

Phase 3 enables denial for duplicate no-delta release keys and changed-release-key allow for one bounded dispatch
repair.

Phase 4 makes the board required for `merge_ready` and `deploy_widen` evidence.

## Rollback

Rollback is to stop emitting the foreclosure board and leave existing route-stability escrow, material-action verdicts,
source-rollout truth, and revenue-repair settlement custody as the authorities.

If enforcement causes false holds:

- disable the board as an input to material-action verdicts;
- keep the payload visible in observe mode for debugging;
- preserve Torghut `max_notional=0`;
- keep paper and live classes held until proof-floor contracts recover.

If the board allows a duplicate no-delta launch:

- immediately set the no-delta rule to deny-on-active-key;
- require a human deployer note before re-enabling allow-on-changed-release-condition;
- inspect the Torghut release-key fields and Jangar digest inputs before another launch.

## Risks

- Risk: a stale Torghut no-delta key denies useful work. Mitigation: release conditions are explicit and include source
  ref, evidence window, blocker set, and required receipt set changes.
- Risk: verify trust stays degraded for unrelated flakes. Mitigation: tickets name the debt class and can allow
  observe-only work while holding material action.
- Risk: the board duplicates material-action verdict logic. Mitigation: the board summarizes debt and release keys;
  material-action verdict remains the enforcement point.
- Risk: application DB witnesses hide row-level data issues. Mitigation: DB witnesses are required but not sufficient;
  Torghut must also carry schema-lineage and evidence receipts.

## Handoff

Engineer next action: implement `jangar.verify-trust-foreclosure-board.v1` in observe mode and add tests that prove
verify trust degraded plus active Torghut no-delta denies duplicate `dispatch_repair`.

Deployer next action: after rollout, prove Jangar `/ready`, control-plane status, workload readiness, and Torghut
revenue-repair agree on the board decision before calling the PR-to-rollout path healthy.

The smallest blocker preventing improvement is current and specific: `jangar-control-plane:verify` has consecutive
failures, and Torghut's selected alpha repair has an active no-delta release key with routeable candidate count still
at zero.

## Implementation Update - 2026-05-14

The implementation now emits the additive `verify_trust_foreclosure_board` in observe mode from both the `/ready` hot
path and `/api/agents/control-plane/status`. The board joins execution trust, source-serving truth, controller and
database witnesses when available, route stability, revenue-repair settlement custody, Torghut consumer evidence, and
the compact alpha repair dividend ledger. It exposes `alpha_repair_reentry_admission` so duplicate no-delta alpha
repair launches are denied with the active release key while serve-readonly and Torghut observe paths stay separate.

Jangar now parses Torghut's compact `torghut.alpha-repair-dividend-ledger-ref.v1` from consumer evidence and carries
`ledger_id`, selected hypothesis, selected value gate, routeable candidate delta, no-delta release key,
`launch_decision`, validation command, max notional, capital rule, and rollback target into the control-plane data
model.

The board also binds alpha-repair reentry admission to Torghut's compact `alpha_repair_closure_board` when present.
That keeps foreclosure and `material_gate_digest.alpha_closure_carry` aligned on the selected hypothesis, required
settlement receipt, active dedupe key, consumed no-delta budget, validation command, and rollback target. The fallback
order remains closure board, alpha repair dividend ledger, alpha-readiness settlement conveyor, and executable-alpha
repair receipt.

Local validation for the implementation:

- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-verify-trust-foreclosure.test.ts src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/routes/ready.test.ts`
- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter @proompteng/jangar tsc`
- `bun run --filter @proompteng/jangar lint`
- `bun run --filter @proompteng/jangar lint:oxlint`
- `bunx oxfmt --check` on the touched Jangar files

Live pre-rollout evidence from `http://agents.agents.svc.cluster.local/ready` at `2026-05-14T13:25:30Z` still shows
`business_state=repair_only`, `revenue_ready=false`, top repair `repair_alpha_readiness`, affected value gate
`routeable_candidate_count`, and `execution_trust.status=degraded` for
`jangar-control-plane:plan:plan consecutive failures`. The deployed service does not yet expose
`verify_trust_foreclosure_board`; release must verify that field after this PR rolls out.

Rollback for this implementation is to set `JANGAR_VERIFY_TRUST_FORECLOSURE_MODE=observe` or stop consuming the board
while leaving ready truth, revenue-repair settlement custody, material gate digest, and Torghut max notional `0` as the
active safety authorities.
