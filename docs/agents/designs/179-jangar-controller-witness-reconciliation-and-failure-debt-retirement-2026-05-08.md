# 179. Jangar Controller-Witness Reconciliation And Failure-Debt Retirement (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane resilience, AgentRun failure-debt reduction, ready-status truth, rollout clearance,
Torghut action custody, validation, rollout, rollback, and acceptance gates.

Governing requirement:

- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`

Companion Torghut contract:

- `docs/torghut/design-system/v6/183-torghut-forecast-registry-repair-and-route-rehearsal-profit-gates-2026-05-08.md`

Extends:

- `178-jangar-source-serving-parity-escrow-and-route-independent-launch-passports-2026-05-08.md`
- `177-jangar-evidence-quality-admission-ledger-and-degradation-backpressure-2026-05-08.md`
- `175-jangar-failure-debt-clearance-and-action-reentry-frontier-2026-05-08.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`

## Decision

I am selecting a **controller-witness reconciliation rail with failure-debt retirement** as the next Jangar
control-plane architecture step.

The current cluster is no longer in the May 5 state. On 2026-05-08 around 08:20Z to 08:29Z, Argo CD reported
`agents`, `agents-ci`, `jangar`, `root`, `torghut`, and `torghut-options` Synced and Healthy at
`00b0bc2c6b6591ce061af3efce7f9976e52deb11`. Jangar pods were running, Agents deployments were available
(`agents=1/1`, `agents-controllers=2/2`), and the Torghut live and sim consumer-evidence routes returned HTTP 200
with fresh receipts. The broad rollout is healthy.

The control-plane still cannot honestly call itself action-ready. The `agents` namespace retained 79 failed pods,
19 failed AgentRuns, and 315 succeeded pods. Recent warning events still showed `/ready` probe timeouts on the
`agents` and `agents-controllers` pods. Jangar's own control-plane status reported a current watch epoch with 1,594+
events and zero watch errors, but `agentrun_ingestion.status=unknown` because the agents controller self-report is
missing. The source-rollout truth exchange consequently marked `dispatch_repair`, `dispatch_normal`, `deploy_widen`,
and `merge_ready` as `hold` under `controller_heartbeat_not_current`.

That split is the next leverage point. We should not loosen readiness by ignoring the missing controller witness, but
we also should not let stale retained failures or a missing self-report keep the system in a permanent repair-only
state when deployment health, watch health, database health, and route health are current. The selected design creates
a rail that reconciles four facts independently: controller deployment availability, live serving process, watch epoch,
and AgentRun ingestion self-report. It then retires old failure debt when a later run on the same stage has succeeded,
while keeping active failures and unknown ingestion as bounded repair work.

The tradeoff is more explicit state. We will have one more projection, one more reducer, and stricter acceptance
criteria for action clearance. I accept that. The six-month risk is not that Jangar is too strict for five minutes.
It is that operators cannot tell the difference between active failure, retained debris, and a missing witness, so
healthy rollouts keep carrying yesterday's debt into today's action decisions.

## Business Metrics And Value Gates

This design targets the swarm business metric: reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout
time for the Jangar control plane.

Mapped value gates:

- `failed_agentrun_rate`: classify active, superseded, retained, and retired failure debt; enforce cleanup budgets.
- `pr_to_rollout_latency`: unblock `merge_ready` and `deploy_widen` from stale retained debt once current witnesses
  are converged.
- `ready_status_truth`: separate deployment/watch truth from controller self-report truth and state their disagreement.
- `manual_intervention_count`: make the next repair action deterministic instead of requiring a human to inspect pods.
- `handoff_evidence_quality`: record acceptance gates, rollout checks, rollback levers, and exact proof surfaces.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, GitOps manifests,
trading flags, or AgentRun objects.

### Cluster And Rollout Evidence

- Local branch was `codex/swarm-jangar-control-plane-plan`, clean, based on `main`.
- `kubectl config current-context` was initially unset; I created a local in-cluster context using the mounted service
  account token. `kubectl auth whoami` identified `system:serviceaccount:agents:agents-sa`.
- Argo CD applications `agents`, `agents-ci`, `jangar`, `root`, `torghut`, and `torghut-options` were Synced and
  Healthy at revision `00b0bc2c6b6591ce061af3efce7f9976e52deb11`.
- Jangar namespace pods and deployments were running and available. `deployment/jangar` was `1/1` on
  `registry.ide-newton.ts.net/lab/jangar:03eea88e`.
- Agents deployments were available: `agents=1/1`, `agents-alloy=1/1`, `agents-controllers=2/2`.
- Agents pods grouped to 79 `Failed`, 13 `Running`, and 315 `Succeeded`.
- AgentRun CRs grouped to 19 `Failed`, 9 `Running`, 438 `Succeeded`, and 12 `Template`.
- Recent agents events showed successful current schedule ticks, but also `/ready` timeouts for both
  `agents-controllers` pods and the `agents` pod minutes before this assessment.
- Torghut live, sim, options, WebSocket, TA, Postgres, ClickHouse, and Keeper workloads were running. One old
  whitepaper autoresearch pod remained `Error`, and Torghut events still showed repeated ClickHouse PDB ambiguity.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` assembles the status surface that operators and schedule
  runners consume. It already emits database health, rollout health, watch reliability, material action verdicts,
  controller witness state, source-rollout truth exchange, and Torghut consumer evidence.
- `services/jangar/src/server/control-plane-controller-witness.ts` models the split. The live status showed deployment,
  serving process, and watch epoch witnesses allowing, while the AgentRun ingestion witness remained `repair_only`.
- `services/jangar/src/server/supporting-primitives-controller.ts` is still a high-risk module at 3,325 lines. It owns
  schedule generation, runtime admission, fire-time checks, requirement dispatch, and swarm status. Its tests are broad
  but the failure-debt retirement behavior should be isolated into a pure reducer before touching scheduler code.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` converts the witness split into material
  action holds. That is the right enforcement point, but it needs a better distinction between active debt and retired
  debt.
- Existing tests cover supporting-primitives admission, source-rollout truth, material action verdicts, failure-domain
  leases, route-stability escrow, and `/ready`. The missing regression tests are for controller witness reconciliation
  and failure-debt maturity when later stage runs have succeeded.

### Database And Data Evidence

- Direct CNPG metadata listing was forbidden for this service account in `jangar` and `torghut`.
- Direct `pods/exec` into Postgres and ClickHouse pods was also forbidden for this service account. The smallest
  access improvement, if raw SQL becomes mandatory, is a read-only diagnostic role or a service endpoint that exposes
  bounded schema/data summaries without secret access.
- Jangar application status reported database `configured=true`, `connected=true`, `status=healthy`, latency `3ms`,
  28 registered Kysely migrations, 28 applied migrations, no unapplied migrations, no unexpected migrations, and
  latest migration `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar watch reliability reported one observed AgentRun stream, 1,594+ events in the current 15-minute window,
  zero errors, zero restarts, and a current `last_seen_at`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, head
  `0029_whitepaper_embedding_dimension_4096`, lineage ready, account scope ready, and known parent-fork warnings for
  two historical migration forks.
- Jangar quant health returned `status=ok`, `latestMetricsCount=4284`, latest update lag about three seconds, and no
  empty-store or missing-update alarm.
- Scoped quant health for `account=TORGHUT_SIM&window=15m` returned `status=degraded`, zero latest metrics, no stage
  rows, and `emptyLatestStoreAlarm=true`.
- Torghut live `/readyz` returned `status=degraded`: Postgres, ClickHouse, database schema, universe, empirical jobs,
  and quant evidence were acceptable, but live submission was blocked by `simple_submit_disabled` and the proof floor
  stayed `repair_only` with `max_notional=0`.
- Torghut sim `/readyz` returned `status=ok`, but its proof floor was also `repair_only` because alpha readiness had
  no promotion-eligible hypotheses and execution TCA had an empty route universe.
- Torghut `/trading/consumer-evidence` returned HTTP 200 for live and sim with fresh
  `torghut-consumer-evidence:*` receipts. This closes the route-parity blocker described by design 178, but not the
  capital/profit blockers.

## Problem

Jangar currently conflates three different states:

1. Active failure: a run or job is failing now and should block or hold action.
2. Retained failure debt: a failed pod, job, or AgentRun is still visible, but a later run for the same lane succeeded.
3. Missing witness: deployment and watch surfaces are current, but the controller has not published its own ingestion
   heartbeat.

Those states produce the same operator result: held material actions. That is too blunt. It slows PR-to-rollout
clearance, makes failed pod counts look worse than live behavior, and forces humans to inspect raw pods to decide
whether a hold is safety-critical or just debt waiting for retirement.

The control plane needs a controller-witness reconciliation rail that can say:

- the controller is deployed and watching;
- the ingestion self-report is missing or stale;
- active AgentRun debt is below or above budget;
- retained failed pods are superseded by later successful runs;
- the next exact repair is to publish a self-report, retire retained debt, or hold action.

## Alternatives Considered

### Option A: Treat Argo Healthy And Deployments Ready As Sufficient

If Argo is Synced/Healthy and the deployments are available, allow dispatch and merge readiness.

Advantages:

- Fastest reduction in held actions.
- Easy to explain to deployers.
- Uses common Kubernetes rollout signals.

Disadvantages:

- Ignores the current missing AgentRun ingestion self-report.
- Can mark readiness true while the controller is not actually updating run state.
- Does not reduce retained failure debris or failed AgentRun ambiguity.

Decision: reject. Argo and deployment health are necessary, not sufficient.

### Option B: Keep Global Repair-Only Until Every Witness Is Current

Keep `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` held whenever any witness is missing.

Advantages:

- Strict safety model.
- Prevents action under ambiguous controller state.
- Matches current behavior.

Disadvantages:

- Converts a missing self-report into a broad automation freeze.
- Does not distinguish active failures from retained debris.
- Increases manual intervention because humans must inspect the real failure state.

Decision: keep as a rollback mode, not as the target architecture.

### Option C: Controller-Witness Reconciliation Rail With Failure-Debt Retirement

Build a pure reconciliation reducer that separates deployment, serving process, watch epoch, ingestion self-report,
active failure debt, retained failure debt, and retirement proofs. Use it to clear specific action classes only when
the relevant evidence is current.

Advantages:

- Keeps safety strict while making the reason precise.
- Lets bounded repair run even when normal dispatch and capital stay held.
- Reduces failed AgentRun noise by retiring superseded debt.
- Gives deployers a deterministic acceptance gate for green PR-to-healthy rollout.

Disadvantages:

- Adds a new reducer, status section, and tests.
- Requires careful history matching so old failed pods are not retired incorrectly.
- May initially expose more detail than the UI can display well.

Decision: select Option C.

## Architecture

Add a `controller_witness_reconciliation` projection to Jangar status in shadow mode.

```text
controller_witness_reconciliation
  schema_version
  reconciliation_id
  generated_at
  fresh_until
  namespace
  source_head_sha
  gitops_revision
  controller_deployment_witness
  serving_process_witness
  watch_epoch_witness
  ingestion_self_report_witness
  failure_debt_summary
  action_clearance[]
  next_repair_action
  rollback_target
```

`failure_debt_summary` separates:

```text
failure_debt_summary
  active_failed_agentruns
  active_failed_jobs
  active_failed_pods
  retained_failed_agentruns
  retained_failed_jobs
  retained_failed_pods
  retired_failure_debt
  superseded_by_success_count
  oldest_active_failure_age_seconds
  debt_budget_state              # clear | watch | hold | block
  reason_codes
```

`action_clearance` is action-class scoped:

```text
action_clearance
  action_class                   # serve_readonly | dispatch_repair | dispatch_normal | deploy_widen | merge_ready
  decision                       # allow | allow_bounded | hold | block
  required_witnesses
  missing_witnesses
  debt_budget_state
  max_dispatches
  max_runtime_seconds
  evidence_refs
  rollback_target
```

The first implementation slice should be pure and read-only: build the reducer from existing status inputs, expose it
in status, and add tests. Enforcement changes come only after the deployer validates shadow output against current
cluster behavior.

## Implementation Scope

Engineer stage:

1. Add `services/jangar/src/server/control-plane-controller-witness-reconciliation.ts` as a pure reducer.
2. Feed it from existing `database`, `rollout_health`, `watch_reliability`, `agentrun_ingestion`,
   `control_plane_controller_witness`, `stages`, jobs, pods, and AgentRun summaries.
3. Classify failure debt as `active`, `retained`, `superseded`, or `retired`.
4. Treat a later successful run for the same swarm/stage as a retirement candidate, not an automatic deletion.
5. Expose the projection from `control-plane-status.ts` under `controller_witness_reconciliation`.
6. Add tests for witness split, retained failed pods, active failed AgentRuns, bounded repair clearance, and rollback
   mode.
7. Do not delete pods, jobs, AgentRuns, or database rows in this slice.

Deployer stage:

1. Verify Argo apps are Synced/Healthy at the merged revision.
2. Verify Jangar and Agents deployments are available.
3. Verify `/api/agents/control-plane/status?namespace=agents` includes the reconciliation projection.
4. Compare projection counts to `kubectl -n agents get pods` and `kubectl -n agents get agentruns`.
5. Confirm `serve_readonly` remains allow, `dispatch_repair` is at most bounded, and normal/capital actions stay held
   when ingestion self-report is missing.

## Validation Gates

Local tests:

- `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/control-plane-controller-witness-reconciliation.test.ts`
- `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `bunx oxfmt --check docs/agents/designs/179-jangar-controller-witness-reconciliation-and-failure-debt-retirement-2026-05-08.md`

CI gates:

- Semantic PR title passes.
- Semantic commit messages pass.
- Jangar affected test suite passes.

Runtime gates after merge:

- Argo `agents` and `jangar` are Synced/Healthy at the merge revision.
- `deployment/agents` is `1/1`; `deployment/agents-controllers` is `2/2`.
- Status shows database healthy and migrations consistent.
- Status shows watch reliability healthy with zero current watch errors.
- Reconciliation projection names active versus retained failure debt.
- Reconciliation projection names the smallest repair when `controller_self_report_current=false`.

## Rollout

Phase 0, design: merge this document and companion Torghut contract.

Phase 1, shadow reducer: add the projection with no action enforcement. Deployer compares it to live cluster reads for
at least one Jangar schedule cycle.

Phase 2, bounded repair: allow only bounded `dispatch_repair` when deployment, serving process, database, route, and
watch witnesses are current but ingestion self-report is missing and active failure debt is under budget.

Phase 3, action clearance: allow `deploy_widen` and `merge_ready` only when all required witnesses are current and
active failure debt is clear or explicitly waived by the verifier.

## Rollback

Rollback is feature-flag based:

- Disable the projection consumer and continue using existing `control_plane_controller_witness` decisions.
- Keep the reducer present but shadow-only if action clearance is wrong.
- Revert the implementation PR if the status route slows down, produces bad debt classifications, or masks active
  AgentRun failure.
- Do not delete retained pods or AgentRuns as part of rollback.

## Risks

- Misclassifying an active failure as retained debt would hide a real incident. Mitigation: retirement requires a
  later successful run for the same swarm/stage and no current BackoffLimitExceeded job for that lane.
- Adding another status projection could slow the full status route. Mitigation: use existing summarized inputs first
  and keep raw pod lists out of the payload.
- Bounded repair could still launch too much work during controller ambiguity. Mitigation: default `max_dispatches=0`
  until the deployer validates shadow output.
- UI consumers may ignore the new projection. Mitigation: keep existing material action receipts unchanged until the
  projection is validated.

## Handoff

Engineer next milestone: implement the shadow `controller_witness_reconciliation` reducer and status projection with
focused unit tests. This maps to `failed_agentrun_rate`, `ready_status_truth`, `manual_intervention_count`, and
`handoff_evidence_quality`.

Deployer next milestone: after the implementation PR merges, prove Argo sync, deployment readiness, status projection
presence, active/retained debt classification, and no regression in Jangar `/ready`. This maps to
`pr_to_rollout_latency`, `ready_status_truth`, and `manual_intervention_count`.
