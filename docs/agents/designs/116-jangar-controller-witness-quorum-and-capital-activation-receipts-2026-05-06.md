# 116. Jangar Controller Witness Quorum And Capital Activation Receipts (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane controller authority, action SLO provenance, Torghut capital activation, rollout widening,
and proof-repair admission.

Companion Torghut contract:

- `docs/torghut/design-system/v6/120-torghut-capital-activation-receipts-and-shadow-profit-proof-queue-2026-05-06.md`

Extends:

- `114-jangar-evidence-transport-ledger-and-watch-restart-circuit-breakers-2026-05-06.md`
- `113-jangar-contradiction-settlement-and-profit-repair-auction-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`

## Decision

I am selecting a **controller witness quorum with material-action activation receipts** as the next Jangar
control-plane architecture step.

The cluster is no longer in the earlier failure posture. In the read-only sample at `2026-05-06T12:23Z`, Argo CD
reported `agents`, `jangar`, and `torghut` as `Synced` and `Healthy` at revision
`54f5a353c5481f1ac2c54866499d035bef74b37b`. Jangar `/ready` returned HTTP `200`, the Jangar DB projection was
healthy with `28/28` Kysely migrations applied, dependency quorum returned `allow`, watch reliability was healthy with
`5` streams, `3459` events, `0` errors, and `0` restarts, and the agents rollout was available with
`deployment/agents=1/1` and `deployment/agents-controllers=2/2`.

The problem is not basic liveness. The problem is authority provenance. The Jangar status service still emitted
`agentrun_ingestion.status=unknown` with message `agents controller not started`, which caused the negative-evidence
router to put `dispatch_normal` into `repair_only`, even though Kubernetes showed the controller deployment available
and the status service's own watch reliability sample was healthy. That is a process-topology split: the serving
process is not the controller process, but its local controller health value is still being used as action authority.

Torghut exposed the matching capital split. Live `/readyz` and `/trading/health` returned HTTP `503` with
`simple_submit_disabled`, stale empirical jobs, and `quant_health_not_configured`. Sim `/readyz` was `ok`, but its
typed quant proof was degraded because `latestMetricsCount=0` for `TORGHUT_SIM`. Jangar's market-context health for
`AAPL` was `down`, ClickHouse-backed market-context ingestion was not configured in that route, and the quant alerts
route still had `50` open alerts, `37` critical. Paper observation is useful; capital activation is not ready.

The selected design makes controller authority and capital activation separately receipted. Jangar must not infer
controller freshness from a serving-process boolean alone, and Torghut must not infer paper or live readiness from a
route being reachable. Material actions require receipts that cite the controller witnesses, route contracts, proof
freshness, capital stage, max notional, rollback target, and expiry.

The tradeoff is more ceremony before widening and capital. I accept that. The next six-month failure mode is a locally
green service turning stale, disabled, or process-local evidence into material authority. We need a small, explicit
receipt that says which witness made the decision and which proof debt remains.

## Evidence Snapshot

All checks for this decision were read-only. I did not mutate Kubernetes resources, database rows, broker flags, Argo
applications, or trading records.

### Cluster And Rollout Evidence

- Runtime identity was `system:serviceaccount:agents:agents-sa`.
- Branch was `codex/swarm-jangar-control-plane-plan`, based on `main`.
- `kubectl config current-context` was unset, but API auth succeeded as the mounted service account.
- Jangar namespace pods were running, including `jangar-f8c6b9bd9-nw52c`, `jangar-db-1`, Bumba, Redis, Open WebUI,
  Alloy, Symphony, and `symphony-jangar`.
- `deployment/jangar` was `1/1` available on
  `registry.ide-newton.ts.net/lab/jangar:89d740d3@sha256:c897e060175fd53ae055ad4a4f2f1ceeae5d3ae3e97d130c7d556af096d2e035`.
- `deployment/agents` was `1/1` and `deployment/agents-controllers` was `2/2` available on the same rollout family.
- The agents namespace still carried retained execution debt: `155` Completed pods, `33` Error pods, and `9` Running
  pods in the phase sample.
- Recent agents events showed a clean new rollout, but also readiness `503` misses on the old controller ReplicaSet
  during scale-down. The current ReplicaSet was available.
- Argo CD reported `agents`, `jangar`, and `torghut` `Synced` and `Healthy` at
  `54f5a353c5481f1ac2c54866499d035bef74b37b`; the prior Torghut OutOfSync condition had recovered.
- Torghut live revision `torghut-00237` and sim revision `torghut-sim-00323` were running. ClickHouse, Keeper,
  Postgres, live TA, sim TA, options catalog, options enricher, websocket, Alloy, and Symphony pods were running.
- Recent Torghut events showed the rollout settling, completed backfill/bootstrap jobs, and transient readiness misses
  while old revisions and options pods were replaced.

### Database And Data Evidence

- Direct `kubectl cnpg psql` read probes for Jangar and Torghut failed because this service account cannot create
  `pods/exec` in those namespaces. Direct ClickHouse HTTP returned `401`. That RBAC boundary is correct; routine
  verification must use service-owned projections.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported database `configured=true`, `connected=true`,
  `status=healthy`, `latency_ms=3`, and migration consistency `28/28` with latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar dependency quorum returned `decision=allow`, while action SLO budgets downgraded `dispatch_normal` to
  `repair_only` for `agentrun_ingestion_unknown`.
- Jangar failure-domain leases were all valid in shadow and allowed `serve_readonly`, `dispatch_normal`,
  `dispatch_repair`, `deploy_widen`, `merge_ready`, `torghut_observe`, and `torghut_capital`.
- Jangar negative evidence included `agentrun_ingestion_unknown` and `empirical_jobs_disabled`; paper canary was held,
  live micro-canary was blocked, and live scale was blocked.
- Torghut `/db-check` returned HTTP `200`, `schema_current=true`, `schema_graph_lineage_ready=true`, and
  `account_scope_ready=true`.
- Torghut live `/readyz` and `/trading/health` returned HTTP `503` with `simple_submit_disabled`,
  `quant_health_not_configured`, stale empirical proof, and zero promotion-eligible hypotheses.
- Torghut sim `/readyz` returned `status=ok` and `live_submission_gate.allowed=true` for non-live mode, but its quant
  proof was degraded: `latestMetricsCount=0`, `emptyLatestStoreAlarm=true`, and no pipeline stages.
- Jangar typed quant health for live account `PA3SX7FYNUTF` was routable, but the latest metrics were from
  `2026-05-05T17:28:03.839Z`, lagging the sample by `68122` seconds.
- Jangar market-context health for `AAPL` returned `overallState=down`, with technicals and regime source errors,
  fundamentals and news missing, and ClickHouse ingestion reporting `CH_HOST is not configured`.
- Jangar quant alerts had `50` open alerts: `37` critical and `13` warning.
- Torghut empirical jobs were stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`, all tied to dataset `torghut-full-day-20260318-884bec35`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` builds dependency quorum, failure-domain leases, negative
  evidence, action SLO budgets, and agent-run ingestion in one status route.
- `services/jangar/src/server/agents-controller/index.ts` returns `agentrun_ingestion.status=unknown` and message
  `agents controller not started` when `health.started` is false. That is correct inside a controller process, but
  ambiguous when served by a separate status process.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` treats any non-healthy AgentRun ingestion
  state as current runtime negative evidence and maps it to "restore AgentRun ingestion freshness."
- `services/jangar/src/server/control-plane-watch-reliability.ts` already proves watch freshness independently and was
  healthy in the current sample. It is a stronger witness than a local controller-start flag for this topology.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains the highest-risk Jangar module at `2883`
  lines and owns schedule generation, runner ConfigMaps, CronJobs, swarm admission, requirements, freezes, workspace
  state, and PVC lifecycle.
- `services/torghut/app/main.py` is `4051` lines and assembles `/readyz`, `/db-check`, `/trading/health`,
  `/trading/status`, `/trading/autonomy`, decisions, executions, and data projections.
- `services/torghut/app/trading/submission_council.py` builds live submission gates from dependency quorum,
  empirical jobs, DSPy runtime, quant health, market context, and toggle parity.
- Focused tests exist for Jangar control-plane status, watch reliability, negative evidence, failure-domain leases,
  Torghut empirical jobs, quant health, market context, and submission gates. The missing system-level test is witness
  arbitration across serving process, controller deployment, controller self-report, watch epoch, and action budget.

## Problem

Jangar has accumulated enough local evidence producers that "status says degraded" is no longer precise enough.

The current control plane has five true statements:

1. The serving process is healthy and can produce a status payload.
2. The controller deployment is available and current.
3. The serving process does not have a started controller in its own memory.
4. Watch reliability is healthy and shows current events.
5. Action budgets can still downgrade dispatch because the local controller-start field is unknown.

Those statements should not collapse into either "everything is fine" or "freeze normal dispatch." They should produce
a witness result: controller self-report missing from this process, external controller deployment available, watch
epoch current, action impact `repair_only` until the controller process emits its own ingestion receipt or the status
service consumes the controller witness directly.

Torghut has the same shape. Live, paper, sim, market context, quant health, empirical jobs, and DB checks each produce
truthful local facts. A capital action needs one activation receipt that names which facts were used, which are stale or
disabled, and why the notional cap is `0` or non-zero.

## Alternatives Considered

### Option A: Trust The Serving Status Process As Final Authority

Pros:

- Smallest implementation.
- Keeps all material-action decisions inside the existing status route.
- Matches the current API shape.

Cons:

- Confuses process-local controller state with the deployed controller fleet.
- Can downgrade dispatch after a healthy controller rollout if the serving process is intentionally not the controller.
- Gives deployers no receipt explaining the witness split.

Decision: reject. The serving process remains a producer, not final controller authority.

### Option B: Trust Kubernetes Deployment Availability As Final Authority

Pros:

- Removes the false "controller not started" downgrade when `agents-controllers` is available.
- Easy for deployers to inspect.
- Avoids coupling the status service to controller internals.

Cons:

- Deployment availability does not prove AgentRun ingestion, watch events, or reconciler progress.
- It can be green while the controller is stale, wedged, or not observing new runs.
- It does not solve Torghut capital proof activation.

Decision: reject as final authority. Deployment availability is a witness, not a receipt.

### Option C: Controller Witness Quorum With Material-Action Activation Receipts

Pros:

- Separates serving health, controller deployment health, controller self-report, and watch freshness.
- Produces one material-action receipt that deployers can cite for dispatch, merge, deploy widening, paper, and live
  capital.
- Converts stale or disabled proof systems into scoped repair requirements rather than broad ambiguity.
- Gives Torghut a clear activation ladder: observe, shadow repair, paper canary, live micro-canary, live scale.

Cons:

- Adds one more reducer and receipt type.
- Requires controller processes to publish a stable witness or for status to consume a controller-owned projection.
- Requires deployer discipline: pod availability is not enough for material actions.

Decision: select Option C.

## Architecture

Jangar adds two projections.

```text
control_plane_controller_witness
  witness_id
  generated_at
  expires_at
  namespace
  controller_surface            # serving_process, controller_process, kubernetes_deployment, watch_epoch
  deployment_ref
  pod_uid
  image_ref
  leader_identity
  controller_started
  deployment_available
  watch_epoch_id
  ingestion_epoch_id
  last_watch_event_at
  last_resync_at
  observed_run_count
  untouched_run_count
  decision                      # allow, allow_with_split, repair_only, hold_material, block
  reason_codes
```

```text
material_action_activation_receipt
  receipt_id
  generated_at
  expires_at
  action_class                  # dispatch_normal, dispatch_repair, deploy_widen, merge_ready,
                                # torghut_observe, paper_canary, live_micro_canary, live_scale
  scope                         # namespace, swarm, PR, rollout digest, account, strategy, window, hypothesis
  controller_witness_refs
  transport_contract_refs
  proof_freshness_refs
  positive_authority_refs
  negative_authority_refs
  capital_stage                 # none, observe, shadow, paper, live_micro, live_scale
  decision                      # allow, observe_only, repair_only, hold, block
  max_dispatches
  max_runtime_seconds
  max_notional
  required_repairs
  rollback_target
```

Rules:

- `serve_readonly` can use the serving process witness plus DB and runtime-kit evidence.
- `dispatch_repair` can proceed with an external controller deployment witness and current watch epoch, even when the
  serving process lacks controller self-report, if max notional is `0`.
- `dispatch_normal` requires either a healthy controller-process ingestion witness or a quorum of deployment
  availability, current watch epoch, and recent resync.
- `deploy_widen` and `merge_ready` require a receipt that names the controller witness split and the rollback target.
- `paper_canary` requires Jangar action budgets, Torghut sim health, non-empty scoped quant latest metrics, empirical
  job endpoint availability, and market-context closure receipts for the hypothesis universe.
- `live_micro_canary` requires live `/readyz=200`, live `/trading/health=200`, live quant health configured and fresh,
  no critical quant alerts for the target account/window, paper canary closure, broker reconciliation, and human rollout
  window.
- `live_scale` is out of scope until live micro-canary receipts pass across multiple market sessions.

## Implementation Scope

Jangar engineer scope:

- Add a pure witness reducer that accepts serving-process controller health, controller deployment status, watch
  reliability, and AgentRun ingestion state.
- Extend `/api/agents/control-plane/status` with `control_plane_controller_witness` and current
  `material_action_activation_receipt` records.
- Change negative-evidence routing so `agentrun_ingestion_unknown` from a non-controller serving process becomes a
  witness split, not automatically final dispatch authority.
- Add route tests for a healthy `agents-controllers` deployment plus healthy watch epoch plus missing serving-process
  controller self-report producing `dispatch_repair=allow` and `dispatch_normal=repair_only`.
- Add route tests for true controller ingestion stall producing `dispatch_normal=hold_material`.

Torghut engineer scope:

- Emit activation-receipt inputs from `/readyz`, `/trading/health`, `/trading/autonomy`, typed quant health, market
  context, and empirical jobs.
- Distinguish disabled proof systems from stale proof systems in the receipt. Disabled proof requires configuration
  repair; stale proof requires replay or backfill.
- Keep paper and live notional at `0` until the receipt for the exact account, strategy, window, hypothesis, and market
  session allows more.

Deployer scope:

- Treat deployment availability as one witness, not the whole gate.
- Before widening or merging, cite the activation receipt id, controller witness ids, action decision, rollback target,
  and expiry.
- Before any Torghut paper or live capital step, cite the receipt for the exact account/window and the max notional.

## Validation Gates

Engineer acceptance:

- Unit tests cover `serving_process_only`, `deployment_only`, `watch_epoch_only`, `controller_self_report_current`, and
  `controller_ingestion_stalled` witness cases.
- Route tests prove status exposes witness ids, receipt ids, action decisions, expiry, and rollback target.
- Tests prove a non-controller serving process does not turn `health.started=false` into a hard controller failure when
  deployment and watch witnesses are current.
- Tests prove true untouched AgentRuns above the threshold still hold normal dispatch.
- Torghut tests prove disabled empirical jobs, stale empirical jobs, empty sim quant latest metrics, live quant not
  configured, market-context down, and open critical alerts produce distinct receipt repairs.

Deployer acceptance:

- A deployer can show `dispatch_normal=repair_only` with the reason `controller_witness_split` while
  `dispatch_repair=allow`.
- A deployer can show `deploy_widen` and `merge_ready` receipts before widening Jangar or Torghut.
- A deployer can show paper capital is held until empirical proof, sim quant latest metrics, and market-context receipts
  are current.
- A deployer can show live capital is blocked while live `/readyz` is `503` or live submission is disabled.

Profit acceptance:

- Within two market sessions of implementation, the top activation repairs should either reduce open critical quant
  alerts by at least `50%` or publish receipt debt explaining why each remaining alert is still valid.
- The first paper canary receipt must cite current empirical jobs, non-empty sim quant metrics, market-context health,
  and a post-cost expected edge hypothesis.
- Live capital remains disabled until a paper canary closes with PnL, TCA, broker reconciliation, and rollback
  rehearsal evidence.

## Rollout Plan

1. Ship controller witnesses and activation receipts in shadow mode inside Jangar status.
2. Wire the negative-evidence router to consume witness decisions without enforcing new holds.
3. Teach Torghut live and sim routes to echo activation-receipt inputs while keeping existing gates unchanged.
4. Require receipt visibility for deployer handoff before enforcing receipt decisions.
5. Enforce receipt decisions for `dispatch_normal`, `merge_ready`, and `deploy_widen` after seven healthy witness epochs.
6. Enforce paper capital receipts after empirical proof and sim quant latest metrics are configured and current.
7. Enforce live micro-canary receipts only after paper closure, broker reconciliation, TCA, and rollback rehearsal.

## Rollback Plan

- Disable receipt enforcement with a feature flag and return to dependency quorum, failure-domain leases, and existing
  submission gates.
- Keep writing shadow witnesses and receipts during rollback for comparison.
- If witness quorum is noisy, enforce only true controller ingestion stalls and leave serving/controller process splits
  as warnings.
- If Torghut activation receipts block too much, keep `max_notional=0` and allow only observe and repair receipts until
  proof producers stabilize.

## Risks

- Witness quorum can hide a real controller failure if deployment availability is over-weighted. Mitigation: require
  current watch or resync evidence for normal dispatch.
- Receipts can become another broad status object. Mitigation: every receipt must name action class, scope, max
  notional, expiry, and rollback target.
- Disabled empirical jobs may be treated as less serious than stale jobs. Mitigation: disabled proof blocks capital and
  creates configuration repair debt.
- Paper mode can look safe because notional is not live. Mitigation: paper canary still requires current proof and
  closure receipts before live promotion.

## Handoff

Engineer stage should implement witness reduction first, then activation receipts. Keep the first slice pure and
fixture-backed before adding persistence or enforcement.

Deployer stage should stop using pod availability alone for material actions. The handoff gate is an activation receipt
with controller witness ids, proof refs, decision, max notional, rollback target, and expiry.
