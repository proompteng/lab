import { Schema } from 'effect'

import {
  NonNegativeFiniteSchema as NonNegativeFinite,
  PositiveMicrosSchema as PositiveMicros,
  UnsignedMicrosSchema as UnsignedMicros,
} from './schemas'

const BasisPoints = NonNegativeFinite.check(Schema.isLessThanOrEqualTo(10_000))
const PartsPerMillion = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
const SubmissionCutoffLeadMinutes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 }))

const ExecutionModelCommon = {
  venue: Schema.Literal('alpaca-paper'),
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

const executionModelIssues = (
  model: typeof ExecutionModelV1Base.Type | typeof ExecutionModelV2Base.Type,
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
  return issues
}

export const ExecutionModelV1Schema = ExecutionModelV1Base.check(Schema.makeFilter(executionModelIssues))
export const ExecutionModelV2Schema = ExecutionModelV2Base.check(Schema.makeFilter(executionModelIssues))
export const ExecutionModelSchema = Schema.Union([ExecutionModelV1Schema, ExecutionModelV2Schema])
export type ExecutionModel = typeof ExecutionModelSchema.Type
