# 70. Jangar Evidence Epoch Admission and Rollout Quarantine (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Gideon Park (Torghut Traders architecture)
Scope: Jangar control-plane reliability, execution trust, runtime completeness, rollout quarantine, and downstream
consumer admission for Torghut quant.

Companion doc:

- `docs/torghut/design-system/v6/75-torghut-cross-plane-evidence-epochs-and-profit-cell-governor-2026-05-05.md`

Extends:

- `65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`
- `64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`
- `62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`
- `61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md`

## Executive Summary

The decision is to add a Jangar evidence epoch in front of rollout widening and stage launch. A serving pod, a
healthy database connection, and a partially available controller rollout are not enough authority to launch backlog or
fund Torghut quant work. The control plane needs one durable epoch that binds runtime kit completeness, stage receipts,
controller rollout state, image portability, dependency freshness, and downstream consumer acknowledgements.

I am not choosing a topology-first split. Splitting deployments may still be useful later, but it does not stop a
ready service from launching stale work with a missing runtime binary or from reporting green database state while
execution trust is degraded. The evidence from this run is exactly that shape of failure.

The tradeoff is stricter admission. Some work that could currently start will be quarantined until it can cite a fresh
evidence epoch. I am keeping that trade because the six-month risk is silent false confidence, not a noisy block.

## Runtime Inputs and Success Metrics

Mission inputs observed for this architecture lane:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarm: `torghut-quant`
- stage: `discover`
- channel: `general`

This design succeeds when:

1. `/ready`, `/api/agents/control-plane/status`, stage dispatch, deploy verification, and Torghut consumer routes cite
   the same active `evidence_epoch_id`.
2. `swarm_plan`, `swarm_implement`, and `swarm_verify` cannot launch when their required runtime kit is missing in the
   Jangar runtime image.
3. rollout widening is blocked or quarantined when controller rollout health, execution trust, dependency quorum, and
   runtime kit state disagree.
4. stale stage debt is assigned to a bounded recovery cell with an owner, retry budget, and retirement rule.
5. Torghut can consume one typed admission receipt instead of scraping multiple Jangar routes during hot-path trading
   checks.

## Assessment Evidence

All cluster and database assessment in this run was read-only.

### Cluster Health, Rollout, and Events

Observed commands and outcomes:

- `kubectl auth whoami`
  - identity: `system:serviceaccount:agents:agents-sa`
  - this is a constrained service account, which is the right default for architecture assessment.
- `kubectl get pods -n jangar -o wide`
  - `jangar-5fd4649d47-b5shm` is `2/2 Running`;
  - `jangar-db-1` is `1/1 Running`;
  - Open WebUI, Redis, Bumba, and Symphony pods are running.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status`
  - returns HTTP `200`;
  - reports `database.status="healthy"`;
  - reports `migration_consistency.registered_count=25`, `applied_count=25`, `unapplied_count=0`;
  - reports `execution_trust.status="degraded"`;
  - reports `rollout_health.status="degraded"` because `agents-controllers` has `ready=1`, `desired=2`;
  - blocks `swarm_plan`, `swarm_implement`, and `swarm_verify` passports on
    `runtime_kit_component_missing:nats_cli`;
  - blocks dependency quorum on `empirical_jobs_degraded`.
- `kubectl get pods -n agents | rg "(agents-|torghut-quant|jangar-control)"`
  - shows many older scheduled pods in `Error`;
  - shows current scheduled attempts running;
  - shows `agents-controllers-675b94fc46-5ncwz` as `0/1 Running` while another controller pod is `1/1`.
- `kubectl get events -n agents --sort-by=.lastTimestamp`
  - shows `BackoffLimitExceeded` for scheduled verify jobs;
  - shows `UnexpectedJob` warnings for hotfix cron jobs;
  - shows new scheduled work continuing to launch in the same namespace.

Interpretation:

- Jangar serving is available, but control-plane admission is not healthy.
- The system already computes several useful truth surfaces, but they do not collapse into one launch authority.
- The current status route can say "database healthy" and "execution trust degraded" in the same response, which is
  truthful but not yet decisive enough for rollout automation.

### Source Architecture and High-Risk Modules

Relevant source surfaces:

- `services/jangar/src/server/control-plane-status.ts`
  - already assembles controller health, database migration consistency, watch reliability, runtime kits, passports,
    rollout health, swarms, stages, workflow failures, dependency quorum, and empirical services;
  - this is the right source for evidence epoch projection.
- `services/jangar/src/server/torghut-quant-metrics-store.ts`
  - persists latest metrics, series metrics, alerts, and pipeline health under `torghut_control_plane`;
  - this proves Jangar already owns the data model needed for Torghut consumer receipts.
- `services/jangar/src/routes/ready.tsx`
  - separates serving readiness from promotion authority;
  - should keep serving available while emitting the active evidence epoch and degraded classes.
- `services/jangar/scripts/codex/codex-progress-comment.ts`
  - is the required PR progress-comment helper and should remain the visible implementation surface during rollout.

The high-risk source gap is not missing primitives. It is that the primitives are still recomputed per route and are
not sealed into one epoch receipt that launchers and consumers must share.

### Database, Schema, Freshness, and Consistency

Evidence:

- Jangar status reports a healthy configured database and `25/25` applied Kysely migrations.
- Direct database shell access is intentionally unavailable from this worker:
  - `kubectl cnpg psql -n torghut torghut-db ...` fails because `pods/exec` is forbidden;
  - `kubectl exec -n torghut ... clickhouse-client ...` also fails because `pods/exec` is forbidden.
- Memory retrieval through Jangar reset twice:
  - `http://jangar.jangar.svc.cluster.local/api/memories?...` returned `ECONNRESET`.

Interpretation:

- The design must not depend on privileged direct database reads in deploy verification.
- The control plane should publish compact, typed receipts that are safe for constrained workers and downstream
  consumers to read.
- Memory and collaboration reliability belong inside the runtime kit and evidence epoch, not as best-effort side
  channels.

## Problem Statement

Jangar has useful status surfaces, but it still lets consumers and operators reason from partial truth:

1. a route can return HTTP `200` while execution trust is degraded;
2. a rollout can be mostly available while one controller replica is not ready;
3. a stage can keep launching attempts while older attempts remain in error/backoff;
4. a runtime kit can be complete in an assessment pod but missing in the Jangar runtime image;
5. Torghut can ask for quant authority and receive a timeout instead of a durable admission decision.

That is a reliability problem because the failure is not always an outage. It is worse: different surfaces are each
partly true, and no one object decides whether launch, rollout, or downstream capital authority is allowed.

## Alternatives Considered

### Option A: Split Controller Topology First

Summary:

- Add more Jangar deployments and isolate controller roles before changing admission authority.

Pros:

- narrows CPU, memory, and pod-failure domains;
- may reduce noisy readiness interactions between serving and controller work.

Cons:

- does not solve stale stage debt;
- does not prove runtime completeness before launch;
- does not give Torghut one durable authority receipt;
- increases rollout complexity before fixing launch semantics.

Decision: rejected for this phase.

### Option B: Tighten Existing Health Thresholds

Summary:

- Keep the current status and readiness architecture, but make thresholds stricter.

Pros:

- smaller implementation surface;
- can catch some obvious failure modes quickly.

Cons:

- keeps truth route-local and request-time;
- can still produce disagreements between `/ready`, status, dispatch, and deploy verification;
- tends to create global blocks instead of class-local quarantine.

Decision: rejected.

### Option C: Evidence Epoch Admission

Summary:

- Seal one evidence epoch for each control-plane execution class.
- Bind controller rollout, runtime kit, dependency quorum, stage freshness, workflow failures, and consumer
  acknowledgements into one durable receipt.
- Launch and rollout widening consume the receipt instead of recomputing trust.

Pros:

- directly addresses the observed mismatch between serving, rollout, runtime, and execution trust;
- gives deployers and Torghut one compact authority object;
- allows class-local quarantine instead of global optimism or global shutdown;
- preserves later topology changes as an implementation detail.

Cons:

- adds additive persistence and receipt projection work;
- requires deploy verification and dispatch to adopt a new contract before enforcement.

Decision: selected.

## Decision

Adopt Option C.

Jangar will produce an `EvidenceEpoch` for each execution class:

- `serving`
- `collaboration`
- `swarm_discover`
- `swarm_plan`
- `swarm_implement`
- `swarm_verify`
- `torghut_quant_consumer`

Each epoch carries:

- `evidence_epoch_id`
- `execution_class`
- `producer_revision`
- `runtime_kit_digest`
- `controller_rollout_digest`
- `stage_receipt_digest`
- `dependency_quorum_digest`
- `workflow_failure_digest`
- `consumer_ack_digest`
- `decision`: `allow`, `degrade`, `quarantine`, or `block`
- `reason_codes`
- `issued_at`
- `fresh_until`

The important rule is simple: launchers and rollout automation do not infer. They consume the epoch decision.

## Implementation Scope

Engineer scope:

1. Add additive persistence for evidence epochs and class-local quarantine state.
2. Extend `control-plane-status` to emit the active epoch per execution class.
3. Extend `/ready` to keep serving readiness separate while projecting the serving epoch id.
4. Update stage dispatch to require an `allow` epoch for launchable classes and a `degrade` epoch only where the
   runtime explicitly supports degraded mode.
5. Update deploy verification to compare `/ready`, status, and rollout observation against the same epoch id.
6. Make runtime kit checks evaluate the actual Jangar runtime image, not only the worker environment that happened to
   run assessment.
7. Emit Torghut consumer receipts that include quant-health freshness and dependency quorum state without requiring
   Torghut to issue remote hot-path fetches.

Non-goals:

- no direct database mutation from deploy verification;
- no cluster-admin dependency for normal checks;
- no replacement of existing runtime kits or admission passports in the first implementation wave.

## Validation Gates

Required local and CI checks for implementation:

1. Unit tests for epoch decision building:
   - degraded execution trust produces class-local `quarantine` or `block`;
   - missing `nats` in the runtime image blocks collaboration-dependent classes;
   - healthy serving can remain `degrade` while swarm launch is `block`.
2. Route tests for `/ready` and `/api/agents/control-plane/status`:
   - both routes expose the same active serving epoch id;
   - status exposes a per-class epoch list;
   - no route silently drops `reason_codes`.
3. Deploy verification smoke:
   - fails when status and `/ready` cite different epoch ids;
   - fails when rollout health is green but launch epoch is unsealed;
   - passes when all required classes cite fresh `allow` epochs.
4. Runtime image validation:
   - verifies `/usr/local/bin/codex-nats-publish`, `/usr/local/bin/codex-nats-soak`, and `nats` inside the Jangar
     runtime image used by scheduled work.
5. Torghut consumer validation:
   - quant authority reads a typed receipt and does not time out the hot path when Jangar is reachable but degraded.

## Rollout Plan

Wave 1: shadow compile.

- Build evidence epochs from existing status ingredients.
- Emit them in status only.
- Compare epoch decisions to existing passports and record mismatches.

Wave 2: deploy verification parity.

- Make deploy verification read the epoch id from `/ready` and status.
- Keep enforcement warning-only.
- Alert on mismatched epoch ids or expired epochs.

Wave 3: class-local quarantine.

- Block new stage launches for classes with `block` epochs.
- Quarantine stale stage debt with bounded retry budgets.
- Keep serving available when its serving epoch is `degrade` rather than `block`.

Wave 4: Torghut consumer admission.

- Publish a Torghut quant consumer receipt.
- Require Torghut promotion and non-observe capital checks to cite the receipt.
- Keep observe-only diagnostics available during Jangar degradation.

## Rollback Plan

Rollback must preserve safety:

1. Disable enforcement by feature flag and keep shadow epoch projection active.
2. Treat all missing or expired epochs as `block` for launch and promotion, not `allow`.
3. Leave existing admission passports in place as the fallback authority for serving only.
4. Do not reopen quarantined backlog automatically; require explicit reseat or supersede.
5. Roll forward by repairing the epoch compiler or runtime kit validation rather than deleting evidence rows.

## Risks and Mitigations

- Risk: the epoch compiler becomes another monolithic status route.
  - Mitigation: keep it a pure compiler over already collected facts, then persist compact receipts.
- Risk: class-local quarantine blocks too much work at first.
  - Mitigation: shadow mode first, then enforce only after parity evidence is stable.
- Risk: runtime-kit validation checks the wrong environment.
  - Mitigation: validate inside the scheduled-work image and record the image digest in the epoch.
- Risk: Torghut over-trusts Jangar receipt freshness.
  - Mitigation: every receipt has `fresh_until`; expired receipts block non-observe capital.

## Handoff to Engineer and Deployer

Engineer acceptance gates:

- Additive schema and route changes only in the first wave.
- Tests prove class-local `allow/degrade/quarantine/block` decisions.
- Status, `/ready`, and deploy verification agree on epoch ids.
- Scheduled-work image validation catches missing `nats`.

Deployer acceptance gates:

- Shadow epochs are visible for at least one rollout cycle.
- No rollout widening when the active launch epoch is unsealed.
- Quarantined backlog is listed with owner, reason, retry budget, and retirement rule.
- Torghut quant consumer receipts are fresh before any non-observe promotion path is enabled.
