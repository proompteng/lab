# 129. Jangar Heartbeat Lane Escrow And Material Verdict Stability (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar controller heartbeat authority, AgentRun ingestion witnesses, material action verdict stability, Torghut
capital receipt consumption, least-privilege validation, rollout convergence, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/133-torghut-stable-jangar-receipts-and-closed-session-capital-hold-2026-05-06.md`

Extends:

- `128-jangar-runtime-convergence-ledger-and-capital-gate-receipts-2026-05-06.md`
- `128-jangar-terminal-run-settlement-and-forecast-reentry-admission-2026-05-06.md`
- `121-jangar-controller-witness-uplink-and-proof-renewal-train-2026-05-06.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`

## Decision

I am selecting **heartbeat lane escrow with material verdict stability windows** as the next Jangar control-plane
architecture step.

The live system is no longer in the May 5 degraded state. In the read-only sample between `2026-05-06T20:08Z` and
`2026-05-06T20:14Z`, Jangar was serving, `deployment/jangar` was `1/1`, `deployment/agents` was `1/1`,
`deployment/agents-controllers` was `2/2`, and Jangar `/ready` returned `status=ok`. The control-plane status route
reported healthy execution trust, healthy database migration consistency through
`20260505_torghut_quant_pipeline_health_window_index`, healthy watch reliability with more than `5700` AgentRun watch
events and zero errors in the 15-minute window, and healthy controller heartbeat authority from
`agents-controllers-b8b789d4f-2lqtl`.

The weak point is more subtle and more dangerous than a missing rollout. The heartbeat store is a last-writer-wins
projection keyed by `(cluster, namespace, component, workload_role)`. A direct read of
`agents_control_plane.component_heartbeats` at `2026-05-06T20:14:16Z` showed the `controllers` lane rows overwritten
by the serving deployment `jangar-6b665898b9-jk27d`: `agents-controller`, `supporting-controller`, and
`workflow-runtime` were `disabled`, while `orchestration-controller` was `healthy`. Seconds earlier, the route-level
status had selected fresh controller heartbeats from `agents-controllers-b8b789d4f-2lqtl`, produced
`control_plane_controller_witness.decision=allow_with_split`, and allowed `dispatch_normal`, even though
`agentrun_ingestion.status=unknown` with message `agents controller not started`.

That is an authority instability, not a cosmetic inconsistency. A material action verdict cannot be allowed to depend
on whichever writer most recently touched a shared heartbeat row. I am choosing a heartbeat lane escrow: controller
authority, serving self-report, and ingestion witnesses become distinct producer lanes, and material verdicts consume a
stable escrow receipt rather than a raw heartbeat row. The tradeoff is another reducer and a stricter dispatch gate.
I accept it because the current race can move normal dispatch between repair-only and allow while the system still
cannot prove AgentRun ingestion from the controller process.

## Runtime Objective And Success Metrics

This contract improves Jangar resilience by eliminating controller heartbeat last-writer-wins ambiguity and making
material verdicts stable across rollout churn.

Success means:

- Serving pods never overwrite controller-process heartbeat authority for the `controllers` lane.
- Controller, serving, and ingestion witnesses are preserved as separate facts with producer identity and expiry.
- `dispatch_normal` can only become `allow` after the controller heartbeat, watch epoch, and AgentRun ingestion witness
  agree for a bounded stability window.
- `allow_with_split` permits serving, observation, and bounded repair, but not unconstrained normal dispatch.
- Torghut capital gates consume a stable Jangar receipt and remain zero-notional when the Jangar receipt is unstable,
  expired, or contradicted.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps manifests, or ClickHouse tables.

### Cluster And Rollout Evidence

- Runtime identity was `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` was unset, but
  namespace-scoped reads worked.
- `pods/exec` is forbidden in both `jangar` and `torghut`, and `statefulsets.apps` listing is forbidden in `torghut`.
  Deployer gates must not rely on privileged pod exec or broad workload reads.
- Jangar namespace phase count was `Running=8`.
- Agents namespace phase count was `Running=9`, `Completed=225`, and `Error=37`.
- Torghut namespace phase count was `Running=29` and `Completed=6`.
- Argo CD showed `jangar` Synced/Healthy at `62b9efedb1366c24f0b44b42923099d38249c47c`, `agents` Synced/Healthy at
  `b09a46cdb028a0a2291201950162e412b8262718`, and `torghut` Synced/Progressing at
  `b09a46cdb028a0a2291201950162e412b8262718`.
- Recent Agents events included schedule jobs completing normally and transient readiness timeouts for `agents` and
  `agents-controllers` pods.
- Recent Torghut events showed database migrations completing, live revision `torghut-00243` and sim revision
  `torghut-sim-00344` becoming ready after startup probe warm-up, and repeated ClickHouse PDB warnings where replicas
  match multiple PodDisruptionBudgets.

### Route Evidence

- Jangar `/ready` returned `status=ok`; leader election was current; serving and collaboration runtime kits were
  healthy; swarm plan, implement, and verify passports were `allow`.
- Jangar `/api/agents/control-plane/status` at `2026-05-06T20:09:32Z` reported execution trust healthy, database
  healthy, dependency quorum allow, watch reliability healthy with `5743` events, `0` errors, and `2` restarts.
- The same route reported Jangar degraded only for `empirical:forecast`; forecast authority was
  `status=degraded`, `message=registry_empty`, and no eligible forecast models.
- At `2026-05-06T20:14:15Z`, route status reported controller heartbeats from
  `agents-controllers-b8b789d4f-2lqtl`, `agentrun_ingestion.status=unknown`, controller witness
  `allow_with_split`, and material action verdicts that allowed `dispatch_normal`.
- Paper and live Torghut actions remained held or blocked by `forecast_service_degraded`,
  `torghut_consumer_evidence_missing`, and `paper_settlement_required`.

### Database And Data Evidence

- Jangar SQL connected as `jangar` to database `jangar`.
- Jangar had `54` public tables, `2` `agents_control_plane` tables, `11` `torghut_control_plane` tables, and `1`
  `workflow_comms` table.
- `kysely_migration` had `28` applied migrations, latest
  `20260505_torghut_quant_pipeline_health_window_index`.
- `agents_control_plane.resources_current` had active AgentRun projections:
  `Succeeded=194`, `Failed=14`, `Running=5`, and `Template=12`.
- Jangar table estimates were large enough to require indexed or estimated validation paths:
  `quant_metrics_series` about `314M`, `quant_pipeline_health` about `50.7M`,
  `workflow_comms.agent_messages` about `8156`, and `resources_current` about `4315`.
- The heartbeat table showed the authority race directly: the only rows for workload role `controllers` were produced
  by `deployment_name=jangar-6b665898b9-jk27d` with disabled controller and workflow-runtime statuses at
  `2026-05-06T20:14:16Z`, while the route had just used `agents-controllers-b8b789d4f-2lqtl` as healthy authority.
- Torghut SQL connected as `torghut_app` to database `torghut`; public schema had `69` tables and Alembic head
  `0029_whitepaper_embedding_dimension_4096`.
- Torghut had `147623` trade decisions, `13778` executions, `42139` position snapshots, `20` empirical job rows,
  `16` strategies, and zero rows in `strategy_hypotheses`, `simulation_runtime_context`, and
  `simulation_run_progress`.
- Latest execution update was `2026-04-03T05:32:36.212Z`; latest trade decision was
  `2026-05-06T17:44:19.618Z`; latest position snapshot was `2026-05-06T20:13:06.742Z`.
- ClickHouse guardrail exporter reported both replicas up, last scrape success, and max TA signal/microbar timestamp
  `2026-05-06T20:11:37Z`.

### Source Evidence

- `services/jangar/src/server/control-plane-heartbeat-store.ts` upserts heartbeat rows on conflict by
  `cluster`, `namespace`, `component`, and `workload_role`. That key cannot distinguish serving self-report from
  controller-process authority when both write the same workload role.
- `services/jangar/src/server/control-plane-status.ts` reads `workloadRole: 'controllers'` for controller and workflow
  authority, then builds runtime adapter availability from the selected heartbeat.
- `services/jangar/src/server/control-plane-controller-witness.ts` can return `allow_with_split` when the effective
  controller heartbeat is fresh but the serving process is not the controller. It still keeps an AgentRun ingestion
  witness with `controller_ingestion_unknown`.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` consumes the controller witness and can allow
  normal dispatch after the transient healthy heartbeat is selected.
- Existing tests cover heartbeat store, status, controller witness, and material verdict behavior. The missing tests
  are producer-lane collision tests and stability-window tests where route status and direct heartbeat storage disagree
  within the same minute.

## Problem

Jangar has the right evidence categories, but one storage contract is still too weak for material authority.

The current failure modes are:

1. **Heartbeat lane collision.** Serving and controller processes can write the same controller-role key.
2. **Last-writer-wins authority.** The selected controller truth can change from disabled to healthy and back without a
   stable settlement window.
3. **Ingestion ambiguity.** AgentRun ingestion can stay unknown while controller heartbeats and watch events look
   healthy.
4. **Material verdict oscillation.** `dispatch_normal` can change decision without a durable receipt that proves the
   controller process, watch epoch, and ingestion witness agree.
5. **Least-privilege validation gap.** The normal agents service account cannot use pod exec to inspect the producer,
   so the route and database projection must be self-sufficient.

## Alternatives Considered

### Option A: Widen RBAC And Validate With Pod Exec

Pros:

- Lets deployers inspect the exact pod process and environment.
- Can prove which deployment is writing a heartbeat.
- Low application code complexity.

Cons:

- Violates the least-privilege operating model for normal validation.
- Does not stop last-writer-wins overwrites.
- Makes capital gates depend on operator access rather than productized receipts.

Decision: reject.

### Option B: Trust The Status Route And Ignore Direct Heartbeat Rows

Pros:

- Uses the existing control-plane route.
- Avoids schema or reducer changes.
- Keeps dispatch unblocked when the latest route sample is healthy.

Cons:

- Hides the storage race that the route is built on.
- Allows material decisions to change with scrape timing.
- Does not prove AgentRun ingestion from the controller process.

Decision: reject.

### Option C: Heartbeat Lane Escrow With Material Verdict Stability

Pros:

- Preserves serving, controller, and ingestion facts separately.
- Turns route/storage disagreement into a named stability debt item.
- Gives material verdicts a stable receipt with producer identity and expiry.
- Lets serving and repair remain available while holding normal dispatch and capital during instability.
- Works under least-privilege validation.

Cons:

- Requires a migration or projection change.
- Requires stricter tests around timing and writer identity.
- May temporarily reduce normal dispatch throughput while the new receipt learns stability windows.

Decision: select Option C.

## Architecture

Jangar emits one heartbeat lane escrow epoch per namespace and stability window.

```text
heartbeat_lane_escrow_epoch
  epoch_id
  generated_at
  namespace
  window_start
  window_end
  producer_lanes
  selected_controller_lane
  ingestion_lane
  route_storage_consistency
  stability_decision_by_action_class
  debt_items
  rollback_target
```

Producer lanes are not last-writer-wins rows:

```text
heartbeat_producer_lane
  lane_id
  component
  workload_role
  producer_kind            # serving_process, controller_process, workflow_runtime
  deployment_name
  pod_name
  status
  enabled
  observed_at
  expires_at
  source_namespace
  writer_identity_hash
```

Selection rules:

- `controller_process` lanes can satisfy controller authority only when the deployment name matches the configured
  controller rollout target and the lane is fresh.
- `serving_process` lanes can satisfy serving readiness and local orchestration state, but cannot write or supersede
  controller-process authority.
- `agentrun_ingestion` must come from the controller process or from a controller-provided projection. A serving-process
  "not started" value is a diagnostic fact, not a controller-ingestion receipt.
- If route status and storage projection disagree within the stability window, emit `heartbeat_lane_unstable` and
  downgrade `dispatch_normal` to `repair_only`.
- `allow_with_split` is never enough for paper or live capital. It can only support read-only service, observation, and
  bounded repair.

Material verdict stability:

```text
material_verdict_stability_receipt
  receipt_id
  action_class
  current_verdict_id
  heartbeat_escrow_epoch_id
  required_consecutive_epochs
  observed_consecutive_epochs
  decision              # allow, repair_only, hold, block
  instability_reasons
  allowed_until
  rollback_target
```

Initial policy:

- `serve_readonly`: allow if serving readiness is healthy.
- `dispatch_repair`: allow with one stable controller or one named instability debt item.
- `dispatch_normal`: require controller-process heartbeat, watch epoch, and AgentRun ingestion receipt stable for two
  consecutive windows.
- `deploy_widen`: require rollout health and no heartbeat lane collision in the target namespace.
- `paper_canary`, `live_micro_canary`, and `live_scale`: require stable Jangar receipt plus Torghut-specific forecast,
  paper settlement, TCA, and rollback receipts.

## Validation Gates

Engineer stage must add:

- Heartbeat-store tests proving serving and controller producers cannot overwrite each other.
- Reducer tests for route healthy plus storage disabled in the same window.
- Material verdict tests where `allow_with_split` keeps repair available but does not allow normal dispatch until
  ingestion is current.
- Status route fixtures that expose `heartbeat_lane_unstable` with producer identities redacted to safe hashes.
- Database migration or projection tests that keep indexed lookup by namespace, component, role, producer kind, and
  freshness.

Deployer stage must prove:

- For three consecutive heartbeat intervals, the selected controller lane is produced by `agents-controllers`, not the
  serving deployment.
- Jangar route, heartbeat storage, rollout health, and watch reliability agree before declaring normal dispatch stable.
- `dispatch_normal` does not oscillate across two consecutive status samples.
- Paper and live Torghut gates remain zero-notional while forecast authority is missing or the Jangar stability receipt
  is unstable.

## Rollout Plan

1. Add producer-lane fields or a new heartbeat-lane projection while keeping the current route in shadow.
2. Emit heartbeat escrow epochs from existing heartbeat, rollout, watch, and ingestion inputs.
3. Add material verdict stability receipts in shadow and compare decisions with current material verdicts.
4. Enforce stability for `dispatch_normal` first; keep repair lanes open.
5. Let Torghut consume the stable receipt for observe and paper gating after route payloads are stable for two sessions.

## Rollback Plan

- Disable heartbeat escrow enforcement and return material verdicts to the current shadow route.
- Preserve escrow epochs for audit.
- Keep serving readiness, dependency quorum, and existing material verdict payloads visible.
- Keep Torghut paper/live capital blocked by forecast and consumer-evidence gates if the stability feature is rolled
  back before Torghut consumption is complete.

## Risks

- A stability window that is too strict can slow normal scheduled work during rollouts.
- A stability window that is too short can still admit heartbeat flapping.
- Producer identity fields can leak operational detail if exposed raw; public route payloads must use hashes and
  workload names only.
- If the current heartbeat race is fixed in code before the reducer lands, the escrow still adds value as a regression
  guard and Torghut receipt contract.

## Handoff Contract

Engineer acceptance:

- Heartbeat producer lanes are distinct and tested.
- A status route exposes heartbeat escrow, stability receipts, and route/storage consistency without privileged pod
  exec.
- `dispatch_normal` requires a stable controller-process plus AgentRun ingestion receipt; `allow_with_split` cannot
  upgrade it by itself.

Deployer acceptance:

- Read-only checks capture Jangar route status, heartbeat storage, rollout health, watch reliability, and Torghut
  capital gates.
- Normal dispatch is declared stable only after two consecutive matching samples.
- Rollback is a feature flag or projection disablement, not a database mutation.
