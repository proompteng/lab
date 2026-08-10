import { pipe, Result, Schema } from 'effect'

import {
  BrokerEnvironment,
  BrokerEnvironmentSchema,
  BrokerIdentitySchema,
  type BrokerIdentity,
} from '../broker/identity'
import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import {
  PositiveMicrosSchema as PositiveMicros,
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  UtcInstantSchema as UtcInstant,
  strictParseOptions as StrictParseOptions,
} from '../schemas'
import { Pipeable } from '../pipeable'

export { BrokerEnvironment, BrokerEnvironmentSchema }

export enum BrokerAccess {
  ReadOnly = 'read-only',
  Mutation = 'mutation',
}

export const BrokerAccessSchema = Schema.Enum(BrokerAccess)

export enum CapitalAuthorityKind {
  None = 'none',
  Sandbox = 'sandbox-capital',
  LiveGrant = 'live-capital-grant',
}

export interface NoCapitalAuthority {
  readonly _tag: CapitalAuthorityKind.None
}

export interface SandboxCapitalAuthority {
  readonly _tag: CapitalAuthorityKind.Sandbox
  readonly authorityGenerationHash: string
}

export interface LiveCapitalLimits {
  readonly maxGrossNotionalMicros: string
  readonly maxOrderNotionalMicros: string
  readonly maxPositionNotionalMicros: string
  readonly maxDailyLossMicros: string
  readonly maxOpenOrders: number
}

export interface ExecutionStrategyIdentity {
  readonly name: string
  readonly behaviorHash: string
  readonly parameterHash: string
  readonly parameterSchemaVersion: string
}

export const LiveCapitalLimitsSchema = Schema.Struct({
  maxGrossNotionalMicros: PositiveMicros,
  maxOrderNotionalMicros: PositiveMicros,
  maxPositionNotionalMicros: PositiveMicros,
  maxDailyLossMicros: PositiveMicros,
  maxOpenOrders: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
})

export const ExecutionStrategyIdentitySchema = Schema.Struct({
  name: NonEmptyString,
  behaviorHash: Sha256,
  parameterHash: Sha256,
  parameterSchemaVersion: NonEmptyString,
})

export const LiveCapitalGrantMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.live-capital-grant.v1'),
  brokerIdentity: BrokerIdentitySchema,
  authorityGenerationHash: Sha256,
  strategy: ExecutionStrategyIdentitySchema,
  limits: LiveCapitalLimitsSchema,
  validFrom: UtcInstant,
  validUntil: UtcInstant,
  issuedAt: UtcInstant,
  issuedBy: NonEmptyString,
})
export type LiveCapitalGrantMaterial = typeof LiveCapitalGrantMaterialSchema.Type

const LiveCapitalGrantBase = Schema.Struct({
  ...LiveCapitalGrantMaterialSchema.fields,
  grantHash: Sha256,
})

export const LiveCapitalGrantSchema = LiveCapitalGrantBase.check(
  Schema.makeFilter((grant: typeof LiveCapitalGrantBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
    if (grant.brokerIdentity.environment !== BrokerEnvironment.Live) {
      issues.push({ path: ['brokerIdentity', 'environment'], issue: 'must be live' })
    }
    if (grant.validUntil <= grant.validFrom) {
      issues.push({ path: ['validUntil'], issue: 'must be after validFrom' })
    }
    if (grant.issuedAt > grant.validFrom) {
      issues.push({ path: ['issuedAt'], issue: 'must not be after validFrom' })
    }
    const { grantHash, ...material } = grant
    const expected = canonicalHashV1Result(material)
    if (Result.isFailure(expected) || grantHash !== expected.success) {
      issues.push({ path: ['grantHash'], issue: 'must match the immutable grant material' })
    }
    return issues
  }),
)
export type LiveCapitalGrant = typeof LiveCapitalGrantSchema.Type

export const LiveCapitalGrantRevocationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.live-capital-grant-revocation.v1'),
  revokedAt: UtcInstant,
  revokedBy: NonEmptyString,
  reason: NonEmptyString,
})
export type LiveCapitalGrantRevocation = typeof LiveCapitalGrantRevocationSchema.Type

export interface LiveCapitalAuthority {
  readonly _tag: CapitalAuthorityKind.LiveGrant
  readonly grant: LiveCapitalGrant
  readonly revocation?: LiveCapitalGrantRevocation
}

export type CapitalAuthority = NoCapitalAuthority | SandboxCapitalAuthority | LiveCapitalAuthority

export const noCapitalAuthority: NoCapitalAuthority = Object.freeze({ _tag: CapitalAuthorityKind.None })

export const sandboxCapitalAuthority = (authorityGenerationHash: string): SandboxCapitalAuthority => ({
  _tag: CapitalAuthorityKind.Sandbox,
  authorityGenerationHash,
})

const liveCapitalAuthorityDataFirst = (
  grant: LiveCapitalGrant,
  revocation?: LiveCapitalGrantRevocation,
): LiveCapitalAuthority => ({
  _tag: CapitalAuthorityKind.LiveGrant,
  grant,
  ...(revocation === undefined ? {} : { revocation }),
})

export const liveCapitalAuthority = Pipeable.by<
  (
    revocation?: LiveCapitalGrantRevocation,
  ) => (grant: LiveCapitalGrant) => ReturnType<typeof liveCapitalAuthorityDataFirst>,
  typeof liveCapitalAuthorityDataFirst
>(
  (arguments_) =>
    typeof arguments_[0] === 'object' &&
    arguments_[0] !== null &&
    arguments_[0].schemaVersion === 'bayn.live-capital-grant.v1',
  liveCapitalAuthorityDataFirst,
)

export type ExecutionAuthority =
  | {
      readonly brokerIdentity: BrokerIdentity
      readonly brokerAccess: BrokerAccess.ReadOnly
      readonly capitalAuthority: NoCapitalAuthority
      readonly strategy: ExecutionStrategyIdentity
    }
  | {
      readonly brokerIdentity: BrokerIdentity & { readonly environment: BrokerEnvironment.Sandbox }
      readonly brokerAccess: BrokerAccess.Mutation
      readonly capitalAuthority: SandboxCapitalAuthority
      readonly strategy: ExecutionStrategyIdentity
    }
  | {
      readonly brokerIdentity: BrokerIdentity & { readonly environment: BrokerEnvironment.Live }
      readonly brokerAccess: BrokerAccess.Mutation
      readonly capitalAuthority: LiveCapitalAuthority
      readonly strategy: ExecutionStrategyIdentity
    }

export type MutationExecutionAuthority = Extract<ExecutionAuthority, { readonly brokerAccess: BrokerAccess.Mutation }>

export type ExecutionAuthorityConstructionFailure =
  | {
      readonly _tag: 'ReadOnlyBrokerRequiresNoCapital'
      readonly capitalAuthority: CapitalAuthorityKind
    }
  | {
      readonly _tag: 'MutationBrokerRequiresCapitalAuthority'
      readonly environment: BrokerEnvironment
    }
  | {
      readonly _tag: 'SandboxBrokerRequiresSandboxCapital'
      readonly capitalAuthority: CapitalAuthorityKind
    }
  | {
      readonly _tag: 'LiveBrokerRequiresLiveGrant'
      readonly capitalAuthority: CapitalAuthorityKind
    }
  | {
      readonly _tag: 'LiveGrantBrokerIdentityMismatch'
      readonly authorityIdentityHash: string
      readonly grantIdentityHash: string
    }
  | {
      readonly _tag: 'LiveGrantStrategyMismatch'
      readonly expected: ExecutionStrategyIdentity
      readonly observed: ExecutionStrategyIdentity
    }
  | {
      readonly _tag: 'LiveGrantNotYetValid'
      readonly validFrom: string
      readonly observedAt: string
    }
  | {
      readonly _tag: 'LiveGrantExpired'
      readonly validUntil: string
      readonly observedAt: string
    }
  | {
      readonly _tag: 'LiveGrantRevoked'
      readonly revokedAt: string
      readonly reason: string
    }

export interface ExecutionAuthorityInput {
  readonly brokerIdentity: BrokerIdentity
  readonly brokerAccess: BrokerAccess
  readonly capitalAuthority: CapitalAuthority
  readonly strategy: ExecutionStrategyIdentity
  readonly observedAt: string
}

const sameStrategy = (left: ExecutionStrategyIdentity, right: ExecutionStrategyIdentity): boolean =>
  left.name === right.name &&
  left.behaviorHash === right.behaviorHash &&
  left.parameterHash === right.parameterHash &&
  left.parameterSchemaVersion === right.parameterSchemaVersion

export const makeExecutionAuthority = (
  input: ExecutionAuthorityInput,
): Result.Result<ExecutionAuthority, ExecutionAuthorityConstructionFailure> => {
  if (input.brokerAccess === BrokerAccess.ReadOnly) {
    return input.capitalAuthority._tag === CapitalAuthorityKind.None
      ? Result.succeed({
          brokerIdentity: input.brokerIdentity,
          brokerAccess: BrokerAccess.ReadOnly,
          capitalAuthority: noCapitalAuthority,
          strategy: input.strategy,
        })
      : Result.fail({
          _tag: 'ReadOnlyBrokerRequiresNoCapital',
          capitalAuthority: input.capitalAuthority._tag,
        })
  }

  if (input.capitalAuthority._tag === CapitalAuthorityKind.None) {
    return Result.fail({
      _tag: 'MutationBrokerRequiresCapitalAuthority',
      environment: input.brokerIdentity.environment,
    })
  }

  if (input.brokerIdentity.environment === BrokerEnvironment.Sandbox) {
    return input.capitalAuthority._tag === CapitalAuthorityKind.Sandbox
      ? Result.succeed({
          brokerIdentity: input.brokerIdentity as BrokerIdentity & {
            readonly environment: BrokerEnvironment.Sandbox
          },
          brokerAccess: BrokerAccess.Mutation,
          capitalAuthority: input.capitalAuthority,
          strategy: input.strategy,
        })
      : Result.fail({
          _tag: 'SandboxBrokerRequiresSandboxCapital',
          capitalAuthority: input.capitalAuthority._tag,
        })
  }

  if (input.capitalAuthority._tag !== CapitalAuthorityKind.LiveGrant) {
    return Result.fail({
      _tag: 'LiveBrokerRequiresLiveGrant',
      capitalAuthority: input.capitalAuthority._tag,
    })
  }
  const capital = input.capitalAuthority
  if (capital.grant.brokerIdentity.identityHash !== input.brokerIdentity.identityHash) {
    return Result.fail({
      _tag: 'LiveGrantBrokerIdentityMismatch',
      authorityIdentityHash: input.brokerIdentity.identityHash,
      grantIdentityHash: capital.grant.brokerIdentity.identityHash,
    })
  }
  if (!sameStrategy(capital.grant.strategy, input.strategy)) {
    return Result.fail({
      _tag: 'LiveGrantStrategyMismatch',
      expected: input.strategy,
      observed: capital.grant.strategy,
    })
  }
  if (capital.revocation !== undefined) {
    return Result.fail({
      _tag: 'LiveGrantRevoked',
      revokedAt: capital.revocation.revokedAt,
      reason: capital.revocation.reason,
    })
  }
  if (input.observedAt < capital.grant.validFrom) {
    return Result.fail({
      _tag: 'LiveGrantNotYetValid',
      validFrom: capital.grant.validFrom,
      observedAt: input.observedAt,
    })
  }
  if (input.observedAt >= capital.grant.validUntil) {
    return Result.fail({
      _tag: 'LiveGrantExpired',
      validUntil: capital.grant.validUntil,
      observedAt: input.observedAt,
    })
  }
  return Result.succeed({
    brokerIdentity: input.brokerIdentity as BrokerIdentity & { readonly environment: BrokerEnvironment.Live },
    brokerAccess: BrokerAccess.Mutation,
    capitalAuthority: capital,
    strategy: input.strategy,
  })
}

export type LiveCapitalGrantConstructionFailure =
  | {
      readonly _tag: 'LiveCapitalGrantSchemaInvalid'
      readonly operation: 'material' | 'grant'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'LiveCapitalGrantCanonicalizationFailed'
      readonly cause: CanonicalHashFailure
    }

const decodeLiveGrantMaterial = Schema.decodeUnknownResult(LiveCapitalGrantMaterialSchema, StrictParseOptions)
const decodeLiveGrant = Schema.decodeUnknownResult(LiveCapitalGrantSchema, StrictParseOptions)

export const makeLiveCapitalGrant = (
  input: LiveCapitalGrantMaterial,
): Result.Result<LiveCapitalGrant, LiveCapitalGrantConstructionFailure> =>
  pipe(
    decodeLiveGrantMaterial(input),
    Result.mapError(
      (cause): LiveCapitalGrantConstructionFailure => ({
        _tag: 'LiveCapitalGrantSchemaInvalid',
        operation: 'material',
        cause,
      }),
    ),
    Result.flatMap((material) =>
      pipe(
        canonicalHashV1Result(material),
        Result.mapError(
          (cause): LiveCapitalGrantConstructionFailure => ({
            _tag: 'LiveCapitalGrantCanonicalizationFailed',
            cause,
          }),
        ),
        Result.flatMap((grantHash) =>
          pipe(
            decodeLiveGrant({ ...material, grantHash }),
            Result.mapError(
              (cause): LiveCapitalGrantConstructionFailure => ({
                _tag: 'LiveCapitalGrantSchemaInvalid',
                operation: 'grant',
                cause,
              }),
            ),
          ),
        ),
      ),
    ),
  )

export const decodeLiveCapitalGrant = (input: unknown) => decodeLiveGrant(input)
const decodeLiveCapitalGrantRevocationDataFirst = Schema.decodeUnknownResult(
  LiveCapitalGrantRevocationSchema,
  StrictParseOptions,
)

export const decodeLiveCapitalGrantRevocation = Pipeable.dual(1, (input: unknown) =>
  decodeLiveCapitalGrantRevocationDataFirst(input),
)
