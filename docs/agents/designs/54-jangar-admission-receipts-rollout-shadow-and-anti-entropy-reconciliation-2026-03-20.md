# 54. Jangar Admission Receipts, Rollout Shadow, and Anti-Entropy Reconciliation (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`

Extends:

- `51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`
- `52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`
- `53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
- `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`

## Executive summary

The decision is to stop letting each Jangar and Torghut route recompute rollout truth for itself. Jangar will compile
durable **Admission Receipts** from cluster, controller, workflow, empirical, and downstream-health evidence, then
project those receipts into a **Rollout Shadow** that every readiness or promotion surface must reuse.

The reason is straightforward: the runtime on `2026-03-20` can already see the right facts and still publish the wrong
allow answer.

Read-only evidence from this plan run shows:

- `GET http://jangar.jangar.svc.cluster.local/ready`
  - returns `status="ok"`
  - reports `agentsController.enabled=false`
  - reports `supportingController.enabled=false`
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - reports `agents-controller.status="healthy"`
  - reports `supporting-controller.status="healthy"`
  - reports `rollout_health.status="healthy"`
  - reports `dependency_quorum.decision="allow"`
  - also reports `empirical_services.forecast.status="degraded"`
- `GET http://torghut.torghut.svc.cluster.local/readyz`
  - returns `live_submission_gate.ok=true`
  - returns `capital_stage="0.10x canary"`
  - returns `promotion_eligible_total=0`
- `GET http://torghut.torghut.svc.cluster.local/trading/status`
  - returns `live_submission_gate.allowed=true`
  - returns `critical_toggle_parity.status="diverged"`
  - returns `shadow_first.capital_stage="shadow"`
  - reports every hypothesis still in `shadow`
- `kubectl get agentrun -n agents`
  - `torghut-swarm-plan-template` is failed with `BackoffLimitExceeded`
  - `torghut-swarm-verify-template` is failed with `BackoffLimitExceeded`
- `kubectl get pods -n torghut`
  - options catalog and enricher are in `CrashLoopBackOff`
  - options TA is in `ImagePullBackOff`

The tradeoff is more persisted state and stricter receipt freshness rules. That is acceptable because the present
failure mode is worse: contradictory routes can make rollout and capital promotion look safe precisely when the
evidence is split.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Evidence captured on `2026-03-20`:

- `kubectl get pods -n jangar -o wide`
  - `jangar` and `jangar-worker` rolled about 11 minutes before assessment and are now `Running`
  - Jangar DB and Redis remain healthy
- `kubectl get events -n jangar --sort-by=.lastTimestamp | tail -n 60`
  - shows a clean rollout with one transient Jangar readiness failure during startup
- `kubectl get pods -n torghut -o wide`
  - core Torghut revision `torghut-00153` is `Running`
  - forecast pods are `0/1 Running`
  - options catalog and enricher are repeatedly crashing
  - options TA is stuck pulling its image
  - options WS continues to restart
- `kubectl get events -n torghut --sort-by=.lastTimestamp | tail -n 80`
  - shows repeated readiness, liveness, restart, and image-pull failures in the options and forecast paths
- `kubectl get agentrun torghut-swarm-plan-template -n agents -o yaml`
  - `reason=BackoffLimitExceeded`
- `kubectl get agentrun torghut-swarm-verify-template -n agents -o yaml`
  - `reason=BackoffLimitExceeded`

Interpretation:

- the platform is mixed-state rather than fully red;
- Jangar already has enough evidence to distinguish healthy rollout from degraded downstream profit authority;
- the missing primitive is not more monitoring, but one authoritative compiled decision.

### Source architecture and high-risk modules

High-signal source seams in the current branch:

- `services/jangar/src/routes/ready.tsx`
  - still derives readiness from direct controller-health calls and optional execution trust;
  - it can disagree with richer control-plane projections.
- `services/jangar/src/server/control-plane-status.ts`
  - derives controller health from heartbeats and rollout evidence;
  - includes richer empirical and rollout state than `/ready`;
  - still leaves `DEFAULT_EXECUTION_TRUST_ENABLED = false`;
  - still allows `dependency_quorum.decision="allow"` while empirical forecast is degraded because only some empirical
    components are quorum-blocking.
- `services/torghut/app/trading/submission_council.py`
  - computes a richer gate than legacy Torghut did, but it still locally derives truth rather than consuming a durable
    cross-plane artifact;
  - it explicitly blocks on `promotion_eligible_total <= 0`, which makes the current live `allowed=true` output a
    route/runtime drift symptom.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - still performs local gate construction inside the scheduler runtime.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - still declares rollout success from Argo and Kubernetes rollout health without requiring Jangar `/ready`,
    `/api/agents/control-plane/status`, or control-plane digest parity to agree;
  - that makes deploy-time authority more permissive than runtime authority.
- `services/torghut/app/options_lane/catalog_service.py`
  - constructs `OptionsRepository` and seeds rate buckets at import time.
- `services/torghut/app/options_lane/enricher_service.py`
  - does the same, so DB auth drift becomes a boot crash instead of a typed dependency artifact.

Missing tests that matter now:

- no regression proving `/ready`, `/api/agents/control-plane/status`, and downstream promotion consumers are projections
  of the same compiled decision;
- no regression proving deploy verification fails when admission receipts are blocked, stale, or digest-mismatched even
  if Kubernetes rollout and Argo health are green;
- no regression proving a degraded empirical dependency cannot coexist with a top-level `allow` receipt for consumers
  that require it;
- no regression proving route-local recomputation is rejected when its output diverges from the persisted receipt;
- no regression proving options bootstrap failures degrade only the required receipt subjects instead of becoming
  unstructured pod churn.

### Database, schema, and data-state evidence

Direct pod exec is RBAC-forbidden for this service account, so database assessment used service-level read-only APIs and
metrics instead of mutating or exec-based access.

Evidence captured on `2026-03-20`:

- `GET http://torghut.torghut.svc.cluster.local/db-check`
  - `schema_current=true`
  - current and expected head are both `0024_simulation_runtime_context`
  - lineage warnings remain for forked parents at `0010` and `0015`
- `GET http://torghut.torghut.svc.cluster.local/readyz`
  - database, ClickHouse, and Alpaca dependencies report healthy
  - `live_submission_gate.ok=true` despite `promotion_eligible_total=0`
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA`
  - `overallState="down"`
  - `bundleFreshnessSeconds=321961`
  - fundamentals stale
  - news stale
  - technicals and regime in error
  - ClickHouse ingest health reports `clickhouse_query_failed`
- `GET http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - `freshness_fallback_total` remains elevated for `ta_signals` and `ta_microbars`

Interpretation:

- schemas are current enough to trust the control-plane store;
- data freshness and profitability readiness remain inconsistent;
- receipt freshness must therefore be stricter than bare schema health.

## Problem statement

The current control plane still has four systemic contradictions:

1. route-local recomputation means `/ready`, control-plane status, and Torghut promotion surfaces can disagree;
2. the system has segment evidence, but no immutable compiled result that consumers are forced to reuse;
3. rollout truth and downstream authority truth are not versioned together, so drift is detectable but not decisive;
4. downstream runtime contradictions are visible, yet Jangar still has no single object that says "promotion is not
   allowed as of this evidence set."

That is not just an observability issue. It is an authority issue.

## Alternatives considered

### Option A: patch the existing routes and expand dependency-quorum reasons

Pros:

- smallest code delta
- directly addresses the most obvious mismatches

Cons:

- keeps N-way recomputation in place
- does not create an auditable, replayable truth object
- still allows future rollout drift between routes and consumers

Decision: rejected.

### Option B: fail closed globally whenever any profit-adjacent dependency is degraded

Pros:

- easy to reason about
- immediately safer than route-local optimism

Cons:

- destroys failure-domain isolation
- prevents safe Jangar rollout when only one Torghut dependency is red
- reduces operator leverage instead of increasing it

Decision: rejected.

### Option C: compile authoritative admission receipts and project a rollout shadow from them

Pros:

- every consumer reads the same compiled decision
- drift becomes explicit and veto-capable
- rollout and profit authority can be versioned together without collapsing every issue into one global freeze
- preserves future option value for more consumers without multiplying logic

Cons:

- requires additive persistence and anti-entropy loops
- raises the engineering bar for every status surface

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will become the compiler of authoritative **Admission Receipts** and the owner of a **Rollout Shadow** that
exposes desired-versus-observed authority state. Readiness, promotion, and deployer validation must consume those
artifacts rather than recomputing permissive truth locally.

## Architecture

### 1. Admission receipt compiler

Add additive Jangar persistence:

- `control_plane_admission_receipts`
  - key: `{receipt_id, namespace, consumer, receipt_kind}`
  - fields:
    - `decision` in `{allow, delay, block, unknown}`
    - `rollout_epoch`
    - `producer_revision`
    - `producer_config_hash`
    - `evidence_bundle_hash`
    - `observed_at`
    - `expires_at`
    - `required_segments`
    - `blocked_segments`
    - `delayed_segments`
    - `reason_codes`
- `control_plane_admission_receipt_subjects`
  - one row per segment or downstream subject included in the receipt
  - fields:
    - `segment`
    - `scope`
    - `status`
    - `source_kind`
    - `source_ref`
    - `fresh_until`
    - `reason_codes`
- `control_plane_admission_receipt_audits`
  - immutable event log for compile, expire, reconcile, and divergence transitions

Required first-wave receipt kinds:

- `control-plane-readiness`
- `control-plane-rollout`
- `torghut-promotion-authority`
- `collaboration-delivery`

### 2. Rollout shadow

The rollout shadow is the required projection layer that compares:

- desired rollout state from GitOps and known deployment expectations;
- observed runtime state from controller heartbeats, rollout health, agentrun failures, and downstream readiness;
- the currently published admission receipt;
- the last acknowledged downstream consumer state.

Every shadow row must publish:

- `desired_state`
- `observed_state`
- `receipt_decision`
- `shadow_status` in `{aligned, drifted, stale, missing}`
- `drift_reasons`
- `next_reconcile_at`

The design intent is not another dashboard. It is a durable answer to "what did we intend, what did we observe, and
what decision did we publish from that delta?"

### 3. Anti-entropy reconciliation

Jangar adds a periodic anti-entropy loop that:

1. recompiles receipts from fresh evidence;
2. compares route-local projections with the last persisted receipt;
3. marks receipt subjects stale when their freshness windows expire;
4. emits explicit `drift_detected`, `receipt_expired`, `consumer_unacknowledged`, and `shadow_reconciled` audit
   events.

Hard rules:

- if `/ready` would compute a different decision from the last fresh `control-plane-readiness` receipt, Jangar must
  return `503` with `decision_source="divergence_fail_closed"`;
- if Torghut promotion authority has no fresh receipt, Jangar must return `unknown` or `block`, never `allow`;
- if a required downstream consumer has not acknowledged the latest rollout epoch, rollout shadow becomes `drifted`
  and promotion receipts cannot advance beyond `delay`.

### 4. Consumption contract

Every surface must consume the same receipt classes:

- `GET /ready`
  - projection of `control-plane-readiness`
- `GET /api/agents/control-plane/status`
  - projection of `control-plane-readiness`, `control-plane-rollout`, and rollout shadow
- `Swarm.status`
  - derived from the same receipt family, not an independent authority
- Torghut dependency fetch
  - projection of `torghut-promotion-authority`
- deployer verification scripts
  - must validate receipt freshness, shadow alignment, and control-plane digest parity before rollout or merge claims

Direct local recomputation remains allowed only as a shadow-only debug path, never as the final authority path.

### 5. Segment policy changes

This document deliberately narrows optimistic `allow` behavior:

- degraded empirical forecast becomes veto-capable for any consumer that declares `forecast_authority` as required;
- repeated `BackoffLimitExceeded` in required workflow templates becomes a blocked subject, not just a status footnote;
- options bootstrap failures become named receipt subjects so Jangar can scope the blast radius instead of forcing
  operators to infer it from pod churn;
- bare schema health cannot satisfy promotion authority when market-context or quant evidence subjects are stale.

### 6. Explicit failure-mode reduction

This architecture reduces concrete failure modes:

1. `/ready` vs control-plane status contradictions become detectable and fail-closed;
2. stale downstream consumer state becomes a named rollout-shadow problem instead of operator guesswork;
3. promotion decisions cannot outlive the evidence that created them;
4. mixed-state Torghut failures stop polluting unrelated Jangar rollout claims;
5. deployer verification gains one canonical artifact instead of several loosely related HTTP payloads.

## Validation gates

Engineer-stage acceptance gates:

1. Receipt compiler truth-table tests cover:
   - degraded empirical forecast
   - workflow `BackoffLimitExceeded`
   - stale receipt expiry
   - divergent route-local recomputation
2. Route parity tests prove `/ready`, `/api/agents/control-plane/status`, and `Swarm.status` all reuse the same
   receipt decision for the same fixture set.
3. Torghut dependency-consumer tests prove stale or missing promotion receipts fail closed.
4. Shadow tests prove aligned and drifted projections are stable across restarts.

Suggested validation commands:

- `bun run --filter jangar test -- control-plane-status`
- `bun run --filter jangar test -- ready`
- `bun run --filter jangar test -- agents-control-plane`

Deployer-stage acceptance gates:

1. `GET /ready` and `GET /api/agents/control-plane/status?namespace=agents` report the same receipt id and decision.
2. rollout shadow shows `shadow_status="aligned"` for required consumers before promotion claims.
3. no required receipt is stale or missing.
4. deploy verification fails closed when app image, control-plane image, or approved receipt digest disagree.
5. Torghut promotion authority cannot be `allow` when receipt subjects include stale quant, stale market-context, or
   unacknowledged rollout subjects.

Read-only deploy validation examples:

- `curl -fsS http://jangar.jangar.svc.cluster.local/ready | jq .`
- `curl -fsS "http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents" | jq .`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.live_submission_gate'`
- `bun test packages/scripts/src/jangar/__tests__/verify-deployment.test.ts`

## Rollout plan

1. Land receipt tables, compiler, and shadow projection in write-only shadow mode.
2. Expose receipt ids and shadow status in Jangar status surfaces without enforcing them.
3. Switch `/ready` and Torghut dependency fetch to receipt-backed enforcement.
4. Remove permissive route-local recomputation from promotion and readiness paths.

## Rollback plan

If receipt enforcement causes unexpected blocking:

1. disable enforcement with a feature flag while leaving receipt compilation and shadow projection running;
2. keep audit writes on so the divergence root cause is retained;
3. revert only the enforcement switch, not the receipt tables or projection surfaces.

Rollback success means:

- Jangar remains service-available;
- receipt compilation continues;
- deployer and engineer can still inspect drift without relying on production traffic mutation.

## Risks and open questions

- Receipt freshness windows that are too short can create avoidable blocking churn.
- Receipt freshness windows that are too long recreate stale optimism.
- Consumer acknowledgement policy must stay segment-scoped or the system will regress into coarse global freezes.
- The rollout shadow will be operator-critical, so its JSON shape must stay stable enough for scripts and dashboards.

## Handoff contract

Engineer handoff:

- Implement receipt persistence, receipt compiler, route projections, and anti-entropy reconciliation in Jangar.
- Do not add new permissive local fallbacks.
- Treat missing receipt freshness as `unknown` or `block`, never `allow`.
- Add regression tests for every contradiction cited in this document.

Deployer handoff:

- Do not claim rollout safety from `/ready` alone once this lands.
- Verify receipt id parity, shadow alignment, subject freshness, and control-plane digest parity before any promotion or
  merge-ready declaration.
- If shadow and route projections disagree, stop promotion and capture the receipt id plus drift reasons before retrying.

Success for this architecture lane is not "more status." It is one compiled authority artifact that all status and
promotion paths are forced to respect.
