import { observedBarsAt, type StreamingProjection } from './market-data/streaming/projection'
import { compressionsAlgorithms } from '@platformatic/kafka'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Data, Effect, Layer, Logger, Result, Schedule, Stdio, Stream } from 'effect'
import { kafkaMarketConfig } from './config/source'
import { canonicalJsonV1Result } from './hash'
import { featureMatchesBars } from './market-data/features/contract'
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
  return {
    symbol,
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

const usage = 'Usage: bayn-streaming-diagnostics --since <UTC-instant> | --codecs | --help'
export const parseStreamingDiagnosticsArgs = (args: readonly string[]) => {
  if (args.length === 1 && args[0] === '--codecs') return { kind: 'codecs' } as const
  if (args.length === 1 && args[0] === '--help') return { kind: 'help' } as const
  if (
    args.length === 2 &&
    args[0] === '--since' &&
    args[1] !== undefined &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(args[1])
  ) {
    const sinceMs = Date.parse(args[1])
    if (
      Number.isSafeInteger(sinceMs) &&
      sinceMs > 0 &&
      new Date(sinceMs).toISOString().replace('.000Z', 'Z') === args[1].replace('.000Z', 'Z')
    )
      return { kind: 'probe', sinceMs } as const
  }
  return { kind: 'invalid' } as const
}
const print = (value: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(`${value}\n`), stdio.stdout())
  })
const main = Effect.scoped(
  Effect.gen(function* () {
    const args = parseStreamingDiagnosticsArgs(process.argv.slice(2))
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
      config,
      {
        universeId: protocol.universeId,
        universeSymbolHash: protocol.universeSymbolHash,
        symbols: protocol.universe,
        topics: { ...protocol.sourceTopics, features: intradayMomentumFeatureTopic },
      },
      undefined,
      args.sinceMs,
    )
    const cut = yield* market.read.pipe(
      Effect.retry({ schedule: Schedule.spaced('1 second'), times: kafkaBootstrapDeadlineMs / 1000 + 30 }),
    )
    const symbols = protocol.universe.map((symbol) => summarizeStreamingSymbol(cut.projection, symbol))
    yield* print(
      yield* Effect.fromResult(
        canonicalJsonV1Result({
          schemaVersion: 'bayn.streaming-diagnostic-receipt.v1',
          evidenceMode: 'retained-input-join-observed-now',
          sinceMs: args.sinceMs,
          bootstrap: cut.bootstrap,
          positions: cut.positions,
          sequence: cut.projection.sequence,
          rejections: Object.fromEntries(cut.projection.rejections),
          symbols,
        }),
      ),
    )
  }),
).pipe(Effect.timeout(kafkaBootstrapDeadlineMs + 60_000))
if (import.meta.main)
  NodeRuntime.runMain(
    main.pipe(
      Effect.tapCause(Effect.logError),
      // @effect-diagnostics-next-line strictEffectProvide:off -- read-only diagnostic entry point owns and closes its Kafka resources
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
