# 82. Jangar Authority Clearance Cells and Negative Evidence SLAs (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-discover`

Companion Torghut contract:

- `docs/torghut/design-system/v6/86-torghut-profit-debt-ledger-and-repair-sla-experiments-2026-05-05.md`

Extends:

- `81-jangar-action-authority-ledger-and-repair-runway-2026-05-05.md`
- `81-jangar-action-lease-backplane-and-profit-evidence-exchange-2026-05-05.md`
- `80-jangar-settlement-adoption-ladder-and-cutover-governance-2026-05-05.md`
- `79-jangar-control-plane-proof-runway-and-consumer-gated-rollout-2026-05-05.md`

## Decision

Jangar should add **Authority Clearance Cells** on top of the action-authority ledger and action-lease backplane. Every
`hold`, `block`, or `degrade` decision for `dispatch`, `widen`, or `external_capital` must create a small owned cell
with the negative evidence, the affected action class, the repair authority allowed to clear it, the deadline, and the
proof that will close it. The control plane can keep serving while material actions are held, but no held action should
remain passive status debt.

I am choosing this because the current evidence is no longer a simple availability problem. Jangar `/ready` is healthy
and leader-held, controller heartbeats are fresh, database migrations are applied, and rollout health reports green for
the `agents` deployments. The same window shows `execution_trust.status=degraded`, `dependency_quorum.decision=block`,
stale verify truth, one plan failure window, old image-pull-blocked jobs, recent controller probe failures, and route
proof timeouts for Torghut quant and market-context consumers.

The existing architecture stack correctly separates serving, repair, dispatch, rollout widening, and external capital.
The missing operational contract is clearance. A held action has to name the exact repair that will make it safe again,
or it becomes another dashboard field everyone learns to ignore.

## Scope and Success Metrics

This contract is scoped to Jangar control-plane architecture and the handoff to Torghut capital consumers. It does not
replace the proof runway, action ledger, or action lease designs. It makes negative evidence actionable and auditable.

Success means engineer and deployer stages can prove all of the following:

1. A degraded execution-trust window creates clearance cells for `dispatch` and `widen`, while `serve`, `observe`, and
   bounded `repair` remain allowed.
2. A Torghut capital hold creates an `external_capital` clearance cell with the same evidence cut Torghut reads.
3. Every cell has an owner, action class, source evidence refs, deadline, close condition, repair budget, and rollback
   switch.
4. Status routes expose the latest open cells and their decision digests without requiring `pods/exec`, database
   credentials, or cluster-admin reads.
5. Dispatch and rollout widening cannot be re-enabled by time alone; they require a fresh close proof for the same
   namespace, release digest, and action class.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Rollout Evidence

The runner identity was `system:serviceaccount:agents:agents-sa`. It can list pods, jobs, CronJobs, and events in the
relevant namespaces, but it cannot exec into CNPG database pods. That is the right operating constraint for this design:
clearance must be provable through least-privilege projections, not privileged shell access.

Observed Jangar state on `2026-05-05T18:19Z`:

- `kubectl get pods -n jangar -o wide` showed Jangar, Jangar Postgres, Redis, Bumba, Symphony, Open WebUI, and Alloy
  running. The active Jangar pod was `2/2 Running`.
- `/ready` returned HTTP 200 with leader election enabled, required, and held by the active Jangar pod.
- `kubectl get events -n jangar --sort-by=.lastTimestamp` showed a recent Jangar rollout from `e48d29c9` to
  `a1b55322`, earlier container restarts, and readiness probe failures during startup. A Jangar DB readiness probe
  reported HTTP 500 in the same recent window.
- `kubectl get pods -n agents -o wide` showed current `agents` and `agents-controllers` pods running, plus scheduled
  Jangar and Torghut work interleaved with `Error`, `ErrImagePull`, and `ImagePullBackOff` pods from older attempts.
- `kubectl get events -n agents --sort-by=.lastTimestamp` showed recent controller readiness probe failures, old image
  pull backoffs, `BackoffLimitExceeded`, scheduling pressure, successful current digest jobs, and rollout scale events.
- Control-plane status reported rollout health healthy for `agents` and `agents-controllers`, while execution trust
  was degraded for Jangar plan/verify and dependency quorum blocked on `empirical_jobs_degraded`.

Interpretation: rollout health is necessary evidence, but it is not clearance. The control plane needs a durable cell
that says which negative evidence still blocks each action class.

### Source and Test Evidence

The high-risk source surfaces are already identifiable:

- `services/jangar/src/server/control-plane-status.ts` has 572 lines and aggregates controller, database, watch,
  workflow, runtime, rollout, execution trust, dependency quorum, and empirical-service state.
- `services/jangar/src/server/control-plane-execution-trust.ts` has 506 lines and evaluates stage freshness, failure
  windows, freezes, and pending requirements.
- `services/jangar/src/server/supporting-primitives-controller.ts` has 2878 lines and owns schedule materialization,
  CronJob generation, workspace PVC lifecycle, and supporting-resource watches.
- `services/jangar/src/server/control-plane-rollout-health.ts` has 238 lines and can report rollout health as green
  while older action blockers remain visible in events and execution trust.
- `services/jangar/src/routes/ready.tsx` has 175 lines and intentionally keeps serving readiness narrower than
  control-plane promotion health.

The missing regression shape is cross-route clearance parity. A new test should not only assert that a route reports
`execution_trust=degraded`; it should assert that degraded execution trust opens the correct clearance cells, preserves
repair authority, and keeps dispatch/widen held until a close proof appears.

### Database, Data, and Consumer Evidence

Direct database SQL was intentionally unavailable:

- `kubectl cnpg psql -n jangar jangar-db -- -c 'select current_database();'` failed because `pods/exec` is forbidden.
- `kubectl cnpg psql -n torghut torghut-db -- -c 'select current_database();'` failed for the same reason.

Allowed application evidence:

- Jangar status reported database `configured=true`, `connected=true`, `status=healthy`, 25 registered migrations, 25
  applied migrations, and latest applied migration `20260418_embedding_dimension_4096`.
- Torghut `/db-check` returned HTTP 200 with `ok=true`, `schema_current=true`, current head
  `0029_whitepaper_embedding_dimension_4096`, and `schema_graph_lineage_ready=true`, with warnings about historical
  migration parent forks.
- Torghut `/trading/health` returned HTTP 503 because `live_submission_gate.ok=false` while database, scheduler,
  ClickHouse, Alpaca, and universe checks were usable.
- Torghut `/trading/status` reported `live_submission_gate.allowed=false`, `reason=simple_submit_disabled`,
  `capital_stage=shadow`, three hypotheses all shadow or blocked, `promotion_eligible_total=0`, and
  `rollback_required_total=3`.
- Torghut `/trading/empirical-jobs` reported all four empirical jobs stale from `2026-03-21T09:03Z`.
- Jangar Torghut quant-health and market-context proof routes timed out after 8 seconds in this sample.

Interpretation: schema proof is healthy, but material-action proof is mixed. Clearance must treat route timeouts,
stale empirical jobs, and dependency quorum as first-class negative evidence.

## Problem

Jangar now has several strong primitives: evidence clocks, proof runways, action ledgers, action leases, runtime kits,
admission passports, and Torghut capital warrants. Those primitives answer whether an action should be allowed. They do
not yet guarantee that a blocked action is owned, timed, and cleared with proof.

That creates four failure modes:

1. **Passive holds.** Dispatch, widening, or capital can be held correctly, but no bounded repair path is attached.
2. **Evidence decay.** A route can recover or a job can complete, but stale negative evidence can remain unclear or
   disappear without an audit trail.
3. **Consumer drift.** A deployer, scheduler, and Torghut mirror can read the same degraded facts and choose different
   reopening criteria.
4. **Privilege dependency.** A closure process that requires database exec or cluster-admin reads cannot be run by the
   least-privilege agents that actually operate the lane.

The next design step is to make every negative decision an owned clearance cell with an expiration, repair budget, and
close proof.

## Options Considered

### Option A: Alerts and Runbook Links Only

Add alerts for stale stages, image-pull backoffs, route timeouts, and Torghut stale empirical jobs. Link each alert to a
runbook.

Pros:

- fastest to implement;
- improves operator visibility;
- avoids a new data object.

Cons:

- alerts do not create authority;
- no deterministic close proof;
- deployers still decide when widening is safe;
- Torghut capital consumers still need their own interpretation.

Decision: reject as the architecture. Alerts are inputs to clearance, not clearance itself.

### Option B: Automatic Reset and Retry

Let Jangar automatically retry failed schedules, clear old jobs, and refresh proof routes until the action lease returns
to allow.

Pros:

- reduces manual load;
- can clear transient failures quickly;
- uses the existing repair-runway direction.

Cons:

- retries can hide persistent image, route, or data freshness failures;
- no explicit owner or acceptance proof;
- can add workload pressure during degraded windows;
- does not help Torghut understand why capital remains held.

Decision: reject as the primary design. Automation is useful only after a cell defines the allowed repair budget.

### Option C: Authority Clearance Cells

Create one clearance cell for every material held action. The cell owns the blocker, cites evidence, grants bounded
repair, and closes only when proof is fresh for the same action class and digest.

Pros:

- converts negative evidence into an auditable repair contract;
- preserves serving and repair while holding unsafe actions;
- gives deployers and Torghut one close-proof surface;
- works under least-privilege RBAC;
- makes stale or missing proof measurable instead of informal.

Cons:

- adds persistence and route work;
- requires careful cell deduplication so repeated route failures do not create noise;
- needs a shadow period before enforcement depends on cell state.

Decision: select Option C.

## Chosen Architecture

### AuthorityClearanceCell

Jangar should materialize one cell per action class, subject, release digest, and evidence cut:

```text
authority_clearance_cell
  cell_id
  cell_digest
  namespace
  action_class              # dispatch, widen, external_capital
  subject_kind              # swarm, stage, release, route, torghut_account_window
  subject_ref
  release_digest
  opened_by_decision_digest
  opened_reason_codes
  negative_evidence_refs
  owner                     # controller, deployer, torghut, human escalation queue
  repair_authority_class    # observe_only, repair, retry, proof_refresh, manual_review
  repair_budget
  close_condition
  close_proof_refs
  state                     # open, repairing, closing, closed, expired, escalated
  observed_at
  due_at
  fresh_until
  rollback_switch
```

Cells should be append-friendly and deduplicated by `action_class`, `subject_ref`, `release_digest`, and
`opened_reason_codes`. A repeated route timeout updates the evidence window on the existing cell unless it changes the
reason set or affected subject.

### Negative Evidence SLA Policy

Each blocker class should map to a default SLA and repair budget:

- `stage_stale`: one scheduled interval plus 15 minutes; repair may refresh stage evidence or rerun the smallest
  verification job.
- `stage_consecutive_failures`: immediate hold; repair may launch one scoped diagnostic run, then escalate.
- `image_pull_backoff`: immediate hold for `dispatch` and `widen`; repair must prove the digest/platform tuple before
  any new non-repair schedule.
- `controller_probe_failure`: hold `widen`; repair may observe and run route probes, but not increase replicas.
- `route_probe_timeout`: hold consumer-specific widen/capital; repair may refresh cached proof asynchronously.
- `empirical_jobs_degraded`: hold `external_capital`; repair may run proof-refresh jobs under Torghut's budget.
- `privileged_sql_unavailable`: never blocks by itself; it records that application-route proof is the clearance path.

### Consumer Projection

Jangar should expose the current cells through a compact projection:

- `/ready` may include an action-summary link or digest while staying focused on serving readiness.
- `/api/agents/control-plane/status` should include `authority_clearance.open_cells` and `authority_clearance.digest`.
- deploy verification should require no open `widen` cells for the target release digest.
- schedule launch should require no open `dispatch` cell unless the launch is a bounded repair for that same cell.
- Torghut should bind non-shadow capital to absence of open `external_capital` cells for its account/window/release.

### Handoff to Torghut

The Torghut companion contract consumes Jangar cells as capital blockers. A Jangar `external_capital` clearance cell
does not tell Torghut which strategy is profitable. It tells Torghut that platform authority is not clear. Torghut must
then create profit-debt records for the local proof gaps that can close the platform cell or keep capital held.

## Implementation Scope

Engineer-stage work should land in small slices:

1. Add the `AuthorityClearanceCell` type, digest helper, and in-memory/materialized builder from existing
   control-plane status inputs.
2. Emit shadow cells in `/api/agents/control-plane/status` for execution-trust, rollout, route, image, database, and
   dependency-quorum blockers.
3. Add route and unit tests showing `/ready` can be HTTP 200 while `dispatch`, `widen`, and `external_capital` cells
   are open.
4. Add supporting-controller checks that label repair launches with the target `cell_id` and reject non-repair launches
   when a dispatch cell is enforced.
5. Add deploy verification checks for open `widen` cells.
6. Add Torghut mirror fields for open `external_capital` cells.

## Validation Gates

Required local validation for implementation PRs:

- `bun run --filter jangar test -- control-plane-status`
- `bun run --filter jangar test -- control-plane-execution-trust`
- `bun run --filter jangar test -- supporting-primitives-controller`
- `bunx oxfmt --check services/jangar/src docs/agents/designs`
- a read-only deployed check showing `/ready` still serves while the status route exposes open cells when execution
  trust is degraded.

Required deployer validation:

- capture the release digest, `authority_clearance.digest`, and open-cell count before rollout widening;
- prove that disabling enforcement leaves cell emission intact;
- prove that a close proof clears only the matching action class and digest;
- verify that least-privilege workers can read the projection without `pods/exec`.

## Rollout Plan

1. **Shadow emission:** compute cells and expose them in status without changing scheduling or deploy behavior.
2. **Read-path authority:** make deploy verification, Jangar UI, and Torghut mirrors display the same digest.
3. **Repair gating:** allow repair launches to cite cells and require budgets.
4. **Dispatch/widen enforcement:** block new non-repair dispatch and rollout widening while matching cells are open.
5. **External-capital enforcement:** require Torghut to observe no open platform capital cell before broker-bound
   non-shadow admission.

## Rollback Plan

Rollback is configuration-only:

- set clearance enforcement to `shadow` or `off`;
- continue emitting cells and negative evidence;
- keep repair launches allowed under the prior action-lease policy;
- clear no historical cells during rollback;
- require a post-rollback report explaining whether the old behavior widened, dispatched, or admitted capital despite
  still-open cells.

## Risks and Tradeoffs

The main risk is operational noise. If every transient event opens a cell, teams will ignore the projection. The first
implementation should deduplicate aggressively and focus on the blockers that materially affect `dispatch`, `widen`,
and `external_capital`.

The second risk is over-blocking repair. The cell model must preserve bounded repair authority by design. A control
plane that cannot repair itself under degraded execution trust will be safer only on paper.

The tradeoff is one more durable object. I accept that because a held action without close proof is not resilience. It
is delayed ambiguity.

## Handoff Contract

Engineer acceptance gates:

- implement shadow `AuthorityClearanceCell` emission from current status inputs;
- add tests for degraded execution trust opening `dispatch` and `widen` cells while `/ready` remains OK;
- add tests for route timeout and stale empirical jobs opening consumer-specific cells;
- publish cell digests through the status route.

Deployer acceptance gates:

- do not widen a Jangar rollout while open `widen` cells match the release digest;
- do not treat Jangar database schema health as clearance for dispatch or capital;
- verify that enforcement can be disabled without disabling cell emission;
- capture open-cell evidence in release handoffs.

Torghut acceptance gates:

- treat open Jangar `external_capital` cells as a platform capital hold;
- map each platform hold to a local profit-debt record and repair experiment;
- keep shadow, replay, observe, and repair running while non-shadow capital is held.
