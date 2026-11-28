import { sleeves } from './portfolio-research-data'
import { type PortfolioDay, startingEquity } from './portfolio-research-replay'
import { requireAlignedSessions, sliceFold } from './research-lib/calendar'
import { dailySharpe, deflatedSharpe, expectedMaximumSharpe, sum } from './research-lib/statistics'
import { bootstrapPValue, quantile } from './midday-research-statistics'

const tradingDays = 252

export const economics = (daily: readonly number[]) => {
  let equity = startingEquity
  let peak = equity
  let maxDrawdown = 0
  for (const pnl of daily) {
    equity += pnl
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }
  const net = sum(daily)
  const sharpe = dailySharpe(daily)
  const ranked = daily.toSorted((a, b) => a - b)
  // A fixed-notional strategy does not reinvest: annualize the additive return, not a fictitious CAGR.
  const annualizedReturn = daily.length === 0 ? null : (net / startingEquity) * (tradingDays / daily.length)
  return {
    sessions: daily.length,
    netUsd: daily.length === 0 ? null : net,
    sharpe: sharpe === null ? null : sharpe * Math.sqrt(tradingDays),
    calmar: maxDrawdown === 0 || annualizedReturn === null ? null : annualizedReturn / maxDrawdown,
    maxDrawdown: daily.length === 0 ? null : maxDrawdown,
    exTop5Usd: daily.length <= 5 ? null : sum(ranked.slice(0, -5)),
    exWorst5Usd: daily.length <= 5 ? null : sum(ranked.slice(5)),
  }
}

export const bootstrapTrials = 10_000

// Circular moving-block resampling. The centered test controls the zero-mean null; the uncentered
// resamples are distribution diagnostics, not an independent confirmation of the fitted model.
export const bootstrapPortfolio = (daily: readonly number[]) => {
  if (daily.length < 5) return null
  const net: number[] = []
  const drawdowns: number[] = []
  let rng = 0x4241594e
  for (let trial = 0; trial < bootstrapTrials; trial++) {
    let pnl = 0
    let peak = startingEquity
    let maxDrawdown = 0
    for (let i = 0; i < daily.length; i += 5) {
      rng = (Math.imul(rng, 1_664_525) + 1_013_904_223) >>> 0
      const from = Math.floor((rng / 2 ** 32) * daily.length)
      for (let block = 0; block < Math.min(5, daily.length - i); block++) {
        pnl += daily[(from + block) % daily.length] ?? 0
        peak = Math.max(peak, startingEquity + pnl)
        maxDrawdown = Math.max(maxDrawdown, (peak - startingEquity - pnl) / peak)
      }
    }
    net.push(pnl)
    drawdowns.push(maxDrawdown)
  }
  return {
    trials: bootstrapTrials,
    blockSessions: 5,
    pValue: bootstrapPValue(daily, bootstrapTrials),
    netUsdP05: quantile(net, 0.05),
    netUsdP50: quantile(net, 0.5),
    netUsdP95: quantile(net, 0.95),
    maxDrawdownP95: quantile(drawdowns, 0.95),
  }
}

export const commonSessions = (series: readonly (readonly PortfolioDay[])[]): ReadonlySet<string> => {
  const [calendar = [], ...others] = series
  requireAlignedSessions(calendar, ...others)
  return new Set(calendar.flatMap(({ date }, i) => (series.every((arm) => arm[i].net !== null) ? [date] : [])))
}

export const dailyNet = (days: readonly PortfolioDay[], support: ReadonlySet<string>) =>
  days.flatMap(({ date, net }) => (support.has(date) && net !== null ? [net] : []))

export const trialSharpeBenchmark = (series: readonly (readonly PortfolioDay[])[], support: ReadonlySet<string>) =>
  expectedMaximumSharpe(series.map((days) => dailySharpe(dailyNet(days, support))).filter((value) => value !== null))

export const score = (
  days: readonly PortfolioDay[],
  support: ReadonlySet<string>,
  folds: readonly { readonly name: string; readonly start: string; readonly end: string }[],
  sharpeBenchmark: number | null,
  grossCap: number,
) => {
  const daily = dailyNet(days, support)
  const summarize = (subset: readonly PortfolioDay[]) => ({
    requestedSessions: subset.length,
    ...economics(dailyNet(subset, support)),
  })
  const partitioned = folds.map((fold) => ({
    ...fold,
    days: sliceFold(days, fold),
  }))
  const regimes = {
    spyUp: days.filter(({ spyReturn }) => spyReturn !== null && spyReturn > 0),
    spyDown: days.filter(({ spyReturn }) => spyReturn !== null && spyReturn <= 0),
    highVol: days.filter(({ highVol }) => highVol === true),
    lowVol: days.filter(({ highVol }) => highVol === false),
  }
  const execution = {
    attemptedLegs: sum(days.map(({ orderLegs }) => orderLegs)),
    filledLegs: sum(days.map(({ filled }) => filled)),
    partialBaskets: sum(days.map(({ partialBaskets }) => partialBaskets)),
    unresolvedExits: sum(days.map(({ unresolvedExits }) => unresolvedExits)),
    missingBenchmarkChecks: sum(days.map(({ missingBenchmarkChecks }) => missingBenchmarkChecks)),
    missingEntryPrices: sum(days.map(({ missingEntryPrices }) => missingEntryPrices)),
    missingHeldBars: sum(days.map(({ missingHeldBars }) => missingHeldBars)),
    unknownExposureMinutes: sum(days.map(({ unknownExposureMinutes }) => unknownExposureMinutes)),
    constrainedCheckpoints: sum(days.map(({ capConstrained }) => capConstrained)),
    lossScaledEntries: sum(days.map(({ throttleEntries }) => throttleEntries)),
    profitLockScaledEntries: sum(days.map(({ profitLockEntries }) => profitLockEntries)),
    peakReservedGrossUsd: Math.max(0, ...days.map(({ peakReservedGross }) => peakReservedGross)),
    peakMarkedGrossUsd: Math.max(0, ...days.map(({ peakMarkedGross }) => peakMarkedGross)),
    admissionsOverCap: days.filter(({ peakReservedGross }) => peakReservedGross > grossCap + 1e-6).length,
    daysMarkedOverCap: days.filter(({ peakMarkedGross }) => peakMarkedGross > grossCap + 1e-6).length,
    peakIntradayDrawdown: Math.max(0, ...days.map(({ maxIntradayDrawdown }) => maxIntradayDrawdown)),
    headroomBuckets: ['0% used', '(0%,20%]', '(20%,40%]', '(40%,60%]', '(60%,80%]', '>80%'],
    peakUtilizationDays: Array.from(
      { length: 6 },
      (_, i) =>
        days.filter(({ peakUtilization }) =>
          i === 0 ? peakUtilization === 0 : Math.min(5, Math.ceil(peakUtilization * 5)) === i,
        ).length,
    ),
    closeUtilizationMinutes: Array.from({ length: 6 }, (_, i) => sum(days.map((day) => day.timeBuckets[i] ?? 0))),
  }
  return {
    ...summarize(days),
    completeSessions: days.filter(({ net }) => net !== null).length,
    fullWindowNetUsd: days.every(({ net }) => net !== null) ? sum(days.map(({ net }) => net ?? 0)) : null,
    observedClosedNetUsd: sum(days.map(({ closedNet }) => closedNet)),
    folds: partitioned.map(({ days: subset, ...fold }) => ({ ...fold, ...summarize(subset) })),
    regimes: {
      spyUp: summarize(regimes.spyUp),
      spyDown: summarize(regimes.spyDown),
      highVol: summarize(regimes.highVol),
      lowVol: summarize(regimes.lowVol),
    },
    sleeves: sleeves.map((phase, i) => {
      const sleeveEconomics = (subset: readonly PortfolioDay[]) =>
        economics(
          subset.flatMap(({ date, sleeveNet }) => {
            const net = sleeveNet[i]
            return support.has(date) && net != null ? [net] : []
          }),
        )
      return {
        phase,
        ...sleeveEconomics(days),
        foldNetUsd: partitioned.map(({ days: subset }) => sleeveEconomics(subset).netUsd),
        regimeNetUsd: Object.values(regimes).map((subset) => sleeveEconomics(subset).netUsd),
      }
    }),
    bootstrap: bootstrapPortfolio(daily),
    dsr: deflatedSharpe(daily, sharpeBenchmark),
    execution,
  }
}
