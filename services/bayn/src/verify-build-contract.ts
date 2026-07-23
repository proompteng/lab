import { NodeRuntime } from '@effect/platform-node'
import { Effect, Schema } from 'effect'

import { riskBalancedTrendBehaviorHash } from './behavior'
import { embeddedBuildMetadata, EmbeddedBuildMetadataSchema, verifyBehaviorHash, verifyParameterHash } from './build'
import { operationalError } from './errors'
import { hashParameters, loadDefaultProtocol } from './protocol'
import { strictParseOptions } from './schemas'

const program = Effect.gen(function* () {
  const metadata = yield* Schema.decodeUnknownEffect(
    EmbeddedBuildMetadataSchema,
    strictParseOptions,
  )(embeddedBuildMetadata).pipe(
    Effect.mapError((cause) =>
      operationalError('config', 'provenance', 'production image is missing complete build metadata', cause),
    ),
  )
  const protocol = yield* loadDefaultProtocol
  yield* Effect.all([
    verifyBehaviorHash(metadata, riskBalancedTrendBehaviorHash),
    verifyParameterHash(metadata, hashParameters(protocol)),
  ])
})

NodeRuntime.runMain(program)
