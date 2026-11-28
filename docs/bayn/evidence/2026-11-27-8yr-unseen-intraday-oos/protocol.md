# Wave 4E — blind SIP preregistration

**Research only.** No refitting, threshold search, winner selection, live-policy edit, trading authority or deployment.
Wave 2B's [live v2 study](../2026-11-27-3yr-sip-bayn21-v2/README.md), Wave 2C
([#16361](https://github.com/proompteng/lab/pull/16361)), Wave 2D
([#16360](https://github.com/proompteng/lab/pull/16360)) and Wave 3B
([#16365](https://github.com/proompteng/lab/pull/16365)) inspected 2024–2026. Wave 3B's code and development receipt
are on [`d8f822088`](https://github.com/proompteng/lab/tree/d8f8220880c490e647a0baef88245df94da48258/services/bayn/tools),
not on this study's base. Freeze this protocol and the typed roster before requesting any 2016–2023 bar bytes. Manifest
and calendar metadata can be authenticated before admission; they are not scoring inputs. The registered result is the
whole roster, regardless of its economics.

## Sample and eligibility

- Blind: 2016-01-04 through 2023-12-29, 2,012 official regular sessions. Inspected continuity segment:
  2024-01-02 through 2026-11-25, 729 official regular sessions. Use the same simulation in both periods, in one
  chronological pass; prior-session state carries over the seam. A cash warm-up stays in the session index. No warm-up
  is borrowed from after the as-of date.
- Compare exact universe identity, not counts: the frozen Wave 3B roster has 46 stocks and 16 ETFs. SPY is a benchmark,
  QQQ/SMH are tradable, and 18 names supply the C1 stock sleeves (including IWM, not a single stock). A source must
  declare the exact roster and attest positive coverage for every name that already listed in its window. A name not
  yet listed may have no rows. A whole-name omission is an input failure, not an IPO, a sparse session or a cash day.
  Do not substitute an ETF, unrelated stock, another feed, or an intersection run.
- Bind the S3 manifest, calendar, compressed checksum, length and row count; also verify raw receipts where the
  manifest publishes them. Authenticate both archive objects before scoring either. Reject malformed, off-grid,
  duplicated or out-of-window rows; do not synthesize missing bars. Use the calendar's New York open/close instants
  rather than a fixed UTC session. Discard bars outside exact RTH, and exclude pre-listing/when-issued activity.
- Require 14 complete **consecutive** prior RTH sessions since first eligible regular-way trade, with no pre-IPO
  zero-fills. Incomplete prior sessions reset the consecutive count; short sessions are complete if all their own
  slots exist. They cannot supply late Noise checkpoints. ATR is the mean of prior daily true ranges, with
  first/post-gap range measured from that day's own open if no earlier adjacent valid close exists. WDC resets on
  the Sandisk distribution. SMCI was [public in 2007](https://www.sec.gov/Archives/edgar/data/1375365/000137536520000064/smci-2020630x10k.htm),
  not a 2020 IPO; exclude its Nasdaq suspension (2018-08-23 through 2020-01-13) and require fresh warm-up after relisting.
- Listing identity is specified in the typed protocol. Sources include [Arm](https://investors.arm.com/investor-info/faqs),
  [CrowdStrike](https://ir.crowdstrike.com/resources/investor-faqs/),
  [Uber](https://www.sec.gov/Archives/edgar/data/312070/000095010321019842/dp163754_424b2-4370ms.htm),
  [Palantir/Coinbase](https://www.sec.gov/Archives/edgar/data/19617/000121390025123831/ea0270410-01_424b2.htm),
  [AppLovin](https://www.sec.gov/Archives/edgar/data/1751008/000175100823000035/applovincorporation10kfy22.pdf),
  [Snowflake](https://www.sec.gov/Archives/edgar/data/1640147/000164014723000084/a2023ars.pdf),
  [Spotify](https://www.sec.gov/Archives/edgar/data/1114446/000111444619002801/tc5285611i_0fwp.htm),
  [Cloudflare](https://www.sec.gov/Archives/edgar/data/200245/000095010322004272/dp168910_424b2-us2285810.htm),
  [Vertiv](https://www.sec.gov/Archives/edgar/data/1674101/000119312521093517/d137112dpre14a.htm),
  [Vistra](https://www.sec.gov/Archives/edgar/data/1692819/000169281918000018/vistra-12312017x10k.htm),
  [SoFi](https://www.sec.gov/Archives/edgar/data/1818874/000181887423000018/sofi-20221231.htm),
  [Robinhood](https://www.sec.gov/Archives/edgar/data/1783879/000178387922000044/hood-20211231.htm),
  [Credo](https://www.sec.gov/Archives/edgar/data/1807794/000162828023030114/ars2023.pdf),
  [Constellation](https://www.constellationenergy.com/content/dam/constellationenergy/earnings-releases/Q1-2022-Press-Release-and-Earnings-Release-Attachments.pdf)
  and the Wave 3B registration for ALAB, GEV and SNDK.

## Roster

| ID          | Frozen specification                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------ |
| C1          | 21-symbol Live v2 **approximation**: 15m opening range, ungated Midday 2L+2S, QQQ/SMH 30m Noise. |
| C2          | Wave 2D/3B OR5 champion: top 1, opening SIP RVOL ≥2.5, gap filter, range stop, 2R.               |
| C3_3R       | C2 with 3R only.                                                                                 |
| C3_top2     | C2 with top 2 only.                                                                              |
| C4_timed    | Noon relative-SIP-VWAP IQR ≥100 bp, 2L+2S, timed close.                                          |
| C4_brackets | Same selection, 500 bp stop / 800 bp target and timed cutoff.                                    |
| C4_ungated  | Same as C4_brackets with no IQR minimum; matched Wave 3B ablation.                               |
| C5          | QQQ/SMH 30m Noise, 1.2× band and opposite-band exit.                                             |
| C6          | C2 + C4_timed, Wave 3B Train-leading 75/25 OR5 tilt.                                             |
| C7_equal    | C2 + C4_timed + C5, equal static thirds.                                                         |
| C7_tilt     | Same sleeves, Wave 3B Train-leading 50/25/25 tilt.                                               |

**OR5:** RVOL is first-bar SIP volume divided by the mean of 14 prior first-bar volumes. Direction is the first bar's
open-to-close sign. Gap filter is Wave 2D/3B's **absolute** open-minus-prior-close of at least 0.5 ATR, not a new
same-sign gap filter. Rank RVOL at range completion, descending, symbol ties; freeze K with no replacement. First
subsequent completed bar whose high/low strictly breaks the range signals entry. Stop is the opposite edge. Size
from the signal-close distance to the stop, with $1,000 total risk divided by K, whole shares and $60,000 per symbol.
Cancel an entry already through the stop. The target is R times the actual open-to-stop risk. Hard exit 11:28 ET,
or 25 minutes before a short close.

**Reversion:** At 12:00 ET use only completed bars, compute each stock's close/cumulative SIP VWAP minus the
equivalent contemporaneous SPY deviation (in bp), and require the two bottom scores be negative and the two top
scores positive. Ties sort by symbol. IQR uses interpolated 25th/75th percentiles on all eligible names; 100 bp is
inclusive. Long the bottom two, short the top two in an equal-reserved-dollar, fractional-share basket. In books,
rerank and recompute IQR after excluding symbols occupied or already pending at the preceding close. Require all
four next opens to enter. Timed liquidation is five minutes before actual close even on a short day.

**Noise:** Mean absolute open-to-checkpoint return from the prior 14 matching checkpoints. Apply the multiplier
above max(today open, prior close) and below min(today open, prior close). First completed 30m checkpoint strictly
outside a band (10:00–15:00 ET, clamped by the actual close and liquidation) signals a single long/short entry
per ETF; no re-entry. Opposite breaches at the same checkpoint grid signal exits. C5 whole-share size is $1,500
total ATR risk split evenly over both enrolled ETFs, at most $60,000 per leg. Flatten two minutes before actual close.

**C1 approximation:** Read the live 21 names but not the live execution path. The mission's 15m range replaces the
live 30m range. From 10:00 through 10:50 ET, select the largest first eligible completed-close breakout relative to
its range edge, requiring agreement with opening candle direction. One position, $500 risk, $35,000 ceiling, stop
0.35 ATR bounded to 50–300 bp of reference and 2R target. Hold at most 60m, subject to the OR5 cutoff. Midday takes
the first fully sign-gated 2L+2S between 11:30 and noon, $18,000 per leg, 500/800 bp brackets and close-minus-5.
C1 Noise uses a 1× band, 1.5 ATR stop (bounded 150–600 bp) and 1,500 bp target; allocate $50,000 over the ETFs inverse
to ATR as a fraction of price, per-ETF weight clipped to 15%–32% of equity. The replay omits live limit/stop-limit
queues, one-minute clocks, short locates and single-leg fallback. It is not byte-equivalent to the Wave 2B or deployed strategy.

## Execution and reporting

- Use exact **next 5m open** after a completed entry, opposite-band exit or bracket touch. The open is a bar proxy,
  not an observed NBBO. If stop and target both touch, stop takes priority. Unlike the historical bracket model,
  there is no assumed intrabar level execution. Schedule timed exits at the latest grid open **at or before** the
  deadline (11:25 for 11:28, 15:55 for 15:58); never use a later price and call it timely. No entry at the cutoff.
  A missing entry cancels; no delayed entry. A gap while held reserves the position and its gross and is reported.
  An absent open for a scheduled exit renders the trade and enclosing daily net unresolved, not zero.
- Use fixed $100,000 equity, not compounding. Gross is simultaneous **entry-reserved notional**, cap $180,000,
  sized with the worst registered half-slippage included. Do not resize on unrealized price movement. C6/C7 size
  the underlying sleeve budgets with the stated weights before flooring shares; no overlay of already-simulated
  dollar P&L. Process open exits before new fills, then ORB, Noise, reversion; no concurrent duplicate symbol.
  Charge adverse half of the 2/5/10 bp RT cost per side, and 0.21 bp on slipped actual sell notional.
- Report each blind calendar year, the full blind period, the prior period as continuity only, and the 2,741-session
  stitched daily cumulative equity in USD for each fixed cost. Net, Ex-Top-5/10 (remove the best positive days),
  annualized 252-session Sharpe, additive MaxDD and Calmar, fee-adjusted turnover breakeven, active days,
  active-day win rate and daily profit factor; undefined metrics are null. Report unresolved days and their known
  closed-leg P&L separately. Report daily Pearson sleeve correlations on matched resolved observations.
- Recompute each book on each single-name omission (SPY remains a benchmark; the omitted ETF does not increase
  the other ETF's budget); report worst known LOSO and counts of complete omissions. Bootstrap is a one-sided
  centered stationary circular block bootstrap (geometric lengths, mean 5 sessions, 10,000 draws, registered
  seed, add-one correction) on full daily net including cash; incomplete windows are not given p-values.
  Descriptive p-values are not a discovery or a capital gate.
- Publish yearly active-roster count distributions and first eligible dates. Attribute realized net by symbol
  and by pre-2016 large caps (AAPL, MSFT, NVDA, AMZN, GOOGL, META, QQQ, SMH), 2019-or-later regular-way listings
  (IPO/direct listing/SPAC conversion/spin-off), and other names. Attribution is not an omission rerun. This is
  survivorship-biased: the 2026 roster lacks delisted 2016 names, and causal admission only removes pre-listing
  exposure. The blind period is unseen by these strategy studies, not a prospective live trial.
