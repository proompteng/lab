import { Effect, Result, Schema } from 'effect'

import { sha256 } from '../hash'
import { GitSourceRevisionSchema, NonNegativeIntegerSchema, Sha256Schema, strictParseOptions } from '../schemas'
import {
  CaptureQualification,
  ResearchCaptureFailure,
  ResearchCaptureIdSchema,
  decodeResearchCaptureChunk,
  decodeResearchCaptureSeal,
  maximumResearchCaptureChunkBytes,
  verifyResearchCapture,
  verifyResearchCapturePrefix,
  type ResearchCaptureBytes,
  type ResearchCaptureReceipt,
} from './capture'

export interface ResearchCaptureObject {
  readonly contentHash: string
  readonly payload: Uint8Array
}

export interface ResearchCaptureObjectStore {
  readonly putVerified: (object: ResearchCaptureObject) => Effect.Effect<void, ResearchCaptureFailure>
}

export interface ResearchCaptureExportEntry {
  readonly receipt: ResearchCaptureReceipt
  readonly rawValue?: Uint8Array | null
}

const ObjectReferenceSchema = Schema.Struct({
  contentHash: Sha256Schema,
  byteLength: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(maximumResearchCaptureChunkBytes)),
})
export const ResearchCaptureExportManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.research-capture-export.v2'),
  qualification: Schema.Enum(CaptureQualification),
  captureId: ResearchCaptureIdSchema,
  sourceRevision: GitSourceRevisionSchema,
  exportedChunks: NonNegativeIntegerSchema,
  lastChunkHash: Schema.NullOr(Sha256Schema),
  metadataSeal: ObjectReferenceSchema,
})

const frameMagic = Buffer.from('BAYNCAP2', 'ascii')
// Magic, uint32 metadata length, previous-hash presence, and 32 hash bytes.
export const researchCaptureExportChunkHeaderBytes = 45
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// Reserve wire payloads, including assembly and readback, rather than claiming a bound on JavaScript or SDK RSS.
export const researchCaptureExportEnvelopeReservation = 64 * 1024
export const researchCaptureExportEntryReservation = (receiptBytes: number, rawBytes: number): number =>
  4 * receiptBytes + 3 * rawBytes

export const researchCaptureObject = (payload: string | Uint8Array): ResearchCaptureObject => {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  return { contentHash: sha256(bytes), payload: bytes }
}
export const researchCaptureObjectKey = (contentHash: string): string => `research-capture/sha256/${contentHash}`
const reference = (object: ResearchCaptureObject) => ({
  contentHash: object.contentHash,
  byteLength: object.payload.byteLength,
})
const fail = (message: string, cause?: unknown) =>
  new ResearchCaptureFailure({ message, ...(cause === undefined ? {} : { cause }) })

export const buildResearchCaptureExportChunk = (
  metadataBytes: ResearchCaptureBytes,
  entries: readonly ResearchCaptureExportEntry[],
  previousChunkHash: string | null,
): ResearchCaptureObject => {
  const metadata = Buffer.from(metadataBytes.payload, 'utf8')
  const header = Buffer.alloc(researchCaptureExportChunkHeaderBytes)
  header.set(frameMagic)
  header.writeUInt32BE(metadata.byteLength, 8)
  if (previousChunkHash !== null) {
    const hash = Schema.decodeUnknownResult(Sha256Schema)(previousChunkHash)
    if (Result.isFailure(hash)) throw fail('Invalid previous capture frame hash', hash.failure)
    header[12] = 1
    header.set(Buffer.from(hash.success, 'hex'), 13)
  }
  const parts: Uint8Array[] = [header, metadata]
  let size = header.byteLength + metadata.byteLength
  for (const entry of entries) {
    if (entry.receipt.event.kind !== 'market-record') continue
    const raw = entry.rawValue
    if (raw === undefined) throw fail('Admitted market receipt lost its original bytes')
    if (raw !== null) {
      size += raw.byteLength
      if (size > maximumResearchCaptureChunkBytes) throw fail('Capture frame exceeds its exact byte bound')
      parts.push(raw)
    }
  }
  if (size > maximumResearchCaptureChunkBytes) throw fail('Capture frame exceeds its exact byte bound')
  return researchCaptureObject(Buffer.concat(parts, size))
}

/** The receipt order and lengths delimit original values; no second range-index representation exists. */
export const decodeResearchCaptureExportChunk = (object: ResearchCaptureObject) =>
  Result.gen(function* () {
    if (
      !(object.payload instanceof Uint8Array) ||
      object.payload.byteLength < researchCaptureExportChunkHeaderBytes ||
      object.payload.byteLength > maximumResearchCaptureChunkBytes ||
      sha256(object.payload) !== object.contentHash
    )
      return yield* Result.fail(fail('Capture frame exceeds its byte bound or differs from its content address'))
    const bytes = Buffer.from(object.payload.buffer, object.payload.byteOffset, object.payload.byteLength)
    if (!bytes.subarray(0, 8).equals(frameMagic))
      return yield* Result.fail(fail('Capture frame has an unsupported wire version'))
    const metadataLength = bytes.readUInt32BE(8)
    const metadataEnd = researchCaptureExportChunkHeaderBytes + metadataLength
    if (metadataLength === 0 || metadataEnd > bytes.byteLength)
      return yield* Result.fail(fail('Capture frame truncates its exact metadata'))
    const previousHashBytes = bytes.subarray(13, researchCaptureExportChunkHeaderBytes)
    if (bytes[12] !== 0 && bytes[12] !== 1)
      return yield* Result.fail(fail('Capture frame has an invalid previous-hash presence flag'))
    if (bytes[12] === 0 && previousHashBytes.some((value) => value !== 0))
      return yield* Result.fail(fail('Capture frame has a noncanonical absent previous hash'))
    const previousChunkHash = bytes[12] === 0 ? null : previousHashBytes.toString('hex')
    const payload = yield* Result.try({
      try: () => utf8.decode(bytes.subarray(researchCaptureExportChunkHeaderBytes, metadataEnd)),
      catch: (cause) => fail('Capture frame metadata is not exact UTF8', cause),
    })
    const metadata = { contentHash: sha256(payload), payload }
    const chunk = yield* decodeResearchCaptureChunk(metadata)
    const rawValues = new Map<number, Uint8Array | null>()
    let offset = metadataEnd
    for (const receipt of chunk.receipts) {
      const event = receipt.event
      if (event.kind !== 'market-record') continue
      if (event.originalTransport === undefined)
        return yield* Result.fail(fail('Raw export omits the original transport timestamp contract'))
      if (event.tombstone) {
        if (event.rawByteLength !== null || event.rawValueSha256 !== null)
          return yield* Result.fail(fail('Tombstone has a raw byte identity'))
        rawValues.set(receipt.sequence, null)
      } else {
        if (
          event.rawByteLength === null ||
          event.rawValueSha256 === null ||
          event.rawByteLength > bytes.byteLength - offset
        )
          return yield* Result.fail(fail('Capture frame truncates an original Kafka value'))
        const raw = bytes.subarray(offset, offset + event.rawByteLength)
        if (sha256(raw) !== event.rawValueSha256)
          return yield* Result.fail(fail('Capture frame changed original Kafka bytes'))
        rawValues.set(receipt.sequence, raw)
        offset += event.rawByteLength
      }
    }
    if (offset !== bytes.byteLength) return yield* Result.fail(fail('Capture frame contains unreferenced raw bytes'))
    return { metadata, chunk, previousChunkHash, rawValues }
  })

export const deriveResearchCaptureExportManifest = (sealBytes: ResearchCaptureBytes | undefined) =>
  Result.gen(function* () {
    if (sealBytes === undefined) return yield* Result.fail(fail('Unsealed capture has no durable export root'))
    const seal = yield* decodeResearchCaptureSeal(sealBytes)
    const root = seal.exportRoot
    if (root === undefined) return yield* Result.fail(fail('Metadata-only seal has no durable export root'))
    const metadataSeal = researchCaptureObject(sealBytes.payload)
    return researchCaptureObject(
      JSON.stringify({
        schemaVersion: 'bayn.research-capture-export.v2',
        qualification: CaptureQualification.Unqualified,
        captureId: seal.captureId,
        sourceRevision: seal.sourceRevision,
        exportedChunks: root.exportedChunks,
        lastChunkHash: root.lastChunkHash,
        metadataSeal: reference(metadataSeal),
      } satisfies typeof ResearchCaptureExportManifestSchema.Type),
    )
  })

export const persistResearchCaptureExportSeal = (store: ResearchCaptureObjectStore, sealBytes: ResearchCaptureBytes) =>
  Effect.gen(function* () {
    const manifest = yield* Effect.fromResult(deriveResearchCaptureExportManifest(sealBytes)).pipe(
      Effect.mapError((cause) => fail('Invalid capture export root', cause)),
    )
    yield* Effect.all([store.putVerified(researchCaptureObject(sealBytes.payload)), store.putVerified(manifest)], {
      concurrency: 2,
      discard: true,
    })
    return manifest.contentHash
  })

const decodeExport = <A>(schema: Schema.Codec<A>, bytes: ResearchCaptureBytes) =>
  Result.gen(function* () {
    if (
      Buffer.byteLength(bytes.payload) > maximumResearchCaptureChunkBytes ||
      sha256(bytes.payload) !== bytes.contentHash
    )
      return yield* Result.fail(fail('Export object exceeds its byte bound or has a different hash'))
    return yield* Schema.decodeUnknownResult(Schema.fromJsonString(schema), strictParseOptions)(bytes.payload)
  })

/** Readback proves these objects, never missing source coverage or trading authority. */
const verifyExport = (
  objects: readonly ResearchCaptureObject[],
  sealBytes: ResearchCaptureBytes,
  manifestBytes: ResearchCaptureBytes,
  prefix: boolean,
) =>
  Result.gen(function* () {
    const chunks = []
    for (const object of objects) chunks.push(yield* decodeResearchCaptureExportChunk(object))
    const capture = yield* (prefix ? verifyResearchCapturePrefix : verifyResearchCapture)(
      chunks.map((chunk) => chunk.metadata),
      sealBytes,
    )
    const manifest = yield* decodeExport(ResearchCaptureExportManifestSchema, manifestBytes)
    const expectedManifest = yield* deriveResearchCaptureExportManifest(sealBytes)
    if (
      manifestBytes.contentHash !== expectedManifest.contentHash ||
      manifestBytes.payload !== Buffer.from(expectedManifest.payload).toString('utf8')
    )
      return yield* Result.fail(fail('Export manifest differs from its durable SQL seal root'))
    if (
      manifest.captureId !== capture.seal.captureId ||
      manifest.sourceRevision !== capture.seal.sourceRevision ||
      manifest.exportedChunks !== chunks.length ||
      manifest.metadataSeal.contentHash !== sealBytes.contentHash ||
      manifest.metadataSeal.byteLength !== Buffer.byteLength(sealBytes.payload)
    )
      return yield* Result.fail(fail('Export manifest does not bind its exact metadata seal'))
    let previousChunkHash: string | null = null
    for (const [ordinal, chunk] of chunks.entries()) {
      if (chunk.previousChunkHash !== previousChunkHash)
        return yield* Result.fail(fail('Capture frame chain differs from its exact predecessor'))
      const object = objects[ordinal]
      if (object === undefined) return yield* Result.fail(fail('Capture frame omitted its declared ordinal'))
      previousChunkHash = object.contentHash
    }
    if (manifest.lastChunkHash !== previousChunkHash)
      return yield* Result.fail(fail('Export manifest omits its capture frame tail'))
    return { ...capture, chunks, exportVerified: true, complete: false }
  })

export const verifyResearchCaptureExport = (
  objects: Parameters<typeof verifyExport>[0],
  sealBytes: ResearchCaptureBytes,
  manifestBytes: ResearchCaptureBytes,
) => verifyExport(objects, sealBytes, manifestBytes, false)

/** An immutable observation prefix can end while its consumer continues. It is not a closed worker. */
export const verifyResearchCaptureExportPrefix = (
  objects: Parameters<typeof verifyExport>[0],
  sealBytes: ResearchCaptureBytes,
  manifestBytes: ResearchCaptureBytes,
) => verifyExport(objects, sealBytes, manifestBytes, true)
