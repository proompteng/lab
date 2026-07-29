export interface Candidate12HoldoutAccessInput {
  readonly developmentStatus: 'PASS' | 'HOLD_REJECT'
  readonly identityLocked: boolean
  readonly priorAccessCount: number
}

export type Candidate12HoldoutAccessDecision =
  | { readonly status: 'ALLOW_ONCE'; readonly nextAccessCount: 1 }
  | {
      readonly status: 'DENY'
      readonly reason:
        | 'DEVELOPMENT_NOT_PASSED'
        | 'IDENTITY_NOT_LOCKED'
        | 'HOLDOUT_ALREADY_ACCESSED'
        | 'INVALID_ACCESS_COUNT'
    }

export const decideCandidate12HoldoutAccess = (
  input: Candidate12HoldoutAccessInput,
): Candidate12HoldoutAccessDecision => {
  if (!Number.isSafeInteger(input.priorAccessCount) || input.priorAccessCount < 0) {
    return { status: 'DENY', reason: 'INVALID_ACCESS_COUNT' }
  }
  if (input.developmentStatus !== 'PASS') return { status: 'DENY', reason: 'DEVELOPMENT_NOT_PASSED' }
  if (!input.identityLocked) return { status: 'DENY', reason: 'IDENTITY_NOT_LOCKED' }
  return input.priorAccessCount === 0
    ? { status: 'ALLOW_ONCE', nextAccessCount: 1 }
    : { status: 'DENY', reason: 'HOLDOUT_ALREADY_ACCESSED' }
}
