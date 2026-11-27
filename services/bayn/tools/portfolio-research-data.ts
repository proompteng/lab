import { Result, Schema } from 'effect'

import { buildTrailingBaseline } from '../src/market-data/intraday/trailing-baseline'
import { IsoDateSchema } from '../src/schemas'
import { intradayAlphaBenchmarkSymbol, IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { intradayAlphaDefinition, makeIntradayAlphaPolicy } from '../src/strategy/intraday-alpha/policy'
import {
  type ActiveAlphaPhase,
  extractIntradayAlphaCandidates,
  resolveAlphaRegularSession,
  selectIntradayAlphaLegs,
  type SelectedAlphaLeg,
} from '../src/strategy/intraday-alpha/signals'
import { crossSectionalDispersion, trailingSleeveRisk } from '../src/strategy/intraday-alpha/portfolio-allocator'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../src/jev/protocol'
import {
  decodeRegularCalendar,
  evaluationEnd,
  evaluationStart,
  minuteMs,
  openFrozenBaynDataset,
  parseBar,
  warmupStart,
} from './midday-research-data'
import { quantile } from './midday-research-statistics'
import {
  buildReplaySnapshot,
  buildSessionSummaries,
  makeShortEligibility,
  type RawBar,
  replayAccountId,
} from './verify-intraday-alpha-replay'

const calendarFile = 'calendar_2024_2026.json'
const liveFile = 'bars_1m_live_20260716_20261125.tsv.gz'
const longFile = 'bars_1m_3yr_7sym_20240102_20260911.tsv.gz'
const dailyFile = 'daily_sip_17sym_20160104_20261125.tsv.gz'
const longStart = '2024-01-02'
export const longHoldoutSplice = evaluationStart

const policy = makeIntradayAlphaPolicy(Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument)))
const { morningOrb, middayReversion, noiseArea, trailingBaseline } = policy
const benchmark = intradayAlphaBenchmarkSymbol

export const sleeves = [
  IntradayAlphaPhase.MorningOrb,
  IntradayAlphaPhase.MiddayReversion,
  IntradayAlphaPhase.NoiseAreaTrend,
] as const

export interface Opportunity {
  readonly phase: ActiveAlphaPhase
  readonly legs: readonly SelectedAlphaLeg[]
  readonly dispersion: number | null
  readonly trailingDispersion: number | null
}

export interface Decision {
  readonly noise: Opportunity | undefined
  readonly equity: Opportunity | undefined
  readonly observedMsFromOpen: number
  readonly missingBenchmark: boolean
}

export interface PortfolioSession {
  readonly date: string
  readonly minutes: number
  readonly bars: ReadonlyMap<string, ReadonlyMap<number, RawBar>>
  readonly decisions: ReadonlyMap<number, Decision>
  readonly noiseSymbolCount: number
  readonly baselineAvailable: boolean
  readonly spyReturn: number | null
  readonly highVol: boolean | null
}

export const nvdaSplitAdjusted = (row: RawBar, date: string): RawBar =>
  row.symbol === 'NVDA' && date < '2024-06-10'
    ? {
        ...row,
        open: row.open / 10,
        high: row.high / 10,
        low: row.low / 10,
        close: row.close / 10,
        vwap: row.vwap / 10,
        volume: row.volume * 10,
      }
    : row

const parseDailyMarket = (text: string, rows: number) => {
  const lines = text.trimEnd().split('\n')
  if (
    lines.length !== rows ||
    lines.shift() !== 'symbol\tsession_date\topen\thigh\tlow\tclose\tvolume\tvwap\ttrade_count'
  )
    throw new Error('Unexpected frozen SIP daily header or row count')
  const prices = new Map<string, number>()
  for (const line of lines) {
    const [symbol, date, , , , close] = line.split('\t')
    if (symbol !== benchmark) continue
    const day = Schema.decodeUnknownSync(IsoDateSchema)(date)
    const price = Number(close)
    if (!Number.isFinite(price) || price <= 0 || prices.has(day)) throw new Error(`Invalid SIP close for ${day}`)
    prices.set(day, price)
  }
  const history: { session: string; returns: [number] }[] = []
  const priorVols: (number | null)[] = []
  let previous: number | undefined
  return new Map(
    [...prices]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, price]) => {
        const spyReturn = previous === undefined ? null : price / previous - 1
        previous = price
        const vol = trailingSleeveRisk(history.slice(-14), date, 1).volatility[0] ?? null
        const median = quantile(
          priorVols.slice(-60).filter((value) => value !== null),
          0.5,
        )
        if (spyReturn !== null) history.push({ session: date, returns: [spyReturn] })
        priorVols.push(vol)
        return [date, { spyReturn, highVol: vol !== null && median !== null ? vol > median : null }] as const
      }),
  )
}

type TapeByDate = Map<string, Map<string, RawBar[]>>
type Calendar = ReturnType<typeof decodeRegularCalendar>

const readBars = (
  input: { readonly text: string; readonly rows: number },
  calendar: Calendar,
  start: string,
  end: string,
  universe: ReadonlySet<string>,
  adjust: boolean,
): TapeByDate => {
  const days = new Map(
    calendar.providerSessions
      .filter(({ date }) => date >= start && date <= end)
      .map(({ date }) => [
        date as string,
        {
          ...Result.getOrThrow(resolveAlphaRegularSession(calendar, date)),
          tapes: new Map<string, RawBar[]>(),
        },
      ]),
  )
  const seen = new Set<string>()
  let rowCount = 0
  // Avoid retaining a second copy of the large decoded TSV as an array of strings.
  for (let cursor = 0; cursor < input.text.length; ) {
    const endOfLine = input.text.indexOf('\n', cursor)
    const line = input.text.slice(cursor, endOfLine < 0 ? undefined : endOfLine)
    cursor = endOfLine < 0 ? input.text.length : endOfLine + 1
    rowCount++
    const { date, symbol, at, value } = parseBar(line)
    if (!universe.has(symbol) || date < start || date > end) continue
    const day = days.get(date)
    if (day === undefined) throw new Error(`Frozen bar date not in calendar: ${symbol} ${date}`)
    if (at < day.openMs || at >= day.closeMs) continue
    const tape = day.tapes.get(symbol) ?? []
    const key = `${symbol}:${at}`
    if (seen.has(key)) throw new Error(`Duplicate frozen bar ${key}`)
    seen.add(key)
    const bar = { ...value, symbol, eventAt: new Date(at).toISOString(), eventMs: at }
    tape.push(adjust ? nvdaSplitAdjusted(bar, date) : bar)
    day.tapes.set(symbol, tape)
  }
  if (rowCount !== input.rows) throw new Error('Frozen minute row count mismatch')
  return new Map(
    [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { tapes }]) => [
        date,
        new Map([...tapes].map(([symbol, bars]) => [symbol, bars.sort((a, b) => a.eventMs - b.eventMs)])),
      ]),
  )
}

const missingMarket = { spyReturn: null, highVol: null }

export const readAllocatorDatasets = (directory: string) => {
  const {
    read,
    sources: files,
    manifestSha256,
  } = openFrozenBaynDataset(directory, [calendarFile, liveFile, longFile, dailyFile])
  const calendar = decodeRegularCalendar(JSON.parse(read(calendarFile).text))
  const sip = read(dailyFile)
  const market = parseDailyMarket(sip.text, sip.rows)
  const live = readBars(
    read(liveFile),
    calendar,
    warmupStart,
    evaluationEnd,
    new Set([...policy.candidateSymbols, benchmark]),
    false,
  )
  const longSymbols = ['AAPL', 'AMZN', 'NVDA', ...policy.noiseAreaSymbols]
  const longUniverse = new Set([...longSymbols, benchmark])
  const long = readBars(read(longFile), calendar, longStart, '2026-08-24', longUniverse, true)
  for (const [date, tapes] of live) {
    if (date >= longHoldoutSplice) long.set(date, new Map([...tapes].filter(([symbol]) => longUniverse.has(symbol))))
  }
  if ([...live.keys()].filter((date) => date >= evaluationStart).length !== 66)
    throw new Error('Expected 66 live evaluation sessions')
  return {
    calendar,
    market,
    live,
    long,
    longSymbols,
    sources: { manifestSha256, files, calendarHash: calendar.normalizedResponseHash },
  }
}

// The variant key is the omitted candidate. Production ranking is rerun against the reduced universe,
// while symbol-level features are reused (other than the remaining Noise Area leg's inverse-ATR weight).
export const preparePortfolioSessions = (
  dataset: ReturnType<typeof readAllocatorDatasets>,
  cohort: 'live' | 'long',
) => {
  const { calendar, market } = dataset
  const data = dataset[cohort]
  const candidateSymbols = cohort === 'live' ? policy.candidateSymbols : dataset.longSymbols
  const equitySymbols = policy.equitySymbols.filter((symbol) => candidateSymbols.includes(symbol))
  const cohortPolicy = { ...policy, candidateSymbols, equitySymbols }
  const omittedSymbols: readonly string[] = cohort === 'live' ? ['', ...candidateSymbols] : ['']
  const dates = [...data.keys()]
  const summaries = buildSessionSummaries(data, dates, calendar)
  const dispersionHistory = new Map<string, Map<number, (number | null)[]>>(
    omittedSymbols.map((symbol) => [symbol, new Map()]),
  )
  const sessionsByOmission = new Map<string, PortfolioSession[]>(omittedSymbols.map((symbol) => [symbol, []]))

  for (const [index, date] of dates.entries()) {
    const regular = Result.getOrThrow(resolveAlphaRegularSession(calendar, date))
    const minutes = (regular.closeMs - regular.openMs) / minuteMs
    const symMap = data.get(date) ?? new Map<string, RawBar[]>()
    const bars = new Map(
      [...symMap].map(([symbol, tape]) => [
        symbol,
        new Map(tape.map((bar) => [(bar.eventMs - regular.openMs) / minuteMs, bar])),
      ]),
    )
    const priorDays = dates
      .slice(Math.max(0, index - 32), index)
      .filter((day) => Date.parse(date) - Date.parse(day) <= 42 * 86_400_000)
    const baseline = buildTrailingBaseline({
      sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(date),
      symbols: candidateSymbols,
      noiseAreaSymbols: policy.noiseAreaSymbols,
      lookbackSessions: trailingBaseline.lookbackSessions,
      minimumSessions: trailingBaseline.minimumSessions,
      dailyRows: priorDays.flatMap((day) => summaries.dailyByDate.get(day) ?? []),
      checkpointRows: priorDays.flatMap((day) => summaries.checkpointsByDate.get(day) ?? []),
    })
    const byOmission = new Map<string, Map<number, Decision>>(omittedSymbols.map((symbol) => [symbol, new Map()]))
    for (let minute = 0; minute < minutes - 1; minute++) {
      const orb = minute >= morningOrb.entryStartMinuteFromOpen && minute <= morningOrb.entryEndMinuteFromOpen
      const midday =
        cohort === 'live' &&
        minute >= middayReversion.entryStartMinuteFromOpen &&
        minute <= middayReversion.entryEndMinuteFromOpen
      const noise = noiseArea.checkpointMinutesFromOpen.some((point) => point === minute + 1)
      if (!orb && !midday && !noise) continue

      const snapshot = buildReplaySnapshot({
        sessionDate: date,
        calendar,
        sessionOpenMs: regular.openMs,
        rangeEndMs: regular.openMs + (minute + 1) * minuteMs,
        symMap,
        // The selector checks quote presence; the replay applies scenario costs separately.
        quoteModel: { slippageRtBps: 2 },
      })
      const extract = (blockNoise: boolean) =>
        Result.isSuccess(baseline)
          ? Result.getOrThrow(
              extractIntradayAlphaCandidates({
                snapshot,
                accountId: replayAccountId,
                policy: cohortPolicy,
                trailingBaseline: baseline.success,
                equityShortEligibility: makeShortEligibility(snapshot.manifest.observedAt),
                ...(blockNoise ? { noiseAreaTakenSymbols: policy.noiseAreaSymbols } : {}),
              }),
            )
          : undefined
      const noisePool = noise ? extract(false) : undefined
      const equityPool = orb || midday ? extract(noise) : undefined
      for (const [omitted, decisions] of byOmission) {
        const make = (pool: typeof noisePool, expected: ActiveAlphaPhase): Opportunity | undefined => {
          if (pool === undefined || pool.context.phase !== expected || pool.spyVwapDevBps === null) return undefined
          const adjustNoise =
            expected === IntradayAlphaPhase.NoiseAreaTrend &&
            policy.noiseAreaSymbols.some((symbol) => symbol === omitted)
          const adjust = (candidate: (typeof pool.longPool)[number]) =>
            adjustNoise ? { ...candidate, targetWeightOverride: noiseArea.maximumWeightPerLeg } : candidate
          const longs = pool.longPool.filter(({ symbol }) => symbol !== omitted).map(adjust)
          const shorts = pool.shortPool.filter(({ symbol }) => symbol !== omitted).map(adjust)
          const dispersion =
            expected === IntradayAlphaPhase.MiddayReversion
              ? crossSectionalDispersion(longs.map(({ relVwapDevBps }) => relVwapDevBps))
              : null
          const history = dispersionHistory.get(omitted)
          const samples = history?.get(minute) ?? []
          const trailingDispersion =
            samples.length === 14 && samples.every((sample) => sample !== null) ? quantile(samples, 0.5) : null
          const legs = selectIntradayAlphaLegs({
            context: pool.context,
            policy: cohortPolicy,
            longPool: longs,
            shortPool: shorts,
            vetoedSymbols: new Set(),
          })
          return { phase: expected, legs, dispersion, trailingDispersion }
        }
        const equity = orb
          ? make(equityPool, IntradayAlphaPhase.MorningOrb)
          : midday
            ? make(equityPool, IntradayAlphaPhase.MiddayReversion)
            : undefined
        if (midday) {
          const history = dispersionHistory.get(omitted)
          const samples = history?.get(minute) ?? []
          history?.set(minute, [...samples.slice(-13), equity?.dispersion ?? null])
        }
        decisions.set(minute, {
          noise: make(noisePool, IntradayAlphaPhase.NoiseAreaTrend),
          equity,
          observedMsFromOpen: Date.parse(snapshot.manifest.observedAt) - regular.openMs,
          missingBenchmark: bars.get(benchmark)?.has(minute) !== true,
        })
      }
    }
    for (const [omitted, decisions] of byOmission)
      sessionsByOmission.get(omitted)?.push({
        date,
        minutes,
        bars,
        decisions,
        noiseSymbolCount: policy.noiseAreaSymbols.filter((symbol) => symbol !== omitted).length,
        baselineAvailable: Result.isSuccess(baseline),
        ...(market.get(date) ?? missingMarket),
      })
  }
  return sessionsByOmission
}

export const sleeveBudgetWeights = [
  intradayAlphaDefinition.morningOrb.maximumWeightPerLeg,
  intradayAlphaDefinition.middayReversion.targetPairs * 2 * intradayAlphaDefinition.middayReversion.targetWeightPerLeg,
  intradayAlphaDefinition.noiseArea.sleeveGrossWeight,
] as const
