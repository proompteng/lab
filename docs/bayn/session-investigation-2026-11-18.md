# Bayn loss investigation: completed November 4–17 sessions

## Result and financial boundary

The exact fourteen-day interval is **2026-11-04T01:07:22Z through 2026-11-18T01:07:22Z**, exclusive at the end.
It contains ten completed equity sessions in the retained **PAPER** account, **1,107 accounting transactions, 1,107 matching receipts,
and 225 closed flat-to-flat episodes**: 121 winners and 104 losers. Every instrument ends with zero quantity.
There are no crypto transactions or fee-accrual rows in this interval. The earlier November 3–17 comparison is
fifteen calendar days, not this fourteen-day result.

Gross trading profit is **$57.77**. Broker cash/equity falls from **$94,264.95 to $94,241.67**, a **$23.28 loss**.
The cash bridge reproduces that change exactly:

| Cash component                               |    USD |
| -------------------------------------------- | -----: |
| Realized gross trading profit                |  57.77 |
| Broker fee cash postings inside the interval | -81.05 |
| Broker cash/equity change                    | -23.28 |
| Unexplained residual                         |   0.00 |

The first cash fee posting includes **$2.33 attributable to November 3**. Attributing expenses by trading session
instead gives $78.72 of known November 4–16 fees and a **-$20.95 known economic subtotal**. These are different
date bases, not conflicting results. November 17 fees had not posted at the cut; actual fully costed profit is
unknown. Missing inference, infrastructure, data and research expenses are not zero. An exact broker cash bridge
does not establish complete costs.

| Session | Episodes | Wins / losses | Gross USD | Known session fees USD |
| ------- | -------: | ------------: | --------: | ---------------------: |
| Nov 4   |       14 |        10 / 4 |     97.60 |                   5.41 |
| Nov 5   |        2 |         1 / 1 |     10.66 |                   0.79 |
| Nov 6   |       16 |         9 / 7 |     30.97 |                   6.17 |
| Nov 9   |       28 |       18 / 10 |     62.45 |                  10.43 |
| Nov 10  |       15 |        5 / 10 |    -10.23 |                   5.73 |
| Nov 11  |       28 |       15 / 13 |     41.58 |                  10.51 |
| Nov 12  |       38 |       17 / 21 |     75.88 |                  14.37 |
| Nov 13  |       38 |       20 / 18 |   -179.45 |                  13.61 |
| Nov 16  |       31 |       15 / 16 |   -111.92 |                  11.70 |
| Nov 17  |       15 |        11 / 4 |     40.23 |                Unknown |

Completed November 17 supersedes earlier partial-session losses. Its fourteen long episodes earn $24.06 gross;
its NFLX short earns $16.17. All fifteen are flat. The latest fill is at 21:02:38.459 UTC; fresh exact
reconciliation and the zero-position snapshot independently confirm closure.

## Where the gross result comes from

Every closing fill belongs to exactly one episode; mixed exits retain every mechanism. Fees are account/session
activities and are not fabricated as per-mechanism allocations.

| Actual exit mechanism                       | Episodes | Gross USD |
| ------------------------------------------- | -------: | --------: |
| Native take-profit                          |       79 |  1,634.57 |
| Native stop-loss                            |       38 |   -928.94 |
| Jev protective stop                         |       68 | -1,127.13 |
| Maximum hold                                |       17 |    149.75 |
| Native take-profit plus released protection |       10 |    107.92 |
| Native stop plus Jev stop                   |        2 |    -31.86 |
| Native take-profit plus Jev profit target   |        8 |    255.97 |
| Jev profit target                           |        3 |     -2.51 |
| Total                                       |      225 |     57.77 |

Fees consume an already thin gross edge. November 13 and 16 contribute $291.37 of gross losses; November 17
recovers $40.23. This classifies realized exits, not the profit a different policy or faster execution would earn.

## Entry economics and independent chronological checks

All **84** original funded plans from November 13, 16 and 17 reproduce their entry-price and quantity ceilings
with exact integer arithmetic. There are no cap breaches. All November 17 realized losses are below original
modeled stop loss. The only modeled-risk exceedance in these 84 episodes is the already documented November 13
NVDA exit that stalled for approximately 62 minutes.

Current model questions ask whether a support recovery or base breakout exists and whether the stop invalidates
that structure. A 0.70 affirmative threshold is **not** a calibrated probability that the target beats the stop.
Funding requires positive modeled target gain after transaction fees, not positive expected value. A high hit rate
can coexist with negative profit when winners are small relative to losses.

The November 13 research note froze `G = targetNet - acquisitionCost`, `L = acquisitionCost - stopNet` and ratio
bins below 0.25, 0.25–below 0.5, 0.5–below 1 and at least 1. Independent reconstruction of the two later sessions:

| Later original-plan group | Episodes | Wins / losses | Gross USD |
| ------------------------- | -------: | ------------: | --------: |
| G/L below 0.25            |       23 |        14 / 9 |   -137.09 |
| All other ratios          |       23 |       12 / 11 |     65.40 |

The low-ratio group has the higher hit rate and still loses. Its conditional two-endpoint break-even fractions
are approximately 89%; those fractions assume target-or-stop settlement and are not model forecasts. Actual
early exits, holding exits and additional costs differ. Only **two later session clusters** are available,
opportunities depend on the existing strategy, and no alternate portfolio was executed. The difference is
descriptive chronological evidence, not a causal effect, avoided-loss amount, independent-trade confidence
interval or qualified cutoff.

Further source checks reject unsupported repairs. The prior implementation did not require all target gains to
exceed stop losses. Box confidence is localization evidence, distinct from pattern presence and final structural
judgment; a 0.70 Box-confidence floor would suppress all 84 plans. A prior stop touch is deliberately an observed
fact, not a deterministic rejection of a later recovery. Neither threshold is restored as a regression fix.

## Mandatory exits during archive failure

The fallback rejected a reproduced `MAXIMUM_HOLD` exit before the final session-close window, even after the
original first-fill-plus-15-minute deadline. It also rejected profit-latched exits after that deadline, although
their existing limit floor or ceiling had expired by time.

Caller regressions reproduce long and short maximum hold and long and short profit latches at exactly 900,000 ms.
Actual position management creates the timed target without market data; the archive fails, fresh reconciliation
succeeds, and the reducing position-mark close proceeds. All four fail before the fix. The fix permits only fully
reproduced, identity-bound targets after the original deadline. Profit latches before that deadline retain the
quote-backed path. Original lease, reconciliation, orders, mutation, accounting, inventory and authority gates
remain mandatory.

## Native partial take-profit investigation

The protection contract says partial native take-profit fills reduce remaining stop coverage without repricing it.
The prior position reader instead latched every accounted protective disposal as an exit. Management then canceled
an otherwise healthy remaining native group and submitted an ordinary residual close.

A November 17 AAPL episode supplies a native example: 14 of 53 shares take profit at $350.81 at 20:32:31.866 UTC;
the remaining 39 close at $350.74/$350.73 before the original $350.22 stop or holding deadline. This establishes
the sequence and contract mismatch, not a counterfactual target fill for those shares. Classifying verified
take-profit disposal as inventory reduction must preserve stop/rejection recovery and every retained portfolio's
original source verification and hash.

Fresh managed portfolios carry `bayn.jev-protection-evidence.v2`. Only a take-profit fill with exact native
account, intent, symbol, side, conditional price and parent binding is an inventory-only reduction. A verified
native stop still authorizes reducing recovery and releases an earlier profit restriction; unknown child roles
retain a conservative latch without fabricating stop evidence. Untagged retained portfolios use the original
derivation. New cancellation command times use the per-account database clock sampled after the writer lease and
intent lock. The unrounded time checks the original deadline; the stored millisecond key matches receipt lookup.
Replay aligns its market clock with that committed admission before any broker response. The original trigger and
commit deadline remain unchanged. Source ordering uses the reconciliation cut and the existing serialized writer;
it is not a general PostgreSQL commit-time watermark.

A later independent quote-backed profit trigger can still request cancellation of a healthy residual group. Its
closure must bind that exact command and original target, not the earlier take-profit inventory reduction. The
three previously failing replay cases now check this complete cause, preserved residual coverage, re-entry and
accounting. Stop or unknown-disposal exits still require their actual causal fill.

An independent method-selection defect canceled an otherwise exact bracket/OCO when a partial fill left fractional
inventory. Existing verified equity protection now remains valid during the regular session with exact quantity,
stop and target coverage. New protection still uses provider sizing rules; session changes, bad coverage, crypto
method restrictions and due exits remain enforced. This defect was reproduced separately and did not cause the
three whole-share replay assertion failures.

## Inference admission and validation limits

The November 17 cost-ledger read verifies 870 parent claims, 1,740 stage quotes and 1,082 transfers with an exact
ledger prefix. Known estimated inference expense is $0.306205536; 274 stages retain unknown usage. November 16 has
1,007 claims, a $0.410036130 known estimate and 48 unknown stages. Neither report is invoice-reconciled. Neither
has missing quotes or unverified acknowledgements. A receipt gap is not free inference.

The 20:52 November 17 admission takes 10,223 ms and misses its original ten-second window. PostgreSQL records a
10,169.506 ms `COMMIT`, accounting for 99.5% of admission time. Retained primary `SyncRep`, standby `WalInitSync`,
flush lag and disk queues corroborate a durability tail. Two native request preparations take 85.4 ms cold and
9.8–38.3 ms warm, disproving them as that ten-second cause. Low CPU/throttling and ample disk space do not justify
a resource-limit increase. The disk-contention writer is not established; weakening synchronous durability or
extending the inference deadline is not a supported repair.

The expired pre-HTTP path now records `bayn.staged-terminal-receipt.v2` positive non-dispatch evidence before
returning typed `DEADLINE`. It creates no successful abstention or fabricated handoff. Version 5 expense quotes
bind both stages to that exact immutable terminal: a non-dispatched chart stage cannot produce the committed
`READY` handoff required to call Jev. Zero provider-token usage requires that complete source graph, not just a
missing response. The database checks request, claim, deadline, native account and session binding; both stage
quotes are required before the obligation clears. Paid responses, mixed batches, commit failure and interruption
retain their evidence. Legacy terminal/quote bytes and historical unknown usage remain unchanged. This proof
does not assign zero infrastructure or other operating expense to an expired request.

The fixed matched-entry experiment is long-only. Its previous preparation discarded a selected v41 short's
direction and passed its symbol to a BUY-then-SELL simulator. That output cannot validate the current long/short
strategy. Short comparison needs separately frozen borrowing, collateral, costs and signed lifecycle assumptions;
flipping one order side cannot supply them. Current v41 has only two completed sessions, November 16/17; the
experiment requires five consecutive sessions and independently witnessed timing, capacity, costs and complete
inventory. Historical v40 development sessions cannot replace a current prospective comparison.

## Evidence

Private economic packet: `/tmp/bayn-econ-deep-summary-20261118.json`, SHA-256
`127a2976d3184a928ce8167e1be058e8048685d155ce3b586eea62c8450d6864`. It links native SQL, per-fill/episode
reconstruction, daily mechanism counts, selected judgments, cash bridge and instrument coverage.
Independent frozen-bin reconstruction: `/tmp/bayn-entry-frozen84-independent-validation-20261118.json`, SHA-256
`43244dec1f73ec6995bd1fa101afa6ebb06077bb631d0a98c0a56c1ce8c297ab`.
Full source packets remain outside Git and CI artifacts. This report neither grants capital authority nor
establishes economic qualification. [Issue 15936](https://github.com/proompteng/lab/issues/15936) tracks remaining
fully costed, prospectively controlled evidence.

A bounded read-only search of connected Drive files at approximately 01:47 UTC found no usable Bayn invoice,
allocation or operating-cost packet. That search establishes no usable packet in that connected source, not the
absence of expenses or evidence elsewhere.
