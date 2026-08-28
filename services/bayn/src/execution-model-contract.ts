import { Schema } from 'effect'

import {
  NonNegativeFiniteSchema as NonNegativeFinite,
  PositiveMicrosSchema as PositiveMicros,
  UnsignedMicrosSchema as UnsignedMicros,
} from './schemas'

const BasisPoints = NonNegativeFinite.check(Schema.isLessThanOrEqualTo(10_000))
const PartsPerMillion = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
const SubmissionCutoffLeadMinutes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 }))
const IntradayOrderOffsetMs = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 }))
const US_EQUITY_REGULAR_SESSION_DURATION_MS = 6.5 * 60 * 60 * 1_000

const ExecutionModelCommon = {
  assetClass: Schema.Literal('us-equity'),
  precision: Schema.Struct({
    quantityIncrementMicros: PositiveMicros,
    priceIncrementMicros: PositiveMicros,
    minimumBuyNotionalMicros: PositiveMicros,
  }),
  priceImpact: Schema.Struct({
    halfSpreadBps: BasisPoints,
    slippageBps: BasisPoints,
  }),
  fees: Schema.Struct({
    scheduleVersion: Schema.Literal('alpaca-brokerage-2026-07-01'),
    commissionBps: BasisPoints,
    secSellBps: BasisPoints,
    tafSellPerShareMicros: UnsignedMicros,
    tafMaximumPerOrderMicros: PositiveMicros,
    catPerShareMicros: UnsignedMicros,
    aggregation: Schema.Literal('session-by-fee-type'),
    roundingIncrementMicros: PositiveMicros,
  }),
  cash: Schema.Struct({
    annualYieldBps: BasisPoints,
    dayCount: Schema.Literal('actual-365'),
    accrual: Schema.Literal('session-open'),
  }),
  partialFills: Schema.Struct({
    policy: Schema.Literal('deterministic-hash'),
    probabilityPpm: PartsPerMillion,
    filledFractionPpm: PartsPerMillion,
    remainder: Schema.Literal('cancel'),
  }),
  doubleCostMultiplier: Schema.Literal(2),
} as const

const ExecutionModelV1Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-model.v1'),
  venue: Schema.Literal('alpaca-paper'),
  ...ExecutionModelCommon,
  order: Schema.Struct({
    type: Schema.Literal('market'),
    timeInForce: Schema.Literal('day'),
    extendedHours: Schema.Literal(false),
    submitAfter: Schema.Literal('signal-session-close'),
    submitBefore: Schema.Literal('next-session-open'),
    priceReference: Schema.Literal('next-session-open'),
  }),
})

const ExecutionModelV2Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-model.v2'),
  venue: Schema.Literal('alpaca-paper'),
  ...ExecutionModelCommon,
  order: Schema.Struct({
    type: Schema.Literal('market'),
    timeInForce: Schema.Literal('day'),
    extendedHours: Schema.Literal(false),
    planAfter: Schema.Literal('signal-session-finalized'),
    submitAfter: Schema.Literal('plan-committed'),
    submitBefore: Schema.Literal('fixed-pre-open-cutoff'),
    planningPriceReference: Schema.Literal('signal-session-close'),
    planningBrokerStateReference: Schema.Literal('reconciled-pre-plan-broker-state'),
    fillPriceReference: Schema.Literal('next-session-open'),
    buyingPowerPolicy: Schema.Literal('pre-submit-cash-without-sell-proceeds'),
    submissionCutoffLeadMinutes: SubmissionCutoffLeadMinutes,
  }),
})

const ExecutionModelV3Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-model.v3'),
  venue: Schema.Literal('alpaca-us-equity'),
  ...ExecutionModelCommon,
  order: ExecutionModelV2Base.fields.order,
})

const ExecutionModelV4Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-model.v4'),
  venue: Schema.Literal('alpaca-us-equity'),
  ...ExecutionModelCommon,
  order: Schema.Struct({
    type: Schema.Literal('limit'),
    timeInForce: Schema.Literal('ioc'),
    extendedHours: Schema.Literal(false),
    planAfter: Schema.Literal('verified-opening-range'),
    submitAfter: Schema.Literal('plan-committed'),
    submitBefore: Schema.Literal('intraday-entry-cutoff'),
    planningPriceReference: Schema.Literal('verified-adverse-top-of-book'),
    planningBrokerStateReference: Schema.Literal('reconciled-pre-plan-broker-state'),
    fillPriceReference: Schema.Literal('limit-or-better'),
    buyingPowerPolicy: Schema.Literal('pre-submit-cash-without-sell-proceeds'),
    decisionAfterOpenMs: IntradayOrderOffsetMs,
    submissionCutoffAfterOpenMs: IntradayOrderOffsetMs,
  }),
})

const ExecutionModelV5Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-model.v5'),
  venue: Schema.Literal('alpaca-us-equity'),
  ...ExecutionModelCommon,
  order: Schema.Struct({
    type: Schema.Literal('limit'),
    timeInForce: Schema.Literal('ioc'),
    extendedHours: Schema.Literal(false),
    planAfter: Schema.Literal('verified-intraday-window'),
    submitAfter: Schema.Literal('plan-committed'),
    submitBefore: Schema.Literal('intraday-entry-cutoff'),
    planningPriceReference: Schema.Literal('verified-adverse-top-of-book'),
    planningBrokerStateReference: Schema.Literal('reconciled-pre-plan-broker-state'),
    fillPriceReference: Schema.Literal('limit-or-better'),
    buyingPowerPolicy: Schema.Literal('pre-submit-cash-without-sell-proceeds'),
    warmupAfterOpenMs: IntradayOrderOffsetMs,
    submissionCutoffBeforeCloseMs: IntradayOrderOffsetMs,
  }),
})

const executionModelIssues = (
  model:
    | typeof ExecutionModelV1Base.Type
    | typeof ExecutionModelV2Base.Type
    | typeof ExecutionModelV3Base.Type
    | typeof ExecutionModelV4Base.Type
    | typeof ExecutionModelV5Base.Type,
): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (model.partialFills.probabilityPpm > 0 && model.partialFills.filledFractionPpm === 0) {
    issues.push({
      path: ['partialFills', 'filledFractionPpm'],
      issue: 'must be positive when partial fills are enabled',
    })
  }
  if (model.partialFills.filledFractionPpm >= 1_000_000) {
    issues.push({ path: ['partialFills', 'filledFractionPpm'], issue: 'must describe a partial, not complete, fill' })
  }
  if (
    model.schemaVersion === 'bayn.execution-model.v4' &&
    model.order.decisionAfterOpenMs >= model.order.submissionCutoffAfterOpenMs
  ) {
    issues.push({
      path: ['order', 'submissionCutoffAfterOpenMs'],
      issue: 'must follow the opening-drive decision boundary',
    })
  }
  if (
    model.schemaVersion === 'bayn.execution-model.v5' &&
    model.order.warmupAfterOpenMs + model.order.submissionCutoffBeforeCloseMs >= US_EQUITY_REGULAR_SESSION_DURATION_MS
  ) {
    issues.push({
      path: ['order'],
      issue: 'must leave a non-empty regular-session decision interval',
    })
  }
  return issues
}

export const ExecutionModelV1Schema = ExecutionModelV1Base.check(Schema.makeFilter(executionModelIssues))
export const ExecutionModelV2Schema = ExecutionModelV2Base.check(Schema.makeFilter(executionModelIssues))
export const ExecutionModelV3Schema = ExecutionModelV3Base.check(Schema.makeFilter(executionModelIssues))
export const ExecutionModelV4Schema = ExecutionModelV4Base.check(Schema.makeFilter(executionModelIssues))
export const ExecutionModelV5Schema = ExecutionModelV5Base.check(Schema.makeFilter(executionModelIssues))
export const DailyExecutionModelSchema = Schema.Union([ExecutionModelV2Schema, ExecutionModelV3Schema])
export const SupportedExecutionModelSchema = DailyExecutionModelSchema
export const CycleExecutionModelSchema = Schema.Union([
  ExecutionModelV2Schema,
  ExecutionModelV3Schema,
  ExecutionModelV4Schema,
])
export const ExecutionModelSchema = Schema.Union([
  ExecutionModelV1Schema,
  ExecutionModelV2Schema,
  ExecutionModelV3Schema,
  ExecutionModelV4Schema,
  ExecutionModelV5Schema,
])
export type DailyExecutionModel = typeof DailyExecutionModelSchema.Type
export type SupportedExecutionModel = typeof SupportedExecutionModelSchema.Type
export type CycleExecutionModel = typeof CycleExecutionModelSchema.Type
export type ExecutionModel = typeof ExecutionModelSchema.Type

export const isSupportedExecutionModel = (model: ExecutionModel): model is SupportedExecutionModel =>
  model.schemaVersion === 'bayn.execution-model.v2' || model.schemaVersion === 'bayn.execution-model.v3'
