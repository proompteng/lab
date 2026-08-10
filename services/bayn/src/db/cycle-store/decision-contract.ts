import type { CycleDecisionDocument } from '../../shadow-decision-contract'
import { Pipeable } from '../../pipeable'

export interface CycleStoreDecisionFailure {
  readonly failure: 'conflict' | 'invariant' | 'not-found'
  readonly message: string
}

export interface CycleDecisionStoreEvidence {
  readonly paperCompletionEvidenceMatches: boolean
  readonly paperGenerationIsSuperseded: boolean
}

const decisionStoreEvidence = new WeakMap<object, CycleDecisionStoreEvidence>()

const attachCycleDecisionStoreEvidenceDataFirst = (
  document: CycleDecisionDocument,
  evidence: CycleDecisionStoreEvidence,
): CycleDecisionDocument => {
  const attached = { ...document } satisfies CycleDecisionDocument
  decisionStoreEvidence.set(attached, evidence)
  return attached
}

export const attachCycleDecisionStoreEvidence = Pipeable.dual(2, attachCycleDecisionStoreEvidenceDataFirst)

export const cycleDecisionStoreEvidence = (document: CycleDecisionDocument): CycleDecisionStoreEvidence | undefined =>
  decisionStoreEvidence.get(document)
