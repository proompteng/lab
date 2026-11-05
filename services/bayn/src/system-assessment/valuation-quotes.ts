import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { readNativeArrivalChunks, readNativeArrivalEpoch } from '../db/native-arrival-postgres'
import {
  decodeNativeArrivalChunk,
  type NativeArrival,
  type NativeArrivalEpoch,
} from '../market-data/streaming/native-arrival'
import { CaptureDisposition, restoreKafkaTransportTimestamp } from '../market-data/streaming/transport-evidence'
import { decodeRawMarketRecord, marketSourceForTopic, RawMarketEventKind } from '../market-data/streaming/raw-events'
import { compareCurrentMarketRecord, type ObservedMarketValue } from '../market-data/streaming/projection'
import type { IntradayQuote } from '../market-data/intraday/model'
import { replayQuoteRejection } from '../intraday-replay/broker-execution-evidence'
import { jevMarketForSymbol } from '../jev/markets'
import { priceNumberToMicros } from '../strategy/execution-model/fixed-point'
import { quantityFromNumber } from '../quantity'
import { Sha256Schema } from '../schemas'
import type { SystemRegistration } from './policy'
import { SystemAssessmentError } from './economics'

interface ValuationQuote extends ObservedMarketValue<IntradayQuote> {
  readonly source: { readonly epoch: NativeArrivalEpoch; readonly chunk: string; readonly arrival: NativeArrival }
}

export const executableBid = (
  quote: ObservedMarketValue<IntradayQuote> | undefined,
  symbol: string,
  at: string,
  maximumQuoteAgeMs: number,
) => {
  const market = jevMarketForSymbol(symbol)
  if (
    quote === undefined ||
    quote.value.universeId !== market.universeId ||
    quote.value.universeSymbolHash !== market.universeSymbolHash ||
    quote.value.sourceTopic !== market.sourceTopics.quotes ||
    replayQuoteRejection(quote, symbol, Date.parse(at), { ...market, maximumQuoteAgeMs }) !== null
  )
    return null
  const bid = priceNumberToMicros(quote.value.bidPrice, 'valuation.bid', 'DOWN')
  const size = quantityFromNumber(quote.value.bidSize)
  if (Result.isFailure(bid) || Result.isFailure(size) || bid.success <= 0n || size.success <= 0n) return null
  return { bidPriceMicros: bid.success.toString(), quoteSourceHash: quote.recordHash }
}

/** Retain the latest native quote at each observation, paging the original immutable journal. */
export const readValuationQuotes = (
  definition: SystemRegistration['policies'][number],
  requests: readonly { readonly at: string; readonly symbols: readonly string[] }[],
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const symbolsAt = new Map<string, Set<string>>()
    for (const request of requests)
      symbolsAt.set(request.at, new Set([...(symbolsAt.get(request.at) ?? []), ...request.symbols]))
    const instants = [...symbolsAt.keys()].sort()
    const selected = new Map<string, Map<string, ValuationQuote>>()
    const last = instants.at(-1)
    if (last === undefined) return selected
    const epochs = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ captureId: Sha256Schema })))(
      yield* sql`SELECT capture_id AS "captureId" FROM native_arrival_epochs
      WHERE payload::jsonb #>> '{build,sourceRevision}' = ${definition.sourceRevision}
        AND payload::jsonb #>> '{build,imageDigest}' = ${`sha256:${definition.imageDigest}`}
        AND payload::jsonb #>> '{build,strategyBehaviorHash}' = ${definition.strategyHash}
        AND payload::jsonb #>> '{build,strategyParameterHash}' = ${definition.parametersHash}
      ORDER BY capture_id`,
    )
    for (const { captureId } of epochs) {
      const epoch = yield* readNativeArrivalEpoch(sql, captureId)
      const current = new Map<string, ValuationQuote>()
      let nextInstant = 0
      let ordinal = -1
      let previousHash: string | null = null
      let previousSequence = 0
      let previousAvailableAtMs = 0
      const retainBefore = (availableAtMs: number) => {
        while (nextInstant < instants.length) {
          const at = instants[nextInstant]
          if (at === undefined || Date.parse(at) >= availableAtMs) break
          const merged = selected.get(at) ?? new Map<string, ValuationQuote>()
          for (const [symbol, quote] of current) {
            if (symbolsAt.get(at)?.has(symbol) !== true) continue
            const previous = merged.get(symbol)
            if (previous === undefined || compareCurrentMarketRecord(quote.value, previous.value) > 0)
              merged.set(symbol, quote)
          }
          selected.set(at, merged)
          nextInstant++
        }
      }
      while (nextInstant < instants.length) {
        const chunks = yield* readNativeArrivalChunks(sql, captureId, ordinal)
        if (chunks.length === 0) break
        for (const chunk of chunks) {
          if (
            chunk.header.ordinal !== ordinal + 1 ||
            chunk.header.previousHash !== previousHash ||
            chunk.header.firstConsumerSequence !== previousSequence + 1 ||
            chunk.header.firstAvailableAtMs < previousAvailableAtMs
          )
            return yield* new SystemAssessmentError({ message: 'Valuation quote journal has an incomplete prefix' })
          for (const arrival of yield* Effect.fromResult(decodeNativeArrivalChunk(chunk))) {
            retainBefore(arrival.availableAtMs)
            if (nextInstant === instants.length) break
            if (arrival.receipt.disposition !== CaptureDisposition.Accepted) continue
            const source = marketSourceForTopic(epoch.sources, arrival.record.topic)
            if (source === undefined || arrival.record.topic !== source.topics.quotes) continue
            const timestampMs = restoreKafkaTransportTimestamp(arrival.originalTransport)
            const event = yield* Effect.fromResult(
              decodeRawMarketRecord(
                { ...arrival.record, ...(timestampMs === undefined ? {} : { timestampMs }) },
                source,
              ),
            )
            if (event.kind !== RawMarketEventKind.Quote) continue
            const previous = current.get(event.value.symbol)
            if (previous !== undefined && compareCurrentMarketRecord(event.value, previous.value) <= 0) continue
            const provenance = { epoch, chunk: chunk.contentHash, arrival }
            current.set(event.value.symbol, {
              source: provenance,
              value: event.value,
              availableAtMs: arrival.availableAtMs,
              sequence: arrival.receipt.consumerSequence,
              recordHash: yield* Effect.fromResult(canonicalHashV1Result(provenance)),
            })
          }
          ordinal = chunk.header.ordinal
          previousHash = chunk.contentHash
          previousSequence = chunk.header.lastConsumerSequence
          previousAvailableAtMs = chunk.header.lastAvailableAtMs
          if (nextInstant === instants.length) break
        }
      }
      retainBefore(Infinity)
    }
    return selected
  })
