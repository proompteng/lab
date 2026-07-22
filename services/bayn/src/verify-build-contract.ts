import { NodeRuntime } from '@effect/platform-node'
import { Effect, Schema } from 'effect'

import { embeddedBuildMetadata, EmbeddedBuildMetadataSchema, verifyParameterHash } from './build'
import { operationalError } from './errors'
import { hashParameters, loadDefaultProtocol } from './protocol'

const program = Effect.gen(function* () {
  const metadata = yield* Schema.decodeUnknownEffect(EmbeddedBuildMetadataSchema, {
    onExcessProperty: 'error',
  })(embeddedBuildMetadata).pipe(
    Effect.mapError((cause) =>
      operationalError('config', 'provenance', 'production image is missing complete build metadata', cause),
    ),
  )
  const protocol = yield* loadDefaultProtocol
  yield* verifyParameterHash(metadata, hashParameters(protocol))
})

NodeRuntime.runMain(program)
