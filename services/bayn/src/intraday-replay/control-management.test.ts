import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { OrderSide, OrderStatus } from '../execution/contracts'
import { canonicalHashV1 } from '../hash'
import { applyControlOrder, ControlExit, createControlPortfolio } from './control-portfolio'
import { JevBatchPlanVersion, JevCandidatePlanStatus } from '../jev/batch'
import { nativeJevBatchResult, nativeJevFixture } from '../jev/native.test-support'
import { decideJevManagement, JevManagementAction } from '../jev/decision'
import { makeJevObservation } from '../jev/observation'
import { decodeJevPortfolio, JevPurpose } from '../jev/portfolio'
import { makeJevTradingSignalBatch, reproduceJevTradingSignalBatchEvidence } from '../jev/trading-signals'
import { reconciledStateHash } from '../reconciliation'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { applyControlManagementDecision, makeControlManagementBatch } from './control-management'

const fixture = nativeJevFixture(JevPurpose.Manage)
const observedAtMs = Date.parse(fixture.snapshot.manifest.observedAt)
const quote = (atMs: number, askSize = 5, askPrice = 100, bidSize = 1000) => {
  const original = fixture.snapshot.latestQuotes['AAPL']
  if (original === undefined) throw new Error('Missing fixture quote')
  const value = {
    ...original,
    bidPrice: askPrice - 0.01,
    askPrice,
    bidSize,
    askSize,
    eventAt: new Date(atMs).toISOString(),
    ingestedAt: new Date(atMs).toISOString(),
  }
  return { value, recordHash: canonicalHashV1(value), availableAtMs: atMs, sequence: 1 }
}
const input = (): Parameters<typeof makeControlManagementBatch>[0] => ({
  runId: '3'.repeat(64),
  entryDecisionHash: '4'.repeat(64),
  beforeEntry: Result.getOrThrow(createControlPortfolio('100000000000')),
  entryOrder: {
    symbol: 'AAPL',
    side: OrderSide.Buy,
    quantityMicros: 10_000_000n,
    protocol: fixture.protocol,
    assumptions: { latencyMs: 100, slippageBps: 0, availableLiquidityPpm: 1_000_000, feeMultiplierPpm: 1_000_000 },
    decisionAtMs: observedAtMs - 180_100,
    arrivalAtMs: observedAtMs - 180_000,
    decisionQuote: quote(observedAtMs - 180_100),
    arrivalQuote: quote(observedAtMs - 180_000),
  },
  snapshot: fixture.snapshot,
})
const prepared = (i = input()) => Result.getOrThrow(makeControlManagementBatch(i))

const managedDecision = (value = prepared(), action = 'exit', probability = 0.8) => {
  const at = new Date(observedAtMs + 100).toISOString()
  return Result.getOrThrow(
    decideJevManagement({
      observation: value.observation,
      batchPlan: value.batch,
      batchResult: nativeJevBatchResult(value.batch, at, () => action, probability),
      decidedAt: at,
    }),
  )
}

test('recorded model exit persists across partial IOC fills without another inference', () => {
  const i = input()
  const value = prepared(i)
  const result = Result.getOrThrow(
    applyControlManagementDecision({
      portfolio: value.controlPortfolio,
      expectedBatchId: value.batch.batchId,
      decision: managedDecision(value),
      committedAtMs: observedAtMs + 101,
    }),
  )
  expect(result.action).toBe(JevManagementAction.Exit)
  if (result.action !== JevManagementAction.Exit) throw new Error('Expected model exit')
  expect(result.target.commitDeadlineAt).toBe(value.batch.expiresAt)
  expect(result.portfolio.inventory).toMatchObject({ status: 'EXITING', reason: ControlExit.Model })
  const sellAt = observedAtMs + 200
  const partial = Result.getOrThrow(
    applyControlOrder(result.portfolio, {
      ...i.entryOrder,
      side: OrderSide.Sell,
      quantityMicros: 5_000_000n,
      decisionAtMs: sellAt,
      arrivalAtMs: sellAt + 100,
      decisionQuote: quote(sellAt),
      arrivalQuote: quote(sellAt + 100, 5, 100, 2),
    }),
  ).portfolio
  expect(partial.ledger.positions[0]?.quantityMicros).toBe('3000000')
  expect(partial.episodes).toHaveLength(0)
  expect(partial.inventory).toEqual(result.portfolio.inventory)
  const retryAt = Date.parse(value.batch.expiresAt) + 5_000
  const closed = Result.getOrThrow(
    applyControlOrder(partial, {
      ...i.entryOrder,
      side: OrderSide.Sell,
      quantityMicros: 3_000_000n,
      decisionAtMs: retryAt,
      arrivalAtMs: retryAt + 100,
      decisionQuote: quote(retryAt),
      arrivalQuote: quote(retryAt + 100),
    }),
  ).portfolio
  expect(closed.inventory.status).toBe('FLAT')
  expect(closed.ledger.positions).toHaveLength(0)
  expect(closed.episodes).toHaveLength(1)
  expect(closed.episodes[0]?.reason).toBe(ControlExit.Model)
  expect(closed.ledger.fills.map((fill) => fill.quantityMicros)).toEqual(['5000000', '2000000', '3000000'])
})

test('hold and below-threshold exit responses preserve the held control', () => {
  const value = prepared()
  for (const [action, probability] of [
    ['hold', 0.8],
    ['exit', 0.6],
  ] as const) {
    const result = Result.getOrThrow(
      applyControlManagementDecision({
        portfolio: value.controlPortfolio,
        expectedBatchId: value.batch.batchId,
        decision: managedDecision(value, action, probability),
        committedAtMs: observedAtMs + 101,
      }),
    )
    expect(result.action).toBe(JevManagementAction.Hold)
    expect(result.portfolio).toBe(value.controlPortfolio)
  }
})

test('unbound, expired, future and changed-position management cannot trigger an exit', () => {
  const value = prepared()
  const base = {
    portfolio: value.controlPortfolio,
    expectedBatchId: value.batch.batchId,
    decision: managedDecision(value),
    committedAtMs: observedAtMs + 101,
  }
  for (const patch of [
    { expectedBatchId: 'a'.repeat(64) },
    { committedAtMs: observedAtMs + 99 },
    { committedAtMs: Date.parse(value.batch.expiresAt) + 1 },
    { committedAtMs: NaN },
    { portfolio: { ...value.controlPortfolio, ledger: { ...value.controlPortfolio.ledger, cashMicros: '1' } } },
    { portfolio: Result.getOrThrow(createControlPortfolio('100000000000')) },
    { decision: { ...base.decision, action: JevManagementAction.Hold } },
  ])
    expect(Result.isFailure(applyControlManagementDecision({ ...base, ...patch }))).toBe(true)
  const other = prepared({ ...input(), runId: '7'.repeat(64) })
  expect(Result.isFailure(applyControlManagementDecision({ ...base, decision: managedDecision(other) }))).toBe(true)
})

describe('native control management requests', () => {
  test('zero displayed bid preserves the production management path without triggering a stop', () => {
    const quotes = new Map(fixture.cut.projection.quotes)
    const quoteHistory = new Map(fixture.cut.projection.quoteHistory)
    const current = quotes.get('AAPL')
    const history = quoteHistory.get('AAPL')
    if (current === undefined || history === undefined) throw new Error('Missing management quote fixture')
    quotes.set('AAPL', { ...current, value: { ...current.value, bidSize: 0 } })
    quoteHistory.set(
      'AAPL',
      history.map((value) => ({ ...value, value: { ...value.value, bidSize: 0 } })),
    )
    const snapshot = Result.getOrThrow(
      constructStreamingSnapshot(
        {
          ...fixture.cut,
          projection: { ...fixture.cut.projection, quotes, quoteHistory },
        },
        fixture.query,
      ),
    )
    const i = input()
    const result = makeControlManagementBatch({
      ...i,
      snapshot,
      entryOrder: {
        ...i.entryOrder,
        decisionQuote: quote(i.entryOrder.decisionAtMs, 5, 110),
        arrivalQuote: quote(i.entryOrder.arrivalAtMs, 5, 110),
      },
    })
    expect(Result.isSuccess(result)).toBe(true)
    const batch = Result.getOrThrow(result)
    expect(batch.batch.candidates[0]?.status).toBe(JevCandidatePlanStatus.Requested)
    expect(Result.isSuccess(reproduceJevTradingSignalBatchEvidence(batch.observation, batch.batch))).toBe(true)
  })

  test('uses native management request bytes for the actually filled position', () => {
    const result = prepared()
    if (fixture.portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected native managed portfolio')
    const state = fixture.portfolio.brokerState
    const material = {
      ...state,
      account: {
        ...state.account,
        cashMicros: '99499990000',
        equityMicros: '100009990000',
        buyingPowerMicros: '99499990000',
      },
    }
    const stateHash = Result.getOrThrow(reconciledStateHash(material))
    const nativePortfolio = Result.getOrThrow(
      decodeJevPortfolio({
        ...fixture.portfolio,
        entryFills: fixture.portfolio.entryFills.map((fill, index) => ({
          ...fill,
          feeMicros: index === 0 ? '10000' : '0',
        })),
        brokerState: {
          ...material,
          reconciliation: {
            ...state.reconciliation,
            expectedHash: stateHash,
            observedHash: stateHash,
            contentHash: canonicalHashV1(material),
          },
        },
      }),
    )
    const nativeObservation = Result.getOrThrow(
      makeJevObservation({
        cycleId: fixture.observation.payload.cycleId,
        authorityGenerationHash: fixture.observation.payload.authorityGenerationHash,
        protocol: fixture.protocol,
        portfolio: nativePortfolio,
        snapshot: fixture.snapshot,
      }),
    )
    const native = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: nativeObservation.payload,
        expiresAt: new Date(observedAtMs + fixture.protocol.inferenceValidityMs).toISOString(),
        planVersion: JevBatchPlanVersion.V3,
      }),
    )
    const candidate = result.batch.candidates[0]
    const nativeCandidate = native.candidates[0]
    if (
      candidate?.status !== JevCandidatePlanStatus.Requested ||
      nativeCandidate?.status !== JevCandidatePlanStatus.Requested
    )
      throw new Error('Expected native management requests')
    expect(result.batch.candidates).toHaveLength(1)
    expect(candidate.request.request).toEqual(nativeCandidate.request.request)
    expect(candidate.request.request.state).toMatchObject({
      schemaVersion: 'bayn.jev-trading-signal-state.v2',
      task: { decisionPurpose: 'MANAGE' },
      position: {
        quantityShares: 5,
        costBasisUsd: 500,
        averageEntryPriceUsd: 100,
        heldForMinutes: 3,
        remainingHoldingMinutes: 12,
        entryFeesUsd: 0.01,
      },
    })
    expect(result.controlPortfolio.ledger.cashMicros).toBe('99499990000')
    expect(result.observation.portfolio.brokerState.orders[0]?.status).toBe(OrderStatus.Canceled)
    expect(result.observation.portfolio.brokerState.orders[0]?.quantityMicros).toBe('10000000')
    expect(result.observation.portfolio.brokerState.orders[0]?.filledQuantityMicros).toBe('5000000')
    expect(Result.isSuccess(reproduceJevTradingSignalBatchEvidence(result.observation, result.batch))).toBe(true)
  })

  test('different IOC liquidity creates a different position and request', () => {
    const i = input()
    const result = prepared({ ...i, entryOrder: { ...i.entryOrder, arrivalQuote: quote(i.entryOrder.arrivalAtMs, 2) } })
    const candidate = result.batch.candidates[0]
    if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing management request')
    expect(candidate.request.request.state).toMatchObject({ position: { quantityShares: 2, costBasisUsd: 200 } })
    expect(result.entryIdentity).not.toBe(prepared().entryIdentity)
  })

  test('consumed displayed liquidity cannot create a management position', () => {
    const i = input()
    const q = i.entryOrder.arrivalQuote
    if (q === undefined) throw new Error('Missing arrival quote')
    expect(
      Result.isFailure(
        makeControlManagementBatch({
          ...i,
          beforeEntry: { ...i.beforeEntry, consumedLiquidity: new Map([[`AAPL:BUY:${q.recordHash}`, 5_000_000n]]) },
        }),
      ),
    ).toBe(true)
  })

  test('canceled, missing-quote, wrong-side and zero-size entries cannot invent held positions', () => {
    const i = input()
    for (const patch of [
      { arrivalQuote: undefined },
      { arrivalQuote: quote(i.entryOrder.arrivalAtMs, 0) },
      { arrivalQuote: quote(i.entryOrder.arrivalAtMs, 5, 101) },
      { side: OrderSide.Sell },
    ])
      expect(Result.isFailure(makeControlManagementBatch({ ...i, entryOrder: { ...i.entryOrder, ...patch } }))).toBe(
        true,
      )
  })

  test('maximum hold and protective stop run before model input', () => {
    const i = input()
    const arrived = observedAtMs - 15 * 60_000
    expect(
      Result.isFailure(
        makeControlManagementBatch({
          ...i,
          entryOrder: {
            ...i.entryOrder,
            decisionAtMs: arrived - 100,
            arrivalAtMs: arrived,
            decisionQuote: quote(arrived - 100),
            arrivalQuote: quote(arrived),
          },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        makeControlManagementBatch({
          ...i,
          entryOrder: {
            ...i.entryOrder,
            decisionQuote: quote(i.entryOrder.decisionAtMs, 5, 110),
            arrivalQuote: quote(i.entryOrder.arrivalAtMs, 5, 110),
          },
        }),
      ),
    ).toBe(true)
  })

  test('future fills and a complete entry-universe snapshot cannot masquerade as management context', () => {
    const i = input()
    expect(Result.isFailure(makeControlManagementBatch({ ...i, snapshot: nativeJevFixture().snapshot }))).toBe(true)
    expect(
      Result.isFailure(
        makeControlManagementBatch({
          ...i,
          entryOrder: {
            ...i.entryOrder,
            decisionAtMs: observedAtMs + 100,
            arrivalAtMs: observedAtMs + 200,
            decisionQuote: quote(observedAtMs + 100),
            arrivalQuote: quote(observedAtMs + 200),
          },
        }),
      ),
    ).toBe(true)
  })

  test('research identities are deterministic and separate from production and other runs', () => {
    const i = input()
    const a = prepared(i)
    expect(prepared(i)).toEqual(a)
    expect(a.observation.portfolio.brokerState.account.accountId).toStartWith('research-control-management-')
    expect(prepared({ ...i, runId: '5'.repeat(64) }).batch.batchId).not.toBe(a.batch.batchId)
    expect(prepared({ ...i, entryDecisionHash: '6'.repeat(64) }).batch.batchId).not.toBe(a.batch.batchId)
    expect(Result.isFailure(makeControlManagementBatch({ ...i, runId: 'invalid' }))).toBe(true)
  })
})
