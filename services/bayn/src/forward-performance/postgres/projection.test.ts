import { expect, test } from 'bun:test'
import { Schema } from 'effect'

import { completedIntradayCycles } from '../intraday-cycle.test-support'
import { MarketVolumeBindingRow } from './model'
import { marketVolumeRequestsFromRows } from './projection'

test('binds the completed IWM and NVDA cycles to their native intraday evidence', () => {
  for (const cycle of completedIntradayCycles) {
    const binding = Schema.decodeUnknownSync(MarketVolumeBindingRow)({
      cycle_id: cycle.cycleId,
      snapshot_id: cycle.manifest.snapshotId,
      execution_session_date: cycle.session,
      execution_open_at: new Date(cycle.windowOpenedAt),
      execution_close_at: new Date(cycle.windowClosedAt),
      manifest: cycle.manifest,
    })
    const symbol = cycle.session === '2026-09-10' ? 'IWM' : 'NVDA'
    const requests = marketVolumeRequestsFromRows(
      [
        {
          cycleId: cycle.cycleId,
          decisionDocumentHash: 'a'.repeat(64),
          decisionHash: 'b'.repeat(64),
          decisionCreatedAt: cycle.manifest.observedAt,
          intentId: 'c'.repeat(64),
          accountId: 'test-account',
          symbol,
          side: 'BUY',
          fills: [],
        },
      ],
      [binding],
      `${cycle.session}T21:00:00.000Z`,
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      cycleId: cycle.cycleId,
      decisionSnapshotId: cycle.manifest.snapshotId,
      symbol,
      sourceFeed: 'iex',
      windowOpenedAt: new Date(cycle.windowOpenedAt).toISOString(),
      windowClosedAt: new Date(cycle.windowClosedAt).toISOString(),
      evidenceCutoffAt: `${cycle.session}T21:00:00.000Z`,
    })
  }
})
