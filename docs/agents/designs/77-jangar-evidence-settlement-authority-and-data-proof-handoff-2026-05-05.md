# 77. Jangar Evidence Settlement Authority and Data-Proof Handoff (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-discover`

Companion Torghut contract:

- `docs/torghut/design-system/v6/81-torghut-capital-proof-reconciliation-and-jangar-settlement-consumer-2026-05-05.md`

Extends:

- `docs/agents/designs/76-jangar-rollout-settlement-fuses-and-proof-reclocking-2026-05-05.md`
- `docs/agents/designs/68-jangar-evidence-clock-arbiter-and-rollout-veto-contract-2026-05-05.md`
- `docs/torghut/design-system/v6/80-torghut-capital-proof-reclocking-and-live-submission-fuses-2026-05-05.md`

## Decision

Jangar should promote the rollout-settlement receipt into an **Evidence Settlement Authority** with explicit action
classes and data-proof adapters. The key decision is that no scheduler, deployer, or Torghut capital consumer should
interpret raw readiness, raw rollout availability, raw database migration parity, or raw trading liveness on its own.
They should consume one settled authority response that says which actions are allowed, which clocks were used, which
data proof was accepted, and what must refresh next.

This is a stricter step than the existing evidence-clock arbiter. The arbiter makes clocks comparable. The settlement
authority makes the comparison operational: `serve`, `observe`, `repair`, `verify`, `dispatch`, `widen`, and
`external_capital` become separate decisions with separate proof requirements.

I am choosing this because the May 5 live evidence still shows contradictory green surfaces:

- Jangar `/ready` returned HTTP 200 and `status="ok"`;
- `/api/agents/control-plane/status?namespace=agents` reported the Jangar database healthy with `25/25` Kysely
  migrations applied, but `execution_trust.status="degraded"`;
- the same status payload held swarm plan/implement/verify passports because Jangar has five pending requirements and
  stale discover, plan, implement, and verify stages;
- `kubectl get pods -n agents` showed active controller pods, but events also showed readiness probe timeouts and
  scheduled Jangar/Torghut runs in `ImagePullBackOff`;
- `kubectl cnpg psql` was not available from this runtime because the `agents` service account cannot `pods/exec` into
  `jangar-db-1` or `torghut-db-1`;
- Torghut `/trading/status` was serving and said the live submission gate was allowed, while alpha readiness had
  `promotion_eligible_total=0`, `rollback_required_total=3`, and `dependency_quorum.decision="block"`.

The tradeoff is that this adds one more persisted/materialized contract. I am accepting that cost because the present
system already has enough signals to avoid unsafe action. What it lacks is one authority that makes consumers obey the
same interpretation.

## Runtime Scope

Inputs assessed in this discover pass:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- Jangar namespace: `jangar`
- agent runtime namespace: `agents`
- Torghut namespace: `torghut`
- NATS channel: `general`

Assessment rules:

- Kubernetes and database checks were read-only.
- No cluster resources were mutated.
- No database records were mutated.
- When direct database shell access was blocked by RBAC, application-minted database proofs and migration logs were
  treated as the allowed evidence surface.

## Evidence Captured

### Cluster, Rollout, and Events

Jangar is serving, but rollout-derived availability is not enough for promotion authority.

- `kubectl get pods -n jangar -o wide` showed Bumba, Jangar Alloy, Jangar Postgres, Redis, OpenWebUI, and Symphony
  running. The primary Jangar pod was in init during one sample and then served `/ready` successfully through the
  service.
- `curl http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200 with `leaderElection.isLeader=true`.
- `kubectl get deploy,statefulset,daemonset,cronjob,job -n jangar` was partially forbidden for apps resources from the
  `agents` service account. This matters: deploy gates cannot depend on privileged deployment reads from every runner.
- `kubectl get events -n jangar --sort-by=.lastTimestamp` showed recent scheduling pressure, readiness probe failures,
  CSI mount failures, Redis probe timeouts, and sealed-secret unseal failures for Discord and ClickHouse credentials.
- `kubectl get pods -n agents -o wide` showed Jangar and Torghut scheduled runs alongside controller pods. Older
  implement/discover pods were still in `ImagePullBackOff` for image digests with no matching platform manifest.
- `kubectl get events -n agents --sort-by=.lastTimestamp` showed `ImagePullBackOff`, `ErrImagePull`, controller
  readiness timeouts, completed schedule CronJobs, and new discover/verify jobs.
- `kubectl get pods -n torghut -o wide` showed Postgres and ClickHouse running, migrations completed, but `torghut-ws`
  was `0/1 Ready` with repeated restarts.
- `kubectl get events -n torghut --sort-by=.lastTimestamp` showed repeated scheduling pressure, Flink job exceptions,
  PDB ambiguity for ClickHouse pods, and Torghut websocket readiness/liveness failures.

Interpretation: the cluster can serve key routes, but action safety is mixed. The authority must include event-window
and action-class decisions, not just route liveness.

### Source Architecture and Test Gaps

The source already contains the raw evidence builders, but they do not yet produce one settled action authority.

High-risk modules:

- `services/jangar/src/server/control-plane-status.ts` is the main aggregator for controller state, database status,
  watch reliability, workflow reliability, rollout health, dependency quorum, runtime kits, and admission passports.
- `services/jangar/src/server/control-plane-execution-trust.ts` evaluates pending requirements, stage freshness, and
  freeze state.
- `services/jangar/src/server/control-plane-db-status.ts` validates Jangar database connectivity and migration
  consistency.
- `services/jangar/src/server/control-plane-watch-reliability.ts` records watch errors and restarts in process memory.
- `services/jangar/src/server/control-plane-rollout-health.ts` summarizes configured deployment rollout state.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule-runner command generation and
  supporting primitive watches, including workspace PVC lifecycle.
- `services/jangar/src/server/primitives-kube.ts` is the Kubernetes resource resolver boundary used by primitive APIs.

Observed coverage is broad: `services/jangar/src/server/__tests__` currently has 119 test files. The missing coverage
is not raw unit coverage. The missing coverage is cross-surface settlement:

- a healthy `/ready` plus stale execution stages must block `dispatch`;
- a healthy database plus failed route probe must block only the action classes that require that route;
- a healthy rollout plus recent image-pull/probe failures must block `widen`;
- route-specific reset of the memory API must not be hidden by the global memory provider status;
- lack of direct `pods/exec` database access must not turn into an unstructured "unknown" if application database
  proofs are healthy.

### Database, Data, Freshness, and Consistency

Direct database SQL was blocked from the agent runtime:

- `kubectl cnpg psql -n jangar jangar-db` failed because the service account cannot create `pods/exec` in `jangar`;
- `kubectl cnpg psql -n torghut torghut-db` failed for the same reason in `torghut`.

Allowed data evidence:

- Jangar status reported `database.configured=true`, `database.connected=true`, `database.status="healthy"`,
  `migration_table="kysely_migration"`, `registered_count=25`, `applied_count=25`, and latest migration
  `20260418_embedding_dimension_4096`.
- `bun run --filter memories retrieve-memory` failed with `ECONNRESET` against the Jangar memories API in this
  runtime even though the memory provider was configured and globally healthy. Route-specific proof is required.
- Torghut migration job logs reported the app database ready, Alembic transactional DDL active, and simulation runtime
  privileges granted to `torghut_app`.
- Torghut `/db-check` returned `ok=true`, current and expected head `0029_whitepaper_embedding_dimension_4096`,
  `schema_graph_lineage_ready=true`, and parent-fork warnings for two historical branches.
- Torghut `/trading/health` reported Postgres, ClickHouse, and Alpaca healthy, but `universe.require_non_empty=true`
  with no evaluated symbols and empirical jobs as degraded authority.
- Jangar's market-context route for `AAPL` returned `overallState="degraded"` with stale technicals, fundamentals,
  news, and regime domains.

Interpretation: schema parity is not the blocking risk. The blocking risk is that data freshness and route-specific
proofs disagree with broad service health.

## Problem

The control plane currently has four classes of truth that can disagree:

1. serving truth: route liveness and leader election;
2. execution truth: stage clocks, pending requirements, workflows, and runtime kits;
3. data truth: migration parity, route-specific data probes, memory API behavior, market context, and empirical jobs;
4. rollout truth: deployment availability, recent events, image platform compatibility, probes, and watch reliability.

Jangar exposes much of this information, but consumers still have to interpret mixed evidence. That creates three
failure modes:

- an operator sees HTTP 200 and assumes dispatch is safe;
- a deployer sees rollout availability and widens before event/probe failures settle;
- Torghut sees live-submission liveness and treats capital as available even when profitability and Jangar dependency
  proof says it is not promotable.

## Options Considered

### Option A: Keep `/api/agents/control-plane/status` as a Raw Summary

Consumers would keep reading the current status payload and make local decisions.

Pros:

- lowest implementation cost;
- preserves current route shapes;
- no new persistence contract.

Cons:

- every consumer can interpret degraded evidence differently;
- privileged and unprivileged runtimes see different Kubernetes surfaces;
- route-specific data failures can be hidden by broad provider health;
- Torghut still has to reconcile live submission and alpha readiness itself.

Decision: reject. The raw summary remains useful, but it is not an authority.

### Option B: Fail Serving Readiness on Any Degraded Evidence

Jangar would return `503` for `/ready` whenever execution trust, rollout health, or downstream data freshness degrades.

Pros:

- simple and hard to ignore;
- makes green dashboards less misleading.

Cons:

- takes away the UI/API surface needed for repair;
- couples serving availability to downstream market data and empirical jobs;
- encourages manual bypasses during incidents;
- still does not define what Torghut should do with mixed capital evidence.

Decision: reject. Serving should remain available when it can help recovery. Promotion must be stricter than serving.

### Option C: Evidence Settlement Authority With Data-Proof Adapters

Jangar produces one settlement authority response. It consumes clocks from the existing arbiter, accepts typed data
proofs from allowed surfaces, and emits action-class decisions with expiry, negative evidence, and repair hints.

Pros:

- gives all consumers one interpretation of mixed evidence;
- supports unprivileged agent runtimes because database proof can come from application status and migration jobs;
- keeps serving and repair available while holding dispatch, widening, and external capital;
- gives Torghut one proof reference to consume in capital gates.

Cons:

- requires a new materialized/persisted contract and tests across current modules;
- requires a migration path so shadow decisions can be compared against current dependency quorum first;
- requires care to avoid dumping raw event logs or sensitive data into receipts.

Decision: select Option C.

## Chosen Architecture

### EvidenceSettlementAuthority

Add a pure builder in `services/jangar/src/server/` that consumes existing status inputs plus compact event and route
probe results. The builder returns one settled authority object.

Required fields:

- `authority_id`
- `namespace`
- `subject`
- `release_digest`
- `observed_at`
- `fresh_until`
- `decision`: `allow`, `observe`, `repair_only`, `hold`, or `unknown`
- `allowed_action_classes`: `serve`, `observe`, `repair`, `verify`, `dispatch`, `widen`, `external_capital`
- `serving_clock`
- `execution_clock`
- `rollout_clock`
- `watch_clock`
- `workflow_artifact_clock`
- `data_proof_clock`
- `route_probe_clock`
- `consumer_clock`
- `negative_evidence_refs`
- `repair_hints`

### Data-Proof Adapter

The data proof adapter normalizes database and data-freshness evidence from permitted surfaces:

- application database status routes, including migration counts and latest migration ids;
- migration job logs for completed schema operations;
- route-specific data probes such as memories, market context, and Torghut health;
- optional direct SQL only when RBAC explicitly allows it.

If direct SQL is forbidden, the adapter must record `sql_probe="forbidden"` and cite the application proof it used.
That is a valid degraded-or-healthy proof depending on the action class. It must not silently become "unknown."

### Action Matrix

- `serve`: allowed when the serving route and serving runtime kit are fresh.
- `observe`: allowed when status routes answer and the authority is not `unknown`.
- `repair`: allowed when collaboration runtime and repository access are fresh, even if rollout or data clocks are
  held.
- `verify`: allowed when the check is scoped to repair or all data-proof clocks required by the verify target are
  fresh.
- `dispatch`: allowed only when execution, schedule, workflow artifact, watch, data proof, and route probe clocks are
  fresh.
- `widen`: allowed only when rollout is available and the recent event window has no blocking image-pull, mount,
  readiness, liveness, or backoff failures.
- `external_capital`: allowed only when dispatch is allowed and every named Torghut capital proof is fresh and
  promotable.

### API Surfaces

Expose the settled authority in:

- `/api/agents/control-plane/status` as `evidence_settlement`;
- `/ready` as a visible but non-serving-blocking section unless the serving class itself is unknown or blocked;
- deploy verification output as the required rollout-widening proof;
- NATS handoff updates as compact `authority_id`, `decision`, and held action classes;
- Torghut consumer routes through the companion capital reconciliation contract.

## Implementation Scope

Engineer stage should implement:

1. `buildEvidenceSettlementAuthority()` as a pure function with injectable clocks.
2. A route/data probe collector with bounded timeout and compact negative evidence.
3. A recent-event window reader that works through the same least-privilege Kubernetes access available to agent
   runtimes.
4. Optional persistence for the latest authority receipt in the Jangar database when connected.
5. Status and readiness route additions.
6. Dispatch/deploy gates that consume `allowed_action_classes`.

Deployer stage should implement:

1. Shadow emission first, without blocking current dispatch.
2. Comparison of shadow decisions against current dependency quorum for at least three scheduled cycles.
3. Dispatch enforcement before rollout-widening enforcement.
4. Rollout-widening enforcement before Torghut external-capital enforcement.

## Validation Gates

The PR that implements this design is not ready unless these checks pass:

- Unit tests for all authority decisions: `allow`, `observe`, `repair_only`, `hold`, and `unknown`.
- Regression test: HTTP 200 `/ready` plus stale execution stages blocks `dispatch`.
- Regression test: healthy Kysely migrations plus memories route reset blocks only route-dependent action classes.
- Regression test: `pods/exec` forbidden plus healthy application DB proof produces a structured data-proof clock.
- Regression test: recent image-pull/probe events block `widen` even when rollout health is available.
- Regression test: Torghut dependency quorum block prevents `external_capital` even when live-submission liveness is
  allowed.
- Snapshot tests prove receipts include compact negative evidence refs without raw secret values or large event dumps.

## Rollout

Rollout must be staged:

1. Shadow: add `evidence_settlement.shadow_decision` and compare with current dependency quorum.
2. Repair-only enforcement: allow settlement to hold dispatch and widen only for new scheduled runs created by the
   swarm lane.
3. Dispatch enforcement: require `dispatch` for normal scheduled Jangar and Torghut agent runs.
4. Widen enforcement: require `widen` in deploy verification before image promotion.
5. Capital enforcement: require `external_capital` for Torghut non-shadow capital.

## Rollback

Rollback is configuration-first:

- disable enforcement while keeping shadow emission;
- leave receipts visible for incident analysis;
- do not delete receipt tables during rollback;
- if receipt persistence fails, fall back to process-local shadow receipts and block only `widen` and
  `external_capital`;
- if status route additions regress serving, remove the route field from `/ready` first and keep
  `/api/agents/control-plane/status` authoritative for repair.

## Risks and Open Decisions

- The event window must be tuned so short registry failures do not hold rollout forever.
- Receipt persistence needs retention limits because event-derived evidence can grow quickly.
- Direct database proof should remain optional for agents; privileged SQL can be a deployer check, not a runtime
  assumption.
- Torghut must treat a missing Jangar settlement as a capital hold, not as informational.
- The authority must not include raw secrets, raw database rows, or unbounded logs.

## Handoff

Engineer acceptance gates:

- the settlement builder is pure and has unit coverage for every action class;
- status and readiness routes expose the same `authority_id`;
- a route-specific memories failure is visible in `data_proof_clock`;
- forbidden `pods/exec` is represented as a structured RBAC fact;
- dispatch and deploy gates read the same allowed-action matrix.

Deployer acceptance gates:

- shadow receipts are visible for at least three scheduled cycles;
- no rollout widening proceeds while `widen` is absent;
- no Torghut non-shadow capital proceeds while `external_capital` is absent;
- rollback can disable enforcement without removing receipt visibility;
- NATS handoff messages cite `authority_id`, held action classes, and the next proof to refresh.
