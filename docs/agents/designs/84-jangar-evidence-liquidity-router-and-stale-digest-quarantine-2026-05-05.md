# 84. Jangar Evidence Liquidity Router and Stale-Digest Quarantine (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Gideon Park (Torghut Traders architecture)
Mission: `codex/swarm-torghut-quant-discover`

Companion Torghut contract:

- `docs/torghut/design-system/v6/88-torghut-session-proof-liquidity-and-hypothesis-market-maker-2026-05-05.md`

Extends:

- `83-jangar-clearance-repair-exchange-and-budgeted-proof-closures-2026-05-05.md`
- `83-jangar-lease-backed-proof-market-and-profit-aware-rollout-authority-2026-05-05.md`
- `82-jangar-authority-clearance-cells-and-negative-evidence-slas-2026-05-05.md`
- `81-jangar-action-class-proof-fuses-and-quant-health-quarantine-2026-05-05.md`

## Decision

Jangar should add an **Evidence Liquidity Router** and **Stale-Digest Quarantine** above clearance repair warrants.
Repair warrants say which bounded repair is allowed. The router decides which proof route is liquid enough to trust,
which stale digest should be quarantined instead of retried, and which consumer action class may proceed.

I am choosing this because the current read-only state shows a control plane that can serve while action authority is
still degraded:

- `/health` returned HTTP 200 from `jangar-847d6d7f8d-zx5sq`;
- `/api/agents/control-plane/status` reported leader election held by that pod and database status healthy with 25
  registered/applied migrations, latest `20260418_embedding_dimension_4096`;
- runtime kits are now healthy: serving has `/usr/local/bin/bun`; collaboration has `codex-nats-publish`,
  `codex-nats-soak`, `nats`, `/app/services/jangar`, and `NATS_URL`;
- serving admission is `degrade` because execution trust is degraded, while `swarm_plan`, `swarm_implement`, and
  `swarm_verify` passports are `hold` with `execution_trust_degraded`;
- execution trust is degraded because `jangar-control-plane:verify` is stale;
- rollout health reports `agents` and `agents-controllers` healthy, but the non-running pod query still shows old
  Jangar and Torghut stage jobs in `ImagePullBackOff` and `Error`;
- recent Jangar events include the successful `919848c1` rollout and one current `jangar-db-1` readiness HTTP 500
  warning;
- direct Argo Application reads, CNPG CR reads, and Torghut SQL via `pods/exec` are forbidden to this runner, so
  least-privilege route proof is the supported evidence path.

The decision is to keep serving available, keep normal action classes held, and introduce a router that prices proof
availability by SLO, digest, route, and consumer. Old image digests should be quarantined as evidence debt, not retried
until an attestation or replacement warrant exists.

## Scope and Success Metrics

This contract covers Jangar control-plane resilience and the proof projection consumed by Torghut. It does not change
the broker admission policy and does not merge or deploy application code by itself.

Success means:

1. every important route and stage has an evidence-liquidity state: liquid, thin, stale, timed_out, quarantined, or
   unavailable;
2. serving readiness, repair permission, dispatch permission, widen permission, and external-capital permission are
   separate actionability buckets;
3. stale image digests and old failed jobs stop consuming retry authority unless a matching warrant exists;
4. least-privilege consumers can read evidence liquidity without `pods/exec`, Argo Application reads, or direct SQL;
5. Torghut can discount proof when Jangar has stale verify, route timeouts, old digest failures, or open
   `external_capital` holds;
6. deployer stages can block rollout widening on stale-digest debt without blocking operator visibility.

## Evidence Snapshot

All cluster, route, and database assessment was read-only.

### Cluster and Rollout Evidence

Jangar and the agents deployments are mostly healthy, but workflow debt remains visible:

- `kubectl get pods -n jangar -o wide` showed Jangar, Jangar DB, Redis, Open WebUI, Bumba, Symphony, and Alloy running.
- `kubectl get pods -n agents -o wide` showed current `agents` and two `agents-controllers` pods running, with active
  stage attempts also running.
- The non-running pod view still listed old `ImagePullBackOff` jobs for Jangar control-plane implement, Torghut quant
  discover, and Torghut quant implement, plus one recent plan-stage `Error`.
- Agent events showed repeated old digest pull failures for `86423d3e` and `eba3d511`, even after the current
  `919848c1` rollout recovered runtime-kit proof.
- Jangar events showed one current database readiness warning on `jangar-db-1` after the app pod itself became healthy.

Interpretation: rollout health alone is not enough. The current digest is serving, but stale digest failures and stale
stage proof still reduce action liquidity.

### Source and Test Evidence

The control-plane implementation already has the right status surfaces, but they need a proof-liquidity contract:

- `services/jangar/src/server/control-plane-status.ts` is 572 lines and aggregates controller, database, watch,
  workflow, runtime, rollout, execution-trust, dependency-quorum, Torghut empirical-service, runtime-kit, and admission
  state.
- `services/jangar/src/server/control-plane-runtime-admission.ts` is 489 lines and already emits runtime kits and
  admission passports.
- `services/jangar/src/server/supporting-primitives-controller.ts` is 2,878 lines and owns schedule and swarm materialization.
- `services/jangar/src/server/agents-controller/job-runtime.ts` is 734 lines and owns runner execution details.
- Existing tests cover runtime kit component failures, admission passports, control-plane status, supporting primitive
  scheduling, and route parsing. The gap is a contract that says when stale proof is merely visible, when it permits
  repair, and when it blocks action classes.

Interpretation: implementation should add pure evidence-liquidity builders and status tests before changing admission.

### Database and Data Evidence

Jangar database evidence is route-based:

- control-plane status reported database connected and healthy, latency around 30 ms, and all 25 registered migrations
  applied;
- direct CNPG CR reads in `jangar` and `torghut` were forbidden;
- Torghut direct SQL was blocked by `pods/exec` RBAC;
- Torghut `/db-check` supplied the schema-current proof that the least-privilege runner could not get through SQL.

Interpretation: the architecture should formalize route proof as first-class evidence, not treat missing privileged SQL
as a fatal diagnostic gap.

## Problem

Jangar already separates serving from action admission. It still lacks a common price for proof availability.

Today the control plane can say:

- Jangar is serving;
- runtime kits are healthy;
- verify is stale;
- old digest jobs are in `ImagePullBackOff`;
- Torghut empirical jobs are stale;
- quant-health timed out;
- route and SQL visibility are least-privilege.

What it cannot yet say in one projection is:

1. which proof is liquid enough for observation;
2. which proof is liquid enough for bounded repair;
3. which stale digest must be quarantined instead of retried;
4. which action class remains held for dispatch, widen, or external capital;
5. which consumer can use the proof without overreading it.

Without that projection, operators and downstream systems either freeze too broadly or retry stale work too loosely.

## Options Considered

### Option A: Hard Global Freeze While Any Stage Is Stale

Jangar would block all scheduled work, repair work, and consumer proof while verify is stale or any old digest job is in
failure.

Pros:

- simple to reason about;
- avoids false clearance;
- reduces the chance of retry storms.

Cons:

- hides useful route and runtime-kit proof;
- prevents bounded repair work that could clear the stale stage;
- lets old failed digests block current serving evidence;
- gives Torghut no way to keep learning under capital hold.

Decision: reject as the default. It remains appropriate for corrupt route proof or unknown authority sessions.

### Option B: Retry All Failed Jobs on the Current Runtime

Jangar would retry stale stages and image-pull failures after the `919848c1` rollout because current runtime kits are
healthy.

Pros:

- may clear transient failures quickly;
- uses the recovered runtime immediately;
- simple operationally.

Cons:

- old missing digests can keep consuming cluster pressure;
- retries do not distinguish route timeout, image absence, stale verify, or Torghut stale proof;
- a successful retry can be mistaken for widen or capital clearance;
- it ignores the consumer action class.

Decision: reject as the primary design. Retries need evidence SLOs, quarantine, and warrants.

### Option C: Evidence Liquidity Router With Stale-Digest Quarantine

Jangar routes proof by action class, SLO, digest, and consumer. It quarantines old digests and emits compact
least-privilege receipts.

Pros:

- keeps visibility while normal action remains held;
- turns old image failures into owned debt instead of retry noise;
- lets repair work run only when warranted;
- gives Torghut a single proof-liquidity digest to price hypothesis work;
- makes rollout widening safer by separating current serving from stale digest debt.

Cons:

- adds another projection and digest;
- needs careful cooldowns and expiry rules;
- requires deployer education because "serving" and "liquid for action" will differ.

Decision: select Option C.

## Chosen Architecture

### EvidenceLiquidityReceipt

Jangar should materialize receipts for route and stage proof:

```text
evidence_liquidity_receipt
  receipt_id
  subject_kind                  # route, stage, runtime_kit, image_digest, database_route, consumer_projection
  subject_ref
  release_digest
  consumer_class                # observe, repair, dispatch, widen, external_capital
  state                         # liquid, thin, stale, timed_out, quarantined, unavailable
  observed_at
  fresh_until
  evidence_slo_seconds
  failure_class
  route_ref
  required_warrant_id
  close_proof_ref
  digest
```

Receipts are least-privilege evidence. They should not expose secrets, raw SQL, or privileged cluster internals.

### ActionabilityBuckets

The router should emit separate buckets:

```text
evidence_actionability
  observe_allowed
  repair_allowed
  dispatch_allowed
  widen_allowed
  external_capital_allowed
  blocked_reasons_by_class
  stale_digest_count
  timed_out_route_count
  stale_stage_count
  digest
```

Serving can be allowed while dispatch, widen, and external capital are held. That is the desired state when evidence is
available but not liquid enough for action.

### StaleDigestQuarantine

Old image pull failures need their own state:

```text
stale_digest_quarantine
  quarantine_id
  image_ref
  digest
  first_failed_at
  last_failed_at
  failure_count
  failure_class                 # image_missing, auth_failed, platform_mismatch, unknown
  affected_swarms
  affected_stages
  retry_blocked_until
  required_attestation
  replacement_digest
  state                         # open, attested, replaced, expired, ignored
```

The current old failures for `86423d3e` and `eba3d511` should be modeled as open quarantine debt. They should not
block observation of the `919848c1` runtime, but they should block automatic retry and any widen claim that depends on
those digests.

### Torghut Consumer Projection

Torghut should consume a compact projection:

```text
torghut_evidence_liquidity
  account
  generated_at
  serving_state
  repair_state
  external_capital_state
  open_external_capital_holds
  stale_stage_refs
  stale_digest_refs
  timed_out_route_refs
  empirical_jobs_state
  quant_health_state
  digest
```

This projection lets Torghut discount proof without needing Jangar database credentials or privileged Kubernetes reads.

## Implementation Scope

Engineer-stage implementation should land in small slices:

1. Add pure builders for evidence liquidity receipts, actionability buckets, stale-digest quarantine records, and
   digests.
2. Build receipts from existing control-plane status inputs, runtime-kit snapshots, admission passports, workflow
   health, rollout health, and dependency quorum.
3. Emit a shadow projection on `/api/agents/control-plane/status` without changing admission behavior.
4. Add tests for the May 5 state: runtime kits healthy, verify stale, plan/implement/verify held, old digest
   `ImagePullBackOff`, Torghut empirical jobs degraded, and quant-health timeout.
5. Add supporting-controller tests proving quarantined digests cannot be retried without a matching warrant.
6. Add deployer tests proving widen requires no open stale-digest quarantine for the target release digest.
7. Add Torghut consumer tests proving external-capital proof debt is visible separately from serving readiness.

## Validation Gates

Required local validation for implementation PRs:

- `bun run --filter jangar test -- control-plane-status`
- `bun run --filter jangar test -- control-plane-runtime-admission`
- `bun run --filter jangar test -- supporting-primitives-controller`
- `bun run --filter jangar test -- agents-controller`
- `bunx oxfmt --check services/jangar/src docs/agents/designs`

Required deployed validation:

- `/health` can remain green while `/api/agents/control-plane/status` reports held actionability buckets;
- runtime kits stay healthy when the local NATS tooling is present;
- stale verify opens repair demand and holds normal dispatch;
- old image digests enter quarantine and do not receive automatic retries;
- Torghut can read the consumer projection without `pods/exec`, Argo Application reads, or direct SQL;
- disabling enforcement leaves receipts and quarantine state visible.

## Rollout Plan

1. **Shadow receipts:** emit evidence liquidity and quarantine state without admission changes.
2. **UI and handoff parity:** show the same digest in Jangar status, release handoffs, and Torghut consumer routes.
3. **Retry quarantine:** block automatic retry for quarantined digests unless an attestation or replacement warrant is
   present.
4. **Repair routing:** allow bounded repair work when the repair bucket is liquid and the matching action class remains
   held.
5. **Widen and capital enforcement:** block rollout widening and external-capital clearance when matching evidence
   liquidity is stale, timed out, or quarantined.

## Rollback Plan

Rollback must keep observability:

- set enforcement to `shadow` or `off`;
- keep receipt, actionability, and quarantine projection emission enabled;
- stop only retry and widen enforcement first;
- preserve historical quarantine records and ignored actionability buckets;
- publish a rollback note listing stale stage count, stale digest count, timed-out routes, and action classes reopened.

## Risks and Tradeoffs

The main risk is making the control plane look more complex while the actual failures are simple. The answer is not to
hide the complexity. The answer is to reduce it to actionability buckets and digest-stable receipts.

The second risk is stale quarantine debt blocking useful work forever. Quarantine records need expiry, replacement
digest paths, and human override with evidence. An override should be visible as an override, not a clean bill of
health.

The tradeoff is stricter rollout widening. I accept that because the current failure mode is old digest debt coexisting
with a healthy current runtime. Widening should depend on the target digest, not on the broad fact that a pod is
serving.

## Handoff Contract

Engineer acceptance gates:

- implement shadow evidence liquidity receipts, actionability buckets, stale-digest quarantine records, and digests;
- add May 5 fixtures for healthy runtime kits, stale verify, held passports, old image pull failures, route timeout,
  and Torghut stale empirical proof;
- prove quarantined digests cannot be retried or widened without attestation or replacement warrants;
- expose Torghut consumer projection without requiring privileged SQL or cluster-admin reads.

Deployer acceptance gates:

- do not widen a release while target-digest quarantine or stale-stage debt is open;
- capture evidence liquidity digest, actionability buckets, stale digest count, and rollback switch in release
  handoffs;
- verify enforcement can be disabled without hiding stale digest or route debt.

Torghut acceptance gates:

- consume Jangar evidence liquidity as platform proof debt, not as trading proof by itself;
- discount hypothesis proof quotes when Jangar external-capital, route, or digest liquidity is stale;
- keep observe, replay, and zero-notional proof work running while capital and rollout action classes remain held.
