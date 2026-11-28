import { Result } from 'effect'

import { prepareAccounting } from '../accounting/domain'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { verifyNonTradeActivityStatement } from '../broker/alpaca/model'
import { OrderSide } from '../execution/contracts'
import { coinActivity } from '../forward-performance/coin-fee-episodes.test-support'
import type { confirmEquityFeeCash } from './equity-fee-cash'
import { testHash } from './fixtures.test-support'

const shift = (at: string, milliseconds: number) => new Date(Date.parse(at) + milliseconds).toISOString()

export const equityFeeCashFixture = (
  session: Parameters<typeof confirmEquityFeeCash>[0],
  accountId = 'fee-adjusted-paper-account',
  feeCount = 2,
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

  const receipts = Array.from({ length: feeCount }, (_, index) => {
    const activityId = `${session.sessionDate}::d7a201b7-679b-44d8-b76b-d352a25de73${index + 1}`
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
  const activities = receipts.map((receipt) => ({
    id: receipt.data.activityId,
    activity_type: 'FEE',
    date: receipt.data.date,
    net_amount: '-0.01',
  }))
  const pass = (body: typeof activities) =>
    [
      { pageToken: null, evidence: { ...scanEvidence, contentHash: testHash(body) }, body },
      {
        pageToken: body.at(-1)?.id ?? null,
        evidence: { ...scanEvidence, contentHash: testHash([]) },
        body: [],
      },
    ] as const
  const accountBody = { id: accountId }
  const statement = {
    schemaVersion: 'bayn.alpaca-non-trade-activity-statement.v2' as const,
    accountIdentityHash: identity.identityHash,
    observedAt: statementAt,
    window: { after: shift(openingAt, -1_000), until: shift(statementAt, -1_000) },
    accountBody,
    accountRead: { ...scanEvidence, contentHash: testHash(accountBody) },
    firstPass: pass(activities),
    secondPass: pass(activities.toReversed()),
  }
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
        observation: witness(shift(reconciledAt, -300), String(1_007_000_000 - receipts.length * 10_000)),
        reconciliationHash: testHash('post fee reconciliation'),
        fees: receipts.map((r) => ({
          activityId: r.data.activityId,
          sourceHash: r.content_hash,
          availableAt,
          postedAt,
        })),
      },
    ],
    statement: Result.getOrThrow(verifyNonTradeActivityStatement(statement, accountId)),
  }
  return { identity, accountHash, forward, evidence, receipts, openFill, closeFill, statementAt, statement }
}
