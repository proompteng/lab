export const costAttributionRule = {
  schemaVersion: 'bayn.system-cost-attribution.v2',
  sessionAllocations: 'PROSPECTIVELY_REGISTERED_SERVICE_PERIOD_WEIGHTS',
  allocationRounding: 'CANONICAL_SCOPE_CUMULATIVE_FLOOR_WITH_EXACT_TERMINAL_TOTAL',
  fixedCosts: 'LINEAR_REGISTERED_SESSION_TIME',
  inferenceInvoice: 'PROPORTIONAL_FROZEN_TARIFF_AT_REQUEST_START',
  qualificationPremium: 'PROPORTIONAL_FROZEN_TARIFF_AT_REQUEST_START',
  zeroUsageInvoice: 'LINEAR_REGISTERED_SESSION_TIME',
  outsideSessionRequest: 'CLAMP_TO_REGISTERED_SESSION_BOUNDARY',
  rounding: 'FLOOR_CUMULATIVE_WITH_EXACT_TERMINAL_TOTAL',
} as const
