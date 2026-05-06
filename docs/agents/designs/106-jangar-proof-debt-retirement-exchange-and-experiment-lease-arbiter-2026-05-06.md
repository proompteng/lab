# 106. Jangar Proof Debt Retirement Exchange And Experiment Lease Arbiter (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, proof debt retirement, material-action leases, rollout safety, and Torghut
options hypothesis admission.

Companion Torghut contract:

- `docs/torghut/design-system/v6/110-torghut-options-hypothesis-leases-and-capital-reentry-ladder-2026-05-06.md`

Extends:

- `105-jangar-evidence-pressure-runways-and-profit-proof-budgets-2026-05-06.md`
- `104-jangar-quant-evidence-clearinghouse-and-capital-action-firewall-2026-05-06.md`
- `103-jangar-torghut-decision-custody-cells-and-rollout-proof-exchange-2026-05-06.md`

## Decision

I am choosing a **proof debt retirement exchange with experiment lease arbitration** as the next Jangar architecture
step for Torghut quant.

The current cluster is serving, but it is not capital-ready. Argo reports `jangar`, `agents`, and `torghut` synced and
healthy at revision `da09882e2f7b2ecb48e45a9a4d6f3427725fdb7d`. Jangar is healthy, `agents-controller`,
`supporting-controller`, and `orchestration-controller` are heartbeat-healthy, execution trust is healthy, the database
projection is healthy, and rollout health reports both configured Agents deployments healthy. Torghut live revision
`torghut-00233` and simulation revision `torghut-sim-00314` are ready.

The open failure mode is authority drift after recovery. Jangar dependency quorum still blocks on
`empirical_jobs_degraded`. The Agents namespace has `10` failed AgentRuns, `26` failed Jobs, and retained Error pods
from older Jangar and Torghut quant stages. Torghut `/readyz` is degraded even though Postgres, ClickHouse, Alpaca, and
universe checks are healthy. Torghut live submission is still blocked by `simple_submit_disabled`, capital stage is
`shadow`, quant health is not configured as required by Torghut, and empirical jobs are stale from
`2026-03-21T09:03:22Z`.

At the same time, Torghut has a live opportunity surface. The options catalog and options enricher are ready, the
enricher last succeeded at `2026-05-06T08:11:25Z`, the options hot set returned `160` symbols under a provider cap of
`200`, and ClickHouse guardrails report both replicas reachable with disk-free ratios near `0.97`. The right move is not
to freeze all Torghut work. It is to let Jangar issue tightly scoped leases for proof repair and shadow experiments
while refusing to turn route health into live capital.

The selected design makes proof debt explicit and finite. Jangar will price stale empirical jobs, failed run debt,
stale quant latest rows, stale trade decisions, old TCA coverage, and rollout warning debt as items in a retirement
exchange. The exchange issues experiment leases only when the requested work either retires a named debt item or
generates bounded shadow evidence for a named hypothesis. No lease can grant live capital until the debt ledger proves
fresh empirical proof, current account/window quant, current TCA coverage, and a clean rollout window.

The tradeoff is another reducer and projection. I accept that because the current system needs a way to distinguish
useful repair from unsafe widening. A boolean block keeps us safe but slows learning. Ignoring debt lets us learn, but
risks repeating stale-proof capital decisions. A debt-priced lease is the useful middle.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, runtime settings, broker settings, or trading flags were mutated during this
assessment.

### Cluster And Rollout Evidence

- The runtime identity is `system:serviceaccount:agents:agents-sa`; I initialized only the local kubectl context for
  read-only checks and verified `kubectl auth whoami`.
- `kubectl get applications -n argocd jangar agents torghut -o wide` showed all three applications `Synced` and
  `Healthy` at revision `da09882e2f7b2ecb48e45a9a4d6f3427725fdb7d`.
- `kubectl get deploy -n jangar -o wide` showed `jangar=1/1`, `bumba=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`. The active Jangar image was `a4403261`.
- `kubectl get deploy -n agents -o wide` showed `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Jangar control-plane status at `2026-05-06T08:09:57Z` reported all three controllers heartbeat-healthy, execution
  trust healthy, database migration consistency healthy, and rollout health healthy for the configured `agents` and
  `agents-controllers` deployments.
- The same status kept `dependency_quorum.decision=block` with reason `empirical_jobs_degraded`.
- `kubectl get agentruns -n agents -o json` counted `96` succeeded, `10` failed, `4` running, and `12` template
  AgentRuns. `kubectl get jobs -n agents -o json` counted `126` complete, `26` failed, and `4` running jobs.
- Recent Agents events showed a new rollout onto `a4403261`, transient readiness probe failures on the old controller
  pods, and fresh scheduled Jangar and Torghut discover jobs completing.
- `kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded` still showed retained Error pods
  in `agents`, three pending Rook Ceph OSD pods, and `temporal/elasticsearch-master-1` pending.
- `kubectl get pods -n torghut -o wide` showed ClickHouse, Keeper, Torghut Postgres, latest live and simulation
  revisions, options catalog/enricher, options TA, equity TA, simulation TA, websocket services, guardrail exporters,
  Symphony, and Alloy running.
- Recent Torghut events still included repeated ClickHouse multiple-PDB warnings and a Flink status modification
  conflict for the options TA deployment, so deploy widening should keep a rollout proof budget.

### Database And Data Evidence

- Torghut `/db-check` returned schema current at Alembic head `0029_whitepaper_embedding_dimension_4096`, with expected
  and current head signatures aligned.
- The schema graph still reports known parent forks at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`; there are no duplicate revisions or orphan parents in the read.
- Torghut `/readyz` returned `status=degraded`; Postgres, ClickHouse, Alpaca live account status, database schema, and
  Jangar universe were healthy, while live submission was blocked by `simple_submit_disabled`.
- Torghut `/trading/status` reported `mode=live`, `pipeline_mode=simple`, `TRADING_AUTONOMY_ENABLED=false`, empirical
  jobs stale from `2026-03-21T09:03:22Z`, and quant evidence `not_required` because `quant_health_not_configured`.
- Jangar typed Torghut quant health returned `status=ok`, `latestMetricsCount=108`,
  `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z`, and `metricsPipelineLagSeconds=52930`. This is reachable, but it
  is too old to be live capital proof without market-session-aware enforcement.
- Torghut runtime profitability for the last `72h` showed an active window with `8` decisions, `0` executions, and `0`
  TCA samples.
- The newest sampled Torghut trade decisions were three `rejected` rows at `2026-05-04T17:25:57Z`.
- The newest sampled executions were canceled `MU` rows from `2026-04-02T20:59:45Z`.
- Torghut TCA summary still had `13,775` historical orders, expected-shortfall coverage `0`, and
  `last_computed_at=2026-04-02T20:59:45Z`.
- The options catalog service was ready and returned a hot set of `160` symbols. The options enricher was ready with
  `last_success_ts=2026-05-06T08:11:25.776545Z`.
- ClickHouse guardrails reported both Torghut replicas reachable, no read-only replica, disk-free ratios `0.972` and
  `0.969`, and last scrape success at `2026-05-06T08:10:18Z`. TA signal and microbar freshness pointed to
  `2026-05-05T20:59:07Z`.

Direct secret and pod-exec database access is not available to this service account. Database evidence is therefore
from service-owned read-only projections and metrics surfaces. That is an important design constraint: the control
plane must publish safe projections that do not depend on operator pod exec.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the current reducer boundary at `629` lines. It already
  composes controller authority, runtime adapters, database status, rollout health, execution trust, workflows,
  empirical services, dependency quorum, runtime admission, and leases.
- `services/jangar/src/server/supporting-primitives-controller.ts` is still the highest-blast-radius Jangar module at
  `2,882` lines. It owns CRD checks, watches, schedule generation, schedule-runner CronJobs, swarms, requirements,
  freezes, workspace PVC status, and reconciliation.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` and
  `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` expose the typed Torghut quant latest
  and health path that an experiment lease can consume without full proof-series scans.
- `services/torghut/app/main.py` is `4,051` lines and owns readiness, trading status, profitability, decisions,
  executions, and TCA APIs.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4,288` lines and owns live-submission gate consumption,
  strategy runtime, signal continuity, risk, sizing, market context, and submission.
- `services/torghut/app/trading/submission_council.py` is `1,196` lines and owns quant evidence, empirical readiness,
  capital stage, promotion eligibility, and live-submission gate payloads.
- Test coverage exists for Jangar control-plane status, empirical services, quant metrics store/runtime, Torghut
  quant-health routes, Torghut empirical jobs, hypothesis governance, options lane, scheduler safety, submission
  council, profitability proofs, TCA policy, and quant readiness. The missing regression is a cross-plane lease reducer
  proving that fresh options data plus stale empirical jobs and old TCA can allow shadow hypothesis work while blocking
  paper and live capital.

## Problem

Jangar can currently say "serving is healthy" and "dependency quorum is blocked." That is correct, but it leaves too
much judgment outside the control plane.

The next stage needs to answer five finer questions:

1. Which specific stale proof item blocks material action?
2. Which repair or shadow experiment will retire that item?
3. How much query, rollout, and capital-adjacent budget can that work spend?
4. When does the proof expire?
5. What is the rollback behavior if a lease starts producing stale, expensive, or contradictory evidence?

Without those answers, the system falls into two bad postures. A full freeze protects capital but wastes the fresh
options lane. A route-health reopen generates decisions before proof is current. Neither posture is good enough for the
next six months of Torghut quant.

## Alternatives Considered

### Option A: Keep Dependency Quorum As The Sole Gate

Pros:

- Already implemented and blocking on stale empirical jobs.
- Easy for operators to understand.
- Prevents immediate live capital widening.

Cons:

- Cannot distinguish repair from capital action.
- Does not retire stale proof debt as a first-class object.
- Does not let fresh options data produce bounded shadow evidence.
- Leaves Torghut to infer action classes from several status payloads.

Decision: reject as the primary design. Keep dependency quorum as an input.

### Option B: Freeze Torghut Until Every Debt Item Is Green

Pros:

- Strong capital protection.
- Simple deployer posture.
- Avoids creating more proof data while the system already has retained failures.

Cons:

- Wastes the freshest data plane, which is options enrichment and hot-set ranking.
- Does not produce new hypothesis windows or promotion evidence.
- Does not reduce failed-run or empirical debt except through manual work.
- Encourages one-off overrides when operators want learning.

Decision: reject as the normal operating model. Preserve it as emergency fail-closed behavior.

### Option C: Proof Debt Retirement Exchange With Experiment Lease Arbitration

Pros:

- Converts stale proof and failed-run debt into named, finite work items.
- Lets Jangar allow observation, proof repair, and zero-notional options experiments without granting capital.
- Gives Torghut one lease contract before it generates hypothesis windows, promotion decisions, paper canaries, or live
  notional.
- Keeps expensive proof reads on latest/materialized paths by adding query budgets to each lease.
- Makes rollout widening safer because deployer can see which debt items are still active.

Cons:

- Adds a reducer, projection, and lease lifecycle.
- Requires shadow-mode calibration so debt weights do not block useful work.
- Requires Torghut to honor lease absence before sizing and promotion.

Decision: select Option C.

## Chosen Architecture

Jangar adds two projections.

The first projection is `proof_debt_item`:

```text
proof_debt_item
  debt_id
  namespace
  consumer                         # jangar, agents, torghut
  source_kind                      # empirical_job, agentrun, job, quant_latest, trade_decision, tca, rollout, storage
  source_ref
  action_scope                     # observe, repair, shadow_experiment, paper_canary, live_micro_canary, live_scale
  severity                         # info, warning, block
  stale_since
  fresh_until
  retirement_condition
  owner_stage
  evidence_refs[]
  status                           # active, retiring, retired, superseded
  retired_at
```

The second projection is `experiment_lease`:

```text
experiment_lease
  lease_id
  namespace
  consumer                         # torghut
  account_label
  hypothesis_id
  strategy_id
  data_surface                     # options, equity, market_context, quant_latest, tca
  action_class                     # repair, shadow_rank, shadow_decide, metric_window, paper_canary, live_micro_canary
  debt_items[]
  decision                         # allow, shadow_only, repair_only, hold, block
  budget_remaining
  max_symbols
  max_contracts
  max_notional
  max_query_cost
  fresh_until
  reason_codes[]
  evidence_refs[]
```

Reducer rules:

- Route health can issue `observe` leases only.
- Healthy rollout plus active proof debt can issue `repair_only` leases when the repair scope names a debt item.
- Fresh options data with stale empirical proof can issue `shadow_rank`, `shadow_decide`, and `metric_window` leases
  with `max_notional=0`.
- Stale empirical jobs, stale or missing account/window quant latest, old TCA coverage, active failed run debt, or red
  infrastructure pressure block `paper_canary`, `live_micro_canary`, and `live_scale`.
- Retained historical failures can move from `active` to `superseded` only when a newer run for the same stage and
  scope succeeds and the evidence refs are recorded.
- Full-series proof reads require an offline repair lease. Admission reducers use latest/materialized projections.
- A lease expires at `fresh_until`; expired leases downgrade to `hold` until refreshed or retired.

For the current evidence, expected decisions are:

```text
jangar_observe                         allow
jangar_repair_empirical_jobs           repair_only
torghut_options_shadow_rank            shadow_only
torghut_options_shadow_decide          shadow_only
torghut_hypothesis_metric_window       shadow_only
torghut_paper_canary                   block
torghut_live_micro_canary              block
torghut_live_scale                     block
```

## Implementation Scope

Engineer stage should:

1. Add a pure reducer for `proof_debt_item` and `experiment_lease` decisions under the Jangar control-plane status
   boundary.
2. Populate debt items from dependency quorum, empirical jobs, AgentRun phases, Job terminal states, quant latest
   freshness, TCA freshness, trade-decision freshness, rollout health, and infrastructure pressure.
3. Add an API/status projection that exposes active debt and leases without requiring secret, CNPG, or pod-exec access.
4. Add Torghut-facing lease fixtures for current state: fresh options data, stale empirical jobs, stale decisions, old
   executions/TCA, quant latest not required by Torghut, and live submission disabled.
5. Keep lease admission on latest/materialized paths. Any full proof-series query must be a named repair job with a
   query budget and fresh artifact output.

Deployer stage should:

1. Deploy the exchange in observe-only mode.
2. Compare debt items against Jangar dependency quorum, Torghut `/readyz`, Torghut `/trading/status`, quant health, and
   options lane status for one full market session.
3. Enable `repair_only` and `shadow_only` leases only after the projection matches observed debt.
4. Keep paper and live capital blocked until stale empirical jobs, old TCA, stale decisions, failed run debt, and
   account/window quant freshness are retired.
5. Roll back by disabling lease enforcement while keeping the read-only debt projection visible.

## Validation Gates

- A reducer test proves healthy rollout plus stale empirical jobs emits `repair_only` and `shadow_only`, never live.
- A reducer test proves fresh options hot-set data with empty or stale profit proof emits `shadow_only` leases with
  `max_notional=0`.
- A reducer test proves old TCA coverage blocks `live_micro_canary` and `live_scale`.
- A reducer test proves retained failed jobs can be superseded by newer successful scoped runs instead of blocking
  forever.
- An API contract test proves every lease includes `fresh_until`, `reason_codes`, `evidence_refs`, and a query budget.
- A Torghut integration fixture proves the scheduler refuses live sizing when no current lease exists.
- A deployer validation run proves no pod exec or secret read is required to inspect the debt/lease state.

## Rollout And Rollback

Rollout sequence:

1. Ship read-only debt projection and lease decisions in shadow mode.
2. Calibrate debt severity for one market session and one scheduled swarm cycle.
3. Enable repair and shadow experiment lease enforcement.
4. Require paper-canary leases before promotion decisions.
5. Require live-micro-canary leases before any live notional.

Rollback sequence:

1. Disable lease enforcement with a single control-plane flag.
2. Keep debt projection read-only for operator diagnosis.
3. Fall back to dependency quorum, live submission gate, and Torghut shadow capital stage.
4. Keep live capital disabled until a post-rollback proof bundle explains which lease decision was wrong.

## Risks

- Debt weights can become too conservative and starve useful shadow experiments. Mitigation: calibrate in observe-only
  mode and require reason-code histograms before enforcement.
- Retained historical failures can block too long. Mitigation: support scoped supersession by newer successful runs.
- Torghut can bypass the lease if scheduler integration is partial. Mitigation: make absence of a current lease a
  scheduler test failure before any paper or live sizing path.
- Query budgets can be ignored by ad hoc analysis. Mitigation: admission reducers use latest/materialized paths only,
  and full-series work requires a repair lease.

## Handoff Contract

Engineer acceptance is a merged implementation that emits deterministic debt and lease projections, has reducer tests
for the current evidence mix, and proves Torghut cannot size live without a current lease.

Deployer acceptance is a rollout report showing one market-session shadow comparison, active debt items, lease
decisions, retired debt evidence, and an explicit rollback flag. Live capital remains blocked until paper-canary and
live-micro-canary leases are fresh and all blocker debt items are retired.
