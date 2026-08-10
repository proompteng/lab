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
import { Pipeable } from '../pipeable'

const decodeQualificationSeriesDataFirst = Schema.decodeUnknownResult(QualificationSeriesSchema, strictParseOptions)

export const decodeQualificationSeries = Pipeable.dual(1, (input: unknown) => decodeQualificationSeriesDataFirst(input))
const decodeQualificationStatisticsPolicyDataFirst = Schema.decodeUnknownResult(
  QualificationStatisticsPolicySchema,
  strictParseOptions,
)

export const decodeQualificationStatisticsPolicy = Pipeable.dual(1, (input: unknown) =>
  decodeQualificationStatisticsPolicyDataFirst(input),
)
const decodeQualificationPowerDataFirst = Schema.decodeUnknownResult(PowerAnalysisSchema, strictParseOptions)

export const decodeQualificationPower = Pipeable.dual(1, (input: unknown) => decodeQualificationPowerDataFirst(input))
const decodeQualificationAnalysisDataFirst = Schema.decodeUnknownResult(QualificationAnalysisSchema, strictParseOptions)

export const decodeQualificationAnalysis = Pipeable.dual(1, (input: unknown) =>
  decodeQualificationAnalysisDataFirst(input),
)
const decodePriorTrialRunIdsDataFirst = Schema.decodeUnknownResult(Schema.Array(Sha256Schema), strictParseOptions)

export const decodePriorTrialRunIds = Pipeable.dual(1, (input: unknown) => decodePriorTrialRunIdsDataFirst(input))

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
