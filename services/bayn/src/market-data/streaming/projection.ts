import { MarketKind } from '../../instruments'
import { CaptureDisposition } from './transport-evidence'
import {
  cryptoFeatureDefinitionMaterial,
  decodeCryptoMarketFeature,
  isCryptoMarketFeature,
} from '../features/crypto-contract'
import type { NativeMarketFeature } from '../features/native-feature'
import { sameBarMarketValues } from '../intraday/bar-publication'
import { createHash } from 'node:crypto'
import { Result, Schema } from 'effect'
import type { RawMarketEvent } from './raw-events'
import type { TechnicalMarketFeature } from '../features/technical-contract'
import { incorporateTechnicalRecord, type TechnicalInputRejection } from './technical-projection'

import { compareIntradayInstants, intradayInstantNanos } from '../intraday/time'
import type { IntradayBar, IntradayQuote, IntradayTrade } from '../intraday/model'
import {
  decodeRollingMarketFeature,
  MarketFeatureFailure,
  MarketFeatureDefinition,
  marketFeatureClockSkewAllowanceMs,
} from '../features/contract'
import {
  decodeRawMarketRecord,
  marketSourceKind,
  RawMarketEventKind,
  type KafkaMarketRecord,
  type StreamingUniverse,
} from './raw-events'

export const kafkaCaptureDisposition = (previous: StreamingProjection, next: StreamingProjection) => {
  if (next.rejections !== previous.rejections || next.technicalRejections !== previous.technicalRejections)
    return CaptureDisposition.Rejected
  return next.bars !== previous.bars ||
    next.quotes !== previous.quotes ||
    next.trades !== previous.trades ||
    next.features !== previous.features ||
    next.technicalFeatures !== previous.technicalFeatures
    ? CaptureDisposition.Accepted
    : CaptureDisposition.Ignored
}

const decodeFeatureIdentity = Schema.decodeUnknownResult(
  Schema.Struct({ material: Schema.Struct({ definitionId: Schema.NonEmptyString }) }),
)

export interface ObservedMarketValue<A> {
  readonly value: A
  readonly availableAtMs: number
  readonly sequence: number
  readonly recordHash: string
}
export interface ObservedQuoteSource {
  readonly topic: string
  readonly partition: number
  readonly offset: string
  readonly availableAtMs: number
}
export interface ObservedBar extends ObservedMarketValue<IntradayBar> {
  readonly firstPublication?: ObservedMarketValue<IntradayBar>
}
export interface ObservedFeature<A = NativeMarketFeature> extends ObservedMarketValue<A> {
  readonly topic: string
  readonly partition: number
  readonly offset: string
}
export interface StreamingProjection {
  readonly availabilityMode: 'observed' | 'simulated'
  readonly epoch: string
  readonly sequence: number
  readonly sources: ReadonlyMap<string, StreamingUniverse>
  readonly offsets: ReadonlyMap<string, string>
  readonly bars: ReadonlyMap<string, readonly ObservedBar[]>
  readonly quotes: ReadonlyMap<string, ObservedMarketValue<IntradayQuote>>
  readonly trades: ReadonlyMap<string, ObservedMarketValue<IntradayTrade>>
  readonly quoteHistory: ReadonlyMap<string, readonly ObservedMarketValue<IntradayQuote>[]>
  readonly tradeHistory: ReadonlyMap<string, readonly ObservedMarketValue<IntradayTrade>[]>
  readonly minimumObservationMs: number
  readonly minimumQuoteObservationMs: ReadonlyMap<string, number>
  readonly features: ReadonlyMap<string, readonly ObservedFeature[]>
  /** The accepted feature for this disposition, including one too old for retained join history. */
  readonly featureArrival: ObservedFeature | null
  readonly technicalTopic?: string
  readonly technicalFeatures: ReadonlyMap<string, readonly ObservedFeature<TechnicalMarketFeature>[]>
  readonly technicalFeatureArrival: ObservedFeature<TechnicalMarketFeature> | null
  readonly technicalRejections: readonly TechnicalInputRejection[]
  readonly technicalRejectionsDiscardedThrough: Pick<TechnicalInputRejection, 'availableAtMs' | 'sequence'> | null
  readonly discardedRejectionsThroughMs: ReadonlyMap<string, number>
  readonly rejections: ReadonlyMap<
    string,
    readonly { readonly availableAtMs: number; readonly offset: string; readonly reason: string }[]
  >
}
export const emptyStreamingProjection = (epoch: string, technicalTopic?: string): StreamingProjection => ({
  availabilityMode: 'observed',
  epoch,
  sequence: 0,
  sources: new Map(),
  offsets: new Map(),
  bars: new Map(),
  quotes: new Map(),
  trades: new Map(),
  quoteHistory: new Map(),
  tradeHistory: new Map(),
  minimumObservationMs: 0,
  minimumQuoteObservationMs: new Map(),
  features: new Map(),
  featureArrival: null,
  ...(technicalTopic === undefined ? {} : { technicalTopic }),
  technicalFeatures: new Map(),
  technicalFeatureArrival: null,
  technicalRejections: [],
  technicalRejectionsDiscardedThrough: null,
  discardedRejectionsThroughMs: new Map(),
  rejections: new Map(),
})
export const topicPartitionKey = (topic: string, partition: number): string => `${topic}:${partition}`

export const discardedRejectionsOverlap = (
  state: StreamingProjection,
  windowStartMs: number,
  topic?: string,
): boolean => {
  for (const [key, discardedThroughMs] of state.discardedRejectionsThroughMs) {
    if ((topic === undefined || key.startsWith(`${topic}:`)) && windowStartMs <= discardedThroughMs) return true
  }
  return false
}

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
    discardedRejectionsThroughMs:
      discarded === undefined
        ? state.discardedRejectionsThroughMs
        : new Map(state.discardedRejectionsThroughMs).set(
            key,
            Math.max(state.discardedRejectionsThroughMs.get(key) ?? -1, discarded.availableAtMs),
          ),
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
  technicalRecordedAtMs = availableAtMs,
): StreamingProjection => {
  if (universe.topics.technicalFeatures !== undefined && record.topic === universe.topics.technicalFeatures)
    return incorporateTechnicalRecord(previous, record, universe, availableAtMs, technicalRecordedAtMs)
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
    const retainedHistory = (histories: Iterable<readonly ObservedMarketValue<IntradayQuote | IntradayTrade>[]>) => {
      for (const history of histories) {
        const entry = history.find(sameRawCoordinate)
        if (entry !== undefined) return entry
      }
      return undefined
    }
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
          [...previous.trades.values()].find(sameRawCoordinate) ??
          retainedHistory(previous.quoteHistory.values()) ??
          retainedHistory(previous.tradeHistory.values()))
    return retained !== undefined && retained.recordHash !== recordHash
      ? reject(previous, record, availableAtMs, 'conflicting-immutable-record')
      : previous
  }
  const sequence = previous.sequence + 1
  const state = {
    ...previous,
    sequence,
    sources: new Map(previous.sources).set(universe.universeId, universe),
    featureArrival: null,
    technicalFeatureArrival: null,
    offsets: new Map(previous.offsets).set(key, record.offset),
  }
  if (record.topic === universe.topics.features) {
    const document = Result.try({
      try: (): unknown => JSON.parse(record.value),
      catch: () => new MarketFeatureFailure({ reason: 'schema', message: 'feature is not JSON' }),
    })
    if (Result.isFailure(document)) return reject(state, record, availableAtMs, document.failure.reason)
    const identity = decodeFeatureIdentity(document.success)
    if (Result.isFailure(identity)) return reject(state, record, availableAtMs, 'schema')
    const crypto = marketSourceKind(universe) === MarketKind.Crypto
    const requiredDefinition = crypto ? cryptoFeatureDefinitionMaterial[0] : MarketFeatureDefinition.ObservedPriceWindow
    // Shared retained topics may contain other feature definitions. They provide no
    // input or authority for this strategy; the selected definition is decoded strictly.
    if (identity.success.material.definitionId !== requiredDefinition) return state
    const parsed: Result.Result<NativeMarketFeature, MarketFeatureFailure> = crypto
      ? decodeCryptoMarketFeature(document.success)
      : decodeRollingMarketFeature(document.success)
    if (Result.isFailure(parsed)) return reject(state, record, availableAtMs, parsed.failure.reason)
    const feature = parsed.success
    const material = feature.material
    if (
      (!isCryptoMarketFeature(feature) &&
        (feature.material.universeId !== universe.universeId ||
          feature.material.universeSymbolHash !== universe.universeSymbolHash)) ||
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
      // Histories are already sorted and bounded by this reducer. Merge the new
      // revision without sorting or mutating an earlier projection's history.
      const bars: ObservedBar[] = []
      let minimumObservationMs = state.minimumObservationMs
      let incoming = true
      let index = 0
      let previousMinute: string | undefined
      let minutes = 0
      let revisions = 0
      let earliestRetainedAtMs = availableAtMs
      while (incoming || index < existing.length) {
        const prior = existing[index]
        let entry: ObservedBar
        if (
          incoming &&
          (prior === undefined ||
            (compareIntradayInstants(prior.value.eventAt, bar.eventAt) || compareBarRevisions(prior.value, bar)) < 0)
        ) {
          entry = revision
          incoming = false
        } else if (prior !== undefined) {
          entry = prior
          index++
        } else break
        // Recorded timestamps may have three fractional digits; raw rows have nine.
        if (previousMinute === undefined || compareIntradayInstants(entry.value.eventAt, previousMinute) !== 0) {
          if (++minutes > 61) break
          previousMinute = entry.value.eventAt
          revisions = 0
        }
        if (revisions++ < 4) {
          bars.push(entry)
          earliestRetainedAtMs = entry.availableAtMs
        } else minimumObservationMs = Math.max(minimumObservationMs, earliestRetainedAtMs)
      }
      return { ...state, minimumObservationMs, bars: new Map(state.bars).set(bar.symbol, bars) }
    }
    case RawMarketEventKind.Quote: {
      const current = state.quotes.get(event.value.symbol)
      if (current !== undefined && compareCurrent(event.value, current.value) <= 0) return state
      const entry = { value: event.value, availableAtMs, sequence, recordHash }
      const previousHistory = state.quoteHistory.get(event.value.symbol) ?? []
      const evicted = previousHistory.length >= 512 ? previousHistory[previousHistory.length - 512] : undefined
      const history = previousHistory.slice(-511)
      history.push(entry)
      return {
        ...state,
        quoteHistory: new Map(state.quoteHistory).set(event.value.symbol, history),
        minimumObservationMs: Math.max(state.minimumObservationMs, evicted?.availableAtMs ?? 0),
        minimumQuoteObservationMs:
          evicted === undefined
            ? state.minimumQuoteObservationMs
            : new Map(state.minimumQuoteObservationMs).set(
                event.value.symbol,
                Math.max(state.minimumQuoteObservationMs.get(event.value.symbol) ?? 0, evicted.availableAtMs),
              ),
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
  technicalRecordedAtMs = availableAtMs,
): StreamingProjection =>
  incorporateDecodedRecord(
    { ...previous, availabilityMode: 'simulated' },
    record,
    universe,
    availableAtMs,
    undefined,
    featureRecordedAtMs,
    technicalRecordedAtMs,
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

/** Choose the winning revision that had arrived at the observation, preserving earlier cuts across corrections. */
export const observedQuoteAt = (
  state: Pick<StreamingProjection, 'quoteHistory'>,
  symbol: string,
  observedAtMs: number,
  source: ObservedQuoteSource | null = null,
) =>
  state.quoteHistory
    .get(symbol)
    ?.findLast(
      (entry) =>
        entry.availableAtMs <= observedAtMs &&
        (source === null ||
          (entry.availableAtMs === source.availableAtMs &&
            entry.value.sourceTopic === source.topic &&
            entry.value.sourcePartition === source.partition &&
            entry.value.sourceOffset === source.offset)),
    )

export const observedBarsAt = (
  state: StreamingProjection,
  symbol: string,
  startNanos: bigint,
  endNanos: bigint,
  observedAtMs: number,
): readonly ObservedBar[] => {
  const selected = new Map<bigint, ObservedBar>()
  for (const entry of state.bars.get(symbol) ?? []) {
    const minute = intradayInstantNanos(entry.value.eventAt)
    if (entry.availableAtMs > observedAtMs || minute < startNanos || minute >= endNanos) continue
    const prior = selected.get(minute)
    if (prior === undefined || compareBarRevisions(entry.value, prior.value) > 0) selected.set(minute, entry)
  }
  return [...selected.values()].toSorted((a, b) => compareIntradayInstants(a.value.eventAt, b.value.eventAt))
}
