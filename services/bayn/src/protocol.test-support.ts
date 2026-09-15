import { Result } from 'effect'

import { hashParametersResult, type Protocol } from './protocol'

export const hashParameters = (parameters: Protocol): string => Result.getOrThrow(hashParametersResult(parameters))
