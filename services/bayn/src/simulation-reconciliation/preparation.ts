import { Chunk, pipe, Result } from 'effect'

import type {
  CashChange,
  CashYieldEvent,
  DecisionEvent,
  EvaluationEvent,
  FeeEvent,
  FillEvent,
  SimulationTrace,
} from '../types'
import { validateFee, type ValidatedFee } from './fee-validation'
import { validateMarks } from './mark-validation'
import { MARKED_EQUITY_TOLERANCE_MICROS, type MarkedEquityReconciliationInput, type Validation } from './model'
import {
  fail,
  failIssues,
  groupValuesBy,
  indexUnique,
  indexUniqueBy,
  positiveUnsigned,
  validateDecisionIdentity,
  validateOrder,
  type ValidatedFill,
} from './validation'

export interface PreparedFill extends ValidatedFill {
  readonly cashChange: CashChange
}

export interface PreparedFee extends ValidatedFee {
  readonly cashChange: CashChange
}

export interface PreparedCashYield {
  readonly kind: 'cash-yield'
  readonly event: CashYieldEvent
  readonly cashChange: CashChange
}

export type PreparedMonetaryEvent = PreparedFill | PreparedFee | PreparedCashYield

export interface PreparedReconciliation {
  readonly input: MarkedEquityReconciliationInput
  readonly toleranceMicros: bigint
  readonly monetaryEvents: readonly PreparedMonetaryEvent[]
}

const validateDecisions = (
  runId: string,
  events: readonly EvaluationEvent[],
): Validation<ReadonlyMap<string, DecisionEvent>> => {
  const decisionValues = events.filter((event): event is DecisionEvent => event.kind === 'decision')
  const decisions = indexUnique(decisionValues, 'decision', (decision) => ({
    kind: 'decision',
    id: decision.id,
    signalDate: decision.signalDate,
  }))
  if (Result.isFailure(decisions)) return failIssues(decisions.failure)
  return pipe(
    [...decisions.success.values()].reduce<Validation<void>>(
      (validated, decision) =>
        pipe(
          validated,
          Result.flatMap(() => validateDecisionIdentity(runId, decision)),
        ),
      Result.succeed(undefined),
    ),
    Result.map(() => decisions.success),
  )
}

const validateOrdersAndFills = (
  runId: string,
  events: readonly EvaluationEvent[],
  simulation: SimulationTrace,
  decisions: ReadonlyMap<string, DecisionEvent>,
  costMultiplierMicros: bigint,
): Validation<readonly ValidatedFill[]> => {
  const fills = events.filter((event): event is FillEvent => event.kind === 'fill')
  const indexedFills = indexUnique(fills, 'fill', (fill) => ({
    kind: 'fill',
    id: fill.id,
    sessionDate: fill.sessionDate,
  }))
  if (Result.isFailure(indexedFills)) return failIssues(indexedFills.failure)
  const fillsByOrder = indexUniqueBy(
    fills.map((event, eventIndex) => ({ event, eventIndex })),
    ({ event }) => event.orderId,
    ({ event }) => ({
      _tag: 'InvalidEvidenceState',
      problem: { _tag: 'DuplicateFillForOrder', orderId: event.orderId, secondFillId: event.id },
    }),
  )
  if (Result.isFailure(fillsByOrder)) return failIssues(fillsByOrder.failure)
  const orders = indexUnique(simulation.orders, 'order', (order) => ({
    kind: 'order',
    id: order.id,
    sessionDate: order.sessionDate,
  }))
  if (Result.isFailure(orders)) return failIssues(orders.failure)
  const preparedFills = [...orders.success.values()].reduce<
    Validation<Chunk.Chunk<{ readonly eventIndex: number; readonly fill: ValidatedFill }>>
  >(
    (prepared, order) =>
      pipe(
        prepared,
        Result.flatMap((items) => {
          const indexedFill = fillsByOrder.success.get(order.id)
          return pipe(
            validateOrder(runId, order, indexedFill?.event, decisions, simulation, costMultiplierMicros),
            Result.map((fill) =>
              fill === undefined || indexedFill === undefined
                ? items
                : Chunk.prepend(items, { eventIndex: indexedFill.eventIndex, fill }),
            ),
          )
        }),
      ),
    Result.succeed(Chunk.empty()),
  )
  if (Result.isFailure(preparedFills)) return failIssues(preparedFills.failure)
  const orphan = fills.find((fill) => !orders.success.has(fill.orderId))
  return orphan === undefined
    ? Result.succeed(
        Chunk.toReadonlyArray(preparedFills.success)
          .toSorted((left, right) => left.eventIndex - right.eventIndex)
          .map(({ fill }) => fill),
      )
    : fail({ _tag: 'MissingReference', problem: { _tag: 'FillOrder', fillId: orphan.id, orderId: orphan.orderId } })
}

const validateFeesAndYields = (
  runId: string,
  events: readonly EvaluationEvent[],
  fills: readonly ValidatedFill[],
  simulation: SimulationTrace,
  costMultiplierMicros: bigint,
): Validation<readonly ValidatedFee[]> => {
  const fees = events.filter((event): event is FeeEvent => event.kind === 'fee')
  const indexedFees = indexUnique(fees, 'fee', (fee) => ({ kind: 'fee', id: fee.id, sessionDate: fee.sessionDate }))
  if (Result.isFailure(indexedFees)) return failIssues(indexedFees.failure)
  const cashYields = events.filter((event): event is CashYieldEvent => event.kind === 'cash-yield')
  const indexedCashYields = indexUnique(cashYields, 'cash-yield', (event) => ({
    kind: 'cash-yield',
    id: event.id,
    sessionDate: event.sessionDate,
  }))
  if (Result.isFailure(indexedCashYields)) return failIssues(indexedCashYields.failure)
  const fillsBySession = groupValuesBy(fills, (fill) => fill.event.sessionDate)
  return pipe(
    fees.reduce<Validation<Chunk.Chunk<ValidatedFee>>>(
      (prepared, fee) =>
        pipe(
          prepared,
          Result.flatMap((items) =>
            pipe(
              validateFee(runId, fee, fillsBySession.get(fee.sessionDate) ?? [], simulation, costMultiplierMicros),
              Result.map((valid) => Chunk.prepend(items, valid)),
            ),
          ),
        ),
      Result.succeed(Chunk.empty()),
    ),
    Result.map((reversed) => Chunk.toReadonlyArray(Chunk.reverse(reversed))),
  )
}

interface MonetaryAccumulator {
  readonly reversedEvents: Chunk.Chunk<PreparedMonetaryEvent>
  readonly fillIndex: number
  readonly feeIndex: number
}

const validateMonetaryEvidence = (
  events: readonly EvaluationEvent[],
  cashChanges: readonly CashChange[],
  fills: readonly ValidatedFill[],
  fees: readonly ValidatedFee[],
): Validation<readonly PreparedMonetaryEvent[]> => {
  const sourceEvents = events.filter(
    (event): event is FillEvent | FeeEvent | CashYieldEvent => event.kind !== 'decision',
  )
  const changes = indexUnique(cashChanges, 'cash-change', (change) => ({
    kind: 'cash-change',
    id: change.id,
    sourceId: change.sourceId,
    sessionDate: change.sessionDate,
  }))
  if (Result.isFailure(changes)) return failIssues(changes.failure)
  const cashChangesBySource = indexUniqueBy(
    [...changes.success.values()],
    (change) => change.sourceId,
    (change) => ({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'DuplicateCashChangeForEvent',
        eventId: change.sourceId,
        secondCashChangeId: change.id,
      },
    }),
  )
  if (Result.isFailure(cashChangesBySource)) return failIssues(cashChangesBySource.failure)
  if (changes.success.size !== sourceEvents.length) {
    return fail({
      _tag: 'IncompleteEvidence',
      problem: {
        _tag: 'CashChangeCountMismatch',
        cashChangeCount: changes.success.size,
        monetaryEventCount: sourceEvents.length,
      },
    })
  }
  return pipe(
    sourceEvents.reduce<Validation<MonetaryAccumulator>>(
      (prepared, event) =>
        pipe(
          prepared,
          Result.flatMap((accumulator) => {
            const cashChange = cashChangesBySource.success.get(event.id)
            if (cashChange === undefined) {
              return fail({
                _tag: 'MissingReference',
                problem: { _tag: 'MonetaryEventCashChange', eventId: event.id, eventKind: event.kind },
              })
            }
            if (event.kind === 'cash-yield') {
              return Result.succeed({
                ...accumulator,
                reversedEvents: Chunk.prepend(accumulator.reversedEvents, { kind: 'cash-yield', event, cashChange }),
              })
            }
            if (event.kind === 'fill') {
              const fill = fills.at(accumulator.fillIndex)
              if (fill === undefined) {
                return fail({
                  _tag: 'MissingReference',
                  problem: { _tag: 'ValidatedMonetaryEvent', eventId: event.id, eventKind: event.kind },
                })
              }
              return Result.succeed({
                reversedEvents: Chunk.prepend(accumulator.reversedEvents, { ...fill, cashChange }),
                fillIndex: accumulator.fillIndex + 1,
                feeIndex: accumulator.feeIndex,
              })
            }
            const fee = fees.at(accumulator.feeIndex)
            if (fee === undefined) {
              return fail({
                _tag: 'MissingReference',
                problem: { _tag: 'ValidatedMonetaryEvent', eventId: event.id, eventKind: event.kind },
              })
            }
            return Result.succeed({
              reversedEvents: Chunk.prepend(accumulator.reversedEvents, { ...fee, cashChange }),
              fillIndex: accumulator.fillIndex,
              feeIndex: accumulator.feeIndex + 1,
            })
          }),
        ),
      Result.succeed({ reversedEvents: Chunk.empty(), fillIndex: 0, feeIndex: 0 }),
    ),
    Result.map(({ reversedEvents }) => Chunk.toReadonlyArray(Chunk.reverse(reversedEvents))),
  )
}

export const prepareReconciliation = (input: MarkedEquityReconciliationInput): Validation<PreparedReconciliation> => {
  const toleranceMicros = input.toleranceMicros ?? MARKED_EQUITY_TOLERANCE_MICROS
  if (toleranceMicros < 0n) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: { _tag: 'NegativeTolerance', toleranceMicros: toleranceMicros.toString() },
    })
  }
  const runIdentity = /^[0-9a-f]{64}$/.test(input.runId)
  if (!runIdentity) {
    return fail({
      _tag: 'InvalidIdentity',
      evidence: { kind: 'run', id: input.runId },
      problem: { _tag: 'InvalidFormat', expected: 'lowercase-sha256' },
    })
  }
  if (input.simulation.schemaVersion !== 'bayn.simulation-trace.v3') {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: {
        _tag: 'UnsupportedSimulationSchema',
        actual: input.simulation.schemaVersion,
        expected: 'bayn.simulation-trace.v3',
      },
    })
  }
  const costMultiplierMicros = positiveUnsigned({
    kind: 'simulation',
    field: 'costMultiplierMicros',
    value: input.simulation.costMultiplierMicros,
  })
  if (Result.isFailure(costMultiplierMicros)) return failIssues(costMultiplierMicros.failure)
  const decisions = validateDecisions(input.runId, input.events)
  if (Result.isFailure(decisions)) return failIssues(decisions.failure)
  const fills = validateOrdersAndFills(
    input.runId,
    input.events,
    input.simulation,
    decisions.success,
    costMultiplierMicros.success,
  )
  if (Result.isFailure(fills)) return failIssues(fills.failure)
  const fees = validateFeesAndYields(
    input.runId,
    input.events,
    fills.success,
    input.simulation,
    costMultiplierMicros.success,
  )
  if (Result.isFailure(fees)) return failIssues(fees.failure)
  const monetaryEvents = validateMonetaryEvidence(
    input.events,
    input.simulation.cashChanges,
    fills.success,
    fees.success,
  )
  if (Result.isFailure(monetaryEvents)) return failIssues(monetaryEvents.failure)
  const marks = validateMarks(input.simulation.dailyMarks)
  if (Result.isFailure(marks)) return failIssues(marks.failure)
  return Result.succeed({ input, toleranceMicros, monetaryEvents: monetaryEvents.success })
}
