# Wave 21K: multi-sleeve risk budget and drawdown replay

The [simulator](../../../../services/bayn/tools/simulate-multi-sleeve-portfolio.ts) compares 27 independent paths: three
account scenarios, three allocation rules, and 0/2/5 bp of allocator rebalance drag. Live Main and Paper Main each
start at $100,000 and have no simulated day-trade cap. Paper Small starts at $10,000 and exercises a legacy-style
day-trade stress limit. These are model accounts, not account observations or permission to trade. The tool reads
files or the existing archive and emits results on stdout; it has no broker, database, or execution path.

## Input and replay contract

```sh
bun services/bayn/tools/simulate-multi-sleeve-portfolio.ts --fixture "$fixture" --sha256 "$pinned_sha256"
bun services/bayn/tools/simulate-multi-sleeve-portfolio.ts --archive "$object_key" --sha256 "$pinned_sha256"
```

Supply a local file or an object key in the existing `agents-artifacts` bucket, never a URL. Both modes require
an independently pinned, lowercase SHA-256 of the exact JSON bytes. Get the digest from the verified export receipt,
not by hashing an untrusted download. The command checks the digest before parsing, validates the closed schema, and
requires every sleeve to cover the exact ordered, unique calendar. It does not look up the upstream receipts or
certify their authenticity: the fixture producer must verify those sources, retain their digests, and pin the joined
export. A missing observation is not a zero. No partial report is emitted for unreadable or invalid evidence.

Set `schemaVersion` to `bayn.multi-sleeve-return-series.v1`. The other required fields are:

- `calendar`: `{ sourceSha256, sessions: [{ date }] }` from the verified US equity calendar for the entire cut.
- `sleeves.B0`: `{ sourceSha256, sessions: [{ date, netReturn, dayTradeCount }] }`. Measure closed intraday P&L
  per unit of reserved B0 capital, excluding idle carry. An explicitly flat no-trade session has zero return.
- `sleeves.F4`, `sleeves.O1`, `sleeves.SHY`: one `{ sourceSha256, sessions: [{ date, netReturn }] }` per sleeve.

Dates are `YYYY-MM-DD`. Returns are simple decimals, not percentages or prices, and must be finite and greater than
−1. All returns use the same previous-close to current-close session attribution; flat-overnight B0 contributes only
its intraday P&L. Use source returns after their own execution costs. SHY uses an observed total-return series and
can lose value. Aggregate evidence JSONs that lack the daily paths or B0's verified round-trip counts are not inputs.

- **Allocation:** All arms use the same scored dates, excluding the first lookback window. Static uses the supplied
  capital weights. Inverse-vol divides each risky sleeve's supplied weight by its trailing realized volatility using
  only prior sessions, then normalizes to the eligible risk budget. SHY is not in the vol calculation. The budget of
  a verified zero-vol sleeve stays in SHY. The governor applies inverse-vol and scales all risk to 50% at 5% account
  drawdown and 25% at 10%, based on the previous net close against that path's own high-water mark. It restores risk
  as the drawdown recovers. These are throttles, not a hard drawdown cap.
- **PDT stress:** The small-account path starts with no prior day trades and may execute at most three B0 round trips
  in a rolling five verified sessions. It reserves capacity for two trips before a session (QQQ and SMH); if the
  capacity is insufficient, the whole B0 allocation moves to SHY for that session. Only executed trips consume the
  quota; blocked trips count foregone trips from the unblocked evidence. A blocked session can have no foregone trips.
  This intentionally conservative all-or-none model does not prorate B0 P&L, model cross-sleeve day trades, infer
  broker limits from the balance, or implement the [current account regime](../../three-account-capital-plan.md#account-1-legacy-25000-pdt-stress).
- **Costs and metrics:** The path starts in SHY. At each session boundary it rebalances from marked weights to that
  session's target. One-way turnover is half the sum of absolute weight changes, including SHY; drag is charged on
  that turnover before earning returns. CAGR uses elapsed calendar time from the warmup close to the last scored
  close, Sharpe uses sample volatility, Sortino uses downside RMS, and both ratios annualize at √252 with a zero
  hurdle. Calmar uses CAGR divided by positive-magnitude maximum drawdown. Undefined ratios are `null`. The model
  does not price orders, re-net trades, round shares, model taxes, or establish implementable cross-sleeve fills.
- **Dependence:** All six pairs report full-period Pearson and rolling positive spikes (default: 20 sessions, ≥0.75).
  Flat windows are undefined, not zero correlation. Co-drawdowns are dates on which both sleeves have negative
  returns at or below their own empirical lower 5% cutoff (nearest rank, including ties). The report also tests all
  three risky sleeves together and reports each path's worst net return on those dates and on observed risky-pair
  spike dates. These are contemporaneous diagnostics, not signals or invented correlation shocks.

Add `--daily` to inspect the per-session weights, drag, NAV, governor scale, and PDT decisions. Add `--scenario FILE`
to replace the defaults with a complete scenario JSON. The tighter governor below uses all defaults except its
drawdown thresholds; use `0.05` and `0.10` for the default thresholds. Weights must be long-only and sum to one.

```json
{
  "weights": { "B0": 0.3, "F4": 0.3, "O1": 0.3, "SHY": 0.1 },
  "startingEquityUsd": { "live-main": 100000, "paper-main": 100000, "paper-small-account": 10000 },
  "lookbackSessions": 20,
  "correlationThreshold": 0.75,
  "tailFraction": 0.05,
  "pdtMaxDayTrades": 3,
  "b0DayTradeReservation": 2,
  "drawdown": { "throttleAt": 0.02, "throttleScale": 0.5, "severeAt": 0.03, "severeScale": 0.25 }
}
```

## Verified 2022 evidence

The fixed 2022 calendar supplies **251 aligned sessions**: 20 warmup (Jan 3–31), then 231 scored (Feb 1–Dec 30).
B0 was reproduced from the [Wave 9B baseline](../2026-11-27-10yr-qqq-smh-conditioning/README.md) at 5 bp round trip
plus its sell fee, with no unresolved trades, missing entries or held-bar gaps in this cut. F4 and O1 use the
[Wave 8A daily archive and target oracles](../2026-11-27-macro-etf-core-dual-horizon/README.md), replaying them
separately at the source's 5 bp per-side scenario. SHY uses verified adjusted closes from the same daily tape.
The round-trip counts are B0 research fills, not reported broker activity. This is previously studied history,
not independent validation or a recommendation about capital weights.

The default governor did not trigger, so it exactly matches inverse-vol. The $100,000 Live and Paper runs are
identical by construction. Metrics are net of allocator drag as well as the source costs above.

| Account     | Allocation             | Drag (bp) |  CAGR | Sharpe | Sortino | Calmar | MaxDD |
| ----------- | ---------------------- | --------: | ----: | -----: | ------: | -----: | ----: |
| Either main | Static                 |         0 | 8.22% |  1.566 |   2.525 |  2.560 | 3.21% |
| Either main | Static                 |         2 | 8.19% |  1.561 |   2.516 |  2.550 | 3.21% |
| Either main | Static                 |         5 | 8.15% |  1.553 |   2.503 |  2.535 | 3.21% |
| Either main | Inverse-vol / governed |         0 | 5.66% |  1.116 |   1.685 |  1.529 | 3.70% |
| Either main | Inverse-vol / governed |         2 | 5.56% |  1.097 |   1.654 |  1.496 | 3.72% |
| Either main | Inverse-vol / governed |         5 | 5.41% |  1.068 |   1.609 |  1.447 | 3.74% |
| Paper Small | Static                 |         0 | 4.60% |  0.964 |   1.457 |  1.262 | 3.65% |
| Paper Small | Static                 |         2 | 4.04% |  0.852 |   1.281 |  1.087 | 3.72% |
| Paper Small | Static                 |         5 | 3.20% |  0.683 |   1.020 |  0.838 | 3.82% |
| Paper Small | Inverse-vol / governed |         0 | 2.67% |  0.563 |   0.799 |  0.723 | 3.69% |
| Paper Small | Inverse-vol / governed |         2 | 2.21% |  0.472 |   0.667 |  0.591 | 3.74% |
| Paper Small | Inverse-vol / governed |         5 | 1.53% |  0.335 |   0.471 |  0.394 | 3.88% |

- **PDT:** In each default arm, either main executed 198 modeled B0 trips (peak 8 in five sessions). Paper Small
  executed 85, denied 113 across 142 gated sessions, and reached 3/3 slots. At 5 bp, Paper Small's static arm
  paid $124.53 in simulated rebalance drag versus $61.37 for a main account: the repeated moves to and from SHY
  drove more turnover despite the smaller opening balance.
- **Correlation/tails:** F4–O1 had full-period correlation 0.685, reached 0.934 on Dec 30, and was ≥0.75 in
  126 overlapping windows. The pair had eight joint lower-tail sessions; all three risk sleeves never hit their
  tails together. The worst same-day net return during a risky-pair spike at 5 bp was −0.89% for main static
  and −1.09% for Small inverse-vol. The absence of a three-way event in this cut is not tail protection.
- **Governor sensitivity:** At 5 bp, lowering the thresholds to 2%/3% changed the main governed path to 88/60
  throttled/severe sessions, 2.60% CAGR and 3.76% MaxDD, vs. 5.41% and 3.74% at default thresholds. Paper Small
  recorded 42/0 sessions, 1.46% CAGR and 2.75% MaxDD, vs. 1.53% and 3.88% at defaults. The tighter throttle did
  not improve drawdown on both accounts; no parameter was selected for deployment.

## Reproduce the local fixture run

Run from the repository root with the existing read-only archive credentials mounted. The extraction reuses the
pinned research loaders and must reproduce the source oracles before joining the calendar window. Keep the return
series private. The input and output digests below are for Bun 1.4.2; a normalized evidence JSON already present in
the archive can also be read directly with `--archive`, but this reproduction does not upload anything.

```sh
set -eu
umask 077
scratch=$(mktemp -d)
trap 'rm -r -- "$scratch"' EXIT
fixture="$scratch/fixture.json"
(
  cd services/bayn
  bun - "$fixture" <<'TS'
import { Effect, Result } from 'effect'
import { sha256 } from './src/hash'
import { Profile } from './src/strategy/macro-etf-core/policy'
import { replayMacroEtfCoreSignals } from './src/strategy/macro-etf-core/signals'
import { loadDevelopment, sources, withArchive } from './tools/noise-area-study-data'
import { baskets, capital, createReplay, netAt, prepare, splits } from './tools/noise-area-study-replay'
import { receipts } from './tools/pure-etf-dual-horizon-data'
import { base, verifyBaseline } from './tools/research-10yr-qqq-smh-conditioning'
import { requireAlignedSessions } from './tools/research-lib/calendar'
import { mixes, replayAccount, toMarks } from './tools/research/macro-etf-core-dual-horizon-account'
import { closeEvidence, loadFrozenDailyFrames } from './tools/research/macro-etf-core-dual-horizon-data'
import { wave5dTargets } from './tools/research/macro-etf-core-wave5d'

const [dev, daily] = await Effect.runPromise(Effect.all([withArchive(loadDevelopment), loadFrozenDailyFrames], { concurrency: 2 }))
requireAlignedSessions(dev.days, daily.slice(0, dev.days.length))
const ledgers = [...prepare(dev.days, baskets.B0)].map((day) => createReplay(day)(base))
verifyBaseline(ledgers.slice(0, splits.train.count), 'train')
verifyBaseline(ledgers.slice(splits.train.count), 'validation')

const close = closeEvidence(daily)
if (close.snapshotHash !== '15641f2c58623f6441edd8dfa95bc435344d092dc4989fcb055eae5189c4605a') throw new Error('Close snapshot mismatch')
const signals = (profile: Profile) =>
  Result.getOrThrow(replayMacroEtfCoreSignals({ schema: 'bayn.macro-etf-core-policy.v1', profile }, close))
const pack = (weights: readonly number[]) => weights.map((value) => value.toFixed(12))
const f4 = signals(Profile.F4)
const o1 = wave5dTargets(daily)
const f4Sha = sha256(JSON.stringify(f4.map(({ signalDate, executionDate, weights }) => [signalDate, executionDate, pack(weights)])))
const o1Sha = sha256(JSON.stringify(o1.slice(0, -1).flatMap((weights, i) => weights === undefined ? [] : [[daily[i].date, pack(weights)]])))
if (f4Sha !== '384ae7f5f241cb95fa5dc8d2c61a72a5a34048f4fdf96497ed84ec0d17168ed6' ||
    o1Sha !== '690bbb6193b4dd9659eec0a3c56c553b23816dd916d2e49c4bc0460249ddef5c') throw new Error('Target mismatch')
const weights = (rows: typeof f4) => new Map(rows.map(({ executionDate, weights }) => [executionDate, weights]))
const target = { F2: weights(signals(Profile.F2)), F4: weights(f4), O1: o1 }
const marks = toMarks(daily)
const empty = marks.map(() => [])
const f4Book = replayAccount(marks, empty, target, mixes.E2, 5)
const o1Book = replayAccount(marks, empty, target, { f2: 0, f4: 0, o1: 1, noise: 0 }, 5)
const from = daily.findIndex(({ date }) => date === '2022-01-03')
const through = daily.findIndex(({ date }) => date === '2022-12-30')
if (from < 1 || through - from + 1 !== 251) throw new Error('Unexpected 2022 session count')
const b0 = []
const shy = []
for (let i = from; i <= through; i++) {
  const { date, bars } = daily[i]
  const row = ledgers[i]
  const net = netAt(row, 5)
  if (net === null || row.missingEntries !== 0 || row.missingHeld !== 0) throw new Error('Incomplete B0 path at ' + date)
  const current = bars.get('SHY')?.close
  const previous = daily[i - 1].bars.get('SHY')?.close
  if (current === undefined || previous === undefined) throw new Error('Missing SHY close')
  b0.push({ date, netReturn: net / capital, dayTradeCount: row.trades })
  shy.push({ date, netReturn: current / previous - 1 })
}
const window = (rows: typeof f4Book) => rows.slice(from, through + 1).map(({ date, net }) => ({ date, netReturn: net }))
await Bun.write(process.argv[2], JSON.stringify({
  schemaVersion: 'bayn.multi-sleeve-return-series.v1',
  calendar: { sourceSha256: sources.development.calendarSha256, sessions: b0.map(({ date }) => ({ date })) },
  sleeves: {
    B0: { sourceSha256: sources.development.manifestSha256, sessions: b0 },
    F4: { sourceSha256: f4Sha, sessions: window(f4Book) },
    O1: { sourceSha256: o1Sha, sessions: window(o1Book) },
    SHY: { sourceSha256: receipts.datasets.daily.sha256, sessions: shy },
  },
}) + '\n')
TS
)
pinned_sha256=41bbda3a2debeb581f518b0d8532f6160dee9e60990a691e9ac88c019cb2580c
entry=services/bayn/tools/simulate-multi-sleeve-portfolio.ts
bun "$entry" --fixture "$fixture" --sha256 "$pinned_sha256" > "$scratch/report.json"
bun "$entry" --fixture "$fixture" --sha256 "$pinned_sha256" > "$scratch/repeat.json"
cmp "$scratch/report.json" "$scratch/repeat.json"
printf 'd394b49977309bbbb12b40888346cd385087fe8b14eaac1073db5ab70c5b3747  %s\n' "$scratch/report.json" | sha256sum -c -

bun -e '
const { scenario } = await Bun.file(process.argv[1]).json()
scenario.drawdown.throttleAt = 0.02
scenario.drawdown.severeAt = 0.03
await Bun.write(process.argv[2], JSON.stringify(scenario))
' "$scratch/report.json" "$scratch/tighter.json"
bun "$entry" --fixture "$fixture" --sha256 "$pinned_sha256" --scenario "$scratch/tighter.json" > "$scratch/tighter-report.json"
printf 'f895cf3754794cb9ff766071d3b11a30d7af177838beec65b78f4a8bc70fa495  %s\n' "$scratch/tighter-report.json" | sha256sum -c -
```
