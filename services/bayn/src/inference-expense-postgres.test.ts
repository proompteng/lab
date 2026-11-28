import { expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { makeInferenceExpenseQuote } from './inference-expense'
import { decodeInferenceExpenseSessionRows } from './inference-expense-postgres'
import { expenseRateFixture, expenseSourceFixture } from './inference-expense.test-support'

test('retains every valid cost record in a session beyond ten thousand quotes', async () => {
  const quotes = Array.from({ length: 10_001 }, (_, index) =>
    Result.getOrThrow(
      makeInferenceExpenseQuote(
        expenseSourceFixture({ observedAt: new Date(index).toISOString() }),
        expenseRateFixture,
      ),
    ),
  )
  const captured = await Effect.runPromise(
    decodeInferenceExpenseSessionRows(
      quotes.map((quote) => ({
        quoteHash: quote.quoteHash,
        payload: quote,
        verifiedAt: '1970-01-01T00:01:00.001Z',
      })),
      quotes[0]!.sessionDate,
    ),
  )
  expect(captured).toHaveLength(quotes.length)
  expect(captured.every((row, index) => row.quote.quoteHash === quotes[index]?.quoteHash)).toBe(true)
  const tampered = await Effect.runPromise(
    Effect.result(
      decodeInferenceExpenseSessionRows(
        captured.map((row, index) => ({
          quoteHash: index === captured.length - 1 ? 'f'.repeat(64) : row.quote.quoteHash,
          payload: row.quote,
          verifiedAt: row.verifiedAt,
        })),
        quotes[0]!.sessionDate,
      ),
    ),
  )
  expect(Result.isFailure(tampered)).toBe(true)
  if (Result.isFailure(tampered)) expect(tampered.failure.message).toContain('identity differs')
}, 15_000)
