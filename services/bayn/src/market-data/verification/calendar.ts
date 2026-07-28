import { Result, pipe } from 'effect'

import type { FinalizedPublicationRequest, MarketDataContract, MarketDataInspection, SnapshotRequest } from '../model'
import type { SignalManifestRow, SignalSessionRow, SnapshotRows } from '../rows'
import type { InputManifest, SymbolCoverage } from '../../types'
import type { MarketDataVerificationError, SessionField } from './errors'
import { verifyManifest, type VerifiedManifest } from './manifest'
import {
  canonicalHashResult,
  database,
  fail,
  requireCondition,
  requireValue,
  tables,
  validateAll,
  validateBoundSessions,
  withoutSnapshot,
} from './shared'

export interface VerifiedCalendar {
  readonly verifiedManifest: VerifiedManifest
  readonly orderedSessions: readonly SignalSessionRow[]
  readonly boundedSessions: readonly SignalSessionRow[]
  readonly inputManifest: InputManifest
}

const sessionMismatch = (
  field: SessionField,
  expected: unknown,
  observed: unknown,
  snapshotId: string,
  sessionDate: string | null,
): MarketDataVerificationError => ({
  _tag: 'SessionFieldMismatch',
  field,
  expected,
  observed,
  snapshotId,
  sessionDate,
})

const validateSession = (
  session: SignalSessionRow,
  manifest: SignalManifestRow,
  request: SnapshotRequest,
): Result.Result<void, MarketDataVerificationError> =>
  validateAll([
    requireCondition(
      session.snapshot_id === request.snapshotId,
      sessionMismatch('snapshotId', request.snapshotId, session.snapshot_id, request.snapshotId, session.session_date),
    ),
    requireCondition(
      session.calendar_version === manifest.calendar_version,
      sessionMismatch(
        'calendarVersion',
        manifest.calendar_version,
        session.calendar_version,
        request.snapshotId,
        session.session_date,
      ),
    ),
    requireCondition(
      session.provider === manifest.provider,
      sessionMismatch('provider', manifest.provider, session.provider, request.snapshotId, session.session_date),
    ),
    requireCondition(session.open_time < session.close_time, {
      _tag: 'SessionHoursInvalid',
      snapshotId: request.snapshotId,
      sessionDate: session.session_date,
      openTime: session.open_time,
      closeTime: session.close_time,
    }),
  ])

export const verifyCalendar = (
  sessions: readonly SignalSessionRow[],
  manifests: readonly SignalManifestRow[],
  request: SnapshotRequest,
): Result.Result<VerifiedCalendar, MarketDataVerificationError> =>
  pipe(
    verifyManifest(manifests, request),
    Result.flatMap((verifiedManifest) => {
      const { finalizedSnapshot, manifest, universe } = verifiedManifest
      const orderedSessions = [...sessions].sort((left, right) => left.session_date.localeCompare(right.session_date))
      const duplicate = orderedSessions.find(
        (session, index) => index > 0 && orderedSessions[index - 1]?.session_date === session.session_date,
      )
      const sessionDates = new Set(orderedSessions.map((session) => session.session_date))
      const firstSession = orderedSessions.at(0)
      const lastSession = orderedSessions.at(-1)
      return pipe(
        canonicalHashResult('sessions', request.snapshotId, orderedSessions.map(withoutSnapshot)),
        Result.flatMap((sessionsContentHash) =>
          validateAll([
            ...orderedSessions.map((session) => validateSession(session, manifest, request)),
            requireCondition(duplicate === undefined, {
              _tag: 'DuplicateSession',
              snapshotId: request.snapshotId,
              sessionDate: duplicate?.session_date ?? '',
            }),
            requireCondition(
              orderedSessions.length === manifest.session_count,
              sessionMismatch('count', manifest.session_count, orderedSessions.length, request.snapshotId, null),
            ),
            requireCondition(
              firstSession?.session_date === manifest.first_session,
              sessionMismatch(
                'firstSession',
                manifest.first_session,
                firstSession?.session_date ?? null,
                request.snapshotId,
                firstSession?.session_date ?? null,
              ),
            ),
            requireCondition(
              lastSession?.session_date === manifest.last_session,
              sessionMismatch(
                'lastSession',
                manifest.last_session,
                lastSession?.session_date ?? null,
                request.snapshotId,
                lastSession?.session_date ?? null,
              ),
            ),
            requireCondition(
              sessionsContentHash === manifest.sessions_content_hash,
              sessionMismatch(
                'sessionsContentHash',
                manifest.sessions_content_hash,
                sessionsContentHash,
                request.snapshotId,
                null,
              ),
            ),
            validateBoundSessions(sessionDates, request.bounds),
          ]),
        ),
        Result.flatMap(() => {
          const boundedSessions = orderedSessions.filter(
            (session) =>
              session.session_date >= request.bounds.dataStart && session.session_date <= request.bounds.dataEnd,
          )
          const emptyError: MarketDataVerificationError = {
            _tag: 'BoundedSessionsEmpty',
            snapshotId: request.snapshotId,
            dataStart: request.bounds.dataStart,
            dataEnd: request.bounds.dataEnd,
          }
          return pipe(
            Result.all({
              firstBoundedSession: requireValue(boundedSessions.at(0), emptyError),
              lastBoundedSession: requireValue(boundedSessions.at(-1), emptyError),
            }),
            Result.flatMap(({ firstBoundedSession, lastBoundedSession }) => {
              const symbols: SymbolCoverage[] = universe.map((symbol) => ({
                symbol,
                rows: boundedSessions.length,
                firstSession: firstBoundedSession.session_date,
                lastSession: lastBoundedSession.session_date,
              }))
              const material: Omit<InputManifest, 'hash'> = {
                schemaVersion: 'bayn.input-manifest.v3',
                tables,
                database,
                bounds: request.bounds,
                rowCount: boundedSessions.length * universe.length,
                sessionCount: boundedSessions.length,
                firstSession: firstBoundedSession.session_date,
                lastSession: lastBoundedSession.session_date,
                symbols,
                finalizedSnapshot,
              }
              return Result.map(
                canonicalHashResult('input-manifest', request.snapshotId, material),
                (hash): VerifiedCalendar => ({
                  verifiedManifest,
                  orderedSessions,
                  boundedSessions,
                  inputManifest: { ...material, hash },
                }),
              )
            }),
          )
        }),
      )
    }),
  )

export const verifyFinalizedCalendar = (
  rows: Pick<SnapshotRows, 'sessions' | 'manifests'>,
  request: SnapshotRequest,
): Result.Result<MarketDataInspection, MarketDataVerificationError> =>
  pipe(
    verifyCalendar(rows.sessions, rows.manifests, request),
    Result.flatMap((calendar) => {
      const signalSession = calendar.boundedSessions.at(-1)
      return signalSession === undefined
        ? fail({ _tag: 'SignalSessionMissing', snapshotId: request.snapshotId })
        : Result.succeed({
            manifest: calendar.inputManifest,
            sessionDates: calendar.boundedSessions.map((session) => session.session_date),
            signalSession: {
              calendar_version: signalSession.calendar_version,
              session_date: signalSession.session_date,
              close_time: signalSession.close_time,
              timezone: signalSession.timezone,
            },
          })
    }),
  )

export const publicationSnapshotRequest = (
  manifest: SignalManifestRow,
  input: FinalizedPublicationRequest,
  contract: MarketDataContract,
  observedAt: string,
): SnapshotRequest => ({
  snapshotId: manifest.snapshot_id,
  publicationAsOf: input.signalSessionDate,
  calendarVersion: input.signalCalendarVersion,
  universe: contract.universe,
  bounds: {
    schemaVersion: 'bayn.evaluation-bounds.v1',
    dataStart: contract.historyStart,
    dataEnd: input.signalSessionDate,
    lookbackStart: contract.historyStart,
    evaluationStart: contract.evaluationStart,
    evaluationEnd: input.signalSessionDate,
  },
  observedAt,
  universeId: contract.universeId,
  universeSymbolHash: contract.universeSymbolHash,
  historyStart: contract.historyStart,
  evaluationStart: contract.evaluationStart,
})
