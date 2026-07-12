# 121. Torghut Evidence Debt Tranches And Profit Unblock Ladder (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

I am selecting a **Torghut evidence-debt tranche publisher with a profit unblock ladder** as the companion design to
Jangar's material-action unblock ledger.

The current Torghut state is not a simple outage. In the read-only sample at `2026-05-06T13:09Z`, the live route had
healthy Postgres, ClickHouse, Alpaca, scheduler, and universe checks. `/db-check` returned HTTP `200` with
`schema_current=true`, `schema_graph_lineage_ready=true`, and `account_scope_ready=true`. The active live and sim
Knative revisions were ready, and Argo CD reported `torghut` `Synced` and `Healthy`.

The route still is not capital-grade. Live `/readyz` and `/trading/health` returned HTTP `503` because
`simple_submit_disabled` holds live submission in `capital_stage=shadow`. Alpha readiness had `hypotheses_total=3`,
`promotion_eligible_total=0`, and `rollback_required_total=3`. `/trading/autonomy` showed stale empirical jobs
`benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`, all tied to
`torghut-full-day-20260318-884bec35`. The live quant route was reachable but stale by `70873` seconds. The sim route
was paper-ready but quant proof was empty. Market context for `AAPL` was reachable and configured, but technicals,
fundamentals, news, and regime were stale. The quant alert route had `50` open alerts.

The selected design makes Torghut publish debt tranches that Jangar can rank and retire. Each tranche states which
capital action it blocks, which proof surface must be refreshed, what trading hypothesis it protects, how much profit
option value it may unlock, and which receipt retires it. This lets Torghut repair stale proof without asking Jangar
to loosen live capital gates.

The tradeoff is stricter paperwork before capital reentry. I accept that because the target is profitable autonomy,
not just service availability. A paper or live promotion should be able to point to fresh empirical proof, fresh quant
metrics, fresh market context, a paper settlement record, and a Jangar unblock receipt.

## Evidence Snapshot

All checks were read-only. No database rows, Kubernetes resources, trading flags, broker state, or GitOps manifests
were changed.

### Runtime And Data Evidence

- Argo CD reported `torghut` `Synced` and `Healthy` at revision `84739fac65e8eaf8d82922ca2f605c262c182ef9`.
- Live revision `torghut-00237` was `1/1` available on the current Torghut image digest.
- Sim revision `torghut-sim-00326` was `1/1` available on the same Torghut image digest.
- Live TA, sim TA, options TA, options catalog, options enricher, websocket, ClickHouse, Keeper, Postgres, Alloy, and
  Symphony pods were Running.
- Recent events showed sim rollout startup/readiness misses that cleared, a successful sim runtime analysis, and
  duplicate ClickHouse PodDisruptionBudget warnings.
- Direct CNPG shell access was blocked by RBAC, so portable validation must use `/db-check`, `/readyz`,
  `/trading/health`, `/trading/autonomy`, and Jangar-owned proof projections.

### Schema And Readiness Evidence

- `/db-check` returned HTTP `200` with `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, no missing heads, no unexpected heads, and lineage ready.
- Known Alembic parent-fork warnings remained for `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`; they are warnings, not missing schema heads.
- Live `/readyz` returned HTTP `503` with `status=degraded`.
- Live dependencies were locally healthy: Postgres `ok`, ClickHouse `ok`, Alpaca `broker_ok`, scheduler running, and
  universe source `jangar_cache_hit` with `12` symbols.
- Live submission was blocked by `simple_submit_disabled`; `capital_stage=shadow`; configured live promotion was
  false.
- Live quant evidence was informational because the live route reported `quant_health_not_configured`, while Jangar's
  typed route showed the live account metrics were stale.
- Sim `/readyz` returned HTTP `200` and `live_submission_gate.allowed=true` for `non_live_mode`, but sim quant
  evidence was degraded with `latestMetricsCount=0`, `emptyLatestStoreAlarm=true`, and no stages.

### Profit Evidence

- Empirical jobs were stale: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.
- The stale empirical snapshot was `torghut-full-day-20260318-884bec35`; candidate id was `intraday_tsmom_v1@prod`.
- Jangar typed quant health for live account `PA3SX7FYNUTF` had `latestMetricsCount=108`, but latest metrics were
  from `2026-05-05T17:28:03.839Z` and lagged by `70873` seconds.
- Jangar typed quant health for `TORGHUT_SIM` had `latestMetricsCount=0` and an empty latest-store alarm.
- Jangar market-context health for `AAPL` had `overallState=degraded`, `bundleFreshnessSeconds=147028`, and stale
  technicals, fundamentals, news, and regime domains.
- Jangar quant alerts had `50` open alerts: `37` critical metrics-pipeline lag alerts, `12` TA freshness warnings,
  and `1` Sharpe warning.

## Problem

Torghut has several useful proof surfaces, but they do not yet publish a single repair contract that Jangar can use to
retire material-action debt.

The route can say database and dependencies are healthy. The autonomy route can say empirical jobs are stale. Jangar
can say quant metrics and market context are stale. The submission council can say live submission is disabled. Those
are all true. What is missing is the trading-specific debt object that says:

1. which hypothesis or account is blocked;
2. which proof surface must be refreshed;
3. which Jangar action classes stay blocked;
4. which zero-notional repair is safe to run;
5. what measurable outcome retires the debt;
6. what profit option value may be unlocked.

Without this, Jangar can only hold or block. With it, Jangar can safely prioritize empirical refresh, quant pipeline
materialization, market-context rehydration, and paper settlement before any live capital.

## Alternatives Considered

### Option A: Re-run All Stale Empirical Jobs First

Pros:

- Targets the current dependency-quorum blocker directly.
- Simple to explain and audit.
- Keeps live capital disabled while proof refresh runs.

Cons:

- Does not address empty sim quant proof.
- Does not address stale market context.
- May refresh empirical artifacts for a hypothesis that still cannot pass paper settlement.
- Does not give Jangar an action-class ledger.

Decision: reject as the full architecture. Keep it as one high-priority repair tranche.

### Option B: Enable Paper Or Live Based On Local Torghut Health

Pros:

- Uses the fact that Postgres, ClickHouse, Alpaca, scheduler, and universe checks are currently healthy.
- Would reduce friction for paper experimentation.
- Small implementation surface.

Cons:

- Ignores stale empirical jobs, empty sim quant proof, stale live metrics, stale market context, and open quant alerts.
- Conflates route availability with proof freshness.
- Creates an unsafe path from HTTP health to capital action.

Decision: reject. Local readiness is an input, not capital authority.

### Option C: Evidence-Debt Tranche Publisher With Profit Unblock Ladder

Pros:

- Separates empirical, quant, market-context, paper-settlement, and live-submission debt.
- Lets Jangar keep capital at zero while allowing zero-notional repair.
- Ranks repairs by expected profit unlock and action unblock value.
- Produces clear closure receipts before paper, micro-live, or scale.
- Makes profitability hypotheses measurable instead of aspirational.

Cons:

- Requires Torghut to publish more structured proof metadata.
- Expected profit unlock is an estimate until paper settlement exists.
- Needs guardrails so stale historical alerts do not permanently block new proof.

Decision: select Option C.

## Architecture

Torghut publishes two projections for Jangar.

```text
torghut_evidence_debt_tranche
  tranche_id
  generated_at
  expires_at
  account
  strategy_id
  candidate_id
  dataset_snapshot_ref
  debt_type                     # empirical_stale, quant_metrics_stale, market_context_stale,
                                # paper_settlement_missing, live_submission_disabled, quant_alert_open
  blocked_capital_stage         # observe, shadow, paper, live_micro, live_scale
  blocked_jangar_actions        # paper_canary, live_micro_canary, live_scale, merge_ready
  repair_mode                   # empirical_refresh, quant_materialize, market_context_rehydrate,
                                # paper_settlement, submission_gate_config
  expected_profit_unblock_value
  evidence_age_seconds
  required_closure_metrics
  safety_cap                    # zero_notional, paper_only, live_micro
```

```text
torghut_profit_unblock_receipt
  receipt_id
  generated_at
  expires_at
  retired_tranche_ids
  account
  strategy_id
  capital_stage
  empirical_refs
  quant_refs
  market_context_refs
  paper_settlement_refs
  jangar_unblock_receipt_ref
  max_notional
  rollback_target
  decision                      # observe, paper_allowed, live_micro_allowed, live_scale_allowed, block
```

These projections are not order instructions. They are authority inputs for Jangar. The only repair actions allowed
before closure are zero-notional or paper-only, and each must cite its target tranche id.

## Measurable Trading Hypotheses

- H1: Refreshing the four stale empirical jobs against the current dataset will clear
  `empirical_jobs_degraded` and move at least one hypothesis from shadow to paper-eligible. Success means no stale
  empirical jobs, `promotion_eligible_total > 0`, and no new rollback-required hypothesis from the refresh.
- H2: Repairing quant materialization will reduce open quant alerts from `50` to `<=5`, make live 15-minute metrics
  lag `<=120` seconds, and make `TORGHUT_SIM` `latestMetricsCount > 0`.
- H3: Rehydrating market context for the selected universe will move top-symbol health from `degraded` to `ok`, with
  technicals and regime freshness under `120` seconds, news under `300` seconds, and fundamentals under `86400`
  seconds where provider data exists.
- H4: Paper settlement should stay zero live-notional until a full paper session proves positive after-cost PnL,
  drawdown inside policy, and no critical quant lag alerts.

## Guardrails

- Live `max_notional` stays `0` while `simple_submit_disabled` is present.
- Paper canary requires fresh empirical proof and non-empty sim quant metrics.
- Live micro-canary requires a Jangar material-action unblock receipt and a Torghut profit unblock receipt.
- Live scale requires a fresh paper settlement receipt and no open high-severity market-context or quant freshness
  tranches.
- Historical resolved alerts should not block capital; open alerts tied to current account, strategy, or universe do.
- A schema-current `/db-check` is necessary but never sufficient for capital.

## Implementation Scope

Torghut engineer stage:

1. Add a debt-tranche builder to the submission council or readiness assembly layer.
2. Emit tranches for stale empirical jobs, empty sim quant proof, stale live quant metrics, stale market context, open
   quant alerts, and live submission disabled.
3. Attach hypothesis, account, candidate, dataset, evidence age, repair mode, and expected profit-unblock metadata.
4. Add tests that current sampled evidence creates separate tranches instead of one broad degraded state.
5. Add a proof-unblock receipt only when the closure metrics are fresh.

Jangar engineer stage:

1. Consume Torghut tranches in the Jangar debt ledger.
2. Keep action SLO budgets aligned with tranche decisions.
3. Reject any capital receipt that does not cite fresh empirical, quant, market-context, paper settlement, and
   rollback evidence.

## Validation Gates

- `/db-check` remains HTTP `200`, schema-current, and lineage-ready.
- `/trading/autonomy` reports no stale required empirical jobs before paper canary.
- Jangar quant health for live and sim accounts reports recent metrics, with live lag `<=120` seconds and sim
  `latestMetricsCount > 0`.
- Jangar market-context health for the selected universe reports fresh domains under their max freshness thresholds.
- Open current-scope quant alerts are `<=5` and contain no critical pipeline-lag alert before paper.
- Live `/trading/health` can remain HTTP `503` while `capital_stage=shadow`; that is expected until live submission
  is deliberately enabled by receipt.

## Rollout

1. Publish tranches in observe-only mode and compare them to existing live/sim health payloads.
2. Let Jangar read the tranches and surface a ranked repair plan without changing action decisions.
3. Require paper repair jobs to cite a tranche id.
4. Require paper canary to cite retired empirical, quant, and market-context tranches.
5. Require live micro-canary to cite a Jangar unblock receipt and keep max notional explicitly capped.

## Rollback

If tranche publishing is wrong or noisy, disable Jangar consumption and fall back to existing Torghut health,
dependency quorum, and action SLO budgets. Keep live submission disabled and live notional at `0`. If a tranche is
mistakenly retired, reopen it, expire its profit unblock receipt, and require a new paper settlement before any capital
promotion.

## Handoff

Torghut owns tranche publication and closure metrics. Jangar owns material-action authority. Deployer owns read-only
validation that tranches match live health, sim health, Jangar quant health, market context, and autonomy payloads.

The acceptance standard is narrow: no paper or live capital action should be allowed unless all blocking Torghut
tranches for that action are retired by current receipts and Jangar has issued a matching material-action unblock
receipt.
