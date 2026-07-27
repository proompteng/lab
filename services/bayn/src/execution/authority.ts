import { Result, Schema } from 'effect'

import { Sha256Schema as Sha256, strictParseOptions as StrictParseOptions } from '../schemas'

export enum BrokerEnvironment {
  Sandbox = 'sandbox',
  Live = 'live',
}

export enum ExecutionAccess {
  ReadOnly = 'read-only',
  SubmitOrders = 'submit-orders',
}

export const BrokerEnvironmentSchema = Schema.Enum(BrokerEnvironment)
export const ExecutionAccessSchema = Schema.Enum(ExecutionAccess)
export const CapitalPolicyIdentitySchema = Sha256
export type CapitalPolicyIdentity = typeof CapitalPolicyIdentitySchema.Type

export enum CapitalAccessState {
  Disabled = 'Disabled',
  Enabled = 'Enabled',
}

export interface DisabledCapitalAccess {
  readonly _tag: CapitalAccessState.Disabled
}

export interface EnabledCapitalAccess {
  readonly _tag: CapitalAccessState.Enabled
  readonly policyIdentity: CapitalPolicyIdentity
}

export type CapitalAccess = DisabledCapitalAccess | EnabledCapitalAccess

export interface ExecutionAuthority {
  readonly brokerEnvironment: BrokerEnvironment
  readonly executionAccess: ExecutionAccess
  readonly capitalAccess: CapitalAccess
}

export const disabledCapitalAccess: DisabledCapitalAccess = {
  _tag: CapitalAccessState.Disabled,
}

export const enabledCapitalAccess = (policyIdentity: CapitalPolicyIdentity): EnabledCapitalAccess => ({
  _tag: CapitalAccessState.Enabled,
  policyIdentity,
})

export const makeExecutionAuthority = (
  brokerEnvironment: BrokerEnvironment,
  executionAccess: ExecutionAccess,
  capitalAccess: CapitalAccess,
): ExecutionAuthority => ({
  brokerEnvironment,
  executionAccess,
  capitalAccess,
})

export const CapitalAccessSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal(CapitalAccessState.Disabled),
  }),
  Schema.Struct({
    _tag: Schema.Literal(CapitalAccessState.Enabled),
    policyIdentity: CapitalPolicyIdentitySchema,
  }),
])

export const ExecutionAuthoritySchema = Schema.Struct({
  brokerEnvironment: BrokerEnvironmentSchema,
  executionAccess: ExecutionAccessSchema,
  capitalAccess: CapitalAccessSchema,
})

const decodeExecutionAuthorityResult = Schema.decodeUnknownResult(ExecutionAuthoritySchema, StrictParseOptions)

export const decodeExecutionAuthority = (input: unknown): Result.Result<ExecutionAuthority, Schema.SchemaError> =>
  decodeExecutionAuthorityResult(input)

/**
 * Durable identifiers used by the existing paper-only schemas and PostgreSQL rows.
 * Keep these exact values until a separate data migration changes the stored contracts.
 */
export enum LegacyBrokerMode {
  Paper = 'PAPER',
}

export enum LegacyMaximumAuthority {
  Observe = 'OBSERVE',
  Paper = 'PAPER',
}

export interface LegacyPaperAuthorityMaterial {
  readonly brokerMode: LegacyBrokerMode.Paper
  readonly maximum: LegacyMaximumAuthority
  readonly effective: LegacyMaximumAuthority
  readonly riskPolicyHash?: CapitalPolicyIdentity
}

export const LegacyPaperAuthorityMaterialSchema = Schema.Struct({
  brokerMode: Schema.Literal(LegacyBrokerMode.Paper),
  maximum: Schema.Enum(LegacyMaximumAuthority),
  effective: Schema.Enum(LegacyMaximumAuthority),
  riskPolicyHash: Schema.optionalKey(CapitalPolicyIdentitySchema),
})

const decodeLegacyPaperAuthorityMaterialResult = Schema.decodeUnknownResult(
  LegacyPaperAuthorityMaterialSchema,
  StrictParseOptions,
)

export type LegacyPaperAuthorityDecodeFailure =
  | {
      readonly _tag: 'InvalidLegacyPaperAuthorityMaterial'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'MissingLegacyRiskPolicyHash'
      readonly maximum: LegacyMaximumAuthority.Paper
    }
  | {
      readonly _tag: 'UnexpectedLegacyRiskPolicyHash'
      readonly maximum: LegacyMaximumAuthority.Observe
      readonly riskPolicyHash: CapitalPolicyIdentity
    }
  | {
      readonly _tag: 'LegacyEffectiveAuthorityExceedsMaximum'
      readonly maximum: LegacyMaximumAuthority.Observe
      readonly effective: LegacyMaximumAuthority.Paper
    }

export const decodeLegacyPaperAuthority = (
  input: unknown,
): Result.Result<ExecutionAuthority, LegacyPaperAuthorityDecodeFailure> => {
  const decoded = decodeLegacyPaperAuthorityMaterialResult(input)
  if (Result.isFailure(decoded)) {
    return Result.fail({
      _tag: 'InvalidLegacyPaperAuthorityMaterial',
      cause: decoded.failure,
    })
  }

  const material: LegacyPaperAuthorityMaterial = decoded.success
  if (material.maximum === LegacyMaximumAuthority.Observe && material.effective === LegacyMaximumAuthority.Paper) {
    return Result.fail({
      _tag: 'LegacyEffectiveAuthorityExceedsMaximum',
      maximum: LegacyMaximumAuthority.Observe,
      effective: LegacyMaximumAuthority.Paper,
    })
  }

  if (material.maximum === LegacyMaximumAuthority.Observe) {
    if (material.riskPolicyHash !== undefined) {
      return Result.fail({
        _tag: 'UnexpectedLegacyRiskPolicyHash',
        maximum: LegacyMaximumAuthority.Observe,
        riskPolicyHash: material.riskPolicyHash,
      })
    }
    return Result.succeed(
      makeExecutionAuthority(BrokerEnvironment.Sandbox, ExecutionAccess.ReadOnly, disabledCapitalAccess),
    )
  }

  if (material.riskPolicyHash === undefined) {
    return Result.fail({
      _tag: 'MissingLegacyRiskPolicyHash',
      maximum: LegacyMaximumAuthority.Paper,
    })
  }
  return Result.succeed(
    makeExecutionAuthority(
      BrokerEnvironment.Sandbox,
      material.effective === LegacyMaximumAuthority.Paper ? ExecutionAccess.SubmitOrders : ExecutionAccess.ReadOnly,
      enabledCapitalAccess(material.riskPolicyHash),
    ),
  )
}

export type LegacyPaperAuthorityEncodeFailure =
  | {
      readonly _tag: 'LegacyBrokerEnvironmentUnsupported'
      readonly brokerEnvironment: BrokerEnvironment.Live
    }
  | {
      readonly _tag: 'LegacyAuthorityCombinationUnsupported'
      readonly executionAccess: ExecutionAccess
      readonly capitalAccess: CapitalAccessState
    }

export const encodeLegacyPaperAuthority = (
  authority: ExecutionAuthority,
): Result.Result<LegacyPaperAuthorityMaterial, LegacyPaperAuthorityEncodeFailure> => {
  if (authority.brokerEnvironment === BrokerEnvironment.Live) {
    return Result.fail({
      _tag: 'LegacyBrokerEnvironmentUnsupported',
      brokerEnvironment: BrokerEnvironment.Live,
    })
  }

  if (
    authority.executionAccess === ExecutionAccess.ReadOnly &&
    authority.capitalAccess._tag === CapitalAccessState.Disabled
  ) {
    return Result.succeed({
      brokerMode: LegacyBrokerMode.Paper,
      maximum: LegacyMaximumAuthority.Observe,
      effective: LegacyMaximumAuthority.Observe,
    })
  }

  if (authority.capitalAccess._tag === CapitalAccessState.Enabled) {
    return Result.succeed({
      brokerMode: LegacyBrokerMode.Paper,
      maximum: LegacyMaximumAuthority.Paper,
      effective:
        authority.executionAccess === ExecutionAccess.SubmitOrders
          ? LegacyMaximumAuthority.Paper
          : LegacyMaximumAuthority.Observe,
      riskPolicyHash: authority.capitalAccess.policyIdentity,
    })
  }

  return Result.fail({
    _tag: 'LegacyAuthorityCombinationUnsupported',
    executionAccess: authority.executionAccess,
    capitalAccess: authority.capitalAccess._tag,
  })
}
