# 90. Jangar Proof Capacity Leases and Route SLO Governor (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Gideon Park, Torghut Traders
Scope: Jangar control-plane resilience, swarm dispatch capacity, route SLO authority, repair-lane admission, and
Torghut quant capital dependency.

Companion Torghut contract:

- `docs/torghut/design-system/v6/94-torghut-session-edge-ledger-and-cost-aware-capital-allocator-2026-05-05.md`

Extends:

- `89-jangar-brownout-adoption-ladder-and-quant-capital-contract-2026-05-05.md`
- `88-jangar-negative-evidence-arbiter-and-brownout-governor-2026-05-05.md`
- `87-jangar-database-pressure-fuses-and-capital-authority-backplane-2026-05-05.md`
- `docs/torghut/design-system/v6/93-torghut-evidence-priced-hypothesis-market-and-capital-ladder-2026-05-05.md`

## Decision

I am choosing capacity-priced repair, not a broader freeze and not a larger retry pool.

The BrownoutAdoptionLadder says which action classes may proceed. The missing layer is capacity: how many proof jobs,
route probes, workflow pods, and database readers are allowed to run while the control plane is already showing
readiness timeouts, scheduling pressure, stale workflow proof, and route latency. Jangar should add a
**ProofCapacityLease** and a **RouteSloGovernor** between the brownout decision and any material action.

The decision is to require every repair or proof producer to cite a fresh capacity lease before it creates a CronJob,
runner ConfigMap, route probe fanout, or Torghut capital authority receipt. Serving can remain degraded-but-available.
Repair remains open only when its declared work fits the current lease. Normal dispatch, rollout widening, and Torghut
paper/live capital stay held when route SLO or pod capacity says the proof lane would amplify the failure.

The tradeoff is slower repair concurrency. I am accepting it because the current evidence says the control plane is not
short on ideas; it is short on bounded, current proof work that does not consume the same scarce capacity it is trying
to restore.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster, Rollout, and Event Evidence

- The worker identity was `system:serviceaccount:agents:agents-sa`; local `kubectl config current-context` was unset,
  but in-cluster auth worked.
- Jangar pods were Running, including active `jangar-5995cc678b-mmhtc` at `2/2` Ready, but warning events still showed
  prior Jangar app backoff, active Jangar readiness connection refusal, and `jangar-db-1` readiness HTTP 500.
- Agents runtime and both controller pods were Running, but warning events still showed recent scheduling pressure:
  `0/2 nodes are available: 1 Too many pods, 1 node(s) didn't match Pod's node affinity/selector`.
- Agents warning events also showed controller readiness/liveness failures, BackOff, BackoffLimitExceeded, stale
  ImagePullBackOff, missing runner ConfigMaps, and unexpected manual CronJob children.
- `kubectl get agentruns -n agents` showed active Jangar and Torghut discover/verify runs alongside recent succeeded
  and errored workflow attempts.
- Listing Deployments in `agents` and `jangar` remains forbidden for this identity, so the design must work from pods,
  events, AgentRuns, routes, and Jangar status projections rather than Deployment reads.

### Jangar Route and Status Evidence

- `GET http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200 in 0.442s.
- The same ready payload reported execution trust `degraded` because the Jangar control-plane verify stage and Torghut
  quant verify stage were stale.
- Runtime kits were healthy, including `/usr/local/bin/codex-nats-publish`, `/usr/local/bin/codex-nats-soak`, `nats`,
  the Jangar workspace path, and `NATS_URL`.
- Serving admission was `degrade` on `execution_trust_degraded`; `swarm_plan`, `swarm_implement`, and `swarm_verify`
  passports were `hold`.
- `GET /api/agents/control-plane/status?namespace=agents` returned HTTP 200 in 3.319s once, with database and rollout
  health `healthy`, execution trust `degraded`, and dependency quorum `block` for `watch_reliability_blocked` and
  `empirical_jobs_degraded`.
- A later status request to the same route timed out after 12 seconds, which is route SLO evidence even when `/ready`
  is green.
- Jangar quant-health for Torghut live and sim both timed out after 30 seconds with HTTP 000.

### Torghut Consumer Evidence

- Torghut live revision `torghut-00223` and sim revision `torghut-sim-00304` returned HTTP 200 for `/healthz`.
- Live `/readyz` returned HTTP 503 in 5.000s, and live `/trading/health` returned HTTP 503 in 3.838s.
- Live capital remained shadow and live submission was blocked by `simple_submit_disabled`.
- Live status returned HTTP 200 in 4.615s, but the latest decision was from `2026-05-04T17:25:57.901670Z`.
- All three hypotheses had capital multiplier `0`, zero promotion eligibility, and rollback required.
- Sim `/trading/health` returned HTTP 200 in 9.009s, but quant evidence was `quant_health_fetch_failed` because the
  Jangar quant-health route timed out.
- Options catalog `/readyz` returned HTTP 200 with `last_success_ts=null`; options enricher `/readyz` returned HTTP
  200 while carrying a `snapshot_cycle_failed` query-canceled error from `2026-05-05T18:58:31.729949Z`.

### Database and Data Evidence

- Direct CNPG SQL was blocked: `pods/exec` is forbidden in the `torghut` namespace.
- Listing Torghut secrets was also forbidden, so direct ClickHouse SQL credentials are not available to this identity.
- Torghut `/db-check` returned HTTP 200 with `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, one current head, and lineage-ready known parent-fork warnings.
- ClickHouse guardrail metrics reported both replicas up, no read-only replicated table alarm, disk free ratio above
  96%, and last successful scrape at `2026-05-05T21:13:00Z`.
- The same metrics reported max TA signal and microbar event timestamps at `2026-05-05T20:59:07Z`.
- Microbar freshness had already fallen back to the low-memory query path 161 times, while signal freshness had not.

### Source Architecture Evidence

- `services/jangar/src/server/control-plane-status.ts` is the status projection surface for heartbeat, rollout,
  database, execution trust, empirical services, dependency quorum, runtime kits, and admission passports.
- `services/jangar/src/server/control-plane-workflows.ts` already scans workflow Jobs for active runs, recent failures,
  BackoffLimitExceeded, and collection errors.
- `services/jangar/src/server/supporting-primitives-controller.ts` is the material dispatch boundary for schedules,
  runner ConfigMaps, CronJobs, workspace PVCs, and runtime admission traces.
- The high-risk Jangar control surface is concentrated: `supporting-primitives-controller.ts` is 2,878 lines,
  `control-plane-status.ts` is 572 lines, and `control-plane-workflows.ts` is 499 lines.
- Jangar has strong test surface around status and admission, including `control-plane-status.test.ts`,
  `control-plane-runtime-admission.test.ts`, `control-plane-watch-reliability.test.ts`, and
  `supporting-primitives-controller.test.ts`; capacity leases should be pure and fixture-tested before route wiring.

## Problem

The current design family correctly separates serving, repair, dispatch, rollout, and capital. It does not yet decide
how much repair is safe when the evidence says the cluster is capacity-constrained.

That matters because the same system is now producing both the block and the repair work:

1. Jangar can serve `/ready` while status and quant-health routes are slow or timing out.
2. Swarm stages are held by stale execution trust, but new repair jobs still need pods, ConfigMaps, database reads, and
   route probes.
3. The agents namespace shows scheduling pressure and readiness timeouts while the swarm is trying to run multiple
   discover, plan, implement, and verify lanes.
4. Torghut needs empirical refresh and quant-health repair, but those repairs are not free; they consume route and
   database capacity.

Without a capacity lease, repair becomes another uncontrolled source of load. Without a route SLO governor, a route can
be treated as usable just because one sample returned HTTP 200.

## Alternatives Considered

### Option A: Raise Concurrency and Retry Limits

Increase workflow concurrency, route timeouts, database pool limits, and retry budgets so repair has more chances to
complete.

Pros:

- Simple operational knob.
- May reduce transient failures during quiet periods.
- Does not require a new policy object.

Cons:

- Can make pod pressure, database pressure, and route latency worse during incidents.
- Does not distinguish repair work from normal dispatch.
- Lets every proof producer assume capacity exists.
- Gives Torghut no bounded reason to trust or reject a capital authority projection.

Decision: reject as architecture. Use only as measured tactical tuning after capacity receipts exist.

### Option B: Freeze All Proof Until Routes Are Fast

Stop repair and proof producers whenever Jangar status, quant-health, or workflow readiness misses an SLO.

Pros:

- Conservative.
- Easy for deployers to reason about.
- Prevents repair work from amplifying the outage.

Cons:

- Prevents the very jobs needed to clear stale empirical and execution-trust proof.
- Encourages manual bypass because it blocks zero-notional work and capital work equally.
- Does not rank which repair should consume the next available pod or query budget.

Decision: keep only as an emergency brake.

### Option C: ProofCapacityLease and RouteSloGovernor

Admit repair and proof work only when it has a fresh lease that names its capacity class, route budget, database budget,
expected receipt, and expiry. Separately track route SLO posture so slow or timed-out proof routes can hold dispatch and
capital while still allowing bounded repair.

Pros:

- Converts degraded trust into a small number of capacity-priced repairs.
- Prevents repair lanes from competing blindly with serving and controller health.
- Gives Jangar a concrete enforcement point before CronJob and ConfigMap materialization.
- Gives Torghut a route SLO input for capital decisions instead of a route-local guess.
- Works with least-privilege evidence: pods, events, AgentRuns, routes, and status projections are enough.

Cons:

- Adds another policy object and expiry discipline.
- May underutilize the cluster until the first lease weights are tuned.
- Requires shadow comparison before enforcement to avoid starving legitimate repair.

Decision: select Option C.

## Chosen Architecture

### ProofCapacityLease

```text
proof_capacity_lease
  lease_id
  namespace
  swarm_name
  action_class              # observe, repair, dispatch, rollout_widen, paper_submit, live_submit
  producer_class            # workflow_job, route_probe, empirical_job, quant_health, torghut_data_quality
  max_concurrent_pods
  max_new_configmaps
  max_route_ms
  max_database_ms
  max_rows_read
  node_pressure_posture     # normal, constrained, saturated
  required_output_receipt
  reason_codes
  issued_at
  fresh_until
```

Rules:

- `serve` does not need a proof lease. It is governed by `/ready` and serving admission.
- `repair` must cite the blocker it clears and the receipt it will produce.
- `dispatch` and `rollout_widen` require healthy route SLO and non-saturated pod capacity.
- `paper_submit` and `live_submit` require Torghut capital receipts plus a healthy route SLO for the referenced
  authority projection.
- A lease expires quickly. Expired repair work must stop creating new pods, ConfigMaps, and route fanout.

### RouteSloGovernor

```text
route_slo_governor
  route_ref
  consumer_class
  success_count
  timeout_count
  p50_ms
  p95_ms
  latest_http_code
  latest_error
  posture                  # normal, cache_only, repair_only, hold, block
  action_classes_held
  fresh_until
```

Rules:

- A route timeout is material evidence even if a later `/ready` sample is green.
- Quant-health HTTP 000 holds Torghut paper/live capital and prioritizes quant-health repair.
- Status route p95 above budget holds normal swarm dispatch when the same window also shows scheduling pressure.
- Cache-only serving is allowed for dashboards, but material action must cite a fresh route SLO receipt.

### Capacity-Aware Admission

The supporting primitives controller should evaluate the current BrownoutAdoptionLadder, ProofCapacityLease, and
RouteSloGovernor before materializing schedules:

1. normal stage schedules are held when execution trust is degraded or route SLO is `hold`;
2. repair schedules are admitted only when annotated with target blocker, expected receipt, and lease ID;
3. runner ConfigMaps and CronJobs inherit the lease ID as an annotation;
4. status projection exposes current capacity posture without deep request-time scans.

## Engineer Scope

1. Add pure builders for `ProofCapacityLease` and `RouteSloGovernor`.
2. Build fixtures for pod scheduling pressure, route timeout, database readiness 500, stale execution trust, and healthy
   recovery.
3. Project capacity posture into control-plane status and `/ready` as compact fields only.
4. Add shadow evaluation before schedule materialization in `supporting-primitives-controller.ts`.
5. Add repair annotations for target blocker, expected receipt, max route milliseconds, max database milliseconds, and
   lease expiry.
6. Feed Torghut with a capital-relevant route SLO posture while keeping enforcement off until shadow data is clean.

## Validation Gates

- Unit test: `Too many pods` scheduling pressure lowers node posture and denies normal dispatch without denying
  leased repair.
- Unit test: quant-health HTTP 000 creates `RouteSloGovernor.posture=hold` for `paper_submit` and `live_submit`.
- Unit test: a stale verify-stage execution-trust window holds `swarm_verify` unless a repair lease targets that stage.
- Unit test: expired repair leases cannot create new runner ConfigMaps or CronJobs.
- Integration test: control-plane status can return HTTP 200 while dispatch is held by route SLO or capacity posture.
- Integration test: a repair schedule with matching lease annotations is admitted under the same brownout that holds a
  normal schedule.
- Deployer smoke: after rollout, read `/ready`, control-plane status, AgentRuns, and recent events; verify every active
  repair pod has a lease ID and expected receipt.

## Rollout Plan

1. Ship builders and status projection only.
2. Run one swarm schedule cycle in shadow mode and record denied/allowed decisions.
3. Enforce capacity leases for repair schedules while normal dispatch remains governed by existing admission.
4. Enforce normal dispatch holds when route SLO is `hold` or node posture is `saturated`.
5. Add rollout widening holds after deployer smoke confirms the projection stays fast.
6. Expose the capital-relevant posture to Torghut before any paper/live enforcement.

## Rollback Plan

- Disable capacity enforcement and keep route SLO projection.
- If projection destabilizes `/ready`, remove it from `/ready` and keep it on control-plane status only.
- If repair is starved, temporarily allow one repair lease per swarm and hold all normal dispatch.
- If persistence adds database pressure, keep the latest lease and route SLO in memory with short expiry.
- If Torghut consumption regresses, Torghut must fail closed for paper/live and ignore the capacity posture.

## Handoff Contract

Engineer acceptance:

- Policy builders are pure, deterministic, and fixture-tested before controller wiring.
- No material schedule is admitted in enforcement mode without either normal capacity posture or a fresh repair lease.
- Route SLO decisions must include latest sample time, expiry, route ref, action classes held, and reason codes.

Deployer acceptance:

- Do not widen Jangar or Agents rollouts when route SLO is `hold` or node posture is `saturated`.
- Do not treat a single HTTP 200 route sample as proof that dispatch or Torghut capital may proceed.
- Before enabling Torghut paper capital, require healthy route SLO for the authority projection and no active capital
  hold from the brownout ladder.

Open risks:

- Early lease weights may be too conservative. Start with shadow decisions and publish denied work counts.
- Least-privilege RBAC still blocks direct Deployment and SQL evidence, so capacity posture depends on pod, event,
  AgentRun, route, and exported metric projections.
- Route SLO receipts must not become another expensive route. They should be cached projections with bounded expiry.
