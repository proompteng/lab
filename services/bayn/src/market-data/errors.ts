import { isSqlError } from 'effect/unstable/sql/SqlError'

import { OperationalError, operationalError, retryableOperationalError } from '../errors'

export const marketDataOperationError = (
  operation: 'check' | 'inspect' | 'inspect-publication' | 'load',
  message: string,
  cause: unknown,
): OperationalError => {
  if (cause instanceof OperationalError) return cause
  const makeError = isSqlError(cause) && !cause.isRetryable ? operationalError : retryableOperationalError
  return makeError('market-data', operation, message, cause)
}
