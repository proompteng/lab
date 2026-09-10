import { NodeRuntime } from '@effect/platform-node'
import { Effect, Schema } from 'effect'

import {
  embeddedBuildMetadata,
  embeddedRuntimeIdentity,
  EmbeddedBuildMetadataSchema,
  EmbeddedRuntimeIdentitySchema,
  verifyBehaviorHash,
  verifyExecutionRiskPolicyHash,
  verifyParameterHash,
  verifyStrategyName,
  verifyStrategyProtocolHash,
} from './build'
import { makeStrategyProtocolHashResult } from './contracts'
import { operationalError } from './errors'
import { canonicalHashV1Result } from './hash'
import { loadQuoteBoundExecutionRiskPolicy } from './observe-composition/decision-builder'
import { strictParseOptions } from './schemas'
import { activeStrategyBehaviorHash, activeStrategyName, loadActiveStrategyProtocol } from './strategy'

const program = Effect.gen(function* () {
  const metadata = yield* Schema.decodeUnknownEffect(
    EmbeddedBuildMetadataSchema,
    strictParseOptions,
  )(embeddedBuildMetadata).pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'config',
        operation: 'provenance',
        message: 'production image is missing complete build metadata',
        cause,
      }),
    ),
  )
  const runtimeIdentity = yield* Schema.decodeUnknownEffect(
    EmbeddedRuntimeIdentitySchema,
    strictParseOptions,
  )(embeddedRuntimeIdentity).pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'config',
        operation: 'provenance',
        message: 'production image is missing complete runtime identity',
        cause,
      }),
    ),
  )
  const protocol = yield* Effect.fromResult(loadActiveStrategyProtocol())
  const parameterHash = yield* Effect.fromResult(canonicalHashV1Result(protocol)).pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'provenance',
        message: 'compiled strategy parameters could not be canonically hashed',
        cause,
      }),
    ),
  )
  const protocolHash = yield* Effect.fromResult(
    makeStrategyProtocolHashResult({
      name: activeStrategyName,
      behaviorHash: activeStrategyBehaviorHash,
      parameterHash,
      parameterSchemaVersion: protocol.schemaVersion,
    }),
  ).pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'provenance',
        message: 'compiled strategy protocol could not be canonically hashed',
        cause,
      }),
    ),
  )
  const riskPolicy = yield* loadQuoteBoundExecutionRiskPolicy('build-contract', protocol.universe).pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'provenance',
        message: 'compiled execution risk policy is invalid',
        cause,
      }),
    ),
  )
  const riskPolicyHash = yield* Effect.fromResult(canonicalHashV1Result(riskPolicy)).pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'strategy',
        operation: 'provenance',
        message: 'compiled execution risk policy could not be canonically hashed',
        cause,
      }),
    ),
  )
  yield* Effect.all([
    verifyBehaviorHash(metadata, activeStrategyBehaviorHash),
    verifyParameterHash(metadata, parameterHash),
    verifyStrategyName(runtimeIdentity, activeStrategyName),
    verifyStrategyProtocolHash(runtimeIdentity, protocolHash),
    verifyExecutionRiskPolicyHash(runtimeIdentity, riskPolicyHash),
  ])
})

NodeRuntime.runMain(program)
