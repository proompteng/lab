import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Result } from 'effect'

import { WebullRequestState, WebullSession } from '../webull-contract'
import { decodeWebullCapture, WebullCaptureKind, WebullProducerClockDirection } from './webull-capture'

const receivedAt = '2026-11-05T14:32:02.123456789Z'
const bar = {
  time: '2026-11-05T14:31:00.000+0000',
  trading_session: 'RTH',
  open: '123.450000000000000001',
  high: '124',
  low: '122',
  close: '123.46',
  volume: '1000.25',
}
const group = { symbol: 'AAPL', delay_minutes: '0', result: [bar] }
const request = {
  symbols: ['AAPL', 'SPY'],
  category: 'US_STOCK',
  timespan: 'M1',
  count: '5',
  real_time_required: true,
  trading_sessions: 'PRE,RTH,ATH',
  start_time: Date.parse('2026-11-05T14:27:00Z'),
  end_time: Date.parse('2026-11-05T14:32:00Z') - 1,
}
const source = {
  type: 'http',
  endpoint: '/market-data/stocks/bars/list',
  requestedSymbols: request.symbols,
  query: {},
  requestBody: JSON.stringify(request),
}
const record = (body = JSON.stringify({ result: [group] }), overrides: Record<string, unknown> = {}) => {
  const payload = Buffer.from(body)
  return {
    topic: 'dorvud.webull.raw.v1',
    partition: 0,
    offset: '42',
    timestampMs: Date.parse(receivedAt),
    value: JSON.stringify({
      version: 1,
      provider: 'webull',
      feed: 'nasdaq_basic',
      captureId: '8e8cfeb4-538f-42bd-b2bf-ed0000000001',
      receivedAt,
      source,
      payloadBase64: payload.toString('base64'),
      payloadSha256: createHash('sha256').update(payload).digest('hex'),
      ...overrides,
    }),
  }
}
const bars = (value = record()) => {
  const decoded = Result.getOrThrow(decodeWebullCapture(value))
  if (decoded.kind !== WebullCaptureKind.Bars) throw new Error('Expected a native bar batch')
  return decoded
}

test('native M1 decoding preserves exact decimals, capture identity, nanoseconds and Kafka provenance', () => {
  const native = record(),
    decoded = bars(native)
  expect(decoded.bars).toEqual([
    {
      symbol: 'AAPL',
      startMs: Date.parse(bar.time),
      session: WebullSession.Regular,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    },
  ])
  expect(decoded.receipt.receivedAt).toBe(receivedAt)
  expect(decoded.receipt.sourceOffset).toBe('42')
  expect(decoded.receipt.recordHash).toBe(createHash('sha256').update(native.value).digest('hex'))
  expect(decoded.requests.map((entry) => [entry.symbol, entry.state])).toEqual([
    ['AAPL', WebullRequestState.Observed],
    ['SPY', WebullRequestState.Omitted],
  ])
})

test('cached and unfinished bars are excluded while completed peers and empty request states remain explicit', () => {
  const decoded = bars(
    record(
      JSON.stringify({
        result: [
          {
            ...group,
            result: [
              { ...bar, time: '2026-11-04T20:00:00.000+0000', trading_session: 'OVN' },
              bar,
              { ...bar, time: '2026-11-05T14:32:00.000+0000' },
            ],
          },
          { symbol: 'SPY', delay_minutes: 0, result: [] },
        ],
      }),
    ),
  )
  expect(decoded.bars).toHaveLength(1)
  expect(decoded.requests).toEqual([
    { symbol: 'AAPL', state: WebullRequestState.Observed, observations: 1, excluded: 2 },
    { symbol: 'SPY', state: WebullRequestState.Empty, observations: 0, excluded: 0 },
  ])
  expect(
    bars(record(JSON.stringify({ result: [{ ...group, result: [{ ...bar, time: '2026-11-04T20:00:00.000+0000' }] }] })))
      .requests[0]?.state,
  ).toBe(WebullRequestState.Excluded)
})

test('Webull extended-session bars retain their provider label outside IEX entitlement hours', () => {
  const at = '2026-11-05T10:32:02.123456789Z'
  const native = record(
    JSON.stringify({
      result: [{ ...group, result: [{ ...bar, time: '2026-11-05T10:31:00.000+0000', trading_session: 'PRE' }] }],
    }),
    {
      receivedAt: at,
      source: {
        ...source,
        requestBody: JSON.stringify({
          ...request,
          start_time: Date.parse('2026-11-05T10:27:00Z'),
          end_time: Date.parse('2026-11-05T10:32:00Z') - 1,
        }),
      },
    },
  )
  expect(bars({ ...native, timestampMs: Date.parse(at) }).bars[0]?.session).toBe(WebullSession.Pre)
})

test('delayed, duplicate, unrequested and malformed bar data never become usable context', () => {
  const invalid = [
    { result: [{ ...group, delay_minutes: '15' }] },
    { result: [group, group] },
    { result: [{ ...group, symbol: 'MSFT' }] },
    { result: [{ ...group, result: [bar, bar] }] },
    { result: [{ ...group, result: [{ ...bar, time: '2026-02-31T14:31:00.000+0000' }] }] },
    { result: [{ ...group, result: [{ ...bar, time: '2026-11-05T14:31:01.000+0000' }] }] },
    { result: [{ ...group, result: [{ ...bar, trading_session: 'OVN' }] }] },
    { result: [{ ...group, result: [{ ...bar, open: '0' }] }] },
    { result: [{ ...group, result: [{ ...bar, low: '125' }] }] },
    { result: [{ ...group, result: [{ ...bar, volume: '-1' }] }] },
    { result: [{ ...group, result: [{ ...bar, open: 123.45 }] }] },
  ]
  for (const value of invalid) expect(Result.isFailure(decodeWebullCapture(record(JSON.stringify(value))))).toBe(true)
})

test('capture hashes, exact base64, provider identity and envelope version are checked before use', () => {
  for (const fields of [
    { payloadSha256: '0'.repeat(64) },
    { payloadBase64: 'e30= ' },
    { provider: 'alpaca' },
    { feed: 'iex' },
    { version: 2 },
    { receivedAt: '2026-02-31T14:32:02.123456789Z' },
    { source: { ...source, endpoint: '/trading/orders/create' } },
  ])
    expect(Result.isFailure(decodeWebullCapture(record(undefined, fields)))).toBe(true)
  const bytes = Buffer.from([0xff])
  expect(
    Result.isFailure(
      decodeWebullCapture(
        record(undefined, {
          payloadBase64: bytes.toString('base64'),
          payloadSha256: createHash('sha256').update(bytes).digest('hex'),
        }),
      ),
    ),
  ).toBe(true)
})

test('request metadata must reproduce the real-time request and completed five-minute window', () => {
  const bodies = [
    { ...request, real_time_required: false },
    { ...request, symbols: ['SPY'] },
    { ...request, end_time: request.end_time + 60000 },
    { ...request, start_time: request.start_time + 1 },
    { ...request, start_time: request.start_time - 60000 },
    { ...request, trading_sessions: 'RTH,RTH' },
  ]
  for (const body of bodies)
    expect(
      Result.isFailure(
        decodeWebullCapture(record(undefined, { source: { ...source, requestBody: JSON.stringify(body) } })),
      ),
    ).toBe(true)
})

test('Kafka coordinates and the producer clock cannot be omitted or relabeled', () => {
  const native = record()
  const invalid = [
    { ...native, partition: -1 },
    { ...native, partition: 2147483648 },
    { ...native, offset: '9223372036854775808' },
    { ...native, offset: 'wrong' },
    { ...native, timestampMs: native.timestampMs + 5001 },
    { topic: native.topic, partition: native.partition, offset: native.offset, value: native.value },
  ]
  for (const value of invalid) expect(Result.isFailure(decodeWebullCapture(value))).toBe(true)
})

test.each([-5001, 5001])(
  'producer clock rejections expose the signed difference %i without inferring its cause',
  (difference) => {
    const native = record()
    const decoded = decodeWebullCapture({ ...native, timestampMs: native.timestampMs + difference })
    expect(Result.isFailure(decoded)).toBe(true)
    if (!Result.isFailure(decoded)) throw new Error('Expected a producer clock rejection')
    expect(decoded.failure).toMatchObject({
      _tag: 'WebullProducerClockError',
      message: 'Webull timestamp violates the producer clock contract',
      producerClock: {
        kafkaTimestampMs: native.timestampMs + difference,
        collectorReceivedAtMs: native.timestampMs,
        kafkaMinusCollectorReceiptMs: difference,
        maximumDifferenceMs: 5000,
        direction:
          difference > 0
            ? WebullProducerClockDirection.KafkaAfterCollectorReceipt
            : WebullProducerClockDirection.KafkaBeforeCollectorReceipt,
      },
    })
  },
)

test('the inclusive producer clock bound preserves successful native output and nanosecond receipts', () => {
  const native = record()
  const expected = bars(native)
  for (const difference of [-5000, 0, 5000])
    expect(bars({ ...native, timestampMs: native.timestampMs + difference })).toEqual(expected)
})

test('MQTT messages stay ignored for bar context and collector gaps retain their scope', () => {
  const mqtt = Result.getOrThrow(
    decodeWebullCapture(
      record('binary payload', {
        source: { type: 'mqtt', sessionId: '8e8cfeb4-538f-42bd-b2bf-ed0000000002', topic: 'tick' },
      }),
    ),
  )
  expect(mqtt.kind).toBe(WebullCaptureKind.Ignored)
  const gap = Result.getOrThrow(
    decodeWebullCapture(
      record(JSON.stringify({ channel: 'bars', symbols: ['AAPL'], reason: 'timeout' }), {
        source: { type: 'collector', operation: 'gap' },
      }),
    ),
  )
  expect(gap.kind).toBe(WebullCaptureKind.Gap)
  if (gap.kind !== WebullCaptureKind.Gap) throw new Error('Expected a scoped gap')
  expect(gap.gap.symbols).toEqual(['AAPL'])
})
