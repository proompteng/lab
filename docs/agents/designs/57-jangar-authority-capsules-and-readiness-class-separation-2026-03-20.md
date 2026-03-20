# 57. Jangar Authority Capsules and Readiness-Class Separation (2026-03-20)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Related mission: `codex/swarm-jangar-control-plane-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`

Extends:

- `54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`
- `55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`
- `56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`
- `51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`

## Executive summary

The decision is to stop letting Jangar compute rollout authority inside request handlers and to replace it with
durable **Authority Capsules** plus explicit **readiness classes**. The `agents` deployment should become ready when it
can safely serve the control-plane API, while promotion, deploy verification, and Torghut profitability consumers
should read a separate capsule class that can remain blocked without deadlocking rollout.

The reason is visible in the live state on `2026-03-20`:

- `kubectl describe pod -n agents agents-679c868658-n2gsn`
  - shows the new `agents` pod has been failing the `/ready` probe for about 12 hours with `HTTP probe failed with
    statuscode: 503`
- `kubectl describe pod -n agents agents-controllers-5c4b57cf57-mgwv8`
  - shows the new `agents-controllers` pod is failing the same readiness contract for the same period
- `curl -sS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - reports `database.status="healthy"`
  - reports `watch_reliability.status="healthy"`
  - reports `rollout_health.status="degraded"`
  - reports `execution_trust.status="blocked"`
  - reports `swarms[0].name="jangar-control-plane"` with `phase="Recovering"` but `updated_at="2026-03-11T15:48:11.742Z"`
- `kubectl get swarm -n agents jangar-control-plane -o yaml`
  - shows `status.freeze.reason=StageStaleness`
  - shows `status.freeze.until=2026-03-11T16:36:12.630Z`
  - shows stale stage timestamps from `2026-03-08`
- `curl -sS http://agents.agents.svc.cluster.local/ready`
  - returns `200` from the old ready pod
  - proves the rollout is deadlocked by readiness on the new pods, not by total service loss

The tradeoff is more persisted control-plane state, another compiler loop, and stricter deploy gates. That is the
correct trade. The expensive failure mode is not extra state; it is letting stale authority freeze new rollouts while
operators manually reconcile which endpoint is telling the truth.

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
3. a stale or contradictory promotion state can no longer make a fresh control-plane rollout fail readiness;
4. engineer and deployer stages receive explicit validation, rollout, and rollback contracts.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The live cluster is not simply "healthy" or "broken". It is split across two authority classes:

- serving capacity still exists because the old `agents` and `agents-controllers` pods remain ready and routable;
- the new rollout is blocked because `/ready` on the new pods is coupled to execution-trust evaluation;
- the execution-trust blocker is not a database outage or watch-stream outage;
- it is stale swarm and requirements truth that remained unreconciled after the freeze window expired.

This matters because the system currently pays the wrong price for the wrong failure:

- a stale promotion state blocks a fresh binary rollout;
- rollout deadlock then hides whether the new build is actually safe to serve;
- deployers are forced to choose between rollback and manual trust-gate narrowing without one durable authority object.

### Source architecture and high-risk modules

The source tree matches the live contradiction:

- `services/jangar/src/routes/ready.tsx`
  - computes readiness by calling `buildExecutionTrust(...)` at request time;
  - returns `503` whenever execution trust is not `healthy`;
  - therefore couples pod readiness directly to stale swarm and downstream authority.
- `services/jangar/src/server/control-plane-status.ts`
  - already knows how to compute `rollout_health`, `execution_trust`, `watch_reliability`, and `empirical_services`;
  - still exposes them as one summary payload rather than one durable capsule id that all consumers must reuse.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - still relies on process-local `swarmUnfreezeTimers`;
  - that is useful for liveness, but not sufficient as durable authority after controller restarts or delayed
    reconciliation.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - verifies Argo health, rollout state, and digests;
  - does not verify that runtime authority and rollout authority share the same compiled result.

Current missing regression coverage:

- no test proving a blocked promotion capsule does not make `serving` readiness fail when serving dependencies are
  healthy;
- no test proving expired freeze state is published as stale authority instead of blocking pod readiness directly;
- no test proving `/ready`, `/api/agents/control-plane/status`, `Swarm.status`, and deploy verification share a capsule
  id and digest;
- no test proving the old request-time execution-trust path can be removed without losing explicit blocker reasons.

### Database and data continuity evidence

The database is not the bottleneck. Authority publication is.

- `curl -sS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - reports `database.connected=true`
  - reports `database.latency_ms=3`
  - reports `migration_consistency.applied_count=24`
  - reports `migration_consistency.unapplied_count=0`
- direct CNPG inspection remains RBAC-limited for this worker:
  - `kubectl get cluster -A` is forbidden
  - `kubectl cnpg psql ...` is not available without `pods/exec`

Interpretation:

- Jangar already has a healthy persistence substrate for additive authority state;
- the missing primitive is one durable representation of "what authority did we trust for this rollout epoch?"

## Problem statement

Jangar still has four reliability-critical gaps:

1. pod readiness and promotion authority are computed from the same request-time trust check;
2. stale swarm or requirements truth can therefore deadlock a fresh rollout;
3. deploy verification can disagree with runtime authority because it does not consume the same durable object;
4. downstream systems such as Torghut cannot tell whether a failure is "do not serve" or "serve, but do not promote".

That reduces resilience and it reduces future option value. Every new consumer is forced to either call Jangar at
request time or re-derive truth from partial signals.

## Alternatives considered

### Option A: keep request-time execution trust and only repair stale freeze state faster

Summary:

- retain the current `/ready` contract;
- add better stale-freeze reconciliation and more aggressive unfreeze repair.

Pros:

- smallest code delta;
- easiest near-term patch;
- preserves current endpoint semantics.

Cons:

- keeps serving readiness coupled to promotion truth;
- still makes rollout health dependent on live cross-surface fetches;
- does not give deployers or Torghut one durable authority artifact.

Decision: rejected.

### Option B: relax `/ready` and treat trust issues as warnings during rollout

Summary:

- keep current status computation;
- stop blocking readiness on execution trust during rollout.

Pros:

- unblocks deadlocked rollouts quickly;
- avoids a large schema change.

Cons:

- removes a safety gate without replacing it with a stronger authority primitive;
- risks the opposite failure mode, where consumers treat a rollout-ready pod as promotion-ready;
- still leaves deploy verification and Torghut on independent truth paths.

Decision: rejected.

### Option C: authority capsules plus readiness-class separation

Summary:

- compile durable authority capsules in the control-plane database;
- define separate `serving`, `control`, and `promotion` readiness classes;
- require all consumers to bind to capsule ids instead of recomputing trust.

Pros:

- removes rollout deadlock caused by stale promotion state;
- preserves fail-closed promotion behavior;
- gives deployers and Torghut one durable authority source;
- cleanly extends to future consumers and failure domains.

Cons:

- adds schema, compiler, and migration work;
- requires temporary dual-read cutover and parity tests.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar should expose one compiled authority graph, not one request-time trust calculation. Serving readiness must answer
"can this pod safely serve the control-plane API?" Promotion authority must answer "may this rollout or downstream
consumer advance?" Those are different questions and they need different contracts.

## Proposed architecture

### 1. Authority capsule ledger

Add additive persistence in `agents_control_plane`:

- `authority_capsules`
  - `capsule_id`
  - `capsule_class` in `{serving, control, promotion}`
  - `subject_kind`
  - `subject_ref`
  - `decision` in `{healthy, hold, block, unknown}`
  - `observed_at`
  - `fresh_until`
  - `rollout_epoch`
  - `evidence_digest`
  - `reason_codes_json`
  - `evidence_refs_json`
  - `producer_identity`
- `authority_capsule_events`
  - immutable append-only history of `published`, `staled`, `recovered`, `superseded`, and `expired`

Capsules are keyed by rollout epoch and subject so they can be reused by:

- `agents` pod readiness
- `agents-controllers` readiness
- `/api/agents/control-plane/status`
- `Swarm.status`
- deploy verification
- Torghut capability consumers

### 2. Readiness classes

Define three explicit classes:

- `serving`
  - used by Kubernetes readiness probes for `agents` and `agents-controllers`;
  - depends on local process health, leader-election sanity, database reachability, and at least one available serving
    replica during split rollouts;
  - does not block on stale promotion evidence.
- `control`
  - used by operator status views;
  - includes watch reliability, workflow health, swarm state, and capsule compiler freshness.
- `promotion`
  - used by deploy verification and downstream consumers;
  - blocks on stale swarm freeze, requirements degradation, empirical blockers, and downstream receipt mismatches.

`/health` remains liveness. `/ready` becomes the `serving` class. `/api/agents/control-plane/status` must expose all
three class decisions plus the active capsule ids.

### 3. Capsule compiler and repair loop

Move stale-freeze repair out of request handlers and into a dedicated compiler:

- read Swarm, workflow, rollout, heartbeat, and empirical evidence;
- reconcile expired freeze windows into capsule state;
- publish new capsule rows only when the evidence digest changes;
- emit one stale-capsule reason instead of thousands of readiness probe failures.

`swarmUnfreezeTimers` can remain as a liveness optimization, but not as the authority source.

### 4. Consumer binding

Every consumer must declare the capsule class and subject it requires:

- `packages/scripts/src/jangar/verify-deployment.ts`
  - must require `serving` healthy for rollout completion;
  - must require `promotion` parity for control-plane changes that affect downstream authority;
  - must fail when capsule ids or digests disagree between Jangar status and rollout verification.
- `Swarm.status`
  - must project the current `promotion` capsule id and decision for each stage.
- Torghut
  - must consume `promotion` or typed capability capsules rather than request-time Jangar summaries.

### 5. Failure-domain rules

Explicit rules:

- `serving=healthy`, `promotion=block` is valid and expected during degraded evidence windows;
- a stale or unknown promotion capsule must hold rollout advancement, not pod serving;
- only loss of `serving` capsule health should fail Kubernetes readiness.

## Validation gates

Engineer stage must satisfy all of the following:

1. Add schema and compiler tests for capsule publish, expiry, repair, and supersession.
2. Add readiness tests proving blocked promotion authority does not fail `serving` readiness when serving dependencies
   are healthy.
3. Add parity tests proving `/ready`, `/api/agents/control-plane/status`, `Swarm.status`, and deploy verification share
   capsule ids and digests.
4. Add regression coverage for stale freeze expiry and workflow-failure reconciliation after controller restart.

Deployer stage must satisfy all of the following:

1. During canary rollout, confirm new `agents` and `agents-controllers` pods become ready on the `serving` class even
   if `promotion` remains blocked.
2. Confirm `promotion` stays blocked with explicit capsule reasons while stale swarm or downstream blockers persist.
3. Confirm rollout verification fails when capsule digest parity is broken.
4. Confirm rollback removes the capsule-aware gate cleanly without leaving stale rows as active authority.

## Rollout plan

1. Land the capsule schema and compiler behind shadow mode.
2. Publish capsule ids in status payloads while leaving current readiness logic in place for one release.
3. Cut Kubernetes readiness to `serving`.
4. Cut deploy verification and downstream consumers to capsule parity.
5. Remove request-time execution-trust readiness once parity has been proven in one production cycle.

## Rollback plan

Rollback is a feature-flagged reversion, not a schema deletion:

- leave capsule tables in place;
- restore old readiness evaluation through a guarded fallback flag;
- keep compiler writing shadow capsules for forensic comparison until confidence is restored.

## Risks and open questions

- The main risk is building too many capsule classes before consumer binding is simple enough to enforce.
- A second risk is partial cutover, where deploy verification reads capsules but one runtime path still re-derives truth.
- The acceptance bar must therefore require digest parity, not just roughly similar decisions.

## Handoff to engineer

- Implement the capsule schema, compiler, and class model in Jangar.
- Change readiness to `serving` only after parity tests land.
- Extend control-plane status and Swarm projections with capsule ids and digests.
- Update deploy verification to require capsule parity on control-plane-affecting rollouts.

## Handoff to deployer

- Treat `serving` and `promotion` as separate contracts during rollout.
- Do not approve a control-plane-affecting release unless `promotion` capsule parity is green.
- If rollout stalls on readiness after this change, treat it as a true serving regression, not a stale authority issue.
