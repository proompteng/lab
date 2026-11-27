import { Result } from 'effect'

import { instrumentMarket, MarketKind } from '../instruments'
import type { ExecutionModel } from '../execution-model-contract'
import { quantityScale, quantityFromNumber } from '../quantity'
import { desiredQuantityAtoms } from '../strategy/execution-model/fixed-point'
import type { FundedEntryExitPlan } from '../strategy/funded-exit-plan'
import { JevContractError } from './contract'

const isShortFundedExitPlan = (plan: FundedEntryExitPlan): boolean =>
  plan.schemaVersion === 'bayn.jev-short-funded-exit-plan.v1' ||
  plan.schemaVersion === 'bayn.intraday-alpha-short-funded-exit-plan.v1'

export const maximumAllocatedBuyQuantities = (input: {
  readonly askPriceMicros: Readonly<Record<string, string>>
  readonly targetWeights: Readonly<Record<string, number>>
  readonly capitalMicros: string
  readonly precision: ExecutionModel['precision']
}) =>
  Result.gen(function* () {
    const quantities: Record<string, string> = {}
    for (const [symbol, weight] of Object.entries(input.targetWeights).sort(([a], [b]) => a.localeCompare(b))) {
      quantities[symbol] =
        weight <= 0
          ? '0'
          : (yield* desiredQuantityAtoms(
              BigInt(input.capitalMicros),
              weight,
              BigInt(input.askPriceMicros[symbol] ?? '0'),
              {
                precision: {
                  ...input.precision,
                  quantityIncrementAtoms:
                    instrumentMarket(symbol) === MarketKind.Equity
                      ? quantityScale.toString()
                      : input.precision.quantityIncrementAtoms,
                },
              },
            ).pipe(
              Result.mapError(
                (cause) =>
                  new JevContractError({ message: `Allocated entry quantity for ${symbol} is invalid`, cause }),
              ),
            )).toString()
    }
    return Object.freeze(quantities)
  })

export const maximumFundedBuyQuantities = (
  input: Parameters<typeof maximumAllocatedBuyQuantities>[0] & {
    readonly plans: Readonly<Record<string, FundedEntryExitPlan>>
  },
) =>
  Result.gen(function* () {
    const allocated = yield* maximumAllocatedBuyQuantities(input)
    const quantities: Record<string, string> = {}
    for (const [symbol, quantity] of Object.entries(allocated)) {
      if (quantity === '0') {
        quantities[symbol] = '0'
        continue
      }
      const plan = input.plans[symbol]
      if (plan === undefined)
        return yield* Result.fail(
          new JevContractError({ message: `Entry quantity for ${symbol} has no funded strategy plan` }),
        )
      const ceiling = BigInt(plan.maximumQuantityAtoms)
      quantities[symbol] = (BigInt(quantity) < ceiling ? BigInt(quantity) : ceiling).toString()
    }
    return Object.freeze(quantities)
  })

/** Short quantities use the executable sale bid and the original funded whole-share ceiling. */
export const maximumFundedSellQuantities = (input: {
  readonly bidPriceMicros: Readonly<Record<string, string>>
  readonly bidSize: Readonly<Record<string, number>>
  readonly targetWeights: Readonly<Record<string, number>>
  readonly capitalMicros: string
  readonly precision: ExecutionModel['precision']
  readonly plans: Readonly<Record<string, FundedEntryExitPlan>>
  readonly ignoreDisplayedBidSize?: boolean
}) =>
  Result.gen(function* () {
    const allocated = yield* maximumAllocatedBuyQuantities({
      ...input,
      askPriceMicros: input.bidPriceMicros,
      targetWeights: Object.fromEntries(
        Object.entries(input.targetWeights).map(([symbol, weight]) => [symbol, Math.max(0, -weight)]),
      ),
    })
    const quantities: Record<string, string> = {}
    for (const [symbol, plan] of Object.entries(input.plans).sort(([a], [b]) => a.localeCompare(b))) {
      const quantity = BigInt(allocated[symbol] ?? '0')
      const maximum = isShortFundedExitPlan(plan) ? BigInt(plan.maximumQuantityAtoms) : 0n
      if (input.ignoreDisplayedBidSize === true) {
        quantities[symbol] = (quantity < maximum ? quantity : maximum).toString()
        continue
      }
      const displayed = yield* quantityFromNumber(input.bidSize[symbol] ?? 0).pipe(
        Result.mapError((cause) => new JevContractError({ message: 'Short displayed bid quantity is invalid', cause })),
      )
      quantities[symbol] = [quantity, maximum, (displayed / quantityScale) * quantityScale]
        .reduce((a, b) => (a < b ? a : b))
        .toString()
    }
    return quantities
  })
