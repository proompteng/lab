import { expect, test } from 'bun:test'
import { Schema } from 'effect'

import { completedIntradayCycles } from '../intraday-cycle.test-support'
import { CycleDecisionRow, MarketVolumeBindingRow } from './model'
import { marketVolumeRequestsFromRows, verifyPerformanceDecisions } from './projection'

test('retains unverified historical decision identities without aborting accounting reads', () => {
  const row = Schema.decodeUnknownSync(CycleDecisionRow)({
    cycle_id: 'a'.repeat(64),
    decision_hash: 'b'.repeat(64),
    document: { schemaVersion: 'unsupported-historical-decision' },
    created_at: new Date('2026-09-10T19:50:00.000Z'),
  })
  expect(verifyPerformanceDecisions([row, row])).toEqual({
    verifiedRows: [],
    unverifiedDecisionHashes: ['b'.repeat(64)],
  })
})

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
          symbol,
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
