import { Data } from 'effect'

export type DatabaseFailure = 'constraint' | 'decode' | 'invariant' | 'migration' | 'query' | 'unavailable'
export type PersistenceFailure = 'connectivity' | 'constraint' | 'decode' | 'invariant' | 'query' | 'transaction'

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly failure: DatabaseFailure
  readonly persistenceFailure?: PersistenceFailure
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}
