import { canonicalHashV1 } from '../hash'
import type { ForwardPerformanceReceipt, ForwardPerformanceReceiptMaterial } from './model'

export const performanceWindowAccountId = 'performance-window-test-account'
export const performanceWindowGenerationHash = '1'.repeat(64)

export const makeWindowReceiptFixture = (
  overrides: Partial<ForwardPerformanceReceiptMaterial> = {},
): ForwardPerformanceReceipt => {
  const build = {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.example.test/lab/bayn',
    imageDigest: `sha256:${'b'.repeat(64)}`,
  }
  const material: ForwardPerformanceReceiptMaterial = {
    schemaVersion: 'bayn.forward-performance-receipt.v3',
    bindings: {
      runtime: build,
      source: build,
      strategy: {
        qualificationRunId: '2'.repeat(64),
        strategyName: 'intraday-momentum',
        strategyProtocolHash: '3'.repeat(64),
        strategyBehaviorHash: '4'.repeat(64),
        strategyParameterHash: '5'.repeat(64),
        strategyParameterSchemaVersion: 'bayn.intraday-momentum.protocol.v3',
        executionPolicyHash: '6'.repeat(64),
        strategyExecutionModelHash: '7'.repeat(64),
      },
      account: { accountReferenceHash: '8'.repeat(64), provider: 'alpaca', environment: 'sandbox' },
    },
    window: {
      firstCycleId: '9'.repeat(64),
      lastCycleId: '9'.repeat(64),
      openedAt: '2026-09-18T13:30:00.000Z',
      closedAt: '2026-09-18T20:01:00.000Z',
      reconciliationId: 'c'.repeat(64),
      reconciliationContentHash: 'd'.repeat(64),
      reconciliationStatus: 'EXACT',
      cashYieldAdjustedExact: false,
    },
    totals: {
      startingCapitalMicros: '100000000000',
      realizedGainsMicros: '100000000',
      realizedLossesMicros: '0',
      brokerExecutionFeesMicros: '1000000',
      otherChargedCostsMicros: '0',
      cashYieldMicros: '0',
      grossRealizedPnlMicros: '100000000',
      netRealizedPnlAfterCostsMicros: '99000000',
      netRealizedReturn: { numeratorMicros: '99000000', denominatorMicros: '100000000000', decimal: '0.000990000000' },
    },
    counts: { cycleCount: 1, completedExecutionCount: 2, realizedCloseCount: 1 },
    evidence: { status: 'SUFFICIENT', reasonCodes: [], cashYield: null },
    reconciliationProof: {
      accountingReceiptsExact: true,
      ledgerExact: true,
      missingLedgerAccountCount: 0,
      unresolvedMutationCount: 0,
      unclosedCycleCount: 0,
      openPositionCount: 0,
    },
    executionQuality: {
      status: 'UNDETERMINED',
      reasonCodes: ['PLANNED_DECISION_EVIDENCE_GAP'],
      evidenceHash: null,
      implementationShortfall: null,
    },
    observedCapacity: {
      status: 'UNDETERMINED',
      reasonCodes: ['EXECUTION_QUALITY_UNDETERMINED'],
      evidenceHash: null,
      observations: [],
      boundedObservedReferenceNotionalMicros: null,
      boundedObservedExecutedNotionalMicros: null,
      maximumParticipationRate: null,
    },
    profitability: 'PROFITABLE',
    ...overrides,
  }
  return { ...material, receiptHash: canonicalHashV1(material) }
}
