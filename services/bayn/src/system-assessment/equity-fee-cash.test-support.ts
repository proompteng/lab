import { Result } from 'effect'

import { prepareAccounting } from '../accounting/domain'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { OrderSide } from '../execution/contracts'
import { coinActivity } from '../forward-performance/coin-fee-episodes.test-support'
import type { confirmEquityFeeCash } from './equity-fee-cash'
import { testHash } from './fixtures.test-support'

const shift = (at: string, milliseconds: number) => new Date(Date.parse(at) + milliseconds).toISOString()

export const equityFeeCashFixture = (
  session: Parameters<typeof confirmEquityFeeCash>[0],
  accountId = 'fee-adjusted-paper-account',
) => {
  const openFill = shift(session.openAt, 30_000)
  const closeFill = shift(session.closeAt, -30_000)
  const availableAt = shift(session.recoveryCloseAt, 60_000)
  const postedAt = shift(availableAt, 1000).replace('Z', '165Z')
  const reconciledAt = shift(availableAt, 2_000)
  const statementAt = shift(reconciledAt, 60_000)
  const identity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      accountId,
      environment: BrokerEnvironment.Sandbox,
      provider: BrokerProvider.Alpaca,
    }),
  )
  const accountHash = testHash({ schemaVersion: 'bayn.inference-cost-account.v1', accountId })
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

  const receipts = [1, 2].map((index) => {
    const activityId = `${session.sessionDate}::d7a201b7-679b-44d8-b76b-d352a25de73${index}`
    return {
      ...coinActivity('1', accountId),
      data: { accountId, activityId, date: session.sessionDate, netAmountMicros: '-10000' },
      coin_cost_basis_micros: null,
      content_hash: testHash(activityId),
      read_evidence: read,
    }
  })
  const forward: Parameters<typeof confirmEquityFeeCash>[3] = {
    account: { accountId },
    accountTransactions: fills,
    accountPositionCounts: { reconciledAt, exact: true },
    accountCashSettlements: [],
    accountFeeAccruals: [],
    accountBrokerFees: receipts,
    accountingReceiptsExact: true,
    ledgerExact: true,
    missingLedgerAccountCount: 0,
    unresolvedMutationCount: 0,
  }
  const witness = (at: string, cashMicros: string) => ({
    at,
    availableAt: at,
    cashMicros,
    sourceHash: testHash(at),
    positions: { at, count: 0, sourceHash: testHash({ at }) },
  })
  const openingAt = shift(session.openAt, -10_000)
  const recoveryAt = shift(session.recoveryCloseAt, -10_000)
  const scanEvidence = { ...read, observedAt: statementAt }
  const pass = (activityIds: string[]) =>
    [
      { pageToken: null, evidence: scanEvidence, activityIds },
      { pageToken: activityIds.at(-1) ?? null, evidence: scanEvidence, activityIds: [] },
    ] as const
  const activities = receipts.map((receipt) => ({
    activityId: receipt.data.activityId,
    activityType: 'FEE',
    date: receipt.data.date,
    netAmount: '-0.01',
    createdAt: null,
  }))
  const ids = activities.map((row) => row.activityId)
  const evidence: Parameters<typeof confirmEquityFeeCash>[4] = {
    asOf: statementAt,
    accountIdentityHash: identity.identityHash,
    anchors: [
      {
        sessionDate: session.sessionDate,
        phase: 'OPENING',
        cutAt: session.openAt,
        observation: witness(openingAt, '1000000000'),
        reconciliationHash: null,
        fees: [],
      },
      {
        sessionDate: session.sessionDate,
        phase: 'RECOVERY',
        cutAt: session.recoveryCloseAt,
        observation: witness(recoveryAt < session.closeAt ? session.closeAt : recoveryAt, '1007000000'),
        reconciliationHash: null,
        fees: [],
      },
      {
        sessionDate: session.sessionDate,
        phase: 'RECONCILED',
        cutAt: reconciledAt,
        observation: witness(shift(reconciledAt, -300), '1006980000'),
        reconciliationHash: testHash('post fee reconciliation'),
        fees: receipts.map((r) => ({
          activityId: r.data.activityId,
          sourceHash: r.content_hash,
          availableAt,
          postedAt,
        })),
      },
    ],
    statement: {
      schemaVersion: 'bayn.alpaca-non-trade-activity-statement.v1',
      accountIdentityHash: identity.identityHash,
      observedAt: statementAt,
      window: { after: shift(openingAt, -1_000), until: shift(statementAt, -1_000) },
      accountRead: scanEvidence,
      firstPass: pass(ids),
      secondPass: pass(ids.toReversed()),
      activities,
    },
  }
  return { identity, accountHash, forward, evidence, receipts, openFill, closeFill, statementAt }
}
