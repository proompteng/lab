import { pipe, Result, Schema } from 'effect'

import type { BrokerIdentity } from '../broker/identity'
import { BrokerEnvironment } from '../broker/identity'
import { canonicalHashV1Result } from '../hash'
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

export const PaperActivationRequestSchema = Schema.Struct({
  ...PaperActivationRequestMaterialSchema.fields,
  requestHash: Sha256Schema,
}).check(
  Schema.makeFilter((request: typeof PaperActivationRequestMaterialSchema.Type & { readonly requestHash: string }) => {
    if (request.expiresAt <= request.cutoffAt) return false
    const expected = canonicalHashV1Result(requestWithoutHash(request))
    return Result.isSuccess(expected) && request.requestHash === expected.success
  }),
)

export type PaperActivationRequest = typeof PaperActivationRequestSchema.Type

const requestWithoutHash = (
  request:
    | PaperActivationRequest
    | (typeof PaperActivationRequestMaterialSchema.Type & { readonly requestHash: string }),
) => {
  const { requestHash: _requestHash, ...material } = request
  return material
}

export const makePaperActivationRequest = (
  material: typeof PaperActivationRequestMaterialSchema.Type,
): Result.Result<PaperActivationRequest, 'PaperActivationRequestCanonicalizationFailed'> =>
  pipe(
    canonicalHashV1Result(material),
    Result.mapError(() => 'PaperActivationRequestCanonicalizationFailed' as const),
    Result.flatMap((requestHash) => Result.succeed({ ...material, requestHash } as PaperActivationRequest)),
  )

export const decodePaperActivationRequestResult = Schema.decodeUnknownResult(
  PaperActivationRequestSchema,
  strictParseOptions,
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
  const exhaustive: never = failure
  return exhaustive
}
