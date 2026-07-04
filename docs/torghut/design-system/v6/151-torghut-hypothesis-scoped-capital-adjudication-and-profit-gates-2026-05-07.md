# 151. Torghut Hypothesis-Scoped Capital Adjudication And Profit Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut profitability, hypothesis-scoped proof verdicts, paper/live capital gates, forecast dependency scoping,
TCA and market-context guardrails, validation, rollout, rollback, and implementation handoff.

Companion Jangar contract:

- `docs/agents/designs/147-jangar-hypothesis-scoped-capital-adjudication-ledger-2026-05-07.md`

Extends:

- `150-torghut-repair-dividend-order-book-and-capital-warrants-2026-05-07.md`
- `149-torghut-profit-evidence-convergence-epochs-and-quant-stage-arbitrage-2026-05-07.md`
- `148-torghut-profit-evidence-reactivation-scheduler-and-paper-gate-receipts-2026-05-07.md`
- `docs/agents/designs/146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md`

## Decision

I am selecting **hypothesis-scoped capital adjudication and profit gates** for Torghut.

Torghut's current posture is safe but not yet economically useful. Live status is reachable, empirical jobs are fresh,
Postgres and ClickHouse are healthy, and the service is running revision `torghut-00259`. The same status correctly
holds live capital at zero notional. Live `/readyz` is HTTP 503, the proof floor is `repair_only`, all three
hypotheses are shadow with `0` promotion eligible, execution TCA breaches the slippage guardrail, market context is
stale, and live submit remains disabled.

Simulation is not a clean paper candidate either. Simulation status is reachable, but simulation `/readyz` timed out;
simulation proof floor is `repair_only`; simulation latest quant metrics are empty; simulation TCA has `0`
expected-shortfall coverage and average absolute slippage above the `8` bps guardrail; and there are unsettled
simulation executions.

The next profitable architecture step is not another global readiness flag. Torghut needs to emit adjudication-ready
proof verdicts per hypothesis. Jangar should be able to see that `H-CONT-01` is blocked by signal lag and stale TCA,
`H-MICRO-01` is blocked by drift, signal lag, and stale TCA, and `H-REV-01` is blocked by market context, signal lag,
and stale TCA. Forecast debt should block only hypotheses that require forecast authority, not every paper repair path.

The tradeoff is stricter schema and more explicit hypothesis metadata. I accept that. Profitability requires narrower
capital decisions than service-level readiness can provide.

## Runtime Objective And Success Metrics

Success means:

- Torghut exposes `hypothesis_capital_verdicts` in `/trading/status` and `/trading/health`.
- Every verdict has `verdict_id`, `account_label`, `torghut_revision`, `hypothesis_id`, `strategy_family`,
  `action_class`, `capital_decision`, `max_notional`, `expected_after_cost_bps`, `expected_shortfall_coverage`,
  `avg_abs_slippage_bps`, `forecast_dependency`, `proof_dimensions`, `blocking_reason_codes`,
  `repair_actions`, `source_refs`, `fresh_until`, and `rollback_target`.
- Verdicts distinguish stale evidence from bad evidence.
- Forecast dependency is declared per hypothesis as `not_required`, `optional`, or `required`.
- Live submit remains disabled until paper settlement, live proof, expected-shortfall coverage, and rollback posture
  agree.
- Paper canary can only be proposed for a hypothesis whose own proof dimensions pass.
- Live micro canary can only be proposed for a hypothesis that has settled paper evidence.
- Live scale remains blocked until live micro settlement and expected-shortfall coverage are current.

## Read-Only Evidence Snapshot

I collected this evidence without mutating Kubernetes resources, database records, broker state, trading settings,
ClickHouse tables, AgentRun objects, GitOps resources, or empirical artifacts.

### Cluster Evidence

- `kubectl get pods -n torghut -o wide` showed `torghut-00259-deployment-c94544c69-xd9fj` and
  `torghut-sim-00359-deployment-57c446b98b-bvpx7` `2/2 Running`.
- Torghut Postgres, ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog, options enricher, websockets,
  exporters, Alloy, and Symphony pods were running.
- Torghut services exposed live and simulation Knative revisions plus Postgres read-write/read-only services and
  ClickHouse services.
- Recent Torghut events showed rollout startup/readiness probe failures that cleared for the latest revisions.
- Recent Torghut events still showed duplicate ClickHouse PodDisruptionBudget matches, Keeper `NoPods`, and
  FlinkDeployment status-modified warnings.
- Argo CD reported `torghut` as `Synced` and `Healthy` at revision `4c4417997ba6adb89678d7a784499adfa22b7470`.

### Trading Evidence

- Live `/healthz` returned HTTP 200.
- Live `/readyz` returned HTTP 503 with service dependencies mostly healthy but live submission and proof floor not
  ready.
- Live `/trading/status` returned HTTP 200 with `mode=live`, `pipeline_mode=simple`, active revision
  `torghut-00259`, build commit `0aa204cd446ba8ad24f4460eaa74d392a5ae3ea4`, and `orders_submitted_total=0`.
- Live submission gate was `allowed=false`, reason `simple_submit_disabled`, `capital_stage=shadow`.
- Live proof floor was `repair_only`, `route_state=repair_only`, `capital_state=zero_notional`, and `max_notional=0`.
- Live proof blockers were `hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live empirical jobs were healthy, truthful, and promotion-authority eligible for candidate
  `chip-paper-microbar-composite@execution-proof` on dataset `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Live quant evidence was degraded but not a hard live gate: latest metrics count `144`, latest update
  `2026-05-07T13:09:33.290Z`, stage count `3`, and ingestion lag about `69,893` seconds.
- Live TCA had `13,775` orders, `13,571` filled executions, last computed at `2026-04-02T20:59:45.136640Z`, average
  absolute slippage `568.6138848199565249` bps, and expected-shortfall coverage `0`.
- Live hypotheses totaled `3`, all shadow, `0` promotion eligible, and `3` rollback required.
- `H-CONT-01` was blocked by signal lag and stale TCA.
- `H-MICRO-01` was blocked by missing drift checks, signal lag, and stale TCA.
- `H-REV-01` was blocked by stale market context, signal lag, and stale TCA.
- Simulation `/trading/status` returned HTTP 200 for `mode=paper`, active revision `torghut-sim-00359`, and paper
  submission gate allowed because it is non-live mode.
- Simulation `/readyz` timed out after 12 seconds.
- Simulation proof floor was `repair_only`, `capital_state=zero_notional`, with blockers for alpha readiness,
  execution TCA slippage, and market context.
- Simulation quant latest metrics count was `0`, latest update was null, stage count was `0`, and the latest-store
  alarm was active.
- Simulation TCA had average absolute slippage `17.4301320928571429` bps, expected-shortfall coverage `0`, and `3`
  unsettled executions.

### Database And Data Evidence

- Live `/db-check` returned HTTP 200 and schema-current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema graph lineage was ready with root `0001_initial`, branch count `1`, duplicate revisions `{}`, and no orphan
  parents.
- Historic parent-fork warnings remain at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Account-scope checks were ready, with the current warning that account-scope checks are bypassed when
  multi-account trading is disabled.
- Direct CNPG cluster listing was RBAC-blocked for `system:serviceaccount:agents:agents-sa`.
- Data freshness is mixed: empirical jobs are fresh; live quant latest metrics are fresh but ingestion is lagged;
  simulation quant latest metrics are empty; market context has no fresh timestamp; and live TCA is more than a month
  old.

### Source Evidence

- `services/torghut/app/main.py` is `4145` lines and should remain route assembly, not adjudication logic.
- `services/torghut/app/trading/proof_floor.py` is `593` lines and already emits proof dimensions and repair ladder
  entries.
- `services/torghut/app/trading/submission_council.py` is `1199` lines and owns submission gate reduction.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines and is too large to absorb another capital
  reducer.
- `services/torghut/app/trading/tca.py` is `815` lines and owns TCA aggregation and expected-shortfall fields.
- `services/torghut/app/trading/hypotheses.py` is `764` lines and already compiles hypothesis readiness state.
- `services/torghut/app/models/entities.py` is `3064` lines and contains empirical jobs, TCA metrics, and promotion
  evidence tables.
- Tests already cover proof floor, trading API proof-floor exposure, submission council, empirical jobs, hypotheses,
  forecast service, TCA adaptive policy, scheduler safety, and quant readiness.

## Problem

Torghut can explain why the whole system is not ready, but it cannot yet emit the per-hypothesis capital verdict Jangar
needs.

The failure modes are:

1. Fresh empirical proof can coexist with zero promotion-eligible hypotheses.
2. Stale TCA and bad TCA are different repair tasks, but both block capital.
3. Forecast registry debt can be global even when a hypothesis does not require forecast authority.
4. Simulation and live accounts can fail different dimensions, but the current proof floor is not shaped as a
   Jangar-ready ledger.
5. Paper canary would be unsafe unless it is tied to one hypothesis, one account, one proof row, and one rollback
   target.

## Alternatives Considered

### Option A: Keep Using Service Readiness And Proof Floor Only

Pros:

- No new schema.
- Existing routes already expose the core blockers.
- Conservative for live capital.

Cons:

- Jangar continues to see generic consumer-evidence gaps.
- Engineers still have to hand-map blockers to hypotheses.
- Forecast service debt remains too broad.

Decision: reject. It is safe but too blunt to improve profitability.

### Option B: Add A Torghut-Only Paper Capital Gate

Pros:

- Fastest path to paper experiments.
- Torghut can use local TCA, market context, empirical, and hypothesis state directly.
- Less Jangar work.

Cons:

- Bypasses Jangar's rollout, schedule, runtime-kit, watch, and material-action authority.
- Makes paper admission harder to audit from the control plane.
- Creates a precedent for Torghut self-admission.

Decision: reject. Torghut should propose verdicts, not admit capital.

### Option C: Emit Hypothesis-Scoped Capital Verdicts For Jangar

Pros:

- Keeps Torghut close to profit evidence while preserving Jangar authority.
- Lets Jangar replace generic blockers with concrete proof reasons.
- Separates forecast-required from forecast-not-required hypotheses.
- Gives engineers and deployers one testable contract per hypothesis and action class.
- Supports paper experiments without weakening live gates.

Cons:

- Requires a new reducer and tests.
- Requires hypothesis manifests to declare forecast dependency.
- Requires contradiction handling across live and simulation accounts.

Decision: select Option C.

## Architecture

Torghut adds a pure `hypothesis_capital_adjudicator` reducer and exposes its output in `/trading/status` and
`/trading/health`.

```text
hypothesis_capital_verdicts
  generated_at
  schema_version
  account_label
  torghut_revision
  source_proof_floor_ref
  verdicts[]
  summary
```

Each verdict is:

```text
hypothesis_capital_verdict
  verdict_id
  account_label
  torghut_revision
  hypothesis_id
  strategy_family
  action_class                 # observe, proof_repair, paper_canary, live_micro_canary, live_scale
  capital_decision             # allow, repair_only, shadow_only, hold, block
  max_notional
  expected_after_cost_bps
  expected_shortfall_coverage
  avg_abs_slippage_bps
  forecast_dependency          # not_required, optional, required
  proof_dimensions[]
  blocking_reason_codes[]
  downgrade_reason_codes[]
  repair_actions[]
  source_refs[]
  fresh_until
  rollback_target
```

Initial hypothesis gates:

- `H-CONT-01`: paper requires signal lag below `90` seconds, TCA evidence age below `30` minutes, at least `40` paper
  samples, post-cost expectancy at least `6` bps, and average absolute slippage at or below `12` bps.
- `H-MICRO-01`: paper requires drift checks current, feature coverage current, at least `60` paper samples,
  post-cost expectancy at least `10` bps, and average absolute slippage at or below `8` bps.
- `H-REV-01`: paper requires market-context freshness below `120` seconds, signal lag below `90` seconds, at least
  `30` paper samples, post-cost expectancy at least `8` bps, and average absolute slippage at or below `12` bps.

Global guardrails:

- Live submit disabled means live capital is blocked regardless of other proof.
- Expected-shortfall coverage `0` blocks live micro and live scale.
- Any rollback-required hypothesis cannot move beyond repair or shadow.
- Empty simulation quant latest metrics block paper for simulation-backed action classes.
- Market-closed expected staleness can defer signal checks only with a next-open validation receipt.
- Forecast service degradation blocks only hypotheses with `forecast_dependency=required`.
- Unknown forecast dependency defaults to `required` until the hypothesis manifest declares it.

## Validation Gates

Engineer acceptance gates:

- Add `app/trading/hypothesis_capital_adjudicator.py` or equivalent pure reducer; keep `app/main.py` thin.
- Add hypothesis manifest fields for forecast dependency and paper/live gate thresholds.
- Add tests for the current evidence shape: empirical healthy, zero promotion eligible, live TCA guardrail breach,
  market context stale, live submit disabled, simulation latest metrics empty, and forecast registry degraded.
- Add tests proving stale TCA and bad TCA emit different repair actions.
- Add tests proving forecast degradation blocks forecast-required hypotheses only.
- Add tests proving all current hypotheses remain `repair_only` or `hold` under current evidence.
- Add API tests proving `/trading/status` and `/trading/health` expose stable verdict IDs and source refs.

Deployer acceptance gates:

- Do not use Torghut verdicts as capital authority without Jangar ledger acceptance.
- Before paper, require one hypothesis verdict with all paper dimensions passing, no account contradiction, current
  simulation proof, and closed Jangar repair warrant.
- Before live micro, require prior paper settlement for the same hypothesis, live proof current, live submit still
  governed, and expected-shortfall coverage above the configured threshold.
- Before live scale, require live micro settlement and no rollback-required state.
- Roll back by hiding the verdict section and returning Jangar to current proof-floor and action SLO inputs.

Suggested local validation:

```bash
cd services/torghut
uv run --frozen pytest \
  tests/test_profitability_proof_floor.py \
  tests/test_hypotheses.py \
  tests/test_submission_council.py \
  tests/test_trading_api.py
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

## Rollout

Roll out in four phases:

1. `observe`: emit verdicts, no gate changes.
2. `source-refs`: let Jangar ingest verdict IDs as evidence refs while preserving decisions.
3. `paper-scope`: allow Jangar to evaluate paper by hypothesis instead of service-wide forecast or consumer-evidence
   labels.
4. `live-consistency`: require the same verdict schema for live micro and scale checks.

No phase enables live submit by itself. Live remains disabled until Jangar and Torghut gates both pass.

## Rollback

Rollback is to stop emitting `hypothesis_capital_verdicts` and continue using the current proof floor, live submission
gate, empirical job health, market-context state, TCA summary, and submission council checks. Jangar falls back to the
generic consumer-evidence and action SLO behavior. No broker state, Kubernetes object, or database row needs manual
mutation for rollback.

## Risks

- Hypothesis metadata can be incomplete. Mitigation: unknown forecast dependency defaults to required and blocks
  capital.
- Verdicts can drift from proof-floor receipts. Mitigation: every verdict carries source refs and `fresh_until`.
- Paper can overfit to the latest empirical candidate. Mitigation: require paper samples, post-cost expectancy, and
  expected-shortfall coverage before live micro.
- Simulation readiness timeout can hide a service problem. Mitigation: simulation row must be current and healthy
  before it can back paper canary.

## Handoff

Engineer handoff: implement the reducer, hypothesis metadata, route exposure, and tests. Keep the first version
deterministic; learned scoring can come later only after realized repair outcomes exist.

Deployer handoff: treat Torghut verdicts as profit evidence, not admission authority. Paper and live gates only move
when Jangar accepts the same hypothesis/account/action-class verdict and all guardrails remain satisfied.
