import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { prepareAccounting } from '../accounting/domain'
import { OrderSide } from '../execution/contracts'
import { coinActivity } from '../forward-performance/coin-fee-episodes.test-support'
import type { ForwardPerformanceEvidenceInput } from '../forward-performance/model'
import { intradayExecutionModel } from '../strategy/intraday-market'
import { markedRisk } from './economics'
import { confirmEquityFeeCash, projectFeeAdjustedCash } from './equity-fee-cash'
import { testHash } from './fixtures.test-support'
import { accountMarkValue } from './valuation'

const session = {
  sessionDate: '2026-11-19',
  openAt: '2026-11-19T13:00:00.000Z',
  closeAt: '2026-11-19T22:00:00.000Z',
} as const
const openFill = '2026-11-19T15:02:14.784Z'
const closeFill = '2026-11-19T20:58:28.770Z'
const accountId = 'fee-adjusted-paper-account'
const accountHash = testHash(accountId)
const brokerHash = testHash('broker identity')
const availableAt = '2026-11-20T09:28:31.827Z'
const postedAt = '2026-11-20T09:28:37.394165Z'
const reconciledAt = '2026-11-20T09:29:36.309Z'
const statementAt = '2026-11-20T13:00:00.000Z'
const read = { requestId: 'paper read', status: 200 as const, contentHash: testHash('read'), observedAt: availableAt }

const fills = [
  { side: OrderSide.Buy, priceAtoms: '100000000000', at: openFill },
  { side: OrderSide.Sell, priceAtoms: '107000000000', at: closeFill },
].map(
  ({ side, priceAtoms, at }, index) =>
    Result.getOrThrow(
      prepareAccounting(
        testHash(['economic cash', index]),
        {
          schemaVersion: 'bayn.fill.v2',
          accountId,
          intentId: testHash(['intent', index]),
          fillId: `fill-${index}`,
          brokerOrderId: `order-${index}`,
          clientOrderId: `client-${index}`,
          symbol: 'AAPL',
          side,
          quantityAtoms: '1000000000',
          priceAtoms,
          feeMicros: '0',
          occurredAt: at,
        },
        side === OrderSide.Buy
          ? { quantityAtoms: '0', costMicros: '0' }
          : { quantityAtoms: '1000000000', costMicros: '100000000' },
        7001,
      ),
    ).transaction,
)

const receipts = ['SEC', 'CAT'].map((activityId) => ({
  ...coinActivity('1', accountId),
  data: { accountId, activityId, date: session.sessionDate, netAmountMicros: '-10000' },
  coin_cost_basis_micros: null,
  content_hash: testHash(activityId),
  read_evidence: read,
}))

const forward: ForwardPerformanceEvidenceInput = {
  account: { accountId, accountReferenceHash: accountHash, provider: 'alpaca', environment: 'sandbox' },
  runtime: {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.example/bayn',
    imageDigest: `sha256:${testHash('image')}`,
  },
  durableExecutionBindings: [],
  cycles: [],
  transactions: [],
  accountTransactions: fills,
  accountPositionCounts: { postgres: 0, ledger: 0, reconciledAt, exact: true },
  accountCashSettlements: [],
  accountFeeAccruals: [],
  accountBrokerFees: receipts,
  cashYieldEvidenceRequired: false,
  accountingReceiptsExact: true,
  ledgerExact: true,
  missingLedgerAccountCount: 0,
  unresolvedMutationCount: 0,
  unclosedCycleCount: 0,
  openPositionCount: 0,
}

const witness = (at: string, cashMicros: string) => ({
  at,
  availableAt: at,
  cashMicros,
  sourceHash: testHash(at),
  positions: { at, count: 0, sourceHash: testHash({ at }) },
})
const evidence: Parameters<typeof confirmEquityFeeCash>[4] = {
  asOf: statementAt,
  accountIdentityHash: brokerHash,
  anchors: [
    {
      sessionDate: session.sessionDate,
      phase: 'OPENING',
      cutAt: session.openAt,
      observation: witness('2026-11-19T12:59:46.129Z', '1000000000'),
      reconciliationHash: null,
      fees: [],
    },
    {
      sessionDate: session.sessionDate,
      phase: 'RECOVERY',
      cutAt: '2026-11-20T01:00:00.000Z',
      observation: witness('2026-11-20T00:59:03.136Z', '1007000000'),
      reconciliationHash: null,
      fees: [],
    },
    {
      sessionDate: session.sessionDate,
      phase: 'RECONCILED',
      cutAt: reconciledAt,
      observation: witness('2026-11-20T09:29:33.141Z', '1006980000'),
      reconciliationHash: testHash('post fee reconciliation'),
      fees: receipts.map((r) => ({ activityId: r.data.activityId, sourceHash: r.content_hash, availableAt, postedAt })),
    },
  ],
  statement: {
    schemaVersion: 'bayn.alpaca-non-trade-activity-statement.v1',
    accountIdentityHash: brokerHash,
    observedAt: statementAt,
    window: { after: '2026-11-19T12:59:45.000Z', until: '2026-11-20T12:59:59.000Z' },
    accountRead: read,
    firstPass: [],
    secondPass: [],
    activities: receipts.map((r) => ({
      activityId: r.data.activityId,
      activityType: 'FEE',
      date: r.data.date,
      netAmount: '-0.01',
      createdAt: null,
    })),
  },
}

const confirm = (input = evidence, ledger = forward) =>
  Result.getOrThrow(confirmEquityFeeCash(session, accountHash, intradayExecutionModel, ledger, input))

test('charges fees as each fill is incurred and keeps terminal P&L and risk consistent', () => {
  const proof = confirm()
  if (proof === null) throw new Error('Expected exact fee-adjusted cash')
  expect(proof.points).toEqual([
    { at: openFill, tradeCashDeltaMicros: '-100000000', incurredFeesMicros: '10000' },
    { at: closeFill, tradeCashDeltaMicros: '7000000', incurredFeesMicros: '20000' },
  ])
  const marks: Parameters<typeof projectFeeAdjustedCash>[0] = [
    { at: session.openAt, cashMicros: null, positions: [] },
    {
      at: openFill,
      cashMicros: '900000000',
      positions: [
        {
          symbol: 'AAPL',
          quantityAtoms: '1000000000',
          bidPriceMicros: '96000000',
          costBasisMicros: '100000000',
          quoteSourceHash: testHash('executable quote'),
        },
      ],
    },
    { at: session.closeAt, cashMicros: '1007000000', positions: [] },
  ].map(({ positions, ...row }) => ({
    ...row,
    accountBindingHash: accountHash,
    availableAt: statementAt,
    sourceHash: testHash(row),
    valuation: { inventorySourceHash: testHash('positions'), positions },
  }))
  const adjusted = Result.getOrThrow(projectFeeAdjustedCash(marks, proof))
  expect(adjusted.map((mark) => mark.cashMicros)).toEqual(['1000000000', '899990000', '1006980000'])
  const equity = adjusted.map((mark) => BigInt(accountMarkValue(mark)!.equityMicros))
  expect(markedRisk(equity)).toEqual({ maximumDrawdownMicros: '4010000', maximumSessionLossMicros: '4010000' })
  expect(equity[2]! - equity[0]!).toBe(6980000n)
  expect(marks[1]?.cashMicros).toBe('900000000')
  expect(
    Result.getOrThrow(
      projectFeeAdjustedCash(
        marks.map((m) => ({ ...m, cashMicros: '0' })),
        proof,
      ),
    ),
  ).toEqual([])
})

test('requires complete authentic scope, exact independent postings, and a move-free equity session', () => {
  const { statement, anchors } = evidence
  const activities = statement.activities
  const variants: (typeof evidence)[] = [
    { ...evidence, asOf: '2026-11-20T08:00:00.000Z' },
    { ...evidence, accountIdentityHash: testHash('another account') },
    { ...evidence, statement: { ...statement, activities: activities.slice(1) } },
    { ...evidence, statement: { ...statement, activities: [...activities, activities[0]!] } },
    {
      ...evidence,
      statement: {
        ...statement,
        activities: [
          ...activities,
          {
            activityId: 'offsetting-deposit',
            activityType: 'CSD',
            date: session.sessionDate,
            createdAt: null,
            netAmount: '0.01',
          },
        ],
      },
    },
    {
      ...evidence,
      anchors: anchors.map((row) => ({ ...row, fees: row.fees.map((fee) => ({ ...fee, availableAt: closeFill })) })),
    },
    {
      ...evidence,
      anchors: anchors.map((row) =>
        row.phase === 'RECOVERY' ? { ...row, observation: { ...row.observation!, cashMicros: '1006990000' } } : row,
      ),
    },
    {
      ...evidence,
      anchors: anchors.map((row) =>
        row.phase === 'RECONCILED' ? { ...row, observation: { ...row.observation!, cashMicros: '1006980001' } } : row,
      ),
    },
  ]
  for (const changed of variants) expect(confirm(changed)).toBeNull()
  expect(confirm(evidence, { ...forward, accountBrokerFees: receipts.slice(1) })).toBeNull()
  const oldFee = receipts[0]!
  expect(
    confirm(evidence, {
      ...forward,
      accountBrokerFees: [
        ...receipts,
        {
          ...oldFee,
          posted: false,
          data: { ...oldFee.data, activityId: 'earlier unpaid fee', date: '2026-11-18' },
        },
      ],
    }),
  ).toBeNull()
  expect(confirm(evidence, { ...forward, ledgerExact: false })).toBeNull()
})
