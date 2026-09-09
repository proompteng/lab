# 128. Jangar Runtime Convergence Ledger And Capital Gate Receipts (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders architecture
Scope: Jangar control-plane resilience, cross-plane dependency quorum convergence, Torghut capital-gate receipts,
runtime rollout proof, database projection freshness, and rollback-safe handoff gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/132-torghut-dependency-quorum-rehydration-and-profit-inventory-handoff-2026-05-06.md`

Extends:

- `127-jangar-activation-inventory-ledger-and-product-gap-fuses-2026-05-06.md`
- `126-jangar-projection-witness-exchange-and-material-evidence-products-2026-05-06.md`
- `125-jangar-quant-proof-replication-and-capital-admission-firebreak-2026-05-06.md`
- `121-jangar-controller-witness-uplink-and-proof-renewal-train-2026-05-06.md`

## Decision

I am selecting a **runtime convergence ledger with capital-gate receipts** as the next Jangar architecture contract.

The May 5 degraded posture has moved. On 2026-05-06 at about 19:16 UTC, Jangar had eight running pods, the `jangar`
deployment was available at image `885c987a`, `agents` was `1/1`, and `agents-controllers` was `2/2`. The Jangar
control-plane route reported healthy agents-controller, supporting-controller, orchestration-controller, workflow
runtime, job runtime, Temporal runtime, execution trust, and database migration consistency. The database heartbeat
table agreed: `agents-controller`, `supporting-controller`, `orchestration-controller`, and `workflow-runtime` were
fresh and healthy.

The problem is no longer "Jangar is down." The problem is that downstream capital consumers can still be looking at
stale or contradictory dependency truth. Torghut live readiness reported `dependency_quorum` as blocked for
`agents_controller_unavailable` and `workflow_runtime_unavailable` while Jangar's own status reported those surfaces
healthy. That contradiction is dangerous because it can either block good zero-notional learning for the wrong reason
or, after a later rollout, admit paper/live notional from a stale green path.

The selected direction makes Jangar issue an explicit convergence ledger per runtime window. Each ledger records
source intent, rollout state, heartbeat truth, database projection, route payloads, and Torghut consumer acknowledgments.
Jangar then emits capital-gate receipts that Torghut can consume. The tradeoff is one more authoritative payload and
one more reducer, but that is cheaper than asking deployers to reconcile stale route state, rollout events, and database
facts by hand during every quant promotion.

## Runtime Objective And Success Metrics

This contract increases control-plane resilience by reducing failure modes where one plane is healthy and another plane
still acts on old or contradictory evidence.

Success means:

- Jangar can state whether controller, runtime, quant, and simulation facts have converged for a named window.
- Torghut can cite a current Jangar receipt before treating a dependency quorum block or allow decision as material.
- A healthy Jangar rollout does not automatically widen Torghut capital until Torghut has consumed and echoed the
  receipt.
- A stale Torghut dependency block is visible as a convergence debt item, not silently treated as current truth.
- Rollback has a single target: disable convergence receipts and return Torghut to existing shadow and simple-gate
  behavior.

## Evidence Snapshot

All evidence was read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests, broker state, or
trading flags.

### Cluster And Rollout Evidence

- `kubectl config current-context` was unset, but namespace-scoped reads worked under the in-cluster service account.
- Jangar namespace phase counts were `Running=8`.
- Agents namespace phase counts were `Running=7`, `Completed=218`, and `Error=37`.
- `deployment/jangar` was `1/1`, `deployment/agents` was `1/1`, and `deployment/agents-controllers` was `2/2`.
- Recent Jangar events showed rollout replacement to image `885c987a` with a transient readiness failure on
  `http://pod:8080/health` before availability.
- Recent Agents events showed `agents` and `agents-controllers` rollout replacement, completed scheduled jobs, and
  readiness probe failures on older controller pods during replacement.
- The agents service account could not list `services.serving.knative.dev` or Argo `analysisruns` in `torghut`, so
  this design must work from least-privilege routes, deployments, events, and database projections.

### Route Evidence

- Jangar `/health` returned HTTP 200 with `status=ok`, but the serving-process health still showed its local
  `agentsController.enabled=false` state.
- Jangar `/api/agents/control-plane/status` returned HTTP 200 with healthy agents, supporting, and orchestration
  controllers, healthy workflow and job runtime adapters, healthy execution trust, and database migrations through
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar `/api/torghut/trading/control-plane/quant/health` returned HTTP 200 with `latestMetricsCount=4032`,
  `metricsPipelineLagSeconds=0`, and `pipelineHealthSkippedReason=account_and_window_required`.
- Torghut live `/readyz` returned HTTP 503 degraded. Core dependencies were healthy, but `live_submission_gate` was
  blocked by `simple_submit_disabled`, and alpha readiness reported dependency quorum blocked for
  `agents_controller_unavailable` and `workflow_runtime_unavailable`.
- Torghut sim `/readyz` returned HTTP 200 with healthy Postgres, ClickHouse, paper Alpaca, universe, and non-live
  submission gate state.

### Database And Data Evidence

- Jangar read-only SQL connected as `jangar` to database `jangar`.
- Jangar schema inventory included `agents_control_plane=2` tables and `torghut_control_plane=11` tables.
- `kysely_migration` had `28` applied rows, latest
  `20260505_torghut_quant_pipeline_health_window_index`.
- `agents_control_plane.component_heartbeats` had four rows, all healthy and fresh through about
  `2026-05-06T19:15Z`.
- `agents_control_plane.resources_current` estimated `3480` rows with AgentRun projections:
  `Succeeded=188`, `Failed=14`, `Running=2`, and `Template=12`.
- Jangar quant estimates were large: `quant_pipeline_health` about `50.7M`, `quant_metrics_series` about `314M`, and
  `quant_metrics_latest=4032` with latest data at about `2026-05-06T19:13Z`.
- Jangar simulation control data existed but was stale: `simulation_runs=58`, `simulation_artifacts=754`,
  `dataset_cache=19`, and `simulation_lane_leases=4`, with latest updates on `2026-03-19`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes controller status, runtime adapters, execution trust,
  database health, failure-domain leases, negative evidence, controller witness, and material action receipts.
- `services/jangar/src/server/control-plane-heartbeat-store.ts` already stores fresh component heartbeat truth, but
  downstream consumers need a receipt that says Torghut has consumed that truth.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` owns the high-volume quant metrics path and has indexed
  account/window queries, but unscoped health still intentionally skips pipeline health.
- `services/jangar/src/server/torghut-simulation-control-plane.ts` owns simulation runs, lane leases, dataset cache,
  campaigns, and artifacts. The live database shows this surface exists but is stale relative to current Torghut sim
  pods.
- Existing tests cover control-plane status, heartbeat store, runtime admission, Kysely migrations, and simulation
  control-plane submission. The missing test surface is the cross-plane convergence reducer: stale Torghut dependency
  blocks versus fresh Jangar receipts.

## Problem

Jangar has accumulated the right evidence products, but they are not yet joined into one cross-plane convergence
contract.

The current failure modes are:

1. **Healthy producer, stale consumer.** Jangar controller and runtime facts are fresh, but Torghut can still report
   old dependency quorum blocks.
2. **Healthy route, incomplete scope.** Jangar quant health is fresh globally, but scoped account/window health is not
   evaluated when account and window are omitted.
3. **Running workload, stale inventory.** Current Torghut sim pods are running, but Jangar simulation-control rows are
   from March 19.
4. **Least-privilege ambiguity.** The agents service account cannot inspect Knative services or Argo AnalysisRuns, so
   runtime proof must be expressed through productized receipts.
5. **Rollout churn.** Recent readiness failures during rollout were transient and recovered, but there is no receipt
   that tells Torghut when that churn has converged.

## Alternatives Considered

### Option A: Treat Jangar Control-Plane Status As Sufficient

Pros:

- Uses an existing route.
- Avoids new schema or payload fields.
- Quickly reflects the now-healthy Jangar controller state.

Cons:

- Does not prove Torghut consumed the state.
- Does not distinguish stale downstream quorum blocks from current blocks.
- Does not include simulation inventory freshness or scoped quant consumption.

Decision: reject.

### Option B: Let Torghut Poll And Reconcile Every Source Directly

Pros:

- Keeps capital logic close to Torghut.
- Gives Torghut direct control over readiness decisions.
- Avoids adding Jangar-side receipt storage.

Cons:

- Pushes Jangar rollout, heartbeat, and database semantics into Torghut.
- Requires broader RBAC or fragile route scraping.
- Recreates multiple conflicting sources of truth.

Decision: reject.

### Option C: Runtime Convergence Ledger With Capital-Gate Receipts

Pros:

- Converts producer state and consumer acknowledgment into one bounded fact.
- Makes stale dependency quorum blocks explicit.
- Keeps Jangar responsible for Jangar runtime truth and Torghut responsible for capital decisions.
- Gives deployers a single rollout gate and rollback switch.

Cons:

- Adds a reducer and one more route payload.
- Requires receipt TTLs to avoid false confidence during rapid rollouts.
- Requires Torghut changes before enforcement can move beyond shadow.

Decision: select Option C.

## Architecture

Jangar emits one convergence ledger per runtime window.

```text
runtime_convergence_epoch
  epoch_id
  generated_at
  source_ref
  rollout_ref
  heartbeat_ref
  database_ref
  route_ref
  torghut_consumer_ref
  convergence_items
  capital_gate_receipts
  open_debt_items
  decision_by_action_class
  rollback_target
```

Each convergence item must name both producer and consumer state.

```text
runtime_convergence_item
  item_id
  producer_id
  consumer_id
  expected_state
  rollout_status
  heartbeat_status
  database_projection_status
  route_status
  consumer_ack_status
  observed_at
  expires_at
  decision        # current, observe_only, repair_only, stale, contradictory, blocked
  reason_codes
```

Initial receipts:

- `controller_runtime_converged`: agents-controller, supporting-controller, orchestration-controller, workflow runtime,
  and job runtime are healthy and fresh.
- `dependency_quorum_reconciled`: Torghut has consumed current controller/runtime truth and no longer reports stale
  controller unavailability.
- `quant_health_consumed`: Torghut has configured and queried the typed Jangar quant health route for account/window.
- `simulation_inventory_current`: Jangar simulation rows are fresher than the current Torghut sim revision and lane
  leases are not older than the allowed TTL.
- `profit_inventory_current`: Torghut has active hypothesis or strategy inventory for the capital window.

Action classes:

- `observe`: allowed with fresh Jangar controller/runtime receipt and Torghut shadow gate.
- `repair`: allowed when convergence debt is named and notional remains zero.
- `paper_canary`: requires all five initial receipts.
- `live_micro`: requires all paper receipts plus execution settlement and deployer approval.
- `live_scale`: requires live micro evidence, post-cost performance, and a fresh rollback target.

## Validation Gates

Engineer stage must add:

- Pure reducer tests for healthy Jangar plus stale Torghut dependency quorum.
- Route fixture tests for each receipt state: current, stale, missing, contradictory, and blocked.
- Database tests that avoid broad scans and use table estimates or indexed latest queries.
- A fixture where Jangar simulation rows are stale while Torghut sim pods are current.
- A fixture where Jangar quant health is fresh globally but skipped for missing account/window.

Deployer stage must prove:

- Jangar convergence route returns current controller/runtime receipts after rollout.
- Torghut consumes the receipt and stops reporting stale controller/runtime blocks before paper canary is considered.
- Paper and live gates remain blocked while `quant_health_consumed`, `simulation_inventory_current`, or
  `profit_inventory_current` are missing.
- Disabling the convergence feature flag returns the system to current shadow/simple-gate behavior.

## Rollout Plan

1. Implement the Jangar convergence reducer and route behind a disabled-by-default flag.
2. Emit shadow-only receipts from existing status, heartbeat, quant, and simulation projections.
3. Add Torghut shadow consumption and echo the receipt id in health/status payloads.
4. Require `dependency_quorum_reconciled` for paper canary while keeping notional at zero.
5. Require the full receipt set before any live micro-canary.

## Rollback Plan

Rollback is feature-flag based:

- Disable Jangar convergence receipt emission.
- Disable Torghut receipt consumption.
- Keep Jangar status, Torghut readiness, and simple submission gates on their current paths.
- Preserve receipt rows for audit, but stop using them in capital decisions.

## Risks

- Receipt TTLs that are too long can hide a new controller outage.
- Receipt TTLs that are too short can block paper during normal rollout churn.
- Quant table volume can still pressure Postgres if engineers implement unbounded scans.
- Torghut can remain in shadow if profit inventory is not rehydrated after the Jangar receipt path is ready.

## Handoff Contract

Engineer acceptance:

- `runtime_convergence_epoch` reducer exists with unit tests for the five initial receipts.
- Jangar route exposes convergence status without privileged Kubernetes reads.
- Torghut can consume a receipt in shadow and echo its id, freshness, and blocking reasons.

Deployer acceptance:

- A post-rollout read-only check captures Jangar route health, controller heartbeats, Torghut readiness, and both DB
  projection summaries.
- Paper canary remains blocked until stale dependency quorum and profit inventory gaps are closed.
- Rollback is a documented flag flip with no database mutation required.
