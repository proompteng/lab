import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { OrderSide } from '../execution/contracts'
import { intradayMomentumExecutionModel } from '../strategy/intraday-momentum/protocol'
import {
  simulateIntradayReplayIocCore,
  type IntradayReplayIocCoreInput,
  type IntradayReplayIocCoreOutcome,
} from './execution-core'

const coreInput = (
  overrides: Partial<IntradayReplayIocCoreInput['order']> = {},
  quote: Partial<IntradayReplayIocCoreInput['quote']> = {},
  assumptions: Partial<IntradayReplayIocCoreInput['assumptions']> = {},
): IntradayReplayIocCoreInput => ({
  order: {
    side: OrderSide.Buy,
    quantityMicros: 2_000_000n,
    limitPriceMicros: 100_020_000n,
    ...overrides,
  },
  quote: {
    priceMicros: 100_010_000n,
    displayedQuantityMicros: 2_000_000n,
    ...quote,
  },
  executionModel: intradayMomentumExecutionModel,
  assumptions: {
    slippageBps: 0,
    availableLiquidityPpm: 1_000_000,
    ...assumptions,
  },
})

const success = (result: Result.Result<IntradayReplayIocCoreOutcome, unknown>): IntradayReplayIocCoreOutcome =>
  Result.getOrThrow(result)

describe('intraday replay IOC economic core', () => {
  test('preserves exact buy and sell quote economics', () => {
    expect(success(simulateIntradayReplayIocCore(coreInput()))).toEqual({
      status: 'filled',
      requestedQuantityMicros: 2_000_000n,
      filledQuantityMicros: 2_000_000n,
      fillPriceMicros: 100_010_000n,
      fillNotionalMicros: 200_020_000n,
      unfilledRemainder: 'none',
    })
    expect(
      success(
        simulateIntradayReplayIocCore(
          coreInput({ side: OrderSide.Sell, limitPriceMicros: 99_980_000n }, { priceMicros: 99_990_000n }),
        ),
      ),
    ).toEqual({
      status: 'filled',
      requestedQuantityMicros: 2_000_000n,
      filledQuantityMicros: 2_000_000n,
      fillPriceMicros: 99_990_000n,
      fillNotionalMicros: 199_980_000n,
      unfilledRemainder: 'none',
    })
  })

  test('enforces IOC limits and rounds the displayed cap to whole shares', () => {
    expect(
      success(
        simulateIntradayReplayIocCore(
          coreInput({}, { displayedQuantityMicros: 3_900_000n }, { availableLiquidityPpm: 500_000 }),
        ),
      ),
    ).toMatchObject({
      status: 'filled',
      filledQuantityMicros: 1_000_000n,
      unfilledRemainder: 'canceled',
    })
    expect(
      success(simulateIntradayReplayIocCore(coreInput({ limitPriceMicros: 100_010_000n }, {}, { slippageBps: 1 }))),
    ).toMatchObject({
      status: 'canceled',
      reason: 'adverse-price-exceeds-limit',
      filledQuantityMicros: 0n,
    })
  })
})
