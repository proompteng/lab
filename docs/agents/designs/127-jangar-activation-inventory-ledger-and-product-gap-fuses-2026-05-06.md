# 127. Jangar Activation Inventory Ledger And Product Gap Fuses (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane activation truth, rollout safety, producer projection gaps, bounded database pressure,
Torghut profit-proof consumers, and cross-swarm acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/131-torghut-active-profit-inventory-and-quant-carry-fuses-2026-05-06.md`

Extends:

- `126-jangar-projection-witness-exchange-and-material-evidence-products-2026-05-06.md`
- `125-jangar-run-settlement-watermarks-and-consumer-evidence-escrow-2026-05-06.md`
- `122-jangar-evidence-pressure-governor-and-data-cost-rollout-cells-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`

## Decision

I am selecting an **activation inventory ledger with product gap fuses** as the next Jangar control-plane contract.

The current control plane is not down. On `2026-05-06T18:27Z`, `jangar` had eight running pods, including the serving
pod, database, Redis, OpenWebUI, Bumba, Alloy, and Symphony. In `agents`, the `agents` deployment was `1/1` and
`agents-controllers` was `2/2`. Torghut live, sim, Postgres, ClickHouse, Keeper, TA, options, websockets, and
guardrail exporters were running. This is a materially healthier cluster than the broad degraded posture from May 5.

The control-plane risk is subtler. The agents namespace still retained `37` failed pods, and recent events showed
readiness probe timeouts during the latest agents and Jangar rollouts. The Jangar database was reachable and
schema-current at `28` applied Kysely migrations, but the component heartbeat table showed only
`orchestration-controller` as `healthy`; `agents-controller`, `supporting-controller`, and `workflow-runtime` were
reported as `disabled` for the controllers workload. At the same time, `agents_control_plane.resources_current`
projected `4252` rows and fresh AgentRun state, while `torghut_control_plane.quant_pipeline_health` estimated about
`50.8M` rows and the Jangar simulation-control tables had zero run, artifact, campaign, and lane lease rows.

That split is the next failure mode to remove. Jangar has product contracts now, but it still lacks a compact ledger
that says whether each expected producer is intended, deployed, heartbeating, projecting rows, emitting products, and
feeding a real consumer. Without that ledger, a green rollout can hide disabled producer heartbeats, a large proof
table can hide zero active profit inventory, and deployers cannot tell which missing product is a true outage versus a
producer that was never meant to run.

The selected design adds one activation inventory epoch per status window. Each epoch inventories expected producers
and consumers, then opens product gap fuses when desired state, deployment state, heartbeat state, database projection,
or product emission disagree. The tradeoff is stricter rollout friction during noisy green windows. I accept that
because the six-month control-plane risk is not only failed pods; it is silent drift between source, cluster,
database projection, and capital consumers.

## Runtime Objective And Success Metrics

This contract improves Jangar resilience by making producer activation an explicit prerequisite for widening rollout,
normal dispatch, merge readiness, and Torghut capital work.

Success means:

- Jangar can explain, for each producer, whether it is expected, enabled, deployed, heartbeating, projecting data, and
  producing material evidence products.
- A deployment cannot be treated as fully green when an expected controller heartbeat is `disabled`, expired, missing,
  or contradictory with the deployment.
- High-volume data products must show bounded consumers. A `50M` row proof table with no active simulation run or
  lane lease opens a data-cost fuse, not a silent success.
- Torghut profit work can continue at zero notional only when the matching Jangar activation products are fresh.
- Engineers and deployers can validate the design with pure reducers, bounded database statistics, route payloads, and
  read-only cluster checks.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests, broker
state, trading flags, or runtime objects.

### Cluster And Rollout Evidence

- `kubectl config current-context` was unset, but namespace-scoped reads worked under the in-cluster service account.
- Jangar namespace phase counts were `Running=8`.
- Agents namespace phase counts were `Running=7`, `Succeeded=212`, and `Failed=37`.
- `deployment/agents` was `1/1`; `deployment/agents-controllers` was `2/2`; both had progressed successfully.
- Recent agents events included readiness probe failures on older and current controller pods during rollout, then the
  `eb0d955b` image family became available.
- Torghut phase counts were `Running=27` and `Succeeded=2`; the earlier sim image pull failure was not present in the
  current pod set.
- Recent Torghut events showed live and sim revision warm-up, analysis success for runtime-ready and activity checks,
  one failed sim teardown-clean analysis, repeated ClickHouse multiple-PDB warnings, and a `torghut-ws-options`
  readiness `503`.
- Direct CNPG cluster listing and pod exec were forbidden; product and activation contracts must work from
  least-privilege application and namespace read surfaces.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes database, rollout, watch, workflow, heartbeat,
  negative-evidence, failure-domain, runtime-admission, and action-clock surfaces.
- `services/jangar/src/server/control-plane-heartbeat-store.ts` stores one current heartbeat row by cluster,
  namespace, component, and workload role. The shape is right for activation inventory, but it is not yet compared to
  expected producer intent.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedules, CronJobs, workspaces, requirements,
  swarm admission, and runner state. It is the correct owner for supporting-controller activation facts.
- `services/jangar/src/server/primitives-kube.ts` includes PVC support, so the older workspace PVC blind spot is
  closed in code. The remaining risk is activation mismatch, not missing primitive support.
- `services/jangar/src/server/control-plane-db-status.ts` already gives migration consistency and a `select 1` probe;
  activation inventory should reuse this bounded pattern instead of adding wide ad hoc scans.

### Database And Data Evidence

- Jangar direct read-only SQL used the app secret and `current_database=jangar`, `current_user=jangar`.
- Jangar schema inventory showed `agents_control_plane=2` tables, `torghut_control_plane=11`, `atlas=16`,
  `jangar_github=9`, `codex_judge=4`, `memories=1`, and `public=54`.
- Jangar Kysely migrations were applied through
  `20260505_torghut_quant_pipeline_health_window_index` with `applied_count=28`.
- `agents_control_plane.component_heartbeats` had four rows, all fresh to the minute, but only
  `orchestration-controller` was `healthy`; `agents-controller`, `supporting-controller`, and `workflow-runtime`
  were `disabled`.
- `agents_control_plane.resources_current` estimated `4252` live rows and included AgentRun projections:
  `Succeeded=182`, `Failed=14`, `Running=2`, and `Template=12`.
- `torghut_control_plane.quant_pipeline_health` estimated `50838708` live rows and `quant_metrics_series` estimated
  `2149704` live rows. `dataset_cache`, `simulation_runs`, `simulation_artifacts`, `simulation_campaigns`,
  `simulation_campaign_runs`, and `simulation_lane_leases` each estimated zero rows.
- Torghut direct read-only SQL used the app secret and `current_database=torghut`, `current_user=torghut_app`.
- Torghut Alembic head was `0029_whitepaper_embedding_dimension_4096`; the public schema had `71` tables.
- Torghut sampled statistics showed `trade_decisions=17`, `trade_cursor=1`, `executions=0`, and
  `strategy_hypotheses=0`.

## Problem

Jangar now has strong evidence products, but product emission is not the same thing as producer activation truth.

The current gap has four failure modes:

1. **Deployed but disabled.** A controller deployment can be ready while the corresponding heartbeat reports disabled.
2. **Projected but not capital-useful.** A high-volume quant table can be fresh enough for dashboards while the
   consumer inventory needed for simulation or profit admission is empty.
3. **Cluster-active but database-invisible.** Torghut sim can be running in Kubernetes while Jangar has zero simulation
   run and lane lease rows.
4. **Privilege-safe but ambiguous.** Least-privilege service accounts cannot use CNPG exec as a backstop, so Jangar
   must make product gaps explicit instead of asking deployers to inspect privileged surfaces manually.

These are architecture failures, not local bugs. The system needs activation inventory before it can safely automate
more rollout or capital decisions.

## Alternatives Considered

### Option A: Keep Material Evidence Products As The Only Shared Contract

Pros:

- Builds directly on the previous accepted design.
- Avoids another status surface.
- Keeps implementation focused on route payloads and receipts.

Cons:

- Products can be missing without a clear statement of whether the producer is disabled, failed, or not expected.
- Does not compare expected controller intent with heartbeat state.
- Does not connect database row pressure to active consumers.
- Leaves deployers to infer why simulation rows are absent while sim pods are running.

Decision: reject as incomplete.

### Option B: Broaden Runtime RBAC And Query Producers Directly

Pros:

- Gives operators more immediate raw evidence.
- Makes ad hoc debugging easier.
- Can validate CNPG and pod internals directly.

Cons:

- Violates the least-privilege posture that kept this assessment read-only and bounded.
- Expands blast radius for every agent lane.
- Still does not decide which producers are expected or economically useful.
- Encourages privileged inspection instead of durable product contracts.

Decision: reject.

### Option C: Activation Inventory Ledger With Product Gap Fuses

Pros:

- Separates "should exist" from "exists" from "is useful".
- Converts disabled heartbeats, missing projections, and oversized proof tables into action-specific fuses.
- Keeps database checks bounded through table statistics and targeted projections.
- Gives Torghut a stable producer inventory for profit gates without owning Jangar dispatch authority.

Cons:

- Adds one more reducer and payload section.
- Requires careful thresholds so expected overnight emptiness does not become false outage noise.
- Requires source, cluster, and database projection facts to be versioned together.

Decision: select Option C.

## Architecture

Jangar emits one activation inventory per control-plane status window.

```text
control_plane_activation_inventory_epoch
  epoch_id
  generated_at
  namespace
  producer_revision
  source_ref
  deployment_ref
  database_ref
  product_exchange_ref
  inventory_items
  gap_fuses
  data_cost_fuses
  decision_by_action_class
  rollback_target
```

Each inventory item is explicit:

```text
activation_inventory_item
  producer_id
  producer_class
  expected_state       # required, optional, disabled, unknown
  source_owner
  source_refs
  desired_namespace
  deployment_ready
  deployment_replicas
  heartbeat_status
  heartbeat_observed_at
  heartbeat_expires_at
  projection_table
  estimated_rows
  latest_observed_at
  product_count
  consumer_refs
  activation_decision  # active, observe_only, repair_only, hold, block, unavailable
  reason_codes
  required_repairs
```

Initial producer inventory:

- `jangar.serving`
- `jangar.agents_controller`
- `jangar.supporting_controller`
- `jangar.orchestration_controller`
- `jangar.workflow_runtime`
- `jangar.database_projection`
- `jangar.agentrun_projection`
- `jangar.schedule_runner`
- `jangar.torghut_quant_cache`
- `jangar.torghut_simulation_control_plane`
- `torghut.live_runtime`
- `torghut.sim_runtime`
- `torghut.clickhouse_guardrails`
- `torghut.profit_inventory`

Gap fuses:

- `expected_heartbeat_disabled`: expected producer has a fresh `disabled` heartbeat.
- `deployment_heartbeat_split`: deployment is ready but heartbeat is missing, expired, or contradictory.
- `projection_empty_while_cluster_active`: cluster workload is running but the corresponding projection is empty.
- `large_table_without_consumer`: proof table exceeds row budget without active run, lane, or product consumers.
- `consumer_product_missing`: a material action requires a product that no expected producer emitted.
- `observation_right_missing`: the service account cannot read a raw surface and no producer projection replaces it.

Action classes use fuses conservatively:

- `serve_readonly` can continue when database and serving products are active.
- `dispatch_repair` can continue for repairs that target an open activation gap.
- `dispatch_normal` holds on expected controller heartbeat gaps or workflow-runtime gaps.
- `deploy_widen` and `merge_ready` hold on any required producer gap or migration drift.
- `torghut_observe` can continue at zero notional while profit inventory is empty.
- `paper_canary`, `live_micro_canary`, and `live_scale` require active Torghut profit inventory plus the companion
  Torghut fuse decisions.

## Implementation Scope

Engineer stage:

- Add pure TypeScript reducers for activation inventory and gap fuses.
- Build inventory inputs from existing status reducers, heartbeat store rows, bounded `pg_stat_all_tables` summaries,
  and existing Torghut route products.
- Add status payload fields behind a shadow feature flag.
- Add fixtures for the current state: deployments ready, disabled controller heartbeats, failed pod retention,
  large quant pipeline tables, zero simulation lane rows, and Torghut zero active profit inventory.
- Do not add broad RBAC, pod exec, or write-path database changes in the first implementation PR.

Deployer stage:

- Validate shadow output in `agents` and `jangar` before enforcing holds.
- Use existing rollout status commands plus the activation inventory to explain why a green deployment can still be a
  hold for dispatch or capital.

## Validation Gates

Local gates:

- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-controller-witness.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-failure-domain-leases.test.ts`
- `bun run --filter @proompteng/jangar lint`

Behavior gates:

- A ready controller deployment plus `disabled` expected heartbeat opens `expected_heartbeat_disabled`.
- A running Torghut sim pod plus zero Jangar simulation rows opens `projection_empty_while_cluster_active`.
- A quant pipeline table above budget with no active consumer opens `large_table_without_consumer`.
- `dispatch_repair` stays allowed for the repair named by the fuse.
- `deploy_widen`, `merge_ready`, `paper_canary`, and live capital remain held while required activation fuses are open.

Read-only runtime gates:

- `kubectl get deploy -n agents agents agents-controllers` shows available replicas before evaluating deployment
  activation.
- Jangar DB stats come from bounded catalog projections, not full table scans.
- The status route explains any `/ready` versus material-action difference through producer ids and fuse ids.

## Rollout Plan

Phase 0, shadow fixtures:

- Land reducer types and fixtures only.
- Keep material action enforcement unchanged.

Phase 1, shadow status:

- Emit `activation_inventory_epoch` and fuse summaries from Jangar status.
- Compare status output against read-only cluster and database samples for one rollout window.

Phase 2, repair admission:

- Let open activation fuses feed repair-clearing items.
- Keep normal dispatch, deploy widen, and capital actions in existing enforcement mode.

Phase 3, enforcement:

- Enforce expected heartbeat and projection-empty fuses for `dispatch_normal`, `deploy_widen`, and `merge_ready`.
- Enforce Torghut profit inventory fuses for `paper_canary` and live capital only after companion Torghut reducers are
  present.

## Rollback

- Disable activation-fuse enforcement and keep shadow inventory visible.
- Preserve material evidence product emission and existing action receipts.
- Do not expand RBAC as an emergency bypass.
- If catalog stats prove too stale for a product, fall back to product `observe_only` and require a targeted bounded
  projection before enforcement resumes.
- If false holds block repair dispatch, keep only `dispatch_repair` exempt for the named fuse owner.

## Risks

- The ledger can become noisy if optional producers are not modeled separately from required producers.
- Table statistics can be stale; enforcement must start in shadow and use exact counts only for small bounded tables.
- A disabled heartbeat can be legitimate during split-topology deployments; expected-state source refs must be precise.
- Torghut consumers may overreact to Jangar activation holds unless zero-notional observe remains available.
- If product ids and fuse ids diverge, deployers will lose the audit chain.

## Handoff To Engineer

Implement the activation inventory as a pure reducer first. Use the current evidence as fixtures: agents deployments
available, three disabled controller heartbeats, fresh AgentRun projections, `37` failed pods, large quant cache
tables, zero simulation rows, and Torghut zero active executions/hypotheses. Keep the first PR read-only and
feature-flagged.

Acceptance gates:

- Tests prove each current evidence mismatch maps to exactly one fuse.
- Status payloads include producer ids, source refs, decision, reason codes, and rollback targets.
- No full scan of `quant_pipeline_health` or `quant_metrics_series` is introduced.
- No broad RBAC, CNPG exec, or Secret listing is required for the reducer.

## Handoff To Deployer

Deploy shadow mode first. Treat activation inventory as explanatory until one full rollout window proves stable. Do
not widen deploy or capital actions from activation decisions until product ids, fuse ids, and material-action receipt
ids are visible together.

Rollback gate:

- If activation inventory reports a false required-producer hold, disable enforcement and keep the shadow ledger for
  audit.
- If a real expected heartbeat remains disabled for more than one TTL after deploy, stop `dispatch_normal` and open a
  repair PR against the producer owner before widening.
