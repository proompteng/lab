import { Result, Schema, pipe } from 'effect'

import { type EvaluationBounds, type FinalizedSnapshotProvenance, FinalizedSnapshotProvenanceSchema } from './contracts'
import { canonicalHashV1Result, sha256, type CanonicalHashFailure } from './hash'
import { strictParseOptions } from './schemas'
import type {
  FinalizedPublicationRequest,
  MarketDataContract,
  MarketDataInspection,
  MarketDataSnapshot,
  SnapshotRequest,
  VerifiedSignalSession,
} from './market-data/model'
import type { SignalBarRow, SignalManifestRow, SignalSessionRow, SnapshotRows } from './market-data/rows'
import { type DailyBar, type InputManifest, type SymbolCoverage, PublicationSchema } from './types'

const database = 'signal' as const
const tables = {
  bars: 'adjusted_daily_bars_v2',
  sessions: 'exchange_sessions_v1',
  manifests: 'snapshot_manifests_v2',
} as const

type BoundField = Exclude<keyof EvaluationBounds, 'schemaVersion'>
type ManifestField =
  | 'barCount'
  | 'calendarVersion'
  | 'dataBounds'
  | 'evaluationBounds'
  | 'historyStart'
  | 'manifestContentHash'
  | 'publicationAsOf'
  | 'snapshotId'
  | 'symbolCount'
  | 'universeId'
  | 'universeSymbolHash'
type SessionField =
  | 'calendarVersion'
  | 'closeTime'
  | 'count'
  | 'firstSession'
  | 'lastSession'
  | 'provider'
  | 'sessionsContentHash'
  | 'snapshotId'
type BarField =
  | 'barCount'
  | 'barsContentHash'
  | 'boundedBarCount'
  | 'publicationAsOf'
  | 'provenance'
  | 'snapshotId'
  | 'universe'

export type MarketDataVerificationError =
  | {
      readonly _tag: 'RowDecodeFailed'
      readonly rows: 'bars' | 'finalized-snapshot' | 'manifests' | 'sessions'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CountInvalid'
      readonly field: 'bar_count' | 'session_count' | 'symbol_count'
      readonly value: string | number
    }
  | {
      readonly _tag: 'UniverseInvalid'
      readonly reason: 'empty-or-duplicate' | 'not-canonical'
      readonly universe: readonly string[]
    }
  | {
      readonly _tag: 'DecimalInvalid'
      readonly field: 'adjusted_close' | 'adjusted_high' | 'adjusted_low' | 'adjusted_open' | 'adjusted_volume'
      readonly requirement: 'non-negative' | 'positive'
      readonly value: string
      readonly symbol: string
      readonly sessionDate: string
    }
  | {
      readonly _tag: 'OhlcInvalid'
      readonly symbol: string
      readonly sessionDate: string
      readonly open: number
      readonly high: number
      readonly low: number
      readonly close: number
    }
  | {
      readonly _tag: 'BoundSessionMissing'
      readonly field: BoundField
      readonly value: string
    }
  | {
      readonly _tag: 'ManifestCountMismatch'
      readonly snapshotId: string
      readonly count: number
    }
  | {
      readonly _tag: 'ManifestFieldMismatch'
      readonly field: ManifestField
      readonly expected: unknown
      readonly observed: unknown
      readonly snapshotId: string
    }
  | {
      readonly _tag: 'SnapshotFinalizedInFuture'
      readonly snapshotId: string
      readonly finalizedAt: string
      readonly observedAt: string
    }
  | {
      readonly _tag: 'ManifestCardinalityInvalid'
      readonly snapshotId: string
      readonly symbolCount: number
      readonly sessionCount: number
      readonly barCount: number
    }
  | {
      readonly _tag: 'CanonicalizationFailed'
      readonly target: 'bars' | 'input-manifest' | 'manifest' | 'sessions' | 'snapshot-identity'
      readonly snapshotId: string
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'SessionFieldMismatch'
      readonly field: SessionField
      readonly expected: unknown
      readonly observed: unknown
      readonly snapshotId: string
      readonly sessionDate: string | null
    }
  | {
      readonly _tag: 'SessionHoursInvalid'
      readonly snapshotId: string
      readonly sessionDate: string
      readonly openTime: string
      readonly closeTime: string
    }
  | {
      readonly _tag: 'DuplicateSession'
      readonly snapshotId: string
      readonly sessionDate: string
    }
  | {
      readonly _tag: 'BoundedSessionsEmpty'
      readonly snapshotId: string
      readonly dataStart: string
      readonly dataEnd: string
    }
  | {
      readonly _tag: 'SignalSessionMissing'
      readonly snapshotId: string
    }
  | {
      readonly _tag: 'PublicationManifestCountMismatch'
      readonly signalSessionDate: string
      readonly calendarVersion: string
      readonly count: number
    }
  | {
      readonly _tag: 'BoundSnapshotMismatch'
      readonly phase: 'manifest-query' | 'publication-verification' | 'session-query'
      readonly expectedSnapshotId: string
      readonly observedSnapshotIds: readonly string[]
    }
  | {
      readonly _tag: 'CyclePublicationCountExceeded'
      readonly maximum: number
      readonly observed: number
    }
  | {
      readonly _tag: 'DuplicatePublicationDate'
      readonly publicationAsOf: string
      readonly snapshotIds: readonly string[]
    }
  | {
      readonly _tag: 'PublicationVerificationMissing'
      readonly snapshotId: string
      readonly publicationAsOf: string
      readonly calendarVersion: string
    }
  | {
      readonly _tag: 'BarFieldMismatch'
      readonly field: BarField
      readonly expected: unknown
      readonly observed: unknown
      readonly snapshotId: string
      readonly symbol: string | null
      readonly sessionDate: string | null
    }
  | {
      readonly _tag: 'BarOutsideCalendar'
      readonly snapshotId: string
      readonly symbol: string
      readonly sessionDate: string
    }
  | {
      readonly _tag: 'DuplicateBar'
      readonly snapshotId: string
      readonly symbol: string
      readonly sessionDate: string
    }
  | {
      readonly _tag: 'SnapshotCellMissing'
      readonly snapshotId: string
      readonly symbol: string
      readonly sessionDate: string
    }

const fail = <A>(error: MarketDataVerificationError): Result.Result<A, MarketDataVerificationError> =>
  Result.fail(error)

const requireCondition = (
  condition: boolean,
  error: MarketDataVerificationError,
): Result.Result<void, MarketDataVerificationError> => (condition ? Result.succeed(undefined) : fail(error))

const requireValue = <A>(
  value: A | null | undefined,
  error: MarketDataVerificationError,
): Result.Result<A, MarketDataVerificationError> =>
  value === null || value === undefined ? fail(error) : Result.succeed(value)

const validateAll = (
  validations: ReadonlyArray<Result.Result<void, MarketDataVerificationError>>,
): Result.Result<void, MarketDataVerificationError> =>
  pipe(
    Result.all(validations),
    Result.map(() => undefined),
  )

const canonicalHashResult = (
  target: Extract<MarketDataVerificationError, { readonly _tag: 'CanonicalizationFailed' }>['target'],
  snapshotId: string,
  value: unknown,
): Result.Result<string, MarketDataVerificationError> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): MarketDataVerificationError => ({
      _tag: 'CanonicalizationFailed',
      target,
      snapshotId,
      cause,
    }),
  )

export const decodeSignalCount = (
  value: string | number,
  field: Extract<MarketDataVerificationError, { readonly _tag: 'CountInvalid' }>['field'],
): Result.Result<number, MarketDataVerificationError> => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Result.succeed(parsed)
    : fail({ _tag: 'CountInvalid', field, value })
}

const canonicalUniverse = (
  universe: readonly string[],
): Result.Result<readonly string[], MarketDataVerificationError> => {
  const canonical = [...new Set(universe)].sort()
  return canonical.length === 0 || canonical.length !== universe.length
    ? fail({ _tag: 'UniverseInvalid', reason: 'empty-or-duplicate', universe })
    : canonical.some((symbol, index) => symbol !== universe[index])
      ? fail({ _tag: 'UniverseInvalid', reason: 'not-canonical', universe })
      : Result.succeed(canonical)
}

const withoutSnapshot = <A extends { readonly snapshot_id: string }>({ snapshot_id: _, ...row }: A) => row
const withoutManifestHash = ({ manifest_content_hash: _, ...manifest }: SignalManifestRow) => manifest
const toUtcInstant = (value: string): string => `${value.replace(' ', 'T')}Z`

const decimalNumber = (
  row: SignalBarRow,
  field: Extract<MarketDataVerificationError, { readonly _tag: 'DecimalInvalid' }>['field'],
  requirement: 'non-negative' | 'positive',
): Result.Result<number, MarketDataVerificationError> => {
  const value = row[field]
  const parsed = Number(value)
  return Number.isFinite(parsed) && (requirement === 'positive' ? parsed > 0 : parsed >= 0)
    ? Result.succeed(parsed)
    : fail({
        _tag: 'DecimalInvalid',
        field,
        requirement,
        value,
        symbol: row.symbol,
        sessionDate: row.session_date,
      })
}

const toDailyBar = (
  row: SignalBarRow,
  publicationSchemaVersion: PublicationSchema,
): Result.Result<DailyBar, MarketDataVerificationError> =>
  pipe(
    Result.all({
      open: decimalNumber(row, 'adjusted_open', 'positive'),
      high: decimalNumber(row, 'adjusted_high', 'positive'),
      low: decimalNumber(row, 'adjusted_low', 'positive'),
      close: decimalNumber(row, 'adjusted_close', 'positive'),
      volume: decimalNumber(row, 'adjusted_volume', 'non-negative'),
    }),
    Result.flatMap(({ close, high, low, open, volume }) =>
      pipe(
        requireCondition(low <= Math.min(open, close) && high >= Math.max(open, close) && low <= high, {
          _tag: 'OhlcInvalid',
          symbol: row.symbol,
          sessionDate: row.session_date,
          open,
          high,
          low,
          close,
        }),
        Result.map(
          (): DailyBar => ({
            symbol: row.symbol,
            sessionDate: row.session_date,
            open,
            high,
            low,
            close,
            volume,
            source: row.provider,
            sourceFeed: row.source_feed,
            adjustment: row.adjustment,
            publicationSchemaVersion,
          }),
        ),
      ),
    ),
  )

const boundFields: readonly BoundField[] = ['dataStart', 'dataEnd', 'lookbackStart', 'evaluationStart', 'evaluationEnd']

const validateBoundSessions = (
  sessions: ReadonlySet<string>,
  bounds: EvaluationBounds,
): Result.Result<void, MarketDataVerificationError> =>
  validateAll(
    boundFields.map((field) =>
      requireCondition(sessions.has(bounds[field]), {
        _tag: 'BoundSessionMissing',
        field,
        value: bounds[field],
      }),
    ),
  )

interface VerifiedManifest {
  readonly manifest: SignalManifestRow
  readonly finalizedSnapshot: FinalizedSnapshotProvenance
  readonly universe: readonly string[]
}

const onlyManifest = (
  manifests: readonly SignalManifestRow[],
  request: SnapshotRequest,
): Result.Result<SignalManifestRow, MarketDataVerificationError> =>
  manifests.length === 1 && manifests[0] !== undefined
    ? Result.succeed(manifests[0])
    : fail({
        _tag: 'ManifestCountMismatch',
        snapshotId: request.snapshotId,
        count: manifests.length,
      })

const manifestMismatch = (
  field: ManifestField,
  expected: unknown,
  observed: unknown,
  snapshotId: string,
): MarketDataVerificationError => ({
  _tag: 'ManifestFieldMismatch',
  field,
  expected,
  observed,
  snapshotId,
})

const verifyManifest = (
  manifests: readonly SignalManifestRow[],
  request: SnapshotRequest,
): Result.Result<VerifiedManifest, MarketDataVerificationError> =>
  pipe(
    Result.all({
      universe: canonicalUniverse(request.universe),
      manifest: onlyManifest(manifests, request),
    }),
    Result.flatMap(({ manifest, universe }) => {
      const finalizedAt = toUtcInstant(manifest.finalized_at)
      const snapshotIdentity = {
        schemaVersion: manifest.schema_version,
        provider: manifest.provider,
        feed: manifest.source_feed,
        adjustment: manifest.adjustment,
        calendarVersion: manifest.calendar_version,
        requestedStart: manifest.requested_start,
        publicationAsOf: manifest.publication_asof,
        symbols: universe,
        barsContentHash: manifest.bars_content_hash,
        sessionsContentHash: manifest.sessions_content_hash,
      } as const
      return pipe(
        Result.all({
          expectedManifestHash: canonicalHashResult('manifest', request.snapshotId, withoutManifestHash(manifest)),
          expectedSnapshotId: canonicalHashResult('snapshot-identity', request.snapshotId, {
            ...snapshotIdentity,
            universeId: manifest.universe_id,
            universeSymbolHash: manifest.universe_symbol_hash,
          }),
        }),
        Result.flatMap(({ expectedManifestHash, expectedSnapshotId }) =>
          validateAll([
            requireCondition(
              manifest.snapshot_id === request.snapshotId,
              manifestMismatch('snapshotId', request.snapshotId, manifest.snapshot_id, request.snapshotId),
            ),
            requireCondition(
              manifest.calendar_version === request.calendarVersion,
              manifestMismatch(
                'calendarVersion',
                request.calendarVersion,
                manifest.calendar_version,
                request.snapshotId,
              ),
            ),
            requireCondition(
              manifest.publication_asof === request.publicationAsOf,
              manifestMismatch(
                'publicationAsOf',
                request.publicationAsOf,
                manifest.publication_asof,
                request.snapshotId,
              ),
            ),
            requireCondition(finalizedAt <= request.observedAt, {
              _tag: 'SnapshotFinalizedInFuture',
              snapshotId: request.snapshotId,
              finalizedAt,
              observedAt: request.observedAt,
            }),
            requireCondition(
              manifest.manifest_content_hash === expectedManifestHash,
              manifestMismatch(
                'manifestContentHash',
                expectedManifestHash,
                manifest.manifest_content_hash,
                request.snapshotId,
              ),
            ),
            requireCondition(
              manifest.symbol_count === universe.length,
              manifestMismatch('symbolCount', universe.length, manifest.symbol_count, request.snapshotId),
            ),
            requireCondition(manifest.bar_count === manifest.session_count * manifest.symbol_count, {
              _tag: 'ManifestCardinalityInvalid',
              snapshotId: request.snapshotId,
              symbolCount: manifest.symbol_count,
              sessionCount: manifest.session_count,
              barCount: manifest.bar_count,
            }),
            requireCondition(
              manifest.snapshot_id === expectedSnapshotId,
              manifestMismatch('snapshotId', expectedSnapshotId, manifest.snapshot_id, request.snapshotId),
            ),
            requireCondition(
              request.bounds.dataStart >= manifest.first_session && request.bounds.dataEnd <= manifest.last_session,
              manifestMismatch(
                'dataBounds',
                { firstSession: manifest.first_session, lastSession: manifest.last_session },
                { dataStart: request.bounds.dataStart, dataEnd: request.bounds.dataEnd },
                request.snapshotId,
              ),
            ),
            requireCondition(
              manifest.universe_id === request.universeId,
              manifestMismatch('universeId', request.universeId, manifest.universe_id, request.snapshotId),
            ),
            requireCondition(
              manifest.universe_symbol_hash === request.universeSymbolHash,
              manifestMismatch(
                'universeSymbolHash',
                request.universeSymbolHash,
                manifest.universe_symbol_hash,
                request.snapshotId,
              ),
            ),
            requireCondition(
              sha256(universe.join(',')) === request.universeSymbolHash,
              manifestMismatch(
                'universeSymbolHash',
                sha256(universe.join(',')),
                request.universeSymbolHash,
                request.snapshotId,
              ),
            ),
            requireCondition(
              manifest.requested_start === request.historyStart && manifest.first_session === request.historyStart,
              manifestMismatch(
                'historyStart',
                request.historyStart,
                { requestedStart: manifest.requested_start, firstSession: manifest.first_session },
                request.snapshotId,
              ),
            ),
            requireCondition(
              request.bounds.dataStart === request.historyStart &&
                request.bounds.lookbackStart === request.historyStart &&
                request.bounds.evaluationStart === request.evaluationStart,
              manifestMismatch(
                'evaluationBounds',
                { historyStart: request.historyStart, evaluationStart: request.evaluationStart },
                request.bounds,
                request.snapshotId,
              ),
            ),
            requireCondition(
              request.bounds.dataEnd === request.publicationAsOf &&
                request.bounds.evaluationEnd === request.publicationAsOf,
              manifestMismatch(
                'evaluationBounds',
                { publicationAsOf: request.publicationAsOf },
                request.bounds,
                request.snapshotId,
              ),
            ),
          ]),
        ),
        Result.flatMap(() => {
          const commonSnapshot = {
            snapshotId: manifest.snapshot_id,
            publicationId: manifest.manifest_content_hash,
            publicationSchemaVersion: manifest.schema_version,
            source: manifest.provider,
            sourceFeed: manifest.source_feed,
            adjustment: manifest.adjustment,
            calendarVersion: manifest.calendar_version,
            publisherSourceRevision: manifest.publisher_source_revision,
            publisherImage: {
              repository: manifest.publisher_image_repository,
              digest: manifest.publisher_image_digest,
            },
            finalizedAt,
            requestedStart: manifest.requested_start,
            firstSession: manifest.first_session,
            lastSession: manifest.last_session,
            asOfSession: manifest.publication_asof,
            symbols: universe,
            rowCount: manifest.bar_count,
            sessionCount: manifest.session_count,
            contentHash: manifest.bars_content_hash,
            sessionsContentHash: manifest.sessions_content_hash,
          } as const
          return pipe(
            Schema.decodeUnknownResult(
              FinalizedSnapshotProvenanceSchema,
              strictParseOptions,
            )({
              schemaVersion: 'bayn.finalized-snapshot.v3',
              universeId: manifest.universe_id,
              universeSymbolHash: manifest.universe_symbol_hash,
              ...commonSnapshot,
            }),
            Result.mapError(
              (cause): MarketDataVerificationError => ({
                _tag: 'RowDecodeFailed',
                rows: 'finalized-snapshot',
                cause,
              }),
            ),
            Result.map((finalizedSnapshot) => ({ manifest, universe, finalizedSnapshot })),
          )
        }),
      )
    }),
  )

export const verifyFinalizedManifest = (
  manifests: readonly SignalManifestRow[],
  request: SnapshotRequest,
): Result.Result<FinalizedSnapshotProvenance, MarketDataVerificationError> =>
  pipe(
    verifyManifest(manifests, request),
    Result.map(({ finalizedSnapshot }) => finalizedSnapshot),
  )

interface VerifiedCalendar {
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

const verifyCalendar = (
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
              return pipe(
                canonicalHashResult('input-manifest', request.snapshotId, material),
                Result.map(
                  (hash): VerifiedCalendar => ({
                    verifiedManifest,
                    orderedSessions,
                    boundedSessions,
                    inputManifest: { ...material, hash },
                  }),
                ),
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
            } satisfies VerifiedSignalSession,
          })
    }),
  )

export const verifyFinalizedPublication = (
  rows: Pick<SnapshotRows, 'sessions' | 'manifests'>,
  input: FinalizedPublicationRequest,
  contract: MarketDataContract,
  observedAt: string,
): Result.Result<MarketDataInspection | undefined, MarketDataVerificationError> => {
  const manifests = rows.manifests.filter((manifest) => manifest.calendar_version === input.signalCalendarVersion)
  if (manifests.length === 0) return Result.succeed(undefined)
  return manifests.length !== 1 || manifests[0] === undefined
    ? fail({
        _tag: 'PublicationManifestCountMismatch',
        signalSessionDate: input.signalSessionDate,
        calendarVersion: input.signalCalendarVersion,
        count: manifests.length,
      })
    : verifyFinalizedCalendar(
        { sessions: rows.sessions, manifests },
        {
          snapshotId: manifests[0].snapshot_id,
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
        },
      )
}

const barMismatch = (
  field: BarField,
  expected: unknown,
  observed: unknown,
  snapshotId: string,
  symbol: string | null,
  sessionDate: string | null,
): MarketDataVerificationError => ({
  _tag: 'BarFieldMismatch',
  field,
  expected,
  observed,
  snapshotId,
  symbol,
  sessionDate,
})

const validateBar = (
  bar: SignalBarRow,
  manifest: SignalManifestRow,
  request: SnapshotRequest,
  sessionDates: ReadonlySet<string>,
): Result.Result<void, MarketDataVerificationError> =>
  validateAll([
    requireCondition(
      bar.snapshot_id === request.snapshotId,
      barMismatch('snapshotId', request.snapshotId, bar.snapshot_id, request.snapshotId, bar.symbol, bar.session_date),
    ),
    requireCondition(
      bar.provider === manifest.provider &&
        bar.source_feed === manifest.source_feed &&
        bar.adjustment === manifest.adjustment,
      barMismatch(
        'provenance',
        { provider: manifest.provider, sourceFeed: manifest.source_feed, adjustment: manifest.adjustment },
        { provider: bar.provider, sourceFeed: bar.source_feed, adjustment: bar.adjustment },
        request.snapshotId,
        bar.symbol,
        bar.session_date,
      ),
    ),
    requireCondition(
      bar.publication_asof === manifest.publication_asof,
      barMismatch(
        'publicationAsOf',
        manifest.publication_asof,
        bar.publication_asof,
        request.snapshotId,
        bar.symbol,
        bar.session_date,
      ),
    ),
    requireCondition(sessionDates.has(bar.session_date), {
      _tag: 'BarOutsideCalendar',
      snapshotId: request.snapshotId,
      symbol: bar.symbol,
      sessionDate: bar.session_date,
    }),
  ])

export const verifyFinalizedSnapshot = (
  rows: SnapshotRows,
  request: SnapshotRequest,
): Result.Result<MarketDataSnapshot, MarketDataVerificationError> =>
  pipe(
    verifyCalendar(rows.sessions, rows.manifests, request),
    Result.flatMap((calendar) => {
      const { manifest, universe } = calendar.verifiedManifest
      const sessionDates = new Set(calendar.orderedSessions.map((session) => session.session_date))
      const orderedBars = [...rows.bars].sort((left, right) =>
        left.session_date === right.session_date
          ? left.symbol.localeCompare(right.symbol)
          : left.session_date.localeCompare(right.session_date),
      )
      const barKey = (bar: SignalBarRow): string => `${bar.symbol}\u001f${bar.session_date}`
      const duplicate = orderedBars.find(
        (bar, index) => index > 0 && barKey(orderedBars[index - 1] as SignalBarRow) === barKey(bar),
      )
      const barKeys = new Set(orderedBars.map(barKey))
      const actualSymbols = [...new Set(orderedBars.map((bar) => bar.symbol))].sort()
      const missingCells = calendar.orderedSessions.flatMap((session) =>
        universe
          .filter((symbol) => !barKeys.has(`${symbol}\u001f${session.session_date}`))
          .map((symbol) => ({ symbol, sessionDate: session.session_date })),
      )
      const boundedSessionDates = new Set(calendar.boundedSessions.map((session) => session.session_date))
      const boundedRows = orderedBars.filter((bar) => boundedSessionDates.has(bar.session_date))
      return pipe(
        canonicalHashResult('bars', request.snapshotId, orderedBars.map(withoutSnapshot)),
        Result.flatMap((barsContentHash) =>
          validateAll([
            ...orderedBars.map((bar) => validateBar(bar, manifest, request, sessionDates)),
            requireCondition(duplicate === undefined, {
              _tag: 'DuplicateBar',
              snapshotId: request.snapshotId,
              symbol: duplicate?.symbol ?? '',
              sessionDate: duplicate?.session_date ?? '',
            }),
            requireCondition(
              orderedBars.length === manifest.bar_count,
              barMismatch('barCount', manifest.bar_count, orderedBars.length, request.snapshotId, null, null),
            ),
            requireCondition(
              actualSymbols.join(',') === universe.join(','),
              barMismatch('universe', universe, actualSymbols, request.snapshotId, null, null),
            ),
            ...missingCells.map(({ sessionDate, symbol }) =>
              fail<void>({
                _tag: 'SnapshotCellMissing',
                snapshotId: request.snapshotId,
                symbol,
                sessionDate,
              }),
            ),
            requireCondition(
              barsContentHash === manifest.bars_content_hash,
              barMismatch(
                'barsContentHash',
                manifest.bars_content_hash,
                barsContentHash,
                request.snapshotId,
                null,
                null,
              ),
            ),
            requireCondition(
              boundedRows.length === calendar.inputManifest.rowCount,
              barMismatch(
                'boundedBarCount',
                calendar.inputManifest.rowCount,
                boundedRows.length,
                request.snapshotId,
                null,
                null,
              ),
            ),
          ]),
        ),
        Result.flatMap(() => Result.all(boundedRows.map((row) => toDailyBar(row, manifest.schema_version)))),
        Result.map((bars) => ({ bars, manifest: calendar.inputManifest })),
      )
    }),
  )

export const selectPublicationManifest = (
  manifests: readonly SignalManifestRow[],
  expectedSnapshotId?: string,
): Result.Result<SignalManifestRow | undefined, MarketDataVerificationError> => {
  const observedSnapshotIds = manifests.map((manifest) => manifest.snapshot_id)
  return expectedSnapshotId !== undefined && observedSnapshotIds.some((snapshotId) => snapshotId !== expectedSnapshotId)
    ? fail({
        _tag: 'BoundSnapshotMismatch',
        phase: 'manifest-query',
        expectedSnapshotId,
        observedSnapshotIds,
      })
    : Result.succeed(manifests[0])
}

export const verifyBoundFinalizedPublication = (
  rows: Pick<SnapshotRows, 'sessions' | 'manifests'>,
  input: FinalizedPublicationRequest,
  contract: MarketDataContract,
  observedAt: string,
  expectedSnapshotId?: string,
): Result.Result<MarketDataInspection, MarketDataVerificationError> =>
  pipe(
    verifyFinalizedPublication(rows, input, contract, observedAt),
    Result.flatMap((inspection) =>
      inspection === undefined
        ? fail({
            _tag: 'PublicationVerificationMissing',
            snapshotId: expectedSnapshotId ?? rows.manifests[0]?.snapshot_id ?? 'unknown',
            publicationAsOf: input.signalSessionDate,
            calendarVersion: input.signalCalendarVersion,
          })
        : expectedSnapshotId !== undefined && inspection.manifest.finalizedSnapshot.snapshotId !== expectedSnapshotId
          ? fail({
              _tag: 'BoundSnapshotMismatch',
              phase: 'publication-verification',
              expectedSnapshotId,
              observedSnapshotIds: [inspection.manifest.finalizedSnapshot.snapshotId],
            })
          : Result.succeed(inspection),
    ),
  )

export const selectCyclePublicationManifests = (
  manifests: readonly SignalManifestRow[],
  maximum: number,
): Result.Result<readonly SignalManifestRow[], MarketDataVerificationError> => {
  const ordered = [...manifests].sort((left, right) =>
    left.publication_asof !== right.publication_asof
      ? right.publication_asof.localeCompare(left.publication_asof)
      : left.finalized_at !== right.finalized_at
        ? right.finalized_at.localeCompare(left.finalized_at)
        : right.snapshot_id.localeCompare(left.snapshot_id),
  )
  const duplicate = ordered.find(
    (manifest, index) => index > 0 && ordered[index - 1]?.publication_asof === manifest.publication_asof,
  )
  return manifests.length > maximum
    ? fail({ _tag: 'CyclePublicationCountExceeded', maximum, observed: manifests.length })
    : duplicate !== undefined
      ? fail({
          _tag: 'DuplicatePublicationDate',
          publicationAsOf: duplicate.publication_asof,
          snapshotIds: ordered
            .filter((manifest) => manifest.publication_asof === duplicate.publication_asof)
            .map((manifest) => manifest.snapshot_id),
        })
      : Result.succeed(ordered)
}

export const verifyCyclePublications = (
  manifests: readonly SignalManifestRow[],
  sessions: readonly SignalSessionRow[],
  contract: MarketDataContract,
  observedAt: string,
): Result.Result<readonly MarketDataInspection[], MarketDataVerificationError> => {
  const expectedSnapshotIds = new Set(manifests.map((manifest) => manifest.snapshot_id))
  const unexpectedSnapshotIds = [
    ...new Set(
      sessions.filter((session) => !expectedSnapshotIds.has(session.snapshot_id)).map((session) => session.snapshot_id),
    ),
  ].sort()
  return unexpectedSnapshotIds.length > 0
    ? fail({
        _tag: 'BoundSnapshotMismatch',
        phase: 'session-query',
        expectedSnapshotId: manifests.map((manifest) => manifest.snapshot_id).join(','),
        observedSnapshotIds: unexpectedSnapshotIds,
      })
    : Result.all(
        manifests.map((manifest) =>
          verifyBoundFinalizedPublication(
            {
              manifests: [manifest],
              sessions: sessions.filter((session) => session.snapshot_id === manifest.snapshot_id),
            },
            {
              signalSessionDate: manifest.publication_asof,
              signalCalendarVersion: manifest.calendar_version,
            },
            contract,
            observedAt,
            manifest.snapshot_id,
          ),
        ),
      )
}

export const renderMarketDataVerificationError = (error: MarketDataVerificationError): string => {
  const renderFact = (value: unknown): string =>
    pipe(
      Result.try(() => (typeof value === 'string' ? value : JSON.stringify(value))),
      Result.getOrElse(() => '[unrenderable]'),
    )

  switch (error._tag) {
    case 'RowDecodeFailed':
      return `failed to decode Signal ${error.rows}`
    case 'CountInvalid':
      return `${error.field} is not a safe non-negative integer: ${String(error.value)}`
    case 'UniverseInvalid':
      return `evaluation universe is ${error.reason}: ${error.universe.join(',')}`
    case 'DecimalInvalid':
      return `${error.symbol} ${error.sessionDate} ${error.field} must be finite and ${error.requirement}: ${error.value}`
    case 'OhlcInvalid':
      return `${error.symbol} ${error.sessionDate} has invalid OHLC: open=${error.open} high=${error.high} low=${error.low} close=${error.close}`
    case 'BoundSessionMissing':
      return `${error.field} ${error.value} is not an exchange session in the snapshot`
    case 'ManifestCountMismatch':
      return `snapshot ${error.snapshotId} has ${error.count} manifests; expected exactly one`
    case 'ManifestFieldMismatch':
      return `snapshot ${error.snapshotId} manifest ${error.field} mismatch: expected=${renderFact(error.expected)} observed=${renderFact(error.observed)}`
    case 'SnapshotFinalizedInFuture':
      return `snapshot ${error.snapshotId} finalized at ${error.finalizedAt} after observation ${error.observedAt}`
    case 'ManifestCardinalityInvalid':
      return `snapshot ${error.snapshotId} cardinality is invalid: symbols=${error.symbolCount} sessions=${error.sessionCount} bars=${error.barCount}`
    case 'CanonicalizationFailed':
      return `snapshot ${error.snapshotId} ${error.target} canonicalization failed`
    case 'SessionFieldMismatch':
      return `snapshot ${error.snapshotId} session ${error.sessionDate ?? 'summary'} ${error.field} mismatch: expected=${renderFact(error.expected)} observed=${renderFact(error.observed)}`
    case 'SessionHoursInvalid':
      return `snapshot ${error.snapshotId} session ${error.sessionDate} has invalid hours ${error.openTime}-${error.closeTime}`
    case 'DuplicateSession':
      return `snapshot ${error.snapshotId} duplicates session ${error.sessionDate}`
    case 'BoundedSessionsEmpty':
      return `snapshot ${error.snapshotId} has no sessions in ${error.dataStart}..${error.dataEnd}`
    case 'SignalSessionMissing':
      return `snapshot ${error.snapshotId} has no terminal Signal session`
    case 'PublicationManifestCountMismatch':
      return `Signal session ${error.signalSessionDate} calendar ${error.calendarVersion} has ${error.count} manifests; expected one`
    case 'BoundSnapshotMismatch':
      return `bound snapshot ${error.expectedSnapshotId} mismatched during ${error.phase}: ${error.observedSnapshotIds.join(',')}`
    case 'CyclePublicationCountExceeded':
      return `cycle publication discovery returned ${error.observed} manifests; expected at most ${error.maximum}`
    case 'DuplicatePublicationDate':
      return `cycle publication ${error.publicationAsOf} has duplicate snapshots ${error.snapshotIds.join(',')}`
    case 'PublicationVerificationMissing':
      return `snapshot ${error.snapshotId} publication ${error.publicationAsOf}/${error.calendarVersion} disappeared during verification`
    case 'BarFieldMismatch':
      return `snapshot ${error.snapshotId} bar ${error.symbol ?? 'summary'} ${error.sessionDate ?? ''} ${error.field} mismatch: expected=${renderFact(error.expected)} observed=${renderFact(error.observed)}`
    case 'BarOutsideCalendar':
      return `snapshot ${error.snapshotId} bar ${error.symbol} ${error.sessionDate} is outside the calendar`
    case 'DuplicateBar':
      return `snapshot ${error.snapshotId} duplicates bar ${error.symbol} ${error.sessionDate}`
    case 'SnapshotCellMissing':
      return `snapshot ${error.snapshotId} is missing ${error.symbol} ${error.sessionDate}`
  }
}
