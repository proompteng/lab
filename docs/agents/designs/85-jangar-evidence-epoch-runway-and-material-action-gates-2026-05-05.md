# 85. Jangar Evidence Epoch Runway and Material Action Gates (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, least-privilege evidence settlement, rollout safety, and Torghut capital
authority handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/89-torghut-hypothesis-warrant-ledger-and-profit-runway-2026-05-05.md`

Extends:

- `84-jangar-material-action-settlement-ledger-and-slo-arbiter-2026-05-05.md`
- `84-jangar-evidence-liquidity-router-and-stale-digest-quarantine-2026-05-05.md`
- `83-jangar-lease-backed-proof-market-and-profit-aware-rollout-authority-2026-05-05.md`
- `81-jangar-action-lease-backplane-and-profit-evidence-exchange-2026-05-05.md`

## Decision

Jangar should promote the material-action settlement ledger into an **Evidence Epoch Runway**. Each action that can
dispatch work, widen a rollout, repair controller state, or grant Torghut paper/live authority must cite one current
evidence epoch and one action gate decision. The epoch is the immutable bundle of route, event, runtime-kit, rollout,
database, and Torghut profit receipts. The gate is the short-lived action decision derived from that epoch.

I am choosing this because the current cluster is serving but not trustworthy enough for material authority. Jangar
`/ready` is ok, the collaboration runtime-kit now includes `nats`, controller heartbeats are fresh, rollout health is
green for `agents` and `agents-controllers`, and watch reliability reports 1260 events with zero errors in the last
15 minutes. The same sample holds plan and verify authority because execution trust is degraded, dependency quorum is
blocked by stale empirical jobs, older jobs are still in ImagePullBackOff, and schedule attempts recently failed from
missing input/spec ConfigMaps.

The important tradeoff is that this design does not freeze the platform. Serving, observation, replay, and bounded
repair stay open. What changes is that material actions stop reading a pile of local green checks and start reading one
epoch id with explicit negative evidence.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Rollout Evidence

- Current runtime identity is `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar -o wide` showed `jangar-847d6d7f8d-zx5sq` as `2/2 Running`.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`, leader election held by
  `jangar-847d6d7f8d-zx5sq`, and runtime-kit collaboration healthy with `codex-nats-publish`, `codex-nats-soak`, and
  `nats` present.
- `GET /api/agents/control-plane/status?namespace=agents` reported all three controllers healthy by heartbeat,
  workflow/job runtimes configured, Temporal configured, database connected with 25/25 migrations, rollout health
  healthy, and watch reliability healthy.
- The same Jangar status held swarm plan/implement/verify consumers because execution trust was degraded:
  `jangar-control-plane:plan`, `jangar-control-plane:verify`, and `torghut-quant:verify` were stale across sampled
  routes.
- `kubectl get pods -n agents -o wide` showed both `agents-controllers` replicas running, but also old
  ImagePullBackOff pods for stale Jangar digests, recent Error pods, and active/retried swarm stage pods.
- `kubectl get events -n agents --sort-by=.lastTimestamp` showed recent image pulls succeeding for `919848c1`, but
  old image pull backoffs for `86423d3e` and `eba3d511`, `BackoffLimitExceeded` for plan/verify attempts, and verify
  pods blocked by missing `*-inputs` and `*-spec` ConfigMaps.
- `kubectl get events -n torghut --sort-by=.lastTimestamp` showed Torghut and Torghut-sim revisions ready, but also
  scheduling pressure, startup/readiness probe failures, Flink checkpoint exceptions, and repeated ClickHouse
  multiple-PDB warnings.

### Least-Privilege Evidence

- This service account can read pods, services, and events in the target namespaces.
- It cannot list Deployments in `agents` or `jangar`, cannot list Argo CD Applications, cannot list CNPG cluster CRs,
  and cannot create `pods/exec` into Postgres or ClickHouse pods.
- Direct SQL through `kubectl cnpg psql` and `kubectl exec` failed with `pods/exec` forbidden.
- Route-level proof did work: Jangar database status was healthy, Torghut `/db-check` returned `ok=true` and
  `schema_current=true`, and Torghut `/trading/status` exposed capital and empirical state.

This is the access pattern engineer and deployer stages should assume. A design that requires privileged database shell
access for routine settlement will fail in the runtime that actually runs the swarm.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` aggregates controllers, runtime adapters, execution trust,
  database, watch reliability, runtime admission, rollout health, workflows, dependency quorum, and empirical services.
  It returns a status snapshot, not a settled action gate.
- `services/jangar/src/server/control-plane-execution-trust.ts` already computes stale stages and blocking windows.
- `services/jangar/src/server/control-plane-workflows.ts` already derives workflow reliability and dependency quorum,
  including empirical-service blockers.
- `services/jangar/src/server/control-plane-empirical-services.ts` fetches Torghut status with a 2 second timeout and
  maps stale empirical jobs into degraded empirical services.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedules, runner jobs, admission traces, and
  workspace lifecycle. It is the correct first enforcement point for dispatch gates.
- `services/jangar/src/server/primitives-kube.ts` has common helpers for ConfigMaps, CronJobs, Deployments, Events,
  Jobs, Leases, Namespaces, and Pods. The evidence runway needs first-class storage and route receipts as peers, not
  ad hoc controller-local checks.

### Torghut Dependency Evidence

- Torghut `/healthz` returned ok and `/db-check` returned Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Torghut `/trading/health` was degraded because `live_submission_gate.ok=false` with `simple_submit_disabled`.
- Torghut `/trading/status` reported `mode=live`, active revision `torghut-00219`, `capital_stage=shadow`, three
  hypotheses, zero promotion-eligible hypotheses, three rollback-required hypotheses, and dependency quorum blocked by
  `empirical_jobs_degraded`.
- Torghut `/trading/empirical-jobs` reported four stale but truthful jobs from `2026-03-21T09:03:22Z`.
- Torghut `/trading/profitability/runtime?hours=72` reported eight rejected decisions, zero executions, zero TCA
  samples, and no promotion target.

## Problem

Jangar has enough local facts to diagnose the system, but not enough settlement discipline to keep consumers from
making different decisions from the same facts. A route can be healthy while execution trust is stale. A rollout can be
healthy while an older digest is still in ImagePullBackOff. A schedule can exist while its input ConfigMap proof was
lost. Torghut can be live-mode and schema-current while capital must remain shadow-only.

The current failure mode is interpretation drift. Operators and automation are forced to decide which status surface
is authoritative at the moment they act. That is how stale plan/verify authority, stale empirical jobs, and local green
health can be mixed into an unsafe action.

## Alternatives Considered

### Option A: Keep The Current Material Settlement Ledger

Leave `84-jangar-material-action-settlement-ledger-and-slo-arbiter-2026-05-05.md` as the implementation contract and
add only narrow tickets for stale stages, old image digests, and ConfigMap readback.

Pros:

- lowest document churn;
- keeps implementation small;
- maps directly to existing status fields.

Cons:

- does not name the evidence cut shared by `/ready`, control-plane status, schedule admission, deploy verification,
  and Torghut capital consumers;
- leaves least-privilege proof as a note rather than a contract;
- still lets consumers reinterpret negative evidence from different freshness windows.

Decision: not enough. The material ledger is the right base, but it needs an epoch boundary.

### Option B: Freeze All Material Work On Any Degraded Input

Treat stale plan, stale verify, stale empirical jobs, route timeouts, and old ImagePullBackOff pods as a global freeze.

Pros:

- simple operational behavior;
- minimizes accidental widening;
- easy to explain during an incident.

Cons:

- blocks repair work that is needed to close the freeze;
- treats stale profit evidence and control-plane image parity as the same failure class;
- wastes Torghut market-session replay windows;
- encourages manual bypass when the platform needs typed repair lanes.

Decision: keep as an emergency brake, reject as the normal architecture.

### Option C: Evidence Epoch Runway With Material Action Gates

Persist a compact epoch for each evidence cut and derive short-lived gates per material action class.

Pros:

- gives every consumer one epoch id, freshness window, and reason-code set;
- works under least-privilege access by using route receipts and Kubernetes events;
- separates serving/repair from dispatch/widen/capital authority;
- lets Torghut use blocked capital for replay without granting paper/live authority;
- makes rollout safety and profit safety share the same negative evidence vocabulary.

Cons:

- adds one projection layer and one persistence contract;
- requires shadow rollout before enforcement;
- needs strict dedupe so epochs do not become a noisy status stream.

Decision: select Option C.

## Chosen Architecture

### Evidence Epoch

An evidence epoch is immutable once published:

```text
evidence_epoch
  epoch_id
  namespace
  subject_ref
  release_digest
  generated_at
  fresh_until
  producer_revision
  route_receipts[]
  kubernetes_receipts[]
  runtime_kit_receipts[]
  rollout_receipts[]
  database_route_receipts[]
  torghut_profit_receipts[]
  negative_evidence[]
```

The epoch must include both positive and negative evidence. A forbidden CNPG read is not ignored; it becomes
`least_privilege_gap:cnpg_cluster_read_forbidden`. A missing schedule ConfigMap is not a log line; it becomes
`dispatch_input_configmap_missing`.

### Material Action Gate

Each gate references exactly one epoch:

```text
material_action_gate
  gate_id
  epoch_id
  action_class              # serve, dispatch, widen, repair, paper_submit, live_submit
  subject_ref
  decision                  # allow, hold, block, degrade
  reason_codes[]
  expires_at
  rollback_switch_ref
  minimum_next_receipt_ref
```

`serve` may degrade while `dispatch`, `widen`, `paper_submit`, and `live_submit` hold. `repair` is allowed when the
repair action names the negative evidence it closes.

### Producer Contracts

Required producers:

- `jangar_ready`: leader election, runtime kits, memory provider, and serving passport.
- `control_plane_status`: controllers, runtime adapters, database, watch reliability, rollout health, stages, workflows,
  and dependency quorum.
- `workflow_events`: pod/job events for stale image pull, BackoffLimitExceeded, missing ConfigMaps, and scheduling
  pressure.
- `database_route`: Jangar migration consistency and Torghut `/db-check`.
- `torghut_profit`: `/trading/health`, `/trading/status`, `/trading/empirical-jobs`, and
  `/trading/profitability/runtime`.

Every producer must emit `observed_at`, `fresh_until`, `source_url_or_command`, `decision`, and `reason_codes`.

## Implementation Scope

Phase 0, observe-only:

- Add an epoch builder that reads the existing Jangar and Torghut route receipts.
- Project `epoch_id` and gate summaries into `/ready` and `/api/agents/control-plane/status`.
- Add a deployer route that returns the current epoch without requiring Deployment, CNPG, secret, or exec permissions.

Phase 1, dispatch and rollout gates:

- Require schedule dispatch to read back input/spec ConfigMaps, runner image digest, runtime-kit digest, and workspace
  proof in the same epoch.
- Require rollout widening to cite rollout health, execution trust freshness, watch reliability, and database route
  proof from the same epoch.
- Quarantine old ImagePullBackOff digests as negative evidence until a current epoch proves they are not part of the
  active release.

Phase 2, Torghut capital gates:

- Emit `paper_submit` and `live_submit` gates for Torghut from the same epoch.
- Hold both gates when empirical jobs are stale, profit runtime has zero executable evidence, or Torghut remains
  shadow-only.
- Allow replay and shadow-only repair gates when they do not submit orders.

## Validation Gates

Engineer acceptance:

- Unit tests prove stale plan/verify stages produce `dispatch=hold` and `widen=hold` while `serve=degrade`.
- Regression tests prove missing schedule input/spec ConfigMaps produce negative evidence and block dispatch.
- Route tests prove `/ready`, control-plane status, and the deployer epoch route expose the same `epoch_id`.
- Timeout tests prove a Torghut profit route timeout emits a typed negative receipt instead of an empty action decision.
- Least-privilege tests run with no Deployment, CNPG, secret, or pod exec access.

Deployer acceptance:

- Shadow mode runs for seven days with zero false `allow` decisions for dispatch, widen, paper_submit, or live_submit.
- A current sample shows old ImagePullBackOff pods quarantined without blocking serving.
- A current sample shows stale empirical jobs holding Torghut capital while replay/shadow repair remains available.
- Rollback drill proves disabling gate enforcement returns Jangar to status-only behavior without deleting epoch rows.

## Rollout And Rollback

Rollout:

1. Ship epoch creation in observe-only mode.
2. Project epoch ids in Jangar routes and deployer handoff output.
3. Enforce dispatch gates for new schedule attempts only.
4. Enforce rollout widening gates.
5. Enforce Torghut paper/live gates after the companion Torghut warrant ledger is consuming epoch ids.

Rollback:

- Keep epoch writes enabled, disable enforcement with one feature flag.
- If epoch writes are noisy or slow, disable producer collection by producer class while preserving route status.
- If Torghut capital consumption misreads the epoch, force `paper_submit=hold` and `live_submit=hold` while replay stays
  allowed.

## Risks

- Epoch volume can become noisy. Mitigation: dedupe by subject, release digest, producer revision, and reason-code set.
- A stale epoch could be mistaken for authority. Mitigation: every gate expires independently and consumers must reject
  expired gates.
- Least-privilege route proof can miss low-level database failure detail. Mitigation: record the access gap and require
  application-level database route proof for routine settlement, with privileged DBA diagnostics only during incidents.
- Torghut replay could be treated as profitability proof. Mitigation: replay gates are separate from paper/live gates.

## Handoff

Engineer stage owns the epoch schema, producers, projections, dispatch gate tests, and rollout gate tests.

Deployer stage owns shadow observation, route latency budgets, least-privilege validation, rollout gate enablement, and
rollback drills.

Torghut engineer stage owns consumption of `paper_submit` and `live_submit` gates through the companion hypothesis
warrant ledger. No paper or live capital should be authorized from local Torghut health alone.
