# 148. Jangar Source Rollout Truth Exchange And Proof-Floor Settlement (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, source-to-rollout settlement, controller heartbeat authority, Torghut
proof-floor consumption, validation, rollout, rollback, and engineer/deployer handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/152-torghut-proof-floor-settlement-bonds-and-tca-repair-auction-2026-05-07.md`

Extends:

- `146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md`
- `145-jangar-observation-epoch-tripwire-and-capital-contradiction-arbiter-2026-05-07.md`
- `docs/torghut/design-system/v6/150-torghut-repair-dividend-order-book-and-capital-warrants-2026-05-07.md`
- `docs/torghut/design-system/v6/149-torghut-profit-evidence-convergence-epochs-and-quant-stage-arbitrage-2026-05-07.md`

## Decision

I am selecting **a source rollout truth exchange with Torghut proof-floor settlement** as the next Jangar
control-plane architecture step.

The live cluster is in a much better state than the early May 5 evidence pass. At `2026-05-07T13:08Z`, Argo CD
reported `agents`, `jangar`, and `torghut` as `Synced` and `Healthy` at revision
`4c4417997ba6adb89678d7a784499adfa22b7470`. Jangar and Agents served `/ready` successfully, watch reliability was
healthy, database migrations were current, and recent swarm cron jobs were completing after the older Bun inline
import failure. That is real progress.

The remaining weakness is that Jangar still has several truths that can move independently. The working branch and
local `main` were at `99470fcfa`, one GitOps promotion ahead of the Argo revision. The Agents status endpoint could
derive controller health from rollout state while the same payload still reported `agentrun_ingestion=unknown` with
`agents controller not started` in the serving process. The Jangar database had fresh controller heartbeats, but those
heartbeats were a separate clock from Git source, Argo revision, live image digest, route readiness, and Torghut
proof-floor state. Torghut infrastructure was healthy, but `/readyz` and `/trading/health` returned HTTP 503 because
the trading proof floor remained `repair_only`, market context was stale, forecast registry was empty, alpha readiness
had no promotion-eligible hypotheses, and execution TCA was both stale and far beyond the slippage guardrail.

That means the next reliability gain is not another local readiness check. Jangar needs a settlement receipt that
states, for each action class, whether source head, GitOps revision, desired image digest, live image digest,
controller heartbeat, route status, database projection, watch cache, and Torghut proof-floor evidence agree inside
one freshness window.

The tradeoff is extra reducer work and a stricter deployer gate. I accept it because the current ambiguity is exactly
where rollout mistakes and capital mistakes hide. A healthy rollout may keep serving, but it should not imply normal
dispatch, rollout widening, merge readiness, or Torghut paper/live progression unless the exchange settles the same
truth across planes.

## Runtime Objective And Success Metrics

Success means:

- Jangar publishes a `source_rollout_truth_exchange` section in control-plane status.
- Each `truth_settlement_receipt` names `source_head_sha`, `gitops_revision`, `desired_image_ref`,
  `desired_image_digest`, `live_image_ref`, `live_image_digest`, `controller_heartbeat_ref`, `database_projection_ref`,
  `watch_cache_ref`, `route_status_ref`, `torghut_proof_floor_ref`, `settlement_state`, `fresh_until`, and
  `action_decisions`.
- `serve_readonly` can remain `allow` when route, database, and dependency quorum are healthy even if source and
  rollout clocks differ.
- `dispatch_repair` can remain `allow` only when the repair warrant exchange has a fresh zero-notional warrant and
  the controller heartbeat is fresh enough to observe the run.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` become `repair_only` or `hold` when source head, Argo revision,
  desired image, live image, and controller heartbeat cannot be joined.
- Torghut `paper_canary`, `live_micro_canary`, and `live_scale` consume a settled proof-floor receipt instead of
  interpreting isolated `/readyz`, `/trading/health`, quant health, or database checks.
- Deployer handoff uses one settlement receipt before widening rollouts or changing capital posture.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, ClickHouse tables,
broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster And Rollout Evidence

- The work branch was `codex/swarm-jangar-control-plane-discover` at `99470fcfa`, the same commit as local
  `origin/main` at assessment time.
- Argo CD reported `agents`, `jangar`, and `torghut` as `Synced` and `Healthy` at revision
  `4c4417997ba6adb89678d7a784499adfa22b7470`, so GitOps was one promotion behind the local source head.
- The in-cluster identity was `system:serviceaccount:agents:agents-sa`.
- `agents` was `1/1` available and `agents-controllers` was `2/2` available.
- The Agents serving deployment used `jangar-control-plane:f0b56648@sha256:d9a6ae...`; the controller deployment
  used `jangar:f0b56648@sha256:cbc484...`.
- `jangar` was `1/1` available, with pod `jangar-5c695bbfd4-zjv77` `2/2 Running` on
  `jangar:f0b56648@sha256:cbc484...`.
- Current Agents cron jobs were completing, while old `296354xx` swarm jobs remained as failed historical evidence.
- Recent Agents events still included readiness and liveness probe timeouts around the rollout, but current rollout
  availability was healthy.
- CNPG cluster listing was RBAC-blocked for this service account in both `jangar` and `torghut`, so the deployer
  contract must rely on typed database checks unless a privileged operator chooses to inspect CNPG directly.

### Jangar Control-Plane Evidence

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`.
- `GET /api/agents/control-plane/status?namespace=agents` returned HTTP 200 from both Agents and Jangar serving
  surfaces.
- Watch reliability was healthy: the Agents surface reported `5` streams, `1717` events, `0` errors, and `0`
  restarts; the Jangar surface reported `2` streams, `1616` events, and `0` errors.
- Database migration status was healthy with `28` registered and applied migrations, latest
  `20260505_torghut_quant_pipeline_health_window_index`.
- The status endpoint showed execution trust healthy and material action receipts conservative.
- `dispatch_normal` was reduced to repair-only behavior when controller-process witness evidence was not settled.
- Torghut paper and live action classes stayed held because Torghut consumer evidence and forecast proof were missing
  or degraded.
- The direct Jangar database query showed fresh `agents_control_plane.component_heartbeats` rows at
  `2026-05-07T13:09:21.070Z`, but those rows were not yet a single settled receipt with source head, Argo revision,
  live image, and route readiness.

### Torghut And Data Evidence

- `GET http://torghut.torghut.svc.cluster.local/healthz` returned `status=ok`.
- `GET /readyz` and `GET /trading/health` returned HTTP 503 with `status=degraded`.
- `GET /db-check` returned HTTP 200, schema-current at Alembic head `0029_whitepaper_embedding_dimension_4096`, branch
  count `1`, no duplicate revisions, and lineage ready.
- `/db-check` retained historic parent-fork warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- `/trading/autonomy` reported empirical jobs healthy and fresh for candidate
  `chip-paper-microbar-composite@execution-proof`, dataset `torghut-chip-full-day-20260505-5e447b6d-r1`.
- The forecast service was configured false and degraded with `registry_empty`.
- Quant direct health was HTTP 200, but stage rows were empty and `pipelineHealthSkippedReason` was
  `account_and_window_required`.
- The proof floor remained `repair_only`, `capital_state=zero_notional`, with blockers
  `hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`, `market_context_stale`, and
  `simple_submit_disabled`.
- TCA was stale and poor: `13,775` orders, latest computed at `2026-04-02T20:59:45.136640Z`, and
  `avg_abs_slippage_bps=568.6138848199565249` against an `8` bps guardrail.
- Direct Torghut database reads showed `trade_decisions` still arriving on `2026-05-06`, but executions and TCA
  metrics last updated on `2026-04-02`, proving that decision freshness and execution-quality freshness are separate
  clocks.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the status aggregation boundary and is already large enough
  that the settlement reducer should be factored outside route assembly.
- `services/jangar/src/server/control-plane-controller-witness.ts` owns controller witness logic and should provide a
  typed input to settlement rather than being bypassed by rollout-only health.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` already converts evidence into action-class
  decisions and should consume settlement states.
- `services/jangar/src/server/control-plane-route-stability-escrow.ts` and watch reliability tests already provide
  route and watch evidence that can become settlement inputs.
- `services/jangar/src/server/torghut-quant-runtime.ts` and `torghut-quant-metrics-store.ts` already project Torghut
  quant health, but they do not prove the trading proof floor is capital-ready.
- Focused tests exist for controller witness, material action verdicts, route stability escrow, watch reliability,
  quant runtime, quant metrics store, and control-plane status. The new work should add pure reducer tests instead of
  relying on end-to-end cluster access.

## Problem

Jangar currently projects several true facts without requiring them to agree before sensitive action classes widen.

The failure modes are:

1. A source branch can move ahead of Argo while deployed services remain healthy, causing operators to over-read
   serving health as rollout convergence.
2. Rollout-derived controller health can coexist with serving-process ingestion unknown, causing a false sense of
   normal dispatch readiness.
3. Fresh database heartbeats can prove a controller existed without proving it belongs to the source, image, and Argo
   revision being promoted.
4. Torghut can have healthy Postgres, ClickHouse, schema, scheduler, and empirical jobs while the proof floor is still
   zero-notional repair-only.
5. Deployer and engineer stages must currently join source, Argo, runtime, database, and trading proof by hand.

## Alternatives Considered

### Option A: Extend The Existing Repair Warrant Exchange Only

Pros:

- Lowest implementation cost.
- Keeps the repair work authorization model stable.
- Does not add a new status section.

Cons:

- Leaves source, rollout, live image, heartbeat, and proof-floor agreement implicit.
- Does not solve the one-revision GitOps lag observed in this run.
- Still lets deployers infer rollout readiness from several unrelated fields.

Decision: reject as insufficient.

### Option B: Treat Argo Revision As The Sole Rollout Truth

Pros:

- Simple and familiar for GitOps operators.
- Easy to validate with `argocd` application state.
- Clear rollback target.

Cons:

- Argo health does not prove serving route readiness, controller heartbeat freshness, or database projection health.
- It cannot distinguish rollout health from trading proof-floor readiness.
- It would have marked this run healthy while Torghut remained proof-floor blocked and Jangar had ingestion authority
  ambiguity.

Decision: reject as too narrow.

### Option C: Add A Source Rollout Truth Exchange

Pros:

- Joins source head, GitOps revision, desired image, live image, controller heartbeat, route status, database
  projection, watch cache, and Torghut proof-floor evidence into one receipt.
- Lets serving remain available while normal dispatch, rollout widening, merge readiness, and capital action stay
  conservative.
- Converts a confusing set of partial truths into action-class settlement.
- Gives engineer and deployer stages one testable handoff object.

Cons:

- Adds reducer, fixture, and status schema work.
- Requires tight freshness budgets so status serving does not block on slow consumers.
- Requires careful wording so settlement is not mistaken for a capital approval.

Decision: select Option C.

## Architecture

Jangar adds a pure reducer and status projection:

```text
source_rollout_truth_exchange
  generated_at
  namespace
  source_head_sha
  gitops_revision
  desired_images[]
  live_images[]
  controller_heartbeats[]
  route_statuses[]
  database_projection
  watch_reliability
  torghut_proof_floor
  receipts[]
```

Each receipt has:

```text
truth_settlement_receipt
  receipt_id
  action_class
  settlement_state
  source_head_sha
  gitops_revision
  desired_image_ref
  desired_image_digest
  live_image_ref
  live_image_digest
  controller_heartbeat_ref
  database_projection_ref
  watch_cache_ref
  route_status_ref
  torghut_proof_floor_ref
  fresh_until
  action_decision
  blocking_reasons[]
  rollback_target
```

Settlement states are:

- `converged`: source, GitOps, desired image, live image, controller heartbeat, route, database, watch cache, and
  required consumer proof agree inside the freshness window.
- `rollout_lagging_source`: deployed Argo revision or live image is behind the source head being considered.
- `heartbeat_projection_split`: rollout health and controller heartbeat authority do not agree.
- `proof_floor_repair_only`: Jangar is healthy enough for repair, but Torghut proof-floor state blocks capital.
- `consumer_evidence_missing`: source and rollout may be healthy, but required downstream proof is absent or stale.
- `unknown`: one or more required settlement inputs cannot be read.

Action decisions are intentionally asymmetric:

- `serve_readonly`: allow on healthy route, dependency quorum, and database projection even when rollout clocks lag.
- `dispatch_repair`: allow only for zero-notional repairs with a fresh warrant, fresh controller heartbeat, healthy
  route, and bounded runtime budget.
- `dispatch_normal`: require `converged` settlement and no material controller witness split.
- `deploy_widen`: require source head, Argo revision, desired image, live image, and controller heartbeat to settle for
  the target deployment.
- `merge_ready`: require local branch, PR head, CI head, and deployer target to be named in the receipt; docs-only
  changes may settle without live image changes, but the receipt must say so.
- `torghut_observe`: allow while Torghut is repair-only if the route and database checks are healthy.
- `paper_canary`, `live_micro_canary`, and `live_scale`: require companion Torghut proof-floor settlement bonds to
  close and must never be opened by Jangar rollout health alone.

## Implementation Scope

Engineer stage should implement:

1. A `control-plane-source-rollout-truth-exchange` reducer with fixtures for source/Argo/live image mismatch,
   heartbeat split, proof-floor repair-only, and full convergence.
2. A status projection under `/api/agents/control-plane/status` that exposes settlement receipts without increasing
   route latency when a downstream consumer is slow.
3. Material-action verdict integration so action classes consume settlement states.
4. A deployer-readable summary that names the freshest blocking reason and rollback target.
5. Tests that prove serving can remain green while dispatch normal, deploy widen, merge ready, and Torghut capital stay
   held.

Out of scope for this design artifact:

- Mutating Kubernetes resources.
- Writing database records.
- Enabling Torghut submit flags.
- Replacing Argo CD as the GitOps authority.

Implementation note: status projection and material-action consumption (2026-05-07).

- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` now builds a deterministic
  `source_rollout_truth_exchange` from already-collected runtime kits, pod image evidence, controller witness quorum,
  route probe, database projection, watch cache, and Torghut action-budget proof-floor inputs.
- `/api/agents/control-plane/status` exposes exchange receipts for `serve_readonly`, `dispatch_repair`,
  `dispatch_normal`, `deploy_widen`, `merge_ready`, `torghut_observe`, and Torghut capital classes without adding any
  synchronous downstream calls to the status route.
- Material-action verdicts now consume the matching truth-settlement receipt as one more conservative signal. Serving
  and bounded repair can stay allowed during normal source/GitOps lag, while `dispatch_normal` downgrades to
  `repair_only` and `deploy_widen`/`merge_ready` hold until source, GitOps revision, desired image, live image, and
  controller heartbeat settle.
- Rollback is status-side only: ignore `source_rollout_truth_exchange` and remove it from material-action verdict input
  to return to the previous verdict reducer while keeping route readiness and existing runtime-admission gates intact.

## Validation Gates

Engineer validation:

- Unit tests for each settlement state and action decision.
- Snapshot tests for the status payload with compact, stable field names.
- A regression test where Argo is healthy but one revision behind source and `dispatch_normal` remains repair-only.
- A regression test where controller rollout health exists but controller heartbeat authority is missing or stale.
- A regression test where Torghut `/db-check` is current but proof-floor settlement is `repair_only`.
- Existing targeted tests for material action verdicts, controller witness, route stability escrow, watch reliability,
  and control-plane status stay green.

Deployer validation:

- `kubectl -n argocd get application agents jangar torghut -o wide` shows the target GitOps revision.
- Live deployments expose the image digests named by the settlement receipt.
- `GET /ready` is healthy for Agents and Jangar.
- `GET /api/agents/control-plane/status?namespace=agents` includes a fresh `source_rollout_truth_exchange`.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` are not widened unless settlement is `converged`.
- Torghut capital stays zero-notional unless the companion proof-floor settlement bond is closed.

## Rollout Plan

1. Ship the reducer behind a status-only projection with no action-class enforcement.
2. Compare receipts against existing material-action decisions for at least one full schedule cycle.
3. Enable material-action consumption for `dispatch_normal` and `deploy_widen`.
4. Enable Torghut action-class consumption after companion proof-floor bond receipts are visible.
5. Add deployer runbook language that names the receipt fields required before widening.

## Rollback Plan

Rollback is conservative:

- If settlement projection fails, omit the new section and keep existing action verdicts conservative.
- If settlement disagrees with known-good route health, keep `serve_readonly` allowed and hold dispatch widening.
- If Torghut proof-floor input is missing, treat Torghut as `repair_only` and keep capital zero-notional.
- If reducer latency threatens serving, cache the last fresh receipt and mark it expired instead of blocking `/ready`.
- Revert the status-projection feature flag before changing database schema or Kubernetes manifests.

## Risks And Mitigations

- Risk: operators mistake settlement for capital approval. Mitigation: settlement names action class, and Torghut
  capital classes require companion proof-floor bond closure.
- Risk: receipt churn creates noise. Mitigation: stable receipt IDs should be derived from action class, source head,
  GitOps revision, image digest, heartbeat identity, and proof-floor epoch.
- Risk: status route latency grows. Mitigation: use cached typed inputs and freshness expiration, not synchronous
  blocking calls to every dependency.
- Risk: GitOps revision lag is normal during promotion. Mitigation: allow serving and repair while holding only the
  action classes that require convergence.

## Engineer Handoff

Build the exchange as a pure reducer first. The reducer should accept already-collected source, rollout, heartbeat,
route, database, watch, and Torghut proof-floor inputs and return deterministic receipts. Keep route assembly thin.
Then wire the reducer into material-action verdicts. The highest-value regression test is the exact shape from this
run: Argo apps are synced and healthy at `4c4417997`, local source is `99470fcfa`, Jangar route and database are
healthy, but Torghut proof floor is repair-only. Serving and repair should stay allowed; normal dispatch, widening,
merge readiness, and capital should stay held.

## Deployer Handoff

Before widening, require the source rollout truth exchange to name the same target commit and image digest that Argo
and the live deployments expose. Treat a healthy Argo app as necessary but not sufficient. Treat fresh Jangar database
heartbeats as necessary but not sufficient. Treat Torghut schema-current and healthz as necessary but not sufficient.
The deployer gate is closed until the receipt says which action class is converged and which proof-floor settlement
unlocks the next Torghut capital step.
