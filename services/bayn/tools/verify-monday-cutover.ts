import { parseArgs } from 'node:util'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Config, Data, Effect, FileSystem, Layer, Option, Redacted, Result, Schema, Stdio, Stream } from 'effect'
import { FetchHttpClient, Headers, HttpClient } from 'effect/http'

import { redactedHeaders } from '../src/broker/alpaca/model'
import { Sha256Schema, StrictNonEmptyStringSchema } from '../src/schemas'
import {
  accountCollision,
  AccountIdentitySchema,
  AlpacaEndpoint,
  CheckStatus,
  cutoverReport,
  evaluated,
  failed,
  FailureKind,
  Format,
  MacroAccountSchema,
  ObservationSchema,
  OntologyStatus,
  openOrderLimit,
  OpenOrdersSchema,
  Phase,
  PositionsSchema,
  postgresIdentityFailure,
  renderCutoverReport,
  skipped,
  verifyIntraday,
  verifyMacro,
  type AccountIdentity,
  type OntologyCheck,
  type ProbeProblem,
} from './monday-cutover-verifier'

const usage = `Usage: bun services/bayn/tools/verify-monday-cutover.ts --phase pre-open|post-flatten|post-cutover
  [--format json|markdown] [--output <new-report-path>] [--skip-macro-accounts]
  [--allow-live-endpoint] [--require-standby] [--expected-policy-hash <behavior-sha256>]

Alpaca: load BAYN_ALPACA_{KEY_ID,SECRET_KEY} for Account #1. Load the corresponding
BAYN_MACRO_CORE_ALPACA_* and BAYN_MACRO_CANARY_ALPACA_* credentials unless explicitly skipped.
Each prefix accepts BASE_URL (default: official Paper) and ACCOUNT_ID (optional identity pin).
Postgres: BAYN_POSTGRES_URL (read-only role), plus optional BAYN_POSTGRES_CA_PATH and
BAYN_POSTGRES_TLS_SERVERNAME. --require-standby also requires the URL.
Ontology: AUTO_ONTOLOGY_API_URL (optional, advisory only).
Policy: --expected-policy-hash is post-cutover only and compares against the running controller's
BAYN_STRATEGY_BEHAVIOR_HASH and canonical v3 BAYN_STRATEGY_PARAMETER_HASH.
Reports default to JSON on stdout. Verification grants no trading or capital authority.`

const options = {
  phase: { type: 'string' },
  format: { type: 'string' },
  output: { type: 'string' },
  'skip-macro-accounts': { type: 'boolean' },
  'allow-live-endpoint': { type: 'boolean' },
  'require-standby': { type: 'boolean' },
  'expected-policy-hash': { type: 'string' },
} as const
const OptionsSchema = Schema.Struct({
  phase: Schema.Enum(Phase),
  format: Schema.optionalKey(Schema.Enum(Format)),
  output: Schema.optionalKey(StrictNonEmptyStringSchema),
  'skip-macro-accounts': Schema.optionalKey(Schema.Boolean),
  'allow-live-endpoint': Schema.optionalKey(Schema.Boolean),
  'require-standby': Schema.optionalKey(Schema.Boolean),
  'expected-policy-hash': Schema.optionalKey(Sha256Schema),
})
type Options = typeof OptionsSchema.Type

class CutoverProbeError extends Data.TaggedError('CutoverProbeError')<ProbeProblem> {}
class CutoverNotReady extends Data.TaggedError('CutoverNotReady') {}

const problem = (kind: FailureKind, operation: string, message: string, cause?: unknown): ProbeProblem => ({
  kind,
  operation,
  message,
  ...(cause === undefined ? {} : { cause: Redacted.make(cause) }),
})
const probeError = (kind: FailureKind, operation: string, message: string, cause?: unknown) =>
  new CutoverProbeError(problem(kind, operation, message, cause))

const parseOptions = (args: readonly string[]) =>
  Effect.gen(function* () {
    const invalid = (cause?: unknown) => probeError(FailureKind.Configuration, 'arguments', usage, cause)
    const parsed = yield* Effect.try({
      try: () => parseArgs({ args: [...args], options, tokens: true }),
      catch: invalid,
    })
    const names = parsed.tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []))
    if (new Set(names).size !== names.length) return yield* invalid()
    const decoded = yield* Schema.decodeUnknownEffect(OptionsSchema)(parsed.values).pipe(Effect.mapError(invalid))
    if (decoded['expected-policy-hash'] !== undefined && decoded.phase !== Phase.PostCutover) {
      return yield* invalid()
    }
    return decoded
  })

const optionalRedacted = (name: string) => Config.option(Config.Redacted(name)).pipe(Config.map(Option.getOrUndefined))
const configurationError = (operation: string, message: string) => (cause: unknown) =>
  probeError(FailureKind.Configuration, operation, message, cause)
const decodeError = (operation: string) => (cause: unknown) =>
  probeError(FailureKind.Decode, operation, 'Response does not match the required evidence schema.', cause)

const parseUrl = (value: Redacted.Redacted, operation: string) =>
  Effect.try({
    try: () => new URL(Redacted.value(value)),
    catch: configurationError(operation, 'Invalid connection URL.'),
  })

const readUrl = (value: Redacted.Redacted, operation: string) =>
  Effect.gen(function* () {
    const url = yield* parseUrl(value, operation)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== '/'
    ) {
      return yield* probeError(FailureKind.Configuration, operation, 'Supply a bare HTTP(S) origin.')
    }
    return url
  })

interface AlpacaConnection {
  readonly url: URL
  readonly endpoint: AlpacaEndpoint
  readonly key: Redacted.Redacted
  readonly secret: Redacted.Redacted
  readonly expectedId: string | undefined
}

const paperOrigin = 'https://paper-api.alpaca.markets'
const liveOrigin = 'https://api.alpaca.markets'
const HeaderValue = Schema.String.check(Schema.isPattern(/^[!-~]+$/))

const loadAlpaca = (prefix: string, allowLive: boolean) =>
  Effect.gen(function* () {
    const config = yield* Config.all({
      key: Config.Redacted(`${prefix}_KEY_ID`),
      secret: Config.Redacted(`${prefix}_SECRET_KEY`),
      url: optionalRedacted(`${prefix}_BASE_URL`),
      expectedId: Config.option(Config.schema(AccountIdentitySchema.fields.id, `${prefix}_ACCOUNT_ID`)).pipe(
        Config.map(Option.getOrUndefined),
      ),
    }).pipe(
      Effect.mapError(configurationError(prefix, `Check ${prefix}_KEY_ID, _SECRET_KEY and optional _ACCOUNT_ID.`)),
    )
    if (!Schema.is(HeaderValue)(Redacted.value(config.key)) || !Schema.is(HeaderValue)(Redacted.value(config.secret))) {
      return yield* probeError(FailureKind.Configuration, prefix, 'Alpaca credentials must be non-empty header values.')
    }
    const url = yield* readUrl(config.url ?? Redacted.make(paperOrigin), prefix)
    if (url.origin !== paperOrigin && !(allowLive && url.origin === liveOrigin)) {
      return yield* probeError(
        FailureKind.Configuration,
        prefix,
        'Use the official Alpaca Paper HTTPS origin; the official live origin requires --allow-live-endpoint.',
      )
    }
    return {
      ...config,
      url,
      endpoint: url.origin === paperOrigin ? AlpacaEndpoint.Paper : AlpacaEndpoint.Live,
    } satisfies AlpacaConnection
  })

const getJson = <A>(
  schema: Schema.Decoder<A>,
  url: URL,
  operation: string,
  timeout: '3 seconds' | '5 seconds',
  credentials?: AlpacaConnection,
) =>
  Effect.gen(function* () {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient)
    const response = yield* client
      .get(url, {
        headers: {
          accept: 'application/json',
          ...(credentials === undefined
            ? {}
            : {
                'apca-api-key-id': Redacted.value(credentials.key),
                'apca-api-secret-key': Redacted.value(credentials.secret),
              }),
        },
      })
      .pipe(Effect.mapError((cause) => probeError(FailureKind.Transport, operation, 'GET request failed.', cause)))
    if (response.status !== 200) {
      return yield* new CutoverProbeError({
        ...problem(FailureKind.HttpStatus, operation, 'GET returned an unexpected HTTP status.'),
        httpStatus: response.status,
      })
    }
    const json = yield* response.json.pipe(Effect.mapError(decodeError(operation)))
    return yield* Schema.decodeUnknownEffect(schema, { reportInput: false })(json).pipe(
      Effect.mapError(decodeError(operation)),
    )
  }).pipe(
    Effect.scoped,
    Effect.timeout(timeout),
    Effect.catchTag('TimeoutError', (cause) =>
      Effect.fail(probeError(FailureKind.Timeout, operation, `GET exceeded ${timeout}.`, cause)),
    ),
  )

const getAlpaca = <A>(schema: Schema.Decoder<A>, connection: AlpacaConnection, path: string, label: string) =>
  getJson(schema, new URL(path, connection.url), `${label} ${path.split('?')[0]}`, '5 seconds', connection)

const readAccount = <A extends AccountIdentity>(prefix: string, options: Options, schema: Schema.Decoder<A>) =>
  Effect.gen(function* () {
    const connection = yield* loadAlpaca(prefix, options['allow-live-endpoint'] === true)
    const account = yield* getAlpaca(schema, connection, '/v2/account', prefix)
    return { account, connection, expectedId: connection.expectedId }
  })

const readPolicy = (expectedBehaviorHash: string) =>
  Config.all({
    behaviorHash: Config.option(Config.schema(Sha256Schema, 'BAYN_STRATEGY_BEHAVIOR_HASH')),
    parameterHash: Config.option(Config.schema(Sha256Schema, 'BAYN_STRATEGY_PARAMETER_HASH')),
  }).pipe(
    Effect.map(({ behaviorHash, parameterHash }) => ({
      expectedBehaviorHash,
      observed:
        Option.isSome(behaviorHash) && Option.isSome(parameterHash)
          ? { behaviorHash: behaviorHash.value, parameterHash: parameterHash.value }
          : null,
    })),
    Effect.mapError(configurationError('Account #1 policy', 'Deployed strategy hashes must be lowercase SHA-256.')),
  )

const readBrokerChecks = (options: Options) =>
  Effect.gen(function* () {
    const { intraday, core, canary } = yield* Effect.all(
      {
        intraday: Effect.result(readAccount('BAYN_ALPACA', options, AccountIdentitySchema)),
        core:
          options['skip-macro-accounts'] === true
            ? Effect.succeed(null)
            : Effect.result(readAccount('BAYN_MACRO_CORE_ALPACA', options, MacroAccountSchema)),
        canary:
          options['skip-macro-accounts'] === true
            ? Effect.succeed(null)
            : Effect.result(readAccount('BAYN_MACRO_CANARY_ALPACA', options, MacroAccountSchema)),
      },
      { concurrency: 'unbounded' },
    )
    const inspectIntraday = Effect.gen(function* () {
      const binding = yield* Effect.fromResult(intraday)
      // Read flat orders before positions so an order filling between reads cannot hide both the order and its fill.
      const orders = yield* getAlpaca(
        OpenOrdersSchema,
        binding.connection,
        `/v2/orders?status=open&nested=false&limit=${openOrderLimit}`,
        'Account #1',
      )
      const positions = yield* getAlpaca(PositionsSchema, binding.connection, '/v2/positions', 'Account #1')
      const policy =
        options['expected-policy-hash'] === undefined ? null : yield* readPolicy(options['expected-policy-hash'])
      return verifyIntraday(options.phase, binding, positions, orders, policy)
    }).pipe(Effect.catch((error) => Effect.succeed(failed([error]))))

    const inspectMacros = Effect.gen(function* () {
      if (core === null || canary === null) return skipped('--skip-macro-accounts was supplied.')
      const collision = accountCollision(
        Result.isSuccess(intraday) ? intraday.success.account : undefined,
        Result.isSuccess(core) ? core.success.account : undefined,
        Result.isSuccess(canary) ? canary.success.account : undefined,
      )
      if (collision !== null) {
        return failed([problem(FailureKind.Configuration, 'Macro account isolation', collision)])
      }
      if (Result.isFailure(intraday) || Result.isFailure(core) || Result.isFailure(canary)) {
        return failed(
          [intraday, core, canary].flatMap((identity) => (Result.isFailure(identity) ? [identity.failure] : [])),
        )
      }
      const [corePositions, canaryPositions] = yield* Effect.all(
        [
          getAlpaca(PositionsSchema, core.success.connection, '/v2/positions', 'Account #2'),
          getAlpaca(PositionsSchema, canary.success.connection, '/v2/positions', 'Account #3'),
        ],
        { concurrency: 'unbounded' },
      )
      return verifyMacro(
        { ...core.success, positions: corePositions, endpoint: core.success.connection.endpoint },
        { ...canary.success, positions: canaryPositions, endpoint: canary.success.connection.endpoint },
      )
    }).pipe(Effect.catch((error) => Effect.succeed(failed([error]))))

    return yield* Effect.all({ intraday: inspectIntraday, macroAccounts: inspectMacros }, { concurrency: 'unbounded' })
  })

const PostgresIdentityRows = Schema.Tuple([
  Schema.Struct({ role: StrictNonEmptyStringSchema, standby: Schema.Boolean }),
])
const LatestObservationRows = Schema.Array(ObservationSchema).check(Schema.isMaxLength(1))

const auditPostgres = (requireStandby: boolean) =>
  Effect.gen(function* () {
    const url = yield* optionalRedacted('BAYN_POSTGRES_URL').pipe(
      Effect.mapError(configurationError('PostgreSQL', 'Check BAYN_POSTGRES_URL.')),
    )
    if (url === undefined) {
      return requireStandby
        ? failed([problem(FailureKind.Configuration, 'PostgreSQL', '--require-standby needs BAYN_POSTGRES_URL.')])
        : skipped('BAYN_POSTGRES_URL is not configured.')
    }

    const config = yield* Config.all({
      caPath: optionalRedacted('BAYN_POSTGRES_CA_PATH'),
      serverName: Config.option(Config.schema(StrictNonEmptyStringSchema, 'BAYN_POSTGRES_TLS_SERVERNAME')).pipe(
        Config.map(Option.getOrUndefined),
      ),
    }).pipe(Effect.mapError(configurationError('PostgreSQL', 'Check the read-only URL and TLS configuration.')))

    const parsed = yield* parseUrl(url, 'PostgreSQL')
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return yield* probeError(FailureKind.Configuration, 'PostgreSQL', 'Use a postgres:// or postgresql:// URL.')
    }
    const login = yield* Effect.try({
      try: () => parsed.searchParams.getAll('user').at(-1) ?? decodeURIComponent(parsed.username),
      catch: configurationError('PostgreSQL', 'Invalid PostgreSQL login in the URL.'),
    })
    const forbidden = postgresIdentityFailure(login, false, false)
    if (forbidden !== null) return failed([problem(FailureKind.Configuration, 'PostgreSQL login', forbidden)])

    const fs = yield* FileSystem.FileSystem
    const ca =
      config.caPath === undefined
        ? undefined
        : yield* fs
            .readFileString(Redacted.value(config.caPath))
            .pipe(Effect.mapError(configurationError('PostgreSQL TLS', 'Cannot read BAYN_POSTGRES_CA_PATH.')))
    if (ca !== undefined && !ca.includes('-----BEGIN CERTIFICATE-----')) {
      return yield* probeError(
        FailureKind.Configuration,
        'PostgreSQL TLS',
        'The configured CA is not a PEM certificate.',
      )
    }

    const sqlLayer = PgClient.layerFrom(
      PgClient.makeClient({
        url,
        ssl: {
          ...(ca === undefined ? {} : { ca }),
          ...(config.serverName === undefined ? {} : { servername: config.serverName }),
          rejectUnauthorized: true,
        },
        startupOptions: '-c default_transaction_read_only=on -c statement_timeout=4000',
        connectTimeout: '5 seconds',
        applicationName: 'bayn-monday-cutover-verifier',
      }),
    )
    const audit = Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
          const [identity] = yield* Schema.decodeUnknownEffect(PostgresIdentityRows)(
            yield* sql`SELECT current_user AS role, pg_catalog.pg_is_in_recovery() AS standby`,
          ).pipe(Effect.mapError(decodeError('PostgreSQL identity')))
          const issue = postgresIdentityFailure(identity.role, identity.standby, requireStandby)
          if (issue !== null) return evaluated({ standby: identity.standby, latestObservation: null }, [issue])
          const [latest] = yield* Schema.decodeUnknownEffect(LatestObservationRows)(
            yield* sql`
              SELECT pg_catalog.to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp,
                status #>> '{last_pass,result}' AS result, status #>> '{last_pass,outcome}' AS outcome
              FROM public.execution_controller_observations
              ORDER BY observation_id DESC
              LIMIT 1
            `,
          ).pipe(Effect.mapError(decodeError('PostgreSQL execution observation')))
          return evaluated(
            { standby: identity.standby, latestObservation: latest ?? null },
            [],
            latest === undefined ? ['No retained execution observation is available.'] : [],
          )
        }),
      )
    })

    return yield* audit.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- the audit owns one scoped read-only session
      Effect.provide(sqlLayer),
      Effect.timeout('10 seconds'),
      Effect.mapError((cause) =>
        cause instanceof CutoverProbeError
          ? cause
          : probeError(FailureKind.Database, 'PostgreSQL audit', 'Read-only database audit failed.', cause),
      ),
    )
  }).pipe(Effect.catch((error) => Effect.succeed(failed([error]))))

enum AutoOntologyHealth {
  Ok = 'ok',
  Degraded = 'degraded',
}

const OntologyHealth = Schema.Struct({ status: Schema.Enum(AutoOntologyHealth) })
const probeOntology = Effect.gen(function* () {
  const url = yield* optionalRedacted('AUTO_ONTOLOGY_API_URL').pipe(
    Effect.mapError(configurationError('Auto Ontology', 'Check AUTO_ONTOLOGY_API_URL.')),
  )
  if (url === undefined) return skipped('AUTO_ONTOLOGY_API_URL is not configured.')
  const origin = yield* readUrl(url, 'Auto Ontology')
  const health = yield* getJson(
    OntologyHealth,
    new URL('/api/health', origin),
    'Auto Ontology /api/health',
    '3 seconds',
  )
  return { status: health.status === AutoOntologyHealth.Ok ? OntologyStatus.Healthy : OntologyStatus.Degraded }
}).pipe(
  Effect.catch(
    (error): Effect.Effect<OntologyCheck> =>
      Effect.succeed({
        status:
          error.kind === FailureKind.HttpStatus || error.kind === FailureKind.Decode
            ? OntologyStatus.Degraded
            : OntologyStatus.Unreachable,
        problem: error,
      }),
  ),
  Effect.catchDefect((cause) =>
    Effect.succeed({
      status: OntologyStatus.Unreachable,
      problem: problem(FailureKind.Transport, 'Auto Ontology', 'Unexpected health probe failure.', cause),
    }),
  ),
)

export const verifyMondayCutover = (options: Options) =>
  Effect.all(
    {
      broker: readBrokerChecks(options),
      postgres: auditPostgres(options['require-standby'] === true),
      autoOntology: probeOntology,
    },
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map(({ broker, postgres, autoOntology }) =>
      cutoverReport(options.phase, { ...broker, postgres, autoOntology }),
    ),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error', cache: 'no-store' }),
    Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders),
  )

export const runMondayCutover = (args: readonly string[]) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    if (args.length === 1 && args[0] === '--help') {
      return yield* Stream.run(Stream.make(`${usage}\n`), stdio.stdout())
    }
    const options = yield* parseOptions(args)
    const report = yield* verifyMondayCutover(options)
    const text = renderCutoverReport(report, options.format ?? Format.Json)
    if (options.output === undefined) yield* Stream.run(Stream.make(text), stdio.stdout())
    else {
      const fs = yield* FileSystem.FileSystem
      yield* fs
        .writeFileString(options.output, text, { flag: 'wx', mode: 0o600 })
        .pipe(
          Effect.mapError((cause) =>
            probeError(FailureKind.Output, 'report', 'Cannot create the requested report.', cause),
          ),
        )
    }
    if (report.verdict === CheckStatus.Fail) return yield* new CutoverNotReady()
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    runMondayCutover(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        const error = Cause.findErrorOption(cause)
        if (Option.isSome(error) && error.value instanceof CutoverNotReady) return Effect.void
        const diagnostic =
          Option.isSome(error) && error.value instanceof CutoverProbeError
            ? error.value
            : problem(FailureKind.Output, 'verifier', 'Verification could not complete.', cause)
        return Effect.flatMap(Stdio.Stdio, (stdio) =>
          Stream.run(Stream.make(`${diagnostic.operation}: ${diagnostic.message}\n`), stdio.stderr()),
        )
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI owns stdout, filesystem, and HTTP composition
      Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
    ),
    { disableErrorReporting: true },
  )
}
