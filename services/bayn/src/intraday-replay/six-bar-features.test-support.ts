import { equityMarketProfile } from '../jev/markets'
import { Result } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { sha256, canonicalHashV1Result } from '../hash'
import { defaultJevProtocolDocument, decodeJevProtocol } from '../jev/protocol'
import { IntradayCandidateEvidencePolicy, type IntradaySnapshotQuery } from '../market-data/intraday/model'
import {
  advanceHistoricalMarketCursor,
  createHistoricalMarketCursor,
  type HistoricalMarketArrival,
  type HistoricalMarketCursor,
} from '../market-data/streaming/historical'
import {
  kafkaCaptureDisposition,
  emptyStreamingProjection,
  incorporateSimulatedMarketRecord,
} from '../market-data/streaming/projection'
import { captureKafkaTransport } from '../market-data/streaming/transport-evidence'

export const sixBarOpenMs = Date.parse('2026-09-04T13:30:00.000Z')
export const sixBarEndMs = sixBarOpenMs + 360_000
export const sixBarObservedMs = sixBarEndMs + 2_000
const iso = (at: number) => new Date(at).toISOString()
const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
export const sixBarUniverse = {
  universeId: equityMarketProfile.universeId,
  universeSymbolHash: equityMarketProfile.universeSymbolHash,
  symbols: equityMarketProfile.universe,
  topics: { ...equityMarketProfile.sourceTopics, features: equityMarketProfile.streamingInput.featureTopic },
}

export interface SixBarFixtureInput {
  readonly availableAtMs: number
  readonly channel: 'bars' | 'updatedBars' | 'quotes' | 'trades'
  readonly symbol: string
  readonly eventAtMs: number
  readonly eventAtText?: string
  readonly ingestedAtMs?: number
  readonly close?: number
  readonly bid?: number
  readonly ask?: number
  readonly bidSize?: number
  readonly askSize?: number
  readonly final?: boolean
  readonly marketSession?: string
}

export const sixBarFixtureInputs = (): SixBarFixtureInput[] => {
  const inputs: SixBarFixtureInput[] = []
  for (let index = 0; index < 6; index++)
    for (const symbol of ['AAPL', 'SPY'])
      inputs.push({
        availableAtMs: sixBarOpenMs + (index + 1) * 60_000 + 1_000,
        channel: 'bars',
        symbol,
        eventAtMs: sixBarOpenMs + index * 60_000,
        close: symbol === 'AAPL' ? 100 + index : 200 + index * 0.4,
      })
  for (const symbol of ['AAPL', 'SPY']) {
    inputs.push({
      availableAtMs: sixBarEndMs + 1_000,
      channel: 'quotes',
      symbol,
      eventAtMs: sixBarEndMs + 1_000,
      bid: symbol === 'AAPL' ? 104.99 : 201.99,
      ask: symbol === 'AAPL' ? 105.01 : 202.01,
      bidSize: symbol === 'AAPL' ? 300 : 500,
      askSize: symbol === 'AAPL' ? 100 : 500,
    })
    inputs.push({
      availableAtMs: sixBarEndMs + 1_000,
      channel: 'trades',
      symbol,
      eventAtMs: sixBarEndMs + 1_000,
      close: symbol === 'AAPL' ? 105 : 202,
    })
  }
  return inputs
}

export const sixBarFixture = (
  inputs = sixBarFixtureInputs(),
  close = '16:00',
  encode = (value: string) => Buffer.from(value),
) => {
  const offsets = new Map<string, number>()
  let projection = emptyStreamingProjection('synthetic-six-bar-receipts')
  const events: Extract<HistoricalMarketArrival, { schemaVersion: 'bayn.original-market-arrival.v2' }>[] = []
  for (const [index, input] of inputs.toSorted((a, b) => a.availableAtMs - b.availableAtMs).entries()) {
    const topic =
      input.channel === 'quotes'
        ? sixBarUniverse.topics.quotes
        : input.channel === 'trades'
          ? sixBarUniverse.topics.trades
          : sixBarUniverse.topics.bars
    const offset = offsets.get(topic) ?? 0
    offsets.set(topic, offset + 1)
    const at = input.eventAtText ?? iso(input.eventAtMs)
    const price = input.close ?? 100
    const value = JSON.stringify({
      version: 2,
      provider: 'alpaca',
      feed: 'iex',
      delayClass: 'real_time_exchange_only',
      marketSession: input.marketSession ?? 'regular',
      symbol: input.symbol,
      channel: input.channel,
      eventTs: at,
      ingestTs: iso(input.ingestedAtMs ?? input.availableAtMs),
      ...(input.channel === 'bars' || input.channel === 'updatedBars' ? { isFinal: input.final ?? true } : {}),
      payload:
        input.channel === 'quotes'
          ? { t: at, bp: input.bid, ap: input.ask, bs: input.bidSize, as: input.askSize }
          : input.channel === 'trades'
            ? { t: at, p: price, s: 100 }
            : { t: at, o: price, h: price + 1, l: price - 1, c: price, v: 1_000, vw: price, n: 100 },
    })
    const bytes = encode(value)
    const record = { topic, partition: 0, offset: String(offset), value: bytes.toString('utf8') }
    const next = incorporateSimulatedMarketRecord(projection, record, sixBarUniverse, input.availableAtMs)
    events.push({
      schemaVersion: 'bayn.original-market-arrival.v2',
      availableAtMs: input.availableAtMs,
      record,
      originalTransport: captureKafkaTransport(undefined),
      rawValueBase64: bytes.toString('base64'),
      receipt: {
        captureId: 'SYNTHETIC-six-bar-contract',
        consumerEpoch: 'SYNTHETIC-epoch-1',
        sequence: index + 1,
        consumerSequence: index + 1,
        projectionSequence: next.sequence,
        disposition: kafkaCaptureDisposition(projection, next),
        tombstone: false,
        rawValueSha256: sha256(bytes),
        rawByteLength: bytes.byteLength,
      },
    })
    projection = next
  }
  const eventsHash = Result.getOrThrow(canonicalHashV1Result(events))
  const source = {
    runId: Result.getOrThrow(canonicalHashV1Result({ fixture: 'six-bar-research', eventsHash })),
    sourceManifestHash: eventsHash,
    marketSources: [sixBarUniverse],
    deliveryModel: {
      schemaVersion: 'bayn.original-capture-arrivals.v1',
      description: 'Synthetic original-format receipts, not a captured market session.',
      tieBreak: 'availability-receipt-sequence',
      captureId: 'SYNTHETIC-six-bar-contract',
      consumerEpoch: 'SYNTHETIC-epoch-1',
      exportManifestHash: eventsHash,
      intervalReceiptHash: Result.getOrThrow(canonicalHashV1Result(events.map((event) => event.receipt))),
      finalConsumerSequence: events.length,
    },
  } satisfies NonNullable<HistoricalMarketCursor['source']>
  const calendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      [{ date: '2026-09-04', open: '09:30', close, session_open: '0930', session_close: close.replace(':', '') }],
      {
        start: '2026-09-04',
        end: '2026-09-04',
      },
    ),
  )
  const query: IntradaySnapshotQuery = {
    sessionDate: '2026-09-04',
    calendar,
    rangeStartAt: iso(sixBarOpenMs),
    rangeEndAt: iso(sixBarEndMs),
    observedAt: iso(sixBarObservedMs),
    universeId: equityMarketProfile.universeId,
    universeSymbolHash: equityMarketProfile.universeSymbolHash,
    universe: equityMarketProfile.universe,
    symbols: ['AAPL', 'SPY'],
    candidateSymbols: ['AAPL'],
    candidateEvidencePolicy: IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
    feed: equityMarketProfile.feed,
    delayClass: equityMarketProfile.delayClass,
    sourceTopics: equityMarketProfile.sourceTopics,
    maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
    minimumWatermarkLagMs: 2_000,
  }
  return { source, query, events, universe: sixBarUniverse }
}

export const replaySixBarFixture = (fixture: ReturnType<typeof sixBarFixture>, observedAtMs = sixBarObservedMs) => {
  let cursor: HistoricalMarketCursor = Result.getOrThrow(
    createHistoricalMarketCursor(fixture.source.runId, [fixture.universe], undefined, fixture.source),
  )
  for (const event of fixture.events) {
    if (event.availableAtMs > observedAtMs) break
    cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, event))
  }
  return cursor
}
