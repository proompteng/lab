# Wave 20D: 10-year rates and credit defensive rotation

**DO NOT PROMOTE.** The stress switch had positive full-period net returns at every tested cost, but it
failed both promotion routes at every cost. It lost money and lagged SHY in 2022–2023, and its later
rebound did not establish statistically reliable pooled out-of-sample (OOS) excess. Adding it at 25% to F4/O1/B0
lowered Sharpe in both forward folds, even at zero spread.

- At **5 bp round-trip**, the stress switch earned **2.01% CAGR, 0.283 Sharpe and 25.69% MaxDD**.
  SHY earned **1.69% CAGR, 1.084 Sharpe and 5.70% MaxDD**. The switch reduced volatility versus plain
  relative strength (8.25% vs 9.19%), but raised annual one-way turnover from **14.99× to 23.14×**
  and had higher full-period drawdown. It rebalanced 464 times versus 319 for the ablation.
- The 25% allocation cut the Bayn portfolio's full-period MaxDD from **9.22% to 8.11%**, but Sharpe
  fell from **1.339 to 1.119** and Calmar from **0.722 to 0.682**. In pooled OOS, Sharpe fell **0.242**
  and the paired 97.5% lower bound was **−0.549**. Sleeve correlation with the Bayn base reached
  **0.586** in the second fold, above the registered 0.50 ceiling.
- At 5 bp, the SPY-only and B0-only blends had positive OOS Sharpe, Calmar and drawdown improvements
  as point estimates. Their paired lower bounds were negative; neither supplied reliable evidence of
  a diversification benefit. The base that already contained all four controls also lost OOS Sharpe.

The runner, rules and gates were [committed before scoring](https://github.com/proompteng/lab/commit/1f0602e7c8fbd74901683e78d4d6c32167940779).
The [machine-readable results](results.json) contain the source hashes, comparator receipts, both rules,
all four cost tiers, and every standalone, control and blend window and yearly return.

## Findings

### Full sample at 5 bp round-trip

Bayn is equal-weight F4/O1/B0; SPY+Bayn is equal-weight across all four named controls. A sleeve
allocation replaces 25% of its base. Turnover is one-way notional per year as a multiple of NAV.

| Path              | CAGR   | Ann. vol | Sharpe | Sortino | Calmar | MaxDD  | Turnover |
| ----------------- | ------ | -------- | ------ | ------- | ------ | ------ | -------- |
| SHY               | 1.69%  | 1.56%    | 1.084  | 1.687   | 0.296  | 5.70%  | 0.05×    |
| SPY               | 14.10% | 17.56%   | 0.841  | 1.182   | 0.417  | 33.79% | 0.05×    |
| F4                | 7.14%  | 5.66%    | 1.248  | 1.741   | 0.712  | 10.04% | 0.80×    |
| O1                | 6.21%  | 6.96%    | 0.903  | 1.239   | 0.301  | 20.65% | 2.49×    |
| B0                | 6.23%  | 8.52%    | 0.753  | 1.211   | 0.591  | 10.55% | 103.44×  |
| Bayn              | 6.66%  | 4.91%    | 1.339  | 2.048   | 0.722  | 9.22%  | 35.83×   |
| SPY+Bayn          | 8.71%  | 7.03%    | 1.226  | 1.848   | 0.589  | 14.78% | 27.07×   |
| Stress switch     | 2.01%  | 8.25%    | 0.283  | 0.386   | 0.078  | 25.69% | 23.14×   |
| Relative strength | 2.52%  | 9.19%    | 0.318  | 0.434   | 0.119  | 21.16% | 14.99×   |
| Bayn + switch     | 5.53%  | 4.93%    | 1.119  | 1.656   | 0.682  | 8.11%  | 32.74×   |
| SPY+Bayn + switch | 7.08%  | 6.12%    | 1.150  | 1.700   | 0.589  | 12.01% | 26.19×   |

### Cost stress and forward evidence

The first two metric pairs are full-period standalone. Bootstrap p tests the mean daily excess over SHY in
pooled OOS; the last two columns compare the primary 25% blend against unmodified Bayn over those same days.

| RT bp | Switch CAGR | Switch Sharpe | Ablation CAGR | Ablation Sharpe | Switch excess p | Bayn Sharpe Δ | Lower 97.5% bound |
| ----- | ----------- | ------------- | ------------- | --------------- | --------------- | ------------- | ----------------- |
| 0     | 3.20%       | 0.424         | 3.29%         | 0.399           | 0.103           | −0.291        | −0.603            |
| 2     | 2.72%       | 0.368         | 2.98%         | 0.367           | 0.128           | −0.271        | −0.583            |
| 5     | 2.01%       | 0.283         | 2.52%         | 0.318           | 0.172           | −0.242        | −0.549            |
| 10    | 0.84%       | 0.143         | 1.76%         | 0.236           | 0.259           | −0.192        | −0.495            |

At 5 bp, the later fold's positive excess had nominal p = 0.045, while the confirmatory pooled
test gave p = 0.172. The first fold had negative excess even at 0 bp. Bayn's point gains in
the later fold's Calmar did not carry over to Sharpe or the first fold.

| Forward window | Switch net | Switch Sharpe | Excess vs SHY (pp) | Bootstrap p | Bayn Sharpe Δ | Bayn Calmar Δ | Bayn DD reduction (pp) | Sleeve–Bayn corr. |
| -------------- | ---------- | ------------- | ------------------ | ----------- | ------------- | ------------- | ---------------------- | ----------------- |
| 2022–2023      | −8.85%     | −0.539        | −8.97              | 0.848       | −0.522        | −0.943        | −0.17                  | 0.397             |
| 2024–Nov 2026  | +40.49%    | 1.166         | +29.75             | 0.045       | −0.096        | +0.079        | −0.07                  | 0.586             |
| Pooled OOS     | +28.06%    | 0.574         | +17.18             | 0.172       | −0.242        | −0.282        | −0.07                  | 0.519             |

### Other 25% blends, pooled OOS at 5 bp

Changes are relative to the named base; a positive drawdown reduction means a shallower loss.
No paired lower bound was positive for either rule, at any cost, in either forward fold or pooled OOS.

| Base     | Sleeve corr. | Sharpe Δ | Calmar Δ | DD reduction (pp) | Sharpe Δ lower 97.5% bound |
| -------- | ------------ | -------- | -------- | ----------------- | -------------------------- |
| SPY      | 0.127        | +0.075   | +0.039   | +4.14             | −0.069                     |
| F4       | 0.625        | −0.166   | −0.254   | −0.72             | −0.429                     |
| O1       | 0.600        | −0.085   | −0.150   | −0.34             | −0.347                     |
| B0       | 0.052        | +0.101   | +0.039   | +0.97             | −0.163                     |
| Bayn     | 0.519        | −0.242   | −0.282   | −0.07             | −0.549                     |
| SPY+Bayn | 0.368        | −0.047   | −0.099   | +0.30             | −0.318                     |

### Calendar-year returns at 5 bp

| Year            | Stress switch | Relative strength | SHY    | SPY     | Bayn   | Bayn + switch |
| --------------- | ------------- | ----------------- | ------ | ------- | ------ | ------------- |
| 2016            | −6.15%        | −5.98%            | 0.59%  | 13.27%  | 1.09%  | −0.75%        |
| 2017            | −2.84%        | 1.38%             | 0.26%  | 21.75%  | 5.36%  | 3.27%         |
| 2018            | −4.00%        | −4.86%            | 1.46%  | −4.96%  | 3.36%  | 1.50%         |
| 2019            | 12.15%        | 10.24%            | 3.39%  | 31.14%  | 5.75%  | 7.35%         |
| 2020            | 10.77%        | 8.88%             | 3.03%  | 18.45%  | 2.58%  | 4.67%         |
| 2021            | −10.76%       | −4.56%            | −0.71% | 28.60%  | 9.42%  | 4.02%         |
| 2022            | −10.46%       | −10.30%           | −3.88% | −18.18% | 7.46%  | 2.72%         |
| 2023            | 1.79%         | 1.32%             | 4.17%  | 26.18%  | 7.24%  | 5.90%         |
| 2024            | 11.26%        | 10.96%            | 3.92%  | 24.89%  | 8.10%  | 8.93%         |
| 2025            | 27.05%        | 28.09%            | 4.95%  | 17.72%  | 12.49% | 16.04%        |
| 2026 to Nov. 25 | −0.62%        | −2.23%            | 1.54%  | 5.93%   | 10.23% | 7.50%         |

## Audit and reproduction

The verified base and locally staged TIP input supplied all 2,741 open and close marks for each admitted ticker.
No missing sleeve observations were filled. The comparator audit reproduced full-period F4 net **+111.11%**
at 10 bp and O1 net **+94.43% / +92.87% / +90.29%** at 2/5/10 bp, respectively. B0 reproduced fixed-capital
P&L **+$103,533.58 / +$69,780.16** at 2/5 bp. Its one documented missing held bar was on 2016-02-02:
the existing B0 replay skipped the missing bar without inventing a price. There were no missing B0 entries
or unresolved exits. The gap precedes both OOS folds.

From the repository root with artifact read access, stage the pinned
Wave 13C supplement privately, then write and compare a new result. The runner authenticates the staged
manifest, gzip bytes, and decoded tape before use.

```sh
study=$(mktemp -d)
trap 'rm -rf "$study"' EXIT
(
  cd services/bayn
  bun -e '
    import { NodeRuntime } from "@effect/platform-node"
    import { withArchive } from "./tools/noise-area-study-data"
    const dir = Bun.argv[1]
    const prefix = "bayn-research-datasets/2026-11-27-sip-10yr-sp100-supplement-tip"
    NodeRuntime.runMain(withArchive(async ({ open }) => {
      for (const name of ["MANIFEST.json", "tip.tsv.gz"])
        await Bun.write(dir + "/" + name, await open(prefix + "/" + name))
    }))
  ' "$study"
)
bun services/bayn/tools/research-10yr-rates-credit-rotation.ts --tip-dir "$study" --output "$study/score.json"
bunx oxfmt --config .oxfmtrc.json "$study/score.json"
cmp "$study/score.json" docs/bayn/evidence/2026-11-28-10yr-rates-credit-rotation/results.json
```

## Preregistered protocol

**Question.** Can a fully funded daily ETF rotation earn positive net risk-adjusted returns above short Treasuries,
or improve the existing Bayn research portfolio's Sharpe, Calmar, and drawdown at a fixed capital weight?

### Data and walk-forward evaluation

- Admit only the frozen SIP total-return daily marks from `bayn-research-datasets/2026-11-27-sip-10yr-sp100/`
  for TLT, IEF, SHY, HYG, LQD, GLD and the SPY comparator. Admit TIP only from the existing Wave 13C local
  research input, staged from its pinned [SIP supplement](../2026-11-27-10yr-orthogonal-pillar3/README.md#inputs-and-development-freeze).
  All seven sleeve tickers require full session coverage. BIL and SGOV are excluded: neither is in the
  verified base manifest or the staged local inputs. SHY is a traded Treasury ETF, not a cash proxy with fabricated yield.
  The pinned DIA/UUP supplement and B0 5-minute tapes are comparator inputs only.
- Use the complete 2,741-session intersection: 2016-01-04 through 2026-11-25 (2026 is partial).
  The dates must match the pinned exchange calendar exactly. Use 2016–2021 as the reference/warm-up
  fold (1,511 sessions), 2022–2023 as forward fold 1 (501), and 2024–2026 as forward fold 2 (729).
  Also report both forward folds pooled, the full span and all calendar-year returns. Rules, parameters
  and weights are fixed, not fitted in either fold. Carry positions and history across boundaries,
  without resetting held assets or applying an end-of-sample liquidation.
- These are chronological out-of-sample (OOS) tests of fixed rules, not prospective or previously unseen market data.
  Other Bayn studies used these markets and dates. The bootstrap addresses serial dependence, not research-wide
  selection bias. No asset, year, or rule is removed based on performance.

### Registered rules and execution

1. **Stress switch (primary):** Each session after 126 prior sessions, give each of TLT, IEF, TIP, HYG,
   LQD and GLD a score equal to its mean 21/63/126-session close-to-close log return minus SHY's at the same horizons.
   Only positive scores are eligible. Allocate 50% each to at most two eligible assets; any unfilled slot goes to SHY.
   In stress, only IEF and GLD remain eligible. Stress means the 63-session HYG/IEF ratio fell or SPY lost at least
   5% over 21 sessions. Outside stress, TLT is eligible only when the 63-session TLT/IEF ratio rose.
   These are market-price proxies for credit and duration, not measured yield-curve slopes or option-adjusted spreads.
2. **Relative strength (ablation):** Same scores, ranks, weights and execution; no credit, equity or curve filters.
   This rule is diagnostic and cannot qualify for promotion.

An eligible incumbent receives a 50 bp ranking advantage (in blended log-return units); remaining exact ties
use the registered order above. A rebalance requires at least 10 percentage points of buys or sells in aggregate
against actual prior-close weights. A falling score that becomes ineligible loses the ranking advantage.
Initialize in SHY at the first open and remain there through warm-up. Decisions use only completed closes
through session **t**; fill at the next exchange-session open. Old shares take the overnight gap; new shares
earn only after their fill. There is no close fill on the signal date or same-day open-price trigger.

Replay fractional, long-only shares at adjusted marks; no leverage, shorts, injected yield or fabricated quotes.
Stress **0, 2, 5 and 10 bp round-trip** by charging half the quoted bps on each buy or sell, plus the existing
0.21 bp sell fee for comparability to F4/O1/B0. Thus 0 bp RT is zero spread/slippage, not zero statutory cost.
Pay entry friction on SPY and SHY; do not charge an unexecuted liquidation. Costs for existing sleeves use
their original replay conventions.

### Controls, portfolio construction and metrics

- Audit [F4](../2026-11-27-10yr-vol-regime-carry/README.md) as the fixed Wave 5C SHY-idle
  `F4-42-1-LQD-parity` replay, and [O1](../2026-11-27-10yr-pure-etf-dual-horizon/README.md) as the Wave 4D
  base ensemble with SHY sweep. Reproduce F4's 10 bp RT published folds and full period and O1's 2/5/10 bp
  RT published full-period returns.
- Audit [B0](../2026-11-27-10yr-qqq-smh-conditioning/README.md) as the Wave 6A QQQ/SMH
  `B0/30/1.4/opposite_band/inverse_vol_parity` control using original fixed $100,000 sizing and zero return
  on idle cash. Reproduce the 2/5 bp RT published net P&L by fold and overall; require no unresolved exits,
  no missing entries and exactly the one documented skipped held bar. For blended and comparable
  compounded metrics, use each day's P&L divided by $100,000, not the original fixed-dollar wealth curve.
- Build a primary equal-weight F4/O1/B0 portfolio and a secondary equal-weight SPY/F4/O1/B0 portfolio.
  For each and for each individual SPY/F4/O1/B0 leg, replace 25% of the base's capital with the candidate,
  funding it proportionally from the base. Compare to the exact same base without the sleeve.
  Stacks reset weights daily at the prior close and pay half the RT bps on gross capital transfers.
  They include the component trading costs, with no cross-sleeve netting, buying-power offsets or
  inferred shared fills. This is a historical allocation diagnostic, not a joint order simulator.
- All portfolio paths are matched close-to-close (first session begins at its open). Compound NAV; use elapsed
  calendar years for CAGR, daily sample volatility scaled by √252, zero-risk-free-rate Sharpe, zero-target
  Sortino, and Calmar = CAGR/MaxDD. MaxDD is the positive peak-to-trough loss, including starting capital
  as a potential peak. One-way turnover is half the absolute traded notional over NAV, annualized at 252
  sessions; for B0 use its cost slope to infer turnover, and include transfers in blend turnover.
  Report the standalone sleeve's daily Pearson correlation with each unmodified base.
- Use the shared circular stationary block bootstrap with 10,000 draws, mean block length 10 sessions and
  seed `0x20d5a11`. Use identical draws within each matched comparison, a one-sided centered mean test on
  daily sleeve-minus-SHY return, and a one-sided 97.5% basic lower bound on paired Sharpe lift (not the Sharpe
  of the excess series). Score both forward folds, the pooled OOS period and the full span (descriptive).
  Null means undefined or not tested.

### Promotion gates

At every registered cost the **primary rule** must pass the same route. The two confirmatory routes each
use one-sided 2.5% inference; the ablation, alternative bases and full-period results are descriptive.

- **Standalone:** Positive CAGR and Sharpe and positive compounded return difference versus SHY in
  both forward folds, plus pooled OOS mean-excess bootstrap p < 0.025.
- **Portfolio:** At the fixed 25% allocation in the F4/O1/B0 blend, improve Sharpe and Calmar, reduce
  MaxDD, and have absolute sleeve–base correlation below 0.50 in both forward folds; the pooled OOS
  lower bound on Sharpe lift must exceed zero.

If neither route passes, report **DO NOT PROMOTE**. A pass would justify further research, not deployment or
permission to trade. Adjusted daily SIP opens do not prove executable prices, market impact, or live capacity.
