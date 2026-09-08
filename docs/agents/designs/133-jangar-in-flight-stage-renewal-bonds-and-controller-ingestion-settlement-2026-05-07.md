# 133. Jangar In-Flight Stage Renewal Bonds And Controller Ingestion Settlement (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar stage freshness, schedule lease rehydration, controller ingestion proof, AgentRun settlement, material
action gates, Torghut capital handoff, validation, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/137-torghut-renewal-bond-profit-escrow-and-evidence-carry-2026-05-07.md`

Extends:

- `132-jangar-schedule-lease-rehydration-and-stage-trust-settlement-2026-05-07.md`
- `129-jangar-heartbeat-lane-escrow-and-material-verdict-stability-2026-05-06.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`

## Decision

I am selecting **in-flight stage renewal bonds with controller ingestion settlement** as the next Jangar control-plane
architecture step.

The schedule lease contract solved the wrong-time authority stamp: a cron runner must resolve current authority instead
of carrying a stale admission passport. The current live evidence shows the next problem one layer later. At
`2026-05-07T05:09Z`, `/ready` returned `status=ok`, runtime kits were healthy, and serving plus swarm admission
passports were fresh and allowed. The control-plane status route reported a healthy database with `28` registered and
applied Kysely migrations, healthy watch reliability with `4565` events and `0` errors or restarts in the 15 minute
window, and healthy controller heartbeats. Yet execution trust still degraded plan, implement, and verify as stale, and
the controller witness reduced normal dispatch to `repair_only` because controller ingestion self-report was missing.

The cluster was not idle. AgentRuns showed current Torghut and Jangar schedule work in flight, including active
Torghut discover, implement, and verify runs, plus a Torghut plan run that succeeded in the current window. The
existing trust model only knows terminal freshness and split controller ingestion. It cannot price an active renewal run
as bounded proof in flight, and it cannot settle whether the controller process has actually ingested the runs it is
creating. The result is conservative behavior, which is safer than premature dispatch, but it leaves engineers and
deployer gates with the wrong repair target.

The selected design keeps terminal success as the only proof that can clear material gates. It adds a renewal bond for
in-flight stage runs and a controller ingestion settlement that proves the controller process saw, resynced, and either
settled or escalated those runs. The tradeoff is one more evidence state between stale and current. I accept that
tradeoff because long-running stage work should not be invisible, but it must not be mistaken for a successful stage.

## Runtime Objective And Success Metrics

This contract improves control-plane reliability by separating active renewal from terminal freshness and by making
controller ingestion proof explicit.

Success means:

- A stale stage with an admitted, current, in-flight renewal run reports `renewing`, not simply `stale`.
- `renewing` permits read-only serving, Torghut observation, and bounded repair, but never deploy widening, merge-ready,
  paper canary, or live capital.
- Terminal AgentRun success is still required before a stage becomes `current`.
- Controller witness no longer depends on serving-process inference when the controller process can publish ingestion
  settlements.
- Normal dispatch only exits `repair_only` when controller ingestion and stage settlement agree.
- Deployer validation can prove the state with routes, AgentRun status, job status, and logs; it does not require pod
  exec, Secret reads, or direct database mutation.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps manifests, or AgentRun records.

### Cluster And Rollout Evidence

- The Agents namespace had `deployment/agents=1/1` and `deployment/agents-controllers=2/2` available.
- The active images were `jangar-control-plane:39c27b12@sha256:f87519...` for serving and
  `jangar:39c27b12@sha256:cdfdcb...` for controllers.
- Argo CD reported `agents`, `agents-ci`, `jangar`, `symphony-jangar`, `symphony-torghut`, `torghut`, and
  `torghut-options` Synced and Healthy; `root` remained OutOfSync but Healthy.
- Agents events included transient readiness probe timeouts on `agents` and `agents-controllers`, but current
  deployments were available.
- Hourly Jangar and Torghut schedule CRs were active for discover, plan, implement, and verify.
- Recent cron failures fail closed on stale schedule authority. For example,
  `job/jangar-control-plane-discover-sched-cron-29635445` failed with a stale schedule admission passport, while the
  next discover cron job `29635505` completed.

### Route And Database Evidence

- `/api/agents/control-plane/status?namespace=agents` generated evidence at `2026-05-07T05:09:20.714Z`.
- Database projection was healthy: connected, `12ms` latency, `28` registered migrations, `28` applied migrations,
  `0` unapplied, `0` unexpected, latest migration `20260505_torghut_quant_pipeline_health_window_index`.
- Watch reliability was healthy with `4565` total events, `0` errors, and `0` restarts.
- Runtime kits for serving and collaboration were healthy; `codex-nats-publish`, `codex-nats-soak`, `nats`, workspace
  path, and NATS URL were present.
- `/ready` returned `status=ok` while execution trust was degraded for Jangar plan, implement, verify and Torghut
  discover, implement, verify.
- Controller witness returned `decision=repair_only`, `reason_codes=["controller_witness_split"]`, and message:
  `controller deployment and watch epoch are current, but controller ingestion self-report is missing`.
- The ingestion witness carried `controller_ingestion_unknown` even though AgentRun watch events were current.

### AgentRun And Schedule Evidence

- `kubectl get agentruns -n agents` showed active Torghut discover, implement, and verify runs, plus recent completed
  stage runs across all Torghut lanes.
- `torghut-quant-plan-sched-sg2xt` succeeded in the current window, but Torghut execution trust still reported stale
  stages through `/ready`.
- Current schedule CRs were active:
  `jangar-control-plane-{discover,plan,implement,verify}-sched` and
  `torghut-quant-{discover,plan,implement,verify}-sched`.
- A current Jangar discover run had controller-generated ConfigMaps for inputs and step spec, proving the controller was
  creating step artifacts for active work.
- RBAC blocked pod exec and StatefulSet listing for the Agents service account. The design must keep validation on
  route and Kubernetes object projections.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is `3060` lines and owns schedules, runner
  ConfigMaps, CronJobs, requirements, freezes, and workspace state.
- `services/jangar/src/server/control-plane-status.ts` is `781` lines and assembles execution trust, dependency quorum,
  controller witness, action clocks, and material verdicts.
- `services/jangar/src/server/control-plane-runtime-admission.ts` is `504` lines and emits runtime kits, admission
  passports, and recovery warrants.
- `services/jangar/src/server/control-plane-workflows.ts` is `499` lines and already reads job outcomes and
  backoff-limit signals.
- `services/jangar/src/server/agents-controller/workflow-reconciler.ts` is `1190` lines and settles step lifecycle.
- Jangar has `159` colocated route/server/component tests. The right implementation shape is a small reducer plus
  targeted tests, not another branch-heavy path inside the schedule controller.

## Problem

Jangar currently collapses four different states into one stale signal.

The states are:

1. No recent run exists.
2. A renewal run exists and is still inside its expected execution window.
3. A renewal run exists but has exceeded its settlement window.
4. A renewal run completed and should either refresh or fail the stage.

Treating all non-terminal states as stale is safe but imprecise. It has three production costs:

- Operators cannot tell whether the repair action is to launch a stage, wait for a current stage to settle, or debug a
  stuck controller ingestion path.
- Action budgets see `execution_trust_degraded` even when active renewal work is running with current runtime kits.
- Torghut capital gates receive platform delay without knowing whether the platform is stale, renewing, or split.

The controller witness split is the same class of problem. Jangar can prove the controller deployment and watch epoch,
but it cannot prove controller-process ingestion unless the controller process publishes its own settlement. That keeps
normal dispatch in `repair_only` even when AgentRun objects show fresh activity.

## Alternatives Considered

### Option A: Increase Stage Freshness TTLs

Pros:

- Small configuration change.
- Reduces stale labels during long-running stages.
- Avoids new status fields.

Cons:

- Hides genuinely stuck stages.
- Lets old terminal successes mask current in-flight failures.
- Does not repair controller ingestion self-report.
- Gives Torghut no precise receipt for capital gates.

Decision: reject.

### Option B: Treat Running AgentRuns As Fresh Stage Success

Pros:

- Clears degraded execution trust quickly.
- Matches operator intuition that active work means the stage is alive.
- Minimal reducer change.

Cons:

- Confuses work in progress with completed proof.
- Can authorize deploy widening or capital while the renewal run later fails.
- Breaks the terminal-evidence safety property used by material action verdicts.

Decision: reject.

### Option C: In-Flight Stage Renewal Bonds With Controller Ingestion Settlement

Pros:

- Preserves terminal success as the only material clearance.
- Makes active renewal visible and bounded.
- Produces explicit timeout collateral when a renewal run misses settlement.
- Gives controller witness a process-owned ingestion proof instead of serving-process inference.
- Gives Torghut a first-class platform renewal receipt.

Cons:

- Adds new status concepts and a small reducer.
- Requires agreement on expected settlement windows by stage.
- Requires rollout discipline so consumers do not treat `renewing` as `current`.

Decision: select Option C.

## Architecture

Jangar emits a stage renewal bond for each admitted in-flight stage run.

```text
stage_renewal_bond
  bond_id
  namespace
  swarm_name
  stage
  schedule_ref
  agentrun_ref
  runtime_ref
  admission_passport_ref
  schedule_lease_receipt_ref
  issued_at
  expected_terminal_by
  fresh_until
  state                    # renewing, settled_success, settled_failure, expired, suppressed
  allowed_effects          # serve_readonly, dispatch_repair, torghut_observe
  blocked_effects          # dispatch_normal, deploy_widen, merge_ready, paper_canary, live_micro_canary
  reason_codes
```

The controller process publishes ingestion settlement:

```text
controller_ingestion_settlement
  settlement_id
  namespace
  controller_pod_uid
  controller_revision
  watch_epoch_ref
  resync_epoch_ref
  observed_run_count
  untouched_run_count
  active_renewal_bond_refs
  settled_run_refs
  generated_at
  fresh_until
  decision                  # current, split, stalled, unknown
  reason_codes
```

Stage trust becomes a reducer over terminal success, active renewal bonds, schedule lease receipts, workflow reliability,
and controller ingestion settlement.

```text
stage_trust
  stage
  state                     # current, renewing, repair_only, stale, blocked
  last_terminal_success_ref
  active_renewal_bond_ref
  controller_ingestion_settlement_ref
  material_action_effects
  fresh_until
```

### Action Semantics

- `current`: terminal success is fresh and controller ingestion settlement is current.
- `renewing`: an admitted run is active and not past `expected_terminal_by`; allow observe and bounded repair only.
- `repair_only`: terminal proof is stale or ingestion is split, but runtime kits and watches are healthy.
- `stale`: no active renewal and no fresh terminal success.
- `blocked`: runtime admission, lease rehydration, controller ingestion, or workflow reliability cannot prove safe
  repair.

### Material Action Effects

- `serve_readonly`: allowed for `current`, `renewing`, and `repair_only` when serving health is OK.
- `dispatch_repair`: allowed for `current`, `renewing`, and `repair_only` with strict runtime and duration caps.
- `dispatch_normal`: requires every required stage to be `current`.
- `deploy_widen` and `merge_ready`: require every required stage to be `current` and controller ingestion `current`.
- `paper_canary` and `live_micro_canary`: require Jangar stage trust `current` plus Torghut proof-floor clearance.

## Implementation Scope

Engineer stage should implement the minimum production slice:

- Add a stage renewal bond reducer that reads active AgentRuns, schedule lease receipts, runtime refs, and terminal
  outcomes.
- Add a controller-process ingestion settlement emitted by `agents-controllers`, including watch epoch, resync epoch,
  active renewal bonds, settled runs, and untouched run count.
- Expose `stage_renewal_bonds`, `controller_ingestion_settlement`, and reduced `stage_trust` in
  `/api/agents/control-plane/status`.
- Update dependency quorum and material action verdicts so `renewing` keeps observe and repair open but does not clear
  material actions.
- Add tests for active renewal, expired renewal, terminal success, controller ingestion split, and Torghut consumer
  projection.

Out of scope for the first implementation:

- New AgentRun CRDs.
- Direct database or Secret reads by deployer tooling.
- Granting pod exec or broader cluster RBAC.
- Allowing paper or live capital from `renewing` state.

## Validation Gates

Local validation:

- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-controller-witness.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/supporting-primitives-controller.test.ts`
- `bun run --filter @proompteng/jangar lint`
- `bun run --filter @proompteng/jangar tsc`

Cluster validation after deploy:

- `curl -sS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents | jq '.stage_trust,.stage_renewal_bonds,.controller_ingestion_settlement'`
- Start or wait for one scheduled renewal run and confirm its stage reports `renewing` before terminal success.
- Confirm `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, and `live_micro_canary` do not become
  allowed from `renewing`.
- Confirm the same stage reports `current` only after terminal success and fresh controller ingestion settlement.
- Confirm a renewal run past `expected_terminal_by` becomes `expired` and requires repair.

## Rollout Plan

1. Ship status-only renewal bonds and ingestion settlements.
2. Compare projected `stage_trust` with existing execution trust for two schedule windows.
3. Let material action verdicts read `stage_trust` in shadow mode.
4. Make deploy verification require current controller ingestion settlement before widening.
5. Let Torghut consume `renewing` as observe/repair only and `current` as a prerequisite for paper.

## Rollback Plan

- Stop consumers from reading `stage_renewal_bonds` and `stage_trust`.
- Keep schedule lease rehydration and existing terminal execution trust intact.
- Treat missing controller ingestion settlement as the current `controller_witness_split` behavior.
- Keep Torghut paper and live capital held if Jangar stage trust is absent or unavailable.

## Risks And Mitigations

- **Over-trusting in-flight work:** never let `renewing` clear material action gates.
- **False expiration:** make expected terminal windows stage-specific and visible in the bond.
- **Controller-process publishing failure:** fall back to `controller_witness_split` and bounded repair only.
- **Status payload growth:** cap retained bonds to active and recent terminal windows.
- **Operator confusion:** publish one reduced `stage_trust` row per stage with explicit action effects.

## Handoff To Engineer

Build the reducer and status projection first. Do not change schedule launch semantics until the projection matches
observed AgentRuns for at least two windows. The important safety property is that `renewing` is visible but not
materially trusted.

## Handoff To Deployer

Treat this as a trust-state rollout. It should improve diagnosis before it changes behavior. Hold deploy widening if
controller ingestion settlement is missing, if any active renewal bond has expired, or if a required stage is not
`current`. Torghut may observe and run zero-notional repair under `renewing`, but paper and live remain held.
