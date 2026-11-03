import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { prepareAccounting } from '../accounting/domain'
import { prepareFeeAccrual, type FeeAccrual } from '../accounting/fee-accrual'
import type { AccountingTransaction } from '../accounting/schema'
import { planAccountingReceipt } from '../db/execution-store/decisions'
import { AccountStatus, OrderSide, type AccountingReceipt, type Fill } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { checkProperty } from '../testing/property-test-support'
import { compareOpeningCash, verifyAccountingReceipts } from './algebra'

const accountId = 'partial-exit-account'
const observedAt = '2026-10-19T03:13:58.921Z'
const hash = (value: string) => Result.getOrThrow(canonicalHashV1Result({ value }))

const actualSales: readonly [string, string][] = [
  ['13982000000', '105300000000'],
  ['17734146248', '105300000000'],
  ['41805100000', '105227000000'],
  ['27943000000', '105300000000'],
]

const actualBuys: readonly [string, string][] = [
  ['94975780000', '105490000000'],
  ['41550000000', '105410000000'],
  ['3161474370', '105490000000'],
  ['697183700', '105429000000'],
  ['13921000000', '105400000000'],
  ['27890000000', '105400000000'],
]
const actualCohorts = [
  { buys: actualBuys, quantity: '181794608105', cost: '19170399376', at: '2026-10-19T03:12:44.159Z' },
]
const splitCohorts = [
  {
    buys: actualBuys.filter((_, index) => [0, 3, 4].includes(index)),
    quantity: '109352856980',
    cost: '11534340315',
    at: '2026-10-19T03:12:44.159Z',
  },
  {
    buys: actualBuys.filter((_, index) => [1, 2, 5].includes(index)),
    quantity: '181794608107',
    cost: '19170392797',
    at: '2026-10-19T03:12:45.159Z',
  },
]

const partialExit = (
  sales = actualSales,
  cohorts: readonly (typeof actualCohorts)[number][] = actualCohorts,
  reportedPosition?: { readonly costBasisMicros: string; readonly averageEntryPriceMicros: string },
) => {
  const transactions: AccountingTransaction[] = []
  const fills: Fill[] = []
  const receipts: AccountingReceipt[] = []
  const accruals: FeeAccrual[] = []
  let quantity = 0n
  let cost = 0n
  const append = (side: OrderSide, quantityAtoms: string, priceAtoms: string, occurredAt: string) => {
    const fill: Fill = {
      schemaVersion: 'bayn.fill.v2',
      accountId,
      fillId: `fill-${fills.length}`,
      brokerOrderId: `order-${side}`,
      clientOrderId: `client-${side}`,
      symbol: 'SOL/USD',
      side,
      quantityAtoms,
      priceAtoms,
      feeMicros: '0',
      occurredAt,
    }
    const prepared = Result.getOrThrow(
      prepareAccounting(
        hash(fill.fillId),
        fill,
        {
          quantityAtoms: String(quantity),
          costMicros: String(cost),
        },
        1,
      ),
    )
    fills.push(fill)
    transactions.push(prepared.transaction)
    receipts.push({ ...Result.getOrThrow(planAccountingReceipt(prepared, '1', 1)), recordedAt: observedAt })
    quantity += BigInt(prepared.transaction.quantityDeltaAtoms)
    cost += BigInt(prepared.transaction.costBasisDeltaMicros)
  }
  for (const cohort of cohorts) {
    const first = transactions.length
    for (const [qty, price] of cohort.buys) append(OrderSide.Buy, qty, price, '2026-10-19T03:12:40.233Z')
    const accrual = Result.getOrThrow(
      prepareFeeAccrual(
        {
          schemaVersion: 'bayn.broker-fee-accrual.v1',
          kind: 'COIN',
          accountId,
          symbol: 'SOL/USD',
          date: '2026-10-19',
          cycleId: hash('cycle'),
          observedAt: cohort.at,
          positionSnapshotId: hash(`position-snapshot-${first}`),
          projectedQuantityAtoms: String(quantity),
          observedQuantityAtoms: cohort.quantity,
          projectedCostMicros: String(cost),
          observedCostMicros: cohort.cost,
          sourceTrades: transactions
            .slice(first)
            .map(({ transactionId, quantityAtoms, priceAtoms }) => ({
              transactionId,
              quantityAtoms,
              priceAtoms,
            }))
            .sort((left, right) => left.transactionId.localeCompare(right.transactionId)),
        },
        1,
      ),
    )
    accruals.push(accrual.data)
    quantity = BigInt(cohort.quantity)
    cost = BigInt(cohort.cost)
  }
  for (const [qty, price] of sales) append(OrderSide.Sell, qty, price, '2026-10-19T03:13:18.921Z')
  const sourceProduct = transactions
    .filter((t) => t.side === OrderSide.Buy)
    .reduce((sum, t) => sum + BigInt(t.quantityAtoms) * BigInt(t.priceAtoms), 0n)
  const divisor = 182195438070n * 1_000_000_000_000n
  const reportedCost = (sourceProduct * quantity * 2n + divisor) / (divisor * 2n)
  const cashMicros = (
    100_000_000_000n + transactions.reduce((sum, t) => sum + BigInt(t.cashDeltaMicros), 0n)
  ).toString()
  const position = {
    schemaVersion: 'bayn.position.v2' as const,
    accountId,
    symbol: 'SOL/USD',
    quantityAtoms: String(quantity),
    averageEntryPriceMicros: '105450869',
    costBasisMicros: String(reportedCost),
    marketPriceMicros: '105300000',
    marketValueMicros: '8458787104',
    unrealizedPnlMicros: '-12119348',
    observedAt,
    ...reportedPosition,
  }
  const equityMicros = (BigInt(cashMicros) + BigInt(position.marketValueMicros)).toString()
  return {
    accountId,
    openingCash: { cash_micros: '100000000000', observed_at: '2026-10-19T03:00:00.000Z' },
    transactions,
    fillExecutionTimes: new Map<string, string>(),
    fees: [],
    brokerFeeAccruals: accruals,
    brokerFeeCashDeltaMicros: '0',
    cashReportingOffsetMicros: '0',
    cashSettlementDeltaMicros: '0',
    brokerCashSettlements: [],
    receipts,
    ledgerExact: true,
    intents: [],
    durableFills: fills.map((f) => ({ fillId: f.fillId, brokerOrderId: f.brokerOrderId, accounted: true })),
    projectedPositions: [{ symbol: position.symbol, quantityAtoms: String(quantity), costBasisMicros: String(cost) }],
    snapshot: {
      account: {
        schemaVersion: 'bayn.paper-account-snapshot.v2' as const,
        cryptoFeeTier: null,
        accountId,
        status: AccountStatus.Active,
        currency: 'USD' as const,
        cashMicros,
        equityMicros,
        buyingPowerMicros: cashMicros,
        observedAt,
      },
      cashReportingQuantumMicros: '1' as const,
      positions: [position],
      positionsObservedAt: observedAt,
      orders: [],
      ordersObservedAt: observedAt,
      fills,
      valuation: {
        schemaVersion: 'bayn.paper-valuation.v1' as const,
        accountId,
        valuationId: hash('valuation'),
        sourceHash: hash('source'),
        cashMicros,
        longMarketValueMicros: position.marketValueMicros,
        shortMarketValueMicros: '0',
        equityMicros,
        asOf: observedAt,
      },
      reconciledAt: observedAt,
    },
  }
}

test('reconciles the actual SOL partial-exit weighted basis without changing posted fill costs', () => {
  const input = partialExit()
  expect(input.snapshot.positions[0]?.quantityAtoms).toBe('80330361857')
  expect(input.snapshot.positions[0]?.costBasisMicros).toBe('8470906452')
  const accounting = Result.getOrThrow(
    verifyAccountingReceipts(input.transactions, input.receipts, {
      tigerBeetle: { clusterId: 1n, ledger: 1 },
    }),
  )
  expect([...accounting.exactReceipts.values()].every(Boolean)).toBe(true)
  const result = Result.getOrThrow(compareOpeningCash(input))
  expect(result.comparison.discrepancies).toEqual([])
  expect(input.projectedPositions[0]?.costBasisMicros).toBe('8470906453')
})

test('requires the complete entry and coin-debit evidence for partial-exit reporting', () => {
  const input = partialExit()
  const unsupported = [
    { ...input, brokerFeeAccruals: [] },
    { ...input, transactions: input.transactions.slice(1) },
    {
      ...input,
      brokerFeeAccruals: input.brokerFeeAccruals.map((a) =>
        a.kind === 'COIN' ? { ...a, observedCostMicros: '19170399375' } : a,
      ),
    },
    {
      ...input,
      projectedPositions: [{ symbol: 'SOL/USD', quantityAtoms: '80330361857', costBasisMicros: '8470906454' }],
    },
  ]
  for (const changed of unsupported) {
    expect(
      Result.getOrThrow(compareOpeningCash(changed)).comparison.discrepancies.some(
        (d) => d.identity === 'SOL/USD:cost',
      ),
    ).toBe(true)
  }
  const ledgerMismatch = Result.getOrThrow(compareOpeningCash({ ...input, ledgerExact: false }))
  expect(ledgerMismatch.comparison.metrics.accountingExact).toBe(false)
  const cashMismatch = Result.getOrThrow(
    compareOpeningCash({
      ...input,
      snapshot: {
        ...input.snapshot,
        account: { ...input.snapshot.account, cashMicros: String(BigInt(input.snapshot.account.cashMicros) - 1n) },
      },
    }),
  )
  expect(cashMismatch.comparison.metrics.cashDifferenceMicros).toBe('-1')
})

test('reproduces a nine-decimal broker average before rounding the remaining position basis', () => {
  const input = partialExit([['78451390064', '105300000000']])
  expect(input.projectedPositions[0]?.costBasisMicros).toBe('10897632132')
  const changed = {
    ...input,
    snapshot: {
      ...input.snapshot,
      positions: input.snapshot.positions.map((position) => ({
        ...position,
        costBasisMicros: '10897632131',
      })),
    },
  }
  expect(Result.getOrThrow(compareOpeningCash(changed)).comparison.discrepancies).toEqual([])
})

test.each([
  { cohorts: splitCohorts, cost: '10025466544', average: '105450833', nativeCost: '10025466543' },
  {
    cohorts: [
      { buys: actualBuys.slice(0, 3), quantity: '139379942411', cost: '14699873438', at: '2026-10-19T03:12:44.159Z' },
      { buys: actualBuys.slice(3), quantity: '181794608107', cost: '19170394666', at: '2026-10-19T03:12:45.159Z' },
    ],
    cost: '10025467521',
    average: '105450843',
    nativeCost: '10025467522',
  },
])(
  'carries earlier observed coin fees when later IOC fills arrive in another reconciliation: $average',
  ({ cohorts, cost, average, nativeCost }) => {
    const input = partialExit(
      ['31976639476', '21085846470', '26143673352', '7516022243'].map((qty): [string, string] => [qty, '105300000000']),
      cohorts,
      { costBasisMicros: cost, averageEntryPriceMicros: average },
    )
    expect(input.projectedPositions[0]).toMatchObject({ quantityAtoms: '95072426566', costBasisMicros: nativeCost })
    expect(Result.getOrThrow(compareOpeningCash(input)).comparison.discrepancies).toEqual([])
    const missingPriorCohort = { ...input, brokerFeeAccruals: input.brokerFeeAccruals.slice(1) }
    expect(
      Result.getOrThrow(compareOpeningCash(missingPriorCohort)).comparison.discrepancies.some(
        (d) => d.identity === 'SOL/USD:cost',
      ),
    ).toBe(true)
  },
)

test('property: multiple coin-fee cohorts preserve the acquisition average through partial disposals', () => {
  checkProperty(
    'partial-position-cost-cohorts',
    fc.property(
      fc.array(fc.bigInt({ min: 10_000n, max: 40_000_000_000n }), { minLength: 4, maxLength: 4 }),
      (quantities) => {
        const quantity = 181794608107n - quantities.reduce((sum, value) => sum + value, 0n)
        const denominator = 3988219277005934399n * 1_000_000_000_000n
        const reportedCost = (420561043566276145686352800000n * quantity * 2n + denominator) / (denominator * 2n)
        const input = partialExit(
          quantities.map((qty): [string, string] => [String(qty), '105300000000']),
          splitCohorts,
          { costBasisMicros: String(reportedCost), averageEntryPriceMicros: '105450833' },
        )
        expect(Result.getOrThrow(compareOpeningCash(input)).comparison.discrepancies).toEqual([])
      },
    ),
  )
})

test('property: partial fill rounding preserves exact quantity and rejects unexplained broker costs', () => {
  checkProperty(
    'partial-position-cost-reporting',
    fc.property(
      fc.array(fc.bigInt({ min: 10_000n, max: 40_000_000_000n }), { minLength: 4, maxLength: 4 }),
      (quantities) => {
        const input = partialExit(quantities.map((q): [string, string] => [String(q), '105300000000']))
        expect(Result.getOrThrow(compareOpeningCash(input)).comparison.discrepancies).toEqual([])
        for (const position of input.snapshot.positions) {
          const quantity = BigInt(position.quantityAtoms)
          const known = new Set([
            position.costBasisMicros,
            input.projectedPositions[0]?.costBasisMicros,
            String((BigInt(position.averageEntryPriceMicros) * quantity + 500_000_000n) / 1_000_000_000n),
            String((105_450_868_843n * quantity + 500_000_000_000n) / 1_000_000_000_000n),
          ])
          const reportedAtNineDecimals = {
            ...input,
            snapshot: {
              ...input.snapshot,
              positions: [
                {
                  ...position,
                  costBasisMicros: String((105_450_868_843n * quantity + 500_000_000_000n) / 1_000_000_000_000n),
                },
              ],
            },
          }
          expect(Result.getOrThrow(compareOpeningCash(reportedAtNineDecimals)).comparison.discrepancies).toEqual([])
          for (const offset of [-1n, 1n]) {
            const changedCost = String(BigInt(position.costBasisMicros) + offset)
            if (known.has(changedCost)) continue
            const changed = {
              ...input,
              snapshot: { ...input.snapshot, positions: [{ ...position, costBasisMicros: changedCost }] },
            }
            expect(
              Result.getOrThrow(compareOpeningCash(changed)).comparison.discrepancies.some(
                (d) => d.identity === 'SOL/USD:cost',
              ),
            ).toBe(true)
          }
          const changed = {
            ...input,
            snapshot: { ...input.snapshot, positions: [{ ...position, quantityAtoms: String(quantity + 1n) }] },
          }
          expect(
            Result.getOrThrow(compareOpeningCash(changed)).comparison.discrepancies.some(
              (d) => d.identity === 'SOL/USD:quantity',
            ),
          ).toBe(true)
        }
      },
    ),
  )
})
