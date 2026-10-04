# 98. Jangar Action SLO Budget And Profit Proof Exchange (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar action-class reliability budgets, rollout holdbacks, database freshness evidence, agent workflow
settlement, and Torghut capital proof exchange integration.

Companion Torghut contract:

- `docs/torghut/design-system/v6/102-torghut-profit-proof-exchange-and-capital-slo-budget-2026-05-06.md`

Extends:

- `97-jangar-discover-cutover-handoff-and-proof-debt-gates-2026-05-06.md`
- `96-jangar-observed-action-authority-and-negative-evidence-reclocking-2026-05-06.md`
- `95-jangar-evidence-settlement-slo-and-launch-escrow-runway-2026-05-05.md`
- `75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md`

## Decision

I am choosing an **action SLO budget with a profit proof exchange** as the next Jangar architecture step.

Jangar is no longer in a simple outage posture. The live app pod is serving, the agents API and controller Deployments
are available, controller heartbeats are fresh, the database is reachable through application credentials, and quant
latest metrics are current. At the same time, the system is not clean enough to treat all actions as equivalent. Recent
agents events still show readiness probe timeouts during rollout, verify-stage AgentRuns still have many failures,
Atlas ingestion has long-running rows, and Torghut has fresh options watermarks but no live hypothesis proof chain in
the database. A single green or red readiness answer is too blunt for this state.

The action SLO budget separates the reliability answer by action class. It keeps read-only service and bounded repair
open while it prices normal dispatch, rollout widening, merge readiness, and Torghut paper/live capital against current
failure evidence. The profit proof exchange is the Jangar-facing contract that lets Torghut publish measurable,
account/window-scoped proof before capital can leave shadow.

The tradeoff is deliberate friction. Operators may see `/health` and Deployment status green while Jangar still blocks
normal dispatch or capital. I accept that friction because the live evidence says the control plane can serve, but it
does not yet prove that rollout widening or profit-seeking execution is safe.

## Evidence Snapshot

All assessment was read-only. No Kubernetes resources or database rows were changed.

### Runtime Inputs

- Repository: `proompteng/lab`
- Base branch: `main`
- Head branch: `codex/swarm-jangar-control-plane-plan`
- Runtime date: `2026-05-06`
- `kubectl config current-context` was unset, but namespace-scoped read-only calls succeeded through
  `system:serviceaccount:agents:agents-sa`.

### Cluster And Rollout Evidence

- `kubectl get pods -n jangar -o wide` showed the Jangar serving pod `jangar-7c4bbdd45-sgqpg` at `2/2 Running`.
  Bumba, Symphony, Redis, Open WebUI, Alloy, and `jangar-db-1` were also running.
- `kubectl get deployments -n jangar -o wide` showed `jangar` at `1/1`, using
  `registry.ide-newton.ts.net/lab/jangar:8a50e9da`.
- `kubectl get deployments -n agents -o wide` showed `agents` at `1/1` and `agents-controllers` at `2/2`, both on
  image family `8a50e9da`.
- `kubectl get agentruns -n agents` showed plan/discover/implement work continuing, but verify-stage debt remained:
  failed Jangar verify runs included `b5ddf`, `h9rx7`, `n26px`, `ngtd8`, `rqlm7`, `wbbzk`, and `wppz5`.
- Recent agents events included readiness probe timeouts on older and current rollout pods, including
  `agents-controllers-*` and `agents-*`, plus BackoffLimitExceeded events for verify jobs.
- Torghut pods were broadly running, including live revision `torghut-00226`, simulation revision `torghut-sim-00307`,
  ClickHouse, Keeper, Postgres, TA, options, and guardrail exporters.

### Route Evidence

- `GET http://jangar.jangar.svc.cluster.local/health` returned `status="ok"`.
- The same route reported `agentsController.enabled=false` for the Jangar serving app, so Jangar app health alone is not
  controller authority.
- `GET http://torghut.torghut.svc.cluster.local/` returned HTTP 200 with service `torghut`, status `ok`, version
  `v0.568.5-99-gbc400c770`, and commit `bc400c7709cc114f52d6e90f53c014e2574887ba`.

### Database, Schema, Freshness, And Consistency

- CNPG list and pod exec were blocked by RBAC:
  `clusters.postgresql.cnpg.io is forbidden` and `pods/exec is forbidden`. The run used reflected application
  credentials without printing secret values.
- Jangar SQL connected as user `jangar` to database `jangar` at `2026-05-06T01:23:59.310Z`; Torghut SQL connected as
  `torghut_app` to database `torghut` at `2026-05-06T01:23:59.394Z`.
- Jangar latest applied Kysely migrations include
  `20260505_torghut_quant_pipeline_health_account_window_asof_index`,
  `20260505_torghut_quant_metrics_latest_account_window_index`, and
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar `public.agent_runs` counted 141 `Failed`, 100 `Succeeded`, and 27 `Running` rows, with the newest updates at
  `2026-05-06T01:26:28Z`.
- Jangar `public.agent_run_idempotency_keys` counted 129 failed terminal phases, 97 succeeded terminal phases, and 25
  open keys.
- Jangar `atlas.ingestions` counted 147 `running` rows, with the oldest running ingestion started on
  `2026-05-05T07:17:48.923Z`.
- Jangar `agents_control_plane.component_heartbeats` was fresh: four healthy leader heartbeats from
  `agents-controllers-b69df966c-prxr2`, observed at `2026-05-06T01:26:28.189Z`, expiring at
  `2026-05-06T01:28:28.189Z`.
- Jangar `torghut_control_plane.quant_metrics_latest` had 3,780 rows and newest `as_of` at
  `2026-05-06T01:26:25.075Z`.
- Torghut Alembic head was `0029_whitepaper_embedding_dimension_4096`.
- Torghut options watermarks had 5,085 rows, newest successful timestamp `2026-05-06T01:26:27.508Z`, and max retry
  count `0`.
- Torghut proof and capital tables show the gap: `strategy_hypotheses` had zero rows, `research_runs` held only 48
  skipped rows, and `trade_decisions` was dominated by `rejected` and `blocked` statuses.

### Source And Test Evidence

- `services/jangar/src/server/control-plane-status.ts` already composes controllers, heartbeats, database status,
  rollout health, workflow reliability, watch reliability, execution trust, runtime admission, failure-domain leases,
  and empirical service evidence.
- `services/jangar/src/server/control-plane-workflows.ts` already counts active jobs, recent failed jobs,
  BackoffLimitExceeded conditions, collection confidence, and dependency quorum segments.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` already maps database, rollout, workflow, route,
  and runtime-kit evidence into action-class holdbacks.
- `services/jangar/src/server/supporting-primitives-controller.ts` is the launch choke point for swarm schedules,
  runtime admission, CRD watches, and status reconciliation.
- `services/jangar/src/server/primitives-kube.ts` supports core built-ins plus Jangar custom resources, but the current
  primitive surface still centralizes broad Kubernetes apply/delete authority behind one client abstraction.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` already materializes latest metrics, series, alerts, and
  pipeline health in `torghut_control_plane`.
- Jangar has targeted tests for control-plane status, failure-domain leases, runtime admission, workflow reliability,
  primitive Kubernetes access, and Torghut quant metrics. The missing regression is action-class budget settlement:
  current evidence should allow serve/observe/repair while blocking normal dispatch, widening, merge-ready, and capital.

## Problem

Jangar has a multi-surface truth problem. The serving plane is healthy, the controller plane has fresh heartbeats, the
database plane is current enough to answer, and the trading plane has fresh options watermarks. Those facts are real.
The negative evidence is also real: verify failures are recent, rollout probes have timed out, Atlas ingestion has stale
running rows, and Torghut profit proof is not populated.

The system fails if it collapses those facts into one status:

1. **Serving health can over-authorize.** A green app route cannot authorize controller launch, rollout widening, or
   capital.
2. **Repair and normal dispatch need different budgets.** Repair should run to close proof debt; normal dispatch should
   wait for better reliability settlement.
3. **Database reachability is not data quality.** Jangar migrations and heartbeats are fresh while old Atlas ingestions
   and failed AgentRuns remain unresolved.
4. **Torghut capital needs measurable proof, not liveness.** Fresh options watermarks and broker route health do not
   prove a hypothesis can profit after costs.
5. **Deployer rollback needs a single contract.** Events, SQL counts, and route results must map to action-class gates
   with explicit rollback triggers.

## Alternatives Considered

### Option A: Extend The Existing Discover Cutover Receipt Only

Pros:

- Minimal new surface area.
- Keeps the architecture close to the accepted `97` cutover document.
- Fastest implementation if engineer work only needs a receipt payload.

Cons:

- Leaves dispatch, rollout, merge, and capital budgets as implicit fields inside one receipt.
- Does not give Torghut a first-class exchange for measurable profit proof.
- Makes it harder to reopen repair while keeping capital closed.

Decision: reject as the main direction. The cutover receipt remains a required input, but not the whole architecture.

### Option B: Global Brownout Governor

Pros:

- Simple operational rule: degraded evidence turns off all non-read-only work.
- Strong safety posture during unknown failure windows.
- Easy to reason about in an incident.

Cons:

- Blocks the repair work required to clear proof debt.
- Treats stale Torghut profit proof like a Jangar serving outage.
- Encourages manual bypasses when teams need targeted repair.

Decision: reject as steady state. Keep it as an emergency override.

### Option C: Action SLO Budget And Profit Proof Exchange

Jangar materializes an action SLO budget by action class, consumes failure-domain leases and proof receipts, and admits
Torghut capital only through a measurable profit proof exchange.

Pros:

- Separates serve, observe, repair, normal dispatch, rollout, merge, paper capital, and live capital.
- Makes negative evidence explicit and expiring.
- Keeps least-privilege evidence sufficient for audit.
- Gives engineer and deployer stages concrete gates.
- Creates a path for Torghut to earn capital through hypotheses that prove edge after cost and risk.

Cons:

- Requires a new status projection and tests.
- Requires shared action-class vocabulary between Jangar and Torghut.
- Requires care to avoid an ever-growing receipt corpus.

Decision: select Option C.

## Chosen Architecture

### ActionSloBudget

Jangar adds an action budget projection to the control-plane status payload:

```text
action_slo_budget
  budget_id
  namespace
  generated_at
  fresh_until
  producer_revision
  evidence_window_seconds
  action_classes[]
  budget_debits[]
  budget_credits[]
  admission_decisions[]
  rollback_triggers[]
  source_refs[]
```

Initial action classes:

- `serve_readonly`: UI, status routes, read-only API, and audit views.
- `observe`: status projection, metrics reads, route digest reads, and database freshness reads.
- `dispatch_repair`: bounded AgentRuns or schedules that name a proof debt target.
- `dispatch_normal`: recurring swarm work without a debt target.
- `deploy_widen`: promotion to broader rollout, higher concurrency, or larger controller scope.
- `merge_ready`: marking an architecture or implementation PR ready after checks.
- `torghut_shadow_capital`: zero-notional or shadow-only hypothesis work.
- `torghut_paper_capital`: paper execution with real broker order flow.
- `torghut_live_capital`: real capital.

### Budget Debits

The current state creates these initial debits:

- `verify_recent_failures`: recent failed verify AgentRuns block `dispatch_normal`, `deploy_widen`, and `merge_ready`.
- `rollout_probe_tail`: recent readiness probe timeouts block `deploy_widen` until the event window clears.
- `atlas_ingestion_stale`: 147 running ingestions with the oldest on `2026-05-05T07:17:48Z` block merge-ready for
  source-indexing-sensitive work.
- `agentrun_failure_debt`: 141 failed `agent_runs` block normal dispatch widening until classified.
- `torghut_hypothesis_absent`: zero `strategy_hypotheses` rows block paper/live capital.
- `torghut_research_skipped`: only skipped research runs block proof-backed paper/live capital.
- `torghut_reject_dominance`: rejected and blocked trade decisions dominate historical records, requiring a route-level
  rejection-ratio guard before any paper capital widening.

### Budget Credits

The current state grants these credits:

- `serving_route_ok`: Jangar health route is OK.
- `controller_heartbeat_fresh`: four controller heartbeats are fresh and healthy.
- `database_sql_ok`: Jangar and Torghut application SQL connections succeeded.
- `quant_latest_fresh`: Jangar quant latest metrics are fresh at `2026-05-06T01:26:25Z`.
- `torghut_options_watermarks_fresh`: options watermarks are fresh with zero retry count.
- `torghut_route_ok`: Torghut root route returns status OK.

### Admission Decisions For This Evidence Window

- Allow `serve_readonly`.
- Allow `observe`.
- Allow `dispatch_repair` only with a named debt target and bounded concurrency.
- Hold `dispatch_normal`.
- Hold `deploy_widen`.
- Hold `merge_ready` until the PR-specific checks pass and the budget has no merge-blocking debits.
- Allow `torghut_shadow_capital` only when it remains zero-notional and logs proof debt.
- Block `torghut_paper_capital`.
- Block `torghut_live_capital`.

### ProfitProofExchange

Jangar consumes Torghut proof receipts through a compact exchange:

```text
profit_proof_exchange
  exchange_id
  account
  window
  generated_at
  fresh_until
  hypothesis_receipts[]
  data_freshness_receipts[]
  cost_and_reject_receipts[]
  risk_receipts[]
  capital_decisions[]
```

Capital decisions must include:

- hypothesis id and strategy family;
- account and time window;
- sample size and lookback;
- expected edge after fees and slippage;
- reject ratio and quote-quality guard;
- max drawdown and loss stop;
- required market-context domains and freshness;
- quant latest-store digest from Jangar;
- rollback trigger and owner.

## Implementation Scope

Engineer stage:

1. Add a pure `buildActionSloBudget` module that consumes existing control-plane status components.
2. Add action-budget fields to `/api/agents/control-plane/status?namespace=agents` in shadow mode.
3. Add tests for the current evidence shape: serve/observe/repair allowed, normal dispatch/widen/merge/capital held.
4. Add a supporting-primitives admission hook that can read the budget and enforce only `dispatch_repair` first.
5. Add a Torghut proof-exchange client that reads route digests or database projections without requiring privileged
   Kubernetes exec.
6. Add migration-ready schema notes for any durable action-budget history table, but do not persist until shadow parity
   proves the projection is stable.

Deployer stage:

1. Verify Jangar route health, controller heartbeats, and SQL probes before enabling enforcement.
2. Verify action-budget debits match recent events and SQL counts.
3. Enable `dispatch_repair` enforcement for a single swarm, then widen by namespace only after no false holds are
   observed for two evidence windows.
4. Keep paper/live capital disabled until Torghut publishes proof-exchange receipts for a specific hypothesis.
5. Roll back enforcement by disabling the action-budget admission feature flag; keep the shadow projection running for
   audit.

## Validation Gates

- Unit tests cover debit/credit precedence and expiry.
- Control-plane status contract tests include the new action budget in shadow mode.
- Supporting-primitives tests prove normal schedules are held when `dispatch_normal` is blocked and repair schedules with
  debt targets are allowed.
- Torghut proof-exchange contract tests reject missing hypothesis ids, stale market context, missing quant digest, high
  rejection ratio, and drawdown breaches.
- Deployment validation captures:
  - `kubectl get deployments -n jangar -o wide`
  - `kubectl get deployments -n agents -o wide`
  - `kubectl get agentruns -n agents`
  - Jangar SQL status counts
  - Torghut proof-exchange route or SQL projection

## Rollout Plan

1. Ship the builder and status payload in shadow mode.
2. Compare shadow decisions against deployer judgment for two evidence windows.
3. Enforce `dispatch_repair` only for named proof debts.
4. Enforce `dispatch_normal` holds for the plan swarm.
5. Enforce rollout and merge-ready gates after CI and PR checks observe the same budget.
6. Wire Torghut paper capital to proof-exchange receipts.
7. Wire Torghut live capital only after paper evidence passes and rollback drills succeed.

## Rollback

- Disable action-budget admission enforcement with the feature flag and continue emitting shadow budgets.
- If the builder blocks too broadly, fall back to existing failure-domain leases and runtime admission.
- If Torghut proof exchange is stale or unreachable, Jangar must fail closed for paper/live capital but keep observe and
  repair open.
- If controller heartbeats stale while the app route stays green, hold dispatch and rollout but keep read-only serving.

## Risks

- The first implementation may duplicate failure-domain lease logic. The mitigation is a pure builder over existing
  leases, not a second independent classifier.
- Budget expiry can be too aggressive or too sticky. Tests must cover both stale negative evidence and expired positive
  evidence.
- Torghut proof receipts can become another broad status object. The exchange must stay account/window/hypothesis scoped.
- Reading application DB credentials is useful for assessment but not a deployer dependency; production gates should use
  typed routes or service-owned projections.

## Handoff Contract

Engineer acceptance:

- `action_slo_budget` appears in control-plane status in shadow mode.
- Current evidence maps to the admission decisions listed in this document.
- Tests prove repair can proceed while normal dispatch and capital are held.
- No privileged Kubernetes exec or CNPG shell is required for the projection.

Deployer acceptance:

- Shadow budget is observed for two evidence windows.
- Rollout probe tails and verify failures are visible as budget debits.
- Paper/live capital stay blocked until Torghut publishes profit proof receipts.
- Rollback flag is documented and tested before enforcement widens.
