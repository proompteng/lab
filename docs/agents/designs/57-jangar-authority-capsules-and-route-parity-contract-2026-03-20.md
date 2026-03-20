# 57. Jangar Authority Capsules and Route Parity Contract (2026-03-20)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/56-torghut-profit-clocks-and-lane-falsification-exchange-2026-03-20.md`

Extends:

- `54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`
- `54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`
- `55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`
- `56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`

## Executive summary

The decision is to make Jangar publish one compiled `authority capsule` per namespace and rollout epoch, then force
every consumer-facing route and deploy verifier to project that exact capsule instead of recomputing partial truth at
request time.

The reason is visible in the live system on `2026-03-20`:

- `GET http://jangar.jangar.svc.cluster.local/ready`
  - returns HTTP `503`
  - reports `agentsController.enabled=false`
  - reports `supportingController.enabled=false`
  - reports `execution_trust.status="blocked"`
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - reports controller heartbeats `healthy`
  - reports `database.status="healthy"` with `applied_count=24` and `unapplied_count=0`
  - reports `rollout_health.status="degraded"`
  - reports `execution_trust.status="blocked"`
  - reports both `jangar-control-plane` and `torghut-quant` swarms in `Recovering` with freeze expiry unreconciled
- `kubectl -n agents get pods`
  - shows `agents-679c868658-n2gsn` at `0/1 Running`
  - shows `agents-controllers-5c4b57cf57-mgwv8` at `0/1 Running`
  - shows older replicas still serving at `1/1`
- `kubectl -n agents get events --sort-by=.lastTimestamp | tail -n 80`
  - shows repeated readiness probe `503` on the new `agents` and `agents-controllers` pods
  - shows failed mount events for recent Jangar discover template pods because expected ConfigMaps were missing

Jangar can already see the right ingredients. The failure is that route-local code, rollout summaries, and downstream
consumers do not all reuse one compiled answer. That keeps rollout safety dependent on request-time interpretation.

The tradeoff is deliberate: more persisted state, a compiler loop, and stricter freshness expiry. That is the right
trade because the current costlier failure mode is contradictory green answers.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- objective: assess cluster/source/database state and create/update+merge required design-document PRs that improve,
  maintain, and innovate Torghut quant

This artifact succeeds when:

1. Jangar emits one durable authority object that represents rollout, freeze, capability, and consumer-binding truth
   for a given namespace and epoch.
2. `/ready`, `/api/agents/control-plane/status`, Swarm-facing status, and deploy verification all reference the same
   `authority_capsule_id` and `authority_capsule_digest`.
3. unknown or stale critical inputs become `hold` or `block`, never route-specific warnings.
4. engineer and deployer stages can validate rollout and rollback behavior from one contract instead of correlating
   several endpoints manually.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Current live evidence shows three separate authority surfaces looking at the same degraded cluster:

- Jangar route readiness:
  - `/ready` fails closed and returns `503`.
  - The payload still describes controller enablement from local route helpers.
- Jangar control-plane status:
  - the controller heartbeats are healthy;
  - rollout health is degraded because the new `agents` and `agents-controllers` rollouts are incomplete;
  - execution trust is blocked because frozen swarm stages remain unreconciled.
- Kubernetes directly:
  - one new `agents` replica and one new `agents-controllers` replica are not ready;
  - older replicas are still available;
  - recent events show `503` readiness failures and discover-template `FailedMount` events.

Interpretation:

- the system already has enough information to know that rollout truth is not clean;
- it does not yet publish one canonical object that every route and consumer must reuse;
- the same namespace can therefore look different depending on which code path answered the question.

### Source architecture and high-risk modules

The source tree explains the contradiction directly:

- `services/jangar/src/routes/ready.tsx`
  - builds readiness from local controller helpers plus execution trust;
  - it does not project a durable control-plane authority object;
  - route-local enablement booleans can therefore diverge from richer heartbeat and rollout evidence.
- `services/jangar/src/server/control-plane-status.ts`
  - already knows about heartbeats, rollout health, watch reliability, workflow reliability, empirical dependencies,
    migration consistency, and execution trust;
  - it still returns a computed payload, not a reusable authority capsule id and digest;
  - downstream consumers can therefore choose subsets of the payload.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - still validates rollout and digest parity independently from Jangar runtime authority;
  - deploy verification can therefore disagree with runtime route truth.
- `services/torghut/app/trading/hypotheses.py`
  - consumes only `decision`, `reasons`, and `message` from Jangar dependency quorum;
  - typed capability provenance is flattened before Torghut can reason about lane-local impact.

Current missing regression coverage:

- no regression proving `/ready`, `/api/agents/control-plane/status`, and deploy verification return the same capsule
  digest;
- no regression proving a capsule compiler blocks when required inputs are unknown or expired;
- no regression proving stale frozen-stage windows cannot outlive fresher job or rollout evidence;
- no regression proving downstream consumers cannot bind to individual receipt subsets once a capsule exists.

### Database, schema, freshness, and continuity evidence

Database continuity is healthy enough for additive authority persistence.

- `control-plane/status` reports:
  - `database.connected=true`
  - `migration_consistency.latest_applied="20260312_torghut_simulation_control_plane_v2"`
  - `migration_consistency.unapplied_count=0`
- direct RBAC is intentionally narrower than route access:
  - Argo application reads are forbidden;
  - CNPG cluster reads are forbidden;
  - direct `pods/exec` database access is forbidden.

Interpretation:

- the next step should not expand one broad service account until it can read everything;
- the better architecture is least-privilege producers plus one durable capsule compiler that persists what each
  producer observed, when it observed it, and which rollout epoch it applies to.

## Problem statement

Jangar still has four six-month reliability risks:

1. route-local readiness and control-plane status are parallel computations, not views over one authority object;
2. downstream consumers can bind to intermediate receipt fragments instead of a finalized control-plane verdict;
3. deploy verification is not guaranteed to share runtime authority semantics;
4. stale freeze and rollout contradictions are visible, but not encoded in one replayable capsule that humans and
   automation can inspect.

That weakens safe rollout behavior exactly where the system needs the most discipline: when the cluster is partially
healthy and evidence is contradictory.

## Alternatives considered

### Option A: centralize all authority in one Jangar route

Summary:

- keep route-time computation;
- designate one endpoint as the only valid source;
- force consumers to call that endpoint.

Pros:

- smallest conceptual change;
- no new storage tables.

Cons:

- the answer is still recomputed on every call;
- deploy verification still has to fetch and trust a live route;
- historical replay and forensic diff stay weak;
- route-time races remain possible during rollout churn.

Decision: rejected.

### Option B: expand Jangar RBAC until one runtime can read every critical object directly

Summary:

- broaden Jangar’s read scope across Deployments, Argo Applications, CNPG, and downstream runtime CRs;
- keep control-plane status as the one producer-authored answer.

Pros:

- fewer moving parts than a distributed compiler;
- some `unknown` states disappear.

Cons:

- privilege footprint grows in the most sensitive control-plane runtime;
- capability truth still depends on one process doing all reads at request time;
- future option value is worse because every new capability forces more RBAC broadening.

Decision: rejected.

### Option C: compiled authority capsules with route parity

Summary:

- each producer emits typed receipts and witness records with freshness and provenance;
- Jangar compiles them into one durable `authority capsule`;
- routes, deploy verification, and downstream consumers all project that capsule by id and digest.

Pros:

- removes route-time interpretation drift;
- preserves least-privilege producer boundaries;
- gives deployers and runtime the same authority object;
- adds future option value because new capability classes extend the capsule schema instead of widening one monolith.

Cons:

- adds a compiler loop and persistence tables;
- introduces capsule expiry semantics and dual-read migration.

Decision: selected.

## Decision

Adopt **compiled authority capsules with route parity**.

Jangar will continue to own infrastructure and rollout truth, but it will no longer ask each route or consumer to
reconstruct that truth independently. The control plane will compile the latest admissible receipt set into one
capsule and make every consumer reuse it.

## Proposed architecture

### 1. Authority capsule data model

Add additive persistence for:

- `authority_capsules`
  - `id`
  - `namespace`
  - `rollout_epoch`
  - `digest`
  - `status` (`allow`, `hold`, `block`, `unknown`)
  - `fresh_until`
  - `compiled_at`
  - `compiler_version`
  - `summary_reason`
- `authority_capsule_inputs`
  - `authority_capsule_id`
  - `subject_kind` (`rollout`, `swarm`, `stage`, `capability`, `consumer_ack`, `database`, `watch`)
  - `subject_name`
  - `status`
  - `observed_at`
  - `fresh_until`
  - `evidence_ref`
  - `reason_codes`
  - `producer`
- `authority_capsule_bindings`
  - `authority_capsule_id`
  - `consumer_name`
  - `required_subjects`
  - `binding_digest`
  - `acknowledged_at`

The capsule is the only object that may answer whether a namespace is rollout-safe.

### 2. Capsule compiler

Run a compiler loop inside Jangar control-plane runtime:

- read the latest admissible receipts and witness mirrors;
- reject contradictory epochs or expired critical receipts;
- compute one digest over the finalized input set;
- persist the capsule and input rows atomically;
- mark the previous capsule superseded but still queryable for forensic replay.

Critical rule:

- if a required receipt is missing, stale, contradictory, or `unknown`, the compiler emits `hold` or `block`;
- it never leaves that choice to a consumer.

### 3. Route parity

Replace route-local summaries with capsule projections:

- `/ready`
  - returns the latest capsule digest and the minimal route projection of it;
- `/api/agents/control-plane/status`
  - returns the same digest plus the richer input breakdown;
- Swarm and stage status surfacing
  - points at the same capsule id or explicitly says no admissible capsule exists;
- `verify-deployment.ts`
  - fetches or reads the same capsule digest rather than re-deriving readiness rules independently.

### 4. Consumer binding

Every downstream consumer must declare which capsule subjects it requires:

- Torghut hypothesis readiness requires rollout, execution trust, empirical jobs, quant capability, and relevant lane
  capability bindings.
- Deploy verification requires rollout, image digest parity, and consumer acknowledgement.
- Huly or collaboration consumers can bind to non-critical subjects without becoming global blockers.

This preserves the previous direction of typed capability receipts, but moves the final reusable answer up one layer.

## Validation gates

Engineer acceptance gates:

- add persistence schema and compiler unit tests for:
  - expired critical receipts -> `hold` or `block`
  - contradictory epochs -> `block`
  - missing consumer acknowledgement -> `hold`
  - identical input set -> stable digest
- add route parity tests proving `/ready` and `/api/agents/control-plane/status` share one digest;
- add deploy verification tests proving a digest mismatch fails closed;
- add a regression proving stale swarm freeze state cannot override fresher rollout or job evidence.

Deployer acceptance gates:

- live `curl` of `/ready` and `/api/agents/control-plane/status` returns the same `authority_capsule_digest`;
- `verify-deployment.ts` reports the same digest and status;
- `kubectl -n agents get pods` plus events must agree with capsule inputs for any degraded rollout subject;
- promotion remains blocked unless the latest capsule status is `allow` and within freshness budget.

## Rollout plan

1. Add capsule tables and compiler in shadow mode.
2. Emit capsule ids and digests alongside existing route payloads without changing decisions.
3. Flip `/ready`, control-plane status, and deploy verification to capsule-backed projection.
4. Block downstream consumer bindings that still bypass the capsule.
5. Remove legacy route-local readiness logic once parity has held for at least one full swarm cadence.

## Rollback plan

If capsule compilation or bindings regress:

- keep legacy route payloads behind a temporary feature flag for one release window;
- freeze promotion on `hold` until the prior capsule compiler version or prior digest source is restored;
- revert the capsule projection change first, not the underlying receipt producers, so evidence remains queryable.

## Risks and open questions

- Capsule compilation adds one more latency-sensitive persistence path in Jangar.
- Bad freshness budgets could create unnecessary `hold` decisions.
- Deploy tooling and runtime routes must adopt the same capsule vocabulary at the same time.
- We still need a precise migration contract for how Swarm CR status references capsule ids without duplicating capsule
  logic in the controller.

## Engineer and deployer handoff contract

Engineer handoff:

- implement capsule tables, compiler, and route parity first;
- do not add new consumer-specific shortcuts while dual-read exists;
- carry exact capsule ids through route payloads, logs, and deploy verification;
- preserve additive rollout so current receipts remain inspectable during migration.

Deployer handoff:

- treat any missing capsule digest parity as a hard rollout block;
- do not accept manual interpretation of route differences once capsule projection is enabled;
- rollback by restoring prior capsule-backed behavior or prior release digest, then confirm parity again before any
  new promotion.

