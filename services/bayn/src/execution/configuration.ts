import { pipe, Result, Schema } from 'effect'

import type { BrokerIdentity } from '../broker/identity'
import { BrokerEnvironment } from '../broker/identity'
import { canonicalHashV1Result } from '../hash'
import { ResearchPaperGrantSchema } from '../paper-episode'
import { Authority, type ResearchCapitalGrantGeneration, type ResearchCapitalGrantProofBinding } from './contracts'
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
import { Pipeable } from '../pipeable'

export enum CapitalAuthoritySelection {
  None = 'none',
  Sandbox = 'sandbox-capital',
  LiveGrant = 'live-capital-grant',
}

export interface NoCapitalRequest {
  readonly _tag: CapitalAuthorityKind.None
}

export interface SandboxCapitalRequest {
  readonly _tag: CapitalAuthorityKind.Sandbox
  readonly authorityGenerationHash: string
}

export interface LiveCapitalGrantRequest {
  readonly _tag: CapitalAuthorityKind.LiveGrant
  readonly grantHash: string
  readonly authorityGenerationHash: string
}

export const paperActivationRequestSchemaVersion = 'bayn.paper-activation-request.v1' as const
export const researchPaperActivationRequestSchemaVersion = 'bayn.paper-research-activation-request.v1' as const
export const researchPaperPlanSchemaVersion = 'bayn.paper-research-plan.v1' as const
export const researchPaperBuildContinuationSchemaVersion = 'bayn.paper-research-build-continuation.v1' as const

const PaperActivationStrategySchema = Schema.Struct({
  name: StrictNonEmptyStringSchema,
  behaviorHash: Sha256Schema,
  parameterHash: Sha256Schema,
  parameterSchemaVersion: StrictNonEmptyStringSchema,
  protocolHash: Sha256Schema,
})

const PaperActivationRevisionBindingSchema = Schema.Struct({
  sourceRevision: GitSourceRevisionSchema,
  imageRepository: ImageRepositorySchema,
  imageDigest: ImageDigestSchema,
})
export type PaperActivationRevisionBinding = typeof PaperActivationRevisionBindingSchema.Type

const PaperActivationRequestMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(paperActivationRequestSchemaVersion),
  qualification: Schema.Struct({
    runId: Sha256Schema,
    lockId: Sha256Schema,
    resultHash: Sha256Schema,
    sourceRevision: GitSourceRevisionSchema,
    imageRepository: ImageRepositorySchema,
    imageDigest: ImageDigestSchema,
  }),
  activation: PaperActivationRevisionBindingSchema,
  strategy: PaperActivationStrategySchema,
  limits: Schema.Struct({
    maxOpenOrders: Schema.Literal(0),
    maxPositions: Schema.Literal(0),
  }),
  cutoffAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
})

export const QualifiedPaperActivationRequestSchema = Schema.Struct({
  ...PaperActivationRequestMaterialSchema.fields,
  requestHash: Sha256Schema,
}).check(
  Schema.makeFilter((request: typeof PaperActivationRequestMaterialSchema.Type & { readonly requestHash: string }) => {
    if (request.expiresAt <= request.cutoffAt) return false
    const expected = canonicalHashV1Result(requestWithoutHash(request))
    return Result.isSuccess(expected) && request.requestHash === expected.success
  }),
)

export type QualifiedPaperActivationRequest = typeof QualifiedPaperActivationRequestSchema.Type

const ResearchPaperPlanFields = {
  activation: PaperActivationRevisionBindingSchema,
  strategy: PaperActivationStrategySchema,
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

const ResearchPaperPlanMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(researchPaperPlanSchemaVersion),
  ...ResearchPaperPlanFields,
})
export type ResearchPaperPlanMaterial = typeof ResearchPaperPlanMaterialSchema.Type

export const makeResearchPaperPlanHash = (
  material: ResearchPaperPlanMaterial,
): Result.Result<string, 'ResearchPaperPlanCanonicalizationFailed'> =>
  pipe(
    canonicalHashV1Result(material),
    Result.mapError(() => 'ResearchPaperPlanCanonicalizationFailed' as const),
  )

const ResearchPaperActivationRequestMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(researchPaperActivationRequestSchemaVersion),
  grant: ResearchPaperGrantSchema,
  ...ResearchPaperPlanFields,
})

const researchPlanMaterial = (
  request: typeof ResearchPaperActivationRequestMaterialSchema.Type,
): ResearchPaperPlanMaterial => ({
  schemaVersion: researchPaperPlanSchemaVersion,
  activation: request.activation,
  strategy: request.strategy,
  broker: request.broker,
  riskPolicyHash: request.riskPolicyHash,
  limits: request.limits,
  cutoffAt: request.cutoffAt,
  expiresAt: request.expiresAt,
  maximumCloseSessions: request.maximumCloseSessions,
})

export const ResearchPaperActivationRequestSchema = Schema.Struct({
  ...ResearchPaperActivationRequestMaterialSchema.fields,
  requestHash: Sha256Schema,
}).check(
  Schema.makeFilter(
    (request: typeof ResearchPaperActivationRequestMaterialSchema.Type & { readonly requestHash: string }) => {
      if (request.expiresAt <= request.cutoffAt) return false
      const planHash = makeResearchPaperPlanHash(researchPlanMaterial(request))
      if (Result.isFailure(planHash) || request.grant.planHash !== planHash.success) return false
      const expected = canonicalHashV1Result(requestWithoutHash(request))
      return Result.isSuccess(expected) && request.requestHash === expected.success
    },
  ),
)
export type ResearchPaperActivationRequest = typeof ResearchPaperActivationRequestSchema.Type

const ResearchPaperBuildContinuationMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(researchPaperBuildContinuationSchemaVersion),
  request: ResearchPaperActivationRequestSchema,
  generationHash: Sha256Schema,
  activation: PaperActivationRevisionBindingSchema,
})

export const ResearchPaperBuildContinuationSchema = Schema.Struct({
  ...ResearchPaperBuildContinuationMaterialSchema.fields,
  continuationHash: Sha256Schema,
}).check(
  Schema.makeFilter(
    (
      continuation: typeof ResearchPaperBuildContinuationMaterialSchema.Type & {
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
export type ResearchPaperBuildContinuation = typeof ResearchPaperBuildContinuationSchema.Type

export const makeResearchPaperBuildContinuation = (
  material: typeof ResearchPaperBuildContinuationMaterialSchema.Type,
): Result.Result<ResearchPaperBuildContinuation, 'ResearchPaperBuildContinuationCanonicalizationFailed'> => {
  if (material.activation.imageRepository !== material.request.activation.imageRepository) {
    return Result.fail('ResearchPaperBuildContinuationCanonicalizationFailed')
  }
  return pipe(
    canonicalHashV1Result(material),
    Result.mapError(() => 'ResearchPaperBuildContinuationCanonicalizationFailed' as const),
    Result.map((continuationHash) => ({ ...material, continuationHash }) as ResearchPaperBuildContinuation),
  )
}

export const isResearchPaperActivationRequest = (
  request: PaperActivationRequest,
): request is ResearchPaperActivationRequest => request.schemaVersion === researchPaperActivationRequestSchemaVersion

export const researchCapitalGrantProof = (
  request: ResearchPaperActivationRequest,
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

const researchPaperGenerationIsBoundToRequestDataFirst = (
  request: ResearchPaperActivationRequest,
  sourceGenerationHash: string,
  generation: ResearchCapitalGrantGeneration,
): Result.Result<void, string> => {
  if (
    generation.maximum !== Authority.Paper ||
    generation.previousGenerationHash !== sourceGenerationHash ||
    generation.grant.planHash !== request.grant.planHash
  ) {
    return Result.fail('research PAPER generation identity is not bound to the activation request')
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
    return Result.fail('research PAPER generation is not bound to the requested current strategy and build')
  }
  if (
    generation.accountId !== request.broker.accountId ||
    generation.brokerIdentityHash !== request.broker.identityHash ||
    generation.riskPolicyHash !== request.riskPolicyHash ||
    generation.proofPlanHash !== request.grant.planHash
  ) {
    return Result.fail('research PAPER generation is not bound to the requested broker and risk controls')
  }
  return Result.succeed(undefined)
}

export const researchPaperGenerationIsBoundToRequest = Pipeable.dual(
  3,
  researchPaperGenerationIsBoundToRequestDataFirst,
)

export const researchPaperBuildContinuationIsBound = (
  continuation: ResearchPaperBuildContinuation,
  sourceGenerationHash: string,
  generation: ResearchCapitalGrantGeneration,
  currentActivation: PaperActivationRevisionBinding,
): Result.Result<void, string> => {
  if (
    continuation.generationHash !== generation.generationHash ||
    continuation.activation.sourceRevision !== currentActivation.sourceRevision ||
    continuation.activation.imageRepository !== currentActivation.imageRepository ||
    continuation.activation.imageDigest !== currentActivation.imageDigest
  ) {
    return Result.fail('research PAPER build continuation is not bound to the active generation and current build')
  }
  return researchPaperGenerationIsBoundToRequest(continuation.request, sourceGenerationHash, generation)
}

export const PaperActivationRequestSchema = Schema.Union([
  QualifiedPaperActivationRequestSchema,
  ResearchPaperActivationRequestSchema,
])
export type PaperActivationRequest = typeof PaperActivationRequestSchema.Type

export const PaperActivationConfigurationSchema = Schema.Union([
  PaperActivationRequestSchema,
  ResearchPaperBuildContinuationSchema,
])
export type PaperActivationConfiguration = typeof PaperActivationConfigurationSchema.Type

export const isResearchPaperBuildContinuation = (
  configuration: PaperActivationConfiguration,
): configuration is ResearchPaperBuildContinuation =>
  configuration.schemaVersion === researchPaperBuildContinuationSchemaVersion

const requestWithoutHash = (
  request:
    | QualifiedPaperActivationRequest
    | ResearchPaperActivationRequest
    | (typeof PaperActivationRequestMaterialSchema.Type & { readonly requestHash: string }),
) => {
  const { requestHash: _requestHash, ...material } = request
  return material
}

export const makePaperActivationRequest = (
  material: typeof PaperActivationRequestMaterialSchema.Type,
): Result.Result<QualifiedPaperActivationRequest, 'PaperActivationRequestCanonicalizationFailed'> =>
  pipe(
    canonicalHashV1Result(material),
    Result.mapError(() => 'PaperActivationRequestCanonicalizationFailed' as const),
    Result.flatMap((requestHash) => Result.succeed({ ...material, requestHash } as QualifiedPaperActivationRequest)),
  )

export const makeResearchPaperActivationRequest = (
  material: typeof ResearchPaperActivationRequestMaterialSchema.Type,
): Result.Result<
  ResearchPaperActivationRequest,
  'PaperActivationRequestCanonicalizationFailed' | 'ResearchPaperCloseWindowInvalid' | 'ResearchPaperPlanHashMismatch'
> => {
  if (material.expiresAt <= material.cutoffAt) return Result.fail('ResearchPaperCloseWindowInvalid')
  const planHash = makeResearchPaperPlanHash(researchPlanMaterial(material))
  if (Result.isFailure(planHash)) return Result.fail('PaperActivationRequestCanonicalizationFailed')
  if (material.grant.planHash !== planHash.success) return Result.fail('ResearchPaperPlanHashMismatch')
  return pipe(
    canonicalHashV1Result(material),
    Result.mapError(() => 'PaperActivationRequestCanonicalizationFailed' as const),
    Result.map((requestHash) => ({ ...material, requestHash }) as ResearchPaperActivationRequest),
  )
}

const decodePaperActivationRequestResultDataFirst = Schema.decodeUnknownResult(
  PaperActivationRequestSchema,
  strictParseOptions,
)

export const decodePaperActivationRequestResult = Pipeable.dual(1, (input: unknown) =>
  decodePaperActivationRequestResultDataFirst(input),
)

const decodePaperActivationConfigurationResultDataFirst = Schema.decodeUnknownResult(
  PaperActivationConfigurationSchema,
  strictParseOptions,
)

export const decodePaperActivationConfigurationResult = Pipeable.dual(1, (input: unknown) =>
  decodePaperActivationConfigurationResultDataFirst(input),
)

export type CapitalAuthorityRequest = NoCapitalRequest | SandboxCapitalRequest | LiveCapitalGrantRequest

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
      readonly brokerIdentity: BrokerIdentity & { readonly environment: BrokerEnvironment.Sandbox }
      readonly brokerAccess: BrokerAccess.Mutation
      readonly capitalAuthority: SandboxCapitalRequest
    }
  | {
      readonly brokerIdentity: BrokerIdentity & { readonly environment: BrokerEnvironment.Live }
      readonly brokerAccess: BrokerAccess.Mutation
      readonly capitalAuthority: LiveCapitalGrantRequest
    }

export interface ExecutionPolicyInput {
  readonly brokerIdentity: BrokerIdentity | undefined
  readonly brokerAccess: BrokerAccess
  readonly capitalAuthority: CapitalAuthoritySelection
  readonly authorityGenerationHash: string | undefined
  readonly liveCapitalGrantHash: string | undefined
}

export type ExecutionPolicyResolutionFailure =
  | {
      readonly _tag: 'BrokerAccessRequiresConnection'
      readonly brokerAccess: BrokerAccess.Mutation
    }
  | {
      readonly _tag: 'CapitalAuthorityRequiresConnection'
      readonly capitalAuthority: CapitalAuthoritySelection.Sandbox | CapitalAuthoritySelection.LiveGrant
    }
  | {
      readonly _tag: 'ReadOnlyBrokerRequiresNoCapital'
      readonly capitalAuthority: CapitalAuthoritySelection.Sandbox | CapitalAuthoritySelection.LiveGrant
    }
  | {
      readonly _tag: 'MutationBrokerRequiresCapitalAuthority'
      readonly environment: BrokerEnvironment
    }
  | {
      readonly _tag: 'SandboxBrokerRequiresSandboxCapital'
      readonly capitalAuthority: CapitalAuthoritySelection.LiveGrant
    }
  | {
      readonly _tag: 'LiveBrokerRequiresLiveCapitalGrant'
      readonly capitalAuthority: CapitalAuthoritySelection.Sandbox
    }
  | {
      readonly _tag: 'SandboxCapitalRequiresAuthorityGeneration'
    }
  | {
      readonly _tag: 'LiveCapitalRequiresGrantHash'
    }
  | {
      readonly _tag: 'LiveCapitalRequiresAuthorityGeneration'
    }
  | {
      readonly _tag: 'UnexpectedAuthorityGenerationHash'
      readonly brokerEnvironment: BrokerEnvironment | undefined
      readonly capitalAuthority: CapitalAuthoritySelection
    }
  | {
      readonly _tag: 'UnexpectedLiveCapitalGrantHash'
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
  if (input.capitalAuthority !== CapitalAuthoritySelection.LiveGrant && input.liveCapitalGrantHash !== undefined) {
    return Result.fail({
      _tag: 'UnexpectedLiveCapitalGrantHash',
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

  if (input.brokerIdentity.environment === BrokerEnvironment.Sandbox) {
    if (input.capitalAuthority !== CapitalAuthoritySelection.Sandbox) {
      return Result.fail({
        _tag: 'SandboxBrokerRequiresSandboxCapital',
        capitalAuthority: CapitalAuthoritySelection.LiveGrant,
      })
    }
    if (input.authorityGenerationHash === undefined) {
      return Result.fail({ _tag: 'SandboxCapitalRequiresAuthorityGeneration' })
    }
    return Result.succeed({
      brokerIdentity: input.brokerIdentity as BrokerIdentity & { readonly environment: BrokerEnvironment.Sandbox },
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: {
        _tag: CapitalAuthorityKind.Sandbox,
        authorityGenerationHash: input.authorityGenerationHash,
      },
    })
  }

  if (input.capitalAuthority !== CapitalAuthoritySelection.LiveGrant) {
    return Result.fail({
      _tag: 'LiveBrokerRequiresLiveCapitalGrant',
      capitalAuthority: CapitalAuthoritySelection.Sandbox,
    })
  }
  if (input.liveCapitalGrantHash === undefined) {
    return Result.fail({ _tag: 'LiveCapitalRequiresGrantHash' })
  }
  if (input.authorityGenerationHash === undefined) {
    return Result.fail({ _tag: 'LiveCapitalRequiresAuthorityGeneration' })
  }
  return Result.succeed({
    brokerIdentity: input.brokerIdentity as BrokerIdentity & { readonly environment: BrokerEnvironment.Live },
    brokerAccess: BrokerAccess.Mutation,
    capitalAuthority: {
      _tag: CapitalAuthorityKind.LiveGrant,
      grantHash: input.liveCapitalGrantHash,
      authorityGenerationHash: input.authorityGenerationHash,
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
    case 'SandboxBrokerRequiresSandboxCapital':
      return 'sandbox broker mutation requires sandbox-capital authority'
    case 'LiveBrokerRequiresLiveCapitalGrant':
      return 'live broker mutation requires a persisted live-capital-grant'
    case 'SandboxCapitalRequiresAuthorityGeneration':
      return 'sandbox-capital authority requires an authority generation hash'
    case 'LiveCapitalRequiresGrantHash':
      return 'live-capital-grant authority requires a persisted grant hash'
    case 'LiveCapitalRequiresAuthorityGeneration':
      return 'live-capital-grant authority requires the configured authority generation hash'
    case 'UnexpectedAuthorityGenerationHash':
      return `authority generation hash is not valid for ${failure.capitalAuthority}`
    case 'UnexpectedLiveCapitalGrantHash':
      return `live capital grant hash is not valid for ${failure.capitalAuthority}`
  }
}
