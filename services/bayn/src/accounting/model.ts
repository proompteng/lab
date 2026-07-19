import { AccountFlags } from 'tigerbeetle-node'

/**
 * Bayn's accounting contract is intentionally immutable. A semantic or numeric
 * change requires a new exported model instead of mutating this one in place.
 */
export const BAYN_ACCOUNTING_MODEL_V1 = {
  schemaVersion: 'bayn.tigerbeetle-accounting.v1',
  evaluationSchemaVersion: 'bayn.evaluation-economics.v1',
  identifierVersion: 'bayn.sha256-u128.v1',
  reconciliationSchemaVersion: 'bayn.tigerbeetle-reconciliation.v1',
  modelVersion: 1,
  ledgers: {
    usdMicros: 11_001,
    shareE8: 11_002,
  },
  units: {
    usdMicros: {
      name: 'USD_MICRO',
      scale: 6,
      description: 'One unit is USD 0.000001. All cash, fees, gross trade consideration, and valuation use this unit.',
    },
    shareE8: {
      name: 'SHARE_E8',
      scale: 8,
      description: 'One unit is 0.00000001 share. All position quantities use this unit.',
    },
  },
  accountCodes: {
    cashAsset: 11_001,
    contributedCapital: 11_002,
    tradeSettlement: 11_003,
    feeExpense: 11_004,
    endingValuationAsset: 11_005,
    endingValuationOffset: 11_006,
    securityPosition: 11_101,
    securityMarket: 11_102,
  },
  transferCodes: {
    initialCash: 12_001,
    cashDeposit: 12_002,
    cashWithdrawal: 12_003,
    tradeBuyCash: 12_101,
    tradeSellCash: 12_102,
    tradeBuyQuantity: 12_103,
    tradeSellQuantity: 12_104,
    fee: 12_201,
    endingValuation: 12_301,
  },
  balancingRules: {
    version: 1,
    rules: [
      'USD and share quantities are journaled in separate TigerBeetle ledgers; every transfer balances within one ledger.',
      'Cash deposits debit cash and credit capital; withdrawals reverse that entry.',
      'Buy consideration credits cash and debits trade settlement; sells reverse that entry.',
      'Buy quantities debit the symbol position and credit its market account; sells reverse that entry.',
      'Fees debit fee expense and credit cash and are never folded into gross trade consideration.',
      'Ending position market values debit valuation assets and credit a valuation offset without changing cash.',
      'Cash and symbol position accounts prohibit credits exceeding debits, enforcing long-only/cash economics.',
      'Evaluator ending cash, positions, total fees, and equity must equal exact integer journal-derived values.',
      'Reconciliation compares every expected transfer plus immutable account fields and both posted balance sides.',
    ],
  },
} as const

export const ACCOUNT_HISTORY_FLAG = AccountFlags.history
export const NON_NEGATIVE_ASSET_FLAGS = AccountFlags.history | AccountFlags.credits_must_not_exceed_debits

export type BaynAccountCode =
  (typeof BAYN_ACCOUNTING_MODEL_V1.accountCodes)[keyof typeof BAYN_ACCOUNTING_MODEL_V1.accountCodes]

export type BaynTransferCode =
  (typeof BAYN_ACCOUNTING_MODEL_V1.transferCodes)[keyof typeof BAYN_ACCOUNTING_MODEL_V1.transferCodes]

export type BaynLedger = (typeof BAYN_ACCOUNTING_MODEL_V1.ledgers)[keyof typeof BAYN_ACCOUNTING_MODEL_V1.ledgers]

export const MAX_U128 = (1n << 128n) - 1n
