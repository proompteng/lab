import { Result } from 'effect'

import type { DailyBar, IsoDate } from '../types'
import {
  CANDIDATE_6_ORDINAL,
  CANDIDATE_6_STRATEGY_NAME,
  CANDIDATE_6_SYMBOL,
  candidate6Protocol,
  type Candidate6Decision,
  type Candidate6DecisionFailure,
  type Candidate6DecisionInput,
  type Candidate6OrderIntent,
  type Candidate6PressureFeature,
  type Candidate6Protocol,
} from './model'

const WEIGHT_EPSILON = 1e-12

type DecisionResult<A> = Result.Result<A, Candidate6DecisionFailure>

const fail = <A>(failure: Candidate6DecisionFailure): DecisionResult<A> => Result.fail(failure)

const isFinitePositive = (value: number): boolean => Number.isFinite(value) && value > 0

const validateProtocol = (protocol: Candidate6Protocol): DecisionResult<Candidate6Protocol> => {
  const numericFields = [
    ['signal.expectedReversionFraction', protocol.signal.expectedReversionFraction],
    ['sizing.targetWeight', protocol.sizing.targetWeight],
    ['sizing.maximumSymbolWeight', protocol.sizing.maximumSymbolWeight],
    ['sizing.maximumGrossExposure', protocol.sizing.maximumGrossExposure],
    ['sizing.maximumOneWayTurnover', protocol.sizing.maximumOneWayTurnover],
    ['sizing.minimumAverageDollarVolumeUsd', protocol.sizing.minimumAverageDollarVolumeUsd],
    ['sizing.maximumAverageDailyVolumeParticipation', protocol.sizing.maximumAverageDailyVolumeParticipation],
    ['execution.halfSpreadBps', protocol.execution.halfSpreadBps],
    ['execution.slippageBps', protocol.execution.slippageBps],
    ['execution.costBufferMultiplier', protocol.execution.costBufferMultiplier],
  ] as const

  for (const [field, value] of numericFields) {
    if (!isFinitePositive(value)) return fail({ _tag: 'InvalidProtocol', field, value })
  }
  if (
    protocol.sizing.targetWeight > protocol.sizing.maximumSymbolWeight ||
    protocol.sizing.targetWeight > protocol.sizing.maximumGrossExposure ||
    protocol.sizing.targetWeight > protocol.sizing.maximumOneWayTurnover
  ) {
    return fail({ _tag: 'InvalidProtocol', field: 'sizing.targetWeight', value: protocol.sizing.targetWeight })
  }
  if (protocol.signal.expectedReversionFraction > 1) {
    return fail({
      _tag: 'InvalidProtocol',
      field: 'signal.expectedReversionFraction',
      value: protocol.signal.expectedReversionFraction,
    })
  }
  return Result.succeed(protocol)
}

const validateCalendar = (
  calendar: readonly IsoDate[],
  signalDate: IsoDate,
  executionDate: IsoDate,
): DecisionResult<number> => {
  const unique = new Set(calendar)
  if (unique.size !== calendar.length) return fail({ _tag: 'InvalidCalendar', reason: 'duplicate' })
  for (let index = 1; index < calendar.length; index += 1) {
    if ((calendar[index - 1] ?? '') >= (calendar[index] ?? '')) {
      return fail({ _tag: 'InvalidCalendar', reason: 'not-sorted' })
    }
  }
  const signalIndex = calendar.indexOf(signalDate)
  if (signalIndex < 0) return fail({ _tag: 'InvalidCalendar', reason: 'signal-missing' })
  const expected = calendar[signalIndex + 1] ?? null
  return expected === executionDate
    ? Result.succeed(signalIndex)
    : fail({ _tag: 'InvalidExecutionSession', expected, observed: executionDate })
}

const validateTimes = (finalizedAt: number, observedAt: number, protocol: Candidate6Protocol): DecisionResult<void> => {
  if (!Number.isSafeInteger(finalizedAt) || !Number.isSafeInteger(observedAt) || observedAt < finalizedAt) {
    return fail({ _tag: 'InvalidObservationTime', finalizedAt, observedAt })
  }
  const lagMilliseconds = observedAt - finalizedAt
  return lagMilliseconds <= protocol.marketData.maximumFinalizationLagMilliseconds
    ? Result.succeed(undefined)
    : fail({
        _tag: 'StaleFinalization',
        lagMilliseconds,
        maximum: protocol.marketData.maximumFinalizationLagMilliseconds,
      })
}

const validateBar = (bar: DailyBar, protocol: Candidate6Protocol): DecisionResult<DailyBar> => {
  for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
    const value = bar[field]
    const valid = field === 'volume' ? Number.isFinite(value) && value >= 0 : isFinitePositive(value)
    if (!valid) return fail({ _tag: 'MalformedBar', sessionDate: bar.sessionDate, field, value })
  }
  if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high) {
    return fail({ _tag: 'MalformedBar', sessionDate: bar.sessionDate, field: 'range', value: bar.high - bar.low })
  }
  if (bar.adjustment !== protocol.marketData.adjustment) {
    return fail({
      _tag: 'UnexpectedCorporateActionPolicy',
      sessionDate: bar.sessionDate,
      observed: bar.adjustment,
    })
  }
  if (bar.source !== protocol.marketData.source) {
    return fail({ _tag: 'UnexpectedMarketDataSource', sessionDate: bar.sessionDate, observed: bar.source })
  }
  if (bar.sourceFeed !== protocol.marketData.sourceFeed) {
    return fail({ _tag: 'UnexpectedMarketDataFeed', sessionDate: bar.sessionDate, observed: bar.sourceFeed })
  }
  if (bar.publicationSchemaVersion !== protocol.marketData.publicationSchemaVersion) {
    return fail({
      _tag: 'UnexpectedPublicationSchema',
      sessionDate: bar.sessionDate,
      observed: bar.publicationSchemaVersion,
    })
  }
  return Result.succeed(bar)
}

const prepareBars = (
  bars: readonly DailyBar[],
  signalDate: IsoDate,
  protocol: Candidate6Protocol,
): DecisionResult<ReadonlyMap<IsoDate, DailyBar>> => {
  const seen = new Set<string>()
  const selected = new Map<IsoDate, DailyBar>()
  for (const bar of bars) {
    if (bar.sessionDate > signalDate) {
      return fail({ _tag: 'FutureBar', sessionDate: bar.sessionDate, signalDate })
    }
    const key = `${bar.symbol}\u001f${bar.sessionDate}`
    if (seen.has(key)) return fail({ _tag: 'DuplicateBar', symbol: bar.symbol, sessionDate: bar.sessionDate })
    seen.add(key)
    const validated = validateBar(bar, protocol)
    if (Result.isFailure(validated)) return fail(validated.failure)
    if (bar.symbol === CANDIDATE_6_SYMBOL) selected.set(bar.sessionDate, bar)
  }
  return Result.succeed(selected)
}

const remainingSessionsInMonth = (calendar: readonly IsoDate[], signalIndex: number): number => {
  const month = (calendar[signalIndex] ?? '').slice(0, 7)
  let remaining = 0
  for (let index = signalIndex + 1; index < calendar.length; index += 1) {
    if ((calendar[index] ?? '').slice(0, 7) !== month) break
    remaining += 1
  }
  return remaining
}

const requiredHistory = (
  calendar: readonly IsoDate[],
  signalIndex: number,
  bars: ReadonlyMap<IsoDate, DailyBar>,
  protocol: Candidate6Protocol,
): DecisionResult<readonly DailyBar[]> => {
  const requiredCount = Math.max(protocol.sizing.liquidityWindowSessions, protocol.signal.pressureLookbackSessions + 1)
  if (signalIndex + 1 < requiredCount) {
    return fail({ _tag: 'InsufficientHistory', required: requiredCount, observed: signalIndex + 1 })
  }
  const requiredDates = calendar.slice(signalIndex + 1 - requiredCount, signalIndex + 1)
  const history: DailyBar[] = []
  for (const date of requiredDates) {
    const bar = bars.get(date)
    if (bar === undefined) return fail({ _tag: 'MissingBar', sessionDate: date })
    history.push(bar)
  }
  return Result.succeed(history)
}

const pressureFeature = (
  history: readonly DailyBar[],
  portfolioEquityUsd: number,
  protocol: Candidate6Protocol,
): DecisionResult<Candidate6PressureFeature> => {
  const last = history.at(-1)
  const first = history.at(-(protocol.signal.pressureLookbackSessions + 1))
  if (last === undefined || first === undefined) {
    return fail({
      _tag: 'InsufficientHistory',
      required: protocol.signal.pressureLookbackSessions + 1,
      observed: history.length,
    })
  }
  const liquidityBars = history.slice(-protocol.sizing.liquidityWindowSessions)
  const averageDollarVolumeUsd =
    liquidityBars.reduce((sum, bar) => sum + bar.close * bar.volume, 0) / liquidityBars.length
  if (averageDollarVolumeUsd < protocol.sizing.minimumAverageDollarVolumeUsd) {
    return fail({
      _tag: 'InsufficientLiquidity',
      averageDollarVolumeUsd,
      minimumAverageDollarVolumeUsd: protocol.sizing.minimumAverageDollarVolumeUsd,
    })
  }
  const pressureReturn = last.close / first.close - 1
  const oneWayCostBps = protocol.execution.halfSpreadBps + protocol.execution.slippageBps
  const bufferedRoundTripCost = ((2 * oneWayCostBps) / 10_000) * protocol.execution.costBufferMultiplier
  const expectedGrossReversion = Math.max(0, -pressureReturn * protocol.signal.expectedReversionFraction)
  const liquidityWeightCap =
    (averageDollarVolumeUsd * protocol.sizing.maximumAverageDailyVolumeParticipation) / portfolioEquityUsd
  return Result.succeed({
    symbol: CANDIDATE_6_SYMBOL,
    firstSession: first.sessionDate,
    lastSession: last.sessionDate,
    pressureReturn,
    expectedGrossReversion,
    bufferedRoundTripCost,
    netExpectedReversion: expectedGrossReversion - bufferedRoundTripCost,
    averageDollarVolumeUsd,
    liquidityWeightCap,
  })
}

const orderIntents = (
  fromWeight: number,
  toWeight: number,
  portfolioEquityUsd: number,
  reason: Candidate6OrderIntent['reason'],
): readonly Candidate6OrderIntent[] => {
  const weightDelta = toWeight - fromWeight
  if (Math.abs(weightDelta) <= WEIGHT_EPSILON) return []
  return [
    {
      symbol: CANDIDATE_6_SYMBOL,
      side: weightDelta > 0 ? 'buy' : 'sell',
      fromWeight,
      toWeight,
      weightDelta,
      maximumNotionalUsd: Math.abs(weightDelta) * portfolioEquityUsd,
      reason,
    },
  ]
}

const decision = (
  input: Candidate6DecisionInput,
  protocol: Candidate6Protocol,
  action: Candidate6Decision['action'],
  reason: Candidate6Decision['reason'],
  targetWeight: number,
  feature: Candidate6PressureFeature | null,
  intentReason: Candidate6OrderIntent['reason'] | null,
): DecisionResult<Candidate6Decision> => {
  const currentWeight = input.position.currentWeights.SPY
  const grossExposure = Math.abs(targetWeight)
  const oneWayTurnover = Math.abs(targetWeight - currentWeight)
  if (
    grossExposure > protocol.sizing.maximumGrossExposure + WEIGHT_EPSILON ||
    targetWeight > protocol.sizing.maximumSymbolWeight + WEIGHT_EPSILON ||
    oneWayTurnover > protocol.sizing.maximumOneWayTurnover + WEIGHT_EPSILON
  ) {
    return fail({
      _tag: 'InvalidProtocol',
      field: 'decision.constraint',
      value: Math.max(grossExposure, oneWayTurnover),
    })
  }
  return Result.succeed({
    schemaVersion: 'bayn.month-end-liquidity-reversal.decision.v1',
    candidateOrdinal: CANDIDATE_6_ORDINAL,
    strategyName: CANDIDATE_6_STRATEGY_NAME,
    signalDate: input.signalDate,
    executionDate: input.executionDate,
    action,
    reason,
    targetWeights: { SPY: targetWeight },
    feature,
    orderIntents:
      intentReason === null ? [] : orderIntents(currentWeight, targetWeight, input.portfolioEquityUsd, intentReason),
    constraints: {
      grossExposure,
      oneWayTurnover,
      maximumGrossExposure: protocol.sizing.maximumGrossExposure,
      maximumOneWayTurnover: protocol.sizing.maximumOneWayTurnover,
      maximumSymbolWeight: protocol.sizing.maximumSymbolWeight,
    },
  })
}

export const makeCandidate6Decision = (input: Candidate6DecisionInput): DecisionResult<Candidate6Decision> => {
  const protocol = input.protocol ?? candidate6Protocol
  const protocolResult = validateProtocol(protocol)
  if (Result.isFailure(protocolResult)) return fail(protocolResult.failure)
  if (!isFinitePositive(input.portfolioEquityUsd)) {
    return fail({ _tag: 'InvalidPortfolioEquity', portfolioEquityUsd: input.portfolioEquityUsd })
  }
  const currentWeight = input.position.currentWeights.SPY
  if (!Number.isFinite(currentWeight) || currentWeight < 0 || currentWeight > 1) {
    return fail({ _tag: 'InvalidCurrentWeight', weight: currentWeight })
  }
  const timeResult = validateTimes(input.finalizedAtEpochMilliseconds, input.observedAtEpochMilliseconds, protocol)
  if (Result.isFailure(timeResult)) return fail(timeResult.failure)
  if (input.publicationAsOf !== input.signalDate) {
    return fail({
      _tag: 'PublicationSessionMismatch',
      expected: input.signalDate,
      observed: input.publicationAsOf,
    })
  }
  const calendarResult = validateCalendar(input.calendar, input.signalDate, input.executionDate)
  if (Result.isFailure(calendarResult)) return fail(calendarResult.failure)
  const signalIndex = calendarResult.success
  const calendarExcluded = protocol.signal.calendarExclusions.some(
    (exclusion) =>
      (input.signalDate >= exclusion.start && input.signalDate <= exclusion.end) ||
      (input.executionDate >= exclusion.start && input.executionDate <= exclusion.end),
  )
  if (calendarExcluded) {
    return input.position.currentWeights.SPY > WEIGHT_EPSILON
      ? decision(input, protocol, 'exit', 'calendar-exclusion', 0, null, 'calendar-exclusion-exit')
      : decision(input, protocol, 'cash', 'calendar-exclusion', 0, null, null)
  }
  const barsResult = prepareBars(input.bars, input.signalDate, protocol)
  if (Result.isFailure(barsResult)) return fail(barsResult.failure)

  const activeEntrySignalDate = input.position.activeEntrySignalDate
  if (activeEntrySignalDate !== null) {
    const entryIndex = input.calendar.indexOf(activeEntrySignalDate)
    if (
      entryIndex < 0 ||
      remainingSessionsInMonth(input.calendar, entryIndex) !== protocol.signal.signalSessionsBeforeMonthEnd
    ) {
      return fail({ _tag: 'UnknownActiveEntry', activeEntrySignalDate })
    }
    const exitSignalIndex =
      entryIndex + protocol.signal.signalSessionsBeforeMonthEnd + protocol.signal.exitSessionsAfterMonthEnd
    if (signalIndex < exitSignalIndex) {
      const cappedWeight = Math.min(
        currentWeight,
        protocol.sizing.maximumSymbolWeight,
        protocol.sizing.maximumGrossExposure,
      )
      const requiresTrim = cappedWeight < currentWeight - WEIGHT_EPSILON
      return decision(
        input,
        protocol,
        'hold',
        requiresTrim ? 'exposure-cap-trim' : 'active-hold-window',
        cappedWeight,
        null,
        requiresTrim ? 'exposure-cap-trim' : null,
      )
    }
    const scheduled = signalIndex === exitSignalIndex
    return decision(
      input,
      protocol,
      'exit',
      scheduled ? 'scheduled-exit' : 'overdue-exit',
      0,
      null,
      scheduled ? 'scheduled-reversal-exit' : 'overdue-risk-exit',
    )
  }

  if (currentWeight > WEIGHT_EPSILON) return fail({ _tag: 'UnboundExposure', weight: currentWeight })
  if (remainingSessionsInMonth(input.calendar, signalIndex) !== protocol.signal.signalSessionsBeforeMonthEnd) {
    return decision(input, protocol, 'cash', 'outside-entry-window', 0, null, null)
  }
  const historyResult = requiredHistory(input.calendar, signalIndex, barsResult.success, protocol)
  if (Result.isFailure(historyResult)) return fail(historyResult.failure)
  const featureResult = pressureFeature(historyResult.success, input.portfolioEquityUsd, protocol)
  if (Result.isFailure(featureResult)) return fail(featureResult.failure)
  const feature = featureResult.success
  if (feature.netExpectedReversion <= 0) {
    return decision(input, protocol, 'cash', 'cost-exceeds-expected-reversion', 0, feature, null)
  }
  const targetWeight = Math.min(
    protocol.sizing.targetWeight,
    protocol.sizing.maximumSymbolWeight,
    protocol.sizing.maximumGrossExposure,
    protocol.sizing.maximumOneWayTurnover,
    feature.liquidityWeightCap,
  )
  return decision(input, protocol, 'enter', 'entry-signal', targetWeight, feature, 'month-end-pressure-entry')
}

export const candidate6RequiredPressureReturn = (protocol: Candidate6Protocol = candidate6Protocol): number => {
  const oneWayCostBps = protocol.execution.halfSpreadBps + protocol.execution.slippageBps
  const bufferedRoundTripCost = ((2 * oneWayCostBps) / 10_000) * protocol.execution.costBufferMultiplier
  return -(bufferedRoundTripCost / protocol.signal.expectedReversionFraction)
}
