import { sha256 } from '../hash'
import { Result, Schema } from 'effect'
import {
  CaptureDisposition,
  ResearchCaptureFailure,
  maximumResearchCaptureChunkBytes,
  type ResearchCaptureEvent,
  type ResearchCaptureBytes,
} from './capture'
import {
  deriveResearchCaptureExportManifest,
  ResearchCaptureByteIndexSchema,
  ResearchCaptureExportManifestSchema,
  researchCaptureObjectKey,
  verifyResearchCaptureExport,
  type ResearchCaptureObject,
} from './export'

export const recoverCaptureFromStoredObjects = (
  sqlChunks: readonly ResearchCaptureBytes[],
  sqlSeal: ResearchCaptureBytes | undefined,
  get: (key: string) => ResearchCaptureObject | undefined,
) =>
  Result.gen(function* () {
    const fail = (message: string) => new ResearchCaptureFailure({ message })
    const read = (hash: string) =>
      Result.gen(function* () {
        const object = get(researchCaptureObjectKey(hash))
        if (object === undefined) return yield* Result.fail(fail('Missing immutable object'))
        if (
          object.payload.byteLength > maximumResearchCaptureChunkBytes ||
          object.contentHash !== hash ||
          sha256(object.payload) !== hash
        )
          return yield* Result.fail(fail('Corrupt immutable object'))
        return object
      })
    const asText = (object: ResearchCaptureObject): ResearchCaptureBytes => ({
      contentHash: object.contentHash,
      payload: Buffer.from(object.payload).toString('utf8'),
    })
    const expectedManifest = yield* deriveResearchCaptureExportManifest(sqlSeal)
    if (sqlSeal === undefined) return yield* Result.fail(fail('Missing durable SQL seal'))
    const manifestBytes = asText(yield* read(expectedManifest.contentHash))
    if (manifestBytes.payload !== Buffer.from(expectedManifest.payload).toString('utf8'))
      return yield* Result.fail(fail('Manifest differs from durable seal'))
    const manifest = yield* Schema.decodeUnknownResult(Schema.fromJsonString(ResearchCaptureExportManifestSchema))(
      manifestBytes.payload,
    )
    if (manifest.exportedChunks !== sqlChunks.length)
      return yield* Result.fail(fail('SQL frontier differs from export root'))
    const chunks: Array<{ metadata: ResearchCaptureBytes; index: ResearchCaptureBytes; raw: Uint8Array }> = []
    let hash = manifest.lastIndexHash
    for (let ordinal = sqlChunks.length - 1; ordinal >= 0; ordinal--) {
      if (hash === null) return yield* Result.fail(fail('Missing index tail'))
      const indexBytes = asText(yield* read(hash))
      const index = yield* Schema.decodeUnknownResult(Schema.fromJsonString(ResearchCaptureByteIndexSchema))(
        indexBytes.payload,
      )
      const metadata = asText(yield* read(index.metadata.contentHash))
      if (metadata.payload !== sqlChunks[ordinal]?.payload || metadata.contentHash !== sqlChunks[ordinal]?.contentHash)
        return yield* Result.fail(fail('SQL and exported metadata differ'))
      const raw = yield* read(index.raw.contentHash)
      chunks.unshift({ metadata, index: indexBytes, raw: raw.payload })
      hash = index.previousIndexHash
    }
    if (hash !== null) return yield* Result.fail(fail('Index chain exceeds SQL frontier'))
    return yield* verifyResearchCaptureExport(chunks, sqlSeal, manifestBytes)
  })

export const captureEvent = (phase: 'STARTED' | 'STOPPED'): ResearchCaptureEvent => ({
  kind: 'consumer-boundary',
  consumerEpoch: 'consumer-1',
  phase,
  positions: [],
})
export const marketEvent: Extract<ResearchCaptureEvent, { readonly kind: 'market-record' }> = {
  kind: 'market-record',
  consumerEpoch: 'consumer-1',
  consumerSequence: 1,
  projectionSequence: 1,
  topic: 'quotes',
  partition: 0,
  offset: '0',
  rawValueSha256: sha256('é'),
  rawByteLength: 2,
  tombstone: false,
  bootstrap: false,
  disposition: CaptureDisposition.Accepted,
}

export const fullCaptureBufferEvents = (lastReceiptBytes = 64 * 1024): readonly ResearchCaptureEvent[] =>
  Array.from({ length: 64 }, (_, index) => {
    const event: ResearchCaptureEvent = {
      kind: 'consumer-boundary',
      consumerEpoch: 'consumer-1',
      phase: index === 0 ? 'STARTED' : index === 63 ? 'STOPPED' : 'ASSIGNED',
      positions: [],
      reason: 'x',
    }
    const targetBytes = index === 63 ? lastReceiptBytes : 64 * 1024
    const remaining = targetBytes - Buffer.byteLength(JSON.stringify({ sequence: index + 1, observedAtMs: 100, event }))
    return { ...event, reason: `x${'é'.repeat(Math.floor(remaining / 2))}${'x'.repeat(remaining % 2)}` }
  })
