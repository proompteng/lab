# Whitepaper Design: ATLAS (arXiv:2510.15949)

- Run ID: `wp-170f349204ec83d16deb28cf`
- Repository: `proompteng/lab`
- Issue: `https://github.com/proompteng/lab/issues/3624`
- Source PDF: `https://arxiv.org/pdf/2510.15949.pdf`
- Ceph object: `s3://torghut-whitepapers/raw/checksum/a4/a4e9f8a261c9a07e015d2389e4b9523147db3d43b4d9d52d15732db3c71dff1d/source.pdf`
- Reviewed end-to-end: yes (43 pages, main text + references + appendices A-K)
- Review date (UTC): `2026-02-25`

## 1) Executive Summary

ATLAS proposes an LLM trading architecture with three analyst agents (market/news/fundamental), one central trading agent (CTA), and a sequential prompt-optimization loop called Adaptive-OPRO. The core claim is that optimizing the CTA's static instruction block over rolling windows improves order-level trading performance under delayed/noisy feedback (Sec. 4, Eq. 1, Tables 1-2).

The strongest empirical signal is in the bearish/volatile regime: Adaptive-OPRO often converts negative baseline ROI into positive ROI for several models (for example GPT-o3 and GPT-o4-mini in Table 1). Results are directionally promising but remain bounded by narrow scope: three assets, one two-month window, daily decisions, deterministic simulator execution, and only three runs per configuration (Sec. 5.1, Limitations, App. D/E).

Implementation relevance is moderate-to-high for prompt-optimization workflows and auditable agent architecture patterns. It is low for immediate autonomous live trading deployment.

## 2) Methodology Synthesis

## 2.1 System Architecture (ATLAS)

1. Market Intelligence Pipeline:
- `Market Analyst`: multi-timescale technical summaries and indicators (Sec. 3, App. B).
- `News Analyst`: structured narrative/sentiment synthesis from news (Sec. 3, App. C.1).
- `Fundamental Analyst`: low-frequency financial-statement/event summaries (Sec. 3, App. C.2).

2. Decision and Execution Layer:
- `Central Trading Agent (CTA)` consumes analyst outputs + portfolio state and emits order-level actions (`BUY`, `SELL`, `SHORT`, `SHORT_COVER`) with order types (`MARKET`, `LIMIT`, `STOP`) (Sec. 3, App. F.1).
- Execution is handled in StockSim with deterministic order semantics and portfolio updates (Sec. 3, Sec. 5.1).

3. Feedback Mechanism:
- Supports static policy (off), reflection, or Adaptive-OPRO optimization loops (Sec. 3-4).

## 2.2 Adaptive-OPRO

1. Optimized object: CTA static instruction block only; dynamic runtime content and template placeholders are frozen (Sec. 4, App. F.5).
2. Optimization history: stores prior prompt variants with scalar score history (Sec. 4).
3. Windowed evaluation: rolling `K=5` trading-day scoring windows (Sec. 4).
4. Score mapping:
- `s = clip[0,100](50 + 250 * ROI)`
- anchors: `-20% -> 0`, `0% -> 50`, `+20% -> 100` (Sec. 4, Eq. 1).
5. Guardrail: candidate prompt accepted only if runtime template/interface is preserved (Sec. 4, App. F.5).

## 2.3 Experimental Design

1. Regimes/assets:
- Bearish-volatile: LLY
- Sideways: XOM
- Bullish: NVDA
- Fixed window for all: Apr 28 to Jun 28, 2025, daily decisions (Sec. 5.1, App. D.1-D.3).

2. Compared prompting strategies:
- Baseline static prompt
- Reflection (weekly in main text; daily in appendix tables)
- Adaptive-OPRO (Sec. 5.1, Tables 1-2, Tables 9-11).

3. Backbones:
- GPT-o3, GPT-o4-mini, Claude Sonnet 4 (+ thinking variant), LLaMA 3.3-70B, Qwen3-235B, Qwen3-32B (Sec. 5.1).

4. Metrics:
- ROI, Sharpe, max drawdown, win rate, trade count (Sec. 5.1).
- Extra metrics in appendix: annualized Sharpe, Sortino, ROIC, profit/trade (App. E, Tables 4-6).

5. Stochasticity handling:
- 3 runs per configuration, report mean +/- std (Sec. 5.1, App. D.7).

## 3) Key Findings

1. Adaptive-OPRO improves results markedly in the bearish/volatile regime for most tested models.
- Evidence: Table 1. Examples:
- GPT-o4-mini: ROI `-1.30` (baseline) -> `9.06` (Adaptive-OPRO).
- GPT-o3: ROI `-6.11` -> `9.02`.
- Qwen3-235B: ROI `-1.78` -> `1.33`.

2. Reflection is frequently unstable and can degrade performance.
- Evidence: Sec. 6.1 "reflection paradox" (`r=-0.78`, `p<0.05` in volatile regime), App. H causal case study, Tables 1-2 and 9-11.

3. Gains are not uniformly dominant in every regime/model cell.
- Evidence: Table 2 shows exceptions (for example Qwen3-235B bullish ROI baseline `43.91` vs Adaptive-OPRO `41.25`).
- Implication: headline "consistently outperforms" should be interpreted as trend-level, not strictly cell-wise universal superiority.

4. Market and news analyst signals are complementary and regime-dependent.
- Evidence: Table 3 ablation.
- Removing market analyst in bearish regime strongly harms ROI (`9.06` -> `-5.75`).
- In bullish regime, no-market-data can slightly outperform full ATLAS (`11.78` vs `10.47`), indicating trend-regime sensitivity.

5. Order-level interface exposes useful failure modes.
- Evidence: Sec. 6.2-6.3.
- Some models produce plausible analysis but fail on sizing/timing/order construction.

## 4) Novelty Claims Assessment

1. Claim: Sequential prompt optimization for delayed/noisy reward settings (Adaptive-OPRO).
- Assessment: `moderately_novel`.
- Basis: clear adaptation of OPRO to rolling-window sequential tasks with template-separation constraints (Sec. 4).

2. Claim: Practical, auditable order-level multi-agent trading framework.
- Assessment: `incremental_but_useful`.
- Basis: architecture integration is pragmatic and implementation-oriented; core components are combinations/extensions of known patterns (Sec. 3, App. F).

3. Claim: Broad, consistent outperformance.
- Assessment: `partially_supported`.
- Basis: strong directional support in many settings (Tables 1-2), but not universal across all model/regime cells.

## 5) Risks, Assumptions, and Unresolved Questions

## 5.1 Critical Assumptions

1. A 5-day rolling ROI score is sufficient credit assignment signal for prompt updates.
2. Deterministic simulator results transfer directionally to real execution environments.
3. Three-run mean +/- std is adequate to rank adaptation mechanisms robustly.

## 5.2 High-Impact Risks

1. External validity risk (`high`).
- Only 3 assets and one two-month period (Sec. 5.1, Limitations, App. D).

2. Execution realism risk (`high`).
- No slippage/latency/partial fills/intraday microstructure (Limitations).

3. Statistical power risk (`high`).
- Only three runs/configuration; no significance tests for most reported deltas (Sec. 5.1, App. D.7).

4. Over-claiming risk (`medium-high`).
- "Consistent outperformance" language exceeds some table cells.

5. Reproducibility availability risk (`medium`).
- "Code will be released upon publication" means immediate external replication is partially constrained from this manuscript alone.

## 5.3 Unresolved Questions

1. How stable are gains under longer horizons and rolling walk-forward windows across multiple years?
2. Do results hold under realistic transaction-cost and slippage models?
3. Which Adaptive-OPRO components contribute most: score design, template separation, optimizer model choice, or window length?
4. What is the sensitivity of outcomes to regime definitions and asset selection criteria?

## 6) Implementation Implications (Implementation-Ready Outcomes)

## 6.1 What Can Be Adopted Now

1. Prompt update architecture:
- Optimize only stable instruction blocks.
- Keep runtime interface fixed with strict placeholder/schema checks.

2. Windowed optimization loop:
- Use periodic scalar objective windows rather than per-step noisy feedback.

3. Order-level auditing discipline:
- Require structured action/order-type/size outputs to separate reasoning quality from execution quality.

4. Reflection containment:
- Treat free-form reflective critique as optional and gated; do not allow direct policy drift without objective checks.

## 6.2 Required Guardrails Before Any Live Trading Usage

1. Add realistic execution frictions: spread/slippage/latency/partial fills.
2. Run broader universes and longer multi-regime horizons.
3. Increase repeat counts and add uncertainty/significance reporting.
4. Enforce risk policy caps and kill-switch conditions for automated adaptation.

## 6.3 Concrete Incremental Plan

Phase 1 (1-2 weeks): research replication
1. Recreate ATLAS-style prompt separation and 5-day scoring loop in current simulation stack.
2. Benchmark baseline vs adaptive on a fixed deterministic replay dataset.

Phase 2 (2-4 weeks): robustness hardening
1. Expand to multi-year walk-forward windows and broader asset basket.
2. Add slippage/transaction-cost stress tests and uncertainty bands.

Phase 3 (2-3 weeks): controlled pilot
1. Deploy as analyst-assist recommendation engine in shadow mode.
2. Promote only if risk-adjusted improvements hold under friction and out-of-sample conditions.

## 7) Viability Verdict

- Verdict: **conditional_implement**
- Score: **0.67 / 1.00**
- Confidence: **0.83 / 1.00**
- Rejection reasons (for immediate autonomous production rollout):
1. Narrow empirical scope (assets/horizon) and limited run count.
2. Simulator realism gap vs live execution.
3. Incomplete evidence of universal superiority across all model/regime cells.

Recommendation: implement Adaptive-OPRO patterns as a controlled R&D capability and analyst-support mechanism, not as immediate autonomous live trading logic.

## 8) Section-Level Evidence Map

1. Sec. 3: ATLAS architecture (analyst agents, CTA, execution layer).
2. Sec. 4 + Eq. 1: Adaptive-OPRO algorithm and scoring function.
3. Sec. 5.1 + App. D: experimental setup, models, regimes, and protocols.
4. Table 1: bearish/volatile comparative performance.
5. Table 2: sideways and bullish comparative performance.
6. Table 3: ablation impacts for market/news components.
7. Sec. 6.1 + App. H: reflection degradation mechanisms and case evidence.
8. App. E (Tables 4-6): extended risk-adjusted and capital-efficiency metrics.
9. Limitations section: external validity and execution realism bounds.
10. App. J: reproducibility environment and model/provider metadata.
