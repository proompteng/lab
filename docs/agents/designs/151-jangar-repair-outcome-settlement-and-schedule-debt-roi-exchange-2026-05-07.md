# 151. Jangar Repair Outcome Settlement And Schedule Debt ROI Exchange (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders architecture
Scope: Jangar control-plane resilience, schedule debt accounting, repair outcome settlement, rollout gating,
Torghut proof-spend feedback, validation, rollback, and implementation handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/155-torghut-capital-repair-outcome-ledger-and-edge-reacquisition-gates-2026-05-07.md`

Extends:

- `150-jangar-controller-brownout-budgets-and-proof-spend-admission-exchange-2026-05-07.md`
- `149-jangar-wrapper-truth-settlement-and-useful-evidence-gates-2026-05-07.md`
- `147-jangar-hot-path-witness-cache-and-repair-settlement-cells-2026-05-07.md`

## Decision

I am selecting repair-outcome settlement as the next Jangar control-plane architecture step.

The brownout budget tells Jangar what work can run now. That is necessary, but it is not enough. The fresh evidence
shows Jangar serving, the Jangar database healthy, execution trust healthy, and watch reliability healthy at the status
endpoint, while the Agents namespace still carries recent probe failures, controller restarts, retained failed schedule
jobs, and live schedule attempts in progress. The scheduler recovered many hourly wrappers, but recovered activity is
not the same thing as useful repair.

Jangar needs to settle whether each admitted repair bought down control-plane or Torghut proof debt. A repair that
consumes a token and only produces another completed wrapper should not earn the same future priority as a repair that
reduces failed schedule debt, removes rollout ambiguity, restores a typed database witness, or lets Torghut advance a
proof-floor blocker. The selected design adds a `RepairOutcomeReceipt` exchange. The receipt binds admission token,
wrapper job, child job, source revision, database witness, consumer effect, and before/after debt delta.

The tradeoff is that we add one more reducer after admission. I accept that. Without outcome settlement, the brownout
budget can still reward noisy retries. With outcome settlement, Jangar can keep read-only serving stable, admit bounded
zero-notional repair, and learn which repair classes deserve scarce capacity during the next brownout.

## Runtime Objective And Success Metrics

Success means:

- Jangar publishes `repair_outcome_settlement` in `/api/agents/control-plane/status`.
- Every schedule-created repair that consumes an admission token produces a `RepairOutcomeReceipt`.
- Retained failed schedule jobs are separated from active failed attempts and later-successfully-settled repairs.
- Repair classes receive outcome grades: `closed`, `converted`, `no_effect`, `regressed`, `stale`, or `unknown`.
- Future repair tokens are ranked by observed closure per controller token, not only by requested priority.
- `serve_readonly` remains available when route and database witnesses are healthy.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` stay held when recent repairs regress or fail to settle.
- Torghut proof-spend repair receives more budget only when the companion Torghut outcome ledger reports blocker or
  edge improvement.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07 around 15:11Z. I did not mutate Kubernetes resources, database
records, broker state, GitOps resources, AgentRun objects, or Torghut trading flags.

### Cluster And Rollout Evidence

- `jangar` namespace deployments were available: `deployment/jangar`, `deployment/bumba`,
  `deployment/symphony`, and `deployment/symphony-jangar` were each `1/1`.
- The active Jangar pod was `2/2 Running` on image digest
  `sha256:a1882587e5dc97f38593be5bf6b5e387fee6a2089c0ef7b8de5f6b64c5b242b0`.
- Jangar events showed one replacement about 32 minutes before the probe and one transient readiness failure against
  `/health` during startup. The pod later settled.
- `agents` deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- The active `agents` pod had 2 recent restarts. The two controller pods had 3 and 1 recent restarts.
- Recent `agents` events showed readiness and liveness failures for the API and controller pods, including
  connection-refused, EOF, and timeout responses before the pods restarted.
- The hourly Jangar and Torghut swarm CronJobs recovered with recent successful wrapper jobs, but retained failed cron
  jobs from about 10 to 11 hours earlier remain in the namespace.
- Several live stage jobs were still running during the evidence pass, including Jangar discover, implement, verify,
  and Torghut discover and verify attempts.
- `torghut` active live and simulation Knative deployments were available at `1/1` on current digest
  `sha256:8db8a40ee7f76c08aaa0689b55e145dfaf872248707a20fb38c005e0eabb42ab`.
- Torghut events showed recent rollout churn, completed DB migration and backfill jobs, duplicate ClickHouse
  PodDisruptionBudget warnings, and Flink status-modified-externally warnings.

### Jangar Status And Data Evidence

- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok` and `execution_trust=healthy`.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status` generated at
  `2026-05-07T15:11:01.339Z` with `database=healthy`, `execution_trust=healthy`, `watch_reliability=healthy`,
  `watch_errors=0`, and `watch_restarts=1`.
- Direct CNPG SQL was RBAC-blocked for `jangar-db-1`: the service account cannot create `pods/exec` in `jangar`.
  Typed application health is therefore the normal database witness for this run, and direct-inspection access is a
  validation limitation that must be modeled separately.

### Torghut Consumer Evidence

- Live Torghut `/readyz` returned `status=degraded` while Postgres, ClickHouse, Alpaca, schema, Jangar universe,
  readiness cache, and empirical jobs were healthy.
- Live proof floor was `repair_only`, `capital_state=zero_notional`, and `max_notional=0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`,
  `market_context_stale`, and `simple_submit_disabled`.
- Execution TCA had `13,775` orders, `13,571` filled executions, average absolute slippage
  `13.7594875295276693` bps, and an `8` bps guardrail.
- Quant ingestion was degraded but informational for live readiness, with latest metrics updated at
  `2026-05-07T15:10:53.611Z` and maximum stage lag `77172` seconds.
- Simulation `/readyz` returned `status=ok`, but simulation proof floor also remained `repair_only` and
  `zero_notional`.
- Direct CNPG SQL was also RBAC-blocked for `torghut-db-1`; typed Torghut endpoints are the durable data witness
  available to this control-plane lane.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is 3301 lines and owns schedule reconciliation,
  swarm dispatch, workspace PVC reconciliation, and watch loops.
- `services/jangar/src/server/control-plane-status.ts` is 787 lines and composes database, watch, execution trust,
  Torghut, action clock, and runtime admission signals.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is 610 lines and is the right place to
  convert outcome receipts into action-class reason codes.
- `services/jangar/src/server/control-plane-action-clock.ts` is 276 lines and should consume settled outcome scores,
  not raw failed-pod counts.
- Existing focused tests cover watch reliability, action clocks, negative evidence, material verdicts, runtime
  admission, primitives, and Torghut market context. Missing tests are outcome-delta reducers, schedule-debt netting,
  and repair-token reweighting after no-effect or regressed repairs.

## Problem

Jangar now has enough admission signals to avoid the worst false-green behavior, but it still lacks closure accounting.
The system can say that a wrapper completed, a schedule recovered, or a repair was admitted. It cannot yet say whether
that work bought down the debt that justified the token.

That creates five failure modes.

1. Retained failed jobs can remain visible after later successful wrappers, and operators have to infer whether the
   failure tail is historical or still actionable.
2. A completed retry can clear Kubernetes job status without reducing controller restarts, watch debt, rollout
   ambiguity, or Torghut proof blockers.
3. A repair class can keep receiving tokens because it is urgent, even if prior repairs in that class produced no
   consumer-visible improvement.
4. Deployer gates can widen after a healthy route and green CI while recent repair outcomes are regressed.
5. Torghut proof-spend bids can consume controller capacity without proving that the spend improved capital readiness.

## Alternatives Considered

### Option A: Block Schedules Until Retained Failures Are Manually Cleared

Pros:

- Simple operational rule.
- Reduces noisy schedule retries quickly.
- Easy to explain during an incident.

Cons:

- Conflates old retained failures with active debt.
- Blocks bounded repair work that may be needed to clear the system.
- Pushes correctness into manual cleanup rather than typed evidence.

Decision: reject. It is safe in the moment but brittle over a multi-day swarm.

### Option B: Keep Brownout Budgets As The Final Admission Authority

Pros:

- Uses the current selected design without adding another reducer.
- Keeps action decisions in one place.
- Avoids additional persistence.

Cons:

- Admission is not outcome settlement.
- Future token ranking cannot distinguish closed repairs from no-effect retries.
- Deployer evidence still stops at "work ran" instead of "debt moved."

Decision: reject as incomplete.

### Option C: Add Repair-Outcome Settlement Receipts

Pros:

- Separates activity from useful repair.
- Lets Jangar net retained failures against later successful closure.
- Gives Torghut proof-spend a feedback loop tied to capital readiness.
- Produces concrete deployer evidence before widening.

Cons:

- Adds one reducer and a small durable receipt table.
- Requires source, database, and consumer witnesses for closure.
- Needs care to avoid making every old failed pod a permanent debt anchor.

Decision: select Option C.

## Architecture

Add a pure reducer named `repair-outcome-settlement` under `services/jangar/src/server/`.

`RepairOutcomeReceipt` fields:

- `receipt_id`: deterministic hash of admission token, action class, namespace, source revision, target, and evidence
  window.
- `admission_token_id`: the `AdmissionSpendToken` that allowed the work, if any.
- `action_class`: `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`,
  `live_micro_canary`, or `live_scale`.
- `repair_class`: `controller_probe`, `watch_recovery`, `schedule_retry`, `database_witness`, `rollout_truth`,
  `torghut_tca`, `torghut_market_context`, `torghut_alpha_readiness`, or `torghut_submit_gate`.
- `wrapper_ref`: CronJob, Job, AgentRun, rollout, or workflow that launched the work.
- `child_refs`: concrete child Jobs, pods, nested AgentRuns, provider jobs, or workflow steps.
- `source_ref`: Git SHA, image digest, or manifest revision that owns the repair behavior.
- `before_state`: active schedule debt, retained failures, watch debt, controller restarts, rollout ambiguity, and
  consumer proof state before the repair.
- `after_state`: the same dimensions after the repair window.
- `debt_delta`: signed normalized change by dimension.
- `consumer_effect`: what the intended consumer observed, including Torghut proof-floor or capital readiness changes.
- `outcome`: `closed`, `converted`, `no_effect`, `regressed`, `stale`, or `unknown`.
- `fresh_until`: timestamp after which the receipt cannot justify future widening.
- `next_budget_modifier`: `increase`, `hold`, `decrease`, or `quarantine`.
- `rollback_target`: explicit safe state if the outcome later contradicts itself.

Outcome rules:

- `closed`: the targeted debt fell and the consumer witness improved.
- `converted`: the repair did not clear the debt but converted it into a more precise blocker.
- `no_effect`: the work completed but no target debt changed.
- `regressed`: the work increased active debt, restarts, rollout ambiguity, or Torghut proof blockers.
- `stale`: witnesses are too old or source revision no longer matches.
- `unknown`: insufficient witness data; cannot widen but can request bounded observation.

Schedule-debt netting:

- Retained failed wrapper jobs older than the latest successful settled wrapper reduce active debt only when the child
  and consumer witnesses also settle.
- Failed first attempts followed by successful second attempts become `converted` or `closed` only when the before and
  after states prove useful change.
- A running stage attempt consumes active debt budget until it settles, expires, or is explicitly waived.

Action integration:

- The brownout budget issues tokens.
- Outcome settlement grades the tokens after execution.
- The negative-evidence router turns regressed, stale, and no-effect outcomes into action-class reasons.
- The action clock uses observed closure rate per repair class to rank future repair tokens.
- Material-action verdicts cite outcome receipt IDs before deploy widening or merge-ready.

## Implementation Scope

Engineer stage:

- Add `RepairOutcomeReceipt` and `RepairOutcomeSettlement` types.
- Add a pure reducer that consumes schedule debt, watch reliability, controller pod restarts, rollout events, typed
  database status, and Torghut proof-floor summaries.
- Persist current receipts with indexes on `action_class`, `repair_class`, `outcome`, `fresh_until`,
  `admission_token_id`, and `source_ref`.
- Add a status section and lightweight read API for recent receipts.
- Feed `regressed`, `stale`, and repeated `no_effect` receipts into
  `control-plane-negative-evidence-router.ts`.
- Feed receipt IDs and closure grades into material-action verdict evidence refs.
- Teach the supporting primitives scheduler to lower priority for repair classes whose last N outcomes were
  `no_effect` or `regressed`.

Deployer stage:

- Roll out outcome calculation in shadow mode.
- Enable budget reweighting only for repair dispatch after one day of receipts.
- Enable deploy-widen and merge-ready holds after receipt false-positive rate is measured.
- Connect Torghut proof-spend budget modifiers only after the companion Torghut ledger emits stable outcomes.

## Validation Gates

- Unit: a failed cron wrapper followed by a successful wrapper is not `closed` unless child and consumer witnesses
  improve.
- Unit: a completed repair with unchanged controller restarts and unchanged Torghut proof floor is `no_effect`.
- Unit: a repair that increases readiness failures or active failed attempts is `regressed` and decreases future
  budget.
- Unit: a stale source revision produces `stale` and cannot justify deploy widening.
- Unit: direct CNPG inspection forbidden is captured as a witness limitation, not as database unhealthy when typed DB
  status is healthy.
- Integration fixture: current evidence shape with recent Agents restarts, retained failed cron jobs, and live running
  stage attempts yields repair-only dispatch, held deploy widening, and no live capital.
- Performance: reducer completes under 100 ms on a production-sized schedule and event fixture.
- Status resilience: `/api/agents/control-plane/status` remains HTTP 200 if receipt reduction fails; the new section
  reports degraded and serving stays decoupled.

## Rollout And Rollback

Rollout sequence:

1. `shadow`: compute receipts and expose them without changing admission.
2. `repair-reweight`: use outcomes to rank only zero-notional repair tokens.
3. `normal-hold`: hold normal dispatch when recent outcomes are regressed or stale.
4. `widen-hold`: require settled non-regressed receipts for deploy widening and merge-ready.
5. `torghut-feedback`: let Torghut capital repair outcomes modify proof-spend budget.

Rollback is configuration-first:

- Disable enforcement and keep receipts informational.
- If receipt computation causes load, disable the reducer and keep brownout budget behavior.
- Do not delete receipts during rollback; they are audit evidence.
- Keep Torghut live capital at zero notional whenever its proof floor remains `repair_only`.

## Risks

- Outcome scoring can overfit to a short incident window. Mitigation: start with ordinal grades and explicit witness
  fields, not opaque scores.
- Old retained failures can dominate the ledger. Mitigation: separate active, retained, and netted debt.
- A useful repair can be marked no-effect if the observation window is too short. Mitigation: each repair class owns an
  explicit settlement window and `fresh_until`.
- More persistence can add database pressure. Mitigation: update deterministic current receipts and archive only
  final state transitions.

## Handoff Contract

Engineer acceptance gates:

- Receipt reducer and tests cover all validation gates above.
- Supporting scheduler can reweight repair classes without creating duplicate work.
- Status schema is additive and does not affect `/ready`.
- Outcome receipts are deterministic across restarts for the same witnesses.

Deployer acceptance gates:

- Shadow receipts are visible for one full day before enforcement.
- Repair reweighting reduces no-effect retries or leaves them flat.
- Deploy widening is blocked when recent repair outcomes are regressed, stale, or unknown for the target revision.
- Torghut proof-spend budget is not increased unless the companion ledger reports blocker, edge, or capital-readiness
  improvement.
