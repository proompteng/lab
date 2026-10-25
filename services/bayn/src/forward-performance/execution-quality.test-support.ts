import { createHash } from 'node:crypto'

import type { ForwardPerformanceEvidenceInput, ForwardPerformanceExecutionEvidence } from './model'

/** Synthetic completed fills only; no account, broker, database or market-data reads. */
export const executionQualityFixture = (count: number): ForwardPerformanceEvidenceInput => {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const accountId = 'synthetic-forward-performance'
  const createdAt = '2026-07-20T13:30:00.000Z'
  const occurredAt = '2026-07-20T14:00:00.000Z'
  const observedAt = '2026-07-20T14:00:00.100Z'
  const cycles = Array.from({ length: count }, (_, index) => ({
    cycleId: hash(`cycle-${index}`),
    qualificationRunId: hash('qualification'),
    strategyName: 'synthetic',
    strategyProtocolHash: hash('protocol'),
    accountId,
    executionPolicyHash: hash('execution'),
    strategyExecutionModelHash: hash('model'),
    state: 'COMPLETED' as const,
    submissionOpenAt: createdAt,
    terminalAt: observedAt,
  }))
  const executionEvidence: ForwardPerformanceExecutionEvidence[] = cycles.map(({ cycleId }, index) => {
    const intentId = hash(`intent-${index}`)
    const decisionHash = hash(`decision-${index}`)
    const clientOrderId = `client-${index}`
    const brokerOrderId = `broker-${index}`
    const identity = { intentId, accountId, symbol: 'NVDA', side: 'SELL' as const }
    return {
      ...identity,
      cycleId,
      decisionDocumentHash: hash(`document-${index}`),
      decisionHash,
      decisionCreatedAt: createdAt,
      plannedQuantityAtoms: '1000000000',
      referencePriceMicros: '100000000',
      intent: {
        ...identity,
        clientOrderId,
        cycleId,
        decisionHash,
        quantityAtoms: '1000000000',
        terminalOutcome: 'FILLED',
        createdAt,
        updatedAt: observedAt,
      },
      terminalOrder: {
        ...identity,
        eventId: hash(`order-${index}`),
        brokerOrderId,
        clientOrderId,
        quantityAtoms: '1000000000',
        filledQuantityAtoms: '1000000000',
        status: 'FILLED',
        occurredAt,
        observedAt,
      },
      fills: [
        {
          ...identity,
          brokerEventId: hash(`fill-event-${index}`),
          fillId: `fill-${index}`,
          brokerOrderId,
          clientOrderId,
          quantityAtoms: '1000000000',
          priceAtoms: '100000000000',
          feeMicros: '0',
          sourceTimestamp: '2026-07-20T14:00:00.000000000Z',
          occurredAt,
          observedAt,
        },
      ],
    }
  })
  return {
    runtime: {
      sourceRevision: 'a'.repeat(40),
      imageRepository: 'registry.example.test/bayn',
      imageDigest: `sha256:${hash('image')}`,
    },
    account: { accountId, accountReferenceHash: hash('account'), provider: 'alpaca', environment: 'sandbox' },
    durableExecutionBindings: [],
    cycles,
    reconciliation: {
      reconciliationId: hash('reconciliation'),
      contentHash: hash('reconciliation-content'),
      status: 'EXACT',
      performanceExact: true,
      cashYieldAdjustedExact: false,
      reconciledAt: observedAt,
    },
    startingCapitalMicros: '1000000000000',
    transactions: executionEvidence.flatMap((execution, index) =>
      execution.fills.map((fill) => ({
        transactionId: hash(`transaction-${index}`),
        brokerEventId: fill.brokerEventId,
        intentId: execution.intentId,
        cycleId: execution.cycleId,
        symbol: execution.symbol,
        side: execution.side,
        quantityAtoms: fill.quantityAtoms,
        priceAtoms: fill.priceAtoms,
        notionalMicros: '100000000',
        feeMicros: '0',
        realizedPnlMicros: '0',
        occurredAt,
      })),
    ),
    executionEvidence,
    ledgerTotals: {
      realizedGainMicros: '0',
      realizedLossMicros: '0',
      brokerExecutionFeesMicros: '0',
      otherChargedCostsMicros: '0',
      cashYieldMicros: '0',
      cashSettlementRoundingMicros: '0',
    },
    accountingReceiptsExact: true,
    ledgerExact: true,
    missingLedgerAccountCount: 0,
    unresolvedMutationCount: 0,
    unclosedCycleCount: 0,
    openPositionCount: 0,
    cashYieldEvidenceRequired: false,
  }
}
