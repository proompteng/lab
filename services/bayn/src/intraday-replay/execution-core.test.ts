import { instrumentMarket } from '../instruments'
import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { OrderSide } from '../execution/contracts'
import { intradayMomentumExecutionModel } from '../strategy/intraday-momentum/protocol'
import {
  simulateIntradayReplayExecution,
  type ReplayExecutionInput,
  type ReplayExecutionOutcome,
} from './execution-core'

const coreInput = (
  overrides: Partial<ReplayExecutionInput['order']> = {},
  quote: Partial<ReplayExecutionInput['quote']> = {},
  assumptions: Partial<ReplayExecutionInput['assumptions']> = {},
): ReplayExecutionInput => ({
  instrument: {
    symbol: 'NVDA',
    market: instrumentMarket('NVDA'),
    minimumQuantityAtoms: 1_000_000_000n,
    quantityIncrementAtoms: 1_000_000_000n,
    priceIncrementAtoms: 100_000n,
  },
  order: {
    side: OrderSide.Buy,
    quantityAtoms: 2000000000n,
    limitPriceMicros: 100_020_000n,
    ...overrides,
  },
  quote: {
    priceMicros: 100_010_000n,
    displayedQuantityAtoms: 2000000000n,
    ...quote,
  },
  executionModel: intradayMomentumExecutionModel,
  assumptions: {
    slippageBps: 0,
    availableLiquidityPpm: 1_000_000,
    ...assumptions,
  },
})

const success = (result: Result.Result<ReplayExecutionOutcome, unknown>): ReplayExecutionOutcome =>
  Result.getOrThrow(result)

describe('quote execution economics', () => {
  test('preserves exact buy and sell quote economics', () => {
    expect(success(simulateIntradayReplayExecution(coreInput()))).toEqual({
      status: 'filled',
      requestedQuantityAtoms: 2000000000n,
      filledQuantityAtoms: 2000000000n,
      fillPriceMicros: 100_010_000n,
      fillNotionalMicros: 200_020_000n,
      remainingQuantityAtoms: 0n,
    })
    expect(
      success(
        simulateIntradayReplayExecution(
          coreInput({ side: OrderSide.Sell, limitPriceMicros: 99_980_000n }, { priceMicros: 99_990_000n }),
        ),
      ),
    ).toEqual({
      status: 'filled',
      requestedQuantityAtoms: 2000000000n,
      filledQuantityAtoms: 2000000000n,
      fillPriceMicros: 99_990_000n,
      fillNotionalMicros: 199_980_000n,
      remainingQuantityAtoms: 0n,
    })
  })

  test('enforces order limits and rounds the displayed cap to whole shares', () => {
    expect(
      success(
        simulateIntradayReplayExecution(
          coreInput({}, { displayedQuantityAtoms: 3900000000n }, { availableLiquidityPpm: 500_000 }),
        ),
      ),
    ).toMatchObject({
      status: 'filled',
      filledQuantityAtoms: 1000000000n,
      remainingQuantityAtoms: 1_000_000_000n,
    })
    expect(
      success(simulateIntradayReplayExecution(coreInput({ limitPriceMicros: 100_010_000n }, {}, { slippageBps: 1 }))),
    ).toMatchObject({
      status: 'unfilled',
      reason: 'adverse-price-exceeds-limit',
      filledQuantityAtoms: 0n,
    })
  })
})
