// Immutable policy data is retained only to verify existing financial assessment receipts.
export const retainedRegisteredWindowPolicy = {
  schemaVersion: 'bayn.jev-acceptance-policy.v3',
  programStartedAt: '2026-09-21T08:31:54Z',
  evaluation: {
    window: 'PROSPECTIVE_NONEMPTY_REGISTERED_CALENDAR',
    minimumCompletedEpisodes: 200,
    uncertainty: {
      resamplingUnit: 'TWO_CONSECUTIVE_SESSION_CIRCULAR_BLOCKS',
      replicateLength: 'REGISTERED_SESSION_COUNT_WITH_FINAL_BLOCK_TRUNCATION',
      seed: 20260921,
      replicates: 10000,
      familywiseAlpha: 0.05,
      oneSided95PercentLowerBoundForMeanNetPnlGreaterThan: 0,
      pairedMeanIncrementalNetPnlUsdLowerBoundGreaterThan: 50,
    },
  },
  requiredOutcomes: {
    completedEpisodesPerSessionAtLeast: 10,
    filledBuyPlusSellNotionalPerSessionUsdAtLeast: 100000,
    netPnlVsBestMatchedControlAtLeastMultiplier: '1.25',
    minimumNetAfterDroppingBestSessionUsdExclusive: 0,
    allOutcomesRequiredTogether: true,
    netPnlUsdAtLeast: 5000,
  },
  riskAcceptance: {
    allocationUsd: 100000,
    maximumMarkedPeakToTroughDrawdownUsd: 2500,
    maximumSessionLossUsd: 1000,
    existingBrokerRiskPolicyHash: 'a0f680ac1db91a7d1950960034950048b68659629da29ead1cc79852725d01a0',
    existingMaximumOrderAndSymbolNotionalUsd: 40000,
    existingMaximumGrossAndNetExposureUsd: 100000,
    existingMaximumDailyTradedNotionalUsd: 200000,
    exitAuthorityPreserved: true,
    leverageOrShortingExpansion: false,
    activityQuotasDoNotForceOrders: true,
  },
  executionEvidence: {
    stress: {
      additionalCostBpsOnEachFilledLeg: 10,
      netMustRemainPositive: true,
      p95ObservedFullBatchLatency: true,
    },
    modelCost: {
      usdPerMillionInputTokens: '0.042',
      usdPerMillionOutputTokens: '0',
      source: 'https://docs.typesafe.ai/models',
      verifiedDate: '2026-09-21',
      countFailedAndRejectedCalls: true,
      useGreaterOfTariffEstimateOrActualInvoice: true,
    },
  },
}
