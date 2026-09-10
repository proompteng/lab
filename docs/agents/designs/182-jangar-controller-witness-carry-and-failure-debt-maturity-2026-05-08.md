# 182. Jangar Controller-Witness Carry And Failure-Debt Maturity (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane reliability, controller witness truth, scheduled AgentRun admission, failure-debt maturity,
Torghut repair selection, validation, rollout, rollback, and handoff gates.

Governing requirement:

- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`

Companion Torghut contract:

- `docs/torghut/design-system/v6/186-torghut-proof-lease-repair-market-and-capital-hold-2026-05-08.md`

Extends:

- `180-jangar-stage-clearance-exchange-and-scheduler-routability-contract-2026-05-08.md`
- `180-jangar-evidence-settlement-reclocking-and-profit-gated-rollouts-2026-05-08.md`
- `179-jangar-controller-witness-reconciliation-and-failure-debt-retirement-2026-05-08.md`
- `177-jangar-evidence-quality-admission-ledger-and-degradation-backpressure-2026-05-08.md`

## Decision

I am selecting a **controller-witness carry rail with failure-debt maturity** as the next Jangar architecture step.

The current system is in a better availability state than the May 5 soak. At `2026-05-08T16:08Z`, Argo CD reported
`agents`, `jangar`, and `torghut` `Synced` and `Healthy`; `agents-controllers` was `2/2`; Jangar was serving
`/health` and `/ready`; and Torghut live and sim revisions were running. The last 15-minute workflow rollup from
Jangar control-plane status reported `recent_failed_jobs=0` and `backoff_limit_exceeded_jobs=0`.

The system is not yet ready to spend normal dispatch, merge-ready, or capital authority. Jangar `/health` says the
local process has `agentsController.enabled=false`; control-plane status reports `agentrun_ingestion.status=unknown`
with message `agents controller not started`; material action verdicts hold `dispatch_normal` and `merge_ready` on
`controller_heartbeat_not_current`; and recent cluster events still show schedule job retries, one
`BackoffLimitExceeded` for a Jangar implement attempt, one market-context `BackoffLimitExceeded`, and readiness probe
timeouts on both `agents-controllers` pods. Torghut consumer evidence is current, but Torghut `/readyz` remains HTTP
503 degraded and paper/live action is held by proof-floor and signal debt.

The selected architecture carries controller witness truth forward as its own durable input instead of letting it be
re-derived at every action surface. It then matures failure debt into active, superseded, retained, and retired classes.
That lets the scheduler continue bounded repair when a witness is missing, keeps normal dispatch and merge readiness
held until the self-report and route witnesses converge, and prevents retained debris from looking like live failure
after newer work succeeds.

The tradeoff is a stricter action model. Some runnable work will stay held until it can cite a fresh witness-carry
receipt. I am keeping that trade because the business metric is fewer failed AgentRuns and shorter green
PR-to-healthy rollout time, not maximum launch volume.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests, trading
flags, or AgentRun objects.

### Cluster And Rollout Evidence

- The worktree was on `codex/swarm-jangar-control-plane-discover`, based on `main`.
- `kubectl config current-context` was unset, while `kubectl auth whoami` succeeded as
  `system:serviceaccount:agents:agents-sa`.
- `deployment/agents` was `1/1`, `deployment/agents-alloy` was `1/1`, and `deployment/agents-controllers` was `2/2`.
- Jangar namespace pods were running, including `jangar-77c49fd877-t4vcg 2/2 Running`, `jangar-db-1 1/1 Running`,
  and supporting OpenWebUI, Redis, Alloy, Bumba, and Symphony pods.
- Torghut live `torghut-00311` and sim `torghut-sim-00409` pods were `2/2 Running`; Torghut Postgres, ClickHouse,
  Keeper, TA, options TA, WebSocket, options catalog, and options enricher were running.
- Argo CD reported `agents`, `jangar`, `torghut`, `torghut-options`, and `symphony-torghut` `Synced` and `Healthy`.
  `rook-ceph` was still `Synced` and `Degraded`, so storage-backed evidence must degrade explicitly.
- Recent agents events showed completed schedule ticks, but also `BackoffLimitExceeded` for
  `jangar-control-plane-implement-sched-7qcvx-step-1-attempt-1`, `BackoffLimitExceeded` for
  `torghut-market-context-fundamentals-batch-xw9q7-job`, and readiness probe timeouts on `agents` and
  `agents-controllers` pods.
- Recent Torghut events showed normal rollout churn for `torghut-00311`, but also repeated ClickHouse
  multiple-PDB warnings and a `torghut-keeper` PDB with no matching pods.

### Runtime Evidence

- Jangar `/health` returned `status=ok`, but reported the local `agentsController` as disabled and not started.
- Jangar `/ready` returned `status=ok` with serving and collaboration runtime kits healthy and swarm plan,
  implement, and verify passports allowed.
- Jangar control-plane status reported `execution_trust.status=healthy`, but `agentrun_ingestion.status=unknown` with
  message `agents controller not started`.
- The same control-plane status held `dispatch_normal` as `repair_only` because of `controller_witness_split`.
- Material action verdicts held `merge_ready` on controller heartbeat and AgentRun ingestion witnesses, while
  allowing `torghut_observe` and holding or blocking paper/live Torghut capital classes.
- Torghut consumer evidence was current at `2026-05-08T16:08:14Z`, with receipt
  `torghut-route-proven-profit:d269b7c44c6c79a0`, serving revision `torghut-00311`, decision `repair`, and reasons
  `forecast_registry_degraded`, `simple_submit_disabled`, `hypothesis_not_promotion_eligible`, and
  `market_context_stale`.

### Source Evidence

- `services/jangar/src/server/control-plane-controller-witness.ts` already models controller deployment, serving
  process, watch epoch, and AgentRun ingestion witness state. The next work should extend this reducer instead of
  adding another ad hoc status branch.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is the correct consumer for action-class
  decisions; it already holds material classes when controller witness truth is not current.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` binds controller heartbeat, source
  schema, database, route, and deployment truth into deploy-widen and merge-ready decisions.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains a high-risk integration point at 3,325
  lines. Scheduler enforcement should call a small pure admission helper rather than increasing this module's
  decision surface.
- Existing tests cover controller witness, material action verdicts, source-rollout truth, action clocks, failure
  domain leases, route stability, `/ready`, and supporting primitive schedules. The missing acceptance tests are for
  witness carry across scheduler admission and failure-debt maturity after later success.

### Database And Data Evidence

- CNPG cluster reads, Secret listing, and Postgres pod exec were forbidden for the `agents-sa` service account in both
  `jangar` and `torghut`. The smallest unblocker for direct SQL evidence is a bounded read-only diagnostic endpoint
  or a read-only role exposed through an audited service path.
- Torghut `/readyz` provided database evidence without raw SQL access: Postgres, ClickHouse, broker, universe, and
  schema checks were OK. Current and expected Alembic heads were both `0030_evidence_epochs`, with lineage ready and
  only known historical parent-fork warnings.
- Jangar control-plane status included a `database:probe:select_1` evidence ref and source schema ref
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Jangar quant health for `PA3SX7FYNUTF/15m` reported `latestMetricsCount=180`, latest metrics updated at
  `2026-05-08T16:07:41Z`, and degraded pipeline stages: compute OK, ingestion false, and materialization false for
  active strategies.
- Torghut `/readyz` reported `market_context_ref.last_domain_states.news=stale`, `ta-core` blocked on
  `signal_lag_exceeded`, and live submission disabled.

## Problem

The current control plane has recovered enough to run work, but not enough to call material action ready.

The unresolved split is specific:

1. Kubernetes and Argo say the controllers are available.
2. Jangar serving and collaboration runtime kits are healthy.
3. The local Jangar process says its embedded agents controller is disabled.
4. The agents-controller deployment is running, but Jangar does not have a fresh controller self-report.
5. Recent schedule debt is improving, yet retained and recent failed attempts still affect operator confidence.
6. Torghut proof leases are current enough to direct repair, but not current enough to permit paper or live capital.

Without a witness-carry rail, each downstream consumer reinterprets those facts. That creates either overblocking, where
retained debt keeps holding healthy repair work, or underblocking, where a healthy rollout badge lets work launch with
missing controller ingestion truth.

## Alternatives Considered

### Option A: Accept Deployment Availability As Controller Truth

Treat `agents-controllers=2/2` plus Argo Healthy as sufficient to clear controller witness holds.

Advantages:

- Very fast to implement.
- Reduces held actions immediately.
- Aligns with familiar rollout dashboards.

Disadvantages:

- Ignores the observed `agentrun_ingestion.status=unknown` self-report gap.
- Lets scheduler admission drift away from the actual controller ingestion surface.
- Risks calling merge-ready while Jangar cannot prove AgentRun state is being consumed.

Decision: reject. Deployment availability is a witness, not the whole truth.

### Option B: Keep All Normal Dispatch Held Until Every Witness Is Fresh

Require controller deployment, serving process, watch epoch, AgentRun ingestion self-report, workflow window, database,
and Torghut proof surfaces to be green before allowing anything beyond read-only serving.

Advantages:

- Strong safety posture.
- Simple operator rule.
- Prevents accidental material action under witness uncertainty.

Disadvantages:

- Blocks repair work that can restore the missing witness.
- Treats retained failures and active failures as equally bad.
- Increases manual intervention by forcing humans to inspect raw pods and retained AgentRuns.

Decision: keep as rollback mode, not target mode.

### Option C: Controller-Witness Carry With Failure-Debt Maturity

Create a witness-carry receipt that records the independent controller witnesses, then mature failure debt by stage,
source commit, route, and later success before action decisions consume it.

Advantages:

- Keeps strict holds for merge-ready, deploy-widen, and capital when controller truth is incomplete.
- Lets bounded repair and observe work proceed with explicit reason codes.
- Retires superseded debt without deleting audit history.
- Gives deployers one receipt to cite for PR-to-rollout clearance.
- Provides the next implementable milestone after stage-clearance and profit-signal quorum.

Disadvantages:

- Adds a reducer, status schema, and scheduler hook.
- Requires careful matching to avoid retiring real active failures.
- Needs UI wording so operators understand "retained debt" versus "active failure".

Decision: select Option C.

## Architecture

Add a `controller_witness_carry` receipt in Jangar status and scheduler admission.

```text
controller_witness_carry
  schema_version
  receipt_id
  generated_at
  fresh_until
  namespace
  source_commit
  serving_revision
  gitops_revision
  controller_deployment_witness
  serving_process_witness
  watch_epoch_witness
  ingestion_self_report_witness
  workflow_window_witness
  failure_debt_maturity_ref
  action_clearance[]
  next_repair_action
  rollback_target
```

`failure_debt_maturity` is separate from the receipt so it can be tested independently:

```text
failure_debt_maturity
  maturity_id
  window_started_at
  window_ended_at
  active_failed_runs
  active_failed_jobs
  active_failed_pods
  retained_failed_runs
  retained_failed_jobs
  retained_failed_pods
  superseded_by_success
  retired_debt_refs[]
  debt_state                 # clear | watch | repair | hold | block
  reason_codes[]
```

Action clearance rules:

- `serve_readonly`: allow when the serving process and database probe are healthy.
- `dispatch_repair`: allow bounded work when the route, runtime kit, and one repair target are explicit.
- `dispatch_normal`: hold while ingestion self-report is missing or failure debt is `hold` or `block`.
- `deploy_widen`: require source, GitOps, rollout, controller witness carry, and workflow window to converge.
- `merge_ready`: require deploy-widen clearance plus no active failure debt for the PR's source commit.
- `torghut_observe`: allow when Torghut consumer evidence is current and max notional is zero.
- `paper_canary`, `live_micro_canary`, and `live_scale`: consume Torghut proof-lease repair state and remain held or
  blocked until the companion Torghut contract produces full proof.

## Implementation Milestones

| Milestone | Scope                                                                                                      | Value gates                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| M0        | Merge this design, companion Torghut contract, ledger, and handoff artifact.                               | `handoff_evidence_quality`                                                |
| M1        | Add a pure `controller_witness_carry` builder and `failure_debt_maturity` reducer with fixtures.           | `ready_status_truth`, `failed_agentrun_rate`                              |
| M2        | Publish the receipt in control-plane status and `/ready` without changing liveness.                        | `ready_status_truth`, `manual_intervention_count`                         |
| M3        | Add scheduler admission in shadow mode and compare predicted holds to actual launches for one full window. | `failed_agentrun_rate`, `handoff_evidence_quality`                        |
| M4        | Enforce only duplicate active-debt denial while allowing bounded repair.                                   | `failed_agentrun_rate`, `manual_intervention_count`                       |
| M5        | Require carry receipts for deploy-widen and merge-ready verification.                                      | `pr_to_rollout_latency`, `ready_status_truth`, `handoff_evidence_quality` |

## Validation Gates

Engineer stages must prove:

- a healthy deployment with missing ingestion self-report keeps `dispatch_normal` and `merge_ready` held;
- a later successful run can mature older failed pods into retained debt without deleting the evidence;
- active `BackoffLimitExceeded` for the same stage/source keeps normal dispatch held;
- `dispatch_repair` remains allowed only when it names one repair action and max notional is zero;
- Torghut observe remains allowed while paper/live actions consume the companion proof-lease state and stay held;
- every implementation PR cites this document and the runtime validation contract.

Deployer stages must prove:

- Argo app sync and health for `agents` and `jangar`;
- workload readiness for `agents`, `agents-controllers`, and `jangar`;
- Jangar `/ready` and control-plane status show a fresh carry receipt;
- the scheduler logs or status show predicted versus actual admission in shadow mode;
- no paper or live Torghut notional is enabled by this change.

## Rollout

1. Ship the pure reducer and tests.
2. Publish carry receipts in status shadow mode.
3. Compare receipts against material action verdicts and workflow windows.
4. Add scheduler shadow admission and NATS denial summaries.
5. Enforce duplicate active-debt denial for one low-risk stage class.
6. Expand enforcement only after failed AgentRun rate falls without increasing manual overrides.

## Rollback

- Disable enforcement and keep receipt publication.
- Fall back to existing material action verdicts, action SLO budgets, and stage-clearance packets.
- Do not delete retained debt rows or audit artifacts during rollback.
- If storage or database evidence is unavailable, fail open only for read-only discover and fail closed for implement,
  verify, deploy-widen, merge-ready, paper, and live actions.
- If Torghut proof-lease receipts are unavailable, allow only bounded zero-notional diagnostics.

## Risks And Mitigations

- **False retirement:** a failed run could be marked superseded by an unrelated success. Mitigation: match on swarm,
  stage, source commit, input digest, route, and action class.
- **Overblocking:** missing self-report could hold normal dispatch too long. Mitigation: allow bounded repair with a
  single named repair action and publish the next evidence needed.
- **Status sprawl:** adding another receipt could make the UI harder to read. Mitigation: surface one summarized
  decision per action class and keep detailed debt in expandable evidence.
- **Database access gap:** direct SQL evidence is RBAC-blocked from this worker. Mitigation: use bounded service
  summaries now and create a least-privilege database witness milestone if raw SQL becomes necessary.
- **Capital confusion:** Torghut repair receipts could be mistaken for trading permission. Mitigation: every
  Torghut-related action in this contract carries `max_notional=0` unless a separate capital gate allows it.

## Engineer Handoff

Start with M1 in `services/jangar/src/server`. Implement a pure reducer first and keep `supporting-primitives-controller`
as a consumer. The first production PR should add fixtures for the exact live contradiction: `agents-controllers=2/2`,
Jangar runtime kits healthy, `agentrun_ingestion.status=unknown`, a clean 15-minute workflow window, retained schedule
debt, and Torghut proof leases in `repair_only`.

Do not enforce scheduler denial in the first PR. Shadow output must prove which launches would have been allowed,
held, or denied and which value gate each decision protects.

## Deployer Handoff

Deploy shadow mode first. Acceptance is a fresh carry receipt in Jangar status, Argo and workload readiness for
`agents` and `jangar`, bounded repair still available, normal dispatch and merge-ready held when ingestion self-report
is missing, and no change to Torghut live or paper notional.

The next bounded implementation milestone is M1: controller-witness carry and failure-debt maturity reducer with unit
tests. It targets `failed_agentrun_rate`, `ready_status_truth`, and `handoff_evidence_quality`.
