# 94. Jangar Proof-Backed Rollout Brake and Repair Debt Ledger (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane rollout safety, swarm schedule launch authority, repair action admission, Torghut proof
consumption, and capital reentry guardrails.

Companion Torghut contract:

- `docs/torghut/design-system/v6/98-torghut-repair-dividend-ledger-and-capital-reentry-guard-2026-05-05.md`

Extends:

- `93-jangar-torghut-proof-sample-settlement-and-repair-close-loop-2026-05-05.md`
- `92-jangar-torghut-proof-feed-route-budget-and-quorum-split-2026-05-05.md`
- `88-jangar-negative-evidence-arbiter-and-brownout-governor-2026-05-05.md`
- `docs/torghut/design-system/v6/97-torghut-proof-sample-settlement-and-repair-close-loop-2026-05-05.md`

## Decision

I am choosing a **proof-backed rollout brake with a repair debt ledger** as the next control-plane contract. The
previous proof-sample work gives Jangar and Torghut a shared evidence object. The missing layer is actuation discipline:
which launches, rollouts, and repair attempts are allowed while recent pods, probes, jobs, and empirical data are still
showing debt.

Jangar should classify every control-plane action into one of these classes: `serve`, `discover`, `plan`, `implement`,
`verify`, `zero_notional_repair`, `paper_capital`, and `live_capital`. Each action class must cite a current
`ActuationDebtReceipt`. If debt is above the action-class threshold, Jangar keeps serving read paths, but it freezes
new schedule launches, prevents retry storms, and admits only bounded repair work that declares the debt it will reduce.

The tradeoff is intentional friction. Some plan or verify work will wait even though the API is up. That is the right
tradeoff because the current risk is not lack of launch volume; it is hidden retry pressure and stale data being
flattened into global control-plane degradation.

## Evidence Snapshot

All cluster and database checks for this pass were read-only.

### Cluster And Rollout Evidence

- The current Kubernetes identity is `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` is unset
  but in-cluster reads work.
- Jangar rolled to image `49e27b93`; recent namespace events showed readiness failures during the prior image and the
  current `jangar-ff5f988cd-rs2rp` startup window before the `/health` probe settled.
- `kubectl get pods -n jangar -o wide` showed Jangar serving, Jangar DB, Redis, Bumba, OpenWebUI, Symphony, and Alloy
  running, but the Jangar pod had just restarted and one container was still not ready during the first sample.
- `kubectl get pods -n agents --field-selector=status.phase!=Succeeded` showed healthy `agents` and
  `agents-controllers` deployments, but also recent failed Jangar plan/verify and Torghut discover/verify pods.
- AgentRun listing showed active plan/verify/discover runs, plus failed Torghut discover/verify runs in the recent
  window. The workflow is moving, but the failure tail is still live.
- Torghut live `torghut-00224` and sim `torghut-sim-00305` pods were both `2/2 Running`; events still showed liveness
  and readiness probe timeouts on the current live pod.
- Torghut events repeatedly reported ClickHouse pods matching multiple PodDisruptionBudgets and `torghut-keeper` PDB
  with no matching pods. That is not a trading outage, but it is rollout debt.
- Direct Deployment, CNPG cluster, and `pods/exec` access were forbidden. Normal architecture must not require those
  privileges to make admission decisions.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is 2,878 lines and owns schedules, swarms,
  workspaces, PVC lifecycle, signal delivery, and status updates. That is the highest-risk actuation module because a
  bug can create jobs, delete runner CronJobs, update status, or provision storage.
- Schedule launch is already stage-aware and runtime-admission-aware, but it does not yet spend from a shared recent
  failure budget across pod readiness, failed jobs, controller health, database route state, and Torghut proof debt.
- `services/jangar/src/server/primitives-kube.ts` supports built-in `CronJob`, `ConfigMap`, and PVC targets plus
  custom resources. Workspace PVC support exists, but storage-backed repair is not isolated from the broader supporting
  controller reconcile path.
- Jangar control-plane status already exposes controller heartbeats, runtime kits, execution trust, rollout health,
  database migration consistency, dependency quorum, and empirical services. Those are the right ingredients for an
  actuation debt receipt.
- Existing tests cover control-plane status, runtime admission, supporting-primitives controller behavior, kube helpers,
  empirical services, and readiness. Missing tests are cross-domain: recent failed jobs plus healthy controllers,
  rollout probe flaps plus stale verify stage, storage/PVC repair with schedule freezing, and capital gates independent
  from zero-notional repair.

### Database And Data Evidence

- Direct CNPG `psql` failed for Jangar and Torghut because `pods/exec` is forbidden. CNPG cluster listing is also
  forbidden in both namespaces.
- Jangar status reports the database connected with 2 ms latency and migration consistency healthy: 26 registered and
  26 applied migrations, latest `20260505_torghut_quant_pipeline_health_window_index`.
- Torghut `/db-check` reports schema current with expected head `0029_whitepaper_embedding_dimension_4096`, no missing
  heads, no unexpected heads, one current head, and lineage ready. It still carries known parent-fork warnings.
- Torghut `/trading/health` is degraded for trading authority: three hypotheses, zero promotion eligible, three
  rollback required, empirical jobs degraded, live submission blocked by `simple_submit_disabled`, and quant health not
  configured.
- Torghut `/trading/empirical-jobs` shows four stale but truthful empirical jobs from 2026-03-21:
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Torghut `/trading/profitability/runtime` shows a 72-hour window with eight decisions, zero executions, zero TCA
  samples, and all AAPL, AMD, INTC, and NVDA decisions rejected by `microbar-volume-continuation-long-top2-v11`.
- ClickHouse guardrail metrics report both replicas reachable, disk free ratios around 0.97, no read-only replicated
  tables, fresh `ta_signals` and `ta_microbars` timestamps, and successful last scrape. Historical low-memory fallback
  counters still need to be carried as proof cost, not ignored.
- The options catalog reports `ready=true` while `last_success_ts=null` and the last error detail is a timeout. Ready is
  not the same thing as useful data proof.

## Problem

Jangar has built enough evidence surfaces to know when the system is degraded. It does not yet have a single rule for
how much new actuation it should allow while degraded.

That creates three concrete failure modes:

1. **Retry pressure hides inside normal schedules.** A healthy controller can continue launching plan, discover, or
   verify work while recent failed pods and probe flaps show the runtime is already consuming recovery capacity.
2. **Proof debt and rollout debt are separate in the UI but coupled in operations.** Stale empirical jobs should create
   repair work, but rollout probe failures should dampen how much repair work starts at once.
3. **Capital gates are safe, but repair gates are not economically ranked.** Torghut correctly holds capital, yet the
   control plane does not allocate zero-notional repair capacity by expected debt reduction or profit value.

The system needs a shared ledger that says: this action is safe to run now, this action must wait, and this repair is
worth spending the next scarce launch.

## Alternatives Considered

### Option A: Keep Proof Settlement As The Only New Boundary

Continue with producer samples, consumer receipts, and proof settlement. Let rollout and schedule retry behavior stay
inside the existing controller paths.

Pros:

- Minimal new design surface.
- Keeps the previous proof contracts focused.
- Avoids another persisted object.

Cons:

- Does not stop retry pressure when recent failed pods are visible.
- Treats rollout flaps and stale proof as independent even when both consume operator attention.
- Gives no economic ranking for zero-notional repair launches.

Decision: reject as insufficient. Proof settlement is necessary but not enough.

### Option B: Tune Probes, Timeouts, And Retry Counts

Increase startup windows, reduce CronJob cadence, and tune failed-job backoff thresholds.

Pros:

- Useful operational mitigation.
- Low implementation complexity.
- Can reduce noisy failures quickly.

Cons:

- Local tuning does not create an auditable action-class decision.
- Probe and backoff settings will drift by workload.
- Still cannot decide whether a Torghut repair should outrank another swarm launch.

Decision: use tactically, but do not treat it as the architecture.

### Option C: Proof-Backed Rollout Brake And Repair Debt Ledger

Create an `ActuationDebtReceipt` for the current control-plane window and require schedule launch, repair, and capital
classes to spend against it.

Pros:

- Converts recent failures into explicit launch budgets.
- Separates read-serving from new actuation, so Jangar can remain useful during degraded windows.
- Lets Torghut repair work continue only when it declares a measurable debt reduction.
- Gives deployers a rollback gate that is independent of ticket state.

Cons:

- Adds a new admission object and tests.
- Requires careful adoption to avoid freezing all work during normal rollout churn.
- Needs a clear expiry model so stale debt does not outlive the evidence window.

Decision: select Option C.

## Chosen Architecture

### ActuationDebtReceipt

Jangar materializes a compact receipt per namespace and action window:

```text
actuation_debt_receipt
  receipt_id
  namespace
  generated_at
  fresh_until
  producer_revision
  action_window
  rollout_debt
  execution_debt
  data_proof_debt
  storage_debt
  route_budget_debt
  recent_recovery_credit
  action_class_decisions
  evidence_refs
```

`rollout_debt` includes readiness/liveness probe failures, unavailable deployment replicas, ImagePullBackOff, PDB
warnings that affect protected data planes, and recent pod restart bursts. `execution_debt` includes failed AgentRun
jobs, stale stages, duplicate idempotency launches, and verify lag. `data_proof_debt` includes stale empirical jobs,
missing quant health, missing options catalog success timestamps, and proof-sample disagreement. `storage_debt` includes
Workspace/PVC pending, expired, or delete-failed state.

### Action-Class Decisions

The receipt produces one decision per class:

```text
serve: allow | delay | brownout
discover: allow | delay | block
plan: allow | delay | block
implement: allow | delay | block
verify: allow | delay | block
zero_notional_repair: allow | delay | block
paper_capital: allow | delay | block
live_capital: allow | block
```

Serving can stay `allow` or `brownout` while launch classes are delayed. `live_capital` cannot be `delay`; it is either
allowed by fresh proof and Jangar quorum or blocked.

### Rollout Brake

The supporting-primitives controller must consult the current receipt before it creates or keeps schedule-runner
ConfigMaps and CronJobs. A blocked launch class deletes or withholds the runner resources and writes a status condition
with the receipt id and debt reasons. A delayed class keeps templates visible but sets `suspend: true` on runner
CronJobs once that implementation exists; until then, deleting the runner remains the safer behavior.

This is intentionally narrower than stopping the controller. The controller keeps watching, reconciling status, and
serving read evidence. It only brakes new action.

### Recovery Bonds

Every zero-notional repair launch must carry:

```text
recovery_bond
  bond_id
  requested_action
  expected_debt_reduction
  max_runtime
  max_route_budget_ms
  max_parallelism
  rollback_on_failure
  success_evidence
```

If the repair reduces the declared debt before expiry, Jangar records recovery credit. If it fails or overruns, the
debt window is extended and parallel repair capacity is reduced. This prevents repair work from becoming another retry
storm.

### Torghut Profit Repair Coupling

Torghut provides the profit-side value of each repair through the companion `repair_dividend` contract. Jangar does not
choose trading strategy winners. It chooses whether the system can afford to launch a repair now and whether the repair
has enough declared value to outrank other action classes.

Minimum Torghut repair candidates for the current evidence:

- refresh the four stale empirical jobs and produce fresh artifact refs;
- classify the eight rejected `microbar-volume-continuation-long-top2-v11` decisions by blocker and expected fix path;
- repair options catalog data proof so `ready=true` is accompanied by a non-null success timestamp;
- configure typed quant health before any paper-capital or live-capital reentry.

## Implementation Scope

Engineer stage should implement:

- `ActuationDebtReceipt` types in Jangar status data and server status modules.
- A receipt builder that consumes existing rollout health, execution trust, empirical services, database consistency,
  runtime kit, AgentRun job, and Workspace/PVC evidence.
- Schedule launch integration in `supporting-primitives-controller.ts`, with tests for allow, delay, block, and recovery
  credit.
- A narrow storage/PVC debt extractor so Workspace lifecycle failures do not disappear inside the supporting controller.
- UI surfacing that shows the receipt id, action-class decisions, and top debt reasons without replacing existing
  status panels.

Torghut engineer stage should implement the companion repair dividend route before Jangar treats repair value as
authoritative.

## Validation Gates

Required local and CI gates:

- Jangar unit tests for receipt construction from healthy, degraded, and blocked evidence.
- Supporting controller tests proving blocked plan/verify classes do not create launch-capable CronJobs.
- Regression test proving serving remains allowed while plan or verify is delayed.
- Workspace/PVC tests proving pending or expired storage contributes storage debt.
- Torghut tests proving repair dividends cannot unlock paper or live capital without fresh empirical jobs and typed
  quant health.
- Manual read-only validation against `/api/agents/control-plane/status?namespace=agents`, `/trading/health`,
  `/trading/empirical-jobs`, `/trading/profitability/runtime`, and guardrail exporter metrics.

## Rollout Plan

1. Ship receipt calculation in shadow mode and expose it in status only.
2. Compare receipt decisions against current schedule launches for at least one full Jangar/Torghut swarm cadence.
3. Enable enforcement for `verify` and `plan` launch classes first, because those are visible in the current failure
   tail and do not affect serving.
4. Enable `zero_notional_repair` bonds after Torghut emits repair dividends.
5. Keep `paper_capital` and `live_capital` blocked until empirical jobs are fresh, quant health is configured, Jangar
   dependency quorum allows, and rollout debt is below threshold.

## Rollback Plan

Rollback is a configuration rollback, not a data rollback. Disable receipt enforcement and return schedule admission to
the previous runtime-passport path while preserving the shadow receipt in status for forensics. Existing schedules should
be reconciled by the controller on the next watch or periodic pass. Capital remains governed by existing Torghut live
submission and Jangar dependency-quorum gates.

## Risks

- The first threshold set may be too conservative and delay useful repair work. Mitigation: shadow mode plus per-class
  enforcement, not global enforcement.
- Receipt evidence can go stale if status collectors fail. Mitigation: every receipt has `fresh_until`; expired receipts
  block launch classes and keep serving in brownout.
- Supporting-primitives controller size makes implementation risky. Mitigation: add the receipt builder as a separate
  module and keep controller edits to admission calls and status conditions.
- Profit repair value can be gamed if Torghut overstates dividends. Mitigation: dividends are zero-notional until
  measured debt reduction and fresh proof are observed.

## Handoff To Engineer And Deployer

Engineer acceptance gate: a blocked receipt must prevent a schedule-runner CronJob from launching work, while `/health`
and read-only control-plane status remain available.

Deployer acceptance gate: after rollout, a fresh read of Jangar status must show the receipt id and action-class
decisions; Torghut capital must remain shadow while empirical jobs are stale or quant health is unconfigured; and a
manual rollback must restore previous schedule admission without requiring database writes.
