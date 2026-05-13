# 187. Jangar Stage Credit Ledger And Runner Slot Futures (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane resilience, scheduled AgentRun admission, retained failure debt, runner-slot economics,
Torghut repair value, rollout truth, validation, rollback, and handoff gates.

Extends:

- `docs/agents/designs/185-jangar-clearance-market-and-rollout-truth-settlement-2026-05-12.md`
- `docs/agents/designs/184-jangar-stage-clearance-packets-and-freeze-aware-launch-governor-2026-05-12.md`
- `docs/agents/designs/183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md`
- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`
- `services/jangar/README.md`

Companion Torghut contract:

- `docs/torghut/design-system/v6/189-torghut-repair-yield-market-and-profit-hypothesis-guardrails-2026-05-12.md`

## Decision

I am selecting a **stage credit ledger with runner slot futures** as the next Jangar architecture increment.

The control plane has become good at describing why an action is unsafe. It is still weaker at deciding whether a
scheduled stage deserves the next scarce runner slot. On the 2026-05-13 evidence pass, Argo showed `jangar` and
`agents` as Synced and Healthy, the `jangar-control-plane` swarm was Active and Ready, and the Jangar database was
healthy with 29 registered and applied migrations. At the same time, the live clearance-market status held
`discover`, `plan`, `implement`, `verify`, `deploy_widen`, and `merge_ready` on controller witness, AgentRun ingestion,
source-rollout truth, and Torghut empirical debt while runtime admission still reported launch-capable stage passports
as allowed.

That split is the next reliability problem. A stage can be fresh enough to schedule while too expensive to run. The
system needs an admission account that prices the stage against retained failure debt, rollout proof, repair value, and
capacity risk before the scheduler spends another runner slot.

The selected design adds a `stage_credit_ledger` to the control-plane status payload. It does not introduce money,
external markets, or speculative execution. It is an internal accounting contract that tells the scheduler how much
credit each stage has, what debt taxes it paid, which repair lot can earn credit, how many concurrent launches are
allowed, and how credit is refunded or burned after the run settles. The same object gives deployers an audit trail for
why a green PR was held, why a repair was admitted, or why a repeated launch was blocked.

The tradeoff is that some stages that look operationally healthy will be throttled. I accept that because the business
metric is to reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout time. Spending one more runner slot
on a held stage makes that metric worse unless the launch has a bounded repair receipt and a credible refund path.

## Governing Runtime Requirements

This design binds to the current swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Every milestone maps to at least one value gate:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-13. I did not mutate Kubernetes resources, database rows,
GitOps resources, AgentRuns, broker state, Torghut flags, or trading data.

### Cluster And Rollout Evidence

- Runtime scope resolved to repository `proompteng/lab`, base `main`, head
  `codex/swarm-jangar-control-plane-discover`, stage `discover`, owner channel `swarm://owner/platform`, live
  communication channel `general`, mission ledger `/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md`,
  and business metric "reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout time for the Jangar
  control plane".
- The working tree was clean on `codex/swarm-jangar-control-plane-discover`, aligned with `origin/main` at
  `4dfa7c70771f3f8d6f3884c52a77c41e5e851638` before this artifact was authored.
- The last 20 PRs from this reused head branch were already merged; the newest was PR `#6247`,
  `docs(jangar): define clearance market architecture`, merged on 2026-05-12.
- Argo CD reported `agents=Synced/Healthy`, `jangar=Synced/Healthy`, `torghut=Synced/Degraded`, and
  `torghut-options=Synced/Healthy`, all at revision `4dfa7c70771f3f8d6f3884c52a77c41e5e851638`.
- Jangar namespace pods were Running. `deployment/jangar` was `1/1`, `deployment/agents` was `1/1`, and
  `deployment/agents-controllers` was `2/2`. Recent events still included readiness probe failures during the rollout
  window, which is acceptable only when rollout truth records the settled state and latency.
- The service account could read pods, deployments, services, events, secrets, Swarms, and AgentRuns. It could not list
  `statefulsets.apps` in `jangar`, could not list CNPG `clusters.postgresql.cnpg.io`, and could not exec into
  `pod/jangar-db-1`. Those denials are useful proof: direct database internals are not the normal stage-admission
  evidence path for this worker.
- `kubectl get swarm jangar-control-plane -n agents -o yaml` showed `phase=Active`, `Ready=True`, `Frozen=False`,
  no queued requirements, zero consecutive failures, and 24-hour autonomous success rate `0.9474`. Its stage runtime
  admission still reported `decision=allow` for launch-capable stages through sealed recovery warrants.
- The Jangar status endpoint simultaneously reported clearance-market stage admission `hold` for `discover`, `plan`,
  `implement`, `verify`, `deploy_widen`, and `merge_ready`; `repair_only` for `repair`; `allow` for `serve_readonly`
  and `torghut_observe`; and `block` for Torghut live capital.
- Retained AgentRun CRs in `agents` showed `jangar-control-plane`: 276 Succeeded, 50 Failed, and 3 Running. The same
  source showed `torghut-quant`: 259 Succeeded, 42 Failed, and 3 Running.
- Agents namespace events included recent `BackoffLimitExceeded` for a Torghut verify attempt, completed schedule-runner
  CronJobs, and active Jangar/Torghut runner pods. The recent 15-minute clearance debt was clear, but the six-hour
  repair schedule debt remained active with one failed/backoff attempt.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` assembles the control-plane truth surface and is 798 lines.
- `services/jangar/src/server/control-plane-stage-clearance.ts` is 563 lines and already projects stage-clearance
  packets from execution trust, controller witness, source-rollout truth, route stability, material verdicts,
  failure-domain leases, Torghut evidence, and dependency verdicts.
- `services/jangar/src/server/control-plane-clearance-market.ts` is 552 lines and already ranks repair lots, retained
  failure debt, authority splits, rollout truth settlement, action clearance, and stage admission.
- `services/jangar/src/server/supporting-primitives-controller.ts` is 3,351 lines and owns the risky scheduler
  integration boundary. The next implementation must add a small pure reducer and a narrow call site, not another
  inline scheduler branch.
- `services/jangar/src/server/agents-controller/agent-run-reconciler.ts` is 1,190 lines and owns AgentRun lifecycle
  settlement. It is the right settlement consumer for credit refunds and burns after a run finishes.
- Existing tests cover control-plane status, failure-domain leases, stage clearance, clearance market projection,
  controller witnesses, watch reliability, runtime admission, and Torghut consumer evidence. The missing test family is
  economic admission: a held stage must have zero spendable credit, a selected repair lot must have bounded credit, and
  a later successful repair must refund or unlock the normal stage account.

### Database And Data Evidence

- Local `psql` was unavailable. I connected read-only with the Bun Postgres client using the `jangar-db-app` Kubernetes
  secret and did not print secret values.
- Jangar Postgres connected as database `jangar`, user `jangar`, server address `10.244.3.115`.
- `kysely_migration` had 29 applied migrations; latest applied and latest registered were both
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Non-system schemas included `agents_control_plane` with 2 tables, `atlas` with 16, `codex_judge` with 4,
  `jangar_github` with 9, `memories` with 1, `public` with 54, `terminals` with 1, `torghut_control_plane` with 11,
  and `workflow_comms` with 1.
- Largest Jangar-side tables included `torghut_control_plane.quant_metrics_series` with about 1,483,524 estimated rows,
  `torghut_control_plane.quant_pipeline_health` with about 123,528, `workflow_comms.agent_messages` with about 25,202,
  and `jangar_github.events` with about 7,381.
- `agents_control_plane.resources_current` has `last_seen_at`, `status_phase`, runtime, source, and update columns
  suitable for retained failure-debt projection. It does not currently expose a spend/refund account for admission.
- `workflow_comms.agent_messages`, `memories.entries`, and `torghut_control_plane.quant_metrics_latest` have freshness
  columns that can support credit inputs, but the ledger must treat these as evidence refs, not as independent launch
  authority.
- `/api/agents/control-plane/status?namespace=agents` reported `database.connected=true`, `database.status=healthy`,
  migration consistency `29/29`, and a database lease allowing `dispatch_normal`, `deploy_widen`, `merge_ready`, and
  `torghut_capital`.
- The same status reported `agentrun_ingestion.status=unknown` with message `agents controller not started`,
  `dispatch_normal=hold`, `deploy_widen=hold`, `merge_ready=hold`, `paper_canary=hold`,
  `live_micro_canary=block`, and `live_scale=block`.

## Problem

The current Jangar control plane has multiple true statements that do not produce one launch decision:

1. The deployment can be healthy while retained failure debt remains active.
2. A runtime passport can be allowed while clearance-market stage admission is held.
3. The database can be healthy while controller witness or AgentRun ingestion is not current.
4. Torghut observe evidence can be current while capital and paper canaries are unsafe.
5. A repair lot can be valuable while normal dispatch remains too expensive.
6. A green PR can pass CI before rollout truth, route health, downstream evidence, and failure debt settlement prove it
   is safe to widen.

That produces the failure mode I want to remove: schedules can continue to spend runner slots in states where the
control plane already knows the stage should not launch normally. Retrying the same held stage increases failed
AgentRun rate, hides the smallest repair, and makes PR-to-rollout latency noisy because the proof window now contains
avoidable failures.

The system needs one additional abstraction: spendable stage credit. A stage can launch when it has current evidence,
positive expected repair value, and enough credit after debt taxes. A stage cannot launch when the ledger says the
credit account is empty, expired, or reserved for a different repair class.

## Alternatives Considered

### Option A: Enforce Clearance-Market Stage Admission As-Is

The simplest path is to make `clearance_market_ledger.stage_admission` the sole scheduler gate. A `hold` or `block`
decision deletes schedule resources and fire-time runners fail closed.

Advantages:

- Small implementation delta.
- Uses existing payload and tests.
- Directly reduces some failed launches.

Disadvantages:

- It cannot distinguish one cheap repair from ten expensive retries.
- It does not quantify how retained failure debt reduces future launch allowance.
- It does not define refunds after successful repair or burns after repeated failure.
- It can over-hold high-value zero-notional repairs that should run once.

Decision: use as an input and fallback, not the full architecture.

### Option B: Add Static Per-Stage Rate Limits

Another path is fixed budgets: one discover per four hours, one implement per hour, one verify per hour, plus lower
limits when a stage has recent failures.

Advantages:

- Easy to explain.
- Limits runaway schedules quickly.
- Low data modeling cost.

Disadvantages:

- Treats all stages in the same time bucket as equal value.
- Does not understand rollout truth, Torghut repair value, or controller witness splits.
- Can waste the only allowed launch on a low-value run while the high-value repair waits.
- Does not improve handoff evidence quality because operators still must infer why a launch was worth spending.

Decision: reject as the main design. Static caps can remain a safety guard below the credit ledger.

### Option C: Stage Credit Ledger With Runner Slot Futures

The selected option emits a stage-account ledger. Each stage receives base credit only when its governing evidence is
fresh. Retained failure debt, controller witness debt, rollout ambiguity, source truth holds, and Torghut capital debt
tax that credit. A selected repair lot can add bounded repair credit when it names the value gate it buys down and the
maximum dispatch/runtime/notional budget. A runner slot future reserves one launch opportunity; the lifecycle
controller later refunds, burns, or converts that credit based on the run outcome and evidence receipts.

Advantages:

- Turns "allowed but held" authority splits into one spendable account.
- Reduces failed AgentRuns by making repeated failures consume future launch credit.
- Allows one bounded repair when it has value and guardrails.
- Produces a deployer receipt for why merge-ready or deploy widening was withheld.
- Lets Torghut profitability improvements compete on measurable repair value without granting capital authority.

Disadvantages:

- Adds a new reducer and status payload.
- Requires stable reason codes and clear TTLs.
- Requires lifecycle settlement work after the read model ships.

Decision: select Option C.

## Architecture

Jangar emits one `stage_credit_ledger` per control-plane status generation.

```text
stage_credit_ledger
  schema_version = jangar.stage-credit-ledger.v1
  ledger_id
  namespace
  generated_at
  fresh_until
  governing_design_refs[]
  observed_revision
  evidence_mode                # observe | shadow | hold | enforce
  credit_epoch_id
  stage_accounts[]
  runner_slot_futures[]
  retained_failure_debt_refs[]
  settlement_policy
  handoff_contract
```

Each `stage_account` is keyed by `stage` and `action_class`:

```text
stage_account
  account_id
  stage                         # serve | discover | plan | implement | verify | repair | deployer | torghut
  action_class                  # dispatch_normal | dispatch_repair | deploy_widen | merge_ready | ...
  opening_credit
  base_credit
  evidence_freshness_bonus
  torghut_repair_value_credit
  rollout_truth_deposit
  failure_debt_tax
  controller_witness_tax
  source_rollout_tax
  capital_safety_tax
  available_credit
  minimum_spend
  max_concurrent_runs
  max_runtime_seconds
  max_notional
  decision                      # allow | repair_only | hold | block
  reason_codes[]
  required_repair_actions[]
  evidence_refs[]
  selected_repair_lot_ref
  rollback_target
```

Credit is intentionally dimensionless. It is not money and does not leave the control plane. It answers one question:
is this stage allowed to spend the next runner slot?

The first implementation should use conservative constants:

- `serve_readonly`: base credit 100, minimum spend 0, no runner slot required.
- `torghut_observe`: base credit 80, minimum spend 0, zero notional only.
- `dispatch_repair`: base credit 40, minimum spend 25, one concurrent run, zero notional.
- `dispatch_normal`: base credit 50, minimum spend 50, no launch if any material action hold applies.
- `deploy_widen` and `merge_ready`: base credit 60, minimum spend 60, require rollout truth settlement allow.
- `paper_canary`: base credit 50, minimum spend 75, zero live notional and current paper settlement.
- `live_micro_canary` and `live_scale`: base credit 0 until Torghut closes capital blockers.

Taxes are additive and capped at 100:

- each active 15-minute workflow failure debt: 40;
- six-hour repair schedule debt active: 25;
- seven-day projection limited: 10 until retained historical debt is available;
- AgentRun ingestion not current: 40;
- controller witness split or repair-only: 35;
- source-rollout truth hold: 35;
- deployer rollout truth hold: 50;
- Torghut zero-notional capital state: 100 for live capital, 50 for paper canary, 0 for observe;
- stale empirical, forecast, market-context, or proof-floor evidence: 25 each for capital and normal dispatch.

Bonuses are also capped and must cite evidence:

- fresh route and database leases: up to 10;
- fresh controller witness and AgentRun ingestion: up to 20;
- selected repair lot with positive expected unblock value: up to 30, repair-only;
- Torghut repair value naming a value gate: up to 20, zero-notional;
- rollout truth settlement allow: up to 30 for deployer and merge-ready stages.

The account decision follows credit and safety:

- `allow` when `available_credit >= minimum_spend` and no blocker is classified as non-waivable.
- `repair_only` when normal action is held but a selected repair lot has bounded credit and zero notional.
- `hold` when credit is below spend or evidence is stale but repair is possible.
- `block` when live capital, source rollout, route, or safety evidence is contradicted.

## Runner Slot Futures

A runner slot future is a reservation, not a queued Kubernetes object.

```text
runner_slot_future
  future_id
  account_id
  stage
  action_class
  reserved_credit
  expires_at
  max_dispatches
  max_runtime_seconds
  max_notional
  spend_reason
  required_receipts[]
  settlement_state              # open | refunded | burned | converted
  settlement_ref
```

The scheduler may create an AgentRun only if it can cite a current future. The launch stamps:

- `swarmStageCreditLedgerId`
- `swarmStageCreditAccountId`
- `swarmRunnerSlotFutureId`
- `swarmStageCreditDecision`
- `swarmCreditSelectedRepairLotRef`

The lifecycle controller settles the future:

- **Refunded** when the run succeeds and emits required receipts.
- **Burned** when the run fails for a stage-owned reason or reaches backoff without superseding success.
- **Converted** when the run fixes a repair lot and unlocks normal stage credit.
- **Expired** when the future is unused past TTL.

Infrastructure failures should not punish the stage indefinitely. If the failure is classified as platform-owned by
provider capacity, image pull, node disruption, or storage conflict evidence, the future burns against the infrastructure
account and leaves the stage account eligible for one repair retry after the corresponding failure-domain lease turns
valid.

## Implementation Scope

The first bounded implementation milestone is a read-model PR:

- Add `StageCreditLedger`, `StageCreditAccount`, and `RunnerSlotFuture` types to
  `services/jangar/src/data/agents-control-plane.ts`.
- Add `services/jangar/src/server/control-plane-stage-credit-ledger.ts` as a pure reducer consuming database status,
  workflow reliability, AgentRun ingestion, controller witness, source-rollout truth, stage-clearance packets,
  clearance-market ledger, rollout health, failure-domain leases, and Torghut consumer evidence.
- Add the ledger to `services/jangar/src/server/control-plane-status.ts` and the API payload while keeping
  `evidence_mode=observe`.
- Add targeted tests in `services/jangar/src/server/__tests__/control-plane-stage-credit-ledger.test.ts` and extend the
  status test so held normal stages have zero spendable credit and repair-only stages expose one bounded future.
- Update the UI only if the existing control-plane status component cannot display the new payload without breaking.

The second milestone is scheduler shadow stamping:

- In `services/jangar/src/server/supporting-primitives-controller.ts`, read the current ledger at schedule reconciliation
  and stamp `swarmStageCredit*` fields on launches that are already admitted by the existing clearance market.
- Fire-time schedule runners verify the stamped future is still current before creating an AgentRun.
- Enforcement remains `shadow` until deployer evidence proves every launched scheduled run carries a ledger id, account
  id, future id, and stage decision.

The third milestone is settlement:

- In `services/jangar/src/server/agents-controller/agent-run-reconciler.ts`, classify terminal runs as refunded,
  burned, converted, or infrastructure-owned.
- Add a small persisted settlement table only when the shadow reducer proves the in-memory status model is useful. The
  initial reducer can compute from current AgentRun resources and avoid a migration.

Read-model implementation binding:

- `services/jangar/src/server/control-plane-stage-credit-ledger.ts` is the first implementation owner for this design.
- `JANGAR_STAGE_CREDIT_LEDGER_ENABLED=false` removes the payload; otherwise the read model is emitted by default.
- `JANGAR_STAGE_CREDIT_LEDGER_MODE` accepts `observe`, `shadow`, `hold`, or `enforce`; unset values resolve to
  `observe`.
- The read model consumes the existing clearance-market ledger and stage-clearance packets. It does not create,
  delete, or mutate schedules, AgentRuns, Kubernetes resources, database rows, or Torghut orders.
- Scheduler shadow stamping remains the next bounded implementation milestone and must cite this document plus the
  emitted `stage_credit_ledger.handoff_contract.next_implementation_milestone`.

## Validation Gates

Engineer stage acceptance:

- Unit tests prove `dispatch_normal` has `available_credit=0` when clearance-market stage admission is `hold`.
- Unit tests prove `dispatch_repair` can receive one bounded future when a selected repair lot names
  `failed_agentrun_rate`, `ready_status_truth`, or `pr_to_rollout_latency`.
- Unit tests prove Torghut `live_micro_canary` and `live_scale` remain `block` when max notional is zero or capital
  evidence is stale.
- Status payload includes `stage_credit_ledger.governing_design_refs` with this document.
- Oxfmt, Jangar type-check, and targeted Jangar tests pass.

Deployer stage acceptance:

- `/api/agents/control-plane/status?namespace=agents` returns a fresh `stage_credit_ledger` with `fresh_until` no later
  than the current evidence window.
- Argo applications `jangar` and `agents` are Synced and Healthy after rollout.
- Workload readiness shows `deployment/jangar=1/1`, `deployment/agents=1/1`, and `deployment/agents-controllers=2/2`.
- The deployer records whether `pr_to_rollout_latency_seconds` is measured or still `null`; a null value is acceptable
  only while rollout truth settlement lacks PR merge timestamp wiring.
- No scheduled `discover`, `plan`, `implement`, or `verify` launch is counted as green rollout proof unless it carries
  stage credit fields in addition to stage-clearance and clearance-market fields.

Value-gate mapping:

- `failed_agentrun_rate`: failure debt taxes and burned futures reduce repeated launches.
- `pr_to_rollout_latency`: rollout truth deposit and deployer account block premature widening.
- `ready_status_truth`: controller witness, AgentRun ingestion, database, and source truth taxes drive the decision.
- `manual_intervention_count`: selected repair lots tell the operator the smallest admitted repair.
- `handoff_evidence_quality`: every launch and settlement cites ledger, account, future, repair lot, and design refs.

## Rollout

Phase 0, observe:

- Ship the reducer and status payload behind `JANGAR_STAGE_CREDIT_LEDGER_ENABLED=true`.
- Default `JANGAR_STAGE_CREDIT_LEDGER_MODE=observe`.
- Do not alter scheduler behavior.
- Compare ledger decisions with existing stage-clearance and clearance-market decisions for at least one full cadence
  of discover, plan, implement, and verify.

Phase 1, shadow:

- Stamp ledger/account/future ids on admitted launches.
- Do not delete schedules solely because of stage credit yet.
- Deployer verifies every normal scheduled launch has stage-clearance, clearance-market, and stage-credit fields.

Phase 2, hold:

- Let stage credit hold normal scheduled launches when `available_credit < minimum_spend` or a non-waivable safety
  blocker exists.
- Keep `serve_readonly`, `torghut_observe`, and one bounded `dispatch_repair` path available.
- Record burn/refund counts in status and NATS handoff updates.

Phase 3, enforce:

- Require a current runner slot future for every scheduled AgentRun launch.
- Block live capital and deploy widening if the corresponding account is not `allow`.
- Treat missing credit stamps as failed rollout evidence.

## Rollback

Rollback is runtime-local and must preserve evidence:

- Set `JANGAR_STAGE_CREDIT_LEDGER_MODE=observe` to stop scheduler holds while keeping the payload visible.
- Set `JANGAR_STAGE_CREDIT_LEDGER_ENABLED=false` to remove the payload from new status responses.
- Keep existing stage-clearance, clearance-market, runtime-admission, failure-domain lease, and material-action gates
  enabled.
- If a migration is introduced in a later settlement milestone, rollback should first disable settlement writes and then
  revert code. The initial milestone should avoid schema changes.
- A rollback handoff must include the latest `ledger_id`, blocked account ids, future ids if any, and the reason code
  that forced rollback.

## Risks

- The ledger can look more precise than its inputs. The payload must carry `data_confidence`, `fresh_until`, and
  `evidence_refs` so operators know when it is a projection.
- Static credit constants can encode the wrong economics. The first phase should log decisions and compare them against
  actual run outcomes before enforcement.
- The scheduler integration point is large and high risk. Keep the first implementation pure and separately tested.
- If Torghut evidence stays degraded, credit will mostly hold capital and normal dispatch. That is correct, but it means
  repair-only paths must stay ergonomic.
- If every failure burns stage credit, infrastructure faults could starve useful work. The settlement classifier must
  separate stage-owned failures from platform-owned failures before hold mode.

## Handoff

Engineer:

- Implement the read-model milestone first.
- Do not change schedule deletion behavior in the first PR.
- The regression to prevent is a status payload that says normal stage admission is held while the new ledger still
  gives that stage enough spendable credit to launch.
- Required local checks: `bunx oxfmt --check docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md docs/agents/runbooks.md`,
  `bun run --filter @proompteng/jangar tsc`, and the targeted Jangar tests for status and stage credit.

Deployer:

- After the read model rolls out, verify Argo, workloads, `/ready`, and
  `/api/agents/control-plane/status?namespace=agents`.
- Treat a missing `stage_credit_ledger` as a rollout evidence gap, not a service outage, during observe mode.
- Do not call a PR green-to-healthy if normal stage launches are being created without stage-clearance,
  clearance-market, and stage-credit stamps once shadow stamping is enabled.

This design improves `failed_agentrun_rate` by making repeated failures consume future launch credit, improves
`pr_to_rollout_latency` by requiring a rollout truth deposit before deploy widening, improves `ready_status_truth` by
collapsing runtime-passport and clearance-market splits into one spendable account, reduces `manual_intervention_count`
by naming the smallest repair lot, and improves `handoff_evidence_quality` by giving every launch a ledger/account/future
chain to cite.
