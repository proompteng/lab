# Data Pipeline and Features (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**
- Audit update: **2026-02-26**

## Purpose

Specify data requirements for profitable strategies and an intelligence layer.

## Data Layers

- Level 0: trades/quotes/bars (already in Torghut).
- Level 1: derived microbars and indicators (already in ClickHouse).
- Level 2: enriched features (baseline implemented; advanced factors still pending):
  - realized volatility, intraday seasonality,
  - spread/imbalance proxies,
  - market regime features,
  - cross-asset factor features.

## Audit Update (2026-02-26)

- Feature-contract/schema checks and quality/staleness controls are implemented in the trading path.
- Online/offline parity guardrails are present for current feature set.
- Remaining v2 work is expansion depth (especially richer cross-asset and optional L2/L3 feature families), not
  initial feature-contract enablement.

## Feature Parity Rule (Non-Negotiable)

If a feature is used for live decisioning, it must be:

- computable in streaming (online),
- reproducible offline with the same code and the same versioned definitions,
- timestamp-aligned (no future leakage),
- monitored for missingness and staleness.

## Order Book Data (Optional, High Value)

To support market making and microstructure-aware execution, add L2/L3 order book ingestion.

Design requirements:

- store top-of-book and aggregated depth features,
- maintain strict timestamp alignment,
- validate feed integrity and handle out-of-order messages.

## Feature Store Design (Pragmatic)

- Store computed features in ClickHouse with TTL and partitioning.
- Keep a version tag for feature definitions.
- Ensure features are computable in streaming and reproducible offline.

## Suggested ClickHouse Shape (v2)

Create a single wide feature table that is easy to query by `(symbol, event_ts)`:

- Partition: `toDate(event_ts)` (or a coarser unit if needed)
- Order key: `(symbol, event_ts, seq)`
- Version column: `feature_version` (UInt32) for evolution

## Torghut Extensions

- Extend Flink TA to produce a v2 "feature table" in ClickHouse.
- Add a schema evolution policy for features.

## References

- Example of modern order-book modeling direction (Transformer-based LOB forecasting): https://arxiv.org/abs/2406.05317
