import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { parseCandidate6DevelopmentCsv } from './development-data'
import {
  candidate6DevelopmentProvenance,
  candidate6Protocol,
  type Candidate6DevelopmentDataset,
  type Candidate6DevelopmentManifest,
  type Candidate6DevelopmentSession,
} from './model'
import { makeSealedCandidate6Preregistration } from './preregistration'
import {
  CANDIDATE_6_DEVELOPMENT_DATA_START,
  CANDIDATE_6_DEVELOPMENT_END,
  CANDIDATE_6_HOLDOUT_START,
  buildCandidate6DevelopmentReport,
  type Candidate6DevelopmentIdentity,
  type Candidate6ResearchFailure,
} from './research'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'fixture must succeed')
  return result.success
}

const failure = <A>(result: Result.Result<A, Candidate6ResearchFailure>): Candidate6ResearchFailure => {
  assert(Result.isFailure(result), 'fixture must fail')
  return result.failure
}

const weekdays = (start: IsoDate, end: IsoDate): readonly IsoDate[] => {
  const dates: IsoDate[] = []
  const cursor = new Date(`${start}T00:00:00.000Z`)
  const final = new Date(`${end}T00:00:00.000Z`)
  while (cursor <= final) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10) as IsoDate)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

const syntheticDataset = (includeIncompleteFinalEvent = false): Candidate6DevelopmentDataset => {
  const calendar = weekdays(CANDIDATE_6_DEVELOPMENT_DATA_START, CANDIDATE_6_DEVELOPMENT_END)
  const snapshotId = 'synthetic-development-only'
  const calendarVersion = 'alpaca-us-equity-calendar-v1'
  const signalDates = new Set<IsoDate>()
  for (let index = 0; index < calendar.length; index += 1) {
    const current = calendar[index]
    if (current === undefined) continue
    const month = current.slice(0, 7)
    let remaining = 0
    for (let cursor = index + 1; cursor < calendar.length; cursor += 1) {
      if ((calendar[cursor] ?? '').slice(0, 7) !== month) break
      remaining += 1
    }

    if (remaining === 4 && (includeIncompleteFinalEvent || month !== '2022-12')) signalDates.add(current)
  }
  const bars = calendar.map((sessionDate, index): DailyBar => {
    const priorDate = calendar[index - 1]
    const signal = signalDates.has(sessionDate)
    const afterSignal = priorDate !== undefined && signalDates.has(priorDate)
    const close = signal ? 99.5 : 100
    const open = afterSignal ? 99.5 : close
    return {
      symbol: 'SPY',
      sessionDate,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 2_000_000,
      source: DataSource.Alpaca,
      sourceFeed: DataFeed.Sip,
      adjustment: PriceAdjustment.All,
      publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
    }
  })
  const sessions = calendar.map(
    (sessionDate): Candidate6DevelopmentSession => ({
      snapshotId,
      calendarVersion,
      sessionDate,
      openTime: '09:30',
      closeTime: '16:00',
      timezone: 'America/New_York',
      provider: DataSource.Alpaca,
    }),
  )
  const manifest: Candidate6DevelopmentManifest = {
    snapshotId,
    schemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
    publisherSourceRevision: '1'.repeat(40),
    publisherImageRepository: 'registry.example.test/signal-publisher',
    publisherImageDigest: `sha256:${'2'.repeat(64)}`,
    universeId: candidate6Protocol.marketData.universeId,
    universeSymbolHash: '3'.repeat(64),
    provider: DataSource.Alpaca,
    sourceFeed: DataFeed.Sip,
    adjustment: PriceAdjustment.All,
    calendarVersion,
    requestedStart: CANDIDATE_6_DEVELOPMENT_DATA_START,
    publicationAsOf: '2026-07-27',
    firstSession: CANDIDATE_6_DEVELOPMENT_DATA_START,
    lastSession: CANDIDATE_6_DEVELOPMENT_END,
    symbolCount: 1,
    sessionCount: sessions.length,
    barCount: bars.length,
    barsContentHash: '4'.repeat(64),
    sessionsContentHash: '5'.repeat(64),
    manifestContentHash: '6'.repeat(64),
    finalizedAt: '2026-07-27 22:30:01.850',
  }
  return {
    snapshotId,
    calendarVersion,
    publicationAsOf: manifest.publicationAsOf,
    manifestContentHash: manifest.manifestContentHash,
    rawManifestExportSha256: 'c'.repeat(64),
    rawBarsExportSha256: 'a'.repeat(64),
    rawSessionsExportSha256: 'b'.repeat(64),
    firstSession: CANDIDATE_6_DEVELOPMENT_DATA_START,
    lastSession: CANDIDATE_6_DEVELOPMENT_END,
    barCount: bars.length,
    sessionCount: sessions.length,
    manifest,
    sessions,
    bars,
  }
}

const syntheticIdentity = (dataset: Candidate6DevelopmentDataset): Candidate6DevelopmentIdentity => ({
  snapshotId: dataset.snapshotId,
  calendarVersion: dataset.calendarVersion,
  publicationAsOf: dataset.publicationAsOf,
  manifestContentHash: dataset.manifestContentHash,
  rawManifestExportSha256: dataset.rawManifestExportSha256,
  rawBarsExportSha256: dataset.rawBarsExportSha256,
  rawSessionsExportSha256: dataset.rawSessionsExportSha256,
  sessionCount: dataset.sessionCount,
})

const buildSyntheticReport = (dataset: Candidate6DevelopmentDataset) =>
  buildCandidate6DevelopmentReport(dataset, candidate6Protocol, syntheticIdentity(dataset))

const barsHeader =
  '"snapshot_id","symbol","toString(session_date)","toString(adjusted_open)","toString(adjusted_high)","toString(adjusted_low)","toString(adjusted_close)","toString(adjusted_volume)","provider","source_feed","adjustment","toString(publication_asof)"'
const sessionsHeader = '"snapshot_id","calendar_version","session_date","open_time","close_time","timezone","provider"'
const manifestHeader =
  '"snapshot_id","schema_version","publisher_source_revision","publisher_image_repository","publisher_image_digest","universe_id","universe_symbol_hash","provider","source_feed","adjustment","calendar_version","requested_start","publication_asof","first_session","last_session","symbol_count","session_count","bar_count","bars_content_hash","sessions_content_hash","manifest_content_hash","finalized_at"'
const manifestRow =
  '"2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0","signal.adjusted-daily-snapshot.v2","72006ac26afef02e42fc1af8d434e49835cc40d6","registry.ide-newton.ts.net/lab/signal-publisher","sha256:2561a79d2baaa998036344c121cc3986aedec365881911dd592d334163d82729","cross-asset-taa-v1","c15a52d125073a20c3addee154974ef32b4ef009c40a46b05b54743f075c0fe8","alpaca","sip","all","alpaca-us-equity-calendar-v1","2016-01-04","2026-07-27","2016-01-04","2026-07-27",5,2655,13275,"8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d","8a31568055a23fa1e58fd9e2bcf7d3df71cae1ed1ecdd887a91e83055f0a2c6b","7b1216c8d698da4b2e74a5a77584c9863608edab0ad1c7331f37d039ddb1a764","2026-07-27 22:30:01.850"'
const validManifestCsv = `${manifestHeader}\n${manifestRow}\n`
const validBarsCsv = `${barsHeader}\n"${candidate6DevelopmentProvenance.snapshotId}","SPY","2016-01-04","100","101","99","100.5","2000000","alpaca","sip","all","${candidate6DevelopmentProvenance.publicationAsOf}"\n`
const validSessionsCsv = `${sessionsHeader}\n"${candidate6DevelopmentProvenance.snapshotId}","alpaca-us-equity-calendar-v1","2016-01-04","09:30","16:00","America/New_York","alpaca"\n`

describe('candidate 6 development data decoder', () => {
  test('decodes immutable bars and official-session CSV contracts and hashes raw bytes', () => {
    const dataset = success(parseCandidate6DevelopmentCsv(validBarsCsv, validSessionsCsv, validManifestCsv))
    expect(dataset).toMatchObject({
      snapshotId: candidate6DevelopmentProvenance.snapshotId,
      calendarVersion: 'alpaca-us-equity-calendar-v1',
      publicationAsOf: candidate6DevelopmentProvenance.publicationAsOf,
      manifestContentHash: candidate6DevelopmentProvenance.manifestContentHash,
      firstSession: '2016-01-04',
      lastSession: '2016-01-04',
      barCount: 1,
      sessionCount: 1,
    })
    expect(dataset.rawManifestExportSha256).toBe(candidate6DevelopmentProvenance.rawManifestExportSha256)
    expect(dataset.rawBarsExportSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(dataset.rawSessionsExportSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(dataset.bars[0]).toMatchObject({ symbol: 'SPY', close: 100.5, source: 'alpaca' })
    expect(dataset.sessions[0]).toMatchObject({
      snapshotId: candidate6DevelopmentProvenance.snapshotId,
      sessionDate: '2016-01-04',
      openTime: '09:30',
      closeTime: '16:00',
    })
  })

  test('fails closed for malformed CSV, impossible dates, headers, numbers, and enums', () => {
    const cases = [
      ['"unterminated', validSessionsCsv, validManifestCsv, 'InvalidCsv'],
      ['"wrong"\n', validSessionsCsv, validManifestCsv, 'InvalidCsvHeader'],
      [
        `${barsHeader}\n"${candidate6DevelopmentProvenance.snapshotId}","SPY","2022-02-30","1","2","1","1","2","alpaca","sip","all","${candidate6DevelopmentProvenance.publicationAsOf}"\n`,
        validSessionsCsv,
        validManifestCsv,
        'InvalidCsvDate',
      ],
      [
        `${barsHeader}\n"${candidate6DevelopmentProvenance.snapshotId}","SPY","2016-01-04","nan","2","1","1","2","alpaca","sip","all","${candidate6DevelopmentProvenance.publicationAsOf}"\n`,
        validSessionsCsv,
        validManifestCsv,
        'InvalidCsvNumber',
      ],
      [
        `${barsHeader}\n"${candidate6DevelopmentProvenance.snapshotId}","SPY","2016-01-04","1","2","1","1","","alpaca","sip","all","${candidate6DevelopmentProvenance.publicationAsOf}"\n`,
        validSessionsCsv,
        validManifestCsv,
        'InvalidCsvNumber',
      ],
      [
        `${barsHeader}\n"${candidate6DevelopmentProvenance.snapshotId}","SPY","2016-01-04","1","2","1","1","   ","alpaca","sip","all","${candidate6DevelopmentProvenance.publicationAsOf}"\n`,
        validSessionsCsv,
        validManifestCsv,
        'InvalidCsvNumber',
      ],
      [
        `${barsHeader}\n"${candidate6DevelopmentProvenance.snapshotId}","SPY","2016-01-04","1","2","1","1","2","other","sip","all","${candidate6DevelopmentProvenance.publicationAsOf}"\n`,
        validSessionsCsv,
        validManifestCsv,
        'InvalidCsvEnum',
      ],
      [
        validBarsCsv,
        `${sessionsHeader}\n"${candidate6DevelopmentProvenance.snapshotId}","alpaca-us-equity-calendar-v1","2022-02-30","09:30","16:00","America/New_York","alpaca"\n`,
        validManifestCsv,
        'InvalidCsvDate',
      ],
      [
        validBarsCsv,
        `${sessionsHeader}\n"${candidate6DevelopmentProvenance.snapshotId}","alpaca-us-equity-calendar-v1","2016-01-04","16:00","09:30","America/New_York","alpaca"\n`,
        validManifestCsv,
        'InvalidSessionHours',
      ],
    ] as const
    for (const [barsCsv, sessionsCsv, manifestCsv, tag] of cases) {
      const decoded = parseCandidate6DevelopmentCsv(barsCsv, sessionsCsv, manifestCsv)
      assert(Result.isFailure(decoded))
      expect(decoded.failure._tag).toBe(tag)
    }
  })

  test('binds every export row to the verified snapshot manifest', () => {
    const wrongSnapshot = '0'.repeat(64)
    const wrongPublication = '2026-07-26'
    const cases = [
      [validBarsCsv.replace(candidate6DevelopmentProvenance.snapshotId, wrongSnapshot), 'SnapshotIdMismatch'],
      [
        validBarsCsv.replace(candidate6DevelopmentProvenance.publicationAsOf, wrongPublication),
        'ManifestFieldMismatch',
      ],
    ] as const
    for (const [barsCsv, tag] of cases) {
      const decoded = parseCandidate6DevelopmentCsv(barsCsv, validSessionsCsv, validManifestCsv)
      assert(Result.isFailure(decoded))
      expect(decoded.failure._tag).toBe(tag)
    }
    const wrongSession = validSessionsCsv.replace(candidate6DevelopmentProvenance.snapshotId, wrongSnapshot)
    const decodedSession = parseCandidate6DevelopmentCsv(validBarsCsv, wrongSession, validManifestCsv)
    assert(Result.isFailure(decodedSession))
    expect(decodedSession.failure._tag).toBe('SnapshotIdMismatch')
  })
})

describe('candidate 6 deterministic development simulation', () => {
  test('is deterministic, order invariant, bounded, and cost sensitive', () => {
    const dataset = syntheticDataset()
    const ordered = success(buildSyntheticReport(dataset))
    const reversed = success(
      buildSyntheticReport({
        ...dataset,
        sessions: [...dataset.sessions].reverse(),
        bars: [...dataset.bars].reverse(),
      }),
    )

    expect(reversed).toEqual(ordered)
    expect(ordered.status).toBe('DEVELOPMENT_ONLY_HOLDOUT_UNTOUCHED')
    expect(ordered.identity.parameterHash).toBe(success(makeSealedCandidate6Preregistration()).identity.parameterHash)
    expect(ordered.dataset.untouchedHoldoutStart).toBe(CANDIDATE_6_HOLDOUT_START)
    expect(ordered.net.observationCount).toBeGreaterThanOrEqual(1_500)
    expect(ordered.net.entryCount).toBeGreaterThan(0)
    expect(ordered.net.maximumGrossExposure).toBeLessThanOrEqual(0.35)
    expect(ordered.net.annualTurnover).toBeLessThanOrEqual(12)
    expect(ordered.gross.annualizedReturn).toBeGreaterThan(ordered.net.annualizedReturn)
    expect(ordered.costSensitivity.map((item) => item.metrics.annualizedReturn)).toEqual(
      [...ordered.costSensitivity]
        .sort((left, right) => left.costMultiplier - right.costMultiplier)
        .map((item) => item.metrics.annualizedReturn),
    )
    for (let index = 1; index < ordered.costSensitivity.length; index += 1) {
      expect(ordered.costSensitivity[index]?.metrics.annualizedReturn).toBeLessThanOrEqual(
        ordered.costSensitivity[index - 1]?.metrics.annualizedReturn ?? Number.POSITIVE_INFINITY,
      )
    }
    expect(ordered.confidenceInterval.annualizedReturn[0]).toBeLessThanOrEqual(
      ordered.confidenceInterval.annualizedReturn[1],
    )
    expect(ordered.reportHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('rejects an omitted interior SPY bar against the authoritative session calendar', () => {
    const dataset = syntheticDataset()
    const omittedSession = '2021-01-15' as IsoDate
    const bars = dataset.bars.filter((bar) => bar.sessionDate !== omittedSession)
    expect(
      failure(
        buildSyntheticReport({
          ...dataset,
          barCount: bars.length,
          bars,
        }),
      ),
    ).toEqual({ _tag: 'MissingDevelopmentBar', symbol: 'SPY', sessionDate: omittedSession })
  })

  test('rejects a changed official-session export identity before simulation', () => {
    const dataset = syntheticDataset()
    const expectedIdentity = syntheticIdentity(dataset)
    expect(
      failure(
        buildCandidate6DevelopmentReport(
          { ...dataset, rawSessionsExportSha256: 'c'.repeat(64) },
          candidate6Protocol,
          expectedIdentity,
        ),
      ),
    ).toEqual({
      _tag: 'DevelopmentIdentityMismatch',
      field: 'rawSessionsExportSha256',
      expected: dataset.rawSessionsExportSha256,
      observed: 'c'.repeat(64),
    })
  })

  test('rejects a simulation that ends before an entered event can exit', () => {
    const issue = failure(buildSyntheticReport(syntheticDataset(true)))
    expect(issue).toEqual({
      _tag: 'ResearchSimulationInvariant',
      reason: 'simulation ended with open event from 2022-12-26',
    })
  })

  test('rejects any post-development row before simulation', () => {
    const dataset = syntheticDataset()
    const future: DailyBar = {
      ...(dataset.bars.at(-1) as DailyBar),
      sessionDate: CANDIDATE_6_HOLDOUT_START,
    }
    expect(
      failure(
        buildSyntheticReport({
          ...dataset,
          barCount: dataset.barCount + 1,
          bars: [...dataset.bars, future],
        }),
      ),
    ).toEqual({ _tag: 'InvalidDevelopmentBoundary', field: 'futureBar', observed: CANDIDATE_6_HOLDOUT_START })
  })
})
