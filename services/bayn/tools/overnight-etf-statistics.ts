import { dailySharpe, deflatedSharpe, mean, sum } from './midday-research-statistics'
import { capital, splits } from './noise-area-study-replay'
import { stationaryBootstrap } from './noise-area-study-statistics'
import { type Session, universe } from './vol-regime-carry-data'

export const sellFee = 0.21 / 10_000
const annualization = Math.sqrt(252)
const msPerYear = 365.2425 * 86_400_000

export interface LedgerDay {
  readonly date: string
  readonly net: number
  readonly overnight: number
  readonly intraday: number
  readonly priorNav: number
  readonly fees: number
  readonly mocNotional: number
  readonly fundingNotional: number
  readonly openNotional: number
  readonly noiseNotional: number
  readonly noiseNet: number
  readonly overnightGrossRatio: number
  readonly intradayEntryGrossRatio: number
  readonly intradayMarkWarning: boolean
  readonly cashStressShortfall: number
  readonly spyDay: number
  readonly noise:
    | {
        readonly blockedEntries: number
        readonly trades: number
        readonly missingEntries: number
        readonly missingHeld: number
        readonly firstEntryMinutesAfterOpen: number | null
        readonly lastExitMinutesBeforeClose: number | null
      }
    | undefined
}

type Path = { readonly id: string; readonly rows: readonly LedgerDay[] }
type Scenario = { readonly bp: number; readonly books: readonly Path[] }
type Hurdle = { readonly bp: number; readonly hurdle: number | null }
const windows = {
  train: [splits.train.first, splits.train.last],
  validation: [splits.validation.first, splits.validation.last],
  holdout: [splits.holdout.first, splits.holdout.last],
  full: [splits.train.first, splits.holdout.last],
  bear2022: ['2022-01-01', '2022-12-31'],
} as const
const compound = (returns: readonly number[]) => returns.reduce((wealth, value) => wealth * (1 + value), 1)
const pairMoments = (a: readonly number[], b: readonly number[]) => {
  if (a.length !== b.length) throw new Error('Unpaired statistics inputs')
  const centerA = mean(a)
  const centerB = mean(b)
  let aa = 0
  let bb = 0
  let ab = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - centerA
    const y = b[i] - centerB
    aa += x * x
    bb += y * y
    ab += x * y
  }
  return { aa, bb, ab }
}
const correlation = (a: readonly number[], b: readonly number[]) => {
  const { aa, bb, ab } = pairMoments(a, b)
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : null
}
const netLeg = (ret: number, bp: number) => {
  const slip = bp / 20_000
  return ((1 + ret) * (1 - slip - (bp > 0 ? sellFee : 0))) / (1 + slip) - 1
}

export const decomposition = (sessions: readonly Session[], tiers: readonly number[]) =>
  Object.fromEntries(
    universe.map((symbol, j) => {
      const rows = sessions.map(({ date, bars }, i) => {
        const bar = bars[j]
        const previous = sessions[i - 1]?.bars[j]
        return {
          date,
          day: bar === undefined ? null : bar.close / bar.open - 1,
          night: previous === undefined || bar === undefined ? null : bar.open / previous.close - 1,
          both: previous === undefined || bar === undefined ? null : bar.close / previous.close - 1,
        }
      })
      return [
        symbol,
        Object.fromEntries(
          Object.entries(windows).flatMap(([name, [first, last]]) => {
            const slice = rows.filter(({ date }) => date >= first && date <= last)
            if (slice.length === 0) return []
            const nights = slice.flatMap(({ night }) => (night === null ? [] : [night]))
            const days = slice.flatMap(({ day }) => (day === null ? [] : [day]))
            const pairedDays = slice.flatMap(({ day, night }) => (day === null || night === null ? [] : [day]))
            const paired = slice.flatMap(({ both }) => (both === null ? [] : [both]))
            const overnightLog = sum(nights.map((r) => Math.log1p(r)))
            const intradayLog = sum(pairedDays.map((r) => Math.log1p(r)))
            const bothLog = sum(paired.map((r) => Math.log1p(r)))
            if (Math.abs(overnightLog + intradayLog - bothLog) > 1e-10)
              throw new Error(`ETF decomposition does not reconcile: ${symbol} ${name}`)
            const returnOf = (leg: number[], bp: number) =>
              leg.length === 0 ? null : compound(leg.map((r) => netLeg(r, bp))) - 1
            return [
              [
                name,
                {
                  sessions: slice.length,
                  overnightCount: nights.length,
                  intradayCount: days.length,
                  pairedCount: paired.length,
                  overnightShareOfPairedLogReturn: Math.abs(bothLog) > 1e-12 ? overnightLog / bothLog : null,
                  overnightIntradayCorrelation: correlation(nights, pairedDays),
                  pairedCloseToCloseGross: paired.length > 0 ? compound(paired) - 1 : null,
                  pairedIntradayGross: pairedDays.length > 0 ? compound(pairedDays) - 1 : null,
                  returns: tiers.map((bp) => ({ bp, overnight: returnOf(nights, bp), intraday: returnOf(days, bp) })),
                },
              ],
            ]
          }),
        ),
      ]
    }),
  )

export const summarize = (
  rows: readonly LedgerDay[],
  shy: readonly LedgerDay[],
  b0: readonly LedgerDay[],
  years: number,
  hurdle: number | null,
  p: ReturnType<typeof stationaryBootstrap>,
) => {
  if (
    rows.length === 0 ||
    years <= 0 ||
    rows.some(({ date }, i) => date !== shy[i]?.date || date !== b0[i]?.date) ||
    rows.length !== shy.length ||
    rows.length !== b0.length
  )
    throw new Error('Misaligned comparison window')
  const all = rows.map(({ net }) => net)
  const excess = all.map((value, i) => value - shy[i].net)
  const allB0 = all.map((value, i) => value - b0[i].net)
  const top = new Set(
    all
      .map((net, i) => ({ net, i }))
      .filter(({ net }) => net > 0)
      .sort((a, b) => b.net - a.net || a.i - b.i)
      .slice(0, 10)
      .map(({ i }) => i),
  )
  const trimmed = (series: readonly LedgerDay[]) => compound(series.flatMap(({ net }, i) => (top.has(i) ? [] : [net])))
  let peak = 1
  let nav = 1
  let maxDrawdown = 0
  let maxDrawdownUsd = 0
  const annual = new Map<string, number>()
  for (const { date, net } of rows) {
    nav *= 1 + net
    peak = Math.max(peak, nav)
    maxDrawdown = Math.max(maxDrawdown, 1 - nav / peak)
    maxDrawdownUsd = Math.max(maxDrawdownUsd, (peak - nav) * capital)
    const year = date.slice(0, 4)
    annual.set(year, (annual.get(year) ?? 1) * (1 + net))
  }
  const cagr = nav ** (1 / years) - 1
  const downside = Math.sqrt(mean(all.map((ret) => Math.min(0, ret) ** 2)))
  const sharpe = dailySharpe(all)
  const daytime = rows.map(({ intraday }) => intraday)
  const beta = pairMoments(
    daytime,
    rows.map(({ spyDay }) => spyDay),
  )
  const shyExcess = nav - compound(shy.map(({ net }) => net))
  const trimmedWealth = trimmed(rows)
  const clockMinimum = (field: 'firstEntryMinutesAfterOpen' | 'lastExitMinutesBeforeClose') => {
    const sampled = rows.flatMap(({ noise }) => {
      const value = noise?.[field]
      return value === null || value === undefined ? [] : [value]
    })
    return sampled.length > 0 ? Math.min(...sampled) : null
  }
  return {
    sessions: rows.length,
    elapsedYears: years,
    finalEquity: nav * capital,
    cagr,
    shyExcess,
    shyExcessUsd: shyExcess * capital,
    sharpe: sharpe === null ? null : sharpe * annualization,
    sortino: downside > 0 ? (mean(all) / downside) * annualization : null,
    maxDrawdown,
    maxDrawdownUsd,
    calmar: maxDrawdown > 0 ? cagr / maxDrawdown : null,
    turnoverAnnual:
      sum(
        rows.map(
          (row) => (row.mocNotional + row.openNotional + row.noiseNotional + row.fundingNotional) / (2 * row.priorNav),
        ),
      ) / years,
    calendarReturns: Object.fromEntries([...annual].map(([year, value]) => [year, value - 1])),
    positiveCalendarYears: [...annual.values()].filter((value) => value > 1).length,
    calendarYears: annual.size,
    exTop10Excess: trimmedWealth - trimmed(shy),
    exTop10ExcessVsB0: trimmedWealth - trimmed(b0),
    topRemovedDates: [...top].map((i) => rows[i].date),
    overnightIntradayCorrelation: correlation(
      rows.map(({ overnight }) => overnight),
      daytime,
    ),
    daytimeBetaToSpy: beta.bb > 0 ? beta.ab / beta.bb : null,
    pVsShy: p(excess),
    pVsB0: p(allB0),
    dsr: deflatedSharpe(excess, hurdle),
    execution: {
      feesUsd: sum(rows.map(({ fees }) => fees)),
      mocNotionalUsd: sum(rows.map(({ mocNotional }) => mocNotional)),
      closeFundingNotionalUsd: sum(rows.map(({ fundingNotional }) => fundingNotional)),
      openNotionalUsd: sum(rows.map(({ openNotional }) => openNotional)),
      noiseNotionalUsd: sum(rows.map(({ noiseNotional }) => noiseNotional)),
      noiseNetUsd: sum(rows.map(({ noiseNet }) => noiseNet)),
      blockedNoiseEntries: sum(rows.map(({ noise }) => noise?.blockedEntries ?? 0)),
      noiseTrades: sum(rows.map(({ noise }) => noise?.trades ?? 0)),
      missingNoiseEntries: sum(rows.map(({ noise }) => noise?.missingEntries ?? 0)),
      missingHeldNoiseBars: sum(rows.map(({ noise }) => noise?.missingHeld ?? 0)),
      firstNoiseEntryMinutesAfterOpen: clockMinimum('firstEntryMinutesAfterOpen'),
      lastNoiseExitMinutesBeforeClose: clockMinimum('lastExitMinutesBeforeClose'),
      maxOvernightGrossRatio: Math.max(...rows.map(({ overnightGrossRatio }) => overnightGrossRatio)),
      maxIntradayEntryGrossRatio: Math.max(...rows.map(({ intradayEntryGrossRatio }) => intradayEntryGrossRatio)),
      intradayMarkWarnings: rows.filter(({ intradayMarkWarning }) => intradayMarkWarning).map(({ date }) => date),
      cashStressShortfallUsd: Math.max(...rows.map(({ cashStressShortfall }) => cashStressShortfall)),
    },
  }
}

export const comparisonReport = (scenarios: readonly Scenario[], hurdles: readonly Hurdle[]) => {
  const gross = scenarios.find(({ bp }) => bp === 0)
  if (gross === undefined || gross.books.length === 0) throw new Error('Missing gross counterfactual')
  const dates = gross.books[0].rows.map(({ date }) => date)
  const metrics = Object.fromEntries(
    Object.entries(windows).flatMap(([name, [first, last]]) => {
      if ((dates.at(-1) ?? '') < last) return []
      const from = dates.findIndex((date) => date >= first)
      const until = dates.findLastIndex((date) => date <= last) + 1
      if (from < 0 || until <= from) throw new Error(`Missing registered window ${name}`)
      const years =
        (Date.parse(dates[until - 1]) - Date.parse(dates[Math.max(0, from - 1)]) + (from === 0 ? 86_400_000 : 0)) /
        msPerYear
      const p = stationaryBootstrap(until - from)
      const fold = (paths: readonly Path[], id: string) => {
        const path = paths.find((book) => book.id === id)
        if (path === undefined) throw new Error(`Missing ${id} comparison path`)
        return path.rows.slice(from, until)
      }
      const logWealth = (paths: readonly Path[], id: string) => sum(fold(paths, id).map(({ net }) => Math.log1p(net)))
      const attribution = (paths: readonly Path[], id: string) => {
        const continuous = 'C3-continuous'
        const grossClockLogDifference = logWealth(gross.books, id) - logWealth(gross.books, continuous)
        const netLogDifference = logWealth(paths, id) - logWealth(paths, continuous)
        return {
          grossClockLogDifference,
          incrementalCostLogDrag: grossClockLogDifference - netLogDifference,
          netLogDifference,
        }
      }
      return [
        [
          name,
          scenarios.map(({ bp, books }) => {
            const shy = fold(books, 'C0-SHY')
            const b0 = fold(books, 'B0')
            const hurdle = hurdles.find((row) => row.bp === bp)?.hurdle ?? null
            return {
              bp,
              c3Attribution: { cash: attribution(books, 'C3-cash'), shy: attribution(books, 'C3-SHY') },
              books: Object.fromEntries(
                books.map(({ id, rows }) => [id, summarize(rows.slice(from, until), shy, b0, years, hurdle, p)]),
              ),
            }
          }),
        ],
      ]
    }),
  )
  return { metrics }
}
