import { Result, pipe } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import type { ExecutionModel } from '../../execution-model-contract'
import type { OrderRejectionReason, OrderStatus } from '../../evidence-contracts'
import {
  ceilDiv,
  ensureUnsigned,
  fail,
  integerNumber,
  notionalMicros,
  quantizeDown,
  quantizeUp,
  scaledNumber,
  type ExecutionResult,
} from './fixed-point'
import { BPS, MICROS, PPM, type ExecutionModelFailure } from './model'

const impactedDelta = (
  referencePriceMicros: bigint,
  basisPoints: number,
  costMultiplierMicros: bigint,
): ExecutionResult<bigint> =>
  pipe(
    scaledNumber(basisPoints, 'execution cost basis points'),
    Result.flatMap((basisPointMicros) =>
      ceilDiv(referencePriceMicros * basisPointMicros * costMultiplierMicros, BPS * MICROS * MICROS),
    ),
  )

export interface FillTerms {
  readonly referencePriceMicros: bigint
  readonly fillPriceMicros: bigint
  readonly notionalMicros: bigint
  readonly spreadCostMicros: bigint
  readonly slippageCostMicros: bigint
}

export const makeFillTerms = (
  side: 'buy' | 'sell',
  quantityMicros: bigint,
  referencePrice: bigint,
  model: ExecutionModel,
  costMultiplierMicros: bigint,
): ExecutionResult<FillTerms> => {
  const invalid = <A>(
    reason: Extract<ExecutionModelFailure, { readonly _tag: 'InvalidFillTerms' }>['reason'],
  ): ExecutionResult<A> =>
    fail({
      _tag: 'InvalidFillTerms',
      side,
      quantityMicros,
      referencePriceMicros: referencePrice,
      costMultiplierMicros,
      reason,
    })
  if (quantityMicros <= 0n || referencePrice <= 0n) return invalid('invalid-quantity-or-price')
  if (costMultiplierMicros <= 0n) return invalid('invalid-cost-multiplier')

  return pipe(
    Result.all({
      increment: ensureUnsigned(model.precision.priceIncrementMicros, 'price increment', 1n),
      spreadDelta: impactedDelta(referencePrice, model.priceImpact.halfSpreadBps, costMultiplierMicros),
      slippageDelta: impactedDelta(referencePrice, model.priceImpact.slippageBps, costMultiplierMicros),
    }),
    Result.flatMap(({ increment, spreadDelta, slippageDelta }) => {
      const spreadPrice = pipe(
        side === 'buy'
          ? quantizeUp(referencePrice + spreadDelta, increment)
          : quantizeDown(referencePrice > spreadDelta ? referencePrice - spreadDelta : 0n, increment),
        Result.flatMap((price) => {
          if (price <= 0n) return invalid<bigint>('costs-consume-reference-price')
          return Result.succeed(price)
        }),
      )
      return pipe(
        spreadPrice,
        Result.flatMap((quantizedSpreadPrice) =>
          pipe(
            side === 'buy'
              ? quantizeUp(referencePrice + spreadDelta + slippageDelta, increment)
              : quantizeDown(
                  referencePrice > spreadDelta + slippageDelta ? referencePrice - spreadDelta - slippageDelta : 0n,
                  increment,
                ),
            Result.flatMap((fillPrice) => {
              if (fillPrice <= 0n) return invalid<FillTerms>('costs-consume-reference-price')
              return pipe(
                Result.all({
                  notional: notionalMicros(quantityMicros, fillPrice),
                  spreadCost: notionalMicros(
                    quantityMicros,
                    quantizedSpreadPrice > referencePrice
                      ? quantizedSpreadPrice - referencePrice
                      : referencePrice - quantizedSpreadPrice,
                  ),
                  slippageCost: notionalMicros(
                    quantityMicros,
                    fillPrice > quantizedSpreadPrice
                      ? fillPrice - quantizedSpreadPrice
                      : quantizedSpreadPrice - fillPrice,
                  ),
                }),
                Result.map(
                  ({ notional, spreadCost, slippageCost }): FillTerms => ({
                    referencePriceMicros: referencePrice,
                    fillPriceMicros: fillPrice,
                    notionalMicros: notional,
                    spreadCostMicros: spreadCost,
                    slippageCostMicros: slippageCost,
                  }),
                ),
              )
            }),
          ),
        ),
      )
    }),
  )
}

export interface OrderOutcome {
  readonly requestedQuantityMicros: bigint
  readonly filledQuantityMicros: bigint
  readonly status: OrderStatus
  readonly rejectionReason: OrderRejectionReason | null
  readonly unfilledRemainder: 'none' | 'canceled'
}

export interface OrderOutcomeInput {
  readonly identity: unknown
  readonly side: 'buy' | 'sell'
  readonly requestedQuantityMicros: bigint
  readonly referencePriceMicros: bigint
  readonly model: ExecutionModel
  readonly forceFullFill?: boolean
}

export const makeOrderOutcome = (input: OrderOutcomeInput): ExecutionResult<OrderOutcome> =>
  pipe(
    ensureUnsigned(input.model.precision.quantityIncrementMicros, 'quantity increment', 1n),
    Result.flatMap((quantityIncrement) =>
      pipe(
        quantizeDown(input.requestedQuantityMicros, quantityIncrement),
        Result.map((requested) => ({ quantityIncrement, requested })),
      ),
    ),
    Result.flatMap(({ quantityIncrement, requested }) => {
      const reject = (reason: OrderRejectionReason): OrderOutcome => ({
        requestedQuantityMicros: requested,
        filledQuantityMicros: 0n,
        status: 'rejected',
        rejectionReason: reason,
        unfilledRemainder: 'canceled',
      })
      if (requested === 0n) return Result.succeed(reject('zero-after-rounding'))

      const belowMinimumBuyNotional =
        input.side === 'sell'
          ? Result.succeed(false)
          : pipe(
              notionalMicros(requested, input.referencePriceMicros),
              Result.flatMap((requestedNotional) =>
                pipe(
                  ensureUnsigned(input.model.precision.minimumBuyNotionalMicros, 'minimum buy notional'),
                  Result.map((minimumBuyNotional) => requestedNotional < minimumBuyNotional),
                ),
              ),
            )
      return pipe(
        belowMinimumBuyNotional,
        Result.flatMap((belowMinimum) => {
          if (belowMinimum) return Result.succeed(reject('below-minimum-buy-notional'))
          return pipe(
            integerNumber(input.model.partialFills.probabilityPpm, 'partial fill probability', 0, Number(PPM)),
            Result.flatMap((probability) =>
              pipe(
                Result.mapError(
                  canonicalHashV1Result(input.identity),
                  (cause): ExecutionModelFailure => ({
                    _tag: 'OrderOutcomeCanonicalizationFailed',
                    identity: input.identity,
                    cause,
                  }),
                ),
                Result.flatMap((identityHash) => {
                  const bucket = BigInt(`0x${identityHash.slice(0, 16)}`) % PPM
                  if (input.forceFullFill === true || bucket >= probability) {
                    return Result.succeed({
                      requestedQuantityMicros: requested,
                      filledQuantityMicros: requested,
                      status: 'filled',
                      rejectionReason: null,
                      unfilledRemainder: 'none',
                    })
                  }
                  return pipe(
                    integerNumber(input.model.partialFills.filledFractionPpm, 'partial fill fraction', 0, Number(PPM)),
                    Result.flatMap((filledFraction) =>
                      quantizeDown((requested * filledFraction) / PPM, quantityIncrement),
                    ),
                    Result.map(
                      (filled): OrderOutcome =>
                        filled === 0n
                          ? reject('zero-after-rounding')
                          : {
                              requestedQuantityMicros: requested,
                              filledQuantityMicros: filled,
                              status: 'partially-filled',
                              rejectionReason: null,
                              unfilledRemainder: 'canceled',
                            },
                    ),
                  )
                }),
              ),
            ),
          )
        }),
      )
    }),
  )
