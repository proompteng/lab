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
  Granted = 'granted-capital',
}

export interface NoCapitalAuthority {
  readonly _tag: CapitalAuthorityKind.None
}

export interface ExecutionCapitalLimits {
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

export const ExecutionCapitalLimitsSchema = Schema.Struct({
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

export const CapitalGrantRecordMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literals(['bayn.live-capital-grant.v1', 'bayn.capital-grant.v2']),
  brokerIdentity: BrokerIdentitySchema,
  authorityGenerationHash: Sha256,
  strategy: ExecutionStrategyIdentitySchema,
  limits: ExecutionCapitalLimitsSchema,
  validFrom: UtcInstant,
  validUntil: UtcInstant,
  issuedAt: UtcInstant,
  issuedBy: NonEmptyString,
})
export type CapitalGrantRecordMaterial = typeof CapitalGrantRecordMaterialSchema.Type

const CapitalGrantRecordBase = Schema.Struct({
  ...CapitalGrantRecordMaterialSchema.fields,
  grantHash: Sha256,
})

export const CapitalGrantRecordSchema = CapitalGrantRecordBase.check(
  Schema.makeFilter((grant: typeof CapitalGrantRecordBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
    if (
      grant.schemaVersion === 'bayn.live-capital-grant.v1' &&
      grant.brokerIdentity.environment !== BrokerEnvironment.Live
    ) {
      issues.push({ path: ['brokerIdentity', 'environment'], issue: 'legacy v1 grants must be bound to live' })
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
export type CapitalGrantRecord = typeof CapitalGrantRecordSchema.Type

export const CapitalGrantRevocationSchema = Schema.Struct({
  schemaVersion: Schema.Literals(['bayn.live-capital-grant-revocation.v1', 'bayn.capital-grant-revocation.v2']),
  revokedAt: UtcInstant,
  revokedBy: NonEmptyString,
  reason: NonEmptyString,
})
export type CapitalGrantRevocation = typeof CapitalGrantRevocationSchema.Type

export interface PersistedCapitalGrant {
  readonly grant: CapitalGrantRecord
  readonly revocation?: CapitalGrantRevocation
}

export interface GrantedCapitalAuthority {
  readonly _tag: CapitalAuthorityKind.Granted
  readonly authorityGenerationHash: string
  readonly persistedGrant?: PersistedCapitalGrant
}

export type CapitalAuthority = NoCapitalAuthority | GrantedCapitalAuthority

export const noCapitalAuthority: NoCapitalAuthority = Object.freeze({ _tag: CapitalAuthorityKind.None })

const persistedGrantBinding = (
  grant: CapitalGrantRecord,
  revocation?: CapitalGrantRevocation,
): PersistedCapitalGrant => ({
  grant,
  ...(revocation === undefined ? {} : { revocation }),
})

export function grantedCapitalAuthority(authorityGenerationHash: string): GrantedCapitalAuthority
export function grantedCapitalAuthority(
  grant: CapitalGrantRecord,
  revocation?: CapitalGrantRevocation,
): GrantedCapitalAuthority
export function grantedCapitalAuthority(
  input: string | CapitalGrantRecord,
  revocation?: CapitalGrantRevocation,
): GrantedCapitalAuthority {
  const authorityGenerationHash = typeof input === 'string' ? input : input.authorityGenerationHash
  const persistedGrant = typeof input === 'string' ? undefined : persistedGrantBinding(input, revocation)
  return {
    _tag: CapitalAuthorityKind.Granted,
    authorityGenerationHash,
    ...(persistedGrant === undefined ? {} : { persistedGrant }),
  }
}

export type ExecutionAuthority =
  | {
      readonly brokerIdentity: BrokerIdentity
      readonly brokerAccess: BrokerAccess.ReadOnly
      readonly capitalAuthority: NoCapitalAuthority
      readonly strategy: ExecutionStrategyIdentity
    }
  | {
      readonly brokerIdentity: BrokerIdentity
      readonly brokerAccess: BrokerAccess.Mutation
      readonly capitalAuthority: GrantedCapitalAuthority
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
      readonly _tag: 'PersistedGrantAuthorityGenerationMismatch'
      readonly authorityGenerationHash: string
      readonly grantAuthorityGenerationHash: string
    }
  | {
      readonly _tag: 'PersistedGrantBrokerIdentityMismatch'
      readonly authorityIdentityHash: string
      readonly grantIdentityHash: string
    }
  | {
      readonly _tag: 'PersistedGrantStrategyMismatch'
      readonly expected: ExecutionStrategyIdentity
      readonly observed: ExecutionStrategyIdentity
    }
  | {
      readonly _tag: 'PersistedGrantNotYetValid'
      readonly validFrom: string
      readonly observedAt: string
    }
  | {
      readonly _tag: 'PersistedGrantExpired'
      readonly validUntil: string
      readonly observedAt: string
    }
  | {
      readonly _tag: 'PersistedGrantRevoked'
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

  const persistedGrant = input.capitalAuthority.persistedGrant
  if (persistedGrant === undefined) {
    return Result.succeed({
      brokerIdentity: input.brokerIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: input.capitalAuthority,
      strategy: input.strategy,
    })
  }

  if (input.capitalAuthority.authorityGenerationHash !== persistedGrant.grant.authorityGenerationHash) {
    return Result.fail({
      _tag: 'PersistedGrantAuthorityGenerationMismatch',
      authorityGenerationHash: input.capitalAuthority.authorityGenerationHash,
      grantAuthorityGenerationHash: persistedGrant.grant.authorityGenerationHash,
    })
  }
  if (persistedGrant.grant.brokerIdentity.identityHash !== input.brokerIdentity.identityHash) {
    return Result.fail({
      _tag: 'PersistedGrantBrokerIdentityMismatch',
      authorityIdentityHash: input.brokerIdentity.identityHash,
      grantIdentityHash: persistedGrant.grant.brokerIdentity.identityHash,
    })
  }
  if (!sameStrategy(persistedGrant.grant.strategy, input.strategy)) {
    return Result.fail({
      _tag: 'PersistedGrantStrategyMismatch',
      expected: input.strategy,
      observed: persistedGrant.grant.strategy,
    })
  }
  if (persistedGrant.revocation !== undefined) {
    return Result.fail({
      _tag: 'PersistedGrantRevoked',
      revokedAt: persistedGrant.revocation.revokedAt,
      reason: persistedGrant.revocation.reason,
    })
  }
  if (input.observedAt < persistedGrant.grant.validFrom) {
    return Result.fail({
      _tag: 'PersistedGrantNotYetValid',
      validFrom: persistedGrant.grant.validFrom,
      observedAt: input.observedAt,
    })
  }
  if (input.observedAt >= persistedGrant.grant.validUntil) {
    return Result.fail({
      _tag: 'PersistedGrantExpired',
      validUntil: persistedGrant.grant.validUntil,
      observedAt: input.observedAt,
    })
  }
  return Result.succeed({
    brokerIdentity: input.brokerIdentity,
    brokerAccess: BrokerAccess.Mutation,
    capitalAuthority: input.capitalAuthority,
    strategy: input.strategy,
  })
}

export type CapitalGrantRecordConstructionFailure =
  | {
      readonly _tag: 'CapitalGrantRecordSchemaInvalid'
      readonly operation: 'material' | 'grant'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'CapitalGrantRecordCanonicalizationFailed'
      readonly cause: CanonicalHashFailure
    }

const decodeCapitalGrantRecordMaterial = Schema.decodeUnknownResult(
  CapitalGrantRecordMaterialSchema,
  StrictParseOptions,
)
const decodeCapitalGrantRecordValue = Schema.decodeUnknownResult(CapitalGrantRecordSchema, StrictParseOptions)

export const makeCapitalGrantRecord = (
  input: CapitalGrantRecordMaterial,
): Result.Result<CapitalGrantRecord, CapitalGrantRecordConstructionFailure> =>
  pipe(
    decodeCapitalGrantRecordMaterial(input),
    Result.mapError(
      (cause): CapitalGrantRecordConstructionFailure => ({
        _tag: 'CapitalGrantRecordSchemaInvalid',
        operation: 'material',
        cause,
      }),
    ),
    Result.flatMap((material) =>
      pipe(
        canonicalHashV1Result(material),
        Result.mapError(
          (cause): CapitalGrantRecordConstructionFailure => ({
            _tag: 'CapitalGrantRecordCanonicalizationFailed',
            cause,
          }),
        ),
        Result.flatMap((grantHash) =>
          pipe(
            decodeCapitalGrantRecordValue({ ...material, grantHash }),
            Result.mapError(
              (cause): CapitalGrantRecordConstructionFailure => ({
                _tag: 'CapitalGrantRecordSchemaInvalid',
                operation: 'grant',
                cause,
              }),
            ),
          ),
        ),
      ),
    ),
  )

export const decodeCapitalGrantRecord = (input: unknown) => decodeCapitalGrantRecordValue(input)
const decodeCapitalGrantRevocationDataFirst = Schema.decodeUnknownResult(
  CapitalGrantRevocationSchema,
  StrictParseOptions,
)

export const decodeCapitalGrantRevocation = Pipeable.dual(1, (input: unknown) =>
  decodeCapitalGrantRevocationDataFirst(input),
)
