import { expect, test } from 'bun:test'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Deferred, Effect, Fiber, Redacted, Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import {
  makeIntradayPerformanceFixture,
  makeStreamingPerformanceFixture,
  makeStreamingPartitionPerformanceFixture,
} from './intraday-cycle.test-support'
import { makeIntradayPerformanceVolumeEvidence } from './intraday-volume'
import { readForwardPerformanceMarketVolumeWithClient } from './program'
import type { ForwardPerformanceIntradayMarketVolumeRequest } from './model'

const config = {
  clickhouse: { url: 'http://unused.invalid', username: 'unused', password: Redacted.make('unused') },
  operationTimeoutMs: 1_000,
}
const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))

const fixtureClient = (fixture: ReturnType<typeof makeIntradayPerformanceFixture>) => {
  const calls = { watermarks: 0, bars: 0 }
  const statement = (strings: TemplateStringsArray) =>
    Effect.suspend<readonly Record<string, unknown>[], never, never>(() => {
      const text = strings.join('?')
      if (text.includes('GROUP BY source_topic, source_partition')) {
        calls.watermarks += 1
        return Effect.succeed(
          fixture.archive.archiveWatermarks.map((item) => ({
            source_topic: item.sourceTopic,
            source_partition: String(item.sourcePartition),
            inclusive_last_offset: item.inclusiveLastOffset,
          })),
        )
      }
      if (text.includes('toString(volume) AS volume')) {
        calls.bars += 1
        return Effect.succeed(fixture.bars)
      }
      if (text.trim() === '' || text.includes('LIMIT 0')) return Effect.succeed([])
      return Effect.die(new Error('Unexpected archive query'))
    })
  const client = Object.assign(statement, {
    param: (_type: string, value: unknown) => ({ value }),
  }) as unknown as ClickhouseClient.ClickhouseClient
  return { calls, client }
}

test.each([makeIntradayPerformanceFixture, makeStreamingPerformanceFixture, makeStreamingPartitionPerformanceFixture])(
  'shares identical report-cut archive I/O without sharing cycle evidence: %p',
  async (makeFixture) => {
    const fixture = makeFixture()
    const { calls, client } = fixtureClient(fixture)
    const requests = Array.from({ length: 117 }, (_, i) => ({ ...fixture.request, cycleId: hash(i) }))
    const evidence = await Effect.runPromise(
      readForwardPerformanceMarketVolumeWithClient(config, requests).pipe(
        Effect.provideService(ClickhouseClient.ClickhouseClient, client),
      ),
    )
    const expected = requests
      .map((request) => {
        const value = Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, fixture.archive, fixture.bars))
        if (value === undefined) throw new Error('Expected complete fixture evidence')
        return value
      })
      .toSorted((left, right) => (left.cycleId < right.cycleId ? -1 : left.cycleId > right.cycleId ? 1 : 0))
    expect(evidence).toEqual(expected)
    expect(calls).toEqual({ watermarks: 1, bars: 1 })
    expect(new Set(evidence.map((item) => item.contentHash)).size).toBe(117)
  },
)

const withWatermarkDelta = (request: ForwardPerformanceIntradayMarketVolumeRequest, delta: bigint) => {
  if (request.decisionManifest.schemaVersion !== 'bayn.intraday-market-snapshot.v1')
    throw new Error('Expected intraday fixture')
  const { snapshotId: _id, contentHash: _hash, ...source } = request.decisionManifest
  const material = {
    ...source,
    archiveWatermarks: source.archiveWatermarks.map((item) => ({
      ...item,
      inclusiveLastOffset: String(BigInt(item.inclusiveLastOffset) + delta),
    })),
  }
  const contentHash = hash(material)
  const snapshotId = hash({ ...material, contentHash })
  return {
    ...request,
    cycleId: hash(delta.toString()),
    decisionSnapshotId: snapshotId,
    decisionManifest: { ...material, contentHash, snapshotId },
  }
}

test('sharing retains each original decision identity and watermark lower bound', async () => {
  const fixture = makeIntradayPerformanceFixture()
  const { calls, client } = fixtureClient(fixture)
  const sibling = withWatermarkDelta(fixture.request, 1n)
  const evidence = await Effect.runPromise(
    readForwardPerformanceMarketVolumeWithClient(config, [fixture.request, sibling]).pipe(
      Effect.provideService(ClickhouseClient.ClickhouseClient, client),
    ),
  )
  expect(evidence).toHaveLength(2)
  expect(evidence.map((item) => item.decisionSnapshotId).toSorted()).toEqual(
    [fixture.request.decisionSnapshotId, sibling.decisionSnapshotId].toSorted(),
  )
  expect(calls).toEqual({ watermarks: 1, bars: 1 })
  const failed = await Effect.runPromise(
    Effect.result(
      readForwardPerformanceMarketVolumeWithClient(config, [
        fixture.request,
        withWatermarkDelta(fixture.request, 1_000n),
      ]).pipe(Effect.provideService(ClickhouseClient.ClickhouseClient, client)),
    ),
  )
  expect(Result.isFailure(failed)).toBe(true)
})

test('different cutoffs never share archive reads and corrupted siblings fail closed', async () => {
  const fixture = makeIntradayPerformanceFixture()
  const { calls, client } = fixtureClient(fixture)
  const later = {
    ...fixture.request,
    cycleId: hash('later'),
    evidenceCutoffAt: new Date(Date.parse(fixture.request.evidenceCutoffAt) + 1_000).toISOString(),
  }
  const evidence = await Effect.runPromise(
    readForwardPerformanceMarketVolumeWithClient(config, [fixture.request, later]).pipe(
      Effect.provideService(ClickhouseClient.ClickhouseClient, client),
    ),
  )
  expect(evidence.map((item) => item.evidenceCutoffAt).toSorted()).toEqual(
    [fixture.request.evidenceCutoffAt, later.evidenceCutoffAt].toSorted(),
  )
  expect(calls).toEqual({ watermarks: 2, bars: 2 })
  const corrupted = { ...fixture.request, decisionSnapshotId: 'f'.repeat(64) }
  const failed = await Effect.runPromise(
    Effect.result(
      readForwardPerformanceMarketVolumeWithClient(config, [fixture.request, corrupted]).pipe(
        Effect.provideService(ClickhouseClient.ClickhouseClient, client),
      ),
    ),
  )
  expect(Result.isFailure(failed)).toBe(true)
  expect(calls).toEqual({ watermarks: 2, bars: 2 })
})

test('interruption cancels the shared archive read once without publishing partial evidence', async () => {
  let finalized = 0
  const fixture = makeIntradayPerformanceFixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { client: original } = fixtureClient(fixture)
      const statement = (strings: TemplateStringsArray) =>
        strings.join('?').includes('toString(volume) AS volume')
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized += 1
                }),
              ),
            )
          : original(strings)
      const client = Object.assign(statement, {
        param: (_type: string, value: unknown) => ({ value }),
      }) as unknown as ClickhouseClient.ClickhouseClient
      const fiber = yield* readForwardPerformanceMarketVolumeWithClient(config, [
        fixture.request,
        {
          ...fixture.request,
          cycleId: hash('sibling'),
        },
      ]).pipe(Effect.provideService(ClickhouseClient.ClickhouseClient, client), Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }),
  )
  expect(finalized).toBe(1)
})
