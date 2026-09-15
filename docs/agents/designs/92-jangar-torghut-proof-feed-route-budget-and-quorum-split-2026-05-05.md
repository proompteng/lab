# 92. Jangar Torghut Proof Feed, Route Budget, and Quorum Split (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Gideon Park, Torghut Traders
Scope: Jangar control-plane resilience, Torghut quant dependency quorum, empirical-service status, route budgets,
runtime admission, and safe repair rollout.

Companion Torghut contract:

- `docs/torghut/design-system/v6/96-torghut-control-plane-proof-feed-and-profit-route-budget-contract-2026-05-05.md`

Extends:

- `91-jangar-evidence-warrants-and-lane-local-quorum-2026-05-05.md`
- `90-jangar-proof-capacity-leases-and-route-slo-governor-2026-05-05.md`
- `docs/torghut/design-system/v6/95-torghut-hypothesis-warrant-reclocking-and-profit-repair-contract-2026-05-05.md`

## Decision

Jangar should stop using Torghut's monolithic `/trading/status` route as the primary empirical-service dependency for
control-plane quorum. It should consume a bounded **TorghutControlPlaneProofFeed** instead, with explicit route-budget
receipts and a quorum split between `platform_execution`, `proof_feed`, `repair`, and `capital`.

The current system is not down. Jangar `/health` and `/ready` serve. Agents controllers are currently two ready
replicas. Torghut liveness, readiness, DB check, empirical-jobs, profitability-runtime, and trading-health routes all
produce useful evidence through the latest private Knative revision. The failure is more specific: Jangar's
empirical-services reader still calls `http://torghut.torghut.svc.cluster.local/trading/status`, and that route timed
out after 10 seconds while narrower Torghut routes answered. Jangar then reported `empirical_services.*.message =
"torghut status unavailable"` and blocked dependency quorum, even though `/trading/empirical-jobs` had already returned
the exact stale job set, dataset lineage, and artifact refs.

I am choosing a proof-feed split rather than another global block. Jangar should ask Torghut for small, purpose-built
proof projections with declared freshness and route cost, then keep the existing broad dependency quorum only as a
compatibility summary. Capital remains fail-closed. Repair and investigation get lane-local evidence instead of being
hidden behind a heavy route timeout.

The tradeoff is another explicit contract between Jangar and Torghut. I accept that because the old contract is already
too broad: it makes a slow operational status route look like missing empirical proof, and that is the wrong failure
mode for a trading system.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Rollout Evidence

- `kubectl config current-context` was initially unset, so the worker bootstrapped an in-cluster context from the
  service-account token and CA.
- `kubectl get pods -n agents -o wide` showed `agents-c46bccb7c-jmpnx` at `1/1 Running` and two
  `agents-controllers-7cb5bfc595-*` pods at `1/1 Running`.
- `kubectl get pods -n jangar -o wide` showed `jangar-7766b4456b-q6jv8` at `2/2 Running`, with the Jangar database,
  Redis, Bumba, OpenWebUI, and Symphony pods also running.
- `kubectl get pods -n torghut -o wide` showed the latest live `torghut-00224` and sim `torghut-sim-00305` pods at
  `2/2 Running`; the earlier sim ImagePullBackOff seen in shared NATS context was no longer present.
- Agents events still showed pod-pressure scheduling failures, recent readiness probe timeouts for control-plane pods,
  and a recent `BackoffLimitExceeded` for `torghut-quant-discover-sched-gws67`.
- Jangar events showed recent rollout churn: older Jangar pods had app container backoff or readiness connection
  refusals before the current `01717359` image became ready.
- Torghut events showed live and sim revisions becoming ready after startup/readiness probe failures. ClickHouse events
  repeatedly warned that pods match multiple PodDisruptionBudgets and that the keeper PDB has no matching pods.
- Listing Deployments, ClickHouseInstallations, FlinkDeployments, Knative Services, and direct database exec was
  forbidden to `system:serviceaccount:agents:agents-sa`; the contract must work with least-privilege route/status
  evidence.

### Jangar Evidence

- `GET http://jangar.jangar.svc.cluster.local/health` returned `status="ok"`.
- `GET /ready` returned `status="ok"` while reporting `execution_trust.status="degraded"`.
- The degraded execution trust reason was precise: `jangar-control-plane:verify` is stale. The latest verify stage in
  the status payload was still `2026-04-07T15:50:00Z`.
- Runtime kits were healthy. The collaboration kit found `/usr/local/bin/codex-nats-publish`,
  `/usr/local/bin/codex-nats-soak`, `nats`, `/app/services/jangar`, and `NATS_URL`.
- Serving admission was `degrade` on `execution_trust_degraded`; `swarm_plan`, `swarm_implement`, and `swarm_verify`
  were `hold`.
- `GET /api/agents/control-plane/status?namespace=agents` returned HTTP 200 and showed healthy controller heartbeats,
  healthy database migration consistency, healthy watch reliability, healthy rollout health, and `dependency_quorum` at
  `block` because empirical services were degraded.
- In that Jangar status payload, `empirical_services.forecast`, `empirical_services.lean`, and `empirical_services.jobs`
  all pointed at `http://torghut.torghut.svc.cluster.local/trading/status` and reported `torghut status unavailable`.
- `GET /api/torghut/trading/control-plane/quant/health` timed out after 8 seconds with no bytes received.

### Torghut Evidence

- `GET http://torghut-00224-private.torghut.svc.cluster.local/healthz` returned `{"status":"ok","service":"torghut"}`.
- `GET /readyz` returned a structured degraded payload, not an outage. Postgres, ClickHouse, Alpaca, and DB schema were
  OK. The degraded causes were empirical jobs blocked, live submission disabled, and quant health not configured.
- `GET /db-check` returned `ok=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, and lineage-ready schema state with known parent-fork warnings.
- `GET /trading/health` returned structured `status="degraded"` with the same broker-safe posture:
  `simple_submit_disabled`, shadow capital, zero promotion eligibility, and dependency quorum blocked by
  `empirical_jobs_degraded`.
- `GET /trading/empirical-jobs` returned `ready=false`, `authority="blocked"`, stale-after `86400`, and the exact stale
  jobs: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Those stale jobs were completed, truthful, promotion-authority eligible, tied to dataset
  `torghut-full-day-20260318-884bec35`, candidate `intraday_tsmom_v1@prod`, and S3 artifact refs from March 21.
- `GET /trading/profitability/runtime` returned a compact 72-hour view: 8 decisions, 0 executions, 0 TCA samples, and
  all recent AAPL/AMD/INTC/NVDA decisions rejected.
- `GET /trading/status` through the same latest private revision timed out after 10 seconds with no bytes received.

### Source and Test Evidence

- `services/jangar/src/server/control-plane-empirical-services.ts` is the current Jangar reader that depends on
  Torghut status and maps empirical job posture into control-plane status.
- `services/jangar/src/server/control-plane-status.ts` combines controller heartbeats, runtime adapters, database
  health, workflow evidence, watch reliability, execution trust, runtime admission, and empirical services.
- `services/jangar/src/server/control-plane-workflows.ts` already gives Jangar a narrow, bounded workflow projection;
  empirical proof should follow the same pattern.
- `services/torghut/app/main.py` is the high-risk aggregate route at 3,981 lines and owns status, readiness, health,
  empirical jobs, profitability, TCA, Jangar dependency, market context, and live submission payloads.
- `services/torghut/app/trading/hypotheses.py` and `services/torghut/app/trading/submission_council.py` already compile
  hypothesis dependency and capital-gate reasons, including `jangar_dependency_block`, `signal_lag_exceeded`,
  `required_feature_set_unavailable`, and `quant_health_not_configured`.
- Tests already cover control-plane empirical services, control-plane status, execution trust, empirical jobs,
  hypothesis quorum loading, quant-health URL enforcement, live submission gates, and trading route parity. The missing
  target is a bounded proof-feed reader that does not require the heavy `/trading/status` route to answer.

## Problem

Jangar currently confuses a slow Torghut aggregate route with missing Torghut proof. That creates two bad outcomes at
the same time:

1. Jangar blocks dependency quorum for the right broad reason, empirical proof is stale, but cites the wrong immediate
   failure, `torghut status unavailable`.
2. Torghut has route-owned evidence that is good enough to rank repair, but Jangar cannot consume it unless the heavy
   status route also completes.

This is not just a latency problem. It is an authority problem. The control plane should distinguish:

- platform execution trust;
- Torghut proof-feed freshness;
- zero-notional repair eligibility;
- paper/live capital eligibility;
- route health of the diagnostic surfaces themselves.

The current status path flattens those into one read. That makes rollouts less reliable and makes trading repair less
profitable, because the system cannot select the next highest-value proof repair when the aggregate route is slow.

## Alternatives Considered

### Option A: Tune the Existing Status Route

Raise Torghut status timeout in Jangar, add caching inside `/trading/status`, and keep the current empirical-service
reader.

Pros:

- Lowest code delta.
- Keeps one endpoint as the operator source of truth.
- Avoids a new API contract.

Cons:

- Preserves the broad authority problem.
- Raises the cost of a route that already mixes DB reads, broker status, market context, TCA, hypothesis summaries,
  empirical jobs, quant evidence, and live submission gates.
- Makes Jangar quorum sensitive to unrelated status-route work.
- Does not give repair lanes a typed feed or route budget.

Decision: reject as the architecture. Use local route optimization only after the proof-feed split exists.

### Option B: Point Jangar at `/trading/health` or `/trading/empirical-jobs`

Replace the status URL with one narrower route and leave the rest of dependency quorum unchanged.

Pros:

- Quick fix for the current timeout.
- Uses routes that already answer with better evidence.
- Reduces Jangar read cost immediately.

Cons:

- Still leaves Jangar with one empirical bit instead of typed proof subjects.
- Does not solve quant-health timeout, route-budget attribution, or capital/repair split.
- Makes the chosen route the next overloaded aggregation point.
- Does not carry enough lineage for Torghut capital warrants.

Decision: use as the first migration step, not the final contract.

### Option C: Torghut Proof Feed and Jangar Quorum Split

Add a compact Torghut proof-feed contract, have Jangar consume it with route-budget receipts, and split quorum by action
class.

Pros:

- Makes the current stale empirical state visible without requiring `/trading/status`.
- Keeps paper/live capital closed while allowing repair to be ranked.
- Lets Jangar hold `swarm_*` admission for execution trust without hiding Torghut proof-feed facts.
- Gives deployers an SLO boundary: proof-feed stale is different from platform serving degraded.
- Preserves least-privilege operation because no direct database read is required.

Cons:

- Adds a new API and fixture set.
- Requires careful compatibility so existing status consumers keep working.
- Creates another freshness clock that must be tested and observed.

Decision: select Option C.

## Chosen Architecture

### TorghutControlPlaneProofFeed

Jangar consumes a new compact Torghut projection instead of the full trading status payload.

```text
torghut_control_plane_proof_feed
  schema_version
  generated_at
  active_revision
  route_budget
  database_schema
  empirical_jobs
  profitability_runtime
  hypothesis_summary
  live_submission_gate
  quant_evidence
  repair_candidates
  source_route_refs
  digest
  fresh_until
```

The feed is not a new capital authority by itself. It is a low-cost evidence projection with route-cost metadata and
refs to the deeper routes that produced it.

Required initial fields:

- `database_schema`: current head, expected head, lineage readiness, lineage warnings, and observed time.
- `empirical_jobs`: ready/status/authority, stale jobs, missing jobs, ineligible jobs, candidate IDs, dataset refs, and
  per-job lineage summaries.
- `profitability_runtime`: window, decision count, execution count, TCA sample count, latest decision, and rejected
  strategy/symbol counts.
- `hypothesis_summary`: total hypotheses, state totals, promotion-eligible count, rollback-required count, and quorum
  decision.
- `live_submission_gate`: allowed, reason, blocked reasons, capital stage, and configured promotion flags.
- `quant_evidence`: required, status, reason, source URL, and route failure reason.
- `route_budget`: route duration, timeout budget, cache source, producer status, and digest freshness.

### Jangar Empirical Service Reader

Jangar should read the proof feed first. The old `/trading/status` reader stays as fallback during migration, but it
cannot convert a proof-feed timeout into a false empirical conclusion.

Reader rules:

- Feed `healthy` with stale empirical jobs produces `empirical_jobs_degraded` with authoritative stale-job details.
- Feed `degraded` because route budget expired produces `torghut_proof_feed_unavailable`, not
  `empirical_jobs_degraded`.
- Feed `healthy` with no empirical lineage produces `empirical_jobs_missing`.
- Feed `healthy` with truthful expired jobs produces `expired_truthful` evidence warrants and opens only repair lanes.
- The legacy status fallback is advisory after shadow parity; it must not override a fresher proof-feed digest.

### Quorum Split

Jangar keeps the existing `dependency_quorum` summary, but adds action-scoped posture:

```text
quorum_split
  platform_execution
  proof_feed
  repair
  capital
```

Rules:

- `platform_execution` owns controller heartbeat, runtime adapters, database health, watch reliability, rollout health,
  and execution trust.
- `proof_feed` owns Torghut proof-feed freshness and route budget.
- `repair` may be `allow` when platform execution is serving/degraded, proof feed is stale but truthful, and a capacity
  lease exists.
- `capital` is `block` unless all required warrants are eligible and Torghut live-submission gates allow paper/live.
- A broad `dependency_quorum.block` remains valid when capital is blocked, but it must cite lane-local reasons and not
  hide repair eligibility.

### Runtime Admission

Runtime admission should project the split:

```text
admission_passport
  consumer_class
  decision
  reason_codes
  required_runtime_kits
  required_proof_feed_digest
  quorum_split_ref
  repair_lane_allowed
  capital_allowed
```

`swarm_plan`, `swarm_implement`, and `swarm_verify` can remain held by stale execution trust. A separate
`torghut_repair` admission class may allow bounded zero-notional repair when proof-feed evidence is fresh enough to
name the stale subjects and Jangar has capacity.

## Implementation Scope

Engineer stage:

- Add a Jangar proof-feed client near `control-plane-empirical-services.ts`.
- Add pure mapping tests proving feed states map to empirical-service and quorum-split outcomes.
- Keep the old Torghut status URL as fallback under a feature flag during shadow parity.
- Extend control-plane status with additive `torghut_proof_feed` and `quorum_split` blocks.
- Add route-budget fields to the Jangar status projection and runtime admission passport payloads.
- Do not change capital behavior in the first implementation PR; only change projection and shadow decisions.

Deployer stage:

- Roll out the proof-feed reader in shadow mode.
- Compare old status-reader and new proof-feed reader for at least one market session or one full replay window.
- Switch Jangar empirical services to proof-feed authority only when parity diffs are understood and bounded.
- Keep `swarm_*` holds on execution trust until the verify-stage staleness is resolved.

## Validation Gates

- Unit tests cover feed healthy, feed route-timeout, stale truthful empirical jobs, missing lineage, quant-health
  timeout, and degraded Jangar execution trust.
- Control-plane status tests prove stale empirical proof and proof-feed unavailability produce different reasons.
- Runtime admission tests prove repair can be allowed while capital stays blocked.
- Route smoke proves Jangar status can render when Torghut `/trading/status` times out but the proof feed answers.
- Live read-only validation records `/health`, `/ready`, `/api/agents/control-plane/status`, Torghut proof feed,
  `/trading/empirical-jobs`, `/trading/profitability/runtime`, and `/db-check`.

## Rollout

1. Add the proof-feed client and status projection behind a disabled-by-default feature flag.
2. Enable shadow reads in Jangar and publish parity diffs to logs and NATS summaries.
3. Set empirical-services authority to proof feed when parity has no capital-widening diff.
4. Add the `torghut_repair` admission class after Jangar can cite proof-feed digests.
5. Let Torghut capital consumers read the same digest only after repair shadowing proves expiry behavior.

## Rollback

- Disable the proof-feed reader feature flag and return empirical services to the legacy status reader.
- Keep proof-feed payloads in logs for audit, but do not use them for quorum or admission.
- If proof-feed mapping ever widens capital relative to legacy gates, force `capital=block`, invalidate the digest, and
  require a fresh feed sample plus route-level investigation.
- If shadow reads increase route pressure, stop Jangar shadow polling and keep only manual read-only validation until
  Torghut adds a cheaper producer cache.

## Risks

- A new feed can become stale silently if freshness is not enforced. The digest must carry `fresh_until`, and stale feed
  must block capital.
- Repair admission can become a bypass if it is not explicitly zero-notional. The repair class must prohibit broker
  submission and live capital toggles.
- The first feed may still compute too much at request time. Torghut should materialize the feed or cache it behind a
  short, explicit budget before Jangar relies on it.
- Least-privilege evidence is enough for this design, but direct SQL remains blocked. If route evidence diverges from
  database truth, the smallest unblocker is read-only SQL or a service-owned diagnostic endpoint, not broad exec.

## Handoff Contract

Engineer acceptance:

- Jangar has a pure proof-feed mapper with tests and an additive status projection.
- `empirical_jobs_degraded` is reserved for proof-feed evidence that actually says empirical jobs are stale.
- A proof-feed route timeout reports `torghut_proof_feed_unavailable` and does not fabricate empirical lineage.

Deployer acceptance:

- Shadow rollout records legacy-reader versus proof-feed parity.
- Jangar status remains available when Torghut `/trading/status` is slow.
- Repair remains zero-notional and capital remains blocked until eligible warrants exist.

Owner acceptance:

- The owner update names the current proof-feed digest, the stale empirical subjects, the route budget outcome, and the
  first bounded repair lane that can run without opening capital.
