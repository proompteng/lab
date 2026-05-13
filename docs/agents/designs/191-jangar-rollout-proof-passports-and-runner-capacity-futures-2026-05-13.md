# 191. Jangar Rollout Proof Passports And Runner Capacity Futures (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane rollout truth, AgentRun launch reliability, runner capacity settlement, merge-ready
evidence, Torghut repair dispatch custody, validation, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/196-torghut-profit-carry-passports-and-repair-capacity-futures-2026-05-13.md`

Extends:

- `docs/agents/designs/132-jangar-renewable-passport-ledger-and-proof-floor-actuation-2026-05-07.md`
- `docs/agents/designs/190-jangar-projection-foreclosure-notary-and-stage-custody-repair-2026-05-13.md`
- `docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
- `docs/agents/designs/185-jangar-clearance-market-and-rollout-truth-settlement-2026-05-12.md`
- `docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `docs/agents/runbooks.md`

## Decision

I am selecting **rollout proof passports with runner capacity futures** as the next Jangar control-plane architecture
increment.

The current system can serve status and can run work, but it still asks deployers and schedulers to infer a complete
rollout truth from separate signals: PR checks, image digests, Argo revision, live pods, source-serving verdicts,
controller heartbeats, AgentRun outcomes, and Torghut repair posture. On the 2026-05-13 read-only assessment, Argo
reported `agents`, `jangar`, and `torghut` as `Synced/Healthy` at revision
`704ef0aebc13722e541c006edddee4b4610c3424`. The main workloads were ready: `agents=1/1`,
`agents-controllers=2/2`, `jangar=1/1`, and the current Torghut live/sim revisions were ready.

That is good availability evidence, but it is not enough launch authority. The same pass found material holds:
`ready_action_exchange.status=block`, dispatch and merge-ready custody receipts in `hold`, source-serving contract
verdicts blocked by `source_ci_retention_receipt_missing`, `manifest_sha_missing`, and
`manifest_image_digest_missing`, controller heartbeat split evidence, and current stage-credit holds for plan work.
In the last roughly 24 hours, all retained AgentRuns summarized to `103` succeeded, `13` failed, `6` pending, and
`2` running; Jangar control-plane retained `49` succeeded, `5` failed, and `2` running. The active plan AgentRun had
already retried after a failed attempt, and its second attempt saw a `FailedScheduling` event: `0/2 nodes are
available`, with one node failing affinity and one node carrying an untolerated taint before it eventually scheduled.
Recent verify lanes also showed `WorkflowStepTimedOut`.

The selected design turns the missing middle into a first-class contract. A rollout proof passport is the single
source-settled statement that a PR, source revision, image digest, manifest, Argo sync, workload, status route,
database projection, controller heartbeat, and post-rollout verification all point to the same system state. A runner
capacity future is the matching statement that a stage has enough schedulable execution capacity before it launches
normal work. Stage launch tickets consume both. This reduces failed AgentRuns by refusing normal launch when the
system already knows capacity or proof is missing, and it shortens green PR-to-healthy rollout time by making the
missing proof explicit instead of rediscovered by deployers.

This is the next layer after the renewable passport ledger work from 2026-05-07. That contract made launch proof
renewable and retirable across schedule generations. This contract narrows the high-value path to source-to-serving
rollout proof and adds a pre-launch capacity future so a current passport cannot still launch into an obviously
unschedulable lane.

The tradeoff is that Jangar will hold some dispatch and merge-ready work even when Argo is green and pods are ready. I
accept that. The business metric is to reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout time, not
to maximize launches. A held stage with named missing proof is cheaper than a failed AgentRun that spends a runner,
produces partial handoff evidence, and requires manual interpretation.

## Governing Runtime Requirements

This design binds to the active swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Every milestone maps to at least one required value gate:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Read-Only Evidence Snapshot

All evidence below was collected read-only on 2026-05-13. I did not mutate Kubernetes resources, database rows,
GitOps resources, AgentRuns, broker state, trading flags, or market data.

### Runtime Scope And NATS

- Runtime inputs resolved to repository `proompteng/lab`, base `main`, head
  `codex/swarm-jangar-control-plane-plan`, swarm `jangar-control-plane`, stage `plan`, live channel `general`, owner
  channel `swarm://owner/platform`, and mission ledger
  `/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md`.
- The working branch started at `704ef0aebc13722e541c006edddee4b4610c3424`, equal to the fetched `origin/main`.
- The NATS context soak against `workflow.general.>` fetched messages but returned no parseable branch-relevant
  teammate context, so durable repo and live-cluster evidence are the audit source for this pass.

### Cluster, Rollout, And Events

- Argo CD reported `agents`, `jangar`, and `torghut` as `Synced/Healthy` at revision
  `704ef0aebc13722e541c006edddee4b4610c3424`.
- `agents` namespace deployments were ready: `deployment/agents=1/1`,
  `deployment/agents-controllers=2/2`, and `deployment/agents-alloy=1/1`.
- `jangar` namespace deployments were ready: `deployment/jangar=1/1`, with the app container on
  `registry.ide-newton.ts.net/lab/jangar:146bbce5@sha256:5a333a5d...`, plus ready `bumba`, `symphony`,
  `symphony-jangar`, and `jangar-alloy`.
- Torghut serving was available after the latest rollout: `torghut-00359-deployment=1/1` and
  `torghut-sim-00457-deployment=1/1`; older Knative revisions were scaled to `0/0`.
- Recent `agents` events showed rollout readiness noise, including `agents-controllers` HTTP 503 readiness failures,
  a temporary schedule-template `FailedMount`, and the active plan AgentRun delayed by `FailedScheduling` before it
  landed on `talos-192-168-1-85`.
- The active plan AgentRun `jangar-control-plane-plan-sched-6sjkd` carried stage-credit and stage-clearance `hold`
  annotations. Its reason codes included `controller_heartbeat_not_current`, `controller_witness_allow_with_split`,
  `evidence_clock_custody_blocked`, `route_stability_hold`, `source_rollout_truth_hold`, and
  `stage_credit_insufficient`.
- Jangar control-plane AgentRuns created in the last roughly 24 hours summarized to `49` succeeded, `5` failed, and
  `2` running. Failed Jangar implement runs included `BackoffLimitExceeded`; failed verify runs included
  `WorkflowStepTimedOut`.
- All AgentRuns created in the same window summarized to `103` succeeded, `13` failed, `6` pending, and `2` running.
  This is a healthy success majority, but the failure and pending tail is large enough to justify launch admission
  improvements.

### Jangar Runtime, Source, And Test Surface

- `curl http://agents.agents.svc.cluster.local/ready` returned HTTP 200 with `status=ok`; the serving passport was
  present and leader election reported the agents service replica as leader for the `agents` namespace.
- `curl http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200 with `status=ok`; the Jangar service replica
  was leader for its own control-plane lease.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` reported
  `database.status=healthy`, `database.connected=true`, latency `4ms`, migration consistency `29/29`, and latest
  applied migration `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- The same status route reported `agentrun_ingestion.status=unknown` with message `agents controller not started`.
  The controller witness layer considered that a split projection rather than total outage because the controller
  deployment itself was ready.
- `ready_action_exchange` was in `observe` mode but `status=block`. It allowed `serve_readonly` and
  `torghut_observe`, held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`,
  and blocked `live_micro_canary` and `live_scale`.
- `source_serving_contract_verdict_exchange.status=block`, with missing source CI retention and manifest digest
  receipts. This is the direct evidence that a green deployment does not yet prove green PR-to-serving truth.
- High-risk source modules are already large and highly coupled: `agents-controller/index.ts` is `1827` lines,
  `control-plane-status.ts` is `766` lines, `control-plane-action-custody.ts` is `595` lines,
  `control-plane-stage-clearance.ts` is `563` lines, `control-plane-ready-truth-arbiter.ts` is `442` lines, and
  `services/jangar/src/data/agents-control-plane.ts` is `2386` lines.
- Existing focused tests cover control-plane status, action custody, stage clearance, ready truth, terminal debt,
  source-serving verdicts, watch reliability, and Torghut consumer evidence. The remaining gap is not basic reducer
  coverage; it is cross-surface admission coverage that proves a PR, rollout, source-serving status, and runner slot
  agree before normal launch.

### Database, Data Quality, And Freshness

- Direct CNPG resource inspection was blocked by RBAC for `clusters.postgresql.cnpg.io`,
  `scheduledbackups.postgresql.cnpg.io`, and `backups.postgresql.cnpg.io` in namespace `jangar`. Direct statefulset
  listing was also forbidden. This reinforces that the rollout proof contract must use service-level read evidence,
  not privileged database pod access, as its normal worker path.
- Jangar application database status was healthy through the control-plane status route: connected, `29` registered
  migrations, `29` applied migrations, no missing or unexpected migrations, latest applied migration
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Torghut `/db-check` returned `ok=true`, schema current at Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, expected and current head count `1`, no missing or unexpected
  heads, and lineage ready with known parent-fork warnings.
- Torghut `/readyz` returned HTTP 503 with `status=degraded`, but the dependencies were specific: scheduler,
  Postgres, ClickHouse, Alpaca, database schema, universe, and empirical jobs were OK. Live submission was blocked by
  `simple_submit_disabled`; profitability proof floor was `repair_only`; capital state was `zero_notional`; promotion
  eligible hypotheses were `0`.
- Torghut route custody showed useful repair evidence but no capital authority. The consumer evidence route carried a
  route warrant ref and blockers including `quant_health_not_configured`, `market_context_stale`,
  `route_tca_missing`, `max_notional_zero`, and `profit_signal_quorum_observe_only`.

## Problem

The control plane has accumulated the right ingredients but still lacks a single admission object that answers two
questions before material work starts:

1. Is the rollout truth complete for this source revision?
2. Is there schedulable runner capacity for this stage and action class?

The current failure modes are concrete:

- Argo can be `Synced/Healthy` while source-serving contract verdicts are blocked by missing CI retention and manifest
  digest receipts.
- `/ready` can be `ok` for serving while action custody correctly holds dispatch and merge-ready work.
- Controller witness can be split, which is safe for serving status but not enough for normal material launch.
- A stage can have a valid AgentRun object and still hit `FailedScheduling` because node affinity, taints, PVC, image,
  or runtime budget were not settled before launch.
- Verify stages can timeout after green CI because rollout proof and post-rollout service checks are reconstructed
  late rather than carried as a passport.
- Torghut repair-only proof can be reachable and useful while capital and paper actions must remain held.

The next architecture increment must reduce repeated launch failures and make deployer decisions faster. More status
fields are not enough. We need a passport that is consumed by admission and a capacity future that prevents known-bad
launches before Kubernetes has to fail them.

## Alternatives Considered

### Option A: Keep Independent Ledgers And Improve Handoff Text

This path keeps source-serving verdicts, action custody, ready truth, stage credit, terminal debt, and Torghut repair
evidence as separate objects. Engineers and deployers would read the fields and write better handoffs.

Advantages:

- Minimal implementation cost.
- Preserves existing reducer boundaries.
- Low risk of blocking work by accident.

Disadvantages:

- Keeps manual interpretation in the critical path.
- Does not stop launches when runner capacity is already suspect.
- Does not create one PR-to-rollout stopwatch.
- Lets missing manifest digest evidence remain a prose problem rather than an admission fact.

Decision: reject. Better handoff text helps audits, but it will not materially reduce failed AgentRuns.

### Option B: Enforce Ready Truth Immediately For Normal Launch

This path makes `ready_truth_arbiter` and action custody directly suppress normal launch whenever material readiness is
not `allow`.

Advantages:

- Reuses existing status objects.
- Reduces unsafe dispatch quickly.
- Simple for operators to understand.

Disadvantages:

- Does not solve missing source-to-manifest-to-image proof.
- Does not reserve or validate runner capacity.
- Risks holding all normal work without naming the smallest missing proof.
- Could convert a scheduler reliability issue into a broad stage freeze.

Decision: reject as the next primary step. Ready truth remains necessary, but it needs a passport and capacity proof
to become actionable.

### Option C: Rollout Proof Passports And Runner Capacity Futures

This selected path creates two new read-side admission contracts:

- `rollout_proof_passport`: the source-to-serving proof that the PR, source revision, CI result, manifest, image
  digest, Argo revision, workload, database, controller heartbeat, status route, and verify command agree.
- `runner_capacity_future`: the stage-to-runtime proof that a lane can schedule and finish work within its budget
  before launching normal dispatch, deploy, or verify work.

Stage launch tickets consume both contracts. Serving and observe work can stay available with partial proof. Normal
dispatch, deploy widening, and merge-ready work require current proof and capacity. Repair dispatch can run with a
bounded repair passport and zero-notional Torghut proof.

Advantages:

- Directly targets `failed_agentrun_rate` by preventing known capacity misses.
- Directly targets `pr_to_rollout_latency` by carrying one proof object from green CI to healthy rollout.
- Makes source-serving contract gaps machine-readable admission blockers.
- Gives verify and deployer stages a concise acceptance object.
- Keeps Torghut repair-only work possible without leaking into paper/live capital.

Disadvantages:

- Adds a contract that must be generated and consumed across several reducers.
- Requires careful TTLs so passports do not outlive their source revision.
- May hold work that would have succeeded by luck.

Decision: select Option C.

## Architecture

### Rollout Proof Passport

The `rollout_proof_passport` is a read-side contract emitted by Jangar control-plane status and consumed by stage
credit, ready truth, action custody, and deployer runbooks.

```text
rollout_proof_passport
  schema_version = jangar.rollout-proof-passport.v1
  passport_id
  generated_at
  fresh_until
  repository
  base_ref
  head_ref
  source_sha
  pr_number
  pr_merge_sha
  ci_conclusion
  manifest_sha
  manifest_image_digest
  registry_image_digest
  argo_application
  argo_sync_revision
  argo_health
  workload_refs[]
  serving_status_ref
  database_projection_ref
  controller_heartbeat_ref
  post_rollout_verify_refs[]
  decision = absent | collecting | current | degraded | stale | contradicted
  action_class_decisions[]
  reason_codes[]
  value_gate_impacts[]
  rollback_target
```

The passport must be source-settled:

- `source_sha` must match the merged PR or explicitly cite why the current source is pre-merge.
- `manifest_sha` must identify the GitOps manifest commit that changed the workload.
- `manifest_image_digest` and `registry_image_digest` must match the live workload digest for the action class being
  admitted.
- `argo_sync_revision` must match the manifest revision or be named as lagging.
- `serving_status_ref` must come from a status route that includes database and controller witness evidence.
- `post_rollout_verify_refs` must include Argo, workload readiness, and service health checks for verify and merge.

### Runner Capacity Future

The `runner_capacity_future` is a bounded reservation and schedulability contract. It does not create a pod or mutate
Kubernetes. It proves that a planned stage has a credible path to run.

```text
runner_capacity_future
  schema_version = jangar.runner-capacity-future.v1
  future_id
  generated_at
  fresh_until
  namespace
  swarm_name
  stage
  action_class
  expected_runtime_seconds
  retry_budget
  service_account
  node_selector_summary
  toleration_summary
  pvc_refs[]
  secret_refs[]
  image_ref
  image_pull_state
  schedulability_state = available | constrained | unavailable | unknown
  launch_window
  reason_codes[]
  required_repair_actions[]
```

The first implementation can derive this from existing read paths: AgentRun runtime config, workload image, service
account, recent events, pod status, resource quota where available, and workload history. It does not need a scheduler
plugin. It must at least classify:

- recent `FailedScheduling` for the same lane or runtime image;
- untolerated taints or unmatched node affinity in recent events;
- repeated image pull delay or missing image digest;
- PVC or ConfigMap mount failures;
- historical stage timeout rates over the recent schedule window;
- pending AgentRuns that already consume the lane budget.

### Stage Launch Ticket

Normal stage work should be launched by a `stage_launch_ticket` that binds proof and capacity:

```text
stage_launch_ticket
  schema_version = jangar.stage-launch-ticket.v1
  ticket_id
  generated_at
  fresh_until
  stage
  action_class
  rollout_proof_passport_ref
  runner_capacity_future_ref
  projection_foreclosure_notary_ref
  torghut_profit_carry_passport_ref
  decision = allow | repair_only | hold | block
  max_dispatches
  max_runtime_seconds
  reason_codes[]
  rollback_target
```

Policy:

- `serve_readonly` can run when service and database proof are current.
- `torghut_observe` can run when Torghut is reachable and max notional remains zero.
- `dispatch_repair` can run with a current repair passport, zero-notional Torghut proof, and available capacity.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require a current rollout proof passport and available runner
  capacity future.
- `paper_canary`, `live_micro_canary`, and `live_scale` remain blocked or held until the companion Torghut profit-carry
  passport graduates with its guardrails satisfied.

## Failure-Mode Reduction

| Failure mode                   | Current symptom                                                                                | Selected mechanism                                                                                              | Value gates                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Missing manifest/source proof  | Source-serving verdict blocks on missing CI and manifest digest receipts                       | Rollout proof passport has explicit `manifest_sha`, `manifest_image_digest`, and `registry_image_digest` states | `pr_to_rollout_latency`, `ready_status_truth`        |
| Failed scheduling              | AgentRun pod delayed by node affinity and taint mismatch                                       | Runner capacity future classifies schedulability before normal launch                                           | `failed_agentrun_rate`, `manual_intervention_count`  |
| Verify timeout                 | Verify AgentRuns fail with `WorkflowStepTimedOut` after rollout evidence is reconstructed late | Stage launch ticket requires expected runtime and post-rollout verify refs                                      | `failed_agentrun_rate`, `handoff_evidence_quality`   |
| Readiness ambiguity            | `/ready=ok` while material actions are held                                                    | Passport separates serving proof from material launch proof                                                     | `ready_status_truth`                                 |
| Torghut repair-only ambiguity  | Torghut evidence is useful but capital is zero-notional                                        | Companion profit-carry passport binds repair hypotheses and no-notional guardrails                              | `ready_status_truth`, `handoff_evidence_quality`     |
| Manual deployer interpretation | Argo is healthy but source/manifest proof missing                                              | Deployer checks one passport verdict and one launch ticket                                                      | `pr_to_rollout_latency`, `manual_intervention_count` |

## Implementation Milestones

### Milestone 1: Passport Schema And Read Model

Value gates: `ready_status_truth`, `handoff_evidence_quality`.

- Add a Jangar status-domain type for `rollout_proof_passport`.
- Build a pure reducer that accepts source rollout truth, source-serving verdicts, database status, controller witness,
  rollout health, and verify evidence.
- Emit the passport on `/api/agents/control-plane/status`.
- Tests must cover current, collecting, stale, degraded, and contradicted passports.

### Milestone 2: Manifest, Registry, And Argo Reconciliation

Value gates: `pr_to_rollout_latency`, `ready_status_truth`.

- Populate `manifest_sha`, `manifest_image_digest`, `registry_image_digest`, and `argo_sync_revision`.
- Treat missing manifest digest as `collecting` for serve-readonly and `hold` for normal material launch.
- Add regression tests for digest match, digest mismatch, and Argo lagging source.
- Deployer acceptance requires a passport with a current digest chain before merge-ready.

### Milestone 3: Runner Capacity Futures

Value gates: `failed_agentrun_rate`, `manual_intervention_count`.

- Add `runner_capacity_future` classification from recent events, pending AgentRuns, runtime config, image ref, and
  stage history.
- Mark normal launch `hold` when the lane recently hit `FailedScheduling`, image pull failure, mount failure, or
  repeated timeout and no repair receipt cleared the reason.
- Tests must cover node affinity mismatch, untolerated taint, missing ConfigMap/PVC mount, image digest absence, and
  healthy capacity.

### Milestone 4: Stage Launch Tickets

Value gates: `failed_agentrun_rate`, `pr_to_rollout_latency`, `ready_status_truth`.

- Wire passports and capacity futures into stage credit and ready truth behind a configuration flag.
- Emit `stage_launch_ticket` for each action class.
- Hold `dispatch_normal`, `deploy_widen`, and `merge_ready` unless both passport and future are current.
- Allow bounded `dispatch_repair` only with explicit repair scope, zero-notional Torghut proof, and available capacity.

### Milestone 5: Deployer Cutover

Value gates: `pr_to_rollout_latency`, `manual_intervention_count`, `handoff_evidence_quality`.

- Update deployer runbooks to require the passport and launch ticket instead of raw status-field interpretation.
- Verify after rollout: Argo healthy, workload ready, status route healthy or explicitly held, passport current, runner
  capacity future available, and Torghut remains zero-notional for repair-only work.
- Record before and after counts for failed AgentRuns, pending launches, and PR-to-healthy rollout duration.

## Validation Gates

Engineer stage is not complete until these checks pass:

- Unit tests for rollout proof passport state transitions.
- Unit tests for runner capacity future classification.
- Regression tests for recent `FailedScheduling`, mount failure, missing image digest, and verify timeout input.
- Regression tests proving `serve_readonly` remains available when material launch is held by missing manifest proof.
- Regression tests proving normal launch is held when passport and capacity future disagree.
- `bunx oxfmt --check` on touched TypeScript and Markdown paths.
- The nearest targeted Jangar test command for every touched TypeScript reducer.

Verify stage is not complete until these runtime checks are recorded:

- `gh pr checks <pr> --watch -R proompteng/lab` is green before merge.
- Argo reports `agents`, `jangar`, and `torghut` synced and healthy, or names the exact non-healthy app and reason.
- Jangar `/ready` and `/api/agents/control-plane/status?namespace=agents` are reachable.
- The status route includes `rollout_proof_passport` and `runner_capacity_future` after implementation.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` explain holds with passport or capacity reason codes.
- Torghut `/db-check` is schema-current.
- Torghut `/readyz` may remain degraded only for capital/profit guards, and max notional remains `0` for repair-only
  work.

## Rollout Plan

1. Ship the passport reducer in observe mode with no admission behavior change.
2. Add manifest, registry, and Argo fields and compare against live workload digests.
3. Ship runner capacity futures in observe mode and compare predictions against actual scheduling outcomes for one
   schedule cycle.
4. Enable stage launch tickets for discover and plan normal dispatch.
5. Enable implement and verify normal dispatch after failure counts and scheduler predictions match.
6. Promote deployer runbooks to require passport current and capacity available before merge-ready.

Implementation note: observe-mode status reducer (2026-05-13).

- `services/jangar/src/server/control-plane-rollout-proof-passport.ts` now emits a read-only
  `rollout_proof_passport` from source rollout truth, source-serving verdicts, database status, controller witness,
  rollout health, and ready truth.
- The passport reports `current`, `collecting`, `stale`, `degraded`, or `contradicted`; missing source CI, manifest
  digest, or registry digest proof holds material launch evidence without changing serving readiness.
- The same reducer emits `runner_capacity_futures` for normal swarm dispatch lanes using recent scheduling events,
  workflow timeout evidence, runtime adapter health, stage credit, and passport image-digest state.
- `stage_launch_tickets` bind the passport and runner future for handoff evidence only. This implementation does not
  change scheduler admission or deployer cutover behavior.
- Rollback is consumer-side: keep existing ready truth, stage credit, runtime-admission passports, and source-serving
  verdicts as authority while ignoring the new status fields or keeping downstream consumers in observe mode.

## Rollback Plan

Rollback is configuration-first:

- set passport and runner-capacity consumption to observe-only;
- keep emitting the payload if it is stable, so incident review still has evidence;
- fall back to existing ready truth, stage credit, action custody, and source-serving verdict behavior;
- do not delete AgentRuns, jobs, database rows, or receipts as part of rollback;
- if the passport route causes status instability, roll back the Jangar deployment image and keep existing design
  contracts as the operator source of truth.

## Risks And Mitigations

- Risk: capacity prediction blocks a stage that would have scheduled. Mitigation: start in observe mode, require recent
  matching failure evidence before hold, and keep repair dispatch available.
- Risk: passport TTLs go stale during long CI or image promotion. Mitigation: mark the passport `collecting` rather
  than `contradicted` while a known promotion is in flight.
- Risk: source and manifest proof is unavailable to the service account. Mitigation: use GitHub, Argo, and status-route
  evidence first; report exact missing access instead of requiring pod exec or direct database privileges.
- Risk: deployer handoff becomes too strict. Mitigation: keep `serve_readonly` and `torghut_observe` separate from
  material launch and make every hold name the missing proof.
- Risk: Torghut repair work starves. Mitigation: companion profit-carry passports keep zero-notional repair dispatch
  available when it names expected value and guardrails.

## Handoff To Engineer

Build the passport and future as pure reducers first. Do not start by changing scheduler behavior. The first production
PR should make the evidence visible, testable, and stable. The second PR can wire the contracts into stage credit and
ready truth behind flags.

Acceptance gates:

- a green Argo app without manifest digest proof produces `collecting` or `hold`, not `allow`, for normal launch;
- a recent `FailedScheduling` event for the same lane produces a constrained or unavailable runner future;
- serving readiness stays available when material launch is held;
- verify handoff can point to one passport and one stage launch ticket;
- tests cover current, stale, contradicted, and capacity-unavailable states.

## Handoff To Deployer

Deployer should use the rollout proof passport as the PR-to-healthy evidence object once it lands. Do not infer
rollout health from Argo alone. The rollout is healthy for material launch only when the passport is current, the
runner capacity future is available for the target stage, and the stage launch ticket decision is `allow` for the
action class.

Rollout acceptance gates:

- Argo `agents`, `jangar`, and `torghut` are synced and healthy;
- Jangar status route emits current passport evidence for the deployed revision;
- runner capacity future is available for the next stage;
- Torghut repair work remains zero-notional unless a later capital passport explicitly graduates;
- failed AgentRun and pending-run counts are recorded before and after cutover.
