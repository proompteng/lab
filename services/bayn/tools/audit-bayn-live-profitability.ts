import { X509Certificate } from 'node:crypto'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Config, ConfigProvider, Console, Data, Effect, FileSystem, Option, Redacted, Result, Schema } from 'effect'

import { BrokerEnvironment } from '../src/broker/identity'
import { IsoDateSchema, StrictNonEmptyStringSchema, strictParseOptions } from '../src/schemas'
import {
  analyzeProfitability,
  AuditInput,
  MarketEvidence,
  renderAuditJson,
  renderAuditMarkdown,
} from './live-profitability-audit-core'
import { readProfitability } from './live-profitability-audit-postgres'

const usage =
  'Usage: bun services/bayn/tools/audit-bayn-live-profitability.ts (--session YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD) [--format markdown|json] [--fixture path] [--market-evidence path]'
const flags = new Set(['--session', '--from', '--to', '--format', '--fixture', '--market-evidence'])
const dayMs = 86_400_000

class AuditUsageError extends Data.TaggedError('AuditUsageError')<{ readonly message: string }> {}
class AuditDatabaseError extends Data.TaggedError('AuditDatabaseError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

type AuditOptions =
  | { readonly kind: 'help' }
  | {
      readonly kind: 'audit'
      readonly format: 'json' | 'markdown'
      readonly dates: readonly string[]
      readonly fixture: string | undefined
      readonly marketEvidence: string | undefined
    }
export const parseAuditArguments = (args: readonly string[]): Result.Result<AuditOptions, AuditUsageError> => {
  const fail = (detail?: string) =>
    Result.fail(new AuditUsageError({ message: detail === undefined ? usage : `${detail} ${usage}` }))
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ kind: 'help' } as const)
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    const value = args[i + 1]
    if (
      key === undefined ||
      value === undefined ||
      !flags.has(key) ||
      value.trim() === '' ||
      value.startsWith('--') ||
      values.has(key)
    )
      return fail()
    values.set(key, value)
  }
  const session = values.get('--session')
  if (session !== undefined && (values.has('--from') || values.has('--to'))) return fail()
  const bounds = Schema.decodeUnknownResult(Schema.Tuple([IsoDateSchema, IsoDateSchema]))([
    session ?? values.get('--from'),
    session ?? values.get('--to'),
  ])
  const format = values.get('--format') ?? 'markdown'
  if (Result.isFailure(bounds) || (format !== 'markdown' && format !== 'json')) return fail()
  const [from, to] = bounds.success
  const count = (Date.parse(to) - Date.parse(from)) / dayMs + 1
  if (count < 1 || count > 31) return fail('Select an ascending range of at most 31 calendar dates.')
  return Result.succeed({
    kind: 'audit',
    format,
    dates: Array.from({ length: count }, (_, i) => new Date(Date.parse(from) + i * dayMs).toISOString().slice(0, 10)),
    fixture: values.get('--fixture'),
    marketEvidence: values.get('--market-evidence'),
  } as const)
}

const invalidPostgresTls = (cause: unknown) =>
  new AuditDatabaseError({
    cause: Redacted.make(cause),
    message:
      'Invalid PostgreSQL TLS configuration. Check BAYN_POSTGRES_TLS, the readable PEM CA file at BAYN_POSTGRES_CA_PATH, and BAYN_POSTGRES_TLS_SERVERNAME.',
  })

export const loadAuditPostgresTls = Effect.gen(function* () {
  const tls = yield* Config.Boolean('BAYN_POSTGRES_TLS').pipe(Config.withDefault(true))
  if (!tls) return false as const
  const caPath = yield* Config.schema(StrictNonEmptyStringSchema, 'BAYN_POSTGRES_CA_PATH').pipe(
    Config.withDefault('/var/run/secrets/bayn/postgres/ca.crt'),
  )
  const servername = yield* Config.option(Config.schema(StrictNonEmptyStringSchema, 'BAYN_POSTGRES_TLS_SERVERNAME'))
  const fs = yield* FileSystem.FileSystem
  const ca = yield* fs.readFileString(caPath)
  // Node's TLS context can accept an empty or malformed trust store without a configuration error.
  yield* Effect.try({ try: () => new X509Certificate(ca), catch: invalidPostgresTls })
  return { ca, rejectUnauthorized: true, ...(Option.isSome(servername) ? { servername: servername.value } : {}) }
}).pipe(Effect.mapError((cause) => (cause._tag === 'AuditDatabaseError' ? cause : invalidPostgresTls(cause))))

const auditPostgres = PgClient.layerFrom(
  Effect.gen(function* () {
    const ssl = yield* loadAuditPostgresTls
    const url = yield* Config.Redacted('BAYN_POSTGRES_URL')
    return yield* PgClient.make({
      url,
      ssl,
      maxConnections: 1,
      applicationName: 'bayn-live-profitability-audit',
      connectTimeout: '5 seconds',
    })
  }),
)

const loadDatabase = (dates: readonly string[]) =>
  Effect.gen(function* () {
    const account = yield* Config.schema(StrictNonEmptyStringSchema, 'BAYN_AUDIT_ACCOUNT_ID')
    const sql = yield* PgClient.PgClient
    return yield* readProfitability(sql, account, dates, BrokerEnvironment.Live)
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- the CLI owns the short-lived read-only pool
    Effect.provide(auditPostgres),
    Effect.mapError((cause) =>
      cause._tag === 'AuditDatabaseError'
        ? cause
        : new AuditDatabaseError({
            cause: Redacted.make(cause),
            message:
              cause._tag === 'AuditScopeError'
                ? cause.message
                : `Read-only Postgres audit failed (${cause._tag}). Check BAYN_POSTGRES_URL, BAYN_AUDIT_ACCOUNT_ID, read grants, and migration revision; database details are redacted.`,
          }),
    ),
  )

export const runAudit = (args: readonly string[]) =>
  Effect.gen(function* () {
    const options = yield* Effect.fromResult(parseAuditArguments(args))
    if (options.kind === 'help') return yield* Console.log(usage)
    const fs = yield* FileSystem.FileSystem
    const input =
      options.fixture === undefined
        ? yield* loadDatabase(options.dates).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(AuditInput, strictParseOptions)),
          )
        : yield* fs
            .readFileString(options.fixture)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(AuditInput), strictParseOptions)))
    const market =
      options.marketEvidence === undefined
        ? null
        : yield* fs
            .readFileString(options.marketEvidence)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(MarketEvidence), strictParseOptions)))
    const selected = new Set(options.dates)
    const sessions = input.sessions.filter(({ date }) => selected.has(date))
    if (sessions.length === 0) return yield* new AuditUsageError({ message: 'No evidence for the requested dates.' })
    const report = analyzeProfitability({
      ...input,
      sessions: sessions.map((session) =>
        market === null
          ? session
          : {
              ...session,
              market: {
                bars: [...session.market.bars, ...market.bars],
                quotes: [...session.market.quotes, ...market.quotes],
              },
            },
      ),
    })
    yield* Console.log(options.format === 'json' ? renderAuditJson(report) : renderAuditMarkdown(report))
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    runAudit(process.argv.slice(2)).pipe(
      // A blank TLS setting is invalid, not an omitted setting.
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI composition
      Effect.provide(NodeServices.layer),
    ),
  )
}
