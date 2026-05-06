# 111. Jangar Negative Evidence Router And Action SLO Budgets (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane resilience, safer rollout behavior, evidence freshness, negative-evidence routing, Torghut
profit handoff, and action-class SLO budgets.

Companion Torghut contract:

- `docs/torghut/design-system/v6/115-torghut-proof-spend-market-and-negative-evidence-consumer-2026-05-06.md`

Extends:

- `110-jangar-gitops-convergence-escrow-and-promotion-evidence-ledger-2026-05-06.md`
- `109-jangar-promotion-escrow-replay-cells-and-consumer-parity-gates-2026-05-06.md`
- `104-jangar-quant-evidence-clearinghouse-and-capital-action-firewall-2026-05-06.md`

## Decision

I am selecting a **negative evidence router with action SLO budgets** as the next Jangar control-plane architecture
step.

The current cluster is not in a simple outage state. Jangar is serving, `deployment/jangar` is rolled out, Agents
controllers are rolled out, Torghut live and sim are rolled out, and Jangar's own control-plane status says the
database is configured, connected, healthy, and migration-consistent. The same run still shows negative evidence that
operators should not have to reconcile by hand: the `agents` namespace has `32` failed/error pods, recent readiness
probe failures on `agents` and `agents-controllers`, `140` completed pods retained as audit debt, and `10` failed
AgentRuns in the control-plane summary. Torghut has HTTP `200` `/healthz`, but HTTP `503` `/readyz` because live
submission is disabled, empirical jobs are degraded, and no hypothesis is promotion eligible. Market context for
`AAPL` is degraded with stale technicals, fundamentals, news, and regime. Torghut events still show duplicate
ClickHouse PDB matches, Keeper PDB no-pod warnings, and a FlinkDeployment status race.

The selected design makes that negative evidence a routed control-plane input. Jangar should not collapse "service is
available" and "material action is safe" into the same decision. It should issue separate action budgets for
read-only serving, repair dispatch, normal dispatch, deploy widening, merge readiness, Torghut observation, paper
capital, and live capital. Those budgets carry freshness windows, spend limits, downgrade rules, and rollback targets.
The router converts contradictory evidence into scoped budgets instead of global ambiguity.

The tradeoff is one more reducer in the authority path. I accept that because the current failure mode is not lack of
facts. It is facts with different scopes and clocks being interpreted as one Boolean. The control plane needs to route
negative evidence to the action class it actually threatens.

## Evidence Snapshot

All cluster and database assessment for this document was read-only. Direct CNPG cluster listing and database pod exec
were forbidden to the runner service account, so database evidence comes from service-owned projections and source
schema inspection.

### Cluster And Rollout Evidence

- Runtime identity: `system:serviceaccount:agents:agents-sa`.
- The working branch was `codex/swarm-jangar-control-plane-plan`, clean, and based on `origin/main` at
  `a79f36ea78934d3e22213f6d605a25a705670ca9`.
- `kubectl get pods -n jangar -o wide` showed `jangar`, `bumba`, `jangar-db`, Redis, Open WebUI, Alloy, and Symphony
  pods running; `kubectl rollout status -n jangar deployment/jangar` succeeded.
- `kubectl get deployments -n agents -o wide` showed `agents=1/1` and `agents-controllers=2/2`; rollout status for
  `deployment/agents-controllers` succeeded.
- Aggregating `agents` pods by phase/container reason showed `32 Failed/Error`, `8 Running/running`, and
  `140 Succeeded/Completed`.
- Jangar control-plane summary reported `AgentRun total=140`, with `Running=4`, `Succeeded=114`, `Failed=10`, and
  `Template=12`.
- Recent `agents` events included readiness/liveness probe failures for `agents-controllers-785bcd8b8c-276jx`,
  readiness probe failures for `agents-controllers-785bcd8b8c-2lx7v`, and readiness timeouts for `agents`.
- Schedule-runner CronJobs for Jangar and Torghut lanes are present and using image
  `registry.ide-newton.ts.net/lab/jangar:9fd86916@sha256:4d6e590666381d128713dcc1439aadbf7ef565ecf09233d01167a855d3dc4dd7`.
- `kubectl get pods -n torghut -o wide` showed current Torghut live, Torghut sim, Postgres, ClickHouse, Keeper,
  options services, TA services, websocket services, exporters, Alloy, and Symphony running.
- Torghut deployment rollout status succeeded for `torghut-00234-deployment` and `torghut-sim-00316-deployment`.
- Recent Torghut events still included duplicate ClickHouse PodDisruptionBudget matches, Keeper PDB `NoPods`, and a
  FlinkDeployment status modification race.
- PVCs in `agents` and `torghut` namespaces were bound in the read, including the Torghut Postgres PVC and ClickHouse
  PVCs. The current source also has first-class PVC support in the shared Kubernetes resource map.

### Database And Data Evidence

- Direct `kubectl cnpg psql` and direct `kubectl exec` into `jangar-db-1` and `torghut-db-1` were forbidden:
  `system:serviceaccount:agents:agents-sa` cannot create `pods/exec` in the `jangar` or `torghut` namespaces, and
  cannot list `clusters.postgresql.cnpg.io`.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported database `configured=true`,
  `connected=true`, `status=healthy`, `latency_ms=17`, `registered_count=28`, `applied_count=28`,
  `unapplied_count=0`, and latest applied migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- The same Jangar status reported valid shadow failure-domain leases for `database`, `route`, `rollout`, `registry`,
  `storage`, `workflow_artifact`, `nats`, and `source_schema`; it allowed `dispatch_normal`, `deploy_widen`,
  `merge_ready`, and `torghut_capital` in shadow.
- Torghut `/db-check` returned HTTP `200`, schema current at expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, `schema_graph_lineage_ready=true`, and `account_scope_ready=true`.
- Torghut `/db-check` still warned about historical migration parent forks at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/healthz` returned HTTP `200`, while `/readyz` returned HTTP `503` with `status=degraded`.
- Torghut `/readyz` reported Postgres, ClickHouse, Alpaca, database schema, and Jangar universe healthy; it also
  reported `live_submission_gate.allowed=false`, `reason=simple_submit_disabled`, `capital_stage=shadow`,
  `promotion_eligible_total=0`, and `rollback_required_total=3`.
- Jangar typed quant health reported a fresh global latest-metrics projection:
  `latestMetricsUpdatedAt=2026-05-06T10:24:07.173Z`, `latestMetricsCount=3780`, and
  `metricsPipelineLagSeconds=1`.
- The quant alerts endpoint still returned open critical `metrics_pipeline_lag_seconds` alerts for stale scoped
  strategy/window tuples opened on 2026-05-05.
- Market-context health for `AAPL` returned `overallState=degraded`; all four domains were stale, with technicals and
  regime roughly `137127` seconds old, fundamentals roughly `4740105` seconds old, and news roughly `4373291`
  seconds old.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is still a high-risk module at `2883` lines and
  owns schedules, runner ConfigMaps, CronJobs, swarm admission, requirement launches, freeze state, workspace PVC
  lifecycle, and watches.
- `services/jangar/src/server/primitives-kube.ts` is `690` lines and now includes first-class
  `PersistentVolumeClaim`, `persistentvolumeclaim`, `persistentvolumeclaims`, `pvc`, and `pvcs` built-in targets.
- `services/jangar/src/server/control-plane-status.ts` is `629` lines and composes controller health, runtime
  adapters, database status, watch reliability, workflows, empirical services, failure-domain leases, execution trust,
  runtime admission, and rollout health into the status surface operators consume.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` is `780` lines and currently reduces local
  database, route, rollout, registry, storage, workflow artifact, NATS, and source-schema facts into shadow holdbacks.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` and the 2026-05-05 Kysely migrations define the durable
  latest-metrics and pipeline-health indexes needed for account/window quant projections.
- `services/torghut/app/main.py` is `4051` lines and remains the main Torghut route/readiness/status assembly point.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4288` lines and owns market-context observations,
  rejection accounting, LLM decision context, signal continuity, and order-submission preparation.
- Tests already cover PVC resource-map behavior, supporting-primitives PVC reconciliation, control-plane status,
  failure-domain leases, Torghut market-context staleness, Torghut DB schema/account checks, quant-health ingestion, and
  submission-council quant health. The missing system-level regression is a reducer that proves negative evidence is
  downgraded by action class instead of ignored by green rollout.

## Problem

Jangar has outgrown a single green/red control-plane answer.

The current state has several true statements that conflict operationally:

1. Jangar and Agents deployments are rolled out.
2. Jangar database and source-schema projections are healthy.
3. Failure-domain leases are valid in shadow.
4. Agents has retained failed pod and AgentRun debt plus recent controller probe failures.
5. Torghut is routable but not ready for live material action.
6. Market context and scoped quant alerts are stale enough to invalidate capital decisions.
7. Direct database access from the worker lane is intentionally not available, so service-owned projections are the
   only portable database evidence.

The current architecture can name many of these facts, but it does not yet allocate action budgets from them. A failed
historical verify run should not block read-only serving. A current controller readiness timeout should reduce dispatch
budget. Stale market context should not block Jangar repair work, but it should hold live capital. Duplicate PDB
selection warnings should not stop observation, but they should be negative rollout evidence before data-plane widening.

The failure mode is unscoped negative evidence. When negative evidence is not routed, teams either ignore it because a
deployment is green or overreact by freezing repair lanes that would close the evidence gap.

## Alternatives Considered

### Option A: Keep Failure-Domain Leases As The Final Router

This option extends the current failure-domain lease model and adds more reason codes for failed pods, readiness probe
failures, quant alerts, and market-context staleness.

Pros:

- Reuses the existing lease set and holdback vocabulary.
- Smallest implementation increment.
- Keeps deployer status surfaces familiar.

Cons:

- Failure-domain leases are domain availability, not action capacity.
- They can allow `torghut_capital` in shadow while Torghut `/readyz` is degraded and market context is stale.
- They do not express action budgets, spend limits, or time-boxed repair authority.
- They risk becoming a catch-all reducer with unclear semantics.

Decision: reject as the target. Failure-domain leases remain inputs to the router.

### Option B: Global Brownout On Any Current Negative Evidence

This option freezes normal dispatch, deploy widening, merge readiness, and capital actions whenever current probe
failures, failed pods, stale data, or data-plane warnings are observed.

Pros:

- Very conservative.
- Easy to explain during incidents.
- Prevents accidental live widening during ambiguous states.

Cons:

- Blocks proof repair and bounded dispatch that are required to retire the negative evidence.
- Treats old failed AgentRuns the same as current failed dispatch.
- Makes Torghut less profitable by stopping shadow and repair loops during recoverable stale-data windows.
- Encourages manual exceptions because the system cannot distinguish action classes.

Decision: keep as an emergency posture only.

### Option C: Negative Evidence Router With Action SLO Budgets

This option introduces a reducer that consumes positive and negative evidence, then emits action budgets by action
class and consumer. It downgrades or holds only the actions threatened by the evidence.

Pros:

- Separates serving, observation, repair, normal dispatch, deploy widening, merge readiness, paper capital, and live
  capital.
- Converts contradictory evidence into explicit budget reductions instead of ambiguous global state.
- Lets repair lanes stay open while live capital and widening stay held.
- Gives Torghut one typed negative-evidence contract to consume before sizing.
- Produces testable acceptance gates for engineer and deployer stages.

Cons:

- Adds a new reducer and persistence/projection contract.
- Requires careful stale-vs-current windows so retained audit debt does not permanently brown out the system.
- Requires deployers to inspect budgets, not only deployment rollout state.

Decision: select Option C.

## Architecture

Jangar adds a `negative_evidence_router` that produces `action_slo_budget` records.

```text
negative_evidence_router
  router_epoch_id
  generated_at
  evidence_window
  positive_evidence_refs
  negative_evidence_refs
  contradiction_refs
  source_schema_ref
  database_projection_ref
  gitops_convergence_ref
  failure_domain_lease_refs
  consumer_refs
```

```text
action_slo_budget
  budget_id
  router_epoch_id
  action_class             # serve_readonly, dispatch_repair, dispatch_normal, deploy_widen,
                           # merge_ready, torghut_observe, paper_canary, live_micro_canary, live_scale
  consumer                 # jangar, agents, torghut, torghut-sim, deployer, engineer
  scope                    # namespace, swarm, schedule, account, strategy, window, or release digest
  decision                 # allow, observe_only, repair_only, shadow_only, hold, block
  max_dispatches
  max_runtime_seconds
  max_notional
  max_error_budget_spend
  fresh_until
  downgrade_reasons
  blocked_reasons
  required_repairs
  rollback_target
```

The router classifies negative evidence into five groups:

- `current_runtime_negative`: recent readiness/liveness failures, currently failed pods, active failed jobs, rollout
  unavailability, image pull failures, or watch restart/error bursts.
- `retained_audit_negative`: completed or historical failed AgentRuns/jobs kept for audit.
- `data_freshness_negative`: stale market context, empty or stale latest quant metrics, stale empirical jobs, stale
  DB/cache projections.
- `source_schema_negative`: unapplied/unexpected migrations, schema lineage errors, missing resource aliases, or
  source/test gaps tied to a material action.
- `rollout_ambiguity_negative`: duplicate PDB matches, out-of-sync GitOps resources, data-plane status races, or
  consumer route/deployment disagreement.

Routing rules:

- `serve_readonly` can remain `allow` when route and database projections are healthy, even if retained audit debt
  exists.
- `dispatch_repair` can remain `allow` or `repair_only` when the repair directly targets the active negative evidence
  and has a bounded runtime budget.
- `dispatch_normal` is downgraded to `repair_only` when current controller probe failures or active failed jobs cross
  the configured window.
- `deploy_widen` is held on rollout ambiguity, GitOps drift, image pull failures, data-plane PDB ambiguity, or
  degraded watch reliability.
- `merge_ready` requires database/schema projection healthy, required tests green, and no unresolved design-review
  blocker; retained audit failures can be referenced but do not block by themselves.
- `torghut_observe` can remain `allow` when the action is read-only and proof-producing.
- `paper_canary` requires fresh quant evidence for the account/window, fresh empirical proof for the strategy family,
  and no active rollout ambiguity for the serving lane.
- `live_micro_canary` and `live_scale` require paper settlement plus clean market-context, quant, broker, rollback, and
  rollout budgets.

The router is intentionally pessimistic about capital and optimistic about bounded repair. It should not turn stale data
into a live hold forever; it should emit the smallest repair budget needed to refresh the data.

## Implementation Scope

Engineer stage owns:

1. Add a pure reducer under `services/jangar/src/server/` that accepts current status inputs and emits
   `action_slo_budget` records.
2. Extend the control-plane status projection with `negative_evidence_router` and `action_slo_budgets` in observe mode.
3. Add reducer tests for the current evidence mix: healthy rollout plus failed AgentRun debt, controller probe failure,
   stale market context, open quant alerts, and Torghut readiness `503`.
4. Add a test proving retained audit failures do not block `serve_readonly` or bounded `dispatch_repair`.
5. Add a test proving stale market context and open scoped quant alerts block `live_micro_canary` while allowing
   `torghut_observe`.
6. Add a test proving duplicate PDB or data-plane rollout ambiguity holds `deploy_widen` but not read-only service.
7. Add a Torghut-facing endpoint or status field that exposes only the budgets Torghut needs for sizing decisions.

Deployer stage owns:

1. Run Jangar status in observe mode for one full schedule window and compare budget decisions against existing
   failure-domain leases and dependency quorum.
2. Verify the router sees current negative evidence without direct database or pod-exec privileges.
3. Confirm that repair CronJobs remain allowed while normal dispatch and capital budgets are reduced during fresh
   controller probe failures.
4. Confirm that Torghut consumes the budget before paper or live capital widening.
5. Flip enforcement one action class at a time: `deploy_widen`, then `paper_canary`, then `live_micro_canary`, then
   `live_scale`.

## Validation Gates

Local and CI gates:

- `bunx oxfmt --check` for touched Markdown and any TypeScript implementation.
- Jangar unit tests for the negative-evidence reducer and status projection.
- Existing control-plane status and failure-domain lease tests remain green.
- Torghut API/submission tests remain green when the consumer contract is added.

Runtime gates:

- Jangar control-plane status reports database connected and migration-consistent.
- Torghut `/db-check` reports schema current and account scope ready.
- Negative evidence budgets are present and fresh, with `fresh_until` no more than one schedule window out.
- A retained historical failed AgentRun does not block read-only serving.
- A current controller probe-failure window reduces normal dispatch.
- Stale market context or empty/stale quant latest-store evidence blocks live capital.
- Duplicate PDB or data-plane status-race evidence holds deploy widening until cleared or waived with a rollback
  target.

## Rollout

1. Ship the reducer in observe mode and expose budgets in status.
2. Run one schedule window with no enforcement; compare budgets to current failure-domain leases, dependency quorum,
   Torghut readiness, and human expectations.
3. Enforce only `deploy_widen` and `merge_ready` budgets after shadow parity.
4. Enforce `paper_canary` after Torghut consumes the budget and proves fresh account/window quant evidence.
5. Enforce `live_micro_canary` and `live_scale` only after paper settlement and rollback rehearsal.

## Rollback

- Disable enforcement through one feature flag, returning budgets to observe-only projection.
- Keep `serve_readonly` independent of the router unless route or database projections fail.
- If the router emits bad holds, roll back to failure-domain leases plus dependency quorum while preserving emitted
  budgets as audit evidence.
- If Torghut consumer parsing fails, hold capital locally in Torghut and keep Jangar budgets visible for repair.

## Risks

- Budget windows can become too conservative and starve normal dispatch. Mitigation: enforce action classes one at a
  time and keep repair budgets open.
- Retained audit failures can be misclassified as current runtime negative evidence. Mitigation: require observed-time
  windows and explicit `retained_audit_negative`.
- Torghut may treat a Jangar budget as sufficient for capital. Mitigation: Torghut still requires local broker,
  empirical, quant, market-context, and rollback checks.
- Database projections can be healthy while direct DB access remains forbidden. Mitigation: service-owned projections
  are the contract; direct DB access is audit-only for this lane.

## Handoff Contract

Engineer acceptance is a merged implementation PR that adds the router in observe mode, exposes budgets in Jangar
status, and proves the reducer behavior with tests for the evidence classes above.

Deployer acceptance is a rollout report showing one full schedule window of budgets, the existing status inputs that
fed them, and the exact action class chosen for first enforcement. No deploy widening, paper capital, or live capital
should use the router until that report proves shadow parity and a rollback flag exists.
