# Torghut Design System v2 (Research): Profitable Autonomous Trading + Intelligence Layer

This is a historical research/proposal archive index, not a current implementation dashboard. Validate every reference
against `docs/torghut/README.md`, live GitOps, service source, and runtime readback.

## Status

- Version: `v2` (research / proposal)
- Last updated: **2026-02-10**
- Operational authority: `docs/torghut/README.md`, live GitOps, service source, and runtime readback.
- Historical implementation counts: `Implemented=0`, `Partial=16`, `Planned=8` of 24

## Purpose

Capture a research-backed blueprint for evolving Torghut from a safe paper-first automated trading loop into a more
robust, higher-signal, more profitable autonomous trading system with a bounded intelligence layer.

This is not investment advice and does not guarantee profitability. The goal is to reduce common failure modes
(overfitting, hidden costs, regime breaks, unsafe autonomy) and increase the probability of positive expectancy.

## Historical Use Note

The following tracks record the historical sequencing proposed for this research pack. They are not a current delivery
plan; revalidate any implementation decision against the live authority listed above.

## Historical MVP Track (Build Sequence at the Time)

- `profitability-discipline.md`
- `backtesting-and-walkforward.md`
- `overfitting-and-statistical-validity.md`
- `transaction-cost-and-capacity.md`
- `execution-and-market-impact.md`
- `portfolio-and-sizing.md`
- `risk-controls-and-kill-switches.md`
- `regime-detection.md`
- `llm-intelligence-layer-architecture.md`
- `governance-compliance-and-ops.md`

Pick one initial alpha family:

- `time-series-momentum.md` (trend)
- `mean-reversion-and-stat-arb.md` (mean reversion)

## Historical Next Track (Once MVP Was Stable)

- `alpha-discovery-loop.md`
- `quant-research-merge-and-alpha-tsmom-v1.md`
- `research-ledger.md`
- `research-reading-list.md`
- `agent-swarm-implementation.md`
- `data-pipeline-and-features.md`
- `cross-sectional-factors.md`
- `volatility-strategies.md`

## Historical Advanced / Optional Track

- `market-making.md` (requires order book data + low-latency loop + toxicity controls)
- `ml-stack-transformers-and-lob.md` (requires stronger data + evaluation discipline)
- `rl-trading-and-execution.md` (requires credible simulators; easiest to overfit)

## Design Constraints (Non-Negotiable)

- Paper-by-default. Live requires explicit gate(s) and change control.
- Deterministic risk controls remain final authority.
- LLM/agent layer is advisory unless a separate, audited actuation path is intentionally built.
- Every decision must be reproducible (inputs, config, model/prompt versions, and outputs).

## Historical Reading Shortlist

- Trend following and crisis performance (managed futures): AQR overview and research links.
- Market access risk controls (US): SEC 15c3-5 (Market Access Rule) summary.
- Algo trading organizational requirements (EU): MiFID II RTS 6 delegated regulation.
- LLM app security: OWASP Top 10 for LLM Applications.
- GenAI risk management: NIST AI RMF GenAI Profile.

(Each doc includes deeper references.)
