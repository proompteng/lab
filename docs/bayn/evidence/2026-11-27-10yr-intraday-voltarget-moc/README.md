# Wave 11B — Intraday ETF volatility targeting, close momentum and pairs

**No family qualified.** Volatility targeting did not improve the registered B0 control’s Holdout
Sharpe. All ten close-momentum variants and all eight vol-neutral pair variants lost money on Holdout
even at 2 bp. Low correlation was not enough to help the two-sleeve portfolio. Do not substitute any
Wave 11B variant for B0 or stack it onto B0 on this evidence.

This is a historical bar replay, not an execution, broker-authority, or deployment receipt. The sample is
out-of-sample for Wave 11B selection, not new to Bayn research.

## Frozen Holdout verdicts

729 official sessions, 2024-01-02 through 2026-11-25. Values are USD on each fixed $100,000 starting unit;
no SHY carry in the qualification test. Sharpe and Calmar are annualized, and tests use unrounded numbers.
Only the three preregistered nominees could qualify. Both costs had to pass.

| Nominee (5 bp Holdout metrics unless noted) | Net at 2 bp | Net at 5 bp | Ex-top-10 at 5 bp | Sharpe at 5 bp | Stationary p (2 / 5 bp) |  DSR at 2 / 5 bp |
| ------------------------------------------- | ----------: | ----------: | ----------------: | -------------: | ----------------------: | ---------------: |
| A — QQQ/SMH, 15% target, 1.0× cap           |     +39,560 |     +30,828 |            +1,510 |          1.153 |           .0067 / .0238 | .0024 / <.000001 |
| B — SPY/QQQ/IWM, previous close, 1.5σ       |      −1,775 |      −5,178 |            −8,007 |         −1.771 |           .8468 / .9987 |         <.000001 |
| C — XLK/QQQ, vol-neutral, 2.0σ              |      −6,242 |     −12,008 |           −13,424 |         −4.399 |         1.0000 / 1.0000 |         <.000001 |

- **A passed raw profitability, ex-top-ten and bootstrap gates at both costs, but failed DSR.** The
  preregistered 28-trial cross-family dispersion implied daily Sharpe benchmarks of 0.178 and 0.342 at
  2 and 5 bp. These results do not justify changing that benchmark after scoring. Compared with fixed
  QQQ/SMH, the nominee lost $883 / $800 of Holdout net at 2 / 5 bp and lost 0.013 / 0.014 of annual
  Sharpe; paired improvement p was .782 / .766. The drop in 5 bp max drawdown ($6,592 to $6,144)
  did improve Calmar from 1.659 to 1.734. It capped at 1.0× on 682 of 729 sessions and reduced
  realized 5 bp annual volatility only from 9.37% to 9.24%.
- **B passed the correlation requirement but failed the economics and stack.** Daily correlation with B0
  was +0.223 / +0.167 at 2 / 5 bp; adding the sleeve lowered Sharpe by 0.105 / 0.214. Results cover
  index, tech and cross-asset ETFs independently; none made money at 2 or 5 bp.
- **C also passed correlation, but lowered Sharpe more.** Daily B0 correlation was −0.105 / −0.106;
  stack Sharpe fell by 0.223 / 0.439. XLK/QQQ at 2σ was the only development-eligible pair cell.
  The other seven had gaps on held paths in development. None of the eight made money at 2 or 5 bp on
  Holdout, where the tested ETFs have all regular-session bars.

The 10 bp stress net for A/B/C was +$16,276 / −$10,850 / −$21,619. A's 10 bp result was negative after
removing the ten best days (−$12,570). Ten bp did not enter the qualification gate.

## What leverage changed

| Sizing or control               | Holdout net at 5 bp | Holdout Sharpe | Holdout Calmar | Holdout annual vol | Full Sharpe at 2 bp |
| ------------------------------- | ------------------: | -------------: | -------------: | -----------------: | ------------------: |
| QQQ/SMH fixed 1.0×              |             +31,628 |          1.167 |          1.659 |              9.37% |               1.115 |
| QQQ/SMH 15%, cap 1.0× (nominee) |             +30,828 |          1.153 |          1.734 |              9.24% |               1.113 |
| QQQ/SMH 20%, cap 2.0×           |             +57,352 |          1.153 |          1.620 |             17.19% |               1.114 |
| QQQ/SMH/XLK fixed 1.0×          |             +33,599 |          1.224 |          1.666 |              9.49% |               1.175 |
| QQQ/SMH/XLK 20%, cap 2.0×       |             +61,125 |          1.198 |          1.557 |             17.64% |               1.170 |

The 20%/2.0× examples are descriptive, not new nominees. They raised dollars and volatility together and
had larger drawdowns; none of the ten sizing upgrades beat its matched fixed basket's Holdout Sharpe
at 5 bp. The fixed XLK basket did replicate the higher historical Sharpe, not a new qualification.
At the 2.0× entry-allocation cap, conservative summed high marks reached about $205,000; the backtest
does not establish compliance with broker buying-power rules after entry.

The exact B0 full-session replication is **+$103,533.58 at 2 bp** and **+$69,780.16 at 5 bp**, matching
Wave 6A to the cent at both costs in each split and Full. The matched 3-ETF fixed sleeve was
+$106,794.62 / +$73,104.12 over Full. The archive has no empty session for an enrolled ETF, but isolated
missing development bars remain; two aggressive B variants have one unproved historical exit apiece and
no fabricated full-window P&L. The three frozen nominees had no unresolved closes or missing held bars
over the full replay.

SHY earned +$20,041 Full and +$11,645 Holdout as a separately funded $100,000 total-return overlay.
The B nominee plus SHY at 5 bp made +$6,467 on Holdout, less than SHY alone; it is not evidence of
trading alpha. SHY is never used for nomination, p, DSR or correlation.

## Verify

- [Protocol](protocol.md) and [development freeze](freeze.json): 1,511 Train + 501 Validation sessions only.
  The freeze was [committed and pushed](https://github.com/proompteng/lab/commit/a3a19c9cc688e0d8452e13e7c271d117cb836cb2)
  before opening any Holdout price for Wave 11B. Neither SLV nor HYG was present in either frozen 5-minute roster.
- [Score](results.json): all 30 registered trials at 2, 5 and 10 bp, aligned splits, dollar and risk metrics,
  execution gaps, paired comparisons, gates and SHY diagnostics. The original freeze SHA-256 is
  `bca98b2008e975c40d2d067a7b0c0c6ee4acd44c5ba084bdf220b7492986dd71`.
- [Transport erratum](transport-erratum.json): Bun truncated the formatter pipe before any result file was
  written. The correction invokes the same pinned formatter under Node. The score is byte-identical to
  the output from the original committed runner with only the formatter invoked under Node. No variant,
  decision, input, gate or original receipt changed.

From the repository root in the [archived checkout][study-revision], with the pinned Bun and Node toolchain, dependencies installed, and the existing
`AGENTS_ARTIFACTS_*`/AWS read credentials for `agents-artifacts`:

```sh
bun services/bayn/tools/research-10yr-intraday-voltarget-moc.ts --score
git diff --exit-code -- docs/bayn/evidence/2026-11-27-10yr-intraday-voltarget-moc/results.json
```

The runner verifies committed SHA-256 content (including the transport correction) and regenerates the
full development freeze before reading Holdout prices. It does not require a pre-squash commit or branch
to be in the checkout's ancestry.

[study-revision]: https://github.com/proompteng/lab/tree/4b25eaee338c3c4766360108733da2f266dff493
