import { Effect, Result } from 'effect'

import { BrokerEnvironment, type BrokerIdentity } from '../broker/identity'
import {
  BrokerAccess,
  grantedCapitalAuthority,
  makeExecutionAuthority,
  type GrantedCapitalAuthority,
  type ExecutionAuthority,
  type ExecutionAuthorityConstructionFailure,
  type ExecutionStrategyIdentity,
} from './authority'
import {
  CapitalAuthoritySelection,
  resolveExecutionPolicy,
  type ExecutionPolicy,
  type ExecutionPolicyResolutionFailure,
} from './configuration'

export type RuntimeAuthorityFailure = {
  readonly _tag: 'ExecutionAuthorityInvalid'
  readonly cause: ExecutionAuthorityConstructionFailure
}

export type PreparedExecutionPolicy = Extract<ExecutionPolicy, { readonly brokerAccess: BrokerAccess.Mutation }>

export type PreparedExecutionPolicyFailure =
  | {
      readonly _tag: 'ConfiguredBrokerIdentityMismatch'
      readonly configuredIdentityHash: string
      readonly runtimeIdentityHash: string
    }
  | {
      readonly _tag: 'LegacyActivationRequiresSandbox'
      readonly environment: BrokerEnvironment
    }
  | {
      readonly _tag: 'LegacySandboxPolicyInvalid'
      readonly cause: ExecutionPolicyResolutionFailure
    }

export type PreparedExecutionAuthorityFailure =
  | RuntimeAuthorityFailure
  | {
      readonly _tag: 'PersistedCapitalGrantHashMissing'
    }
  | {
      readonly _tag: 'PersistedCapitalGrantMissing'
      readonly grantHash: string
    }

export const resolvePreparedExecutionPolicy = (input: {
  readonly configured: ExecutionPolicy
  readonly brokerIdentity: BrokerIdentity
  readonly preparedGenerationHash: string
}): Result.Result<PreparedExecutionPolicy, PreparedExecutionPolicyFailure> => {
  if (
    input.configured.brokerIdentity !== undefined &&
    input.configured.brokerIdentity.identityHash !== input.brokerIdentity.identityHash
  ) {
    return Result.fail({
      _tag: 'ConfiguredBrokerIdentityMismatch',
      configuredIdentityHash: input.configured.brokerIdentity.identityHash,
      runtimeIdentityHash: input.brokerIdentity.identityHash,
    })
  }

  if (input.configured.brokerAccess === BrokerAccess.Mutation) {
    return Result.succeed({
      ...input.configured,
      capitalAuthority: {
        ...input.configured.capitalAuthority,
        authorityGenerationHash: input.preparedGenerationHash,
      },
    })
  }

  if (input.brokerIdentity.environment !== BrokerEnvironment.Sandbox) {
    return Result.fail({
      _tag: 'LegacyActivationRequiresSandbox',
      environment: input.brokerIdentity.environment,
    })
  }
  const policy = resolveExecutionPolicy({
    brokerIdentity: input.brokerIdentity,
    brokerAccess: BrokerAccess.Mutation,
    capitalAuthority: CapitalAuthoritySelection.Granted,
    authorityGenerationHash: input.preparedGenerationHash,
    persistedCapitalGrantHash: undefined,
  })
  return Result.isFailure(policy)
    ? Result.fail({ _tag: 'LegacySandboxPolicyInvalid', cause: policy.failure })
    : Result.succeed(policy.success as PreparedExecutionPolicy)
}

export const resolvePreparedExecutionAuthority = <E>(input: {
  readonly executionPolicy: PreparedExecutionPolicy
  readonly brokerIdentity: BrokerIdentity
  readonly strategy: ExecutionStrategyIdentity
  readonly observedAt: string
  readonly readPersistedCapitalGrant: (grantHash: string) => Effect.Effect<GrantedCapitalAuthority | undefined, E>
}): Effect.Effect<ExecutionAuthority, PreparedExecutionAuthorityFailure | E> => {
  const capitalAuthority = input.executionPolicy.capitalAuthority
  const resolveAuthority = (
    resolvedCapitalAuthority: GrantedCapitalAuthority,
  ): Effect.Effect<ExecutionAuthority, RuntimeAuthorityFailure> => {
    const authority = makeExecutionAuthority({
      brokerIdentity: input.brokerIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: resolvedCapitalAuthority,
      strategy: input.strategy,
      observedAt: input.observedAt,
    })
    return Result.isFailure(authority)
      ? Effect.fail({ _tag: 'ExecutionAuthorityInvalid' as const, cause: authority.failure })
      : Effect.succeed(authority.success)
  }

  if (input.brokerIdentity.environment === BrokerEnvironment.Sandbox) {
    return resolveAuthority(grantedCapitalAuthority(capitalAuthority.authorityGenerationHash))
  }

  const grantHash = capitalAuthority.persistedGrantHash
  if (grantHash === undefined) return Effect.fail({ _tag: 'PersistedCapitalGrantHashMissing' })
  return input.readPersistedCapitalGrant(grantHash).pipe(
    Effect.flatMap(
      (
        persisted,
      ): Effect.Effect<
        ExecutionAuthority,
        RuntimeAuthorityFailure | { readonly _tag: 'PersistedCapitalGrantMissing'; readonly grantHash: string }
      > =>
        persisted === undefined
          ? Effect.fail({ _tag: 'PersistedCapitalGrantMissing' as const, grantHash })
          : resolveAuthority({
              ...persisted,
              authorityGenerationHash: capitalAuthority.authorityGenerationHash,
            }),
    ),
  )
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
    capitalAuthority: grantedCapitalAuthority(input.generationHash),
    strategy: input.strategy,
    observedAt: input.observedAt,
  })
  return Result.isFailure(authority)
    ? Effect.fail({ _tag: 'ExecutionAuthorityInvalid', cause: authority.failure })
    : Effect.succeed(authority.success)
}
