import { createHash } from 'node:crypto'

import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { NodeRuntime } from '@effect/platform-node'
import { Config, Data, Effect, Redacted, Result } from 'effect'

import {
  officialMonthEndSignalDates,
  runCandidateDevelopment,
  type CandidateDevelopmentRunFailure,
} from './candidate-development'
import { candidate9DatasetHashes, evaluateCandidate9Development } from './asymmetric-range-volatility/development'
import {
  CANDIDATE_9_DEVELOPMENT_END,
  CANDIDATE_9_DEVELOPMENT_START,
  CANDIDATE_9_PREREGISTRATION_SHA256,
  CANDIDATE_9_SNAPSHOT_ID,
  CANDIDATE_9_SYMBOL,
  candidate9DevelopmentSessions,
  candidate9Protocol,
  type Candidate9Bar,
  type Candidate9Dataset,
  type Candidate9Failure,
  type Candidate9Registration,
} from './asymmetric-range-volatility/model'

interface SessionRow {
  readonly session_date: string
}

interface BarRow {
  readonly session_date: string
  readonly adjusted_open: string
  readonly adjusted_high: string
  readonly adjusted_low: string
  readonly adjusted_close: string
  readonly adjusted_volume: string
}

interface Candidate9CommandConfig {
  readonly clickhouseUrl: string
  readonly clickhouseUsername: string
  readonly clickhousePassword: Redacted.Redacted<string>
  readonly evaluatedCommit: string
}

const commandConfig = Config.all({
  clickhouseUrl: Config.string('BAYN_CANDIDATE9_CLICKHOUSE_URL'),
  clickhouseUsername: Config.string('BAYN_CANDIDATE9_CLICKHOUSE_USERNAME'),
  clickhousePassword: Config.redacted('BAYN_CANDIDATE9_CLICKHOUSE_PASSWORD'),
  evaluatedCommit: Config.string('BAYN_CANDIDATE9_EVALUATED_COMMIT'),
})

const ioFailure = (operation: string, cause: unknown): Candidate9Failure => ({
  _tag: 'Candidate9IoFailure',
  operation,
  cause,
})

const sha256 = (bytes: ArrayBuffer): string => createHash('sha256').update(new Uint8Array(bytes)).digest('hex')

const preregisterCandidate = (evaluatedCommit: string): Effect.Effect<Candidate9Registration, Candidate9Failure> =>
  Effect.tryPromise({
    try: () =>
      Bun.file(
        new URL('../candidates/ordinal-9-asymmetric-range-volatility-preregistration.md', import.meta.url),
      ).arrayBuffer(),
    catch: (cause) => ioFailure('read-preregistration', cause),
  }).pipe(
    Effect.flatMap((bytes) => {
      const preregistrationHash = sha256(bytes)
      if (preregistrationHash !== CANDIDATE_9_PREREGISTRATION_SHA256) {
        return Effect.fail<Candidate9Failure>({
          _tag: 'Candidate9InvalidInput',
          operation: 'preregister',
          reason: `preregistration hash ${preregistrationHash} differs from ${CANDIDATE_9_PREREGISTRATION_SHA256}`,
        })
      }
      if (!/^[0-9a-f]{40}$/.test(evaluatedCommit)) {
        return Effect.fail<Candidate9Failure>({
          _tag: 'Candidate9InvalidInput',
          operation: 'preregister',
          reason: 'evaluated commit must be a lowercase 40-character Git object id',
        })
      }
      return Effect.succeed({ preregistrationHash, evaluatedCommit })
    }),
  )

const acquireClickHouse = (config: Candidate9CommandConfig): Effect.Effect<ClickHouseClient, Candidate9Failure> =>
  Effect.try({
    try: () =>
      createClient({
        url: config.clickhouseUrl,
        username: config.clickhouseUsername,
        password: Redacted.value(config.clickhousePassword),
        application: 'bayn-candidate-9-development',
        clickhouse_settings: { readonly: '1' },
      }),
    catch: (cause) => ioFailure('create-clickhouse-client', cause),
  })

const queryDevelopmentData = (
  client: ClickHouseClient,
): Effect.Effect<
  { readonly sessions: readonly string[]; readonly bars: readonly Candidate9Bar[] },
  Candidate9Failure
> =>
  Effect.tryPromise({
    try: async () => {
      const [sessionResult, barResult] = await Promise.all([
        client.query({
          query: `
            SELECT toString(session_date) AS session_date
            FROM signal.exchange_sessions_v1
            WHERE snapshot_id = {snapshotId:String}
              AND session_date >= toDate({start:String})
              AND session_date <= toDate({end:String})
            ORDER BY session_date
          `,
          query_params: {
            snapshotId: CANDIDATE_9_SNAPSHOT_ID,
            start: CANDIDATE_9_DEVELOPMENT_START,
            end: CANDIDATE_9_DEVELOPMENT_END,
          },
          format: 'JSONEachRow',
          query_id: 'bayn-candidate-9-development-sessions',
        }),
        client.query({
          query: `
            SELECT
              toString(session_date) AS session_date,
              toDecimalString(adjusted_open, 8) AS adjusted_open,
              toDecimalString(adjusted_high, 8) AS adjusted_high,
              toDecimalString(adjusted_low, 8) AS adjusted_low,
              toDecimalString(adjusted_close, 8) AS adjusted_close,
              toDecimalString(adjusted_volume, 8) AS adjusted_volume
            FROM signal.adjusted_daily_bars_v2
            WHERE snapshot_id = {snapshotId:String}
              AND symbol = {symbol:String}
              AND session_date >= toDate({start:String})
              AND session_date <= toDate({end:String})
            ORDER BY session_date
          `,
          query_params: {
            snapshotId: CANDIDATE_9_SNAPSHOT_ID,
            symbol: CANDIDATE_9_SYMBOL,
            start: CANDIDATE_9_DEVELOPMENT_START,
            end: CANDIDATE_9_DEVELOPMENT_END,
          },
          format: 'JSONEachRow',
          query_id: 'bayn-candidate-9-development-bars',
        }),
      ])
      const [sessionRows, barRows] = await Promise.all([sessionResult.json<SessionRow>(), barResult.json<BarRow>()])
      return {
        sessions: sessionRows.map((row) => row.session_date),
        bars: barRows.map((row) => ({
          sessionDate: row.session_date as Candidate9Bar['sessionDate'],
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

const loadDevelopmentData = (config: Candidate9CommandConfig): Effect.Effect<Candidate9Dataset, Candidate9Failure> =>
  Effect.scoped(
    Effect.acquireRelease(acquireClickHouse(config), (client) =>
      Effect.tryPromise({
        try: () => client.close(),
        catch: (cause) => ioFailure('close-clickhouse-client', cause),
      }).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap(queryDevelopmentData),
      Effect.flatMap(({ bars, sessions }) =>
        Effect.fromResult(
          candidate9DatasetHashes(sessions as Candidate9Dataset['sessions'], bars).pipe(
            Result.map((hashes) => ({
              snapshotId: CANDIDATE_9_SNAPSHOT_ID,
              sessions: sessions as Candidate9Dataset['sessions'],
              bars,
              ...hashes,
            })),
          ),
        ),
      ),
    ),
  )

type Candidate9CommandFailure = Candidate9Failure | CandidateDevelopmentRunFailure

class Candidate9DevelopmentCommandError extends Data.TaggedError('Candidate9DevelopmentCommandError')<{
  readonly message: string
  readonly failure: Candidate9CommandFailure
}> {}

const renderFailure = (failure: Candidate9CommandFailure): string => {
  const tagged = failure as Candidate9CommandFailure & {
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
    const officialSessions = candidate9DevelopmentSessions()
    return runCandidateDevelopment(
      {
        officialSessions,
        signalSessionDates: officialMonthEndSignalDates(officialSessions),
        featureLookbackSessions: candidate9Protocol.feature.sessions,
      },
      {
        preregisterCandidate: () => preregisterCandidate(config.evaluatedCommit),
        loadDevelopmentData: (registration) =>
          loadDevelopmentData(config).pipe(Effect.map((dataset) => ({ registration, dataset }))),
        evaluateDevelopment: ({ registration, dataset }, preflight) =>
          Effect.fromResult(evaluateCandidate9Development(registration, dataset, preflight)),
      },
    )
  }),
  Effect.tap((report) => Effect.sync(() => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))),
  Effect.flatMap((report) =>
    report.status === 'PASS'
      ? Effect.succeed(report)
      : Effect.fail(
          ioFailure(
            'development-rejected',
            `Candidate 9 failed the preregistered development screen: ${report.uncertainty.reasonCodes.join(',')}`,
          ),
        ),
  ),
  Effect.mapError((failure) => new Candidate9DevelopmentCommandError({ message: renderFailure(failure), failure })),
)

if (import.meta.main) NodeRuntime.runMain(main)
