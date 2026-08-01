import { pipe, Result } from 'effect'
import { type CandidateDevelopmentPreflightInput } from '../candidate-development'
import { elapsedCalendarDays, referencePriceMicros } from '../execution-model'
import { type AlignedSession } from '../simulation'
import { type EvaluationResult } from '../types'
import type { CandidateDevelopmentCommandFailure, CandidateDevelopmentStrategyProtocol } from './contracts'
import {
  markedEquityFailure,
  performanceBaselineFromPoint,
  type CandidateDevelopmentPerformanceBaseline,
} from './evaluation-metrics'
import { requireCanonicalEvidenceEqual, type PreparedCandidateDevelopmentMarketData } from './market-data-binding'

export const validateDecisionEventBinding = (
  field: 'baseline' | 'stressed',
  signalDecisions: EvaluationResult['signalDecisions'],
  events: EvaluationResult['events'],
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const first = signalDecisions.at(0)
  if (first === undefined) {
    return Result.fail(markedEquityFailure('binding-mismatch', null, `${field}.signalDecisions`, 'nonempty', 0))
  }
  const decisionEvents = events.filter(
    (event): event is Extract<EvaluationResult['events'][number], { readonly kind: 'decision' }> =>
      event.kind === 'decision',
  )
  if (decisionEvents.length !== signalDecisions.length) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        `${field}.decisionCount`,
        signalDecisions.length,
        decisionEvents.length,
      ),
    )
  }
  for (let index = 0; index < signalDecisions.length; index += 1) {
    const signal = signalDecisions[index]
    const event = decisionEvents[index]
    const scalars = [
      ['decisionId', signal.decisionId, event?.id],
      ['signalDate', signal.signalDate, event?.signalDate],
      ['executionDate', signal.executionDate, event?.executionDate],
    ] as const
    for (const [name, expected, observed] of scalars) {
      if (expected !== observed) {
        return Result.fail(
          markedEquityFailure('binding-mismatch', index, `${field}.decision.${name}`, expected, observed ?? null),
        )
      }
    }
    const weights = requireCanonicalEvidenceEqual(
      `${field}.decision.targetWeights`,
      signal.targetWeights,
      event?.targetWeights ?? null,
    )
    if (Result.isFailure(weights)) return Result.fail(weights.failure)
  }
  return Result.succeed(undefined)
}

export const validateRunIndependentDecisionPlans = (
  field: string,
  expected: EvaluationResult['signalDecisions'],
  observed: EvaluationResult['signalDecisions'],
): Result.Result<void, CandidateDevelopmentCommandFailure> =>
  requireCanonicalEvidenceEqual(
    field,
    expected.map(({ decisionId: _, ...decision }) => decision),
    observed.map(({ decisionId: _, ...decision }) => decision),
  )

export const signalDecisionsInSimulationWindow = (
  signalDecisions: EvaluationResult['signalDecisions'],
  simulation: EvaluationResult['simulation'],
): EvaluationResult['signalDecisions'] => {
  const first = simulation.dailyMarks.at(0)?.sessionDate
  const last = simulation.dailyMarks.at(-1)?.sessionDate
  return first === undefined || last === undefined
    ? []
    : signalDecisions.filter(({ executionDate }) => executionDate >= first && executionDate <= last)
}

export const decisionEventsInSimulationWindow = (
  events: EvaluationResult['events'],
  simulation: EvaluationResult['simulation'],
): EvaluationResult['events'] => {
  const first = simulation.dailyMarks.at(0)?.sessionDate
  const last = simulation.dailyMarks.at(-1)?.sessionDate
  return first === undefined || last === undefined
    ? []
    : events.filter((event) => event.kind === 'decision' && event.executionDate >= first && event.executionDate <= last)
}

export const bindRunIndependentDecisionPlansToEvents = (
  field: 'baseline' | 'stressed',
  plans: EvaluationResult['signalDecisions'],
  events: EvaluationResult['events'],
): Result.Result<EvaluationResult['signalDecisions'], CandidateDevelopmentCommandFailure> => {
  const decisionEvents = events.filter(
    (event): event is Extract<EvaluationResult['events'][number], { readonly kind: 'decision' }> =>
      event.kind === 'decision',
  )
  if (decisionEvents.length !== plans.length) {
    return Result.fail(
      markedEquityFailure('binding-mismatch', null, `${field}.decisionCount`, plans.length, decisionEvents.length),
    )
  }
  const bound = plans.map((plan, index) => ({ ...plan, decisionId: decisionEvents[index]!.id }))
  return pipe(
    validateDecisionEventBinding(field, bound, events),
    Result.map(() => bound),
  )
}

export const governedPriceMicros = (
  field: string,
  index: number,
  price: number,
  protocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<string, CandidateDevelopmentCommandFailure> =>
  pipe(
    referencePriceMicros(price, protocol.executionModel),
    Result.map((value) => value.toString()),
    Result.mapError((cause) =>
      markedEquityFailure('binding-mismatch', index, field, 'quantized governed market-data price', price, cause),
    ),
  )

export const validateAccountingPrices = (
  field: 'baseline' | 'stressed',
  events: EvaluationResult['events'],
  simulation: EvaluationResult['simulation'],
  marketData: PreparedCandidateDevelopmentMarketData,
  protocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const sessionFor = (sessionDate: string): AlignedSession | undefined => {
    const index = marketData.sessionIndexByDate.get(sessionDate)
    return index === undefined ? undefined : marketData.sessions[index]
  }
  const fills = events.filter(
    (event): event is Extract<EvaluationResult['events'][number], { readonly kind: 'fill' }> => event.kind === 'fill',
  )
  for (let index = 0; index < fills.length; index += 1) {
    const fill = fills[index]
    const bar = sessionFor(fill.sessionDate)?.bars[fill.symbol]
    if (bar === undefined) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.fills.referencePriceMicros`,
          'governed execution-session bar',
          { symbol: fill.symbol, sessionDate: fill.sessionDate },
        ),
      )
    }
    const expected = governedPriceMicros(`${field}.fills.referencePriceMicros`, index, bar.open, protocol)
    if (Result.isFailure(expected)) return Result.fail(expected.failure)
    if (expected.success !== fill.referencePriceMicros) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.fills.referencePriceMicros`,
          expected.success,
          fill.referencePriceMicros,
        ),
      )
    }
  }
  for (let markIndex = 0; markIndex < simulation.dailyMarks.length; markIndex += 1) {
    const mark = simulation.dailyMarks[markIndex]
    const session = sessionFor(mark.sessionDate)
    if (session === undefined) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          markIndex,
          `${field}.dailyMarks.priceMicros`,
          'governed mark session',
          mark.sessionDate,
        ),
      )
    }
    for (let positionIndex = 0; positionIndex < mark.positions.length; positionIndex += 1) {
      const position = mark.positions[positionIndex]
      const bar = session.bars[position.symbol]
      if (bar === undefined) {
        return Result.fail(
          markedEquityFailure(
            'binding-mismatch',
            markIndex,
            `${field}.dailyMarks.priceMicros`,
            'governed symbol bar',
            position.symbol,
          ),
        )
      }
      const expected = governedPriceMicros(`${field}.dailyMarks.priceMicros`, positionIndex, bar.close, protocol)
      if (Result.isFailure(expected)) return Result.fail(expected.failure)
      if (expected.success !== position.priceMicros) {
        return Result.fail(
          markedEquityFailure(
            'binding-mismatch',
            markIndex,
            `${field}.dailyMarks.priceMicros`,
            expected.success,
            position.priceMicros,
          ),
        )
      }
    }
  }
  return Result.succeed(undefined)
}

export const validateCashYieldIntervals = (
  field: 'baseline' | 'stressed',
  events: EvaluationResult['events'],
  simulation: EvaluationResult['simulation'],
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const markIndexBySession = new Map(simulation.dailyMarks.map((mark, index) => [mark.sessionDate, index] as const))
  if (markIndexBySession.size !== simulation.dailyMarks.length) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        `${field}.cashYield.calendar`,
        'unique accounting sessions',
        simulation.dailyMarks.length - markIndexBySession.size,
      ),
    )
  }
  const seenSessions = new Set<string>()
  const firstRebalanceEventBySession = new Map<string, { readonly index: number; readonly kind: 'fill' | 'fee' }>()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.kind === 'fill' || event.kind === 'fee') {
      if (!firstRebalanceEventBySession.has(event.sessionDate)) {
        firstRebalanceEventBySession.set(event.sessionDate, { index, kind: event.kind })
      }
      continue
    }
    if (event.kind !== 'cash-yield') continue
    const priorRebalanceEvent = firstRebalanceEventBySession.get(event.sessionDate)
    if (priorRebalanceEvent !== undefined) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.cashYield.order`,
          'before every same-session fill and fee',
          priorRebalanceEvent,
        ),
      )
    }
    if (seenSessions.has(event.sessionDate)) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.cashYield.sessionDate`,
          'one cash-yield event per accounting session',
          event.sessionDate,
        ),
      )
    }
    seenSessions.add(event.sessionDate)
    const markIndex = markIndexBySession.get(event.sessionDate)
    const previous = markIndex === undefined ? undefined : simulation.dailyMarks[markIndex - 1]
    if (markIndex === undefined || previous === undefined) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.cashYield.elapsedDays`,
          'accounting session with a predecessor',
          event.sessionDate,
        ),
      )
    }
    const elapsed = elapsedCalendarDays(previous.sessionDate, event.sessionDate)
    if (Result.isFailure(elapsed)) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.cashYield.elapsedDays`,
          `calendar interval after ${previous.sessionDate}`,
          event.elapsedDays,
          elapsed.failure,
        ),
      )
    }
    if (elapsed.success !== event.elapsedDays) {
      return Result.fail(
        markedEquityFailure(
          'binding-mismatch',
          index,
          `${field}.cashYield.elapsedDays`,
          elapsed.success,
          event.elapsedDays,
        ),
      )
    }
  }
  return Result.succeed(undefined)
}

export const validateAccountingCalendar = (
  field: 'baseline' | 'stressed',
  officialSessions: CandidateDevelopmentPreflightInput['officialSessions'],
  simulation: EvaluationResult['simulation'],
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const first = simulation.dailyMarks.at(0)
  if (first === undefined) {
    return Result.fail(
      markedEquityFailure('binding-mismatch', null, `${field}.calendar`, 'nonempty accounting marks', 0),
    )
  }
  const startIndex = officialSessions.indexOf(first.sessionDate)
  if (startIndex < 0 || startIndex + simulation.dailyMarks.length > officialSessions.length) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        `${field}.calendar.start`,
        'contiguous slice of official sessions',
        first.sessionDate,
      ),
    )
  }
  for (let index = 0; index < simulation.dailyMarks.length; index += 1) {
    const expected = officialSessions[startIndex + index]
    const observed = simulation.dailyMarks[index].sessionDate
    if (expected !== observed) {
      return Result.fail(
        markedEquityFailure('binding-mismatch', index, `${field}.calendar.sessionDate`, expected ?? null, observed),
      )
    }
  }
  return Result.succeed(undefined)
}

export const validateAccountingUniverse = (
  field: 'baseline' | 'stressed',
  universe: readonly string[],
  signalDecisions: EvaluationResult['signalDecisions'],
  events: EvaluationResult['events'],
  simulation: EvaluationResult['simulation'],
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const governed = new Set(universe)
  const validateSymbol = (
    evidenceField: string,
    index: number,
    symbol: string,
  ): Result.Result<void, CandidateDevelopmentCommandFailure> =>
    governed.has(symbol)
      ? Result.succeed(undefined)
      : Result.fail(markedEquityFailure('binding-mismatch', index, `${field}.${evidenceField}`, universe, symbol))
  const validateWeights = (
    evidenceField: string,
    index: number,
    weights: Readonly<Record<string, number>>,
  ): Result.Result<void, CandidateDevelopmentCommandFailure> => {
    for (const symbol of Object.keys(weights)) {
      const valid = validateSymbol(evidenceField, index, symbol)
      if (Result.isFailure(valid)) return Result.fail(valid.failure)
    }
    return Result.succeed(undefined)
  }

  for (let index = 0; index < signalDecisions.length; index += 1) {
    const decision = signalDecisions[index]
    const weights = validateWeights('signalDecisions.targetWeights', index, decision.targetWeights)
    if (Result.isFailure(weights)) return Result.fail(weights.failure)
    for (const signal of decision.signals) {
      const valid = validateSymbol('signalDecisions.signals.symbol', index, signal.symbol)
      if (Result.isFailure(valid)) return Result.fail(valid.failure)
    }
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.kind === 'decision') {
      const weights = validateWeights('events.targetWeights', index, event.targetWeights)
      if (Result.isFailure(weights)) return Result.fail(weights.failure)
    } else if (event.kind === 'fill') {
      const valid = validateSymbol('events.symbol', index, event.symbol)
      if (Result.isFailure(valid)) return Result.fail(valid.failure)
    }
  }
  for (let index = 0; index < simulation.orders.length; index += 1) {
    const valid = validateSymbol('orders.symbol', index, simulation.orders[index].symbol)
    if (Result.isFailure(valid)) return Result.fail(valid.failure)
  }
  for (let markIndex = 0; markIndex < simulation.dailyMarks.length; markIndex += 1) {
    for (const position of simulation.dailyMarks[markIndex].positions) {
      const valid = validateSymbol('positions.symbol', markIndex, position.symbol)
      if (Result.isFailure(valid)) return Result.fail(valid.failure)
    }
  }
  return Result.succeed(undefined)
}

export const selectedTracePerformanceBaseline = (
  field: 'baselineSimulation' | 'stressedSimulation',
  full: EvaluationResult['simulation'],
  selected: EvaluationResult['simulation'],
  events: EvaluationResult['events'],
): Result.Result<CandidateDevelopmentPerformanceBaseline, CandidateDevelopmentCommandFailure> => {
  const first = selected.dailyMarks.at(0)
  if (first === undefined) {
    return Result.fail(markedEquityFailure('selected-trace-mismatch', null, field, 'nonempty selected trace', 0))
  }
  const startIndex = full.dailyMarks.findIndex((mark) => mark.sessionDate === first.sessionDate)
  if (startIndex < 0) {
    return Result.fail(
      markedEquityFailure('selected-trace-mismatch', null, `${field}.firstSession`, first.sessionDate, null),
    )
  }
  if (startIndex !== 1) {
    return Result.fail(markedEquityFailure('selected-trace-mismatch', null, `${field}.predecessorCount`, 1, startIndex))
  }
  const predecessor = full.dailyMarks[0]
  const last = selected.dailyMarks.at(-1)
  if (last === undefined || startIndex + selected.dailyMarks.length !== full.dailyMarks.length) {
    return Result.fail(
      markedEquityFailure(
        'selected-trace-mismatch',
        null,
        `${field}.terminalSession`,
        last?.sessionDate ?? null,
        full.dailyMarks.at(-1)?.sessionDate ?? null,
      ),
    )
  }
  for (let index = 0; index < selected.dailyMarks.length; index += 1) {
    const expected = selected.dailyMarks[index]
    const observed = full.dailyMarks[startIndex + index]
    if (observed === undefined) {
      return Result.fail(markedEquityFailure('selected-trace-mismatch', index, field, expected.sessionDate, null))
    }
    const equality = requireCanonicalEvidenceEqual(`${field}.dailyMarks[${index}]`, expected, observed)
    if (Result.isFailure(equality)) return Result.fail(equality.failure)
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const evidenceDates =
      event.kind === 'decision'
        ? ([
            ['signalDate', event.signalDate],
            ['executionDate', event.executionDate],
          ] as const)
        : ([['sessionDate', event.sessionDate]] as const)
    for (const [dateField, observed] of evidenceDates) {
      const isEconomicBeforeWindow =
        event.kind === 'decision'
          ? dateField === 'executionDate' && observed < predecessor.sessionDate
          : observed < predecessor.sessionDate
      if (isEconomicBeforeWindow) {
        return Result.fail(
          markedEquityFailure(
            'selected-trace-mismatch',
            index,
            `${field}.events.${dateField}`,
            `>=${predecessor.sessionDate}`,
            observed,
          ),
        )
      }
      if (observed > last.sessionDate) {
        return Result.fail(
          markedEquityFailure(
            'selected-trace-mismatch',
            index,
            `${field}.events.${dateField}`,
            `<=${last.sessionDate}`,
            observed,
          ),
        )
      }
    }
  }
  for (let index = 0; index < full.orders.length; index += 1) {
    const observed = full.orders[index].sessionDate
    if (observed < predecessor.sessionDate) {
      return Result.fail(
        markedEquityFailure(
          'selected-trace-mismatch',
          index,
          `${field}.orders.sessionDate`,
          `>=${predecessor.sessionDate}`,
          observed,
        ),
      )
    }
    if (observed > last.sessionDate) {
      return Result.fail(
        markedEquityFailure(
          'selected-trace-mismatch',
          index,
          `${field}.orders.sessionDate`,
          `<=${last.sessionDate}`,
          observed,
        ),
      )
    }
  }
  for (let index = 0; index < full.cashChanges.length; index += 1) {
    const observed = full.cashChanges[index].sessionDate
    if (observed < predecessor.sessionDate) {
      return Result.fail(
        markedEquityFailure(
          'selected-trace-mismatch',
          index,
          `${field}.cashChanges.sessionDate`,
          `>=${predecessor.sessionDate}`,
          observed,
        ),
      )
    }
    if (observed > last.sessionDate) {
      return Result.fail(
        markedEquityFailure(
          'selected-trace-mismatch',
          index,
          `${field}.cashChanges.sessionDate`,
          `<=${last.sessionDate}`,
          observed,
        ),
      )
    }
  }
  return Result.succeed(performanceBaselineFromPoint(predecessor))
}
