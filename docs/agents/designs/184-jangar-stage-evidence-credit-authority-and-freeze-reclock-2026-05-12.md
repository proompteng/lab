# 184. Jangar Stage Evidence Credit Authority And Freeze Reclock (2026-05-12)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-12
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane reliability, stale-stage freeze recovery, launch admission, PR-to-rollout evidence,
Torghut repair admission, validation, rollout, rollback, and cross-stage handoff.

Governing requirement:

- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`

Companion Torghut contract:

- `docs/torghut/design-system/v6/188-torghut-evidence-credit-capital-repair-market-2026-05-12.md`

Extends:

- `183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md`
- `182-jangar-controller-witness-carry-and-failure-debt-maturity-2026-05-08.md`
- `180-jangar-stage-clearance-exchange-and-scheduler-routability-contract-2026-05-08.md`
- `180-jangar-evidence-settlement-reclocking-and-profit-gated-rollouts-2026-05-08.md`

## Decision

I am selecting a **Stage Evidence Credit Authority** as the next Jangar control-plane architecture step.

The current control plane has two truths that are individually correct and jointly dangerous. At
`2026-05-12T16:21Z`, Argo CD reported `agents`, `jangar`, `symphony-jangar`, and `symphony-torghut` as
`Synced/Healthy` at revision `32564cef018d608a7928c80240a70d35f75c5b25`. Jangar `/ready` returned `status=ok`,
leader election was current, memory provider configuration was healthy, runtime kits were healthy, the Jangar database
probe was healthy, and the watch reliability stream had `975` events with zero errors or restarts.

The same evidence said Jangar execution trust was degraded. The `jangar-control-plane` Swarm was `Frozen` for
`StageStaleness`, with discover, plan, implement, and verify stage clocks still pointing to May 8 runs. The controller
witness was `repair_only`: deployment and watch witnesses were current, but AgentRun ingestion self-report was
`unknown`. Material action verdicts held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` on
controller heartbeat and witness refs. Meanwhile, Kubernetes showed fresh May 12 schedule jobs and AgentRuns still
being created, including multiple running Jangar discover/verify jobs and fresh Torghut market-context jobs.

That split is the failure mode. A frozen stage clock should prevent blind launch widening, but it should not make the
system ignore current successful proof. A current schedule job should help reclock evidence, but it should not earn
unbounded launch authority while the source of truth still marks the Swarm frozen. The control plane needs a credit
authority that can say which live evidence earns a bounded credit, which evidence creates launch debt, and when the
freeze can be reclocked without manual state edits.

The selected design adds a `stage_evidence_credit_authority` projection. It consumes Swarm stage clocks, AgentRun CRs,
Job outcomes, controller witnesses, workflow/event windows, source rollout truth, route stability, material action
verdicts, memory/NATS handoff evidence, and PR rollout certificates. It emits per-stage evidence credits, launch
budgets, freeze-reclock receipts, and deployer certificates. A stage can launch or widen only by spending a current
credit that names its source evidence and debt state.

The tradeoff is stricter accounting. Some launchable work will wait for a credit receipt, and some current jobs will
count only as repair evidence until the controller ingestion witness is current. I accept that because the business
metric is fewer failed AgentRuns and shorter green PR-to-healthy GitOps rollout time, not maximum pod creation.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, trading flags, GitOps
resources, or AgentRun objects.

### Cluster And Rollout Evidence

- The worktree was on `codex/swarm-jangar-control-plane-discover`, based on `main` at `32564cef0`.
- `kubectl auth whoami` returned `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` was unset.
- Argo CD reported:
  - `agents`: `Synced/Healthy`, revision `32564cef018d608a7928c80240a70d35f75c5b25`
  - `jangar`: `Synced/Healthy`, revision `32564cef018d608a7928c80240a70d35f75c5b25`
  - `torghut`: `Synced/Degraded`, revision `32564cef018d608a7928c80240a70d35f75c5b25`
  - `torghut-options`: `Synced/Progressing`, revision `d875cca7addce4a02afd5bb005b26636960f8c35`
- `deployment/agents` was `1/1`, `deployment/agents-controllers` was `2/2`, and `deployment/agents-alloy` was `1/1`.
- Jangar was available: `deployment/jangar` was `1/1`; pod `jangar-6679f79857-tsgp2` was `2/2 Running`.
- Agents resources showed `AgentRun` phase counts from the control-plane summary: `629` total, `487 Succeeded`,
  `101 Failed`, `23 Running`, `6 Pending`, and `12 Template`.
- Recent Jobs showed current active work while the Swarm remained frozen: Jangar discover had three active attempt
  jobs, Jangar verify had two active attempt jobs, and Jangar implement/plan each had one active attempt job.
- Recent failed Jobs still existed in the same namespace: `jangar-control-plane-implement-sched-cron-29642730` and
  `jangar-control-plane-plan-sched-cron-29642660` each had seven failures from `2026-05-12T05:32:51Z`.
- Torghut runtime had active image-pull and readiness debt: `torghut-options-ta`, `torghut-ta-sim`, `torghut-ws`, and
  `torghut-ws-options` were in `ImagePullBackOff`, while live and sim Knative revisions were running.

### Runtime Evidence

- Jangar `/health` returned `status=ok`, but its local `agentsController` was `enabled=false` and `started=false`.
- Jangar `/ready` returned `status=ok`, but `execution_trust.status=degraded` because the Jangar Swarm freeze was
  active and discover, plan, implement, and verify stages were stale.
- `/api/agents/control-plane/status` reported database `healthy`, migration consistency `healthy`, and latest applied
  migration `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Workflow status for the last 15 minutes showed `recent_failed_jobs=0` and `backoff_limit_exceeded_jobs=0`, which is
  useful current proof but does not cancel the retained failed-job evidence.
- `control_plane_controller_witness.decision=repair_only` with reason `controller_witness_split`; deployment and watch
  witnesses were current, while AgentRun ingestion was `unknown`.
- `watch_reliability.status=healthy`, with `975` events, zero errors, and zero restarts in the 15-minute window.
- `material_action_verdicts` allowed `serve_readonly` and `torghut_observe`, but held dispatch and deploy action
  classes on controller witness and execution-trust debt.
- `source_rollout_truth_exchange` had converged `serve_readonly` and `torghut_observe`, but held dispatch, deploy,
  merge, paper, and live action classes.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is `3,327` lines and owns schedule generation,
  runtime admission, workspace lifecycle, and swarm reconciliation. It is the wrong place to add ad hoc freeze logic.
- `services/jangar/src/server/control-plane-status.ts` is `793` lines and already composes database, runtime kit,
  controller witness, source rollout truth, route stability, material verdict, and Torghut consumer evidence.
- `services/jangar/src/server/control-plane-controller-witness.ts` already models deployment, serving process, watch
  epoch, and AgentRun ingestion witnesses. The new authority should consume it, not replace it.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` already decides action classes. The new
  authority should become a precondition and credit source for these decisions.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` already binds source, GitOps, rollout,
  database, route, and Torghut proof truth into deployment receipts.
- `services/jangar/src/server/control-plane-route-stability-escrow.ts` already emits route stability escrow, but there
  is no current `action_custody` field on status and no `stage_evidence_credit_authority` projection.
- Existing tests cover controller witness, material action verdicts, source rollout truth, route stability, Torghut
  consumer evidence, negative evidence routing, and control-plane status. The missing test surface is credit accounting
  across stale Swarm clocks, current successful jobs, retained failed jobs, and duplicate active launches.

### Database And Data Evidence

- Direct `pods/exec` to `jangar-db-1` and `torghut-db-1` was forbidden for `agents-sa`, so raw database inspection used
  CNPG app credentials from Kubernetes Secrets and `BEGIN READ ONLY` transactions.
- Jangar Postgres identity was `database=jangar`, `user=jangar`, observed at `2026-05-12T16:29:36Z`.
- Jangar schemas included `agents_control_plane`, `atlas`, `codex_judge`, `jangar_github`, `memories`, `public`,
  `terminals`, `torghut_control_plane`, and `workflow_comms`.
- `agents_control_plane.resources_current` estimated `4,384` live rows and had autoanalyze at
  `2026-05-12T16:27:37Z`.
- `agents_control_plane.component_heartbeats` had `4` rows with newest `observed_at=2026-05-12T16:29:38Z`.
- `workflow_comms.agent_messages` had `21,045` rows with newest `created_at=2026-05-12T16:29:32Z`.
- `memories.entries` had `1,176` rows, but newest `created_at=2026-05-08T22:35:08Z`; runtime memory configuration is
  healthy, while persisted memory freshness is lagging this run.
- `torghut_control_plane.quant_metrics_latest` had `4,536` rows with newest `updated_at=2026-05-12T16:29:37Z`.
- `torghut_control_plane.quant_pipeline_health` estimated `5,337` live rows and still had no sampled autoanalyze or
  autovacuum timestamp.

## Problem

The control plane currently has proof, but not proof credit.

The user-facing and machine-facing symptoms are specific:

1. Swarm status can stay frozen from stale stage clocks while Kubernetes creates current jobs.
2. Recent workflow windows can show no failed jobs while retained failed jobs still dominate operator trust.
3. A current watch stream can observe AgentRuns while controller ingestion self-report remains unknown.
4. A healthy database and service route can coexist with held dispatch and merge action classes.
5. A schedule runner can start multiple attempts while the status plane says the stage is frozen.
6. A deployer cannot tell which current evidence is enough to reclock the freeze and which evidence only proves
   bounded repair.

Without an evidence-credit authority, each consumer makes a local judgment. Schedulers can over-launch because they
see runtime readiness. Deployer checks can over-block because they see retained failures. Status can be truthful but
not actionable because it lists receipts without telling a stage what it can spend.

## Alternatives Considered

### Option A: Keep The Freeze Manual

Leave stage freezes and stale clocks as manual operator conditions. Engineers inspect Jobs, AgentRuns, status, and
events, then decide whether to clear the freeze through follow-up work.

Advantages:

- No new runtime schema.
- Keeps the current conservative safety posture.
- Avoids accidentally clearing a real outage.

Disadvantages:

- Increases manual intervention.
- Does not reduce duplicate schedule attempts.
- Does not shorten PR-to-rollout diagnosis because deployers still hand-join evidence.
- Lets useful current proof sit unused while the Swarm remains frozen.

Decision: reject. Manual freeze handling is the current problem, not the target architecture.

### Option B: Reclock Stages From Recent Successful Jobs

If a recent schedule Job or AgentRun succeeds, update the stage clock and clear the freeze.

Advantages:

- Simple mental model.
- Converts live evidence into stage freshness.
- Likely reduces stale-stage false positives quickly.

Disadvantages:

- Treats all successes as equal, even when controller ingestion self-report is missing.
- Ignores retained failed Jobs and active duplicate launches.
- Does not give deployers a PR-to-rollout certificate.
- Can clear a freeze based on a wrapper success that did not complete the mission contract.

Decision: reject as the whole architecture. Job success is one credit input, not the authority.

### Option C: Stage Evidence Credit Authority

Create a credit ledger that prices evidence from stage clocks, AgentRuns, Jobs, controller witnesses, workflow windows,
source rollout truth, route stability, material verdicts, NATS, memory, and PR rollout checks. A stage can reclock,
launch, or widen only by spending a current credit whose debt state permits that action.

Advantages:

- Reduces failed AgentRuns by denying duplicate launches while active debt exceeds the credit budget.
- Shortens PR-to-rollout diagnosis because deployers consume one certificate instead of many raw receipts.
- Preserves ready-status truth: `/ready=ok` remains serving truth, while credit receipts carry action truth.
- Lets current proof reclock stale stages without deleting retained failure audit.
- Gives Torghut a bounded way to request zero-notional repair work while capital stays held.

Disadvantages:

- Adds a new reducer, status projection, and scheduler admission hook.
- Requires careful weighting so a wrapper success does not erase material failure debt.
- Needs UI and handoff wording for `credit`, `debt`, `reclock`, and `hold` states.

Decision: select Option C.

## Architecture

Jangar adds `stage_evidence_credit_authority` to control-plane status in shadow mode first.

```text
stage_evidence_credit_authority
  schema_version
  authority_id
  generated_at
  fresh_until
  namespace
  swarm_name
  source_revision
  gitops_revision
  stage_credits[]
  launch_credit_windows[]
  freeze_reclock_receipts[]
  pr_rollout_certificates[]
  torghut_repair_credit_ref
  authority_decision          # observe | repair_only | hold | block
  rollback_target
```

Each stage credit is scoped and spendable:

```text
stage_evidence_credit
  credit_id
  stage
  action_class
  earned_from_refs[]
  blocked_by_refs[]
  debt_refs[]
  credit_state                # earned | partial | retained | stale | denied
  spend_scope                 # observe | repair | normal_dispatch | deploy_widen | merge_ready
  max_new_agentruns
  max_active_agentruns
  max_runtime_seconds
  expires_at
  required_repair_actions[]
```

Credit rules:

- A current successful schedule Job can earn a stage credit only when its generated AgentRun or OrchestrationRun is
  observed by the watch stream and the run cites the governing design or runtime requirement.
- A current running AgentRun earns no normal-dispatch credit until it exits successfully; it can hold duplicate launch
  budget while active.
- Retained failed Jobs stay as debt, but a later success at the same stage/source can mature them from active debt to
  retained debt.
- Controller deployment and watch evidence can earn observe or repair credit; AgentRun ingestion self-report is
  required for normal dispatch, deploy widening, and merge-ready credit.
- Database and source-schema health can earn deploy evidence only when the source rollout truth exchange agrees with
  the live image digest and GitOps revision.
- Torghut repair credit is zero notional by default and cannot upgrade paper or live capital.

## Implementation Scope

M1 is intentionally small and testable: add a pure `stage-evidence-credit-authority` reducer under
`services/jangar/src/server/` with fixtures for the May 12 evidence shape. The reducer must not create Kubernetes
resources, update Swarm status, or modify database rows. It reads typed inputs and emits a deterministic receipt.

M2 publishes the receipt through `/api/agents/control-plane/status` and `/ready` without changing liveness. This makes
deployer and engineer handoffs concrete while the authority is still shadow.

M3 wires scheduler admission to the receipt in observe mode. It records predicted allow/hold decisions against actual
launches and reports the delta.

M4 enforces only duplicate active-debt denial for stages with more active AgentRuns than credit budget. Bounded repair
continues when the receipt names one repair target and a max runtime.

M5 adds PR-to-rollout certificates. A PR cannot be called deploy-ready until the certificate cites green CI, GitOps
revision, Argo sync, workload readiness, service route, controller witness, database health, and no active stage debt
for the touched action class.

M6 lets Torghut consume zero-notional repair credit from the companion contract. Paper and live capital remain held
until the Torghut proof floor, route/TCA, promotion, market context, and Jangar credit receipts all clear.

## Validation Gates

Every implementation PR must cite this design or the source swarm mission architecture before changing runtime code.

Required tests:

- Unit tests for credit earning from current success, active running work, retained failure debt, controller witness
  split, and stale Swarm clocks.
- Unit tests proving wrapper success does not clear material failure debt without a matching AgentRun outcome.
- Control-plane status tests proving the receipt appears in shadow mode and `/ready` keeps serving semantics separate
  from action semantics.
- Scheduler admission tests proving duplicate active-debt denial does not block a single bounded repair run.
- Deployer certificate tests proving merge-ready remains held while controller ingestion self-report is missing.

Required runtime checks after merge:

- `kubectl get applications.argoproj.io -n argocd agents jangar -o wide`
- `kubectl get deploy,pods,jobs,cronjobs -n agents -o wide`
- `curl -fsS http://jangar.jangar.svc.cluster.local/ready`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '.stage_evidence_credit_authority'`
- `gh pr checks <pr> --watch -R proompteng/lab`

Value-gate mapping:

| Milestone | Scope                                                                              | Value gates                                                                     |
| --------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| M0        | Merge this design, companion Torghut contract, mission ledger, and handoff.        | `handoff_evidence_quality`                                                      |
| M1        | Pure credit reducer and fixtures for stale stages, active runs, retained failures. | `ready_status_truth`, `failed_agentrun_rate`                                    |
| M2        | Shadow status projection without changing liveness.                                | `ready_status_truth`, `handoff_evidence_quality`                                |
| M3        | Scheduler observe-mode comparison against actual launches.                         | `failed_agentrun_rate`, `manual_intervention_count`                             |
| M4        | Enforce duplicate active-debt denial while allowing bounded repair.                | `failed_agentrun_rate`, `manual_intervention_count`                             |
| M5        | Add PR-to-rollout certificates for deploy/merge handoff.                           | `pr_to_rollout_latency`, `ready_status_truth`, `handoff_evidence_quality`       |
| M6        | Admit Torghut zero-notional repair credits; keep paper/live capital held by proof. | `failed_agentrun_rate`, `manual_intervention_count`, `handoff_evidence_quality` |

## Rollout

Roll out in four phases.

Phase 1 is shadow projection only. The receipt appears in status, but no scheduler or deployer decision changes.

Phase 2 is audit comparison. The scheduler records predicted credit decisions beside actual launches. The acceptance
gate is one full cadence with no material disagreement that would have blocked a successful required repair.

Phase 3 denies duplicate active-debt launches. A stage with active work above budget gets `hold`, and the receipt names
the active AgentRuns and the smallest repair action.

Phase 4 makes deploy and merge consumers require PR-to-rollout certificates. This phase starts only after phase 3 has
shown fewer duplicate active launches or has reported the exact blocker.

## Rollback

Rollback is feature-flagged at each consumer.

- Disable scheduler enforcement and keep the receipt in shadow.
- Ignore `stage_evidence_credit_authority` in deployer checks and fall back to material action verdicts plus source
  rollout truth.
- Keep retained debt audit rows and receipts; do not delete history during rollback.
- Preserve Torghut zero-notional holds even if Jangar repair credit consumption is disabled.

The safe fallback is the current material action verdict plus source rollout truth model. It is conservative and noisy,
but it prevents normal dispatch and merge-ready widening while controller ingestion truth is incomplete.

## Risks

- Credit weighting can be too generous and reclock a stage from weak wrapper evidence.
- Credit weighting can be too strict and keep the Swarm frozen despite a real recovery.
- Status size can grow if every retained failure is embedded instead of referenced.
- Engineers can treat credit receipts as capital permission unless the Torghut contract keeps zero-notional semantics
  explicit.
- Memory freshness is lagging the current run, so mission ledgers and NATS evidence must stay canonical until memory
  writes are proven current again.

## Engineer Handoff

Build M1 first. Own `services/jangar/src/server/stage-evidence-credit-authority.ts` and a focused test file. Inputs
should be plain objects from existing status reducers. Do not edit `supporting-primitives-controller.ts` until the pure
reducer has tests.

Acceptance gates:

- A stale Swarm with current successful proof earns only `repair` or `reclock_candidate` credit until ingestion
  self-report is current.
- Active duplicate AgentRuns consume launch budget and prevent additional normal launches.
- Retained failure debt remains visible after later success.
- The output names one next repair action for each held stage.

## Deployer Handoff

After M2 or later, validate that the authority is shadow-only before using it as a gate.

Acceptance gates:

- Argo `agents` and `jangar` are `Synced/Healthy`.
- Jangar `/ready` is HTTP 200, but material action holds remain visible when controller ingestion is unknown.
- The credit authority receipt is current and cites controller witness, stage clock, AgentRun, Job, database, source,
  and route evidence.
- No rollout is called complete until the PR-to-rollout certificate cites GitOps revision, workload readiness, service
  route, controller witness, and active-debt state.
