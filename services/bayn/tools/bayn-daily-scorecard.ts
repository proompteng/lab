import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Clock, Config, Console, Effect, FileSystem, Layer, Logger, Result, Schema } from 'effect'

import { BrokerEnvironment } from '../src/broker/identity'
import { StrictNonEmptyStringSchema, strictParseOptions } from '../src/schemas'
import { accountTradingDate, utcInstantFromEpochMillis } from '../src/time'
import { analyzeProfitability, AuditInput } from './live-profitability-audit-core'
import { readProfitability } from './live-profitability-audit-postgres'
import { AccountId } from './macro-canary-runner/alpaca'
import {
  buildScorecard,
  renderScorecardJson,
  renderScorecardMarkdown,
  scorecardError,
} from './multi-horizon-scorecard-core'

enum OutputFormat {
  Markdown = 'markdown',
  Json = 'json',
}

const format = Schema.Enum(OutputFormat)
const path = StrictNonEmptyStringSchema
const Options = Schema.Struct({
  'intraday-dir': Schema.optionalKey(path),
  postgres: Schema.optionalKey(Schema.Boolean),
  'macro-core-dir': path,
  'macro-canary-dir': path,
  'sip-dir': Schema.optionalKey(path),
  'qualification-file': Schema.optionalKey(path),
  format: Schema.optionalKey(format),
  output: Schema.optionalKey(path),
})

const usage = [
  'Usage: bun services/bayn/tools/bayn-daily-scorecard.ts',
  '  (--intraday-dir <dir> | --postgres) --macro-core-dir <dir> --macro-canary-dir <dir>',
  '  [--sip-dir <dir>] [--qualification-file <path>] [--format markdown|json] [--output <new-path>]',
  '  --postgres reads today’s New York PAPER audit from the TLS-verified standby and only fresh shadow receipts.',
].join('\n')

const parseOptions = (args: readonly string[]) =>
  Result.gen(function* () {
    const { values, tokens } = yield* Result.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: {
            'intraday-dir': { type: 'string' },
            postgres: { type: 'boolean' },
            'macro-core-dir': { type: 'string' },
            'macro-canary-dir': { type: 'string' },
            'sip-dir': { type: 'string' },
            'qualification-file': { type: 'string' },
            format: { type: 'string' },
            output: { type: 'string' },
          },
          tokens: true,
        }),
      catch: (cause) => scorecardError(usage, cause),
    })
    const names = tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []))
    if (new Set(names).size !== names.length)
      return yield* Result.fail(scorecardError(usage, { _tag: 'DuplicateFlag' }))
    const options = yield* Schema.decodeUnknownResult(
      Options,
      strictParseOptions,
    )(values).pipe(Result.mapError((cause) => scorecardError(usage, cause)))
    const directory = options['intraday-dir']
    if (options.postgres === true && directory === undefined && options['qualification-file'] === undefined)
      return { ...options, source: { kind: 'postgres' } as const }
    if (options.postgres === true || directory === undefined)
      return yield* Result.fail(scorecardError(usage, { _tag: 'InvalidIntradaySource' }))
    return { ...options, source: { kind: 'directory', directory } as const }
  })

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const fileOptions = { flag: 'wx', mode: 0o600, noFollow: true } as const

const readJson = (fs: FileSystem.FileSystem, filename: string, label: string) =>
  fs.readFileString(filename).pipe(
    Effect.flatMap(parseJson),
    Effect.mapError((cause) => scorecardError(`Cannot read or parse JSON: ${label}`, cause)),
  )

const readDirectory = Effect.fn('bayn.scorecard.readDirectory')(function* (
  fs: FileSystem.FileSystem,
  directory: string,
  label: string,
) {
  const names = yield* fs
    .readDirectory(directory)
    .pipe(Effect.mapError((cause) => scorecardError(`Cannot read receipt directory: ${label}`, cause)))
  const documents = yield* Effect.forEach(names.filter((name) => name.endsWith('.json')).sort(), (file, i) =>
    readJson(fs, join(directory, file), `${label} JSON file #${i + 1}`),
  )
  return documents.flatMap((document) => (Array.isArray(document) ? document : [document]))
})

const readLatest = (fs: FileSystem.FileSystem, directory: string) =>
  fs.readFileString(join(directory, 'latest.json')).pipe(
    Effect.catchIf(
      ({ reason }) => reason._tag === 'NotFound',
      () => Effect.succeed(null),
    ),
    Effect.flatMap((text) => (text === null ? Effect.succeed([]) : parseJson(text).pipe(Effect.map((row) => [row])))),
    Effect.mapError((cause) => scorecardError('Cannot read latest isolated shadow receipt', cause)),
  )

const readStandbyAudit = (fs: FileSystem.FileSystem, account: string, date: string) =>
  Effect.gen(function* () {
    const username = yield* Config.schema(StrictNonEmptyStringSchema, 'BAYN_SCORECARD_POSTGRES_USERNAME')
    const password = yield* Config.Redacted('BAYN_SCORECARD_POSTGRES_PASSWORD')
    const ca = yield* fs.readFileString('/var/run/secrets/bayn/postgres/ca.crt')
    const read = Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const [role] = yield* sql`SELECT pg_is_in_recovery() AS standby`
      if (role?.['standby'] !== true) return yield* scorecardError('Scorecard requires a PostgreSQL standby', null)
      const input = yield* readProfitability(sql, account, [date], BrokerEnvironment.Sandbox)
      return analyzeProfitability(yield* Schema.decodeUnknownEffect(AuditInput, strictParseOptions)(input))
    })
    return yield* read.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- this CLI owns its bounded, read-only database pool
      Effect.provide(
        PgClient.layer({
          host: 'bayn-db-ro.bayn.svc',
          database: 'bayn',
          username,
          password,
          ssl: { ca, rejectUnauthorized: true },
          connectTimeout: '5 seconds',
          maxConnections: 1,
          applicationName: 'bayn-daily-scorecard',
          startupParameters: { default_transaction_read_only: 'on', statement_timeout: '25s' },
        }),
      ),
    )
  }).pipe(
    Effect.mapError((cause) =>
      scorecardError('Read-only PAPER audit failed; check standby, CA and audit access', cause),
    ),
  )

const readEvidence = (fs: FileSystem.FileSystem, options: Result.Result.Success<ReturnType<typeof parseOptions>>) =>
  Effect.gen(function* () {
    const coreDir = options['macro-core-dir']
    const canaryDir = options['macro-canary-dir']
    if (options.source.kind === 'directory')
      return {
        intraday: yield* readDirectory(fs, options.source.directory, 'intraday audit'),
        macroCore: yield* readDirectory(fs, coreDir, 'macro ETF core'),
        macroCanary: yield* readDirectory(fs, canaryDir, 'macro canary'),
        daily: undefined,
      }
    const intradayAccountId = yield* Config.schema(AccountId, 'BAYN_AUDIT_ACCOUNT_ID').pipe(
      Effect.mapError((cause) => scorecardError('Invalid PAPER audit account binding', cause)),
    )
    const date = accountTradingDate(utcInstantFromEpochMillis(yield* Clock.currentTimeMillis))
    return {
      intraday: [yield* readStandbyAudit(fs, intradayAccountId, date)],
      macroCore: yield* readLatest(fs, coreDir),
      macroCanary: yield* readLatest(fs, canaryDir),
      daily: { intradayAccountId, date },
    }
  })

export const runScorecard = (args: readonly string[]) =>
  Effect.gen(function* () {
    if (args.length === 1 && args[0] === '--help') return yield* Console.log(usage)
    const options = yield* Effect.fromResult(parseOptions(args))
    const outputFormat =
      options.format ??
      (yield* Config.schema(format, 'BAYN_SCORECARD_FORMAT').pipe(
        Config.withDefault(OutputFormat.Markdown),
        Effect.mapError((cause) => scorecardError('Invalid BAYN_SCORECARD_FORMAT', cause)),
      ))
    const fs = yield* FileSystem.FileSystem
    const { daily, ...evidence } = yield* readEvidence(fs, options)
    const sip =
      options['sip-dir'] === undefined ? undefined : yield* readDirectory(fs, options['sip-dir'], 'SIP shadow')
    const qualification =
      options['qualification-file'] === undefined
        ? {}
        : { qualification: yield* readJson(fs, options['qualification-file'], 'qualification evidence') }
    const scorecard = yield* Effect.fromResult(
      buildScorecard(
        {
          ...evidence,
          ...qualification,
          ...(sip === undefined ? {} : { sip }),
        },
        daily,
      ),
    )
    const document =
      outputFormat === OutputFormat.Json
        ? yield* Effect.fromResult(renderScorecardJson(scorecard))
        : renderScorecardMarkdown(scorecard)
    const outputPath = options.output
    if (outputPath === undefined) return yield* Console.log(document)
    yield* Effect.scoped(
      Effect.gen(function* () {
        const output = yield* fs.open(outputPath, fileOptions)
        yield* output.writeAll(new TextEncoder().encode(`${document}\n`))
        yield* output.sync
      }),
    ).pipe(Effect.mapError((cause) => scorecardError('Cannot write new scorecard output', cause)))
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    runScorecard(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause))),
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI composition
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
}
