import { Result, Schema } from 'effect'

import { strictParseOptions } from '../schemas'
import { preparedAlphaSystemLatencyStressProtocolHash } from './latency-protocol'
import { PreparedAlphaSystemRegistrationSchema, preparedAlphaSystemQualificationPolicyHash } from './policy'
import { strategyBoundRegistrationFixture } from './strategy-registration.test-support'

export const preparedAlphaRegistrationFixture = (...args: Parameters<typeof strategyBoundRegistrationFixture>) => {
  const base = strategyBoundRegistrationFixture(...args)
  return Schema.decodeUnknownSync(
    PreparedAlphaSystemRegistrationSchema,
    strictParseOptions,
  )({
    ...base,
    schemaVersion: 'bayn.system-registration.v7',
    policyHash: Result.getOrThrow(preparedAlphaSystemQualificationPolicyHash()),
    latencyStressProtocolHash: Result.getOrThrow(preparedAlphaSystemLatencyStressProtocolHash()),
  })
}
