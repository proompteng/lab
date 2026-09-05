import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Data, Effect, FileSystem, Layer, Logger, Result, Schema, Stdio, Stream } from 'effect'
import { HttpClient } from 'effect/unstable/http'

import { makeProxyDispatcher } from './broker/alpaca/http'
import { canonicalJsonV1Result } from './hash'
import { makeAlpacaHistoricalClient } from './intraday-replay/vendor/alpaca/client'
import { VendorReplayFailure, VendorReplayInputSchema } from './intraday-replay/vendor/model'
import { runVendorIntradayReplay } from './intraday-replay/vendor/program'
import { strictParseOptions, TrimmedNonEmptyStringSchema } from './schemas'
import { currentUtcInstant } from './time'

export const VENDOR_INTRADAY_REPLAY_COMMAND_USAGE =
  'Usage: bayn-vendor-intraday-replay --input <path> --cache <directory> | --help'

export class VendorReplayCommandArgumentError extends Data.TaggedError('VendorReplayCommandArgumentError')<{
  readonly message: string
}> {}

export const parseVendorReplayCommandArgs = (
  args: readonly string[],
): Result.Result<
  { readonly _tag: 'Help' } | { readonly _tag: 'Run'; readonly inputPath: string; readonly cacheDirectory: string },
  VendorReplayCommandArgumentError
> => {
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ _tag: 'Help' })
  const inputPath = args[1]
  const cacheDirectory = args[3]
  if (
    args.length === 4 &&
    args[0] === '--input' &&
    args[2] === '--cache' &&
    inputPath !== undefined &&
    inputPath.trim().length > 0 &&
    !inputPath.startsWith('--') &&
    cacheDirectory !== undefined &&
    cacheDirectory.trim().length > 0 &&
    !cacheDirectory.startsWith('--')
  ) {
    return Result.succeed({ _tag: 'Run', inputPath, cacheDirectory })
  }
  return Result.fail(new VendorReplayCommandArgumentError({ message: VENDOR_INTRADAY_REPLAY_COMMAND_USAGE }))
}

const decodeInputJson = Schema.decodeUnknownResult(Schema.fromJsonString(VendorReplayInputSchema), strictParseOptions)
const vendorConfig = Config.all({
  key: Config.redacted('BAYN_ALPACA_KEY_ID'),
  secret: Config.redacted('BAYN_ALPACA_SECRET_KEY'),
  proxyUrl: Config.schema(TrimmedNonEmptyStringSchema, 'BAYN_ALPACA_PROXY_URL').pipe(
    Config.withDefault('http://bayn-egress-proxy:3128'),
  ),
})

const print = (output: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(`${output}\n`), stdio.stdout())
  })

const replayFile = (inputPath: string, cacheDirectory: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const input = yield* Effect.fromResult(decodeInputJson(yield* fs.readFileString(inputPath))).pipe(
        Effect.mapError(
          (cause) =>
            new VendorReplayFailure({ operation: 'input', message: 'invalid vendor replay input JSON', cause }),
        ),
      )
      const now = yield* currentUtcInstant
      const config = yield* vendorConfig
      const httpLayer = NodeHttpClient.layerUndiciNoDispatcher.pipe(
        Layer.provide(Layer.effect(NodeHttpClient.Dispatcher, makeProxyDispatcher(config.proxyUrl))),
      )
      const replay = Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const client = yield* makeAlpacaHistoricalClient(http, { key: config.key, secret: config.secret })
        return yield* runVendorIntradayReplay(input, client, cacheDirectory, now)
      })
      // @effect-diagnostics-next-line strictEffectProvide:off -- command owns the scoped vendor read transport
      const report = yield* replay.pipe(Effect.provide(httpLayer))
      const output = yield* Effect.fromResult(canonicalJsonV1Result(report)).pipe(
        Effect.mapError(
          (cause) => new VendorReplayFailure({ operation: 'report', message: 'vendor report encoding failed', cause }),
        ),
      )
      yield* print(output)
    }),
  )

const main = Effect.gen(function* () {
  const command = yield* Effect.fromResult(parseVendorReplayCommandArgs(process.argv.slice(2)))
  if (command._tag === 'Help') return yield* print(VENDOR_INTRADAY_REPLAY_COMMAND_USAGE)
  yield* replayFile(command.inputPath, command.cacheDirectory)
})

const program = main.pipe(
  // @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the platform runtime
  Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
)
if (import.meta.main) NodeRuntime.runMain(program)
