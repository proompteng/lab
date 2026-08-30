# 79. Jangar Control-Plane Proof Runway and Consumer-Gated Rollout

Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Status: Accepted for implementation planning
Scope: Jangar control-plane resilience, schedule materialization, image-platform rollout safety, database/data proof
freshness, and Torghut external-capital admission.

Companion Torghut contract:

- `docs/torghut/design-system/v6/83-torghut-profit-runway-consumer-and-hypothesis-capital-auction-2026-05-05.md`

Extends and consolidates:

- `72-jangar-materialized-run-proof-and-storage-backed-admission-contract-2026-05-05.md`
- `77-jangar-evidence-settlement-authority-and-data-proof-handoff-2026-05-05.md`
- `78-jangar-capital-warrant-issuer-and-route-independent-order-admission-2026-05-05.md`

## Decision

Jangar should build one release-scoped **ControlPlaneProofRunway** instead of adding another independent status field
for every failure class. The runway is a compact, materialized contract that binds release digest, image-platform
proof, schedule template proof, runtime-kit proof, workspace/storage proof, database/schema proof, route probes,
execution-trust clocks, and downstream consumer decisions into one object with action-class gates.

I am choosing this because the current system is serving but still contradicts itself. On this plan pass, Jangar
readiness returned `status=ok` with leader election healthy, and the control-plane status route reported healthy
database, rollout, and watch surfaces. The same status route reported `execution_trust=degraded` and
`dependency_quorum.decision=block` on `empirical_jobs_degraded`. The `agents` namespace had current running controller
pods and schedule jobs, but recent events also showed `ImagePullBackOff` from Jangar image digests with no platform
match on one node class, and manual schedule jobs appearing as unexpected CronJob children. Torghut schema checks were
current, but live submission still reported `allowed=true` through the simple lane while promotion eligibility was
zero, signal continuity was alerting, TCA evidence was last computed on 2026-04-02, and Jangar quant health returned an
empty reply for `account=paper&window=15m`.

The design decision is not "make readiness stricter." The decision is to keep serving and repair available while making
dispatch, rollout widening, and external capital consume one proof runway. A pod can be healthy and still not be a
dispatch authority. A database can be schema-current and still not carry fresh profit evidence. A Torghut route can be
live and still not be allowed to risk external capital.

The tradeoff is deliberate centralization. We will add one durable authority object and a small consumer API. That is
less operational risk than continuing to spread authority across readiness, raw status, route-specific health, and
consumer-local interpretation.

## Runtime Scope and Success Metrics

This plan is for:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarm: `jangar-control-plane`
- stage: `plan`
- channel: `general`

Success for the engineer and deployer stages means:

- every scheduled or manual Jangar stage launch cites a runway id before it creates a Job;
- every runway names its release digest, image digest, target architecture set, schedule template digest, runtime-kit
  digest, workspace/storage decision, database/schema proof, and route-probe proof;
- Jangar can return HTTP 200 for serving and repair while holding `dispatch`, `widen`, or `external_capital`;
- image-platform mismatches hold new dispatch for the affected node pool before pods enter `ImagePullBackOff`;
- Torghut consumes the runway before minting non-shadow order warrants;
- rollback can disable enforcement without deleting proof writes or losing negative evidence.

## Evidence Captured

All Kubernetes and database assessment was read-only.

### Cluster, Rollout, and Events

- Identity: `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` was unset, but `kubectl auth whoami` succeeded as the agents service account.
- `kubectl get pods -n jangar -o wide` showed the Jangar serving pod, Jangar DB, Redis, Bumba, Symphony, Open WebUI,
  and Alloy running.
- `kubectl get pods -n agents -o wide` showed controller pods running, active plan/discover/implement/verify jobs, and
  several Torghut/Jangar pods in `ImagePullBackOff`.
- Current failed pod count in `agents` was lower than the earlier NATS soak, but old failed Jobs remained and events
  still showed pull failures, backoff-limit failures, unexpected manual jobs under CronJobs, and missing/forgotten job
  ownership events.
- The notable current pull failure is platform-specific: the promoted Jangar image digest
  `0f631e583b7f0ff813b65f9ff7462071c0b54416eba53eb35ac6a13cf350ebb1` returned "no match for platform in manifest" on
  one node path while other pods using the same digest ran elsewhere.
- The agents service account cannot list Deployments or StatefulSets in `jangar` or `agents` and cannot exec into
  `jangar-db-1` or `torghut-db-1`. That is a useful constraint: deploy gates must be satisfiable through least-privilege
  proof surfaces, not privileged shell access.
- `kubectl get pods -n torghut -o wide` showed the live service, sim service, Postgres, ClickHouse, Keeper, TA workers,
  options workers, websocket forwarders, and exporters running; one options TA pod was still starting.
- Torghut events showed repeated migration and backfill jobs completing, rollout churn, and short-lived readiness
  warnings. The platform is live, but proof freshness remains mixed.

### Source Architecture and High-Risk Modules

Jangar already has most ingredients for the runway, but they are not sealed together.

- `services/jangar/src/server/control-plane-status.ts` composes database status, execution trust, rollout health, watch
  reliability, runtime admission, workflow reliability, and dependency quorum. It is the right aggregator, but today it
  returns raw facts rather than a per-release action authority.
- `services/jangar/src/server/control-plane-execution-trust.ts` turns stale stages, pending requirements, freezes, and
  recent failures into degraded or blocked windows. It should become one runway input, not the whole authority.
- `services/jangar/src/server/supporting-primitives-controller.ts` creates schedule template ConfigMaps, CronJobs,
  workspace PVCs, and watches schedule and PVC events. It now resolves schedule runtime admission traces, but schedule
  materialization is still inferred from later pod behavior.
- The same controller uses `persistentvolumeclaim` for workspace reads/deletes/watches, while
  `services/jangar/src/server/primitives-kube.ts` currently defines built-in targets for ConfigMaps, CronJobs,
  Deployments, Events, Jobs, Leases, Namespaces, Pods, Secrets, and Services but not PersistentVolumeClaims. That split
  is a direct reliability risk for workspace status and watch parity.
- `services/torghut/app/main.py::_build_live_submission_gate_payload` still allows the simple lane from local toggles
  alone when mode is live, while `services/torghut/app/trading/submission_council.py::build_live_submission_gate_payload`
  is the proof-aware path that evaluates dependency quorum, empirical jobs, quant health, promotion eligibility, TCA,
  and certificate evidence.
- Jangar quant health has focused tests for lag, empty latest stores, stage degradation, and account/window scoping.
  The missing test is not a unit test of the route. The missing test is consumer-grade behavior: an empty reply or empty
  latest store must hold Torghut external capital while Jangar keeps serving.

### Database, Data Quality, Freshness, and Consistency

- Direct CNPG SQL from this worker was blocked by RBAC: `pods/exec` is forbidden in both `jangar` and `torghut`.
- Jangar control-plane status reported `database.configured=true`, `database.connected=true`, `database.status=healthy`,
  `latency_ms=3`, `registered_count=25`, `applied_count=25`, and latest migration
  `20260418_embedding_dimension_4096`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing or unexpected heads, and
  `schema_graph_lineage_ready=true`. It still reports parent-fork warnings for historical branches at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/trading/status` reported `mode=live`, `execution_lane=simple`, `kill_switch_enabled=false`, and
  `live_submission_gate.allowed=true`.
- The same payload reported `promotion_eligible_total=0`, `dependency_quorum_decision=informational_only`, no empirical
  jobs readiness in the simple lane, a market-session signal-continuity alert on `cursor_tail_stable`, and TCA evidence
  last computed on `2026-04-02T20:59:45.136640Z` with `avg_abs_slippage_bps=568.6138848199565249`.
- Jangar market-context health for `NVDA` returned `overallState=degraded`: technicals and regime were fresh, but
  fundamentals and news were stale by multi-week windows.
- `bun run --filter memories retrieve-memory` still failed with `ECONNRESET` against
  `http://jangar.jangar.svc.cluster.local/api/memories`. This is a route proof failure even if the service is otherwise
  available.

## Problem

The control plane now has many good local proofs, but no release-scoped runway that answers the operational question:
"For this digest and this consumer, which actions are safe right now?"

The absence creates five concrete failure modes:

1. a schedule runner can be admitted by high-level status and still fail after pod creation because the image platform,
   ConfigMap, service account, or storage contract is not actually runnable;
2. old failed Jobs and current image pull errors can coexist with healthy rollout summaries, which makes deployment
   health too weak as a widening signal;
3. least-privilege workers cannot prove deploy safety if the gate requires listing Deployments or execing into DB pods;
4. Torghut can report a live simple-lane gate while every economic proof says external capital should be held;
5. route-specific failures such as memories `ECONNRESET` or quant health empty replies are not first-class blockers for
   the action classes that require those routes.

The next six months should not add more independent "health" fields. It should collapse health into one proof runway
that every launch, deploy, and capital consumer can cite.

## Alternatives Considered

### Option A: Patch the Current Defects Only

Fix PersistentVolumeClaim resource support, add image multi-arch validation in CI, and make the Torghut simple lane call
the proof-aware submission council.

Pros:

- fastest path to remove known sharp edges;
- small PRs with obvious tests;
- lowers current event noise.

Cons:

- does not give deployers one action authority;
- does not preserve a per-release failure record;
- leaves consumers free to interpret readiness, route health, and database status differently;
- does not make Torghut capital allocation depend on the same proof as Jangar rollout.

Decision: required implementation steps, but not the architecture.

### Option B: Freeze All Schedules and Capital on Any Degraded Signal

Any degraded execution trust, image pull, stale route, or empirical proof would freeze all Jangar schedules and Torghut
live capital.

Pros:

- conservative incident posture;
- easy to explain during an outage;
- prevents repeated bad pods quickly.

Cons:

- over-blocks repair, observe, shadow, and verify work;
- treats platform image drift and market data staleness as the same kind of failure;
- encourages manual bypasses because the control is too coarse;
- does not help least-privilege deploy verification.

Decision: keep as an emergency brake, not the default design.

### Option C: ControlPlaneProofRunway

Jangar materializes a release-scoped runway with action-class gates. Schedule launch, rollout widening, and Torghut
external-capital admission all consume the same runway, but each action class has separate proof requirements and
expiry.

Pros:

- one authority for mixed evidence, not multiple route-local interpretations;
- supports least-privilege deployers because proof is queryable without privileged Kubernetes reads;
- allows serving and repair while holding unsafe dispatch, widen, or capital actions;
- captures image-platform, storage, route, and data proof failures before they become repeated pods;
- gives Torghut one platform digest to bind into order warrants and capital auctions.

Cons:

- adds one durable proof object and route contract;
- requires shadow-mode comparison before enforcement;
- requires careful expiry semantics so stale proof cannot clear live capital.

Decision: select Option C.

## Chosen Architecture

### ControlPlaneProofRunway

Create a Jangar-produced object with these fields:

- `runway_id`
- `namespace`
- `swarm`
- `stage`
- `release_digest`
- `image_ref`
- `image_digest`
- `image_platforms`
- `observed_node_architectures`
- `schedule_template_digest`
- `target_manifest_digest`
- `runtime_kit_digest`
- `runtime_admission_passport_id`
- `workspace_storage_decision`
- `database_schema_digest`
- `database_route_proof`
- `execution_trust_digest`
- `rollout_event_window_digest`
- `watch_reliability_digest`
- `route_probe_digest`
- `consumer_proof_digests`
- `observed_at`
- `fresh_until`
- `allowed_action_classes`
- `negative_evidence_refs`
- `repair_hints`
- `enforcement_mode`: `shadow`, `enforce`, or `disabled`

Action classes are:

- `serve`
- `observe`
- `repair`
- `verify`
- `dispatch`
- `widen`
- `external_capital`

### Producer Rules

Jangar may allow `dispatch` only when:

- the target manifest resolves;
- the schedule ConfigMap has been written and read back by name;
- the service account is resolved for the target namespace;
- the image digest has a manifest entry for every schedulable node architecture in the runway scope;
- runtime-kit admission allows the stage;
- required workspace storage is present and safe for the declared concurrency class.

Jangar may allow `widen` only when:

- `dispatch` is allowed;
- rollout and watch windows are healthy;
- no current image-pull, mount, or probe error is inside the configured event window for the release digest;
- the prior runway settled without unresolved negative evidence.

Jangar may allow `external_capital` only when:

- `widen` is allowed or explicitly waived by a scoped manual override;
- database schema and route probes are fresh;
- Torghut consumer proof says the target account/window/hypothesis is promotion eligible;
- quant latest store and market-context domains required by the hypothesis are fresh;
- TCA and empirical proof are inside the configured budget.

### Consumer Contract

Consumers must treat the runway as an authority, not a dashboard:

- missing runway means hold for `dispatch`, `widen`, and `external_capital`;
- expired runway means hold for all non-repair action classes;
- wrong release digest, account, window, or stage means hold;
- a newer hold invalidates older allows for the same scope;
- `serve`, `observe`, and `repair` remain available unless their own proof class is blocked.

### Persistence and API

Add a small materialized store and route:

- `control_plane_proof_runways` table or equivalent Kysely migration;
- `GET /api/agents/control-plane/proof-runway?namespace=&swarm=&stage=&release_digest=`;
- compact runway projection inside `/api/agents/control-plane/status`;
- compact serving-safe projection inside `/ready` without making readiness fail for non-serving holds;
- event emission for runway changes so NATS/Jangar can show why a gate changed without dumping logs.

## Engineer Scope

Implement in this order:

1. Add PersistentVolumeClaim built-in support to `primitives-kube` and regression tests for get/list/delete/watch parity.
2. Add image-platform inspection for the configured Jangar runner/control-plane image digests and fail `dispatch` in
   shadow when a schedulable node architecture is missing.
3. Add the pure runway builder and tests for `serve`, `repair`, `dispatch`, `widen`, and `external_capital` decisions.
4. Add runway persistence or a bounded materialized cache with digest, expiry, and negative evidence.
5. Add the runway route and compact status projection.
6. Wire schedule reconciliation to record a shadow runway before Job/CronJob creation, then gate creation when
   enforcement is enabled.
7. Update Torghut to consume the runway digest in its profit and order-admission contract.

## Validation Gates

- Unit test: PVC resource aliases resolve for `persistentvolumeclaim` and `persistentvolumeclaims`.
- Unit test: schedule materialization returns `dispatch` hold when the schedule ConfigMap cannot be read back.
- Unit test: image platform proof holds `dispatch` for an image digest missing one observed node architecture.
- Unit test: HTTP 200 `/ready` can coexist with `dispatch=false`, `widen=false`, and `external_capital=false`.
- Integration test: a fake Torghut consumer proof with empty latest metrics holds `external_capital` while allowing
  `repair`.
- Contract test: a stale database route proof blocks `external_capital` but not `serve`.
- Deployer smoke: query proof runway after rollout and verify `serve=true`, `repair=true`, and the expected hold or
  allow state for `dispatch`, `widen`, and `external_capital`.

## Rollout Plan

1. Ship runway builder in shadow mode and emit proof objects without gating.
2. Compare shadow decisions against current schedule outcomes, image-pull events, and Torghut submission gates for at
   least two market sessions.
3. Enforce `dispatch` for new Jangar control-plane schedules only.
4. Enforce `widen` for Jangar release promotion after deployer smoke passes.
5. Let Torghut consume the runway in shadow for order warrants.
6. Enforce `external_capital` only after Torghut proves zero false-positive live submissions in shadow.

## Rollback Plan

- Set runway enforcement to `disabled` while preserving proof writes and route projections.
- If the status route regresses, remove the compact projection from `/ready` first and keep the dedicated route.
- If persistence regresses, fall back to an in-memory hold runway with `database_route_proof=unavailable`.
- If Torghut consumption regresses, keep broker warrants in shadow and continue using the proof-aware submission council
  as the live block.

## Risks and Open Questions

- Image manifest inspection must be fast and cached, or schedule reconciliation will become registry-bound.
- The first enforcement phase must avoid blocking repair jobs that need the same image proof to fix the image proof.
- Torghut account/window scoping must be exact; `paper/15m` proof cannot clear a live account.
- Manual overrides need expiry, actor, reason, max notional, and scope. An override without those fields is not a
  runway; it is an audit gap.

## Handoff

Engineer acceptance gate: a failing image-platform proof, missing ConfigMap proof, stale execution-trust proof, and
empty Torghut quant proof each produce a deterministic runway hold with the smallest repair hint.

Deployer acceptance gate: a rollout is not widened from pod readiness alone. It is widened only after the runway route
shows the expected release digest, fresh proof clocks, no active image/storage/event negative evidence, and the action
class being widened is allowed.
