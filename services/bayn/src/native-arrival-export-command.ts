import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Config, Effect, Layer, Logger, Result, Schema, Stdio, Stream } from 'effect'

import { PostgresClientLive } from './db/postgres-client'
import { readNativeArrivalEpoch, streamNativeArrivalChunkPage } from './db/native-arrival-postgres'
import { exportNativeArrivalPrefix } from './intraday-replay/native-arrival-export'
import { ReplaySourceFailure } from './intraday-replay/source'
import type {
  NativeArrivalCaptureError,
  NativeArrivalChunk,
  NativeArrivalEpoch,
} from './market-data/streaming/native-arrival'
import { NonNegativeIntegerSchema, Sha256Schema } from './schemas'

export const nativeArrivalExportUsage =
  'Usage: bayn-native-arrival-export --capture-id <sha256> --through-ordinal <integer> --output <new-private-directory> | --help'

type ExportCommand =
  | { readonly _tag: 'Help' }
  | {
      readonly _tag: 'Export'
      readonly captureId: string
      readonly throughOrdinal: number
      readonly outputPath: string
    }

export const parseNativeArrivalExportArgs = (
  args: readonly string[],
): Result.Result<ExportCommand, ReplaySourceFailure> => {
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ _tag: 'Help' } as const)
  const captureId = args[1]
  const ordinal = args[3]
  const outputPath = args[5]
  if (
    args.length !== 6 ||
    args[0] !== '--capture-id' ||
    args[2] !== '--through-ordinal' ||
    args[4] !== '--output' ||
    !Schema.is(Sha256Schema)(captureId) ||
    ordinal === undefined ||
    !/^(0|[1-9][0-9]*)$/.test(ordinal) ||
    !Schema.is(NonNegativeIntegerSchema)(Number(ordinal)) ||
    outputPath === undefined ||
    outputPath.trim() === '' ||
    outputPath.startsWith('--')
  )
    return Result.fail(new ReplaySourceFailure({ message: nativeArrivalExportUsage }))
  return Result.succeed({ _tag: 'Export', captureId, throughOrdinal: Number(ordinal), outputPath } as const)
}

const prefixChunks = (
  sql: PgClient.PgClient,
  epoch: NativeArrivalEpoch,
  throughOrdinal: number,
  after = -1,
): Stream.Stream<NativeArrivalChunk, NativeArrivalCaptureError> =>
  Stream.suspend(() => {
    let lastOrdinal = after
    return streamNativeArrivalChunkPage(sql, epoch, after).pipe(
      Stream.take(throughOrdinal - after),
      Stream.tap((chunk) =>
        Effect.sync(() => {
          lastOrdinal = chunk.header.ordinal
        }),
      ),
      Stream.concat(
        Stream.suspend(() =>
          lastOrdinal === after || lastOrdinal >= throughOrdinal
            ? Stream.empty
            : prefixChunks(sql, epoch, throughOrdinal, lastOrdinal),
        ),
      ),
    )
  })

const print = (value: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(value + '\n'), stdio.stdout())
  })

export const runNativeArrivalExportCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const command = yield* Effect.fromResult(parseNativeArrivalExportArgs(args))
    if (command._tag === 'Help') return yield* print(nativeArrivalExportUsage)
    const postgres = yield* Config.all({
      url: Config.Redacted('BAYN_NATIVE_ARRIVAL_POSTGRES_URL'),
      tls: Config.Boolean('BAYN_POSTGRES_TLS').pipe(Config.withDefault(true)),
      caPath: Config.NonEmptyString('BAYN_NATIVE_ARRIVAL_POSTGRES_CA_PATH').pipe(
        Config.withDefault('/var/run/secrets/bayn/native-arrival-postgres/ca.crt'),
      ),
    })
    const result = yield* Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION READ ONLY`
          const epoch = yield* readNativeArrivalEpoch(sql, command.captureId)
          return yield* exportNativeArrivalPrefix({
            epoch,
            throughOrdinal: command.throughOrdinal,
            outputPath: command.outputPath,
            chunks: prefixChunks(sql, epoch, command.throughOrdinal),
          })
        }),
      )
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- command owns its read-only archive connection
      Effect.provide(
        PostgresClientLive(
          { postgres, operationTimeoutMs: 30_000 },
          {
            maxConnections: 1,
            applicationName: 'bayn-native-arrival-export',
          },
        ),
      ),
    )
    yield* print(JSON.stringify(result))
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runNativeArrivalExportCommand(process.argv.slice(2)).pipe(
      Effect.tapError(() =>
        Effect.logError('Native export failed; an export without source-receipt.json is incomplete'),
      ),
      // @effect-diagnostics-next-line strictEffectProvide:off -- command owns file and standard-output resources
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
