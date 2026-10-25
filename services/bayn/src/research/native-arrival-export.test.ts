import { expect, test } from 'bun:test'
import { Effect, Exit, Result } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from '../hash'
import { decodeNativeArrivalChunk, type NativeArrivalChunk } from '../market-data/streaming/native-arrival'
import { nativeArrivalEpochFixture as epoch } from '../market-data/streaming/native-arrival.test-support'
import { EvidenceArchiveFailure, type EvidenceArchive } from './evidence-archive'
import { exportNativeArrivalPrefix, type NativeArrivalExportSource } from './native-arrival-export'
import { nativeArrivalArchiveFixture as fixture } from './native-arrival-export.test-support'

const bytes = (value: unknown) => new TextEncoder().encode(Result.getOrThrow(canonicalJsonV1Result(value)))

test('archives original native bytes across linked pages and resumes without re-exporting a prefix', async () => {
  const f = fixture()
  const receipt = await Effect.runPromise(exportNativeArrivalPrefix(f.source, f.archive, 20))
  expect(receipt.nextOrdinal).toBe(20)
  expect(receipt.pagesWritten).toBe(3)
  expect(receipt.caughtUpToReadCut).toBeTrue()
  expect(receipt.qualification).toBe('UNQUALIFIED')
  expect(receipt.completeSessionCoverage).toBeFalse()
  const restored: NativeArrivalChunk[] = []
  for (const key of f.pageKeys()) {
    const stored = f.objects.get(key)
    if (stored === undefined) throw new Error('Missing retained page')
    const page = JSON.parse(new TextDecoder().decode(stored.body))
    expect(key).toContain(sha256(stored.body))
    for (const chunk of page.chunks) {
      const retained = {
        header: chunk.header,
        contentHash: chunk.contentHash,
        compressed: Buffer.from(chunk.compressedBase64, 'base64'),
      }
      expect(Result.isSuccess(decodeNativeArrivalChunk(retained))).toBeTrue()
      restored.push(retained)
    }
  }
  expect(restored).toEqual(f.chunks)
  const resumed = await Effect.runPromise(exportNativeArrivalPrefix(f.source, f.archive, 20))
  expect(resumed.firstOrdinal).toBe(20)
  expect(resumed.pagesWritten).toBe(0)
  expect(f.pageKeys()).toHaveLength(3)
  expect(receipt.end).not.toBeNull()
})

test('bounded runs advance only verified original pages', async () => {
  const f = fixture()
  for (const expected of [8, 16, 20]) {
    const receipt = await Effect.runPromise(exportNativeArrivalPrefix(f.source, f.archive, 1))
    expect(receipt.nextOrdinal).toBe(expected)
    expect(receipt.pagesWritten).toBe(1)
    expect(receipt.caughtUpToReadCut).toBeFalse()
  }
  expect((await Effect.runPromise(exportNativeArrivalPrefix(f.source, f.archive, 1))).caughtUpToReadCut).toBeTrue()
  expect(f.pageKeys()).toHaveLength(3)
})

test.each(['before', 'after'])(
  'a checkpoint failure %s publication resumes without losing or duplicating source bytes',
  async (when) => {
    const f = fixture()
    const archive: EvidenceArchive = {
      ...f.archive,
      checkpoint: (key, body, etag) =>
        Effect.gen(function* () {
          if (when === 'after') yield* f.archive.checkpoint(key, body, etag)
          return yield* new EvidenceArchiveFailure({ message: 'fixture process stopped at checkpoint' })
        }),
    }
    expect(Exit.isFailure(await Effect.runPromiseExit(exportNativeArrivalPrefix(f.source, archive, 20)))).toBeTrue()
    expect(f.pageKeys()).toHaveLength(1)
    const resumed = await Effect.runPromise(exportNativeArrivalPrefix(f.source, f.archive, 20))
    expect(resumed.nextOrdinal).toBe(20)
    expect(resumed.firstOrdinal).toBe(when === 'after' ? 8 : 0)
    expect(f.pageKeys()).toHaveLength(3)
  },
)

test.each(['missing-page', 'changed-page', 'changed-anchor', 'wrong-page-boundary', 'invalid-utf8'])(
  'rejects a corrupted checkpoint or its source: %s',
  async (scenario) => {
    const f = fixture()
    const first = await Effect.runPromise(exportNativeArrivalPrefix(f.source, f.archive, 1))
    if (first.lastPage === null) throw new Error('Missing retained page fixture')
    let source = f.source
    if (scenario === 'missing-page') f.objects.delete(first.lastPage.key)
    if (scenario === 'changed-page')
      f.objects.set(first.lastPage.key, { body: bytes({ replaced: true }), etag: 'forged' })
    if (scenario === 'changed-anchor')
      source = {
        ...f.source,
        chunks: (after) => Effect.succeed(after === 6 ? [] : f.chunks.slice(after + 1, after + 9)),
      }
    if (scenario === 'invalid-utf8') f.objects.set(f.cursorKey, { body: new Uint8Array([0xff]), etag: 'forged' })
    if (scenario === 'wrong-page-boundary') {
      const checkpoint = f.objects.get(f.cursorKey)
      if (checkpoint === undefined) throw new Error('Missing checkpoint fixture')
      const { cursorHash: _hash, ...cursor } = JSON.parse(new TextDecoder().decode(checkpoint.body))
      const page = JSON.parse(new TextDecoder().decode(f.objects.get(first.lastPage.key)?.body))
      page.chunks = page.chunks.slice(0, -1)
      const body = bytes(page)
      cursor.lastPage = await Effect.runPromise(
        f.archive.retain(`native-evidence/v1/arrivals/${epoch.captureId}/pages/${sha256(body)}.json`, body),
      )
      f.objects.set(f.cursorKey, {
        body: bytes({ ...cursor, cursorHash: Result.getOrThrow(canonicalHashV1Result(cursor)) }),
        etag: 'forged',
      })
    }
    const exit = await Effect.runPromiseExit(exportNativeArrivalPrefix(source, f.archive, 20))
    expect(Exit.isFailure(exit)).toBeTrue()
  },
)

test.each(['gap', 'foreign-capture', 'too-many'])(
  'refuses a source page that violates its complete prefix: %s',
  async (scenario) => {
    const f = fixture()
    const source: NativeArrivalExportSource = {
      ...f.source,
      chunks: () =>
        Effect.succeed(
          scenario === 'gap'
            ? f.chunks.slice(1, 8)
            : scenario === 'too-many'
              ? f.chunks.slice(0, 9)
              : f.chunks
                  .slice(0, 1)
                  .map((chunk) => ({ ...chunk, header: { ...chunk.header, captureId: 'f'.repeat(64) } })),
        ),
    }
    expect(Exit.isFailure(await Effect.runPromiseExit(exportNativeArrivalPrefix(source, f.archive, 20)))).toBeTrue()
    expect(f.pageKeys()).toHaveLength(0)
  },
)

test('preserves missing and interrupted consumer evidence without claiming complete source coverage', async () => {
  for (const end of [
    null,
    {
      captureId: epoch.captureId,
      status: 'INCOMPLETE' as const,
      observedConsumerSequence: 22,
      durableConsumerSequence: 20,
      lastChunkHash: fixture().chunks.at(-1)?.contentHash ?? null,
      reason: 'fixture source stopped',
      consumerScopeCompleted: false,
    },
  ]) {
    const f = fixture()
    const receipt = await Effect.runPromise(
      exportNativeArrivalPrefix({ ...f.source, end: Effect.succeed(end) }, f.archive, 20),
    )
    expect(receipt.completeSessionCoverage).toBeFalse()
    expect(receipt.end === null).toBe(end === null)
    expect(receipt.qualification).toBe('UNQUALIFIED')
  }
})

test.each([0, 257])('rejects an unbounded or empty page budget %s before exporting', async (maximumPages) => {
  const f = fixture()
  expect(
    Exit.isFailure(await Effect.runPromiseExit(exportNativeArrivalPrefix(f.source, f.archive, maximumPages))),
  ).toBeTrue()
  expect(f.objects.size).toBe(0)
})
