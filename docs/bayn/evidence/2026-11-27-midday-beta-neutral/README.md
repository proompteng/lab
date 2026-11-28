# Midday Reversion Wave 1A: beta neutrality and paired fills

**Decision: do not promote.** Pair-level remediation removed retained orphan exposure in the spread-center
controls, but no beta-adjusted, beta-sized protected configuration had positive ex-top-five-day net P&L at
either 5 or 10 bp round trip. No complete observed-IEX trial had positive net or ex-top-five net. No trial
passed the promotion gates, so there are no v3 production helpers, policy or migration changes, or live orders.

The [pre-scoring protocol](protocol.md) was committed as `8c78f54cc`. [The ledger][archived-results] retains all
47 configurations × four costs, not just winning rows. All figures are simulated on $100,000 fixed capital over
the same 66 sessions, August 25–November 25, with July 16–August 24 for warmup. The folds are August 25–September 24,
September 25–October 26, and October 27–November 25 (22 sessions each). They and the 18 leave-one-symbol-out
(LOSO) reruns are robustness checks on the same historical cohort, not independent validation.

## Reference and paired controls

The v2-signal / 10 bp entry collar / independent equal-dollar reference is an **isolated** Engine 2 control:

| Execution cost           |     Net | Annualized Sharpe | Ex-top-five net | Folds 1 / 2 / 3          | Worst LOSO | Four legs | One-sided |
| ------------------------ | ------: | ----------------: | --------------: | ------------------------ | ---------: | --------: | --------: |
| 2 bp RT                  | $13,248 |              6.21 |          $6,979 | $1,691 / $4,652 / $6,905 |     $9,119 |     42/66 |         2 |
| 5 bp RT                  | $12,241 |              5.75 |          $6,074 | $1,433 / $4,248 / $6,560 |     $8,833 |     41/66 |         2 |
| 10 bp RT                 |  $9,401 |              4.56 |          $3,516 | $90 / $3,947 / $5,364    |     $6,820 |     32/66 |         2 |
| Observed IEX + allowance | −$1,846 |             −1.22 |         −$5,377 | −$1,659 / −$368 / $180   |    −$3,961 |      5/66 |        33 |

This is not a reproduction of [#16342](https://github.com/proompteng/lab/pull/16342). That earlier concurrent-sleeve
replay used different inputs and a first whole-minute open after the delayed decision, and its November 17
co-held-mark gap precluded a full-period result. Here the experiment isolates Midday and uses the requested
next bucket after the completed signal bar. The reference's apparent fixed-cost edge disappears at observed
IEX costs: the first-quote half-spread plus 1 bp per side allowance cost $10,119 in supported transactions versus
$2,043 in the 5 bp model. The numerical models differ in placement/fills as well as in cost, so this is not a
like-for-like fee subtraction.

| Predeclared control                        | Ex-top-five at 5 / 10 bp | IEX four legs | IEX one-sided before → after | IEX partial residual dollars mean / max | IEX retained orphan max |
| ------------------------------------------ | ------------------------ | ------------: | ---------------------------: | --------------------------------------- | ----------------------: |
| v2 signal, fixed 10, independent           | $6,074 / $3,516          |          5/66 |                      33 → 33 | $19,585 / $35,802                       |                 $35,808 |
| Beta-z, spread 1.5×, flatten, equal-dollar | −$419 / −$1,774          |         29/66 |                        3 → 0 | $307 / $1,206                           |                      $0 |
| Beta-z, spread 1.5×, flatten, beta-dollar  | −$3,633 / −$4,975        |         29/66 |                        3 → 0 | $8,184 / $20,686                        |                      $0 |
| Beta-z, spread 1.5×, re-quote, beta-dollar | −$3,668 / −$5,023        |         33/66 |                        3 → 0 | $13,920 / $21,249                       |                      $0 |

- **Completion:** At 5 bp, the reference completed 41/66. The 25 and 35 bp fixed collars reached 49/66
  (74.2%) at all fixed costs, below the 50/66 gate, and only 10/66 on IEX. Across the grid the IEX ceiling was
  34/66 (51.5%, semi-neutral / spread 1.5× / flatten / beta-dollar). The spread-center re-quote rescued seven
  IEX legs and flattened seven, versus 14 flattened without re-quote; higher completion did not establish
  better economics. Holding spread-center flatten, beta-dollar sizing, and 5 bp costs fixed, the v2 signal's
  ex-top-five net was −$1,656 versus −$3,633 for beta-z. Neither beat the independent fixed-10 reference.
  None of the OLS, ATR, demeaning, or dispersion variants overcame the full gate.
- **Neutrality:** On the same 52 selected IEX sessions, beta-dollar sizing reduced mean post-work estimated beta
  dollars from $25,109 (equal-dollar) to $1,071 (beta-dollar) under spread-center flatten. Beta-dollar neutrality
  is not raw dollar neutrality. Whole shares and sizing at the signal-time limit leave beta drift too. Even where
  orphan remediation worked, quote order within a bucket cannot be established: the beta-dollar spread-center
  flatten had a conservative maximum in-flight directional entry bound of $59,205. Zero _retained orphan_
  exposure is not zero transient exposure, and independent stop/target exits can unbalance a pair later.
- **Robustness:** All 141 fixed-cost trials resolved. Only nine IEX trials resolved all 66 dates; 38 have a
  missing supported exit on September 22. For example, spread-center beta-z flatten could not price the AAPL
  and NVDA exits that day; their last observed quote buckets were both 13:39 ET. No P&L, Sharpe, ex-top-five, bootstrap or DSR is imputed for incomplete windows.
  The best ex-top-five among eligible protected rows was still −$2,503 at 5 bp, −$3,208 at 10 bp, and
  −$9,187 on IEX (among three complete eligible IEX trials). No row passed the core gate or obtained a
  qualifying neighboring plateau. The maximum DSR anywhere in the ledger was 0.400; using all 150 finite
  Sharpe trials, the expected maximum null daily Sharpe was 0.421.

## Observed midday execution inputs

Coverage below counts observed minutes out of 2,046 per symbol at 11:30–12:00 ET inclusive. Spread statistics
use the minute's recorded median; jumps need both adjacent bars (the ledger also includes these sample counts,
p75 spread, last-quote spread tail and signed jumps). Quotes are wide enough to make the fixed 10 bp collar
restrictive for several semis, independently of the next-open jump. Six names have only 248 quote minutes;
a missing observation never becomes a zero spread.

| Symbol | Quote minutes | Median spread (bp) | P90 spread (bp) | P90 absolute close → next open (bp) |
| ------ | ------------: | -----------------: | --------------: | ----------------------------------: |
| AAPL   |         1,912 |                2.7 |             7.2 |                                 2.6 |
| AMD    |         1,500 |               47.9 |           318.7 |                                 9.9 |
| AMZN   |         1,882 |                3.8 |             9.2 |                                 4.2 |
| AVGO   |         1,573 |               24.8 |           128.6 |                                 5.4 |
| COHR   |         1,517 |              142.0 |           418.5 |                                14.4 |
| GOOGL  |           248 |               20.7 |            56.2 |                                 5.7 |
| INTC   |           248 |                3.7 |             5.6 |                                 9.5 |
| IWM    |         1,910 |                0.7 |             0.8 |                                 2.7 |
| LITE   |         1,488 |              160.4 |           441.6 |                                19.7 |
| META   |           248 |               29.7 |            91.4 |                                 6.9 |
| MRVL   |         1,459 |              125.2 |           370.1 |                                14.9 |
| MSFT   |           248 |                7.2 |            22.2 |                                 5.0 |
| MU     |         1,575 |               56.8 |           158.9 |                                 7.2 |
| NFLX   |           248 |                1.7 |             3.3 |                                 5.0 |
| NVDA   |         2,004 |                1.4 |             2.7 |                                 3.3 |
| SNDK   |         1,554 |               95.4 |           266.8 |                                14.5 |
| TSLA   |           248 |               95.7 |           215.1 |                                 9.3 |
| WDC    |         1,548 |               90.6 |           360.7 |                                13.9 |

## Reproduce and interpret

The commands below use the runner and results from the [archived checkout][study-revision].

Use the frozen objects under `bayn-research-datasets/2026-11-27/` in the artifacts bucket. No market data is
committed. The runner pins the manifest SHA-256 and checks each used object's stored and decoded bytes, row
counts for the tabular inputs, and normalized calendar. The actual export has 523,944 bars across 22 symbols,
and 368,394 quote data rows plus a header (the manifest count includes it). The daily SIP file is not substituted
for the production IEX trailing-baseline algorithm, and the regular-hours JSON calendar is sufficient without
the duplicate TSV calendar. The JSON lacks extended-session fields; only its supplied regular clock is used.

```sh
export DATA="$(mktemp -d)"
bun -e '
  import { S3Client } from "bun";
  const s3 = new S3Client({
    endpoint: process.env.AGENTS_ARTIFACTS_ENDPOINT || "http://rook-ceph-rgw-objectstore.rook-ceph.svc:80",
    bucket: process.env.AGENTS_ARTIFACTS_BUCKET || "agents-artifacts",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: "us-east-1",
  });
  for (const name of ["MANIFEST.json", "calendar_2024_2026.json",
    "bars_1m_live_20260716_20261125.tsv.gz", "quotes_1m_spreads_20260824_20261125.tsv.gz"]) {
    await Bun.write(process.env.DATA + "/" + name,
      await s3.file("bayn-research-datasets/2026-11-27/" + name).bytes());
  }
'
bun services/bayn/tools/research-midday-beta-neutral.ts "$DATA" "$DATA/results.json"
bunx oxfmt --write "$DATA/results.json"
cmp "$DATA/results.json" docs/bayn/evidence/2026-11-27-midday-beta-neutral/results.json
```

The ledger stores exact daily P&L aligned to `sessions`: true modeled no-trade days are zero, unresolved
outcomes are `null`, and `unresolved` identifies the affected session index and any exit symbols.
`execution` describes supported activity, even for an unresolved outcome; four-leg counts use all 66 dates.
Partial baskets filled at least one but fewer than the selected legs. Estimated-beta statistics omit affected
baskets where beta is unavailable and report their denominators. Post-work exposures use filled entry notionals
after remediation; in-flight bounds are conservative sums of same-direction entry notionals, not measured
simultaneity. LOSO reruns the selection, dispersion history and fill simulation; its worst result is unknown
if any omission is incomplete.

The bootstrap follows [Politis–Romano circular block resampling](https://statistics.stanford.edu/technical-reports/circular-block-resampling-procedure-stationary-data)
with centered 5-session blocks, 10,000 seeded draws and a one-sided mean test. The
[Bailey–López de Prado DSR](https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf) uses daily unannualized Sharpe
and counts each finite configuration × cost trial as independent for the multiplicity penalty. The dispersion
weighting is our proxy motivated by [Nagel's liquidity-provision results](https://doi.org/10.1093/rfs/hhs066),
not that paper's specification.

A stop touched in the entry bucket can activate from that completed bucket, but can only fill from a subsequent
executable price. Protection stays active while a rescue order is working. If the original leg closes in that
bucket, the newly filled partner is unwound at the next supported price. In the IEX model, OHLC and quote
summaries cannot prove the stop touch followed the intra-bucket entry quote; the model treats it as a possible
trigger, not as evidence of an intra-bucket execution.

Event-time causality does not prove archive arrival latency or executable size. The IEX scenario assumes the
proxy price for whole shares, no quote queue or impact, and no capital, borrow, funding, or operating-cost
constraints. The allowance is a 1 bp per-side stress, not an observed adverse-selection fee. A separate signed
next-minute midquote markout is descriptive and not charged again as execution cost. A missing quote cannot
establish a fill, and an unresolved exit cannot be priced from a bar or close on this path. These limits,
the unqualified rows and the shared evaluation cohort preclude any trading or capital recommendation.

[archived-results]: https://github.com/proompteng/lab/blob/4b25eaee338c3c4766360108733da2f266dff493/docs/bayn/evidence/2026-11-27-midday-beta-neutral/results.json
[study-revision]: https://github.com/proompteng/lab/tree/4b25eaee338c3c4766360108733da2f266dff493
