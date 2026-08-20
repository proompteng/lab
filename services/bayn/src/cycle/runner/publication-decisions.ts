import { Pipeable } from '../../pipeable'
import { CycleState, type LegacyAutonomousCycle } from '../model'

export type CyclePublicationAdmission =
  | { readonly _tag: 'RETURN_BLOCKED' }
  | { readonly _tag: 'INSPECT_BOUND' }
  | { readonly _tag: 'REJECT_UNBOUND_STATE' }
  | { readonly _tag: 'BLOCK_MISSED' }
  | { readonly _tag: 'WAIT_SIGNAL' }
  | { readonly _tag: 'INSPECT_PUBLICATION' }

const decideCyclePublicationAdmissionDataFirst = (
  cycle: LegacyAutonomousCycle,
  observedAt: string,
): CyclePublicationAdmission => {
  if (cycle.state === CycleState.Blocked) return { _tag: 'RETURN_BLOCKED' }
  if (cycle.bindings.snapshotId !== undefined) return { _tag: 'INSPECT_BOUND' }
  if (cycle.state !== CycleState.Pending) return { _tag: 'REJECT_UNBOUND_STATE' }
  if (observedAt >= cycle.window.publicationDeadlineAt) return { _tag: 'BLOCK_MISSED' }
  if (observedAt < cycle.window.signalCloseAt) return { _tag: 'WAIT_SIGNAL' }
  return { _tag: 'INSPECT_PUBLICATION' }
}

export const decideCyclePublicationAdmission = Pipeable.dual(2, decideCyclePublicationAdmissionDataFirst)

export type FinalizedPublicationBindingDecision =
  | { readonly _tag: 'RETURN_BLOCKED' }
  | { readonly _tag: 'REJECT_IMMUTABLE_BINDING' }
  | { readonly _tag: 'RETURN_ALREADY_BOUND' }
  | { readonly _tag: 'REJECT_UNBOUND_STATE' }
  | { readonly _tag: 'BLOCK_MISSED' }
  | { readonly _tag: 'REJECT_BEFORE_SIGNAL_CLOSE' }
  | { readonly _tag: 'BIND' }

const decideFinalizedPublicationBindingDataFirst = (
  cycle: LegacyAutonomousCycle,
  snapshotId: string,
  observedAt: string,
): FinalizedPublicationBindingDecision => {
  if (cycle.state === CycleState.Blocked) return { _tag: 'RETURN_BLOCKED' }
  if (cycle.bindings.snapshotId !== undefined) {
    return cycle.bindings.snapshotId === snapshotId
      ? { _tag: 'RETURN_ALREADY_BOUND' }
      : { _tag: 'REJECT_IMMUTABLE_BINDING' }
  }
  if (cycle.state !== CycleState.Pending) return { _tag: 'REJECT_UNBOUND_STATE' }
  if (observedAt >= cycle.window.publicationDeadlineAt) return { _tag: 'BLOCK_MISSED' }
  if (observedAt < cycle.window.signalCloseAt) return { _tag: 'REJECT_BEFORE_SIGNAL_CLOSE' }
  return { _tag: 'BIND' }
}

export const decideFinalizedPublicationBinding = Pipeable.dual(3, decideFinalizedPublicationBindingDataFirst)

export type PublicationInspectionDecision =
  | { readonly _tag: 'BLOCK_MISSED' }
  | { readonly _tag: 'WAIT_MISSING' }
  | { readonly _tag: 'BIND_FINALIZED' }

const decidePublicationInspectionDataFirst = (
  publicationFound: boolean,
  observedAt: string,
  publicationDeadlineAt: string,
): PublicationInspectionDecision => {
  if (observedAt >= publicationDeadlineAt) return { _tag: 'BLOCK_MISSED' }
  return publicationFound ? { _tag: 'BIND_FINALIZED' } : { _tag: 'WAIT_MISSING' }
}

export const decidePublicationInspection = Pipeable.dual(3, decidePublicationInspectionDataFirst)
