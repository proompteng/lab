import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { decideIntradayMomentumCore, type IntradayMomentumCoreInput } from './decision-core'
import { decodeDefaultIntradayMomentumProtocol } from './protocol'

const success = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)

const observedAt = '2026-08-18T16:00:02.000Z'
const evidenceAt = '2026-08-18T16:00:01.000Z'
const rangeStartAt = '2026-08-18T15:00:00.000Z'
const rangeEndAt = '2026-08-18T15:01:00.000Z'

const makeInput = (candidateMidpoint: number): IntradayMomentumCoreInput => {
  const protocol = success(decodeDefaultIntradayMomentumProtocol())
  const symbols = [...protocol.candidateSymbols, protocol.benchmarkSymbol]
  const bars = symbols.flatMap((symbol) => [
    { symbol, eventAt: rangeStartAt, open: 100, high: 100.2, low: 99.9 },
    { symbol, eventAt: rangeEndAt, open: 100, high: 100.3, low: 99.8 },
  ])
  const latestQuotes = Object.fromEntries(
    symbols.map((symbol) => {
      const midpoint = symbol === protocol.benchmarkSymbol ? 100.1 : symbol === 'AAPL' ? candidateMidpoint : 100.01
      return [
        symbol,
        {
          symbol,
          eventAt: evidenceAt,
          bidPrice: midpoint - 0.005,
          bidSize: 100,
          askPrice: midpoint + 0.005,
          askSize: 100,
        },
      ]
    }),
  )
  const latestTrades = Object.fromEntries(
    protocol.candidateSymbols.map((symbol) => [
      symbol,
      {
        symbol,
        eventAt: evidenceAt,
        price: symbol === 'AAPL' ? candidateMidpoint : 100.01,
      },
    ]),
  )
  return { bars, latestQuotes, latestTrades, observedAt, protocol }
}

describe('intraday momentum decision core', () => {
  test('keeps the archive wrapper projection stable when event input order changes', () => {
    const input = makeInput(101)
    const result = success(decideIntradayMomentumCore(input))
    const reordered = success(
      decideIntradayMomentumCore({
        ...input,
        bars: [...input.bars].reverse(),
      }),
    )

    expect(reordered).toEqual(result)
    expect(result.selectedSymbols).toEqual(['AAPL'])
    expect(result.targetWeights).toEqual({
      AAPL: 0.1,
      AMZN: 0,
      IWM: 0,
      NVDA: 0,
      QQQ: 0,
      SMH: 0,
    })
    expect(Object.keys(result)).toEqual(['benchmark', 'selectedSymbols', 'targetWeights', 'signals'])
    expect(result.signals.find(({ symbol }) => symbol === 'AAPL')).toMatchObject({
      eligible: true,
      rank: 1,
      rejectionReasons: [],
    })
  })

  test('retains an explicit no-trade result when every candidate is below the thresholds', () => {
    const input = makeInput(100.01)
    const result = success(decideIntradayMomentumCore(input))

    expect(result.selectedSymbols).toEqual([])
    expect(result.targetWeights).toEqual({
      AAPL: 0,
      AMZN: 0,
      IWM: 0,
      NVDA: 0,
      QQQ: 0,
      SMH: 0,
    })
    expect(result.signals.every(({ eligible, rank }) => !eligible && rank === null)).toBe(true)
    expect(result.signals.every(({ rejectionReasons }) => rejectionReasons.includes('breakout'))).toBe(true)
  })

  test('fails closed when the caller does not provide a selected latest trade', () => {
    const input = makeInput(101)
    const { AAPL: _ignored, ...latestTrades } = input.latestTrades
    const result = decideIntradayMomentumCore({ ...input, latestTrades })

    expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({
      reason: 'snapshot-coverage',
      symbol: 'AAPL',
    })
  })
})
