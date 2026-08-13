import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1 } from '../hash'
import { makeForwardPerformanceReceipt } from './domain'
import type {
  ForwardPerformanceEvidenceInput,
  ForwardPerformanceExecutionEvidence,
  ForwardPerformanceMarketVolumeEvidence,
  ForwardPerformanceReceipt,
} from './model'

const hash = (character: string): string => character.repeat(64)

const cycle = (name: string, overrides: Partial<ForwardPerformanceEvidenceInput['cycles'][number]> = {}) => ({
  cycleId: hash(name),
  qualificationRunId: hash('1'),
  strategyName: 'risk-balanced-trend',
  strategyProtocolHash: hash('2'),
  accountId: 'paper-account-1',
  executionPolicyHash: hash('3'),
  strategyExecutionModelHash: hash('4'),
  state: 'COMPLETED' as const,
  submissionOpenAt: '2026-07-20T13:00:00.000Z',
  terminalAt: '2026-07-20T21:00:00.000Z',
  ...overrides,
})

const transaction = (
  name: string,
  realizedPnlMicros: string,
  feeMicros: string,
  overrides: Partial<ForwardPerformanceEvidenceInput['transactions'][number]> = {},
) => ({
  transactionId: hash(name),
  brokerEventId: hash('b'),
  intentId: hash('c'),
  cycleId: hash('a'),
  symbol: 'NVDA',
  side: 'SELL' as const,
  quantityMicros: '1000000',
  priceMicros: '109000000',
  notionalMicros: '109000000',
  feeMicros,
  realizedPnlMicros,
  occurredAt: '2026-07-20T20:00:00.000Z',
  ...overrides,
})

const cashYieldBinding = (amountMicros = '200') => ({
  source: 'TIGERBEETLE_CASH_YIELD_TRANSFER' as const,
  transferId: '123456789',
  transferTimestampNs: '1784563200000000000',
  amountMicros,
})

const input = (overrides: Partial<ForwardPerformanceEvidenceInput> = {}): ForwardPerformanceEvidenceInput => ({
  runtime: {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.example.test/lab/bayn',
    imageDigest: `sha256:${hash('b')}`,
  },
  account: {
    accountId: 'paper-account-1',
    accountReferenceHash: hash('5'),
    provider: 'alpaca',
    environment: 'sandbox',
  },
  durableExecutionBindings: [
    {
      accountId: 'paper-account-1',
      accountReferenceHash: hash('5'),
      provider: 'alpaca',
      environment: 'sandbox',
      qualificationRunId: hash('1'),
      strategyName: 'risk-balanced-trend',
      strategyProtocolHash: hash('2'),
      strategyBehaviorHash: hash('6'),
      strategyParameterHash: hash('7'),
      strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
      executionPolicyHash: hash('3'),
      sourceRevision: 'c'.repeat(40),
      imageRepository: 'registry.example.test/lab/bayn',
      imageDigest: `sha256:${hash('d')}`,
    },
  ],
  cycles: [cycle('a')],
  strategy: {
    qualificationRunId: hash('1'),
    strategyName: 'risk-balanced-trend',
    strategyProtocolHash: hash('2'),
    strategyBehaviorHash: hash('6'),
    strategyParameterHash: hash('7'),
    strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
    sourceRevision: 'c'.repeat(40),
    imageRepository: 'registry.example.test/lab/bayn',
    imageDigest: `sha256:${hash('d')}`,
  },
  reconciliation: {
    reconciliationId: hash('8'),
    contentHash: hash('9'),
    status: 'EXACT',
    performanceExact: true,
    cashYieldAdjustedExact: false,
    reconciledAt: '2026-07-20T21:01:00.000Z',
  },
  startingCapitalMicros: '1000',
  transactions: [transaction('e', '100', '20')],
  ledgerTotals: {
    realizedGainMicros: '100',
    realizedLossMicros: '0',
    brokerExecutionFeesMicros: '20',
    otherChargedCostsMicros: '0',
    cashYieldMicros: '0',
  },
  accountingReceiptsExact: true,
  ledgerExact: true,
  missingLedgerAccountCount: 0,
  unresolvedMutationCount: 0,
  unclosedCycleCount: 0,
  openPositionCount: 0,
  ...overrides,
  cashYieldEvidenceRequired: overrides.cashYieldEvidenceRequired ?? false,
})

const exactExecutionEvidence = (reverse = false) => {
  const fills = [
    {
      brokerEventId: hash('b'),
      fillId: 'fill-1',
      brokerOrderId: 'broker-order-1',
      clientOrderId: 'client-order-1',
      intentId: hash('c'),
      accountId: 'paper-account-1',
      symbol: 'NVDA',
      side: 'SELL' as const,
      quantityMicros: '400000',
      priceMicros: '109000000',
      feeMicros: '10',
      sourceTimestamp: '2026-07-20T20:00:00.000000000Z',
      occurredAt: '2026-07-20T20:00:00.000Z',
      observedAt: '2026-07-20T20:00:00.100Z',
    },
    {
      brokerEventId: hash('d'),
      fillId: 'fill-2',
      brokerOrderId: 'broker-order-1',
      clientOrderId: 'client-order-1',
      intentId: hash('c'),
      accountId: 'paper-account-1',
      symbol: 'NVDA',
      side: 'SELL' as const,
      quantityMicros: '600000',
      priceMicros: '108000000',
      feeMicros: '10',
      sourceTimestamp: '2026-07-20T20:00:01.000000000Z',
      occurredAt: '2026-07-20T20:00:01.000Z',
      observedAt: '2026-07-20T20:00:01.100Z',
    },
  ]
  return [
    {
      cycleId: hash('a'),
      decisionDocumentHash: hash('8'),
      decisionHash: hash('e'),
      decisionCreatedAt: '2026-07-20T13:00:00.000Z',
      intentId: hash('c'),
      accountId: 'paper-account-1',
      symbol: 'NVDA',
      side: 'SELL' as const,
      plannedQuantityMicros: '1000000',
      referencePriceMicros: '110000000',
      intent: {
        intentId: hash('c'),
        accountId: 'paper-account-1',
        clientOrderId: 'client-order-1',
        cycleId: hash('a'),
        decisionHash: hash('e'),
        symbol: 'NVDA',
        side: 'SELL' as const,
        quantityMicros: '1000000',
        terminalOutcome: 'FILLED' as const,
        createdAt: '2026-07-20T13:00:00.000Z',
        updatedAt: '2026-07-20T20:00:02.000Z',
      },
      terminalOrder: {
        eventId: hash('f'),
        brokerOrderId: 'broker-order-1',
        clientOrderId: 'client-order-1',
        intentId: hash('c'),
        accountId: 'paper-account-1',
        symbol: 'NVDA',
        side: 'SELL' as const,
        quantityMicros: '1000000',
        filledQuantityMicros: '1000000',
        status: 'FILLED' as const,
        occurredAt: '2026-07-20T20:00:02.000Z',
        observedAt: '2026-07-20T20:00:02.100Z',
      },
      fills: reverse ? fills.toReversed() : fills,
    },
  ]
}

const exactMarketVolumeEvidence = (): readonly ForwardPerformanceMarketVolumeEvidence[] => {
  const material: Omit<ForwardPerformanceMarketVolumeEvidence, 'contentHash'> = {
    schemaVersion: 'bayn.forward-performance-market-volume-evidence.v1' as const,
    cycleId: hash('a'),
    decisionSnapshotId: hash('5'),
    decisionSnapshotAsOfSession: '2026-07-19',
    symbol: 'NVDA',
    executionSessionDate: '2026-07-20',
    windowOpenedAt: '2026-07-20T13:30:00.000Z',
    windowClosedAt: '2026-07-20T21:00:00.000Z',
    evidenceCutoffAt: '2026-07-20T21:10:00.000Z',
    quantityMicros: '100000000',
    closePriceMicros: '103000000',
    snapshotId: hash('1'),
    manifestContentHash: hash('2'),
    barsContentHash: hash('3'),
    finalizedAt: '2026-07-20T21:05:00.000Z',
    universeId: 'cross-asset-taa-v1' as const,
    universeSymbolHash: hash('4'),
    requestedStart: '2018-01-02',
    evaluationStart: '2019-01-02',
    calendarVersion: 'fixture-calendar-v1',
    source: 'alpaca' as const,
    sourceFeed: 'sip' as const,
    adjustment: 'all' as const,
  }
  return [{ ...material, contentHash: canonicalHashV1(material) }]
}

const terminalReferencePriceFor = (
  volume: ForwardPerformanceMarketVolumeEvidence,
): NonNullable<ForwardPerformanceExecutionEvidence['terminalReferencePrice']> => {
  const material = {
    schemaVersion: 'bayn.forward-performance-terminal-reference-price.v1' as const,
    cycleId: volume.cycleId,
    symbol: volume.symbol,
    executionSessionDate: volume.executionSessionDate,
    priceMicros: volume.closePriceMicros,
    observedAt: volume.finalizedAt,
    sourceEvidenceHash: volume.contentHash,
  }
  return { ...material, contentHash: canonicalHashV1(material) }
}

const exactTransactions = () => [
  transaction('1', '40', '10', {
    brokerEventId: hash('b'),
    quantityMicros: '400000',
    priceMicros: '109000000',
    notionalMicros: '43600000',
    occurredAt: '2026-07-20T20:00:00.000Z',
  }),
  transaction('2', '60', '10', {
    brokerEventId: hash('d'),
    quantityMicros: '600000',
    priceMicros: '108000000',
    notionalMicros: '64800000',
    occurredAt: '2026-07-20T20:00:01.000Z',
  }),
]

const success = (value: Result.Result<ForwardPerformanceReceipt, unknown>): ForwardPerformanceReceipt => {
  assert(Result.isSuccess(value), 'forward-performance fixture must produce a receipt')
  return value.success
}

describe('forward performance domain', () => {
  test('reports positive net realized returns after charged costs', () => {
    const receipt = success(makeForwardPerformanceReceipt(input()))

    expect(receipt.evidence).toEqual({ status: 'SUFFICIENT', reasonCodes: [], cashYield: null })
    expect(receipt.profitability).toBe('PROFITABLE')
    expect(receipt.totals).toMatchObject({
      grossRealizedPnlMicros: '100',
      netRealizedPnlAfterCostsMicros: '80',
      netRealizedReturn: {
        numeratorMicros: '80',
        denominatorMicros: '1000',
        decimal: '0.080000000000',
      },
    })
  })

  test('keeps profitability independent while execution quality and capacity lack immutable source evidence', () => {
    const receipt = success(makeForwardPerformanceReceipt(input()))

    expect(receipt.profitability).toBe('PROFITABLE')
    expect(receipt.executionQuality).toEqual({
      status: 'UNDETERMINED',
      reasonCodes: ['PLANNED_DECISION_EVIDENCE_GAP'],
      evidenceHash: null,
      implementationShortfall: null,
    })
    expect(receipt.observedCapacity).toEqual({
      status: 'UNDETERMINED',
      reasonCodes: ['EXECUTION_QUALITY_UNDETERMINED', 'MARKET_VOLUME_EVIDENCE_GAP'],
      evidenceHash: null,
      observations: [],
      boundedObservedReferenceNotionalMicros: null,
      boundedObservedExecutedNotionalMicros: null,
      maximumParticipationRate: null,
    })
  })

  test('measures Perold implementation shortfall and bounded observed participation from exact immutable evidence', () => {
    const transactions = exactTransactions()
    const evidence = {
      transactions,
      executionEvidence: exactExecutionEvidence(),
      marketVolumeEvidence: exactMarketVolumeEvidence(),
    }
    const first = success(makeForwardPerformanceReceipt(input(evidence)))
    const second = success(
      makeForwardPerformanceReceipt(
        input({
          ...evidence,
          transactions: transactions.toReversed(),
          executionEvidence: exactExecutionEvidence(true),
        }),
      ),
    )

    expect(first).toEqual(second)
    expect(first.profitability).toBe('PROFITABLE')
    expect(first.executionQuality).toMatchObject({
      status: 'MEASURED',
      reasonCodes: [],
      implementationShortfall: {
        plannedOrderCount: 1,
        fillCount: 2,
        plannedQuantityMicros: '1000000',
        filledQuantityMicros: '1000000',
        unfilledQuantityMicros: '0',
        plannedReferenceNotionalMicros: '110000000',
        executedNotionalMicros: '108400000',
        executionPriceShortfallMicros: '1600000',
        opportunityShortfallMicros: '0',
        explicitCostsMicros: '20',
        totalImplementationShortfallMicros: '1600020',
        implementationShortfallRate: {
          numeratorMicros: '1600020',
          denominatorMicros: '110000000',
          decimal: '0.014545636364',
        },
        firstDecisionAt: '2026-07-20T13:00:00.000Z',
        firstFillAt: '2026-07-20T20:00:00.000Z',
        lastFillAt: '2026-07-20T20:00:01.000Z',
        lastTerminalOrderObservedAt: '2026-07-20T20:00:02.100Z',
      },
    })
    expect(first.executionQuality.evidenceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(first.observedCapacity).toMatchObject({
      status: 'MEASURED',
      reasonCodes: [],
      boundedObservedReferenceNotionalMicros: '110000000',
      boundedObservedExecutedNotionalMicros: '108400000',
      maximumParticipationRate: {
        numeratorQuantityMicros: '1000000',
        denominatorQuantityMicros: '100000000',
        decimal: '0.010000000000',
      },
      observations: [
        {
          cycleId: hash('a'),
          symbol: 'NVDA',
          windowOpenedAt: '2026-07-20T13:30:00.000Z',
          windowClosedAt: '2026-07-20T21:00:00.000Z',
          filledQuantityMicros: '1000000',
          marketVolumeQuantityMicros: '100000000',
          participationRate: {
            numeratorQuantityMicros: '1000000',
            denominatorQuantityMicros: '100000000',
            decimal: '0.010000000000',
          },
        },
      ],
    })
    expect(first.observedCapacity.evidenceHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('measures a notional BUY from actual broker fills when price improvement yields more shares than planned', () => {
    const [baseExecution] = exactExecutionEvidence()
    const [firstFill, secondFill] = baseExecution?.fills ?? []
    if (baseExecution === undefined || firstFill === undefined || secondFill === undefined) {
      throw new Error('execution fixture missing')
    }
    const terminalOrder = baseExecution.terminalOrder
    const baseIntent = baseExecution.intent
    if (terminalOrder === undefined || baseIntent === undefined) throw new Error('execution identity fixture missing')
    const { quantityMicros: _quantityMicros, ...notionalOrder } = terminalOrder
    const executionEvidence: ForwardPerformanceExecutionEvidence = {
      ...baseExecution,
      side: 'BUY',
      intent: {
        ...baseIntent,
        side: 'BUY',
        notionalLimitMicros: '110000001',
      },
      terminalOrder: {
        ...notionalOrder,
        side: 'BUY',
        notionalMicros: '110000000',
        filledQuantityMicros: '1100000',
      },
      fills: [
        {
          ...firstFill,
          side: 'BUY',
          quantityMicros: '500000',
          priceMicros: '100000000',
        },
        {
          ...secondFill,
          side: 'BUY',
          quantityMicros: '600000',
          priceMicros: '99000000',
        },
      ],
    }
    const transactions = [
      transaction('1', '0', '10', {
        brokerEventId: hash('b'),
        side: 'BUY',
        quantityMicros: '500000',
        priceMicros: '100000000',
        notionalMicros: '50000000',
        occurredAt: '2026-07-20T20:00:00.000Z',
      }),
      transaction('2', '0', '10', {
        brokerEventId: hash('d'),
        side: 'BUY',
        quantityMicros: '600000',
        priceMicros: '99000000',
        notionalMicros: '59400000',
        occurredAt: '2026-07-20T20:00:01.000Z',
      }),
    ]

    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions,
          executionEvidence: [executionEvidence],
          marketVolumeEvidence: exactMarketVolumeEvidence(),
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '20',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.executionQuality).toMatchObject({
      status: 'MEASURED',
      reasonCodes: [],
      implementationShortfall: {
        plannedQuantityMicros: '1000000',
        filledQuantityMicros: '1100000',
        unfilledQuantityMicros: '0',
        executedNotionalMicros: '109400000',
      },
    })
  })

  test('orders terminal fills by broker occurrence even when fill observation completes after order observation', () => {
    const [execution] = exactExecutionEvidence()
    if (execution === undefined) throw new Error('execution fixture missing')
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: exactTransactions(),
          executionEvidence: [
            {
              ...execution,
              fills: execution.fills.map((fill, index) => ({
                ...fill,
                observedAt: `2026-07-20T20:00:0${index + 3}.100Z`,
              })),
            },
          ],
          marketVolumeEvidence: exactMarketVolumeEvidence(),
        }),
      ),
    )

    expect(receipt.executionQuality.status).toBe('MEASURED')
    expect(receipt.executionQuality.reasonCodes).toEqual([])
    expect(receipt.observedCapacity.status).toBe('MEASURED')
  })

  test('keeps implementation shortfall undetermined when the immutable decision reference price is absent', () => {
    const execution = exactExecutionEvidence().map(
      ({ referencePriceMicros: _referencePriceMicros, ...evidence }) => evidence,
    )
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: exactTransactions(),
          executionEvidence: execution,
          marketVolumeEvidence: exactMarketVolumeEvidence(),
        }),
      ),
    )

    expect(receipt.profitability).toBe('PROFITABLE')
    expect(receipt.executionQuality.status).toBe('UNDETERMINED')
    expect(receipt.executionQuality.reasonCodes).toContain('REFERENCE_PRICE_EVIDENCE_GAP')
    expect(receipt.executionQuality.implementationShortfall).toBeNull()
    expect(receipt.observedCapacity).toMatchObject({
      status: 'UNDETERMINED',
      reasonCodes: ['EXECUTION_QUALITY_UNDETERMINED'],
      observations: [],
    })
  })

  test('fails execution measurement closed when a terminal fill lacks accounting and quantity binding', () => {
    const [execution] = exactExecutionEvidence()
    if (execution === undefined) throw new Error('execution fixture missing')
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: exactTransactions(),
          executionEvidence: [{ ...execution, fills: execution.fills.slice(0, 1) }],
        }),
      ),
    )

    expect(receipt.executionQuality.status).toBe('UNDETERMINED')
    expect(receipt.executionQuality.reasonCodes).toEqual(
      expect.arrayContaining(['ACCOUNTING_FILL_BINDING_GAP', 'FILL_QUANTITY_MISMATCH']),
    )
    expect(receipt.executionQuality.implementationShortfall).toBeNull()
  })

  test('measures shortfall but leaves observed capacity undetermined without market volume', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({ transactions: exactTransactions(), executionEvidence: exactExecutionEvidence() }),
      ),
    )

    expect(receipt.executionQuality.status).toBe('MEASURED')
    expect(receipt.observedCapacity).toEqual({
      status: 'UNDETERMINED',
      reasonCodes: ['MARKET_VOLUME_EVIDENCE_GAP'],
      evidenceHash: null,
      observations: [],
      boundedObservedReferenceNotionalMicros: null,
      boundedObservedExecutedNotionalMicros: null,
      maximumParticipationRate: null,
    })
  })

  test('includes adverse unfilled opportunity cost only with an immutable terminal reference price', () => {
    const [marketVolume] = exactMarketVolumeEvidence()
    if (marketVolume === undefined) throw new Error('market-volume fixture missing')
    const executionEvidence = [
      {
        cycleId: hash('a'),
        decisionDocumentHash: hash('8'),
        decisionHash: hash('e'),
        decisionCreatedAt: '2026-07-20T13:00:00.000Z',
        intentId: hash('c'),
        accountId: 'paper-account-1',
        symbol: 'NVDA',
        side: 'BUY' as const,
        plannedQuantityMicros: '1000000',
        referencePriceMicros: '100000000',
        intent: {
          intentId: hash('c'),
          accountId: 'paper-account-1',
          clientOrderId: 'client-order-1',
          cycleId: hash('a'),
          decisionHash: hash('e'),
          symbol: 'NVDA',
          side: 'BUY' as const,
          quantityMicros: '1000000',
          terminalOutcome: 'CANCELED' as const,
          createdAt: '2026-07-20T13:00:00.000Z',
          updatedAt: '2026-07-20T20:00:02.000Z',
        },
        terminalOrder: {
          eventId: hash('f'),
          brokerOrderId: 'broker-order-1',
          clientOrderId: 'client-order-1',
          intentId: hash('c'),
          accountId: 'paper-account-1',
          symbol: 'NVDA',
          side: 'BUY' as const,
          quantityMicros: '1000000',
          filledQuantityMicros: '400000',
          status: 'CANCELED' as const,
          occurredAt: '2026-07-20T20:00:02.000Z',
          observedAt: '2026-07-20T21:06:00.000Z',
        },
        fills: [
          {
            brokerEventId: hash('b'),
            fillId: 'fill-1',
            brokerOrderId: 'broker-order-1',
            clientOrderId: 'client-order-1',
            intentId: hash('c'),
            accountId: 'paper-account-1',
            symbol: 'NVDA',
            side: 'BUY' as const,
            quantityMicros: '400000',
            priceMicros: '101000000',
            feeMicros: '10',
            sourceTimestamp: '2026-07-20T20:00:00.000000000Z',
            occurredAt: '2026-07-20T20:00:00.000Z',
            observedAt: '2026-07-20T20:00:00.100Z',
          },
        ],
        terminalReferencePrice: terminalReferencePriceFor(marketVolume),
      },
    ]
    const transactions = [
      transaction('1', '0', '10', {
        brokerEventId: hash('b'),
        side: 'BUY',
        quantityMicros: '400000',
        priceMicros: '101000000',
        notionalMicros: '40400000',
        occurredAt: '2026-07-20T20:00:00.000Z',
      }),
    ]
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions,
          executionEvidence,
          marketVolumeEvidence: [marketVolume],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '10',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.executionQuality).toMatchObject({
      status: 'MEASURED',
      implementationShortfall: {
        filledQuantityMicros: '400000',
        unfilledQuantityMicros: '600000',
        executionPriceShortfallMicros: '400000',
        opportunityShortfallMicros: '1800000',
        explicitCostsMicros: '10',
        totalImplementationShortfallMicros: '2200010',
      },
    })
  })

  test('measures terminal zero-fill opportunity shortfall without requiring fabricated fills', () => {
    const [marketVolume] = exactMarketVolumeEvidence()
    const [filledExecution] = exactExecutionEvidence()
    if (marketVolume === undefined || filledExecution === undefined) throw new Error('execution fixture missing')
    const zeroFillIntentId = hash('0')
    const zeroFillExecution: ForwardPerformanceExecutionEvidence = {
      cycleId: hash('a'),
      decisionDocumentHash: hash('8'),
      decisionHash: hash('e'),
      decisionCreatedAt: '2026-07-20T13:00:00.000Z',
      intentId: zeroFillIntentId,
      accountId: 'paper-account-1',
      symbol: 'NVDA',
      side: 'BUY',
      plannedQuantityMicros: '1000000',
      referencePriceMicros: '100000000',
      intent: {
        intentId: zeroFillIntentId,
        accountId: 'paper-account-1',
        clientOrderId: 'zero-fill-client-order',
        cycleId: hash('a'),
        decisionHash: hash('e'),
        symbol: 'NVDA',
        side: 'BUY',
        quantityMicros: '1000000',
        terminalOutcome: 'CANCELED',
        createdAt: '2026-07-20T13:00:00.000Z',
        updatedAt: '2026-07-20T20:00:03.000Z',
      },
      terminalOrder: {
        eventId: hash('9'),
        brokerOrderId: 'zero-fill-broker-order',
        clientOrderId: 'zero-fill-client-order',
        intentId: zeroFillIntentId,
        accountId: 'paper-account-1',
        symbol: 'NVDA',
        side: 'BUY',
        quantityMicros: '1000000',
        filledQuantityMicros: '0',
        status: 'CANCELED',
        occurredAt: '2026-07-20T20:00:03.000Z',
        observedAt: '2026-07-20T20:00:03.100Z',
      },
      fills: [],
      terminalReferencePrice: terminalReferencePriceFor(marketVolume),
    }
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: exactTransactions(),
          executionEvidence: [filledExecution, zeroFillExecution],
          marketVolumeEvidence: [marketVolume],
        }),
      ),
    )

    expect(receipt.executionQuality.reasonCodes).not.toContain('FILL_EVIDENCE_GAP')
    expect(receipt.executionQuality).toMatchObject({
      status: 'MEASURED',
      implementationShortfall: {
        plannedOrderCount: 2,
        fillCount: 2,
        plannedQuantityMicros: '2000000',
        filledQuantityMicros: '1000000',
        unfilledQuantityMicros: '1000000',
        opportunityShortfallMicros: '3000000',
      },
    })
    expect(receipt.observedCapacity).toMatchObject({
      status: 'MEASURED',
      observations: [
        {
          cycleId: hash('a'),
          symbol: 'NVDA',
          filledQuantityMicros: '1000000',
          marketVolumeQuantityMicros: '100000000',
        },
      ],
    })
  })

  test('measures an all-zero terminal plan while profitability remains unproven', () => {
    const [marketVolume] = exactMarketVolumeEvidence()
    if (marketVolume === undefined) throw new Error('market-volume fixture missing')
    const intentId = hash('0')
    const zeroFillExecution: ForwardPerformanceExecutionEvidence = {
      cycleId: hash('a'),
      decisionDocumentHash: hash('8'),
      decisionHash: hash('e'),
      decisionCreatedAt: '2026-07-20T13:00:00.000Z',
      intentId,
      accountId: 'paper-account-1',
      symbol: 'NVDA',
      side: 'BUY',
      plannedQuantityMicros: '1000000',
      referencePriceMicros: '100000000',
      intent: {
        intentId,
        accountId: 'paper-account-1',
        clientOrderId: 'all-zero-client-order',
        cycleId: hash('a'),
        decisionHash: hash('e'),
        symbol: 'NVDA',
        side: 'BUY',
        quantityMicros: '1000000',
        terminalOutcome: 'CANCELED',
        createdAt: '2026-07-20T13:00:00.000Z',
        updatedAt: '2026-07-20T20:00:03.000Z',
      },
      terminalOrder: {
        eventId: hash('9'),
        brokerOrderId: 'all-zero-broker-order',
        clientOrderId: 'all-zero-client-order',
        intentId,
        accountId: 'paper-account-1',
        symbol: 'NVDA',
        side: 'BUY',
        quantityMicros: '1000000',
        filledQuantityMicros: '0',
        status: 'CANCELED',
        occurredAt: '2026-07-20T20:00:03.000Z',
        observedAt: '2026-07-20T20:00:03.100Z',
      },
      fills: [],
      terminalReferencePrice: terminalReferencePriceFor(marketVolume),
    }
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [],
          executionEvidence: [zeroFillExecution],
          marketVolumeEvidence: [marketVolume],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.evidence.reasonCodes).toContain('ZERO_COMPLETED_EXECUTIONS')
    expect(receipt.profitability).toBe('UNDETERMINED')
    expect(receipt.executionQuality).toMatchObject({
      status: 'MEASURED',
      reasonCodes: [],
      implementationShortfall: {
        plannedOrderCount: 1,
        fillCount: 0,
        plannedQuantityMicros: '1000000',
        filledQuantityMicros: '0',
        unfilledQuantityMicros: '1000000',
        opportunityShortfallMicros: '3000000',
        totalImplementationShortfallMicros: '3000000',
        firstFillAt: null,
        lastFillAt: null,
      },
    })
    expect(receipt.observedCapacity).toMatchObject({
      status: 'MEASURED',
      observations: [
        {
          cycleId: hash('a'),
          symbol: 'NVDA',
          filledQuantityMicros: '0',
          marketVolumeQuantityMicros: '100000000',
          participationRate: {
            numeratorQuantityMicros: '0',
            denominatorQuantityMicros: '100000000',
            decimal: '0.000000000000',
          },
        },
      ],
      maximumParticipationRate: {
        numeratorQuantityMicros: '0',
        denominatorQuantityMicros: '100000000',
        decimal: '0.000000000000',
      },
    })
  })

  test('measures a risk-blocked plan without requiring broker-order evidence', () => {
    const [marketVolume] = exactMarketVolumeEvidence()
    if (marketVolume === undefined) throw new Error('market-volume fixture missing')
    const intentId = hash('0')
    const blockedExecution: ForwardPerformanceExecutionEvidence = {
      cycleId: hash('a'),
      decisionDocumentHash: hash('8'),
      decisionHash: hash('e'),
      decisionCreatedAt: '2026-07-20T13:00:00.000Z',
      intentId,
      accountId: 'paper-account-1',
      symbol: 'NVDA',
      side: 'BUY',
      plannedQuantityMicros: '1000000',
      referencePriceMicros: '100000000',
      intent: {
        intentId,
        accountId: 'paper-account-1',
        clientOrderId: 'blocked-client-order',
        cycleId: hash('a'),
        decisionHash: hash('e'),
        symbol: 'NVDA',
        side: 'BUY',
        quantityMicros: '1000000',
        terminalOutcome: 'BLOCKED',
        createdAt: '2026-07-20T13:00:00.000Z',
        updatedAt: '2026-07-20T13:05:00.000Z',
      },
      fills: [],
      terminalReferencePrice: terminalReferencePriceFor(marketVolume),
    }
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [],
          executionEvidence: [blockedExecution],
          marketVolumeEvidence: [marketVolume],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.profitability).toBe('UNDETERMINED')
    expect(receipt.executionQuality.reasonCodes).not.toEqual(
      expect.arrayContaining(['TERMINAL_ORDER_EVIDENCE_GAP', 'FILL_TIMESTAMP_GAP', 'TERMINAL_PRICE_EVIDENCE_GAP']),
    )
    expect(receipt.executionQuality).toMatchObject({
      status: 'MEASURED',
      implementationShortfall: {
        fillCount: 0,
        filledQuantityMicros: '0',
        unfilledQuantityMicros: '1000000',
        opportunityShortfallMicros: '3000000',
        firstFillAt: null,
        lastFillAt: null,
        lastTerminalOrderObservedAt: '2026-07-20T13:05:00.000Z',
      },
    })
    expect(receipt.observedCapacity).toMatchObject({
      status: 'MEASURED',
      observations: [
        {
          cycleId: hash('a'),
          symbol: 'NVDA',
          filledQuantityMicros: '0',
          participationRate: { decimal: '0.000000000000' },
        },
      ],
    })
  })

  test('does not estimate opportunity cost when the terminal reference price is absent', () => {
    const [execution] = exactExecutionEvidence()
    if (execution === undefined || execution.terminalOrder === undefined || execution.intent === undefined) {
      throw new Error('execution fixture missing')
    }
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [exactTransactions()[0]!],
          executionEvidence: [
            {
              ...execution,
              intent: { ...execution.intent, terminalOutcome: 'CANCELED' },
              terminalOrder: {
                ...execution.terminalOrder,
                status: 'CANCELED',
                filledQuantityMicros: '400000',
              },
              fills: execution.fills.slice(0, 1),
            },
          ],
          ledgerTotals: {
            realizedGainMicros: '40',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '10',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.executionQuality.status).toBe('UNDETERMINED')
    expect(receipt.executionQuality.reasonCodes).toContain('TERMINAL_PRICE_EVIDENCE_GAP')
    expect(receipt.executionQuality.implementationShortfall).toBeNull()
  })

  test('rejects market-volume evidence that does not cover the fill-to-terminal interval', () => {
    const [volume] = exactMarketVolumeEvidence()
    if (volume === undefined) throw new Error('volume fixture missing')
    const { contentHash: _contentHash, ...volumeMaterial } = volume
    const driftedMaterial = { ...volumeMaterial, windowOpenedAt: '2026-07-20T20:00:00.500Z' }
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: exactTransactions(),
          executionEvidence: exactExecutionEvidence(),
          marketVolumeEvidence: [{ ...driftedMaterial, contentHash: canonicalHashV1(driftedMaterial) }],
        }),
      ),
    )

    expect(receipt.executionQuality.status).toBe('MEASURED')
    expect(receipt.observedCapacity.status).toBe('UNDETERMINED')
    expect(receipt.observedCapacity.reasonCodes).toEqual(['MARKET_VOLUME_IDENTITY_DRIFT'])
    expect(receipt.observedCapacity.observations).toEqual([])
  })

  test('rejects self-inconsistent immutable market-volume evidence', () => {
    const [volume] = exactMarketVolumeEvidence()
    if (volume === undefined) throw new Error('volume fixture missing')
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: exactTransactions(),
          executionEvidence: exactExecutionEvidence(),
          marketVolumeEvidence: [{ ...volume, quantityMicros: '100000001' }],
        }),
      ),
    )

    expect(receipt.executionQuality.status).toBe('MEASURED')
    expect(receipt.observedCapacity.status).toBe('UNDETERMINED')
    expect(receipt.observedCapacity.reasonCodes).toEqual(['INVALID_MARKET_VOLUME_EVIDENCE'])
    expect(receipt.observedCapacity.observations).toEqual([])
  })

  test('reports realized losses without using mark-to-market equity', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [transaction('e', '-50', '10')],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '50',
            brokerExecutionFeesMicros: '10',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.profitability).toBe('NOT_PROFITABLE')
    expect(receipt.totals.grossRealizedPnlMicros).toBe('-50')
    expect(receipt.totals.netRealizedPnlAfterCostsMicros).toBe('-60')
  })

  test('fees can flip gross profit into a net realized loss', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [transaction('e', '100', '150')],
          ledgerTotals: {
            realizedGainMicros: '100',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '150',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.profitability).toBe('NOT_PROFITABLE')
    expect(receipt.totals.grossRealizedPnlMicros).toBe('100')
    expect(receipt.totals.netRealizedPnlAfterCostsMicros).toBe('-50')
  })

  test('cash yield can make total realized economic income profitable without changing gross trade PnL', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          reconciliation: {
            reconciliationId: hash('8'),
            contentHash: hash('9'),
            status: 'DISCREPANCY',
            performanceExact: true,
            cashYieldAdjustedExact: true,
            reconciledAt: '2026-07-20T21:01:00.000Z',
          },
          transactions: [transaction('e', '-100', '0')],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '100',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '200',
          },
          cashYieldEvidenceRequired: true,
          cashYieldEvidence: cashYieldBinding(),
        }),
      ),
    )

    expect(receipt.evidence).toEqual({
      status: 'SUFFICIENT',
      reasonCodes: [],
      cashYield: cashYieldBinding(),
    })
    expect(receipt.profitability).toBe('PROFITABLE')
    expect(receipt.window).toMatchObject({
      reconciliationStatus: 'DISCREPANCY',
      cashYieldAdjustedExact: true,
    })
    expect(receipt.totals).toMatchObject({
      grossRealizedPnlMicros: '-100',
      cashYieldMicros: '200',
      netRealizedPnlAfterCostsMicros: '100',
      netRealizedReturn: {
        numeratorMicros: '100',
        denominatorMicros: '1000',
        decimal: '0.100000000000',
      },
    })
  })

  test('cash yield can reduce a realized loss without falsely crossing profitability', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [transaction('e', '-200', '0')],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '200',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '100',
          },
          cashYieldEvidenceRequired: true,
          cashYieldEvidence: cashYieldBinding('100'),
        }),
      ),
    )

    expect(receipt.profitability).toBe('NOT_PROFITABLE')
    expect(receipt.totals.grossRealizedPnlMicros).toBe('-200')
    expect(receipt.totals.cashYieldMicros).toBe('100')
    expect(receipt.totals.netRealizedPnlAfterCostsMicros).toBe('-100')
  })

  test('zero cash yield preserves the checked trade net after costs', () => {
    const receipt = success(makeForwardPerformanceReceipt(input()))

    expect(receipt.totals.cashYieldMicros).toBe('0')
    expect(receipt.totals.grossRealizedPnlMicros).toBe('100')
    expect(receipt.totals.netRealizedPnlAfterCostsMicros).toBe('80')
  })

  test('an open or partial operating window is insufficient evidence', () => {
    const receipt = success(makeForwardPerformanceReceipt(input({ unclosedCycleCount: 1 })))

    expect(receipt.evidence).toEqual({
      status: 'INSUFFICIENT_EVIDENCE',
      reasonCodes: ['UNCLOSED_WINDOW'],
      cashYield: null,
    })
    expect(receipt.profitability).toBe('UNDETERMINED')
  })

  test('zero activity is never profitable', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          cycles: [cycle('a', { state: 'NO_TRADE' })],
          transactions: [],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.evidence.reasonCodes).toContain('ZERO_COMPLETED_EXECUTIONS')
    expect(receipt.profitability).toBe('UNDETERMINED')
    expect(receipt.counts.completedExecutionCount).toBe(0)
    expect(receipt.executionQuality).toEqual({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['ZERO_COMPLETED_EXECUTIONS'],
      evidenceHash: null,
      implementationShortfall: null,
    })
    expect(receipt.observedCapacity).toEqual({
      status: 'NOT_ELIGIBLE',
      reasonCodes: ['ZERO_COMPLETED_EXECUTIONS'],
      evidenceHash: null,
      observations: [],
      boundedObservedReferenceNotionalMicros: null,
      boundedObservedExecutedNotionalMicros: null,
      maximumParticipationRate: null,
    })
  })

  test('missing starting capital is an evidence gap rather than malformed micros', () => {
    const evidence = input()
    Reflect.deleteProperty(evidence, 'startingCapitalMicros')
    const receipt = success(makeForwardPerformanceReceipt(evidence))

    expect(receipt.evidence.reasonCodes).toContain('STARTING_CAPITAL_GAP')
    expect(receipt.evidence.reasonCodes).not.toContain('INVALID_MICROS')
    expect(receipt.profitability).toBe('UNDETERMINED')
  })

  test('invalid or overflowing integer-micro arithmetic fails closed', () => {
    const max = ((1n << 127n) - 1n).toString()
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [transaction('e', `-${max}`, max)],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: max,
            brokerExecutionFeesMicros: max,
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.evidence.reasonCodes).toContain('INVALID_MICROS')
    expect(receipt.profitability).toBe('UNDETERMINED')
    expect(receipt.totals.netRealizedPnlAfterCostsMicros).toBeNull()
  })

  test('invalid or overflowing cash yield arithmetic fails closed', () => {
    const max = ((1n << 127n) - 1n).toString()
    const overflow = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [transaction('e', max, '0')],
          ledgerTotals: {
            realizedGainMicros: max,
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '1',
          },
        }),
      ),
    )
    const invalid = success(
      makeForwardPerformanceReceipt(
        input({
          ledgerTotals: {
            realizedGainMicros: '100',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '20',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '-1',
          },
        }),
      ),
    )

    for (const receipt of [overflow, invalid]) {
      expect(receipt.evidence.reasonCodes).toContain('INVALID_MICROS')
      expect(receipt.profitability).toBe('UNDETERMINED')
      expect(receipt.totals.netRealizedPnlAfterCostsMicros).toBeNull()
    }
  })

  test('canonical ordering produces one deterministic content hash', () => {
    const secondCycle = cycle('f', {
      submissionOpenAt: '2026-07-21T13:00:00.000Z',
      terminalAt: '2026-07-21T21:00:00.000Z',
    })
    const evidence = {
      transactions: [transaction('e', '-100', '0')],
      ledgerTotals: {
        realizedGainMicros: '0',
        realizedLossMicros: '100',
        brokerExecutionFeesMicros: '0',
        otherChargedCostsMicros: '0',
        cashYieldMicros: '200',
      },
      cashYieldEvidenceRequired: true,
      cashYieldEvidence: cashYieldBinding(),
      reconciliation: {
        reconciliationId: hash('8'),
        contentHash: hash('9'),
        status: 'DISCREPANCY' as const,
        performanceExact: true,
        cashYieldAdjustedExact: true,
        reconciledAt: '2026-07-21T21:01:00.000Z',
      },
    } as const
    const first = success(makeForwardPerformanceReceipt(input({ ...evidence, cycles: [secondCycle, cycle('a')] })))
    const second = success(makeForwardPerformanceReceipt(input({ ...evidence, cycles: [cycle('a'), secondCycle] })))

    expect(first).toEqual(second)
    expect(first.schemaVersion).toBe('bayn.forward-performance-receipt.v3')
    expect(first.receiptHash).toBe('62d38bc64113308d3aba90c29c877cceb9c3c7d390ca382dd26ff1207ab1a6e4')
    expect(first.evidence).toEqual({
      status: 'SUFFICIENT',
      reasonCodes: [],
      cashYield: cashYieldBinding(),
    })
    expect(first.profitability).toBe('PROFITABLE')
    expect(first.totals.netRealizedPnlAfterCostsMicros).toBe('100')
    expect(JSON.stringify(first)).not.toContain('paper-account-1')
  })

  test('a ledger reconciliation failure remains insufficient even when cash yield crosses profitability', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [transaction('e', '-100', '0')],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '100',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '200',
          },
          ledgerExact: false,
        }),
      ),
    )

    expect(receipt.totals.netRealizedPnlAfterCostsMicros).toBe('100')
    expect(receipt.evidence.reasonCodes).toContain('LEDGER_MISMATCH')
    expect(receipt.evidence.status).toBe('INSUFFICIENT_EVIDENCE')
    expect(receipt.profitability).toBe('UNDETERMINED')
  })

  test('an unexplained cash discrepancy remains insufficient even when yield would cross profitability', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          reconciliation: {
            reconciliationId: hash('8'),
            contentHash: hash('9'),
            status: 'DISCREPANCY',
            performanceExact: false,
            cashYieldAdjustedExact: false,
            reconciledAt: '2026-07-20T21:01:00.000Z',
          },
          transactions: [transaction('e', '-100', '0')],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '100',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '200',
          },
        }),
      ),
    )

    expect(receipt.evidence.reasonCodes).toContain('NON_EXACT_RECONCILIATION')
    expect(receipt.profitability).toBe('UNDETERMINED')
    expect(receipt.window).toMatchObject({
      reconciliationStatus: 'DISCREPANCY',
      cashYieldAdjustedExact: false,
    })
  })

  test('identity drift across completed cycles is insufficient', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          cycles: [cycle('a'), cycle('f', { strategyProtocolHash: hash('f') })],
        }),
      ),
    )

    expect(receipt.evidence.reasonCodes).toContain('CYCLE_IDENTITY_DRIFT')
    expect(receipt.profitability).toBe('UNDETERMINED')
  })

  test('durable execution account drift is insufficient', () => {
    const baseline = input()
    const binding = baseline.durableExecutionBindings[0]
    assert(binding !== undefined)
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          durableExecutionBindings: [{ ...binding, environment: 'live' }],
        }),
      ),
    )

    expect(receipt.evidence.reasonCodes).toContain('ACCOUNT_IDENTITY_GAP')
    expect(receipt.profitability).toBe('UNDETERMINED')
  })
})
