# 199. Jangar Material Action Custody Flight Recorder And Merge Reentry SLO (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar material action custody, AgentRun failure-debt reduction, ready truth, source-to-serving rollout proof,
database/schema witnesses, Torghut alpha repair admission, validation, rollout, rollback, and stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/204-torghut-alpha-repair-dividend-ledger-and-custody-flight-recorder-2026-05-14.md`

Extends:

- `docs/agents/designs/198-jangar-material-gate-digest-and-alpha-closure-carry-2026-05-14.md`
- `docs/agents/designs/197-jangar-compact-alpha-closure-ingestion-and-stage-credit-repair-gate-2026-05-14.md`
- `docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
- `docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`

## Decision

I am selecting a **material action custody flight recorder with merge reentry SLOs** as the next Jangar
control-plane architecture increment.

The reason is the current evidence split. On 2026-05-14, Jangar and Torghut workloads were serving, but material
action authority was not healthy. Argo reported `jangar` and `torghut` `Synced/Healthy`, while `agents` was
`OutOfSync/Progressing` at revision `2ee617e354af746549731b54e037f90af5d3fd6f`. Deployments were available:
`agents=1/1`, `agents-controllers=2/2`, `jangar=1/1`, Torghut live `torghut-00382=1/1`, and Torghut sim
`torghut-sim-00480=1/1`.

Serving health alone is too weak. `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`, but the
same payload reported `business_state=repair_only`, `revenue_ready=false`, top repair queue
`repair_alpha_readiness`, affected value gate `routeable_candidate_count`, and execution trust degraded because
`torghut-quant` had pending requirements and stale verify stage evidence. The richer Jangar status route showed the
database healthy at `29` registered and `29` applied Kysely migrations, but it also showed `agentrun_ingestion.status`
as `unknown`, the agents controller degraded, ready action exchange `block`, and only `serve_readonly` plus
`torghut_observe` allowed.

The runner-debt evidence is not abstract. In the agents namespace, retained pods totaled `337`: `215` succeeded,
`113` failed, and `9` running. Scoped to Jangar/Torghut swarm work, I observed `84` failed pods, `117` succeeded, and
`5` running. Recent events included missing ConfigMap mounts for Torghut/Jangar requirement pods, controller readiness
timeouts during rollout, and repeated schedule pod failures. Watch reliability itself was healthy in the current
15-minute window, with `1457` AgentRun watch events, `0` errors, and `2` restarts, so the primary problem is not an
opaque watch outage. It is that launch, deploy, and merge decisions are scattered across status, source, database,
runner, and Torghut repair surfaces.

Torghut points at the next business repair. `/trading/revenue-repair` returned `repair_only`, top queue
`repair_alpha_readiness`, `routeable_candidate_count=0`, and required output `torghut.executable-alpha-receipts.v1`.
It also reported `3` executable alpha receipts, all zero notional, no paper replay candidates, and no capital-ready
path. Jangar repair-bid admission still had a launch-allowed ticket for the same value gate while ready action held
`dispatch_repair`, `deploy_widen`, and `merge_ready`. That contradiction should never require a human to correlate
five endpoints.

The selected architecture adds `jangar.material-action-custody-flight-recorder.v1`. It is not another broad status
page. It is a compact, immutable decision record generated for each material action class. It says what Jangar knew
about serving readiness, source revision, Argo revision, database/schema consistency, controller witness, AgentRun
ingestion, runner debt, Torghut repair evidence, and no-delta/revenue blockers when it allowed, held, denied, or
blocked an action.

The tradeoff is stricter over-holding when the recorder is stale or incomplete. I accept that tradeoff. The business
metric is reducing failed AgentRuns and shortening green PR-to-healthy GitOps rollout time. A held action with a
specific recorder is cheaper than a runner pod that fails because the same missing ConfigMap, source-serving mismatch,
or Torghut no-delta condition was already visible.

## Governing Runtime Requirements

This contract implements the active swarm validation requirements:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Value-gate mapping:

- `failed_agentrun_rate`: every dispatch decision must carry the runner-debt window and deny repeat work when the
  relevant debt class has no changed release key.
- `pr_to_rollout_latency`: deployer and verifier stages read one recorder instead of reconstructing Argo, workload,
  source, DB, and service truth by hand.
- `ready_status_truth`: `/ready=ok` remains serving truth; `material_action_custody.decision` is material truth.
- `manual_intervention_count`: held actions include one selected blocker, one release condition set, and one next
  bounded implementation milestone.
- `handoff_evidence_quality`: every handoff cites recorder id, source revision, Argo revision, database witness,
  AgentRun ingestion state, Torghut repair receipt, validation commands, and rollback target.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows, GitOps
resources, AgentRuns, trading flags, broker state, or market data.

### Cluster, Rollout, And Runner Debt

- Work branch: `codex/swarm-jangar-control-plane-plan`, based on `main` at
  `2ee617e354af746549731b54e037f90af5d3fd6f`.
- Kubernetes identity: `system:serviceaccount:agents:agents-sa`, using an in-cluster context created from the service
  account token.
- Argo: `agents` was `OutOfSync/Progressing` at `2ee617e354af746549731b54e037f90af5d3fd6f`; `jangar` was
  `Synced/Healthy` at `d42c4576c46c603a9f180026672a8e5c1f974364`; `torghut` was `Synced/Healthy` at
  `2ee617e354af746549731b54e037f90af5d3fd6f`.
- Workloads: `agents=1/1`, `agents-controllers=2/2`, `jangar=1/1`, `bumba=1/1`, `symphony=1/1`,
  Torghut live `torghut-00382=1/1`, Torghut sim `torghut-sim-00480=1/1`, Torghut DB, ClickHouse, Keeper, options,
  TA, and WebSocket services were running.
- Agents namespace pods: `337` total, `215` succeeded, `113` failed, and `9` running.
- Jangar/Torghut swarm pods: `84` failed, `117` succeeded, and `5` running.
- Recent events: missing ConfigMap mounts on Torghut/Jangar requirement pods, agents controller readiness timeouts,
  temporary Jangar ready probe timeout, and repeated schedule pod failures.

### Ready, Status, Source, And Database

- `GET /ready` returned `status=ok`, `business_state=repair_only`, `revenue_ready=false`, affected gate
  `routeable_candidate_count`, and top queue `repair_alpha_readiness`.
- `/ready` execution trust was degraded because `torghut-quant` had pending requirements and stale verify evidence.
- Jangar status route returned database `healthy`, latency `3 ms`, migration table `kysely_migration`, `29`
  registered migrations, `29` applied migrations, and no missing or unexpected migrations.
- Jangar status route reported `agentrun_ingestion.status=unknown`, message `agents controller not started`,
  `agents-controller.status=degraded`, and ready action exchange `block`.
- Ready action exchange allowed `serve_readonly` and `torghut_observe`, held `dispatch_repair`, `dispatch_normal`,
  `deploy_widen`, `merge_ready`, and `paper_canary`, and blocked `live_micro_canary` plus `live_scale`.
- Source-serving contract verdict was `block` with `source_ci_retention_receipt_missing`,
  `source_serving_build_mismatch`, and `manifest_image_digest_missing`.
- Direct database introspection was blocked by RBAC: listing CNPG clusters and pod exec into `jangar-db-1` and
  `torghut-db-1` were forbidden for this service account. The accepted read path for this lane is the application
  database witness.

### Torghut Business And Data State

- `GET /trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, top queue
  `repair_alpha_readiness`, value gate `routeable_candidate_count`, priority `70`, expected unblock value `2`, and
  required output `torghut.executable-alpha-receipts.v1`.
- Routeability remained blocked with `accepted_routeable_candidate_count=0` and
  `zero_notional_or_stale_evidence_rate=1.0`.
- Repair-bid settlement was current with `42` raw bids, `6` compacted lots, `5` selected lots, `3` dispatchable lots,
  and `routeable_candidate_count=0`.
- Executable alpha had `3` receipts, `3` zero-notional receipts, `0` paper replay candidates, and
  `capital_ready=false`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, no lineage errors, and
  no warnings.
- Torghut health stayed capital-safe: `/trading/revenue-repair` kept `max_notional=0`, live submission disabled, and
  capital stage `shadow`.

### Source Architecture And Test Gaps

- High-risk Jangar modules remain broad: `supporting-primitives-controller.ts` is `3351` lines,
  `control-plane-torghut-consumer-evidence.ts` is `784` lines, `control-plane-status.ts` is `757` lines,
  `control-plane-stage-credit-ledger.ts` is `594` lines, `control-plane-ready-truth-arbiter.ts` is `478` lines, and
  `control-plane-repair-bid-admission.ts` is `440` lines.
- High-risk Torghut modules remain broad: `app/main.py` is `6938` lines, `revenue_repair.py` is `1111` lines,
  `alpha_repair_closure_board.py` is `820` lines, `repair_bid_settlement.py` is `716` lines, and
  `alpha_evidence_foundry.py` is `608` lines.
- Existing tests cover many reducers, including ready truth, stage credit, material reentry, repair-bid admission,
  Torghut consumer evidence, revenue repair, alpha closure boards, and executable alpha receipts.
- Missing test family: material action flight-recorder behavior for healthy allow, serving-ok/material-hold,
  AgentRun ingestion unknown, source-serving mismatch, database migration drift, runner-debt repeat denial, stale
  Torghut repair evidence, consumed no-delta debt, and deployer merge reentry.

## Problem

Jangar has a material-action provenance problem.

The system can prove serving health and still fail material work because launch authority is distributed across too
many surfaces. `/ready` proves that the process can serve. The status route proves more, but it is too broad to be the
object every runner and deployer cites. Argo proves GitOps state. The database witness proves schema consistency.
Torghut proves business repair state. Kubernetes events prove runner debt. None of those surfaces alone answers the
question that matters before action: "Why is this dispatch, deploy, or merge allowed right now?"

The current evidence shows six failure modes:

1. `status=ok` can coexist with `repair_only`, execution trust degradation, and zero routeable candidates.
2. A repair dispatch ticket can look launch-allowed while ready action exchange still holds dispatch.
3. `agents` can be OutOfSync/Progressing while workload pods are available, which makes rollout truth ambiguous.
4. AgentRun ingestion can be unknown even while watch reliability is healthy.
5. Missing ConfigMap mount events can be visible before repeated requirement pods fail.
6. Deployer proof can require manual correlation across Argo, Jangar, Torghut, database, source, and events.

The next architecture step is not another free-form design note. It is a decision record that Jangar can emit, store,
test, and require.

## Alternatives Considered

### Option A: Continue Using The Full Status Route As The Action Gate

Jangar would keep `/api/agents/control-plane/status` as the gate for launch, deploy, merge, and handoff evidence.

Advantages:

- No new schema.
- It already includes database, ready truth, stage credit, source-serving, rollout, watch, and Torghut evidence.
- Existing tests exercise many subcomponents.

Disadvantages:

- It is diagnostic breadth, not an immutable decision record.
- Runners and deployers still need to infer which fields controlled the action.
- It does not produce a stable release key for "do not retry this failure class until evidence changes."
- It is too easy for a launch-allowed subfield to be quoted while the overall exchange says `block`.

Decision: reject as the material action contract. Keep it as the source reducer and diagnostic surface.

### Option B: Hard-Freeze Material Actions Until Every Surface Is Healthy

Jangar would deny dispatch, deploy, merge, and paper canary whenever any source, controller, runner, Torghut, or Argo
surface is degraded.

Advantages:

- Simple and capital-safe.
- Eliminates ambiguous launches.
- Easier to explain during an incident.

Disadvantages:

- Deadlocks zero-notional repair work that must run to clear `routeable_candidate_count`.
- Increases manual exceptions because operators still need a way to clear repair-only evidence.
- Does not improve PR-to-rollout latency.
- Treats source-serving mismatch, Torghut no-delta debt, and missing ConfigMap debt as the same kind of hold.

Decision: reject as the default. Keep it as emergency rollback posture.

### Option C: Emit Material Action Custody Flight Records

Jangar emits a compact flight record whenever a material action class is evaluated. The record is cited by runs,
deployer handoffs, and merge reentry gates.

Advantages:

- Preserves `/ready` as serving truth while giving material actions their own proof.
- Prevents quoting a launch-allowed subfield without the overall gate decision.
- Turns failure debt into release-keyed no-retry decisions.
- Shortens deployer proof by carrying the source, Argo, database, workload, Torghut, and runner evidence in one object.
- Gives engineer stages a bounded implementation target with focused tests.

Disadvantages:

- Adds a schema that must remain compatible.
- Requires shadow mode before enforcement.
- Can over-hold if the recorder is stale or if a source witness is temporarily missing.

Decision: select Option C.

## Architecture

Jangar emits `jangar.material-action-custody-flight-recorder.v1`.

```text
jangar.material-action-custody-flight-recorder.v1
  recorder_id
  generated_at
  fresh_until
  mode: observe | shadow | enforce
  namespace
  repository
  branch
  action_class: serve_readonly | dispatch_repair | dispatch_normal | deploy_widen | merge_ready | paper_canary
  decision: allow | hold | deny | block
  governing_design_refs[]
  validation_contract_refs[]
  value_gate_impacts[]
  source_truth
    git_head
    argo_app
    argo_sync
    argo_health
    argo_revision
    source_serving_verdict
    source_serving_reason_codes[]
  database_truth
    status
    migration_table
    registered_count
    applied_count
    unapplied_count
    unexpected_count
    latest_registered
    latest_applied
  controller_truth
    ready_action_exchange_status
    agentrun_ingestion_status
    controller_witness_ref
    watch_reliability_status
    watch_error_count
    watch_restart_count
  runner_debt
    window_started_at
    failed_pod_count
    failed_agentrun_count
    dominant_failure_classes[]
    release_key
  torghut_truth
    revenue_repair_digest_ref
    business_state
    revenue_ready
    top_repair_code
    target_value_gate
    required_output_receipt
    routeable_candidate_count
    max_notional
    capital_rule
  decision_basis
    required_evidence_refs[]
    blocking_reason_codes[]
    selected_blocker
    release_conditions[]
    validation_commands[]
    rollback_target
```

The recorder is immutable once emitted. A later evaluation creates a new recorder with a different `recorder_id` and,
if the action remains held, a stable `runner_debt.release_key` that explains what must change before Jangar retries.

### Decision Rules

- `serve_readonly` can allow when serving readiness, database witness, and runtime proof cells are healthy or in
  documented observe mode.
- `dispatch_repair` can allow only when the recorder is fresh, database schema is healthy, the selected Torghut repair
  evidence is current, `max_notional=0`, the repair targets one value gate, AgentRun ingestion is current, and the
  runner-debt release key changed since the last failed launch for that repair class.
- `dispatch_normal` can allow only when `dispatch_repair` gates pass and repair-only Torghut blockers are cleared.
- `deploy_widen` can allow only when Argo source/serving truth, workload readiness, database witness, and ready action
  exchange agree.
- `merge_ready` can allow only after CI is green, source-serving verdict is not block, deployer proof is current, and
  the recorder has no unresolved review, rollout, or runner-debt holds.
- `paper_canary` remains held while Torghut reports `paper_replay_candidate_count=0`, `capital_ready=false`, or
  `max_notional=0`.
- `live_micro_canary` and `live_scale` remain blocked until this design is superseded by a capital-release contract.

## Rollout Plan

Phase 0 is documentation and handoff. This PR defines the schema, gates, validation, and rollback expectations.

Phase 1 is shadow read model. Add a pure reducer that builds the recorder from the current status route inputs. It
must not change launch behavior. Tests cover healthy allow, serving-ok/material-hold, source-serving block, database
drift, AgentRun ingestion unknown, and Torghut repair-only evidence.

Phase 2 is `/ready` carry. Expose the latest recorder summary under `/ready.material_action_custody` with a strict
size budget and no full diagnostic payload.

Phase 3 is launch admission. Require a fresh recorder id for `dispatch_repair` AgentRuns and deny repeat launches when
the same runner-debt release key is still active.

Phase 4 is deployer and merge reentry. Require the deployer to cite the recorder id in handoff, and require
`merge_ready` to include the deployer proof recorder id plus green CI.

## Validation Gates

Engineer implementation must pass:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-material-action-custody-flight-recorder.test.ts`
- `bun run --cwd services/jangar test -- src/routes/ready.test.ts`
- `bun run --cwd services/jangar tsc`
- `bun run --cwd services/jangar lint`
- `bun run --cwd services/jangar lint:oxlint`

Deployer verification must prove:

- Argo `agents`, `jangar`, and `torghut` are `Synced/Healthy`, or any drift is explicitly named as a hold.
- `kubectl get deploy -n agents agents agents-controllers` reports available replicas matching desired replicas.
- `GET http://agents.agents.svc.cluster.local/ready` returns serving status and material custody summary.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status` shows database healthy and recorder
  current.
- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` still reports zero-notional repair-only until
  the top queue item is cleared.
- No material action is reported ready unless its recorder says `decision=allow`.

## Rollback

Rollback is configuration-first:

- set the recorder mode to `observe`;
- keep `/ready` serving status unchanged;
- keep ready action exchange and stage credit as the enforcement source;
- keep Torghut `max_notional=0` and live submit disabled;
- remove recorder requirements from AgentRun templates only after deployer confirms no in-flight run depends on them.

Emergency rollback is the hard-freeze posture: allow `serve_readonly` and `torghut_observe`, hold repair, deploy, and
merge, and block paper/live capital until the recorder reducer is fixed.

## Risks

- Over-holding repair work if AgentRun ingestion remains unknown while watch reliability is otherwise healthy.
- Treating historical failed pods as current debt if the release key window is too long.
- Adding another schema before the prior material gate digest has been implemented.
- Making deployer proof depend on Argo while `agents` is legitimately progressing during image rollout.

The mitigation is shadow mode, short freshness TTLs, explicit release keys, and a deployer override that can record a
hold without creating new runner pods.

## Engineer Handoff

Next bounded implementation milestone: build the shadow reducer
`buildMaterialActionCustodyFlightRecorder()` in Jangar and expose it through the status route without changing launch
behavior.

Acceptance gates:

- Each recorder includes governing design refs and validation contract refs.
- `dispatch_repair` is held when AgentRun ingestion is unknown, source-serving verdict blocks, database migration
  consistency is degraded, Torghut repair evidence is stale, or runner-debt release key has not changed.
- `serve_readonly` remains allowed when serving readiness is healthy and no material action is requested.
- Tests prove the current evidence window would produce `dispatch_repair=hold`, `deploy_widen=hold`,
  `merge_ready=hold`, and `serve_readonly=allow`.

## Deployer Handoff

Do not widen deploy or merge authority on `/ready=ok` alone. A deployer handoff must cite:

- PR URL and merge commit;
- Argo sync and health for `agents`, `jangar`, and `torghut`;
- workload readiness for `agents`, `agents-controllers`, `jangar`, and active Torghut revisions;
- Jangar database migration witness;
- latest material action custody recorder id;
- Torghut revenue repair top queue item and target value gate;
- rollback target.

Until the recorder is implemented, the smallest blocker preventing improvement is absence of a single immutable
material action record that binds ready truth, source truth, database truth, runner debt, and Torghut repair evidence.
