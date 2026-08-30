# 125. Jangar Run Settlement Watermarks And Consumer Evidence Escrow (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane run settlement, controller witness reconciliation, material action receipts, Torghut
consumer evidence, rollout safety, and read-only validation.

Companion Torghut contract:

- `docs/torghut/design-system/v6/129-torghut-proof-carry-watermarks-and-zero-decision-capital-drain-2026-05-06.md`

Extends:

- `124-jangar-disruption-budget-arbiter-and-data-freshness-settlement-2026-05-06.md`
- `123-jangar-market-context-contradiction-ledger-and-lane-capital-holds-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`

## Decision

I am selecting **run settlement watermarks with consumer evidence escrow** as the next Jangar control-plane contract.

The live state is better than the original May 5 degraded baseline. At `2026-05-06T17:09Z`, Jangar `/ready` was OK,
the service was leader, execution trust was healthy, memory embeddings were on an explicit self-hosted endpoint, and
runtime admission passports were fresh. The control-plane status route reported database connectivity healthy, Kysely
migration consistency at `28/28`, agents rollout healthy for `agents=1/1` and `agents-controllers=2/2`, workflow
failures at `0` in the 15-minute window, and watch reliability healthy with `5544` AgentRun events, `0` errors, and
`2` restarts.

The same evidence shows why deployment and capital authority are still too optimistic. Controller witness quorum was
`repair_only` because the controller deployment and watch epoch were current, but the controller ingestion self-report
was missing. Material receipts carried that negative authority but still allowed `deploy_widen` and `merge_ready`.
`dispatch_normal` was only `repair_only`, `paper_canary` was `observe_only`, `live_micro_canary` was held, and
`live_scale` was blocked, mostly because Torghut consumer evidence was missing. The swarm resource itself was fresh
and not degraded, but its status still contained a stale-looking requirements error for an implementation template
while reporting zero pending requirements. Recent events also showed controller readiness timeouts during rollout.

Torghut evidence confirms the consumer side of the gap. Live `/readyz` returned HTTP `503` because
`simple_submit_disabled` keeps live submission in shadow. Postgres, ClickHouse, Alpaca, database schema, and the Jangar
universe were healthy, but market context for `NVDA` was degraded because fundamentals and news were stale. The
Jangar quant health route was healthy when account scope was omitted, but `account=paper&window=1d` returned degraded
with `latestMetricsCount=0` and `emptyLatestStoreAlarm=true`. Open quant alerts showed critical
`metrics_pipeline_lag_seconds` windows from `5m` through `20d`. Torghut Prometheus metrics exposed zero trading
decisions and zero submitted orders.

The selected design makes every material action pass through two watermarks:

1. A **control-plane run settlement watermark** proving the lane has no unbounded in-flight work, no unresolved
   controller self-report split, and no contradictory requirement bridge state for the requested action class.
2. A **consumer evidence escrow** proving Torghut has supplied the evidence required by the action, including
   freshness, empirical jobs, market context, and proof-carrying capital inputs.

The tradeoff is stricter merge and deploy authority. I accept that. A service can be serving and still lack a current
controller self-report or consumer proof. The six-month failure mode to remove is a green deployment or merged design
that starts another automated lane while the previous work is still unsettled or while Torghut capital gates have no
fresh consumer evidence.

## Runtime Objective And Success Metrics

This contract improves Jangar reliability by separating "currently serving" from "safe to widen, merge, or dispatch
more non-repair work." It improves Torghut profitability by requiring proof-carrying consumer evidence before Jangar
grants paper or live capital authority.

Success means:

- Every material action receipt cites one `control_plane_run_settlement_watermark`.
- `serve_readonly` remains allowed when the run watermark is degraded but the route and database are healthy.
- `dispatch_repair` remains allowed when the only blockers are missing controller self-report or missing consumer
  proof.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` hold when controller self-report is missing, a stage has an
  over-budget active run, or the requirements bridge reports contradictory state.
- `paper_canary`, `live_micro_canary`, and `live_scale` require a `consumer_evidence_escrow` with fresh Torghut
  evidence refs.
- Torghut observe can continue at max notional `0` while quant stores are empty, alerts are open, or market context is
  stale.
- Deployer and engineer lanes can validate the contract from Jangar routes, Torghut routes, Kubernetes reads, and
  source fixtures without Secret reads or pod exec.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, or GitOps resources.

### Cluster And Rollout Evidence

- The workspace is on `codex/swarm-jangar-control-plane-discover` and was clean at `origin/main` before this artifact.
- `kubectl config current-context` was unset, so I bootstrapped the documented in-cluster context and verified identity
  as `system:serviceaccount:agents:agents-sa`.
- Jangar namespace pods were running: `jangar-b6b87bffd-5xtt9` was `2/2 Running`, `jangar-db-1` was running, and
  Bumba, Alloy, Symphony, Symphony-Jangar, Redis, and Open WebUI were available.
- Jangar deployments were available for `bumba`, `jangar`, `jangar-alloy`, `symphony`, and `symphony-jangar`.
- Listing statefulsets in Jangar and Torghut was forbidden to this service account; that denial is an observation
  right gap, not a data-plane mutation.
- Agents deployments were healthy in Jangar status: `agents=1/1` and `agents-controllers=2/2`.
- Agents events showed recent readiness probe timeouts for `agents`, `agents-controllers-b4b7c4f4d-bjsrn`, and
  `agents-controllers-b4b7c4f4d-wmqgv`, even though rollout-derived status was healthy.
- The `jangar-control-plane` Swarm was `Ready=True`, `Degraded=False`, had fresh discover, plan, implement, and verify
  stages, `queuedNeeds=0`, and `autonomousSuccessRate24h=0.9231`.
- The same Swarm status still carried a requirements error:
  `implement target AgentRun/jangar-swarm-implement-template not found`, while reporting `pending=0`; that is a
  contradiction that material receipts should not ignore.
- Recent AgentRuns showed several Jangar and Torghut workflow lanes running while earlier runs completed; Torghut
  verify had one long-running sample around `136m`.

### Source Evidence

- `docs/jangar/application-architecture.md` identifies the current decision contract and the control-plane status
  reducer modules.
- `docs/jangar/architecture-inventory.md` shows the largest Jangar modules remain high risk, including
  `supporting-primitives-controller.ts` at `2884` lines, `orchestration-controller.ts` at `2140`, and
  `agents-controller/index.ts` at `1828`.
- The module-size guardrail passed locally for `417` files and confirmed legacy oversized files stayed within their
  baseline caps.
- `services/jangar/src/server/control-plane-controller-witness.ts` already emits controller witness quorum and material
  action receipt refs; it is the right owner for attaching run settlement refs.
- `services/jangar/src/server/control-plane-status.ts` already composes database, workflow, watch, rollout, execution
  trust, action clocks, and material receipts.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is the right reducer for turning stale
  self-report and missing consumer proof into action-class decisions.
- Jangar has focused tests for `control-plane-status`, `control-plane-controller-witness`,
  `control-plane-negative-evidence-router`, `control-plane-action-clock`, watch reliability, runtime admission, and
  Torghut quant route behavior.
- The remaining source gap is not raw test absence. It is that current fixtures do not make missing controller
  self-report and missing Torghut consumer evidence authoritative for `deploy_widen` and `merge_ready`.

### Database And Data Evidence

- Direct database exec and Secret reads were blocked by RBAC in Jangar and Torghut. This contract assumes production
  validation must use application-projected database status or a future narrow read-only verifier.
- Jangar control-plane status reported `database.configured=true`, `database.connected=true`, `status=healthy`,
  `latency_ms=8`, and migration consistency `registered=28`, `applied=28`, `unapplied=0`, `unexpected=0`.
- The latest Jangar migration was `20260505_torghut_quant_pipeline_health_window_index`.
- Torghut `/readyz` returned HTTP `503` with scheduler OK, Postgres OK, ClickHouse OK, Alpaca live account OK,
  database schema current, and universe fresh.
- Torghut database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`; schema lineage was
  ready with known parent-fork warnings.
- Torghut live submission remained blocked by `simple_submit_disabled` with `capital_stage=shadow`.
- Jangar Torghut quant health without account scope was fresh with `latestMetricsCount=540` and approximately
  `13` seconds of lag.
- Jangar Torghut quant health for `account=paper&window=1d` was degraded with `latestMetricsCount=0` and
  `emptyLatestStoreAlarm=true`.
- Torghut market-context health for `NVDA` was degraded: fundamentals were stale for `4764365` seconds against an
  `86400` second limit, and news was stale for `5273` seconds against a `600` second limit.
- Torghut metrics showed `torghut_trading_decisions_total=0` and `torghut_trading_orders_submitted_total=0`.

## Problem

Jangar now has many positive signals, but some of them are not settlement signals.

The control plane can prove that its route is serving, its database probe is healthy, its deployments are available,
and its watch streams are active. It cannot yet prove, in one durable action receipt, that controller ingestion
self-report is current, no stage has over-budget in-flight work, requirements bridge state is non-contradictory, and
Torghut has supplied the consumer evidence required for the requested action.

That gap creates three failure modes:

1. A deployer can see healthy rollouts and green `merge_ready` while the controller witness is `repair_only`.
2. A workflow lane can keep launching while a previous lane is still running beyond its expected settlement window.
3. Torghut capital can be held for generic missing evidence without a precise escrow contract naming what proof must
   arrive before paper or live reentry.

The system needs a final settlement layer between live observations and material action receipts.

## Alternatives Considered

### Option A: Keep The Existing Material Receipts And Fix Controller Self-Report Locally

This option treats the missing controller self-report as a bug in the existing witness path.

Pros:

- Smallest implementation.
- Keeps the current action receipt schema mostly stable.
- Directly addresses one active reason code.

Cons:

- Does not settle active run age or lane drain.
- Does not handle contradictory requirement bridge state.
- Leaves Torghut consumer evidence as generic missing proof.
- Allows future green deploy or merge decisions to skip lane settlement.

Decision: reject as sufficient. The self-report bug is real, but the architecture gap is broader.

### Option B: Freeze All Non-Serving Actions On Any Warning Event Or Active Run

This option would block dispatch, deploy, merge, and capital whenever recent warnings or active runs exist.

Pros:

- Strong fail-closed posture.
- Easy to validate from Kubernetes events.
- Prevents overlapping automated work.

Cons:

- Over-blocks normal long-running verification.
- Turns benign readiness warmups into global holds.
- Makes repair slower because the same freeze catches repair work.
- Does not distinguish Jangar platform work from Torghut capital work.

Decision: reject. We need action-class settlement, not a global freeze.

### Option C: Run Settlement Watermarks With Consumer Evidence Escrow

Jangar emits a run settlement watermark and a consumer evidence escrow, then material receipts consume both.

Pros:

- Separates serving, repair, dispatch, merge, deploy, paper, and live actions.
- Turns controller self-report and active-run age into explicit receipt refs.
- Gives Torghut exact proof requirements before paper or live capital.
- Lets observe and zero-notional repair continue during proof gaps.
- Can be validated without broad database, Secret, or pod exec privileges.

Cons:

- Adds two projections to the action authority path.
- Requires shadow calibration for stage age thresholds.
- Requires route payload compatibility for Torghut consumer evidence refs.

Decision: select Option C.

## Architecture

### ControlPlaneRunSettlementWatermark

Jangar emits one watermark per namespace and material action window.

```text
control_plane_run_settlement_watermark
  watermark_id
  generated_at
  expires_at
  namespace
  stage_states
  active_run_refs
  max_active_run_age_seconds
  recent_success_refs
  controller_witness_quorum_ref
  controller_self_report_current
  requirements_bridge_state
  contradictory_requirement_refs
  decision                 # allow, repair_only, hold, block
  affected_action_classes
  reason_codes
  required_repairs
  rollback_target
```

Rules:

1. `serve_readonly` only requires route, database, and serving runtime admission.
2. `dispatch_repair` is allowed when the controller witness is split, provided NATS and storage leases are valid.
3. `dispatch_normal` is `repair_only` when controller self-report is missing.
4. `deploy_widen` and `merge_ready` hold when controller self-report is missing, a stage has an over-budget active run,
   or requirements bridge state is contradictory.
5. `paper_canary`, `live_micro_canary`, and `live_scale` consume this watermark plus the Torghut consumer escrow.
6. Watermarks expire quickly, default 5 minutes for controller self-report and 15 minutes for action receipts.

### ConsumerEvidenceEscrow

Jangar emits one escrow per consumer and material action class.

```text
consumer_evidence_escrow
  escrow_id
  generated_at
  expires_at
  consumer
  action_class
  required_evidence_types
  supplied_evidence_refs
  missing_evidence_types
  stale_evidence_refs
  contradiction_refs
  decision                 # allow, observe_only, repair_only, hold, block
  max_notional
  required_repairs
```

Rules:

1. Torghut observe requires no capital evidence and always stays max notional `0`.
2. Paper requires fresh quant metrics for the target account/window, fresh market-context domains required by the lane,
   fresh empirical jobs, and no critical open proof alerts.
3. Live micro-canary requires paper settlement plus live submission gate readiness.
4. Live scale requires a settled live micro-canary window, not only healthy route readiness.
5. Empty latest stores and zero decision counts cannot support paper or live authority.

### Material Receipt Integration

Material action activation receipts add:

- `control_plane_run_settlement_watermark_ref`;
- `consumer_evidence_escrow_ref` when the consumer is Torghut;
- `max_active_run_age_seconds`;
- `controller_self_report_current`;
- `requirements_bridge_decision`;
- `consumer_missing_evidence_types`;
- `consumer_stale_evidence_refs`.

Final rule:

```text
material_action_decision =
  min_by_severity(action_clock, run_settlement_watermark, consumer_evidence_escrow)
```

`allow` cannot override a stricter watermark or escrow. The stricter decision wins.

## Implementation Scope

Engineer stage:

- Add a run settlement builder next to the control-plane witness and action-clock reducers.
- Add fixtures for missing controller self-report, over-budget active runs, and contradictory requirements state.
- Add a consumer evidence escrow builder for Torghut action classes.
- Attach watermark and escrow refs to material action receipts.
- Update control-plane status and route tests so `deploy_widen` and `merge_ready` hold when the watermark is stricter
  than the action clock.

Deployer stage:

- Validate the status payload from `/api/agents/control-plane/status?namespace=agents`.
- Confirm current `deploy_widen`, `merge_ready`, and Torghut capital receipts cite watermark and escrow refs.
- Confirm no broad Secret, pod exec, or database write privilege is needed for validation.
- Use canary rollout. Hold widening if the watermark reports `hold` or `block`.

## Validation Gates

Local validation:

- `bun run --cwd services/jangar check:module-sizes`
- `bun test services/jangar/src/server/__tests__/control-plane-controller-witness.test.ts`
- `bun test services/jangar/src/server/__tests__/control-plane-negative-evidence-router.test.ts`
- `bun test services/jangar/src/server/__tests__/control-plane-action-clock.test.ts`
- `bun test services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `bunx oxfmt --check docs/agents/designs/125-jangar-run-settlement-watermarks-and-consumer-evidence-escrow-2026-05-06.md`

Read-only runtime validation:

- `curl -fsS http://jangar.jangar.svc.cluster.local/ready`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents'`
- `kubectl get swarm -n agents jangar-control-plane -o yaml`
- `kubectl get agentruns -n agents --sort-by=.metadata.creationTimestamp`
- `kubectl get events -n agents --sort-by=.lastTimestamp`

Acceptance gates:

- A missing controller ingestion self-report prevents `deploy_widen` and `merge_ready` from returning `allow`.
- An over-budget active run prevents a new non-repair dispatch in the same lane.
- Torghut `paper_canary` cites the consumer evidence escrow and stays observe-only when paper quant metrics are empty.
- Torghut live receipts stay held while live submission is disabled.
- Serving and bounded repair remain available.

## Rollout And Rollback

Roll out in shadow first. Emit watermarks and escrows, attach refs to receipts, but keep existing decisions as
advisory for one release.

Move to enforcement when shadow telemetry shows no false holds for serving or repair and at least one expected hold
for missing controller self-report, missing Torghut evidence, or over-budget active runs.

Rollback is simple: disable enforcement and keep watermark generation in observe mode. Existing action clocks,
failure-domain leases, negative evidence, and disruption/freshness settlements remain valid.

## Risks

- Too-strict active-run budgets can hold legitimate long verifications. Mitigation: use stage-specific budgets and
  shadow calibration.
- Missing consumer evidence can become a generic bucket again. Mitigation: require typed missing evidence names and
  route refs in every escrow.
- Controller self-report repair may need runtime code changes outside the status reducer. Mitigation: keep repair
  dispatch allowed and make the receipt point directly at the missing self-report.
- If the requirements bridge keeps contradictory status fields, deploy and merge could hold frequently. Mitigation:
  treat contradictions as repairable and make bridge normalization an explicit engineer task.

## Handoff

Engineer acceptance:

- Implement the watermark and escrow reducers with fixture coverage.
- Material receipts must choose the strictest decision across action clock, run watermark, and consumer escrow.
- `deploy_widen` and `merge_ready` must no longer allow when controller self-report is missing.

Deployer acceptance:

- Before widening Jangar, capture the run watermark and verify it is `allow`.
- Before paper or live Torghut capital, capture the consumer evidence escrow and verify no missing or stale proof.
- If rollback is needed, disable enforcement first, then keep observe-mode watermarks for postmortem evidence.
