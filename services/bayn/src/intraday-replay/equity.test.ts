import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { markIntradayReplayEquity, type IntradayReplayEquityInput } from './equity'

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success: ${String(result.failure)}`)
  return result.success
}

const input = (overrides: Partial<IntradayReplayEquityInput> = {}): IntradayReplayEquityInput => ({
  ledger: {
    cashMicros: '4900000',
    positions: [{ symbol: 'AAPL', quantityMicros: '1000000', costBasisMicros: '5100000' }],
  },
  bidPriceMicros: { AAPL: '1000' },
  dayStartEquityMicros: '10000000',
  previousPeakEquityMicros: '10000000',
  previousMaximumObservedDrawdownMicros: '0',
  ...overrides,
})

describe('markIntradayReplayEquity', () => {
  test('retains the over-limit excursion after the marked price recovers', () => {
    const distressed = success(
      markIntradayReplayEquity(
        input({
          limits: { maxDailyLossMicros: '5000000', maxDrawdownMicros: '5000000' },
        }),
      ),
    )

    expect(distressed).toMatchObject({
      equityMicros: '4901000',
      unrealizedPnlMicros: '-5099000',
      markedPositionValueMicros: '1000',
      dayLossMicros: '5099000',
      peakEquityMicros: '10000000',
      currentDrawdownMicros: '5099000',
      maximumObservedDrawdownMicros: '5099000',
      dailyLossLimit: { actualMicros: '5099000', limitMicros: '5000000', exceeded: true },
      drawdownLimit: { actualMicros: '5099000', limitMicros: '5000000', exceeded: true },
    })

    const recovered = success(
      markIntradayReplayEquity(
        input({
          bidPriceMicros: { AAPL: '5100000' },
          previousPeakEquityMicros: distressed.peakEquityMicros,
          previousMaximumObservedDrawdownMicros: distressed.maximumObservedDrawdownMicros,
          limits: { maxDailyLossMicros: '5000000', maxDrawdownMicros: '5000000' },
        }),
      ),
    )

    expect(recovered).toMatchObject({
      equityMicros: '10000000',
      unrealizedPnlMicros: '0',
      dayLossMicros: '0',
      peakEquityMicros: '10000000',
      currentDrawdownMicros: '0',
      maximumObservedDrawdownMicros: '5099000',
      dailyLossLimit: { actualMicros: '0', limitMicros: '5000000', exceeded: false },
      drawdownLimit: { actualMicros: '0', limitMicros: '5000000', exceeded: false },
    })
  })

  test('uses fee-adjusted cash and exact adverse bid valuation', () => {
    const marked = success(
      markIntradayReplayEquity(
        input({
          ledger: {
            cashMicros: '4899000',
            positions: [{ symbol: 'AAPL', quantityMicros: '1000000', costBasisMicros: '5100000' }],
          },
          bidPriceMicros: { AAPL: '5200000' },
        }),
      ),
    )

    expect(marked).toMatchObject({
      cashMicros: '4899000',
      markedPositionValueMicros: '5200000',
      equityMicros: '10099000',
      unrealizedPnlMicros: '100000',
      grossExposureMicros: '5200000',
      netExposureMicros: '5200000',
    })
  })

  test('fails closed when an open position has no mark quote', () => {
    const result = markIntradayReplayEquity(input({ bidPriceMicros: {} }))

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'InvalidIntradayReplayEquityInput',
        field: 'bidPriceMicros.AAPL',
        reason: 'missing-quote',
      },
    })
  })

  test('marks multiple long positions and carries prior peak and drawdown', () => {
    const marked = success(
      markIntradayReplayEquity(
        input({
          ledger: {
            cashMicros: '5000000',
            positions: [
              { symbol: 'AAPL', quantityMicros: '1000000', costBasisMicros: '2000000' },
              { symbol: 'MSFT', quantityMicros: '2000000', costBasisMicros: '1000000' },
            ],
          },
          bidPriceMicros: { AAPL: '3000000', MSFT: '4000000' },
          dayStartEquityMicros: '10000000',
          previousPeakEquityMicros: '15000000',
          previousMaximumObservedDrawdownMicros: '500000',
        }),
      ),
    )

    expect(marked).toMatchObject({
      markedPositionValueMicros: '11000000',
      equityMicros: '16000000',
      unrealizedPnlMicros: '8000000',
      grossExposureMicros: '11000000',
      netExposureMicros: '11000000',
      dayLossMicros: '0',
      peakEquityMicros: '16000000',
      currentDrawdownMicros: '0',
      maximumObservedDrawdownMicros: '500000',
    })
  })

  test('accepts a U128 cost basis when final unrealized PnL remains signed-I128 representable', () => {
    const marked = success(
      markIntradayReplayEquity(
        input({
          ledger: {
            cashMicros: '0',
            positions: [
              {
                symbol: 'AAPL',
                quantityMicros: '1000000',
                costBasisMicros: '170141183460469231731687303715884105728',
              },
            ],
          },
          bidPriceMicros: { AAPL: '1000000' },
          dayStartEquityMicros: '0',
          previousPeakEquityMicros: '0',
          previousMaximumObservedDrawdownMicros: '0',
        }),
      ),
    )

    expect(marked).toMatchObject({
      markedPositionValueMicros: '1000000',
      equityMicros: '1000000',
      unrealizedPnlMicros: '-170141183460469231731687303715883105728',
    })
  })

  test('marks flat cash without requiring a quote', () => {
    const marked = success(
      markIntradayReplayEquity(
        input({
          ledger: { cashMicros: '3000000', positions: [] },
          bidPriceMicros: {},
          dayStartEquityMicros: '4000000',
          previousPeakEquityMicros: '5000000',
          previousMaximumObservedDrawdownMicros: '1000000',
        }),
      ),
    )

    expect(marked).toMatchObject({
      cashMicros: '3000000',
      markedPositionValueMicros: '0',
      equityMicros: '3000000',
      unrealizedPnlMicros: '0',
      grossExposureMicros: '0',
      netExposureMicros: '0',
      dayLossMicros: '1000000',
      peakEquityMicros: '5000000',
      currentDrawdownMicros: '2000000',
      maximumObservedDrawdownMicros: '2000000',
    })
  })

  test('rejects negative and overflowing valuation inputs', () => {
    expect(markIntradayReplayEquity(input({ bidPriceMicros: { AAPL: '-1' } }))).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'negative' },
    })
    expect(
      markIntradayReplayEquity(
        input({
          ledger: {
            cashMicros: '340282366920938463463374607431768211456',
            positions: [],
          },
          bidPriceMicros: {},
        }),
      ),
    ).toMatchObject({
      _tag: 'Failure',
      failure: { field: 'ledger.cashMicros', reason: 'overflow' },
    })
  })
})
