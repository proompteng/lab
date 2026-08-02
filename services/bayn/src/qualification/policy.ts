import { pipe, Result, Schema } from 'effect'

import { defaultQualificationStatisticsPolicy } from '../qualification-statistics/policy'
import { strictParseOptions } from '../schemas'
import type { QualificationConstructionFailure } from './failure'
import { hashQualificationMaterial } from './hashing'
import { QualificationPolicyDocumentSchema, type QualificationPolicyDocument } from './model'

const decodeQualificationPolicyDocument = Schema.decodeUnknownResult(
  QualificationPolicyDocumentSchema,
  strictParseOptions,
)

export const makeQualificationPolicyDocument = (
  schemaVersion: string,
  content: unknown,
): Result.Result<QualificationPolicyDocument, QualificationConstructionFailure> =>
  pipe(
    hashQualificationMaterial('policy-content', content),
    Result.flatMap((contentHash) =>
      pipe(
        decodeQualificationPolicyDocument({ schemaVersion, contentHash, content }),
        Result.mapError(
          (cause): QualificationConstructionFailure => ({
            _tag: 'QualificationSchemaInvalid',
            operation: 'policy-document',
            cause,
          }),
        ),
      ),
    ),
  )

export const defaultQualificationStatisticsPolicyDocument = makeQualificationPolicyDocument(
  defaultQualificationStatisticsPolicy.schemaVersion,
  defaultQualificationStatisticsPolicy,
)
