# 72. Jangar Route-Authority Fuses and Deploy Quarantine (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Gideon Park (Torghut Traders)
Scope: Jangar control-plane route budgets, runtime admission, deploy proof, Torghut quant health, and safe
actuation/quarantine behavior.

Companion doc:

- `docs/torghut/design-system/v6/77-torghut-hot-path-proof-projections-and-profit-cell-settlement-2026-05-05.md`

Extends:

- `70-jangar-actuation-escrow-and-deploy-proof-lanes-2026-05-05.md`
- `71-jangar-least-privilege-evidence-projection-broker-and-deploy-gates-2026-05-05.md`
- `70-jangar-evidence-epoch-admission-and-rollout-quarantine-2026-05-05.md`
- `69-jangar-evidence-escrow-and-repair-cell-contract-2026-05-05.md`
- `67-jangar-evidence-epochs-and-proof-cell-rollout-contract-2026-05-05.md`

## Executive Summary

The decision is to add route-authority fuses and deploy quarantine to Jangar's evidence-epoch and actuation-escrow
stack.

The reason is current live behavior. Jangar `/ready` is fast and returns HTTP `200`, but it reports degraded execution
trust, stale Jangar and Torghut stages, and a blocked collaboration runtime kit because the deployed image lacks the
`nats` CLI. At the same time, the heavier control-plane status route and Torghut quant-health route timed out at ten
seconds, while logs showed repeated heartbeat read timeouts and GitHub review ingestion failures for deleted refs. The
control plane can still serve humans, but route-time authority is not reliable enough to admit dispatch, deploy
widening, or Torghut capital promotion.

The tradeoff is a stricter split between serving and actuation. `/ready` can stay up to support repair, but dispatch,
review authority, deploy proof, and Torghut promotion must fail closed when their route-authority fuse is stale,
missing, or over budget.

## Assessment Evidence

All cluster checks were read-only.

### Runtime and Collaboration

- The NATS context soak read `workflow.general.>` and fetched `0` prior messages for this run.
- The runner image initially had `codex-nats-publish` and `codex-nats-soak` but no `nats` binary. Installing NATS CLI
  `0.4.0` locally made publish work for this run.
- Jangar `/ready` still reported deployed collaboration runtime admission as blocked with
  `runtime_kit_component_missing:nats_cli`, so the deployed image, not just this workspace, needs a runtime-kit gate.

### Cluster and Events

- `kubectl get pods -n jangar -o wide` showed `jangar-675b5b8855-rwglb` running `2/2`.
- Recent events showed Jangar rollout replacement, Jangar DB readiness probe failure, and Redis readiness/liveness
  timeouts.
- `kubectl get pods -n agents -o wide` showed active agents and controller pods, plus many old failed swarm schedule
  pods.
- `kubectl get agentruns -n agents` showed current Jangar and Torghut runs mixed with old failed requirements and
  stale scheduled stages.

### Route Behavior

- `curl /ready` returned HTTP `200` in `0.058375` seconds.
- The `/ready` payload reported:
  - `execution_trust.status="degraded"`;
  - `requirements are degraded on jangar-control-plane: pending=5`;
  - stale discover, plan, implement, and verify stages for Jangar and Torghut;
  - `runtime_kit_component_missing:nats_cli` on collaboration passports.
- `curl /api/agents/control-plane/status?namespace=agents` timed out after ten seconds.
- `curl /api/torghut/trading/control-plane/quant/health` timed out after ten seconds.
- Jangar logs showed repeated control-plane heartbeat read timeouts and repeated GitHub review ingest failures where
  branch refs could not be resolved after PRs were merged or deleted.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes controller heartbeats, rollout health, execution
  trust, workflow reliability, database status, runtime admission, empirical services, and dependency quorum in one
  status assembly.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already produces runtime kits and admission
  passports, but missing `nats` is still a reported fact rather than an image-build and stage-actuation blocker.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` starts quant runtime work and reads
  latest metrics plus latest pipeline health on the request path.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` has a compact latest metrics status, but pipeline health
  uses a ranked latest-row query. Given the observed timeout, this must be fenced by a route budget or replaced by a
  bounded projection.

## Problem Statement

Jangar has enough facts to diagnose degraded authority, but some of those facts are assembled synchronously on routes
that downstream systems treat as control-plane truth. That creates three failure modes:

1. serving stays green while action authority is degraded;
2. slow routes become ambiguous timeouts instead of explicit hold/block decisions;
3. missing runtime components and deleted-ref ingestion defects remain observable but not quarantine-capable.

The system needs one rule: route budget failure is authority failure for actuation, not a reason to wait longer and
hope the route eventually returns.

## Alternatives Considered

### Option A: Make `/ready` Return 503 for Every Degraded Control-Plane Fact

Pros:

- Simple to understand.
- Forces operators to notice degraded execution trust.

Cons:

- Takes away the repair surface when the system is degraded.
- Couples serving availability to trading and review economics.
- Does not explain which action is blocked.

Decision: rejected.

### Option B: Keep Current Routes and Raise Timeouts

Pros:

- Minimal implementation.
- Avoids schema or projection work.

Cons:

- Turns route budget breaches into hidden latency.
- Leaves dispatch, deploy, and Torghut promotion interpreting independent route failures.
- Does not make missing `nats` or deleted-ref ingestion quarantine-capable.

Decision: rejected.

### Option C: Route-Authority Fuses and Deploy Quarantine

Pros:

- Keeps serving routes available for repair.
- Fails actuation closed when authority is stale, missing, or over budget.
- Converts missing runtime tools, deleted-ref review defects, and slow Torghut proof routes into explicit quarantine
  reasons.
- Supports partial-RBAC validation by consuming bounded projections.

Cons:

- Adds route-fuse state and deploy-proof records.
- Requires updates across runtime admission, deploy checks, and Torghut quant health.
- Requires operators to learn a stronger distinction between serving and actuation.

Decision: selected.

## Decision

Adopt Option C.

The Jangar companion layer has three contracts.

### 1. RouteAuthorityFuse

`RouteAuthorityFuse` records whether a route is allowed to serve as authority for a consumer.

Required fields:

- `route_authority_fuse_id`;
- `route_name`;
- `consumer_class`: `serving`, `swarm_dispatch`, `review_ingest`, `deploy_widening`, `torghut_promotion`;
- `evidence_epoch_id`;
- `route_budget_ms`;
- `last_success_at`;
- `last_duration_ms`;
- `decision`: `allow`, `degrade`, `hold`, or `block`;
- `reason_codes`;
- `fresh_until`;
- `fallback_projection_ref`.

Rules:

- `/ready` may be `allow` for serving while `swarm_dispatch` or `torghut_promotion` is `block`.
- A timeout or missing projection is a `block` for actuation consumers.
- A degraded runtime kit is a `block` for any consumer that depends on that kit.

### 2. DeployQuarantine

`DeployQuarantine` holds a revision, route, consumer class, or Torghut promotion target out of widening until proof is
fresh.

Required quarantine reasons:

- `runtime_kit_component_missing:nats_cli`;
- `route_budget_exceeded`;
- `torghut_projection_missing`;
- `torghut_projection_stale`;
- `deleted_ref_review_ingest_unresolved`;
- `heartbeat_store_timeout`;
- `image_platform_receipt_missing`;
- `dependency_quorum_block`.

Quarantine must be reversible by writing a newer proof record. It must not require deleting old facts.

### 3. TorghutProofMirror

`TorghutProofMirror` is Jangar's bounded copy of Torghut proof authority. It must be small enough for route-time reads
and must reference the Torghut `ProofProjection` and `ProfitCellSettlement` identifiers.

Required fields:

- `proof_projection_id`;
- `profit_cell_settlement_id` when promotion is requested;
- `evidence_epoch_id`;
- `torghut_route_budget_status`;
- `data_freshness_status`;
- `post_cost_profit_status`;
- `capital_stage`;
- `fresh_until`;
- `reason_codes`.

Jangar must not infer Torghut profit authority from broad quant history on the request path.

## Implementation Scope

Engineer stage:

1. Extend runtime admission so missing `nats` blocks collaboration stage actuation before a run starts.
2. Add route-authority fuse records for `/ready`, control-plane status, review ingest, deploy proof, and Torghut
   quant health.
3. Add deleted-ref fallback in review ingestion so merged or deleted PR branches resolve through merge commit SHA or
   archived PR metadata instead of producing repeated live defects.
4. Refactor Torghut quant health to consume the Torghut proof projection or a bounded Jangar mirror.
5. Add tests for serving-allowed/action-blocked split, missing runtime component quarantine, route timeout quarantine,
   and deleted-ref fallback.

Deployer stage:

1. Verify the deployed Jangar image includes `nats`, `codex-nats-publish`, and `codex-nats-soak`.
2. Verify `/ready` remains available while actuation fuses can independently block unsafe consumers.
3. Verify the control-plane status route has a route fuse and no longer acts as the only dispatch authority.
4. Verify Torghut promotion is blocked when the Torghut proof mirror is missing, stale, or over budget.

## Validation Gates

Required implementation checks:

- Unit tests for route-authority fuse evaluation.
- Unit tests for runtime-kit admission when `nats` is missing.
- Route tests proving `/ready` can serve while swarm dispatch is blocked.
- Route tests proving Jangar quant health returns bounded projection authority.
- Review-ingest tests for deleted or merged head refs.
- Existing Jangar formatter, linter, and relevant route test suite.

Required live checks:

- `/ready` returns within `500 ms`.
- Control-plane action authority returns a fuse decision within `750 ms`.
- Torghut quant health returns projection-backed authority within `750 ms`.
- Collaboration runtime kit reports `nats_cli` present in the deployed image.
- No deploy widening proceeds while a required fuse is `block`.

## Rollout

1. Write fuses in shadow mode and expose them in `/ready`.
2. Make dispatch and deploy verification log the selected fuse id without enforcement.
3. Enforce missing runtime kit quarantine for new collaboration runs.
4. Switch Torghut quant health to the proof mirror.
5. Enforce deploy quarantine for route-budget and Torghut-proof failures.
6. Remove any workflow that treats broad control-plane status timeout as an acceptable wait state.

## Rollback

Rollback keeps the facts and relaxes enforcement:

- stop enforcing deploy quarantine;
- keep writing route fuses;
- keep `/ready` serving from the current path;
- force Torghut promotion consumers to observe-only if the proof mirror is missing;
- preserve quarantine records for audit and repair.

## Risks and Open Questions

- The observed control-plane status timeout may have multiple causes. The design treats route budget breach as the
  actionable failure even before root cause is narrowed.
- `/ready` payloads are already large. Fuse summaries must stay compact enough that the serving route remains cheap.
- Review ingest deleted-ref fallback must not hide legitimate branch-resolution failures for open PRs.
- Runtime-kit enforcement must be staged carefully so existing emergency repair runs are not stranded without a
  documented override.

## Handoff Contract

Engineer acceptance gates:

- Runtime admission blocks collaboration actuation when `nats` is missing.
- Route-authority fuses exist for serving, dispatch, deploy, review ingest, and Torghut promotion.
- Jangar quant health consumes Torghut proof projection or a bounded mirror.
- Deleted-ref review ingest failures resolve through commit/archived PR metadata for merged PRs.

Deployer acceptance gates:

- The Jangar image includes the collaboration runtime kit.
- Required route fuses are fresh and under budget before deploy widening.
- Torghut promotion remains blocked unless the Torghut proof mirror and profit cell are fresh.
- Rollback relaxes enforcement without deleting fuse, quarantine, or proof records.
