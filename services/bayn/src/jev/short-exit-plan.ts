import { Schema } from 'effect'

import {
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SignedMicrosSchema,
  SymbolSchema,
  UtcInstantSchema,
} from '../schemas'
import { ShortEntrySourceSchema, type ShortEntryProposal } from './short-entry'
import { instrumentMarket, MarketKind } from '../instruments'
import { quantityScale } from '../quantity'

export const ShortStrategyExitPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-short-strategy-exit-plan.v1'),
  positionSide: Schema.Literal('SHORT'),
  rule: Schema.Literal('source-anchored-complete-plan'),
  proposalId: Sha256Schema,
  source: ShortEntrySourceSchema,
  symbol: SymbolSchema,
  sourceStartAt: UtcInstantSchema,
  sourceEndAt: UtcInstantSchema,
  maximumHoldingMinutes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60)),
  minimumEntryPriceMicros: PositiveMicrosSchema,
  stopPriceMicros: PositiveMicrosSchema,
  stopLimitPriceMicros: PositiveMicrosSchema,
  profitLimitPriceMicros: PositiveMicrosSchema,
}).check(
  Schema.makeFilter((plan) =>
    instrumentMarket(plan.symbol) === MarketKind.Equity &&
    Date.parse(plan.sourceStartAt) < Date.parse(plan.sourceEndAt) &&
    BigInt(plan.profitLimitPriceMicros) < BigInt(plan.minimumEntryPriceMicros) &&
    BigInt(plan.minimumEntryPriceMicros) < BigInt(plan.stopPriceMicros) &&
    BigInt(plan.stopPriceMicros) <= BigInt(plan.stopLimitPriceMicros)
      ? []
      : [{ path: [], issue: 'short cover prices and pre-entry source window must be ordered' }],
  ),
)

export const ShortFundedExitPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-short-funded-exit-plan.v1'),
  levels: ShortStrategyExitPlanSchema,
  maximumQuantityAtoms: PositiveMicrosSchema,
  saleNetProceedsMicros: PositiveMicrosSchema,
  collateralMicros: PositiveMicrosSchema,
  estimatedStopPnlMicros: SignedMicrosSchema,
  estimatedTargetPnlMicros: SignedMicrosSchema,
}).check(
  Schema.makeFilter((plan) =>
    BigInt(plan.maximumQuantityAtoms) % quantityScale === 0n &&
    BigInt(plan.estimatedStopPnlMicros) < 0n &&
    BigInt(plan.estimatedTargetPnlMicros) > 0n
      ? []
      : [{ path: [], issue: 'short plan must fund a possible loss and a fee-inclusive target profit' }],
  ),
)
export type ShortFundedExitPlan = typeof ShortFundedExitPlanSchema.Type

export const shortEntryProposalExitPlan = (proposal: ShortEntryProposal): ShortFundedExitPlan => ({
  schemaVersion: 'bayn.jev-short-funded-exit-plan.v1',
  levels: {
    schemaVersion: 'bayn.jev-short-strategy-exit-plan.v1',
    positionSide: 'SHORT',
    rule: 'source-anchored-complete-plan',
    proposalId: proposal.proposalId,
    source: proposal.source,
    symbol: proposal.symbol,
    sourceStartAt: proposal.sourceStartAt,
    sourceEndAt: proposal.sourceEndAt,
    maximumHoldingMinutes: proposal.maximumHoldingMinutes,
    minimumEntryPriceMicros: proposal.minimumEntryPriceMicros,
    stopPriceMicros: proposal.stopPriceMicros,
    stopLimitPriceMicros: proposal.stopLimitPriceMicros,
    profitLimitPriceMicros: proposal.profitLimitPriceMicros,
  },
  maximumQuantityAtoms: proposal.funding.maximumQuantityAtoms,
  saleNetProceedsMicros: proposal.funding.saleNetProceedsMicros,
  collateralMicros: proposal.funding.collateralMicros,
  estimatedStopPnlMicros: proposal.funding.estimatedStopPnlMicros,
  estimatedTargetPnlMicros: proposal.funding.estimatedTargetPnlMicros,
})
