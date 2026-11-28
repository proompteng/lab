import { Effect, Redacted, Schema } from 'effect'

import { etfs as canaryEtfs, mix } from './etf-canary-macro-protocol'
import { marks, replay as replayO1 } from './etf-canary-macro-replay'
import { features, targets } from './etf-canary-macro-signals'
import { loadDevelopment, loadHoldout, withArchive } from './noise-area-study-data'
import { baskets, capital, createReplay, netAt, prepare, splits, type Day } from './noise-area-study-replay'
import { receipts } from './pure-etf-dual-horizon-data'
import { base, verifyBaseline } from './research-10yr-qqq-smh-conditioning'
import { requireAlignedSessions } from './research-lib/calendar'
import { S3ArchiveError } from './research-lib/s3-archive'
import { sum, wealth } from './research-lib/statistics'
import { assets, end, loadSessions, sources, type Session } from './vol-regime-carry-data'
import { replay as replayF4 } from './vol-regime-carry-replay'
import { signalModel, trialId, type Trial } from './vol-regime-carry-signals'

export enum PullbackEtf {
  SPY = 'SPY',
  QQQ = 'QQQ',
  IWM = 'IWM',
  SMH = 'SMH',
  XLK = 'XLK',
  XLF = 'XLF',
  XLE = 'XLE',
  XLI = 'XLI',
}

export const roster = Object.values(PullbackEtf)
const price = Schema.Finite.check(Schema.isGreaterThan(0))
const quoteSchema = Schema.Struct({ symbol: Schema.Enum(PullbackEtf), signalClose: price, open: price, close: price })
const validQuote = Schema.is(quoteSchema)
export type Quote = typeof quoteSchema.Type
export type TradingSession = { readonly date: string; readonly quotes: readonly Quote[] }

const closeOutage = '2019-08-12'

export const admitCandidates = (daily: readonly Session[], intraday: readonly Day[]) => {
  requireAlignedSessions(daily, intraday)
  const history = roster.map((symbol) => {
    const missing: string[] = []
    const earlyMarks: { date: string; minutesBeforeClose: number }[] = []
    const quotes = daily.map(({ date, bars }, t) => {
      const { slots, bars: minutes } = intraday[t]
      const series = minutes.get(symbol)
      const signalClose = bars[assets[symbol]]?.close
      const open = series?.[0]?.open
      // The known outage affects valuation only; the exact opening slot is still mandatory.
      const firstCloseSlot = Math.max(0, slots - (date === closeOutage ? 7 : 2))
      let closeSlot = slots - 1
      while (closeSlot > firstCloseSlot && series?.[closeSlot] === undefined) closeSlot--
      const close = series?.[closeSlot]?.close
      if (signalClose === undefined || open === undefined || close === undefined) {
        missing.push(date)
        return undefined
      }
      const quote = { symbol, signalClose, open, close }
      if (!validQuote(quote)) throw new Error(`Malformed price: ${symbol} ${date}`)
      if (closeSlot < slots - 1) earlyMarks.push({ date, minutesBeforeClose: (slots - 1 - closeSlot) * 5 })
      return quote
    })
    return { symbol, quotes, missing, earlyMarks }
  })
  const admitted = history.filter(({ missing }) => missing.length === 0)
  if (!admitted.some(({ symbol }) => symbol === PullbackEtf.SPY)) throw new Error('Required SPY pricing is incomplete')
  return {
    sessions: daily.map(
      ({ date }, t): TradingSession => ({
        date,
        quotes: admitted.map(({ symbol, quotes }) => {
          const quote = quotes[t]
          if (quote === undefined) throw new Error(`Admitted ETF has no quote: ${symbol} ${date}`)
          return quote
        }),
      }),
    ),
    admitted: admitted.map(({ symbol }) => symbol),
    coverage: history.map(({ symbol, missing, earlyMarks }) => ({
      symbol,
      verifiedSessions: daily.length - missing.length,
      missing,
      earlyMarks,
    })),
  }
}

export enum Control {
  SPY = 'SPY',
  B0 = 'B0',
  F4 = 'F4',
  O1 = 'O1',
}
export type FactorRow = { readonly date: string; readonly returns: Readonly<Record<Control, number>> }

const f4 = { family: 'F4', cadence: 42, power: 1, credit: 'LQD', mix: 'parity' } satisfies Trial
const closeTo = (observed: number, expected: number, label: string) => {
  if (!Number.isFinite(observed) || Math.abs(observed - expected) > 5.01e-10)
    throw new Error(`Published ${label} reproduction mismatch: ${observed} vs ${expected}`)
  return observed
}

const buildControls = (daily: readonly Session[], intraday: readonly Day[]) => {
  requireAlignedSessions(daily, intraday)
  const holdoutStart = splits.train.count + splits.validation.count
  const b0 = Array.from(prepare(intraday, baskets.B0), (day) => createReplay(day)(base))
  const b0Parity = {
    full: verifyBaseline(b0, 'full'),
    holdout: verifyBaseline(b0.slice(holdoutStart), 'holdout'),
  }
  const canary = daily.map(({ date, bars }) => ({
    date,
    open: Float64Array.from(canaryEtfs, (symbol) => bars[assets[symbol]]?.open ?? NaN),
    close: Float64Array.from(canaryEtfs, (symbol) => bars[assets[symbol]]?.close ?? NaN),
  }))
  const canaryMarks = marks(canary)
  const canaryTargets = targets(mix, features(canary), -1)
  const f4Targets = signalModel(daily)(f4)
  const f4Path = (bp: number) => replayF4(daily, f4Targets, bp).map(({ idle }) => idle.net)
  const o1Path = (bp: number) => Array.from(replayO1(canaryMarks, canaryTargets, mix, bp, true, -1).net)
  const compound = (returns: readonly number[]) => wealth(returns, true) - 1
  // Split identities from Wave 10D (F4) and Wave 6C, which reproduced the original Wave 5D book (O1).
  const f4Parity = [
    [10, 1.111094304, 0.372083365],
    [20, 1.092765661, 0.36920683],
  ].map(([roundTripBp, full, holdout]) => {
    const path = f4Path(roundTripBp)
    return {
      roundTripBp,
      full: closeTo(compound(path), full, `F4 full at ${roundTripBp} bp RT`),
      holdout: closeTo(compound(path.slice(holdoutStart)), holdout, `F4 holdout at ${roundTripBp} bp RT`),
    }
  })
  const o1Parity = [
    [2, 0.9442965714470313, 0.28326801353111986],
    [5, 0.9286692789006974, 0.28035058356373144],
    [10, 0.9029113849269141, 0.27550393908871973],
  ].map(([roundTripBp, full, holdout]) => {
    const path = o1Path(roundTripBp)
    return {
      roundTripBp,
      full: closeTo(compound(path), full, `O1 full at ${roundTripBp} bp RT`),
      holdout: closeTo(compound(path.slice(holdoutStart)), holdout, `O1 holdout at ${roundTripBp} bp RT`),
    }
  })
  return {
    evidence: {
      B0: {
        id: base.id,
        parityAt2And5BpRoundTripUsd: b0Parity,
        missingHeldBars: sum(b0.map(({ missingHeld }) => missingHeld)),
        cancelledEntries: sum(b0.map(({ missingEntries }) => missingEntries)),
      },
      F4: { id: trialId(f4), parity: f4Parity },
      O1: { id: 'Wave 5D base with SHY sweep', parity: o1Parity },
    },
    atCost: (oneWayBp: number): FactorRow[] => {
      const roundTripBp = oneWayBp * 2
      const f4Net = f4Path(roundTripBp)
      const o1Net = o1Path(roundTripBp)
      return daily.map(({ date }, t) => {
        const pnl = netAt(b0[t], roundTripBp)
        if (pnl === null) throw new Error(`Unresolved B0 on ${date}`)
        const returns = { SPY: canaryMarks[t].spy, B0: pnl / capital, F4: f4Net[t], O1: o1Net[t] }
        if (Object.values(returns).some((value) => !Number.isFinite(value)))
          throw new Error(`Non-finite control return on ${date}`)
        return { date, returns }
      })
    },
  }
}

export const loadStudy = withArchive(async (archive) => {
  const read = async (key: string) =>
    (await archive.open(key)).bytes().catch((cause: unknown) => {
      throw new S3ArchiveError({ message: `Unable to read archive body: ${key}`, cause: Redacted.make(cause) })
    })
  const inputs = []
  for (const source of sources) {
    inputs.push({
      manifest: await read(`${source.prefix}/MANIFEST.json`),
      gzip: await read(`${source.prefix}/${source.file}`),
    })
  }
  const daily = loadSessions(inputs, end)
  const development = await loadDevelopment(archive)
  const holdout = await loadHoldout(archive)
  const intraday = [...development.days, ...holdout.days]
  return {
    ...admitCandidates(daily, intraday),
    controls: buildControls(daily, intraday),
    receipts,
    intradayCoverage: [development, holdout].map(({ coverage }) => ({
      rows: coverage.physical,
      outsideRegularHours: coverage.outsideRth,
      earlyCloses: coverage.halfDays.length,
    })),
  }
}).pipe(Effect.timeout('5 minutes'))
