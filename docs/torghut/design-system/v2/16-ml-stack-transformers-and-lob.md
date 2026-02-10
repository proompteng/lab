# ML Stack: Trees, Deep Learning, Transformers, and LOB Models (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Summarize a practical ML modeling stack for trading signals and execution signals.

## Pragmatic Model Ladder
- Baseline: linear models and simple rules.
- Strong tabular baseline: gradient-boosted trees (feature discipline).
- Deep learning: sequence models for time series.
- Transformers: multi-resolution temporal modeling, order-book forecasting.

## Where ML Fits In Torghut
- Signal generation: enrich ClickHouse signals with ML-based forecasts.
- Risk: classify anomaly conditions (stale feed, toxicity proxies).
- Execution: predict short-term slippage/spread and choose execution style.

## Engineering Requirements
- Strict feature versioning and offline/online parity.
- Deterministic inference paths (same model weights, same preprocessing).
- Model drift monitoring and rollback.

## References
- Transformer for limit order books (TLOB, 2024): https://arxiv.org/abs/2406.05317
