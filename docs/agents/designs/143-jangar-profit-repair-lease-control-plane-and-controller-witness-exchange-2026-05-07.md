# 143. Jangar Profit Repair Lease Control Plane And Controller Witness Exchange (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders architecture
Scope: Jangar control-plane resilience, controller witness settlement, Torghut quant repair leases, capital action
verdicts, rollout safety, validation, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/147-torghut-profit-repair-leases-and-forecast-registry-settlement-2026-05-07.md`

Extends:

- `142-jangar-repair-dividend-handoff-gates-and-actuation-contracts-2026-05-07.md`
- `141-jangar-controller-witness-escrow-and-repair-dividend-settlement-2026-05-07.md`
- `140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`
- `139-jangar-empirical-relay-source-binding-and-capital-gate-parity-2026-05-07.md`

## Decision

I am selecting a **profit repair lease control plane** as the next Jangar architecture direction for Torghut quant.

The cluster is no longer in the worst state reported earlier in the swarm. On this read-only pass, `jangar`, `agents`,
`agents-controllers`, and the Torghut serving stack were available. Jangar reported migration parity with `28/28`
Kysely migrations applied, merge-ready allowed, runtime kits serving, dependency quorum allowed, and empirical jobs
healthy. Torghut reported live mode running with Postgres, ClickHouse, Alpaca, universe, and empirical jobs healthy.

That is not enough to restore normal dispatch or capital. Jangar still held `dispatch_normal` in `repair_only` because
the controller witness split had not settled. Torghut still held paper and live routes because the forecast registry was
empty, market context had no current domain state, execution TCA was stale from `2026-04-02T20:59:45.136640Z`, average
absolute slippage was about `568.61` bps against an `8` bps guardrail, and no hypothesis was promotion eligible.
Jangar's database had fresh quant metric rows, but `quant_pipeline_health` had about `50,995,674` rows and the live
Torghut route still reported `quant_pipeline_stages_missing`, so the control plane is writing a lot of stage material
without giving Torghut a simple current-stage receipt it can trust.

The decision is to make Jangar issue time-boxed profit repair leases. A lease is not an encouragement to trade. It is a
bounded authority object that says which evidence debt can be repaired, which controller and runtime witnesses make the
repair trustworthy, which Torghut proof dimensions must close before paper or live can reenter, and which rollback target
applies when the lease expires or contradicts live data.

The tradeoff is more contract surface between Jangar and Torghut. I accept that because the current failure mode is not
lack of status pages. The current failure mode is ambiguous authority: serving looks healthy while controller ingestion,
forecast authority, stage health, TCA, and market context disagree about whether the system is safe to act.

## Runtime Objective And Success Metrics

Success means:

- Jangar can keep `serve_readonly`, `dispatch_repair`, `deploy_widen`, `merge_ready`, and `torghut_observe` open while
  holding `dispatch_normal`, `paper_canary`, `live_micro_canary`, and `live_scale` whenever profit evidence is stale.
- A controller witness split cannot silently age out. It must publish a lease blocker with current witness refs,
  required repair, freshness window, and rollback target.
- Torghut receives one compact current lease view instead of inferring action authority from raw control-plane status,
  empirical job status, and quant metric rows separately.
- Every lease states the affected account, market window, hypothesis IDs when known, action class, proof debts,
  validation gate, expiry, and rollback behavior.
- Paper cannot open on empirical freshness alone. Paper requires fresh controller witness, forecast authority or waiver,
  current stage health, current market context, current TCA, and at least one promotion-eligible hypothesis.
- Live cannot open until paper settlement proves after-cost expectancy, expected shortfall coverage, and no active capital
  repair lease.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, GitOps
manifests, AgentRun records, or trading flags.

### Cluster And Runtime

- `kubectl get deploy,pods -n jangar` showed `jangar`, `bumba`, `symphony`, `symphony-jangar`, and Alloy available.
  The Jangar pod was on image digest `sha256:004b08ba...` for source commit `a42a5d61` after a recent rollout.
- `kubectl get deploy,pods -n agents` showed `agents` available `1/1` and `agents-controllers` available `2/2`.
  Recent events showed transient readiness and liveness warnings during rollout, but current deployments were healthy.
- `kubectl get deploy,pods -n torghut` showed Torghut live revision `00254`, sim revision `00354`, ClickHouse, Keeper,
  Torghut Postgres, TA, options catalog, options enricher, websocket, Alloy, and Symphony pods running.
- Torghut events still reported rollout risk: ClickHouse pods matched multiple PodDisruptionBudgets, Keeper PDB had
  `NoPods`, and Knative revisions had transient startup/readiness failures during rollout.
- RBAC blocked read-only introspection for Knative serving objects, PDBs, CNPG clusters, ClickHouseInstallation objects,
  and CNPG `pods/exec`. That means the deployer lane should continue route and API evidence unless RBAC is explicitly
  expanded.

### Jangar Control Plane

- `GET /health` on Jangar returned `status=ok`.
- `GET /api/agents/control-plane/status?namespace=agents` showed controllers healthy, runtime adapters configured,
  execution trust healthy, watch reliability healthy, database healthy, Kysely migrations `28/28`, runtime kits healthy,
  and recovery warrants sealed.
- Jangar marked only `empirical:forecast` as degraded. Forecast authority was blocked because the registry was empty.
  Empirical jobs were healthy with eligible benchmark, router, event-CAR, and HGRM reward jobs.
- Material action verdicts allowed read-only serve, repair dispatch, deploy widen, merge ready, and Torghut observe.
  Normal dispatch was `repair_only` because of `controller_witness_split`.
- Paper canary was held by `forecast_service_degraded` and missing Torghut consumer evidence. Live micro-canary was held
  for the same family of reasons. Live scale was blocked by paper settlement and forecast degradation.

### Torghut Consumer Evidence

- `GET /trading/status` reported Torghut enabled, live mode, running, active revision `torghut-00254`, build commit
  `ea859490fefb369075fd650ec2ed1ce5595b2d77`, and live submission `allowed=false` because `simple_submit_disabled`.
- `GET /trading/health` and `/readyz` returned HTTP `503` with proof floor `repair_only` and capital state
  `zero_notional`.
- Proof-floor blockers were `hypothesis_not_promotion_eligible`, `execution_tca_stale`, `market_context_stale`,
  and `simple_submit_disabled`.
- TCA had `13,775` orders, latest computation `2026-04-02T20:59:45.136640Z`, and average absolute slippage around
  `568.61` bps against an `8` bps threshold.
- Empirical jobs were healthy and fresh, but that positive evidence did not make any hypothesis promotion eligible.

### Database And Data

- Jangar direct Postgres read showed database `jangar`, schemas `public`, `torghut_control_plane`, and
  `workflow_comms`, with `28` applied Kysely migrations and latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- `torghut_control_plane.quant_metrics_latest` had about `4,032` live rows and recent rows updated at
  `2026-05-07T11:20:19.316Z` for account `PA3SX7FYNUTF`.
- `torghut_control_plane.quant_pipeline_health` had about `50,995,674` rows. A broad ordered sample timed out under a
  four-second statement timeout, while Torghut still reported missing pipeline stages. That is a contract smell: the
  write path has volume, but the consumer path lacks a current bounded receipt.
- `workflow_comms.agent_messages` had about `10,467` rows and recent `general` and `run` messages at
  `2026-05-07T11:19Z`, so collaboration evidence was active.
- Torghut direct Postgres read showed database `torghut`, `69` public tables, Alembic head
  `0029_whitepaper_embedding_dimension_4096`, `147,623` trade decisions with latest decision
  `2026-05-06T17:44:19.618Z`, `13,778` executions, `13,775` TCA rows, zero `execution_order_events`, zero
  `vnext_promotion_decisions`, zero `vnext_feature_view_specs`, and one strategy hypothesis row.

### Source And Test Surfaces

- Jangar status composition lives in `services/jangar/src/server/control-plane-status.ts`.
- Controller split handling lives in `services/jangar/src/server/control-plane-controller-witness.ts`.
- Action gating lives in `services/jangar/src/server/control-plane-material-action-verdict.ts` and
  `services/jangar/src/server/control-plane-negative-evidence-router.ts`.
- Empirical service status lives in `services/jangar/src/server/control-plane-empirical-services.ts`.
- Quant metrics and pipeline health persistence lives in `services/jangar/src/server/torghut-quant-metrics-store.ts`.
- Tests already cover status, empirical services, material action verdicts, negative evidence routing, controller
  witness split, and quant metrics store migrations.
- The missing implementation seam is a compact lease issuer that turns those existing facts into a bounded consumer
  object with expiry, receipts, and rollback.

## Problem

Jangar currently has enough facts to decide that Torghut should not receive capital, but not enough shape to make the
next repair action mechanically obvious.

The failure modes are:

1. **Controller witness ambiguity.** A split between controller process, watch, and ingestion witnesses holds normal
   dispatch, but the consumer still has to inspect multiple status sections to understand the repair.
2. **Data volume without current settlement.** Quant pipeline health has tens of millions of rows, while Torghut reports
   missing stages. The control plane needs a bounded current-stage receipt, not another unbounded query surface.
3. **Empirical optimism without capital authority.** Empirical jobs are fresh, but forecast authority is empty and TCA,
   market context, and hypotheses are stale or not promotion eligible.
4. **Rollout health is necessary but not sufficient.** Deployments are available after rollout, but transient startup
   warnings and PDB issues are still rollout risk and should not be confused with trading authority.
5. **Consumers need one contract.** Torghut should not infer action class by joining Jangar controller status, empirical
   service status, quant metric rows, proof-floor state, and route-level health by hand.

## Alternatives Considered

### Option A: Keep The Current Status Aggregator And Add More Fields

Pros:

- Lowest implementation cost.
- Reuses the existing `/api/agents/control-plane/status` route.
- Minimal schema change.

Cons:

- Adds more surface area to an already broad status payload.
- Does not solve lease expiry, consumer receipts, or bounded stage settlement.
- Leaves Torghut to infer action authority from many sections.

Decision: reject.

### Option B: Make Forecast Registry Recovery The Primary Gate

Pros:

- Directly targets the most visible degraded empirical service.
- Creates a clear quant innovation lane for calibrated model families.
- Could improve alpha faster than control-plane work alone.

Cons:

- Forecast readiness does not fix controller witness split, stale TCA, stale market context, or missing promotion
  decisions.
- It can create false confidence if model calibration improves while execution costs remain structurally broken.
- It treats one data product as the system boundary.

Decision: reject as the primary architecture, keep as a lease dimension.

### Option C: Issue Profit Repair Leases With Controller Witness Settlement

Pros:

- Converts control-plane facts into bounded authority objects that Torghut can consume.
- Keeps repair open while preventing empirical freshness from bypassing capital guardrails.
- Makes controller witness split, forecast registry, stage health, market context, and TCA explicit lease blockers.
- Gives deployer clear rollback behavior when rollout health and trading authority diverge.
- Provides a natural place to measure repair ROI and stale-evidence debt.

Cons:

- Requires new API and persistence contracts.
- Requires discipline to avoid treating leases as a trading signal.
- Requires tests across both Jangar and Torghut because the contract spans services.

Decision: select Option C.

## Architecture

Jangar becomes the issuer of profit repair leases. Torghut remains the final trading authority and consumer. A lease
does not authorize orders. It authorizes a bounded repair path and states what evidence must settle before Torghut can
consider paper or live capital.

```text
profit_repair_lease
  lease_id
  issued_at
  fresh_until
  namespace
  account
  market_window
  action_class
  decision
  controller_witness_ref
  empirical_services_ref
  quant_stage_receipts[]
  torghut_consumer_requirements[]
  blockers[]
  acceptance_gates[]
  rollback_target
```

The lease decision values are:

- `observe_only`: safe for read-only serving and dashboards.
- `repair_only`: safe for repair jobs, quant backfills, stage settlement, and route-only validation.
- `paper_hold`: paper is explicitly held until all proof debts close.
- `paper_candidate`: paper may be proposed to Torghut, but Torghut still applies its own quorum.
- `live_hold`: live remains blocked even if paper is active.
- `live_candidate`: live may be proposed only after paper settlement and capital proof are current.

The lease blockers are concrete:

- `controller_witness_split`
- `forecast_registry_empty`
- `quant_pipeline_stages_missing`
- `market_context_stale`
- `execution_tca_stale`
- `hypothesis_not_promotion_eligible`
- `simple_submit_disabled`
- `paper_settlement_required`

## Control-Plane Failure-Mode Reduction

Controller witness split must become a first-class lease blocker. The lease issuer should read the same controller
witness quorum used by material action verdicts and emit:

- witness refs for deployment, watch epoch, and ingestion;
- freshness age per witness;
- required repair text;
- action classes affected;
- the lease expiry;
- rollback target.

When the split is active, Jangar should keep:

- `serve_readonly=allow`
- `dispatch_repair=allow`
- `dispatch_normal=repair_only`
- `torghut_observe=allow`
- `paper_canary=hold`
- `live_micro_canary=hold`
- `live_scale=block`

This preserves useful recovery while preventing ordinary dispatch from hiding under a green deployment rollout.

## Bounded Stage Settlement

Jangar should not ask Torghut to scan `quant_pipeline_health` for current truth. The lease issuer should project current
stage health into a small receipt set keyed by account, strategy, and market window:

```text
quant_stage_receipt
  stage
  ok
  as_of
  lag_seconds
  source_row_ref
  expires_at
  reason
```

The required stages for paper candidate status are:

- market data ingestion;
- feature materialization;
- forecast registry and calibration;
- market context;
- execution TCA;
- risk/proof-floor reducer;
- promotion decision.

Missing or expired stages keep the lease in `repair_only` or `paper_hold`. Jangar may continue to store detailed stage
history, but the consumer contract must stay bounded.

## API And Storage Contract

Engineer stage should add a small issuer around existing status modules before adding any broad new data model.

Proposed API:

- `GET /api/agents/control-plane/profit-repair-leases?namespace=agents&account=PA3SX7FYNUTF`
- `GET /api/agents/control-plane/profit-repair-leases/current?namespace=agents&account=PA3SX7FYNUTF`
- SSE event `profit_repair_lease.issued` on the existing control-plane stream.

Proposed tables:

- `control_plane_profit_repair_leases`
- `control_plane_profit_repair_lease_receipts`

The first implementation may compute leases from current status without persistence if it logs deterministic refs and
tests the payload. Persistence is required before deployer uses leases as a rollout gate.

## Validation Gates

Engineer acceptance:

- Unit test: controller witness split yields `repair_only`, blocks normal dispatch, and emits required repair refs.
- Unit test: forecast registry empty yields `paper_hold`, even when empirical jobs are healthy.
- Unit test: missing stage receipt keeps paper closed when quant metrics are fresh.
- Unit test: stale TCA keeps paper closed and cites the Torghut TCA evidence ref.
- Contract test: `/api/agents/control-plane/status` and `/profit-repair-leases/current` agree on action class.
- Contract test: every blocker has a rollback target and expiry.

Deployer acceptance:

- Jangar and agents deployments available.
- Kysely migrations current.
- Current lease endpoint returns within route budget.
- Controller witness split absent before normal dispatch.
- Paper and live action classes are held unless Torghut consumer requirements are current.
- Rollout notes include PDB risk for ClickHouse and Keeper if deploy touches Torghut data services.

## Rollout

1. Ship lease issuer behind a read-only feature flag and expose it only as `observe_only` or `repair_only`.
2. Add the current lease endpoint and compare it with material action verdicts in CI and route smoke checks.
3. Persist leases once the computed contract is stable.
4. Let Torghut consume the lease as an informational proof input while retaining existing proof-floor decisions.
5. Promote the lease to a required paper gate only after route latency, expiry behavior, and rollback targets are stable
   for at least one full market session.

## Rollback

Rollback target is conservative:

- keep `dispatch_repair` and `torghut_observe` open;
- hold `dispatch_normal`;
- hold `paper_canary`;
- block `live_micro_canary` and `live_scale`;
- keep Torghut `capital_state=zero_notional`;
- continue serving status routes so operators can observe the repair.

If lease issuance is unavailable, Torghut must treat Jangar consumer evidence as missing and stay in zero-notional
repair.

## Risks

- Lease sprawl: too many blockers can turn into another status dump. Keep leases per account/window/action class.
- Latency: current lease routes must avoid broad scans of `quant_pipeline_health`; use bounded projections.
- False authority: lease wording must make clear that Jangar proposes repair and action class, while Torghut decides
  trading authority.
- RBAC: deployer validation cannot depend on CNPG exec or Knative object reads unless service-account permissions are
  deliberately expanded.
- Forecast overfit: model registry recovery must carry calibration and expiry, not just a non-empty model list.

## Handoff

Engineer should implement the lease issuer against existing Jangar status modules, not by duplicating Torghut proof-floor
logic. The first useful slice is a pure reducer plus a current endpoint that emits the exact blockers seen in this
assessment: `controller_witness_split`, `forecast_registry_empty`, `quant_pipeline_stages_missing`,
`market_context_stale`, `execution_tca_stale`, `hypothesis_not_promotion_eligible`, and `simple_submit_disabled`.

Deployer should treat the lease as a rollout and action-class guard. A green deployment is not a green capital gate. The
release can widen serving traffic while leases remain `repair_only`, but paper and live gates stay closed until Torghut
consumes a current lease and its own proof quorum passes.
