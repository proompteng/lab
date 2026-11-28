import { Redacted, Result, Schema } from 'effect'

import type { Session } from './research-lib/calendar'
import { S3ArchiveError } from './research-lib/s3-archive'

export enum BarInterval {
  FiveMinutes = '5m',
  OneMinute = '1m',
}

enum LiquidityTier {
  Deeper = 'DEEPER',
  Middle = 'MIDDLE',
  Thinner = 'THINNER',
}

const encodeTier = Schema.encodeSync(Schema.Enum(LiquidityTier))
const minuteMs = 60_000
const bucketMinutes = 30
const bps = 10_000

const clockEt = (minute: number) => {
  const clock = 9 * 60 + 30 + minute
  return `${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`
}
export const rthBuckets = Array.from({ length: 390 / bucketMinutes }, (_, index) => ({
  startEt: clockEt(index * bucketMinutes),
  endEt: clockEt((index + 1) * bucketMinutes),
}))

// First regular-way dates for securities introduced during the archived period.
const listingStarts: ReadonlyMap<string, string> = new Map([
  ['ALAB', '2024-03-20'],
  ['GEV', '2024-04-02'],
  ['SNDK', '2025-02-24'],
])

const DateTime = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00Z$/))
const Positive = Schema.FiniteFromString.check(Schema.isGreaterThan(0))
const decodeBar = Schema.decodeUnknownResult(
  Schema.Tuple([Schema.String, DateTime, Positive, Positive, Positive, Positive, Positive, Positive]),
)

const percentile = (sorted: readonly number[], fraction: number) => {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * fraction
  const lower = sorted[Math.floor(position)]
  return lower + (sorted[Math.ceil(position)] - lower) * (position % 1)
}

const gapDistribution = (gaps: number[]) => {
  const absolute = gaps.map(Math.abs).sort((a, b) => a - b)
  gaps.sort((a, b) => a - b)
  return {
    sessions: gaps.length,
    p05Bps: percentile(gaps, 0.05),
    p25Bps: percentile(gaps, 0.25),
    medianBps: percentile(gaps, 0.5),
    p75Bps: percentile(gaps, 0.75),
    p95Bps: percentile(gaps, 0.95),
    medianAbsoluteBps: percentile(absolute, 0.5),
    p95AbsoluteBps: percentile(absolute, 0.95),
  }
}

const distribution = () => ({
  completeDollarVolumes: [] as number[],
  bars: 0,
  garmanKlassVariance: 0,
  parkinsonVariance: 0,
  amihudPairs: 0,
  amihud: 0,
})
type Distribution = ReturnType<typeof distribution>

const addBar = (stats: Distribution, garmanKlass: number, parkinson: number, amihud: number | null) => {
  stats.bars++
  stats.garmanKlassVariance += garmanKlass
  stats.parkinsonVariance += parkinson
  if (amihud !== null) {
    stats.amihudPairs++
    stats.amihud += amihud
  }
}

const summarize = (stats: Distribution, expectedBars: number, expectedSessions: number) => ({
  expectedSessions,
  completeSessions: stats.completeDollarVolumes.length,
  expectedBars,
  observedBars: stats.bars,
  medianDollarVolumeUsd: percentile(
    stats.completeDollarVolumes.sort((a, b) => a - b),
    0.5,
  ),
  garmanKlassBarVolatilityBps: stats.bars > 0 ? bps * Math.sqrt(stats.garmanKlassVariance / stats.bars) : null,
  parkinsonBarVolatilityBps: stats.bars > 0 ? bps * Math.sqrt(stats.parkinsonVariance / stats.bars) : null,
  amihudPairs: stats.amihudPairs,
  amihudBpsPerMillionUsd: stats.amihudPairs > 0 ? stats.amihud / stats.amihudPairs : null,
})
type Metrics = ReturnType<typeof summarize>

const windowVolume = () => ({ bars: 0, dollars: 0 })
const addVolume = (volume: ReturnType<typeof windowVolume>, stats: Distribution, dollars: number, expected: number) => {
  volume.bars++
  volume.dollars += dollars
  if (volume.bars === expected) stats.completeDollarVolumes.push(volume.dollars)
}
type Close = { readonly minute: number; readonly price: number }
const activeSession = (index: number) => ({
  index,
  lastClose: undefined as Close | undefined,
  dailyVolume: windowVolume(),
  bucketVolumes: rthBuckets.map(windowVolume),
})

const symbolState = (listedAt: string | undefined) => ({
  listedAt,
  lastEventMs: undefined as number | undefined,
  firstRthSession: undefined as string | undefined,
  day: undefined as ReturnType<typeof activeSession> | undefined,
  daily: distribution(),
  buckets: rthBuckets.map(distribution),
  gaps: [] as number[],
})
/** Keep one active session per symbol; exact volume medians need only the completed totals. */
export const createTapeProfiler = (calendar: readonly Session[], symbols: readonly string[], interval: BarInterval) => {
  const step = interval === BarInterval.FiveMinutes ? 5 : 1
  const barsPerBucket = bucketMinutes / step
  const sessions = new Map(calendar.map((session, index) => [session.date, { ...session, index }]))
  const states = new Map(symbols.toSorted().map((symbol) => [symbol, symbolState(listingStarts.get(symbol))]))
  const rowCoverage = { regular: 0, outsideRth: 0, beforeListing: 0 }

  const add = (line: string, index: number) => {
    const row = index + 1
    const decoded = decodeBar(line.split('\t'))
    if (Result.isFailure(decoded))
      throw new S3ArchiveError({ message: `Invalid SIP TSV at row ${row}`, cause: Redacted.make(decoded.failure) })
    const [symbol, stamp, open, high, low, close, volume, vwap] = decoded.success
    const state = states.get(symbol)
    const session = sessions.get(stamp.slice(0, 10))
    if (state === undefined || session === undefined)
      throw new S3ArchiveError({ message: `Unregistered SIP symbol or session at row ${row}` })
    const eventMs = Date.parse(stamp)
    const minute = (eventMs - session.openMs) / minuteMs
    if (
      !Number.isInteger(minute) ||
      minute % step !== 0 ||
      (state.lastEventMs !== undefined && eventMs <= state.lastEventMs)
    )
      throw new S3ArchiveError({ message: `Invalid, duplicate or unordered SIP timestamp at row ${row}` })
    if (low > Math.min(open, close) || high < Math.max(open, close))
      throw new S3ArchiveError({ message: `Inconsistent SIP OHLC at row ${row}` })
    state.lastEventMs = eventMs
    if (minute < 0 || minute >= session.minutes) {
      rowCoverage.outsideRth++
      return
    }
    if (state.listedAt !== undefined && session.date < state.listedAt) {
      rowCoverage.beforeListing++
      return
    }

    let day = state.day
    if (day === undefined || day.index !== session.index) {
      if (
        minute === 0 &&
        day !== undefined &&
        day.index + 1 === session.index &&
        day.lastClose?.minute === calendar[day.index].minutes - step
      ) {
        const gap = bps * (open / day.lastClose.price - 1)
        if (!Number.isFinite(gap)) throw new S3ArchiveError({ message: `Invalid SIP open gap at row ${row}` })
        state.gaps.push(gap)
      }
      day = activeSession(session.index)
      state.day = day
      state.firstRthSession ??= session.date
    }

    const dollars = volume * vwap
    const rangeSquared = Math.log(high / low) ** 2
    const garmanKlass = 0.5 * rangeSquared - (2 * Math.LN2 - 1) * Math.log(close / open) ** 2
    const parkinson = rangeSquared / (4 * Math.LN2)
    // Do not bridge missing slots or include overnight moves in a bar's price response.
    const amihud =
      day.lastClose !== undefined && minute - day.lastClose.minute === step
        ? (bps * Math.abs(close / day.lastClose.price - 1) * 1_000_000) / dollars
        : null
    const bucket = Math.floor(minute / bucketMinutes)
    const bucketVolume = day.bucketVolumes[bucket]
    if (
      dollars <= 0 ||
      !Number.isFinite(dollars + day.dailyVolume.dollars) ||
      !Number.isFinite(garmanKlass) ||
      garmanKlass < 0 ||
      (amihud !== null && !Number.isFinite(amihud + state.daily.amihud))
    )
      throw new S3ArchiveError({ message: `Invalid derived SIP bar metrics at row ${row}` })
    addVolume(day.dailyVolume, state.daily, dollars, session.minutes / step)
    addVolume(bucketVolume, state.buckets[bucket], dollars, barsPerBucket)
    addBar(state.daily, garmanKlass, parkinson, amihud)
    addBar(state.buckets[bucket], garmanKlass, parkinson, amihud)
    day.lastClose = { minute, price: close }
    rowCoverage.regular++
  }

  const finish = () => ({
    rowCoverage: { ...rowCoverage },
    symbols: [...states].map(([symbol, state]) => {
      const { day, firstRthSession } = state
      if (day === undefined || firstRthSession === undefined)
        throw new S3ArchiveError({ message: `No admitted RTH bars for ${symbol}` })
      const eligible = calendar.filter(({ date }) => state.listedAt === undefined || date >= state.listedAt)
      const expectedBars = eligible.reduce((total, session) => total + session.minutes / step, 0)
      return {
        symbol,
        firstRthSession,
        lastRthSession: calendar[day.index].date,
        daily: summarize(state.daily, expectedBars, eligible.length),
        buckets: state.buckets.map((stats, index) => {
          const expectedSessions = eligible.filter(({ minutes }) => minutes > index * bucketMinutes).length
          return summarize(stats, expectedSessions * barsPerBucket, expectedSessions)
        }),
        gapAtOpen: gapDistribution(state.gaps),
      }
    }),
  })

  return { add, finish }
}

type SymbolProfile = ReturnType<ReturnType<typeof createTapeProfiler>['finish']>['symbols'][number]

const rankLiquidity = (scopes: readonly { readonly key: string; readonly metrics: Metrics }[]) => {
  const comparable = scopes.flatMap(({ key, metrics: { medianDollarVolumeUsd, amihudBpsPerMillionUsd } }) =>
    medianDollarVolumeUsd === null || amihudBpsPerMillionUsd === null
      ? []
      : [{ key, dollars: medianDollarVolumeUsd, amihud: amihudBpsPerMillionUsd }],
  )
  const ranks = (metric: 'dollars' | 'amihud', direction: number) => {
    let previous: number | undefined
    let rank = 0
    return new Map(
      comparable
        .toSorted((a, b) => direction * (a[metric] - b[metric]))
        .map((entry, index) => {
          if (entry[metric] !== previous) rank = index + 1
          previous = entry[metric]
          return [entry.key, rank]
        }),
    )
  }
  const volume = ranks('dollars', -1)
  const amihud = ranks('amihud', 1)
  return comparable
    .map(({ key }) => {
      const dollarVolumeRank = volume.get(key)
      const amihudRank = amihud.get(key)
      if (dollarVolumeRank === undefined || amihudRank === undefined)
        throw new S3ArchiveError({ message: 'Incomplete SIP liquidity ranking' })
      return { key, dollarVolumeRank, amihudRank, rankSum: dollarVolumeRank + amihudRank }
    })
    .sort(
      (a, b) => a.rankSum - b.rankSum || a.dollarVolumeRank - b.dollarVolumeRank || a.key.localeCompare(b.key, 'en'),
    )
}

export const rankEtfs = (symbols: readonly SymbolProfile[], etfs: ReadonlySet<string>) => {
  const etfProfiles = symbols.filter(({ symbol }) => etfs.has(symbol))
  const ranked = rankLiquidity(etfProfiles.map(({ symbol, daily }) => ({ key: symbol, metrics: daily })))
  return ranked.map(({ key: symbol, ...ranks }, index) => {
    const profile = etfProfiles.find((row) => row.symbol === symbol)
    if (profile === undefined) throw new S3ArchiveError({ message: 'Unregistered ETF in SIP liquidity ranking' })
    const tercile = Math.floor((3 * index) / ranked.length)
    const tier = tercile === 0 ? LiquidityTier.Deeper : tercile === 1 ? LiquidityTier.Middle : LiquidityTier.Thinner
    return {
      symbol,
      tier: encodeTier(tier),
      ...ranks,
      windows: rankLiquidity(
        profile.buckets.map((metrics, index) => ({ key: rthBuckets[index].startEt, metrics })),
      ).map(({ key: startEt, ...windowRanks }) => ({ startEt, ...windowRanks })),
    }
  })
}
