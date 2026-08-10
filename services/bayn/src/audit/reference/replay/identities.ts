import { Result } from 'effect'

import { canonicalHashV1Result } from '../../../hash'
import type {
  CashChange,
  CashYieldEvent,
  DecisionEvent,
  FeeEvent,
  FillEvent,
  IsoDate,
  SimulatedOrder,
} from '../../../types'
import type { ReferenceCanonicalizationSubject, ReferenceComputation } from '../model'
import { Pipeable } from '../../../pipeable'

const hashReferenceMaterialDataFirst = (
  subject: ReferenceCanonicalizationSubject,
  value: unknown,
): ReferenceComputation<string> =>
  Result.mapError(canonicalHashV1Result(value), (cause) => ({
    _tag: 'ReferenceCanonicalizationFailed' as const,
    subject,
    cause,
  }))

export const hashReferenceMaterial = Pipeable.dual(2, hashReferenceMaterialDataFirst)

const makeReferenceDecisionEventDataFirst = (
  runId: string,
  material: Omit<DecisionEvent, 'id' | 'kind'>,
): ReferenceComputation<DecisionEvent> =>
  Result.map(hashReferenceMaterial('decision-event', { runId, kind: 'decision', ...material }), (id) => ({
    kind: 'decision',
    id,
    ...material,
  }))

export const makeReferenceDecisionEvent = Pipeable.dual(2, makeReferenceDecisionEventDataFirst)

const makeReferenceCashYieldEventDataFirst = (
  runId: string,
  material: Omit<CashYieldEvent, 'id' | 'kind'>,
): ReferenceComputation<CashYieldEvent> =>
  Result.map(hashReferenceMaterial('cash-yield-event', { runId, kind: 'cash-yield', ...material }), (id) => ({
    kind: 'cash-yield',
    id,
    ...material,
  }))

export const makeReferenceCashYieldEvent = Pipeable.dual(2, makeReferenceCashYieldEventDataFirst)

const makeReferenceFeeEventDataFirst = (
  runId: string,
  material: Omit<FeeEvent, 'id' | 'kind'>,
): ReferenceComputation<FeeEvent> =>
  Result.map(hashReferenceMaterial('fee-event', { runId, kind: 'fee', ...material }), (id) => ({
    kind: 'fee',
    id,
    ...material,
  }))

export const makeReferenceFeeEvent = Pipeable.dual(2, makeReferenceFeeEventDataFirst)

const makeReferenceOrderIdentityDataFirst = (
  runId: string,
  material: Omit<SimulatedOrder, 'id'>,
): ReferenceComputation<SimulatedOrder> =>
  Result.map(hashReferenceMaterial('simulated-order', { runId, kind: 'order', ...material }), (id) => ({
    id,
    ...material,
  }))

export const makeReferenceOrderIdentity = Pipeable.dual(2, makeReferenceOrderIdentityDataFirst)

const makeReferenceFillIdentityDataFirst = (
  runId: string,
  material: Omit<FillEvent, 'id' | 'kind'>,
): ReferenceComputation<FillEvent> =>
  Result.map(hashReferenceMaterial('fill-event', { runId, kind: 'fill', ...material }), (id) => ({
    kind: 'fill',
    id,
    ...material,
  }))

export const makeReferenceFillIdentity = Pipeable.dual(2, makeReferenceFillIdentityDataFirst)

const makeReferenceCashChangeIdentityDataFirst = (
  runId: string,
  source:
    | Pick<FillEvent | FeeEvent, 'kind' | 'id' | 'sessionDate'>
    | {
        readonly kind: 'cash-yield'
        readonly id: string
        readonly sessionDate: IsoDate
      },
  amountMicros: bigint,
  cashAfterMicros: bigint,
): ReferenceComputation<CashChange> => {
  const material = {
    sourceKind: source.kind,
    sourceId: source.id,
    sessionDate: source.sessionDate,
    amountMicros: amountMicros.toString(),
    cashAfterMicros: cashAfterMicros.toString(),
  }
  return Result.map(hashReferenceMaterial('cash-change', { runId, kind: 'cash-change', ...material }), (id) => ({
    id,
    ...material,
  }))
}

export const makeReferenceCashChangeIdentity = Pipeable.dual(4, makeReferenceCashChangeIdentityDataFirst)
