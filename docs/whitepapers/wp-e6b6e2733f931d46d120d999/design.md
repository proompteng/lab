# Whitepaper Design: Trading-R1 (arXiv:2509.11420)

- Run ID: `wp-e6b6e2733f931d46d120d999`
- Repository: `proompteng/lab`
- Issue: `https://github.com/proompteng/lab/issues/3591`
- Source PDF: `https://arxiv.org/pdf/2509.11420`
- Ceph object: `s3://torghut-whitepapers/raw/github/proompteng-lab/issue-3591/wp-e6b6e2733f931d46d120d999/source.pdf`
- Reviewed end-to-end: yes (58 pages, main paper + supplementary sections S1-S6)
- Review date (UTC): `2026-02-24`

## 1) Executive Summary

Trading-R1 proposes a finance-focused reasoning LLM pipeline that combines supervised fine-tuning (SFT) and reinforcement fine-tuning (RFT/GRPO) in a three-stage curriculum: structure -> evidence -> decision (Sec. 3.3-3.7, Table 1, Fig. 1).

Core ingredients:

1. A 100k-sample dataset (`Tauric-TR1-DB`) built from five modalities (news, technicals, fundamentals, sentiment, macro) over 14 assets and ~18 months (Sec. 3.2, S1.1-S1.3).
2. Reverse reasoning distillation to synthesize detailed investment-thesis traces from stronger API-model final recommendations (Sec. 3.4, Fig. 2).
3. Volatility-normalized five-class labels (`strong sell` to `strong buy`) generated with multi-horizon returns and asymmetric quantiles (Sec. 3.5, Algorithm S1).
4. Stage-specific reward shaping for format, evidential grounding, and final decision quality, optimized with GRPO (Sec. 3.7, Eq. 1, S4).

Reported backtests on six assets/ETFs (NVDA, AAPL, MSFT, AMZN, META, SPY) indicate Trading-R1 outperforms listed baselines on many Sharpe/return cells (Sec. 5, Table 3-4, Fig. 5).

Implementation relevance is moderate for research tooling and structured thesis generation, but low for immediate autonomous trading. The paper itself recommends analyst-in-the-loop usage and acknowledges instability, hallucinations, long-bias, and data-quality constraints (pp. 17-18, "Industrial Applications and Future Work").

## 2) Methodology Synthesis

## 2.1 Data and Input Pipeline

- Asset universe: 14 large-cap stocks/ETFs across sectors (S1.3, Table S3).
- Time window: 2024-01-01 to 2025-05-31 for corpus construction (Sec. 1, S1.3).
- Modalities and sources:
  1. News: Finnhub + Google News, bucketed by recency (S1.1.1, Table S1).
  2. Technicals: OHLCV + indicator suite (MACD/RSI/ATR/Bollinger/ADX/etc.) (S1.1.2, Table S2).
  3. Fundamentals: SimFin + SEC filings (S1.1.3).
  4. Sentiment: insider sentiment/transactions + analyst revisions (S1.1.4).
  5. Macro: FRED monthly indicators (S1.1.5).
- Assembly strategy: shuffled/sampled modality subsets to simulate missing-data regimes; ~20 variations per date-ticker pair; token-saving preprocessing for long contexts (S1.2).

## 2.2 Labeling and Decision Space

- Action space: five discrete decisions mapped to conviction-weighted positions (Sec. 3.7).
- Label generation (Algorithm S1):
  1. EMA-based forward returns at 3/7/15-day horizons.
  2. Volatility normalization (rolling std).
  3. Weighted composite signal (0.3/0.5/0.2).
  4. Asymmetric percentile cutoffs (3%, 15%, 53%, 85%).
- Target distribution: 15% strong buy, 32% buy, 38% hold, 12% sell, 3% strong sell (Table 2).

## 2.3 Training Strategy

- Backbone: Qwen3-4B (Sec. 3.6).
- Interleaved curriculum per stage:
  1. SFT warm-start for structure/evidence/decision priors.
  2. RFT (GRPO) to align outcomes and preserve staged behavior (Sec. 3.3, 3.6, 3.7).
  3. Self-distillation with reject sampling (Table 1).
- GRPO objective uses group-relative advantages and KL anchor to reference policy (Sec. 3.7, Eq. 1).

## 2.4 Reward Design

- Main paper: structured, evidence-grounded, decision-aligned composite reward framing (Fig. 4).
- Supplement (S4): explicit stage formulas for XML structure, opinion-quote-source evidence checks, and asymmetric decision matrix with heavier false-bullish penalties.
- Supplement (S5): documents failed R0 design where mixed format+outcome rewards in one stage caused instability and shallow reasoning.

## 2.5 Evaluation Protocol

- Backtest period stated as 2024-06-01 to 2024-08-31 on held-out set (Sec. 4.3).
- Metrics: CR, SR, HR, MDD with explicit definitions in S2.2.
- Baselines: SLMs, larger LLMs, reasoning LLMs, plus internal SFT-only and RL-only ablations (Sec. 4.3, Table 3-4).

## 3) Key Findings

1. Trading-R1 is reported as strongest overall variant among compared groups.
- Evidence: Table 3-4 + Fig. 5 show Trading-R1 leading or near-leading SR/CR on most assets.

2. Combining SFT and RFT outperforms one-stage variants in aggregate.
- Evidence: Table 3-4 and text discussion in Sec. 5.

3. Structured reasoning and evidence formatting are central to model usability.
- Evidence: curriculum and reward definitions (Table 1, Sec. 3.3, S4), plus R0 failure analysis (S5.3).

4. The paper positions the model for analyst support rather than fully autonomous live trading.
- Evidence: explicit recommendations and limitations section (pp. 17-18).

## 4) Novelty Claims Assessment

1. Claim: reverse reasoning distillation can recover useful reasoning traces from black-box strong models.
- Assessment: moderately novel workflow contribution.
- Basis: Sec. 3.4 + Fig. 2 define a concrete multi-model reconstruction pipeline.

2. Claim: staged structure/evidence/decision curriculum materially improves trading reasoning quality.
- Assessment: plausible and partially supported.
- Basis: Sec. 3.3, Table 1, Sec. 5; but no statistical tests or confidence intervals are reported.

3. Claim: robust market-aligned performance versus open and proprietary baselines.
- Assessment: directionally supported in provided setup, externally under-validated.
- Basis: Table 3-4 and Fig. 5 are positive; robustness depth is limited.

## 5) Risks, Assumptions, and Unresolved Questions

## 5.1 Critical Assumptions

1. Volatility-adjusted quantile labels are stable proxies for actionable alpha under regime shifts.
2. Reverse-distilled reasoning traces preserve causal relevance rather than style artifacts from teacher models.
3. Asymmetric decision matrix encodes the right risk posture for target deployment context.

## 5.2 High-Impact Risks

1. Data leakage/split ambiguity risk (high).
- The paper claims a held-out Jun-Aug 2024 test (Sec. 4.3), but dataset window description spans Jan 2024-May 2025 for training corpus generation (Sec. 1, S1.3) without a fully explicit leakage-proof split procedure.

2. Statistical rigor risk (high).
- No confidence intervals, repeated-seed variance, or significance testing for metric deltas.

3. Benchmark comparability risk (medium-high).
- Prompting/format compliance and adaptation parity across heterogeneous closed/open baselines is not fully specified.

4. Regime/generalization risk (high).
- Universe is concentrated in mega-cap/blue-chip names during a strong 2024-2025 cycle; authors acknowledge structural long bias (p. 17).

5. Execution realism risk (medium-high).
- Paper discusses decision labels and backtesting, but does not provide a full production-grade transaction-cost/slippage/market-impact framework.

6. Hallucination and faithfulness risk (medium-high).
- Explicitly acknowledged for long noisy contexts and small model size (p. 17).

## 5.3 Internal Consistency Signals to Verify

1. Reported NVDA Sharpe inconsistency: narrative states SR=1.88 while table row indicates SR=2.72.
2. Some table rendering suggests formatting artifacts; exact numeric extraction should be verified from source tables before secondary citation.
3. Held-out evaluation statement should be reconciled with full corpus date window via released split manifests.

## 6) Implementation Implications (Implementation-Ready Outcomes)

## 6.1 What Can Be Adopted Now

1. Staged reasoning curriculum template:
- enforce structure first,
- then evidence grounding,
- then decision calibration.

2. Volatility-normalized multi-horizon labeler (Algorithm S1) as a reproducible baseline label policy.

3. Explicit reward decomposition:
- formatting quality,
- claim-grounding quality,
- decision correctness with asymmetric penalties.

4. Analyst-facing thesis generation UX with strict output schema and source citations.

## 6.2 Must-Have Guardrails Before Any Trading Deployment

1. Deterministic dataset split manifests with date/ticker hashes and leakage checks.
2. Repeated-seed evaluation with uncertainty bands for SR/CR/HR/MDD.
3. Walk-forward and stress-regime tests beyond 2024-2025 mega-cap regime.
4. Realistic execution simulator including spread/slippage/impact/turnover constraints.
5. Safety controls: exposure caps, concentration limits, stale-signal suppression, auto-disable on drift.

## 6.3 Concrete Incremental Plan

Phase 1 (2-3 weeks): reproducible research replica
1. Rebuild S1 ingestion schema and Algorithm S1 labels with immutable artifacts.
2. Implement stage-specific reward calculators from S4.
3. Reproduce key table metrics on a fixed seed and publish run manifests.

Phase 2 (2-4 weeks): robustness and anti-leak hardening
1. Enforce strict temporal train/val/test boundaries with CI assertions.
2. Add repeated-seed and bootstrap significance tests.
3. Run cross-universe tests (small/mid-cap, non-tech-heavy slices).

Phase 3 (ongoing): controlled pilot
1. Deploy as analyst-assist thesis engine in paper-trading/shadow mode only.
2. Promote only if robustness gates pass for multiple regimes.
3. Keep human sign-off mandatory for any live action pathway.

## 7) Viability Verdict

- Verdict: **conditional_implement**
- Score: **0.61 / 1.00**
- Confidence: **0.79 / 1.00**
- Rejection reasons (for immediate full production rollout):
  1. Split/leakage ambiguity and incomplete reproducibility metadata.
  2. Missing statistical significance/variance reporting.
  3. Limited regime breadth and acknowledged long-bias.
  4. Insufficient execution-friction realism for autonomous deployment.

Recommendation: implement as a deterministic research and analyst-support system first, not an autonomous production trading engine.

## 8) Concrete Section-Level Evidence Map

1. Sec. 3.2 + S1: multi-modal data collection and assembly pipeline.
2. Sec. 3.4 + Fig. 2: reverse reasoning distillation process.
3. Sec. 3.5 + Algorithm S1 + S2.1: volatility-based multi-horizon label generation.
4. Sec. 3.3 + Table 1: staged SFT/RFT curriculum design.
5. Sec. 3.7 + Eq. 1: GRPO objective and policy-optimization details.
6. S4: formal stage reward equations and asymmetric decision matrix.
7. Sec. 4.3 + S2.2: evaluation protocol and metric definitions.
8. Sec. 5 + Table 3-4 + Fig. 5: comparative model outcomes.
9. pp. 17-18 (Industrial Applications and Future Work): limitations and recommended usage boundaries.
10. S5.3: R0 failure analysis motivating staged reward separation.
