import { expect, test } from 'bun:test'
import {
  partitionLagMeasurements,
  projectionCoverageMeasurements,
  safeKafkaFailureCodes,
  snapshotFailureMeasurement,
} from './telemetry'
import { AuthenticationError, MultipleErrors, ProtocolError, TimeoutError } from '@platformatic/kafka'
import { emptyStreamingProjection } from './projection'
import { canonicalJsonV1Result } from '../../hash'
import { Result } from 'effect'
import { IntradayIngestionDelayDirection, IntradaySnapshotFailure } from '../intraday/model'
import { streamingFixture } from '../../testing/streaming-market-fixture'
import { validateBarCoverage, validateBarStructure } from '../intraday/verification'
import { BarPublicationPolicy } from '../intraday/bar-publication'

for (const delayMs of [50000, 89689]) {
  test(`rejected benchmark bar retains its actual publication delay ${delayMs}ms and governing bound`, () => {
    const { query, snapshot } = streamingFixture()
    const original = snapshot.bars.find((bar) => bar.symbol === 'SPY')
    if (original === undefined) throw new Error('Missing benchmark fixture')
    const bar = { ...original, ingestedAt: new Date(Date.parse(original.eventAt) + delayMs).toISOString() }
    const checked =
      delayMs < 60000
        ? validateBarStructure(query, [bar])
        : validateBarCoverage(query, [bar], 0, BarPublicationPolicy.TimelyEquivalentRevision)
    expect(Result.isFailure(checked)).toBe(true)
    if (Result.isSuccess(checked)) throw new Error('Invalid benchmark unexpectedly accepted')
    expect(snapshotFailureMeasurement(checked.failure, query)).toMatchObject({
      failureReason: 'freshness',
      symbol: 'SPY',
      eventAt: bar.eventAt,
      ingestedAt: bar.ingestedAt,
      publicationDelayMs: delayMs,
      ...(delayMs < 60000
        ? { ingestionDelayDirection: 'below-minimum', minimumPublicationDelayMs: 60000 }
        : { ingestionDelayDirection: 'above-maximum', maximumPublicationDelayMs: 70000 }),
    })
  })
}

test('snapshot diagnostics retain precise publication times and bounds without forwarding arbitrary failure facts', () => {
  const { query } = streamingFixture()
  const diagnostics = snapshotFailureMeasurement(
    new IntradaySnapshotFailure({
      reason: 'freshness',
      message: 'credential-bearing exception detail',
      ingestionDelayDirection: IntradayIngestionDelayDirection.AboveMaximum,
      facts: {
        symbol: 'SPY',
        sourceTopic: query.sourceTopics.bars,
        eventAt: '2026-09-04T14:00:00.000000000Z',
        ingestedAt: '2026-09-04T14:01:29.689204540Z',
        publicationDelayMs: 89689.20454,
        maximumPublicationDelayMs: 70000,
        password: 'secret',
        rawPayload: 'private',
      },
    }),
    query,
  )
  expect(diagnostics).toEqual({
    schemaVersion: 'bayn.market-snapshot-failure.v1',
    failureReason: 'freshness',
    ingestionDelayDirection: IntradayIngestionDelayDirection.AboveMaximum,
    observedAt: query.observedAt,
    rangeStartAt: query.rangeStartAt,
    rangeEndAt: query.rangeEndAt,
    symbol: 'SPY',
    sourceTopic: query.sourceTopics.bars,
    eventAt: '2026-09-04T14:00:00.000000000Z',
    ingestedAt: '2026-09-04T14:01:29.689204540Z',
    publicationDelayMs: 89689.20454,
    maximumPublicationDelayMs: 70000,
  })
  expect(Result.isSuccess(canonicalJsonV1Result(diagnostics))).toBe(true)
})

test('snapshot diagnostics omit foreign identities, malformed timestamps and non-finite durations', () => {
  const { query } = streamingFixture()
  const diagnostics = snapshotFailureMeasurement(
    new IntradaySnapshotFailure({
      reason: 'freshness',
      message: 'internal detail',
      facts: {
        symbol: 'foreign-secret',
        sourceTopic: 'foreign-secret',
        eventAt: 'invalid-secret',
        ingestedAt: '2026-09-04T14:00:00.000000000Z?secret',
        publicationDelayMs: Infinity,
        minimumPublicationDelayMs: -1,
        maximumPublicationDelayMs: 'secret',
      },
    }),
    query,
  )
  expect(diagnostics).toEqual({
    schemaVersion: 'bayn.market-snapshot-failure.v1',
    failureReason: 'freshness',
    observedAt: query.observedAt,
    rangeStartAt: query.rangeStartAt,
    rangeEndAt: query.rangeEndAt,
  })
})

test('failure classification retains SDK and broker codes without leaking error messages', () => {
  const secretMessage = 'credential-bearing broker detail'
  expect(safeKafkaFailureCodes(new AuthenticationError(secretMessage))).toEqual(['PLT_KFK_AUTHENTICATION'])
  const codes = safeKafkaFailureCodes(
    new MultipleErrors(secretMessage, [
      new ProtocolError('TOPIC_AUTHORIZATION_FAILED', secretMessage),
      new TimeoutError(secretMessage),
    ]),
  )
  expect(codes).toContain('TOPIC_AUTHORIZATION_FAILED')
  expect(codes).toContain('PLT_KFK_TIMEOUT')
  expect(JSON.stringify(codes)).not.toContain(secretMessage)
  expect(safeKafkaFailureCodes(new Error(secretMessage))).toEqual(['UNKNOWN'])
})

test('offset lag retains integer precision and distinguishes unknown ends from zero lag', () => {
  const positions = [
    { topic: 'bars', partition: 0, offset: '9007199254740993' },
    { topic: 'quotes', partition: 0, offset: '9' },
    { topic: 'trades', partition: 0, offset: '4' },
  ]
  expect(
    partitionLagMeasurements(positions, [
      { topic: 'bars', partition: 0, offset: '9007199254741000' },
      { topic: 'quotes', partition: 0, offset: '8' },
    ]).map(({ lagOffsets }) => lagOffsets),
  ).toEqual(['7', '0', null])
  expect(partitionLagMeasurements(positions, undefined).every(({ lagOffsets }) => lagOffsets === null)).toBe(true)
})

test('an absent symbol reports missing coverage without fabricating zero event age', () => {
  const observedAtMs = Date.parse('2026-09-11T14:00:02Z')
  const measurements = projectionCoverageMeasurements(emptyStreamingProjection('epoch'), ['AMD'], observedAtMs)
  expect(measurements.windowEndMs).toBe(Date.parse('2026-09-11T14:00:00Z'))
  expect(measurements.symbols).toEqual([
    {
      symbol: 'AMD',
      expectedBars: 30,
      observedBars: 0,
      windowFeatures: 0,
      matchedFeatures: 0,
      unmatchedFeatures: 0,
      quoteAgeMs: null,
      tradeAgeMs: null,
    },
  ])
  expect(Result.isSuccess(canonicalJsonV1Result(measurements))).toBe(true)
})
