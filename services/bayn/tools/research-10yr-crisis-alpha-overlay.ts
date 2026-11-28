import { link, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Logger, Redacted, Result, Schema } from 'effect'

import { sha256 } from '../src/hash'
import { Profile } from '../src/strategy/macro-etf-core/policy'
import { replayMacroEtfCoreSignals } from '../src/strategy/macro-etf-core/signals'
import { loadDevelopment, loadHoldout, withArchive } from './noise-area-study-data'
import { baskets, capital, createReplay, type Ledger, prepare } from './noise-area-study-replay'
import { receipts, tapeReceipt } from './pure-etf-dual-horizon-data'
import {
  admitUniverse,
  type Baseline,
  costGrid,
  type DayReturn,
  folds,
  type OneWayBps,
  OverlayEtf,
  prepareOverlay,
  scoreStudy,
} from './research-10yr-crisis-alpha-overlay-core'
import { base, verifyBaseline } from './research-10yr-qqq-smh-conditioning'
import { requireAlignedSessions } from './research-lib/calendar'
import { S3ArchiveError, withS3Archive } from './research-lib/s3-archive'
import { sum } from './research-lib/statistics'
import { initialUsd, replayAccount, toMarks } from './research/macro-etf-core-dual-horizon-account'
import { closeEvidence, type DailyFrame, loadFrozenDailyFrames } from './research/macro-etf-core-dual-horizon-data'
import { wave5dTargets } from './research/macro-etf-core-wave5d'
import {
  type IntradayLeg,
  IntradayMode,
  type IntradaySession,
  ShareSizing,
  tradeIntraday,
} from './three-account-capital-core'

const registrationCommit = '9c11ab24c76989a7a18b9f3af9353326885dfe36'
const firstOos = folds[0].from
const dailyReceipt = receipts.datasets.daily

enum ArchiveSource {
  SipDailyAdjusted = 'Alpaca Market Data API v2 (feed=sip, adjustment=all [split+dividend total return])',
}

const decodeCatalog = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-10yr-sp100-manifest.v1'),
    source: Schema.Enum(ArchiveSource),
    etfs: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Z]+$/))),
    files: Schema.Tuple([
      Schema.Struct({
        key: Schema.Literal(tapeReceipt(dailyReceipt).key),
        rows: Schema.Literal(dailyReceipt.rows),
        gzipBytes: Schema.Literal(dailyReceipt.bytes),
        gzipSha256: Schema.Literal(dailyReceipt.sha256),
        rawBytes: Schema.Literal(dailyReceipt.rawBytes),
        rawSha256: Schema.Literal(dailyReceipt.rawSha256),
      }),
    ]),
  }),
)

const loadAdmittedSymbols = withS3Archive(async (archive) => {
  const manifest = await archive.readJson(`${dailyReceipt.prefix}/MANIFEST.json`, dailyReceipt.manifestSha256)
  try {
    return admitUniverse(decodeCatalog(manifest).etfs)
  } catch (cause) {
    throw new S3ArchiveError({
      message: 'Unable to admit overlay ETFs from the verified catalog',
      cause: Redacted.make(cause),
    })
  }
}).pipe(Effect.timeout('1 minute'))

const loadB0 = withArchive(async (archive) => {
  const older = await loadDevelopment(archive)
  const recent = await loadHoldout(archive)
  const fixed: Ledger[] = []
  const sessions: IntradaySession[] = []
  const missingEntries: { date: string; count: number }[] = []
  for (const day of prepare([...older.days, ...recent.days], baskets.B0)) {
    const replay = createReplay(day)
    fixed.push(replay(base))
    const priced = baskets.B0.map((symbol) => {
      const features = day.bySymbol.get(symbol)
      if (features?.vol === undefined) return { inverseVol: 0, leg: undefined }
      let leg: Omit<IntradayLeg, 'weight'> | undefined
      const { unresolved, missingEntries: missing } = replay(base, [symbol], undefined, {
        budget: capital,
        onFill: ({ side, entry, entrySlot, exit, missingHeld }) => {
          const reference = features.bars[entrySlot - 1]?.close
          if (reference === undefined) throw new Error(`B0 missing decision mark: ${symbol} ${day.date}`)
          leg = { side, entry, reference, exit, missingHeld }
        },
      })
      if (unresolved > 0) throw new Error(`B0 unresolved exit: ${symbol} ${day.date}`)
      if (missing > 0) missingEntries.push({ date: day.date, count: missing })
      return { inverseVol: 1 / features.vol, leg }
    })
    const total = sum(priced.map(({ inverseVol }) => inverseVol))
    sessions.push({
      date: day.date,
      legs: priced.flatMap(({ leg, inverseVol }) =>
        leg === undefined ? [] : [{ ...leg, weight: inverseVol / total }],
      ),
    })
  }

  return {
    sessions,
    evidence: {
      olderRows: older.coverage.physical,
      recentRows: recent.coverage.physical,
      missingEntries,
      fixedSizeParityUsd: verifyBaseline(fixed, 'full'),
    },
  }
}).pipe(Effect.timeout('5 minutes'))

const signalOracle = {
  F2: { count: 63, sha256: '7e297125e3acaca974bd2d9fcafbc9bed88181661f780cadb2fd310003662a04' },
  F4: { count: 63, sha256: '384ae7f5f241cb95fa5dc8d2c61a72a5a34048f4fdf96497ed84ec0d17168ed6' },
  O1: { count: 119, sha256: '690bbb6193b4dd9659eec0a3c56c553b23816dd916d2e49c4bc0460249ddef5c' },
} as const

const checkOracle = (name: keyof typeof signalOracle, rows: readonly unknown[]) => {
  const observed = { count: rows.length, sha256: sha256(JSON.stringify(rows)) }
  const expected = signalOracle[name]
  if (observed.count !== expected.count || observed.sha256 !== expected.sha256)
    throw new Error(`Frozen ${name} signal identity mismatch: ${observed.count} reviews / ${observed.sha256}`)
  return observed
}

const baselineSignals = (daily: readonly DailyFrame[]) => {
  const evidence = closeEvidence(daily)
  if (evidence.snapshotHash !== '15641f2c58623f6441edd8dfa95bc435344d092dc4989fcb055eae5189c4605a')
    throw new Error('Frozen macro close snapshot identity mismatch')
  const pack = (weights: readonly number[]) => weights.map((weight) => weight.toFixed(12))
  const loadCore = (profile: Profile) => {
    const rows = Result.getOrThrow(
      replayMacroEtfCoreSignals({ schema: 'bayn.macro-etf-core-policy.v1', profile }, evidence),
    )
    const receipt = checkOracle(
      profile,
      rows.map(({ signalDate, executionDate, weights }) => [signalDate, executionDate, pack(weights)]),
    )
    return { reviews: new Map(rows.map(({ executionDate, weights }) => [executionDate, weights])), receipt }
  }
  const f2 = loadCore(Profile.F2)
  const f4 = loadCore(Profile.F4)
  const O1 = wave5dTargets(daily)
  const o1Receipt = checkOracle(
    'O1',
    O1.slice(0, -1).flatMap((weights, i) => (weights === undefined ? [] : [[daily[i].date, pack(weights)]])),
  )
  return {
    targets: { F2: f2.reviews, F4: f4.reviews, O1 },
    evidence: { snapshotHash: evidence.snapshotHash, F2: f2.receipt, F4: f4.receipt, O1: o1Receipt },
  }
}

const replayB0 = (sessions: readonly IntradaySession[], bps: OneWayBps) => {
  const heldGapDates: { date: string; missingBars: number }[] = []
  let equity = initialUsd
  const returns = sessions.map((day) => {
    const { pnl, heldGaps } = tradeIntraday(day, equity, IntradayMode.UnleveredLongShort, ShareSizing.Whole, bps)
    if (heldGaps > 0) heldGapDates.push({ date: day.date, missingBars: heldGaps })
    const net = pnl / equity
    equity += pnl
    if (!Number.isFinite(equity) || equity <= 0) throw new Error(`Invalid B0 equity: ${day.date}`)
    return { date: day.date, net }
  })
  return { returns, heldGapDates }
}

const runStudy = (
  daily: readonly DailyFrame[],
  intraday: Effect.Success<typeof loadB0>,
  symbols: readonly OverlayEtf[],
) => {
  requireAlignedSessions(daily, intraday.sessions)
  const overlay = prepareOverlay(daily, symbols, firstOos)
  const SPY = overlay.map(({ date, marks }) => {
    const mark = marks.find(({ symbol }) => symbol === OverlayEtf.SPY)
    if (mark === undefined) throw new Error(`Missing verified SPY benchmark: ${date}`)
    return { date, net: mark.close / mark.priorClose - 1 }
  })
  const marks = toMarks(daily)
  const { targets, evidence: macroEvidence } = baselineSignals(daily)
  const noNoise = daily.map(() => [])
  const scored = (rows: readonly DayReturn[]) => rows.filter(({ date }) => date >= firstOos)
  const references = (bps: OneWayBps) => {
    const b0 = replayB0(intraday.sessions, bps)
    // The account replayer binds both macro review streams; F2 has zero weight in either reference.
    const F4 = replayAccount(marks, noNoise, targets, { f2: 0, f4: 1, o1: 0, noise: 0 }, bps)
    const O1 = replayAccount(marks, noNoise, targets, { f2: 0, f4: 0, o1: 1, noise: 0 }, bps)
    const series: Baseline = { SPY, B0: scored(b0.returns), F4: scored(F4), O1: scored(O1) }
    return { series, heldGapDates: b0.heldGapDates }
  }
  const cases = costGrid.map(references)
  const [zero, low, primary, stress] = cases
  const b0Evidence = cases.map(({ heldGapDates }, i) => ({ oneWayBps: costGrid[i], heldGapDates }))
  const scoredHeldGapDates = [
    ...new Set(
      b0Evidence.flatMap(({ heldGapDates }) =>
        heldGapDates.filter(({ date }) => date >= firstOos).map(({ date }) => date),
      ),
    ),
  ].sort((a, b) => a.localeCompare(b))
  return {
    schemaVersion: 'bayn.wave21m.crisis-alpha-overlay.v1',
    registrationCommit,
    evidence: {
      archiveReceipts: receipts,
      archiveCalendarSessions: daily.length,
      firstArchiveSession: daily[0].date,
      lastArchiveSession: daily[daily.length - 1].date,
      overlaySymbols: symbols,
      excludedUnlistedSymbols: Object.values(OverlayEtf).filter((symbol) => !symbols.includes(symbol)),
      dailyBarsPerOverlaySymbol: daily.length,
      macro: macroEvidence,
      b0: { ...intraday.evidence, byCost: b0Evidence, scoredHeldGapDates },
    },
    ...scoreStudy(
      overlay,
      { 0: zero.series, 2: low.series, 5: primary.series, 10: stress.series },
      scoredHeldGapDates.length,
    ),
  }
}

// Publish a complete new file or preserve the old path. Both staged and destination
// files are on the same filesystem, so link is atomic and refuses to overwrite.
export const writeEvidence = async (destination: string, json: string, signal: AbortSignal) => {
  signal.throwIfAborted()
  const directory = await mkdtemp(join(dirname(destination), '.crisis-overlay-'))
  try {
    const staged = join(directory, 'results.json')
    await writeFile(staged, json, { mode: 0o600, signal, flag: 'wx' })
    signal.throwIfAborted()
    await link(staged, destination)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

class StudyError extends Data.TaggedError('CrisisAlphaOverlayStudyError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

const failure = (message: string) => (cause: unknown) => new StudyError({ message, cause: Redacted.make(cause) })
const usage = failure('Usage: bun services/bayn/tools/research-10yr-crisis-alpha-overlay.ts --output NEW_RESULTS.json')
const decodeOptions = Schema.decodeUnknownEffect(Schema.Struct({ output: Schema.NonEmptyString }))

const main = Effect.gen(function* () {
  const { values } = yield* Effect.try({
    try: () => parseArgs({ args: Bun.argv.slice(2), options: { output: { type: 'string' } } }),
    catch: usage,
  })
  const { output } = yield* decodeOptions(values).pipe(Effect.mapError(usage))
  const symbols = yield* loadAdmittedSymbols
  const daily = yield* loadFrozenDailyFrames
  const intraday = yield* loadB0
  const study = yield* Effect.try({
    try: () => runStudy(daily, intraday, symbols),
    catch: failure('Unable to evaluate the frozen crisis-alpha overlay and baseline inputs'),
  })
  yield* Effect.tryPromise({
    try: (signal) => writeEvidence(output, JSON.stringify(study, null, 2) + '\n', signal),
    catch: failure('Unable to publish a new crisis-alpha overlay evidence file'),
  })
  yield* Effect.logInfo('Crisis-alpha overlay study complete').pipe(Effect.annotateLogs({ verdict: study.verdict }))
})

if (import.meta.main) {
  NodeRuntime.runMain(
    // @effect-diagnostics-next-line strictEffectProvide:off -- This CLI entry point owns logging.
    main.pipe(Effect.provide(Logger.layer([Logger.consoleJson]))),
  )
}
