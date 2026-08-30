# Jangar Failure-Domain Leases and Database Routability Holdbacks

Date: 2026-05-05

Author: Victor Chen, Jangar Engineering

Status: Accepted for implementation planning

Companion Torghut contract:

- `docs/torghut/design-system/v6/79-torghut-capital-holdbacks-and-profit-repair-ledger-2026-05-05.md`

Extends:

- `docs/agents/designs/74-jangar-evidence-settlement-cells-and-torghut-hypothesis-revenue-governor-2026-05-05.md`
- `docs/agents/designs/73-jangar-evidence-settlement-and-runtime-freshness-leases-2026-05-05.md`
- `docs/agents/designs/72-jangar-route-authority-fuses-and-deploy-quarantine-2026-05-05.md`
- `docs/agents/designs/jangar-control-plane-failure-mode-reduction-and-safe-rollout-architecture-2026-03-16.md`

## Decision

Jangar should treat failure domains as leased authority, not as dashboard facts. I am choosing a Failure-Domain Lease
architecture that can hold back rollout, dispatch, and downstream Torghut capital decisions when a critical domain is
not routable, even if a container still reports ready.

The immediate driver is the current cluster state. During this discover pass, the Jangar app service was not routable,
the Jangar database service refused connections, both Jangar and Torghut CNPG pods were marked terminating with
`DisruptionTarget=True`, the agents rollout had promoted-image pull failures, and older replicas were still carrying
traffic. The system had enough evidence to know the control plane was unsafe for broad promotion, but that evidence is
spread across pod readiness, service routability, events, source migrations, and live routes.

The selected change is to issue short-lived leases for each failure domain. A lease is not a deployment, a database
row, or a route response by itself. It is a bounded claim that a named domain is fresh enough for a named class of
action. When the database route is down, the database lease expires and the scheduler must hold back non-repair work.
When the promoted image cannot be pulled, the rollout lease expires and the deployer must stop widening. When source
and database migration registries cannot be compared, the schema lease is unknown and promotion is blocked until a
repair or manual override path supplies evidence.

The tradeoff is stricter gating during infrastructure turbulence. Jangar can keep serving degraded read-only views and
can keep running repair/verify jobs, but it should not dispatch normal architecture, implementation, or trading
promotion work from a control plane whose database and rollout domains are not routable.

## Runtime Inputs

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- swarm: `jangar-control-plane`
- stage: `discover`
- owner channel: `swarm://owner/platform`
- NATS channel: `general`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve the Jangar
  control plane and Torghut profitability.

Success for this artifact means the next engineer can implement a bounded lease model and the deployer can prove
rollout safety without mutating cluster or database state during validation.

## Evidence Captured

All checks were read-only.

### Cluster Health, Rollout, and Events

Jangar namespace evidence:

- `kubectl -n jangar get pods -o wide` showed `jangar-6d8c7796c9-8pk4w` at `0/2 Init:0/1`, `bumba` at
  `0/1 Running`, and `jangar-openwebui-redis-0` at `1/2 Running`.
- The current Jangar pod was blocked by a Ceph volume mount conflict:
  `MountVolume.MountDevice failed ... an operation with the given Volume ID ... already exists`.
- `curl http://jangar.jangar.svc.cluster.local/health` and `/api/health` failed to connect to port 80.
- `bumba` readiness was not healthy. The pod had `Readiness probe failed: HTTP probe failed with statuscode: 503`
  repeated over the inspected window.
- Redis readiness and liveness probes timed out on `redis-cli ping`.
- Recent namespace events included `NodeNotReady` for Jangar, Symphony, Open WebUI, and the database pod.

Agents namespace evidence:

- `kubectl -n agents get pods -o wide` showed the older `agents` and `agents-controllers` replicas running while new
  promoted replicas were blocked.
- `agents-78f6cc44f6-z9rsl` was in `ErrImagePull` or `ImagePullBackOff` for
  `registry.ide-newton.ts.net/lab/jangar-control-plane:86423d3e`.
- `agents-controllers-5447c576db-x6nkd` was in `ErrImagePull` or `ImagePullBackOff` for
  `registry.ide-newton.ts.net/lab/jangar:86423d3e`.
- Recent events showed `dial tcp 100.87.150.47:443: i/o timeout` while resolving the promoted image digests.
- Recent events also showed a missing ConfigMap for a verify run:
  `configmap "jangar-control-plane-verify-sched-m5ctm-inputs-step-1-attempt-1" not found`.

NATS evidence:

- `codex-nats-soak` against `workflow.general.>` completed and fetched 0 prior teammate messages.
- `codex-nats-publish` successfully emitted progress updates to `workflow.general.status`.
- `nats stream info agent-comms` timed out, so NATS publishing worked but stream inspection was not a reliable
  assessment surface from this runtime.

RBAC evidence:

- This service account can read pods, services, events, jobs, and cronjobs in the target namespaces.
- It cannot list Argo CD Applications, Deployments in `jangar`/`agents`, CNPG Cluster resources, Endpoints, or
  EndpointSlices.
- It cannot `pods/exec` into CNPG pods, so database validation must work through routable services or application
  health contracts.

### Database, Schema, Freshness, and Consistency

Jangar Postgres evidence:

- `jangar-db-1` container readiness was true with 0 restarts, but the pod status was terminating and Pod Ready was
  false with `DisruptionTarget=True`.
- `jangar-db-rw` existed at `10.98.225.178:5432`, but application-secret DSN connection attempts returned
  `connect ECONNREFUSED 10.98.225.178:5432`.
- Direct connection to the pod IP timed out.
- `kubectl cnpg psql -n jangar jangar-db` failed because `pods/exec` is forbidden.
- The memories helper failed before and during this run with `ConnectionRefused` against
  `http://jangar.jangar.svc.cluster.local/api/memories`.

Torghut Postgres evidence:

- `torghut-db-1` had the same split state: container readiness true, pod terminating, Pod Ready false, and
  `DisruptionTarget=True`.
- `torghut-db-rw` existed at `10.105.214.188:5432`, but DSN connection attempts timed out.
- `kubectl cnpg psql -n torghut torghut-db` failed because `pods/exec` is forbidden.

Source schema evidence:

- Jangar migration registry in `services/jangar/src/server/kysely-migrations.ts` has 25 registered migrations through
  `20260418_embedding_dimension_4096` and requires `vector` plus `pgcrypto`.
- Jangar already has table contracts for `workflow_comms.agent_messages`,
  `agents_control_plane.resources_current`, `agents_control_plane.component_heartbeats`,
  `torghut_control_plane.quant_metrics_latest`, and Torghut market-context run evidence.
- Torghut source has Alembic migrations through `0029_whitepaper_embedding_dimension_4096`.
- Because live Postgres was not routable, I could not prove applied migration freshness from the database. That is the
  exact gap this design must close: database authority cannot be inferred from source registry or container readiness.

### Source Architecture and Test Surface

High-risk Jangar modules:

- `services/jangar/src/server/codex-judge.ts` is 2728 lines and owns merge, CI, review, and outcome interpretation.
- `services/jangar/src/server/agents-controller/index.ts` is 1827 lines and spans multiple controller concerns.
- `services/jangar/src/server/agents-controller/agent-run-reconciler.ts` and `workflow-reconciler.ts` are both around
  1190 lines.
- `services/jangar/src/server/db.ts` is 1016 lines and defines a broad schema interface.
- `services/jangar/src/server/agent-comms-subscriber.ts` is 543 lines and turns NATS into durable agent messages.
- `services/jangar/src/server/control-plane-status.ts` already synthesizes database, rollout, watch, workflow,
  runtime-admission, execution-trust, and dependency-quorum status.

Existing useful primitives:

- `control-plane-db-status.ts` already detects migration drift when the database is reachable.
- `control-plane-rollout-health.ts` already distinguishes degraded deployment rollout states and exposes material
  rollout degradation helpers.
- `control-plane-watch-reliability.ts` already tracks watch events, errors, and restarts in a time window.
- `control-plane-workflows.ts` already delays or blocks workflow actions when dependency quorum, rollout health, or
  watch reliability degrade.
- `control-plane-runtime-admission.ts` already checks the runtime collaboration kit and required tools.

Test coverage is substantial but not yet aimed at this failure mode:

- `services/jangar/src/server/__tests__` has 119 test files.
- There are tests for control-plane status, database migration consistency, watch reliability, runtime admission,
  agents-controller conditions, job runtime, lifecycle, queue, rate limits, and Torghut quant integration.
- The gap is cross-domain lease behavior: no regression currently proves that database service refusal, pod
  `DisruptionTarget`, image pull failure, missing run ConfigMap, and Jangar route refusal converge into one holdback
  decision that blocks normal dispatch while preserving repair/verify work.

## Problem

Jangar has improved local failure detection, but it still lacks a single action contract for failure-domain divergence.

The current state exposes the divergence:

- A CNPG container can be ready while its pod is terminating and its service refuses connections.
- A rollout can keep serving old replicas while promoted replicas cannot pull their images.
- A service can have a ClusterIP while no route is reachable.
- A schedule can complete its CronJob while child run artifacts still fail to materialize.
- A source migration registry can be current while the live database cannot be queried.
- NATS can accept progress posts while stream inspection is unavailable.

Each fact is locally truthful. None is sufficient for admission. The control plane needs a compact lease model that
answers: which domains are fresh, which actions are allowed, which actions must hold, and what evidence closes the
holdback?

## Options Considered

### Option A: Freeze the Whole Swarm on Any Critical Failure

Stop all `jangar-control-plane` schedules and block all stages whenever Jangar DB, Jangar route, agents rollout, or
Torghut DB is degraded.

Pros:

- Simple to reason about during incidents.
- Strong blast-radius reduction.
- Easy deployer gate: any red domain blocks everything.

Cons:

- Over-blocks repair and verification work.
- Makes architecture and deployer stages unable to collect the evidence needed to exit the freeze.
- Encourages manual bypasses because the freeze is too coarse.
- Does not help Torghut continue observe-only profit evidence collection while capital remains held.

Decision: reject as the steady architecture; keep as an emergency manual mode.

### Option B: Keep Additive Status, Add More Fields

Extend `/api/agents/control-plane/status` with database routability, service reachability, image-pull, and PVC
materialization fields.

Pros:

- Lowest implementation cost.
- Uses existing UI and status tests.
- Gives operators better visibility quickly.

Cons:

- Still leaves every consumer to interpret fields differently.
- Does not produce an idempotent lease with action scope and expiry.
- Does not preserve authority when Jangar DB is down, because the status route itself can be unreachable.
- Does not give Torghut a stable object to consume for capital decisions.

Decision: reject as insufficient. It is useful implementation detail, not the architecture.

### Option C: Failure-Domain Leases with Holdback Classes

Issue short-lived leases for named domains and map each lease to explicit action classes. A lease can be stored in the
database when available, mirrored through NATS, and persisted as an artifact for repair runs. Consumers do not infer
authority from raw health fields; they consume the lease set for their action.

Pros:

- Separates serving, dispatch, deploy, repair, and capital decisions.
- Keeps read-only or repair work possible during degraded infrastructure.
- Reduces unsafe rollout progression when DB or registry evidence is stale.
- Works when the database is unavailable by allowing NATS/object-store/artifact fallback for negative evidence.
- Gives Torghut one bounded Jangar dependency object for capital holdbacks.

Cons:

- Requires a new lease lifecycle and anti-entropy reconciliation.
- Requires precise action taxonomy so holdbacks do not become vague alerts.
- Needs tests that cover multi-domain degraded states, not just per-module status.

Decision: select Option C.

## Chosen Architecture

### 1. Lease Model

Create a `FailureDomainLease` contract. The first implementation can be a TypeScript data contract plus persisted
records; a later implementation may promote it to a CRD if controller ownership needs stronger Kubernetes semantics.

Required fields:

- `lease_id`
- `domain`: `database`, `route`, `rollout`, `registry`, `storage`, `workflow_artifact`, `nats`, `source_schema`,
  `torghut_dependency`, or `manual_override`
- `scope`: namespace, workload, swarm, stage, repository, or Torghut account/window
- `status`: `valid`, `degraded`, `expired`, `unknown`, or `override`
- `action_class`: one or more of `serve_readonly`, `dispatch_normal`, `dispatch_repair`, `deploy_widen`,
  `merge_ready`, `torghut_observe`, `torghut_capital`
- `observed_at`
- `expires_at`
- `evidence_refs`: compact links to pod, event, route, query, source commit, NATS message, or artifact ids
- `reason_codes`
- `rollback_target`
- `issuer`: controller, verifier job, deployer, or manual operator identity

The lease is valid only for its declared action classes. A database lease that allows `serve_readonly` does not allow
`dispatch_normal` or `torghut_capital`.

### 2. Initial Failure Domains

Implement these domains first:

- `database`
  - Probe service routability and a read-only `select 1`.
  - Treat `Pod Ready=false`, `DisruptionTarget=True`, service connection refused, or query timeout as degraded.
  - Source registry parity is necessary but not sufficient.
- `route`
  - Probe Jangar route health and the specific status APIs that downstream consumers rely on.
  - Route refusal blocks normal dispatch and Torghut capital, but still allows repair verification from jobs with
    direct Kubernetes evidence.
- `rollout`
  - Include promoted image pull success, old/new replica split, and recent readiness flaps.
  - `ErrImagePull` or `ImagePullBackOff` for the promoted digest blocks `deploy_widen`.
- `storage`
  - Include workspace PVC mount and child-run ConfigMap materialization.
  - Missing ConfigMap or mount conflict blocks schedule dispatch for the affected stage.
- `nats`
  - Publish success can allow collaboration progress; stream-inspection timeout degrades replay confidence.
- `source_schema`
  - Compare registered migrations and expected schema heads from source. This lease cannot be valid for database
    action classes unless paired with a fresh database lease.

### 3. Holdback Classes

Map leases to action classes:

- `serve_readonly`
  - Jangar UI and status pages may serve degraded data if route is up and no secret exposure risk exists.
- `dispatch_repair`
  - Repair, verify, and evidence-collection jobs may run when their required workspace/storage lease is valid.
- `dispatch_normal`
  - Architecture, implementation, and routine schedule runs require valid `database`, `route`, `rollout`, `storage`,
    `nats`, and `source_schema` leases for their scope.
- `deploy_widen`
  - Requires valid `rollout`, `registry`, `route`, and `database` leases plus a clean soak window.
- `merge_ready`
  - Requires source validations plus no expired lease for the touched domain.
- `torghut_capital`
  - Requires valid Jangar dependency lease, Torghut database lease, Torghut proof freshness lease, and rollback lease.

### 4. Storage and Anti-Entropy

The lease store must degrade gracefully:

- Primary mirror: Jangar Postgres when `database` lease is valid.
- Live bus: NATS status and handoff events for current workers.
- Durable fallback: object-store or PR/AgentRun artifact receipt for repair jobs when DB is unavailable.
- Anti-entropy: once DB returns, replay recent NATS/artifact leases into Postgres with idempotency keys.

The key rule is negative evidence must not disappear because the database is down. If a verifier observes
`database.service_refused`, that expired lease must be visible to the next run even before Postgres recovers.

### 5. Admission and Rollout Behavior

Admission changes:

- Before creating a normal AgentRun, the controller asks the lease evaluator for the action class.
- `valid` leases allow the run.
- `degraded`, `expired`, or `unknown` leases delay normal work and write a holdback reason.
- Repair and verify runs can bypass only the failed domains they are explicitly scoped to repair.

Rollout changes:

- Canary starts with `deploy_widen` disabled.
- The deployer observes one soak window with no image pull failures, no route refusal, and no database routability
  degradation.
- Widen only after the rollout lease becomes valid for `deploy_widen`.
- Roll back immediately if the promoted digest cannot be pulled, the Jangar route is unreachable, or the database lease
  expires during the soak.

## Implementation Scope

Engineer stage:

- Add a lease data contract under the Jangar control-plane data/server boundary.
- Add lease synthesis from database probe, route probe, rollout probe, storage artifact probe, NATS collaboration probe,
  and source-schema probe.
- Wire lease decisions into control-plane status and normal AgentRun admission.
- Preserve repair/verify dispatch as an explicit exception class, not a general bypass.
- Add artifact or NATS fallback for negative evidence before introducing any DB-only persistence.

Likely source files:

- `services/jangar/src/server/control-plane-status-types.ts`
- `services/jangar/src/server/control-plane-status-types.ts`
- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/control-plane-db-status.ts`
- `services/jangar/src/server/control-plane-rollout-health.ts`
- `services/jangar/src/server/control-plane-workflows.ts`
- `services/jangar/src/server/agents-controller/agent-run-reconciler.ts`
- `services/jangar/src/server/agents-controller/job-runtime.ts`
- `services/jangar/src/server/agent-comms-subscriber.ts`

Deployer stage:

- Add a rollout preflight that records the current lease set before widening.
- Block promotion on `database.service_refused`, `database.pod_disruption_target`, `route.unreachable`,
  `registry.image_pull_timeout`, `storage.mount_conflict`, or `workflow_artifact.configmap_missing`.
- Publish the lease set and holdback decision to NATS and PR progress.
- Roll back to the last digest whose `deploy_widen` lease was valid.

## Validation Gates

Unit and integration tests:

- Database service refusal produces an expired `database` lease and blocks `dispatch_normal`.
- CNPG pod `DisruptionTarget=True` with container ready does not produce a valid database lease.
- Jangar route refusal blocks `dispatch_normal` and `torghut_capital` but still allows scoped `dispatch_repair`.
- Image pull failure for the promoted digest blocks `deploy_widen`.
- Missing child-run ConfigMap blocks only the affected schedule/stage storage lease.
- Source migration registry current plus database unreachable remains `unknown` or `expired`, never `valid`.
- Negative evidence emitted while DB is down is replayed into the DB mirror when DB recovers.

Read-only deploy validation:

- `kubectl -n jangar get pods -o wide`
- `kubectl -n jangar get events --sort-by=.lastTimestamp | tail -80`
- `kubectl -n agents get pods -o wide`
- `kubectl -n agents get events --sort-by=.lastTimestamp | tail -100`
- route probes for Jangar status endpoints
- read-only Postgres probe through service DSN, never `exec` as the primary path
- NATS publish and soak check for the current channel

Acceptance gates:

- A normal Jangar stage run is delayed with a named holdback when database or route lease is expired.
- A repair or verify run can still run and cites the failed lease it is repairing.
- A deployer cannot widen to a promoted image while any promoted replica is in `ErrImagePull` or `ImagePullBackOff`.
- Torghut receives one Jangar lease digest and can block capital without re-querying every Jangar route.

## Rollout Plan

Phase 0: shadow lease synthesis.

- Build leases and publish them in status/NATS, but do not block admission.
- Compare lease decisions against current operator decisions for at least one full rollout window.

Implementation note:

- Phase 0 is implemented additively through `/api/agents/control-plane/status` as
  `failure_domain_leases.mode="shadow"`.
- The status projector emits one typed lease set with `lease_set_digest`, per-domain leases, reason codes, evidence
  refs, rollback targets, and per-action holdback decisions.
- Current shadow domains are `database`, `route`, `rollout`, `registry`, `storage`, `workflow_artifact`, `nats`, and
  `source_schema`.
- The projector uses the existing database probe and migration consistency check, optional route probe, rollout
  health, runtime-kit admission, workflow reliability, and read-only Kubernetes pod/event evidence.
- No AgentRun admission or deploy widening enforcement is enabled by this Phase 0 surface. Operators and deployers use
  the holdback decisions as evidence until a later enforcement phase consumes the lease set directly.

Phase 1: hold back normal dispatch.

- Enable holdbacks for `dispatch_normal` when database, route, storage, or rollout leases expire.
- Keep repair and verify dispatch available with explicit scope.

Phase 2: deploy widen gate.

- Make deployer widening require a valid `deploy_widen` lease.
- Add rollback evidence to PR and NATS handoff.

Phase 3: Torghut capital consumer.

- Let Torghut consume the Jangar lease digest as part of capital admission.
- Keep Torghut observe/shadow lanes available while capital is held.

## Rollback Plan

Rollback is lease-class specific:

- If lease synthesis is wrong but status remains useful, disable enforcement and keep shadow publication.
- If lease publication is noisy, stop NATS/artifact mirroring and retain only local status.
- If dispatch is over-held, re-enable `dispatch_normal` while keeping `deploy_widen` blocked.
- If deploy widening is incorrectly blocked, require manual override with expiry, issuer, evidence refs, and rollback
  target.

Rollback must not delete evidence. Expired or incorrect leases should be superseded with a new lease revision so the
incident can be audited.

## Risks and Mitigations

- Risk: leases become another status surface that consumers ignore.
  - Mitigation: admission and deploy gates consume the lease set directly; status is only the display surface.
- Risk: DB fallback artifacts drift from DB mirror.
  - Mitigation: use idempotency keys and anti-entropy replay after DB recovers.
- Risk: strict gates slow autonomous throughput.
  - Mitigation: separate `dispatch_repair` and `torghut_observe` from `dispatch_normal` and `torghut_capital`.
- Risk: RBAC prevents rich endpoint checks.
  - Mitigation: design probes around service routability, pod/events reads, and source registry checks; do not depend on
    privileged `exec`.

## Handoff Contract

Engineer acceptance:

- Implement a typed `FailureDomainLease` contract with reason codes and action classes.
- Add tests for the current split-readiness cases: CNPG terminating/ready, service refused, image pull timeout,
  ConfigMap missing, route unreachable, and DB-down negative-evidence replay.
- Keep changes additive until shadow lease synthesis has test coverage.

Deployer acceptance:

- Capture the lease set before rollout widening.
- Do not widen while database, route, registry, rollout, or storage leases are expired for the deployment scope.
- Publish NATS handoff with the lease digest, holdback decision, rollback target, and next validation command.
- Roll back to the last digest with valid `deploy_widen` lease if promoted image pull, Jangar route, or DB routability
  fails during soak.
