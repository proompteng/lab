import { expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'
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
import {
  persistenceDocumentFixture,
  cryptoPersistenceDocumentFixture,
} from '../../system-assessment/decision-persistence.test-support'
import { controlDocumentFixture } from '../../jev/control-document.test-support'
import { protectiveStopDocumentFixture, makeProtectiveStopDocumentFixture } from '../../jev/exit-document.test-support'
import { retainedV38ExecutionFixture, retainedV38ExecutionGoldens } from '../../jev/retained-v38-execution.test-support'
import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from '../../hash'
import { strictParseOptions } from '../../schemas'
import {
  CycleDecisionDocumentSchema,
  decodeRetainedJevExecutionDecisionDocument,
  makeExecutionDecisionDocument,
  makeObserveShadowDecisionDocument,
} from '../../shadow-decision-contract'
import { TargetPlanReason, TargetPlanStatus } from '../../target-planner/index'
import { makeStrategyProtocolHashResult } from '../../contracts'
import { defaultJevProtocolDocument, jevBehaviorHash } from '../../jev/protocol'

const projectionRow = (
  document: {
    readonly bindings: { readonly cycleId: string }
    readonly contentHash: string
    readonly createdAt: string
  },
  original: unknown = document,
): typeof CycleDecisionRow.Type => ({
  cycle_id: document.bindings.cycleId,
  decision_hash: document.contentHash,
  created_at: new Date(document.createdAt),
  document: original,
})

// Preserve the previous two-verifier acceptance boundary independently of the routing prefix.
const expectEquivalentProjection = (row: typeof CycleDecisionRow.Type) => {
  const current = Schema.decodeUnknownResult(CycleDecisionDocumentSchema, strictParseOptions)(row.document)
  const expected = Result.isSuccess(current) ? current : decodeRetainedJevExecutionDecisionDocument(row.document)
  const actual = verifyPerformanceDecisions([row])
  expect(actual).toEqual(
    expected._tag === 'Success'
      ? { verifiedRows: [{ ...row, document: expected.success }], unverifiedDecisionHashes: [] }
      : { verifiedRows: [], unverifiedDecisionHashes: [row.decision_hash] },
  )
  return actual
}

const withHash = <const Material extends object>(material: Material) => ({
  ...material,
  contentHash: Result.getOrThrow(canonicalHashV1Result(material)),
})

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
    const { document, bytes, golden } = retainedV38ExecutionFixture(index)
    expect(bytes.byteLength).toBe(golden.bytes)
    expect(sha256(bytes)).toBe(golden.canonicalHash)
    const row = projectionRow(document, JSON.parse(bytes.toString('utf8')))
    const verified = expectEquivalentProjection(row)
    expect(verified.unverifiedDecisionHashes).toEqual([])
    expect(verified.verifiedRows).toHaveLength(1)
    expect(verified.verifiedRows[0]?.document).toEqual(document)
    expect(Result.getOrThrow(canonicalJsonV1Result(verified.verifiedRows[0]?.document))).toBe(bytes.toString('utf8'))
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

test.each([
  { name: 'candidate entry', fixture: persistenceDocumentFixture },
  { name: 'candidate crypto entry', fixture: cryptoPersistenceDocumentFixture },
  { name: 'candidate exit', fixture: protectiveStopDocumentFixture },
  { name: 'ablation entry', fixture: controlDocumentFixture('ablation') },
  { name: 'momentum entry', fixture: controlDocumentFixture('momentum') },
  { name: 'ablation exit', fixture: makeProtectiveStopDocumentFixture('ablation') },
  { name: 'momentum exit', fixture: makeProtectiveStopDocumentFixture('momentum') },
])(
  'preserves current $name verification and rejects relabeled protocol evidence',
  async ({ fixture }) => {
    const document = await Effect.runPromise(fixture)
    expect(expectEquivalentProjection(projectionRow(document)).verifiedRows).toHaveLength(1)
    const { contentHash: _hash, ...material } = document
    const target = document.strategyDecision
    if (
      target === undefined ||
      target.schemaVersion === 'bayn.execution-flat-target.v1' ||
      target.schemaVersion === 'bayn.intraday-momentum.target.v3'
    )
      throw new Error('Expected current Jev evidence')
    const changed = withHash({
      ...material,
      strategyDecision: {
        ...target,
        evidence:
          target.schemaVersion === 'bayn.jev-exit-target.v5'
            ? { ...target.evidence, protocol: { ...target.evidence.protocol, schemaVersion: 'bayn.jev.protocol.v38' } }
            : {
                ...target.evidence,
                observation: {
                  ...target.evidence.observation,
                  protocol: { ...target.evidence.observation.protocol, schemaVersion: 'bayn.jev.protocol.v38' },
                },
              },
      },
    })
    expect(expectEquivalentProjection(projectionRow(document, changed)).verifiedRows).toEqual([])
    if (
      target.schemaVersion === 'bayn.entry-ablation-target.v1' ||
      target.schemaVersion === 'bayn.repeated-momentum-target.v1'
    ) {
      const mixedPolicy = withHash({
        ...material,
        strategyDecision: {
          ...target,
          policy: {
            ...target.policy,
            sharedProtocol: { ...target.policy.sharedProtocol, schemaVersion: 'bayn.jev.protocol.v38' },
          },
        },
      })
      expect(expectEquivalentProjection(projectionRow(document, mixedPolicy)).verifiedRows).toEqual([])
    }
  },
  15_000,
)

test.each(retainedV38ExecutionGoldens.map((_, index) => index))(
  'rejects malformed, mixed and relabeled v38 evidence after rehashing: %i',
  (index) => {
    const { document } = retainedV38ExecutionFixture(index)
    const { contentHash: _hash, ...material } = document
    const target = document.strategyDecision
    if (target === undefined || target.schemaVersion === 'bayn.execution-flat-target.v1')
      throw new Error('Expected retained Jev evidence')
    const changes = [
      { ...material, bindings: { ...document.bindings, strategyProtocolHash: 'f'.repeat(64) } },
      { ...material, bindings: { ...document.bindings, authorityGenerationHash: 'f'.repeat(64) } },
      { ...material, deltaRisk: [] },
      { ...material, unexpectedEvidence: true },
      { ...material, strategyDecision: { ...target, schemaVersion: 'bayn.unknown-target.v1' } },
      {
        ...material,
        strategyDecision: {
          ...target,
          schemaVersion:
            target.schemaVersion === 'bayn.jev-entry-target.v7'
              ? 'bayn.entry-ablation-target.v1'
              : 'bayn.jev-entry-target.v7',
        },
      },
      { ...material, strategyDecision: { ...target, evidence: {} } },
      ...['bayn.jev.protocol.v39', 'bayn.jev.protocol.v37', 'bayn.jev.protocol.unknown', null].map((schemaVersion) => ({
        ...material,
        strategyDecision: {
          ...target,
          evidence:
            target.schemaVersion === 'bayn.jev-exit-target.v5'
              ? { ...target.evidence, protocol: { ...target.evidence.protocol, schemaVersion } }
              : {
                  ...target.evidence,
                  observation: {
                    ...target.evidence.observation,
                    protocol: { ...target.evidence.observation.protocol, schemaVersion },
                  },
                },
        },
      })),
    ]
    for (const changed of changes)
      expect(expectEquivalentProjection(projectionRow(document, withHash(changed))).verifiedRows).toEqual([])
    if (
      target.schemaVersion === 'bayn.entry-ablation-target.v1' ||
      target.schemaVersion === 'bayn.repeated-momentum-target.v1'
    ) {
      const mixedPolicy = withHash({
        ...material,
        strategyDecision: {
          ...target,
          policy: {
            ...target.policy,
            sharedProtocol: { ...target.policy.sharedProtocol, schemaVersion: 'bayn.jev.protocol.v39' },
          },
        },
      })
      expect(expectEquivalentProjection(projectionRow(document, mixedPolicy)).verifiedRows).toEqual([])
    }
  },
  15_000,
)

test('rejects native and control identity swaps after rehashing', () => {
  const documents = [0, 2, 3].map((index) => retainedV38ExecutionFixture(index).document)
  for (const document of documents) {
    const { contentHash: _contentHash, ...material } = document
    for (const other of documents) {
      if (document.bindings.strategyProtocolHash === other.bindings.strategyProtocolHash) continue
      const changed = withHash({
        ...material,
        bindings: { ...material.bindings, strategyProtocolHash: other.bindings.strategyProtocolHash },
      })
      expect(expectEquivalentProjection(projectionRow(document, changed)).verifiedRows).toEqual([])
    }
  }
}, 15_000)

test('preserves flat, OBSERVE and non-Jev documents without a nested protocol discriminator', () => {
  const retained = retainedV38ExecutionFixture(1).document
  const bindings = {
    strategyName: 'jev',
    cycleId: retained.bindings.cycleId,
    strategyProtocolHash: retained.bindings.strategyProtocolHash,
    accountId: retained.bindings.accountId,
    snapshotId: retained.bindings.snapshotId,
    snapshotContentHash: retained.bindings.snapshotContentHash,
    snapshotFinalizedAt: retained.bindings.snapshotFinalizedAt,
    strategyDecisionHash: retained.bindings.strategyDecisionHash,
    policyHash: retained.bindings.policyHash,
    planningBrokerStateHash: retained.bindings.planningBrokerStateHash,
    reconciliationId: retained.bindings.reconciliationId,
    reconciliationHash: retained.bindings.reconciliationHash,
  }
  const targetPlan = withHash({
    schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
    inputHash: '1'.repeat(64),
    status: TargetPlanStatus.NoTrade,
    reason: TargetPlanReason.TargetsSatisfied,
    targets: [
      {
        symbol: 'AAPL',
        targetWeight: 0,
        referencePriceMicros: '100000000',
        currentQuantityAtoms: '0',
        targetQuantityAtoms: '0',
      },
    ],
    intentTargets: [],
    requiredReferenceBuyNotionalMicros: '0',
    availableBuyingPowerMicros: '0',
    residualBuyingPowerMicros: '0',
  })
  const { contentHash: outputHash, ...targetMaterial } = targetPlan
  const common = {
    dispatchable: false as const,
    bindings,
    targetPlan: { ...targetMaterial, outputHash },
    deltaRisk: [],
    createdAt: retained.createdAt,
    submissionCutoffAt: retained.submissionCutoffAt,
    expiresAt: retained.expiresAt,
  }
  const observe = Result.getOrThrow(
    makeObserveShadowDecisionDocument({ ...common, schemaVersion: 'bayn.observe-shadow-decision.v2', mode: 'OBSERVE' }),
  )
  expect(expectEquivalentProjection(projectionRow(observe)).verifiedRows).toHaveLength(1)
  const execution = {
    ...common,
    dispatchable: true,
    schemaVersion: 'bayn.paper-cycle-decision.v2' as const,
    mode: 'PAPER' as const,
    bindings: {
      ...bindings,
      qualificationRunId: retained.bindings.qualificationRunId,
      authorityGenerationHash: retained.bindings.authorityGenerationHash,
    },
    orderedIntentIds: [],
  }
  const flat = {
    schemaVersion: 'bayn.execution-flat-target.v1' as const,
    strategyName: 'jev',
    sessionDate: '2026-09-04',
    targetWeights: { AAPL: 0 },
    symbols: ['AAPL'],
    reason: 'mandate-close' as const,
  }
  const currentProtocolHash = Result.getOrThrow(
    makeStrategyProtocolHashResult({
      name: 'jev',
      behaviorHash: jevBehaviorHash,
      parameterHash: Result.getOrThrow(canonicalHashV1Result(defaultJevProtocolDocument)),
      parameterSchemaVersion: defaultJevProtocolDocument.schemaVersion,
    }),
  )
  for (const strategyProtocolHash of [retained.bindings.strategyProtocolHash, currentProtocolHash]) {
    const flatDocument = Result.getOrThrow(
      makeExecutionDecisionDocument({
        ...execution,
        bindings: {
          ...execution.bindings,
          strategyProtocolHash,
          strategyDecisionHash: Result.getOrThrow(canonicalHashV1Result(flat)),
        },
        strategyDecision: flat,
      }),
    )
    expect(Result.isSuccess(decodeRetainedJevExecutionDecisionDocument(flatDocument))).toBe(
      strategyProtocolHash === retained.bindings.strategyProtocolHash,
    )
    expect(expectEquivalentProjection(projectionRow(flatDocument)).verifiedRows).toHaveLength(1)
  }
  const nonJev = Result.getOrThrow(
    makeExecutionDecisionDocument({
      ...execution,
      bindings: { ...execution.bindings, strategyName: 'risk-balanced-trend' },
    }),
  )
  expect(expectEquivalentProjection(projectionRow(nonJev)).verifiedRows).toHaveLength(1)
})

test('keeps rejected identities sorted and deduplicated independently of protocol routing', () => {
  const { document } = retainedV38ExecutionFixture(1)
  const valid = projectionRow(document)
  const rejected = projectionRow(document, { ...document, contentHash: 'f'.repeat(64) })
  const rows = [
    { ...rejected, decision_hash: 'c'.repeat(64) },
    valid,
    { ...rejected, decision_hash: 'a'.repeat(64) },
    { ...rejected, decision_hash: 'c'.repeat(64) },
    { ...rejected, decision_hash: 'b'.repeat(64), document: { schemaVersion: 'unknown' } },
  ]
  const verified = verifyPerformanceDecisions(rows)
  expect(verified.unverifiedDecisionHashes).toEqual(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)])
  expect(verified.verifiedRows).toEqual([{ ...valid, document }])
})

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
    parent_broker_order_id: null,
    order_type: target.orderType,
    time_in_force: target.timeInForce,
    limit_price_micros: document.deltaRisk[0]?.limitPriceMicros ?? null,
    stop_price_micros: null,
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
    source_sequence: '1',
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
