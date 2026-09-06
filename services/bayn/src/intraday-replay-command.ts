import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Config, Data, Effect, FileSystem, Redacted, Result, Schema, Stdio, Stream } from 'effect'

import { canonicalJsonV1Result } from './hash'
import { IntradayReplayFailure, IntradayReplayInputSchema } from './intraday-replay/model'
import { runIntradayReplay } from './intraday-replay/program'
import { makeIntradayMarketData } from './market-data/intraday/program'
import { strictParseOptions, TrimmedNonEmptyStringSchema } from './schemas'
import { currentUtcInstant } from './time'

export const INTRADAY_REPLAY_COMMAND_USAGE = 'Usage: bayn-intraday-replay --input <path> | --help'

export class IntradayReplayCommandArgumentError extends Data.TaggedError('IntradayReplayCommandArgumentError')<{
  readonly message: string
}> {}

export const parseIntradayReplayCommandArgs = (
  args: readonly string[],
): Result.Result<
  { readonly _tag: 'Help' } | { readonly _tag: 'Run'; readonly inputPath: string },
  IntradayReplayCommandArgumentError
> => {
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ _tag: 'Help' })
  const inputPath = args[1]
  if (
    args.length === 2 &&
    args[0] === '--input' &&
    inputPath !== undefined &&
    inputPath.trim().length > 0 &&
    !inputPath.startsWith('--')
  ) {
    return Result.succeed({ _tag: 'Run', inputPath })
  }
  return Result.fail(new IntradayReplayCommandArgumentError({ message: INTRADAY_REPLAY_COMMAND_USAGE }))
}

const decodeInputJson = Schema.decodeUnknownResult(Schema.fromJsonString(IntradayReplayInputSchema), strictParseOptions)
const archiveConfig = Config.all({
  url: Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_CLICKHOUSE_URL'),
  username: Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_CLICKHOUSE_USERNAME'),
  password: Config.redacted('BAYN_CLICKHOUSE_PASSWORD'),
})

const print = (output: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(`${output}\n`), stdio.stdout())
  })

const replayFile = (inputPath: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const raw = yield* fs.readFileString(inputPath)
      const input = yield* Effect.fromResult(decodeInputJson(raw)).pipe(
        Effect.mapError(
          (cause) => new IntradayReplayFailure({ operation: 'input', message: 'invalid replay input JSON', cause }),
        ),
      )
      const now = yield* currentUtcInstant
      const config = yield* archiveConfig
      const replay = Effect.gen(function* () {
        const marketData = yield* makeIntradayMarketData
        return yield* runIntradayReplay(input, marketData, now)
      })
      const report = yield* replay.pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- the command owns its scoped read-only archive client
        Effect.provide(
          ClickhouseClient.layer({
            url: config.url,
            username: config.username,
            password: Redacted.value(config.password),
            database: 'signal',
            application: 'bayn-intraday-replay',
            request_timeout: 30_000,
          }),
        ),
      )
      const output = yield* Effect.fromResult(canonicalJsonV1Result(report)).pipe(
        Effect.mapError(
          (cause) =>
            new IntradayReplayFailure({ operation: 'report', message: 'replay report encoding failed', cause }),
        ),
      )
      yield* print(output)
    }),
  )

const main = Effect.gen(function* () {
  const command = yield* Effect.fromResult(parseIntradayReplayCommandArgs(process.argv.slice(2)))
  if (command._tag === 'Help') return yield* print(INTRADAY_REPLAY_COMMAND_USAGE)
  return yield* replayFile(command.inputPath)
})

// @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the platform runtime
const program = main.pipe(Effect.provide(NodeServices.layer))
if (import.meta.main) NodeRuntime.runMain(program)
