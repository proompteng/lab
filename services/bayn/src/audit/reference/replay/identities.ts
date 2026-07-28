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

export const hashReferenceMaterial = (
  subject: ReferenceCanonicalizationSubject,
  value: unknown,
): ReferenceComputation<string> =>
  Result.mapError(canonicalHashV1Result(value), (cause) => ({
    _tag: 'ReferenceCanonicalizationFailed' as const,
    subject,
    cause,
  }))

export const makeReferenceDecisionEvent = (
  runId: string,
  material: Omit<DecisionEvent, 'id' | 'kind'>,
): ReferenceComputation<DecisionEvent> =>
  Result.map(hashReferenceMaterial('decision-event', { runId, kind: 'decision', ...material }), (id) => ({
    kind: 'decision',
    id,
    ...material,
  }))

export const makeReferenceCashYieldEvent = (
  runId: string,
  material: Omit<CashYieldEvent, 'id' | 'kind'>,
): ReferenceComputation<CashYieldEvent> =>
  Result.map(hashReferenceMaterial('cash-yield-event', { runId, kind: 'cash-yield', ...material }), (id) => ({
    kind: 'cash-yield',
    id,
    ...material,
  }))

export const makeReferenceFeeEvent = (
  runId: string,
  material: Omit<FeeEvent, 'id' | 'kind'>,
): ReferenceComputation<FeeEvent> =>
  Result.map(hashReferenceMaterial('fee-event', { runId, kind: 'fee', ...material }), (id) => ({
    kind: 'fee',
    id,
    ...material,
  }))

export const makeReferenceOrderIdentity = (
  runId: string,
  material: Omit<SimulatedOrder, 'id'>,
): ReferenceComputation<SimulatedOrder> =>
  Result.map(hashReferenceMaterial('simulated-order', { runId, kind: 'order', ...material }), (id) => ({
    id,
    ...material,
  }))

export const makeReferenceFillIdentity = (
  runId: string,
  material: Omit<FillEvent, 'id' | 'kind'>,
): ReferenceComputation<FillEvent> =>
  Result.map(hashReferenceMaterial('fill-event', { runId, kind: 'fill', ...material }), (id) => ({
    kind: 'fill',
    id,
    ...material,
  }))

export const makeReferenceCashChangeIdentity = (
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
