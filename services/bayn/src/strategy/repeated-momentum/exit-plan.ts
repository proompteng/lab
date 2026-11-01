import { Result, Schema } from 'effect'

import { quantizeInstrumentPriceMicros } from '../../broker/alpaca-price'
import { effectiveCryptoFeeTier } from '../../broker/crypto-fees'
import { canonicalHashV1Result } from '../../hash'
import { JevContractError } from '../../jev/contract'
import { jevEntryEconomics } from '../../jev/entry-economics'
import { jevBreakEvenExitLimitPrice, jevExitLimitValue } from '../../jev/liquidation-economics'
import type { reproduceJevCandidateObservation } from '../../jev/observation'
import { JevFundedExitPlanSchema, JevStrategyExitPlanSchema } from '../../jev/strategy-exit-plan'
import { Sha256Schema, strictParseOptions } from '../../schemas'
import { priceNumberToMicros } from '../execution-model/fixed-point'
import { momentumExitDefinition, type RepeatedMomentumPolicy } from './policy'

export const momentumRequiredTargetNet = (acquisitionCostMicros: bigint): bigint =>
  (acquisitionCostMicros * BigInt(10_000 + momentumExitDefinition.profitTargetNetBps) + 9999n) / 10_000n

const { proposalId: _proposalId, source: _chartSource, ...levelFields } = JevStrategyExitPlanSchema.fields
export const MomentumExitLevelsSchema = Schema.Struct({
  ...levelFields,
  schemaVersion: Schema.Literal('bayn.momentum-exit-levels.v1'),
  rule: Schema.Literal('FROZEN_RELATIVE_MOMENTUM_BRACKET'),
  planId: Sha256Schema,
  source: Schema.Struct({ observationHash: Sha256Schema, policyHash: Sha256Schema, quoteHash: Sha256Schema }),
}).check(
  Schema.makeFilter((plan) => {
    const { planId, ...material } = plan
    const hash = canonicalHashV1Result(material)
    return Result.isSuccess(hash) &&
      hash.success === planId &&
      BigInt(plan.stopLimitPriceMicros) <= BigInt(plan.stopPriceMicros) &&
      BigInt(plan.stopPriceMicros) < BigInt(plan.maximumEntryPriceMicros) &&
      BigInt(plan.maximumEntryPriceMicros) < BigInt(plan.profitLimitPriceMicros) &&
      plan.sourceStartAt < plan.sourceEndAt
      ? []
      : [{ path: [], issue: 'momentum exit prices and source window must be ordered and reproduce their identity' }]
  }),
)

export const MomentumFundedExitPlanSchema = Schema.Struct({
  ...JevFundedExitPlanSchema.fields,
  schemaVersion: Schema.Literal('bayn.momentum-funded-exit-plan.v1'),
  levels: MomentumExitLevelsSchema,
}).check(
  Schema.makeFilter((plan) =>
    BigInt(plan.estimatedStopNetMicros) < BigInt(plan.acquisitionCostMicros) &&
    momentumRequiredTargetNet(BigInt(plan.acquisitionCostMicros)) <= BigInt(plan.estimatedTargetNetMicros)
      ? []
      : [{ path: [], issue: 'momentum funding must retain a possible loss and meet the frozen fee-inclusive target' }],
  ),
)
export type MomentumFundedExitPlan = typeof MomentumFundedExitPlanSchema.Type

/** A funded bracket is an admissible contingent order, not evidence of positive expected profit. */
export const makeMomentumFundedExitPlan = (
  policy: RepeatedMomentumPolicy,
  observation: Result.Result.Success<ReturnType<typeof reproduceJevCandidateObservation>>,
  symbol: string,
) =>
  Result.gen(function* () {
    const protocol = policy.sharedProtocol
    const quote = observation.snapshot.latestQuotes[symbol]
    if (quote === undefined)
      return yield* Result.fail(new JevContractError({ message: 'Momentum funding requires its verified quote' }))
    const bid = yield* priceNumberToMicros(quote.bidPrice, 'momentum bid', 'DOWN')
    const ask = yield* priceNumberToMicros(quote.askPrice, 'momentum ask', 'UP')
    const account = observation.portfolio.brokerState.account
    const economics = yield* jevEntryEconomics({
      feeAt: observation.observedAt,
      protocol,
      symbol,
      bidMicros: bid,
      askMicros: ask,
      capitalMicros: account.equityMicros,
      cryptoFeeTier: effectiveCryptoFeeTier(account.cryptoFeeTier, account.observedAt, observation.observedAt),
    })
    if (economics === null) return null
    const entry = BigInt(economics.maximumEntryPriceMicros)
    const stop = quantizeInstrumentPriceMicros(
      symbol,
      (entry * BigInt(10_000 - policy.exits.protectiveStopBps)) / 10_000n,
      'DOWN',
    )
    const stopLimit = quantizeInstrumentPriceMicros(
      symbol,
      (stop * BigInt(10_000 - protocol.maximumEntryLimitSlippageBps) + 9999n) / 10_000n,
      'UP',
    )
    if (stopLimit <= 0n || stopLimit > stop || stop >= bid) return null
    const liquidation = { protocol, symbol, quantityAtoms: BigInt(economics.receivedQuantityAtoms) }
    const requiredNet = momentumRequiredTargetNet(BigInt(economics.acquisitionCostMicros))
    const target = quantizeInstrumentPriceMicros(
      symbol,
      yield* jevBreakEvenExitLimitPrice({
        feeAt: observation.observedAt,
        ...liquidation,
        acquisitionCostMicros: requiredNet,
        upperLimitPriceMicros: entry * 2n,
      }),
      'UP',
    )
    const stopValue = yield* jevExitLimitValue({
      feeAt: observation.observedAt,
      ...liquidation,
      limitPriceMicros: stopLimit,
    })
    const targetValue = yield* jevExitLimitValue({
      feeAt: observation.observedAt,
      ...liquidation,
      limitPriceMicros: target,
    })
    if (
      stopValue.conservativeNetMicros <= 0n ||
      stopValue.conservativeNetMicros >= BigInt(economics.acquisitionCostMicros) ||
      targetValue.conservativeNetMicros < requiredNet
    )
      return null
    const levels = {
      schemaVersion: 'bayn.momentum-exit-levels.v1' as const,
      rule: 'FROZEN_RELATIVE_MOMENTUM_BRACKET' as const,
      source: {
        observationHash: observation.contentHash,
        policyHash: yield* canonicalHashV1Result(policy),
        quoteHash: yield* canonicalHashV1Result(quote),
      },
      symbol,
      sourceStartAt: observation.snapshot.manifest.rangeStartAt,
      sourceEndAt: observation.snapshot.manifest.rangeEndAt,
      maximumHoldingMinutes: protocol.maximumHoldingMinutes,
      maximumEntryPriceMicros: entry.toString(),
      stopPriceMicros: stop.toString(),
      stopLimitPriceMicros: stopLimit.toString(),
      profitLimitPriceMicros: target.toString(),
    }
    const plan = yield* Schema.decodeUnknownResult(
      MomentumFundedExitPlanSchema,
      strictParseOptions,
    )({
      schemaVersion: 'bayn.momentum-funded-exit-plan.v1',
      levels: { ...levels, planId: yield* canonicalHashV1Result(levels) },
      maximumQuantityAtoms: economics.maximumQuantityAtoms,
      acquisitionCostMicros: economics.acquisitionCostMicros,
      estimatedStopNetMicros: stopValue.conservativeNetMicros.toString(),
      estimatedTargetNetMicros: targetValue.conservativeNetMicros.toString(),
    })
    return { plan, weight: economics.maximumTargetWeight }
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Momentum entry funding could not be established', cause }),
    ),
  )
