import { NodeRuntime } from '@effect/platform-node'
import { Effect, Schema } from 'effect'

import { embeddedBuildMetadata, EmbeddedBuildMetadataSchema, verifyBehaviorHash, verifyParameterHash } from './build'
import { operationalError } from './errors'
import { canonicalHashV1Result } from './hash'
import { strictParseOptions } from './schemas'
import { activeStrategyBehaviorHash, loadActiveStrategyProtocol } from './strategy'

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
  yield* Effect.all([
    verifyBehaviorHash(metadata, activeStrategyBehaviorHash),
    verifyParameterHash(metadata, parameterHash),
  ])
})

NodeRuntime.runMain(program)
