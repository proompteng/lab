# Jangar Evidence Settlement Cells and Torghut Hypothesis Revenue Governor

Date: 2026-05-05

Author: Victor Chen, Jangar Engineering

Status: Accepted for implementation planning

## Decision

Jangar should move the control plane from rollout-health observation to evidence settlement. I am choosing an
Evidence Settlement Cell architecture with a Torghut Hypothesis Revenue Governor as the first consumer.

The core decision is simple: a controller, schedule, swarm stage, trading hypothesis, or deployment promotion is not
considered promotable just because the serving pod is ready or a database query succeeds. It is promotable only when a
fresh Evidence Certificate binds these facts together:

- the producing controller revision and runtime kit,
- the materialized run or trading evidence used for the decision,
- the data freshness window and schema/migration contract,
- the failure-domain budget consumed by the rollout,
- the rollback target and the exact condition that triggers it.

This is an architecture artifact, not a code patch. It is meant to give the engineer and deployer stages a concrete
contract to implement, validate, and roll back.

## Evidence Assessed

I assessed the current system through three read-only surfaces on 2026-05-05.

### Cluster Health, Rollout, and Events

The visible Jangar serving surface recovered:

- `kubectl get pods -n jangar -o wide` showed 8 pods and all were `Running`.
- `jangar-66cd546c79-jdfw6` was `2/2 Running` after a recent rollout.
- `jangar-db-1` was `1/1 Running`, primary-labeled, ready, and had 0 restarts.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status` reported `rollout_health.status:
healthy`, with `agents` at 1/1 available and `agents-controllers` at 2/2 available.

The agents execution surface still shows a large failed-run tail:

- `kubectl get pods -n agents --no-headers | awk ...` reported `Running 10`, `Completed 39`, `Error 222`, and
  `ContainerCreating 1`.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/summary` reported 60 AgentRuns: 4 running,
  9 succeeded, 35 failed, and 12 templates.
- Recent warning events included missing run ConfigMaps for active verification runs:
  `configmap "jangar-control-plane-verify-sched-m5ctm-inputs-step-1-attempt-1" not found` and
  `configmap "jangar-control-plane-verify-sched-dwltk-inputs-step-1-attempt-1" not found`.
- Recent warning events also showed controller readiness flaps during image promotion, including HTTP 503 readiness
  failures on prior `agents-controllers` replicas.
- The control-plane status endpoint reported `execution_trust.status: degraded`, with `requirements_pending: 5` and
  all four `jangar-control-plane` stages stale.

The Torghut serving surface is up but not promotable:

- `kubectl get pods -n torghut -o wide` showed the main Torghut service, ClickHouse, Keeper, options, TA, and DB pods
  running at the time of assessment.
- The current Torghut status endpoint reported build commit `3b11998de2f328f157bdbca21912306149994795` and active
  revision `torghut-00207`.
- Torghut warning events showed repeated startup/readiness gaps during Knative revision promotion and an older
  `ImagePullBackOff` class symptom on a `torghut-sim-00280` revision before later sim revisions recovered.
- The newest sim revision was still passing through startup/readiness warning windows while becoming ready.

RBAC itself is part of the evidence:

- The assessment service account could list pods, PVCs, services, and events in target namespaces.
- It could not list nodes, deployments in non-owned namespaces, CNPG clusters, or exec into database pods.
- I treated that as an intended least-privilege boundary and used service status endpoints for database evidence.

### Source Architecture and High-Risk Modules

The control plane already has useful primitives, but the failure-mode evidence is not settled into one promotable
object.

`services/jangar/src/server/supporting-primitives-controller.ts` is the highest-risk source seam for this lane:

- `buildScheduleRunTemplate` clones `AgentRun` or `OrchestrationRun` templates and injects a runtime delivery id.
- `buildScheduleRunnerCommand` is generated as an inline Bun script that reads `/config/run.json`, substitutes a UUID,
  and posts directly to the Kubernetes API.
- `reconcileSchedule` writes a ConfigMap template and CronJob, then marks the Schedule active.
- `reconcileScheduleRunnerStatus` currently derives active schedule status from CronJob `lastScheduleTime`.
- `reconcileWorkspace` provisions PVCs and deletes them when `ttlSeconds` expires.
- Watchers listen to Schedule, Workspace, CronJob, and PVC resources, then enqueue status reconciles.

The tests cover important regressions:

- `services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts` checks the generated schedule runner
  script syntax and verifies it does not contain the earlier malformed namespace expression.
- The same test suite checks schedule admission-trace propagation and secret deduplication.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts` already blocks dependency quorum when empirical
  jobs are stale or degraded.
- `services/jangar/src/server/__tests__/torghut-quant-metrics.test.ts` checks that TA freshness reads the latest
  `ta_signals` row instead of relying on aggregate probes.

The test gap is also clear:

- Schedule activation is tested as a generated Kubernetes object, but not as an end-to-end settlement between Schedule,
  ConfigMap, CronJob, child AgentRun, child pod volume materialization, and final run status.
- Workspace PVC support exists, but the current evidence plane does not bind a PVC readiness snapshot to the child run
  that consumed it.
- The control-plane status endpoint can see rollout health, database health, watch reliability, execution trust, and
  empirical services, but those facts are not issued as a durable certificate with an idempotency key and rollback
  target.
- Torghut has hypothesis governance rows and promotion decisions, but live-mode configuration can still look
  operational while hypothesis gates correctly say promotion is not allowed.

### Database, Schema, Freshness, and Consistency

Direct CNPG and pod exec access were forbidden, so I used the Jangar and Torghut service status APIs.

Jangar database evidence:

- `database.configured: true`
- `database.connected: true`
- `database.status: healthy`
- `migration_consistency.status: healthy`
- `registered_count: 25`
- `applied_count: 25`
- `unapplied_count: 0`
- `unexpected_count: 0`
- latest registered and applied migration: `20260418_embedding_dimension_4096`

The source migration registry confirms the same shape in `services/jangar/src/server/kysely-migrations.ts`, including
the static registry through `20260418_embedding_dimension_4096` and the required `vector` and `pgcrypto` extensions.

Torghut data evidence:

- `/trading/health` reported Postgres `ok`, ClickHouse `ok`, and Alpaca broker `ok`.
- `/trading/status` reported `mode: live`, `TRADING_ENABLED: true`, `TRADING_AUTONOMY_ENABLED: false`,
  `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION: false`, and `TRADING_KILL_SWITCH_ENABLED: false`.
- The same status reported `active_capital_stage: shadow`, all 3 hypotheses at shadow capital, 0 promotion eligible,
  and 3 rollback required.
- The latest signal lag was about 51,896 seconds. The status classified it as expected market-closed staleness at the
  moment, but the hypothesis contracts still marked promotion blocked by `signal_lag_exceeded`.
- Empirical jobs were stale: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` were completed from `2026-03-21T09:03:22.150009+00:00` and marked `job_stale`.
- TCA evidence exists but is not healthy for promotion: `order_count: 13775`, `avg_abs_slippage_bps:
568.6138848199565249`, and hypothesis max slippage budgets are 8 to 12 bps.
- The LLM rollout API blocked requests with `llm_rollout_evidence_missing` and `llm_rollout_stage3_must_not_shadow`.
- The quant health route through Jangar timed out after 10 seconds, which is an operability gap for the data plane
  status surface even though Torghut's direct status endpoint returned.

The database is therefore not currently the failing component. The failure is that durable data exists in several
places but no single settlement authority binds it into a promotion decision that operators can trust under rollout
pressure.

## Problem

Jangar is accumulating the right signals but still asks operators and downstream agents to reason across too many
partial truths:

- A Deployment can be healthy while Schedule stages are stale.
- A Schedule can be active while its child run fails to mount the generated ConfigMap.
- A database can be migrated while the data freshness window used by a trading hypothesis is stale.
- A trading service can say `mode: live` while the hypothesis plane correctly says every hypothesis is shadow or
  blocked.
- A controller can recover after readiness flaps, but stale failed pods and orphaned run artifacts still bias future
  incident response.

The current shape reduces local failure modes but does not yet reduce system failure modes. The next six months need a
promotion contract that makes evidence freshness, storage materialization, controller authority, and rollback behavior
first-class.

## Options Considered

### Option A: Harden Existing Status Gates

Keep the current status endpoint as the main contract. Add a few more fields for missing ConfigMaps, stale stages, and
Torghut hypothesis readiness.

Pros:

- Lowest immediate implementation cost.
- Reuses existing status endpoint and test scaffolding.
- Fits current operator habits.

Cons:

- Keeps evidence as a live read model rather than a durable decision record.
- Does not create a single object for engineer/deployer acceptance gates.
- Does not solve the gap between ready deployments and stale child evidence.
- Makes Torghut profitability harder to audit because promotion decisions remain spread across runtime status, DB rows,
  and artifacts.

I am rejecting this as insufficient. It improves dashboards but not rollback correctness.

### Option B: Evidence Settlement Cells and Promotion Certificates

Create a settlement layer that materializes evidence per failure domain and issues an Evidence Certificate before a
promotion can proceed. Each cell owns one domain, such as schedule execution, storage materialization, controller
authority, database/schema, or Torghut hypothesis profitability. A promotion decision consumes the certificates and
records its rollback target.

Pros:

- Converts partial health facts into durable, testable contracts.
- Gives deployers one object to inspect before promotion.
- Makes stale schedules, missing ConfigMaps, PVC readiness, migration consistency, and Torghut hypothesis gates part of
  the same decision model.
- Enables narrow rollback: a failed schedule cell can quarantine schedules without freezing all Jangar serving; a failed
  Torghut hypothesis cell can demote a hypothesis without blocking unrelated service recovery.
- Creates long-term option value for autonomous engineer/deployer stages.

Cons:

- Requires new CRD or database-backed certificate objects.
- Adds implementation complexity and new lifecycle rules.
- Needs strict anti-entropy jobs to prevent certificate drift.

I am choosing this option because it attacks the failure mode shown by the evidence: healthy surfaces with unsettled
execution truth.

### Option C: Split Controllers into Hard Failure Domains First

Before adding settlement, split Schedule, Workspace, Swarm, and Torghut integration controllers into separate
deployments with separate leases, RBAC, and rollout windows.

Pros:

- Strong blast-radius reduction.
- Makes readiness and rollout ownership clearer.
- Reduces the chance that one controller loop masks another.

Cons:

- It still leaves evidence spread across live reads.
- It can increase operational surface area before the promotion contract is ready.
- It does not directly improve Torghut profitability gates.

I am not choosing this as the primary move, but it becomes a Phase 2 implementation detail once certificates identify
the highest-churn cells.

## Chosen Architecture

### 1) Evidence Settlement Cells

Introduce a small set of named cells. Each cell publishes a certificate with:

- `cell`: stable cell name.
- `subject`: namespace/kind/name or Torghut hypothesis id.
- `producerRevision`: controller or service revision that produced the evidence.
- `observedAt` and `freshUntil`.
- `inputs`: resource versions, run ids, artifact refs, migration names, data windows, and image digests.
- `decision`: `allow`, `hold`, `quarantine`, or `rollback`.
- `reasonCodes`: stable machine-readable reasons.
- `rollbackTarget`: previous revision, previous capital stage, or prior schedule generation.
- `evidenceRef`: durable pointer to the materialized evidence payload.

Initial cells:

- `controller-authority`: leader election, rollout health, controller heartbeat, watch reliability.
- `schedule-materialization`: Schedule, ConfigMap template, CronJob, child run creation, and child run status.
- `storage-materialization`: Workspace, PVC phase, consuming run volume references, and TTL behavior.
- `database-schema`: Jangar migration consistency, required extensions, Torghut Postgres migration graph, and ClickHouse
  freshness probe.
- `swarm-stage`: pending requirements, stage freshness, stage failure budget, and current freeze state.
- `torghut-hypothesis-revenue`: hypothesis state, signal freshness, empirical job recency, TCA slippage, promotion
  eligibility, and rollback requirement.

The first implementation can store certificates in Jangar Postgres and expose them through the existing
control-plane status endpoint. A CRD can follow if deployer workflows need native Kubernetes watches.

### 2) Promotion Certificate

Promotion is a separate certificate that consumes cell certificates. It must include:

- the exact candidate being promoted,
- the certificates consumed by digest,
- the failure-domain budget consumed,
- the acceptance gates that passed,
- the rollback target,
- the operator or automation identity,
- the expiry time.

If any required cell certificate is missing, stale, or in `hold`, the promotion certificate is not issued. Deployer
automation must treat absence as a block, not a warning.

### 3) Schedule and Storage Settlement

Schedule promotion must no longer stop at CronJob existence. The schedule cell should settle:

1. The Schedule generation and spec hash.
2. The ConfigMap template name, resourceVersion, and hash of `run.json`.
3. The CronJob generation and service account used.
4. The child run id generated by the schedule runner.
5. The child pod volume materialization result, including every generated ConfigMap and PVC.
6. The child run terminal phase and artifact pointer.

A missing generated ConfigMap, like the warning events observed in `agents`, becomes a `quarantine` decision for that
schedule cell. It should not require freezing Jangar serving or all Torghut operation.

Storage settlement must bind Workspace/PVC state to the run that consumed it. A PVC being `Bound` is not sufficient if
the consuming run cannot mount its inputs.

### 4) Torghut Hypothesis Revenue Governor

Torghut's current status already knows that active hypotheses are not ready for promotion. The missing step is turning
that into a first-class control-plane certificate.

For each hypothesis, the revenue cell settles:

- hypothesis id and version,
- capital stage and capital multiplier,
- signal freshness and market-session context,
- empirical jobs and their recency,
- TCA metrics against the hypothesis budget,
- promotion eligibility,
- rollback requirement,
- latest materialized evidence artifact refs.

The first revenue governor rule set:

- No hypothesis can move from shadow to canary if empirical jobs are stale.
- No canary can scale if `avg_abs_slippage_bps` exceeds the hypothesis budget.
- No live capital is expanded when `signal_lag_seconds` exceeds the entry contract outside explicitly classified
  market-closed windows.
- No LLM influence is enabled when rollout checks include evidence-missing or stage/fail-mode violations.
- Live-mode configuration is informational unless the capital-stage certificate says live capital is allowed.

This directly addresses the current Torghut evidence: `mode: live` exists, but hypothesis capital remains shadow,
promotion eligible is 0, stale empirical jobs are present, and TCA slippage is far outside the 8 to 12 bps budgets.

### 5) Anti-Entropy and Expiry

Certificates must expire. A certificate that does not expire is just another stale status row.

Anti-entropy jobs should periodically compare:

- live Kubernetes resources,
- Jangar Postgres certificates,
- Torghut Postgres hypothesis rows,
- ClickHouse freshness,
- object-store artifact refs.

When drift is detected, the job emits a new certificate with `decision: hold` or `quarantine`. It does not mutate the
underlying workload directly. Mutation remains the deployer stage's job.

## Implementation Scope

Engineer stage should implement this in four increments.

### Increment 1: Certificate Model and Read API

Add Jangar persistence for evidence certificates:

- table keyed by `cell`, `subject_kind`, `subject_ref`, `producer_revision`, and `idempotency_key`,
- JSON payload for inputs and reason details,
- indexed `decision`, `fresh_until`, and `created_at`,
- digest of the canonical payload,
- read endpoint under the control-plane status surface.

Acceptance gates:

- Unit tests for canonical digest stability.
- Migration consistency test updated with the new migration.
- Status endpoint includes current and expired certificate counts.
- Expired required certificates block promotion by default.

### Increment 2: Schedule and Storage Cells

Add settlement for Schedule and Workspace/PVC paths:

- schedule template ConfigMap hash,
- CronJob generation,
- child run id,
- child run pod materialization status,
- missing ConfigMap and failed mount reason capture,
- PVC phase and consuming run volume references.

Acceptance gates:

- Regression test where a Schedule exists but its template ConfigMap is missing, producing `quarantine`.
- Regression test where a run references a required PVC but the PVC is not `Bound`, producing `hold`.
- Existing schedule runner syntax test remains green.
- No broad namespace freeze is triggered by one schedule cell quarantine.

### Increment 3: Torghut Hypothesis Revenue Governor

Add the revenue cell using existing Torghut status and governance data:

- consume hypothesis readiness, empirical job freshness, TCA, signal freshness, and LLM rollout checks,
- issue per-hypothesis certificates,
- expose a compact summary in Jangar control-plane status,
- keep Torghut database writes in Torghut-owned code or explicit import scripts.

Acceptance gates:

- Unit test with stale empirical jobs blocks promotion.
- Unit test with slippage above budget blocks canary scale-up.
- Unit test with live mode enabled but shadow capital returns `hold`, not `allow`.
- Integration or mocked endpoint test for Jangar consuming Torghut revenue certificates.

### Increment 4: Promotion Certificate and Deployer Gate

Add promotion certificates and wire the deployer stage to require them:

- fail closed when required cells are missing or expired,
- record rollback target,
- publish the certificate digest in NATS handoff and PR/rollout audit artifacts,
- allow emergency manual override only with an explicit incident id and rollback owner.

Acceptance gates:

- Deployer dry run fails when any required certificate is stale.
- Rollback rehearsal demotes one Torghut hypothesis without rolling back Jangar serving.
- Jangar rollout can proceed when Torghut revenue cells are `hold` but not required for a Jangar-only serving fix.
- Cross-cell dependency reasons are visible in the status endpoint.

## Rollout Plan

Rollout must be staged and reversible.

Stage 0: Shadow certificates

- Produce certificates but do not block promotion.
- Compare decisions with current status endpoint behavior for at least 48 hours or 10 scheduled runs, whichever is
  longer.
- Alert on disagreement but do not mutate workloads.

Stage 1: Block only obviously stale or missing evidence

- Block promotions when a required certificate is missing, expired, or explicitly `quarantine`.
- Keep Torghut revenue governor in shadow for capital expansion decisions.
- Keep schedule quarantine local to the schedule subject.

Stage 2: Enforce Torghut hypothesis promotion

- Require revenue certificates before canary or live capital expansion.
- Keep shadow capital allowed for research candidates when evidence is stale.
- Require fresh empirical jobs before any promotion above shadow.

Stage 3: Split high-churn cells

- If certificate telemetry shows controller-level contention, split schedule, workspace, and Torghut integration loops
  into independent deployments and leases.
- Use certificate drift as the evidence for which split is worth the operational surface area.

## Rollback Plan

Rollback is certificate-driven:

- If certificate generation fails, disable enforcement and keep shadow emission enabled.
- If schedule settlement falsely quarantines healthy schedules, disable the schedule cell enforcement flag and retain
  control-plane rollout gates.
- If revenue governor falsely blocks all Torghut hypotheses, keep trading in shadow capital and disable only the
  promotion enforcement flag.
- If a promoted service revision causes readiness or migration regression, roll back to the previous image digest and
  issue a replacement promotion certificate that records the rollback.
- If certificate storage migration fails, revert the migration through the normal Jangar migration rollback path before
  enabling enforcement.

No rollback path should require deleting historical certificates. Bad certificates must be superseded by newer
certificates so the incident remains auditable.

## Risks and Tradeoffs

The main risk is complexity. Certificates add another durable layer and a new source of stale data if expiry and
anti-entropy are weak. That is why expiry and anti-entropy are part of the core design, not follow-up polish.

The second risk is over-blocking. If every degraded Torghut revenue cell blocks every Jangar rollout, we recreate a
global freeze. The mitigation is scoped requirements: Jangar serving promotions require controller, schedule, storage,
and database cells; Torghut capital promotions additionally require revenue cells.

The third risk is latency. The quant health route timed out in this assessment, so enforcement must not depend on a
slow fan-out request at deployment time. Certificates should be precomputed and read cheaply.

The fourth risk is authority confusion. Torghut owns trading state and Jangar owns control-plane promotion. The revenue
governor must not make Torghut database writes from Jangar unless the ownership boundary is explicitly changed. The
first version can consume Torghut status and expose Jangar certificates without mutating Torghut trading rows.

## Validation Gates

Required local checks for engineer PRs:

- `bun run --cwd services/jangar test -- supporting-primitives-controller`
- `bun run --cwd services/jangar test -- control-plane-status`
- `bun run --cwd services/jangar test -- torghut-quant-metrics`
- `uv run --frozen pytest services/torghut/tests/test_strategy_hypothesis_governance_migration.py`
- `uv run --frozen pytest services/torghut/tests/test_governance_policy_dry_run.py`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.json`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.alpha.json`
- `uv run --frozen pyright --project services/torghut/pyrightconfig.scripts.json`

Required cluster validation for deployer stage:

- Jangar status reports database connected and migration consistency healthy.
- Agents namespace has no new missing generated ConfigMap warnings for the promoted schedule cell.
- Schedule certificates exist for all enabled `jangar-control-plane` stage schedules and are fresh.
- Storage certificates exist for every required Workspace/PVC subject and are fresh.
- Torghut revenue certificates report 0 promotion eligible when empirical jobs are stale.
- A synthetic stale empirical job fixture blocks canary promotion.
- A rollback rehearsal produces a superseding certificate with the prior revision or prior capital stage.

## Handoff Contract

Engineer stage receives this contract:

- Implement the certificate table, canonical digest, read API, and shadow producers first.
- Add schedule/storage settlement before enforcing any deployer block.
- Add Torghut revenue certificates as read-only Jangar consumers of Torghut status unless a separate Torghut-owned
  migration is part of the PR.
- Prove the missing ConfigMap and stale empirical job cases with regression tests.

Deployer stage receives this contract:

- Do not promote based only on pod readiness or live-mode configuration.
- Require fresh certificates for the cells relevant to the deployment subject.
- Keep Torghut revenue enforcement scoped to capital promotion, not every Jangar serving fix.
- Roll back by issuing superseding certificates and reverting the workload revision or capital stage.

## References

- `services/jangar/src/server/supporting-primitives-controller.ts`
- `services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts`
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `services/jangar/src/server/__tests__/torghut-quant-metrics.test.ts`
- `services/torghut/app/trading/autonomy/lane.py`
- `services/torghut/migrations/versions/0021_strategy_hypothesis_governance.py`
- `docs/agents/designs/73-jangar-evidence-settlement-and-runtime-freshness-leases-2026-05-05.md`
- `docs/agents/designs/72-jangar-materialized-run-proof-and-storage-backed-admission-contract-2026-05-05.md`
- `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
