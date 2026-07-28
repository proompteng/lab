import { Result } from 'effect'

import { calculateSessionFees, type FeeBreakdown, type FeeInput } from '../execution-model'
import type { FeeEvent, SimulationTrace } from '../types'
import type { EvidenceMismatchProblem, FailedComputation, SimulationReconciliationIssue, Validation } from './model'
import { fail, failIssues, unsigned, validateCanonicalIdentity, type ValidatedFill } from './validation'

export interface ValidatedFee {
  readonly kind: 'fee'
  readonly event: FeeEvent
  readonly totalMicros: bigint
}

const feeUnsigned = (fee: FeeEvent, field: Extract<Parameters<typeof unsigned>[0], { kind: 'fee' }>['field']) =>
  unsigned({ kind: 'fee', feeId: fee.id, field, value: fee[field] })

const feeSchedule = (
  fee: FeeEvent,
  inputs: readonly FeeInput[],
  simulation: SimulationTrace,
  costMultiplierMicros: bigint,
): Validation<FeeBreakdown> => {
  const computation: FailedComputation = {
    _tag: 'FeeSchedule',
    feeId: fee.id,
    fillCount: inputs.length,
    costMultiplierMicros: costMultiplierMicros.toString(),
  }
  return Result.mapError(
    calculateSessionFees(inputs, simulation.executionModel, costMultiplierMicros),
    (cause): readonly SimulationReconciliationIssue[] => [{ _tag: 'ComputationFailed', computation, cause }],
  )
}

export const validateFee = (
  runId: string,
  fee: FeeEvent,
  sessionFills: readonly ValidatedFill[],
  simulation: SimulationTrace,
  costMultiplierMicros: bigint,
): Validation<ValidatedFee> => {
  const commission = feeUnsigned(fee, 'commissionMicros')
  if (Result.isFailure(commission)) return failIssues(commission.failure)
  const sec = feeUnsigned(fee, 'secMicros')
  if (Result.isFailure(sec)) return failIssues(sec.failure)
  const taf = feeUnsigned(fee, 'tafMicros')
  if (Result.isFailure(taf)) return failIssues(taf.failure)
  const cat = feeUnsigned(fee, 'catMicros')
  if (Result.isFailure(cat)) return failIssues(cat.failure)
  const total = feeUnsigned(fee, 'totalMicros')
  if (Result.isFailure(total)) return failIssues(total.failure)
  const componentTotal = commission.success + sec.success + taf.success + cat.success
  if (componentTotal !== total.success) {
    return fail({
      _tag: 'EvidenceMismatch',
      problem: {
        _tag: 'FeeComponents',
        feeId: fee.id,
        actualTotalMicros: total.success.toString(),
        expectedTotalMicros: componentTotal.toString(),
      },
    })
  }
  const inputs: FeeInput[] = sessionFills.map((fill) => ({
    side: fill.event.side,
    quantityMicros: fill.quantityMicros,
    notionalMicros: fill.notionalMicros,
  }))
  const expected = feeSchedule(fee, inputs, simulation, costMultiplierMicros)
  if (Result.isFailure(expected)) return failIssues(expected.failure)
  const comparisons: readonly [
    Extract<EvidenceMismatchProblem, { readonly _tag: 'FeeSchedule' }>['field'],
    bigint,
    bigint,
  ][] = [
    ['commissionMicros', commission.success, expected.success.commissionMicros],
    ['secMicros', sec.success, expected.success.secMicros],
    ['tafMicros', taf.success, expected.success.tafMicros],
    ['catMicros', cat.success, expected.success.catMicros],
    ['totalMicros', total.success, expected.success.totalMicros],
  ]
  const scheduleIssues: readonly SimulationReconciliationIssue[] = comparisons.flatMap(([field, actual, calculated]) =>
    actual === calculated
      ? []
      : [
          {
            _tag: 'EvidenceMismatch',
            problem: {
              _tag: 'FeeSchedule',
              feeId: fee.id,
              field,
              actualMicros: actual.toString(),
              expectedMicros: calculated.toString(),
            },
          },
        ],
  )
  if (scheduleIssues.length > 0) return failIssues(scheduleIssues)
  const { id: _, kind: __, ...payload } = fee
  const identity = validateCanonicalIdentity(
    { kind: 'fee', id: fee.id, sessionDate: fee.sessionDate },
    { runId, kind: 'fee', ...payload },
  )
  return Result.isFailure(identity)
    ? failIssues(identity.failure)
    : Result.succeed({ kind: 'fee', event: fee, totalMicros: total.success })
}
