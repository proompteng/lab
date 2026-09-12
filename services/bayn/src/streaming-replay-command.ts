import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Config, Data, Effect, FileSystem, Layer, Logger, Schema, Stdio, Stream } from 'effect'
import { PostgresClientLive } from './db/postgres-client'
import { canonicalJsonV1Result } from './hash'
import { reproduceRecordedStreamingDecision } from './market-data/streaming/recorded-decision'
import { replayHistoricalStreamingStrategy } from './market-data/streaming/historical-strategy'
import { Sha256Schema } from './schemas'

class StreamingReplayCommandFailure extends Data.TaggedError('StreamingReplayCommandFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}
const usage =
  'Usage: bayn-streaming-replay --file <decision.json> | --decision <decision-content-hash> | --historical <experiment.json>'
export const parseStreamingReplayArgs = (args: readonly string[]) => {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return { _tag: 'Help' } as const
  if (args.length === 2 && args[0] === '--file' && args[1] !== undefined && args[1].length > 0)
    return { _tag: 'File', path: args[1] } as const
  if (args.length === 2 && args[0] === '--historical' && args[1] !== undefined && args[1].length > 0)
    return { _tag: 'Historical', path: args[1] } as const
  if (args.length === 2 && args[0] === '--decision' && args[1] !== undefined && /^[0-9a-f]{64}$/.test(args[1]))
    return { _tag: 'Decision', hash: args[1] } as const
  return { _tag: 'Invalid' } as const
}
const print = (value: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(`${value}\n`), stdio.stdout())
  })
const main = Effect.gen(function* () {
  const command = parseStreamingReplayArgs(process.argv.slice(2))
  if (command._tag === 'Help') return yield* print(usage)
  if (command._tag === 'Invalid') return yield* new StreamingReplayCommandFailure({ message: usage })
  let input: unknown
  if (command._tag === 'File' || command._tag === 'Historical') {
    const fs = yield* FileSystem.FileSystem
    const raw = yield* fs.readFileString(command.path)
    input = yield* Effect.try({
      try: (): unknown => JSON.parse(raw),
      catch: (cause) => new StreamingReplayCommandFailure({ message: 'Invalid replay JSON', cause }),
    })
  } else {
    const hash = yield* Schema.decodeUnknownEffect(Sha256Schema)(command.hash)
    const postgres = yield* Config.all({
      url: Config.redacted('BAYN_POSTGRES_URL'),
      tls: Config.boolean('BAYN_POSTGRES_TLS').pipe(Config.withDefault(true)),
      caPath: Config.string('BAYN_POSTGRES_CA_PATH').pipe(Config.withDefault('/var/run/secrets/bayn/postgres/ca.crt')),
    })
    input = yield* Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const rows = yield* sql<
        Record<string, unknown>
      >`SELECT document FROM autonomous_cycle_shadow_decisions WHERE decision_hash = ${hash}`
      if (rows.length !== 1)
        return yield* new StreamingReplayCommandFailure({ message: 'Expected exactly one recorded decision' })
      return rows[0]?.['document']
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- command owns a SELECT-only connection, never migrations or trading resources
      Effect.provide(PostgresClientLive({ postgres, operationTimeoutMs: 30_000 })),
    )
  }
  const receipt =
    command._tag === 'Historical'
      ? yield* Effect.fromResult(replayHistoricalStreamingStrategy(input))
      : yield* Effect.fromResult(reproduceRecordedStreamingDecision(input))
  yield* print(yield* Effect.fromResult(canonicalJsonV1Result(receipt)))
})
const program = main.pipe(
  Effect.tapCause(Effect.logError),
  // @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the platform runtime
  Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
)
if (import.meta.main) NodeRuntime.runMain(program, { disableErrorReporting: true })
