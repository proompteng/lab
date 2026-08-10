import { describe, expect, test } from 'bun:test'

import { Cause, Effect, Logger, References } from 'effect'

import { provideTestLayer } from '../effect-test-support'

import { AccountStatus, type Account, type ReadEvidence } from '../broker/alpaca'
import type { ReconciliationPersistence } from '../db/execution-store'
import type { BrokerSnapshot, ReconciliationWriteResult } from '../db/reconciliation'
import type { WriterFenceService } from '../execution/writer-fence'
import { canonicalHashV1 } from '../hash'
import { ReconciliationStatus, type Valuation } from '../paper'
import { persistStableSnapshot } from './broker-persistence'
import type { StableBrokerSnapshot } from './broker-reconciler-model'

const accountId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const observedAt = '2026-07-30T10:08:00.000Z'
const reconciliationId = canonicalHashV1('reconciliation-log-redaction')
const accountingHash = canonicalHashV1('accounting-state')

const evidence = (identity: string): ReadEvidence => ({
  requestId: `request-${identity}`,
  status: 200,
  contentHash: canonicalHashV1(identity),
  observedAt,
})

const account: Account = {
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
  },
}

const valuation: Valuation = {
  schemaVersion: 'bayn.paper-valuation.v1',
  valuationId: canonicalHashV1('valuation'),
  accountId,
  sourceHash: canonicalHashV1('valuation-source'),
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
    expectedHash: canonicalHashV1('expected-state'),
    observedHash: canonicalHashV1('expected-state'),
    contentHash: canonicalHashV1('reconciliation-content'),
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
    ingest: (input) =>
      Effect.succeed({
        eventId: canonicalHashV1(input.sourceEventId),
        sourceSequence: '1',
        deduplicated: false,
      }),
    ingestPositions: (input) =>
      Effect.succeed({
        snapshotId: canonicalHashV1(input.sourceHash),
        eventIds: [],
        deduplicated: false,
      }),
  },
  accounting: {
    account: () => Effect.die(new Error('empty successful reconciliation must not account a fill')),
  },
  valuation: {
    value: () => Effect.succeed(valuation),
    hasAccountBaseline: () => Effect.die(new Error('empty successful reconciliation must not read a baseline')),
  },
  reconciliation: {
    bindings: (boundAccountId) => {
      expect(boundAccountId).toBe(accountId)
      return Effect.succeed([])
    },
    reconcile: (persisted) => {
      expect(persisted.account.accountId).toBe(accountId)
      return Effect.succeed(writeResult(persisted))
    },
  },
  authorityRestriction: {
    restrictAuthority: () => Effect.die(new Error('successful reconciliation must not restrict authority')),
  },
}

const fence: WriterFenceService = {
  backendPid: 1,
  check: Effect.void,
  transaction: (effect) => effect,
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
      persistStableSnapshot(store, fence, snapshot, Effect.succeed(observedAt)).pipe(
        provideTestLayer(Logger.layer([logger])),
      ),
    )

    expect(result.report.reconciliation.accountId).toBe(accountId)
    expect(result.brokerState.account.accountId).toBe(accountId)

    const completed = logs.find((entry) =>
      JSON.stringify(entry.message).includes('Paper account reconciliation completed'),
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
