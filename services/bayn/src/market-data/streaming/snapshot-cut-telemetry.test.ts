import { expect, test } from 'bun:test'
import { Effect, Layer, Logger, References, Result } from 'effect'
import { PgClient } from '@effect/sql-pg'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'
import { streamingFixture } from '../../testing/streaming-market-fixture'
import { constructStreamingSnapshot } from './snapshot'
import { SnapshotCutReason, snapshotCutMeasurement } from './telemetry'
import { IntradayMarketData, IntradaySnapshotPurpose } from '../intraday/model'
import { KafkaMarketProjection } from './kafka'
import { StreamingIntradayMarketDataLive } from './service'

test('complete market coverage cannot disguise a missing bootstrap position', () => {
  const { cut, query } = streamingFixture()
  expect(Result.isSuccess(constructStreamingSnapshot(cut, query))).toBe(true)
  expect(snapshotCutMeasurement(cut, query).reasons).toEqual([])
  const incomplete = { ...cut, positions: [] }
  expect(Result.isFailure(constructStreamingSnapshot(incomplete, query))).toBe(true)
  expect(snapshotCutMeasurement(incomplete, query)).toMatchObject({
    reasons: ['BOOTSTRAP_OFFSETS_INCOMPLETE'],
    pendingPartitionCount: cut.bootstrap.partitions.length,
  })
})

test('cut diagnostics distinguish startup, epoch, missing partitions and future observation without changing rejection', () => {
  const { cut, query } = streamingFixture()
  const scenarios = [
    [{ ...cut, projection: { ...cut.projection, availabilityMode: 'simulated' } }, 'AVAILABILITY_NOT_OBSERVED'],
    [{ ...cut, projection: { ...cut.projection, sources: new Map() } }, 'SOURCE_UNAVAILABLE'],
    [{ ...cut, bootstrap: { ...cut.bootstrap, epoch: 'other' } }, 'EPOCH_MISMATCH'],
    [{ ...cut, bootstrap: { ...cut.bootstrap, partitions: [] } }, 'REQUIRED_PARTITIONS_MISSING'],
    [
      { ...cut, bootstrap: { ...cut.bootstrap, observedAtMs: Date.parse(query.observedAt) + 1 } },
      'BOOTSTRAP_AFTER_OBSERVATION',
    ],
  ] as const
  for (const [value, reason] of scenarios) {
    expect(Result.isFailure(constructStreamingSnapshot(value, query))).toBe(true)
    expect(snapshotCutMeasurement(value, query).reasons.map(String)).toContain(reason)
  }
})

test('liquidation diagnoses only its quote bootstrap gate', () => {
  const { cut, query } = streamingFixture()
  const quotesOnly = {
    ...cut,
    positions: cut.positions.filter((position) => position.topic === query.sourceTopics.quotes),
  }
  expect(snapshotCutMeasurement(quotesOnly, query).reasons).toEqual([SnapshotCutReason.BootstrapOffsetsIncomplete])
  expect(
    snapshotCutMeasurement(quotesOnly, { ...query, purpose: IntradaySnapshotPurpose.Liquidation }).reasons,
  ).toEqual([])
})

test('pending partition evidence is bounded and excludes arbitrary source fields', () => {
  const { cut, query } = streamingFixture()
  const partition = cut.bootstrap.partitions.find((value) => value.topic === query.sourceTopics.bars)
  if (partition === undefined) throw new Error('Missing bars partition fixture')
  const partitions = Array.from({ length: 20 }, (_, index) => ({
    ...partition,
    partition: index,
    secret: 'never-export',
  }))
  const measured = snapshotCutMeasurement({ ...cut, bootstrap: { ...cut.bootstrap, partitions }, positions: [] }, query)
  expect(measured.pendingPartitionCount).toBe(20)
  expect(measured.pendingPartitions).toHaveLength(8)
  expect(measured.pendingPartitionsTruncated).toBe(true)
  expect(JSON.stringify(measured)).not.toContain('never-export')
  expect(measured.pendingPartitions[0]).toEqual({
    topic: query.sourceTopics.bars,
    partition: 0,
    position: null,
    requiredEndOffset: partition.endOffset,
  })
})

test('the live rejection warning carries cut reasons while healthy snapshots emit no warning', async () => {
  const { cut, query } = streamingFixture()
  const annotations: Readonly<Record<string, unknown>>[] = []
  const logger = Logger.make(({ fiber }) => annotations.push(fiber.getRef(References.CurrentLogAnnotations)))
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.make({
          acquirer: Effect.die('Diagnostics must not query PostgreSQL'),
          compiler: PgClient.makeCompiler(undefined, false),
          spanAttributes: [],
        })
        for (const complete of [true, false]) {
          const selected = complete ? cut : { ...cut, positions: [] }
          const live = StreamingIntradayMarketDataLive.pipe(
            Layer.provide(Layer.succeed(PgClient.PgClient, sql as PgClient.PgClient)),
            Layer.provide(
              Layer.succeed(KafkaMarketProjection, {
                read: Effect.succeed(selected),
                readForLiquidation: Effect.succeed(selected),
                status: Effect.succeed({
                  epoch: cut.projection.epoch,
                  ready: true,
                  sequence: cut.projection.sequence,
                }),
              }),
            ),
          )
          const result = yield* Effect.gen(function* () {
            const market = yield* IntradayMarketData
            return yield* market.loadSnapshot(query).pipe(Effect.result)
          }).pipe(Effect.provide(live))
          expect(Result.isSuccess(result)).toBe(complete)
          expect(annotations).toHaveLength(complete ? 0 : 1)
        }
      }),
    ).pipe(Effect.provide(Reactivity.layer), Effect.provide(Logger.layer([logger]))),
  )
  expect(annotations[0]?.['inputCut']).toMatchObject({ reasons: ['BOOTSTRAP_OFFSETS_INCOMPLETE'] })
})
