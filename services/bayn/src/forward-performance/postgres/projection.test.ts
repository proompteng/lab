import { expect, test } from 'bun:test'
import { Effect, Schema } from 'effect'
import { streamingFixture } from '../../testing/streaming-market-fixture'

import { completedIntradayCycles } from '../intraday-cycle.test-support'
import {
  CycleDecisionRow,
  FillExecutionRow,
  IntentExecutionRow,
  MarketVolumeBindingRow,
  OrderExecutionRow,
} from './model'
import {
  executionEvidenceFromRows,
  indexExecutionEvidence,
  marketVolumeRequestsFromRows,
  verifyPerformanceDecisions,
} from './projection'
import { persistenceDocumentFixture } from '../../system-assessment/decision-persistence.test-support'
import { retainedV38ExecutionFixture, retainedV38ExecutionGoldens } from '../../jev/retained-v38-execution.test-support'

const countedRows = <T>(values: readonly T[]) => {
  let traversals = 0
  const rows = new Proxy(values, {
    get(target, key, receiver) {
      if (key === Symbol.iterator)
        return function* () {
          traversals++
          yield* target
        }
      return Reflect.get(target, key, receiver)
    },
  })
  return { rows, traversals: () => traversals }
}

test.each(retainedV38ExecutionGoldens.map((_, index) => index))(
  'projects genuine v38 execution evidence without losing historical performance coverage: %i',
  (index) => {
    const { document } = retainedV38ExecutionFixture(index)
    const row = {
      cycle_id: document.bindings.cycleId,
      decision_hash: document.contentHash,
      created_at: new Date(document.createdAt),
      document,
    }
    const verified = verifyPerformanceDecisions([row])
    expect(verified.unverifiedDecisionHashes).toEqual([])
    expect(verified.verifiedRows).toHaveLength(1)
    expect(verified.verifiedRows[0]?.document).toEqual(document)
    const evidence = executionEvidenceFromRows(verified.verifiedRows, indexExecutionEvidence([], [], []))
    expect(evidence).toHaveLength(document.targetPlan.intentTargets.length)
    expect(evidence[0]).toMatchObject({
      decisionDocumentHash: document.contentHash,
      plannedQuantityAtoms: document.targetPlan.intentTargets[0]!.quantityAtoms,
      fills: [],
    })
    const tampered = { ...row, document: { ...document, contentHash: 'f'.repeat(64) } }
    expect(verifyPerformanceDecisions([tampered, tampered])).toEqual({
      verifiedRows: [],
      unverifiedDecisionHashes: [document.contentHash],
    })
  },
)

test('streams planned decisions without rebuilding history indexes or changing ambiguous ownership', async () => {
  const document = await Effect.runPromise(persistenceDocumentFixture)
  const target = document.targetPlan.intentTargets[0]
  const intentId = document.orderedIntentIds[0]
  if (target === undefined || intentId === undefined) throw new Error('Expected a planned native entry')
  const at = new Date(document.createdAt)
  const common = {
    account_id: document.bindings.accountId,
    intent_id: intentId,
    client_order_id: 'synthetic-projection-order',
    symbol: target.symbol,
    side: target.side,
    quantity_atoms: target.quantityAtoms,
  }
  const intent = Schema.decodeUnknownSync(IntentExecutionRow)({
    ...common,
    cycle_id: document.bindings.cycleId,
    decision_hash: document.bindings.strategyDecisionHash,
    notional_limit_micros: '1',
    replan_generation_hash: null,
    terminal_outcome: 'FILLED',
    created_at: at,
    updated_at: at,
  })
  const order = Schema.decodeUnknownSync(OrderExecutionRow)({
    ...common,
    event_id: '1'.repeat(64),
    broker_order_id: 'synthetic-projection-broker-order',
    notional_micros: null,
    filled_quantity_atoms: target.quantityAtoms,
    status: 'FILLED',
    occurred_at: at,
    observed_at: at,
  })
  const fill = Schema.decodeUnknownSync(FillExecutionRow)({
    ...order,
    event_id: '2'.repeat(64),
    fill_id: 'synthetic-projection-fill',
    price_atoms: '100000000000',
    fee_micros: '0',
    source_timestamp: document.createdAt,
  })
  const row = verifyPerformanceDecisions([
    { cycle_id: document.bindings.cycleId, decision_hash: document.contentHash, created_at: at, document },
  ]).verifiedRows[0]
  if (row === undefined) throw new Error('Expected a verified native document')
  const intents = countedRows([intent])
  const orders = countedRows([order])
  const fills = countedRows([fill])
  const index = indexExecutionEvidence(intents.rows, orders.rows, fills.rows)
  for (let i = 0; i < 100; i++) {
    const projected = executionEvidenceFromRows([row], index)
    expect(projected[0]).toMatchObject({
      intentId,
      decisionDocumentHash: document.contentHash,
      plannedQuantityAtoms: target.quantityAtoms,
      terminalOrder: { brokerOrderId: order.broker_order_id, filledQuantityAtoms: target.quantityAtoms },
      fills: [{ fillId: fill.fill_id, quantityAtoms: target.quantityAtoms }],
    })
    expect(executionEvidenceFromRows([], index)).toEqual([])
  }
  expect([intents.traversals(), orders.traversals(), fills.traversals()]).toEqual([1, 1, 1])
  const ambiguous = indexExecutionEvidence([intent, intent], [order, order], [fill])
  expect(executionEvidenceFromRows([row], ambiguous)[0]).toMatchObject({ intentId: '', fills: [] })
})

test('retains the native streaming cut when projecting a completed cycle market-volume request', () => {
  const { snapshot } = streamingFixture()
  const binding = Schema.decodeUnknownSync(MarketVolumeBindingRow)({
    cycle_id: 'a'.repeat(64),
    snapshot_id: snapshot.manifest.snapshotId,
    execution_session_date: snapshot.manifest.sessionDate,
    execution_open_at: new Date('2026-09-04T13:30:00.000Z'),
    execution_close_at: new Date('2026-09-04T20:00:00.000Z'),
    manifest: snapshot.manifest,
  })
  const requests = marketVolumeRequestsFromRows(
    [{ cycleId: binding.cycle_id, symbol: 'AAPL' }],
    [binding],
    '2026-09-04T21:00:00.000Z',
  )
  expect(requests).toEqual([
    {
      cycleId: binding.cycle_id,
      decisionSnapshotId: snapshot.manifest.snapshotId,
      decisionSnapshotAsOfSession: snapshot.manifest.sessionDate,
      symbol: 'AAPL',
      executionSessionDate: snapshot.manifest.sessionDate,
      windowOpenedAt: '2026-09-04T13:30:00.000Z',
      windowClosedAt: '2026-09-04T20:00:00.000Z',
      evidenceCutoffAt: '2026-09-04T21:00:00.000Z',
      sourceFeed: 'iex',
      decisionManifest: snapshot.manifest,
    },
  ])
})

test.each([
  { schemaVersion: 'unsupported-historical-decision' },
  {
    schemaVersion: 'bayn.paper-cycle-decision.v2',
    strategyDecision: { schemaVersion: 'bayn.jev-exit-target.v1', reason: 'JEV_EXIT' },
  },
])('retains unverified historical decision identities without aborting accounting reads: %j', (document) => {
  const row = Schema.decodeUnknownSync(CycleDecisionRow)({
    cycle_id: 'a'.repeat(64),
    decision_hash: 'b'.repeat(64),
    document,
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
