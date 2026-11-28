import { decodeIntradayBarRows } from '../market-data/intraday/rows'
import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { MarketVolumeBindingRow } from './postgres/model'
import { marketVolumeRequestsFromRows } from './postgres/projection'
import { IntradayPerformanceVolumeEvidenceSchema } from './intraday-schema'
import {
  intradayPerformanceDecisionRequest,
  intradayPerformanceSessionQuery,
  makeIntradayPerformanceVolumeEvidence,
  validIntradayPerformanceVolumeEvidence,
} from './intraday-volume'

for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const) {
  test(`${symbol} reports its native Sunday feed, fractional volume and complete cycle minutes`, () => {
    const fixture = cryptoMarketFixture(symbol)
    const manifest = fixture.snapshot.manifest
    const end = Date.parse(manifest.rangeEndAt)
    const binding = Schema.decodeUnknownSync(MarketVolumeBindingRow)({
      cycle_id: 'a'.repeat(64),
      snapshot_id: manifest.snapshotId,
      execution_session_date: manifest.sessionDate,
      execution_open_at: new Date(end + 500),
      execution_close_at: new Date(end + 192_000),
      manifest,
    })
    const request = marketVolumeRequestsFromRows(
      [{ cycleId: binding.cycle_id, symbol }],
      [binding],
      new Date(end + 200_000).toISOString(),
    )[0]
    if (request === undefined || !('decisionManifest' in request)) throw new Error('Missing crypto request')
    expect(request.sourceFeed).toBe('us')
    const original = Result.getOrThrow(intradayPerformanceDecisionRequest(request))
    const archive = intradayPerformanceSessionQuery(request, original)
    const source = Result.getOrThrow(decodeIntradayBarRows(fixture.rows.bars)).find((bar) => bar.symbol === symbol)
    if (source === undefined) throw new Error('Missing producer bar')
    const bars = [1, 2].map((minute) => ({
      ...source,
      event_at: new Date(end + minute * 60_000).toISOString(),
      ingested_at: new Date(end + (minute + 1) * 60_000).toISOString(),
      volume: '0.031234567',
      open: '103.123456789',
      high: '103.123456789',
      low: '103.123456789',
      close: '103.123456789',
      native_payload: `{"T":"b","S":"${symbol}","t":"${new Date(end + minute * 60_000).toISOString()}","o":103.123456789,"h":103.123456789,"l":103.123456789,"c":103.123456789,"v":0.031234567}`,
      is_final: '1',
    }))
    const evidence = Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, archive, bars))
    expect(evidence).toMatchObject({
      sourceFeed: 'us',
      quantityAtoms: '62469134',
      closePriceMicros: '103123457',
      barCount: 2,
      volumeScope: 'RECORDED_COMPLETE_MINUTE_VOLUME',
      missingMinutes: [],
    })
    if (evidence === undefined) throw new Error('Missing complete volume evidence')
    expect(evidence).toEqual(Schema.decodeUnknownSync(IntradayPerformanceVolumeEvidenceSchema)(evidence))
    expect(validIntradayPerformanceVolumeEvidence(evidence)).toBe(true)
    expect(
      Result.isFailure(
        makeIntradayPerformanceVolumeEvidence(
          request,
          archive,
          bars.map((bar) => ({ ...bar, feed: 'iex' })),
        ),
      ),
    ).toBe(true)
    expect(Result.getOrThrow(makeIntradayPerformanceVolumeEvidence(request, archive, bars.slice(0, 1)))).toBeUndefined()
    expect(
      Result.isFailure(intradayPerformanceDecisionRequest({ ...request, evidenceCutoffAt: manifest.observedAt })),
    ).toBe(true)
  })
}
