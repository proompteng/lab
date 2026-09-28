import { parseArgs } from 'node:util'

import { Clock, DateTime, Effect } from 'effect'
import { HttpClient } from 'effect/unstable/http'

import { fetchBars, fetchCalendar } from './alpaca'
import type { PublisherConfig } from './config'
import {
  buildPublication,
  calendarTimeZone,
  isIsoDate,
  missingRows,
  verifyPublication,
  type AlpacaCalendarSession,
  type BarRow,
  type IsoDate,
  type Publication,
  type SessionRow,
} from './domain'
import { publicationError, type PublicationError } from './errors'
import type { SnapshotRepository } from './repository'

type PublicationArguments =
  | { readonly mode: 'daily' }
  | { readonly mode: 'backfill'; readonly start: IsoDate; readonly end: IsoDate }

interface PublicationResult {
  readonly snapshotId: string
  readonly reused: boolean
  readonly barCount: number
  readonly sessionCount: number
  readonly publicationAsOf: IsoDate
}

const isoDate = (value: string | undefined, name: string): IsoDate => {
  if (!value || !isIsoDate(value)) {
    throw new Error(`${name} must be a valid ISO date (YYYY-MM-DD)`)
  }
  return value as IsoDate
}

export const parsePublicationArguments = (argv: readonly string[]): PublicationArguments => {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      start: { type: 'string' },
      end: { type: 'string' },
    },
  })
  if (parsed.positionals.length !== 1)
    throw new Error('usage: signal-publisher daily | backfill --start DATE --end DATE')
  const mode = parsed.positionals[0]
  if (mode === 'daily') {
    if (parsed.values.start || parsed.values.end) throw new Error('daily mode does not accept --start or --end')
    return { mode }
  }
  if (mode !== 'backfill') throw new Error(`unsupported publication mode: ${mode}`)
  const start = isoDate(parsed.values.start, '--start')
  const end = isoDate(parsed.values.end, '--end')
  if (start > end) throw new Error('--start must not be after --end')
  return { mode, start, end }
}

const newYorkParts = (epochMillis: number): { readonly date: IsoDate; readonly minuteOfDay: number } => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMillis))
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? ''
  return {
    date: `${value('year')}-${value('month')}-${value('day')}` as IsoDate,
    minuteOfDay: Number(value('hour')) * 60 + Number(value('minute')),
  }
}

const sessionCloseEpochMillis = (session: AlpacaCalendarSession): number => {
  const [year, month, day] = session.date.split('-').map(Number)
  const [hour, minute] = session.close.split(':').map(Number)
  return DateTime.makeZonedUnsafe(
    { year, month, day, hour, minute },
    {
      timeZone: calendarTimeZone,
      adjustForTimeZone: true,
      disambiguation: 'reject',
    },
  ).pipe(DateTime.toEpochMillis)
}

export const isFinalizable = (session: AlpacaCalendarSession, epochMillis: number, lagMinutes: number): boolean => {
  const finalizationEpochMillis = sessionCloseEpochMillis(session) + lagMinutes * 60_000
  return epochMillis >= finalizationEpochMillis
}

export const latestFinalizableSession = (
  calendar: readonly AlpacaCalendarSession[],
  epochMillis: number,
  lagMinutes: number,
): IsoDate | undefined =>
  calendar.reduce<IsoDate | undefined>(
    (latest, session) =>
      isFinalizable(session, epochMillis, lagMinutes) && (latest === undefined || session.date > latest)
        ? session.date
        : latest,
    undefined,
  )

const clickhouseTimestamp = (epochMillis: number): string =>
  new Date(epochMillis).toISOString().replace('T', ' ').replace('Z', '')

const basicHistoricalDataDelayMs = 15 * 60 * 1_000

export const historicalBarsQueryEnd = (publicationAsOf: IsoDate, epochMillis: number): string => {
  const sessionDateEnd = Date.parse(`${publicationAsOf}T23:59:59.999Z`)
  return new Date(Math.min(sessionDateEnd, epochMillis - basicHistoricalDataDelayMs)).toISOString()
}

const loadPublication = (
  config: PublisherConfig,
  args: PublicationArguments,
  epochMillis: number,
): Effect.Effect<Publication, PublicationError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const today = newYorkParts(epochMillis).date
    const requestedStart = args.mode === 'backfill' ? args.start : config.startDate
    const requestedCalendarEnd = args.mode === 'backfill' ? args.end : today
    const calendar = yield* fetchCalendar(config, requestedStart, requestedCalendarEnd)
    const publicationAsOf =
      args.mode === 'backfill'
        ? args.end
        : latestFinalizableSession(calendar, epochMillis, config.finalizationLagMinutes)
    if (publicationAsOf === undefined) {
      return yield* Effect.fail(
        publicationError('validation', 'calendar has no finalized exchange session in the requested range'),
      )
    }
    const finalSession = calendar.find((session) => session.date === publicationAsOf)
    if (!finalSession) {
      return yield* Effect.fail(
        publicationError('validation', `publication end ${publicationAsOf} is not an exchange session`),
      )
    }
    if (!isFinalizable(finalSession, epochMillis, config.finalizationLagMinutes)) {
      return yield* Effect.fail(
        publicationError('validation', `exchange session ${publicationAsOf} is not finalized yet`),
      )
    }
    const boundedCalendar = calendar.filter((session) => session.date <= publicationAsOf)
    const barsBySymbol = yield* fetchBars(
      config,
      requestedStart,
      publicationAsOf,
      historicalBarsQueryEnd(publicationAsOf, epochMillis),
    )
    return yield* Effect.try({
      try: () =>
        buildPublication({
          barsBySymbol,
          calendar: boundedCalendar,
          symbols: config.symbols,
          universeId: config.universe.id,
          universeSymbolHash: config.universe.symbolHash,
          feed: config.alpaca.feed,
          calendarVersion: config.calendarVersion,
          requestedStart,
          publicationAsOf,
          finalizedAt: clickhouseTimestamp(epochMillis),
          provenance: config.provenance,
        }),
      catch: (cause) => publicationError('validation', 'snapshot validation failed', cause),
    })
  })

const barKey = (row: BarRow): string => `${row.symbol}\u001f${row.session_date}`
const sessionKey = (row: SessionRow): string => row.session_date

export const persistPublication = (
  repository: SnapshotRepository,
  publication: Publication,
): Effect.Effect<PublicationResult, PublicationError> =>
  Effect.gen(function* () {
    const snapshotId = publication.manifest.snapshot_id
    const existingManifests = yield* repository.loadManifests(snapshotId)
    if (existingManifests.length > 1) {
      return yield* Effect.fail(publicationError('finalization', `snapshot ${snapshotId} has duplicate manifest rows`))
    }
    const existingBars = yield* repository.loadBars(snapshotId)
    const existingSessions = yield* repository.loadSessions(snapshotId)

    if (existingManifests.length === 1) {
      const storedManifest = existingManifests[0]
      const expectedWithStoredFinalization: Publication = {
        ...publication,
        manifest: {
          ...publication.manifest,
          publisher_source_revision: storedManifest.publisher_source_revision,
          publisher_image_repository: storedManifest.publisher_image_repository,
          publisher_image_digest: storedManifest.publisher_image_digest,
          finalized_at: storedManifest.finalized_at,
          manifest_content_hash: storedManifest.manifest_content_hash,
        },
      }
      yield* Effect.try({
        try: () => verifyPublication(expectedWithStoredFinalization, existingBars, existingSessions, existingManifests),
        catch: (cause) => publicationError('finalization', 'finalized snapshot verification failed', cause),
      })
      return {
        snapshotId,
        reused: true,
        barCount: publication.bars.length,
        sessionCount: publication.sessions.length,
        publicationAsOf: publication.manifest.publication_asof,
      }
    }

    const barsToInsert = yield* Effect.try({
      try: () => missingRows(publication.bars, existingBars, barKey),
      catch: (cause) => publicationError('storage', 'staged bar verification failed', cause),
    })
    const sessionsToInsert = yield* Effect.try({
      try: () => missingRows(publication.sessions, existingSessions, sessionKey),
      catch: (cause) => publicationError('storage', 'staged session verification failed', cause),
    })
    yield* repository.insertBars(snapshotId, barsToInsert)
    yield* repository.insertSessions(snapshotId, sessionsToInsert)

    const stagedBars = yield* repository.loadBars(snapshotId)
    const stagedSessions = yield* repository.loadSessions(snapshotId)
    yield* Effect.try({
      try: () => {
        if (
          missingRows(publication.bars, stagedBars, barKey).length !== 0 ||
          stagedBars.length !== publication.bars.length
        ) {
          throw new Error('staged bars are incomplete')
        }
        if (
          missingRows(publication.sessions, stagedSessions, sessionKey).length !== 0 ||
          stagedSessions.length !== publication.sessions.length
        ) {
          throw new Error('staged exchange sessions are incomplete')
        }
      },
      catch: (cause) => publicationError('storage', 'staged snapshot readback failed', cause),
    })

    yield* repository.insertManifest(publication.manifest)
    const finalizedManifests = yield* repository.loadManifests(snapshotId)
    const finalizedBars = yield* repository.loadBars(snapshotId)
    const finalizedSessions = yield* repository.loadSessions(snapshotId)
    yield* Effect.try({
      try: () => verifyPublication(publication, finalizedBars, finalizedSessions, finalizedManifests),
      catch: (cause) => publicationError('finalization', 'finalized snapshot readback failed', cause),
    })
    return {
      snapshotId,
      reused: false,
      barCount: publication.bars.length,
      sessionCount: publication.sessions.length,
      publicationAsOf: publication.manifest.publication_asof,
    }
  })

export const publish = (
  config: PublisherConfig,
  args: PublicationArguments,
  repository: SnapshotRepository,
): Effect.Effect<PublicationResult, PublicationError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const epochMillis = yield* Clock.currentTimeMillis
    const publication = yield* loadPublication(config, args, epochMillis)
    yield* Effect.logInfo('Signal snapshot validated').pipe(
      Effect.annotateLogs({
        snapshotId: publication.manifest.snapshot_id,
        universeId: publication.manifest.universe_id,
        universeSymbolHash: publication.manifest.universe_symbol_hash,
        publicationAsOf: publication.manifest.publication_asof,
        barCount: publication.manifest.bar_count,
        sessionCount: publication.manifest.session_count,
      }),
    )
    const result = yield* persistPublication(repository, publication)
    yield* Effect.logInfo('Signal snapshot finalized').pipe(
      Effect.annotateLogs({
        snapshotId: result.snapshotId,
        universeId: config.universe.id,
        universeSymbolHash: config.universe.symbolHash,
        publicationAsOf: result.publicationAsOf,
        reused: result.reused,
        barCount: result.barCount,
        sessionCount: result.sessionCount,
      }),
    )
    return result
  })
