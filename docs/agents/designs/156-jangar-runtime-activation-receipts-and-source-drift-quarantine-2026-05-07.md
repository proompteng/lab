# 156. Jangar Runtime Activation Receipts And Source Drift Quarantine (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane reliability, source-to-runtime activation, release drift, Torghut capital receipts, rollout
quarantine, validation, rollback, and implementation acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/160-torghut-proof-surface-activation-ledger-and-capital-receipt-firewall-2026-05-07.md`

Extends:

- `155-jangar-execution-cohort-settlement-and-launch-quarantine-2026-05-07.md`
- `154-jangar-repair-cell-admission-and-market-context-trust-gates-2026-05-07.md`
- `153-jangar-design-actuation-ledger-and-contract-convergence-gates-2026-05-07.md`

## Decision

I am selecting runtime activation receipts with source drift quarantine as the next Jangar architecture step.

The current control plane is available, but availability is not the same thing as activation truth. At
`2026-05-07T17:10Z`, Jangar serving was healthy, execution trust was healthy, collaboration runtime kits were healthy,
and all three controller heartbeats were fresh from the agents controller deployment. Argo reported Jangar and Torghut
as synced and healthy. That is good evidence for serving reliability.

The more important finding is that source, GitOps, and runtime are out of phase for a profitability feature that just
merged. The repository head is `f65301040` on `main`, and the source tree contains `route_reacquisition_book` support:
`services/torghut/app/trading/route_reacquisition.py`, proof-floor wiring in
`services/torghut/app/trading/proof_floor.py`, API wiring in `services/torghut/app/main.py`, and tests in
`services/torghut/tests/test_route_reacquisition.py`, `test_profitability_proof_floor.py`, and `test_trading_api.py`.
Live Torghut, however, is still running `TORGHUT_COMMIT=4c3eab33120e247e1a4bd235d63098f2beac6fab` at Knative
revision `torghut-00272`, and both live and simulation proof-floor responses lack `route_reacquisition_book`.

That is not a bug in the new source artifact. It is a release activation gap. Jangar needs to distinguish four states:

1. source intent exists in `main`;
2. GitOps desired state points at a promoted image and commit;
3. runtime pods are serving that image and commit;
4. runtime endpoints emit the required receipt shape.

Today those states are easy to blend together. A design PR can merge, Argo can be healthy, and the trading service can
serve while the newly merged proof surface is not activated. For Torghut, that is a capital-risk boundary. A source
document or merged reducer must not become capital evidence until the deployed runtime proves that it emits the agreed
receipt.

The tradeoff is stricter launch gating after merges. I accept that. It is cheaper to hold dispatch or capital for one
activation receipt than to discover later that deployers, engineers, and trading gates were looking at different
versions of the system.

## Runtime Objective And Success Metrics

Success means:

- Jangar publishes `runtime_activation_receipts` from `/api/agents/control-plane/status?namespace=agents`.
- Each receipt binds `source_head_sha`, `gitops_revision`, `desired_image_digest`, `runtime_image_digest`,
  `runtime_commit`, `runtime_revision`, `endpoint_contract`, `observed_receipt_shape`, and `activation_decision`.
- A source/runtime mismatch is represented as `source_drift_quarantine`, not as a vague rollout note.
- A merged design or code PR can be visible as source intent while still being barred from `dispatch_normal`,
  `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` until activation passes.
- `serve_readonly` remains allowed when the serving deployment is healthy, even if activation is quarantined.
- Torghut capital gates can cite one Jangar activation receipt ID for each required proof surface.
- Deployer checks can answer: "Which runtime revision emitted this receipt shape, and does it match the source/GitOps
  revision we intended to promote?"

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database rows, ClickHouse
tables, broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster And Rollout Evidence

- Current branch: `codex/swarm-torghut-quant-discover` on `main`.
- Current repository head: `f65301040`, titled `feat(torghut): add route reacquisition book (#5918)`.
- `kubectl auth whoami` succeeded as `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` was
  unset, and cluster-scoped node listing was forbidden.
- Jangar namespace deployments were available: `jangar=1/1`, `bumba=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`.
- Agents namespace deployments were available: `agents=1/1` and `agents-controllers=2/2`.
- Torghut namespace deployments were available for live, sim, TA, sim TA, options TA, websocket services, options
  catalog, options enricher, ClickHouse guardrail exporter, LLM guardrail exporter, Symphony, and Alloy.
- Argo reported `jangar` and `torghut` as `Synced` and `Healthy` at revision `f65301040`.
- Recent Agents events still included a readiness timeout on one agents-controller pod and retained failed schedule
  runner jobs, but the current controller pods were running.
- Recent Torghut events showed a rollout to revision `00272`, DB migrations, empirical/whitepaper backfill completion,
  duplicate ClickHouse PDB warnings, options TA restart, and a retained
  `torghut-whitepaper-autoresearch-profit-target-8r6w6` error pod.

### Jangar Status Evidence

- `GET http://jangar.jangar.svc.cluster.local/health` returned `status=ok`.
- `GET /ready` returned `status=ok`, leader election `isLeader=true`, execution trust `healthy`, memory provider
  `healthy`, and serving/collaboration runtime kits `healthy`.
- The collaboration runtime kit confirmed `/usr/local/bin/codex-nats-publish`, `/usr/local/bin/codex-nats-soak`, and
  `nats` were present and healthy.
- `GET /api/agents/control-plane/status` showed `agents-controller`, `supporting-controller`, and
  `orchestration-controller` all `healthy`, with fresh heartbeat authority from
  `agents-controllers-559cd785cb-g6hws`.
- Aggregate Jangar Torghut quant health was `ok=true` with `latestMetricsUpdatedAt=2026-05-07T17:12:42.502Z`,
  `missingUpdateAlarm=false`, `metricsPipelineLagSeconds=1`, and zero scoped stages because account/window was omitted.

### Torghut Runtime Evidence

- Live Torghut revision: `torghut-00272`.
- Sim Torghut revision: `torghut-sim-00372`.
- Both live and sim deployments used image digest
  `registry.ide-newton.ts.net/lab/torghut@sha256:05fd4b6fc045a50adb049acc98c34278592cea12786aa08597d259ea05c0b464`.
- Both live and sim deployments advertised `TORGHUT_VERSION=v0.568.5-392-g4c3eab331` and
  `TORGHUT_COMMIT=4c3eab33120e247e1a4bd235d63098f2beac6fab`.
- Live `/readyz` was degraded. Scheduler, Postgres, ClickHouse, Alpaca, database schema, and Jangar universe were
  healthy, but proof floor remained `repair_only` and capital state remained `zero_notional`.
- Live `/trading/status` had `proof_floor` but top-level `route_reacquisition_book=null`, and
  `proof_floor.route_reacquisition_book` was absent.
- Live proof-floor blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`.
- Live execution TCA had 7334 orders, 7245 filled executions, zero routeable symbols, five blocked symbols
  (`AAPL`, `AMD`, `AVGO`, `INTC`, `NVDA`), three missing symbols (`AMZN`, `GOOGL`, `ORCL`), average absolute slippage
  `13.8203637593029676` bps, and guardrail `8` bps.
- Live empirical jobs were stale: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` were all completed but older than the 86400 second freshness budget.

### Database And Data Evidence

- Torghut `/db-check` returned `ok=true`, `schema_current=true`, expected head
  `0029_whitepaper_embedding_dimension_4096`, one migration branch, lineage ready, account scope ready, no duplicates,
  and no orphan parents.
- Direct Postgres read via the application secret showed 69 public base tables and Alembic version
  `0029_whitepaper_embedding_dimension_4096`.
- Core Postgres counts: `trade_decisions=147623`, `executions=13778`, `execution_tca_metrics=13775`,
  `position_snapshots=43216`, `vnext_empirical_job_runs=20`, `strategy_hypothesis_metric_windows=3`.
- Freshness split: position snapshots were current at `2026-05-07T17:11:48Z`, TCA metrics were current to
  `2026-05-07T14:23:41Z`, trade decisions stopped at `2026-05-06T17:44:19Z`, and executions stopped at
  `2026-04-03T05:32:38Z`.
- Hypothesis metric windows were all `observed_stage=paper`, `capital_stage=shadow`, and the single promotion decision
  was `allowed=false`.
- ClickHouse live tables were fresh and nonempty: `torghut.ta_signals=1185313` rows with newest event
  `2026-05-07T17:12:40Z`, and `torghut.ta_microbars=1785949` rows with newest event `2026-05-07T17:12:41Z`.
- ClickHouse sim tables were uneven: 20 nonempty sim tables, 82 empty sim tables, and 51 sim databases. The largest
  recent simulation databases were all `2026_05_05` chip runs.

### Source Evidence

- `services/torghut/app/trading/route_reacquisition.py` exists and defines
  `SCHEMA_VERSION = "torghut.route-reacquisition-book.v1"`.
- `services/torghut/app/trading/proof_floor.py` wires `receipt["route_reacquisition_book"] =
build_route_reacquisition_book(...)` in source.
- `services/torghut/app/main.py` is wired to expose `proof_floor.get("route_reacquisition_book")` from `/readyz`,
  `/trading/health`, and `/trading/status`.
- Tests exist for route reacquisition normalization, malformed symbol filtering, routeable/probing/missing states,
  proof-floor routeability blockers, and API passthrough.
- The active runtime does not yet prove this source shape. That is the release activation gap this design addresses.

## Problem

Jangar can prove that services are available, but it does not yet prove that a newly merged proof surface is active in
the runtime that Torghut capital gates are reading. That creates five failure modes:

1. A source PR can merge and update docs/tests while live runtime still serves the prior commit.
2. Argo can be healthy because the desired manifests match, while the desired manifest itself still points at an older
   application commit.
3. Runtime pods can be healthy while endpoint response shapes lack the fields that downstream gates expect.
4. Torghut capital can cite a design or source artifact that has not crossed runtime activation.
5. Deployer handoffs can conflate "merged", "promoted", "rolled out", and "emitting receipts".

This is exactly the kind of ambiguity that lets a safe trading system become brittle. It does not fail open today, but
without an activation receipt it can make humans over-trust source intent and under-check runtime truth.

## Alternatives Considered

### Option A: Keep Manual Source/Runtime Checks

Pros:

- No new Jangar status object.
- Engineers can compare `git log`, Argo manifests, deployment env, and endpoint shapes by hand.
- Minimal implementation cost.

Cons:

- Manual checks are hard to reproduce in deployer and capital gates.
- The comparison is not durable audit evidence.
- It does not give Torghut a receipt ID to cite.
- It does not scale when multiple proof surfaces activate in one release train.

Decision: reject. The current evidence required several separate read paths to expose one activation gap.

### Option B: Treat Argo Health As Activation Truth

Pros:

- Argo is already the GitOps authority.
- It is easy for deployers to check.
- It catches obvious drift between desired manifests and cluster state.

Cons:

- Argo health does not prove endpoint contract shape.
- It does not prove that a source feature is included in the image currently named by GitOps.
- It can be healthy at commit `f65301040` while the Torghut image and `TORGHUT_COMMIT` still point at `4c3eab331`.
- It cannot tell Torghut whether `route_reacquisition_book` is actually emitted.

Decision: reject as incomplete. Argo health is necessary rollout evidence, not activation evidence.

### Option C: Add Runtime Activation Receipts And Source Drift Quarantine

Pros:

- Binds source, GitOps, image, runtime env, and endpoint response shape into one decision.
- Lets Jangar allow read-only serving while holding material launch and capital classes.
- Gives Torghut deterministic activation receipt IDs.
- Makes release train gaps visible without weakening capital guardrails.

Cons:

- Adds a reducer and endpoint-shape probes.
- Requires each material proof surface to declare an endpoint contract.
- Can hold dispatch or capital even when the service is otherwise healthy.

Decision: select Option C.

## Architecture

Add a pure reducer named `control-plane-runtime-activation-receipts` under `services/jangar/src/server/`. The reducer
does not own Kubernetes watches directly. It consumes already-collected status evidence plus bounded HTTP probes to
declared internal endpoints.

`RuntimeActivationReceipt` fields:

- `activation_receipt_id`
- `consumer`: `jangar`, `torghut_live`, `torghut_sim`, `deployer`, or `operator_only`
- `source_head_sha`
- `source_feature_ref`
- `gitops_revision`
- `gitops_manifest_ref`
- `desired_image_digest`
- `runtime_image_digest`
- `runtime_commit`
- `runtime_version`
- `runtime_revision`
- `endpoint_contract`
- `required_shape`
- `observed_shape`
- `shape_hash`
- `decision`: `active`, `source_only`, `gitops_only`, `runtime_only`, `shape_missing`, `stale`, or `blocked`
- `material_action_effect`: `allow`, `hold`, or `block`
- `capital_effect`: `none`, `paper_hold`, `live_hold`, `paper_candidate`, or `live_candidate`
- `observed_at`
- `expires_at`
- `reason_codes`

Initial endpoint contracts:

- `torghut.proof-floor.route-reacquisition-book.v1`: requires `/trading/status` and `/readyz` to include
  `proof_floor.route_reacquisition_book.schema_version=torghut.route-reacquisition-book.v1` or top-level
  `route_reacquisition_book.schema_version=torghut.route-reacquisition-book.v1`.
- `torghut.proof-floor.capital-state.v1`: requires `proof_floor.capital_state`, `proof_floor.route_state`,
  `proof_floor.max_notional`, and `proof_floor.blocking_reasons`.
- `torghut.quant-health.aggregate.v1`: requires aggregate Jangar quant health to include latest metric freshness and
  runtime started flags.
- `jangar.controller-heartbeat.v1`: requires controller heartbeat authority for all enabled controllers.

`SourceDriftQuarantine` fields:

- `quarantine_id`
- `source_head_sha`
- `gitops_revision`
- `runtime_commit`
- `runtime_revision`
- `reason`: `source_ahead_of_runtime`, `gitops_ahead_of_runtime`, `shape_missing`, `mixed_runtime_cohort`,
  `expired_activation`, or `probe_failed`
- `allowed_actions`
- `held_actions`
- `blocked_actions`
- `next_unblocker`
- `rollback_action`

Action policy:

- `serve_readonly` is allowed when deployment readiness and runtime health pass, even if activation is quarantined.
- `dispatch_repair` is allowed only for bounded repair cells whose endpoint contracts are not required for the repair
  itself.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` are held
  when any required activation receipt is `source_only`, `gitops_only`, `shape_missing`, or expired.
- `live_micro_canary` and `live_scale` are blocked when a Torghut capital receipt cites a source feature that lacks an
  active runtime activation receipt.

## Failure-Mode Reduction

This design removes several concrete failure modes:

- Humans no longer need to infer activation by comparing source, Argo, deployment env, image digest, and endpoint JSON
  manually.
- Retained old jobs and healthy current services stop being mixed into one release truth.
- Torghut cannot cite a merged source feature as capital evidence until the active runtime emits the receipt.
- Deployer stages can distinguish "source is merged but not promoted" from "runtime is promoted but endpoint shape is
  absent".
- Jangar can keep serving read-only status without granting material action authority.

## Rollout Plan

Phase 0: shadow projection.

- Add the reducer and endpoint contract registry.
- Emit activation receipts in status as `mode=shadow`.
- Do not change material action decisions.
- Compare receipt decisions against manual checks for Torghut live and sim.

Phase 1: repair and deployer hold.

- Allow `serve_readonly`.
- Hold `dispatch_normal`, `deploy_widen`, and `merge_ready` when a required activation receipt is missing or expired.
- Keep `dispatch_repair` available for bounded activation repair work.

Phase 2: Torghut capital consumption.

- Require Torghut proof-floor and route-reacquisition gates to cite the relevant Jangar activation receipt ID.
- Paper canary remains held while `route_reacquisition_book` is source-only or shape-missing.
- Live capital remains blocked unless all activation receipts and Torghut capital gates pass.

Phase 3: hard material gate.

- Make activation receipts required for every new proof surface that affects capital, dispatch, merge, or rollout
  widening.
- Expired receipts automatically downgrade material action effects to `hold` or `block`.

## Rollback Plan

Rollback is conservative:

- Disable enforcement by setting the reducer to `shadow` while keeping receipt emission.
- Keep serving status and existing health routes unchanged.
- If endpoint probes cause latency or false negatives, reduce the probe set to the last known safe contracts:
  `jangar.controller-heartbeat.v1` and `torghut.proof-floor.capital-state.v1`.
- If Torghut capital consumption is too strict, keep capital at current proof-floor behavior and mark activation
  receipts informational until the false positive is fixed.
- Never use rollback to bypass Torghut live capital guards. The safe fallback is `zero_notional`.

## Validation Gates

Engineer gates:

- Unit: source ahead of runtime yields `decision=source_only` and material action `hold`.
- Unit: runtime endpoint missing a required shape yields `decision=shape_missing`.
- Unit: Argo healthy plus old `TORGHUT_COMMIT` does not produce `active`.
- Unit: active receipt requires source, GitOps, image, runtime env, and endpoint shape agreement.
- Unit: expired activation receipt downgrades `paper_canary`, `live_micro_canary`, and `live_scale`.
- Integration: probe Torghut live and sim endpoints and produce one receipt per contract without mutating cluster state.

Deployer gates:

- `kubectl get deploy -n torghut torghut-*-deployment` confirms the runtime commit.
- `curl /trading/status` and `curl /readyz` confirm the required response shape.
- Jangar status exposes the activation receipt with `decision=active` before rollout widening.
- If a receipt is `source_only`, the deployer waits for release promotion rather than treating source merge as
  runtime evidence.

Torghut capital gates:

- No paper canary can cite `route_reacquisition_book` until the route book activation receipt is active.
- No live capital gate can cite a source feature that is `source_only`, `gitops_only`, `shape_missing`, or expired.
- All rollback targets remain `zero_notional` while activation is not active.

## Handoff To Engineer

Build the Jangar reducer first. Keep it pure and testable.

Implementation ownership:

- `services/jangar/src/server/control-plane-runtime-activation-receipts.ts`
- `services/jangar/src/server/control-plane-status.ts`
- focused tests under `services/jangar/src/server/__tests__/`

Do not start by changing Torghut capital policy. First make the activation truth visible. The first useful fixture is
the current state: source head `f65301040`, runtime commit `4c3eab331`, and missing `route_reacquisition_book` shape.
That fixture should produce `source_only` or `shape_missing`, not `active`.

## Handoff To Deployer

Treat Argo `Healthy` as rollout health, not activation truth.

Before widening dispatch or accepting a Torghut paper/live capital gate, require:

- Jangar activation receipt `decision=active`;
- receipt `expires_at` in the future;
- `source_head_sha`, `gitops_revision`, `runtime_commit`, and endpoint shape all present;
- no `source_drift_quarantine` for the target action class.

If the active Torghut runtime still advertises `TORGHUT_COMMIT=4c3eab331` while source requires
`route_reacquisition_book`, the smallest unblocker is a normal Torghut release promotion to a digest built from the
source commit that contains the route book, followed by endpoint-shape verification. Do not patch live resources
manually.

## Risks

- Endpoint-shape probes can create false holds if the contract is too broad. Keep contracts small and material.
- A source-only state may be expected during normal release lag. The design should not page; it should hold material
  actions and publish the exact unblocker.
- Activation receipts can become another stale artifact if expiry is not enforced. Every material receipt needs
  `expires_at`.
- If the reducer reaches directly into Kubernetes instead of consuming status evidence, it will duplicate existing
  controller responsibilities. Keep collection and reduction separate.

## Final Position

I am choosing activation truth over release optimism.

Jangar is healthy enough to serve, and Torghut is safe enough to keep capital closed. The next reliability gain is to
prove when source intent becomes runtime receipt evidence. Until that proof exists, new profitability artifacts remain
design/source intent, not capital authority.
