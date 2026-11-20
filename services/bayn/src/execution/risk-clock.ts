import { Data, Result, Schema } from 'effect'
import { isSqlError } from 'effect/sql/SqlError'

import { Sha256Schema, UtcDatabaseInstantSchema, strictParseOptions } from '../schemas'
import type { Intent, RiskDecision } from './contracts'

const evidenceFields = {
  schemaVersion: Schema.Literal('bayn.intent-risk-clock-rejection.v1'),
  intentId: Sha256Schema,
  decisionId: Sha256Schema,
  decidedAt: UtcDatabaseInstantSchema,
  expiresAt: UtcDatabaseInstantSchema,
  updatedAt: UtcDatabaseInstantSchema,
  checkedAt: UtcDatabaseInstantSchema,
} as const

export const ExpiredRiskClockEvidenceSchema = Schema.Struct({
  ...evidenceFields,
  violation: Schema.Literal('EXPIRED'),
})

export const IntentRiskClockRejectionSchema = Schema.Union([
  ExpiredRiskClockEvidenceSchema,
  Schema.Struct({ ...evidenceFields, violation: Schema.Literal('NOT_YET_VALID') }),
])

export class ExpiredIntentRiskDecision extends Data.TaggedError('ExpiredIntentRiskDecision')<{
  readonly evidence: typeof ExpiredRiskClockEvidenceSchema.Type
  readonly cause: unknown
}> {}

const RiskClockDatabaseError = Schema.Struct({
  code: Schema.Literal('23514'),
  constraint: Schema.Literal('intents_current_risk_decision'),
  detail: Schema.String,
})
const decodeEvidence = Schema.decodeUnknownResult(
  Schema.fromJsonString(IntentRiskClockRejectionSchema),
  strictParseOptions,
)

export const expiredRiskClockRejection = (
  cause: unknown,
  expected: Pick<Intent, 'intentId'> & Pick<RiskDecision, 'decisionId' | 'decidedAt' | 'expiresAt'>,
): ExpiredIntentRiskDecision | undefined => {
  if (!isSqlError(cause) || cause.reason._tag !== 'ConstraintError') return undefined
  const database = Schema.decodeUnknownResult(RiskClockDatabaseError)(cause.reason.cause)
  if (Result.isFailure(database)) return undefined
  const decoded = decodeEvidence(database.success.detail)
  if (Result.isFailure(decoded) || decoded.success.violation !== 'EXPIRED') return undefined
  const evidence = decoded.success
  if (
    evidence.intentId !== expected.intentId ||
    evidence.decisionId !== expected.decisionId ||
    evidence.decidedAt.replace(/(\.\d{3})000Z$/, '$1Z') !== expected.decidedAt ||
    evidence.expiresAt.replace(/(\.\d{3})000Z$/, '$1Z') !== expected.expiresAt
  )
    return undefined
  return new ExpiredIntentRiskDecision({ evidence, cause })
}
