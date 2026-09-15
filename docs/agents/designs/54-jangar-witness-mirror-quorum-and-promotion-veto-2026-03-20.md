# 54. Jangar Witness-Mirror Quorum and Promotion-Veto Contract (2026-03-20)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Related mission: `codex/swarm-jangar-control-plane-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`

Extends:

- `51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`
- `53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
- `52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`

## Executive summary

The March 20 live state shows that Jangar still fails open on the most important question: whether rollout evidence is
authoritative enough to permit promotion.

Read-only evidence captured on `2026-03-20` shows:

- `kubectl -n agents get swarm jangar-control-plane -o yaml`
  - `status.phase = Frozen`
  - `status.updatedAt = 2026-03-11T15:48:11.742Z`
  - `status.queuedNeeds = 5`
  - `status.lastDiscoverAt = 2026-03-08T07:05:00Z`
- `curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents'`
  - `database.status = "healthy"`
  - `rollout_health.status = "unknown"`
  - `rollout_health.message = "rollout health unavailable (kubernetes query failed)"`
  - `dependency_quorum.decision = "allow"`
  - `agentrun_ingestion.status = "unknown"`
  - `agentrun_ingestion.message = "agents controller not started"`
- `kubectl auth can-i list deployments -n agents`
  - returned `no`
- `kubectl -n agents get agentrun jangar-swarm-plan-template -o yaml`
  - `status.phase = Failed`
  - `status.reason = BackoffLimitExceeded`
  - `status.finishedAt = 2026-03-19T18:53:58.845Z`
- `kubectl -n agents get events --sort-by=.metadata.creationTimestamp | tail`
  - shows the discover job being killed and recreated on `2026-03-20`, even while the `Swarm` object still reports the
    stale frozen state from March 11.

The system is therefore doing the wrong thing in the dangerous direction:

- rollout truth is incomplete because Kubernetes rollout reads are RBAC-limited;
- stale swarm state is still visible after the freeze window expired;
- failed stage jobs exist in the last 24 hours;
- yet the top-level dependency decision remains `allow`.

The selected architecture is to move from one producer-authored summary to a **Witness-Mirror Quorum**. Jangar will
only authorize promotion when a quorum of durable witness mirrors agrees that rollout, stage progress, consumer
acknowledgement, and downstream evidence are fresh enough to trust. Unknown or missing critical witnesses become an
explicit veto, not an informational footnote.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- swarmName: `jangar-control-plane`
- swarmStage: `discover`
- ownerChannel: `swarm://owner/platform`

This architecture artifact succeeds when:

1. cluster, source, and database evidence are captured with concrete read-only proof;
2. at least two viable directions are compared and one is selected with explicit tradeoffs;
3. rollout authorization becomes impossible when critical evidence is `unknown`, stale, or contradictory;
4. engineer and deployer stages receive one implementation contract for validation, rollout, and rollback.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Current live evidence proves that Jangar still confuses control-plane liveness with rollout authority:

- `Swarm.status` says the swarm is still frozen on March 11 state.
- the control-plane status endpoint says controller heartbeats, database, and watch streams are healthy right now.
- the same payload cannot evaluate rollout objects because Kubernetes reads fail under current RBAC.
- stage jobs failed recently with `BackoffLimitExceeded`, but those failures are not preventing `dependency_quorum = allow`.

Interpretation:

- Jangar has enough evidence to know that its view is incomplete;
- Jangar does not yet convert incomplete rollout evidence into a mandatory hold or veto;
- deployer stages still need operator inference to decide whether rollout truth is good enough to trust.

### Source architecture and high-risk modules

The source tree matches the live contradiction:

- `services/jangar/src/server/control-plane-status.ts`
  - `DEFAULT_EXECUTION_TRUST_ENABLED = false`
  - `unknownRolloutHealth()` emits `status = "unknown"` but only material rollout degradation affects quorum
  - `dependency_quorum` blocks on degraded rollout, not on rollout evidence being unavailable
- `services/jangar/src/routes/ready.tsx`
  - readiness only enforces execution trust when `JANGAR_CONTROL_PLANE_EXECUTION_TRUST` is enabled
  - if trust is disabled, `/ready` can remain green while rollout authority is incomplete
- `services/jangar/src/server/control-plane-status.ts`
  - `agentrun_ingestion` can remain `unknown` while controller heartbeats are healthy
  - that gap is surfaced, but it is not made authoritative for promotion
- `services/torghut/app/trading/hypotheses.py`
  - downstream consumers only receive `decision/reasons/message`
  - they do not receive the exact provenance of why rollout truth is incomplete

Current missing regression coverage:

- no test proving `rollout_health.status = "unknown"` forces `dependency_quorum != allow`;
- no test proving expired frozen swarm state cannot survive as the active authority after fresh jobs have started;
- no test proving `agentrun_ingestion.status = unknown` plus recent backoff-limit failures blocks promotion for the
  affected stage;
- no test proving `/ready`, `/api/agents/control-plane/status`, and `Swarm.status` are projections of the same witness
  state.

### Database and data continuity evidence

Storage is healthy enough. The missing piece is authoritative witness continuity.

- Jangar control-plane status reports:
  - `database.connected = true`
  - `migration_consistency.applied_count = 24`
  - `migration_consistency.unapplied_count = 0`
- direct CNPG inspection remains RBAC-limited for this worker;
- the architecture gap is not database reachability, but the absence of durable rows that say:
  - which evidence surfaces were evaluated,
  - which ones were missing or stale,
  - which rollout epoch they applied to,
  - which consumers acknowledged them.

## Problem statement

Today Jangar still has four reliability-critical blind spots:

1. it can emit `dependency_quorum = allow` while rollout evidence is `unknown`;
2. it can carry stale frozen swarm truth long after the freeze window expired;
3. it can observe failed stage jobs without attaching those failures to one authoritative promotion veto;
4. it gives downstream consumers one coarse decision instead of the exact witness set that justified it.

That means safer rollout behavior still depends on human interpretation of several partially trusted surfaces. The next
architecture step must make incompleteness itself authoritative.

## Alternatives considered

### Option A: widen Jangar RBAC and keep producer-authored rollout truth

Summary:

- grant the control plane direct read access to `Deployment`, `ReplicaSet`, `Application`, and related rollout objects;
- keep the current dependency-quorum model, but improve the quality of the producer view.

Pros:

- smallest conceptual delta;
- fewer new persistence objects;
- direct access could remove some `unknown` states quickly.

Cons:

- increases the privilege footprint of the control plane;
- still trusts one producer summary as the final authority;
- does not generalize to downstream evidence that Jangar cannot read directly;
- keeps rollout safety tightly coupled to RBAC scope.

### Option B: keep the existing quorum model and tune thresholds

Summary:

- treat `rollout_health.unknown` as a warning;
- lower backoff thresholds and add more alerts.

Pros:

- smallest implementation delta;
- easy to land incrementally.

Cons:

- still fails open on missing critical evidence;
- turns a correctness problem into observability noise;
- leaves deployer decisions dependent on manual interpretation.

### Option C: witness-mirror quorum with promotion-veto semantics

Summary:

- each critical surface publishes a durable witness mirror;
- promotion requires a quorum of fresh, non-contradictory witnesses;
- missing or unknown critical witnesses become `hold` or `block`.

Pros:

- works with least-privilege producers instead of broadening one service account;
- turns `unknown` into an explicit control decision;
- gives downstream consumers the exact provenance of the decision;
- improves future option value because new witness classes can be added without central RBAC expansion.

Cons:

- broader schema and controller work;
- adds reconciliation logic and expiry semantics;
- raises the bar for stage completion because incomplete evidence can no longer be ignored.

## Decision

Adopt **Option C**.

The current failure is not a monitoring problem. It is an authority problem. Jangar must only authorize promotion when
it can prove that the required evidence set exists, is fresh, and does not contradict the intended rollout epoch.

## Proposed architecture

### 1. Witness-mirror ledger

Add durable witness rows under `agents_control_plane`:

- `rollout_witness_mirrors`
  - key: `{rollout_epoch_id, witness_kind, witness_subject}`
  - fields:
    - `witness_kind` in `{cluster_rollout, swarm_stage, agentrun_health, consumer_ack, data_evidence, collaboration}`
    - `witness_subject`
    - `status` in `{healthy, hold, block, unknown}`
    - `reason_codes[]`
    - `observed_at`
    - `fresh_until`
    - `source_revision`
    - `source_config_hash`
    - `evidence_ref`
    - `producer_identity`
- `rollout_witness_events`
  - immutable append-only history of `published`, `staled`, `recovered`, `contradicted`, and `expired` transitions

Witness mirrors are produced by the component that can authoritatively see the surface:

- Jangar controller for control-plane heartbeats and stage jobs;
- GitOps or rollout adapters for deployment/application truth;
- Torghut for profit-side consumer acknowledgement;
- mission runtime for collaboration delivery state.

### 2. Promotion covenant and veto rules

Add `promotion_covenants` keyed by `{swarm, rollout_epoch_id}` with:

- `required_witnesses[]`
- `optional_witnesses[]`
- `decision` in `{allow, hold, block}`
- `blocking_witnesses[]`
- `degraded_witnesses[]`
- `published_at`
- `expires_at`
- `rollback_epoch_id`
- `evidence_bundle_ref`

Mandatory behavior changes:

- `rollout_health.status = "unknown"` is a veto for promotion-facing decisions;
- stale `Swarm.status` that conflicts with fresh stage-job witnesses yields `decision = hold`;
- recent `BackoffLimitExceeded` on required stages yields `decision = block` for the affected stage or swarm;
- `agentrun_ingestion.status = "unknown"` remains non-authoritative until a fresh witness confirms otherwise.

### 3. Surface convergence

Derive these surfaces from the same covenant snapshot:

- `/ready`
- `/api/agents/control-plane/status`
- `Swarm.status`
- downstream dependency payloads consumed by Torghut

Required invariants:

- `/ready` cannot return `200` when the active promotion covenant is `block`;
- `/api/agents/control-plane/status` cannot emit `dependency_quorum = allow` when any required witness is `unknown`;
- `Swarm.status.phase` becomes a projection of covenant truth, not a separate authority surface;
- downstream consumers receive witness-level provenance, not only `decision/reasons/message`.

### 4. Failure-mode reduction

This design explicitly reduces the live failure modes observed on March 20:

- RBAC-limited rollout reads no longer disappear into `unknown`; they produce a durable `cluster_rollout:insufficient_scope`
  witness and veto promotion.
- stale frozen swarms no longer persist as orphaned status; contradictory stage-job witnesses force `hold` until the
  projection is reconciled.
- recent `BackoffLimitExceeded` jobs no longer remain local workflow telemetry; they become veto-capable stage
  witnesses.
- downstream runtimes can distinguish:
  - `global block`
  - `stage-local hold`
  - `consumer acknowledgement missing`
  - `evidence stale`

### 5. Implementation scope

Engineer stage must implement:

- new `agents_control_plane` tables and migrations for witness mirrors, covenant snapshots, and immutable events;
- witness producers for:
  - rollout adapters
  - swarm-stage freshness
  - agentrun backoff/failure status
  - consumer acknowledgement
- covenant builder logic in `services/jangar/src/server/control-plane-status.ts`;
- readiness/status projection changes in `services/jangar/src/routes/ready.tsx` and `Swarm.status` shaping paths;
- consumer payload expansion so Torghut can consume witness freshness and scope directly.

## Validation and acceptance gates

Engineer acceptance gates:

- add a regression proving `rollout_health.status = "unknown"` yields `dependency_quorum.decision in {"delay","block"}`; it
  must never remain `allow`;
- add a regression proving stale March 11 freeze state plus fresh stage-job witnesses yields `hold`, not `healthy`;
- add a regression proving recent `BackoffLimitExceeded` for `plan` or `verify` blocks the affected covenant;
- add a regression proving `/ready`, `/api/agents/control-plane/status`, and the swarm projection are derived from the
  same covenant id;
- add a regression proving RBAC-denied rollout reads are rendered as a typed witness reason, not collapsed to generic
  `unknown`.

Deployer acceptance gates:

- do not promote if any required witness is `unknown`, stale, or contradictory;
- do not promote if the active covenant id differs across `/ready`, control-plane status, and downstream consumer
  acknowledgement;
- verify one forced failure drill where rollout RBAC is insufficient and Jangar holds promotion rather than allowing it;
- verify one recovery drill where a blocked stage witness is replaced by a fresh healthy witness and the covenant
  advances cleanly.

## Rollout plan

1. Add witness tables and write witnesses in shadow mode only.
2. Publish covenant snapshots advisory-only for at least one full day of scheduled swarm activity.
3. Diff old `dependency_quorum` output against covenant output; any case where the covenant is stricter must be reviewed.
4. Switch `/api/agents/control-plane/status` to covenant-derived `dependency_quorum`.
5. Switch `/ready` and `Swarm.status` projections to covenant-derived state.
6. Require downstream consumers to include the covenant id they used when making promotion decisions.

## Rollback plan

If covenant enforcement proves too noisy:

- keep writing witness mirrors and covenant rows;
- disable hard enforcement behind `JANGAR_CONTROL_PLANE_WITNESS_QUORUM_ENFORCED=false`;
- revert `/ready` and downstream dependency payloads to legacy evaluation temporarily;
- preserve witness history so the noisy segments can be fixed without losing diagnosis data.

Rollback is a GitOps and PR-driven change only. Do not patch the cluster manually to bypass covenant truth.

## Risks and open questions

- witness churn can create noisy `hold` transitions if freshness windows are too short;
- clock skew between producers can cause false expiry if timestamps are not normalized carefully;
- rollout adapters still need a trustworthy source for Argo and deployment truth;
- covenant strictness will expose pre-existing ambiguity, which can look like a regression during the first rollout.

## Handoff to engineer

- implement witness persistence before any new enforcement logic;
- keep all new vetoes typed and durable; generic `unknown` is not sufficient;
- make the covenant id visible in logs, status payloads, and test fixtures;
- preserve least privilege by preferring producer-authored mirrors over central RBAC expansion.

## Handoff to deployer

- treat `allow` as valid only when the covenant id, freshness window, and required witnesses match across every queried
  surface;
- use witness events as the primary incident timeline for rollout decisions;
- if the covenant is `hold` because of missing evidence, do not bypass it with manual promotion;
- verify rollback by observing covenant transition, not only pod readiness.
