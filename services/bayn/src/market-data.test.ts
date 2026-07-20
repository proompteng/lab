import { describe, expect, test } from 'bun:test'

import { buildPublication } from '../../signal-publisher/src/domain'
import {
  verifyFinalizedSnapshot,
  type SignalBarRow,
  type SignalManifestRow,
  type SignalSessionRow,
  type SnapshotRequest,
  type SnapshotRows,
} from './market-data'

const symbols = ['EEM', 'SPY'] as const
const calendar = [
  { date: '2025-01-02', open: '09:30', close: '16:00' },
  { date: '2025-01-03', open: '09:30', close: '16:00' },
  { date: '2025-01-06', open: '09:30', close: '16:00' },
  { date: '2025-01-07', open: '09:30', close: '16:00' },
] as const

const barsFor = (offset: number) =>
  calendar.map((session, index) => {
    const close = 100 + offset + index
    return {
      t: `${session.date}T05:00:00Z`,
      o: close - 0.5,
      h: close + 1,
      l: close - 1,
      c: close,
      v: 1_000_000 + offset + index,
      n: 1_000 + offset + index,
      vw: close - 0.1,
    }
  })

const makeFixture = (): {
  readonly rows: SnapshotRows
  readonly request: SnapshotRequest
} => {
  const publication = buildPublication({
    barsBySymbol: {
      EEM: barsFor(10),
      SPY: barsFor(20),
    },
    calendar,
    symbols,
    feed: 'sip',
    calendarVersion: 'alpaca-us-equity-calendar-v1',
    requestedStart: '2025-01-02',
    publicationAsOf: '2025-01-07',
    finalizedAt: '2025-01-08 01:00:00.000',
    provenance: {
      sourceRevision: 'a'.repeat(40),
      imageRepository: 'registry.ide-newton.ts.net/lab/signal-publisher',
      imageDigest: `sha256:${'b'.repeat(64)}`,
    },
  })
  return {
    rows: {
      bars: publication.bars as readonly SignalBarRow[],
      sessions: publication.sessions as readonly SignalSessionRow[],
      manifests: [publication.manifest as SignalManifestRow],
    },
    request: {
      snapshotId: publication.manifest.snapshot_id,
      publicationAsOf: '2025-01-07',
      calendarVersion: 'alpaca-us-equity-calendar-v1',
      universe: symbols,
      bounds: {
        schemaVersion: 'bayn.evaluation-bounds.v1',
        dataStart: '2025-01-02',
        dataEnd: '2025-01-07',
        lookbackStart: '2025-01-02',
        evaluationStart: '2025-01-03',
        evaluationEnd: '2025-01-07',
      },
      observedAt: '2025-01-08T02:00:00.000Z',
    },
  }
}

describe('finalized Signal snapshot reader', () => {
  test('reproduces the publisher contract before exposing bounded numeric bars', () => {
    const fixture = makeFixture()
    const snapshot = verifyFinalizedSnapshot(fixture.rows, fixture.request)
    const source = fixture.rows.manifests[0]

    expect(snapshot.bars).toHaveLength(8)
    expect(snapshot.manifest).toMatchObject({
      schemaVersion: 'bayn.input-manifest.v2',
      rowCount: 8,
      sessionCount: 4,
      firstSession: '2025-01-02',
      lastSession: '2025-01-07',
      finalizedSnapshot: {
        snapshotId: source.snapshot_id,
        publicationId: source.manifest_content_hash,
        contentHash: source.bars_content_hash,
        sessionsContentHash: source.sessions_content_hash,
        sourceFeed: 'sip',
        symbols,
      },
    })
    expect(snapshot.manifest.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.bars.every((bar) => bar.open > 0 && bar.close > 0)).toBe(true)
  })

  test('rejects duplicate manifests, sessions, and bars', () => {
    const fixture = makeFixture()
    expect(() =>
      verifyFinalizedSnapshot(
        { ...fixture.rows, manifests: [...fixture.rows.manifests, fixture.rows.manifests[0]] },
        fixture.request,
      ),
    ).toThrow('expected exactly one')
    expect(() =>
      verifyFinalizedSnapshot(
        { ...fixture.rows, sessions: [...fixture.rows.sessions, fixture.rows.sessions[0]] },
        fixture.request,
      ),
    ).toThrow('duplicate exchange session')
    expect(() =>
      verifyFinalizedSnapshot({ ...fixture.rows, bars: [...fixture.rows.bars, fixture.rows.bars[0]] }, fixture.request),
    ).toThrow('duplicate adjusted bar')
  })

  test('rejects a missing symbol-session row instead of silently shrinking history', () => {
    const fixture = makeFixture()
    expect(() =>
      verifyFinalizedSnapshot({ ...fixture.rows, bars: fixture.rows.bars.slice(1) }, fixture.request),
    ).toThrow('adjusted-bar count does not match manifest')
  })

  test('rejects unexpected symbols and mixed publication provenance', () => {
    const fixture = makeFixture()
    const unexpected = [{ ...fixture.rows.bars[0], symbol: 'QQQ' }, ...fixture.rows.bars.slice(1)]
    expect(() => verifyFinalizedSnapshot({ ...fixture.rows, bars: unexpected }, fixture.request)).toThrow(
      'snapshot universe does not match request',
    )

    const mixed = [{ ...fixture.rows.bars[0], source_feed: 'iex' as never }, ...fixture.rows.bars.slice(1)]
    expect(() => verifyFinalizedSnapshot({ ...fixture.rows, bars: mixed }, fixture.request)).toThrow(
      'mix provider, feed, or adjustment',
    )
  })

  test('rejects changed values, calendar contracts, counts, and hashes', () => {
    const fixture = makeFixture()
    const changed = [{ ...fixture.rows.bars[0], adjusted_close: '999.00000000' }, ...fixture.rows.bars.slice(1)]
    expect(() => verifyFinalizedSnapshot({ ...fixture.rows, bars: changed }, fixture.request)).toThrow(
      'adjusted-bar content hash is invalid',
    )

    const wrongCalendar = [
      { ...fixture.rows.sessions[0], calendar_version: 'wrong-calendar' },
      ...fixture.rows.sessions.slice(1),
    ]
    expect(() => verifyFinalizedSnapshot({ ...fixture.rows, sessions: wrongCalendar }, fixture.request)).toThrow(
      'mixes calendar versions',
    )

    const badManifest = { ...fixture.rows.manifests[0], bar_count: 7 }
    expect(() => verifyFinalizedSnapshot({ ...fixture.rows, manifests: [badManifest] }, fixture.request)).toThrow(
      'manifest content hash is invalid',
    )
  })

  test('rejects future finalization, a different publication session, and non-session bounds', () => {
    const fixture = makeFixture()
    expect(() =>
      verifyFinalizedSnapshot(fixture.rows, { ...fixture.request, observedAt: '2025-01-08T00:59:59.999Z' }),
    ).toThrow('finalization is in the future')
    expect(() => verifyFinalizedSnapshot(fixture.rows, { ...fixture.request, publicationAsOf: '2025-01-06' })).toThrow(
      'does not match expected session',
    )
    expect(() =>
      verifyFinalizedSnapshot(fixture.rows, {
        ...fixture.request,
        bounds: { ...fixture.request.bounds, evaluationStart: '2025-01-04' },
      }),
    ).toThrow('is not an exchange session')
  })
})
