import { ClickhouseClient } from '@effect/sql-clickhouse'
import { PgClient } from '@effect/sql-pg'
import { Data, Effect, Option, Result, Schema } from 'effect'

import type { LoadedRuntimeConfig } from '../../config'
import {
  openOpeningDriveQualification,
  persistOpeningDriveQualification,
  readIncompleteOpeningDriveQualificationLockId,
  readOpeningDrivePriorTrialReceiptHashes,
} from '../../db/opening-drive-qualification-postgres'
import type { OperationalError } from '../../errors'
import type { IntradayMarketDataService } from '../../market-data'
import { IntradayMarketData } from '../../market-data'
import { decodeManifests, decodeSessions } from '../../market-data/rows'
import { IsoDateSchema } from '../../schemas'
import { openingDriveBehaviorHash } from './decision'
import { qualifyOpeningDrive } from './qualification'
import type {
  OpeningDriveQualificationCalendar,
  OpeningDriveQualificationReceipt,
  OpeningDriveReplaySessionInput,
} from './qualification-model'
import { defaultOpeningDriveQualificationPolicy, hashOpeningDriveQualificationPolicy } from './qualification-policy'
import { hashOpeningDriveReplayCostModel } from './qualification-replay'
import {
  bindOpeningDriveQualificationVersions,
  prepareOpeningDriveQualificationCalendar,
  verifyOpeningDriveQualificationCalendarPublication,
  versionOpeningDriveQualificationSession,
  type OpeningDriveQualificationSessionPlan,
  type OpeningDriveQualificationVersionedSession,
} from './qualification-runner'
import { decodeDefaultOpeningDriveProtocol, hashOpeningDriveProtocol, type OpeningDriveProtocol } from './protocol'

export interface OpeningDriveQualificationRequest {
  readonly start: string
  readonly end: string
}

export interface OpeningDriveQualificationProgramReceipt {
  readonly schemaVersion: 'bayn.opening-drive.qualification-program-receipt.v1'
  readonly lockId: string
  readonly lockState: 'ACQUIRED' | 'TERMINAL'
  readonly persistenceState: 'PERSISTED' | 'EXISTING'
  readonly qualification: {
    readonly receiptHash: string
    readonly verdict: OpeningDriveQualificationReceipt['verdict']
    readonly sessionCount: number
  }
}

export class OpeningDriveQualificationProgramError extends Data.TaggedError('OpeningDriveQualificationProgramError')<{
  readonly operation:
    | 'request'
    | 'calendar'
    | 'build-binding'
    | 'capture-version'
    | 'load-snapshot'
    | 'qualify'
    | 'store'
  readonly message: string
  readonly cause?: unknown
}> {}

const error = (
  operation: OpeningDriveQualificationProgramError['operation'],
  message: string,
  cause?: unknown,
): OpeningDriveQualificationProgramError => new OpeningDriveQualificationProgramError({ operation, message, cause })

const decodeRequest = Schema.decodeUnknownResult(Schema.Struct({ start: IsoDateSchema, end: IsoDateSchema }))

const loadSignalCalendar = (
  sql: ClickhouseClient.ClickhouseClient,
  config: LoadedRuntimeConfig,
  request: OpeningDriveQualificationRequest,
) =>
  Effect.gen(function* () {
    const manifests = yield* Effect.fromResult(
      decodeManifests(
        yield* sql<Record<string, unknown>>`
        SELECT
          snapshot_id,
          schema_version,
          publisher_source_revision,
          publisher_image_repository,
          publisher_image_digest,
          universe_id,
          universe_symbol_hash,
          provider,
          source_feed,
          adjustment,
          calendar_version,
          toString(requested_start) AS requested_start,
          toString(publication_asof) AS publication_asof,
          toString(first_session) AS first_session,
          toString(last_session) AS last_session,
          symbol_count,
          session_count,
          bar_count,
          bars_content_hash,
          sessions_content_hash,
          manifest_content_hash,
          toString(finalized_at) AS finalized_at
        FROM signal.snapshot_manifests_v2
        WHERE snapshot_id = ${sql.param('String', config.clickhouse.snapshotId)}
        ORDER BY finalized_at
      `,
      ),
    ).pipe(Effect.mapError((cause) => error('calendar', 'Signal qualification manifest failed row validation', cause)))
    const sessions = yield* Effect.fromResult(
      decodeSessions(
        yield* sql<Record<string, unknown>>`
          SELECT
            snapshot_id,
            calendar_version,
            toString(session_date) AS session_date,
            open_time,
            close_time,
            timezone,
            provider
          FROM signal.exchange_sessions_v1
          WHERE snapshot_id = ${sql.param('String', config.clickhouse.snapshotId)}
          ORDER BY session_date
        `,
      ),
    ).pipe(Effect.mapError((cause) => error('calendar', 'Signal qualification sessions failed row validation', cause)))
    return yield* Effect.fromResult(
      verifyOpeningDriveQualificationCalendarPublication({
        manifests,
        sessions,
        snapshotId: config.clickhouse.snapshotId,
        publicationAsOf: config.clickhouse.publicationAsOf,
        calendarVersion: config.clickhouse.calendarVersion,
        start: request.start,
        end: request.end,
      }),
    ).pipe(
      Effect.mapError((cause) =>
        error('calendar', 'configured Signal snapshot calendar failed finalized-manifest verification', cause),
      ),
    )
  })

const captureVersions = (
  marketData: IntradayMarketDataService,
  plans: readonly OpeningDriveQualificationSessionPlan[],
) =>
  Effect.forEach(
    plans,
    (plan) =>
      Effect.all(
        {
          opening: marketData.captureVersion(plan.openingQuery),
          exit: marketData.captureVersion(plan.exitQuery),
        },
        { concurrency: 2 },
      ).pipe(
        Effect.flatMap(({ opening, exit }) =>
          Effect.fromResult(
            versionOpeningDriveQualificationSession(
              plan,
              { ...plan.openingQuery, archiveWatermarks: opening },
              { ...plan.exitQuery, archiveWatermarks: exit },
            ),
          ),
        ),
        Effect.mapError((cause) =>
          error('capture-version', `archive version capture failed for ${plan.sessionDate}`, cause),
        ),
      ),
    { concurrency: 4 },
  )

const loadReplaySessions = (
  marketData: IntradayMarketDataService,
  versions: readonly OpeningDriveQualificationVersionedSession[],
  calendar: OpeningDriveQualificationCalendar,
): Effect.Effect<readonly OpeningDriveReplaySessionInput[], OpeningDriveQualificationProgramError> =>
  Effect.forEach(
    versions,
    (version) => {
      const session = calendar.sessions.find(({ sessionDate }) => sessionDate === version.sessionDate)
      if (session === undefined) {
        return Effect.fail(error('load-snapshot', `qualification calendar lost session ${version.sessionDate}`))
      }
      return Effect.all(
        {
          opening: marketData.loadSnapshot(version.openingRequest),
          exit: marketData.loadSnapshot(version.exitRequest),
        },
        { concurrency: 2 },
      ).pipe(
        Effect.flatMap(({ opening, exit }) =>
          Effect.all(
            {
              opening: marketData.verifyArchiveSnapshot(opening),
              exit: marketData.verifyArchiveSnapshot(exit),
            },
            { concurrency: 2 },
          ),
        ),
        Effect.map(({ opening, exit }) =>
          Object.freeze({ opening: Object.freeze({ snapshot: opening, session }), exit }),
        ),
        Effect.mapError((cause: OperationalError) =>
          error('load-snapshot', `immutable qualification replay load failed for ${version.sessionDate}`, cause),
        ),
      )
    },
    { concurrency: 4 },
  )

export const runOpeningDriveQualification = (
  config: LoadedRuntimeConfig,
  requestInput: OpeningDriveQualificationRequest,
): Effect.Effect<
  OpeningDriveQualificationProgramReceipt,
  OpeningDriveQualificationProgramError,
  ClickhouseClient.ClickhouseClient | PgClient.PgClient | IntradayMarketData
> =>
  Effect.gen(function* () {
    const requestResult = decodeRequest(requestInput)
    if (Result.isFailure(requestResult) || requestInput.start > requestInput.end) {
      return yield* error('request', 'opening-drive qualification requires an ordered ISO session range')
    }
    const protocolResult = decodeDefaultOpeningDriveProtocol()
    if (Result.isFailure(protocolResult))
      return yield* error('build-binding', 'default opening-drive protocol is invalid')
    const protocol: OpeningDriveProtocol = protocolResult.success
    const protocolHash = hashOpeningDriveProtocol(protocol)
    const policyHash = hashOpeningDriveQualificationPolicy(defaultOpeningDriveQualificationPolicy)
    const costModelHash = hashOpeningDriveReplayCostModel()
    if (
      Result.isFailure(protocolHash) ||
      Result.isFailure(policyHash) ||
      Result.isFailure(costModelHash) ||
      config.build.strategyBehaviorHash !== openingDriveBehaviorHash ||
      config.build.strategyParameterHash !== protocolHash.success
    ) {
      return yield* error(
        'build-binding',
        'running image build metadata does not match the executable opening-drive strategy and protocol',
      )
    }

    const clickhouse = yield* ClickhouseClient.ClickhouseClient
    const postgres = yield* PgClient.PgClient
    const marketData = yield* IntradayMarketData
    const incompleteLockId = yield* readIncompleteOpeningDriveQualificationLockId(postgres).pipe(
      Effect.mapError((cause) => error('store', 'incomplete qualification lock read failed', cause)),
    )
    if (Option.isSome(incompleteLockId)) {
      return yield* error(
        'store',
        `opening-drive qualification lock ${incompleteLockId.value} is incomplete and cannot be retried or bypassed`,
      )
    }
    const signal = yield* loadSignalCalendar(clickhouse, config, requestInput).pipe(
      Effect.mapError((cause) =>
        cause instanceof OpeningDriveQualificationProgramError
          ? cause
          : error('calendar', 'Signal qualification calendar query failed', cause),
      ),
    )
    const prepared = yield* Effect.fromResult(
      prepareOpeningDriveQualificationCalendar({
        sessions: signal.sessions,
        finalizedAt: signal.finalizedAt,
        publication: signal.publication,
        protocol,
      }),
    ).pipe(Effect.mapError((cause) => error('calendar', 'qualification calendar preparation failed', cause)))
    const versions = yield* captureVersions(marketData, prepared.sessions)
    const priorTrials = yield* readOpeningDrivePriorTrialReceiptHashes(postgres).pipe(
      Effect.mapError((cause) => error('store', 'prior opening-drive qualification trial read failed', cause)),
    )
    const lock = yield* Effect.fromResult(
      bindOpeningDriveQualificationVersions(versions, {
        sourceRevision: config.build.sourceRevision,
        protocol,
        calendar: prepared.calendar,
        priorTrialReceiptHashes: priorTrials,
      }),
    ).pipe(Effect.mapError((cause) => error('build-binding', 'qualification lock construction failed', cause)))
    const opened = yield* openOpeningDriveQualification(postgres, lock, versions).pipe(
      Effect.mapError((cause) => error('store', 'qualification lock persistence failed', cause)),
    )
    if (opened.state === 'TERMINAL') {
      return Object.freeze({
        schemaVersion: 'bayn.opening-drive.qualification-program-receipt.v1' as const,
        lockId: opened.lockId,
        lockState: opened.state,
        persistenceState: 'EXISTING' as const,
        qualification: Object.freeze({
          receiptHash: opened.receiptHash,
          verdict: opened.verdict,
          sessionCount: opened.sessionCount,
        }),
      })
    }
    const sessions = yield* loadReplaySessions(marketData, versions, prepared.calendar)
    const run = yield* Effect.fromResult(
      qualifyOpeningDrive({ sessions, calendar: prepared.calendar, protocol, binding: lock.binding }),
    ).pipe(Effect.mapError((cause) => error('qualify', 'opening-drive qualification evaluation failed', cause)))
    const persistenceState = yield* persistOpeningDriveQualification(postgres, lock, run).pipe(
      Effect.mapError((cause) => error('store', 'qualification result persistence failed', cause)),
    )
    return Object.freeze({
      schemaVersion: 'bayn.opening-drive.qualification-program-receipt.v1' as const,
      lockId: lock.lockId,
      lockState: opened.state,
      persistenceState,
      qualification: Object.freeze({
        receiptHash: run.receipt.receiptHash,
        verdict: run.receipt.verdict,
        sessionCount: run.receipt.sessionCount,
      }),
    })
  })
