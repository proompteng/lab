import { pipe, Result, Schema } from 'effect'

import type { BrokerIdentity } from '../broker/identity'
import { BrokerEnvironment } from '../broker/identity'
import { canonicalHashV1Result } from '../hash'
import { Pipeable } from '../pipeable'
import {
  GitSourceRevisionSchema,
  ImageDigestSchema,
  ImageRepositorySchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { BrokerAccess, CapitalAuthorityKind } from './authority'
import { Authority, type ResearchCapitalGrantGeneration, type ResearchCapitalGrantProofBinding } from './contracts'
import { ResearchCapitalGrantSchema } from './episode'

export enum CapitalAuthoritySelection {
  None = 'none',
  Granted = 'granted-capital',
}

export interface NoCapitalRequest {
  readonly _tag: CapitalAuthorityKind.None
}

export interface GrantedCapitalRequest {
  readonly _tag: CapitalAuthorityKind.Granted
  readonly authorityGenerationHash: string
  readonly persistedGrantHash?: string
}

export const capitalActivationRequestSchemaVersion = 'bayn.paper-activation-request.v1' as const
export const researchCapitalActivationRequestSchemaVersion = 'bayn.paper-research-activation-request.v1' as const
export const researchCapitalPlanSchemaVersion = 'bayn.paper-research-plan.v1' as const
export const researchCapitalBuildContinuationSchemaVersion = 'bayn.paper-research-build-continuation.v1' as const

const CapitalActivationStrategySchema = Schema.Struct({
  name: StrictNonEmptyStringSchema,
  behaviorHash: Sha256Schema,
  parameterHash: Sha256Schema,
  parameterSchemaVersion: StrictNonEmptyStringSchema,
  protocolHash: Sha256Schema,
})

const CapitalActivationRevisionBindingSchema = Schema.Struct({
  sourceRevision: GitSourceRevisionSchema,
  imageRepository: ImageRepositorySchema,
  imageDigest: ImageDigestSchema,
})
export type CapitalActivationRevisionBinding = typeof CapitalActivationRevisionBindingSchema.Type

const CapitalActivationRequestMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(capitalActivationRequestSchemaVersion),
  qualification: Schema.Struct({
    runId: Sha256Schema,
    lockId: Sha256Schema,
    resultHash: Sha256Schema,
    sourceRevision: GitSourceRevisionSchema,
    imageRepository: ImageRepositorySchema,
    imageDigest: ImageDigestSchema,
  }),
  activation: CapitalActivationRevisionBindingSchema,
  strategy: CapitalActivationStrategySchema,
  limits: Schema.Struct({
    maxOpenOrders: Schema.Literal(0),
    maxPositions: Schema.Literal(0),
  }),
  cutoffAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
})

export const QualifiedCapitalActivationRequestSchema = Schema.Struct({
  ...CapitalActivationRequestMaterialSchema.fields,
  requestHash: Sha256Schema,
}).check(
  Schema.makeFilter(
    (request: typeof CapitalActivationRequestMaterialSchema.Type & { readonly requestHash: string }) => {
      if (request.expiresAt <= request.cutoffAt) return false
      const expected = canonicalHashV1Result(requestWithoutHash(request))
      return Result.isSuccess(expected) && request.requestHash === expected.success
    },
  ),
)

export type QualifiedCapitalActivationRequest = typeof QualifiedCapitalActivationRequestSchema.Type

const ResearchCapitalPlanFields = {
  activation: CapitalActivationRevisionBindingSchema,
  strategy: CapitalActivationStrategySchema,
  broker: Schema.Struct({
    environment: Schema.Literal(BrokerEnvironment.Sandbox),
    accountId: StrictNonEmptyStringSchema,
    identityHash: Sha256Schema,
  }),
  riskPolicyHash: Sha256Schema,
  limits: Schema.Struct({
    maxOpenOrders: Schema.Literal(0),
    maxPositions: Schema.Literal(0),
  }),
  cutoffAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
  maximumCloseSessions: Schema.Literal(3),
} as const

const ResearchCapitalPlanMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(researchCapitalPlanSchemaVersion),
  ...ResearchCapitalPlanFields,
})
export type ResearchCapitalPlanMaterial = typeof ResearchCapitalPlanMaterialSchema.Type

export const makeResearchCapitalPlanHash = (
  material: ResearchCapitalPlanMaterial,
): Result.Result<string, 'ResearchCapitalPlanCanonicalizationFailed'> =>
  pipe(
    canonicalHashV1Result(material),
    Result.mapError(() => 'ResearchCapitalPlanCanonicalizationFailed' as const),
  )

const ResearchCapitalActivationRequestMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(researchCapitalActivationRequestSchemaVersion),
  grant: ResearchCapitalGrantSchema,
  ...ResearchCapitalPlanFields,
})

const researchPlanMaterial = (
  request: typeof ResearchCapitalActivationRequestMaterialSchema.Type,
): ResearchCapitalPlanMaterial => ({
  schemaVersion: researchCapitalPlanSchemaVersion,
  activation: request.activation,
  strategy: request.strategy,
  broker: request.broker,
  riskPolicyHash: request.riskPolicyHash,
  limits: request.limits,
  cutoffAt: request.cutoffAt,
  expiresAt: request.expiresAt,
  maximumCloseSessions: request.maximumCloseSessions,
})

export const ResearchCapitalActivationRequestSchema = Schema.Struct({
  ...ResearchCapitalActivationRequestMaterialSchema.fields,
  requestHash: Sha256Schema,
}).check(
  Schema.makeFilter(
    (request: typeof ResearchCapitalActivationRequestMaterialSchema.Type & { readonly requestHash: string }) => {
      if (request.expiresAt <= request.cutoffAt) return false
      const planHash = makeResearchCapitalPlanHash(researchPlanMaterial(request))
      if (Result.isFailure(planHash) || request.grant.planHash !== planHash.success) return false
      const expected = canonicalHashV1Result(requestWithoutHash(request))
      return Result.isSuccess(expected) && request.requestHash === expected.success
    },
  ),
)
export type ResearchCapitalActivationRequest = typeof ResearchCapitalActivationRequestSchema.Type

const ResearchCapitalBuildContinuationMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(researchCapitalBuildContinuationSchemaVersion),
  request: ResearchCapitalActivationRequestSchema,
  generationHash: Sha256Schema,
  activation: CapitalActivationRevisionBindingSchema,
})

export const ResearchCapitalBuildContinuationSchema = Schema.Struct({
  ...ResearchCapitalBuildContinuationMaterialSchema.fields,
  continuationHash: Sha256Schema,
}).check(
  Schema.makeFilter(
    (
      continuation: typeof ResearchCapitalBuildContinuationMaterialSchema.Type & {
        readonly continuationHash: string
      },
    ) => {
      if (continuation.activation.imageRepository !== continuation.request.activation.imageRepository) return false
      const { continuationHash: _continuationHash, ...material } = continuation
      const expected = canonicalHashV1Result(material)
      return Result.isSuccess(expected) && continuation.continuationHash === expected.success
    },
  ),
)
export type ResearchCapitalBuildContinuation = typeof ResearchCapitalBuildContinuationSchema.Type

export const makeResearchCapitalBuildContinuation = (
  material: typeof ResearchCapitalBuildContinuationMaterialSchema.Type,
): Result.Result<ResearchCapitalBuildContinuation, 'ResearchCapitalBuildContinuationCanonicalizationFailed'> => {
  if (material.activation.imageRepository !== material.request.activation.imageRepository) {
    return Result.fail('ResearchCapitalBuildContinuationCanonicalizationFailed')
  }
  return pipe(
    canonicalHashV1Result(material),
    Result.mapError(() => 'ResearchCapitalBuildContinuationCanonicalizationFailed' as const),
    Result.map((continuationHash) => ({ ...material, continuationHash }) as ResearchCapitalBuildContinuation),
  )
}

export const isResearchCapitalActivationRequest = (
  request: CapitalActivationRequest,
): request is ResearchCapitalActivationRequest =>
  request.schemaVersion === researchCapitalActivationRequestSchemaVersion

export const researchCapitalGrantProof = (
  request: ResearchCapitalActivationRequest,
): ResearchCapitalGrantProofBinding => ({
  schemaVersion: 'bayn.research-paper-grant-proof.v1',
  grant: request.grant,
  activationSourceRevision: request.activation.sourceRevision,
  activationImageRepository: request.activation.imageRepository,
  activationImageDigest: request.activation.imageDigest,
  strategyName: request.strategy.name,
  strategyBehaviorHash: request.strategy.behaviorHash,
  strategyParameterHash: request.strategy.parameterHash,
  strategyParameterSchemaVersion: request.strategy.parameterSchemaVersion,
  strategyProtocolHash: request.strategy.protocolHash,
  accountId: request.broker.accountId,
  brokerIdentityHash: request.broker.identityHash,
  riskPolicyHash: request.riskPolicyHash,
  proofPlanHash: request.grant.planHash,
})

const researchCapitalGenerationIsBoundToRequestDataFirst = (
  request: ResearchCapitalActivationRequest,
  sourceGenerationHash: string,
  generation: ResearchCapitalGrantGeneration,
): Result.Result<void, string> => {
  if (
    generation.maximum !== Authority.Execution ||
    generation.previousGenerationHash !== sourceGenerationHash ||
    generation.grant.planHash !== request.grant.planHash
  ) {
    return Result.fail('research capital generation identity is not bound to the activation request')
  }
  if (
    generation.activationSourceRevision !== request.activation.sourceRevision ||
    generation.activationImageRepository !== request.activation.imageRepository ||
    generation.activationImageDigest !== request.activation.imageDigest ||
    generation.strategyName !== request.strategy.name ||
    generation.strategyBehaviorHash !== request.strategy.behaviorHash ||
    generation.strategyParameterHash !== request.strategy.parameterHash ||
    generation.strategyParameterSchemaVersion !== request.strategy.parameterSchemaVersion ||
    generation.strategyProtocolHash !== request.strategy.protocolHash
  ) {
    return Result.fail('research capital generation is not bound to the requested current strategy and build')
  }
  if (
    generation.accountId !== request.broker.accountId ||
    generation.brokerIdentityHash !== request.broker.identityHash ||
    generation.riskPolicyHash !== request.riskPolicyHash ||
    generation.proofPlanHash !== request.grant.planHash
  ) {
    return Result.fail('research capital generation is not bound to the requested broker and risk controls')
  }
  return Result.succeed(undefined)
}

export const researchCapitalGenerationIsBoundToRequest = Pipeable.dual(
  3,
  researchCapitalGenerationIsBoundToRequestDataFirst,
)

export const researchCapitalBuildContinuationIsBound = (
  continuation: ResearchCapitalBuildContinuation,
  sourceGenerationHash: string,
  generation: ResearchCapitalGrantGeneration,
  currentActivation: CapitalActivationRevisionBinding,
): Result.Result<void, string> => {
  if (
    continuation.generationHash !== generation.generationHash ||
    continuation.activation.sourceRevision !== currentActivation.sourceRevision ||
    continuation.activation.imageRepository !== currentActivation.imageRepository ||
    continuation.activation.imageDigest !== currentActivation.imageDigest
  ) {
    return Result.fail('research capital build continuation is not bound to the active generation and current build')
  }
  return researchCapitalGenerationIsBoundToRequest(continuation.request, sourceGenerationHash, generation)
}

export const CapitalActivationRequestSchema = Schema.Union([
  QualifiedCapitalActivationRequestSchema,
  ResearchCapitalActivationRequestSchema,
])
export type CapitalActivationRequest = typeof CapitalActivationRequestSchema.Type

export const capitalActivationRequiresQualificationEvidence = (request: CapitalActivationRequest | null): boolean =>
  request !== null && !isResearchCapitalActivationRequest(request)

export const CapitalActivationConfigurationSchema = Schema.Union([
  CapitalActivationRequestSchema,
  ResearchCapitalBuildContinuationSchema,
])
export type CapitalActivationConfiguration = typeof CapitalActivationConfigurationSchema.Type

export const isResearchCapitalBuildContinuation = (
  configuration: CapitalActivationConfiguration,
): configuration is ResearchCapitalBuildContinuation =>
  configuration.schemaVersion === researchCapitalBuildContinuationSchemaVersion

const requestWithoutHash = (
  request:
    | QualifiedCapitalActivationRequest
    | ResearchCapitalActivationRequest
    | (typeof CapitalActivationRequestMaterialSchema.Type & { readonly requestHash: string }),
) => {
  const { requestHash: _requestHash, ...material } = request
  return material
}

export const makeCapitalActivationRequest = (
  material: typeof CapitalActivationRequestMaterialSchema.Type,
): Result.Result<QualifiedCapitalActivationRequest, 'CapitalActivationRequestCanonicalizationFailed'> =>
  pipe(
    canonicalHashV1Result(material),
    Result.mapError(() => 'CapitalActivationRequestCanonicalizationFailed' as const),
    Result.flatMap((requestHash) => Result.succeed({ ...material, requestHash } as QualifiedCapitalActivationRequest)),
  )

export const makeResearchCapitalActivationRequest = (
  material: typeof ResearchCapitalActivationRequestMaterialSchema.Type,
): Result.Result<
  ResearchCapitalActivationRequest,
  | 'CapitalActivationRequestCanonicalizationFailed'
  | 'ResearchCapitalCloseWindowInvalid'
  | 'ResearchCapitalPlanHashMismatch'
> => {
  if (material.expiresAt <= material.cutoffAt) return Result.fail('ResearchCapitalCloseWindowInvalid')
  const planHash = makeResearchCapitalPlanHash(researchPlanMaterial(material))
  if (Result.isFailure(planHash)) return Result.fail('CapitalActivationRequestCanonicalizationFailed')
  if (material.grant.planHash !== planHash.success) return Result.fail('ResearchCapitalPlanHashMismatch')
  return pipe(
    canonicalHashV1Result(material),
    Result.mapError(() => 'CapitalActivationRequestCanonicalizationFailed' as const),
    Result.map((requestHash) => ({ ...material, requestHash }) as ResearchCapitalActivationRequest),
  )
}

const decodeCapitalActivationRequestResultDataFirst = Schema.decodeUnknownResult(
  CapitalActivationRequestSchema,
  strictParseOptions,
)

export const decodeCapitalActivationRequestResult = Pipeable.dual(1, (input: unknown) =>
  decodeCapitalActivationRequestResultDataFirst(input),
)

const decodeCapitalActivationConfigurationResultDataFirst = Schema.decodeUnknownResult(
  CapitalActivationConfigurationSchema,
  strictParseOptions,
)

export const decodeCapitalActivationConfigurationResult = Pipeable.dual(1, (input: unknown) =>
  decodeCapitalActivationConfigurationResultDataFirst(input),
)

export type CapitalAuthorityRequest = NoCapitalRequest | GrantedCapitalRequest

export type ExecutionPolicy =
  | {
      readonly brokerIdentity?: undefined
      readonly brokerAccess: BrokerAccess.ReadOnly
      readonly capitalAuthority: NoCapitalRequest
    }
  | {
      readonly brokerIdentity: BrokerIdentity
      readonly brokerAccess: BrokerAccess.ReadOnly
      readonly capitalAuthority: NoCapitalRequest
    }
  | {
      readonly brokerIdentity: BrokerIdentity
      readonly brokerAccess: BrokerAccess.Mutation
      readonly capitalAuthority: GrantedCapitalRequest
    }

export interface ExecutionPolicyInput {
  readonly brokerIdentity: BrokerIdentity | undefined
  readonly brokerAccess: BrokerAccess
  readonly capitalAuthority: CapitalAuthoritySelection
  readonly authorityGenerationHash: string | undefined
  /** Additional durable authorization required by capital environments that mandate it. */
  readonly persistedCapitalGrantHash: string | undefined
}

export type ExecutionPolicyResolutionFailure =
  | {
      readonly _tag: 'BrokerAccessRequiresConnection'
      readonly brokerAccess: BrokerAccess.Mutation
    }
  | {
      readonly _tag: 'CapitalAuthorityRequiresConnection'
      readonly capitalAuthority: CapitalAuthoritySelection.Granted
    }
  | {
      readonly _tag: 'ReadOnlyBrokerRequiresNoCapital'
      readonly capitalAuthority: CapitalAuthoritySelection.Granted
    }
  | {
      readonly _tag: 'MutationBrokerRequiresCapitalAuthority'
      readonly environment: BrokerEnvironment
    }
  | {
      readonly _tag: 'GrantedCapitalRequiresAuthorityGeneration'
    }
  | {
      readonly _tag: 'PersistedCapitalGrantRequired'
      readonly environment: BrokerEnvironment
    }
  | {
      readonly _tag: 'UnexpectedAuthorityGenerationHash'
      readonly brokerEnvironment: BrokerEnvironment | undefined
      readonly capitalAuthority: CapitalAuthoritySelection
    }
  | {
      readonly _tag: 'UnexpectedPersistedCapitalGrantHash'
      readonly brokerEnvironment: BrokerEnvironment | undefined
      readonly capitalAuthority: CapitalAuthoritySelection
    }

const noCapitalRequest: NoCapitalRequest = Object.freeze({ _tag: CapitalAuthorityKind.None })

const rejectUnexpectedBindings = (
  input: ExecutionPolicyInput,
): Result.Result<void, ExecutionPolicyResolutionFailure> => {
  if (input.capitalAuthority === CapitalAuthoritySelection.None && input.authorityGenerationHash !== undefined) {
    return Result.fail({
      _tag: 'UnexpectedAuthorityGenerationHash',
      brokerEnvironment: input.brokerIdentity?.environment,
      capitalAuthority: input.capitalAuthority,
    })
  }
  if (input.capitalAuthority === CapitalAuthoritySelection.None && input.persistedCapitalGrantHash !== undefined) {
    return Result.fail({
      _tag: 'UnexpectedPersistedCapitalGrantHash',
      brokerEnvironment: input.brokerIdentity?.environment,
      capitalAuthority: input.capitalAuthority,
    })
  }
  return Result.succeed(undefined)
}

export const resolveExecutionPolicy = (
  input: ExecutionPolicyInput,
): Result.Result<ExecutionPolicy, ExecutionPolicyResolutionFailure> => {
  const bindings = rejectUnexpectedBindings(input)
  if (Result.isFailure(bindings)) return Result.fail(bindings.failure)

  if (input.brokerIdentity === undefined) {
    if (input.brokerAccess === BrokerAccess.Mutation) {
      return Result.fail({ _tag: 'BrokerAccessRequiresConnection', brokerAccess: BrokerAccess.Mutation })
    }
    if (input.capitalAuthority !== CapitalAuthoritySelection.None) {
      return Result.fail({
        _tag: 'CapitalAuthorityRequiresConnection',
        capitalAuthority: input.capitalAuthority,
      })
    }
    return Result.succeed({
      brokerIdentity: undefined,
      brokerAccess: BrokerAccess.ReadOnly,
      capitalAuthority: noCapitalRequest,
    })
  }

  if (input.brokerAccess === BrokerAccess.ReadOnly) {
    return input.capitalAuthority === CapitalAuthoritySelection.None
      ? Result.succeed({
          brokerIdentity: input.brokerIdentity,
          brokerAccess: BrokerAccess.ReadOnly,
          capitalAuthority: noCapitalRequest,
        })
      : Result.fail({
          _tag: 'ReadOnlyBrokerRequiresNoCapital',
          capitalAuthority: input.capitalAuthority,
        })
  }

  if (input.capitalAuthority === CapitalAuthoritySelection.None) {
    return Result.fail({
      _tag: 'MutationBrokerRequiresCapitalAuthority',
      environment: input.brokerIdentity.environment,
    })
  }

  if (input.authorityGenerationHash === undefined) {
    return Result.fail({ _tag: 'GrantedCapitalRequiresAuthorityGeneration' })
  }
  // Compatibility policy only: historical sandbox generations predate persisted grants. The execution authority and
  // submit path are account-environment neutral once a grant is present.
  if (input.brokerIdentity.environment === BrokerEnvironment.Live && input.persistedCapitalGrantHash === undefined) {
    return Result.fail({ _tag: 'PersistedCapitalGrantRequired', environment: input.brokerIdentity.environment })
  }
  return Result.succeed({
    brokerIdentity: input.brokerIdentity,
    brokerAccess: BrokerAccess.Mutation,
    capitalAuthority: {
      _tag: CapitalAuthorityKind.Granted,
      authorityGenerationHash: input.authorityGenerationHash,
      ...(input.persistedCapitalGrantHash === undefined ? {} : { persistedGrantHash: input.persistedCapitalGrantHash }),
    },
  })
}

export const renderExecutionPolicyFailure = (failure: ExecutionPolicyResolutionFailure): string => {
  switch (failure._tag) {
    case 'BrokerAccessRequiresConnection':
      return 'mutation broker access requires a complete broker connection'
    case 'CapitalAuthorityRequiresConnection':
      return `${failure.capitalAuthority} requires a complete broker connection`
    case 'ReadOnlyBrokerRequiresNoCapital':
      return `read-only broker access forbids ${failure.capitalAuthority}`
    case 'MutationBrokerRequiresCapitalAuthority':
      return `${failure.environment} mutation broker access requires explicit capital authority`
    case 'GrantedCapitalRequiresAuthorityGeneration':
      return 'granted capital requires an authority generation hash'
    case 'PersistedCapitalGrantRequired':
      return `${failure.environment} broker execution requires a persisted capital grant hash`
    case 'UnexpectedAuthorityGenerationHash':
      return `authority generation hash is not valid for ${failure.capitalAuthority}`
    case 'UnexpectedPersistedCapitalGrantHash':
      return `persisted capital grant hash is not valid for ${failure.capitalAuthority}`
  }
}
