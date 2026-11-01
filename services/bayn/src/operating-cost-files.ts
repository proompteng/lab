import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { Effect, FileSystem, Schema } from 'effect'

import { OperatingCostError, OperatingCostEvidenceSchema, operatingCostSourceHashes } from './operating-costs'
import { Sha256Schema, StrictNonEmptyStringSchema, strictParseOptions } from './schemas'

const PacketSchema = Schema.Struct({
  evidence: OperatingCostEvidenceSchema,
  artifacts: Schema.Array(Schema.Struct({ sha256: Sha256Schema, path: StrictNonEmptyStringSchema })),
})

/** Read-only imports bind the reviewed normalization to the original local artifact bytes. */
export const readOperatingCostPacket = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const packet = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(PacketSchema),
      strictParseOptions,
    )(yield* fs.readFileString(path))
    const verified = new Set<string>()
    for (const artifact of packet.artifacts) {
      const content = yield* fs.readFile(resolve(dirname(path), artifact.path))
      if (createHash('sha256').update(content).digest('hex') !== artifact.sha256)
        return yield* new OperatingCostError({ message: 'An operating-cost source file hash does not match' })
      verified.add(artifact.sha256)
    }
    if (operatingCostSourceHashes(packet.evidence).some((hash) => !verified.has(hash)))
      return yield* new OperatingCostError({ message: 'The operating-cost packet omits a required source artifact' })
    return { evidence: packet.evidence, verifiedSourceHashes: verified }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof OperatingCostError
        ? cause
        : new OperatingCostError({ message: 'Operating-cost packet could not be read or decoded', cause }),
    ),
  )
