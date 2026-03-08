# Whitepaper Design: The Impact of Option Demand Shocks on Underlying Stock Prices

- Run ID: `wp-c5f9fd17f351f1f3100ed79a`
- Repository: `proompteng/lab`
- Issue: `https://github.com/proompteng/lab/issues/4230`
- Source PDF: `https://arno.uvt.nl/show.cgi?fid=192119&utm_source=chatgpt.com`
- Ceph object: `s3://torghut-whitepapers/raw/checksum/1d/1debf6b8b14a5ef368cd8fd25901d91ba3bbb65b39c59838e1aa28957b333810/source.pdf`
- Paper: `The Impact of Option Demand Shocks on Underlying Stock Prices`
- Author: `David Lawlor`
- Document type: `Master Thesis Finance`
- Dated: `2025-12-22`
- Reviewed end-to-end: yes (60 pages, title page + table of contents + main text + references)
- Review date (UTC): `2026-03-08`

## 1) Executive Summary

This thesis studies whether option demand shocks spill into next-day stock returns for 20 option-liquid U.S. equities from January 2020 through December 2022. The empirical design compares two demand proxies: Net Buy Pressure (NBP), intended to capture one-day option order-flow imbalance, and Net Open Interest (Net OI), intended to capture position accumulation. The claimed headline result is that NBP predicts next-day returns, the effect is stronger in high-VIX regimes, Net OI is largely uninformative, and the effect fades beyond one day.

The implementation verdict for this repository is **reject**. Two independent blockers drive that decision. First, the thesis is not internally reliable enough to support deterministic implementation: its own tables do not consistently support the narrative, core sample/threshold/unit definitions are contradictory, and the paper does not provide a reproducible code or data package. Second, the current repository does not contain the paper's required data substrate: Torghut has equity trading, simulation, and backtest infrastructure, but no WRDS/CRSP/OptionMetrics integration, no option-contract master/schema, and no option-order-flow/open-interest feature pipeline.

## 2) Paper Synthesis

### 2.1 Problem Statement and Hypotheses

The thesis asks whether demand shocks in the equity options market affect underlying stock prices, and whether that effect is stronger in high-volatility periods. The stated hypotheses are:

1. Option demand shocks have a statistically significant positive effect on underlying stock returns.
2. The positive effect is stronger in high-volatility markets than in low-volatility markets.

Evidence: Sec. 1.1-1.4 (pp. 4-9), Sec. 4 (p. 29).

### 2.2 Data and Variables

- Universe: 20 large, option-active U.S. equities.
- Sample window: January 2020 to December 2022.
- Data sources claimed: CRSP daily stock data, OptionMetrics Ivy DB options data, and CBOE VIX via WRDS.
- Main variables:
  - `NBP`: buyer-initiated minus seller-initiated option volume.
  - `Net OI`: daily change in total option open interest.
  - `HighVol`: VIX-based dummy intended to separate volatile from calm periods.

Evidence: Sec. 1.2-1.3 (pp. 5-7), Sec. 3.2-3.5 (pp. 19-24), Sec. 5.1-5.2 (pp. 30-32).

### 2.3 Empirical Method

The core empirical model is a next-day panel regression of stock return on lagged option-demand proxies plus controls for lagged return, lagged absolute return, and a volatility-regime dummy. The thesis reports pooled OLS, firm-fixed-effects panel regressions, and firm-by-firm regressions, then adds a high-VIX interaction and separate regime splits.

Evidence: Sec. 5.3 (pp. 32-35).

### 2.4 Reported Results

- Table 2 reports positive NBP coefficients across baseline specifications, but they are not statistically significant in the displayed baseline and firm-fixed-effects models.
- Net OI is described as insignificant, but the corresponding table is not shown.
- Table 3 reports larger positive NBP coefficients in the high-VIX subsample and near-zero or negative coefficients in the low-VIX subsample; the reported high-VIX coefficients are still not conventionally significant.
- The discussion claims the NBP effect fades over longer horizons, which the author interprets as temporary price pressure rather than durable information.

Evidence: Sec. 6.2-6.5 (pp. 37-47), Sec. 7.1 (pp. 50-52).

## 3) Evidence Quality and Internal Consistency Risks

### 3.1 Narrative Overstates Statistical Support

The largest implementation blocker from the paper itself is that the narrative claims significance where the displayed tables do not. Table 2 shows NBP coefficients of `0.031`, `0.026`, `0.026`, and `0.026` with standard errors of roughly `0.026-0.027`, which are not statistically significant at conventional levels. Yet Sec. 7.1 states that NBP "emerged as a significant positive predictor of next-day stock returns." That is not supported by the displayed regression table.

Evidence: Table 2 and associated discussion (pp. 38-40) versus Sec. 7.1 (pp. 50-51).

### 3.2 Regime Definition Is Contradictory

Sec. 3.5 defines `HighVol` as `VIX > 20` and states that about 70% of the sample days are high-volatility days. Sec. 5.2 later says the threshold is set so that roughly the top quartile of VIX observations are classified as high-volatility days. Those statements cannot both be true for the same sample. Table 3 sample counts (`10,279` high-VIX observations versus `4,251` low-VIX observations) are consistent with the 70% split, not a top-quartile split.

Evidence: Sec. 3.5 (pp. 23-24), Sec. 5.2 (p. 32), Table 3 (p. 41).

### 3.3 Observation Counts Are Inconsistent

The thesis reports several incompatible sample sizes:

- `14,553` stock-day observations in Sec. 3.3.
- `14,520` observations in Table 1.
- `14,529` observations in Table 2.

The paper does not explain these differences, missing-data filters, or why counts vary by table. That breaks deterministic reproduction.

Evidence: Sec. 3.3 (p. 20), Table 1 (pp. 25-26), Table 2 (p. 38).

### 3.4 Variable Units and Scaling Are Unclear

Sec. 3.4 describes NBP as net option contracts and states that the median is about `1.85 thousand contracts`, while Table 1 later reports NBP with mean `0.0021`, standard deviation `0.0563`, minimum `-0.245`, and maximum `0.273`. The table does not explain the scaling transformation even though the surrounding text still describes contract counts. The same problem appears in the interpretation of Table 2, where the regression discussion shifts into "millions of contracts" units without defining the exact scaling in the table.

Evidence: Sec. 3.4 (pp. 20-22), Table 1 (p. 25), Sec. 6.2 discussion of Table 2 (pp. 38-39).

### 3.5 Firm-Level Robustness Table Does Not Match Its Narrative

Table 4 is presented as a summary of firm-by-firm regressions, but the table structure and values do not cleanly support the accompanying prose. The reported mean coefficient is negative (`-0.0168`), while the text says the majority of firms exhibit a positive coefficient. The paper does not include the per-firm coefficient list needed to resolve the contradiction.

Evidence: Table 4 and Sec. 6.4 discussion (pp. 43-45).

### 3.6 Reproducibility Is Inadequate

The thesis does not provide code, regression scripts, data snapshots, contract-level feature-construction logic, or deterministic extraction/cleaning rules. Because the underlying data sources are licensed academic datasets, the absence of precise transformation code and data-version metadata is a hard blocker for reproduction.

Evidence: entire document, especially Sec. 3-6 (pp. 18-49) and references (pp. 58-59).

## 4) Repo Fit Assessment

### 4.1 Reusable Infrastructure That Already Exists

The repository is not empty on the quant side. `services/torghut` already provides:

- equity trading and execution infrastructure,
- offline backtest and evaluation helpers,
- walk-forward and historical simulation scripts,
- market-context and TCA primitives,
- governance and research-ledger style workflows.

Concrete pointers:

- `services/torghut/app/trading/backtest.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/app/trading/simulation.py`
- `services/torghut/app/trading/market_context.py`
- `services/torghut/scripts/run_walkforward.py`
- `services/torghut/scripts/start_historical_simulation.py`
- `docs/torghut/system-design.md`

### 4.2 Missing Substrate Required by This Paper

The thesis depends on option-native data and schemas that the repo does not currently have:

1. licensed WRDS/CRSP/OptionMetrics ingestion,
2. option-contract master data (symbol, strike, expiry, type),
3. buyer/seller-initiated option trade flow,
4. stock-level open-interest aggregation by day,
5. options-specific fields such as greeks and implied volatility if the method is extended,
6. deterministic joins between option records, stock returns, and VIX regime data.

Current Torghut code is equity/crypto and bar/signal oriented rather than option-contract oriented. That means the paper cannot be implemented as a reviewable production change without first building an entirely new data plane.

## 5) Viability Verdict

- Verdict: **reject**
- Score: **0.22 / 1.00**
- Confidence: **0.87 / 1.00**
- Blocked stage: **implementation_viability_assessment**

Rationale:

1. The thesis does not establish a reproducible or statistically reliable signal strong enough to justify implementation.
2. The repository lacks the paper's required options data model and ingestion stack.
3. Even a research-only implementation would first need licensed datasets, deterministic replication code, and clarified feature definitions.

## 6) Smallest Unblocker

If the organization wants to pursue this topic anyway, the smallest credible next step is not implementation of the thesis result. It is a replication lane:

1. Acquire explicit access rights for CRSP and OptionMetrics (or a viable commercial alternative).
2. Define an option-contract and stock-day schema in Torghut for order-flow and open-interest features.
3. Reproduce the paper's tables with deterministic code, exact filters, and frozen data snapshots.
4. Only after replication succeeds, decide whether NBP-style features belong in a Torghut research workflow.

## 7) Evidence Map

1. Research question and motivation: Sec. 1.1-1.4, pp. 4-9.
2. Literature channels (informational vs mechanical hedging): Sec. 2.1-2.3, pp. 10-17.
3. Data sources and variable definitions: Sec. 3.2-3.5, pp. 19-24.
4. Summary-statistics inconsistencies: Table 1, pp. 25-26.
5. Hypotheses: Sec. 4, p. 29.
6. Regression design: Sec. 5.2-5.3, pp. 31-35.
7. Baseline results and significance gap: Table 2 plus discussion, pp. 38-40.
8. High/low VIX split and threshold inconsistency: Sec. 3.5, Sec. 5.2, Table 3, pp. 23-24, 32, 41-42.
9. Firm-level robustness inconsistency: Table 4 and Sec. 6.4, pp. 43-45.
10. Claimed conclusions and limitations: Sec. 7.1-7.4, pp. 50-56.
