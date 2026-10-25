import { Result } from 'effect'

import { instrumentMarket, MarketKind } from '../instruments'
import type { ExecutionModel } from '../execution-model-contract'
import { quantityScale } from '../quantity'
import { desiredQuantityAtoms } from '../strategy/execution-model/fixed-point'
import type { JevFundedExitPlan } from './strategy-exit-plan'
import { JevContractError } from './contract'

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
        weight === 0
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
    readonly plans: Readonly<Record<string, JevFundedExitPlan>>
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
