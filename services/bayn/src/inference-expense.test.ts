import { describe, expect, test } from 'bun:test'
import { Cause, Deferred, Effect, Exit, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { canonicalHashV1 } from './hash'
import { InferenceCostError, InferenceUsageStatus } from './inference-costs'
import { provideTestLayer } from './effect-test-support'
import {
  buildInferenceExpensePlan,
  decodeInferenceExpenseQuote,
  inferenceExpenseLedger,
  makeInferenceExpenseQuote,
  verifyInferenceExpenseCoverage,
  verifyInferenceExpenseQuote,
} from './inference-expense'
import { expenseRateFixture, expenseSourceFixture } from './inference-expense.test-support'
import { inferenceExpenseLoop } from './inference-expense-runtime'

const quote = (options: Parameters<typeof expenseSourceFixture>[0] = {}) =>
  Result.getOrThrow(makeInferenceExpenseQuote(expenseSourceFixture(options), expenseRateFixture))

describe('inference expense quote and deterministic plan', () => {
  test('records each sub-micro expense exactly without touching broker cash accounts', () => {
    const first = quote()
    const second = quote({ key: 'b' })
    const plan = Result.getOrThrow(buildInferenceExpensePlan([first, second]))
    expect(plan.accounts).toHaveLength(2)
    expect(plan.transfers).toHaveLength(2)
    expect(plan.transfers.map((transfer) => transfer.amount)).toEqual([42000n, 42000n])
    expect(plan.transfers.every((transfer) => transfer.ledger === inferenceExpenseLedger)).toBe(true)
    expect(plan.accounts.map((account) => account.code).sort((left, right) => left - right)).toEqual([230, 510])
    expect(plan.transfers.every((transfer) => transfer.debit_account_id !== transfer.credit_account_id)).toBe(true)
    expect(first.quoteHash).toBe(quote().quoteHash)
    expect(first.line.estimatedCostPicoUsd).toBe('42000')
  })

  test('replays identical quotes once and rejects a second price for the same request', () => {
    const first = quote()
    expect(Result.getOrThrow(buildInferenceExpensePlan([first, first])).transfers).toHaveLength(1)
    const changed = Result.getOrThrow(
      makeInferenceExpenseQuote(expenseSourceFixture(), {
        ...expenseRateFixture,
        rates: [{ ...expenseRateFixture.rates[0], inputMicrosPerMillionTokens: '43000' }],
      }),
    )
    expect(Result.isFailure(buildInferenceExpensePlan([first, changed]))).toBe(true)
    expect(Result.getOrThrow(buildInferenceExpensePlan([first])).transfers[0]?.id).toBe(
      Result.getOrThrow(buildInferenceExpensePlan([changed])).transfers[0]?.id,
    )
    const free = Result.getOrThrow(
      makeInferenceExpenseQuote(expenseSourceFixture(), {
        ...expenseRateFixture,
        rates: [{ ...expenseRateFixture.rates[0], inputMicrosPerMillionTokens: '0' }],
      }),
    )
    expect(Result.isFailure(buildInferenceExpensePlan([free, first]))).toBe(true)
  })

  test('prices rejected and permanently abandoned responses without enabling their decisions', () => {
    const rejected = quote({ rejected: true })
    const abandoned = quote({ key: 'b', abandoned: true })
    expect(rejected.line.usageStatus).toBe(InferenceUsageStatus.Rejected)
    const plan = Result.getOrThrow(buildInferenceExpensePlan([rejected, abandoned]))
    expect(plan.transfers).toHaveLength(2)
    expect(plan.transfers.reduce((sum, transfer) => sum + transfer.amount, 0n)).toBe(84000n)
  })

  test('preserves missing and unpriced usage without posting fabricated zero expenses', () => {
    const missing = quote({ missing: true })
    const unpriced = Result.getOrThrow(
      makeInferenceExpenseQuote(expenseSourceFixture({ key: 'b' }), {
        schemaVersion: 'bayn.inference-rate-card.v1',
        rates: [],
      }),
    )
    expect(missing.line.estimatedCostPicoUsd).toBeNull()
    expect(unpriced.line.inputTokens).toBe('1')
    expect(unpriced.line.estimatedCostPicoUsd).toBeNull()
    expect(Result.getOrThrow(buildInferenceExpensePlan([missing, unpriced]))).toEqual({ accounts: [], transfers: [] })
    const zero = quote({ inputTokens: 0 })
    expect(zero.line.estimatedCostPicoUsd).toBe('0')
    expect(Result.getOrThrow(buildInferenceExpensePlan([zero])).accounts).toHaveLength(2)
    expect(Result.getOrThrow(buildInferenceExpensePlan([zero])).transfers).toHaveLength(0)
  })

  test('a late metered receipt replaces the gap in request coverage and creates only one expense', () => {
    const missing = quote({ missing: true })
    const late = quote({ abandoned: true })
    expect(late.line.requestId).toBe(missing.line.requestId)
    expect(late.quoteHash).not.toBe(missing.quoteHash)
    expect(Result.getOrThrow(buildInferenceExpensePlan([missing, late])).transfers).toHaveLength(1)
  })

  test('binds account and session without including account identity in the quote', () => {
    const first = quote()
    const other = quote({ accountId: 'other-account' })
    expect(first.accountBindingHash).not.toBe(other.accountBindingHash)
    expect(JSON.stringify(first)).not.toContain('fixture-account')
    expect(
      Result.isFailure(verifyInferenceExpenseQuote(expenseSourceFixture({ accountId: 'other-account' }), first)),
    ).toBe(true)
    const laterCut = { ...expenseSourceFixture(), asOf: '1970-01-01T01:00:00.000Z' }
    expect(Result.getOrThrow(makeInferenceExpenseQuote(laterCut, expenseRateFixture)).quoteHash).toBe(first.quoteHash)
  })

  test('rejects a rehashed amount that differs from recorded usage and a corrupted receipt', () => {
    const valid = quote()
    const { quoteHash: _hash, ...material } = valid
    const forged = { ...material, line: { ...material.line, estimatedCostPicoUsd: '84000' } }
    expect(Result.isFailure(decodeInferenceExpenseQuote({ ...forged, quoteHash: canonicalHashV1(forged) }))).toBe(true)
    expect(
      Result.isFailure(makeInferenceExpenseQuote({ ...expenseSourceFixture(), receipt: {} }, expenseRateFixture)),
    ).toBe(true)
  })

  test('requires all claimed requests and verified frozen prices before claiming metered coverage', () => {
    const source = expenseSourceFixture()
    const { accountId: _account, sessionDate: _date, asOf: _cut, ...request } = source
    const priced = quote()
    const evidence = {
      schemaVersion: 'bayn.inference-cost-evidence.v1' as const,
      accountBindingHash: priced.accountBindingHash,
      sessionDate: source.sessionDate,
      asOf: source.asOf,
      requests: [request],
    }
    expect(Result.getOrThrow(verifyInferenceExpenseCoverage(evidence, source.accountId, [])).missingQuoteCount).toBe(1)
    expect(
      Result.getOrThrow(
        verifyInferenceExpenseCoverage(evidence, source.accountId, [{ quote: priced, verifiedAt: null }]),
      ).completeMeteredCoverage,
    ).toBe(false)
    expect(
      Result.getOrThrow(
        verifyInferenceExpenseCoverage(evidence, source.accountId, [{ quote: priced, verifiedAt: source.asOf }]),
      ).completeMeteredCoverage,
    ).toBe(true)
    expect(Result.isFailure(verifyInferenceExpenseCoverage(evidence, 'other-account', []))).toBe(true)
    expect(
      Result.isFailure(
        verifyInferenceExpenseCoverage({ ...evidence, requests: [] }, source.accountId, [
          { quote: priced, verifiedAt: source.asOf },
        ]),
      ),
    ).toBe(true)
  })

  test('keeps a retained gap incomplete and verifies a later receipt against its original graph', () => {
    const source = expenseSourceFixture({ missing: true })
    const { accountId: _account, sessionDate: _date, asOf: _cut, ...request } = source
    const gap = quote({ missing: true })
    const evidence = {
      schemaVersion: 'bayn.inference-cost-evidence.v1' as const,
      accountBindingHash: gap.accountBindingHash,
      sessionDate: source.sessionDate,
      asOf: source.asOf,
      requests: [request],
    }
    const incomplete = Result.getOrThrow(
      verifyInferenceExpenseCoverage(evidence, source.accountId, [{ quote: gap, verifiedAt: source.asOf }]),
    )
    expect(incomplete.gapRequestCount).toBe(1)
    expect(incomplete.completeMeteredCoverage).toBe(false)
    const late = quote({ abandoned: true })
    const {
      accountId: _lateAccount,
      sessionDate: _lateDate,
      asOf: _lateCut,
      ...lateRequest
    } = expenseSourceFixture({ abandoned: true })
    const complete = Result.getOrThrow(
      verifyInferenceExpenseCoverage({ ...evidence, requests: [lateRequest] }, source.accountId, [
        { quote: gap, verifiedAt: source.asOf },
        { quote: late, verifiedAt: source.asOf },
      ]),
    )
    expect(complete.claimedRequestCount).toBe(1)
    expect(complete.completeMeteredCoverage).toBe(true)
  })
})

describe('scoped inference expense background loop', () => {
  test('retries a typed failure after the interval and finalizes its owned pass once on interruption', async () => {
    let starts = 0
    let releases = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const pass = Effect.gen(function* () {
            starts++
            if (starts === 1) return yield* new InferenceCostError({ message: 'synthetic unavailable' })
            yield* Deferred.succeed(entered, undefined)
            return yield* Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  releases++
                }),
              ),
            )
          })
          const fiber = yield* inferenceExpenseLoop(pass).pipe(Effect.forkScoped)
          yield* TestClock.adjust('30 seconds')
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(provideTestLayer(TestClock.layer())),
    )
    expect(starts).toBe(2)
    expect(releases).toBe(1)
  })

  test('does not turn a defect into successful accounting', async () => {
    const exit = await Effect.runPromiseExit(inferenceExpenseLoop(Effect.die('synthetic accounting defect')))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(Result.getOrThrow(Cause.findDie(exit.cause)).defect).toBe('synthetic accounting defect')
  })
})
