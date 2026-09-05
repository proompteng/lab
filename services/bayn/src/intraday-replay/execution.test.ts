import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1 } from '../hash'
import { IntradaySnapshotPurpose, type IntradaySnapshotRequest } from '../market-data/intraday/model'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import {
  decodeDefaultIntradayMomentumProtocol,
  intradayMomentumExecutionModel,
} from '../strategy/intraday-momentum/protocol'
import { OrderSide } from '../execution/contracts'
import {
  simulateIntradayReplayIoc,
  type IntradayReplayIocAssumptions,
  type IntradayReplayIocInput,
  type IntradayReplayIocOrder,
  type IntradayReplayIocOutcome,
} from './execution'

const protocol = Result.getOrThrow(decodeDefaultIntradayMomentumProtocol())
const sessionDate = '2026-09-04'
const openAt = `${sessionDate}T13:30:00.000Z`
const closeAt = `${sessionDate}T20:00:00.000Z`
const calendarMaterial = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: sessionDate, end: sessionDate },
  timeZone: 'UTC' as const,
  sessions: [{ date: sessionDate, openAt, closeAt }],
}
const calendar = { ...calendarMaterial, normalizedResponseHash: canonicalHashV1(calendarMaterial) }

const request: IntradaySnapshotRequest = {
  sessionDate,
  calendar,
  rangeStartAt: openAt,
  rangeEndAt: `${sessionDate}T13:35:00.000Z`,
  observedAt: `${sessionDate}T13:35:30.000Z`,
  universeId: protocol.universeId,
  universeSymbolHash: protocol.universeSymbolHash,
  universe: protocol.universe,
  symbols: ['AMD'],
  purpose: IntradaySnapshotPurpose.EntryPricing,
  feed: protocol.feed,
  delayClass: protocol.delayClass,
  sourceTopics: protocol.sourceTopics,
  maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
  minimumWatermarkLagMs: 1_000,
  archiveWatermarks: Object.values(protocol.sourceTopics).map((sourceTopic) => ({
    sourceTopic,
    sourcePartition: 0,
    inclusiveLastOffset: '100',
  })),
}

const snapshot = (bidSizes: Readonly<Record<string, number>> = {}) =>
  makeIntradayMomentumTestSnapshot(protocol, request, {}, 100, bidSizes)

const defaultOrder: IntradayReplayIocOrder = {
  symbol: 'AMD',
  side: OrderSide.Buy,
  quantityMicros: '2000000',
  limitPriceMicros: '100020000',
  submittedAt: `${sessionDate}T13:35:20.000Z`,
}

const defaultAssumptions: IntradayReplayIocAssumptions = {
  slippageBps: 0,
  availableLiquidityPpm: 1_000_000,
}

const input = (
  overrides: Partial<IntradayReplayIocOrder> = {},
  assumptions: Partial<IntradayReplayIocAssumptions> = {},
  arrivalSnapshot = snapshot(),
): IntradayReplayIocInput => ({
  order: { ...defaultOrder, ...overrides },
  arrivalSnapshot,
  executionModel: intradayMomentumExecutionModel,
  assumptions: { ...defaultAssumptions, ...assumptions },
})

const success = (result: Result.Result<IntradayReplayIocOutcome, unknown>): IntradayReplayIocOutcome =>
  Result.getOrThrow(result)

const failure = (result: Result.Result<unknown, unknown>): unknown => Result.getOrThrow(Result.flip(result))

describe('intraday replay IOC execution', () => {
  test('fills buys and sells at the adverse opposite quote within the limit', () => {
    const buy = success(simulateIntradayReplayIoc(input()))
    expect(buy).toMatchObject({
      status: 'filled',
      symbol: 'AMD',
      side: OrderSide.Buy,
      requestedQuantityMicros: '2000000',
      filledQuantityMicros: '2000000',
      fillPriceMicros: '100010000',
      fillNotionalMicros: '200020000',
      snapshotId: snapshot().manifest.snapshotId,
      snapshotContentHash: snapshot().manifest.contentHash,
      observedAt: request.observedAt,
      unfilledRemainder: 'none',
    })

    const sell = success(simulateIntradayReplayIoc(input({ side: OrderSide.Sell, limitPriceMicros: '99980000' })))
    expect(sell).toMatchObject({
      status: 'filled',
      side: OrderSide.Sell,
      fillPriceMicros: '99990000',
      fillNotionalMicros: '199980000',
      unfilledRemainder: 'none',
    })
  })

  test('preserves executable-side behavior when the unused quote size exceeds safe micros', () => {
    const original = snapshot().latestQuotes['AMD']
    if (original === undefined) throw new Error('fixture must contain AMD quote')
    const withQuote = (quote: typeof original) =>
      ({
        ...snapshot(),
        quotes: [quote],
        latestQuotes: { AMD: quote },
      }) as unknown as ReturnType<typeof snapshot>

    const buy = success(
      simulateIntradayReplayIoc(input({}, {}, withQuote({ ...original, bidSize: Number.MAX_SAFE_INTEGER }))),
    )
    expect(buy).toMatchObject({ status: 'filled', filledQuantityMicros: '2000000', fillPriceMicros: '100010000' })

    const sell = success(
      simulateIntradayReplayIoc(
        input(
          { side: OrderSide.Sell, limitPriceMicros: '99980000' },
          {},
          withQuote({ ...original, askSize: Number.MAX_SAFE_INTEGER }),
        ),
      ),
    )
    expect(sell).toMatchObject({ status: 'filled', filledQuantityMicros: '2000000', fillPriceMicros: '99990000' })
  })

  test('cancels when declared adverse slippage crosses the order limit', () => {
    const result = success(simulateIntradayReplayIoc(input({ limitPriceMicros: '100010000' }, { slippageBps: 1 })))

    expect(result).toMatchObject({
      status: 'canceled',
      reason: 'adverse-price-exceeds-limit',
      requestedQuantityMicros: '2000000',
      filledQuantityMicros: '0',
      unfilledRemainder: 'canceled',
    })
    expect(result).not.toHaveProperty('fillPriceMicros')
    expect(result).not.toHaveProperty('fillNotionalMicros')
  })

  test('caps an IOC fill to available displayed liquidity and cancels the remainder', () => {
    const result = success(
      simulateIntradayReplayIoc(
        input(
          { side: OrderSide.Sell, quantityMicros: '5000000', limitPriceMicros: '99980000' },
          {},
          snapshot({ AMD: 1.9 }),
        ),
      ),
    )

    expect(result).toMatchObject({
      status: 'filled',
      requestedQuantityMicros: '5000000',
      filledQuantityMicros: '1000000',
      fillPriceMicros: '99990000',
      fillNotionalMicros: '99990000',
      unfilledRemainder: 'canceled',
    })
  })

  test('rounds displayed fractional shares down to whole-share execution precision', () => {
    const result = success(
      simulateIntradayReplayIoc(
        input(
          { side: OrderSide.Sell, quantityMicros: '2000000', limitPriceMicros: '99980000' },
          { availableLiquidityPpm: 500_000 },
          snapshot({ AMD: 3.9 }),
        ),
      ),
    )

    expect(result).toMatchObject({ filledQuantityMicros: '1000000', unfilledRemainder: 'canceled' })
  })

  test('cancels an IOC when displayed liquidity disappears at arrival', () => {
    const result = success(
      simulateIntradayReplayIoc(
        input({ side: OrderSide.Sell, limitPriceMicros: '99980000' }, {}, snapshot({ AMD: 0 })),
      ),
    )
    expect(result).toMatchObject({
      status: 'canceled',
      reason: 'no-displayed-liquidity',
      filledQuantityMicros: '0',
      unfilledRemainder: 'canceled',
      limitPriceMicros: '99980000',
      submittedAt: defaultOrder.submittedAt,
    })
  })

  test('rejects stale and future arrival quotes', () => {
    const original = snapshot().latestQuotes['AMD']
    if (original === undefined) throw new Error('fixture must contain AMD quote')
    const staleQuote = { ...original, eventAt: `${sessionDate}T13:34:00.000Z` }
    const stale = {
      ...snapshot(),
      quotes: [staleQuote],
      latestQuotes: { AMD: staleQuote },
    } as unknown as ReturnType<typeof snapshot>
    expect(failure(simulateIntradayReplayIoc(input({}, {}, stale)))).toMatchObject({
      _tag: 'InvalidIntradayReplaySnapshot',
      reason: 'stale-quote',
    })

    const futureQuote = { ...original, eventAt: `${sessionDate}T13:36:00.000Z` }
    const future = {
      ...snapshot(),
      quotes: [futureQuote],
      latestQuotes: { AMD: futureQuote },
    } as unknown as ReturnType<typeof snapshot>
    expect(failure(simulateIntradayReplayIoc(input({}, {}, future)))).toMatchObject({
      _tag: 'InvalidIntradayReplaySnapshot',
      reason: 'future-quote',
    })
  })

  test('accepts canonical nanosecond quote timestamps and compares boundaries exactly', () => {
    const original = snapshot().latestQuotes['AMD']
    if (original === undefined) throw new Error('fixture must contain AMD quote')
    const withQuote = (eventAt: string, ingestedAt = eventAt) => {
      const quote = { ...original, eventAt, ingestedAt }
      return {
        ...snapshot(),
        quotes: [quote],
        latestQuotes: { AMD: quote },
      } as unknown as ReturnType<typeof snapshot>
    }

    expect(
      success(simulateIntradayReplayIoc(input({}, {}, withQuote(`${sessionDate}T13:35:29.000000001Z`)))),
    ).toMatchObject({
      status: 'filled',
    })
    expect(
      failure(simulateIntradayReplayIoc(input({}, {}, withQuote(`${sessionDate}T13:35:30.000000001Z`)))),
    ).toMatchObject({ reason: 'future-quote' })
    expect(
      failure(simulateIntradayReplayIoc(input({}, {}, withQuote(`${sessionDate}T13:35:27.999999999Z`)))),
    ).toMatchObject({ reason: 'stale-quote' })
  })

  test('rejects malformed order, assumptions, identity, and non-quote snapshots', () => {
    expect(failure(simulateIntradayReplayIoc(input({ quantityMicros: '1500000' })))).toMatchObject({
      _tag: 'InvalidIntradayReplayOrder',
      reason: 'fractional-quantity',
    })
    expect(failure(simulateIntradayReplayIoc(input({}, { slippageBps: 0.5 })))).toMatchObject({
      _tag: 'InvalidIntradayReplayAssumptions',
      field: 'slippageBps',
    })
    expect(failure(simulateIntradayReplayIoc(input({}, { availableLiquidityPpm: 0 })))).toMatchObject({
      _tag: 'InvalidIntradayReplayAssumptions',
      field: 'availableLiquidityPpm',
    })
    expect(failure(simulateIntradayReplayIoc(input({ symbol: 'NOT A SYMBOL' })))).toMatchObject({
      _tag: 'InvalidIntradayReplayOrder',
      field: 'order.symbol',
    })

    const nonQuote = {
      ...snapshot(),
      manifest: { ...snapshot().manifest, purpose: undefined },
    } as unknown as ReturnType<typeof snapshot>
    expect(failure(simulateIntradayReplayIoc(input({}, {}, nonQuote)))).toMatchObject({
      _tag: 'InvalidIntradayReplaySnapshot',
      reason: 'not-quote-only',
    })
  })

  test('requires arrival time at or after order submission', () => {
    expect(failure(simulateIntradayReplayIoc(input({ submittedAt: `${sessionDate}T13:35:31.000Z` })))).toMatchObject({
      _tag: 'InvalidIntradayReplayOrder',
      reason: 'after-arrival',
    })
  })
})
