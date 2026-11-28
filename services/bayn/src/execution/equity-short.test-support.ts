import type { EquityShortEligibility } from './equity-short'

export const shortEligibilityFixture = (
  accountId: string,
  symbol: string,
  observedAt: string,
): EquityShortEligibility => ({
  schemaVersion: 'bayn.equity-short-eligibility.v1',
  accountId,
  symbol,
  accountHash: 'a'.repeat(64),
  configurationHash: 'b'.repeat(64),
  assetHash: 'c'.repeat(64),
  accountObservedAt: observedAt,
  configurationObservedAt: observedAt,
  assetObservedAt: observedAt,
  accountActive: true,
  shortingEnabled: true,
  noShorting: false,
  assetActive: true,
  tradable: true,
  marginable: true,
  shortable: true,
  easyToBorrow: true,
})
