import { pipe, Result, Schema } from 'effect'

import { strictParseOptions } from '../schemas'
import type { EconomicVerdict } from '../types'
import { QualificationStatisticsPolicySchema, type QualificationAnalysis } from '../qualification-statistics/model'
import type { QualificationConstructionFailure } from './failure'
import { canonicalHashMatches, hashQualificationMaterial } from './hashing'
import {
  QualificationResultSchema,
  qualificationResultReasonCode,
  type QualificationLock,
  type QualificationResult,
} from './model'
import { Pipeable } from '../pipeable'

const decodeQualificationResult = Schema.decodeUnknownResult(QualificationResultSchema, strictParseOptions)
const QualificationPolicyBindingSchema = Schema.Struct({
  lockedSchemaVersion: Schema.String,
  lockedContentHash: Schema.String,
  analysisPolicy: QualificationStatisticsPolicySchema,
}).check(
  Schema.makeFilter(
    ({ analysisPolicy, lockedContentHash, lockedSchemaVersion }) =>
      (lockedSchemaVersion === analysisPolicy.schemaVersion &&
        canonicalHashMatches(lockedContentHash, analysisPolicy)) ||
      ({ path: ['analysisPolicy'], issue: 'must match the immutable lock uncertainty policy' } as const),
  ),
)
const decodeQualificationPolicyBinding = Schema.decodeUnknownResult(
  QualificationPolicyBindingSchema,
  strictParseOptions,
)

export interface QualificationResultInput {
  readonly lock: QualificationLock
  readonly evaluationVerdict: EconomicVerdict
  readonly analysis: QualificationAnalysis
}

const constructQualificationResult = (
  input: QualificationResultInput,
): Result.Result<QualificationResult, QualificationConstructionFailure> => {
  const { analysis, evaluationVerdict, lock } = input
  if (lock.candidateRunId !== analysis.runId) {
    return Result.fail({
      _tag: 'QualificationRunIdMismatch',
      lockRunId: lock.candidateRunId,
      analysisRunId: analysis.runId,
    })
  }
  if (
    lock.priorTrialRunIds.length !== analysis.priorTrialRunIds.length ||
    lock.priorTrialRunIds.some((runId, index) => runId !== analysis.priorTrialRunIds.at(index))
  ) {
    return Result.fail({
      _tag: 'QualificationPriorTrialLineageMismatch',
      lockedRunIds: lock.priorTrialRunIds,
      analyzedRunIds: analysis.priorTrialRunIds,
    })
  }
  const policyBinding = decodeQualificationPolicyBinding({
    lockedSchemaVersion: lock.policies.uncertainty.schemaVersion,
    lockedContentHash: lock.policies.uncertainty.contentHash,
    analysisPolicy: analysis.policy,
  })
  if (Result.isFailure(policyBinding)) {
    return Result.fail({
      _tag: 'QualificationSchemaInvalid',
      operation: 'result',
      cause: policyBinding.failure,
    })
  }
  const economicReasons = evaluationVerdict.gates
    .filter((gate) => !gate.passed)
    .map((gate) => qualificationResultReasonCode(gate.name))
  const reasonCodes = [...new Set([...economicReasons, ...analysis.reasonCodes])].sort()
  const material = {
    schemaVersion: 'bayn.qualification-result.v2' as const,
    lockId: lock.lockId,
    runId: lock.candidateRunId,
    verdict:
      evaluationVerdict.status === 'PASS' && analysis.status === 'PASS'
        ? ('QUALIFIED' as const)
        : ('REJECTED' as const),
    evaluationVerdict,
    analysis,
    reasonCodes,
  }
  return pipe(
    hashQualificationMaterial('result-material', material),
    Result.flatMap((resultHash) =>
      pipe(
        decodeQualificationResult({ ...material, resultHash }),
        Result.mapError(
          (cause): QualificationConstructionFailure => ({
            _tag: 'QualificationSchemaInvalid',
            operation: 'result',
            cause,
          }),
        ),
      ),
    ),
  )
}

const makeQualificationResultDataFirst = (
  lock: QualificationLock,
  evaluationVerdict: EconomicVerdict,
  analysis: QualificationAnalysis,
): Result.Result<QualificationResult, QualificationConstructionFailure> =>
  constructQualificationResult({ lock, evaluationVerdict, analysis })

export const makeQualificationResult = Pipeable.dual(3, makeQualificationResultDataFirst)
