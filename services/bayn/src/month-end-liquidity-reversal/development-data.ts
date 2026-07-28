import { Result } from 'effect'

import { sha256 } from '../hash'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'
import {
  candidate6DataFail,
  candidate6FiniteNumber,
  candidate6IsoDate,
  candidate6SessionTime,
  parseCandidate6CsvBody,
  parseCandidate6DevelopmentManifestCsv,
  type Candidate6DataResult,
} from './development-input'
import type { Candidate6DevelopmentDataset, Candidate6DevelopmentManifest, Candidate6DevelopmentSession } from './model'

export type { Candidate6DevelopmentDataFailure } from './development-input'

const EXPECTED_BARS_HEADER = [
  'snapshot_id',
  'symbol',
  'toString(session_date)',
  'toString(adjusted_open)',
  'toString(adjusted_high)',
  'toString(adjusted_low)',
  'toString(adjusted_close)',
  'toString(adjusted_volume)',
  'provider',
  'source_feed',
  'adjustment',
  'toString(publication_asof)',
] as const

const EXPECTED_SESSIONS_HEADER = [
  'snapshot_id',
  'calendar_version',
  'session_date',
  'open_time',
  'close_time',
  'timezone',
  'provider',
] as const

const decodeBar = (
  fields: readonly string[],
  row: number,
  manifest: Candidate6DevelopmentManifest,
): Candidate6DataResult<DailyBar> => {
  if (fields.length !== EXPECTED_BARS_HEADER.length) {
    return candidate6DataFail({ _tag: 'InvalidCsvFieldCount', artifact: 'bars', row, observed: fields.length })
  }
  const [
    snapshotId,
    symbol,
    rawDate,
    rawOpen,
    rawHigh,
    rawLow,
    rawClose,
    rawVolume,
    provider,
    feed,
    adjustment,
    rawPublicationAsOf,
  ] = fields
  if (snapshotId !== manifest.snapshotId) {
    return candidate6DataFail({
      _tag: 'SnapshotIdMismatch',
      row,
      expected: manifest.snapshotId,
      observed: snapshotId ?? '',
    })
  }
  const publicationAsOf = candidate6IsoDate('bars', row, rawPublicationAsOf ?? '')
  if (Result.isFailure(publicationAsOf)) return candidate6DataFail(publicationAsOf.failure)
  if (publicationAsOf.success !== manifest.publicationAsOf) {
    return candidate6DataFail({
      _tag: 'ManifestFieldMismatch',
      field: 'bars.publication_asof',
      expected: manifest.publicationAsOf,
      observed: publicationAsOf.success,
    })
  }
  const sessionDate = candidate6IsoDate('bars', row, rawDate ?? '')
  if (Result.isFailure(sessionDate)) return candidate6DataFail(sessionDate.failure)
  const numbers = [
    ['open', rawOpen ?? ''],
    ['high', rawHigh ?? ''],
    ['low', rawLow ?? ''],
    ['close', rawClose ?? ''],
    ['volume', rawVolume ?? ''],
  ] as const
  const decodedNumbers: number[] = []
  for (const [field, observed] of numbers) {
    const decoded = candidate6FiniteNumber(row, field, observed)
    if (Result.isFailure(decoded)) return candidate6DataFail(decoded.failure)
    decodedNumbers.push(decoded.success)
  }
  if (provider !== DataSource.Alpaca) {
    return candidate6DataFail({ _tag: 'InvalidCsvEnum', row, field: 'provider', observed: provider ?? '' })
  }
  if (feed !== DataFeed.Sip) {
    return candidate6DataFail({ _tag: 'InvalidCsvEnum', row, field: 'source_feed', observed: feed ?? '' })
  }
  if (adjustment !== PriceAdjustment.All) {
    return candidate6DataFail({ _tag: 'InvalidCsvEnum', row, field: 'adjustment', observed: adjustment ?? '' })
  }
  return Result.succeed({
    symbol: symbol ?? '',
    sessionDate: sessionDate.success,
    open: decodedNumbers[0] ?? Number.NaN,
    high: decodedNumbers[1] ?? Number.NaN,
    low: decodedNumbers[2] ?? Number.NaN,
    close: decodedNumbers[3] ?? Number.NaN,
    volume: decodedNumbers[4] ?? Number.NaN,
    source: DataSource.Alpaca,
    sourceFeed: DataFeed.Sip,
    adjustment: PriceAdjustment.All,
    publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
  })
}

const decodeSession = (
  fields: readonly string[],
  row: number,
  manifest: Candidate6DevelopmentManifest,
): Candidate6DataResult<Candidate6DevelopmentSession> => {
  if (fields.length !== EXPECTED_SESSIONS_HEADER.length) {
    return candidate6DataFail({ _tag: 'InvalidCsvFieldCount', artifact: 'sessions', row, observed: fields.length })
  }
  const [observedSnapshotId, calendarVersion, rawDate, rawOpenTime, rawCloseTime, timezone, provider] = fields
  if (observedSnapshotId !== manifest.snapshotId) {
    return candidate6DataFail({
      _tag: 'SnapshotIdMismatch',
      row,
      expected: manifest.snapshotId,
      observed: observedSnapshotId ?? '',
    })
  }
  if (calendarVersion !== manifest.calendarVersion) {
    return candidate6DataFail({
      _tag: 'CalendarVersionMismatch',
      row,
      expected: manifest.calendarVersion,
      observed: calendarVersion ?? '',
    })
  }
  const sessionDate = candidate6IsoDate('sessions', row, rawDate ?? '')
  if (Result.isFailure(sessionDate)) return candidate6DataFail(sessionDate.failure)
  const openTime = candidate6SessionTime(row, 'open_time', rawOpenTime ?? '')
  if (Result.isFailure(openTime)) return candidate6DataFail(openTime.failure)
  const closeTime = candidate6SessionTime(row, 'close_time', rawCloseTime ?? '')
  if (Result.isFailure(closeTime)) return candidate6DataFail(closeTime.failure)
  if (openTime.success >= closeTime.success) {
    return candidate6DataFail({
      _tag: 'InvalidSessionHours',
      row,
      openTime: openTime.success,
      closeTime: closeTime.success,
    })
  }
  if (timezone === undefined || timezone.length === 0) {
    return candidate6DataFail({ _tag: 'InvalidCsvEnum', row, field: 'timezone', observed: timezone ?? '' })
  }
  if (provider !== DataSource.Alpaca) {
    return candidate6DataFail({ _tag: 'InvalidCsvEnum', row, field: 'provider', observed: provider ?? '' })
  }
  return Result.succeed({
    snapshotId: manifest.snapshotId,
    calendarVersion: manifest.calendarVersion,
    sessionDate: sessionDate.success,
    openTime: openTime.success,
    closeTime: closeTime.success,
    timezone,
    provider: DataSource.Alpaca,
  })
}

export const parseCandidate6DevelopmentCsv = (
  barsCsv: string,
  sessionsCsv: string,
  manifestCsv: string,
): Candidate6DataResult<Candidate6DevelopmentDataset> => {
  const manifest = parseCandidate6DevelopmentManifestCsv(manifestCsv)
  if (Result.isFailure(manifest)) return candidate6DataFail(manifest.failure)
  const barRows = parseCandidate6CsvBody(barsCsv, 'bars', EXPECTED_BARS_HEADER)
  if (Result.isFailure(barRows)) return candidate6DataFail(barRows.failure)
  const sessionRows = parseCandidate6CsvBody(sessionsCsv, 'sessions', EXPECTED_SESSIONS_HEADER)
  if (Result.isFailure(sessionRows)) return candidate6DataFail(sessionRows.failure)
  const bars: DailyBar[] = []
  for (let index = 0; index < barRows.success.length; index += 1) {
    const decoded = decodeBar(barRows.success[index] ?? [], index + 2, manifest.success)
    if (Result.isFailure(decoded)) return candidate6DataFail(decoded.failure)
    bars.push(decoded.success)
  }
  const sessions: Candidate6DevelopmentSession[] = []
  for (let index = 0; index < sessionRows.success.length; index += 1) {
    const decoded = decodeSession(sessionRows.success[index] ?? [], index + 2, manifest.success)
    if (Result.isFailure(decoded)) return candidate6DataFail(decoded.failure)
    sessions.push(decoded.success)
  }
  const dates = sessions.map((session) => session.sessionDate).sort()
  return Result.succeed({
    snapshotId: manifest.success.snapshotId,
    calendarVersion: manifest.success.calendarVersion,
    publicationAsOf: manifest.success.publicationAsOf,
    manifestContentHash: manifest.success.manifestContentHash,
    rawManifestExportSha256: sha256(manifestCsv),
    rawBarsExportSha256: sha256(barsCsv),
    rawSessionsExportSha256: sha256(sessionsCsv),
    firstSession: dates[0] as IsoDate,
    lastSession: dates.at(-1) as IsoDate,
    barCount: bars.length,
    sessionCount: sessions.length,
    manifest: manifest.success,
    sessions,
    bars,
  })
}
