import { Effect, Result } from 'effect'

import type { LiveCapitalGrantStoreShape } from '../db/live-capital-grant'
import {
  BrokerAccess,
  CapitalAuthorityKind,
  liveCapitalAuthority,
  makeExecutionAuthority,
  noCapitalAuthority,
  sandboxCapitalAuthority,
  type ExecutionAuthority,
  type ExecutionAuthorityConstructionFailure,
  type ExecutionStrategyIdentity,
} from './authority'
import type { ExecutionPolicy } from './configuration'

export type RuntimeAuthorityFailure =
  | {
      readonly _tag: 'LiveCapitalGrantMissing'
      readonly grantHash: string
    }
  | {
      readonly _tag: 'LiveCapitalGrantReadFailed'
      readonly grantHash: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'LiveCapitalGrantAuthorityGenerationMismatch'
      readonly grantHash: string
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'ExecutionAuthorityInvalid'
      readonly cause: ExecutionAuthorityConstructionFailure
    }

export interface RuntimeAuthorityInput {
  readonly policy: Exclude<ExecutionPolicy, { readonly brokerIdentity?: undefined }>
  readonly strategy: ExecutionStrategyIdentity
  readonly observedAt: string
}

export interface RuntimeAuthorityDependencies {
  readonly liveCapitalGrants: Pick<LiveCapitalGrantStoreShape, 'read'>
}

const construct = (
  input: RuntimeAuthorityInput,
  capitalAuthority:
    | typeof noCapitalAuthority
    | ReturnType<typeof sandboxCapitalAuthority>
    | ReturnType<typeof liveCapitalAuthority>,
): Effect.Effect<ExecutionAuthority, RuntimeAuthorityFailure> => {
  const authority = makeExecutionAuthority({
    brokerIdentity: input.policy.brokerIdentity,
    brokerAccess: input.policy.brokerAccess,
    capitalAuthority,
    strategy: input.strategy,
    observedAt: input.observedAt,
  })
  return Result.isFailure(authority)
    ? Effect.fail({ _tag: 'ExecutionAuthorityInvalid', cause: authority.failure })
    : Effect.succeed(authority.success)
}

export const resolveRuntimeAuthority = (
  input: RuntimeAuthorityInput,
  dependencies: RuntimeAuthorityDependencies,
): Effect.Effect<ExecutionAuthority, RuntimeAuthorityFailure> => {
  if (input.policy.brokerAccess === BrokerAccess.ReadOnly) {
    return construct(input, noCapitalAuthority)
  }
  if (input.policy.capitalAuthority._tag === CapitalAuthorityKind.Sandbox) {
    return construct(input, sandboxCapitalAuthority(input.policy.capitalAuthority.authorityGenerationHash))
  }
  if (input.policy.capitalAuthority._tag !== CapitalAuthorityKind.LiveGrant) {
    return Effect.fail({
      _tag: 'ExecutionAuthorityInvalid',
      cause: {
        _tag: 'MutationBrokerRequiresCapitalAuthority',
        environment: input.policy.brokerIdentity.environment,
      },
    })
  }
  const liveRequest = input.policy.capitalAuthority
  const grantHash = liveRequest.grantHash
  return dependencies.liveCapitalGrants.read(grantHash).pipe(
    Effect.mapError(
      (cause): RuntimeAuthorityFailure => ({
        _tag: 'LiveCapitalGrantReadFailed',
        grantHash,
        cause,
      }),
    ),
    Effect.flatMap((authority) =>
      authority === undefined
        ? Effect.fail<RuntimeAuthorityFailure>({
            _tag: 'LiveCapitalGrantMissing' as const,
            grantHash,
          })
        : authority.grant.authorityGenerationHash !== liveRequest.authorityGenerationHash
          ? Effect.fail<RuntimeAuthorityFailure>({
              _tag: 'LiveCapitalGrantAuthorityGenerationMismatch' as const,
              grantHash,
              expected: liveRequest.authorityGenerationHash,
              observed: authority.grant.authorityGenerationHash,
            })
          : construct(input, authority),
    ),
  )
}

export const renderRuntimeAuthorityFailure = (failure: RuntimeAuthorityFailure): string => {
  switch (failure._tag) {
    case 'LiveCapitalGrantMissing':
      return `persisted live capital grant ${failure.grantHash} was not found`
    case 'LiveCapitalGrantReadFailed':
      return `persisted live capital grant ${failure.grantHash} could not be read`
    case 'LiveCapitalGrantAuthorityGenerationMismatch':
      return `persisted live capital grant ${failure.grantHash} is not bound to the configured authority generation`
    case 'ExecutionAuthorityInvalid':
      return `execution authority is invalid: ${failure.cause._tag}`
  }
  const exhaustive: never = failure
  return exhaustive
}
