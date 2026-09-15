# 161. Jangar Stage-Debt Clearinghouse And Freshness Credit Ledger (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane execution trust, stale-stage freeze retirement, workflow evidence, read-only/database
freshness projection, bounded repair admission, validation, rollout, rollback, and engineer/deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/165-torghut-quant-freshness-debt-and-paper-edge-ledgers-2026-05-07.md`

Extends:

- `160-jangar-split-authority-repair-escrow-and-dispatch-reentry-packets-2026-05-07.md`
- `159-jangar-closed-loop-repair-outcome-ledger-and-material-action-reentry-2026-05-07.md`
- `158-jangar-controller-ingestion-epochs-and-profit-evidence-refill-gates-2026-05-07.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`

## Decision

I am selecting a stage-debt clearinghouse and freshness credit ledger as the next Jangar control-plane architecture
step.

The control plane is serving, but execution trust is still degraded. The fresh evidence is not a hard outage: Jangar
and Agents deployments are available, the status route is reachable, database migration consistency is healthy, watch
reliability is healthy, recent scheduled jobs are completing, and current discover/verify jobs are running. The failure
mode is that stale-stage and StageStaleness freeze state remain authoritative even when the workflow surface is already
producing newer repair evidence.

The system needs a middle state between "everything is healthy" and "freeze all work". That state should not open
normal dispatch, deploy widening, merge readiness, paper, or live capital. It should issue short-lived freshness
credits that prove a specific stage has new terminal or in-flight evidence, then use those credits to retire stale-stage
debt when the evidence closes. The clearinghouse gives engineers a way to show progress without bypassing the gates
that are protecting source identity and capital.

The tradeoff is that we add another reducer to an already rich status payload. I accept that because the reducer turns
an opaque liveness problem into a bounded accounting problem: which stage is stale, which run is trying to repair it,
what receipt would retire it, and what gates remain closed until retirement is complete.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` publishes `stage_debt_clearinghouse`.
- Each tracked swarm/stage has a `stage_debt_state`: `healthy`, `repair_credit_open`, `stale_debt`,
  `freeze_debt`, `blocked_debt`, or `unknown`.
- Running jobs may create `repair_credit_open` only for `discover`, `plan`, `implement`, or `verify` on the same
  swarm and stage.
- A credit names a source: AgentRun, Job, CronJob wave, stage state, workflow window, controller witness, watch epoch,
  database projection, and source rollout truth receipt.
- Credits can retire stage debt only after a terminal receipt closes with `Succeeded` and the stage state or latest
  workflow evidence is newer than the stale blocker.
- StageStaleness freeze debt can move to `retire_pending` only when every frozen stage has either terminal success or
  an active bounded repair credit younger than one cadence.
- `dispatch_repair` and `torghut_observe` may consume credits in shadow/warn mode; `dispatch_normal`,
  `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` remain held or blocked until
  source rollout truth and Torghut proof floor are current.
- Deployer output can answer three questions without reading raw jobs: which stages are stale, which repair attempts
  are earning credit, and which evidence will retire the freeze.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 from 19:00Z to 19:10Z. I did not mutate Kubernetes resources, database
records, GitOps resources, AgentRun objects, broker state, or trading flags.

### Cluster And Rollout Evidence

- The local kubeconfig current context was unset, but the in-cluster `agents-sa` service account could read common
  Kubernetes resources.
- Jangar deployments were available: `jangar=1/1`, `bumba=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`.
- Jangar pod `jangar-865f8f4768-bq94m` was `2/2 Running` on image
  `registry.ide-newton.ts.net/lab/jangar:c7f3aa1b@sha256:6ca018b8...`; events showed a recent rollout replacing
  `jangar-594b6746fd-5lhwp`, plus recurring stale `elasticsearch-master-pdb` `NoPods` noise.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Agents events showed a recent controller rollout and transient readiness probe timeouts on the new
  `agents-controllers-67949b78bb` pods, followed by available deployment state.
- Recent workflow jobs show the stale-stage gap clearly: many Jangar control-plane scheduled runs completed, while
  current `verify` and `discover` jobs were still running. The status route still reported execution trust degraded.
- Current AgentRuns included `jangar-control-plane-verify-sched-tqhhv` running for about 17 minutes,
  `jangar-control-plane-discover-sched-bmg76` running for about 3 minutes, and `torghut-quant-discover-sched-482m7`
  running for about 1 minute.

### Jangar Status And Database Evidence

- `/ready` returned `status=ok`, leader election was active and current, and orchestration controller health was
  started.
- Execution trust was `degraded` because `jangar-control-plane:verify` was stale and `torghut-quant` was frozen by
  StageStaleness; discover, plan, implement, and verify for Torghut were delayed by the freeze.
- Database status through the Jangar route was healthy: configured, connected, latency `2 ms`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, latest applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Direct CNPG/database inspection was blocked by RBAC. Listing CNPG clusters in `jangar` was forbidden, and
  `kubectl cnpg psql -n jangar jangar-db` failed because `agents-sa` cannot create `pods/exec`.
- Watch reliability was healthy with two observed streams, `1032` events, `0` errors, and `0` restarts.
- `agentrun_ingestion.status` was `unknown` with message `agents controller not started`, while controller heartbeat
  evidence in source rollout truth was fresh but split.
- Source rollout truth was still `heartbeat_projection_split`; `serve_readonly` and `torghut_observe` were allowed,
  while `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`,
  `live_micro_canary`, and `live_scale` were held or blocked.

### Torghut And Data Evidence

- Torghut live and simulation Knative revisions were available at `torghut-00278=1/1` and `torghut-sim-00378=1/1`.
- Live `/trading/health` returned HTTP `503` with `status=degraded`; Postgres, ClickHouse, Alpaca, Jangar universe,
  readiness cache, and broker status were healthy.
- Live proof floor was `repair_only`, `capital_state=zero_notional`, `max_notional=0`, and blocked by
  `hypothesis_not_promotion_eligible`, `degraded`, `execution_tca_route_universe_empty`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live quant evidence had `144` latest metrics updated at `2026-05-07T19:08:41Z`, but the ingestion stage lag was
  `534758` seconds and the materialization stage was not OK.
- Simulation `/trading/health` was OK, but proof floor remained `repair_only` and zero-notional. Simulation had one
  `NVDA` probing path, seven missing symbols, stale TCA at about `90502` seconds, stale market context, and zero latest
  quant metrics.

## Source Assessment

- `services/jangar/src/server/control-plane-execution-trust.ts` derives stage staleness from Swarm status, freeze
  state, `lastRunTime`, `recentSuccessAt`, and stage freshness flags. It does not correlate Kubernetes Job or AgentRun
  terminal evidence back into a staged debt ledger.
- `services/jangar/src/server/control-plane-workflows.ts` counts active job runs, recent failures, and failure reasons
  across workflow jobs. That gives a namespace-level reliability window, but it does not say which active job is
  repairing which stale stage.
- `services/jangar/src/server/control-plane-status.ts` assembles execution trust, workflow reliability, source rollout
  truth, route stability, and dependency quorum into one status route. It is the right integration point for a
  clearinghouse reducer because it already has the controller, database, watch, rollout, and workflow inputs.
- Existing tests cover source rollout truth, route stability, watch reliability, material action verdicts, status
  assembly, and migration registry behavior. The missing regression surface is a stale stage with current in-flight or
  terminal repair evidence and a StageStaleness freeze that should be retired only by matching credits.

## Problem

The control plane currently over-compresses stage evidence. A stage is either fresh enough or it contributes to
execution trust degradation. That is safe for deploy and capital gates, but too coarse for repair operations.

The current failure is a liveness problem:

1. Recent Jangar scheduled jobs completed, and current stage jobs are running.
2. Execution trust still treats the verify stage as stale.
3. Torghut remains frozen by StageStaleness even while quant/discover repair work is active.
4. Operators can see active repair work in Jobs and AgentRuns, but the status payload lacks a receipt that connects that
   work to stale-stage debt retirement.

That creates pressure to either ignore the stale-stage gate or keep dispatch frozen until a later reconciliation pass
notices the work. Neither is the right six-month architecture.

## Alternatives Considered

### Option A: Make Execution Trust Strictly Block On Any Stale Stage

Pros:

- Simple and conservative.
- Prevents stale evidence from ever admitting action.
- Keeps implementation close to the current reducer.

Cons:

- Current evidence shows it can freeze repairs while repair runs are already producing newer evidence.
- It does not distinguish a dead stage from a stage actively earning repair credit.
- It gives deployers no closure condition except waiting.

Decision: reject. Strict freeze protects capital, but it leaves repair liveness to luck.

### Option B: Trust Successful Jobs Directly And Clear Stage Staleness Immediately

Pros:

- Fastest path out of stale-stage degradation.
- Reuses Kubernetes Job status without adding a new object.
- Reduces operator confusion when jobs visibly complete.

Cons:

- A completed Job is not enough to prove the right swarm/stage was repaired.
- It can clear freezes without source rollout truth, controller witness, database, and watch agreement.
- It weakens the material-action model by treating raw job completion as authority.

Decision: reject. Job completion is evidence, not authority.

### Option C: Add A Stage-Debt Clearinghouse And Freshness Credit Ledger

Pros:

- Makes stale-stage debt explicit and auditable.
- Lets active and terminal repair work earn bounded credit without opening normal dispatch or capital.
- Preserves source rollout truth, controller witness, database, watch, and route gates.
- Produces a concrete handoff for engineer and deployer stages.

Cons:

- Adds reducer complexity.
- Requires tests that model both Kubernetes job evidence and Swarm status evidence.
- Some credits will expire and need renewed evidence.

Decision: select Option C.

## Architecture

Add a pure reducer named `control-plane-stage-debt-clearinghouse` under `services/jangar/src/server/`.

Inputs:

- Execution trust snapshot.
- Workflow reliability snapshot.
- Swarm CRD stage states.
- Recent AgentRun list for tracked swarms.
- Recent Jobs and CronJob waves for tracked swarms.
- Controller witness quorum.
- Database projection and migration consistency.
- Watch reliability.
- Rollout health for `agents` and `agents-controllers`.
- Source rollout truth exchange.
- Split-authority repair escrow, when available.

Output shape:

```text
stage_debt_clearinghouse
  mode                         # shadow, warn, enforce
  generated_at
  fresh_until
  namespace
  design_artifact
  swarms[]
    swarm
    phase
    freeze_reason
    freeze_until
    freeze_debt_state          # none, active, retire_pending, blocked, unknown
    stages[]
      stage
      stage_debt_state         # healthy, repair_credit_open, stale_debt, freeze_debt, blocked_debt, unknown
      stale_reason
      stale_since
      latest_stage_state_ref
      latest_terminal_receipt_ref
      active_credit_ref
      retire_after_ref
      allowed_action_classes
      held_action_classes
      blocked_action_classes
  credits[]
    credit_ref
    swarm
    stage
    credit_state               # open, terminal_success, terminal_failure, expired, rejected
    source_kind                # agentrun, job, cronjob_wave, stage_state
    source_ref
    started_at
    completed_at
    fresh_until
    max_runtime_seconds
    required_witness_refs[]
    retire_debt_ref
    rollback_target
  deployer_summary
    stale_stage_count
    open_credit_count
    retire_pending_count
    freshest_blocking_reason
    next_evidence_needed[]
```

Credit admission requires:

- matching swarm and stage labels or AgentRun parameters;
- source object created after the stale blocker timestamp;
- controller witness fresh or split-authority repair escrow open;
- database migration consistency healthy;
- watch reliability healthy or degraded below block thresholds;
- source rollout truth at least allows `serve_readonly`;
- no live or paper capital class opened by the credit.

Debt retirement requires:

- terminal success for the same swarm/stage;
- terminal evidence newer than the stale blocker;
- no newer terminal failure for the same stage;
- current database and watch projection;
- source rollout truth still converged for `serve_readonly`;
- no active freeze reason other than StageStaleness for the same swarm.

## Implementation Scope

Engineer stage should:

1. Add `control-plane-stage-debt-clearinghouse.ts` as a pure reducer with deterministic fixtures.
2. Add KubeGateway readers for recent Jobs and AgentRuns if existing readers cannot provide the needed labels and
   terminal timestamps.
3. Include `stage_debt_clearinghouse` in `ControlPlaneStatus`.
4. Add deployer summary fields to the status route and UI data model.
5. Keep the first rollout in `shadow` mode. In shadow mode, the reducer emits credits but does not change action
   decisions.
6. In `warn` mode, let `dispatch_repair` cite a `repair_credit_open` ref, while all stronger action classes continue
   to use source rollout truth and proof floor.
7. In `enforce` mode, allow StageStaleness freeze retirement only through terminal successful credits.

Deployer stage should:

1. Confirm `/ready` remains OK after shadow rollout.
2. Capture `stage_debt_clearinghouse.deployer_summary`.
3. Confirm stale verify debt has either an open credit or a terminal receipt.
4. Confirm Torghut StageStaleness freeze debt is not retired until all four Torghut stages have matching credits or
   fresh stage state.
5. Confirm `paper_canary`, `live_micro_canary`, and `live_scale` stay held or blocked while proof floor is
   `repair_only`.

## Validation Gates

Required local checks:

- `bun test services/jangar/src/server/__tests__/control-plane-stage-debt-clearinghouse.test.ts`
- `bun test services/jangar/src/server/__tests__/control-plane-status.test.ts -t stage_debt_clearinghouse`
- `bunx oxfmt --check docs/agents/designs/161-jangar-stage-debt-clearinghouse-and-freshness-credit-ledger-2026-05-07.md`

Required read-only cluster checks:

- `curl -fsS http://jangar.jangar.svc.cluster.local/ready`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.stage_debt_clearinghouse.deployer_summary'`
- `kubectl get agentruns -n agents --sort-by=.metadata.creationTimestamp | tail -40`
- `kubectl get jobs -n agents --sort-by=.metadata.creationTimestamp | tail -40`

Acceptance gates:

- A stale stage with no matching current run remains `stale_debt`.
- A stale stage with a running matching run becomes `repair_credit_open`.
- A stale stage with a newer successful terminal receipt becomes `healthy` or `retire_pending`.
- A failed terminal receipt does not retire debt.
- StageStaleness freeze retirement never opens capital classes.

## Rollout Plan

Phase 0, design acceptance:

- Merge this architecture doc and the companion Torghut doc.
- Publish engineer and deployer handoff with exact evidence gates.

Phase 1, shadow:

- Emit the reducer in status only.
- Compare its deployer summary against raw Jobs, AgentRuns, and execution trust for at least two scheduled cycles.
- No action decisions change.

Phase 2, warn:

- Permit `dispatch_repair` to cite open credits in status output.
- Continue to hold `dispatch_normal`, deploy, merge, paper, and live classes.
- Alert when StageStaleness freeze has terminal credit but remains unreconciled for more than one cadence.

Phase 3, enforce:

- Allow StageStaleness freeze retirement only through terminal successful credits.
- Reject stale-stage freeze retirement when the latest terminal receipt failed, database projection is unhealthy, or
  watch reliability is blocked.

## Rollback Plan

- Disable the reducer with `JANGAR_STAGE_DEBT_CLEARINGHOUSE_MODE=off`.
- Ignore `stage_debt_clearinghouse` in deployer tooling and return to current execution trust behavior.
- Keep all source rollout truth and proof-floor gates unchanged.
- If a credit incorrectly retires debt, restore the previous freeze state and require a new terminal receipt after the
  rollback timestamp.
- If status payload size becomes a problem, cap credit samples to the latest terminal and latest active credit per
  swarm/stage while preserving aggregate counts.

## Risks And Tradeoffs

- False credit risk: a job may be mislabeled. Mitigation: require matching swarm/stage labels and AgentRun parameters.
- Stale credit risk: an active run can hang. Mitigation: every credit has `fresh_until` and `max_runtime_seconds`.
- Status complexity risk: deployers may see another object. Mitigation: keep the summary small and make raw credit rows
  optional in UI.
- RBAC evidence gap: direct DB inspection is blocked from this worker. Mitigation: use the healthy Jangar database
  projection as the runtime gate and require CNPG read access only for deeper data audits.
- Capital leakage risk: repair credits could be misread as paper/live authority. Mitigation: the contract explicitly
  forbids capital class changes from the clearinghouse.

## Handoff To Engineer

Build the reducer and tests first. Do not wire it into admission until the shadow status payload proves that open
credits match raw Jobs and AgentRuns. The first implementation should focus on `jangar-control-plane:verify` and
`torghut-quant:*` because those are the current stale/frozen surfaces.

The reducer is successful when a deployer can answer: "the verify stage is stale, this run is earning repair credit,
this receipt will retire it, and paper/live remain closed."

## Handoff To Deployer

After the shadow build deploys, capture:

- `/ready`
- `stage_debt_clearinghouse.deployer_summary`
- `execution_trust`
- `source_rollout_truth_exchange.deployer_summary`
- `watch_reliability`
- `database.migration_consistency`
- recent AgentRuns and Jobs for the tracked swarms

Proceed only if the reducer explains stale-stage debt without opening normal dispatch or capital. Roll back the feature
flag if the clearinghouse contradicts raw terminal evidence or hides a failed run behind an open credit.
