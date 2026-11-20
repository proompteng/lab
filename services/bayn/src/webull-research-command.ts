import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Config, Effect, FileSystem, Layer, Logger, Redacted, Schema, Stdio, Stream } from 'effect'

import { WebullResearchError, WebullResearchInputSchema, readWebullResearch } from './market-data/webull-research'
import { strictParseOptions } from './schemas'

const usage =
  'Usage: bayn-webull-research --input <json> --output <new-json> | --help. Read-only M1 research; unqualified for trading.'

export const runWebullResearchCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const print = (text: string) => Stream.run(Stream.make(`${text}\n`), stdio.stdout())
    if (args.length === 1 && args[0] === '--help') return yield* print(usage)
    const inputPath = args[1]
    const outputPath = args[3]
    if (
      args.length !== 4 ||
      args[0] !== '--input' ||
      args[2] !== '--output' ||
      inputPath === undefined ||
      outputPath === undefined
    )
      return yield* new WebullResearchError({ message: usage })
    const fs = yield* FileSystem.FileSystem
    if ((yield* fs.stat(inputPath)).size > 65_536n)
      return yield* new WebullResearchError({ message: 'Research input exceeds 64 KiB' })
    if (yield* fs.exists(outputPath))
      return yield* new WebullResearchError({ message: 'Research output already exists' })
    const input = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(WebullResearchInputSchema),
      strictParseOptions,
    )(yield* fs.readFileString(inputPath))
    const url = yield* Config.NonEmptyString('BAYN_CLICKHOUSE_URL')
    const username = yield* Config.NonEmptyString('BAYN_CLICKHOUSE_USERNAME')
    const password = yield* Config.Redacted('BAYN_CLICKHOUSE_PASSWORD')
    const report = yield* readWebullResearch(input).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- this read-only command owns and closes its ClickHouse client
      Effect.provide(
        ClickhouseClient.layer({
          url,
          username,
          password: Redacted.value(password),
          database: 'signal',
          application: 'bayn-webull-research',
          request_timeout: 30_000,
        }),
      ),
      Effect.scoped,
    )
    yield* fs.writeFileString(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    yield* print(
      JSON.stringify({
        outputPath,
        reportHash: report.reportHash,
        qualification: report.qualification,
        ...report.summary,
        issues: report.issues,
      }),
    )
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runWebullResearchCommand(process.argv.slice(2)).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI composition owns platform resources
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerNodeHttp,
          Logger.layer([Logger.withConsoleError(Logger.formatJson)]),
        ),
      ),
    ),
  )
