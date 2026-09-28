# 91. Jangar Evidence Warrants and Lane-Local Quorum (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Gideon Park, Torghut Traders
Scope: Jangar dependency quorum, empirical proof freshness, swarm admission, route SLO, Torghut quant capital
dependency, and repair-lane rollout.

Companion Torghut contract:

- `docs/torghut/design-system/v6/95-torghut-hypothesis-warrant-reclocking-and-profit-repair-contract-2026-05-05.md`

Extends:

- `90-jangar-proof-capacity-leases-and-route-slo-governor-2026-05-05.md`
- `89-jangar-brownout-adoption-ladder-and-quant-capital-contract-2026-05-05.md`
- `88-jangar-negative-evidence-arbiter-and-brownout-governor-2026-05-05.md`
- `docs/torghut/design-system/v6/94-torghut-session-edge-ledger-and-cost-aware-capital-allocator-2026-05-05.md`

## Decision

I am choosing lane-local evidence warrants with explicit reclocking over a single global empirical-jobs block.

The live system is correctly refusing to trust stale proof, but it is doing so too coarsely. The current Jangar control
plane sees a healthy collaboration runtime kit and a serving `/health` route, yet dependency quorum is blocked by
`empirical_jobs_degraded`, execution trust is degraded by a stale verify stage, and swarm plan, implement, and verify
passports are all held. Torghut then consumes that global block and keeps every hypothesis at zero capital, even though
the empirical artifacts are truthful and have concrete lineage.

Jangar should introduce an **EvidenceWarrantRegistry** and a **LaneLocalQuorumCompiler**. A warrant is the current,
typed answer to "what evidence subject is trustworthy, stale, missing, or under repair, for which consumer lane, until
when, and at what proof cost?" Dependency quorum should stop collapsing stale empirical evidence into a global block
when the evidence can be scoped to a lane, a hypothesis, or a repair action. Dispatch and capital still fail closed.
Repair gets an explicit warrant and a bounded lease instead of an opaque retry loop.

The tradeoff is that Jangar must own more evidence vocabulary. I accept that because the alternative is worse: a
single degraded segment blocks unrelated work, hides repair priority, and forces Torghut to make capital decisions
from route-level status rather than evidence-specific authority.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Runtime Evidence

- Local `kubectl config current-context` was unset, but in-cluster read-only Kubernetes access worked.
- `kubectl get pods -n jangar -o wide` showed Jangar serving with `jangar-5b7fb54bd-xjpwm` at `2/2 Running`; the app
  container had restarted minutes earlier.
- Jangar events showed recent failed scheduling due to pod pressure and node affinity, earlier app container backoff,
  readiness connection refusals, and `jangar-db-1` readiness HTTP 500.
- `kubectl get pods -n agents -o wide` showed both agents controller pods running, but the namespace still contained
  failed Torghut/Jangar discover and verify attempts beside active workflow runs.
- `kubectl get agentrun,swarm -n agents` showed both `jangar-control-plane` and `torghut-quant` swarms active and
  ready, while individual verify/discover AgentRuns had recent `Failed`, `Error`, `Succeeded`, and `Running` states.
- Listing Deployments and StatefulSets in `jangar` and `torghut` was forbidden to the agents service account. The
  design therefore assumes the control plane must make safe decisions from pods, events, services, AgentRuns, status
  projections, and route evidence without requiring broad rollout-reader RBAC.

### Jangar Route and Status Evidence

- `GET http://jangar.jangar.svc.cluster.local/health` returned `{"status":"ok","service":"jangar"}`.
- `GET /api/agents/control-plane/status?namespace=agents` returned HTTP 200 and reported
  `dependency_quorum.decision="block"` with reason `empirical_jobs_degraded`.
- The same status payload reported `execution_trust.status="degraded"` because the `jangar-control-plane:verify`
  stage was stale; the last verify timestamp was `2026-04-07T15:50:00Z`.
- The serving passport was `degrade`; `swarm_plan`, `swarm_implement`, and `swarm_verify` passports were all `hold`
  on `execution_trust_degraded`.
- The collaboration runtime kit was healthy and explicitly found `/usr/local/bin/codex-nats-publish`,
  `/usr/local/bin/codex-nats-soak`, `nats`, `/app/services/jangar`, and `NATS_URL`.
- `GET /api/torghut/trading/control-plane/quant/health` timed out after 10 seconds with no bytes received.

### Torghut Consumer Evidence

- `GET http://torghut.torghut.svc.cluster.local/healthz` returned `{"status":"ok","service":"torghut"}`.
- `GET /trading/status` returned live mode, `running=true`, and active revision `torghut-00224`.
- Torghut status consumed Jangar dependency quorum as `block` for `empirical_jobs_degraded`.
- All three runtime hypotheses remained zero-capital: `H-CONT-01` and `H-REV-01` were shadow, `H-MICRO-01` was
  blocked, and all three had `rollback_required=true`.
- Signal lag was about 2,233 seconds against a 90 second manifest threshold, feature batch rows were zero, drift
  checks were zero, and market context freshness was unavailable for the event-reversion lane.
- `/trading/empirical-jobs` returned `ready=false`, `status="degraded"`, and `authority="blocked"` because
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` were stale.
- Those empirical jobs were not empty placeholders. They were truthful completed artifacts with dataset
  `torghut-full-day-20260318-884bec35`, candidate `intraday_tsmom_v1@prod`, March 21 creation timestamps, persisted
  empirical authority, promotion authority eligibility, and S3 artifact refs.

### Database and Data Evidence

- Direct CNPG SQL via `kubectl cnpg psql -n torghut torghut-db` was blocked because `pods/exec` is forbidden.
- Direct ClickHouse SQL via `kubectl exec -n torghut chi-torghut-clickhouse-default-0-0-0` was blocked for the same
  `pods/exec` reason.
- Listing Torghut secrets was forbidden, so the worker could not safely open a direct network SQL connection with
  database credentials.
- `GET /db-check` timed out after 8 seconds, and `GET /trading/health` returned HTTP 503.
- Service-level data evidence remained available through Torghut status, empirical-jobs, and metrics. Metrics showed
  signal lag above 2,300 seconds, zero promotion eligibility, three rollback-required hypotheses, and one runtime loop
  failure event.

### Source Architecture Evidence

- `services/jangar/src/server/control-plane-status.ts` is the aggregation point for heartbeats, runtime adapters,
  database status, workflow reliability, execution trust, empirical services, runtime admission, and dependency quorum.
- `services/jangar/src/server/control-plane-empirical-services.ts` currently reads Torghut status once and maps stale
  empirical jobs into a degraded jobs dependency.
- `services/jangar/src/server/control-plane-workflows.ts` already has the right substrate for workflow evidence:
  active jobs, failures, backoff limits, and data confidence.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already produces serving and swarm admission
  passports. It is the correct consumer of lane-local quorum once the compiler exists.
- Jangar has strong tests around control-plane status, empirical services, execution trust, runtime admission, and
  supporting-primitives schedule admission. The new warrant compiler can be pure and fixture-tested before it changes
  dispatch behavior.

## Problem

Jangar has moved from "is the platform up?" to "which material action is safe right now?" The current dependency
quorum still contains one dangerous simplification: evidence freshness can become a global binary block even when the
underlying evidence has narrower scope.

That simplification has three concrete costs today:

1. It hides the difference between `missing`, `stale but truthful`, `stale and untrusted`, and `under repair`.
2. It forces Torghut to treat every hypothesis as equally blocked by empirical freshness, even when the evidence
   lineage can identify the affected candidate, dataset, job type, and repair target.
3. It makes swarm admission choose between holding everything or allowing work without a fresh proof contract.

The control plane should preserve the safety property. It should not allow stale empirical evidence to fund paper or
live capital. But it also should not convert every stale evidence subject into a global dispatch stop when the
right answer is a small, capacity-priced repair action and a lane-local capital hold.

## Alternatives Considered

### Option A: Refresh All Empirical Jobs on a Fixed Schedule

Run the full empirical suite often enough that the stale job state rarely appears.

Pros:

- Simple operating model.
- Keeps existing dependency quorum semantics.
- Produces fresh artifacts without adding new policy types.

Cons:

- Expensive during the exact windows where Jangar is already showing pod pressure and route timeouts.
- Does not distinguish which hypothesis or consumer lane needs which empirical subject.
- Does not help when direct database checks time out or quant-health cannot answer.
- Still treats a delayed refresh as a global block.

Decision: use scheduled refreshes as one producer of warrants, not as the architecture.

### Option B: Remove Empirical Jobs from Dependency Quorum

Let empirical freshness be Torghut-local and keep Jangar dependency quorum focused on platform runtime health.

Pros:

- Reduces false global blocks.
- Keeps Jangar simpler.
- Gives Torghut full ownership of capital semantics.

Cons:

- Jangar would lose visibility into a dependency that its own routes and workflows produce.
- Swarm admission could launch plan/implement work against stale empirical authority without knowing the proof debt.
- The owner channel would see fewer precise reasons for repair and rollout holds.
- Torghut would still need a typed authority source for "fresh enough for this action."

Decision: reject. Jangar should know empirical evidence posture, but it must scope it correctly.

### Option C: Evidence Warrant Registry and Lane-Local Quorum Compiler

Materialize evidence subjects as warrants, then compile dependency quorum by consumer lane and action class.

Pros:

- Keeps capital fail-closed while allowing bounded repair.
- Gives swarm admission a precise input instead of one global empirical bit.
- Lets Torghut consume warrant refs for hypothesis-local capital decisions.
- Converts stale truthful jobs into expired warrants with repair receipts, not invisible failure.
- Works with current low-privilege runtime evidence.

Cons:

- Adds a new control-plane object and expiry discipline.
- Requires migration from current aggregated dependency quorum semantics.
- Needs careful UI/API language so operators do not mistake expired truthful evidence for eligible capital proof.

Decision: select Option C.

## Chosen Architecture

### EvidenceWarrant

```text
evidence_warrant
  warrant_id
  subject_kind              # empirical_job, quant_health, signal_feed, market_context, route_slo, workflow_stage
  subject_ref
  consumer_lane             # serving, swarm_plan, swarm_implement, swarm_verify, torghut_hypothesis, torghut_repair
  action_class              # observe, repair, dispatch, paper_submit, live_submit, rollout_widen
  state                     # eligible, expired_truthful, stale_untrusted, missing, repairing
  trust_level               # authoritative, advisory, placeholder, unavailable
  evidence_hash
  lineage_ref
  produced_at
  observed_at
  fresh_until
  repair_by
  repair_receipt_ref
  route_slo_ref
  proof_capacity_lease_ref
  reason_codes
```

Rules:

- `eligible` may fund only the action classes named by the warrant.
- `expired_truthful` can support analysis and repair priority, but cannot fund paper/live capital.
- `missing` and `stale_untrusted` block the lane that requires them and create repair demand.
- `repairing` must cite a fresh proof capacity lease and the receipt expected from the repair.
- A warrant without `lineage_ref` is never authoritative for Torghut capital.

### LaneLocalQuorumCompiler

The compiler consumes warrants and emits two projections:

- `dependency_quorum`: the existing coarse projection for compatibility, with `decision`, `reasons`, and
  `degradation_scope`.
- `lane_quorum`: a new typed projection keyed by consumer lane and action class.

Initial lanes:

- `serving`: Jangar HTTP serving and OpenAI-compatible routes.
- `swarm_plan`: planning and discover-stage proof work.
- `swarm_implement`: code or config implementation work.
- `swarm_verify`: verification work and release proof.
- `torghut_repair`: zero-notional empirical, quant-health, route, and data repair.
- `torghut_capital`: Torghut paper/live capital authority.

Compiler rules:

- Serving may degrade on expired empirical warrants but does not block solely on them.
- Swarm plan and implement hold on stale verify execution trust, but repair work can be admitted under
  `torghut_repair` when it has a capacity lease.
- Torghut capital blocks on any required warrant that is not `eligible`.
- A global `block` is reserved for platform-wide data absence, unavailable workflow runtime, database pressure above
  the configured budget, or evidence contradictions across independent authorities.

### Runtime Admission Changes

Runtime admission should keep the current passports and add warrant refs:

```text
admission_passport
  admission_passport_id
  consumer_class
  decision
  reason_codes
  required_runtime_kits
  required_evidence_warrants
  lane_quorum_ref
  proof_capacity_lease_ref
  fresh_until
```

Admission behavior:

- `serving`: `allow` or `degrade` can continue without empirical capital warrants.
- `swarm_plan` and `swarm_implement`: `hold` remains correct while verify evidence is stale, except for bounded repair
  runs that cite a `torghut_repair` lane quorum.
- `swarm_verify`: verify lanes must cite a fresh workflow-stage warrant or produce the repair receipt that reclocks it.
- `torghut_capital`: no paper/live handoff can proceed without eligible empirical, quant-health, signal, and route SLO
  warrants for the target hypothesis.

## Measurable Hypotheses

1. Lane-local quorum will reduce avoidable global blocks: within one week of shadow rollout, expired empirical jobs
   should block `torghut_capital` while allowing at least one `torghut_repair` warrant to be admitted under capacity.
2. Evidence reclocking will improve proof freshness: empirical job warrants should move from `expired_truthful` to
   `eligible` within the configured repair SLA or emit a failed repair receipt with exact blocker reason.
3. Route SLO isolation will reduce slow-status blast radius: a timed-out quant-health route should block capital and
   quant repair fanout, but it should not change Jangar serving from available to unavailable.
4. Operator diagnosis will improve: the owner channel and Jangar UI should name subject refs, lineage refs, and repair
   receipts instead of only `empirical_jobs_degraded`.

## Implementation Scope

Engineer stage:

- Add a pure warrant model and compiler under `services/jangar/src/server/control-plane-evidence-warrants.ts`.
- Convert `resolveEmpiricalServices()` output into warrants for each empirical job type, preserving job_run_id,
  dataset_snapshot_ref, candidate_id, artifact refs, stale state, and truthfulness.
- Extend `buildControlPlaneStatus()` to include `evidence_warrants` and `lane_quorum` while keeping the existing
  `dependency_quorum` shape stable.
- Extend runtime admission snapshot generation to include required warrant refs on passports.
- Add unit tests for expired truthful empirical jobs, missing jobs, route timeout, verify-stage staleness, and
  repair-only admission.
- Do not mutate Kubernetes or database state in the compiler.

Deployer stage:

- Roll out the new status fields in shadow mode first.
- Keep current dependency quorum decisions authoritative during shadow mode.
- Enable lane-local admission only for `torghut_repair` after status samples show warrants are fresh, bounded, and
  explainable.
- Do not allow `torghut_capital` to consume lane-local warrants until Torghut implements the companion hypothesis
  warrant reclocking contract.

## Validation Gates

- Unit tests prove `expired_truthful` empirical warrants block `torghut_capital` and allow only capacity-leased repair.
- Unit tests prove `missing` and `stale_untrusted` evidence does not become eligible through reclocking.
- Control-plane status tests prove old `dependency_quorum` fields remain backwards-compatible.
- Runtime admission tests prove plan/implement/verify passports keep holding on stale execution trust outside repair
  lanes.
- Route tests prove quant-health timeout produces a route warrant with action-specific blockers.
- A read-only cluster smoke validates `/health`, `/api/agents/control-plane/status?namespace=agents`, Torghut
  `/trading/status`, and `/trading/empirical-jobs` after deploy.

## Rollout

1. Ship warrant models and status projection in shadow mode.
2. Publish NATS/Jangar status updates naming the top expired or missing warrants and their repair lanes.
3. Add UI/API rendering for lane quorum after the API shape is stable.
4. Enable `torghut_repair` lane-local admission with a small proof capacity lease.
5. Enable Torghut capital consumption only after the companion Torghut ledger can cite warrant refs.
6. Remove the global empirical-jobs block only after historical status samples show no unexplained capital widening.

## Rollback

- Disable lane-local quorum enforcement and return to the current global dependency quorum projection.
- Keep warrant generation visible for forensics; do not delete emitted evidence history.
- If repair lanes amplify pod pressure or route latency, set `torghut_repair` lane quorum to `hold` while preserving
  serving and status routes.
- If a warrant incorrectly marks stale evidence as eligible, treat that as a capital safety incident: block
  `torghut_capital`, invalidate affected warrant refs, and require a fresh empirical repair receipt.

## Risks

- The first warrant taxonomy may overfit current empirical jobs. Keep subject kinds open but reject untyped strings in
  capital paths.
- A stale but truthful warrant could be misread as capital-eligible. UI and API labels must keep `expired_truthful`
  separate from `eligible`.
- Low-privilege evidence can miss Deployment rollout details. The design intentionally avoids needing that RBAC, but
  deployers should still correlate with Argo/rollout views when available.
- Repair lanes can still create load. They must cite proof capacity leases and route budgets before admission.

## Handoff Contract

Engineer acceptance:

- The PR adds the warrant compiler, status projection, runtime admission refs, and focused tests.
- Existing status consumers continue to read `dependency_quorum` unchanged.
- Fixture tests cover stale truthful empirical jobs from March 21, Jangar verify staleness, quant-health timeout, and
  repair-only admission.

Deployer acceptance:

- Shadow status includes warrants for all four empirical job types and a lane-local quorum projection.
- `torghut_repair` can be enabled without admitting `torghut_capital`.
- Rollback is one feature flag or config toggle that restores global quorum enforcement.

Owner acceptance:

- The owner channel receives a concise handoff naming the current global blocker, the lane-local replacement, the
  first repair warrant, and the exact capital gate that remains closed.
