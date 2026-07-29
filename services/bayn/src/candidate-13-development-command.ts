import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { NodeRuntime } from '@effect/platform-node'
import { Config, Data, Effect, Redacted, Result, Schema } from 'effect'

import {
  officialMonthEndSignalDates,
  runCandidateDevelopment,
  type CandidateDevelopmentRunFailure,
} from './candidate-development'
import { candidate13DatasetHashes, evaluateCandidate13Development } from './residual-momentum/development'
import {
  CANDIDATE_13_DEVELOPMENT_END,
  CANDIDATE_13_DEVELOPMENT_START,
  CANDIDATE_13_ORDINAL,
  CANDIDATE_13_PREREGISTRATION_COMMIT,
  CANDIDATE_13_PREREGISTRATION_SHA256,
  CANDIDATE_13_PRIOR_TRIAL_COUNT,
  CANDIDATE_13_SNAPSHOT_ID,
  candidate13DevelopmentSessions,
  candidate13Protocol,
  candidate13Universe,
  type Candidate13Bar,
  type Candidate13Dataset,
  type Candidate13Failure,
  type Candidate13Registration,
} from './residual-momentum/model'
import { strictParseOptions } from './schemas'

const BarRowSchema = Schema.Struct({
  symbol: Schema.String,
  session_date: Schema.String,
  adjusted_open: Schema.String,
  adjusted_high: Schema.String,
  adjusted_low: Schema.String,
  adjusted_close: Schema.String,
  adjusted_volume: Schema.String,
})
const BarRowsSchema = Schema.Array(BarRowSchema)

interface Candidate13CommandConfig {
  readonly clickhouseUrl: string
  readonly clickhouseUsername: string
  readonly clickhousePassword: Redacted.Redacted<string>
  readonly evaluatedCommit: string
  readonly preregistrationBase64: string
}

const commandConfig = Config.all({
  clickhouseUrl: Config.string('BAYN_CLICKHOUSE_URL'),
  clickhouseUsername: Config.string('BAYN_CLICKHOUSE_USERNAME'),
  clickhousePassword: Config.redacted('BAYN_CLICKHOUSE_PASSWORD'),
  evaluatedCommit: Config.string('BAYN_CANDIDATE_13_EVALUATED_COMMIT'),
  preregistrationBase64: Config.string('BAYN_CANDIDATE_13_PREREGISTRATION_BASE64').pipe(Config.withDefault('')),
})

const ioFailure = (operation: string, cause: unknown): Candidate13Failure => ({
  _tag: 'Candidate13IoFailure',
  operation,
  cause,
})

const invalidInput = (operation: string, reason: string): Candidate13Failure => ({
  _tag: 'Candidate13InvalidInput',
  operation,
  reason,
})

const sha256 = (bytes: ArrayBufferView): string =>
  createHash('sha256')
    .update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    .digest('hex')

const preregistrationBytes = (encoded: string): Effect.Effect<Uint8Array, Candidate13Failure> =>
  encoded.length === 0
    ? Effect.tryPromise({
        try: () =>
          readFile(new URL('../candidates/ordinal-13-spy-residual-momentum-preregistration.md', import.meta.url)),
        catch: (cause) => ioFailure('read-preregistration', cause),
      })
    : Effect.try({
        try: () => Uint8Array.from(Buffer.from(encoded, 'base64')),
        catch: (cause) => ioFailure('decode-preregistration', cause),
      })

const preregisterCandidate = (
  evaluatedCommit: string,
  encodedPreregistration: string,
): Effect.Effect<Candidate13Registration, Candidate13Failure> =>
  preregistrationBytes(encodedPreregistration).pipe(
    Effect.flatMap((bytes) => {
      const preregistrationHash = sha256(bytes)
      if (preregistrationHash !== CANDIDATE_13_PREREGISTRATION_SHA256) {
        return Effect.fail(
          invalidInput(
            'preregister',
            `preregistration hash ${preregistrationHash} differs from ${CANDIDATE_13_PREREGISTRATION_SHA256}`,
          ),
        )
      }
      if (!/^[0-9a-f]{40}$/.test(evaluatedCommit)) {
        return Effect.fail(
          invalidInput('preregister', 'evaluated commit must be a lowercase 40-character Git object id'),
        )
      }
      return Effect.succeed({
        preregistrationHash: CANDIDATE_13_PREREGISTRATION_SHA256,
        preregistrationCommit: CANDIDATE_13_PREREGISTRATION_COMMIT,
        evaluatedCommit,
      })
    }),
  )

const acquireClickHouse = (config: Candidate13CommandConfig): Effect.Effect<ClickHouseClient, Candidate13Failure> =>
  Effect.try({
    try: () =>
      createClient({
        url: config.clickhouseUrl,
        username: config.clickhouseUsername,
        password: Redacted.value(config.clickhousePassword),
        application: 'bayn-candidate-13-development',
        clickhouse_settings: { readonly: '1' },
      }),
    catch: (cause) => ioFailure('create-clickhouse-client', cause),
  })

const parsedNumber = (field: string, value: string): Result.Result<number, Candidate13Failure> => {
  const number = Number(value)
  return Number.isFinite(number)
    ? Result.succeed(number)
    : Result.fail(invalidInput('decode-bars', `${field} is ${value}`))
}

const candidate13Bar = (row: typeof BarRowSchema.Type): Result.Result<Candidate13Bar, Candidate13Failure> => {
  if (!candidate13Universe.includes(row.symbol as Candidate13Bar['symbol'])) {
    return Result.fail(invalidInput('decode-bars', `unexpected symbol ${row.symbol}`))
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.session_date)) {
    return Result.fail(invalidInput('decode-bars', `invalid session date ${row.session_date}`))
  }
  return pipeNumbers(row)
}

const pipeNumbers = (row: typeof BarRowSchema.Type): Result.Result<Candidate13Bar, Candidate13Failure> =>
  Result.all({
    open: parsedNumber('adjusted_open', row.adjusted_open),
    high: parsedNumber('adjusted_high', row.adjusted_high),
    low: parsedNumber('adjusted_low', row.adjusted_low),
    close: parsedNumber('adjusted_close', row.adjusted_close),
    volume: parsedNumber('adjusted_volume', row.adjusted_volume),
  }).pipe(
    Result.map((values) => ({
      symbol: row.symbol as Candidate13Bar['symbol'],
      sessionDate: row.session_date as Candidate13Bar['sessionDate'],
      ...values,
    })),
  )

export const queryCandidate13DevelopmentBars = (
  client: ClickHouseClient,
): Effect.Effect<readonly Candidate13Bar[], Candidate13Failure> =>
  Effect.tryPromise({
    try: async () => {
      const result = await client.query({
        query: `
          SELECT
            symbol,
            toString(session_date) AS session_date,
            toDecimalString(adjusted_open, 8) AS adjusted_open,
            toDecimalString(adjusted_high, 8) AS adjusted_high,
            toDecimalString(adjusted_low, 8) AS adjusted_low,
            toDecimalString(adjusted_close, 8) AS adjusted_close,
            toDecimalString(adjusted_volume, 8) AS adjusted_volume
          FROM signal.adjusted_daily_bars_v2
          WHERE snapshot_id = {snapshotId:String}
            AND symbol IN {symbols:Array(String)}
            AND toString(session_date) >= {start:String}
            AND toString(session_date) <= {end:String}
          ORDER BY session_date, symbol
        `,
        query_params: {
          snapshotId: CANDIDATE_13_SNAPSHOT_ID,
          symbols: candidate13Universe,
          start: CANDIDATE_13_DEVELOPMENT_START,
          end: CANDIDATE_13_DEVELOPMENT_END,
        },
        format: 'JSONEachRow',
        query_id: 'bayn-candidate-13-development-bars-one-shot',
      })
      return result.json<unknown>()
    },
    catch: (cause) => ioFailure('query-development-bars', cause),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(BarRowsSchema, strictParseOptions)),
    Effect.mapError((cause) => ioFailure('decode-development-bars', cause)),
    Effect.flatMap((rows) => Effect.fromResult(Result.all(rows.map(candidate13Bar)))),
  )

const loadDevelopmentData = (config: Candidate13CommandConfig): Effect.Effect<Candidate13Dataset, Candidate13Failure> =>
  Effect.scoped(
    Effect.acquireRelease(acquireClickHouse(config), (client) =>
      Effect.tryPromise({
        try: () => client.close(),
        catch: (cause) => ioFailure('close-clickhouse-client', cause),
      }).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap(queryCandidate13DevelopmentBars),
      Effect.flatMap((bars) => {
        const sessions = candidate13DevelopmentSessions()
        return Effect.fromResult(
          candidate13DatasetHashes(sessions, bars).pipe(
            Result.map((hashes) => ({
              snapshotId: CANDIDATE_13_SNAPSHOT_ID,
              sessions,
              bars,
              ...hashes,
            })),
          ),
        )
      }),
    ),
  )

type Candidate13CommandFailure = Candidate13Failure | CandidateDevelopmentRunFailure

class Candidate13DevelopmentCommandError extends Data.TaggedError('Candidate13DevelopmentCommandError')<{
  readonly message: string
  readonly failure: Candidate13CommandFailure
}> {}

const renderFailure = (failure: Candidate13CommandFailure): string => {
  const tagged = failure as Candidate13CommandFailure & { readonly operation?: string; readonly reason?: string }
  return `${tagged._tag}${tagged.operation === undefined ? '' : `:${tagged.operation}`}${
    tagged.reason === undefined ? '' : `:${tagged.reason}`
  }`
}

const main = commandConfig.pipe(
  Effect.mapError((cause) => ioFailure('load-config', cause)),
  Effect.flatMap((config) => {
    const officialSessions = candidate13DevelopmentSessions()
    return runCandidateDevelopment(
      {
        candidateOrdinal: CANDIDATE_13_ORDINAL,
        priorTrialCount: CANDIDATE_13_PRIOR_TRIAL_COUNT,
        officialSessions,
        signalSessionDates: officialMonthEndSignalDates(officialSessions),
        featureLookbackSessions: candidate13Protocol.feature.declaredLookbackSessions,
      },
      {
        preregisterCandidate: () => preregisterCandidate(config.evaluatedCommit, config.preregistrationBase64),
        loadDevelopmentData: (registration) =>
          loadDevelopmentData(config).pipe(Effect.map((dataset) => ({ registration, dataset }))),
        evaluateDevelopment: ({ registration, dataset }, preflight) =>
          Effect.fromResult(evaluateCandidate13Development(registration, dataset, preflight)),
      },
    )
  }),
  Effect.tap((report) => Effect.sync(() => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))),
  Effect.tap((report) =>
    report.status === 'PASS'
      ? Effect.void
      : Effect.sync(() => {
          process.exitCode = 2
        }),
  ),
  Effect.mapError((failure) => new Candidate13DevelopmentCommandError({ message: renderFailure(failure), failure })),
)

if (import.meta.main)
  NodeRuntime.runMain(
    main.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.message}\n`)
          process.exitCode = 1
        }),
      ),
    ),
    { disableErrorReporting: true },
  )
