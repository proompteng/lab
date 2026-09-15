# 143. Jangar Route-Stable Status Snapshot Escrow And Repair Actuation Windows (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, route-stable status authority, scheduled runner preflight, bounded repair
dispatch, safe rollout, validation, rollback, and Torghut capital handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/147-torghut-stale-proof-repair-exchange-and-route-stable-capital-quorum-2026-05-07.md`

Extends:

- `142-jangar-repair-dividend-handoff-gates-and-actuation-contracts-2026-05-07.md`
- `141-jangar-controller-witness-escrow-and-repair-dividend-settlement-2026-05-07.md`
- `140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`
- `136-jangar-controller-authority-settlement-and-endpoint-parity-ledger-2026-05-07.md`

## Decision

I am selecting **route-stable status snapshot escrow with repair actuation windows** as the next Jangar
control-plane architecture step.

The current cluster is healthier than the May 5 NATS soak. At `2026-05-07T11:09Z`, Jangar `/ready` returned HTTP
`200`, execution trust was healthy, memory provider was healthy, runtime kits were healthy, and the status route
reported a connected database with `28` registered migrations, `28` applied migrations, zero unapplied migrations, zero
unexpected migrations, and `12` ms database latency. The `agents` and `jangar` Argo CD Applications were `Synced` and
`Healthy`, the Jangar namespace deployments were available, and the `agents` namespace swarms were `Active`,
`lights-out`, and `Ready=True`.

The residual failure mode is not general availability. It is action authority during route and controller-witness
transitions. Kubernetes events showed recent readiness probe failures on `jangar`, `agents`, and
`agents-controllers`. Older scheduled Jangar and Torghut quant CronJob pods from roughly six to seven hours earlier
failed, and one sampled Torghut plan runner failed because it could not connect to
`http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`. More recent scheduled
CronJobs completed, which means the system recovered, but the current architecture still treats "route unreachable
during rollout" as a pod failure rather than a bounded status-authority condition.

The status route also showed the deeper ambiguity. Watch reliability was currently healthy with `2,571` events,
`0` errors, and `0` restarts in the last 15 minute window, but material action verdicts still downgraded
`dispatch_normal` to `repair_only` because controller-process witness freshness was missing. In the same response,
some controller and runtime-adapter authority was derived from rollout health rather than from a controller-process
heartbeat. Rollout-derived authority is useful availability evidence. It should not be the same thing as route-stable
actuation authority.

The selected design adds a short-lived status snapshot escrow and a route-stability window. Scheduled runners and
repair dispatches can use a fresh escrowed status snapshot only for observe and zero-notional repair when the live route
is transiently unavailable. Normal dispatch, merge-ready, deploy widening, paper canary, live micro canary, and live
scale require live route reachability plus controller-process witness authority inside the route-stability window.

The tradeoff is stricter action graduation immediately after rollouts. I accept that. The six-month risk is not that
we wait a few minutes before normal dispatch. The risk is that a recovered Deployment and a stable action authority are
treated as identical facts.

## Runtime Objective And Success Metrics

Success means:

- Jangar keeps serving read-only traffic when `/ready`, leader election, runtime kits, and database projection are
  healthy.
- Scheduled discover, plan, implement, and verify runners do not fail on a single transient status-route connection
  refusal during rollout.
- A status snapshot can be consumed only when it is fresh, hash-addressed, tied to a status producer revision, and
  scoped to an action class.
- Escrowed snapshots can allow `serve_readonly`, `torghut_observe`, and bounded zero-notional `dispatch_repair`.
- `dispatch_normal`, `merge_ready`, `deploy_widen`, `paper_canary`, `live_micro_canary`, and `live_scale` require a
  live route and a route-stability window.
- Rollout-derived controller authority can keep repair available, but it cannot graduate normal dispatch by itself.
- The status route exposes live-route attempts, last accepted snapshot, snapshot expiry, route-stability window state,
  action consequences, and rollback target.
- Torghut can cite the Jangar route-stability window when deciding whether a profit repair can be observed, repaired,
  paper-tested, or live-submitted.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, GitOps
resources, trading flags, AgentRun objects, or empirical artifacts.

### NATS Context

The latest branch-level NATS soak contained the May 5 evidence-clock baseline: Jangar serving was up while execution
trust and stages were stale, scheduled swarm CronJobs had failed from a Bun inline import parse error, workspace PVC
watching was failing, and Torghut had healthy schema checks but stale market-context domains. Later NATS updates said
the evidence-clock arbiter design was drafted and committed. I treated that as historical context and measured the
current runtime state before selecting this design.

### Cluster, Rollout, And Event Evidence

- `deployment/jangar` was available `1/1` on image
  `registry.ide-newton.ts.net/lab/jangar:a42a5d61@sha256:004b08ba8b01129289f260b09254a7508efa9a0a88d46034d8a5452de00b331e`.
- `deployment/agents` was available `1/1` on image
  `registry.ide-newton.ts.net/lab/jangar-control-plane:a42a5d61@sha256:2efa45e94d0bf04520d2ee1e25e5243263ed1ece67b937c69a1b0941aa789819`.
- `deployment/agents-controllers` was available `2/2` on image
  `registry.ide-newton.ts.net/lab/jangar:a42a5d61@sha256:004b08ba8b01129289f260b09254a7508efa9a0a88d46034d8a5452de00b331e`.
- `deployment/bumba`, `deployment/jangar-alloy`, `deployment/symphony`, and `deployment/symphony-jangar` were also
  available.
- `kubectl get swarms -n agents` reported `jangar-control-plane` and `torghut-quant` as `Active`, `lights-out`, and
  `Ready=True`.
- Argo CD reported `agents` and `jangar` as `Synced` and `Healthy` at revision
  `3c7e24de3b9085531cd47cd28955045ddb68860d`.
- Argo CD reported `torghut` as `OutOfSync` and `Healthy`, which is rollout-risk evidence for downstream capital.
- Recent Jangar events included readiness probe failures for old and current `jangar` pods during startup.
- Recent `agents` events included readiness timeouts for `agents`, readiness timeouts for both controller pods, one
  controller liveness failure, and recovery.
- Scheduled Jangar and Torghut quant CronJobs were active and unsuspended. Older CronJob pods from about six to seven
  hours earlier remained in `Error`, while recent scheduled runs completed.
- A sampled failed Torghut plan pod exited on a Jangar status-route connection refusal, not on a trading proof failure.

### Jangar Route And Database Evidence

- `GET http://jangar.jangar.svc.cluster.local/ready` returned HTTP `200` with `status=ok`.
- `/ready` reported leader election healthy, execution trust healthy, serving and collaboration runtime kits healthy,
  and fresh admission passports for serving, swarm plan, swarm implement, and swarm verify.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` returned
  `generated_at=2026-05-07T11:09:12.122Z`.
- Database projection was healthy: configured, connected, `latency_ms=12`, migration table `kysely_migration`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, `unexpected_count=0`, latest registered migration
  `20260505_torghut_quant_pipeline_health_window_index`, and latest applied migration with the same name.
- Watch reliability was healthy with a 15 minute window, two observed streams, `2,571` total events, `0` errors, and
  `0` restarts.
- Controller status was healthy, but authority for `agents-controller`, `supporting-controller`, workflow runtime, and
  job runtime was sometimes rollout-derived. Orchestration-controller heartbeat was fresh.
- Material action verdicts allowed `serve_readonly`, `dispatch_repair`, `deploy_widen`, `merge_ready`, and
  `torghut_observe`, downgraded `dispatch_normal` to `repair_only`, held `paper_canary`, held `live_micro_canary`, and
  blocked `live_scale`.
- `dispatch_normal` required repairs to publish a fresh controller-process ingestion witness and a fresh
  controller-process witness.
- Direct CNPG shell inspection was not available from this runner. `kubectl cnpg psql -n jangar jangar-db -- -c ...`
  failed because the service account cannot create `pods/exec` in namespace `jangar`. The design therefore relies on
  typed route evidence and source schema artifacts, not privileged database shells.

### Torghut Consumer Evidence

- `GET http://torghut.torghut.svc.cluster.local/readyz` returned `status=degraded`.
- Scheduler, Postgres, ClickHouse, Alpaca, Jangar universe, readiness cache, empirical jobs, and quant evidence were
  individually reachable or informational.
- Alpaca account label `PA3SX7FYNUTF` was `ACTIVE`.
- Live submission was closed by `simple_submit_disabled` with `capital_stage=shadow`.
- Profitability proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and max
  notional `0`.
- Proof-floor blockers included `hypothesis_not_promotion_eligible`, `execution_tca_stale`,
  `market_context_stale`, and `simple_submit_disabled`.
- Execution TCA was stale from `2026-04-02T20:59:45.136640Z`, with `13,775` orders, average absolute slippage about
  `568.61` bps, and an `8` bps slippage guardrail.
- Quant latest metrics were fresh, but ingestion-stage lag was `62,654` seconds for the live account/window.
- Forecast authority was degraded with `registry_empty`; LEAN authority was disabled as a deterministic scaffold.
- Alpha readiness had `3` hypotheses, `0` promotion eligible, and `3` requiring rollback.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `781` lines and is the aggregation boundary for controllers,
  database projection, runtime adapters, execution trust, watch reliability, runtime kits, failure-domain leases,
  negative evidence, empirical services, action clocks, and material action receipts.
- `services/jangar/src/server/control-plane-action-clock.ts` is `276` lines and already turns failure-domain leases and
  empirical service state into action clocks.
- `services/jangar/src/server/control-plane-controller-witness.ts` is `444` lines and models controller-process,
  rollout, watch, and AgentRun ingestion evidence.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is `473` lines and already resolves action
  consequences from dependency quorum, negative evidence, action clocks, rollout health, controller witness, database,
  watch reliability, and empirical services.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and already names Torghut
  consumer gaps, forecast degradation, watch reliability, workflow failures, source schema gaps, and controller
  witness splits.
- `services/jangar/src/server/supporting-primitives-controller.ts` is `3,301` lines and owns high-risk schedule
  runner, CronJob, workspace, swarm, and requirement dispatch behavior. Route-stability rules should not be embedded
  directly in that file.
- Focused tests exist for control-plane status, action clocks, controller witness, watch reliability, negative
  evidence, runtime admission, heartbeat store, heartbeat publisher, and Torghut control surfaces.
- The missing fixture is a route-stability reducer that starts with a live status-route failure, consumes a fresh
  snapshot for repair-only work, and refuses normal dispatch until live route and controller-process witness authority
  recover.

## Problem

Jangar now separates serving health from material action health, but scheduled runners and downstream consumers still
need a durable way to distinguish transient route unavailability from missing action authority.

The current failure modes are:

1. **Route transients become pod failures.** A scheduled runner can fail immediately on a status-route connection
   refusal even when a fresh status snapshot would safely allow observe or repair.
2. **Rollout-derived authority can be overread.** Available Deployments are useful evidence, but they should not
   graduate normal dispatch when controller-process witness freshness is missing.
3. **Snapshot freshness is implicit.** Consumers can read live route fields, but there is no hash-addressed snapshot
   escrow with action-class scope and expiry.
4. **Repair and capital need different route contracts.** Repair can proceed under a bounded snapshot during a route
   transient. Paper and live capital need a live route plus fresh controller-process witness authority.
5. **Least-privilege validation is the operating model.** Routine validation cannot depend on `pods/exec`, secret
   reads, or manual database shells.

## Alternatives Considered

### Option A: Fail Fast When The Status Route Is Unreachable

Pros:

- Simple runner behavior.
- Avoids using stale evidence.
- Keeps failure visible.

Cons:

- Turns rollout-time route blips into scheduled job failures.
- Prevents bounded repair work exactly when repair evidence is needed.
- Does not separate observe/repair authority from normal dispatch or capital authority.

Decision: reject.

### Option B: Treat Healthy Rollout As Sufficient Controller Authority

Pros:

- Uses evidence already available from Kubernetes.
- Keeps scheduled work moving after pod recovery.
- Avoids adding another status reducer.

Cons:

- Repeats the risky conflation between Deployment availability and controller-process witness truth.
- Can graduate normal dispatch before AgentRun ingestion or controller-process heartbeat is current.
- Gives Torghut a misleading signal for capital gates.

Decision: reject.

### Option C: Route-Stable Status Snapshot Escrow And Repair Actuation Windows

Pros:

- Keeps serving, observe, and bounded repair available through short route transients.
- Requires live route and controller-process witness authority before normal dispatch, deploy widening, merge-ready, or
  capital actions.
- Gives scheduled runners deterministic preflight behavior instead of single-attempt failures.
- Produces one status artifact Torghut can cite when ranking profit repairs.
- Fits the least-privilege evidence model because it uses route, status, and Kubernetes object evidence.

Cons:

- Adds a reducer and a status payload.
- Requires expiry and replay rules so stale snapshots do not become authority.
- May keep normal dispatch held for a few minutes after otherwise healthy rollouts.

Decision: select Option C.

## Architecture

Jangar emits one route-stability escrow per namespace and status window.

```text
route_stability_escrow
  escrow_id
  namespace
  generated_at
  fresh_until
  status_snapshot_ref
  status_snapshot_hash
  status_producer_revision
  live_route_attempts[]
  last_live_route_success_at
  last_live_route_error
  route_stability_window
  controller_witness_ref
  database_projection_ref
  watch_reliability_ref
  material_action_contracts[]
  rollback_target
```

The route-stability window is intentionally stricter than serving readiness.

```text
route_stability_window
  state                 # stable, escrow_repair_only, unstable, unknown
  started_at
  stable_after
  expires_at
  live_route_success_count
  required_success_count
  controller_authority_mode
  allowed_action_classes[]
  held_action_classes[]
  blocked_action_classes[]
  reason_codes[]
```

Action consequences are explicit.

```text
material_action_contract
  action_class
  route_requirement       # live_required, escrow_allowed, none
  controller_requirement  # heartbeat_required, rollout_ok_for_repair, none
  decision
  max_dispatches
  max_runtime_seconds
  max_notional
  required_repairs[]
  snapshot_ref
  live_route_ref
  rollback_target
```

Rules:

1. `serve_readonly` may use serving readiness and does not require route-stable actuation authority.
2. `torghut_observe` may use a fresh snapshot when live route is unavailable, with max notional `0`.
3. `dispatch_repair` may use a fresh snapshot only when the repair lease targets route, controller, watch, storage,
   workflow, or Torghut consumer evidence and max notional is `0`.
4. `dispatch_normal` requires live route success and controller-process heartbeat authority. Rollout-derived authority
   alone downgrades it to `repair_only`.
5. `merge_ready` and `deploy_widen` require live route success, database projection healthy, source schema healthy,
   rollout healthy, and no current route connection-refused evidence in the stability window.
6. `paper_canary`, `live_micro_canary`, and `live_scale` require live route success, Jangar actuation allow, Torghut
   proof quorum, and no stale snapshot fallback.
7. A snapshot can only be consumed before `fresh_until` and only for the action classes listed in the snapshot.
8. A live route failure after a snapshot is consumed reverts the window to `escrow_repair_only` or `unstable` depending
   on action class.
9. A route-stability escrow is not durable capital authority. It is a short-lived repair and scheduling aid.

## Implementation Scope

Engineer lane:

1. Add a pure reducer such as `services/jangar/src/server/control-plane-route-stability-escrow.ts`.
2. Feed the reducer from control-plane status route attempts, controller witness, database projection, watch
   reliability, material action verdicts, and rollout health.
3. Add a status field `route_stability_escrow` and include escrow refs in material action activation receipts.
4. Update scheduled runner preflight to retry the live status route with jitter, then consume only eligible snapshot
   authority for observe and repair.
5. Keep `dispatch_normal`, `merge_ready`, `deploy_widen`, and Torghut capital actions on live route authority.
6. Add tests covering route connection refusal, stale snapshot expiry, rollout-derived controller authority,
   heartbeat recovery, and capital quarantine.

Implementation note: shadow status projection (2026-05-07).

- `services/jangar/src/server/control-plane-route-stability-escrow.ts` now implements the reducer as a pure status
  projection outside `supporting-primitives-controller.ts`.
- `/api/agents/control-plane/status` includes `route_stability_escrow` with the live route attempt, status snapshot
  hash, controller witness ref, database/watch refs, route-stability window, and one material-action contract per action
  class.
- Fresh snapshot fallback is shadow-scoped to `serve_readonly`, `dispatch_repair`, and `torghut_observe`; normal
  dispatch becomes `repair_only`, deploy and merge hold, paper and live capital hold or block, and stale snapshots
  remove non-serving fallback authority.
- Rollout-derived controller authority keeps bounded repair visible but does not graduate `dispatch_normal`,
  `merge_ready`, or `deploy_widen`; those require live route success plus controller-process witness authority.
- Material action activation receipts cite the escrow id through `route_stability_escrow_ref` and transport refs, giving
  deployer and Torghut consumers one compact shadow artifact to compare before any runner or capital enforcement.
- Rollback for this slice is to ignore `route_stability_escrow` and continue consuming existing material-action
  receipts; no Kubernetes resource mutation, data migration, or schedule admission change is required.

Deployer lane:

1. Roll out the reducer in shadow mode.
2. Compare shadow action consequences with current material action receipts for one scheduled cycle per lane.
3. Enable runner preflight snapshot fallback only for observe and repair.
4. Enable normal dispatch live-route enforcement only after the shadow window has zero false allows.
5. Keep paper/live capital enforcement blocked until Torghut emits a matching route-stable capital quorum.

## Validation Gates

Local validation:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-route-stability-escrow.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-material-action-verdict.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-controller-witness.test.ts`
- `bun run --cwd services/jangar lint`
- `bun run --cwd services/jangar tsc`
- `bun run --cwd services/jangar check:module-sizes`

Cluster validation:

- `curl -sS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents | jq '.route_stability_escrow'`
- `kubectl get events -n agents --field-selector type!=Normal --sort-by=.lastTimestamp`
- `kubectl get cronjobs -n agents`
- `kubectl get pods -n agents`
- Confirm a simulated status-route connection refusal permits only `serve_readonly`, `torghut_observe`, and bounded
  `dispatch_repair`.
- Confirm normal dispatch remains `repair_only` when controller authority is rollout-derived.
- Confirm normal dispatch can graduate only after live route success and controller-process heartbeat authority.

## Rollout

1. Shadow: emit `route_stability_escrow` with no consumer behavior change.
2. Runner observe: allow scheduled observe and zero-notional repair runners to consume fresh snapshots after live route
   retry exhaustion.
3. Dispatch gate: require live route plus controller-process witness for normal dispatch.
4. Deploy gate: require route-stable window for deploy widening and merge-ready.
5. Capital handoff: allow Torghut to consume the route-stable window for repair ranking, while paper/live remain
   blocked until Torghut quorum also passes.

## Rollback

Rollback is a configuration rollback, not a data deletion:

- Stop consuming snapshot fallback in scheduled runners.
- Keep emitting `route_stability_escrow` in shadow for incident analysis.
- Return normal dispatch, deploy, merge, and capital authority to the existing material action receipt behavior.
- Preserve status snapshots and route-attempt evidence for postmortem and repair dividend accounting.
- If snapshot emission itself creates route pressure, disable only the snapshot field and keep existing `/ready` and
  control-plane status fields.

## Risks

- Snapshot fallback can be overused if expiry is too long. Keep initial freshness at five minutes or less and never use
  snapshots for capital.
- Jittered retries can hide persistent route failures. Emit live-route attempt counts and last error in every escrow.
- Rollout-derived authority can still be useful. Preserve it as repair evidence, but do not allow it to graduate normal
  dispatch alone.
- Status payload growth can make routes slower. Keep snapshot refs compact and store bulky evidence elsewhere.
- Torghut may try to treat a route-stable repair window as paper authority. The companion contract explicitly forbids
  that.

## Handoff To Engineer

Implement the reducer outside `supporting-primitives-controller.ts`. Treat it like the existing action-clock and
material-verdict reducers: pure inputs, deterministic outputs, fixtures before wiring, and route integration last.

Acceptance gates:

- Unit fixture: live route connection refused, fresh snapshot exists, `dispatch_repair=allow`, `dispatch_normal=repair_only`.
- Unit fixture: stale snapshot exists, live route refused, all non-serving actions hold or block.
- Unit fixture: controller authority rollout-derived, live route healthy, normal dispatch remains `repair_only`.
- Unit fixture: controller heartbeat current, live route stable, database and watch healthy, normal dispatch can allow.
- Status fixture: material action activation receipts include route escrow refs and rollback targets.
- Runner fixture: snapshot fallback is impossible for `paper_canary`, `live_micro_canary`, and `live_scale`.

## Handoff To Deployer

Deployer should not enable enforcement in one step. First confirm shadow parity, then enable observe and repair
snapshot fallback, then normal dispatch live-route enforcement.

Acceptance gates:

- One full scheduled cycle for Jangar discover, plan, implement, verify, and Torghut quant lanes completes without
  route-refusal pod failures.
- During a controlled route refusal, runner logs show snapshot fallback only for observe or repair.
- `route_stability_escrow.route_stability_window.state=stable` before deploy widening and merge-ready.
- Torghut stays `capital_state=zero_notional` while route fallback, forecast degradation, stale TCA, stale market
  context, or zero promotion eligibility persists.
- Rollback disables fallback without deleting status evidence.
