# Stock short research and accounting — November 13, 2026

The active JeV v40 strategy is structurally long-only. Supporting short accounting does not make its long chart
judgments valid for shorts. This change adds explicit signed stock inventory, cover accounting, ledger replay,
position-episode measurement, and three short research controls. It does not enable short orders or promote a
strategy. The tested controls provide no evidence of profitable short exposure after the modeled execution costs.

## Empirical result

All figures below are USD execution-scenario P&L, starting each partition at $100,000. The six-symbol universe is
AAPL, AMZN, IWM, NVDA, QQQ and benchmark-only SPY. Signals use completed native prices; no prices or model scores
are reflected. Base execution charges 10 bp adverse prices on each side; stress charges 20 bp. Both include the
native fee model valued explicitly at November 13, 2026. These are current-fee scenarios on historical prices,
not reconstructed historical charges. Infrastructure, market data, inference and historical borrow costs remain
unknown. All-in profit stays null and qualification stays false.

| SIP corpus / short control              | Development | Validation | Later sample |
| --------------------------------------- | ----------: | ---------: | -----------: |
| November 2026 / relative weakness       |     -419.81 |    -138.67 |      -818.08 |
| November 2026 / opening-range breakdown |     +479.97 |     -80.37 |      -501.08 |
| November 2026 / VWAP rejection          |      +57.90 |     -28.61 |      -670.76 |
| June 2022 / relative weakness           |     -750.02 |  -1,053.59 |    -1,403.40 |
| June 2022 / opening-range breakdown     |     -363.27 |    -620.99 |      -363.10 |
| June 2022 / VWAP rejection              |     -586.15 |    -281.58 |       -93.83 |

The November selector chose the opening-range short from all sixteen controls using development only. Its later
base/stress results were -$80.37/-$417.12 and -$501.08/-$1,122.04 on SIP; on IEX they were
-$185.73/-$830.20 and -$802.82/-$1,659.03. No June control had a positive completed development result.
The March 2020 corpus could not establish complete paths: missing SPY benchmark minutes and missing held-position
bars invalidated the evaluations. Those are unknown results, not zero returns or evidence that shorts cannot work.
Do not fill gaps through a market-wide halt with fabricated prices.

Dates were selected retrospectively, including known selloffs. November dates also overlap previously inspected
research. The input's `holdout` label denotes a later chronological partition; none of these dates constitutes an
untouched prospective test. The sixteen attempted policies and both cost scenarios are retained, including losses,
zero-activity sessions and incomplete paths. The short controls are numerical feasibility tests, not JeV replay.
The three seven-session samples do not establish behavior across all bear markets or a calibrated significance level.

| Corpus        | Acquisition range   | Development | Validation | Later sample | Raw IEX / SIP rows | Missing regular minutes IEX / SIP |
| ------------- | ------------------- | ----------- | ---------- | ------------ | -----------------: | --------------------------------: |
| November 2026 | Oct 14–Nov 12       | Nov 4–5     | Nov 6–9    | Nov 10–12    |   53,171 / 117,384 |                           245 / 0 |
| COVID crash   | Feb 18–Mar 20, 2020 | Mar 12–13   | Mar 16–17  | Mar 18–20    |        0 / 107,341 |                      56,160 / 337 |
| June selloff  | May 18–Jun 17, 2022 | Jun 9–10    | Jun 13–14  | Jun 15–17    |   50,250 / 103,505 |                         2,627 / 3 |

Each corpus retains an independently acquired exchange calendar, complete request/response pagination tokens,
raw-adjustment and feed identity, acquisition clocks and exact source bytes. IEX and SIP are distinct sources;
SIP historical access does not prove current real-time entitlement. The contemporary universe creates survivor
and selection bias. Intraday liquidation removes modeled overnight dividends but does not prove actual timely fills.

## Broker feasibility

The [full 2022 quarterly extension](stock-short-2022-quarter-study-2026-11-14.md) evaluates 251 sessions with
unchanged controls. All 52 complete short paths lose under the stated scenarios; 20 others remain incomplete.
It retains all sixteen policies and audits 18,443 simulated trades across the full long/short report inventory.

A read-only sandbox probe at 22:22:19 UTC found an ACTIVE account with shorting enabled and no account/trading
blocks. AAPL, AMZN, IWM, NVDA, QQQ, SMH and SPY were active, tradable, marginable, shortable and easy-to-borrow.
These are current observations only. The reported four-times buying-power multiplier grants no strategy authority
and is not an instruction to increase leverage. No order or paid locate was submitted.

[Alpaca's current margin and short-selling documentation](https://docs.alpaca.markets/us/docs/margin-and-short-selling)
states zero borrow/locate fees for ETB stock, while HTB requires approved, single-use round-lot locates and separate
borrow charges. HTB charges can apply for a full day even to an intraday position. A minute-prorated annual rate
would understate that cost. Initial implementation should remain ETB-only; HTB needs separately modeled receipts,
fees, availability, expiry and recall behavior.

[Alpaca's order documentation](https://docs.alpaca.markets/us/docs/orders-at-alpaca) supports short-opening brackets,
but child orders activate only after the parent fills completely. Partial parents and cancel/fill races still need
an explicit protection owner. Stops do not cap losses during gaps or guarantee fills.
[SEC Regulation SHO guidance](https://www.sec.gov/investor/pubs/regsho.htm) explains locate requirements, unbounded
short losses, dividend obligations and the Rule 201 price test after a ten-percent decline. Historical bars do not
prove a compliant short fill at the modeled bid during a price restriction.

## Implemented boundary

The new `bayn.equity-short-accounting-transaction.v1` is explicit; the default accounting mode remains long-only.
A SELL creates equal cash proceeds and negative inventory basis, with zero realized gain. BUY covers allocate
liability using deterministic half-up rounding; the final cover consumes the exact residual. Fees debit cash
separately. Long/short crossing within a fill and crypto short inventory are rejected. Existing long transaction,
account and transfer identities retain their golden values. Migration 0198 admits the new evidence version without
rewriting retained rows; it changes neither grants nor execution policy.

Each short screen fill retains synthetic, unposted opening and cover transactions built by this same accounting
core. Rebuilding their ledger plans reproduces their identities and balances. PostgreSQL 18 admission checks and
a real isolated TigerBeetle 0.17.9 test cover partial covers, an adverse $350 cover after a $100 sale, process restart
and repeated posting. The native ledger reconciles exactly with no duplicate transfer or clipped loss.
Position episodes recognize explicit short inventory, retain unknown equity cost attribution and reject mixing
inventory modes inside an episode. These tests establish accounting behavior, not a broker short execution.

## Required strategy development

A deployable short strategy still needs a separately versioned JeV contract and short-specific evidence. Candidate
hypotheses are resistance rejection after a failed recovery and a downside base break followed by a failed retest.
Judgments must separately assess resistance confirmation, upside invalidation and nearby downside support. Do not
invert the existing long probability, reuse a long support label, or manufacture a reflected chart. Any thresholds
must be selected using development data and assessed prospectively under the repository's economic qualification.

Before opening exposure, retain fresh account-bound shorting permission, asset/ETB status, quote and regulatory
execution evidence. Keep the existing capital, gross exposure, daily loss, cumulative drawdown and turnover history.
Signed targets, SELL brackets, BUY protection/cover terms, partial-fill protection, locate/recall events, margin
changes, uncertain submits, reconciliation and controller restart recovery must all share the same direction-aware
contract. Existing production account/asset normalization drops some borrow flags, so its current snapshots cannot
supply this evidence. Covers must remain available when opening eligibility disappears, with exact quantity bounds.
The current controls' losses are a reason to reject their promotion, not proof against every short-specific JeV idea.

## Evidence and reproduction

Private source envelopes, pinned inputs, full reports and all intermediate diagnostics remain outside Git and CI
artifacts. Independent arithmetic and byte-pin checks passed for 2,716 simulated trades and 361 complete paths.
The private archive `bayn-stock-short-evidence-2026-11-13.tar.gz` has SHA-256
`5ffd384eed4006e6a6a5d7c136225da5de7e9f2e9bf58e0b1d274276d022ad2d`.
The retained source SHA-256 identities are:

| Corpus / feed  | Source SHA-256                                                     |
| -------------- | ------------------------------------------------------------------ |
| November / IEX | `3018062341b35af9820a6b497a09bc83b8d695d37e07fb0d078ad35b7af46462` |
| November / SIP | `5b70ff6e79f66ae42a119dea7511e20e3c1404de140d6b8a4ba383a2ed1ef782` |
| COVID / IEX    | `e674d8bc20ce5daeaa07eabe80db3d2e5eff723e0530c1d4c82003f0d0d0123f` |
| COVID / SIP    | `cf4bdf755681b46e1f688ab18b0f53ea957a99a7d1404ca0b2432b9ce96dbe28` |
| June / IEX     | `17a69c94bcc65191f22cca7c82fddc21ee058b69e643496d5e9a6fa4da3a8c2e` |
| June / SIP     | `3aaee5752ce908f0107c129ba3b7908ed39c2721c426b6a8b5104f956425b822` |

Use [the equity screen command](equity-edge-screen.md) with input v3, `executionFeeDate: "2026-11-13"`, independently
pinned input bytes and a new output path. Original attempts on 2020/2022 dates correctly failed with
`UnsupportedEquityFeeDate`; the explicit current-fee scenario replaces no historical tariff evidence. Report v5
retains direction in selection identity, preventing a selected short from being matched to the corresponding long.

The broader investigation remains in [the system report](system-investigation-2026-11-13.md) and
[#15936](https://github.com/proompteng/lab/issues/15936). A new deployed-source report at 23:00 UTC still exceeded the
30-second deadline, discarded incomplete stdout, and measured 686,356 KiB process-lifetime peak RSS in the API
process. Controllers remained at zero restarts. Isolation is shipped in #15940; full-report latency remains #15928.
