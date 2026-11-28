import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { AuthenticationError, AuthorizationError, ConnectionError, SqlError } from 'effect/sql/SqlError'

import { CycleObservabilityError } from './cycle/store/observability'
import { DatabaseError } from './db/database-error'
import { databaseOperation } from './operations'

describe('Bayn database operation failures', () => {
  test('keeps authentication and authorization terminal while retrying transient availability failures', async () => {
    const classify = (cause: SqlError) =>
      Effect.runPromise(
        Effect.flip(
          databaseOperation(
            Effect.fail(
              new DatabaseError({
                failure: 'unavailable',
                operation: 'recover-evaluation',
                message: cause.message,
                cause,
              }),
            ),
            'recover-evaluation',
          ),
        ),
      )

    const [authentication, authorization, connection] = await Promise.all([
      classify(
        SqlError.make({
          reason: AuthenticationError.make({ cause: new Error('invalid credentials'), operation: 'connect' }),
        }),
      ),
      classify(
        SqlError.make({
          reason: AuthorizationError.make({ cause: new Error('permission denied'), operation: 'query' }),
        }),
      ),
      classify(
        SqlError.make({
          reason: ConnectionError.make({ cause: new Error('connection reset'), operation: 'query' }),
        }),
      ),
    ])

    expect(authentication.retryable).toBe(false)
    expect(authorization.retryable).toBe(false)
    expect(connection.retryable).toBe(true)
  })

  test('preserves transient cycle-observability query retryability without widening the error boundary', async () => {
    const classify = (cause: SqlError) =>
      Effect.runPromise(
        Effect.flip(
          databaseOperation(
            Effect.fail(
              new CycleObservabilityError({
                operation: 'read',
                failure: 'query',
                message: cause.message,
                cause,
              }),
            ),
            'cycle-observability',
          ),
        ),
      )

    const [connection, authorization] = await Promise.all([
      classify(
        SqlError.make({
          reason: ConnectionError.make({ cause: new Error('connection reset'), operation: 'query' }),
        }),
      ),
      classify(
        SqlError.make({
          reason: AuthorizationError.make({ cause: new Error('permission denied'), operation: 'query' }),
        }),
      ),
    ])

    expect(connection).toMatchObject({
      component: 'database',
      operation: 'cycle-observability',
      retryable: true,
    })
    expect(connection.cause).toBeInstanceOf(CycleObservabilityError)
    expect(authorization.retryable).toBe(false)
  })
})
