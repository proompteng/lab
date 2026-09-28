# 86. Jangar Query-Budgeted Evidence Receipts and Admission Firebreaks (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, database backpressure, route authority, schedule dispatch, rollout widening,
and Torghut capital-proof consumption.

Companion Torghut contract:

- `docs/torghut/design-system/v6/90-torghut-proof-receipt-router-and-capital-query-firebreak-2026-05-05.md`

Extends:

- `85-jangar-proof-debt-exchange-and-rollout-credit-windows-2026-05-05.md`
- `84-jangar-material-action-settlement-and-proof-budget-cutover-2026-05-05.md`
- `72-jangar-route-authority-fuses-and-deploy-quarantine-2026-05-05.md`
- `67-jangar-evidence-epochs-and-proof-cell-rollout-contract-2026-05-05.md`

## Decision

Jangar should add **query-budgeted evidence receipts** and **admission firebreaks** between status production and
material action authority. The proof-debt exchange tells the system what proof is missing. This cut makes sure the
proof is collected without letting request routes, heartbeat writers, memory saves, review ingest, and Torghut
consumers compete for unbounded database or route capacity.

I am choosing this because the current 2026-05-05 state is not a pure workload failure. Jangar is serving and the
control-plane status route can prove a current schema: `/ready` returned HTTP 200 in 0.032s, the status route returned
HTTP 200 in 3.313s, controller heartbeats were fresh, watch reliability saw 1,652 AgentRun events with zero errors,
and the Jangar database route reported 25 registered and 25 applied Kysely migrations through
`20260418_embedding_dimension_4096`. At the same time, execution trust still held plan and verify, dependency quorum
blocked on empirical jobs, the agents namespace had fresh `BackoffLimitExceeded`, missing ConfigMap, and
ImagePullBackOff evidence, Jangar app logs showed Postgres connection-slot exhaustion and heartbeat query timeouts, and
memory persistence previously timed out server-side.

Torghut sharpened the same point. The live app is running on revision `torghut-00220`, but `/db-check` and `/readyz`
timed out after 15 seconds, `/trading/health` returned HTTP 503 under `simple_submit_disabled`, options catalog
`/readyz` returned HTTP 503 with `last_success_ts=null`, and recent Torghut events included Flink exceptions,
startup/readiness probe churn, and multiple-PDB warnings. Request-time proof is too expensive to be the authority
surface for dispatch, rollout widening, or capital.

The design decision is to produce compact, expiring evidence receipts under explicit query budgets. Routes may project
the latest receipt. Admission consumers must not compile new deep proof on the request path. When a receipt is missing,
stale, over budget, or contradicted by negative evidence, the admission firebreak holds the material action while
keeping serving, observe, and bounded repair open.

## Success Metrics

1. Every database-backed proof producer declares a per-route and per-action query budget before it can feed
   `dispatch`, `widen`, `paper_submit`, or `live_submit`.
2. `/ready` and `/api/agents/control-plane/status` project receipt state without doing unbounded downstream proof
   compilation.
3. Heartbeat reads and writes have their own small pool budget and cannot starve memory, review ingest, status, or
   Torghut proof mirrors.
4. Schedule dispatch receives `hold` when the dispatch receipt is missing ConfigMap readback, runner image proof,
   workspace storage proof, or admission-passport proof.
5. Rollout widening receives `hold` when DB route proof is stale, route budgets breach, target-digest ImagePullBackOff
   is unresolved, or controller heartbeats are stale.
6. Torghut capital consumers receive `hold` when Jangar platform receipts are stale or Torghut profit receipts are
   missing, even if serving routes remain healthy.
7. Least-privilege deployers can validate the decision through route projections, events, and PR artifacts, without
   CNPG exec, Deployment reads, Argo Application reads, or secret reads.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster, Rollout, and Events

- `kubectl auth whoami` identified this worker as `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar -o wide` showed 8 Running pods. `jangar-847d6d7f8d-zx5sq` was `2/2 Running` with two
  recent restarts, and `jangar-db-1` was `1/1 Running` with one restart.
- Jangar warning events included a Redis liveness timeout, a Jangar app readiness failure and restart backoff during
  rollout, and `jangar-db-1` readiness HTTP 500.
- `kubectl get pods -n agents -o wide` showed the current agents and controller pods running, but old and current
  schedule attempts still present as `Error`, `ErrImagePull`, or `ImagePullBackOff`.
- Agents warning events in the last hour included controller `/ready` and `/health` failures, `BackoffLimitExceeded`
  on plan/verify jobs, unexpected manual jobs observed by CronJobs, missing schedule input/spec ConfigMaps, and
  stale image digests that cannot be pulled.
- `kubectl get agentruns -n agents` showed mixed state: current Jangar plan/verify runs still running while many
  older Jangar and Torghut runs were failed.
- This service account can read pods, jobs, CronJobs, events, and AgentRuns. It cannot list Deployments in
  `jangar`/`agents`, CNPG clusters in `jangar`, or Argo/Knative deployment state.

### Route and Database Evidence

- `GET http://jangar.jangar/ready` returned HTTP 200 in 0.032s. It reported leader election held by
  `jangar-847d6d7f8d-zx5sq`, execution trust degraded for stale plan/verify, and collaboration runtime kit healthy.
- `GET /api/agents/control-plane/status?namespace=agents` returned HTTP 200 in 3.313s. It reported healthy controller
  heartbeats, healthy rollout health for `agents` and `agents-controllers`, healthy watch reliability, database
  latency 13ms, and 25/25 Kysely migrations applied.
- The same status route reported `dependency_quorum.decision=block` for `empirical_jobs_degraded`.
- Jangar app logs showed repeated `remaining connection slots are reserved for roles with the SUPERUSER attribute`,
  heartbeat read failures, heartbeat publish failures, and `Query read timeout`.
- The memories helper was eventually able to retrieve prior architecture memories, but earlier workers recorded
  server-side memory save timeouts. The status route's `memory_provider.status=healthy` does not prove successful
  write-path pressure under load.
- Direct CNPG reads are blocked for this identity: `clusters.postgresql.cnpg.io is forbidden`.

### Source Architecture and Test Surface

- `services/jangar/src/server/control-plane-status.ts` already composes controller heartbeats, database status,
  rollout health, watch reliability, execution trust, empirical services, dependency quorum, and runtime admission. It
  is the right projection surface, but it still needs a receipt contract to avoid repeating expensive proof work.
- `services/jangar/src/server/control-plane-heartbeat-store.ts` stores authoritative heartbeat rows in Postgres and
  calls `ensureMigrations` before reads and writes. Its failures now need to become query-budget evidence, not just
  warnings.
- `services/jangar/src/server/db.ts` creates a shared `pg` pool with connect and query timeouts but no explicit pool
  size partition by proof class. `services/jangar/src/server/memory-provider.ts` maintains separate pools per memory
  connection string without explicit max settings.
- `services/jangar/src/server/control-plane-db-status.ts` can prove migration consistency when DB access succeeds, but
  it has no separate "budget exhausted" receipt type.
- `services/jangar/src/server/supporting-primitives-controller.ts` is the first dispatch enforcement point: it owns
  schedule ConfigMaps, runner CronJobs, admission traces, swarm scheduling, and workspace/PVC reconciliation.
- `services/jangar/src/server/primitives-kube.ts` supports ConfigMap, Job, CronJob, Deployment, events, pod, secret,
  service, and Jangar CRDs. It still lacks a first-class PVC target while workflow and workspace paths rely on PVC
  proof.
- Existing tests cover control-plane status, heartbeat store behavior, runtime admission, supporting schedules,
  Kubernetes resource access, workflow PVC validation, and readiness. The missing test is resource-budget parity:
  budget exhaustion must hold material action even when the last cached status receipt is green.

## Problem

Jangar now has a rich enough settlement vocabulary to be safe in principle. The failure mode left is cost and
backpressure. A status route can be correct and still be too expensive. A database can be schema-current and still be
under connection pressure. A memory provider can be configured and still fail to persist. A Torghut route can serve
some payloads while timing out on DB proof. If those facts are collected synchronously by the same routes that act as
admission authority, failure turns into ambiguity.

The platform needs to answer four questions before any material action:

1. What proof receipt is the action citing?
2. Which query budget funded that receipt?
3. Is the receipt still fresh and uncontested by negative evidence?
4. What action classes remain open when the receipt is missing or over budget?

Without that contract, the system will keep oscillating between over-broad freezes and overconfident route reads.

## Alternatives Considered

### Option A: Increase Pools and Timeouts

Raise Postgres pool size, memory-provider pool limits, route timeouts, and Torghut DB timeouts.

Pros:

- fastest local relief;
- simple to implement and roll back;
- reduces false route timeouts in the short term.

Cons:

- hides expensive proof patterns instead of bounding them;
- can make connection exhaustion worse during incident load;
- does not create a reusable least-privilege receipt for deployers or Torghut;
- lets route health masquerade as action authority.

Decision: use only as tactical mitigation. Reject as architecture.

### Option B: Freeze Material Actions When Any Proof Route Times Out

Hold all dispatch, rollout widening, and Torghut capital when `/ready`, status, memory, db-check, or trading health
routes miss budget.

Pros:

- conservative and easy to explain;
- reduces unsafe widening under route ambiguity;
- cheap to enforce.

Cons:

- blocks repair and proof work that would restore health;
- treats a stale Torghut options catalog like a Jangar controller heartbeat failure;
- gives no prioritization for which proof to collect next;
- encourages manual bypasses when the freeze is too blunt.

Decision: keep as an emergency brake only.

### Option C: Query-Budgeted Evidence Receipts With Admission Firebreaks

Produce evidence receipts under explicit query budgets, project them cheaply, and let action-specific firebreaks decide
which actions are held, allowed, or limited to repair.

Pros:

- separates serving from actuation;
- turns DB pressure into typed evidence rather than route ambiguity;
- gives deployers and Torghut a compact receipt to cite;
- keeps bounded repair open when ordinary dispatch is held;
- makes profitability proof collection measurable instead of request-time incidental work.

Cons:

- adds receipt schema, producers, and expiry handling;
- requires shadow comparison before enforcement;
- needs strict dedupe so receipts do not become another noisy event stream.

Decision: select Option C.

## Chosen Architecture

### EvidenceQueryBudget

Each producer has an explicit budget:

```text
evidence_query_budget
  budget_id
  producer
  consumer_class              # serving, dispatch, widen, paper_submit, live_submit, repair
  route_name
  pool_class                  # heartbeat, status, memory, review_ingest, torghut_mirror
  max_duration_ms
  max_rows
  max_connections
  max_retries
  stale_after_seconds
  failure_policy              # hold, degrade, observe_only
```

Budgets should start conservative. Heartbeats and admission receipts get priority over review ingest, memory writes,
and Torghut mirrors during pressure.

### EvidenceReceipt

Receipts are compact, expiring, and cheap to project:

```text
evidence_receipt
  receipt_id
  receipt_digest
  evidence_cut_digest
  producer
  subject_kind
  subject_ref
  namespace
  release_digest
  budget_id
  budget_status               # within_budget, over_budget, timed_out, forbidden, unavailable
  decision                    # allow, degrade, hold, block
  reason_codes
  observed_at
  fresh_until
  source_refs                 # route, event, job, migration, log, artifact
  negative_evidence_refs
```

Receipts are append-friendly but deduped by subject, producer, budget, evidence cut, and failure class.

### AdmissionFirebreak

Firebreaks translate receipts into material action decisions:

```text
admission_firebreak
  action_class                # serve, observe, repair, dispatch, widen, paper_submit, live_submit
  required_receipts
  optional_receipts
  missing_policy
  over_budget_policy
  allowed_when_held           # observe, repair, replay
  rollback_switch
```

The first enforced firebreaks should be:

- `dispatch`: requires current stage passport, schedule template digest, ConfigMap readback, service account proof,
  runner image digest proof, and workspace/PVC proof.
- `widen`: requires route authority, DB receipt, controller heartbeat receipt, rollout receipt, watch reliability
  receipt, and no unresolved target-digest image-pull debt.
- `paper_submit`: requires Jangar platform receipt plus Torghut profit receipt for the hypothesis/account/window.
- `live_submit`: requires paper receipt history, rollback dry-run receipt, and explicit operator approval receipt.

## Implementation Scope

Engineer stage:

1. Add pure `EvidenceQueryBudget`, `EvidenceReceipt`, and `AdmissionFirebreak` builders under
   `services/jangar/src/server/`.
2. Add additive persistence under `agents_control_plane` or reuse current-state cache tables for receipt projection.
3. Partition DB access by proof class or add explicit pool caps for heartbeat, status, memory, review ingest, and
   Torghut mirrors.
4. Add PVC aliases to `primitives-kube` and tests for workspace storage proof.
5. Feed receipt decisions into supporting schedule reconciliation in shadow mode before hard enforcement.
6. Expose receipt summaries on `/ready` and `/api/agents/control-plane/status?namespace=agents`.

Deployer stage:

1. Validate receipt projection from least-privilege routes.
2. Run a seven-day shadow comparison of current admission versus receipt firebreak decisions.
3. Enforce `dispatch` first, then `widen`, then Torghut `paper_submit`.
4. Keep serving, observe, repair, and zero-notional proof work open while ordinary dispatch or capital is held.

## Validation Gates

- Unit tests prove DB timeout, connection-slot pressure, missing ConfigMap, missing PVC target, ImagePullBackOff, and
  stale stage evidence create `hold` receipts for the right action class.
- Route tests prove `/ready` can stay HTTP 200 while `dispatch`, `widen`, or `paper_submit` receipts are held.
- Supporting controller tests prove runner CronJobs are not created when dispatch receipt is held.
- Status tests prove stale cached receipts cannot silently allow after `fresh_until`.
- Torghut integration tests prove Jangar platform receipt `hold` blocks paper/live capital but does not block
  zero-notional proof jobs.
- Deployer validation must include one soak window with no target-digest image pull debt and no over-budget DB receipt
  before widening.

## Rollout

1. **Observe:** emit receipts and firebreak decisions without behavior changes.
2. **Shadow compare:** log every divergence between current gates and receipt firebreaks.
3. **Dispatch enforcement:** block new schedule dispatch when dispatch receipt is held; keep repair and verify paths
   available.
4. **Widen enforcement:** require widen receipt before deployer can mark a rollout promotion-safe.
5. **Capital enforcement:** require Jangar platform receipt plus Torghut profit receipt for paper, then live.

## Rollback

- Disable per-action enforcement while continuing to emit receipts.
- If DB pressure persists, switch material actions to `repair_only` and keep `/ready` serving.
- If receipt producers are noisy, disable the offending producer and retain cached negative evidence.
- If Torghut consumption fails, keep Jangar receipt projection local and hold Torghut paper/live capital.

## Risks

- Receipt spam can become another status stream; dedupe by subject, budget, evidence cut, and failure class is
  mandatory.
- Overprioritizing heartbeat writes can starve memory or review ingest; budgets must be visible and adjustable.
- A cached green receipt can become unsafe if expiry is wrong; `fresh_until` must be enforced everywhere.
- Least-privilege validation can miss lower-level CNPG symptoms; route receipts should record RBAC gaps explicitly.

## Handoff

Engineer acceptance gate: a material action cannot execute unless it cites unexpired receipts for its action class, and
tests cover both receipt allow and receipt hold paths.

Deployer acceptance gate: rollout widening is no-go when DB receipts are over budget, target digest has image-pull
debt, or Torghut profit receipts are stale. Serving and repair stay open unless route integrity itself is unknown.
