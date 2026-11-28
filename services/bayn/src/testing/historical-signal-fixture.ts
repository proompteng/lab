import type { HistoricalSignalSnapshotConfig } from '../config/historical-signal'

export const historicalSignalConfig: HistoricalSignalSnapshotConfig = {
  snapshotId: '1'.repeat(64),
  publicationAsOf: '2026-08-28',
  calendarVersion: 'alpaca-us-equity-calendar-v1',
  bounds: {
    schemaVersion: 'bayn.evaluation-bounds.v1',
    dataStart: '2026-08-28',
    dataEnd: '2026-08-28',
    lookbackStart: '2026-08-28',
    evaluationStart: '2026-08-28',
    evaluationEnd: '2026-08-28',
  },
}
