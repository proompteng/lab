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
