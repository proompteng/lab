import { Effect, Result } from 'effect'

import { BrokerEnvironment, type BrokerIdentity } from '../broker/identity'
import {
  BrokerAccess,
  CapitalAuthorityKind,
  makeExecutionAuthority,
  type ExecutionAuthority,
  type ExecutionAuthorityConstructionFailure,
  type ExecutionStrategyIdentity,
} from './authority'

export type RuntimeAuthorityFailure = {
  readonly _tag: 'ExecutionAuthorityInvalid'
  readonly cause: ExecutionAuthorityConstructionFailure
}

export const resolvePreparedSandboxAuthority = (input: {
  readonly brokerIdentity: BrokerIdentity & { readonly environment: BrokerEnvironment.Sandbox }
  readonly strategy: ExecutionStrategyIdentity
  readonly generationHash: string
  readonly observedAt: string
}): Effect.Effect<ExecutionAuthority, RuntimeAuthorityFailure> => {
  const authority = makeExecutionAuthority({
    brokerIdentity: input.brokerIdentity,
    brokerAccess: BrokerAccess.Mutation,
    capitalAuthority: {
      _tag: CapitalAuthorityKind.Sandbox,
      authorityGenerationHash: input.generationHash,
    },
    strategy: input.strategy,
    observedAt: input.observedAt,
  })
  return Result.isFailure(authority)
    ? Effect.fail({ _tag: 'ExecutionAuthorityInvalid', cause: authority.failure })
    : Effect.succeed(authority.success)
}
