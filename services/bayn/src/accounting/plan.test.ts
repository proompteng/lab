import { describe, expect, test } from 'bun:test'
import { Effect, Either } from 'effect'

import type { BaynAccountingValidationError } from './errors'
import { BAYN_ACCOUNTING_MODEL_V1, MAX_U128 } from './model'
import { buildJournalPlan } from './plan'
import { evaluationFixture } from './test-support'
import type { BaynEvaluationEconomicsV1 } from './types'

const build = (evaluation: BaynEvaluationEconomicsV1) => Effect.runSync(buildJournalPlan(evaluation))

const validationError = (evaluation: BaynEvaluationEconomicsV1): BaynAccountingValidationError => {
  const result = Effect.runSync(buildJournalPlan(evaluation).pipe(Effect.either))
  if (Either.isRight(result)) throw new Error('expected validation to fail')
  return result.left
}

describe('Bayn journal planning', () => {
  test('reproduces every evaluator economic event and ending balance exactly', () => {
    const plan = build(evaluationFixture())

    expect(plan.accounts).toHaveLength(8)
    expect(plan.transfers).toHaveLength(10)
    expect(plan.transfers.filter(({ kind }) => kind === 'trade-cash')).toHaveLength(2)
    expect(plan.transfers.filter(({ kind }) => kind === 'trade-quantity')).toHaveLength(2)
    expect(plan.transfers.filter(({ kind }) => kind === 'fee')).toHaveLength(2)
    expect(plan.transfers.filter(({ kind }) => kind === 'cash-entry')).toHaveLength(2)

    const cash = plan.accounts.find(({ kind }) => kind === 'cash')!
    expect(cash.expectedDebitsPosted).toBe(1_260_000_000n)
    expect(cash.expectedCreditsPosted).toBe(651_500_000n)
    expect(cash.expectedDebitsPosted - cash.expectedCreditsPosted).toBe(plan.expected.endingCash)

    const spy = plan.accounts.find(({ kind }) => kind === 'security-position')!
    expect(spy.expectedDebitsPosted - spy.expectedCreditsPosted).toBe(150_000_000n)
    expect(plan.expected.positions.SPY).toEqual({ quantity: 150_000_000n, marketValue: 480_000_000n })
  })

  test('uses versioned codes, ledgers, units, and non-negative account guards', () => {
    const plan = build(evaluationFixture())
    expect(new Set(plan.accounts.map(({ ledger }) => ledger))).toEqual(
      new Set([BAYN_ACCOUNTING_MODEL_V1.ledgers.usdMicros, BAYN_ACCOUNTING_MODEL_V1.ledgers.shareE8]),
    )
    expect(plan.accounts.every(({ code }) => Object.values(BAYN_ACCOUNTING_MODEL_V1.accountCodes).includes(code))).toBe(
      true,
    )
    expect(
      plan.transfers.every(({ code }) => Object.values(BAYN_ACCOUNTING_MODEL_V1.transferCodes).includes(code)),
    ).toBe(true)
    expect(plan.accounts.find(({ kind }) => kind === 'cash')!.account.flags).not.toBe(0)
    expect(plan.accounts.find(({ kind }) => kind === 'security-position')!.account.flags).not.toBe(0)
  })

  test('derives every deterministic ID and content fingerprint inside the non-zero u128 range', () => {
    const first = build(evaluationFixture())
    const replay = build(evaluationFixture())
    const firstIds = [
      first.evaluationFingerprint,
      ...first.accounts.map(({ account }) => account.id),
      ...first.transfers.map(({ transfer }) => transfer.id),
    ]
    const replayIds = [
      replay.evaluationFingerprint,
      ...replay.accounts.map(({ account }) => account.id),
      ...replay.transfers.map(({ transfer }) => transfer.id),
    ]

    expect(firstIds).toEqual(replayIds)
    expect(firstIds.every((id) => id > 0n && id <= MAX_U128)).toBe(true)
    expect(new Set(firstIds).size).toBe(firstIds.length)
  })

  test('supports a zero starting balance without emitting an invalid zero-amount transfer', () => {
    const evaluation = evaluationFixture()
    evaluation.initialCash = 0n
    evaluation.cashEntries[0]!.amount += 1_000_000_000n
    const plan = build(evaluation)

    expect(plan.transfers.some(({ kind }) => kind === 'initial-cash')).toBe(false)
    expect(plan.transfers.every(({ transfer }) => transfer.amount > 0n)).toBe(true)
    expect(plan.accounts.find(({ kind }) => kind === 'cash')!.expectedDebitsPosted).toBe(1_260_000_000n)
  })

  test('rejects evaluator cash, fee, position, and equity mismatches before journaling', () => {
    const cash = evaluationFixture()
    cash.ending.cash += 1n
    expect(validationError(cash).rule).toBe('ending-cash-exact')

    const fees = evaluationFixture()
    fees.ending.totalFees += 1n
    expect(validationError(fees).rule).toBe('fees-exact')

    const position = evaluationFixture()
    position.ending.positions[0]!.quantity += 1n
    expect(validationError(position).rule).toBe('ending-positions-exact')

    const equity = evaluationFixture()
    equity.ending.equity += 1n
    expect(validationError(equity).rule).toBe('ending-equity-exact')
  })

  test('rejects duplicate stable identities and unsafe event order', () => {
    const duplicate = evaluationFixture()
    duplicate.fees[0]!.eventId = duplicate.trades[0]!.eventId
    expect(validationError(duplicate).rule).toBe('stable-identities')

    const overspend = evaluationFixture()
    overspend.trades[0]!.grossAmount = 1_200_000_000n
    overspend.ending.cash = 8_500_000n
    overspend.ending.equity = 488_500_000n
    expect(validationError(overspend).rule).toBe('cash-only')

    const short = evaluationFixture()
    short.trades[0]!.side = 'SELL'
    expect(validationError(short).rule).toBe('long-only')

    const oversized = evaluationFixture()
    oversized.initialCash = MAX_U128 + 1n
    expect(validationError(oversized).rule).toBe('amount-range')
  })
})
