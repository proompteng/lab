import { describe, expect, test } from 'bun:test'

import { canonicalHashV1 } from './hash'
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
} from './paper'
import { reconciledStateHash } from './reconciliation'
import {
  TargetPlanReason,
  TargetPlanStatus,
  planTargets,
  type SignalSessionReferencePrices,
  type TargetPlannerInput,
} from './target-planner'

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
  readonly buyingPowerMicros?: string
  readonly decisionHash?: string
  readonly equityMicros?: string
  readonly maximumInputAgeMs?: number
  readonly observedAt?: string
  readonly orders?: readonly Order[]
  readonly ordersObservedAt?: string
  readonly positions?: readonly Position[]
  readonly positionsObservedAt?: string
  readonly priceMicros?: Readonly<Record<string, string>>
  readonly pricesObservedAt?: string
  readonly referenceSignalDate?: '2026-07-21' | '2026-07-22'
  readonly submissionCutoffAt?: string
  readonly targetWeights?: Readonly<Record<string, number>>
  readonly unknownOrderCount?: number
}

const position = (
  symbol: string,
  quantityMicros: string,
  positionObservedAt = brokerObservedAt,
  positionAccountId = accountId,
): Position => ({
  schemaVersion: 'bayn.paper-position.v1',
  accountId: positionAccountId,
  symbol,
  quantityMicros,
  averageEntryPriceMicros: '50000000',
  marketPriceMicros: '50000000',
  marketValueMicros: quantityMicros.startsWith('-') ? '-1' : quantityMicros === '0' ? '0' : '1',
  unrealizedPnlMicros: '0',
  observedAt: positionObservedAt,
})

const order = (
  status: OrderStatus,
  symbol = 'AMD',
  orderObservedAt = brokerObservedAt,
  orderAccountId = accountId,
): Order => ({
  schemaVersion: 'bayn.paper-order.v1',
  accountId: orderAccountId,
  brokerOrderId: `broker-${status}`,
  clientOrderId: `client-${status}`,
  symbol,
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: '1000000',
  filledQuantityMicros: status === OrderStatus.Filled ? '1000000' : '0',
  status,
  observedAt: orderObservedAt,
})

const referencePrices = (
  priceMicros: Readonly<Record<string, string>>,
  referenceObservedAt: string,
  referenceSignalDate: '2026-07-21' | '2026-07-22',
): SignalSessionReferencePrices => {
  const material = {
    schemaVersion: 'bayn.signal-session-reference-prices.v1' as const,
    signalDate: referenceSignalDate,
    observedAt: referenceObservedAt,
    priceMicros,
  }
  return { ...material, contentHash: canonicalHashV1(material) }
}

const reconciliation = (
  account: AccountSnapshot,
  positions: readonly Position[],
  positionsObservedAt: string,
  orders: readonly Order[],
  ordersObservedAt: string,
): Reconciliation => {
  const stateHash = reconciledStateHash({
    account,
    positions,
    positionsObservedAt,
    orders,
    ordersObservedAt,
    accountingHash,
  })
  const material = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId: account.accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt,
  }
  const reconciliationId = canonicalHashV1({
    schemaVersion: 'bayn.paper-reconciliation-id.v1',
    material,
  })
  return {
    ...material,
    reconciliationId,
    contentHash: canonicalHashV1({ ...material, reconciliationId }),
  }
}

const fixture = (options: FixtureOptions = {}): TargetPlannerInput => {
  const inputAccountId = options.accountId ?? accountId
  const positionsObservedAt = options.positionsObservedAt ?? brokerObservedAt
  const ordersObservedAt = options.ordersObservedAt ?? brokerObservedAt
  const positions = options.positions ?? [
    position('AMD', '80000000', positionsObservedAt, inputAccountId),
    position('NVDA', '60000000', positionsObservedAt, inputAccountId),
  ]
  const orders = options.orders ?? []
  const account: AccountSnapshot = {
    schemaVersion: 'bayn.paper-account-snapshot.v1',
    accountId: inputAccountId,
    status: options.accountStatus ?? AccountStatus.Active,
    currency: 'USD',
    cashMicros: '3000000000',
    equityMicros: options.equityMicros ?? '10000000000',
    buyingPowerMicros: options.buyingPowerMicros ?? '1500000000',
    observedAt: options.accountObservedAt ?? brokerObservedAt,
  }
  const prices = options.priceMicros ?? { AMD: '50000000', NVDA: '100000000' }
  return {
    schemaVersion: 'bayn.paper-target-planner-input.v1',
    strategyName: 'risk-balanced-trend',
    cycleId: hash('1'),
    decisionHash: options.decisionHash ?? hash('2'),
    policyHash: hash('3'),
    accountId: inputAccountId,
    signalDate,
    targetWeights: options.targetWeights ?? {
      AMD: 0.5,
      NVDA: 0.5,
    },
    referencePrices: referencePrices(
      prices,
      options.pricesObservedAt ?? pricesObservedAt,
      options.referenceSignalDate ?? signalDate,
    ),
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
    precision: {
      quantityIncrementMicros: '1',
      priceIncrementMicros: '100',
      minimumBuyNotionalMicros: '1000000',
    },
    maximumInputAgeMs: options.maximumInputAgeMs ?? 120_000,
    submissionCutoffAt: options.submissionCutoffAt ?? submissionCutoffAt,
    observedAt: options.observedAt ?? observedAt,
  }
}

describe('causal target planner', () => {
  test('produces exact target deltas in stable sell-then-buy order without crediting the sell', () => {
    const result = planTargets(fixture())

    expect(result.status).toBe(TargetPlanStatus.Planned)
    expect(result.reason).toBeNull()
    expect(result.targets).toEqual([
      {
        symbol: 'AMD',
        targetWeight: 0.5,
        referencePriceMicros: '50000000',
        currentQuantityMicros: '80000000',
        targetQuantityMicros: '100000000',
      },
      {
        symbol: 'NVDA',
        targetWeight: 0.5,
        referencePriceMicros: '100000000',
        currentQuantityMicros: '60000000',
        targetQuantityMicros: '50000000',
      },
    ])
    expect(result.intentTargets.map(({ symbol, side, quantityMicros }) => ({ symbol, side, quantityMicros }))).toEqual([
      {
        symbol: 'NVDA',
        side: OrderSide.Sell,
        quantityMicros: '10000000',
      },
      {
        symbol: 'AMD',
        side: OrderSide.Buy,
        quantityMicros: '20000000',
      },
    ])
    expect(result.requiredReferenceBuyNotionalMicros).toBe('1000000000')
    expect(result.residualBuyingPowerMicros).toBe('500000000')
    expect(
      result.intentTargets.every((intent) => !('schemaVersion' in intent) && !('notionalLimitMicros' in intent)),
    ).toBe(true)
  })

  test('replays byte-for-byte with golden hashes and binds decision drift', () => {
    const first = planTargets(fixture())
    const replay = planTargets(fixture())
    const reordered = planTargets(
      fixture({
        priceMicros: { NVDA: '100000000', AMD: '50000000' },
        targetWeights: { NVDA: 0.5, AMD: 0.5 },
      }),
    )
    const changedDecision = planTargets(fixture({ decisionHash: hash('4') }))

    expect(replay).toEqual(first)
    expect(reordered).toEqual(first)
    expect(first.inputHash).toBe('aad6c6e6e3e1c6a0162d07b2f804639cc0a117d5ac3fdc0bc7658dea593e9a4b')
    expect(first.outputHash).toBe('0e226d5942df14c30bc03d13e560ef481ff6d463021982c82dbd1a933d2aed8e')
    expect(changedDecision.inputHash).not.toBe(first.inputHash)
    expect(changedDecision.outputHash).not.toBe(first.outputHash)
    expect(changedDecision.intentTargets.every((intent) => intent.decisionHash === hash('4'))).toBe(true)
  })

  test('is independent of next-session gaps and every future OHLC field', () => {
    const futureSessions = [
      { open: '900000000', high: '999000000', low: '1', close: '777000000' },
      { open: '1', high: '2', low: '1', close: '3' },
    ]
    const plans = futureSessions.map(() => planTargets(fixture()))

    expect(futureSessions[0]).not.toEqual(futureSessions[1])
    expect(plans[1]).toEqual(plans[0])
  })

  test('returns no-trade when the rounded targets already match the all-cash account', () => {
    const result = planTargets(
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
    const liquidation = planTargets(
      fixture({
        buyingPowerMicros: '-1000000',
        positions: [position('AMD', '1000000'), position('NVDA', '2000000')],
        targetWeights: { AMD: 0, NVDA: 0 },
      }),
    )
    const short = planTargets(
      fixture({
        positions: [position('AMD', '-1'), position('NVDA', '2000000')],
      }),
    )

    expect(liquidation.intentTargets.map((intent) => [intent.symbol, intent.side, intent.quantityMicros])).toEqual([
      ['AMD', OrderSide.Sell, '1000000'],
      ['NVDA', OrderSide.Sell, '2000000'],
    ])
    expect(liquidation.status).toBe(TargetPlanStatus.Planned)
    expect(short).toMatchObject({
      status: TargetPlanStatus.Blocked,
      reason: TargetPlanReason.ShortPositionNotAllowed,
      intentTargets: [],
    })
  })

  test('reserves aggregate buys against current buying power without unfilled sell proceeds', () => {
    const aggregate = planTargets(
      fixture({
        buyingPowerMicros: '6000000000',
        positions: [],
      }),
    )
    const sellDoesNotFund = planTargets(
      fixture({
        buyingPowerMicros: '1500000000',
        positions: [position('AMD', '0'), position('NVDA', '100000000')],
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
    const before = planTargets(fixture({ observedAt: '2026-07-23T13:29:59.999Z' }))
    const exact = planTargets(fixture({ observedAt: submissionCutoffAt }))
    const after = planTargets(fixture({ observedAt: '2026-07-23T13:30:00.001Z' }))

    expect(before.status).toBe(TargetPlanStatus.Planned)
    expect(exact.reason).toBe(TargetPlanReason.SubmissionCutoffReached)
    expect(after.reason).toBe(TargetPlanReason.SubmissionCutoffReached)
  })

  test('blocks input at the exact freshness boundary and observations from the future', () => {
    const stale = planTargets(
      fixture({
        accountObservedAt: '2026-07-23T13:27:00.000Z',
        maximumInputAgeMs: 120_000,
      }),
    )
    const future = fixture({ pricesObservedAt: '2026-07-23T13:29:00.001Z' })

    expect(stale.reason).toBe(TargetPlanReason.InputStale)
    expect(planTargets(future).reason).toBe(TargetPlanReason.InputMismatch)
  })

  test('rejects a reference vector labeled as a signal session that has not happened', () => {
    const input = fixture()
    const material = {
      schemaVersion: input.referencePrices.schemaVersion,
      signalDate: '2026-07-24' as const,
      observedAt: input.referencePrices.observedAt,
      priceMicros: input.referencePrices.priceMicros,
    }
    const futureSignal = {
      ...input,
      signalDate: material.signalDate,
      referencePrices: { ...material, contentHash: canonicalHashV1(material) },
    }

    expect(planTargets(futureSignal).reason).toBe(TargetPlanReason.IdentityMismatch)
  })

  test('blocks identity, reference-vector, and reconciliation mismatches', () => {
    const identity = planTargets(fixture({ referenceSignalDate: '2026-07-21' }))
    const referenceInput = fixture()
    const reconciliationInput = fixture()
    const leveraged = planTargets(fixture({ targetWeights: { AMD: 0.75, NVDA: 0.75 } }))
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
    expect(planTargets(badReference).reason).toBe(TargetPlanReason.InputMismatch)
    expect(planTargets(badReconciliation).reason).toBe(TargetPlanReason.ReconciliationNotExact)
  })

  test('blocks unknown and unresolved orders but accepts terminal order history', () => {
    const unknown = planTargets(fixture({ unknownOrderCount: 1 }))
    const unresolvedOrder = order(OrderStatus.New)
    const unresolved = planTargets(fixture({ orders: [unresolvedOrder] }))
    const terminalOrder = order(OrderStatus.Filled)
    const terminal = planTargets(fixture({ orders: [terminalOrder] }))

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
      precision: { ...preciseInput.precision, quantityIncrementMicros: '1000000' },
    }
    const rounded = planTargets(precise)

    const dust = fixture({
      buyingPowerMicros: '10000000000',
      equityMicros: '1000000',
      positions: [],
      priceMicros: { AMD: '100000000' },
      targetWeights: { AMD: 0.1 },
    })

    expect(rounded.targets[0]?.targetQuantityMicros).toBe('333000000')
    expect(rounded.intentTargets[0]?.quantityMicros).toBe('333000000')
    expect(planTargets(dust).reason).toBe(TargetPlanReason.BelowMinimumBuyNotional)
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
    const reconciliationId = canonicalHashV1({
      schemaVersion: 'bayn.paper-reconciliation-id.v1',
      material,
    })
    const discrepantInput = {
      ...input,
      brokerState: {
        ...input.brokerState,
        reconciliation: {
          ...material,
          reconciliationId,
          contentHash: canonicalHashV1({ ...material, reconciliationId }),
        },
      },
    }

    expect(planTargets(discrepantInput).reason).toBe(TargetPlanReason.ReconciliationNotExact)
  })
})
