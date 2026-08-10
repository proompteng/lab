import { Effect, flow, Match, pipe, Result } from 'effect'

import { makeApplicationPlan, type ApplicationIdentity, type ApplicationPlan } from './app'
import {
  activeStrategyBehaviorHash,
  activeStrategyName,
  makeActiveStrategyApplication,
  type StrategyRuntime,
} from './strategy'
import { verifyBehaviorHash, verifyParameterHash } from './build'
import { loadConfig, type LoadedRuntimeConfig } from './config'
import {
  makeRuntimeProvenanceResult,
  makeStrategyProtocolHashResult,
  type ContractConstructionFailure,
  type RuntimeProvenance,
} from './contracts'
import { operationalError } from './errors'
import { canonicalHashV1Result, type CanonicalJsonFailure } from './hash'
import { loadDefaultProtocol, type CausalProtocol } from './protocol'

type RuntimeIdentityFailure =
  | {
      readonly _tag: 'RuntimeParameterHashFailed'
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly _tag: 'RuntimeProvenanceFailed'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'RuntimeStrategyProtocolHashFailed'
      readonly cause: ContractConstructionFailure
    }

type RuntimeSeed = {
  readonly config: LoadedRuntimeConfig
  readonly protocol: CausalProtocol
}

type ParameterizedRuntime = RuntimeSeed & { readonly parameterHash: string }
type ProvenanceRuntime = ParameterizedRuntime & { readonly provenance: RuntimeProvenance }
type SelectedRuntime = ProvenanceRuntime & { readonly strategy: StrategyRuntime }

const selectStrategy = (runtime: ProvenanceRuntime): StrategyRuntime => {
  const application = makeActiveStrategyApplication(runtime.protocol)
  return { application, definition: application.definition, provenance: runtime.provenance }
}

const hashRuntimeParameters = (seed: RuntimeSeed): Result.Result<ParameterizedRuntime, RuntimeIdentityFailure> =>
  pipe(
    canonicalHashV1Result(seed.protocol),
    Result.mapError((cause): RuntimeIdentityFailure => ({ _tag: 'RuntimeParameterHashFailed', cause })),
    Result.map((parameterHash) => ({ ...seed, parameterHash })),
  )

const addRuntimeProvenance = (
  parameterized: ParameterizedRuntime,
): Result.Result<ProvenanceRuntime, RuntimeIdentityFailure> =>
  pipe(
    makeRuntimeProvenanceResult({
      sourceRevision: parameterized.config.build.sourceRevision,
      image: {
        repository: parameterized.config.build.imageRepository,
        digest: parameterized.config.build.imageDigest,
      },
      strategy: {
        name: activeStrategyName,
        behaviorHash: activeStrategyBehaviorHash,
        parameterHash: parameterized.parameterHash,
        parameterSchemaVersion: parameterized.protocol.schemaVersion,
      },
    }),
    Result.mapError(
      (cause): RuntimeIdentityFailure => ({
        _tag: 'RuntimeProvenanceFailed',
        cause,
      }),
    ),
    Result.map((provenance) => ({ ...parameterized, provenance })),
  )

const addStrategy = (runtime: ProvenanceRuntime): SelectedRuntime => ({ ...runtime, strategy: selectStrategy(runtime) })

const addStrategyProtocolHash = (
  runtime: SelectedRuntime,
): Result.Result<ApplicationIdentity, RuntimeIdentityFailure> =>
  pipe(
    makeStrategyProtocolHashResult(runtime.strategy.provenance.strategy),
    Result.mapError(
      (cause): RuntimeIdentityFailure => ({
        _tag: 'RuntimeStrategyProtocolHashFailed',
        cause,
      }),
    ),
    Result.map((strategyProtocolHash) => ({
      config: runtime.config,
      protocol: runtime.protocol,
      parameterHash: runtime.parameterHash,
      strategy: runtime.strategy,
      strategyProtocolHash,
    })),
  )

const makeRuntimeIdentity = flow(
  hashRuntimeParameters,
  Result.flatMap(addRuntimeProvenance),
  Result.map(addStrategy),
  Result.flatMap(addStrategyProtocolHash),
)

const runtimeIdentityError = (failure: RuntimeIdentityFailure) =>
  pipe(
    Match.value(failure),
    Match.tag('RuntimeParameterHashFailed', ({ cause }) =>
      operationalError({
        component: 'strategy',
        operation: 'runtime-identity/parameter-hash',
        message: 'runtime strategy parameter-hash construction failed',
        cause,
      }),
    ),
    Match.tag('RuntimeProvenanceFailed', ({ cause }) =>
      operationalError({
        component: 'strategy',
        operation: 'runtime-identity/provenance',
        message: 'runtime strategy provenance construction failed',
        cause,
      }),
    ),
    Match.tag('RuntimeStrategyProtocolHashFailed', ({ cause }) =>
      operationalError({
        component: 'strategy',
        operation: 'runtime-identity/strategy-protocol-hash',
        message: 'runtime strategy protocol-hash construction failed',
        cause,
      }),
    ),
    Match.exhaustive,
  )

const verifyRuntimeIdentity = (
  identity: ApplicationIdentity,
): Effect.Effect<ApplicationIdentity, ReturnType<typeof operationalError>> =>
  pipe(
    Effect.all(
      [
        verifyBehaviorHash(identity.config.build, activeStrategyBehaviorHash),
        verifyParameterHash(identity.config.build, identity.parameterHash),
      ],
      { discard: true },
    ),
    Effect.as(identity),
  )

export const loadApplicationPlan = pipe(
  Effect.all({ config: loadConfig(), protocol: loadDefaultProtocol }),
  Effect.flatMap(flow(makeRuntimeIdentity, Effect.fromResult, Effect.mapError(runtimeIdentityError))),
  Effect.flatMap(verifyRuntimeIdentity),
  Effect.map(makeApplicationPlan),
)

export type { ApplicationPlan }
