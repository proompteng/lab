import { Effect } from 'effect'

import { decideCandidateDevelopmentEvaluation, type CandidateDevelopmentEvaluation } from './evaluation'
import {
  preflightCandidateDevelopment,
  type CandidateDevelopmentPreflightInput,
  type CandidateDevelopmentPreflightIssue,
  type CandidateDevelopmentPreflightPass,
} from './preflight'
import { buildCandidateDevelopmentReport, type CandidateDevelopmentReport } from './report'
import type { CandidateDevelopmentComparisonSemanticsIssue } from './comparison'
import type { CandidateDevelopmentDoubledCostIssue } from './doubled-cost'
import type { CandidateDevelopmentGeometryFail } from './geometry'

export interface CandidateDevelopmentEffects<Registration, Data, Error, Requirements> {
  readonly preregisterCandidate: (
    preflight: CandidateDevelopmentPreflightPass,
  ) => Effect.Effect<Registration, Error, Requirements>
  readonly loadDevelopmentData: (
    registration: Registration,
    preflight: CandidateDevelopmentPreflightPass,
  ) => Effect.Effect<Data, Error, Requirements>
  readonly evaluateDevelopment: (
    data: Data,
    preflight: CandidateDevelopmentPreflightPass,
  ) => Effect.Effect<CandidateDevelopmentEvaluation, Error, Requirements>
}

export type CandidateDevelopmentRunFailure =
  | {
      readonly _tag: 'CandidateDevelopmentPreflightInvalid'
      readonly cause: CandidateDevelopmentPreflightIssue
    }
  | {
      readonly _tag: 'CandidateDevelopmentPreflightFailed'
      readonly preflight: CandidateDevelopmentGeometryFail
    }
  | {
      readonly _tag: 'CandidateDevelopmentDoubledCostInvalid'
      readonly cause: CandidateDevelopmentDoubledCostIssue
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSemanticsInvalid'
      readonly cause: CandidateDevelopmentComparisonSemanticsIssue
    }

const evaluationFailure = (
  failure:
    | {
        readonly _tag: 'CandidateDevelopmentEvaluationComparisonInvalid'
        readonly cause: CandidateDevelopmentComparisonSemanticsIssue
      }
    | {
        readonly _tag: 'CandidateDevelopmentEvaluationDoubledCostInvalid'
        readonly cause: CandidateDevelopmentDoubledCostIssue
      },
): CandidateDevelopmentRunFailure =>
  failure._tag === 'CandidateDevelopmentEvaluationComparisonInvalid'
    ? { _tag: 'CandidateDevelopmentComparisonSemanticsInvalid', cause: failure.cause }
    : { _tag: 'CandidateDevelopmentDoubledCostInvalid', cause: failure.cause }

export const runCandidateDevelopment = <Registration, Data, Error, Requirements>(
  input: CandidateDevelopmentPreflightInput,
  effects: CandidateDevelopmentEffects<Registration, Data, Error, Requirements>,
): Effect.Effect<CandidateDevelopmentReport, CandidateDevelopmentRunFailure | Error, Requirements> =>
  Effect.fromResult(preflightCandidateDevelopment(input)).pipe(
    Effect.mapError(
      (cause): CandidateDevelopmentRunFailure => ({ _tag: 'CandidateDevelopmentPreflightInvalid', cause }),
    ),
    Effect.flatMap(
      (preflight): Effect.Effect<CandidateDevelopmentReport, CandidateDevelopmentRunFailure | Error, Requirements> =>
        preflight.status === 'FAIL'
          ? Effect.fail<CandidateDevelopmentRunFailure>({
              _tag: 'CandidateDevelopmentPreflightFailed',
              preflight,
            })
          : effects.preregisterCandidate(preflight).pipe(
              Effect.flatMap((registration) => effects.loadDevelopmentData(registration, preflight)),
              Effect.flatMap((data) => effects.evaluateDevelopment(data, preflight)),
              Effect.flatMap((evaluation) =>
                Effect.fromResult(decideCandidateDevelopmentEvaluation(preflight, evaluation)).pipe(
                  Effect.mapError(evaluationFailure),
                  Effect.map((decision) => buildCandidateDevelopmentReport(preflight, decision)),
                ),
              ),
            ),
    ),
  )
