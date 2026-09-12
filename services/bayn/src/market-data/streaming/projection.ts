import { createHash } from 'node:crypto'
import { Result } from 'effect'
import type { RawMarketEvent } from './raw-events'

import { compareIntradayInstants, intradayInstantNanos } from '../intraday/time'
import type { IntradayBar, IntradayQuote, IntradayTrade } from '../intraday/model'
import {
  decodeRollingMarketFeature,
  featureMatchesBars,
  MarketFeatureFailure,
  marketFeatureClockSkewAllowanceMs,
  type RollingMarketFeature,
} from '../features/contract'
import { decodeRawMarketRecord, RawMarketEventKind, type KafkaMarketRecord, type StreamingUniverse } from './raw-events'

export interface ObservedMarketValue<A> {
  readonly value: A
  readonly availableAtMs: number
  readonly sequence: number
  readonly recordHash: string
}
export interface ObservedFeature extends ObservedMarketValue<RollingMarketFeature> {
  readonly topic: string
  readonly partition: number
  readonly offset: string
}
export interface StreamingProjection {
  readonly availabilityMode: 'observed' | 'simulated'
  readonly epoch: string
  readonly sequence: number
  readonly offsets: ReadonlyMap<string, string>
  readonly bars: ReadonlyMap<string, readonly ObservedMarketValue<IntradayBar>[]>
  readonly quotes: ReadonlyMap<string, ObservedMarketValue<IntradayQuote>>
  readonly trades: ReadonlyMap<string, ObservedMarketValue<IntradayTrade>>
  readonly quoteHistory: ReadonlyMap<string, readonly ObservedMarketValue<IntradayQuote>[]>
  readonly tradeHistory: ReadonlyMap<string, readonly ObservedMarketValue<IntradayTrade>[]>
  readonly minimumObservationMs: number
  readonly features: ReadonlyMap<string, readonly ObservedFeature[]>
  /** The accepted feature for this disposition, including one too old for retained join history. */
  readonly featureArrival: ObservedFeature | null
  readonly discardedRejectionsThroughMs: number
  readonly rejections: ReadonlyMap<
    string,
    readonly { readonly availableAtMs: number; readonly offset: string; readonly reason: string }[]
  >
}
export const emptyStreamingProjection = (epoch: string): StreamingProjection => ({
  availabilityMode: 'observed',
  epoch,
  sequence: 0,
  offsets: new Map(),
  bars: new Map(),
  quotes: new Map(),
  trades: new Map(),
  quoteHistory: new Map(),
  tradeHistory: new Map(),
  minimumObservationMs: 0,
  features: new Map(),
  featureArrival: null,
  discardedRejectionsThroughMs: -1,
  rejections: new Map(),
})
export const topicPartitionKey = (topic: string, partition: number): string => `${topic}:${partition}`

const compareOffsets = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
export const compareBarRevisions = (a: IntradayBar, b: IntradayBar): number =>
  compareIntradayInstants(a.ingestedAt, b.ingestedAt) ||
  a.sourcePartition - b.sourcePartition ||
  compareOffsets(a.sourceOffset, b.sourceOffset)
const compareCurrent = (a: IntradayQuote | IntradayTrade, b: IntradayQuote | IntradayTrade): number =>
  compareIntradayInstants(a.eventAt, b.eventAt) ||
  a.sourcePartition - b.sourcePartition ||
  compareOffsets(a.sourceOffset, b.sourceOffset)

const reject = (
  state: StreamingProjection,
  record: KafkaMarketRecord,
  availableAtMs: number,
  reason: string,
): StreamingProjection => {
  const key = topicPartitionKey(record.topic, record.partition)
  const history = [...(state.rejections.get(key) ?? []), { availableAtMs, offset: record.offset, reason }]
  const discarded = history.length > 256 ? history[history.length - 257] : undefined
  return {
    ...state,
    discardedRejectionsThroughMs: Math.max(state.discardedRejectionsThroughMs, discarded?.availableAtMs ?? -1),
    rejections: new Map(state.rejections).set(key, history.slice(-256)),
  }
}

const incorporateDecodedRecord = (
  previous: StreamingProjection,
  record: KafkaMarketRecord,
  universe: StreamingUniverse,
  availableAtMs: number,
  decodedEvent?: RawMarketEvent,
  featureRecordedAtMs = availableAtMs,
): StreamingProjection => {
  if (
    !Number.isSafeInteger(record.partition) ||
    record.partition < 0 ||
    record.partition > 2_147_483_647 ||
    !/^(0|[1-9][0-9]*)$/.test(record.offset) ||
    BigInt(record.offset) > 9_223_372_036_854_775_807n ||
    !Number.isSafeInteger(availableAtMs) ||
    availableAtMs < 0 ||
    !Number.isSafeInteger(featureRecordedAtMs) ||
    featureRecordedAtMs < 0
  ) {
    return reject(previous, record, availableAtMs, 'invalid-transport-coordinate')
  }
  const recordHash = createHash('sha256').update(record.value).digest('hex')
  const key = topicPartitionKey(record.topic, record.partition)
  const priorOffset = previous.offsets.get(key)
  if (priorOffset !== undefined && compareOffsets(record.offset, priorOffset) <= 0) {
    const sameRawCoordinate = (entry: ObservedMarketValue<IntradayBar | IntradayQuote | IntradayTrade>) =>
      entry.value.sourceTopic === record.topic &&
      entry.value.sourcePartition === record.partition &&
      entry.value.sourceOffset === record.offset
    const retained =
      record.topic === universe.topics.features
        ? [...previous.features.values()]
            .flat()
            .find(
              (entry) =>
                entry.topic === record.topic && entry.partition === record.partition && entry.offset === record.offset,
            )
        : ([...previous.bars.values()].flat().find(sameRawCoordinate) ??
          [...previous.quotes.values()].find(sameRawCoordinate) ??
          [...previous.trades.values()].find(sameRawCoordinate))
    return retained !== undefined && retained.recordHash !== recordHash
      ? reject(previous, record, availableAtMs, 'conflicting-immutable-record')
      : previous
  }
  const sequence = previous.sequence + 1
  const state = {
    ...previous,
    sequence,
    featureArrival: null,
    offsets: new Map(previous.offsets).set(key, record.offset),
  }
  if (record.topic === universe.topics.features) {
    const parsed = Result.try({
      try: (): unknown => JSON.parse(record.value),
      catch: () => new MarketFeatureFailure({ reason: 'schema', message: 'feature is not JSON' }),
    }).pipe(Result.flatMap(decodeRollingMarketFeature))
    if (Result.isFailure(parsed)) return reject(state, record, availableAtMs, parsed.failure.reason)
    const feature = parsed.success
    const material = feature.material
    if (
      material.universeId !== universe.universeId ||
      material.universeSymbolHash !== universe.universeSymbolHash ||
      !universe.symbols.includes(material.symbol) ||
      material.inputs.some((input) => input.sourceTopic !== universe.topics.bars) ||
      feature.computedAtMs > featureRecordedAtMs + marketFeatureClockSkewAllowanceMs ||
      (record.timestampMs !== undefined &&
        (!Number.isSafeInteger(record.timestampMs) || Math.abs(record.timestampMs - feature.computedAtMs) > 5000))
    )
      return reject(state, record, availableAtMs, 'identity-or-availability')
    const existing = state.features.get(material.symbol) ?? []
    if (existing.some((entry) => entry.value.featureId === feature.featureId)) return state
    const incoming: ObservedFeature = {
      value: feature,
      availableAtMs,
      sequence,
      recordHash,
      topic: record.topic,
      partition: record.partition,
      offset: record.offset,
    }
    const features = [...existing, incoming]
      .toSorted((a, b) => b.value.material.windowEndMs - a.value.material.windowEndMs || b.sequence - a.sequence)
      .slice(0, 64)
    return { ...state, featureArrival: incoming, features: new Map(state.features).set(material.symbol, features) }
  }
  const parsed = decodedEvent === undefined ? decodeRawMarketRecord(record, universe) : Result.succeed(decodedEvent)
  if (Result.isFailure(parsed)) return reject(state, record, availableAtMs, parsed.failure.reason)
  const event = parsed.success
  if (event.kind === RawMarketEventKind.Ignored) return state
  const ingestedAtNanos = intradayInstantNanos(event.value.ingestedAt)
  if (
    ingestedAtNanos > (BigInt(availableAtMs + marketFeatureClockSkewAllowanceMs) + 1n) * 1_000_000n - 1n ||
    ingestedAtNanos + BigInt(marketFeatureClockSkewAllowanceMs) * 1_000_000n < intradayInstantNanos(event.value.eventAt)
  )
    return reject(state, record, availableAtMs, 'availability')
  switch (event.kind) {
    case RawMarketEventKind.Bar: {
      const bar = event.value
      const existing = state.bars.get(bar.symbol) ?? []
      const current = existing.find((entry) => compareIntradayInstants(entry.value.eventAt, bar.eventAt) === 0)
      if (current !== undefined && compareBarRevisions(bar, current.value) <= 0) return state
      const revisions = [...existing, { value: bar, availableAtMs, sequence, recordHash }].toSorted(
        (a, b) => compareIntradayInstants(b.value.eventAt, a.value.eventAt) || compareBarRevisions(b.value, a.value),
      )
      const minuteCounts = new Map<bigint, number>()
      const bars: ObservedMarketValue<IntradayBar>[] = []
      let minimumObservationMs = state.minimumObservationMs
      for (const entry of revisions) {
        const minute = intradayInstantNanos(entry.value.eventAt)
        const count = minuteCounts.get(minute) ?? 0
        if (count === 0 && minuteCounts.size === 61) continue
        minuteCounts.set(minute, count + 1)
        if (count < 4) bars.push(entry)
        else {
          const earliestRetained = bars.findLast((retained) => intradayInstantNanos(retained.value.eventAt) === minute)
          minimumObservationMs = Math.max(minimumObservationMs, earliestRetained?.availableAtMs ?? availableAtMs)
        }
      }
      return { ...state, minimumObservationMs, bars: new Map(state.bars).set(bar.symbol, bars) }
    }
    case RawMarketEventKind.Quote: {
      const current = state.quotes.get(event.value.symbol)
      if (current !== undefined && compareCurrent(event.value, current.value) <= 0) return state
      const entry = { value: event.value, availableAtMs, sequence, recordHash }
      const history = [...(state.quoteHistory.get(event.value.symbol) ?? []), entry]
      const evicted = history.length > 512 ? history[history.length - 513] : undefined
      return {
        ...state,
        quoteHistory: new Map(state.quoteHistory).set(event.value.symbol, history.slice(-512)),
        minimumObservationMs: Math.max(state.minimumObservationMs, evicted?.availableAtMs ?? 0),
        quotes: new Map(state.quotes).set(event.value.symbol, {
          value: event.value,
          availableAtMs,
          sequence,
          recordHash,
        }),
      }
    }
    case RawMarketEventKind.Trade: {
      const current = state.trades.get(event.value.symbol)
      if (current !== undefined && compareCurrent(event.value, current.value) <= 0) return state
      const entry = { value: event.value, availableAtMs, sequence, recordHash }
      const history = [...(state.tradeHistory.get(event.value.symbol) ?? []), entry]
      const evicted = history.length > 512 ? history[history.length - 513] : undefined
      return {
        ...state,
        tradeHistory: new Map(state.tradeHistory).set(event.value.symbol, history.slice(-512)),
        minimumObservationMs: Math.max(state.minimumObservationMs, evicted?.availableAtMs ?? 0),
        trades: new Map(state.trades).set(event.value.symbol, {
          value: event.value,
          availableAtMs,
          sequence,
          recordHash,
        }),
      }
    }
  }
}

export const incorporateMarketRecord = (
  previous: StreamingProjection,
  record: KafkaMarketRecord,
  universe: StreamingUniverse,
  availableAtMs: number,
): StreamingProjection => incorporateDecodedRecord(previous, record, universe, availableAtMs)

/** Research can model earlier feature arrivals while retaining the real production timestamp. */
export const incorporateSimulatedMarketRecord = (
  previous: StreamingProjection,
  record: KafkaMarketRecord,
  universe: StreamingUniverse,
  availableAtMs: number,
  featureRecordedAtMs = availableAtMs,
): StreamingProjection =>
  incorporateDecodedRecord(
    { ...previous, availabilityMode: 'simulated' },
    record,
    universe,
    availableAtMs,
    undefined,
    featureRecordedAtMs,
  )

/** Recorded-decision replay passes decoded archived rows through the same reducer without re-encoding binary64 values. */
export const incorporateRecordedMarketValue = (
  previous: StreamingProjection,
  value: IntradayBar | IntradayQuote | IntradayTrade,
  universe: StreamingUniverse,
  availableAtMs: number,
): StreamingProjection => {
  const event: RawMarketEvent =
    'open' in value
      ? { kind: RawMarketEventKind.Bar, value }
      : 'bidPrice' in value
        ? { kind: RawMarketEventKind.Quote, value }
        : { kind: RawMarketEventKind.Trade, value }
  return incorporateDecodedRecord(
    previous,
    {
      topic: value.sourceTopic,
      partition: value.sourcePartition,
      offset: value.sourceOffset,
      value: JSON.stringify(value),
    },
    universe,
    availableAtMs,
    event,
  )
}

export interface StreamingSymbolInputs {
  readonly bars: readonly IntradayBar[]
  readonly quote: IntradayQuote
  readonly trade: IntradayTrade
  readonly feature: ObservedFeature
}

/** Choose the winning revision that had arrived at the observation, preserving earlier cuts across corrections. */
export const observedBarsAt = (
  state: StreamingProjection,
  symbol: string,
  startNanos: bigint,
  endNanos: bigint,
  observedAtMs: number,
): readonly ObservedMarketValue<IntradayBar>[] => {
  const selected = new Map<bigint, ObservedMarketValue<IntradayBar>>()
  for (const entry of state.bars.get(symbol) ?? []) {
    const minute = intradayInstantNanos(entry.value.eventAt)
    if (entry.availableAtMs > observedAtMs || minute < startNanos || minute >= endNanos) continue
    const prior = selected.get(minute)
    if (prior === undefined || compareBarRevisions(entry.value, prior.value) > 0) selected.set(minute, entry)
  }
  return [...selected.values()].toSorted((a, b) => compareIntradayInstants(a.value.eventAt, b.value.eventAt))
}

export const selectStreamingSymbolInputs = (
  state: StreamingProjection,
  symbol: string,
  windowStartMs: number,
  windowEndMs: number,
  observedAtMs: number,
): Result.Result<StreamingSymbolInputs, MarketFeatureFailure> =>
  Result.gen(function* () {
    const fail = (message: string) => Result.fail(new MarketFeatureFailure({ reason: 'input', message }))
    const bars = observedBarsAt(
      state,
      symbol,
      BigInt(windowStartMs) * 1_000_000n,
      BigInt(windowEndMs) * 1_000_000n,
      observedAtMs,
    ).map((entry) => entry.value)
    if (observedAtMs < state.minimumObservationMs) return yield* fail('observation precedes retained arrival history')
    if (windowStartMs <= state.discardedRejectionsThroughMs)
      return yield* fail('requested window precedes retained rejection history')
    const quote = state.quoteHistory.get(symbol)?.findLast((entry) => entry.availableAtMs <= observedAtMs)
    const trade = state.tradeHistory.get(symbol)?.findLast((entry) => entry.availableAtMs <= observedAtMs)
    if (
      quote === undefined ||
      trade === undefined ||
      quote.availableAtMs > observedAtMs ||
      trade.availableAtMs > observedAtMs
    )
      return yield* fail('current raw quote or trade is unavailable')
    const coordinates = [...bars, quote.value, trade.value].map((row) =>
      topicPartitionKey(row.sourceTopic, row.sourcePartition),
    )
    if (
      coordinates.some((coordinate) => {
        return (state.rejections.get(coordinate) ?? []).some(
          (rejection) => rejection.availableAtMs >= windowStartMs && rejection.availableAtMs <= observedAtMs,
        )
      })
    )
      return yield* fail('input partition has rejected records in the observation window')
    for (const feature of state.features.get(symbol) ?? []) {
      if (
        feature.availableAtMs > observedAtMs ||
        feature.value.material.windowStartMs !== windowStartMs ||
        feature.value.material.windowEndMs !== windowEndMs
      )
        continue
      if (
        (state.rejections.get(topicPartitionKey(feature.topic, feature.partition)) ?? []).some(
          (rejection) => rejection.availableAtMs >= windowStartMs && rejection.availableAtMs <= observedAtMs,
        )
      )
        return yield* fail('feature partition has rejected records in the observation window')
      if (yield* featureMatchesBars(feature.value, bars))
        return { bars, quote: quote.value, trade: trade.value, feature }
    }
    return yield* fail('matching rolling feature is unavailable')
  })
