import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { prepareAccounting } from '../accounting/domain'
import { planAccountingReceipt } from '../db/execution-store/decisions'
import { OrderSide } from '../execution/contracts'
import { testHash } from './fixtures.test-support'
import { verifyRetainedAccountLedgerPrefix } from './accounting-source'

test('rejects an accounting receipt whose deterministic identity differs from its transaction', () => {
  const accountId = 'paper-account'
  const occurredAt = '2026-11-20T20:00:00.000Z'
  const prepared = Result.getOrThrow(
    prepareAccounting(
      testHash('accounting source receipt event'),
      {
        schemaVersion: 'bayn.fill.v2',
        accountId,
        fillId: 'accounting-source-fill',
        brokerOrderId: 'accounting-source-order',
        clientOrderId: 'accounting-source-client-order',
        symbol: 'AAPL',
        side: OrderSide.Buy,
        quantityAtoms: '1000000000',
        priceAtoms: '100000000000',
        feeMicros: '0',
        occurredAt,
      },
      { quantityAtoms: '0', costMicros: '0' },
      7001,
    ),
  )
  const receipt = {
    ...Result.getOrThrow(planAccountingReceipt(prepared, '2001', 7001)),
    recordedAt: occurredAt,
  }
  const input = {
    accountId,
    asOf: '2026-11-20T20:01:00.000Z',
    retainedTransactions: [prepared.transaction],
    durableTransactions: [prepared.transaction],
    durableReceipts: [receipt],
    retainedCashSettlements: [],
    durableCashSettlements: [],
  }

  expect(Result.isSuccess(verifyRetainedAccountLedgerPrefix(input))).toBe(true)
  expect(
    Result.isFailure(
      verifyRetainedAccountLedgerPrefix({
        ...input,
        durableReceipts: [{ ...receipt, receiptId: testHash('forged accounting receipt identity') }],
      }),
    ),
  ).toBe(true)
})
