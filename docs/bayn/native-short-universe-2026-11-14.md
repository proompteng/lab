# Native JeV shorts and the S&P 100 universe — November 14, 2026

The broker account permits stock shorting; deployed JeV v40 did not open shorts. V41 extends the same native
JeV chart and atomic-judgment process with bearish proposals, signed sizing, SELL brackets and BUY covers.
It does not infer bearish conviction by subtracting a long probability from one. Profitability remains unproven.

The engineering goal is complete, bounded PAPER execution in either equity direction, with exact accounting
and unchanged capital controls. The economic goal is positive performance after execution, inference and
operating costs on subsequent, untouched observations. More candidates, completed tests, healthy pods and
broker shorting permission do not establish that economic result.

## Universe evidence and decision

The old equity source contains sixteen symbols, including benchmark SPY, ETFs and stocks outside the S&P 100.
That source remains available for outstanding and retained positions. New stock entries use:

`AAPL AMZN GOOGL INTC META MSFT MU NFLX NVDA TSLA`

Four previous candidates remain: AAPL, AMZN, MU and NVDA. Six stocks are added. AMD and SNDK fail the native
history screen; AVGO loses its place under the five-per-sector limit and dollar-volume ranking. The other old
candidates either fail membership or coverage. ETF liquidity alone does not make an ETF an S&P 100 constituent.
The resulting set has five Information Technology, three Communication and two Consumer Discretionary stocks;
this is still concentrated and should not be described as broad sector diversification.

Membership uses the [iShares OEF holdings CSV](https://www.ishares.com/us/products/239723/ishares-s-p-100-etf/latest-holdings.csv),
dated November 12, independently corroborated against 101 equity entries on the S&P 100 constituent list.
The issuer CSV SHA-256 is `b9803c6332eb7993f2f14ee5a24b7b1acab8d57b172b4bedb5a2144a747a8baa`.
The official S&P page returned HTTP 403; OEF is a disclosed membership proxy rather than a claim of direct
index-provider access. Berkshire's issuer symbol `BRK B` maps to Alpaca `BRK.B`; the initial rejected spelling
and its response are retained.

The study covers twenty completed regular sessions, October 19–November 13, including the November DST
transition. It inspects 110 symbols: 101 constituents and nine additional old-source symbols. Consolidated
SIP daily dollar volume is the median of each session's actual `volume × bar VWAP`; native IEX minute history
is separately screened for the top 35 dollar-volume names plus the old universe, 44 symbols in total.
There are 193 successful paginated acquisition requests. Current historical SIP access was verified, but the
recent real-time SIP request returned subscription denial; executable pricing remains the entitled IEX feed.

The first rule was frozen at 18:53:21.892 UTC: twenty complete daily sessions, median daily dollar volume of
at least $1 billion, 95% native minute coverage, 80% complete rolling thirty-minute windows, active/tradable/
marginable/shortable/ETB flags, at most fifteen candidates, at most five per sector and one Alphabet class.
It also required an event-weighted p95 spread no wider than five basis points in November 13's 15:00–15:02 UTC
sample. **Only NFLX passes that complete initial rule.**

After inspecting that result, an expanded sampling rule was frozen at 18:59:00.938 UTC, before its acquisition.
For 22 symbols it samples 10:00, 12:00 and 14:00 Eastern for twenty seconds on every session. One-second
decisions use only quotes already observed, no older than ten seconds, with positive two-sided prices and sizes.
Each symbol has 1,200 sampled seconds; missing, stale, withdrawn or crossed quotes remain unavailable.
The first second of a window commonly lacks a captured quote. Nothing is extrapolated to unsampled times.

The ten-stock alternative retains the structural rules and applies the existing five-basis-point gate at every
actual entry. This is an adaptive development decision, not an untouched holdout; one expanded window overlaps
the first sample. Both results and their different denominators remain visible.

| Symbol | Median daily SIP dollars, billions | Native minute coverage | Complete 30-minute windows | Sampled seconds eligible at ≤5 bp |
| ------ | ---------------------------------: | ---------------------: | -------------------------: | --------------------------------: |
| NVDA   |                             25.764 |                 99.97% |                     99.17% |                            63.17% |
| MU     |                             22.637 |                 99.82% |                     96.12% |                             3.75% |
| AAPL   |                             14.570 |                 99.99% |                     99.58% |                            48.50% |
| TSLA   |                             14.060 |                 99.83% |                     95.57% |                             5.17% |
| MSFT   |                             13.791 |                 99.71% |                     92.78% |                            18.75% |
| META   |                             12.138 |                 99.63% |                     91.04% |                             8.42% |
| AMZN   |                             10.354 |                 99.81% |                     94.40% |                            36.17% |
| GOOGL  |                              9.802 |                 99.95% |                     98.34% |                            19.17% |
| INTC   |                              8.770 |                 99.96% |                     98.89% |                            69.92% |
| NFLX   |                              2.573 |                 99.95% |                     98.34% |                            85.75% |

All ten were currently short eligible when captured. This is not historical borrow evidence or a promise of
future availability. The average complete-window coverage rises from 68.52% across fifteen old candidates
to 96.42% across ten new candidates. Mean sampled executable opportunity rises from 23.93% to 35.88%.
These are equally weighted descriptive averages on selected data. MU, TSLA and META frequently fail the
spread gate despite high consolidated volume; they cannot enter merely because they belong to the universe.
Historical API completeness does not prove native delivery by a future decision deadline.

The source universe is the union of all sixteen retained symbols and the six additions: 22 equity symbols,
`torghut-core-equity-v3`, symbol hash
`495e9255caedc2632da88b337af9aca2f59256d18c0c164598cff7ee990a476c`.
V2 source identities and frozen long-only protocols retain their original bytes.

## Same strategy, direction-specific implementation

V41 keeps JeV 1.14, completed source candles, the bounded Box chart stage and the final proposal-specific
Noul stage. Resistance rejection requires an observed resistance anchor, an upper invalidation stop and a
lower observed support target. Base breakdown requires a completed base and executable ask below it,
an upper invalidation stop and a measured downside target. Both ask independently about the bearish setup,
stop quality and intervening downside support. The supplied chart keeps actual prices and actual direction.

The final provider request holds at most four proposals and ten questions. Unsupported, refused, ambiguous,
unfunded or obstructed proposals abstain. Modeled target profit must cover the declared execution fees;
the judgment threshold is not represented as a calibrated win probability or a proven expected-value model.

Whole-share short entries require regular hours, a fresh account/configuration/asset proof and ETB stock.
An independent final broker check repeats eligibility before transmission. Unknown flags, revoked borrow,
disabled shorting, evidence fifteen seconds old, changed positions/orders or insufficient collateral block
opening exposure. The original sale floor, funded quantity, displayed bid size and 150% initial collateral
bound sizing. Short proceeds do not increase allocation capital. One position, 20% gross target allocation,
existing monetary limits and the fifteen-minute holding limit remain in force.

Native short brackets SELL with a higher BUY stop and lower BUY profit target. Partial parents are canceled
before arming standalone protection or covering; confirmed quantities bound covers. Stop-limit protection
can remain unfilled through a gap. Stops and a maximum-hold decision are not guarantees of a broker fill
at a given price or time. Borrow revocation blocks new shorts but does not disable an exact risk-reducing cover.
Broker Rule 201/SSR restrictions, rejects and uncertain outcomes remain broker execution evidence; historical
bid quotes do not prove a compliant or available short fill. HTB locates and overnight short positions are excluded.

The immutable execution document, PostgreSQL protection trigger, intent identity, signed inventory, exit
policy, reconciliation, accounting and TigerBeetle plans all bind the same direction. Sale proceeds create a
negative inventory basis rather than realized profit. Covers release the exact liability, including partial
and adverse covers. Unknown inference or operating expenses remain unknown.

The connected integration test discovered and repaired absolute-capital sizing, long-only price-order
validation, missing displayed-bid caps, cumulative collateral reproduction and upward tick rounding that exceeded
the unchanged stop-limit slippage cap. Standalone short OCO and stop-limit covers now retain their original
entry-decision admission audit through actual risk approval and submission-start records. Replay short valuations now
require ask liquidity. These were functional gaps that separate entry and broker tests did not expose.
Retained long accounting, protocol and financial receipt golden identities remain protected by regression tests.

## Feed capacity and performance

The existing Alpaca websocket allocation stays at thirty symbol/channel subscriptions: sixteen bars, seven
quotes and seven trades. The six new symbols' completed minute bars use bounded REST acquisition. Existing
REST quote/trade coverage expands within its current batching and rate limits. Webull's optional supplemental
priority follows the ten candidates, then retained symbols; Webull never supplies executable prices.

Completed REST minute bars require an exact minute start, finite valid OHLCV, completion before observation
and freshness measured from the bar end. Partial, stale and future bars are rejected. Acknowledgement follows
successful publication; failed publication remains retryable without fabricated bars. Independent quote,
trade and bar polling is bounded and concurrent. Shared request pacing/backoff no longer holds a mutex across
an HTTP request, so a slow quote response cannot serialize completed-bar acquisition.

Full forward-performance reporting remains outside the execution controller. A retained full report measured
57.085 seconds wall time, 55.815 seconds worker time and 754,792 KiB peak RSS; a thirty-second invocation failed
without publishing partial stdout. That budget miss is still a measured limitation, tracked in
[#15928](https://github.com/proompteng/lab/issues/15928), not a claimed speed improvement from the universe swap.

## Economic evidence and limits

The retained v40 generation cut has 174 execution transactions, 87 realized-close transactions, 38 completed
episodes and no open episode: $430.59 gross gains less $610.04 gross losses, **−$179.45 gross** on $94,518.12
starting capital. Transactions, partial closes and episodes are different units. The full-account status at
21:18 UTC spans retired strategies: 1,863 fills/transactions/receipts, −$1,224.323819 gross and $4,450.690374
execution fees, or −$5,675.014193 after execution fees. It must not be attributed wholly to v40 or v41.

All-in net profit remains undetermined. Historical UNKNOWN_USAGE expenses, incomplete cycle/operating-cost
coverage and unpriced research receipts are retained; they are not replaced with zero. The earlier numerical
short-control studies remain [separate empirical evidence](stock-short-research-2026-11-13.md): their adverse
results neither validate native bearish JeV judgments nor justify relabeling a numerical control as this strategy.

There is no qualified historical v41 return series. Retained v2 arrival captures do not contain the new v3
universe and cannot be relabeled. The historical REST acquisition was received on November 14; assigning it
fictional original arrival clocks would create look-ahead. Backtests can explicitly freeze short-account
eligibility, with source hash and retained-as-of or counterfactual timing; absent permission disables shorts.
Future permission cannot claim historical availability. Counterfactual research stays labeled in input and
comparison identity and supplies no prospective qualification.

## Verification and delivery evidence

The dedicated native tests exercise bearish provider responses through the actual request/receipt graph,
selection, negative weight, sizing and complete execution-document construction. Real PostgreSQL 18 verifies
durable source, risk and authority bindings and rejects wrong direction, fractional quantity and one-micro
stop substitution. With TigerBeetle 0.17.9, that same persisted entry drives signed fill accounting, partial
and adverse covers, client restart, duplicate replay and exact account verification.

All four isolated unit shards passed: 5,609 tests, with 1,450 explicit integration skips. Formatting, both lint
modes, complete and production TypeScript checks, and trading and research builds pass. The extended native
PostgreSQL/TigerBeetle test passes both persistence modes, including protective submission admission.

Additional tests cover final borrow/configuration revocation, stale account/asset/configuration evidence,
150% collateral, covers after revocation, profit/stop/maximum-hold management, bracket request bodies and
checkpoint restoration. The provider's platform, websocket, TA and Flink suites and ktlint pass. The Python
audit tests pagination, unconsumed/missing pages, unrequested symbols, DST, future quotes, stale quotes and
withdrawn/crossed sides. These are synthetic contract checks, not actual broker fill or profitability evidence.

The settlement change is [PR #15945](https://github.com/proompteng/lab/pull/15945), main
`896338d216e9c1ff5a2ae7a7a24177260336db9c`. Its CI completed successfully. Normal immutable publication
`43639306848` and Kargo/Argo delivered API digest
`sha256:9f16522c4e510492ae8cda5e6e5102bd89b03cfb6688713189ad520f96187e63`.
At 21:18 UTC the API reports sandbox, read-only access, no capital authority, clear OBSERVE and exact accounting.
The [cutover runbook](equity-short-cutover.md) governs successor admission and same-account PAPER activation.
V41 implementation release and activation evidence must be appended after verification; this settlement image
does not contain or activate v41.

## Private evidence reproduction

Raw membership responses, source pages, pagination receipts, calendars, account/asset observations and frozen
sampling rules remain private. Archive `/tmp/bayn-jev-short-sp100-evidence-20261114.tar.gz` on the authorized
agents-shell host has 39,072,957 bytes and SHA-256
`f9ffae0bc429ad069423c09ea42e0e7edce70086c5ec9eb8fed64a9806c648bb`.
It contains the original acquisition corpus and intermediate reports; account identifiers and quote payloads
are deliberately absent from Git. The final audit is
`/tmp/bayn-jev-short-sp100/study-final-verified.json`, SHA-256
`e18b705ed5f43ea7179f3b62273b710c0538a96977db26c06e2fa4ea90a929ad`.
Both objects are also retained in the existing private research capture bucket
`bayn-research-captures-b7849792-71db-4b29-99b6-6b8c76dda60a`, under
`captures/v1/investigations/native-short-sp100/2026-11-14/`, named by the hashes above with `.tar.gz` and `.json`
extensions. Conditional creates prevent overwrite; complete object readback reproduced both SHA-256 values and
the archive's byte count. Existing storage identity and permissions were used.

Reproduce from that private directory with:

```sh
python3 services/bayn/tools/sp100-universe-study.py \
  /tmp/bayn-jev-short-sp100/capture-expanded /private/new-study.json
python3 -m unittest discover -s services/bayn/tools -p test_sp100_universe_study.py
```

The audit checks the issuer's original CSV hash and exact constituent rows, every successful response's bytes
and SHA-256, full pagination, duplicate bars, repeated exchange calendars and acquisition after each frozen
sampling rule. It does not fill missing minutes, forward-fill quote gaps beyond ten seconds, purchase data,
create a locate or place orders.
