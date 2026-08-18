import { Result } from 'effect'

import { makeQualificationDiagnosisResult, type QualificationDiagnosis } from './qualification-diagnosis'
import type { QualificationResult } from './qualification'
import type { EvaluationSummary } from './types'

export const makeQualificationDiagnosis = (
  evaluation: EvaluationSummary,
  result: QualificationResult,
): QualificationDiagnosis => Result.getOrThrow(makeQualificationDiagnosisResult(evaluation, result))
