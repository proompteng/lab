import { describe, expect, test } from 'bun:test'

import { ConnectionError, DeadlockError, SqlError, SqlSyntaxError, UniqueViolation } from 'effect/unstable/sql/SqlError'

import { classifyDatabaseError } from './errors'

describe('evidence persistence error classification', () => {
  test('retains connectivity, transaction, constraint, and query distinctions', () => {
    const cases = [
      [new ConnectionError({ cause: new Error('reset'), operation: 'connect' }), 'unavailable', 'connectivity'],
      [new DeadlockError({ cause: new Error('deadlock'), operation: 'query' }), 'unavailable', 'transaction'],
      [
        new UniqueViolation({ cause: new Error('duplicate'), operation: 'query', constraint: 'evaluation_runs_pkey' }),
        'constraint',
        'constraint',
      ],
      [new SqlSyntaxError({ cause: new Error('syntax'), operation: 'query' }), 'query', 'query'],
    ] as const

    for (const [reason, failure, persistenceFailure] of cases) {
      expect(classifyDatabaseError('persist', new SqlError({ reason }))).toMatchObject({
        failure,
        persistenceFailure,
        operation: 'persist',
      })
    }
  })
})
