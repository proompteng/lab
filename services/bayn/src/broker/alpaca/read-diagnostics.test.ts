import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Logger, Redacted, References, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { canonicalHashV1 } from '../../hash'
import { alpacaSandboxBaseUrl, decodeBrokerConnection } from '../connection'
import { BrokerEnvironment, BrokerProvider } from '../identity'
import { make } from './http'
import { diagnosticLimits, makeReadDiagnostics, projectReadDiagnostic, type DiagnosticEvent } from './read-diagnostics'
import { AccountStatus, type ReadEvidence } from './model'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const connection = Result.getOrThrow(
  decodeBrokerConnection({
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: alpacaSandboxBaseUrl,
    expectedAccountId: accountId,
    key: Redacted.make('synthetic-private-key'),
    secret: Redacted.make('synthetic-private-secret'),
    proxyUrl: 'http://bayn-egress-proxy:3128',
    operationTimeoutMs: 1_000,
    retryAttempts: 0,
  }),
)
const fee = (index = 1) => ({
  activity_type: 'FEE',
  id: `20261002000000000::12345678-1234-4234-8234-${index.toString(16).padStart(12, '0')}`,
  date: '2026-10-02',
  net_amount: '-0.01',
  status: 'executed',
  description: `TAF fee for synthetic activity by ${accountId}`,
})
const account = {
  id: accountId,
  account_number: 'PRIVATE-ACCOUNT-NUMBER',
  status: 'ACTIVE',
  currency: 'USD',
  cash: '76543.21',
  equity: '76543.21',
  last_equity: '76543.21',
  buying_power: '153086.42',
  account_blocked: false,
  trading_blocked: false,
  trade_suspended_by_user: false,
  accrued_fees: '0.113961944444418396',
  pending_reg_taf_fees: '0.01',
}
const evidence = (index = 1): ReadEvidence => ({
  requestId: `synthetic-request-${index}`,
  status: 200,
  contentHash: canonicalHashV1({ index }),
  observedAt: '2026-10-03T08:00:00.000Z',
})
const clocked = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))
const record = (events: DiagnosticEvent[]) => (event: DiagnosticEvent) =>
  Effect.sync(() => {
    events.push(event)
  })

describe('bounded observational broker diagnostics', () => {
  test('retains reported metadata and distinct absent/null/type states without treating absence as settlement', () => {
    const result = projectReadDiagnostic('fee-activities', [
      {
        ...fee(),
        status: null,
        settle_date: 42,
        system_date: '2026-02-30',
        activity_subtype: 'UNTRUSTED-PRIVATE-TEXT',
        entry_sub_type: 'TAF',
        executed_at: '2026-10-03T07:00:00.000Z',
      },
    ])
    expect(result).toMatchObject({
      fees: [
        {
          fields: {
            status: { state: 'null' },
            settle_date: { state: 'invalid', type: 'number' },
            system_date: { state: 'unrecognized', type: 'string' },
            activity_subtype: { state: 'unrecognized', type: 'string' },
            entry_sub_type: { state: 'reported', value: 'TAF' },
            transaction_time: { state: 'absent' },
            descriptionCategoryNonAuthoritative: { state: 'reported', value: 'TAF' },
          },
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('UNTRUSTED-PRIVATE-TEXT')
    expect(projectReadDiagnostic('account', { accrued_fees: [], pending_reg_taf_fees: null })).toEqual({
      endpoint: '/v2/account',
      fields: {
        accrued_fees: { state: 'invalid', type: 'array' },
        pending_reg_taf_fees: { state: 'null' },
      },
    })
    expect(projectReadDiagnostic('account', {})).toMatchObject({ fields: { accrued_fees: { state: 'absent' } } })
  })

  test('never copies hostile strings, raw descriptions, balances, identity, credentials or unrelated keys', () => {
    const privateText = 'sensitive-data-must-not-appear'
    const raw = {
      ...fee(),
      status: privateText,
      entry_sub_type: privateText,
      description: `REG fee ${privateText}`,
      settle_date: privateText,
      executed_at: privateText,
      arbitrary: { [privateText]: privateText },
    }
    const text = JSON.stringify([
      projectReadDiagnostic('fee-activities', [raw]),
      projectReadDiagnostic('account', {
        ...account,
        password: privateText,
        accrued_fees: '9'.repeat(1_000),
        pending_reg_taf_fees: privateText,
      }),
    ])
    for (const value of [
      privateText,
      accountId,
      raw.id,
      account.account_number,
      account.cash,
      account.buying_power,
      'password',
    ])
      expect(text).not.toContain(value)
    expect(projectReadDiagnostic('positions', account)).toBeUndefined()
    expect(projectReadDiagnostic('fee-activities', {})).toBeUndefined()
    expect(
      projectReadDiagnostic(
        'account',
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error(privateText)
            },
          },
        ),
      ),
    ).toBeUndefined()
    expect(
      projectReadDiagnostic(
        'fee-activities',
        Array.from({ length: 1_000 }, (_, index) => fee(index)),
      ),
    ).toMatchObject({ omitted: 872 })
  })

  test('does not invoke changing accessors or overridden array methods at the pure projection boundary', () => {
    let getterCalls = 0
    const row = {
      ...fee(),
      get date() {
        getterCalls += 1
        return getterCalls % 2 ? '2026-10-02' : { private: 'SYNTHETIC_PRIVATE' }
      },
    }
    expect(projectReadDiagnostic('fee-activities', [row])).toEqual({
      endpoint: '/v2/account/activities/FEE',
      fees: [],
      omitted: 1,
    })
    expect(getterCalls).toBe(0)
    const rows = Array.from({ length: 129 }, (_, index) => fee(index))
    Object.defineProperty(rows, 'slice', { value: () => Array.from({ length: 1_000 }, (_, index) => fee(index)) })
    const projected = projectReadDiagnostic('fee-activities', rows)
    expect(projected?.endpoint === '/v2/account/activities/FEE' && projected.fees.length).toBe(128)
    expect(projected).toMatchObject({ omitted: 1 })
    const fields = projectReadDiagnostic('account', {
      get accrued_fees() {
        throw new Error('must not read getter')
      },
    })
    expect(fields).toMatchObject({ fields: { accrued_fees: { state: 'invalid', type: 'accessor' } } })
  })

  test('coalesces same metadata across response hashes and emits changes once per minute with original evidence', async () => {
    const events: DiagnosticEvent[] = []
    await clocked(
      Effect.gen(function* () {
        const observe = yield* makeReadDiagnostics(connection.identity, record(events))
        yield* observe(projectReadDiagnostic('account', account), evidence())
        yield* observe(projectReadDiagnostic('fee-activities', [fee()]), evidence(2))
        expect(events).toHaveLength(0)
        yield* TestClock.adjust(60_000)
        yield* observe(projectReadDiagnostic('fee-activities', [fee()]), evidence(3))
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          identityHash: connection.identity.identityHash,
          account: {
            fields: { accrued_fees: { value: account.accrued_fees } },
            evidence: { responseHash: evidence().contentHash },
          },
          fees: [{ evidence: { responseHash: evidence(3).contentHash } }],
          incomplete: false,
        })
        yield* TestClock.adjust(60_000)
        yield* observe(projectReadDiagnostic('fee-activities', [fee()]), evidence(4))
        expect(events).toHaveLength(1)
        yield* observe(projectReadDiagnostic('account', { ...account, pending_reg_taf_fees: '0.02' }), evidence(5))
        expect(events).toHaveLength(2)
        yield* observe(projectReadDiagnostic('account', { ...account, pending_reg_taf_fees: '0.03' }), evidence(6))
        expect(events).toHaveLength(2)
        yield* TestClock.adjust(60_000)
        yield* observe(projectReadDiagnostic('account', { ...account, pending_reg_taf_fees: '0.03' }), evidence(7))
        expect(events).toHaveLength(3)
      }),
    )
  })

  test('bounds retained identities, serialized bytes and records, reports omission, and prioritizes recent dates', async () => {
    const events: DiagnosticEvent[] = []
    await clocked(
      Effect.gen(function* () {
        const observe = yield* makeReadDiagnostics(connection.identity, record(events))
        for (let page = 0; page < 4; page += 1)
          yield* observe(
            projectReadDiagnostic(
              'fee-activities',
              Array.from({ length: 100 }, (_, i) => ({
                ...fee(page * 100 + i),
                date: `2026-09-${String(page + 1).padStart(2, '0')}`,
              })),
            ),
            evidence(page),
          )
        for (let pass = 0; pass < 20; pass += 1) {
          yield* TestClock.adjust(60_000)
          yield* observe(projectReadDiagnostic('account', account), evidence(pass))
        }
        const rows = events.flatMap((event) => event.fees)
        expect(rows).toHaveLength(diagnosticLimits.identities)
        expect(new Set(rows.map((row) => row.activityHash)).size).toBe(diagnosticLimits.identities)
        expect(rows[0]?.reportedDate).toBe('2026-09-04')
        expect(events[0]?.omittedRecords).toBe(272)
        expect(events[0]?.incomplete).toBe(true)
        for (const event of events) {
          expect(event.fees.length).toBeLessThanOrEqual(diagnosticLimits.records)
          expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThanOrEqual(diagnosticLimits.bytes)
        }
      }),
    )
  })

  test('unchanged overflowing pages and multi-page histories become silent after retained metadata drains', async () => {
    for (const pages of [
      [Array.from({ length: 129 }, (_, index) => fee(index))],
      [
        Array.from({ length: 100 }, (_, index) => ({ ...fee(index), date: '2026-09-01' })),
        Array.from({ length: 100 }, (_, index) => fee(index + 100)),
      ],
    ]) {
      const events: DiagnosticEvent[] = []
      await clocked(
        Effect.gen(function* () {
          const observe = yield* makeReadDiagnostics(connection.identity, record(events))
          for (let poll = 0; poll < 25; poll += 1) {
            for (const page of pages) yield* observe(projectReadDiagnostic('fee-activities', page), evidence(poll))
            yield* TestClock.adjust(60_000)
          }
          const emitted = events.length
          for (let poll = 0; poll < 5; poll += 1) {
            for (const page of pages)
              yield* observe(projectReadDiagnostic('fee-activities', page), evidence(poll + 100))
            yield* TestClock.adjust(60_000)
          }
          expect(events.length).toBe(emitted)
          expect(events.length).toBeGreaterThan(0)
          expect(events.every((event) => event.retentionTruncated && event.incomplete)).toBe(true)
          expect(events.filter((event) => event.fees.length === 0)).toHaveLength(0)
        }),
      )
    }
  })

  test('reader replacement emits at most a new bounded snapshot and diagnostic sink defects cannot fail a read', async () => {
    const events: DiagnosticEvent[] = []
    await clocked(
      Effect.gen(function* () {
        for (let replacement = 0; replacement < 2; replacement += 1) {
          const observe = yield* makeReadDiagnostics(connection.identity, record(events))
          yield* observe(projectReadDiagnostic('account', account), evidence())
          yield* TestClock.adjust(60_000)
          yield* observe(projectReadDiagnostic('account', account), evidence())
        }
        expect(events).toHaveLength(2)
        const broken = yield* makeReadDiagnostics(connection.identity, () => Effect.die('synthetic sink defect'))
        yield* TestClock.adjust(60_000)
        yield* broken(projectReadDiagnostic('account', account), evidence())
      }),
    )
  })

  test('does not swallow interruption in the diagnostic tap', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const observe = yield* makeReadDiagnostics(connection.identity, () => Effect.interrupt)
        yield* TestClock.adjust(60_000)
        yield* observe(projectReadDiagnostic('account', account), evidence())
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  })

  test('uses only existing HTTP reads and preserves normalized values and response hashes', async () => {
    let calls = 0
    const events: unknown[] = []
    const logger = Logger.make<unknown, void>((entry) => {
      const annotations = entry.fiber.getRef(References.CurrentLogAnnotations)
      if (annotations['brokerReadDiagnostic'] !== undefined) events.push(annotations['brokerReadDiagnostic'])
    })
    const client = HttpClient.make((request, url) => {
      calls += 1
      expect(request.method).toBe('GET')
      expect(['/v2/account', '/v2/account/activities/FEE']).toContain(url.pathname)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(url.pathname === '/v2/account' ? account : [fee()]), {
            headers: { 'content-type': 'application/json', 'x-request-id': `request-${calls}` },
          }),
        ),
      )
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* make(connection)
        const original = yield* read.account
        const feeRead = yield* read.feeActivities()
        expect(original.value).toEqual({
          id: accountId,
          status: AccountStatus.Active,
          currency: 'USD',
          cashMicros: '76543210000',
          equityMicros: '76543210000',
          lastEquityMicros: '76543210000',
          buyingPowerMicros: '153086420000',
          accountBlocked: false,
          tradingBlocked: false,
          tradeSuspendedByUser: false,
          observedAt: original.evidence.observedAt,
        })
        expect(feeRead.value).toEqual({
          items: [{ accountId, activityId: fee().id, date: fee().date, netAmountMicros: '-10000' }],
        })
        expect(original.evidence.contentHash).toBe(canonicalHashV1(account))
        expect(feeRead.evidence.contentHash).toBe(canonicalHashV1([fee()]))
        expect(events).toHaveLength(0)
        yield* TestClock.adjust(60_000)
        const repeated = yield* read.account
        expect({ ...repeated.value, observedAt: original.value.observedAt }).toEqual(original.value)
        expect(events).toHaveLength(1)
        expect(calls).toBe(3)
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(TestClock.layer()),
        Effect.provide(Logger.layer([logger])),
      ),
    )
    const encoded = JSON.stringify(events)
    for (const value of [
      accountId,
      account.account_number,
      account.cash,
      account.buying_power,
      'synthetic-private',
      fee().id,
    ])
      expect(encoded).not.toContain(value)
  })

  test('never emits trusted evidence after HTTP, decoder or account-binding failure', async () => {
    for (const broken of [
      { operation: 'account', body: { ...account, id: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415' }, status: 200 },
      { operation: 'account', body: { ...account, cash: 'bad' }, status: 200 },
      { operation: 'account', body: { code: 40310000, message: 'denied' }, status: 403 },
      { operation: 'fee', body: [{ ...fee(), account_id: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415' }], status: 200 },
      { operation: 'fee', body: [{ ...fee(), net_amount: 'bad' }], status: 200 },
      { operation: 'fee', body: { code: 40310000, message: 'denied' }, status: 403 },
    ]) {
      const logs: unknown[] = []
      const logger = Logger.make<unknown, void>((entry) => {
        logs.push(entry.fiber.getRef(References.CurrentLogAnnotations))
      })
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(broken.body), {
              status: broken.status,
              headers: { 'x-request-id': 'failed-read', 'content-type': 'application/json' },
            }),
          ),
        ),
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const read = yield* make(connection)
          yield* TestClock.adjust(60_000)
          const request =
            broken.operation === 'account' ? Effect.asVoid(read.account) : Effect.asVoid(read.feeActivities())
          expect(Exit.isFailure(yield* Effect.exit(request))).toBe(true)
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide(TestClock.layer()),
          Effect.provide(Logger.layer([logger])),
        ),
      )
      expect(JSON.stringify(logs)).not.toContain('brokerReadDiagnostic')
    }
  })
})
