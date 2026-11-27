import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Config, Console, Data, Effect, FileSystem, Redacted, Result, Schema } from 'effect'

import { IsoDateSchema, StrictNonEmptyStringSchema, strictParseOptions } from '../src/schemas'
import {
  analyzeProfitability,
  AuditInput,
  MarketEvidence,
  renderAuditJson,
  renderAuditMarkdown,
} from './live-profitability-audit-core'
import { readLiveProfitability } from './live-profitability-audit-postgres'

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

const loadDatabase = (dates: readonly string[]) =>
  Effect.gen(function* () {
    const account = yield* Config.schema(StrictNonEmptyStringSchema, 'BAYN_AUDIT_ACCOUNT_ID')
    const sql = yield* PgClient.PgClient
    return yield* readLiveProfitability(sql, account, dates)
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- the CLI owns the short-lived read-only pool
    Effect.provide(
      PgClient.layerConfig({
        url: Config.Redacted('BAYN_POSTGRES_URL'),
        maxConnections: Config.succeed(1),
        applicationName: Config.succeed('bayn-live-profitability-audit'),
        connectTimeout: Config.succeed('5 seconds'),
      }),
    ),
    Effect.mapError(
      (cause) =>
        new AuditDatabaseError({
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
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI composition
      Effect.provide(NodeServices.layer),
    ),
  )
}
