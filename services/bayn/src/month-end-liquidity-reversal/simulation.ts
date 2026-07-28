import { Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import type { DailyBar, IsoDate } from '../types'
import { makeCandidate6Decision } from './decision'
import { type Candidate6Decision, type Candidate6DecisionFailure, type Candidate6Protocol } from './model'

export const CANDIDATE_6_INITIAL_CAPITAL_USD = 1_000_000
export const CANDIDATE_6_SESSIONS_PER_YEAR = 252

export type Candidate6SimulationFailure =
  | Candidate6DecisionFailure
  | { readonly _tag: 'InvalidResearchCostMultiplier'; readonly costMultiplier: number }
  | { readonly _tag: 'ResearchSimulationInvariant'; readonly reason: string }
  | {
      readonly _tag: 'ResearchHashFailure'
      readonly operation: 'partial-fill' | 'protocol' | 'development-report'
      readonly cause: CanonicalHashFailure
    }

export interface Candidate6PerformanceMetrics {
  readonly totalReturn: number
  readonly annualizedReturn: number
  readonly annualizedVolatility: number
  readonly sharpe: number
  readonly maximumDrawdown: number
  readonly annualTurnover: number
  readonly averageGrossExposure: number
  readonly maximumGrossExposure: number
  readonly observationCount: number
  readonly entryCount: number
  readonly orderCount: number
  readonly partialFillCount: number
  readonly modeledCostUsd: number
}

export interface Candidate6DailyObservation {
  readonly sessionDate: IsoDate
  readonly dailyReturn: number | null
  readonly equityUsd: number
  readonly grossExposure: number
  readonly spyAnnualizedVolatility: number | null
  readonly turnoverFraction: number
  readonly entryCount: number
  readonly orderCount: number
  readonly partialFillCount: number
  readonly modeledCostUsd: number
}

export interface Candidate6SimulationOutcome {
  readonly metrics: Candidate6PerformanceMetrics
  readonly observations: readonly Candidate6DailyObservation[]
}

interface PendingDecision {
  readonly decision: Candidate6Decision
  readonly targetWeight: number
}

interface FillOutcome {
  readonly cashUsd: number
  readonly shares: number
  readonly turnoverFraction: number
  readonly modeledCostUsd: number
  readonly partial: boolean
}

type SimulationResult<A> = Result.Result<A, Candidate6SimulationFailure>

const fail = <A>(failure: Candidate6SimulationFailure): SimulationResult<A> => Result.fail(failure)

export const candidate6Mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

export const candidate6SampleStandardDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0
  const average = candidate6Mean(values)
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export const candidate6Quantile = (values: readonly number[], probability: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const lowerValue = sorted[lower] ?? 0
  const upperValue = sorted[upper] ?? lowerValue
  return lowerValue + (upperValue - lowerValue) * (position - lower)
}

export const candidate6Metrics = (
  observations: readonly Candidate6DailyObservation[],
): Candidate6PerformanceMetrics => {
  const selected = observations.filter(
    (observation): observation is Candidate6DailyObservation & { readonly dailyReturn: number } =>
      observation.dailyReturn !== null,
  )
  const returns = selected.map((observation) => observation.dailyReturn)
  const growth = returns.reduce((value, dailyReturn) => value * (1 + dailyReturn), 1)
  const years = returns.length / CANDIDATE_6_SESSIONS_PER_YEAR
  const annualizedVolatility = candidate6SampleStandardDeviation(returns) * Math.sqrt(CANDIDATE_6_SESSIONS_PER_YEAR)
  let path = 1
  let peak = 1
  let maximumDrawdown = 0
  for (const dailyReturn of returns) {
    path *= 1 + dailyReturn
    peak = Math.max(peak, path)
    maximumDrawdown = Math.max(maximumDrawdown, 1 - path / peak)
  }
  return {
    totalReturn: growth - 1,
    annualizedReturn: years > 0 && growth > 0 ? growth ** (1 / years) - 1 : 0,
    annualizedVolatility,
    sharpe:
      annualizedVolatility > 0 ? (candidate6Mean(returns) * CANDIDATE_6_SESSIONS_PER_YEAR) / annualizedVolatility : 0,
    maximumDrawdown,
    annualTurnover:
      years > 0 ? observations.reduce((sum, observation) => sum + observation.turnoverFraction, 0) / years : 0,
    averageGrossExposure: candidate6Mean(observations.map((observation) => observation.grossExposure)),
    maximumGrossExposure: Math.max(0, ...observations.map((observation) => observation.grossExposure)),
    observationCount: returns.length,
    entryCount: observations.reduce((sum, observation) => sum + observation.entryCount, 0),
    orderCount: observations.reduce((sum, observation) => sum + observation.orderCount, 0),
    partialFillCount: observations.reduce((sum, observation) => sum + observation.partialFillCount, 0),
    modeledCostUsd: observations.reduce((sum, observation) => sum + observation.modeledCostUsd, 0),
  }
}

export const candidate6SubsetMetrics = (
  observations: readonly Candidate6DailyObservation[],
  predicate: (observation: Candidate6DailyObservation) => boolean,
): Candidate6PerformanceMetrics => candidate6Metrics(observations.filter(predicate))

const partialFillFraction = (
  decision: Candidate6Decision,
  protocol: Candidate6Protocol,
  includePartialFills: boolean,
): SimulationResult<number> => {
  if (!includePartialFills) return Result.succeed(1)
  const hash = canonicalHashV1Result({
    schemaVersion: 'bayn.candidate-6-partial-fill.v1',
    signalDate: decision.signalDate,
    executionDate: decision.executionDate,
    action: decision.action,
  })
  if (Result.isFailure(hash)) {
    return fail({ _tag: 'ResearchHashFailure', operation: 'partial-fill', cause: hash.failure })
  }
  const bucket = Number.parseInt(hash.success.slice(0, 12), 16) / 0xffffffffffff
  return Result.succeed(bucket < protocol.execution.partialFillProbability ? protocol.execution.partialFillFraction : 1)
}

const executeTarget = (
  cashUsd: number,
  shares: number,
  openPrice: number,
  pending: PendingDecision,
  protocol: Candidate6Protocol,
  costMultiplier: number,
  includePartialFills: boolean,
): SimulationResult<FillOutcome> => {
  const equityAtOpen = cashUsd + shares * openPrice
  const currentNotional = shares * openPrice
  const desiredNotional = pending.targetWeight * equityAtOpen
  const referenceNotionalDelta = desiredNotional - currentNotional
  if (Math.abs(referenceNotionalDelta) < 0.01) {
    return Result.succeed({ cashUsd, shares, turnoverFraction: 0, modeledCostUsd: 0, partial: false })
  }
  const fractionResult = partialFillFraction(pending.decision, protocol, includePartialFills)
  if (Result.isFailure(fractionResult)) return fail(fractionResult.failure)
  const fraction = fractionResult.success
  const oneWayBps = (protocol.execution.halfSpreadBps + protocol.execution.slippageBps) * costMultiplier
  const priceAdjustment = oneWayBps / 10_000
  if (referenceNotionalDelta > 0) {
    const requestedQuantity = (referenceNotionalDelta / openPrice) * fraction
    const fillPrice = openPrice * (1 + priceAdjustment)
    const maximumQuantity = cashUsd / fillPrice
    const quantity = Math.max(0, Math.min(requestedQuantity, maximumQuantity))
    const referenceNotional = quantity * openPrice
    return Result.succeed({
      cashUsd: cashUsd - quantity * fillPrice,
      shares: shares + quantity,
      turnoverFraction: equityAtOpen > 0 ? referenceNotional / equityAtOpen : 0,
      modeledCostUsd: quantity * (fillPrice - openPrice),
      partial: fraction < 1,
    })
  }
  const requestedQuantity = Math.min(shares, (-referenceNotionalDelta / openPrice) * fraction)
  const fillPrice = openPrice * Math.max(0, 1 - priceAdjustment)
  const referenceNotional = requestedQuantity * openPrice
  const secFee = referenceNotional * ((protocol.execution.secSellBps * costMultiplier) / 10_000)
  const tafFee = Math.min(
    protocol.execution.tafMaximumPerOrderUsd * costMultiplier,
    requestedQuantity * protocol.execution.tafSellPerShareUsd * costMultiplier,
  )
  const catFee = requestedQuantity * protocol.execution.catPerShareUsd * costMultiplier
  const fees = secFee + tafFee + catFee
  return Result.succeed({
    cashUsd: cashUsd + requestedQuantity * fillPrice - fees,
    shares: Math.max(0, shares - requestedQuantity),
    turnoverFraction: equityAtOpen > 0 ? referenceNotional / equityAtOpen : 0,
    modeledCostUsd: requestedQuantity * (openPrice - fillPrice) + fees,
    partial: fraction < 1,
  })
}

const rollingSpyVolatility = (bars: readonly DailyBar[], index: number): number | null => {
  if (index < 20) return null
  const returns: number[] = []
  for (let cursor = index - 19; cursor <= index; cursor += 1) {
    const current = bars[cursor]
    const prior = bars[cursor - 1]
    if (current === undefined || prior === undefined) return null
    returns.push(current.close / prior.close - 1)
  }
  return candidate6SampleStandardDeviation(returns) * Math.sqrt(CANDIDATE_6_SESSIONS_PER_YEAR)
}

export const simulateCandidate6 = (
  calendar: readonly IsoDate[],
  bars: readonly DailyBar[],
  simulationStart: IsoDate,
  protocol: Candidate6Protocol,
  costMultiplier: number,
  includePartialFills: boolean,
): SimulationResult<Candidate6SimulationOutcome> => {
  if (!Number.isFinite(costMultiplier) || costMultiplier < 0) {
    return fail({ _tag: 'InvalidResearchCostMultiplier', costMultiplier })
  }
  const firstSimulationIndex = calendar.indexOf(simulationStart)
  if (firstSimulationIndex < 20) {
    return fail({ _tag: 'ResearchSimulationInvariant', reason: 'simulation start lacks twenty prior sessions' })
  }
  let cashUsd = CANDIDATE_6_INITIAL_CAPITAL_USD
  let shares = 0
  let activeEntrySignalDate: IsoDate | null = null
  let pending: PendingDecision | null = null
  let previousEquityUsd: number | null = CANDIDATE_6_INITIAL_CAPITAL_USD
  const observations: Candidate6DailyObservation[] = []

  for (let index = firstSimulationIndex; index < calendar.length; index += 1) {
    const bar = bars[index]
    const sessionDate = calendar[index]
    if (bar === undefined || sessionDate === undefined || bar.sessionDate !== sessionDate) {
      return fail({ _tag: 'ResearchSimulationInvariant', reason: `bar/calendar mismatch at ${String(index)}` })
    }
    let turnoverFraction = 0
    let entryCount = 0
    let orderCount = 0
    let partialFillCount = 0
    let modeledCostUsd = 0
    if (pending !== null && pending.decision.executionDate === sessionDate) {
      const fill = executeTarget(cashUsd, shares, bar.open, pending, protocol, costMultiplier, includePartialFills)
      if (Result.isFailure(fill)) return fail(fill.failure)
      cashUsd = fill.success.cashUsd
      shares = fill.success.shares
      turnoverFraction = fill.success.turnoverFraction
      modeledCostUsd = fill.success.modeledCostUsd
      orderCount = 1
      partialFillCount = fill.success.partial ? 1 : 0
      if (pending.decision.action === 'enter' && shares > 0) {
        activeEntrySignalDate = pending.decision.signalDate
        entryCount = 1
      } else if (pending.decision.action === 'exit' && shares * bar.open < 0.01) {
        shares = 0
        activeEntrySignalDate = null
      }
      pending = null
    }
    const equityUsd = cashUsd + shares * bar.close
    if (!Number.isFinite(equityUsd) || equityUsd <= 0) {
      return fail({ _tag: 'ResearchSimulationInvariant', reason: `non-positive equity on ${sessionDate}` })
    }
    const grossExposure = (shares * bar.close) / equityUsd
    observations.push({
      sessionDate,
      dailyReturn: previousEquityUsd === null ? null : equityUsd / previousEquityUsd - 1,
      equityUsd,
      grossExposure,
      spyAnnualizedVolatility: rollingSpyVolatility(bars, index),
      turnoverFraction,
      entryCount,
      orderCount,
      partialFillCount,
      modeledCostUsd,
    })
    previousEquityUsd = equityUsd
    const executionDate = calendar[index + 1]
    if (executionDate === undefined) continue
    const decisionResult = makeCandidate6Decision({
      signalDate: sessionDate,
      executionDate,
      publicationAsOf: sessionDate,
      calendar,
      bars: bars.slice(Math.max(0, index - 19), index + 1),
      position: { activeEntrySignalDate, currentWeights: { SPY: grossExposure } },
      portfolioEquityUsd: equityUsd,
      finalizedAtEpochMilliseconds: 1_500_000_000_000 + index * 86_400_000,
      observedAtEpochMilliseconds: 1_500_000_060_000 + index * 86_400_000,
      protocol,
    })
    if (Result.isFailure(decisionResult)) return fail(decisionResult.failure)
    if (decisionResult.success.orderIntents.length > 0) {
      pending = {
        decision: decisionResult.success,
        targetWeight: decisionResult.success.targetWeights.SPY,
      }
    }
  }
  if (pending !== null) {
    return fail({
      _tag: 'ResearchSimulationInvariant',
      reason: `simulation ended before pending ${pending.decision.action} executed on ${pending.decision.executionDate}`,
    })
  }
  if (activeEntrySignalDate !== null || shares > 0) {
    return fail({
      _tag: 'ResearchSimulationInvariant',
      reason: `simulation ended with open event from ${activeEntrySignalDate ?? 'unknown'}`,
    })
  }
  return Result.succeed({ metrics: candidate6Metrics(observations), observations })
}

export const simulateCandidate6BuyAndHold = (
  calendar: readonly IsoDate[],
  bars: readonly DailyBar[],
  simulationStart: IsoDate,
): SimulationResult<Candidate6SimulationOutcome> => {
  const start = calendar.indexOf(simulationStart)
  const startBar = bars[start]
  if (start < 0 || startBar === undefined || startBar.sessionDate !== simulationStart || startBar.open <= 0) {
    return fail({ _tag: 'ResearchSimulationInvariant', reason: 'invalid buy-and-hold simulation start' })
  }
  for (let index = start; index < bars.length; index += 1) {
    const bar = bars[index]
    if (bar === undefined || bar.sessionDate !== calendar[index] || !Number.isFinite(bar.close) || bar.close <= 0) {
      return fail({ _tag: 'ResearchSimulationInvariant', reason: `invalid buy-and-hold bar at ${String(index)}` })
    }
  }
  const startPrice = startBar.open
  const shares = CANDIDATE_6_INITIAL_CAPITAL_USD / startPrice
  let previousEquityUsd: number | null = CANDIDATE_6_INITIAL_CAPITAL_USD
  const observations = bars.slice(start).map((bar, offset): Candidate6DailyObservation => {
    const equityUsd = shares * bar.close
    const observation = {
      sessionDate: calendar[start + offset] ?? bar.sessionDate,
      dailyReturn: previousEquityUsd === null ? null : equityUsd / previousEquityUsd - 1,
      equityUsd,
      grossExposure: 1,
      spyAnnualizedVolatility: rollingSpyVolatility(bars, start + offset),
      turnoverFraction: offset === 0 ? 1 : 0,
      entryCount: offset === 0 ? 1 : 0,
      orderCount: offset === 0 ? 1 : 0,
      partialFillCount: 0,
      modeledCostUsd: 0,
    }
    previousEquityUsd = equityUsd
    return observation
  })
  return Result.succeed({ metrics: candidate6Metrics(observations), observations })
}
