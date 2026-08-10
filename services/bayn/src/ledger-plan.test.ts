import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { AccountFlags, type Account, type Transfer } from 'tigerbeetle-node'

import {
  AccountCode,
  buildLedgerPlan,
  hashLedgerPlanResult,
  LEDGER_BATCH_MAX,
  preflightTransfers,
  reconcileLedgerPlan,
  TransferCode,
  validatePersistedRunEvidence,
  type LedgerInput,
  type LedgerPlan,
  type LedgerPlanFailureDetail,
  LedgerValidationError,
} from './ledger-plan'
import { evaluateRiskBalancedTrend } from './risk-balanced-trend'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'
import type { CashYieldEvent, FeeEvent, FillEvent } from './types'

const ledger = 7_001

const assertSuccess = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'ledger plan decision must succeed')
  return result.success
}

const assertFailure = <A, E>(result: Result.Result<A, E>): E => {
  assert(Result.isFailure(result), 'ledger plan decision must fail')
  return result.failure
}

const hashPlan = (plan: LedgerPlan): string => assertSuccess(hashLedgerPlanResult(plan))

const assertLedgerPlanFailure = <A>(result: Result.Result<A, LedgerValidationError>): LedgerPlanFailureDetail => {
  const failure = assertFailure(result)
  expect(failure).toBeInstanceOf(LedgerValidationError)
  assert('detail' in failure, 'ledger plan failure must retain its closed detail')
  return failure.detail as LedgerPlanFailureDetail
}

const evaluationResult = (): LedgerInput => {
  const snapshot = makeSnapshot()
  return assertSuccess(
    evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance()),
  )
}

const evaluationPlan = () => {
  const result = evaluationResult()
  return { result, plan: assertSuccess(buildLedgerPlan(result, ledger)) }
}

const firstFill = (result: LedgerInput, side?: FillEvent['side']): FillEvent => {
  const fill = result.events.find(
    (event): event is FillEvent => event.kind === 'fill' && (side === undefined || event.side === side),
  )
  assert(fill, `evaluation fixture must contain a${side === undefined ? '' : ` ${side}`} fill`)
  return fill
}

const materialize = (plan: LedgerPlan): { readonly accounts: Account[]; readonly transfers: Transfer[] } => {
  const balances = new Map(plan.accounts.map((account) => [account.id, { debits: 0n, credits: 0n }]))
  for (const transfer of plan.transfers) {
    const debit = balances.get(transfer.debit_account_id)
    const credit = balances.get(transfer.credit_account_id)
    assert(debit, `missing debit account ${transfer.debit_account_id}`)
    assert(credit, `missing credit account ${transfer.credit_account_id}`)
    debit.debits += transfer.amount
    credit.credits += transfer.amount
  }
  return {
    accounts: plan.accounts.map((account) => {
      const balance = balances.get(account.id)
      assert(balance, `missing account balance ${account.id}`)
      return {
        ...account,
        debits_posted: balance.debits,
        credits_posted: balance.credits,
        timestamp: 1n,
      }
    }),
    transfers: plan.transfers.map((transfer) => ({ ...transfer, timestamp: 1n })),
  }
}

describe('ledger plan Result algebra', () => {
  test('returns a fact-bearing no-fill failure', () => {
    const result = evaluationResult()
    const failure = assertLedgerPlanFailure(buildLedgerPlan({ ...result, events: [] }, ledger))

    expect(failure).toEqual({
      kind: 'no-fill-events',
      runId: result.runId,
      eventCount: 0,
    })
  })

  test('returns exact parsing and sign failures for every planned amount', () => {
    const result = evaluationResult()
    const fill = firstFill(result, 'buy')
    const fee = {
      kind: 'fee',
      id: 'e'.repeat(64),
      sessionDate: fill.sessionDate,
      commissionMicros: '0',
      secMicros: '0',
      tafMicros: '0',
      catMicros: '0',
      totalMicros: '1',
    } satisfies FeeEvent
    const cashYield = {
      kind: 'cash-yield',
      id: 'd'.repeat(64),
      sessionDate: fill.sessionDate,
      elapsedDays: 1,
      annualYieldBps: 100,
      amountMicros: '1',
    } satisfies CashYieldEvent

    const cases: readonly {
      readonly input: LedgerInput
      readonly expected: Partial<LedgerPlanFailureDetail>
    }[] = [
      {
        input: { ...result, initialCapitalMicros: 'invalid', events: [fill] },
        expected: {
          kind: 'amount-parse-failed',
          field: 'initialCapitalMicros',
          actualType: 'string',
          value: 'invalid',
        },
      },
      {
        input: { ...result, initialCapitalMicros: '0', events: [fill] },
        expected: { kind: 'initial-capital-not-positive', value: 0n },
      },
      {
        input: { ...result, initialCapitalMicros: '-1', events: [fill] },
        expected: { kind: 'initial-capital-not-positive', value: -1n },
      },
      {
        input: { ...result, events: [{ ...fill, notionalMicros: 'invalid' }] },
        expected: {
          kind: 'amount-parse-failed',
          field: 'fill.notionalMicros',
          actualType: 'string',
          value: 'invalid',
          eventId: fill.id,
        },
      },
      {
        input: { ...result, events: [{ ...fill, notionalMicros: '-1' }] },
        expected: {
          kind: 'negative-amount',
          field: 'fill.notionalMicros',
          value: -1n,
          eventId: fill.id,
        },
      },
      {
        input: { ...result, events: [{ ...fill, costBasisMicros: 'invalid' }] },
        expected: {
          kind: 'amount-parse-failed',
          field: 'fill.costBasisMicros',
          actualType: 'string',
          value: 'invalid',
          eventId: fill.id,
        },
      },
      {
        input: { ...result, events: [{ ...fill, costBasisMicros: '-1' }] },
        expected: {
          kind: 'negative-amount',
          field: 'fill.costBasisMicros',
          value: -1n,
          eventId: fill.id,
        },
      },
      {
        input: { ...result, events: [fill, { ...fee, totalMicros: 'invalid' }] },
        expected: {
          kind: 'amount-parse-failed',
          field: 'fee.totalMicros',
          actualType: 'string',
          value: 'invalid',
          eventId: fee.id,
        },
      },
      {
        input: { ...result, events: [fill, { ...fee, totalMicros: '-1' }] },
        expected: {
          kind: 'negative-amount',
          field: 'fee.totalMicros',
          value: -1n,
          eventId: fee.id,
        },
      },
      {
        input: { ...result, events: [fill, { ...cashYield, amountMicros: 'invalid' }] },
        expected: {
          kind: 'amount-parse-failed',
          field: 'cashYield.amountMicros',
          actualType: 'string',
          value: 'invalid',
          eventId: cashYield.id,
        },
      },
      {
        input: { ...result, events: [fill, { ...cashYield, amountMicros: '-1' }] },
        expected: {
          kind: 'negative-amount',
          field: 'cashYield.amountMicros',
          value: -1n,
          eventId: cashYield.id,
        },
      },
    ]

    for (const { input, expected } of cases) {
      expect(assertLedgerPlanFailure(buildLedgerPlan(input, ledger))).toMatchObject(expected)
    }
  })

  test('never re-coerces rejected amount values while constructing failures', () => {
    const result = evaluationResult()
    const fill = firstFill(result, 'buy')
    const coercionCause = new TypeError('amount coercion is unavailable')
    const hostileAmount = {
      [Symbol.toPrimitive]: () => {
        throw coercionCause
      },
    }

    const symbolFailure = assertFailure(
      buildLedgerPlan(
        { ...result, initialCapitalMicros: Symbol('invalid') as unknown as string, events: [fill] },
        ledger,
      ),
    )
    expect(symbolFailure).toMatchObject({
      operation: 'build-plan',
      message: 'TigerBeetle build-plan failed: initialCapitalMicros is not an integer micros value (symbol)',
      detail: {
        kind: 'amount-parse-failed',
        field: 'initialCapitalMicros',
        actualType: 'symbol',
      },
    })
    expect(symbolFailure.detail).not.toHaveProperty('value')

    const hostileFailure = assertFailure(
      buildLedgerPlan(
        {
          ...result,
          events: [{ ...fill, notionalMicros: hostileAmount as unknown as string }],
        },
        ledger,
      ),
    )
    expect(hostileFailure).toMatchObject({
      operation: 'build-plan',
      message: 'TigerBeetle build-plan failed: fill.notionalMicros is not an integer micros value (object)',
      detail: {
        kind: 'amount-parse-failed',
        field: 'fill.notionalMicros',
        actualType: 'object',
        eventId: fill.id,
        cause: coercionCause,
      },
      cause: coercionCause,
    })
    expect(hostileFailure.detail).not.toHaveProperty('value')
  })

  test('returns exact inventory and event canonicalization failures', () => {
    const result = evaluationResult()
    const fill = firstFill(result, 'buy')
    const missingSymbol = 'MISSING-INVENTORY'

    expect(
      assertLedgerPlanFailure(buildLedgerPlan({ ...result, events: [{ ...fill, symbol: missingSymbol }] }, ledger)),
    ).toEqual({
      kind: 'inventory-account-missing',
      runId: result.runId,
      eventId: fill.id,
      symbol: missingSymbol,
    })

    const nonCanonicalFill = { ...fill, unsupported: undefined } as FillEvent
    const canonicalizationFailure = assertFailure(buildLedgerPlan({ ...result, events: [nonCanonicalFill] }, ledger))
    expect(canonicalizationFailure).toMatchObject({
      operation: 'build-plan',
      reason: 'ledger-plan-failure',
      kind: 'canonicalization-failed',
      detail: {
        kind: 'canonicalization-failed',
        canonicalizationOperation: 'event-transfer',
        eventId: fill.id,
        leg: 'buy',
        cause: {
          _tag: 'CanonicalJsonFailure',
          path: '$.unsupported',
          reason: 'non-json-type',
          actualType: 'undefined',
        },
      },
    })
    expect(canonicalizationFailure.operation).toBe('build-plan')
  })

  test('retains hostile manifest access as a closed failure with the original cause', () => {
    const result = evaluationResult()
    const cause = new TypeError('ledger-plan symbols are unavailable')
    const inputManifest = new Proxy(result.inputManifest, {
      get: (target, property, receiver) => {
        if (property === 'symbols') throw cause
        return Reflect.get(target, property, receiver)
      },
    })

    const failure = assertFailure(buildLedgerPlan({ ...result, inputManifest }, ledger))

    expect(failure).toBeInstanceOf(LedgerValidationError)
    expect(failure).toMatchObject({
      kind: 'input-access-failed',
      detail: { kind: 'input-access-failed', field: 'inputManifest.symbols', cause },
      material: {
        ledger,
        failure: { kind: 'input-access-failed', field: 'inputManifest.symbols', cause },
      },
      cause,
    })
  })

  test('retains hostile event collection and discriminator access as closed failures', () => {
    const result = evaluationResult()
    const fill = firstFill(result, 'buy')
    const eventsCause = new TypeError('ledger-plan events are unavailable')
    const kindCause = new TypeError('ledger-plan event kind is unavailable')
    const hostileInput = new Proxy(result, {
      get: (target, property, receiver) => {
        if (property === 'events') throw eventsCause
        return Reflect.get(target, property, receiver)
      },
    })
    const hostileFill = new Proxy(fill, {
      get: (target, property, receiver) => {
        if (property === 'kind') throw kindCause
        return Reflect.get(target, property, receiver)
      },
    })

    expect(assertLedgerPlanFailure(buildLedgerPlan(hostileInput, ledger))).toEqual({
      kind: 'input-access-failed',
      field: 'events',
      cause: eventsCause,
    })
    expect(assertLedgerPlanFailure(buildLedgerPlan({ ...result, events: [hostileFill] }, ledger))).toEqual({
      kind: 'input-access-failed',
      field: 'event.kind',
      eventIndex: 0,
      cause: kindCause,
    })
  })

  test('rejects noncanonical event shapes without invoking accessors or collapsing distinct material', () => {
    const result = evaluationResult()
    const fill = firstFill(result, 'buy')
    let accessorReads = 0
    const accessorFill = Object.defineProperty({ ...fill }, 'notionalMicros', {
      enumerable: true,
      get: () => {
        accessorReads += 1
        return fill.notionalMicros
      },
    }) as FillEvent
    const symbolFill = { ...fill } as FillEvent & { [key: symbol]: string }
    symbolFill[Symbol('distinct-material')] = 'present'
    const classFill = Object.assign(Object.create({ inherited: true }), fill) as FillEvent

    for (const event of [accessorFill, symbolFill, classFill]) {
      expect(assertLedgerPlanFailure(buildLedgerPlan({ ...result, events: [event] }, ledger))).toMatchObject({
        kind: 'input-access-failed',
        eventIndex: 0,
        eventKind: 'fill',
      })
    }
    expect(accessorReads).toBe(0)
  })

  test('rejects hostile scalar identities before hashing or rendering can coerce them', () => {
    const result = evaluationResult()
    const fill = firstFill(result, 'buy')
    let runIdCoercions = 0
    const hostileRunId = {
      [Symbol.toPrimitive]: () => {
        runIdCoercions += 1
        throw new TypeError('ledger-plan run identity coercion is unavailable')
      },
    }

    expect(
      assertLedgerPlanFailure(buildLedgerPlan({ ...result, runId: hostileRunId as unknown as string }, ledger)),
    ).toEqual({
      kind: 'input-value-invalid',
      field: 'runId',
      expected: 'string',
      actualType: 'object',
    })
    expect(runIdCoercions).toBe(0)

    expect(
      assertLedgerPlanFailure(
        buildLedgerPlan({ ...result, events: [{ ...fill, id: Symbol('fill-id') as unknown as string }] }, ledger),
      ),
    ).toEqual({
      kind: 'input-value-invalid',
      field: 'fill.id',
      expected: 'string',
      actualType: 'symbol',
      index: 0,
      eventKind: 'fill',
    })

    expect(
      assertLedgerPlanFailure(
        buildLedgerPlan(
          {
            ...result,
            inputManifest: {
              ...result.inputManifest,
              symbols: [
                {
                  ...result.inputManifest.symbols[0],
                  symbol: Symbol('inventory-symbol') as unknown as string,
                },
              ],
            },
          },
          ledger,
        ),
      ),
    ).toEqual({
      kind: 'input-value-invalid',
      field: 'inputManifest.symbol',
      expected: 'string',
      actualType: 'symbol',
      index: 0,
    })
  })

  test('preserves exact TigerBeetle identity, ordering, amounts, flags, and replay hash', () => {
    const result = evaluationResult()
    const first = assertSuccess(buildLedgerPlan(result, ledger))
    const replay = assertSuccess(buildLedgerPlan(result, ledger))

    expect(replay).toEqual(first)
    expect(first.runKey).toBe(69_942_771_251_131_843_050_516_581_237_517_927_397n)
    expect(first.runTag).toBe(2_699_395_039_088_034_789n)
    expect(first.accounts).toHaveLength(11)
    expect(first.transfers).toHaveLength(258)
    expect(first.accounts[0].id).toBe(43_249_501_142_936_952_057_395_946_051_265_147_876n)
    expect(first.accounts.at(-1)?.id).toBe(187_166_520_106_165_147_592_061_639_881_212_135_452n)
    expect(first.transfers[0].id).toBe(843_588_107_247_104_286_364_813_362_505_705_787n)
    expect(first.transfers.at(-1)?.id).toBe(339_931_206_364_908_967_505_523_512_953_605_189_254n)
    expect(first.transfers.find((transfer) => transfer.code === TransferCode.funding)?.id).toBe(
      91_698_455_022_344_017_785_425_376_077_893_533_948n,
    )
    expect(first.accounts.every((account) => account.flags === AccountFlags.history)).toBeTrue()
    expect(first.transfers.every((transfer) => transfer.flags === 0 && transfer.amount > 0n)).toBeTrue()
    expect(hashPlan(first)).toBe('9e4f815019e89744429af0ce5add0de162b088607ffcc37d9e5eee49695efd4a')
  })

  test('preserves the same balanced plan across deterministic event permutations', () => {
    const result = evaluationResult()
    const expected = assertSuccess(buildLedgerPlan(result, ledger))
    const expectedHash = hashPlan(expected)
    const permutations = [
      [...result.events].reverse(),
      [...result.events.slice(1), result.events[0]],
      [...result.events.slice(17), ...result.events.slice(0, 17)],
    ]

    for (const events of permutations) {
      const plan = assertSuccess(buildLedgerPlan({ ...result, events }, ledger))
      expect(hashPlan(plan)).toBe(expectedHash)
      expect(plan.accounts).toEqual(expected.accounts)
      expect(plan.transfers).toEqual(expected.transfers)

      const accountIds = new Set(plan.accounts.map((account) => account.id))
      let totalDebits = 0n
      let totalCredits = 0n
      for (const transfer of plan.transfers) {
        expect(accountIds.has(transfer.debit_account_id)).toBeTrue()
        expect(accountIds.has(transfer.credit_account_id)).toBeTrue()
        totalDebits += transfer.amount
        totalCredits += transfer.amount
      }
      expect(totalDebits).toBe(totalCredits)
      const persisted = materialize(plan)
      expect(Result.isSuccess(reconcileLedgerPlan(plan, persisted.accounts, persisted.transfers))).toBeTrue()
    }
  })

  test('returns an exact ledger-plan canonicalization failure for invalid typed material', () => {
    const plan = assertSuccess(buildLedgerPlan(evaluationResult(), ledger))
    expect(
      assertFailure(
        hashLedgerPlanResult({
          ...plan,
          accounts: [{ ...plan.accounts[0], ledger: Number.NaN }, ...plan.accounts.slice(1)],
        }),
      ),
    ).toEqual({
      _tag: 'LedgerPlanHashCanonicalizationFailed',
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.accounts[0].ledger',
        reason: 'non-finite-number',
        actualType: 'number',
      },
    })
  })

  test('accepts the last exact single-query size and rejects both next records', () => {
    const result = evaluationResult()
    const fill = firstFill(result, 'buy')
    const coverage = result.inputManifest.symbols.find((candidate) => candidate.symbol === fill.symbol)
    assert(coverage, `evaluation manifest must cover ${fill.symbol}`)

    const manifestWithSymbols = (count: number): LedgerInput['inputManifest'] => ({
      ...result.inputManifest,
      symbols: Array.from({ length: count }, (_, index) => ({
        ...coverage,
        symbol: index === 0 ? fill.symbol : `LIMIT${index.toString().padStart(5, '0')}`,
      })),
    })
    const allowedAccounts = assertSuccess(
      buildLedgerPlan(
        {
          ...result,
          inputManifest: manifestWithSymbols(LEDGER_BATCH_MAX - 7),
          events: [fill],
        },
        ledger,
      ),
    )
    expect(allowedAccounts.accounts).toHaveLength(LEDGER_BATCH_MAX - 1)
    expect(
      assertLedgerPlanFailure(
        buildLedgerPlan(
          {
            ...result,
            inputManifest: manifestWithSymbols(LEDGER_BATCH_MAX - 6),
            events: [fill],
          },
          ledger,
        ),
      ),
    ).toEqual({
      kind: 'single-query-limit-exceeded',
      runId: result.runId,
      accountCount: LEDGER_BATCH_MAX,
      transferCount: 2,
      limit: LEDGER_BATCH_MAX,
    })

    const feeEvents = Array.from(
      { length: LEDGER_BATCH_MAX - 2 },
      (_, index): FeeEvent => ({
        kind: 'fee',
        id: `f${(index + 1).toString(16).padStart(63, '0')}`,
        sessionDate: fill.sessionDate,
        commissionMicros: '1',
        secMicros: '0',
        tafMicros: '0',
        catMicros: '0',
        totalMicros: '1',
      }),
    )
    const minimalManifest = manifestWithSymbols(1)
    const allowedTransfers = assertSuccess(
      buildLedgerPlan(
        {
          ...result,
          inputManifest: minimalManifest,
          events: [fill, ...feeEvents.slice(0, -1)],
        },
        ledger,
      ),
    )
    expect(allowedTransfers.transfers).toHaveLength(LEDGER_BATCH_MAX - 1)
    expect(
      assertLedgerPlanFailure(
        buildLedgerPlan(
          {
            ...result,
            inputManifest: minimalManifest,
            events: [fill, ...feeEvents],
          },
          ledger,
        ),
      ),
    ).toEqual({
      kind: 'single-query-limit-exceeded',
      runId: result.runId,
      accountCount: 7,
      transferCount: LEDGER_BATCH_MAX,
      limit: LEDGER_BATCH_MAX,
    })
  })

  test('partitions exact existing transfers and preserves missing request order', () => {
    const { plan } = evaluationPlan()
    const existing = [plan.transfers[1], plan.transfers.at(-1)].filter(
      (transfer): transfer is Transfer => transfer !== undefined,
    )
    const missing = assertSuccess(preflightTransfers(plan.transfers, existing))

    expect(missing.map((transfer) => transfer.id)).toEqual(
      plan.transfers
        .filter((transfer) => !existing.some((present) => present.id === transfer.id))
        .map((transfer) => transfer.id),
    )

    const mismatch = assertFailure(
      preflightTransfers(plan.transfers, [{ ...plan.transfers[0], amount: plan.transfers[0].amount + 1n }]),
    )
    expect(mismatch).toMatchObject({
      operation: 'preflight-transfers',
      reason: 'record-mismatch',
      material: { id: plan.transfers[0].id },
    })
    expect('detail' in mismatch).toBeFalse()
  })

  test('reconciles exact sets and posted balances without throwing assertions', () => {
    const { plan } = evaluationPlan()
    const persisted = materialize(plan)

    expect(Result.isSuccess(reconcileLedgerPlan(plan, persisted.accounts, persisted.transfers))).toBeTrue()
    expect(
      assertFailure(
        reconcileLedgerPlan(plan, persisted.accounts, [
          ...persisted.transfers,
          { ...persisted.transfers[0], id: persisted.transfers[0].id + 1n },
        ]),
      ),
    ).toMatchObject({ operation: 'reconcile', reason: 'record-set-mismatch' })
    expect(
      assertFailure(
        reconcileLedgerPlan(
          plan,
          [
            { ...persisted.accounts[0], credits_posted: persisted.accounts[0].credits_posted + 1n },
            ...persisted.accounts.slice(1),
          ],
          persisted.transfers,
        ),
      ),
    ).toMatchObject({ operation: 'reconcile', reason: 'invalid-balance' })
  })

  test('validates all locally reconstructible persisted-run metadata', () => {
    const { result, plan } = evaluationPlan()
    const persisted = materialize(plan)
    const receipt = {
      runId: result.runId,
      accountCount: persisted.accounts.length,
      transferCount: persisted.transfers.length,
      exact: true,
    } as const

    expect(
      Result.isSuccess(validatePersistedRunEvidence(receipt, ledger, persisted.accounts, persisted.transfers)),
    ).toBeTrue()

    for (const invalidAccount of [
      { ...persisted.accounts[0], code: 999 },
      { ...persisted.accounts[0], flags: 0 },
      { ...persisted.accounts[0], reserved: 1 },
      { ...persisted.accounts[0], timestamp: 0n },
    ]) {
      expect(
        assertFailure(
          validatePersistedRunEvidence(
            receipt,
            ledger,
            [invalidAccount, ...persisted.accounts.slice(1)],
            persisted.transfers,
          ),
        ),
      ).toMatchObject({ operation: 'check-run', reason: 'invalid-account-metadata' })
    }

    for (const invalidTransfer of [
      { ...persisted.transfers[0], code: 999 },
      { ...persisted.transfers[0], flags: 1 },
      { ...persisted.transfers[0], pending_id: 1n },
      { ...persisted.transfers[0], timeout: 1 },
      { ...persisted.transfers[0], timestamp: 0n },
    ]) {
      expect(
        assertFailure(
          validatePersistedRunEvidence(receipt, ledger, persisted.accounts, [
            invalidTransfer,
            ...persisted.transfers.slice(1),
          ]),
        ),
      ).toMatchObject({ operation: 'check-run', reason: 'invalid-transfer-metadata' })
    }

    const cashIndex = persisted.accounts.findIndex((account) => account.code === AccountCode.cash)
    assert.notEqual(cashIndex, -1, 'ledger plan must contain deterministic cash account')
    const cash = persisted.accounts[cashIndex]
    const changedCashId = cash.id ^ (1n << 127n)
    const invalidIdentityAccounts = persisted.accounts.map((account, index) =>
      index === cashIndex ? { ...account, id: changedCashId } : account,
    )
    const invalidIdentityTransfers = persisted.transfers.map((transfer) => ({
      ...transfer,
      debit_account_id: transfer.debit_account_id === cash.id ? changedCashId : transfer.debit_account_id,
      credit_account_id: transfer.credit_account_id === cash.id ? changedCashId : transfer.credit_account_id,
    }))
    expect(
      assertFailure(validatePersistedRunEvidence(receipt, ledger, invalidIdentityAccounts, invalidIdentityTransfers)),
    ).toMatchObject({ operation: 'check-run', reason: 'invalid-account-metadata' })

    const fundingIndex = persisted.transfers.findIndex((transfer) => transfer.code === TransferCode.funding)
    assert.notEqual(fundingIndex, -1, 'ledger plan must contain deterministic funding')
    for (const replacement of [
      { ...persisted.transfers[fundingIndex], id: persisted.transfers[fundingIndex].id ^ (1n << 127n) },
      {
        ...persisted.transfers[fundingIndex],
        user_data_128: persisted.transfers[fundingIndex].user_data_128 ^ (1n << 127n),
      },
    ]) {
      const invalidFunding = persisted.transfers.map((transfer, index) =>
        index === fundingIndex ? replacement : transfer,
      )
      expect(
        assertFailure(validatePersistedRunEvidence(receipt, ledger, persisted.accounts, invalidFunding)),
      ).toMatchObject({ operation: 'check-run', reason: 'invalid-transfer-metadata' })
    }
  })

  test('rejects a transferless fixed account with the generic inventory code', () => {
    const { result, plan } = evaluationPlan()
    const persisted = materialize(plan)
    const fixedAccountIndex = persisted.accounts.findIndex((account) => account.code === AccountCode.cashYieldIncome)
    assert.notEqual(fixedAccountIndex, -1, 'ledger plan must contain the deterministic cash-yield-income account')
    const fixedAccount = persisted.accounts[fixedAccountIndex]
    expect(
      persisted.transfers.some(
        (transfer) => transfer.debit_account_id === fixedAccount.id || transfer.credit_account_id === fixedAccount.id,
      ),
    ).toBeFalse()
    const invalidAccounts = persisted.accounts.map((account, index) =>
      index === fixedAccountIndex ? { ...account, code: AccountCode.inventory } : account,
    )
    const receipt = {
      runId: result.runId,
      accountCount: persisted.accounts.length,
      transferCount: persisted.transfers.length,
      exact: true,
    } as const

    expect(
      assertFailure(validatePersistedRunEvidence(receipt, ledger, invalidAccounts, persisted.transfers)),
    ).toMatchObject({
      operation: 'check-run',
      reason: 'invalid-account-metadata',
      material: {
        account: { id: fixedAccount.id, code: AccountCode.inventory },
        expected: { deterministicId: fixedAccount.id, code: AccountCode.cashYieldIncome },
      },
    })
  })

  test('does not claim event-derived identity without the expected plan', () => {
    const { result, plan } = evaluationPlan()
    const persisted = materialize(plan)
    const eventTransferIndex = persisted.transfers.findIndex((transfer) => transfer.code !== TransferCode.funding)
    assert.notEqual(eventTransferIndex, -1, 'ledger plan must contain an event-derived transfer')
    const original = persisted.transfers[eventTransferIndex]
    const locallyConsistent = persisted.transfers.map((transfer, index) =>
      index === eventTransferIndex
        ? {
            ...transfer,
            id: original.id ^ (1n << 127n),
            user_data_128: original.user_data_128 ^ (1n << 127n),
          }
        : transfer,
    )
    const receipt = {
      runId: result.runId,
      accountCount: persisted.accounts.length,
      transferCount: persisted.transfers.length,
      exact: true,
    } as const

    expect(
      Result.isSuccess(validatePersistedRunEvidence(receipt, ledger, persisted.accounts, locallyConsistent)),
    ).toBeTrue()
    expect(Result.isFailure(reconcileLedgerPlan(plan, persisted.accounts, locallyConsistent))).toBeTrue()
  })
})
