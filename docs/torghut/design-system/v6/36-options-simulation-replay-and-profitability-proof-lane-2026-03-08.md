# 36. Options Simulation, Replay, and Profitability Proof Lane (2026-03-08)

## Status

- Date: `2026-03-08`
- Maturity: `implementation-ready design`
- Scope: `services/torghut/scripts/**`, `services/torghut/app/trading/**`,
  `services/torghut/app/options_lane/**`, `argocd/applications/torghut/**`,
  simulation Postgres/ClickHouse/Kafka assets, and artifact generation for options
  evidence
- Depends on:
  `33-alpaca-options-market-data-and-technical-analysis-lane-2026-03-08.md`,
  `34-alpaca-options-lane-implementation-contract-set-2026-03-08.md`, and
  `35-alpaca-options-production-hardening-and-opra-promotion-2026-03-08.md`
- Primary objective: extend Torghut's historical simulation and proof workflow from
  equity-only runtime assumptions to a deterministic options replay lane that can
  generate profitability evidence before live options trading is allowed
- Non-goals: live options order routing, assignment automation, or full
  multi-broker abstraction

## Executive Summary

Torghut already has strong simulation machinery, but it is still equity-shaped. The
historical simulation entrypoints, verification logic, and report generators are all
hard-coded around equity topics and the equity ClickHouse tables
`ta_microbars` / `ta_signals`. At the same time, the new options lane already has the
beginnings of replay support in source: Alpaca historical option bars exist in the
client, and the options control plane already reserves a `bars_backfill` rate bucket.

That mismatch creates a dangerous gap. Torghut can ingest options data in production,
yet it still cannot prove an options strategy against a deterministic replay lane
using the same discipline it now expects for equities.

This document closes that gap:

- options replay becomes an extension of the existing historical simulation system,
  not a side notebook workflow;
- replay datasets are assembled from raw options topics plus provider backfill
  artifacts, not from current-state tables alone;
- simulation topics, tables, manifests, and reports become asset-lane aware;
- profitability proof requires contract-aware transaction-cost and lifecycle evidence,
  not only gross PnL.

## Context

The market-data lane is necessary but not sufficient. Production options trading
without a replay and proof lane would create the exact anti-pattern Torghut already
learned to avoid in the equity system: runtime confidence without empirical
promotion evidence.

Options make this even more important because replay correctness is harder:

- contracts expire and disappear;
- liquidity is sparse and spread-driven;
- raw quotes often matter more than prints;
- open interest, Greeks, and IV matter to strategy logic and cost modeling;
- the replay universe must preserve both contract-level and underlying-level truth.

That means the options replay lane must be contract-aware from ingest to artifact,
not just "another table copy."

## Verified Current State

### Historical simulation entrypoints are equity-only

[`services/torghut/scripts/start_historical_simulation.py`](services/torghut/scripts/start_historical_simulation.py)
defines only equity production and simulation topic families:

- `torghut.trades.v1`
- `torghut.quotes.v1`
- `torghut.bars.1m.v1`
- `torghut.ta.bars.1s.v1`
- `torghut.ta.signals.v1`
- `torghut.trade-updates.v1`

and their `torghut.sim.*` equivalents.

The same file fixes simulation ClickHouse runtime tables to
`('ta_microbars', 'ta_signals')`, and later wires:

- `TRADING_SIGNAL_TABLE=<db>.ta_signals`
- `TRADING_PRICE_TABLE=<db>.ta_microbars`

That is a direct proof that the current replay path cannot host options-derived
signals without design work.

### Verification and report tooling are still bound to equity tables and topics

[`services/torghut/scripts/historical_simulation_verification.py`](services/torghut/scripts/historical_simulation_verification.py)
checks only the equity topic family and only accepts ClickHouse isolation when:

- the signal table ends in `.ta_signals`
- the price table ends in `.ta_microbars`

[`services/torghut/scripts/analyze_historical_simulation.py`](services/torghut/scripts/analyze_historical_simulation.py)
queries `FROM {clickhouse_db}.ta_microbars` for price reconstruction and does not
look at any options-derived table family.

### The options lane has partial backfill plumbing, but not an end-to-end replay path

[`services/torghut/app/options_lane/alpaca.py`](services/torghut/app/options_lane/alpaca.py)
already defines `get_option_bars(...)`.

[`services/torghut/app/options_lane/catalog_service.py`](services/torghut/app/options_lane/catalog_service.py)
and
[`services/torghut/app/options_lane/enricher_service.py`](services/torghut/app/options_lane/enricher_service.py)
both initialize a `bars_backfill` rate bucket.

But repository search shows no current caller for `get_option_bars(...)`, so Torghut
does not yet have a working historical options backfill or replay reconstruction
path.

### Dataset selection and proof workflows still assume an equity universe

[`services/torghut/app/trading/llm/dspy_compile/dataset.py`](services/torghut/app/trading/llm/dspy_compile/dataset.py)
recognizes `torghut:equity:enabled`, but there is no options universe selector or
contract-set selector.

That means the current dataset compiler cannot express:

- an underlying universe for options,
- a contract filter policy,
- an expiry or DTE band,
- a call/put mix, or
- a hot-set snapshot for replay reproducibility.

## Design Decision

### Decision 1: no live options capital before replay proof exists

Options strategy or execution work may not be promoted ahead of a replay lane that
can reproduce inputs, outputs, and profitability evidence. The replay lane is a gate,
not a nice-to-have.

### Decision 2: extend the existing historical simulation framework instead of forking it

Torghut already has:

- simulation namespace wiring,
- rollout analysis support,
- verification gates,
- artifact bundles, and
- post-run reporting.

The correct move is to make that framework asset-lane aware, not to create a second,
options-only proof workflow that drifts immediately.

### Decision 3: the canonical replay input is raw market data plus versioned backfill artifacts

Replays must be reconstructable from:

- raw options topic dumps when the window is inside Kafka retention,
- Alpaca historical bars and snapshot artifacts when the window falls outside Kafka
  retention,
- the contract catalog snapshot that was valid for the window,
- the underlying equity price context used by the features.

Derived ClickHouse tables are a useful verification source, but not the only source
of truth for replay construction.

### Decision 4: profitability proof is contract-aware, not equity-PnL-with-different-symbols

Any options proof must account for:

- contract multiplier,
- quoted spread and fill side,
- open/close direction,
- DTE bucket,
- expiry outcomes,
- stale or missing Greeks/snapshots,
- underlying concentration.

Gross return without these controls is not an acceptable promotion metric.

## Selected Architecture

### Replay components

The replay lane introduces five implementation units:

| Component | Type | Responsibility |
| --- | --- | --- |
| `torghut-options-dataset-builder` | script / batch job | Build a reproducible dataset bundle for one options simulation window |
| `torghut-options-ta-replay` | replay workflow extension | Rehydrate raw options topics into `torghut.sim.options.*` topics |
| `torghut-options-ta-sim` | Flink simulation job | Materialize options simulation derived topics and ClickHouse tables |
| `torghut-options-simulation-verifier` | script extension | Verify topic coverage, table isolation, contract coverage, and replay fidelity |
| `torghut-options-simulation-report` | report generator extension | Produce profitability, liquidity, spread, and lifecycle artifacts |

### Dataset bundle layout

Each options replay window produces an artifact root:

`artifacts/torghut/simulations/options/<run-id>/`

Required bundle contents:

- `manifest.json`
- `contract_catalog.jsonl`
- `raw/contracts.jsonl`
- `raw/trades.jsonl`
- `raw/quotes.jsonl`
- `raw/snapshots.jsonl`
- `raw/status.jsonl`
- `backfill/option-bars.jsonl`
- `backfill/underlying-bars.jsonl`
- `validation/coverage.json`
- `reports/profitability.json`
- `reports/liquidity.json`
- `reports/pnl-by-underlying.csv`
- `reports/pnl-by-expiry.csv`
- `reports/pnl-by-dte-band.csv`

### Replay flow

1. Load a versioned simulation manifest.
2. Resolve the underlying universe and contract-selection policy for the requested
   window.
3. Pull raw topic data from Kafka when retention permits.
4. Fill older gaps with Alpaca historical option bars and snapshot artifacts.
5. Materialize a frozen contract catalog snapshot for the window.
6. Rehydrate the dataset into `torghut.sim.options.*` topics.
7. Run `torghut-options-ta-sim` to produce derived options simulation tables.
8. Execute verification and profitability analysis against the isolated simulation
   assets.

### Asset-lane generalization of the existing simulation system

The current historical simulation framework remains the control shell, but it gains a
top-level lane selector:

- `lane=equity`
- `lane=options`

The lane determines:

- topic families,
- ClickHouse table families,
- manifest validation rules,
- replay source requirements,
- report sections and cost model hooks.

This lets Torghut preserve one simulation operating model while still having
asset-aware contracts.

## Interfaces and Data Contracts

### Options simulation topic family

The replay lane introduces the isolated topic namespace:

- `torghut.sim.options.contracts.v1`
- `torghut.sim.options.trades.v1`
- `torghut.sim.options.quotes.v1`
- `torghut.sim.options.snapshots.v1`
- `torghut.sim.options.status.v1`
- `torghut.sim.options.ta.contract-bars.1s.v1`
- `torghut.sim.options.ta.contract-features.v1`
- `torghut.sim.options.ta.surface-features.v1`
- `torghut.sim.options.ta.status.v1`
- `torghut.sim.options.trade-updates.v1`

These are the simulation analogues of the live options topics from document 34.

### Options simulation ClickHouse tables

Simulation ClickHouse tables are isolated from live production tables:

- `sim_options_contract_bars_1s`
- `sim_options_contract_features`
- `sim_options_surface_features`

`TRADING_SIGNAL_TABLE` and `TRADING_PRICE_TABLE` for options simulation must point to
these tables, not to live options tables and not to equity simulation tables.

### Options simulation manifest

Each replay run is defined by `torghut.options-simulation-manifest.v1`.

Required fields:

| Field | Type | Notes |
| --- | --- | --- |
| `schema_version` | `string` | fixed to `torghut.options-simulation-manifest.v1` |
| `lane` | `string` | must equal `options` |
| `feed` | `string` | `indicative` or `opra` |
| `window.start` | `timestamp` | inclusive UTC start |
| `window.end` | `timestamp` | exclusive UTC end |
| `underlyings` | `array<string>` | underlying symbol set or selector |
| `contract_policy` | `object` | DTE, expiry, call/put, strike-distance, and liquidity filters |
| `catalog_snapshot_ref` | `string` | immutable contract snapshot artifact |
| `raw_source_policy` | `object` | Kafka-retention vs provider-backfill rules |
| `cost_model` | `object` | spread crossing, fee, multiplier, and fill assumptions |
| `proof_gates` | `object` | coverage, minimum fills, minimum contracts, and artifact thresholds |

### Profitability report contract

`reports/profitability.json` must include:

- gross PnL
- net PnL
- spread cost
- slippage cost
- fee cost
- fill-rate
- quote-staleness rate
- contract-count
- underlying-count
- expiry-distribution
- DTE-band distribution
- max drawdown
- win rate
- Sharpe-like risk summary

Each metric must be reported both overall and by:

- underlying
- expiry date
- option type
- DTE band

## Failure Modes and Ops

### Survivorship bias

Replay must use the window-valid contract catalog snapshot, not the currently active
catalog. Otherwise expired contracts disappear and the proof becomes optimistic.

### Backfill incompleteness outside Kafka retention

If a replay window depends on provider backfill and the required bars or snapshots are
missing, the run fails. It does not silently degrade to a partial proof.

### Underlying-price mismatch

Options replay requires the underlying price context used by feature generation. A run
that replays options contracts without matching underlying bars is invalid.

### Cost-model optimism

If the replay report cannot prove spread, fill, and multiplier assumptions, the proof
is not promotion-grade even if gross PnL is positive.

## Rollout Phases

### Phase 1: lane-aware simulation framework

- generalize the historical simulation manifest and topic/table routing by lane
- add options topic and table families
- isolate options simulation resources from live resources

### Phase 2: dataset and backfill builder

- implement the options dataset builder
- wire Alpaca historical option bars into replay artifact generation
- freeze contract catalog snapshots per run

### Phase 3: verifier and report extension

- extend verification to options topics/tables
- extend reporting to options profitability and liquidity metrics
- add artifact completeness gates

### Phase 4: proof runs

- run smoke replay windows
- run at least one full regular session replay
- compare replay coverage and derived-table fidelity against live-lane truth

## Acceptance Criteria

This document is complete only when all of the following are true:

- `start_historical_simulation.py` can run with `lane=options`.
- Replay assets are isolated under `torghut.sim.options.*` topics and
  `sim_options_*` tables.
- The verifier refuses to pass when contract catalog, raw topic coverage, or
  underlying context is incomplete.
- A smoke run and a full-session run both complete with reproducible manifests and
  artifact bundles.
- Profitability reports include spread, slippage, multiplier, DTE-band, and
  underlying-level attribution.
- No options strategy is allowed to request live capital without attaching one of
  these proof artifacts.
