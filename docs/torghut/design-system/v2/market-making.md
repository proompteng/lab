# Market Making and Liquidity Provision (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: strategy/alpha/discovery/profile modules and tests exist, but research strategy proposals are not all promoted runtime strategies.
- Matched implementation area: Strategy, alpha, TSMOM, regime, portfolio, and sizing.
- Current source evidence:
  - `services/torghut/app/strategies/catalog.py`
  - `services/torghut/app/trading/alpha/tsmom.py`
  - `services/torghut/app/trading/strategy_runtime`
  - `services/torghut/app/trading/discovery/candidate_specs.py`
  - `services/torghut/app/trading/portfolio`
- Design drift note: A research/stress module is not enough to call a strategy live; promotion still depends on proof/readiness gates.


## Purpose

Describe what it would take to add market making safely.

## Warning

Market making is operationally and model-risk intensive. It requires order-book data, low latency, and strong
inventory and adverse selection controls.

## Core Concepts

- Quote around a reservation price.
- Control inventory risk and widen spreads as inventory grows.
- Detect toxic flow and pull quotes in stress.

## Torghut Extensions Needed

- Order-book ingestion and feature generation (see `data-pipeline-and-features.md`).
- Sub-second loop and deterministic throttles.
- Inventory-aware risk engine extensions.

## References

- Avellaneda-Stoikov model (foundational): https://people.orie.cornell.edu/sfs33/LimitOrderBook.pdf
