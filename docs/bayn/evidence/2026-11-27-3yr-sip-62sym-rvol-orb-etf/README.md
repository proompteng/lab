# Bayn Wave 2D: 3-year SIP intraday momentum

**Decision: no v3 promotion.** Across 2,055 configurations, none had positive net after removing the five best
days at **both** 5 and 10 bp in each of Train, Validation, and Holdout. The frozen ORB diagnostic made money
before trimming in all three splits; the low-correlation 50/50 portfolio also made money before trimming. At
10 bp their Holdout returns fell from +$5,585 to −$2,342 and from +$3,965 to −$604, respectively. No new
strategy primitive or live policy change is warranted.

The [preregistered protocol](PROTOCOL.md) defines trade timing, sizing, costs and gates. The
[development receipt](freeze.json) was [pushed before Holdout scoring](https://github.com/proompteng/lab/commit/e694f03d704e5a8fa787d740a838ac3cf94869b7).
The subsequent formatter-only commit preserved the receipt's canonical JSON. A second score produced identical
results except for that Git revision. Neither sleeve passed the Train gate, so highest-Train-Sharpe diagnostics were frozen; neither was replaced
after seeing Validation or Holdout. [Results](results.json) include every variant, all splits and half-years,
the three costs, and the audit details. Wave 1B used a different tape and different fill rules; this study
does not isolate a causal effect of switching from IEX to SIP.

## Tape and coverage

- The supplied 62-symbol panel has **46 stocks and 16 ETFs**. There are 3,923,737 authenticated archive rows.
  The file's RTH label is not a coverage guarantee: the exchange-calendar filter removed 442,813 outside-session
  rows, and the listing filter removed 376 SNDK when-issued RTH rows. This left **3,480,548** regular-way RTH bars
  with **256 missing expected slots**, 141 of them KLAC. No bars were filled or shifted.
- The calendar has **729 sessions**, including six early closes: 374 Train, 189 Validation and 166 Holdout.
  It ends on December 31 only in 2024 and 2025, and on November 25 by design in 2026. Each frozen run has
  zero missing committed entries and zero unresolved legs. Some other ORB configurations do not have a
  complete Train return; the result ledger keeps those unknown rather than treating gaps as cash.
- Using consolidated SIP aggregate volume makes the RVOL observations comparable across reportable venues;
  the execution receipts are scenario results at assumed NBBO costs, not reconstructions of executable
  historical quotes or short availability.

## Frozen comparisons

Net is rounded USD in cost order **2 / 5 / 10 bp**; Ex-Top-5 reports **5 / 10 bp**. Every price scenario also
charges the 0.21 bp sell fee.

| Evaluation                                | Split      | Net (2 / 5 / 10)            | Ex-Top-5 (5 / 10) | Bootstrap p (5 / 10) |
| ----------------------------------------- | ---------- | --------------------------- | ----------------- | -------------------- |
| OR5, RVOL 2.5, top 1, gap, range stop, 2R | Train      | +29,580 / +27,558 / +24,189 | +17,309 / +14,049 | .0167 / .0306        |
| OR5 diagnostic                            | Validation | +8,323 / +7,272 / +5,521    | −2,164 / −3,804   | .1694 / .2343        |
| OR5 diagnostic                            | Holdout    | +7,495 / +6,778 / +5,585    | −1,260 / −2,342   | .1754 / .2168        |
| QQQ+SMH, 30m, band 1.2, opposite exit     | Train      | +15,419 / +11,445 / +4,821  | +1,755 / −4,693   | .0748 / .2593        |
| ETF diagnostic                            | Validation | +3,333 / +981 / −2,938      | −5,142 / −8,863   | .4166 / .7185        |
| ETF diagnostic                            | Holdout    | +6,592 / +5,031 / +2,430    | −1,634 / −4,086   | .1057 / .2547        |
| 50/50 combined                            | Train      | +22,428 / +19,441 / +14,462 | +12,404 / +7,539  | .0060 / .0299        |
| 50/50 combined                            | Validation | +5,760 / +4,067 / +1,244    | −1,674 / −4,349   | .1744 / .3867        |
| 50/50 combined                            | Holdout    | +6,978 / +5,849 / +3,965    | +1,172 / −604     | .0773 / .1667        |

| Calendar period       | Sessions | OR5 Ex-Top-5 (5 / 10) | QQQ+SMH Ex-Top-5 (5 / 10) | Combined Ex-Top-5 (5 / 10) |
| --------------------- | -------: | --------------------: | ------------------------: | -------------------------: |
| 2024H1                |      124 |         +1,816 / +935 |           −4,272 / −6,639 |              +1,095 / −583 |
| 2024H2                |      128 |       +7,335 / +6,282 |           −2,634 / −4,719 |            +5,844 / +4,216 |
| 2025H1                |      122 |     −10,233 / −11,375 |           −1,492 / −3,085 |            −3,869 / −5,262 |
| 2025H2                |      128 |       −6,640 / −7,688 |           −6,332 / −8,850 |            −4,386 / −6,189 |
| 2026H1                |      123 |       −2,676 / −3,620 |           −3,509 / −5,646 |            −1,529 / −3,046 |
| 2026H2 through Nov 25 |      104 |         −414 / −1,084 |           −1,119 / −2,459 |              +1,493 / +464 |

Untrimmed net was jointly positive at 5 and 10 bp in five half-years for OR5, three for QQQ+SMH and five
for the combination. None passed a plateau in any split. At 10 bp in Holdout:

| Evaluation     | Ex-Top-10 | Annualized Sharpe | Drawdown |   DSR |                 Worst known LOSO net |
| -------------- | --------: | ----------------: | -------: | ----: | -----------------------------------: |
| OR5 diagnostic |    −8,546 |              0.97 |    5,533 | .0232 | +2,527 without SMCI (46/46 positive) |
| ETF diagnostic |    −7,822 |              0.67 |    3,283 | .0114 |      −165 without SMH (1/2 positive) |
| Combined       |    −3,896 |              1.19 |    3,682 | .0341 | +2,432 without SMCI (48/48 positive) |

## What the sweeps showed

- **ORB5 beat OR15 in this Holdout, but the effect did not generalize through the development gates.**
  At 10 bp, 829/1,008 OR5 runs had positive Holdout net, falling to 115/1,008 after removing the best five
  days. OR15 fell from 128/1,008 to zero. The OR5 results are exploratory comparisons, not alternate candidates:
  no trial was jointly positive Ex-Top-5 in all three splits at both costs.
- **More ETFs did not turn this Noise Area model profitable.** All twelve all-16 configurations failed
  the joint 5/10 bp Ex-Top-5 criterion in **every** half-year; none of the six- or 16-ETF variants was
  even net positive at 5 or 10 bp in any of the three pooled splits. At matched 30m/1.2/opposite settings,
  10 bp Holdout net was +$2,430 (QQQ+SMH), −$7,344 (six ETFs) and −$6,843 (16 ETFs), before trimming.
- **Low correlation helped reduce concentration, but did not clear the friction gate.** At 10 bp the
  frozen sleeves' daily Pearson correlations were +0.043 Train, +0.079 Validation and −0.021 Holdout.
  The balanced combination was positive Ex-Top-5 at 5 bp in Holdout, but negative at 10 bp and negative
  at both costs in Validation. The 25% and 75% ORB weights also failed 10 bp Holdout Ex-Top-5.

## Reproduce

Run from an artifact-enabled checkout with the committed receipt. No archive or credentials are checked in.

```sh
cli=services/bayn/tools/research-3yr-sip-62sym-rvol-orb-etf.ts
evidence=docs/bayn/evidence/2026-11-27-3yr-sip-62sym-rvol-orb-etf
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
bun "$cli" --freeze "$scratch/freeze.json"
bunx oxfmt "$scratch/freeze.json"
cmp "$evidence/freeze.json" "$scratch/freeze.json"
bun "$cli" --score "$evidence/freeze.json" "$scratch/results.json"
bunx oxfmt "$scratch/results.json"
cmp "$evidence/results.json" "$scratch/results.json"
```

In the JSON, `rows` and `loso.worst` follow `windowOrder` then `costOrder`; use `metricColumns`,
`coverageColumns` and `losoColumns` to label values. `loso.bySymbol` supplies each omission for the frozen
evaluations. `null` denotes unknown full-window results or undefined inference, not a zero.
