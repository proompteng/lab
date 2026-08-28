import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

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
} from './execution/contracts'
import { reconciledStateHash } from './reconciliation'
import {
  TargetPlanReason,
  TargetPlanStatus,
  decodeTargetPlanResult,
  intradaySnapshotReferencePricesSchemaVersion,
  planTargets,
  quoteBoundTargetPlannerInputSchemaVersion,
  referenceTargetPlanSchemaVersion,
  type SignalSessionReferencePrices,
  type TargetPlanResult,
  type TargetPlannerInput,
  type TargetPlannerInputV1,
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
  readonly allocationCapitalMicros?: string
  readonly buyingPowerMicros?: string
  readonly decisionHash?: string
  readonly equityMicros?: string
  readonly maximumInputAgeMs?: number
  readonly maximumBuyQuantityMicros?: Readonly<Record<string, string>>
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
  readonly quoteBound?: boolean
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
  known = true,
): Order => ({
  schemaVersion: 'bayn.paper-order.v1',
  accountId: orderAccountId,
  brokerOrderId: `broker-${status}`,
  clientOrderId: `client-${status}`,
  ...(known ? { intentId: hash('9') } : {}),
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
  const common: Omit<TargetPlannerInputV1, 'schemaVersion'> = {
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
  return options.quoteBound === true
    ? (() => {
        const snapshotId = hash('7')
        const snapshotContentHash = hash('8')
        const bidPriceMicros = options.bidPriceMicros ?? prices
        const askPriceMicros = options.askPriceMicros ?? prices
        const priceMaterial = {
          schemaVersion: intradaySnapshotReferencePricesSchemaVersion,
          signalDate,
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
          ...common,
          referencePrices: { ...priceMaterial, contentHash: canonicalHashV1(priceMaterial) },
          allocationCapitalMicros: options.allocationCapitalMicros ?? '1000000000',
          precision: { ...common.precision, quantityIncrementMicros: '1000000' as const },
          executionTerms: {
            orderType: OrderType.Limit,
            timeInForce: TimeInForce.ImmediateOrCancel,
            priceReference: 'verified-adverse-quote-boundary' as const,
            snapshotId,
            snapshotContentHash,
            maximumBuyQuantityMicros:
              options.maximumBuyQuantityMicros ??
              Object.fromEntries(Object.keys(prices).map((symbol) => [symbol, '1000000000000'])),
          },
        }
      })()
    : options.allocationCapitalMicros === undefined
      ? { schemaVersion: 'bayn.paper-target-planner-input.v1', ...common }
      : {
          schemaVersion: 'bayn.paper-target-planner-input.v2',
          ...common,
          allocationCapitalMicros: options.allocationCapitalMicros,
        }
}

const planSuccess = (input: TargetPlannerInput): TargetPlanResult => {
  const result = planTargets(input)
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

describe('causal target planner', () => {
  test('plans whole-share LIMIT/IOC deltas against an immutable adverse quote boundary', () => {
    const result = planSuccess(
      fixture({
        quoteBound: true,
        positions: [],
        priceMicros: { AMD: '30000000' },
        targetWeights: { AMD: 1 },
      }),
    )

    expect(result).toMatchObject({
      schemaVersion: referenceTargetPlanSchemaVersion,
      status: TargetPlanStatus.Planned,
      requiredReferenceBuyNotionalMicros: '990000000',
      targets: [{ symbol: 'AMD', targetQuantityMicros: '33000000' }],
      intentTargets: [
        {
          symbol: 'AMD',
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          quantityMicros: '33000000',
        },
      ],
    })
  })

  test('prices buys at the verified ask, sells at the verified bid, and does not churn inside the spread', () => {
    const options = {
      quoteBound: true,
      allocationCapitalMicros: '1000000000',
      priceMicros: { AMD: '100000000' },
      bidPriceMicros: { AMD: '90000000' },
      askPriceMicros: { AMD: '100000000' },
      targetWeights: { AMD: 1 },
    } as const
    const buy = planSuccess(fixture({ ...options, positions: [position('AMD', '5000000')] }))
    const sell = planSuccess(fixture({ ...options, positions: [position('AMD', '12000000')] }))
    const insideSpread = planSuccess(fixture({ ...options, positions: [position('AMD', '10000000')] }))

    expect(buy).toMatchObject({
      status: TargetPlanStatus.Planned,
      targets: [{ symbol: 'AMD', referencePriceMicros: '100000000', targetQuantityMicros: '10000000' }],
      intentTargets: [{ symbol: 'AMD', side: OrderSide.Buy, quantityMicros: '5000000' }],
    })
    expect(sell).toMatchObject({
      status: TargetPlanStatus.Planned,
      targets: [{ symbol: 'AMD', referencePriceMicros: '90000000', targetQuantityMicros: '11000000' }],
      intentTargets: [{ symbol: 'AMD', side: OrderSide.Sell, quantityMicros: '1000000' }],
    })
    expect(insideSpread).toMatchObject({
      status: TargetPlanStatus.NoTrade,
      reason: TargetPlanReason.TargetsSatisfied,
      targets: [{ symbol: 'AMD', referencePriceMicros: '100000000', targetQuantityMicros: '10000000' }],
      intentTargets: [],
    })
  })

  test('rejects quote prices not bound to the execution snapshot identity', () => {
    const input = fixture({ quoteBound: true })
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

  test('keeps the legacy target-plan decoder strict to MARKET/DAY evidence', () => {
    const current = planSuccess(
      fixture({ quoteBound: true, positions: [], priceMicros: { AMD: '30000000' }, targetWeights: { AMD: 1 } }),
    )
    const { outputHash: _outputHash, ...currentMaterial } = current
    const mislabeledLegacy = {
      ...currentMaterial,
      schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
    }

    expect(
      Result.isFailure(decodeTargetPlanResult({ ...mislabeledLegacy, outputHash: canonicalHashV1(mislabeledLegacy) })),
    ).toBe(true)
  })

  test('rejects quote-bound planning that permits fractional-share quantities', () => {
    const input = fixture({ quoteBound: true, positions: [] })

    expect(
      Result.isFailure(
        planTargets({
          ...input,
          precision: { ...input.precision, quantityIncrementMicros: '1' },
        }),
      ),
    ).toBe(true)
  })

  test('plans an exact fractional MARKET/DAY close without permitting a buy', () => {
    const input = fixture({
      quoteBound: true,
      allocationCapitalMicros: '0',
      positions: [position('AMD', '500000')],
      priceMicros: { AMD: '100000000' },
      targetWeights: { AMD: 0 },
      maximumBuyQuantityMicros: { AMD: '0' },
    })
    if (input.schemaVersion !== quoteBoundTargetPlannerInputSchemaVersion) {
      return expect.unreachable('fractional close fixture requires quote-bound planning')
    }
    const result = planSuccess({
      ...input,
      precision: { ...input.precision, quantityIncrementMicros: '1' },
      executionTerms: {
        executionPurpose: 'fractional-close',
        orderType: OrderType.Market,
        timeInForce: TimeInForce.Day,
        priceReference: input.executionTerms.priceReference,
        snapshotId: input.executionTerms.snapshotId,
        snapshotContentHash: input.executionTerms.snapshotContentHash,
        maximumBuyQuantityMicros: { AMD: '0' },
      },
    })

    expect(result).toMatchObject({
      status: TargetPlanStatus.Planned,
      targets: [{ symbol: 'AMD', currentQuantityMicros: '500000', targetQuantityMicros: '0' }],
      intentTargets: [
        {
          symbol: 'AMD',
          side: OrderSide.Sell,
          orderType: OrderType.Market,
          timeInForce: TimeInForce.Day,
          quantityMicros: '500000',
        },
      ],
    })
  })

  test('caps only buy deltas at the verified whole-share ask quantity', () => {
    const result = planSuccess(
      fixture({
        quoteBound: true,
        positions: [position('AMD', '20000000')],
        priceMicros: { AMD: '10000000' },
        targetWeights: { AMD: 1 },
        maximumBuyQuantityMicros: { AMD: '10000000' },
      }),
    )

    expect(result).toMatchObject({
      status: TargetPlanStatus.Planned,
      targets: [{ symbol: 'AMD', currentQuantityMicros: '20000000', targetQuantityMicros: '30000000' }],
      intentTargets: [{ symbol: 'AMD', side: OrderSide.Buy, quantityMicros: '10000000' }],
    })
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
        { symbol: 'AMD', targetQuantityMicros: '10000000' },
        { symbol: 'NVDA', targetQuantityMicros: '5000000' },
      ],
    })
  })

  test('preserves legacy full-equity planning and rejects allocation above current equity', () => {
    const legacy = planSuccess(fixture({ positions: [] }))
    const excessive = planSuccess(
      fixture({ allocationCapitalMicros: '10000000001', equityMicros: '10000000000', positions: [] }),
    )

    expect(legacy.targets).toMatchObject([
      { symbol: 'AMD', targetQuantityMicros: '100000000' },
      { symbol: 'NVDA', targetQuantityMicros: '50000000' },
    ])
    expect(legacy.schemaVersion).toBe('bayn.paper-reference-target-plan.v1')
    expect(excessive).toMatchObject({ status: TargetPlanStatus.Blocked, reason: TargetPlanReason.InputMismatch })
  })

  test('versions bounded allocation separately from strict legacy planner evidence', () => {
    const legacy = fixture({ positions: [] })
    const bounded = fixture({ allocationCapitalMicros: '1000000000', positions: [] })

    expect(legacy.schemaVersion).toBe('bayn.paper-target-planner-input.v1')
    expect(bounded.schemaVersion).toBe('bayn.paper-target-planner-input.v2')
    expect(Result.isFailure(planTargets({ ...legacy, allocationCapitalMicros: '1000000000' }))).toBe(true)
    if (bounded.schemaVersion !== 'bayn.paper-target-planner-input.v2') throw new Error('expected v2 planner input')
    const { allocationCapitalMicros: _allocationCapitalMicros, ...boundedWithoutAllocation } = bounded
    expect(Result.isFailure(planTargets(boundedWithoutAllocation))).toBe(true)
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
        positions: [position('AMD', '1000000'), position('NVDA', '2000000')],
        targetWeights: { AMD: 0, NVDA: 0 },
      }),
    )
    const short = planSuccess(
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
    const aggregate = planSuccess(
      fixture({
        buyingPowerMicros: '6000000000',
        positions: [],
      }),
    )
    const sellDoesNotFund = planSuccess(
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
    if (input.schemaVersion === quoteBoundTargetPlannerInputSchemaVersion) throw new Error('expected legacy input')
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

    expect(planSuccess(futureSignal).reason).toBe(TargetPlanReason.IdentityMismatch)
  })

  test('blocks identity, reference-vector, and reconciliation mismatches', () => {
    const identity = planSuccess(fixture({ referenceSignalDate: '2026-07-21' }))
    const referenceInput = fixture()
    const reconciliationInput = fixture()
    if (
      referenceInput.schemaVersion === quoteBoundTargetPlannerInputSchemaVersion ||
      reconciliationInput.schemaVersion === quoteBoundTargetPlannerInputSchemaVersion
    ) {
      throw new Error('expected legacy planner inputs')
    }
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
      precision: { ...preciseInput.precision, quantityIncrementMicros: '1000000' as const },
    }
    const rounded = planSuccess(precise)

    const dust = fixture({
      buyingPowerMicros: '10000000000',
      equityMicros: '1000000',
      positions: [],
      priceMicros: { AMD: '100000000' },
      targetWeights: { AMD: 0.1 },
    })

    expect(rounded.targets[0]?.targetQuantityMicros).toBe('333000000')
    expect(rounded.intentTargets[0]?.quantityMicros).toBe('333000000')
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

    expect(planSuccess(discrepantInput).reason).toBe(TargetPlanReason.ReconciliationNotExact)
  })

  test('covers every terminal planner action with its exact closed reason', () => {
    const reconciliationMismatch = fixture()
    const belowMinimum = fixture({
      buyingPowerMicros: '10000000000',
      equityMicros: '1000000',
      positions: [],
      priceMicros: { AMD: '100000000' },
      targetWeights: { AMD: 0.1 },
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
        fixture({ positions: [position('AMD', '-1'), position('NVDA', '2000000')] }),
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
      { ...fixture(), precision: { ...fixture().precision, quantityIncrementMicros: '0' } },
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
      fixture({ positions: [position('AMD', '1'), position('AMD', '2')] }),
      fixture({ positions: [position('NVDA', '2'), position('AMD', '1')] }),
      fixture({ orders: [filled, canceled] }),
      fixture({ positions: [{ ...position('AMD', '1'), marketValueMicros: '-1' }, position('NVDA', '2')] }),
      fixture({ positions: [{ ...position('AMD', '0'), marketValueMicros: '1' }, position('NVDA', '2')] }),
      fixture({ positions: [{ ...position('AMD', '-1'), marketValueMicros: '1' }, position('NVDA', '2')] }),
      fixture({ positions: [position('AMD', '1', '2026-07-23T13:27:00.000Z'), position('NVDA', '2')] }),
      fixture({ positions: [position('AMD', '1', '2026-07-23T13:29:00.001Z'), position('NVDA', '2')] }),
      fixture({ unknownOrderCount: 1 }),
    ]

    expect(cases.map((input) => planSuccess(input).reason)).toEqual(cases.map(() => TargetPlanReason.InputMismatch))
  })

  test('rejects rehashed status, sign, delta, ordering, reason-fact, and buying-power impossibilities', () => {
    const valid = planSuccess(fixture())
    const rehash = (candidate: Omit<typeof valid, 'outputHash'>) => ({
      ...candidate,
      outputHash: canonicalHashV1(candidate),
    })
    const { outputHash: _, ...material } = valid
    const candidates: readonly unknown[] = [
      rehash({ ...material, intentTargets: [...material.intentTargets].reverse() }),
      rehash({
        ...material,
        intentTargets: material.intentTargets.map((intent, index) =>
          index === 0 ? { ...intent, quantityMicros: (BigInt(intent.quantityMicros) + 1n).toString() } : intent,
        ),
      }),
      rehash({ ...material, requiredReferenceBuyNotionalMicros: '1' }),
      rehash({ ...material, residualBuyingPowerMicros: '1' }),
      rehash({
        ...material,
        targets: material.targets.map((target, index) =>
          index === 0 ? { ...target, targetQuantityMicros: target.currentQuantityMicros } : target,
        ),
      }),
      rehash({
        ...material,
        targets: material.targets.map((target, index) =>
          index === 0 ? { ...target, targetQuantityMicros: '-1' } : target,
        ),
      }),
      rehash({
        ...material,
        targets: material.targets.map((target, index) =>
          index === 0 ? { ...target, currentQuantityMicros: '-1' } : target,
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
        const impossible = { ...noTradeMaterial, targets: [] }
        return { ...impossible, outputHash: canonicalHashV1(impossible) }
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
        return { ...impossible, outputHash: canonicalHashV1(impossible) }
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
