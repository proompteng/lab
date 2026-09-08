# Research Ledger (Experiment Tracking)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

## Purpose

Prevent accidental p-hacking and make results reproducible by tracking:

- what was tested,
- on what data,
- with what code and parameters,
- and what the outcome was.

The ledger is a key part of producing "alpha" that survives contact with production.

## Minimum Fields

- Identity:
  - `run_id` (uuid)
  - `created_at`
  - `author`

- Code + config:
  - `repo_commit`
  - `strategy_name`
  - `strategy_version`
  - `parameter_set` (json)

- Data:
  - `data_source` (Alpaca, internal replay, etc.)
  - `universe_definition` (list or rules)
  - `date_range`
  - `feature_version`

- Evaluation protocol:
  - walk-forward fold definitions
  - purging/embargo parameters
  - cost model version and parameters

- Results:
  - headline metrics (PnL, Sharpe, drawdown, turnover)
  - distribution across folds
  - sensitivity summary
  - notes on failure modes

- Multiple testing:
  - `variants_tested_count` (this is non-negotiable)
  - selection procedure description

## Where To Store

- Early phase: Postgres table (append-only) in the Torghut DB.
- Later: a dedicated analytics store or artifact system.

## Torghut Integration

- Add a `research_runs` table in Postgres.
- Add a CLI/script that:
  - creates a run record,
  - runs a backtest/simulation,
  - writes results back.

## Quality Gates

- No strategy is promoted without a ledger record.
- All published results must include fold distributions and costs.
