# 131. Jangar Capital Qualification Receipts And Rollout Repair Arbiter (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, typed rollout admission, evidence freshness, Torghut capital qualification,
repair dispatch, rollback evidence, and read-only validation.

Companion Torghut contract:

- `docs/torghut/design-system/v6/135-torghut-capital-qualified-alpha-router-and-execution-repair-ladder-2026-05-06.md`

Extends:

- `130-jangar-synthetic-readiness-settlement-and-evidence-probe-fuses-2026-05-06.md`
- `129-jangar-consumer-evidence-leases-and-readiness-decoupling-2026-05-06.md`
- `124-jangar-disruption-budget-arbiter-and-data-freshness-settlement-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`

## Decision

I am selecting a **capital qualification receipt with a rollout repair arbiter** as the next Jangar control-plane
contract for Torghut quant.

The control plane is not in the same state as the stale soak from `2026-05-05T09:00Z`. On the read-only sample from
`2026-05-06T21:10Z`, Jangar served `/health` with HTTP `200`, Jangar served control-plane status with dependency
quorum `allow`, and the agents controller, supporting controller, orchestration controller, workflow runtime, job
runtime, and temporal runtime were all reported healthy or configured. Agents pods showed two
`agents-controllers` replicas running, and Jangar `jangar-54d5b66746-c28hw` was `2/2 Running`.

That recovery is not enough to widen Torghut rollout or admit capital. The same evidence shows that Torghut is still
capital-blocked. Live Torghut `torghut-00244` and sim `torghut-sim-00344` were running, but live `/readyz` was
`degraded`. Live submission was closed with `simple_submit_disabled`, capital stage `shadow`, and
`promotion_eligible_total=0`. Jangar quant health for account `PA3SX7FYNUTF` was reachable and current at the latest
metric level, but pipeline health was degraded: compute lag was `1` second, ingestion lag was about `12369` seconds,
and materialization lag was `17` seconds. Market context health was degraded with stale technicals, fundamentals,
news, and regime domains. Torghut execution settlement was even older: TCA last computed at
`2026-04-02T20:59:45Z` with average absolute slippage around `568.6` bps. Empirical jobs were fresh, but they cannot
override stale execution and market evidence.

The chosen direction makes Jangar issue one typed receipt that answers a narrow question before any material action:
does this Torghut account, revision, market window, and action class have enough current evidence to proceed, and if
not, which repair action is allowed? The receipt separates controller health from capital qualification. It lets Jangar
keep `observe` and zero-notional `repair_dispatch` moving while holding `merge_ready`, `deploy_widen`, `paper_canary`,
`live_micro_canary`, and `live_scale` when data freshness, execution settlement, market context, disruption ambiguity,
or rollout event debt is unresolved.

The tradeoff is more holds on actions that used to look green at the pod or controller level. I accept that. The next
six-month failure mode to remove is not a dead controller. It is a recovered controller using stale or partial evidence
to bless a rollout or capital path.

## Runtime Objective And Success Metrics

This contract increases Jangar resilience by making rollout and capital admission resilient to partial evidence. It
increases Torghut reliability by keeping repair throughput alive while denying capital escalation on stale proof.

Success means:

- Jangar emits a `capital_qualification_receipt` for every Torghut material action class.
- A healthy controller quorum is necessary but not sufficient for `deploy_widen`, `paper_canary`, `live_micro_canary`,
  or `live_scale`.
- `observe` and `repair_dispatch` stay available when the control plane is healthy and the requested action has max
  notional `0`.
- Stale quant ingestion, stale market context, stale execution/TCA settlement, ambiguous PDB events, and route
  readiness debt become typed blocker dimensions.
- Each blocker dimension has an expiry, source reference, severity, and repair action.
- Receipts include the rollback target for the active Torghut revision and the evidence that would prove rollback
  complete.
- Engineer and deployer stages can validate the contract from Kubernetes events, Jangar routes, Torghut routes, and
  local source tests without Secret reads, pod exec, or database mutation.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests, trading
flags, broker state, or ClickHouse tables.

### Cluster And Rollout Evidence

- The workspace was on `codex/swarm-torghut-quant-discover` at current `origin/main` before this artifact.
- `kubectl config current-context` was initially unset. I bootstrapped an in-cluster context using the mounted service
  account token and verified identity as `system:serviceaccount:agents:agents-sa`.
- Cluster-scope node listing was forbidden for this service account. Knative service listing, statefulset listing,
  Secret listing, and pod exec were also forbidden in the relevant namespaces. That is acceptable for the runtime
  contract because Jangar must use least-privilege projected evidence.
- Jangar pods were running, including `jangar-54d5b66746-c28hw` at `2/2 Running`, `jangar-db-1`, Redis, Open WebUI,
  Bumba, Alloy, and Symphony.
- Agents pods were running, including `agents-99984c648-h5r92` and two `agents-controllers` replicas. Recent agents
  events still showed transient readiness probe timeouts against the agent and controller pods.
- Torghut live `torghut-00244-deployment-556cc5c594-4kjls` and sim
  `torghut-sim-00344-deployment-68787fcc66-rmdp5` were `2/2 Running`.
- Torghut supporting services were running: ClickHouse replicas, Keeper, Postgres, TA, sim TA, options TA, options
  catalog, options enricher, websockets, guardrail exporters, Alloy, and Symphony.
- Torghut events still showed repeated `MultiplePodDisruptionBudgets` warnings for ClickHouse pods and transient
  readiness failures on options and websocket pods.
- Torghut options catalog and options enricher were healthy at their route layer; the options hot set contained `160`
  instruments at `2026-05-06T21:12:15Z`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `781` lines and already composes controller health, runtime
  adapters, dependency quorum, action clocks, negative evidence, empirical services, and material receipts.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and already reduces Torghut
  readiness, market-context stale domains, and quant alerts into negative evidence.
- `services/jangar/src/server/torghut-quant-runtime.ts` is `817` lines and materializes the quant metrics surface used
  by the typed health endpoint.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` is `399` lines and is the store boundary for latest
  metrics and pipeline health.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` is `128` lines and correctly exposes
  latest metric lag, empty-store alarms, missing-update alarms, scoped pipeline stages, and max stage lag.
- Jangar has focused tests around control-plane status, negative evidence, material-action verdicts, quant runtime,
  quant metrics, and the quant health route. The missing architecture layer is not route coverage. It is a receipt
  reducer that joins those proof surfaces by Torghut action class.

### Database And Data Evidence

- Direct Postgres and ClickHouse pod exec were forbidden by RBAC. Direct ClickHouse HTTP access without credentials
  returned `401 REQUIRED_PASSWORD`. The runtime contract must not depend on broad Secret or exec access.
- Jangar control-plane status at `2026-05-06T21:10:58Z` reported dependency quorum `allow` and healthy control runtime,
  dependency quorum, freshness authority, evidence authority, market data context, and watch stream segments.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, and matching expected/current Alembic head
  `0029_whitepaper_embedding_dimension_4096`.
- Torghut schema lineage was ready but carried parent-fork warnings around `0010` and `0015`, which should remain
  visible as schema-quality context even when head parity is healthy.
- Torghut empirical jobs were fresh and promotion-authority eligible for
  `chip-paper-microbar-composite@execution-proof`, with four completed jobs:
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Jangar quant health for `PA3SX7FYNUTF` and `15m` had `latestMetricsCount=144`, `metricsPipelineLagSeconds=12-14`,
  and `maxStageLagSeconds=12369`. The latest-store alarm was clear, but ingestion and materialization stages were not
  healthy.
- Market context health was degraded: technicals were stale by about `175987` seconds against a `60` second limit,
  fundamentals by about `4778965` seconds against an `86400` second limit, news by about `4412152` seconds against a
  `300` second limit, and regime by about `175987` seconds against a `120` second limit.
- Torghut TCA summary still anchored to `2026-04-02T20:59:45Z`, with `order_count=13775` and
  `avg_abs_slippage_bps=568.6138848199565`.
- Recent Torghut decisions existed on `2026-05-06`, but the sampled decisions were blocked with
  `trading_simple_submit_disabled`; the sampled executions were from `2026-04-02`.

## Problem

Jangar has enough route and controller health to look green while Torghut remains unqualified for capital.

The active failure modes are:

1. **Recovered controller, stale capital evidence.** Jangar quorum is healthy, but Torghut quant ingestion, market
   context, and execution settlement remain stale or degraded.
2. **Route reachability is mistaken for proof.** Quant health is HTTP `200` and latest metrics are non-empty, but stage
   health shows stale ingestion.
3. **Empirical proof outruns execution proof.** Current empirical jobs are useful, but the execution/TCA surface is
   more than a month old.
4. **Least-privilege gaps are not typed.** RBAC denies direct exec, Secret, statefulset, and Knative service reads.
   Jangar must represent unobserved authority explicitly rather than relying on ad hoc manual commands.
5. **Rollout debt and capital debt are mixed.** A previous pod readiness miss, duplicate PDB warning, stale data, and
   simple submit disablement should not collapse into one generic unhealthy state.

## Alternatives Considered

### Option A: Treat Jangar Controller Quorum As The Primary Gate

This option promotes actions once Jangar control-plane status reports `allow` and required runtimes are configured.

Pros:

- Fast to implement because most surfaces already exist.
- Clear control-plane operator story.
- Helps avoid false incidents after a controller rollout recovers.

Cons:

- Does not catch stale quant ingestion, stale TCA, stale market context, or ClickHouse disruption ambiguity.
- Lets a recovered controller bless an unqualified capital path.
- Gives the deployer no ranked repair action.

Decision: reject.

### Option B: Freeze Every Material Action Until Torghut Is Fully Healthy

This option blocks all Jangar material actions whenever any Torghut evidence dimension is degraded.

Pros:

- Strong safety posture.
- Simple rollback story.
- Avoids any chance of stale data influencing capital.

Cons:

- Blocks zero-notional repair even when repair is the safest next action.
- Wastes the current healthy controller quorum and fresh empirical jobs.
- Makes Jangar less reliable as an orchestration surface because every Torghut data issue becomes a control-plane
  stop.

Decision: reject.

### Option C: Capital Qualification Receipts With A Rollout Repair Arbiter

Jangar emits an action-scoped receipt that gates capital and rollout widening while allowing observe and repair actions
with zero notional.

Pros:

- Keeps the control plane useful during partial Torghut degradation.
- Separates controller availability from capital qualification.
- Converts each failure mode into a typed blocker with source evidence and repair ownership.
- Preserves least-privilege validation through projected routes and events.
- Gives engineer and deployer stages concrete acceptance gates.

Cons:

- Adds a new receipt reducer and action-class policy table.
- Requires calibration to avoid over-holding rollout widening.
- Requires Torghut to expose repair outcomes in a shape that Jangar can settle.

Decision: select Option C.

## Architecture

Jangar creates a capital qualification receipt for every material action affecting Torghut.

```text
capital_qualification_receipt
  receipt_id
  generated_at
  expires_at
  account_label
  torghut_revision
  action_class              # observe, repair_dispatch, merge_ready, deploy_widen, paper_canary, live_micro, live_scale
  decision                  # allow, allow_repair, hold, block, unobserved
  max_notional
  controller_quorum_ref
  rollout_event_ref
  disruption_settlement_ref
  quant_freshness_ref
  market_context_ref
  execution_settlement_ref
  empirical_authority_ref
  schema_quality_ref
  blocker_dimensions
  repair_action_refs
  rollback_target
```

The receipt dimensions are action-scoped:

```text
capital_qualification_dimension
  dimension                 # control_plane, rollout, disruption, quant, market_context, execution, empirical, schema
  state                     # pass, degraded, stale, missing, ambiguous, unobserved, fail
  source_ref
  observed_at
  freshness_seconds
  threshold_seconds
  severity
  action_effect             # allow, allow_repair, hold_paper, hold_live, block
  repair_kind
```

Action policy:

- `observe` requires controller quorum and route reachability. It tolerates degraded trading evidence.
- `repair_dispatch` requires controller quorum and a concrete repair target. It always sets max notional `0`.
- `merge_ready` requires controller quorum, no unresolved rollout event debt, current schema, and no unobserved
  disruption authority for data-plane surfaces affected by the change.
- `deploy_widen` requires `merge_ready` plus current Torghut route readiness for the active revision.
- `paper_canary` requires fresh quant ingestion, fresh market context, fresh execution/TCA settlement, and a current
  empirical authority receipt.
- `live_micro_canary` requires `paper_canary` plus Torghut live submission gate eligibility and account-scoped
  rollback evidence.
- `live_scale` requires live micro outcome receipts, fresh slippage settlement, and no open rollback blockers.

The rollout repair arbiter converts held dimensions into repair actions:

```text
rollout_repair_action
  action_id
  created_at
  receipt_id
  repair_kind               # quant_ingestion, market_context_refresh, tca_replay, pdb_disambiguation, route_health
  owner_stage               # engineer, deployer, architect
  allowed_action_class
  max_notional
  validation_gate
  expires_at
```

The arbiter never edits Kubernetes or database state itself. It selects and publishes the next allowed action class so
engineer and deployer lanes can implement or roll out the repair with normal GitOps and CI/CD controls.

## Implementation Scope

Engineer stage:

- Add a Jangar reducer that builds `capital_qualification_receipt` from existing control-plane status, negative
  evidence, Torghut quant health, Torghut market-context health, Torghut TCA summary, empirical jobs, and DB-check
  projections.
- Add fixtures for the current degraded state: controller quorum `allow`, quant latest store non-empty, stale
  ingestion, stale market context, stale TCA, fresh empirical jobs, and simple submit disabled.
- Add unit tests proving that `observe` and zero-notional `repair_dispatch` are allowed while `paper_canary` and
  `live_micro_canary` are held.
- Add a status payload field that names the top repair action without changing existing dependency quorum semantics.

Deployer stage:

- Roll out receipt generation in shadow mode first. Receipts must be visible but non-blocking for existing actions.
- After one market session, make receipts blocking for `paper_canary`, `live_micro_canary`, and `live_scale`.
- Keep `observe` and `repair_dispatch` non-blocking unless controller quorum is unhealthy.
- Do not grant broad Secret read or pod exec to solve validation. Add narrow projected routes or read-only Kubernetes
  list permissions only when a receipt dimension cannot be produced otherwise.

## Validation Gates

Local/source gates:

- `bun test services/jangar/src/server/__tests__/control-plane-negative-evidence-router.test.ts`
- `bun test services/jangar/src/server/__tests__/control-plane-material-action-verdict.test.ts`
- `bun test services/jangar/src/routes/api/torghut/trading/control-plane/quant/-health.test.ts`
- Add a new receipt reducer test that asserts stale ingestion and stale TCA hold capital but allow repair dispatch.

Read-only runtime gates:

- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` shows dependency
  quorum `allow`.
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
  shows latest metrics non-empty and stage health included.
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health` shows domain freshness and quality.
- `curl http://torghut-00244.torghut.svc.cluster.local/trading/tca` shows execution settlement recency.
- `curl http://torghut-00244.torghut.svc.cluster.local/db-check` shows schema head and lineage status.

Production acceptance:

- A current degraded state produces `decision=allow_repair` for `repair_dispatch`, `max_notional=0`, and repair kind
  `quant_ingestion` or `tca_replay`.
- The same state produces `decision=hold` for `paper_canary`, `live_micro_canary`, and `live_scale`.
- Receipt expiry prevents old green receipts from authorizing a later action.
- Rollback target names the active Torghut revision and the route or GitOps object that proves rollback.

## Rollout Plan

1. Add the reducer and tests behind a shadow-only feature flag.
2. Publish receipts in Jangar status without changing admission decisions.
3. Compare receipt decisions against existing dependency quorum and Torghut live submission gates for one full market
   session.
4. Make receipt holds blocking for paper and live capital action classes.
5. Add deploy-widen blocking only after PDB/disruption evidence is stable and false holds are below the agreed budget.

## Rollback Plan

Rollback is a control-plane behavior rollback, not a data rollback.

- Disable the receipt reducer flag to return to existing dependency quorum and Torghut live submission gates.
- Keep emitted receipts as audit evidence but mark them `inactive`.
- Revert the Jangar image through the normal GitOps release path if the reducer causes route errors.
- If receipt generation is slow or flaky, keep `observe` and `repair_dispatch` available and block only capital action
  classes until route latency is back within budget.

## Risks And Mitigations

- Risk: receipts over-hold deploy widening because event debt is noisy. Mitigation: start in shadow mode and only block
  capital before deploy-widen.
- Risk: receipts depend on stale Torghut route names. Mitigation: include active revision and source URL in every
  receipt and fail to `unobserved`, not `allow`.
- Risk: repair dispatch creates action churn. Mitigation: require expiry, owner stage, and one top-ranked repair action
  per account/window.
- Risk: engineers try to solve RBAC gaps with broad pod exec or Secret access. Mitigation: define projected route or
  narrow list permission as the accepted unblocker.

## Handoff Contract

Engineer acceptance:

- Implement the reducer and fixtures.
- Demonstrate that the current evidence shape yields `allow_repair` for zero-notional repair and `hold` for paper/live
  capital.
- Keep existing control-plane status and dependency quorum payloads backward compatible.

Deployer acceptance:

- Deploy receipts in shadow mode first.
- Capture one market-session comparison between receipt decisions and existing gates.
- Do not widen paper/live capital until quant ingestion, market context, TCA, empirical, and schema dimensions are
  current in the receipt.
