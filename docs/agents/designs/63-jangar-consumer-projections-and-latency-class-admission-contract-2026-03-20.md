# 63. Jangar Consumer Projections and Latency-Class Admission Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`

Extends:

- `62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`
- `61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md`
- `60-jangar-recovery-ledger-and-consumer-attestation-contract-2026-03-20.md`
- `57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`

## Executive summary

The decision is to stop treating one generic Jangar control-plane route as the authority path for every consumer and
instead publish two durable control-plane objects: **Consumer Projections** and **Latency-Class Admissions**.

The live evidence on `2026-03-20` is strong enough that this is no longer optional:

- `GET http://jangar.jangar.svc.cluster.local/ready`
  - returns HTTP `200`;
  - still reports `execution_trust.status="degraded"`;
  - still cites `jangar-control-plane.requirements.pending=5`;
  - still cites unreconciled `StageStaleness` freeze debt for both `jangar-control-plane` and `torghut-quant`.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - reports `rollout_health.status="healthy"` for `agents` and `agents-controllers`;
  - still reports `execution_trust.status="degraded"`;
  - still reports `authority_session=null`, `runtime_kits=null`, `admission_passports=null`, `execution_receipts=null`,
    `recovery_ledger=null`, and `consumer_attestations=null`.
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
  - returns `ok=true`, `status="degraded"`;
  - returns `latestMetricsCount=36`, `metricsPipelineLagSeconds=4`;
  - isolates the real bad stage as `ingestion.lagSeconds=98202` rather than flattening everything to a generic fetch failure.
- `GET http://torghut-00156-private.torghut.svc.cluster.local:8012/trading/health`
  - still reports `quant_evidence.detail="quant_health_fetch_failed"`;
  - still resolves `source_url="http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?account=PA3SX7FYNUTF&window=15m"`;
  - still times out on the generic Jangar status path even though the typed quant-health path answers directly.
- `argocd/applications/jangar/deployment.yaml`
  - still runs the Jangar web pod as `replicas: 1` with `Recreate`;
  - still keeps readiness bound to `/health`;
  - still co-locates Torghut quant control-plane work on the same pod.

The tradeoff is more additive persistence and explicit admission policy classes. I am keeping that trade because the
current failure mode is no longer "Jangar is down." It is "Jangar is serving, but the wrong consumer path times out or
shares stale debt with consumers that did not need it."

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Jangar
  resilience/reliability, safer rollout behavior, and Torghut profitability

This document succeeds when:

1. every Jangar consumer can cite one `consumer_projection_id` and one `latency_class_admission_id` instead of
   relying on a broad request-time reducer;
2. `serving-fast` and `torghut-quant-fast` remain independently admissible when `interactive-status` is degraded or
   timing out;
3. stale watch or freeze recovery debt blocks only the affected consumer classes rather than synthesizing one global
   degraded answer for rollout, Torghut, deploy verification, and cross-swarm handoff;
4. rollout safety becomes stricter, not looser: no class may advertise `healthy` when it is still borrowing health
   from replica availability or process-local memory.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The live cluster is serving traffic, but it is still collapsing very different failure classes into one route family.

- `kubectl -n jangar get pods`
  - shows the current Jangar web and worker pods running;
  - does not prove the Torghut quant control-plane path is independently admissible.
- `GET /ready`
  - proves the web pod is allowed to serve;
  - does not prove stale freeze debt is resolved;
  - does not prove Torghut can fetch the right projection without contention.
- `GET /api/agents/control-plane/status?namespace=agents`
  - proves controller rollout and database connectivity are healthy;
  - still exposes unresolved March 11, 2026 freeze debt and pending requirement debt.
- `GET /api/torghut/trading/control-plane/quant/health`
  - proves the typed Torghut consumer surface can return a bounded, meaningful answer quickly.

Interpretation:

- Jangar needs a first-class distinction between "the web pod can serve" and "this consumer class is admissible";
- the typed Torghut quant-health route is already closer to the right authority shape than the generic status route;
- rollout safety will improve only if those two classes stop sharing one request-time reduction path.

### Source architecture and test-gap evidence

The highest-risk source hotspots are still optimistic synthesis and process-local truth.

- `services/jangar/src/routes/ready.tsx`
  - returns `200` whenever execution trust is not `blocked` or `unknown`;
  - does not surface a consumer-scoped projection id that deployers or Torghut can reuse.
- `services/jangar/src/server/control-plane-status.ts`
  - still contains rollout-derived fallback behavior that can treat missing controller/runtime detail as healthy enough
    because `agents-controllers` has available replicas;
  - still emits one large status document rather than bounded consumer projections.
- `services/jangar/src/server/control-plane-watch-reliability.ts`
  - still depends on a process `Map`;
  - `unknown` watch state remains too easy to treat as "not presently blocking."
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - still uses in-process swarm unfreeze timers;
  - stale-stage repair remains behavior, not durable admission evidence.
- `services/jangar/src/server/torghut-quant-runtime.ts`
  - still keeps quant-runtime cadence and cache state inside the web process;
  - the typed quant route is a better consumer shape, but it is still co-located with interactive UI/API serving.

Architectural test gaps:

- no regression proves `interactive-status` timing out still leaves `serving-fast` green when serving receipts remain
  healthy;
- no regression proves a stale watch or recovery cell blocks `handoff-async` or `torghut-quant-fast` without forcing
  `serving-fast` down;
- no parity test proves `/ready`, the quant-health route, deploy verification, and the generic status route cite the
  same underlying receipt and recovery evidence when they overlap.

### Database, schema, freshness, and consistency evidence

Jangar already has enough stable persistence to own this contract safely.

- `GET /api/agents/control-plane/status?namespace=agents`
  - reports database healthy and migration-consistent;
  - shows the substrate is not the current blocker.
- scoped service-account access still forbids `pods/exec` into Jangar DB pods from this workspace;
- that is acceptable because the correct fix is more additive control-plane persistence, not broader operator access.

Interpretation:

- this is not a database fragility problem;
- it is a control-plane authority-shaping problem;
- Jangar should persist consumer truth instead of recomputing it broadly per request.

## Alternatives considered

### Option A: keep the generic status route and add more caching/timeouts

Pros:

- smallest code delta;
- fastest way to hide the immediate timeout symptom.

Cons:

- the same broad reducer remains the common-mode blast radius;
- serving, deploy verification, Torghut quant, and handoff keep contending on one truth path;
- rollout can still appear healthier than the consumer that actually needs to run.

Decision: rejected.

### Option B: move Torghut capital authority entirely into Jangar

Pros:

- one platform-owned authority path;
- less Torghut-local orchestration logic.

Cons:

- makes Jangar web-pod contention even more expensive;
- reduces Torghut option value for lane-local experimentation and repair-probe economics;
- couples platform rollout errors directly to trading-economics final authority.

Decision: rejected.

### Option C: consumer projections plus latency-class admission

Pros:

- isolates fast, typed consumer paths from heavy interactive status payloads;
- keeps serving safety strict while reducing false consumer-wide coupling;
- gives rollout, Torghut, deploy verification, and handoff one reusable identifier set to trust.

Cons:

- adds new tables and a projection compiler;
- requires shadow parity before enforcement.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will compile consumer-scoped projections and latency-class admissions from execution receipts and recovery cells.
The generic status route becomes a projection consumer, not the source of truth compiler.

## Architecture

### 1. Consumer projections

Add additive persistence:

- `control_plane_consumer_projections`
  - `consumer_projection_id`
  - `consumer_name` (`serving`, `interactive_status`, `torghut_quant`, `deploy_verify`, `handoff_huly`)
  - `execution_class`
  - `projection_version`
  - `required_execution_receipt_ids_json`
  - `required_recovery_cell_ids_json`
  - `required_dependency_segments_json`
  - `payload_json`
  - `decision` (`healthy`, `degraded`, `blocked`, `unknown`)
  - `reason_codes_json`
  - `projection_digest`
  - `observed_at`
  - `expires_at`

Rules:

- every consumer projection is compiled independently;
- `torghut_quant` includes only the bounded fields Torghut needs: quant-health summary, dependency-segment summary,
  empirical-jobs summary, and projection ids;
- `interactive_status` may be richer and slower, but it may no longer act as the only authority input for other
  consumers;
- a projection may cite overlapping receipts and recovery cells with another projection, but it must keep its own
  decision and expiry.

### 2. Latency-class admissions

Add additive persistence:

- `control_plane_latency_class_admissions`
  - `latency_class_admission_id`
  - `latency_class` (`serving_fast`, `interactive_status`, `torghut_quant_fast`, `handoff_async`, `deploy_verify`)
  - `max_eval_ms`
  - `cache_ttl_ms`
  - `hard_dependencies_json`
  - `source_budget_json`
  - `decision` (`healthy`, `degraded`, `blocked`, `unknown`)
  - `reason_codes_json`
  - `observed_at`
  - `fresh_until`

Rules:

- `/ready` consumes only `serving_fast`;
- `/api/agents/control-plane/status` consumes `interactive_status`;
- `/api/torghut/trading/control-plane/quant/health` consumes `torghut_quant_fast`;
- handoff and requirement launchers consume `handoff_async`;
- a timeout or `unknown` in `interactive_status` may not synthesize failure or success for `serving_fast` or
  `torghut_quant_fast`;
- a blocked `handoff_async` class may stop Huly-dependent stage launch without taking Jangar serving down.

### 3. Recovery and watch evidence become admission inputs, not comments

Implementation implications:

- move watch-reliability summaries out of process-local `Map` state and into durable projection inputs;
- move freeze-expiry repair ownership and closure into durable recovery records rather than only in-process timers;
- treat `unknown` watch evidence as explicit admission debt for the affected class, not a silent non-event;
- remove rollout-derived optimism that upgrades missing controller/runtime detail to healthy just because a deployment
  has available replicas.

### 4. Route and tooling contract

The runtime surfaces change as follows:

- `services/jangar/src/routes/ready.tsx`
  - returns the `serving_fast` projection id and admission id;
  - stays fail-closed only on serving-class blockers.
- `services/jangar/src/routes/api/agents/control-plane/status.ts`
  - returns a map of consumer projections and latency-class admissions;
  - becomes an observer of compiled truth, not the reducer that makes it.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`
  - returns the `torghut_quant_fast` projection id and the exact recovery cells that shaped it;
  - must no longer depend on the heavier interactive status reducer to answer.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - verifies digest parity plus required projection/admission ids for the deploy class.

## Validation, rollout, and rollback

Engineer acceptance gates:

1. Add tests proving `interactive_status` timeout or cache expiry does not flip `/ready` when `serving_fast` remains
   healthy.
2. Add tests proving `torghut_quant_fast` can still answer with a valid projection id while `interactive_status` is
   degraded.
3. Add tests proving stale watch evidence or unresolved freeze recovery blocks the affected class and is preserved
   across controller restart.
4. Remove optimistic controller/runtime fallback that infers healthy/configured from deployment availability alone.

Deployer acceptance gates:

1. Run projection shadow mode for at least one full day of normal stage cadence.
2. Require live parity between legacy route fields and the new projection payloads before any consumer flips.
3. Measure `torghut_quant_fast` p95 latency and `interactive_status` p95 latency separately; promotion is blocked if
   they are still effectively one shared bottleneck.
4. Flip Torghut to the projection-backed quant-health path before any deploy verification or handoff path starts
   requiring the new ids.

Rollout sequence:

1. Land tables and compiler writes in shadow mode.
2. Expose projection ids and latency-class admission ids on routes without enforcing them.
3. Move `torghut_quant_fast` to compiled truth first.
4. Move deploy verification and handoff launchers.
5. Keep `interactive_status` as the last consumer to stop compiling truth on request.

Rollback:

1. stop enforcing projection ids in Torghut, deploy verification, and handoff launchers;
2. keep projection writes running for observability and replay;
3. revert only the affected consumer class to legacy request-time computation;
4. preserve recovery-cell and receipt compilation so the underlying debt remains visible.

## Risks and open questions

- Jangar remains a single-replica `Recreate` deployment today; consumer projections reduce failure coupling, but they do
  not by themselves create multi-replica serving.
- Projection-schema drift can create a new compatibility problem if digests are not versioned deliberately.
- If the typed quant-health projection becomes too rich, it will repeat the same mistake as the current generic status
  route.

## Handoff to engineer and deployer

Engineer scope:

- implement the two additive tables and compiler;
- move watch and freeze recovery evidence off process-local truth paths;
- update `/ready`, quant-health, and deploy-verification code to consume projection ids;
- add the parity and restart regressions listed above.

Deployer scope:

- keep rollout shadow-only until the new ids are visible on routes;
- compare route parity and latency-class SLOs before enabling enforcement;
- treat any mismatch between `serving_fast`, `torghut_quant_fast`, and `interactive_status` as a hard stop;
- rollback consumer enforcement before rolling back projection writes.
