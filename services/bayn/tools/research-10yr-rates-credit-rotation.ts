import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, Redacted, Schema } from 'effect'

import { etfs as canaryEtfs, mix } from './etf-canary-macro-protocol'
import { marks as canaryMarks, replay as replayCanary } from './etf-canary-macro-replay'
import { features as canaryFeatures, targets as canaryTargets } from './etf-canary-macro-signals'
import { loadDevelopment, loadHoldout, sources as b0Sources, withArchive } from './noise-area-study-data'
import { baskets, capital, createReplay, netAt, prepare } from './noise-area-study-replay'
import { attachTip, verifyTip } from './orthogonal-pillar3-tip'
import { base as b0Rule, verifyBaseline } from './research-10yr-qqq-smh-conditioning'
import {
  buyAndHold,
  costs,
  isTicker,
  protocol,
  scoreStudy,
  sleeveTickers,
  Ticker,
  type Cost,
  type Frame,
} from './research-10yr-rates-credit-rotation-core'
import { foldBounds, requireAlignedSessions } from './research-lib/calendar'
import { archiveBucket, decodeArchiveJson } from './research-lib/s3-archive'
import { sum, wealth } from './research-lib/statistics'
import { assets, end, loadSessions, sources, universe } from './vol-regime-carry-data'
import { replay as replayCarry } from './vol-regime-carry-replay'
import { signalModel, trialId, type Trial } from './vol-regime-carry-signals'

const tipManifest = 'c55023773b7590f9d07fd8c01ccd63edad8b6dd8f346d1529f24d87396a428d4'
const tipPrefix = sources[0].prefix + '-supplement-tip'
const decodeRoster = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-10yr-sp100-manifest.v1'),
    source: Schema.Literal('Alpaca Market Data API v2 (feed=sip, adjustment=all [split+dividend total return])'),
    etfs: Schema.Array(Schema.String),
  }),
)

const tickers = [...sleeveTickers, Ticker.SPY]
export const confirmBaseRoster = (input: unknown) => {
  const { etfs } = decodeRoster(input)
  const base = new Set(etfs.filter(isTicker))
  const expected = tickers.filter((ticker) => ticker !== Ticker.TIP)
  const missing = expected.filter((ticker) => !base.has(ticker))
  if (missing.length > 0) throw new Error(`Base SIP manifest lacks required tickers: ${missing.join(', ')}`)
  if (base.has(Ticker.TIP) || protocol.excludedTickers.some((ticker) => etfs.includes(ticker)))
    throw new Error('Unexpected TIP, BIL, or SGOV in the registered base SIP roster')
  return expected
}

const f4Rule = { family: 'F4', cadence: 42, power: 1, credit: 'LQD', mix: 'parity' } as const satisfies Trial
const f4Pinned = { train: 0.426060485, validation: 0.078919864, holdout: 0.372083365, full: 1.111094304 } as const
const o1Pinned = { 2: 0.9442965714, 5: 0.9286692789, 10: 0.9029113849 } as const
const requireReference = (actual: number, expected: number, tolerance: number, label: string) => {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) >= tolerance)
    throw new Error(`Published ${label} did not reproduce: ${actual} vs ${expected}`)
}

class StudyError extends Data.TaggedError('RatesCreditRotationStudyError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

const io = <A>(message: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new StudyError({ message, cause: Redacted.make(cause) }) })

const usage =
  'Usage: bun research-10yr-rates-credit-rotation.ts --tip-dir <frozen TIP directory> --output <new JSON file>'
const parseOptions = () =>
  Effect.try({
    try: () => {
      const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: { 'tip-dir': { type: 'string' }, output: { type: 'string' } },
      })
      const { 'tip-dir': tipDir, output } = values
      if (tipDir === undefined || tipDir.trim() === '' || output === undefined || output.trim() === '')
        throw new Error('Both flags are required')
      return { tipDir, output }
    },
    catch: (cause) => new StudyError({ message: usage, cause: Redacted.make(cause) }),
  })

const program = Effect.gen(function* () {
  const { tipDir, output } = yield* parseOptions()
  const { raw: tipBars, ...tipReceipt } = yield* io('Verify locally staged Wave 13C SIP TIP archive', async (signal) =>
    verifyTip(
      await readFile(join(tipDir, 'MANIFEST.json'), { signal }),
      await readFile(join(tipDir, 'tip.tsv.gz'), { signal }),
      tipManifest,
    ),
  )

  const result = yield* withArchive(async (archive) => {
    const read = async (key: string) => {
      const response = await archive.open(key)
      return response.bytes().catch((cause: unknown) => {
        throw new StudyError({ message: `Unable to read S3 object: ${key}`, cause: Redacted.make(cause) })
      })
    }
    const [base, macro] = sources
    const baseKey = `${base.prefix}/MANIFEST.json`
    const baseManifest = await read(baseKey)
    const baseTickers = confirmBaseRoster(decodeArchiveJson(baseManifest, baseKey, base.manifest))
    const daily = loadSessions(
      [
        { manifest: baseManifest, gzip: await read(`${base.prefix}/${base.file}`) },
        { manifest: await read(`${macro.prefix}/MANIFEST.json`), gzip: await read(`${macro.prefix}/${macro.file}`) },
      ],
      end,
    )
    const frames: Frame[] = attachTip(daily, tipBars).map(({ date, bars }) => ({
      date,
      bars: new Map(
        tickers.map((ticker) => {
          const bar = bars[ticker === Ticker.TIP ? universe.length : assets[ticker]]
          if (bar === undefined) throw new Error(`Missing admitted daily bar: ${ticker} ${date}`)
          return [ticker, bar]
        }),
      ),
    }))

    const development = await loadDevelopment(archive)
    const holdout = await loadHoldout(archive)
    const intraday = [...development.days, ...holdout.days]
    requireAlignedSessions(frames, intraday)
    const b0 = Array.from(prepare(intraday, baskets.B0), (day) => createReplay(day)(b0Rule))
    const b0HeldGapDates = intraday.flatMap(({ date }, i) => (b0[i].missingHeld > 0 ? [date] : []))
    if (
      sum(b0.map(({ missingHeld }) => missingHeld)) !== 1 ||
      b0.some(({ unresolved, missingEntries }) => unresolved > 0 || missingEntries > 0)
    )
      throw new Error('B0 execution coverage does not match the published control')

    const dates = frames.map(({ date }) => date)
    const auditWindows = (['train', 'validation', 'holdout', 'full'] as const).map((name) => {
      if (name === 'full') return { name, first: 0, end: dates.length }
      const [from, through, count] = protocol.splits[name]
      return { name, ...foldBounds(dates, from, through, count) }
    })
    const b0Audit = auditWindows.map(({ name, first, end }) => ({
      window: name,
      ...verifyBaseline(b0.slice(first, end), name),
    }))
    const carryTargets = signalModel(daily)(f4Rule)
    const canary = daily.map(({ date, bars }) => ({
      date,
      open: Float64Array.from(canaryEtfs, (ticker) => bars[assets[ticker]]?.open ?? NaN),
      close: Float64Array.from(canaryEtfs, (ticker) => bars[assets[ticker]]?.close ?? NaN),
    }))
    const ratings = canaryTargets(mix, canaryFeatures(canary), -1)
    const marks = canaryMarks(canary)
    const inputs = new Map(
      costs.map((bp) => [
        bp,
        { f4: replayCarry(daily, carryTargets, bp), o1: replayCanary(marks, ratings, mix, bp, true, -1) },
      ]),
    )
    const replayAt = (bp: Cost) => {
      const path = inputs.get(bp)
      if (path === undefined) throw new Error(`Missing controls for ${bp} bp`)
      return path
    }
    const f4Audit = auditWindows.map(({ name, first, end }) => {
      const net =
        wealth(
          replayAt(10)
            .f4.slice(first, end)
            .map(({ idle }) => idle.net),
          true,
        ) - 1
      requireReference(net, f4Pinned[name], 5.01e-10, `F4 ${name} at 10 bp RT`)
      return { window: name, net }
    })
    const o1Audit = costs
      .filter((bp) => bp !== 0)
      .map((bp) => {
        const net = wealth(Array.from(replayAt(bp).o1.net), true) - 1
        requireReference(net, o1Pinned[bp], 1e-9, `O1 full at ${bp} bp RT`)
        return { roundTripBp: bp, net }
      })

    return {
      schema: 'bayn.wave20d.rates-credit-rotation.v1',
      protocol,
      provenance: {
        bucket: archiveBucket,
        daily: sources,
        tip: { prefix: tipPrefix, file: 'tip.tsv.gz', ...tipReceipt },
        intraday: { development: b0Sources.development, holdout: b0Sources.holdout },
        baseTickers,
        coverage: Object.fromEntries(tickers.map((ticker) => [ticker, frames.length])),
      },
      comparatorAudit: {
        B0: { rule: b0Rule.id, roundTripBp: [2, 5], windows: b0Audit, heldGapDates: b0HeldGapDates },
        F4: { rule: trialId(f4Rule), roundTripBp: 10, windows: f4Audit },
        O1: { rule: 'Wave 4D base ensemble, SHY sweep', full: o1Audit },
      },
      ...scoreStudy(frames, (bp) => {
        const { f4, o1 } = replayAt(bp)
        return {
          SPY: buyAndHold(frames, Ticker.SPY, bp),
          SHY: buyAndHold(frames, Ticker.SHY, bp),
          F4: f4.map(({ date, idle: { net, turnover } }) => ({ date, net, turnover })),
          O1: frames.map(({ date }, i) => ({ date, net: o1.net[i], turnover: o1.turnover[i] })),
          B0: b0.map((row, i) => {
            const pnl = netAt(row, bp)
            if (pnl === null) throw new Error(`Unresolved B0 position on ${intraday[i].date}`)
            return { date: intraday[i].date, net: pnl / capital, turnover: (row.slope * 10_000) / capital }
          }),
        }
      }),
    }
  })
  yield* io('Write new Wave 20D evidence file', (signal) =>
    writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', signal }),
  )
})

if (import.meta.main) NodeRuntime.runMain(program)
