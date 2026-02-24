# Torghut Design System v4: Quant LLM Profitability Expansion

## Status

- Version: `v4`
- Date: `2026-02-19`
- Maturity: `research-to-implementation pack`
- Scope: 10 additional design docs focused on profitability, robustness, and autonomous controls.

## Objective

Translate fresh quant and LLM research (2024-2025) into implementation-ready Torghut designs that can be executed by
engineers or AgentRuns with clear acceptance gates.

## Non-Negotiable Invariants

- Paper trading remains default.
- Deterministic risk gates and kill-switch controls remain final authority.
- LLM systems are bounded by policy and cannot directly bypass deterministic execution controls.
- Every promotion decision must be backed by reproducible evidence.

## New Design Pack (10 Documents)

1. `01-time-series-foundation-model-routing-and-calibration.md`
2. `02-limit-order-book-intelligence-and-feature-stack.md`
3. `03-event-driven-synthetic-market-and-offline-policy-lab.md`
4. `04-latency-and-inventory-aware-market-making-policy.md`
5. `05-conformal-uncertainty-and-regime-shift-gating.md`
6. `06-robust-portfolio-optimization-and-regime-allocation.md`
7. `07-llm-multi-agent-trade-committee-and-critic.md`
8. `08-financial-rag-and-time-series-memory-architecture.md`
9. `09-ai-market-fragility-and-stability-controls.md`
10. `10-profitability-evidence-standard-and-benchmark-suite.md`

## Primary Research Inputs (Fresh)

- Chronos / Chronos-2 / MOMENT / TiRex (time-series foundation models).
- HLOB and recent limit-order-book prediction work.
- Neural Hawkes event simulation and CoFinDiff synthetic data generation.
- Market making RL papers for latency/inventory-aware quoting.
- Conformal forecasting papers for shift-aware uncertainty calibration.
- Robust portfolio optimization and online change-point portfolio methods.
- TradingAgents / QuantAgent / TradingGroup multi-agent LLM trading research.
- FinSrag / TiMi / FinTMMBench for finance RAG + memory + evaluation.
- BIS and NBER white papers on AI market fragility and asset pricing.

## Execution Expectations

Every doc in this pack includes:

- owned code/config paths,
- concrete deliverables,
- verification and rollback,
- an AgentRun handoff bundle (`ImplementationSpec` name, required keys, artifacts, exit criteria).

## Recommended Starting Order

1. `05-conformal-uncertainty-and-regime-shift-gating.md`
2. `10-profitability-evidence-standard-and-benchmark-suite.md`
3. `01-time-series-foundation-model-routing-and-calibration.md`
4. `04-latency-and-inventory-aware-market-making-policy.md`
5. `07-llm-multi-agent-trade-committee-and-critic.md`
