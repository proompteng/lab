import { Result } from 'effect'

import { Authority, type AuthorityState } from './contracts'
import { isResearchCapitalActivationRequest, type CapitalActivationRequest } from './configuration'

export type ExecutionCycleObservationBinding =
  | { readonly _tag: 'ObserveAuthority' }
  | { readonly _tag: 'ResearchGrant'; readonly cycleObservationId: string }
  | { readonly _tag: 'Qualification'; readonly cycleObservationId: string }

export interface ExecutionRuntimeBinding {
  readonly requiresQualificationEvidence: boolean
  readonly cycleObservation: ExecutionCycleObservationBinding
}

export const executionRuntimeBinding = (request: CapitalActivationRequest | null): ExecutionRuntimeBinding => {
  if (request === null) {
    return {
      requiresQualificationEvidence: false,
      cycleObservation: { _tag: 'ObserveAuthority' },
    }
  }
  if (isResearchCapitalActivationRequest(request)) {
    return {
      requiresQualificationEvidence: false,
      cycleObservation: { _tag: 'ResearchGrant', cycleObservationId: request.grant.planHash },
    }
  }
  return {
    requiresQualificationEvidence: true,
    cycleObservation: { _tag: 'Qualification', cycleObservationId: request.qualification.runId },
  }
}

export const resolveExecutionCycleObservationId = (
  binding: ExecutionRuntimeBinding,
  authority: AuthorityState | undefined,
): Result.Result<string, string> => {
  if (binding.cycleObservation._tag !== 'ObserveAuthority') {
    return Result.succeed(binding.cycleObservation.cycleObservationId)
  }
  if (authority === undefined) {
    return Result.fail('OBSERVE execution binding requires durable authority state')
  }
  return authority.maximum === Authority.Observe && authority.effective === Authority.Observe
    ? Result.succeed(authority.generationHash)
    : Result.fail('OBSERVE execution binding requires current effective OBSERVE authority')
}
