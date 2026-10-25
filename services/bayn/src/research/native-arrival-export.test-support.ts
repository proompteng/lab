import { Effect, Option, Result } from 'effect'

import { canonicalJsonV1Result, sha256 } from '../hash'
import { makeNativeArrivalChunk, nativeArrival, type NativeArrivalChunk } from '../market-data/streaming/native-arrival'
import {
  nativeArrivalEpochFixture as epoch,
  nativeArrivalObservationFixture as observation,
} from '../market-data/streaming/native-arrival.test-support'
import { EvidenceArchiveFailure, type EvidenceArchive } from './evidence-archive'
import type { NativeArrivalExportSource } from './native-arrival-export'

export const nativeArrivalArchiveFixture = (count = 20, observe = observation) => {
  const chunks: NativeArrivalChunk[] = []
  for (let i = 0; i < count; i++)
    chunks.push(
      Result.getOrThrow(
        makeNativeArrivalChunk(epoch, i, chunks.at(-1)?.contentHash ?? null, [nativeArrival(epoch, observe(i + 1))]),
      ),
    )
  const objects = new Map<string, { body: Uint8Array; etag: string }>()
  let version = 0
  const archive: EvidenceArchive = {
    read: (key, maximum) =>
      Effect.gen(function* () {
        const existing = objects.get(key)
        if (existing === undefined) return Option.none()
        if (existing.body.byteLength > maximum)
          return yield* new EvidenceArchiveFailure({ message: 'fixture byte bound' })
        return Option.some({ ...existing, body: existing.body.slice() })
      }),
    retain: (key, body) =>
      Effect.gen(function* () {
        const existing = objects.get(key)
        if (existing !== undefined && !Buffer.from(existing.body).equals(body))
          return yield* new EvidenceArchiveFailure({ message: 'fixture identity conflict' })
        if (existing === undefined) objects.set(key, { body: body.slice(), etag: String(++version) })
        return { key, sha256: sha256(body), bytes: body.byteLength }
      }),
    checkpoint: (key, body, previousEtag) =>
      Effect.gen(function* () {
        if ((objects.get(key)?.etag ?? null) !== previousEtag)
          return yield* new EvidenceArchiveFailure({ message: 'fixture stale checkpoint', status: 412 })
        const etag = String(++version)
        objects.set(key, { body: body.slice(), etag })
        return etag
      }),
  }
  const payload = Result.getOrThrow(canonicalJsonV1Result(epoch))
  const source: NativeArrivalExportSource = {
    epoch: Effect.succeed({ epoch, payload, contentHash: sha256(payload) }),
    chunks: (after) => Effect.succeed(chunks.slice(after + 1, after + 9)),
    end: Effect.succeed({
      captureId: epoch.captureId,
      status: 'STOPPED',
      observedConsumerSequence: count,
      durableConsumerSequence: count,
      lastChunkHash: chunks.at(-1)?.contentHash ?? null,
      reason: null,
      consumerScopeCompleted: false,
    }),
  }
  const pageKeys = () => [...objects.keys()].filter((key) => key.includes('/pages/'))
  return {
    chunks,
    objects,
    archive,
    source,
    pageKeys,
    cursorKey: `native-evidence/v1/arrivals/${epoch.captureId}/cursor.json`,
  }
}
