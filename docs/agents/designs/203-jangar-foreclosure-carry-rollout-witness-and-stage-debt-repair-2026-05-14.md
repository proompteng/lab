# 203. Jangar Foreclosure-Carry Rollout Witness And Stage-Debt Repair (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane source-to-live foreclosure carry, stage-debt repair admission, Torghut verification
carry, rollout truth, validation, rollback, and cross-swarm handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/209-torghut-verification-carry-import-and-alpha-repair-release-2026-05-14.md`

Extends:

- `202-jangar-verification-carry-export-and-repair-slot-reconciliation-2026-05-14.md`
- `docs/torghut/design-system/v6/208-torghut-jangar-verification-carry-bridge-and-no-delta-reentry-market-2026-05-14.md`
- `201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`
- `200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`
- `199-jangar-material-action-custody-flight-recorder-and-merge-reentry-slo-2026-05-14.md`
- `188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `180-jangar-execution-trust-debt-retirement-and-profit-repair-settlement-2026-05-08.md`

## Decision

I am selecting a **foreclosure-carry rollout witness with stage-debt repair admission** as the next Jangar
control-plane contract.

The current failure is not that the repository lacks the foreclosure-board implementation. Source already contains
`services/jangar/src/server/control-plane-verify-trust-foreclosure.ts`, `/ready` wiring, status wiring, and tests.
The failure is that the live system cannot spend that source fact. On 2026-05-14 at about 16:10Z, the `agents`
deployment was still running image `registry.ide-newton.ts.net/lab/jangar-control-plane:0f963a1d`, while the current
GitOps desired state in `argocd/applications/agents/values.yaml` pointed at `77e207de` and digest
`sha256:0eaafd56bf7292502b142fb9ca0dff9f082a8c497539be62e7145f4411f4b41a`. Argo CD reported the `agents`
application `OutOfSync` but `Healthy`.

That is exactly the kind of split that makes a control plane look healthy while its material-action authority is
missing. Jangar `/ready` returned `status=ok`, controller heartbeats were healthy, database migrations were current,
and watch reliability saw `1327` events with `0` errors and `0` restarts in the last 15 minutes. But
`execution_trust.status=degraded` because `jangar-control-plane:plan` and `jangar-control-plane:verify` had
consecutive failures, and both `/ready` and `/api/agents/control-plane/status` returned
`verify_trust_foreclosure_board=null`.

Torghut has already moved to the next contract. `/trading/revenue-repair` emits
`no_delta_repair_reentry_auction` in observe mode, denies duplicate alpha repair because the active no-delta release
key is unchanged, keeps `max_notional=0`, and reports `jangar_verification_carry_unavailable`. Torghut is waiting for
a Jangar carry that source promises but live Jangar does not yet emit.

The selected design adds a Jangar-owned rollout witness that treats the foreclosure board as usable only when source,
GitOps desired image, live image, `/ready`, control-plane status, and Torghut auction carry all agree. It also adds a
stage-debt repair admission object that can spend one bounded zero-notional repair slot on the specific reason the
carry is unavailable: rollout lag, board emission absence, plan/verify failure debt, or Torghut import mismatch.

The tradeoff is that this contract is stricter than the current source rollout path. A merged source PR and healthy
Kubernetes deployment will no longer be enough to claim stage-debt recovery. I accept that. The business metric is
fewer failed AgentRuns and shorter green PR-to-healthy GitOps rollout time. Counting a source-only foreclosure board
as recovered would hide the exact lag that currently keeps Torghut from accepting Jangar verification carry.

## Governing Runtime Requirements

This contract implements the active swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Value-gate mapping:

- `failed_agentrun_rate`: deny broad retries while the same plan/verify debt and missing live board are still active.
- `pr_to_rollout_latency`: turn source-to-live lag into an explicit witness with target revision, desired image,
  observed image, service fields, and Torghut carry result.
- `ready_status_truth`: keep `/ready.status=ok` as serving truth while refusing to treat serving health as material
  action authority.
- `manual_intervention_count`: replace manual comparison of Git, Argo, live images, status fields, and Torghut auction
  output with one witness packet.
- `handoff_evidence_quality`: every handoff cites witness id, carry state, rollout lag class, validation commands, and
  rollback target.

Torghut value-gate mapping:

- `routeable_candidate_count`: alpha-repair reentry remains denied until Jangar verification carry is current or a
  named zero-notional stage-debt repair ticket is selected.
- `zero_notional_or_stale_evidence_rate`: stale or source-only Jangar carry remains denial evidence.
- `fill_tca_or_slippage_quality`: execution repair can be admitted only if the witness says Jangar carry is current
  enough to let Torghut evaluate the top alpha lane.
- `post_cost_daily_net_pnl`: no live or paper capital follows from this contract.
- `capital_gate_safety`: all stage-debt and alpha-repair work remains `max_notional=0`.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records, GitOps
resources, trading flags, AgentRuns, or market data.

### Cluster And Rollout Evidence

- Kubernetes identity was `system:serviceaccount:agents:agents-sa`.
- `agents`, `agents-controllers`, and `agents-alloy` deployments were available in the `agents` namespace.
- `agents` live image was `registry.ide-newton.ts.net/lab/jangar-control-plane:0f963a1d` with digest
  `sha256:41c2cec100cf819712a64e39b504a965dd34a1519d90b14c23905e259a512e21`.
- `agents-controllers` live image was `registry.ide-newton.ts.net/lab/jangar:0f963a1d` with digest
  `sha256:3e0cc409faa2445769ad05266674ee0c370ef07be8b11d78a295974f20828e11`.
- Current GitOps desired state pointed `agents` at image tag `77e207de`, digest
  `sha256:0eaafd56bf7292502b142fb9ca0dff9f082a8c497539be62e7145f4411f4b41a`, and source SHA
  `77e207ded12c0144af7f1196e7c1676d03aaeef4`.
- Argo CD reported `agents` `OutOfSync` and `Healthy`; `jangar` was `Synced` and `Healthy`; `torghut` was
  `OutOfSync` and `Healthy` while waiting on a migration hook; `symphony-torghut` was `Synced` and `Healthy`.
- Recent agents events showed successful scheduled jobs, but plan pods had `OOMKilled` attempts and verify jobs had
  `BackoffLimitExceeded` failures.
- AgentRun inventory in `agents` contained `127` failed, `699` succeeded, `6` running, `11` pending, and `12`
  template runs.
- Recent Jangar stage inventory included failed `jangar-control-plane-plan-sched-w9w7f` with
  `BackoffLimitExceeded`, failed `jangar-control-plane-verify-sched-jm4rd`, and a currently running verify run.
- The `jangar-control-plane` and `torghut-quant` Swarms were both `Active`, `lights-out`, and `Ready=True`.

### Jangar Control-Plane Evidence

- `/ready` returned `status=ok`, `business_state=repair_only`, `revenue_ready=false`, and top repair
  `repair_alpha_readiness`.
- `/ready.execution_trust.status=degraded` with blocking windows
  `jangar-control-plane:plan:plan consecutive failures` and
  `jangar-control-plane:verify:verify consecutive failures`.
- `/api/agents/control-plane/status?namespace=agents` generated at `2026-05-14T16:10:12.103Z`.
- Controllers were healthy with fresh heartbeat authority.
- Watch reliability was healthy with `1327` events, `0` errors, and `0` restarts in the 15 minute window.
- Database was connected and healthy with `latency_ms=15`.
- Kysely migration consistency was healthy: `registered_count=29`, `applied_count=29`, `unapplied_count=0`,
  `unexpected_count=0`, latest migration
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Route-stability window allowed only `serve_readonly` and `torghut_observe`; it held `dispatch_repair`,
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`; it blocked `live_micro_canary` and
  `live_scale`.
- `verify_trust_foreclosure_board` was `null` on both `/ready` and control-plane status.
- `repair_slot_escrow` was also `null` on `/ready`, even though source head `77e207de` contains the repair slot
  escrow implementation.

### Torghut Business And Data Evidence

- Torghut live revision was `torghut-00397`; sim revision was `torghut-sim-00494`; both pods were running.
- Torghut `/readyz` returned `status=degraded`, with degradation aligned to capital safety rather than service
  unavailability.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, `schema_missing_heads=[]`,
  `schema_unexpected_heads=[]`, `schema_head_delta_count=0`, and `schema_graph_lineage_ready=true`.
- The database witness still reported historical parent-fork warnings under
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `/trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, and
  `alpha_readiness_settlement_conveyor.status=no_delta`.
- The selected lane was `H-MICRO-01`, selected value gate was `routeable_candidate_count`, and accepted routeable
  candidate count remained `0`.
- `alpha_repair_dividend_ledger.status=no_delta`, `jangar_custody.launch_decision=deny`, and
  `launch_decision_reason=no_delta_release_key_active`.
- `no_delta_repair_reentry_auction.reentry_decision=deny`, with reason codes including
  `active_no_delta_release_key`, `no_release_condition_changed`, `zero_notional_reentry_ticket_not_selected`,
  `jangar_verification_carry_unavailable`, and `duplicate_no_delta_reentry_denied`.
- `no_delta_repair_reentry_auction.jangar_verification_carry.status=unavailable` and required
  `jangar.verify-trust-foreclosure-ticket.v1`.

### Source And Test Surface

- Source contains the Jangar foreclosure builder in
  `services/jangar/src/server/control-plane-verify-trust-foreclosure.ts`.
- Source contains `/ready` and status emission wiring in `services/jangar/src/routes/ready.tsx` and
  `services/jangar/src/server/control-plane-status.ts`.
- The implementation landed after the live `0f963a1d` image: source history from `0f963a1d..77e207de` includes
  `13d640a02 feat(jangar): add verify trust foreclosure board`, `b9e2b92d5 fix(jangar): bind foreclosure admission to
closure board`, and `77e207ded feat(jangar): add repair slot escrow`.
- Jangar high-risk integration files remain large: `agents-control-plane.ts` is `3165` lines,
  `control-plane-status.ts` is `798` lines, and `control-plane-material-action-verdict.ts` is `680` lines.
- There are `42` Jangar server tests matching `*control-plane*test.ts`, including foreclosure, ready truth, material
  action verdict, material reentry, source rollout truth, repair slot escrow, and authority provenance.
- Torghut source contains `services/torghut/app/trading/no_delta_repair_reentry_auction.py` and
  `services/torghut/tests/test_no_delta_repair_reentry_auction.py`.
- The missing contract is not another local reducer. It is the live witness that proves the reducer has crossed the
  source-to-serving boundary and that Torghut has consumed the resulting carry.

## Problem

Jangar currently has three separate truths for the same recovery:

1. Source truth says the foreclosure board and repair slot escrow exist.
2. GitOps desired truth says the `77e207de` image should be deployed.
3. Live serving truth says the old `0f963a1d` image is still active and the board fields are absent.

The system lets these truths remain separate. That creates concrete failure modes:

1. `/ready.status=ok` can be mistaken for material-action readiness.
2. Argo `Healthy` can hide `OutOfSync` application state.
3. A current source SHA can be treated as recovered before its fields appear in live status.
4. Torghut can correctly deny duplicate alpha repair but still lack the Jangar verification carry needed to price the
   next release condition.
5. Plan and verify failures can keep accumulating while implement runs continue to spend capacity.
6. Deployer handoff can cite rollout or service health without proving the carry field has appeared and been consumed.

The control plane needs a rollout witness that makes source-to-live carry availability a first-class admission gate.

## Alternatives Considered

### Option A: Wait For Argo To Converge And Recheck `/ready`

This option treats the current split as a transient deployment lag.

Advantages:

- No new contract.
- If Argo catches up quickly, the missing board may appear without more work.
- Avoids more documentation and reducer surface.

Disadvantages:

- It does not explain why `agents` is `OutOfSync` while `Healthy`.
- It does not prevent workers from spending more plan/verify capacity while the carry is missing.
- It does not give Torghut a stable reason to keep `jangar_verification_carry_unavailable`.
- It does not improve handoff evidence quality.

Decision: reject as the architecture. It remains a deployer action inside the selected contract.

### Option B: Treat Source Commit Presence As The Carry

This option lets Torghut or Jangar accept `13d640a02`/`77e207de` source presence as proof that the foreclosure board is
available.

Advantages:

- Easy to compute.
- Unblocks downstream contracts quickly.
- Reduces dependence on live status payload shape.

Disadvantages:

- It failed the live evidence test: source exists and live status still returns `null`.
- It would make the business surface less truthful.
- It can open alpha-repair reentry before the deployed service can explain material action decisions.
- It weakens rollback because source cannot say which live image is answering traffic.

Decision: reject.

### Option C: Foreclosure-Carry Rollout Witness With Stage-Debt Repair Admission

This option creates a Jangar witness that joins source commit, GitOps desired image, live image, Argo state, workload
readiness, `/ready` field presence, control-plane status field presence, execution-trust debt, and Torghut auction
carry. It then admits only one bounded repair ticket for the current missing link.

Advantages:

- Directly targets the current failure.
- Separates serving health from material-action authority.
- Gives Torghut a compact carry state that is either current, lagging, stale, unavailable, or denied.
- Converts source-to-live lag into a measurable PR-to-rollout latency component.
- Reduces duplicate plan/verify AgentRuns by requiring debt-specific repair tickets.

Disadvantages:

- Adds one more status payload.
- Requires deployer discipline: green CI is not enough until live carry appears.
- Can hold otherwise safe repairs while the witness is missing.

Decision: select Option C.

## Architecture

Jangar emits two additive payloads in observe mode first:

```text
jangar.foreclosure-carry-rollout-witness.v1
  witness_id
  generated_at
  fresh_until
  source_head_sha
  gitops_revision
  desired_agents_image
  desired_agents_digest
  observed_agents_image
  observed_agents_digest
  argo_app_status
  workload_readiness
  ready_field_presence
  control_plane_status_field_presence
  execution_trust_status
  execution_trust_blocking_windows[]
  torghut_auction_ref
  torghut_jangar_verification_carry_state
  carry_state: current | rollout_lagging | field_absent | stale | unavailable | denied
  reason_codes[]
  validation_commands[]
  rollback_target

jangar.stage-debt-repair-admission.v1
  admission_id
  generated_at
  fresh_until
  selected_debt_class:
    rollout_lag | board_field_absent | plan_failure_debt | verify_failure_debt | torghut_carry_import_mismatch
  action_class
  decision: allow | hold | deny
  required_output_receipt
  max_parallelism
  max_runtime_seconds
  max_notional: "0"
  reason_codes[]
  validation_commands[]
  rollback_target
```

The witness is not a replacement for `/ready`. `/ready` remains a serving surface. The witness is an authority surface
for material action, rollout widening, and Torghut carry import.

### Carry States

- `current`: desired source/image, observed image, `/ready` board, control-plane status board, and Torghut carry all
  agree within freshness windows.
- `rollout_lagging`: GitOps desired source/image is ahead of the observed workload image.
- `field_absent`: observed image should contain the field, but `/ready` or status does not emit it.
- `stale`: fields exist but are older than their freshness windows.
- `unavailable`: Torghut reports missing Jangar carry or Jangar cannot compute the witness.
- `denied`: carry exists but material action is denied by active debt or no-delta duplicate suppression.

### Admission Rules

Jangar allows `serve_readonly` when `/ready.status=ok` and route-stability allows it.

Jangar allows `torghut_observe` when Torghut evidence is current, even if material action is held.

Jangar holds `dispatch_repair`, `merge_ready`, and `deploy_widen` when:

- `carry_state` is `rollout_lagging`, `field_absent`, `stale`, or `unavailable`;
- Argo is `OutOfSync` for the serving app that owns the carry field;
- execution trust has plan or verify consecutive failures and no current repair admission;
- Torghut auction carry is unavailable or stale;
- required output receipt is missing.

Jangar denies duplicate repair when:

- the selected debt class is unchanged from the previous admission;
- the previous repair produced no carry-state delta;
- Torghut active no-delta release key is unchanged;
- the run does not cite the governing Jangar and Torghut design refs.

Jangar allows one bounded repair only when:

- the selected debt class is exactly one of the active missing links;
- the repair has one required output receipt and one fast validation command;
- `max_parallelism=1`;
- `max_notional=0`;
- rollback preserves existing material-action holds.

### Stage-Debt Classes

- `rollout_lag`: desired source/image is ahead of the observed workload image.
- `board_field_absent`: live service is on an eligible image but does not emit the required board fields.
- `plan_failure_debt`: plan stage has consecutive failures, OOMKilled attempts, or BackoffLimitExceeded debt.
- `verify_failure_debt`: verify stage has consecutive failures or BackoffLimitExceeded debt.
- `torghut_carry_import_mismatch`: Jangar emits a current board but Torghut still reports verification carry
  unavailable or stale.

## Implementation Scope

Engineer milestone 1:

- Add `foreclosure_carry_rollout_witness` and `stage_debt_repair_admission` to the Jangar status model.
- Build the witness from existing source-serving proof, source rollout truth, workload image evidence,
  route-stability escrow, execution trust, `verify_trust_foreclosure_board`, `repair_slot_escrow`, and Torghut
  `no_delta_repair_reentry_auction` fields.
- Expose compact witness refs on `/ready` and `/api/agents/control-plane/status`.
- Keep enforcement in observe mode for one deploy.

Engineer milestone 2:

- Wire witness state into material-action verdicts for `dispatch_repair`, `merge_ready`, and `deploy_widen`.
- Add debt-specific dedupe keys so repeated plan/verify repairs are denied when the carry-state delta is unchanged.
- Add tests for source ahead of live image, field absent, Torghut carry unavailable, carry current, and duplicate
  no-delta suppression.

Deployer milestone:

- Promote the current Jangar image and prove `agents` is `Synced` and `Healthy`.
- Prove live `/ready.verify_trust_foreclosure_board` and status `.verify_trust_foreclosure_board` are non-null.
- Prove Torghut auction moves from `jangar_verification_carry_unavailable` to a current, stale, or denied carry state
  that cites the Jangar board.

## Validation Gates

Local validation for the Jangar implementation:

- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-verify-trust-foreclosure.test.ts`
- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-repair-slot-escrow.test.ts`
- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-material-action-verdict.test.ts`
- `bunx vitest run --config vitest.config.ts src/routes/ready.test.ts`
- `bun run --filter @proompteng/jangar tsc`
- `bun run --filter @proompteng/jangar lint`
- `bun run --filter @proompteng/jangar lint:oxlint`

Live validation for deployer:

- `kubectl -n argocd get applications.argoproj.io agents -o json | jq '{sync: .status.sync.status, health: .status.health.status, revision: .status.sync.revision}'`
- `kubectl -n agents get deploy agents -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'`
- `curl -fsS http://agents.agents.svc.cluster.local/ready | jq '.verify_trust_foreclosure_board, .foreclosure_carry_rollout_witness, .stage_debt_repair_admission'`
- `curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.verify_trust_foreclosure_board, .foreclosure_carry_rollout_witness'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.no_delta_repair_reentry_auction.jangar_verification_carry'`

Acceptance:

- Source and GitOps desired image cannot count as carry-current until live `/ready` and status emit the board.
- `agents` `OutOfSync` forces `carry_state=rollout_lagging` or a more specific hold.
- Torghut `jangar_verification_carry_unavailable` blocks alpha-repair reentry unless a Jangar stage-debt repair ticket
  is selected.
- Duplicate plan/verify repair launches are denied when the selected debt class and carry-state delta are unchanged.
- Material `merge_ready`, `deploy_widen`, `paper_canary`, `live_micro_canary`, and `live_scale` remain held or blocked
  while carry is unavailable.

## Rollout

Phase 0 is documentation and test fixtures.

Phase 1 emits the witness in observe mode on `/ready` and control-plane status.

Phase 2 makes deployer handoff require non-null witness fields before claiming PR-to-rollout recovery.

Phase 3 feeds `carry_state` into material-action verdicts while keeping hold-on-unknown behavior.

Phase 4 allows one bounded stage-debt repair ticket for the exact active missing link.

Phase 5 makes `carry_state=current` required for `merge_ready` and `deploy_widen`.

## Rollback

Rollback is to stop consuming `foreclosure_carry_rollout_witness` in material-action verdicts and keep existing
route-stability escrow, execution trust, verify-trust foreclosure board, repair slot escrow, and Torghut no-delta
auction as separate observe-mode authorities.

If the witness falsely holds rollout:

- keep the witness visible;
- remove it from material-action verdicts;
- require the deployer to cite live `/ready` and status fields manually;
- keep Torghut `max_notional=0`.

If the witness falsely allows carry-current:

- force `carry_state=denied` unless both `/ready` and status emit a fresh board;
- deny `dispatch_repair`, `merge_ready`, and `deploy_widen`;
- inspect source SHA, desired image, live image, and Torghut carry import before reopening.

## Risks

- Risk: Argo `OutOfSync` is transient and creates noisy holds. Mitigation: the witness has a freshness window and
  records both desired and observed image facts.
- Risk: status payload grows too large. Mitigation: expose compact refs on `/ready` and full detail only on
  control-plane status.
- Risk: plan and verify failures are caused by resource limits rather than source defects. Mitigation: stage-debt
  repair tickets classify OOMKilled and BackoffLimitExceeded separately and require one bounded output receipt.
- Risk: Torghut treats stale carry as capital permission. Mitigation: Torghut companion contract keeps every carry
  state zero-notional and keeps no-delta duplicate suppression authoritative.

## Handoff

Engineer next action: implement `jangar.foreclosure-carry-rollout-witness.v1` in observe mode and add tests proving
that source ahead of live image plus missing board fields produces `carry_state=rollout_lagging` or `field_absent`,
not material readiness.

Deployer next action: after promotion, prove `agents` is `Synced` and `Healthy`, live image matches desired
`77e207de`, `/ready.verify_trust_foreclosure_board` is non-null, status emits the board, and Torghut no-delta auction
imports a Jangar carry state.

The smallest current blocker is specific: Jangar source contains the foreclosure board and repair slot escrow, but the
live `agents` image is still `0f963a1d`; Torghut therefore reports `jangar_verification_carry_unavailable` while
`routeable_candidate_count` remains `0`.
