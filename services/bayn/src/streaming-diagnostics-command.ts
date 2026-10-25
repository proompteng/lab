import { jevMarketForFeed } from './jev/markets'
import { nativeFeatureMatchesBars, rollingWindowStartMs } from './market-data/features/native-feature'
import { observedBarsAt, type StreamingProjection } from './market-data/streaming/projection'
import { compressionsAlgorithms } from '@platformatic/kafka'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, FileSystem, Layer, Logger, Result, Schedule, Schema, Stdio, Stream } from 'effect'
import { SnapshotManifestFields } from './market-data/streaming/manifest-schema'
import { diagnoseStreamingInputs } from './market-data/streaming/inputs'
import { SymbolSchema, strictParseOptions } from './schemas'
import { verifyIntradaySnapshotQuery } from './market-data/intraday/verification'
import type { IntradaySnapshotQuery } from './market-data/intraday/model'
import { kafkaMarketConfig } from './config/source'
import { canonicalJsonV1Result } from './hash'

import { technicalFeatureMatchesBars } from './market-data/features/technical-contract'
import { technicalReceiptAvailableAt } from './market-data/streaming/technical-projection'
import { makeKafkaMarketProjection } from './market-data/streaming/kafka'
import { kafkaBootstrapDeadlineMs } from './market-data/streaming/bootstrap'

class StreamingDiagnosticsFailure extends Data.TaggedError('StreamingDiagnosticsFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const summarizeStreamingSymbol = (projection: StreamingProjection, symbol: string, observedAtMs: number) => {
  const allBars = (projection.bars.get(symbol) ?? []).filter((entry) => entry.availableAtMs <= observedAtMs)
  const features = (projection.features.get(symbol) ?? []).filter((entry) => entry.availableAtMs <= observedAtMs)
  const technicalFeatures = (projection.technicalFeatures.get(symbol) ?? []).filter(
    (entry) => entry.availableAtMs <= observedAtMs,
  )
  const matches = features.filter(({ value }) => {
    const bars = observedBarsAt(
      projection,
      symbol,
      BigInt(rollingWindowStartMs(value)) * 1_000_000n,
      BigInt(value.material.windowEndMs) * 1_000_000n,
      observedAtMs,
    ).map(({ value: bar }) => bar)
    const match = nativeFeatureMatchesBars(value, bars)
    return Result.isSuccess(match) && match.success
  })
  const technicalMatches = technicalFeatures.filter((candidate) => {
    if (!technicalReceiptAvailableAt(projection, candidate, observedAtMs)) return false
    const { value } = candidate
    const bars = observedBarsAt(
      projection,
      symbol,
      BigInt(value.material.windowEndMs - 30 * 60_000) * 1_000_000n,
      BigInt(value.material.windowEndMs) * 1_000_000n,
      observedAtMs,
    ).map((entry) => entry.value)
    if (bars.length !== 30) return false
    const match = technicalFeatureMatchesBars(value, bars)
    return Result.isSuccess(match) && match.success
  })
  return {
    symbol,
    ...(projection.technicalTopic === undefined
      ? {}
      : {
          technical: {
            topic: projection.technicalTopic,
            retainedFeatures: technicalFeatures.length,
            matchedFeatures: technicalMatches.map(({ value, availableAtMs, topic, partition, offset }) => ({
              featureId: value.featureId,
              windowEndMs: value.material.windowEndMs,
              computedAtMs: value.computedAtMs,
              availableAtMs,
              topic,
              partition,
              offset,
              matchedRawBars: 30,
              values: value.material.values,
            })),
          },
        }),
    retainedBars: allBars.length,
    retainedFeatures: features.length,
    latestQuoteAt:
      projection.quoteHistory.get(symbol)?.findLast((entry) => entry.availableAtMs <= observedAtMs)?.value.eventAt ??
      null,
    latestTradeAt:
      projection.tradeHistory.get(symbol)?.findLast((entry) => entry.availableAtMs <= observedAtMs)?.value.eventAt ??
      null,
    matchedFeatures: matches.map(({ value, availableAtMs }) => ({
      featureId: value.featureId,
      windowEndMs: value.material.windowEndMs,
      computedAtMs: value.computedAtMs,
      availableAtMs,
    })),
  }
}

const DiagnosticQuerySchema = Schema.Struct({
  sessionDate: SnapshotManifestFields.sessionDate,
  calendar: SnapshotManifestFields.calendar,
  rangeStartAt: SnapshotManifestFields.rangeStartAt,
  rangeEndAt: SnapshotManifestFields.rangeEndAt,
  observedAt: SnapshotManifestFields.observedAt,
  universeId: SnapshotManifestFields.universeId,
  universeSymbolHash: SnapshotManifestFields.universeSymbolHash,
  universe: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  symbols: Schema.optionalKey(SnapshotManifestFields.symbols),
  candidateSymbols: SnapshotManifestFields.candidateSymbols,
  candidateEvidencePolicy: SnapshotManifestFields.candidateEvidencePolicy,
  benchmarkEvidencePolicy: SnapshotManifestFields.benchmarkEvidencePolicy,
  benchmarkSymbols: SnapshotManifestFields.benchmarkSymbols,
  purpose: SnapshotManifestFields.purpose,
  feed: SnapshotManifestFields.feed,
  delayClass: SnapshotManifestFields.delayClass,
  sourceTopics: SnapshotManifestFields.sourceTopics,
  maximumQuoteAgeMs: SnapshotManifestFields.maximumQuoteAgeMs,
  minimumWatermarkLagMs: SnapshotManifestFields.minimumWatermarkLagMs,
})
export const decodeStreamingDiagnosticQuery = (raw: unknown) =>
  Schema.decodeUnknownResult(
    DiagnosticQuerySchema,
    strictParseOptions,
  )(raw).pipe(Result.flatMap(verifyIntradaySnapshotQuery))

export const streamingInputDiagnosticReceipt = (projection: StreamingProjection, query: IntradaySnapshotQuery) => {
  const diagnostics = diagnoseStreamingInputs(projection, query)
  return Result.isSuccess(diagnostics)
    ? { status: 'AVAILABLE' as const, ...diagnostics.success }
    : {
        status: 'UNAVAILABLE' as const,
        reason: diagnostics.failure.reason,
        message: diagnostics.failure.message,
        candidates: (query.candidateSymbols ?? []).map((symbol) => ({
          symbol,
          eligibility: { status: 'UNAVAILABLE' as const },
        })),
      }
}
const usage =
  'Usage: bayn-streaming-diagnostics --query <query.json> [--bootstrap-timeout-seconds <1..14400>] | --codecs | --help'
export const parseStreamingDiagnosticsArgs = (args: readonly string[]) => {
  if (args.length === 1 && args[0] === '--codecs') return { kind: 'codecs' } as const
  if (args.length === 1 && args[0] === '--help') return { kind: 'help' } as const
  const timeoutSeconds = args.length === 4 ? Number(args[3]) : kafkaBootstrapDeadlineMs / 1000
  if (
    (args.length === 2 ||
      (args.length === 4 && args[2] === '--bootstrap-timeout-seconds' && /^[1-9]\d*$/.test(args[3] ?? ''))) &&
    args[0] === '--query' &&
    args[1] !== undefined &&
    args[1].trim().length > 0 &&
    Number.isSafeInteger(timeoutSeconds) &&
    timeoutSeconds >= 1 &&
    timeoutSeconds <= 14_400
  )
    return { kind: 'probe', queryPath: args[1], bootstrapTimeoutMs: timeoutSeconds * 1000 } as const
  return { kind: 'invalid' } as const
}
const print = (value: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(`${value}\n`), stdio.stdout())
  })
const main = (args: ReturnType<typeof parseStreamingDiagnosticsArgs>) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (args.kind === 'help') return yield* print(usage)
      if (args.kind === 'codecs') {
        yield* Effect.try({
          try: () => {
            const payload = Buffer.from('Bayn Kafka codec verification '.repeat(32))
            for (const algorithm of ['gzip', 'snappy', 'lz4', 'zstd'] as const) {
              const codec = compressionsAlgorithms[algorithm]
              if (!codec.available || !codec.decompressSync(codec.compressSync(payload)).equals(payload))
                throw new StreamingDiagnosticsFailure({ message: `Kafka codec verification failed: ${algorithm}` })
            }
          },
          catch: (cause) => new StreamingDiagnosticsFailure({ message: 'Kafka codec verification failed', cause }),
        })
        return yield* print('Kafka codecs verified: gzip,snappy,lz4,zstd')
      }
      if (args.kind === 'invalid') return yield* new StreamingDiagnosticsFailure({ message: usage })
      const fs = yield* FileSystem.FileSystem
      const text = yield* fs.readFileString(args.queryPath)
      const raw = yield* Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: (cause) => new StreamingDiagnosticsFailure({ message: 'Invalid diagnostic query JSON', cause }),
      })
      const query = yield* Effect.fromResult(decodeStreamingDiagnosticQuery(raw))
      const config = yield* kafkaMarketConfig
      if (config === undefined)
        return yield* new StreamingDiagnosticsFailure({
          message: 'Diagnostics require the configured Bayn Kafka identity',
        })
      const market = yield* makeKafkaMarketProjection(
        { ...config, bootstrapTimeoutMs: args.bootstrapTimeoutMs },
        [
          {
            universeId: query.universeId,
            universeSymbolHash: query.universeSymbolHash,
            symbols: query.universe,
            topics: {
              ...query.sourceTopics,
              features: jevMarketForFeed(query.feed).streamingInput.featureTopic,
              ...(query.feed === 'us' || config.technicalFeaturesTopic === undefined
                ? {}
                : { technicalFeatures: config.technicalFeaturesTopic }),
            },
          },
        ],
        undefined,
        Date.parse(query.rangeStartAt),
      )
      const cut = yield* market.read.pipe(
        Effect.retry({ schedule: Schedule.spaced('1 second'), times: args.bootstrapTimeoutMs / 1000 + 30 }),
      )
      const diagnostics = streamingInputDiagnosticReceipt(cut.projection, query)
      const symbols = query.universe.map((symbol) =>
        summarizeStreamingSymbol(cut.projection, symbol, Date.parse(query.observedAt)),
      )
      yield* print(
        yield* Effect.fromResult(
          canonicalJsonV1Result({
            schemaVersion: 'bayn.streaming-diagnostic-receipt.v2',
            evidenceMode: 'retained-input-join-at-requested-observation',
            query,
            diagnostics,
            bootstrapTimeoutMs: args.bootstrapTimeoutMs,
            bootstrap: cut.bootstrap,
            positions: cut.positions,
            sequence: cut.projection.sequence,
            rejections: Object.fromEntries(cut.projection.rejections),
            ...(cut.projection.technicalTopic === undefined
              ? {}
              : { technicalRejections: cut.projection.technicalRejections }),
            symbols,
          }),
        ),
      )
    }),
  ).pipe(Effect.timeout((args.kind === 'probe' ? args.bootstrapTimeoutMs : kafkaBootstrapDeadlineMs) + 60_000))
if (import.meta.main)
  NodeRuntime.runMain(
    main(parseStreamingDiagnosticsArgs(process.argv.slice(2))).pipe(
      Effect.tapCause(Effect.logError),
      // @effect-diagnostics-next-line strictEffectProvide:off -- read-only diagnostic entry point owns and closes its Kafka resources
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
