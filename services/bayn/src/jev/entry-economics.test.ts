import { cryptoMaximumTakerFeeBps } from '../broker/crypto-fees'
import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { decideJevEntry } from './decision'
import { jevObservationForSnapshot, nativeJevDecisionEvidence, nativeJevFixture } from './native.test-support'
import { JevPurpose } from './portfolio'
import { makeJevTradingSignalRequest } from './trading-signals'
import { checkProperty } from '../testing/property-test-support'
import { maximumAllocatedBuyQuantities, maximumFundedBuyQuantities } from './entry-sizing'
import { jevEntryEconomics } from './entry-economics'
import { fundJevTradePlan } from './entry-economics'
import { defaultJevProtocolDocument } from './protocol'
import { orderRequestBody } from '../broker/alpaca-mutations/decisions'
import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { calculateSessionFees } from '../strategy/execution-model/fees'
import { quantityScale } from '../quantity'
import { makeJevObservation } from './observation'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'

test('uses the broker crypto fee tier for received entry inventory', () => {
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      cryptoFeeTier: 4,

      protocol: defaultJevProtocolDocument,
      symbol: 'BTC/USD',
      bidMicros: 80_000_000_000n,
      askMicros: 80_000_000_000n,
      capitalMicros: '400800400000',
    }),
  )
  if (economics === null) throw new Error('Expected a fully funded BTC unit')
  expect(economics.maximumEntryPriceMicros).toBe('80160080000')
  expect(economics.maximumQuantityAtoms).toBe('1000000000')
  expect(economics.receivedQuantityAtoms).toBe('998200000')
  expect(economics.estimatedEntryFeesUsd).toBeCloseTo(144.288144, 6)
  expect(economics.entryTakerFeeBps).toBe(18)
  expect(economics.maximumExitTakerFeeBps).toBe(25)
})

test('the sealed model state uses the account tier for entry and the maximum future exit fee', () => {
  const { snapshot } = cryptoMarketFixture('BTC/USD')
  const base = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
  const state = {
    ...base.portfolio.brokerState,
    account: { ...base.portfolio.brokerState.account, cryptoFeeTier: 4 as const },
  }
  const hash = Result.getOrThrow(reconciledStateHash(state))
  const observation = Result.getOrThrow(
    makeJevObservation({
      cycleId: base.cycleId,
      authorityGenerationHash: base.authorityGenerationHash,
      protocol: base.protocol,
      snapshot,
      portfolio: {
        ...base.portfolio,
        brokerState: { ...state, reconciliation: { ...state.reconciliation, expectedHash: hash, observedHash: hash } },
      },
    }),
  )
  const request = Result.getOrThrow(makeJevTradingSignalRequest(observation.payload, 'BTC/USD'))
  const context = JSON.parse(request.body).state
  expect(context.execution).toMatchObject({
    maximumEntryFeeBps: 18,
    maximumExitFeeBps: 25,
    estimatedRoundTripFeesBps: 43,
  })
  expect(context.execution.estimatedFeeBpsPerSide).toBeUndefined()
  expect(context.entryEconomics).toMatchObject({
    entryCryptoFeeTier: 4,
    entryTakerFeeBps: 18,
    maximumExitTakerFeeBps: 25,
  })
})

test('funding values a native take-profit at its submitted minimum sell price', () => {
  const protocol = defaultJevProtocolDocument
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      cryptoFeeTier: null,

      protocol,
      symbol: 'AAPL',
      bidMicros: 100_000_000n,
      askMicros: 100_000_000n,
      capitalMicros: '100000000000',
    }),
  )
  if (economics === null) throw new Error('Expected a funded equity quantity')
  const levels = {
    schemaVersion: 'bayn.jev-strategy-exit-plan.v3' as const,
    rule: 'model-selected-complete-plan' as const,
    symbol: 'AAPL',
    sourceStartAt: '2026-10-23T14:00:00.000Z',
    sourceEndAt: '2026-10-23T14:30:00.000Z',
    maximumHoldingMinutes: 15,
    maximumEntryPriceMicros: economics.maximumEntryPriceMicros,
    stopPriceMicros: '99000000',
    stopLimitPriceMicros: '98910000',
    profitLimitPriceMicros: '100210000',
  }
  const quantity = BigInt(economics.receivedQuantityAtoms)
  const proceeds = (BigInt(levels.profitLimitPriceMicros) * quantity) / quantityScale
  const fees = Result.getOrThrow(
    calculateSessionFees(
      [{ symbol: 'AAPL', side: 'sell', quantityAtoms: quantity, notionalMicros: proceeds }],
      protocol.executionModel,
      1_000_000n,
      cryptoMaximumTakerFeeBps,
    ),
  )
  expect(proceeds - fees.cashMicros).toBeGreaterThan(BigInt(economics.acquisitionCostMicros))
  const request = Result.getOrThrow(
    orderRequestBody({
      symbol: 'AAPL',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      clientOrderId: 'b1_' + 'A'.repeat(43),
      quantityAtoms: economics.maximumQuantityAtoms,
      limitPriceMicros: economics.maximumEntryPriceMicros,
      notionalLimitMicros: String(
        (BigInt(economics.maximumEntryPriceMicros) * BigInt(economics.maximumQuantityAtoms) + quantityScale - 1n) /
          quantityScale,
      ),
      protection: {
        _tag: 'Bracket',
        stopPriceMicros: levels.stopPriceMicros,
        stopLimitPriceMicros: levels.stopLimitPriceMicros,
        profitLimitPriceMicros: levels.profitLimitPriceMicros,
      },
    }),
  )
  expect(request.take_profit?.limit_price).toBe('100.21')
  const funded = Result.getOrThrow(fundJevTradePlan({ protocol, economics, levels }))
  expect(funded).not.toBeNull()
  expect(BigInt(funded?.exitPlan.estimatedTargetNetMicros ?? '0')).toBeGreaterThan(
    BigInt(economics.acquisitionCostMicros),
  )
})

test('typed entry and protection choices support an entry without a confidence gate', () => {
  const fixture = nativeJevFixture()
  const request = Result.getOrThrow(makeJevTradingSignalRequest(fixture.observation.payload, 'AAPL'))
  expect(
    Object.fromEntries(Object.entries(request.request.questions).map(([name, question]) => [name, question.type])),
  ).toEqual({ action: 'choice', setup: 'choice' })
  const evidence = nativeJevDecisionEvidence(fixture, 'enter', 0.4)
  expect(Result.getOrThrow(decideJevEntry(evidence)).selectedSymbols).toEqual(['AAPL'])
})

test('an unfunded whole-equity target abstains even when the model chooses enter', () => {
  const fixture = nativeJevFixture(JevPurpose.Entry, undefined, undefined, {
    ...defaultJevProtocolDocument,
    maximumGrossWeight: 0.000001,
    maximumSymbolWeight: 0.000001,
  })
  const evidence = nativeJevDecisionEvidence(fixture)
  expect(Result.getOrThrow(decideJevEntry(evidence)).selectedSymbols).toEqual([])
})

test.each(['BTC/USD', 'ETH/USD', 'SOL/USD'] as const)(
  '%s passes fee context to Jev without precomputing a geometric exit plan',
  (symbol) => {
    const { snapshot } = cryptoMarketFixture(symbol)
    const native = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
    const request = Result.getOrThrow(makeJevTradingSignalRequest(native, symbol))
    const state = JSON.parse(request.body).state
    expect(state.entryEconomics).not.toBeNull()
    expect(request.request.questions['action']).toBeDefined()
    expect(request.request.questions['net_economics']).toBeUndefined()
  },
)

test('property: crypto break-even bid covers both adverse limits, the coin debit and cent-rounded exit fee', () => {
  checkProperty(
    'crypto-entry-break-even',
    fc.property(
      fc.bigInt({ min: 1_000_000n, max: 200_000_000_000n }),
      fc.bigInt({ min: 1_000_000_000n, max: 1_000_000_000_000n }),
      (ask, capital) => {
        const protocol = defaultJevProtocolDocument
        const economics = Result.getOrThrow(
          jevEntryEconomics({
            cryptoFeeTier: null,

            protocol,
            symbol: 'BTC/USD',
            askMicros: ask,
            bidMicros: ask,
            capitalMicros: String(capital),
          }),
        )
        if (economics === null) throw new Error('Funded crypto fixture requires a positive allocation')
        const entryPrice = BigInt(Math.round(economics.maximumEntryPriceUsd * 1_000_000))
        const quantity = BigInt(economics.maximumQuantityAtoms)
        const received = quantity - (quantity * 25n + 9999n) / 10_000n
        const acquired = (entryPrice * quantity + 999_999_999n) / 1_000_000_000n
        const net = (bid: bigint) => {
          const boundary = (bid * 9990n + 9999n) / 10000n
          const proceeds = (boundary * received) / 1_000_000_000n
          const fee = ((proceeds * 25n + 99_999_999n) / 100_000_000n) * 10_000n
          return proceeds - fee
        }
        const bid = BigInt(Math.round(economics.holdingExitBreakEvenBidUsd * 1_000_000))
        expect(net(bid)).toBeGreaterThanOrEqual(acquired)
        expect(net(bid - 1n)).toBeLessThan(acquired + 10_000n)
        const centInPrice = (10_000n * 1_000_000_000n + received - 1n) / received
        for (const step of [1n, 5n, 10n, 20n])
          expect(net(bid + (centInPrice * step + 19n) / 20n)).toBeGreaterThanOrEqual(acquired)
        expect(economics.estimatedEntryFeesUsd).toBeGreaterThan(0)
        expect(economics.operatingCostCoverage).toBe('UNKNOWN')
      },
    ),
  )
})

test('a cheaper refreshed crypto ask preserves the funded cap used by durable reproduction', () => {
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      cryptoFeeTier: null,

      protocol: defaultJevProtocolDocument,
      symbol: 'BTC/USD',
      bidMicros: 99990000n,
      askMicros: 100000000n,
      capitalMicros: '100000000000',
    }),
  )
  if (economics === null) throw new Error('Expected a funded synthetic setup')
  const input = {
    askPriceMicros: { 'BTC/USD': '99990000' },
    targetWeights: { 'BTC/USD': economics.maximumTargetWeight },
    capitalMicros: '100000000000',
    precision: defaultJevProtocolDocument.executionModel.precision,
  }
  const allocated = Result.getOrThrow(maximumAllocatedBuyQuantities(input))
  expect(BigInt(allocated['BTC/USD'] ?? '0')).toBeGreaterThan(BigInt(economics.maximumQuantityAtoms))
  expect(
    Result.getOrThrow(
      maximumFundedBuyQuantities({
        ...input,
        plans: {
          'BTC/USD': {
            schemaVersion: 'bayn.jev-funded-exit-plan.v3',
            maximumQuantityAtoms: economics.maximumQuantityAtoms,
            acquisitionCostMicros: economics.acquisitionCostMicros,
            estimatedStopNetMicros: '1',
            estimatedTargetNetMicros: String(BigInt(economics.acquisitionCostMicros) + 1n),
            levels: {
              schemaVersion: 'bayn.jev-strategy-exit-plan.v3',
              rule: 'model-selected-complete-plan',
              symbol: 'BTC/USD',
              sourceStartAt: '2026-10-19T14:59:00.000Z',
              sourceEndAt: '2026-10-19T15:00:00.000Z',
              maximumHoldingMinutes: 15,
              maximumEntryPriceMicros: economics.maximumEntryPriceMicros,
              stopPriceMicros: '99000000',
              stopLimitPriceMicros: '98900000',
              profitLimitPriceMicros: '110000000',
            },
          },
        },
      }),
    )['BTC/USD'],
  ).toBe(economics.maximumQuantityAtoms)
  expect(Result.isFailure(maximumFundedBuyQuantities({ ...input, plans: {} }))).toBe(true)
})
