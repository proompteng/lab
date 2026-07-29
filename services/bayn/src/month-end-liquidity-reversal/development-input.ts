import { Result } from 'effect'

import { canonicalHashV1Result, sha256, type CanonicalHashFailure } from '../hash'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type IsoDate } from '../types'
import { candidate6DevelopmentProvenance, candidate6Protocol, type Candidate6DevelopmentManifest } from './model'

const EXPECTED_MANIFEST_HEADER = [
  'snapshot_id',
  'schema_version',
  'publisher_source_revision',
  'publisher_image_repository',
  'publisher_image_digest',
  'universe_id',
  'universe_symbol_hash',
  'provider',
  'source_feed',
  'adjustment',
  'calendar_version',
  'requested_start',
  'publication_asof',
  'first_session',
  'last_session',
  'symbol_count',
  'session_count',
  'bar_count',
  'bars_content_hash',
  'sessions_content_hash',
  'manifest_content_hash',
  'finalized_at',
] as const

export type Candidate6DevelopmentArtifact = 'bars' | 'sessions' | 'manifest'

export type Candidate6DevelopmentDataFailure =
  | {
      readonly _tag: 'InvalidCsv'
      readonly artifact: Candidate6DevelopmentArtifact
      readonly row: number
      readonly reason: string
    }
  | {
      readonly _tag: 'InvalidCsvHeader'
      readonly artifact: Candidate6DevelopmentArtifact
      readonly observed: readonly string[]
    }
  | {
      readonly _tag: 'InvalidCsvFieldCount'
      readonly artifact: Candidate6DevelopmentArtifact
      readonly row: number
      readonly observed: number
    }
  | {
      readonly _tag: 'InvalidCsvDate'
      readonly artifact: Candidate6DevelopmentArtifact
      readonly row: number
      readonly observed: string
    }
  | {
      readonly _tag: 'InvalidCsvTime'
      readonly row: number
      readonly field: 'open_time' | 'close_time'
      readonly observed: string
    }
  | {
      readonly _tag: 'InvalidSessionHours'
      readonly row: number
      readonly openTime: string
      readonly closeTime: string
    }
  | { readonly _tag: 'InvalidCsvNumber'; readonly row: number; readonly field: string; readonly observed: string }
  | { readonly _tag: 'InvalidCsvEnum'; readonly row: number; readonly field: string; readonly observed: string }
  | { readonly _tag: 'InvalidCsvHash'; readonly row: number; readonly field: string; readonly observed: string }
  | { readonly _tag: 'InvalidManifestCount'; readonly observed: number }
  | {
      readonly _tag: 'ManifestFieldMismatch'
      readonly field: string
      readonly expected: string | number
      readonly observed: string | number
    }
  | {
      readonly _tag: 'ManifestCanonicalizationFailed'
      readonly operation: 'manifest' | 'snapshot-identity'
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'DevelopmentContentHashFailed'
      readonly artifact: 'bars' | 'sessions'
      readonly cause: CanonicalHashFailure
    }
  | { readonly _tag: 'SnapshotIdMismatch'; readonly row: number; readonly expected: string; readonly observed: string }
  | {
      readonly _tag: 'CalendarVersionMismatch'
      readonly row: number
      readonly expected: string
      readonly observed: string
    }
  | { readonly _tag: 'EmptyDevelopmentDataset'; readonly artifact: Candidate6DevelopmentArtifact }

export type Candidate6DataResult<A> = Result.Result<A, Candidate6DevelopmentDataFailure>

export const candidate6DataFail = <A>(failure: Candidate6DevelopmentDataFailure): Candidate6DataResult<A> =>
  Result.fail(failure)

const parseCsvRows = (
  input: string,
  artifact: Candidate6DevelopmentArtifact,
): Candidate6DataResult<readonly (readonly string[])[]> => {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? ''
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
      }
      continue
    }
    if (character === '"') {
      if (field.length > 0) {
        return candidate6DataFail({ _tag: 'InvalidCsv', artifact, row: rows.length + 1, reason: 'quote-after-data' })
      }
      quoted = true
    } else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }
  if (quoted) {
    return candidate6DataFail({ _tag: 'InvalidCsv', artifact, row: rows.length + 1, reason: 'unterminated-quote' })
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith('\r') ? field.slice(0, -1) : field)
    rows.push(row)
  }
  return Result.succeed(rows)
}

export const parseCandidate6CsvBody = (
  csv: string,
  artifact: Candidate6DevelopmentArtifact,
  expectedHeader: readonly string[],
): Candidate6DataResult<readonly (readonly string[])[]> => {
  const rows = parseCsvRows(csv, artifact)
  if (Result.isFailure(rows)) return candidate6DataFail(rows.failure)
  const [header, ...body] = rows.success
  if (
    header === undefined ||
    header.length !== expectedHeader.length ||
    header.some((field, index) => field !== expectedHeader[index])
  ) {
    return candidate6DataFail({ _tag: 'InvalidCsvHeader', artifact, observed: header ?? [] })
  }
  return body.length === 0 ? candidate6DataFail({ _tag: 'EmptyDevelopmentDataset', artifact }) : Result.succeed(body)
}

export const candidate6FiniteNumber = (row: number, field: string, observed: string): Candidate6DataResult<number> => {
  if (observed.trim().length === 0) {
    return candidate6DataFail({ _tag: 'InvalidCsvNumber', row, field, observed })
  }
  const value = Number(observed)
  return Number.isFinite(value)
    ? Result.succeed(value)
    : candidate6DataFail({ _tag: 'InvalidCsvNumber', row, field, observed })
}

const safeNonNegativeInteger = (row: number, field: string, observed: string): Candidate6DataResult<number> => {
  const decoded = candidate6FiniteNumber(row, field, observed)
  if (Result.isFailure(decoded)) return candidate6DataFail(decoded.failure)
  return Number.isSafeInteger(decoded.success) && decoded.success >= 0
    ? decoded
    : candidate6DataFail({ _tag: 'InvalidCsvNumber', row, field, observed })
}

const hash = (row: number, field: string, observed: string): Candidate6DataResult<string> =>
  /^[0-9a-f]{64}$/.test(observed)
    ? Result.succeed(observed)
    : candidate6DataFail({ _tag: 'InvalidCsvHash', row, field, observed })

const exactField = (field: string, expected: string | number, observed: string | number): Candidate6DataResult<void> =>
  expected === observed
    ? Result.succeed(undefined)
    : candidate6DataFail({ _tag: 'ManifestFieldMismatch', field, expected, observed })

export const candidate6IsoDate = (
  artifact: Candidate6DevelopmentArtifact,
  row: number,
  observed: string,
): Candidate6DataResult<IsoDate> => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observed)) {
    return candidate6DataFail({ _tag: 'InvalidCsvDate', artifact, row, observed })
  }
  const parsed = new Date(`${observed}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === observed
    ? Result.succeed(observed as IsoDate)
    : candidate6DataFail({ _tag: 'InvalidCsvDate', artifact, row, observed })
}

export const candidate6SessionTime = (
  row: number,
  field: 'open_time' | 'close_time',
  observed: string,
): Candidate6DataResult<string> =>
  /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(observed)
    ? Result.succeed(observed)
    : candidate6DataFail({ _tag: 'InvalidCsvTime', row, field, observed })

const decodeManifest = (
  fields: readonly string[],
  row: number,
): Candidate6DataResult<Candidate6DevelopmentManifest> => {
  if (fields.length !== EXPECTED_MANIFEST_HEADER.length) {
    return candidate6DataFail({ _tag: 'InvalidCsvFieldCount', artifact: 'manifest', row, observed: fields.length })
  }
  const [
    snapshotId,
    schemaVersion,
    publisherSourceRevision,
    publisherImageRepository,
    publisherImageDigest,
    universeId,
    universeSymbolHash,
    provider,
    sourceFeed,
    adjustment,
    calendarVersion,
    rawRequestedStart,
    rawPublicationAsOf,
    rawFirstSession,
    rawLastSession,
    rawSymbolCount,
    rawSessionCount,
    rawBarCount,
    barsContentHash,
    sessionsContentHash,
    manifestContentHash,
    finalizedAt,
  ] = fields
  const requestedStart = candidate6IsoDate('manifest', row, rawRequestedStart ?? '')
  if (Result.isFailure(requestedStart)) return candidate6DataFail(requestedStart.failure)
  const publicationAsOf = candidate6IsoDate('manifest', row, rawPublicationAsOf ?? '')
  if (Result.isFailure(publicationAsOf)) return candidate6DataFail(publicationAsOf.failure)
  const firstSession = candidate6IsoDate('manifest', row, rawFirstSession ?? '')
  if (Result.isFailure(firstSession)) return candidate6DataFail(firstSession.failure)
  const lastSession = candidate6IsoDate('manifest', row, rawLastSession ?? '')
  if (Result.isFailure(lastSession)) return candidate6DataFail(lastSession.failure)
  const symbolCount = safeNonNegativeInteger(row, 'symbol_count', rawSymbolCount ?? '')
  if (Result.isFailure(symbolCount)) return candidate6DataFail(symbolCount.failure)
  const sessionCount = safeNonNegativeInteger(row, 'session_count', rawSessionCount ?? '')
  if (Result.isFailure(sessionCount)) return candidate6DataFail(sessionCount.failure)
  const barCount = safeNonNegativeInteger(row, 'bar_count', rawBarCount ?? '')
  if (Result.isFailure(barCount)) return candidate6DataFail(barCount.failure)
  for (const [field, observed] of [
    ['snapshot_id', snapshotId ?? ''],
    ['universe_symbol_hash', universeSymbolHash ?? ''],
    ['bars_content_hash', barsContentHash ?? ''],
    ['sessions_content_hash', sessionsContentHash ?? ''],
    ['manifest_content_hash', manifestContentHash ?? ''],
  ] as const) {
    const decoded = hash(row, field, observed)
    if (Result.isFailure(decoded)) return candidate6DataFail(decoded.failure)
  }
  if (!/^[0-9a-f]{40}$/.test(publisherSourceRevision ?? '')) {
    return candidate6DataFail({
      _tag: 'InvalidCsvEnum',
      row,
      field: 'publisher_source_revision',
      observed: publisherSourceRevision ?? '',
    })
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(publisherImageDigest ?? '')) {
    return candidate6DataFail({
      _tag: 'InvalidCsvEnum',
      row,
      field: 'publisher_image_digest',
      observed: publisherImageDigest ?? '',
    })
  }
  if ((publisherImageRepository ?? '').trim().length === 0) {
    return candidate6DataFail({
      _tag: 'InvalidCsvEnum',
      row,
      field: 'publisher_image_repository',
      observed: publisherImageRepository ?? '',
    })
  }
  if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}$/.test(finalizedAt ?? '')) {
    return candidate6DataFail({ _tag: 'InvalidCsvEnum', row, field: 'finalized_at', observed: finalizedAt ?? '' })
  }
  const expectedFields = [
    ['snapshot_id', candidate6DevelopmentProvenance.snapshotId, snapshotId ?? ''],
    ['schema_version', candidate6Protocol.marketData.publicationSchemaVersion, schemaVersion ?? ''],
    ['universe_id', candidate6Protocol.marketData.universeId, universeId ?? ''],
    ['universe_symbol_hash', candidate6DevelopmentProvenance.universeSymbolHash, universeSymbolHash ?? ''],
    ['provider', candidate6Protocol.marketData.source, provider ?? ''],
    ['source_feed', candidate6Protocol.marketData.sourceFeed, sourceFeed ?? ''],
    ['adjustment', candidate6Protocol.marketData.adjustment, adjustment ?? ''],
    ['calendar_version', candidate6Protocol.marketData.calendarVersion, calendarVersion ?? ''],
    ['requested_start', candidate6DevelopmentProvenance.developmentDataStart, requestedStart.success],
    ['publication_asof', candidate6DevelopmentProvenance.publicationAsOf, publicationAsOf.success],
    ['first_session', candidate6DevelopmentProvenance.developmentDataStart, firstSession.success],
    ['finalized_at', candidate6DevelopmentProvenance.finalizedAt, finalizedAt ?? ''],
    ['manifest_content_hash', candidate6DevelopmentProvenance.manifestContentHash, manifestContentHash ?? ''],
  ] as const
  for (const [field, expected, observed] of expectedFields) {
    const exact = exactField(field, expected, observed)
    if (Result.isFailure(exact)) return candidate6DataFail(exact.failure)
  }
  if (lastSession.success < candidate6DevelopmentProvenance.developmentEnd) {
    return candidate6DataFail({
      _tag: 'ManifestFieldMismatch',
      field: 'last_session',
      expected: `>=${candidate6DevelopmentProvenance.developmentEnd}`,
      observed: lastSession.success,
    })
  }
  if (
    symbolCount.success !== candidate6DevelopmentProvenance.snapshotUniverse.length ||
    barCount.success !== symbolCount.success * sessionCount.success
  ) {
    return candidate6DataFail({
      _tag: 'ManifestFieldMismatch',
      field: 'cardinality',
      expected: symbolCount.success * sessionCount.success,
      observed: barCount.success,
    })
  }
  const expectedUniverseHash = sha256(candidate6DevelopmentProvenance.snapshotUniverse.join(','))
  if (expectedUniverseHash !== universeSymbolHash) {
    return candidate6DataFail({
      _tag: 'ManifestFieldMismatch',
      field: 'universe_symbol_hash',
      expected: expectedUniverseHash,
      observed: universeSymbolHash ?? '',
    })
  }
  const wireManifest = {
    snapshot_id: snapshotId as string,
    schema_version: schemaVersion as string,
    publisher_source_revision: publisherSourceRevision as string,
    publisher_image_repository: publisherImageRepository as string,
    publisher_image_digest: publisherImageDigest as string,
    universe_id: universeId as string,
    universe_symbol_hash: universeSymbolHash as string,
    provider: provider as string,
    source_feed: sourceFeed as string,
    adjustment: adjustment as string,
    calendar_version: calendarVersion as string,
    requested_start: requestedStart.success,
    publication_asof: publicationAsOf.success,
    first_session: firstSession.success,
    last_session: lastSession.success,
    symbol_count: symbolCount.success,
    session_count: sessionCount.success,
    bar_count: barCount.success,
    bars_content_hash: barsContentHash as string,
    sessions_content_hash: sessionsContentHash as string,
    finalized_at: finalizedAt as string,
  }
  const expectedManifestHash = canonicalHashV1Result(wireManifest)
  if (Result.isFailure(expectedManifestHash)) {
    return candidate6DataFail({
      _tag: 'ManifestCanonicalizationFailed',
      operation: 'manifest',
      cause: expectedManifestHash.failure,
    })
  }
  const manifestHashMatch = exactField('manifest_content_hash', expectedManifestHash.success, manifestContentHash ?? '')
  if (Result.isFailure(manifestHashMatch)) return candidate6DataFail(manifestHashMatch.failure)
  const expectedSnapshotId = canonicalHashV1Result({
    schemaVersion,
    provider,
    feed: sourceFeed,
    adjustment,
    calendarVersion,
    requestedStart: requestedStart.success,
    publicationAsOf: publicationAsOf.success,
    symbols: candidate6DevelopmentProvenance.snapshotUniverse,
    barsContentHash,
    sessionsContentHash,
    universeId,
    universeSymbolHash,
  })
  if (Result.isFailure(expectedSnapshotId)) {
    return candidate6DataFail({
      _tag: 'ManifestCanonicalizationFailed',
      operation: 'snapshot-identity',
      cause: expectedSnapshotId.failure,
    })
  }
  const snapshotMatch = exactField('snapshot_id', expectedSnapshotId.success, snapshotId ?? '')
  if (Result.isFailure(snapshotMatch)) return candidate6DataFail(snapshotMatch.failure)
  return Result.succeed({
    snapshotId: snapshotId as string,
    schemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
    publisherSourceRevision: publisherSourceRevision as string,
    publisherImageRepository: publisherImageRepository as string,
    publisherImageDigest: publisherImageDigest as string,
    universeId: universeId as string,
    universeSymbolHash: universeSymbolHash as string,
    provider: DataSource.Alpaca,
    sourceFeed: DataFeed.Sip,
    adjustment: PriceAdjustment.All,
    calendarVersion: calendarVersion as string,
    requestedStart: requestedStart.success,
    publicationAsOf: publicationAsOf.success,
    firstSession: firstSession.success,
    lastSession: lastSession.success,
    symbolCount: symbolCount.success,
    sessionCount: sessionCount.success,
    barCount: barCount.success,
    barsContentHash: barsContentHash as string,
    sessionsContentHash: sessionsContentHash as string,
    manifestContentHash: manifestContentHash as string,
    finalizedAt: finalizedAt as string,
  })
}

export const parseCandidate6DevelopmentManifestCsv = (
  manifestCsv: string,
): Candidate6DataResult<Candidate6DevelopmentManifest> => {
  const rows = parseCandidate6CsvBody(manifestCsv, 'manifest', EXPECTED_MANIFEST_HEADER)
  if (Result.isFailure(rows)) return candidate6DataFail(rows.failure)
  if (rows.success.length !== 1) {
    return candidate6DataFail({ _tag: 'InvalidManifestCount', observed: rows.success.length })
  }
  return decodeManifest(rows.success[0] ?? [], 2)
}
