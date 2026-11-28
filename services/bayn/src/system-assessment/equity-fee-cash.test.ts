import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { intradayExecutionModel } from '../strategy/intraday-market'
import { markedRisk } from './economics'
import { confirmEquityFeeCash, projectFeeAdjustedCash } from './equity-fee-cash'
import { equityFeeCashFixture } from './equity-fee-cash.test-support'
import { testHash } from './fixtures.test-support'
import { accountMarkValue } from './valuation'

const session = {
  sessionDate: '2026-11-19',
  openAt: '2026-11-19T13:00:00.000Z',
  closeAt: '2026-11-19T22:00:00.000Z',
  recoveryCloseAt: '2026-11-20T01:00:00.000Z',
} as const
const { evidence, forward, accountHash, openFill, closeFill, receipts, statementAt } = equityFeeCashFixture(session)

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
    { ...evidence, asOf: session.recoveryCloseAt },
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

test.each(['2026-09-29', '2027-01-04'] as const)('requires receipted TAF and verifies its cash prefix on %s', (day) => {
  const tradingSession = {
    sessionDate: day,
    openAt: `${day}T14:30:00.000Z`,
    closeAt: `${day}T21:00:00.000Z`,
    recoveryCloseAt: `${day}T23:00:00.000Z`,
  } as const
  const { accountHash, evidence, forward, openFill, closeFill } = equityFeeCashFixture(tradingSession, undefined, 3)
  const verify = (model = intradayExecutionModel, ledger = forward, inputs = evidence) =>
    Result.getOrThrow(confirmEquityFeeCash(tradingSession, accountHash, model, ledger, inputs))

  expect(verify()?.points).toEqual([
    { at: openFill, tradeCashDeltaMicros: '-100000000', incurredFeesMicros: '10000' },
    { at: closeFill, tradeCashDeltaMicros: '7000000', incurredFeesMicros: '30000' },
  ])

  const unpaid = equityFeeCashFixture(tradingSession)
  expect(verify(intradayExecutionModel, unpaid.forward, unpaid.evidence)).toBeNull()

  const possibleCap = {
    ...intradayExecutionModel,
    fees: { ...intradayExecutionModel.fees, tafMaximumPerOrderMicros: '194' },
  } as const
  expect(verify(possibleCap)).toBeNull()
})
