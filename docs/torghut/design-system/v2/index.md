# Torghut Design System v2 (Research): Profitable Autonomous Trading + Intelligence Layer

## Status

- Version: `v2` (research / proposal)
- Last updated: **2026-02-10**
- Relationship to v1: `docs/torghut/design-system/v1/` remains the production-facing source of truth.
- Source-of-truth implementation status: `implementation-status-matrix-2026-02-21.md`
- Evidence sync: `implementation-audit.md`
- Implementation status (strict): `Implemented=0`, `Partial=17`, `Planned=8` of 25

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Purpose

Capture a research-backed blueprint for evolving Torghut from a safe paper-first automated trading loop into a more
robust, higher-signal, more profitable autonomous trading system with a bounded intelligence layer.

This is not investment advice and does not guarantee profitability. The goal is to reduce common failure modes
(overfitting, hidden costs, regime breaks, unsafe autonomy) and increase the probability of positive expectancy.

## How To Use This Pack

- Start with the MVP track below. Add strategy families only after you have credible evaluation + cost realism.
- Treat \"Advanced\" items as optional until you have strong evidence you need them.

## MVP Track (Build This First)

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

## Next (Once MVP Is Stable)

- `alpha-discovery-loop.md`
- `quant-research-merge-and-alpha-tsmom-v1.md`
- `research-ledger.md`
- `research-reading-list.md`
- `agent-swarm-implementation.md`
- `strategy-universe.md`
- `data-pipeline-and-features.md`
- `cross-sectional-factors.md`
- `volatility-strategies.md`

## Advanced / Optional

- `market-making.md` (requires order book data + low-latency loop + toxicity controls)
- `ml-stack-transformers-and-lob.md` (requires stronger data + evaluation discipline)
- `rl-trading-and-execution.md` (requires credible simulators; easiest to overfit)

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
