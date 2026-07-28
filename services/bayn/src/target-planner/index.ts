import { Result, Schema } from 'effect'

import { strictParseOptions } from '../schemas'
import { deriveTargetPlannerHashes, parseTargetPlannerFacts } from './facts'
import { TargetPlannerInputSchema, decodePlannerInputFailure, type TargetPlannerFailure } from './model'
import { computeTargetPlan, finalizeTargetPlan } from './planning'
import type { TargetPlanResult } from './result'

export * from './model'
export { decodeTargetPlanResult, TargetPlanResultSchema } from './result'
export type {
  BlockedTargetPlanResult,
  NoTradeTargetPlanResult,
  PlannedTargetPlanResult,
  TargetPlanResult,
} from './result'

const decodeTargetPlannerInputResult = Schema.decodeUnknownResult(TargetPlannerInputSchema, strictParseOptions)

export const planTargets = (input: unknown): Result.Result<TargetPlanResult, TargetPlannerFailure> => {
  const decoded = Result.mapError(decodeTargetPlannerInputResult(input), (cause) =>
    decodePlannerInputFailure('contract', 'target-planner input failed its durable contract', {}, cause),
  )
  return Result.flatMap(decoded, (value) =>
    Result.flatMap(deriveTargetPlannerHashes(value), (hashes) =>
      Result.flatMap(computeTargetPlan(parseTargetPlannerFacts(value, hashes)), finalizeTargetPlan),
    ),
  )
}
