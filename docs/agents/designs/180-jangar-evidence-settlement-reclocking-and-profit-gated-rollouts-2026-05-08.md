# 180. Jangar Evidence Settlement, Reclocking, And Profit-Gated Rollouts (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane reliability, AgentRun schedule dispatch, source-to-serving rollout truth, and Torghut
profit-evidence admission.

Companion Torghut contract:

- `docs/torghut/design-system/v6/184-torghut-profit-frontier-reclocking-and-capital-reentry-guardrails-2026-05-08.md`

## Decision

Jangar should move from process-local freeze and retry behavior to a durable **evidence settlement and reclocking spine**.

The control plane already has useful signals: execution trust, rollout health, dependency quorum, runtime admission,
Torghut consumer evidence, and negative evidence routing. The weak part is that those signals are assembled late and do
not yet become a durable dispatch contract before schedule runners create more work. The next architecture milestone is
to settle every stage window into a small durable evidence epoch, classify failure debt by stage and cause, and require a
fresh admission packet before material work can be dispatched.

The tradeoff is that some work will be held earlier. That is intentional. The current failure pattern shows that cheap
local retries can create expensive cluster noise while the actual blocker is stale stage evidence, a route-proof gap, or
serving-source disagreement. Holding work with a reasoned reclock condition is better than launching another schedule
job that is already unlikely to improve the business metric.

## Governing Mission

The runtime business metric is to reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout time for the
Jangar control plane.

The validation contract is:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

The value gates are `failed_agentrun_rate`, `pr_to_rollout_latency`, `ready_status_truth`,
`manual_intervention_count`, and `handoff_evidence_quality`.

## Evidence Snapshot

This evidence pass was read-only on 2026-05-08.

- Kubernetes access runs as `system:serviceaccount:agents:agents-sa`. `kubectl config current-context` is unset, but the
  in-cluster service account can read many workload surfaces. It cannot list StatefulSets, CNPG clusters, CNPG backups,
  or exec into database pods, so direct database inspection is not available from this run.
- Argo CD reports `agents` and `jangar` as `Synced` but `Progressing`. `torghut` is `OutOfSync` and `Healthy`.
  `rook-ceph` is `Synced` and `Degraded`, which matters because persistent evidence ledgers should degrade cleanly
  rather than assuming storage is always healthy.
- The `agents` namespace has many historical `Completed` and `Error` pods, plus recent schedule-runner
  `BackoffLimitExceeded` events for Jangar and Torghut discover, plan, implement, and verify cron lanes. Controller and
  API pods are up, but events still show readiness probe timeouts against `/ready` during the rollout.
- Jangar `/health` returns `ok`, and `/ready` returns `ok` with leader election success. The same readiness surface also
  reports active `StageStaleness` freezes for Jangar and Torghut swarm stages, while `agentsController` and
  `supportingController` were observed disabled in the service payload. That is a status-truth gap: the HTTP code says
  ready while the execution plane says the mission lane is not fit for material dispatch.
- Torghut is live on active revision `torghut-00308` with version `v0.568.5-588-ge87e3d87d`. `/readyz` and
  `/trading/health` return HTTP 503 degraded. Postgres, ClickHouse, Alpaca, schema currentness, and empirical jobs are
  OK; live submission is blocked by `simple_submit_disabled`, promotion is blocked by
  `hypothesis_not_promotion_eligible`, quant evidence reports `quant_pipeline_stages_missing`, and market context
  has stale domains.
- Torghut `/trading/status` reports three hypotheses, all in shadow, zero promotion eligible, and all rollback
  required. TCA has 7,334 orders with average absolute slippage around 13.82 bps, but the latest execution is
  2026-04-02, so the execution proof is old relative to the active route gates.
- Torghut `/trading/consumer-evidence` emits `torghut.consumer-evidence-status.v1`, schema head `0030_evidence_epochs`,
  active revision `torghut-00308`, and a route-proven profit receipt in `repair` state. The receipt names
  `forecast_registry_degraded`, `simple_submit_disabled`, and `hypothesis_not_promotion_eligible` as reason codes.
- Source risk is concentrated. `services/jangar/src/server/supporting-primitives-controller.ts` is 3,325 lines and owns
  CRD watches, schedule runner generation, freeze state, namespace queues, resource-key throttles, workspace/PVC
  reconciliation, and unfreeze timers. `control-plane-status.ts` assembles rollout truth, execution trust, dependency
  quorum, Torghut consumer evidence, and degraded components. `services/torghut/app/trading/autonomy/policy_checks.py`
  is 6,072 lines and owns a large share of capital and policy evaluation.
- `services/jangar/src/server/primitives-kube.ts` already includes PVC aliases, so the current high-risk source seam is
  not missing PVC support. The risk is that schedule, freeze, rollout, and profit-admission decisions are spread across
  large modules without a durable settlement record that later stages can audit.

## Problem

The system currently has several good status signals but no single settled dispatch fact.

That creates four failure modes.

1. **Retry amplification.** A schedule runner can launch while the lane is frozen or stale, then fail with the same
   reason and consume another pod, controller event, and operator attention cycle.
2. **Ready-status ambiguity.** `/ready` can be HTTP `ok` while execution trust is degraded, because process liveness and
   material-action fitness are reported on the same surface without a stricter action class.
3. **Rollout truth lag.** A PR can merge and an image can roll, but the control plane needs a compact certificate that
   says source commit, image revision, Argo sync/health, service readiness, and runtime business evidence agree.
4. **Profit evidence is advisory too late.** Torghut correctly blocks live capital, but Jangar still needs to use that
   proof earlier to decide whether a Torghut stage should run, reclock, or wait for repair evidence.

## Alternatives Considered

### Option A: Tune Freeze Thresholds And Retry Backoff

This is the fastest path. Increase stale-stage thresholds, lower retry counts, or widen CronJob backoff windows.

Pros:

- Low implementation cost.
- Easy to test locally around schedule-runner generation.
- Reduces some immediate failed pods.

Cons:

- Does not explain which evidence surface is stale.
- Can hide real source-serving drift by waiting longer.
- Does not connect Torghut profit gates to Jangar dispatch.
- Does not create a better handoff for engineer and deployer stages.

Decision: use only as an emergency safety valve. It is not the main architecture.

### Option B: Split The Supporting Controller Into More Controllers

Move schedule, workspace, freeze, and primitive reconciliation into separate deployable controllers.

Pros:

- Reduces blast radius of one large module.
- Gives each controller a clearer readiness and ownership model.
- Improves long-term maintainability.

Cons:

- Increases deployment and leader-election surface before the dispatch contract is fixed.
- Does not by itself stop bad work from being admitted.
- Requires more migration choreography during an already noisy control-plane window.

Decision: useful after settlement is in place. Splitting controllers should consume settled evidence, not replace it.

### Option C: Durable Evidence Settlement And Reclocking Spine

Settle each control-plane stage window into durable evidence, classify failure debt, and require a fresh admission packet
before material dispatch.

Pros:

- Directly targets failed AgentRuns by preventing known-stale launches.
- Gives `/ready` a stricter material-action truth surface.
- Shortens PR-to-rollout diagnosis by making the missing receipt explicit.
- Lets Torghut profit repair evidence prioritize zero-notional work without relaxing capital gates.
- Creates concrete implementation and verification contracts for later swarm stages.

Cons:

- Requires new schema or persisted status records.
- Requires careful shadow rollout so existing CronJobs are not abruptly stranded.
- Adds another concept that must stay small and deterministic.

Decision: select Option C.

## Chosen Architecture

The evidence settlement spine has six parts.

### 1. Stage Evidence Epoch

Each swarm, stage, and schedule window gets one compact epoch. The epoch records source commit, runtime revision, Argo
state, stage input digest, stage output digest, controller leader identity, terminal pod summary, readiness state, and
consumer evidence refs.

The epoch is not a log dump. It is the small fact that later admission and verification code can trust.

Required fields:

```text
stage_evidence_epoch
  swarm_name
  stage
  window_id
  source_commit
  runtime_revision
  argo_sync_status
  argo_health_status
  controller_leader
  controller_ready_status
  terminal_result
  failure_class
  evidence_refs
  settled_at
  fresh_until
```

### 2. Failure Debt Ledger

Terminal failures become debt entries. Debt is keyed by swarm, stage, failure class, governing design, and source commit.
The same debt should not keep creating equivalent pods. It should be retired by a newer successful epoch, an explicit
operator waiver, or a design-backed reclock condition.

Failure classes:

- `stage_staleness`
- `runner_contract_error`
- `source_serving_drift`
- `rollout_not_converged`
- `database_evidence_unavailable`
- `torghut_profit_gate_blocked`
- `external_dependency_unavailable`
- `unknown_terminal_failure`

### 3. Reclocking Arbiter

The arbiter decides whether a stage can retry now, must wait until a clock expires, or must wait for a specific evidence
receipt. It replaces open-ended process-local unfreeze timers with settled conditions.

Examples:

- A `StageStaleness` freeze can retry only when a newer epoch exists for the stage input or a dependency receipt has a
  later `settled_at`.
- A Torghut implement stage blocked by profit evidence can retry only when the consumer evidence receipt has a fresher
  route-proven profit receipt or a selected zero-notional repair packet.
- A rollout verify stage can retry only when the rollout certificate points to the new source commit and the service
  readiness clock is fresh.

### 4. Dispatch Admission Packet

Before creating a CronJob, Jangar should build an admission packet. The packet cites the governing design, current
validation contract, last settled epoch, open debt, reclock decision, and expected validation command or runtime check.

If the packet is denied, the schedule runner does not launch. It records a skipped dispatch with the denial reason and
the next evidence required.

### 5. Rollout Certificate

PR-to-rollout work needs one certificate that can be checked by verify stages and handoffs.

Required facts:

- merged PR number and squash commit;
- image or runtime revision observed in Kubernetes;
- Argo app sync and health;
- workload readiness and service readiness;
- Jangar `/ready` material-action status;
- Torghut consumer evidence when the action depends on Torghut;
- rollback condition and last known good revision.

### 6. Torghut Profit Evidence Join

Jangar should consume Torghut profit frontier packets as dispatch evidence, not as permission to trade. If Torghut says
the route is in `repair` state, Jangar can spend work only on the named zero-notional repair. It should not launch
capital or promotion work until the Torghut guardrails say the hypothesis is promotion eligible.

## Implementation Milestones

| Milestone | Scope                                                                                                                    | Value gates                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| M0        | Merge this design, mission ledger, and handoff contract.                                                                 | `handoff_evidence_quality`                                                                        |
| M1        | Add stage evidence epoch schema and a shadow recorder fed by current status, schedule-runner, and terminal pod evidence. | `ready_status_truth`, `handoff_evidence_quality`                                                  |
| M2        | Add failure debt ledger and dispatch admission packets in shadow mode, including governing design citation.              | `failed_agentrun_rate`, `manual_intervention_count`                                               |
| M3        | Enforce denial for exact duplicate terminal debt while allowing explicit reclock receipts to reopen work.                | `failed_agentrun_rate`, `manual_intervention_count`                                               |
| M4        | Add rollout certificates for PR merge to Argo sync, workload readiness, service readiness, and source-serving parity.    | `pr_to_rollout_latency`, `ready_status_truth`                                                     |
| M5        | Join Torghut profit frontier packets into Jangar admission for Torghut stages.                                           | `failed_agentrun_rate`, `manual_intervention_count`, `handoff_evidence_quality`                   |
| M6        | Publish SLO counters and handoff evidence from settled epochs.                                                           | `failed_agentrun_rate`, `pr_to_rollout_latency`, `ready_status_truth`, `handoff_evidence_quality` |

## Validation Gates

Engineer stages must add tests before enforcement.

- Unit tests classify current observed failures: `StageStaleness`, `BackoffLimitExceeded`, readiness probe timeout,
  Torghut `simple_submit_disabled`, `quant_pipeline_stages_missing`, and direct database evidence unavailable by RBAC.
- Schedule-runner tests prove denied admission does not create a CronJob and records the next evidence requirement.
- Status tests prove `/ready` can distinguish process liveness from material-action fitness.
- Rollout-certificate tests prove a certificate is invalid when source commit, runtime revision, Argo status, workload
  readiness, or service readiness is missing.
- Consumer-evidence tests prove Torghut `repair` receipts admit only the named zero-notional repair action.

Deployer stages must prove behavior after rollout.

- Argo app for `jangar` is `Synced` and `Healthy` or the rollout certificate names the exact blocker.
- Jangar workload and `/ready` are healthy.
- Agents schedule lanes show fewer duplicate terminal failures for the same failure class and source commit.
- Torghut-dependent stages cite the Torghut frontier packet or are denied with a current reason.

## Rollout Plan

1. Ship the evidence epoch recorder in shadow mode. No schedule behavior changes.
2. Add failure debt and admission packet creation in shadow mode. Compare predicted denies against actual launches.
3. Enforce only exact duplicate terminal-debt denial for one low-risk stage class.
4. Add rollout certificate verification to verify stages.
5. Add Torghut profit evidence admission for Torghut stages, still zero-notional only.
6. Expand enforcement stage by stage once metrics show duplicate terminal failures falling without increasing manual
   intervention.

## Rollback Plan

Rollback must be boring.

- Disable enforcement and keep recording epochs.
- Keep old schedule-runner paths available until shadow parity is proven.
- Do not delete evidence records during rollback; stale evidence is safer than missing evidence for postmortems.
- If storage is degraded, fail open for non-material read-only discover work and fail closed for implement, verify,
  rollout, and capital-adjacent work.
- If Torghut frontier packets are unavailable, deny Torghut capital or promotion actions and allow only explicitly
  bounded repair actions.

## Risks And Mitigations

- **Risk: evidence schema becomes another sprawling status object.** Keep the epoch compact and append evidence refs
  instead of embedding logs.
- **Risk: enforcement blocks too much work early.** Start shadow-only, then enforce duplicate debt before enforcing
  broader gates.
- **Risk: direct database evidence remains RBAC-blocked.** Use service health and consumer evidence as the initial
  read-only witness, then create a least-privilege database witness milestone instead of granting broad exec.
- **Risk: profit evidence gets mistaken for capital approval.** The Torghut join is an admission input for repair work,
  not a trading permission shortcut.
- **Risk: controller split work distracts from dispatch safety.** Defer controller decomposition until settlement
  records exist and can be consumed by split controllers.

## Engineer Handoff

Start with M1 and M2 in `services/jangar/src/server`. The first production PR should add a shadow evidence epoch builder
and tests that replay the observed degraded cases. Do not enforce denies until the shadow packet proves it can explain
the current duplicate terminal failures.

The governing design citation for implementation PRs is this document. Each implementation PR must state which value
gate it targets and which epoch or admission packet proves success.

## Deployer Handoff

After the first implementation rollout, verify Argo, workload readiness, Jangar `/ready`, and the schedule-runner
failure rate for the same swarm/stage/source tuple. Rollback by disabling enforcement, not by clearing the ledger.

The deployer acceptance gate is a rollout certificate that names the merged PR, runtime revision, service readiness,
and the first metric movement or exact blocker for `failed_agentrun_rate` and `pr_to_rollout_latency`.
