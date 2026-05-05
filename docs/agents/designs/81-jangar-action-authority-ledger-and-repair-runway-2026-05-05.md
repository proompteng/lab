# 81. Jangar Action Authority Ledger and Repair Runway (2026-05-05)

Status: Approved for implementation (`plan`)
Date: `2026-05-05`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`

Companion Torghut contract:

- `docs/torghut/design-system/v6/85-torghut-profit-escrow-repair-auction-and-capital-authority-2026-05-05.md`

Extends:

- `docs/agents/designs/80-jangar-settlement-adoption-ladder-and-cutover-governance-2026-05-05.md`
- `docs/agents/designs/79-jangar-control-plane-proof-runway-and-consumer-gated-rollout-2026-05-05.md`
- `docs/agents/designs/72-jangar-materialized-run-proof-and-storage-backed-admission-contract-2026-05-05.md`
- `docs/torghut/design-system/v6/84-torghut-capital-warrant-adoption-and-profitability-experiment-ladder-2026-05-05.md`

## Decision

Jangar should promote from proof-runway designs to an **Action Authority Ledger** with an explicit **Repair Runway**.
The ledger records one decision per action class: `serve`, `observe`, `repair`, `dispatch`, `widen`, and
`external_capital`. A degraded control plane can keep serving and repairing while the ledger holds dispatch, rollout
widening, and Torghut non-shadow capital. This is the next architecture move because the current evidence says the
system is not simply up or down; it is healthy enough to repair and unsafe enough to gate material actions.

The important distinction is plain: a route can be alive, a database can be schema-current, and controllers can have
fresh heartbeats while execution truth is still degraded. I do not want a single readiness bit deciding every action.
I want Jangar to publish action-specific authority with fresh evidence, expiry, and a repair path that remains available
when higher-risk actions are held.

## Evidence Snapshot

### Cluster and Rollout Evidence

All cluster checks in this pass were read-only.

- Runtime inputs resolved to base `main`, head `codex/swarm-jangar-control-plane-plan`, namespace focus `agents`, and
  channel `general`.
- `kubectl auth whoami` identified the runner as `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n agents -o json` at `2026-05-05T17:28Z` showed `Running=13`, `Succeeded=19`, `Failed=6`, and
  `Pending=3` pods.
- `kubectl get jobs -n agents -o json` showed `37` failed jobs out of `96` total jobs. In the last hour, Jangar plan
  and discover jobs and Torghut plan jobs had `BackoffLimitExceeded`, while several current digest jobs were running
  or completed.
- `kubectl get events -n agents --sort-by=.lastTimestamp` showed old `ImagePullBackOff` events for Jangar and Torghut
  scheduled work, `UnexpectedJob` warnings from manual runs, recent controller readiness probe timeouts, and fresh
  successful creates for current schedule-runner jobs.
- `kubectl get pods -n jangar -o wide` showed Jangar, Jangar Postgres, Redis, Bumba, Symphony, OpenWebUI, and Alloy
  running. Events showed recent Jangar rollout churn and readiness probe failures during pod startup.
- `curl http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200 with leader election healthy.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` returned controller
  status healthy, rollout health healthy for `agents` and `agents-controllers`, and watch reliability healthy.
- The same control-plane status response reported `execution_trust.status=degraded` because Jangar `discover`, `plan`,
  and `verify` stages were stale, and `dependency_quorum.decision=block` because empirical jobs were degraded.
- RBAC blocked `deployments`, Argo CD Applications, CNPG clusters, and `pods/exec` reads from this service account in
  the target namespaces.

Interpretation: the control plane can serve and reconcile current jobs, but its material-action truth is weaker than
its pod and route truth. The ledger must make that difference explicit.

### Source and Test Evidence

The high-risk source shape is a split authority problem across large modules:

- `services/jangar/src/server/control-plane-status.ts` assembles controller, database, watch, workflow, dependency,
  runtime-kit, admission-passport, rollout, and empirical-service evidence.
- `services/jangar/src/server/control-plane-workflows.ts` evaluates recent workflow failures from scheduled Job labels
  and feeds dependency quorum.
- `services/jangar/src/server/control-plane-execution-trust.ts` evaluates swarm stage freshness, freezes, requirements,
  and recent failure counts.
- `services/jangar/src/server/control-plane-rollout-health.ts` can derive healthy controller authority from rollout
  health when split topology is enabled.
- `services/jangar/src/server/supporting-primitives-controller.ts` generates schedule-runner CronJobs and reconciles
  Workspaces to PVCs.
- `services/jangar/src/server/primitives-kube.ts` has builtin targets for ConfigMaps, CronJobs, Jobs, Deployments,
  Pods, Secrets, Services, Events, Leases, and Namespaces, but not `PersistentVolumeClaim`. The supporting controller
  calls `kube.get('persistentvolumeclaim', ...)` and `kube.delete('persistentvolumeclaim', ...)`, and there is no
  workspace/PVC regression test in the sampled test files. That is a concrete repair-lane risk.

The source already has useful reliability primitives, but they are route-local. The missing contract is a shared action
decision that every route and controller path consumes instead of reinterpreting partial health.

### Database and Data Evidence

Direct SQL was intentionally not used because the runner service account cannot create `pods/exec` in `jangar` or
`torghut`, and CNPG cluster reads were forbidden. The design must therefore rely on application-exposed database proof
plus migration and route evidence, not privileged operator shell access.

Allowed evidence:

- Jangar control-plane status reported database `connected=true`, `status=healthy`, and migration consistency healthy.
- Jangar migration consistency reported `registered_count=25`, `applied_count=25`, `unapplied_count=0`,
  `unexpected_count=0`, and latest applied migration `20260418_embedding_dimension_4096`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, `current_heads=["0029_whitepaper_embedding_dimension_4096"]`,
  and `schema_graph_lineage_ready=true`, with warnings about historical migration parent forks.
- Torghut `/trading/status` returned shadow-only capital posture, `promotion_eligible_total=0`,
  `quant_health_not_configured`, an active signal-continuity alert, and `last_decision_at=2026-05-04T17:25:57.901670Z`.
- Torghut `/trading/health` returned 503 during the evidence window, while `/healthz` returned OK.

Interpretation: schema proof is healthy, but action proof is mixed. Database success must not override stale execution
truth, missing quant evidence, or route-specific health failures.

## Problem

Jangar currently exposes several valid but incomplete health views. `/ready` answers whether the serving process should
receive traffic. The control-plane status route answers whether controllers, workflows, watches, database, rollout, and
dependency quorum are healthy enough for broader decisions. Torghut reads some Jangar signals for capital and market
context. Deployers read pod and rollout state. Schedulers read CRD state.

Those views are not wrong. They are answering different questions. The failure mode is that consumers can still treat a
green answer from one surface as permission for a different action class.

The next six months need a stronger contract:

1. serving remains available when repair is needed;
2. repair jobs can run when dispatch is held;
3. dispatch cannot hide stale stage truth;
4. rollout widening cannot hide old ImagePullBackOff or route probe failures;
5. Torghut non-shadow capital cannot proceed on schema health alone.

## Options Considered

### Option A: Tighten Existing Readiness and Dependency Quorum

Make `/ready`, `/api/agents/control-plane/status`, and dependency quorum stricter so degraded execution trust turns the
whole system red.

Pros:

- simplest mental model;
- fast to test;
- stops unsafe dispatch if all callers respect readiness.

Cons:

- turns repair incidents into serving incidents;
- blocks useful diagnostics and shadow work;
- encourages manual bypasses when operators need repair jobs;
- still does not separate rollout widening from Torghut capital.

Decision: reject. This reduces ambiguity by making the system less available, not by making authority clearer.

### Option B: Keep Existing Proof Runway and Add More Alerts

Preserve the current proof-runway direction and add alerts for route disagreements, old ImagePullBackOff pods, and
Torghut quant evidence gaps.

Pros:

- low implementation risk;
- aligns with existing docs;
- useful as a near-term observability improvement.

Cons:

- alerts do not create a single contract for controllers, routes, deployers, and Torghut;
- consumers still decide which alert matters;
- no durable audit record of why an action was allowed or held;
- repair and dispatch remain coupled through informal practice.

Decision: reject as the final design. Alerts are evidence inputs, not the authority layer.

### Option C: Action Authority Ledger With Repair Runway

Persist action-specific decisions and expose them through routes, controller reconciliation, deploy verification, and
Torghut mirrors. Allow `serve`, `observe`, and bounded `repair` under degraded execution trust. Hold `dispatch`,
`widen`, and `external_capital` until their evidence cuts are fresh.

Pros:

- reduces false-positive green surfaces without taking serving offline;
- creates one audit object for every material action class;
- lets deployers and engineers validate route parity with deterministic digests;
- gives Torghut a capital authority surface that is not route liveness.

Cons:

- requires schema, route, controller, and test work;
- introduces a transitional period with shadow and enforced interpretations;
- demands careful expiry semantics so stale repair authority cannot become stale dispatch authority.

Decision: select Option C.

## Chosen Architecture

### ActionAuthorityLedger

Jangar should persist one compact ledger row per action class, namespace, subject, and evidence cut:

```text
action_authority_ledger
  authority_epoch_id
  namespace
  action_class              # serve, observe, repair, dispatch, widen, external_capital
  subject_kind              # route, swarm, stage, release, torghut_account, repair_case
  subject_ref
  release_digest
  evidence_cut_digest
  decision                  # allow, degrade, hold, block
  enforcement_mode          # off, shadow, warn, enforce
  reason_codes
  required_inputs
  satisfied_inputs
  missing_inputs
  observed_at
  fresh_until
  producer_revision
  rollback_switch
```

The ledger is append-oriented. Current-state routes can materialize the latest fresh row, but the audit trail keeps
negative evidence and old decisions.

### Action Semantics

`serve` means the Jangar process may receive traffic. It should be based on process health, leader election, required
database connectivity, and basic runtime kit availability.

`observe` means routes and watches may surface state, even if action classes are held. It should remain available unless
the process cannot safely read state.

`repair` means bounded repair jobs, retries, resyncs, proof refreshes, and cleanup work may run. It is allowed when the
repair action is scoped, idempotent, and does not widen production blast radius.

`dispatch` means Jangar may launch new non-repair AgentRuns, scheduled work, or orchestrated execution. It requires
fresh stage truth, workflow reliability inside budget, a valid runner image, and no blocking dependency quorum segment.

`widen` means a deployer may expand a rollout, promote a revision, or increase controller/scheduler concurrency. It
requires dispatch authority plus rollout health, route parity, and a fresh negative-evidence scan.

`external_capital` means a Torghut account/window may receive non-shadow capital. It requires Jangar dispatch/widen
authority for the relevant release digest plus Torghut profit proof, quant evidence, signal continuity, and broker
warrant parity.

### Repair Runway

The repair runway is the part that prevents safe gates from becoming operational dead ends. When `dispatch`, `widen`, or
`external_capital` is held, Jangar should still be able to issue bounded `repair` authority for:

- refresh of stale swarm stage evidence;
- replacement of schedule-runner jobs pinned to missing image digests;
- status/proof route rechecks;
- workspace/PVC reconciliation tests and fixes;
- Torghut quant-health and empirical-job proof refresh;
- read-only database schema proof via application routes.

Repair authority must carry a budget: max concurrent repairs, max age, owner, expected proof output, and rollback
switch. A repair action that creates new workload demand outside the budget needs dispatch authority.

### Consumer Projection

Every consumer should read the same ledger-derived projection:

- `/ready` may keep returning OK for `serve`, but it must include a compact action summary or link to it.
- `/api/agents/control-plane/status` should expose the full action-authority block and decision digests.
- the supporting controller should consult `dispatch` before creating non-repair schedule-runner work and consult
  `repair` for bounded remediation.
- deploy verification should require `widen` before promoting or widening.
- Torghut should bind non-shadow order warrants to `external_capital`.

### Required Source Repairs

The first engineer slice should include two small code hardening tasks that make the ledger credible:

1. add `persistentvolumeclaim` and `persistentvolumeclaims` builtin targets to `services/jangar/src/server/primitives-kube.ts`;
2. add workspace/PVC regression tests covering `reconcileWorkspace` get/delete status and the native kube target map.

This is not the whole architecture. It is the source repair exposed by the evidence pass, and it should land before
workspace repair authority is considered trustworthy.

## Implementation Scope

Engineer scope:

1. Add a Kysely migration for `action_authority_ledger` with indexes on `namespace`, `action_class`, `subject_ref`,
   `fresh_until`, and `evidence_cut_digest`.
2. Build a pure action-authority evaluator from existing control-plane status inputs.
3. Add route serialization and tests for `/ready` and `/api/agents/control-plane/status`.
4. Wire supporting-controller dispatch decisions in shadow mode first; log and surface planned holds without changing
   scheduling behavior.
5. Add the PVC target/test repair described above.
6. Add Torghut projection fields for `external_capital` without enforcing broker behavior until route parity passes.

Deployer scope:

1. Run the action ledger in `shadow` for one full schedule cycle.
2. Compare decision digests across `/ready`, control-plane status, deploy verification, and Torghut status.
3. Enable repair-runway enforcement first.
4. Enable dispatch holds next.
5. Enable rollout widening holds after deploy verification reads the same digest.
6. Enable `external_capital` only after Torghut route/scheduler/broker parity passes.

## Validation Gates

Unit gates:

- pure evaluator allows `serve`, `observe`, and scoped `repair` when execution trust is degraded but database and route
  reads are healthy;
- pure evaluator holds `dispatch` and `widen` for stale discover, plan, or verify stages;
- pure evaluator holds `external_capital` when Torghut quant evidence is missing, signal continuity is alerting, or
  promotion eligibility is zero;
- `primitives-kube` supports `persistentvolumeclaim` and `persistentvolumeclaims`;
- workspace/PVC reconciliation has get/delete/status tests.

Integration gates:

- `/ready` and `/api/agents/control-plane/status` expose the same action-authority digest for the sampled namespace;
- current May 5 evidence produces `serve=allow`, `observe=allow`, `repair=degrade/allow`, `dispatch=hold`,
  `widen=hold`, and `external_capital=hold`;
- a stale stage, an old image-pull failure, and a Torghut quant-health timeout each produce distinct reason codes;
- RBAC-denied direct SQL is represented as missing privileged evidence, not a database outage when application DB proof
  is healthy.

Operational gates:

- one schedule cycle in shadow emits no digest drift between route surfaces;
- repair actions clear or refresh at least one stale-stage or proof-gap reason without widening dispatch;
- deploy verification refuses widening when the action ledger holds `widen`;
- Torghut refuses non-shadow capital when the action ledger holds `external_capital`.

## Rollout

Rung 1: schema and shadow evaluator. Persist decisions but do not enforce them.

Rung 2: route parity. Expose identical action digests on `/ready`, control-plane status, and Torghut projection routes.

Rung 3: repair runway. Enforce bounded repair authority while dispatch remains advisory.

Rung 4: dispatch hold. Block non-repair schedule-runner and AgentRun launch when `dispatch` is held.

Rung 5: rollout widening hold. Require `widen` for deploy promotion and concurrency expansion.

Rung 6: external capital hold. Require `external_capital` for Torghut non-shadow broker warrants.

## Rollback

Rollback is configuration-only per action class:

- `JANGAR_ACTION_AUTHORITY_ENFORCEMENT_MODE=off` disables enforcement while keeping ledger emission.
- `JANGAR_ACTION_AUTHORITY_REPAIR_MODE=shadow` disables repair enforcement without deleting repair evidence.
- `JANGAR_ACTION_AUTHORITY_DISPATCH_MODE=shadow` allows dispatch while continuing to report holds.
- `JANGAR_ACTION_AUTHORITY_WIDEN_MODE=shadow` lets deployers revert to current rollout behavior.
- `JANGAR_ACTION_AUTHORITY_EXTERNAL_CAPITAL_MODE=shadow` leaves Torghut broker admission on its previous gate.

Do not roll back by deleting ledger rows. Negative evidence is part of the audit surface.

## Risks and Tradeoffs

The biggest risk is overfitting to today’s stale-stage and Torghut signal-continuity evidence. The mitigation is to keep
the evaluator input-driven and action-scoped; a future failure mode should add a reason code, not a new global gate.

The second risk is a confusing transition period. The mitigation is route parity: every visible surface must show the
same digest and action decisions before enforcement.

The third risk is repair abuse. The repair runway must be budgeted and idempotent. A repair that launches unbounded
work is dispatch, not repair.

The fourth risk is stale ledger rows. Every row needs `fresh_until`, and consumers must treat expired rows as `hold` for
material action classes.

## Handoff

Engineer acceptance gate: implement the ledger schema, pure evaluator, route serialization, PVC target repair, and tests
so the current evidence cut deterministically allows serving/repair but holds dispatch, widening, and external capital.

Deployer acceptance gate: run one shadow schedule cycle, verify digest parity across Jangar and Torghut surfaces, then
enable enforcement in the order `repair`, `dispatch`, `widen`, `external_capital`.

Owner acceptance gate: the handoff is not complete until a merged PR records the current evidence, the selected option,
the action-class contract, validation gates, rollout order, rollback switches, and Torghut capital implications.
