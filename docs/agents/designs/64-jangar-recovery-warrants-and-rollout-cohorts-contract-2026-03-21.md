# 64. Jangar Recovery Warrants and Rollout Cohorts Contract (2026-03-21)

Status: Approved for implementation (`discover`)
Date: `2026-03-21`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/63-torghut-opportunity-books-and-evidence-drift-warrants-contract-2026-03-21.md`

Extends:

- `63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`
- `62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`
- `61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md`
- `60-jangar-recovery-ledger-and-consumer-attestation-contract-2026-03-20.md`

## Executive summary

The decision is to stop treating stale-freeze release as an incidental side effect of healthy-enough controllers and to
make it depend on two durable control-plane objects: **Recovery Warrants** and **Rollout Cohorts**.

The reason is current live evidence, not preference:

- `kubectl -n agents get swarm jangar-control-plane torghut-quant -o json`
  - at `2026-03-21T00:15Z` still reports both swarms `phase="Frozen"` and `type=Frozen status=True`;
  - still shows `freeze.until` values of `2026-03-11T16:36:12.630Z` and `2026-03-11T16:36:17.456Z`;
  - still shows last successful stage activity on `2026-03-08`.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents&window=15m`
  - at `2026-03-21T00:15:26Z` reports `agents-controllers` healthy `2/2`, workflow and job runtimes available, and
    rollout health healthy;
  - still reports `execution_trust.status="degraded"` because both swarms remain on unreconciled `StageStaleness`
    freezes and `jangar-control-plane.requirements_pending=5`.
- `kubectl -n agents get events --sort-by=.lastTimestamp | tail -n 20`
  - still records an `agents-controllers` readiness failure at `2026-03-21T00:07Z`;
  - also proves the rollout recovered within minutes.
- `GET http://torghut-00156-private.torghut.svc.cluster.local:8012/trading/health`
  - at `2026-03-21T00:15:42Z` still returns HTTP `503`;
  - still reports `quant_evidence.reason="quant_health_fetch_failed"`;
  - still points `quant_evidence.source_url` at the generic Jangar status route instead of the typed quant route.

The tradeoff is more additive state, one more compiler, and stricter rollout evidence. I am keeping that trade because
the next expensive failure mode is not "Jangar is down." It is "Jangar recovered enough to look healthy, but stale
authority still freezes the wrong consumers and leaks rollout ambiguity into Torghut."

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Jangar
  resilience/reliability, safer rollout behavior, and Torghut profitability

This artifact succeeds when:

1. stale swarm freezes can only remain active while one current recovery warrant says they should remain active;
2. controller replica recovery, runtime-kit completeness, and consumer admission become separate facts instead of one
   broad route-time reduction;
3. Torghut can bind to one typed Jangar recovery warrant without re-reading the full generic status payload;
4. rollout promotion and rollback decisions prove cohort freshness and warrant parity before unfreezing downstream
   consumers.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The live system now shows a sharper problem than it did on March 20: rollout health recovered, but stale authority did
not.

- raw swarm CRDs in `agents`
  - still publish overdue freeze deadlines from March 11, 2026;
  - still publish last successful discover/plan/implement/verify runs from March 8, 2026;
  - still leave both swarms frozen even after controller rollout recovery.
- Jangar control-plane status
  - reports the control-runtime cohort healthy again by `2026-03-21T00:15:26Z`;
  - reclassifies the swarms as `phase="Recovering"` while the raw CRDs still say `Frozen`;
  - proves two different projections are already interpreting the same stale truth differently.
- `agents-controllers` events
  - prove readiness actually flapped during this assess run;
  - prove the control plane can recover quickly while stale freeze truth remains unchanged.

Interpretation:

- Jangar needs one explicit object that says whether freeze release is earned now, not whether it might be inferred
  from recovered replicas;
- rollout safety is currently ahead of recovery safety;
- the control-plane authority gap is now between fresh rollout facts and stale freeze facts.

### Source architecture and high-risk modules

The highest-risk source hotspots are exactly where projection truth and release behavior diverge.

- `services/jangar/src/server/control-plane-status.ts`
  - can derive controller and workflow availability from rollout health;
  - still has no durable object that binds recovered rollout state to freeze-release eligibility or downstream consumer
    admission.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - still keeps unfreeze scheduling in the process-local `swarmUnfreezeTimers` map;
  - that makes freeze repair behavior runtime-local instead of durable and replayable.
- `services/jangar/src/routes/ready.tsx`
  - still exposes serving truth without forcing the same release evidence Torghut and deploy verification need;
  - cannot cite one recovery warrant id today.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - validates rollout and digest parity;
  - does not validate that the recovered rollout cohort and the consumer-facing recovery warrant agree.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`
  - already provides the right typed consumer shape;
  - still depends on broader Jangar truth that does not separate stale-freeze release from control-runtime recovery.

Architectural test gaps:

- no regression proves a recovered `agents-controllers` rollout does not automatically thaw a stale March 11 freeze;
- no parity test proves raw swarm CRDs, `/ready`, typed Torghut quant health, and deploy verification cite the same
  recovery warrant;
- no regression proves one degraded cohort can keep Torghut admission blocked while `serving-fast` stays healthy.

### Database, schema, freshness, and consistency evidence

The database is not the limiting factor. The authority model is.

- Jangar control-plane status reports `database.status="healthy"` and `24/24` migrations applied;
- the same status payload reports fresh watch-stream and workflow data, so the system already has enough facts to
  compile better release truth;
- this workspace cannot `pods/exec` into Jangar or Torghut database pods, which is acceptable because the fix is not
  broader operator reach. The fix is additive persisted recovery evidence.

Interpretation:

- Jangar already has enough durable state to own recovery warrants;
- the missing piece is a compiler and an explicit cohort model, not more raw data collection.

## Problem statement

Jangar still has five resilience-critical gaps:

1. rollout recovery and freeze release are related but not equivalent, yet the control plane still lets them drift;
2. raw CRD truth and route-level projections can disagree on whether a swarm is frozen or recovering;
3. process-local unfreeze timers remain a hidden dependency for stale-freeze repair;
4. downstream consumers, especially Torghut, still cannot bind to one replayable recovery object;
5. deploy verification can prove digests and replicas, but not that the right downstream cohorts are safe to thaw.

That is not sustainable for the next six months. The system needs an explicit release contract that survives process
restarts, rollout churn, and partial controller recovery.

## Alternatives considered

### Option A: keep consumer projections and latency classes, add more route caching

Pros:

- smallest code delta;
- likely reduces some transient timeout noise.

Cons:

- does not close the gap between raw freeze truth and recovered rollout truth;
- still leaves thaw eligibility implicit;
- still lets downstream consumers guess from broad route payloads.

Decision: rejected.

### Option B: make rollout health the sole freeze-release authority

Pros:

- simple operating model;
- easy to explain during deployment.

Cons:

- equates replica recovery with consumer safety;
- cannot express pending requirements or stale stage debt once replicas are back;
- would make Torghut trust a cheaper signal than it should.

Decision: rejected.

### Option C: recovery warrants plus rollout cohorts

Pros:

- separates recovered rollout, stale-freeze debt, and consumer admission cleanly;
- gives Torghut one typed recovery contract to consume;
- improves rollout safety because thawing now depends on parity, not optimism.

Cons:

- adds new additive persistence and compiler logic;
- requires shadow rollout before thaw enforcement can change.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will compile recovery warrants from raw swarm state, rollout cohorts, and execution evidence. Freeze release,
typed consumer admission, and deploy verification will consume those warrants instead of inferring thaw eligibility from
controller replicas or request-time reducers.

## Architecture

### 1. Recovery warrants

Add additive persistence:

- `control_plane_recovery_warrants`
  - `recovery_warrant_id`
  - `swarm_name`
  - `consumer_name` (`serving`, `interactive_status`, `torghut_quant`, `deploy_verify`, `handoff_huly`)
  - `projection_id`
  - `latency_class_admission_id`
  - `required_execution_receipt_ids_json`
  - `required_recovery_cell_ids_json`
  - `required_rollout_cohort_ids_json`
  - `raw_freeze_signature`
  - `decision` (`eligible`, `delay`, `blocked`, `shadow`)
  - `reason_codes_json`
  - `issued_at`
  - `fresh_until`
  - `warrant_digest`

Rules:

- a stale swarm freeze may only remain active while at least one current warrant still says `delay` or `blocked`;
- once the raw freeze deadline is in the past, a new warrant must either re-arm the freeze with fresh evidence or mark
  the freeze release as eligible;
- `/ready`, `/api/agents/control-plane/status`, the typed Torghut quant route, and deploy verification must surface
  the same current `recovery_warrant_id` when they are speaking for the same consumer.

### 2. Rollout cohorts

Add additive persistence:

- `control_plane_rollout_cohorts`
  - `rollout_cohort_id`
  - `cohort_name` (`agents_controller_core`, `jangar_serving`, `jangar_worker_handoff`, `torghut_quant_projection`)
  - `namespace`
  - `required_deployments_json`
  - `required_runtime_classes_json`
  - `required_routes_json`
  - `deployment_digest_set_hash`
  - `decision` (`healthy`, `degraded`, `blocked`, `shadow`)
  - `reason_codes_json`
  - `observed_at`
  - `fresh_until`

Rules:

- rollout cohorts are the smallest release domains Jangar will trust for downstream thaw;
- `agents_controller_core` may recover without automatically thawing `torghut_quant_projection`;
- `jangar_serving` may remain healthy while `jangar_worker_handoff` or `torghut_quant_projection` stays blocked;
- deploy verification must prove the target cohort digest hash matches the cohort cited by the latest recovery warrant.

### 3. Recovery compiler

Compile warrants in this order:

1. read raw swarm CRD facts and preserve the actual frozen/until values as source truth;
2. evaluate rollout cohorts from deployment state, runtime-kit state, and typed route health;
3. evaluate stale-freeze debt, pending requirements, and recovery-cell freshness;
4. emit one consumer-scoped recovery warrant with a bounded expiry.

Compiler invariants:

- route projections may no longer synthesize `Recovering` or `Healthy` without citing a warrant;
- no process-local timer may be the only source of thaw eligibility;
- a warrant compiled from healthy rollout but overdue freeze debt must still emit `delay`, not `eligible`.

### 4. Route and deploy behavior

- `/ready`
  - consumes only the `serving` recovery warrant and the `jangar_serving` cohort.
- `/api/agents/control-plane/status`
  - exposes both raw freeze facts and warrant/cohort ids;
  - never rewrites raw swarm truth silently.
- `/api/torghut/trading/control-plane/quant/health`
  - consumes the `torghut_quant` recovery warrant and `torghut_quant_projection` cohort only;
  - never falls back to the generic control-plane route for final recovery authority.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - must fail closed if the rollout cohort hash and recovery warrant digest do not match.

## Validation gates

Engineer stage acceptance gates:

1. Add regression coverage proving overdue freeze windows are not thawed by recovered controller replicas alone.
2. Add parity tests proving `/ready`, generic status, typed quant health, and deploy verification expose the same
   `recovery_warrant_id` when scoped to the same cohort.
3. Add a replay test proving process restart does not lose thaw eligibility because the compiler rehydrates from
   persisted warrants and cohorts.

Deployer stage acceptance gates:

1. `curl -sS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents&window=15m'`
   must show fresh `recovery_warrant_id` and `rollout_cohort_id` values for `torghut_quant` and `serving`.
2. `kubectl -n agents get swarm jangar-control-plane torghut-quant -o json | jq ...`
   must show raw freeze values either cleared or backed by a fresh warrant decision that explains why they remain.
3. `bun run --filter @proompteng/scripts verify-deployment -- --service jangar`
   must fail if warrant/cohort parity breaks and pass only when parity is current.

## Rollout plan

1. Add the new tables and compiler in shadow mode with no thaw-side effects.
2. Emit warrant and cohort ids on status surfaces and deploy verification while existing behavior remains unchanged.
3. Enable typed-consumer enforcement for Torghut quant and deploy verification.
4. Move freeze-release decisions to warrant-backed logic only after shadow parity is stable for one full weekday
   trading session.

## Rollback plan

If rollout introduces regressions:

1. disable warrant-backed thaw enforcement behind a feature flag;
2. keep the additive tables intact for auditability;
3. fall back to the current projection/admission paths while continuing to emit warrant records for diagnosis;
4. revert only the consumer binding logic, not the persisted evidence.

## Risks and open questions

- warrant churn could become noisy if fresh-until intervals are too short;
- deploy verification must stay fast enough that warrant parity does not create a slower release bottleneck;
- the compiler needs strict precedence rules when raw CRD truth and route projections disagree, or operators will lose
  confidence quickly.

## Handoff contract

Engineer handoff:

- implement the new additive tables and compiler under Jangar control-plane ownership;
- update the typed Torghut quant route, status route, and deploy verification to consume warrant/cohort ids;
- add the three regression suites listed in validation gates.

Deployer handoff:

- verify warrant/cohort ids on status and deploy surfaces before promotion;
- prove stale March 11 freezes are either released or justified by a fresh warrant with current timestamps;
- refuse promotion if Torghut still reads generic status-path authority for recovery-critical decisions.
