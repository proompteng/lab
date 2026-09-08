import { Result } from 'effect'

import { makeStrategyProtocolHashResult, type RuntimeProvenance } from './contracts'

export const makeStrategyProtocolHash = (strategy: RuntimeProvenance['strategy']): string =>
  Result.getOrThrow(makeStrategyProtocolHashResult(strategy))
