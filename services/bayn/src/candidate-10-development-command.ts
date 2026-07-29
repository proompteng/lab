import { createHash } from 'node:crypto'

import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { NodeRuntime } from '@effect/platform-node'
import { Config, Data, Effect, Redacted, Result } from 'effect'

import {
  officialMonthEndSignalDates,
  runCandidateDevelopment,
  type CandidateDevelopmentRunFailure,
} from './candidate-development'
import { candidate10DatasetHashes, evaluateCandidate10Development } from './benchmark-anchored-high/development'
import {
  CANDIDATE_10_DEVELOPMENT_END,
  CANDIDATE_10_DEVELOPMENT_START,
  CANDIDATE_10_PREREGISTRATION_COMMIT,
  CANDIDATE_10_PREREGISTRATION_SHA256,
  CANDIDATE_10_SNAPSHOT_ID,
  candidate10DevelopmentSessions,
  candidate10Protocol,
  candidate10Universe,
  type Candidate10Bar,
  type Candidate10Dataset,
  type Candidate10Failure,
  type Candidate10Registration,
} from './benchmark-anchored-high/model'

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

interface Candidate10CommandConfig {
  readonly clickhouseUrl: string
  readonly clickhouseUsername: string
  readonly clickhousePassword: Redacted.Redacted<string>
  readonly evaluatedCommit: string
}

const commandConfig = Config.all({
  clickhouseUrl: Config.string('BAYN_CANDIDATE10_CLICKHOUSE_URL'),
  clickhouseUsername: Config.string('BAYN_CANDIDATE10_CLICKHOUSE_USERNAME'),
  clickhousePassword: Config.redacted('BAYN_CANDIDATE10_CLICKHOUSE_PASSWORD'),
  evaluatedCommit: Config.string('BAYN_CANDIDATE10_EVALUATED_COMMIT'),
})

const ioFailure = (operation: string, cause: unknown): Candidate10Failure => ({
  _tag: 'Candidate10IoFailure',
  operation,
  cause,
})

const sha256 = (bytes: ArrayBuffer): string => createHash('sha256').update(new Uint8Array(bytes)).digest('hex')

const preregisterCandidate = (evaluatedCommit: string): Effect.Effect<Candidate10Registration, Candidate10Failure> =>
  Effect.tryPromise({
    try: () =>
      Bun.file(
        new URL('../candidates/ordinal-10-benchmark-anchored-52-week-high-preregistration.md', import.meta.url),
      ).arrayBuffer(),
    catch: (cause) => ioFailure('read-preregistration', cause),
  }).pipe(
    Effect.flatMap((bytes) => {
      const preregistrationHash = sha256(bytes)
      if (preregistrationHash !== CANDIDATE_10_PREREGISTRATION_SHA256) {
        return Effect.fail<Candidate10Failure>({
          _tag: 'Candidate10InvalidInput',
          operation: 'preregister',
          reason: `preregistration hash ${preregistrationHash} differs from ${CANDIDATE_10_PREREGISTRATION_SHA256}`,
        })
      }
      if (!/^[0-9a-f]{40}$/.test(evaluatedCommit)) {
        return Effect.fail<Candidate10Failure>({
          _tag: 'Candidate10InvalidInput',
          operation: 'preregister',
          reason: 'evaluated commit must be a lowercase 40-character Git object id',
        })
      }
      return Effect.succeed({
        preregistrationHash,
        preregistrationCommit: CANDIDATE_10_PREREGISTRATION_COMMIT,
        evaluatedCommit,
      })
    }),
  )

const acquireClickHouse = (config: Candidate10CommandConfig): Effect.Effect<ClickHouseClient, Candidate10Failure> =>
  Effect.try({
    try: () =>
      createClient({
        url: config.clickhouseUrl,
        username: config.clickhouseUsername,
        password: Redacted.value(config.clickhousePassword),
        application: 'bayn-candidate-10-development',
        clickhouse_settings: { readonly: '1' },
      }),
    catch: (cause) => ioFailure('create-clickhouse-client', cause),
  })

export const queryCandidate10DevelopmentData = (
  client: ClickHouseClient,
): Effect.Effect<
  { readonly sessions: readonly string[]; readonly bars: readonly Candidate10Bar[] },
  Candidate10Failure
> =>
  Effect.tryPromise({
    try: async () => {
      const sessionResult = await client.query({
        query: `
          SELECT toString(session_date) AS session_date
          FROM signal.exchange_sessions_v1
          WHERE snapshot_id = {snapshotId:String}
            AND toString(session_date) >= {start:String}
            AND toString(session_date) <= {end:String}
          ORDER BY session_date
        `,
        query_params: {
          snapshotId: CANDIDATE_10_SNAPSHOT_ID,
          start: CANDIDATE_10_DEVELOPMENT_START,
          end: CANDIDATE_10_DEVELOPMENT_END,
        },
        format: 'JSONEachRow',
        query_id: 'bayn-candidate-10-development-sessions',
      })
      const sessionRows = await sessionResult.json<SessionRow>()

      // Calendar materialization is deliberately complete before the first return-data query.
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
          snapshotId: CANDIDATE_10_SNAPSHOT_ID,
          symbols: candidate10Universe,
          start: CANDIDATE_10_DEVELOPMENT_START,
          end: CANDIDATE_10_DEVELOPMENT_END,
        },
        format: 'JSONEachRow',
        query_id: 'bayn-candidate-10-development-bars',
      })
      const barRows = await barResult.json<BarRow>()
      return {
        sessions: sessionRows.map((row) => row.session_date),
        bars: barRows.map((row) => ({
          symbol: row.symbol as Candidate10Bar['symbol'],
          sessionDate: row.session_date as Candidate10Bar['sessionDate'],
          open: Number(row.adjusted_open),
          high: Number(row.adjusted_high),
          low: Number(row.adjusted_low),
          close: Number(row.adjusted_close),
          volume: Number(row.adjusted_volume),
        })),
      }
    },
    catch: (cause) => ioFailure('query-development-data', cause),
  })

const loadDevelopmentData = (config: Candidate10CommandConfig): Effect.Effect<Candidate10Dataset, Candidate10Failure> =>
  Effect.scoped(
    Effect.acquireRelease(acquireClickHouse(config), (client) =>
      Effect.tryPromise({
        try: () => client.close(),
        catch: (cause) => ioFailure('close-clickhouse-client', cause),
      }).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap(queryCandidate10DevelopmentData),
      Effect.flatMap(({ bars, sessions }) =>
        Effect.fromResult(
          candidate10DatasetHashes(sessions as Candidate10Dataset['sessions'], bars).pipe(
            Result.map((hashes) => ({
              snapshotId: CANDIDATE_10_SNAPSHOT_ID,
              sessions: sessions as Candidate10Dataset['sessions'],
              bars,
              ...hashes,
            })),
          ),
        ),
      ),
    ),
  )

type Candidate10CommandFailure = Candidate10Failure | CandidateDevelopmentRunFailure

class Candidate10DevelopmentCommandError extends Data.TaggedError('Candidate10DevelopmentCommandError')<{
  readonly message: string
  readonly failure: Candidate10CommandFailure
}> {}

const renderFailure = (failure: Candidate10CommandFailure): string => {
  const tagged = failure as Candidate10CommandFailure & {
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
    const officialSessions = candidate10DevelopmentSessions()
    return runCandidateDevelopment(
      {
        officialSessions,
        signalSessionDates: officialMonthEndSignalDates(officialSessions),
        featureLookbackSessions: candidate10Protocol.feature.sessions,
      },
      {
        preregisterCandidate: () => preregisterCandidate(config.evaluatedCommit),
        loadDevelopmentData: (registration) =>
          loadDevelopmentData(config).pipe(Effect.map((dataset) => ({ registration, dataset }))),
        evaluateDevelopment: ({ registration, dataset }, preflight) =>
          Effect.fromResult(evaluateCandidate10Development(registration, dataset, preflight)),
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
  Effect.mapError((failure) => new Candidate10DevelopmentCommandError({ message: renderFailure(failure), failure })),
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
