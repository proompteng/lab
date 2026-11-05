import { describe, expect, test } from 'bun:test'

import { Cause, Effect, Logger, References, Result } from 'effect'

import { provideTestLayer } from '../effect-test-support'

import { AccountStatus, type Account, type ReadEvidence } from '../broker/alpaca/model'
import type { ReconciliationPersistence } from '../db/execution-store'
import type { BrokerSnapshot, ReconciliationWriteResult } from '../db/reconciliation'
import { canonicalHashV1Result } from '../hash'
import { ReconciliationStatus, type Valuation } from '../execution/contracts'
import { persistStableSnapshot } from './broker-persistence'
import type { StableBrokerSnapshot } from './broker-reconciler-model'

const accountId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const observedAt = '2026-07-30T10:08:00.000Z'
const reconciliationId = Result.getOrThrow(canonicalHashV1Result('reconciliation-log-redaction'))
const accountingHash = Result.getOrThrow(canonicalHashV1Result('accounting-state'))

const evidence = (identity: string): ReadEvidence => ({
  requestId: `request-${identity}`,
  status: 200,
  contentHash: Result.getOrThrow(canonicalHashV1Result(identity)),
  observedAt,
})

const account: Account = {
  cryptoStatus: null,
  cryptoFeeTier: null,
  cashReportingQuantumMicros: '1' as const,
  nonMarginableBuyingPowerMicros: null,

  id: accountId,
  status: AccountStatus.Active,
  currency: 'USD',
  cashMicros: '1000000000',
  equityMicros: '1000000000',
  lastEquityMicros: '1000000000',
  buyingPowerMicros: '2000000000',
  accountBlocked: false,
  tradingBlocked: false,
  tradeSuspendedByUser: false,
  observedAt,
}

const snapshot: StableBrokerSnapshot = {
  account: { value: account, evidence: evidence('account') },
  positions: { value: [], evidence: evidence('positions') },
  history: {
    orders: { rows: [], observedAt },
    fills: [],
    fees: [],
  },
}

const valuation: Valuation = {
  schemaVersion: 'bayn.paper-valuation.v1',
  valuationId: Result.getOrThrow(canonicalHashV1Result('valuation')),
  accountId,
  sourceHash: Result.getOrThrow(canonicalHashV1Result('valuation-source')),
  cashMicros: account.cashMicros,
  longMarketValueMicros: '0',
  shortMarketValueMicros: '0',
  equityMicros: account.equityMicros,
  asOf: observedAt,
}

const writeResult = (persisted: BrokerSnapshot): ReconciliationWriteResult => ({
  reconciliation: {
    schemaVersion: 'bayn.paper-reconciliation.v1',
    reconciliationId,
    accountId,
    expectedHash: Result.getOrThrow(canonicalHashV1Result('expected-state')),
    observedHash: Result.getOrThrow(canonicalHashV1Result('expected-state')),
    contentHash: Result.getOrThrow(canonicalHashV1Result('reconciliation-content')),
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt: persisted.reconciledAt,
  },
  metrics: {
    brokerPollAgeMs: 123,
    oldestUnknownMutationAgeMs: 456,
    cashDifferenceMicros: '0',
    positionDifferenceMicros: '0',
    equityDifferenceMicros: '0',
    accountingExact: true,
    discrepancyCount: 0,
  },
  accountingHash,
  riskContext: {
    tradingDate: '2026-07-30',
    authority: null,
    authorityObservedAt: null,
    unknownMutationCount: 0,
    dailyTradedNotionalMicros: '0',
    dayStartEquityMicros: account.equityMicros,
    peakEquityMicros: account.equityMicros,
  },
})

const store: ReconciliationPersistence = {
  events: {
    completeHistory: () => Effect.succeed(new Set()),
    ingest: (input) =>
      Effect.succeed({
        eventId: Result.getOrThrow(canonicalHashV1Result(input.sourceEventId)),
        sourceSequence: '1',
        deduplicated: false,
      }),
    ingestPositions: (input) =>
      Effect.succeed({
        snapshotId: Result.getOrThrow(canonicalHashV1Result(input.sourceHash)),
        eventIds: [],
        deduplicated: false,
      }),
  },
  accounting: {
    account: () => Effect.die(new Error('empty successful reconciliation must not account a fill')),
    verifyCompleted: () => Effect.void,
  },
  valuation: {
    value: () => Effect.succeed(valuation),
    hasAccountBaseline: () => Effect.die(new Error('empty successful reconciliation must not read a baseline')),
  },
  reconciliation: {
    retainCashReporting: () => Effect.void,
    bindings: (boundAccountId) => {
      expect(boundAccountId).toBe(accountId)
      return Effect.succeed([])
    },
    reconcile: (_, snapshot) =>
      snapshot.pipe(
        Effect.map((snapshot) => {
          expect(snapshot.account.accountId).toBe(accountId)
          return { snapshot, persisted: writeResult(snapshot) }
        }),
      ),
  },
  authorityRestriction: {
    restrictAuthority: () => Effect.die(new Error('successful reconciliation must not restrict authority')),
  },
}

describe('simulation reconciliation persistence logging', () => {
  test('keeps raw broker identity internal while excluding it from the successful reconciliation log', async () => {
    const logs: Array<{
      readonly message: unknown
      readonly annotations: Record<string, unknown>
      readonly renderedCause: string
    }> = []
    const logger = Logger.make<unknown, void>((entry) => {
      logs.push({
        message: entry.message,
        annotations: { ...entry.fiber.getRef(References.CurrentLogAnnotations) },
        renderedCause: Cause.pretty(entry.cause),
      })
    })

    const result = await Effect.runPromise(
      persistStableSnapshot(store, snapshot, Effect.succeed(observedAt)).pipe((self) =>
        provideTestLayer(self, Logger.layer([logger])),
      ),
    )

    expect(result.report.reconciliation.accountId).toBe(accountId)
    expect(result.brokerState.account.accountId).toBe(accountId)

    const completed = logs.find((entry) =>
      JSON.stringify(entry.message).includes('Broker account reconciliation completed'),
    )
    expect(completed).toBeDefined()
    if (completed === undefined) return expect.unreachable('successful reconciliation log was not captured')

    expect(JSON.stringify(completed.message)).not.toContain(accountId)
    expect(JSON.stringify(completed.annotations)).not.toContain(accountId)
    expect(completed.renderedCause).not.toContain(accountId)
    expect(completed.annotations).toMatchObject({
      status: ReconciliationStatus.Exact,
      reconciliationId,
      orderCount: 0,
      fillCount: 0,
      discrepancyCount: 0,
      brokerPollAgeMs: 123,
      oldestUnknownMutationAgeMs: 456,
      accountingExact: true,
    })
  })
})
