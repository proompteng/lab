import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { OrderSide } from '../../execution/contracts'
import type { EquityShortEligibility } from '../../execution/equity-short'
import type { EtfWeights, MultiAssetEtfTradable } from './policy'
import { planMultiAssetEtfRebalance, type EtfRebalanceInput, type EtfReferencePrice } from './rebalance-planner'
import { compileMultiAssetEtfSignal } from './signals'
import { marketAt, policyAt, withoutBar } from './test-support'

const policy = policyAt()
const USD = 1_000_000n
const prior = '2026-11-25'
const nextOpen = '2026-11-27'
const at = `${nextOpen}T14:25:00.000Z`
const price = (priceMicros = 100n * USD): EtfReferencePrice => ({
  kind: 'RAW_PRIOR_CLOSE',
  session: prior,
  priceMicros,
})
const eligible = (symbol: MultiAssetEtfTradable): EquityShortEligibility => ({
  schemaVersion: 'bayn.equity-short-eligibility.v1',
  accountId: 'paper',
  symbol,
  accountHash: 'a'.repeat(64),
  configurationHash: 'b'.repeat(64),
  assetHash: 'c'.repeat(64),
  accountObservedAt: at,
  configurationObservedAt: at,
  assetObservedAt: at,
  accountActive: true,
  shortingEnabled: true,
  noShorting: false,
  assetActive: true,
  tradable: true,
  marginable: true,
  shortable: true,
  easyToBorrow: true,
})

const input = (targetWeights: EtfWeights, chosen = policy): EtfRebalanceInput => ({
  signal: {
    policyHash: chosen.policyHash,
    signalSession: prior,
    executionSession: nextOpen,
    targetWeights,
    exclusions: [],
    idleCashContribution: {},
  },
  accountId: 'paper',
  plannedAt: at,
  equityMicros: 100_000n * USD,
  buyingPowerMicros: 100_000n * USD,
  positions: {},
  references: { SPY: price(), QQQ: price(), TLT: price(), GLD: price(), SHY: price(), SGOV: price() },
  shortEligibility: {},
})
const plan = (args: EtfRebalanceInput, chosen = policy) => Result.getOrThrow(planMultiAssetEtfRebalance(chosen, args))

test('rounds whole shares down and computes exact integer turnover and reserved buy notional', () => {
  const args = input({ SPY: 0.123456, QQQ: 0 })
  const result = plan(args)
  expect(result.orders).toEqual([
    {
      symbol: 'SPY',
      side: OrderSide.Buy,
      shares: 123n,
      positionEffect: 'BUY_LONG',
      limitPriceMicros: 100_200_000n,
      referenceNotionalMicros: 12_300n * USD,
      buyingPowerReservedMicros: 123n * 100_200_000n,
    },
  ])
  expect(result.targetShares).toEqual({ SPY: 123n })
  expect(result.turnoverNotionalMicros).toBe(12_300n * USD)
  expect(result.turnoverEquityMicros).toBe(100_000n * USD)
  expect(result.buyLimitNotionalMicros).toBe(123n * 100_200_000n)
  expect(result.buyingPowerRemainingMicros).toBe(args.buyingPowerMicros - result.buyLimitNotionalMicros)
  expect(
    plan({ ...args, references: { SPY: { kind: 'RAW_OPEN', session: nextOpen, priceMicros: 200n * USD } } })
      .targetShares,
  ).toEqual({ SPY: 61n })
})

test('deadband suppresses small increments but not exact-threshold trades or exits', () => {
  const args = { ...input({ SPY: 0.1 }), positions: { SPY: 101n } }
  const held = plan(args)
  expect(held.orders).toEqual([])
  expect(held.targetShares).toEqual({ SPY: 101n })
  expect(held.restrictions).toEqual([{ symbol: 'SPY', reason: 'Deadband' }])
  expect(held.turnoverNotionalMicros).toBe(0n)
  expect(plan({ ...args, positions: { SPY: 102n } }).orders[0]).toMatchObject({ side: OrderSide.Sell, shares: 3n })
  const exact = policyAt(undefined, { risk: { ...policy.risk, minRebalanceDriftBps: 20 } })
  expect(plan({ ...args, signal: { ...args.signal, policyHash: exact.policyHash } }, exact).orders[0]?.shares).toBe(2n)
  expect(plan({ ...input({}), positions: { SPY: 1n } }).orders[0]).toMatchObject({ side: OrderSide.Sell, shares: 1n })
  const flat = plan(input({}))
  expect(flat.orders).toEqual([])
  expect(flat.turnoverNotionalMicros).toBe(0n)
  expect(flat.buyingPowerReservedMicros).toBe(0n)
})

test('reclamps gross, net and single-name limits, and never buffers a required risk trim', () => {
  const chosen = policyAt(undefined, {
    risk: {
      ...policy.risk,
      maxGrossLeverage: 0.4,
      maxSingleSymbolWeight: 0.25,
      maxNetShortWeight: 0.1,
      minRebalanceDriftBps: 10_000,
    },
  })
  const over = { ...input({ SPY: 0.9, QQQ: 0.9 }, chosen), positions: { SPY: 220n, QQQ: 220n } }
  const result = plan(over, chosen)
  expect(result.targetShares).toEqual({ SPY: 199n, QQQ: 199n })
  expect(result.projectedGrossAtCollarMicros).toBe(398n * 100_200_000n)
  expect(result.projectedWithinRiskLimits).toBe(true)
  expect(result.orders.map(({ shares }) => shares)).toEqual([21n, 21n])

  const single = plan(input({ SPY: 0.9 }, chosen), chosen)
  expect(single.targetShares.SPY).toBe(249n)
  const short = plan({ ...input({ SPY: -0.9 }, chosen), shortEligibility: { SPY: eligible('SPY') } }, chosen)
  expect(short.targetShares.SPY).toBe(-99n)
  expect(short.projectedNetShortAtCollarMicros).toBeLessThanOrEqual(10_000n * USD)
})

test('preserves reconciled holdings on missing adjusted bars, and refuses unpriced or misaligned active legs', () => {
  const pullback = policyAt('pullback')
  const signal = Result.getOrThrow(compileMultiAssetEtfSignal(pullback, marketAt(nextOpen, withoutBar(prior, 'XLK'))))
  const args = { ...input({}, pullback), signal, positions: { XLK: 25n }, references: { XLK: price() } }
  const result = plan(args, pullback)
  expect(result.targetShares).toEqual({ XLK: 25n })
  expect(result.restrictions).toContainEqual({ symbol: 'XLK', reason: 'MissingSymbolBar' })
  expect(result.orders).toEqual([])
  for (const references of [{}, { XLK: { ...price(), session: '2026-11-24' } }, { XLK: price(0n) }]) {
    expect(planMultiAssetEtfRebalance(pullback, { ...args, references })).toEqual(
      Result.fail({ _tag: 'InvalidReferencePrice', symbol: 'XLK' }),
    )
  }
  expect(planMultiAssetEtfRebalance(policy, args)).toEqual(
    Result.fail({ _tag: 'InvalidRebalanceInput', field: 'signal' }),
  )
})

test('a reversal has separate closing/opening orders and needs fresh same-account borrow only for the new short', () => {
  const args = { ...input({ SPY: -0.1 }), positions: { SPY: 30n } }
  for (const borrow of [
    { ...eligible('SPY'), assetObservedAt: `${nextOpen}T14:24:45.000Z` },
    { ...eligible('SPY'), easyToBorrow: false },
    { ...eligible('SPY'), accountId: 'another' },
  ]) {
    const blocked = plan({ ...args, shortEligibility: { SPY: borrow } })
    expect(blocked.orders.map(({ positionEffect }) => positionEffect)).toEqual(['SELL_LONG'])
    expect(blocked.restrictions).toContainEqual({ symbol: 'SPY', reason: 'BorrowUnavailable' })
    expect(blocked.targetShares.SPY).toBe(0n)
  }
  const admitted = plan({ ...args, shortEligibility: { SPY: eligible('SPY') } })
  expect(admitted.orders.map(({ shares, positionEffect }) => [shares, positionEffect])).toEqual([
    [30n, 'SELL_LONG'],
    [99n, 'SELL_SHORT'],
  ])
  expect(admitted.buyingPowerReservedMicros).toBe(99n * 100_200_000n)
  expect(plan({ ...input({}), positions: { SPY: -8n } }).orders[0]).toMatchObject({
    positionEffect: 'COVER_SHORT',
    shares: 8n,
  })
})

test('caps purchases at worst-case spend, does not anticipate sale proceeds, and does not sell a required long hedge', () => {
  const result = plan({
    ...input({ SPY: 0.3 }),
    positions: { QQQ: 200n },
    buyingPowerMicros: 550n * USD,
    references: { SPY: price(100_003_000n), QQQ: price(100_003_000n) },
  })
  expect(result.orders).toMatchObject([
    { symbol: 'QQQ', positionEffect: 'SELL_LONG', shares: 200n, limitPriceMicros: 99_810_000n },
    { symbol: 'SPY', positionEffect: 'BUY_LONG', shares: 5n, limitPriceMicros: 100_200_000n },
  ])
  expect(result.buyingPowerRemainingMicros).toBe(49n * USD)
  const neutral = policyAt(undefined, { risk: { ...policy.risk, maxNetShortWeight: 0 } })
  const blocked = plan({ ...input({}, neutral), positions: { SPY: -100n, QQQ: 101n }, buyingPowerMicros: 0n }, neutral)
  expect(blocked.orders).toEqual([])
  expect(blocked.restrictions).toEqual([
    { symbol: 'SPY', reason: 'BuyingPower' },
    { symbol: 'QQQ', reason: 'RiskLimit' },
  ])
})

test('cash sweep cannot use encumbered gross collateral or presumed fills', () => {
  const sweep = policyAt(undefined, { idleCashSweep: { enabled: true, symbol: 'SGOV' } })
  const args = input({ SGOV: 0.3 }, sweep)
  expect(planMultiAssetEtfRebalance(sweep, args)).toEqual(
    Result.fail({ _tag: 'InvalidRebalanceInput', field: 'SGOV sweep target' }),
  )
  const verified = { ...args, signal: { ...args.signal, idleCashContribution: { SGOV: 0.3 } } }
  expect(plan(verified, sweep).targetShares.SGOV).toBe(299n)
  const held = plan({ ...verified, positions: { SPY: 349n, QQQ: 349n, TLT: -300n } }, sweep)
  expect(held.targetShares.SGOV).toBe(0n)
  expect(held.restrictions).toContainEqual({ symbol: 'SGOV', reason: 'IdleCashLimit' })
})

test('property: every conditional fill prefix preserves portfolio and collateral limits', () => {
  const symbols = ['SPY', 'QQQ', 'TLT', 'GLD'] as const
  const arb = fc.tuple(
    ...symbols.map(() =>
      fc.record({
        shares: fc.integer({ min: -40, max: 40 }),
        targetBps: fc.integer({ min: -12_000, max: 12_000 }),
        rawDollars: fc.integer({ min: 10, max: 100 }),
        borrow: fc.boolean(),
      }),
    ),
  )
  fc.assert(
    fc.property(arb, fc.integer({ min: 0, max: 100_000 }), (legs, budget) => {
      const weights = Object.fromEntries(symbols.map((symbol, i) => [symbol, legs[i].targetBps / 10_000]))
      const positions = Object.fromEntries(symbols.map((symbol, i) => [symbol, BigInt(legs[i].shares)]))
      const references = Object.fromEntries(
        symbols.map((symbol, i) => [symbol, price(BigInt(legs[i].rawDollars) * USD)]),
      )
      const shortEligibility = Object.fromEntries(
        symbols.flatMap((symbol, i) => (legs[i].borrow ? [[symbol, eligible(symbol)]] : [])),
      )
      const args = {
        ...input(weights),
        positions,
        references,
        shortEligibility,
        buyingPowerMicros: BigInt(budget) * USD,
      }
      const result = plan(args)
      const held = { ...positions }
      let turnover = 0n
      let reserved = 0n
      for (const order of result.orders) {
        const raw = references[order.symbol].priceMicros
        const before = held[order.symbol]
        expect(order.shares).toBeGreaterThan(0n)
        if (order.positionEffect === 'SELL_SHORT') expect(shortEligibility[order.symbol]).toBeDefined()
        const after = before + (order.side === OrderSide.Buy ? order.shares : -order.shares)
        expect(before * after).toBeGreaterThanOrEqual(0n)
        held[order.symbol] = after
        expect(order.limitPriceMicros).toBeGreaterThanOrEqual((raw * 998n) / 1000n)
        expect(order.limitPriceMicros).toBeLessThanOrEqual((raw * 1002n) / 1000n)
        turnover += order.shares * raw
        reserved += order.buyingPowerReservedMicros
        let total = 0n
        let netShort = 0n
        for (const symbol of symbols) {
          const shares = held[symbol]
          const reference = references[symbol].priceMicros
          const gross = ((shares < 0n ? -shares : shares) * reference * 1002n) / 1000n
          expect(gross).toBeLessThanOrEqual(35_000n * USD)
          total += gross
          netShort -= (shares * reference * (shares < 0n ? 1002n : 998n)) / 1000n
        }
        expect(total).toBeLessThanOrEqual(180_000n * USD)
        expect(netShort).toBeLessThanOrEqual(20_000n * USD)
        expect(reserved).toBeLessThanOrEqual(args.buyingPowerMicros)
      }
      expect(result.turnoverNotionalMicros).toBe(turnover)
      expect(result.buyingPowerReservedMicros).toBe(reserved)
      expect(result.projectedWithinRiskLimits).toBe(true)
      expect(result.orders).toEqual(
        plan({
          ...args,
          signal: { ...args.signal, targetWeights: Object.fromEntries(Object.entries(weights).reverse()) },
          positions: Object.fromEntries(Object.entries(positions).reverse()),
        }).orders,
      )
    }),
    { seed: 420403, numRuns: 200 },
  )
})
