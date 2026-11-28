import { NodeRuntime } from '@effect/platform-node'
import { Console, Data, Effect, Redacted } from 'effect'

import {
  type Cost,
  pairedMetrics,
  prepareCashWalkForward,
  replayFrozenPair,
  start,
} from './multi-account-daily-sleeves/walk-forward'
import { cashV3Rules, replayCashV3 } from './multi-account-daily-sleeves/walk-forward-v3'
import { loadDevelopment, loadHoldout, withArchive } from './noise-area-study-data'
import { baskets, capital, createReplay, netAt, prepare } from './noise-area-study-replay'
import { receipts } from './pure-etf-dual-horizon-data'
import { base, verifyBaseline } from './research-10yr-qqq-smh-conditioning'
import { prepareDaily } from './research-3account-capital-allocation'
import { foldBounds, requireAlignedSessions } from './research-lib/calendar'
import { pearson } from './research-orb-zab-statistics'
import { costs } from './research/macro-etf-core-dual-horizon-account'
import { loadFrozenDailyFrames } from './research/macro-etf-core-dual-horizon-data'

class MacroCashStudyError extends Data.TaggedError('MacroCashStudyError')<{
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}

const loadB0 = withArchive(async (archive) => {
  const development = await loadDevelopment(archive)
  const recent = await loadHoldout(archive)
  const rows = Array.from(prepare([...development.days, ...recent.days], baskets.B0), (day) => ({
    date: day.date,
    ...createReplay(day)(base),
  }))
  return { rows, parity: verifyBaseline(rows, 'full') }
})

const compare = (path: Parameters<typeof pairedMetrics>[0], b0: readonly number[], first: number, end: number) => {
  const joint = path.slice(first, end).map(({ f4, o1 }, i) => {
    const before = path[first + i - 1] ?? start
    return (f4 + o1) / (before.f4 + before.o1) - 1
  })
  return { ...pairedMetrics(path, first, end), correlationB0: pearson(joint, b0.slice(first, end)) }
}

type Metrics = Pick<
  ReturnType<typeof compare>,
  'cagr' | 'sharpe' | 'maxDrawdown' | 'oneWayTurnover' | 'correlation' | 'correlationB0' | 'maxOpeningGross'
>

const floors = { 5: { cagr: 0.0685, sharpe: 1.175 }, 10: { cagr: 0.0691, sharpe: 1.165 } } as const

export const promotionChecks = (bps: Exclude<Cost, 2>, frozen: Metrics, cash: Metrics) => ({
  higherCagr: cash.cagr > Math.max(frozen.cagr, floors[bps].cagr),
  higherSharpe:
    cash.sharpe !== null && frozen.sharpe !== null && cash.sharpe > Math.max(frozen.sharpe, floors[bps].sharpe),
  maxDrawdownUnder12Pct: cash.maxDrawdown < 0.12,
  sleeveCorrelationUnder077: cash.correlation !== null && cash.correlation < 0.77,
  absoluteB0CorrelationUnder015: cash.correlationB0 !== null && Math.abs(cash.correlationB0) < 0.15,
  openingGrossWithinCash: cash.maxOpeningGross !== null && cash.maxOpeningGross <= 1,
  oneWayTurnoverWithin2x: cash.oneWayTurnover <= 2,
})

const main = Effect.gen(function* () {
  if (Bun.argv.length > 2)
    return yield* new MacroCashStudyError({ message: 'Usage: bun services/bayn/tools/research-macro-portfolio-v3.ts' })
  const frames = yield* loadFrozenDailyFrames
  const b0 = yield* loadB0
  const evidence = yield* Effect.try({
    try: () => {
      requireAlignedSessions(frames, b0.rows)
      const dates = frames.map(({ date }) => date)
      const full = foldBounds(dates, '2016-11-01', '2026-11-25', 2_531)
      const validation = foldBounds(dates, '2022-01-03', '2023-12-29', 501)
      const recent = foldBounds(dates, '2024-01-02', '2026-11-25', 729)
      const { daily, evidence: frozenTargets } = prepareDaily(frames)
      const v2 = prepareCashWalkForward(frames)
      const scenarios = costs.map((bps) => {
        const b0Returns = b0.rows.map((row) => {
          const pnl = netAt(row, 2 * bps)
          if (pnl === null) throw new Error(`Unresolved B0 exit on ${row.date}`)
          return pnl / capital
        })
        const frozen = replayFrozenPair(daily, bps)
        const candidate = replayCashV3(frames, daily, bps)
        const score = (path: typeof frozen, window: typeof full) => compare(path, b0Returns, window.first, window.end)
        const baseline = score(frozen, full)
        const cashV3 = score(candidate, full)
        return {
          bps,
          baseline,
          cashV2: score(v2.replay(bps), full),
          cashV3,
          checks: bps === 2 ? null : promotionChecks(bps, baseline, cashV3),
          validation: { baseline: score(frozen, validation), cashV3: score(candidate, validation) },
          recent: { baseline: score(frozen, recent), cashV3: score(candidate, recent) },
        }
      })
      return {
        schemaVersion: 'bayn.macro-portfolio-v3-walk-forward.v1',
        fullTapeSessions: frames.length,
        startingEquityUsd: start,
        policy: cashV3Rules,
        tape: receipts,
        frozenTargets,
        b0ParityAt2And5BpRoundTrip: b0.parity,
        scenarios,
      }
    },
    catch: (cause) =>
      new MacroCashStudyError({
        message: cause instanceof Error ? cause.message : 'Low-turnover cash replay failed',
        cause: Redacted.make(cause),
      }),
  })
  yield* Console.log(JSON.stringify(evidence, null, 2))
  if (evidence.scenarios.some(({ checks }) => checks !== null && !Object.values(checks).every(Boolean)))
    return yield* new MacroCashStudyError({ message: 'A 5 or 10 bp cash v3 promotion gate failed' })
})

if (import.meta.main) NodeRuntime.runMain(main)
