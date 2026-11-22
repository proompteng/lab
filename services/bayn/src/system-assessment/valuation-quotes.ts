import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema, Stream } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { streamNativeArrivalChunkPage, readNativeArrivalEpoch } from '../db/native-arrival-postgres'
import type { NativeArrival, NativeArrivalEpoch } from '../market-data/streaming/native-arrival'
import { CaptureDisposition, restoreKafkaTransportTimestamp } from '../market-data/streaming/transport-evidence'
import { decodeRawMarketRecord, marketSourceForTopic, RawMarketEventKind } from '../market-data/streaming/raw-events'
import { compareCurrentMarketRecord, type ObservedMarketValue } from '../market-data/streaming/projection'
import type { IntradayQuote } from '../market-data/intraday/model'
import { replayQuoteRejection } from '../intraday-replay/broker-execution-evidence'
import type { JevMarketProfile } from '../jev/markets'
import { priceNumberToMicros } from '../strategy/execution-model/fixed-point'
import { quantityFromNumber } from '../quantity'
import { Sha256Schema } from '../schemas'
import type { SystemRegistration } from './policy'
import { SystemAssessmentError } from './economics'

type QuoteObservation = Omit<ObservedMarketValue<IntradayQuote>, 'recordHash'> & {
  readonly source: { readonly epoch: NativeArrivalEpoch; readonly chunk: string; readonly arrival: NativeArrival }
}
type ValuationQuote = ObservedMarketValue<IntradayQuote> & {
  readonly source: QuoteObservation['source'] & {
    readonly frontier: { readonly chunk: string; readonly availableAtMs: number; readonly consumerSequence: number }
  }
}

export const executableValuationQuote = (
  quote: ObservedMarketValue<IntradayQuote> | undefined,
  symbol: string,
  at: string,
  maximumQuoteAgeMs: number,
  market: JevMarketProfile | undefined,
  quantityAtoms: string,
) => {
  const short = BigInt(quantityAtoms) < 0n
  if (
    market === undefined ||
    !market.universe.some((member) => member === symbol) ||
    BigInt(quantityAtoms) === 0n ||
    (short && symbol.includes('/')) ||
    quote === undefined ||
    quote.value.universeId !== market.universeId ||
    quote.value.universeSymbolHash !== market.universeSymbolHash ||
    quote.value.sourceTopic !== market.sourceTopics.quotes ||
    replayQuoteRejection(quote, symbol, Date.parse(at), { ...market, maximumQuoteAgeMs }) !== null
  )
    return null
  const price = priceNumberToMicros(
    short ? quote.value.askPrice : quote.value.bidPrice,
    'valuation.liquidation',
    short ? 'UP' : 'DOWN',
  )
  const size = quantityFromNumber(short ? quote.value.askSize : quote.value.bidSize)
  if (Result.isFailure(price) || Result.isFailure(size) || price.success <= 0n || size.success <= 0n) return null
  return short
    ? { askPriceMicros: price.success.toString(), quoteSourceHash: quote.recordHash }
    : { bidPriceMicros: price.success.toString(), quoteSourceHash: quote.recordHash }
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
    const instants = [...symbolsAt.keys()].sort().map((at) => ({ at, ms: Date.parse(at) }))
    const selected = new Map<string, Map<string, ValuationQuote>>()
    if (instants.length === 0) return selected
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
      const current = new Map<string, QuoteObservation>()
      let nextInstant = 0
      let ordinal = -1
      let previousHash: string | null = null
      let previousSequence = 0
      let previousAvailableAtMs = 0
      const retainBefore = (frontier: ValuationQuote['source']['frontier']) =>
        Effect.gen(function* () {
          while (nextInstant < instants.length) {
            const instant = instants[nextInstant]
            if (instant === undefined || instant.ms >= frontier.availableAtMs) break
            const { at } = instant
            const merged = selected.get(at) ?? new Map<string, ValuationQuote>()
            for (const [symbol, quote] of current) {
              if (symbolsAt.get(at)?.has(symbol) !== true) continue
              const previous = merged.get(symbol)
              if (previous === undefined || compareCurrentMarketRecord(quote.value, previous.value) > 0) {
                const source = { ...quote.source, frontier }
                merged.set(symbol, {
                  ...quote,
                  source,
                  recordHash: yield* Effect.fromResult(canonicalHashV1Result(source)),
                })
              }
            }
            selected.set(at, merged)
            nextInstant++
          }
        })
      while (nextInstant < instants.length) {
        const afterOrdinal = ordinal
        yield* streamNativeArrivalChunkPage(sql, epoch, ordinal).pipe(
          Stream.runForEachWhile((chunk) =>
            Effect.gen(function* () {
              if (
                chunk.header.ordinal !== ordinal + 1 ||
                chunk.header.previousHash !== previousHash ||
                chunk.header.firstConsumerSequence !== previousSequence + 1 ||
                chunk.header.firstAvailableAtMs < previousAvailableAtMs
              )
                return yield* new SystemAssessmentError({ message: 'Valuation quote journal has an incomplete prefix' })
              for (const arrival of chunk.records) {
                const next = instants[nextInstant]
                if (next !== undefined && next.ms < arrival.availableAtMs)
                  yield* retainBefore({
                    chunk: chunk.contentHash,
                    availableAtMs: arrival.availableAtMs,
                    consumerSequence: arrival.receipt.consumerSequence,
                  })
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
                })
              }
              ordinal = chunk.header.ordinal
              previousHash = chunk.contentHash
              previousSequence = chunk.header.lastConsumerSequence
              previousAvailableAtMs = chunk.header.lastAvailableAtMs
              return nextInstant < instants.length
            }),
          ),
        )
        if (ordinal === afterOrdinal) break
      }
      // EOF can follow an incomplete capture. Only an archived arrival strictly after a mark proves its frontier.
    }
    return selected
  })
