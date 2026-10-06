import { sha256 } from '../hash'
import { Result, Schema } from 'effect'
import {
  CaptureDisposition,
  CaptureQualification,
  ResearchCaptureFailure,
  maximumResearchCaptureChunkBytes,
  type ResearchCaptureEvent,
  type ResearchCaptureBytes,
  type ResearchCaptureChunk,
} from './capture'
import {
  deriveResearchCaptureExportManifest,
  decodeResearchCaptureExportEnvelope,
  ResearchCaptureByteIndexSchema,
  ResearchCaptureExportManifestSchema,
  researchCaptureObjectKey,
  researchCaptureObject,
  verifyResearchCaptureExport,
  type ResearchCaptureObject,
  type ResearchCaptureExportEntry,
} from './export'

/** Retained v1 fixture writer; production writes only v2 envelopes. */
export const buildResearchCaptureExportChunk = (
  chunk: ResearchCaptureChunk,
  metadataBytes: ResearchCaptureBytes,
  entries: readonly ResearchCaptureExportEntry[],
  previousIndexHash: string | null,
) => {
  const parts: Uint8Array[] = []
  const ranges: Array<(typeof ResearchCaptureByteIndexSchema.Type.ranges)[number]> = []
  let offset = 0
  for (const entry of entries) {
    if (entry.receipt.event.kind !== 'market-record') continue
    const raw = entry.rawValue
    if (raw === undefined)
      throw new ResearchCaptureFailure({ message: 'Admitted market receipt lost its original bytes' })
    const range = {
      receiptSequence: entry.receipt.sequence,
      byteOffset: raw === null ? null : offset,
      byteLength: raw === null ? null : raw.byteLength,
    }
    if (Buffer.byteLength(JSON.stringify(range)) > 128)
      throw new ResearchCaptureFailure({ message: 'Byte range exceeds its admission reservation' })
    ranges.push(range)
    if (raw !== null) {
      parts.push(raw)
      offset += raw.byteLength
    }
  }
  const raw = researchCaptureObject(Buffer.concat(parts, offset))
  const metadata = researchCaptureObject(metadataBytes.payload)
  const reference = (object: ResearchCaptureObject) => ({
    contentHash: object.contentHash,
    byteLength: object.payload.byteLength,
  })
  const index = researchCaptureObject(
    JSON.stringify({
      schemaVersion: 'bayn.research-capture-byte-index.v1',
      qualification: CaptureQualification.Unqualified,
      captureId: chunk.captureId,
      sourceRevision: chunk.sourceRevision,
      chunkOrdinal: chunk.chunkOrdinal,
      previousIndexHash,
      metadata: reference(metadata),
      raw: reference(raw),
      ranges,
    } satisfies typeof ResearchCaptureByteIndexSchema.Type),
  )
  return { raw, metadata, index }
}

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
    const chunks: Array<{
      metadata: ResearchCaptureBytes
      index: ResearchCaptureBytes
      raw: Uint8Array
      envelope?: ResearchCaptureObject
    }> = []
    let hash = manifest.lastIndexHash
    for (let ordinal = sqlChunks.length - 1; ordinal >= 0; ordinal--) {
      if (hash === null) return yield* Result.fail(fail('Missing index tail'))
      const object = yield* read(hash)
      const envelope =
        manifest.schemaVersion === 'bayn.research-capture-export.v2'
          ? yield* decodeResearchCaptureExportEnvelope(object)
          : undefined
      const indexBytes = envelope?.index ?? asText(object)
      const index = yield* Schema.decodeUnknownResult(Schema.fromJsonString(ResearchCaptureByteIndexSchema))(
        indexBytes.payload,
      )
      const metadata = envelope?.metadata ?? asText(yield* read(index.metadata.contentHash))
      if (metadata.payload !== sqlChunks[ordinal]?.payload || metadata.contentHash !== sqlChunks[ordinal]?.contentHash)
        return yield* Result.fail(fail('SQL and exported metadata differ'))
      const raw = envelope?.raw ?? (yield* read(index.raw.contentHash)).payload
      chunks.unshift({ metadata, index: indexBytes, raw, ...(envelope === undefined ? {} : { envelope: object }) })
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
