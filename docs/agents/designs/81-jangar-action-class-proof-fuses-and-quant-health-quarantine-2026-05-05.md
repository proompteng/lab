# 81. Jangar Action-Class Proof Fuses and Quant-Health Quarantine (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Gideon Park (Torghut Traders architecture)
Mission: `codex/swarm-torghut-quant-discover`

Companion Torghut contract:

- `docs/torghut/design-system/v6/85-torghut-proof-fresh-profitability-governor-and-causal-replay-quarantine-2026-05-05.md`

Extends:

- `80-jangar-settlement-adoption-ladder-and-cutover-governance-2026-05-05.md`
- `79-jangar-control-plane-proof-runway-and-consumer-gated-rollout-2026-05-05.md`
- `78-jangar-capital-warrant-issuer-and-route-independent-order-admission-2026-05-05.md`
- `77-jangar-evidence-settlement-authority-and-data-proof-handoff-2026-05-05.md`

## Decision

Jangar should make quant-facing control-plane decisions by action class, not by one global readiness answer. The
selected direction is an **Action-Class Proof Fuse** with a dedicated **Quant-Health Quarantine** for Torghut capital
consumers. Serving, observe, repair, replay, dispatch, rollout widening, paper submission, and live capital submission
must each receive an explicit decision tied to a proof epoch, route probe evidence, runtime image evidence, and data
freshness evidence.

I am choosing this because the current system can be route-healthy and database-healthy while still being unfit for
dispatch widening or external capital. The May 5 evidence is clear:

- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status="ok"` with leader election healthy.
- `GET /api/agents/control-plane/status?namespace=agents` reported the Jangar database `healthy`, migration
  consistency `healthy`, 25 registered migrations, and 25 applied migrations.
- The same status payload showed stage staleness for `jangar-control-plane` discover, plan, and verify.
- `GET /api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m` timed out after 12 seconds
  with no bytes returned.
- `kubectl get jobs -n agents` showed fresh running jobs mixed with failed jobs, stale scheduled work, and old
  image-pull-blocked attempts.
- `kubectl get events -n agents` showed `MissingJob`, `UnexpectedJob`, readiness timeouts, `ImagePullBackOff`, and
  `BackoffLimitExceeded` around Jangar and Torghut swarm work.
- Direct SQL into both Jangar and Torghut databases was blocked by service-account RBAC because the runner cannot
  create `pods/exec`.

The decision is to preserve serving and repair while failing closed for higher-risk action classes whenever proof is
stale, route-specific probes time out, or runtime image evidence does not match the promoted digest. This is stricter
than the settlement adoption ladder because it defines the consumer-facing fuse shape that Torghut can automate
against.

## Problem

Jangar has accumulated the right reliability concepts: settlement epochs, runtime kits, admission passports, execution
trust, rollout health, and Torghut mirrors. The remaining failure mode is composition. A consumer can still read a
healthy serving route, a healthy database status, or a recently completed manual job and treat that as enough evidence
to proceed with a riskier action.

That is wrong for Torghut quant. A healthy Jangar route should allow dashboards and repair. It should not imply:

1. scheduled stages are fresh;
2. stale or image-pull-blocked jobs have been quarantined;
3. the quant-health route can answer within its budget;
4. Torghut empirical evidence is fresh enough to widen capital;
5. a database shell is available for privileged proof.

The current control plane needs a bounded decision object that states what is allowed, what is held, and why.

## Evidence Snapshot

### Cluster and Rollout Evidence

The read-only cluster assessment showed mixed health:

- Jangar application pods were running, including the promoted `jangar-75b8d8cdf-6pznq` pod.
- Jangar events showed rollout churn and readiness probe failures during recent promoted-image turnovers.
- The Jangar database pod was running, but events still recorded a recent `jangar-db-1` readiness probe HTTP 500.
- Agents controller pods were running, but namespace events still recorded recent readiness probe timeouts on
  `agents`, `agents-controllers`, and long-running swarm jobs.
- Older scheduled jobs referenced digests that were no longer pullable, while newer manual jobs on the promoted digest
  completed.

Interpretation: route serving has recovered enough for operators, but rollout-derived proof is inconsistent. A
consumer must not collapse those signals into a single green bit.

### Source and Test Evidence

The high-risk source surfaces are broad and shared:

- `services/jangar/src/server/control-plane-status.ts` assembles database, controller, workflow, dependency, runtime
  kit, admission passport, stage, and rollout evidence.
- `services/jangar/src/server/control-plane-execution-trust.ts` evaluates freshness and trust for scheduled work.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule-runner command generation and watches.
- `services/jangar/src/routes/ready.tsx` intentionally keeps serving readiness narrower than promotion health.

The line-count pass reinforces the blast radius: `control-plane-status.ts` has 572 lines,
`control-plane-execution-trust.ts` has 506 lines, `supporting-primitives-controller.ts` has 2790 lines, and
`ready.tsx` has 175 lines. Tests exist for route readiness, control-plane status, runtime admission, watch reliability,
and Torghut quant runtime routes, but the missing acceptance shape is cross-route action-class parity.

### Database and Data Evidence

Direct SQL was unavailable because the runner service account cannot exec into the database pods. That is an important
design constraint. Promotion proof cannot depend on a privileged shell as its only path. Jangar can still rely on:

- application-level database status and migration consistency;
- route-specific probes;
- Kubernetes pod, job, and event evidence available to the runner;
- Torghut application database evidence such as `/db-check`, `/trading/empirical-jobs`, and runtime profitability
  payloads.

The design treats missing privileged SQL as an explicit input limitation, not as a global outage.

## Options Considered

### Option A: Patch Quant-Health Timeout Handling Only

Add a timeout cache around the Jangar Torghut quant-health route and return a degraded payload faster.

Pros:

- addresses the visible timeout;
- small implementation scope;
- improves operator feedback quickly.

Cons:

- does not quarantine stale jobs or image drift;
- does not define which action classes are still allowed;
- can leave deploy verification and Torghut mirrors with different decisions;
- does not solve the privileged-SQL proof gap.

Decision: reject as the architecture. It is an implementation task inside the chosen direction.

### Option B: Make Control-Plane Status Globally Blocking

Treat any stale stage, route timeout, failed job, or database-probe limitation as a global degraded or blocked state.

Pros:

- simple mental model;
- reduces accidental dispatch and rollout widening;
- easy to expose on one dashboard.

Cons:

- blocks repair and observe paths during incidents;
- hides which proof failed;
- encourages operators to bypass the global gate when they need to fix the system;
- turns route-specific quant-health timeouts into platform-wide unavailability.

Decision: reject. A global block is too blunt for a system that must keep repairing itself.

### Option C: Action-Class Proof Fuses

Emit a durable action-class decision for every consumer class. Serving and repair can remain allowed while dispatch,
rollout widening, and external capital are held until fresh proof exists.

Pros:

- reduces false green failure modes without halting repair;
- gives Torghut a stable contract for capital quarantine;
- makes stale jobs and route timeouts explicit evidence, not folklore;
- supports shadow comparison before enforcement;
- removes privileged SQL from the critical path.

Cons:

- requires cross-route tests and adoption work;
- temporarily carries both legacy readiness and action-class decisions;
- needs careful UI language so operators do not read `serve=allow` as `capital=allow`.

Decision: select Option C.

## Chosen Architecture

### QuantActionClassDecision

Jangar should materialize this bounded object from existing status inputs:

```text
quant_action_class_decision
  namespace
  consumer
  account
  release_digest
  proof_epoch_id
  settlement_epoch_id
  decision_digest
  observed_at
  fresh_until
  action_classes:
    serve: allow|hold|block
    observe: allow|hold|block
    repair: allow|hold|block
    replay: allow|hold|block
    dispatch: allow|hold|block
    rollout_widen: allow|hold|block
    paper_submit: allow|hold|block
    live_submit: allow|hold|block
  required_inputs
  satisfied_inputs
  blocked_inputs
  route_probe_refs
  job_quarantine_refs
  runtime_image_refs
  database_proof_refs
  privileged_sql_available
  rollback_switch
```

The first implementation can materialize this in the control-plane status route and later persist it in Postgres. The
hard requirement is monotonic semantics: a newer decision may narrow action classes immediately, but it may widen only
when every widening input is fresh for the same digest and consumer window.

### Fuse Rules

The initial rule set should be conservative:

- `serve` is allowed when `/ready` leader election and serving passport checks pass.
- `observe` is allowed when serving is allowed and read paths can answer or return explicit negative evidence.
- `repair` is allowed when serving or Kubernetes read evidence is available, even if other proof is stale.
- `replay` is allowed when Torghut database and artifact routes are schema-ready, even if live capital is held.
- `dispatch` is held when scheduled stage evidence is stale, failed, or image-pull-blocked for the active stage.
- `rollout_widen` is held when route probes time out, runtime image evidence is stale, or job quarantine is non-empty.
- `paper_submit` is held when Torghut proof freshness is stale or no executable paper evidence exists for the account.
- `live_submit` is blocked unless Torghut empirical proof, runtime profitability, quant-health, and capital warrants are
  all fresh for the same account/window/digest.

### Quant-Health Quarantine

The Torghut quant-health route should be moved behind a quarantine budget:

- timeout budget: 3 seconds for cached degraded answer, 10 seconds for background refresh;
- stale budget: at most one control-plane cycle for dispatch and rollout, at most one market-data window for capital;
- failure payload: a typed negative decision with `route_probe_timeout`, not an empty response;
- enforcement: timeout blocks `rollout_widen`, `paper_submit`, and `live_submit`, but does not block `serve` or
  `repair`.

### Job Quarantine

Jangar should summarize stale and image-pull-blocked jobs into a small quarantine ledger:

```text
job_quarantine_ref
  job_name
  stage
  image_ref
  reason_code
  first_seen_at
  last_seen_at
  active_digest_match
  blocks_action_classes
```

Old digest failures should not poison every action indefinitely. They should block dispatch or widening only when the
failure belongs to the active stage, active release digest, or a still-active retry chain. Otherwise they remain audit
evidence and cleanup work.

## Validation Gates

Engineer acceptance:

- Unit test a healthy `/ready` plus stale stages: `serve`, `observe`, and `repair` allowed; `dispatch` and
  `rollout_widen` held.
- Unit test quant-health timeout: typed negative evidence, no empty response, `live_submit=block`.
- Unit test old image-pull failures: not allowed to block `serve`; allowed to block active-stage dispatch only when the
  digest or retry lineage is current.
- Unit test missing privileged SQL: represented as `privileged_sql_available=false` and `database_proof_refs` from
  application probes.
- Integration-style route test proves `/ready`, control-plane status, deploy verification, and Torghut mirror output
  expose the same `decision_digest`.

Deployer acceptance:

- Run control-plane status against `agents` and capture action classes for the promoted digest.
- Confirm quant-health returns either a fresh success or a typed degraded response within the timeout budget.
- Confirm no rollout widening occurs when `rollout_widen` is held.
- Confirm repair jobs and diagnostics are still launchable when dispatch is held.
- Confirm Torghut sees the same `decision_digest` before capital admission is widened.

## Rollout Plan

1. Shadow mode: compute and expose `QuantActionClassDecision`, but do not enforce it.
2. Read authority: make dashboards, deploy verification, and Torghut mirrors display the decision digest and action
   classes.
3. Dispatch fuse: block new scheduled dispatch and rollout widening on held action classes while preserving repair.
4. Capital fuse: let Torghut block paper or live submission unless the decision authorizes the matching action class.
5. Cleanup: expire or garbage-collect stale job quarantine refs after the retry lineage is closed and the active digest
   has passed a clean cycle.

## Rollback

Every rung must be configuration-only:

- disable dispatch enforcement and keep shadow action-class emission;
- disable capital enforcement and keep route parity diagnostics;
- disable quant-health quarantine enforcement and keep timeout metrics;
- never delete proof, quarantine, or action-class history during rollback.

Rollback is successful only if `serve`, `observe`, and `repair` still have explicit decisions after enforcement is
disabled.

## Risks

- Operators may initially treat `serve=allow` as global health. Mitigation: all UIs and handoffs must show risky action
  classes first when any are held.
- Overly strict job quarantine can block useful dispatch. Mitigation: bind job blocks to active stage, active digest,
  and retry lineage.
- Quant-health caching can hide recovery. Mitigation: stale answers carry `fresh_until`, source timestamp, and refresh
  status.
- Privileged SQL unavailability can reduce confidence. Mitigation: application database proof is the required gate;
  direct SQL is an optional forensic input.

## Handoff

Engineer stage should implement the decision builder and route parity tests before changing enforcement. Deployer stage
should promote only through shadow, read authority, dispatch fuse, and capital fuse in that order. The first production
acceptance sample must use the current evidence class: Jangar serving healthy, stage proof partially stale, quant-health
timeout or degraded, and Torghut empirical proof stale. The expected decision is `serve=allow`, `repair=allow`,
`dispatch=hold`, `rollout_widen=hold`, `paper_submit=hold`, and `live_submit=block`.
