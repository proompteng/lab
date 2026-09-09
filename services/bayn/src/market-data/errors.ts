import { isSqlError } from 'effect/unstable/sql/SqlError'

import { OperationalError, operationalError, retryableOperationalError } from '../errors'
import { isMarketDataVerificationError, renderMarketDataVerificationError } from '../market-data-verification'
import { Pipeable } from '../pipeable'

const marketDataOperationErrorDataFirst = (
  operation: 'check' | 'inspect' | 'inspect-publication' | 'load',
  message: string,
  cause: unknown,
): OperationalError => {
  if (cause instanceof OperationalError) return cause
  if (isSqlError(cause)) {
    const makeError = cause.isRetryable ? retryableOperationalError : operationalError
    return makeError({ component: 'market-data', operation, message, cause })
  }
  if (isMarketDataVerificationError(cause)) {
    return new OperationalError({
      component: 'market-data',
      operation,
      message: renderMarketDataVerificationError(cause),
      retryable: false,
      cause,
    })
  }
  return retryableOperationalError({ component: 'market-data', operation, message, cause })
}

export const marketDataOperationError = Pipeable.dual(3, marketDataOperationErrorDataFirst)
