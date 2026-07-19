import { describe, expect, test } from 'bun:test'

import { BAYN_ACCOUNTING_MODEL_V1 } from './model'

describe('Bayn accounting model v1', () => {
  test('versions all numeric and balancing contracts', () => {
    expect(BAYN_ACCOUNTING_MODEL_V1).toMatchObject({
      schemaVersion: 'bayn.tigerbeetle-accounting.v1',
      evaluationSchemaVersion: 'bayn.evaluation-economics.v1',
      identifierVersion: 'bayn.sha256-u128.v1',
      reconciliationSchemaVersion: 'bayn.tigerbeetle-reconciliation.v1',
      modelVersion: 1,
      ledgers: { usdMicros: 11_001, shareE8: 11_002 },
      units: { usdMicros: { scale: 6 }, shareE8: { scale: 8 } },
      balancingRules: { version: 1 },
    })
    expect(new Set(Object.values(BAYN_ACCOUNTING_MODEL_V1.accountCodes)).size).toBe(
      Object.keys(BAYN_ACCOUNTING_MODEL_V1.accountCodes).length,
    )
    expect(new Set(Object.values(BAYN_ACCOUNTING_MODEL_V1.transferCodes)).size).toBe(
      Object.keys(BAYN_ACCOUNTING_MODEL_V1.transferCodes).length,
    )
    expect(Object.values(BAYN_ACCOUNTING_MODEL_V1.accountCodes).every((code) => code > 0 && code <= 65_535)).toBe(true)
    expect(Object.values(BAYN_ACCOUNTING_MODEL_V1.transferCodes).every((code) => code > 0 && code <= 65_535)).toBe(true)
    expect(
      Object.values(BAYN_ACCOUNTING_MODEL_V1.ledgers).every((ledger) => ledger > 0 && ledger <= 4_294_967_295),
    ).toBe(true)
    expect(BAYN_ACCOUNTING_MODEL_V1.balancingRules.rules.length).toBeGreaterThanOrEqual(9)
  })
})
