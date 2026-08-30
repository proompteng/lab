# 103. Jangar Material Action Settlement Board And Profit Repair Gates (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, failure-domain lease settlement, dependency quorum precedence, rollout safety,
workflow dispatch, merge readiness, deploy widening, and Torghut capital-adjacent action gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/107-torghut-profit-repair-roi-ledger-and-capital-settlement-gates-2026-05-06.md`

Extends:

- `102-jangar-dual-authority-dispatch-ledger-and-capital-proof-firewall-2026-05-06.md`
- `101-jangar-typed-evidence-authority-and-readiness-debt-gates-2026-05-06.md`
- `101-jangar-evidence-provenance-firewall-and-lease-graduation-contract-2026-05-06.md`
- `100-jangar-lease-reconciliation-clock-and-dispatch-expiry-contract-2026-05-06.md`

## Decision

I am choosing a **material-action settlement board with profit repair gates** for Jangar.

The control plane is no longer in the same condition described by the earlier soak. The current Agents, Jangar, and
Torghut serving deployments are running. Jangar's control-plane status projection reports a healthy database connection,
28 applied migrations, fresh rollout-derived authority for `agents-controller` and `supporting-controller`, heartbeat
authority for `orchestration-controller`, healthy execution trust, and valid failure-domain leases in shadow mode.

That recovered state still exposes a more important architecture gap: separate projectors can disagree about the same
material action. Failure-domain leases currently allow `dispatch_normal`, `merge_ready`, `deploy_widen`,
`torghut_observe`, and `torghut_capital`, while dependency quorum returns `block` with reason
`empirical_jobs_degraded`. Torghut live readiness returns HTTP 503 with `simple_submit_disabled`, zero promotion-eligible
hypotheses, and all hypotheses requiring rollback. Torghut simulation returns HTTP 200, but its quant evidence projection
is degraded because the latest metrics store is empty.

The selected architecture makes a new settlement board the only Jangar-owned answer for material actions. Failure-domain
leases, dependency quorum, controller authority, runtime admission, rollout health, database status projections, and
Torghut profit proof become inputs. The board emits one reduced decision per action class: `allow`, `observe_only`,
`repair_only`, `hold`, or `block`. A narrow allow signal remains necessary, but it is never sufficient when another
current projector blocks the same action class.

The tradeoff is explicit friction. Jangar will add one more reducer and a shadowed projection before dispatch widening
or capital-adjacent consumers can rely on it. I accept that cost because the failure mode to remove is worse: a healthy
lease projection authorizing capital or merge readiness while dependency and profit proof say no.

## Read-Only Evidence Snapshot

No Kubernetes resources, database records, trading settings, or runtime objects were mutated during this assessment.

### Cluster And Rollout Evidence

- `kubectl auth whoami` identified the runtime as `system:serviceaccount:agents:agents-sa`.
- Namespaces `agents`, `jangar`, and `torghut` were `Active`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Jangar deployments were available: `jangar=1/1`, `bumba=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`.
- Torghut current live and simulation revisions were available: `torghut-00231-deployment=1/1` and
  `torghut-sim-00312-deployment=1/1`.
- Agents events still recorded old readiness failures on a prior controller replica, followed by a successful rollout.
- Jangar events recorded a recent rollout with transient readiness probe failures before the current pod settled.
- Torghut events recorded transient options readiness failures, an endpoint-slice update timeout, a Flink status
  conflict warning, and successful creation of current live and simulation revisions.
- Agent schedules for Jangar and Torghut discover, plan, implement, and verify lanes were active with staggered hourly
  cron windows.

### Database And Data Evidence

- Direct CNPG cluster reads were RBAC-blocked for this service account.
- Direct `kubectl cnpg psql` and pod exec attempts against Jangar Postgres, Torghut Postgres, and ClickHouse were
  RBAC-blocked. The smallest unblocker is a read-only DB introspection path or narrowly scoped `pods/exec` and CNPG read
  access in the `jangar` and `torghut` namespaces.
- Jangar `/api/agents/control-plane/status` reported `database.status=healthy`, `configured=true`, `connected=true`,
  `latency_ms=6`, migration table `kysely_migration`, 28 registered/applied migrations, and no unapplied or unexpected
  migrations.
- Jangar failure-domain leases were valid in `shadow` mode with `dispatch_normal`, `merge_ready`, `deploy_widen`,
  `torghut_observe`, and `torghut_capital` holdbacks allowing.
- The same Jangar status projection reported `dependency_quorum.decision=block`,
  `dependency_quorum.reason=empirical_jobs_degraded`, and `degradation_scope=global`.
- Jangar empirical services reported jobs degraded with stale `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`.
- Torghut live `/readyz` returned HTTP 503 with database schema current at Alembic head
  `0029_whitepaper_embedding_dimension_4096`, lineage ready, Postgres and ClickHouse healthy, and live submission blocked
  by `simple_submit_disabled`.
- Torghut simulation `/readyz` returned HTTP 200 with the same schema head and healthy service dependencies, but
  Jangar quant evidence was degraded with `latest_metrics_count=0` and no pipeline stages.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes database status, rollout health, workflows, empirical
  services, runtime admission, execution trust, and failure-domain leases. It is the right API boundary for settlement
  exposure.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` already creates action holdbacks, but those
  holdbacks are not the final cross-projector decision.
- `services/jangar/src/server/control-plane-runtime-admission.ts` owns runtime-kit and admission-passport state and
  should feed the settlement board instead of growing another independent gate.
- `services/jangar/src/server/supporting-primitives-controller.ts` is the current high-risk module at 2,882 lines. It
  owns schedule generation, supporting primitive reconciliation, workspace storage, status reconciliation, and launch
  decisions; it should consume a reduced settlement decision rather than re-interpret all readiness surfaces.
- `services/jangar/src/server/primitives-kube.ts` already supports PVC aliases and tests cover PVC read/list behavior;
  the earlier missing-PVC concern is stale in source.
- Schedule-runner source already uses the corrected namespace expression with parentheses; older failed jobs can still
  carry the previous command shape, but source no longer does.
- Jangar has focused tests for control-plane status, heartbeat precedence, failure-domain leases, runtime admission,
  supporting-primitives behavior, and PVC primitives. The missing regression is a cross-surface reducer test that proves
  lease allow, dependency block, runtime admission, and Torghut profit state settle to one deterministic action decision.

### Torghut Consumer Evidence

- Torghut live `/trading/status` returned HTTP 200 with `mode=live`, `pipeline_mode=simple`,
  `execution_lane=simple`, `kill_switch=false`, active revision `torghut-00231`, and `orders_submitted_total=0`.
- Live capital remained shadow-only with `capital_stage_totals.shadow=3`.
- Live submission was not allowed because `simple_submit_disabled` was set and no hypothesis was promotion eligible.
- Torghut simulation was service-ready, but its quant evidence projection was degraded because latest metrics were
  empty.
- Jangar quant health for the live account was not aligned with the simulation account: one account-level query returned
  current generic health with large lag, while the simulation account returned empty latest metrics.

## Problem

Jangar has moved from obvious outage risk to inconsistent-authority risk.

The control plane now has multiple useful reducers: rollout health, controller authority, database migrations,
failure-domain leases, execution trust, empirical dependency quorum, runtime admission, and Torghut-specific proof. Each
reducer is locally reasonable. The system-level problem is that material actions still need one final answer.

The risky cases are concrete:

1. `torghut_capital` can appear allowed by failure-domain leases while dependency quorum blocks globally.
2. `merge_ready` can appear allowed while empirical jobs are stale and Torghut live has zero promotion eligibility.
3. `deploy_widen` can appear allowed after a successful rollout even when recent events show readiness instability.
4. Repair work can be starved if a global block is applied without distinguishing bounded repair from normal dispatch.
5. Operators and later agents must infer precedence from several status payloads instead of reading one action-class
   result.

The architecture must reduce failure modes without freezing repair. It must also give engineer and deployer stages a
testable contract: the same evidence snapshot must always settle to the same action decision.

## Alternatives Considered

### Option A: Let Failure-Domain Leases Remain The Final Gate

This option treats the existing failure-domain lease holdbacks as the material-action decision. If a lease is valid and
the holdback says allow, dispatch, merge readiness, deploy widening, and Torghut capital consumers proceed.

Pros:

- Minimal implementation cost.
- Uses an existing Jangar reducer and status payload.
- Keeps throughput high while leases are in shadow.

Cons:

- Does not resolve current evidence where leases allow `torghut_capital` while dependency quorum blocks globally.
- Makes Torghut profit proof advisory instead of decisive for capital-adjacent actions.
- Forces supporting-primitives and deployer logic to keep interpreting other projectors themselves.

Decision: reject. Failure-domain leases should stay necessary, but not sufficient.

### Option B: Make Dependency Quorum A Global Hard Freeze

This option lets dependency quorum override every material action whenever it returns `block`.

Pros:

- Very safe for capital and merge readiness.
- Simple to reason about during outages.
- Converts stale empirical jobs into an immediate stop signal.

Cons:

- Blocks the bounded repair jobs needed to clear stale empirical and quant evidence.
- Treats observation, repair, normal dispatch, merge readiness, deploy widening, and capital as one risk class.
- Encourages manual bypasses because the platform cannot express "repair only."

Decision: reject as the steady-state design. Keep this behavior as an emergency brake, but not as the main control
plane contract.

### Option C: Add A Material-Action Settlement Board

This option introduces a dedicated reducer that composes all current projectors and emits one action-class decision.

Pros:

- Removes ambiguous precedence between lease allow, dependency block, and Torghut proof block.
- Preserves observation and bounded repair while holding normal dispatch, merge, widening, or capital.
- Gives deployers one shadowed projection to compare before enforcement.
- Lets Torghut consume `repair_only` or `block` without parsing Jangar internals.
- Creates a clear regression-test target for the current failure mode.

Cons:

- Adds a new projection and status field.
- Requires a shadow period to tune false holds.
- Requires each material action to declare its action class instead of relying on local defaults.

Decision: select Option C.

## Chosen Architecture

### MaterialActionSettlementBoard

Jangar should materialize a current settlement row per namespace, action class, target, and evidence epoch.

```text
material_action_settlement_board
  settlement_id
  namespace
  action_class                  # observe, repair, normal_dispatch, merge_ready, deploy_widen, torghut_capital
  target_ref                    # schedule, agentrun, deployment, route, torghut_account, workflow
  final_decision                # allow, observe_only, repair_only, hold, block
  precedence_rule               # hard_block, repair_carveout, quorum_hold, lease_hold, full_allow
  failure_domain_lease_state    # allow, hold, block, shadow_allow, shadow_hold
  dependency_quorum_state       # allow, degraded, block, unknown
  controller_authority_state    # heartbeat, rollout, dual, stale, missing
  runtime_admission_state       # admitted, repair_only, held, blocked
  rollout_health_state          # healthy, progressing, degraded, unknown
  database_projection_state     # healthy, degraded, inaccessible
  torghut_profit_state          # not_applicable, observe, repair, paper_candidate, live_candidate, blocked
  evidence_refs[]
  reason_codes[]
  observed_at
  fresh_until
```

Initial precedence rules:

- A current hard block from dependency quorum or Torghut profit proof beats a failure-domain lease allow.
- A failure-domain lease allow is necessary for `normal_dispatch`, `merge_ready`, `deploy_widen`, and
  `torghut_capital`, but never sufficient by itself.
- `observe` stays open when database projection and rollout health are fresh, even if dependency quorum is degraded.
- `repair` stays open under dependency block only when the repair target directly retires the blocking reason and has a
  bounded scope.
- `normal_dispatch` requires lease allow, runtime admission, healthy rollout, and either heartbeat authority or a
  shadowed dual-authority override.
- `merge_ready` requires `normal_dispatch=allow`, no current dependency block, and no unresolved failed-run debt for the
  workflow class being claimed.
- `deploy_widen` requires healthy rollout, no recent readiness-probe hold for the target deployment, execution trust
  healthy, and dependency quorum not blocking.
- `torghut_capital` requires lease allow, dependency quorum allow, Torghut profit proof at least `paper_candidate`, and
  no live submission block from the companion Torghut contract.

### Profit Repair Gates

The board must expose repair gates rather than only blocks. For the current evidence snapshot, the expected settlement
is:

```text
observe                    allow
repair:empirical_jobs      repair_only
repair:quant_metrics       repair_only
normal_dispatch            hold
merge_ready                block
deploy_widen               hold
torghut_capital            block
```

Reason codes should include `dependency_quorum_empirical_jobs_degraded`, `torghut_simple_submit_disabled`,
`torghut_zero_promotion_eligible`, `torghut_quant_latest_metrics_empty`, and `db_direct_introspection_unavailable`.

The direct DB access gap is not by itself a capital block while service-owned database projections are healthy. It is a
deployer evidence gap that must be retired before widening enforcement beyond shadow.

### API And Status Contract

Jangar should add a `material_action_settlement` section to `/api/agents/control-plane/status`:

```text
material_action_settlement
  mode                         # shadow, enforce_repair, enforce_material
  generated_at
  evidence_epoch
  decisions[]
  shadow_disagreements[]
  stale_inputs[]
```

The first implementation should run in `shadow` and record disagreements between existing local allow decisions and the
new settlement result. Enforcement can only begin after two consecutive scheduled cycles with no unexpected
disagreements for observation or repair lanes.

## Engineer Handoff

Implement the board as a pure reducer first, then wire it into status.

Required slices:

- Add a `control-plane-material-action-settlement` reducer under `services/jangar/src/server/**`.
- Feed it with existing failure-domain lease, dependency quorum, runtime admission, database status, rollout health,
  execution-trust, workflow, and Torghut quant/profit status projections.
- Add fixture tests for the current evidence snapshot: lease allow plus dependency block plus Torghut live block must
  settle `torghut_capital=block`, `merge_ready=block`, `deploy_widen=hold`, and bounded empirical repair as
  `repair_only`.
- Add a test proving direct DB introspection unavailable is a reason code, not a hard block, when service DB projection
  is healthy.
- Keep `supporting-primitives-controller.ts` a consumer of settlement decisions; do not add new ad-hoc readiness logic
  there.
- Expose the shadow payload through `/api/agents/control-plane/status` and preserve the existing status shape for
  backward-compatible consumers.

Acceptance gates:

- Unit tests cover every action class and every final decision.
- Status payload includes action-class decisions with evidence refs and fresh-until timestamps.
- No material action can be `allow` when dependency quorum is `block`, except bounded repair with a matching repair
  reason.
- Torghut capital cannot be `allow` while live submission is blocked or promotion eligibility is zero.

## Deployer Handoff

Roll out in three stages:

1. `shadow`: publish the board and collect disagreements. No existing dispatch behavior changes.
2. `enforce_repair`: use the board to keep observation and bounded repair open while holding merge, deploy widening,
   and Torghut capital when dependency quorum or profit proof blocks.
3. `enforce_material`: require the board for normal dispatch, merge readiness, deploy widening, and Torghut capital.

Deployment gates:

- Jangar status returns `database.status=healthy` and no migration drift.
- `agents` and `agents-controllers` deployments are available with no fresh readiness-probe event hold.
- Dependency quorum is either `allow` or every block has a corresponding repair-only lane.
- Torghut live and simulation status are both represented in the board.
- Shadow disagreements are explained and either fixed or accepted in the rollout notes.

Rollback:

- Set the board mode back to `shadow`.
- Keep status emission enabled for audit.
- Revert only the enforcement toggle, not the reducer or projection, unless the reducer corrupts status generation.
- If status generation fails closed, fall back to existing failure-domain lease behavior for observation and repair only;
  capital remains blocked until the board is healthy again.

## Validation Plan

- `bun test services/jangar/src/server/control-plane-material-action-settlement.test.ts`
- `bun test services/jangar/src/server/control-plane-status.test.ts`
- `bunx oxfmt --check services/jangar packages/scripts/src/jangar argocd/applications/jangar`
- Read-only smoke: `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
- Read-only smoke: `curl http://torghut.torghut.svc.cluster.local/readyz`
- Read-only smoke: `curl http://torghut-sim.torghut.svc.cluster.local/readyz`

## Risks

- A too-conservative reducer could hold normal dispatch longer than necessary. The shadow phase must measure false
  holds before enforcement.
- A too-broad repair carveout could become a disguised normal-dispatch bypass. Repair actions must name the blocking
  reason they retire.
- Direct DB introspection is currently unavailable to this service account. That is acceptable for this design pass, but
  deployers need either a safe projection or scoped read-only access before relying on database evidence during incidents.
- Existing status consumers may assume failure-domain lease holdbacks are final. The status contract must label leases
  as inputs and settlement as the reduced decision.
