import { expect, test } from 'bun:test'
import { Redacted, Result, Schema } from 'effect'

import {
  AssetClass,
  OrderClass,
  OrderSide as BrokerSide,
  OrderStatus as BrokerStatus,
  OrderType as BrokerOrderType,
  TimeInForce,
  type Order,
} from '../../broker/alpaca/model'
import { OrderSide } from '../../execution/contracts'
import {
  EquityCutFeed,
  SipDelayClass,
  SipMarketSession,
  SipAdmissionFailure,
  sipTopics,
} from '../../market-data/sip/provenance'
import { sipUniverse } from '../../market-data/sip/universe'
import { quantityScale } from '../../quantity'
import { planNoiseAreaEntries, planNoiseAreaEntryReanchor } from '../etf-noise-area/exit-plan'
import { defaultEtfNoiseAreaPolicy, type EtfNoiseAreaSymbol } from '../etf-noise-area/policy'
import type { NoiseAreaBreakout } from '../etf-noise-area/signals'
import { BPS, MICROS } from './model'
import { decodePassiveEntryPolicy, EntryPricingMode, pricePassiveEntry, type PassiveEntryMarket } from './passive-entry'

const cent = 10_000n
const checkpoint = Date.parse('2026-11-27T15:00:00.000Z')
const at = (offsetMs: number) => new Date(checkpoint + offsetMs).toISOString()
const policyInput = {
  schemaVersion: 'bayn.passive-entry-execution.v1',
  mode: EntryPricingMode.PassiveNbbo,
  maximumQuoteAgeMs: 2_000,
  minimumDwellMs: 8_000,
  reanchorDeadbandBpsOfSpread: 5_000,
}
const executionPolicy = Result.getOrThrow(decodePassiveEntryPolicy(policyInput))
const strategy = defaultEtfNoiseAreaPolicy
const quote = (offsetMs: number, bidCents: number, askCents: number, symbol: EtfNoiseAreaSymbol = 'QQQ') => ({
  provider: 'alpaca',
  symbol,
  feed: EquityCutFeed.Sip,
  delay_class: SipDelayClass.RealTimeConsolidated,
  market_session: SipMarketSession.Regular,
  universe_id: sipUniverse.id,
  universe_symbol_hash: sipUniverse.symbolHash,
  source_topic: sipTopics.quotes,
  source_partition: 0,
  source_offset: String(1_000_000 + offsetMs),
  schema_version: 1,
  bid_price: bidCents / 100,
  ask_price: askCents / 100,
  bid_size: 100,
  ask_size: 100,
  event_at: at(offsetMs - 100),
  ingested_at: at(offsetMs - 75),
})

const market = (current = quote(1_000, 9_996, 10_004), observedAt = at(1_000)): PassiveEntryMarket => ({
  cut: { observedAt, regularOpenAt: at(-30 * 60_000), regularCloseAt: '2026-11-27T18:00:00.000Z' },
  quote: current,
  // Last observed quote in each preceding minute; the two outliers cannot move the 8 bp median.
  completedMinuteQuotes: [4, 8, 2, 18, 8].map((width, index) =>
    quote(-299_000 + index * 60_000, 10_000 - width / 2, 10_000 + width / 2, current.symbol),
  ),
})

const price = (overrides: Partial<Parameters<typeof pricePassiveEntry>[0]> = {}) =>
  pricePassiveEntry({
    policy: executionPolicy,
    symbol: 'QQQ',
    side: OrderSide.Buy,
    adverseLimitMicros: 10_025n * cent,
    market: market(),
    ...overrides,
  })

const signal = (symbol: EtfNoiseAreaSymbol, side: OrderSide): NoiseAreaBreakout => ({
  _tag: side === OrderSide.Buy ? 'LongBreakout' : 'ShortBreakout',
  symbol,
  referencePriceMicros: 100n * MICROS,
  sessionOpenPriceMicros: 100n * MICROS,
  checkpointAt: at(0),
  atr14Micros: 2n * MICROS,
  flattenAt: '2026-11-27T17:58:00.000Z',
})

const plan = (
  signals: readonly NoiseAreaBreakout[],
  execution?: Parameters<typeof planNoiseAreaEntries>[0]['execution'],
) =>
  Result.getOrThrow(
    planNoiseAreaEntries({
      policy: strategy,
      signals,
      capitalBudgetMicros: 20_000n * MICROS,
      usedGrossMicros: 0n,
      ...(execution === undefined ? {} : { execution }),
    }),
  )

const order = (entry: NoiseAreaBreakout, limitPriceMicros: bigint, since: number, observed: number): Order => ({
  accountId: 'replay',
  brokerOrderId: `order-${since}`,
  clientOrderId: `entry-${since}`,
  createdAt: at(since),
  submittedAt: at(since),
  updatedAt: at(since),
  observedAt: at(observed),
  assetId: entry.symbol,
  symbol: entry.symbol,
  assetClass: AssetClass.UsEquity,
  quantityAtoms: quantityScale.toString(),
  filledQuantityAtoms: '0',
  orderClass: OrderClass.Simple,
  orderType: BrokerOrderType.Limit,
  side: entry._tag === 'LongBreakout' ? BrokerSide.Buy : BrokerSide.Sell,
  timeInForce: TimeInForce.Day,
  limitPriceMicros: limitPriceMicros.toString(),
  status: BrokerStatus.New,
  extendedHours: false,
})

test('decodes only explicit, bounded execution policy and redacts rejected configuration', () => {
  const marker = 'private-config-value'
  for (const patch of [
    { mode: marker },
    { minimumDwellMs: 0 },
    { reanchorDeadbandBpsOfSpread: 10_001 },
    { unused: marker },
  ]) {
    const result = decodePassiveEntryPolicy({ ...policyInput, ...patch })
    if (Result.isSuccess(result)) throw new Error('invalid execution policy accepted')
    expect(result.failure.message).toBe('Invalid passive entry policy')
    const { cause } = result.failure
    expect(cause && Redacted.value(cause)).toBeInstanceOf(Schema.SchemaError)
    expect(Bun.inspect(result.failure)).not.toContain(marker)
  }
})

test('rounds a depth-weighted microprice away from crossing and never widens the original collar', () => {
  const balanced = quote(1_000, 9_997, 10_004)
  const sell = { side: OrderSide.Sell, adverseLimitMicros: 9_975n * cent }
  expect(Result.getOrThrow(price({ market: market(balanced) }))).toMatchObject({ limitPriceMicros: 10_000n * cent })
  expect(Result.getOrThrow(price({ ...sell, market: market(balanced) }))).toMatchObject({
    limitPriceMicros: 10_001n * cent,
  })
  expect(Result.getOrThrow(price({ market: market({ ...balanced, bid_size: 300 }) }))).toMatchObject({
    limitPriceMicros: 10_002n * cent,
  })
  expect(Result.getOrThrow(price({ ...sell, market: market({ ...balanced, ask_size: 300 }) }))).toMatchObject({
    limitPriceMicros: 9_999n * cent,
  })
  expect(Result.getOrThrow(price({ adverseLimitMicros: 9_999n * cent + 1n }))).toMatchObject({
    limitPriceMicros: 9_999n * cent,
  })
  expect(Result.getOrThrow(price({ ...sell, adverseLimitMicros: 10_001n * cent + 1n }))).toMatchObject({
    limitPriceMicros: 10_002n * cent,
  })
  expect(Result.getOrThrow(price({ adverseLimitMicros: 9_995n * cent }))).toEqual({
    _tag: 'Defer',
    reason: 'NoPassiveTick',
  })

  const oneTick = market(quote(1_000, 10_000, 10_001))
  expect(Result.getOrThrow(price({ market: oneTick }))).toMatchObject({ limitPriceMicros: 10_000n * cent })
  expect(Result.getOrThrow(price({ ...sell, market: oneTick }))).toMatchObject({ limitPriceMicros: 10_001n * cent })
  expect(Result.getOrThrow(price({ market: market(quote(1_000, 10_000, 10_000)) }))).toEqual({
    _tag: 'Defer',
    reason: 'NoPassiveTick',
  })
})

test('defers without warmup after the open and only defers abnormal spreads strictly above 2.5× the median', () => {
  const ready = market(quote(1_000, 9_990, 10_010))
  expect(Result.getOrThrow(price({ market: ready }))._tag).toBe('Price')
  expect(Result.getOrThrow(price({ market: market(quote(1_000, 9_989, 10_011)) }))).toEqual({
    _tag: 'Defer',
    reason: 'AbnormalSpread',
  })
  expect(
    Result.getOrThrow(price({ market: { ...ready, completedMinuteQuotes: ready.completedMinuteQuotes.slice(1) } })),
  ).toEqual({ _tag: 'Defer', reason: 'SpreadWarmup' })
  expect(
    Result.getOrThrow(price({ market: { ...ready, cut: { ...ready.cut, regularOpenAt: at(-4 * 60_000) } } })),
  ).toEqual({ _tag: 'Defer', reason: 'SpreadWarmup' })
  expect(Result.getOrThrow(price({ market: { cut: ready.cut, completedMinuteQuotes: [] } }))).toEqual({
    _tag: 'Defer',
    reason: 'MissingNbbo',
  })
})

test('rejects non-NBBO, stale, malformed, or noncausal evidence without exposing raw rows', () => {
  const current = quote(1_000, 9_996, 10_004)
  const view = market(current)
  const marker = 'private-quote-field'
  for (const badMarket of [
    { ...view, quote: { ...current, feed: EquityCutFeed.Iex, private: marker } },
    { ...view, quote: { ...current, bid_price: current.ask_price + 1 } },
    { ...view, quote: { ...current, symbol: 'SMH' } },
    { ...view, quote: { ...current, ingested_at: at(800) } },
    { ...view, quote: { ...current, ingested_at: at(1_001) } },
    market(current, '2026-11-27T15:00:02.900000001Z'),
    { ...view, completedMinuteQuotes: view.completedMinuteQuotes.toReversed() },
    {
      ...view,
      completedMinuteQuotes: [
        { ...quote(-299_000, 9_996, 10_004), ingested_at: at(-239_999) },
        ...view.completedMinuteQuotes.slice(1),
      ],
    },
  ]) {
    const result = price({ market: badMarket })
    if (Result.isSuccess(result)) throw new Error('invalid SIP evidence accepted')
    expect(result.failure._tag).toBe('PassiveEntryExecutionError')
    expect(Bun.inspect(result.failure)).not.toContain(marker)
  }
  const stale = price({ market: market(current, at(2_901)) })
  if (Result.isSuccess(stale) || stale.failure.cause === undefined) throw new Error('expected structured quote failure')
  expect(Redacted.value(stale.failure.cause)).toBeInstanceOf(SipAdmissionFailure)
  expect(Redacted.value(stale.failure.cause)).toMatchObject({ reason: 'quote-stale' })
  expect(Result.getOrThrow(price({ market: market(current, at(2_900)) }))._tag).toBe('Price')
})

test('QQQ/SMH planner opt-in skips the affected symbol without inheriting the crossing price or reallocating gross', () => {
  const entries = [signal('QQQ', OrderSide.Buy), signal('SMH', OrderSide.Sell)]
  const baseline = plan(entries)
  expect(baseline.map(({ limitPriceMicros }) => limitPriceMicros)).toEqual([10_025n * cent, 9_975n * cent])
  expect(plan(entries, { policy: executionPolicy, marketBySymbol: {} })).toEqual([])
  const adaptive = plan(entries, {
    policy: executionPolicy,
    marketBySymbol: { QQQ: market(quote(1_000, 9_988, 10_012)), SMH: market(quote(1_000, 9_996, 10_004, 'SMH')) },
  })
  expect(adaptive).toEqual([{ ...baseline[1], symbol: 'SMH', limitPriceMicros: 100n * MICROS }])
  expect(
    plan(entries, {
      policy: executionPolicy,
      marketBySymbol: { QQQ: market(quote(60_000, 9_996, 10_004), at(60_000)) },
    }),
  ).toEqual([])
  const [short] = plan(entries, {
    policy: executionPolicy,
    marketBySymbol: { SMH: market(quote(1_000, 10_030, 10_038, 'SMH')) },
  })
  expect(short).toMatchObject({ limitPriceMicros: 10_034n * cent, grossReservePriceMicros: 10_034n * cent })
})

test('reanchor requires a material move past both dwell and deadband and only considers untouched working entries', () => {
  const entry = signal('QQQ', OrderSide.Buy)
  const resting = (offset: number) => order(entry, 100n * MICROS, 1_000, offset)
  const decide = (offset: number, shift: number, patch: Partial<Order> = {}) =>
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: entry,
        executionPolicy,
        market: market(quote(offset, 9_996 + shift, 10_004 + shift), at(offset)),
        order: { ...resting(offset), ...patch },
      }),
    )
  expect(decide(8_999, 5)._tag).toBe('Keep')
  expect(decide(9_000, 4)._tag).toBe('Keep')
  expect(decide(9_000, 5)).toEqual({ _tag: 'CancelForReanchor', brokerOrderId: 'order-1000' })
  expect(decide(9_000, 5, { updatedAt: at(8_000) })._tag).toBe('Keep')
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: entry,
        executionPolicy,
        market: market(quote(9_000, 10_001, 10_002), at(9_000)),
        order: resting(9_000),
      }),
    )._tag,
  ).toBe('Keep')
  for (const patch of [
    { status: BrokerStatus.PendingCancel },
    { status: BrokerStatus.Filled },
    { filledQuantityAtoms: '1' },
    { orderClass: OrderClass.Bracket },
    { orderType: BrokerOrderType.StopLimit },
    { parentBrokerOrderId: 'parent' },
    { side: BrokerSide.Sell },
    { submittedAt: at(-1) },
    { observedAt: at(9_001) },
  ])
    expect(decide(9_000, 5, patch)._tag).toBe('Keep')
  expect(decide(60_000, 5)._tag).toBe('Keep')
})

test('fixed opportunity replay measures paired fill cost, cancel rate, and missed opportunities', () => {
  // Each row is an independent opportunity with $100 arrival midpoint. A quote changes desired terms but never
  // grants a fill. Only the later strict trade-through fills, conservatively at the working limit for both arms.
  const jitter = [
    [1_000, 0],
    [2_000, 1],
    [2_200, 1],
    [4_000, 2],
    [4_200, 2],
    [11_000, 1],
    [11_200, 1],
  ] as const
  const drift = [
    [1_000, 0],
    [4_000, 6],
    [4_200, 6],
    [6_000, 7],
    [6_200, 7],
    [10_000, 6],
    [10_200, 6],
  ] as const
  const replay = (
    symbol: EtfNoiseAreaSymbol,
    side: OrderSide,
    tape: readonly (readonly [number, number])[],
    width: number,
    through: number,
    passive: boolean,
  ) => {
    const entry = signal(symbol, side)
    const isBuy = side === OrderSide.Buy
    const legacy = plan([entry])[0]
    if (legacy === undefined) throw new Error('expected frozen collar')
    let working: { limit: bigint; since: number } | undefined
    let canceled = 0
    for (const [offset, shift] of tape) {
      const bid = 10_000 + shift - width / 2
      const ask = 10_000 + shift + width / 2
      const view = market(quote(offset, bid, ask, symbol), at(offset))
      const crossing = BigInt(isBuy ? ask : bid) * cent
      const controlLimit = (isBuy ? crossing <= legacy.limitPriceMicros : crossing >= legacy.limitPriceMicros)
        ? crossing
        : undefined
      if (working !== undefined) {
        const reanchor = passive
          ? Result.getOrThrow(
              planNoiseAreaEntryReanchor({
                policy: strategy,
                signal: entry,
                executionPolicy,
                market: view,
                order: order(entry, working.limit, working.since, offset),
              }),
            )._tag === 'CancelForReanchor'
          : controlLimit !== working.limit
        if (reanchor) {
          canceled++
          working = undefined // The synthetic broker confirms cancellation before the next quote, never on this cut.
        }
        continue
      }
      const limit = passive
        ? plan([entry], { policy: executionPolicy, marketBySymbol: { [symbol]: view } })[0]?.limitPriceMicros
        : controlLimit
      if (limit !== undefined) working = { limit, since: offset }
    }
    if (working === undefined) return { canceled, costBps: null }
    const trade = BigInt(through) * cent
    if (!(isBuy ? trade < working.limit : trade > working.limit)) return { canceled: canceled + 1, costBps: null }
    const signedCost = (working.limit - entry.referencePriceMicros) * (isBuy ? 1n : -1n)
    return { canceled, costBps: Number(signedCost * BPS) / Number(entry.referencePriceMicros) }
  }

  const run = (passive: boolean) => [
    replay('QQQ', OrderSide.Buy, jitter, 8, 9_999, passive),
    replay(
      'SMH',
      OrderSide.Sell,
      jitter.map(([offset, shift]) => [offset, -shift]),
      8,
      10_001,
      passive,
    ),
    replay('QQQ', OrderSide.Buy, drift, 8, 10_005, passive),
    replay('SMH', OrderSide.Buy, [[1_000, 0]], 24, 10_011, passive),
    replay('SMH', OrderSide.Buy, [[1_000, 0]], 8, 10_003, passive),
  ]
  const control = run(false)
  const adaptive = run(true)
  expect(control).toEqual([
    { canceled: 3, costBps: 5 },
    { canceled: 3, costBps: 5 },
    { canceled: 3, costBps: 10 },
    { canceled: 0, costBps: 12 },
    { canceled: 0, costBps: 4 },
  ])
  expect(adaptive).toEqual([
    { canceled: 0, costBps: 0 },
    { canceled: 0, costBps: 0 },
    { canceled: 1, costBps: 6 },
    { canceled: 0, costBps: null },
    { canceled: 1, costBps: null },
  ])
  const metrics = (results: typeof control) => {
    const filled = results.filter(({ costBps }) => costBps !== null).length
    const canceled = results.reduce((sum, item) => sum + item.canceled, 0)
    return { fillRate: filled / results.length, cancelRate: canceled / (filled + canceled) }
  }
  const pairedSavings = control.flatMap(({ costBps }, index) => {
    const passiveBps = adaptive[index]?.costBps
    return costBps === null || passiveBps == null ? [] : [costBps - passiveBps]
  })
  expect(pairedSavings.reduce((a, b) => a + b, 0) / pairedSavings.length).toBeCloseTo(4.67, 2)
  expect(metrics(control)).toEqual({ fillRate: 1, cancelRate: 9 / 14 })
  expect(metrics(adaptive)).toEqual({ fillRate: 0.6, cancelRate: 2 / 5 })
})
