import { describe, expect, test } from 'bun:test'
import type { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit } from 'effect'

import { BrokerReadErrorKind } from '../broker/alpaca/failures'
import { valkeyFixture } from '../testing/valkey-fixture'
import { makeBrokerObservationStore } from './broker-observations'

const unavailableRead = (diagnostic: Effect.Effect<readonly unknown[], unknown>) => {
  let queries = 0
  const sql = (() =>
    Effect.suspend(() => (++queries <= 2 ? Effect.succeed([]) : diagnostic))) as unknown as PgClient.PgClient
  return makeBrokerObservationStore(sql, 'private-account', 'a'.repeat(40), 60_000, valkeyFixture().cache).readState
}

describe('Broker observation revision diagnostic', () => {
  test.each([false, true])(
    'reports a verified foreign revision without changing rejection: %s',
    async (foreignRevision) => {
      const failure = await unavailableRead(Effect.succeed([{ foreignRevision }])).pipe(Effect.flip, Effect.runPromise)
      expect(failure.kind).toBe(BrokerReadErrorKind.Timeout)
      expect(failure.retryable).toBe(true)
      expect(failure.observationFailure).toBe('NO_ADMISSIBLE_CUT')
      expect(failure.message).toBe(
        foreignRevision
          ? 'Broker observation source revision differs from this runtime'
          : 'Broker observation is unavailable or invalidated by a mutation',
      )
      expect(failure.message).not.toContain('private-account')
    },
  )

  test('a failed diagnostic remains a typed persistence failure', async () => {
    const failure = await unavailableRead(Effect.fail(new Error('test database failure'))).pipe(
      Effect.flip,
      Effect.runPromise,
    )
    expect(failure.message).toBe('Broker observation persistence failed')
    expect(failure.observationFailure).toBeUndefined()
  })

  test('malformed diagnostic evidence cannot assert a revision mismatch', async () => {
    const failure = await unavailableRead(Effect.succeed([{ foreignRevision: 'true' }])).pipe(
      Effect.flip,
      Effect.runPromise,
    )
    expect(failure.message).toBe('Broker observation persistence failed')
  })

  test('diagnostic interruption remains interruption', async () => {
    const exit = await unavailableRead(Effect.interrupt).pipe(Effect.runPromiseExit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })
})
