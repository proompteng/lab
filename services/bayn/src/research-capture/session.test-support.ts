import { Effect } from 'effect'
import { canonicalHashV1 } from '../hash'
import type { StreamingUniverse } from '../market-data/streaming/raw-events'
import { ResearchCaptureFailure, type ResearchCaptureBytes } from './capture'
import type { ResearchCaptureObject, ResearchCaptureObjectStore } from './export'
import type { ResearchCaptureStore } from './recorder'
import type { ResearchCaptureSessionConfig } from './session-config'

export const sessionStart = Date.parse('2026-10-05T13:29:50.000Z')
export const sessionUniverse: StreamingUniverse = {
  universeId: 'session-fixture',
  universeSymbolHash: '0'.repeat(64),
  symbols: ['AAPL'],
  topics: { bars: 'bars', quotes: 'quotes', trades: 'trades', features: 'features' },
}
const calendar = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: '2026-10-05', end: '2026-10-05' },
  timeZone: 'UTC' as const,
  sessions: [{ date: '2026-10-05', openAt: '2026-10-05T13:30:00.000Z', closeAt: '2026-10-05T13:30:10.000Z' }],
} as const
export const sessionConfig: ResearchCaptureSessionConfig = {
  captureId: 'one-session',
  intervalId: 'regular-session',
  coverageStartMs: sessionStart + 10_000,
  coverageEndMs: sessionStart + 20_000,
  bootstrapDeadlineMs: sessionStart + 5000,
  stopAtMs: sessionStart + 25_000,
  universeHash: canonicalHashV1(sessionUniverse),
  expectedPartitions: Object.values(sessionUniverse.topics)
    .sort()
    .map((topic) => ({ topic, partition: 0 })),
  calendarSnapshotId: 'b'.repeat(64),
  calendarObservedAt: '2026-10-02T18:43:17.644Z',
  calendarHash: canonicalHashV1(calendar),
  maximumObjectBytes: 1024 * 1024,
  maximumSqlBytes: 1024 * 1024,
  sessionDate: '2026-10-05',
  calendar: { ...calendar, normalizedResponseHash: canonicalHashV1(calendar) },
}
export const sessionMemory = () => {
  const chunks: ResearchCaptureBytes[] = []
  const seals: ResearchCaptureBytes[] = []
  const objects: ResearchCaptureObject[] = []
  const writes: string[] = []
  const store: ResearchCaptureStore = {
    append: (bytes) =>
      Effect.suspend(() => {
        const ordinal = JSON.parse(bytes.payload).chunkOrdinal as number
        writes.push('sql-chunk')
        if (chunks[ordinal] !== undefined && chunks[ordinal]?.payload !== bytes.payload)
          return Effect.fail(new ResearchCaptureFailure({ message: 'Existing capture identity conflicts' }))
        chunks[ordinal] = bytes
        return Effect.void
      }),
    seal: (bytes) =>
      Effect.sync(() => {
        writes.push('sql-seal')
        seals.push(bytes)
      }),
  }
  const objectStore: ResearchCaptureObjectStore = {
    putVerified: (object) =>
      Effect.sync(() => {
        writes.push('object')
        objects.push(object)
      }),
  }
  return { chunks, seals, objects, writes, store, objectStore }
}
