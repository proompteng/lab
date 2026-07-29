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
import {
  candidate14DatasetHashes,
  evaluateCandidate14Development,
} from './intraday-information-continuation/development'
import {
  CANDIDATE_14_DEVELOPMENT_END,
  CANDIDATE_14_DEVELOPMENT_START,
  CANDIDATE_14_ORDINAL,
  CANDIDATE_14_PREREGISTRATION_COMMIT,
  CANDIDATE_14_PREREGISTRATION_SHA256,
  CANDIDATE_14_PRIOR_TRIAL_COUNT,
  CANDIDATE_14_SNAPSHOT_ID,
  candidate14DevelopmentSessions,
  candidate14Protocol,
  candidate14Universe,
  type Candidate14Bar,
  type Candidate14Dataset,
  type Candidate14Failure,
  type Candidate14Registration,
} from './intraday-information-continuation/model'
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

interface Candidate14CommandConfig {
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
  evaluatedCommit: Config.string('BAYN_CANDIDATE_14_EVALUATED_COMMIT'),
  preregistrationBase64: Config.string('BAYN_CANDIDATE_14_PREREGISTRATION_BASE64').pipe(Config.withDefault('')),
})

const ioFailure = (operation: string, cause: unknown): Candidate14Failure => ({
  _tag: 'Candidate14IoFailure',
  operation,
  cause,
})

const invalidInput = (operation: string, reason: string): Candidate14Failure => ({
  _tag: 'Candidate14InvalidInput',
  operation,
  reason,
})

const sha256 = (bytes: ArrayBufferView): string =>
  createHash('sha256')
    .update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    .digest('hex')

const preregistrationBytes = (encoded: string): Effect.Effect<Uint8Array, Candidate14Failure> =>
  encoded.length === 0
    ? Effect.tryPromise({
        try: () =>
          readFile(
            new URL('../candidates/ordinal-14-intraday-information-continuation-preregistration.md', import.meta.url),
          ),
        catch: (cause) => ioFailure('read-preregistration', cause),
      })
    : Effect.try({
        try: () => Uint8Array.from(Buffer.from(encoded, 'base64')),
        catch: (cause) => ioFailure('decode-preregistration', cause),
      })

const preregisterCandidate = (
  evaluatedCommit: string,
  encodedPreregistration: string,
): Effect.Effect<Candidate14Registration, Candidate14Failure> =>
  preregistrationBytes(encodedPreregistration).pipe(
    Effect.flatMap((bytes) => {
      const preregistrationHash = sha256(bytes)
      if (preregistrationHash !== CANDIDATE_14_PREREGISTRATION_SHA256) {
        return Effect.fail(
          invalidInput(
            'preregister',
            `preregistration hash ${preregistrationHash} differs from ${CANDIDATE_14_PREREGISTRATION_SHA256}`,
          ),
        )
      }
      if (!/^[0-9a-f]{40}$/.test(evaluatedCommit)) {
        return Effect.fail(
          invalidInput('preregister', 'evaluated commit must be a lowercase 40-character Git object id'),
        )
      }
      return Effect.succeed({
        preregistrationHash: CANDIDATE_14_PREREGISTRATION_SHA256,
        preregistrationCommit: CANDIDATE_14_PREREGISTRATION_COMMIT,
        evaluatedCommit,
      })
    }),
  )

const acquireClickHouse = (config: Candidate14CommandConfig): Effect.Effect<ClickHouseClient, Candidate14Failure> =>
  Effect.try({
    try: () =>
      createClient({
        url: config.clickhouseUrl,
        username: config.clickhouseUsername,
        password: Redacted.value(config.clickhousePassword),
        application: 'bayn-candidate-14-development',
        clickhouse_settings: { readonly: '1' },
      }),
    catch: (cause) => ioFailure('create-clickhouse-client', cause),
  })

const parsedNumber = (field: string, value: string): Result.Result<number, Candidate14Failure> => {
  const number = Number(value)
  return Number.isFinite(number)
    ? Result.succeed(number)
    : Result.fail(invalidInput('decode-bars', `${field} is ${value}`))
}

const candidate14Bar = (row: typeof BarRowSchema.Type): Result.Result<Candidate14Bar, Candidate14Failure> => {
  if (!candidate14Universe.includes(row.symbol as Candidate14Bar['symbol'])) {
    return Result.fail(invalidInput('decode-bars', `unexpected symbol ${row.symbol}`))
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.session_date)) {
    return Result.fail(invalidInput('decode-bars', `invalid session date ${row.session_date}`))
  }
  return pipeNumbers(row)
}

const pipeNumbers = (row: typeof BarRowSchema.Type): Result.Result<Candidate14Bar, Candidate14Failure> =>
  Result.all({
    open: parsedNumber('adjusted_open', row.adjusted_open),
    high: parsedNumber('adjusted_high', row.adjusted_high),
    low: parsedNumber('adjusted_low', row.adjusted_low),
    close: parsedNumber('adjusted_close', row.adjusted_close),
    volume: parsedNumber('adjusted_volume', row.adjusted_volume),
  }).pipe(
    Result.map((values) => ({
      symbol: row.symbol as Candidate14Bar['symbol'],
      sessionDate: row.session_date as Candidate14Bar['sessionDate'],
      ...values,
    })),
  )

export const queryCandidate14DevelopmentBars = (
  client: ClickHouseClient,
): Effect.Effect<readonly Candidate14Bar[], Candidate14Failure> =>
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
          snapshotId: CANDIDATE_14_SNAPSHOT_ID,
          symbols: candidate14Universe,
          start: CANDIDATE_14_DEVELOPMENT_START,
          end: CANDIDATE_14_DEVELOPMENT_END,
        },
        format: 'JSONEachRow',
        query_id: 'bayn-candidate-14-development-bars-one-shot',
      })
      return result.json<unknown>()
    },
    catch: (cause) => ioFailure('query-development-bars', cause),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(BarRowsSchema, strictParseOptions)),
    Effect.mapError((cause) => ioFailure('decode-development-bars', cause)),
    Effect.flatMap((rows) => Effect.fromResult(Result.all(rows.map(candidate14Bar)))),
  )

const loadDevelopmentData = (config: Candidate14CommandConfig): Effect.Effect<Candidate14Dataset, Candidate14Failure> =>
  Effect.scoped(
    Effect.acquireRelease(acquireClickHouse(config), (client) =>
      Effect.tryPromise({
        try: () => client.close(),
        catch: (cause) => ioFailure('close-clickhouse-client', cause),
      }).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap(queryCandidate14DevelopmentBars),
      Effect.flatMap((bars) => {
        const sessions = candidate14DevelopmentSessions()
        return Effect.fromResult(
          candidate14DatasetHashes(sessions, bars).pipe(
            Result.map((hashes) => ({
              snapshotId: CANDIDATE_14_SNAPSHOT_ID,
              sessions,
              bars,
              ...hashes,
            })),
          ),
        )
      }),
    ),
  )

type Candidate14CommandFailure = Candidate14Failure | CandidateDevelopmentRunFailure

class Candidate14DevelopmentCommandError extends Data.TaggedError('Candidate14DevelopmentCommandError')<{
  readonly message: string
  readonly failure: Candidate14CommandFailure
}> {}

const renderFailure = (failure: Candidate14CommandFailure): string => {
  const tagged = failure as Candidate14CommandFailure & { readonly operation?: string; readonly reason?: string }
  return `${tagged._tag}${tagged.operation === undefined ? '' : `:${tagged.operation}`}${
    tagged.reason === undefined ? '' : `:${tagged.reason}`
  }`
}

const main = commandConfig.pipe(
  Effect.mapError((cause) => ioFailure('load-config', cause)),
  Effect.flatMap((config) => {
    const officialSessions = candidate14DevelopmentSessions()
    return runCandidateDevelopment(
      {
        candidateOrdinal: CANDIDATE_14_ORDINAL,
        priorTrialCount: CANDIDATE_14_PRIOR_TRIAL_COUNT,
        officialSessions,
        signalSessionDates: officialMonthEndSignalDates(officialSessions),
        featureLookbackSessions: candidate14Protocol.feature.declaredLookbackSessions,
      },
      {
        preregisterCandidate: () => preregisterCandidate(config.evaluatedCommit, config.preregistrationBase64),
        loadDevelopmentData: (registration) =>
          loadDevelopmentData(config).pipe(Effect.map((dataset) => ({ registration, dataset }))),
        evaluateDevelopment: ({ registration, dataset }, preflight) =>
          Effect.fromResult(evaluateCandidate14Development(registration, dataset, preflight)),
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
  Effect.mapError((failure) => new Candidate14DevelopmentCommandError({ message: renderFailure(failure), failure })),
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
