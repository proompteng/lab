import type { ForwardPerformanceLedgerTotals } from './model'

export const ledgerTotalsFixture = (
  overrides: Partial<ForwardPerformanceLedgerTotals> = {},
): ForwardPerformanceLedgerTotals => ({
  realizedGainMicros: '0',
  realizedLossMicros: '0',
  cashSettlementRoundingMicros: '0',
  brokerExecutionFeesMicros: '0',
  otherChargedCostsMicros: '0',
  cashYieldMicros: '0',
  ...overrides,
})
