import { pipe, Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { AlignedSession } from '../simulation'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'
import {
  CANDIDATE_7_DEVELOPMENT_END,
  CANDIDATE_7_HISTORY_START,
  CANDIDATE_7_UNIVERSE,
  candidate7DatasetIdentity,
  type Candidate7DevelopmentDataset,
  type Candidate7DevelopmentSession,
  type Candidate7Failure,
  type Candidate7Symbol,
} from './model'

const fail = <A>(failure: Candidate7Failure): Result.Result<A, Candidate7Failure> => Result.fail(failure)

const exactIdentity = (
  field: keyof typeof candidate7DatasetIdentity,
  observed: unknown,
): Result.Result<void, Candidate7Failure> => {
  const expected = candidate7DatasetIdentity[field]
  return observed === expected
    ? Result.succeed(undefined)
    : fail({ _tag: 'Candidate7DatasetMismatch', field, expected, observed })
}

const validIsoDate = (value: string): value is IsoDate => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const validateSession = (
  session: Candidate7DevelopmentSession,
): Result.Result<Candidate7DevelopmentSession, Candidate7Failure> => {
  if (!validIsoDate(session.sessionDate)) {
    return fail({ _tag: 'Candidate7InvalidSession', reason: 'invalid ISO date' })
  }
  if (session.snapshotId !== candidate7DatasetIdentity.snapshotId) {
    return fail({
      _tag: 'Candidate7InvalidSession',
      reason: 'snapshot identity mismatch',
      sessionDate: session.sessionDate,
    })
  }
  if (session.calendarVersion !== candidate7DatasetIdentity.calendarVersion) {
    return fail({
      _tag: 'Candidate7InvalidSession',
      reason: 'calendar version mismatch',
      sessionDate: session.sessionDate,
    })
  }
  if (
    session.provider !== DataSource.Alpaca ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(session.openTime) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(session.closeTime) ||
    session.openTime >= session.closeTime ||
    session.timezone.length === 0
  ) {
    return fail({
      _tag: 'Candidate7InvalidSession',
      reason: 'invalid official session contract',
      sessionDate: session.sessionDate,
    })
  }
  return session.sessionDate >= CANDIDATE_7_HISTORY_START && session.sessionDate <= CANDIDATE_7_DEVELOPMENT_END
    ? Result.succeed(session)
    : fail({
        _tag: 'Candidate7InvalidSession',
        reason: 'session crosses frozen development boundary',
        sessionDate: session.sessionDate,
      })
}

const validateBar = (bar: DailyBar): Result.Result<DailyBar, Candidate7Failure> => {
  if (!validIsoDate(bar.sessionDate)) {
    return fail({ _tag: 'Candidate7InvalidBar', reason: 'invalid ISO date', symbol: bar.symbol })
  }
  if (!CANDIDATE_7_UNIVERSE.includes(bar.symbol as Candidate7Symbol)) {
    return fail({
      _tag: 'Candidate7InvalidBar',
      reason: 'symbol is outside the source-controlled universe',
      symbol: bar.symbol,
      sessionDate: bar.sessionDate,
    })
  }
  if (bar.sessionDate < CANDIDATE_7_HISTORY_START || bar.sessionDate > CANDIDATE_7_DEVELOPMENT_END) {
    return fail({
      _tag: 'Candidate7InvalidBar',
      reason: 'bar crosses frozen development boundary',
      symbol: bar.symbol,
      sessionDate: bar.sessionDate,
    })
  }
  for (const field of ['open', 'high', 'low', 'close'] as const) {
    if (!Number.isFinite(bar[field]) || bar[field] <= 0) {
      return fail({
        _tag: 'Candidate7InvalidBar',
        reason: `${field} must be finite and positive`,
        symbol: bar.symbol,
        sessionDate: bar.sessionDate,
      })
    }
  }
  if (
    !Number.isFinite(bar.volume) ||
    bar.volume < 0 ||
    bar.low > Math.min(bar.open, bar.close) ||
    bar.high < Math.max(bar.open, bar.close) ||
    bar.low > bar.high
  ) {
    return fail({
      _tag: 'Candidate7InvalidBar',
      reason: 'invalid volume or OHLC range',
      symbol: bar.symbol,
      sessionDate: bar.sessionDate,
    })
  }
  if (
    bar.source !== DataSource.Alpaca ||
    bar.sourceFeed !== DataFeed.Sip ||
    bar.adjustment !== PriceAdjustment.All ||
    bar.publicationSchemaVersion !== PublicationSchema.AdjustedDailySnapshotV2
  ) {
    return fail({
      _tag: 'Candidate7InvalidBar',
      reason: 'bar provenance does not match the frozen adjusted-daily contract',
      symbol: bar.symbol,
      sessionDate: bar.sessionDate,
    })
  }
  return Result.succeed(bar)
}

export const candidate7BoundedBarsContentHash = (bars: readonly DailyBar[]) =>
  canonicalHashV1Result(
    [...bars]
      .sort((left, right) =>
        left.sessionDate === right.sessionDate
          ? left.symbol.localeCompare(right.symbol)
          : left.sessionDate.localeCompare(right.sessionDate),
      )
      .map((bar) => ({
        symbol: bar.symbol,
        sessionDate: bar.sessionDate,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        source: bar.source,
        sourceFeed: bar.sourceFeed,
        adjustment: bar.adjustment,
        publicationSchemaVersion: bar.publicationSchemaVersion,
      })),
  )

export const candidate7BoundedSessionsContentHash = (sessions: readonly Candidate7DevelopmentSession[]) =>
  canonicalHashV1Result(
    [...sessions]
      .sort((left, right) => left.sessionDate.localeCompare(right.sessionDate))
      .map((session) => ({
        snapshotId: session.snapshotId,
        calendarVersion: session.calendarVersion,
        sessionDate: session.sessionDate,
        openTime: session.openTime,
        closeTime: session.closeTime,
        timezone: session.timezone,
        provider: session.provider,
      })),
  )

const validateContentHashes = (dataset: Candidate7DevelopmentDataset): Result.Result<void, Candidate7Failure> =>
  pipe(
    Result.all({
      bars: pipe(
        candidate7BoundedBarsContentHash(dataset.bars),
        Result.mapError(
          (cause): Candidate7Failure => ({ _tag: 'Candidate7HashFailure', operation: 'bounded-bars', cause }),
        ),
      ),
      sessions: pipe(
        candidate7BoundedSessionsContentHash(dataset.sessions),
        Result.mapError(
          (cause): Candidate7Failure => ({ _tag: 'Candidate7HashFailure', operation: 'bounded-sessions', cause }),
        ),
      ),
    }),
    Result.flatMap(({ bars, sessions }) =>
      bars !== candidate7DatasetIdentity.boundedBarsContentHash
        ? fail({
            _tag: 'Candidate7DatasetMismatch',
            field: 'computedBoundedBarsContentHash',
            expected: candidate7DatasetIdentity.boundedBarsContentHash,
            observed: bars,
          })
        : sessions !== candidate7DatasetIdentity.boundedSessionsContentHash
          ? fail({
              _tag: 'Candidate7DatasetMismatch',
              field: 'computedBoundedSessionsContentHash',
              expected: candidate7DatasetIdentity.boundedSessionsContentHash,
              observed: sessions,
            })
          : Result.succeed(undefined),
    ),
  )

export const prepareCandidate7Sessions = (
  dataset: Candidate7DevelopmentDataset,
): Result.Result<readonly AlignedSession[], Candidate7Failure> => {
  const identity = Result.all([
    exactIdentity('snapshotId', dataset.snapshotId),
    exactIdentity('publicationAsOf', dataset.publicationAsOf),
    exactIdentity('calendarVersion', dataset.calendarVersion),
    exactIdentity('manifestContentHash', dataset.manifestContentHash),
    exactIdentity('rawManifestExportSha256', dataset.rawManifestExportSha256),
    exactIdentity('rawBarsExportSha256', dataset.rawBarsExportSha256),
    exactIdentity('rawSessionsExportSha256', dataset.rawSessionsExportSha256),
    exactIdentity('boundedBarsContentHash', dataset.boundedBarsContentHash),
    exactIdentity('boundedSessionsContentHash', dataset.boundedSessionsContentHash),
  ])
  if (Result.isFailure(identity)) return fail(identity.failure)
  if (dataset.sessions.length !== candidate7DatasetIdentity.officialSessionCount) {
    return fail({
      _tag: 'Candidate7DatasetMismatch',
      field: 'officialSessionCount',
      expected: candidate7DatasetIdentity.officialSessionCount,
      observed: dataset.sessions.length,
    })
  }
  if (dataset.bars.length !== candidate7DatasetIdentity.officialSessionCount * CANDIDATE_7_UNIVERSE.length) {
    return fail({
      _tag: 'Candidate7DatasetMismatch',
      field: 'barCount',
      expected: candidate7DatasetIdentity.officialSessionCount * CANDIDATE_7_UNIVERSE.length,
      observed: dataset.bars.length,
    })
  }
  const sessions = [...dataset.sessions].sort((left, right) => left.sessionDate.localeCompare(right.sessionDate))
  const dates = new Set<IsoDate>()
  for (const session of sessions) {
    const validated = validateSession(session)
    if (Result.isFailure(validated)) return fail(validated.failure)
    if (dates.has(session.sessionDate)) {
      return fail({
        _tag: 'Candidate7InvalidSession',
        reason: 'duplicate official session',
        sessionDate: session.sessionDate,
      })
    }
    dates.add(session.sessionDate)
  }
  if (
    sessions.at(0)?.sessionDate !== CANDIDATE_7_HISTORY_START ||
    sessions.at(-1)?.sessionDate !== CANDIDATE_7_DEVELOPMENT_END
  ) {
    return fail({
      _tag: 'Candidate7InvalidSession',
      reason: 'official calendar does not match frozen boundaries',
    })
  }
  const barsBySession = new Map<IsoDate, Map<Candidate7Symbol, DailyBar>>()
  for (const bar of dataset.bars) {
    const validated = validateBar(bar)
    if (Result.isFailure(validated)) return fail(validated.failure)
    if (!dates.has(bar.sessionDate)) {
      return fail({
        _tag: 'Candidate7InvalidBar',
        reason: 'bar is outside the official development calendar',
        symbol: bar.symbol,
        sessionDate: bar.sessionDate,
      })
    }
    const symbol = bar.symbol as Candidate7Symbol
    const sessionBars = barsBySession.get(bar.sessionDate) ?? new Map<Candidate7Symbol, DailyBar>()
    if (sessionBars.has(symbol)) {
      return fail({
        _tag: 'Candidate7InvalidBar',
        reason: 'duplicate symbol/session bar',
        symbol,
        sessionDate: bar.sessionDate,
      })
    }
    sessionBars.set(symbol, bar)
    barsBySession.set(bar.sessionDate, sessionBars)
  }
  const aligned: AlignedSession[] = []
  for (const session of sessions) {
    const sessionBars = barsBySession.get(session.sessionDate)
    if (sessionBars === undefined || sessionBars.size !== CANDIDATE_7_UNIVERSE.length) {
      return fail({
        _tag: 'Candidate7InvalidSession',
        reason: 'session lacks exact universe coverage',
        sessionDate: session.sessionDate,
      })
    }
    const entries: [Candidate7Symbol, DailyBar][] = []
    for (const symbol of CANDIDATE_7_UNIVERSE) {
      const bar = sessionBars.get(symbol)
      if (bar === undefined) return fail({ _tag: 'Candidate7MissingBar', symbol, sessionDate: session.sessionDate })
      entries.push([symbol, bar])
    }
    aligned.push({ date: session.sessionDate, bars: Object.fromEntries(entries) })
  }
  return pipe(
    validateContentHashes(dataset),
    Result.map(() => aligned),
  )
}
