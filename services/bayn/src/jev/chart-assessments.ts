import { Schema } from 'effect'
import { Sha256Schema, SymbolSchema, UtcInstantSchema } from '../schemas'
import type { RetainedConditionalChartAssessmentsMaterial } from './retained-conditional-chart-questions'

export const Presence = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('ASSESSED'),
    probability: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  }),
  Schema.Struct({ status: Schema.Literal('REFUSED') }),
])
export const Anchor = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('ASSESSED'),
    barId: Schema.NonEmptyString,
    probability: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  }),
  Schema.Struct({ status: Schema.Literal('NOT_IDENTIFIED') }),
  Schema.Struct({ status: Schema.Literal('REFUSED') }),
])
export const ChartAssessmentsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.chart-assessments.v4'),
  symbol: SymbolSchema,
  windowEndAt: UtcInstantSchema,
  barsHash: Sha256Schema,
  pngHash: Sha256Schema,
  support: Schema.Struct({ presence: Presence, anchor: Anchor }),
  resistance: Schema.Struct({ presence: Presence, anchor: Anchor }),
  base: Schema.Struct({ presence: Presence, first: Anchor, last: Anchor }),
})
export type ChartAssessments = typeof ChartAssessmentsSchema.Type
export type ChartAssessmentsMaterial =
  | ChartAssessments
  | RetainedConditionalChartAssessmentsMaterial
  | import('./retained-funded-chart-questions').ChartAssessments
