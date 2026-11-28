import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../src/hash'
import { type Etf, EtfSchema, Profile, universe } from '../src/strategy/macro-etf-core/policy'
import { closeSnapshotSchema, replayMacroEtfCoreSignals } from '../src/strategy/macro-etf-core/signals'
import { loadDevelopment, loadHoldout, withArchive } from './noise-area-study-data'
import {
  baskets,
  budgetedShares,
  capital,
  closedLeg,
  createReplay,
  type Ledger,
  prepare,
} from './noise-area-study-replay'
import { receipts, tapeReceipt } from './pure-etf-dual-horizon-data'
import { base, verifyBaseline } from './research-10yr-qqq-smh-conditioning'
import { countArchiveLines, withS3Archive } from './research-lib/s3-archive'
import type { Bar, DailyFrame } from './research/macro-etf-core-dual-horizon-data'
import { wave5dTargets } from './research/macro-etf-core-wave5d'
import {
  type DailySession,
  type IntradayLeg,
  type IntradaySession,
  IntradayVariant,
  studyCapitalAllocation,
} from './three-account-capital-core'

const rosters = {
  [IntradayVariant.B0]: baskets.B0,
  [IntradayVariant.Phase2]: [...baskets.B0, 'XLK'],
} as const

const loadIntraday = withArchive(async (archive) => {
  const development = await loadDevelopment(archive)
  const holdout = await loadHoldout(archive)
  const days = [...development.days, ...holdout.days]
  const intraday = { [IntradayVariant.B0]: [] as IntradaySession[], [IntradayVariant.Phase2]: [] as IntradaySession[] }
  const missingEntries = { [IntradayVariant.B0]: 0, [IntradayVariant.Phase2]: 0 }
  const legacyB0: Ledger[] = []
  for (const day of prepare(days, rosters[IntradayVariant.Phase2])) {
    const replay = createReplay(day)
    const candidates = rosters[IntradayVariant.Phase2].map((symbol) => {
      const features = day.bySymbol.get(symbol)
      if (features?.vol === undefined) return { symbol, inverseVol: 0, missing: 0 }
      let leg: Omit<IntradayLeg, 'weight'> | undefined
      // Ask the registered replay for the priced path, not its $100k probe quantity.
      const row = replay(base, [symbol], undefined, {
        budget: capital,
        onFill: ({ side, entry, entrySlot, exit, missingHeld }) => {
          const reference = features.bars[entrySlot - 1]?.close
          if (reference === undefined) throw new Error(`Missing decision mark: ${symbol} ${day.date}`)
          leg = { side, entry, reference, exit, missingHeld }
        },
      })
      if (row.unresolved > 0) throw new Error(`Unresolved intraday exit: ${symbol} ${day.date}`)
      return { symbol, inverseVol: 1 / features.vol, missing: row.missingEntries, leg }
    })

    for (const variant of Object.values(IntradayVariant)) {
      const members = candidates.filter(({ symbol }) => rosters[variant].some((ticker) => ticker === symbol))
      const total = members.reduce((weight, member) => weight + member.inverseVol, 0)
      const legs = members.flatMap(({ leg, inverseVol, missing }) => {
        missingEntries[variant] += missing
        return leg === undefined ? [] : [{ ...leg, weight: inverseVol / total }]
      })
      intraday[variant].push({ date: day.date, legs })
      if (variant === IntradayVariant.B0) {
        const frozenSizing = legs.map(({ side, entry, reference, exit, weight }) =>
          closedLeg(side, budgetedShares(capital * weight, entry, reference), entry, exit),
        )
        legacyB0.push({
          ...replay(base),
          base: frozenSizing.reduce((sum, fill) => sum + fill.base, 0),
          slope: frozenSizing.reduce((sum, fill) => sum + fill.slope, 0),
        })
      }
    }
  }

  return {
    calendar: days.map(({ date, openMs, slots }) => ({ date, openAt: openMs, closeAt: openMs + slots * 300_000 })),
    intraday,
    evidence: {
      missingEntries,
      developmentRows: development.coverage.physical,
      holdoutRows: holdout.coverage.physical,
      legacyB0ParityAt2And5BpRoundTrip: verifyBaseline(legacyB0, 'full'),
    },
  }
})

enum DailyArchiveSource {
  Base = 'Alpaca Market Data API v2 (feed=sip, adjustment=all [split+dividend total return])',
  Macro = 'Alpaca Market Data API v2 (feed=sip, adjustment=all, timeframe=1Day)',
}

const decodeManifest = Schema.decodeUnknownSync(Schema.Struct({ source: Schema.Enum(DailyArchiveSource) }))
const price = Schema.FiniteFromString.check(Schema.isGreaterThan(0))
const decodeDay = Schema.decodeUnknownSync(
  Schema.Tuple([
    EtfSchema,
    Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T0[45]:00:00Z$/)),
    price,
    price,
    price,
    price,
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
    price,
  ]),
)
const dailyRoster = new Set<string>(universe)
const loadDaily = (calendar: Effect.Success<typeof loadIntraday>['calendar']) =>
  withS3Archive(async ({ readJson, readGzip }) => {
    const frames = calendar.map((session) => ({ ...session, bars: new Map<Etf, Bar>() }))
    const byDate = new Map(frames.map(({ date, bars }) => [date, bars]))
    for (const [receipt, expectedSource] of [
      [receipts.datasets.daily, DailyArchiveSource.Base],
      [receipts.datasets.macro, DailyArchiveSource.Macro],
    ] as const) {
      const manifest = await readJson(`${receipt.prefix}/MANIFEST.json`, receipt.manifestSha256)
      if (decodeManifest(manifest).source !== expectedSource) throw new Error(`Wrong daily source: ${receipt.name}`)
      const seen = new Map<Etf, string>()
      const rows = await readGzip(
        tapeReceipt(receipt),
        countArchiveLines((line) => {
          if (!dailyRoster.has(line.slice(0, line.indexOf('\t')))) return
          const [symbol, stamp, open, high, low, close] = decodeDay(line.split('\t'))
          const date = stamp.slice(0, 10)
          const bars = byDate.get(date)
          if (
            bars === undefined ||
            date <= (seen.get(symbol) ?? '') ||
            (expectedSource === DailyArchiveSource.Macro) !== (symbol === 'DIA' || symbol === 'UUP') ||
            high < Math.max(open, close) ||
            low > Math.min(open, close)
          )
            throw new Error(`Invalid, unordered or duplicate daily bar: ${symbol} ${stamp}`)
          seen.set(symbol, date)
          bars.set(symbol, { open, high, low, close })
        }),
      )
      if (rows !== receipt.rows) throw new Error(`Wrong row count for ${receipt.name}: ${rows}`)
    }
    return frames
  })

const targetReceipt = (label: string, rows: readonly unknown[], count: number, expected: string) => {
  const digest = sha256(JSON.stringify(rows))
  if (rows.length !== count || digest !== expected)
    throw new Error(`Frozen ${label} target mismatch: ${rows.length} reviews / ${digest}`)
  return { count, sha256: digest }
}

const prepareDaily = (frames: readonly DailyFrame[]) => {
  const calendar = frames.map(({ date, openAt, closeAt }) => ({ date, openAt, closeAt }))
  const snapshot = {
    schema: closeSnapshotSchema,
    datasetVersion: 'alpacav2-sip-10yr-sp100-with-dia-uup-2026-11-27',
    adjustment: 'all',
    calendar,
    bars: frames
      .slice(0, -1)
      .map(({ date, closeAt, bars }) =>
        [...bars].map(([symbol, bar]) => ({ date, symbol, availableAt: closeAt, ...bar })),
      ),
  }
  const snapshotHash = Result.getOrThrow(canonicalHashV1Result(snapshot))
  // Check the Wave 8A snapshot and uncapped signal receipts before account-specific sizing.
  if (snapshotHash !== '15641f2c58623f6441edd8dfa95bc435344d092dc4989fcb055eae5189c4605a')
    throw new Error(`Frozen F4 close snapshot mismatch: ${snapshotHash}`)
  const signals = Result.getOrThrow(
    replayMacroEtfCoreSignals(
      { schema: 'bayn.macro-etf-core-policy.v1', profile: Profile.F4 },
      { asOf: calendar.at(-1)?.openAt, snapshot, snapshotHash },
    ),
  )
  const o1 = wave5dTargets(frames)
  const pack = (weights: readonly number[]) => weights.map((w) => w.toFixed(12))
  const f4Targets = new Map(signals.map(({ executionDate, weights }) => [executionDate, weights]))
  return {
    evidence: {
      snapshotHash,
      f4: targetReceipt(
        'F4',
        signals.map(({ signalDate, executionDate, weights }) => [signalDate, executionDate, pack(weights)]),
        63,
        '384ae7f5f241cb95fa5dc8d2c61a72a5a34048f4fdf96497ed84ec0d17168ed6',
      ),
      o1: targetReceipt(
        'O1',
        o1.slice(0, -1).flatMap((weights, i) => (weights === undefined ? [] : [[frames[i].date, pack(weights)]])),
        119,
        '690bbb6193b4dd9659eec0a3c56c553b23816dd916d2e49c4bc0460249ddef5c',
      ),
    },
    daily: frames.map(({ date, bars }, i): DailySession => ({ date, bars, f4: f4Targets.get(date), o1: o1[i - 1] })),
  }
}

class StudyError extends Data.TaggedError('ThreeAccountCapitalStudyError')<{ readonly cause: unknown }> {}

const main = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () => parseArgs({ args: Bun.argv.slice(2), options: { output: { type: 'string' } } }),
    catch: (cause) => new StudyError({ cause }),
  })
  const output = args.values.output
  if (output === undefined || output === '')
    return yield* new StudyError({
      cause: 'Usage: bun services/bayn/tools/research-3account-capital-allocation.ts --output NEW_REPORT.json',
    })
  const { calendar, intraday, evidence: intradayEvidence } = yield* loadIntraday
  const frames = yield* loadDaily(calendar)
  const summary = yield* Effect.try({
    try: () => {
      const { daily, evidence: dailyEvidence } = prepareDaily(frames)
      return {
        schemaVersion: 'bayn.wave17-9.three-account-capital-allocation.v1',
        archiveReceipts: receipts,
        intradayRosters: rosters,
        intradayEvidence,
        dailyEvidence,
        ...studyCapitalAllocation({ daily, intraday }),
      }
    },
    catch: (cause) => new StudyError({ cause }),
  })
  yield* Effect.tryPromise({
    try: (signal) => writeFile(output, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', signal }),
    catch: (cause) => new StudyError({ cause }),
  })
})

if (import.meta.main) NodeRuntime.runMain(main)
