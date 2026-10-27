import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { brokerFeeLedgerPlan } from '../accounting/domain'
import { prepareFeeAccrual } from '../accounting/fee-accrual'
import { prepareFeeMatchCorrection, verifyBrokerFeeRecord, type StoredBrokerFee } from '../accounting/broker-fees'
import { prepareCashSettlement } from '../accounting/cash-settlement'
import { hashLedgerPlanResult } from '../ledger-plan'
import { captureCashHistory as captureHistory, cashChangesAt } from './cash-history'

import type { ForwardPerformanceEvidenceInput } from '../forward-performance/model'
import { JevResearchPolicy } from '../jev/acceptance'
import { captureForwardFinancialEvidence } from './forward-evidence'
import { registrationFixture, testHash } from './fixtures.test-support'
import { coinRoundTrip, coinActivity } from '../forward-performance/coin-fee-episodes.test-support'

const captureCashHistory = (forward: ForwardPerformanceEvidenceInput) =>
  captureHistory(forward, '2026-09-18T00:00:00.000Z')

const fixture = (policy: JevResearchPolicy) => {
  const accountId = `financial-${policy}`
  const registration = registrationFixture()
  const definition = registration.policies.find((definition) => definition.policy === policy)
  if (definition === undefined) throw new Error('Missing financial policy fixture')
  const updated = {
    ...definition,
    accountBindingHash: testHash({ schemaVersion: 'bayn.inference-cost-account.v1', accountId }),
  }
  const first = registration.calendar.sessions[0]
  const last = registration.calendar.sessions.at(-1)
  if (first === undefined || last === undefined) throw new Error('Missing financial calendar fixture')
  const forward: ForwardPerformanceEvidenceInput = {
    runtime: {
      sourceRevision: definition.sourceRevision,
      imageRepository: 'registry.example.test/bayn',
      imageDigest: `sha256:${definition.imageDigest}`,
    },
    account: { accountId, accountReferenceHash: testHash(accountId), provider: 'alpaca', environment: 'sandbox' },
    durableExecutionBindings: [],
    cycles: [],
    reconciliation: {
      reconciliationId: testHash('reconciliation'),
      contentHash: testHash('reconciliation content'),
      status: 'EXACT',
      performanceExact: true,
      cashYieldAdjustedExact: false,
      reconciledAt: last.closeAt,
    },
    accountTransactions: [],
    accountCashSettlements: [],
    transactions: [],
    accountingReceiptsExact: true,
    ledgerExact: true,
    missingLedgerAccountCount: 0,
    cashYieldEvidenceRequired: false,
    unresolvedMutationCount: 0,
    unclosedCycleCount: 0,
    openPositionCount: 0,
    accountPositionCounts: { postgres: 0, ledger: 0, reconciledAt: last.closeAt, exact: true },
    accountFeeAccruals: [],
    accountBrokerFees: [],
    brokerFeeAccruals: [],
    brokerFees: [
      { accountId, activityId: 'synthetic-account-charge', date: first.sessionDate, netAmountMicros: '-3000000' },
    ],
  }
  return {
    forward,
    registration: {
      ...registration,
      policies: registration.policies.map((definition) => (definition.policy === policy ? updated : definition)),
    },
  }
}

const cashSettlements = (fills: ReturnType<typeof coinRoundTrip>['fills']) =>
  fills.map((trade) => {
    const prepared = Result.getOrThrow(
      prepareCashSettlement(
        {
          schemaVersion: 'bayn.broker-cash-settlement.v1',
          accountId: trade.accountId,
          transactionId: trade.transactionId,
          transactionContentHash: trade.contentHash,
          brokerEventId: trade.brokerEventId,
          cashDeltaMicros: trade.cashDeltaMicros,
          occurredAt: trade.occurredAt,
          observedAt: trade.occurredAt,
          precisionAccountEventId: testHash('cash precision'),
          cashReportingQuantumMicros: '10000',
        },
        7001,
      ),
    )
    return {
      settlement_id: prepared.settlementId,
      data: prepared.data,
      content_hash: prepared.contentHash,
      rounding_delta_micros: prepared.roundingDeltaMicros,
      ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(prepared.plan)),
      tigerbeetle_cluster_id: '2001',
      tigerbeetle_ledger: 7001,
      posted: true,
    }
  })

describe('registered financial capture', () => {
  test('cash capture retains rounded settlement deltas once and rejects missing or conflicting source records', () => {
    const { forward } = fixture(JevResearchPolicy.Candidate)
    const { fills } = coinRoundTrip(0, forward.account.accountId)
    const settlements = cashSettlements(fills)
    const observed = { ...forward, accountTransactions: fills, accountCashSettlements: settlements }
    const captured = Result.getOrThrow(captureCashHistory(observed))
    if (captured === null) throw new Error('Expected complete cash history')
    expect(captured.changes).toHaveLength(2)
    const expected = fills.reduce(
      (sum, trade, index) =>
        sum + BigInt(trade.cashDeltaMicros) + BigInt(settlements[index]?.rounding_delta_micros ?? '0'),
      0n,
    )
    expect(cashChangesAt(captured, '2026-09-18T16:00:00.000Z')).toBe(expected)
    expect(captured.changes[1]?.amountMicros).toBe('3300000')
    const sell = fills[1]
    if (sell === undefined) throw new Error('Missing synthetic sell')
    const preparedAccrual = Result.getOrThrow(
      prepareFeeAccrual(
        {
          schemaVersion: 'bayn.broker-fee-accrual.v2',
          kind: 'CASH',
          accountId: sell.accountId,
          symbol: 'USD',
          date: '2026-09-18',
          cycleId: testHash('fee cycle'),
          accountEventId: testHash('fee account event'),
          openingAccountEventId: testHash('fee opening'),
          openingCashReportingQuantumMicros: '10000',
          observedAt: '2026-09-18T15:31:00.000Z',
          projectedCashMicros: '100000000',
          observedCashMicros: '99990000',
          cashReportingQuantumMicros: '10000',
          sourceTrades: [
            { transactionId: sell.transactionId, quantityAtoms: sell.quantityAtoms, priceAtoms: sell.priceAtoms },
          ],
        },
        7001,
      ),
    )
    const cashAccrual = {
      accrual_id: preparedAccrual.accrualId,
      data: preparedAccrual.data,
      settlement_date: '2026-09-18' as const,
      content_hash: preparedAccrual.contentHash,
      coin_quantity_atoms: preparedAccrual.coinQuantityAtoms,
      cash_debit_micros: preparedAccrual.cashDebitMicros,
      expense_micros: preparedAccrual.expenseMicros,
      matched_coin_quantity_atoms: '0',
      matched_cash_micros: '10000',
      ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(preparedAccrual.plan)),
      tigerbeetle_cluster_id: '2001',
      tigerbeetle_ledger: 7001,
      posted: true,
    }
    const base = coinActivity('82625', sell.accountId)
    const feeData: StoredBrokerFee['data'] = {
      accountId: sell.accountId,
      activityId: 'cash-settlement',
      date: base.data.date,
      cryptoCashFee: true,
      netAmountMicros: '-9000',
    }
    const fee: StoredBrokerFee = {
      ...base,
      data: feeData,
      matched_cash_micros: '10000',
      coin_cost_basis_micros: null,
      content_hash: testHash({ schemaVersion: 'bayn.broker-fee.v1', ...feeData }),
      ledger_plan_hash: Result.getOrThrow(
        hashLedgerPlanResult(brokerFeeLedgerPlan(sell.accountId, feeData.activityId, '1000', 7001)),
      ),
    }
    const correction = Result.getOrThrow(
      prepareFeeMatchCorrection(
        {
          schemaVersion: 'bayn.fee-match-correction.v2',
          accountId: sell.accountId,
          activityId: fee.data.activityId,
          accrualId: cashAccrual.accrual_id,
          feeContentHash: fee.content_hash,
          activityCashMicros: '9000',
          accrualCashMicros: '10000',
          readEvidence: fee.read_evidence,
        },
        7001,
      ),
    )
    const correctedFee = {
      ...fee,
      cash_match_corrections: [
        {
          correction_id: correction.correctionId,
          data: correction.data,
          content_hash: correction.contentHash,
          ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(correction.plan)),
          tigerbeetle_cluster_id: '2001',
          tigerbeetle_ledger: 7001,
          posted: true,
        },
      ],
    }
    expect(
      Result.getOrThrow(verifyBrokerFeeRecord(correctedFee, sell.accountId, { clusterId: 2001n, ledger: 7001 }))
        .cashDeltaMicros,
    ).toBe('0')
    const feeObserved = { ...observed, accountFeeAccruals: [cashAccrual], accountBrokerFees: [correctedFee] }
    const fees = Result.getOrThrow(captureCashHistory(feeObserved))
    if (fees === null) throw new Error('Expected captured fee history')
    expect(fees.changes).toHaveLength(3)
    expect(cashChangesAt(fees, '2026-09-18T15:30:03.000Z')).toBeNull()
    expect(cashChangesAt(fees, '2026-09-18T16:00:00.000Z')).toBe(expected - 10000n)
    expect(
      Result.getOrThrow(captureCashHistory({ ...feeObserved, accountBrokerFees: [correctedFee, correctedFee] })),
    ).toBeNull()
    expect(
      Result.getOrThrow(captureCashHistory({ ...feeObserved, accountFeeAccruals: [cashAccrual, cashAccrual] })),
    ).toBeNull()
    expect(
      Result.getOrThrow(
        captureCashHistory({ ...feeObserved, accountFeeAccruals: [{ ...cashAccrual, posted: false }] }),
      ),
    ).toBeNull()

    const laterFeeData: StoredBrokerFee['data'] = {
      accountId: sell.accountId,
      activityId: 'later-posted-fee',
      date: '2026-09-19',
      netAmountMicros: '-1000',
    }
    const laterFee: StoredBrokerFee = {
      ...base,
      data: laterFeeData,
      coin_cost_basis_micros: null,
      content_hash: testHash({ schemaVersion: 'bayn.broker-fee.v1', ...laterFeeData }),
      ledger_plan_hash: Result.getOrThrow(
        hashLedgerPlanResult(brokerFeeLedgerPlan(sell.accountId, laterFeeData.activityId, '-1000', 7001)),
      ),
      read_evidence: { ...base.read_evidence, observedAt: '2026-09-19T16:00:00.000Z' },
    }
    expect(Result.isSuccess(verifyBrokerFeeRecord(laterFee, sell.accountId, { clusterId: 2001n, ledger: 7001 }))).toBe(
      true,
    )
    const laterHistory = Result.getOrThrow(captureCashHistory({ ...observed, accountBrokerFees: [laterFee] }))
    if (laterHistory === null) throw new Error('Missing later fee fixture')
    expect(cashChangesAt(laterHistory, '2026-09-18T16:00:00.000Z')).toBeNull()
    expect(cashChangesAt(laterHistory, '2026-09-19T16:00:00.000Z')).toBe(expected - 1000n)
    for (const invalid of [
      { ...observed, accountCashSettlements: [] },
      { ...observed, accountCashSettlements: [...settlements, ...settlements] },
      { ...observed, accountTransactions: [...fills, ...fills] },
      { ...observed, ledgerExact: false },
      { ...observed, accountCashSettlements: settlements.map((s) => ({ ...s, posted: false })) },
      {
        ...observed,
        accountCashSettlements: settlements.map((s) => ({
          ...s,
          data: { ...s.data, transactionContentHash: testHash('wrong') },
        })),
      },
      {
        ...observed,
        accountCashSettlements: settlements.map((s) => ({
          ...s,
          data: { ...s.data, occurredAt: '2026-09-18T16:00:00.000Z' },
        })),
      },
    ])
      expect(Result.getOrThrow(captureCashHistory(invalid))).toBeNull()
  })

  test('a coin fee closes the actual inventory without leaving a phantom fractional position', () => {
    const { registration, forward } = fixture(JevResearchPolicy.Candidate)
    const first = registration.calendar.sessions[0]
    if (first === undefined) throw new Error('Missing first session')
    const { fills, accrual } = coinRoundTrip(0, forward.account.accountId, testHash('cycle'), {
      sourceDate: first.sessionDate,
    })
    const observed = {
      ...forward,
      accountTransactions: fills,
      accountCashSettlements: cashSettlements(fills),
      transactions: fills.map((fill) => ({ ...fill, cycleId: testHash('cycle') })),
      accountFeeAccruals: [accrual],
      brokerFeeAccruals: [
        {
          accrualId: accrual.accrual_id,
          accountId: forward.account.accountId,
          expenseMicros: accrual.expense_micros,
          settled: false,
        },
      ],
      executionEvidence: fills.map((fill) => ({
        cycleId: testHash('cycle'),
        decisionDocumentHash: testHash('document'),
        decisionHash: testHash('decision'),
        decisionCreatedAt: fill.occurredAt,
        intentId: fill.intentId ?? testHash('intent'),
        accountId: fill.accountId,
        symbol: fill.symbol,
        side: fill.side,
        fills: [
          {
            ...fill,
            fillId: fill.brokerEventId,
            brokerOrderId: 'order',
            clientOrderId: 'client',
            intentId: fill.intentId ?? testHash('intent'),
            sourceTimestamp: fill.occurredAt,
            observedAt: fill.occurredAt,
          },
        ],
      })),
    }
    const calendar = {
      ...registration,
      calendar: {
        ...registration.calendar,
        sessions: registration.calendar.sessions.map((session, index) =>
          index === 0
            ? {
                ...session,
                openAt: `${first.sessionDate}T15:30:00.000Z`,
                closeAt: `${first.sessionDate}T15:32:00.000Z`,
              }
            : session,
        ),
      },
    }
    const captured = Result.getOrThrow(
      captureForwardFinancialEvidence(calendar, JevResearchPolicy.Candidate, observed, []),
    )
    expect(captured.sessions[0]?.facts).toMatchObject({
      openingPositionCount: 0,
      closingPositionCount: 0,
      completedEpisodes: 1,
      unsettledFillCount: 1,
      executionCostMicros: (3_000_000n + BigInt(accrual.expense_micros)).toString(),
      cashSettlementRoundingMicros: '-1738',
    })
  })
  test('verified carried inventory retains trade facts and basis rather than requiring a flat position to measure economics', () => {
    const { registration, forward } = fixture(JevResearchPolicy.Candidate)
    const first = registration.calendar.sessions[0]
    if (first === undefined) throw new Error('Missing first session')
    const buy = coinRoundTrip(0, forward.account.accountId, testHash('cycle'), { sourceDate: first.sessionDate })
      .fills[0]
    if (buy === undefined) throw new Error('Missing synthetic buy')
    const calendar = {
      ...registration,
      calendar: {
        ...registration.calendar,
        sessions: registration.calendar.sessions.map((s, index) =>
          index === 0
            ? { ...s, openAt: `${first.sessionDate}T15:30:00.000Z`, closeAt: `${first.sessionDate}T15:32:00.000Z` }
            : s,
        ),
      },
    }
    const observed = {
      ...forward,
      accountTransactions: [buy],
      accountCashSettlements: cashSettlements([buy]),
      transactions: [{ ...buy, cycleId: testHash('cycle') }],
      brokerFees: [],
      openPositionCount: 1,
      accountPositionCounts: {
        postgres: 1,
        ledger: 1,
        exact: true,
        reconciledAt: forward.reconciliation?.reconciledAt ?? '',
      },
      executionEvidence: [
        {
          cycleId: testHash('cycle'),
          decisionDocumentHash: testHash('document'),
          decisionHash: testHash('decision'),
          decisionCreatedAt: buy.occurredAt,
          intentId: buy.intentId ?? testHash('intent'),
          accountId: buy.accountId,
          symbol: buy.symbol,
          side: buy.side,
          fills: [
            {
              ...buy,
              fillId: buy.brokerEventId,
              brokerOrderId: 'order',
              clientOrderId: 'client',
              intentId: buy.intentId ?? testHash('intent'),
              sourceTimestamp: buy.occurredAt,
              observedAt: buy.occurredAt,
            },
          ],
        },
      ],
    }
    const captured = Result.getOrThrow(
      captureForwardFinancialEvidence(calendar, JevResearchPolicy.Candidate, observed, []),
    )
    expect(captured.sessions[0]?.facts).toMatchObject({
      grossRealizedPnlMicros: '0',
      executionCostMicros: '0',
      cashSettlementRoundingMicros: '-5000',
      openingPositionCount: 0,
      closingPositionCount: 1,
      completedEpisodes: 0,
    })
    expect(captured.sessions[1]?.facts).toMatchObject({
      grossRealizedPnlMicros: '0',
      executionCostMicros: '0',
      cashSettlementRoundingMicros: '0',
      openingPositionCount: 1,
      closingPositionCount: 1,
      completedEpisodes: 0,
    })
    expect(captured.sessions[0]?.facts).not.toHaveProperty('closingUnrealizedPnlMicros')
    const second = calendar.calendar.sessions[1]
    if (second === undefined) throw new Error('Missing second session')
    const lateFee = Result.getOrThrow(
      prepareFeeAccrual(
        {
          schemaVersion: 'bayn.broker-fee-accrual.v2',
          kind: 'CASH',
          accountId: buy.accountId,
          symbol: 'USD',
          date: second.sessionDate,
          cycleId: testHash('cycle'),
          accountEventId: testHash('late account event'),
          openingAccountEventId: testHash('late opening event'),
          openingCashReportingQuantumMicros: '10000',
          observedAt: second.closeAt,
          projectedCashMicros: '100000000',
          observedCashMicros: '99990000',
          cashReportingQuantumMicros: '10000',
          sourceTrades: [
            { transactionId: buy.transactionId, quantityAtoms: buy.quantityAtoms, priceAtoms: buy.priceAtoms },
          ],
        },
        7001,
      ),
    )
    const withLateFee = Result.getOrThrow(
      captureForwardFinancialEvidence(
        calendar,
        JevResearchPolicy.Candidate,
        {
          ...observed,
          accountFeeAccruals: [
            {
              accrual_id: lateFee.accrualId,
              data: lateFee.data,
              settlement_date: second.sessionDate,
              content_hash: lateFee.contentHash,
              coin_quantity_atoms: lateFee.coinQuantityAtoms,
              cash_debit_micros: lateFee.cashDebitMicros,
              expense_micros: lateFee.expenseMicros,
              matched_coin_quantity_atoms: '0',
              matched_cash_micros: '0',
              ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(lateFee.plan)),
              tigerbeetle_cluster_id: '2001',
              tigerbeetle_ledger: 7001,
              posted: true,
            },
          ],
          brokerFeeAccruals: [
            {
              accrualId: lateFee.accrualId,
              accountId: buy.accountId,
              expenseMicros: lateFee.expenseMicros,
              settled: false,
            },
          ],
        },
        [],
      ),
    )
    expect(withLateFee.sessions[0]?.facts?.executionCostMicros).toBe('0')
    expect(withLateFee.sessions[1]?.facts).toMatchObject({ executionCostMicros: '10000', unsettledFillCount: 1 })
    expect(
      Result.getOrThrow(
        captureForwardFinancialEvidence(
          calendar,
          JevResearchPolicy.Candidate,
          { ...observed, accountCashSettlements: [] },
          [],
        ),
      ).sessions[0]?.facts,
    ).toBeNull()
  })

  test('every policy retains all twenty sessions and a fee on a zero-trade session', () => {
    for (const policy of Object.values(JevResearchPolicy)) {
      const { registration, forward } = fixture(policy)
      const captured = Result.getOrThrow(captureForwardFinancialEvidence(registration, policy, forward, []))
      expect(captured.policy).toBe(policy)
      expect(captured.sessions.map((session) => session.sessionDate)).toEqual(
        registration.calendar.sessions.map((session) => session.sessionDate),
      )
      expect(captured.sessions[0]?.facts).toMatchObject({
        grossRealizedPnlMicros: '0',
        executionCostMicros: '3000000',
        completedEpisodes: 0,
        filledNotionalMicros: '0',
      })
      expect(captured.sessions.slice(1).every((session) => session.facts?.executionCostMicros === '0')).toBe(true)
    }
  })

  test('a charge without registered session attribution cannot disappear between sessions or after the window', () => {
    const { registration, forward } = fixture(JevResearchPolicy.Candidate)
    for (const date of ['2026-11-07', '2026-11-30'] as const) {
      expect(registration.calendar.sessions.some((session) => session.sessionDate === date)).toBe(false)
      const captured = Result.getOrThrow(
        captureForwardFinancialEvidence(
          registration,
          JevResearchPolicy.Candidate,
          {
            ...forward,
            brokerFees: [
              {
                accountId: forward.account.accountId,
                activityId: `unallocated-${date}`,
                date,
                netAmountMicros: '-3000000',
              },
            ],
          },
          [],
        ),
      )
      expect(captured.sessions.every((session) => session.facts === null)).toBe(true)
    }
  })

  test('a control cannot reuse another account or turn an incomplete ledger into measured money', () => {
    const policy = JevResearchPolicy.Momentum
    const { registration, forward } = fixture(policy)
    expect(
      Result.isFailure(captureForwardFinancialEvidence(registration, JevResearchPolicy.Candidate, forward, [])),
    ).toBe(true)
    for (const missing of [
      { ...forward, ledgerExact: false },
      { ...forward, accountingReceiptsExact: false },
      { ...forward, missingLedgerAccountCount: 1 },
      { ...forward, unresolvedMutationCount: 1 },
    ]) {
      const captured = Result.getOrThrow(captureForwardFinancialEvidence(registration, policy, missing, []))
      expect(captured.sessions).toHaveLength(20)
      expect(captured.sessions.every((session) => session.facts === null)).toBe(true)
    }
  })
})
