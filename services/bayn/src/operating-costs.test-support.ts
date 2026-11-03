import { Result } from 'effect'

import { canonicalHashV1Result, sha256 } from './hash'
import { OperatingCostCategory, OperatingCostCoverage, type OperatingCostEvidence } from './operating-costs'

export type OperatingAmountsFixture = {
  readonly netTradingPnlMicros: string
  readonly inferenceInvoiceMicros: string
  readonly inferenceTariffMicros: string
  readonly dataCostMicros: string
  readonly infrastructureCostMicros: string
  readonly researchCostMicros: string
}

export const operatingCostFixture = (amounts: OperatingAmountsFixture) => {
  const accountBindingHash = sha256('synthetic economic account')
  const sessionDate = '1970-01-01'
  const asOf = '1970-01-02T00:00:00.000Z'
  const tradingSourceHash = sha256('synthetic trading source')
  const amountsByCategory = {
    [OperatingCostCategory.Inference]: amounts.inferenceInvoiceMicros,
    [OperatingCostCategory.Data]: amounts.dataCostMicros,
    [OperatingCostCategory.Infrastructure]: amounts.infrastructureCostMicros,
    [OperatingCostCategory.Research]: amounts.researchCostMicros,
  }
  const evidence: OperatingCostEvidence = {
    schemaVersion: 'bayn.operating-cost-evidence.v1',
    accountBindingHash,
    sessionDate,
    asOf,
    currency: 'USD',
    trading: { netPnlAfterExecutionFeesMicros: amounts.netTradingPnlMicros, sourceHash: tradingSourceHash },
    coverage: Object.values(OperatingCostCategory).map((category) => ({
      category,
      status: OperatingCostCoverage.Complete,
      sourceHash: sha256(category),
    })),
    consumption: Object.values(OperatingCostCategory).map((category) => ({
      provider: 'synthetic provider',
      documentId: sha256(category),
      lineId: '1',
      sourceHash: sha256(category),
      category,
      serviceStartDate: sessionDate,
      serviceEndDateExclusive: '1970-01-02',
      grossAmountMicros: amountsByCategory[category],
      credits: [],
      allocations: [
        { accountBindingHash, sessionDate, amountMicros: amountsByCategory[category], sourceHash: sha256(category) },
      ],
      unallocatedMicros: '0',
    })),
    prepaidFunding: [],
  }
  const inferenceMaterial = {
    accountBindingHash,
    sessionDate,
    asOf,
    knownEstimatedCostMicros: amounts.inferenceTariffMicros,
    estimatedTotalCostMicros: amounts.inferenceTariffMicros,
    unknownUsageCount: 0,
    unpricedUsageCount: 0,
  }
  return {
    evidence,
    inference: { ...inferenceMaterial, reportHash: Result.getOrThrow(canonicalHashV1Result(inferenceMaterial)) },
    verifiedSources: new Set([tradingSourceHash, ...evidence.consumption.map((line) => line.sourceHash)]),
  }
}
