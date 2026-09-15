# 71. Jangar Least-Privilege Evidence Projection Broker and Deploy Gate Contract (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Victor Chen (Jangar Engineering)
Scope: Jangar control-plane resilience, read-only deploy verification, database/data evidence projection, and downstream
Torghut promotion authority.

Companion doc:

- `docs/torghut/design-system/v6/76-torghut-profit-projection-consumer-and-route-parity-gates-2026-05-05.md`

Extends:

- `68-jangar-evidence-clock-arbiter-and-rollout-veto-contract-2026-05-05.md`
- `70-jangar-evidence-epoch-admission-and-rollout-quarantine-2026-05-05.md`
- `70-jangar-promotion-authority-ledger-and-rollout-rehearsal-cells-2026-05-05.md`

## Executive Summary

The decision is to add a least-privilege Evidence Projection Broker to Jangar. The broker is the read model that turns
privileged controller observation, route health, database schema checks, runtime admission, schedule state, and
downstream Torghut evidence into bounded receipts that constrained workers and deploy gates can consume.

I am choosing this after the current discover pass because the evidence-clock direction is already merged, but the
system still has an observation authority gap. The worker running this assessment can list pods, events, jobs, CronJobs,
services, and Jangar CRDs. It cannot read Argo CD `Application` objects, cannot list `apps` workloads, and cannot exec
into CNPG database pods. That is the right security shape for a generic worker, but it means architecture and deploy
automation cannot depend on broad cluster or database shell access. The control plane needs to project enough evidence
for safety without handing every worker the keys to the rollout machinery.

The tradeoff is that Jangar owns one more durable read path. I am accepting that cost because the alternative is worse:
either over-privilege every deployer or let every stage infer rollout and data authority from partial route-time checks.
For the next six months, the reliable path is a single projection broker with strict producers, scoped consumers, and
rollout gates that fail closed when the projection is stale, missing, or contradictory.

## Objective and Success Metrics

Runtime inputs for this architecture lane:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- swarm: `jangar-control-plane`
- stage: `discover`
- channel: `general`

This design succeeds when:

1. deploy verification can prove Jangar and Torghut promotion readiness using read-only projected receipts, without
   requiring Argo CD read permissions, `apps` workload list permissions, or database `pods/exec`;
2. `/ready`, `/api/agents/control-plane/status`, deploy checks, and Torghut promotion checks cite the same projection
   snapshot id for their shared control-plane decision;
3. every projection records producer, observed time, freshness, required RBAC class, source digest, decision, and
   reason codes;
4. stale execution trust, blocked dependency quorum, missing runtime kit components, stale market context, and route
   timeouts become typed deploy-blocking reasons instead of operator interpretation;
5. worker RBAC stays narrow while Jangar-owned controllers retain the authority to observe the privileged objects they
   already reconcile;
6. engineer and deployer stages have concrete acceptance gates for implementation, rollout, and rollback.

## Evidence Snapshot

All cluster and database checks in this run were read-only.

### NATS Shared State

The NATS context soak returned four relevant teammate updates. The latest shared state was that previous architecture
passes had selected an evidence-clock arbiter because live evidence showed stale Jangar discover, plan, implement, and
verify stages, pending execution-trust requirements, scheduled swarm CronJob failures, Torghut non-promotable
hypotheses, and market-context freshness problems. PRs `#5391` and `#5400` are already merged on this branch lineage, so
this document extends that direction instead of replacing it.

### Cluster, Rollout, and Event Evidence

The assessment service account is `system:serviceaccount:agents:agents-sa`.

Observed access:

- `kubectl auth can-i --list -n jangar` shows read access to pods, pod logs, services, jobs, CronJobs, events, PVCs,
  configmaps, Jangar CRDs, and several cluster discovery resources.
- The same access does not include Argo CD `Application` reads in `argocd` and does not include `apps/deployments`,
  `apps/statefulsets`, or `apps/daemonsets` list permissions in `jangar`, `torghut`, or `agents`.
- `kubectl cnpg psql -n jangar jangar-db -- -c 'select now();'` and the Torghut equivalent fail because `pods/exec`
  is forbidden.

Observed runtime state:

- `kubectl get pods -n jangar -o wide` shows Jangar, Jangar DB, Redis, OpenWebUI, Bumba, Symphony, and Symphony-Jangar
  pods running.
- `kubectl get pods -n torghut -o wide` shows Torghut service pods, Torghut DB, ClickHouse, Keeper, TA task managers,
  websocket forwarder, guardrail exporters, and options pods running. `torghut-ws-options` restarted once inside the
  last twenty minutes.
- `kubectl get pods -n agents -o wide` shows current `agents` and `agents-controllers` pods ready, but also many older
  Jangar and Torghut swarm pods in `Error` from the last day and older template runs.
- `kubectl get events -n jangar --sort-by=.lastTimestamp` shows recent readiness probe failures during Bumba,
  Symphony, Redis, and Jangar DB transitions, followed by running pods.
- `kubectl get events -n torghut --sort-by=.lastTimestamp` shows Torghut and Torghut-sim revisions becoming ready after
  readiness and image-pull warnings, plus repeated migration and backfill jobs completing.
- `kubectl get events -n agents --sort-by=.lastTimestamp` shows current schedule-created jobs and earlier
  `BackoffLimitExceeded` for scheduled verify/plan jobs.

Interpretation: serving is up, but a constrained worker cannot independently prove Argo sync, deployment rollout, or
database contents. Jangar must publish the proof it wants deployers and downstream consumers to use.

### Source Architecture and Test-Gap Evidence

Relevant Jangar source surfaces:

- `services/jangar/src/server/control-plane-status.ts`
  - already composes controller health, heartbeat authority, database status, watch reliability, runtime admission,
    workflow reliability, empirical services, execution trust, dependency quorum, and rollout health;
  - this is the right nucleus for projection, but the current shape is still route-time assembly rather than a durable
    projection with producer and consumer contracts.
- `services/jangar/src/server/control-plane-runtime-admission.ts`
  - checks runtime components such as `codex-nats-publish`, `codex-nats-soak`, `nats`, the worktree, and `NATS_URL`;
  - current live `/ready` reports the collaboration runtime kit as blocked on
    `runtime_kit_component_missing:nats_cli`.
- `services/jangar/src/routes/ready.tsx`
  - correctly keeps serving readiness narrower than promotion authority;
  - it already exposes execution-trust and runtime-kit detail, but deployers still need a single projection snapshot id
    shared with control-plane status and downstream Torghut checks.
- `services/jangar/src/server/control-plane-db-status.ts`
  - produces the migration consistency data needed for a database projection without direct worker database access.
- `services/jangar/src/server/control-plane-workflows.ts`
  - produces dependency quorum and workflow reliability summaries, currently including `empirical_jobs_degraded` as a
    global block.

Test gaps exposed by this pass:

- no deploy-gate contract test proving a constrained worker can validate promotion authority without Argo, `apps`, or
  DB exec permissions;
- no status parity test requiring `/ready`, control-plane status, and deploy verification to share one projection id;
- no projection-retention test proving stale route-time errors are preserved long enough for deployer rollback
  analysis;
- no Torghut consumer contract test that treats empty reply, timeout, and stale market-context projection as distinct
  capital decisions.

### Database, Data, Freshness, and Consistency Evidence

Jangar status:

- `GET /ready` returns `status="ok"`.
- Leader election is enabled and the current Jangar pod is leader.
- `execution_trust.status="degraded"` with five pending Jangar control-plane requirements and stale discover, plan,
  implement, and verify stages for Jangar and Torghut.
- `memory_provider.status="healthy"` and points at an OpenAI-compatible self-hosted embedding endpoint.
- Runtime admission blocks collaboration consumers on `runtime_kit_component_missing:nats_cli`.
- `GET /api/agents/control-plane/status?namespace=agents` reports database `connected=true`, latency `3ms`, migration
  table `kysely_migration`, registered migrations `25`, applied migrations `25`, and latest migration
  `20260418_embedding_dimension_4096`.
- The same status route reports `dependency_quorum.decision="block"` with reason `empirical_jobs_degraded` while
  rollout health is `healthy`.
- Direct memory retrieval through the repo helper failed twice with `ECONNRESET` against
  `http://jangar.jangar.svc.cluster.local/api/memories`, which contradicts the coarse memory-provider healthy signal
  enough to warrant an explicit memory projection.

Torghut status:

- `GET /healthz` returns `{"status":"ok","service":"torghut"}`.
- `GET /db-check` returns `ok=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, `schema_graph_lineage_ready=true`, no duplicate revisions, and no orphan
  parents.
- The same DB check still reports parent-fork warnings around
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `GET /readyz`, `GET /trading/status`, and the Jangar quant-health route timed out or returned an empty reply during
  this run.
- `GET /api/torghut/market-context/health?symbol=NVDA` through Jangar returns `overallState="degraded"`,
  bundle freshness around `48740s`, stale technicals, fundamentals, news, and regime domains, with provider fetches
  recently succeeding.

Interpretation: schema is not the primary failure. Freshness, route parity, and least-privilege proof are the failure.

## Problem Statement

Jangar now has the concepts needed for evidence clocks and admission passports, but deployers and downstream consumers
still lack one least-privilege read model that answers a specific question: "Can this stage, rollout, or capital move
proceed, and what exact evidence made that decision?"

The current system leaves five failure modes open:

1. a constrained worker cannot prove Argo sync or deployment rollout without broader RBAC;
2. direct database reads are unavailable to the worker, so database claims must be trusted route by route;
3. `/ready` can be serving `ok` while execution trust is degraded and dependency quorum is blocked;
4. memory and Torghut routes can fail at request time while coarser provider/schema checks remain healthy;
5. Torghut and deploy automation still need to compose multiple Jangar and Torghut routes, each with different
   freshness and timeout semantics.

The architecture needs a brokered projection, not broader worker authority.

## Alternatives Considered

### Option A: Broaden Worker RBAC

Give architecture and deploy workers read access to Argo CD Applications, `apps` workloads, and database exec for CNPG
checks.

Pros:

- fastest path to richer live diagnostics;
- reuses familiar Kubernetes and database commands;
- minimizes new Jangar code.

Cons:

- violates least privilege for generic agent-runner pods;
- makes every worker a rollout observer with accidental blast radius;
- still produces ad hoc evidence that downstream Torghut cannot safely consume;
- does not solve route parity or stale projection retention.

Decision: rejected.

### Option B: Keep Route-Time Aggregation and Tighten Timeouts

Keep `/ready`, `/api/agents/control-plane/status`, Torghut `/readyz`, Torghut `/trading/status`, and Jangar quant-health
as independent checks. Add stricter timeouts and clearer errors.

Pros:

- small implementation surface;
- improves operator messages quickly;
- preserves current source boundaries.

Cons:

- does not give deployers one snapshot id;
- still lets each route recompute truth at different times;
- treats empty reply, timeout, stale data, and blocked dependency quorum as consumer-side interpretation;
- does not let restricted workers prove privileged controller state.

Decision: rejected as the six-month answer.

### Option C: Add an Evidence Projection Broker

Controllers and route producers emit typed observations into a Jangar-owned projection. The broker seals a snapshot per
scope and exposes it to constrained consumers through a narrow API and, where useful, CR status fields. Deploy and
Torghut checks consume the projection snapshot instead of recomputing authority.

Pros:

- keeps worker RBAC narrow;
- gives deploy gates and Torghut one shared evidence id;
- records freshness and reason codes for rollback analysis;
- builds directly on the merged evidence-clock and admission-passport direction;
- creates a future-compatible surface for Argo, deployment, database, memory, and Torghut data evidence.

Cons:

- adds persistence and retention work;
- requires producers to be disciplined about freshness and reason-code vocabularies;
- can become another summary layer if deploy gates are not forced to consume it.

Decision: selected.

## Decision

Build the Evidence Projection Broker as the least-privilege read authority for Jangar-controlled promotion decisions.

The broker will:

1. collect typed observations from controller heartbeats, Kubernetes watches, rollout checks, Argo sync checks,
   database schema checks, runtime admission, schedule outcomes, memory retrieval, and downstream Torghut evidence;
2. seal a projection snapshot with a stable id, producer revisions, observed times, freshness windows, decisions, and
   reason codes;
3. expose the snapshot through `/api/agents/control-plane/status`, `/ready`, deploy verification, and a dedicated
   projection route;
4. allow serving readiness to remain available while promotion and rollout gates fail closed on stale or missing
   projection classes;
5. give Torghut a single Jangar projection id to cite in capital decisions.

## Target Model

Add an additive projection store:

```text
control_plane_projection_snapshots
  projection_snapshot_id
  scope_kind                 # namespace, swarm, rollout, consumer, global
  scope_namespace
  scope_name
  decision                   # allow, degrade, hold, block, unknown
  reason_codes
  producer_revision
  observed_at
  fresh_until
  source_digest
  projection_digest
  created_at

control_plane_projection_observations
  observation_id
  projection_snapshot_id
  observation_class          # argo, apps_workload, pod, event, db_schema, memory, runtime, schedule, torghut
  subject_ref
  required_for               # serving, dispatch, deploy_widen, rollback, torghut_capital, diagnostic
  required_rbac_class        # controller, worker_readonly, route_projection
  decision
  reason_codes
  observed_at
  fresh_until
  payload_digest
  payload_ref
```

The first projection classes are:

- `serving`: Jangar HTTP readiness, leader election, serving runtime kit.
- `controller_authority`: heartbeat freshness, controller rollout, watch stream health.
- `dispatch`: schedule-runner parser result, runtime kit, execution trust, stage freshness.
- `deploy_widen`: Argo sync, workload rollout, pod readiness, recent events, migration status.
- `database_schema`: Kysely and Alembic head/lineage summaries, not raw DB shell output.
- `memory`: memory provider config plus a bounded retrieval/write probe result.
- `torghut_profit`: market-context freshness, quant-health route status, Torghut DB check, live submission gate parity.

Dedicated route shape:

```text
GET /api/agents/control-plane/evidence-projections?namespace=agents&scope=jangar-control-plane

{
  "projection_snapshot_id": "...",
  "decision": "block",
  "reason_codes": ["execution_trust_degraded", "empirical_jobs_degraded"],
  "observed_at": "...",
  "fresh_until": "...",
  "observations": [
    {
      "observation_class": "database_schema",
      "subject_ref": "jangar:kysely",
      "decision": "allow",
      "reason_codes": [],
      "payload_digest": "..."
    }
  ]
}
```

The route is not a raw object dump. It is a signed-off projection with bounded payload references and stable decision
vocabulary.

## Implementation Scope

Engineer stage should implement this in four slices.

1. Projection skeleton and parity.
   - Add snapshot and observation types.
   - Emit an in-memory projection from the existing `control-plane-status` inputs.
   - Include `projection_snapshot_id` in `/ready` and `/api/agents/control-plane/status`.
   - Add a parity test that both routes cite the same active projection id for one request cycle.

2. Least-privilege deploy evidence.
   - Add projection classes for Argo sync and `apps` rollout state from the privileged controller path, not worker
     shell access.
   - Add database schema projections from existing Jangar and Torghut status routes.
   - Record forbidden direct-check evidence as `worker_rbac_forbidden` diagnostics, not as rollout truth.

3. Memory and Torghut freshness projections.
   - Add bounded memory read/write probe receipts with timeout and error class.
   - Add Torghut route projections for `/healthz`, `/db-check`, `/readyz`, `/trading/status`, Jangar quant-health, and
     market-context health.
   - Distinguish `timeout`, `empty_reply`, `schema_ok`, `freshness_stale`, and `dependency_block`.

4. Enforcement consumers.
   - Update deploy verification to require a fresh `deploy_widen` projection.
   - Update schedule dispatch to require a fresh `dispatch` projection.
   - Update Torghut promotion checks to require a fresh `torghut_profit` projection.
   - Keep serving readiness decoupled from promotion enforcement.

Non-goals:

- granting generic workers broad Argo, `apps`, or database exec access;
- deleting existing evidence-clock or admission-passport concepts;
- making `/ready` a global safety gate;
- storing large raw logs in projection rows.

## Validation Gates

Engineer local gates:

- `bun --cwd services/jangar run test -- src/server/__tests__/control-plane-status.test.ts`
- `bun --cwd services/jangar run test -- src/routes/ready.test.ts`
- add a new projection test proving `/ready` and status share `projection_snapshot_id`;
- add a deploy-gate test proving forbidden worker RBAC becomes diagnostic evidence while controller-produced rollout
  observations remain authoritative;
- `bun --cwd services/jangar run tsc`
- `bun --cwd services/jangar run lint`

Cluster/deployer gates:

- `GET /api/agents/control-plane/evidence-projections?namespace=agents&scope=jangar-control-plane` returns a fresh
  snapshot id and typed observations.
- `GET /ready` includes the same projection snapshot id for serving-class evidence.
- `GET /api/agents/control-plane/status?namespace=agents` includes the same projection snapshot id for promotion-class
  evidence.
- A constrained worker can run deploy verification without `apps` list, Argo `Application` get, or `pods/exec`.
- A stale Torghut market-context projection blocks only Torghut capital promotion, not Jangar serving.
- A memory retrieval timeout or reset becomes a `memory_probe_failed` observation with its own freshness window.

## Rollout Plan

1. Ship projection in shadow mode with no enforcement.
2. Run one full Jangar discover/plan/implement/verify cadence and compare projection decisions against current status.
3. Enable deploy verification to require a fresh projection but only warn on missing Argo/deployment classes.
4. Enable deploy widening block on stale `deploy_widen`.
5. Enable dispatch block on stale `dispatch`.
6. Enable Torghut non-observe capital block on stale `torghut_profit`.

Feature flags:

- `JANGAR_EVIDENCE_PROJECTIONS_ENABLED=true`
- `JANGAR_EVIDENCE_PROJECTIONS_ENFORCEMENT=shadow|deploy_widen|dispatch|capital`
- `JANGAR_EVIDENCE_PROJECTION_RETENTION_DAYS=14`

## Rollback Plan

Rollback must preserve historical evidence.

- Set `JANGAR_EVIDENCE_PROJECTIONS_ENFORCEMENT=shadow` to disable behavioral blocks.
- If projection emission is causing route instability, set `JANGAR_EVIDENCE_PROJECTIONS_ENABLED=false`.
- Do not delete projection tables during rollback.
- Keep any Argo/deployment/database observation producers disabled independently if one producer is noisy.
- After rollback, verify `/ready` still returns serving status and `/api/agents/control-plane/status` still reports
  database and execution-trust details.

## Risks and Open Questions

- Projection freshness can hide per-route details if payload references are too thin. The first implementation must
  include enough reason codes and payload digests to debug without raw log blobs.
- Controller-produced Argo and deployment observations need careful RBAC scoping. The producer should be privileged only
  where Jangar already owns reconciliation.
- Memory probing must avoid writing noisy audit data. A read-only probe is enough for most deploy gates; a write probe
  should use a tiny TTL-scoped test record only if the memory service supports it safely.
- Torghut route timeouts can be market-session sensitive. The projection must record timeout class and not collapse it
  into generic `down`.
- The broker should not become a second, conflicting status system. `/ready`, status, deploy verification, and Torghut
  must cite its snapshot id.

## Handoff to Engineer

Implement the projection skeleton and route parity first. Do not start enforcement until the projection id appears in
both `/ready` and `/api/agents/control-plane/status` and a constrained-worker deploy-gate test proves no broad RBAC is
required.

Acceptance gates:

- projection route exists and returns a bounded snapshot;
- `/ready` and status share `projection_snapshot_id`;
- database schema projection reports `25/25` Jangar migrations without DB exec;
- memory probe failures are typed separately from memory-provider configuration health;
- Torghut market-context degradation is represented as `torghut_profit` evidence, not as Jangar serving failure.

## Handoff to Deployer

Deploy in shadow mode. Do not enable deploy widening enforcement until one full scheduled cadence has fresh projections
for Jangar discover, plan, implement, and verify, and until deploy verification succeeds using only constrained-worker
permissions.

Rollback gate:

- if projection emission destabilizes `/ready` or status, disable projection emission;
- if enforcement blocks a rollout because a producer is missing rather than stale, return enforcement to `shadow` and
  keep the producer defect as a repair-cell item;
- if Torghut capital promotion is blocked by a stale projection, keep Jangar serving available and move Torghut to
  observe/shadow via the companion Torghut rollback path.
