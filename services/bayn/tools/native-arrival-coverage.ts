import { readFileSync, statSync } from 'node:fs'
import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../src/hash'
import {
  decodeNativeArrivalChunk,
  nativeArrivalCaptureId,
  NativeArrivalChunkHeaderSchema,
  NativeArrivalEpochSchema,
} from '../src/market-data/streaming/native-arrival'
import {
  decodeRawMarketRecord,
  marketSourceForTopic,
  RawMarketEventKind,
} from '../src/market-data/streaming/raw-events'
import { CaptureDisposition, restoreKafkaTransportTimestamp } from '../src/market-data/streaming/transport-evidence'
import type { ObservedMarketValue } from '../src/market-data/streaming/projection'
import type { IntradayQuote } from '../src/market-data/intraday/model'
import { NonNegativeIntegerSchema, Sha256Schema, SymbolSchema, strictParseOptions } from '../src/schemas'

export const nativeCoverageMaximumInputBytes = 32 * 1024 * 1024
const maximumDecodedBytes = 128 * 1024 * 1024
const Header = Schema.Struct({ contentHash: Sha256Schema, header: NativeArrivalChunkHeaderSchema })
const Input = Schema.Struct({
  epoch: Schema.Struct({ contentHash: Sha256Schema, epoch: NativeArrivalEpochSchema }),
  headers: Schema.Array(Header).check(Schema.isMinLength(1), Schema.isMaxLength(25_000)),
  chunks: Schema.Array(
    Schema.Struct({
      ...Header.fields,
      compressedBase64: Schema.String.check(Schema.isMaxLength(6 * 1024 * 1024)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  end: Schema.NullOr(
    Schema.Struct({
      captureId: Sha256Schema,
      status: Schema.Literals(['STOPPED', 'INCOMPLETE']),
      observedConsumerSequence: NonNegativeIntegerSchema,
      durableConsumerSequence: NonNegativeIntegerSchema,
      lastChunkHash: Schema.NullOr(Sha256Schema),
      reason: Schema.NullOr(Schema.String),
      consumerScopeCompleted: Schema.Boolean,
    }),
  ),
  interval: Schema.Struct({ startMs: NonNegativeIntegerSchema, endMs: NonNegativeIntegerSchema }),
  symbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
})

export class NativeArrivalCoverageError extends Data.TaggedError('NativeArrivalCoverageError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
const fail = (message: string) => Result.fail(new NativeArrivalCoverageError({ message }))

/** Private offline evidence audit, not a replay receipt or a claim about execution. */
export const auditNativeArrivalCoverage = (input: unknown) =>
  Result.gen(function* () {
    const request = yield* Schema.decodeUnknownResult(Input, strictParseOptions)(input)
    const { epoch } = request.epoch
    const { startMs, endMs } = request.interval
    if (startMs >= endMs) return yield* fail('Coverage interval must have positive duration')
    if (
      (yield* canonicalHashV1Result(epoch)) !== request.epoch.contentHash ||
      (yield* nativeArrivalCaptureId(epoch.build, epoch.bootstrap, epoch.sources)) !== epoch.captureId
    )
      return yield* fail('Native epoch identity differs')
    if (request.symbols.some((symbol) => !epoch.sources.some((source) => source.symbols.includes(symbol))))
      return yield* fail('Requested symbol is outside the original source inventory')

    let previous: typeof Header.Type | undefined
    for (const row of request.headers) {
      const { header } = row
      if (
        (yield* canonicalHashV1Result(header)) !== row.contentHash ||
        header.captureId !== epoch.captureId ||
        header.ordinal !== (previous?.header.ordinal ?? -1) + 1 ||
        header.previousHash !== (previous?.contentHash ?? null) ||
        header.firstConsumerSequence !== (previous?.header.lastConsumerSequence ?? 0) + 1 ||
        header.lastConsumerSequence < header.firstConsumerSequence ||
        header.firstAvailableAtMs < (previous?.header.lastAvailableAtMs ?? 0) ||
        header.lastAvailableAtMs < header.firstAvailableAtMs
      )
        return yield* fail('Native header chain has an identity, sequence or time gap')
      previous = row
    }
    const finalHeader = previous
    if (finalHeader === undefined) return yield* fail('Native header chain is empty')
    const end = request.end
    if (
      end !== null &&
      (end.captureId !== epoch.captureId ||
        end.lastChunkHash !== finalHeader.contentHash ||
        end.durableConsumerSequence !== finalHeader.header.lastConsumerSequence ||
        end.observedConsumerSequence < end.durableConsumerSequence ||
        (end.status === 'STOPPED' &&
          (end.observedConsumerSequence !== end.durableConsumerSequence || end.reason !== null)))
    )
      return yield* fail('Native end receipt does not bind the retained chain')
    const firstChunk = request.chunks[0]
    const lastChunk = request.chunks.at(-1)
    if (
      firstChunk === undefined ||
      lastChunk === undefined ||
      firstChunk.header.firstAvailableAtMs > startMs ||
      lastChunk.header.lastAvailableAtMs < endMs
    )
      return yield* fail('Selected original deliveries do not bracket the requested interval')
    if (request.chunks.reduce((total, chunk) => total + chunk.header.uncompressedBytes, 0) > maximumDecodedBytes)
      return yield* fail('Selected chunk bytes exceed the bounded offline audit budget')

    const quotes: ObservedMarketValue<IntradayQuote>[] = []
    let verifiedRecords = 0
    let ignoredRecords = 0
    for (const [index, row] of request.chunks.entries()) {
      const retained = request.headers[row.header.ordinal]
      if (row.header.ordinal !== firstChunk.header.ordinal + index || retained?.contentHash !== row.contentHash)
        return yield* fail('Selected chunks are not a contiguous part of the verified header chain')
      const records = yield* decodeNativeArrivalChunk({
        header: row.header,
        contentHash: row.contentHash,
        compressed: Buffer.from(row.compressedBase64, 'base64'),
      })
      for (const record of records) {
        if (record.receipt.consumerEpoch !== epoch.bootstrap.epoch)
          return yield* fail('Original arrival belongs to another consumer epoch')
        if (
          record.receipt.tombstone ||
          record.receipt.reason === 'assignment-invalidated' ||
          record.receipt.disposition === CaptureDisposition.Rejected
        )
          return yield* fail('Selected original deliveries contain a termination or rejected-input gap')
        verifiedRecords++
        const source = marketSourceForTopic(epoch.sources, record.record.topic)
        if (source === undefined) return yield* fail('Original arrival topic is outside the captured source inventory')
        if (record.receipt.disposition === CaptureDisposition.Ignored) {
          ignoredRecords++
          continue
        }
        if (record.record.topic !== source.topics.quotes) continue
        const timestampMs = restoreKafkaTransportTimestamp(record.originalTransport)
        const decoded = yield* decodeRawMarketRecord(
          { ...record.record, ...(timestampMs === undefined ? {} : { timestampMs }) },
          source,
        )
        if (decoded.kind === RawMarketEventKind.Ignored)
          return yield* fail('Accepted original arrival no longer reproduces its decoder disposition')
        if (decoded.kind !== RawMarketEventKind.Quote || !request.symbols.includes(decoded.value.symbol)) continue
        const recordHash = record.receipt.rawValueSha256
        if (recordHash === null) return yield* fail('Original quote has no raw value identity')
        quotes.push({
          value: decoded.value,
          availableAtMs: record.availableAtMs,
          sequence: record.receipt.projectionSequence,
          recordHash,
        })
      }
    }
    const symbols = request.symbols.map((symbol) => {
      const values = quotes.filter((quote) => quote.value.symbol === symbol)
      const inWindow = values.filter((quote) => quote.availableAtMs >= startMs && quote.availableAtMs <= endMs)
      const initial = values.findLast((quote) => quote.availableAtMs <= startMs)
      let previousAt = startMs
      let maximumGapMs = 0
      for (const quote of inWindow) {
        maximumGapMs = Math.max(maximumGapMs, quote.availableAtMs - previousAt)
        previousAt = quote.availableAtMs
      }
      return {
        symbol,
        observedQuoteCount: inWindow.length,
        initialQuoteAvailableAtMs: initial?.availableAtMs ?? null,
        firstQuoteAvailableAtMs: inWindow[0]?.availableAtMs ?? null,
        lastQuoteAvailableAtMs: inWindow.at(-1)?.availableAtMs ?? null,
        maximumQuoteArrivalGapIncludingBoundariesMs: Math.max(maximumGapMs, endMs - previousAt),
      }
    })
    return {
      report: {
        diagnosticOnly: true as const,
        qualification: 'UNQUALIFIED' as const,
        captureId: epoch.captureId,
        consumerEpoch: epoch.bootstrap.epoch,
        sourceRevision: epoch.build.sourceRevision,
        interval: request.interval,
        verifiedHeaderCount: request.headers.length,
        finalHeaderHash: finalHeader.contentHash,
        decodedChunkRange: { first: firstChunk.header.ordinal, last: lastChunk.header.ordinal },
        decodedChunkCount: request.chunks.length,
        verifiedRecords,
        ignoredRecords,
        completePrefixBytesVerified:
          firstChunk.header.ordinal === 0 && lastChunk.header.ordinal === finalHeader.header.ordinal,
        endReceipt: end,
        controllerCoverage: 'UNKNOWN' as const,
        decisionCommitAcknowledgement: 'UNKNOWN' as const,
        symbols,
      },
      // Leading/trailing context is retained, not relabeled as inside the requested interval.
      quotes,
    }
  }).pipe(
    Result.mapError(
      (cause) => new NativeArrivalCoverageError({ message: 'Native arrival coverage audit failed', cause }),
    ),
  )

if (import.meta.main) {
  const path = Bun.argv[2]
  if (path === undefined || Bun.argv.length !== 3)
    throw new Error('Usage: bun tools/native-arrival-coverage.ts <private-json>')
  if (statSync(path).size > nativeCoverageMaximumInputBytes) throw new Error('Native coverage input exceeds 32 MiB')
  const input: unknown = JSON.parse(readFileSync(path, 'utf8'))
  process.stdout.write(JSON.stringify(Result.getOrThrow(auditNativeArrivalCoverage(input))) + '\n')
}
