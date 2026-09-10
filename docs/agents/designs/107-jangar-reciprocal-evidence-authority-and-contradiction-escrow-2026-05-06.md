# 107. Jangar Reciprocal Evidence Authority And Contradiction Escrow (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane evidence authority, failure-domain leases, rollout safety, database/schema evidence,
Torghut capital promotion handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/111-torghut-reciprocal-evidence-authority-and-profit-escrow-2026-05-06.md`

Extends:

- `106-jangar-proof-debt-retirement-exchange-and-experiment-lease-arbiter-2026-05-06.md`
- `105-jangar-evidence-pressure-runways-and-profit-proof-budgets-2026-05-06.md`
- `75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md`

## Decision

I am choosing **reciprocal evidence authority with contradiction escrow** as the next Jangar control-plane architecture
step.

The current system is healthy enough to serve and unhealthy enough to mislead a deployer. Argo reports `agents`,
`jangar`, and `torghut` `Synced` and `Healthy`. Jangar `/api/agents/control-plane/status` at
`2026-05-06T08:24:45.805Z` reports `database.connected=true`, `database.status=healthy`, `latency_ms=8`, and
`28/28` Kysely migrations applied through `20260505_torghut_quant_pipeline_health_window_index`. The same payload
also emits failure-domain holdbacks for `dispatch_normal`, `deploy_widen`, `merge_ready`, and `torghut_capital` with
`source_schema.database_unroutable`.

That contradiction is not theoretical. The database lease evidence referenced
`pod:agents:torghut-quant-verify-sched-cron-29634232-db7gp`. The source classifier in
`services/jangar/src/server/control-plane-failure-domain-leases.ts` treated the generated suffix `-db7gp` as a database
pod token because `db` followed by a digit was accepted. A failed runner pod could therefore expire the database lease
even while the service-owned SQL probe and migration consistency check were healthy.

The selected architecture makes that class of failure a first-class control-plane state instead of a quiet reducer
accident. Jangar will publish a settled evidence verdict only after service probes, Kubernetes observations, source
classifier versions, and consumer acknowledgments agree for the requested action class. If they disagree, Jangar opens a
contradiction case. Contradiction cases allow `serve_readonly`, `dispatch_repair`, and `torghut_observe`; they hold
`merge_ready`, `deploy_widen`, and `torghut_capital` until the conflicting evidence is either repaired, superseded, or
explicitly waived with bounded rollback.

The tradeoff is more ceremony around promotion. I accept that because the system is now complex enough that "one green
surface wins" is not safe. Serving health, rollout health, database probes, and capital readiness are different facts.
The control plane should reconcile them, not make operators infer reconciliation from several partially overlapping
status payloads.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, broker settings, runtime flags, or trading state were mutated during this
assessment.

### Cluster And Rollout Evidence

- The runtime identity is `system:serviceaccount:agents:agents-sa`. I only initialized the local in-cluster kubectl
  context and verified the identity with `kubectl auth whoami`.
- `kubectl get applications -A` showed `agents`, `jangar`, and `torghut` `Synced` and `Healthy`.
- `kubectl get deploy,pods -n jangar -o wide` showed the Jangar deployment on image `a4403261`, `1/1` available, and
  the active pod `2/2 Running`.
- `kubectl get deploy,cronjob,job,pods -n agents -o wide` showed `agents=1/1`, `agents-controllers=2/2`, and the
  scheduled Jangar/Torghut swarm CronJobs active. Listing StatefulSets is forbidden for this service account.
- Agents namespace pods counted `31 Failed`, `8 Running`, and `123 Succeeded`. Jobs counted `127 Complete`,
  `27 Failed`, and `4 RunningOrPending`.
- AgentRuns counted `97 Succeeded`, `10 Failed`, `5 Running`, and `12 Template`. The failed runs were all
  `BackoffLimitExceeded`, concentrated in Jangar verify and Torghut quant discover/verify schedules.
- Recent Agents events included readiness probe timeouts on both `agents-controllers` pods and the `agents` pod, even
  though the deployments were available when sampled.
- Torghut namespace pods were running for ClickHouse, Keeper, Postgres, live and simulation Knative revisions, options
  catalog/enricher, options TA, equity TA, websocket services, guardrail exporters, Symphony, and Alloy.
- Recent Torghut events included repeated ClickHouse multiple-PDB warnings and a Flink status modification conflict on
  `torghut-options-ta`.

### Database And Data Evidence

- Direct pod exec and `kubectl cnpg psql` were blocked by RBAC:
  `pods/exec is forbidden` in `jangar` and `torghut`, and CNPG cluster listing is forbidden cluster-wide. Database
  assessment therefore uses service-owned read-only projections.
- Jangar control-plane status reported the Jangar database configured, connected, healthy, and migration-consistent:
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, `unexpected_count=0`.
- Jangar failure-domain leases simultaneously marked `database` `expired` and `source_schema` `unknown` because the
  generated runner pod `torghut-quant-verify-sched-cron-29634232-db7gp` looked like database evidence to the reducer.
- Torghut `/db-check` returned `ok=true`, Alembic head `0029_whitepaper_embedding_dimension_4096`, expected/current
  heads aligned, no duplicate revisions, no orphan parents, and account scope ready.
- Torghut schema lineage still reports known parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/readyz` and `/trading/health` returned HTTP `503`. Postgres, ClickHouse, Alpaca, database schema, and
  Jangar universe were healthy, but `live_submission_gate.allowed=false` with `simple_submit_disabled`, capital stage
  `shadow`, `promotion_eligible_total=0`, and dependency quorum blocked by `empirical_jobs_degraded`.
- Torghut `/trading/autonomy` reported stale empirical jobs:
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` over
  `intraday_tsmom_v1@prod` and dataset `torghut-full-day-20260318-884bec35`.
- Jangar typed Torghut quant health returned HTTP `200`, `latestMetricsCount=3780`, `metricsPipelineLagSeconds=0`, and
  `latestMetricsUpdatedAt` near the sample time.
- Options catalog and options enricher `/readyz` both returned HTTP `200`; the enricher reported
  `last_success_ts=2026-05-06T08:24:47.939199+00:00`.

### Source Evidence

- `services/jangar/src/server/control-plane-failure-domain-leases.ts` owns database, route, rollout, registry,
  storage, workflow-artifact, NATS, and source-schema leases. Its database pod classifier accepted `db` followed by a
  digit as a database token, which matched the live generated suffix `-db7gp`.
- `services/jangar/src/server/__tests__/control-plane-failure-domain-leases.test.ts` already covered generated suffixes
  like `cndb7` and `4dbnk`, but not the boundary case where a hyphen is followed by `db` plus more random characters.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains the largest Jangar module at `2,882` lines
  and owns schedule generation, runner CronJobs, swarms, freezes, requirements, and workspace PVC status.
- `services/jangar/src/server/primitives-kube.ts` has first-class PVC resource mapping, but the broader source risk is
  still that generic Kubernetes evidence is consumed by many reducers without classifier provenance.
- `services/torghut/app/main.py` is `4,051` lines and owns readiness, DB checks, trading health, runtime profitability,
  decisions, executions, and TCA projections.
- `services/torghut/app/trading/submission_council.py` is `1,196` lines and owns quant-health, empirical-readiness,
  capital-stage, and live-submission gate decisions.
- Tests exist for failure-domain leases, control-plane status, empirical services, quant metrics, Torghut DB readiness,
  empirical jobs, options lane, scheduler safety, and submission council. The missing regression before this change was
  the exact generated-pod false positive observed in the live failure-domain lease.

## Problem

Jangar now has enough status surfaces that contradictions can be introduced by the control plane itself:

1. A service-owned SQL probe can be healthy while Kubernetes evidence marks the database lease expired.
2. A rollout can be available while recent readiness probes are timing out.
3. Torghut can have fresh quant metrics and a healthy DB while capital promotion is correctly blocked by stale
   empirical jobs and disabled live submission.
4. A consumer can see `quant_health_not_configured` while Jangar exposes a typed quant-health endpoint.
5. RBAC can prevent direct database proof, making read-only projections the only acceptable evidence surface for this
   lane.

The current reducer model has no explicit place for "these facts disagree." It collapses the disagreement into a hold
reason, which is safe but not actionable. Operators cannot tell whether to repair the database, the pod classifier, the
quant-health wiring, or the empirical proof debt.

## Alternatives Considered

### Option A: Let The Strongest Local Probe Win

In this model, Jangar would prefer its SQL probe over Kubernetes pod evidence whenever the database is reachable and
migrations are current.

Pros:

- Simple and fast.
- Would have prevented the observed false holdback.
- Keeps the status payload small.

Cons:

- Masks real split-brain cases where the SQL probe is healthy but the database pod is terminating or under disruption.
- Still does not tell Torghut which evidence was accepted or rejected.
- Turns classifier bugs into silent bypasses.

Decision: reject. It is operationally convenient but weakens failure-mode reduction.

### Option B: Keep Failure-Domain Leases As The Sole Gate

In this model, Jangar keeps the current holdback output and engineers inspect individual evidence refs when a hold looks
wrong.

Pros:

- Already implemented.
- Conservative for merge, deploy, and capital action.
- Easy to keep in shadow mode.

Cons:

- Contradictions remain implicit.
- Debugging requires knowing reducer internals.
- Torghut gets no stable receipt explaining which proof surface must be refreshed.

Decision: reject as the next architecture step. Keep the lease set as an input to the verdict.

### Option C: Reciprocal Evidence Authority With Contradiction Escrow

In this model, Jangar emits observations, contradiction cases, and settled promotion verdicts. Consumers acknowledge the
evidence they used before promotion. Contradictions hold material action but are explicitly repairable.

Pros:

- Separates observation, contradiction, and promotion.
- Preserves conservative holds without hiding the cause.
- Gives Torghut a machine-readable evidence receipt for profit and capital decisions.
- Lets repair dispatch proceed while merge/deploy/capital remain held.
- Makes classifier versions and evidence scopes auditable.

Cons:

- Adds projection state and UI/API surface.
- Requires Torghut to return consumer acknowledgments before capital promotion.
- Requires a short shadow phase to calibrate contradiction volume.

Decision: select Option C.

## Architecture

Jangar introduces three projection types.

`evidence_observation` is the raw claim:

```text
evidence_observation
  observation_id
  producer                       # jangar_status, kube_gateway, torghut_health, torghut_db_check, source_classifier
  scope                          # service, namespace, account, window, action_class
  subject_ref
  observed_at
  fresh_until
  status                         # valid, degraded, expired, unknown
  classifier_version
  confidence
  evidence_refs
  reason_codes
```

`contradiction_case` groups incompatible observations:

```text
contradiction_case
  case_id
  scope
  action_classes
  opened_at
  expires_at
  status                         # open, repaired, superseded, waived, expired
  observations
  allowed_actions                # serve_readonly, dispatch_repair, torghut_observe
  held_actions                   # dispatch_normal, deploy_widen, merge_ready, torghut_capital
  repair_owner
  repair_hint
```

`settled_promotion_verdict` is the only artifact a deployer or capital consumer may use:

```text
settled_promotion_verdict
  verdict_id
  action_class
  decision                       # allow, hold, repair_only
  issued_at
  fresh_until
  required_observations
  contradiction_cases
  consumer_acks
  rollback_target
```

The first classifier contract is narrow: database pod evidence must come from a database label (`cnpg.io/cluster`,
`app.kubernetes.io/name/component` containing postgres/database, or `app` containing postgres/database) or from a whole
name token `db`, `database`, `postgres`, or `postgresql` separated by `-`, `_`, `.`, start, or end. A generated suffix
like `-db7gp` is not a database token.

## Implementation Scope

This PR includes the first production fix and regression test: tighten the database pod name token classifier and add a
test for the observed generated suffix `torghut-quant-verify-sched-cron-29634232-db7gp`.

Engineer stage should then add:

- A contradiction-case reducer beside `control-plane-failure-domain-leases.ts`.
- Status API fields for `evidence_observations`, `contradiction_cases`, and `settled_promotion_verdicts`.
- A classifier version in each lease and contradiction case.
- A UI panel that shows the contradiction, accepted observations, rejected observations, and repair owner.
- Torghut consumer acknowledgment ingestion for DB, quant-health, empirical-job, TCA, and live-submission gate evidence.

## Validation Gates

- Unit test: generated runner pod names containing `db` in random suffixes do not expire database leases.
- Unit test: real CNPG and explicit `*-db-*` pods still expire database leases when terminating, not ready, or under
  `DisruptionTarget`.
- Status test: healthy DB probe plus classifier-derived non-database runner pod yields `merge_ready=allow` when no other
  required domain is degraded.
- Status test: healthy DB probe plus real terminating CNPG pod opens a contradiction case and holds material actions.
- Torghut integration test: `/trading/health` includes the Jangar verdict id when quant-health evidence is configured.
- Read-only cluster check: `agents`, `jangar`, and `torghut` Argo apps remain synced and healthy after rollout.

## Rollout

Phase 0: ship the classifier fix and keep failure-domain leases in their current shadow mode. Confirm the live
`source_schema.database_unroutable` false hold disappears after deploy without weakening real DB-pod split readiness.

Phase 1: add contradiction cases to the status payload but do not enforce them beyond the existing holdbacks. Deployer
acceptance is that every material hold has either a single unambiguous reason or an explicit contradiction case.

Phase 2: make `settled_promotion_verdict` the source of truth for `merge_ready`, `deploy_widen`, and
`torghut_capital`. Existing dependency quorum and failure-domain leases remain inputs, not final answers.

Phase 3: require Torghut consumer acknowledgments before any paper or live capital promotion. Shadow experiments may run
with repair-only verdicts when they retire proof debt and cannot place live orders.

## Rollback

- If the classifier fix misses a real database pod, revert only the classifier change and keep contradiction projection
  shadowed. CNPG labels remain the preferred authority, so this rollback should be rare.
- If contradiction volume is too high, disable verdict enforcement and leave contradiction cases as read-only status.
- If Torghut cannot emit consumer acknowledgments, keep `torghut_capital` held and allow only `torghut_observe` and
  proof-repair leases.
- If status projection latency exceeds its freshness budget, fall back to current dependency quorum plus
  failure-domain lease holdbacks.

## Risks

- Classifier tightening can miss hand-named database pods that use `db1` as a compact token. The mitigation is to rely
  on database labels for owned workloads and add explicit allowlist tests before enforcement.
- Contradiction cases can become noisy if every stale historical pod is treated as live evidence. The reducer must use
  action-class windows and freshness cutoffs.
- A verdict artifact can become another authority surface unless consumers are required to cite the verdict id they
  used.
- Torghut can still be unprofitable with clean evidence. The verdict only proves safe promotion conditions; it does not
  prove alpha.

## Handoff

Engineer acceptance gate: implement the contradiction reducer and status fields, keep the classifier regression green,
and prove one fixture for each path: false generated suffix, real terminating CNPG pod, stale empirical jobs with shadow
experiment allowed, and live capital held.

Deployer acceptance gate: before widening Jangar or Torghut, capture a `settled_promotion_verdict` with no open
contradiction cases for `deploy_widen` and no stale DB/source-schema evidence. For Torghut capital, require a fresh
consumer acknowledgment over DB, quant health, empirical jobs, TCA, and live-submission gate evidence.
