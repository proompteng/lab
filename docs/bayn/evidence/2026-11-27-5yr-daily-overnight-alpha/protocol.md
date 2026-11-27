# Wave 2A pre-registration: daily and overnight SIP

**Research only.** No policy hash, migration, runtime binding, order or capital grant changes. This protocol is
registered before measuring candidate P&L. Zero survivors is a valid result; it is not permission to search
the same holdout again.

## Tape and chronology

- Pin the 87,727-row gzip at `bayn-research-datasets/2026-11-27-sip-multiyear/alpaca_sip_daily_62sym_20210104_20261125.tsv.gz`
  in `agents-artifacts`, SHA-256 `e8023075922737f98d9a792267bb02940246971918387a877be92c2ad443b247`.
  Require exactly the 62 named symbols, one bar per symbol/session, valid OHLCV/VWAP, and 1,482 SPY sessions.
  Use the observed SPY dates as the session index; do not forward-fill prices or bridge missing observations.
- Train: 2021-01-04 through 2024-06-30; Validation: 2024-07-01 through 2025-08-31; Frozen Holdout:
  2025-09-01 through 2026-11-25, inclusive. Each split starts flat, can warm signals from earlier observations
  and liquidates at its last eligible event (Open for open-to-open/overnight, Close for close-to-close/intraday).
  No scored trade or realized label spans a split boundary. Earlier split returns do not seed ensemble risk.
- The 50 requested names contain 46 common stocks/ADRs and four ETFs (SPY, QQQ, SMH, IWM). The exact
  Bayn v2 Morning/Midday basket has 18 names: 17 stocks and IWM. The ETF exclusion sensitivity runs on the
  46 and 17 actual stocks, not invented additions. ETF-only trials use all 16 ETFs and repeat on the four
  supplied live ETFs; a 3+3 basket on four is a recorded structural rejection, not a smaller substitute basket.
- First eligible dates: COIN 2021-04-14, APP 2021-04-15, SOFI 2021-06-01, HOOD 2021-07-29, CRDO 2022-01-27,
  CEG 2022-02-02, COHR 2022-09-08, ARM 2023-09-14, ALAB 2024-03-20, GEV 2024-04-02, SNDK 2025-02-24.
  Drop SOFI predecessor and SNDK when-issued bars; lack of security identifiers prevents using pre-change COHR.
  Close WDC positions at the 2025-02-21 close, disallow WDC entries across the distribution, and reset WDC return
  and volume windows on 2025-02-24. No synthetic dividend or split payout is credited.
- No point-in-time universe or locate tape is supplied. The universe was chosen retrospectively. Returns use
  split-adjusted prices, without dividends, short distribution liabilities, hard-to-borrow rates, long margin interest, taxes, auction
  imbalance, or quote/size checks. A 10 bp pass would be a research result, not proof of realizable fills.

Issuer and filing sources: [COIN](https://www.sec.gov/Archives/edgar/data/1679788/000167978824000022/coin-20231231.htm),
[APP](https://investors.applovin.com/files/doc_financials/2024/q4/AppLovin-Corporation-10K-FY24_As-Filed.pdf),
[SOFI](https://investors.sofi.com/resources/investor-faqs/default.aspx?LanguageId=1),
[HOOD](https://www.sec.gov/Archives/edgar/data/312070/000095010325015706/dp238351_424b2-8131barc.htm),
[CRDO](https://investors.credosemi.com/resources/investor-faqs/default.aspx),
[CEG](https://investors.constellationenergy.com/news-releases/news-release-details/constellation-launches-largest-us-clean-energy-company-after),
[COHR](https://www.coherent.com/news/press-releases/ii-vi-changes-name-to-coherent-and-launches-new-brand),
[ARM](https://newsroom.arm.com/news/arm-announces-closing-of-initial-public-offering),
[ALAB](https://ir.asteralabs.com/static-files/39f0033e-b86e-4f5f-9ee1-c6de3c2fc7f3),
[GEV](https://www.gevernova.com/news/press-releases/ge-vernova-completes-spin-off-begins-trading-new-york-stock-exchange),
[SNDK](https://investor.sandisk.com/news-releases/news-release-details/sandisk-celebrates-nasdaq-listing-after-completing-separation),
[WDC](https://www.westerndigital.com/company/newsroom/press-releases/2025/2025-02-24-western-digital-completes-planned-company-separation).

## Registry (Cartesian products within each row)

| Family                         | Registered signals and parameters                                                                                                                                                                                                                                                                                                                                          | Execution                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1. Residual overnight momentum | Overnight log-return beta/residual vol over 40/60 sessions, 3/5/10 residuals, K=3/5/8 per side, inverse-residual-vol weights; 0.5x gross budget                                                                                                                                                                                                                            | Close to next Open; repeat with signal lagged one Close for pre-submittable MOC                             |
| 2. Residual multi-day momentum | Close-to-close log-return beta/vol over 60 sessions, 5/10/20/60 residuals, skip=0/1, K=4/6/8, rebalance every 3/5/10 sessions, equal initial dollars per side, 10% annual risk target                                                                                                                                                                                      | Same-Close to Close; previous-Close signal at next Open to Open                                             |
| 3. Residual reversal           | 40-session Close beta/vol, reverse 1/2 residuals, K=5, rebalance every 1/2/3 sessions; unfiltered and 2.5x prior-20-session average volume veto. Intraday variants use the same preceding-Close residuals plus a confirming opposite-signed trade/price-gap direction (prior observable overnight gap or current gap with a hypothetical Open fill), rebalance daily       | Close to Close; previous-Close signal at next Open to Close; realized-current-gap Open fill diagnostic only |
| 4. ETF trend and rotation      | 10/20/60 Close log-return sum, divided by 20-session volatility; signed time-series trend (all ETFs, inverse vol) or equal-dollar 3+3 relative strength, 5-session rebalance, 10% annual risk target                                                                                                                                                                       | Same-Close to Close; previous-Close signal at next Open to Open                                             |
| 5. Risk-parity ensemble        | For each expanded/live and mixed/stock-only cohort, select the Train leader from each family among pre-submittable variants; combine with inverse trailing standalone daily net-return vol over 15/20/30 sessions. Register a Train-leader diagnostic and a survivors-only ensemble (family incumbents can be vetoed, never replaced). At least two families are required. | Each sleeve retains its execution event; actual costs applied to net orders.                                |

Motivation, not replications: [Lou–Polk–Skouras](https://personal.lse.ac.uk/polk/research/TugOfWar.pdf),
[Blitz–Huij–Martens](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2319883),
[Moskowitz–Grinblatt](https://doi.org/10.1111/0022-1082.00146),
[Avellaneda–Lee](https://math.nyu.edu/inmemoriam/avellaneda/AvellanedaLeeStatArb20090616.pdf),
[Lehmann](https://www.nber.org/papers/w2533),
[Moskowitz–Ooi–Pedersen](https://doi.org/10.1016/j.jfineco.2011.11.003) and
[Moreira–Muir](https://www.nber.org/papers/w22208).

OLS beta uses trailing paired returns with centered covariance; residuals are `ri − beta × rSPY`, with no
deducted intercept. Skipped returns are excluded from both signal and residual fit. Require continuous input
windows and both full sides; lexical symbol ties. A gap-confirmed reversal needs positive residual and gap
for shorts, negative for longs. Standalone risk scaling uses the trailing 20-session sample vol of the
target-weighted Close return basket; cap its target gross at 1.5x. Ensemble risk uses up to the specified
number of earlier completed split sessions; use equal weights until all components have a complete window
and floor daily vol at 5 bp thereafter. Plans stay anchored to the absolute SPY session index.

Same-Close rebalance uses the official close for both the signal and fill, so it is a **hypothetical MOC**
benchmark, not submittable at the official close. Same-Open gap fills are likewise diagnostic. Lagged MOC
and next-Open entries fix desired shares using the preceding Close (not the auction fill price). Open-to-Open
and overnight flatten at the final Open; liquidation at a known time does not require the liquidation price
to generate the order. Fractional shares and auction prints are model assumptions.

## Accounting and inference

Mark shares at each Open/Close and record P&L at session Close, including zero/cash days. Compare additive
daily dollars on a fixed $100,000 notional; target/share sizing does not compound. Charge half of each
2/5/10/20 bp round trip on absolute traded notional (including net changes and boundary liquidation), 0.21 bp
on every sell, and 1.5% actual/365 calendar-day borrow on prior Close net short notional, including weekends.
Intraday-only shorts have no overnight borrow. Use exact observed marks; a missing held or execution print
invalidates the trial. Ensemble risk weights are applied to sleeve targets/marked allocations at planned trade
events before netting; cap planned aggregate gross at 1.8x and report realized gross drift separately.

At all costs report net, ex-top-five, Sharpe and drawdown; at 10 bp report five-session circular, mean-centered
block-bootstrap p-value (10,000 draws, fixed seed, one-sided), [Bailey–López de Prado
DSR](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf), LOSO (rerun ranks, sizing, positions and costs
after each symbol exclusion; SPY may remain the reference), calendar year 2021–2026 and concurrent up/nonnegative
SPY vs down-SPY Close-return splits, SPY beta, Calmar and turnover. The DSR null uses Train dispersion of daily
Sharpes and the full registered count (each parameter/cohort variant including structurally rejected trials and
ensemble slots; other costs and robustness checks are not selection trials). No effective-N discount. Use the
same Train-derived DSR benchmark on Validation and Holdout. Bootstrap complements DSR's non-IID limitations;
neither addresses survivorship or data mining outside this registry.

Adjacent neighbors change one ordered numeric value or toggle the one skip/filter at a time; execution and
universe are separate controls, not neighbors. An ensemble varies only its risk window; membership is held fixed.
Plateau passes if at least two neighbors are available and at least two-thirds clear positive 10 bp net,
positive ex-top-five, and at least 50% of the center's Sharpe on the given split.

## Selection and stop rule

1. Rank using Train only. At 10 bp, require positive net and ex-top-five, annualized Sharpe >= 1, one-sided
   BootP < 0.05, DSR >= 0.95 (Train and Holdout), minimum LOSO net > 0, positive plateau, at least 60 exposed
   sessions and mean one-way daily turnover <= 0.50. Reject realized gross >1.8x or diagnostic execution for
   promotion. Turnover divides absolute traded dollars by two and by starting capital.
2. Standalone freeze slots: highest Train-ranked pre-submittable incumbent, and next highest of a distinct
   family (both across all cohorts). Rank Train gate passes first, then annualized Train Sharpe, then lexical ID.
   If at least two expanded mixed-cohort family incumbents pass Train, reserve slot two for the 20-session
   survivors-only ensemble instead. Family incumbents are Train-ranked the same way in each cohort (ETF
   sleeves use the corresponding ETF cohort); Validation only vetoes incumbents and never supplies replacements.
   The ensemble is unviable if fewer than two components survive. Diagnostic Train ensembles are never promoted.
3. Rank standalones against the Train-only standalone Sharpe dispersion with the full registered count.
   Use the final Train dispersion including measured ensemble slots for the final gates, without re-ranking.
   Validation applies the same economic checks (DSR reported but not a Validation gate); no re-ranking,
   substitution, parameter changes, or membership additions. Freeze at most two IDs, including rejected
   incumbents for diagnostic Holdout only. Commit the development-only receipt and ledger before scoring.
4. Holdout scores only frozen finalists, their registered cohort counterparts, and fixed one-step plateau and
   LOSO probes; no other trial opens the holdout. Apply the same gates to the promoted cohort, with only the
   two frozen finalists eligible. Keep unscored and rejected trials in the ledger. A failed Holdout cannot
   be retried with a changed protocol. Build pure v3/v4-ready modules only for actual survivors.
