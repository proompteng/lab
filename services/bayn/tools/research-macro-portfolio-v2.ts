import { parseArgs } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Console, Data, Effect, Redacted } from 'effect'

import {
  annualDebitBps,
  costSweep,
  type pairedMetrics,
  start,
  targetVolatility,
} from './multi-account-daily-sleeves/walk-forward'
import { receipts } from './pure-etf-dual-horizon-data'
import { prepareDaily } from './research-3account-capital-allocation'
import { foldBounds } from './research-lib/calendar'
import { loadFrozenDailyFrames, loadFrozenDailyFramesFromDirectory } from './research/macro-etf-core-dual-horizon-data'

const first = '2016-11-01'
const last = '2026-11-25'
const drawdownCeiling = 0.12
type Metrics = ReturnType<typeof pairedMetrics>

class MacroPortfolioStudyError extends Data.TaggedError('MacroPortfolioStudyError')<{
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
}> {}

const evidenceGate = (baseline: Metrics, candidate: Metrics, gross: number) => ({
  higherCagr: candidate.cagr > Math.max(baseline.cagr, 0),
  higherSharpe: candidate.sharpe !== null && baseline.sharpe !== null && candidate.sharpe > baseline.sharpe,
  lowerCorrelation:
    candidate.correlation !== null && baseline.correlation !== null && candidate.correlation < baseline.correlation,
  maxDrawdownUnder12Pct: candidate.maxDrawdown < drawdownCeiling,
  grossWithinCap: candidate.maxOpeningGross !== null && candidate.maxOpeningGross <= gross,
})

const main = Effect.gen(function* () {
  const { values } = yield* Effect.try({
    try: () => parseArgs({ args: Bun.argv.slice(2), options: { 'archive-directory': { type: 'string' } } }),
    catch: (cause) =>
      new MacroPortfolioStudyError({
        message: 'Usage: bun services/bayn/tools/research-macro-portfolio-v2.ts [--archive-directory DIRECTORY]',
        cause: Redacted.make(cause),
      }),
  })
  const directory = values['archive-directory']
  const frames = yield* directory === undefined ? loadFrozenDailyFrames : loadFrozenDailyFramesFromDirectory(directory)
  const evidence = yield* Effect.try({
    try: () => {
      const { first: firstIndex } = foldBounds(
        frames.map(({ date }) => date),
        first,
        last,
      )
      const { daily, evidence: frozenTargets } = prepareDaily(frames)
      const sweep = costSweep(frames, daily, firstIndex)
      const scenarios = sweep.scenarios.map(({ bps, baseline, cash, margin }) => ({
        bps,
        baseline,
        cash,
        margin,
        checks: { cash: evidenceGate(baseline, cash, 1), margin: evidenceGate(baseline, margin, 1.5) },
      }))
      if (scenarios.some(({ baseline }) => baseline.years < 10 || baseline.last !== last))
        throw new Error('Fewer than ten matched years of scored sessions')
      return {
        schemaVersion: 'bayn.macro-portfolio-v2-walk-forward.v1',
        window: { first, last, fullTapeSessions: frames.length },
        startingEquityUsd: start,
        targetVolatility,
        annualDebitBps,
        tape: { daily: receipts.datasets.daily.sha256, supplement: receipts.datasets.macro.sha256 },
        frozenTargets,
        policyHashes: sweep.policyHashes,
        scenarios,
      }
    },
    catch: (cause) =>
      new MacroPortfolioStudyError({
        message: cause instanceof Error ? cause.message : 'Macro portfolio replay failed',
        cause: Redacted.make(cause),
      }),
  })
  // Aggregate rows only. Do not persist per-session data or change frozen artifacts.
  yield* Console.log(JSON.stringify(evidence, null, 2))
  if (
    evidence.scenarios.some(({ checks }) => Object.values(checks).some((mode) => !Object.values(mode).every(Boolean)))
  )
    return yield* new MacroPortfolioStudyError({
      message: 'At least one cost/mode failed the retrospective evidence gate',
    })
})

if (import.meta.main) NodeRuntime.runMain(main)
