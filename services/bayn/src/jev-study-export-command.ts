import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Logger, Redacted, Result, Schema, Stdio, Stream } from 'effect'

import { PostgresClientLive } from './db/postgres-client'
import { researchReaderConfig } from './db/research-reader-config'
import { exportJevStudySession, JevStudyExportFailure } from './jev/study-export'
import { IsoDateSchema } from './schemas'

export const JEV_STUDY_EXPORT_USAGE =
  'Usage: bayn-jev-study-export --session YYYY-MM-DD --output <new-private-directory> | --help'

type JevStudyExportCommand =
  | { readonly _tag: 'Help' }
  | { readonly _tag: 'Export'; readonly sessionDate: string; readonly outputPath: string }

export const parseJevStudyExportArgs = (
  args: readonly string[],
): Result.Result<JevStudyExportCommand, JevStudyExportFailure> => {
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ _tag: 'Help' as const })
  const sessionDate = args[1]
  const outputPath = args[3]
  if (
    args.length === 4 &&
    args[0] === '--session' &&
    args[2] === '--output' &&
    sessionDate !== undefined &&
    Result.isSuccess(Schema.decodeUnknownResult(IsoDateSchema)(sessionDate)) &&
    outputPath !== undefined &&
    outputPath.trim() !== '' &&
    !outputPath.startsWith('--')
  )
    return Result.succeed({ _tag: 'Export' as const, sessionDate, outputPath })
  return Result.fail(new JevStudyExportFailure({ message: JEV_STUDY_EXPORT_USAGE }))
}

const print = (text: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(`${text}\n`), stdio.stdout())
  })

export const runJevStudyExportCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const command = yield* Effect.fromResult(parseJevStudyExportArgs(args))
    if (command._tag === 'Help') return yield* print(JEV_STUDY_EXPORT_USAGE)
    const config = yield* researchReaderConfig
    const report = yield* Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      return yield* exportJevStudySession(
        sql,
        Redacted.value(config.accountId),
        command.sessionDate,
        command.outputPath,
      )
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- read-only export owns its scoped database layer
      Effect.provide(PostgresClientLive({ operationTimeoutMs: 30_000, postgres: config })),
    )
    yield* print(JSON.stringify(report))
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runJevStudyExportCommand(process.argv.slice(2)).pipe(
      Effect.tapError((error) =>
        Effect.logError(
          error instanceof JevStudyExportFailure
            ? error.message
            : 'Jev study export failed; an export without receipt.json is incomplete',
        ),
      ),
      // @effect-diagnostics-next-line strictEffectProvide:off -- command owns files and standard output
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
