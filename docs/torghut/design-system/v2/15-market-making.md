# Market Making and Liquidity Provision (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

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
- Order-book ingestion and feature generation (see `03-data-pipeline-and-features.md`).
- Sub-second loop and deterministic throttles.
- Inventory-aware risk engine extensions.

## References
- Avellaneda-Stoikov model (foundational): https://people.orie.cornell.edu/sfs33/LimitOrderBook.pdf
