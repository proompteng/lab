# Wave 23D — Intraday ETF opening-range breakout

**Goal.** Test whether an opening-range breakout (ORB) after a compressed, high-volume open earns positive
risk-adjusted returns after costs, or improves the QQQ/SMH B0 sleeve. This registration is for research only.
It sets no trading or capital authority.

## Pre-registration

**Input.** Use only QQQ, SPY, IWM, SMH, XLK, XLF, XLE and XLI from the split-adjusted Alpaca SIP
`bayn-research-datasets/2026-11-27-sip-multiyear/alpaca_sip_5m_rth_62sym_20240102_20261125.tsv.gz`
object in `agents-artifacts`. Verify the pinned manifest and exchange calendar, the gzip and decoded tape
SHA-256 and lengths, and the 3,923,737-row receipt. Verify membership and observed regular-hours coverage
for each enrolled symbol. Use the New York exchange calendar for DST and early closes. Timestamps label the
start of each five-minute bar; ignore outside-session rows. A missing slot is not a bar. Do not use an older
tape, external prices, quotes, or overnight returns.

| Fold | Expanding selection history | OOS dates             | Sessions |
| ---- | --------------------------- | --------------------- | -------: |
| 2025 | 2024-01-02–2024-12-31       | 2025-01-02–2025-12-31 |      250 |
| 2026 | 2024-01-02–2025-12-31       | 2026-01-02–2026-11-25 |      227 |

**Signal.** Register exactly two eligible widths (15 and 30 minutes) and an ungated diagnostic at each
width. Set the range to the high and low of the first complete bars from 09:30 ET. Opening realized
volatility is the root sum of squared log moves from the 09:30 open to the first close and between
consecutive closes in that range. Opening volume is the sum of the same bars' volume. Both reference
medians use the same symbol and same width over the immediately preceding **20 exchange sessions**, all
of which must have a complete opening range. At range completion require positive reference volatility,
current realized volatility at most **0.80×** its median, and opening volume at least **1.25×** its median.
The ungated controls skip both ratio tests and require no history. No future day's data enters a gate.

**Orders and fills.** From the first **subsequent** completed bar through the bar ending at 11:25 ET,
take the first close strictly above the range (long) or below it (short). One round trip per symbol per
session; no stops, intraday reversals, re-entry, or redistribution of idle allocations. Size whole
split-adjusted shares as `floor(($100,000 / 8) / signal close)` before the fill. Use the next bar's open,
not the signal price, as the entry proxy. Repeat with one extra five-minute bar of entry delay, holding
the instruction, size and exit clock fixed. Close all positions at the open of the **15:55 ET** bar
(**12:55 ET** on early closes); there is no overnight carry or later exit fallback. These are bar-open
prices, not fills at a first-arrival timestamp or proof of executable quotes.

Incomplete opening/history or a gap before the first trigger withholds the symbol; no later bar
can repair that signal. A missing required entry or exit after a trigger leaves that path unresolved and
withholds full-window economics and inference, not just the missing day. Both scheduled fill opens are
sufficient for endpoint P&L; intervening held gaps are diagnostic since ORB has no path-dependent orders.

**Control and friction.** Replay [Wave 6A B0](../2026-11-27-10yr-16etf-noise-area/protocol.md):
QQQ/SMH, 30-minute Noise Area checkpoints, 1.4× bands, opposite-band exit and inverse-volatility sizing.
Warm it on this same tape rather than import earlier observations. Preserve the existing B0 path/sizing
rules, including its timed exit request (close minus 15 minutes) and last admissible exit at close minus
five. A held-bar gap withholds B0 economics because B0 is path-dependent. Use the same $100,000 reference
and reprice both books at **0 / 2 / 5 / 10 bp round trip**, with half
applied adversely to each fill and no additional fee. The zero-cost tier is frictionless; nonzero tiers are
scenarios, not estimates of commissions, spreads, impact, or locate/borrow. Turnover is the sum of both raw
fill notionals divided by $100,000; the signed break-even round-trip cost solves net P&L = 0. No
compounding, cash yield, or leverage from idle slots is modeled.

**Selection and inference.** For each OOS fold select the higher **5 bp daily Sharpe** on the prior
expanding history (ties: 15m). A path with unresolved fills or undefined Sharpe cannot be selected.
Publish both fixed widths and both ungated controls; neither a better OOS width nor an ungated control can
replace the selected path. Pool only the two nonoverlapping OOS selections. Use all calendar sessions
including known cash days. Report net, annualized Sharpe (sample deviation, zero risk-free, √252),
simple-equity drawdown, exact fill counts and exposure, and Pearson correlation to B0 at each cost. The
fixed 80% B0 / 20% ORB blend shares capital; it is a linear combination of aligned daily model returns,
not a re-simulation of whole-share trades at scaled budgets. Report its return and Sharpe lift over B0.
Use a one-sided, mean-centered circular stationary bootstrap (10,000 draws, mean block five sessions,
seed `0x23d20261`, +1 correction) for net mean and paired blend-minus-B0 mean at 5 bp. Inference is
conditional on the realized walk-forward selections and does not establish prospective independence.

**Promotion gate.** Require a selected path for both OOS folds, complete matched ORB/B0 fill evidence
including the delayed-entry ORB stress, and at least 30 pooled OOS sessions with a closed ORB trade.
Then require either:

- **Standalone:** positive ORB net in both folds at 5 and 10 bp, pooled 5 bp mean p < 0.025, and positive
  pooled 5 bp net with the delayed entry.
- **Alongside B0:** positive blend-minus-B0 net in both folds at 5 and 10 bp, pooled 5 bp absolute Pearson
  correlation no higher than 0.30, positive blend Sharpe lift at pooled 5 bp, pooled paired 5 bp p < 0.025,
  and positive pooled blend-minus-B0 net at 5 bp with delayed ORB entry.

The 0.025 threshold budgets 0.05 across the two prespecified promotion paths. A pass would only justify
separate prospective qualification. Other waves have used overlapping data and a fixed modern ETF universe
is not a survivorship-free screen; these folds are chronological OOS, not new blind market history.

## Result: DO NOT PROMOTE

The walk-forward selector picked **30 minutes in both folds**. At 5 bp it earned **$723.12** on the
fixed $100,000 reference across 477 OOS sessions (Sharpe **0.430**, MaxDD **1.035%**). The pooled
one-sided bootstrap p was **0.2564** against the 0.025 threshold, and 2026 lost money at both 5 and
10 bp. The positive pooled estimate does not establish a durable standalone edge.

Correlation to B0 at 5 bp was **0.113** across the same 477 sessions, including cash days. That is low
co-movement, not evidence of positive diversifying alpha. The 80/20 blend earned **$19,859.39** versus
**$24,643.45** for B0, giving up **$4,784.07**. The blend cut modeled drawdown from **5.655%** to
**4.573%** but raised Sharpe by only **0.006** (1.255 vs. 1.249). The one-sided paired p for positive
net lift was **0.9473**. The blend failed the registered net-lift gates in both folds; reducing B0
exposure is not by itself evidence of an ORB edge. Differences are calculated before rounding.

### Walk-forward selection

Train Sharpes below are daily and unannualized, based only on data before that fold. Net is USD
after the specified round-trip penalty. Counts are closed round trips, not individual fills.

| OOS fold | Train Sharpe 15m / 30m | Selected | Round trips | Turnover / capital | 5 bp net | 10 bp net |
| -------- | ---------------------- | -------- | ----------: | -----------------: | -------: | --------: |
| 2025     | −0.04654 / +0.00978    | 30m      |          67 |            16.589× |  $753.59 |   $338.87 |
| 2026     | −0.01879 / +0.03711    | 30m      |          43 |            10.612× |  −$30.47 |  −$295.78 |

### Pooled 2025–2026 cost and fill stress

All rows use the same 477-session OOS calendar. Dollar P&L and turnover are modeled at fixed sizing;
turnover includes both sides of each round trip at their raw opens. The other width and the ungated
rows are diagnostics, not replacements for the walk-forward selection.

| Book / fill clock               | Round trips | Turnover / capital |   0 bp net |   2 bp net |    5 bp net |   10 bp net | 5 bp Sharpe |
| ------------------------------- | ----------: | -----------------: | ---------: | ---------: | ----------: | ----------: | ----------: |
| Selected (gated 30m), next open |         110 |            27.201× |  $1,403.15 |  $1,131.14 |     $723.12 |      $43.09 |       0.430 |
| Selected (gated 30m), +5m entry |         110 |            27.200× |  $1,343.12 |  $1,071.11 |     $663.10 |     −$16.91 |       0.413 |
| Gated 15m, next open            |         199 |            49.204× |    $439.74 |    −$52.30 |    −$790.35 |  −$2,020.45 |      −0.314 |
| Ungated 15m, next open          |       3,533 |           872.857× |  $5,760.94 | −$2,967.63 | −$16,060.48 | −$37,881.91 |      −0.936 |
| Ungated 30m, next open          |       3,135 |           774.275× |  $3,258.06 | −$4,484.69 | −$16,098.81 | −$35,455.67 |      −1.032 |
| B0, same-tape control           |         362 |           367.483× | $33,830.52 | $30,155.69 |  $24,643.45 |  $15,456.39 |       1.249 |

- **Activity is limited by the gates, not by missing bars.** Of 3,816 OOS symbol-sessions, 2,686
  failed compression, 1,000 of the 1,130 remaining failed RVOL, and 20 of the 130 that passed both
  had no breakout. The 110 round trips were 63 long and 47 short on 80 active sessions. The largest
  daily sum of entry notionals was $49,300.24; the per-symbol budget is set at the signal close and
  does not use the later fill price to resize.
- **Turnover and fill timing limit the economics.** The selected next-open path turned $2,720,119.70
  two-sided. A 5 bp penalty consumed $680.03 of gross P&L. Pooled break-even fell from 10.317 bp to
  9.876 bp under the one-bar delay; the same 110 orders held to the same exits earned $60.02 less at
  5 bp than the next-open path. The 2026 next-open fold broke even at only 4.426 bp.
- **The archive limits execution claims.** No selected entries or scheduled exits were unresolved in
  either fill scenario. All modeled selected exits are same-session at the registered 15:55/12:55
  bar open; B0's latest modeled OOS exit was 15:45. A bar open is an aggregate's first eligible print,
  not a quote or evidence of trading at the window boundary. Finalized archive bars do not certify
  first-arrival latency, executable liquidity, borrow, costs, or live eligible share lots. See
  [Alpaca's bar specification](https://docs.alpaca.markets/us/docs/market-data-faq#how-are-bars-aggregated).

### Receipts and reproduction

The [registration commit](https://github.com/proompteng/lab/commit/e63ec8d22a74ea5d2b4074d919323dcaee2a17a9)
was published before any Wave 23D price-tape read. The [machine-readable receipt](results.json) binds the
manifest and calendar and records the authenticated compressed and decoded tape hashes and lengths.
All 3,923,737 rows were counted. After discarding 61,122 outside-RTH rows for the eight enrolled names,
each had exactly 56,646 of 56,646 expected five-minute slots: 453,168 observed bars across the 729
sessions, six of them early closes. The OOS sample stops on November 25, 2026; it is not three full
OOS years. No external prices or generated bars entered the study.

With read-only access to the registered `agents-artifacts` archive, run from the repository root:

```sh
bun services/bayn/tools/research-intraday-orb-etf.ts /tmp/w23d-replay.json
bunx oxfmt /tmp/w23d-replay.json
cmp /tmp/w23d-replay.json docs/bayn/evidence/2026-11-28-intraday-orb-etf/results.json
```

The command requires a new output path; it will not overwrite an existing receipt. The JSON retains
full-precision costs, B0 and blend metrics, fill counts, gate dispositions, and the delayed-entry stress
for each variant and fold. This result changes no Bayn policy or execution path.
