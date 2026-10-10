import { Result } from 'effect'
import { makeForwardPerformanceReceipt } from '../forward-performance/domain'
import type { ForwardPerformanceEvidenceInput } from '../forward-performance/model'

export const makePersistenceReceipt = (overrides: Partial<ForwardPerformanceEvidenceInput> = {}) => {
  const hash = (value: string) => value.repeat(64)
  const runtime = {
    sourceRevision: 'b'.repeat(40),
    imageRepository: 'registry.example.test/lab/bayn',
    imageDigest: `sha256:${hash('c')}`,
  }
  const account = {
    accountId: 'persistence-test-account',
    accountReferenceHash: hash('d'),
    provider: 'alpaca',
    environment: 'sandbox',
  }
  const strategy = {
    ...runtime,
    qualificationRunId: hash('1'),
    strategyName: 'persistence-test-strategy',
    strategyProtocolHash: hash('2'),
    strategyBehaviorHash: hash('3'),
    strategyParameterHash: hash('4'),
    strategyParameterSchemaVersion: 'persistence-test-parameters.v1',
  }
  const receipt = Result.getOrThrow(
    makeForwardPerformanceReceipt({
      runtime,
      account,
      strategy,
      durableExecutionBindings: [{ ...account, ...strategy, executionPolicyHash: hash('5') }],
      cycles: [
        {
          cycleId: hash('a'),
          qualificationRunId: strategy.qualificationRunId,
          strategyName: strategy.strategyName,
          strategyProtocolHash: strategy.strategyProtocolHash,
          accountId: account.accountId,
          executionPolicyHash: hash('5'),
          strategyExecutionModelHash: hash('6'),
          state: 'COMPLETED',
          submissionOpenAt: '2026-07-20T13:00:00.000Z',
          terminalAt: '2026-07-20T21:00:00.000Z',
        },
      ],
      reconciliation: {
        reconciliationId: hash('7'),
        contentHash: hash('8'),
        status: 'EXACT',
        performanceExact: true,
        cashYieldAdjustedExact: false,
        reconciledAt: '2026-07-20T21:01:00.000Z',
      },
      startingCapitalMicros: '1000',
      transactions: [
        {
          transactionId: hash('9'),
          brokerEventId: hash('b'),
          intentId: hash('c'),
          cycleId: hash('a'),
          symbol: 'NVDA',
          side: 'SELL',
          quantityMicros: '1000000',
          priceMicros: '109000000',
          notionalMicros: '109000000',
          feeMicros: '20',
          realizedPnlMicros: '100',
          occurredAt: '2026-07-20T20:00:00.000Z',
        },
      ],
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
      cashYieldEvidenceRequired: false,
      ...overrides,
    }),
  )
  return receipt
}
