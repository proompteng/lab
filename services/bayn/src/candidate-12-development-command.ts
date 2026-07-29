import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { NodeRuntime } from '@effect/platform-node'
import { Config, Data, Effect, Redacted, Result } from 'effect'

import {
  officialMonthEndSignalDates,
  runCandidateDevelopment,
  type CandidateDevelopmentRunFailure,
} from './candidate-development'
import { candidate12DatasetHashes, evaluateCandidate12Development } from './same-calendar-month-seasonality/development'
import {
  CANDIDATE_12_DEVELOPMENT_END,
  CANDIDATE_12_DEVELOPMENT_START,
  CANDIDATE_12_PREREGISTRATION_COMMIT,
  CANDIDATE_12_PREREGISTRATION_SHA256,
  CANDIDATE_12_SNAPSHOT_ID,
  candidate12DevelopmentSessions,
  candidate12Protocol,
  candidate12Universe,
  type Candidate12Bar,
  type Candidate12Dataset,
  type Candidate12Failure,
  type Candidate12Registration,
} from './same-calendar-month-seasonality/model'

interface SessionRow {
  readonly session_date: string
}

interface BarRow {
  readonly symbol: string
  readonly session_date: string
  readonly adjusted_open: string
  readonly adjusted_high: string
  readonly adjusted_low: string
  readonly adjusted_close: string
  readonly adjusted_volume: string
}

interface Candidate12CommandConfig {
  readonly clickhouseUrl: string
  readonly clickhouseUsername: string
  readonly clickhousePassword: Redacted.Redacted<string>
  readonly evaluatedCommit: string
}

const commandConfig = Config.all({
  clickhouseUrl: Config.string('BAYN_CANDIDATE12_CLICKHOUSE_URL'),
  clickhouseUsername: Config.string('BAYN_CANDIDATE12_CLICKHOUSE_USERNAME'),
  clickhousePassword: Config.redacted('BAYN_CANDIDATE12_CLICKHOUSE_PASSWORD'),
  evaluatedCommit: Config.string('BAYN_CANDIDATE12_EVALUATED_COMMIT'),
})

const ioFailure = (operation: string, cause: unknown): Candidate12Failure => ({
  _tag: 'Candidate12IoFailure',
  operation,
  cause,
})

const sha256 = (bytes: ArrayBufferView): string =>
  createHash('sha256')
    .update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    .digest('hex')

const preregisterCandidate = (evaluatedCommit: string): Effect.Effect<Candidate12Registration, Candidate12Failure> =>
  Effect.tryPromise({
    try: () =>
      readFile(new URL('../candidates/ordinal-12-same-calendar-month-seasonality-preregistration.md', import.meta.url)),
    catch: (cause) => ioFailure('read-preregistration', cause),
  }).pipe(
    Effect.flatMap((bytes) => {
      const preregistrationHash = sha256(bytes)
      if (preregistrationHash !== CANDIDATE_12_PREREGISTRATION_SHA256) {
        return Effect.fail<Candidate12Failure>({
          _tag: 'Candidate12InvalidInput',
          operation: 'preregister',
          reason: `preregistration hash ${preregistrationHash} differs from ${CANDIDATE_12_PREREGISTRATION_SHA256}`,
        })
      }
      if (!/^[0-9a-f]{40}$/.test(evaluatedCommit)) {
        return Effect.fail<Candidate12Failure>({
          _tag: 'Candidate12InvalidInput',
          operation: 'preregister',
          reason: 'evaluated commit must be a lowercase 40-character Git object id',
        })
      }
      return Effect.succeed({
        preregistrationHash,
        preregistrationCommit: CANDIDATE_12_PREREGISTRATION_COMMIT,
        evaluatedCommit,
      })
    }),
  )

const acquireClickHouse = (config: Candidate12CommandConfig): Effect.Effect<ClickHouseClient, Candidate12Failure> =>
  Effect.try({
    try: () =>
      createClient({
        url: config.clickhouseUrl,
        username: config.clickhouseUsername,
        password: Redacted.value(config.clickhousePassword),
        application: 'bayn-candidate-12-development',
        clickhouse_settings: { readonly: '1' },
      }),
    catch: (cause) => ioFailure('create-clickhouse-client', cause),
  })

export const queryCandidate12DevelopmentData = (
  client: ClickHouseClient,
): Effect.Effect<
  { readonly sessions: readonly string[]; readonly bars: readonly Candidate12Bar[] },
  Candidate12Failure
> =>
  Effect.tryPromise({
    try: () =>
      client.query({
        query: `
          SELECT toString(session_date) AS session_date
          FROM signal.exchange_sessions_v1
          WHERE snapshot_id = {snapshotId:String}
            AND toString(session_date) >= {start:String}
            AND toString(session_date) <= {end:String}
          ORDER BY session_date
        `,
        query_params: {
          snapshotId: CANDIDATE_12_SNAPSHOT_ID,
          start: CANDIDATE_12_DEVELOPMENT_START,
          end: CANDIDATE_12_DEVELOPMENT_END,
        },
        format: 'JSONEachRow',
        query_id: 'bayn-candidate-12-development-sessions',
      }),
    catch: (cause) => ioFailure('query-development-sessions', cause),
  }).pipe(
    Effect.flatMap((sessionResult) =>
      Effect.tryPromise({
        try: () => sessionResult.json<SessionRow>(),
        catch: (cause) => ioFailure('decode-development-sessions', cause),
      }),
    ),
    Effect.flatMap((sessionRows) => {
      const sessions = sessionRows.map((row) => row.session_date)
      const expected = candidate12DevelopmentSessions()
      const exactCalendar =
        sessions.length === expected.length && sessions.every((session, index) => session === expected[index])
      return exactCalendar
        ? Effect.succeed(sessions)
        : Effect.fail<Candidate12Failure>({
            _tag: 'Candidate12InvalidInput',
            operation: 'verify-development-calendar',
            reason: `queried calendar differs from the frozen ${expected.length}-session calendar`,
          })
    }),
    // The complete remote calendar is verified before the first adjusted-bar query.
    Effect.flatMap((sessions) =>
      Effect.tryPromise({
        try: async () => {
          const barResult = await client.query({
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
              snapshotId: CANDIDATE_12_SNAPSHOT_ID,
              symbols: candidate12Universe,
              start: CANDIDATE_12_DEVELOPMENT_START,
              end: CANDIDATE_12_DEVELOPMENT_END,
            },
            format: 'JSONEachRow',
            query_id: 'bayn-candidate-12-development-bars',
          })
          const barRows = await barResult.json<BarRow>()
          return {
            sessions,
            bars: barRows.map((row) => ({
              symbol: row.symbol as Candidate12Bar['symbol'],
              sessionDate: row.session_date as Candidate12Bar['sessionDate'],
              open: Number(row.adjusted_open),
              high: Number(row.adjusted_high),
              low: Number(row.adjusted_low),
              close: Number(row.adjusted_close),
              volume: Number(row.adjusted_volume),
            })),
          }
        },
        catch: (cause) => ioFailure('query-development-bars', cause),
      }),
    ),
  )

const loadDevelopmentData = (config: Candidate12CommandConfig): Effect.Effect<Candidate12Dataset, Candidate12Failure> =>
  Effect.scoped(
    Effect.acquireRelease(acquireClickHouse(config), (client) =>
      Effect.tryPromise({
        try: () => client.close(),
        catch: (cause) => ioFailure('close-clickhouse-client', cause),
      }).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap(queryCandidate12DevelopmentData),
      Effect.flatMap(({ bars, sessions }) =>
        Effect.fromResult(
          candidate12DatasetHashes(sessions as Candidate12Dataset['sessions'], bars).pipe(
            Result.map((hashes) => ({
              snapshotId: CANDIDATE_12_SNAPSHOT_ID,
              sessions: sessions as Candidate12Dataset['sessions'],
              bars,
              ...hashes,
            })),
          ),
        ),
      ),
    ),
  )

type Candidate12CommandFailure = Candidate12Failure | CandidateDevelopmentRunFailure

class Candidate12DevelopmentCommandError extends Data.TaggedError('Candidate12DevelopmentCommandError')<{
  readonly message: string
  readonly failure: Candidate12CommandFailure
}> {}

const renderFailure = (failure: Candidate12CommandFailure): string => {
  const tagged = failure as Candidate12CommandFailure & {
    readonly operation?: string
    readonly reason?: string
  }
  return `${tagged._tag}${tagged.operation === undefined ? '' : `:${tagged.operation}`}${
    tagged.reason === undefined ? '' : `:${tagged.reason}`
  }`
}

const main = commandConfig.pipe(
  Effect.mapError((cause) => ioFailure('load-config', cause)),
  Effect.flatMap((config) => {
    const officialSessions = candidate12DevelopmentSessions()
    return runCandidateDevelopment(
      {
        officialSessions,
        signalSessionDates: officialMonthEndSignalDates(officialSessions),
        featureLookbackSessions: candidate12Protocol.feature.declaredLookbackSessions,
      },
      {
        preregisterCandidate: () => preregisterCandidate(config.evaluatedCommit),
        loadDevelopmentData: (registration) =>
          loadDevelopmentData(config).pipe(Effect.map((dataset) => ({ registration, dataset }))),
        evaluateDevelopment: ({ registration, dataset }, preflight) =>
          Effect.fromResult(evaluateCandidate12Development(registration, dataset, preflight)),
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
  Effect.mapError((failure) => new Candidate12DevelopmentCommandError({ message: renderFailure(failure), failure })),
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
