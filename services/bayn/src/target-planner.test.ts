import { cryptoMarketFixture } from './testing/crypto-market-fixture'
import { maximumAllocatedBuyQuantities } from './jev/entry-sizing'
import { adverseQuotePrices } from './observe-composition/intraday-market-data'
import { jevEntryQuoteExclusion } from './jev/trading-signals'
import { jevMarketForSymbol } from './jev/markets'
import { JevEntryExclusion } from './jev/batch'
import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'
import fc from 'fast-check'
import { checkProperty } from './testing/property-test-support'

import { canonicalHashV1Result } from './hash'
import {
  AccountStatus,
  DiscrepancyKind,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TimeInForce,
  type AccountSnapshot,
  type Order,
  type Position,
  type Reconciliation,
} from './execution/contracts'
import { reconciledStateHash } from './simulation-reconciliation/broker-model'
import {
  TargetPlanReason,
  TargetPlanStatus,
  decodeTargetPlanResult,
  intradaySnapshotReferencePricesSchemaVersion,
  planTargets,
  quoteBoundTargetPlannerInputSchemaVersion,
  referenceTargetPlanSchemaVersion,
  type TargetPlanResult,
  type TargetPlannerInput,
} from './target-planner/index'

const hash = (digit: string): string => digit.repeat(64)
const accountId = 'paper-account-1'
const signalDate = '2026-07-22'
const observedAt = '2026-07-23T13:29:00.000Z'
const brokerObservedAt = '2026-07-23T13:28:30.000Z'
const pricesObservedAt = '2026-07-23T13:28:00.000Z'
const reconciledAt = '2026-07-23T13:28:45.000Z'
const submissionCutoffAt = '2026-07-23T13:30:00.000Z'
const accountingHash = hash('a')

interface FixtureOptions {
  readonly accountId?: string
  readonly accountStatus?: AccountStatus
  readonly accountObservedAt?: string
  readonly allocationCapitalMicros?: string
  readonly buyingPowerMicros?: string
  readonly decisionHash?: string
  readonly equityMicros?: string
  readonly maximumInputAgeMs?: number
  readonly maximumBuyQuantityAtoms?: Readonly<Record<string, string>>
  readonly maximumSellQuantityAtoms?: Readonly<Record<string, string>>
  readonly observedAt?: string
  readonly orders?: readonly Order[]
  readonly ordersObservedAt?: string
  readonly positions?: readonly Position[]
  readonly positionsObservedAt?: string
  readonly priceMicros?: Readonly<Record<string, string>>
  readonly bidPriceMicros?: Readonly<Record<string, string>>
  readonly askPriceMicros?: Readonly<Record<string, string>>
  readonly pricesObservedAt?: string
  readonly referenceSignalDate?: '2026-07-21' | '2026-07-22'
  readonly submissionCutoffAt?: string
  readonly targetWeights?: Readonly<Record<string, number>>
  readonly unknownOrderCount?: number
}

const position = (
  symbol: string,
  quantityAtoms: string,
  positionObservedAt = brokerObservedAt,
  positionAccountId = accountId,
): Position => ({
  schemaVersion: 'bayn.position.v2',
  costBasisMicros: ((BigInt(quantityAtoms) * BigInt('50000000')) / 1_000_000_000n).toString(),
  accountId: positionAccountId,
  symbol,
  quantityAtoms,
  averageEntryPriceMicros: '50000000',
  marketPriceMicros: '50000000',
  marketValueMicros: quantityAtoms.startsWith('-') ? '-1' : quantityAtoms === '0' ? '0' : '1',
  unrealizedPnlMicros: '0',
  observedAt: positionObservedAt,
})

const order = (
  status: OrderStatus,
  symbol = 'AMD',
  orderObservedAt = brokerObservedAt,
  orderAccountId = accountId,
  known = true,
): Order => ({
  schemaVersion: 'bayn.order.v3',
  accountId: orderAccountId,
  brokerOrderId: `broker-${status}`,
  clientOrderId: `client-${status}`,
  ...(known ? { intentId: hash('9') } : {}),
  symbol,
  side: OrderSide.Buy,
  orderType: OrderType.Limit,
  timeInForce: TimeInForce.Day,
  limitPriceMicros: '50000000',
  quantityAtoms: '1000000000',
  filledQuantityAtoms: status === OrderStatus.Filled ? '1000000000' : '0',
  status,
  observedAt: orderObservedAt,
})

const reconciliation = (
  account: AccountSnapshot,
  positions: readonly Position[],
  positionsObservedAt: string,
  orders: readonly Order[],
  ordersObservedAt: string,
): Reconciliation => {
  const stateHash = Result.getOrThrow(
    reconciledStateHash({
      account,
      positions,
      positionsObservedAt,
      orders,
      ordersObservedAt,
      accountingHash,
    }),
  )
  const material = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId: account.accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt,
  }
  const reconciliationId = Result.getOrThrow(
    canonicalHashV1Result({
      schemaVersion: 'bayn.paper-reconciliation-id.v1',
      material,
    }),
  )
  return {
    ...material,
    reconciliationId,
    contentHash: Result.getOrThrow(canonicalHashV1Result({ ...material, reconciliationId })),
  }
}

const fixture = (options: FixtureOptions = {}): TargetPlannerInput => {
  const inputAccountId = options.accountId ?? accountId
  const positionsObservedAt = options.positionsObservedAt ?? brokerObservedAt
  const ordersObservedAt = options.ordersObservedAt ?? brokerObservedAt
  const positions = options.positions ?? [
    position('AMD', '80000000000', positionsObservedAt, inputAccountId),
    position('NVDA', '60000000000', positionsObservedAt, inputAccountId),
  ]
  const orders = options.orders ?? []
  const account: AccountSnapshot = {
    schemaVersion: 'bayn.paper-account-snapshot.v2',
    cryptoFeeTier: null,
    accountId: inputAccountId,
    status: options.accountStatus ?? AccountStatus.Active,
    currency: 'USD',
    cashMicros: '3000000000',
    equityMicros: options.equityMicros ?? '10000000000',
    buyingPowerMicros: options.buyingPowerMicros ?? '1500000000',
    observedAt: options.accountObservedAt ?? brokerObservedAt,
  }
  const prices = options.priceMicros ?? { AMD: '50000000', NVDA: '100000000' }
  const snapshotId = hash('7')
  const snapshotContentHash = hash('8')
  const bidPriceMicros = options.bidPriceMicros ?? prices
  const askPriceMicros = options.askPriceMicros ?? prices
  const priceMaterial = {
    schemaVersion: intradaySnapshotReferencePricesSchemaVersion,
    signalDate: options.referenceSignalDate ?? signalDate,
    observedAt: options.pricesObservedAt ?? pricesObservedAt,
    snapshotId,
    snapshotContentHash,
    priceReference: 'verified-adverse-quote-boundary' as const,
    priceMicros: askPriceMicros,
    bidPriceMicros,
    askPriceMicros,
  } as const
  return {
    schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
    strategyName: 'risk-balanced-trend',
    cycleId: hash('1'),
    decisionHash: options.decisionHash ?? hash('2'),
    policyHash: hash('3'),
    accountId: inputAccountId,
    signalDate,
    targetWeights: options.targetWeights ?? { AMD: 0.5, NVDA: 0.5 },
    referencePrices: { ...priceMaterial, contentHash: Result.getOrThrow(canonicalHashV1Result(priceMaterial)) },
    brokerState: {
      account,
      positions,
      positionsObservedAt,
      orders,
      ordersObservedAt,
      accountingHash,
      reconciliation: reconciliation(account, positions, positionsObservedAt, orders, ordersObservedAt),
      unknownOrderCount: options.unknownOrderCount ?? 0,
    },
    allocationCapitalMicros: options.allocationCapitalMicros ?? account.equityMicros,
    precision: {
      quantityIncrementAtoms: '1000',
      priceIncrementMicros: '100',
      minimumBuyNotionalMicros: '1000000',
    },
    executionTerms: {
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      priceReference: 'verified-adverse-quote-boundary',
      snapshotId,
      snapshotContentHash,
      maximumBuyQuantityAtoms:
        options.maximumBuyQuantityAtoms ??
        Object.fromEntries(Object.keys(prices).map((symbol) => [symbol, '1000000000000'])),
      maximumSellQuantityAtoms:
        options.maximumSellQuantityAtoms ??
        Object.fromEntries(Object.keys(prices).map((symbol) => [symbol, '1000000000000'])),
    },
    maximumInputAgeMs: options.maximumInputAgeMs ?? 120_000,
    submissionCutoffAt: options.submissionCutoffAt ?? submissionCutoffAt,
    observedAt: options.observedAt ?? observedAt,
  }
}

const planSuccess = (input: TargetPlannerInput): TargetPlanResult => {
  const result = planTargets(input)
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

test('property: the shared equity and crypto planner obeys quantity precision, liquidity and available capital', () => {
  checkProperty(
    'target-planner-capital-and-precision',
    fc.property(
      fc.constantFrom('AAPL', 'BTC/USD', 'ETH/USD', 'SOL/USD'),
      fc.bigInt({ min: 1_000_000n, max: 100_000_000_000n }),
      fc.bigInt({ min: 1n, max: 100_000_000n }),
      fc.bigInt({ min: 1n, max: 100_000_000n }),
      (symbol, priceUnits, desiredLots, capacityLots) => {
        const increment = symbol === 'AAPL' ? 1_000_000_000n : 1n
        const price = priceUnits * 100n
        const capital = (desiredLots * increment * price + 999_999_999n) / 1_000_000_000n
        const capacity = capacityLots * increment
        const baseInput = fixture({
          positions: [],
          targetWeights: { [symbol]: 1 },
          equityMicros: capital.toString(),
          allocationCapitalMicros: capital.toString(),
          buyingPowerMicros: capital.toString(),
          priceMicros: { [symbol]: price.toString() },
          maximumBuyQuantityAtoms: { [symbol]: capacity.toString() },
          maximumSellQuantityAtoms: { [symbol]: '0' },
        })
        const input = {
          ...baseInput,
          precision: {
            ...baseInput.precision,
            quantityIncrementAtoms: increment.toString(),
            minimumBuyNotionalMicros: '1',
          },
        }
        const saved = JSON.stringify(input)
        const planned = planSuccess(input)
        expect(planned.status).toBe(TargetPlanStatus.Planned)
        expect(planned.intentTargets).toHaveLength(1)
        const quantity = BigInt(planned.intentTargets[0]?.quantityAtoms ?? '0')
        const notional = (quantity * price + 999_999_999n) / 1_000_000_000n
        expect(quantity).toBeGreaterThan(0n)
        expect(quantity % increment).toBe(0n)
        expect(quantity).toBeLessThanOrEqual(capacity)
        expect(notional).toBeLessThanOrEqual(capital)
        expect(planned.requiredReferenceBuyNotionalMicros).toBe(notional.toString())
        expect(BigInt(planned.residualBuyingPowerMicros) + notional).toBe(capital)
        expect(planSuccess(input)).toEqual(planned)
        expect(JSON.stringify(input)).toBe(saved)
        const tampered = { ...planned, requiredReferenceBuyNotionalMicros: (notional + 1n).toString() }
        expect(Result.isFailure(decodeTargetPlanResult(tampered))).toBe(true)
      },
    ),
  )
})

test('property: exhausted buying power and the exact cutoff cannot emit a buy intent', () => {
  checkProperty(
    'target-planner-submit-boundaries',
    fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: 60_000 }), (price, lateMs) => {
      const options = {
        positions: [],
        targetWeights: { AAPL: 1 },
        priceMicros: { AAPL: String(BigInt(price) * 1_000_000n) },
        equityMicros: '10000000000000',
        allocationCapitalMicros: '10000000000000',
      }
      const noCash = planSuccess(fixture({ ...options, buyingPowerMicros: '0' }))
      expect(noCash.status).toBe(TargetPlanStatus.Blocked)
      expect(noCash.reason).toBe(TargetPlanReason.InsufficientBuyingPower)
      expect(noCash.intentTargets).toEqual([])
      const late = planSuccess(
        fixture({
          ...options,
          maximumInputAgeMs: 600_000,
          observedAt: new Date(Date.parse(submissionCutoffAt) + lateMs).toISOString(),
        }),
      )
      expect(late.status).toBe(TargetPlanStatus.Blocked)
      expect(late.reason).toBe(TargetPlanReason.SubmissionCutoffReached)
      expect(late.intentTargets).toEqual([])
    }),
  )
})

describe('causal target planner', () => {
  test('permits an empty quote-bound no-trade plan only for a flat account without unresolved orders', () => {
    const options = {
      allocationCapitalMicros: '1000000000',
      positions: [],
      targetWeights: {},
      priceMicros: {},
    } as const
    const planned = planSuccess(fixture(options))
    expect(planned).toMatchObject({ status: TargetPlanStatus.NoTrade, targets: [], intentTargets: [] })
    expect(Result.isSuccess(decodeTargetPlanResult(planned))).toBeTrue()
    expect(planSuccess(fixture({ ...options, orders: [order(OrderStatus.Filled)] })).status).toBe(
      TargetPlanStatus.NoTrade,
    )
    for (const input of [
      fixture({ ...options, positions: [position('AMD', '1000000000')] }),
      fixture({ ...options, orders: [order(OrderStatus.New)] }),
    ]) {
      expect(planSuccess(input).status).toBe(TargetPlanStatus.Blocked)
    }
  })

  test('binds absent whole-share ask capacity as a durable close-only block when holdings exist', () => {
    const blocked = planSuccess(
      fixture({
        allocationCapitalMicros: '1000000000',
        positions: [position('AMD', '1000000000')],
        priceMicros: { AMD: '100000000' },
        targetWeights: { AMD: 1 },
        maximumBuyQuantityAtoms: { AMD: '0' },
      }),
    )

    expect(blocked).toMatchObject({
      schemaVersion: referenceTargetPlanSchemaVersion,
      status: TargetPlanStatus.Blocked,
      reason: TargetPlanReason.InsufficientBuyLiquidity,
      targets: [{ symbol: 'AMD', currentQuantityAtoms: '1000000000', targetQuantityAtoms: '1000000000' }],
      intentTargets: [],
      requiredReferenceBuyNotionalMicros: '0',
    })
    expect(Result.isSuccess(decodeTargetPlanResult(blocked))).toBe(true)
  })

  test('binds insufficient entry sell liquidity as a durable close-only block', () => {
    const blocked = planSuccess(
      fixture({
        allocationCapitalMicros: '1000000000',
        positions: [position('AMD', '2000000000')],
        priceMicros: { AMD: '100000000' },
        targetWeights: { AMD: 0 },
        maximumSellQuantityAtoms: { AMD: '1000000000' },
      }),
    )

    expect(blocked).toMatchObject({
      schemaVersion: referenceTargetPlanSchemaVersion,
      status: TargetPlanStatus.Blocked,
      reason: TargetPlanReason.InsufficientSellLiquidity,
      targets: [],
      intentTargets: [],
      requiredReferenceBuyNotionalMicros: '0',
    })
    expect(Result.isSuccess(decodeTargetPlanResult(blocked))).toBe(true)
  })

  test('plans whole-share LIMIT/IOC deltas against an immutable adverse quote boundary', () => {
    const result = planSuccess(
      fixture({
        allocationCapitalMicros: '1000000000',
        positions: [],
        priceMicros: { AMD: '30000000' },
        targetWeights: { AMD: 1 },
      }),
    )

    expect(result).toMatchObject({
      schemaVersion: referenceTargetPlanSchemaVersion,
      status: TargetPlanStatus.Planned,
      executionTerms: {
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.ImmediateOrCancel,
        priceReference: 'verified-adverse-quote-boundary',
      },
      requiredReferenceBuyNotionalMicros: '990000000',
      targets: [{ symbol: 'AMD', targetQuantityAtoms: '33000000000' }],
      intentTargets: [
        {
          symbol: 'AMD',
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          quantityAtoms: '33000000000',
        },
      ],
    })
  })

  test('prices buys at the verified ask, sells at the verified bid, and does not churn inside the spread', () => {
    const options = {
      allocationCapitalMicros: '1000000000',
      priceMicros: { AMD: '100000000' },
      bidPriceMicros: { AMD: '90000000' },
      askPriceMicros: { AMD: '100000000' },
      targetWeights: { AMD: 1 },
    } as const
    const buy = planSuccess(fixture({ ...options, positions: [position('AMD', '5000000000')] }))
    const sell = planSuccess(fixture({ ...options, positions: [position('AMD', '12000000000')] }))
    const insideSpread = planSuccess(fixture({ ...options, positions: [position('AMD', '10000000000')] }))

    expect(buy).toMatchObject({
      status: TargetPlanStatus.Planned,
      targets: [{ symbol: 'AMD', referencePriceMicros: '100000000', targetQuantityAtoms: '10000000000' }],
      intentTargets: [{ symbol: 'AMD', side: OrderSide.Buy, quantityAtoms: '5000000000' }],
    })
    expect(sell).toMatchObject({
      status: TargetPlanStatus.Planned,
      targets: [{ symbol: 'AMD', referencePriceMicros: '90000000', targetQuantityAtoms: '11000000000' }],
      intentTargets: [{ symbol: 'AMD', side: OrderSide.Sell, quantityAtoms: '1000000000' }],
    })
    expect(insideSpread).toMatchObject({
      status: TargetPlanStatus.NoTrade,
      reason: TargetPlanReason.TargetsSatisfied,
      targets: [{ symbol: 'AMD', referencePriceMicros: '100000000', targetQuantityAtoms: '10000000000' }],
      intentTargets: [],
    })
  })

  test('rejects quote prices not bound to the execution snapshot identity', () => {
    const input = fixture({ allocationCapitalMicros: '1000000000' })
    if (input.schemaVersion !== 'bayn.target-planner-input.quote-bound.v1') throw new Error('expected quote input')

    expect(
      Result.isFailure(
        planTargets({
          ...input,
          executionTerms: { ...input.executionTerms, snapshotId: hash('9') },
        }),
      ),
    ).toBe(true)
  })

  test('rejects quote-bound evidence mislabeled as a legacy target plan', () => {
    const current = planSuccess(
      fixture({
        allocationCapitalMicros: '1000000000',
        positions: [],
        priceMicros: { AMD: '30000000' },
        targetWeights: { AMD: 1 },
      }),
    )
    const { outputHash: _outputHash, ...currentMaterial } = current
    const mislabeledLegacy = {
      ...currentMaterial,
      schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
    }

    expect(
      Result.isFailure(
        decodeTargetPlanResult({
          ...mislabeledLegacy,
          outputHash: Result.getOrThrow(canonicalHashV1Result(mislabeledLegacy)),
        }),
      ),
    ).toBe(true)
  })

  test('plans quote-bound quantities at the validated instrument increment', () => {
    const input = fixture({ allocationCapitalMicros: '1000000000', positions: [] })

    expect(
      Result.isSuccess(
        planTargets({
          ...input,
          precision: { ...input.precision, quantityIncrementAtoms: '1000' },
        }),
      ),
    ).toBe(true)
  })

  test('plans an exact fractional LIMIT/DAY close without permitting a buy', () => {
    const input = fixture({
      allocationCapitalMicros: '0',
      positions: [position('AMD', '500000000')],
      priceMicros: { AMD: '100000000' },
      targetWeights: { AMD: 0 },
      maximumBuyQuantityAtoms: { AMD: '0' },
    })
    if (input.schemaVersion !== quoteBoundTargetPlannerInputSchemaVersion) {
      return expect.unreachable('fractional close fixture requires quote-bound planning')
    }
    const result = planSuccess({
      ...input,
      precision: { ...input.precision, quantityIncrementAtoms: '1000' },
      executionTerms: {
        executionPurpose: 'forced-close',
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        priceReference: 'verified-adverse-quote-boundary',
        snapshotId: input.executionTerms.snapshotId,
        snapshotContentHash: input.executionTerms.snapshotContentHash,
        maximumBuyQuantityAtoms: { AMD: '0' },
        maximumSellQuantityAtoms: { AMD: '500000000' },
      },
    })

    expect(result).toMatchObject({
      status: TargetPlanStatus.Planned,
      executionTerms: {
        executionPurpose: 'forced-close',
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        priceReference: 'verified-adverse-quote-boundary',
      },
      targets: [{ symbol: 'AMD', currentQuantityAtoms: '500000000', targetQuantityAtoms: '0' }],
      intentTargets: [
        {
          symbol: 'AMD',
          side: OrderSide.Sell,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.Day,
          quantityAtoms: '500000000',
        },
      ],
    })
  })

  test('rejects a rehashed LIMIT/DAY close that lacks matching durable close evidence', () => {
    const planned = planSuccess(
      fixture({
        allocationCapitalMicros: '0',
        positions: [position('AMD', '1000000000')],
        priceMicros: { AMD: '100000000' },
        targetWeights: { AMD: 0 },
      }),
    )
    if (planned.status !== TargetPlanStatus.Planned) return expect.unreachable('expected a planned close')
    const { outputHash: _outputHash, ...material } = planned
    const tampered = {
      ...material,
      intentTargets: planned.intentTargets.map((intent) => ({
        ...intent,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
      })),
    }

    expect(
      Result.isFailure(
        decodeTargetPlanResult({ ...tampered, outputHash: Result.getOrThrow(canonicalHashV1Result(tampered)) }),
      ),
    ).toBe(true)
  })

  test('permits only the exactly reconciled short quantity in a forced buy-to-cover', () => {
    const input = fixture({
      allocationCapitalMicros: '0',
      buyingPowerMicros: '1',
      positions: [position('AMD', '-2000000000')],
      priceMicros: { AMD: '100000000' },
      targetWeights: { AMD: 0 },
      maximumBuyQuantityAtoms: { AMD: '2000000000' },
      maximumSellQuantityAtoms: { AMD: '0' },
    })
    if (input.schemaVersion !== quoteBoundTargetPlannerInputSchemaVersion) {
      return expect.unreachable('forced close fixture requires quote-bound planning')
    }
    if (input.executionTerms.orderType !== OrderType.Limit) {
      return expect.unreachable('whole-share forced close fixture requires LIMIT execution')
    }
    const result = planSuccess({
      ...input,
      executionTerms: {
        ...input.executionTerms,
        executionPurpose: 'forced-close',
      },
    })

    expect(result).toMatchObject({
      status: TargetPlanStatus.Planned,
      requiredReferenceBuyNotionalMicros: '0',
      residualBuyingPowerMicros: '1',
      targets: [{ symbol: 'AMD', currentQuantityAtoms: '-2000000000', targetQuantityAtoms: '0' }],
      intentTargets: [
        {
          symbol: 'AMD',
          side: OrderSide.Buy,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          quantityAtoms: '2000000000',
        },
      ],
    })
  })

  test('defers an entry-time short position to close-only containment', () => {
    const result = planSuccess(
      fixture({
        allocationCapitalMicros: '1000000000',
        positions: [position('AMD', '-2000000000')],
        priceMicros: { AMD: '100000000' },
        targetWeights: { AMD: 0 },
        maximumBuyQuantityAtoms: { AMD: '10000000000' },
      }),
    )

    expect(result).toMatchObject({
      status: TargetPlanStatus.Blocked,
      reason: TargetPlanReason.ShortPositionNotAllowed,
      intentTargets: [],
    })
  })

  test('caps only buy deltas at the verified whole-share ask quantity', () => {
    const result = planSuccess(
      fixture({
        allocationCapitalMicros: '1000000000',
        positions: [position('AMD', '20000000000')],
        priceMicros: { AMD: '10000000' },
        targetWeights: { AMD: 1 },
        maximumBuyQuantityAtoms: { AMD: '10000000000' },
      }),
    )

    expect(result).toMatchObject({
      status: TargetPlanStatus.Planned,
      targets: [{ symbol: 'AMD', currentQuantityAtoms: '20000000000', targetQuantityAtoms: '30000000000' }],
      intentTargets: [{ symbol: 'AMD', side: OrderSide.Buy, quantityAtoms: '10000000000' }],
    })
  })

  test('keeps sell-only reductions executable without whole-share ask capacity', () => {
    const result = planSuccess(
      fixture({
        allocationCapitalMicros: '1000000000',
        positions: [position('AMD', '20000000000')],
        priceMicros: { AMD: '10000000' },
        targetWeights: { AMD: 0.1 },
        maximumBuyQuantityAtoms: { AMD: '0' },
      }),
    )

    expect(result).toMatchObject({
      status: TargetPlanStatus.Planned,
      targets: [{ symbol: 'AMD', currentQuantityAtoms: '20000000000', targetQuantityAtoms: '10000000000' }],
      intentTargets: [{ symbol: 'AMD', side: OrderSide.Sell, quantityAtoms: '10000000000' }],
    })
  })

  test('fails closed when a positive buy delta has no whole-share ask capacity', () => {
    const result = planTargets(
      fixture({
        allocationCapitalMicros: '1000000000',
        positions: [],
        priceMicros: { AMD: '10000000' },
        targetWeights: { AMD: 1 },
        maximumBuyQuantityAtoms: { AMD: '0' },
      }),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        operation: 'derive-targets',
        message: 'quote-bound buy target has no executable displayed ask capacity',
        facts: { symbol: 'AMD' },
      })
    }
  })

  test('sizes an immutable execution target against its bounded allocation instead of full account equity', () => {
    const bounded = planSuccess(
      fixture({
        allocationCapitalMicros: '1000000000',
        buyingPowerMicros: '400000000000',
        equityMicros: '100000000000',
        positions: [],
      }),
    )

    expect(bounded).toMatchObject({
      status: TargetPlanStatus.Planned,
      requiredReferenceBuyNotionalMicros: '1000000000',
      targets: [
        { symbol: 'AMD', targetQuantityAtoms: '10000000000' },
        { symbol: 'NVDA', targetQuantityAtoms: '5000000000' },
      ],
    })
  })

  test.each(['bayn.paper-target-planner-input.v1', 'bayn.paper-target-planner-input.v2'])(
    'rejects retired executable planner input %s',
    (schemaVersion) => {
      const { executionTerms: _terms, allocationCapitalMicros: _allocation, ...current } = fixture({ positions: [] })
      const priceMaterial = {
        schemaVersion: 'bayn.signal-session-reference-prices.v1',
        signalDate: current.signalDate,
        observedAt: current.referencePrices.observedAt,
        priceMicros: current.referencePrices.priceMicros,
      }
      const retired = {
        ...current,
        schemaVersion,
        referencePrices: { ...priceMaterial, contentHash: Result.getOrThrow(canonicalHashV1Result(priceMaterial)) },
        ...(schemaVersion.endsWith('.v2') ? { allocationCapitalMicros: '1000000000' } : {}),
      }
      const result = planTargets(retired)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ operation: 'decode-input', reason: 'contract' })
      }
    },
  )

  test('requires explicit allocation and rejects allocation above current equity', () => {
    const input = fixture({ positions: [] })
    const { allocationCapitalMicros: _allocation, ...withoutAllocation } = input
    expect(Result.isFailure(planTargets(withoutAllocation))).toBe(true)
    const excessive = planSuccess(
      fixture({ allocationCapitalMicros: '10000000001', equityMicros: '10000000000', positions: [] }),
    )
    expect(excessive).toMatchObject({ status: TargetPlanStatus.Blocked, reason: TargetPlanReason.InputMismatch })
  })

  test('retains immutable legacy target-plan decoding without reopening legacy planning', () => {
    const current = planSuccess(fixture())
    if (current.status !== TargetPlanStatus.Planned) throw new Error('expected a planned historical fixture')
    const { outputHash: _hash, executionTerms: _terms, ...currentMaterial } = current
    const material = {
      ...currentMaterial,
      schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
      intentTargets: current.intentTargets.map((intent) => ({ ...intent, timeInForce: TimeInForce.Day as const })),
    }
    const historical = { ...material, outputHash: Result.getOrThrow(canonicalHashV1Result(material)) }
    expect(Result.getOrThrow(decodeTargetPlanResult(historical))).toEqual(historical)
    expect(Result.isFailure(decodeTargetPlanResult({ ...historical, outputHash: hash('f') }))).toBe(true)
  })

  test('turns an exhausted allocation into a deterministic flat no-trade target', () => {
    expect(planSuccess(fixture({ allocationCapitalMicros: '0', positions: [] }))).toMatchObject({
      status: TargetPlanStatus.NoTrade,
      reason: TargetPlanReason.TargetsSatisfied,
      requiredReferenceBuyNotionalMicros: '0',
      intentTargets: [],
    })
  })

  test('produces exact target deltas in stable sell-then-buy order without crediting the sell', () => {
    const result = planSuccess(fixture())

    expect(result.status).toBe(TargetPlanStatus.Planned)
    expect(result.reason).toBeNull()
    expect(result.targets).toEqual([
      {
        symbol: 'AMD',
        targetWeight: 0.5,
        referencePriceMicros: '50000000',
        currentQuantityAtoms: '80000000000',
        targetQuantityAtoms: '100000000000',
      },
      {
        symbol: 'NVDA',
        targetWeight: 0.5,
        referencePriceMicros: '100000000',
        currentQuantityAtoms: '60000000000',
        targetQuantityAtoms: '50000000000',
      },
    ])
    expect(result.intentTargets.map(({ symbol, side, quantityAtoms }) => ({ symbol, side, quantityAtoms }))).toEqual([
      {
        symbol: 'NVDA',
        side: OrderSide.Sell,
        quantityAtoms: '10000000000',
      },
      {
        symbol: 'AMD',
        side: OrderSide.Buy,
        quantityAtoms: '20000000000',
      },
    ])
    expect(result.requiredReferenceBuyNotionalMicros).toBe('1000000000')
    expect(result.residualBuyingPowerMicros).toBe('500000000')
    expect(
      result.intentTargets.every((intent) => !('schemaVersion' in intent) && !('notionalLimitMicros' in intent)),
    ).toBe(true)
  })

  test('replays byte-for-byte with golden hashes and binds decision drift', () => {
    const first = planSuccess(fixture())
    const replay = planSuccess(fixture())
    const reordered = planSuccess(
      fixture({
        priceMicros: { NVDA: '100000000', AMD: '50000000' },
        targetWeights: { NVDA: 0.5, AMD: 0.5 },
      }),
    )
    const changedDecision = planSuccess(fixture({ decisionHash: hash('4') }))

    expect(replay).toEqual(first)
    expect(reordered).toEqual(first)
    expect(first.inputHash).toBe('0716076c92ec9f3fb0261b1aab72ae37e3376dc25aa39f690b112184501d88ba')
    expect(first.outputHash).toBe('371fac767af074391ae9059615242e8f86f91421727f675e6c69991f2926592f')
    expect(changedDecision.inputHash).not.toBe(first.inputHash)
    expect(changedDecision.outputHash).not.toBe(first.outputHash)
    expect(changedDecision.intentTargets.every((intent) => intent.decisionHash === hash('4'))).toBe(true)
  })

  test('is independent of next-session gaps and every future OHLC field', () => {
    const futureSessions = [
      { open: '900000000', high: '999000000', low: '1', close: '777000000' },
      { open: '1', high: '2', low: '1', close: '3' },
    ]
    const plans = futureSessions.map(() => planSuccess(fixture()))

    expect(futureSessions[0]).not.toEqual(futureSessions[1])
    expect(plans[1]).toEqual(plans[0])
  })

  test('returns no-trade when the rounded targets already match the all-cash account', () => {
    const result = planSuccess(
      fixture({
        positions: [],
        targetWeights: { AMD: 0, NVDA: 0 },
      }),
    )

    expect(result).toMatchObject({
      status: TargetPlanStatus.NoTrade,
      reason: TargetPlanReason.TargetsSatisfied,
      intentTargets: [],
      requiredReferenceBuyNotionalMicros: '0',
      residualBuyingPowerMicros: '1500000000',
    })
  })

  test('liquidates only the existing long quantity and rejects an existing short', () => {
    const liquidation = planSuccess(
      fixture({
        buyingPowerMicros: '-1000000',
        positions: [position('AMD', '1000000000'), position('NVDA', '2000000000')],
        targetWeights: { AMD: 0, NVDA: 0 },
      }),
    )
    const short = planSuccess(
      fixture({
        positions: [position('AMD', '-1000'), position('NVDA', '2000000000')],
      }),
    )

    expect(liquidation.intentTargets.map((intent) => [intent.symbol, intent.side, intent.quantityAtoms])).toEqual([
      ['AMD', OrderSide.Sell, '1000000000'],
      ['NVDA', OrderSide.Sell, '2000000000'],
    ])
    expect(liquidation.status).toBe(TargetPlanStatus.Planned)
    expect(short).toMatchObject({
      status: TargetPlanStatus.Blocked,
      reason: TargetPlanReason.ShortPositionNotAllowed,
      intentTargets: [],
    })
  })

  test('reserves aggregate buys against current buying power without unfilled sell proceeds', () => {
    const aggregate = planSuccess(
      fixture({
        buyingPowerMicros: '6000000000',
        positions: [],
      }),
    )
    const sellDoesNotFund = planSuccess(
      fixture({
        buyingPowerMicros: '1500000000',
        positions: [position('AMD', '0'), position('NVDA', '100000000000')],
        targetWeights: {
          AMD: 0.5,
          NVDA: 0,
        },
      }),
    )

    expect(aggregate).toMatchObject({
      status: TargetPlanStatus.Blocked,
      reason: TargetPlanReason.InsufficientBuyingPower,
      intentTargets: [],
      requiredReferenceBuyNotionalMicros: '10000000000',
      availableBuyingPowerMicros: '6000000000',
    })
    expect(sellDoesNotFund).toMatchObject({
      status: TargetPlanStatus.Blocked,
      reason: TargetPlanReason.InsufficientBuyingPower,
      intentTargets: [],
      requiredReferenceBuyNotionalMicros: '5000000000',
      availableBuyingPowerMicros: '1500000000',
    })
  })

  test('treats the submission cutoff as an exclusive boundary', () => {
    const before = planSuccess(fixture({ observedAt: '2026-07-23T13:29:59.999Z' }))
    const exact = planSuccess(fixture({ observedAt: submissionCutoffAt }))
    const after = planSuccess(fixture({ observedAt: '2026-07-23T13:30:00.001Z' }))

    expect(before.status).toBe(TargetPlanStatus.Planned)
    expect(exact.reason).toBe(TargetPlanReason.SubmissionCutoffReached)
    expect(after.reason).toBe(TargetPlanReason.SubmissionCutoffReached)
  })

  test('blocks input at the exact freshness boundary and observations from the future', () => {
    const stale = planSuccess(
      fixture({
        accountObservedAt: '2026-07-23T13:27:00.000Z',
        maximumInputAgeMs: 120_000,
      }),
    )
    const future = fixture({ pricesObservedAt: '2026-07-23T13:29:00.001Z' })

    expect(stale.reason).toBe(TargetPlanReason.InputStale)
    expect(planSuccess(future).reason).toBe(TargetPlanReason.InputMismatch)
  })

  test('rejects a reference vector labeled as a signal session that has not happened', () => {
    const input = fixture()
    const { contentHash: _hash, ...priceMaterial } = input.referencePrices
    const material = { ...priceMaterial, signalDate: '2026-07-24' as const }
    const futureSignal = {
      ...input,
      signalDate: material.signalDate,
      referencePrices: { ...material, contentHash: Result.getOrThrow(canonicalHashV1Result(material)) },
    }

    expect(planSuccess(futureSignal).reason).toBe(TargetPlanReason.IdentityMismatch)
  })

  test('blocks identity, reference-vector, and reconciliation mismatches', () => {
    const identity = planSuccess(fixture({ referenceSignalDate: '2026-07-21' }))
    const referenceInput = fixture()
    const reconciliationInput = fixture()
    const leveraged = planSuccess(fixture({ targetWeights: { AMD: 0.75, NVDA: 0.75 } }))
    const badReference = {
      ...referenceInput,
      referencePrices: { ...referenceInput.referencePrices, contentHash: hash('f') },
    }
    const badReconciliation = {
      ...reconciliationInput,
      brokerState: {
        ...reconciliationInput.brokerState,
        reconciliation: {
          ...reconciliationInput.brokerState.reconciliation,
          observedHash: hash('e'),
        },
      },
    }

    expect(identity.reason).toBe(TargetPlanReason.IdentityMismatch)
    expect(leveraged.reason).toBe(TargetPlanReason.InputMismatch)
    expect(planSuccess(badReference).reason).toBe(TargetPlanReason.InputMismatch)
    expect(planSuccess(badReconciliation).reason).toBe(TargetPlanReason.ReconciliationNotExact)
  })

  test('blocks unknown and unresolved orders but accepts terminal order history', () => {
    const unknownOrder = order(OrderStatus.Filled, 'AMD', brokerObservedAt, accountId, false)
    const unknown = planSuccess(fixture({ orders: [unknownOrder], unknownOrderCount: 1 }))
    const unresolvedOrder = order(OrderStatus.New)
    const unresolved = planSuccess(fixture({ orders: [unresolvedOrder] }))
    const terminalOrder = order(OrderStatus.Filled)
    const terminal = planSuccess(fixture({ orders: [terminalOrder] }))

    expect(unknown.reason).toBe(TargetPlanReason.UnknownOrder)
    expect(unresolved.reason).toBe(TargetPlanReason.UnresolvedOrder)
    expect(terminal.status).toBe(TargetPlanStatus.Planned)
  })

  test('rounds target quantity once to the declared increment and blocks sub-minimum buys', () => {
    const preciseInput = fixture({
      buyingPowerMicros: '10000000000',
      positions: [],
      priceMicros: { AMD: '30000000' },
      targetWeights: { AMD: 1 },
    })
    const precise = {
      ...preciseInput,
      precision: { ...preciseInput.precision, quantityIncrementAtoms: '1000000000' as const },
    }
    const rounded = planSuccess(precise)

    const dust = fixture({
      buyingPowerMicros: '10000000000',
      equityMicros: '1000000',
      positions: [],
      priceMicros: { 'BTC/USD': '100000000' },
      targetWeights: { 'BTC/USD': 0.1 },
    })

    expect(rounded.targets[0]?.targetQuantityAtoms).toBe('333000000000')
    expect(rounded.intentTargets[0]?.quantityAtoms).toBe('333000000000')
    const belowMinimum = planSuccess(dust)
    expect(belowMinimum.reason).toBe(TargetPlanReason.BelowMinimumBuyNotional)
    expect(belowMinimum.requiredReferenceBuyNotionalMicros).toBe('100000')
  })

  test('blocks a durable reconciliation discrepancy even when its top-level hashes agree', () => {
    const input = fixture()
    const discrepancy = {
      discrepancyId: hash('5'),
      kind: DiscrepancyKind.Order,
      identity: 'client-order',
      expected: 'resolved',
      observed: 'open',
      evidenceHash: hash('6'),
      firstObservedAt: reconciledAt,
      lastObservedAt: reconciledAt,
    }
    const material = {
      schemaVersion: 'bayn.paper-reconciliation.v1' as const,
      accountId,
      expectedHash: hash('7'),
      observedHash: hash('8'),
      status: ReconciliationStatus.Discrepancy,
      discrepancies: [discrepancy],
      reconciledAt,
    }
    const reconciliationId = Result.getOrThrow(
      canonicalHashV1Result({
        schemaVersion: 'bayn.paper-reconciliation-id.v1',
        material,
      }),
    )
    const discrepantInput = {
      ...input,
      brokerState: {
        ...input.brokerState,
        reconciliation: {
          ...material,
          reconciliationId,
          contentHash: Result.getOrThrow(canonicalHashV1Result({ ...material, reconciliationId })),
        },
      },
    }

    expect(planSuccess(discrepantInput).reason).toBe(TargetPlanReason.ReconciliationNotExact)
  })

  test('covers every terminal planner action with its exact closed reason', () => {
    const reconciliationMismatch = fixture()
    const belowMinimum = fixture({
      buyingPowerMicros: '10000000000',
      equityMicros: '1000000',
      positions: [],
      priceMicros: { 'BTC/USD': '100000000' },
      targetWeights: { 'BTC/USD': 0.1 },
    })
    const externalOrder = order(OrderStatus.Filled, 'AMD', brokerObservedAt, accountId, false)
    const cases: readonly [TargetPlanReason, TargetPlannerInput][] = [
      [TargetPlanReason.SubmissionCutoffReached, fixture({ observedAt: submissionCutoffAt })],
      [TargetPlanReason.IdentityMismatch, fixture({ referenceSignalDate: '2026-07-21' })],
      [TargetPlanReason.InputMismatch, fixture({ targetWeights: { AMD: 0.75, NVDA: 0.75 } })],
      [
        TargetPlanReason.InputStale,
        fixture({ accountObservedAt: '2026-07-23T13:27:00.000Z', maximumInputAgeMs: 120_000 }),
      ],
      [
        TargetPlanReason.ReconciliationNotExact,
        {
          ...reconciliationMismatch,
          brokerState: {
            ...reconciliationMismatch.brokerState,
            reconciliation: {
              ...reconciliationMismatch.brokerState.reconciliation,
              observedHash: hash('e'),
            },
          },
        },
      ],
      [TargetPlanReason.AccountNotActive, fixture({ accountStatus: AccountStatus.Restricted })],
      [TargetPlanReason.UnknownOrder, fixture({ orders: [externalOrder], unknownOrderCount: 1 })],
      [TargetPlanReason.UnresolvedOrder, fixture({ orders: [order(OrderStatus.New)] })],
      [
        TargetPlanReason.ShortPositionNotAllowed,
        fixture({ positions: [position('AMD', '-1000'), position('NVDA', '2000000000')] }),
      ],
      [TargetPlanReason.NonPositiveEquity, fixture({ equityMicros: '0' })],
      [TargetPlanReason.BelowMinimumBuyNotional, belowMinimum],
      [TargetPlanReason.InsufficientBuyingPower, fixture({ buyingPowerMicros: '1', positions: [] })],
      [TargetPlanReason.TargetsSatisfied, fixture({ positions: [], targetWeights: { AMD: 0, NVDA: 0 } })],
    ]

    expect(cases.map(([_, input]) => planSuccess(input).reason)).toEqual(cases.map(([reason]) => reason))
  })

  test('returns tagged failures for malformed domain input without BigInt, date, or canonicalization defects', () => {
    const malformed: readonly unknown[] = [
      { ...fixture(), observedAt: 'not-an-instant' },
      { ...fixture(), precision: { ...fixture().precision, quantityIncrementAtoms: '0' } },
      {
        ...fixture(),
        referencePrices: {
          ...fixture().referencePrices,
          priceMicros: { AMD: 'not-micros', NVDA: '100000000' },
        },
      },
      { ...fixture(), targetWeights: { AMD: Number.NaN, NVDA: 0.5 } },
    ]

    for (const input of malformed) {
      const result = planTargets(input)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe('TargetPlannerFailure')
        expect(result.failure.operation).toBe('decode-input')
        expect(result.failure.cause).toBeDefined()
      }
    }
  })

  test('returns a tagged precision failure for a decoded weight beyond the execution fixed-point', () => {
    const result = planTargets(
      fixture({
        targetWeights: {
          AMD: 0.12345678901234,
          NVDA: 0.5,
        },
      }),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'TargetPlannerFailure',
        operation: 'derive-targets',
        reason: 'precision',
        facts: {
          symbol: 'AMD',
          targetWeight: 0.12345678901234,
        },
      })
      expect(result.failure.cause).toBeDefined()
    }
  })

  test('rejects noncanonical, sign-incoherent, duplicate, and temporally incoherent broker state before planning', () => {
    const filled = order(OrderStatus.Filled)
    const canceled = order(OrderStatus.Canceled)
    const cases = [
      fixture({ positions: [position('AMD', '1000'), position('AMD', '2000')] }),
      fixture({ positions: [position('NVDA', '2000'), position('AMD', '1000')] }),
      fixture({ orders: [filled, canceled] }),
      fixture({ positions: [{ ...position('AMD', '1000'), marketValueMicros: '-1' }, position('NVDA', '2000')] }),
      fixture({ positions: [{ ...position('AMD', '0'), marketValueMicros: '1' }, position('NVDA', '2000')] }),
      fixture({ positions: [{ ...position('AMD', '-1000'), marketValueMicros: '1' }, position('NVDA', '2000')] }),
      fixture({ positions: [position('AMD', '1000', '2026-07-23T13:27:00.000Z'), position('NVDA', '2000')] }),
      fixture({ positions: [position('AMD', '1000', '2026-07-23T13:29:00.001Z'), position('NVDA', '2000')] }),
      fixture({ unknownOrderCount: 1 }),
    ]

    expect(cases.map((input) => planSuccess(input).reason)).toEqual(cases.map(() => TargetPlanReason.InputMismatch))
  })

  test('rejects rehashed status, sign, delta, ordering, reason-fact, and buying-power impossibilities', () => {
    const valid = planSuccess(fixture())
    const rehash = (candidate: Omit<typeof valid, 'outputHash'>) => ({
      ...candidate,
      outputHash: Result.getOrThrow(canonicalHashV1Result(candidate)),
    })
    const { outputHash: _, ...material } = valid
    const candidates: readonly unknown[] = [
      rehash({ ...material, intentTargets: [...material.intentTargets].reverse() }),
      rehash({
        ...material,
        intentTargets: material.intentTargets.map((intent, index) =>
          index === 0 ? { ...intent, quantityAtoms: (BigInt(intent.quantityAtoms) + 1n).toString() } : intent,
        ),
      }),
      rehash({ ...material, requiredReferenceBuyNotionalMicros: '1' }),
      rehash({ ...material, residualBuyingPowerMicros: '1' }),
      rehash({
        ...material,
        targets: material.targets.map((target, index) =>
          index === 0 ? { ...target, targetQuantityAtoms: target.currentQuantityAtoms } : target,
        ),
      }),
      rehash({
        ...material,
        targets: material.targets.map((target, index) =>
          index === 0 ? { ...target, targetQuantityAtoms: '-1000' } : target,
        ),
      }),
      rehash({
        ...material,
        targets: material.targets.map((target, index) =>
          index === 0 ? { ...target, currentQuantityAtoms: '-1000' } : target,
        ),
      }),
      rehash({
        ...material,
        targets: material.targets.map((target, index) => (index === 0 ? { ...target, targetWeight: 0 } : target)),
      }),
      rehash({
        ...material,
        availableBuyingPowerMicros: '0',
        residualBuyingPowerMicros: `-${material.requiredReferenceBuyNotionalMicros}`,
      }),
      (() => {
        const noTrade = planSuccess(fixture({ positions: [], targetWeights: { AMD: 0, NVDA: 0 } }))
        const { outputHash: _, ...noTradeMaterial } = noTrade
        const { executionTerms: _terms, ...historicalMaterial } = noTradeMaterial
        const impossible = {
          ...historicalMaterial,
          schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
          targets: [],
        }
        return { ...impossible, outputHash: Result.getOrThrow(canonicalHashV1Result(impossible)) }
      })(),
      (() => {
        const impossible = {
          schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
          inputHash: valid.inputHash,
          status: TargetPlanStatus.Blocked,
          reason: TargetPlanReason.InsufficientBuyingPower,
          targets: [],
          intentTargets: [],
          requiredReferenceBuyNotionalMicros: '0',
          availableBuyingPowerMicros: '-1',
          residualBuyingPowerMicros: '-1',
        }
        return { ...impossible, outputHash: Result.getOrThrow(canonicalHashV1Result(impossible)) }
      })(),
    ]

    for (const candidate of candidates) {
      expect(Result.isFailure(decodeTargetPlanResult(candidate))).toBe(true)
    }
  })

  test('rejects ill-formed Unicode at the exact intent identity path before output hashing', () => {
    const valid = planSuccess(fixture())
    const candidate = {
      ...valid,
      intentTargets: valid.intentTargets.map((intent) => ({ ...intent, strategyName: '\ud800' })),
    }
    const result = decodeTargetPlanResult(candidate)

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'TargetPlannerFailure',
        operation: 'decode-output',
        reason: 'contract',
      })
      expect(result.failure.cause).toBeDefined()
      expect(String(result.failure.cause)).toContain('["intentTargets"][0]["strategyName"]')
      expect(String(result.failure.cause)).toContain('well-formed Unicode')
    }
  })
})

const allocatedEntryQuoteFixture = cryptoMarketFixture().snapshot.latestQuotes['BTC/USD']
if (allocatedEntryQuoteFixture === undefined) throw new Error('Expected native quote fixture')
const entrySizingSymbolArbitrary = fc.constantFrom('AAPL', 'BTC/USD', 'ETH/USD', 'SOL/USD')

test('property: capital sizing is invariant to displayed quote size and never exceeds its allocation', () => {
  checkProperty(
    'capital-entry-sizing',
    fc.property(
      entrySizingSymbolArbitrary,
      fc.integer({ min: 1_000_000, max: 1_000_000_000_000 }),
      fc.integer({ min: 1, max: 200_000 }),
      fc.integer({ min: 1, max: 100_000 }),
      fc.integer({ min: 1, max: 100_000_000 }),
      (symbol, capital, weightPpm, price, sizeAtoms) => {
        const quote = {
          ...allocatedEntryQuoteFixture,
          symbol,
          bidPrice: price,
          askPrice: price + 0.01,
          askSize: sizeAtoms / 1_000_000_000,
        }
        const input = {
          snapshot: { latestQuotes: { [symbol]: quote } },
          targetWeights: { [symbol]: weightPpm / 1_000_000 },
          capitalMicros: String(capital),
          precision: { quantityIncrementAtoms: '1', priceIncrementMicros: '100', minimumBuyNotionalMicros: '1000000' },
        }
        const first = Result.getOrThrow(
          maximumAllocatedBuyQuantities({
            ...input,
            askPriceMicros: Result.getOrThrow(adverseQuotePrices(input.snapshot, [symbol])).askPriceMicros,
          }),
        )
        const changedQuote = { ...quote, askSize: quote.askSize * 1000 }
        const other = Result.getOrThrow(
          maximumAllocatedBuyQuantities({
            ...input,
            askPriceMicros: Result.getOrThrow(
              adverseQuotePrices({ latestQuotes: { [symbol]: changedQuote } }, [symbol]),
            ).askPriceMicros,
          }),
        )
        expect(first).toEqual(other)
        const quantity = BigInt(first[symbol] ?? '0')
        const prices = Result.getOrThrow(adverseQuotePrices(input.snapshot, [symbol]))
        expect((quantity * BigInt(prices.askPriceMicros[symbol] ?? '0')) / 1_000_000_000n).toBeLessThanOrEqual(
          (BigInt(capital) * BigInt(weightPpm)) / 1_000_000n,
        )
        expect(quantity % (symbol === 'AAPL' ? 1_000_000_000n : 1n)).toBe(0n)
      },
    ),
  )
})

test('property: one quote gate enforces the exact market spread boundary and positive liquidity', () => {
  checkProperty(
    'market-entry-spread',
    fc.property(entrySizingSymbolArbitrary, fc.integer({ min: 0, max: 100 }), (symbol, spreadBps) => {
      const quote = {
        ...allocatedEntryQuoteFixture,
        symbol,
        bidPrice: 10000 - spreadBps / 2,
        askPrice: 10000 + spreadBps / 2,
        bidSize: 1,
        askSize: 1,
      }
      const exclusion = Result.getOrThrow(jevEntryQuoteExclusion(quote))
      expect(exclusion).toBe(
        spreadBps > jevMarketForSymbol(symbol).maximumEntrySpreadBps ? JevEntryExclusion.Spread : null,
      )
      expect(Result.getOrThrow(jevEntryQuoteExclusion({ ...quote, askSize: 0 }))).not.toBeNull()
    }),
  )
})
