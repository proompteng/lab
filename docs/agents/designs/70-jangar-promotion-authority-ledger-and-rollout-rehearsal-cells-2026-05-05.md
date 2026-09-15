# 70. Jangar Promotion Authority Ledger and Rollout Rehearsal Cells (2026-05-05)

Status: Approved for implementation (`plan`)
Date: `2026-05-05`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/75-torghut-profit-authority-ledger-and-rehearsal-cells-2026-05-05.md`

Extends:

- `docs/agents/designs/69-jangar-evidence-escrow-and-repair-cell-contract-2026-05-05.md`
- `docs/agents/designs/67-jangar-evidence-epochs-and-proof-cell-rollout-contract-2026-05-05.md`
- `docs/agents/designs/jangar-control-plane-failure-mode-reduction-and-safe-rollout-architecture-2026-03-16.md`
- `docs/torghut/design-system/v6/74-torghut-profit-cells-and-evidence-escrow-promotion-veto-2026-05-05.md`

## Executive Summary

The decision is to make Jangar publish a durable **promotion authority ledger** and to require rollout rehearsal cells
before any downstream system can treat a rollout, schedule, proof read, or Torghut capital promotion as authoritative.

The evidence says Jangar is serving but still has mixed authority signals. On `2026-05-05`, the Jangar pod in namespace
`jangar` was `2/2 Running`, the agents controllers had recovered to two `1/1 Running` replicas, and
`/api/agents/control-plane/status?namespace=agents` reported healthy controller heartbeats. At the same time, the
`agents` namespace still carried `210` Error pods, recent backoff-limit events, recurring OTLP export failures to
Mimir, and repeated `workspace pvc watch failed warn: unsupported kubernetes resource: persistentvolumeclaim` log lines.
The database tells the same story: current-state tables are fresh to the second, but `torghut_control_plane.quant_metrics_series`
is about `109 GB` with an estimated `314,034,592` rows, and a bounded `max(created_at)` freshness probe timed out.

The tradeoff is one more authority object for engineers and deployers to learn. I am accepting that cost because the
alternative is worse: route-time summaries keep mixing serving health, observer noise, historical failure tails, and
trading promotion truth into one ambiguous answer.

## Decision

Jangar will separate four authority classes:

- `serving`: the API can answer requests.
- `dispatch`: the scheduler may launch work.
- `rollout`: deploy verification may widen or advance a revision.
- `torghut_promotion`: Torghut may consume Jangar evidence for non-observe capital authority.

Each class must be projected from the latest sealed `promotion_authority_ledger` entry. A ledger entry cites one evidence
escrow, the accepted proof cells, rejected proof cells, read budgets, repair cells, and expiry. Request handlers may still
serve additive diagnostics, but they must not invent promotion authority by recomputing broad state on demand.

## Current Assessment

### Cluster and Rollout Evidence

Read-only cluster commands were run from the `agents` service account.

- `kubectl get pods -n jangar -o wide`
  - `jangar-675b5b8855-rwglb` was `2/2 Running`.
  - `bumba`, `symphony`, `symphony-jangar`, Redis, Open WebUI, Alloy, and `jangar-db-1` were running.
- `kubectl get pods -n agents --no-headers | awk ...`
  - `Running 14`
  - `Completed 16`
  - `Error 210`
- `kubectl get events -n agents --sort-by=.lastTimestamp | tail -100`
  - old schedule jobs still had `BackoffLimitExceeded` events;
  - the latest cron-created Torghut and Jangar plan jobs completed;
  - controller rollout events showed new `agents` and `agents-controllers` images becoming ready.
- `kubectl logs -n agents agents-controllers-6fc8799c76-46sj4 --tail=160`
  - controller reconciliation was active;
  - OTLP export to `observability-mimir-nginx` failed with socket and connection-refused errors;
  - the workspace PVC watcher repeatedly reported unsupported `persistentvolumeclaim`.

Interpretation:

- Jangar is not down.
- Active controllers and current heartbeats are useful truth.
- Failed-run history, observer export failures, and unsupported watch resources need bounded repair ownership rather
  than generic readiness erosion.

### Source Architecture and Test Gaps

Relevant source seams:

- `services/jangar/src/server/torghut-quant-metrics-store.ts`
  - `readQuantLatestStoreStatus()` uses the latest table for bounded current status.
  - `listLatestQuantPipelineHealth()` still ranks over `torghut_control_plane.quant_pipeline_health`, so the projection
    layer needs a materialized latest subject, not repeated wide ranking.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`
  - the typed route is the correct authority boundary for Torghut, but the live call for
    `account=paper&window=15m` timed out at eight seconds during this assessment.
- `services/jangar/src/server/primitives-kube.ts`
  - the controller log proves PVC is not yet mapped as a supported watch resource.
- `services/jangar/src/server/control-plane-execution-trust.ts`
  - request-time trust reducers exist, but consumers cannot cite one durable authority id.

Test gap:

- There are route-level tests for quant control-plane APIs, but there is no end-to-end proof that `serving`, `dispatch`,
  `rollout`, and `torghut_promotion` are projected from the same ledger entry while observer repair remains degraded.

### Database and Data Quality

Read-only Postgres evidence:

- Jangar database version: PostgreSQL `17.0`.
- Schemas present: `agents_control_plane`, `atlas`, `codex_judge`, `jangar_github`, `memories`, `public`,
  `terminals`, `torghut_control_plane`, and `workflow_comms`.
- Migration state:
  - `public.alembic_version`: `56359461a091`
  - latest Kysely rows included `20260418_embedding_dimension_4096`.
  - `public.kysely_migration_lock` had one unlocked row.
- Fresh current-state rows:
  - `public.agent_runs.updated_at`: `2026-05-05 09:27:51.737328+00`
  - `agents_control_plane.resources_current.updated_at`: `2026-05-05 09:27:51.768735+00`
  - `agents_control_plane.component_heartbeats.observed_at`: `2026-05-05 09:27:49.025+00`
  - `workflow_comms.agent_messages.created_at`: `2026-05-05 09:27:36.88803+00`
  - `torghut_control_plane.quant_metrics_latest.updated_at`: `2026-05-05 09:27:51.433984+00`
- Heavy surface:
  - `torghut_control_plane.quant_metrics_series`: estimated `314,034,592` rows, `109 GB`.
  - A `max(created_at)` probe against that table was canceled by the `4s` statement timeout.

Interpretation:

- Current-state projections are healthy and should be the authority substrate.
- Broad historical tables are audit/replay assets, not request-path proof sources.
- The ledger compiler must run with statement timeouts and must persist what it accepted or rejected.

## Problem Statement

The current control plane can be technically healthy and still ambiguous. A serving pod can be ready while old failed
jobs dominate the namespace, an observer watch can be broken, a metrics exporter can fail, and a downstream Torghut proof
route can time out. If each consumer recomputes its own interpretation, rollout safety depends on timing and luck.

For the next six months, Jangar needs one durable authority spine. It should answer:

- Which facts were accepted for this authority class?
- Which facts were rejected?
- Which repair cell owns each rejected fact?
- Which read budget was spent?
- Which consumers are allowed to proceed before the entry expires?

## Alternatives Considered

### Option A: Patch the Noisy Observers and Keep Request-Time Authority

This option would add PVC watch support, tune OTLP exporter behavior, and leave readiness and Torghut consumers to keep
calling current status routes.

Pros:

- Fastest operational cleanup.
- Small schema surface.
- Directly reduces log noise.

Cons:

- Does not give deployers or Torghut a durable authority id.
- Keeps broad read mistakes possible.
- Leaves old failed-run tails as a recurring interpretation problem.

Decision: rejected as the primary architecture. These fixes are necessary maintenance, but they are not enough.

### Option B: Make One Active Supervisor Own All Authority

This option would centralize dispatch, rollout, repair, and Torghut promotion decisions in one active control loop.

Pros:

- Clear operator story.
- Easier to reason about queue ownership.
- Fewer projection tables.

Cons:

- Increases blast radius from a supervisor bug.
- Couples trading economics too tightly to platform runtime state.
- Makes partial RBAC and observer degradation harder to handle safely.

Decision: rejected. Jangar should provide platform authority; Torghut should own economic authority.

### Option C: Promotion Authority Ledger With Rehearsal Cells (Selected)

This option compiles authority into durable ledger entries and requires every high-impact action to cite a successful
rehearsal cell for its class.

Pros:

- Makes authority replayable and auditable.
- Lets serving remain available while promotion is vetoed.
- Turns observer problems into named repair cells.
- Gives Torghut one stable platform proof id without letting Jangar own PnL.
- Avoids broad historical scans in request paths.

Cons:

- Adds tables, compiler code, and route projection work.
- Requires compatibility mode for existing consumers.
- Requires deployer discipline during cutover.

Decision: selected.

## Target Architecture

### Promotion Authority Ledger

Add a Jangar-owned ledger with these logical fields:

- `authority_ledger_id`
- `authority_class`: `serving`, `dispatch`, `rollout`, or `torghut_promotion`
- `namespace`
- `subject_kind`: `controller`, `schedule`, `revision`, `proof_cell`, `torghut_lane`
- `subject_name`
- `evidence_escrow_id`
- `generation`
- `accepted_cells`
- `rejected_cells`
- `repair_cell_ids`
- `read_budget_ms`
- `read_budget_rows`
- `status`: `allow`, `hold`, `veto`, `superseded`
- `issued_at`
- `expires_at`
- `superseded_by`

The ledger is append-only except for explicit supersession metadata. Consumers must never delete failed authority
entries to make current status look better.

### Rollout Rehearsal Cells

A rehearsal cell is a precondition bundle for one authority class. Required initial cells:

- `controller-heartbeat-cell`
  - proves leader election, controller heartbeat freshness, and CRD discovery.
- `schedule-dispatch-cell`
  - proves generated CronJobs and current AgentRuns share one accepted runtime contract.
- `image-portability-cell`
  - proves the target image digest runs on every scheduled node class required by the rollout.
- `observer-repair-cell`
  - isolates OTLP, PVC watch, and optional observer failures from serving readiness while blocking rollout widening if
    they hide required facts.
- `torghut-proof-read-cell`
  - proves typed quant-health and market-context consumers can read bounded current-state projections within budget.

### Projection Rules

- `/ready` may report `serving=allow` while `rollout=hold` or `torghut_promotion=veto`.
- `/api/agents/control-plane/status` must include the latest ledger id per authority class.
- Schedule dispatch may proceed only with a current `dispatch=allow`.
- Deploy verification may widen a Jangar revision only with `rollout=allow`.
- Torghut may treat Jangar evidence as promotion-eligible only with `torghut_promotion=allow`.

### Failure-Mode Reduction

This design removes four failure modes:

1. Broad historical scans cannot be used as request-path proof.
2. Observer failures cannot silently poison serving readiness or silently allow promotion.
3. Old failed-run tails cannot override current controller heartbeats without a repair-cell reason.
4. Image digest portability must be proven before rollout authority is widened.

## Implementation Scope

Engineer stage:

1. Add Jangar tables and Kysely migration for `promotion_authority_ledger` and `rollout_rehearsal_cells`.
2. Build a compiler that reads current-state tables with statement timeouts and emits one ledger entry per authority
   class.
3. Materialize latest `quant_pipeline_health` by `(strategy_id, account, stage, window)` so health routes do not rank
   over history.
4. Add PVC support to `primitives-kube.ts` or classify PVC watch as non-blocking observer repair when RBAC forbids it.
5. Project ledger ids into `/ready`, `/api/agents/control-plane/status`, and the Torghut quant-health route.
6. Add tests proving stale or timed-out proof cells block `torghut_promotion` but do not mark `serving` down.

Deployer stage:

1. Roll out schema and compiler in shadow mode.
2. Compare legacy route decisions with ledger projections for 24 hours.
3. Enable `dispatch` authority first, then `rollout`, then `torghut_promotion`.
4. Keep rollback as a flag flip to legacy projections plus ledger supersession, not data deletion.

## Validation Gates

Required local and CI gates:

- Jangar unit tests for ledger compiler, projection, and route compatibility.
- A regression test where `quant_metrics_series` freshness scan times out but `quant_metrics_latest` permits bounded
  current-state projection.
- A regression test where OTLP export fails and serving remains `allow`, while rollout is `hold` if the observer failure
  hides required evidence.
- A route parity test proving `/ready`, control-plane status, and Torghut quant-health expose the same
  `authority_ledger_id`.
- Kysely migration tests and rollback tests.

Required cluster gates:

- `agents_control_plane.component_heartbeats` freshness under 30 seconds.
- `resources_current` freshness under 30 seconds.
- `torghut_control_plane.quant_metrics_latest` freshness under 60 seconds for promoted lanes.
- zero broad-table freshness scans in live route handlers.
- all active rollout rehearsal cells either `allow` or explicitly `hold` with repair ownership.

## Rollout and Rollback

Rollout:

1. Land additive schema and compiler.
2. Emit ledger entries in shadow mode.
3. Add route fields without changing status codes.
4. Switch scheduler dispatch to require `dispatch=allow`.
5. Switch deploy widening to require `rollout=allow`.
6. Switch Torghut promotion checks to require `torghut_promotion=allow`.

Rollback:

- Disable ledger enforcement flags.
- Continue writing ledger diagnostics if safe.
- Mark current ledger generation `superseded`.
- Revert consumers to legacy route projection.
- Do not delete ledger or repair-cell rows.

## Risks and Tradeoffs

- More schema and route surface: accepted because authority needs replay.
- Initial false holds: accepted because false promotion is more expensive than delayed promotion.
- Ledger compiler bugs: mitigated by shadow parity and legacy projection fallback.
- Operator learning curve: mitigated by one authority id per class and repair-cell reason codes.

## Handoff Gates

Engineer acceptance:

- A Torghut promotion request can cite one Jangar `authority_ledger_id`.
- A timed-out typed quant-health read returns `hold` or `veto`, not an ambiguous operational error.
- A PVC watch warning has a repair cell and does not by itself mark serving down.

Deployer acceptance:

- The active Jangar revision exposes ledger ids on readiness and control-plane status.
- Dispatch and rollout enforcement can be enabled independently.
- Rollback is a flag change plus supersession record.
