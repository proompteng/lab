import { Schema } from 'effect'

import { PositiveIntegerSchema, Sha256Schema, SymbolSchema, UtcInstantSchema } from '../schemas'
import { EntryProposalSchema, type EntryProposal } from './entry-proposals'

const Price = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/))

export const JevStrategyExitPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-strategy-exit-plan.v4'),
  rule: Schema.Literal('source-anchored-complete-plan'),
  proposalId: Sha256Schema,
  source: EntryProposalSchema.fields.source,
  symbol: SymbolSchema,
  sourceStartAt: UtcInstantSchema,
  sourceEndAt: UtcInstantSchema,
  maximumHoldingMinutes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60)),
  maximumEntryPriceMicros: Price,
  stopPriceMicros: Price,
  stopLimitPriceMicros: Price,
  profitLimitPriceMicros: Price,
}).check(
  Schema.makeFilter((plan) =>
    BigInt(plan.stopLimitPriceMicros) <= BigInt(plan.stopPriceMicros) &&
    BigInt(plan.stopPriceMicros) < BigInt(plan.maximumEntryPriceMicros) &&
    BigInt(plan.maximumEntryPriceMicros) < BigInt(plan.profitLimitPriceMicros) &&
    Date.parse(plan.sourceStartAt) < Date.parse(plan.sourceEndAt)
      ? []
      : [{ path: [], issue: 'model exit prices and their pre-entry source window must be ordered' }],
  ),
)
export type JevStrategyExitPlan = typeof JevStrategyExitPlanSchema.Type

export const JevFundedExitPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-funded-exit-plan.v4'),
  levels: JevStrategyExitPlanSchema,
  maximumQuantityAtoms: Price,
  acquisitionCostMicros: Price,
  estimatedStopNetMicros: Price,
  estimatedTargetNetMicros: Price,
}).check(
  Schema.makeFilter((plan) =>
    BigInt(plan.acquisitionCostMicros) > BigInt(plan.estimatedStopNetMicros) &&
    BigInt(plan.estimatedTargetNetMicros) > BigInt(plan.acquisitionCostMicros)
      ? []
      : [
          {
            path: [],
            issue: 'the funded model plan must cover execution fees and preserve ordered loss and profit estimates',
          },
        ],
  ),
)
export type JevFundedExitPlan = typeof JevFundedExitPlanSchema.Type

export const entryProposalExitPlan = (proposal: EntryProposal): JevFundedExitPlan => ({
  schemaVersion: 'bayn.jev-funded-exit-plan.v4',
  levels: {
    schemaVersion: 'bayn.jev-strategy-exit-plan.v4',
    rule: 'source-anchored-complete-plan',
    proposalId: proposal.proposalId,
    source: proposal.source,
    symbol: proposal.symbol,
    sourceStartAt: proposal.sourceStartAt,
    sourceEndAt: proposal.sourceEndAt,
    maximumHoldingMinutes: proposal.maximumHoldingMinutes,
    maximumEntryPriceMicros: proposal.maximumEntryPriceMicros,
    stopPriceMicros: proposal.stopPriceMicros,
    stopLimitPriceMicros: proposal.stopLimitPriceMicros,
    profitLimitPriceMicros: proposal.profitLimitPriceMicros,
  },
  maximumQuantityAtoms: proposal.funding.maximumQuantityAtoms,
  acquisitionCostMicros: proposal.funding.acquisitionCostMicros,
  estimatedStopNetMicros: proposal.funding.estimatedStopNetMicros,
  estimatedTargetNetMicros: proposal.funding.estimatedTargetNetMicros,
})
