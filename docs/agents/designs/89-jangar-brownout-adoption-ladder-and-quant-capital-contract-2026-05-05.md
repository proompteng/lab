# 89. Jangar Brownout Adoption Ladder and Quant Capital Contract (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Gideon Park, Torghut Traders
Scope: Jangar control-plane resilience, brownout enforcement sequencing, repair lane budgeting, and Torghut quant
capital authority.

Companion Torghut contract:

- `docs/torghut/design-system/v6/93-torghut-evidence-priced-hypothesis-market-and-capital-ladder-2026-05-05.md`

Extends:

- `88-jangar-negative-evidence-arbiter-and-brownout-governor-2026-05-05.md`
- `87-jangar-database-pressure-fuses-and-capital-authority-backplane-2026-05-05.md`
- `83-jangar-clearance-repair-exchange-and-budgeted-proof-closures-2026-05-05.md`
- `docs/torghut/design-system/v6/92-torghut-proof-cost-market-and-options-catalog-firebreak-2026-05-05.md`

## Decision

I am choosing an adoption ladder, not another all-or-nothing control-plane freeze.

Jangar should make the NegativeEvidenceArbiter and BrownoutGovernor enforceable through a staged
**BrownoutAdoptionLadder**. The ladder starts with projection and shadow decisions, then gates normal dispatch, then
rollout widening, and only then Torghut paper/live capital. Repair lanes remain open under explicit budgets.

The key addition is a **RepairLaneBudget** plus an **EvidenceShadowPrice** for each blocked action class. A brownout
posture should not merely say "hold." It should say which repair work is allowed, what evidence would clear the hold,
how expensive that repair is allowed to be, and when the decision expires. That turns degraded execution trust into a
bounded recovery program instead of a permanent status warning.

The tradeoff is complexity at the action boundary. I am accepting that tradeoff because the current cluster state shows
the safer path: Jangar can serve, but swarm plan/implement/verify remain held by stale execution trust, empirical jobs
are degraded, and Torghut capital needs a current control-plane authority before any non-shadow exposure.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster And Runtime Evidence

- The worker used `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar -o wide` showed all Jangar namespace pods Running. The active `jangar-749fcf8554-wz8hz`
  pod was `2/2` Ready, but had restarted twice, including an app restart roughly five minutes before the sample.
- Jangar warning events still showed the old bad revision failing readiness and backing off, plus a recent
  `jangar-db-1` readiness probe HTTP 500.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200.
- `GET /api/agents/control-plane/status?namespace=agents` returned HTTP 200 in 2.220s at
  `2026-05-05T20:48:05.618Z`.
- That status payload reported `rollout_health.status=healthy` for the `agents` and `agents-controllers`
  Deployments, and both runtime kits were healthy. The collaboration runtime kit now sees `codex-nats-publish`,
  `codex-nats-soak`, `nats`, the workspace path, and `NATS_URL`.
- The same payload reported `execution_trust.status=degraded` because discover, plan, implement, and verify stages are
  stale.
- Jangar dependency quorum was `block` with reason `empirical_jobs_degraded`.
- Admission passports allowed serving only in degraded mode and held `swarm_plan`, `swarm_implement`, and
  `swarm_verify` on `execution_trust_degraded`.
- `kubectl get pods -n agents -o wide` showed active discover, plan, implement, and verify swarm jobs plus older
  failed jobs, including prior Torghut quant discover and verify errors.
- Direct Deployment reads in `jangar`, `agents`, and `torghut` are forbidden for this identity. The control plane must
  keep working from least-privilege pod, event, service, route, and status projections.

### Torghut Consumer Evidence

- Torghut live revision `torghut-00222` and sim revision `torghut-sim-00303` were both Running and returned HTTP 200
  for `/healthz`.
- Live `/trading/status` returned HTTP 200 in 4.944s. It reported `last_decision_at=2026-05-04T17:25:57.901670Z`,
  active capital stage `shadow`, three hypotheses, zero promotion-eligible hypotheses, and three rollback-required
  hypotheses.
- Live `/trading/health` returned HTTP 503 in 6.208s. Postgres, ClickHouse, Alpaca, and universe checks were OK, but
  live submission was blocked by `simple_submit_disabled`.
- Live quant evidence was `quant_health_not_configured`, and the live GitOps manifest does not set
  `TRADING_JANGAR_QUANT_HEALTH_URL`.
- Jangar quant-health for live and sim with `window=5d` timed out after 25 seconds with HTTP 000.
- `/db-check` returned HTTP 200 in 0.058s with Alembic head `0029_whitepaper_embedding_dimension_4096`, a single
  current head, and known parent-fork lineage warnings.
- `/trading/empirical-jobs` returned HTTP 200 but `ready=false`, `status=degraded`, `authority=blocked`, and stale
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` jobs from March 2026.

### Database And Data Evidence

- Direct CNPG and ClickHouse pod exec is forbidden, but specific read-only secrets and service routes are available.
- ClickHouse HTTP with the Torghut service credential reported version `25.3.6.10034.altinitystable`.
- `torghut.ta_microbars` had 1,676,669 rows with max event time `2026-05-05 20:50:32.000` and max ingest time
  `2026-05-05 20:51:08.757`.
- `torghut.ta_signals` had 1,185,151 rows with max event time `2026-05-05 20:50:12.000` and max ingest time
  `2026-05-05 20:51:02.702`.
- Recent duplicate groups over the last six hours were `0` for microbars and `803` for signals.
- `options_contract_bars_1s`, `options_contract_features`, and `options_surface_features` each had zero rows.

### Source Architecture Evidence

- `services/jangar/src/server/control-plane-status.ts` is the correct projection surface for rollout health,
  execution trust, empirical services, runtime kits, and admission passports.
- `services/jangar/src/server/control-plane-workflows.ts` already reduces controller, workflow, watch, rollout, and
  empirical conditions into dependency quorum segments.
- `services/jangar/src/server/torghut-simulation-control-plane.ts` is large and route-critical at 1,740 lines, so
  quant-health proof needs cached projections and bounded request-time work.
- Torghut's control boundary is equally concentrated: `services/torghut/app/main.py` is 3,981 lines, the submission
  council is 1,196 lines, and the policy checks module is 6,072 lines. Any new authority must be pure and fixture-tested
  before it touches routes.

## Problem

Jangar now has the ingredients for safety, but not yet the adoption sequence that prevents two bad outcomes:

1. serving stays green while stale execution trust and degraded empirical jobs silently hold material work forever;
2. a broad freeze blocks the very repair jobs needed to close stale proof and clear capital holds.

Torghut exposes the same tension downstream. The broker boundary is safe because live submission is disabled and
capital is shadow. Profitability is stalled because empirical jobs are stale, quant-health times out, signal quality has
duplicate groups, and the options lane has no populated feature tables.

The platform needs a common language for this state: serve, observe, repair, dispatch, rollout, paper capital, and live
capital are different action classes. They should not share the same gate.

## Alternatives Considered

### Option A: Finish Brownout Projection Only

Expose richer brownout fields in `/ready` and `/api/agents/control-plane/status`, then ask every consumer to make the
right decision.

Pros:

- Lowest implementation risk.
- Good operator visibility.
- Easy to ship behind a route flag.

Cons:

- Leaves enforcement to each caller.
- Does not prevent new normal schedules from launching during stale execution trust.
- Does not tell Torghut which repair work remains allowed.
- Does not convert stale empirical debt into an actionable repair budget.

Decision: useful first increment, insufficient architecture.

### Option B: Global Freeze Until Execution Trust Is Healthy

Freeze normal dispatch, rollout widening, proof jobs, and Torghut paper/live capital whenever execution trust is
degraded or empirical jobs are stale.

Pros:

- Strong safety posture.
- Easy deployer rule.
- Prevents accidental capital exposure.

Cons:

- Blocks zero-notional repair and empirical refresh work.
- Creates manual bypass pressure.
- Treats an expired verify-stage proof the same as a live database outage.
- Does not improve profitability because no proof lane can earn its way out.

Decision: keep as emergency posture only.

### Option C: Brownout Adoption Ladder With Repair Budgets

Stage enforcement by action class. Keep serving and bounded repair open. Hold normal dispatch, rollout widening, and
paper/live capital until the relevant evidence clears. Price repair work with shadow prices so the next job repairs the
highest-value blocker first.

Pros:

- Converts degraded trust into bounded repair work.
- Reduces control-plane failure modes before new schedules or rollouts amplify them.
- Gives Torghut a typed capital authority instead of a route-local inference.
- Lets engineer and deployer stages validate one action class at a time.

Cons:

- Adds state and policy at material action boundaries.
- Requires expiry discipline so stale warnings do not become permanent holds.
- Needs shadow-mode telemetry before enforcement.

Decision: select Option C.

## Chosen Architecture

### BrownoutAdoptionLadder

```text
brownout_adoption_ladder
  ladder_id
  namespace
  release_digest
  adoption_stage       # projection, dispatch_shadow, dispatch_enforced, rollout_enforced, capital_enforced
  action_class         # serve, observe, repair, dispatch, rollout_widen, paper_submit, live_submit
  posture              # normal, observe, repair_only, hold, block
  shadow_decision
  enforced_decision
  reason_codes
  required_repair_receipts
  observed_at
  fresh_until
```

Rules:

- `serve` may stay normal while `dispatch`, `rollout_widen`, and capital are held.
- `repair` remains open only for jobs that declare their repair target, query budget, and proof output.
- `dispatch_enforced` blocks new normal schedule materialization but allows repair schedules.
- `rollout_enforced` blocks widening when fresh negative evidence exists for the target release.
- `capital_enforced` is last. Torghut consumes the ladder only after Jangar shadow decisions match operator judgment
  for at least one market session.

### RepairLaneBudget

```text
repair_lane_budget
  budget_id
  consumer_class       # swarm_discover, swarm_plan, swarm_implement, swarm_verify, quant_empirical, quant_data
  allowed_jobs
  max_concurrent_jobs
  max_database_ms
  max_route_ms
  max_rows_read
  expires_at
  clearing_evidence
```

Rules:

- Stale empirical jobs get repair budget only when they are the active blocker for a capital or proof decision.
- A repair job that times out or exceeds its budget lowers its next priority.
- Repair budgets are small, explicit, and expiring. They are not a side door for normal dispatch.

### EvidenceShadowPrice

```text
evidence_shadow_price
  subject_ref
  action_class
  blocker_reason
  capital_unlock_value
  failure_mode_reduction_value
  repair_cost
  priority_score
  recommended_repair
```

Shadow prices are policy outputs, not market decoration. The current state prices these repairs above normal swarm
expansion:

- refresh stale empirical jobs;
- make quant-health a cached projection instead of a 25-second request-time route;
- resolve signal duplicate groups before signal quality can clear capital;
- bootstrap options feature tables behind a firebreak before options experiments receive capital.

## Engineer Scope

1. Add pure builders for `BrownoutAdoptionLadder`, `RepairLaneBudget`, and `EvidenceShadowPrice`.
2. Project ladder state into `/api/agents/control-plane/status` with no deep request-time scans.
3. Add shadow decisions for schedule materialization, runner ConfigMap writes, CronJob creation, and rollout widening.
4. Add repair schedule annotations so Jangar can distinguish bounded repair work from normal stage execution.
5. Emit reason codes for `execution_trust_degraded`, `empirical_jobs_degraded`, `quant_health_timeout`,
   `signal_duplicate_groups_present`, and `options_feature_tables_empty`.
6. Add Torghut capital posture as a consumer projection, but do not enforce it until dispatch and rollout enforcement
   have been validated.

## Validation Gates

- Unit test: stale execution trust holds `dispatch` but leaves `serve` and explicitly annotated `repair` open.
- Unit test: empirical jobs degraded emits a high shadow price for quant empirical repair and holds paper/live capital.
- Unit test: quant-health HTTP 000 is a capital blocker but not a serving blocker.
- Unit test: signal duplicate groups and empty options feature tables appear as Torghut consumer blockers, not global
  Jangar outages.
- Integration test: status projection can return HTTP 200 while `swarm_plan` is held by the ladder.
- Integration test: a repair schedule with a matching budget is admitted while a normal schedule with the same stale
  execution trust is shadow-held, then enforced-held.
- Deployer smoke: rollout widening is blocked when the target release has fresh material negative evidence and no
  clearing repair receipt.

## Rollout Plan

1. Ship projection-only ladder state.
2. Run dispatch shadow for one full swarm schedule cycle.
3. Enforce dispatch holds for normal schedules while repair annotations remain open.
4. Add rollout widening enforcement after deployer smoke proves projection stability.
5. Expose Torghut capital posture in shadow for one market session.
6. Enforce Torghut paper before live; live capital remains disabled until the Torghut companion gates clear.

## Rollback Plan

- Disable enforcement and keep projection.
- If projection destabilizes `/ready`, remove it from `/ready` and keep it only on control-plane status.
- If repair lanes are blocked by mistake, admit only schedules annotated `repair=true` and hold all normal schedules.
- If budget persistence adds database pressure, switch to in-memory latest-state projection with short expiry.
- If Torghut consumption regresses, keep Torghut local submission gates in fail-closed mode and ignore Jangar capital
  posture.

## Handoff Contract

Engineer acceptance:

- The first implementation must be pure policy plus projection.
- Enforcement order is dispatch, rollout, then Torghut capital.
- Every repair lane must declare target blocker, budget, expected receipt, and expiry.

Deployer acceptance:

- Do not widen a rollout when ladder posture is `hold` or `block` for `rollout_widen`.
- Do not treat HTTP 200 `/ready` as permission for swarm dispatch or Torghut capital.
- Before enabling paper capital, require no `capital_hold`, fresh empirical jobs, configured quant-health projection,
  and Torghut data-quality receipts inside threshold.

Open risks:

- Shadow prices need static policy weights first; producer self-reported value should not drive admission.
- Least-privilege RBAC limits direct Deployment and SQL evidence, so the first implementation depends on status,
  event, pod, and consumer projections.
- Expiry errors can either hold too long or allow too early. Every blocker must have a test for expiry and clearing
  evidence.
