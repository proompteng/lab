# Bayn $10,000 Alpaca Paper accounts

Keep one broker writer and one private, durable journal directory per account. These runners are standalone Paper
tools, not Bayn activations. The study and the shadow receipts do not establish fills, qualification, or live authority.

| Account                                          | Owns                                                       | Operating boundary                                                                                                                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 — intraday                                    | Existing intraday runner                                   | Keep its account, strategy and risk controls separate. Do not run either macro CLI there.                                                                                                                                              |
| #2 — $10k Paper, `bayn-alpaca-macro-core-auth`   | `F4`; `F2_F4_EQUAL` is an alternative, not a second writer | The standalone [core CLI](../../services/bayn/tools/macro-etf-core-runner/README.md) still always reserves QQQ/SMH. It reviews every 42 sessions and uses a 10% aggregate drift band.                                                  |
| #3 — $10k Paper, `bayn-alpaca-macro-canary-auth` | `O1`                                                       | Run the [canary CLI](../../services/bayn/tools/macro-canary-runner/README.md) without `--exclude-symbols` or `--capital-budget-usd` to keep QQQ eligible. It reviews every 21 sessions and uses a 10-percentage-point per-symbol band. |

## Account #1: the legacy PDT floor is not a Paper funding requirement

The legacy FINRA pattern day trader (PDT) rule required **$25,000 equity** in a live margin account designated PDT.
The replacement intraday-margin standards took effect on June 4, 2026, with a permitted broker transition through
October 20, 2027; the new standards remove the fixed PDT minimum. Confirm which rules and house requirements apply to
the actual account before any live use. [FINRA Regulatory Notice 26-10](https://www.finra.org/rules-guidance/notices/26-10),
[Alpaca's intraday-margin guidance](https://docs.alpaca.markets/us/docs/understanding-the-new-intraday-margin-rule).

A **$10,000 [Paper](https://docs.alpaca.markets/us/docs/paper-trading)** balance is simulated. It neither satisfies a
legacy live PDT requirement nor proves that the broker or Bayn would admit the same live trades. Keep Account #1's
current configuration; use the existing [read-only post-close audit](intraday-v2-1-execution-upgrade.md#post-close-paper-promotion-separate-reviewed-change)
with its approved database identity and the provider's actual regular close:

```sh
bun services/bayn/tools/audit-intraday-alpha-session.ts \
  --session "${SESSION:?set the New York session date}" \
  --account "${PAPER_ACCOUNT:?set the verified Account 1 ID}" \
  --regular-close "${CLOSE_ET:?set the provider close in HH:MM ET}"
```

## Accounts #2 and #3: shadow, inspect, then submit only if approved

Start from the repository root. In **separate shells**, inject `BAYN_ALPACA_KEY_ID` and `BAYN_ALPACA_SECRET_KEY` from
the corresponding approved Paper secret. Do not print them, put them on the command line, or reuse Account #1's keys.
Set `PAPER_ACCOUNT_UUID` to that account's independently verified Alpaca UUID and `SESSION` to the **upcoming regular
session date** in New York. Run after the previous session's 20:15 ET finalization and before the next regular open
minus two minutes (09:28 ET exclusive on a normal day). Keep even the non-review and zero-order receipts.

```sh
# Account #2 shell only. BAYN_PAPER_STATE must be on durable storage.
umask 077
export BAYN_ALPACA_BASE_URL=https://paper-api.alpaca.markets
dir="${BAYN_PAPER_STATE:?set a private durable root}/account-2"
install -d -m 700 "$dir"
bun services/bayn/tools/run-macro-etf-core-rebalance.ts --profile F4 --tif opg \
  --output "$dir/${SESSION:?set the next execution session}-shadow.json"
```

```sh
# Account #3 shell only, with different credentials and UUID.
umask 077
export BAYN_ALPACA_BASE_URL=https://paper-api.alpaca.markets
dir="${BAYN_PAPER_STATE:?set a private durable root}/account-3"
install -d -m 700 "$dir"
bun services/bayn/tools/run-macro-canary-etf-rebalance.ts --tif opg \
  --output "$dir/${SESSION:?set the next execution session}-shadow.json"
```

In each shell, require the shadow receipt to match the intended account and session, then inspect the raw marks,
reconciled positions, funding, and proposed orders privately. A prior order or uncertain journal entry requires
reconciliation before proceeding. Use a new filename for every observation; never change directories to bypass a journal.

```sh
jq -e --arg account "${PAPER_ACCOUNT_UUID:?set the verified Paper UUID}" --arg session "$SESSION" \
  '.reconciliation.account.id == $account and .executionSession == $session and .plan.blocked == null' \
  "$dir/$SESSION-shadow.json"
```

Use **only the applicable command** below, after review and explicit Paper approval. To run the blend instead of F4,
change `--profile F4` to `--profile F2_F4_EQUAL` in both core commands before making the session's single submission.

**Account #2 only:**

```sh
bun services/bayn/tools/run-macro-etf-core-rebalance.ts --profile F4 --tif opg \
  --mode paper-submit --confirm-paper-account "${PAPER_ACCOUNT_UUID:?set Account 2 UUID}" \
  --output "$dir/$SESSION-paper.json"
```

**Account #3 only, in the separate canary shell:**

```sh
bun services/bayn/tools/run-macro-canary-etf-rebalance.ts --tif opg \
  --mode paper-submit --confirm-paper-account "${PAPER_ACCOUNT_UUID:?set Account 3 UUID}" \
  --output "$dir/$SESSION-paper.json"
```

The runners use whole-share opening-auction limits inside a 15 bp collar and do not budget against expected sell
proceeds. If dispatch was journaled but unacknowledged, stop and look up the recorded client order ID in Alpaca;
do not resubmit. Verify actual fills and remaining cash/positions after the open. An isolated canary below $25,000
can now take one affordable lot if proportional clipping would otherwise erase every one-lot buy and there are no
sell candidates. It stays inside existing cash, buying-power, and gross limits; sizing at $25k and up is unchanged.
In the [raw-price regression](../../services/bayn/tools/small-account-10k.test.ts), a $747 cash budget can buy one
SPY at its $729.09 limit; with buying power capped at $700 it can buy one QQQ at $520.78 instead.

## Frozen 10.9-year sizing evidence

2,741 sessions, **2016-01-04 through 2026-11-25**, from the hash-verified S3 exports under
`bayn-research-datasets/2026-11-27-sip-10yr-sp100/` and `2026-11-27-sip-10yr-sp100-supplement-dia-uup/`, plus the
registered calendars. The core paths honor their default QQQ/SMH protection; O1 is isolated and can use QQQ. The two
arms share targets, review cadence, prior-close deadbands and 2/5/10 bp **all-in per side**. They mark carried positions
through the next open and simulate funded sells then buys at that open, with no leverage or cash interest. The archive
has split/dividend-adjusted prices only: the integer arm buys **adjusted-share lots**, not historical raw broker shares.
This isolates sizing on the frozen tape; it does not model the Paper limit collar, partial fills, or pre-trade funding.

Annualized tracking error is `sqrt(252) × sample SD(whole − fractional daily net returns)`, in percent. Returns include
the common cash warmup. The CLI emits all 36 cases, unrounded metrics, archive/target hashes, and review diagnostics.

| Profile     | Starting equity |      2 bp |      5 bp |     10 bp |
| ----------- | --------------: | --------: | --------: | --------: |
| F4          |         $10,000 | 1.093850% | 1.099581% | 1.118698% |
| F4          |         $25,000 | 0.584739% | 0.582868% | 0.584546% |
| F4          |        $100,000 | 0.212866% | 0.212271% | 0.213079% |
| F2          |         $10,000 | 1.030294% | 1.031203% | 1.044109% |
| F2          |         $25,000 | 0.625463% | 0.617884% | 0.619035% |
| F2          |        $100,000 | 0.513349% | 0.512091% | 0.509705% |
| F2_F4_EQUAL |         $10,000 | 1.035710% | 1.043611% | 1.048824% |
| F2_F4_EQUAL |         $25,000 | 0.447437% | 0.457124% | 0.469416% |
| F2_F4_EQUAL |        $100,000 | 0.443174% | 0.091829% | 0.090534% |
| O1          |         $10,000 | 1.748756% | 1.726375% | 1.926043% |
| O1          |         $25,000 | 1.238585% | 1.263718% | 1.401406% |
| O1          |        $100,000 | 1.015502% | 0.989547% | 0.465494% |

At **$10k and 5 bp/side**, deltas are whole minus fractional; cash is mean close cash/equity from the first review.
Drawdown is a positive loss magnitude, so a negative delta is a smaller drawdown. SHY is invested, not idle cash.

| Profile     | CAGR Δ (pp) |  Sharpe Δ | MaxDD Δ (pp) | Idle cash: whole / fractional | Reviews traded: whole / fractional |
| ----------- | ----------: | --------: | -----------: | ----------------------------: | ---------------------------------: |
| F4          |   −0.682915 | +0.051541 |    −1.821366 |         8.028422% / 0.011142% |                            60 / 40 |
| F2          |   −0.548955 | +0.005612 |    −2.771170 |         6.008639% / 0.006672% |                            49 / 46 |
| F2_F4_EQUAL |   −0.637387 | +0.012816 |    −2.134199 |         7.655086% / 0.007931% |                            55 / 44 |
| O1          |   −0.974078 | −0.154727 |    +0.858464 |         0.489150% / 0.326936% |                            86 / 85 |

**Deadband and turnover.** No $10k core review triggered without a trade on this tape at any tested cost. F4 traded
on 20 more review sessions than its fractional arm at 5 bp, adding 0.054710× annual one-way turnover. When the prior
adjusted close was at least $600 SPY and $510 QQQ, F4 traded on 8/8 such reviews vs 5/8; O1 traded on 14/17 vs 10/17,
but traded less notional over the full tape (−0.136672×/yr). O1 triggered without a trade on 20 whole-share reviews vs
17 fractional at 5 bp. In seven of the 20, allowing fractional orders on the _same_ whole-share book would have
produced a trade (none in the high-price subset at 5 bp). At 2 bp the longest O1 whole-share no-trade trigger streak
was four reviews and extended to the tape end.

At $10k, $600 and $510 are 6.0% and 5.1% one-share steps. A fixed-price test with 5.9% SPY and 5.0% QQQ demonstrates
that aggregate drift can remain above 10% while neither target buys a share (QQQ is only used in that synthetic
probe, not the protected core replay). A separate fixed-price test shows rounding can cause an extra trade at the
next review. Do not override the band, widen collars, or force a second submission to eliminate residual cash.

To reproduce, use the existing **read-only** S3 credentials with the registered `AGENTS_ARTIFACTS_ENDPOINT` and
`AGENTS_ARTIFACTS_BUCKET=agents-artifacts`. The study needs no Alpaca credentials and sends no orders:

```sh
report_dir=$(mktemp -d /dev/shm/bayn-sizing.XXXXXX)
bun services/bayn/tools/research-10k-small-account-sizing.ts --output "$report_dir/sizing.json"
jq -r '.results[] | [.profile, .initialEquityUsd, .oneWayBps, .trackingErrorAnnualizedPct,
  .wholeMinusFractional.cagrPp, .wholeMinusFractional.sharpe, .wholeMinusFractional.maxDrawdownPp,
  .fractional.avgUninvestedCashAfterFirstReviewPct, .whole.avgUninvestedCashAfterFirstReviewPct] | @tsv' \
  "$report_dir/sizing.json"
rm "$report_dir/sizing.json" && rmdir "$report_dir"
```
