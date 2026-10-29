import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { continuousMarketHours } from '../market-hours'
import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { reproduceStreamingSnapshot } from '../market-data/streaming/replay'
import { incorporateMarketRecord } from '../market-data/streaming/projection'
import { persistIntradayRecordRows, verifyIntradaySnapshotRequest } from '../market-data/intraday/verification'
import { makeJevEntryQuery } from './observation-query'
import { decodeJevProtocol, defaultJevProtocolDocument } from './protocol'
import { jevSignalFor } from './trading-signals'

test('crypto sees two hours of completed history while equity retains thirty minutes', () => {
  const equity = streamingFixture().query
  const observedAtMs = Date.parse('2026-09-04T16:00:03.000Z')
  for (const [candidates, calendar, expectedStart] of [
    [['AAPL'], equity.calendar, '2026-09-04T15:30:00.000Z'],
    [['ETH/USD'], continuousMarketHours, '2026-09-04T14:00:00.000Z'],
  ] as const) {
    const query = makeJevEntryQuery({
      protocol: defaultJevProtocolDocument,
      calendar,
      sessionDate: '2026-09-04',
      observedAtMs,
      candidates,
    })
    expect(query.rangeStartAt).toBe(expectedStart)
    expect(query.rangeEndAt).toBe('2026-09-04T16:00:00.000Z')
    expect(query.maximumQuoteAgeMs).toBe(10_000)
  }
  expect(defaultJevProtocolDocument.maximumHoldingMinutes).toBe(15)
  expect(defaultJevProtocolDocument.horizonMinutes).toBe(15)
})

test('extended crypto evidence reproduces real sparse history without padding missing bars', () => {
  const fixture = cryptoMarketFixture()
  const query = {
    ...fixture.query,
    rangeStartAt: new Date(Date.parse(fixture.query.rangeEndAt) - 120 * 60_000).toISOString(),
  }
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(fixture.cut, query))
  const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
  expect(snapshot.bars).toEqual(fixture.snapshot.bars)
  expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows)).manifest.snapshotId).toBe(
    snapshot.manifest.snapshotId,
  )
  expect(
    Result.isFailure(
      verifyIntradaySnapshotRequest({
        ...query,
        rangeStartAt: new Date(Date.parse(query.rangeStartAt) - 60_000).toISOString(),
        archiveWatermarks: [],
      }),
    ),
  ).toBe(true)
})

test('the current protocol rejects the retired shared history contract', () => {
  expect(Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, lookbackMinutes: 30 }))).toBe(true)
  expect(
    Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, schemaVersion: 'bayn.jev.protocol.v29' })),
  ).toBe(true)
  for (const lookbackMinutes of [
    { equity: 120, crypto: 120 },
    { equity: 30, crypto: 30 },
    { equity: 30, crypto: 121 },
  ])
    expect(Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, lookbackMinutes }))).toBe(true)
})

test('equity verification still rejects more than thirty completed minutes', () => {
  const query = streamingFixture().query
  const result = verifyIntradaySnapshotRequest({
    ...query,
    rangeStartAt: new Date(Date.parse(query.rangeEndAt) - 31 * 60_000).toISOString(),
    archiveWatermarks: [],
  })
  expect(result).toMatchObject({
    _tag: 'Failure',
    failure: { message: 'intraday range must contain one to 30 complete UTC-aligned one-minute bars' },
  })
})

test('all 120 crypto minutes survive projection and replay without changing the rolling indicator contract', () => {
  const fixture = cryptoMarketFixture()
  const source = fixture.cut.projection.sources.get(fixture.query.universeId)
  if (source === undefined) throw new Error('Missing incorporated crypto source')
  let projection = fixture.cut.projection
  const positions = fixture.cut.positions.map((position) => ({ ...position }))
  const end = Date.parse(fixture.query.rangeEndAt)
  for (const original of fixture.fixtures) {
    const record = original.records[0]
    if (record === undefined) throw new Error('Missing source bar')
    const envelope = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(JSON.parse(record.value))
    const payload = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(envelope['payload'])
    const position = positions.find((entry) => entry.topic === record.topic && entry.partition === record.partition)
    if (position === undefined) throw new Error('Missing source partition')
    // Backfill arrives after the current cut. Its event and publication timestamps remain historical.
    for (let minutes = 121; minutes >= 62; minutes--) {
      const at = new Date(end - minutes * 60_000).toISOString()
      projection = incorporateMarketRecord(
        projection,
        {
          ...record,
          offset: position.offset,
          value: JSON.stringify({
            ...envelope,
            eventTs: at,
            ingestTs: new Date(Date.parse(at) + 61_000).toISOString(),
            seq: 10_000 + minutes,
            payload: { ...payload, t: at, o: 80, h: 120, l: 70, c: 90, v: 10 },
          }),
        },
        source,
        end + 3000,
      )
      position.offset = String(BigInt(position.offset) + 1n)
    }
    expect(
      new Set(projection.bars.get(original.feature.material.symbol)?.map((bar) => Date.parse(bar.value.eventAt))).size,
    ).toBe(121)
  }
  const snapshot = Result.getOrThrow(
    constructStreamingSnapshot({ ...fixture.cut, projection, positions }, fixture.query),
  )
  const bars = snapshot.bars.filter((bar) => bar.symbol === 'BTC/USD')
  expect(bars).toHaveLength(120)
  expect(Date.parse(bars[0]?.eventAt ?? '')).toBe(end - 120 * 60_000)
  const signal = Result.getOrThrow(jevSignalFor(snapshot, 'BTC/USD'))
  expect(signal.state.priceWindow).toMatchObject({ referencePrice: 80, rangeHigh: 120, rangeLow: 70 })
  expect(signal.state.priceWindow.totalVolume).toBeCloseTo(590.000000061, 9)
  expect(signal.state.recent15mVolumeToPrior15m).toBeCloseTo(1, 9)
  expect(signal.state.technicalIndicators).toEqual(
    Result.getOrThrow(jevSignalFor(fixture.snapshot, 'BTC/USD')).state.technicalIndicators,
  )
  expect(snapshot.manifest.streaming.features).toEqual(fixture.snapshot.manifest.streaming.features)
  const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
  expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows)).manifest.snapshotId).toBe(
    snapshot.manifest.snapshotId,
  )
  const changed = {
    ...rows,
    bars: rows.bars.map((bar, index) =>
      index === 0
        ? { ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(bar), close_price: '999' }
        : bar,
    ),
  }
  expect(Result.isFailure(reproduceStreamingSnapshot(snapshot.manifest, changed))).toBe(true)
})
