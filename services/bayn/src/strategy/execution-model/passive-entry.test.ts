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
import { orderRequestBody } from '../../broker/alpaca-mutations/decisions'
import { OrderSide, OrderType, TimeInForce as DomainTimeInForce } from '../../execution/contracts'
import { deriveExecutionIntentPricing } from '../../execution/intent-pricing'
import {
  EquityCutFeed,
  SipDelayClass,
  SipMarketSession,
  SipAdmissionFailure,
  sipTopics,
} from '../../market-data/sip/provenance'
import { sipUniverse } from '../../market-data/sip/universe'
import { quantityScale } from '../../quantity'
import {
  planNoiseAreaEntries,
  planNoiseAreaEntryReanchor,
  planNoiseAreaExitPricing,
  planNoiseAreaExitReanchor,
} from '../etf-noise-area/exit-plan'
import {
  defaultEtfNoiseAreaPolicy,
  expandedEtfNoiseAreaPolicy,
  type EtfNoiseAreaSymbol,
} from '../etf-noise-area/policy'
import type { NoiseAreaBreakout, NoiseAreaExitSignal } from '../etf-noise-area/signals'
import { BPS, MICROS } from './model'
import {
  decodePassiveEntryPolicy,
  decodePassiveExitPolicy,
  EntryPricingMode,
  ExecutionPricingStage,
  PassiveDeferReason,
  PassiveReanchorReason,
  planPassiveExitReanchor,
  pricePassiveEntry,
  pricePassiveExit,
  type PassiveEntryMarket,
} from './passive-entry'

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
    reason: PassiveDeferReason.NoPassiveTick,
  })

  const oneTick = market(quote(1_000, 10_000, 10_001))
  expect(Result.getOrThrow(price({ market: oneTick }))).toMatchObject({ limitPriceMicros: 10_000n * cent })
  expect(Result.getOrThrow(price({ ...sell, market: oneTick }))).toMatchObject({ limitPriceMicros: 10_001n * cent })
  expect(Result.getOrThrow(price({ market: market(quote(1_000, 10_000, 10_000)) }))).toEqual({
    _tag: 'Defer',
    reason: PassiveDeferReason.NoPassiveTick,
  })
})

test('defers without warmup after the open and only defers abnormal spreads strictly above 2.5× the median', () => {
  const ready = market(quote(1_000, 9_990, 10_010))
  expect(Result.getOrThrow(price({ market: ready }))._tag).toBe('Price')
  expect(Result.getOrThrow(price({ market: market(quote(1_000, 9_989, 10_011)) }))).toEqual({
    _tag: 'Defer',
    reason: PassiveDeferReason.AbnormalSpread,
  })
  expect(
    Result.getOrThrow(price({ market: { ...ready, completedMinuteQuotes: ready.completedMinuteQuotes.slice(1) } })),
  ).toEqual({ _tag: 'Defer', reason: PassiveDeferReason.SpreadWarmup })
  expect(
    Result.getOrThrow(price({ market: { ...ready, cut: { ...ready.cut, regularOpenAt: at(-4 * 60_000) } } })),
  ).toEqual({ _tag: 'Defer', reason: PassiveDeferReason.SpreadWarmup })
  expect(Result.getOrThrow(price({ market: { cut: ready.cut, completedMinuteQuotes: [] } }))).toEqual({
    _tag: 'Defer',
    reason: PassiveDeferReason.MissingNbbo,
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
  expect(decide(9_000, 5)).toEqual({
    _tag: 'CancelForReanchor',
    brokerOrderId: 'order-1000',
    reason: PassiveReanchorReason.QuoteDrift,
    targetStage: ExecutionPricingStage.Passive,
    proposedLimitPriceMicros: 10_005n * cent,
  })
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

const steppedPolicy = Result.getOrThrow(
  decodePassiveEntryPolicy({
    ...policyInput,
    escalateToMarketableAfterMs: 20_000,
    marketablePaddingBps: 2,
    maximumSpreadBps: 12,
    minimumReanchorTicks: 3,
    maximumReanchors: 1,
  }),
)

const exitPolicyInput = {
  schemaVersion: 'bayn.passive-exit-execution.v1',
  mode: EntryPricingMode.PassiveNbbo,
  maximumQuoteAgeMs: 2_000,
  minimumDwellMs: 8_000,
  reanchorDeadbandBpsOfSpread: 5_000,
  escalateToMarketableAfterMs: 20_000,
  mandatoryEscalationLeadMs: 15_000,
  marketableSlippageBps: 5,
  minimumReanchorTicks: 2,
  maximumReanchors: 1,
}
const exitPolicy = Result.getOrThrow(decodePassiveExitPolicy(exitPolicyInput))

test('validates stepping, spread-cap, churn-guard, and exit policies with redacted errors', () => {
  const marker = 'secret-step-policy'
  for (const patch of [
    { escalateToMarketableAfterMs: 7_999 },
    { escalateToMarketableAfterMs: 60_000 },
    { marketablePaddingBps: 2 },
    { escalateToMarketableAfterMs: 20_000, marketablePaddingBps: 26 },
    { maximumSpreadBps: 0 },
    { minimumReanchorTicks: 0 },
    { maximumReanchors: 11 },
    { extra: marker },
  ]) {
    const result = decodePassiveEntryPolicy({ ...policyInput, ...patch })
    if (Result.isSuccess(result)) throw new Error(`invalid stepped entry policy accepted: ${JSON.stringify(patch)}`)
    expect(result.failure.message).toBe('Invalid passive entry policy')
    expect(Bun.inspect(result.failure)).not.toContain(marker)
  }
  for (const patch of [
    { escalateToMarketableAfterMs: 7_999 },
    { mandatoryEscalationLeadMs: 500 },
    { marketableSlippageBps: 51 },
    { mode: marker },
    { extra: marker },
  ]) {
    const result = decodePassiveExitPolicy({ ...exitPolicyInput, ...patch })
    if (Result.isSuccess(result)) throw new Error(`invalid exit policy accepted: ${JSON.stringify(patch)}`)
    expect(result.failure.message).toBe('Invalid passive exit policy')
    expect(Bun.inspect(result.failure)).not.toContain(marker)
  }
})

test('absolute spread cap defers sustained wide spreads even when the 5-minute median is already wide', () => {
  const wideHistory = [14, 14, 14, 14, 14].map((width, index) =>
    quote(-299_000 + index * 60_000, 10_000 - width / 2, 10_000 + width / 2, 'SMH'),
  )
  const wideMarket: PassiveEntryMarket = {
    cut: { observedAt: at(1_000), regularOpenAt: at(-30 * 60_000), regularCloseAt: '2026-11-27T18:00:00.000Z' },
    quote: quote(1_000, 9_993, 10_007, 'SMH'), // 14 bp spread = 1.0x median, but strictly above 12 bp cap
    completedMinuteQuotes: wideHistory,
  }
  // Baseline policy without maximumSpreadBps accepts 1.0x median; capped policy defers.
  expect(
    Result.getOrThrow(
      pricePassiveEntry({
        policy: executionPolicy,
        symbol: 'SMH',
        side: OrderSide.Buy,
        adverseLimitMicros: 10_025n * cent,
        market: wideMarket,
      }),
    )._tag,
  ).toBe('Price')
  expect(
    Result.getOrThrow(
      pricePassiveEntry({
        policy: steppedPolicy,
        symbol: 'SMH',
        side: OrderSide.Buy,
        adverseLimitMicros: 10_025n * cent,
        market: wideMarket,
        windowStartedAt: at(0),
      }),
    ),
  ).toEqual({ _tag: 'Defer', reason: PassiveDeferReason.AbnormalSpread })
  // Exact 12 bp boundary is permitted.
  const atCapMarket: PassiveEntryMarket = {
    ...wideMarket,
    quote: quote(1_000, 9_994, 10_006, 'SMH'),
  }
  expect(
    Result.getOrThrow(
      pricePassiveEntry({
        policy: steppedPolicy,
        symbol: 'SMH',
        side: OrderSide.Buy,
        adverseLimitMicros: 10_025n * cent,
        market: atCapMarket,
        windowStartedAt: at(0),
      }),
    ),
  ).toMatchObject({ _tag: 'Price', stage: ExecutionPricingStage.Passive, limitPriceMicros: 10_000n * cent })
})

test('time-decay entry stepping transitions from passive microprice to collar-bounded marketable touch', () => {
  // Missing or noncausal windowStartedAt fails closed when escalation is enabled.
  expect(
    Result.isFailure(
      pricePassiveEntry({
        policy: steppedPolicy,
        symbol: 'QQQ',
        side: OrderSide.Buy,
        adverseLimitMicros: 10_025n * cent,
        market: market(quote(19_999, 9_996, 10_004), at(19_999)),
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      pricePassiveEntry({
        policy: steppedPolicy,
        symbol: 'QQQ',
        side: OrderSide.Buy,
        adverseLimitMicros: 10_025n * cent,
        market: market(quote(1_000, 9_996, 10_004), at(1_000)),
        windowStartedAt: at(1_001),
      }),
    ),
  ).toBe(true)

  // Before 20s: stays Passive at microprice ($100.00).
  const before = Result.getOrThrow(
    pricePassiveEntry({
      policy: steppedPolicy,
      symbol: 'QQQ',
      side: OrderSide.Buy,
      adverseLimitMicros: 10_025n * cent,
      market: market(quote(19_999, 9_996, 10_004), at(19_999)),
      windowStartedAt: at(0),
    }),
  )
  expect(before).toMatchObject({
    _tag: 'Price',
    stage: ExecutionPricingStage.Passive,
    limitPriceMicros: 10_000n * cent,
  })

  // At 20s: escalates to Marketable at ask ($100.04) + 2 bp padding ($100.06), strictly inside $100.25 collar.
  const buyEscalated = Result.getOrThrow(
    pricePassiveEntry({
      policy: steppedPolicy,
      symbol: 'QQQ',
      side: OrderSide.Buy,
      adverseLimitMicros: 10_025n * cent,
      market: market(quote(20_000, 9_996, 10_004), at(20_000)),
      windowStartedAt: at(0),
    }),
  )
  expect(buyEscalated).toMatchObject({
    _tag: 'Price',
    stage: ExecutionPricingStage.Marketable,
    limitPriceMicros: 10_006n * cent,
  })

  // Short side at 20s: bid ($99.96) - 2 bp padding ($99.95, rounded up into allowance), strictly inside $99.75 collar.
  const sellEscalated = Result.getOrThrow(
    pricePassiveEntry({
      policy: steppedPolicy,
      symbol: 'SMH',
      side: OrderSide.Sell,
      adverseLimitMicros: 9_975n * cent,
      market: market(quote(20_000, 9_996, 10_004, 'SMH'), at(20_000)),
      windowStartedAt: at(0),
    }),
  )
  expect(sellEscalated).toMatchObject({
    _tag: 'Price',
    stage: ExecutionPricingStage.Marketable,
    limitPriceMicros: 9_995n * cent,
  })

  // Never widens collar when ask is near collar; defers if touch itself exceeds collar.
  expect(
    Result.getOrThrow(
      pricePassiveEntry({
        policy: steppedPolicy,
        symbol: 'QQQ',
        side: OrderSide.Buy,
        adverseLimitMicros: 10_025n * cent,
        market: market(quote(20_000, 10_017, 10_025), at(20_000)),
        windowStartedAt: at(0),
      }),
    ),
  ).toMatchObject({ _tag: 'Price', stage: ExecutionPricingStage.Marketable, limitPriceMicros: 10_025n * cent })
  expect(
    Result.getOrThrow(
      pricePassiveEntry({
        policy: steppedPolicy,
        symbol: 'QQQ',
        side: OrderSide.Buy,
        adverseLimitMicros: 10_025n * cent,
        market: market(quote(20_000, 10_018, 10_026), at(20_000)),
        windowStartedAt: at(0),
      }),
    ),
  ).toEqual({ _tag: 'Defer', reason: PassiveDeferReason.ExceedsAdverseBound })
})

test('entry churn guards enforce minimumReanchorTicks, maximumReanchors, and single escalation without churn', () => {
  const entry = signal('QQQ', OrderSide.Buy)
  const resting = (limitCents: bigint, since: number, observed: number) =>
    order(entry, limitCents * cent, since, observed)
  // 2-tick move with 4-cent spread clears 50% deadband (>2c? no, 2c = 50% -> use 2c spread where 2c > 50% = 1c)
  // With minimumReanchorTicks = 3, a 2-tick move is suppressed while a 3-tick move reanchors.
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: entry,
        executionPolicy: steppedPolicy,
        market: market(quote(10_000, 10_001, 10_003), at(10_000)),
        order: resting(10_000n, 1_000, 10_000),
      }),
    )._tag,
  ).toBe('Keep')
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: entry,
        executionPolicy: steppedPolicy,
        market: market(quote(10_000, 10_002, 10_004), at(10_000)),
        order: resting(10_000n, 1_000, 10_000),
      }),
    ),
  ).toEqual({
    _tag: 'CancelForReanchor',
    brokerOrderId: 'order-1000',
    reason: PassiveReanchorReason.QuoteDrift,
    targetStage: ExecutionPricingStage.Passive,
    proposedLimitPriceMicros: 10_003n * cent,
  })
  // Once maximumReanchors (1) is exhausted, passive quote-drift reanchors are suppressed.
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: entry,
        executionPolicy: steppedPolicy,
        market: market(quote(10_000, 10_002, 10_004), at(10_000)),
        order: resting(10_000n, 1_000, 10_000),
        reanchorCount: 1,
      }),
    )._tag,
  ).toBe('Keep')
  // Time-decay escalation at t=20s STILL fires even when passive reanchor budget is exhausted (and on a 1-tick spread!).
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: entry,
        executionPolicy: steppedPolicy,
        market: market(quote(20_000, 10_000, 10_001), at(20_000)),
        order: resting(10_000n, 1_000, 20_000),
        reanchorCount: 1,
      }),
    ),
  ).toEqual({
    _tag: 'CancelForReanchor',
    brokerOrderId: 'order-1000',
    reason: PassiveReanchorReason.TimeDecayEscalation,
    targetStage: ExecutionPricingStage.Marketable,
    proposedLimitPriceMicros: 10_003n * cent,
  })
  // Once the working order is already at or above the marketable limit, hold with zero churn.
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: entry,
        executionPolicy: steppedPolicy,
        market: market(quote(29_000, 10_000, 10_001), at(29_000)),
        order: resting(10_003n, 20_500, 29_000),
        reanchorCount: 2,
      }),
    )._tag,
  ).toBe('Keep')
  // Reject invalid reanchor counts.
  expect(
    Result.isFailure(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: entry,
        executionPolicy: steppedPolicy,
        market: market(quote(10_000, 10_002, 10_004), at(10_000)),
        order: resting(10_000n, 1_000, 10_000),
        reanchorCount: -1,
      }),
    ),
  ).toBe(true)
})

test('escalated entries and exits retain orders that still cross the current NBBO touch', () => {
  const buyEntry = signal('QQQ', OrderSide.Buy)
  const workingBuy = order(buyEntry, 10_006n * cent, 20_500, 29_000)

  // Ask moves $100.04 -> $100.05: padded proposal rises to $100.07, but $100.06 still crosses the $100.05 ask.
  const buyMovedMarket = market(quote(29_000, 9_997, 10_005), at(29_000))
  expect(
    Result.getOrThrow(
      pricePassiveEntry({
        policy: steppedPolicy,
        symbol: 'QQQ',
        side: OrderSide.Buy,
        adverseLimitMicros: 10_025n * cent,
        market: buyMovedMarket,
        windowStartedAt: at(0),
      }),
    ),
  ).toMatchObject({
    _tag: 'Price',
    stage: ExecutionPricingStage.Marketable,
    limitPriceMicros: 10_007n * cent,
    marketableTouchPriceMicros: 10_005n * cent,
  })
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: buyEntry,
        executionPolicy: steppedPolicy,
        market: buyMovedMarket,
        order: workingBuy,
        reanchorCount: 2,
      }),
    )._tag,
  ).toBe('Keep')
  // Exact touch equality ($100.06 working vs $100.06 ask) also remains marketable and is retained.
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: buyEntry,
        executionPolicy: steppedPolicy,
        market: market(quote(29_000, 9_998, 10_006), at(29_000)),
        order: workingBuy,
        reanchorCount: 2,
      }),
    )._tag,
  ).toBe('Keep')
  // Ask moves to $100.07: $100.06 no longer crosses the ask, so re-anchor escalates cleanly to $100.09.
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: buyEntry,
        executionPolicy: steppedPolicy,
        market: market(quote(29_000, 9_999, 10_007), at(29_000)),
        order: workingBuy,
        reanchorCount: 2,
      }),
    ),
  ).toEqual({
    _tag: 'CancelForReanchor',
    brokerOrderId: 'order-20500',
    reason: PassiveReanchorReason.TimeDecayEscalation,
    targetStage: ExecutionPricingStage.Marketable,
    proposedLimitPriceMicros: 10_009n * cent,
  })
  // When ask moves above the $100.25 collar, collar deferral prevents re-anchoring beyond bounds.
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: buyEntry,
        executionPolicy: steppedPolicy,
        market: market(quote(29_000, 10_018, 10_026), at(29_000)),
        order: workingBuy,
        reanchorCount: 2,
      }),
    )._tag,
  ).toBe('Keep')

  // Symmetric sell entry with 3 bp padding: at $99.96 bid the escalated limit is $99.94; when bid moves
  // to $99.95 the padded proposal becomes $99.93, yet $99.94 still crosses the $99.95 bid and is retained.
  const sellSteppedPolicy = Result.getOrThrow(
    decodePassiveEntryPolicy({
      ...policyInput,
      escalateToMarketableAfterMs: 20_000,
      marketablePaddingBps: 3,
      maximumSpreadBps: 12,
      minimumReanchorTicks: 3,
      maximumReanchors: 1,
    }),
  )
  const sellEntry = signal('SMH', OrderSide.Sell)
  const workingSell = order(sellEntry, 9_994n * cent, 20_500, 29_000)
  const sellMovedMarket = market(quote(29_000, 9_995, 10_003, 'SMH'), at(29_000))
  expect(
    Result.getOrThrow(
      pricePassiveEntry({
        policy: sellSteppedPolicy,
        symbol: 'SMH',
        side: OrderSide.Sell,
        adverseLimitMicros: 9_975n * cent,
        market: sellMovedMarket,
        windowStartedAt: at(0),
      }),
    ),
  ).toMatchObject({
    _tag: 'Price',
    stage: ExecutionPricingStage.Marketable,
    limitPriceMicros: 9_993n * cent,
    marketableTouchPriceMicros: 9_995n * cent,
  })
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: sellEntry,
        executionPolicy: sellSteppedPolicy,
        market: sellMovedMarket,
        order: workingSell,
        reanchorCount: 2,
      }),
    )._tag,
  ).toBe('Keep')
  // Exact touch equality ($99.94 working vs $99.94 bid) also remains marketable and is retained.
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: sellEntry,
        executionPolicy: sellSteppedPolicy,
        market: market(quote(29_000, 9_994, 10_002, 'SMH'), at(29_000)),
        order: workingSell,
        reanchorCount: 2,
      }),
    )._tag,
  ).toBe('Keep')
  // Bid drops to $99.93: $99.94 no longer crosses the bid, so re-anchor escalates cleanly to $99.91.
  expect(
    Result.getOrThrow(
      planNoiseAreaEntryReanchor({
        policy: strategy,
        signal: sellEntry,
        executionPolicy: sellSteppedPolicy,
        market: market(quote(29_000, 9_993, 10_001, 'SMH'), at(29_000)),
        order: workingSell,
        reanchorCount: 2,
      }),
    ),
  ).toEqual({
    _tag: 'CancelForReanchor',
    brokerOrderId: 'order-20500',
    reason: PassiveReanchorReason.TimeDecayEscalation,
    targetStage: ExecutionPricingStage.Marketable,
    proposedLimitPriceMicros: 9_991n * cent,
  })

  // Escalated reduce-only exits also check marketability against the current NBBO touch (both sides).
  const flattenStart = Date.parse('2026-11-27T17:58:00.000Z')
  const exitAt = (offsetMs: number) => new Date(flattenStart + offsetMs).toISOString()
  const deadlineAt = '2026-11-27T17:59:00.000Z'
  const exitMarket = (offsetMs: number, bidCents: number, askCents: number) => ({
    cut: {
      observedAt: exitAt(offsetMs),
      regularOpenAt: '2026-11-27T14:30:00.000Z',
      regularCloseAt: '2026-11-27T18:00:00.000Z',
    },
    quote: {
      ...quote(0, bidCents, askCents, 'SMH'),
      event_at: exitAt(offsetMs - 100),
      ingested_at: exitAt(offsetMs - 75),
      source_offset: String(3_000_000 + offsetMs),
    },
  })
  const makeExitOrder = (side: OrderSide, limitCents: bigint): Order => ({
    ...order(signal('SMH', side), limitCents * cent, 0, 0),
    createdAt: exitAt(20_500),
    submittedAt: exitAt(20_500),
    updatedAt: exitAt(20_500),
    observedAt: exitAt(29_000),
    brokerOrderId: `exit-${side.toLowerCase()}-escalated`,
  })

  // Sell exit working at $99.94 is retained when bid is $99.95 (even though 5 bp padded proposal is $99.91),
  // and re-anchors to $99.89 once bid drops to $99.93.
  expect(
    Result.getOrThrow(
      planPassiveExitReanchor({
        policy: exitPolicy,
        symbol: 'SMH',
        side: OrderSide.Sell,
        market: exitMarket(29_000, 9_995, 10_003),
        windowStartedAt: exitAt(0),
        deadlineAt,
        order: makeExitOrder(OrderSide.Sell, 9_994n),
      }),
    )._tag,
  ).toBe('Keep')
  expect(
    Result.getOrThrow(
      planPassiveExitReanchor({
        policy: exitPolicy,
        symbol: 'SMH',
        side: OrderSide.Sell,
        market: exitMarket(29_000, 9_993, 10_001),
        windowStartedAt: exitAt(0),
        deadlineAt,
        order: makeExitOrder(OrderSide.Sell, 9_994n),
      }),
    ),
  ).toEqual({
    _tag: 'CancelForReanchor',
    brokerOrderId: 'exit-sell-escalated',
    reason: PassiveReanchorReason.TimeDecayEscalation,
    targetStage: ExecutionPricingStage.Marketable,
    proposedLimitPriceMicros: 9_989n * cent,
  })

  // Buy (short-cover) exit working at $100.06 is retained when ask is $100.05 (padded proposal $100.10),
  // and re-anchors to $100.12 once ask rises to $100.07.
  expect(
    Result.getOrThrow(
      planPassiveExitReanchor({
        policy: exitPolicy,
        symbol: 'SMH',
        side: OrderSide.Buy,
        market: exitMarket(29_000, 9_997, 10_005),
        windowStartedAt: exitAt(0),
        deadlineAt,
        order: makeExitOrder(OrderSide.Buy, 10_006n),
      }),
    )._tag,
  ).toBe('Keep')
  expect(
    Result.getOrThrow(
      planPassiveExitReanchor({
        policy: exitPolicy,
        symbol: 'SMH',
        side: OrderSide.Buy,
        market: exitMarket(29_000, 9_999, 10_007),
        windowStartedAt: exitAt(0),
        deadlineAt,
        order: makeExitOrder(OrderSide.Buy, 10_006n),
      }),
    ),
  ).toEqual({
    _tag: 'CancelForReanchor',
    brokerOrderId: 'exit-buy-escalated',
    reason: PassiveReanchorReason.TimeDecayEscalation,
    targetStage: ExecutionPricingStage.Marketable,
    proposedLimitPriceMicros: 10_012n * cent,
  })
})

test('passive-to-marketable reduce-only exits capture spread early and guarantee pre-deadline escalation', () => {
  const flattenStart = Date.parse('2026-11-27T17:58:00.000Z')
  const exitAt = (offsetMs: number) => new Date(flattenStart + offsetMs).toISOString()
  const deadlineAt = '2026-11-27T17:59:00.000Z'
  const exitSignal: NoiseAreaExitSignal = {
    _tag: 'TimedHalfDayFlatten',
    symbol: 'SMH',
    side: 'LONG',
    flattenAt: '2026-11-27T17:58:00.000Z',
  }
  const exitQuote = (offsetMs: number, bidCents: number, askCents: number, symbol: EtfNoiseAreaSymbol = 'SMH') => ({
    ...quote(0, bidCents, askCents, symbol),
    event_at: exitAt(offsetMs - 100),
    ingested_at: exitAt(offsetMs - 75),
    source_offset: String(2_000_000 + offsetMs),
  })
  const exitMarket = (offsetMs: number, bidCents: number, askCents: number, symbol: EtfNoiseAreaSymbol = 'SMH') => ({
    cut: {
      observedAt: exitAt(offsetMs),
      regularOpenAt: '2026-11-27T14:30:00.000Z',
      regularCloseAt: '2026-11-27T18:00:00.000Z',
    },
    quote: exitQuote(offsetMs, bidCents, askCents, symbol),
  })

  // Early 15:58 flatten rests passively at microprice ($100.01 sell on 99.97/100.04 quote, saving crossing cost).
  const passiveExit = Result.getOrThrow(
    planNoiseAreaExitPricing({
      policy: strategy,
      signal: exitSignal,
      executionPolicy: exitPolicy,
      market: exitMarket(1_000, 9_997, 10_004),
      windowStartedAt: exitAt(0),
      deadlineAt,
    }),
  )
  expect(passiveExit).toEqual({
    symbol: 'SMH',
    side: OrderSide.Sell,
    orderType: OrderType.Limit,
    limitPriceMicros: 10_001n * cent,
    stage: ExecutionPricingStage.Passive,
    reason: 'TimedHalfDayFlatten',
    reduceOnly: true,
    flattenAt: '2026-11-27T17:58:00.000Z',
  })

  // Locked quote on exit never defers; prices directly at touch as Marketable.
  expect(
    Result.getOrThrow(
      pricePassiveExit({
        policy: exitPolicy,
        symbol: 'SMH',
        side: OrderSide.Sell,
        market: exitMarket(1_000, 10_000, 10_000),
        windowStartedAt: exitAt(0),
        deadlineAt,
      }),
    ),
  ).toMatchObject({ _tag: 'Price', stage: ExecutionPricingStage.Marketable, limitPriceMicros: 9_995n * cent })

  // After escalateToMarketableAfterMs (20s): steps to marketable bid - 5 bp ($99.97 -> $99.93 rounded up).
  expect(
    Result.getOrThrow(
      planNoiseAreaExitPricing({
        policy: strategy,
        signal: exitSignal,
        executionPolicy: exitPolicy,
        market: exitMarket(20_000, 9_997, 10_004),
        windowStartedAt: exitAt(0),
        deadlineAt,
      }),
    ),
  ).toMatchObject({ stage: ExecutionPricingStage.Marketable, limitPriceMicros: 9_993n * cent })

  // Short cover exit escalates to ask + 5 bp ($100.04 -> $100.09).
  expect(
    Result.getOrThrow(
      planNoiseAreaExitPricing({
        policy: strategy,
        signal: { ...exitSignal, side: 'SHORT' },
        executionPolicy: exitPolicy,
        market: exitMarket(20_000, 9_997, 10_004),
        windowStartedAt: exitAt(0),
        deadlineAt,
      }),
    ),
  ).toMatchObject({ side: OrderSide.Buy, stage: ExecutionPricingStage.Marketable, limitPriceMicros: 10_009n * cent })

  // Mandatory pre-deadline escalation lead (15s before deadline = offset 45_000ms) bypasses minimumDwellMs!
  const lateOrder: Order = {
    ...order(signal('SMH', OrderSide.Sell), 10_001n * cent, 0, 0),
    createdAt: exitAt(43_000),
    submittedAt: exitAt(43_000),
    updatedAt: exitAt(43_000),
    observedAt: exitAt(45_000),
    brokerOrderId: 'exit-late-order',
  }
  expect(
    Result.getOrThrow(
      planNoiseAreaExitReanchor({
        policy: strategy,
        signal: exitSignal,
        executionPolicy: exitPolicy,
        market: exitMarket(45_000, 9_997, 10_004),
        windowStartedAt: exitAt(40_000), // Only 5s elapsed (<20s), only 2s dwell (<8s), but 15s left to deadline!
        deadlineAt,
        order: lateOrder,
      }),
    ),
  ).toEqual({
    _tag: 'CancelForReanchor',
    brokerOrderId: 'exit-late-order',
    reason: PassiveReanchorReason.TimeDecayEscalation,
    targetStage: ExecutionPricingStage.Marketable,
    proposedLimitPriceMicros: 9_993n * cent,
  })

  // Already marketable working exit holds without churn.
  expect(
    Result.getOrThrow(
      planPassiveExitReanchor({
        policy: exitPolicy,
        symbol: 'SMH',
        side: OrderSide.Sell,
        market: exitMarket(45_000, 9_997, 10_004),
        windowStartedAt: exitAt(0),
        deadlineAt,
        order: { ...lateOrder, limitPriceMicros: (9_993n * cent).toString() },
      }),
    )._tag,
  ).toBe('Keep')

  // Rejects non-QQQ/SMH cohorts and expired/noncausal exit windows.
  expect(
    Result.isFailure(
      planNoiseAreaExitPricing({
        policy: expandedEtfNoiseAreaPolicy,
        signal: exitSignal,
        executionPolicy: exitPolicy,
        market: exitMarket(1_000, 9_997, 10_004),
        windowStartedAt: exitAt(0),
        deadlineAt,
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      pricePassiveExit({
        policy: exitPolicy,
        symbol: 'SMH',
        side: OrderSide.Sell,
        market: exitMarket(60_000, 9_997, 10_004),
        windowStartedAt: exitAt(0),
        deadlineAt,
      }),
    ),
  ).toBe(true)
})

test('stepped NBBO prices compose with deriveExecutionIntentPricing and Alpaca order encoding', () => {
  const [entryPlan] = plan([signal('QQQ', OrderSide.Buy)], {
    policy: steppedPolicy,
    marketBySymbol: { QQQ: market(quote(1_000, 9_996, 10_004)) },
  })
  if (entryPlan === undefined) throw new Error('expected passive stepped entry plan')
  const intentPricing = Result.getOrThrow(
    deriveExecutionIntentPricing({
      symbol: 'QQQ',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: DomainTimeInForce.Day,
      quantityAtoms: entryPlan.quantityAtoms,
      referencePriceMicros: 100n * MICROS,
      limitSlippageBps: 25n,
      maximumBuyPriceMicros: entryPlan.limitPriceMicros,
    }),
  )
  expect(intentPricing.expectedExecutionPriceMicros).toBe(100n * MICROS)
  const request = Result.getOrThrow(
    orderRequestBody({
      symbol: 'QQQ',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: DomainTimeInForce.Day,
      clientOrderId: 'b1_' + 'B'.repeat(43),
      quantityAtoms: entryPlan.quantityAtoms.toString(),
      limitPriceMicros: intentPricing.expectedExecutionPriceMicros.toString(),
      notionalLimitMicros: intentPricing.notionalLimitMicros.toString(),
    }),
  )
  expect(request).toMatchObject({ symbol: 'QQQ', side: 'buy', type: 'limit', time_in_force: 'day', limit_price: '100' })
})

test('stepped NBBO replay recovers runaway breakout fill completion while cutting round-trip slippage and churn', () => {
  const runaway = [
    [1_000, 0],
    [4_000, 3],
    [10_000, 4],
    [20_000, 5],
    [25_000, 5],
  ] as const
  const pullback = [
    [1_000, 0],
    [2_000, 1],
    [10_000, 1],
    [15_000, 0],
  ] as const

  const runEntry = (
    tape: readonly (readonly [number, number])[],
    width: number,
    tradeAtEndCents: number,
    mode: 'control' | 'pure-passive' | 'stepped',
  ) => {
    const entry = signal('SMH', OrderSide.Buy)
    const legacy = plan([entry])[0]
    if (legacy === undefined) throw new Error('expected frozen collar')
    const activePolicy = mode === 'stepped' ? steppedPolicy : executionPolicy
    let working: { limit: bigint; since: number; reanchors: number } | undefined
    let cancels = 0
    for (const [offset, shift] of tape) {
      const bid = 10_000 + shift - width / 2
      const ask = 10_000 + shift + width / 2
      const view = market(quote(offset, bid, ask, 'SMH'), at(offset))
      const askMicros = BigInt(ask) * cent
      if (mode === 'control') {
        return {
          filled: askMicros <= legacy.limitPriceMicros,
          cancels: 0,
          costBps: Number((askMicros - entry.referencePriceMicros) * BPS) / Number(entry.referencePriceMicros),
        }
      }
      if (working === undefined) {
        const planned = plan([entry], { policy: activePolicy, marketBySymbol: { SMH: view } })[0]
        if (planned !== undefined) working = { limit: planned.limitPriceMicros, since: offset, reanchors: 0 }
        continue
      }
      // Check passive fill on quote pullback only if trade occurs strictly through working limit;
      // on marketable escalation (working >= ask), fills immediately at ask!
      if (working.limit >= askMicros) {
        return {
          filled: true,
          cancels,
          costBps: Number((askMicros - entry.referencePriceMicros) * BPS) / Number(entry.referencePriceMicros),
        }
      }
      const decision = Result.getOrThrow(
        planNoiseAreaEntryReanchor({
          policy: strategy,
          signal: entry,
          executionPolicy: activePolicy,
          market: view,
          order: order(entry, working.limit, working.since, offset),
          reanchorCount: working.reanchors,
        }),
      )
      if (decision._tag === 'CancelForReanchor') {
        cancels++
        working = {
          limit: decision.proposedLimitPriceMicros,
          since: offset + 500,
          reanchors: working.reanchors + 1,
        }
      }
    }
    const trade = BigInt(tradeAtEndCents) * cent
    if (working === undefined || !(trade < working.limit || (mode === 'stepped' && working.limit >= trade))) {
      return { filled: false, cancels: cancels + (working === undefined ? 0 : 1), costBps: null }
    }
    return {
      filled: true,
      cancels,
      costBps: Number((working.limit - entry.referencePriceMicros) * BPS) / Number(entry.referencePriceMicros),
    }
  }

  // Pullback case: both pure passive and stepped save the full 4 bp half-spread with 0 cancels!
  expect(runEntry(pullback, 8, 9_999, 'control')).toEqual({ filled: true, cancels: 0, costBps: 4 })
  expect(runEntry(pullback, 8, 9_999, 'pure-passive')).toEqual({ filled: true, cancels: 0, costBps: 0 })
  expect(runEntry(pullback, 8, 9_999, 'stepped')).toEqual({ filled: true, cancels: 0, costBps: 0 })

  // Runaway momentum breakout: pure-passive reanchors passively, still misses at expiry (2 cancels),
  // while stepped escalates once at t=20s and fills immediately (1 cancel, 100% fill completion).
  expect(runEntry(runaway, 8, 10_009, 'pure-passive')).toEqual({ filled: false, cancels: 2, costBps: null })
  expect(runEntry(runaway, 8, 10_009, 'stepped')).toEqual({ filled: true, cancels: 1, costBps: 9 })
})
