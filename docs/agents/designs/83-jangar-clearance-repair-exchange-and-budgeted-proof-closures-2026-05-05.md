# 83. Jangar Clearance Repair Exchange and Budgeted Proof Closures (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Gideon Park (Torghut Traders architecture)
Mission: `codex/swarm-torghut-quant-discover`

Companion Torghut contract:

- `docs/torghut/design-system/v6/87-torghut-repair-alpha-exchange-and-session-proof-budgets-2026-05-05.md`

Extends:

- `82-jangar-authority-clearance-cells-and-negative-evidence-slas-2026-05-05.md`
- `81-jangar-action-authority-ledger-and-repair-runway-2026-05-05.md`
- `81-jangar-action-lease-backplane-and-profit-evidence-exchange-2026-05-05.md`
- `80-jangar-settlement-adoption-ladder-and-cutover-governance-2026-05-05.md`

## Decision

Jangar should add a **Clearance Repair Exchange** with **Budgeted Proof Closures** above authority clearance cells.
Clearance cells correctly say which material action is held. The missing system behavior is the next step: choose the
smallest safe repair, give it an explicit budget, and require a closure proof before `dispatch`, `widen`, or
`external_capital` can reopen.

I am choosing this direction because the 2026-05-05 read-only evidence shows a control plane that can serve while
execution trust and consumer proof are still degraded:

- `/api/agents/control-plane/status` returned HTTP 200 with leader election held, rollout health healthy for
  `agents` and `agents-controllers`, and database migration consistency healthy.
- The same status returned `execution_trust.status=degraded` because the Jangar verify stage is stale, and admission
  passports for `swarm_plan`, `swarm_implement`, and `swarm_verify` were `hold`.
- `dependency_quorum.decision=block` with `empirical_jobs_degraded`.
- `kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded` showed repeated Jangar and
  Torghut scheduler attempt pods in `Error`, plus three older executor pods stuck in `ImagePullBackOff`.
- Torghut `/trading/status` was reachable, but it reported `capital_stage=shadow`, `promotion_eligible_total=0`, and
  stale empirical proof from 2026-03-21.
- Direct SQL and pod exec were unavailable to the runner because `system:serviceaccount:agents:agents-sa` cannot create
  `pods/exec` in `torghut` or `jangar`. Closure has to work through least-privilege projections.

The decision is not to make serving readiness stricter. Serving should stay available when it can safely inform
operators. The decision is to make repair authority stricter: a held action can only launch bounded repair work that
cites the open cell, spends a known budget, and produces proof for the same action class, subject, release digest, and
evidence cut.

## Scope and Success Metrics

This contract covers Jangar control-plane resilience and the cross-plane handoff to Torghut. It does not replace the
authority clearance cell model. It turns cells from passive blockers into repair demand.

Success means:

1. every open `dispatch`, `widen`, or `external_capital` clearance cell can be mapped to zero or more repair bids;
2. only selected repair bids receive a `ProofClosureWarrant`;
3. a warrant names its target cell, allowed repair class, runtime budget, retry budget, image or route proof
   requirements, expected outputs, stop condition, and rollback switch;
4. normal swarm dispatch remains held while matching dispatch cells are open, but bounded repair dispatch can proceed;
5. rollout widening requires no open `widen` cells and no expired closure warrants for the target digest;
6. Torghut can read the same closure digest without database credentials or cluster-admin reads.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Rollout Evidence

The current runner could list pods, services, jobs, and events, but not deployments, CRDs, endpoints, or `pods/exec` in
several namespaces. That matters because the architecture must be implementable with least privilege.

Observed cluster state:

- `kubectl get pods -n jangar -o wide` showed Jangar, Jangar Postgres, Redis, Open WebUI, Bumba, Symphony, and Alloy
  running. The active Jangar pod was `2/2 Running`.
- `kubectl get pods -n agents -o wide` showed current `agents` and `agents-controllers` pods running, while old and
  current scheduled stage attempts included `Error` and `ImagePullBackOff` states.
- `kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded` showed failures in `agents`,
  `kafka`, `rook-ceph`, `sealed-secrets`, and `temporal`; this is a noisy shared cluster, not a clean-room control
  plane.
- Torghut events showed rollout startup/readiness probe failures, scheduling pressure for backfills, multiple
  PodDisruptionBudget warnings for ClickHouse pods, and Flink job exceptions followed by restarts.
- Jangar control-plane status still reported rollout health healthy for configured agents deployments. That is useful
  but insufficient as a closure signal.

Interpretation: the control plane needs a repair lane that is narrow enough to run during degraded execution trust and
strict enough to avoid relaunching the same broken digest or stale proof cycle.

### Source and Test Evidence

The risk is concentrated in a few large aggregation and scheduling surfaces:

- `services/jangar/src/server/control-plane-status.ts` is 572 lines and combines controller, database, watch, workflow,
  runtime, rollout, execution-trust, dependency-quorum, and Torghut empirical-service state.
- `services/jangar/src/server/control-plane-execution-trust.ts` is 506 lines and evaluates stage freshness, stale
  windows, freezes, and failure classes.
- `services/jangar/src/server/supporting-primitives-controller.ts` is 2878 lines and owns supporting resource
  materialization, including schedules and workspace resources.
- `services/jangar/src/server/control-plane-rollout-health.ts` is 238 lines and can be correct while older action
  blockers remain unresolved.
- Existing route tests cover readiness and status behavior, but the next regression shape is repair authorization:
  degraded execution trust should open cells, select or reject repair bids, allow only warranted repair dispatch, and
  keep regular dispatch and widening held.

### Database and Data Evidence

Direct SQL was intentionally unavailable from this runner. The allowed application surfaces still gave enough state:

- Jangar reported database `configured=true`, `connected=true`, `status=healthy`, and 25 registered/applied
  migrations, latest `20260418_embedding_dimension_4096`.
- Torghut `/db-check` returned HTTP 200 with `schema_current=true`, current head
  `0029_whitepaper_embedding_dimension_4096`, and lineage warnings for historical parent forks.
- Jangar Torghut quant-health timed out after 10 seconds from this runner.
- Torghut `/trading/empirical-jobs` reported all four promotion-authority empirical jobs stale, even though they were
  truthful and persisted.

Interpretation: repair closure cannot depend on privileged SQL. It needs digest-stable route projections, artifacts,
and warrants.

## Problem

Authority clearance cells give us the right negative evidence shape, but they stop at "held." A mature control plane
must also answer:

1. Which repair is allowed while this action is held?
2. What is the maximum runtime, retry, cluster, and route budget for that repair?
3. Which proof closes the cell?
4. How do we prevent a transient success from clearing unrelated action classes?
5. How do we avoid re-running stale image digests, stale empirical jobs, or timed-out proof routes indefinitely?

Without a repair exchange, the system drifts back to manual judgement. Without budgets, automatic repair can become
another source of control-plane pressure.

## Options Considered

### Option A: Manual Clearance Queue

Operators would inspect open cells, choose repairs, and close cells after reading route or cluster evidence.

Pros:

- simple implementation;
- preserves human judgement;
- avoids new scheduling policy.

Cons:

- too slow during market-session proof windows;
- inconsistent closure criteria across deployers, Jangar, and Torghut;
- depends on operator access that least-privilege agents do not have;
- does not reduce repeated stale attempts.

Decision: reject as the architecture. Manual escalation remains the fallback for expired warrants.

### Option B: Auto-Retry Every Open Cell

Jangar would automatically retry stale stages, proof routes, and failed schedules until cells clear.

Pros:

- can clear transient failures quickly;
- keeps repair close to the controller;
- reduces manual load.

Cons:

- retries can hide persistent image-pull and proof-route failures;
- cluster pressure can worsen exactly when trust is degraded;
- repeated route timeouts produce work without information gain;
- Torghut still does not know whether a capital hold was economically repaired.

Decision: reject as the primary design. Retries need warrants and budgets.

### Option C: Clearance Repair Exchange With Budgeted Proof Closures

Jangar treats each open clearance cell as repair demand. Producers can submit repair bids, the control plane selects
bounded bids, and a `ProofClosureWarrant` authorizes only that repair. Cells close only on matching proof.

Pros:

- converts degraded-state status into owned repair work;
- lets safe repair continue while normal dispatch and widening are held;
- deduplicates repeated failures by cell digest and warrant state;
- gives Torghut one platform closure digest to consume;
- keeps closure least-privilege and auditable.

Cons:

- adds a new projection and warrant state machine;
- needs careful cooldowns to avoid repair churn;
- requires deployer gates before enforcement is safe.

Decision: select Option C.

## Chosen Architecture

### ClearanceRepairBid

Jangar should materialize repair bids from open cells and producer observations:

```text
clearance_repair_bid
  bid_id
  target_cell_id
  action_class               # dispatch, widen, external_capital
  repair_class               # stage_reclock, image_digest_attestation, route_probe_refresh, empirical_refresh
  producer                   # controller, deployer, torghut, human
  expected_close_reasons
  required_inputs
  expected_output_refs
  max_runtime_minutes
  max_retries
  cluster_pressure_cost
  capital_risk_class         # none, shadow_only, paper, live
  priority
  expires_at
```

Bids with `capital_risk_class` above `shadow_only` are invalid while the matching action class is held.

### ProofClosureWarrant

Only selected bids receive a warrant:

```text
proof_closure_warrant
  warrant_id
  target_cell_id
  target_cell_digest
  release_digest
  action_class
  repair_class
  allowed_runner
  allowed_image_digest
  allowed_route_refs
  max_runtime_minutes
  max_retries
  retry_cooldown_seconds
  close_condition
  close_proof_schema
  rollback_switch
  issued_at
  expires_at
  state                     # issued, running, proven, failed, expired, revoked
```

The warrant is the only permission to dispatch repair work while a matching dispatch cell is open. It does not reopen
normal plan, implement, verify, deploy, or capital paths.

### Closure Proof Rules

Initial closure rules should be deliberately narrow:

- `stage_stale` closes on a fresh successful stage outcome for the same swarm, stage, namespace, and release digest.
- `image_pull_backoff` closes on a digest/platform attestation and one successful pull or dry-run resolution for the
  same image reference.
- `route_probe_timeout` closes on two fresh successful typed route probes inside the route freshness window.
- `empirical_jobs_degraded` closes for `external_capital` only when Torghut reports fresh, truthful, promotion-eligible
  empirical jobs for the same candidate and dataset window.
- `privileged_sql_unavailable` never closes or blocks by itself; it records that route proof is the supported closure
  path.

### Consumer Projection

`/api/agents/control-plane/status` should expose a compact repair exchange projection:

```text
clearance_repair
  open_cell_count
  eligible_bid_count
  issued_warrant_count
  blocked_bid_count
  digest
  top_open_cells
  top_warrants
```

Torghut should consume the digest and relevant `external_capital` warrants. Deployer gates should consume `widen`
warrants. Schedulers should consume `dispatch` warrants.

## Implementation Scope

Engineer-stage implementation should land in small slices:

1. Add types and pure builders for `ClearanceRepairBid`, `ProofClosureWarrant`, and closure digests.
2. Emit a shadow repair exchange projection from existing control-plane status inputs.
3. Add tests proving degraded execution trust creates dispatch and widen cells, repair bids, and no regular dispatch
   authority.
4. Add tests proving image-pull backoff and route timeout bids are deduplicated by cell digest.
5. Add a supporting-controller admission check that allows only warranted repair dispatch while matching dispatch cells
   are open.
6. Add deploy verification checks that block widening when target-digest widen cells or expired closure warrants exist.
7. Add Torghut-facing projection fields for external-capital repair warrants and closure proof refs.

## Validation Gates

Required local validation for implementation PRs:

- `bun run --filter jangar test -- control-plane-status`
- `bun run --filter jangar test -- control-plane-execution-trust`
- `bun run --filter jangar test -- supporting-primitives-controller`
- `bunx oxfmt --check services/jangar/src docs/agents/designs`

Required deployed validation:

- `/ready` can remain HTTP 200 while the status route shows open cells and repair warrants.
- A stale verify stage opens a dispatch or widen repair bid, not normal dispatch permission.
- An image-pull-blocked digest cannot be retried without an attestation warrant.
- Least-privilege workers can read the repair projection without `pods/exec`.
- Disabling enforcement leaves repair exchange emission visible.

## Rollout Plan

1. **Shadow projection:** compute bids and warrants without admission behavior changes.
2. **UI and handoff parity:** show the same digest in Jangar UI, deploy verification, and Torghut consumer routes.
3. **Repair-only admission:** allow warranted repair dispatch while matching normal dispatch stays held.
4. **Widen enforcement:** block rollout widening when target-digest widen cells or expired warrants exist.
5. **External-capital handoff:** require Torghut to cite closed platform warrants before clearing platform profit debt.

## Rollback Plan

Rollback must keep evidence:

- set enforcement to `shadow` or `off`;
- keep bid, warrant, and closure projection emission on;
- allow prior repair-runway behavior while recording which open cells were ignored;
- revoke no historical warrants during rollback;
- publish a rollback note with open-cell count, open-warrant count, and any action class reopened despite unresolved
  proof.

## Risks and Tradeoffs

The main risk is repair churn. A repair exchange that issues a new warrant for every route timeout is worse than a
manual queue. The first version should deduplicate by cell digest, apply cooldowns, and cap cluster pressure.

The second risk is false closure. A successful route probe can clear a route cell, but it must not clear stale
empirical jobs or image-pull blockers. Closure proof has to be action-class and digest specific.

The tradeoff is slower reentry for dispatch and widening. I accept that because the current failure mode is not lack of
status. It is lack of owned, budgeted proof closure.

## Handoff Contract

Engineer acceptance gates:

- implement shadow repair bids and proof closure warrants from existing status inputs;
- add route tests for open cells, bids, warrants, and closure digests;
- add admission tests proving only warranted repair dispatch can run while matching dispatch cells are open;
- add deploy tests for target-digest widen holds.

Deployer acceptance gates:

- do not widen a release while open widen cells or expired warrants match the release digest;
- capture repair exchange digest and top warrants in release handoffs;
- verify enforcement can be disabled without hiding repair demand.

Torghut acceptance gates:

- treat an open or expired Jangar `external_capital` warrant as platform profit debt;
- clear local platform debt only when Jangar closure proof matches account/window, action class, and digest;
- keep observe, replay, shadow, and repair work running while platform capital remains held.
