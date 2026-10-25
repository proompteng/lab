import { cryptoMaximumTakerFeeBps } from '../broker/crypto-fees'
import { Data, Result } from 'effect'

import { calculateSessionFees, type FeeInput } from '../strategy/execution-model/fees'
import { intradayExecutionModel } from '../strategy/intraday-market'
import { canonicalHashV1Result } from '../hash'

export enum EquityScreenSignal {
  Momentum = 'RELATIVE_MOMENTUM',
  OpeningRange = 'OPENING_RANGE_BREAKOUT',
  Pullback = 'VWAP_PULLBACK',
  Reversal = 'RESIDUAL_REVERSAL',
  EarlyOpeningRange = 'EARLY_OPENING_RANGE_BREAKOUT',
}

export interface EquityScreenBar {
  readonly symbol: string
  readonly at: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly vwap: number
}

export interface EquityScreenDay {
  readonly date: string
  readonly openAt: number
  readonly closeAt: number
}

export interface EquityScreenPolicy {
  readonly signal: EquityScreenSignal
  readonly holdingMinutes: 15 | 60
  readonly adverseBpsPerSide: 10 | 20
  readonly volatilityRisk?: boolean
}

export const equityScreenDefinition = Object.freeze({
  schemaVersion: 'bayn.equity-edge-screen-definition.v6',
  signalMinutes: 30,
  decisionIntervalMinutes: 5,
  lastEntryMinute: 210,
  firstEntryMinute: 30,
  entryDelayMinutes: 1,
  openingRangeMinutes: 5,
  relativeVolumePriorSessions: 14,
  protectiveStopBps: 50,
  initialCapitalMicros: '100000000000',
  maximumAllocationWeightBps: 2000,
  maximumDailyTurnoverMicros: '1000000000000',
  maximumDailyLossMicros: '1000000000',
  flattenMinutesBeforeClose: 5,
  maximumExitWaitMinutes: 3,
  feePolicy: 'native-intraday-execution-model',
  executionModelHash: Result.getOrThrow(canonicalHashV1Result(intradayExecutionModel)),
  feeAggregation:
    'Cumulative native session-by-fee-type deltas; one fill per simulated order preserves per-order TAF caps',
  sizing:
    'Completed signal close with adverse-price reserve; fixed quantity before arrival; reject an arrival exceeding its allocation, never resize from future price',
  entry: 'first eligible next-minute open, adverse price rounded to cents',
  exit: 'bar-completion stop or horizon, next available open within three minutes; no forced mark-to-flat',
  capacity: 'UNVERIFIED; no quote, queue, IOC, or limit-fill simulation',
  costs: 'execution-only; external costs remain UNKNOWN',
  missingRequiredEvidence:
    'Benchmark windows, selected entry prices and held-position marks invalidate the path; only candidate-specific signal gaps permit exclusion',
  qualification: 'UNQUALIFIED_RETROSPECTIVE_BAR_SCREEN',
})

export class EquityScreenError extends Data.TaggedError('EquityScreenError')<{ readonly message: string }> {}

export const equityScreenPolicies: readonly EquityScreenPolicy[] = [
  EquityScreenSignal.Momentum,
  EquityScreenSignal.OpeningRange,
  EquityScreenSignal.Pullback,
].flatMap((signal) => ([15, 60] as const).map((holdingMinutes) => ({ signal, holdingMinutes, adverseBpsPerSide: 10 })))

export const equityRiskScreenPolicies: readonly EquityScreenPolicy[] = [
  { signal: EquityScreenSignal.Reversal, holdingMinutes: 15, adverseBpsPerSide: 10, volatilityRisk: true },
  { signal: EquityScreenSignal.Reversal, holdingMinutes: 60, adverseBpsPerSide: 10, volatilityRisk: true },
  { signal: EquityScreenSignal.OpeningRange, holdingMinutes: 60, adverseBpsPerSide: 10, volatilityRisk: true },
]

export const equityEarlyScreenPolicies: readonly EquityScreenPolicy[] = ([15, 60] as const).flatMap((holdingMinutes) =>
  [false, true].map((volatilityRisk) => ({
    signal: EquityScreenSignal.EarlyOpeningRange,
    holdingMinutes,
    adverseBpsPerSide: 10,
    volatilityRisk,
  })),
)

export const equityEarlyScreenDefinition = Object.freeze({
  schemaVersion: 'bayn.equity-early-screen-definition.v1',
  entryWindowMinutes: [5, 30],
  decisionIntervalMinutes: 1,
  maximumEntriesPerSession: 1,
  selection:
    'Positive first-five-minute candle, completed close above opening high, nonnegative benchmark return, first-five-minute volume above fourteen prior sessions; rank relative opening volume',
  qualification: 'UNQUALIFIED_RETROSPECTIVE_BAR_SCREEN',
})

export const equityRiskScreenDefinition = Object.freeze({
  schemaVersion: 'bayn.equity-risk-screen-definition.v1',
  reversal:
    'Nonnegative benchmark return; negative own return; rebound over five bars; below thirty-bar VWAP by 1.5 realized horizon standard deviations',
  stop: 'Two realized thirty-bar minute-return standard deviations scaled to holding horizon; bounded to 50..200 bps',
  sizing: 'At most 20% of equity and 0.1% of equity divided by stop distance; no leverage',
  qualification: 'UNQUALIFIED_RETROSPECTIVE_BAR_SCREEN',
})

const volatilityBps = (bars: readonly EquityScreenBar[]) => {
  const returns = bars.slice(1).map((bar, i) => Math.log(bar.close / (bars[i]?.close ?? bar.close)))
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length
  return Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length) * 10_000
}

const minuteMs = 60_000
const micros = 1_000_000n
const quantityScale = 1_000_000_000n
const initialCapital = BigInt(equityScreenDefinition.initialCapitalMicros)
const priceMicros = (price: number, buy: boolean, bps: number) =>
  BigInt(buy ? Math.ceil(price * (1 + bps / 10_000) * 100) : Math.floor(price * (1 - bps / 10_000) * 100)) * 10_000n

export interface EquityScreenTrade {
  readonly symbol: string
  readonly signalAt: number
  readonly entryAt: number
  readonly exitAt: number
  readonly shares: number
  readonly entryPriceMicros: string
  readonly exitPriceMicros: string
  readonly grossPnlMicros: string
  readonly feesMicros: string
  readonly executionNetPnlMicros: string
  readonly exitReason: 'STOP' | 'HORIZON' | 'CLOSE' | 'DAILY_LOSS'
}

type IndexedBars = ReadonlyMap<string, ReadonlyMap<number, EquityScreenBar>>

export const indexEquityScreenBars = (bars: readonly EquityScreenBar[]) =>
  Result.gen(function* () {
    const index = new Map<string, Map<number, EquityScreenBar>>()
    for (const bar of bars) {
      if (
        !Number.isSafeInteger(bar.at) ||
        bar.at % minuteMs !== 0 ||
        bar.symbol.includes('/') ||
        ![bar.open, bar.high, bar.low, bar.close, bar.vwap].every(
          (x) => Number.isFinite(x) && x > 0 && x < 1_000_000,
        ) ||
        !Number.isFinite(bar.volume) ||
        bar.volume < 0 ||
        bar.high < Math.max(bar.open, bar.close, bar.low) ||
        bar.low > Math.min(bar.open, bar.close) ||
        bar.vwap < bar.low ||
        bar.vwap > bar.high
      )
        return yield* Result.fail(new EquityScreenError({ message: 'Invalid equity bar' }))
      const symbolBars = index.get(bar.symbol) ?? new Map<number, EquityScreenBar>()
      if (symbolBars.has(bar.at))
        return yield* Result.fail(new EquityScreenError({ message: 'Duplicate symbol/minute' }))
      symbolBars.set(bar.at, bar)
      index.set(bar.symbol, symbolBars)
    }
    return index
  })

const window = (index: IndexedBars, symbol: string, start: number, count: number) => {
  const rows: EquityScreenBar[] = []
  for (let i = 0; i < count; i++) {
    const bar = index.get(symbol)?.get(start + i * minuteMs)
    if (bar === undefined) return null
    rows.push(bar)
  }
  return rows
}

export enum EquityScreenExclusionReason {
  Signal = 'MISSING_SIGNAL_WINDOW',
  Opening = 'MISSING_OPENING_WINDOW',
  History = 'MISSING_PRIOR_OPENING_HISTORY',
}

export interface EquityScreenExclusion {
  readonly symbol: string
  readonly signalAt: number
  readonly missingAt: number | null
  readonly reason: EquityScreenExclusionReason
  readonly targetWeight: 0
}

const firstMissingMinute = (index: IndexedBars, symbol: string, start: number, count: number) => {
  for (let i = 0; i < count; i++) {
    const at = start + i * minuteMs
    if (index.get(symbol)?.has(at) !== true) return at
  }
  return null
}

/** Causal feature screen only: no model answers or future bar enters candidate ranking. */
export const equityScreenCandidates = (
  index: IndexedBars,
  symbols: readonly string[],
  days: readonly EquityScreenDay[],
  dayIndex: number,
  at: number,
  signal: EquityScreenSignal,
): {
  readonly candidates: readonly { symbol: string; score: number }[]
  readonly exclusions: readonly EquityScreenExclusion[]
} => {
  const exclusions: EquityScreenExclusion[] = []
  const day = days[dayIndex]
  if (day === undefined) return { candidates: [], exclusions }
  const early = signal === EquityScreenSignal.EarlyOpeningRange
  const count = early ? Math.min(30, Math.floor((at - day.openAt) / minuteMs)) : 30
  if (count < 5) return { candidates: [], exclusions }
  const benchmark = window(index, 'SPY', at - count * minuteMs, count)
  const benchmarkStart = benchmark?.[0]
  const benchmarkEnd = benchmark?.at(-1)
  if (benchmarkStart === undefined || benchmarkEnd === undefined) return { candidates: [], exclusions }
  const benchmarkReturn = benchmarkEnd.close / benchmarkStart.open - 1
  const result: { symbol: string; score: number }[] = []
  for (const symbol of symbols) {
    if (symbol === 'SPY') continue
    const bars = window(index, symbol, at - count * minuteMs, count)
    const first = bars?.[0]
    const last = bars?.at(-1)
    if (bars === null || first === undefined || last === undefined) {
      exclusions.push({
        symbol,
        signalAt: at,
        missingAt: firstMissingMinute(index, symbol, at - count * minuteMs, count),
        reason: EquityScreenExclusionReason.Signal,
        targetWeight: 0,
      })
      continue
    }
    const ownReturn = last.close / first.open - 1
    const excess = ownReturn - benchmarkReturn
    let score = excess
    if (signal === EquityScreenSignal.Reversal) {
      const volume = bars.reduce((sum, bar) => sum + bar.volume, 0)
      const fiveAgo = bars.at(-6)
      if (volume <= 0 || fiveAgo === undefined || ownReturn >= 0 || benchmarkReturn < 0 || last.close <= fiveAgo.close)
        continue
      const vwap = bars.reduce((sum, bar) => sum + bar.vwap * bar.volume, 0) / volume
      const deviation = volatilityBps(bars) * Math.sqrt(30)
      const gap = (vwap / last.close - 1) * 10_000
      if (deviation <= 0 || gap <= 1.5 * deviation) continue
      score = gap / deviation
    }
    if (signal === EquityScreenSignal.OpeningRange || early) {
      const opening = window(index, symbol, day.openAt, 5)
      if (opening === null) {
        exclusions.push({
          symbol,
          signalAt: at,
          missingAt: firstMissingMinute(index, symbol, day.openAt, 5),
          reason: EquityScreenExclusionReason.Opening,
          targetWeight: 0,
        })
        continue
      }
      if (dayIndex < 14) {
        exclusions.push({
          symbol,
          signalAt: at,
          missingAt: null,
          reason: EquityScreenExclusionReason.History,
          targetWeight: 0,
        })
        continue
      }
      const priorDays = days.slice(dayIndex - 14, dayIndex)
      const priorVolumes = priorDays.map((prior) => window(index, symbol, prior.openAt, 5))
      const missingPrior = priorVolumes.findIndex((rows) => rows === null)
      if (missingPrior >= 0) {
        const prior = priorDays[missingPrior]
        exclusions.push({
          symbol,
          signalAt: at,
          missingAt: prior === undefined ? null : firstMissingMinute(index, symbol, prior.openAt, 5),
          reason: EquityScreenExclusionReason.History,
          targetWeight: 0,
        })
        continue
      }
      if (early && (benchmarkReturn < 0 || (opening.at(-1)?.close ?? 0) <= (opening[0]?.open ?? 0))) continue
      const average =
        priorVolumes.reduce((total, rows) => total + (rows?.reduce((sum, bar) => sum + bar.volume, 0) ?? 0), 0) / 14
      const volume = opening.reduce((sum, bar) => sum + bar.volume, 0)
      if (average <= 0 || volume <= average || last.close <= Math.max(...opening.map((bar) => bar.high))) continue
      score = volume / average
    }
    if (!early && signal !== EquityScreenSignal.Reversal && (ownReturn <= 0 || excess <= 0)) continue
    if (signal === EquityScreenSignal.Pullback) {
      const prior = bars.slice(0, 25)
      const recent = bars.slice(25)
      const priorVolume = prior.reduce((sum, bar) => sum + bar.volume, 0)
      const totalVolume = bars.reduce((sum, bar) => sum + bar.volume, 0)
      const priorLast = prior.at(-1)
      if (priorVolume <= 0 || totalVolume <= 0 || priorLast === undefined) continue
      const priorVwap = prior.reduce((sum, bar) => sum + bar.vwap * bar.volume, 0) / priorVolume
      const currentVwap = bars.reduce((sum, bar) => sum + bar.vwap * bar.volume, 0) / totalVolume
      if (priorLast.close > priorVwap || last.close <= currentVwap || recent.some((bar) => bar.volume <= 0)) continue
    }
    result.push({ symbol, score })
  }
  return { candidates: result.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol, 'en')), exclusions }
}

/** Serial one-position retrospective bar simulation. Its fills are scenarios, never observed executions. */
export const runEquityEdgeScreen = (
  index: IndexedBars,
  symbols: readonly string[],
  days: readonly EquityScreenDay[],
  from: string,
  through: string,
  policy: EquityScreenPolicy,
) =>
  Result.gen(function* () {
    if (
      from > through ||
      !symbols.includes('SPY') ||
      new Set(symbols).size !== symbols.length ||
      symbols.some((symbol) => symbol.includes('/'))
    )
      return yield* Result.fail(new EquityScreenError({ message: 'Invalid screen scope' }))
    for (let i = 0; i < days.length; i++) {
      const day = days[i]
      const previous = days[i - 1]
      if (
        day === undefined ||
        !Number.isSafeInteger(day.openAt) ||
        !Number.isSafeInteger(day.closeAt) ||
        day.openAt % minuteMs !== 0 ||
        day.closeAt % minuteMs !== 0 ||
        day.openAt >= day.closeAt ||
        (previous !== undefined && (previous.date >= day.date || previous.closeAt >= day.openAt))
      )
        return yield* Result.fail(new EquityScreenError({ message: 'Invalid ordered session calendar' }))
    }
    let cash = initialCapital
    let peak = cash
    let drawdown = 0n
    let unknownMarkedMinutes = 0
    const sessions: {
      date: string
      netPnlMicros: string
      trades: number
      noCandidateDecisions: number
      missingArrivalBars: number
      entryBudgetRejections: number
      feesMicros: string
    }[] = []
    const trades: EquityScreenTrade[] = []
    const candidateExclusions: EquityScreenExclusion[] = []
    const early = policy.signal === EquityScreenSignal.EarlyOpeningRange
    let incomplete: { date: string; symbol: string; reason: string } | null = null
    const feeInput = (symbol: string, buy: boolean, shares: bigint, price: bigint): FeeInput => ({
      symbol,
      side: buy ? 'buy' : 'sell',
      quantityAtoms: shares * quantityScale,
      notionalMicros: shares * price,
    })
    for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
      const day = days[dayIndex]
      if (day === undefined || day.date < from || day.date > through) continue
      const dayStart = cash
      const tradeStart = trades.length
      let turnover = 0n
      let noCandidate = 0
      let missingArrivalBars = 0
      let entryBudgetRejections = 0
      const sessionFills: FeeInput[] = []
      let sessionFees = 0n
      // Quoting a hypothetical fill does not mutate the session. Accepted fills post only its cumulative fee delta.
      const fee = (symbol: string, buy: boolean, shares: bigint, price: bigint) =>
        calculateSessionFees(
          [...sessionFills, feeInput(symbol, buy, shares, price)],
          intradayExecutionModel,
          micros,
          cryptoMaximumTakerFeeBps,
        ).pipe(Result.map((value) => value.cashMicros - sessionFees))
      let position: {
        symbol: string
        shares: bigint
        cost: bigint
        entryFees: bigint
        price: bigint
        enteredAt: number
        signalAt: number
        stopBps: bigint
      } | null = null
      const closeAt = day.closeAt - 5 * minuteMs
      let notBefore = day.openAt + (early ? 5 : 30) * minuteMs
      for (let at = notBefore; at < day.closeAt; at += minuteMs) {
        if (position !== null) {
          if (at <= position.enteredAt) continue
          const last = index.get(position.symbol)?.get(at - minuteMs)
          if (last === undefined) {
            unknownMarkedMinutes++
            incomplete = { date: day.date, symbol: position.symbol, reason: 'MISSING_HELD_POSITION_BAR' }
            break
          }
          const marked = last === undefined ? null : cash + position.shares * priceMicros(last.close, false, 0)
          if (marked !== null) {
            peak = marked > peak ? marked : peak
            drawdown = peak - marked > drawdown ? peak - marked : drawdown
          }
          const reason =
            at >= closeAt
              ? 'CLOSE'
              : last !== undefined &&
                  priceMicros(last.low, false, 0) * 10_000n <= position.price * (10_000n - position.stopBps)
                ? 'STOP'
                : marked !== null && dayStart - marked >= 1_000n * micros
                  ? 'DAILY_LOSS'
                  : at >= position.enteredAt + policy.holdingMinutes * minuteMs
                    ? 'HORIZON'
                    : null
          if (reason === null) continue
          let exit: EquityScreenBar | undefined
          for (let delta = 0; delta <= 3; delta++) {
            const time = at + delta * minuteMs
            if (time >= day.closeAt) break
            exit = index.get(position.symbol)?.get(time)
            if (exit !== undefined) break
          }
          if (exit === undefined) {
            incomplete = { date: day.date, symbol: position.symbol, reason: 'MISSING_EXIT_BAR' }
            break
          }
          const price = priceMicros(exit.open, false, policy.adverseBpsPerSide)
          const exitFees = yield* fee(position.symbol, false, position.shares, price)
          sessionFills.push(feeInput(position.symbol, false, position.shares, price))
          sessionFees += exitFees
          const gross = position.shares * (price - position.price)
          const fees = position.entryFees + exitFees
          trades.push({
            symbol: position.symbol,
            shares: Number(position.shares),
            signalAt: position.signalAt,
            entryAt: position.enteredAt,
            exitAt: exit.at,
            entryPriceMicros: position.price.toString(),
            exitPriceMicros: price.toString(),
            grossPnlMicros: gross.toString(),
            feesMicros: fees.toString(),
            executionNetPnlMicros: (gross - fees).toString(),
            exitReason: reason,
          })
          cash += position.shares * price - exitFees
          turnover += position.shares * price
          position = null
          notBefore = exit.at + minuteMs
          peak = cash > peak ? cash : peak
          drawdown = peak - cash > drawdown ? peak - cash : drawdown
        }
        const elapsed = (at - day.openAt) / minuteMs
        if (
          position !== null ||
          at < notBefore ||
          elapsed % (early ? 1 : 5) !== 0 ||
          elapsed > (early ? 30 : 210) ||
          (early && trades.length > tradeStart) ||
          at >= closeAt ||
          dayStart - cash >= 1_000n * micros
        )
          continue
        const benchmarkMinutes = early ? Math.min(30, elapsed) : 30
        if (window(index, 'SPY', at - benchmarkMinutes * minuteMs, benchmarkMinutes) === null) {
          incomplete = { date: day.date, symbol: 'SPY', reason: 'MISSING_BENCHMARK_BAR' }
          break
        }
        const { candidates, exclusions } = equityScreenCandidates(index, symbols, days, dayIndex, at, policy.signal)
        candidateExclusions.push(...exclusions)
        const candidate = candidates[0]
        if (candidate === undefined) {
          noCandidate++
          continue
        }
        const riskCount = early ? Math.min(30, elapsed) : 30
        const riskBars = window(index, candidate.symbol, at - riskCount * minuteMs, riskCount)
        if (riskBars === null) continue
        const signalBar = riskBars.at(-1)
        if (signalBar === undefined) continue
        const sizingPrice = priceMicros(signalBar.close, true, policy.adverseBpsPerSide)
        const stopBps = BigInt(
          policy.volatilityRisk === true
            ? Math.max(50, Math.min(200, Math.ceil(2 * volatilityBps(riskBars) * Math.sqrt(policy.holdingMinutes))))
            : 50,
        )
        const capitalAllocation = (cash * 2000n) / 10_000n
        const riskAllocation = (cash * 10n) / stopBps
        const allocation =
          policy.volatilityRisk === true && riskAllocation < capitalAllocation ? riskAllocation : capitalAllocation
        // Total buy cost is monotone in whole shares. Search without mutating the accepted session-fee prefix.
        let shares = 0n
        let upper = allocation / sizingPrice
        while (shares < upper) {
          const proposed = (shares + upper + 1n) / 2n
          const proposedFees = yield* fee(candidate.symbol, true, proposed, sizingPrice)
          if (proposed * sizingPrice + proposedFees <= allocation) shares = proposed
          else upper = proposed - 1n
        }
        if (shares <= 0n) continue
        const entry = index.get(candidate.symbol)?.get(at + minuteMs)
        if (entry === undefined) {
          missingArrivalBars++
          incomplete = { date: day.date, symbol: candidate.symbol, reason: 'MISSING_ENTRY_BAR' }
          break
        }
        if (entry.at >= closeAt) continue
        const price = priceMicros(entry.open, true, policy.adverseBpsPerSide)
        const entryFees = yield* fee(candidate.symbol, true, shares, price)
        if (shares * price + entryFees > allocation) {
          entryBudgetRejections++
          continue
        }
        if (shares <= 0n || turnover + shares * price * 2n > 1_000_000n * micros) continue
        sessionFills.push(feeInput(candidate.symbol, true, shares, price))
        sessionFees += entryFees
        position = {
          symbol: candidate.symbol,
          shares,
          cost: shares * price,
          entryFees,
          price,
          enteredAt: entry.at,
          signalAt: at,
          stopBps,
        }
        cash -= position.cost + entryFees
        turnover += position.cost
      }
      if (position !== null && incomplete === null)
        incomplete = { date: day.date, symbol: position.symbol, reason: 'RESIDUAL_POSITION' }
      if (incomplete !== null) break
      sessions.push({
        date: day.date,
        netPnlMicros: (cash - dayStart).toString(),
        trades: trades.length - tradeStart,
        noCandidateDecisions: noCandidate,
        missingArrivalBars,
        entryBudgetRejections,
        feesMicros: sessionFees.toString(),
      })
    }
    const expected = days.filter((day) => day.date >= from && day.date <= through).length
    return {
      definition: equityScreenDefinition,
      riskDefinition: policy.volatilityRisk === true ? equityRiskScreenDefinition : null,
      earlyDefinition: early ? equityEarlyScreenDefinition : null,
      policy,
      status: incomplete === null && expected > 0 ? 'COMPLETED' : 'INCOMPLETE',
      incomplete,
      expectedSessions: expected,
      sessions,
      trades,
      candidateExclusions,
      executionNetPnlMicros: incomplete === null && expected > 0 ? (cash - initialCapital).toString() : null,
      maximumMarkedDrawdownMicros: drawdown.toString(),
      markedDrawdownCoverage: 'OBSERVED_BAR_CLOSES_ONLY',
      unknownMarkedMinutes,
      allInProfit: null,
      profitabilityQualified: false,
    }
  })
