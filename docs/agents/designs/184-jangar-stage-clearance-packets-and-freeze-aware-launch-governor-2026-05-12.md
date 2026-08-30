# 184. Jangar Stage-Clearance Packets And Freeze-Aware Launch Governor (2026-05-12)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-12
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane resilience, scheduled AgentRun admission, stage-freeze reduction, action-custody
enforcement, Torghut repair launch safety, validation, rollout, rollback, and handoff gates.

Governing requirements:

- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`
- `docs/agents/designs/183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md`
- Swarm validation contract: every run cites its governing requirement before changing code; implementation stages
  produce production PRs with tests or report the exact blocker; verify stages merge only green PRs and prove Argo,
  workload readiness, and service health after rollout; final handoff names the control-plane metric improved or the
  smallest blocker preventing improvement.

Companion Torghut contract:

- `docs/torghut/design-system/v6/188-torghut-profit-repair-clearance-packets-and-market-context-slos-2026-05-12.md`

Extends:

- `183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md`
- `182-jangar-controller-witness-carry-and-failure-debt-maturity-2026-05-08.md`
- `180-jangar-stage-clearance-exchange-and-scheduler-routability-contract-2026-05-08.md`
- `180-jangar-execution-trust-debt-retirement-and-profit-repair-settlement-2026-05-08.md`

## Decision

I am selecting a **freeze-aware launch governor backed by stage-clearance packets** as the next Jangar architecture
step.

The May 8 action-custody design was the right direction. It made material decisions depend on source truth, controller
witnesses, route stability, Torghut consumer evidence, and action-class receipts. The live May 12 evidence shows the
next failure mode: Jangar can hold material action classes while schedule-driven AgentRuns still start under a frozen
swarm and degraded execution trust. The system is serving, but it is still spending run capacity on work that is not
cleared by the same truth used to hold dispatch, deploy widening, merge readiness, and capital.

The selected design makes stage clearance a launch-time contract. Every scheduled `discover`, `plan`, `implement`, and
`verify` launch must carry a current `stage_clearance_packet`. The packet binds the governing design requirement, the
swarm freeze state, stage freshness, controller witness, runtime adapter state, source-rollout truth, material action
verdict, failure-domain lease, Torghut repair value, and the exact action class being requested. Serving reads and
observe-only Torghut evidence can stay available, but normal stage launches cannot bypass the material action holds by
using an older runtime-admission passport or CronJob path.

The tradeoff is that the scheduler becomes stricter. I accept that because the business metric is not "more AgentRuns
launched." It is fewer failed AgentRuns and a shorter green PR-to-healthy GitOps rollout time. A failed launch during a
known freeze adds audit noise, hides the real unblocker, and increases manual intervention.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests, trading
flags, or AgentRun objects.

### Cluster And Rollout

- Work ran on `codex/swarm-jangar-control-plane-plan`, fast-forwarded to current `origin/main`.
- The Kubernetes service account was `system:serviceaccount:agents:agents-sa`; it could read application, pod, event,
  secret, and AgentRun surfaces, but could not list CNPG cluster objects or exec into database pods.
- Argo CD reported `agents`, `jangar`, and `symphony-jangar` as `Synced/Healthy` at revision
  `b9137f87f5e14cffab6f841cf5ead38724b95949`. `torghut` was `Synced/Degraded`, and `torghut-options` was
  `Synced/Progressing`.
- `deployment/agents` was `1/1`; `deployment/agents-controllers` was `2/2`; `deployment/jangar` was `1/1`.
  `jangar-6679f79857-tsgp2` was running but had restarted once during the assessment window.
- The `jangar-control-plane` swarm was `Frozen` until `2026-05-12T17:00:39.529Z`, reason `StageStaleness`, with
  `Degraded=True` and message `unhealthy stages: discover, implement`.
- The swarm requirements bridge reported `implement target AgentRun/jangar-swarm-implement-template not found`.
- AgentRun CRs in `agents` counted `495 Succeeded`, `116 Failed`, `9 Running`, `1 Pending`, and `12 Template`.
- Recent `agents` events showed scheduled `jangar-control-plane-plan`, `implement`, `verify`, and `discover` work
  launching while the swarm was frozen. The same event sample showed repeated Torghut market-context failures with
  `BackoffLimitExceeded`.
- Recent `torghut` events showed a `torghut-ta-sim` image digest that was not found, followed by a stateless restart to
  a digest present on the node, startup probe failures, and Flink `Job Not Found` warnings.

### Runtime Status

- `http://jangar.jangar.svc.cluster.local/health` returned HTTP 200.
- Jangar control-plane status at `2026-05-12T16:44:09.227Z` reported `execution_trust=degraded` because the swarm
  freeze delayed `discover`, `plan`, `implement`, and `verify`.
- The deployer summary state was `heartbeat_projection_split`, with freshest blocker
  `witness:agentrun_ingestion:b68bb0662020ae4c`; held action classes included `dispatch_repair`,
  `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale`.
- The same status allowed only read or observe surfaces in practice: `serve_readonly` and `torghut_observe` could
  carry zero-notional evidence, while dispatch, deploy, merge, paper, and live action classes had zero dispatch or
  notional budgets.
- Torghut consumer evidence was current, but its decision was `repair`, `max_notional=0`, `route_repair_value=14`, and
  reason codes included `empirical_jobs_degraded`, `forecast_registry_degraded`, `simple_submit_disabled`,
  `hypothesis_not_promotion_eligible`, `degraded`, and `market_context_stale`.

### Source Assessment

- `services/jangar/src/server/control-plane-material-action-verdict.ts` already composes action clocks, dependency
  quorum, source-rollout truth, and action budgets.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts`,
  `control-plane-route-stability-escrow.ts`, `control-plane-controller-witness.ts`, and
  `control-plane-torghut-consumer-evidence.ts` already produce most packet inputs.
- `services/jangar/src/server/control-plane-runtime-admission.ts` produces admission passports, but those passports do
  not yet close the observed launch gap between a frozen swarm and a CronJob-driven AgentRun.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains the high-risk enforcement point because it
  owns schedule launch behavior and is over 3,000 lines. The implementation should add a small pure reducer for packet
  decisions and call it from the scheduler instead of embedding more inline special cases.
- Existing Jangar tests cover controller witnesses, material action verdicts, negative evidence routing, route
  stability escrow, runtime admission, control-plane status, Torghut consumer evidence, and watch reliability. The
  missing regression test is a launch-governor invariant: a frozen swarm plus held material action must not create a
  normal stage launch.

### Database And Data Assessment

- Local `psql` was unavailable, and pod exec was forbidden with
  `pods "jangar-db-1" is forbidden: User "system:serviceaccount:agents:agents-sa" cannot create resource "pods/exec"`.
  I used the Jangar and Torghut app database secrets from Kubernetes and connected to service endpoints with a Bun
  Postgres client inside `BEGIN READ ONLY`; no secret values were printed.
- Jangar database schemas included `agents_control_plane`, `workflow_comms`, `memories`, `torghut_control_plane`,
  `codex_judge`, and `jangar_github`.
- Jangar table stats showed `agents_control_plane.resources_current` with about `4386` live rows and fresh
  auto-vacuum/analyze activity near `2026-05-12T16:33Z`.
- `agents_control_plane.resources_current` counted `493` succeeded AgentRuns, `116` failed AgentRuns, `12` templates,
  `11` running AgentRuns, and `1` pending AgentRun in the direct read.
- `workflow_comms.agent_messages` had `21113` rows with newest `created_at=2026-05-12T16:40:12.601Z`.
- `memories.entries` had `1176` rows with newest `created_at=2026-05-08T22:35:08.279Z`, but the memory helper used by
  this run returned HTTP 500 during retrieval, so memory access is not a reliable current-run evidence source.
- `torghut_control_plane.quant_metrics_latest` had fresh update timestamps but many non-ok metrics: for
  `PA3SX7FYNUTF/15m`, `180` metrics, latest update `2026-05-12T16:37:31.717Z`, and `107` non-ok metrics.
- Direct reads from `torghut_control_plane.quant_pipeline_health` timed out even on a limited ordered query. The
  runtime status surface reported the same data-quality issue as `quant_pipeline_stages_missing`, so the data
  assessment treats pipeline-stage freshness as degraded until that table can be queried within the SLO.

## Problem

Jangar now has enough evidence to avoid broad blind freezes, but launch authority is not yet bound to that evidence.

The control plane can say:

1. The service is alive and routes read-only status.
2. The swarm is frozen by stage staleness.
3. Material actions are held by source-rollout truth and controller witness disagreement.
4. Torghut has current observe evidence but no capital or normal dispatch authority.
5. A schedule runner can still start plan, implement, discover, or verify work under the same degraded state.

That split creates repeated failure modes:

- Failed AgentRuns accumulate during known freeze windows.
- Operators must infer whether a launch was expected repair work or accidental scheduler fanout.
- Runtime-admission passports look like launch authority even when material action verdicts are holding.
- Torghut repair work competes with Jangar repair work without a shared capacity and value contract.
- Green PR-to-healthy rollout time lengthens because failed launches pollute the evidence needed to prove recovery.

The control plane needs one launch decision per stage and action class, not parallel truths that humans reconcile after
the fact.

## Alternatives Considered

### Option A: Keep Action-Custody Receipts And Fix Only The Active CronJobs

Patch the currently failing or noisy schedules, reduce launch frequency, and rely on material action receipts for
deploy and capital decisions.

Advantages:

- Small implementation.
- Low migration risk.
- Directly reduces the specific noisy schedules seen on May 12.

Disadvantages:

- Leaves runtime admission, CronJob launch behavior, and material action custody as separate authorities.
- Does not stop the next schedule template or provider lane from launching during a freeze.
- Does not produce a durable handoff gate for engineer and deployer stages.

Decision: reject as the architecture. It can be a tactical mitigation, but it does not reduce the failure mode class.

### Option B: Convert Every Freeze Into A Full Scheduler Stop

When a swarm is frozen or execution trust is degraded, hold all scheduled work until the state is green.

Advantages:

- Easy to reason about during an incident.
- Strongly reduces failed AgentRuns caused by known freezes.
- Small enforcement surface.

Disadvantages:

- Blocks the repair work needed to clear the freeze.
- Increases manual intervention because engineers must launch repair runs outside the governed path.
- Loses Torghut's current repair-value signal instead of converting it into bounded zero-notional work.

Decision: keep as a rollback lever, not the steady-state design.

### Option C: Stage-Clearance Packets With A Freeze-Aware Launch Governor

Compile a packet per `swarm/stage/action_class` and require the scheduler to cite a current packet before launch. The
packet can allow read-only or observe work, allow bounded repair work, hold normal work, or block capital-sensitive
work.

Advantages:

- Binds scheduled launches to the same evidence that holds material actions.
- Lets repair work continue when it is explicitly named, bounded, and valuable.
- Produces machine-readable acceptance gates for engineer and deployer stages.
- Reduces failed AgentRuns without creating a broad manual freeze.
- Gives Torghut a zero-notional repair path tied to expected unblock value.

Disadvantages:

- Adds a new status projection and reducer.
- Requires scheduler changes at a risky integration point.
- Requires careful reason-code stability so operators can trust the packets.

Decision: select Option C.

## Architecture

Jangar adds `stage_clearance_packets` to the control-plane status payload and requires one packet for each scheduled
launch.

```text
stage_clearance_packet
  schema_version
  packet_id
  generated_at
  fresh_until
  namespace
  swarm_name
  stage                         # discover | plan | implement | verify | repair
  action_class                  # serve_readonly | dispatch_repair | dispatch_normal | deploy_widen | merge_ready
  governing_requirement_refs[]
  source_rollout_truth_ref
  controller_witness_ref
  agentrun_ingestion_ref
  execution_trust_ref
  material_action_verdict_ref
  route_stability_ref
  torghut_consumer_evidence_ref
  failure_domain_leases[]
  provider_capacity_ref
  decision                      # allow | repair_only | hold | block
  max_launches
  max_notional
  ttl_seconds
  reason_codes[]
  required_repair_action
  rollback_target
```

The launch governor is a pure reducer over existing inputs. It does not create a new source of truth. It settles
existing truth into a scheduler decision.

Decision rules:

- `serve_readonly` may allow when the Jangar service, database, and status route are healthy, even under stage debt.
- `torghut_observe` may allow when the Torghut receipt is current and `max_notional=0`.
- `dispatch_repair` is `repair_only` when the packet names the exact debt class, expected repair output, TTL, and
  launch budget.
- `dispatch_normal` is held whenever the swarm is frozen, stage freshness is stale, workflow runtime is unavailable,
  provider capacity debt is active, or controller/action witness truth has not settled.
- `deploy_widen` and `merge_ready` are held until the packet proves Argo revision, live workload readiness, controller
  witness, AgentRun ingestion, source rollout truth, and retained failure debt have converged.
- `paper_canary`, `live_micro_canary`, and `live_scale` remain blocked unless Torghut emits a current profit-repair
  clearance packet with non-zero capital authority and Jangar action custody agrees.

The scheduler must persist or log the packet ID on each launched AgentRun. A launched run without a packet ID is treated
as a launch-governor violation and cannot count as green rollout evidence.

## Implementation Scope

Milestone 1: Packet reducer and status projection.

- Add `control-plane-stage-clearance.ts` under `services/jangar/src/server/`.
- Add typed packet fields to control-plane status types and frontend data models.
- Unit tests cover frozen swarm, heartbeat projection split, current Torghut observe receipt, stale quant stages, and
  normal dispatch hold.
- Value gates: `ready_status_truth`, `failed_agentrun_rate`, `handoff_evidence_quality`.

Milestone 2: Scheduler enforcement in shadow, then hold.

- `services/jangar/src/server/supporting-primitives-controller.ts` resolves a packet before creating stage work.
- Shadow mode logs packet decisions and attaches packet refs to runs without blocking.
- Hold mode prevents normal launches when packet decision is `hold` or `block`, but allows bounded `repair_only`
  launches.
- Value gates: `failed_agentrun_rate`, `manual_intervention_count`, `pr_to_rollout_latency`.

Milestone 3: Torghut repair-clearance integration.

- Consume the companion Torghut profit-repair clearance packet and include its receipt in Jangar packets.
- Treat `route_repair_value`, market-context SLO state, and promotion-table emptiness as repair launch inputs, not
  capital authority.
- Value gates: `failed_agentrun_rate`, `pr_to_rollout_latency`, `handoff_evidence_quality`.

Milestone 4: Deployer proof gates.

- Verify stages must cite stage-clearance packet IDs, Argo revisions, workload readiness, Jangar `/api/agents/control-plane/status`,
  Torghut `/readyz`, and the relevant Git commit.
- Green PR-to-healthy rollout evidence must ignore runs that lack packet IDs.
- Value gates: `pr_to_rollout_latency`, `ready_status_truth`, `manual_intervention_count`.

## Validation Gates

Engineer acceptance gates:

- A unit test fails before the reducer change and passes after: frozen `jangar-control-plane` plus held
  `dispatch_normal` returns `hold` with `swarm_freeze_active` and creates no normal launch decision.
- A current Torghut observe receipt with `max_notional=0` returns `allow` only for `torghut_observe`.
- A degraded quant pipeline or market-context stale reason returns `repair_only` only when the repair class is named and
  launch budget is bounded.
- Packet decisions include the governing requirement refs for the stage.

Deployer acceptance gates:

- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` includes
  `stage_clearance_packets`.
- While `jangar-control-plane` is frozen, scheduled normal plan/implement/verify launches stop or carry `hold` packet
  evidence; bounded repair launches carry packet IDs.
- Argo applications for `agents` and `jangar` are `Synced/Healthy` on the expected Git revision after rollout.
- Workload readiness confirms `deployment/agents`, `deployment/agents-controllers`, and `deployment/jangar` are ready.
- Torghut remains zero-notional until its companion clearance packet removes capital blockers.

## Rollout

Phase 1: Shadow projection.

- Publish packets in status.
- Keep existing scheduler behavior.
- Emit metrics: `stage_clearance_packet_total`, `stage_clearance_decision_total`, and
  `stage_clearance_missing_inputs_total`.

Phase 2: Shadow launch annotations.

- Attach packet IDs to launched runs.
- Report launches without packet IDs as warnings.
- Keep the packet TTL short enough to detect stale status, initially 120 seconds.

Phase 3: Hold normal launches.

- Enforce `hold` and `block` for normal stage launches.
- Keep bounded `repair_only` launches available when the packet names the debt class and max launch budget.

Phase 4: Deployer gate.

- Verify and deployer handoffs must cite packet IDs and status snippets before claiming green rollout.
- Merge-ready claims must fail closed when packet evidence is missing or expired.

## Rollback

Rollback is explicit and narrow:

- Disable enforcement with `JANGAR_STAGE_CLEARANCE_ENFORCEMENT=shadow` while keeping packet projection visible.
- If the reducer misclassifies serving health, ignore only `serve_readonly` packet enforcement; do not widen dispatch,
  deploy, merge, paper, or live classes.
- If Torghut clearance packets are missing, Jangar falls back to current action-custody receipts and keeps Torghut
  capital at zero notional.
- If scheduler integration causes launch starvation, allow one manually approved `dispatch_repair` packet per swarm and
  stage with a one-hour TTL and explicit owner handoff.

## Risks And Mitigations

- Risk: the packet reducer becomes a duplicate readiness implementation. Mitigation: it consumes existing status
  reducers and stores refs, not recalculated facts.
- Risk: strict launch holds slow recovery. Mitigation: `repair_only` packets preserve bounded repair work with clear
  debt classes.
- Risk: oversized scheduler code gets harder to maintain. Mitigation: keep packet logic in a pure module with focused
  tests and only call it from the controller.
- Risk: packet IDs become audit-only labels. Mitigation: verify and deployer gates must reject rollout evidence without
  packet IDs once enforcement reaches Phase 3.

## Handoff

Engineer next milestone:

- Implement Milestone 1 and Milestone 2 in one PR if the diff stays reviewable; otherwise split status projection from
  scheduler enforcement.
- Add regression tests for frozen swarm launch hold, repair-only launch allow, and Torghut observe-only allow.
- Cite this document in each implementation PR before changing scheduler or status code.

Deployer next milestone:

- After merge and rollout, prove Argo `agents` and `jangar` are `Synced/Healthy`, workloads are ready, and Jangar
  status includes current `stage_clearance_packets`.
- Prove that normal scheduled launches do not run during a freeze without a packet ID.
- Keep Torghut paper/live notional closed until the companion clearance packet removes capital blockers.

The control-plane metric this design improves first is `failed_agentrun_rate`. The second-order metric is
`pr_to_rollout_latency`, because verify and deployer stages no longer have to separate expected repair work from
accidental launches by hand.
