import { dirname, resolve } from 'node:path'
import { Effect, FileSystem, Schema } from 'effect'

import { sha256 } from '../hash'
import { Sha256Schema, StrictNonEmptyStringSchema, strictParseOptions } from '../schemas'
import { SystemAssessmentError } from './economics'

const PacketSchema = Schema.Struct({
  payload: Schema.Unknown,
  artifacts: Schema.Array(Schema.Struct({ sha256: Sha256Schema, path: StrictNonEmptyStringSchema })),
})

/** Private source files remain local. A digest binds bytes; provider authenticity requires the recorded provenance audit. */
export const readSystemEvidencePacket = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const packet = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PacketSchema),
      strictParseOptions,
    )(yield* fs.readFileString(path))
    const verifiedSources = new Set<string>()
    const artifacts = new Map<string, Uint8Array>()
    for (const artifact of packet.artifacts) {
      const bytes = yield* fs.readFile(resolve(dirname(path), artifact.path))
      if (sha256(bytes) !== artifact.sha256)
        return yield* new SystemAssessmentError({
          message: 'System evidence artifact digest differs from its registered source',
        })
      verifiedSources.add(artifact.sha256)
      artifacts.set(artifact.sha256, bytes)
    }
    return { payload: packet.payload, verifiedSources, artifacts }
  }).pipe(
    Effect.mapError(
      (cause) => new SystemAssessmentError({ message: 'System evidence packet could not be read', cause }),
    ),
  )
