# 180. Jangar Execution-Trust Debt Retirement And Profit-Repair Settlement (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Gideon Park, Torghut Traders Architecture Lead
Scope: Jangar control-plane resilience, execution-trust recovery, Torghut quant repair admission, safer rollout
behavior, NATS/Jangar visibility, and capital-action custody.

Companion Torghut contract:

- `docs/torghut/design-system/v6/184-torghut-execution-trusted-profit-repair-settlement-2026-05-08.md`

Extends:

- `179-jangar-controller-witness-reconciliation-and-failure-debt-retirement-2026-05-08.md`
- `179-jangar-controller-witness-stability-escrow-and-capital-reentry-backpressure-2026-05-08.md`
- `179-jangar-session-evidence-auction-and-route-canary-notary-2026-05-08.md`
- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`

## Decision

I am selecting **execution-trust debt retirement with profit-repair settlement admission** as Jangar's next
control-plane architecture step for Torghut quant.

The current cluster is not in the May 5 brownout, but it is not clean enough to call material action ready. At
`2026-05-08T12:15Z`, Argo CD reported `jangar`, `torghut`, `torghut-options`, `symphony-jangar`, and
`symphony-torghut` `Synced` and `Healthy` at `e87e3d87d3b8313f408704e2fa9317bb5a679c8e`. Jangar, Agents, and Torghut
deployments were available. Jangar `/health` returned `status=ok`, and `/ready` returned `status=ok`.

The top-line green state hides the important trust debt. Jangar `/ready` still reported `execution_trust.status` as
`degraded` because both the `jangar-control-plane` and `torghut-quant` swarms were frozen by stage staleness across
discover, plan, implement, and verify. The control-plane status route showed watch reliability `healthy`, but material
actions still held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` on stale controller
witnesses, controller heartbeat not current, and execution-trust degradation. `paper_canary` was held and
`live_micro_canary`/`live_scale` were blocked, which is correct while Torghut is zero-notional.

Torghut's evidence route is now current, so Jangar should stop treating route availability as the main blocker. The
active blocker is that Jangar cannot distinguish productive zero-notional profit repair from normal dispatch while
execution trust is degraded. The selected design adds an execution-trust debt retirement ledger and makes Torghut
profit-repair admission a settled action class. Jangar can admit bounded repair that burns down named Torghut value
gates, but it must hold normal dispatch, deploy widening, merge-ready claims, paper canary, and live action until
execution-trust debt is retired.

The tradeoff is slower throughput after a transient recovery. I accept that. The current risk is not lack of work. The
risk is that the control plane launches or certifies work while its own stage staleness says the swarm cannot prove the
run sequence that led to the action.

## Current Evidence

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, trading flags, AgentRun
objects, or GitOps manifests.

### Cluster And Rollout

- `kubectl config current-context` was unset, but namespace-scoped reads authenticated as
  `system:serviceaccount:agents:agents-sa`.
- Argo CD reported `jangar`, `torghut`, `torghut-options`, `symphony-jangar`, and `symphony-torghut` `Synced` /
  `Healthy`, operation `Succeeded`, revision `e87e3d87d3b8313f408704e2fa9317bb5a679c8e`.
- Jangar namespace pods were running, including `jangar-58df468dc-xj25q`, `jangar-db-1`, Redis, OpenWebUI, Bumba,
  Symphony, and Symphony Jangar.
- Recent Jangar events showed multiple app restarts and readiness failures during rollout before the current ready pod
  settled. That is a cleared rollout symptom, not a reason to widen action authority by itself.
- Agents deployments were available: `agents=1/1` and `agents-controllers=2/2`. The namespace still contained recent
  scheduled-run errors for Jangar control-plane and Torghut quant stages.
- Torghut namespace workloads were available on live revision `torghut-00307` and sim revision `torghut-sim-00405`;
  recent events still showed ClickHouse multiple-PDB ambiguity and a transient `torghut-db-1` readiness 500.

### Jangar Status And Source Evidence

- Jangar `/ready` returned `status=ok` but `execution_trust.status=degraded`.
- The degradation reasons named swarm and stage staleness for both `jangar-control-plane` and `torghut-quant`.
- The control-plane status route showed watch reliability `healthy`.
- Material action verdicts held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready`; `serve_readonly`
  and `torghut_observe` were allowed; `paper_canary` was held; live action classes were blocked.
- `controller_witness_stability_escrow` was absent from the status payload, so deployer checks still rely on older
  witness/material-action projections.
- `services/jangar/src/server/control-plane-status.ts` is the status composition point.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains high risk at 3,325 lines because it owns
  schedule rendering, fire-time checks, launch command generation, and runtime admission.
- Existing tests cover material action verdicts, runtime admission, controller witness, route-stability escrow, and
  Torghut consumer evidence. The missing contract is execution-trust debt retirement tied to Torghut value-gate repair
  admission.

### Database And Data Evidence

- Direct CNPG `psql` through `kubectl cnpg` is forbidden for this service account in both `jangar` and `torghut`
  because `pods/exec` is denied.
- ClickHouse direct HTTP returned 401 without credentials.
- Bounded application status is therefore the deployer-readable database boundary for this pass.
- Torghut `/db-check` returned HTTP 200 with current and expected Alembic head `0030_evidence_epochs`.
- Jangar status reported the latest registered source schema ref
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.

## Problem

Jangar can tell that the cluster is serving, but it cannot yet retire execution-trust debt in a way that admits the
right Torghut repair and blocks the wrong material action.

The current failure modes are:

1. Top-line readiness is green while execution trust is degraded by swarm stage staleness.
2. Material action verdicts correctly hold action, but they do not define a bounded repair settlement for Torghut's
   current profit blockers.
3. Scheduled run errors and retained failed pods can consume operator attention even after later successful runs.
4. `torghut_observe` is allowed, but there is no compact admission object that says which zero-notional repair is
   allowed and which value gate it must improve.
5. Deployer checks can verify Argo and pods but cannot yet verify that execution-trust debt was retired before a
   merge-ready or deploy-widen claim.
6. Capital actions are blocked, but the reason set mixes Jangar trust debt with Torghut profit debt without a shared
   settlement contract.

## Alternatives Considered

### Option A: Treat Argo Healthy Plus Jangar `/ready=ok` As Sufficient

Advantages:

- Lowest engineering cost.
- Matches common deployer habits.
- Restores normal dispatch quickly after rollout.

Disadvantages:

- Ignores `execution_trust=degraded`.
- Lets a stage-stale swarm certify material action.
- Does not reduce failed-run debt or explain why Torghut can only observe.

Decision: reject. Argo health is necessary, not sufficient, for material action.

### Option B: Freeze All Dispatch Until Execution Trust Is Fully Healthy

Advantages:

- Simple safety rule.
- Prevents launch fanout during degraded trust.
- Easy rollback behavior.

Disadvantages:

- Blocks the zero-notional repair work needed to clear Torghut profit debt.
- Treats bounded repair and deploy widening as the same risk.
- Increases manual intervention because every stale stage becomes a global stop.

Decision: reject as the default. Keep it as an emergency mode for active controller failure.

### Option C: Execution-Trust Debt Retirement With Profit-Repair Settlement Admission

Advantages:

- Separates read-only serving, zero-notional repair, normal dispatch, deploy widening, merge readiness, paper canary,
  and live action.
- Lets Jangar admit Torghut work only when it maps to a named value gate and notional stays zero.
- Gives deployers a clear proof that stage staleness, retained failures, and controller witness gaps were retired or
  still holding action.
- Keeps paper/live capital blocked until Torghut publishes settled profit evidence.

Disadvantages:

- Adds a reducer and status section.
- Requires careful debt matching so old failures are not hidden.
- Requires schedule-runner enforcement after an observe-mode period.

Decision: select Option C.

## Architecture

Jangar adds an `execution_trust_debt_retirement` projection:

```text
execution_trust_debt_retirement
  schema_version
  ledger_id
  generated_at
  fresh_until
  namespace
  gitops_revision
  execution_trust_ref
  controller_witness_ref
  watch_reliability_ref
  stage_debt_lots[]
  retained_failure_debt
  retired_failure_debt
  action_clearance[]
  rollback_target
```

Each `stage_debt_lot` is explicit:

```text
stage_debt_lot
  debt_id
  swarm_name
  stage
  debt_class                 # stage_staleness | retained_failure | missing_witness | active_failure
  current_state              # clear | watch | repair | hold | block
  latest_success_ref
  latest_failure_ref
  required_repair_action
  retirement_condition
  value_gate_refs
```

Jangar also adds a `profit_repair_settlement_admission` action class:

```text
profit_repair_settlement_admission
  admission_id
  generated_at
  torghut_receipt_ref
  torghut_profit_repair_ledger_ref
  execution_trust_debt_ref
  allowed_repair_lots[]
  rejected_repair_lots[]
  max_dispatches
  max_runtime_seconds
  max_notional
  decision
  reason_codes
```

Rules:

- `serve_readonly` may allow when route and database probes are current.
- `torghut_observe` may allow when max notional is zero and the work cites a Torghut design requirement.
- `profit_repair_settlement` may allow only bounded work whose repair lot maps to one of:
  `post_cost_daily_net_pnl`, `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`,
  `fill_tca_or_slippage_quality`, or `capital_gate_safety`.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require execution-trust debt `clear` or an explicit maintainer
  waiver recorded in the ledger.
- `paper_canary` requires Torghut profit repair settlement and Jangar execution-trust debt retirement.
- `live_micro_canary` and `live_scale` remain blocked until Torghut live capital gates clear independently.

## Failure-Mode Reduction

- A green pod rollout can no longer erase swarm stage staleness.
- Stale stage debt becomes a bounded repair item instead of a vague degraded status.
- Retained failed pods can be retired only when later same-lane success exists and the controller witness is current.
- Torghut repair dispatch is admitted by value-gate impact, not by newest failure.
- Paper and live action cannot inherit authority from read-only serving or observe-mode repair.

## Implementation Scope

Engineer stage should implement:

- A pure reducer for `execution_trust_debt_retirement`.
- An additive status projection in `/api/agents/control-plane/status?namespace=agents`.
- A shadow `profit_repair_settlement_admission` action class that consumes Torghut's companion ledger.
- Schedule-runner checks that hold `dispatch_normal`, `deploy_widen`, and `merge_ready` when the ledger is stale or
  holding.
- Tests for healthy trust, stage staleness, retained failure debt, missing controller witness, bounded Torghut repair,
  and blocked paper/live action.

Do not add more special-case scoring to `supporting-primitives-controller.ts`; keep the reducer pure and feed it into
that module after tests prove the policy.

## Validation Gates

- `capital_gate_safety`: all Torghut capital action classes carry `max_notional=0` while Torghut proof floor is
  `repair_only`.
- `zero_notional_or_stale_evidence_rate`: stale swarm stages and stale Torghut evidence are counted as debt lots until
  retired by fresh receipts.
- `routeable_candidate_count`: no route candidate is counted as paper-ready unless the Torghut repair settlement says
  the required receipts are present.
- `fill_tca_or_slippage_quality`: Jangar must not override Torghut route/TCA guardrails.
- `post_cost_daily_net_pnl`: Jangar may only claim revenue impact after Torghut publishes post-cost paper evidence.

Local checks:

- `bun run --filter @proompteng/jangar test -- control-plane-status`
- `bun run --filter @proompteng/jangar test -- control-plane-runtime-admission`
- `bunx oxfmt --check docs/agents/designs/180-jangar-execution-trust-debt-retirement-and-profit-repair-settlement-2026-05-08.md`

Cluster checks after rollout:

- Jangar status includes `execution_trust_debt_retirement`.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` hold while stage staleness is active.
- `profit_repair_settlement` can admit only zero-notional repair lots with value-gate refs.
- Two consecutive samples at least five minutes apart show debt retirement before deploy widening.

## Rollout

1. Ship the ledger in observe mode.
2. Compare ledger action decisions with existing material action verdicts for one full schedule window.
3. Enable schedule-runner enforcement for `dispatch_normal`, `deploy_widen`, and `merge_ready`.
4. Enable `profit_repair_settlement` admission for Torghut zero-notional repair.
5. Keep paper and live capital blocked until Torghut settlement gates clear separately.

## Rollback

- Disable schedule-runner enforcement and leave the ledger visible in observe mode.
- Revert to existing material action verdict behavior.
- Keep Torghut paper/live capital blocked during rollback.
- Use the normal GitOps image promotion or revert PR path; do not mutate production workloads from a local shell.

## Handoff

Engineer handoff: implement the pure ledger and shadow admission first. The smallest useful PR should prove that current
`execution_trust=degraded` from stage staleness holds normal dispatch and deploy widening while still allowing bounded
Torghut zero-notional repair with value-gate refs.

Deployer handoff: after rollout, verify Argo sync, Jangar status, ledger freshness, material action agreement, Torghut
consumer evidence current, and unchanged Torghut `max_notional=0`. The deployer must not call paper or live capital
ready until both the Jangar debt ledger and Torghut profit repair ledger clear their gates.
