# Data Pipeline and Features (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Specify data requirements for profitable strategies and an intelligence layer.

## Data Layers
- Level 0: trades/quotes/bars (already in Torghut).
- Level 1: derived microbars and indicators (already in ClickHouse).
- Level 2: enriched features (needs v2 work):
  - realized volatility, intraday seasonality,
  - spread/imbalance proxies,
  - market regime features,
  - cross-asset factor features.

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

## Torghut Extensions
- Extend Flink TA to produce a v2 "feature table" in ClickHouse.
- Add a schema evolution policy for features.

## References
- Example of modern order-book modeling direction (Transformer-based LOB forecasting): https://arxiv.org/abs/2406.05317
