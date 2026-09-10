# 85. Jangar Proof-Debt Exchange and Rollout Credit Windows (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Scope: Jangar material-action settlement, schedule dispatch safety, rollout widening, least-privilege proof
projection, and Torghut profitability handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/89-torghut-zero-notional-proof-runway-and-profit-debt-exchange-2026-05-05.md`

Extends:

- `84-jangar-material-action-settlement-ledger-and-slo-arbiter-2026-05-05.md`
- `84-jangar-evidence-liquidity-router-and-stale-digest-quarantine-2026-05-05.md`
- `83-jangar-lease-backed-proof-market-and-profit-aware-rollout-authority-2026-05-05.md`
- `81-jangar-action-authority-ledger-and-repair-runway-2026-05-05.md`

## Decision

Jangar should add a **Proof-Debt Exchange** and **Rollout Credit Windows** on top of the material-action settlement
ledger. A settlement record answers whether an action is allowed now. The exchange answers the next question: which
missing or stale proof should spend scarce runtime, rollback budget, and deployer attention before the action can earn
fresh credit again.

I am choosing this because the current 2026-05-05 state is not a single outage. It is a credit mismatch across
surfaces. Jangar is serving on `919848c1`, `/ready` is 200, leader election is held, rollout and watch reliability are
healthy, and the Jangar database route reports all 25 migrations applied. At the same time, execution trust is degraded
for stale plan and verify stages, dependency quorum blocks on `empirical_jobs_degraded`, the agents namespace still has
9 Error pods and 3 ImagePullBackOff pods, recent events show missing schedule input/spec ConfigMaps on failed attempts,
and `jangar-db-1` emitted a readiness HTTP 500 during the assessment window. Torghut is also live but not capital-ready:
`/trading/health` and `/readyz` return 503 under `simple_submit_disabled`, the options catalog route reports
`ready=false`, and the last 72-hour profitability window has 8 decisions, 0 executions, and 0 TCA samples.

The architecture decision is to stop treating those facts as independent status fragments. Jangar should convert them
into proof debt, price that debt by action class and service objective, and issue short rollout credit windows only
when the required debt is paid or explicitly waived. Serving, observe, and bounded repair stay available. Dispatch,
widen, and Torghut capital authority consume credit and fail closed when the credit expires.

## Scope and Success Metrics

This document is the plan-lane implementation contract. It is intentionally more specific than a strategy note because
the next engineer and deployer stages need crisp acceptance gates.

Success means:

1. Every material action class has a `rollout_credit_window_id` before execution:
   `serve`, `observe`, `repair`, `dispatch`, `widen`, `paper_submit`, and `live_submit`.
2. A credit window names the settlement digest, release digest, evidence cut, required proof producers, current debt
   items, allowed action classes, expiry, and rollback switch.
3. Stale plan/verify, ImagePullBackOff by digest, missing schedule ConfigMaps, route timeouts, database readiness
   warnings, and Torghut stale empirical proof become typed `proof_debt` rows instead of unpriced event noise.
4. Schedule dispatch cannot create or keep a runner CronJob unless the dispatch credit window includes ConfigMap
   readback, schedule template digest, service account proof, runner image digest proof, and workspace storage proof.
5. Rollout widening cannot proceed unless the widen credit window includes rollout health, execution-trust freshness,
   watch reliability, database route proof, Jangar route proof, and unresolved high-severity proof debt count of zero.
6. Torghut can use Jangar proof debt to select zero-notional proof work without receiving paper or live capital
   authority.
7. Least-privilege workers can validate all of the above through route projections, events, and status objects. CNPG
   reads, `pods/exec`, database shell access, Deployment reads, Argo Application reads, and secrets are not required.

## Evidence Snapshot

All cluster and database assessment for this pass was read-only.

### Cluster, Rollout, and Events

- `kubectl auth whoami` identified the runtime as `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar --sort-by=.status.startTime -o wide` showed 8 Running pods, including
  `jangar-847d6d7f8d-zx5sq` at `2/2 Running` on node `talos-192-168-1-85`.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200 and `status=ok`. Leader election is enabled,
  required, and held by `jangar-847d6d7f8d-zx5sq`.
- `GET /api/agents/control-plane/status?namespace=agents` reported database healthy, rollout health healthy for
  `agents` and `agents-controllers`, watch reliability healthy with 1,256 events and no errors in the 15-minute
  window, and execution trust degraded for stale `jangar-control-plane:plan` and `jangar-control-plane:verify`.
- The same route reported `dependency_quorum.decision=block` with `empirical_jobs_degraded`.
- `kubectl get pods -n agents -o json` grouped to 14 Completed, 9 Error, 3 ImagePullBackOff, and 8 Running pods.
- `kubectl get events -n agents --sort-by=.lastTimestamp` showed current `919848c1` jobs pulling successfully, old
  `eba3d511` and `86423d3e` digests still in image-pull backoff, `BackoffLimitExceeded` on plan/verify attempts, and
  missing `*-spec` and `*-inputs` ConfigMaps for older Torghut verify pods.
- `kubectl get events -n jangar --sort-by=.lastTimestamp` showed the current `919848c1` rollout, a transient startup
  readiness failure, a Redis liveness timeout, and a recent `jangar-db-1` readiness probe HTTP 500.
- `kubectl get pods -n torghut --sort-by=.status.startTime -o wide` showed 27 Running pods: live Torghut, sim
  Torghut, Postgres, ClickHouse, Keeper, Flink task managers, TA workers, options services, websocket forwarders,
  Symphony, and exporters.
- Torghut events showed revisions `torghut-00219` and `torghut-sim-00300` becoming ready, completed migration and
  backfill jobs, scheduling pressure for backfills, Flink checkpoint exceptions, and repeated multiple-PDB warnings on
  ClickHouse pods.

Interpretation: workload liveness is usable, but dispatch, widening, and capital authority have debt that should be
priced and paid down before new action credit is granted.

### Source Architecture and Test Evidence

- `services/jangar/src/server/control-plane-status.ts` composes controller health, heartbeat authority, rollout health,
  workflow reliability, execution trust, database status, watch reliability, dependency quorum, empirical services, and
  runtime admission. It is the right aggregator but still returns status, not spendable action credit.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already emits runtime kits and admission passports.
  It correctly converts degraded execution trust into `hold` decisions for swarm plan, implement, and verify consumers.
  The missing layer is durable credit with debt accounting and expiry per action class.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule ConfigMaps, runner CronJobs, admission
  traces, swarm schedule generation, requirement dispatch, workspace PVC lifecycle, and watches. It is the correct first
  enforcement point for dispatch credit.
- That controller calls `kube.get('persistentvolumeclaim', ...)`, `kube.delete('persistentvolumeclaim', ...)`, and
  watches `persistentvolumeclaim`, while `services/jangar/src/server/primitives-kube.ts` still has no built-in target
  for `persistentvolumeclaim` or `persistentvolumeclaims`. This is a first implementation task, not a documentation
  nicety.
- Torghut's `services/torghut/app/trading/submission_council.py` already models typed quant-health, proof-aware
  submission gates, and capital stages. Its current runtime output proves that the gate can hold capital while the app
  serves.
- Existing tests cover status, runtime admission, supporting schedules, primitives kube behavior, Torghut submission
  council, quant-health parsing, and trading API gate outputs. The missing tests are cross-surface invariants:
  `rollout_credit_window.decision` must match schedule reconciliation, deploy verification, and Torghut capital
  projection for the same evidence cut.

### Database, Schema, and Data Evidence

- Direct CNPG cluster reads are blocked in both `jangar` and `torghut`:
  `clusters.postgresql.cnpg.io is forbidden` for `system:serviceaccount:agents:agents-sa`.
- Direct SQL is blocked in both namespaces because the same identity cannot create `pods/exec`.
- Jangar route-level database proof is healthy: `configured=true`, `connected=true`, `status=healthy`,
  `latency_ms=19`, 25 registered migrations, 25 applied migrations, and latest applied migration
  `20260418_embedding_dimension_4096`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, lineage ready, and historical parent-fork warnings for
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/trading/health` returned HTTP 503 with `live_submission_gate.ok=false`,
  `reason=simple_submit_disabled`, and `capital_stage=shadow`, while scheduler, Postgres, ClickHouse, Alpaca, universe,
  database, and optional quant evidence were usable.
- Torghut `/trading/status` reported `mode=live`, `execution_lane=simple`, and `live_submission_gate.allowed=false`.
- Torghut `/trading/empirical-jobs` reported 4 completed empirical jobs but `status=degraded` and
  `authority=blocked`.
- Torghut `/trading/profitability/runtime?hours=72` reported a 72-hour window with 8 decisions, 0 executions, and 0
  TCA samples.
- Torghut sim `/trading/health` returned HTTP 200 but still reported `jangar_status_fetch_failed` and
  `quant_health_fetch_failed` in its proof payload, which is exactly the kind of route debt the exchange should price.
- `torghut-options-catalog /readyz` returned HTTP 503 with `ready=false` and `last_success_ts=null`; the options
  enricher returned HTTP 200 with a successful timestamp.

Interpretation: the database surfaces are good enough for least-privilege route proof, but the data proof is not fresh
enough for capital. Jangar should record that distinction directly.

## Problem

Jangar has been improving the raw facts: runtime kits, admission passports, settlement ledgers, repair warrants, route
health, database proof, and dependency quorum. The remaining problem is debt accounting.

Today the same evidence can be read three different ways:

1. The serving path says Jangar is up.
2. The workflow path says plan and verify are stale.
3. The trading path says Torghut can run but cannot trade.

All three are correct. The system failure is that no shared object tells consumers which debt must be paid before a
specific action class receives fresh authority. Without that shared credit window, the platform either freezes too
broadly, retries stale work too freely, or asks humans to manually correlate events, route payloads, and database proof.

## Alternatives Considered

### Option A: Patch The Local Gaps

Add PVC aliases to `primitives-kube`, require ConfigMap readback before CronJob creation, quarantine old image digests,
and tighten Torghut readiness docs.

Pros:

- directly fixes real defects;
- small implementation PRs;
- lowers the chance of missing ConfigMap and image-pull repeats;
- gives immediate value to the supporting primitives controller.

Cons:

- does not give deployers one least-privilege action proof;
- leaves stale empirical proof and route timeouts as status fragments;
- cannot prioritize which proof debt should spend limited market-session time;
- does not bind Torghut capital holds to the same credit window as Jangar dispatch and rollout.

Decision: do it as the first engineering slice, but do not stop there.

### Option B: Global Freeze Until All Debt Clears

Block all schedules, rollout widening, and Torghut paper/live work while any stale stage, image-pull debt, route debt,
or empirical proof debt exists.

Pros:

- clear incident posture;
- sharply lowers false-positive action authority;
- simple deployer switch.

Cons:

- prevents bounded repair work that would clear debt;
- treats old image digests, route timeouts, and stale empirical jobs as equivalent;
- wastes market-session opportunities for zero-notional replay and falsification;
- increases the odds of manual bypass because the default is too blunt.

Decision: keep as an emergency brake only.

### Option C: Proof-Debt Exchange With Rollout Credit Windows

Persist debt records from evidence producers, price them by action class and SLO, and issue short-lived rollout credit
windows for actions whose required debt is paid, waived, or explicitly scoped to repair.

Pros:

- separates serving, repair, dispatch, rollout widening, and capital authority;
- creates one route-level proof object for least-privilege deployers;
- turns stale evidence into owned work with expiry and rollback;
- lets Torghut use platform debt to select safe proof work without reopening capital;
- makes failure-mode reduction measurable across the next six months.

Cons:

- adds one persistence and projection layer;
- requires shadow mode before enforcement;
- needs careful dedupe to avoid creating a second noisy event stream.

Decision: select Option C.

## Chosen Architecture

### ProofDebt

Jangar records proof debt whenever an evidence producer cannot satisfy the SLO for a consumer action class:

```text
proof_debt
  debt_id
  subject_kind                 # stage, image_digest, schedule_template, workspace, database_route, route, data_freshness
  subject_ref
  namespace
  release_digest
  evidence_cut_digest
  producer
  failure_class                # stale, missing, timed_out, forbidden, degraded, inconsistent, quarantined
  severity                     # low, medium, high, critical
  action_classes_blocked       # dispatch, widen, paper_submit, live_submit
  action_classes_allowed       # observe, repair
  observed_at
  fresh_until
  owner
  close_condition
  rollback_switch
  repair_budget
```

Debt is append-friendly but deduplicated by subject, release digest, failure class, and evidence cut. Repeated
ImagePullBackOff events for an old digest should update the same debt item, not create a new operational page every
few minutes.

### RolloutCreditWindow

A rollout credit window is the spendable authority object:

```text
rollout_credit_window
  window_id
  action_class
  subject_ref
  namespace
  release_digest
  settlement_digest
  evidence_cut_digest
  decision                    # allow, hold, repair_only, block
  allowed_until
  required_debt_closed
  tolerated_debt
  rollback_switch
  producer_revision
```

The first supported action classes are:

- `observe`: can serve status and evidence even with debt;
- `repair`: can run bounded proof-refresh or remediation work against named debt;
- `dispatch`: can create or keep schedule runner CronJobs;
- `widen`: can promote or widen rollout blast radius;
- `paper_submit`: can let Torghut submit paper orders;
- `live_submit`: can let Torghut submit live orders.

### Dispatch Settlement

For `dispatch=allow`, Jangar must prove:

- schedule target exists and has a stable digest;
- schedule template ConfigMap was applied and read back;
- runner CronJob template hash matches the schedule digest;
- schedule runner image digest matches the current release or has a non-stale attestation;
- service account and namespace match the schedule policy;
- workspace PVC aliases resolve through `primitives-kube`;
- workspace PVC, if required, is `Bound` or explicitly not required;
- plan/implement/verify admission passport for the stage is `allow`;
- no high-severity image, ConfigMap, or workspace debt blocks dispatch.

### Widen Settlement

For `widen=allow`, Jangar must prove:

- current serving route is healthy;
- rollout health is healthy for the target deployments;
- execution trust has no stale or blocked required stage;
- watch reliability is healthy inside the configured window;
- database route proof is healthy and migration-current;
- recent Kubernetes events have no high-severity readiness or image-pull debt for the release digest;
- Torghut external-capital debt is not reinterpreted as a rollout blocker unless the rollout changes Torghut-facing
  proof or capital routes.

### Torghut Consumer Projection

Jangar exposes a compact projection for Torghut:

```text
torghut_platform_credit
  release_digest
  dispatch_credit
  widen_credit
  paper_submit_credit
  live_submit_credit
  blocking_debt
  proof_refresh_candidates
```

Torghut may use `proof_refresh_candidates` for zero-notional replay and empirical refresh. It may not treat that as
paper or live capital authority.

## Implementation Scope

Phase 0, shadow:

1. Add PVC built-in targets to `services/jangar/src/server/primitives-kube.ts` and tests.
2. Add pure builders for `ProofDebt` and `RolloutCreditWindow`.
3. Project debt and credit in `/api/agents/control-plane/status` without enforcing.
4. Add dispatch-credit shadow annotations to schedule status.
5. Add a Torghut platform-credit projection route.

Phase 1, dispatch enforcement:

1. Require `dispatch=allow` before creating or keeping schedule runner CronJobs.
2. Quarantine stale image digests and missing ConfigMap debt.
3. Keep `repair` credit open for debt-specific proof refresh.

Phase 2, rollout and capital enforcement:

1. Require `widen=allow` in deployer gates.
2. Require `paper_submit=allow` before Torghut paper reentry.
3. Keep `live_submit=block` until paper proof, empirical proof, TCA proof, route proof, and operator approval converge.

## Validation Gates

Engineer gates:

- Unit tests prove PVC aliases resolve for get, list, delete, and watch consumers.
- Unit tests prove stale plan or verify creates proof debt and turns `dispatch` credit to `hold`.
- Unit tests prove missing schedule ConfigMap readback creates high-severity dispatch debt.
- Unit tests prove old image digest debt does not block observe or repair, but blocks dispatch and widen until closed or
  waived.
- Route tests prove status includes debt and credit with stable digests.
- Torghut tests prove platform-credit `repair` candidates cannot authorize paper or live submit.

Deployer gates:

- `curl /ready` can remain HTTP 200 while `dispatch` or `widen` credit is held.
- `curl /api/agents/control-plane/status?namespace=agents` exposes debt, credit, and rollback switch.
- `kubectl get events -n agents` has no fresh high-severity image-pull or missing ConfigMap debt for the target digest.
- `kubectl get pods -n agents` has no new Error/ImagePullBackOff pods for the target digest during the shadow window.
- Torghut `/trading/health`, `/readyz`, `/trading/status`, and `/trading/profitability/runtime` agree on capital hold
  while zero-notional proof work is allowed.

## Rollout

1. Ship Phase 0 in shadow mode for seven days.
2. Publish daily debt and credit summaries to Jangar status and NATS.
3. Enable dispatch enforcement for one low-risk schedule after zero false `allow` settlements.
4. Expand dispatch enforcement to all swarm schedules.
5. Add deployer `widen` gate after dispatch debt is stable for three consecutive days.
6. Add Torghut paper-submit credit only after empirical jobs, quant-health, options catalog readiness, and 72-hour
   replay proof are fresh.

## Rollback

Rollback is a feature flag and data retention decision, not a table drop:

- disable dispatch enforcement and continue writing debt/credit shadow records;
- disable widen gate and rely on current deployer checks;
- disable Torghut platform-credit consumption and keep `simple_submit_disabled`;
- quarantine a bad producer revision by ignoring its credit windows while preserving the debt log;
- revert the implementation PR if route projections cause serving instability.

## Risks

- Debt can become noisy if dedupe is weak. Dedupe must use subject, digest, failure class, and evidence cut.
- Overblocking can starve repair. The `repair` action class must stay open for bounded proof work unless authority
  integrity is unknown.
- A credit window can be misunderstood as profit approval. Torghut must label platform credit separately from capital
  credit.
- Route-level database proof can hide lower-level CNPG issues. Deployer gates should record when privileged proof is
  unavailable rather than pretending it was checked.
- The first scoring model will be conservative. That is acceptable; the cost of a false `allow` is higher than the cost
  of a held dispatch during shadow mode.

## Handoff

Engineer:

- start with PVC aliases, pure debt/credit builders, and status projection tests;
- wire dispatch shadow annotations before enforcement;
- make all digests deterministic and stable under repeated reads;
- do not require privileged Kubernetes or database access for acceptance.

Deployer:

- keep serving and repair paths open while dispatch/widen credit is shadowed;
- treat any fresh ImagePullBackOff, missing ConfigMap, or database readiness debt on the target digest as a no-go for
  widening;
- keep Torghut paper/live submit closed until the companion proof runway reports capital credit.
