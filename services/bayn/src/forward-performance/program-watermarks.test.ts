import { describe, expect, test } from 'bun:test'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Cause, Deferred, Effect, Exit, Fiber, Option, Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { ForwardPerformanceIntradayMarketVolumeRequest } from './model'
import {
  makeIntradayPerformanceFixture,
  makeStreamingPerformanceFixture,
  makeStreamingPartitionPerformanceFixture,
} from './intraday-cycle.test-support'
import { intradayPerformanceDecisionRequest, intradayPerformanceSessionQuery } from './intraday-volume'
import { ForwardPerformanceMarketVolumeError, readForwardPerformanceMarketVolumeWithClient } from './program'
import { ReportVerificationLive } from './verification'

const config = { operationTimeoutMs: 30_000 } as Parameters<typeof readForwardPerformanceMarketVolumeWithClient>[0]
type Fixture = ReturnType<typeof makeIntradayPerformanceFixture>
type QueryKind = 'watermarks' | 'bars'

const pair = (fixture: Fixture) => {
  const symbol = (fixture.request.decisionManifest.universe ?? fixture.request.decisionManifest.symbols).find(
    (candidate) => candidate !== fixture.request.symbol,
  )
  if (symbol === undefined) throw new Error('fixture needs a second universe symbol')
  const request = { ...fixture.request, cycleId: 'b'.repeat(64), symbol }
  return [
    fixture,
    {
      request,
      archive: { ...fixture.archive, symbols: [symbol] },
      bars: fixture.bars.map((bar) => ({ ...bar, symbol })),
    },
  ]
}

const rawWatermarks = (fixture: Fixture) =>
  fixture.archive.archiveWatermarks.map((item) => ({
    source_topic: item.sourceTopic,
    source_partition: String(item.sourcePartition),
    inclusive_last_offset: item.inclusiveLastOffset,
  }))

const client = (
  read: (kind: QueryKind, parameters: readonly unknown[]) => Effect.Effect<readonly unknown[], unknown>,
) => {
  const statement = (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
    Effect.suspend(() => {
      const text = strings.join('?')
      const parameters = values.flatMap((value) =>
        typeof value === 'object' && value !== null && 'value' in value ? [value.value] : [],
      )
      if (text.includes('GROUP BY source_topic, source_partition')) return read('watermarks', parameters)
      if (text.includes('toString(volume) AS volume')) return read('bars', parameters)
      if (text.trim() === '' || text.includes('LIMIT 0')) return Effect.succeed([])
      return Effect.die(new Error('Unexpected market-data query'))
    })
  return Object.assign(statement, {
    param: (_type: string, value: unknown) => ({ value }),
  }) as unknown as ClickhouseClient.ClickhouseClient
}

const report = (workers: boolean, fixtures: readonly Fixture[], sql: ClickhouseClient.ClickhouseClient) => {
  const read = readForwardPerformanceMarketVolumeWithClient(
    config,
    fixtures.map(({ request }) => request),
  ).pipe(Effect.provideService(ClickhouseClient.ClickhouseClient, sql))
  return workers ? read.pipe(Effect.provide(ReportVerificationLive)) : read
}

const fixtureReader = (fixtures: readonly Fixture[], counts: { watermarks: number; bars: number }) =>
  client((kind, parameters) =>
    Effect.sync(() => {
      counts[kind] += 1
      const fixture =
        fixtures.find(({ request, archive }) =>
          kind === 'bars'
            ? parameters.some((parameter) => Array.isArray(parameter) && parameter.includes(request.symbol))
            : parameters.includes(archive.sourceTopics.bars),
        ) ?? fixtures[0]
      if (fixture === undefined) throw new Error('missing fixture')
      return kind === 'watermarks' ? rawWatermarks(fixture) : fixture.bars
    }),
  )

describe.each([false, true])('report-local watermark capture (native workers: %s)', (workers) => {
  test.each([
    makeIntradayPerformanceFixture,
    makeStreamingPerformanceFixture,
    makeStreamingPartitionPerformanceFixture,
  ])('shares one capture between symbols without sharing their bar reads: %p', async (makeFixture) => {
    const fixtures = pair(makeFixture())
    const counts = { watermarks: 0, bars: 0 }
    const read = report(workers, fixtures, fixtureReader(fixtures, counts))
    const evidence = await Effect.runPromise(read)
    expect(counts).toEqual({ watermarks: 1, bars: 2 })
    expect(evidence.map(({ symbol }) => symbol).toSorted()).toEqual(
      fixtures.map(({ request }) => request.symbol).toSorted(),
    )
    expect(evidence.every(({ quantityAtoms }) => quantityAtoms === '39000000000000')).toBe(true)
    // Re-running the same Effect must capture a fresh report cut through the same client.
    expect(await Effect.runPromise(read)).toEqual(evidence)
    expect(counts).toEqual({ watermarks: 2, bars: 4 })
  })

  test.each(['cutoff', 'universe', 'calendar', 'topics'] as const)(
    'keeps distinct %s capture material separate',
    async (kind) => {
      const first = makeIntradayPerformanceFixture()
      const { snapshotId: _snapshotId, contentHash: _contentHash, ...material } = first.request.decisionManifest
      const changed =
        kind === 'universe'
          ? { ...material, universeId: `${material.universeId}-other` }
          : kind === 'topics'
            ? {
                ...material,
                sourceTopics: Object.fromEntries(
                  Object.entries(material.sourceTopics).map(([name, topic]) => [name, `${topic}.other`]),
                ) as typeof material.sourceTopics,
                archiveWatermarks:
                  'archiveWatermarks' in material
                    ? material.archiveWatermarks.map((item) => ({ ...item, sourceTopic: `${item.sourceTopic}.other` }))
                    : [],
              }
            : kind === 'calendar'
              ? (() => {
                  if (material.calendar.schemaVersion !== 'bayn.alpaca-market-calendar-observation.v2')
                    throw new Error('expected equity calendar')
                  const { normalizedResponseHash: _calendarHash, ...calendar } = material.calendar
                  const value = { ...calendar, requestedRange: { ...calendar.requestedRange, end: '2026-10-12' } }
                  return {
                    ...material,
                    calendar: { ...value, normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(value)) },
                  }
                })()
              : material
      const hashed = { ...changed, contentHash: Result.getOrThrow(canonicalHashV1Result(changed)) }
      const manifest = { ...hashed, snapshotId: Result.getOrThrow(canonicalHashV1Result(hashed)) }
      const request: ForwardPerformanceIntradayMarketVolumeRequest = {
        ...first.request,
        cycleId: 'b'.repeat(64),
        ...(kind === 'cutoff' ? { evidenceCutoffAt: `${first.request.executionSessionDate}T22:00:00.000Z` } : {}),
        decisionManifest: manifest,
        decisionSnapshotId: manifest.snapshotId,
      }
      const original = Result.getOrThrow(intradayPerformanceDecisionRequest(request))
      const archive = {
        ...intradayPerformanceSessionQuery(request, original),
        archiveWatermarks: original.archiveWatermarks.map((watermark) => ({
          ...watermark,
          inclusiveLastOffset: String(BigInt(watermark.inclusiveLastOffset) + 390n),
        })),
      }
      const second = { request, archive, bars: first.bars }
      const counts = { watermarks: 0, bars: 0 }
      const fixtures = [first, second]
      // Empty bars are a legitimate evidence gap; no symbol or source facts are fabricated.
      const sql = client((query, parameters) => {
        counts[query] += 1
        return Effect.succeed(
          query === 'bars' ? [] : rawWatermarks(parameters.includes(archive.sourceTopics.bars) ? second : first),
        )
      })
      expect(await Effect.runPromise(report(workers, fixtures, sql))).toEqual([])
      expect(counts).toEqual({ watermarks: 2, bars: 2 })
    },
  )

  test('rejects a second decision whose original watermark exceeds the shared capture', async () => {
    const first = makeIntradayPerformanceFixture()
    const fixtures = pair(first)
    const second = fixtures[1]
    if (second === undefined) throw new Error('missing second fixture')
    const manifest = second.request.decisionManifest
    if (manifest.schemaVersion !== 'bayn.intraday-market-snapshot.v1') throw new Error('expected intraday fixture')
    const { snapshotId: _snapshotId, contentHash: _contentHash, ...material } = manifest
    const advanced = {
      ...material,
      archiveWatermarks: material.archiveWatermarks.map((watermark) => ({
        ...watermark,
        inclusiveLastOffset: String(BigInt(watermark.inclusiveLastOffset) + 10_000n),
      })),
    }
    const hashed = { ...advanced, contentHash: Result.getOrThrow(canonicalHashV1Result(advanced)) }
    const changed = { ...hashed, snapshotId: Result.getOrThrow(canonicalHashV1Result(hashed)) }
    const request = { ...second.request, decisionManifest: changed, decisionSnapshotId: changed.snapshotId }
    const counts = { watermarks: 0, bars: 0 }
    const exit = await Effect.runPromiseExit(
      report(workers, [first, { ...second, request }], fixtureReader(fixtures, counts)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(error) && error.value).toMatchObject({
        _tag: 'ForwardPerformanceMarketVolumeError',
        cause: { message: 'intraday performance archive does not retain the decision watermarks' },
      })
    }
    expect(counts.watermarks).toBe(1)
  })

  test.each(['failure', 'defect', 'interruption'] as const)(
    'propagates shared capture %s and closes it once',
    async (outcome) => {
      const fixtures = pair(makeIntradayPerformanceFixture())
      const problem = new Error('watermark capture failed')
      let captures = 0
      let active = 0
      let finalized = 0
      let bars = 0
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const sql = client((query) =>
            query === 'bars'
              ? Effect.sync(() => {
                  bars += 1
                  return []
                })
              : Effect.scoped(
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      captures += 1
                      active += 1
                    }),
                    () =>
                      Effect.sync(() => {
                        active -= 1
                        finalized += 1
                      }),
                  ).pipe(
                    Effect.andThen(Deferred.succeed(started, undefined)),
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(outcome === 'defect' ? Effect.die(problem) : Effect.fail(problem)),
                  ),
                ),
          )
          const fiber = yield* report(workers, fixtures, sql).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          if (outcome === 'interruption') yield* Fiber.interrupt(fiber)
          else yield* Deferred.succeed(release, undefined)
          return yield* Fiber.await(fiber)
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        if (outcome === 'defect') expect(Cause.hasDies(exit.cause)).toBe(true)
        else if (outcome === 'interruption') expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        else {
          const error = Cause.findErrorOption(exit.cause)
          expect(
            Option.isSome(error) && error.value instanceof ForwardPerformanceMarketVolumeError && error.value.cause,
          ).toBe(problem)
        }
      }
      expect({ captures, active, finalized, bars }).toEqual({ captures: 1, active: 0, finalized: 1, bars: 0 })
    },
  )
})
