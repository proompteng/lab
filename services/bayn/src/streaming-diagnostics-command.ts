import { observedBarsAt, type StreamingProjection } from './market-data/streaming/projection'
import { compressionsAlgorithms } from '@platformatic/kafka'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, Layer, Logger, Result, Schedule, Stdio, Stream } from 'effect'
import { kafkaMarketConfig } from './config/source'
import { canonicalJsonV1Result } from './hash'
import { featureMatchesBars } from './market-data/features/contract'
import { technicalFeatureMatchesBars } from './market-data/features/technical-contract'
import { technicalReceiptAvailableAt } from './market-data/streaming/technical-projection'
import { makeKafkaMarketProjection } from './market-data/streaming/kafka'
import { kafkaBootstrapDeadlineMs } from './market-data/streaming/bootstrap'
import {
  defaultIntradayMomentumProtocolDocument,
  intradayMomentumFeatureTopic,
} from './strategy/intraday-momentum/protocol'

class StreamingDiagnosticsFailure extends Data.TaggedError('StreamingDiagnosticsFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const summarizeStreamingSymbol = (projection: StreamingProjection, symbol: string) => {
  const allBars = projection.bars.get(symbol) ?? []
  const features = projection.features.get(symbol) ?? []
  const matches = features.filter(({ value }) => {
    const bars = observedBarsAt(
      projection,
      symbol,
      BigInt(value.material.windowStartMs) * 1_000_000n,
      BigInt(value.material.windowEndMs) * 1_000_000n,
      Number.MAX_SAFE_INTEGER,
    ).map(({ value: bar }) => bar)
    const match = featureMatchesBars(value, bars)
    return Result.isSuccess(match) && match.success
  })
  const technicalMatches = (projection.technicalFeatures.get(symbol) ?? []).filter((candidate) => {
    if (!technicalReceiptAvailableAt(projection, candidate, Number.MAX_SAFE_INTEGER)) return false
    const { value } = candidate
    const bars = observedBarsAt(
      projection,
      symbol,
      BigInt(value.material.windowEndMs - 30 * 60_000) * 1_000_000n,
      BigInt(value.material.windowEndMs) * 1_000_000n,
      Number.MAX_SAFE_INTEGER,
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
            retainedFeatures: projection.technicalFeatures.get(symbol)?.length ?? 0,
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
    latestQuoteAt: projection.quotes.get(symbol)?.value.eventAt ?? null,
    latestTradeAt: projection.trades.get(symbol)?.value.eventAt ?? null,
    matchedFeatures: matches.map(({ value, availableAtMs }) => ({
      featureId: value.featureId,
      windowEndMs: value.material.windowEndMs,
      computedAtMs: value.computedAtMs,
      availableAtMs,
    })),
  }
}

const usage =
  'Usage: bayn-streaming-diagnostics --since <UTC-instant> [--bootstrap-timeout-seconds <1..3600>] | --codecs | --help'
export const parseStreamingDiagnosticsArgs = (args: readonly string[]) => {
  if (args.length === 1 && args[0] === '--codecs') return { kind: 'codecs' } as const
  if (args.length === 1 && args[0] === '--help') return { kind: 'help' } as const
  if (
    (args.length === 2 ||
      (args.length === 4 && args[2] === '--bootstrap-timeout-seconds' && /^[1-9]\d*$/.test(args[3] ?? ''))) &&
    args[0] === '--since' &&
    args[1] !== undefined &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(args[1])
  ) {
    const sinceMs = Date.parse(args[1])
    const timeoutSeconds = args.length === 4 ? Number(args[3]) : kafkaBootstrapDeadlineMs / 1000
    if (
      Number.isSafeInteger(timeoutSeconds) &&
      timeoutSeconds >= 1 &&
      timeoutSeconds <= 3600 &&
      Number.isSafeInteger(sinceMs) &&
      sinceMs > 0 &&
      new Date(sinceMs).toISOString().replace('.000Z', 'Z') === args[1].replace('.000Z', 'Z')
    )
      return { kind: 'probe', sinceMs, bootstrapTimeoutMs: timeoutSeconds * 1000 } as const
  }
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
      const config = yield* kafkaMarketConfig
      if (config === undefined)
        return yield* new StreamingDiagnosticsFailure({
          message: 'Diagnostics require the configured Bayn Kafka identity',
        })
      const protocol = defaultIntradayMomentumProtocolDocument
      const market = yield* makeKafkaMarketProjection(
        { ...config, bootstrapTimeoutMs: args.bootstrapTimeoutMs },
        {
          universeId: protocol.universeId,
          universeSymbolHash: protocol.universeSymbolHash,
          symbols: protocol.universe,
          topics: {
            ...protocol.sourceTopics,
            features: intradayMomentumFeatureTopic,
            ...(config.technicalFeaturesTopic === undefined
              ? {}
              : { technicalFeatures: config.technicalFeaturesTopic }),
          },
        },
        undefined,
        args.sinceMs,
      )
      const cut = yield* market.read.pipe(
        Effect.retry({ schedule: Schedule.spaced('1 second'), times: args.bootstrapTimeoutMs / 1000 + 30 }),
      )
      const symbols = protocol.universe.map((symbol) => summarizeStreamingSymbol(cut.projection, symbol))
      yield* print(
        yield* Effect.fromResult(
          canonicalJsonV1Result({
            schemaVersion: 'bayn.streaming-diagnostic-receipt.v1',
            evidenceMode: 'retained-input-join-observed-now',
            sinceMs: args.sinceMs,
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
