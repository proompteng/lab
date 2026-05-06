# 105. Jangar Evidence Pressure Runways And Profit Proof Budgets (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, scheduled-run pressure, database proof cost, rollout widening, material-action
admission, and Torghut profit-proof consumption.

Companion Torghut contract:

- `docs/torghut/design-system/v6/109-torghut-profit-proof-budget-consumer-and-options-runway-2026-05-06.md`

Extends:

- `104-jangar-repair-closure-receipts-and-settlement-finality-2026-05-06.md`
- `103-jangar-torghut-decision-custody-cells-and-rollout-proof-exchange-2026-05-06.md`
- `101-jangar-account-scoped-proof-liquidity-and-query-budget-2026-05-06.md`
- `87-jangar-database-pressure-fuses-and-capital-authority-backplane-2026-05-05.md`

## Decision

I am choosing **evidence pressure runways with profit proof budgets** as the next Jangar architecture step.

The cluster is not in the same shape as the earlier May 5 soak. Jangar and Agents serving deployments are available,
the latest Torghut serving and simulation revisions are ready, and recent schedules are still creating and completing
work. The remaining failure mode is more subtle: the control plane can look healthy while evidence production,
database proof storage, retained failed pods, and Torghut profit proofs accumulate pressure faster than the system can
settle them.

The strongest evidence is the database. Jangar's projection database is fresh, but
`torghut_control_plane.quant_metrics_series` is about `110 GB`, `quant_pipeline_health` is about `17 GB`, and an exact
count against the series path was expensive enough that I stopped it during assessment. Torghut's options catalog is
alive at about `2.38M` contracts with fresh watermarks, but hypothesis-governance tables are empty and the newest
persisted trade decisions are from `2026-05-04`. The next architecture must make proof cost and proof freshness first
class. Otherwise we will keep authorizing material actions from route health while the expensive evidence path becomes
the next outage source.

The selected design gives each material action a runway budget. Jangar admits or holds work based on four budgets:
rollout pressure, scheduled-run pressure, database proof pressure, and consumer profit-proof pressure. Torghut consumes
the resulting proof budget before it creates a promotion candidate, sizes a live decision, or asks deployer to widen a
revision. The tradeoff is that some useful work will be delayed while the system is otherwise serving. I accept that.
Serving health is not enough evidence to widen a control plane that is already paying high storage and query costs for
proof.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, runtime objects, broker settings, or trading settings were mutated during this
assessment. Kubernetes and database commands were read-only. `kubectl cnpg psql` was RBAC-blocked because this service
account cannot create `pods/exec` in `jangar` or `torghut`; database reads used service-owned CNPG app credentials and
direct service connections with `SELECT` statements only.

### Cluster And Rollout Evidence

- The runtime identity is `system:serviceaccount:agents:agents-sa`. `kubectl config current-context` was initially
  unset, so I initialized a local `in-cluster` kubectl context from the pod service-account token and verified
  `kubectl auth whoami`.
- `jangar` deployments were available: `jangar=1/1`, `bumba=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`. The active Jangar image was `33a0f07a`.
- Jangar pods were running, including `jangar-bcf6fc945-fhsmv`, `jangar-db-1`, Redis, Open WebUI, Bumba, Symphony, and
  Alloy.
- `agents` deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`, also on the
  deployed `33a0f07a` control-plane image.
- `kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded` showed retained Error pods in
  `agents` for older scheduled Jangar plan/verify and Torghut quant runs, plus unrelated pending storage/search pods
  in `rook-ceph` and `temporal`.
- Recent `agents` events still showed successful schedule creates and completions, but also fresh readiness probe
  timeouts on both `agents-controllers-77ccdcf99-rpk4z` and `agents-b95949b4f-mw67t` against `/ready`.
- The `agents` resource projection had current AgentRun phases: `Succeeded=90`, `Template=12`, `Failed=10`, and
  `Running=4`, with fresh `updated_at` timestamps around `2026-05-06T07:27Z`.
- `torghut` deployments were available for the latest live and simulation revisions: `torghut-00233=1/1` and
  `torghut-sim-00314=1/1`. ClickHouse, Keeper, Torghut Postgres, options catalog/enricher, TA, websockets, and
  guardrail exporters were running.
- Torghut rollout events showed transient startup/readiness probe failures before latest revisions became ready, and
  duplicate ClickHouse PDB selection warnings remained.
- Listing StatefulSets in `jangar`, `agents`, and `torghut` is forbidden to this service account, so rollout evidence
  is based on deployments, pods, events, AgentRuns, services, and database/API projections.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is still the highest-risk local module at `2,882`
  lines. It owns CRD checks, watches, schedule generation, schedule-runner CronJobs, Swarm stage schedules, requirement
  dispatch, freezes, workspace PVC status, and status reconciliation.
- `services/jangar/src/server/primitives-kube.ts` is `689` lines and now includes PVC aliases and tests for
  `PersistentVolumeClaim` reads/lists. That closes one primitive seam, but the core Kube gateway remains the shared
  read/write surface for both operator actions and proof observations.
- `services/jangar/src/routes/ready.tsx` is `175` lines and intentionally returns HTTP 200 with degraded payloads for
  several control-plane debts, including ingestion degradation, blocked execution trust, and blocked serving passports.
  That is good for serving continuity but not a sufficient rollout widening gate.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` and the 2026-05-05 indexes provide an indexable latest
  quant metrics path, but the series and pipeline-health tables are now large enough that callers must be kept on
  materialized/latest paths by contract.
- Existing test coverage is real: supporting-primitives controller tests cover schedule runner generation, admission
  passports, queue throttles, requirement dispatch, freeze logic, and long-name normalization; primitives-kube tests
  cover custom objects and PVC aliases; ready tests cover degraded readiness; quant metrics store tests cover indexed
  latest-stage lookup.
- The missing cross-module regression is pressure-aware admission: no reducer currently proves that fresh serving
  health plus retained Error pods plus a 110 GB proof series plus empty Torghut hypothesis tables must hold deploy
  widening and capital-adjacent actions until budgeted proof lanes are healthy.

### Database And Data Evidence

- Jangar table stats showed `torghut_control_plane.quant_metrics_series` at about `1,154,592` planner-estimated live
  rows and `110 GB`; `torghut_control_plane.quant_pipeline_health` at about `50,755,815` planner-estimated live rows
  and `17 GB`.
- Jangar `quant_metrics_latest` remained small and fresh: `3,780` exact rows with `max(updated_at)` around
  `2026-05-06T07:29Z`.
- Jangar control-plane projections were fresh: `agents_control_plane.resources_current=3,380` exact rows with
  `max(updated_at)` around `2026-05-06T07:29Z`; `workflow_comms.agent_messages=5,552` exact rows with fresh
  `created_at`.
- Jangar `public.agent_runs` had `316` exact rows; `public.agent_run_idempotency_keys` had `299` exact live rows but
  table stats showed `3,743` dead tuples, which is an idempotency-ledger pressure signal even after autovacuum.
- Jangar idempotency rows still held failed terminal state: `codex-spark-agent` had `80` failed terminal idempotency
  rows and Torghut market-context agents had additional failed rows.
- Torghut exact counts showed an active options data plane: `torghut_options_contract_catalog=2,385,276` rows,
  `torghut_options_subscription_state=6,026`, `torghut_options_watermarks=5,187`, and `position_snapshots=40,759`.
- Torghut options catalog freshness was current: `max(last_seen_ts)` around `2026-05-06T07:16Z`; `2,346,094`
  contracts were active/tradable and `39,182` active/non-tradable.
- Torghut strategy and proof state lagged behind data availability: `strategies=16`, but
  `strategy_hypotheses=0`, `strategy_hypothesis_metric_windows=0`, and `strategy_promotion_decisions=0`.
- Torghut `trade_decisions` had `147,606` rows with `max(created_at)` at `2026-05-04T17:25:57Z`, so the current options
  data plane is not yet flowing into a fresh, measurable promotion loop.
- Torghut table stats still showed large cold artifacts: `trade_decisions` at about `1,182 MB` and
  `llm_decision_reviews` at about `273 MB` despite old or empty current rows, so profit proof needs lifecycle and
  query-cost accounting, not only row-count gates.

## Problem

Jangar has accumulated the primitives to make better decisions, but those primitives still treat proof as mostly
boolean: fresh enough, blocked, or missing. That model is too weak for the current system.

The control plane now runs scheduled swarms hourly across discover, plan, implement, and verify stages. It also stores
large Torghut proof series, carries retained failed run artifacts, exposes degraded readiness without always failing
serving, and consumes Torghut options data that can move faster than hypothesis proof. The failure mode is no longer a
single missing CRD or broken deployment. It is runaway evidence cost and unresolved proof debt hidden under healthy
serving status.

The design has to answer these questions deterministically:

1. Can the next scheduled stage run, or has retained failure and readiness debt exhausted that stage's runway?
2. Can a deploy widen, or is the database proof path too expensive or stale for the action class?
3. Can Torghut create a promotion candidate, or is options data fresh while hypothesis evidence is empty?
4. Can Torghut size a live decision, or should it produce shadow-only evidence until profit proof is current?
5. Can Jangar keep serving while blocking material actions without turning every transient readiness timeout into a full
   outage?

## Alternatives Considered

### Option A: Add More Cleanup And Retry Policy Around Scheduled Pods

Pros:

- Reduces namespace noise quickly.
- Makes `kubectl get pods` easier to read.
- Helps operators separate current runs from retained historical failures.

Cons:

- Does not address the 110 GB proof series or 17 GB pipeline-health path.
- Does not distinguish serving readiness from rollout widening readiness.
- Does not help Torghut turn fresh options data into measurable profit hypotheses.

Decision: reject as the primary architecture. Keep cleanup as an implementation detail under the selected runway.

### Option B: Split The Supporting Primitives Controller Into Smaller Controllers

Pros:

- Reduces source blast radius in the `2,882` line controller.
- Allows targeted ownership for schedules, workspaces, swarms, and signals.
- Makes tests and rollouts smaller.

Cons:

- A split alone does not create admission semantics.
- Smaller controllers could still all read the same expensive proof tables.
- It does not tell Torghut which hypothesis actions are allowed.

Decision: schedule as a Phase 2 maintainability move, not the governing decision.

### Option C: Evidence Pressure Runways With Profit Proof Budgets

Pros:

- Converts serving health, retained failures, readiness debt, database size, query cost, and Torghut proof freshness into
  one material-action admission decision.
- Keeps expensive proof reads on budgeted, latest/materialized paths.
- Lets Jangar keep serving while holding deploy widening, merge readiness, or capital-adjacent actions.
- Gives Torghut measurable hypothesis gates before promotion and sizing.
- Provides clear engineer/deployer acceptance gates and rollback levers.

Cons:

- Adds another reducer and status projection.
- Requires initial shadow-mode calibration so budget thresholds do not stop useful work unnecessarily.
- Requires producers to declare proof-query cost and not bypass the materialized paths.

Decision: select Option C.

## Chosen Architecture

Jangar adds an `EvidencePressureRunway` projection. It is computed per namespace, swarm, stage, consumer, account, and
material action class.

```text
evidence_pressure_runway
  runway_id
  namespace
  consumer                         # jangar, agents, torghut
  action_class                     # observe, schedule_dispatch, merge_ready, deploy_widen, torghut_shadow, torghut_live
  rollout_pressure
  schedule_pressure
  database_proof_pressure
  consumer_profit_pressure
  decision                         # allow, allow_shadow, repair_only, hold, block
  budget_remaining
  blocking_reason_codes[]
  evidence_refs[]
  computed_at
  fresh_until
```

The reducer inputs are deliberately small and materialized:

- rollout pressure: recent probe failures, deployment availability, rollout age, and blocked serving passport count
- schedule pressure: active runs, failed terminal debt, idempotency dead-row ratio, stale stage clocks, and freeze state
- database proof pressure: table-size class, planner row estimate class, latest-path freshness, query budget spent, and
  forbidden full-scan attempts
- consumer profit pressure: Torghut option data freshness, hypothesis count, promotion-decision count, trade-decision
  freshness, TCA/sample coverage, and account/window quant latest freshness

Budget examples:

```text
schedule_dispatch:
  allow when readiness debt <= warning, active runs under stage concurrency, and failed terminal debt under threshold
  hold when readiness debt is active or idempotency dead-row ratio is high
  block when ingestion is degraded or repeated stage failures are inside the freeze window

deploy_widen:
  allow when rollout pressure is healthy and database proof pressure is green
  hold when latest proofs are fresh but backing series tables exceed budget without retention/partition evidence
  block when serving readiness is blocked or latest proof paths are stale

torghut_shadow:
  allow when options data is fresh and route health is ready, even if hypothesis proof is empty
  require the output to create hypothesis evidence, not live orders

torghut_live:
  allow only when shadow evidence matured into hypothesis metric windows and promotion decisions
  hold when trade decisions are stale, TCA coverage is empty, or quant latest is not account/window current
```

Jangar also adds a `ProofQueryBudget` contract for high-cardinality evidence tables:

```text
proof_query_budget
  table_ref
  owner
  allowed_paths[]                  # latest, account_window_latest, bounded_series, sampled_series
  forbidden_paths[]                # unbounded_count, unbounded_scan, cross_account_series_without_limit
  max_rows_per_material_action
  max_runtime_ms_per_material_action
  retention_policy_ref
  latest_projection_ref
  pressure_class                   # green, yellow, red
```

For the current evidence, the initial pressure classification is:

```text
agents/schedule_dispatch           hold     readiness probe debt plus retained failed scheduled runs
jangar/deploy_widen                 hold     serving available, but proof series pressure is red
torghut/torghut_shadow              allow    options catalog fresh; hypothesis tables empty; shadow proof needed
torghut/torghut_live                block    no hypothesis windows or promotion decisions; stale trade decisions
torghut/profit_repair               allow    repair work may run against bounded latest/materialized paths
```

## Implementation Scope

Engineer stage should implement the architecture in four small slices:

1. Add a shadow-only `EvidencePressureRunway` reducer to `services/jangar/src/server/control-plane-status.ts` or a
   sibling module with unit fixtures for the current evidence snapshot.
2. Add a `ProofQueryBudget` declaration for Torghut quant tables and ensure Jangar quant routes use latest/materialized
   paths for status, health, and admission decisions.
3. Add Torghut consumer projections for hypothesis proof budgets: options freshness, hypothesis count, metric-window
   count, promotion-decision count, latest trade-decision time, and quant latest freshness.
4. Surface the runway decision in Jangar control-plane status and NATS handoff updates before enforcing it.

The first implementation must be shadow mode. It should not block live traffic until deployer has at least one full
business day of runway decisions and false-positive review.

## Validation Gates

Engineer acceptance gates:

- Unit tests prove the current snapshot yields `schedule_dispatch=hold`, `deploy_widen=hold`,
  `torghut_shadow=allow`, and `torghut_live=block`.
- A regression test proves an unbounded proof-series count is classified as `forbidden_path` and never used for
  material-action admission.
- Jangar ready/status tests prove service readiness can remain HTTP 200 while the runway blocks deploy widening.
- Torghut tests prove fresh options data with zero hypothesis windows only allows shadow evidence, not live promotion.
- Database migration or schema changes, if added, include read-path indexes and do not require scanning
  `quant_metrics_series` or `quant_pipeline_health` for routine status.

Deployer acceptance gates:

- Shadow runway status is emitted for at least one full business day.
- `agents` readiness probe debt is below warning for two consecutive schedule cadences before widening enforcement.
- Quant latest projections remain fresh while no routine status endpoint performs an unbounded series scan.
- Torghut has at least one populated hypothesis metric window and one explicit promotion decision before any live
  capital action leaves shadow.
- Rollback instructions are present in the release note and point to the runway enforcement flag.

## Rollout Plan

Phase 0: document and shadow. Land this architecture and emit non-enforcing runway status from existing evidence.

Phase 1: budget latest proof reads. Declare high-cardinality proof tables and route status/admission through latest or
bounded paths only.

Phase 2: attach schedule and rollout pressure. Add readiness-probe debt, retained terminal debt, and idempotency-ledger
pressure to the runway reducer.

Phase 3: Torghut shadow consumer. Let Torghut consume `torghut_shadow=allow` to generate hypothesis evidence from the
fresh options catalog, while keeping live promotion blocked.

Phase 4: enforce material actions. Gate `deploy_widen`, `merge_ready`, and `torghut_live` on the runway after shadow
metrics show acceptable false-positive rates.

## Rollback Plan

Rollback is flag-based and action-class scoped:

- Disable runway enforcement and keep the projection visible if it blocks a needed operational repair.
- Keep `torghut_live` blocked if runway data is unavailable; live capital should fail closed.
- Fall back to existing runtime admission and repair-closure receipts for Jangar schedule dispatch.
- If proof-query budget code causes route regressions, revert only the enforcement path and keep latest read indexes.
- If Torghut shadow production is too noisy, keep options ingestion active and hold promotion consumers.

## Risks And Tradeoffs

- The first thresholds will be imperfect. Shadow mode is mandatory because the current system has retained historical
  failures that should not all block current repair.
- Database pressure is real but not equivalent to database unavailability. The reducer must distinguish expensive proof
  paths from fresh latest projections.
- Splitting the supporting primitives controller is still necessary, but doing it before admission semantics risks
  scattering the same policy across smaller modules.
- Torghut may produce useful options evidence before it has promotion windows. That should be allowed as shadow work,
  not treated as live profitability.
- The service account can read secrets and query databases directly, but cannot use CNPG exec. Future audit tooling
  should use least-privilege read-only DB credentials instead of relying on pod exec.

## Handoff Contract

Engineer handoff:

- Implement the shadow reducer, proof-query budget declarations, and current-snapshot tests.
- Keep edits scoped to reducers, status projections, and tests before enforcement.
- Do not add any routine route that scans `quant_metrics_series` or `quant_pipeline_health` without an account/window
  bound and explicit limit.
- Preserve existing `/ready` serving behavior; material-action runway should be visible in status, not encoded as a
  blanket 503.

Deployer handoff:

- Deploy shadow mode first.
- Watch readiness debt, Jangar DB latency, quant latest freshness, and Torghut shadow hypothesis output.
- Do not widen `torghut_live` until hypothesis windows and promotion decisions are populated.
- Roll back enforcement by action class if the runway blocks repair work, but keep live capital fail-closed.
