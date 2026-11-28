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
That settlement image preceded v41. Verified native release, data-source rollout and successor activation evidence
are recorded below; these later observations supersede its historical OBSERVE snapshot.

## Review closure and regression evidence

The native short review identified four additional execution gaps, all addressed in the owning paths:

- Broker reporting now reproduces the rounded intraday short-sale average through partial covers from complete,
  ordered native short transactions. A two-price sale followed by a partial cover retains the exact ledger basis
  of -200,000,067 micros while proving the broker's -200,000,066-micro reported basis; unrelated quantity,
  average, sign and cost changes still fail reconciliation. Missing fill ordering cannot establish this proof.
- Execution assessments derive liability ownership from the sealed short entry and bound exit/liquidation evidence.
  Opening SELLs establish inventory and BUY covers consume it. Native and independently admitted OCO/stop protection
  retain the entry owner, prices and verified broker provenance. Premature covers, excess covers and model substitutions fail.
- Expired-entry cancellation locks and reads the exact protection tag before admitting a SELL short bracket.
  Plain SELL exits and unrelated protection tags remain excluded. All 24 PostgreSQL cancellation cases pass.
- A negative allocation that rounds below one whole share persists a zero-share abstention. It creates no intent or
  collateral reservation; actual short targets still require direction, eligibility and quantity checks.

The three measured partial-entry/re-entry scenarios pass against isolated PostgreSQL and TigerBeetle (108 assertions).
Their economic checks permit multiple legitimate broker fills while requiring one entry parent, a partial quantity,
entry-before-exit ordering, equal aggregate opening/closing quantities, terminal cancellation, exact accounting and
completed cycles. Both retained v38/v39 Box-cutover cases pass with the original source universe (18 assertions).
These are synthetic execution and accounting proofs, not observed market profitability.

A later automatic review also exposed a retained SELL-only durable protection-cancel predicate and long-only
assessment valuation. Cancellation now derives the admitted broker side from the immutable protection tag, including
BUY short protection. Valuation takes the registered protocol's exact universe profile, reconstructs signed inventory,
and subtracts ask-priced short liabilities with upward rounding. Retained long marks keep their bid-side shape and
downward rounding. PostgreSQL/TigerBeetle native regressions pass 54 assertions, including cancellation direction and
deduplication; signed inventory and endpoint valuation regressions preserve unqualified nonflat-session status.
Reported closing-fill counts now use the posted accounting direction: BUY covers close shorts and SELLs close longs.
The three-fill short episode reports two covers and one completed position episode in both the native database
diagnostic and the financial receipt. Opening short-sale proceeds do not count as a realized close or trading profit.

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

## Verified native release

Implementation PR #15946 merged as `503cb2d60c58c5309c2e031d032069481ac4b0db` after 44 successful checks
and ten explicit skips. All seven actionable review findings were repaired and resolved. Publication run
`43653777069` succeeded and produced the verified immutable cohort:

| Role        | Digest                                                                    |
| ----------- | ------------------------------------------------------------------------- |
| Trading/API | `sha256:0b6ddb52c548cb16791843a3a6c13e20e06abe81cce3f99e9b1833d6dd4cd841` |
| Research    | `sha256:972e1295de1932d5c1fa07edc82baf1a943080646966ece4ff6899bf0b8165f5` |
| Broker feed | `sha256:92981bb0c85fa1004bb6574931ef735ccab39cfd69673cf8f6a719d34fab0c15` |

Kargo verified Freight `e6f26908cf2676667437bd2d44d69ce4eb4f625b`; Argo completed generated revision
`726b830bc6528f452a39b9445c7dfc1b0720e47f`. Both API replicas reported embedded source and digest matching
that cohort, READY, sandbox/read-only/no capital, clear OBSERVE, exact accounting and reconciliation, and
parameter hash `004604dcc48754ff553976d366a4d7643a6a3a1157acac4b89acc879b56c4696`.
The live controller subsequently recorded a WINDOW_CLOSED pass with execution source 503cb2d.

All six data-service publication workflows also succeeded. Torghut's coordinated five-image Freight
`bb5e876e3cc59b8423754b5405f4e2a8c02888db` verified successfully and Argo completed
`ab34a8ce1ad6209edf2e00a21a165d189da34a0a`. The separate Webull Freight
`c9c5411c0e70dee4e0e6cc76c1f4e49df10c0685` verified successfully at Argo revision
`c24f7ec4f7d5c0390a371e50dc0b82c5adb7c2bd`. Runtime ConfigMaps contain the exact v3 universe/hash,
the six added completed-REST-bar symbols and all ten entry candidates first in Webull's priority list.
The websocket subscription allocation remains thirty.

A complete sorted JSON-row fingerprint taken before and after admission migration 200 retained all
1,863 accounting transactions and 1,863 accounting receipts exactly. Transaction SHA-256 is
`0a4adea1372224165b5bc3b2c920859c1c91ddb0adfc2f39127c9fe81c921063`; receipt SHA-256 is
`6028f402185e6e80dc5cac6dfcae0fffe34556d62c14450fec8f3fe7482c4447`.
The post-admission cut at November 15 00:14:16.330818 UTC has zero active cycles, unsettled intents and
missing receipts. These fingerprints describe immutable financial rows, not all mutable operational tables.

Fresh same-account broker reads at November 15 00:28:32–00:28:40 UTC found ACTIVE status, shorting enabled,
no trading/account/user suspension and `no_shorting=false`. Every one of the ten candidates was active,
tradable, marginable, shortable and easy to borrow. No order was placed by this read-only check.
The broker clock was closed and reported the next regular open as November 16 14:30 UTC. Eligibility
is a current observation; the native pipeline refreshes it before each opening decision and transmission.

The same-account mandate was constructed only after the verified native rollout. Existing strict constructors
preserved the broker identity, Research grant class, activation preflight and monetary limits. Its public request hash
is `6856f071e54529227ea48fa7b077506209ffd887c939d7351e948d7e03020130`; account-bound risk hash is
`3b741fadd3dc9e155777f94de16c28f6fd4fbc4b610d16be9bbcb4372a0c2882`. The expanded source union changes
the derived allowed-symbol/order ceiling from nineteen to twenty-five; the entry strategy still permits one
position and 20% gross allocation. Only ciphertext and public strategy/build identity enter Git.

The activation change also corrected a stale CNPG contract assertion. The activation invocation key is owned
by Kargo and derived from the promoted image digest, while the capital request remains independently bound
through its sealed identity and build lineage. The original assertion failed before correction; the combined
activation, Kargo, CNPG and configuration suites then passed 151 tests with 3,091 assertions. The corrected test
also passes formatting and lint. No request hash, lineage check or native financial guard was relaxed.

## Exit-tail attribution and alert repair

A read-only November 15 trace joins the four retained v40 episodes to their exact accounting entry clocks,
durable cancellation commands and receipts, broker order observations, closing intents, mutation events and
controller observations. The maximum-hold deadline is first fill plus 900,000 ms.

| Symbol and opening UTC | Deadline evaluation lateness, ms | Cancellation request to HTTP 204, ms | HTTP 204 to first canceled-order observation, ms | Deadline to closing intent, ms | Deadline to closing fill, ms |
| ---------------------- | -------------------------------: | -----------------------------------: | -----------------------------------------------: | -----------------------------: | ---------------------------: |
| IWM 16:09:41.779       |                              630 |                                  259 |                                            14098 |                          17877 |                        25672 |
| NVDA 16:37:18.222      |                              458 |                                  251 |                                            20556 |                          24252 |                        30810 |
| AAPL 17:14:56.771      |                              481 |                                  264 |                                            12230 |                          49620 |                        51192 |
| NVDA 17:40:09.741      |                              564 |                                  307 |                                             6484 |                          10814 |                        16974 |

All opening clocks are November 13, 2026. These are four observed tails, not population percentiles or a fill-time guarantee.
The AAPL controller recorded post-mutation reconciliation at 17:29:57.555, broker-observation waits at
17:30:02.973 and 17:30:18.952, and another reconciliation after protective recovery at 17:30:17.468.
Its next durable completions were 17:30:47.843 and the close-submission receipt, after a refreshed broker observation.
The observations establish waiting in the broker evidence path; they do not allocate every millisecond to transport,
quota, decoding or SQL. Cancellation acknowledgement alone cannot authorize an overlapping liquidation order.

The overdue critical alert also had a concrete false-positive cause: both exported next-due timestamps were zero
while controller completions remained fresh. PR #15947, main a227eebf35004a0b9c1a66fbda0e5d707365dcb0, uses
a positive explicit deadline or, when no positive deadline exists, a positive last completion. Explicit deadlines
remain authoritative. Five tests across four files pass with real promtool 3.5.0, including nine PromQL scenarios.
Argo completed the normal rule-loader hook, Mimir returned the corrected rule, and the false overdue alert cleared.
The valid research-cost-coverage alert remains active.

The native release's initial Attic downloads failed with incomplete HTTP streams. A subsequent complete transfer
of the same Webull image NAR reproduced the signed 190371840-byte content and SHA-256
84649c1146dd637eb19eee745e5a2ed8b16fc91651757e3ed5825c0dc4cd96b6.
Normal failed-job retries subsequently completed all six data-service publication workflows. No image checksum,
cohort gate or source verification was bypassed.

## Current-image full-report measurement

A separate read-only command on the embedded 503cb2d trading image, API digest
`sha256:0b6ddb52c548cb16791843a3a6c13e20e06abe81cce3f99e9b1833d6dd4cd841`,
retested the retained v40 authority generation without receipt persistence. The 30,000-ms supervised run failed
after 31,106.249499 ms, emitted zero stdout bytes and measured 685,596 KiB process-lifetime peak RSS.
A complete CPU-profiled run at November 15 00:55:01.827–00:55:59.520 UTC succeeded in 57,690.276533 ms;
the worker measured 56,829 ms and 769,704 KiB peak RSS. Profiling adds overhead, so these runs do not establish
a regression or improvement relative to the previous unprofiled command. They establish that the current image
still misses the thirty-second target.

The complete report has 151,079 bytes, SHA-256
`3a35e96e822bcd8271b2a71d8eca9145bc5c90c6d2127e3349744185f08a7f78`, report hash
`83dc6b9bd6af595ac3204597ba309f1ee3104c2c6e9d936ccdfab3c12b4e6ab5`.
The private CPU profile has 13,179,802 bytes, SHA-256
`7ff75caa9380cec9f0cf4861e194b9f5de74b75242c684a25cdb95279800b285`.
Both were copied out before the successor rollout and retained with mode 0600 in the owned checkout's ignored
`services/bayn/node_modules/.cache/native-short-activation/` directory. Raw financial output is absent from Git.

That fresh report reproduces the retained generation's −$179.45 gross result and $13.61 execution fees:
−$193.06 after execution fees, before unresolved inference and operating costs. It reports INCOMPLETE
operating-cost coverage, null all-in net profit and UNDETERMINED profitability.

Aggregated self samples include 7,347.518 ms in canonical object serialization, 2,538.405 ms in canonical value
serialization, 2,393.371 ms in key inspection/sorting, 1,869.853 ms in array serialization and 2,927.989 ms in
hash updates. Other sampled time includes 7,317.846 ms idle, 2,914.008 ms garbage collection and 2,286.588 ms
in synchronous zlib calls under candle-image reconstruction. These are sampled call-site costs from one run,
not independent causal estimates or evidence that validation can be skipped. The API remained READY,
account reconciliation stayed EXACT and controller completions continued after the deadline test. Reporting
remains prohibited in execution-controller workloads. Issue #15928 remains open; no deadline, financial hash
contract, evidence validation or unknown-cost rule was weakened to produce an apparent pass.

## Verified same-account PAPER activation

Activation PR [#15948](https://github.com/proompteng/lab/pull/15948) merged as
`ad84f399433f434f2e2b747e196fe5dc57d504f1` after 33 successful checks and closure of its review finding.
Main publication `43659466691` completed successfully with all 39 jobs passing. Every cohort member carries
that exact source revision and run receipt:

| Role        | Digest                                                                    |
| ----------- | ------------------------------------------------------------------------- |
| Trading/API | `sha256:bf7edda01fd92da30fbc5923b9d10a210c6ce3f3063641351a5a3468795edc2f` |
| Research    | `sha256:b2ba2563af7be00c404f269f158dfba75456a909e7e86f447bd0195f2d8d5993` |
| Broker feed | `sha256:ad7a8c2b8cf89f877e867cac419bbe24d95e1b3b3506ada74788a5213ac68e05` |

Kargo promoted and successfully verified Freight `1895593e412ae42899f3810c6122f3d143035eb5` through
`bayn.01m7ebx4ayyz2hyvng6ee1gvje.1895593`. Argo completed generated revision
`bda29f573ae9ea425bdb21a2e225c3fd01982491`, Synced and Healthy. Its native activation hook completed
before the API rollout; no direct deployment, image-pin substitution or database authority update was used.

At November 15 01:09:34.679081 UTC, the database recorded maximum/effective PAPER, kill CLEAR, version 1844,
generation `d6abce6b2c40368d6300d9f9897b877c393e49d55c89c9a86eb6b458b751f76f`, v41 parameters/behavior,
the account-bound risk hash above and the exact ad84f399 activation source/digest. Actual controller work
completed at 01:09:31.481 UTC from that source with WINDOW_CLOSED. At 01:10:33–01:10:34 UTC, both new API
replicas returned HTTP 200, READY, exact accounting, exact reconciliation with zero discrepancies and coverage
of the latest mutation, sandbox mutation access, granted capital and the matching Realized/Research/Standing
mandate. Kargo advanced the activation lineage to ad84f399 while preserving the authored 503cb2d identity.
The public API calls PAPER authority “execution”; the durable database enum is PAPER.

The 01:10:04.138773 UTC post-activation cut again reproduced all 1,863 transaction and receipt rows with the
unchanged fingerprints above, zero active cycles, zero unsettled intents and zero missing receipts. Independent
broker reads at 01:11:07.899–01:11:10.930 UTC verified the configured account by equality without publishing its
identifier: ACTIVE, shorting enabled, `no_shorting=false`, no trading/account/user suspension, zero positions
and zero open orders. These five requests were read-only. The broker clock remained closed, with next regular
open November 16 14:30 UTC. Existing account identity, monetary limits, one position, 20% gross allocation and
15-minute maximum hold remain in force.

Post-rollout Mimir retained only the valid research-cost-coverage alert. A five-minute aggregate failure query
also contained predecessor 503cb2d API observation-fence failures during ownership handoff; source/pod-specific
readback confined those series to the two predecessor APIs. The new ad84f399 source returned no failed/interrupted
operation series in that window, and the structured ERROR query returned no rows. The observation owner is
revision-fenced in the implementation; a superseded API cannot admit a different revision's broker cut. Absence
of a metric series or log row is bounded observation, not a guarantee against every failure.

This completes the native implementation, revised universe/feed delivery and same-account PAPER activation.
It does not establish a fresh regular-session short fill, an untouched v41 return series or positive all-in
profitability. The full-report latency miss and historical cost-evidence gaps remain open with their measured
limits; neither is replaced with a successful test or an assumed zero cost.
