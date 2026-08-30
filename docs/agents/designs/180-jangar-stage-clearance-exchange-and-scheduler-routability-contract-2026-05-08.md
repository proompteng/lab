# 180. Jangar Stage-Clearance Exchange And Scheduler Routability Contract (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane reliability, scheduled AgentRun launch safety, endpoint routability, stage-freeze
retirement, rollout clearance, Torghut repair admission, validation, rollout, rollback, and handoff gates.

Governing requirement:

- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`

Companion Torghut contract:

- `docs/torghut/design-system/v6/184-torghut-profit-signal-quorum-and-context-routability-handoff-2026-05-08.md`

Extends:

- `179-jangar-controller-witness-reconciliation-and-failure-debt-retirement-2026-05-08.md`
- `179-jangar-controller-witness-stability-escrow-and-capital-reentry-backpressure-2026-05-08.md`
- `178-jangar-source-serving-parity-escrow-and-route-independent-launch-passports-2026-05-08.md`
- `177-jangar-evidence-quality-admission-ledger-and-degradation-backpressure-2026-05-08.md`

## Decision

I am selecting a **stage-clearance exchange with scheduler routability admission** as the next Jangar architecture
step.

The current system is not down. At `2026-05-08T12:19Z`, Argo reported `agents`, `jangar`, `torghut`,
`symphony-torghut`, and `torghut-options` `Synced` and `Healthy`. The `agents` deployment was `1/1`, and
`agents-controllers` was `2/2`. Jangar served `/health` and `/ready`, and the root UI responded.

The system is also not action-trustworthy enough for normal widening. `/ready` returned `status=degraded` because
execution trust still saw stage staleness for both `jangar-control-plane` and `torghut-quant`. Recent scheduled pods
failed by attempting to reach `http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
and receiving `ConnectionRefused`, while the active `agents.agents.svc.cluster.local` service was reachable. The
database heartbeat table showed `agents-controller` as `disabled`, while the `agents-controllers` deployment was
configured with `JANGAR_AGENTS_CONTROLLER_ENABLED=1` and controller logs were reconciling AgentRuns. That is a
route and witness split, not a simple rollout outage.

The selected design makes stage clearance an explicit exchange. A scheduled runner must carry a current
`stage_clearance_packet` before launching work. That packet proves the serving route is routable, the controller
witness is fresh or precisely degraded, stage debt is classified, and the requested action class is allowed. This
keeps serving and repair work alive, but prevents normal dispatch, deploy widening, merge-ready claims, and Torghut
capital work from relying on stale stage state or a hardcoded dead endpoint.

The tradeoff is another admission object. I accept that because the six-month risk is not a missing status field. It
is silent split-brain between healthy rollout badges, stale stage freezes, and scheduled jobs that fail before they can
publish useful evidence.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests, trading
flags, or AgentRun objects.

### Cluster And Rollout

- Local work started on `codex/swarm-jangar-control-plane-discover`, fast-forwarded to `origin/main` at
  `1de3fb0ef` after a clean evidence pass.
- Argo applications `agents`, `jangar`, `torghut`, `symphony-torghut`, and `torghut-options` reported `Synced` and
  `Healthy` at observed revision `e87e3d87d3b8313f408704e2fa9317bb5a679c8e` during the assessment window.
- `deployment/agents` was `1/1` on image `jangar-control-plane:59589242`; `deployment/agents-controllers` was `2/2`
  on image `jangar:59589242`.
- Agents namespace pod status counted `332 Completed`, `92 Error`, `9 Running`, and `2 ContainerStatusUnknown`.
- Jangar-control-plane AgentRun CRs counted `220 Succeeded`, `7 Failed`, and `2 Running`.
- Recent events showed `BackoffLimitExceeded` for scheduled jobs and `/ready` probe timeouts for `agents` and both
  `agents-controllers` pods, even though the deployments later remained available.
- A failed discover cron pod logged `ConnectionRefused` to
  `http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`.

### Source Evidence

- `services/jangar/src/routes/ready.tsx` already composes leader election, controller health, execution trust,
  memory-provider health, runtime kits, admission passports, recovery warrants, proof cells, and projection watermarks.
- `services/jangar/src/routes/health.tsx` still reports `ok` when the serving process has local controllers disabled,
  which is correct for liveness but not sufficient for material action clearance.
- `services/jangar/src/server/control-plane-status.ts` is the current status authority for controller witnesses,
  source-rollout truth, material action verdicts, and Torghut consumer evidence.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule launch behavior and is a high-risk
  integration point. The implementation should add a small pure reducer and call it from schedule admission instead
  of embedding another special case into the large controller.
- `bun run --filter @proompteng/jangar check:module-sizes` passed for 424 files; legacy oversized files stayed within
  baseline caps.

### Database And Data Evidence

- Direct pod exec was forbidden for `system:serviceaccount:agents:agents-sa`, so database evidence used the Jangar
  DB secret locally with a read-only transaction and no secret output.
- The Jangar database exposed schemas `agents_control_plane`, `atlas`, `codex_judge`, `jangar_github`, `memories`,
  `public`, `terminals`, `torghut_control_plane`, and `workflow_comms`; there were 99 non-system tables.
- `workflow_comms.agent_messages` held `16750` rows with newest `created_at=2026-05-08T12:12:13.700Z`.
- `agents_control_plane.resources_current` held `456` succeeded AgentRuns, `19` failed AgentRuns, `8` running
  AgentRuns, and `12` template AgentRuns.
- `agents_control_plane.component_heartbeats` had fresh rows, but the latest `agents-controller` heartbeat reported
  `enabled=false`, `status=disabled`, and `leadership_state=leader`, while the deployment configuration enabled the
  controller.
- `memories.entries` held `1065` rows with newest `created_at=2026-05-08T11:13:21.525Z`; the public memory HTTP
  helper was still refusing connections through the `jangar.jangar` route.

## Problem

Jangar currently has three useful truths that are not settled into one admission decision:

1. Rollout truth: Argo and Kubernetes say the applications and deployments are healthy.
2. Runtime truth: `/ready` says execution trust is degraded by stale stages.
3. Launch truth: scheduled jobs can still use an unroutable Jangar status endpoint and fail before useful work starts.

Those truths create repeated failure modes:

- Cron-driven stages consume a hardcoded or stale control-plane URL.
- Healthy deployment status can hide execution-trust degradation.
- Controller heartbeat rows can disagree with deployment configuration and controller logs.
- Retained AgentRun and pod failures stay mixed with current failures.
- Torghut repair work can see fresh global quant metrics while scoped proof remains degraded.

Jangar needs an admission exchange that answers one question before work launches: is this stage and action class
allowed under the current route, witness, stage-debt, and consumer-evidence facts?

## Alternatives Considered

### Option A: Patch The Scheduled URL And Continue

Change the scheduled jobs to call `agents.agents.svc.cluster.local` and leave the rest of the readiness model alone.

Advantages:

- Smallest implementation.
- Directly addresses the observed `ConnectionRefused` failure.
- Low rollout risk.

Disadvantages:

- Does not classify stage staleness.
- Does not settle controller heartbeat split.
- Lets future route changes recreate the same launch failure.
- Does not give deployers a merge-ready or widen-ready gate.

Decision: reject as the architecture. It is a necessary implementation detail, not the contract.

### Option B: Freeze All Scheduled Work Until Every Witness Is Green

Hold discover, plan, implement, verify, and Torghut repair stages whenever any controller witness or stage freshness
check is degraded.

Advantages:

- Very safe.
- Easy to reason about in an incident.
- Prevents launch fanout during controller uncertainty.

Disadvantages:

- Blocks repair work that could clear the failure.
- Converts endpoint misrouting into broad automation downtime.
- Increases manual intervention because operators must inspect raw pods and status JSON.

Decision: keep as an emergency rollback lever, not the normal architecture.

### Option C: Stage-Clearance Exchange With Scheduler Routability Admission

Generate a current `stage_clearance_packet` per namespace, swarm, stage, and action class. Scheduled runners, deploy
verification, and Torghut capital consumers must cite that packet before work starts.

Advantages:

- Separates serving health, controller witness state, route availability, and stage debt.
- Blocks only the action classes that are unsafe.
- Prevents hardcoded dead endpoints from launching repeated failed jobs.
- Gives engineer and deployer stages a testable acceptance gate.
- Keeps zero-notional repair work possible while normal dispatch and widening stay held.

Disadvantages:

- Adds a reducer, status projection, and tests.
- Requires careful endpoint source-of-truth ordering.
- Adds one more object for operators to inspect.

Decision: select Option C.

## Architecture

Jangar adds a `stage_clearance_packet` projection in shadow mode first:

```text
stage_clearance_packet
  schema_version
  packet_id
  generated_at
  fresh_until
  namespace
  swarm_name
  stage
  action_class
  serving_route_ref
  serving_route_decision
  controller_witness_ref
  controller_witness_decision
  execution_trust_ref
  stage_debt_ref
  consumer_evidence_refs[]
  decision
  reason_codes[]
  required_repair_action
  rollback_target
```

The route resolver chooses the first current route from:

1. An explicit `JANGAR_CONTROL_PLANE_STATUS_URL`.
2. The in-namespace `agents` service.
3. A configured external route.
4. The legacy `jangar.jangar` route only when it is proven routable.

Action decisions are scoped:

- `serve_readonly`: allow when serving route and database are healthy, even if stage debt is degraded.
- `dispatch_repair`: allow when the route is routable and repair is the required action.
- `dispatch_normal`: hold unless stage debt is current and controller witness is fresh.
- `deploy_widen`: hold unless Argo revision, rollout, controller witness, and stage freshness all converge.
- `merge_ready`: hold unless deploy-widen gates are green and retained failures are retired.
- `torghut_capital`: block unless Torghut's profit-signal quorum cites a current packet.

## Implementation Scope

Engineer milestone 1:

- Add a pure stage-clearance reducer under `services/jangar/src/server`.
- Add unit tests for route missing, route current, controller heartbeat split, retained failure debt, repair-only
  dispatch, and merge-ready hold.
- Add a bounded status section to `/ready` or control-plane status without changing liveness semantics.

Engineer milestone 2:

- Update schedule launch generation to resolve the active control-plane status URL and require a current packet before
  launch.
- Emit a concise failure reason to NATS and Jangar when no route is routable.
- Keep an emergency override that freezes all action classes.

Deployer milestone:

- Extend deployment verification to assert a current packet for `deploy_widen` and `merge_ready`.
- Prove Argo app health, workload readiness, `/ready`, packet freshness, and service route health after rollout.

## Validation Gates

- `failed_agentrun_rate`: scheduled launch failures caused by unroutable status endpoints must drop to zero in the
  next measured schedule window.
- `pr_to_rollout_latency`: a green PR may not be called deploy-ready until `deploy_widen` has a current packet.
- `ready_status_truth`: `/health=ok` may continue serving, but `/ready` and control-plane status must name degraded
  stage or witness state.
- `manual_intervention_count`: a failed schedule admission must name the exact repair action instead of requiring pod
  log inspection.
- `handoff_evidence_quality`: every implementation PR must cite this contract and include packet, route, Argo,
  workload, and service-health evidence.

## Rollout

1. Ship the reducer and status projection in shadow mode.
2. Compare packet decisions against existing material action verdicts for at least one schedule window.
3. Enable scheduler admission for observe and repair stages.
4. Enable scheduler admission for normal dispatch after false hold rate is below the agreed threshold.
5. Enable deployer merge-ready and widen-ready checks.

## Rollback

- Disable packet enforcement and return to existing material action verdict behavior.
- Force global schedule freeze if controller witness or route resolution oscillates.
- Revert to the last known working status URL only after proving it is routable from scheduled pods.
- Keep Torghut capital blocked while Jangar packet enforcement is disabled.

## Risks

- Endpoint source-of-truth bugs could hold repair work. Mitigation: route resolver tests and NATS reason codes.
- Heartbeat split may persist. Mitigation: classify as repair-only instead of merge-ready.
- Retained failures may be retired too aggressively. Mitigation: require later successful run evidence for the same
  swarm, stage, and implementation scope.
- Operators may confuse liveness with clearance. Mitigation: keep `/health` and packet decisions separate.

## Handoff

Engineer acceptance:

- A production PR implements the stage-clearance reducer with tests and wires route resolution into scheduled launch
  admission.
- The PR cites this document before changing code.
- The implementation proves no scheduled runner calls an unroutable legacy Jangar status endpoint.

Deployer acceptance:

- After rollout, prove Argo app health, `agents` and `agents-controllers` readiness, Jangar `/ready`, current
  `stage_clearance_packet`, and successful service route checks.
- If any gate fails, hold `deploy_widen`, `merge_ready`, and `torghut_capital` and publish the smallest unblocker.
