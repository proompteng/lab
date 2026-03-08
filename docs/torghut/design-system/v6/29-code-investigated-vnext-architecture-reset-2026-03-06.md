# 29. Code-Investigated vNext Architecture Reset for Empirical Alpha and Truthful Promotion (2026-03-06)

## Status

- Date: `2026-03-06`
- Maturity: `architecture reassessment + implementation contract + proof closeout`
- Scope: `services/torghut/**`, `docs/torghut/design-system/v5/**`, `docs/torghut/design-system/v6/**`
- Primary objective: preserve Torghut's strong deterministic execution and governance core while replacing synthetic alpha and evaluation surfaces with empirical, replayable, and promotion-safe ones.
- Implementation closeout: `doc29` completion contract satisfied in recorded evidence on `2026-03-07`

## Executive Summary

Direct source inspection shows that Torghut already contains a substantial control plane:

- deterministic risk and execution-policy enforcement,
- broker and simulation adapters,
- decision, execution, and TCA persistence,
- autonomous lane orchestration,
- promotion and rollback prerequisites,
- DSPy/LLM guardrails with deterministic fail-closed behavior.

The same source inspection also shows that several surfaces that present as advanced alpha or evaluation capability are
still deterministic scaffolds rather than empirical trading machinery. The most important examples are:

- deterministic forecast routing in `services/torghut/app/trading/forecasting.py`,
- deterministic parity score generation in `services/torghut/app/trading/parity.py`,
- deterministic Janus-Q artifact generation in `services/torghut/app/trading/autonomy/janus_q.py`,
- deterministic LEAN backtest/shadow outputs in `services/torghut/app/lean_runner.py`,
- deterministic plugin-centered runtime strategy execution in `services/torghut/app/trading/strategy_runtime.py`.

The central finding is therefore:

Torghut is materially closer to a production-grade autonomous control system than to a production-grade autonomous alpha
system.

The next architecture iteration should not add more runtime autonomy first. It should:

1. keep deterministic runtime and safety controls as final authority,
2. replace synthetic evidence paths with empirical and calibrated ones,
3. move LLM value toward research, experiment generation, critique, and synthesis,
4. require promotion from one canonical strategy specification backed by truthful evidence.

This is a design for expected after-cost profitability, replayability, and capital protection. It is not a guarantee of
profit.

## Implementation update (2026-03-07)

The architecture reset described below is now closed out for the doc29 completion contract.

Landed repo work:

- explicit recorded producers now exist for `promotion_truthfulness_firewall` and
  `strategy_spec_v2_runtime_lineage`;
- replay evidence now records a fill-price error-budget report and uses it to derive `paper_gate_satisfied`;
- live `canary` and `scale` gates now derive from persisted `strategy_hypothesis_metric_windows`;
- persistent hypothesis-governance tables now back runtime windows, capital allocations, and promotion decisions;
- `/trading/completion/doc29` remains the single read surface and now derives all gates from recorded evidence.

Proof closeout:

- smoke run: `sim-2026-03-06-open-1h-r21`
- full-session replay: `sim-2026-03-06-full-day-r1`
- target window: `2026-03-06T14:30:00Z` to `2026-03-06T21:00:00Z`
- target duration: `390` minutes for the regular US equities session, not a 24-hour replay
- candidate: `intraday_tsmom_v1@prod`
- final completion status against the main Torghut DB: `9/9` satisfied, `0` blocked, `0` stale, `summary.all_satisfied=true`

Closeout scope clarification:

Doc29 completion means the truthful promotion contract is now implemented end to end. It does not require every
deterministic scaffold to be deleted from source immediately. Some scaffold producers still exist in-tree, but they are
now explicitly non-authoritative for promotion and completion gating.

## Runtime proof snapshot

The decisive full-session proving run was `sim-2026-03-06-full-day-r1` using dataset
`torghut-full-day-20260306` and candidate `intraday_tsmom_v1@prod`.

| Field | Result |
|---|---|
| Coverage | `1.0` (`PASS`) over the full `390` minute regular session |
| Trade decisions | `1145` |
| Executions | `528` |
| Execution TCA rows | `528` |
| Execution order events | `520` |
| Decision-to-execution rate | `46.1%` |
| Median absolute slippage | `0.0872` bps |
| P95 absolute slippage | `0.6614` bps |
| Max absolute slippage | `1.0015` bps |
| Fill-price budget | `within_budget` (`12` bps median budget, `25` bps p95 budget) |
| Gross PnL | `66.16` |
| Net estimated PnL | `66.16` |
| Realized PnL | `-65.18` |
| Unrealized PnL | `131.34` |
| Open lots at end of run | `258` |

The profitability interpretation matters. This run proves replay coverage, execution quality, and truthful evidence
assembly. It does not by itself prove durable live profitability. End-of-window net stayed positive because of
mark-to-market on open positions, while realized PnL for the session remained negative.

## Assessment Basis and Verification History

### Source scope

Primary code paths inspected for this reassessment:

- `services/torghut/app/trading/scheduler.py`
- `services/torghut/app/trading/strategy_runtime.py`
- `services/torghut/app/trading/execution_policy.py`
- `services/torghut/app/trading/risk.py`
- `services/torghut/app/trading/execution_adapters.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/app/trading/forecasting.py`
- `services/torghut/app/trading/parity.py`
- `services/torghut/app/trading/regime_hmm.py`
- `services/torghut/app/trading/autonomy/lane.py`
- `services/torghut/app/trading/autonomy/policy_checks.py`
- `services/torghut/app/trading/autonomy/janus_q.py`
- `services/torghut/app/trading/llm/dspy_programs/modules.py`
- `services/torghut/app/trading/llm/review_engine.py`
- `services/torghut/app/lean_runner.py`
- `services/torghut/app/models/entities.py`
- `services/torghut/app/main.py`
- `services/torghut/app/trading/alpha/{tsmom.py,search.py,data_sources.py}`

Supporting design documents inspected:

- `docs/torghut/architecture.md`
- `docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md`
- `docs/torghut/design-system/v6/13-production-gap-closure-master-plan-2026-03-03.md`
- `docs/torghut/design-system/v5/09-fully-autonomous-quant-llm-torghut-novel-alpha-system.md`

### Verified repo facts

- `services/torghut/app` contains roughly `88` Python files and roughly `60k` lines.
- `services/torghut/tests` contains roughly `81` Python test files and roughly `47k` lines.
- `services/torghut/app/trading/scheduler.py` is roughly `6.9k` lines.
- `services/torghut/app/trading/autonomy/lane.py` is roughly `5.1k` lines.
- `services/torghut/app/trading/autonomy/policy_checks.py` is roughly `5.0k` lines.
- `services/torghut/app/main.py` exposes a broad FastAPI surface for trading status, metrics, decisions, executions,
  TCA, LLM evaluation, LEAN backtests, autonomy, and whitepaper workflows.
- `services/torghut/app/models/entities.py` contains substantial persistence for strategies, decisions, executions,
  order events, research runs, research candidates, fold metrics, stress metrics, promotions, TCA metrics, and LEAN
  shadow records.

### Verification timeline

At author time on `2026-03-06`, this reassessment was source-inspection-first. That original constraint is now
historical.

The doc29 closeout on `2026-03-07` added both local validation and recorded runtime proof:

```bash
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
uv run --frozen pytest tests/test_completion_trace.py tests/test_start_historical_simulation.py \
  tests/test_signal_ingest.py tests/test_trading_pipeline.py tests/test_import_hypothesis_runtime_windows.py \
  tests/test_runtime_window_import.py tests/test_feature_parity.py tests/test_janus_q_scaffold.py \
  tests/test_lean_runner.py tests/test_run_simulation_analysis.py tests/test_autonomous_lane.py \
  tests/test_promotion_truthfulness.py -q
```

In addition, recorded proof runs were persisted through `sim-2026-03-06-open-1h-r21`,
`sim-2026-03-06-full-day-r1`, the empirical promotion bundle, and the runtime-window import path.

This document should now be read as both:

- the original architecture reset rationale, and
- a closeout record showing that the doc29 completion contract is satisfied by recorded evidence.

## Verified Current-State Assessment

### What appears genuinely strong in source today

| Area | Source evidence | Assessment |
|---|---|---|
| Runtime control loop | `services/torghut/app/trading/scheduler.py` | Broad end-to-end orchestration exists and appears production-oriented, although too large for safe iteration. |
| Risk controls | `services/torghut/app/trading/risk.py` | Deterministic risk authority appears real and should remain final authority. |
| Execution policy | `services/torghut/app/trading/execution_policy.py` | Execution policy sophistication is ahead of the alpha plane and should be preserved. |
| Adapters | `services/torghut/app/trading/execution_adapters.py` | Broker and simulation abstraction exists and is worth keeping. |
| Persistence and audit | `services/torghut/app/models/entities.py` | The lineage and audit backbone is already substantial. |
| Governance lane | `services/torghut/app/trading/autonomy/lane.py`, `services/torghut/app/trading/autonomy/policy_checks.py` | Promotion, rollback, and prerequisite orchestration are structurally real, but currently able to consume synthetic evidence. |
| LLM fail-closed posture | `services/torghut/app/trading/llm/review_engine.py`, `services/torghut/app/trading/llm/dspy_programs/modules.py` | Good safety posture for advisory use; not evidence of alpha maturity. |

### What is still scaffolded, synthetic, or contract-only

| Area | Source evidence | Why it matters |
|---|---|---|
| Forecasting | `services/torghut/app/trading/forecasting.py:1`, `_DeterministicAdapter` | Forecast-shaped artifacts can exist without trained, calibrated model inference. |
| Benchmark parity | `services/torghut/app/trading/parity.py`, `_deterministic_ratio(...)`, `generation_mode="deterministic_*"` | Promotion artifacts can look complete while remaining synthetic. |
| Janus-Q | `services/torghut/app/trading/autonomy/janus_q.py:1` | Reward and event-study evidence remain deterministic scaffolds. |
| LEAN runner | `services/torghut/app/lean_runner.py`, `_deterministic_backtest_result(...)` | Backtest/shadow surfaces can read as real while remaining placeholders. |
| Regime HMM | `services/torghut/app/trading/regime_hmm.py` | The schema and parsing surface exists, but that is not the same as a trained regime model. |
| Strategy runtime | `services/torghut/app/trading/strategy_runtime.py` | Runtime strategy logic remains plugin-oriented and deterministic rather than spec-compiled. |
| Alpha research | `services/torghut/app/trading/alpha/data_sources.py` and related modules | The current baseline is useful but too narrow and too light for production promotion authority. |

The important operational change is that these scaffolded surfaces no longer count as passing promotion evidence on the
doc29 path. They can remain in source temporarily without being allowed to silently satisfy paper or live gates.

## Central Risk

The primary risk is not the absence of a control plane. The primary risk is that a relatively mature control plane can
consume artifacts produced by deterministic placeholders and treat them as if they represented empirical trading truth.

In other words, Torghut is currently at risk of truthful governance over untruthful evidence.

That is a more important vNext concern than additional orchestration, more runtime autonomy, or broader LLM discretion.

## Design Decision

Adopt a vNext architecture reset with the following principles:

1. Runtime trading authority remains deterministic and typed.
2. The unit of autonomy is the experiment, not the trade.
3. Every promoted strategy is compiled from one canonical strategy specification.
4. Promotion depends on evidence provenance and evidence maturity, not just schema completeness.
5. Simulator calibration, paper/shadow validation, and live canary validation are separate gates.
6. LLMs are used primarily as autonomous quant researchers, critics, and synthesis agents.

## vNext Architecture

### 1. Data and feature plane

Purpose: produce replayable, contamination-safe datasets and feature views for research, evaluation, and runtime.

Keep:

- market-feed and execution-event ingestion infrastructure,
- TCA and order-event persistence,
- existing feature normalization contracts where downstream consumers already depend on them.

Add:

- immutable `dataset_snapshots`,
- versioned `feature_view_specs`,
- raw replay datasets for backtest and shadow re-simulation,
- contamination metadata covering survivorship, clock alignment, corporate actions, and train/test leakage,
- explicit feature-coverage reporting per strategy hypothesis.

Constraint:

`services/torghut/app/trading/alpha/data_sources.py` remains a convenience path only. It must not qualify a strategy for
paper or live promotion.

### 2. Research and hypothesis plane

Purpose: maximize experiment throughput without giving LLMs direct capital authority.

Allowed LLM roles:

- hypothesis proposer,
- feature and ablation assistant,
- contamination and leakage critic,
- execution and cost critic,
- experiment summarizer,
- engineering patch author in controlled branches with tests.

Output contract:

Every research-side LLM output must compile to a typed `ExperimentSpec` or `StrategySpecV2`. Narrative output alone is
never promotion evidence.

### 3. Model and forecast plane

Purpose: preserve existing typed forecast contracts while replacing deterministic producers with empirical ones.

Keep the contract shape of:

- `ForecastContractV1`
- `HMMRegimeContext`

Replace the producers behind those contracts with:

- model registry and serving,
- calibration metadata,
- regime training and inference services,
- explicit benchmark and fallback lineage.

Do not introduce first:

- direct LLM order generation,
- unrestricted web-text trading authority,
- unconstrained RL live policy learning.

### 4. Evaluation and simulation plane

Purpose: produce promotion-safe evidence.

Replace deterministic or placeholder authority in:

- `services/torghut/app/lean_runner.py`,
- `services/torghut/app/trading/parity.py`,
- `services/torghut/app/trading/autonomy/janus_q.py` where those outputs are used as promotion authority.

Required capabilities:

- event-driven historical simulation,
- fees, spreads, slippage, latency, partial fills, rejects, halts,
- borrow and short-sale constraints where applicable,
- purged walk-forward cross-validation and embargoed validation,
- stress windows anchored to real periods,
- simulator calibration from observed TCA and execution events,
- shadow/live comparator reports with explicit error budgets.

### 5. Deterministic runtime plane

Purpose: keep Torghut's strongest current capability: capital-safe execution.

Keep and strengthen:

- `RiskEngine`,
- `ExecutionPolicy`,
- order-firewall behavior,
- execution adapters,
- decision and order-event persistence,
- TCA telemetry,
- kill-switch and rollback contracts.

Reshape:

- compile strategy specifications into runtime plugins or runtime configs,
- keep LLM influence advisory-only by default,
- preserve zero policy-bypass authority for advisory outputs.

### 6. Governance and control plane

Purpose: preserve the strongest part of the current repo while preventing synthetic evidence from satisfying real
promotion gates.

Keep:

- stage manifests,
- prerequisite checks,
- rollback readiness,
- drift governance,
- audit traces.

Add:

- explicit evidence provenance,
- explicit evidence maturity,
- minimum gate requirements by promotion target,
- simulator calibration thresholds,
- shadow/live deviation thresholds,
- CI checks that fail closed when required artifacts are placeholders.

## Canonical Contracts

### `StrategySpecV2`

Minimum fields:

- `strategy_id`
- `semantic_version`
- `universe`
- `feature_view_spec_ref`
- `dataset_eligibility`
- `model_ref` or `deterministic_rule_ref`
- `signal_to_probability_transform`
- `sizing_policy_ref`
- `risk_profile_ref`
- `execution_policy_ref`
- `rebalance_cadence`
- `promotion_policy_ref`
- `replay_dependencies`

It must compile into:

- evaluator config,
- shadow runtime config,
- live runtime config,
- portfolio allocation metadata,
- promotion evidence metadata.

### `ExperimentSpec`

Minimum fields:

- `experiment_id`
- `hypothesis`
- `parent_experiment_ids`
- `target_universe`
- `dataset_snapshot_request`
- `feature_view_spec_ref`
- `model_family`
- `training_protocol`
- `validation_protocol`
- `acceptance_criteria`
- `ablations`
- `stress_scenarios`
- `llm_provenance`

### Separate provenance from maturity

The earlier single-axis authenticity model is too coarse. vNext should separate:

#### `ArtifactProvenance`

- `structural_placeholder`
- `synthetic_generated`
- `historical_market_replay`
- `paper_runtime_observed`
- `live_runtime_observed`

This answers: where did the evidence come from?

#### `EvidenceMaturity`

- `stub`
- `uncalibrated`
- `calibrated`
- `empirically_validated`

This answers: how trustworthy is the evidence for promotion?

Promotion gates must evaluate both.

## Initial Promotion Contract with Explicit Starting Thresholds

These values are intentionally conservative starting defaults. They should be moved into config and tuned from real
observations, but they must exist as explicit numbers rather than prose-only "within thresholds" language.

| Target | Minimum provenance | Minimum maturity | Minimum sample / coverage | Calibration / deviation thresholds |
|---|---|---|---|---|
| Research acceptance | `historical_market_replay` | `calibrated` | `>= 250` simulated decisions across `>= 5` purged folds | No placeholder or synthetic-generated artifact may be counted as passing evidence |
| Paper promotion | `historical_market_replay` | `calibrated` | `>= 500` simulated decisions and `100%` required benchmark-family coverage | Median simulated fill-price error budget defined for the target venue before paper starts |
| Live canary | `paper_runtime_observed` | `empirically_validated` | `>= 40` market-session samples | Shadow/live decision alignment `>= 95%`; average realized slippage must remain within the hypothesis budget |
| Live scale-up | `live_runtime_observed` | `empirically_validated` | `>= 120` market-session samples across `>= 10` sessions | Rolling post-cost expectancy `> 0`; average absolute slippage within budget for `3` consecutive windows; no active continuity or drift gate failure |

The critical rule is that placeholder evidence can still exist for scaffolding, but it must be ineligible for paper or
live promotion.

## Repo-Native Data Model Extensions

Prefer explicit models where possible, while allowing a fast JSONB bridge if migration velocity matters.

Recommended persisted additions:

- `dataset_snapshots`
- `feature_view_specs`
- `model_artifacts`
- `experiment_specs`
- `experiment_runs`
- `simulation_calibrations`
- `shadow_live_deviations`
- `promotion_decisions_v2`

If immediate speed is required, the first implementation can extend:

- `ResearchRun`
- `ResearchCandidate`
- `ResearchPromotion`

with JSONB fields for provenance, maturity, calibration summaries, and gate outcomes. The target design is still an
explicit schema.

## Recommended Source Changes

| Source area | Recommended action |
|---|---|
| `services/torghut/app/trading/scheduler.py` | Split into internal pipelines after promotion-truthfulness work is underway; keep behavior unchanged during the split. |
| `services/torghut/app/trading/forecasting.py` | Preserve contract types, replace deterministic producers with model-serving and calibration-backed producers. |
| `services/torghut/app/trading/parity.py` | Convert from synthetic report generation into report assembly over empirical benchmark outputs. |
| `services/torghut/app/lean_runner.py` | Either implement real backtest/shadow integration or rename/block the current deterministic output from promotion authority. |
| `services/torghut/app/trading/regime_hmm.py` | Keep the schema/parser role and add real regime producers elsewhere. |
| `services/torghut/app/trading/strategy_runtime.py` | Move toward `StrategySpecV2`-compiled runtime behavior instead of manual plugin-only registration. |
| `services/torghut/app/trading/autonomy/lane.py` | Preserve the orchestration skeleton but make it consume truthful evaluator outputs. |
| `services/torghut/app/trading/autonomy/policy_checks.py` | Add provenance, maturity, calibration, and shadow/live deviation checks. |
| `services/torghut/app/trading/llm/dspy_programs/modules.py` | Keep for research/advisory and typed critique, not direct execution authority. |
| `services/torghut/app/trading/llm/review_engine.py` | Keep advisory/fail-closed behavior; do not let it become proof of alpha quality. |
| `services/torghut/app/trading/alpha/*` | Expand beyond narrow offline baselines into cost-aware and portfolio-aware research families. |

## Phased Delivery Order

### Phase 0: stop synthetic promotion risk

Deliver:

- provenance and maturity enums,
- gate-policy enforcement for minimums,
- CI failures on placeholder promotion evidence.

Exit gate:

No paper or live promotion can pass while required evidence remains placeholder or synthetic-generated.

### Phase 1: canonical strategy and experiment specifications

Deliver:

- `StrategySpecV2`,
- `ExperimentSpec`,
- compiler skeleton,
- one migrated incumbent strategy.

Exit gate:

At least one existing runtime strategy compiles to evaluator and runtime targets from one source of truth.

### Phase 2: calibrated evaluator and simulator

Deliver:

- event-driven simulation,
- purged cross-validation,
- calibration metadata,
- shadow/live comparator.

Exit gate:

Simulator and shadow comparison are governed by explicit budgets, not prose-only review.

### Phase 3: replace deterministic model surfaces

Deliver:

- empirical forecast producers,
- empirical regime output producers,
- empirical parity reports.

Exit gate:

No production promotion path depends on `_DeterministicAdapter`, `_deterministic_ratio(...)`, or
`_deterministic_backtest_result(...)`.

### Phase 4: autonomous research loop

Deliver:

- research memory,
- typed experiment generation,
- LLM critique and synthesis workflows,
- experiment lineage.

Exit gate:

Experiment throughput increases without granting LLMs direct execution authority.

### Phase 5: portfolio-aware promotion and live scale-up

Deliver:

- allocator v2,
- portfolio contribution gates,
- demotion logic tied to realized post-cost evidence.

Exit gate:

Promotion decisions are portfolio-aware instead of strategy-isolated.

## Immediate Next Actions

1. Add `ArtifactProvenance` and `EvidenceMaturity` to the promotion contract and gate checks.
2. Block paper/live promotion when required evidence is placeholder or synthetic-generated.
3. Introduce `StrategySpecV2` and port `legacy_macd_rsi` and `intraday_tsmom` first.
4. Change `lean_runner.py` so deterministic outputs are clearly non-authoritative until real integration exists.
5. Start `simulation_calibrations` from observed TCA and order-event history.
6. Re-scope LLM work toward experiment generation and critique rather than runtime trade authority.
7. Split `scheduler.py` into internal pipelines only after truthfulness gates and spec compilation are underway or if the
   current file structure is directly blocking those changes.
8. Update older design docs and rollout narratives to distinguish control-plane completion from alpha-plane readiness.

## Final Recommendation

Keep Torghut's deterministic execution and governance core.

Rebuild the alpha, model, and evaluation planes around:

- replayable datasets,
- explicit feature and model lineage,
- calibrated simulation,
- empirical paper and live evidence,
- canonical strategy specifications,
- LLM-driven research automation rather than LLM runtime discretion.

That is the shortest credible path from "well-governed autonomous trading system" toward "well-governed autonomous
trading system with truthful alpha evidence".
