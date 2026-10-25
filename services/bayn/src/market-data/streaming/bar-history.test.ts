import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { sha256 } from '../../hash'
import { checkProperty } from '../../testing/property-test-support'
import { sameBarMarketValues } from '../intraday/bar-publication'
import type { IntradayBar } from '../intraday/model'
import { compareIntradayInstants } from '../intraday/time'
import {
  compareBarRevisions,
  emptyStreamingProjection,
  incorporateMarketRecord,
  incorporateRecordedMarketValue,
  type ObservedBar,
} from './projection'
import { decodeRawMarketRecord, RawMarketEventKind, type KafkaMarketRecord, type StreamingUniverse } from './raw-events'

const start = Date.parse('2026-10-12T13:30:00.000Z')
const eventTime = (minute: number) =>
  start + Math.floor(minute / 390) * 86_400_000 + (((minute % 390) + 390) % 390) * 60_000
const universe: StreamingUniverse = {
  universeId: 'synthetic-bar-history',
  universeSymbolHash: 'a'.repeat(64),
  symbols: ['AAPL'],
  topics: { bars: 'test.bars', quotes: 'test.quotes', trades: 'test.trades', features: 'test.features' },
}
const recordFor = (index: number, minute: number, publication: number, price: number): KafkaMarketRecord => {
  const eventTs = new Date(eventTime(minute)).toISOString()
  return {
    topic: universe.topics.bars,
    partition: index % 3,
    offset: String(9_007_199_254_740_993n + BigInt(index)),
    value: JSON.stringify({
      provider: 'alpaca',
      feed: 'iex',
      delayClass: 'real_time_exchange_only',
      marketSession: 'regular',
      channel: 'bars',
      symbol: 'AAPL',
      eventTs,
      ingestTs: new Date(eventTime(minute) + 60_000 + publication * 1000).toISOString(),
      version: 2,
      isFinal: true,
      payload: { o: price, h: 110, l: 90, c: 100, v: 10, vw: 100, n: 2, t: eventTs },
    }),
  }
}

// Independent full-sort reference retained from the previous bar reduction algorithm.
const referenceHistory = (
  existing: readonly ObservedBar[],
  bar: IntradayBar,
  availableAtMs: number,
  sequence: number,
  recordHash: string,
  previousMinimum: number,
) => {
  const current = existing.find((entry) => compareIntradayInstants(entry.value.eventAt, bar.eventAt) === 0)
  if (current !== undefined && compareBarRevisions(bar, current.value) <= 0)
    return { bars: existing, minimumObservationMs: previousMinimum }
  const firstPublication =
    current !== undefined && sameBarMarketValues(current.value, bar)
      ? (current.firstPublication ?? {
          value: current.value,
          availableAtMs: current.availableAtMs,
          sequence: current.sequence,
          recordHash: current.recordHash,
        })
      : undefined
  const revision: ObservedBar = {
    value: bar,
    availableAtMs,
    sequence,
    recordHash,
    ...(firstPublication === undefined ? {} : { firstPublication }),
  }
  const ordered = [...existing, revision].toSorted(
    (a, b) => compareIntradayInstants(b.value.eventAt, a.value.eventAt) || compareBarRevisions(b.value, a.value),
  )
  const counts = new Map<string, number>()
  const bars: ObservedBar[] = []
  let minimumObservationMs = previousMinimum
  for (const entry of ordered) {
    const minute = entry.value.eventAt.slice(0, -1).padEnd(29, '0')
    const count = counts.get(minute) ?? 0
    if (count === 0 && counts.size === 61) continue
    counts.set(minute, count + 1)
    if (count < 4) bars.push(entry)
    else {
      const earliest = bars.findLast(
        (retained) => compareIntradayInstants(retained.value.eventAt, entry.value.eventAt) === 0,
      )
      minimumObservationMs = Math.max(minimumObservationMs, earliest?.availableAtMs ?? availableAtMs)
    }
  }
  return { bars, minimumObservationMs }
}

describe('bounded streaming bar history', () => {
  test('property: full reducers preserve sorted-reference revisions, publication identity and immutable cuts', () => {
    checkProperty(
      'bar-history-retention',
      fc.property(
        fc.array(
          fc.record({
            minute: fc.integer({ min: -1000, max: 1000 }),
            publication: fc.integer({ min: 61_000, max: 62_000 }),
            price: fc.integer({ min: 98, max: 102 }),
            arrival: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 80, maxLength: 160 },
        ),
        (changes) => {
          let state = emptyStreamingProjection('bar-history')
          let reference: { bars: readonly ObservedBar[]; minimumObservationMs: number } = {
            bars: [],
            minimumObservationMs: 0,
          }
          const retained: { readonly state: typeof state; readonly hash: string }[] = []
          const digest = (projection: typeof state) =>
            sha256(JSON.stringify(projection, (_key, value: unknown) => (value instanceof Map ? [...value] : value)))
          const prelude = Array.from({ length: 65 * 5 }, (_, index) => ({
            minute: Math.floor(index / 5),
            publication: index,
            price: 100,
            arrival: index,
          }))
          for (const [index, change] of [...prelude, ...changes].entries()) {
            const record = recordFor(index, change.minute, change.publication, change.price)
            const decoded = Result.getOrThrow(decodeRawMarketRecord(record, universe))
            if (decoded.kind !== RawMarketEventKind.Bar) throw new Error('expected bar fixture')
            const recorded = index % 3 === 0
            const bar = recorded
              ? { ...decoded.value, eventAt: new Date(eventTime(change.minute)).toISOString() }
              : decoded.value
            const availableAtMs = start + 1_000_000_000 + change.arrival * 1000
            reference = referenceHistory(
              reference.bars,
              bar,
              availableAtMs,
              index + 1,
              recorded ? sha256(JSON.stringify(bar)) : sha256(record.value),
              reference.minimumObservationMs,
            )
            const previous = state
            state = recorded
              ? incorporateRecordedMarketValue(state, bar, universe, availableAtMs)
              : incorporateMarketRecord(state, record, universe, availableAtMs)
            expect(state.bars.get('AAPL')).toEqual(reference.bars)
            expect(state.minimumObservationMs).toBe(reference.minimumObservationMs)
            expect(state.minimumObservationMs).toBeGreaterThanOrEqual(previous.minimumObservationMs)
            expect(state.sequence).toBe(index + 1)
            expect(state.rejections.size).toBe(0)
            if (index % 100 === 0) {
              for (const history of state.bars.values()) Object.freeze(history)
              retained.push({ state, hash: digest(state) })
            }
          }
          for (const cut of retained) expect(digest(cut.state)).toBe(cut.hash)
        },
      ),
      20,
    )
  }, 150_000)

  test('duplicates, conflicting receipts and invalid offset encodings retain the same bar history', () => {
    const record = recordFor(0, 0, 0, 100)
    const availableAtMs = start + 1_000_000_000
    const initial = incorporateMarketRecord(emptyStreamingProjection('duplicate'), record, universe, availableAtMs)
    const history = initial.bars.get('AAPL')
    expect(history).toHaveLength(1)
    expect(incorporateMarketRecord(initial, record, universe, availableAtMs + 1)).toBe(initial)
    const conflict = incorporateMarketRecord(
      initial,
      { ...record, value: record.value + ' ' },
      universe,
      availableAtMs + 1,
    )
    expect(conflict.bars).toBe(initial.bars)
    expect(conflict.rejections.get(`${record.topic}:0`)?.at(-1)?.reason).toBe('conflicting-immutable-record')
    for (const offset of ['01', '-1', '1.0', '9223372036854775808']) {
      const invalid = incorporateMarketRecord(initial, { ...record, offset }, universe, availableAtMs + 1)
      expect(invalid.bars).toBe(initial.bars)
      expect(invalid.rejections.get(`${record.topic}:0`)?.at(-1)?.reason).toBe('invalid-transport-coordinate')
    }
    expect(initial.bars.get('AAPL')).toBe(history)
  })
})
