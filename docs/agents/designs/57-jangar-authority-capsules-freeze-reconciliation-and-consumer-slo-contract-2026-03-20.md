# 57. Jangar Authority Capsules, Freeze Reconciliation, and Consumer SLO Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/56-torghut-profit-clocks-and-capital-allocation-auction-2026-03-20.md`

Extends:

- `56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`
- `55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`
- `54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`
- `54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`

## Executive summary

The decision is to stop making Jangar assemble critical rollout truth at request time and instead make it compile
small, durable **Authority Capsules** with explicit freshness budgets, while a dedicated **Freeze Reconciler** keeps
expired swarm freezes from remaining the global truth forever.

The reason is visible in the current system on `2026-03-20`:

- `GET http://jangar.jangar.svc.cluster.local/ready`
  - returns HTTP `503`
  - reports `agentsController.enabled=false`
  - reports `supportingController.enabled=false`
  - reports `execution_trust.status="blocked"`
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?account=PA3SX7FYNUTF&window=15m`
  - returns HTTP `200`
  - reports `execution_trust.status="blocked"`
  - reports `rollout_health.status="degraded"`
  - reports `dependency_quorum.decision="block"`
  - reports `database.migration_consistency.applied_count=24`
  - reports `watch_reliability.total_errors=0`
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
  - returns HTTP `200`
  - reports `latestMetricsCount=36`
  - reports `metricsPipelineLagSeconds=5`
  - reports `maxStageLagSeconds=83911`
- `GET http://torghut.torghut.svc.cluster.local/trading/status`
  - still reports `quant_evidence.reason="quant_health_fetch_failed"`
  - still reports the source URL as `http://jangar.../api/agents/control-plane/status?...`
- `kubectl get pods -n jangar -o wide`
  - shows the active Jangar pods `Running`
- `kubectl get pods -n torghut -o wide`
  - shows the core Torghut revision `Running`
  - shows both forecast pods not ready
- `kubectl get events -n torghut --sort-by=.lastTimestamp | tail -n 120`
  - shows repeated forecast `503` readiness failures
  - shows a fresh liveness timeout on the active Torghut revision

The tradeoff is more persistence, one new compiler loop, and stricter consumer admission rules. I am keeping that
trade because the current failure mode is expensive ambiguity: Jangar can answer, but consumers still depend on large
request-time projections and stale freeze state that outlives the underlying moment.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- objective: assess cluster/source/database state and create or update merged design documents that improve Jangar
  resilience and Torghut profitability

This artifact succeeds when:

1. Jangar emits one durable authority object that consumers can bind to by id and digest;
2. stale swarm-freeze truth is reconciled through an explicit control-plane loop instead of surviving indefinitely as
   a global veto;
3. `/ready`, control-plane status, deploy verification, and Torghut typed consumers share the same capsule freshness
   contract;
4. engineer and deployer stages have explicit validation, rollout, and rollback gates that can be executed without
   manually reconciling multiple ad hoc status payloads.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Current live evidence says Jangar is mostly healthy as a runtime, but not yet trustworthy as a single authority plane.

- Jangar service pods are currently healthy enough to serve:
  - `jangar-64b9d545fc-nknwd` is `2/2 Running`
  - `jangar-worker-79984689d4-zs6ql` is `1/1 Running`
  - no active Jangar namespace event noise was visible in the current read window
- the control-plane authority is still blocked by stale swarm-freeze truth:
  - `/ready` reports `execution_trust.status="blocked"`
  - `/api/agents/control-plane/status` reports the same `execution_trust.status="blocked"`
  - the reason includes:
    - `requirements are degraded on jangar-control-plane: pending=5`
    - `freeze expiry unreconciled (StageStaleness)`
    - `discover waiting for freeze reconciliation`
    - `plan waiting for freeze reconciliation`
    - `implement waiting for freeze reconciliation`
    - `verify waiting for freeze reconciliation`
- downstream dependencies remain mixed:
  - `empirical_services.forecast.status="degraded"`
  - Torghut forecast pods keep failing readiness with HTTP `503`
  - `torghut-00156` saw a liveness timeout during the same window
- Jangar market-context truth is actively degraded:
  - `GET /api/torghut/market-context/health?symbol=NVDA`
    - returns `overallState="down"`
    - reports `bundleFreshnessSeconds=366828`
    - reports stale fundamentals and news plus technicals and regime source errors

Interpretation:

- Jangar is not suffering a storage outage or a total rollout failure.
- Jangar is suffering an authority-shape problem: old freeze truth and large request-time reductions still dominate
  the contract that downstream consumers experience.

### Source architecture and high-risk modules

The source tree makes the failure mode concrete.

- `services/jangar/src/server/control-plane-status.ts`
  - computes a broad runtime view on demand;
  - `buildExecutionTrust(...)` can globally block on `StageStaleness` and unreconciled freeze expiry;
  - the payload is rich, but it is not compiled into a small consumer-oriented artifact with a single freshness budget.
- `services/jangar/src/routes/ready.tsx`
  - computes readiness from local controller helpers plus `buildExecutionTrust(...)`;
  - does not require a shared capsule id with control-plane status or deployment verification.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`
  - already exposes a narrower, typed endpoint;
  - returns quickly and materially answers the Torghut quant question;
  - is therefore the right typed subject for consumers, but not yet bound through one consumer contract.
- `services/torghut/app/trading/submission_council.py`
  - still resolves quant-health authority by falling back from `TRADING_JANGAR_QUANT_HEALTH_URL` to
    `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`;
  - that lets a generic control-plane path stand in for a typed evidence source.
- `services/torghut/app/trading/hypotheses.py`
  - reduces Jangar dependency truth to coarse `decision`, `reasons`, and `message`;
  - drops typed capability provenance that lane-local capital decisions need.

Current regression gaps:

- no regression proves an expired swarm freeze self-clears into a reconciled capsule state;
- no regression proves `/ready`, `/api/agents/control-plane/status`, deploy verification, and typed Torghut consumers
  project the same capsule digest;
- no regression proves a generic control-plane endpoint is invalid for quant-evidence authority once typed binding is
  required;
- no regression proves a capsule freshness miss becomes `hold` or `block` instead of a soft warning.

### Database, schema, freshness, and consistency evidence

The current data plane is good enough to support additive capsule persistence.

- Jangar control-plane status reports:
  - `database.status="healthy"`
  - `migration_consistency.applied_count=24`
  - `migration_consistency.unapplied_count=0`
  - latest registered and applied migration `20260312_torghut_simulation_control_plane_v2`
- Torghut `/db-check` reports:
  - `schema_current=true`
  - head `0025_widen_lean_shadow_parity_status`
  - lineage warnings for forked parents
- direct SQL execution remains RBAC-forbidden for this worker:
  - `kubectl cnpg psql -n jangar jangar-db -- ...`
  - `kubectl cnpg psql -n torghut torghut-db -- ...`
  - both fail with `pods/exec is forbidden`
- data freshness is clearly mixed:
  - Jangar market-context is down
  - Torghut quant ingestion stage lag is `83911` seconds
  - `torghut_clickhouse_guardrails_last_scrape_success 0`
  - one ClickHouse replica reports `up=0`

Interpretation:

- the next resilience move is not a database redesign;
- it is a durable authority compiler and a better freshness contract across existing state surfaces.

## Problem statement

Jangar still has four resilience-critical gaps:

1. request-time reductions remain the main way consumers obtain authority, which makes payload size, timeout budget,
   and collection scope part of the correctness story;
2. swarm freeze truth can remain globally blocking after the original moment has expired because reconciliation is not
   a first-class control-plane workflow;
3. typed consumers still do not bind to one capsule digest and freshness budget, so wrong-endpoint usage can look
   valid;
4. deploy verification, readiness, and downstream profitability consumers do not yet share a single consumer SLO
   contract.

That keeps rollout safer than earlier March states, but not safe enough for the next six months. The next six months
need a control plane that answers quickly, degrades explicitly, and cannot leave capital-sensitive consumers depending
on large request-time truth assembly.

## Alternatives considered

### Option A: keep request-time status assembly and only remove the Torghut fallback

Summary:

- fix `submission_council.py` so it never falls back to the generic control-plane route;
- leave Jangar request-time status assembly and freeze handling otherwise unchanged.

Pros:

- smallest implementation delta;
- removes one obvious wrong-endpoint failure mode.

Cons:

- leaves stale freeze truth as a long-lived global blocker;
- keeps correctness dependent on large request-time reducers and timeout behavior;
- does not align deploy verification, readiness, and consumer projections.

Decision: rejected.

### Option B: centralize all downstream authority inside Jangar

Summary:

- Jangar would own both infrastructure capsules and final Torghut capital eligibility;
- Torghut would become a thin executor of Jangar-issued profit answers.

Pros:

- single place to inspect authority;
- easiest deployer story on paper.

Cons:

- couples Jangar directly to Torghut hypothesis semantics and lane economics;
- increases blast radius for mistakes in the infrastructure control plane;
- reduces future option value for additional trading lanes and independent evidence producers.

Decision: rejected.

### Option C: authority capsules plus freeze reconciliation and explicit consumer SLOs

Summary:

- Jangar compiles small, typed capsules with digest and TTL;
- a dedicated freeze reconciler owns stale-freeze transition logic;
- each consumer declares exactly which capsule subjects and freshness budgets it requires.

Pros:

- reduces request-time failure modes and timeout sensitivity;
- turns stale-freeze state into an explicit control-plane workflow instead of a lingering accident;
- preserves clean ownership boundaries between infrastructure truth and trading-local semantics;
- gives deployers, runtime routes, and downstream services the same authority object.

Cons:

- adds compiler persistence and one more background loop;
- requires staged migration because existing consumers dual-read during rollout;
- forces tighter testing around digest parity and freshness budgets.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will compile durable authority capsules, reconcile stale freeze truth through a dedicated loop, and require all
critical consumers to bind to typed capsule subjects with explicit freshness and timeout budgets.

## Architecture

### 1. Authority capsule compiler

Add additive Jangar persistence:

- `control_plane_authority_capsules`
  - `capsule_id`
  - `capsule_kind` (`rollout`, `execution_trust`, `quant_health`, `market_context`, `empirical`, `options_bootstrap`)
  - `subject`
  - `status` (`allow`, `hold`, `block`, `unknown`)
  - `observed_at`
  - `fresh_until`
  - `digest`
  - `evidence_refs_json`
  - `payload_json`
  - `producer`
- `control_plane_capsule_compiler_runs`
  - `run_id`
  - `started_at`
  - `finished_at`
  - `compiler_version`
  - `changed_capsules`
  - `error_count`
  - `digest`
- `control_plane_consumer_bindings`
  - `consumer`
  - `required_capsule_subjects_json`
  - `max_payload_bytes`
  - `max_lookup_latency_ms`
  - `max_staleness_seconds`
  - `missing_capsule_mode`
  - `generic_fallback_allowed`
  - `updated_at`

Initial required capsule subjects:

- `rollout.jangar`
- `execution-trust.agents`
- `swarm-freeze.jangar-control-plane`
- `swarm-freeze.torghut-quant`
- `quant-health.PA3SX7FYNUTF.15m`
- `market-context.bundle.primary`
- `empirical.forecast`
- `options-bootstrap.catalog`
- `options-bootstrap.enricher`
- `options-bootstrap.ta`

Compiler rules:

- every capsule must be smaller than the consumer contract allows;
- capsules can reference larger evidence objects, but they may not require the consumer to re-run heavy reads to
  determine allow or block;
- the compiler publishes `unknown` instead of silently omitting a missing or timed-out subject;
- the compiler is the only producer allowed to emit the digest consumed by readiness, deploy verification, and Torghut
  profit clocks.

### 2. Freeze reconciler

Make stale swarm-freeze truth an explicit control-plane workflow.

Add additive persistence:

- `control_plane_freeze_reconciliation`
  - `swarm_name`
  - `freeze_reason`
  - `freeze_until`
  - `last_observed_at`
  - `reconciled_at`
  - `reconciliation_status` (`active`, `challenge`, `reconciled`, `blocked`)
  - `reconciler_digest`
  - `evidence_refs_json`

Rules:

- once `freeze_until` has passed, the reconciler must write either:
  - `challenge` with explicit blocking evidence, or
  - `reconciled` when the freeze no longer has authoritative backing;
- a stale freeze may not remain the only reason for a global block after its expiry window without a fresh reconciler
  write;
- unreconciled stale freeze truth becomes `hold`, not indefinite `block`, unless another current capsule independently
  blocks;
- the reconciler publishes the exact reason a swarm remains blocked after expiry, so downstream services stop seeing
  one opaque `StageStaleness` string.

### 3. Consumer SLO contract

Each consumer binds to capsules through one explicit contract.

Initial consumer set:

- `/ready`
- `/api/agents/control-plane/status`
- `packages/scripts/src/jangar/verify-deployment.ts`
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`
- `services/torghut/app/trading/submission_council.py`
- `services/torghut/app/main.py`
- `services/torghut/app/trading/scheduler/pipeline.py`

Contract fields:

- `consumer`
- `required_subjects[]`
- `optional_subjects[]`
- `max_staleness_seconds`
- `max_lookup_latency_ms`
- `generic_fallback_allowed`
- `project_digest`
- `failure_mode` (`hold`, `block`, `degraded`)

Rules:

- if a required subject is missing or stale, the consumer must project its configured failure mode;
- consumers may not substitute a different capsule kind for a typed requirement;
- `generic_fallback_allowed` is `false` for quant-health and market-context consumers;
- deploy verification must fail when its capsule digest differs from runtime readiness digest for the same rollout
  window.

### 4. Projection changes

Jangar routes move from heavy reduction to capsule projection.

- `/ready`
  - returns the latest consumer digest and the subset of capsule subjects it requires;
  - stops recomputing controller and trust state as the primary truth path;
  - returns `unknown` when the required capsule lookup exceeds its latency or freshness budget.
- `/api/agents/control-plane/status`
  - remains the detailed operator surface;
  - embeds the latest digest, compiler run id, and reconciliation status;
  - may include expanded payloads, but its top-level verdict must be the capsule verdict.
- `/api/torghut/trading/control-plane/quant/health`
  - remains the typed quant-health route;
  - publishes its own capsule subject and digest;
  - stops being optional from the point of view of Torghut capital consumers.

### 5. Implementation scope

Engineer scope:

- `services/jangar/src/server/control-plane-status.ts`
  - factor the current reducers into compiler inputs rather than only route handlers;
  - surface compiler run metadata and digest.
- `services/jangar/src/routes/ready.tsx`
  - project capsule truth instead of standalone local truth.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`
  - publish typed capsule metadata with the quant-health payload.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - require digest parity with runtime capsule truth.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `services/jangar/src/routes/ready.test.ts`
  - add regression coverage for stale freeze reconciliation, digest parity, and missing-capsule behavior.

Deployer scope:

- verify the compiler loop is running and the latest run is fresh before rollout progression;
- verify `/ready`, control-plane status, and deploy verification all report the same digest during the canary window;
- verify stale freeze truth has either a fresh `challenge` or `reconciled` state before treating a global block as
  authoritative.

### 6. Validation gates

Engineering gates:

1. a required consumer binding exists for every critical consumer listed above;
2. typed quant-health consumers cannot satisfy their contract from `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`;
3. stale freeze expiry produces a reconciler row and a deterministic resulting capsule state;
4. digest parity tests cover `/ready`, control-plane status, and deploy verification.

Deployment gates:

1. latest capsule compiler run is fresh and error-free enough for the rollout window;
2. latest freeze reconciliation rows for `jangar-control-plane` and `torghut-quant` are not stale;
3. `/ready` and control-plane status expose the same digest during canary and post-rollout verification;
4. no critical consumer is running on a binding contract that still allows generic fallback for typed evidence.

### 7. Rollout plan

1. Add capsule tables and the compiler behind dual-read mode.
2. Add freeze reconciler persistence and expose reconciliation status in control-plane status.
3. Wire `/ready` and deploy verification to read capsule truth while preserving detailed status output for operators.
4. Cut Torghut consumers to typed capsule bindings.
5. Remove generic fallback for quant-health and any other typed evidence consumers.

### 8. Rollback plan

Rollback is configuration and projection oriented, not data-destructive.

- keep capsule tables additive;
- if the compiler path regresses, revert consumers to the previous projection code while leaving capsule writes in
  place for diagnosis;
- if the freeze reconciler misclassifies state, disable reconciler enforcement and fall back to explicit operator hold
  while keeping the evidence rows;
- do not delete historical capsules or reconciliation rows during rollback.

## Risks and open questions

- Compiler bugs could make many consumers fail in the same way.
  - Mitigation: dual-read rollout, digest parity tests, and additive storage.
- Freeze reconciliation could clear a valid block too early.
  - Mitigation: `challenge` state requires fresh evidence refs and defaults to `hold` before `allow`.
- Consumer SLO contracts increase strictness and may surface more `unknown` states during cutover.
  - Mitigation: staged rollout with per-consumer budgets and explicit `hold` semantics.

## Handoff contract for engineer and deployer

Engineer acceptance gates:

1. New capsule and reconciliation tables exist as additive migrations only.
2. `/ready`, control-plane status, deploy verification, and typed quant-health routes emit or consume capsule digests.
3. Torghut typed consumers cannot use a generic control-plane fallback once the binding cutover flag is enabled.
4. Regression tests cover:
   - stale freeze reconciliation,
   - missing required capsule behavior,
   - digest parity across consumers,
   - no generic fallback for typed quant-health authority.

Deployer acceptance gates:

1. Latest compiler run and freeze reconciliation rows are fresh in production.
2. `/ready` and `/api/agents/control-plane/status` expose the same digest during the rollout window.
3. Torghut status surfaces reference the typed quant-health capsule subject, not the generic control-plane route.
4. Rollout is blocked if any required capsule is stale, unknown, or digest-divergent for the target consumers.
