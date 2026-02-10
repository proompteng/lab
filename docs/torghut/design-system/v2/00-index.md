# Torghut Design System v2 (Research): Profitable Autonomous Trading + Intelligence Layer

## Status
- Version: `v2` (research / proposal)
- Last updated: **2026-02-10**
- Relationship to v1: `docs/torghut/design-system/v1/` remains the production-facing source of truth.

## Purpose
Capture a research-backed blueprint for evolving Torghut from a safe paper-first automated trading loop into a more
robust, higher-signal, more profitable autonomous trading system with a bounded intelligence layer.

This is not investment advice and does not guarantee profitability. The goal is to reduce common failure modes
(overfitting, hidden costs, regime breaks, unsafe autonomy) and increase the probability of positive expectancy.

## How To Use This Pack
- Read `01-profitability-discipline.md` first.
- For strategy research, use `02-strategy-universe-2026.md` plus the strategy-specific docs (`11-15`).
- For system extension, focus on `03-10`, `16-19`.

## v2 Document List
- `01-profitability-discipline.md`
- `02-strategy-universe-2026.md`
- `03-data-pipeline-and-features.md`
- `04-backtesting-and-walkforward.md`
- `05-overfitting-and-statistical-validity.md`
- `06-transaction-cost-and-capacity.md`
- `07-execution-and-market-impact.md`
- `08-portfolio-and-sizing.md`
- `09-risk-controls-and-kill-switches-v2.md`
- `10-regime-detection.md`
- `11-time-series-momentum.md`
- `12-mean-reversion-and-stat-arb.md`
- `13-cross-sectional-factors.md`
- `14-volatility-strategies.md`
- `15-market-making.md`
- `16-ml-stack-transformers-and-lob.md`
- `17-rl-trading-and-execution.md`
- `18-llm-intelligence-layer-architecture.md`
- `19-governance-compliance-and-ops.md`

## Design Constraints (Non-Negotiable)
- Paper-by-default. Live requires explicit gate(s) and change control.
- Deterministic risk controls remain final authority.
- LLM/agent layer is advisory unless a separate, audited actuation path is intentionally built.
- Every decision must be reproducible (inputs, config, model/prompt versions, and outputs).

## Recommended Reading (Shortlist)
- Trend following and crisis performance (managed futures): AQR overview and research links.
- Market access risk controls (US): SEC 15c3-5 (Market Access Rule) summary.
- Algo trading organizational requirements (EU): MiFID II RTS 6 delegated regulation.
- LLM app security: OWASP Top 10 for LLM Applications.
- GenAI risk management: NIST AI RMF GenAI Profile.

(Each doc includes deeper references.)
