import { Schema } from 'effect'

import { Sha256Schema } from '../contracts'
import { strictParseOptions } from '../schemas'
import type { QualificationStatisticsFailure } from './failure'
import {
  PowerAnalysisSchema,
  QualificationAnalysisSchema,
  QualificationSeriesSchema,
  QualificationStatisticsPolicySchema,
} from './model'

export const decodeQualificationSeries = Schema.decodeUnknownResult(QualificationSeriesSchema, strictParseOptions)
export const decodeQualificationStatisticsPolicy = Schema.decodeUnknownResult(
  QualificationStatisticsPolicySchema,
  strictParseOptions,
)
export const decodeQualificationPower = Schema.decodeUnknownResult(PowerAnalysisSchema, strictParseOptions)
export const decodeQualificationAnalysis = Schema.decodeUnknownResult(QualificationAnalysisSchema, strictParseOptions)
export const decodePriorTrialRunIds = Schema.decodeUnknownResult(Schema.Array(Sha256Schema), strictParseOptions)

export const qualificationStatisticsSchemaFailure =
  (
    operation: Extract<
      QualificationStatisticsFailure,
      { readonly _tag: 'QualificationStatisticsSchemaInvalid' }
    >['operation'],
  ) =>
  (cause: Schema.SchemaError): QualificationStatisticsFailure => ({
    _tag: 'QualificationStatisticsSchemaInvalid',
    operation,
    cause,
  })
