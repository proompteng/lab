# 205. Jangar Controller-Ingestion Settlement And Verification-Carry Cutover (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar controller-ingestion settlement, verification-carry cutover, stage-clearance repair admission, Torghut
no-delta release conditions, validation, rollout, rollback, and cross-swarm handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md`

Extends:

- `204-jangar-source-bound-verification-carry-exchange-and-repair-slot-reconciliation-2026-05-14.md`
- `../torghut/design-system/v6/210-torghut-source-bound-verification-carry-import-and-no-delta-release-2026-05-14.md`
- `203-jangar-foreclosure-carry-rollout-witness-and-stage-debt-repair-2026-05-14.md`
- `202-jangar-verification-carry-export-and-repair-slot-reconciliation-2026-05-14.md`
- `201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`
- `200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`
- `188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`

## Decision

I am selecting a **controller-ingestion settlement with verification-carry cutover** as the next Jangar
control-plane architecture increment.

The live system is serving, but it is not materially coherent. On 2026-05-14 at 16:42-16:43Z, `agents`,
`agents-controllers`, and `jangar` deployments were ready. Argo reported `jangar` and `torghut` as `Synced/Healthy`.
The `agents` application was `OutOfSync/Healthy`, and `/ready` returned `status=ok`. That is serving truth.

Material authority told a different story. `/api/agents/control-plane/status?namespace=agents` reported healthy
database connectivity and migration consistency, but `execution_trust.status=degraded`, `stage_clearance` held normal
dispatch and merge actions, `verify_trust_foreclosure_board=null`, `repair_slot_escrow=null`, and controller witness
decision `repair_only` because the controller deployment and watch epoch were current while the AgentRun ingestion
self-report was not current. The same window showed Jangar/Torghut swarm pods with real failure debt: Jangar verify had
12 error terminations since midnight, Jangar plan had 3 OOMKilled attempts, Torghut plan had 7 errors and 1 OOMKilled,
and Torghut verify had 8 errors and 1 OOMKilled.

Torghut is now blocked on the same boundary. `/trading/revenue-repair` returned `business_state=repair_only`, top
queue `repair_alpha_readiness`, value gate `routeable_candidate_count`, selected lane `H-MICRO-01`, measured
routeable-candidate delta `0`, and a no-delta reentry auction with `jangar_verification_carry_unavailable`. Torghut is
correctly denying duplicate alpha repair, but it cannot distinguish "Jangar source has carry code" from "the live
Jangar control plane can prove carry and ingestion."

The selected design adds one explicit settlement object: `jangar.controller-ingestion-settlement.v1`. It joins the
controller-process witness, Kubernetes deployment witness, watch-epoch witness, AgentRun ingestion witness, execution
trust, source-to-live carry field presence, and Torghut verification-carry import state. It then produces a compact
decision for stage clearance:

- `allow` only when controller ingestion, watch, deployment, database, and verification carry agree;
- `repair_only` when one bounded repair can plausibly make the missing witness current;
- `hold` when the system is serving but broad work would spend capacity on stale or missing authority;
- `block` when the evidence is contradictory or unsafe for capital-adjacent actions.

The tradeoff is intentional. Some repair work will stay held even while pods are ready and the UI is usable. I accept
that because the business metric is fewer failed AgentRuns and faster green PR-to-healthy GitOps rollout. Another broad
repair run does not help when the next missing proof is a controller ingestion witness and a live verification-carry
field.

## Governing Runtime Requirements

This contract implements the active swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Value-gate mapping:

- `failed_agentrun_rate`: do not create another normal dispatch, verify, or no-delta alpha repair run while the
  controller ingestion witness is missing and the same release key is still active.
- `pr_to_rollout_latency`: make source-to-live carry lag explicit with source SHA, desired image, live image, field
  presence, Argo state, and Torghut import result.
- `ready_status_truth`: keep `/ready.status=ok` as serving truth while material actions use the settlement decision.
- `manual_intervention_count`: replace manual comparison of controller logs, status payloads, Argo, and Torghut
  no-delta output with one settlement packet.
- `handoff_evidence_quality`: require engineer and deployer handoffs to cite settlement id, decision, reason codes,
  validation commands, and rollback target.

Torghut value-gate mapping:

- `routeable_candidate_count`: H-MICRO-01 alpha repair remains denied until a Jangar verification-carry release
  condition changes or a bounded Jangar carry repair ticket is selected.
- `zero_notional_or_stale_evidence_rate`: stale or unavailable Jangar carry remains no-delta denial evidence.
- `fill_tca_or_slippage_quality`: TCA work cannot overtake the top alpha-readiness queue unless its release condition
  is the selected ticket.
- `post_cost_daily_net_pnl`: no paper or live capital follows from this cutover.
- `capital_gate_safety`: all work remains `max_notional=0`.

## Current Evidence

All evidence below was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records,
GitOps resources, AgentRuns, trading flags, broker state, or market data.

### Cluster, Rollout, And Events

- `agents` deployment was `1/1`, `agents-controllers` was `2/2`, and `jangar` was `1/1`.
- `agents` ran image `registry.ide-newton.ts.net/lab/jangar-control-plane:0f963a1d` with digest
  `sha256:41c2cec100cf819712a64e39b504a965dd34a1519d90b14c23905e259a512e21`.
- `agents-controllers` ran image `registry.ide-newton.ts.net/lab/jangar:0f963a1d` with digest
  `sha256:3e0cc409faa2445769ad05266674ee0c370ef07be8b11d78a295974f20828e11`.
- Argo reported `agents=OutOfSync/Healthy`, `jangar=Synced/Healthy`, and `torghut=Synced/Healthy` at revision
  `7f5a659ded3eeac1538ec4cbd90605112ce38910`.
- Since midnight UTC, Jangar/Torghut swarm pods included:
  - `jangar-control-plane-plan`: 10 pods, 6 completed, 3 OOMKilled, 1 running;
  - `jangar-control-plane-verify`: 22 pods, 10 completed, 12 error;
  - `torghut-quant-plan`: 15 pods, 6 completed, 7 error, 1 OOMKilled, 1 running;
  - `torghut-quant-verify`: 22 pods, 13 completed, 8 error, 1 OOMKilled.
- The current worker identity can list deployments, pods, AgentRuns, and Argo applications, but CNPG cluster reads and
  direct Postgres exec are blocked by RBAC. That is acceptable and should remain true for normal swarm workers.

### Jangar Control-Plane Evidence

- `/ready` returned `status=ok`, leader election active, `business_state=repair_only`, `revenue_ready=false`, and
  top repair `repair_alpha_readiness`.
- `/ready.execution_trust.status=degraded` because verify was stale or recently failing.
- `/api/agents/control-plane/status?namespace=agents` returned database `healthy`, latency `227ms`, migration
  consistency `registered_count=29`, `applied_count=29`, `unapplied_count=0`, `unexpected_count=0`, latest migration
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Status stage clearance allowed `serve_readonly`, allowed `torghut_observe`, made `repair` `repair_only`, and held
  discover, plan, implement, verify, deploy, and merge-ready actions.
- Controller witness decision was `repair_only` with `controller_witness_split`; deployment and watch epoch witnesses
  were current, but the AgentRun ingestion witness reported `controller_ingestion_unknown`.
- `verify_trust_foreclosure_board` and `repair_slot_escrow` were null on status and `/ready`.
- Material gate digest denied `dispatch_repair` because alpha closure no-delta budget was consumed and debt was active.

### Torghut Business And Data Evidence

- `/trading/revenue-repair` returned `business_state=repair_only` with top repair `repair_alpha_readiness`,
  reason `hypothesis_not_promotion_eligible`, required receipt `torghut.executable-alpha-receipts.v1`,
  value gate `routeable_candidate_count`, and `max_notional=0`.
- The selected alpha-readiness settlement lane was `H-MICRO-01`, strategy
  `microbar_volume_continuation_long_top2_chip_v1@paper`, lane `microstructure-breakout`, and measured
  routeable-candidate delta `0`.
- `no_delta_repair_reentry_auction.reentry_decision=deny` with reason codes:
  `active_no_delta_release_key`, `no_release_condition_changed`,
  `zero_notional_reentry_ticket_not_selected`, `jangar_verification_carry_unavailable`, and
  `duplicate_no_delta_reentry_denied`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, and
  `schema_graph_lineage_ready=true`. It still reported known historical parent-fork warnings, so Jangar should trust
  application-level lineage receipts rather than infer route readiness from the head alone.

### Source And Test Surface

- Jangar has 65 top-level `control-plane-*.ts` server modules and 35 matching control-plane test files.
- High-risk integration points are:
  - `services/jangar/src/server/control-plane-status.ts`, which assembles the status truth surface;
  - `services/jangar/src/routes/ready.tsx`, which serves a hot-path subset;
  - `services/jangar/src/server/control-plane-controller-witness.ts`, which produces the split witness;
  - `services/jangar/src/server/control-plane-verify-trust-foreclosure.ts`, whose source exists but live payload is
    absent;
  - `services/jangar/src/server/control-plane-stage-clearance.ts`, which holds or admits stages.
- Existing tests cover controller witness, stage clearance, ready truth, revenue repair custody, material gate digest,
  verify trust foreclosure, and status assembly. The missing test family is cross-surface controller-ingestion
  settlement: current ingestion allow, missing ingestion repair-only, source-live carry missing hold, Torghut import
  unavailable hold, and contradiction block.

## Problem

Jangar currently has separate claims for serving health, controller deployment health, watch health, AgentRun ingestion,
verification-carry source code, stage clearance, and Torghut no-delta release state. The system does not yet settle
them into one admission object.

The concrete failure modes are:

1. `/ready.status=ok` can be read as material readiness even when stage clearance holds normal work.
2. Argo `Healthy` can hide `OutOfSync` source-to-live lag for the agents control plane.
3. A controller deployment and watch epoch can be current while the AgentRun ingestion self-report is unknown.
4. Source can contain verification-carry logic while live status still returns null fields.
5. Torghut can deny duplicate alpha repair but cannot price whether Jangar carry is unavailable, stale, lagging, or
   repaired.
6. Plan and verify failures can accumulate while broad implement or repair runs keep launching against the same
   unresolved authority split.

The control plane needs an additive settlement object that turns these claims into one bounded action decision.

## Alternatives Considered

### Option A: Wait For Argo Convergence And Keep Existing Gates

This option treats the current split as transient. Engineers and deployers keep checking Argo, `/ready`, and Torghut
manually until the carry fields appear.

Advantages:

- No new reducer.
- Lowest immediate implementation effort.
- Avoids changing schedule admission behavior.

Disadvantages:

- It does not reduce failed AgentRuns while waiting.
- It leaves humans to compare Argo, images, status payloads, and Torghut release conditions.
- It gives Torghut no structured release condition beyond `jangar_verification_carry_unavailable`.
- It repeats the same failure class documented in design 203.

Decision: reject as architecture. Convergence remains a deployer action, but it is not a control-plane contract.

### Option B: Hard Freeze Normal And Repair Dispatch Until All Witnesses Are Current

This option blocks all material work whenever controller ingestion, execution trust, source rollout, or Torghut no-delta
state is degraded.

Advantages:

- Strong failure-rate reduction.
- Easy operator rule.
- Prevents stale retries.

Disadvantages:

- Blocks the bounded zero-notional work needed to repair the missing witness.
- Turns every witness gap into manual intervention.
- Does not distinguish safe `serve_readonly` and `torghut_observe` from capital actions.
- Cannot clear `jangar_verification_carry_unavailable` without a named repair lane.

Decision: reject as steady state. Keep it as an emergency brake for contradictory or unsafe evidence.

### Option C: Controller-Ingestion Settlement With Verification-Carry Cutover

This selected option emits a settlement object that names the missing witness and allows one bounded repair ticket when
the repair can directly close the gap. Everything else stays held or blocked.

Advantages:

- Targets the actual live split.
- Preserves serving availability while hardening material action authority.
- Gives Torghut a stable Jangar carry state and release condition.
- Reduces manual synthesis in deployer handoffs.
- Converts PR-to-rollout lag and controller ingestion debt into measurable evidence.

Disadvantages:

- Adds one reducer and one companion Torghut import contract.
- Requires careful test coverage to avoid false holds.
- Can initially hold useful repairs until the settlement object is emitted.

Decision: select Option C.

## Architecture

Jangar emits `controller_ingestion_settlement` from control-plane status and, once proven cheap enough, from `/ready`.
The object is additive and observe-mode first.

Proposed schema:

```yaml
schema_version: jangar.controller-ingestion-settlement.v1
settlement_id: controller-ingestion-settlement:<namespace>:<digest>
mode: observe|shadow|enforce
generated_at: <iso8601>
fresh_until: <iso8601>
namespace: agents
decision: allow|repair_only|hold|block
serving_readiness: ok|degraded|unknown
controller_witness_ref: <controller-witness id>
controller_witness_decision: allow|repair_only|hold_material|block
deployment_available: true|false
watch_epoch_current: true|false
controller_self_report_current: true|false
agentrun_ingestion_current: true|false
execution_trust_status: healthy|degraded|unknown|blocked
verify_trust_foreclosure_board_ref: <id|null>
repair_slot_escrow_ref: <id|null>
torghut_verification_carry_status: current|lagging|unavailable|stale|unknown
selected_repair_ticket:
  ticket_class: controller_ingestion|verification_carry_rollout|none
  max_parallelism: 1
  max_notional: '0'
  validation_commands: []
reason_codes: []
evidence_refs: []
rollback_target: <string>
```

Decision rules:

1. `allow`: deployment, watch epoch, controller self-report, AgentRun ingestion, database, and execution trust are
   current; verification-carry fields are present; Torghut import is current or not required.
2. `repair_only`: one witness is missing or stale, the repair ticket targets that witness, and no contradictory
   evidence exists.
3. `hold`: serving is healthy but broad dispatch would not repair the missing witness, or source-to-live carry is
   absent.
4. `block`: evidence is contradictory, stale beyond the repair window, or would affect paper/live capital.

Stage-clearance consumption:

- `serve_readonly`: allowed when serving readiness and database read health are acceptable.
- `torghut_observe`: allowed when Torghut evidence routes are reachable and max notional is zero.
- `dispatch_repair`: repair-only only for the selected settlement ticket; denied for duplicate no-delta alpha repair.
- `dispatch_normal`, `deploy_widen`, and `merge_ready`: held until settlement is `allow`.
- `paper_canary`, `live_micro_canary`, and `live_scale`: held or blocked until Torghut proof floor and capital safety
  are explicit.

Torghut consumption:

- Torghut imports `controller_ingestion_settlement` as part of `jangar_verification_carry`.
- `jangar_verification_carry_unavailable` remains a no-delta denial until the settlement is `allow` or a selected
  Jangar carry repair ticket is current.
- Torghut must not treat a source SHA, Argo health, or serving `/ready` alone as enough to release no-delta debt.

## Implementation Scope

Milestone 1: Jangar settlement read model.

- Add `control-plane-controller-ingestion-settlement.ts`.
- Wire it into `control-plane-status.ts` in observe mode.
- Add focused tests for allow, repair-only, hold, block, and Torghut carry unavailable.
- Value gates: `ready_status_truth`, `handoff_evidence_quality`, `manual_intervention_count`.

Milestone 2: stage-clearance consumption.

- Feed the settlement into `control-plane-stage-clearance.ts` behind a config flag.
- Stamp settlement refs into supporting schedule-runner handoff parameters.
- Add tests proving broad dispatch is held while the selected repair ticket is allowed.
- Value gates: `failed_agentrun_rate`, `manual_intervention_count`.

Milestone 3: Torghut carry import.

- Extend Torghut no-delta reentry import to classify Jangar carry as `current`, `lagging`, `unavailable`, or `stale`.
- Require the Jangar settlement receipt before selecting any `jangar_verify_carry` release ticket.
- Keep all selected tickets zero-notional.
- Value gates: `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`, `capital_gate_safety`.

Milestone 4: deployer proof and cutover.

- Deployer must prove PR, source SHA, desired image, live image, Argo state, workload readiness, `/ready`, status,
  controller settlement, Torghut revenue-repair, and Torghut carry import before marking the lane healthy.
- Value gates: `pr_to_rollout_latency`, `handoff_evidence_quality`, `ready_status_truth`.

## Validation Gates

Local engineer validation:

- `bun run --filter jangar test -- src/server/__tests__/control-plane-controller-ingestion-settlement.test.ts`
- `bun run --filter jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter jangar test -- src/server/__tests__/control-plane-stage-clearance.test.ts`
- `bun run --filter jangar lint`
- `bun run --filter jangar lint:oxlint`

Torghut validation:

- `cd services/torghut && uv run --frozen pytest tests/test_no_delta_repair_reentry_auction.py`
- `cd services/torghut && uv run --frozen pytest tests/test_alpha_readiness_settlement_conveyor.py`
- `cd services/torghut && uv run --frozen ruff check app/trading tests`
- `cd services/torghut && uv run --frozen ruff format --check app/trading tests`

Runtime validation:

- `curl -fsS http://agents.agents.svc.cluster.local/ready`
- `curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair`
- `curl -fsS http://torghut.torghut.svc.cluster.local/db-check`
- `kubectl get applications.argoproj.io -n argocd agents jangar torghut`
- `kubectl get deployments -n agents`
- `kubectl get deployments -n jangar`

Acceptance gates:

- `controller_ingestion_settlement` is present, fresh, and cites this design.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` stay held while ingestion or verification carry is missing.
- Exactly one bounded repair ticket may be selected for the missing witness; duplicate no-delta alpha repair is denied.
- Torghut keeps `max_notional=0`.
- Torghut no-delta release reasons distinguish Jangar carry unavailable from alpha evidence no-delta.
- Handoff names the metric improved or the smallest remaining blocker.

## Rollout

Phase 0 is documentation and handoff only. This PR makes the contract durable.

Phase 1 ships the settlement in observe mode and records it in status. No stage behavior changes.

Phase 2 turns on shadow consumption in stage clearance. Handoffs must cite the settlement decision, but launches are
not yet suppressed by it.

Phase 3 allows one selected repair ticket and holds broad dispatch when the settlement is not `allow`.

Phase 4 lets Torghut import the settlement as a release condition for no-delta alpha repair.

Phase 5 promotes enforcement only after two consecutive verify windows show no regression in failed AgentRun rate and
deployer proof shows source-to-live carry current.

## Rollback

Rollback is consumer-side and feature-flagged:

- disable settlement emission from status;
- disable stage-clearance consumption and return to existing controller witness, stage credit, and material gate
  digest behavior;
- keep Torghut no-delta denial active and `max_notional=0`;
- keep `/ready` serving-safe and use full control-plane status for material action decisions.

No database migration is required for the first implementation milestone. If a later PR persists settlement history,
it must include a migration consistency test and a status downgrade when persistence is unavailable.

## Risks

- False holds can reduce useful repair throughput. Mitigation: observe then shadow before enforcement, and select one
  bounded repair ticket only when the missing witness is named.
- False allows can increase failed AgentRuns. Mitigation: require current deployment, watch epoch, ingestion,
  execution trust, and Torghut import before `allow`.
- `/ready` can get too large or expensive. Mitigation: status first; `/ready` carries a compact ref only after cost is
  measured.
- Torghut can overfit to Jangar carry. Mitigation: Jangar carry is a release condition, not a capital release.

## Handoff To Engineer

Build the Jangar settlement reducer first. Do not start with scheduler enforcement. The first production PR should add
the typed reducer, status wiring, and focused tests. The reducer must cite this design and must not require direct CNPG
access from worker identities.

Required changed files are expected under:

- `services/jangar/src/server/control-plane-controller-ingestion-settlement.ts`
- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/control-plane-status-types.ts`
- `services/jangar/src/server/__tests__/control-plane-controller-ingestion-settlement.test.ts`
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`

The first implementation is accepted only if it proves:

- missing AgentRun ingestion self-report yields `repair_only` or `hold`, not `allow`;
- current deployment plus current watch epoch alone is insufficient;
- missing verification-carry field keeps normal material actions held;
- one selected repair ticket carries `max_parallelism=1` and `max_notional=0`;
- existing ready truth and material gate digest behavior remain compatible.

## Handoff To Deployer

Do not declare the lane healthy from Argo or deployment readiness alone. The deployer gate is:

1. PR merged with green checks.
2. Image promotion merged.
3. Argo `agents`, `jangar`, and `torghut` are `Synced/Healthy`.
4. Workloads are ready.
5. `/ready` returns serving `ok`.
6. Full status includes fresh `controller_ingestion_settlement`.
7. `verify_trust_foreclosure_board` and `repair_slot_escrow` presence or absence matches the expected source version.
8. Torghut `/trading/revenue-repair` imports Jangar verification carry without opening paper or live capital.
9. The final handoff names whether `failed_agentrun_rate`, `pr_to_rollout_latency`, or `ready_status_truth` improved,
   or names the smallest remaining blocker.
