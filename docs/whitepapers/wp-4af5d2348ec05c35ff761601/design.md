# Whitepaper Design: Inelastic Hedging Demand and Intraday Momentum

- Run ID: `wp-4af5d2348ec05c35ff761601`
- Repository: `proompteng/lab`
- Issue: `https://github.com/proompteng/lab/issues/4231`
- Source PDF: `https://portal.northernfinanceassociation.org/viewp.php?n=2240183764&utm_source=chatgpt.com`
- Ceph object: `s3://torghut-whitepapers/raw/checksum/16/168be515b25ff9b8100a1192ccfa9070757ba3d9bd9ed1ec38bee573aac7e439/source.pdf`
- Reviewed end-to-end: yes (50 pages: main text, references, appendix A-C, tables/figures)
- Review date (UTC): `2026-03-08`

## 1) Executive Summary

This paper studies whether short-gamma delta hedging by option intermediaries becomes inelastic once the underlying moves outside a gamma-theta breakeven range (GTBR), and whether that state amplifies intraday momentum in the underlying stock. The key theoretical construction is the GTBR itself: under the paper's simplifying assumptions, the breakeven threshold is derived from option theta and gamma and simplified to approximately `+- sigma_imp / sqrt(365)` (Sec. 2.3.1-2.3.3, Eq. 1 and Eq. 4, Appendix A3).

The empirical contribution is stronger than the theory contribution. Using TAQ intraday quotes, ISE account-level option open/close flow, and OptionMetrics standardized ATM 30-day options, the paper reports that short gamma exposure alone is not the full story; intraday momentum is materially stronger when the underlying has broken GTBR (Sec. 4.1-4.3, Tables 2-4, Figure 3). The paper also reports asymmetry on downside moves, stronger effects when active option traders themselves hold short gamma, and persistence in both expiry and non-expiry weeks (Sec. 4.4-4.9, Tables 5-10).

For `proompteng/lab`, the paper is relevant as a research-signal and empirical-evidence design, not as a direct production strategy. The repository already contains a trading/autonomy/evaluation stack under `services/torghut/app/trading/`, including research helpers, empirical manifests, backtests, evaluation, gates, and shadow/paper-trading promotion controls. What the repository does not contain is an authoritative options-market ingest path for TAQ, ISE account categories, or OptionMetrics-style Greeks/open-interest reference data. The viable implementation is therefore a deterministic offline research module that computes GTBR-style microstructure diagnostics and evidence artifacts; it is not a direct autonomous production-trading rollout.

## 2) Problem Statement

Existing intraday trading pipelines can observe price momentum, but they often cannot distinguish between ordinary momentum and intermediary-driven momentum caused by nonlinear hedging losses. This paper argues that short-gamma delta hedgers become effectively inelastic once price moves exceed a breakeven range defined by gamma losses versus theta gains, and that this state is a meaningful source of last-30-minute stock momentum.

## 3) Methodology Synthesis

## 3.1 Theory

1. Section 2 derives the daily hedging PnL from theta and gamma under a simplified Carr-Wu attribution.
2. GTBR is defined as the return magnitude where one-day theta offsets gamma loss:
   - `PnL_T = theta / 365 + 50 * Gamma * r^2`
   - `GTBR = +- sqrt((-theta / 365) / (50 * Gamma))`
3. Under Black-Scholes simplifications, Appendix A3 reduces this to approximately `+- sigma_imp / sqrt(365)`.
4. Section 2.3.2 separately derives a trader-side hedge trigger that depends on drift, impact, transaction cost, and remaining time; GTBR is presented as a special case / benchmark of this broader trigger.

## 3.2 Data and Identification

1. Underlying intraday returns:
   - TAQ midquotes at one-minute frequency, aggregated into half-hour return windows (Sec. 3.1).
2. Market maker gamma exposure:
   - estimated from ISE account-category open/close quantities.
   - paper follows Ni, Pearson, Poteshman, and White (2020) and proxies MM open interest as `-(Firm OI + Customer OI)` (Sec. 3.2).
3. GTBR proxy:
   - OptionMetrics standardized ATM forward option with interpolated 30-day tenor, used as a daily reference option for Greeks and implied volatility instead of full-book aggregation (Sec. 3.3).
4. Data handling details that matter for implementation:
   - first 250 days of cumulative OI are dropped because the initial cumulative state is not authoritative.
   - 1%/99% winsorization is applied to outliers (fn. 12).

## 3.3 Empirical Tests

1. Baseline regressions test whether the last 30 minutes' return loads on the first 30 minutes' return more strongly when:
   - MMs are short gamma,
   - GTBR has been breached by minute 360,
   - both conditions hold (Sec. 4.1, Tables 2-3).
2. Sorted tests examine cumulative GTBR breaches and normalized gamma exposure (Sec. 4.2, Table 4).
3. Decile tests normalize returns by GTBR to locate the inflection point directly (Sec. 4.3, Figure 3).
4. Additional splits examine active option traders, direction asymmetry, gamma source decomposition, expiry effects, and out-of-sample `R^2` (Sec. 4.4-4.9, Tables 5-10).

## 4) High-Signal Findings

1. GTBR is the paper's core explanatory variable, not just short gamma.
- In Table 2 column (4), the interaction on `r30_0 * D Short Gamma` is `0.71`, while `r30_0 * D GTBR hit360` is `0.96`, both statistically significant. The paper interprets this as GTBR breach adding more explanatory power than short gamma sign alone.

2. Short gamma loses explanatory power when GTBR is not breached.
- Table 3 shows the short-gamma interaction is insignificant when `D GTBR hit360 = 0` (`0.413`, `0.286`) and significant when `D GTBR hit360 = 1` (`0.900***`, `0.723**`).
- This is the strongest evidence that the paper's useful implementation unit is "gamma plus GTBR state," not raw short-gamma exposure.

3. The inflection point in the normalized-return view is around GTBR itself.
- Figure 3 reports a visible jump in the momentum coefficient around normalized return `= 1`, which the paper maps to the 67.7th percentile of the normalized-return distribution.

4. Long gamma acts as a reversion force when prices remain inside GTBR.
- Table 4 first row (`Cumul Hit GTBR360 = 0`) shows no meaningful momentum in the strongest short-gamma bucket and a significant reversion coefficient of `-1.25**` in the strongest long-gamma bucket.

5. Downside moves appear more sensitive than upside moves.
- Table 7 shows the short-gamma and GTBR-hit interactions are insignificant in the "first 30 minutes up" subsample, but significant in the "first 30 minutes down" subsample.

6. The paper contains an internal inconsistency in its predictive-evidence narrative.
- Section 4.9 states that all OOS `R^2` values are positive and even the lowest underlying-level OOS `R^2` is positive.
- Table 10 reports minimum OOS `R^2` values of `-1.21`, `-1.68`, `-1.31`, and `-1.71`.
- That contradiction lowers confidence in the strength of the paper's forecasting claim and must be treated as a blocking validation task before code promotion.

## 5) Novelty Assessment

1. Novel contribution: GTBR as a practical trigger variable.
- The paper's most implementable idea is not the general claim that short gamma matters; it is the explicit breakeven trigger linking option theta/gamma economics to a discrete market state.

2. Moderate novelty: account-category-based MM gamma proxy.
- Estimating MM positioning from ISE account categories is a concrete empirical design choice, but it relies on a proxy assumption rather than direct dealer inventory.

3. Lower novelty: predictive regression framing.
- The regression forms are standard extensions of prior intraday-momentum work. The novelty is mainly in the conditioning variable and the options-microstructure interpretation.

## 6) Repo Fit Assessment

## 6.1 What Already Exists in `proompteng/lab`

The repository already has relevant research and deployment scaffolding:

1. Trading research and evaluation primitives:
   - `services/torghut/app/trading/backtest.py`
   - `services/torghut/app/trading/evaluation.py`
   - `services/torghut/app/trading/empirical_manifest.py`
   - `services/torghut/app/trading/feature_quality.py`
2. Safety-gated runtime and promotion flow:
   - `services/torghut/app/trading/autonomy/lane.py`
   - `services/torghut/app/trading/autonomy/gates.py`
   - `services/torghut/app/trading/autonomy/policy_checks.py`
3. Existing whitepaper-driven trading research precedent:
   - `services/torghut/app/trading/autonomy/janus_q.py`
4. Minimal offline market-data helper surface already exists:
   - `services/torghut/app/trading/alpha/data_sources.py`

## 6.2 What Is Missing

1. No authoritative options-market ingest for the paper's required data:
   - no TAQ intraday quote pipeline in this repo for this research path,
   - no ISE account-category options holdings ingestion,
   - no OptionMetrics-style standardized Greeks/IV source.
2. No direct options inventory or Greek state in current trading runtime.
3. No current strategy contract in Torghut that executes "GTBR breach" as a standalone deployable signal with validated cost/risk assumptions.

## 6.3 Implementation Implication

The viable implementation is a research-only, deterministic feature pipeline that:

1. computes GTBR-like thresholds from authoritative option Greeks and implied volatility,
2. computes MM-gamma and cumulative GTBR-hit diagnostics,
3. emits empirical manifests and evaluation artifacts,
4. gates any shadow/paper-trading usage behind existing Torghut safety controls.

This paper does not justify direct live-strategy implementation from the current repository state.

## 7) Risks, Assumptions, and Unresolved Questions

## 7.1 Paper Risks

1. Data authority risk: high.
- The paper depends on proprietary/licensed sources (TAQ, ISE, OptionMetrics). Reproducing or operationalizing the result requires data contracts the repo does not currently expose.

2. Proxy risk: high.
- MM open interest is inferred as `-(Firm + Customer)`. That is useful empirically, but it is not direct dealer inventory.

3. GTBR simplification risk: medium-high.
- Using a standardized ATM 30-day option as the underlying-level GTBR reference is a tractable approximation, not a full option-book calculation.

4. Predictive-claim consistency risk: high.
- Section 4.9 contradicts Table 10 on the sign of minimum OOS `R^2`.

5. Causality / execution risk: high.
- The paper documents explanatory associations in intraday returns; it does not supply a deployable execution policy, risk budget, or transaction-cost model for autonomous trading.

## 7.2 Repository Risks

1. Data-model mismatch.
- Current Torghut trading surfaces are built around signal, feature, evaluation, and safety pipelines, but not around dealer-inventory or options-book state.

2. Licensing and provenance.
- Even a research implementation needs reproducible manifests proving which licensed options feeds generated each GTBR and gamma-exposure series.

3. Runtime overreach.
- Promoting a GTBR feature into live decisioning without first establishing research reproducibility would bypass the strongest evidence threshold the paper actually supports.

## 8) Viability Verdict

- Verdict: **conditional_implement**
- Score: **0.46 / 1.00**
- Confidence: **0.87 / 1.00**

Interpretation:

1. Implementable now:
- deterministic offline research feature engineering and empirical evidence generation inside `services/torghut/app/trading/`.

2. Not implementable now:
- direct production or autonomous deployment of a GTBR trading strategy from the current repo and evidence set.

## 9) Deterministic Implementation Plan

## M0: Data Authority Gate

1. Secure authoritative inputs for:
   - intraday underlying quotes,
   - option open-interest by account category,
   - per-option Greeks and implied volatility.
2. Add immutable manifest fields for feed source, licensing scope, version date, and checksum.
3. Reject execution if any GTBR series is derived from non-authoritative or mixed-source inputs.

## M1: Research Feature Module

1. Add a GTBR research module under `services/torghut/app/trading/alpha/` or `services/torghut/app/trading/microstructure.py` that computes:
   - daily GTBR,
   - GTBR-hit-by-minute,
   - cumulative GTBR hits,
   - normalized return by GTBR,
   - MM gamma sign and normalized exposure.
2. Emit deterministic manifests via `empirical_manifest.py`.

## M2: Evaluation Wiring

1. Extend offline evaluation to reproduce the paper's core checks:
   - baseline Table 2-style interaction regressions,
   - Table 3 conditional splits,
   - Table 4 cumulative-hit and gamma-bucket sorts,
   - Figure 3-style normalized-return deciles.
2. Store contradiction checks explicitly:
   - prose/table consistency assertions,
   - sign/range validation for OOS `R^2`.

## M3: Safety-Bounded Runtime Experiment

1. If M0-M2 pass, expose GTBR metrics as research evidence to the existing autonomy gate stack.
2. Permit only shadow or paper modes; do not enable live promotion.
3. Fail closed when:
   - data provenance is incomplete,
   - OOS metrics are unstable,
   - paper reproduction drifts from expected ranges.

## 10) Recommendation

Use this paper as a source for an options-microstructure research feature set inside Torghut, not as a production trading design. The smallest credible next step is a deterministic research implementation with licensed-data manifests and explicit consistency checks against the paper's reported tables.
