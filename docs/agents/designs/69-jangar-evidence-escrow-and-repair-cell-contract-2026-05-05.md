# 69. Jangar Evidence Escrow and Repair Cell Contract (2026-05-05)

Status: Approved for implementation (`plan`)
Date: `2026-05-05`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/74-torghut-profit-cells-and-evidence-escrow-promotion-veto-2026-05-05.md`

Extends:

- `docs/agents/designs/65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`
- `docs/agents/designs/66-jangar-recovery-release-lanes-and-rollout-proof-fence-contract-2026-03-21.md`
- `docs/agents/designs/jangar-control-plane-failure-mode-reduction-and-safe-rollout-architecture-2026-03-16.md`
- `docs/torghut/design-system/v6/71-torghut-whitepaper-autoresearch-profit-target-strategy-factory-2026-04-21.md`

## Executive Summary

The decision is to make Jangar publish a durable evidence escrow for control-plane truth and to run every unsafe
condition through a named repair cell before it can affect serving readiness, stage dispatch, or Torghut promotion
authority.

The reason is visible in the 2026-05-05 assessment. The main Jangar namespace was serving, but the agents namespace
carried a large failed-run tail, an unready controller replica, old schedule-runner failures, and controller log noise
that mixed runtime truth with observer failures. The database also showed fresh control-plane rows and huge quant
history tables, which means the next system cannot safely re-scan broad state on every readiness request.

The tradeoff is another additive persistence layer and more explicit rollout gates. I am accepting that cost because the
more expensive failure mode is contradictory control-plane truth: a pod can be ready while the scheduler, witness cache,
database probe, or downstream promotion consumer is seeing a different system.

## Success Criteria

This design is complete when engineer and deployer stages can prove the following statements:

1. `/ready`, `/api/agents/control-plane/status`, schedule dispatch, deploy verification, and Torghut promotion checks
   cite one current `evidence_escrow_id`.
2. Every degraded surface is assigned to a bounded repair cell with an owner, deadline, blocking class, and exit gate.
3. Expensive database and Kubernetes probes run under read budgets and cannot cancel, lock, or starve runtime writers.
4. Jangar can keep `serving` readiness available during bounded observer repair while `promotion` authority remains
   vetoed.
5. Rollback means reverting the projector to legacy read paths and marking the current escrow generation superseded,
   not deleting evidence.

## Assessment Snapshot

### Cluster Health, Rollout, and Events

Commands were run read-only from the `agents` service account.

- `kubectl get pods -n jangar -o wide` showed the Jangar serving path healthy:
  - `jangar-5fd4649d47-b5shm` was `2/2 Running`.
  - `bumba`, `symphony`, `symphony-jangar`, `open-webui`, Redis, Alloy, and `jangar-db-1` were running.
- `kubectl get pods -n agents -o wide` showed the control-plane execution surface was not clean:
  - `agents-controllers-675b94fc46-5ncwz` was `0/1 Running`.
  - `agents-controllers-675b94fc46-9z644` was `1/1 Running`.
  - there were 207 failed pods and 13 running pods in the namespace at the assessment point.
- `kubectl logs -n agents job/jangar-control-plane-plan-sched-cron-29632820 --tail=160` showed old schedule-runner jobs
  still failing with the pre-fix Bun parse error:
  - `manifest?.metadata?.namespace ?? readEnv("JANGAR_POD_NAMESPACE") || 'agents'`
  - `error: Unexpected ||`
- `kubectl get events -n agents --sort-by=.lastTimestamp | tail -80` showed the hotfix jobs completing, but the
  controller then reported `UnexpectedJob` for each manually created hotfix job.
- `kubectl describe pod -n agents agents-controllers-675b94fc46-5ncwz` showed repeated `/ready` probe failures with
  `HTTP probe failed with statuscode: 503`.
- Controller logs showed two observer failures that should not be allowed to blur execution truth:
  - OTLP metrics export to `http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics` failed
    with socket and connection-refused errors.
  - `workspace pvc watch failed warn: unsupported kubernetes resource: persistentvolumeclaim`.
- `kubectl auth can-i` confirmed the assessment account can list pods and AgentRuns, can read secrets, but cannot list
  deployments or exec into pods. That is a useful production constraint: deploy verification needs to work with
  partial read authority.

Interpretation:

- Jangar is not down.
- The rollout and schedule surface is still too easy to misread.
- Observer errors, RBAC gaps, and old failed jobs need named repair ownership instead of being folded into a generic
  readiness outcome.

### Source Architecture and Test Gaps

The risky source seams are specific:

- `services/jangar/src/server/supporting-primitives-controller.ts`
  - generates schedule runner CronJobs and already contains the fixed parenthesized namespace fallback at line 945.
  - still needs repair-cell accounting so old failed jobs, hotfix jobs, and generated CronJobs share one rollout truth.
- `services/jangar/src/server/primitives-kube.ts`
  - maps pods, jobs, CronJobs, deployments, leases, secrets, services, events, and Jangar CRDs.
  - does not map `persistentvolumeclaim`, which explains the workspace PVC watch warning in controller logs.
- `services/jangar/src/server/control-plane-execution-trust.ts`
  - computes request-time execution trust from swarms and stages.
  - has useful classes for expired freeze repair and stale stages, but no durable escrow id that consumers can cite.
- `services/jangar/src/server/control-plane-watch-reliability.ts`
  - tracks in-process watch events, errors, and restarts.
  - needs a persisted observer repair path because process-local state is not enough for rollout history.
- `services/jangar/src/server/control-plane-cache-store.ts` and `control-plane-heartbeat-store.ts`
  - already prove the database can hold small current-state and heartbeat records.
  - should be extended rather than bypassed.
- Tests already cover the schedule-runner parentheses regression in
  `services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts`, but the remaining gap is an
  end-to-end proof that repair-cell state drives readiness and promotion classes.

Interpretation:

- The codebase has the right primitives.
- The missing abstraction is a durable compiled evidence object, not another status field.

### Database and Data Quality

The assessment used local read-only Postgres clients because CNPG status and pod exec were forbidden by RBAC.

Jangar database evidence:

- PostgreSQL version: `17.0`.
- Schemas with control-plane relevance:
  - `agents_control_plane`, `atlas`, `jangar_github`, `memories`, `public`, `torghut_control_plane`, and
    `workflow_comms`.
- Migration state:
  - `public.alembic_version` reported `56359461a091`.
  - `public.kysely_migration` had applied rows through the Jangar control-plane and Torghut control-plane migrations.
  - `public.kysely_migration_lock` had `is_locked=0`.
- Fresh rows:
  - `agents_control_plane.resources_current.updated_at` reached `2026-05-05T09:04:03.684Z`.
  - `agents_control_plane.component_heartbeats.updated_at` reached `2026-05-05T09:03:59.527Z`.
  - `public.agent_runs.updated_at` reached `2026-05-05T09:04:07.073Z`.
  - `workflow_comms.agent_messages.created_at` reached `2026-05-05T09:02:47.717Z`.
- Heavy tables:
  - `torghut_control_plane.quant_metrics_series` had an estimated `314,034,592` rows and about `117 GB`.
  - `torghut_control_plane.quant_pipeline_health` had an estimated `49,411,352` rows and about `13.5 GB`.
- Freshness probes against the largest series tables hit read timeouts. That is evidence that status and deploy
  verification need bounded current-state projections, not broad `max(created_at)` scans.

Torghut database evidence is captured in the companion document.

Interpretation:

- The control-plane database is live and useful.
- Broad scans are not acceptable in readiness paths.
- The escrow compiler must use latest/materialized tables, watermarks, and statement timeouts.

## Problem Statement

Jangar still has four failure modes that can survive a healthy serving pod:

1. Request-time reducers can disagree with scheduler, cache, database, and downstream consumers.
2. Observer failures can make readiness noisy without telling engineers which repair action owns the failure.
3. Partial RBAC can hide rollout details from deploy verification even when enough evidence exists elsewhere.
4. Large data surfaces can make naive freshness checks expensive enough to harm the system they are checking.

For the next six months, the control plane needs to behave less like a live summary endpoint and more like a ledgered
authority system. Each consumer should be able to ask: which facts were accepted, which facts were rejected, which repair
cell owns the gap, and what exact escrow id authorized this action?

## Alternatives Considered

### Option A: Tighten Readiness and Leave the Architecture As-Is

This option would add PVC support, fix metrics configuration, and make `/ready` less sensitive to observer failures.

Pros:

- Fastest implementation path.
- Smallest schema surface.
- Directly addresses two log errors found during the assessment.

Cons:

- Keeps correctness in request-time reducers.
- Does not give Torghut or deploy verification a durable id to cite.
- Does not create a budgeted probe contract for large tables.

Decision: rejected. This is necessary maintenance, but it is not enough architecture.

### Option B: Build a Single Active Supervisor That Owns All Decisions

This option would move final stage admission, repair, and Torghut promotion authority into one active controller loop.

Pros:

- Simple operator story.
- Easier to reason about one leader and one queue.

Cons:

- Increases blast radius from a supervisor bug.
- Couples platform readiness and trading economics too tightly.
- Makes partial RBAC and observer failure harder to degrade safely.

Decision: rejected. One supervisor is convenient until it becomes the failure domain.

### Option C: Evidence Escrow With Repair Cells (Selected)

This option compiles accepted facts into a durable escrow, assigns every rejected or stale fact to a repair cell, and
projects all readiness, dispatch, deploy, and Torghut promotion surfaces from the latest sealed escrow.

Pros:

- Gives every consumer one `evidence_escrow_id`.
- Separates `serving`, `dispatch`, `promotion`, and `repair` authority.
- Lets observer failures degrade the right class without hiding the underlying serving state.
- Makes database probe budgets enforceable.
- Preserves future option value because Torghut can consume platform truth without letting Jangar own trading economics.

Cons:

- Requires additive tables, compiler code, and projector parity tests.
- Adds one more object operators must learn.
- Needs a staged cutover to avoid breaking existing status consumers.

Decision: selected.

## Target Architecture

### Evidence Escrow

An evidence escrow is a sealed row set with this shape:

- `evidence_escrow_id`: stable id for the compiled generation.
- `generation`: monotonic per namespace.
- `scope`: `serving`, `dispatch`, `promotion`, `deployer`, or `torghut`.
- `accepted_facts`: compact fact references with source, digest, timestamp, and freshness budget.
- `rejected_facts`: fact references that were stale, expensive, forbidden by RBAC, contradictory, or malformed.
- `repair_cells`: active repair cells linked to rejected facts.
- `authority_class`: `healthy`, `degraded`, `blocked`, or `unknown`.
- `expires_at`: short TTL; stale escrows cannot authorize new promotion or rollout.
- `sealed_at`: compiler timestamp.

Fact classes:

- `rollout`: pods, jobs, CronJobs, deployment/revision observations when allowed by RBAC.
- `stage_run`: AgentRun phase, stage, outcome, runner image, branch, and failure reason.
- `observer`: watch reliability, metrics exporter, NATS comms, GitHub webhook state.
- `database`: migration lock, latest current-state rows, freshness watermarks, row-count estimates.
- `source_contract`: relevant git commit, migration registry, schedule-runner version, and test coverage.
- `consumer_ack`: Torghut and deployer acknowledgement of the escrow id they consumed.

### Repair Cells

A repair cell is the unit of accountable recovery. Each cell has:

- `repair_cell_id`
- `kind`
- `scope`
- `blocking_class`
- `owner_stage`
- `entered_at`
- `deadline_at`
- `exit_gate`
- `evidence_refs`
- `rollback_trigger`

Initial repair cell kinds:

- `schedule_runner_generation`: old CronJob jobs fail with parser or manifest generation errors.
- `controller_readiness`: one controller replica remains unready while another is ready.
- `workspace_pvc_watch`: controller attempts to watch a resource that `primitives-kube.ts` does not support.
- `metrics_exporter`: OTLP exporter points at an unavailable endpoint or creates repeated socket failures.
- `rollout_image_platform`: image pull fails because a digest has no matching platform.
- `database_probe_budget`: a freshness query exceeds its statement timeout or tries to scan a heavy table.
- `rbac_partial_visibility`: deploy verification cannot list deployments or exec into pods and must fall back to cached
  or allowed facts.

### Projectors

The legacy endpoints stay, but they become projectors:

- `/ready` returns `200` when the latest `serving` escrow is not `blocked` or `unknown`.
- `/api/agents/control-plane/status` includes the latest escrow id, authority class, repair cells, and rejected facts.
- Schedule dispatch requires a fresh `dispatch` escrow.
- Deployer verification requires a fresh `deployer` escrow or an explicit `rbac_partial_visibility` repair cell.
- Torghut promotion requires a fresh `torghut` escrow and a matching profit-cell acceptance gate from the companion doc.

### Database Probe Policy

Every compiler database probe must run with:

- `application_name='jangar-evidence-compiler'`
- `statement_timeout` at or below the escrow freshness budget
- `idle_in_transaction_session_timeout`
- read-only transaction mode
- a table allowlist that prefers current-state or materialized latest tables
- no `pg_cancel_backend`, no lock-taking maintenance, and no unbounded aggregate over large history tables

If a probe times out, the compiler records a rejected fact and opens `database_probe_budget`. It does not retry with a
larger query in the readiness path.

## Implementation Scope

Engineer stage should implement the first wave in these paths:

- `services/jangar/src/server/migrations/*`
  - Add `agents_control_plane.evidence_escrows`, `evidence_facts`, and `repair_cells`.
- `services/jangar/src/server/control-plane-status.ts`
  - Project the sealed escrow and keep the legacy fields for compatibility.
- `services/jangar/src/server/control-plane-execution-trust.ts`
  - Feed stage facts into the compiler instead of being the only authority reducer.
- `services/jangar/src/server/control-plane-watch-reliability.ts`
  - Persist observer facts and open repair cells for watch failures.
- `services/jangar/src/server/primitives-kube.ts`
  - Add `persistentvolumeclaim` and `persistentvolumeclaims`.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - Attach schedule-runner job outcomes and hotfix/UnexpectedJob observations to repair cells.
- `services/jangar/src/routes/ready.tsx`
  - Project `serving` authority from the latest sealed escrow.
- `services/jangar/src/server/__tests__/*`
  - Add compiler, projector parity, repair-cell, and probe-budget tests.

Deployer stage should update verification to cite the escrow id and to treat `rbac_partial_visibility` as degraded
rather than automatically fatal when the allowed evidence set is fresh.

## Validation Gates

Pre-merge engineering gates:

- Unit tests prove escrow digest stability and TTL expiry.
- Unit tests prove `/ready` stays serving-ready when only `metrics_exporter` or `workspace_pvc_watch` is degraded.
- Unit tests prove `promotion` authority is blocked when `database_probe_budget`, stale stage runs, or schedule-runner
  failures are active.
- A regression test proves the schedule-runner command never contains the unparenthesized `?? ... ||` pattern.
- A regression test proves `persistentvolumeclaim` resolves in `primitives-kube.ts`.
- Database tests prove compiler probes use `statement_timeout` and reject broad scans.

Pre-merge validation commands:

```bash
bun run --filter jangar test -- services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts
bun run --filter jangar test -- services/jangar/src/routes/ready.test.ts
bunx oxfmt --check docs/agents/designs/69-jangar-evidence-escrow-and-repair-cell-contract-2026-05-05.md
```

Deployer gates:

- `kubectl get pods -n jangar -o wide` shows serving pods ready.
- `kubectl get agentruns -n agents` shows no new dispatch from an expired `dispatch` escrow.
- `/api/agents/control-plane/status?namespace=agents` returns an `evidence_escrow_id` and repair-cell list.
- Jangar emits a NATS handoff message with the escrow id used for verification.

## Rollout Plan

1. Shadow compile:
   - Write escrows but do not gate readiness or dispatch.
   - Compare legacy status versus escrow projections for at least two schedule windows.
2. Seal and project:
   - `/api/agents/control-plane/status` displays escrow ids and repair cells.
   - `/ready` still follows legacy authority unless the escrow is stricter.
3. Enforce dispatch:
   - Schedule dispatch requires fresh `dispatch` escrow.
   - Old failed jobs are moved into repair history instead of counting forever.
4. Enforce promotion:
   - Torghut promotion checks require a fresh `torghut` escrow.
   - Serving remains decoupled from promotion.
5. Deployer cutover:
   - Deploy verification records the escrow id and repair-cell state in the rollout evidence.

## Rollback Plan

Rollback is data-preserving:

- Set `JANGAR_EVIDENCE_ESCROW_PROJECTOR_ENABLED=0`.
- Continue writing shadow escrows for forensics.
- Mark the active generation `superseded` with reason `projector_rollback`.
- Revert `/ready` and dispatch to legacy reducers.
- Do not delete escrow, fact, or repair-cell rows.

Rollback triggers:

- Legacy and escrow projectors disagree for two consecutive windows without an explainable repair cell.
- Escrow compiler cannot seal a generation for more than two TTLs.
- Database probe timeouts exceed the configured repair budget.
- Dispatch blocks healthy AgentRuns because of a compiler bug.

## Risks

- Escrow rows can become another stale truth surface if TTL and supersession are not enforced.
- Engineers may overuse repair cells as parking lots. Every repair cell needs a deadline and exit gate.
- Partial RBAC can still hide rollout details. The design handles that by forcing an explicit degraded cell rather than
  pretending the evidence is complete.
- Heavy Torghut metrics tables require discipline. Readiness must consume latest/materialized projections, not history
  scans.

## Handoff

Engineer acceptance:

- Add the escrow schema, compiler, and projector.
- Add PVC support and schedule-runner repair-cell wiring.
- Add tests for digest, TTL, projection parity, DB probe budgets, and readiness class separation.

Deployer acceptance:

- Verify a shadow generation, then a sealed generation, then dispatch enforcement.
- Capture the active `evidence_escrow_id`, active repair cells, and rollback flag in rollout evidence.
- Do not promote Torghut capital from a stale or missing escrow.
