# Wave 24B: daily real-assets sleeve

**DO NOT PROMOTE.** The requested seven-ETF sleeve was not scored: TIP has no manifest entry and
zero tape rows in the named archive. The separately preregistered six-ETF diagnostic earned
**+10.26% in 2022** at 10 bp one-way, while SPY lost 18.18% and IEF lost 15.15%. It did not add
risk-adjusted performance to B0/F4/O1: final-holdout Sharpe fell from **1.557 to 1.391** and
Calmar from **2.059 to 1.960** when allocating 25% to it.

## Archive and control verification

The [registration commit](https://github.com/proompteng/lab/commit/82f83b85cf9189843c71bc71d258210a7262a022)
fixed the rule, costs, and gates before any scored run. The exact prefix listed only
`MANIFEST.json` and `alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz`. The runner verified
the pinned manifest SHA-256 and both gzip and decoded byte counts and SHA-256 hashes. It
consumed all **450,712 rows**; GLD, SLV, DBC, USO, XLE, SHY, SPY, and IEF each had one valid bar
on all **2,741** registered sessions. No TIP supplement or proxy was read. The price history
starts on 2016-01-04; the one-session decision lag leaves 2,740 scored daily returns.

The [B0](../2026-11-27-10yr-qqq-smh-conditioning/README.md),
[F4](../2026-11-27-10yr-vol-regime-carry/README.md), and
[O1](../2026-11-27-etf-canary-macro-v2/README.md) paths were replayed on their authenticated
inputs, not inferred from aggregate metrics. All pinned oracle totals reproduced on
development, first forward fold, final holdout, and the full tape. [Results](results.json)
contains the input hashes, exact coverage, replay totals and unrounded measurements.

## Six-ETF diagnostic: returns and costs

| One-way bp | Full CAGR | Full Sharpe | Full max drawdown | Development net | 2022–23 net | 2024–26 net |
| ---------: | --------: | ----------: | ----------------: | --------------: | ----------: | ----------: |
|          0 |     8.23% |       0.619 |            16.64% |         +26.89% |     +10.99% |     +67.73% |
|          2 |     7.62% |       0.580 |            16.75% |         +22.92% |      +9.42% |     +65.20% |
|          5 |     6.71% |       0.522 |            16.91% |         +17.19% |      +7.11% |     +61.49% |
|         10 |     5.22% |       0.424 |            20.88% |          +8.24% |      +3.36% |     +55.48% |

At 10 bp one-way, the sleeve traded on 408 of 2,740 sessions. Annualized traded notional was
28.15× NAV (both sides), averaging 1.117 bp/session charged. Costs reduced standalone full
CAGR from 8.23% to 5.22%, but were not the only limiter: holdout Sharpe lift was negative
even at 0 bp on the new sleeve and transfers. Controls retained their native costs.

### Equity and rate drawdowns at 10 bp

Each cell is **sessions / mean net bp per session** within the specified prior-close mask.
Equity and rates are not mutually exclusive.

| Window        |      Equity |       Rates |       Joint |
| ------------- | ----------: | ----------: | ----------: |
| Full          | 518 / +0.64 | 601 / -0.67 | 207 / +1.33 |
| Pooled OOS    | 299 / +3.28 | 431 / -0.58 | 187 / +1.36 |
| Final holdout |  76 / +3.09 | 131 / -2.24 |  4 / +73.45 |
| 2022          | 184 / +6.41 | 184 / +1.91 | 155 / +3.46 |

In 2022, SHY also lost 3.88%; the diagnostic averaged +4.34 bp/session over SHY on the
155 joint-stress sessions. That period accounted for 155 of the 187 pooled OOS joint-stress
sessions. The final holdout had only **four joint-stress sessions**; the large conditional
mean there is not independent evidence of a durable hedge. Rates-stress returns were
negative over the full tape and final holdout. These are conditional observations, not
independent stress episodes.

## Portfolio attribution and inference

| Final holdout, 10 bp   | Net return | Sharpe | Calmar | Max drawdown |
| ---------------------- | ---------: | -----: | -----: | -----------: |
| Equal B0/F4/O1         |    +27.29% |  1.557 |  2.059 |        4.22% |
| 25% six-ETF diagnostic |    +34.66% |  1.391 |  1.960 |        5.53% |
| 25% passive SHY        |    +22.99% |  1.733 |  2.444 |        3.03% |

| One-way bp | Holdout Sharpe lift | Paired 95% lower bound | Holdout Calmar lift | Holdout excess-SHY mean p |
| ---------: | ------------------: | ---------------------: | ------------------: | ------------------------: |
|          0 |              -0.077 |                 -0.599 |              +0.033 |                   0.06179 |
|          2 |              -0.095 |                 -0.619 |              +0.007 |                   0.06899 |
|          5 |              -0.121 |                 -0.646 |              -0.033 |                   0.07878 |
|         10 |              -0.166 |                 -0.691 |              -0.099 |                   0.09898 |

**Arithmetic contribution to blended net, bp/session at 10 bp one-way.** Component contributions
are after each component's internal costs; the capital-reset cost is shown separately.

| Window        |     B0 |     F4 |     O1 | Six-ETF sleeve | Capital resets |  Total |
| ------------- | -----: | -----: | -----: | -------------: | -------------: | -----: |
| 2022          | +1.214 | -0.130 | +0.538 |         +1.129 |         -0.037 | +2.714 |
| Pooled OOS    | +0.594 | +0.816 | +0.748 |         +1.111 |         -0.032 | +3.236 |
| Final holdout | +0.581 | +1.103 | +0.858 |         +1.688 |         -0.032 | +4.197 |

The 2022 allocation increased the combined book's return from 5.33% to 6.75%, but lowered
its Sharpe and Calmar. The final-holdout sleeve correlations were **+0.018 / +0.655 / +0.622**
to B0 / F4 / O1, respectively: low correlation to B0 did not make the real-assets
risk independent of F4 and O1. The 10 bp diagnostic passed the 2022/pooled stress condition,
but missed the 0.30 correlation cap and the portfolio gate; the excess-SHY mean test also
missed p < 0.05 despite a higher compounded pooled OOS return (+60.70% vs. +10.88%).
The requested study's binding blocker is coverage, not a measured TIP result.

## Preregistered protocol

The only candidate price source is the digest-bound Alpaca SIP split-and-dividend-adjusted daily
tape at `s3://agents-artifacts/bayn-research-datasets/2026-11-27-sip-10yr-sp100/`. Require manifest
membership, ordered unique positive marks, and every one of the 2,741 registered sessions for
GLD, SLV, DBC, USO, TIP, XLE, and SHY, and for the SPY and IEF reference ETFs. A manifest-only check
before registration found TIP missing. If and only if TIP is absent from both the manifest and the
authenticated tape, score a **separate six-ETF diagnostic** with no tradable TIP. It cannot clear
the seven-ETF coverage gate. Any other missing or partial coverage aborts. Do not use the sibling
TIP supplement, another instrument as a TIP proxy, or imputed marks.

- **Allocation.** One fixed long-only rule. At each close, qualify each ETF whose adjusted close
  exceeds its own close 126 sessions earlier. Split half the capital equally among qualifying
  GLD and SLV. The other half rotates: when the DBC/SHY close ratio has risen over 63 sessions,
  split it among qualifying DBC, USO, and XLE; otherwise use qualifying TIP. This is a
  market-price inflation-pressure signal, not an observed CPI or breakeven series. Allocate
  any empty budget (including the inactive TIP slot in the diagnostic) to actual SHY, also the
  initial warmup holding. No leverage or short positions.
- **Execution.** Use the previous close to value current holdings, fix target share orders,
  and require the larger of buy or sell requests to be at least 10% of NAV. At the next open,
  sell the requested shares and fill the submitted buy quantities up to available cash and
  sale proceeds, scaling all buys by the same fraction if necessary. An open cannot change
  the order decision or increase a requested quantity. Mark close-to-close; retain prior
  holdings through the opening gap and carry underspends as cash at zero yield. Fractional
  fills at archived opening marks, simultaneous sale funding, and no market impact are
  modeled assumptions, not verified auction execution.
- **Costs.** Charge 0 / 2 / 5 / 10 bp one-way on every sleeve dollar bought or sold, including the
  first SHY entry. The 10 bp one-way tier is primary. Fix B0, F4, and O1 at their native 10 bp
  _round-trip_ slippage plus their existing fees at every tier. Verify their published split
  totals first. B0 daily return is replay P&L divided by its published fixed capital; F4 and O1
  keep their published SHY idle rules. The comparator replays use their own pinned inputs;
  those inputs do not add tickers to the real-assets universe.
- **Walk-forward.** Score chronological intervals 2016-01-05 to 2021-12-31 (development),
  2022-01-03 to 2023-12-29 (first forward fold), and 2024-01-02 to 2026-11-25 (final holdout).
  The first archive close is only an input to the next session; development includes the SHY
  warmup. No tuning, refits, or ledger resets at fold boundaries. Pool the last two folds for
  OOS diagnostics and also report calendar 2022. This is a historical walk-forward test, not
  a newly embargoed archive or prospective trial.
- **Stress.** Label a session by the previous close: SPY at least 5% below its trailing
  63-session closing high (equity); IEF at least 3% below its equivalent high (rates); or both
  (joint). The trailing window includes that close. Report session counts and conditional
  mean net and excess-SHY bps/session, not an annualized return on disjoint days. IEF is an
  intermediate-Treasury ETF reference, not a direct yield or CPI measure.
- **Attribution.** Compare equal daily weights in B0/F4/O1 against 25% in each of
  B0/F4/O1/real assets, and against the same 25% allocation to passive SHY instead.
  Charge the sleeve's one-way tier on all virtual capital transfers implied by prior
  closing weights. Report arithmetic contributions in bps/session, including transfer drag;
  they sum to daily net and are not a decomposition of compounded wealth. Passive SPY, IEF,
  and SHY benchmarks have no internal trading costs. Blends are matched return paths, not
  a joint order, capital, or margin simulation.
- **Inference and decision.** Compute compounded returns, CAGR and sample Sharpe at 252
  sessions/year (zero risk-free rate), max drawdown, Calmar, and Pearson correlations.
  On the final holdout use 5,000 paired circular stationary draws (mean 10 sessions, seed
  `0x24b2026`). Test the centered mean sleeve-minus-SHY return against zero and use the
  fifth percentile of the paired Sharpe difference against the base as a one-sided 95% lower
  bound. At 10 bp require complete seven-ETF coverage, positive pooled OOS excess over SHY
  and holdout excess mean p < 0.05, positive calendar-2022 return and positive pooled joint
  stress mean both absolute and excess over SHY, holdout absolute correlations ≤ 0.30 to
  **each** of B0/F4/O1, and holdout Calmar lift and positive Sharpe lower bound against the
  base. The sleeve blend must also beat the SHY blend on point Sharpe and Calmar. No
  substitutions, threshold changes, or verdicts based on another cost tier after scoring.

## Reproduce

From the repository root with the existing read-only `agents-artifacts` access, replay to a
new path. The runner will not overwrite a result or accept a `freeze.json` destination.

```sh
set -eu
out=$(mktemp -d)
trap 'if test -f "$out/results.json"; then unlink "$out/results.json"; fi; rmdir "$out"' EXIT
evidence=docs/bayn/evidence/2026-11-28-10yr-real-assets-sleeve
bun services/bayn/tools/research-10yr-real-assets-sleeve.ts --output "$out/results.json"
bunx oxfmt --write "$out/results.json"
cmp "$out/results.json" "$evidence/results.json"
```

To evaluate the seven-ETF rule, authorize a pinned, immutable Alpaca SIP adjusted TIP export
for these exact dates or supply an approved complete archive revision. Do not overwrite the
original tape or any freeze. This evidence is research only and changes no trading policy,
account, integration, or execution authority.
