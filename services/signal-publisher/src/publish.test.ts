import { describe, expect, test } from 'bun:test'

import { Effect } from 'effect'

import { buildPublication, type BarRow, type ManifestRow, type SessionRow } from './domain'
import { isFinalizable, latestFinalizableSession, parsePublicationArguments, persistPublication } from './publish'
import type { SnapshotRepository } from './repository'

const publication = (
  finalizedAt = '2026-07-17 22:30:00.000',
  sourceRevision = 'a'.repeat(40),
  imageDigest = `sha256:${'b'.repeat(64)}`,
) =>
  buildPublication({
    barsBySymbol: {
      SPY: [{ t: '2026-07-17T04:00:00Z', o: 620, h: 622, l: 619, c: 621, v: 1_000, n: 10, vw: 621 }],
    },
    calendar: [{ date: '2026-07-17', open: '09:30', close: '16:00' }],
    symbols: ['SPY'],
    feed: 'iex',
    calendarVersion: 'alpaca-us-equity-calendar-v1',
    requestedStart: '2026-07-17',
    publicationAsOf: '2026-07-17',
    finalizedAt,
    provenance: {
      sourceRevision,
      imageRepository: 'registry.ide-newton.ts.net/lab/signal-publisher',
      imageDigest,
    },
  })

const memoryRepository = () => {
  const bars: BarRow[] = []
  const sessions: SessionRow[] = []
  const manifests: ManifestRow[] = []
  const calls: string[] = []
  const repository: SnapshotRepository = {
    loadBars: (snapshotId) => Effect.succeed(bars.filter((row) => row.snapshot_id === snapshotId)),
    loadSessions: (snapshotId) => Effect.succeed(sessions.filter((row) => row.snapshot_id === snapshotId)),
    loadManifests: (snapshotId) => Effect.succeed(manifests.filter((row) => row.snapshot_id === snapshotId)),
    insertBars: (_snapshotId, rows) =>
      Effect.sync(() => {
        if (rows.length > 0) calls.push('bars')
        bars.push(...rows)
      }),
    insertSessions: (_snapshotId, rows) =>
      Effect.sync(() => {
        if (rows.length > 0) calls.push('sessions')
        sessions.push(...rows)
      }),
    insertManifest: (row) => Effect.sync(() => void (calls.push('manifest'), manifests.push(row))),
  }
  return { bars, sessions, manifests, calls, repository }
}

describe('Publication orchestration', () => {
  test('parses only the two explicit modes', () => {
    expect(parsePublicationArguments(['daily'])).toEqual({ mode: 'daily' })
    expect(parsePublicationArguments(['backfill', '--start', '2025-01-01', '--end', '2025-12-31'])).toEqual({
      mode: 'backfill',
      start: '2025-01-01',
      end: '2025-12-31',
    })
    expect(() => parsePublicationArguments(['daily', '--end', '2025-12-31'])).toThrow()
    expect(() => parsePublicationArguments(['backfill', '--start', '2026-01-01', '--end', '2025-01-01'])).toThrow()
    expect(() => parsePublicationArguments(['backfill', '--start', '2026-02-31', '--end', '2026-03-02'])).toThrow()
  })

  test('uses exchange-local close plus lag for finalization', () => {
    const session = { date: '2026-07-17' as const, open: '09:30', close: '16:00' }
    expect(isFinalizable(session, Date.parse('2026-07-17T21:29:00Z'), 90)).toBe(false)
    expect(isFinalizable(session, Date.parse('2026-07-17T21:30:00Z'), 90)).toBe(true)
    expect(isFinalizable(session, Date.parse('2026-07-18T12:00:00Z'), 90)).toBe(true)
    expect(
      latestFinalizableSession(
        [session, { date: '2026-07-16', open: '09:30', close: '16:00' }],
        Date.parse('2026-07-17T21:30:00Z'),
        90,
      ),
    ).toBe('2026-07-17')
  })

  test('stages rows before manifest, verifies readback, and reuses an exact retry', async () => {
    const state = memoryRepository()
    const first = publication()
    const result = await Effect.runPromise(persistPublication(state.repository, first))

    expect(result.reused).toBe(false)
    expect(state.calls).toEqual(['bars', 'sessions', 'manifest'])

    const retry = await Effect.runPromise(
      persistPublication(
        state.repository,
        publication('2026-07-17 22:35:00.000', 'c'.repeat(40), `sha256:${'d'.repeat(64)}`),
      ),
    )
    expect(retry.reused).toBe(true)
    expect(state.manifests[0].publisher_source_revision).toBe('a'.repeat(40))
    expect(state.calls).toEqual(['bars', 'sessions', 'manifest'])
  })

  test('recovers an exact partial stage and rejects mutation after finalization', async () => {
    const state = memoryRepository()
    const expected = publication()
    state.bars.push(expected.bars[0])
    await Effect.runPromise(persistPublication(state.repository, expected))
    expect(state.calls).toEqual(['sessions', 'manifest'])

    state.bars[0] = { ...state.bars[0], adjusted_close: '999.00000000' }
    const error = await Effect.runPromise(Effect.flip(persistPublication(state.repository, expected)))
    expect(error).toMatchObject({ _tag: 'PublicationError', phase: 'finalization' })
  })
})
