# 50. Torghut Submission Parity Council and Options Bootstrap Escrow (2026-03-19)

Status: Approved for implementation (`plan`)
Date: `2026-03-19`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impact: `torghut-quant`

Companion documents:

- `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
- `49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md`

## Executive summary

The runtime on `2026-03-19` still allows contradictory profitability states:

- `GET /trading/status` reports `live_submission_gate.allowed = true` and `capital_stage = "0.10x canary"`;
- the same payload reports `hypotheses_total = 3`, `state_totals.shadow = 3`, and `promotion_eligible_total = 0`;
- Jangar quant health reports `latestMetricsCount = 0` and no active materialization stages;
- Jangar market-context health reports `overallState = "down"` with stale bundle freshness;
- options-lane services fail before readiness because DB rate-bucket defaults are written during module import and the
  current credential for `torghut_app` is rejected;
- `torghut-options-ta` cannot even pull its image digest.

The selected architecture introduces a **Submission Parity Council** that becomes the only place allowed to emit live
capital truth. It also introduces **Profit Cells** so hypotheses degrade locally instead of globally, and an
**Options Bootstrap Escrow** so options-lane failures surface as explicit readiness state instead of import-time
crashes.

## Live assessment snapshot

### Cluster and runtime evidence

Read-only evidence collected on `2026-03-19`:

- `curl -fsS http://torghut.torghut.svc.cluster.local/readyz`
  - database contract reports `schema_current = true`
  - expected head is `0024_simulation_runtime_context`
  - lineage warnings remain for migration forks at `0010` and `0015`
  - `live_submission_gate.ok = true`
  - `capital_stage = "0.10x canary"`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status`
  - `promotion_eligible_total = 0`
  - `capital_stage_totals.shadow = 3`
  - `live_submission_gate.allowed = true`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?...`
  - `status = "degraded"`
  - `latestMetricsCount = 0`
  - `stages = []`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/alerts?...`
  - critical open alerts for `metrics_pipeline_lag_seconds` across `1m`, `5m`, `15m`, `1h`, `1d`, `5d`, and `20d`
  - open warning alert for negative `sharpe_annualized`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA`
  - `overallState = "down"`
  - `bundleFreshnessSeconds = 275280`
  - ClickHouse ingestion shows `clickhouse_query_failed`
  - fundamentals and news are stale; technicals and regime are `error`
- `kubectl -n torghut logs pod/torghut-options-catalog-...`
  - `password authentication failed for user "torghut_app"`
- `kubectl -n torghut logs pod/torghut-options-enricher-...`
  - same DB auth failure
- `kubectl -n torghut get pod torghut-options-ta-... -o jsonpath=...`
  - image pull fails with digest `not found`

Interpretation:

- Torghut has healthy schema state but unhealthy profitability evidence state.
- Current capital truth is too permissive because it is synthesized in multiple places.
- Options-lane bootstrap failures are currently polluting profitability readiness through crashes instead of explicit
  cell state.

### Source architecture and test gaps

Relevant source seams:

- `services/torghut/app/main.py`
  - `_build_live_submission_gate_payload(...)` already composes dependency quorum, empirical readiness, and DSPy
    readiness, but it still does not own every data-freshness and options-bootstrap input needed for capital truth.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - `_live_submission_gate()` remains a separate implementation that only inspects runtime settings and autonomy flags;
    it does not consume the richer inputs used by `/readyz` and `/trading/status`.
- `services/torghut/app/trading/hypotheses.py`
  - hypothesis summaries already carry dependency and continuity signals, but they are not promoted into one durable
    capital-decision record with expiry and evidence refs.
- `services/torghut/app/trading/completion.py`
  - completion aggregation still flattens `continuity_ok` and `dependency_allow` across windows, which is too lossy for
    lane-local guardrails.
- `services/torghut/app/options_lane/catalog_service.py` and `services/torghut/app/options_lane/enricher_service.py`
  - repository construction plus `ensure_rate_bucket_defaults(...)` at import time converts DB auth drift into boot
    failure before readiness or status can explain the lane state.

Current test gaps:

- no parity test that proves `/readyz`, `/trading/status`, and the live scheduler return the same gate decision for the
  same hypothesis summary and evidence inputs;
- no regression that proves `promotion_eligible_total = 0` and `latestMetricsCount = 0` cannot yield live-capital
  authorization;
- no options-lane startup regression proving DB auth/image failures are published as explicit bootstrap state instead of
  crashing the process at import time;
- no completion-trace regression that preserves distinct continuity dimensions when only one lane is degraded.

## Problem statement

Torghut still has four control contradictions:

1. capital truth is synthesized in multiple places;
2. schema health is treated too generously relative to evidence freshness;
3. options-lane bootstrap failures are not isolated as a dedicated readiness dimension;
4. hypothesis profitability and continuity are not yet evaluated as lane-local profit cells with explicit expiry.

If we do not change this, rollouts will keep oscillating between over-blocking and silent over-permissiveness.

## Alternatives considered

### Option A: retune the existing thresholds and keep separate gate implementations

Pros:

- smallest code change
- preserves current APIs

Cons:

- the scheduler/status contradiction remains possible
- options lane still fails before publishing readiness
- no single audit artifact exists for capital promotion

Decision: rejected.

### Option B: fail closed globally whenever any Torghut surface is degraded

Pros:

- simple safety posture
- easy to reason about operationally

Cons:

- too coarse for mixed-state profitability systems
- options bootstrap or collaboration incidents would freeze unrelated equity hypotheses
- contradicts the goal of explicit failure-mode reduction

Decision: rejected.

### Option C: submission parity council with profit cells and options bootstrap escrow

Pros:

- one gate implementation for status, readiness, and runtime
- lane-local degradation and promotion rules
- explicit bootstrap failure semantics for the options lane
- measurable hypothesis contracts tied to evidence bundles

Cons:

- requires new persistence and a small runtime refactor
- demands disciplined ownership of data-quorum inputs

Decision: selected.

## Decision

Adopt **Option C**.

Capital truth must become a durable, evidence-backed decision rather than an emergent property of multiple status
surfaces.

## Proposed architecture

### 1. Submission Parity Council

Create one pure-function module, for example `app/trading/submission_council.py`, that is imported by:

- `/readyz`
- `/trading/status`
- `TradingPipeline._live_submission_gate()`
- any future promotion or deployer validation scripts

Inputs:

- hypothesis summary
- quant latest-store health
- quant alert snapshot
- market-context health bundle
- empirical-job status
- DSPy runtime status
- execution-cell inputs from Jangar
- options bootstrap status

Outputs:

- `allowed`
- `capital_state`
- `reason_codes`
- `expires_at`
- `required_cells`
- `evidence_bundle_ref`

No other path may synthesize a more permissive capital state.

### 2. Profit cells keyed by hypothesis, lane, and account

Persist `profit_cells` with one row per:

- `hypothesis_id`
- `strategy_family`
- `account`
- `lane_id`

Each profit cell records:

- `data_quorum_state`
- `performance_window_state`
- `continuity_state`
- `capital_state`
- `expires_at`
- `reason_codes`
- `evidence_bundle_ref`

Required first-wave cells:

- `H-CONT-01` continuation cell
- `H-MICRO-01` microstructure cell
- `H-REV-01` reversal cell
- `options-bootstrap` cell for options-only hypotheses

### 3. Measurable hypothesis policies and guardrails

The council must evaluate measurable windows before authorizing anything above `observe`.

Required baseline policy for all cells:

- `promotion_eligible_total > 0`
- `latestMetricsCount > 0`
- no open critical `metrics_pipeline_lag_seconds` alert for the evaluation window
- `market_context.overallState != "down"`
- no required execution cell in `blocked` state

Cell-specific default thresholds:

- `H-CONT-01`
  - signal continuity healthy
  - market-context bundle freshness `< 900s`
  - average post-cost expectancy `> 2bps` across the last 3 market sessions
  - average absolute slippage `< 8bps`
- `H-MICRO-01`
  - route coverage `>= 95%`
  - empirical decision alignment ratio `>= 0.70`
  - no continuity alert in the last 2 evaluation windows
- `H-REV-01`
  - market-context bundle freshness `< 600s`
  - no open negative Sharpe alert on the active evaluation horizon
  - reject ratio `<= 3%`

Promotion states:

- `observe`
- `0.10x canary`
- `0.25x canary`
- `0.50x live`
- `1.00x live`
- `quarantine`

If a required freshness or bootstrap condition fails, the cell falls back to `observe` or `quarantine` even when
schema state remains healthy.

### 4. Options bootstrap escrow

Options services must stop touching the database at import time.

Required changes:

- move `ensure_rate_bucket_defaults(...)` out of module import and into a startup/bootstrap phase;
- publish `options_bootstrap_status` with explicit states:
  - `pending`
  - `db_auth_failed`
  - `image_unavailable`
  - `schema_missing`
  - `ready`
- wire `options_bootstrap_status` into the submission council as a separate required input for options-only profit
  cells.

This isolates options failures to options cells while making the failure auditable and testable.

### 5. Evidence bundles and expiry

Every council decision must reference one immutable evidence bundle containing:

- the hypothesis summary snapshot
- the quant-health payload
- the alert snapshot
- the market-context bundle summary
- the options bootstrap payload
- the Jangar execution-cell refs used for the decision

Decisions expire on window boundaries. If no fresh evidence renews the bundle, capital falls back one stage rather than
staying implicitly authorized.

### 6. Completion-trace continuity dimensions

Completion and profitability traces must keep at least these distinct dimensions:

- `dependency_quorum_ok`
- `signal_continuity_ok`
- `evidence_continuity_ok`
- `market_context_quorum_ok`
- `options_bootstrap_ok`

`continuity_ok` becomes a derived summary only. That keeps demotion logic lane-local and debuggable.

## Validation gates

Engineer gates:

- add parity tests for the submission council used by:
  - `services/torghut/app/main.py`
  - `services/torghut/app/trading/scheduler/pipeline.py`
- add regression proving `promotion_eligible_total = 0` plus `latestMetricsCount = 0` blocks any state above
  `observe`
- add options-lane startup tests proving DB auth and image failures surface as bootstrap state instead of import-time
  crashes
- add completion-trace tests that preserve distinct continuity subfields

Deployer gates:

- no canary or live promotion while any required critical quant lag alert remains open;
- no canary or live promotion while `market_context.overallState = "down"`;
- options capital remains `observe` whenever `options_bootstrap_status != ready`;
- one forced rollback from `0.10x canary` to `observe` or `quarantine` must persist the evidence bundle and council
  decision that triggered the rollback.

## Rollout plan

1. Add the submission council in mirror mode and emit advisory decisions into status.
2. Add profit-cell persistence and options bootstrap status without changing capital authorization.
3. Switch `/readyz` and `/trading/status` to council-backed responses.
4. Switch `TradingPipeline` to consume the council result.
5. Enable canary rollout only after parity tests and a forced demotion drill pass.

## Rollback plan

If council-driven capital gating is too noisy:

- keep writing council decisions and profit-cell rows;
- revert runtime authorization to advisory mode;
- preserve all evidence bundles for replay and threshold tuning.

Do not delete profit-cell rows during rollback. They are the audit record for capital decisions.

## Risks and tradeoffs

- Profit cells add persistence and policy surface area.
- Poorly tuned thresholds could block too much capital.
- Options bootstrap escrow creates another explicit subsystem to operate.

Mitigations:

- ship in advisory mirror mode first;
- start with the three current hypothesis ids and options bootstrap only;
- keep thresholds in versioned policy files and require evidence-bundle references for any override.
