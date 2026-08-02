import type { CycleDecisionDocument } from '../../shadow-decision-contract'

export interface CycleStoreDecisionFailure {
  readonly failure: 'conflict' | 'invariant' | 'not-found'
  readonly message: string
}

export interface CycleDecisionStoreEvidence {
  readonly paperCompletionEvidenceMatches: boolean
  readonly paperGenerationIsSuperseded: boolean
}

const decisionStoreEvidence = new WeakMap<object, CycleDecisionStoreEvidence>()

export const attachCycleDecisionStoreEvidence = (
  document: CycleDecisionDocument,
  evidence: CycleDecisionStoreEvidence,
): CycleDecisionDocument => {
  const attached = { ...document } satisfies CycleDecisionDocument
  decisionStoreEvidence.set(attached, evidence)
  return attached
}

export const cycleDecisionStoreEvidence = (document: CycleDecisionDocument): CycleDecisionStoreEvidence | undefined =>
  decisionStoreEvidence.get(document)
