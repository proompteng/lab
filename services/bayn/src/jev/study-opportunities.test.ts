import { beforeAll, describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { intentPlanSchemaVersion, OrderSide } from '../execution/contracts'
import { makeExecutionIntentFromDecodedPlan } from '../execution/intents/domain'
import { MutationEventType } from '../execution/mutations/model'
import { canonicalHashV1Result } from '../hash'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { matchedCommittedDecisionFixture } from '../intraday-replay/matched-entry.test-support'
import { makeInferenceExpenseQuotes, inferenceExpenseRateCard } from '../inference-expense'
import { expenseRateFixture, expenseSourceFixture } from '../inference-expense.test-support'
import {
  entryEvaluationRequestFixture,
  entryCompletionFixture,
  stagedCheckpointFixture,
} from './entry-inference.test-support'
import { makeJevEvaluationReceipt, JevOutcome } from './evidence'
import { makeJevResolution, JevResolutionStatus } from './resolution'
import { nativeJevDecisionEvidence, nativeJevFixture } from './native.test-support'
import { defaultJevProtocolDocument } from './protocol'
import { decideJevEntry } from './decision'
import {
  describeJevStudyBatch,
  makeJevStudyCycleOpportunity,
  makeJevStudyInferenceOpportunity,
} from './study-opportunities'
import { verifyJevStudyExportRow } from './study-export'

const emptySources = () => ({ decisions: [], intents: [], orders: [], fills: [], mutations: [], transactions: [] })
const native = nativeJevFixture()
const accountId = native.portfolio.brokerState.account.accountId
const sessionDate = native.snapshot.manifest.sessionDate
const asOf = `${sessionDate}T23:59:59.000Z`
const retained = async (supportsEntry: boolean, capital = '1', unfunded = false) => {
  const fixture = unfunded
    ? nativeJevFixture(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        Object.fromEntries(defaultJevProtocolDocument.candidateSymbols.map((symbol) => [symbol, -0.1])),
        undefined,
        false,
      )
    : native
  const evidence = nativeJevDecisionEvidence(fixture, supportsEntry)
  const target = Result.getOrThrow(decideJevEntry(evidence))
  const { candidateEvidencePolicy: _policy, candidateSymbols: _symbols, ...query } = fixture.query
  const pricing =
    capital === '1'
      ? fixture.snapshot
      : streamingFixtureFromRaw(fixture.snapshot, {
          ...query,
          observedAt: evidence.decidedAt,
          symbols: target.selectedSymbols,
          purpose: IntradaySnapshotPurpose.EntryPricing,
        }).snapshot
  const document = await Effect.runPromise(matchedCommittedDecisionFixture(fixture, evidence, capital, pricing, 3))
  const batch = Result.getOrThrow(
    describeJevStudyBatch(
      Result.getOrThrow(
        verifyJevStudyExportRow(
          {
            batchId: evidence.batchPlan.batchId,
            cycleId: evidence.batchPlan.cycleId,
            observationHash: evidence.batchPlan.observationHash,
            observation: evidence.observation,
            plan: evidence.batchPlan,
            result: evidence.batchResult,
          },
          sessionDate,
          accountId,
        ),
      ),
    ),
  )
  return {
    document,
    batch,
    cycle: {
      cycleId: document.bindings.cycleId,
      protocolHash: document.bindings.strategyProtocolHash,
      state: document.targetPlan.status === 'NO_TRADE' ? 'NO_TRADE' : 'ACTIVE',
      decisionHash: document.contentHash,
    },
    sources: {
      ...emptySources(),
      decisions: [
        {
          cycle_id: document.bindings.cycleId,
          decision_hash: document.contentHash,
          document,
          created_at: new Date(document.createdAt),
        },
      ],
    },
  }
}
let selected: Awaited<ReturnType<typeof retained>>
let abstained: Awaited<ReturnType<typeof retained>>
let planned: Awaited<ReturnType<typeof retained>>
let unavailable: Awaited<ReturnType<typeof retained>>
beforeAll(async () => {
  selected = await retained(true)
  abstained = await retained(false)
  planned = await retained(true, '100000000000')
  unavailable = await retained(true, '1', true)
}, 30_000)
const report = (f: typeof selected, sources: unknown = f.sources) =>
  makeJevStudyCycleOpportunity(f.cycle, sources, [f.batch], accountId, sessionDate, asOf)

describe('source-backed opportunity denominator', () => {
  test('keeps positive selections with zero allocation distinct from real abstentions', () => {
    const positive = Result.getOrThrow(report(selected))
    const abstention = Result.getOrThrow(report(abstained))
    expect(positive).toMatchObject({
      disposition: 'SELECTED_ZERO_ALLOCATION',
      selectedSymbols: ['AAPL'],
      targetPlanStatus: 'NO_TRADE',
      joinCoverage: 'COMPLETE_FOR_RECORDED_CYCLE_ROWS',
      allInProfitMicros: null,
      brokerFeeCoverage: 'UNKNOWN',
    })
    expect(abstention).toMatchObject({ disposition: 'ABSTAINED', selectedSymbols: [], targetPlanStatus: 'NO_TRADE' })
    expect(positive.batches[0]?.candidates).toHaveLength(selected.batch.candidates.length)
    expect(positive.independentlyVerifiedLedger).toBe(false)
    expect(selected.batch.protocolHash).not.toBe(selected.cycle.protocolHash)
    expect(Result.getOrThrow(report(unavailable)).disposition).toBe('NO_SELECTION')
    expect(Result.getOrThrow(report(unavailable)).selectedSymbols).toEqual([])
  })

  test('keeps no-batch blocked cycles and missing decision evidence visible', () => {
    const cycle = { ...selected.cycle, state: 'BLOCKED', decisionHash: null }
    expect(
      Result.getOrThrow(makeJevStudyCycleOpportunity(cycle, emptySources(), [], accountId, sessionDate, asOf)),
    ).toMatchObject({ disposition: 'NO_RECORDED_DECISION', batches: [], selectedSymbols: null })
    const missing = Result.getOrThrow(report(selected, emptySources()))
    expect(missing.disposition).toBe('MISSING_DECISION')
    expect(missing.joinCoverage).toBe('INCOMPLETE')
    expect(missing.gaps).toContainEqual({ code: 'MISSING_CYCLE_DECISION', sourceId: selected.document.contentHash })
  })

  test('a planned decision with no persisted intent remains selected and incomplete', () => {
    const actual = Result.getOrThrow(report(planned))
    expect(actual.disposition).toBe('SELECTED_PLANNED')
    expect(actual.gaps.some((gap) => gap.code === 'MISSING_PLANNED_INTENT')).toBe(true)
    expect(actual.intents).toEqual([])
  })

  test('rejects forged decisions, substituted accounts/protocols and duplicate source identities', () => {
    const row = selected.sources.decisions[0]
    if (row === undefined) throw new Error('Missing fixture decision')
    for (const decisions of [
      [row, row],
      [{ ...row, decision_hash: 'f'.repeat(64) }],
      [{ ...row, document: { ...row.document, contentHash: 'f'.repeat(64) } }],
    ])
      expect(Result.isFailure(report(selected, { ...selected.sources, decisions }))).toBe(true)
    expect(
      Result.isFailure(
        makeJevStudyCycleOpportunity(
          selected.cycle,
          selected.sources,
          [selected.batch],
          'foreign-account',
          sessionDate,
          asOf,
        ),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        makeJevStudyCycleOpportunity(
          { ...selected.cycle, protocolHash: 'f'.repeat(64) },
          selected.sources,
          [selected.batch],
          accountId,
          sessionDate,
          asOf,
        ),
      ),
    ).toBe(true)
  })

  test('rejects execution activity in NO_TRADE rather than silently dropping it', () => {
    expect(Result.isFailure(report(selected, { ...selected.sources, fills: [fillFixture()] }))).toBe(true)
  })
})

const fillFixture = () => ({
  event_id: 'd'.repeat(64),
  fill_id: 'fill-1',
  broker_order_id: 'order-1',
  client_order_id: 'client-1',
  intent_id: 'e'.repeat(64),
  account_id: accountId,
  symbol: 'AAPL',
  side: OrderSide.Buy,
  quantity_atoms: '1000000000',
  price_atoms: '100000000000',
  fee_micros: '0',
  source_timestamp: `${sessionDate}T15:00:00.000000000Z`,
  occurred_at: new Date(`${sessionDate}T15:00:00.000Z`),
  observed_at: new Date(`${sessionDate}T15:00:00.001Z`),
})

const executionFixture = () => {
  const document = planned.document
  const target = document.targetPlan.intentTargets[0]
  const risk = document.deltaRisk[0]
  const intentId = document.orderedIntentIds[0]
  if (target === undefined || risk === undefined || intentId === undefined)
    throw new Error('Expected a planned fixture')
  const expected = Result.getOrThrow(
    makeExecutionIntentFromDecodedPlan(
      {
        schemaVersion: intentPlanSchemaVersion,
        ...target,
        notionalLimitMicros: risk.notionalLimitMicros,
        limitPriceMicros: risk.limitPriceMicros,
        ...(risk.protection === undefined ? {} : { protection: risk.protection }),
      },
      document.bindings.authorityGenerationHash,
    ),
  )
  const intent = {
    intent_id: intentId,
    account_id: accountId,
    client_order_id: expected.clientOrderId,
    cycle_id: document.bindings.cycleId,
    decision_hash: document.bindings.strategyDecisionHash,
    symbol: target.symbol,
    side: target.side,
    quantity_atoms: target.quantityAtoms,
    notional_limit_micros: risk.notionalLimitMicros,
    replan_generation_hash: null,
    terminal_outcome: 'CANCELED',
    created_at: new Date(document.createdAt),
    updated_at: new Date(`${sessionDate}T15:01:00.000Z`),
    authority_generation_hash: document.bindings.authorityGenerationHash,
    state: 'TERMINAL',
    protection: risk.protection ?? null,
  }
  const commonOrder = {
    schema_version: 'bayn.order.v3',
    parent_broker_order_id: null,
    order_type: target.orderType,
    time_in_force: target.timeInForce,
    limit_price_micros: risk.limitPriceMicros,
    stop_price_micros: null,
    event_id: 'a'.repeat(64),
    source_sequence: '1',
    broker_order_id: 'order-1',
    client_order_id: intent.client_order_id,
    intent_id: intentId,
    account_id: accountId,
    symbol: target.symbol,
    side: target.side,
    quantity_atoms: target.quantityAtoms,
    notional_micros: null,
    filled_quantity_atoms: '0',
    status: 'NEW',
    occurred_at: new Date(document.createdAt),
    observed_at: new Date(document.createdAt),
  }
  const orders = [
    commonOrder,
    {
      ...commonOrder,
      event_id: 'b'.repeat(64),
      source_sequence: '2',
      status: 'CANCELED',
      occurred_at: intent.updated_at,
      observed_at: intent.updated_at,
    },
  ]
  return { ...planned.sources, intents: [intent], orders }
}

describe('execution source joins', () => {
  test.each([
    { client_order_id: 'foreign-client' },
    { symbol: 'FOREIGN' },
    { side: OrderSide.Sell },
    { quantity_atoms: '1' },
    { notional_limit_micros: '1' },
    { created_at: new Date(`${sessionDate}T15:00:00.000Z`) },
    { replan_generation_hash: 'f'.repeat(64) },
  ])('rejects an intent changed beneath its original decision and authority: %p', (change) => {
    const source = executionFixture()
    expect(
      Result.isFailure(
        report(planned, {
          ...source,
          intents: source.intents.map((intent) => ({ ...intent, ...change })),
        }),
      ),
    ).toBe(true)
  })

  test('retains intermediate and terminal order observations and accepted/cancel events', () => {
    const source = executionFixture()
    const intent = source.intents[0]
    if (intent === undefined) throw new Error('Missing intent')
    const event = (kind: 'SUBMIT_ACCEPTED' | 'CANCEL_ACCEPTED', id: string) => ({
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: id.repeat(64),
      mutationId: id.repeat(64),
      intentId: intent.intent_id,
      sequence: 2,
      operation: kind === 'SUBMIT_ACCEPTED' ? 'SUBMIT' : 'CANCEL',
      eventType: kind,
      requestHash: 'f'.repeat(64),
      consistencyDelayMs: 1000,
      brokerOrderId: 'order-1',
      occurredAt: intent.updated_at.toISOString(),
    })
    const actual = Result.getOrThrow(
      report(planned, { ...source, mutations: [event('SUBMIT_ACCEPTED', 'a'), event('CANCEL_ACCEPTED', 'b')] }),
    )
    expect(actual.orders.map((row) => row.status)).toEqual(['NEW', 'CANCELED'])
    expect(actual.mutations.map((row) => row.eventType)).toEqual([
      MutationEventType.SubmitAccepted,
      MutationEventType.CancelAccepted,
    ])
    expect(actual.intents[0]?.terminalOutcome).toBe('CANCELED')
    expect(actual.fills).toEqual([])
    expect(actual.allInProfitMicros).toBeNull()
  })

  test.each([
    { client_order_id: 'foreign-client' },
    { symbol: 'FOREIGN' },
    { side: OrderSide.Sell },
    { account_id: 'foreign-account' },
  ])('rejects an order whose source identity drifts despite a matching intent ID: %p', (change) => {
    const source = executionFixture()
    expect(
      Result.isFailure(report(planned, { ...source, orders: source.orders.map((row) => ({ ...row, ...change })) })),
    ).toBe(true)
  })

  test.each([
    { client_order_id: 'foreign-client' },
    { symbol: 'FOREIGN' },
    { side: OrderSide.Sell },
    { intent_id: 'f'.repeat(64) },
  ])('rejects a fill with mismatched broker/client/side ownership: %p', (change) => {
    const source = executionFixture()
    const intent = source.intents[0]
    if (intent === undefined) throw new Error('Missing intent')
    const fill = { ...fillFixture(), intent_id: intent.intent_id, client_order_id: intent.client_order_id, ...change }
    expect(Result.isFailure(report(planned, { ...source, fills: [fill] }))).toBe(true)
  })

  test('retains missing joins explicitly and rejects malformed atomic amounts', () => {
    const cycle = { ...planned.cycle, state: 'ACTIVE' }
    const fill = fillFixture()
    const actual = Result.getOrThrow(
      makeJevStudyCycleOpportunity(
        cycle,
        {
          ...emptySources(),
          fills: [fill],
        },
        [],
        accountId,
        sessionDate,
        asOf,
      ),
    )
    expect(actual.gaps.map((gap) => gap.code)).toEqual([
      'MISSING_CYCLE_DECISION',
      'MISSING_FILL_INTENT',
      'MISSING_FILL_ORDER',
      'UNACCOUNTED_FILL',
    ])
    expect(actual.joinCoverage).toBe('INCOMPLETE')
    expect(
      Result.isFailure(
        makeJevStudyCycleOpportunity(
          cycle,
          {
            ...emptySources(),
            fills: [{ ...fill, fee_micros: 'not-an-integer' }],
          },
          [],
          accountId,
          sessionDate,
          asOf,
        ),
      ),
    ).toBe(true)
  })
})

const inferenceFixture = (options: Parameters<typeof expenseSourceFixture>[0] = {}) => {
  const source = expenseSourceFixture(options)
  const { accountId, sessionDate, asOf, ...request } = source
  const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(source, expenseRateFixture)).map((quote) => ({
    quote,
    verifiedAt: asOf,
  }))
  return { source, scope: { accountId, sessionDate, asOf }, request, quotes }
}
describe('complete inference opportunity cost coverage', () => {
  test.each([
    [{}, 1, 0, 0, '42000'],
    [{ rejected: true }, 1, 0, 0, '42000'],
    [{ notDispatched: true }, 0, 1, 0, '0'],
    [{ missing: true }, 0, 0, 1, '0'],
    [{ state: { task: { decisionPurpose: 'MANAGE' } } }, 1, 0, 0, '42000'],
  ] as const)(
    'keeps received, failed, skipped, missing and management stages separate: %p',
    (options, metered, skipped, unknown, known) => {
      const f = inferenceFixture(options)
      const actual = Result.getOrThrow(
        makeJevStudyInferenceOpportunity(f.request, f.quotes, f.scope, new Set([f.request.cycleId]), []),
      )
      expect(actual).toMatchObject({
        logicalRequestCount: 1,
        stageObligationCount: 1,
        meteredStageCount: metered,
        notDispatchedStageCount: skipped,
        unknownUsageStageCount: unknown,
        providerCallCount: null,
        costCoverage: { knownEstimatedCostPicoUsd: known },
        invoiceReconciled: false,
      })
      expect(actual.candidateJoin).toBe('MISSING_BATCH_CANDIDATE')
      expect(actual.source).toEqual(f.request)
    },
  )

  test('preserves outside-cycle costs and missing/foreign/conflicting frozen evidence', () => {
    const f = inferenceFixture()
    const actual = Result.getOrThrow(makeJevStudyInferenceOpportunity(f.request, f.quotes, f.scope, new Set(), []))
    expect(actual.cycleJoin).toBe('OUTSIDE_JEV_CYCLE_INVENTORY')
    expect(actual.costCoverage.knownEstimatedCostPicoUsd).toBe('42000')
    expect(
      Result.getOrThrow(makeJevStudyInferenceOpportunity(f.request, [], f.scope, new Set(), [])).costCoverage
        .completeMeteredCoverage,
    ).toBe(false)
    expect(
      Result.isFailure(makeJevStudyInferenceOpportunity(f.request, [...f.quotes, ...f.quotes], f.scope, new Set(), [])),
    ).toBe(true)
    expect(
      Result.isFailure(
        makeJevStudyInferenceOpportunity(f.request, f.quotes, { ...f.scope, accountId: 'foreign' }, new Set(), []),
      ),
    ).toBe(true)
  })

  test('retains the current two-stage graph without presenting stage obligations as paid calls', () => {
    const request = entryEvaluationRequestFixture('2026-11-09T15:30:32.000Z')
    const completion = entryCompletionFixture(request)
    const receipt = Result.getOrThrow(
      makeJevEvaluationReceipt(request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v3',
        requestId: request.requestId,
        startedAt: request.observedAt,
        completedAt: completion.completedAt,
        outcome: { status: JevOutcome.Completed, completion },
      }),
    )
    const resolution = Result.getOrThrow(
      makeJevResolution(request, receipt, {
        schemaVersion: 'bayn.jev-evaluation-resolution.v1',
        requestId: request.requestId,
        status: JevResolutionStatus.Recorded,
        receiptHash: receipt.receiptHash,
      }),
    )
    const source = {
      accountId: 'current-stage-test',
      sessionDate: '2026-11-09' as const,
      asOf: request.expiresAt,
      requestId: request.requestId,
      cycleId: request.cycleId,
      authorityGenerationHash: request.authorityGenerationHash,
      request,
      receipt,
      resolution,
      handoff: completion.handoff,
      stagedCheckpoint: stagedCheckpointFixture(request),
    }
    const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard)).map((quote) => ({
      quote,
      verifiedAt: source.asOf,
    }))
    const { accountId, sessionDate, asOf, ...original } = source
    const actual = Result.getOrThrow(
      makeJevStudyInferenceOpportunity(original, quotes, { accountId, sessionDate, asOf }, new Set(), []),
    )
    expect(actual.stageObligationCount).toBe(2)
    expect(actual.meteredStageCount + actual.notDispatchedStageCount + actual.unknownUsageStageCount).toBe(2)
    expect(actual.providerCallCount).toBeNull()
    expect(actual.costCoverage.completeMeteredCoverage).toBe(true)
    const candidate = {
      symbol: request.symbol,
      planStatus: 'REQUESTED' as const,
      exclusionReason: null,
      requestId: request.requestId,
      requestFingerprint: Result.getOrThrow(canonicalHashV1Result(request)),
      resultStatus: null,
      receiptHash: null,
      resolutionHash: null,
    }
    expect(
      Result.getOrThrow(
        makeJevStudyInferenceOpportunity(original, quotes, { accountId, sessionDate, asOf }, new Set(), [candidate]),
      ).candidateJoin,
    ).toBe('MATCHED')
    expect(
      Result.isFailure(
        makeJevStudyInferenceOpportunity(original, quotes, { accountId, sessionDate, asOf }, new Set(), [
          { ...candidate, requestFingerprint: 'f'.repeat(64) },
        ]),
      ),
    ).toBe(true)
  })
})
