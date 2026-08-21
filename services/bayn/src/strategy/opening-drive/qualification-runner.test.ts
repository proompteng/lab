import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { DataFeed, DataSource, PriceAdjustment, PublicationSchema } from '../../contracts'
import { canonicalHashV1 } from '../../hash'
import type { SignalManifestRow, SignalSessionRow } from '../../market-data/rows'
import {
  bindOpeningDriveQualificationVersions,
  prepareOpeningDriveQualificationCalendar,
  verifyOpeningDriveQualificationCalendarPublication,
  versionOpeningDriveQualificationSession,
} from './qualification-runner'
import { decodeDefaultOpeningDriveProtocol } from './protocol'

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'fixture must succeed')
  return result.success
}

const protocol = success(decodeDefaultOpeningDriveProtocol())

const row = (sessionDate: SignalSessionRow['session_date'], open = '09:30', close = '16:00'): SignalSessionRow => ({
  snapshot_id: 'a'.repeat(64),
  calendar_version: 'alpaca-us-equity-calendar-v1',
  session_date: sessionDate,
  open_time: open,
  close_time: close,
  timezone: 'America/New_York',
  provider: DataSource.Alpaca,
})

const watermarks = (offset: string) => [
  { sourceTopic: 'torghut.bars.1m.v1', sourcePartition: 0, inclusiveLastOffset: offset },
  { sourceTopic: 'torghut.quotes.v1', sourcePartition: 0, inclusiveLastOffset: offset },
  { sourceTopic: 'torghut.trades.v1', sourcePartition: 0, inclusiveLastOffset: offset },
]

const manifestFixture = (sessions: readonly SignalSessionRow[]): SignalManifestRow => {
  const snapshotId = sessions[0]?.snapshot_id ?? 'a'.repeat(64)
  const sessionMaterial = sessions.map(({ snapshot_id: _, ...session }) => session)
  const manifestMaterial = {
    snapshot_id: snapshotId,
    schema_version: PublicationSchema.AdjustedDailySnapshotV2,
    publisher_source_revision: 'b'.repeat(40),
    publisher_image_repository: 'registry.ide-newton.ts.net/lab/signal-publisher',
    publisher_image_digest: `sha256:${'c'.repeat(64)}`,
    universe_id: 'cross-asset-taa-v1' as const,
    universe_symbol_hash: 'd'.repeat(64),
    provider: DataSource.Alpaca,
    source_feed: DataFeed.Sip,
    adjustment: PriceAdjustment.All,
    calendar_version: sessions[0]?.calendar_version ?? 'alpaca-us-equity-calendar-v1',
    requested_start: sessions[0]?.session_date ?? '2026-01-05',
    publication_asof: sessions.at(-1)?.session_date ?? '2026-01-07',
    first_session: sessions[0]?.session_date ?? '2026-01-05',
    last_session: sessions.at(-1)?.session_date ?? '2026-01-07',
    symbol_count: 1,
    session_count: sessions.length,
    bar_count: sessions.length,
    bars_content_hash: 'e'.repeat(64),
    sessions_content_hash: canonicalHashV1(sessionMaterial),
    finalized_at: '2026-01-08 01:00:00.000',
  }
  return { ...manifestMaterial, manifest_content_hash: canonicalHashV1(manifestMaterial) }
}

const withFinalizedAt = (manifest: SignalManifestRow, finalizedAt: string): SignalManifestRow => {
  const { manifest_content_hash: _, ...material } = manifest
  const changed = { ...material, finalized_at: finalizedAt }
  return { ...changed, manifest_content_hash: canonicalHashV1(changed) }
}

describe('opening-drive qualification runner', () => {
  test('freezes Signal calendar sessions into DST-correct entry and flatten snapshot plans', () => {
    const prepared = success(
      prepareOpeningDriveQualificationCalendar({
        sessions: [row('2026-01-05'), row('2026-07-06')],
        finalizedAt: '2026-07-06 22:00:00.000',
        protocol,
      }),
    )

    expect(prepared.calendar).toMatchObject({
      source: 'signal.exchange_sessions_v1',
      firstSession: '2026-01-05',
      lastSession: '2026-07-06',
      finalizedAt: '2026-07-06T22:00:00.000Z',
    })
    expect(prepared.calendar.sessions[0]).toMatchObject({
      sessionDate: '2026-01-05',
      openAt: '2026-01-05T14:30:00.000Z',
      closeAt: '2026-01-05T21:00:00.000Z',
    })
    expect(prepared.calendar.sessions[1]).toMatchObject({
      sessionDate: '2026-07-06',
      openAt: '2026-07-06T13:30:00.000Z',
      closeAt: '2026-07-06T20:00:00.000Z',
    })
    expect(prepared.sessions[0]?.openingQuery).toMatchObject({
      rangeStartAt: '2026-01-05T14:30:00.000Z',
      rangeEndAt: '2026-01-05T14:35:00.000Z',
      observedAt: '2026-01-05T14:35:01.000Z',
      minimumWatermarkLagMs: 1_000,
    })
    expect(prepared.sessions[0]?.exitQuery).toMatchObject({
      rangeStartAt: '2026-01-05T20:29:00.000Z',
      rangeEndAt: '2026-01-05T20:30:00.000Z',
      observedAt: '2026-01-05T20:30:01.000Z',
      minimumWatermarkLagMs: 0,
    })
  })

  test('binds the exact archive watermarks and prior trial lineage before replay rows can be loaded', () => {
    const prepared = success(
      prepareOpeningDriveQualificationCalendar({
        sessions: [row('2026-07-06')],
        finalizedAt: '2026-07-06 22:00:00.000',
        protocol,
      }),
    )
    const plan = prepared.sessions[0]
    assert(plan !== undefined)
    const versioned = success(
      versionOpeningDriveQualificationSession(
        plan,
        { ...plan.openingQuery, archiveWatermarks: watermarks('100') },
        { ...plan.exitQuery, archiveWatermarks: watermarks('200') },
      ),
    )
    const prior = ['0'.repeat(64), 'f'.repeat(64)]
    const lock = success(
      bindOpeningDriveQualificationVersions([versioned], {
        sourceRevision: 'a'.repeat(40),
        protocol,
        calendar: prepared.calendar,
        priorTrialReceiptHashes: prior.toReversed(),
      }),
    )
    const changed = success(
      versionOpeningDriveQualificationSession(
        plan,
        { ...plan.openingQuery, archiveWatermarks: watermarks('101') },
        { ...plan.exitQuery, archiveWatermarks: watermarks('200') },
      ),
    )
    const changedLock = success(
      bindOpeningDriveQualificationVersions([changed], {
        sourceRevision: 'a'.repeat(40),
        protocol,
        calendar: prepared.calendar,
        priorTrialReceiptHashes: prior,
      }),
    )

    const laterTrialLineage = success(
      bindOpeningDriveQualificationVersions([versioned], {
        sourceRevision: 'a'.repeat(40),
        protocol,
        calendar: prepared.calendar,
        priorTrialReceiptHashes: ['1'.repeat(64)],
      }),
    )

    expect(lock.binding.priorTrialReceiptHashes).toEqual(prior)
    expect(lock.binding.replayVersionGraphHash).not.toBe(changedLock.binding.replayVersionGraphHash)
    expect(lock.lockId).not.toBe(changedLock.lockId)
    expect(lock.candidateKey).toBe(laterTrialLineage.candidateKey)
    expect(lock.lockId).not.toBe(laterTrialLineage.lockId)
  })

  test('fails closed on omitted order or mixed Signal calendar versions', () => {
    const outOfOrder = prepareOpeningDriveQualificationCalendar({
      sessions: [row('2026-07-07'), row('2026-07-06')],
      finalizedAt: '2026-07-07 22:00:00.000',
      protocol,
    })
    expect(Result.isFailure(outOfOrder)).toBe(true)

    const mixed = prepareOpeningDriveQualificationCalendar({
      sessions: [row('2026-07-06'), { ...row('2026-07-07'), calendar_version: 'other-calendar' }],
      finalizedAt: '2026-07-07 22:00:00.000',
      protocol,
    })
    expect(Result.isFailure(mixed)).toBe(true)
  })

  test('verifies the complete finalized Signal calendar before selecting the requested subset', () => {
    const sessions = [row('2026-01-05'), row('2026-01-06'), row('2026-01-07')]
    const manifest = manifestFixture(sessions)
    const input = {
      manifests: [manifest],
      sessions,
      snapshotId: manifest.snapshot_id,
      calendarVersion: manifest.calendar_version,
      publicationAsOf: manifest.publication_asof,
      start: '2026-01-06',
      end: '2026-01-07',
    }

    const verified = success(verifyOpeningDriveQualificationCalendarPublication(input))
    expect(verified.sessions.map(({ session_date }) => session_date)).toEqual(['2026-01-06', '2026-01-07'])
    expect(verified.finalizedAt).toBe(manifest.finalized_at)

    expect(
      Result.isFailure(verifyOpeningDriveQualificationCalendarPublication({ ...input, sessions: sessions.slice(1) })),
    ).toBe(true)
    expect(
      Result.isFailure(
        verifyOpeningDriveQualificationCalendarPublication({ ...input, start: '2026-01-04', end: '2026-01-07' }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        verifyOpeningDriveQualificationCalendarPublication({
          ...input,
          manifests: [{ ...manifest, session_count: manifest.session_count - 1 }],
        }),
      ),
    ).toBe(true)

    const beforeFinalSessionClose = withFinalizedAt(manifest, '2026-01-07 20:59:59.999')
    expect(
      Result.isFailure(
        verifyOpeningDriveQualificationCalendarPublication({
          ...input,
          manifests: [beforeFinalSessionClose],
          start: '2026-01-05',
          end: '2026-01-06',
        }),
      ),
    ).toBe(true)

    const exactlyFinalSessionClose = withFinalizedAt(manifest, '2026-01-07 21:00:00.000')
    expect(
      Result.isSuccess(
        verifyOpeningDriveQualificationCalendarPublication({
          ...input,
          manifests: [exactlyFinalSessionClose],
          start: '2026-01-05',
          end: '2026-01-06',
        }),
      ),
    ).toBe(true)
  })
})
