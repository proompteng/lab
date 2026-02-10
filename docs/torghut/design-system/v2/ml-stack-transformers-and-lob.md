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
- Backtest ML signals with the same latency and availability constraints as production (no \"perfect\" feature access).

## Practical Guidance (Keep It Production-Grade)
- Start with interpretable baselines before deep models.
- Treat model evaluation as a trading system problem:
  - include costs and execution assumptions,
  - use walk-forward and purged splits,
  - require stability across regimes.
- Keep models behind deterministic safety:
  - model proposes signals,
  - portfolio + risk controls decide exposure,
  - execution layer enforces price bands and throttles.

## References
- Transformer for limit order books (TLOB, 2024): https://arxiv.org/abs/2406.05317
- TLOB (2025): https://arxiv.org/abs/2507.09322
- Liquidity Transformer (LiT, 2025): https://arxiv.org/abs/2508.04087
