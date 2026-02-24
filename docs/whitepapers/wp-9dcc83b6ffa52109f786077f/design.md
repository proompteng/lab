# Whitepaper Design: Adaptive Alpha Weighting with PPO (arXiv:2509.01393)

- Run ID: `wp-9dcc83b6ffa52109f786077f`
- Repository: `proompteng/lab`
- Issue: `https://github.com/proompteng/lab/issues/3609`
- Source PDF: `https://arxiv.org/pdf/2509.01393.pdf`
- Ceph object: `s3://torghut-whitepapers/raw/github/proompteng-lab/issue-3609/wp-9dcc83b6ffa52109f786077f/source.pdf`
- Reviewed end-to-end: yes (24 pages, including references and all result tables/figures)
- Review date (UTC): `2026-02-24`

## 1) Executive Summary

The paper proposes a two-stage quant pipeline:
1. Generate 50 formulaic alpha expressions with a prompt-based LLM (`deepseek-r1-distill-llama-70b`).
2. Use PPO to dynamically reweight those alphas for trading decisions per stock (Sec. 3.2.1-3.2.2, Eq. 2-8).

The reported results are directionally strong for Apple, HSBC, Pepsi, and Tencent against index benchmarks, while Toyota underperforms its benchmark materially (Table 7). The PPO-weighted strategy also outperforms the paper's equal-weight alpha baseline for 4 out of 5 stocks (Table 8).

Implementation value is moderate for an internal research prototype focused on adaptive signal weighting. Production viability is limited by methodological risks: small universe (5 stocks), one historical split, possible information leakage in alpha-generation protocol, and weak statistical reporting.

## 2) Methodology Synthesis

## 2.1 Data and Feature Construction

- Assets: Apple, HSBC, Pepsi, Tencent, Toyota (Sec. 3.1).
- Price history: 2016-02-16 to 2024-05-08 from `yfinance` (Sec. 3.1).
- News sentiment: Yahoo-style feed via EODHD API, scored with NLTK polarity in [-1, 1] (Sec. 3.1).
- Technical indicators: SMA(5/20), EMA(10), Momentum(3/10), RSI(14), MACD and signal, Bollinger Bands, OBV (Table 1).
- Split: first 80% train, last 20% test (Sec. 3.1).

## 2.2 LLM Alpha Generation

- Model: `deepseek-r1-distill-llama-70b` (Sec. 3.2.1).
- Prompt: asks for 50 Python-syntax formulas over price/volume/sentiment/indicator features (Table 2).
- Output: one shared 50-alpha set used across all five stocks (Sec. 3.2.1, Table 5).
- Generated alphas include momentum, sentiment, volume, index-relative, and mixed indicator formulas (Table 5).

## 2.3 PPO Weight Optimization

- Framing: POMDP with state `st = {OHLCVt, p(t-1), regime_t, sigma_t}` (Eq. 2).
- Action: 50-d weight vector, clipped to [-1, 1], then L1-normalized (Eq. 3-4).
- Composite alpha: weighted sum over standardized alpha signals (Eq. 6).
- Position logic: quantile-thresholded sizing, regime filter, volatility targeting (`sigma_target=0.15`) (Eq. 7, Table 3-4).
- Reward: position P&L minus transaction penalty (`lambda=0.001`) (Eq. 5).
- PPO objective: clipped surrogate with `epsilon=0.2`, GAE advantages (Eq. 8).
- Implementation details: Stable-Baselines3 default PPO hyperparameters listed in Sec. 3.2.2.

## 2.4 Evaluation Protocol

- Metrics: IC, MI, LightGBM gain importance, cumulative return, Sharpe ratio, max drawdown (Sec. 3.3, Eq. 9-14).
- Benchmarks:
1. Market indices (S&P 500, Hang Seng, Nikkei 225 depending on stock).
2. Equal-weight alpha strategy.
- Stochastic evaluation: 10 non-deterministic runs per stock, reporting mean (std) (Sec. 4.3, Table 7).

## 3) Key Findings

1. PPO-adjusted strategy beats market benchmark on 4/5 stocks, but not Toyota.
- Evidence: Table 7.
- Data points:
1. Apple cumulative return 1.6817 vs S&P 500 0.3476.
2. HSBC 0.4657 vs Hang Seng 0.0033.
3. Pepsi 0.6272 vs S&P 500 0.3476.
4. Tencent 0.6245 vs Hang Seng 0.0033.
5. Toyota 0.0299 vs Nikkei 225 0.4081 (underperforming).

2. PPO weighting strongly dominates the equal-weight alpha portfolio for 4/5 stocks.
- Evidence: Table 7 vs Table 8.
- Equal-weight cumulative returns are negative for Apple (-0.3200), HSBC (-0.9059), Pepsi (-0.1726), Tencent (-0.7074).

3. Alpha reduction strategies have mixed per-stock effects but do not change headline direction.
- Evidence: Tables 9-12 and Sec. 5.1.
- Low-correlation and high-contribution subsets help some stocks (for example HSBC), hurt others (for example Apple/Tencent).

4. Sentiment treatment changes outcomes, but no single sentiment setting is uniformly dominant.
- Evidence: Tables 14-18 and Sec. 5.3.
- For Pepsi and Tencent, "all sentiments" or "no sentiment" perform similarly; for HSBC, target-only sentiment is stronger.

5. Full prompt information performs best in Apple ablation, but reduced prompts still outperform market benchmark.
- Evidence: Table 13 and Sec. 5.2.

## 4) Novelty Claims Assessment

1. Claim: combining LLM-generated alpha discovery with PPO weight adaptation is novel and beneficial.
- Assessment: `partially_supported`.
- Why: integration is useful and results are favorable in-sample, but similar LLM+RL motifs already exist in recent quant literature; novelty is mostly in packaging and empirical comparison set (Sec. 2, Sec. 5.1).

2. Claim: dynamic alpha weighting provides clear advantage over static equal weighting.
- Assessment: `supported_in_scope`.
- Why: strongly supported by Table 7 vs Table 8 for 4/5 stocks.

3. Claim: framework is robust across settings (alpha selection, prompt information, sentiment variants).
- Assessment: `partially_supported`.
- Why: robustness is demonstrated only on one period and five names; external validity remains unproven.

## 5) Risks, Assumptions, and Unresolved Questions

## 5.1 Critical Assumptions

1. The 50 generated formulas are not overfit to the specific historical window used to craft prompts.
2. A single 80/20 temporal split is representative of deployment behavior.
3. Fixed transaction cost (`lambda=0.001`) approximates realistic costs across all markets.
4. Reported improvements are not primarily artifacts of benchmark design or evaluation protocol.

## 5.2 High-Impact Risks

1. Information leakage risk (high).
- Prompt is described as receiving feature data in JSON (Sec. 3.2.1) while the paper also uses one train/test split (Sec. 3.1); procedure is not explicit on preventing test-period information from influencing generated formulas.

2. External validity risk (high).
- Universe is only five large names across mixed markets; results may not transfer to broader universes, smaller caps, or different regimes.

3. Statistical rigor risk (high).
- Ten stochastic runs are reported with mean/std, but no confidence intervals, no significance tests, and no walk-forward protocol.

4. Reproducibility risk (medium-high).
- Tables are detailed, but no artifact manifest (exact seeds, data snapshots, code release hash) is provided in paper text.

5. Benchmark fairness risk (medium-high).
- Equal-weight baseline is very weak and may be under-regularized versus PPO setup; comparisons to alternative adaptive baselines are absent.

6. Objective consistency risk (medium).
- Eq. 4 defines normalized weights `w_norm`, but Eq. 6 uses `w_t[i]` in the composite alpha; paper does not clearly state which vector is actually used in execution.

## 5.3 Unresolved Questions

1. Was alpha generation performed using training-only slices, or full-history slices including test horizon?
2. How do results change under rolling walk-forward retraining instead of a single split?
3. Do results persist after realistic slippage/spread/impact modeling by market?
4. Which portion of performance comes from regime filter and volatility scaling vs alpha weighting itself?

## 6) Implementation Implications (Implementation-Ready Outcomes)

## 6.1 What Can Be Adopted Now

1. A reproducible alpha-combination environment where RL optimizes factor weights under explicit risk controls.
2. A standardized experiment harness for testing:
1. `all alphas`,
2. `low-correlation subset`,
3. `high-contribution subset`,
4. `random subset`.
3. A fixed evaluation matrix using cumulative return, Sharpe, max drawdown, IC/MI diagnostics.

## 6.2 Required Guardrails Before Any Production Consideration

1. Strict no-leak alpha generation protocol:
1. generate formulas from training-period metadata only,
2. freeze formulas before test period.
2. Walk-forward multi-period evaluation (rolling train/validation/test windows).
3. Wider universe tests (>=50 symbols across sectors and regions).
4. Robust statistics:
1. confidence intervals,
2. significance tests against strong adaptive baselines.
5. Execution realism:
1. spread/slippage/impact,
2. market-hours and liquidity constraints.

## 6.3 Concrete Incremental Plan

Phase 1 (1-2 weeks): deterministic replication
1. Re-implement Eq. 2-8 with explicit seed control and config snapshots.
2. Reproduce Table 7 on the same five stocks with immutable data artifacts.
3. Resolve implementation ambiguity (`w_t` vs `w_norm`) and document chosen behavior.

Phase 2 (2-4 weeks): anti-leak and robustness hardening
1. Add train-only alpha-generation gating in pipeline.
2. Run rolling walk-forward tests over multiple market regimes.
3. Add adaptive non-LLM baselines (risk parity, rolling IC weighting, ridge/risk-adjusted stacking).

Phase 3 (ongoing): controlled internal deployment
1. Use as research decision-support, not autonomous execution.
2. Add risk limits and kill-switches for abnormal drawdown/drift.
3. Promote only after robustness thresholds pass on expanded universe.

## 7) Viability Verdict

- Verdict: **conditional_implement**
- Score: **0.47 / 1.00**
- Confidence: **0.84 / 1.00**
- Rejection reasons (for immediate production deployment):
1. Potential leakage path in alpha-generation protocol.
2. Limited universe and single-split backtest design.
3. Lack of statistical significance and walk-forward evidence.
4. Insufficient market microstructure realism in cost/execution assumptions.

Recommendation: implement as a deterministic research module for adaptive alpha weighting; do not deploy for autonomous production trading until guardrails and robustness gates are satisfied.

## 8) Section-Level Evidence Map

1. Sec. 3.1 + Table 1: data sources, symbols, dates, indicators, split policy.
2. Sec. 3.2.1 + Table 2 + Table 5: prompt design and generated alpha set.
3. Sec. 3.2.2 + Eq. 2-8 + Table 3-4: RL state/action/reward/objective and risk controls.
4. Sec. 3.3 + Eq. 9-14: evaluation metrics and formal definitions.
5. Sec. 4.1 + Figure 4: MI/IC diagnostics by company and alpha.
6. Sec. 4.2 + Figure 5: LightGBM gain importance distribution.
7. Sec. 4.3 + Table 7: PPO strategy vs market benchmarks.
8. Sec. 4.4 + Table 8: PPO strategy vs equal-weight baseline.
9. Sec. 5.1 + Table 9-12 + Figure 6-7: alpha selection setting impacts.
10. Sec. 5.2 + Table 13: prompt-information ablation.
11. Sec. 5.3 + Table 14-18: sentiment-setting ablations.
12. Sec. 6: stated conclusions and future work claims.
